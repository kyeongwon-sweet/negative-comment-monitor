import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTikTokSurvey } from '../src/tiktok-ads-survey.js';

test('전수 조사 요약은 기존 알림과 신규 미처리 후보를 분리한다', () => {
  const collected = {
    windowDays: 30,
    campaigns: 6,
    ads: 10,
    adgroups: 4,
    comments: 12,
    entries: [{ comments: [{}, {}, {}] }, { comments: [{}, {}] }],
  };
  const alerts = [
    { fingerprint: 'a', risk: { category: '제품불만' } },
    { fingerprint: 'b', risk: { category: '제품불만' } },
    { fingerprint: 'c', risk: { category: '광고의심' } },
  ];
  const summary = summarizeTikTokSurvey(collected, alerts, new Set(['a']), { calls: 1, reviewed: 2 }, 0.012345);
  assert.equal(summary.rawComments, 12);
  assert.equal(summary.normalizedComments, 5);
  assert.equal(summary.classifiedNegative, 3);
  assert.equal(summary.alreadyAlerted, 1);
  assert.equal(summary.unseenNegativeCandidates, 2);
  assert.deepEqual(summary.categoryCounts, { 제품불만: 2, 광고의심: 1 });
  assert.deepEqual(summary.unseenCategoryCounts, { 제품불만: 1, 광고의심: 1 });
  assert.equal(summary.llm.estUsd, 0.01235);
});
