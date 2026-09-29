import { kstDateKey } from './schedule.js';
import { dispatchFloorWake, dispatchMonitor } from './monitor-dispatch.js';
import { fetchLatestMonitorScanHeartbeat } from './monitor-scan-heartbeat.js';

export const DEFAULT_MONITOR_CHAIN_MAX_PER_DAY = 24;
export const DEFAULT_MONITOR_CHAIN_FLOOR_MINUTES = 150;
export const DEFAULT_MONITOR_CHAIN_FLOOR_MAX_PER_DAY = 12;
export const MONITOR_WATCHDOG_MAX_GAP_MINUTES = 210;

function headers(config, extra = {}) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...extra,
  };
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function monitorChainEnabled(env = process.env) {
  return truthy(env.MONITOR_CHAIN_ENABLED);
}

export function isMonitorChainRun(env = process.env) {
  return truthy(env.MONITOR_CHAIN_RUN);
}

export function isMonitorChainSmoke(env = process.env) {
  return truthy(env.MONITOR_CHAIN_SMOKE);
}

export function isMonitorChainFloorRun(env = process.env) {
  return truthy(env.MONITOR_CHAIN_FLOOR_RUN);
}

function chainConfig(env) {
  return {
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    maxPerDay: positiveInt(env.MONITOR_CHAIN_MAX_PER_DAY, DEFAULT_MONITOR_CHAIN_MAX_PER_DAY),
    floorMinutes: Math.min(
      positiveInt(env.MONITOR_CHAIN_FLOOR_MINUTES, DEFAULT_MONITOR_CHAIN_FLOOR_MINUTES),
      MONITOR_WATCHDOG_MAX_GAP_MINUTES - 1,
    ),
    floorMaxPerDay: positiveInt(
      env.MONITOR_CHAIN_FLOOR_MAX_PER_DAY,
      DEFAULT_MONITOR_CHAIN_FLOOR_MAX_PER_DAY,
    ),
  };
}

function chainPrefix(now, kind = 'intensive') {
  const namespace = kind === 'floor'
    ? 'monitor-floor-chain'
    : 'monitor-chain';
  return `${namespace}:${kstDateKey(now)}:`;
}

function chainRunKey(env, now, kind) {
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  const attempt = String(env.GITHUB_RUN_ATTEMPT || '1').trim();
  return `${chainPrefix(now, kind)}${runId ? `${runId}:${attempt}` : `local:${now}`}`;
}

