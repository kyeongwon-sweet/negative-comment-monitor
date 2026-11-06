import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasRecentNegativeAlerts } from './intensive-gate.js';
import { fetchLatestMonitorScanHeartbeat, recordMonitorScanHeartbeat } from './monitor-scan-heartbeat.js';
import {
  chainNextMonitor,
  DEFAULT_MONITOR_CHAIN_FLOOR_MINUTES,
  isMonitorChainFloorRun,
  isMonitorChainRun,
  MONITOR_WATCHDOG_MAX_GAP_MINUTES,
} from './monitor-chain.js';
import {
  claimQuotaPacingSlot,
  nextQuotaResetKst,
  youtubeQuotaConservationPlan,
  youtubeQuotaUsage,
} from './youtube-quota-meter.js';

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

// 이 run의 코드(GITHUB_SHA)가 브랜치 최신 커밋과 다른가. 토큰·저장소 정보가 없거나 조회가 실패하면 false.
export async function runCodeIsStale(env = process.env, fetchImpl = fetch) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const sha = String(env.GITHUB_SHA || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  if (!repo || !sha || !token) return false;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.sha', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) return false;
    const latest = String(await response.text()).trim();
    return /^[0-9a-f]{40}$/i.test(latest) && latest.toLowerCase() !== sha.toLowerCase();
  } catch {
    return false;
  }
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
  // 소유채널 빠른 감시(채널당 최신 스레드 1페이지): 3시간 크론이 5~7시간으로 밀려 부정이 오래 공개되던 공백을
  // 15분으로 줄인다(11-03). 자동숨김(pending-hide)보다 먼저 돌아 같은 회차에 숨겨지게 한다.
  const ownerFastScanEnabled = truthy(env.YOUTUBE_OWNER_FAST_SCAN_LOOP);
  const keepAuxiliaryLoopAlive = heldReviewEnabled || pendingHideEnabled || ownerFastScanEnabled;
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
  const fastScanOwners = options.runOwnerFastScan || ((scanEnv) => runCommand(
    'npm',
    ['run', 'scan:youtube-owner-fast'],
    scanEnv,
  ));
  const recordFastScanOutcome = options.recordOwnerFastScanOutcome || ((outcome, reason) => runCommand(
    process.execPath,
    ['src/record-auxiliary-outcome.js'],
    {
      ...env,
      AUXILIARY_HEALTH_KEY: 'youtube_owner_fast_scan',
      AUXILIARY_OUTCOME: outcome,
      AUXILIARY_FAILURE_THRESHOLD: '3',
      AUXILIARY_ALERT_COOLDOWN_HOURS: '24',
      AUXILIARY_COMPONENT: 'YouTube 소유채널 15분 빠른 감시',
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
  const latestScan = options.latestScan || (() => fetchLatestMonitorScanHeartbeat(gateConfig));
  // 보조 작업(held-review·pending-hide)이 루프를 살려두면 chain은 keepAlive로만 이어지고 floor 경로를
  // 타지 않는다. 그러면 조용한 시간엔 스캔 없이 루프만 돈다(11-01 00:37→04:30 KST 3h53m 무스캔 공백).
  // 그래서 keepAlive 루프 안에서 직접 floor를 지킨다: 마지막 실제 스캔이 floor 분 이상 지났으면 스캔한다.
  const floorMs = Math.min(
    positiveInt(env.MONITOR_CHAIN_FLOOR_MINUTES, DEFAULT_MONITOR_CHAIN_FLOOR_MINUTES),
    MONITOR_WATCHDOG_MAX_GAP_MINUTES - 1,
  ) * MINUTE;
  const chain = options.chain || ((details) => chainNextMonitor(env, details));
  const codeIsStale = options.codeIsStale || (() => runCodeIsStale(env));
  const readQuotaUsage = options.quotaUsage || (() => youtubeQuotaUsage(env));
  const claimPacingSlot = options.claimPacingSlot || ((name, minutes) => claimQuotaPacingSlot(env, name, minutes));
  let endedForNewCode = false;
  const now = options.now || Date.now;
  let dependenciesInstalled = false;
  let monitorRuns = 0;
  // 핵심 스캔(npm start) 실패는 실행을 실패로 남기되(실패 알림 유지), 남은 회차 재시도와 다음 실행 체인은 계속한다.
  // 11-04: 스캔 1회 실패가 루프를 즉시 끝내 체인이 끊겼고, 크론도 드롭돼 핵심 감시가 2시간+ 멈췄다.
  let scanFailure = null;
  let scanFailures = 0;
  let verifiedGateOpen = false;
  let lastScannedAt = null;
  let heldReviewRuns = 0;
  let heldReviewFailures = 0;
  let ownerFastScanRuns = 0;
  let ownerFastScanFailures = 0;
  let pendingHideRuns = 0;
  let pendingHideFailures = 0;
  let falsePositiveRestoreRuns = 0;
  let falsePositiveRestoreFailures = 0;
  let quotaPausedRuns = 0;

  async function quotaPlan(iteration, component) {
    try {
      const usage = await readQuotaUsage();
      const plan = youtubeQuotaConservationPlan(usage, env);
      if (usage) {
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} quota_component=${component} youtube_quota=${usage.total}/${usage.limit} ratio=${usage.ratio.toFixed(4)}${Number.isFinite(usage.projectedRatio) ? ` projected=${usage.projectedRatio.toFixed(2)}` : ""}${plan.onTrackToRunOut ? " on_track_to_run_out=true" : ""}`);
      }
      return plan;
    } catch (error) {
      // 원장 조회 장애가 실제 감시를 막으면 안 된다. 기존 계량·소진 응답이 백스톱이다.
      console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} quota_check=${component} failure=${String(error.message || error).slice(0, 160)} fail_open=true`);
      return youtubeQuotaConservationPlan(null, env);
    }
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // 진행 중인 run은 시작 시점 코드로 끝까지(최대 ~1시간) 돈다. master에 수정이 배포됐으면 남은 회차를
    // 옛 코드로 돌리지 않고 끝내, 체인이 새 코드 run을 바로 잇게 한다(11-03: 수정 배포 후에도 옛 run이
    // 같은 오탐을 두 번 더 냄). 확인 실패는 계속 진행(fail-open).
    if (iteration > 0 && await codeIsStale()) {
      endedForNewCode = true;
      console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} newer code on master; ending early so the chain runs it`);
      break;
    }
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
    let floorDue = false;
    if (!forced && !gateOpen && keepAuxiliaryLoopAlive) {
      try {
        // 이 run에서 이미 스캔했다면 그 시각, 아니면 DB 정본(monitor_scan_heartbeats) 최신 스캔.
        const lastScan = lastScannedAt ?? await latestScan();
        floorDue = lastScan == null || now() - lastScan >= floorMs;
      } catch (error) {
        // 조회 장애로 매 회차 스캔이 폭주하지 않게 강제하지 않는다. 워치독(3h)이 백스톱.
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} floor_check_error=${error.message}`);
      }
    }
    const shouldRun = forced || gateOpen || floorDue;
    console.error(
      `[monitor-loop] iteration=${iteration + 1}/${iterations} gate=${gateState} forced=${forced}`
        + `${floorDue ? ' floor_due=true' : ''} decision=${shouldRun ? 'run' : 'skip'}`,
    );

    if (shouldRun || keepAuxiliaryLoopAlive) {
      if (!dependenciesInstalled) {
        console.error('[monitor-loop] installing dependencies once before the first runnable task');
        await execute('npm', ['install', '--ignore-scripts'], env);
        dependenciesInstalled = true;
      }
    }

    if (heldReviewEnabled) {
      const plan = await quotaPlan(iteration, 'held-review');
      if (!plan.heldReview) {
        quotaPausedRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} held_review=quota-paused priority=low reset=${nextQuotaResetKst(now())}`);
      } else {
      let heldOutcome = 'success';
      let heldReason = '15분 루프 정상';
      try {
        // 워크플로가 false로 고정해 전달한다. 방어적으로 여기서도 false를 강제해 15분 루프가
        // 실수로 dry-run만 반복하지 않게 한다. 시작시각·판정실패 fail-closed는 본체가 지킨다.
        await reviewHeld({
          ...env,
          HELD_REVIEW_DRY_RUN: 'false',
          // 15분 루프는 새 댓글의 공개 지연만 줄이는 얕은 검사다. 채널마다 최대 100개면
          // 한 회차 유입을 충분히 덮으며, 과거 보류분의 깊은 추적은 단독 시간별 잡이 맡는다.
          // 기본 20페이지를 그대로 쓰면 채널 확대 시 일일 YouTube quota를 소진한다(11-04).
          HELD_REVIEW_MAX_PAGES: String(env.HELD_REVIEW_LOOP_MAX_PAGES || '1'),
        });
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
    }

    if (ownerFastScanEnabled) {
      const plan = await quotaPlan(iteration, 'owner-fast-scan');
      if (!plan.fastScan) {
        quotaPausedRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} owner_fast_scan=quota-paused priority=critical`);
      } else {
      let scanOutcome = 'success';
      let scanReason = '15분 루프 정상';
      try {
        await fastScanOwners({
          ...env,
          // 기본 60%부터는 분류·알림·pending-hide 경로는 유지하되, 정상 댓글까지 보류했다가 다시
          // 공개하는 50-unit 왕복은 멈춘다. 부정댓글 숨김용 quota를 남기는 우선순위다.
          // 11-06: 'false'로 끄면 빠른 감시가 '보류 대행 없음' 모드로 바뀌어 옛 '모두 보류 빠진 영상' 알림을
          // 사람에게 보냈다(사용자가 11-03 끈 알림). 끄지 말고 '일시 정지'로 넘겨 브레이크와 같이 조용히 멈춘다.
          YOUTUBE_OWNER_HOLD_ENFORCE: String(env.YOUTUBE_OWNER_HOLD_ENFORCE || 'true'),
          YOUTUBE_OWNER_HOLD_ENFORCE_PAUSED: plan.fastScanHoldEnforce ? '' : 'quota-plan',
          OWNED_BRAND_ESCALATION_MODEL: String(env.YOUTUBE_OWNER_FAST_ESCALATION_MODEL || env.OWNED_BRAND_ESCALATION_MODEL || '').trim(),
        });
        ownerFastScanRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} owner_fast_scan=success`);
      } catch (error) {
        // 빠른 감시 실패는 핵심 수집·숨김을 막지 않는다. 3시간 소유채널 모니터가 백스톱.
        ownerFastScanFailures += 1;
        scanOutcome = 'failure';
        scanReason = `15분 루프 실패: ${String(error.message || error).slice(0, 160)}`;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} owner_fast_scan=failure error=${error.message}`);
      }
      try {
        await recordFastScanOutcome(scanOutcome, scanReason);
      } catch (error) {
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} owner_fast_scan_health_write=failure error=${error.message}`);
      }
      }
    }

    if (pendingHideEnabled) {
      const hidePlan = await quotaPlan(iteration, 'pending-hide');
      const hideEvery = Number(hidePlan.pendingHideEveryMinutes) || 15;
      const hideSlot = hidePlan.pendingHide && hideEvery > 15
        ? await claimPacingSlot('pending-hide', hideEvery)
        : { claimed: true };
      if (!hidePlan.pendingHide) {
        quotaPausedRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} pending_hide=quota-paused priority=critical`);
      } else if (!hideSlot.claimed) {
        // 사용률이 높을 때 숨김을 30·60분 칸에 한 번만 모아서 한다(리셋 전 98% 정지 방지). 쌓인 댓글은 다음 칸에 한꺼번에.
        quotaPausedRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} pending_hide=quota-paced every=${hideEvery}m`);
      } else {
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
      }

      const restorePlan = await quotaPlan(iteration, 'fp-restore');
      if (!restorePlan.falsePositiveRestore) {
        quotaPausedRuns += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} fp_restore=quota-paused priority=low`);
      } else {
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
    }

    let scanOk = false;
    if (shouldRun) {
      try {
        await execute('npm', ['start'], env);
        scanOk = true;
      } catch (error) {
        scanFailure = error;
        scanFailures += 1;
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} scan=failure error=${error.message}`);
      }
    }
    if (shouldRun && scanOk) {
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
    } else if (!shouldRun) {
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
      + `${ownerFastScanEnabled ? ` owner_fast_scan_runs=${ownerFastScanRuns} owner_fast_scan_failures=${ownerFastScanFailures}` : ''}`
      + ` pending_hide_runs=${pendingHideRuns} pending_hide_failures=${pendingHideFailures}`
      + ` fp_restore_runs=${falsePositiveRestoreRuns} fp_restore_failures=${falsePositiveRestoreFailures}`
      + ` quota_paused_runs=${quotaPausedRuns}`
      + ` chain=${chainResult.reason}${endedForNewCode ? ' ended_for_new_code=true' : ''}`
      + `${scanFailures ? ` scan_failures=${scanFailures}` : ''}`,
  );
  // 체인을 이어 둔 뒤에 실패를 던진다 → 워크플로 실패 알림은 그대로, 다음 실행은 예정대로.
  if (scanFailure) {
    const error = new Error(`${scanFailure.message} (scan_failures=${scanFailures}/${iterations}, chain=${chainResult.reason})`);
    error.chain = chainResult;
    throw error;
  }
  return {
    iterations,
    monitorRuns,
    dependenciesInstalled,
    ...(heldReviewEnabled ? { heldReviewRuns, heldReviewFailures } : {}),
    ...(ownerFastScanEnabled ? { ownerFastScanRuns, ownerFastScanFailures } : {}),
    ...(pendingHideEnabled ? {
      pendingHideRuns,
      pendingHideFailures,
      falsePositiveRestoreRuns,
      falsePositiveRestoreFailures,
    } : {}),
    ...(quotaPausedRuns ? { quotaPausedRuns } : {}),
    chain: chainResult,
    ...(endedForNewCode ? { endedForNewCode: true } : {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMonitorLoop().catch((error) => {
    console.error(`[monitor-loop] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
