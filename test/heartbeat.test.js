import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStaleMessage, checkAndWarnStale, updateHeartbeat } from '../src/heartbeat.js';

const baseConfig = {
  supabaseUrl: 'https://sb.example',
  supabaseKey: 'service-key',
  slackBotToken: 'xoxb-test',
  slackChannelId: 'C0BHD9S69JA',
  slackAssignees: { other: 'U_OTHER' },
  heartbeatStaleDeadlineMin: 780, // 13:00 KST
  dryRun: false,
};

// URL별로 응답을 분기하고 호출을 기록하는 가짜 fetch.
function mockFetch({ row } = {}) {
  const calls = { slack: [], upsert: [], get: 0, ping: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('/rest/v1/monitor_heartbeat') && (opts.method || 'GET') === 'GET') {
      calls.get += 1;
      return { ok: true, json: async () => (row ? [row] : []) };
    }
    if (String(url).includes('/rest/v1/monitor_heartbeat')) {
      calls.upsert.push(JSON.parse(opts.body));
      return { ok: true, text: async () => '' };
    }
    if (String(url).includes('chat.postMessage')) {
      calls.slack.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true, ts: '1.2' }) };
    }
    calls.ping.push(String(url));
    return { ok: true, text: async () => '' };
  };
  return { fetchImpl, calls };
}

const AFTER_DEADLINE = Date.parse('2026-07-20T05:00:00Z'); // 14:00 KST (마감 지남)
const BEFORE_DEADLINE = Date.parse('2026-07-20T02:00:00Z'); // 11:00 KST (마감 전)

test('buildStaleMessage에 마지막 점검일과 담당자 멘션이 들어간다', () => {
  const msg = buildStaleMessage({ last_daily_pass_kst_date: '2026-07-19' }, AFTER_DEADLINE, 'U_OTHER');
  assert.match(msg, /2026-07-19/);
  assert.match(msg, /<@U_OTHER>/);
  assert.match(msg, /미완료/);
});

test('마감 전에는 경고하지 않는다', async () => {
  const { fetchImpl, calls } = mockFetch({ row: { last_daily_pass_kst_date: '2026-07-19' } });
  const result = await checkAndWarnStale(baseConfig, BEFORE_DEADLINE, fetchImpl);
  assert.equal(result, null);
  assert.equal(calls.get, 0);
  assert.equal(calls.slack.length, 0);
});

test('오늘 이미 점검했으면 경고하지 않는다', async () => {
  const { fetchImpl, calls } = mockFetch({ row: { last_daily_pass_kst_date: '2026-07-20' } });
  const result = await checkAndWarnStale(baseConfig, AFTER_DEADLINE, fetchImpl);
  assert.equal(result, null);
  assert.equal(calls.slack.length, 0);
});

test('마감 지났고 오늘 점검 없으면 Slack 경고 + 경고일 기록', async () => {
  const { fetchImpl, calls } = mockFetch({ row: { last_daily_pass_kst_date: '2026-07-19', last_warning_kst_date: null } });
  const result = await checkAndWarnStale(baseConfig, AFTER_DEADLINE, fetchImpl);
  assert.equal(result.warned, true);
  assert.equal(calls.slack.length, 1);
  assert.equal(calls.slack[0].channel, 'C0BHD9S69JA');
  assert.equal(calls.upsert.length, 1);
  assert.equal(calls.upsert[0][0].last_warning_kst_date, '2026-07-20');
});

test('오늘 이미 경고했으면 중복 발송하지 않는다', async () => {
  const { fetchImpl, calls } = mockFetch({ row: { last_daily_pass_kst_date: '2026-07-19', last_warning_kst_date: '2026-07-20' } });
  const result = await checkAndWarnStale(baseConfig, AFTER_DEADLINE, fetchImpl);
  assert.deepEqual(result, { warned: false, reason: 'already-warned' });
  assert.equal(calls.slack.length, 0);
});

test('Supabase 오류가 나도 예외를 던지지 않는다(fail-safe)', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const result = await checkAndWarnStale(baseConfig, AFTER_DEADLINE, fetchImpl);
  assert.equal(result, null);
});

test('updateHeartbeat: 일일점검 완료 시 pass 필드 기록, 외부 URL ping', async () => {
  const { fetchImpl, calls } = mockFetch({});
  await updateHeartbeat({ ...baseConfig, heartbeatUrl: 'https://hc.example/ping' }, { dailyPassRan: true }, AFTER_DEADLINE, fetchImpl);
  assert.equal(calls.upsert.length, 1);
  assert.equal(calls.upsert[0][0].last_daily_pass_kst_date, '2026-07-20');
  assert.equal(calls.ping.length, 1);
});

test('updateHeartbeat: dryRun이면 아무것도 쓰지 않는다', async () => {
  const { fetchImpl, calls } = mockFetch({});
  await updateHeartbeat({ ...baseConfig, dryRun: true }, { dailyPassRan: true }, AFTER_DEADLINE, fetchImpl);
  assert.equal(calls.upsert.length, 0);
  assert.equal(calls.ping.length, 0);
});
