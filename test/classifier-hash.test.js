import test from 'node:test';
import assert from 'node:assert/strict';
import { computeClassifierHash } from '../src/classifier-hash.js';

test('computeClassifierHash: 64자 hex, 동일 입력 시 동일', () => {
  const a = computeClassifierHash({ anthropicModel: 'claude-haiku-4-5-20251001' });
  const b = computeClassifierHash({ anthropicModel: 'claude-haiku-4-5-20251001' });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
});

test('computeClassifierHash: 모델 ID가 다르면 해시도 다름(모델 교체=재분류)', () => {
  const a = computeClassifierHash({ anthropicModel: 'claude-haiku-4-5-20251001' });
  const b = computeClassifierHash({ anthropicModel: 'claude-sonnet-5' });
  assert.notEqual(a, b);
});

test('computeClassifierHash: 모델 미지정 시 기본 모델로 계산', () => {
  const dflt = computeClassifierHash({});
  const explicit = computeClassifierHash({ anthropicModel: 'claude-haiku-4-5-20251001' });
  assert.equal(dflt, explicit);
});

test('computeClassifierHash: LLM 공급자나 Gemini 모델이 바뀌면 캐시가 자동 무효화된다', () => {
  const anthropic = computeClassifierHash({ llmProvider: 'anthropic' });
  const gemini = computeClassifierHash({ llmProvider: 'gemini', geminiModel: 'gemini-3.1-flash-lite' });
  const otherGemini = computeClassifierHash({ llmProvider: 'gemini', geminiModel: 'gemini-3.5-flash-lite' });
  assert.notEqual(anthropic, gemini);
  assert.notEqual(gemini, otherGemini);
});
