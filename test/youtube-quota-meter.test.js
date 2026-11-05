import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertQuotaHeadroom,
  meteredFetch,
  nextQuotaResetKst,
  parseUnitsKey,
  quotaAlertMessage,
  quotaDayKey,
  unitsForRequest,
  youtubeQuotaUsage,
} from '../src/youtube-quota-meter.js';

const YT = 'https://www.googleapis.com/youtube/v3';

test('단위: 읽기 1, 쓰기(setModerationStatus 등) 50, search 100, YouTube 밖은 0', () => {
  assert.equal(unitsForRequest(`${YT}/commentThreads?part=snippet`), 1);
  assert.equal(unitsForRequest(`${YT}/comments/setModerationStatus?id=a`, 'POST'), 50);
  assert.equal(unitsForRequest(`${YT}/search?q=x`), 100);
  assert.equal(unitsForRequest('https://oauth2.googleapis.com/token', 'POST'), 0);
  assert.equal(unitsForRequest('https://db.test/rest/v1/cost_usage_ledger'), 0);
});

test('quota 날짜는 자정 PT 경계(겨울 17:00 KST)로 바뀐다', () => {
  assert.equal(quotaDayKey(Date.parse('2026-11-04T07:59:00Z')), '2026-11-03');
  assert.equal(quotaDayKey(Date.parse('2026-11-04T08:01:00Z')), '2026-11-04');
  assert.equal(nextQuotaResetKst(Date.parse('2026-11-04T00:20:00Z')), '17:00');
});

test('원장 키에서 잡·개수를 읽는다(비용 칸은 건드리지 않음)', () => {
  assert.deepEqual(parseUnitsKey('yt-units:2026-11-04:youtube-owner-fast-scan:123.1.99.1:13'), { day: '2026-11-04', job: 'youtube-owner-fast-scan', units: 13 });
  assert.equal(parseUnitsKey('held-review:abc'), null);
});

test('계량 fetch: 성공·오류 응답은 세고, quota 소진(403 quotaExceeded)은 세지 않고 소진 신호만 남긴다', async () => {
  const state = { units: 0, exhausted: false };
  const responses = {
    ok: () => new Response('{}', { status: 200 }),
    quota: () => new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 }),
  };
  let next = 'ok';
  const f = meteredFetch(async () => responses[next](), state);
  await f(`${YT}/commentThreads?x=1`);
  await f(`${YT}/comments/setModerationStatus?id=a`, { method: 'POST' });
  await f('https://db.test/rest/v1/x');
  next = 'quota';
  const res = await f(`${YT}/commentThreads?x=2`);
  assert.equal(res.status, 403, '호출자는 원래 응답을 그대로 받는다');
  assert.equal(await res.text().then((t) => t.includes('quotaExceeded')), true, '본문도 그대로 읽힌다');
  assert.equal(state.units, 51);
  assert.equal(state.exhausted, true);
});

function ledgerFetch(keys) {
  return async () => ({ ok: true, status: 200, json: async () => keys.map((run_key) => ({ run_key })) });
}
const ENV = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const NOW = Date.parse('2026-11-04T01:00:00Z');

test('오늘 사용량은 잡별로 합산된다', async () => {
  const usage = await youtubeQuotaUsage(ENV, ledgerFetch([
    'yt-units:2026-11-03:youtube-owner-fast-scan:1.1.1.1:13',
    'yt-units:2026-11-03:youtube-owner-comments-on-probe:2.1.1.1:3700',
    'yt-units:2026-11-03:youtube-owner-fast-scan:3.1.1.1:12',
  ]), NOW);
  assert.equal(usage.day, '2026-11-03');
  assert.equal(usage.total, 3725);
  assert.deepEqual(usage.byJob[0], ['youtube-owner-comments-on-probe', 3700]);
});

test('대량 작업 가드: 예상치를 더해 상한(기본 60%)을 넘으면 실행 전에 막고, FORCE면 통과', async () => {
  const fetchImpl = ledgerFetch(['yt-units:2026-11-03:x:1.1.1.1:4000']);
  await assert.rejects(assertQuotaHeadroom(3000, { env: ENV, fetchImpl, now: NOW }), /quota 여유 부족/);
  await assertQuotaHeadroom(1000, { env: ENV, fetchImpl, now: NOW });
  assert.equal(await assertQuotaHeadroom(9999, { env: { ...ENV, YOUTUBE_QUOTA_GUARD_FORCE: 'true' }, fetchImpl, now: NOW }), null);
});

test('알림 문구: 사용률·리셋 시각·상위 소비 잡', () => {
  const usage = { total: 7200, limit: 10000, ratio: 0.72, byJob: [['youtube-owner-held-review', 3000], ['youtube-owner-fast-scan', 900]] };
  const text = quotaAlertMessage('70', usage, NOW, 'U1');
  assert.match(text, /72% 사용/);
  assert.match(text, /17:00 KST/);
  assert.match(text, /youtube-owner-held-review 3000/);
  assert.match(quotaAlertMessage('exhausted', usage, NOW), /소진/);
});

test('quota 브레이크: 60% 이상이거나 소진이면 걸리고, 조회 실패면 걸지 않는다(fail-open)', async () => {
  const { quotaBrakeEngaged } = await import('../src/youtube-quota-meter.js');
  const DB = { supabaseUrl: 'https://db.test', supabaseKey: 'k' };
  const ledger = (keys) => async (url) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('run_key=eq.')) return { ok: true, status: 200, json: async () => keys.filter((k) => u.includes(k)).map((run_key) => ({ run_key })) };
    return { ok: true, status: 200, json: async () => keys.filter((k) => k.startsWith('yt-units:')).map((run_key) => ({ run_key })) };
  };
  assert.equal((await quotaBrakeEngaged(DB, ledger(['yt-units:2026-11-03:x:1.1.1.1:6100']), NOW)).engaged, true);
  assert.equal((await quotaBrakeEngaged(DB, ledger(['yt-units:2026-11-03:x:1.1.1.1:5900']), NOW)).engaged, false);
  assert.equal((await quotaBrakeEngaged(DB, ledger(['yt-quota-alert:2026-11-03:exhausted']), NOW)).reason, 'exhausted');
  assert.equal((await quotaBrakeEngaged(DB, async () => { throw new Error('db down'); }, NOW)).engaged, false);
});
