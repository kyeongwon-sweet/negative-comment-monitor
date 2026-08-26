import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommentsHybrid, classifyTargetsBatched } from '../src/hybrid-classify.js';
import { commentFingerprint } from '../src/dedup.js';
import { classificationCacheFingerprint } from '../src/cache.js';

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

test('광고 source(meta/tiktok/youtube)는 전 댓글을 LLM 문맥판정으로 보낸다(reviewAll 일반화)', async () => {
  const comments = [{ text: '라라스윗 맛있어요' }, { text: '잘 먹었습니다' }]; // 키워드로는 둘 다 정상
  // 일반 target: 정상 댓글은 LLM에 안 보냄(키워드로 종결)
  let plainCalled = false;
  await classifyCommentsHybrid(comments, { brandName: '라라스윗' }, { anthropicKey: 'key' },
    async (items) => { plainCalled = true; return items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' })); });
  assert.equal(plainCalled, false);
  // 광고 source: 제품 문맥 확정 지면이라 전 댓글을 LLM 문맥판정으로
  for (const source of ['meta_ads', 'tiktok_ads', 'youtube_ads']) {
    let received = null;
    await classifyCommentsHybrid(comments, { brandName: '라라스윗', source }, { anthropicKey: 'key' },
      async (items) => { received = items; return items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' })); });
    assert.equal(received?.length, 2, `${source}는 전 댓글(2개)을 LLM으로 보내야 함`);
  }
});

test('고댓글 소유채널 심층검사는 전 댓글을 검토하고 강제 재분류면 캐시를 우회한다', async () => {
  const comment = { id: 'c1', platform: 'youtube', text: '기업아님???' };
  const target = { platform: 'youtube', postKey: 'yt:v1', brandName: '라라스윗', fullContextReview: true, bypassClassificationCache: true };
  let liveCalled = false;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('negative_comment_alerts')) return { ok: true, json: async () => [] };
    if (opts.method === 'POST') return { ok: true, json: async () => [] };
    throw new Error('classification cache must not be read during forced reclassification');
  };
  const [[result]] = await classifyTargetsBatched(
    [{ comments: [comment], target }], CACHE_CFG,
    async () => {
      liveCalled = true;
      return [{ alert: true, category: '광고/바이럴 의심', reason: '광고를 의심함', priority: 'normal' }];
    },
    {},
    fetchImpl,
  );
  assert.equal(liveCalled, true);
  assert.equal(result.alert, true);
});

test('B 정책 소유채널만 정상 키워드 댓글도 LLM에 보내고 컨텍스트 플래그를 보존한다', async () => {
  let ownedInput = null;
  await classifyCommentsHybrid(
    [{ text: '라라스윗 왤케 비호감' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' },
    async (items) => {
      ownedInput = items;
      return [{ alert: true, category: '광고/바이럴 의심', reason: '브랜드를 향한 적대', priority: 'normal' }];
    },
  );
  assert.equal(ownedInput.length, 1);
  assert.equal(ownedInput[0].ownedChannelBrandHostilityScope, true);

  let thirdPartyCalled = false;
  await classifyCommentsHybrid(
    [{ text: '인플루언서 왤케 비호감' }],
    { brandName: '라라스윗' },
    { anthropicKey: 'key' },
    async () => { thirdPartyCalled = true; return []; },
  );
  assert.equal(thirdPartyCalled, false);
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
  const fp = classificationCacheFingerprint(target, comment);
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

test('같은 comment_id의 본문이 수정되면 정상 캐시를 재사용하지 않고 다시 분류한다', async () => {
  const target = {
    platform: 'youtube', postKey: 'yt:rbRplW02tbU', brandName: '라라스윗',
    ownedChannelBrandHostilityScope: true,
  };
  const before = { id: 'edited-comment', platform: 'youtube', text: '그냥 그래요' };
  const edited = { ...before, text: '라라스윗 쥐도 먹기 싫어짐 전량 폐기 거북' };
  const staleFingerprint = classificationCacheFingerprint(target, before);
  const editedFingerprint = classificationCacheFingerprint(target, edited);
  assert.notEqual(staleFingerprint, editedFingerprint);
  assert.equal(commentFingerprint(target, before), commentFingerprint(target, edited));

  let lookupFingerprint = '';
  let storedFingerprint = '';
  let llmCalled = false;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes('comment_classification_cache') && (options.method || 'GET') === 'GET') {
      lookupFingerprint = requestUrl;
      // DB에는 편집 전 정상 판정만 남아 있다. 새 텍스트 지문 조회는 미스여야 한다.
      return { ok: true, json: async () => (requestUrl.includes(staleFingerprint) ? [{ fingerprint: staleFingerprint, alert: false }] : []) };
    }
    if (requestUrl.includes('negative_comment_alerts')) return { ok: true, json: async () => [] };
    if (requestUrl.includes('comment_classification_cache') && options.method === 'POST') {
      storedFingerprint = JSON.parse(options.body)[0].fingerprint;
      return { ok: true, json: async () => [] };
    }
    throw new Error(`unexpected request: ${requestUrl}`);
  };

  const [[result]] = await classifyTargetsBatched(
    [{ target, comments: [edited] }],
    CACHE_CFG,
    async () => {
      llmCalled = true;
      return [{ alert: true, category: '제품 불만', reason: '브랜드와 제품을 강하게 혐오함', priority: 'high' }];
    },
    {},
    fetchImpl,
  );
  assert.equal(llmCalled, true);
  assert.equal(result.alert, true);
  assert.match(lookupFingerprint, new RegExp(editedFingerprint));
  assert.equal(storedFingerprint, editedFingerprint);
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
