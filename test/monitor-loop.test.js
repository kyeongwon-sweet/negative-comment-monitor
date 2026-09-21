import test from 'node:test';
import assert from 'node:assert/strict';

import { forceFirstMonitor, runMonitorLoop } from '../src/monitor-loop.js';

const BASE_ENV = {
  MONITOR_TRIGGER_EVENT: 'schedule',
  MONITOR_TRIGGER_SCHEDULE: '*/15 * * * *',
  MONITOR_LOOP_ITERATIONS: '4',
  MONITOR_LOOP_INTERVAL_MS: '1',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'key',
};

test('closed intensive loop exits after one cheap gate read', async () => {
  let gateCalls = 0;
  const commands = [];
  const sleeps = [];
  const result = await runMonitorLoop(BASE_ENV, {
    gate: async () => { gateCalls += 1; return false; },
    runCommand: async (...args) => { commands.push(args); },
    recordHeartbeat: async () => {},
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(gateCalls, 1);
  assert.deepEqual(commands, []);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(result, { iterations: 4, monitorRuns: 0, dependenciesInstalled: false });
});

test('open loop installs once, scans four times, and records each real scan', async () => {
  const commands = [];
  const heartbeats = [];
  const result = await runMonitorLoop(BASE_ENV, {
    gate: async () => true,
    runCommand: async (command, args) => { commands.push([command, ...args]); },
    recordHeartbeat: async (details) => { heartbeats.push(details); },
    now: () => Date.parse('2026-09-21T07:50:00Z'),
    sleep: async () => {},
  });

  assert.deepEqual(commands, [
    ['npm', 'install', '--ignore-scripts'],
    ['npm', 'start'],
    ['npm', 'start'],
    ['npm', 'start'],
    ['npm', 'start'],
  ]);
  assert.deepEqual(heartbeats.map((heartbeat) => heartbeat.iteration), [1, 2, 3, 4]);
  assert.ok(heartbeats.every((heartbeat) => heartbeat.scannedAt === Date.parse('2026-09-21T07:50:00Z')));
  assert.deepEqual(result, { iterations: 4, monitorRuns: 4, dependenciesInstalled: true });
});

test('floor schedule forces the first scan but gates later iterations', async () => {
  const commands = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_TRIGGER_SCHEDULE: '0 */3 * * *',
  }, {
    gate: async () => false,
    runCommand: async (command, args) => { commands.push([command, ...args]); },
    recordHeartbeat: async () => {},
    sleep: async () => {},
  });

  assert.equal(result.monitorRuns, 1);
  assert.deepEqual(commands, [
    ['npm', 'install', '--ignore-scripts'],
    ['npm', 'start'],
  ]);
});

test('gate failures fail open without skipping a coverage iteration', async () => {
  let starts = 0;
  const result = await runMonitorLoop(BASE_ENV, {
    gate: async () => { throw new Error('db unavailable'); },
    runCommand: async (_command, args) => { if (args[0] === 'start') starts += 1; },
    recordHeartbeat: async () => {},
    sleep: async () => {},
  });

  assert.equal(starts, 4);
  assert.equal(result.monitorRuns, 4);
});

test('heartbeat persistence failure is fail-soft after a successful scan', async () => {
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_TRIGGER_EVENT: 'workflow_dispatch',
    MONITOR_TRIGGER_SCHEDULE: '',
    MONITOR_LOOP_ITERATIONS: '1',
  }, {
    gate: async () => false,
    runCommand: async () => {},
    recordHeartbeat: async () => { throw new Error('temporary DB failure'); },
    sleep: async () => {},
  });

  assert.deepEqual(result, { iterations: 1, monitorRuns: 1, dependenciesInstalled: true });
});

test('only the first non-intensive iteration is forced', () => {
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '0 */3 * * *', iteration: 0 }), true);
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '0 */3 * * *', iteration: 1 }), false);
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '*/15 * * * *', iteration: 0 }), false);
  assert.equal(forceFirstMonitor({ eventName: 'workflow_dispatch', schedule: '', iteration: 0 }), true);
});
