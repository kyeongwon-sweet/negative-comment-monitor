import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupAlertsByOwner,
  loadYouTubeOwnerAlerts,
  loadYouTubeOwnerModerationConfig,
  moderateYouTubeOwnerAlerts,
  YOUTUBE_OWNER_ALERT_SCOPES,
  YOUTUBE_OWNER_HIDE_CONFIRMATION,
  YOUTUBE_OWNER_SINGLE_HIDE_CONFIRMATION,
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
    hideVerificationAttempts: 1, hideVerificationDelayMs: 1, sleep: async () => {},
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

test('단일 Slack 카드 숨김은 별도 확인 문구와 channel+ts 쌍을 요구한다', () => {
  assert.throws(() => loadYouTubeOwnerModerationConfig({
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
    YOUTUBE_OWNER_BULK_HIDE_DRY_RUN: 'false',
    YOUTUBE_OWNER_ALERT_SLACK_CHANNEL_ID: 'C1',
  }), /both alert Slack channel and timestamp/);
  const single = loadYouTubeOwnerModerationConfig({
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
    YOUTUBE_OWNER_BULK_HIDE_DRY_RUN: 'false',
    YOUTUBE_OWNER_BULK_HIDE_CONFIRM: YOUTUBE_OWNER_SINGLE_HIDE_CONFIRMATION,
    YOUTUBE_OWNER_ALERT_SLACK_CHANNEL_ID: 'C1',
    YOUTUBE_OWNER_ALERT_SLACK_TS: '1.2',
  });
  assert.equal(single.singleAlert, true);
  assert.equal(single.alertMessageTs, '1.2');
});

test('영상 소유 채널별로 알림을 나누고 누락 사유를 집계한다', () => {
  const result = groupAlertsByOwner([
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c1' },
    { post_url: 'https://youtube.com/watch?v=videoB1', comment_id: 'c2' },
    { post_url: 'https://youtube.com/watch?v=unknown1', comment_id: 'c3' },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: null },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c4', review_decision: 'hidden' },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c5', review_decision: 'false_positive', reviewed_by: 'U1' },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c6', review_decision: 'complete', reviewed_by: 'U2' },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c7', review_decision: 'hide', reviewed_by: 'U3' },
  ], new Map([['videoA1', 'ownerA'], ['videoB1', 'ownerB']]));
  assert.equal(result.groups.get('ownerA').length, 1);
  assert.equal(result.groups.get('ownerB').length, 1);
  assert.equal(result.unmatchedVideo, 1);
  assert.equal(result.missingCommentId, 1);
  assert.equal(result.alreadyMarkedHidden, 1);
  assert.equal(result.skippedHumanDecision, 3);

  const single = groupAlertsByOwner([
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c7', review_decision: 'hide', reviewed_by: 'U3' },
  ], new Map([['videoA1', 'ownerA']]), { singleAlert: true });
  assert.equal(single.groups.get('ownerA').length, 1);

  const automatic = groupAlertsByOwner([
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c6', review_decision: 'complete', reviewed_by: 'U2' },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c7', review_decision: 'hide', reviewed_by: 'U3' },
    { post_url: 'https://youtube.com/watch?v=videoA1', comment_id: 'c8', review_decision: 'false_positive', reviewed_by: 'U4' },
  ], new Map([['videoA1', 'ownerA']]), { autoHideAllNegatives: true });
  assert.deepEqual(automatic.groups.get('ownerA').map((row) => row.comment_id), ['c6', 'c7']);
  assert.equal(automatic.skippedHumanDecision, 1);
});

test('오가닉 위성 범위는 source=null YouTube 중 허용 영상만 읽는다', async () => {
  let requested = '';
  const rows = [
    { id: 1, platform: 'youtube', source: null, post_url: 'https://youtube.com/watch?v=allowedA' },
    { id: 2, platform: 'youtube', source: null, post_url: 'https://youtube.com/watch?v=thirdPartyB' },
  ];
  const result = await loadYouTubeOwnerAlerts(config({
    alertScope: YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
    allowedVideoIds: new Set(['allowedA']),
  }), async (input) => {
    requested = String(input);
    return response(200, rows);
  });
  assert.deepEqual(result.map((row) => row.id), [1]);
  assert.match(requested, /source=is\.null/);
  assert.match(requested, /platform=eq\.youtube/);
});

