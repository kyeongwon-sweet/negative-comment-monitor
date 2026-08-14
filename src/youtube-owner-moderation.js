import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractPostKey } from './delta.js';
import { refreshGoogleAccessToken } from './youtube-ads.js';
import { syncHiddenYouTubeSlackCards } from './youtube-hidden-slack.js';

export const YOUTUBE_OWNER_HIDE_CONFIRMATION = 'HIDE_ALL_YOUTUBE_AD_ALERTS';
export const YOUTUBE_OWNER_SINGLE_HIDE_CONFIRMATION = 'HIDE_ONE_YOUTUBE_AD_ALERT';
const OWNER_TOKEN_PREFIX = 'youtube_owner:';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function loadYouTubeOwnerModerationConfig(env = process.env) {
  const dryRun = String(env.YOUTUBE_OWNER_BULK_HIDE_DRY_RUN || 'true').toLowerCase() !== 'false';
  const confirmation = String(env.YOUTUBE_OWNER_BULK_HIDE_CONFIRM || '').trim();
  const alertChannelId = String(env.YOUTUBE_OWNER_ALERT_SLACK_CHANNEL_ID || '').trim();
  const alertMessageTs = String(env.YOUTUBE_OWNER_ALERT_SLACK_TS || '').trim();
  if (Boolean(alertChannelId) !== Boolean(alertMessageTs)) {
    throw new Error('Single YouTube moderation requires both alert Slack channel and timestamp');
  }
  const singleAlert = Boolean(alertChannelId && alertMessageTs);
  const expectedConfirmation = singleAlert
    ? YOUTUBE_OWNER_SINGLE_HIDE_CONFIRMATION
    : YOUTUBE_OWNER_HIDE_CONFIRMATION;
  if (!dryRun && confirmation !== expectedConfirmation) {
    throw new Error(`Destructive YouTube moderation requires YOUTUBE_OWNER_BULK_HIDE_CONFIRM=${expectedConfirmation}`);
  }
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    dryRun,
    singleAlert,
    alertChannelId,
    alertMessageTs,
    batchSize: positiveInt(env.YOUTUBE_OWNER_BULK_HIDE_BATCH_SIZE, 50, 50),
    actor: String(env.YOUTUBE_OWNER_BULK_HIDE_ACTOR || 'codex-bulk-owner-oauth').trim(),
    slackBotToken: String(env.SLACK_BOT_TOKEN || '').trim(),
    slackUpdateDelayMs: positiveInt(env.YOUTUBE_HIDDEN_SLACK_DELAY_MS, singleAlert ? 1 : 1100, 10_000),
  };
}

function supabaseHeaders(config, extra = {}) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...extra,
  };
}

