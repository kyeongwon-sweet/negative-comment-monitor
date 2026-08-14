import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { buildTikTokAdEntries, loadTikTokAdsConfig } from './tiktok-ads.js';
import { commentFingerprint, loadSeenFingerprints } from './dedup.js';
import { estimateUsd } from './pricing.js';

function countsBy(items, selector) {
  const out = {};
  for (const item of items) {
    const key = String(selector(item) || 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function summarizeTikTokSurvey(collected, alerts, seen, stats, estimatedUsd) {
  const unseen = alerts.filter((item) => !seen.has(item.fingerprint));
  return {
    windowDays: collected.windowDays,
    campaigns: collected.campaigns,
    ads: collected.ads,
    adgroups: collected.adgroups,
    rawComments: collected.comments,
    normalizedComments: collected.entries.reduce((sum, entry) => sum + entry.comments.length, 0),
    classifiedNegative: alerts.length,
    alreadyAlerted: alerts.length - unseen.length,
    unseenNegativeCandidates: unseen.length,
    categoryCounts: countsBy(alerts, (item) => item.risk.category),
    unseenCategoryCounts: countsBy(unseen, (item) => item.risk.category),
    llm: { ...stats, estUsd: Number(estimatedUsd.toFixed(5)) },
  };
}

async function loadSeenInBatches(config, fingerprints, fetchImpl) {
  const seen = new Set();
  for (let offset = 0; offset < fingerprints.length; offset += 75) {
    const batch = await loadSeenFingerprints(config, fingerprints.slice(offset, offset + 75), fetchImpl);
    for (const fingerprint of batch) seen.add(fingerprint);
  }
  return seen;
}

export async function surveyTikTokAds(config = loadTikTokAdsConfig(), fetchImpl = fetch, now = Date.now()) {
  // 조사 모드는 발송 기준시각을 무시하고 조회 범위 전체를 분류한다. Slack 발송·숨김·alert DB 쓰기는 없다.
  const surveyConfig = { ...config, dryRun: true, tiktokAdsAlertAfter: '' };
  const collected = await buildTikTokAdEntries(surveyConfig, fetchImpl, now);
  collected.windowDays = surveyConfig.tiktokAdsLookbackDays;
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const classificationEntries = collected.entries.map((entry) => ({
    ...entry,
    target: { ...entry.target, source: 'meta_ads' },
  }));
  const risks = await classifyTargetsBatched(classificationEntries, surveyConfig, undefined, stats, fetchImpl);
  const alerts = [];
  for (let entryIndex = 0; entryIndex < collected.entries.length; entryIndex += 1) {
    const entry = collected.entries[entryIndex];
    for (let commentIndex = 0; commentIndex < entry.comments.length; commentIndex += 1) {
      const risk = risks[entryIndex]?.[commentIndex] || { alert: false };
      if (!risk.alert) continue;
      const comment = entry.comments[commentIndex];
      alerts.push({
        fingerprint: commentFingerprint(entry.target, comment),
        risk,
      });
    }
  }
  const seen = await loadSeenInBatches(surveyConfig, alerts.map((item) => item.fingerprint), fetchImpl);
  return summarizeTikTokSurvey(collected, alerts, seen, stats, estimateUsd(stats, surveyConfig.anthropicModel));
}

async function writeStepSummary(summary) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## TikTok 인지 광고 댓글 전수 조사',
    '',
    `- 범위: 최근 ${summary.windowDays}일`,
    `- 캠페인 / 광고 / 광고그룹: ${summary.campaigns} / ${summary.ads} / ${summary.adgroups}`,
    `- API 원본 댓글 / 정규화 댓글: ${summary.rawComments} / ${summary.normalizedComments}`,
    `- 부정 판정: ${summary.classifiedNegative}`,
    `- 기존 Slack 알림: ${summary.alreadyAlerted}`,
    `- 신규 미처리 후보: ${summary.unseenNegativeCandidates}`,
    `- Anthropic 호출 / 검토 / 캐시히트: ${summary.llm.calls} / ${summary.llm.reviewed} / ${summary.llm.cacheHits}`,
    `- Anthropic 예상비용: $${summary.llm.estUsd.toFixed(5)}`,
    '',
    '> 읽기 전용 조사: Slack 발송·댓글 숨김·알림 DB 쓰기 없음',
    '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  surveyTikTokAds()
    .then(async (summary) => {
      console.log(JSON.stringify(summary, null, 2));
      await writeStepSummary(summary);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
