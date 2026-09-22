import test from 'node:test';
import assert from 'node:assert/strict';

import { chainNextMonitor, isMonitorChainRun, isMonitorChainSmoke, monitorChainEnabled } from '../src/monitor-chain.js';

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
  assert.equal(monitorChainEnabled({ MONITOR_TRIGGER_EVENT: 'workflow_dispatch' }), false);
  assert.equal(isMonitorChainRun({ MONITOR_TRIGGER_EVENT: 'workflow_dispatch' }), false);
});

test('closed active gate does not read the ledger or dispatch', async () => {
  let calls = 0;
  const result = await chainNextMonitor(ENV, {
    now: NOW,
    gateOpen: false,
    fetchImpl: async () => { calls += 1; throw new Error('must not call'); },
    dispatch: async () => { calls += 1; },
  });

  assert.deepEqual(result, { dispatched: false, reason: 'gate-closed' });
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
      assert.deepEqual(options, { chain: true, maxPerDay: 1, smoke: true });
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
  assert.deepEqual(dispatches, [{ chain: true, maxPerDay: 2, smoke: false }]);
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
