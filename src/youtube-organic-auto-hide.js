import { extractPostKey } from './delta.js';
import {
  moderateYouTubeOwnerAlerts,
  YOUTUBE_OWNER_ALERT_SCOPES,
} from './youtube-owner-moderation.js';

export function satelliteYouTubeVideoIds(targets) {
  const ids = new Set();
  for (const target of targets || []) {
    const category = String(target?.channelCategory || target?.channelClassification || '').trim();
    if (!category.includes('위성채널')) continue;
    const key = extractPostKey(target?.url);
    if (key?.startsWith('yt:')) ids.add(key.slice(3));
  }
  return ids;
}

export function ownerModerationConfigFromMonitor(config, allowedVideoIds) {
  return {
    googleAdsClientId: config.googleAdsClientId,
    googleAdsClientSecret: config.googleAdsClientSecret,
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseKey,
    youtubeApiBase: config.youtubeApiBase || 'https://www.googleapis.com/youtube/v3',
    dryRun: false,
    singleAlert: false,
    autoHideAllNegatives: true,
    alertScope: YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
    allowedVideoIds,
    alertChannelId: '',
    alertMessageTs: '',
    batchSize: 50,
    actor: 'youtube-organic-satellite-auto-hide',
    slackBotToken: config.slackBotToken,
    slackUpdateDelayMs: 1100,
  };
}

export async function autoHideOrganicSatelliteYouTube(
  config,
  targets,
  fetchImpl = fetch,
  now = Date.now(),
) {
  if (config.dryRun || !config.youtubeSatelliteAutoHide) return { skipped: 'disabled' };
  const allowedVideoIds = satelliteYouTubeVideoIds(targets);
  if (!allowedVideoIds.size) return { skipped: 'no-satellite-youtube-targets' };
  if (!config.googleAdsClientId || !config.googleAdsClientSecret) {
    throw new Error('YouTube satellite auto-hide requires GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET');
  }
  return moderateYouTubeOwnerAlerts(
    ownerModerationConfigFromMonitor(config, allowedVideoIds),
    fetchImpl,
    now,
  );
}