async function supabaseJson(config, pathname, fetchImpl) {
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/${pathname}`, {
    headers: supabaseHeaders(config),
  });
  if (!response.ok) throw new Error(`Supabase read failed (${response.status})`);
  return response.json();
}

export async function loadYouTubeOwnerTokens(config, fetchImpl = fetch) {
  const rows = await supabaseJson(config, 'meta_tokens?select=kind,token,expires_at&order=kind.asc', fetchImpl);
  return rows
    .filter((row) => String(row.kind || '').startsWith(OWNER_TOKEN_PREFIX) && row.token)
    .map((row) => ({
      channelId: String(row.kind).slice(OWNER_TOKEN_PREFIX.length),
      refreshToken: String(row.token),
      expiresAt: String(row.expires_at || ''),
    }))
    .filter((row) => row.channelId);
}

export async function loadYouTubeAdAlerts(config, fetchImpl = fetch) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    let pathname = 'negative_comment_alerts'
      + '?select=id,comment_id,comment_text,post_url,review_decision,reviewed_by,reviewed_at,slack_channel_id,slack_ts'
      + '&source=eq.youtube_ads&order=alerted_at.asc'
      + `&offset=${offset}&limit=1000`;
    if (config.alertChannelId && config.alertMessageTs) {
      pathname += `&slack_channel_id=eq.${encodeURIComponent(config.alertChannelId)}`
        + `&slack_ts=eq.${encodeURIComponent(config.alertMessageTs)}`;
    }
    const page = await supabaseJson(config, pathname, fetchImpl);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function videoIdFromAlert(alert) {
  const key = extractPostKey(alert.post_url);
  return key && key.startsWith('yt:') ? key.slice(3) : '';
}

async function googleJson(url, accessToken, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
    const resource = new URL(url).pathname.split('/').filter(Boolean).at(-1) || 'read';
    const error = new Error(`YouTube ${resource} failed (${response.status})${reasons.length ? `: ${reasons.join(',')}` : ''}`);
    error.status = response.status;
    error.reasons = reasons;
    throw error;
  }
  return payload;
}

async function refreshAndVerifyOwner(config, owner, fetchImpl) {
  const accessToken = await refreshGoogleAccessToken(config, owner.refreshToken, fetchImpl);
  const url = new URL(`${config.youtubeApiBase}/channels`);
  url.searchParams.set('part', 'id');
  url.searchParams.set('mine', 'true');
  url.searchParams.set('maxResults', '50');
  const payload = await googleJson(url, accessToken, fetchImpl);
  const ownedIds = (payload.items || []).map((item) => String(item.id || '')).filter(Boolean);
  if (!ownedIds.includes(owner.channelId)) {
    throw new Error(`Stored YouTube owner token no longer exposes expected channel ${owner.channelId}`);
  }
  return accessToken;
}

export async function mapVideosToOwners(config, alerts, owners, accessTokens, fetchImpl = fetch) {
  const videoIds = [...new Set(alerts.map(videoIdFromAlert).filter(Boolean))];
  const ownerByVideo = new Map();
  for (const owner of owners) {
    const accessToken = accessTokens.get(owner.channelId);
    for (const ids of chunk(videoIds, 50)) {
      const url = new URL(`${config.youtubeApiBase}/videos`);
      url.searchParams.set('part', 'id,snippet');
      url.searchParams.set('id', ids.join(','));
      url.searchParams.set('maxResults', '50');
      const payload = await googleJson(url, accessToken, fetchImpl);
      for (const item of payload.items || []) {
        if (String(item.snippet?.channelId || '') !== owner.channelId) continue;
        const existing = ownerByVideo.get(String(item.id));
        if (existing && existing !== owner.channelId) throw new Error(`Ambiguous YouTube video owner for ${item.id}`);
        ownerByVideo.set(String(item.id), owner.channelId);
      }
    }
  }
  return ownerByVideo;
}

export function groupAlertsByOwner(alerts, ownerByVideo) {
  const groups = new Map();
  let missingCommentId = 0;
  let unmatchedVideo = 0;
  let alreadyMarkedHidden = 0;
  for (const alert of alerts) {
    if (alert.review_decision === 'hidden') {
      alreadyMarkedHidden += 1;
      continue;
    }
    if (!String(alert.comment_id || '').trim()) {
      missingCommentId += 1;
      continue;
    }
    const owner = ownerByVideo.get(videoIdFromAlert(alert));
    if (!owner) {
      unmatchedVideo += 1;
      continue;
    }
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(alert);
  }
  return { groups, missingCommentId, unmatchedVideo, alreadyMarkedHidden };
}

async function listVisibleCommentIds(config, ids, accessToken, fetchImpl) {
  const visible = new Set();
  for (const batch of chunk(ids, 50)) {
    const url = new URL(`${config.youtubeApiBase}/comments`);
    url.searchParams.set('part', 'id');
    url.searchParams.set('id', batch.join(','));
    const payload = await googleJson(url, accessToken, fetchImpl);
    for (const item of payload.items || []) if (item.id) visible.add(String(item.id));
  }
  return visible;
}

async function rejectComments(config, ids, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/comments/setModerationStatus`);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('moderationStatus', 'rejected');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.ok) return;
  const payload = await response.json().catch(() => ({}));
  const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
  const error = new Error(`YouTube moderation failed (${response.status})${reasons.length ? `: ${reasons.join(',')}` : ''}`);
  error.status = response.status;
  error.reasons = reasons;
  throw error;
}

