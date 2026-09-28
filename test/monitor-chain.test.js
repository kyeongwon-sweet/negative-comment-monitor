import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chainNextMonitor,
  isMonitorChainFloorRun,
  isMonitorChainRun,
  isMonitorChainSmoke,
  monitorChainEnabled,
} from '../src/monitor-chain.js';

const NOW = Date.parse('2026-09-22T03:00:00Z'); // 2026-09-22 12:00 KST
const ENV = {
  MONITOR_CHAIN_ENABLED: 'true',
  MONITOR_CHAIN_RUN: 'true',
  MONITOR_CHAIN_MAX_PER_DAY: '2',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('chain flags are explicit and do not infer from generic workflow_dispatch', () => {
  assert.equal(monitorChainEnabled(ENV), true);
  assert.equal(isMonitorChainRun(ENV), true);
  assert.equal(isMonitorChainSmoke({ MONITOR_CHAIN_SMOKE: 'true' }), true);
  assert.equal(isMonitorChainFloorRun({ MONITOR_CHAIN_FLOOR_RUN: 'true' }), true);
  assert.equal(monitorChainEnabled({ MONITOR_TRIGGER_EVENT: 'workflow_dispatch' }), false);
  assert.equal(isMonitorChainRun({ MONITOR_TRIGGER_EVENT: 'workflow_dispatch' }), false);
});

test('closed active gate does not dispatch while the latest scan is newer than the floor', async () => {
  const calls = [];
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse([{ scanned_at: new Date(NOW - 149 * 60_000).toISOString() }]);
    },
    dispatch: async () => { throw new Error('must not dispatch'); },
  });

  assert.deepEqual(result, {
    dispatched: false,
    reason: 'floor-not-due',
    ageMinutes: 149,
    floorMinutes: 150,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /monitor_scan_heartbeats/);
});

test('a completed scan never immediately floor-chains when the gate closes', async () => {
  let calls = 0;
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    scannedThisRun: true,
    fetchImpl: async () => { calls += 1; throw new Error('must not call'); },
    dispatch: async () => { calls += 1; },
  });

  assert.deepEqual(result, { dispatched: false, reason: 'floor-scan-completed' });
  assert.equal(calls, 0);
});

test('smoke probe may test one real queue hop with the gate closed only when capped at one', async () => {
  let dispatched = 0;
  const result = await chainNextMonitor({
    ...ENV,
    MONITOR_CHAIN_SMOKE: 'true',
    MONITOR_CHAIN_MAX_PER_DAY: '1',
  }, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('?select=run_key')) return jsonResponse([]);
      if (String(url).includes('?on_conflict=run_key')) return jsonResponse([JSON.parse(options.body)]);
      throw new Error(`unexpected URL: ${url}`);
    },
    dispatch: async (_env, _fetch, options) => {
      dispatched += 1;
      assert.deepEqual(options, {
        chain: true,
        maxPerDay: 1,
        smoke: true,
        floor: false,
        floorMinutes: 150,
        floorMaxPerDay: 12,
      });
    },
  });

  assert.deepEqual(result, { dispatched: true, reason: 'queued', count: 1, maxPerDay: 1 });
  assert.equal(dispatched, 1);
});

test('smoke probe refuses to bypass the gate with a cap above one', async () => {
  let calls = 0;
  const result = await chainNextMonitor({ ...ENV, MONITOR_CHAIN_SMOKE: 'true' }, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async () => { calls += 1; throw new Error('must not call'); },
    dispatch: async () => { calls += 1; },
  });

  assert.deepEqual(result, { dispatched: false, reason: 'smoke-requires-cap-one', maxPerDay: 2 });
  assert.equal(calls, 0);
});

test('daily cap stops self-chaining before a new claim', async () => {
  let dispatched = 0;
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: true,
    fetchImpl: async (url) => {
      assert.match(String(url), /cost_usage_ledger\?select=run_key/);
      return jsonResponse([{ run_key: 'one' }, { run_key: 'two' }]);
    },
    dispatch: async () => { dispatched += 1; },
  });

  assert.deepEqual(result, { dispatched: false, reason: 'daily-cap', count: 2, maxPerDay: 2 });
  assert.equal(dispatched, 0);
});

test('open gate atomically claims a daily slot then queues one chain run', async () => {
  const calls = [];
  const dispatches = [];
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: true,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('?select=run_key')) return jsonResponse([]);
      if (String(url).includes('?on_conflict=run_key')) return jsonResponse([JSON.parse(options.body)]);
      throw new Error(`unexpected URL: ${url}`);
    },
    dispatch: async (_env, _fetch, options) => { dispatches.push(options); },
  });

  assert.deepEqual(result, { dispatched: true, reason: 'queued', count: 1, maxPerDay: 2 });
  assert.deepEqual(dispatches, [{
    chain: true,
    maxPerDay: 2,
    smoke: false,
    floor: false,
    floorMinutes: 150,
    floorMaxPerDay: 12,
  }]);
  assert.equal(calls.some((call) => call.url.includes('monitor_scan_heartbeats')), false);
  const claim = JSON.parse(calls[1].options.body);
  assert.equal(claim.run_key, 'monitor-chain:2026-09-22:123:1');
  assert.equal(claim.kst_date, '2026-09-22');
});

