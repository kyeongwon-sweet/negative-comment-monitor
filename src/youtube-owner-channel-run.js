import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched, deferredEntryKeys } from './hybrid-classify.js';
import { commentFingerprint, loadSeenFingerprints, recordAlert } from './dedup.js';
import { computeClassifierHash } from './cache.js';
import { estimateUsd } from './pricing.js';
import { recordRunCost } from './cost.js';
import { kstDateKey } from './schedule.js';
import { assigneeForTarget, productGroup, productLabel, sendAlert } from './slack.js';
import { ensureDailyThread } from './threads.js';
import { moderateYouTubeOwnerAlerts, YOUTUBE_OWNER_ALERT_SCOPES } from './youtube-owner-moderation.js';
import { retrySlackRateLimit } from './youtube-ads-run.js';
import {
  collectYouTubeOwnerChannels,
  loadYouTubeOwnerChannelConfig,
  saveOwnerVideoStates,
} from './youtube-owner-channel.js';
import {
  assessOwnerCommentOverload,
  maybeWarnOwnerCommentOverload,
} from './youtube-owner-overload.js';
import { suppressLowConfidenceOwnerRisks } from './youtube-owner-risk.js';
import { monitorLlmHealth } from './llm-health.js';
import { monitorOwnerOAuthCoverage, summarizeOwnerOAuthCoverage } from './youtube-owner-coverage.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function moderationConfig(config, allowedVideoIds) {
  return {
    googleAdsClientId: config.googleAdsClientId,
    googleAdsClientSecret: config.googleAdsClientSecret,
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseKey,
    youtubeApiBase: config.youtubeApiBase,
    dryRun: false,
    singleAlert: false,
    autoHideAllNegatives: true,
    alertScope: YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
    allowedVideoIds,
    batchSize: 50,
    actor: 'youtube-owner-channel-auto-hide',
    slackBotToken: config.slackBotToken,
    slackUpdateDelayMs: 1100,
  };
}

// 소유 YouTube 오가닉 카드는 기존 관리 카테고리를 유지해야 [숨김] 버튼과
// owner OAuth 자동숨김/keep 가드가 그대로 동작한다. 부모 스레드만 인지 광고와
// 공유하도록 별도 라우팅 객체를 만들며, 원본 target은 변경하지 않는다.
export function threadRouteForOwnerTarget(target) {
  const originalCategory = String(target?.channelCategory || '').trim() || '소유 YouTube';
  const category = originalCategory.toLowerCase().includes('소유 youtube')
    ? '인지 광고'
    : originalCategory;
  return {
    category,
    target: category === originalCategory ? target : { ...target, channelCategory: category },
  };
}

export function ownerRunFailure(summary = {}) {
  const hardDegraded = Array.isArray(summary.degraded) ? summary.degraded : [];
  if (!hardDegraded.length) return null;
  const error = new Error(`YouTube owner-channel degraded in ${hardDegraded.map((item) => item.stage).join(', ')}`);
  error.summary = summary;
  return error;
}

export function recordOwnerLlmSoftDegraded(summary, health = null, error = null) {
  if (!Array.isArray(summary.softDegraded)) summary.softDegraded = [];
  if (error) {
    summary.softDegraded.push({
      stage: 'llm-health',
      error: String(error?.message || error),
    });
    return;
  }
  if (!health?.degraded) return;
  const deferred = health.llmDeferredComments == null
    ? Number(health.keywordFallbackComments || 0)
    : Number(health.llmDeferredComments || 0);
  summary.softDegraded.push({
    stage: 'llm-classification',
    error: `${health.failureCode || 'unknown'}; deferred=${deferred}/${health.candidateComments || 0}`,
  });
}

