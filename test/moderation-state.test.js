import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_HIDE_REQUIRED,
  isHiddenConfirmed,
  isUnresolvedModeration,
  moderationCapability,
  normalizeHideDecision,
} from '../src/moderation-state.js';

test('숨김 실행 가능성 매트릭스: 광고 API와 owner YouTube만 자동 경로', () => {
  assert.equal(moderationCapability({ source: 'meta_ads', platform: 'instagram', channelCategory: '인지 광고' }).mode, 'automatic');
  assert.equal(moderationCapability({ source: 'tiktok_ads', platform: 'tiktok', channelCategory: '인지 광고' }).mode, 'automatic');
  assert.equal(moderationCapability({ source: 'youtube_ads', platform: 'youtube', channelCategory: '인지 광고' }).mode, 'automatic');
  assert.equal(moderationCapability({ source: null, platform: 'youtube', channelCategory: '위성채널' }).mode, 'conditional');
  assert.equal(moderationCapability({ source: null, platform: 'tiktok', channelCategory: '위성채널' }).mode, 'manual');
  assert.equal(moderationCapability({ source: null, platform: 'youtube', channelCategory: '협찬 (인플루언서)' }).mode, 'manual');
});

test('유기 TikTok hide는 manual_hide_required로 정규화한다', () => {
  assert.equal(normalizeHideDecision({ platform: 'tiktok', channelCategory: '위성채널' }), MANUAL_HIDE_REQUIRED);
  assert.equal(normalizeHideDecision({ platform: 'youtube', channelCategory: '위성채널' }), 'hide');
});

test('hide/hold/null은 실제 숨김 미확인이고 hidden_confirmed만 완료다', () => {
  assert.equal(isUnresolvedModeration({ review_decision: null, hidden_confirmed: false }), true);
  assert.equal(isUnresolvedModeration({ review_decision: 'hide', hidden_confirmed: false }), true);
  assert.equal(isUnresolvedModeration({ review_decision: 'hold', hidden_confirmed: false }), true);
  assert.equal(isUnresolvedModeration({ review_decision: MANUAL_HIDE_REQUIRED, hidden_confirmed: false }), true);
  assert.equal(isUnresolvedModeration({ review_decision: 'false_positive', hidden_confirmed: false }), false);
  assert.equal(isHiddenConfirmed({ review_decision: 'hide', hidden_confirmed: false }), false);
  assert.equal(isHiddenConfirmed({ review_decision: 'hide', hidden_confirmed: true }), true);
  assert.equal(isHiddenConfirmed({ review_decision: 'hidden' }), true); // 무중단 배포 호환
});
