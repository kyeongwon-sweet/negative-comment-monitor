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
  const unresolved = new Set(alerts.map(videoIdFromAlert).filter(Boolean));
  const ownerByVideo = new Map();
  const ownerErrors = [];
  const ownedChannelIds = new Set(owners.map((owner) => owner.channelId));
  for (const owner of owners) {
    if (!unresolved.size) break;
    const accessToken = accessTokens.get(owner.channelId);
    if (!accessToken) continue;
    for (const ids of chunk([...unresolved], 50)) {
      const url = new URL(`${config.youtubeApiBase}/videos`);
      url.searchParams.set('part', 'id,snippet');
      url.searchParams.set('id', ids.join(','));
      url.searchParams.set('maxResults', '50');
      let payload;
      try {
        payload = await googleJson(url, accessToken, fetchImpl);
      } catch (error) {
        ownerErrors.push({ channelId: owner.channelId, stage: 'videos', error: error.message });
        break;
      }
      for (const item of payload.items || []) {
        const videoId = String(item.id || '');
        const channelId = String(item.snippet?.channelId || '');
        if (!videoId) continue;
        // 공개/일부공개 영상은 첫 번째 유효 토큰의 videos.list 한 번으로도 실제
        // channelId를 알 수 있다. 비공개라 응답에서 빠진 ID만 다음 소유자 토큰으로 재조회한다.
        unresolved.delete(videoId);
        if (!ownedChannelIds.has(channelId)) continue;
        const existing = ownerByVideo.get(videoId);
        if (existing && existing !== channelId) throw new Error(`Ambiguous YouTube video owner for ${videoId}`);
        ownerByVideo.set(videoId, channelId);
      }
    }
  }
  return { ownerByVideo, ownerErrors };
}

const KEEP_REVIEW_DECISIONS = new Set([
  'false_positive', 'ignore', 'complete', 'approve', 'hold', 'unhide',
]);

function alertDisposition(alert, { singleAlert = false } = {}) {
  const decision = String(alert.review_decision || '').trim().toLowerCase();
  if (decision === 'hidden') return 'hidden';
  if (KEEP_REVIEW_DECISIONS.has(decision)) return 'human_keep';
  // [숨김] 클릭은 라우트가 먼저 decision=hide와 실제 Slack 행위자를 기록한 뒤
  // 단일 워크플로를 호출한다. 이 경우만 숨김 실행 대상으로 남긴다.
  if (decision === 'hide') return singleAlert ? 'eligible' : 'human_keep';
  // 알 수 없는 사람 결정이나 결정값 없이 행위자/시각만 있는 행도 fail-closed.
  if (decision || alert.reviewed_by || alert.reviewed_at) return 'human_keep';
  return 'eligible';
}

