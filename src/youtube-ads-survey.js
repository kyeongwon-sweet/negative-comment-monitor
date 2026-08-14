import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { buildYouTubeAdEntries, loadYouTubeAdsConfig } from './youtube-ads.js';
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

export function summarizeYouTubeSurvey(collected, alerts, seen, stats, estimatedUsd) {
  const unseen = alerts.filter((item) => !seen.has(item.fingerprint));
  return {
    windowDays: collected.windowDays,
    customers: collected.customers,
    campaigns: collected.campaigns,
    assets: collected.assets,
    videos: collected.videos,
    ownedVideos: collected.ownedVideos,
    externalVideos: collected.externalVideos,
    comments: collected.comments,
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

export async function surveyYouTubeAds(config = loadYouTubeAdsConfig(), fetchImpl = fetch, now = Date.now()) {
  // 과거 조사에서는 라이브 시작시각을 무시한다. Slack 발송·댓글 조치·alert DB 쓰기는 없다.
  const surveyConfig = { ...config, dryRun: true, youtubeAdsAlertAfter: '' };
  const collected = await buildYouTubeAdEntries(surveyConfig, fetchImpl, now);
  collected.windowDays = surveyConfig.youtubeAdsLookbackDays;
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const classificationEntries = collected.entries.map((entry) => ({
    ...entry,
    // 인지 광고는 제품 문맥이 확정돼 있으므로 운영 경로처럼 모든 댓글을 문맥 분류한다.
    target: { ...entry.target, source: 'meta_ads' },
  }));
  const risks = await classifyTargetsBatched(classificationEntries, surveyConfig, undefined, stats, fetchImpl);
  const alerts = [];
  for (let entryIndex = 0; entryIndex < collected.entries.length; entryIndex += 1) {
    const entry = collected.entries[entryIndex];
    for (let commentIndex = 0; commentIndex < entry.comments.length; commentIndex += 1) {
      const risk = risks[entryIndex]?.[commentIndex] || { alert: false };
      if (!risk.alert) continue;
      alerts.push({
        fingerprint: commentFingerprint(entry.target, entry.comments[commentIndex]),
        risk,
      });
    }
  }
  const seen = await loadSeenInBatches(surveyConfig, alerts.map((item) => item.fingerprint), fetchImpl);
  return summarizeYouTubeSurvey(collected, alerts, seen, stats, estimateUsd(stats, surveyConfig.anthropicModel));
}

async function writeStepSummary(summary) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## YouTube 인지 광고 댓글 전수 조사',
    '',
    `- 범위: 최근 ${summary.windowDays}일`,
    `- 고객계정 / 캠페인 / 영상: ${summary.customers} / ${summary.campaigns} / ${summary.videos}`,
    `- 소유채널 / 광고용 외부채널 영상: ${summary.ownedVideos} / ${summary.externalVideos}`,
    `- 댓글·대댓글: ${summary.comments}`,
    `- 부정 판정: ${summary.classifiedNegative}`,
    `- 기존 Slack 알림: ${summary.alreadyAlerted}`,
    `- 신규 미처리 후보: ${summary.unseenNegativeCandidates}`,
    `- Anthropic 호출 / 검토 / 캐시히트: ${summary.llm.calls} / ${summary.llm.reviewed} / ${summary.llm.cacheHits}`,
    `- Anthropic 예상비용: $${summary.llm.estUsd.toFixed(5)}`,
    '',
    '> 읽기 전용 조사: Slack 발송·댓글 조치·알림 DB 쓰기 없음',
    '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  surveyYouTubeAds()
    .then(async (summary) => {
      console.log(JSON.stringify(summary, null, 2));
      await writeStepSummary(summary);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
