import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { loadSeenFingerprints, recordAlert, commentFingerprint } from './dedup.js';
import { sendAlert, assigneeForTarget, productGroup, productLabel } from './slack.js';
import { ensureDailyThread } from './threads.js';
import { kstDateKey } from './schedule.js';
import { computeClassifierHash } from './cache.js';
import { estimateUsd } from './pricing.js';
import { maybeAlertCosts, postCostWarning, recordRunCost, sumDailyCost } from './cost.js';
import { buildYouTubeAdEntries, loadYouTubeAdsConfig } from './youtube-ads.js';

export function inYouTubeAdsWindow(now = Date.now(), env = process.env) {
  if (String(env.YOUTUBE_ADS_FORCE || '').toLowerCase() === 'true') return true;
  const start = Number(env.YOUTUBE_ADS_WINDOW_START || 8);
  const end = Number(env.YOUTUBE_ADS_WINDOW_END || 11);
  const kstHour = new Date(now + 9 * 3600 * 1000).getUTCHours();
  return kstHour >= start && kstHour <= end;
}

export function youtubeDailyRunKey(config, now = Date.now()) {
  return `daily:youtube-ads:${config.googleAdsLoginCustomerId}:${kstDateKey(now)}`;
}

export async function hasYouTubeAdsRunToday(config, now = Date.now(), fetchImpl = fetch) {
  if (!config.supabaseUrl || !config.supabaseKey) return false;
  try {
    const key = youtubeDailyRunKey(config, now);
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/cost_usage_ledger?select=run_key&run_key=eq.${encodeURIComponent(key)}&limit=1`,
      { headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` } },
    );
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

export async function runYouTubeAds(config = loadYouTubeAdsConfig(), fetchImpl = fetch, now = Date.now()) {
  if (!inYouTubeAdsWindow(now)) {
    return { customers: 0, campaigns: 0, assets: 0, videos: 0, comments: 0, entries: 0, sentAlerts: 0, skipped: 'outside-morning-window' };
  }
  const forced = String(process.env.YOUTUBE_ADS_FORCE || '').toLowerCase() === 'true';
  if (!forced && await hasYouTubeAdsRunToday(config, now, fetchImpl)) {
    return { customers: 0, campaigns: 0, assets: 0, videos: 0, comments: 0, entries: 0, sentAlerts: 0, skipped: 'already-ran-today' };
  }

  const collected = await buildYouTubeAdEntries(config, fetchImpl, now);
  const summary = { ...collected, entries: collected.entries.length, sentAlerts: 0 };
  if (!collected.entries.length) {
    if (!config.dryRun) {
      await recordRunCost(config, {
        runKey: youtubeDailyRunKey(config, now), kstDate: kstDateKey(now), apifyUsd: 0, anthropicUsd: 0,
      }, fetchImpl);
    }
    console.error(`[youtube-ads] customers=${summary.customers} campaigns=${summary.campaigns} assets=${summary.assets} videos=${summary.videos} owned=${summary.ownedVideos || 0} external=${summary.externalVideos || 0} comments=${summary.comments} alerts=0`);
    return summary;
  }

  const llmStats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  // 인지 광고는 제품 문맥이 확정되어 있으므로 Meta 광고와 같은 전량 문맥 분류 경로를 재사용한다.
  // 알림/DB source는 youtube_ads로 보존해 후속 플랫폼 처리와 감사 기록을 분리한다.
  const classificationEntries = collected.entries.map((entry) => ({
    ...entry,
    target: { ...entry.target, source: 'meta_ads' },
  }));
  const risksPerEntry = await classifyTargetsBatched(classificationEntries, config, undefined, llmStats, fetchImpl);
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

  for (let entryIndex = 0; entryIndex < collected.entries.length; entryIndex += 1) {
    const { target, comments } = collected.entries[entryIndex];
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
  console.error(`[youtube-ads] customers=${summary.customers} campaigns=${summary.campaigns} assets=${summary.assets} videos=${summary.videos} owned=${summary.ownedVideos || 0} external=${summary.externalVideos || 0} comments=${summary.comments} alerts=${summary.sentAlerts} llmCalls=${llmStats.calls} est=$${estimatedUsd.toFixed(5)}`);

  if (!config.dryRun) {
    try {
      const kstDate = kstDateKey(now);
      await recordRunCost(config, {
        runKey: youtubeDailyRunKey(config, now), kstDate, apifyUsd: 0, anthropicUsd: estimatedUsd,
      }, fetchImpl);
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
      console.error('[youtube-ads] 비용 집계 실패(분류에는 영향 없음):', error.message);
    }
  }
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runYouTubeAds()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
