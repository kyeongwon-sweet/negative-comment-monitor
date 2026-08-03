import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStaleMessage, runHeartbeatCheck } from '../src/heartbeat-check.js';

const NOW = Date.parse('2026-08-03T05:00:00Z'); // 2026-08-03 14:00 KST
const ENV = {
  GITHUB_REPOSITORY: 'owner/repo',
  GH_TOKEN: 'token',
  GITHUB_REF_NAME: 'master',
  SLACK_BOT_TOKEN: 'slack-token',
  SLACK_CHANNEL_ID: 'C123',
  SLACK_ASSIGNEE_OTHER: 'U123',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('healthy heartbeat does not dispatch or notify', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({
      workflow_runs: [{ conclusion: 'success', run_started_at: '2026-08-03T01:00:00Z' }],
    });
  };

  const result = await runHeartbeatCheck(ENV, NOW, fetchImpl);

  assert.deepEqual(result, { warned: false, dispatched: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /monitor\.yml\/runs/);
});

test('stale heartbeat dispatches monitor once and then notifies Slack', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/runs?')) {
      return jsonResponse({
        workflow_runs: [{ conclusion: 'success', run_started_at: '2026-08-02T01:00:00Z' }],
      });
    }
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
    if (url === 'https://slack.com/api/chat.postMessage') return jsonResponse({ ok: true });
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await runHeartbeatCheck(ENV, NOW, fetchImpl);

  assert.deepEqual(result, { warned: true, dispatched: true });
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /monitor\.yml\/dispatches$/);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ref: 'master' });
  assert.equal(calls[2].url, 'https://slack.com/api/chat.postMessage');
  const slackBody = JSON.parse(calls[2].options.body);
  assert.match(slackBody.text, /자동 요청했습니다/);
});

test('stale message distinguishes automatic recovery from manual-only warning', () => {
  assert.match(buildStaleMessage(NOW, null, '', true), /자가치유/);
  assert.doesNotMatch(buildStaleMessage(NOW, null, '', false), /자가치유/);
});
