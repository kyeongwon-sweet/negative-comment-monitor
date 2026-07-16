import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNegativeComment, needsContextualReview } from '../src/classify.js';

test('detects requested discovery keywords in relevant product context', () => {
  const target = { productName: '라라스윗 쫀득바' };
  for (const text of ['광고 같아요', '바이럴 아닌가', '맛이 별로', '다른 상품 끼워 팔기']) {
    assert.equal(classifyNegativeComment({ text }, target).alert, true, text);
  }
});

test('automatically detects common profanity variants', () => {
  const target = { brandName: '라라스윗' };
  assert.equal(classifyNegativeComment({ text: '이거 ㅅㅂ 너무 별로' }, target).category, '욕설/비속어');
  assert.equal(classifyNegativeComment({ text: '시발 가격 뭐냐' }, target).priority, 'high');
});

test('detects entity directly in the comment even without post metadata', () => {
  const result = classifyNegativeComment({ text: '쫀득바 광고 너무 심한데' });
  assert.equal(result.alert, true);
  assert.deepEqual(result.entity.commentMatches, ['쫀득바']);
});

test('does not alert on screenshot examples without brand or product context', () => {
  assert.equal(classifyNegativeComment({ text: '미쳤네.....😮' }).alert, false);
  assert.equal(classifyNegativeComment({ text: '가스테라 종이는 진짜 어릴때 먹는건줄 알고 맨날 맛있다고 처먹었는데' }).alert, false);
});

test('does not treat neutral brand mentions as negative', () => {
  assert.equal(classifyNegativeComment({ text: '라라스윗 쫀득바 맛있어요' }).alert, false);
});

test('keeps explicit profanity and product dissatisfaction as immediate alerts', () => {
  const target = { brandName: '라라스윗' };
  assert.equal(classifyNegativeComment({ text: 'ㅅㅂ 이거 진짜 노맛' }, target).alert, true);
  assert.equal(classifyNegativeComment({ text: '이거 맛없고 돈 아까움' }, target).alert, true);
});

test('does not alert when contextual keywords appear in an overall positive sentence', () => {
  const target = { brandName: '라라스윗' };
  const result = classifyNegativeComment(
    { text: '다른 광고는 별로 안 사먹고 싶었는데 이건 너무 사먹고 싶은 영상' },
    target,
  );
  assert.equal(result.alert, false);
  assert.equal(result.reason, '긍정 문맥 예외');
});

test('sends only ambiguous marketing, dissatisfaction, and competitor terms to contextual review', () => {
  const target = { brandName: '라라스윗' };
  assert.equal(needsContextualReview({ text: '이거 광고인가요?' }, target), true);
  assert.equal(needsContextualReview({ text: '맛이 별로' }, target), true);
  assert.equal(needsContextualReview({ text: '그냥 메로나 맛인가' }, target), true);
  assert.equal(needsContextualReview({ text: 'ㅅㅂ 진짜 노맛' }, target), false);
  assert.equal(needsContextualReview({ text: '맛있어요' }, target), false);
});
