import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNegativeComment, needsContextualReview } from '../src/classify.js';

test('detects requested discovery keywords in relevant product context', () => {
  const target = { productName: '라라스윗 쫀득바' };
  for (const text of ['광고 같아요', '바이럴 아닌가', '맛이 별로', '다른 상품 끼워 팔기']) {
    assert.equal(classifyNegativeComment({ text }, target).alert, true, text);
  }
});

test('가용성 표현이 섞인 긍정 댓글은 오탐 안 함(편의점에 없던데 먹고싶어요)', () => {
  const target = { brandName: '라라스윗', productName: '쫀득바' };
  const text = '이거 애들이 맛있다고 해서 너무 먹고싶어요ㅠㅠ 진짜 쫀득해보이고 편의점에서 찾아봐도 없던데 진짜 한번 먹어보고싶어요ㅠ';
  const r = classifyNegativeComment({ text }, target);
  assert.equal(r.alert, false, '긍정 문맥이면 정상이어야'); // '없던데'가 즉시 부정 트리거였던 회귀 방지
  assert.equal(needsContextualReview({ text }, target), false); // 긍정 문맥이라 LLM 검토도 불필요
});

test('성분/진위 의혹은 즉시 하드판정 대신 LLM 검토로 보낸다', () => {
  const target = { brandName: '라라스윗', productName: '쫀득바' };
  // 긍정 문맥 없는 성분 의혹 → 키워드는 알림이지만 needsContextualReview로 LLM 검토 대상.
  assert.equal(needsContextualReview({ text: '쫀득바 성분표에 멜론이 없어서 가짜 아닌가' }, target), true);
});

test('automatically detects common profanity variants', () => {
  const target = { brandName: '라라스윗' };
  assert.equal(classifyNegativeComment({ text: '이거 ㅅㅂ 너무 별로' }, target).category, '욕설/비속어');
  assert.equal(classifyNegativeComment({ text: '시발 가격 뭐냐' }, target).priority, 'high');
});

test('욕설은 즉시부정 대신 LLM 문맥검토로 라우팅(사람 겨냥 오탐 방지)', () => {
  const target = { brandName: '라라스윗', productName: '쫀득바' };
  // 댓글러 겨냥 욕설(제품 무관) → 즉시부정 아님, LLM 검토 대상으로 라우팅
  assert.equal(needsContextualReview({ text: '꺼져 닥쳐 새끼야' }, target), true);
  // 제품 명백 불만(HARD)+욕설 → 즉시부정(LLM 불필요), 여전히 알림
  assert.equal(needsContextualReview({ text: '라라스윗 맛없어 씨발' }, target), false);
  assert.equal(classifyNegativeComment({ text: '라라스윗 맛없어 씨발' }, target).alert, true);
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
