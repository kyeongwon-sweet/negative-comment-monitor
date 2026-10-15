import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeAuthorBanUrl,
  loadYouTubeRepeatOffenderBanConfig,
  persistBanEvidence,
  YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRMATION,
} from '../src/youtube-repeat-offender-ban.js';

test('2026-10-15 재발방지: 단일 밴 성공 시 후보의 모든 alert 행을 author_banned로(이미 hidden이어도)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true }; };
  await persistBanEvidence({ supabaseUrl: 'https://db.test', supabaseKey: 'svc', actor: 'tester' }, [7698, 7779, 8171, 7698], fetchImpl, Date.parse('2026-10-15T00:51:00Z'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /negative_comment_alerts\?id=in\.\(7698,7779,8171\)$/, '중복 제거·전 행 대상');
  assert.doesNotMatch(calls[0].url, /review_decision=is\.null/, '이미 자동숨김(hidden)된 행도 갱신');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(JSON.parse(calls[0].init.body).review_decision, 'author_banned');
});

const ENV = {
  GOOGLE_ADS_CLIENT_ID: 'client',
  GOOGLE_ADS_CLIENT_SECRET: 'secret',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  YOUTUBE_REPEAT_OFFENDER_ALERT_ID: '123',
};

test('YouTube 작성자 차단은 명시 확인 문자열 없이는 로드되지 않는다', () => {
  assert.throws(() => loadYouTubeRepeatOffenderBanConfig(ENV), /BAN_YOUTUBE_REPEAT_OFFENDER/);
  assert.equal(loadYouTubeRepeatOffenderBanConfig({
    ...ENV,
    YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRM: YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRMATION,
  }).alertId, 123);
});

test('YouTube 작성자 차단 API는 rejected와 banAuthor=true를 함께 강제한다', () => {
  const url = buildYouTubeAuthorBanUrl('https://www.googleapis.com/youtube/v3', 'comment-id');
  assert.equal(url.pathname, '/youtube/v3/comments/setModerationStatus');
  assert.equal(url.searchParams.get('moderationStatus'), 'rejected');
  assert.equal(url.searchParams.get('banAuthor'), 'true');
});
