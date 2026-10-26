import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFailureMessage, evaluateFailureAlert, notifyFailure } from '../src/notify-failure.js';

const GITHUB_ENV = {
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_RUN_ID: '200',
  GH_TOKEN: 'gh-token',
};

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
    if (String(url).includes('api.github.com')) {
      return {
        ok: true,
        json: async () => ({
          workflow_runs: [{ id: 199, conclusion: 'success', updated_at: new Date().toISOString() }],
        }),
      };
    }
    request = { url, options };
    return { json: async () => ({ ok: true, ts: '1.2' }) };
  };
  const result = await notifyFailure({
    ...GITHUB_ENV,
    SLACK_BOT_TOKEN: 'token',
    SLACK_CHANNEL_ID: 'C1',
    SLACK_ASSIGNEE_OTHER: 'U1',
  }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(request.options.body).channel, 'C1');
});

test('suppresses a repeated monitor failure inside the cooldown', () => {
  const now = Date.parse('2026-10-26T01:00:00Z');
  const result = evaluateFailureAlert([
    { id: 200, conclusion: null, updated_at: '2026-10-26T01:00:00Z' },
    { id: 199, conclusion: 'failure', updated_at: '2026-10-26T00:30:00Z' },
  ], GITHUB_ENV, now);
  assert.equal(result.shouldNotify, false);
  assert.equal(result.reason, 'repeat-failure-cooldown');
});

test('notifies on the first failure after recovery', () => {
  const result = evaluateFailureAlert([
    { id: 199, conclusion: 'success', updated_at: '2026-10-26T00:30:00Z' },
  ], GITHUB_ENV, Date.parse('2026-10-26T01:00:00Z'));
  assert.equal(result.shouldNotify, true);
  assert.equal(result.reason, 'failure-after-success');
});

test('posts a reminder when the repeated failure cooldown expires', () => {
  const result = evaluateFailureAlert([
    { id: 199, conclusion: 'failure', updated_at: '2026-10-25T12:00:00Z' },
  ], GITHUB_ENV, Date.parse('2026-10-26T01:00:00Z'));
  assert.equal(result.shouldNotify, true);
  assert.equal(result.reason, 'repeat-failure-reminder');
});

test('does not call Slack when a repeated failure is suppressed', async () => {
  let slackCalled = false;
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com')) {
      return {
        ok: true,
        json: async () => ({
          workflow_runs: [{ id: 199, conclusion: 'failure', updated_at: new Date().toISOString() }],
        }),
      };
    }
    slackCalled = true;
    return { json: async () => ({ ok: true }) };
  };
  const result = await notifyFailure({
    ...GITHUB_ENV,
    SLACK_BOT_TOKEN: 'token',
    SLACK_CHANNEL_ID: 'C1',
  }, fetchImpl);
  assert.equal(result.suppressed, true);
  assert.equal(slackCalled, false);
});
