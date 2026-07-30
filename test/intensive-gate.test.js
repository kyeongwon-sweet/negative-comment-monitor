import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRecentNegativeAlerts } from '../src/intensive-gate.js';

test('intensive gate returns true when a recent alert exists', async () => {
  let requestedUrl = '';
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => [{ fingerprint: 'fp1' }] };
  };
  const result = await hasRecentNegativeAlerts(
    { supabaseUrl: 'https://db.test/', supabaseKey: 'key' },
    { now: Date.parse('2026-07-30T00:00:00Z'), fetchImpl },
  );
  assert.equal(result, true);
  assert.match(requestedUrl, /negative_comment_alerts/);
  assert.match(requestedUrl, /limit=1/);
  assert.match(requestedUrl, /alerted_at=gte\.2026-07-29T21%3A00%3A00\.000Z/);
});

test('intensive gate returns false when there are no recent alerts', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  const result = await hasRecentNegativeAlerts(
    { supabaseUrl: 'https://db.test', supabaseKey: 'key' },
    { now: Date.parse('2026-07-30T00:00:00Z'), fetchImpl },
  );
  assert.equal(result, false);
});

test('intensive gate surfaces Supabase errors so the CLI can fail open', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(
    hasRecentNegativeAlerts(
      { supabaseUrl: 'https://db.test', supabaseKey: 'key' },
      { now: Date.parse('2026-07-30T00:00:00Z'), fetchImpl },
    ),
    /Intensive gate GET 500/,
  );
});
