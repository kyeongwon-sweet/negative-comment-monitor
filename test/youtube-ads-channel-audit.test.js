import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAlertChannels } from '../src/youtube-ads-channel-audit.js';

test('발송 알림을 실제 영상 소유 채널별로 집계한다', () => {
  const videos = [
    { id: 'v1', snippet: { channelId: 'c1', channelTitle: '광고채널' } },
    { id: 'v2', snippet: { channelId: 'c2', channelTitle: '브랜드채널' } },
  ];
  const alerts = [
    { post_url: 'https://www.youtube.com/watch?v=v1', review_decision: null },
    { post_url: 'https://www.youtube.com/watch?v=v1&lc=x', review_decision: 'false_positive' },
    { post_url: 'https://www.youtube.com/watch?v=missing', review_decision: null },
  ];
  const result = summarizeAlertChannels(videos, alerts);
  assert.equal(result.totalAlerts, 3);
  assert.equal(result.unmatchedAlerts, 1);
  assert.deepEqual(result.channels[0], {
    channelId: 'c1', channelTitle: '광고채널', alertCount: 2, falsePositiveCount: 1, videoIds: undefined, videoCount: 1,
  });
});
