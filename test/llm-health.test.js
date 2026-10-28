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
  assert.match(db.messages[0], /25건 문맥판정 보류 중/);
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

test('경고 문구는 원문 없이 보류·자동재분류와 담당자를 명시한다', () => {
  const text = buildLlmDegradedMessage('소유 YouTube', {
    failureCode: 'auth', persistent: true, candidateComments: 12, keywordFallbackComments: 12,
  }, 'U1');
  assert.match(text, /12건 문맥판정 보류 중/);
  assert.match(text, /복구 후 자동 재분류/);
  assert.match(text, /<@U1>/);
});

test('Gemini 429 폴백 경고는 무료 한도 원인과 공급자를 구분한다', () => {
  const text = buildLlmDegradedMessage('소유 YouTube', {
    failureProvider: 'gemini', failureCode: 'rate_limit', persistent: false,
    candidateComments: 8, keywordFallbackComments: 8,
  });
  assert.match(text, /Gemini 무료 한도\/호출 제한 초과/);
  assert.match(text, /Gemini 키·무료 한도를 확인/);
});

test('대량 작업 안전예산 도달은 장애가 아니라 정기 감시 몫 보호로 설명한다', () => {
  const text = buildLlmDegradedMessage('Meta 인지 광고', {
    failureProvider: 'gemini', failureCode: 'daily_budget', persistent: false,
    candidateComments: 10, keywordFallbackComments: 10,
  });
  assert.match(text, /대량 작업용 Gemini 안전예산 도달/);
  assert.match(text, /정기 감시 몫 보호/);
  assert.match(text, /오늘 이 1장만/);
});

test('1순위 Gemini 일시 오류 + 폴백 Anthropic 크레딧 부족은 즉시 경고하지 않고 3회 연속에서만 알린다', async () => {
  const db = statefulFetch();
  // 10-14 실사례: Gemini 5xx로 실패 → Anthropic 폴백이 크레딧 부족 → 1건 보류. 다음 회차 자동 재분류된다.
  const stats = {
    calls: 0, cacheHits: 0, cacheMiss: 1,
    failedAttempts: 3, transientFailures: 2, persistentFailures: 1,
    lastFailureProvider: 'anthropic', lastFailureCode: 'credit',
    providerLastFailure: { gemini: { code: 'server', kind: 'transient' }, anthropic: { code: 'credit', kind: 'persistent' } },
    keywordFallbackComments: 1, keywordFallbackBatches: 1, llmDeferredComments: 1,
  };
  const one = await monitorLlmHealth(CONFIG, stats, { scope: 'core', label: '일반 모니터', totalComments: 1 }, db.fetchImpl, 1_000);
  assert.equal(one.persistent, false);
  assert.equal(one.alerted, false, '첫 회차 즉시 경고 금지(1순위 복구 시 자동 회복)');
  assert.equal(one.failureProvider, 'gemini');
  assert.equal(one.failureCode, 'server');
  await monitorLlmHealth(CONFIG, stats, { scope: 'core', label: '일반 모니터', totalComments: 1 }, db.fetchImpl, 2_000);
  const three = await monitorLlmHealth(CONFIG, stats, { scope: 'core', label: '일반 모니터', totalComments: 1 }, db.fetchImpl, 3_000);
  assert.equal(three.alerted, true, '3회 연속이면 경고');
  assert.match(db.messages[0], /Gemini 서버 오류\(5xx\)/);
  assert.match(db.messages[0], /폴백 Anthropic도 실패: 크레딧 부족/);
});

test('영구 오류만 있으면(일시 오류 없음) 여전히 즉시 경고', () => {
  const out = summarizeLlmHealth({
    persistentFailures: 2, providerLastFailure: { gemini: { code: 'auth', kind: 'persistent' }, anthropic: { code: 'credit', kind: 'persistent' } },
    lastFailureCode: 'credit', keywordFallbackComments: 3,
  });
  assert.equal(out.persistent, true);
});

