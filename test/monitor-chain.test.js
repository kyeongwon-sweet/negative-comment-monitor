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

function floorWakeHarness(lastScannedAt) {
  const calls = [];
  const wakes = [];
  let claim = null;
  return {
    calls,
    wakes,
    fetchImpl: async (url, options = {}) => {
      const value = String(url);
      calls.push({ url: value, options });
      if (value.includes('monitor_scan_heartbeats')) {
        return jsonResponse([{ scanned_at: new Date(lastScannedAt).toISOString() }]);
      }
      if (value.includes('?on_conflict=run_key')) {
        claim = JSON.parse(options.body);
        return jsonResponse([claim]);
      }
      if (value.includes('?select=run_key')) return jsonResponse(claim ? [claim] : []);
      throw new Error(`unexpected URL: ${url}`);
    },
    scheduleWake: async (_env, _fetch, options) => { wakes.push(options); },
  };
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
  const harness = floorWakeHarness(NOW - 149 * 60_000);
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    fetchImpl: harness.fetchImpl,
    scheduleWake: harness.scheduleWake,
    dispatch: async () => { throw new Error('must not dispatch'); },
  });

  assert.equal(result.reason, 'floor-not-due');
  assert.equal(result.ageMinutes, 149);
  assert.equal(result.floorMinutes, 150);
  assert.equal(result.wake.scheduled, true);
  assert.equal(result.wake.wakeAt, NOW + 60_000);
  assert.equal(harness.wakes.length, 1);
  assert.equal(harness.wakes[0].wakeAt, NOW + 60_000);
  assert.equal(harness.calls.filter((call) => call.url.includes('monitor_scan_heartbeats')).length, 1);
});

test('a completed scan reserves exactly one delayed floor wake without immediate floor chaining', async () => {
  const harness = floorWakeHarness(NOW);
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    scannedThisRun: true,
    lastScannedAt: NOW,
    fetchImpl: harness.fetchImpl,
    scheduleWake: harness.scheduleWake,
    dispatch: async () => { throw new Error('must not dispatch monitor'); },
  });

  assert.equal(result.reason, 'floor-scan-completed');
  assert.equal(result.wake.scheduled, true);
  assert.equal(result.wake.wakeAt, NOW + 150 * 60_000);
  assert.equal(harness.wakes.length, 1);
  assert.equal(harness.calls.some((call) => call.url.includes('monitor_scan_heartbeats')), false);
});

test('floor wake reservations obey the same explicit daily cap and do not dispatch past it', async () => {
  const calls = [];
  const existing = { run_key: 'monitor-floor-wake:2026-09-22:0000000000' };
  let claimed;
  let wakeDispatches = 0;
  const result = await chainNextMonitor({
    ...ENV,
    MONITOR_CHAIN_FLOOR_MAX_PER_DAY: '1',
  }, {
    now: NOW,
    gateOpen: false,
    scannedThisRun: true,
    lastScannedAt: NOW,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('?on_conflict=run_key')) {
        claimed = JSON.parse(options.body);
        return jsonResponse([claimed]);
      }
      if (String(url).includes('?select=run_key')) return jsonResponse([existing, claimed]);
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected URL: ${url}`);
    },
    scheduleWake: async () => { wakeDispatches += 1; },
  });

  assert.equal(result.reason, 'floor-scan-completed');
  assert.equal(result.wake.reason, 'floor-wake-daily-cap');
  assert.equal(result.wake.maxPerDay, 1);
  assert.equal(wakeDispatches, 0);
  assert.equal(calls.at(-1).options.method, 'DELETE');
});

test('six hours without GitHub schedules stays within the 150-minute scan floor', async () => {
  let now = NOW;
  let lastScannedAt = NOW;
  let runId = 1;
  const end = NOW + 6 * 60 * 60_000;
  const scans = [NOW];
  const wakes = [];
  const ledger = new Map();

  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('monitor_scan_heartbeats')) {
      return jsonResponse([{ scanned_at: new Date(lastScannedAt).toISOString() }]);
    }
    if (value.includes('?on_conflict=run_key')) {
      const row = JSON.parse(options.body);
      if (ledger.has(row.run_key)) return jsonResponse([]);
      ledger.set(row.run_key, row);
      return jsonResponse([row]);
    }
    if (value.includes('?select=run_key')) {
      const decoded = decodeURIComponent(value);
      const prefix = decoded.match(/run_key=like\.([^*]+)\*/)?.[1] || '';
      return jsonResponse([...ledger.values()].filter((row) => row.run_key.startsWith(prefix)));
    }
    if (options.method === 'DELETE') {
      const decoded = decodeURIComponent(value);
      const runKey = decoded.match(/run_key=eq\.(.+)$/)?.[1];
      if (runKey) ledger.delete(runKey);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const scheduleWake = async (_env, _fetch, options) => { wakes.push(options.wakeAt); };
  const env = () => ({ ...ENV, GITHUB_RUN_ID: String(runId) });

  await chainNextMonitor(env(), {
    now,
    gateOpen: false,
    scannedThisRun: true,
    lastScannedAt,
    fetchImpl,
    scheduleWake,
  });

  while (wakes.length && Math.min(...wakes) <= end) {
    now = Math.min(...wakes);
    wakes.splice(wakes.indexOf(now), 1);
    runId += 1;
    const result = await chainNextMonitor(env(), {
      now,
      gateOpen: false,
      fetchImpl,
      scheduleWake,
      dispatch: async () => {},
    });
    assert.equal(result.reason, 'floor-queued');
    lastScannedAt = now;
    scans.push(now);
    await chainNextMonitor(env(), {
      now,
      gateOpen: false,
      scannedThisRun: true,
      lastScannedAt,
      fetchImpl,
      scheduleWake,
    });
  }

  const gaps = scans.slice(1).map((scan, index) => scan - scans[index]);
  assert.ok(gaps.length >= 2);
  assert.ok(gaps.every((gap) => gap <= 150 * 60_000));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0], NOW + 450 * 60_000);
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
  const harness = floorWakeHarness(NOW - 208 * 60_000);
  const result = await chainNextMonitor({ ...ENV, MONITOR_CHAIN_FLOOR_MINUTES: '999' }, {
    now: NOW,
    gateOpen: false,
    fetchImpl: harness.fetchImpl,
    scheduleWake: harness.scheduleWake,
    dispatch: async () => { throw new Error('must not dispatch'); },
  });

  assert.equal(result.reason, 'floor-not-due');
  assert.equal(result.ageMinutes, 208);
  assert.equal(result.floorMinutes, 209);
  assert.equal(harness.wakes.length, 1);
  assert.equal(harness.wakes[0].wakeAt, NOW + 60_000);
});
