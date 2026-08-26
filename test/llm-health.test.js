import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmDegradedMessage, monitorLlmHealth, summarizeLlmHealth } from '../src/llm-health.js';

const CONFIG = {
  supabaseUrl: 'https://db.test',
  supabaseKey: 'svc',
  slackBotToken: 'xoxb-test',
  slackChannelId: 'C123',
  slackAssignees: { other: 'U123' },
  llmFailureThreshold: 3,
  llmFailureAlertCooldownHours: 12,
};

function statefulFetch() {
  const rows = new Map();
  const messages = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('slack.com/api/chat.postMessage')) {
      messages.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true, ts: '1' }) };
    }
    const key = decodeURIComponent((url.match(/platform=eq\.([^&]+)/) || [])[1] || JSON.parse(init.body || '{}').platform || '');
    if ((init.method || 'GET') === 'GET') return { ok: true, json: async () => rows.has(key) ? [rows.get(key)] : [] };
    const row = JSON.parse(init.body);
    rows.set(row.platform, row);
    return { ok: true, json: async () => [row] };
  };
  return { fetchImpl, rows, messages };
}

test('크레딧·인증형 영구 오류는 첫 회차 즉시 degraded 경고한다', async () => {
  const db = statefulFetch();
  const stats = {
    calls: 0, cacheHits: 0, cacheMiss: 25,
    failedAttempts: 1, persistentFailures: 1,
    lastFailureCode: 'credit', keywordFallbackComments: 25, keywordFallbackBatches: 1,
  };
  const out = await monitorLlmHealth(CONFIG, stats, { scope: 'core', label: '일반 모니터', totalComments: 25 }, db.fetchImpl, 1_000);
  assert.equal(out.degraded, true);
  assert.equal(out.persistent, true);
  assert.equal(out.consecutiveFailures, 1);
  assert.equal(out.alerted, true);
  assert.equal(db.messages.length, 1);
  assert.match(db.messages[0], /크레딧 부족/);
  assert.match(db.messages[0], /키워드 판정으로 대체/);
});

test('429·5xx 최종 폴백은 3회 연속에서만 알리고 쿨다운한다', async () => {
  const db = statefulFetch();
  const stats = {
    calls: 0, cacheHits: 0, cacheMiss: 10,
    failedAttempts: 4, transientFailures: 4,
    lastFailureCode: 'server', keywordFallbackComments: 10, keywordFallbackBatches: 1,
  };
  const one = await monitorLlmHealth(CONFIG, stats, { scope: 'youtube-ads', totalComments: 10 }, db.fetchImpl, 1_000);
  const two = await monitorLlmHealth(CONFIG, stats, { scope: 'youtube-ads', totalComments: 10 }, db.fetchImpl, 2_000);
  const three = await monitorLlmHealth(CONFIG, stats, { scope: 'youtube-ads', totalComments: 10 }, db.fetchImpl, 3_000);
  const four = await monitorLlmHealth(CONFIG, stats, { scope: 'youtube-ads', totalComments: 10 }, db.fetchImpl, 4_000);
  assert.deepEqual([one.alerted, two.alerted, three.alerted, four.alerted], [false, false, true, false]);
  assert.equal(db.messages.length, 1);
});

test('호출 0이어도 전부 캐시 적중이면 degraded가 아니다', async () => {
  const health = summarizeLlmHealth({ calls: 0, cacheHits: 30, cacheMiss: 0, keywordFallbackComments: 0 }, 30);
  assert.equal(health.candidateComments, 30);
  assert.equal(health.keywordFallback, false);
  assert.equal(health.degraded, false);
});

test('LLM 대상 자체가 없는 회차는 헬스 저장·경고를 생략한다', async () => {
  let calls = 0;
  const out = await monitorLlmHealth(CONFIG, {}, { scope: 'core', totalComments: 20 }, async () => { calls += 1; });
  assert.equal(out.inactive, true);
  assert.equal(calls, 0);
});

test('경고 문구는 원문 없이 미탐지 위험과 담당자를 명시한다', () => {
  const text = buildLlmDegradedMessage('소유 YouTube', {
    failureCode: 'auth', persistent: true, candidateComments: 12, keywordFallbackComments: 12,
  }, 'U1');
  assert.match(text, /브랜드 적대·비꼼·문맥형/);
  assert.match(text, /<@U1>/);
});