async function loadClaims(config, now, fetchImpl, kind) {
  const prefix = chainPrefix(now, kind);
  const url = `${config.supabaseUrl}/rest/v1/cost_usage_ledger?select=run_key&run_key=like.${encodeURIComponent(`${prefix}*`)}`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`monitor chain ledger read HTTP ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function claimSlot(config, env, now, fetchImpl, kind) {
  const runKey = chainRunKey(env, now, kind);
  return claimRunKey(config, runKey, now, fetchImpl);
}

async function claimRunKey(config, runKey, now, fetchImpl) {
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: headers(config, {
      'content-type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    }),
    body: JSON.stringify({
      run_key: runKey,
      kst_date: kstDateKey(now),
      apify_usd: 0,
      anthropic_usd: 0,
    }),
  });
  if (!response.ok) throw new Error(`monitor chain ledger claim HTTP ${response.status}`);
  const rows = await response.json();
  return { claimed: Array.isArray(rows) && rows.length > 0, runKey };
}

async function queueClaimedMonitor({
  config,
  env,
  now,
  fetchImpl,
  dispatch,
  kind,
  maxPerDay,
  dispatchOptions,
}) {
  const label = kind === 'floor' ? 'floor' : 'intensive';
  let claims;
  try {
    claims = await loadClaims(config, now, fetchImpl, kind);
  } catch (error) {
    console.error(`[monitor-chain] ${label} ledger read failed; skipping dispatch: ${error.message}`);
    return { dispatched: false, reason: `${label}-ledger-error`, error: error.message };
  }
  if (claims.length >= maxPerDay) {
    return {
      dispatched: false,
      reason: kind === 'floor' ? 'floor-daily-cap' : 'daily-cap',
      count: claims.length,
      maxPerDay,
    };
  }

  let claim;
  try {
    claim = await claimSlot(config, env, now, fetchImpl, kind);
  } catch (error) {
    console.error(`[monitor-chain] ${label} ledger claim failed; skipping dispatch: ${error.message}`);
    return { dispatched: false, reason: `${label}-claim-error`, error: error.message };
  }
  if (!claim.claimed) {
    return { dispatched: false, reason: `${label}-already-claimed`, count: claims.length };
  }

  try {
    await dispatch(env, fetchImpl, dispatchOptions);
    return {
      dispatched: true,
      reason: kind === 'floor' ? 'floor-queued' : 'queued',
      count: claims.length + 1,
      maxPerDay,
    };
  } catch (error) {
    await releaseSlot(config, claim.runKey, fetchImpl);
    return {
      dispatched: false,
      reason: kind === 'floor' ? 'floor-dispatch-failed' : 'dispatch-failed',
      error: error.message,
    };
  }
}

async function releaseSlot(config, runKey, fetchImpl) {
  try {
    await fetchImpl(
      `${config.supabaseUrl}/rest/v1/cost_usage_ledger?run_key=eq.${encodeURIComponent(runKey)}`,
      { method: 'DELETE', headers: headers(config, { Prefer: 'return=minimal' }) },
    );
  } catch {
    // 크론과 heartbeat가 백스톱이므로 claim 해제 실패도 본류를 실패시키지 않는다.
  }
}

async function queueFloorWake({
  config,
  env,
  wakeAt,
  fetchImpl,
  scheduleWake,
}) {
  // Pending waiters replace each other through workflow concurrency and must not
  // consume the daily floor budget. The budget is claimed only after a waiter
  // wakes and queueClaimedMonitor() is about to dispatch a real floor scan.
  try {
    await scheduleWake(env, fetchImpl, {
      wakeAt,
      floorMinutes: config.floorMinutes,
      floorMaxPerDay: config.floorMaxPerDay,
    });
    return {
      scheduled: true,
      reason: 'floor-wake-scheduled',
      wakeAt,
      maxPerDay: config.floorMaxPerDay,
    };
  } catch (error) {
    return { scheduled: false, reason: 'floor-wake-dispatch-failed', error: error.message };
  }
}

export async function chainNextMonitor(env = process.env, options = {}) {
  const now = Number(options.now ?? Date.now());
  const fetchImpl = options.fetchImpl || fetch;
  const dispatch = options.dispatch || dispatchMonitor;
  const scheduleWake = options.scheduleWake || dispatchFloorWake;
  const config = chainConfig(env);
  const smoke = isMonitorChainSmoke(env);

  if (!monitorChainEnabled(env)) return { dispatched: false, reason: 'disabled' };
  // 실환경 큐잉 경로를 게이트 상태와 무관하게 점검할 수 있는 유일한 예외.
  // runaway를 원천 차단하도록 하루 상한을 정확히 1로 준 명시적 smoke에서만 허용한다.
  if (smoke && config.maxPerDay !== 1) {
    return { dispatched: false, reason: 'smoke-requires-cap-one', maxPerDay: config.maxPerDay };
  }
  if (!config.supabaseUrl || !config.supabaseKey) return { dispatched: false, reason: 'ledger-not-configured' };

  // 집중 게이트가 열리면 기존 self-chain이 항상 우선한다. floor 원장/상한과 섞지 않는다.
  if (options.gateOpen || smoke) {
    return queueClaimedMonitor({
      config,
      env,
      now,
      fetchImpl,
      dispatch,
      kind: 'intensive',
      maxPerDay: config.maxPerDay,
      dispatchOptions: {
        chain: true,
        maxPerDay: config.maxPerDay,
        smoke,
        floor: false,
        floorMinutes: config.floorMinutes,
        floorMaxPerDay: config.floorMaxPerDay,
      },
    });
  }

  // 이 run에서 이미 실제 스캔을 마쳤다면 heartbeat 조회 장애가 있더라도 즉시 floor를
  // 연쇄하지 않는다. 기록 장애 때 최대 12회가 연속 실행되는 비용 폭주를 막는다.
  if (options.scannedThisRun) {
    const scannedAt = Number.isFinite(Number(options.lastScannedAt))
      ? Number(options.lastScannedAt)
      : now;
    const wake = await queueFloorWake({
      config,
      env,
      wakeAt: scannedAt + config.floorMinutes * 60 * 1000,
      fetchImpl,
      scheduleWake,
    });
    return { dispatched: false, reason: 'floor-scan-completed', wake };
  }

  let lastScannedAt = null;
  let heartbeatReadFailed = false;
  try {
    lastScannedAt = await fetchLatestMonitorScanHeartbeat(config, fetchImpl);
  } catch (error) {
    // 커버리지 정본 조회 실패는 오래된 것으로 간주하되, 아래 별도 floor 상한은 반드시 거친다.
    heartbeatReadFailed = true;
    console.error(`[monitor-chain] latest heartbeat read failed; treating floor as due: ${error.message}`);
  }
  const ageMs = lastScannedAt == null ? Infinity : Math.max(0, now - lastScannedAt);
  const floorMs = config.floorMinutes * 60 * 1000;
  const ageMinutes = Number.isFinite(ageMs) ? Math.floor(ageMs / (60 * 1000)) : null;
  if (ageMs < floorMs) {
    const wake = await queueFloorWake({
      config,
      env,
      wakeAt: lastScannedAt + floorMs,
      fetchImpl,
      scheduleWake,
    });
    return {
      dispatched: false,
      reason: 'floor-not-due',
      ageMinutes,
      floorMinutes: config.floorMinutes,
      wake,
    };
  }

  const result = await queueClaimedMonitor({
    config,
    env,
    now,
    fetchImpl,
    dispatch,
    kind: 'floor',
    maxPerDay: config.floorMaxPerDay,
    dispatchOptions: {
      chain: true,
      maxPerDay: config.maxPerDay,
      smoke,
      floor: true,
      floorMinutes: config.floorMinutes,
      floorMaxPerDay: config.floorMaxPerDay,
    },
  });
  return {
    ...result,
    ageMinutes,
    floorMinutes: config.floorMinutes,
    ...(heartbeatReadFailed ? { heartbeatReadFailed: true } : {}),
  };
}
