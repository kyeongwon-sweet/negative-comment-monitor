import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoRestoreYouTubeFalsePositives,
  loadYouTubeAutoRestoreConfig,
  loadYouTubeRestoreConfig,
  restoreYouTubeComments,
  YOUTUBE_AUTO_RESTORE_CONFIRMATION,
  YOUTUBE_RESTORE_CONFIRMATION,
} from '../src/youtube-comment-restore.js';

const BASE_ENV = {
  YOUTUBE_RESTORE_SLACK_CHANNEL_ID: 'C1',
  YOUTUBE_RESTORE_SLACK_TS_CSV: '1.1,1.2',
  GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
};

function response(status, payload = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('YouTube 공개 복원은 확인문구와 정확한 Slack ts가 필수다', () => {
  assert.throws(() => loadYouTubeRestoreConfig(BASE_ENV), /RESTORE_YOUTUBE_COMMENTS/);
  const config = loadYouTubeRestoreConfig({ ...BASE_ENV, YOUTUBE_RESTORE_CONFIRM: YOUTUBE_RESTORE_CONFIRMATION });
  assert.deepEqual(config.slackTimestamps, ['1.1', '1.2']);
  assert.throws(() => loadYouTubeRestoreConfig({
    ...BASE_ENV,
    YOUTUBE_RESTORE_CONFIRM: YOUTUBE_RESTORE_CONFIRMATION,
    YOUTUBE_RESTORE_SLACK_TS_CSV: 'bad',
  }), /Invalid Slack timestamp/);
});

test('YouTube FP 자동복원은 별도 명시적 활성화와 제한된 최근 조회창을 요구한다', () => {
  assert.throws(() => loadYouTubeAutoRestoreConfig(BASE_ENV), /AUTO_RESTORE_YOUTUBE_FALSE_POSITIVES/);
  const config = loadYouTubeAutoRestoreConfig({
    ...BASE_ENV,
    YOUTUBE_FP_AUTO_RESTORE: YOUTUBE_AUTO_RESTORE_CONFIRMATION,
    YOUTUBE_FP_AUTO_RESTORE_LOOKBACK_HOURS: '24',
    YOUTUBE_FP_AUTO_RESTORE_MAX_ROWS: '25',
  });
  assert.equal(config.lookbackHours, 24);
  assert.equal(config.maxRows, 25);
});

test('사람 오탐인 선택 댓글만 published 복원하고 공개 상태를 재확인한다', async () => {
  let published = false;
  const calls = [];
  const rows = {
    '1.1': { id: 1, source: 'youtube_ads', platform: 'youtube', comment_id: 'c1', comment_text: 'a', post_url: 'https://youtube.com/watch?v=videoAAAA01', review_decision: 'false_positive', reviewed_by: 'U1', reviewed_at: 'x', slack_channel_id: 'C1', slack_ts: '1.1', fingerprint: 'fp1' },
    '1.2': { id: 2, source: 'youtube_ads', platform: 'youtube', comment_id: 'c2', comment_text: 'b', post_url: 'https://youtube.com/watch?v=videoAAAA01', review_decision: 'false_positive', reviewed_by: 'U1', reviewed_at: 'x', slack_channel_id: 'C1', slack_ts: '1.2', fingerprint: 'fp2' },
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://db.test/rest/v1/negative_comment_alerts?') && (!init.method || init.method === 'GET')) {
      const ts = new URL(url).searchParams.get('slack_ts').slice(3);
      return response(200, [rows[ts]]);
    }
    if (url.startsWith('https://db.test/rest/v1/negative_comment_alerts?id=eq.') && init.method === 'PATCH') return response(200, [{}]);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:owner1', token: 'refresh' }]);
    if (url === 'https://oauth2.googleapis.com/token') return response(200, { access_token: 'access' });
    if (url.includes('/channels?')) return response(200, { items: [{ id: 'owner1' }] });
    if (url.includes('/videos?')) return response(200, { items: [{ id: 'videoAAAA01', snippet: { channelId: 'owner1' } }] });
    if (url.includes('/comments/setModerationStatus')) {
      assert.equal(new URL(url).searchParams.get('moderationStatus'), 'published');
      published = true;
      return response(204);
    }
    if (url.includes('/comments?')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      // 실제 API처럼 숨김 댓글은 직접 조회에서 빠질 수 있다. 복원 뒤에만 공개로 보인다.
      return response(200, { items: published ? ids.map((id) => ({ id, snippet: { moderationStatus: 'published' } })) : [] });
    }
    if (url === 'https://slack.com/api/chat.update') return response(200, { ok: true });
    throw new Error(`unexpected ${url}`);
  };
  const config = {
    googleAdsClientId: 'client', googleAdsClientSecret: 'secret', supabaseUrl: 'https://db.test', supabaseKey: 'service',
    slackBotToken: 'slack', slackChannelId: 'C1', slackTimestamps: ['1.1', '1.2'], youtubeApiBase: 'https://youtube.test',
    actor: 'U0', falsePositiveReason: 'positive_neutral', verificationAttempts: 1, verificationDelayMs: 1,
  };
  const result = await restoreYouTubeComments(config, fetchImpl, Date.parse('2026-08-24T00:00:00Z'));
  assert.equal(result.requested, 2);
  assert.equal(result.restored, 2);
  assert.equal(result.verifiedVisible, 2);
  assert.equal(result.fingerprintsProtected, 2);
  assert.equal(result.slack.updated, 2);
  const patches = calls.filter((call) => call.init.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.ok(patches.every((call) => JSON.parse(call.init.body).review_decision === 'false_positive'));
  assert.equal(JSON.stringify(result).includes('c1'), false);
});

test('사람 유지 결정이 아니면 플랫폼을 호출하지 않는다', async () => {
  const config = {
    googleAdsClientId: 'client', googleAdsClientSecret: 'secret', supabaseUrl: 'https://db.test', supabaseKey: 'service',
    slackBotToken: '', slackChannelId: 'C1', slackTimestamps: ['1.1'], youtubeApiBase: 'https://youtube.test', actor: 'U0', falsePositiveReason: 'other',
    verificationAttempts: 1, verificationDelayMs: 1,
  };
  await assert.rejects(() => restoreYouTubeComments(config, async (input) => {
    if (String(input).includes('/negative_comment_alerts?')) return response(200, [{
      id: 1, source: 'youtube_ads', platform: 'youtube', comment_id: 'c1', post_url: 'https://youtube.com/watch?v=videoAAAA01', review_decision: 'hidden', slack_channel_id: 'C1', slack_ts: '1.1',
    }]);
    throw new Error('must not call platform');
  }), /explicit human keep decision/);
});

test('최근 YouTube false_positive가 실제 숨김이면 published 복원하고 사람 결정을 덮지 않는다', async () => {
  let published = false;
  const calls = [];
  const row = {
    id: 7, source: null, platform: 'youtube', comment_id: 'private-comment', comment_text: '정상',
    post_url: 'https://youtube.com/watch?v=videoAAAA01', review_decision: 'false_positive',
    reviewed_by: 'U_HUMAN', reviewed_at: '2026-08-26T00:00:00Z', slack_channel_id: 'C1', slack_ts: '1.7', fingerprint: 'fp7',
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/negative_comment_alerts?') && (!init.method || init.method === 'GET')) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('platform'), 'eq.youtube');
      assert.equal(parsed.searchParams.get('review_decision'), 'eq.false_positive');
      assert.match(parsed.searchParams.get('reviewed_at'), /^gte\./);
      return response(200, [row]);
    }
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:owner1', token: 'refresh' }]);
    if (url === 'https://oauth2.googleapis.com/token') return response(200, { access_token: 'access' });
    if (url.includes('/channels?')) return response(200, { items: [{ id: 'owner1' }] });
    if (url.includes('/videos?')) return response(200, { items: [{ id: 'videoAAAA01', snippet: { channelId: 'owner1' } }] });
    if (url.includes('/comments/setModerationStatus')) {
      assert.equal(new URL(url).searchParams.get('moderationStatus'), 'published');
      published = true;
      return response(204);
    }
    if (url.includes('/comments?')) {
      return response(200, { items: published ? [{ id: 'private-comment', snippet: { moderationStatus: 'published' } }] : [] });
    }
    if (url === 'https://slack.com/api/chat.update') return response(200, { ok: true });
    throw new Error(`unexpected ${url}`);
  };
  const config = {
    googleAdsClientId: 'client', googleAdsClientSecret: 'secret', supabaseUrl: 'https://db.test', supabaseKey: 'service',
    slackBotToken: 'slack', youtubeApiBase: 'https://youtube.test', lookbackHours: 48, maxRows: 100,
    verificationAttempts: 1, verificationDelayMs: 1,
  };
  const result = await autoRestoreYouTubeFalsePositives(config, fetchImpl, Date.parse('2026-08-26T01:00:00Z'));
  assert.equal(result.candidates, 1);
  assert.equal(result.restored, 1);
  assert.equal(result.slackUpdated, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.some((call) => call.init.method === 'PATCH'), false);
  assert.equal(JSON.stringify(result).includes('private-comment'), false);
});

