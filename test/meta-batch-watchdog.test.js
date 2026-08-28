import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBacklogMessage,
  buildInflowMessage,
  evaluateBacklog,
  evaluateInflow,
  morningStartInstant,
  runMetaBatchWatchdog,
} from '../src/meta-batch-watchdog.js';

const NOW = Date.parse('2026-08-10T04:00:00Z'); // 13:00 KST (워치독 실행 시점)
const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SLACK_BOT_TOKEN: 'slack-token',
  SLACK_CHANNEL_ID: 'C123',
  SLACK_ASSIGNEE_OTHER: 'UHKW',
  META_ADS_WINDOW_START: '8',
  META_INFLOW_STALE_HOURS: '48',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('morningStartInstant: 오늘 KST windowStart:00', () => {
  assert.equal(morningStartInstant(NOW, 8), Date.parse('2026-08-10T08:00:00+09:00'));
});

test('evaluateBacklog: 창(08:00) 전 수신 미처리분만 stale', () => {
  const events = [
    { received_at: '2026-08-09T20:00:00Z' }, // 05:00 KST 08-10, 창 전 → stale
    { received_at: '2026-08-10T00:30:00Z' }, // 09:30 KST, 창 중 → not
    { received_at: '2026-08-10T03:00:00Z' }, // 12:00 KST, 창 후 → not
  ];
  const r = evaluateBacklog(events, NOW, 8);
  assert.equal(r.stale, 1);
  assert.equal(r.total, 3);
  assert.equal(r.oldest, Date.parse('2026-08-09T20:00:00Z'));
});

test('evaluateBacklog: 창 이후 수신만 있으면 stale 0 (정상 대기)', () => {
  const events = [
    { received_at: '2026-08-10T02:30:00Z' }, // 11:30 KST, 창 후 → 정상 대기
    { received_at: '2026-08-10T03:30:00Z' }, // 12:30 KST → 정상 대기
  ];
  const r = evaluateBacklog(events, NOW, 8);
  assert.equal(r.stale, 0);
  assert.equal(r.total, 2);
});

test('evaluateBacklog: 미처리 없음 → stale 0', () => {
  assert.equal(evaluateBacklog([], NOW, 8).stale, 0);
});

test('buildBacklogMessage: 담당자 멘션·건수 포함', () => {
  const msg = buildBacklogMessage(NOW, { stale: 5, oldest: Date.parse('2026-08-09T20:00:00Z'), total: 7 }, 'UHKW');
  assert.match(msg, /인지 광고 아침 배치 미실행 의심/);
  assert.match(msg, /미처리\(창 전 수신\) 5건/);
  assert.match(msg, /<@UHKW>/);
});

test('evaluateInflow: 마지막 이벤트가 49시간 전이면 zero-inflow 경고 대상', () => {
  const last = { received_at: new Date(NOW - 49 * 3600_000).toISOString() };
  const res = evaluateInflow(last, NOW, 48);

  assert.equal(res.stale, true);
  assert.equal(res.ageHours, 49);
  assert.equal(res.thresholdHours, 48);
});

test('evaluateInflow: 마지막 이벤트가 2시간 전이면 정상', () => {
  const last = { received_at: new Date(NOW - 2 * 3600_000).toISOString() };
  const res = evaluateInflow(last, NOW, 48);

  assert.equal(res.stale, false);
  assert.equal(res.ageHours, 2);
});

test('evaluateInflow: 역대 유입 이력이 없으면 정지로 단정하지 않음', () => {
  assert.deepEqual(evaluateInflow(null, NOW, 48), {
    stale: false,
    lastEventAt: null,
    ageHours: null,
    thresholdHours: 48,
  });
});

test('buildInflowMessage: 백로그 장애와 구분되는 웹훅 정지 경고', () => {
  const msg = buildInflowMessage({
    lastEventAt: NOW - 49 * 3600_000,
    ageHours: 49,
    thresholdHours: 48,
  }, 'UHKW');

  assert.match(msg, /Meta 인지광고 댓글 웹훅 유입 정지/);
  assert.match(msg, /48시간 이상/);
  assert.match(msg, /subscribed_apps/);
  assert.match(msg, /<@UHKW>/);
});

test('runMetaBatchWatchdog: 49시간 무유입은 하루 claim 후 Slack 경고하고 monitor는 dispatch하지 않음', async () => {
  const calls = [];
  const lastReceived = new Date(NOW - 49 * 3600_000).toISOString();
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('processed_at=is.null')) return jsonResponse([]);
    if (String(url).includes('order=received_at.desc')) return jsonResponse([{ received_at: lastReceived }]);
    if (String(url).includes('cost_usage_ledger?on_conflict=run_key')) {
      return jsonResponse([{ run_key: 'meta-inflow-stale:2026-08-10' }], 201);
    }
    if (url === 'https://slack.com/api/chat.postMessage') return jsonResponse({ ok: true });
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await runMetaBatchWatchdog(ENV, NOW, fetchImpl);

  assert.deepEqual(result, { warned: true, dispatched: false });
  assert.equal(calls.some((call) => call.url.endsWith('/dispatches')), false);
  const claim = calls.find((call) => call.url.includes('cost_usage_ledger?on_conflict=run_key'));
  assert.equal(JSON.parse(claim.options.body).run_key, 'meta-inflow-stale:2026-08-10');
  const slack = calls.find((call) => call.url === 'https://slack.com/api/chat.postMessage');
  assert.match(JSON.parse(slack.options.body).text, /웹훅 유입 정지/);
});

test('runMetaBatchWatchdog: 2시간 전 유입이 있으면 claim·Slack·dispatch 없이 정상', async () => {
  const calls = [];
  const lastReceived = new Date(NOW - 2 * 3600_000).toISOString();
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('processed_at=is.null')) return jsonResponse([]);
    if (String(url).includes('order=received_at.desc')) return jsonResponse([{ received_at: lastReceived }]);
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await runMetaBatchWatchdog(ENV, NOW, fetchImpl);

  assert.deepEqual(result, { warned: false, dispatched: false });
  assert.equal(calls.length, 2);
});
