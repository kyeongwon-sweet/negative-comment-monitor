import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { curate } from '../scripts/refresh-classifier-exemplars.mjs';

test('curate: 중복 제거 + 카테고리 라운드로빈 다양성 + cap 준수', () => {
  const rows = [
    { category: 'A', comment_text: '가나다' },
    { category: 'A', comment_text: '가나다' }, // 중복
    { category: 'A', comment_text: '가나다2' },
    { category: 'A', comment_text: '가나다3' },
    { category: 'B', comment_text: '라마바' },
    { category: 'B', comment_text: '라마바2' },
    { category: 'C', comment_text: '' }, // 빈 텍스트 제외
    { category: 'C', comment_text: '사아자' },
  ];
  const out = curate(rows, 4);
  assert.equal(out.length, 4);
  assert.equal(new Set(out).size, 4); // 중복 없음
  // 라운드로빈이라 A만 4개가 아니라 여러 카테고리가 섞인다
  assert.ok(out.includes('라마바') || out.includes('사아자'));
});

test('curate: cap 이상 요청해도 있는 만큼만, 정렬된 결과(1글자는 제외)', () => {
  const rows = [
    { category: 'A', comment_text: '나나' },
    { category: 'A', comment_text: '가가' },
    { category: 'A', comment_text: '자' }, // 1글자 → 제외
  ];
  const out = curate(rows, 10);
  assert.deepEqual(out, ['가가', '나나']);
});

test('classifier-exemplars.json은 유효한 균형 셋(정상·부정 둘 다 있거나 둘 다 비어있음)', () => {
  const url = new URL('../src/classifier-exemplars.json', import.meta.url);
  const ex = JSON.parse(readFileSync(url, 'utf8'));
  assert.ok(Array.isArray(ex.normal) && Array.isArray(ex.negative));
  // 미탐 방지 불변식: 한쪽만 있으면 안 된다(주입 시 둘 다 필요).
  assert.equal(ex.normal.length > 0, ex.negative.length > 0);
});
