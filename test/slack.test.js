import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { actionDefinitions, assigneeForChannelCategory, buildAlertBlocks, verifySlackSignature } from '../src/slack.js';

const assignees = {
  satellite: 'U_SATELLITE',
  viralBanner: 'U_BANNER',
  viralVideoOwned: 'U_VIDEO_OWNED',
  other: 'U_OTHER',
  sponsorship: 'U_SPONSORSHIP',
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
