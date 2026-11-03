// 읽기 전용. 소유채널마다 전체 업로드 중 댓글이 켜진 영상 목록을 만든다('모두 보류' 설정 작업 목록, 11-03).
// YouTube API는 영상의 '검토(모두 보류)' 설정을 읽거나 바꿀 수 없다 → 댓글 켜짐만 판정하고, 보류 설정은 Studio에서 한다.
// 판정: videos.list statistics에 commentCount 속성이 없으면 댓글 꺼짐(ownerChannelTarget과 같은 규칙).
// 비용: 채널당 업로드 50개마다 playlistItems 1 + videos 1 unit. 로그엔 채널ID·영상ID·개수만 남긴다(공개 레포).
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadYouTubeOwnerTokens } from './youtube-owner-moderation.js';
import { refreshGoogleAccessToken } from './youtube-ads.js';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadCommentsOnProbeConfig(env = process.env) {
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    channelIds: String(env.COMMENTS_ON_PROBE_CHANNEL_IDS || '').split(',').map((v) => v.trim()).filter(Boolean),
    maxPages: Math.max(1, Math.min(100, Number(env.COMMENTS_ON_PROBE_MAX_PAGES || 60))),
  };
}

async function youtubeGet(config, resource, params, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/${resource}`);
  for (const [key, value] of Object.entries(params)) if (value !== '' && value != null) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean).join(',');
    throw new Error(`YouTube ${resource} failed (${response.status})${reasons ? `: ${reasons}` : ''}`);
  }
  return payload;
}

export function commentsEnabled(video) {
  // statistics가 없으면(부분 응답) 판정 불가 → 켜짐으로 본다(작업 목록에서 빠뜨리지 않는 쪽).
  if (!video?.statistics) return true;
  return Object.prototype.hasOwnProperty.call(video.statistics, 'commentCount');
}

export async function probeChannelCommentsOn(config, channelId, accessToken, fetchImpl = fetch) {
  const channel = await youtubeGet(config, 'channels', { part: 'contentDetails,snippet', id: channelId, maxResults: 1 }, accessToken, fetchImpl);
  const item = channel.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('uploads playlist 없음');
  const ids = [];
  let pageToken = '';
  let pages = 0;
  do {
    const page = await youtubeGet(config, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 50, pageToken }, accessToken, fetchImpl);
    for (const row of page.items || []) if (row.contentDetails?.videoId) ids.push(String(row.contentDetails.videoId));
    pageToken = String(page.nextPageToken || '');
    pages += 1;
  } while (pageToken && pages < config.maxPages);
  const on = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = await youtubeGet(config, 'videos', { part: 'statistics', id: ids.slice(i, i + 50).join(','), maxResults: 50 }, accessToken, fetchImpl);
    for (const video of batch.items || []) if (commentsEnabled(video)) on.push(String(video.id));
  }
  return { channelId, title: String(item?.snippet?.title || ''), videos: ids.length, commentsOn: on, truncated: Boolean(pageToken) };
}

export async function runCommentsOnProbe(config, fetchImpl = fetch) {
  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  const targets = config.channelIds.length ? owners.filter((o) => config.channelIds.includes(o.channelId)) : owners;
  const channels = [];
  for (const owner of targets) {
    try {
      const token = await refreshGoogleAccessToken(config, owner.refreshToken, fetchImpl);
      channels.push(await probeChannelCommentsOn(config, owner.channelId, token, fetchImpl));
    } catch (error) {
      channels.push({ channelId: owner.channelId, error: String(error.message || error).slice(0, 160) });
    }
  }
  return { channels };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCommentsOnProbe(loadCommentsOnProbeConfig())
    .then(async (result) => {
      for (const c of result.channels) {
        console.log(c.error
          ? `[comments-on] ${c.channelId} error=${c.error}`
          : `[comments-on] ${c.channelId} videos=${c.videos} comments_on=${c.commentsOn.length} truncated=${c.truncated} ids=${c.commentsOn.join(',')}`);
      }
      if (process.env.GITHUB_STEP_SUMMARY) {
        const lines = ['### 댓글 켜진 영상(소유채널)', '', '| 채널 | 업로드 | 댓글 켜짐 |', '|---|---|---|',
          ...result.channels.map((c) => `| ${c.channelId} | ${c.videos ?? '-'} | ${c.error ? `오류: ${c.error}` : c.commentsOn.length} |`)];
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
      }
      if (result.channels.some((c) => c.error)) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[comments-on] ${error.message}`);
      process.exitCode = 1;
    });
}
