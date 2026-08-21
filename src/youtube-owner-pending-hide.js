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

export function pendingOwnerModerationConfig(config, allowedVideoIds) {
  return {
    ...config,
    dryRun: false,
    singleAlert: false,
    autoHideAllNegatives: true,
    alertScope: YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
    allowedVideoIds,
    batchSize: 50,
    actor: 'youtube-owner-pending-auto-hide',
  };
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
  const result = await moderateImpl(
    pendingOwnerModerationConfig(config, allowedVideoIds),
    fetchImpl,
    now,
  );
  return { ...result, trackedVideos: allowedVideoIds.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  hidePendingYouTubeOwnerAlerts()
    .then((result) => {
      // 공개 Actions 로그에는 댓글 ID·본문·OAuth 토큰을 쓰지 않는다.
      console.log(JSON.stringify({
        trackedVideos: result.trackedVideos || 0,
        totalAlerts: result.totalAlerts || 0,
        attempted: result.attempted || 0,
        hidden: result.hidden || 0,
        unavailableOrAlreadyHidden: result.unavailableOrAlreadyHidden || 0,
        moderationFailed: result.moderationFailed || 0,
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