test('오가닉 위성 자동숨김은 keep 결정을 제외하고 source IS NULL 행만 갱신한다', async () => {
  const calls = [];
  let rejected = false;
  const alerts = [
    { id: 1, platform: 'youtube', source: null, comment_id: 'autoA', post_url: 'https://youtube.com/watch?v=allowedA' },
    { id: 2, platform: 'youtube', source: null, comment_id: 'keepA', post_url: 'https://youtube.com/watch?v=allowedA', review_decision: 'false_positive', reviewed_by: 'U1' },
    { id: 3, platform: 'youtube', source: null, comment_id: 'unhideA', post_url: 'https://youtube.com/watch?v=allowedA', review_decision: 'unhide', reviewed_by: 'U2' },
  ];
  const result = await moderateYouTubeOwnerAlerts(config({
    alertScope: YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
    allowedVideoIds: new Set(['allowedA']),
    autoHideAllNegatives: true,
  }), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, alerts);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:ownerA', token: 'refreshA' }]);
    if (url.includes('oauth2.googleapis.com')) return response(200, { access_token: 'accessA' });
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerA' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'allowedA', snippet: { channelId: 'ownerA' } }] });
    if (url.includes('/comments?')) return response(200, { items: rejected ? [] : [{ id: 'autoA' }] });
    if (url.includes('/comments/setModerationStatus')) { rejected = true; return response(204); }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') return response(200, [{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(result.hidden, 1);
  assert.equal(result.skippedHumanDecision, 2);
  const patch = calls.find((call) => call.init.method === 'PATCH');
  assert.match(patch.url, /source=is\.null/);
  assert.match(patch.url, /platform=eq\.youtube/);
});

test('현재 노출 댓글만 소유자 토큰으로 rejected 처리하고 성공 행만 DB 갱신한다', async () => {
  const calls = [];
  const rejected = new Set();
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
      return response(200, { items: ids.filter((id) => id !== 'goneA' && !rejected.has(id)).map((id) => ({ id })) });
    }
    if (url.includes('/comments/setModerationStatus')) {
      for (const id of new URL(url).searchParams.get('id').split(',')) rejected.add(id);
      return response(204);
    }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') return response(200, [{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  }, Date.parse('2026-08-14T12:00:00Z'));

  assert.equal(result.totalAlerts, 3);
  assert.equal(result.hidden, 2);
  assert.equal(result.unavailableOrAlreadyHidden, 0);
  assert.equal(result.skippedHumanDecision, 1);
  assert.equal(result.dbUpdated, 2);
  const moderation = calls.filter((call) => call.url.includes('/comments/setModerationStatus'));
  assert.equal(moderation.length, 2);
  assert.ok(moderation.every((call) => new URL(call.url).searchParams.get('moderationStatus') === 'rejected'));
  assert.ok(moderation.every((call) => call.init.method === 'POST'));
  const commentReads = calls.filter((call) => call.url.includes('/comments?'));
  assert.ok(commentReads.every((call) => !new URL(call.url).searchParams.has('maxResults')));
  const patches = calls.filter((call) => call.init.method === 'PATCH');
  assert.ok(patches.every((call) => JSON.parse(call.init.body).review_decision === 'hidden'));
  assert.equal(calls.filter((call) => call.url.includes('/videos')).length, 1);
});

test('직전 숨김 전파가 늦어 다음 실행에서 조회불가가 된 미처리 행은 DB·Slack을 완료로 수렴한다', async () => {
  const alert = {
    id: 21, comment_id: 'delayedA', post_url: 'https://youtube.com/watch?v=videoA1',
    review_decision: null, reviewed_by: null, reviewed_at: null,
  };
  let patches = 0;
  const result = await moderateYouTubeOwnerAlerts(config(), async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:ownerA', token: 'refreshA' }]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, [alert]);
    if (url.includes('oauth2.googleapis.com')) return response(200, { access_token: 'accessA' });
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerA' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'videoA1', snippet: { channelId: 'ownerA' } }] });
    if (url.includes('/comments?')) return response(200, { items: [] });
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') {
      patches += 1;
      return response(200, [{ id: 21 }]);
    }
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(result.unavailableOrAlreadyHidden, 1);
  assert.equal(result.dbUpdated, 1);
  assert.equal(patches, 1);
  assert.equal(result.attempted, 0);
});

