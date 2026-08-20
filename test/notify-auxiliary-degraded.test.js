import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuxiliaryDegradedMessage, notifyAuxiliaryDegraded } from '../src/notify-auxiliary-degraded.js';

const ENV = {
  SLACK_BOT_TOKEN: 'xoxb-test', SLACK_CHANNEL_ID: 'C123', SLACK_ASSIGNEE_OTHER: 'U123',
  AUXILIARY_COMPONENT: 'YouTube 소유채널 보조 모니터', AUXILIARY_REASON: 'schema-preflight',
  FAILURE_RUN_URL: 'https://github.test/run/1',
};

test('보조 degraded 알림은 핵심 전체 실패와 명확히 구분한다', () => {
  const text = buildAuxiliaryDegradedMessage(ENV);
  assert.match(text, /보조 모니터 degraded/);
  assert.match(text, /전체 장애가 아닙니다/);
  assert.doesNotMatch(text, /부정댓글 모니터링 실행 실패/);
  assert.match(text, /schema-preflight/);
});

test('보조 degraded 알림을 지정 Slack 채널에 발송한다', async () => {
  let body;
  await notifyAuxiliaryDegraded(ENV, async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(body.channel, 'C123');
  assert.match(body.text, /YouTube 소유채널/);
});
