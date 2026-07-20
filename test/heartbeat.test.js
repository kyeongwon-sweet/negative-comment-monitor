import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, dailyStartInstant, buildStaleMessage, runHeartbeatCheck } from '../src/heartbeat-check.js';

const NOW = Date.parse('2026-07-20T05:00:00Z'); // 14:00 KST (마감 후 체크 시점)

test('dailyStartInstant은 그날 09:10 KST의 UTC 순간', () => {
  assert.equal(dailyStartInstant(NOW), Date.parse('2026-07-20T00:10:00Z'));
});

test('오늘 09:10 KST 이후 성공 실행이 있으면 healthy', () => {
  const runs = [
    { conclusion: 'success', run_started_at: '2026-07-20T01:55:00Z' }, // 10:55 KST
    { conclusion: 'failure', run_started_at: '2026-07-20T02:10:00Z' },
  ];
  const h = evaluateHealth(runs, NOW);
  assert.equal(h.healthy, true);
});

test('마지막 성공이 어제뿐이면 unhealthy', () => {
  const runs = [
    { conclusion: 'success', run_started_at: '2026-07-19T03:15:00Z' }, // 어제 12:15 KST
    { conclusion: 'failure', run_started_at: '2026-07-20T01:00:00Z' },
  ];
  const h = evaluateHealth(runs, NOW);
  assert.equal(h.healthy, false);
  assert.equal(h.lastSuccessAt, Date.parse('2026-07-19T03:15:00Z'));
});

test('성공 실행이 하나도 없으면 unhealthy(lastSuccessAt=null)', () => {
  const h = evaluateHealth([{ conclusion: 'failure', run_started_at: '2026-07-20T01:00:00Z' }], NOW);
  assert.equal(h.healthy, false);
  assert.equal(h.lastSuccessAt, null);
});

test('buildStaleMessage에 날짜와 담당자 멘션', () => {
  const msg = buildStaleMessage(NOW, Date.parse('2026-07-19T03:15:00Z'), 'U_OTHER');
  assert.match(msg, /2026-07-20/);
  assert.match(msg, /<@U_OTHER>/);
  assert.match(msg, /미확인/);
});

// URL별 분기 + 호출 기록 가짜 fetch.
function mockFetch({ runs }) {
  const calls = { slack: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('api.github.com')) {
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    }
    if (String(url).includes('chat.postMessage')) {
      calls.slack.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const env = { GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 't', SLACK_BOT_TOKEN: 'xoxb', SLACK_CHANNEL_ID: 'C1', SLACK_ASSIGNEE_OTHER: 'U_OTHER' };

test('runHeartbeatCheck: healthy면 Slack 발송 안 함', async () => {
  const { fetchImpl, calls } = mockFetch({ runs: [{ conclusion: 'success', run_started_at: '2026-07-20T01:55:00Z' }] });
  const r = await runHeartbeatCheck(env, NOW, fetchImpl);
  assert.equal(r.warned, false);
  assert.equal(calls.slack.length, 0);
});

test('runHeartbeatCheck: stale면 Slack 경고 발송', async () => {
  const { fetchImpl, calls } = mockFetch({ runs: [{ conclusion: 'success', run_started_at: '2026-07-19T03:15:00Z' }] });
  const r = await runHeartbeatCheck(env, NOW, fetchImpl);
  assert.equal(r.warned, true);
  assert.equal(calls.slack.length, 1);
  assert.equal(calls.slack[0].channel, 'C1');
  assert.match(calls.slack[0].text, /미확인/);
});