test('사람이 누른 YouTube 숨김은 실제 처리하되 review_decision과 행위자를 덮지 않는다', async () => {
  const calls = [];
  let rejected = false;
  const alert = {
    id: 11, comment_id: 'commentA', post_url: 'https://youtube.com/watch?v=videoA1',
    review_decision: 'hide', reviewed_by: 'U_HUMAN', reviewed_at: '2026-08-14T01:00:00Z',
    slack_channel_id: 'C1', slack_ts: '1.2',
  };
  const result = await moderateYouTubeOwnerAlerts(config({
    singleAlert: true, alertChannelId: 'C1', alertMessageTs: '1.2',
  }), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:ownerA', token: 'refreshA' }]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, [alert]);
    if (url.includes('oauth2.googleapis.com')) return response(200, { access_token: 'accessA' });
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerA' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'videoA1', snippet: { channelId: 'ownerA' } }] });
    if (url.includes('/comments?')) return response(200, { items: rejected ? [] : [{ id: 'commentA' }] });
    if (url.includes('/comments/setModerationStatus')) { rejected = true; return response(204); }
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(result.hidden, 1);
  assert.equal(result.dbUpdated, 0);
  assert.equal(calls.filter((call) => call.init.method === 'PATCH').length, 0);
  assert.equal(alert.review_decision, 'hide');
  assert.equal(alert.reviewed_by, 'U_HUMAN');
});

test('배치 404는 이진 분할해 정상 댓글 성공을 보존하고 문제 댓글만 격리한다', async () => {
  const calls = [];
  const rejected = new Set();
  const alerts = ['goodA', 'badA', 'goodB'].map((commentId, index) => ({
    id: index + 1, comment_id: commentId, post_url: 'https://youtube.com/watch?v=videoA1',
    review_decision: null, reviewed_by: null, reviewed_at: null,
  }));
  const result = await moderateYouTubeOwnerAlerts(config(), async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:ownerA', token: 'refreshA' }]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, alerts);
    if (url.includes('oauth2.googleapis.com')) return response(200, { access_token: 'accessA' });
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerA' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'videoA1', snippet: { channelId: 'ownerA' } }] });
    if (url.includes('/comments?')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      return response(200, { items: ids.filter((id) => !rejected.has(id)).map((id) => ({ id })) });
    }
    if (url.includes('/comments/setModerationStatus')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      if (ids.includes('badA')) return response(404, { error: { errors: [{ reason: 'commentNotFound' }] } });
      ids.forEach((id) => rejected.add(id));
      return response(204);
    }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') return response(200, [{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(result.hidden, 2);
  assert.equal(result.moderationUnavailable, 1);
  assert.equal(result.moderationFailed, 0);
  assert.equal(result.dbUpdated, 2);
  const moderationSizes = calls
    .filter((call) => call.url.includes('/comments/setModerationStatus'))
    .map((call) => new URL(call.url).searchParams.get('id').split(',').length);
  assert.deepEqual(moderationSizes, [3, 2, 1, 1, 1]);
});

test('204 뒤에도 보이는 댓글은 성공 기록·즉시 재시도 없이 미확인으로 남긴다', async () => {
  let moderationCalls = 0;
  let patchCalls = 0;
  const alert = { id: 1, comment_id: 'slowA', post_url: 'https://youtube.com/watch?v=videoA1' };
  const result = await moderateYouTubeOwnerAlerts(config(), async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:ownerA', token: 'refreshA' }]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, [alert]);
    if (url.includes('oauth2.googleapis.com')) return response(200, { access_token: 'accessA' });
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerA' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'videoA1', snippet: { channelId: 'ownerA' } }] });
    if (url.includes('/comments?')) return response(200, { items: [{ id: 'slowA' }] });
    if (url.includes('/comments/setModerationStatus')) { moderationCalls += 1; return response(204); }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') { patchCalls += 1; return response(200, []); }
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(result.hidden, 0);
  assert.equal(result.acceptedUnverified, 1);
  assert.equal(moderationCalls, 1);
  assert.equal(patchCalls, 0);
});

test('204 직후 published여도 짧게 재확인해 rejected 전파를 확정하고 한 번만 기록한다', async () => {
  let moderationCalls = 0;
  let verificationReads = 0;
  let patchCalls = 0;
  let waits = 0;
  const alert = { id: 1, comment_id: 'delayedA', post_url: 'https://youtube.com/watch?v=videoA1' };
  const result = await moderateYouTubeOwnerAlerts(config({
    hideVerificationAttempts: 5,
    sleep: async () => { waits += 1; },
  }), async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:ownerA', token: 'refreshA' }]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, [alert]);
    if (url.includes('oauth2.googleapis.com')) return response(200, { access_token: 'accessA' });
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerA' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'videoA1', snippet: { channelId: 'ownerA' } }] });
    if (url.includes('/comments?')) {
      // 첫 호출은 숨김 전 노출 확인. POST 뒤 두 번은 전파 지연, 세 번째에 목록에서 사라진다.
      if (moderationCalls) verificationReads += 1;
      return response(200, { items: moderationCalls && verificationReads >= 3 ? [] : [{ id: 'delayedA' }] });
    }
    if (url.includes('/comments/setModerationStatus')) { moderationCalls += 1; return response(204); }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') {
      patchCalls += 1;
      return response(200, [{ id: 1 }]);
    }
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(result.hidden, 1);
  assert.equal(result.acceptedUnverified, 0);
  assert.equal(result.verificationRetries, 2);
  assert.equal(moderationCalls, 1);
  assert.equal(verificationReads, 3);
  assert.equal(waits, 2);
  assert.equal(patchCalls, 1);
});

test('한 채널의 403은 그 채널만 중단하고 다른 소유 채널은 계속 숨긴다', async () => {
  const rejected = new Set();
  const alerts = [
    { id: 1, comment_id: 'commentA', post_url: 'https://youtube.com/watch?v=videoA1' },
    { id: 2, comment_id: 'commentB', post_url: 'https://youtube.com/watch?v=videoB1' },
  ];
  const result = await moderateYouTubeOwnerAlerts(config(), async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [
      { kind: 'youtube_owner:ownerA', token: 'refreshA' },
      { kind: 'youtube_owner:ownerB', token: 'refreshB' },
    ]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, alerts);
    if (url.includes('oauth2.googleapis.com')) {
      const refresh = new URLSearchParams(init.body).get('refresh_token');
      return response(200, { access_token: refresh === 'refreshA' ? 'accessA' : 'accessB' });
    }
    if (url.includes('/channels')) return response(200, { items: [{ id: init.headers.Authorization.endsWith('accessA') ? 'ownerA' : 'ownerB' }] });
    if (url.includes('/videos')) return response(200, { items: [
      { id: 'videoA1', snippet: { channelId: 'ownerA' } },
      { id: 'videoB1', snippet: { channelId: 'ownerB' } },
    ] });
    if (url.includes('/comments?')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      return response(200, { items: ids.filter((id) => !rejected.has(id)).map((id) => ({ id })) });
    }
    if (url.includes('/comments/setModerationStatus')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      if (ids.includes('commentA')) return response(403, { error: { errors: [{ reason: 'forbidden' }] } });
      ids.forEach((id) => rejected.add(id));
      return response(204);
    }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') return response(200, [{ id: 2 }]);
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(result.hidden, 1);
  assert.equal(result.channelFailures, 1);
  assert.equal(result.dbUpdated, 1);
  assert.equal(result.owners.find((owner) => owner.channelId === 'ownerA').error.stage, 'moderation');
  assert.equal(result.owners.find((owner) => owner.channelId === 'ownerB').hidden, 1);
});

test('한 소유자 refresh token 실패는 다른 채널 처리를 막지 않는다', async () => {
  const rejected = new Set();
  const alerts = [
    { id: 1, comment_id: 'commentA', post_url: 'https://youtube.com/watch?v=videoA1' },
    { id: 2, comment_id: 'commentB', post_url: 'https://youtube.com/watch?v=videoB1' },
  ];
  const result = await moderateYouTubeOwnerAlerts(config(), async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [
      { kind: 'youtube_owner:ownerA', token: 'refreshA' },
      { kind: 'youtube_owner:ownerB', token: 'refreshB' },
    ]);
    if (url.includes('/rest/v1/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, alerts);
    if (url.includes('oauth2.googleapis.com')) {
      const refresh = new URLSearchParams(init.body).get('refresh_token');
      return refresh === 'refreshA'
        ? response(400, { error: 'invalid_grant' })
        : response(200, { access_token: 'accessB' });
    }
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerB' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'videoB1', snippet: { channelId: 'ownerB' } }] });
    if (url.includes('/comments?')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      return response(200, { items: ids.filter((id) => !rejected.has(id)).map((id) => ({ id })) });
    }
    if (url.includes('/comments/setModerationStatus')) {
      for (const id of new URL(url).searchParams.get('id').split(',')) rejected.add(id);
      return response(204);
    }
    if (url.includes('/rest/v1/negative_comment_alerts') && init.method === 'PATCH') return response(200, [{ id: 2 }]);
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(result.ownerTokenFailures.length, 1);
  assert.equal(result.validOwnerTokens, 1);
  assert.equal(result.hidden, 1);
  assert.equal(result.unmatchedVideo, 1);
});

