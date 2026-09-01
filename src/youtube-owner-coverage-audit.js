import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched, isLlmDeferred } from './hybrid-classify.js';
import { commentFingerprint, loadSeenFingerprints } from './dedup.js';
import {
  fetchRecentOwnerUploads,
  inferOwnerVideoProduct,
  loadYouTubeOwnerChannelConfig,
  YOUTUBE_BRAND_HOSTILITY_CHANNEL_IDS,
} from './youtube-owner-channel.js';
import { fetchYouTubeVideoComments } from './youtube-ads.js';
import { loadYouTubeOwnerTokens, refreshAndVerifyOwner } from './youtube-owner-moderation.js';
import { clearPlatformAlertClaim, recordPlatformOutcome } from './platform-health.js';
import { isHighConfidenceOwnerRisk } from './youtube-owner-risk.js';

const HEALTH_KEY = 'youtube-owner-detection-audit';

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function csvSet(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

export function loadOwnerCoverageAuditConfig(env = process.env, now = Date.now()) {
  return {
    ...loadYouTubeOwnerChannelConfig({ ...env, DRY_RUN: 'true' }, now),
    auditVideoIds: csvSet(env.YOUTUBE_OWNER_COVERAGE_AUDIT_VIDEO_IDS),
    auditMaxVideos: positiveInt(env.YOUTUBE_OWNER_COVERAGE_AUDIT_MAX_VIDEOS, 5, 25),
    // 주간 감사는 라이브와 같은 캐시/분류 결과를 읽는다. 강제 재분류는 명시적 진단 때만 사용한다.
    auditForceReclassify: String(env.YOUTUBE_OWNER_COVERAGE_AUDIT_FORCE_RECLASSIFY || 'false').toLowerCase() === 'true',
    auditMissingAlertThreshold: positiveInt(env.YOUTUBE_OWNER_COVERAGE_AUDIT_MISSING_THRESHOLD, 3, 100),
    auditDeferredAlertThreshold: positiveInt(env.YOUTUBE_OWNER_COVERAGE_AUDIT_DEFERRED_THRESHOLD, 25, 500),
    classificationCacheReadOnly: true,
  };
}

export function selectOwnerAuditVideos(candidates, requestedIds = new Set(), maxVideos = 5) {
  const requested = requestedIds instanceof Set ? requestedIds : new Set(requestedIds || []);
  const sorted = [...(requested.size
    ? candidates.filter((item) => requested.has(String(item.video?.id || '')))
    : candidates)]
    .sort((a, b) => Number(b.video?.statistics?.commentCount || 0) - Number(a.video?.statistics?.commentCount || 0));
  // 명시한 영상은 모두 감사한다. maxVideos는 자동 표본 선택에만 적용한다.
  return requested.size ? sorted : sorted.slice(0, Math.max(1, Number(maxVideos) || 5));
}

// 커버리지 감사는 새로운 의미론적 정책을 만드는 곳이 아니다. LLM 단독 톤 판정(드립·배우 평가·
// 댓글러끼리의 다툼)을 누락으로 세지 않고, 라이브 키워드 안전망도 동의하는 명백 부정 또는
// 제품/브랜드를 댓글 본문에서 직접 겨냥한 적대만 고신뢰 후보로 집계한다.
export function isHighConfidenceOwnerAuditRisk(entry, comment, risk) {
  return isHighConfidenceOwnerRisk(entry?.target || {}, comment, risk);
}

async function loadSeenInBatches(config, fingerprints, fetchImpl) {
  const seen = new Set();
  for (let offset = 0; offset < fingerprints.length; offset += 75) {
    const batch = await loadSeenFingerprints(config, fingerprints.slice(offset, offset + 75), fetchImpl);
    for (const fingerprint of batch) seen.add(fingerprint);
  }
  return seen;
}

export function summarizeOwnerDetectionAudit(entries, risksPerEntry, seen, meta = {}) {
  const videos = [];
  let publicComments = 0;
  let negativeCandidates = 0;
  let rawNegativeCandidates = 0;
  let suppressedCandidates = 0;
  let alreadyAlerted = 0;
  let missing = 0;
  let deferred = 0;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    let videoNegative = 0;
    let videoAlready = 0;
    let videoMissing = 0;
    let videoDeferred = 0;
    publicComments += entry.comments.length;
    for (let commentIndex = 0; commentIndex < entry.comments.length; commentIndex += 1) {
      const risk = risksPerEntry[entryIndex]?.[commentIndex] || { alert: false };
      if (isLlmDeferred(risk)) {
        deferred += 1;
        videoDeferred += 1;
        continue;
      }
      if (!risk.alert) continue;
      rawNegativeCandidates += 1;
      if (!isHighConfidenceOwnerAuditRisk(entry, entry.comments[commentIndex], risk)) {
        suppressedCandidates += 1;
        continue;
      }
      negativeCandidates += 1;
      videoNegative += 1;
      const fingerprint = commentFingerprint(entry.target, entry.comments[commentIndex]);
      if (seen.has(fingerprint)) {
        alreadyAlerted += 1;
        videoAlready += 1;
      } else {
        missing += 1;
        videoMissing += 1;
      }
    }
    videos.push({
      videoId: entry.target.youtubeVideoId,
      title: entry.target.videoTitle,
      channelName: entry.target.channelName,
      publicComments: entry.comments.length,
      negativeCandidates: videoNegative,
      alreadyAlerted: videoAlready,
      missing: videoMissing,
      deferred: videoDeferred,
    });
  }
  const denominator = alreadyAlerted + missing;
  return {
    ...meta,
    videoCount: entries.length,
    publicComments,
    negativeCandidates,
    rawNegativeCandidates,
    suppressedCandidates,
    alreadyAlerted,
    missing,
    deferred,
    pipelineMissRatePercent: denominator ? Number((missing / denominator * 100).toFixed(2)) : 0,
    videos,
  };
}

