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

export async function notifyFailure(env = process.env, fetchImpl = fetch) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) throw new Error('Missing Slack failure notification configuration');
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
