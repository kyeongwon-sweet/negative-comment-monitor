export function buildFailureMessage(env = process.env) {
  const owner = String(env.SLACK_ASSIGNEE_OTHER || '').trim();
  const runUrl = String(env.FAILURE_RUN_URL || '').trim();
  const lines = [
    '🚨 *부정댓글 모니터링 실행 실패*',
    owner ? `담당자: <@${owner}>` : '',
    runUrl ? `<${runUrl}|GitHub Actions 실패 로그 열기>` : '',
    '해당 실행의 댓글 수집 또는 Slack 전송이 완료되지 않았습니다.',
  ];
  return lines.filter(Boolean).join('\n');
}

const DEFAULT_FAILURE_ALERT_COOLDOWN_HOURS = 12;

function parseTime(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateFailureAlert(runs, env = process.env, now = Date.now()) {
  const currentRunId = String(env.GITHUB_RUN_ID || '').trim();
  const configuredCooldown = Number(
    env.MONITOR_FAILURE_ALERT_COOLDOWN_HOURS || DEFAULT_FAILURE_ALERT_COOLDOWN_HOURS,
  );
  const cooldownMs = (
    Number.isFinite(configuredCooldown) && configuredCooldown > 0
      ? configuredCooldown
      : DEFAULT_FAILURE_ALERT_COOLDOWN_HOURS
  ) * 3600e3;
  const previous = (runs || [])
    .filter((run) => String(run?.id || '') !== currentRunId)
    .filter((run) => ['success', 'failure', 'cancelled', 'timed_out', 'action_required'].includes(run?.conclusion))
    .map((run) => ({ ...run, timestamp: parseTime(run.updated_at || run.run_started_at || run.created_at) }))
    .filter((run) => run.timestamp != null && run.timestamp <= now)
    .sort((left, right) => right.timestamp - left.timestamp)[0] || null;

  if (!previous || previous.conclusion === 'success') {
    return { shouldNotify: true, reason: previous ? 'failure-after-success' : 'no-history', previous };
  }
  if (now - previous.timestamp < cooldownMs) {
    return { shouldNotify: false, reason: 'repeat-failure-cooldown', previous, cooldownMs };
  }
  return { shouldNotify: true, reason: 'repeat-failure-reminder', previous, cooldownMs };
}

async function fetchRecentMonitorRuns(env, fetchImpl) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (!repo || !token) throw new Error('Missing GitHub failure-dedupe configuration');
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/runs?per_page=20`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'negative-comment-monitor-failure-alert',
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  return payload.workflow_runs || [];
}

export async function notifyFailure(env = process.env, fetchImpl = fetch) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) throw new Error('Missing Slack failure notification configuration');

  try {
    const runs = await fetchRecentMonitorRuns(env, fetchImpl);
    const decision = evaluateFailureAlert(runs, env);
    if (!decision.shouldNotify) {
      console.log(`[notify-failure] suppressed: ${decision.reason}`);
      return { ok: true, suppressed: true, reason: decision.reason };
    }
  } catch (error) {
    // Failure alerts are a safety net. If GitHub history itself cannot be read,
    // fail open and preserve the first visible signal instead of hiding an outage.
    console.error(`[notify-failure] dedupe unavailable; posting alert: ${error.message}`);
  }

  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text: buildFailureMessage(env) }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  notifyFailure().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
