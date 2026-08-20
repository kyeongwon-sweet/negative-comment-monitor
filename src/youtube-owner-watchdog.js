const DEFAULT_STALE_HOURS = 7;

function fmtKst(ms) {
  if (ms == null) return '기록 없음';
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' KST';
}

function successfulStep(job, name) {
  return (job?.steps || []).some((step) => step.name === name && step.conclusion === 'success');
}

export function evaluateOwnerWorkflowHealth(runs, jobsByRunId, now = Date.now(), staleHours = DEFAULT_STALE_HOURS) {
  const threshold = now - staleHours * 3600 * 1000;
  const healthyTimes = [];
  for (const run of runs || []) {
    const startedAt = Date.parse(run.run_started_at || run.created_at || '');
    if (!Number.isFinite(startedAt)) continue;
    const jobs = jobsByRunId.get(String(run.id)) || [];
    const monitor = jobs.find((job) => job.name === 'monitor');
    if (successfulStep(monitor, 'Verify owner-channel schema contract')
      && successfulStep(monitor, 'Run owner-channel monitor')) {
      healthyTimes.push(startedAt);
    }
  }
  const lastHealthyAt = healthyTimes.length ? Math.max(...healthyTimes) : null;
  return { healthy: lastHealthyAt != null && lastHealthyAt >= threshold, lastHealthyAt, threshold };
}

export function buildOwnerWatchdogMessage(health, env = process.env) {
  const owner = String(env.SLACK_ASSIGNEE_OTHER || '').trim();
  return [
    '⚠️ *YouTube 소유채널 보조 모니터 — 정상 결과 미확인*',
    '핵심 부정댓글 모니터링 전체 장애가 아닙니다.',
    `최근 정상 회차: ${fmtKst(health.lastHealthyAt)}`,
    '자가치유: 소유채널 보조 모니터 재실행을 요청했습니다.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function githubJson(env, pathname, options, fetchImpl) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or token');
  const response = await fetchImpl(`https://api.github.com/repos/${repo}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ncm-youtube-owner-watchdog',
      ...(options?.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (response.status === 204) return null;
  return response.json();
}

async function postSlack(env, text, fetchImpl) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) throw new Error('Missing Slack configuration');
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
}

export async function runYouTubeOwnerWatchdog(env = process.env, now = Date.now(), fetchImpl = fetch) {
  const runsPayload = await githubJson(env, '/actions/workflows/youtube-owner-channel.yml/runs?per_page=10', {}, fetchImpl);
  const runs = (runsPayload.workflow_runs || []).filter((run) => run.status === 'completed');
  const jobsByRunId = new Map();
  for (const run of runs) {
    const jobsPayload = await githubJson(env, `/actions/runs/${run.id}/jobs?per_page=10`, {}, fetchImpl);
    jobsByRunId.set(String(run.id), jobsPayload.jobs || []);
  }
  const staleHours = Number(env.YOUTUBE_OWNER_WATCHDOG_STALE_HOURS || DEFAULT_STALE_HOURS);
  const health = evaluateOwnerWorkflowHealth(runs, jobsByRunId, now, staleHours);
  if (health.healthy) {
    console.log(`[youtube-owner-watchdog] OK — last=${fmtKst(health.lastHealthyAt)}`);
    return { warned: false, dispatched: false, ...health };
  }
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  await githubJson(env, '/actions/workflows/youtube-owner-channel.yml/dispatches', {
    method: 'POST', body: JSON.stringify({ ref, inputs: { dry_run: 'false' } }),
  }, fetchImpl);
  await postSlack(env, buildOwnerWatchdogMessage(health, env), fetchImpl);
  console.error(`[youtube-owner-watchdog] STALE — last=${fmtKst(health.lastHealthyAt)}; recovery dispatched`);
  return { warned: true, dispatched: true, ...health };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runYouTubeOwnerWatchdog().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
