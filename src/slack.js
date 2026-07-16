import { createHmac, timingSafeEqual } from 'node:crypto';
import { isManagedChannel } from './routing.js';

const managedActions = [['숨김', 'hide', 'danger'], ['승인', 'approve', 'primary'], ['보류', 'hold'], ['숨김해제', 'unhide']];
const externalActions = [['✅ 완료', 'complete', 'primary'], ['🙈 무시', 'ignore']];

function button([text, actionId, style], value) {
  return { type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value, ...(style ? { style } : {}) };
}

export function actionDefinitions(target, managedCategories) {
  return isManagedChannel(target, managedCategories) ? managedActions : externalActions;
}

export function assigneeForChannelCategory(channelCategory, assignees = {}) {
  const category = String(channelCategory || '').trim().toLowerCase();
  if (category.includes('위성채널')) return assignees.satellite || '';
  if (category.includes('바이럴') && category.includes('배너')) return assignees.viralBanner || '';
  if ((category.includes('바이럴') && category.includes('영상')) || category.includes('온드미디어')) {
    return assignees.viralVideoOwned || '';
  }
  if (category.includes('협찬')) return assignees.sponsorship || '';
  return assignees.other || '';
}

function esc(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 작성시간을 KST 'YYYY-MM-DD HH:mm KST'로. epoch(초/밀리초)·ISO 모두 처리.
export function formatKst(ts) {
  if (!ts && ts !== 0) return '-';
  const s = String(ts).trim();
  let ms;
  if (/^\d{9,}$/.test(s)) ms = Number(s) * (s.length <= 10 ? 1000 : 1);
  else { const t = Date.parse(s); if (!Number.isFinite(t)) return s; ms = t; }
  const k = new Date(ms + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 16).replace('T', ' ') + ' KST';
}

export function buildAlertBlocks(target, comment, managedCategories = ['온드미디어', '위성채널'], assignees = {}) {
  const value = JSON.stringify({ row: target.row, commentId: comment.id, platform: comment.platform, url: target.url });
  const reason = comment.risk?.matchedTerms?.join(', ') || comment.risk?.reason || '부정 표현';
  // 채널 유형 = [채널분류] 계정명 - 캡션 (게시글로 하이퍼링크)
  const account = esc(target.channelName || '-');
  const caption = esc(String(target.caption || '').replace(/\s+/g, ' ').trim().slice(0, 50));
  const channelLine = `<${target.url}|[${esc(target.channelCategory || '-')}] ${account}${caption ? ` - ${caption}` : ''}>`;
  const assigneeId = assigneeForChannelCategory(target.channelCategory, assignees);
  return [
    { type: 'header', text: { type: 'plain_text', text: `🚨 부정댓글 감지 — ${comment.platform}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*채널 유형*\n${channelLine}` } },
    ...(assigneeId ? [{ type: 'section', text: { type: 'mrkdwn', text: `*담당자*\n<@${assigneeId}>` } }] : []),
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*현재상태*\n미처리 ⏳' },
      { type: 'mrkdwn', text: `*작성자*\n${esc(comment.username) || '-'}` },
      { type: 'mrkdwn', text: `*작성시간*\n${formatKst(comment.timestamp)}` },
    ] },
    { type: 'section', text: { type: 'mrkdwn', text: `*댓글*\n${esc(comment.text)}\n\n*분류 근거*\n${esc(reason)}` } },
    { type: 'actions', elements: actionDefinitions(target, managedCategories).map((definition) => button(definition, value)) },
  ];
}

export async function sendAlert(config, target, comment, fetchImpl = fetch) {
  if (!config.slackBotToken) throw new Error('Missing environment variable: SLACK_BOT_TOKEN');
  const blocks = buildAlertBlocks(target, comment, config.managedChannelCategories, config.slackAssignees);
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text: `부정댓글 감지: ${comment.text}`, blocks }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!signingSecret || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const left = Buffer.from(expected); const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
