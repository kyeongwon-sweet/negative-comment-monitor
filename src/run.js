import { loadConfig } from './config.js';
import { runActor } from './apify.js';
import { fetchTargets, submitResult } from './gas.js';
import { normalizeDataset } from './normalize.js';
import { detectPlatform, filterEligibleSponsorships, groupApifyTargets } from './routing.js';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { sendAlert } from './slack.js';
import { filterDueTargets, isEvergreenCategory, kstDateKey } from './schedule.js';
import { loadCommentCounts, filterChangedTargets, recordChecks, summarizeDelta, extractPostKey } from './delta.js';
import { commentFingerprint, loadRecentlyAlertedPostKeys, loadSeenFingerprints, recordAlert } from './dedup.js';
import { estimateUsd } from './pricing.js';
import { computeClassifierHash, purgeCache } from './cache.js';
import { falsePositiveStats } from './review.js';
import { ensureDailyThread } from './threads.js';
import { assigneeForChannelCategory } from './slack.js';
import { DEFAULT_COST_THRESHOLDS, estimateApifyUsd, maybeAlertCosts, postCostWarning, recordRunCost, runKey, sumDailyCost } from './cost.js';

export async function runMonitor(config = loadConfig()) {
  const runNow = Date.now();
  const rawTargets = await fetchTargets(config);
  const missingCategoryTargets = rawTargets.filter((target) => {
    const url = String(target.url || '').trim();
    const category = String(target.channelCategory || target.channelClassification || '').trim();
    return url && !category;
  });
  for (const target of missingCategoryTargets) {
    console.warn(`::warning title=Skipped target with missing channel category::${target.url}`);
  }
  const eligibleTargets = filterEligibleSponsorships(rawTargets, config.excludedChannelCategory);
  const eligibleMappedTargets = eligibleTargets.map((target) => ({
    ...target,
    platform: String(target.platform || detectPlatform(target.url)).toLowerCase(),
    // 감시 대상 = 라라스윗 협찬 게시물 → 브랜드 컨텍스트 부여(캡션에 브랜드명이 없어도
    // 제품 관련 부정댓글을 entity 게이트가 놓치지 않게 함). brandName은 classify가 postContext로 읽음.
    brandName: target.brandName || config.brandContext,
  }));
  // 일반 게시물은 업로드 7일 후 제외. 부스팅 게시물은 기간과 무관하게 일일 확인.
  const windowCutoff = runNow - config.trackingDays * 864e5;
  const windowedTargets = eligibleMappedTargets.filter((t) => {
    const d = Date.parse(t.uploadedAt || t.publishedAt || t.postedAt || '');
    // 부스팅·온드/위성(evergreen)은 기간 무관, 그 외 일반글만 업로드 7일 이내.
    return Boolean(t.isBoosted) || isEvergreenCategory(t.channelCategory) || !Number.isFinite(d) || d >= windowCutoff;
  });

  // Supabase의 마지막 확인·최근 알림 이력을 스케줄 입력으로 연결한다.
  let counts = {};
  let scheduledTargets = windowedTargets;
  if (config.supabaseUrl && config.supabaseKey) {
    try {
      counts = await loadCommentCounts(config, windowedTargets);
      const recentAlerts = await loadRecentlyAlertedPostKeys(config, 3 * 60 * 60 * 1000, fetch, runNow);
      scheduledTargets = windowedTargets.map((target) => ({
        ...target,
        lastCollectedAt: target.lastCollectedAt || counts[target.url]?.lastCheckedAt || '',
        recentNegativeDetectedAt: recentAlerts.get(extractPostKey(target.url)) || target.recentNegativeDetectedAt || '',
      }));
    } catch (error) {
      console.error('[schedule] Supabase 이력 조회 실패 — GAS 시각 정보로 진행:', error.message);
    }
  }
  const dueTargets = filterDueTargets(scheduledTargets, runNow);

  // 정기 확인은 댓글 수 증가분만 과금한다. 최근 부정댓글이 있는 집중 대상은
  // 대시보드 댓글 수 갱신을 기다리지 않고 15분마다 직접 수집한다.
  let targets = dueTargets;
  let deltaSkipped = 0;
  let summary_deltaBreakdown = null;
  if (config.deltaEnabled && config.supabaseUrl && config.supabaseKey) {
    try {
      if (!Object.keys(counts).length) counts = await loadCommentCounts(config, dueTargets);
      const changed = filterChangedTargets(dueTargets, counts);
      const intensive = dueTargets.filter((target) => {
        const detected = Date.parse(target.recentNegativeDetectedAt || '');
        return Number.isFinite(detected) && runNow - detected <= 3 * 60 * 60 * 1000;
      });
      targets = [...new Map([...changed, ...intensive].map((target) => [target.url, target])).values()];
      deltaSkipped = dueTargets.length - targets.length;
      summary_deltaBreakdown = summarizeDelta(dueTargets, counts);
      if (summary_deltaBreakdown.noSignal) {
        console.error(`[delta] 댓글 수 신호 없어 스킵된 대상 ${summary_deltaBreakdown.noSignal}건 — 커버리지 갭(대시보드 comments_count 미수집/URL 미매칭)`);
      }
    } catch (error) {
      console.error('[delta] 댓글 수 조회 실패 — 델타 스킵 없이 진행:', error.message);
    }
  }

  const groups = groupApifyTargets(targets);
  const scrapedTargets = [];
  let sentAlerts = 0;
  // LLM 사용량 계측(내용·키 미기록, 카운트/토큰만). cacheHits/cacheMiss=분류 캐시 적중 현황.
  const llmStats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const apifyCommentsByPlatform = {}; // 플랫폼별 수집 댓글 수(Apify 비용 추정 입력)
  const summary = {
    fetchedTargets: rawTargets.length,
    excludedTargets: rawTargets.length - eligibleMappedTargets.length,
    missingCategoryTargets: missingCategoryTargets.length,
    windowedTargets: windowedTargets.length,
    dueTargets: dueTargets.length,
    deltaSkipped,
    eligibleTargets: targets.length,
    graphSkipped: targets.length,
    slackChannelId: config.slackChannelId,
    dryRun: config.dryRun,
    platforms: {},
  };

  // Phase 1: 플랫폼별 스크레이프 → (게시물, 댓글) 엔트리 수집. 플랫폼 실패는 그 플랫폼만 기록.
  const entries = [];
  for (const [platform, platformTargets] of Object.entries(groups)) {
    summary.graphSkipped -= platformTargets.length;
    if (!platformTargets.length) continue;
    try {
      const items = await runActor(config, platform, platformTargets);
      const normalized = normalizeDataset(platform, items, '');
      apifyCommentsByPlatform[platform] = (apifyCommentsByPlatform[platform] || 0) + normalized.length;
      const single = platformTargets.length === 1;   // 단일 대상 배치면 URL 없는 댓글도 그 대상 소속
      for (const rawTarget of platformTargets) {
        const target = { ...rawTarget, caption: rawTarget.caption || (counts[rawTarget.url] || {}).caption || '' };
        const targetKey = extractPostKey(target.url);
        const targetComments = normalized.filter((comment) => {
          const ck = extractPostKey(comment.url);
          if (ck && targetKey) return ck === targetKey;        // 게시물 ID로 정확 매칭(중복 귀속 방지)
          if (single) return true;                              // 단일 대상 배치 예외
          return comment.url && comment.url === target.url;     // 그 외 정확 URL 일치만
        });
        entries.push({ target, comments: targetComments });
        scrapedTargets.push(target);   // 스크레이프 성공분만 last_count 갱신 대상
      }
      summary.platforms[platform] = { targets: platformTargets.length, items: normalized.length, ok: true };
    } catch (error) {
      // 실패 시 last_count 미갱신 → 다음 실행에서 재시도됨(부정댓글 없음으로 오보하지 않음)
      summary.platforms[platform] = { targets: platformTargets.length, items: 0, ok: false, error: error.message };
    }
  }

  // Phase 2: 실행 전체 문맥 후보를 25개 단위로 통합 분류(캐시 미스만 LLM). 결과는 entries와 동일 순서·귀속.
  const risksPerEntry = await classifyTargetsBatched(entries, config, undefined, llmStats);

  // 알림 당시 classifier_hash 기록용(오탐률 집계·오탐 우선적용 감사). 계산 실패는 무해(null 저장).
  let classifierHash = null;
  try { classifierHash = computeClassifierHash(config); } catch { classifierHash = null; }

  // 날짜×채널분류 스레드 ts를 실행 내 캐시(분류당 1회만 조회/생성). 실패 시 null → 최상위 발송 폴백.
  const kstDateForThreads = kstDateKey(runNow);
  const threadTsByCategory = new Map();
  async function resolveThreadTs(channelCategory) {
    const category = channelCategory || '기타';
    if (threadTsByCategory.has(category)) return threadTsByCategory.get(category);
    const assignee = assigneeForChannelCategory(category, config.slackAssignees);
    const ts = await ensureDailyThread(config, { kstDate: kstDateForThreads, channelCategory: category, assignee });
    threadTsByCategory.set(category, ts);
    return ts;
  }

  // Phase 3: 게시물별 dedup + 알림 발송(날짜×분류 스레드에 답글로, injibot 버튼 포함). DRY_RUN이면 카운트/로그만.
  for (let e = 0; e < entries.length; e += 1) {
    const { target, comments } = entries[e];
    const risks = risksPerEntry[e] || [];
    const classified = comments.map((comment, idx) => ({ ...comment, risk: risks[idx] || { alert: false } }));
    const alerts = classified.filter((comment) => comment.risk.alert);
    const fingerprints = alerts.map((comment) => commentFingerprint(target, comment));
    const seenFingerprints = config.dryRun ? new Set() : await loadSeenFingerprints(config, fingerprints);
    for (let alertIndex = 0; alertIndex < alerts.length; alertIndex += 1) {
      const comment = alerts[alertIndex];
      const fingerprint = fingerprints[alertIndex];
      if (seenFingerprints.has(fingerprint)) {
        console.error(`[dedup] already alerted: ${target.platform} | ${comment.id || fingerprint.slice(0, 12)}`);
        continue;
      }
      console.error(`[alert] ${target.platform} | ${comment.risk.category} | ${(comment.text || '').replace(/\s+/g, ' ').slice(0, 50)}`);
      if (!config.dryRun) {
        const threadTs = await resolveThreadTs(target.channelCategory);
        const slackResult = await sendAlert(config, target, comment, undefined, threadTs);
        await recordAlert(config, target, comment, fingerprint, slackResult.ts, classifierHash);
      }
      sentAlerts += 1;
    }
  }
  summary.sentAlerts = sentAlerts;

  // LLM 사용량 요약 + 예상 비용(단가는 pricing.js에 분리).
  const estUsd = estimateUsd(llmStats, config.anthropicModel);
  summary.llm = { ...llmStats, estUsd: Number(estUsd.toFixed(5)) };
  console.error(`[llm] calls=${llmStats.calls} reviewed=${llmStats.reviewed} cacheHit=${llmStats.cacheHits} cacheMiss=${llmStats.cacheMiss} in=${llmStats.inputTokens} out=${llmStats.outputTokens} promptCacheR=${llmStats.cacheRead} promptCacheC=${llmStats.cacheCreate} est=$${estUsd.toFixed(5)} (${config.anthropicModel})`);

  // 90일 초과 분류 캐시 정리(best-effort — 실패해도 무시).
  if (!config.dryRun) await purgeCache(config);

  // 일별(KST) 비용 누적 + 임계치 경고. run_key 멱등(재시도 중복합산 방지), 임계치별 하루 1회 발송.
  // 비용 경로의 어떤 실패도 모니터링 본류를 막지 않는다.
  if (config.supabaseUrl && config.supabaseKey && !config.dryRun) {
    try {
      const kstDate = kstDateKey(runNow);
      const runApifyUsd = estimateApifyUsd(apifyCommentsByPlatform);
      await recordRunCost(config, { runKey: runKey(process.env, runNow), kstDate, apifyUsd: runApifyUsd, anthropicUsd: estUsd });
      const daily = await sumDailyCost(config, kstDate);
      summary.cost = { kstDate, runApifyUsd: Number(runApifyUsd.toFixed(4)), runAnthropicUsd: Number(estUsd.toFixed(5)), daily };
      const thresholds = config.costThresholds || DEFAULT_COST_THRESHOLDS;
      const fired = await maybeAlertCosts(config, kstDate, daily, thresholds,
        (kind, amount, threshold) => postCostWarning(config, kind, amount, threshold, kstDate));
      if (fired.length) {
        summary.cost.alertsFired = fired;
        console.error(`[cost] 일일 비용 경고 발송: ${fired.join(', ')} (KST ${kstDate})`);
      }
    } catch (error) {
      console.error('[cost] 비용 집계/경고 실패(무시):', error.message);
    }

    // #8 classifier_hash별 오탐률 집계(best-effort).
    try {
      const reviewStats = await falsePositiveStats(config);
      if (reviewStats) summary.reviewStats = reviewStats;
    } catch (error) {
      console.error('[review] 오탐률 집계 실패(무시):', error.message);
    }
  }

  if (summary_deltaBreakdown) summary.deltaBreakdown = summary_deltaBreakdown;
  // 성공적으로 스크레이프한 게시물의 댓글 수 기준선 갱신(다음 실행부터 증가분만).
  if (config.deltaEnabled && config.supabaseUrl && config.supabaseKey && scrapedTargets.length && !config.dryRun) {
    try {
      summary.checksUpdated = await recordChecks(config, scrapedTargets, counts);
    } catch (error) {
      console.error('[delta] last_count 갱신 실패:', error.message);
    }
  }
  const failedPlatforms = Object.entries(summary.platforms)
    .filter(([, result]) => result.ok === false)
    .map(([platform]) => platform);
  if (failedPlatforms.length) {
    throw new Error(`Platform collection failed: ${failedPlatforms.join(', ')}`);
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runMonitor()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
