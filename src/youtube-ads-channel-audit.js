import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  fetchActiveGoogleAdsCustomerIds,
  fetchMatchingGoogleAdsCampaigns,
  fetchOwnedYouTubeChannel,
  fetchOwnedYouTubeVideos,
  fetchYouTubeVideoAssets,
  loadYouTubeAdsConfig,
  refreshGoogleAccessToken,
} from './youtube-ads.js';

function videoIdFromUrl(value) {
  try {
    return new URL(String(value || '')).searchParams.get('v') || '';
  } catch {
    return '';
  }
}

async function loadYouTubeAlerts(config, fetchImpl = fetch) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
    url.searchParams.set('select', 'post_url,review_decision');
    url.searchParams.set('source', 'eq.youtube_ads');
    url.searchParams.set('order', 'alerted_at.asc');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '1000');
    const response = await fetchImpl(url, {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
      },
    });
    if (!response.ok) throw new Error(`YouTube alert audit query failed (${response.status})`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export function summarizeAlertChannels(videos, alerts) {
  const videoById = new Map(videos.map((video) => [String(video.id), video]));
  const grouped = new Map();
  let unmatchedAlerts = 0;
  for (const alert of alerts) {
    const video = videoById.get(videoIdFromUrl(alert.post_url));
    if (!video) {
      unmatchedAlerts += 1;
      continue;
    }
    const channelId = String(video.snippet?.channelId || 'unknown');
    if (!grouped.has(channelId)) grouped.set(channelId, {
      channelId,
      channelTitle: String(video.snippet?.channelTitle || 'unknown'),
      alertCount: 0,
      falsePositiveCount: 0,
      videoIds: new Set(),
    });
    const row = grouped.get(channelId);
    row.alertCount += 1;
    if (alert.review_decision === 'false_positive') row.falsePositiveCount += 1;
    row.videoIds.add(String(video.id));
  }
  return {
    totalAlerts: alerts.length,
    unmatchedAlerts,
    channels: [...grouped.values()]
      .map((row) => ({ ...row, videoCount: row.videoIds.size, videoIds: undefined }))
      .sort((a, b) => b.alertCount - a.alertCount),
  };
}

export async function auditYouTubeAdChannels(config = loadYouTubeAdsConfig(), fetchImpl = fetch) {
  const adsToken = await refreshGoogleAccessToken(config, config.googleAdsRefreshToken, fetchImpl);
  const youtubeToken = await refreshGoogleAccessToken(config, config.youtubeRefreshToken, fetchImpl);
  const customerIds = await fetchActiveGoogleAdsCustomerIds(config, adsToken, fetchImpl);
  const assets = [];
  for (const customerId of customerIds) {
    const campaigns = await fetchMatchingGoogleAdsCampaigns(config, customerId, adsToken, fetchImpl);
    assets.push(...await fetchYouTubeVideoAssets(config, customerId, campaigns, adsToken, fetchImpl));
  }
  const byVideo = new Map();
  for (const asset of assets) if (!byVideo.has(asset.videoId)) byVideo.set(asset.videoId, asset);
  const ownedChannel = await fetchOwnedYouTubeChannel(config, youtubeToken, fetchImpl);
  const videos = await fetchOwnedYouTubeVideos(config, [...byVideo.values()], ownedChannel.id, youtubeToken, fetchImpl);
  const alerts = await loadYouTubeAlerts(config, fetchImpl);
  return {
    ownedOAuthChannel: { id: ownedChannel.id, title: String(ownedChannel.snippet?.title || '') },
    inventoryVideos: videos.length,
    ...summarizeAlertChannels(videos, alerts),
  };
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## YouTube 광고 댓글 소유 채널 진단',
    '',
    `- 현재 OAuth 채널: ${result.ownedOAuthChannel.title} (${result.ownedOAuthChannel.id})`,
    `- 광고 영상: ${result.inventoryVideos}`,
    `- 발송 알림: ${result.totalAlerts}`,
    `- 영상 메타데이터 미매칭: ${result.unmatchedAlerts}`,
    '',
    '| 실제 영상 채널 | 채널 ID | 영상 | 알림 | 무시(FP) |',
    '|---|---|---:|---:|---:|',
    ...result.channels.map((row) => `| ${row.channelTitle} | ${row.channelId} | ${row.videoCount} | ${row.alertCount} | ${row.falsePositiveCount} |`),
    '',
    '> 댓글 본문·작성자·토큰은 출력하지 않는 읽기 전용 진단입니다.',
    '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  auditYouTubeAdChannels()
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await writeSummary(result);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
