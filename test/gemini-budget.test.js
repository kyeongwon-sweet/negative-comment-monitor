import test from 'node:test';
import assert from 'node:assert/strict';
import { claimGeminiRequestBudget } from '../src/gemini-budget.js';
import { classifyCommentsLLM } from '../src/llm.js';

function countResponse(count) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-range' ? `0-0/${count}` : null },
  };
}

const BASE = {
  supabaseUrl: 'https://db.test',
  supabaseKey: 'svc',
  geminiRollingRequestBudget: 480,
  geminiBulkRollingRequestBudget: 300,
  geminiQuotaWindowHours: 24,
};

test('정기 감시는 rolling 총량 480 전이면 호출권을 선점한다', async () => {
  const requests = [];
  const out = await claimGeminiRequestBudget({ ...BASE, geminiQuotaClass: 'live' }, async (input, init = {}) => {
    requests.push({ url: String(input), init });
    if (init.method === 'HEAD') return countResponse(299);
    return { ok: true, status: 201 };
  }, Date.parse('2026-10-26T03:00:00Z'));
  assert.equal(out.allowed, true);
  assert.equal(out.tracked, true);
  assert.equal(requests.filter((item) => item.init.method === 'HEAD').length, 1);
  const claim = requests.find((item) => item.init.method === 'POST');
  assert.match(JSON.parse(claim.init.body).run_key, /^gemini-request:live:/);
});

test('대량 작업은 300회에서 멈추고 정기 감시 몫을 보존한다', async () => {
  const requests = [];
  const out = await claimGeminiRequestBudget({ ...BASE, geminiQuotaClass: 'bulk' }, async (input, init = {}) => {
    requests.push({ url: String(input), init });
    if (String(input).includes('gemini-request%3Abulk%3A')) return countResponse(300);
    return countResponse(320);
  }, Date.parse('2026-10-26T03:00:00Z'));
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'bulk');
  assert.equal(requests.some((item) => item.init.method === 'POST'), false);
});

test('안전예산 도달 시 Gemini API를 호출하지 않고 회차 내 나머지를 보류한다', async () => {
  let geminiCalls = 0;
  const stats = {};
  const out = await classifyCommentsLLM(
    [{ text: '검토 대상' }],
    {
      ...BASE,
      llmProvider: 'gemini', geminiKey: 'g', geminiQuotaClass: 'bulk', geminiRequestIntervalMs: 0,
    },
    async (input, init = {}) => {
      const url = String(input);
      if (url.includes('cost_usage_ledger')) {
        if (url.includes('gemini-request%3Abulk%3A')) return countResponse(300);
        return countResponse(320);
      }
      geminiCalls += 1;
      return { ok: true, json: async () => ({}) };
    },
    stats,
  );
  assert.equal(out, null);
  assert.equal(geminiCalls, 0);
  assert.equal(stats.lastFailureCode, 'daily_budget');
  assert.equal(stats.providerCircuit.gemini, true);
  assert.equal(stats.geminiBudget.reason, 'bulk');
});

test('예산 원장 장애는 fail-open으로 실제 분류를 계속한다', async () => {
  let geminiCalls = 0;
  const out = await classifyCommentsLLM(
    [{ text: '검토 대상' }],
    { ...BASE, llmProvider: 'gemini', geminiKey: 'g', geminiRequestIntervalMs: 0 },
    async (input) => {
      if (String(input).includes('cost_usage_ledger')) return { ok: false, status: 503, headers: { get: () => null } };
      geminiCalls += 1;
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '[{"i":0,"alert":false,"category":"정상","reason":""}]' }] } }] }),
      };
    },
  );
  assert.equal(geminiCalls, 1);
  assert.equal(out[0].alert, false);
});

test('2026-10-28: 강한 모델 승격은 별도 장부(gemini-escalation:)로 세고 1차 총량을 쓰지 않는다', async () => {
  const requests = [];
  const out = await claimGeminiRequestBudget({ ...BASE, geminiQuotaClass: 'escalation' }, async (input, init = {}) => {
    requests.push({ url: String(input), init });
    if (init.method === 'HEAD') return countResponse(String(input).includes('gemini-escalation') ? 10 : 479);
    return { ok: true, status: 201 };
  }, Date.parse('2026-10-28T03:00:00Z'));
  assert.equal(out.allowed, true, '1차 총량이 479여도 승격 장부는 별개');
  const heads = requests.filter((item) => item.init.method === 'HEAD').map((item) => decodeURIComponent(item.url));
  assert.equal(heads.length, 1);
  assert.match(heads[0], /gemini-escalation:/);
  const claim = requests.find((item) => item.init.method === 'POST');
  assert.match(JSON.parse(claim.init.body).run_key, /^gemini-escalation:/);
  assert.doesNotMatch(JSON.parse(claim.init.body).run_key, /^gemini-request:/, '1차 총량 접두어와 겹치면 안 됨');

  const full = await claimGeminiRequestBudget({ ...BASE, geminiQuotaClass: 'escalation' }, async () => countResponse(200), Date.parse('2026-10-28T03:00:00Z'));
  assert.equal(full.allowed, false);
  assert.equal(full.reason, 'escalation');
});
