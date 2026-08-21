import test from 'node:test';
import assert from 'node:assert/strict';
import { threadRouteForOwnerTarget } from '../src/youtube-owner-channel-run.js';
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
