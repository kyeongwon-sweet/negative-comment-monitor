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
  SLACK_BOT_TOKEN: 'slack', SLACK_CHANNEL_ID: 'C1', TIKTOK_BULK_HIDE_THREAD_TS_CSV: 'parent1,parent2',
};
const CFG = {
  advertiserId: 'adv1', accessToken: 'tok', apiBase: 'https://business-api.test/open_api/v1.3',
  supabaseUrl: 'https://db.test', supabaseKey: 'key', slackBotToken: 'slack', slackChannelId: 'C1', threadTs: ['parent1'],
  dryRun: false, auditOnly: false, operation: 'HIDDEN', adType: 'BIDDING', batchSize: 2, limit: 0,
  actor: 'bulk-tiktok-hide', requestDelayMs: 0, slackUpdateDelayMs: 0,
  tiktokCampaignNameFilter: '빙과,쫀득바', tiktokAdsLookbackDays: 30, tiktokAdsMaxCommentsPerAdgroup: 1000,
};
const noSleep = async () => {};

function slackScope(messages = [{ ts: 'parent1' }, { ts: 'reply1' }, { ts: 'reply2' }, { ts: 'reply3' }]) {
  return { ok: true, status: 200, json: async () => ({ ok: true, messages, response_metadata: { next_cursor: '' } }) };
}

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
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].commentId, undefined); // 식별자는 로그·요약에 남기지 않음
});

test('bulkHideTikTokAlerts: dry-run은 숨김/기록 안 하고 집계만', async () => {
  const fetchImpl = async (u) => {
    if (/conversations\.replies/.test(String(u))) return slackScope();
    if (/negative_comment_alerts\?select/.test(u)) return { ok: true, json: async () => [
      { id: 1, comment_id: 'c1', slack_ts: 'reply1' },
      { id: 2, comment_id: 'c2', slack_ts: 'outside' },
    ] };
    throw new Error('dry-run은 숨김/PATCH 호출 안 해야 함: ' + u);
  };
  const res = await bulkHideTikTokAlerts({ ...CFG, dryRun: true }, fetchImpl, Date.now(), noSleep);
  assert.equal(res.dryRun, true); assert.equal(res.targetComments, 1); assert.equal(res.totalSourceUnhiddenRows, 2); assert.equal(res.hidden, 0); assert.equal(res.dbUpdated, 0);
});

test('bulkHideTikTokAlerts: 라이브는 숨김+확정분만 DB 기록, 실패는 격리', async () => {
  const patched = [];
  const fetchImpl = async (u, opts) => {
    if (/conversations\.replies/.test(String(u))) return slackScope();
    if (/negative_comment_alerts\?select/.test(u)) return { ok: true, json: async () => [
      { id: 1, comment_id: 'c1', slack_ts: 'reply1' },
      { id: 2, comment_id: 'c2', slack_ts: 'reply2' },
      { id: 3, comment_id: 'bad', slack_ts: 'reply3' },
    ] };
    if (/comment\/status\/update/.test(u)) { const ids = JSON.parse(opts.body).comment_ids; return { ok: true, status: 200, json: async () => (ids.includes('bad') ? { code: 40002, message: 'x' } : { code: 0 }) }; }
    if (/negative_comment_alerts\?id=in/.test(u) && opts.method === 'PATCH') { const b = JSON.parse(opts.body); patched.push(b); return { ok: true, json: async () => [{ id: 1 }, { id: 2 }] }; }
    throw new Error('unexpected ' + u);
  };
  const verify = async (_config, ids) => ({ hiddenIds: ids, visibleIds: [], missingIds: [], campaigns: 1, ads: 1, adgroups: 1 });
  const res = await bulkHideTikTokAlerts(CFG, fetchImpl, Date.parse('2026-08-18T00:00:00Z'), noSleep, verify);
  assert.equal(res.hidden, 2);           // c1,c2 성공, bad 격리
  assert.equal(res.dbUpdated, 2);
  assert.equal(res.failed.length, 1);
  assert.equal(patched[0].review_decision, 'hidden');
  assert.equal(patched[0].reviewed_by, 'bulk-tiktok-hide'); // 확정분 actor 기록
});

