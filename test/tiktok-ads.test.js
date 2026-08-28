import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTikTokAdEntries,
  buildTikTokAdEntriesFromComments,
  filterTikTokCampaigns,
  loadTikTokAdsConfig,
} from '../src/tiktok-ads.js';
import { hasTikTokAdsRunToday, inTikTokAdsWindow, tiktokDailyRunKey } from '../src/tiktok-ads-run.js';

const CFG = {
  tiktokApiBase: 'https://business-api.test/open_api/v1.3',
  tiktokAccessToken: 'token',
  tiktokAdvertiserId: 'adv1',
  tiktokCampaignNameFilter: '빙과',
  tiktokAdsProductName: 'JD',
  tiktokAdsChannelCategory: '인지 광고',
  tiktokAdsLookbackDays: 7,
  tiktokAdsMaxCommentsPerAdgroup: 100,
  tiktokAdsConcurrency: 1,
  tiktokAdsRequestDelayMs: 0,
  brandContext: '라라스윗 쫀득바',
  videoAssignees: { '정요한': 'U_VIDEO' },
};

test('loadTikTokAdsConfig requires only ad adapter credentials plus shared alert config', () => {
  const config = loadTikTokAdsConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'db',
    SLACK_BOT_TOKEN: 'slack', TIKTOK_ACCESS_TOKEN: 'tt', TIKTOK_ADVERTISER_ID: '749',
    SLACK_ASSIGNEE_AWARENESS: 'U1', AD_CAMPAIGN_NAME_FILTER: '빙과',
  });
  assert.equal(config.tiktokAdvertiserId, '749');
  assert.equal(config.tiktokCampaignNameFilter, '빙과');
  assert.equal(config.tiktokAdsProductName, 'JD');
  assert.equal(config.slackAssignees.awareness, 'U1');
  assert.equal(config.tiktokAdsAutoHide, false);
  assert.equal(loadTikTokAdsConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'db', SLACK_BOT_TOKEN: 'slack',
    TIKTOK_ACCESS_TOKEN: 'tt', TIKTOK_ADVERTISER_ID: '749', TIKTOK_ADS_AUTO_HIDE: 'true',
  }).tiktokAdsAutoHide, true);
});

test('TikTok 대량 백필은 Slack 발송 간격을 안전 범위로 읽는다', () => {
  const config = loadTikTokAdsConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
    SLACK_BOT_TOKEN: 'xoxb-test', TIKTOK_ACCESS_TOKEN: 'token', TIKTOK_ADVERTISER_ID: 'adv',
    TIKTOK_ADS_ALERT_DELAY_MS: '1200',
  });
  assert.equal(config.tiktokAdsAlertDelayMs, 1200);
});

test('filterTikTokCampaigns keeps only names containing 빙과', () => {
  const campaigns = filterTikTokCampaigns([
    { campaign_id: '1', campaign_name: '[빙과] 쫀득바 인지' },
    { campaign_id: '2', campaign_name: '전환 상시' },
  ], '빙과');
  assert.deepEqual(campaigns.map((x) => x.campaign_id), ['1']);
});

test('filterTikTokCampaigns: 다중 키워드(빙과,쫀득바)로 두 명명 규칙 모두 매칭', () => {
  const campaigns = filterTikTokCampaigns([
    { campaign_id: '1', campaign_name: '[빙과] 인지' },
    { campaign_id: '2', campaign_name: '쫀득바 출시 영상' },
    { campaign_id: '3', campaign_name: '전환 상시' },
  ], '빙과,쫀득바');
  assert.deepEqual(campaigns.map((x) => x.campaign_id), ['1', '2']);
});

test('buildTikTokAdEntriesFromComments normalizes comments, replies and skips hidden/unrelated rows', () => {
  const entries = buildTikTokAdEntriesFromComments(CFG, [
    { comment_id: 'c1', content: '별로', campaign_name: '[빙과] 인지', ad_id: 'a1', adgroup_id: 'g1', ad_name: '[26.08]F_V_JD_인지_빙과_정요한', tiktok_item_id: '123456', user_name: 'u', create_time: '1' },
    { comment_id: 'c2', content: '답글', campaign_name: '[빙과] 인지', ad_id: 'a1', adgroup_id: 'g1', ad_name: '[26.08]F_V_JD_인지_빙과_정요한', tiktok_item_id: '123456', user_name: 'u2', original_comment_id: 'c1', create_time: '2' },
    { comment_id: 'c3', content: '숨김', campaign_name: '[빙과] 인지', ad_id: 'a1', comment_status: 'HIDDEN' },
    { comment_id: 'c4', content: '다른 캠페인', campaign_name: '전환', ad_id: 'a1' },
    { comment_id: 'c5', content: '다른 광고', campaign_name: '[빙과] 인지', ad_id: 'a2' },
  ], new Set(['a1']));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target.source, 'tiktok_ads');
  assert.equal(entries[0].target.productName, 'JD');
  assert.equal(entries[0].target.campaignName, '[빙과] 인지');
  assert.equal(entries[0].target.postKey, 'tt:123456');
  assert.deepEqual(entries[0].target.extraAssignees, ['U_VIDEO']);
  assert.deepEqual(entries[0].comments.map((x) => x.id), ['c1', 'c2']);
  assert.equal(entries[0].comments[1].parentId, 'c1');
});

