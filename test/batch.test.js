import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTargetsBatched } from '../src/hybrid-classify.js';

// 캐시 비활성(supabase 미설정) → 문맥 후보는 전부 LLM 미스로 배치된다.
const CFG = { anthropicKey: 'key' };
const T = { brandName: '라라스윗' };

// 각 후보를 '문맥 후보'로 만들기 위해 광고/의심 뉘앙스 텍스트 사용(needsContextualReview=true, 즉시부정 아님).
function ambiguous(n) { return { text: `${n}번 이거 광고인가요?` }; }

test('여러 게시물의 후보가 원 게시물·댓글 인덱스로 정확히 귀속된다', async () => {
  const entries = [
    { target: T, comments: [{ text: '맛있어요' }, ambiguous('A')] }, // idx1만 후보
    { target: T, comments: [ambiguous('B')] },                        // idx0 후보
    { target: T, comments: [{ text: '👍' }] },                        // 후보 없음
  ];
  let receivedTexts = null;
  const llm = async (items) => {
    receivedTexts = items.map((i) => i.text);
    // 입력 순서대로 판정 반환(A→부정, B→정상)
    return items.map((i) => ({ alert: /A번/.test(i.text), category: /A번/.test(i.text) ? '광고/바이럴 의심' : '정상댓글', reason: /A번/.test(i.text) ? '광고 의심' : '', priority: 'normal' }));
  };
  const out = await classifyTargetsBatched(entries, CFG, llm);
  assert.deepEqual(receivedTexts, ['A번 이거 광고인가요?', 'B번 이거 광고인가요?']); // 두 게시물 후보 통합
  assert.equal(out[0][0].engine, 'keyword'); // '맛있어요'
  assert.equal(out[0][1].engine, 'llm');
  assert.equal(out[0][1].alert, true);        // A → 부정, 첫 게시물 idx1에 정확히
  assert.equal(out[1][0].engine, 'llm');
  assert.equal(out[1][0].alert, false);       // B → 정상, 둘째 게시물 idx0에
  assert.equal(out[2][0].engine, 'keyword');
});

test('후보 25개 초과 시 25개 단위로 여러 번 호출하고 전부 매핑', async () => {
  const comments = Array.from({ length: 30 }, (_, i) => ambiguous(i));
  const entries = [{ target: T, comments }];
  const batchSizes = [];
  const llm = async (items) => {
    batchSizes.push(items.length);
    return items.map((i) => ({ alert: true, category: '광고/바이럴 의심', reason: `r-${i.text}`, priority: 'normal' }));
  };
  const out = await classifyTargetsBatched(entries, CFG, llm);
  assert.deepEqual(batchSizes, [25, 5]); // 25 + 5
  assert.equal(out[0].length, 30);
  assert.ok(out[0].every((r) => r.engine === 'llm' && r.alert));
});

test('일부 응답 누락(짧은 배열)이면 그 항목만 키워드 유지, 나머지는 정상 매핑', async () => {
  const entries = [{ target: T, comments: [ambiguous(0), ambiguous(1), ambiguous(2)] }];
  const llm = async (items) => [
    { alert: true, category: '광고/바이럴 의심', reason: 'r0', priority: 'normal' },
    // 인덱스1 누락(undefined)
    undefined,
    { alert: true, category: '광고/바이럴 의심', reason: 'r2', priority: 'normal' },
  ].slice(0, items.length);
  const out = await classifyTargetsBatched(entries, CFG, llm);
  assert.equal(out[0][0].engine, 'llm');
  assert.equal(out[0][1].engine, 'keyword'); // 누락분은 안전경로(키워드)로
  assert.equal(out[0][2].engine, 'llm');
});

test('범위 밖/여분 인덱스가 와도 슬롯 개수만큼만 매핑(초과분 무시)', async () => {
  const entries = [{ target: T, comments: [ambiguous(0), ambiguous(1)] }];
  const llm = async () => [
    { alert: true, category: '광고/바이럴 의심', reason: 'r0', priority: 'normal' },
    { alert: false, category: '정상댓글', reason: '', priority: 'normal' },
    { alert: true, category: 'x', reason: 'extra', priority: 'high' }, // 여분(무시돼야)
  ];
  const out = await classifyTargetsBatched(entries, CFG, llm);
  assert.equal(out[0].length, 2);
  assert.equal(out[0][0].alert, true);
  assert.equal(out[0][1].alert, false);
});

test('LLM이 null(JSON 파싱 실패 신호) 반환 시 배치 전체 키워드 폴백(누락 방지)', async () => {
  const entries = [{ target: T, comments: [ambiguous(0), ambiguous(1)] }];
  const out = await classifyTargetsBatched(entries, CFG, async () => null);
  assert.ok(out[0].every((r) => r.engine === 'keyword'));
});

test('LLM 호출이 throw해도 크래시 없이 키워드 폴백', async () => {
  const entries = [{ target: T, comments: [ambiguous(0)] }];
  const out = await classifyTargetsBatched(entries, CFG, async () => { throw new Error('anthropic 500'); });
  assert.equal(out[0][0].engine, 'keyword');
});

test('한 게시물 준비가 실패해도 다른 게시물 분류는 계속된다', async () => {
  // comments가 배열이 아니면 prepareLocal 내부 .map에서 throw → 그 엔트리만 폴백
  const entries = [
    { target: T, comments: null },
    { target: T, comments: [ambiguous(0)] },
  ];
  const llm = async (items) => items.map(() => ({ alert: true, category: '광고/바이럴 의심', reason: 'r', priority: 'normal' }));
  const out = await classifyTargetsBatched(entries, CFG, llm);
  assert.deepEqual(out[0], []);              // 실패 엔트리는 빈 결과
  assert.equal(out[1][0].engine, 'llm');     // 정상 엔트리는 분류됨
  assert.equal(out[1][0].alert, true);
});

test('anthropicKey 없으면 LLM 미호출, 전부 키워드', async () => {
  let called = false;
  const out = await classifyTargetsBatched(
    [{ target: T, comments: [ambiguous(0)] }],
    { anthropicKey: '' },
    async () => { called = true; return []; },
  );
  assert.equal(called, false);
  assert.equal(out[0][0].engine, 'keyword');
});
