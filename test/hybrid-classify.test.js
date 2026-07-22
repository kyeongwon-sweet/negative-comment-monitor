import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommentsHybrid } from '../src/hybrid-classify.js';
import { commentFingerprint } from '../src/dedup.js';

const CACHE_CFG = { anthropicKey: 'key', supabaseUrl: 'https://db.example', supabaseKey: 'svc' };

test('calls the LLM only for ambiguous comments and keeps immediate rules local', async () => {
  const comments = [
    { text: 'ㅅㅂ 진짜 노맛' },
    { text: '이거 광고인가요?' },
    { text: '라라스윗 맛있어요' },
  ];
  let received;
  const llmClassifier = async (items) => {
    received = items;
    return [{ alert: false, category: '정상댓글', reason: '', priority: 'normal' }];
  };
  const results = await classifyCommentsHybrid(comments, { brandName: '라라스윗' }, { anthropicKey: 'key' }, llmClassifier);
  assert.deepEqual(received.map((item) => item.text), ['이거 광고인가요?']);
  assert.equal(results[0].engine, 'keyword');
  assert.equal(results[0].alert, true);
  assert.equal(results[1].engine, 'llm');
  assert.equal(results[2].engine, 'keyword');
});

test('threads the usage stats accumulator through to the LLM classifier', async () => {
  let receivedStats;
  const stats = { calls: 0 };
  const llmClassifier = async (items, config, fetchImpl, s) => {
    receivedStats = s;
    return [{ alert: false, category: '정상댓글', reason: '', priority: 'normal' }];
  };
  await classifyCommentsHybrid(
    [{ text: '이거 광고인가요?' }],
    { brandName: '라라스윗' },
    { anthropicKey: 'key' },
    llmClassifier,
    stats,
  );
  assert.equal(receivedStats, stats);
});

test('cache hit skips the LLM for that comment (engine=llm-cache)', async () => {
  const target = { brandName: '라라스윗' };
  const comment = { text: '이거 광고인가요?' };
  const fp = commentFingerprint(target, comment);
  const realFetch = globalThis.fetch;
  let stored = false;
  globalThis.fetch = async (url, opts) => {
    if (/negative_comment_alerts/.test(url)) return { ok: true, json: async () => [] }; // 오탐 조회: 없음
    if ((opts?.method || 'GET') === 'GET') {
      return { ok: true, json: async () => [{ fingerprint: fp, alert: true, category: '광고/바이럴 의심', reason: '광고 냉소', priority: 'normal' }] };
    }
    stored = true; // store 시도되면 안 됨(히트라 저장할 것 없음)
    return { ok: true };
  };
  let llmCalled = false;
  const stats = {};
  try {
    const results = await classifyCommentsHybrid([comment], target, CACHE_CFG, async () => { llmCalled = true; return []; }, stats);
    assert.equal(llmCalled, false);
    assert.equal(results[0].engine, 'llm-cache');
    assert.equal(results[0].alert, true);
    assert.equal(results[0].reason, '광고 냉소');
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheMiss, 0);
    assert.equal(stored, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cache miss calls the LLM and stores the fresh verdict', async () => {
  const target = { brandName: '라라스윗' };
  const comment = { text: '이거 광고인가요?' };
  const realFetch = globalThis.fetch;
  let storeBody = null;
  globalThis.fetch = async (url, opts) => {
    if ((opts?.method || 'GET') === 'GET') return { ok: true, json: async () => [] }; // 미스
    storeBody = JSON.parse(opts.body);
    return { ok: true };
  };
  const stats = {};
  try {
    const results = await classifyCommentsHybrid(
      [comment], target, CACHE_CFG,
      async (items) => items.map(() => ({ alert: true, category: '광고/바이럴 의심', reason: '광고 의심', priority: 'normal' })),
      stats,
    );
    assert.equal(results[0].engine, 'llm');
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.cacheMiss, 1);
    assert.ok(storeBody, '미스는 캐시에 저장돼야 함');
    assert.equal(storeBody[0].alert, true);
    assert.equal(storeBody[0].reason, '광고 의심');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cache lookup failure falls back to live LLM (no drop)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('supabase down'); };
  let llmCalled = false;
  try {
    const results = await classifyCommentsHybrid(
      [{ text: '이거 광고인가요?' }], { brandName: '라라스윗' }, CACHE_CFG,
      async (items) => { llmCalled = true; return items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' })); },
    );
    assert.equal(llmCalled, true); // 캐시 조회 실패해도 실시간 분류 진행
    assert.equal(results[0].engine, 'llm');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('uses only free keyword rules when no Anthropic key is configured', async () => {
  let called = false;
  const results = await classifyCommentsHybrid(
    [{ text: '라라스윗 광고인가요?' }],
    { brandName: '라라스윗' },
    { anthropicKey: '' },
    async () => { called = true; return []; },
  );
  assert.equal(called, false);
  assert.equal(results[0].engine, 'keyword');
});
