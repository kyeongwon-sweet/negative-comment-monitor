import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchYouTubeVideoComments } from './youtube-ads.js';
import {
  listYouTubeCommentStatesIsolated,
  loadYouTubeOwnerTokens,
  mapVideosToOwners,
  refreshAndVerifyOwner,
  videoIdFromAlert,
} from './youtube-owner-moderation.js';

export const YOUTUBE_RESTORE_CONFIRMATION = 'RESTORE_YOUTUBE_COMMENTS';
export const YOUTUBE_AUTO_RESTORE_CONFIRMATION = 'AUTO_RESTORE_YOUTUBE_FALSE_POSITIVES';
export const YOUTUBE_RESTORE_UNVERIFIED_MARKER = 'youtube_restore_unverified';
const KEEP_DECISIONS = new Set(['false_positive', 'ignore', 'unhide']);

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSlackTimestamps(value) {
  const result = [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
  if (!result.length) throw new Error('At least one Slack timestamp is required');
  if (result.length > 50) throw new Error('At most 50 Slack timestamps can be restored at once');
  if (result.some((item) => !/^\d+\.\d+$/.test(item))) throw new Error('Invalid Slack timestamp');
  return result;
}

export function loadYouTubeRestoreConfig(env = process.env) {
  if (String(env.YOUTUBE_RESTORE_CONFIRM || '').trim() !== YOUTUBE_RESTORE_CONFIRMATION) {
    throw new Error(`YouTube public restore requires YOUTUBE_RESTORE_CONFIRM=${YOUTUBE_RESTORE_CONFIRMATION}`);
  }
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackBotToken: String(env.SLACK_BOT_TOKEN || '').trim(),
    slackChannelId: required(env, 'YOUTUBE_RESTORE_SLACK_CHANNEL_ID'),
    slackTimestamps: parseSlackTimestamps(required(env, 'YOUTUBE_RESTORE_SLACK_TS_CSV')),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    actor: String(env.YOUTUBE_RESTORE_ACTOR || 'U0B2Y0ZC8QZ').trim(),
    falsePositiveReason: String(env.YOUTUBE_RESTORE_FP_REASON || 'positive_neutral').trim(),
    verificationAttempts: positiveInt(env.YOUTUBE_RESTORE_VERIFY_ATTEMPTS, 30, 60),
    verificationDelayMs: positiveInt(env.YOUTUBE_RESTORE_VERIFY_DELAY_MS, 10_000, 30_000),
    verificationMaxThreadPages: positiveInt(env.YOUTUBE_RESTORE_VERIFY_MAX_THREAD_PAGES, 100, 200),
    verificationMaxReplyPages: positiveInt(env.YOUTUBE_RESTORE_VERIFY_MAX_REPLY_PAGES, 100, 200),
  };
}

export function loadYouTubeAutoRestoreConfig(env = process.env) {
  if (String(env.YOUTUBE_FP_AUTO_RESTORE || '').trim() !== YOUTUBE_AUTO_RESTORE_CONFIRMATION) {
    throw new Error(`YouTube false-positive auto restore requires YOUTUBE_FP_AUTO_RESTORE=${YOUTUBE_AUTO_RESTORE_CONFIRMATION}`);
  }
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackBotToken: String(env.SLACK_BOT_TOKEN || '').trim(),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    lookbackHours: positiveInt(env.YOUTUBE_FP_AUTO_RESTORE_LOOKBACK_HOURS, 48, 168),
    maxRows: positiveInt(env.YOUTUBE_FP_AUTO_RESTORE_MAX_ROWS, 100, 500),
    verificationAttempts: positiveInt(env.YOUTUBE_RESTORE_VERIFY_ATTEMPTS, 5, 20),
    verificationDelayMs: positiveInt(env.YOUTUBE_RESTORE_VERIFY_DELAY_MS, 3_000, 30_000),
    verificationMaxThreadPages: positiveInt(env.YOUTUBE_RESTORE_VERIFY_MAX_THREAD_PAGES, 100, 200),
    verificationMaxReplyPages: positiveInt(env.YOUTUBE_RESTORE_VERIFY_MAX_REPLY_PAGES, 100, 200),
  };
}

