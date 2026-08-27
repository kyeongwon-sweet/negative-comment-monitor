import test from 'node:test';
import assert from 'node:assert/strict';
import { isPintCampaign, selectPintAwarenessAlerts } from '../src/pint-awareness-retag.js';

test('파인트 캠페인명만 인지광고 재태그 대상으로 판별한다', () => {
  assert.equal(isPintCampaign('[빙과] 파인트 인지'), true);
  assert.equal(isPintCampaign('[빙과] 쫀득바 인지'), false);
  assert.equal(isPintCampaign(''), false);
});

test('플랫폼별 실측 후보와 알림을 comment/video ID로만 안전하게 교차한다', () => {
  const alerts = [
    { id: 1, source: 'meta_ads', comment_id: 'm1', post_url: 'https://instagram.test/p/1' },
    { id: 2, source: 'tiktok_ads', comment_id: 't1', post_url: 'https://tiktok.test/@ad/video/1' },
    { id: 3, source: 'youtube_ads', comment_id: 'y1', post_url: 'https://youtube.com/watch?v=video1' },
    { id: 4, source: 'youtube_ads', comment_id: 'y2', post_url: 'https://youtube.com/shorts/video2' },
    { id: 5, source: 'meta_ads', comment_id: 'm2', post_url: 'https://instagram.test/p/2' },
  ];
  const selected = selectPintAwarenessAlerts(alerts, {
    metaCommentIds: new Set(['m1']),
    tiktokCommentIds: new Set(['t1']),
    youtubeVideoIds: new Set(['video1']),
  });
  assert.deepEqual(selected.map((row) => row.id), [1, 2, 3]);
});
