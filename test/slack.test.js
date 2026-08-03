import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { actionDefinitions, assigneeForChannelCategory, assigneeForTarget, buildAlertBlocks, productGroup, sendAlert, verifySlackSignature } from '../src/slack.js';

const assignees = {
  satellite: 'U_SATELLITE',
  viralBanner: 'U_BANNER',
  viralVideoOwned: 'U_VIDEO_OWNED',
  other: 'U_OTHER',
  sponsorship: 'U_SPONSORSHIP',
  jd: { sponsorship: 'U_JD_SPON', viralBanner: 'U_JD_BANNER', viralVideo: 'U_JD_VIDEO', satellite: 'U_JD_SAT' },
  p: { viralBanner: 'U_P_BANNER', viralVideo: 'U_P_VIDEO' },
};

test('owned media and satellite channels get moderation buttons', () => {
  assert.deepEqual(actionDefinitions({ channelCategory: '온드미디어' }).map((item) => item[1]), ['hide', 'approve', 'hold', 'unhide']);
  assert.deepEqual(actionDefinitions({ channelCategory: '위성채널_빙과' }).map((item) => item[1]), ['hide', 'approve', 'hold', 'unhide']);
});
test('external channels only get complete and ignore buttons', () => {
  assert.deepEqual(actionDefinitions({ channelCategory: '유상협찬' }).map((item) => item[1]), ['complete', 'ignore']);
});
test('alert blocks include ownership-specific action buttons', () => {
  const blocks = buildAlertBlocks({ row: 1, url: 'https://example.com', channelCategory: '유상협찬' }, { id: 'c1', platform: 'youtube', text: '라라스윗 별로', risk: {} });
  assert.equal(blocks.at(-1).elements.length, 2);
});
test('routes channel categories to the requested Slack assignees', () => {
  assert.equal(assigneeForChannelCategory('위성채널_빙과', assignees), 'U_SATELLITE');
  assert.equal(assigneeForChannelCategory('바이럴(배너)', assignees), 'U_BANNER');
  assert.equal(assigneeForChannelCategory('바이럴(영상)', assignees), 'U_VIDEO_OWNED');
  assert.equal(assigneeForChannelCategory('온드미디어', assignees), 'U_VIDEO_OWNED');
  assert.equal(assigneeForChannelCategory('유상협찬', assignees), 'U_SPONSORSHIP');
  assert.equal(assigneeForChannelCategory('PPL', assignees), 'U_OTHER');
});
test('productGroup: JD 포함=jd, P로 시작=p, 그 외=other', () => {
  assert.equal(productGroup('JD멜'), 'jd');
  assert.equal(productGroup('JD망'), 'jd');
  assert.equal(productGroup('P혼'), 'p');
  assert.equal(productGroup('P망'), 'p');
  assert.equal(productGroup('DB혼'), 'other');
  assert.equal(productGroup('C혼'), 'other');
  assert.equal(productGroup(''), 'other');
});
test('assigneeForTarget: 상품×카테고리 라우팅 + 미지정은 카테고리 기본값 폴백', () => {
  // JD 상품
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '협찬 (인플루언서)' }, assignees), 'U_JD_SPON');
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '바이럴 (배너)' }, assignees), 'U_JD_BANNER');
  assert.equal(assigneeForTarget({ productName: 'JD망', channelCategory: '바이럴 (영상)' }, assignees), 'U_JD_VIDEO');
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '위성채널' }, assignees), 'U_JD_SAT');
  // P 상품(배너·영상만 지정) — 나머지는 폴백
  assert.equal(assigneeForTarget({ productName: 'P혼', channelCategory: '바이럴 (배너)' }, assignees), 'U_P_BANNER');
  assert.equal(assigneeForTarget({ productName: 'P망', channelCategory: '바이럴 (영상)' }, assignees), 'U_P_VIDEO');
  assert.equal(assigneeForTarget({ productName: 'P혼', channelCategory: '협찬 (인플루언서)' }, assignees), 'U_SPONSORSHIP');
  // 기타 상품(듬뿍바 등) → 현재 카테고리 담당자 유지
  assert.equal(assigneeForTarget({ productName: 'DB혼', channelCategory: '바이럴 (배너)' }, assignees), 'U_BANNER');
  assert.equal(assigneeForTarget({ productName: 'DB딸', channelCategory: '위성채널' }, assignees), 'U_SATELLITE');
  // 상품 정보 없음 → 폴백(하위호환)
  assert.equal(assigneeForTarget({ channelCategory: '유상협찬' }, assignees), 'U_SPONSORSHIP');
});
test('alert blocks mention the category assignee', () => {
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '바이럴(배너)' },
    { id: 'c1', platform: 'instagram', text: '라라스윗 별로', risk: {} },
    undefined,
    assignees,
  );
  assert.ok(blocks.some((block) => block.text?.text === '*담당자*\n<@U_BANNER>'));
});
test('작성자는 메인 라인에만, 필드엔 중복 없음(B2)', () => {
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '유상협찬' },
    { id: 'c1', platform: 'instagram', username: 'hater123', text: '라라스윗 별로', risk: {} },
  );
  const mainLine = blocks[2].text.text;
  assert.match(mainLine, /hater123/); // 메인 라인에 작성자 있음
  const fieldsBlock = blocks.find((b) => Array.isArray(b.fields));
  assert.ok(!fieldsBlock.fields.some((f) => f.text.includes('*작성자*'))); // 필드에 작성자 중복 없음
  assert.equal(fieldsBlock.fields.length, 2); // 현재상태 + 작성시간
});
test('긴 댓글은 잘려서 블록 한도 방어(B3)', () => {
  const long = '가'.repeat(2000);
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '유상협찬' },
    { id: 'c1', platform: 'instagram', username: 'u', text: long, risk: {} },
  );
  assert.ok(blocks[2].text.text.length < 700); // 500자 + 링크/작성자 오버헤드
  assert.match(blocks[2].text.text, /…/);
});
test('verifies valid Slack signatures and rejects stale requests', () => {
  const secret = 'test-secret'; const timestamp = '1000'; const rawBody = 'payload=x';
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody, now: 1000 * 1000 }), true);
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody, now: 2000 * 1000 }), false);
});