async function postSlack(config, summary, fetchImpl) {
  if (!config.slackBotToken || !config.slackChannelId) return false;
  const affected = summary.videos.filter((video) => video.missing || video.deferred).slice(0, 5);
  const text = [
    '⚠️ *YouTube 소유채널 공개댓글 감사 — 고신뢰 탐지 지연/누락 후보*',
    `표본 영상 ${summary.videoCount}개 · 공개댓글 ${summary.publicComments}개`,
    `고신뢰 누락 후보 ${summary.missing}개 · LLM 보류 ${summary.deferred}개 · 톤/드립 제외 ${summary.suppressedCandidates}개`,
    ...affected.map((video) => `• <https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}|${video.channelName || '소유 채널'} 영상> — 누락 ${video.missing}, 보류 ${video.deferred}`),
    '제품·브랜드 지향 명백 부정만 집계하며, 배우 평가·오프토픽 드립·댓글러 간 다툼은 제외합니다.',
    config.slackAssignees?.other ? `담당자: <@${config.slackAssignees.other}>` : '',
  ].filter(Boolean).join('\n');
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Slack API: ${payload.error || response.status}`);
  return true;
}

async function monitorAuditResult(config, summary, fetchImpl, now) {
  const missingThreshold = Math.max(1, Number(config.auditMissingAlertThreshold || 3));
  const deferredThreshold = Math.max(1, Number(config.auditDeferredAlertThreshold || 25));
  const ok = summary.videoCount > 0
    && summary.requestedNotFound === 0
    && summary.missing < missingThreshold
    && summary.deferred < deferredThreshold
    && summary.channelFailures === 0;
  const healthConfig = { ...config, platformFailureThreshold: 1, platformFailureAlertCooldownHours: 168 };
  const outcome = await recordPlatformOutcome(healthConfig, {
    platform: HEALTH_KEY,
    ok,
    error: ok ? '' : `videos=${summary.videoCount}; highConfidenceMissing=${summary.missing}/${missingThreshold}; deferred=${summary.deferred}/${deferredThreshold}; requestedNotFound=${summary.requestedNotFound}; channelFailures=${summary.channelFailures}`,
  }, fetchImpl, now);
  let alerted = false;
  if (!ok && outcome.shouldEscalate) {
    try {
      alerted = await postSlack(config, summary, fetchImpl);
      if (!alerted) await clearPlatformAlertClaim(healthConfig, HEALTH_KEY, fetchImpl, now).catch(() => {});
    } catch (error) {
      await clearPlatformAlertClaim(healthConfig, HEALTH_KEY, fetchImpl, now).catch(() => {});
      throw error;
    }
  }
  return { ok, alerted, persisted: outcome.persisted };
}

export async function auditYouTubeOwnerDetection(
  config = loadOwnerCoverageAuditConfig(),
  fetchImpl = fetch,
  now = Date.now(),
) {
  const configured = new Map(config.youtubeOwnerChannels.map((channel) => [channel.channelId, channel]));
  const storedOwners = (await loadYouTubeOwnerTokens(config, fetchImpl))
    .filter((owner) => configured.has(owner.channelId));
  const candidates = [];
  const channelFailures = [];
  for (const owner of storedOwners) {
    try {
      const accessToken = await refreshAndVerifyOwner(config, owner, fetchImpl);
      const channel = configured.get(owner.channelId);
      const collected = await fetchRecentOwnerUploads(config, channel, accessToken, fetchImpl, now);
      for (const video of collected.videos) candidates.push({ owner, accessToken, channel, channelName: collected.channelName, video });
    } catch (error) {
      channelFailures.push({ channelId: owner.channelId, error: String(error?.message || error) });
    }
  }
  const selected = selectOwnerAuditVideos(candidates, config.auditVideoIds, config.auditMaxVideos);
  const selectedIds = new Set(selected.map((item) => String(item.video?.id || '')));
  const requestedNotFound = [...config.auditVideoIds].filter((videoId) => !selectedIds.has(videoId));
  const entries = [];
  for (const item of selected) {
    const videoId = String(item.video.id);
    const comments = await fetchYouTubeVideoComments(
      { ...config, youtubeAdsMaxThreadPages: config.youtubeOwnerDeepMaxThreadPages },
      videoId,
      item.accessToken,
      fetchImpl,
    );
    const brandScope = YOUTUBE_BRAND_HOSTILITY_CHANNEL_IDS.has(item.channel.channelId);
    entries.push({
      target: {
        platform: 'youtube',
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        postKey: `yt:${videoId}`,
        youtubeVideoId: videoId,
        videoTitle: String(item.video.snippet?.title || videoId),
        channelName: item.channelName,
        channelCategory: item.channel.channelCategory,
        productName: inferOwnerVideoProduct(item.video, config.youtubeOwnerDefaultProductName),
        brandName: config.brandContext,
        caption: [item.video.snippet?.title, item.video.snippet?.description].filter(Boolean).join(' / '),
        ownedChannelBrandHostilityScope: brandScope,
        fullContextReview: brandScope || Number(item.video.statistics?.commentCount || 0) >= config.youtubeOwnerHighCommentThreshold,
        bypassClassificationCache: config.auditForceReclassify,
      },
      comments: comments.filter((comment) => String(comment.text || '').trim()),
    });
  }
  const stats = { calls: 0, attempts: 0, failedAttempts: 0, reviewed: 0, cacheHits: 0, cacheMiss: 0 };
  const risksPerEntry = await classifyTargetsBatched(entries, config, undefined, stats, fetchImpl);
  const negativeFingerprints = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    for (let commentIndex = 0; commentIndex < entries[entryIndex].comments.length; commentIndex += 1) {
      if (risksPerEntry[entryIndex]?.[commentIndex]?.alert) {
        negativeFingerprints.push(commentFingerprint(entries[entryIndex].target, entries[entryIndex].comments[commentIndex]));
      }
    }
  }
  const seen = await loadSeenInBatches(config, negativeFingerprints, fetchImpl);
  const summary = summarizeOwnerDetectionAudit(entries, risksPerEntry, seen, {
    configuredChannels: config.youtubeOwnerChannels.length,
    authenticatedChannels: storedOwners.length,
    candidateVideos: candidates.length,
    requestedNotFound: requestedNotFound.length,
    channelFailures: channelFailures.length,
    llm: stats,
  });
  summary.health = await monitorAuditResult(config, summary, fetchImpl, now);
  return summary;
}

async function writeSummary(summary) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## YouTube 소유채널 공개댓글 탐지 커버리지 감사', '',
    `- OAuth 인증/설정 채널: ${summary.authenticatedChannels}/${summary.configuredChannels}`,
    `- 후보/표본 영상: ${summary.candidateVideos}/${summary.videoCount}`,
    `- 공개댓글/LLM부정/고신뢰/톤·드립제외: ${summary.publicComments}/${summary.rawNegativeCandidates}/${summary.negativeCandidates}/${summary.suppressedCandidates}`,
    `- 기존알림/고신뢰 누락/LLM보류: ${summary.alreadyAlerted}/${summary.missing}/${summary.deferred}`,
    `- 파이프라인 누락 후보율: ${summary.pipelineMissRatePercent}%`,
    `- 요청 영상 미발견/채널 실패: ${summary.requestedNotFound}/${summary.channelFailures}`, '',
    '| 채널/영상 | 공개댓글 | 부정후보 | 기존 | 누락 | 보류 |',
    '|---|---:|---:|---:|---:|---:|',
    ...summary.videos.map((video) => `| ${String(video.channelName || '').replace(/\|/g, '\\|')} / [${String(video.title || video.videoId).replace(/\|/g, '\\|')}](https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}) | ${video.publicComments} | ${video.negativeCandidates} | ${video.alreadyAlerted} | ${video.missing} | ${video.deferred} |`),
    '',
    '> 읽기 전용: 알림·숨김·체크포인트·분류 캐시를 변경하지 않습니다.',
    '> 이 수치는 현재 분류기 기준 파이프라인 누락 후보율이며, 사람 검수 기준 의미론적 미탐률은 아닙니다.',
    '> 댓글 ID·본문·작성자·OAuth 토큰은 공개 로그에 기록하지 않습니다.', '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  auditYouTubeOwnerDetection()
    .then(async (summary) => {
      console.log(JSON.stringify({
        configuredChannels: summary.configuredChannels,
        authenticatedChannels: summary.authenticatedChannels,
        videoCount: summary.videoCount,
        publicComments: summary.publicComments,
        negativeCandidates: summary.negativeCandidates,
        rawNegativeCandidates: summary.rawNegativeCandidates,
        suppressedCandidates: summary.suppressedCandidates,
        alreadyAlerted: summary.alreadyAlerted,
        missing: summary.missing,
        deferred: summary.deferred,
        pipelineMissRatePercent: summary.pipelineMissRatePercent,
        channelFailures: summary.channelFailures,
        health: summary.health,
      }));
      await writeSummary(summary);
    })
    .catch((error) => {
      console.error(`[youtube-owner-coverage-audit] ${error.message}`);
      process.exitCode = 1;
    });
}
