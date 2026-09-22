import { kstDateKey } from './schedule.js';
import { dispatchMonitor } from './monitor-dispatch.js';

export const DEFAULT_MONITOR_CHAIN_MAX_PER_DAY = 24;

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

function chainConfig(env) {
  return {
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    maxPerDay: positiveInt(env.MONITOR_CHAIN_MAX_PER_DAY, DEFAULT_MONITOR_CHAIN_MAX_PER_DAY),
  };
}

function chainPrefix(now) {
  return `monitor-chain:${kstDateKey(now)}:`;
}

function chainRunKey(env, now) {
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  const attempt = String(env.GITHUB_RUN_ATTEMPT || '1').trim();
  return `${chainPrefix(now)}${runId ? `${runId}:${attempt}` : `local:${now}`}`;
}

async function loadClaims(config, now, fetchImpl) {
  const prefix = chainPrefix(now);
  const url = `${config.supabaseUrl}/rest/v1/cost_usage_ledger?select=run_key&run_key=like.${encodeURIComponent(`${prefix}*`)}`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`monitor chain ledger read HTTP ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function claimSlot(config, env, now, fetchImpl) {
  const runKey = chainRunKey(env, now);
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

export async function chainNextMonitor(env = process.env, options = {}) {
  const now = Number(options.now ?? Date.now());
  const fetchImpl = options.fetchImpl || fetch;
  const dispatch = options.dispatch || dispatchMonitor;
  const config = chainConfig(env);
  const smoke = isMonitorChainSmoke(env);

  if (!monitorChainEnabled(env)) return { dispatched: false, reason: 'disabled' };
  // 실환경 큐잉 경로를 게이트 상태와 무관하게 점검할 수 있는 유일한 예외.
  // runaway를 원천 차단하도록 하루 상한을 정확히 1로 준 명시적 smoke에서만 허용한다.
  if (smoke && config.maxPerDay !== 1) {
    return { dispatched: false, reason: 'smoke-requires-cap-one', maxPerDay: config.maxPerDay };
  }
  if (!options.gateOpen && !smoke) return { dispatched: false, reason: 'gate-closed' };
  if (!config.supabaseUrl || !config.supabaseKey) return { dispatched: false, reason: 'ledger-not-configured' };

  const claims = await loadClaims(config, now, fetchImpl);
  if (claims.length >= config.maxPerDay) {
    return { dispatched: false, reason: 'daily-cap', count: claims.length, maxPerDay: config.maxPerDay };
  }

  const claim = await claimSlot(config, env, now, fetchImpl);
  if (!claim.claimed) return { dispatched: false, reason: 'already-claimed', count: claims.length };

  try {
    await dispatch(env, fetchImpl, {
      chain: true,
      maxPerDay: config.maxPerDay,
      smoke,
    });
    return { dispatched: true, reason: 'queued', count: claims.length + 1, maxPerDay: config.maxPerDay };
  } catch (error) {
    await releaseSlot(config, claim.runKey, fetchImpl);
    return { dispatched: false, reason: 'dispatch-failed', error: error.message };
  }
}
