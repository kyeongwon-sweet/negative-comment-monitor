import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractPostKey } from './delta.js';
import { fetchYouTubeVideoComments, refreshGoogleAccessToken } from './youtube-ads.js';

const OWNER_TOKEN_PREFIX = 'youtube_owner:';
const DISCOVERABLE_STATUSES = ['published', 'heldForReview', 'likelySpam'];

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadGroundTruthConfig(env = process.env) {
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    alertId: required(env, 'YOUTUBE_OWNER_AUDIT_ALERT_ID'),
    maxPagesPerStatus: Math.max(1, Math.min(100, Number(env.YOUTUBE_OWNER_AUDIT_MAX_PAGES || 50))),
  };
}

function supabaseHeaders(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

async function readJson(response, label) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
    throw new Error(`${label} failed (${response.status})${reasons.length ? `: ${reasons.join(',')}` : ''}`);
  }
  return payload;
}

export async function loadAuditAlert(config, fetchImpl = fetch) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
  url.searchParams.set('select', 'id,comment_id,post_url,review_decision,reviewed_by,reviewed_at,source,platform');
  url.searchParams.set('id', `eq.${config.alertId}`);
  url.searchParams.set('platform', 'eq.youtube');
  url.searchParams.set('limit', '1');
  const rows = await readJson(await fetchImpl(url, { headers: supabaseHeaders(config) }), 'Supabase alert lookup');
  if (!rows.length) throw new Error('YouTube alert row not found');
  const alert = rows[0];
  if (String(alert.platform || '').toLowerCase() !== 'youtube'
    || !(alert.source == null || String(alert.source) === 'youtube_ads')) {
    throw new Error('YouTube owner audit accepts only owned organic or YouTube ad alerts');
  }
  if (!String(alert.comment_id || '').trim()) throw new Error('YouTube alert has no comment ID');
  const postKey = extractPostKey(alert.post_url);
  if (!postKey?.startsWith('yt:')) throw new Error('YouTube alert has no valid video URL');
  return { ...alert, videoId: postKey.slice(3) };
}

