import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTargetsBatched } from '../src/hybrid-classify.js';
import { classifyCommentsLLM } from '../src/llm.js';
import { commentFingerprint } from '../src/dedup.js';

// 실제 classifyCommentsLLM을 배치 경로에 물려, Anthropic·Supabase 장애가 나도 모니터링이
// 크래시 없이 키워드 안전경로로 계속되는지(누락 방지 우선) 검증한다.
const T = { brandName: '라라스윗' };
const ambiguous = (n) => ({ text: `${n} 이거 광고인가요?` });

function stubFetch(routes) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (/api\.anthropic\.com/.test(url)) return routes.anthropic(url, opts);
    if (/supabase|db\.example/.test(url)) return routes.supabase(url, opts);
    throw new Error(`unexpected fetch: ${url}`);
  };
  return () => { globalThis.fetch = real; };
}

const anthropicOk = (verdicts) => async () => ({
  ok: true,
  json: async () => ({
    content: [{ text: JSON.stringify(verdicts) }],
    usage: { input_tokens: 100, output_tokens: 20 },
  }),
});

test('Anthropic 500이어도 크래시 없이 문맥 후보 보류(캐시 미사용)', async () => {
  const restore = stubFetch({ anthropic: async () => ({ ok: false, json: async () => ({}) }), supabase: async () => { throw new Error('n/a'); } });
  try {
    const out = await classifyTargetsBatched([{ target: T, comments: [ambiguous(0)] }], { anthropicKey: 'k' }, classifyCommentsLLM);
    assert.equal(out[0][0].engine, 'llm-deferred');
  } finally { restore(); }
});

test('Anthropic 실패 보류는 회차 통계에 댓글수·배치수를 남긴다', async () => {
  const restore = stubFetch({
    anthropic: async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { type: 'invalid_request_error', message: 'credit balance is too low' } }),
    }),
    supabase: async () => { throw new Error('n/a'); },
  });
  const stats = { calls: 0, reviewed: 0, cacheHits: 0, cacheMiss: 0 };
  try {
    const out = await classifyTargetsBatched(
      [{ target: T, comments: [ambiguous(0), ambiguous(1)] }],
      { anthropicKey: 'k' },
      classifyCommentsLLM,
      stats,
    );
    assert.equal(out[0][0].engine, 'llm-deferred');
    assert.equal(stats.keywordFallback, true);
    assert.equal(stats.keywordFallbackBatches, 1);
    assert.equal(stats.keywordFallbackComments, 2);
    assert.equal(stats.llmDeferredComments, 2);
    assert.equal(stats.lastFailureCode, 'credit');
  } finally { restore(); }
});

test('LLM 장애는 긍정 광고언급을 보류하고 명백 부정 recall은 유지한다', async () => {
  const restore = stubFetch({
    anthropic: async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { type: 'invalid_request_error', message: 'credit balance is too low' } }),
    }),
    supabase: async () => { throw new Error('n/a'); },
  });
  const target = { brandName: '라라스윗', productName: '쫀득바' };
  try {
    const [out] = await classifyTargetsBatched([{
      target,
      comments: [
        { text: '후님이 광고하니까 꼭 먹어볼게요🥰 잘생겼어용' },
        { text: '헐 후님이 광고를 하시다니!!' },
        { text: '허위광고하지마라' },
        { text: '쫀득바 맛없어 사지 마세요' },
      ],
    }], { anthropicKey: 'k' }, classifyCommentsLLM, {});
    assert.deepEqual(out.map((row) => row.alert), [false, false, true, true]);
    assert.deepEqual(out.map((row) => row.engine), ['llm-deferred', 'llm-deferred', 'keyword', 'keyword']);
    assert.ok(out.slice(0, 2).every((row) => row.deferred === true));
  } finally { restore(); }
});

test('영구 오류는 첫 배치 뒤 회로차단해 남은 배치를 재호출하지 않는다', async () => {
  let calls = 0;
  const restore = stubFetch({
    anthropic: async () => {
      calls += 1;
      return {
        ok: false, status: 401,
        json: async () => ({ error: { type: 'authentication_error', message: 'invalid api key' } }),
      };
    },
    supabase: async () => { throw new Error('n/a'); },
  });
  const stats = { calls: 0, reviewed: 0, cacheHits: 0, cacheMiss: 0 };
  try {
    const comments = Array.from({ length: 30 }, (_, index) => ambiguous(index));
    await classifyTargetsBatched([{ target: { ...T, fullContextReview: true }, comments }], { anthropicKey: 'bad' }, classifyCommentsLLM, stats);
    assert.equal(calls, 1);
    assert.equal(stats.keywordFallbackBatches, 2);
    assert.equal(stats.keywordFallbackComments, 30);
    assert.equal(stats.lastFailureKind, 'persistent');
  } finally { restore(); }
});

