import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasRecentNegativeAlerts } from './intensive-gate.js';
import { recordMonitorScanHeartbeat } from './monitor-scan-heartbeat.js';
import { chainNextMonitor, isMonitorChainFloorRun, isMonitorChainRun } from './monitor-chain.js';

const MINUTE = 60 * 1000;
const GATE_ONLY_SCHEDULES = new Set([
  '*/15 * * * *',
  '9,39 6-16 * * *',
]);

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(' ')} failed (${signal || code})`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function forceFirstMonitor({ eventName, schedule, iteration, chainRun = false, floorRun = false }) {
  return iteration === 0 && (
    floorRun
    || (!chainRun && (eventName !== 'schedule' || !GATE_ONLY_SCHEDULES.has(schedule)))
  );
}

export async function runMonitorLoop(env = process.env, options = {}) {
  const iterations = positiveInt(env.MONITOR_LOOP_ITERATIONS, env.MONITOR_TRIGGER_EVENT === 'schedule' ? 4 : 1);
  const intervalMs = positiveInt(env.MONITOR_LOOP_INTERVAL_MS, 15 * MINUTE);
  const eventName = String(env.MONITOR_TRIGGER_EVENT || '').trim();
  const schedule = String(env.MONITOR_TRIGGER_SCHEDULE || '').trim();
  const chainRun = isMonitorChainRun(env);
  const floorRun = isMonitorChainFloorRun(env);
  // 소유채널이 YouTube의 "모든 댓글 보류" 모드일 때 정상 댓글 공개도 15분 SLA를 갖는다.
  // 부정댓글 intensive gate와 독립적으로 루프를 유지하되, 전체 스캔까지 강제로 돌리지는 않는다.
  const heldReviewEnabled = Boolean(String(env.HELD_REVIEW_CHANNELS || '').trim());
  // 분류된 소유채널 악플 숨김과 사람 오탐 공개복원도 GitHub cron 대신 같은 15분 루프에서 실행한다.
  // 실행 스위치는 워크플로가 명시적으로 켜며, 기존 모더레이션 대상 조건은 각 본체가 그대로 지킨다.
  const pendingHideEnabled = truthy(env.YOUTUBE_OWNER_PENDING_HIDE_LOOP);
  const keepAuxiliaryLoopAlive = heldReviewEnabled || pendingHideEnabled;
  const coverageLoop = eventName === 'schedule' || chainRun;
  const gateConfig = {
    supabaseUrl: String(env.SUPABASE_URL || '').trim(),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  };
  const gate = options.gate || ((config) => hasRecentNegativeAlerts(config));
  const execute = options.runCommand || runCommand;
  const sleep = options.sleep || delay;
  const reviewHeld = options.runHeldReview || ((reviewEnv) => runCommand(
    process.execPath,
    ['src/youtube-owner-held-review.js'],
    reviewEnv,
  ));
  const recordHeldOutcome = options.recordHeldReviewOutcome || ((outcome, reason) => runCommand(
    process.execPath,
    ['src/record-auxiliary-outcome.js'],
    {
      ...env,
      AUXILIARY_HEALTH_KEY: 'youtube_owner_held_review',
      AUXILIARY_OUTCOME: outcome,
      AUXILIARY_FAILURE_THRESHOLD: '2',
      AUXILIARY_ALERT_COOLDOWN_HOURS: '12',
      AUXILIARY_COMPONENT: 'YouTube 소유채널 보류 댓글 공개 봇',
      AUXILIARY_REASON: reason,
      FAILURE_RUN_URL: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : '',
    },
  ));
  const hidePending = options.runPendingHide || ((pendingEnv) => runCommand(
    'npm',
    ['run', 'hide:youtube-owner-pending'],
    pendingEnv,
  ));
  const restoreFalsePositives = options.runFalsePositiveRestore || ((restoreEnv) => runCommand(
    'npm',
    ['run', 'restore:youtube-false-positives'],
    restoreEnv,
  ));
  const recordPendingOutcome = options.recordPendingHideOutcome || ((outcome, reason) => runCommand(
    process.execPath,
    ['src/record-auxiliary-outcome.js'],
    {
      ...env,
      AUXILIARY_HEALTH_KEY: 'youtube_owner_pending_hide',
      AUXILIARY_OUTCOME: outcome,
      AUXILIARY_FAILURE_THRESHOLD: '3',
      AUXILIARY_ALERT_COOLDOWN_HOURS: '24',
      AUXILIARY_COMPONENT: 'YouTube 소유채널 15분 자동숨김',
      AUXILIARY_REASON: reason,
      FAILURE_RUN_URL: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : '',
    },
  ));
  const recordRestoreOutcome = options.recordFalsePositiveRestoreOutcome || ((outcome, reason) => runCommand(
    process.execPath,
    ['src/record-auxiliary-outcome.js'],
    {
      ...env,
      AUXILIARY_HEALTH_KEY: 'youtube_owner_fp_restore',
      AUXILIARY_OUTCOME: outcome,
      AUXILIARY_FAILURE_THRESHOLD: '3',
      AUXILIARY_ALERT_COOLDOWN_HOURS: '24',
      AUXILIARY_COMPONENT: 'YouTube 오탐 댓글 자동 공개복원',
      AUXILIARY_REASON: reason,
      FAILURE_RUN_URL: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : '',
    },
  ));
  const recordHeartbeat = options.recordHeartbeat || ((details) => recordMonitorScanHeartbeat(gateConfig, details));
  const chain = options.chain || ((details) => chainNextMonitor(env, details));
  const now = options.now || Date.now;
  let dependenciesInstalled = false;
  let monitorRuns = 0;
  let verifiedGateOpen = false;
  let lastScannedAt = null;
  let heldReviewRuns = 0;
  let heldReviewFailures = 0;
  let pendingHideRuns = 0;
  let pendingHideFailures = 0;
  let falsePositiveRestoreRuns = 0;
  let falsePositiveRestoreFailures = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let gateOpen = false;
    let gateState = 'closed';
    try {
      gateOpen = await gate(gateConfig);
      gateState = gateOpen ? 'open' : 'closed';
      verifiedGateOpen = gateOpen;
    } catch (error) {
      gateOpen = true;
      gateState = 'fail-open';
      verifiedGateOpen = false;
      console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} gate_error=${error.message}`);
    }

    const forced = forceFirstMonitor({ eventName, schedule, iteration, chainRun, floorRun });
    const shouldRun = forced || gateOpen;
    console.error(
      `[monitor-loop] iteration=${iteration + 1}/${iterations} gate=${gateState} forced=${forced} decision=${shouldRun ? 'run' : 'skip'}`,
    );

    if (shouldRun || keepAuxiliaryLoopAlive) {
      if (!dependenciesInstalled) {
        console.error('[monitor-loop] installing dependencies once before the first runnable task');
        await execute('npm', ['install', '--ignore-scripts'], env);
        dependenciesInstalled = true;
      }
    }

    if (heldReviewEnabled) {
      let heldOutcome = 'success';
      let heldReason = '15분 루프 정상';
      try {
        // 워크플로가 false로 고정해 전달한다. 방어적으로 여기서도 false를 강제해 15분 루프가
        // 실수로 dry-run만 반복하지 않게 한다. 시작시각·판정실패 fail-closed는 본체가 지킨다.
        await reviewHeld({ ...env, HELD_REVIEW_DRY_RUN: 'false' });
        heldReviewRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} held_review=success`);
      } catch (error) {
        // 정상 댓글 공개 지연은 생기더라도 핵심 수집을 죽이지 않는다. 후보는 원장에 기록되지 않아
        // 다음 15분 회차에서 다시 판정되며, 실패 중에는 어떤 댓글도 공개하지 않는다.
        heldReviewFailures += 1;
        heldOutcome = 'failure';
        heldReason = `15분 루프 실패: ${String(error.message || error).slice(0, 160)}`;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} held_review=failure error=${error.message}`);
      }
      try {
        await recordHeldOutcome(heldOutcome, heldReason);
      } catch (error) {
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} held_review_health_write=failure error=${error.message}`);
      }
    }

    if (pendingHideEnabled) {
      let hideOutcome = 'success';
      let hideReason = '15분 루프 정상';
      try {
        await hidePending({
          ...env,
          YOUTUBE_OWNER_BULK_HIDE_DRY_RUN: 'false',
          YOUTUBE_OWNER_BULK_HIDE_CONFIRM: 'HIDE_ALL_YOUTUBE_AD_ALERTS',
          YOUTUBE_OWNER_ALERT_SCOPE: 'organic_satellite',
          YOUTUBE_OWNER_BULK_HIDE_BATCH_SIZE: '50',
          YOUTUBE_OWNER_HIDE_VERIFY_ATTEMPTS: '5',
          YOUTUBE_OWNER_HIDE_VERIFY_DELAY_MS: '3000',
          YOUTUBE_OWNER_BULK_HIDE_ACTOR: 'youtube-owner-pending-auto-hide',
        });
        pendingHideRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} pending_hide=success`);
      } catch (error) {
        pendingHideFailures += 1;
        hideOutcome = 'failure';
        hideReason = `15분 루프 실패: ${String(error.message || error).slice(0, 160)}`;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} pending_hide=failure error=${error.message}`);
      }
      try {
        await recordPendingOutcome(hideOutcome, hideReason);
      } catch (error) {
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} pending_hide_health_write=failure error=${error.message}`);
      }

      let restoreOutcome = 'success';
      let restoreReason = '15분 루프 정상';
      try {
        await restoreFalsePositives({
          ...env,
          YOUTUBE_FP_AUTO_RESTORE: 'AUTO_RESTORE_YOUTUBE_FALSE_POSITIVES',
          YOUTUBE_FP_AUTO_RESTORE_LOOKBACK_HOURS: '72',
          YOUTUBE_FP_AUTO_RESTORE_MAX_ROWS: '100',
          YOUTUBE_RESTORE_VERIFY_ATTEMPTS: '5',
          YOUTUBE_RESTORE_VERIFY_DELAY_MS: '3000',
        });
        falsePositiveRestoreRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} fp_restore=success`);
      } catch (error) {
        falsePositiveRestoreFailures += 1;
        restoreOutcome = 'failure';
        restoreReason = `15분 루프 실패: ${String(error.message || error).slice(0, 160)}`;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} fp_restore=failure error=${error.message}`);
      }
      try {
        await recordRestoreOutcome(restoreOutcome, restoreReason);
      } catch (error) {
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} fp_restore_health_write=failure error=${error.message}`);
      }
    }

    if (shouldRun) {
      await execute('npm', ['start'], env);
      monitorRuns += 1;
      try {
        const scannedAt = now();
        lastScannedAt = scannedAt;
        await recordHeartbeat({
          scannedAt,
          runId: env.GITHUB_RUN_ID,
          runAttempt: env.GITHUB_RUN_ATTEMPT,
          iteration: iteration + 1,
          triggerEvent: eventName,
          triggerSchedule: schedule,
        });
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} scan_heartbeat=${new Date(scannedAt).toISOString()}`);
      } catch (error) {
        // The scan itself succeeded. Heartbeat persistence must never turn a healthy
        // collection into a failed collection; the watchdog falls back to run starts.
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} heartbeat_write_error=${error.message}`);
      }
    } else {
      console.error(
        `[monitor-loop] iteration=${iteration + 1}/${iterations} gate_supabase_get=1 monitor_external_api_calls=0`,
      );
    }

    if (iteration + 1 < iterations) {
      if (coverageLoop && !gateOpen && !keepAuxiliaryLoopAlive) {
        console.error('[monitor-loop] intensive gate closed; ending loop early so floor/backup schedules are not blocked');
        break;
      }
      console.error(`[monitor-loop] sleeping ${Math.round(intervalMs / MINUTE)} minutes before the next gate check`);
      await sleep(intervalMs);
    }
  }

  let chainResult = { dispatched: false, reason: 'not-attempted' };
  try {
    chainResult = await chain({
      gateOpen: verifiedGateOpen,
      ...(keepAuxiliaryLoopAlive ? { keepAlive: true } : {}),
      scannedThisRun: monitorRuns > 0,
      lastScannedAt,
      now: now(),
    });
  } catch (error) {
    // 체인 실패는 기존 크론/heartbeat가 복구한다. 정상 수집을 실패로 뒤집지 않는다.
    chainResult = { dispatched: false, reason: 'chain-error', error: error.message };
  }
  console.error(
    `[monitor-loop] complete iterations=${iterations} full_scans=${monitorRuns}`
      + ` held_review_runs=${heldReviewRuns} held_review_failures=${heldReviewFailures}`
      + ` pending_hide_runs=${pendingHideRuns} pending_hide_failures=${pendingHideFailures}`
      + ` fp_restore_runs=${falsePositiveRestoreRuns} fp_restore_failures=${falsePositiveRestoreFailures}`
      + ` chain=${chainResult.reason}`,
  );
  return {
    iterations,
    monitorRuns,
    dependenciesInstalled,
    ...(heldReviewEnabled ? { heldReviewRuns, heldReviewFailures } : {}),
    ...(pendingHideEnabled ? {
      pendingHideRuns,
      pendingHideFailures,
      falsePositiveRestoreRuns,
      falsePositiveRestoreFailures,
    } : {}),
    chain: chainResult,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMonitorLoop().catch((error) => {
    console.error(`[monitor-loop] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
