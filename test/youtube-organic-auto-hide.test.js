import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoHideOrganicSatelliteYouTube,
  ownerModerationConfigFromMonitor,
  satelliteYouTubeVideoIds,
} from '../src/youtube-organic-auto-hide.js';
import { YOUTUBE_OWNER_ALERT_SCOPES } from '../src/youtube-owner-moderation.js';

test('위성 YouTube 영상만 허용목록에 넣고 TikTok·협찬·온드는 제외한다', () => {
  const ids = satelliteYouTubeVideoIds([
    { url: 'https://youtube.com/shorts/satelliteA', channelCategory: '위성채널' },
    { url: 'https://youtu.be/satelliteB', channelCategory: '위성채널 (배너)' },
    { url: 'https://youtube.com/watch?v=sponsorC', channelCategory: '협찬 (인플루언서)' },
    { url: 'https://youtube.com/watch?v=ownedD', channelCategory: '온드미디어' },
    { url: 'https://tiktok.com/@x/video/123', channelCategory: '위성채널' },
  ]);
  assert.deepEqual([...ids], ['satelliteA', 'satelliteB']);
});

test('모니터 자동숨김 설정은 오가닉 위성 scope와 사람결정 보호 모드를 사용한다', () => {
  const ids = new Set(['satelliteA']);
  const result = ownerModerationConfigFromMonitor({
    googleAdsClientId: 'client', googleAdsClientSecret: 'secret',
    supabaseUrl: 'https://db.test', supabaseKey: 'service', slackBotToken: 'slack',
  }, ids);
  assert.equal(result.alertScope, YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE);
  assert.equal(result.autoHideAllNegatives, true);
  assert.equal(result.allowedVideoIds, ids);
  assert.equal(result.actor, 'youtube-organic-satellite-auto-hide');
});

test('자동숨김 비활성·대상없음은 OAuth나 API 없이 종료한다', async () => {
  assert.deepEqual(await autoHideOrganicSatelliteYouTube({ dryRun: false, youtubeSatelliteAutoHide: false }, []), { skipped: 'disabled' });
  assert.deepEqual(await autoHideOrganicSatelliteYouTube({ dryRun: false, youtubeSatelliteAutoHide: true }, [
    { url: 'https://youtube.com/watch?v=sponsorC', channelCategory: '협찬' },
  ]), { skipped: 'no-satellite-youtube-targets' });
});
