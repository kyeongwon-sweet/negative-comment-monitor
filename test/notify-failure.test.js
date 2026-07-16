import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFailureMessage, notifyFailure } from '../src/notify-failure.js';

test('failure notification includes the operator mention and run URL', () => {
  const message = buildFailureMessage({
    SLACK_ASSIGNEE_OTHER: 'U_OPERATOR',
    FAILURE_RUN_URL: 'https://github.com/example/actions/runs/1',
  });
  assert.match(message, /<@U_OPERATOR>/);
  assert.match(message, /GitHub Actions 실패 로그 열기/);
});

test('posts failure notification to the configured Slack channel', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { json: async () => ({ ok: true, ts: '1.2' }) };
  };
  const result = await notifyFailure({
    SLACK_BOT_TOKEN: 'token',
    SLACK_CHANNEL_ID: 'C1',
    SLACK_ASSIGNEE_OTHER: 'U1',
  }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(request.options.body).channel, 'C1');
});
