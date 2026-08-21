import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hideTikTokCommentBatch, verifyHiddenTikTokComments } from './tiktok-bulk-hide.js';

export const TIKTOK_SINGLE_HIDE_CONFIRMATION = 'HIDE_ONE_TIKTOK_AD_ALERT';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadTikTokSingleHideConfig(env = process.env) {
  if (String(env.TIKTOK_SINGLE_HIDE_CONFIRM || '').trim() !== TIKTOK_SINGLE_HIDE_CONFIRMATION) {
    throw new Error(`Single TikTok hide requires TIKTOK_SINGLE_HIDE_CONFIRM=${TIKTOK_SINGLE_HIDE_CONFIRMATION}`);
  }
  const alertId = Number(required(env, 'TIKTOK_SINGLE_HIDE_ALERT_ID'));
  if (!Number.isInteger(alertId) || alertId <= 0) throw new Error('TikTok alert ID must be a positive integer');
  return {
    alertId,
    apiBase: String(env.TIKTOK_API_BASE || 'https://business-api.tiktok.com/open_api/v1.3').trim().replace(/\/$/, ''),
    accessToken: required(env, 'TIKTOK_ACCESS_TOKEN'),
    advertiserId: required(env, 'TIKTOK_ADVERTISER_ID'),
    operation: 'HIDDEN',
    adType: 'BIDDING',
    tiktokCampaignNameFilter: String(env.AD_CAMPAIGN_NAME_FILTER || '빙과,쫀득바').trim(),
    tiktokAdsLookbackDays: 30,
    tiktokAdsMaxCommentsPerAdgroup: 1000,
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    actor: String(env.TIKTOK_SINGLE_HIDE_ACTOR || 'codex-single-tiktok-hide').trim(),
  };
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export async function loadCompleteTikTokAlert(config, fetchImpl = fetch) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
  url.searchParams.set('select', 'id,source,comment_id,review_decision');
  url.searchParams.set('id', `eq.${config.alertId}`);
  url.searchParams.set('source', 'eq.tiktok_ads');
  url.searchParams.set('limit', '1');
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`TikTok alert lookup failed (${response.status})`);
  const row = (await response.json())[0];
  if (!row) throw new Error('TikTok alert row not found');
  if (!String(row.comment_id || '').trim()) throw new Error('TikTok alert has no comment ID');
  if (String(row.review_decision || '').trim().toLowerCase() !== 'complete') {
    throw new Error('TikTok alert is no longer in the approved complete state');
  }
  return row;
}

async function persistVerifiedHidden(config, now, fetchImpl) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
  url.searchParams.set('id', `eq.${config.alertId}`);
  url.searchParams.set('source', 'eq.tiktok_ads');
  // 사람의 keep/무시 결정이 동시에 들어오면 덮어쓰지 않는 낙관적 잠금.
  url.searchParams.set('review_decision', 'eq.complete');
  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify({
      review_decision: 'hidden',
      reviewed_by: config.actor,
      reviewed_at: new Date(now).toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`TikTok alert audit update failed (${response.status})`);
  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('TikTok alert changed concurrently; hidden state was not recorded');
  }
  return 1;
}

export async function hideSingleTikTokAlert(
  config = loadTikTokSingleHideConfig(), fetchImpl = fetch, now = Date.now(),
) {
  const alert = await loadCompleteTikTokAlert(config, fetchImpl);
  const commentId = String(alert.comment_id);
  const accepted = await hideTikTokCommentBatch(config, [commentId], fetchImpl, async () => {});
  if (!accepted.ok) throw new Error(`TikTok hide was rejected (${accepted.code ?? '-'}): ${accepted.message || 'unknown'}`);
  const verified = await verifyHiddenTikTokComments(config, [commentId], fetchImpl, now);
  if (!verified.hiddenIds.includes(commentId)) {
    const state = verified.visibleIds.includes(commentId) ? 'visible' : 'missing';
    throw new Error(`TikTok hide was not confirmed (${state}); DB was not changed`);
  }
  const dbUpdated = await persistVerifiedHidden(config, now, fetchImpl);
  return { accepted: 1, verifiedHidden: 1, dbUpdated };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  hideSingleTikTokAlert()
    // 공개 로그에는 alert/comment ID나 원문을 남기지 않는다.
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => {
      console.error(`[tiktok-single-hide] ${error.message}`);
      process.exitCode = 1;
    });
}
