import { randomUUID } from 'node:crypto';
import { kstDateKey } from './schedule.js';

const HOUR_MS = 60 * 60 * 1000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function quotaClass(config = {}) {
  return String(config.geminiQuotaClass || 'live').trim().toLowerCase() === 'bulk' ? 'bulk' : 'live';
}

function headers(config, extra = {}) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...extra,
  };
}

async function countClaims(config, prefix, cutoffIso, fetchImpl) {
  const url = new URL(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/cost_usage_ledger`);
  url.searchParams.set('select', 'run_key');
  url.searchParams.set('run_key', `like.${prefix}*`);
  url.searchParams.set('created_at', `gte.${cutoffIso}`);
  const response = await fetchImpl(url, {
    method: 'HEAD',
    headers: headers(config, { Prefer: 'count=exact', Range: '0-0' }),
  });
  if (!response.ok) throw new Error(`Gemini budget count failed: ${response.status}`);
  const range = String(response.headers?.get?.('content-range') || '');
  const match = range.match(/\/(\d+)$/);
  if (!match) throw new Error('Gemini budget count missing Content-Range');
  return Number(match[1]);
}

async function insertClaim(config, kind, now, fetchImpl) {
  const runId = String(process.env.GITHUB_RUN_ID || 'local').replace(/[^A-Za-z0-9_-]+/g, '-');
  const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT || '1').replace(/[^A-Za-z0-9_-]+/g, '-');
  const runKey = `gemini-request:${kind}:${runId}:${runAttempt}:${randomUUID()}`;
  const response = await fetchImpl(
    `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/cost_usage_ledger?on_conflict=run_key`,
    {
      method: 'POST',
      headers: headers(config, {
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      }),
      body: JSON.stringify({
        run_key: runKey,
        kst_date: kstDateKey(now),
        apify_usd: 0,
        anthropic_usd: 0,
      }),
    },
  );
  if (!response.ok) throw new Error(`Gemini budget claim failed: ${response.status}`);
}

// Gemini 무료 한도(실측 500 requests/day)를 대량 복구가 독점하지 않도록 24시간 rolling budget을
// Supabase 원장에 선점한다. bulk는 300회에서 멈추고 live 감시에 최소 180회를 남긴다. 전체는 480회로
// 막아 공급자 한도 직전 20회 버퍼를 둔다. 원장 장애는 fail-open: 분류 자체를 막지 않는다.
export async function claimGeminiRequestBudget(config = {}, fetchImpl = fetch, now = Date.now()) {
  const kind = quotaClass(config);
  const totalLimit = positiveInt(config.geminiRollingRequestBudget, 480);
  const bulkLimit = Math.min(totalLimit, positiveInt(config.geminiBulkRollingRequestBudget, 300));
  const windowHours = positiveInt(config.geminiQuotaWindowHours, 24);
  if (!config.supabaseUrl || !config.supabaseKey) {
    return { allowed: true, tracked: false, quotaClass: kind, totalLimit, bulkLimit };
  }

  const cutoffIso = new Date(now - windowHours * HOUR_MS).toISOString();
  try {
    const totalUsed = await countClaims(config, 'gemini-request:', cutoffIso, fetchImpl);
    if (totalUsed >= totalLimit) {
      return { allowed: false, tracked: true, reason: 'total', quotaClass: kind, totalUsed, totalLimit, bulkLimit };
    }
    if (kind === 'bulk') {
      const bulkUsed = await countClaims(config, 'gemini-request:bulk:', cutoffIso, fetchImpl);
      if (bulkUsed >= bulkLimit) {
        return { allowed: false, tracked: true, reason: 'bulk', quotaClass: kind, totalUsed, bulkUsed, totalLimit, bulkLimit };
      }
    }
    await insertClaim(config, kind, now, fetchImpl);
    return { allowed: true, tracked: true, quotaClass: kind, totalUsed: totalUsed + 1, totalLimit, bulkLimit };
  } catch (error) {
    console.error(`[gemini-budget] 원장 확인 실패 — fail-open: ${String(error?.message || error).slice(0, 160)}`);
    return { allowed: true, tracked: false, quotaClass: kind, totalLimit, bulkLimit, error: String(error?.message || error) };
  }
}
