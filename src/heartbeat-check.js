// 모니터 헬스체크(watchdog) — 별도 워크플로에서 하루 몇 번 실행.
// "오늘(KST) 09:10 이후 성공한 monitor 실행이 있었나"를 GitHub Actions API로 확인해,
// 없으면 Slack 운영채널에 경고한다. DB 불필요. 우리가 겪은 '창 놓쳐 조용히 누락'을 잡는다.
// 정상이면 조용히 종료(성공 시 알림 없음).

const HOUR = 3600 * 1000;

function kstDate(now) {
  return new Date(now + 9 * HOUR).toISOString().slice(0, 10);
}

// 오늘 09:10 KST에 해당하는 UTC 순간(ms).
export function dailyStartInstant(now) {
  return Date.parse(`${kstDate(now)}T09:10:00+09:00`);
}

function fmtKst(ms) {
  if (ms == null) return '기록 없음';
  return new Date(ms + 9 * HOUR).toISOString().slice(0, 16).replace('T', ' ') + ' KST';
}

// runs: [{ conclusion, run_started_at, created_at }] — monitor.yml 실행들.
export function evaluateHealth(runs, now = Date.now()) {
  const threshold = dailyStartInstant(now);
  const successTimes = (runs || [])
    .filter((r) => r.conclusion === 'success')
    .map((r) => Date.parse(r.run_started_at || r.created_at || ''))
    .filter(Number.isFinite);
  const lastSuccessAt = successTimes.length ? Math.max(...successTimes) : null;
  return { healthy: lastSuccessAt != null && lastSuccessAt >= threshold, lastSuccessAt, threshold };
}

export function buildStaleMessage(now, lastSuccessAt, assigneeOther = '') {
  const owner = String(assigneeOther || '').trim();
  return [
    '⚠️ *부정댓글 모니터링 — 오늘 점검 미확인*',
    `오늘(${kstDate(now)}) 09:10 KST 이후 성공한 monitor 실행이 없습니다.`,
    `마지막 성공 실행: ${fmtKst(lastSuccessAt)}`,
    'GitHub Actions 스케줄 실행/실패를 확인하세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function fetchMonitorRuns(env, fetchImpl) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or token');
  const url = `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/runs?per_page=30`;
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

export async function runHeartbeatCheck(env = process.env, now = Date.now(), fetchImpl = fetch) {
  const runs = await fetchMonitorRuns(env, fetchImpl);
  const health = evaluateHealth(runs, now);
  if (health.healthy) {
    console.log(`[heartbeat] OK — 마지막 성공 ${fmtKst(health.lastSuccessAt)}`);
    return { warned: false };
  }
  await postSlack(env, buildStaleMessage(now, health.lastSuccessAt, env.SLACK_ASSIGNEE_OTHER), fetchImpl);
  console.error(`[heartbeat] STALE — 오늘 09:10 KST 이후 성공 실행 없음(마지막 ${fmtKst(health.lastSuccessAt)}) → 경고 발송`);
  return { warned: true };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runHeartbeatCheck().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
