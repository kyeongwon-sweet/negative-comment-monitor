import { verifySlackSignature } from './slack.js';

const allowedActions = new Set(['hide', 'approve', 'hold', 'unhide', 'complete', 'ignore']);
const statusLabels = {
  hide: '숨김 완료 🚫', approve: '승인 완료 ✅', hold: '보류 ⏸️', unhide: '숨김해제 완료 👁️',
  complete: '처리완료 ✅', ignore: '무시 🙈',
};

async function json(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export async function handleSlackInteraction(config, request, fetchImpl = fetch, now = Date.now()) {
  const rawBody = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!verifySlackSignature({ signingSecret: config.slackSigningSecret, timestamp, signature, rawBody, now })) {
    return new Response('invalid signature', { status: 401 });
  }

  const payload = JSON.parse(new URLSearchParams(rawBody).get('payload') || '{}');
  const action = payload.actions?.[0];
  if (!action || !allowedActions.has(action.action_id)) return new Response('unsupported action', { status: 400 });
  const value = JSON.parse(action.value || '{}');

  const gasUrl = new URL(config.gasWebAppUrl);
  gasUrl.searchParams.set('action', 'sponsoredSlackAction');
  gasUrl.searchParams.set('key', config.gasVerifyToken);
  await json(await fetchImpl(gasUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...value, decision: action.action_id, slackUserId: payload.user?.id || '', slackMessageTs: payload.message?.ts || '' }),
  }));

  const blocks = (payload.message?.blocks || []).filter((block) => block.type !== 'actions');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${statusLabels[action.action_id]}* · 처리자 <@${payload.user.id}>` }] });
  const slackResult = await json(await fetchImpl('https://slack.com/api/chat.update', {
    method: 'POST', headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: payload.channel.id, ts: payload.message.ts, text: statusLabels[action.action_id], blocks }),
  }));
  return Response.json({ ok: true, ts: slackResult.ts || payload.message.ts });
}
