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

test('loadSeenFingerprints returns recorded values', async () => {
  const config = { supabaseUrl: 'https://db.test', supabaseKey: 'key' };
  const fetchImpl = async () => ({ ok: true, json: async () => [{ fingerprint: 'a' }] });
  assert.deepEqual([...await loadSeenFingerprints(config, ['a', 'b'], fetchImpl)], ['a']);
});

test('recordAlert writes a conflict-safe row', async () => {
  let request;
  const config = { supabaseUrl: 'https://db.test', supabaseKey: 'key', slackChannelId: 'C1' };
  const fetchImpl = async (url, options) => { request = { url, options }; return { ok: true }; };
  await recordAlert(config, { url: 'https://x.com/u/status/1' }, { id: 'c1', platform: 'twitter', text: 'bad' }, 'fp', '1.2', fetchImpl);
  assert.match(request.url, /on_conflict=fingerprint/);
  assert.equal(JSON.parse(request.options.body).fingerprint, 'fp');
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
