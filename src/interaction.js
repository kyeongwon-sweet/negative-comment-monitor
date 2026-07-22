import { verifySlackSignature } from './slack.js';
import { FALSE_POSITIVE_REASONS, recordFalsePositive } from './review.js';

const allowedActions = new Set(['hide', 'approve', 'hold', 'unhide', 'complete', 'ignore', 'fp_reason']);
const statusLabels = {
  hide: '숨김 완료 🚫', approve: '승인 완료 ✅', hold: '보류 ⏸️', unhide: '숨김해제 완료 👁️',
  complete: '처리완료 ✅', ignore: '무시 🙈 (오탐 기록됨)',
};
const reasonLabel = (value) => (FALSE_POSITIVE_REASONS.find((r) => r.value === value) || {}).label || value;

async function json(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

// 오탐 사유 선택 드롭다운(무시 후 노출). 선택 시 action_id 'fp_reason'로 다시 들어온다.
function reasonSelectBlock() {
  return {
    type: 'actions',
    elements: [{
      type: 'static_select',
      action_id: 'fp_reason',
      placeholder: { type: 'plain_text', text: '오탐 사유 선택(선택)' },
      options: FALSE_POSITIVE_REASONS.map((r) => ({ text: { type: 'plain_text', text: r.label }, value: r.value })),
    }],
  };
}

async function updateMessage(config, payload, text, blocks, fetchImpl) {
  return json(await fetchImpl('https://slack.com/api/chat.update', {
    method: 'POST', headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: payload.channel.id, ts: payload.message.ts, text, blocks }),
  }));
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

  const channelId = payload.channel?.id || '';
  const messageTs = payload.message?.ts || '';
  const userId = payload.user?.id || '';
  const baseBlocks = (payload.message?.blocks || []).filter((block) => block.type !== 'actions');

  // 오탐 사유 선택(무시 후속) — GAS 호출 없이 사유만 갱신. 행 식별은 slack_channel_id + slack_ts.
  if (action.action_id === 'fp_reason') {
    const reason = action.selected_option?.value || '';
    await recordFalsePositive(config, { slackChannelId: channelId, slackTs: messageTs, reviewedBy: userId, reason, now }, fetchImpl);
    const blocks = [...baseBlocks, { type: 'context', elements: [{ type: 'mrkdwn', text: `*오탐 사유: ${reasonLabel(reason)}* · 처리자 <@${userId}>` }] }];
    const result = await updateMessage(config, payload, `오탐 사유: ${reasonLabel(reason)}`, blocks, fetchImpl);
    return Response.json({ ok: true, ts: result.ts || messageTs });
  }

  // 그 외 결정: GAS 상태 갱신(기존 경로). value에 댓글 원문은 없다(row/commentId/platform/url).
  const value = JSON.parse(action.value || '{}');
  const gasUrl = new URL(config.gasWebAppUrl);
  gasUrl.searchParams.set('action', 'sponsoredSlackAction');
  gasUrl.searchParams.set('key', config.gasVerifyToken);
  await json(await fetchImpl(gasUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...value, decision: action.action_id, slackUserId: userId, slackMessageTs: messageTs }),
  }));

  // [무시] → 오탐 피드백 기록(분류기 반영용). 식별=slack_channel_id + slack_ts(댓글 원문 미사용).
  // classifier_hash는 알림 당시 저장된 값을 보존(여기서 덮어쓰지 않음). best-effort.
  const blocks = [...baseBlocks, { type: 'context', elements: [{ type: 'mrkdwn', text: `*${statusLabels[action.action_id]}* · 처리자 <@${userId}>` }] }];
  if (action.action_id === 'ignore') {
    await recordFalsePositive(config, { slackChannelId: channelId, slackTs: messageTs, reviewedBy: userId, now }, fetchImpl);
    blocks.push(reasonSelectBlock());
  }
  const result = await updateMessage(config, payload, statusLabels[action.action_id], blocks, fetchImpl);
  return Response.json({ ok: true, ts: result.ts || messageTs });
}
