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

test('closed intensive loop performs only four gate reads', async () => {
  let gateCalls = 0;
  const commands = [];
  const sleeps = [];
  const result = await runMonitorLoop(BASE_ENV, {
    gate: async () => { gateCalls += 1; return false; },
    runCommand: async (...args) => { commands.push(args); },
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(gateCalls, 4);
  assert.deepEqual(commands, []);
  assert.deepEqual(sleeps, [1, 1, 1]);
  assert.deepEqual(result, { iterations: 4, monitorRuns: 0, dependenciesInstalled: false });
});

test('open loop installs once and runs the monitor on every iteration', async () => {
  const commands = [];
  const result = await runMonitorLoop(BASE_ENV, {
    gate: async () => true,
    runCommand: async (command, args) => { commands.push([command, ...args]); },
    sleep: async () => {},
  });

  assert.deepEqual(commands, [
    ['npm', 'install', '--ignore-scripts'],
    ['npm', 'start'],
    ['npm', 'start'],
    ['npm', 'start'],
    ['npm', 'start'],
  ]);
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
    sleep: async () => {},
  });

  assert.equal(starts, 4);
  assert.equal(result.monitorRuns, 4);
});

test('only the first non-intensive iteration is forced', () => {
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '0 */3 * * *', iteration: 0 }), true);
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '0 */3 * * *', iteration: 1 }), false);
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '*/15 * * * *', iteration: 0 }), false);
  assert.equal(forceFirstMonitor({ eventName: 'workflow_dispatch', schedule: '', iteration: 0 }), true);
});
