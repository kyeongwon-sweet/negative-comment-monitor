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
  const category = comment.risk?.category || '부정';
  // 한 라인: [채널분류] 채널명(업체명) / 작성자 / 댓글  — 채널명은 게시글 링크, 업체명은 바이럴만.
  const isViral = /바이럴/.test(target.channelCategory || '');
  const company = esc(String(target.company || '').trim());
  const channel = esc(target.channelName || '-');
  const author = esc(comment.username || '-');
  const text = esc(String(comment.text || '').replace(/\s+/g, ' ').trim());
  const companyPart = (isViral && company) ? ` (${company})` : '';
  const mainLine = `[${esc(target.channelCategory || '-')}] <${target.url}|${channel}>${companyPart} / ${author} / ${text}`;
  const assigneeId = assigneeForChannelCategory(target.channelCategory, assignees);
  return [
    { type: 'header', text: { type: 'plain_text', text: `🚨 부정댓글 감지 — ${comment.platform}` } },
    { type: 'section', text: { type: 'mrkdwn', text: mainLine } },
    ...(assigneeId ? [{ type: 'section', text: { type: 'mrkdwn', text: `*담당자*\n<@${assigneeId}>` } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `분류 *${esc(category)}* (${esc(reason)}) · 작성 ${formatKst(comment.timestamp)} · 미처리 ⏳` }] },
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