function encodedList(values) {
  return values.map((value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
}

async function patchRows(config, ids, body, fetchImpl) {
  if (!ids.length) return 0;
  let updated = 0;
  for (const batch of chunk(ids, 100)) {
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${encodeURIComponent(encodedList(batch))})&source=eq.youtube_ads`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(config, {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error(`Supabase moderation audit update failed (${response.status})`);
    const rows = await response.json().catch(() => []);
    updated += Array.isArray(rows) ? rows.length : 0;
  }
  return updated;
}

export async function persistHiddenRows(config, alerts, fetchImpl = fetch, now = Date.now()) {
  const reviewed = alerts.filter((alert) => alert.reviewed_by || alert.reviewed_at).map((alert) => alert.id);
  const unreviewed = alerts.filter((alert) => !alert.reviewed_by && !alert.reviewed_at).map((alert) => alert.id);
  let updated = 0;
  // 사람이 먼저 [무시]/[완료]를 누른 행의 행위자·시각은 감사 이력으로 보존한다.
  updated += await patchRows(config, reviewed, { review_decision: 'hidden' }, fetchImpl);
  updated += await patchRows(config, unreviewed, {
    review_decision: 'hidden',
    reviewed_by: config.actor,
    reviewed_at: new Date(now).toISOString(),
  }, fetchImpl);
  return updated;
}

export async function moderateYouTubeOwnerAlerts(config = loadYouTubeOwnerModerationConfig(), fetchImpl = fetch, now = Date.now()) {
  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  if (!owners.length) throw new Error('No stored YouTube owner OAuth tokens');
  const alerts = await loadYouTubeAdAlerts(config, fetchImpl);
  const accessTokens = new Map();
  for (const owner of owners) accessTokens.set(owner.channelId, await refreshAndVerifyOwner(config, owner, fetchImpl));
  const ownerByVideo = await mapVideosToOwners(config, alerts, owners, accessTokens, fetchImpl);
  const grouped = groupAlertsByOwner(alerts, ownerByVideo);
  const result = {
    dryRun: config.dryRun,
    totalAlerts: alerts.length,
    ownerTokens: owners.length,
    matchedVideos: ownerByVideo.size,
    missingCommentId: grouped.missingCommentId,
    unmatchedVideo: grouped.unmatchedVideo,
    alreadyMarkedHidden: grouped.alreadyMarkedHidden,
    attempted: 0,
    hidden: 0,
    unavailableOrAlreadyHidden: 0,
    dbUpdated: 0,
    slackUpdated: 0,
    slackUpdateFailed: 0,
    owners: [],
  };

  for (const owner of owners) {
    const ownerAlerts = grouped.groups.get(owner.channelId) || [];
    const rowsByComment = new Map();
    for (const alert of ownerAlerts) {
      const id = String(alert.comment_id);
      if (!rowsByComment.has(id)) rowsByComment.set(id, []);
      rowsByComment.get(id).push(alert);
    }
    const commentIds = [...rowsByComment.keys()];
    const visible = await listVisibleCommentIds(config, commentIds, accessTokens.get(owner.channelId), fetchImpl);
    const visibleIds = commentIds.filter((id) => visible.has(id));
    const unavailable = commentIds.length - visibleIds.length;
    const hiddenRows = [];
    if (!config.dryRun) {
      for (const ids of chunk(visibleIds, config.batchSize)) {
        await rejectComments(config, ids, accessTokens.get(owner.channelId), fetchImpl);
        for (const id of ids) hiddenRows.push(...(rowsByComment.get(id) || []));
      }
      result.dbUpdated += await persistHiddenRows(config, hiddenRows, fetchImpl, now);
      if (hiddenRows.length && config.slackBotToken) {
        const slack = await syncHiddenYouTubeSlackCards(config, hiddenRows, fetchImpl);
        result.slackUpdated += slack.updated;
        result.slackUpdateFailed += slack.failed;
      }
    }
    result.attempted += visibleIds.length;
    result.hidden += config.dryRun ? 0 : visibleIds.length;
    result.unavailableOrAlreadyHidden += unavailable;
    result.owners.push({
      channelId: owner.channelId,
      alertRows: ownerAlerts.length,
      uniqueComments: commentIds.length,
      visible: visibleIds.length,
      hidden: config.dryRun ? 0 : visibleIds.length,
      unavailableOrAlreadyHidden: unavailable,
    });
  }
  return result;
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## YouTube 소유 채널 댓글 일괄 숨김',
    '',
    `- 모드: ${result.dryRun ? 'DRY RUN' : '실제 숨김'}`,
    `- 전체 YouTube 광고 알림: ${result.totalAlerts}`,
    `- 실제 숨김: ${result.hidden}`,
    `- 이미 숨김/삭제되어 조회 불가: ${result.unavailableOrAlreadyHidden}`,
    `- 소유 채널 미매칭: ${result.unmatchedVideo}`,
    `- DB 갱신: ${result.dbUpdated}`,
    `- Slack 카드 갱신: ${result.slackUpdated} (실패 ${result.slackUpdateFailed})`,
    '',
    '| 소유 채널 ID | 알림 행 | 고유 댓글 | 현재 노출 | 숨김 | 조회 불가 |',
    '|---|---:|---:|---:|---:|---:|',
    ...result.owners.map((owner) => `| ${owner.channelId} | ${owner.alertRows} | ${owner.uniqueComments} | ${owner.visible} | ${owner.hidden} | ${owner.unavailableOrAlreadyHidden} |`),
    '',
    '> 댓글 본문·작성자·댓글 ID·OAuth 토큰은 로그에 기록하지 않습니다.',
    '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  moderateYouTubeOwnerAlerts()
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await writeSummary(result);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
