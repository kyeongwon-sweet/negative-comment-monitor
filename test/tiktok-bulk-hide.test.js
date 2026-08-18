import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTikTokBulkHideConfig,
  hideTikTokCommentBatch,
  hideWithIsolation,
  bulkHideTikTokAlerts,
  TIKTOK_BULK_HIDE_CONFIRMATION,
} from '../src/tiktok-bulk-hide.js';

const BASE_ENV = {
  TIKTOK_ADVERTISER_ID: 'adv1', TIKTOK_ACCESS_TOKEN: 'tok',
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key',
};
const CFG = {
  advertiserId: 'adv1', accessToken: 'tok', apiBase: 'https://business-api.test/open_api/v1.3',
  supabaseUrl: 'https://db.test', supabaseKey: 'key', slackBotToken: '',
  dryRun: false, operation: 'HIDDEN', adType: 'BIDDING', batchSize: 2, limit: 0,
  actor: 'bulk-tiktok-hide', requestDelayMs: 0, slackUpdateDelayMs: 0,
};
const noSleep = async () => {};

test('loadTikTokBulkHideConfig: dry-run 기본 true, 라이브는 confirmation 필수', () => {
  assert.equal(loadTikTokBulkHideConfig(BASE_ENV).dryRun, true);
  assert.throws(() => loadTikTokBulkHideConfig({ ...BASE_ENV, TIKTOK_BULK_HIDE_DRY_RUN: 'false' }),
    /HIDE_ALL_TIKTOK_AD_ALERTS/);
  const live = loadTikTokBulkHideConfig({ ...BASE_ENV, TIKTOK_BULK_HIDE_DRY_RUN: 'false', TIKTOK_BULK_HIDE_CONFIRM: TIKTOK_BULK_HIDE_CONFIRMATION });
  assert.equal(live.dryRun, false);
  assert.equal(live.operation, 'HIDDEN');
  assert.equal(live.adType, 'BIDDING');
});

test('hideTikTokCommentBatch: code 0 성공, 비-0 실패, rate-limit 재시도', async () => {
  assert.deepEqual(await hideTikTokCommentBatch(CFG, ['c1'], async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }), noSleep), { ok: true });
  const fail = await hideTikTokCommentBatch(CFG, ['c1'], async () => ({ ok: true, status: 200, json: async () => ({ code: 40002, message: 'bad op' }) }), noSleep);
  assert.equal(fail.ok, false); assert.equal(fail.code, 40002);
  // 40100 rate-limit → 재시도 후 성공
  let n = 0;
  const r = await hideTikTokCommentBatch(CFG, ['c1'], async () => { n += 1; return { ok: true, status: 200, json: async () => (n < 2 ? { code: 40100 } : { code: 0 }) }; }, noSleep);
  assert.equal(r.ok, true); assert.equal(n, 2);
});

test('hideWithIsolation: 배치 실패 시 이진분할로 문제 댓글만 격리', async () => {
  // 'bad'가 포함된 배치는 실패, 나머지는 성공
  const fetchImpl = async (url, opts) => {
    const ids = JSON.parse(opts.body).comment_ids;
    const ok = !ids.includes('bad');
    return { ok: true, status: 200, json: async () => (ok ? { code: 0 } : { code: 40002, message: 'x' }) };
  };
  const result = { failed: [] };
  const hidden = await hideWithIsolation(CFG, ['a', 'b', 'bad', 'c'], fetchImpl, noSleep, result);
  assert.deepEqual(hidden.sort(), ['a', 'b', 'c']);
  assert.deepEqual(result.failed.map((f) => f.commentId), ['bad']);
});

test('bulkHideTikTokAlerts: dry-run은 숨김/기록 안 하고 집계만', async () => {
  const fetchImpl = async (u) => {
    if (/negative_comment_alerts\?select/.test(u)) return { ok: true, json: async () => [{ id: 1, comment_id: 'c1' }, { id: 2, comment_id: 'c2' }] };
    throw new Error('dry-run은 숨김/PATCH 호출 안 해야 함: ' + u);
  };
  const res = await bulkHideTikTokAlerts({ ...CFG, dryRun: true }, fetchImpl, Date.now(), noSleep);
  assert.equal(res.dryRun, true); assert.equal(res.targetComments, 2); assert.equal(res.hidden, 0); assert.equal(res.dbUpdated, 0);
});

test('bulkHideTikTokAlerts: 라이브는 숨김+확정분만 DB 기록, 실패는 격리', async () => {
  const patched = [];
  const fetchImpl = async (u, opts) => {
    if (/negative_comment_alerts\?select/.test(u)) return { ok: true, json: async () => [
      { id: 1, comment_id: 'c1' }, { id: 2, comment_id: 'c2' }, { id: 3, comment_id: 'bad' },
    ] };
    if (/comment\/status\/update/.test(u)) { const ids = JSON.parse(opts.body).comment_ids; return { ok: true, status: 200, json: async () => (ids.includes('bad') ? { code: 40002, message: 'x' } : { code: 0 }) }; }
    if (/negative_comment_alerts\?id=in/.test(u) && opts.method === 'PATCH') { const b = JSON.parse(opts.body); patched.push(b); return { ok: true, json: async () => [{ id: 1 }, { id: 2 }] }; }
    throw new Error('unexpected ' + u);
  };
  const res = await bulkHideTikTokAlerts(CFG, fetchImpl, Date.parse('2026-08-18T00:00:00Z'), noSleep);
  assert.equal(res.hidden, 2);           // c1,c2 성공, bad 격리
  assert.equal(res.dbUpdated, 2);
  assert.deepEqual(res.failed.map((f) => f.commentId), ['bad']);
  assert.equal(patched[0].review_decision, 'hidden');
  assert.equal(patched[0].reviewed_by, 'bulk-tiktok-hide'); // 확정분 actor 기록
});
