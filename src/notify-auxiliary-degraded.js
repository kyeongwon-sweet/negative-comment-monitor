export function buildAuxiliaryDegradedMessage(env = process.env) {
  const owner = String(env.SLACK_ASSIGNEE_OTHER || '').trim();
  const runUrl = String(env.FAILURE_RUN_URL || '').trim();
  const component = String(env.AUXILIARY_COMPONENT || '보조 모니터').trim();
  const reason = String(env.AUXILIARY_REASON || '').trim();
  return [
    `⚠️ *${component} degraded*`,
    '핵심 부정댓글 모니터링 전체 장애가 아닙니다. 이번 보조 회차의 일부 기능만 다음 실행에서 자동 재시도합니다.',
    reason ? `구간: ${reason}` : '',
    owner ? `담당자: <@${owner}>` : '',
    runUrl ? `<${runUrl}|보조 모니터 실행 로그 열기>` : '',
  ].filter(Boolean).join('\n');
}

export async function notifyAuxiliaryDegraded(env = process.env, fetchImpl = fetch) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) throw new Error('Missing Slack degraded notification configuration');
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text: buildAuxiliaryDegradedMessage(env) }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  notifyAuxiliaryDegraded().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