export async function runYouTubeOwnerChannels(config = loadYouTubeOwnerChannelConfig(), fetchImpl = fetch, now = Date.now()) {
  const collected = await collectYouTubeOwnerChannels(config, fetchImpl, now);
  const summary = {
    ownerTokens: collected.ownerTokens,
    configuredOwners: collected.configuredOwners,
    totalConfiguredChannels: collected.totalConfiguredChannels,
    authenticatedChannels: collected.authenticatedChannels,
    missingOAuthChannels: collected.missingOAuthChannels,
    channels: collected.channels,
    videos: collected.videos,
    due: collected.due,
    deepDue: collected.deepDue,
    spikeDue: collected.spikeDue,
    paginationDeepDue: collected.paginationDeepDue,
    riskDue: collected.riskDue,
    riskSignals: collected.riskSignals,
    unchanged: collected.unchanged,
    zeroBaseline: collected.zeroBaseline,
    noSignal: collected.noSignal,
    comments: collected.comments,
    entries: collected.entries.length,
    sentAlerts: 0,
    overloadWarnings: 0,
    overloadWarningFailures: 0,
    channelFailures: collected.channelFailures,
    degraded: [],
    softDegraded: [],
  };
  const coverage = summarizeOwnerOAuthCoverage(collected);
  summary.oauthCoverage = coverage;
  if (!config.dryRun) {
    try {
      summary.oauthCoverage = await monitorOwnerOAuthCoverage(config, collected, fetchImpl, now);
    } catch (error) {
      // OAuth 커버리지 경고 자체의 장애는 인증된 채널 수집·숨김을 막지 않는다.
      summary.softDegraded.push({ stage: 'oauth-coverage-health', error: String(error?.message || error) });
      console.error(`[youtube-owner-channel:coverage-health-degraded] ${error.message}`);
    }
  }
  if (collected.riskSignalFailure) {
    // 위험도 재스캔 신호가 사라지면 commentCount 상쇄 구멍이 다시 열린다. 수집 자체는
    // 끝까지 진행하되 보조 모니터를 degraded로 표시해 무음 퇴행을 막는다.
    summary.degraded.push({ stage: 'risk-signal', error: collected.riskSignalFailure });
  }
  const llmStats = { calls: 0, attempts: 0, failedAttempts: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const risksPerEntry = await classifyTargetsBatched(collected.entries, config, undefined, llmStats, fetchImpl);
  const deferredVideoIds = deferredEntryKeys(
    collected.entries,
    risksPerEntry,
    (target) => target?.youtubeVideoId,
  );
  summary.llmDeferredComments = Number(llmStats.llmDeferredComments || 0);
  summary.llmDeferredVideos = deferredVideoIds.size;
  let classifierHash = null;
  try { classifierHash = computeClassifierHash(config); } catch { classifierHash = null; }
  const threads = new Map();

  async function threadFor(target) {
    const label = productLabel(productGroup(target.productName));
    const route = threadRouteForOwnerTarget(target);
    const { category } = route;
    const scopeKey = `${label}|${category}`;
    if (threads.has(scopeKey)) return threads.get(scopeKey);
    const ts = await ensureDailyThread(config, {
      kstDate: kstDateKey(now), scopeKey, productLabel: label, category,
      assignee: assigneeForTarget(route.target, config.slackAssignees),
    }, fetchImpl);
    threads.set(scopeKey, ts);
    return ts;
  }

  for (let entryIndex = 0; entryIndex < collected.entries.length; entryIndex += 1) {
    const { target, comments } = collected.entries[entryIndex];
    const risks = risksPerEntry[entryIndex] || [];
    const alertRisks = suppressLowConfidenceOwnerRisks(target, comments, risks);
    const alerts = comments
      .map((comment, index) => ({ ...comment, risk: alertRisks[index] || { alert: false } }))
      .filter((comment) => comment.risk.alert);
    const fingerprints = alerts.map((comment) => commentFingerprint(target, comment));
    const seen = config.dryRun ? new Set() : await loadSeenFingerprints(config, fingerprints, fetchImpl);
    for (let index = 0; index < alerts.length; index += 1) {
      if (seen.has(fingerprints[index])) continue;
      if (!config.dryRun) {
        if (config.youtubeOwnerAlertDelayMs > 0) await wait(config.youtubeOwnerAlertDelayMs);
        const threadTs = await threadFor(target);
        const slack = await retrySlackRateLimit(
          () => sendAlert(config, target, alerts[index], fetchImpl, threadTs),
          { maxRetries: 5, retryDelayMs: 3000 },
        );
        await recordAlert(config, target, alerts[index], fingerprints[index], slack.ts, classifierHash, fetchImpl);
      }
      summary.sentAlerts += 1;
    }

    if (!config.dryRun && target.ownedChannelBrandHostilityScope === true) {
      try {
        const assessment = assessOwnerCommentOverload(comments, risks, config, target);
        const route = threadRouteForOwnerTarget(target);
        const overload = await maybeWarnOwnerCommentOverload(
          config,
          target,
          assessment,
          assessment.overloaded ? await threadFor(target) : '',
          assigneeForTarget(route.target, config.slackAssignees),
          fetchImpl,
          now,
        );
        if (overload.alerted) summary.overloadWarnings += 1;
        if (overload.error) throw new Error(overload.error);
      } catch (error) {
        summary.overloadWarningFailures += 1;
        console.error(`[youtube-owner-overload:degraded] ${error.message}`);
      }
    }
  }

  if (!config.dryRun) {
    // Slack/DB 기록까지 성공한 뒤에만 델타 기준을 전진시킨다. 중간 실패 시 다음 회차가 재수집하고 dedup이 보호한다.
    try {
      const resolvedStateUpdates = collected.stateUpdates.filter(
        (row) => !deferredVideoIds.has(String(row.video_id || '').trim()),
      );
      summary.stateRowsSaved = await saveOwnerVideoStates(config, resolvedStateUpdates, fetchImpl);
      if (deferredVideoIds.size) {
        console.error(`[youtube-owner-channel:llm-deferred] ${llmStats.llmDeferredComments || 0}건 / 영상 ${deferredVideoIds.size}개 — scan checkpoint 미갱신, 다음 회차 재분류`);
      }
    } catch (error) {
      summary.stateRowsSaved = 0;
      summary.degraded.push({ stage: 'state-write', error: String(error?.message || error) });
      console.error(`[youtube-owner-channel:degraded] state-write — ${error.message}`);
    }
    if (config.youtubeOwnerAutoHide) {
      try {
        summary.moderation = await moderateYouTubeOwnerAlerts(
          moderationConfig(config, collected.allowedVideoIds), fetchImpl, now,
        );
        if (summary.moderation.moderationFailed || summary.moderation.channelFailures) {
          summary.degraded.push({
            stage: 'moderation',
            error: `failed=${summary.moderation.moderationFailed || 0}, channelFailures=${summary.moderation.channelFailures || 0}`,
          });
        }
      } catch (error) {
        summary.degraded.push({ stage: 'moderation', error: String(error?.message || error) });
        console.error(`[youtube-owner-channel:degraded] moderation — ${error.message}`);
      }
    }
  }

  const estimatedUsd = estimateUsd(llmStats, config.anthropicModel);
  summary.llm = { ...llmStats, estUsd: Number(estimatedUsd.toFixed(5)) };
  try {
    summary.llmHealth = await monitorLlmHealth(config, llmStats, {
      scope: 'youtube-owner', label: 'YouTube 소유 채널', totalComments: summary.comments, notify: !config.dryRun,
    }, fetchImpl, now);
    recordOwnerLlmSoftDegraded(summary, summary.llmHealth);
  } catch (error) {
    // 헬스 기록/Slack 경고 자체가 실패해도 이미 산출한 키워드 판정과 알림을 버리지 않는다.
    // 분류 공급자 전면 실패는 soft-degraded(exit 0)이며, 수집·DB·모더레이션 장애만 hard-degraded다.
    summary.llmHealth = {
      degraded: true,
      keywordFallback: Number(llmStats.keywordFallbackComments || 0) > 0,
      keywordFallbackComments: Number(llmStats.keywordFallbackComments || 0),
      llmDeferredComments: Number(llmStats.llmDeferredComments || 0),
      healthMonitorError: String(error?.message || error),
    };
    recordOwnerLlmSoftDegraded(summary, null, error);
    console.error(`[youtube-owner-channel:soft-degraded] llm-health — ${error.message}`);
  }
  if (!config.dryRun) {
    await recordRunCost(config, {
      runKey: `youtube-owner-channel:${process.env.GITHUB_RUN_ID || now}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`,
      kstDate: kstDateKey(now), apifyUsd: 0, anthropicUsd: estimatedUsd,
    }, fetchImpl);
  }
  console.error(`[youtube-owner-channel] channels=${summary.channels}/${summary.totalConfiguredChannels} authenticated=${summary.authenticatedChannels} missingOAuth=${summary.oauthCoverage.missing} videos=${summary.videos} due=${summary.due} deepDue=${summary.deepDue} spikeDue=${summary.spikeDue} paginationDeepDue=${summary.paginationDeepDue} riskDue=${summary.riskDue} riskSignals=${summary.riskSignals} unchanged=${summary.unchanged} noSignal=${summary.noSignal} comments=${summary.comments} alerts=${summary.sentAlerts} geminiCalls=${llmStats.geminiCalls || 0} anthropicCalls=${llmStats.anthropicCalls || 0} fallback=${llmStats.keywordFallbackComments || 0} deferred=${llmStats.llmDeferredComments || 0} failures=${summary.channelFailures.length} softDegraded=${summary.softDegraded.length} est=$${estimatedUsd.toFixed(5)}`);
  if (summary.channelFailures.length) {
    summary.degraded.push({
      stage: 'collection',
      error: `${summary.channelFailures.length} channel(s) failed`,
    });
  }
  const failure = ownerRunFailure(summary);
  if (failure) throw failure;
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runYouTubeOwnerChannels()
    .then((summary) => console.log(JSON.stringify(summary, (key, value) => key === 'allowedVideoIds' ? undefined : value, 2)))
    .catch((error) => {
      if (error.summary) console.log(JSON.stringify(error.summary, null, 2));
      console.error(`[youtube-owner-channel:degraded] ${error.message}`);
      // 보조 모니터 전용 코드. Workflow는 이 step만 failure로 표시하고 job 전체는 계속 진행한다.
      process.exitCode = 2;
    });
}
