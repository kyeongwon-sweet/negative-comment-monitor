import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommentsLLM } from '../src/llm.js';

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