export function groupAlertsByOwner(alerts, ownerByVideo, options = {}) {
  const groups = new Map();
  let missingCommentId = 0;
  let unmatchedVideo = 0;
  let alreadyMarkedHidden = 0;
  let skippedHumanDecision = 0;
  for (const alert of alerts) {
    const disposition = alertDisposition(alert, options);
    if (disposition === 'hidden') {
      alreadyMarkedHidden += 1;
      continue;
    }
    if (disposition === 'human_keep') {
      skippedHumanDecision += 1;
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
  return { groups, missingCommentId, unmatchedVideo, alreadyMarkedHidden, skippedHumanDecision };
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

function errorInfo(error) {
  return {
    status: Number(error?.status) || 0,
    reasons: Array.isArray(error?.reasons) ? error.reasons : [],
    message: String(error?.message || 'unknown error').slice(0, 240),
  };
}

function isUnavailableError(error) {
  const info = errorInfo(error);
  return info.status === 404 || info.reasons.includes('commentNotFound');
}

async function listVisibleCommentIdsIsolated(config, ids, accessToken, fetchImpl) {
  const result = { visible: new Set(), unavailable: new Set(), failed: [], channelError: null };
  async function visit(batch) {
    if (!batch.length || result.channelError) return;
    try {
      const visible = await listVisibleCommentIds(config, batch, accessToken, fetchImpl);
      for (const id of visible) result.visible.add(id);
      for (const id of batch) if (!visible.has(id)) result.unavailable.add(id);
    } catch (error) {
      if (Number(error?.status) === 403) {
        result.channelError = errorInfo(error);
        return;
      }
      if (batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2);
        await visit(batch.slice(0, midpoint));
        await visit(batch.slice(midpoint));
        return;
      }
      if (isUnavailableError(error)) result.unavailable.add(batch[0]);
      else result.failed.push({ id: batch[0], error: errorInfo(error) });
    }
  }
  for (const batch of chunk(ids, 50)) await visit(batch);
  return result;
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

async function rejectCommentsIsolated(config, ids, accessToken, fetchImpl, onConfirmed) {
  const result = {
    confirmed: [],
    unavailable: [],
    failed: [],
    acceptedUnverified: [],
    channelError: null,
  };
  async function visit(batch) {
    if (!batch.length || result.channelError) return;
    try {
      await rejectComments(config, batch, accessToken, fetchImpl);
    } catch (error) {
      if (Number(error?.status) === 403) {
        result.channelError = errorInfo(error);
        return;
      }
      if (batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2);
        await visit(batch.slice(0, midpoint));
        await visit(batch.slice(midpoint));
        return;
      }
      if (isUnavailableError(error)) result.unavailable.push(batch[0]);
      else result.failed.push({ id: batch[0], error: errorInfo(error) });
      return;
    }

    // setModerationStatus는 성공 시 본문 없이 204만 반환한다. 공식 API는 rejected
    // 댓글을 다시 나열하지 않으므로, owner 토큰으로 즉시 재조회해 사라진 ID만 확정한다.
    // 확인 조회 자체가 실패하면 DB/Slack을 성공으로 바꾸지 않고 다음 실행의 재시도 여지를 남긴다.
    const verification = await listVisibleCommentIdsIsolated(config, batch, accessToken, fetchImpl);
    if (verification.channelError) {
      result.acceptedUnverified.push(...batch);
      result.channelError = verification.channelError;
      return;
    }
    const unverified = new Set(verification.failed.map((item) => item.id));
    const confirmed = batch.filter((id) => verification.unavailable.has(id));
    result.acceptedUnverified.push(...batch.filter((id) => unverified.has(id)));
    if (confirmed.length) {
      result.confirmed.push(...confirmed);
      await onConfirmed(confirmed);
    }

    // 204 뒤에도 조회되는 댓글은 성공으로 기록하지 않는다. 전파 지연일 수도 있으므로
    // 즉석 재숨김/이진분할로 쿼터를 태우지 않고 미확인 상태로 남겨 다음 실행이 재검사한다.
    const stillVisible = batch.filter((id) => verification.visible.has(id));
    result.acceptedUnverified.push(...stillVisible);
  }
  for (const batch of chunk(ids, config.batchSize)) await visit(batch);
  return result;
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
  // 사람의 결정·행위자는 감사 원본이다. [숨김] 클릭 행도 decision=hide와 실제
  // Slack user를 그대로 두고, 카드의 '숨김 처리 완료' 상태로 플랫폼 결과를 표현한다.
  // 자동 일괄 숨김으로 아직 사람이 검토하지 않은 행만 서비스 계정 결정으로 기록한다.
  const unreviewed = alerts
    .filter((alert) => !alert.review_decision && !alert.reviewed_by && !alert.reviewed_at)
    .map((alert) => alert.id);
  return patchRows(config, unreviewed, {
    review_decision: 'hidden',
    reviewed_by: config.actor,
    reviewed_at: new Date(now).toISOString(),
  }, fetchImpl);
}

export async function moderateYouTubeOwnerAlerts(config = loadYouTubeOwnerModerationConfig(), fetchImpl = fetch, now = Date.now()) {
  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  if (!owners.length) throw new Error('No stored YouTube owner OAuth tokens');
  const alerts = await loadYouTubeAdAlerts(config, fetchImpl);
  const accessTokens = new Map();
  const validOwners = [];
  const ownerTokenFailures = [];
  for (const owner of owners) {
    try {
      accessTokens.set(owner.channelId, await refreshAndVerifyOwner(config, owner, fetchImpl));
      validOwners.push(owner);
    } catch (error) {
      ownerTokenFailures.push({ channelId: owner.channelId, stage: 'token', error: errorInfo(error) });
    }
  }
  if (!validOwners.length) {
    throw new Error(`All stored YouTube owner OAuth tokens failed (${ownerTokenFailures.length}/${owners.length})`);
  }

  const candidateAlerts = alerts.filter((alert) => alertDisposition(alert, { singleAlert: config.singleAlert }) === 'eligible');
  const mapped = await mapVideosToOwners(config, candidateAlerts, validOwners, accessTokens, fetchImpl);
  const grouped = groupAlertsByOwner(alerts, mapped.ownerByVideo, { singleAlert: config.singleAlert });
  const result = {
    dryRun: config.dryRun,
    totalAlerts: alerts.length,
    ownerTokens: owners.length,
    validOwnerTokens: validOwners.length,
    ownerTokenFailures,
    ownerMappingFailures: mapped.ownerErrors,
    matchedVideos: mapped.ownerByVideo.size,
    missingCommentId: grouped.missingCommentId,
    unmatchedVideo: grouped.unmatchedVideo,
    alreadyMarkedHidden: grouped.alreadyMarkedHidden,
    skippedHumanDecision: grouped.skippedHumanDecision,
    attempted: 0,
    hidden: 0,
    unavailableOrAlreadyHidden: 0,
    moderationUnavailable: 0,
    moderationFailed: 0,
    acceptedUnverified: 0,
    channelFailures: 0,
    persistenceFailed: 0,
    dbUpdated: 0,
    slackUpdated: 0,
    slackUpdateFailed: 0,
    owners: [],
  };

  for (const owner of validOwners) {
    const ownerAlerts = grouped.groups.get(owner.channelId) || [];
    const rowsByComment = new Map();
    for (const alert of ownerAlerts) {
      const id = String(alert.comment_id);
      if (!rowsByComment.has(id)) rowsByComment.set(id, []);
      rowsByComment.get(id).push(alert);
    }
    const commentIds = [...rowsByComment.keys()];
    const ownerResult = {
      channelId: owner.channelId,
      alertRows: ownerAlerts.length,
      uniqueComments: commentIds.length,
      visible: 0,
      hidden: 0,
      unavailableOrAlreadyHidden: 0,
      moderationUnavailable: 0,
      moderationFailed: 0,
      acceptedUnverified: 0,
      error: null,
    };
    if (!commentIds.length) {
      result.owners.push(ownerResult);
      continue;
    }

    const visibility = await listVisibleCommentIdsIsolated(
      config,
      commentIds,
      accessTokens.get(owner.channelId),
      fetchImpl,
    );
    if (visibility.channelError) {
      ownerResult.error = { stage: 'list', ...visibility.channelError };
      result.channelFailures += 1;
      result.owners.push(ownerResult);
      continue;
    }
    const visibilityFailed = new Set(visibility.failed.map((item) => item.id));
    const visibleIds = commentIds.filter((id) => visibility.visible.has(id));
    const unavailable = commentIds.filter((id) => visibility.unavailable.has(id)).length;
    ownerResult.visible = visibleIds.length;
    ownerResult.unavailableOrAlreadyHidden = unavailable;
    ownerResult.moderationFailed += visibilityFailed.size;
    result.attempted += visibleIds.length;
    result.unavailableOrAlreadyHidden += unavailable;
    result.moderationFailed += visibilityFailed.size;

    if (!config.dryRun && visibleIds.length) {
      const onConfirmed = async (confirmedIds) => {
        const hiddenRows = confirmedIds.flatMap((id) => rowsByComment.get(id) || []);
        try {
          result.dbUpdated += await persistHiddenRows(config, hiddenRows, fetchImpl, now);
        } catch (error) {
          result.persistenceFailed += hiddenRows.length;
          ownerResult.error ||= { stage: 'database', ...errorInfo(error) };
        }
        if (hiddenRows.length && config.slackBotToken) {
          try {
            const slack = await syncHiddenYouTubeSlackCards(config, hiddenRows, fetchImpl);
            result.slackUpdated += slack.updated;
            result.slackUpdateFailed += slack.failed;
          } catch (error) {
            result.slackUpdateFailed += hiddenRows.length;
            ownerResult.error ||= { stage: 'slack', ...errorInfo(error) };
          }
        }
      };
      const moderation = await rejectCommentsIsolated(
        config,
        visibleIds,
        accessTokens.get(owner.channelId),
        fetchImpl,
        onConfirmed,
      );
      ownerResult.hidden = moderation.confirmed.length;
      ownerResult.moderationUnavailable = moderation.unavailable.length;
      ownerResult.moderationFailed += moderation.failed.length;
      ownerResult.acceptedUnverified = moderation.acceptedUnverified.length;
      result.hidden += moderation.confirmed.length;
      result.moderationUnavailable += moderation.unavailable.length;
      result.moderationFailed += moderation.failed.length;
      result.acceptedUnverified += moderation.acceptedUnverified.length;
      if (moderation.channelError) {
        ownerResult.error = { stage: 'moderation', ...moderation.channelError };
        result.channelFailures += 1;
      }
    }
    result.owners.push(ownerResult);
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
    `- 사람 결정으로 제외(무시·완료 등): ${result.skippedHumanDecision}`,
    `- 실제 숨김: ${result.hidden}`,
    `- 이미 숨김/삭제되어 조회 불가: ${result.unavailableOrAlreadyHidden}`,
    `- 숨김 중 삭제·미존재: ${result.moderationUnavailable}`,
    `- 숨김 실패: ${result.moderationFailed}`,
    `- API 접수 후 확인 불가: ${result.acceptedUnverified}`,
    `- 채널 단위 실패: ${result.channelFailures} (토큰 실패 ${result.ownerTokenFailures.length})`,
    `- 소유 채널 미매칭: ${result.unmatchedVideo}`,
    `- DB 갱신: ${result.dbUpdated}`,
    `- Slack 카드 갱신: ${result.slackUpdated} (실패 ${result.slackUpdateFailed})`,
    '',
    '| 소유 채널 ID | 알림 행 | 고유 댓글 | 현재 노출 | 숨김 | 조회 불가 | 실패 |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...result.owners.map((owner) => `| ${owner.channelId} | ${owner.alertRows} | ${owner.uniqueComments} | ${owner.visible} | ${owner.hidden} | ${owner.unavailableOrAlreadyHidden + owner.moderationUnavailable} | ${owner.moderationFailed + (owner.error ? 1 : 0)} |`),
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
