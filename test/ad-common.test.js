import test from 'node:test';
import assert from 'node:assert/strict';
import { inAdMorningWindow, dailyAdRunKey, hasAdRunToday } from '../src/ad-common.js';

test('inAdMorningWindow: prefix별 FORCE·KST 창 판정', () => {
  const kst9 = Date.parse('2026-08-14T00:10:00Z'); // KST 09
  const kst12 = Date.parse('2026-08-14T03:10:00Z'); // KST 12
  assert.equal(inAdMorningWindow(kst9, {}, 'TIKTOK_ADS'), true);
  assert.equal(inAdMorningWindow(kst12, {}, 'TIKTOK_ADS'), false);
  // FORCE는 시간 무관 실행
  assert.equal(inAdMorningWindow(kst12, { YOUTUBE_ADS_FORCE: 'true' }, 'YOUTUBE_ADS'), true);
  // 창 커스텀(prefix별 env)
  assert.equal(inAdMorningWindow(kst12, { META_ADS_WINDOW_START: '8', META_ADS_WINDOW_END: '13' }, 'META_ADS'), true);
  // 다른 prefix의 FORCE는 영향 없음
  assert.equal(inAdMorningWindow(kst12, { META_ADS_FORCE: 'true' }, 'TIKTOK_ADS'), false);
});

test('dailyAdRunKey: scope·id·KST 날짜 조합(자정 경계)', () => {
  assert.equal(dailyAdRunKey('tiktok-ads', 'adv1', Date.parse('2026-08-13T23:10:00Z')), 'daily:tiktok-ads:adv1:2026-08-14');
  assert.equal(dailyAdRunKey('youtube-ads', '123', Date.parse('2026-08-14T01:00:00Z')), 'daily:youtube-ads:123:2026-08-14');
});

test('hasAdRunToday: 원장 행 있으면 true, 조회 실패·미설정은 false(fail-open)', async () => {
  const cfg = { supabaseUrl: 'https://db', supabaseKey: 'k' };
  let requested;
  assert.equal(await hasAdRunToday(cfg, 'daily:x:1:2026-08-14', async (u) => { requested = u; return { ok: true, json: async () => [{ run_key: 'x' }] }; }), true);
  assert.match(requested, /run_key=eq.daily%3Ax%3A1%3A2026-08-14/);
  assert.equal(await hasAdRunToday(cfg, 'k', async () => ({ ok: true, json: async () => [] })), false);
  assert.equal(await hasAdRunToday(cfg, 'k', async () => ({ ok: false })), false);        // 조회 실패 = fail-open false
  assert.equal(await hasAdRunToday({}, 'k', async () => { throw new Error('down'); }), false); // supabase 미설정
});