test('bulkHideTikTokAlerts: 감사 모드는 이미 처리된 스레드 행을 재조회하되 숨김 API/DB를 건드리지 않는다', async () => {
  let statusUpdates = 0;
  const fetchImpl = async (u) => {
    if (/conversations\.replies/.test(String(u))) return slackScope();
    if (/review_decision,reviewed_by/.test(String(u))) return { ok: true, json: async () => [
      { id: 1, comment_id: 'c1', slack_ts: 'reply1', review_decision: 'hidden' },
      { id: 2, comment_id: 'c2', slack_ts: 'outside', review_decision: 'hidden' },
    ] };
    if (/comment\/status\/update/.test(String(u))) { statusUpdates += 1; }
    throw new Error('unexpected ' + u);
  };
  const verify = async (_config, ids) => ({ hiddenIds: ids, visibleIds: [], missingIds: [], campaigns: 1, ads: 1, adgroups: 1 });
  const result = await bulkHideTikTokAlerts({ ...CFG, auditOnly: true, dryRun: true }, fetchImpl, Date.now(), noSleep, verify);
  assert.equal(result.targetComments, 1);
  assert.equal(result.hidden, 1);
  assert.equal(statusUpdates, 0);
  assert.equal(result.dbUpdated, 0);
});

test('bulkHideTikTokAlerts: 라이브 감사는 실제 공개 댓글만 재숨김하고 사람 결정·DB를 보존한다', async () => {
  const statusUpdates = [];
  let verification = 0;
  let patches = 0;
  const fetchImpl = async (u, opts = {}) => {
    if (/conversations\.replies/.test(String(u))) return slackScope();
    if (/review_decision,reviewed_by/.test(String(u))) return { ok: true, json: async () => [
      { id: 1, comment_id: 'hidden-ok', slack_ts: 'reply1', review_decision: 'hidden', reviewed_by: 'bulk' },
      { id: 2, comment_id: 'visible-hidden', slack_ts: 'reply2', review_decision: 'hidden', reviewed_by: 'bulk' },
      { id: 3, comment_id: 'visible-ignore', slack_ts: 'reply3', review_decision: 'false_positive', reviewed_by: 'U1' },
    ] };
    if (/comment\/status\/update/.test(String(u))) {
      statusUpdates.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    }
    if (/negative_comment_alerts\?id=in/.test(String(u)) && opts.method === 'PATCH') {
      patches += 1;
      return { ok: true, json: async () => [] };
    }
    if (/chat\.update/.test(String(u))) return { ok: true, json: async () => ({ ok: true }) };
    throw new Error('unexpected ' + u);
  };
  const verify = async () => {
    verification += 1;
    return verification === 1
      ? { hiddenIds: ['hidden-ok'], visibleIds: ['visible-hidden', 'visible-ignore'], missingIds: [], campaigns: 1, ads: 1, adgroups: 1 }
      : { hiddenIds: ['hidden-ok', 'visible-hidden'], visibleIds: ['visible-ignore'], missingIds: [], campaigns: 1, ads: 1, adgroups: 1 };
  };
  const result = await bulkHideTikTokAlerts(
    { ...CFG, auditOnly: true, dryRun: false }, fetchImpl, Date.now(), noSleep, verify,
  );

  assert.equal(statusUpdates.length, 1);
  assert.deepEqual(statusUpdates[0].comment_ids, ['visible-hidden']);
  assert.equal(statusUpdates[0].operation, 'HIDDEN');
  assert.equal(statusUpdates[0].ad_type, 'BIDDING');
  assert.equal(result.repairEligibleVisible, 1);
  assert.equal(result.repairBlockedByDecision, 1);
  assert.equal(result.repairedVisible, 1);
  assert.equal(result.repairStillVisible, 0);
  assert.equal(result.dbUpdated, 0);
  assert.equal(patches, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(JSON.stringify(result).includes('visible-hidden'), false);
});
