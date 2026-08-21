import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hideSingleTikTokAlert,
  loadTikTokSingleHideConfig,
  TIKTOK_SINGLE_HIDE_CONFIRMATION,
} from '../src/tiktok-comment-hide.js';

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('단일 TikTok 숨김은 확인문구와 alert row ID만 받는다', () => {
  const config = loadTikTokSingleHideConfig({
    TIKTOK_SINGLE_HIDE_CONFIRM: TIKTOK_SINGLE_HIDE_CONFIRMATION,
    TIKTOK_SINGLE_HIDE_ALERT_ID: '262',
    TIKTOK_ACCESS_TOKEN: 'token',
    TIKTOK_ADVERTISER_ID: 'advertiser',
    SUPABASE_URL: 'https://db.test',
    SUPABASE_SERVICE_ROLE_KEY: 'key',
  });
  assert.equal(config.alertId, 262);
  assert.equal(config.operation, 'HIDDEN');
  assert.equal(config.adType, 'BIDDING');
  assert.throws(() => loadTikTokSingleHideConfig({}), /confirmation|requires/i);
});

test('API HIDDEN 검증 성공 후 complete 행 하나만 hidden으로 기록한다', async () => {
  let patchedBody = null;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/negative_comment_alerts') && (!init.method || init.method === 'GET')) {
      return response(200, [{ id: 262, source: 'tiktok_ads', comment_id: 'comment-secret', review_decision: 'complete' }]);
    }
    if (url.includes('/comment/status/update/')) return response(200, { code: 0 });
    if (url.includes('/campaign/get/')) return response(200, { code: 0, data: { list: [{ campaign_id: 'c1', campaign_name: '빙과' }], page_info: { total_page: 1 } } });
    if (url.includes('/ad/get/')) return response(200, { code: 0, data: { list: [{ ad_id: 'a1', adgroup_id: 'g1' }], page_info: { total_page: 1 } } });
    if (url.includes('/comment/list/')) return response(200, { code: 0, data: { comments: [{ comment_id: 'comment-secret', comment_status: 'HIDDEN' }], page_info: { total_page: 1 } } });
    if (url.includes('/negative_comment_alerts') && init.method === 'PATCH') {
      assert.match(url, /review_decision=eq\.complete/);
      patchedBody = JSON.parse(init.body);
      return response(200, [{ id: 262 }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await hideSingleTikTokAlert({
    alertId: 262,
    apiBase: 'https://tiktok.test',
    accessToken: 'token',
    advertiserId: 'advertiser',
    operation: 'HIDDEN',
    adType: 'BIDDING',
    tiktokCampaignNameFilter: '빙과',
    tiktokAdsLookbackDays: 30,
    tiktokAdsMaxCommentsPerAdgroup: 1000,
    supabaseUrl: 'https://db.test',
    supabaseKey: 'key',
    actor: 'test-actor',
  }, fetchImpl, Date.parse('2026-08-21T00:00:00Z'));
  assert.deepEqual(result, { accepted: 1, verifiedHidden: 1, dbUpdated: 1 });
  assert.equal(patchedBody.review_decision, 'hidden');
});

test('검증에서 공개로 남으면 DB를 바꾸지 않는다', async () => {
  let patched = false;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, [{ id: 262, comment_id: 'c1', review_decision: 'complete' }]);
    if (url.includes('/comment/status/update/')) return response(200, { code: 0 });
    if (url.includes('/campaign/get/')) return response(200, { code: 0, data: { list: [{ campaign_id: 'camp', campaign_name: '빙과' }], page_info: { total_page: 1 } } });
    if (url.includes('/ad/get/')) return response(200, { code: 0, data: { list: [{ adgroup_id: 'g1' }], page_info: { total_page: 1 } } });
    if (url.includes('/comment/list/')) return response(200, { code: 0, data: { comments: [{ comment_id: 'c1', comment_status: 'PUBLIC' }], page_info: { total_page: 1 } } });
    if (init.method === 'PATCH') patched = true;
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(() => hideSingleTikTokAlert({
    alertId: 262, apiBase: 'https://tiktok.test', accessToken: 'token', advertiserId: 'advertiser',
    operation: 'HIDDEN', adType: 'BIDDING', tiktokCampaignNameFilter: '빙과', tiktokAdsLookbackDays: 30,
    tiktokAdsMaxCommentsPerAdgroup: 1000, supabaseUrl: 'https://db.test', supabaseKey: 'key', actor: 'test',
  }, fetchImpl), /not confirmed/);
  assert.equal(patched, false);
});
