import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHealthWarning,
  buildStaleMessage,
  dailyStartInstant,
  evaluateHealth,
  maximumSuccessGap,
  runHeartbeatCheck,
} from '../src/heartbeat-check.js';

const NOW = Date.parse('2026-08-03T05:00:00Z'); // 2026-08-03 14:00 KST
const ENV = {
  GITHUB_REPOSITORY: 'owner/repo',
  GH_TOKEN: 'token',
  GITHUB_REF_NAME: 'master',
  SLACK_BOT_TOKEN: 'slack-token',
  SLACK_CHANNEL_ID: 'C123',
  SLACK_ASSIGNEE_OTHER: 'U123',
};

const STATEFUL_ENV = {
  ...ENV,
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  HEARTBEAT_ALERT_COOLDOWN_HOURS: '24',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function statefulHeartbeatFetch(initialRuns) {
  let runs = initialRuns;
  let state = null;
  const calls = { dispatch: 0, slack: 0, stateWrites: 0 };
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/actions/workflows/monitor.yml/runs?')) {
      return jsonResponse({ workflow_runs: runs });
    }
    if (value.includes('/rest/v1/monitor_scan_heartbeats?')) {
      return jsonResponse([]);
    }
    if (value.includes('/rest/v1/platform_collection_health?platform=eq.')) {
      return jsonResponse(state ? [state] : []);
    }
    if (value.includes('/rest/v1/platform_collection_health?on_conflict=platform')) {
      state = JSON.parse(options.body);
      calls.stateWrites += 1;
      return jsonResponse([state]);
    }
    if (value.endsWith('/actions/workflows/monitor.yml/dispatches')) {
      calls.dispatch += 1;
      return new Response(null, { status: 204 });
    }
    if (value === 'https://slack.com/api/chat.postMessage') {
      calls.slack += 1;
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected URL: ${value}`);
  };
  return {
    calls,
    fetchImpl,
    getState: () => state,
    setRuns: (next) => { runs = next; },
  };
}

test('healthy heartbeat does not dispatch or notify', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({
      workflow_runs: [
        { conclusion: 'success', run_started_at: '2026-08-03T03:30:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-03T01:00:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T22:30:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T20:00:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T17:30:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T15:00:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T12:30:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T10:00:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T07:30:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-02T05:00:00Z' },
      ],
    });
  };

  const result = await runHeartbeatCheck(ENV, NOW, fetchImpl);

  assert.deepEqual(result, { warned: false, dispatched: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /monitor\.yml\/runs/);
});

test('before 09:10 KST, yesterday 09:10 is the health threshold', () => {
  const beforeCutoff = Date.parse('2026-08-27T15:56:00Z'); // 2026-08-28 00:56 KST
  assert.equal(dailyStartInstant(beforeCutoff), Date.parse('2026-08-27T00:10:00Z'));

  const atCutoff = Date.parse('2026-08-28T00:10:00Z'); // 2026-08-28 09:10 KST
  assert.equal(dailyStartInstant(atCutoff), atCutoff);
});

test('delayed heartbeat before 09:10 accepts a success from the previous evening', async () => {
  const beforeCutoff = Date.parse('2026-08-27T15:56:00Z'); // 2026-08-28 00:56 KST
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({
      workflow_runs: [
        { conclusion: 'success', run_started_at: '2026-08-27T13:56:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-27T11:26:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-27T08:56:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-27T06:26:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-27T03:56:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-27T01:26:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-26T22:56:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-26T20:26:00Z' },
        { conclusion: 'success', run_started_at: '2026-08-26T17:56:00Z' },
      ],
    });
  };

  const result = await runHeartbeatCheck(ENV, beforeCutoff, fetchImpl);

  assert.deepEqual(result, { warned: false, dispatched: false });
  assert.equal(calls.length, 1);
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

test('stale message shows the actual rolled-back threshold date before 09:10 KST', () => {
  const beforeCutoff = Date.parse('2026-08-27T15:56:00Z'); // 2026-08-28 00:56 KST
  const message = buildStaleMessage(beforeCutoff, null, '', true);

  assert.match(message, /기준일\(2026-08-27\) 09:10 KST/);
  assert.doesNotMatch(message, /기준일\(2026-08-28\) 09:10 KST/);
});

test('same unhealthy state alerts once within 24 hours and alerts again after cooldown', async () => {
  const staleRuns = [{ conclusion: 'success', run_started_at: '2026-08-02T01:00:00Z' }];
  const harness = statefulHeartbeatFetch(staleRuns);

  const first = await runHeartbeatCheck(STATEFUL_ENV, NOW, harness.fetchImpl);
  const duplicate = await runHeartbeatCheck(STATEFUL_ENV, NOW + 3 * 60 * 60 * 1000, harness.fetchImpl);
  const nextDay = await runHeartbeatCheck(STATEFUL_ENV, NOW + 25 * 60 * 60 * 1000, harness.fetchImpl);

  assert.deepEqual(first, { warned: true, dispatched: true });
  assert.deepEqual(duplicate, { warned: false, dispatched: false, suppressed: true });
  assert.deepEqual(nextDay, { warned: true, dispatched: true });
  assert.equal(harness.calls.dispatch, 2);
  assert.equal(harness.calls.slack, 2);
  assert.equal(harness.getState().last_alerted_at, new Date(NOW + 25 * 60 * 60 * 1000).toISOString());
});

test('healthy observation resets heartbeat alert cooldown before a new incident', async () => {
  const harness = statefulHeartbeatFetch([
    { conclusion: 'success', run_started_at: '2026-08-02T01:00:00Z' },
  ]);
  await runHeartbeatCheck(STATEFUL_ENV, NOW, harness.fetchImpl);

  const healthyNow = NOW + 60 * 60 * 1000;
  harness.setRuns([
    { conclusion: 'success', run_started_at: new Date(healthyNow - 30 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 3 * 60 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 6 * 60 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 9 * 60 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 12 * 60 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 15 * 60 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 18 * 60 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 21 * 60 * 60 * 1000).toISOString() },
    { conclusion: 'success', run_started_at: new Date(healthyNow - 23.5 * 60 * 60 * 1000).toISOString() },
  ]);
  const healthy = await runHeartbeatCheck(STATEFUL_ENV, healthyNow, harness.fetchImpl);
  assert.deepEqual(healthy, { warned: false, dispatched: false });
  assert.equal(harness.getState().last_alerted_at, null);

  harness.setRuns([{ conclusion: 'success', run_started_at: '2026-08-02T01:00:00Z' }]);
  const newIncident = await runHeartbeatCheck(STATEFUL_ENV, healthyNow + 60 * 60 * 1000, harness.fetchImpl);
  assert.deepEqual(newIncident, { warned: true, dispatched: true });
  assert.equal(harness.calls.dispatch, 2);
  assert.equal(harness.calls.slack, 2);
});

test('heartbeat state storage failure fails open and still alerts', async () => {
  const calls = { dispatch: 0, slack: 0 };
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes('/actions/workflows/monitor.yml/runs?')) {
      return jsonResponse({
        workflow_runs: [{ conclusion: 'success', run_started_at: '2026-08-02T01:00:00Z' }],
      });
    }
    if (value.includes('/rest/v1/platform_collection_health?platform=eq.')) {
      return jsonResponse({ error: 'temporary failure' }, 500);
    }
    if (value.endsWith('/actions/workflows/monitor.yml/dispatches')) {
      calls.dispatch += 1;
      return new Response(null, { status: 204 });
    }
    if (value === 'https://slack.com/api/chat.postMessage') {
      calls.slack += 1;
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  const result = await runHeartbeatCheck(STATEFUL_ENV, NOW, fetchImpl);

  assert.deepEqual(result, { warned: true, dispatched: true });
  assert.deepEqual(calls, { dispatch: 1, slack: 1 });
});

test('maximum gap includes the 24-hour window boundaries', () => {
  const now = Date.parse('2026-09-21T08:00:00Z');
  const result = maximumSuccessGap([
    { conclusion: 'success', run_started_at: '2026-09-20T10:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T13:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T18:12:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T21:12:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T00:12:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T03:12:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T06:12:00Z' },
    { conclusion: 'failure', run_started_at: '2026-09-21T04:00:00Z' },
  ], now);

  assert.equal(result.durationMs, 5.2 * 60 * 60 * 1000);
  assert.equal(result.start, Date.parse('2026-09-20T13:00:00Z'));
  assert.equal(result.end, Date.parse('2026-09-20T18:12:00Z'));
});

test('actual iteration heartbeats replace the inflated run-start gap with the real scan gap', () => {
  const now = Date.parse('2026-09-21T10:15:00Z');
  const runs = [
    { conclusion: 'success', run_started_at: '2026-09-21T06:11:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T06:19:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T10:15:00Z' },
  ];
  const scanHeartbeats = [
    '2026-09-21T06:12:00Z',
    '2026-09-21T06:28:00Z',
    '2026-09-21T06:44:00Z',
    '2026-09-21T07:00:00Z',
    '2026-09-21T07:02:00Z',
    '2026-09-21T07:18:00Z',
    '2026-09-21T07:34:00Z',
    '2026-09-21T07:50:00Z',
  ];

  const result = maximumSuccessGap(runs, now, 5 * 60 * 60 * 1000, scanHeartbeats);

  assert.equal(result.durationMs, 2 * 60 * 60 * 1000 + 25 * 60 * 1000);
  assert.equal(result.start, Date.parse('2026-09-21T07:50:00Z'));
  assert.equal(result.end, Date.parse('2026-09-21T10:15:00Z'));
  assert.equal(result.scanHeartbeatCount, 8);
});

test('queued run starts after the first measured scan do not count as coverage', () => {
  const now = Date.parse('2026-09-21T10:15:00Z');
  const result = maximumSuccessGap([
    { conclusion: 'success', run_started_at: '2026-09-21T06:11:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T09:00:00Z' },
  ], now, 5 * 60 * 60 * 1000, [
    '2026-09-21T07:50:00Z',
    '2026-09-21T10:15:00Z',
  ]);

  assert.equal(result.durationMs, 2 * 60 * 60 * 1000 + 25 * 60 * 1000);
  assert.equal(result.start, Date.parse('2026-09-21T07:50:00Z'));
  assert.equal(result.end, Date.parse('2026-09-21T10:15:00Z'));
});

test('gap threshold fails independently from the existing morning check', () => {
  const now = Date.parse('2026-09-21T08:00:00Z'); // 17:00 KST
  const runs = [
    { conclusion: 'success', run_started_at: '2026-09-21T07:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T03:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T23:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T19:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T15:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T11:00:00Z' },
  ];
  const health = evaluateHealth(runs, now, 3.5 * 60 * 60 * 1000);

  assert.equal(health.dailyHealthy, true);
  assert.equal(health.gapHealthy, false);
  assert.equal(health.healthy, false);
  assert.equal(health.maximumGap.durationMs, 4 * 60 * 60 * 1000);
});

test('gap warning contains the measured duration and KST interval', () => {
  const now = Date.parse('2026-09-21T08:00:00Z');
  const health = evaluateHealth([
    { conclusion: 'success', run_started_at: '2026-09-21T07:00:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-21T01:48:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T22:48:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T19:48:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T16:48:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T13:48:00Z' },
    { conclusion: 'success', run_started_at: '2026-09-20T10:48:00Z' },
  ], now, 3.5 * 60 * 60 * 1000);
  const message = buildHealthWarning(now, health, 'U123', true);

  assert.match(message, /5시간 12분/);
  assert.match(message, /2026-09-21 10:48 KST → 2026-09-21 16:00 KST/);
  assert.match(message, /허용 임계: 3시간 30분/);
  assert.match(message, /<@U123>/);
});
