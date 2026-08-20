import { loadMetaAdsConfig } from './meta-ads.js';
import { fetchYouTubeVideoComments } from './youtube-ads.js';
import { loadYouTubeOwnerTokens, refreshAndVerifyOwner } from './youtube-owner-moderation.js';
import { YOUTUBE_SATELLITE_CHANNELS } from './youtube-satellite-oauth.js';

export const YOUTUBE_OWNER_CHANNELS = Object.freeze([
  { name: '먹짱언니', channelId: 'UCxfjcCvRPOPzo6PeAttO4Dg', channelCategory: '소유 YouTube' },
  { name: '썰푸는앵무새', channelId: 'UCQKpvEBNiMBrGzI2f2tAFeA', channelCategory: '소유 YouTube' },
  ...YOUTUBE_SATELLITE_CHANNELS.map(({ name, channelId }) => ({
    name,
    channelId,
    channelCategory: '위성채널',
  })),
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function parseExtraChannels(raw) {
  if (!String(raw || '').trim()) return [];
  const parsed = JSON.parse(String(raw));
  if (!Array.isArray(parsed)) throw new Error('YOUTUBE_OWNER_CHANNELS_JSON must be an array');
  return parsed.map((row) => ({
    name: String(row?.name || '').trim(),
    channelId: String(row?.channelId || '').trim(),
    channelCategory: String(row?.channelCategory || '소유 YouTube').trim(),
  })).filter((row) => row.channelId);
}

function uniqueChannels(channels) {
  const byId = new Map();
  for (const channel of channels) {
    if (!channel.channelId || byId.has(channel.channelId)) continue;
    byId.set(channel.channelId, channel);
  }
  return [...byId.values()];
}

export function loadYouTubeOwnerChannelConfig(env = process.env, now = Date.now()) {
  const base = loadMetaAdsConfig(env, now);
  const satellite = String(env.SLACK_ASSIGNEE_SATELLITE || '').trim();
  return {
    ...base,
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    youtubeAdsMaxThreadPages: positiveInt(env.YOUTUBE_OWNER_MAX_THREAD_PAGES, 10, 100),
    youtubeOwnerLookbackDays: positiveInt(env.YOUTUBE_OWNER_LOOKBACK_DAYS, 14, 90),
    youtubeOwnerMaxUploadPages: positiveInt(env.YOUTUBE_OWNER_MAX_UPLOAD_PAGES, 10, 100),
    youtubeOwnerDefaultProductName: String(env.YOUTUBE_OWNER_DEFAULT_PRODUCT_NAME || 'JD').trim(),
    youtubeOwnerAutoHide: String(env.YOUTUBE_OWNER_CHANNEL_AUTO_HIDE || 'true').toLowerCase() !== 'false',
    youtubeOwnerChannels: uniqueChannels([
      ...YOUTUBE_OWNER_CHANNELS,
      ...parseExtraChannels(env.YOUTUBE_OWNER_CHANNELS_JSON),
    ]),
    managedChannelCategories: ['위성채널', '소유 YouTube'],
    slackAssignees: {
      ...base.slackAssignees,
      satellite,
      jd: { satellite: String(env.SLACK_ASSIGNEE_JD_SATELLITE || satellite).trim() },
    },
  };
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

async function youtubeJson(config, pathname, query, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
    const error = new Error(`YouTube ${pathname} failed (${response.status})${reasons.length ? `: ${reasons.join(',')}` : ''}`);
    error.status = response.status;
    error.reasons = reasons;
    throw error;
  }
  return payload;
}

function chunks(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

export async function loadOwnerVideoStates(config, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/youtube_owner_video_state?select=channel_id,video_id,comment_count,last_scanned_count,last_scanned_at&limit=10000`,
    { headers: headers(config) },
  );
  if (!response.ok) {
    throw new Error(`YouTube owner state GET failed (${response.status}); run supabase/008_youtube_owner_video_state.sql`);
  }
  const rows = await response.json();
  return new Map(rows.map((row) => [String(row.video_id), row]));
}

export async function saveOwnerVideoStates(config, rows, fetchImpl = fetch) {
  if (!rows.length) return 0;
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/youtube_owner_video_state?on_conflict=channel_id,video_id`,
    {
      method: 'POST',
      headers: headers(config, {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(rows),
    },
  );
  if (!response.ok) throw new Error(`YouTube owner state UPSERT failed (${response.status})`);
  return rows.length;
}

export function inferOwnerVideoProduct(video, fallback = 'JD') {
  const text = `${video?.snippet?.title || ''} ${video?.snippet?.description || ''}`.toLowerCase();
  if (/파인트|p(?:혼|망|딸|애)/i.test(text)) return 'P';
  if (/듬뿍|db(?:혼|망|딸|애)/i.test(text)) return 'DB';
  if (/쫀득|멜론바|망고바|jd(?:멜|망|혼|복)/i.test(text)) return 'JD';
  return String(fallback || 'JD').trim() || 'JD';
}

export function shouldScanOwnerVideo(video, previous) {
  const current = Number(video?.statistics?.commentCount);
  if (!Number.isFinite(current) || current < 0) return { due: false, reason: 'no-signal', current: null };
  if (!previous) return { due: current > 0, reason: current > 0 ? 'first-scan' : 'zero-baseline', current };
  const rawLast = previous.last_scanned_count;
  const last = rawLast == null || rawLast === '' ? Number.NaN : Number(rawLast);
  if (!Number.isFinite(last) || last !== current) return { due: true, reason: 'changed', current };
  return { due: false, reason: 'unchanged', current };
}

export async function fetchRecentOwnerUploads(config, channel, accessToken, fetchImpl = fetch, now = Date.now()) {
  const channelPayload = await youtubeJson(config, 'channels', {
    part: 'id,snippet,contentDetails', id: channel.channelId, maxResults: 1,
  }, accessToken, fetchImpl);
  const actual = (channelPayload.items || []).find((item) => String(item.id) === channel.channelId);
  const uploads = actual?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`Owned channel has no uploads playlist (${channel.channelId})`);

  const cutoff = now - config.youtubeOwnerLookbackDays * DAY_MS;
  const playlistItems = [];
  let pageToken = '';
  for (let page = 0; page < config.youtubeOwnerMaxUploadPages; page += 1) {
    const payload = await youtubeJson(config, 'playlistItems', {
      part: 'id,snippet,contentDetails', playlistId: uploads, maxResults: 50, pageToken,
    }, accessToken, fetchImpl);
    let reachedOld = false;
    for (const item of payload.items || []) {
      const published = Date.parse(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '');
      if (Number.isFinite(published) && published < cutoff) { reachedOld = true; continue; }
      const videoId = String(item.contentDetails?.videoId || item.snippet?.resourceId?.videoId || '');
      if (videoId) playlistItems.push({ videoId, publishedAt: new Date(published || now).toISOString() });
    }
    pageToken = String(payload.nextPageToken || '');
    if (!pageToken || reachedOld) break;
  }

  const details = [];
  for (const batch of chunks(playlistItems, 50)) {
    const payload = await youtubeJson(config, 'videos', {
      part: 'id,snippet,statistics,status', id: batch.map((item) => item.videoId).join(','), maxResults: 50,
    }, accessToken, fetchImpl);
    details.push(...(payload.items || []));
  }
  return {
    channelName: String(actual?.snippet?.title || channel.name || channel.channelId),
    videos: details,
  };
}

function stateRow(channel, video, current, now, scanned, previous = null) {
  return {
    channel_id: channel.channelId,
    video_id: String(video.id),
    video_title: String(video.snippet?.title || '').slice(0, 500),
    published_at: String(video.snippet?.publishedAt || new Date(now).toISOString()),
    comment_count: current,
    last_seen_at: new Date(now).toISOString(),
    // PostgREST bulk upsert는 배열 행들의 키 집합이 다르면 400을 낼 수 있다. 변화 없음 행도
    // 직전 스캔 값을 명시해 모든 행을 동일한 완전 스키마로 보낸다.
    last_scanned_count: scanned ? current : Number(previous?.last_scanned_count),
    last_scanned_at: scanned ? new Date(now).toISOString() : (previous?.last_scanned_at || null),
  };
}

export async function collectYouTubeOwnerChannels(config, fetchImpl = fetch, now = Date.now()) {
  const states = await loadOwnerVideoStates(config, fetchImpl);
  const storedOwners = await loadYouTubeOwnerTokens(config, fetchImpl);
  const configured = new Map(config.youtubeOwnerChannels.map((channel) => [channel.channelId, channel]));
  const owners = storedOwners.filter((owner) => configured.has(owner.channelId));
  if (!owners.length) throw new Error('No configured YouTube owner OAuth channels are available');
  const entries = [];
  const stateUpdates = [];
  const allowedVideoIds = new Set();
  const channelFailures = [];
  const counts = { ownerTokens: storedOwners.length, configuredOwners: owners.length, channels: 0, videos: 0, due: 0, unchanged: 0, zeroBaseline: 0, noSignal: 0, comments: 0 };

  for (const owner of owners) {
    const channel = configured.get(owner.channelId);
    try {
      const accessToken = await refreshAndVerifyOwner(config, owner, fetchImpl);
      const collected = await fetchRecentOwnerUploads(config, channel, accessToken, fetchImpl, now);
      counts.channels += 1;
      counts.videos += collected.videos.length;
      for (const video of collected.videos) {
        const videoId = String(video.id || '');
        if (!videoId) continue;
        allowedVideoIds.add(videoId);
        const previous = states.get(videoId);
        const decision = shouldScanOwnerVideo(video, previous);
        if (decision.reason === 'no-signal') { counts.noSignal += 1; continue; }
        if (decision.reason === 'zero-baseline') {
          counts.zeroBaseline += 1;
          stateUpdates.push(stateRow(channel, video, decision.current, now, true));
          continue;
        }
        if (!decision.due) {
          counts.unchanged += 1;
          stateUpdates.push(stateRow(channel, video, decision.current, now, false, previous));
          continue;
        }
        counts.due += 1;
        const comments = await fetchYouTubeVideoComments(config, videoId, accessToken, fetchImpl);
        counts.comments += comments.length;
        stateUpdates.push(stateRow(channel, video, decision.current, now, true));
        if (!comments.length) continue;
        const productName = inferOwnerVideoProduct(video, config.youtubeOwnerDefaultProductName);
        entries.push({
          target: {
            platform: 'youtube',
            url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
            postKey: `yt:${videoId}`,
            channelName: collected.channelName,
            channelCategory: channel.channelCategory,
            productName,
            brandName: config.brandContext,
            caption: [video.snippet?.title, video.snippet?.description].filter(Boolean).join(' / '),
            youtubeVideoId: videoId,
            ownerChannelId: channel.channelId,
            isManagedAccount: true,
          },
          comments,
        });
      }
    } catch (error) {
      channelFailures.push({ channelId: owner.channelId, error: String(error?.message || error) });
    }
  }
  return { ...counts, entries, stateUpdates, allowedVideoIds, channelFailures };
}
