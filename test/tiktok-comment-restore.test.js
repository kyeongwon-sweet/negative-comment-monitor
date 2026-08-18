import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTikTokRestoreConfig,
  restoreTikTokAdComment,
  TIKTOK_RESTORE_CONFIRMATION,
} from '../src/tiktok-comment-restore.js';

const BASE_ENV = {
  TIKTOK_RESTORE_ALERT_ID: '895',
  TIKTOK_ADVERTISER_ID: 'adv', TIKTOK_ACCESS_TOKEN: 'token',
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
};

const CFG = {
  alertId: '895', advertiserId: 'adv', accessToken: 'token', apiBase: 'https://tiktok.test',
  operation: 'PUBLIC', adType: 'BIDDING', supabaseUrl: 'https://db.test', supabaseKey: 'service',
  slackBotToken: 'slack', tiktokCampaignNameFilter: '빙과,쫀득바',
  tiktokAdsLookbackDays: 90, tiktokAdsMaxCommentsPerAdgroup: 1000,
};

function response(status, payload = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('TikTok 공개 복원은 확인문구와 사람 keep 결정이 필수다', () => {
  assert.throws(() => loadTikTokRestoreConfig(BASE_ENV), /RESTORE_TIKTOK_AD_COMMENT/);
  const config = loadTikTokRestoreConfig({ ...BASE_ENV, TIKTOK_RESTORE_CONFIRM: TIKTOK_RESTORE_CONFIRMATION });
  assert.equal(config.operation, 'PUBLIC');
  assert.equal(config.adType, 'BIDDING');
});

test('TikTok 공개 복원은 PUBLIC/BIDDING 성공을 재확인하고 DB 결정을 쓰지 않는다', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/negative_comment_alerts')) return response(200, [{
      id: 895, source: 'tiktok_ads', comment_id: 'comment-1', review_decision: 'false_positive', reviewed_by: 'user-keep',
      slack_channel_id: 'C1', slack_ts: '1.2', post_url: 'https://tiktok.test/video/1', comment_text: '비교 댓글',
    }]);
    if (url.endsWith('/comment/status/update/')) return response(200, { code: 0 });
    if (url === 'https://slack.com/api/chat.update') return response(200, { ok: true });
    throw new Error(`unexpected ${url}`);
  };
  const verify = async () => ({ hiddenIds: [], visibleIds: ['comment-1'], missingIds: [], campaigns: 1, ads: 1, adgroups: 1 });
  const result = await restoreTikTokAdComment(CFG, fetchImpl, Date.parse('2026-08-18T00:00:00Z'), verify);
  const update = calls.find((call) => call.url.endsWith('/comment/status/update/'));
  assert.deepEqual(JSON.parse(update.init.body), {
    advertiser_id: 'adv', comment_ids: ['comment-1'], operation: 'PUBLIC', ad_type: 'BIDDING',
  });
  assert.equal(result.restored, true);
  assert.equal(result.databaseDecisionPreserved, 'false_positive');
  assert.equal(calls.some((call) => call.init.method === 'PATCH'), false);
  assert.equal(JSON.stringify(result).includes('comment-1'), false);
});

test('사람 유지 결정이 없으면 TikTok 공개 복원을 거절한다', async () => {
  await assert.rejects(() => restoreTikTokAdComment(CFG, async (input) => {
    if (String(input).includes('/rest/v1/negative_comment_alerts')) return response(200, [{
      id: 895, source: 'tiktok_ads', comment_id: 'comment-1', review_decision: 'hidden',
    }]);
    throw new Error('must not call platform');
  }), /explicit human keep decision/);
});
