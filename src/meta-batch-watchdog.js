// 인지 광고 '아침 배치' 결과 워치독 — 별도 워크플로에서 KST 13/16시(신뢰 시간대)에 실행.
// 기존 heartbeat는 "monitor.yml이 돌았나"만 보므로, monitor는 돌았지만 meta-ads 스텝이
// 창(KST 8~11) 밖이라 스킵돼 배치가 조용히 누락되는 경우(주말 30건 적체 사고)를 못 잡는다.
// → 여기선 결과(증상)를 직접 본다: '아침 창 시작(08:00) 전에 들어온 웹훅 이벤트가
//   워치독 시점(정오 이후)에도 미처리로 남아있으면' 아침 배치가 안 돈 것 → 자가치유 + 경고.
// 별도로 마지막 웹훅 수신 시각도 확인한다. 다만 저볼륨 광고의 정상적인 무댓글 기간을
// 장애로 오판하지 않도록, 유입이 오래 끊겼을 때는 Marketing API poll을 먼저 실행한다.
// poll 실패 또는 poll이 새 댓글을 찾아 DB 누락을 복구한 경우에만 하루 한 번 경고한다.
// DB(meta_ad_comment_events)만 조회. 정상이면 조용히 종료(알림 없음).

import { loadMetaAdsConfig } from './meta-ads.js';
import { pollMetaAdComments } from './meta-ads-poll.js';

const HOUR = 3600 * 1000;
function kstDate(now) { return new Date(now + 9 * HOUR).toISOString().slice(0, 10); }
function fmtKst(ms) { return ms == null ? '없음' : new Date(ms + 9 * HOUR).toISOString().slice(0, 16).replace('T', ' ') + ' KST'; }

// 아침 창 시작 순간(오늘 KST windowStart:00). 이 시각 '이전'에 수신된 이벤트는 창 안에 처리됐어야 한다.
export function morningStartInstant(now, windowStart = 8) {
  const hh = String(windowStart).padStart(2, '0');
  return Date.parse(`${kstDate(now)}T${hh}:00:00+09:00`);
}

// events: 미처리(processed_at=null) 웹훅 이벤트들. 창 시작 전 수신분이 남아있으면 backlog(=배치 누락).
export function evaluateBacklog(events, now = Date.now(), windowStart = 8) {
  const cutoff = morningStartInstant(now, windowStart);
  const stale = (events || [])
    .map((e) => Date.parse(e.received_at || ''))
    .filter((t) => Number.isFinite(t) && t < cutoff);
  return { stale: stale.length, oldest: stale.length ? Math.min(...stale) : null, total: (events || []).length };
}

// 웹훅 수신 정지는 처리 backlog와 독립된 장애다. received_at이 실제 전달 시각의 정본이고,
// 구형/테스트 행에 received_at이 없을 때만 event_time으로 폴백한다.
export function evaluateInflow(lastEvent, now = Date.now(), staleHours = 48) {
  const configured = Number(staleHours);
  const thresholdHours = Number.isFinite(configured) && configured > 0 ? configured : 48;
  const lastEventAt = Date.parse(lastEvent?.received_at || lastEvent?.event_time || '');
  if (!Number.isFinite(lastEventAt)) {
    return { stale: false, lastEventAt: null, ageHours: null, thresholdHours };
  }
  const ageHours = Math.max(0, (now - lastEventAt) / HOUR);
  return { stale: ageHours > thresholdHours, lastEventAt, ageHours, thresholdHours };
}

