import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeYouTubeSurvey } from '../src/youtube-ads-survey.js';

test('유튜브 전수 조사 요약은 기존 알림과 신규 미처리 후보를 분리한다', () => {
  const collected = {
    windowDays: 30,
    customers: 1,
    campaigns: 3,
    assets: 170,
    videos: 170,
    ownedVideos: 0,
    externalVideos: 170,
    comments: 12,
  };
  const alerts = [
    { fingerprint: 'a', risk: { category: '제품 불만' } },
    { fingerprint: 'b', risk: { category: '제품 불만' } },
    { fingerprint: 'c', risk: { category: '광고/바이럴 의심' } },
  ];
  const summary = summarizeYouTubeSurvey(collected, alerts, new Set(['a']), { calls: 1, reviewed: 2 }, 0.012345);
  assert.equal(summary.videos, 170);
  assert.equal(summary.comments, 12);
  assert.equal(summary.classifiedNegative, 3);
  assert.equal(summary.alreadyAlerted, 1);
  assert.equal(summary.unseenNegativeCandidates, 2);
  assert.deepEqual(summary.categoryCounts, { '제품 불만': 2, '광고/바이럴 의심': 1 });
  assert.deepEqual(summary.unseenCategoryCounts, { '제품 불만': 1, '광고/바이럴 의심': 1 });
  assert.equal(summary.llm.estUsd, 0.01235);
});
