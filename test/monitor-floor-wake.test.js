import test from 'node:test';
import assert from 'node:assert/strict';

import { runMonitorFloorWake } from '../src/monitor-floor-wake.js';

test('floor waiter sleeps only until the absolute target then re-checks the chain once', async () => {
  let now = Date.parse('2026-09-22T03:00:00Z');
  const wakeAt = now + 150 * 60_000;
  const sleeps = [];
  const chainCalls = [];
  const result = await runMonitorFloorWake({
    MONITOR_FLOOR_WAKE_AT: new Date(wakeAt).toISOString(),
  }, {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    chain: async (details) => {
      chainCalls.push(details);
      return { dispatched: true, reason: 'floor-queued' };
    },
  });

  assert.deepEqual(sleeps, [150 * 60_000]);
  assert.deepEqual(chainCalls, [{ gateOpen: false, scannedThisRun: false, now: wakeAt }]);
  assert.deepEqual(result, {
    wakeAt,
    waitMs: 150 * 60_000,
    chain: { dispatched: true, reason: 'floor-queued' },
  });
});
