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

const disabledChain = { dispatched: false, reason: 'disabled' };

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
  assert.deepEqual(result, { iterations: 4, monitorRuns: 0, dependenciesInstalled: false, chain: disabledChain });
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
  assert.deepEqual(result, { iterations: 4, monitorRuns: 4, dependenciesInstalled: true, chain: disabledChain });
});

test('held-review keeps the 15-minute loop alive while the intensive gate is closed', async () => {
  const commands = [];
  const reviews = [];
  const outcomes = [];
  const sleeps = [];
  const chainCalls = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z',
    MONITOR_CHAIN_ENABLED: 'true',
  }, {
    gate: async () => false,
    runCommand: async (command, args) => { commands.push([command, ...args]); },
    runHeldReview: async (reviewEnv) => { reviews.push(reviewEnv); },
    recordHeldReviewOutcome: async (...args) => { outcomes.push(args); },
    recordHeartbeat: async () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => Date.parse('2026-10-30T03:00:00Z'),
    chain: async (details) => {
      chainCalls.push(details);
      return { dispatched: true, reason: 'queued' };
    },
  });

  assert.deepEqual(commands, [['npm', 'install', '--ignore-scripts']]);
  assert.equal(reviews.length, 4);
  assert.ok(reviews.every((reviewEnv) => reviewEnv.HELD_REVIEW_DRY_RUN === 'false'));
  assert.deepEqual(outcomes, Array.from({ length: 4 }, () => ['success', '15분 루프 정상']));
  assert.deepEqual(sleeps, [1, 1, 1]);
  assert.deepEqual(chainCalls, [{
    gateOpen: false,
    keepAlive: true,
    scannedThisRun: false,
    lastScannedAt: null,
    now: Date.parse('2026-10-30T03:00:00Z'),
  }]);
  assert.deepEqual(result, {
    iterations: 4,
    monitorRuns: 0,
    dependenciesInstalled: true,
    heldReviewRuns: 4,
    heldReviewFailures: 0,
    chain: { dispatched: true, reason: 'queued' },
  });
});

test('held-review failure publishes nothing, stays fail-soft, and is retried next iteration', async () => {
  let attempts = 0;
  const outcomes = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_LOOP_ITERATIONS: '2',
    HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z',
  }, {
    gate: async () => false,
    runCommand: async () => {},
    runHeldReview: async () => { attempts += 1; throw new Error('LLM unavailable'); },
    recordHeldReviewOutcome: async (...args) => { outcomes.push(args); },
    recordHeartbeat: async () => {},
    sleep: async () => {},
  });

  assert.equal(attempts, 2);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every(([outcome, reason]) => outcome === 'failure' && reason.includes('LLM unavailable')));
  assert.equal(result.monitorRuns, 0);
  assert.equal(result.heldReviewRuns, 0);
  assert.equal(result.heldReviewFailures, 2);
});

test('pending-hide와 오탐 복원은 intensive gate와 무관하게 매 iteration 실행된다', async () => {
  const hides = [];
  const restores = [];
  const hideOutcomes = [];
  const restoreOutcomes = [];
  const chainCalls = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_LOOP_ITERATIONS: '2',
    YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true',
  }, {
    gate: async () => false,
    runCommand: async () => {},
    runPendingHide: async (pendingEnv) => { hides.push(pendingEnv); },
    runFalsePositiveRestore: async (restoreEnv) => { restores.push(restoreEnv); },
    recordPendingHideOutcome: async (...args) => { hideOutcomes.push(args); },
    recordFalsePositiveRestoreOutcome: async (...args) => { restoreOutcomes.push(args); },
    recordHeartbeat: async () => {},
    sleep: async () => {},
    chain: async (details) => { chainCalls.push(details); return disabledChain; },
  });

  assert.equal(hides.length, 2);
  assert.ok(hides.every((pendingEnv) => (
    pendingEnv.YOUTUBE_OWNER_BULK_HIDE_DRY_RUN === 'false'
    && pendingEnv.YOUTUBE_OWNER_BULK_HIDE_CONFIRM === 'HIDE_ALL_YOUTUBE_AD_ALERTS'
    && pendingEnv.YOUTUBE_OWNER_BULK_HIDE_ACTOR === 'youtube-owner-pending-auto-hide'
  )));
  assert.equal(restores.length, 2);
  assert.ok(restores.every((restoreEnv) => restoreEnv.YOUTUBE_FP_AUTO_RESTORE === 'AUTO_RESTORE_YOUTUBE_FALSE_POSITIVES'));
  assert.deepEqual(hideOutcomes, [['success', '15분 루프 정상'], ['success', '15분 루프 정상']]);
  assert.deepEqual(restoreOutcomes, [['success', '15분 루프 정상'], ['success', '15분 루프 정상']]);
  assert.equal(chainCalls[0].keepAlive, true);
  assert.equal(result.pendingHideRuns, 2);
  assert.equal(result.pendingHideFailures, 0);
  assert.equal(result.falsePositiveRestoreRuns, 2);
  assert.equal(result.falsePositiveRestoreFailures, 0);
});

