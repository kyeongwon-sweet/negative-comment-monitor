import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMetaAdEntries,
  isConversionAd,
  loadMetaAdsConfig,
  loadPendingMetaAdEvents,
  markMetaAdEventsProcessed,
} from '../src/meta-ads.js';

const CFG = {
  supabaseUrl: 'https://db.test',
  supabaseKey: 'svc',
  metaGraphBase: 'https://graph.facebook.com/v26.0',
  metaTokenKind: 'ig_ads',
  metaAdsProductName: 'JD',
  metaAdsChannelCategory: '인지 광고',
  metaAdsInstagramUsername: 'lalasweet_icecream',
  brandContext: '라라스윗 쫀득바',
};

test('loadMetaAdsConfig only requires Supabase and Slack secrets', () => {
  const config = loadMetaAdsConfig({
    SUPABASE_URL: 'https://db.test/',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    SLACK_BOT_TOKEN: 'xoxb-test',
  });
  assert.equal(config.supabaseUrl, 'https://db.test');
  assert.equal(config.metaAdsProductName, 'JD');
  assert.equal(config.metaAdsChannelCategory, '인지 광고');
  assert.equal(config.metaGraphBase, 'https://graph.facebook.com/v26.0');
});

test('loadPendingMetaAdEvents reads only unprocessed rows in arrival order', async () => {
  let requested = '';
  const events = [{ id: 1, comment_id: 'c1' }];
  const fetchImpl = async (url) => { requested = String(url); return { ok: true, json: async () => events }; };
  assert.deepEqual(await loadPendingMetaAdEvents(CFG, 20, fetchImpl), events);
  assert.match(requested, /processed_at=is\.null/);
  assert.match(requested, /order=received_at\.asc/);
  assert.match(requested, /limit=20/);
});

test('buildMetaAdEntries groups Webhook comments and enriches the permalink', async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes('/rest/v1/meta_tokens')) {
      return { ok: true, json: async () => [{ token: 'TOKEN', expires_at: '2099-01-01T00:00:00Z' }] };
    }
    if (value.includes('/178900?fields=')) {
      return { ok: true, json: async () => ({ id: '178900', permalink: 'https://www.instagram.com/p/ABC/', caption: '쫀득바 광고' }) };
    }
    throw new Error(`unexpected ${value}`);
  };
  const entries = await buildMetaAdEntries(CFG, [
    { id: 1, comment_id: 'c1', ig_user_id: 'ig1', media_id: '178900', ad_id: 'ad1', username: 'u1', comment_text: '별로', event_time: '2026-08-04T00:00:00Z' },
    { id: 2, comment_id: 'c2', ig_user_id: 'ig1', media_id: '178900', ad_id: 'ad1', username: 'u2', comment_text: '광고 티남', event_time: '2026-08-04T00:01:00Z' },
  ], fetchImpl);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target.source, 'meta_ads');
  assert.equal(entries[0].target.url, 'https://www.instagram.com/p/ABC/');
  assert.equal(entries[0].target.channelCategory, '인지 광고');
  assert.equal(entries[0].comments.length, 2);
  assert.equal(entries[0].comments[0].metaEventId, 1);
});

test('isConversionAd: 소재명 토큰에 전환이면 true, 인지면 false', () => {
  assert.equal(isConversionAd('[26.06]F_I_P애_전환_상시_혜택강조형_박지연_260623_빙과_홍정민'), true);
  assert.equal(isConversionAd('[26.07]F_V_JD멜_인지_쫀득바출시_인물리뷰형_260731_빙과_정요한'), false);
  assert.equal(isConversionAd(''), false);
  assert.equal(isConversionAd(null), false);
});

test('buildMetaAdEntries: 전환 광고 이벤트는 분류에서 제외(드롭)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] }); // 토큰 없음 → permalink 폴백
  const entries = await buildMetaAdEntries(CFG, [
    { id: 10, comment_id: 'k1', ig_user_id: 'ig1', media_id: 'm1', ad_id: 'ad1', ad_title: '[26.06]F_I_P애_전환_상시_x', username: 'u', comment_text: '별로' },
    { id: 11, comment_id: 'k2', ig_user_id: 'ig1', media_id: 'm2', ad_id: 'ad2', ad_title: '[26.07]F_V_JD멜_인지_x_정요한', username: 'u2', comment_text: '별로' },
  ], fetchImpl);
  const ids = entries.flatMap((e) => e.comments.map((c) => c.id));
  assert.ok(!ids.includes('k1'), '전환 광고 댓글은 제외되어야 함');
  assert.ok(ids.includes('k2'), '인지 광고 댓글은 유지되어야 함');
});

test('buildMetaAdEntries still classifies when no stored token exists', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  const [entry] = await buildMetaAdEntries(CFG, [
    { id: 3, comment_id: 'c3', ig_user_id: 'ig1', media_id: 'm3', ad_id: 'ad3', username: 'u', comment_text: '싫어요' },
  ], fetchImpl);
  assert.equal(entry.target.url, 'https://www.instagram.com/lalasweet_icecream/');
  assert.equal(entry.comments[0].id, 'c3');
});

test('markMetaAdEventsProcessed marks the selected queue rows', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url: String(url), options }; return { ok: true, text: async () => '' }; };
  const count = await markMetaAdEventsProcessed(CFG, [1, 2, 2], fetchImpl, Date.parse('2026-08-04T01:00:00Z'));
  assert.equal(count, 2);
  assert.match(request.url, /meta_ad_comment_events\?id=in\./);
  assert.equal(request.options.method, 'PATCH');
  assert.equal(JSON.parse(request.options.body).processed_at, '2026-08-04T01:00:00.000Z');
});