test('Anthropic 네트워크 예외여도 문맥 후보 보류(classifyCommentsLLM이 null 반환)', async () => {
  const restore = stubFetch({ anthropic: async () => { throw new Error('ECONNRESET'); }, supabase: async () => { throw new Error('n/a'); } });
  try {
    const out = await classifyTargetsBatched([{ target: T, comments: [ambiguous(0)] }], { anthropicKey: 'k' }, classifyCommentsLLM);
    assert.equal(out[0][0].engine, 'llm-deferred');
  } finally { restore(); }
});

test('캐시 DB 다운(조회 throw) + Anthropic 정상 → 실시간 분류로 계속(누락 없음)', async () => {
  const cfg = { anthropicKey: 'k', supabaseUrl: 'https://db.example', supabaseKey: 'svc' };
  let anthropicCalled = false;
  const restore = stubFetch({
    anthropic: async (url, opts) => { anthropicCalled = true; return anthropicOk([{ i: 0, alert: true, category: '광고/바이럴 의심', reason: '광고 의심' }])(url, opts); },
    supabase: async () => { throw new Error('supabase down'); }, // 캐시 조회·저장 모두 실패
  });
  try {
    const out = await classifyTargetsBatched([{ target: T, comments: [ambiguous(0)] }], cfg, classifyCommentsLLM);
    assert.equal(anthropicCalled, true);        // 캐시 실패해도 실시간 분류 수행
    assert.equal(out[0][0].engine, 'llm');
    assert.equal(out[0][0].alert, true);
  } finally { restore(); }
});

test('캐시 조회 non-ok → 미스 취급 후 Anthropic로 분류, 저장 실패도 무해', async () => {
  const cfg = { anthropicKey: 'k', supabaseUrl: 'https://db.example', supabaseKey: 'svc' };
  const restore = stubFetch({
    anthropic: anthropicOk([{ i: 0, alert: false, category: '정상댓글', reason: '' }]),
    supabase: async (url, opts) => ((opts?.method || 'GET') === 'GET' ? { ok: false, json: async () => [] } : { ok: false }),
  });
  try {
    const out = await classifyTargetsBatched([{ target: T, comments: [ambiguous(0)] }], cfg, classifyCommentsLLM);
    assert.equal(out[0][0].engine, 'llm'); // 조회 실패=미스 → 실시간 분류, 저장 실패는 삼킴
  } finally { restore(); }
});

test('사람 false_positive 판정은 분류기 해시와 무관하게 정상으로 강제(키워드 알림도 억제)', async () => {
  const cfg = { anthropicKey: 'k', supabaseUrl: 'https://db.example', supabaseKey: 'svc', anthropicModel: 'some-other-model' };
  const target = { brandName: '라라스윗', productName: '쫀득바' };
  const comment = { text: '라라스윗 노맛' }; // 키워드(HARD) 즉시 알림 대상
  const fp = commentFingerprint(target, comment);
  let anthropicCalled = false;
  const restore = stubFetch({
    anthropic: async () => { anthropicCalled = true; return { ok: true, json: async () => ({ content: [{ text: '[]' }] }) }; },
    supabase: async (url) => (/negative_comment_alerts/.test(url) ? { ok: true, json: async () => [{ fingerprint: fp }] } : { ok: true, json: async () => [] }),
  });
  try {
    const out = await classifyTargetsBatched([{ target, comments: [comment] }], cfg, classifyCommentsLLM);
    assert.equal(out[0][0].engine, 'human-fp'); // 사람 판정 우선
    assert.equal(out[0][0].alert, false);
    assert.equal(anthropicCalled, false); // 하드 알림이라 LLM도 불필요, 오탐이라 억제
  } finally { restore(); }
});

test('Anthropic 정상 응답 시 사용량이 stats에 누적된다(계측 회귀)', async () => {
  const restore = stubFetch({
    anthropic: anthropicOk([{ i: 0, alert: true, category: '광고/바이럴 의심', reason: '광고 의심' }]),
    supabase: async () => { throw new Error('n/a'); },
  });
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  try {
    await classifyTargetsBatched([{ target: T, comments: [ambiguous(0)] }], { anthropicKey: 'k' }, classifyCommentsLLM, stats);
    assert.equal(stats.calls, 1);
    assert.equal(stats.reviewed, 1);
    assert.equal(stats.inputTokens, 100);
    assert.equal(stats.outputTokens, 20);
  } finally { restore(); }
});
