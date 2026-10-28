import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommentsHybrid, classifyTargetsBatched, deferredEntryKeys } from '../src/hybrid-classify.js';
import { commentFingerprint } from '../src/dedup.js';
import { classificationCacheFingerprint } from '../src/cache.js';
import { suppressLowConfidenceOwnerRisks } from '../src/youtube-owner-risk.js';

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

test('미탐 스윕 반영: 소유 채널에서 봇이 놓쳤던 저신호 부정 표현을 확정한다', async () => {
  const normalLlm = async (items) => items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  const missed = [
    '첨듣는데 뭔 헛소리야', '개쌉소리여', '가지가지하네', '족구하고 있네', '개맛없다',
    '댓글알바 작작써라', '앵무새 쟤는 라라스윗 저거만 나오니깐 믿거ㄱㄱ',
    '걍 하겐다즈 먹지 듣보 아이스크림이야 안먹음', '이딴 광고 보내지 마쇼 안 살테니까',
    '안살테니 나오지 마쇼', '망국열차행임',
  ];
  const results = await classifyCommentsHybrid(
    missed.map((text) => ({ text })),
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  results.forEach((r, i) => assert.equal(r.alert, true, `미탐 확정 실패: ${missed[i]}`));

  // 긍정 팬 댓글은 하드 토큰이 없어 정상 유지(오탐 방지).
  const [positive] = await classifyCommentsHybrid(
    [{ text: '라라스윗 맛있어.. 저당인데 고급스런 맛이다' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  assert.equal(positive.alert, false);
});

test('ljeeeReiq1k 재발방지: 소유채널은 브랜드 미언급이어도 LLM 정상건을 강한 모델로 2차 승격', async () => {
  // 1차(약한 모델)=정상, 2차(강한 모델)=부정으로 단계별 응답하는 목.
  let call = 0;
  const staged = async (items) => {
    call += 1;
    return items.map(() => (call === 1
      ? { alert: false, category: '정상댓글', reason: '', priority: 'normal' }
      : { alert: true, category: '광고 냉소/피로', reason: '광고 피로', priority: 'high' }));
  };
  // 브랜드/제품명을 안 부르고 하드넷에도 안 걸리는 미묘 부정(실제 미탐 유형).
  const [risk] = await classifyCommentsHybrid(
    [{ text: '이거 어디서 살 수 있는지 궁금하긴 하네요' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true },
    { anthropicKey: 'key', ownedBrandEscalationModel: 'claude-strong' },
    staged,
  );
  assert.equal(risk.alert, true, '브랜드 미언급 소유댓글도 강한 모델 승격 대상이어야 함');
  assert.equal(risk.engine, 'llm-strong-owned');

  // 비소유(제3자) 스코프는 승격하지 않는다(고volume 오탐·비용 방지).
  let call2 = 0;
  const staged2 = async (items) => {
    call2 += 1;
    return items.map(() => (call2 === 1
      ? { alert: false, category: '정상댓글', reason: '', priority: 'normal' }
      : { alert: true, category: 'x', reason: 'y', priority: 'high' }));
  };
  const [nonScoped] = await classifyCommentsHybrid(
    [{ text: '이거 어디서 살 수 있는지 궁금하긴 하네요' }],
    { brandName: '라라스윗', fullContextReview: true },
    { anthropicKey: 'key', ownedBrandEscalationModel: 'claude-strong' },
    staged2,
  );
  assert.equal(nonScoped.alert, false, '비소유 스코프는 강한 모델 승격 대상이 아니어야 함');
});

test('pCRMnMYe3y8 회귀: 제품 폄하·AI 광고 거부와 운영 지정 경쟁품 우위 표현을 잡는다', async () => {
  const normalLlm = async (items) => items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  const missed = [
    '친구가 다 먹었는데 약 맛 난다고 함',
    '먹어봤는데 특별히 맛있진 않던데',
    '맛도 개 없더만 메로나가 더 맛있는데',
    '셋다 필요없고 메로나, 요맘때 맛',
    '메로나 짭이고 GS25 망하는 소리',
    'Ai그만좀 써라. 광고가 다 뭔 Ai냐',
    'AI 딸깍 광고 방식을 새로 바꾸셔야할듯',
    'AI좀 작작 써라 그렇게 하면 그걸 누가 사먹겠냐',
    '언론에 뒷돈 주고 억지 유행 만들지 말고 광고만 그만해',
    '앵무새야 그만해',
    '먹을만하긴해 근데 메로나가 훨 맛있고 다른거 사먹는게 훨씬 나음',
    '"메로나": 원조는 다르다',
    '내 지갑을 턴 그것... "메로나"',
    '댓글이 있네..',
    '메론맛은 메로나로 종결이다~',
    '메로나가 제일인듯',
    '메로나가 짱이야',
    '난 메로나가 좋소',
    '그냥 메로나 맛이던데',
  ];
  const risks = await classifyCommentsHybrid(
    missed.map((text) => ({ text })),
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  risks.forEach((risk, index) => {
    assert.equal(risk.alert, true, `미탐 확정 실패: ${missed[index]}`);
    assert.equal(risk.engine, 'keyword-hard-owned');
  });

  const neutral = ['메로나 바나나맛 망고맛 멜론맛', '메로나랑 쫀득바 둘 다 좋아요'];
  const neutralRisks = await classifyCommentsHybrid(
    neutral.map((text) => ({ text })),
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  neutralRisks.forEach((risk, index) => assert.equal(risk.alert, false, `중립 경쟁품 선호 오탐: ${neutral[index]}`));

  // LLM이 이미 부정으로 잡았지만 후속 owner-risk 게이트가 인정하지 않는 카테고리여도
  // 하드 표현은 전용 엔진으로 승격돼 다시 억제되지 않아야 한다.
  const [llmAlert] = await classifyCommentsHybrid(
    [{ text: 'Ai그만좀 써라 광고가 다 뭔 Ai냐' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' },
    async () => [{ alert: true, category: '콘텐츠 비판', reason: 'AI 광고 비판', priority: 'normal' }],
  );
  assert.equal(llmAlert.alert, true);
  assert.equal(llmAlert.engine, 'keyword-hard-owned');
});

test('YKZrq8o0xfU 회귀: 품절 컨셉 의심과 경쟁품 단독 찬양을 소유 지면에서 확정한다', async () => {
  const normalLlm = async (items) => items.map(() => ({
    alert: false, category: '정상댓글', reason: '', priority: 'normal',
  }));
  const missed = [
    '컨셉이네... 나는 가는 지에스마다 있음',
    '이거 편의점에 많던데.... 왜 품절이라는거야?? 갈때마다 있던데...',
    '초딩인데 메로나가 존맛입니다',
  ];
  const risks = await classifyCommentsHybrid(
    missed.map((text) => ({ text })),
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  risks.forEach((risk, index) => {
    assert.equal(risk.alert, true, `운영 확정 미탐: ${missed[index]}`);
    assert.equal(risk.engine, 'keyword-hard-owned');
  });

  const neutral = [
    '오늘 편의점에 있어서 드디어 사 먹었는데 맛있어요',
    '메로나랑 쫀득바 둘 다 존맛이에요',
  ];
  const neutralRisks = await classifyCommentsHybrid(
    neutral.map((text) => ({ text })),
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true },
    { anthropicKey: 'key' }, normalLlm,
  );
  neutralRisks.forEach((risk, index) => assert.equal(risk.alert, false, `긍정 오탐: ${neutral[index]}`));
});

test('소유채널 승격(협소화 제거): 브랜드 언급 여부와 무관하게 LLM 정상건을 전부 강한 모델로 재판정', async () => {
  // 2026-09-22 ljeeeReiq1k 재발방지: 옛 A안은 본문에 브랜드/제품명이 있어야만 승격했는데,
  // 실제 미탐 대부분은 브랜드명을 안 부르는 경쟁제품 우위·광고 냉소류였다. 이제 소유 스코프의
  // '이번 회차 LLM 정상' 건은 브랜드 미언급이어도 전부 강한 모델 2차 판정 대상이다.
  const comments = [
    { text: '라라스윗 나본적도 없는데?', id: 'c1' }, // 브랜드 언급
    { text: '오늘 날씨 참 좋네요', id: 'c2' },        // 브랜드 미언급 — 이제도 승격 후보
  ];
  const calls = [];
  const llmClassifier = async (items, cfg) => {
    calls.push({ provider: cfg.llmProvider, anthropicModel: cfg.anthropicModel, n: items.length });
    // 강한 모델(승격) 호출이면 부정으로, 약한 1차 호출이면 전부 정상으로 응답한다.
    if (cfg.anthropicModel === 'claude-strong-test') {
      return items.map(() => ({ alert: true, category: '브랜드 적대/조롱', reason: '소유채널 부정', priority: 'high' }));
    }
    return items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  };
  const [results] = await classifyTargetsBatched(
    [{ comments, target: { brandName: '라라스윗', ownedChannelBrandHostilityScope: true } }],
    { anthropicKey: 'key', ownedBrandEscalationModel: 'claude-strong-test' },
    llmClassifier,
  );
  assert.equal(results[0].alert, true, '브랜드 언급 댓글은 승격돼야 한다');
  assert.equal(results[0].engine, 'llm-strong-owned');
  assert.equal(results[1].alert, true, '브랜드 미언급 소유댓글도 이제 승격 대상이어야 한다');
  assert.equal(results[1].engine, 'llm-strong-owned');
  // 강한 모델은 소유 스코프 LLM 정상건 2개 모두를 대상으로 호출된다(협소화 제거).
  const strongCall = calls.find((c) => c.anthropicModel === 'claude-strong-test');
  assert.ok(strongCall, '강한 모델 승격 호출이 있어야 한다');
  assert.equal(strongCall.n, 2);
});

test('A안 승격 비활성/미대상: 모델 미설정이면 승격하지 않고, 비소유 지면은 대상 아니다', async () => {
  const strongAlways = async (items, cfg) => (cfg.anthropicModel === 'claude-strong-test'
    ? items.map(() => ({ alert: true, category: '브랜드 적대/조롱', reason: 'x', priority: 'high' }))
    : items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' })));
  // 모델 미설정 → 승격 경로 자체가 꺼진다.
  const [offResults] = await classifyTargetsBatched(
    [{ comments: [{ text: '라라스윗 나본적도 없는데?' }], target: { brandName: '라라스윗', ownedChannelBrandHostilityScope: true } }],
    { anthropicKey: 'key' }, strongAlways,
  );
  assert.equal(offResults[0].alert, false);
  // 비소유(협찬/제3자) 지면은 브랜드 언급이어도 승격 대상 아님.
  const [thirdParty] = await classifyTargetsBatched(
    [{ comments: [{ text: '라라스윗 나본적도 없는데?' }], target: { brandName: '라라스윗' } }],
    { anthropicKey: 'key', ownedBrandEscalationModel: 'claude-strong-test' }, strongAlways,
  );
  assert.equal(thirdParty[0].alert, false);
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

test('gXfkWldB0u4 재발방지: 약한 LLM 부정이 소유 게이트에 억제될 건은 강한 모델이 동의하면 최종까지 살아남는다', async () => {
  const target = { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true };
  const comments = [{ text: '허니버터만하겠냐?' }, { text: '광고 의 신개념.' }];
  // 1차(약한)=둘 다 부정(브랜드 미명시라 게이트 억제 대상), 2차(강한)=첫째만 부정.
  let call = 0;
  const staged = async (items) => {
    call += 1;
    if (call === 1) return items.map(() => ({ alert: true, category: '경쟁품 비교', reason: '경쟁품과 비교 폄하', priority: 'high' }));
    return items.map((item) => (item.text.includes('허니버터')
      ? { alert: true, category: '경쟁품 비교', reason: '경쟁품 우위로 제품 폄하', priority: 'high' }
      : { alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  };
  const risks = await classifyCommentsHybrid(comments, target, { anthropicKey: 'key', ownedBrandEscalationModel: 'claude-strong' }, staged);
  assert.equal(call, 2, '게이트 억제 대상은 강한 모델 2차 판정을 받아야 함');
  // 실제 운영 경로처럼 소유 게이트까지 통과시켜 최종 결정을 본다(전엔 여기서 억제돼 공개 잔존).
  const finalRisks = suppressLowConfidenceOwnerRisks(target, comments, risks);
  assert.equal(finalRisks[0].alert, true, '강한 모델이 동의한 경쟁품 폄하는 숨김 대상');
  assert.equal(finalRisks[0].engine, 'llm-strong-owned');
  assert.equal(finalRisks[1].alert, false, '강한 모델이 동의하지 않으면 게이트가 억제(가십 오탐 방지 유지)');
  assert.equal(finalRisks[1].ownerLowConfidenceSuppressed, true);
});

test('기존 승격(약한 정상→강한 부정)도 소유 게이트에서 다시 억제되지 않는다', async () => {
  const target = { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true };
  const comments = [{ text: '이거 어디서 살 수 있는지 궁금하긴 하네요' }];
  let call = 0;
  const staged = async (items) => {
    call += 1;
    return items.map(() => (call === 1
      ? { alert: false, category: '정상댓글', reason: '', priority: 'normal' }
      : { alert: true, category: '광고/바이럴 의심', reason: '광고 냉소', priority: 'high' }));
  };
  const risks = await classifyCommentsHybrid(comments, target, { anthropicKey: 'key', ownedBrandEscalationModel: 'claude-strong' }, staged);
  const [finalRisk] = suppressLowConfidenceOwnerRisks(target, comments, risks);
  assert.equal(finalRisk.alert, true);
});

test('gXfkWldB0u4 하드넷: 광고 짜증 표현과 안사먹 오타 변형', async () => {
  const { matchesOwnedHardHostility } = await import('../src/classify.js');
  assert.equal(matchesOwnedHardHostility('정말 짜증나게 광고하네. 절대 안시먹는다'), true);
  assert.equal(matchesOwnedHardHostility('광고 짜증나요'), true);
  assert.equal(matchesOwnedHardHostility('맛피아는 배민애서 배달 돼요 😂'), false);
});

test('분류기 해시가 바뀌어도 이미 판정한 옛 댓글은 재판정하지 않고 이전 판정을 현재 해시로 이월 저장', async () => {
  const comments = [{ id: 'c-old', text: '라라스윗 이거 광고인가요?' }, { id: 'c-new', text: '라라스윗 이거 광고인가요??' }];
  const target = { platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc', brandName: '라라스윗', fullContextReview: true };
  const oldFp = classificationCacheFingerprint(target, comments[0]);
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') { writes.push(...JSON.parse(init.body)); return { ok: true, json: async () => [] }; }
    // 옛 댓글만 이전 해시(prev)로 '정상' 판정 이력이 있다. 실제 DB처럼 classifier_hash 필터를 존중한다.
    const rows = [{ fingerprint: oldFp, classifier_hash: 'prev-hash', alert: false, category: '정상댓글', reason: '', priority: 'normal', created_at: '2026-10-05' }];
    const hashFilter = decodeURIComponent(String(url)).match(/classifier_hash=eq\.([^&]+)/)?.[1];
    return { ok: true, json: async () => rows.filter((row) => !hashFilter || row.classifier_hash === hashFilter) };
  };
  const sent = [];
  const llm = async (items) => {
    sent.push(...items.map((i) => i.text));
    return items.map(() => ({ alert: true, category: '광고/바이럴 의심', reason: 'z', priority: 'normal' }));
  };
  const stats = {};
  const [risks] = await classifyTargetsBatched([{ comments, target }], CACHE_CFG, llm, stats, fetchImpl);
  assert.deepEqual(sent, ['라라스윗 이거 광고인가요??'], '새 댓글만 LLM으로');
  assert.equal(risks[0].alert, false, '옛 댓글은 이전 판정(정상) 유지 — 월요일 일괄 숨김 방지');
  assert.equal(risks[0].engine, 'llm-cache');
  assert.equal(risks[1].alert, true, '새 댓글은 새 기준으로 판정');
  assert.equal(stats.cacheCarriedForward, 1);
  assert.ok(writes.some((row) => row.fingerprint === oldFp && row.alert === false), '이월 판정을 현재 해시로 재저장(90일 정리 대비)');
});

test('안전장치: 분류기가 category=정상으로 낸 결과는 alert=true여도 알림·숨김하지 않는다', async () => {
  const llm = async (items) => items.map(() => ({ alert: true, category: '정상', reason: '광고 흐름을 흐리는 무관한 잡담', priority: 'normal' }));
  const [risk] = await classifyCommentsHybrid([{ text: '라라스윗 갈비찜 레시피 쓰이겠네' }], { brandName: '라라스윗', fullContextReview: true }, { anthropicKey: 'key' }, llm);
  assert.equal(risk.alert, false);
  assert.equal(risk.normalCategoryGuard, true);
});

test('5q7z3FExo_Q 재발방지: 강한 모델 미설정이면 승격 대상 건수를 stats에 남긴다(조용한 무력화 금지)', async () => {
  const weakNegative = async (items) => items.map(() => ({ alert: true, category: '광고/바이럴 의심', reason: '광고 피로', priority: 'normal' }));
  const stats = {};
  await classifyCommentsHybrid(
    [{ text: '제발 바이럴좀 그만해라' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true },
    { anthropicKey: 'key' },
    weakNegative,
    stats,
  );
  assert.equal(stats.ownedEscalationSkipped, 1);
  assert.equal(stats.ownedEscalationSkipReason, 'escalation_model_unset');

  const keyless = {};
  await classifyCommentsHybrid(
    [{ text: '제발 바이럴좀 그만해라' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true },
    { anthropicKey: 'key', ownedBrandEscalationModel: 'gemini-3.1-pro' },
    weakNegative,
    keyless,
  );
  assert.equal(keyless.ownedEscalationSkipReason, 'escalation_key_missing');
});

test('5q7z3FExo_Q 재발방지: 강한 모델 호출이 실패(404 등 null)하면 승격 실패 건수를 남긴다', async () => {
  let call = 0;
  const strongFails = async (items) => {
    call += 1;
    if (call > 1) return null; // classifyCommentsLLM은 공급자 실패 시 throw 대신 null을 반환한다.
    return items.map(() => ({ alert: true, category: '광고/바이럴 의심', reason: '광고 피로', priority: 'normal' }));
  };
  const stats = {};
  const [risk] = await classifyCommentsHybrid(
    [{ text: '요즘 이런 영상 너무 자주 보이네요' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true },
    { geminiKey: 'key', ownedBrandEscalationModel: 'gemini-3.8-flash' },
    strongFails,
    stats,
  );
  assert.equal(call, 2, '강한 모델 호출을 시도해야 함');
  // 1차 '부정'은 게이트 억제·캐시 고착 대신 보류 → 다음 회차 재판정.
  assert.equal(risk.engine, 'llm-deferred');
  assert.equal(risk.alert, false);
  assert.equal(stats.ownedEscalationDeferred, 1);
  assert.equal(stats.llmDeferredComments, 1);
  assert.equal(stats.ownedEscalationSkipped, 1);
  assert.equal(stats.ownedEscalationSkipReason, 'escalation_call_failed');
});

test('5q7z3FExo_Q 회귀: 바이럴 피로·거부 표현은 소유 지면 하드넷으로 확정하고 중립 언급은 건드리지 않는다', async () => {
  const normalLlm = async (items) => items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  const target = { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true };
  const texts = ['제발 바이럴좀 그만해라ㅗㅗ', '라라스윗 제품 족족 다 바이럴하는거 보기싫다 좀 제발', '이거 바이럴 아니고 진짜 맛있음'];
  const risks = await classifyCommentsHybrid(texts.map((text) => ({ text })), target, { anthropicKey: 'key' }, normalLlm);
  assert.deepEqual(risks.map((r) => r.engine === 'keyword-hard-owned'), [true, true, false]);
});

test('5q7z3FExo_Q 재발방지: 승격 실패로 보류된 1차 부정은 분류 캐시에 저장하지 않는다(다음 회차 재판정)', async () => {
  let call = 0;
  const strongFails = async (items) => {
    call += 1;
    if (call > 1) return null;
    return items.map((item) => (item.text.includes('부정')
      ? { alert: true, category: '광고/바이럴 의심', reason: 'r', priority: 'normal' }
      : { alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  };
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST' && String(url).includes('comment_classification_cache')) posts.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  const target = { platform: 'youtube', url: 'https://www.youtube.com/watch?v=v1', postKey: 'yt:v1', brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true };
  const comments = [{ id: 'a', text: '요즘 이런 영상 부정 느낌' }, { id: 'b', text: '요즘 이런 영상 좋네요' }];
  const [risks] = await classifyTargetsBatched(
    [{ target, comments }],
    { ...CACHE_CFG, geminiKey: 'key', ownedBrandEscalationModel: 'gemini-3.5-flash-lite' },
    strongFails, {}, fetchImpl,
  );
  assert.equal(risks[0].engine, 'llm-deferred');
  assert.equal(risks[1].engine, 'llm');
  const stored = posts.flat().map((row) => row.fingerprint);
  assert.equal(stored.includes(classificationCacheFingerprint(target, comments[0])), false, '보류건은 캐시에 굳으면 안 됨');
  assert.equal(stored.includes(classificationCacheFingerprint(target, comments[1])), true, '1차 정상은 그대로 캐시');
});

test('5q7z3FExo_Q 재발방지: 강한 모델이 본 뒤 정상이면 검토 표시가 남아 게이트 억제가 정당한 억제로 구분된다', async () => {
  let call = 0;
  const strongSaysNo = async (items) => {
    call += 1;
    return items.map(() => (call === 1
      ? { alert: true, category: '광고/바이럴 의심', reason: 'r', priority: 'normal' }
      : { alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  };
  const target = { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true };
  const comments = [{ text: '요즘 이런 영상 너무 자주 보이네요' }];
  const risks = await classifyCommentsHybrid(comments, target, { geminiKey: 'key', ownedBrandEscalationModel: 'gemini-3.5-flash-lite' }, strongSaysNo);
  assert.equal(risks[0].ownedEscalationReviewed, true);
  const [gated] = suppressLowConfidenceOwnerRisks(target, comments, risks);
  assert.equal(gated.ownerLowConfidenceSuppressed, true);
  assert.equal(gated.ownedEscalationReviewed, true, '게이트 억제 후에도 검토 표시가 남아야 run 불변식이 오탐하지 않음');
});

test('2026-10-28 광고 확대: 인지광고 지면의 1차 정상은 강한 모델로 구제하되, 광고 자신의 지면 정책으로 판정한다', async () => {
  const strongCalls = [];
  let call = 0;
  const staged = async (items, cfg) => {
    call += 1;
    if (call > 1) {
      strongCalls.push({ items, cfg });
      return items.map(() => ({ alert: true, category: '광고/바이럴 의심', reason: '광고 냉소', priority: 'normal' }));
    }
    return items.map((item) => (item.text.includes('최악')
      ? { alert: true, category: '제품 불만', reason: 'r', priority: 'normal' }
      : { alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  };
  // Meta·TikTok 광고 대상: awarenessAdScope만 있고 소유 스코프는 없다.
  const target = { brandName: '라라스윗', awarenessAdScope: true, fullContextReview: true };
  const risks = await classifyCommentsHybrid(
    [{ text: '요즘 이런 영상 너무 자주 보이네요' }, { text: '이거 최악' }],
    target,
    { geminiKey: 'key', ownedBrandEscalationModel: 'gemini-3.5-flash-lite' },
    staged,
  );
  assert.equal(risks[0].engine, 'llm-strong-owned', '1차 정상 광고 댓글도 강한 모델 승격 대상');
  assert.equal(strongCalls.length, 1);
  assert.equal(strongCalls[0].items.length, 1, '광고 지면의 1차 부정은 게이트가 없어 재판정하지 않음');
  assert.equal(strongCalls[0].items[0].awarenessAdScope, true);
  assert.equal(strongCalls[0].items[0].ownedChannelBrandHostilityScope, false, '광고 댓글을 소유채널 정책으로 판정하면 안 됨');
  assert.equal(strongCalls[0].cfg.geminiQuotaClass, 'escalation', '승격은 별도 예산 장부');
  assert.equal(risks[1].alert, true);
});

test('2026-10-28 광고 확대: YouTube 광고(소유+인지 스코프)의 1차 부정은 보류되지 않고 그대로 알림된다', async () => {
  let call = 0;
  const strongFails = async (items) => {
    call += 1;
    if (call > 1) return null;
    return items.map(() => ({ alert: true, category: '광고/바이럴 의심', reason: 'r', priority: 'normal' }));
  };
  const [risk] = await classifyCommentsHybrid(
    [{ text: '요즘 이런 영상 너무 자주 보이네요' }],
    { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, awarenessAdScope: true, fullContextReview: true },
    { geminiKey: 'key', ownedBrandEscalationModel: 'gemini-3.5-flash-lite' },
    strongFails,
  );
  assert.equal(call, 1, '게이트 없는 광고 지면의 1차 부정은 강한 모델을 부르지 않음');
  assert.equal(risk.alert, true);
  assert.equal(risk.engine, 'llm');
});

test('2026-10-28 사람 판정 회귀: 유행 부정·광고 재탕 냉소는 소유 지면 하드넷, 단순 질문·호기심은 건드리지 않는다', async () => {
  const normalLlm = async (items) => items.map(() => ({ alert: false, category: '정상댓글', reason: '', priority: 'normal' }));
  const target = { brandName: '라라스윗', ownedChannelBrandHostilityScope: true, fullContextReview: true };
  const texts = ['그래서 이거 누가 먹음?', '이런거 특: 나만 모름', '복붙해서 나오것네', '언제쩍이냐', '이게 뭔데', '처음 보는데 맛있어 보여요'];
  const risks = await classifyCommentsHybrid(texts.map((text) => ({ text })), target, { anthropicKey: 'key' }, normalLlm);
  assert.deepEqual(risks.map((r) => r.engine === 'keyword-hard-owned'), [true, true, true, true, false, false]);
});
