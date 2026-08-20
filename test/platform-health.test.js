import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPlatformOutcome } from '../src/platform-health.js';

const CFG = {
  supabaseUrl: 'https://db.test', supabaseKey: 'svc',
  platformFailureThreshold: 3, platformFailureAlertCooldownHours: 12,
};

function statefulFetch(initial = null) {
  let row = initial;
  const fetchImpl = async (url, options = {}) => {
    if ((options.method || 'GET') === 'GET') return { ok: true, json: async () => row ? [row] : [] };
    row = JSON.parse(options.body);
    return { ok: true, json: async () => [row] };
  };
  return { fetchImpl, row: () => row };
}

test('platform failure escalates only on the configured consecutive threshold', async () => {
  const db = statefulFetch();
  const now = Date.parse('2026-08-21T00:00:00Z');
  const first = await recordPlatformOutcome(CFG, { platform: 'tiktok', ok: false, error: 'timeout' }, db.fetchImpl, now);
  const second = await recordPlatformOutcome(CFG, { platform: 'tiktok', ok: false, error: 'timeout' }, db.fetchImpl, now + 60e3);
  const third = await recordPlatformOutcome(CFG, { platform: 'tiktok', ok: false, error: 'timeout' }, db.fetchImpl, now + 120e3);
  const fourth = await recordPlatformOutcome(CFG, { platform: 'tiktok', ok: false, error: 'timeout' }, db.fetchImpl, now + 180e3);
  assert.deepEqual([first.shouldEscalate, second.shouldEscalate, third.shouldEscalate, fourth.shouldEscalate], [false, false, true, false]);
  assert.equal(fourth.consecutiveFailures, 4);
});

test('platform success resets the failure streak and alert cooldown', async () => {
  const db = statefulFetch({
    platform: 'tiktok', consecutive_failures: 5, last_status: 'failure',
    last_alerted_at: '2026-08-21T00:00:00Z', last_failure_at: '2026-08-21T00:00:00Z',
  });
  const result = await recordPlatformOutcome(CFG, { platform: 'tiktok', ok: true }, db.fetchImpl, Date.parse('2026-08-21T01:00:00Z'));
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(result.shouldEscalate, false);
  assert.equal(db.row().last_status, 'success');
  assert.equal(db.row().last_alerted_at, null);
});

test('health table unavailable is fail-soft and names the required migration', async () => {
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    const result = await recordPlatformOutcome(CFG, { platform: 'tiktok', ok: false }, async () => ({ ok: false, status: 404 }));
    assert.equal(result.persisted, false);
    assert.equal(result.shouldEscalate, false);
  } finally {
    console.error = original;
  }
  assert.match(messages.join('\n'), /010_platform_collection_health\.sql/);
});
