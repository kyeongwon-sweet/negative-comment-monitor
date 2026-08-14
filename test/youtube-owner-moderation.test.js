import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupAlertsByOwner,
  loadYouTubeOwnerModerationConfig,
  moderateYouTubeOwnerAlerts,
  YOUTUBE_OWNER_HIDE_CONFIRMATION,
} from '../src/youtube-owner-moderation.js';

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function config(overrides = {}) {
  return {
    googleAdsClientId: 'client', googleAdsClientSecret: 'secret',
    supabaseUrl: 'https://db.test', supabaseKey: 'service',
    youtubeApiBase: 'https://youtube.test', dryRun: false, batchSize: 50,
    actor: 'bulk-test',
    ...overrides,
  };
}

test('실제 숨김은 명시적 확인 문구 없이는 시작하지 않는다', () => {
  assert.throws(() => loadYouTubeOwnerModerationConfig({
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
    YOUTUBE_OWNER_BULK_HIDE_DRY_RUN: 'false',
  }), /requires YOUTUBE_OWNER_BULK_HIDE_CONFIRM/);
  assert.equal(loadYouTubeOwnerModerationConfig({
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
    YOUTUBE_OWNER_BULK_HIDE_DRY_RUN: 'false',
    YOUTUBE_OWNER_BULK_HIDE_CONFIRM: YOUTUBE_OWNER_HIDE_CONFIRMATION,
  }).dryRun, false);
});

test('영상 소유 채널별로 알림을 나누고 누락 사유를 집계한다', () => {
  const result = groupAlertsByOwner([
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c1' },
    { post_url: 'https://youtube.com/watch?v=videoB1', comment_id: 'c2' },
    { post_url: 'https://youtube.com/watch?v=unknown1', comment_id: 'c3' },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: null },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c4', review_decision: 'hidden' },
  ], new Map([['videoA1', 'ownerA'], ['videoB1', 'ownerB']]));
  assert.equal(result.groups.get('ownerA').length, 1);
  assert.equal(result.groups.get('ownerB').length, 1);
  assert.equal(result.unmatchedVideo, 1);
  assert.equal(result.missingCommentId, 1);
  assert.equal(result.alreadyMarkedHidden, 1);
});

test('현재 노출 댓글만 소유자 토큰으로 rejected 처리하고 성공 행만 DB 갱신한다', async () => {
  const calls = [];
  const alerts = [
    { id: 1, comment_id: 'commentA', post_url: 'https://youtube.com/watch?v=videoA1', review_decision: null, reviewed_by: null, reviewed_at: null },
    { id: 2, comment_id: 'goneA', post_url: 'https://youtube.com/watch?v=videoA1', review_decision: 'false_positive', reviewed_by: 'U_HUMAN', reviewed_at: '2026-08-14T00:00:00Z' },
    { id: 3, comment_id: 'commentB', post_url: 'https://youtube.com/watch?v=videoB1', review_decision: null, reviewed_by: null, reviewed_at: null },
  ];
  const result = await moderateYouTubeOwnerAlerts(config(), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [
      { kind: 'youtube_owner:ownerA', token: 'refreshA' },
      { kind: 'youtube_owner:ownerB', token: 'refreshB' },
    ]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, alerts);
    if (url.includes('oauth2.googleapis.com')) {
      const refresh = new URLSearchParams(init.body).get('refresh_token');
      return response(200, { access_token: refresh === 'refreshA' ? 'accessA' : 'accessB' });
    }
    if (url.includes('/channels')) {
      return response(200, { items: [{ id: init.headers.Authorization.endsWith('accessA') ? 'ownerA' : 'ownerB' }] });
    }
    if (url.includes('/videos')) {
      return response(200, { items: [
        { id: 'videoA1', snippet: { channelId: 'ownerA' } },
        { id: 'videoB1', snippet: { channelId: 'ownerB' } },
      ] });
    }
    if (url.includes('/comments?')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      return response(200, { items: ids.filter((id) => id !== 'goneA').map((id) => ({ id })) });
    }
    if (url.includes('/comments/setModerationStatus')) return response(204);
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') return response(200, [{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  }, Date.parse('2026-08-14T12:00:00Z'));

  assert.equal(result.totalAlerts, 3);
  assert.equal(result.hidden, 2);
  assert.equal(result.unavailableOrAlreadyHidden, 1);
  assert.equal(result.dbUpdated, 2);
  const moderation = calls.filter((call) => call.url.includes('/comments/setModerationStatus'));
  assert.equal(moderation.length, 2);
  assert.ok(moderation.every((call) => new URL(call.url).searchParams.get('moderationStatus') === 'rejected'));
  assert.ok(moderation.every((call) => call.init.method === 'POST'));
  const patches = calls.filter((call) => call.init.method === 'PATCH');
  assert.ok(patches.every((call) => JSON.parse(call.init.body).review_decision === 'hidden'));
});

