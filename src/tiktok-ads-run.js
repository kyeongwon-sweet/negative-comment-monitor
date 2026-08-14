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
import { buildTikTokAdEntries, loadTikTokAdsConfig } from './tiktok-ads.js';

export function inTikTokAdsWindow(now = Date.now(), env = process.env) {
  if (String(env.TIKTOK_ADS_FORCE || '').toLowerCase() === 'true') return true;
  const start = Number(env.TIKTOK_ADS_WINDOW_START || 8);
  const end = Number(env.TIKTOK_ADS_WINDOW_END || 11);
  const kstHour = new Date(now + 9 * 3600 * 1000).getUTCHours();
  return kstHour >= start && kstHour <= end;
}

export function tiktokDailyRunKey(config, now = Date.now()) {
  return `daily:tiktok-ads:${config.tiktokAdvertiserId}:${kstDateKey(now)}`;
}

// monitor.yml은 15분마다 깨어나지만 TikTok 댓글 폴링은 KST 하루 1회만 한다.
// 성공 원장 행을 확인한 뒤 스킵하며, 조회 실패는 감시 누락보다 중복 폴링이 안전하므로 fail-open 한다.
export async function hasTikTokAdsRunToday(config, now = Date.now(), fetchImpl = fetch) {
  if (!config.supabaseUrl || !config.supabaseKey) return false;
  try {
    const key = tiktokDailyRunKey(config, now);
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

export async function runTikTokAds(config = loadTikTokAdsConfig(), fetchImpl = fetch, now = Date.now()) {
  if (!inTikTokAdsWindow(now)) {
    return { campaigns: 0, ads: 0, adgroups: 0, comments: 0, entries: 0, sentAlerts: 0, skipped: 'outside-morning-window' };
  }
  const forced = String(process.env.TIKTOK_ADS_FORCE || '').toLowerCase() === 'true';
  if (!forced && await hasTikTokAdsRunToday(config, now, fetchImpl)) {
    return { campaigns: 0, ads: 0, adgroups: 0, comments: 0, entries: 0, sentAlerts: 0, skipped: 'already-ran-today' };
  }

  const collected = await buildTikTokAdEntries(config, fetchImpl, now);
  const summary = { ...collected, entries: collected.entries.length, sentAlerts: 0 };
  if (!collected.entries.length) {
    if (!config.dryRun) {
      await recordRunCost(config, {
        runKey: tiktokDailyRunKey(config, now), kstDate: kstDateKey(now), apifyUsd: 0, anthropicUsd: 0,
      }, fetchImpl);
    }
    return summary;
  }

  const llmStats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  // 다크 광고(source=tiktok_ads)는 hybrid-classify의 AD_COMMENT_SOURCES에 포함되어 전 댓글 문맥검토됨.
  const risksPerEntry = await classifyTargetsBatched(collected.entries, config, undefined, llmStats, fetchImpl);
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
  console.error(`[tiktok-ads] campaigns=${summary.campaigns} ads=${summary.ads} adgroups=${summary.adgroups} comments=${summary.comments} alerts=${summary.sentAlerts} llmCalls=${llmStats.calls} est=$${estimatedUsd.toFixed(5)}`);

  if (!config.dryRun) {
    try {
      const kstDate = kstDateKey(now);
      await recordRunCost(config, {
        runKey: tiktokDailyRunKey(config, now), kstDate, apifyUsd: 0, anthropicUsd: estimatedUsd,
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
      console.error('[tiktok-ads] 비용 집계 실패(분류에는 영향 없음):', error.message);
    }
  }
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runTikTokAds()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