test('이미 공개인 FP와 비소유 YouTube는 자동복원에서 변경하지 않는다', async () => {
  const rows = [
    { id: 1, source: 'youtube_ads', platform: 'youtube', comment_id: 'visible', post_url: 'https://youtu.be/ownedVideo1', review_decision: 'false_positive', reviewed_at: '2026-08-26T00:00:00Z' },
    { id: 2, source: null, platform: 'youtube', comment_id: 'external', post_url: 'https://youtu.be/externalVid1', review_decision: 'false_positive', reviewed_at: '2026-08-26T00:00:00Z' },
  ];
  let writes = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (init.method === 'POST' || init.method === 'PATCH') writes += 1;
    if (url.includes('/negative_comment_alerts?')) return response(200, rows);
    if (url.includes('/rest/v1/meta_tokens')) return response(200, [{ kind: 'youtube_owner:owner1', token: 'refresh' }]);
    if (url === 'https://oauth2.googleapis.com/token') return response(200, { access_token: 'access' });
    if (url.includes('/channels?')) return response(200, { items: [{ id: 'owner1' }] });
    if (url.includes('/videos?')) return response(200, { items: [
      { id: 'ownedVideo1', snippet: { channelId: 'owner1' } },
      { id: 'externalVid1', snippet: { channelId: 'third-party' } },
    ] });
    if (url.includes('/comments?')) return response(200, { items: [{ id: 'visible', snippet: { moderationStatus: 'published' } }] });
    throw new Error(`unexpected ${url}`);
  };
  const result = await autoRestoreYouTubeFalsePositives({
    googleAdsClientId: 'client', googleAdsClientSecret: 'secret', supabaseUrl: 'https://db.test', supabaseKey: 'service',
    slackBotToken: '', youtubeApiBase: 'https://youtube.test', lookbackHours: 48, maxRows: 100,
    verificationAttempts: 1, verificationDelayMs: 1,
  }, fetchImpl, Date.parse('2026-08-26T01:00:00Z'));
  assert.equal(result.alreadyVisible, 1);
  assert.equal(result.unowned, 1);
  assert.equal(result.restoreAttempted, 0);
  // OAuth refresh POST만 존재하며 댓글 모더레이션·DB 쓰기는 없다.
  assert.equal(writes, 1);
});
