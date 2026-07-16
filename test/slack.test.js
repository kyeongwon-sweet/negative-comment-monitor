import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { actionDefinitions, buildAlertBlocks, verifySlackSignature } from '../src/slack.js';

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
test('verifies valid Slack signatures and rejects stale requests', () => {
  const secret = 'test-secret'; const timestamp = '1000'; const rawBody = 'payload=x';
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody, now: 1000 * 1000 }), true);
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody, now: 2000 * 1000 }), false);
});
