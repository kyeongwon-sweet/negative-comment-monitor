import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNegativeComment, needsContextualReview } from '../src/classify.js';

const T = { brandName: '라라스윗' };
const flag = [
  '또 바이럴이네', '과일 저건 좀 에바다ㅎ', '맛없어 별로 돈아깝',
  '허위광고하지마라', '성분표에 멜론이 없던데요?', '사지 마세여 그냥 메론바 맛남',
];
const pass = ['맛있겠당 🤤', '언니 너무 이뻐요', '망고랑 멜론 둘다 있어욤', '🤨🤨🤨'];

test('제품·음식 부정 언급은 alert', () => {
  for (const t of flag) assert.equal(classifyNegativeComment({ text: t }, T).alert, true, t);
});
test('긍정·중립·무관은 통과', () => {
  for (const t of pass) assert.equal(classifyNegativeComment({ text: t }, T).alert, false, t);
});
test('경쟁품 단순 언급(걍메로나임)은 키워드 즉시부정 대신 LLM 검토로(#7)', () => {
  // 깎아내림 여부는 문맥이라 키워드로 즉시 판정하지 않고 LLM에 맡긴다(제품 불만 동반 시엔 위 flag처럼 즉시).
  assert.equal(classifyNegativeComment({ text: '걍메로나임' }, T).alert, false);
  assert.equal(needsContextualReview({ text: '걍메로나임' }, T), true);
});
