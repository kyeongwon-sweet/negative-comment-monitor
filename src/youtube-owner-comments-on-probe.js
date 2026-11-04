// 읽기 전용. 소유채널마다 전체 업로드 중 댓글이 켜진 영상 목록을 만든다('모두 보류' 설정 작업 목록, 11-03).
// YouTube API는 영상의 '검토(모두 보류)' 설정을 읽거나 바꿀 수 없다 → 댓글 켜짐만 판정하고, 보류 설정은 Studio에서 한다.
// 판정: 영상마다 commentThreads(maxResults 1)를 불러 403 commentsDisabled면 꺼짐(isYouTubeCommentsDisabled).
// ⚠️ 소유자 토큰의 videos.list statistics는 댓글 꺼진 영상에도 commentCount를 준다(11-03 먹는김에 995/995 오판정)
//    → commentCount 유무로 판정하면 안 된다. 비용: 영상당 1 unit + 업로드 50개마다 playlistItems 1. 로그엔 채널ID·영상ID·개수만 남긴다(공개 레포).
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadYouTubeOwnerTokens } from './youtube-owner-moderation.js';
import { refreshGoogleAccessToken } from './youtube-ads.js';
import { isYouTubeCommentsDisabled } from './youtube-owner-overload.js';
import { assertQuotaHeadroom } from './youtube-quota-meter.js';

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
    // 검증용: 지정 영상만 판정(채널 전체 목록 대신). Studio 실측값과 대조할 때 쓴다.
    videoIds: String(env.COMMENTS_ON_PROBE_VIDEO_IDS || '').split(',').map((v) => v.trim()).filter(Boolean),
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


export async function probeChannelCommentsOn(config, channelId, accessToken, fetchImpl = fetch) {
  const channel = await youtubeGet(config, 'channels', { part: 'contentDetails,snippet', id: channelId, maxResults: 1 }, accessToken, fetchImpl);
  const item = channel.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('uploads playlist 없음');
  const ids = [...(config.videoIds || [])];
  let pageToken = config.videoIds?.length ? '' : 'START';
  let pages = 0;
  while (pageToken) {
    const page = await youtubeGet(config, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 50, pageToken: pageToken === 'START' ? '' : pageToken }, accessToken, fetchImpl);
    for (const row of page.items || []) if (row.contentDetails?.videoId) ids.push(String(row.contentDetails.videoId));
    pageToken = String(page.nextPageToken || '');
    pages += 1;
    if (pages >= config.maxPages) break;
  }
  // 영상마다 1 unit. 전 소유채널이면 수천 unit이라(11-03 3회 실행 ~3,700 → 다음날 quota 소진) 실행 전에 남은 양을 확인한다.
  if (typeof config.quotaGuard === 'function') await config.quotaGuard(ids.length);
  const on = [];
  const off = [];
  const unknown = [];
  for (const id of ids) {
    const disabled = await isYouTubeCommentsDisabled(config, id, accessToken, fetchImpl);
    // 판정 불가(null)는 켜짐 쪽으로 남긴다(작업 목록에서 빠뜨리지 않게) — 개수는 따로 보고.
    if (disabled === true) off.push(id);
    else { on.push(id); if (disabled === null) unknown.push(id); }
  }
  return { channelId, title: String(item?.snippet?.title || ''), videos: ids.length, commentsOn: on, commentsOff: off.length, unknown: unknown.length, truncated: Boolean(pageToken) };
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
  // 같은 실행 안의 앞 채널 사용분은 아직 원장에 없으니(종료 시 기록) 누적 예상치로 확인한다.
  let planned = 0;
  runCommentsOnProbe({ ...loadCommentsOnProbeConfig(), quotaGuard: (estimate) => assertQuotaHeadroom((planned += estimate), { maxRatio: 0.6 }) })
    .then(async (result) => {
      for (const c of result.channels) {
        console.log(c.error
          ? `[comments-on] ${c.channelId} error=${c.error}`
          : `[comments-on] ${c.channelId} videos=${c.videos} comments_on=${c.commentsOn.length} off=${c.commentsOff} unknown=${c.unknown} truncated=${c.truncated} ids=${c.commentsOn.join(',')}`);
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