async function loadOwnerTokens(config, fetchImpl) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/meta_tokens`);
  url.searchParams.set('select', 'kind,token');
  url.searchParams.set('kind', `like.${OWNER_TOKEN_PREFIX}*`);
  url.searchParams.set('order', 'kind.asc');
  const rows = await readJson(await fetchImpl(url, { headers: supabaseHeaders(config) }), 'Supabase owner token lookup');
  return rows
    .filter((row) => String(row.kind || '').startsWith(OWNER_TOKEN_PREFIX) && row.token)
    .map((row) => ({ channelId: String(row.kind).slice(OWNER_TOKEN_PREFIX.length), refreshToken: String(row.token) }));
}

async function youtubeJson(config, pathname, params, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/${pathname}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  return readJson(await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } }), `YouTube ${pathname}`);
}

async function findOwner(config, videoId, owners, fetchImpl) {
  const failures = [];
  for (const owner of owners) {
    try {
      const accessToken = await refreshGoogleAccessToken(config, owner.refreshToken, fetchImpl);
      const channels = await youtubeJson(config, 'channels', { part: 'id', mine: 'true', maxResults: 50 }, accessToken, fetchImpl);
      const channelIds = new Set((channels.items || []).map((item) => String(item.id || '')));
      if (!channelIds.has(owner.channelId)) throw new Error('Stored owner token/channel mismatch');
      const videos = await youtubeJson(config, 'videos', { part: 'id,snippet', id: videoId }, accessToken, fetchImpl);
      const item = (videos.items || []).find((video) => String(video.id || '') === videoId);
      if (String(item?.snippet?.channelId || '') === owner.channelId) return { accessToken, channelId: owner.channelId, failures };
    } catch (error) {
      failures.push(String(error.message || 'owner lookup failed').slice(0, 160));
    }
  }
  return { accessToken: '', channelId: '', failures };
}

async function directCommentLookup(config, commentId, accessToken, fetchImpl) {
  try {
    const payload = await youtubeJson(config, 'comments', { part: 'id,snippet', id: commentId }, accessToken, fetchImpl);
    const item = (payload.items || []).find((comment) => String(comment.id || '') === commentId);
    return {
      found: Boolean(item),
      moderationStatus: String(item?.snippet?.moderationStatus || ''),
      parentId: String(item?.snippet?.parentId || ''),
      error: '',
    };
  } catch (error) {
    return { found: false, moderationStatus: '', parentId: '', error: String(error.message || '').slice(0, 160) };
  }
}

async function directThreadLookup(config, commentId, accessToken, fetchImpl) {
  try {
    const payload = await youtubeJson(config, 'commentThreads', {
      part: 'id,snippet,replies', id: commentId,
    }, accessToken, fetchImpl);
    const item = (payload.items || []).find((thread) => String(thread.id || '') === commentId);
    return {
      found: Boolean(item),
      isPublic: item ? Boolean(item.snippet?.isPublic) : false,
      topLevelMatches: String(item?.snippet?.topLevelComment?.id || '') === commentId,
      error: '',
    };
  } catch (error) {
    return { found: false, isPublic: false, topLevelMatches: false, error: String(error.message || '').slice(0, 160) };
  }
}

async function findReplyStatus(config, commentId, parentId, accessToken, fetchImpl) {
  let pageToken = '';
  for (let page = 0; page < config.maxPagesPerStatus; page += 1) {
    const payload = await youtubeJson(config, 'comments', {
      part: 'id,snippet', parentId, maxResults: 100, pageToken,
    }, accessToken, fetchImpl);
    const item = (payload.items || []).find((comment) => String(comment.id || '') === commentId);
    if (item) return { found: true, status: String(item.snippet?.moderationStatus || '') || 'discoverable_unknown', complete: true };
    pageToken = String(payload.nextPageToken || '');
    if (!pageToken) return { found: false, status: '', complete: true };
  }
  return { found: false, status: '', complete: false };
}

async function findTopLevelStatus(config, commentId, videoId, accessToken, fetchImpl) {
  try {
    const published = await fetchYouTubeVideoComments({
      ...config,
      youtubeAdsMaxThreadPages: config.maxPagesPerStatus,
      youtubeAdsMaxReplyPages: config.maxPagesPerStatus,
    }, videoId, accessToken, fetchImpl);
    if (published.some((comment) => String(comment.id || '') === commentId)) {
      return { found: true, status: 'published', complete: true };
    }
  } catch {
    return { found: false, status: '', complete: false };
  }
  let complete = true;
  for (const status of DISCOVERABLE_STATUSES.filter((status) => status !== 'published')) {
    let pageToken = '';
    for (let page = 0; page < config.maxPagesPerStatus; page += 1) {
      const payload = await youtubeJson(config, 'commentThreads', {
        part: 'id,snippet', videoId, moderationStatus: status, order: 'time', maxResults: 100, pageToken,
      }, accessToken, fetchImpl);
      const found = (payload.items || []).some((thread) => String(thread.snippet?.topLevelComment?.id || '') === commentId);
      if (found) return { found: true, status, complete: true };
      pageToken = String(payload.nextPageToken || '');
      if (!pageToken) break;
      if (page === config.maxPagesPerStatus - 1) complete = false;
    }
  }
  return { found: false, status: '', complete };
}

export function groundTruthVerdict({ direct, discoverable }) {
  if (discoverable.found) return discoverable.status;
  if (!discoverable.complete) return 'unknown_incomplete_scan';
  // YouTube는 rejected 댓글을 목록으로 발견하는 API를 제공하지 않는다. 발견 가능한
  // published/held/likelySpam 어디에도 없으면 rejected 또는 삭제된 상태로만 판정 가능하다.
  if (!direct.found) return 'rejected_or_deleted';
  return direct.moderationStatus || 'not_in_discoverable_statuses';
}

export async function auditYouTubeOwnerComment(config = loadGroundTruthConfig(), fetchImpl = fetch) {
  const alert = await loadAuditAlert(config, fetchImpl);
  const owners = await loadOwnerTokens(config, fetchImpl);
  if (!owners.length) throw new Error('No stored YouTube owner OAuth tokens');
  const owner = await findOwner(config, alert.videoId, owners, fetchImpl);
  if (!owner.accessToken) throw new Error(`No valid owner token matched the alert video (${owner.failures.length} owner checks failed)`);
  const direct = await directCommentLookup(config, alert.comment_id, owner.accessToken, fetchImpl);
  const thread = await directThreadLookup(config, alert.comment_id, owner.accessToken, fetchImpl);
  const discoverable = direct.parentId
    ? await findReplyStatus(config, alert.comment_id, direct.parentId, owner.accessToken, fetchImpl)
    : await findTopLevelStatus(config, alert.comment_id, alert.videoId, owner.accessToken, fetchImpl);
  return {
    alertFound: true,
    databaseDecision: String(alert.review_decision || 'unreviewed'),
    ownerMatched: true,
    ownerTokensChecked: owners.length,
    ownerLookupFound: direct.found,
    ownerModerationStatus: direct.moderationStatus || 'not_returned_for_id_filter',
    threadLookupFound: thread.found,
    threadIsPublic: thread.isPublic,
    threadTopLevelMatches: thread.topLevelMatches,
    discoverableFound: discoverable.found,
    discoverableStatus: discoverable.status || 'none',
    scanComplete: discoverable.complete,
    verdict: groundTruthVerdict({ direct, discoverable }),
  };
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## YouTube 소유 채널 댓글 지상진실 점검', '',
    `- DB 처리값: ${result.databaseDecision}`,
    `- 소유 채널 매칭: ${result.ownerMatched ? '예' : '아니오'}`,
    `- comments.list(id) 응답: ${result.ownerLookupFound ? '발견' : '미발견'}`,
    `- id 직접조회 moderationStatus: ${result.ownerModerationStatus}`,
    `- commentThreads.list(id) 응답: ${result.threadLookupFound ? '발견' : '미발견'}`,
    `- 스레드 공개 상태: ${result.threadLookupFound ? (result.threadIsPublic ? '공개' : '비공개') : '확인 불가'}`,
    `- 발견 가능한 상태 목록: ${result.discoverableStatus}`,
    `- 목록 전수조회 완료: ${result.scanComplete ? '예' : '아니오'}`,
    `- 최종 판정: **${result.verdict}**`, '',
    '> 댓글 ID·본문·작성자·영상 ID·OAuth 토큰은 로그와 요약에 기록하지 않습니다.', '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  auditYouTubeOwnerComment()
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await writeSummary(result);
    })
    .catch((error) => {
      console.error(String(error.message || error));
      process.exitCode = 1;
    });
}
