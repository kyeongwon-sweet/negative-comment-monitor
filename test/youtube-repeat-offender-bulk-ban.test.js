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
  assert.equal(out.moderationRequests, 1);
  assert.equal(out.estimatedQuotaUnits, 50);
  assert.equal(banUrls.length, 1);
  assert.match(banUrls[0], /banAuthor=true/);
  assert.match(banUrls[0], /moderationStatus=rejected/);
  assert.match(banUrls[0], /id=CMT10/);
  // alert 10,11 모두 PATCH 대상이며, 종결 상태는 author_banned(자동숨김 'hidden'과 구분)
  assert.match(patched[0], /id=in\.\(10,11\)/);
  assert.doesNotMatch(patched[0], /review_decision=is\.null/);
  assert.equal(patchedBodies[0].review_decision, 'author_banned');
});

test('executeBulkBan live: 같은 소유채널 후보 최대 50명을 한 quota 요청으로 묶는다', async () => {
  const candidates = Array.from({ length: 51 }, (_, index) => candidate({
    authorChannelId: `AUTHOR${index + 1}`,
    alertIds: [index + 1],
    evidenceAlertId: index + 1,
  }));
  const banUrls = [];
  let patchCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('select=id,comment_id')) {
      return {
        ok: true,
        status: 200,
        json: async () => candidates.map((row) => ({
          id: row.evidenceAlertId,
          comment_id: `CMT${row.evidenceAlertId}`,
        })),
      };
    }
    if (url.includes('/comments/setModerationStatus')) {
      banUrls.push(url);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') {
      patchCount += 1;
      return { ok: true, status: 204, json: async () => [] };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    { candidates, accessTokens: new Map([['OWNER1', 'tok']]) },
    fetchImpl,
  );

  assert.equal(out.banned, 51);
  assert.equal(out.moderationRequests, 2);
  assert.equal(out.estimatedQuotaUnits, 100);
  assert.equal(patchCount, 51);
  assert.equal(new URL(banUrls[0]).searchParams.get('id').split(',').length, 50);
  assert.equal(new URL(banUrls[1]).searchParams.get('id'), 'CMT51');
});

test('executeBulkBan live: 소유채널이 다르면 OAuth별 요청으로 분리한다', async () => {
  const candidates = [
    candidate({ ownerChannelId: 'OWNER1', authorChannelId: 'AUTHOR1', alertIds: [1], evidenceAlertId: 1 }),
    candidate({ ownerChannelId: 'OWNER2', authorChannelId: 'AUTHOR2', alertIds: [2], evidenceAlertId: 2 }),
  ];
  const authHeaders = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('select=id,comment_id')) {
      return { ok: true, status: 200, json: async () => [{ id: 1, comment_id: 'CMT1' }, { id: 2, comment_id: 'CMT2' }] };
    }
    if (url.includes('/comments/setModerationStatus')) {
      authHeaders.push(init.headers.Authorization);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') {
      return { ok: true, status: 204, json: async () => [] };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    { candidates, accessTokens: new Map([['OWNER1', 'tok1'], ['OWNER2', 'tok2']]) },
    fetchImpl,
  );

  assert.equal(out.banned, 2);
  assert.equal(out.moderationRequests, 2);
  assert.deepEqual(authHeaders.sort(), ['Bearer tok1', 'Bearer tok2']);
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

test('2026-10-19 재발방지: 묶음 요청이 거절되면 사유를 남기고 한 명씩 재시도한다(불량 1건이 전원을 막지 않음)', async () => {
  const candidates = ['A', 'B', 'C'].map((id, index) => candidate({
    authorChannelId: id, alertIds: [index + 1], evidenceAlertId: index + 1,
  }));
  const banIds = [];
  const patched = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('select=id,comment_id')) {
      return { ok: true, status: 200, json: async () => candidates.map((row) => ({ id: row.evidenceAlertId, comment_id: `CMT${row.evidenceAlertId}` })) };
    }
    if (url.includes('/comments/setModerationStatus')) {
      const ids = new URL(url).searchParams.get('id');
      banIds.push(ids);
      // 묶음이나 CMT2(불량)가 포함되면 400
      if (ids.includes(',') || ids === 'CMT2') return { ok: false, status: 400, text: async () => '{"error":{"message":"bad id"}}' };
      return { ok: true, status: 204, text: async () => '' };
    }
    if (init.method === 'PATCH') { patched.push(url); return { ok: true, status: 204, json: async () => [] }; }
    throw new Error(`unexpected fetch ${url}`);
  };

  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    { candidates, accessTokens: new Map([['OWNER1', 'tok']]) },
    fetchImpl,
  );

  assert.deepEqual(banIds, ['CMT1,CMT2,CMT3', 'CMT1', 'CMT2', 'CMT3']);
  assert.equal(out.banned, 2);
  assert.deepEqual(out.failed.map((row) => [row.authorChannelId, row.status]), [['B', 400]]);
  assert.match(out.failed[0].detail, /bad id/);
  assert.equal(out.batchFailures.length, 1);
  assert.equal(out.batchFailures[0].size, 3);
  assert.equal(out.moderationRequests, 4);
  // 실패한 B의 alert 행은 author_banned로 바꾸지 않는다.
  assert.equal(patched.length, 2);
  assert.ok(patched.every((url) => !url.includes('in.(2)')));
});