function supabaseHeaders(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export async function loadYouTubeRestoreAlerts(config, fetchImpl = fetch) {
  const rows = [];
  for (const slackTs of config.slackTimestamps) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
    url.searchParams.set('select', 'id,source,platform,comment_id,comment_text,post_url,review_decision,reviewed_by,reviewed_at,slack_channel_id,slack_ts,fingerprint');
    url.searchParams.set('slack_channel_id', `eq.${config.slackChannelId}`);
    url.searchParams.set('slack_ts', `eq.${slackTs}`);
    url.searchParams.set('limit', '2');
    const response = await fetchImpl(url, { headers: supabaseHeaders(config) });
    if (!response.ok) throw new Error(`YouTube restore alert lookup failed (${response.status})`);
    const found = await response.json();
    if (!Array.isArray(found) || found.length !== 1) throw new Error('Each Slack timestamp must resolve to exactly one alert');
    rows.push(found[0]);
  }
  for (const row of rows) {
    if (String(row.platform || '').toLowerCase() !== 'youtube' || !['youtube_ads', null].includes(row.source)) {
      throw new Error('YouTube restore only accepts YouTube alert rows');
    }
    if (!row.comment_id || !videoIdFromAlert(row)) throw new Error('YouTube restore alert is missing a comment or video ID');
    if (!KEEP_DECISIONS.has(String(row.review_decision || '').trim().toLowerCase())) {
      throw new Error('YouTube restore requires an explicit human keep decision');
    }
  }
  return rows;
}

async function ensureFalsePositive(config, rows, fetchImpl, now) {
  let updated = 0;
  for (const row of rows) {
    const body = {
      review_decision: 'false_positive',
      false_positive_reason: config.falsePositiveReason,
    };
    if (!row.reviewed_by) body.reviewed_by = config.actor;
    if (!row.reviewed_at) body.reviewed_at = new Date(now).toISOString();
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: supabaseHeaders(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`False-positive persistence failed (${response.status})`);
    const changed = await response.json().catch(() => []);
    updated += Array.isArray(changed) ? changed.length : 0;
  }
  return updated;
}

export async function setPublished(config, ids, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/comments/setModerationStatus`);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('moderationStatus', 'published');
  const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.ok) return;
  const payload = await response.json().catch(() => ({}));
  const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
  const error = new Error(`YouTube public restore failed (${response.status})${reasons.length ? `: ${reasons.join(',')}` : ''}`);
  error.status = response.status;
  error.reasons = reasons;
  throw error;
}

function escaped(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function syncRestoredCards(config, rows, fetchImpl, now) {
  if (!config.slackBotToken) return { updated: 0, failed: rows.length };
  let updated = 0;
  let failed = 0;
  const when = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  for (const row of rows) {
    const post = escaped(row.post_url);
    const comment = escaped(String(row.comment_text || '').slice(0, 700));
    const response = await fetchImpl('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: row.slack_channel_id,
        ts: row.slack_ts,
        text: 'YouTube 댓글 공개 복원 완료 · 오탐 학습 반영',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `👁️ *YouTube 댓글 공개 복원 완료*${post ? `\n<${post}|게시물 열기>` : ''}${comment ? `\n\n*댓글*\n${comment}` : ''}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `*오탐(사람 판정) · 공개 복원됨* · ${when} KST` }] },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.ok) updated += 1;
    else failed += 1;
  }
  return { updated, failed };
}

