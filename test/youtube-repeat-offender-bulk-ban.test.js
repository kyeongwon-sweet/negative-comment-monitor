import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectBulkBanCandidates,
  buildBulkBanInventory,
  executeBulkBan,
  loadYouTubeRepeatOffenderBulkBanConfig,
  YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRMATION,
} from '../src/youtube-repeat-offender-bulk-ban.js';

const baseEnv = {
  GOOGLE_ADS_CLIENT_ID: 'cid',
  GOOGLE_ADS_CLIENT_SECRET: 'secret',
  SUPABASE_URL: 'https://db.example.com',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
};

function candidate(overrides = {}) {
  return {
    ownerChannelId: 'OWNER1',
    ownerChannelName: '먹는김에',
    authorChannelId: 'AUTHOR1',
    authorDisplayName: 'a',
    handle: '@a',
    alertIds: [10, 11],
    evidenceAlertId: 10,
    commentCount: 3,
    videoCount: 2,
    ...overrides,
  };
}

test('selectBulkBanCandidates: allowlist 비면 전원, 있으면 alertId 포함 후보만', () => {
  const cands = [
    candidate({ authorChannelId: 'A', alertIds: [1, 2], evidenceAlertId: 1 }),
    candidate({ authorChannelId: 'B', alertIds: [3, 4], evidenceAlertId: 3 }),
  ];
  assert.equal(selectBulkBanCandidates(cands, new Set()).length, 2);
  const only = selectBulkBanCandidates(cands, new Set([4]));
  assert.equal(only.length, 1);
  assert.equal(only[0].authorChannelId, 'B');
});

test('buildBulkBanInventory: 소유채널별 집계', () => {
  const inv = buildBulkBanInventory([
    candidate({ authorChannelId: 'A', ownerChannelName: '먹는김에' }),
    candidate({ authorChannelId: 'B', ownerChannelName: '먹짱언니' }),
    candidate({ authorChannelId: 'C', ownerChannelName: '먹는김에' }),
  ]);
  assert.equal(inv.selected, 3);
  assert.deepEqual(inv.byOwner, { 먹는김에: 2, 먹짱언니: 1 });
});

test('executeBulkBan dryRun: 밴하지 않고 인벤토리만 반환', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => [] }; };
  const prepared = { candidates: [candidate()], accessTokens: new Map([['OWNER1', 'tok']]) };
  const out = await executeBulkBan({ dryRun: true, allowedAlertIds: new Set() }, prepared, fetchImpl);
  assert.equal(out.dryRun, true);
  assert.equal(out.selected, 1);
  assert.equal(out.banned, 0);
  assert.equal(calls, 0); // 어떤 네트워크 호출도 없어야 한다
});

test('executeBulkBan live: 후보를 밴하고 모든 alert 행을 author_banned 처리', async () => {
  const banUrls = [];
  const patched = [];
  const patchedBodies = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') {
      patched.push(url);
      patchedBodies.push(JSON.parse(init.body));
      return { ok: true, status: 204, json: async () => [] };
    }
    if (url.includes('/rest/v1/negative_comment_alerts') && url.includes('select=id,comment_id')) {
      return { ok: true, status: 200, json: async () => [{ id: 10, comment_id: 'CMT10' }] };
    }
    if (url.includes('/comments/setModerationStatus')) {
      banUrls.push(url);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const prepared = { candidates: [candidate({ alertIds: [10, 11], evidenceAlertId: 10 })], accessTokens: new Map([['OWNER1', 'tok']]) };
  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    prepared, fetchImpl, Date.parse('2026-09-14T00:00:00Z'),
  );
  assert.equal(out.banned, 1);
  assert.equal(out.failed.length, 0);
  assert.equal(banUrls.length, 1);
  assert.match(banUrls[0], /banAuthor=true/);
  assert.match(banUrls[0], /moderationStatus=rejected/);
  assert.match(banUrls[0], /id=CMT10/);
  // alert 10,11 모두 PATCH 대상이며, 종결 상태는 author_banned(자동숨김 'hidden'과 구분)
  assert.match(patched[0], /id=in\.\(10,11\)/);
  assert.doesNotMatch(patched[0], /review_decision=is\.null/);
  assert.equal(patchedBodies[0].review_decision, 'author_banned');
});

test('executeBulkBan live: 토큰/댓글ID 없으면 밴하지 않고 skip', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('select=id,comment_id')) return { ok: true, status: 200, json: async () => [] };
    throw new Error(`should not ban ${url}`);
  };
  const prepared = { candidates: [candidate({ evidenceAlertId: 99 })], accessTokens: new Map() };
  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    prepared, fetchImpl,
  );
  assert.equal(out.banned, 0);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].reason, 'no-owner-token');
});

test('loadConfig: 라이브 모드는 확인 문자열 필수', () => {
  assert.throws(() => loadYouTubeRepeatOffenderBulkBanConfig({ ...baseEnv, YOUTUBE_REPEAT_OFFENDER_BULK_BAN_DRY_RUN: 'false' }), /BAN_ALL_YOUTUBE_REPEAT_OFFENDERS/);
  const ok = loadYouTubeRepeatOffenderBulkBanConfig({
    ...baseEnv,
    YOUTUBE_REPEAT_OFFENDER_BULK_BAN_DRY_RUN: 'false',
    YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRM: YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRMATION,
  });
  assert.equal(ok.dryRun, false);
  // dry-run 기본값은 true(안전)
  assert.equal(loadYouTubeRepeatOffenderBulkBanConfig(baseEnv).dryRun, true);
});

test('loadConfig: 빈 alert_ids는 allowlist 없음(전원) — Number("")=0 함정 방지', () => {
  // 미지정/빈 문자열은 빈 Set이어야 selectBulkBanCandidates가 전원을 반환한다.
  assert.equal(loadYouTubeRepeatOffenderBulkBanConfig(baseEnv).allowedAlertIds.size, 0);
  assert.equal(loadYouTubeRepeatOffenderBulkBanConfig({ ...baseEnv, YOUTUBE_REPEAT_OFFENDER_ALERT_IDS: '' }).allowedAlertIds.size, 0);
  const two = loadYouTubeRepeatOffenderBulkBanConfig({ ...baseEnv, YOUTUBE_REPEAT_OFFENDER_ALERT_IDS: '10, 11' }).allowedAlertIds;
  assert.deepEqual([...two].sort((a, b) => a - b), [10, 11]);
});