test('sendAlert: threadTs 주면 thread_ts로 답글 발송, 없으면 최상위', async () => {
  const cfg = { slackBotToken: 'tok', slackChannelId: 'C1', managedChannelCategories: [], slackAssignees: {} };
  const target = { url: 'https://x.com/u/status/1', channelName: 'ch', channelCategory: '바이럴 (배너)', platform: 'twitter' };
  const comment = { id: 'c1', platform: 'twitter', text: '광고 별로', username: 'u', timestamp: '1700000000' };
  let body;
  const fetchImpl = async (url, opts) => { body = JSON.parse(opts.body); return { json: async () => ({ ok: true, ts: '1.1' }) }; };
  await sendAlert(cfg, target, comment, fetchImpl, '555.666');
  assert.equal(body.thread_ts, '555.666');
  await sendAlert(cfg, target, comment, fetchImpl); // threadTs 없음
  assert.ok(!('thread_ts' in body), '스레드 없으면 최상위 발송');
});

test('sendAlert: 기존 완료 스레드에 새 답글을 달기 전에 완료 반응을 제거', async () => {
  const cfg = { slackBotToken: 'tok', slackChannelId: 'C1', managedChannelCategories: [], slackAssignees: {} };
  const target = { url: 'https://x.com/u/status/1', channelName: 'ch', channelCategory: 'PPL', platform: 'twitter' };
  const comment = { id: 'c1', platform: 'twitter', text: '광고 별로', username: 'u', timestamp: '1700000000' };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { json: async () => ({ ok: true, ts: '1.1' }) };
  };
  await sendAlert(cfg, target, comment, fetchImpl, '555.666');
  assert.match(calls[0].url, /reactions\.remove/);
  assert.equal(calls[0].body.timestamp, '555.666');
  assert.equal(calls[0].body.name, '완료느낌표');
  assert.match(calls[1].url, /chat\.postMessage/);
  assert.equal(calls[1].body.thread_ts, '555.666');
});
