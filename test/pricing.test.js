import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsd, TOKEN_PRICES_USD } from '../src/pricing.js';

test('estimateUsd: Haiku 4.5 단가로 토큰 비용 계산', () => {
  const usd = estimateUsd(
    { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 1_000_000, cacheCreate: 1_000_000 },
    'claude-haiku-4-5-20251001',
  );
  // 1*1 + 1*5 + 1*0.1 + 1*1.25 = 7.35
  assert.equal(Number(usd.toFixed(5)), 7.35);
});

test('estimateUsd: 누락 필드는 0으로 간주', () => {
  assert.equal(estimateUsd({ inputTokens: 500_000 }, 'claude-haiku-4-5-20251001'), 0.5);
  assert.equal(estimateUsd({}), 0);
});

test('estimateUsd: 미등록 모델은 기본 단가로 근사(중단 없음)', () => {
  const usd = estimateUsd({ inputTokens: 1_000_000 }, 'unknown-model-xyz');
  assert.equal(usd, 1);
});

test('TOKEN_PRICES_USD: Haiku 4.5 단가 고정', () => {
  assert.deepEqual(TOKEN_PRICES_USD['claude-haiku-4-5-20251001'], { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 });
});