// zero-inflow는 그 자체로 장애가 아니다. 활성 광고에 새 댓글이 없는 정상 저볼륨 기간과
// 웹훅 장애를 구분하기 위해 poll 결과를 함께 본다.
// - poll 실패/스킵: 정상 여부를 확인하지 못했으므로 경고
// - stored > 0: 광고 댓글이 DB에 없었다가 poll로 복구됨 = 실제 유입 갭이므로 경고
// - 그 외: 광고/댓글이 없거나 조회된 댓글이 이미 DB에 있음 = 정상 조용함
export function evaluateInflowPoll(pollSummary, pollError = null) {
  if (pollError) return { warn: true, reason: 'poll-failed', missing: 0 };
  if (!pollSummary || pollSummary.skipped) return { warn: true, reason: 'poll-unverified', missing: 0 };
  const missing = Math.max(0, Number(pollSummary.stored) || 0);
  if (missing > 0) return { warn: true, reason: 'db-gap', missing };
  const adsMedia = Math.max(0, Number(pollSummary.adsMedia) || 0);
  const comments = Math.max(0, Number(pollSummary.comments) || 0);
  return {
    warn: false,
    reason: adsMedia > 0 && comments === 0 ? 'benign-no-comments' : 'benign-no-missing',
    missing: 0,
    adsMedia,
    comments,
  };
}

