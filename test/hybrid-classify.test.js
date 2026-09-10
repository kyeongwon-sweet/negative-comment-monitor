import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommentsHybrid, classifyTargetsBatched, deferredEntryKeys } from '../src/hybrid-classify.js';
import { commentFingerprint } from '../src/dedup.js';
import { classificationCacheFingerprint } from '../src/cache.js';

const CACHE_CFG = { anthropicKey: 'key', supabaseUrl: 'https://db.example', supabaseKey: 'svc' };

test('브랜드 컨텍스트가 없으면 키워드 즉시판정은 로컬, 애매한 것만 LLM에 보낸다', async () => {
  // 게시물 컨텍스트에 브랜드가 없어 reviewAll(브랜드 게시물 전 댓글 검토)이 아닌 경로.
  const comments = [
    { text: '라라스윗 ㅅㅂ 진짜 노맛' }, // 브랜드+하드불만 → 키워드 즉시 부정
    { text: '라라스윗 이거 광고인가요?' }, // 애매 → LLM
    { text: '라라스윗 맛있어요' }, // 긍정 → 키워드 정상
  ];
  let received;
  const llmClassifier = async (items) => {
    received = items;
    return [{ alert: false, category: '정상댓글', reason: '', priority: 'normal' }];
  };
  const results = await classifyCommentsHybrid(comments, {}, { anthropicKey: 'key' }, llmClassifier);
  assert.deepEqual(received.map((item) => item.text), ['라라스윗 이거 광고인가요?']);
  assert.equal(results[0].engine, 'keyword');
  assert.equal(results[0].alert, true);
  assert.equal(results[1].engine, 'llm');
  assert.equal(results[2].engine, 'keyword');
});