test('pending-hide 실패는 핵심 수집을 죽이지 않고 건강 원장에 실패로 남긴다', async () => {
  const outcomes = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_LOOP_ITERATIONS: '1',
    YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true',
  }, {
    gate: async () => false,
    runCommand: async () => {},
    runPendingHide: async () => { throw new Error('owner OAuth unavailable'); },
    runFalsePositiveRestore: async () => {},
    recordPendingHideOutcome: async (...args) => { outcomes.push(args); },
    recordFalsePositiveRestoreOutcome: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
  });

  assert.equal(result.monitorRuns, 0);
  assert.equal(result.pendingHideRuns, 0);
  assert.equal(result.pendingHideFailures, 1);
  assert.equal(outcomes[0][0], 'failure');
  assert.match(outcomes[0][1], /owner OAuth unavailable/);
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

  assert.deepEqual(result, { iterations: 1, monitorRuns: 1, dependenciesInstalled: true, chain: disabledChain });
});

test('verified-open scheduled loop queues exactly one guarded continuation', async () => {
  const chainCalls = [];
  const result = await runMonitorLoop({ ...BASE_ENV, MONITOR_CHAIN_ENABLED: 'true' }, {
    gate: async () => true,
    runCommand: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
    now: () => Date.parse('2026-09-22T03:00:00Z'),
    chain: async (details) => {
      chainCalls.push(details);
      return { dispatched: true, reason: 'queued' };
    },
  });

  assert.equal(chainCalls.length, 1);
  assert.deepEqual(chainCalls[0], {
    gateOpen: true,
    scannedThisRun: true,
    lastScannedAt: Date.parse('2026-09-22T03:00:00Z'),
    now: Date.parse('2026-09-22T03:00:00Z'),
  });
  assert.deepEqual(result.chain, { dispatched: true, reason: 'queued' });
});

test('chain continuation does not force a scan after the intensive gate closes', async () => {
  const commands = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_TRIGGER_EVENT: 'workflow_dispatch',
    MONITOR_TRIGGER_SCHEDULE: '',
    MONITOR_CHAIN_RUN: 'true',
    MONITOR_CHAIN_ENABLED: 'true',
  }, {
    gate: async () => false,
    runCommand: async (...args) => { commands.push(args); },
    recordHeartbeat: async () => {},
    sleep: async () => {},
    chain: async ({ gateOpen }) => ({ dispatched: false, reason: gateOpen ? 'unexpected' : 'gate-closed' }),
  });

  assert.deepEqual(commands, []);
  assert.equal(result.monitorRuns, 0);
  assert.deepEqual(result.chain, { dispatched: false, reason: 'gate-closed' });
});

test('floor-chain continuation forces exactly one scan while the intensive gate is closed', async () => {
  const commands = [];
  const heartbeats = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_TRIGGER_EVENT: 'workflow_dispatch',
    MONITOR_TRIGGER_SCHEDULE: '',
    MONITOR_CHAIN_RUN: 'true',
    MONITOR_CHAIN_FLOOR_RUN: 'true',
    MONITOR_CHAIN_ENABLED: 'true',
  }, {
    gate: async () => false,
    runCommand: async (command, args) => { commands.push([command, ...args]); },
    recordHeartbeat: async (details) => { heartbeats.push(details); },
    sleep: async () => {},
    chain: async () => ({ dispatched: false, reason: 'floor-not-due' }),
  });

  assert.equal(result.monitorRuns, 1);
  assert.deepEqual(commands, [
    ['npm', 'install', '--ignore-scripts'],
    ['npm', 'start'],
  ]);
  assert.equal(heartbeats.length, 1);
  assert.deepEqual(result.chain, { dispatched: false, reason: 'floor-not-due' });
});

test('chain failure is fail-soft and does not flip a successful scan to failure', async () => {
  const result = await runMonitorLoop({ ...BASE_ENV, MONITOR_CHAIN_ENABLED: 'true' }, {
    gate: async () => true,
    runCommand: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
    chain: async () => { throw new Error('GitHub temporarily unavailable'); },
  });

  assert.equal(result.monitorRuns, 4);
  assert.deepEqual(result.chain, {
    dispatched: false,
    reason: 'chain-error',
    error: 'GitHub temporarily unavailable',
  });
});

test('only the first non-intensive iteration is forced', () => {
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '0 */3 * * *', iteration: 0 }), true);
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '0 */3 * * *', iteration: 1 }), false);
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '*/15 * * * *', iteration: 0 }), false);
  assert.equal(forceFirstMonitor({ eventName: 'schedule', schedule: '9,39 6-16 * * *', iteration: 0 }), false);
  assert.equal(forceFirstMonitor({ eventName: 'workflow_dispatch', schedule: '', iteration: 0 }), true);
  assert.equal(forceFirstMonitor({ eventName: 'workflow_dispatch', schedule: '', iteration: 0, chainRun: true }), false);
  assert.equal(forceFirstMonitor({
    eventName: 'workflow_dispatch', schedule: '', iteration: 0, chainRun: true, floorRun: true,
  }), true);
});