export function buildBacklogMessage(now, res, assigneeOther = '') {
  const owner = String(assigneeOther || '').trim();
  return [
    '⚠️ *인지 광고 아침 배치 미실행 의심*',
    `오늘(${kstDate(now)}) 아침 창(KST 8~11) 이전 수신 웹훅 댓글이 미처리로 남아 있습니다.`,
    `미처리(창 전 수신) ${res.stale}건 · 가장 오래된 수신 ${fmtKst(res.oldest)} · 전체 미처리 ${res.total}건`,
    '자가치유: monitor.yml 강제 실행(META_ADS_FORCE)을 요청했습니다. 반영 안 되면 스케줄/큐를 확인하세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

export function buildInflowMessage(res, assigneeOther = '', pollGate = null) {
  const owner = String(assigneeOther || '').trim();
  const detail = pollGate?.reason === 'db-gap'
    ? `보완 poll에서 DB에 없던 댓글 ${pollGate.missing}건을 찾아 적재했습니다.`
    : '보완 poll이 실패해 정상 무댓글 상태인지 확인하지 못했습니다.';
  return [
    '⚠️ *Meta 인지광고 댓글 웹훅 유입 이상*',
    `최근 유입 ${fmtKst(res.lastEventAt)} · ${res.thresholdHours}시간 이상 신규 이벤트가 없습니다.`,
    detail,
    '웹훅·페이지 subscribed_apps·Meta 토큰 상태를 확인하세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function fetchUnprocessed(env, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!base || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = `${base}/rest/v1/meta_ad_comment_events?select=received_at&processed_at=is.null&order=received_at.asc&limit=500`;
  const res = await fetchImpl(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchLatestEvent(env, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!base || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = `${base}/rest/v1/meta_ad_comment_events?select=event_time,received_at&order=received_at.desc&limit=1`;
  const res = await fetchImpl(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

// cost_usage_ledger의 run_key PK를 재사용해 KST 하루 한 번만 경고한다.
// 비용은 0으로 기록되므로 일일 비용 합계에는 영향을 주지 않는다.
async function claimInflowWarning(env, now, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const date = kstDate(now);
  const runKey = `meta-inflow-stale:${date}`;
  const res = await fetchImpl(`${base}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify({ run_key: runKey, kst_date: date, apify_usd: 0, anthropic_usd: 0 }),
  });
  if (!res.ok) throw new Error(`Supabase inflow claim ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  return { claimed: Array.isArray(rows) && rows.length > 0, runKey };
}

async function releaseInflowWarning(env, runKey, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  try {
    await fetchImpl(
      `${base}/rest/v1/cost_usage_ledger?run_key=eq.${encodeURIComponent(runKey)}`,
      { method: 'DELETE', headers: { apikey: key, authorization: `Bearer ${key}`, Prefer: 'return=minimal' } },
    );
  } catch { /* Slack 재시도를 보장하기 위한 best-effort 해제 */ }
}

async function dispatchMonitor(env, fetchImpl) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  if (!repo || !token) return false; // 토큰 없으면 자가치유 생략(경고는 계속)
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'ncm-meta-watchdog' },
    body: JSON.stringify({ ref }),
  });
  return res.ok;
}

async function postSlack(env, text, fetchImpl) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) throw new Error('Missing Slack configuration');
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

export async function runMetaBatchWatchdog(env = process.env, now = Date.now(), fetchImpl = fetch, deps = {}) {
  const windowStart = Number(env.META_ADS_WINDOW_START || 8);
  const staleHours = Number(env.META_INFLOW_STALE_HOURS || 48);
  const [events, lastEvent] = await Promise.all([
    fetchUnprocessed(env, fetchImpl),
    fetchLatestEvent(env, fetchImpl),
  ]);
  const res = evaluateBacklog(events, now, windowStart);
  const inflow = evaluateInflow(lastEvent, now, staleHours);
  const pollFn = deps.pollMetaAdComments || pollMetaAdComments;
  let warned = false;
  let dispatched = false;

  if (res.stale > 0) {
    dispatched = await dispatchMonitor(env, fetchImpl).catch(() => false);
    await postSlack(env, buildBacklogMessage(now, res, env.SLACK_ASSIGNEE_OTHER), fetchImpl);
    console.error(`[meta-watchdog] STALE — 창 전 미처리 ${res.stale}건(가장 오래됨 ${fmtKst(res.oldest)}) → dispatch=${dispatched}, 경고 발송`);
    warned = true;
  }

  let inflowPoll = null;
  if (inflow.stale) {
    const pollEnv = { ...env, META_ADS_POLL_FORCE: 'true' };
    let pollSummary = null;
    let pollError = null;
    try {
      pollSummary = await pollFn(loadMetaAdsConfig(pollEnv, now), fetchImpl, now, pollEnv);
    } catch (error) {
      pollError = error;
      console.error(`[meta-watchdog] zero-inflow 확인 poll 실패: ${error.message}`);
    }
    inflowPoll = evaluateInflowPoll(pollSummary, pollError);
  }

  if (inflow.stale && inflowPoll?.warn) {
    // poll이 새 댓글을 복구했다면 다음 정기 회차까지 기다리지 않고 즉시 처리한다.
    if (inflowPoll.reason === 'db-gap' && !dispatched) {
      dispatched = await dispatchMonitor(env, fetchImpl).catch(() => false);
    }
    let claim = null;
    try {
      claim = await claimInflowWarning(env, now, fetchImpl);
    } catch (error) {
      // dedup 장애가 유입 정지를 다시 무음으로 만들지 않게 경고는 발송한다.
      console.error(`[meta-watchdog] zero-inflow 경고 dedup 실패(중복 가능): ${error.message}`);
    }
    if (!claim || claim.claimed) {
      try {
        await postSlack(env, buildInflowMessage(inflow, env.SLACK_ASSIGNEE_OTHER, inflowPoll), fetchImpl);
        console.error(`[meta-watchdog] ZERO_INFLOW(${inflowPoll.reason}) — 마지막 유입 ${fmtKst(inflow.lastEventAt)} (${inflow.ageHours.toFixed(1)}h 전), 경고 발송`);
        warned = true;
      } catch (error) {
        if (claim?.claimed) await releaseInflowWarning(env, claim.runKey, fetchImpl);
        throw error;
      }
    } else {
      console.error(`[meta-watchdog] ZERO_INFLOW(${inflowPoll.reason}) — 마지막 유입 ${fmtKst(inflow.lastEventAt)} (${inflow.ageHours.toFixed(1)}h 전), 오늘 경고는 이미 발송됨`);
    }
  }

  if (!warned && inflow.stale && inflowPoll && !inflowPoll.warn) {
    console.log(`[meta-watchdog] OK — zero-inflow poll 정상(${inflowPoll.reason}, adsMedia=${inflowPoll.adsMedia}, comments=${inflowPoll.comments}), 경고 억제`);
  } else if (!warned && !inflow.stale) {
    const inflowText = inflow.lastEventAt == null ? '유입 이력 없음' : `마지막 유입 ${fmtKst(inflow.lastEventAt)}`;
    console.log(`[meta-watchdog] OK — 창 전 미처리 없음(전체 미처리 ${res.total}), ${inflowText}`);
  }
  return { warned, dispatched };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runMetaBatchWatchdog().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
