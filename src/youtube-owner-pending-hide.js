import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadYouTubeOwnerModerationConfig,
  moderateYouTubeOwnerAlerts,
  YOUTUBE_OWNER_ALERT_SCOPES,
} from './youtube-owner-moderation.js';

function supabaseHeaders(config) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
  };
}

export async function loadTrackedOwnerVideoIds(config, fetchImpl = fetch) {
  const ids = new Set();
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/youtube_owner_video_state`);
    url.searchParams.set('select', 'video_id');
    url.searchParams.set('order', 'video_id.asc');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '1000');
    const response = await fetchImpl(url, { headers: supabaseHeaders(config) });
    if (!response.ok) {
      throw new Error(`YouTube owner state GET failed (${response.status}); run supabase/008_youtube_owner_video_state.sql`);
    }
    const rows = await response.json();
    for (const row of rows || []) {
      const id = String(row?.video_id || '').trim();
      if (id) ids.add(id);
    }
    if (!Array.isArray(rows) || rows.length < 1000) break;
  }
  return ids;
}

export function pendingOwnerModerationConfig(
  config,
  allowedVideoIds,
  alertScope = YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
) {
  return {
    ...config,
    dryRun: false,
    singleAlert: false,
    autoHideAllNegatives: true,
    alertScope,
    allowedVideoIds,
    batchSize: 50,
    actor: 'youtube-owner-pending-auto-hide',
  };
}

const SUM_FIELDS = [
  'totalAlerts',
  'eligibleCandidates',
  'trackedEligibleCandidates',
  'matchedCandidates',
  'missingCommentId',
  'unmatchedVideo',
  'alreadyMarkedHidden',
  'skippedHumanDecision',
  'attempted',
  'hidden',
  'unavailableOrAlreadyHidden',
  'moderationUnavailable',
  'moderationFailed',
  'acceptedUnverified',
  'verificationRetries',
  'channelFailures',
  'persistenceFailed',
  'dbUpdated',
  'slackUpdated',
  'slackUpdateFailed',
];

export function combinePendingModerationResults(results) {
  const combined = {};
  for (const field of SUM_FIELDS) {
    combined[field] = results.reduce((sum, result) => sum + Number(result?.[field] || 0), 0);
  }
  combined.scopes = results.map((result) => ({
    alertScope: result.alertScope,
    eligibleCandidates: Number(result.eligibleCandidates || 0),
    trackedEligibleCandidates: Number(result.trackedEligibleCandidates || 0),
    matchedCandidates: Number(result.matchedCandidates || 0),
    attempted: Number(result.attempted || 0),
    hidden: Number(result.hidden || 0),
    unavailableOrAlreadyHidden: Number(result.unavailableOrAlreadyHidden || 0),
    moderationFailed: Number(result.moderationFailed || 0),
  }));
  return combined;
}

export function assertPendingModerationMadeProgress(result) {
  const matched = Number(result.matchedCandidates || 0);
  const tracked = Number(result.trackedEligibleCandidates || 0);
  const handled = Number(result.attempted || 0)
    + Number(result.unavailableOrAlreadyHidden || 0)
    + Number(result.moderationFailed || 0)
    + Number(result.channelFailures || 0);
  if ((matched > 0 || tracked > 0) && handled === 0) {
    throw new Error(
      `YouTube owner pending moderation made no progress `
      + `(tracked=${tracked}, matched=${matched}, attempted=0)`,
    );
  }
  return result;
}

export async function hidePendingYouTubeOwnerAlerts(
  config = loadYouTubeOwnerModerationConfig(),
  fetchImpl = fetch,
  now = Date.now(),
  moderateImpl = moderateYouTubeOwnerAlerts,
) {
  const allowedVideoIds = await loadTrackedOwnerVideoIds(config, fetchImpl);
  if (!allowedVideoIds.size) {
    return { skipped: 'no-tracked-owner-videos', trackedVideos: 0 };
  }
  // 오가닉(source=null)과 광고(source=youtube_ads)는 같은 owner OAuth로 숨길 수 있다.
  // 기존 구현은 오가닉 범위만 실행해 광고에서 204 뒤 확인 대기 상태로 남은 댓글이
  // 영구히 재검증되지 않았다. 두 범위를 분리 호출해 사람 keep 결정은 기존 엔진에서 보존한다.
  const results = [];
  for (const alertScope of [
    YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
    YOUTUBE_OWNER_ALERT_SCOPES.ADS,
  ]) {
    results.push(await moderateImpl(
      pendingOwnerModerationConfig(config, allowedVideoIds, alertScope),
      fetchImpl,
      now,
    ));
  }
  return assertPendingModerationMadeProgress({
    ...combinePendingModerationResults(results),
    trackedVideos: allowedVideoIds.size,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  hidePendingYouTubeOwnerAlerts()
    .then((result) => {
      // 공개 Actions 로그에는 댓글 ID·본문·OAuth 토큰을 쓰지 않는다.
      console.log(JSON.stringify({
        trackedVideos: result.trackedVideos || 0,
        totalAlerts: result.totalAlerts || 0,
        eligibleCandidates: result.eligibleCandidates || 0,
        trackedEligibleCandidates: result.trackedEligibleCandidates || 0,
        matchedCandidates: result.matchedCandidates || 0,
        attempted: result.attempted || 0,
        hidden: result.hidden || 0,
        unavailableOrAlreadyHidden: result.unavailableOrAlreadyHidden || 0,
        moderationFailed: result.moderationFailed || 0,
        verificationRetries: result.verificationRetries || 0,
        channelFailures: result.channelFailures || 0,
        dbUpdated: result.dbUpdated || 0,
        slackUpdated: result.slackUpdated || 0,
        skipped: result.skipped || null,
      }));
      if (result.moderationFailed || result.channelFailures || result.persistenceFailed) {
        process.exitCode = 2;
      }
    })
    .catch((error) => {
      console.error(`[youtube-owner-pending-hide:degraded] ${error.message}`);
      process.exitCode = 2;
    });
}
