import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNegativeComment } from '../src/classify.js';

const T = { brandName: '라라스윗' };
const flag = [
  '또 바이럴이네', '과일 저건 좀 에바다ㅎ', '맛없어 별로 돈아깝',
  '걍메로나임', '허위광고하지마라', '성분표에 멜론이 없던데요?', '사지 마세여 그냥 메론바 맛남',
];
const pass = ['맛있겠당 🤤', '언니 너무 이뻐요', '망고랑 멜론 둘다 있어욤', '🤨🤨🤨'];

test('제품·음식 부정 언급은 alert', () => {
  for (const t of flag) assert.equal(classifyNegativeComment({ text: t }, T).alert, true, t);
});
test('긍정·중립·무관은 통과', () => {
  for (const t of pass) assert.equal(classifyNegativeComment({ text: t }, T).alert, false, t);
});
