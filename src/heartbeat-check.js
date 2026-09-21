import { clearPlatformAlertClaim, recordPlatformOutcome } from './platform-health.js';

// 모니터 헬스체크(watchdog) — 별도 워크플로에서 하루 몇 번 실행.
// "현재 운영일의 09:10 KST 이후 성공한 monitor 실행이 있었나"를 GitHub Actions API로 확인해,
// 없으면 Slack 운영채널에 경고한다. 우리가 겪은 '창 놓쳐 조용히 누락'을 잡는다.
// platform health에 마지막 경고 시각을 남겨 같은 상태의 하루 2회 중복 경고를 막는다.
// 정상이면 조용히 종료(성공 시 알림 없음).

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
export const DEFAULT_MAX_GAP_MS = 3.5 * HOUR;
export const DEFAULT_ALERT_COOLDOWN_HOURS = 24;
const HEARTBEAT_HEALTH_KEY = 'monitor_heartbeat';

function kstDate(now) {
  return new Date(now + 9 * HOUR).toISOString().slice(0, 10);
}

// 09:10 KST 전에는 아직 오늘 점검 마감이 오지 않았으므로 전날 09:10을 기준으로 삼는다.
// 09:10 KST부터는 오늘 09:10을 기준으로 삼아 기존 감시 강도를 유지한다.
export function dailyStartInstant(now) {
  const todayStart = Date.parse(`${kstDate(now)}T09:10:00+09:00`);
  return now < todayStart ? todayStart - DAY : todayStart;
}

export function fmtKst(ms) {
  if (ms == null) return '기록 없음';
  return new Date(ms + 9 * HOUR).toISOString().slice(0, 16).replace('T', ' ') + ' KST';
}

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}분`;
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
}

export function maximumSuccessGap(runs, now = Date.now(), windowMs = DAY) {
  const windowStart = now - windowMs;
  const successTimes = [...new Set((runs || [])
    .filter((run) => run.conclusion === 'success')
    .map((run) => Date.parse(run.run_started_at || run.created_at || ''))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= windowStart && timestamp <= now))]
    .sort((a, b) => a - b);
  const points = [windowStart, ...successTimes, now];
  let start = windowStart;
  let end = now;
  let durationMs = -1;
  for (let index = 1; index < points.length; index += 1) {
    const gap = points[index] - points[index - 1];
    if (gap > durationMs) {
      durationMs = gap;
      start = points[index - 1];
      end = points[index];
    }
  }
  return { durationMs: Math.max(0, durationMs), start, end, successCount: successTimes.length };
}

// runs: [{ conclusion, run_started_at, created_at }] — monitor.yml 실행들.
export function evaluateHealth(runs, now = Date.now(), maxGapMs = DEFAULT_MAX_GAP_MS) {
  const threshold = dailyStartInstant(now);
  const successTimes = (runs || [])
    .filter((r) => r.conclusion === 'success')
    .map((r) => Date.parse(r.run_started_at || r.created_at || ''))
    .filter(Number.isFinite);
  const lastSuccessAt = successTimes.length ? Math.max(...successTimes) : null;
  const dailyHealthy = lastSuccessAt != null && lastSuccessAt >= threshold;
  const maximumGap = maximumSuccessGap(runs, now);
  const gapHealthy = maximumGap.durationMs <= maxGapMs;
  return {
    healthy: dailyHealthy && gapHealthy,
    dailyHealthy,
    gapHealthy,
    lastSuccessAt,
    threshold,
    maximumGap,
    maxGapMs,
  };
}

export function buildStaleMessage(
  now,
  lastSuccessAt,
  assigneeOther = '',
  recoveryDispatched = false,
  threshold = dailyStartInstant(now),
) {
  const owner = String(assigneeOther || '').trim();
  return [
    '⚠️ *부정댓글 모니터링 — 운영 기준 점검 미확인*',
    `기준일(${kstDate(threshold)}) 09:10 KST 이후 성공한 monitor 실행이 없습니다.`,
    `마지막 성공 실행: ${fmtKst(lastSuccessAt)}`,
    recoveryDispatched
      ? '자가치유: monitor.yml 수동 실행을 자동 요청했습니다.'
      : 'GitHub Actions 스케줄 실행/실패를 확인하세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

export function buildHealthWarning(now, health, assigneeOther = '', recoveryDispatched = false) {
  const owner = String(assigneeOther || '').trim();
  const lines = ['⚠️ *부정댓글 모니터링 — 실행 공백 감지*'];
  if (!health.gapHealthy) {
    lines.push(`최근 24시간 최대 성공 실행 공백: *${formatDuration(health.maximumGap.durationMs)}*`);
    lines.push(`공백 구간: ${fmtKst(health.maximumGap.start)} → ${fmtKst(health.maximumGap.end)}`);
    lines.push(`허용 임계: ${formatDuration(health.maxGapMs)}`);
  }
  if (!health.dailyHealthy) {
    lines.push(`기준일(${kstDate(health.threshold)}) 09:10 KST 이후 성공한 monitor 실행이 없습니다.`);
    lines.push(`마지막 성공 실행: ${fmtKst(health.lastSuccessAt)}`);
  }
  lines.push(
    recoveryDispatched
      ? '자가치유: monitor.yml 수동 실행을 자동 요청했습니다.'
      : 'GitHub Actions 스케줄 실행/실패를 확인하세요.',
  );
  if (owner) lines.push(`담당자: <@${owner}>`);
  return lines.join('\n');
}

async function fetchMonitorRuns(env, fetchImpl) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or token');
  const url = `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/runs?per_page=100`;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'ncm-heartbeat' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.workflow_runs || [];
}

async function postSlack(env, text, fetchImpl) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) throw new Error('Missing Slack configuration');
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

async function dispatchMonitor(env, fetchImpl) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or token');
  const url = `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/dispatches`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ncm-heartbeat',
    },
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) throw new Error(`GitHub dispatch API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