test('buildTikTokAdEntriesFromComments honors the go-live cutoff without dropping unparseable timestamps', () => {
  const entries = buildTikTokAdEntriesFromComments({ ...CFG, tiktokAdsAlertAfter: '2026-08-14T08:45:00Z' }, [
    { comment_id: 'old', content: '과거', campaign_name: '[빙과] 인지', ad_id: 'a1', adgroup_id: 'g1', tiktok_item_id: 'v1', create_time: '2026-08-14 08:44:59 +0000 UTC' },
    { comment_id: 'new', content: '신규', campaign_name: '[빙과] 인지', ad_id: 'a1', adgroup_id: 'g1', tiktok_item_id: 'v1', create_time: '2026-08-14 08:45:01 +0000 UTC' },
    { comment_id: 'unknown-time', content: '시간불명', campaign_name: '[빙과] 인지', ad_id: 'a1', adgroup_id: 'g1', tiktok_item_id: 'v1', create_time: 'not-a-date' },
  ], new Set(['a1']));
  assert.deepEqual(entries[0].comments.map((comment) => comment.id), ['new', 'unknown-time']);
});

test('TikTok 인지 광고 캠페인명 파인트는 target 상품 P로 정규화한다', () => {
  const [entry] = buildTikTokAdEntriesFromComments(CFG, [{
    comment_id: 'p1', content: '별로', campaign_name: '[빙과] 파인트 인지',
    ad_id: 'a1', adgroup_id: 'g1', ad_name: '소재', tiktok_item_id: 'v1',
  }], new Set(['a1']));
  assert.equal(entry.target.productName, 'P');
});

test('buildTikTokAdEntries paginates campaigns/ads/comments and returns matching entries', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    let data;
    if (url.pathname.endsWith('/campaign/get/')) {
      data = { list: [{ campaign_id: 'cp1', campaign_name: '[빙과] 인지' }, { campaign_id: 'cp2', campaign_name: '전환' }], page_info: { total_page: 1 } };
    } else if (url.pathname.endsWith('/ad/get/')) {
      data = { list: [{ ad_id: 'a1', adgroup_id: 'g1', campaign_id: 'cp1', ad_name: '소재' }], page_info: { total_page: 1 } };
    } else {
      data = { comments: [{ comment_id: 'c1', content: '맛없다', ad_id: 'a1', adgroup_id: 'g1', tiktok_item_id: 'v1' }], page_info: { total_page: 1 } };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, message: 'OK', data }) };
  };
  const result = await buildTikTokAdEntries(CFG, fetchImpl, Date.parse('2026-08-14T01:00:00Z'));
  assert.equal(result.campaigns, 1);
  assert.equal(result.ads, 1);
  assert.equal(result.adgroups, 1);
  assert.equal(result.comments, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].target.campaignName, '[빙과] 인지');
  const commentCall = calls.find((url) => url.pathname.endsWith('/comment/list/'));
  assert.equal(commentCall.searchParams.get('search_field'), 'ADGROUP_ID');
  assert.equal(commentCall.searchParams.get('start_time'), '2026-08-07');
  assert.equal(commentCall.searchParams.get('end_time'), '2026-08-14');
});

test('inTikTokAdsWindow mirrors the resilient KST morning window', () => {
  const kst8 = Date.parse('2026-08-14T23:10:00Z');
  const kst12 = Date.parse('2026-08-15T03:10:00Z');
  assert.equal(inTikTokAdsWindow(kst8, {}), true);
  assert.equal(inTikTokAdsWindow(kst12, {}), false);
  assert.equal(inTikTokAdsWindow(kst12, { TIKTOK_ADS_FORCE: 'true' }), true);
});

test('tiktok daily ledger key is stable per advertiser and KST date', () => {
  assert.equal(
    tiktokDailyRunKey(CFG, Date.parse('2026-08-13T23:10:00Z')),
    'daily:tiktok-ads:adv1:2026-08-14',
  );
});

test('hasTikTokAdsRunToday skips only when the daily success row exists and fails open', async () => {
  const now = Date.parse('2026-08-13T23:10:00Z');
  const calls = [];
  const found = await hasTikTokAdsRunToday({ ...CFG, supabaseUrl: 'https://db.test', supabaseKey: 'key' }, now, async (url) => {
    calls.push(url);
    return { ok: true, json: async () => [{ run_key: 'daily:tiktok-ads:adv1:2026-08-14' }] };
  });
  assert.equal(found, true);
  assert.match(calls[0], /run_key=eq.daily%3Atiktok-ads%3Aadv1%3A2026-08-14/);
  assert.equal(await hasTikTokAdsRunToday({ ...CFG, supabaseUrl: 'https://db.test', supabaseKey: 'key' }, now, async () => ({ ok: false })), false);
});
