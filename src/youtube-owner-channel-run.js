import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched } from './hybrid-classify.js';
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

export async function runYouTubeOwnerChannels(config = loadYouTubeOwnerChannelConfig(), fetchImpl = fetch, now = Date.now()) {
  const collected = await collectYouTubeOwnerChannels(config, fetchImpl, now);
  const summary = {
    ownerTokens: collected.ownerTokens,
    configuredOwners: collected.configuredOwners,
    channels: collected.channels,
    videos: collected.videos,
    due: collected.due,
    unchanged: collected.unchanged,
    zeroBaseline: collected.zeroBaseline,
    noSignal: collected.noSignal,
    comments: collected.comments,
    entries: collected.entries.length,
    sentAlerts: 0,
    channelFailures: collected.channelFailures,
    degraded: [],
  };
  const llmStats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const risksPerEntry = await classifyTargetsBatched(collected.entries, config, undefined, llmStats, fetchImpl);
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
    const alerts = comments
      .map((comment, index) => ({ ...comment, risk: risks[index] || { alert: false } }))
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
  }

  if (!config.dryRun) {
    // Slack/DB 기록까지 성공한 뒤에만 델타 기준을 전진시킨다. 중간 실패 시 다음 회차가 재수집하고 dedup이 보호한다.
    try {
      summary.stateRowsSaved = await saveOwnerVideoStates(config, collected.stateUpdates, fetchImpl);
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
  if (!config.dryRun) {
    await recordRunCost(config, {
      runKey: `youtube-owner-channel:${process.env.GITHUB_RUN_ID || now}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`,
      kstDate: kstDateKey(now), apifyUsd: 0, anthropicUsd: estimatedUsd,
    }, fetchImpl);
  }
  console.error(`[youtube-owner-channel] channels=${summary.channels}/${summary.configuredOwners} videos=${summary.videos} due=${summary.due} unchanged=${summary.unchanged} noSignal=${summary.noSignal} comments=${summary.comments} alerts=${summary.sentAlerts} failures=${summary.channelFailures.length} est=$${estimatedUsd.toFixed(5)}`);
  if (summary.channelFailures.length) {
    summary.degraded.push({
      stage: 'collection',
      error: `${summary.channelFailures.length} channel(s) failed`,
    });
  }
  if (summary.degraded.length) {
    const error = new Error(`YouTube owner-channel degraded in ${summary.degraded.map((item) => item.stage).join(', ')}`);
    error.summary = summary;
    throw error;
  }
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
