import test from 'node:test';
import assert from 'node:assert/strict';
import { commentFingerprint, loadRecentlyAlertedPostKeys, loadSeenFingerprints, recordAlert } from '../src/dedup.js';

test('commentFingerprint is stable and separates comment IDs', () => {
  const target = { platform: 'instagram', url: 'https://instagram.com/p/POST1/' };
  assert.equal(commentFingerprint(target, { id: 'c1' }), commentFingerprint(target, { id: 'c1' }));
  assert.notEqual(commentFingerprint(target, { id: 'c1' }), commentFingerprint(target, { id: 'c2' }));
});

test('commentFingerprint falls back to immutable comment fields when ID is absent', () => {
  const target = { platform: 'youtube', url: 'https://youtu.be/abcdefg' };
  const a = { username: 'u', timestamp: '2026-07-16T00:00:00Z', text: 'same' };
  const b = { ...a, text: 'different' };
  assert.notEqual(commentFingerprint(target, a), commentFingerprint(target, b));
});

test('commentFingerprint prefers adapter native postKey for dark ads without a public URL', () => {
  const comment = { id: 'c1', platform: 'tiktok', text: 'bad' };
  const a = commentFingerprint({ url: 'https://ads.tiktok.com/', postKey: 'ttad:ad-1' }, comment);
  const b = commentFingerprint({ url: 'https://ads.tiktok.com/', postKey: 'ttad:ad-2' }, comment);
  assert.notEqual(a, b);
});

test('loadSeenFingerprints returns recorded values', async () => {
  const config = { supabaseUrl: 'https://db.test', supabaseKey: 'key' };
  const fetchImpl = async () => ({ ok: true, json: async () => [{ fingerprint: 'a' }] });
  assert.deepEqual([...await loadSeenFingerprints(config, ['a', 'b'], fetchImpl)], ['a']);
});

test('recordAlert writes a conflict-safe row', async () => {
  let request;
  const config = { supabaseUrl: 'https://db.test', supabaseKey: 'key', slackChannelId: 'C1' };
  const fetchImpl = async (url, options) => { request = { url, options }; return { ok: true, json: async () => [{ id: 1 }] }; };
  const inserted = await recordAlert(config,
    { url: 'https://x.com/u/status/1', productName: 'JD멜', channelCategory: '바이럴 (영상)', channelName: '채널', assetName: '소재' },
    { id: 'c1', platform: 'twitter', text: 'bad', timestamp: '2026-08-21T00:00:00Z', risk: { category: '제품 불만', reason: '맛이 없다고 평가' } },
    'fp', '1.2', 'hash123', fetchImpl);
  assert.match(request.url, /on_conflict=fingerprint/);
  const body = JSON.parse(request.options.body);
  assert.equal(body.fingerprint, 'fp');
  assert.equal(body.classifier_hash, 'hash123'); // 알림 당시 해시 저장(#8 오탐률 집계용)
  assert.equal(body.category, '제품 불만');
  assert.equal(body.reason, '맛이 없다고 평가');
  assert.equal(body.product_name, 'JD멜');
  assert.equal(body.channel_category, '바이럴 (영상)');
  assert.equal(body.comment_timestamp, '2026-08-21T00:00:00Z');
  assert.equal(inserted.id, 1);
});

test('recordAlert preserves Meta ad source identifiers for server-side moderation', async () => {
  let body;
  const config = { supabaseUrl: 'https://db.test', supabaseKey: 'key', slackChannelId: 'C1' };
  const fetchImpl = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => [{ id: 1 }] }; };
  const target = { url: 'https://instagram.com/p/ABC/', source: 'meta_ads', metaMediaId: 'm1', metaAdId: 'a1' };
  await recordAlert(config, target, { id: 'c1', platform: 'instagram', text: 'bad' }, 'fp', '1.2', null, fetchImpl);
  assert.equal(body.source, 'meta_ads');
  assert.equal(body.meta_media_id, 'm1');
  assert.equal(body.meta_ad_id, 'a1');
});

test('loads recently alerted post keys for intensive monitoring', async () => {
  const config = { supabaseUrl: 'https://db.test', supabaseKey: 'key' };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ post_url: 'https://instagram.com/p/POST1/', alerted_at: '2026-07-16T00:00:00Z' }],
  });
  const recent = await loadRecentlyAlertedPostKeys(config, 3 * 60 * 60 * 1000, fetchImpl, Date.parse('2026-07-16T01:00:00Z'));
  assert.equal(recent.get('ig:POST1'), '2026-07-16T00:00:00Z');
});
