import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hideTikTokCommentBatch, verifyHiddenTikTokComments } from './tiktok-bulk-hide.js';

export const TIKTOK_RESTORE_CONFIRMATION = 'RESTORE_TIKTOK_AD_COMMENT';
const KEEP_DECISIONS = new Set(['false_positive', 'ignore', 'unhide']);
const DEFAULT_TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadTikTokRestoreConfig(env = process.env) {
  if (String(env.TIKTOK_RESTORE_CONFIRM || '').trim() !== TIKTOK_RESTORE_CONFIRMATION) {
    throw new Error(`TikTok public restore requires TIKTOK_RESTORE_CONFIRM=${TIKTOK_RESTORE_CONFIRMATION}`);
  }
  return {
    alertId: required(env, 'TIKTOK_RESTORE_ALERT_ID'),
    advertiserId: required(env, 'TIKTOK_ADVERTISER_ID'),
    accessToken: required(env, 'TIKTOK_ACCESS_TOKEN'),
    apiBase: String(env.TIKTOK_API_BASE || DEFAULT_TIKTOK_API_BASE).trim().replace(/\/$/, ''),
    operation: 'PUBLIC',
    adType: String(env.TIKTOK_HIDE_AD_TYPE || 'BIDDING').trim(),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackBotToken: String(env.SLACK_BOT_TOKEN || '').trim(),
    tiktokCampaignNameFilter: String(env.AD_CAMPAIGN_NAME_FILTER || '빙과,쫀득바').trim(),
    tiktokAdsLookbackDays: 90,
    tiktokAdsMaxCommentsPerAdgroup: 1000,
  };
}

function headers(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

export async function loadTikTokRestoreAlert(config, fetchImpl = fetch) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
  url.searchParams.set('select', 'id,source,comment_id,comment_text,post_url,review_decision,reviewed_by,slack_channel_id,slack_ts');
  url.searchParams.set('id', `eq.${config.alertId}`);
  url.searchParams.set('source', 'eq.tiktok_ads');
  url.searchParams.set('limit', '1');
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`TikTok restore alert lookup failed (${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('TikTok restore alert not found');
  const row = rows[0];
  if (!row.comment_id) throw new Error('TikTok restore alert has no comment ID');
  if (!KEEP_DECISIONS.has(String(row.review_decision || '').trim().toLowerCase())) {
    throw new Error('TikTok restore requires an explicit human keep decision');
  }
  return row;
}

function escaped(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function syncRestoredCard(config, row, fetchImpl, now) {
  if (!config.slackBotToken || !row.slack_channel_id || !row.slack_ts) return { updated: 0, failed: 0 };
  const when = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const post = escaped(row.post_url);
  const comment = escaped(String(row.comment_text || '').slice(0, 700));
  const response = await fetchImpl('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: row.slack_channel_id,
      ts: row.slack_ts,
      text: 'TikTok 광고 댓글 공개 복원 완료',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `👁️ *TikTok 광고 댓글 공개 복원 완료*${post ? `\n<${post}|게시물 열기>` : ''}${comment ? `\n\n*댓글*\n${comment}` : ''}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `*공개 복원됨 👁️* · 사람 유지 결정 보존 · ${when} KST` }] },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  return response.ok && payload.ok ? { updated: 1, failed: 0 } : { updated: 0, failed: 1 };
}

export async function restoreTikTokAdComment(
  config = loadTikTokRestoreConfig(),
  fetchImpl = fetch,
  now = Date.now(),
  verifyImpl = verifyHiddenTikTokComments,
) {
  const row = await loadTikTokRestoreAlert(config, fetchImpl);
  const update = await hideTikTokCommentBatch(config, [String(row.comment_id)], fetchImpl, async () => {});
  if (!update.ok) throw new Error(`TikTok public restore failed (${update.code || 'unknown'})`);
  const verified = await verifyImpl(config, [String(row.comment_id)], fetchImpl, now);
  const restored = verified.visibleIds.includes(String(row.comment_id));
  if (!restored) throw new Error('TikTok public restore was not visible during verification');
  const slack = await syncRestoredCard(config, row, fetchImpl, now);
  return {
    restored: true,
    databaseDecisionPreserved: String(row.review_decision || ''),
    slack,
    verification: { visible: 1, hidden: 0, missing: 0 },
  };
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  await appendFile(file, [
    '## TikTok 광고 댓글 공개 복원', '',
    `- 실제 공개 재확인: ${result.restored ? '성공' : '실패'}`,
    `- 사람 유지 결정 보존: ${result.databaseDecisionPreserved}`,
    `- Slack 카드 갱신: ${result.slack.updated} (실패 ${result.slack.failed})`, '',
    '> 댓글 ID·본문·작성자·토큰은 로그와 요약에 기록하지 않습니다.', '',
  ].join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  restoreTikTokAdComment()
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await writeSummary(result);
      if (result.slack.failed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(String(error.message || error));
      process.exitCode = 1;
    });
}
