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
  youtubeQuotaConservationPlan,
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

test('상시 감시 절약 모드는 60%부터 비숨김 작업을 멈추고 부정 숨김을 98%까지 보존한다', () => {
  const at = (ratio) => youtubeQuotaConservationPlan({ ratio, total: ratio * 10000, limit: 10000, byJob: [] }, {});
  assert.equal(at(0.59).heldReview, true);
  assert.equal(at(0.60).heldReview, false);
  assert.equal(at(0.59).fastScanHoldEnforce, true);
  assert.equal(at(0.60).fastScanHoldEnforce, false);
  assert.equal(at(0.97).fastScan, true);
  assert.equal(at(0.97).pendingHide, true);
  assert.equal(at(0.98).fastScan, false);
  assert.equal(at(0.98).pendingHide, false);
  assert.equal(at(0.98).ownerChannel, false);
  assert.equal(at(0.60).youtubeAds, false);
  assert.equal(youtubeQuotaConservationPlan(null, {}).failOpen, true);
  assert.equal(youtubeQuotaConservationPlan({ ratio: 0.99 }, { YOUTUBE_QUOTA_GUARD_FORCE: 'true' }).ownerChannel, true);
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

test('11-06 예측 브레이크: 리셋 전 바닥 궤도면 60% 전이라도 보류 대행·오탐 복원을 멈추고 숨김을 30분 칸으로', async () => {
  const { hoursSinceQuotaReset, projectQuotaRatio } = await import('../src/youtube-quota-meter.js');
  // 11-06 09:15 KST = 11-05 16:15 PT → 리셋 후 16.25시간, 72.5% → 하루 끝 ~107% 예측
  const at0915 = Date.parse('2026-11-06T00:15:00Z');
  assert.equal(Math.round(hoursSinceQuotaReset(at0915) * 100) / 100, 16.25);
  assert.ok(projectQuotaRatio(0.725, at0915) > 1.0);
  assert.equal(projectQuotaRatio(0.3, Date.parse('2026-11-05T09:00:00Z')), null, '리셋 후 3시간 안은 예측 안 함');
  const plan = (ratio, projectedRatio) => youtubeQuotaConservationPlan({ ratio, total: ratio * 10000, limit: 10000, byJob: [], projectedRatio }, {});
  const onTrack = plan(0.45, 1.05);
  assert.equal(onTrack.onTrackToRunOut, true);
  assert.equal(onTrack.fastScanHoldEnforce, false);
  assert.equal(onTrack.falsePositiveRestore, false);
  assert.equal(onTrack.pendingHideEveryMinutes, 30);
  assert.equal(onTrack.heldReview, true, '이미 보류된 댓글은 60%까지 계속 풀어준다');
  assert.equal(onTrack.youtubeAds, true, '인지광고 수집은 부정 탐지라 유지');
  assert.equal(onTrack.pendingHide, true);
  const fine = plan(0.45, 0.8);
  assert.equal(fine.onTrackToRunOut, false);
  assert.equal(fine.fastScanHoldEnforce, true);
  assert.equal(fine.pendingHideEveryMinutes, 15);
  assert.equal(plan(0.45, null).onTrackToRunOut, false, '예측 없으면 기존 기준만');
});

test('사용량 조회에 예측치가 붙는다', async () => {
  const usage = await youtubeQuotaUsage(ENV, ledgerFetch(['yt-units:2026-11-05:x:1.1.1.1:7250']), Date.parse('2026-11-06T00:15:00Z'));
  assert.equal(usage.day, '2026-11-05');
  assert.ok(usage.projectedRatio > 1.0);
});

// 11-09 재발방지: 할당량 경고에 '모두 보류' 빠진 채널·영상과 한 번에 끝내는 방법을 붙인다.
test("보류 대행 비용: 키 왕복·채널별 합산·경고 문구", async () => {
  const { holdCostKey, parseHoldCostKey, loadYouTubeHoldCost, holdCostLines } = await import('../src/youtube-quota-meter.js');
  const day = quotaDayKey(NOW);
  const k1 = holdCostKey(day, 'UCa', 1, NOW, ['v1', 'v2', 'v1'], '먹는김에');
  const k2 = holdCostKey(day, 'UCa', 2, NOW + 1, ['v3'], '먹는김에');
  const k3 = holdCostKey(day, 'UCb', 1, NOW + 2, ['w1'], '먹짱언니_mukzzang unnie');
  assert.deepEqual(parseHoldCostKey(k1), { day, channelId: 'UCa', calls: 1, videoIds: ['v1', 'v2'], channelName: '먹는김에' });
  assert.equal(parseHoldCostKey(`yt-units:${day}:job:run:12`), null);
  const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
  let seenUrl = '';
  const rows = await loadYouTubeHoldCost(env, async (url) => {
    seenUrl = decodeURIComponent(String(url));
    return { ok: true, status: 200, json: async () => [{ run_key: k1 }, { run_key: k2 }, { run_key: k3 }, { run_key: 'yt-hold:broken' }] };
  }, NOW);
  assert.match(seenUrl, new RegExp(`yt-hold:${day}:\*`));
  assert.deepEqual(rows.map((r) => [r.channelName, r.calls, r.units, r.videoIds.length]), [['먹는김에', 3, 150, 3], ['먹짱언니_mukzzang unnie', 1, 50, 1]]);
  const text = quotaAlertMessage('70', { total: 7000, limit: 10000, ratio: 0.7, byJob: [] }, NOW, '', rows);
  assert.match(text, /'모두 보류' 빠진 새 영상/);
  assert.match(text, /먹는김에: 영상 3개 · 보류 3번/);
  assert.match(text, /studio\.youtube\.com\/video\/v1\/edit/);
  assert.match(text, /기본값/);
  assert.deepEqual(holdCostLines([]), [], '보류 대행이 없던 날은 문구 없음');
  assert.doesNotMatch(quotaAlertMessage('70', { total: 7000, limit: 10000, ratio: 0.7, byJob: [] }, NOW), /모두 보류/);
  assert.deepEqual(await loadYouTubeHoldCost(env, async () => { throw new Error('down'); }, NOW), [], '조회 실패면 빈 목록(경고는 그대로 나감)');
});
