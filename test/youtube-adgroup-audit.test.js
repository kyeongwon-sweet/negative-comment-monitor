import test from 'node:test';
import assert from 'node:assert/strict';
import { adGroupNameMatches, summarizeAdGroupAudit } from '../src/youtube-adgroup-audit.js';
import { commentFingerprint } from '../src/dedup.js';

test('광고세트명은 쉼표 키워드 중 하나라도 포함하면 일치한다', () => {
  assert.equal(adGroupNameMatches('[멜론] 무디 파트너십 광고', '무디'), true);
  assert.equal(adGroupNameMatches('[멜론] 무디 파트너십 광고', '기타, 파트너십'), true);
  assert.equal(adGroupNameMatches('[멜론] 일반 광고', '무디'), false);
});

test('영상별 부정댓글과 기존 알림·누락을 집계한다', () => {
  const entries = [{
    target: { platform: 'youtube', postKey: 'yt:v1', youtubeVideoId: 'v1', videoTitle: '영상1' },
    comments: [
      { id: 'c1', platform: 'youtube', text: 'a' },
      { id: 'c2', platform: 'youtube', text: 'b' },
      { id: 'c3', platform: 'youtube', text: 'c' },
    ],
  }];
  const risks = [[{ alert: true }, { alert: false }, { alert: true }]];
  const seen = new Set([commentFingerprint(entries[0].target, entries[0].comments[0])]);
  const summary = summarizeAdGroupAudit(entries, risks, seen);
  assert.equal(summary.videoCount, 1);
  assert.equal(summary.comments, 3);
  assert.equal(summary.negatives, 2);
  assert.equal(summary.alreadyAlerted, 1);
  assert.equal(summary.missing, 1);
});