export async function loadRecentYouTubeFalsePositiveAlerts(config, fetchImpl = fetch, now = Date.now()) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
  url.searchParams.set('select', 'id,source,platform,comment_id,comment_text,post_url,review_decision,reviewed_by,reviewed_at,false_positive_reason,slack_channel_id,slack_ts,fingerprint');
  url.searchParams.set('platform', 'eq.youtube');
  url.searchParams.set('review_decision', 'eq.false_positive');
  url.searchParams.set('reviewed_at', `gte.${new Date(now - config.lookbackHours * 3600_000).toISOString()}`);
  url.searchParams.set('comment_id', 'not.is.null');
  url.searchParams.set('order', 'reviewed_at.asc');
  url.searchParams.set('limit', String(config.maxRows));
  const response = await fetchImpl(url, { headers: supabaseHeaders(config) });
  if (!response.ok) throw new Error(`YouTube false-positive lookup failed (${response.status})`);
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    String(row.platform || '').toLowerCase() === 'youtube'
    && (row.source == null || String(row.source) === 'youtube_ads')
    && row.comment_id
    && videoIdFromAlert(row)
    && !String(row.false_positive_reason || '').startsWith(YOUTUBE_RESTORE_UNVERIFIED_MARKER)
  ));
}

async function markUnverifiedRestoreRows(config, rows, fetchImpl) {
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const original = String(row.false_positive_reason || '').trim();
    const marker = original && !original.startsWith(YOUTUBE_RESTORE_UNVERIFIED_MARKER)
      ? `${YOUTUBE_RESTORE_UNVERIFIED_MARKER}:${original}`
      : YOUTUBE_RESTORE_UNVERIFIED_MARKER;
    try {
      const response = await fetchImpl(
        `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=eq.${encodeURIComponent(row.id)}`,
        {
          method: 'PATCH',
          headers: supabaseHeaders(config, {
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          }),
          body: JSON.stringify({ false_positive_reason: marker }),
        },
      );
      if (!response.ok) {
        failed += 1;
        continue;
      }
      const changed = await response.json().catch(() => []);
      if (Array.isArray(changed) && changed.length) updated += changed.length;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { updated, failed };
}

function unavailableRestoreError(error) {
  return Number(error?.status) === 404
    || (Array.isArray(error?.reasons) && error.reasons.includes('commentNotFound'));
}

async function listPublishedIdsForRows(config, rows, accessToken, fetchImpl) {
  const published = new Set();
  const failedVideos = new Set();
  const videoIds = [...new Set(rows.map(videoIdFromAlert).filter(Boolean))];
  const scanConfig = {
    ...config,
    youtubeAdsMaxThreadPages: config.verificationMaxThreadPages || 100,
    youtubeAdsMaxReplyPages: config.verificationMaxReplyPages || 100,
  };
  for (const videoId of videoIds) {
    try {
      const comments = await fetchYouTubeVideoComments(scanConfig, videoId, accessToken, fetchImpl);
      for (const comment of comments) if (comment.id) published.add(String(comment.id));
    } catch {
      failedVideos.add(videoId);
    }
  }
  return { published, failedVideos };
}

async function verifyPublishedRows(config, rows, accessToken, fetchImpl) {
  let latest = { published: new Set(), failedVideos: new Set() };
  for (let attempt = 1; attempt <= (config.verificationAttempts || 1); attempt += 1) {
    latest = await listPublishedIdsForRows(config, rows, accessToken, fetchImpl);
    const allVisible = rows.every((row) => latest.published.has(String(row.comment_id)));
    if (!latest.failedVideos.size && allVisible) break;
    if (attempt < (config.verificationAttempts || 1)) {
      await (config.sleep || wait)(config.verificationDelayMs || 1);
    }
  }
  return latest;
}

export async function autoRestoreYouTubeFalsePositives(
  config = loadYouTubeAutoRestoreConfig(), fetchImpl = fetch, now = Date.now(),
) {
  const rows = await loadRecentYouTubeFalsePositiveAlerts(config, fetchImpl, now);
  const result = {
    candidates: rows.length,
    ownerTokens: 0,
    validOwnerTokens: 0,
    tokenFailures: 0,
    unowned: 0,
    alreadyVisible: 0,
    restoreAttempted: 0,
    restored: 0,
    unavailable: 0,
    unverified: 0,
    manualRequired: 0,
    manualMarked: 0,
    manualMarkFailed: 0,
    failed: 0,
    slackUpdated: 0,
    slackFailed: 0,
  };
  if (!rows.length) return result;

  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  result.ownerTokens = owners.length;
  const accessTokens = new Map();
  const validOwners = [];
  for (const owner of owners) {
    try {
      accessTokens.set(owner.channelId, await refreshAndVerifyOwner(config, owner, fetchImpl));
      validOwners.push(owner);
    } catch {
      result.tokenFailures += 1;
    }
  }
  result.validOwnerTokens = validOwners.length;
  if (!validOwners.length) {
    result.failed = rows.length;
    return result;
  }

  const mapped = await mapVideosToOwners(config, rows, validOwners, accessTokens, fetchImpl);
  const rowsByOwner = new Map();
  for (const row of rows) {
    const ownerId = mapped.ownerByVideo.get(videoIdFromAlert(row));
    if (!ownerId) {
      result.unowned += 1;
      continue;
    }
    if (!rowsByOwner.has(ownerId)) rowsByOwner.set(ownerId, []);
    rowsByOwner.get(ownerId).push(row);
  }

  const restoredRows = [];
  const unverifiedRows = [];
  for (const [ownerId, ownerRows] of rowsByOwner) {
    const token = accessTokens.get(ownerId);
    const rowsByComment = new Map();
    for (const row of ownerRows) {
      const id = String(row.comment_id);
      if (!rowsByComment.has(id)) rowsByComment.set(id, []);
      rowsByComment.get(id).push(row);
    }
    const ids = [...rowsByComment.keys()];
    const before = await listYouTubeCommentStatesIsolated(config, ids, token, fetchImpl);
    if (before.channelError) {
      result.failed += ids.length;
      continue;
    }
    const publishedBefore = await listPublishedIdsForRows(config, ownerRows, token, fetchImpl);
    const visibleBefore = new Set([...before.visible, ...publishedBefore.published]);
    result.failed += before.failed.length;
    result.alreadyVisible += ids.filter((id) => visibleBefore.has(id)).length;
    const candidates = ids.filter((id) => !visibleBefore.has(id) && (
      before.rejected.has(id)
      || before.heldForReview.has(id)
      || before.likelySpam.has(id)
      || before.missing.has(id)
    ));
    const acceptedRows = [];
    for (const id of candidates) {
      result.restoreAttempted += 1;
      try {
        await setPublished(config, [id], token, fetchImpl);
      } catch (error) {
        if (unavailableRestoreError(error)) result.unavailable += 1;
        else result.failed += 1;
        continue;
      }
      acceptedRows.push(...(rowsByComment.get(id) || []));
    }
    if (acceptedRows.length) {
      const verified = await verifyPublishedRows(config, acceptedRows, token, fetchImpl);
      for (const row of acceptedRows) {
        const id = String(row.comment_id);
        if (verified.published.has(id)) {
          if (!(restoredRows.some((restored) => restored.id === row.id))) restoredRows.push(row);
        }
      }
      const restoredIds = new Set(restoredRows.filter((row) => ownerRows.some((owned) => owned.id === row.id)).map((row) => String(row.comment_id)));
      for (const id of candidates) {
        if (restoredIds.has(id)) {
          result.restored += 1;
        } else {
          result.unverified += 1;
          result.manualRequired += 1;
          unverifiedRows.push(...(rowsByComment.get(id) || []));
        }
      }
    }
  }
  if (unverifiedRows.length) {
    // YouTube가 204를 반환했지만 실제 공개 목록에서 끝내 확인되지 않은 과거 rejected
    // 댓글은 사람의 FP 결정은 보존한 채 1회 격리한다. 다음 15분 회차마다 50-unit
    // 복원 API를 무한 호출하거나 같은 degraded 경고를 반복하지 않는다.
    const marked = await markUnverifiedRestoreRows(config, unverifiedRows, fetchImpl);
    result.manualMarked = marked.updated;
    result.manualMarkFailed = marked.failed;
  }
  if (restoredRows.length) {
    const slack = await syncRestoredCards(config, restoredRows, fetchImpl, now);
    result.slackUpdated = slack.updated;
    result.slackFailed = slack.failed;
  }
  return result;
}

export async function restoreYouTubeComments(config = loadYouTubeRestoreConfig(), fetchImpl = fetch, now = Date.now()) {
  const rows = await loadYouTubeRestoreAlerts(config, fetchImpl);
  // 플랫폼 공개 복원보다 먼저 사람 판정을 확정해 15분 자동숨김과의 경쟁을 막는다.
  const falsePositivesUpdated = await ensureFalsePositive(config, rows, fetchImpl, now);

  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  if (!owners.length) throw new Error('No stored YouTube owner OAuth tokens');
  const accessTokens = new Map();
  const validOwners = [];
  for (const owner of owners) {
    try {
      accessTokens.set(owner.channelId, await refreshAndVerifyOwner(config, owner, fetchImpl));
      validOwners.push(owner);
    } catch {
      // 한 채널 토큰 장애가 다른 소유 채널 복원을 막지 않는다.
    }
  }
  if (!validOwners.length) throw new Error('No valid YouTube owner OAuth tokens');
  const mapped = await mapVideosToOwners(config, rows, validOwners, accessTokens, fetchImpl);
  const byOwner = new Map();
  for (const row of rows) {
    const owner = mapped.ownerByVideo.get(videoIdFromAlert(row));
    if (!owner) throw new Error('A requested YouTube comment is not owned by an authenticated channel');
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(row);
  }

  let restored = 0;
  let alreadyVisible = 0;
  for (const [owner, ownerRows] of byOwner) {
    const accessToken = accessTokens.get(owner);
    const ids = [...new Set(ownerRows.map((row) => String(row.comment_id)))];
    const before = await listYouTubeCommentStatesIsolated(config, ids, accessToken, fetchImpl);
    if (before.channelError || before.failed.length) throw new Error('YouTube ground-truth lookup failed before restore');
    // YouTube는 rejected 댓글을 comments.list 결과에서 아예 빼기도 한다. 숨김 직후의
    // missing은 삭제와 구분할 수 없으므로 published를 시도하고, 그 뒤 실제 visible로
    // 나타난 댓글만 복원 성공으로 확정한다. 삭제된 댓글이면 setModerationStatus/사후
    // 조회에서 실패하므로 성공을 위조하지 않는다.
    const hiddenOrMissing = ids.filter((id) => before.rejected.has(id) || before.missing.has(id));
    alreadyVisible += ids.filter((id) => before.visible.has(id)).length;
    if (hiddenOrMissing.length) await setPublished(config, hiddenOrMissing, accessToken, fetchImpl);
    const after = await verifyPublishedRows(config, ownerRows, accessToken, fetchImpl);
    if (after.failedVideos.size || !ids.every((id) => after.published.has(id))) {
      throw new Error('YouTube public restore could not be fully verified');
    }
    restored += hiddenOrMissing.length;
  }
  const slack = await syncRestoredCards(config, rows, fetchImpl, now);
  return {
    requested: rows.length,
    restored,
    alreadyVisible,
    verifiedVisible: rows.length,
    falsePositivesUpdated,
    fingerprintsProtected: rows.filter((row) => row.fingerprint).length,
    slack,
  };
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  await appendFile(file, [
    '## YouTube 댓글 공개 복원·오탐 반영', '',
    `- 요청: ${result.requested}`,
    `- 실제 복원: ${result.restored}`,
    `- 이미 공개: ${result.alreadyVisible}`,
    `- 공개 재확인: ${result.verifiedVisible}`,
    `- 오탐 지문 보호: ${result.fingerprintsProtected}`,
    `- Slack 카드 갱신: ${result.slack.updated} (실패 ${result.slack.failed})`, '',
    '> 댓글 ID·본문·작성자·OAuth 토큰은 로그와 요약에 기록하지 않습니다.', '',
  ].join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  restoreYouTubeComments()
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await writeSummary(result);
      if (result.verifiedVisible !== result.requested || result.slack.failed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(String(error.message || error));
      process.exitCode = 1;
    });
}