test('2026-10-26 재발방지: Gemini 무료 한도(429) 경고는 구간이 달라도 KST 하루 1장만 보낸다', async () => {
  const db = statefulFetch();
  const claimed = new Set();
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/cost_usage_ledger')) {
      const key = JSON.parse(init.body).run_key;
      const fresh = !claimed.has(key);
      claimed.add(key);
      return { ok: true, json: async () => (fresh ? [{ run_key: key }] : []) };
    }
    return db.fetchImpl(input, init);
  };
  const stats = {
    calls: 0, cacheHits: 0, cacheMiss: 5, failedAttempts: 1, transientFailures: 1,
    lastFailureProvider: 'gemini', lastFailureCode: 'rate_limit',
    providerLastFailure: { gemini: { kind: 'transient', code: 'rate_limit' } },
    keywordFallbackComments: 5, keywordFallbackBatches: 1,
  };
  const cfg = { ...CONFIG, llmFailureThreshold: 1 };
  const day1 = Date.parse('2026-10-26T01:00:00Z');
  const core = await monitorLlmHealth(cfg, stats, { scope: 'core', label: '일반 모니터', totalComments: 5 }, fetchImpl, day1);
  const ads = await monitorLlmHealth(cfg, stats, { scope: 'youtube-ads', label: 'YouTube 인지 광고', totalComments: 5 }, fetchImpl, day1 + 60_000);
  const owner = await monitorLlmHealth(cfg, stats, { scope: 'youtube-owner', label: 'YouTube 소유 채널', totalComments: 5 }, fetchImpl, day1 + 120_000);
  assert.deepEqual([core.alerted, ads.alerted, owner.alerted], [true, false, false]);
  assert.deepEqual([ads.quotaSuppressed, owner.quotaSuppressed], [true, true]);
  assert.equal(db.messages.length, 1);
  assert.match(db.messages[0], /이 원인 경고는 오늘 이 1장만/);
  assert.ok(claimed.has('llm-quota-warning:2026-10-26'));

  // 다음 KST 날짜(10-27 00:30 KST = 10-26 15:30Z)엔 다시 1장 — 구간별 12시간 쿨다운이 지난 구간에서
  const nextDay = await monitorLlmHealth(cfg, stats, { scope: 'tiktok-ads', label: 'TikTok 인지 광고', totalComments: 5 }, fetchImpl, Date.parse('2026-10-26T15:30:00Z'));
  assert.equal(nextDay.alerted, true);
  assert.equal(db.messages.length, 2);
});

test('무료 한도 외 원인(영구 오류)은 하루 1장 제한을 받지 않는다', async () => {
  const db = statefulFetch();
  const ledgerCalls = [];
  const fetchImpl = async (input, init = {}) => {
    if (String(input).includes('/cost_usage_ledger')) { ledgerCalls.push(input); return { ok: true, json: async () => [] }; }
    return db.fetchImpl(input, init);
  };
  const stats = { calls: 0, cacheHits: 0, cacheMiss: 3, failedAttempts: 1, persistentFailures: 1, lastFailureCode: 'auth', keywordFallbackComments: 3 };
  const out = await monitorLlmHealth(CONFIG, stats, { scope: 'core', totalComments: 3 }, fetchImpl, 1_000);
  assert.equal(out.alerted, true);
  assert.equal(ledgerCalls.length, 0);
});

test('2026-10-28: 강한 모델 2차 판정 실패는 1차가 정상이어도 별도 원장으로 3회 연속 시 경고한다', async () => {
  const db = statefulFetch();
  const stats = {
    calls: 1, cacheHits: 0, cacheMiss: 5, reviewed: 5,
    ownedEscalationSkipped: 3, ownedEscalationSkipReason: 'escalation_call_failed',
  };
  const config = { ...CONFIG, ownedBrandEscalationModel: 'gemini-3.5-flash-lite' };
  const runs = [];
  for (const t of [1_000, 2_000, 3_000]) runs.push(await monitorLlmHealth(config, stats, { scope: 'meta-ads', label: 'Meta 광고', totalComments: 5 }, db.fetchImpl, t));
  assert.equal(runs[0].degraded, false, '1차 분류는 정상');
  assert.deepEqual(runs.map((r) => r.escalation.alerted), [false, false, true]);
  assert.equal(db.messages.length, 1);
  assert.match(db.messages[0], /강한 모델 2차 판정 실패 — Meta 광고/);
  assert.match(db.messages[0], /gemini-3\.5-flash-lite/);
  assert.ok(db.rows.has('llm-escalation-meta-ads'), '1차 원장(llm-meta-ads)과 분리');
});

test('2026-10-28: 승격 모델 미설정 경로는 실패로 세지 않고, 소유채널은 escalationAlert:false로 중복 경고를 끈다', async () => {
  const db = statefulFetch();
  const unset = await monitorLlmHealth(CONFIG, {
    calls: 1, cacheMiss: 2, ownedEscalationSkipped: 2, ownedEscalationSkipReason: 'escalation_model_unset',
  }, { scope: 'core', totalComments: 2 }, db.fetchImpl, 1_000);
  assert.equal(unset.escalation.inactive, true);
  assert.equal(db.rows.has('llm-escalation-core'), false);

  const failing = { calls: 1, cacheMiss: 2, ownedEscalationSkipped: 2, ownedEscalationSkipReason: 'escalation_call_failed' };
  for (const t of [1_000, 2_000, 3_000]) {
    await monitorLlmHealth(CONFIG, failing, { scope: 'youtube-owner', totalComments: 2, escalationAlert: false }, db.fetchImpl, t);
  }
  assert.equal(db.messages.length, 0);
});
