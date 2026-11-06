// YouTube Data API 일일 quota 계량기(2026-11-04 사고 재발방지).
// 11-04 07:02 KST 프로젝트 일일 quota(10,000)가 바닥나 소유채널 빠른 감시·승인·자동숨김이 17:00(자정 PT)까지
// 멈췄다. 사용량을 아무도 볼 수 없어 0이 된 뒤에야 알았다. 이 모듈은:
//  1) 프로세스의 YouTube API 호출을 세어(읽기 1, 쓰기 50, search 100) 종료 시 원장에 한 줄 남기고
//  2) 오늘(PT 날짜) 누적이 70%·90%를 넘거나 소진되면 슬랙에 하루 한 번씩 알리며(상위 소비 잡 포함)
//  3) 대량 수동 작업(전체 영상 프로브·재감사)이 실행 전 남은 quota를 확인할 수 있게 한다(youtubeQuotaUsage).
// import만 하면 globalThis.fetch를 감싼다. GitHub Actions + Supabase env가 있을 때만 기록하고(테스트·로컬 무영향),
// 어떤 실패도 호출 자체를 막지 않는다(fail-open). 원장에는 잡 이름·개수만 남긴다(공개 레포).
// 단위 저장: cost_usage_ledger에는 숫자 칸이 비용(USD)뿐이라 비용 집계를 오염시키지 않도록
// run_key 끝에 개수를 넣는다: yt-units:<PT날짜>:<잡>:<실행>:<개수>.
import path from 'node:path';
import { kstDateKey } from './schedule.js';

export const YOUTUBE_DAILY_QUOTA_DEFAULT = 10_000;
const PREFIX = 'yt-units:';
const ALERT_PREFIX = 'yt-quota-alert:';

function ratioSetting(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

// 상시 감시용 quota 우선순위. 정상 댓글 공개·오탐 복원은 다음 리셋까지 기다려도 안전하지만,
// 부정댓글 탐지·숨김은 가능한 오래 남겨 둔다. 11-05에는 보류→공개와 공개→보류 쓰기(건당 50 unit)가
// 겹쳐 오전에 99%를 써 버렸고, 단순 경고만으로는 나머지 감시까지 quotaExceeded가 났다.
export function youtubeQuotaConservationPlan(usage, env = process.env) {
  if (String(env?.YOUTUBE_QUOTA_GUARD_FORCE || '').toLowerCase() === 'true') {
    return {
      heldReview: true,
      fastScan: true,
      fastScanHoldEnforce: true,
      pendingHide: true,
      falsePositiveRestore: true,
      youtubeAds: true,
      ownerChannel: true,
      ratio: Number.isFinite(Number(usage?.ratio)) ? Number(usage.ratio) : null,
      forced: true,
    };
  }
  if (!usage || !Number.isFinite(Number(usage.ratio))) {
    return {
      heldReview: true,
      fastScan: true,
      fastScanHoldEnforce: true,
      pendingHide: true,
      falsePositiveRestore: true,
      youtubeAds: true,
      ownerChannel: true,
      ratio: null,
      failOpen: true,
    };
  }
  const ratio = Number(usage.ratio);
  const nonHidingMax = ratioSetting(env, 'YOUTUBE_QUOTA_BRAKE_RATIO', 0.60);
  const heldMax = ratioSetting(env, 'YOUTUBE_QUOTA_HELD_REVIEW_MAX_RATIO', nonHidingMax);
  const restoreMax = ratioSetting(env, 'YOUTUBE_QUOTA_FP_RESTORE_MAX_RATIO', nonHidingMax);
  const adsMax = ratioSetting(env, 'YOUTUBE_QUOTA_ADS_MAX_RATIO', nonHidingMax);
  const holdEnforceMax = ratioSetting(env, 'YOUTUBE_QUOTA_HOLD_ENFORCE_MAX_RATIO', nonHidingMax);
  const criticalMax = ratioSetting(env, 'YOUTUBE_QUOTA_CRITICAL_MAX_RATIO', 0.98);
  // 숨김 페이싱(11-06): 숨김 1회 = 채널당 50 unit. 새 광고에 부정이 몰리면 15분마다 숨김만으로 시간당 ~400을 써
  // 리셋 몇 시간 전에 98%에 닿고 숨김이 통째로 멈춘다. 사용률이 높으면 숨김을 모아서(30·60분 칸) 처리해
  // 리셋까지 버틴다 — 노출이 최대 30·60분으로 늘지만 몇 시간 정지보다 낫다.
  const paceHalfAt = ratioSetting(env, 'YOUTUBE_QUOTA_HIDE_PACE_30_RATIO', 0.75);
  const paceHourAt = ratioSetting(env, 'YOUTUBE_QUOTA_HIDE_PACE_60_RATIO', 0.90);
  // 예측 브레이크(11-06 재발방지): 고정 기준(60·75%)은 '지금' 사용률만 본다. 밤새 새 광고 보류 대행으로 빨리 쓰면
  // 60%에 닿기 전부터 이미 '리셋 전 바닥' 궤도다. 리셋 이후 평균 속도로 리셋 시점 사용량을 예측해 98%를 넘으면
  // 가장 비싼 비숨김 작업(봇 보류 대행 50/회·오탐 복원)을 먼저 멈추고 숨김은 30분 칸으로 모은다. 승인 봇은 이미 보류된
  // 댓글을 풀어줘야 하므로 기존 60% 기준을 유지, 인지광고 수집은 부정 탐지라 유지. 리셋 직후 몇 시간은 표본이 적어 쓰지 않는다
  // (youtubeQuotaUsage가 3시간 이후에만 projectedRatio를 붙인다).
  const projected = usage.projectedRatio == null ? NaN : Number(usage.projectedRatio);
  const onTrackToRunOut = Number.isFinite(projected) && projected >= criticalMax;
  const paceMinutes = ratio >= paceHourAt ? 60 : ratio >= paceHalfAt || onTrackToRunOut ? 30 : 15;
  return {
    pendingHideEveryMinutes: paceMinutes,
    heldReview: ratio < heldMax,
    fastScan: ratio < criticalMax,
    fastScanHoldEnforce: ratio < holdEnforceMax && !onTrackToRunOut,
    pendingHide: ratio < criticalMax,
    falsePositiveRestore: ratio < restoreMax && !onTrackToRunOut,
    youtubeAds: ratio < adsMax,
    ownerChannel: ratio < criticalMax,
    ratio,
    projectedRatio: Number.isFinite(projected) ? projected : null,
    onTrackToRunOut,
    failOpen: false,
  };
}

// quota 날짜는 자정 PT 기준으로 리셋된다(업무 날짜가 아니라 Google 리셋 경계라 KST 규칙 예외).
export function quotaDayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

// 다음 리셋 시각(KST 표기용). PT 자정 = 겨울 17:00 KST, 여름 16:00 KST.
export function nextQuotaResetKst(now = Date.now()) {
  for (let h = 1; h <= 25; h += 1) {
    const t = now + h * 3_600_000;
    if (quotaDayKey(t) !== quotaDayKey(now)) {
      const hourStart = t - (t % 3_600_000);
      return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(hourStart));
    }
  }
  return '';
}

