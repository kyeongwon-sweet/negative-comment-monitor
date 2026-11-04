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
    latestScan: async () => Date.parse('2026-10-30T02:00:00Z'), // 1시간 전 스캔 → floor 미도래
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
  assert.ok(reviews.every((reviewEnv) => reviewEnv.HELD_REVIEW_MAX_PAGES === '1'));
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

test('held-review 15분 루프 페이지 상한은 전용 변수로만 조정한다', async () => {
  const reviews = [];
  await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_LOOP_ITERATIONS: '1',
    HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z',
    HELD_REVIEW_MAX_PAGES: '20',
    HELD_REVIEW_LOOP_MAX_PAGES: '2',
  }, {
    gate: async () => false,
    latestScan: async () => Date.now(),
    runCommand: async () => {},
    runHeldReview: async (reviewEnv) => { reviews.push(reviewEnv); },
    recordHeldReviewOutcome: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
  });

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].HELD_REVIEW_MAX_PAGES, '2', '단독 잡의 깊은 검사 기본값과 분리');
});

// 11-01 00:37→04:30 KST: keepAlive 루프가 게이트 닫힘으로 4회 연속 스캔 없이 이어져 3h53m 무스캔 공백.
test('keepAlive 루프도 마지막 실제 스캔이 floor(150분) 지나면 한 번 스캔하고, 같은 run에선 다시 강제하지 않는다', async () => {
  const commands = [];
  const heartbeats = [];
  const now = Date.parse('2026-10-31T18:00:00Z');
  const result = await runMonitorLoop({
    ...BASE_ENV,
    HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z',
  }, {
    gate: async () => false,
    latestScan: async () => Date.parse('2026-10-31T15:29:00Z'),
    runCommand: async (command, args) => { commands.push([command, ...args]); },
    runHeldReview: async () => {},
    recordHeldReviewOutcome: async () => {},
    recordHeartbeat: async (details) => { heartbeats.push(details); },
    sleep: async () => {},
    now: () => now + 9 * 60 * 1000, // 마지막 스캔 후 151분
    chain: async () => disabledChain,
  });

  assert.equal(result.monitorRuns, 1, 'floor 도래 시 1회만 스캔');
  assert.deepEqual(heartbeats.map((h) => h.iteration), [1]);
  assert.deepEqual(commands.filter(([, a]) => a === 'start').length, 1);
});

test('keepAlive 루프에서 floor 미도래면 스캔하지 않는다', async () => {
  const now = Date.parse('2026-10-31T18:00:00Z');
  const result = await runMonitorLoop({ ...BASE_ENV, HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z' }, {
    gate: async () => false,
    latestScan: async () => now - 149 * 60 * 1000,
    runCommand: async () => {},
    runHeldReview: async () => {},
    recordHeldReviewOutcome: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
    now: () => now,
    chain: async () => disabledChain,
  });
  assert.equal(result.monitorRuns, 0);
});

