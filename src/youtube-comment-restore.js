import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  listYouTubeCommentStatesIsolated,
  loadYouTubeOwnerTokens,
  mapVideosToOwners,
  refreshAndVerifyOwner,
  videoIdFromAlert,
} from './youtube-owner-moderation.js';

export const YOUTUBE_RESTORE_CONFIRMATION = 'RESTORE_YOUTUBE_COMMENTS';
const KEEP_DECISIONS = new Set(['false_positive', 'ignore', 'unhide']);

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
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

async function setPublished(config, ids, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/comments/setModerationStatus`);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('moderationStatus', 'published');
  const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.ok) return;
  const payload = await response.json().catch(() => ({}));
  const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
  throw new Error(`YouTube public restore failed (${response.status})${reasons.length ? `: ${reasons.join(',')}` : ''}`);
}

function escaped(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function syncRestoredCards(config, rows, fetchImpl, now) {
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
    const rejected = ids.filter((id) => before.rejected.has(id));
    alreadyVisible += ids.filter((id) => before.visible.has(id)).length;
    if (before.missing.size) throw new Error('A requested YouTube comment is unavailable and cannot be restored');
    if (rejected.length) await setPublished(config, rejected, accessToken, fetchImpl);
    const after = await listYouTubeCommentStatesIsolated(config, ids, accessToken, fetchImpl);
    if (after.channelError || after.failed.length || after.rejected.size || after.missing.size || after.visible.size !== ids.length) {
      throw new Error('YouTube public restore could not be fully verified');
    }
    restored += rejected.length;
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