export function unitsForRequest(url, method = 'GET') {
  let u;
  try { u = new URL(String(url)); } catch { return 0; }
  if (!/(^|\.)googleapis\.com$/.test(u.hostname) || !u.pathname.startsWith('/youtube/v3/')) return 0;
  if (u.pathname.endsWith('/search')) return 100;
  return String(method || 'GET').toUpperCase() === 'GET' ? 1 : 50;
}

export function parseUnitsKey(runKey) {
  const parts = String(runKey || '').split(':');
  if (parts[0] !== 'yt-units' || parts.length < 5) return null;
  const units = Number(parts[parts.length - 1]);
  return Number.isFinite(units) ? { day: parts[1], job: parts[2], units } : null;
}

function sb(env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  return url && key ? { url, headers: { apikey: key, Authorization: `Bearer ${key}` } } : null;
}

// 오늘(PT) 누적 사용량과 잡별 합계. 대량 작업 전 남은 quota 확인용.
export async function youtubeQuotaUsage(env = process.env, fetchImpl = fetch, now = Date.now()) {
  const db = sb(env);
  if (!db) return null;
  const day = quotaDayKey(now);
  const byJob = new Map();
  let total = 0;
  for (let offset = 0; ; offset += 1000) {
    const response = await fetchImpl(
      `${db.url}/rest/v1/cost_usage_ledger?select=run_key&run_key=like.${encodeURIComponent(`${PREFIX}${day}:*`)}&order=run_key.asc&offset=${offset}&limit=1000`,
      { headers: db.headers },
    );
    if (!response.ok) throw new Error(`quota ledger read failed (${response.status})`);
    const rows = await response.json();
    for (const row of rows) {
      const parsed = parseUnitsKey(row.run_key);
      if (!parsed) continue;
      total += parsed.units;
      byJob.set(parsed.job, (byJob.get(parsed.job) || 0) + parsed.units);
    }
    if (rows.length < 1000) break;
  }
  const limit = Math.max(1, Number(env.YOUTUBE_DAILY_QUOTA || YOUTUBE_DAILY_QUOTA_DEFAULT) || YOUTUBE_DAILY_QUOTA_DEFAULT);
  const ratio = total / limit;
  return {
    day, total, limit, ratio,
    projectedRatio: projectQuotaRatio(ratio, now),
    byJob: [...byJob.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// 리셋(자정 PT) 이후 경과 시간. DST 전환일엔 1시간 오차가 있지만 예측용이라 무시한다.
export function hoursSinceQuotaReset(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return Number(parts.hour) + Number(parts.minute) / 60;
}

// 리셋 이후 평균 속도가 그대로면 리셋 직전 사용률이 얼마일지. 표본이 적은 리셋 후 3시간 안은 null.
export function projectQuotaRatio(ratio, now = Date.now(), minHours = 3) {
  const elapsed = hoursSinceQuotaReset(now);
  if (!Number.isFinite(ratio) || elapsed < minHours) return null;
  return ratio * (24 / elapsed);
}

// 대량 수동 작업 가드: 예상 사용량을 더해 상한을 넘으면 실행 전에 막는다.
export async function assertQuotaHeadroom(estimateUnits, { maxRatio = 0.6, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  if (String(env.YOUTUBE_QUOTA_GUARD_FORCE || '').toLowerCase() === 'true') return null;
  const usage = await youtubeQuotaUsage(env, fetchImpl, now);
  if (!usage) return null;
  const after = usage.total + Math.max(0, Number(estimateUnits) || 0);
  if (after > usage.limit * maxRatio) {
    throw new Error(`YouTube quota 여유 부족: 오늘 ${usage.total}/${usage.limit} + 예상 ${estimateUnits} > ${Math.round(maxRatio * 100)}% — 리셋(${nextQuotaResetKst(now)} KST) 뒤 실행하거나 YOUTUBE_QUOTA_GUARD_FORCE=true`);
  }
  return usage;
}

// 오늘(PT) '할당량 소진' 알림이 나갔는가 = 소진 상태. 리셋(PT 자정)이 지나면 날짜 키가 바뀌어 자동 해제.
export async function isYouTubeQuotaExhaustedToday(env = process.env, fetchImpl = fetch, now = Date.now()) {
  const db = sb(env);
  if (!db) return false;
  const key = `${ALERT_PREFIX}${quotaDayKey(now)}:exhausted`;
  const response = await fetchImpl(
    `${db.url}/rest/v1/cost_usage_ledger?select=run_key&run_key=eq.${encodeURIComponent(key)}`,
    { headers: db.headers },
  );
  if (!response.ok) return false;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.some((row) => row?.run_key === key);
}

// quota 브레이크(11-05): 오늘 사용률이 기준(기본 60%)을 넘거나 소진이면 '부정 댓글 찾기·숨기기'가 아닌 비싼 쓰기
// (봇 보류 대행·보류 댓글 공개)를 멈춰 남은 quota를 숨김에 남긴다. 11-04~05 하루 사용 ~1만 중 절반 이상이
// '모두 보류' 안 걸린 새 광고 19개의 댓글을 봇이 보류(50)→재공개(50)한 비용이었다. 조회 실패 시엔 멈추지 않는다(fail-open).
// 주기 칸 선점(숨김 페이싱용): floor(now/주기) 칸을 원장 키로 한 번만 잡는다. 조회 실패는 실행(fail-open).
export async function claimQuotaPacingSlot(env, name, minutes, fetchImpl = fetch, now = Date.now()) {
  const db = sb(env || {});
  const every = Math.max(1, Math.floor(Number(minutes) || 15));
  const runKey = `quota-pace:${name}:${every}:${Math.floor(now / (every * 60 * 1000))}`;
  if (!db) return { claimed: true, runKey, failOpen: true };
  try {
    const response = await fetchImpl(`${db.url}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
      method: 'POST',
      headers: { ...db.headers, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ run_key: runKey, kst_date: kstDateKey(now), apify_usd: 0, anthropic_usd: 0 }),
    });
    if (!response.ok) return { claimed: true, runKey, failOpen: true };
    const rows = await response.json().catch(() => null);
    return { claimed: !Array.isArray(rows) || rows.length > 0, runKey };
  } catch {
    return { claimed: true, runKey, failOpen: true };
  }
}

export async function quotaBrakeEngaged({ supabaseUrl, supabaseKey, ratio } = {}, fetchImpl = fetch, now = Date.now()) {
  const env = { SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: supabaseKey };
  const limitRatio = Number.isFinite(Number(ratio)) && Number(ratio) > 0 ? Number(ratio) : 0.6;
  try {
    if (await isYouTubeQuotaExhaustedToday(env, fetchImpl, now)) return { engaged: true, reason: 'exhausted' };
    const usage = await youtubeQuotaUsage(env, fetchImpl, now);
    if (usage && usage.ratio >= limitRatio) return { engaged: true, reason: `${Math.round(usage.ratio * 100)}%`, usage };
    return { engaged: false, usage };
  } catch {
    return { engaged: false };
  }
}

export function quotaAlertMessage(level, usage, now = Date.now(), assignee = '') {
  const top = usage.byJob.slice(0, 5).map(([job, units]) => `${job} ${units}`).join(', ');
  const head = level === 'exhausted'
    ? `:rotating_light: *YouTube API 일일 할당량 소진* — 소유채널 빠른 감시·승인·자동숨김이 ${nextQuotaResetKst(now)} KST(리셋)까지 멈춥니다.`
    : `:warning: *YouTube API 할당량 ${Math.round(usage.ratio * 100)}% 사용* (${usage.total}/${usage.limit}) — 리셋 ${nextQuotaResetKst(now)} KST.`;
  const lines = [head, `오늘 많이 쓴 작업: ${top || '기록 없음'}`];
  if (level !== 'exhausted') {
    lines.push('자동 절약 모드: 정상댓글 공개·오탐 복원·인지광고 전수조회부터 멈추고, 부정 탐지·숨김용 quota를 우선 보존합니다.');
    lines.push('전체 영상 프로브·재감사 같은 대량 수동 작업은 리셋 뒤에 돌려주세요.');
  }
  if (assignee) lines.push(`담당자: <@${assignee}>`);
  return lines.join('\n');
}

async function claimAlert(db, day, level, now) {
  const response = await fetch(`${db.url}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: { ...db.headers, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ run_key: `${ALERT_PREFIX}${day}:${level}`, kst_date: kstDateKey(now), apify_usd: 0, anthropic_usd: 0 }),
  });
  if (!response.ok) return false;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

// 기록 + 임계 알림. 프로세스 종료 직전 한 번 호출된다.
export async function flushYouTubeQuotaMeter(state, env = process.env, now = Date.now()) {
  const db = sb(env);
  if (!db || (!state.units && !state.exhausted)) return;
  const day = quotaDayKey(now);
  if (state.units) {
    const run = `${env.GITHUB_RUN_ID || 'local'}.${env.GITHUB_RUN_ATTEMPT || 1}.${process.pid}.${now}`;
    await fetch(`${db.url}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
      method: 'POST',
      headers: { ...db.headers, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ run_key: `${PREFIX}${day}:${state.job}:${run}:${state.units}`, kst_date: kstDateKey(now), apify_usd: 0, anthropic_usd: 0 }),
    });
  }
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) return;
  const usage = await youtubeQuotaUsage(env, fetch, now);
  if (!usage) return;
  const level = state.exhausted ? 'exhausted' : usage.ratio >= 0.9 ? '90' : usage.ratio >= 0.7 ? '70' : '';
  if (!level || !(await claimAlert(db, day, level, now))) return;
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text: quotaAlertMessage(level, usage, now, String(env.SLACK_ASSIGNEE_OTHER || '').trim()), unfurl_links: false }),
  });
}

export function meteredFetch(original, state) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    const units = unitsForRequest(url, init?.method || input?.method);
    const response = await original(input, init);
    if (units) {
      try {
        // quota 소진 응답은 차감되지 않는다 — 세지 않고 소진 신호만 남긴다.
        if (response.status === 403 && /quotaExceeded|dailyLimitExceeded/.test(await response.clone().text())) state.exhausted = true;
        else state.units += units;
      } catch { state.units += units; }
    }
    return response;
  };
}

export function installYouTubeQuotaMeter(env = process.env) {
  if (globalThis.__youtubeQuotaMeter) return globalThis.__youtubeQuotaMeter;
  const state = { units: 0, exhausted: false, job: path.basename(String(process.argv[1] || 'node')).replace(/\.m?js$/, '').replace(/[^A-Za-z0-9_.-]/g, '') || 'node' };
  globalThis.__youtubeQuotaMeter = state;
  const enabled = env.GITHUB_ACTIONS === 'true' && !env.NODE_TEST_CONTEXT && sb(env) && typeof globalThis.fetch === 'function';
  if (!enabled) return state;
  globalThis.fetch = meteredFetch(globalThis.fetch, state);
  let flushed = false;
  process.on('beforeExit', () => {
    if (flushed) return;
    flushed = true;
    flushYouTubeQuotaMeter(state, env).catch((error) => {
      console.error(`[youtube-quota-meter] ${String(error.message || error).slice(0, 160)}`);
    });
  });
  return state;
}

installYouTubeQuotaMeter();