test('keepAlive 루프의 최신 스캔 조회가 실패하면 스캔을 강제하지 않는다(비용 폭주 방지, 워치독이 백스톱)', async () => {
  const result = await runMonitorLoop({ ...BASE_ENV, YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true' }, {
    gate: async () => false,
    latestScan: async () => { throw new Error('heartbeat read HTTP 500'); },
    runCommand: async () => {},
    runPendingHide: async () => {},
    runFalsePositiveRestore: async () => {},
    recordPendingHideOutcome: async () => {},
    recordFalsePositiveRestoreOutcome: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
    chain: async () => disabledChain,
  });
  assert.equal(result.monitorRuns, 0);
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
    latestScan: async () => Date.now(),
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
    latestScan: async () => Date.now(),
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
    latestScan: async () => Date.now(),
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

// 계약(재발방지): 보조 작업이 늘거나 트리거 방식이 바뀌어도, 마지막 스캔이 floor를 넘긴 조용한 구간에서
// run은 (a) 스스로 스캔하거나 (b) floor 경로로 갈 수 있는 chain 요청(keepAlive 아님)을 남겨야 한다.
// 11-01: keepAlive가 (b)를 막고 (a)도 안 해서 3h53m 무스캔. 새 보조 작업은 아래 AUX에 추가할 것.
test('계약: floor 지난 조용한 구간에서 어떤 보조작업·트리거 조합이든 스캔하거나 floor 체인 경로를 남긴다', async () => {
  const AUX = {
    none: {},
    held: { HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z' },
    pending: { YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true' },
    both: { HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z', YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true' },
    ownerFast: { YOUTUBE_OWNER_FAST_SCAN_LOOP: 'true' },
    all: { HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z', YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true', YOUTUBE_OWNER_FAST_SCAN_LOOP: 'true' },
  };
  const TRIGGERS = {
    quarterHourCron: { MONITOR_TRIGGER_EVENT: 'schedule', MONITOR_TRIGGER_SCHEDULE: '*/15 * * * *' },
    staggeredCron: { MONITOR_TRIGGER_EVENT: 'schedule', MONITOR_TRIGGER_SCHEDULE: '9,39 6-16 * * *' },
    chainRun: { MONITOR_TRIGGER_EVENT: 'workflow_dispatch', MONITOR_CHAIN_RUN: 'true', MONITOR_LOOP_ITERATIONS: '4' },
    floorRun: { MONITOR_TRIGGER_EVENT: 'workflow_dispatch', MONITOR_CHAIN_RUN: 'true', MONITOR_CHAIN_FLOOR_RUN: 'true', MONITOR_LOOP_ITERATIONS: '4' },
  };
  const now = Date.parse('2026-11-01T18:00:00Z');
  for (const [auxName, auxEnv] of Object.entries(AUX)) {
    for (const [triggerName, triggerEnv] of Object.entries(TRIGGERS)) {
      const chainCalls = [];
      const result = await runMonitorLoop({ ...BASE_ENV, ...triggerEnv, ...auxEnv }, {
        gate: async () => false,
        latestScan: async () => now - 200 * 60 * 1000,
        runCommand: async () => {},
        runHeldReview: async () => {},
        recordHeldReviewOutcome: async () => {},
        runPendingHide: async () => {},
        runFalsePositiveRestore: async () => {},
        recordPendingHideOutcome: async () => {},
        recordFalsePositiveRestoreOutcome: async () => {},
        runOwnerFastScan: async () => {},
        recordOwnerFastScanOutcome: async () => {},
        recordHeartbeat: async () => {},
        sleep: async () => {},
        now: () => now,
        chain: async (details) => { chainCalls.push(details); return disabledChain; },
      });
      const floorChainPossible = chainCalls.length === 1 && !chainCalls[0].keepAlive;
      assert.ok(
        result.monitorRuns >= 1 || floorChainPossible,
        `${auxName}×${triggerName}: 스캔 0회인데 floor 경로도 막힘(chain=${JSON.stringify(chainCalls)})`,
      );
    }
  }
});

test('소유채널 빠른 감시: 매 회차 자동숨김보다 먼저 돌고, 강한 모델 설정은 이 잡에만 넘긴다', async () => {
  const order = [];
  const scanEnvs = [];
  const outcomes = [];
  const result = await runMonitorLoop({
    ...BASE_ENV,
    MONITOR_LOOP_ITERATIONS: '2',
    YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true',
    YOUTUBE_OWNER_FAST_SCAN_LOOP: 'true',
    YOUTUBE_OWNER_FAST_ESCALATION_MODEL: 'gemini-3.5-flash-lite',
  }, {
    gate: async () => false,
    latestScan: async () => Date.now(),
    runCommand: async (command, args, env) => { if (args?.[0] === 'start') order.push(`start:${env?.OWNED_BRAND_ESCALATION_MODEL || ''}`); },
    runOwnerFastScan: async (env) => { order.push('fast'); scanEnvs.push(env); },
    recordOwnerFastScanOutcome: async (...args) => { outcomes.push(args); },
    runPendingHide: async () => { order.push('hide'); },
    runFalsePositiveRestore: async () => {},
    recordPendingHideOutcome: async () => {},
    recordFalsePositiveRestoreOutcome: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
    chain: async () => disabledChain,
  });
  assert.deepEqual(order, ['fast', 'hide', 'fast', 'hide']);
  assert.ok(scanEnvs.every((env) => env.OWNED_BRAND_ESCALATION_MODEL === 'gemini-3.5-flash-lite'));
  assert.deepEqual(outcomes, [['success', '15분 루프 정상'], ['success', '15분 루프 정상']]);
  assert.equal(result.ownerFastScanRuns, 2);
  assert.equal(result.ownerFastScanFailures, 0);
});

test('소유채널 빠른 감시 실패는 자동숨김·핵심 수집을 막지 않고 건강 원장에 실패로 남긴다', async () => {
  const order = [];
  const outcomes = [];
  const result = await runMonitorLoop({ ...BASE_ENV, MONITOR_LOOP_ITERATIONS: '1', YOUTUBE_OWNER_PENDING_HIDE_LOOP: 'true', YOUTUBE_OWNER_FAST_SCAN_LOOP: 'true' }, {
    gate: async () => false,
    latestScan: async () => Date.now(),
    runCommand: async () => {},
    runOwnerFastScan: async () => { throw new Error('quotaExceeded'); },
    recordOwnerFastScanOutcome: async (...args) => { outcomes.push(args); },
    runPendingHide: async () => { order.push('hide'); },
    runFalsePositiveRestore: async () => {},
    recordPendingHideOutcome: async () => {},
    recordFalsePositiveRestoreOutcome: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
    chain: async () => disabledChain,
  });
  assert.deepEqual(order, ['hide']);
  assert.equal(outcomes[0][0], 'failure');
  assert.match(outcomes[0][1], /quotaExceeded/);
  assert.equal(result.ownerFastScanFailures, 1);
});

// 11-03: 수정 배포 후에도 이미 돌던 run이 옛 코드로 끝까지 돌아 같은 오탐을 두 번 더 냈다.
test('master에 새 코드가 배포되면 다음 회차부터 돌지 않고 끝내 체인이 새 코드 run을 잇는다', async () => {
  const iterationsRun = [];
  const chainCalls = [];
  let staleChecks = 0;
  const result = await runMonitorLoop({ ...BASE_ENV, HELD_REVIEW_CHANNELS: 'UCOWNER@2026-10-29T02:32:00Z' }, {
    gate: async () => false,
    latestScan: async () => Date.now(),
    runCommand: async () => {},
    runHeldReview: async () => { iterationsRun.push('held'); },
    recordHeldReviewOutcome: async () => {},
    recordHeartbeat: async () => {},
    sleep: async () => {},
    codeIsStale: async () => { staleChecks += 1; return staleChecks >= 2; }, // 2회차 시작 전엔 아직, 3회차 전에 배포됨
    chain: async (details) => { chainCalls.push(details); return { dispatched: true, reason: 'queued' }; },
  });
  assert.equal(iterationsRun.length, 2, '1·2회차만 돌고 3회차 전에 종료');
  assert.equal(result.endedForNewCode, true);
  assert.equal(chainCalls.length, 1, '끝내도 체인은 반드시 다음 run을 요청');
  assert.equal(chainCalls[0].keepAlive, true);
});

test('runCodeIsStale: 최신 커밋과 다를 때만 true, 정보 없음·조회 실패는 false(계속 진행)', async () => {
  const { runCodeIsStale } = await import('../src/monitor-loop.js');
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'a'.repeat(40), GH_TOKEN: 't', GITHUB_REF_NAME: 'master' };
  const text = (body, ok = true) => async () => ({ ok, text: async () => body });
  assert.equal(await runCodeIsStale(env, text('b'.repeat(40))), true);
  assert.equal(await runCodeIsStale(env, text('a'.repeat(40))), false);
  assert.equal(await runCodeIsStale(env, text('', false)), false);
  assert.equal(await runCodeIsStale(env, async () => { throw new Error('net'); }), false);
  assert.equal(await runCodeIsStale({ ...env, GH_TOKEN: '' }, text('b'.repeat(40))), false);
});

// 11-04: 핵심 스캔 1회 실패가 루프를 즉시 끝내 다음 실행 체인이 끊겼고(크론도 드롭) 감시가 2시간+ 멈췄다.
test('핵심 스캔이 실패해도 남은 회차를 재시도하고 체인을 이은 뒤에 실패로 끝낸다', async () => {
  const commands = [];
  const heartbeats = [];
  let chainCalls = 0;
  let starts = 0;
  await assert.rejects(runMonitorLoop(BASE_ENV, {
    gate: async () => true,
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (args[0] === 'start' && (starts += 1) === 1) throw new Error('npm start failed (1)');
    },
    recordHeartbeat: async (details) => { heartbeats.push(details); },
    chain: async () => { chainCalls += 1; return { dispatched: true, reason: 'dispatched' }; },
    now: () => Date.parse('2026-09-21T07:50:00Z'),
    sleep: async () => {},
  }), (error) => {
    assert.match(error.message, /npm start failed \(1\)/);
    assert.match(error.message, /scan_failures=1\/4/);
    assert.match(error.message, /chain=dispatched/);
    return true;
  });
  assert.equal(starts, 4, '실패 뒤에도 남은 회차를 계속 스캔');
  assert.equal(chainCalls, 1, '실패해도 다음 실행 체인은 이어진다');
  assert.deepEqual(heartbeats.map((h) => h.iteration), [2, 3, 4], '실패한 회차는 스캔 heartbeat를 남기지 않는다');
});
