import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectOwnerAuditVideos,
  summarizeOwnerDetectionAudit,
} from '../src/youtube-owner-coverage-audit.js';
import { commentFingerprint } from '../src/dedup.js';

function candidate(id, count) {
  return { video: { id, statistics: { commentCount: String(count) } } };
}

test('coverage audit selects explicit videos or highest-comment samples deterministically', () => {
  const candidates = [candidate('low', 2), candidate('high', 100), candidate('mid', 20)];
  assert.deepEqual(selectOwnerAuditVideos(candidates, new Set(), 2).map((row) => row.video.id), ['high', 'mid']);
  assert.deepEqual(selectOwnerAuditVideos(candidates, new Set(['low']), 5).map((row) => row.video.id), ['low']);
});

test('coverage audit separates recorded, missing, deferred, and reports pipeline candidate rate', () => {
  const entries = [{
    target: { platform: 'youtube', postKey: 'yt:v1', youtubeVideoId: 'v1', videoTitle: 'video', channelName: 'owner' },
    comments: [
      { id: 'seen', platform: 'youtube', text: '부정1' },
      { id: 'missing', platform: 'youtube', text: '부정2' },
      { id: 'deferred', platform: 'youtube', text: '광고?' },
      { id: 'normal', platform: 'youtube', text: '좋아요' },
    ],
  }];
  const risks = [[
    { alert: true },
    { alert: true },
    { alert: false, deferred: true, category: 'llm_deferred' },
    { alert: false },
  ]];
  const seen = new Set([commentFingerprint(entries[0].target, entries[0].comments[0])]);
  const summary = summarizeOwnerDetectionAudit(entries, risks, seen, { authenticatedChannels: 2 });

  assert.equal(summary.publicComments, 4);
  assert.equal(summary.negativeCandidates, 2);
  assert.equal(summary.alreadyAlerted, 1);
  assert.equal(summary.missing, 1);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.pipelineMissRatePercent, 50);
  assert.equal(summary.videos[0].missing, 1);
});
