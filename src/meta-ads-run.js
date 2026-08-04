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

export async function runMetaAds(config = loadMetaAdsConfig(), fetchImpl = fetch, now = Date.now()) {
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
