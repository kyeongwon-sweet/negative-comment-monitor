import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { loadSeenFingerprints, recordAlert, commentFingerprint } from './dedup.js';
import { sendAlert, assigneeForTarget, productGroup, productLabel } from './slack.js';
import { ensureDailyThread } from './threads.js';
import { kstDateKey } from './schedule.js';
import { computeClassifierHash } from './cache.js';
import { estimateUsd } from './pricing.js';
import { maybeAlertCosts, postCostWarning, recordRunCost, runKey, sumDailyCost } from './cost.js';
import {
  buildMetaAdEntries,
  loadMetaAdsConfig,
  loadPendingMetaAdEvents,
  markMetaAdEventsFailed,
  markMetaAdEventsProcessed,
} from './meta-ads.js';

// 인지 광고는 '아침 배치'로만 발송한다(부정댓글 관리 시간 정렬). 단, 특정 아침 크론에 의존하면
// GitHub이 그 크론을 드롭할 때 배치가 통째로 누락된다(실측: 아침 크론 드롭 사고). 그래서 안정적인
// 15분 웨이크를 그대로 타되 여기서 'KST 아침 시간대'에만 실제 처리하도록 게이트한다(자가치유).
//   - META_ADS_FORCE=true(수동 실행) 또는 KST 시(hour)==META_ADS_WINDOW_HOUR(기본 9)일 때만 동작.
//   - 그 외 시간대는 큐에 그대로 두고 아무 것도 하지 않는다(LLM·발송 없음).
// ⚠️ KST 09시 == UTC 00시 = GitHub 크론 최혼잡 시간대(대량 드롭). 실측: 최근 실행 중 KST 9시만 0건.
// 단일 시(9)로 게이트하면 그 시간 웨이크가 다 드롭돼 배치가 통째로 누락된다(주말 30건 적체 사고).
// → 죽은 UTC-0(KST 9)를 포함하되 앞뒤로 넓혀(KST 8~11) 실제로 도는 웨이크(UTC 23/1/2)를 타게 한다.
// 큐-비우기로 멱등: 창 내 첫 웨이크가 적체분 발송, 이후 웨이크는 신규분만. FORCE는 시간 무관 강제.
export function inMorningWindow(now = Date.now(), env = process.env) {
  if (String(env.META_ADS_FORCE || '').toLowerCase() === 'true') return true;
  const start = Number(env.META_ADS_WINDOW_START || 8);
  const end = Number(env.META_ADS_WINDOW_END || 11);
  const kstHour = new Date(now + 9 * 3600 * 1000).getUTCHours();
  return kstHour >= start && kstHour <= end;
}

export async function runMetaAds(config = loadMetaAdsConfig(), fetchImpl = fetch, now = Date.now()) {
  if (!inMorningWindow(now)) return { pendingEvents: 0, entries: 0, sentAlerts: 0, processedEvents: 0, skipped: 'outside-morning-window' };
  const events = await loadPendingMetaAdEvents(config, 100, fetchImpl);
  const eventIds = events.map((event) => event.id);
  const summary = { pendingEvents: events.length, entries: 0, sentAlerts: 0, processedEvents: 0 };
  if (!events.length) return summary;

  const llmStats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  try {
    const entries = await buildMetaAdEntries(config, events, fetchImpl);
    summary.entries = entries.length;
    const risksPerEntry = await classifyTargetsBatched(entries, config, undefined, llmStats, fetchImpl);
    let classifierHash = null;
    try { classifierHash = computeClassifierHash(config); } catch { classifierHash = null; }

    const threadTsByScope = new Map();
    async function resolveThreadTs(target) {
      const label = productLabel(productGroup(target.productName));
      const category = target.channelCategory || '인지 광고';
      const scopeKey = `${label}|${category}`;
      if (threadTsByScope.has(scopeKey)) return threadTsByScope.get(scopeKey);
      const assignee = assigneeForTarget(target, config.slackAssignees);
      const ts = await ensureDailyThread(config, {
        kstDate: kstDateKey(now), scopeKey, productLabel: label, category, assignee,
      }, fetchImpl);
      threadTsByScope.set(scopeKey, ts);
      return ts;
    }

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const { target, comments } = entries[entryIndex];
      const risks = risksPerEntry[entryIndex] || [];
      const alerts = comments
        .map((comment, index) => ({ ...comment, risk: risks[index] || { alert: false } }))
        .filter((comment) => comment.risk.alert);
      const fingerprints = alerts.map((comment) => commentFingerprint(target, comment));
      const seen = config.dryRun ? new Set() : await loadSeenFingerprints(config, fingerprints, fetchImpl);
      for (let alertIndex = 0; alertIndex < alerts.length; alertIndex += 1) {
        const comment = alerts[alertIndex];
        const fingerprint = fingerprints[alertIndex];
        if (seen.has(fingerprint)) continue;
        if (!config.dryRun) {
          const threadTs = await resolveThreadTs(target);
          const slack = await sendAlert(config, target, comment, fetchImpl, threadTs);
          await recordAlert(config, target, comment, fingerprint, slack.ts, classifierHash, fetchImpl);
        }
        summary.sentAlerts += 1;
      }
    }

    const estimatedUsd = estimateUsd(llmStats, config.anthropicModel);
    summary.llm = { ...llmStats, estUsd: Number(estimatedUsd.toFixed(5)) };
    console.error(`[meta-ads] events=${events.length} alerts=${summary.sentAlerts} llmCalls=${llmStats.calls} est=$${estimatedUsd.toFixed(5)}`);

    if (!config.dryRun) {
      summary.processedEvents = await markMetaAdEventsProcessed(config, eventIds, fetchImpl, now);
      try {
        const kstDate = kstDateKey(now);
        await recordRunCost(config, { runKey: runKey(process.env, now), kstDate, apifyUsd: 0, anthropicUsd: estimatedUsd }, fetchImpl);
        const daily = await sumDailyCost(config, kstDate, fetchImpl);
        summary.cost = { kstDate, daily };
        await maybeAlertCosts(
          config,
          kstDate,
          daily,
          config.costThresholds,
          (kind, amount, threshold) => postCostWarning(config, kind, amount, threshold, kstDate, fetchImpl),
          fetchImpl,
        );
      } catch (error) {
        console.error('[meta-ads] 비용 집계 실패(분류에는 영향 없음):', error.message);
      }
    }
    return summary;
  } catch (error) {
    if (!config.dryRun) await markMetaAdEventsFailed(config, eventIds, error, fetchImpl).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMetaAds()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
