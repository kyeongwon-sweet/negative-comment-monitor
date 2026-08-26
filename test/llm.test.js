import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommentsLLM, configuredLlmProviders, hasConfiguredLlmProvider } from '../src/llm.js';

function makeFetch(usageList) {
  let call = 0;
  return async () => {
    const usage = usageList[call] || {};
    call += 1;
    return {
      ok: true,
      json: async () => ({
        content: [{ text: '[]' }],
        usage,
      }),
    };
  };
}

test('classifyCommentsLLM accumulates usage into stats (counts/tokens only)', async () => {
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  const comments = [{ text: 'a' }, { text: 'b' }];
  const fetchImpl = makeFetch([
    { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
  ]);
  await classifyCommentsLLM(comments, { anthropicKey: 'k' }, fetchImpl, stats);
  assert.equal(stats.calls, 1);
  assert.equal(stats.reviewed, 2);
  assert.equal(stats.inputTokens, 100);
  assert.equal(stats.outputTokens, 20);
  assert.equal(stats.cacheRead, 5);
  assert.equal(stats.cacheCreate, 3);
});

test('classifyCommentsLLM sums usage across chunks (>25 comments = multiple calls)', async () => {
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  const comments = Array.from({ length: 30 }, (_, i) => ({ text: `c${i}` }));
  const fetchImpl = makeFetch([
    { input_tokens: 100, output_tokens: 10 },
    { input_tokens: 40, output_tokens: 4 },
  ]);
  await classifyCommentsLLM(comments, { anthropicKey: 'k' }, fetchImpl, stats);
  assert.equal(stats.calls, 2);
  assert.equal(stats.reviewed, 30);
  assert.equal(stats.inputTokens, 140);
  assert.equal(stats.outputTokens, 14);
});

test('classifyCommentsLLM works without stats (backward compatible) and tolerates missing usage', async () => {
  const comments = [{ text: 'a' }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ text: '[]' }] }) });
  const out = await classifyCommentsLLM(comments, { anthropicKey: 'k' }, fetchImpl);
  assert.equal(out.length, 1);
  // missing usage must not throw when stats present
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  await classifyCommentsLLM(comments, { anthropicKey: 'k' }, fetchImpl, stats);
  assert.equal(stats.calls, 1);
  assert.equal(stats.inputTokens, 0);
});

test('classifyCommentsLLM does not touch stats when it falls back (non-ok response)', async () => {
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  const out = await classifyCommentsLLM([{ text: 'a' }], { anthropicKey: 'k' }, fetchImpl, stats);
  assert.equal(out, null);
  assert.equal(stats.calls, 0);
});

test('classifyCommentsLLM retries transient Anthropic overload without leaking content', async () => {
  let attempts = 0;
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) return { ok: false, status: 529, headers: { get: () => null } };
    return {
      ok: true,
      json: async () => ({
        content: [{ text: '[{"i":0,"alert":false}]' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    };
  };
  const out = await classifyCommentsLLM(
    [{ text: '질문입니다' }],
    { anthropicKey: 'k', anthropicRetryBaseMs: 0 },
    fetchImpl,
    stats,
  );
  assert.equal(out[0].alert, false);
  assert.equal(attempts, 3);
  assert.equal(stats.attempts, 3);
  assert.equal(stats.failedAttempts, 2);
  assert.equal(stats.lastFailureStatus, 529);
  assert.equal(stats.calls, 1);
});

test('Anthropic credit 400은 재시도하지 않고 persistent/credit으로 구분한다', async () => {
  let attempts = 0;
  const stats = { calls: 0, reviewed: 0 };
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 400,
      json: async () => ({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' },
      }),
    };
  };
  const out = await classifyCommentsLLM([{ text: '검토 대상' }], { anthropicKey: 'k' }, fetchImpl, stats);
  assert.equal(out, null);
  assert.equal(attempts, 1);
  assert.equal(stats.failedAttempts, 1);
  assert.equal(stats.persistentFailures, 1);
  assert.equal(stats.transientFailures || 0, 0);
  assert.equal(stats.lastFailureCode, 'credit');
  assert.equal(stats.lastFailureKind, 'persistent');
});

test('Anthropic 401 키 오류도 재시도 없이 persistent/auth로 구분한다', async () => {
  const stats = { calls: 0, reviewed: 0 };
  const out = await classifyCommentsLLM([{ text: '검토 대상' }], { anthropicKey: 'bad-key' }, async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
  }), stats);
  assert.equal(out, null);
  assert.equal(stats.failedAttempts, 1);
  assert.equal(stats.persistentFailures, 1);
  assert.equal(stats.lastFailureCode, 'auth');
  assert.equal(stats.lastFailureKind, 'persistent');
});