function heartbeatStateConfig(env) {
  const configuredCooldown = Number(env.HEARTBEAT_ALERT_COOLDOWN_HOURS || DEFAULT_ALERT_COOLDOWN_HOURS);
  return {
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || ''),
    platformFailureThreshold: 1,
    platformFailureAlertCooldownHours: Number.isFinite(configuredCooldown) && configuredCooldown > 0
      ? configuredCooldown
      : DEFAULT_ALERT_COOLDOWN_HOURS,
  };
}

function healthErrorSummary(health) {
  return `daily=${health.dailyHealthy} gap=${formatDuration(health.maximumGap.durationMs)}`;
}

export async function runHeartbeatCheck(env = process.env, now = Date.now(), fetchImpl = fetch) {
  const runs = await fetchMonitorRuns(env, fetchImpl);
  const configuredGapMinutes = Number(env.HEARTBEAT_MAX_GAP_MINUTES || 210);
  const maxGapMs = Number.isFinite(configuredGapMinutes) && configuredGapMinutes > 0
    ? configuredGapMinutes * 60000
    : DEFAULT_MAX_GAP_MS;
  const health = evaluateHealth(runs, now, maxGapMs);
  const stateConfig = heartbeatStateConfig(env);
  if (health.healthy) {
    await recordPlatformOutcome(
      stateConfig,
      { platform: HEARTBEAT_HEALTH_KEY, ok: true },
      fetchImpl,
      now,
    );
    console.log(`[heartbeat] OK — 마지막 성공 ${fmtKst(health.lastSuccessAt)}, 최근 24h 최대 공백 ${formatDuration(health.maximumGap.durationMs)}`);
    return { warned: false, dispatched: false };
  }

  const state = await recordPlatformOutcome(
    stateConfig,
    { platform: HEARTBEAT_HEALTH_KEY, ok: false, error: healthErrorSummary(health) },
    fetchImpl,
    now,
  );
  if (state.persisted && !state.shouldEscalate) {
    console.log(`[heartbeat] SUPPRESSED — 같은 unhealthy 상태를 ${stateConfig.platformFailureAlertCooldownHours}시간 내 이미 알림`);
    return { warned: false, dispatched: false, suppressed: true };
  }

  const claimed = state.persisted && state.shouldEscalate;
  try {
    await dispatchMonitor(env, fetchImpl);
    await postSlack(
      env,
      buildHealthWarning(now, health, env.SLACK_ASSIGNEE_OTHER, true),
      fetchImpl,
    );
  } catch (error) {
    if (claimed) await clearPlatformAlertClaim(stateConfig, HEARTBEAT_HEALTH_KEY, fetchImpl, now);
    throw error;
  }
  console.error(`[heartbeat] STALE — daily=${health.dailyHealthy} gap=${formatDuration(health.maximumGap.durationMs)}/${formatDuration(health.maxGapMs)} (${fmtKst(health.maximumGap.start)} → ${fmtKst(health.maximumGap.end)}) → monitor.yml 자동 실행 요청 + 경고 발송`);
  return { warned: true, dispatched: true };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runHeartbeatCheck().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
