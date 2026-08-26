import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerRunFailure,
  recordOwnerLlmSoftDegraded,
  threadRouteForOwnerTarget,
} from '../src/youtube-owner-channel-run.js';
import { actionDefinitions, assigneeForTarget, productGroup, productLabel } from '../src/slack.js';

test('소유 YouTube 카드는 인지 광고 부모 스레드만 공유하고 관리 동작은 유지한다', () => {
  const target = { productName: 'JD멜', channelCategory: '소유 YouTube', platform: 'youtube' };
  const route = threadRouteForOwnerTarget(target);

  assert.equal(`${productLabel(productGroup(target.productName))}|${route.category}`, '쫀득바|인지 광고');
  assert.equal(assigneeForTarget(route.target, { awareness: 'U_AWARENESS', other: 'U_OTHER' }), 'U_AWARENESS');
  assert.equal(target.channelCategory, '소유 YouTube');
  assert.notEqual(route.target, target);
  assert.deepEqual(
    actionDefinitions(target, ['위성채널', '소유 YouTube']).map((item) => item[1]),
    ['hide', 'approve', 'hold', 'unhide'],
  );
});

test('위성 YouTube는 기존 위성 스레드 라우팅을 유지한다', () => {
  const target = { productName: 'JD멜', channelCategory: '위성채널', platform: 'youtube' };
  const route = threadRouteForOwnerTarget(target);

  assert.equal(route.category, '위성채널');
  assert.equal(route.target, target);
});

test('LLM 전면 실패는 키워드 폴백 soft-degraded로 기록하고 실행 실패로 만들지 않는다', () => {
  const summary = { degraded: [], softDegraded: [] };
  recordOwnerLlmSoftDegraded(summary, {
    degraded: true,
    failureCode: 'credit',
    candidateComments: 12,
    keywordFallbackComments: 12,
  });

  assert.deepEqual(summary.softDegraded, [{
    stage: 'llm-classification',
    error: 'credit; fallback=12/12',
  }]);
  assert.equal(ownerRunFailure(summary), null);
});

test('LLM 헬스 기록 자체 실패도 soft-degraded이며 수집 장애만 hard failure다', () => {
  const summary = { degraded: [], softDegraded: [] };
  recordOwnerLlmSoftDegraded(summary, null, new Error('health store unavailable'));
  assert.equal(ownerRunFailure(summary), null);
  assert.equal(summary.softDegraded[0].stage, 'llm-health');

  summary.degraded.push({ stage: 'collection', error: 'channel failed' });
  const failure = ownerRunFailure(summary);
  assert.match(failure.message, /collection/);
  assert.equal(failure.summary, summary);
});
