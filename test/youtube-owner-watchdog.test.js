import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerWatchdogMessage, evaluateOwnerWorkflowHealth, runYouTubeOwnerWatchdog } from '../src/youtube-owner-watchdog.js';

const NOW = Date.parse('2026-08-21T05:00:00Z');
const ENV = {
  GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'gh', GITHUB_REF_NAME: 'master',
  SLACK_BOT_TOKEN: 'slack', SLACK_CHANNEL_ID: 'C123', SLACK_ASSIGNEE_OTHER: 'U123',
};

function job(schema = 'success', monitor = 'success') {
  return [{ name: 'monitor', steps: [
    { name: 'Verify owner-channel schema contract', conclusion: schema },
    { name: 'Run owner-channel monitor', conclusion: monitor },
  ] }];
}

function json(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('job이 success여도 schema/monitor step 실패면 건강한 회차로 보지 않는다', () => {
  const runs = [{ id: 1, status: 'completed', conclusion: 'success', run_started_at: '2026-08-21T03:00:00Z' }];
  assert.equal(evaluateOwnerWorkflowHealth(runs, new Map([['1', job('failure', 'skipped')]]), NOW).healthy, false);
  assert.equal(evaluateOwnerWorkflowHealth(runs, new Map([['1', job()]]), NOW).healthy, true);
});

test('stale이면 보조 워크플로만 재실행하고 구분된 Slack 경고를 보낸다', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/runs?')) return json({ workflow_runs: [{ id: 1, status: 'completed', run_started_at: '2026-08-20T00:00:00Z' }] });
    if (url.includes('/runs/1/jobs')) return json({ jobs: job('failure', 'skipped') });
    if (url.endsWith('/dispatches')) return json(null, 204);
    if (url === 'https://slack.com/api/chat.postMessage') return json({ ok: true });
    throw new Error(`unexpected ${url}`);
  };
  const result = await runYouTubeOwnerWatchdog(ENV, NOW, fetchImpl);
  assert.equal(result.dispatched, true);
  assert.equal(calls.filter((call) => call.url.endsWith('/dispatches')).length, 1);
  const slack = JSON.parse(calls.find((call) => call.url === 'https://slack.com/api/chat.postMessage').options.body);
  assert.match(slack.text, /보조 모니터/);
  assert.doesNotMatch(slack.text, /부정댓글 모니터링 실행 실패/);
});

test('최근 schema+monitor step 성공이면 조용히 종료한다', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/runs?')) return json({ workflow_runs: [{ id: 2, status: 'completed', run_started_at: '2026-08-21T03:00:00Z' }] });
    if (url.includes('/runs/2/jobs')) return json({ jobs: job() });
    throw new Error(`unexpected ${url}`);
  };
  const result = await runYouTubeOwnerWatchdog(ENV, NOW, fetchImpl);
  assert.equal(result.warned, false);
  assert.equal(calls.length, 2);
  assert.match(buildOwnerWatchdogMessage({ lastHealthyAt: null }, ENV), /전체 장애가 아닙니다/);
});