test('2026-10-19 재발방지: 대표 댓글이 처리불가(400)면 같은 작성자의 다른 댓글로 다시 차단한다', async () => {
  const candidates = [
    candidate({ authorChannelId: 'A', alertIds: [1], evidenceAlertId: 1 }),
    candidate({ authorChannelId: 'B', alertIds: [2, 3, 4], evidenceAlertId: 2 }),
  ];
  const banIds = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('select=id,comment_id')) {
      return { ok: true, status: 200, json: async () => [1, 2, 3, 4].map((id) => ({ id, comment_id: `CMT${id}` })) };
    }
    if (url.includes('/comments/setModerationStatus')) {
      const ids = new URL(url).searchParams.get('id');
      banIds.push(ids);
      if (ids.includes(',') || ids === 'CMT2' || ids === 'CMT3') return { ok: false, status: 400, text: async () => 'processingFailure' };
      return { ok: true, status: 204, text: async () => '' };
    }
    if (init.method === 'PATCH') return { ok: true, status: 204, json: async () => [] };
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    { candidates, accessTokens: new Map([['OWNER1', 'tok']]) },
    fetchImpl,
  );
  assert.deepEqual(banIds, ['CMT1,CMT2', 'CMT1', 'CMT2', 'CMT3', 'CMT4']);
  assert.equal(out.banned, 2);
  assert.deepEqual(out.failed, []);
});

test('대표 댓글 1명짜리 요청이 거절돼도 다른 댓글로 재시도, 전부 실패하면 시도 수를 남긴다', async () => {
  const candidates = [candidate({ authorChannelId: 'B', alertIds: [2, 3], evidenceAlertId: 2 })];
  const banIds = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('select=id,comment_id')) return { ok: true, status: 200, json: async () => [2, 3].map((id) => ({ id, comment_id: `CMT${id}` })) };
    if (url.includes('/comments/setModerationStatus')) { banIds.push(new URL(url).searchParams.get('id')); return { ok: false, status: 400, text: async () => 'x' }; }
    if (init.method === 'PATCH') throw new Error('must not persist a failed ban');
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    { candidates, accessTokens: new Map([['OWNER1', 'tok']]) },
    fetchImpl,
  );
  assert.deepEqual(banIds, ['CMT2', 'CMT3']);
  assert.equal(out.banned, 0);
  assert.equal(out.failed[0].attempts, 1);
  assert.equal(out.failed[0].status, 400);
});

test('2026-10-19 재발방지: 두기 결정을 못 읽었으면 라이브 대량 밴을 거부한다(사람 결정 뒤집기 방지)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => [] }; };
  await assert.rejects(
    executeBulkBan(
      { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
      { candidates: [candidate()], accessTokens: new Map([['OWNER1', 'tok']]), keepDecisionsLoadError: 'HTTP 500' },
      fetchImpl,
    ),
    /Keep decisions unavailable/,
  );
  assert.equal(calls, 0);
});

test('2026-10-19 재발방지: 끝내 못 밴한 작성자는 needsStudioHide에 채널 URL과 함께 남긴다', async () => {
  const candidates = [candidate({ authorChannelId: 'UC_FAIL', handle: '@fail', alertIds: [1], evidenceAlertId: 1 })];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('select=id,comment_id')) return { ok: true, status: 200, json: async () => [{ id: 1, comment_id: 'CMT1' }] };
    if (url.includes('/comments/setModerationStatus')) return { ok: false, status: 400, text: async () => 'processingFailure' };
    if (init.method === 'PATCH') throw new Error('must not persist');
    throw new Error(`unexpected fetch ${url}`);
  };
  const out = await executeBulkBan(
    { dryRun: false, allowedAlertIds: new Set(), youtubeApiBase: 'https://yt', supabaseUrl: baseEnv.SUPABASE_URL, supabaseKey: 'srk', actor: 'test', banDelayMs: 0 },
    { candidates, accessTokens: new Map([['OWNER1', 'tok']]) },
    fetchImpl,
  );
  assert.deepEqual(out.needsStudioHide, [{ ownerChannelName: '먹는김에', handle: '@fail', channelUrl: 'https://www.youtube.com/channel/UC_FAIL' }]);
});