test('광고 source(meta/tiktok/youtube)는 전 댓글을 LLM 문맥판정으로 보낸다(reviewAll 일반화)', async () => {
  const comments = [{ text: '라라스윗 맛있어요' }, { text: '잘 먹었습니다' }]; // 키워드로는 둘 다 정상
  // 브랜드 컨텍스트 없는 target + 정상 댓글: LLM에 안 보냄(키워드로 종결)
  let plainCalled = false;
  await classifyCommentsHybrid(comments, {}, { anthropicKey: 'key' },
    async (items) => { plainCalled = true; return items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' })); });
  assert.equal(plainCalled, false);
  // 브랜드 게시물(협찬)도 전 댓글을 LLM 문맥판정으로 보낸다(브랜드 무관 부정도 잡기 위한 확대).
  let brandReceived = null;
  await classifyCommentsHybrid(comments, { brandName: '라라스윗' }, { anthropicKey: 'key' },
    async (items) => { brandReceived = items; return items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' })); });
  assert.equal(brandReceived?.length, 2, '브랜드 게시물은 전 댓글(2개)을 LLM으로 보내야 함');
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

  // 소유채널 스코프가 없어도 브랜드 게시물이면 검토는 되지만(전 댓글 확대), [소유채널] 확대 정책·플래그는 아님.
  let thirdPartyInput = null;
  await classifyCommentsHybrid(
    [{ text: '인플루언서 왤케 비호감' }],
    { brandName: '라라스윗' },
    { anthropicKey: 'key' },
    async (items) => { thirdPartyInput = items; return items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' })); },
  );
  assert.equal(thirdPartyInput.length, 1);
  assert.equal(thirdPartyInput[0].ownedChannelBrandHostilityScope, false);
});

test('인지광고 타겟은 awarenessAdScope 플래그를 LLM 입력에 전달한다', async () => {
  let adInput = null;
  await classifyCommentsHybrid(
    [{ text: '또 광고냐' }],
    { brandName: '라라스윗', source: 'youtube_ads', ownedChannelBrandHostilityScope: true, awarenessAdScope: true },
    { anthropicKey: 'key' },
    async (items) => {
      adInput = items;
      return [{ alert: true, category: '광고/바이럴 의심', reason: '광고 피로', priority: 'normal' }];
    },
  );
  assert.equal(adInput.length, 1);
  assert.equal(adInput[0].awarenessAdScope, true);
  assert.equal(adInput[0].ownedChannelBrandHostilityScope, true);
});

test('스코프 지면 하드 적대 안전망: LLM이 정상으로 봐도 하드 토큰은 부정 확정', async () => {
  const normalLlm = async (items) => items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  // 소유/광고 지면 + 하드 적대 토큰 → LLM 정상 판정을 덮어 부정 확정(작은 LLM 저신호 적대 누락 방지).
  const [scoped] = await classifyCommentsHybrid(
    [{ text: '차단' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  assert.equal(scoped.alert, true);
  assert.equal(scoped.engine, 'keyword-hard-owned');

  // 광고 거부/피로 표현도 확정.
  const [adFatigue] = await classifyCommentsHybrid(
    [{ text: '왜 자꾸 뜨나 했더니 이거 광고였구나' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  assert.equal(adFatigue.alert, true);

  // 스코프가 없으면(일반 협찬·제3자) 안전망을 적용하지 않는다 → 정상 유지(댓글러 간 다툼 오탐 방지).
  const [nonScoped] = await classifyCommentsHybrid(
    [{ text: '차단' }],
    { brandName: '라라스윗' },
    { anthropicKey: 'key' }, normalLlm,
  );
  assert.equal(nonScoped.alert, false);

  // 스코프여도 하드 토큰이 없으면 오작동하지 않는다(LLM 정상 판정 존중).
  const [scopedClean] = await classifyCommentsHybrid(
    [{ text: '트러플맛 궁금하네요' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  assert.equal(scopedClean.alert, false);
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

test('LLM 키가 없으면 문맥형 댓글은 보류하고 LLM을 호출하지 않는다', async () => {
  let called = false;
  const results = await classifyCommentsHybrid(
    [{ text: '라라스윗 광고인가요?' }],
    { brandName: '라라스윗' },
    { anthropicKey: '' },
    async () => { called = true; return []; },
  );
  assert.equal(called, false);
  assert.equal(results[0].engine, 'llm-deferred');
  assert.equal(results[0].deferred, true);
  assert.equal(results[0].alert, false);
});

test('보류는 캐시를 오염시키지 않고 복구 회차에서 실분류되며 checkpoint 키를 남긴다', async () => {
  const config = { anthropicKey: 'k', supabaseUrl: 'https://db.example', supabaseKey: 'svc' };
  const entries = [{
    target: { platform: 'instagram', url: 'https://instagram.com/p/retry', brandName: '라라스윗' },
    comments: [{ id: 'c-defer', platform: 'instagram', text: '후님이 광고하니까 꼭 먹어볼게요🥰' }],
  }];
  let cacheWrites = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('comment_classification_cache') && options.method === 'POST') {
      cacheWrites += 1;
      return { ok: true, json: async () => [] };
    }
    return { ok: true, json: async () => [] };
  };

  const deferred = await classifyTargetsBatched(entries, config, async () => null, {}, fetchImpl);
  assert.equal(deferred[0][0].engine, 'llm-deferred');
  assert.equal(cacheWrites, 0, '보류 결과는 정상 캐시로 저장하면 안 됨');
  assert.deepEqual([...deferredEntryKeys(entries, deferred)], ['https://instagram.com/p/retry']);

  const recovered = await classifyTargetsBatched(
    entries,
    config,
    async () => [{ alert: false, category: '정상댓글', reason: '', priority: 'normal' }],
    {},
    fetchImpl,
  );
  assert.equal(recovered[0][0].engine, 'llm');
  assert.equal(recovered[0][0].deferred, undefined);
  assert.equal(cacheWrites, 1, '복구 후 실분류 결과만 캐시');
});

test('read-only 감사 분류는 실분류해도 운영 캐시를 쓰지 않는다', async () => {
  const config = {
    anthropicKey: 'k', supabaseUrl: 'https://db.example', supabaseKey: 'svc',
    classificationCacheReadOnly: true,
  };
  let writes = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('comment_classification_cache') && options.method === 'POST') writes += 1;
    return { ok: true, json: async () => [] };
  };
  const [[result]] = await classifyTargetsBatched([{
    target: { platform: 'youtube', postKey: 'yt:audit', brandName: '라라스윗', bypassClassificationCache: true },
    comments: [{ id: 'audit-comment', platform: 'youtube', text: '광고인가요?' }],
  }], config, async () => [{ alert: false, category: '정상댓글', reason: '', priority: 'none' }], {}, fetchImpl);

  assert.equal(result.engine, 'llm');
  assert.equal(writes, 0);
});