test('소유채널 확대 정책은 표시된 댓글이 있을 때만 프롬프트에 추가된다', async () => {
  const prompts = [];
  const fetchImpl = async (url, init) => {
    prompts.push(JSON.parse(init.body).messages[0].content);
    return { ok: true, json: async () => ({ content: [{ text: '[]' }] }) };
  };
  await classifyCommentsLLM([{ text: '라라스윗 왤케 비호감', ownedChannelBrandHostilityScope: true }], { anthropicKey: 'k' }, fetchImpl);
  await classifyCommentsLLM([{ text: '인플루언서 왤케 비호감' }], { anthropicKey: 'k' }, fetchImpl);
  assert.match(prompts[0], /소유 YouTube 채널 확대 정책/);
  assert.match(prompts[0], /\[소유채널\] 라라스윗 왤케 비호감/);
  assert.doesNotMatch(prompts[1], /소유 YouTube 채널 확대 정책/);
});

test('Gemini 구조화 JSON 응답을 분류하고 공급자별 무료 사용량을 기록한다', async () => {
  const requests = [];
  const stats = {};
  const out = await classifyCommentsLLM(
    [{ text: '라라스윗 비호감', ownedChannelBrandHostilityScope: true }],
    { llmProvider: 'gemini', geminiKey: 'g', geminiModel: 'gemini-3.1-flash-lite', geminiRequestIntervalMs: 0 },
    async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '[{"i":0,"alert":true,"category":"브랜드 적대/조롱","reason":"브랜드를 비호감이라고 깎아내림"}]' }] } }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, cachedContentTokenCount: 4 },
        }),
      };
    },
    stats,
  );
  assert.equal(out[0].alert, true);
  assert.equal(out[0].category, '브랜드 적대/조롱');
  assert.match(requests[0].url, /gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(requests[0].init.headers['x-goog-api-key'], 'g');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseJsonSchema.type, 'array');
  assert.match(body.contents[0].parts[0].text, /\[소유채널\]/);
  assert.equal(stats.geminiCalls, 1);
  assert.equal(stats.geminiInputTokens, 120);
  assert.equal(stats.anthropicCalls || 0, 0);
  assert.equal(stats.lastSuccessfulProvider, 'gemini');
});

test('Gemini 429는 백오프 재시도 후 성공한다', async () => {
  let attempts = 0;
  const stats = {};
  const out = await classifyCommentsLLM(
    [{ text: '검토' }],
    { llmProvider: 'gemini', geminiKey: 'g', geminiRequestIntervalMs: 0, geminiRetryBaseMs: 0 },
    async () => {
      attempts += 1;
      if (attempts === 1) return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }),
      };
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }),
      };
    },
    stats,
  );
  assert.equal(out.length, 1);
  assert.equal(attempts, 2);
  assert.equal(stats.transientFailures, 1);
  assert.equal(stats.lastSuccessfulProvider, 'gemini');
});

test('Gemini 영구 실패 시 Anthropic으로 폴백하고 키워드 폴백은 하지 않는다', async () => {
  const urls = [];
  const stats = {};
  const out = await classifyCommentsLLM(
    [{ text: '검토' }],
    { llmProvider: 'gemini', geminiKey: 'bad', anthropicKey: 'anthropic', geminiRequestIntervalMs: 0 },
    async (url) => {
      urls.push(String(url));
      if (String(url).includes('generativelanguage')) return {
        ok: false,
        status: 401,
        json: async () => ({ error: { status: 'UNAUTHENTICATED', message: 'API key not valid' } }),
      };
      return {
        ok: true,
        json: async () => ({
          content: [{ text: '[{"i":0,"alert":false,"category":"정상","reason":""}]' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      };
    },
    stats,
  );
  assert.equal(out[0].alert, false);
  assert.equal(urls.length, 2);
  assert.equal(stats.providerCircuit.gemini, true);
  assert.equal(stats.anthropicCalls, 1);
  assert.equal(stats.lastSuccessfulProvider, 'anthropic');
  assert.equal(stats.llmCircuitOpen || false, false);
});

test('공급자 설정 감지는 Gemini 단독·Anthropic 단독·무키를 구분한다', () => {
  assert.deepEqual(configuredLlmProviders({ llmProvider: 'gemini', geminiKey: 'g', anthropicKey: 'a' }), ['gemini', 'anthropic']);
  assert.deepEqual(configuredLlmProviders({ anthropicKey: 'a' }), ['anthropic']);
  assert.equal(hasConfiguredLlmProvider({ geminiKey: 'g' }), true);
  assert.equal(hasConfiguredLlmProvider({}), false);
});
