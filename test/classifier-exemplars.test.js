import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExemplarPayload, curate } from '../scripts/refresh-classifier-exemplars.mjs';

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
  // 미탐 방지 불변식: 존재 여부뿐 아니라 개수도 정확히 같아야 한다.
  assert.equal(ex.normal.length, ex.negative.length);
});

test('buildExemplarPayload: 적은 라벨 쪽에 맞춰 정상·부정을 정확히 균형화한다', () => {
  const normalRows = [
    { category: '정상', comment_text: '정상 하나' },
    { category: '정상', comment_text: '정상 둘' },
  ];
  const negativeRows = [
    { category: '부정', comment_text: '부정 하나' },
    { category: '부정', comment_text: '부정 둘' },
    { category: '부정', comment_text: '부정 셋' },
  ];
  const out = buildExemplarPayload(normalRows, negativeRows, { cap: 25, generatedAt: '2026-09-11' });
  assert.equal(out.normal.length, 2);
  assert.equal(out.negative.length, 2);
  assert.match(out.version, /^[a-f0-9]{64}$/);
});

test('buildExemplarPayload: 예시가 같으면 생성일·버전을 보존하고 내용 변경 때만 버전이 바뀐다', () => {
  const normal = [{ category: '정상', comment_text: '좋은 댓글' }];
  const negative = [{ category: '부정', comment_text: '나쁜 댓글' }];
  const first = buildExemplarPayload(normal, negative, { generatedAt: '2026-09-10' });
  const same = buildExemplarPayload(normal, negative, { generatedAt: '2026-09-11', previous: first });
  assert.equal(same.version, first.version);
  assert.equal(same.generatedAt, '2026-09-10');
  const changed = buildExemplarPayload(normal, [{ category: '부정', comment_text: '더 나쁜 댓글' }], {
    generatedAt: '2026-09-11', previous: first,
  });
  assert.notEqual(changed.version, first.version);
  assert.equal(changed.generatedAt, '2026-09-11');
});