test('dispatch failure releases the claim and remains fail-soft', async () => {
  const calls = [];
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: true,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('?select=run_key')) return jsonResponse([]);
      if (String(url).includes('?on_conflict=run_key')) return jsonResponse([JSON.parse(options.body)]);
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected URL: ${url}`);
    },
    dispatch: async () => { throw new Error('dispatch API 500'); },
  });

  assert.deepEqual(result, { dispatched: false, reason: 'dispatch-failed', error: 'dispatch API 500' });
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.match(calls.at(-1).url, /monitor-chain%3A2026-09-22%3A123%3A1/);
});

test('stale heartbeat queues a floor continuation with a separate ledger namespace and cap', async () => {
  const calls = [];
  const dispatches = [];
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('monitor_scan_heartbeats')) {
        return jsonResponse([{ scanned_at: new Date(NOW - 151 * 60_000).toISOString() }]);
      }
      if (String(url).includes('?select=run_key')) return jsonResponse([]);
      if (String(url).includes('?on_conflict=run_key')) return jsonResponse([JSON.parse(options.body)]);
      throw new Error(`unexpected URL: ${url}`);
    },
    dispatch: async (_env, _fetch, options) => { dispatches.push(options); },
  });

  assert.deepEqual(result, {
    dispatched: true,
    reason: 'floor-queued',
    count: 1,
    maxPerDay: 12,
    ageMinutes: 151,
    floorMinutes: 150,
  });
  assert.deepEqual(dispatches, [{
    chain: true,
    maxPerDay: 2,
    smoke: false,
    floor: true,
    floorMinutes: 150,
    floorMaxPerDay: 12,
  }]);
  const floorClaim = JSON.parse(calls.find((call) => call.url.includes('?on_conflict=run_key')).options.body);
  assert.equal(floorClaim.run_key, 'monitor-floor-chain:2026-09-22:123:1');
});

test('floor daily cap stops quiet-period dispatch independently of the intensive cap', async () => {
  let dispatched = 0;
  const result = await chainNextMonitor({
    ...ENV,
    MONITOR_CHAIN_MAX_PER_DAY: '24',
    MONITOR_CHAIN_FLOOR_MAX_PER_DAY: '2',
  }, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async (url) => {
      if (String(url).includes('monitor_scan_heartbeats')) return jsonResponse([]);
      if (String(url).includes('?select=run_key')) return jsonResponse([{ run_key: 'one' }, { run_key: 'two' }]);
      throw new Error(`unexpected URL: ${url}`);
    },
    dispatch: async () => { dispatched += 1; },
  });

  assert.deepEqual(result, {
    dispatched: false,
    reason: 'floor-daily-cap',
    count: 2,
    maxPerDay: 2,
    ageMinutes: null,
    floorMinutes: 150,
  });
  assert.equal(dispatched, 0);
});

test('heartbeat read failure fails open to a bounded floor dispatch', async () => {
  let dispatched = 0;
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('monitor_scan_heartbeats')) return jsonResponse({}, 500);
      if (String(url).includes('?select=run_key')) return jsonResponse([]);
      if (String(url).includes('?on_conflict=run_key')) return jsonResponse([JSON.parse(options.body)]);
      throw new Error(`unexpected URL: ${url}`);
    },
    dispatch: async () => { dispatched += 1; },
  });

  assert.equal(result.reason, 'floor-queued');
  assert.equal(result.heartbeatReadFailed, true);
  assert.equal(result.ageMinutes, null);
  assert.equal(dispatched, 1);
});

test('floor dispatch failure releases only the floor claim and remains fail-soft', async () => {
  const calls = [];
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('monitor_scan_heartbeats')) return jsonResponse([]);
      if (String(url).includes('?select=run_key')) return jsonResponse([]);
      if (String(url).includes('?on_conflict=run_key')) return jsonResponse([JSON.parse(options.body)]);
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected URL: ${url}`);
    },
    dispatch: async () => { throw new Error('dispatch API 500'); },
  });

  assert.equal(result.reason, 'floor-dispatch-failed');
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.match(calls.at(-1).url, /monitor-floor-chain%3A2026-09-22%3A123%3A1/);
});

test('floor interval is clamped below the 210-minute watchdog threshold', async () => {
  const result = await chainNextMonitor({ ...ENV, MONITOR_CHAIN_FLOOR_MINUTES: '999' }, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async (url) => {
      assert.match(String(url), /monitor_scan_heartbeats/);
      return jsonResponse([{ scanned_at: new Date(NOW - 208 * 60_000).toISOString() }]);
    },
    dispatch: async () => { throw new Error('must not dispatch'); },
  });

  assert.deepEqual(result, {
    dispatched: false,
    reason: 'floor-not-due',
    ageMinutes: 208,
    floorMinutes: 209,
  });
});
