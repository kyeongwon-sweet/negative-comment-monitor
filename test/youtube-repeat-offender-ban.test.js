import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeAuthorBanUrl,
  loadYouTubeRepeatOffenderBanConfig,
  YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRMATION,
} from '../src/youtube-repeat-offender-ban.js';

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
