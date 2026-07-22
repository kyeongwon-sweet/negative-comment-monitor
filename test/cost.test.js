import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APIFY_RATE_USD, DEFAULT_COST_THRESHOLDS, buildCostWarningText,
  estimateApifyUsd, maybeAlertCosts, recordRunCost, runKey, sumDailyCost, postCostWarning,
} from '../src/cost.js';

const CFG = { supabaseUrl: 'https://db.example', supabaseKey: 'svc', slackBotToken: 'x', slackChannelId: 'C0BHD9S69JA' };

test('estimateApifyUsd: 플랫폼별 단가 합산, 미지정은 기본단가', () => {
  const usd = estimateApifyUsd({ instagram: 1000, tiktok: 1000, youtube: 1000 });
  assert.equal(Number(usd.toFixed(4)), Number((0.0023e3 + 0.001e3 + 0.0015e3).toFixed(4)));
  assert.equal(estimateApifyUsd({}), 0);
  assert.equal(estimateApifyUsd({ unknownplat: 1000 }), 1.5); // 기본 $0.0015
});

test('runKey: GHA run_id+attempt 멱등키, 없으면 로컬 폴백', () => {
  assert.equal(runKey({ GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }), 'gha:123:2');
  assert.equal(runKey({ GITHUB_RUN_ID: '123' }), 'gha:123:1'); // attempt 기본 1
  assert.equal(runKey({}, 777), 'local:777');
});

test('recordRunCost: ignore-duplicates 업서트(재시도 중복합산 방지)', async () => {
  let url; let opts;
  const fetchImpl = async (u, o) => { url = u; opts = o; return { ok: true }; };
  const ok = await recordRunCost(CFG, { runKey: 'gha:1:1', kstDate: '2026-07-22', apifyUsd: 1.2, anthropicUsd: 0.03 }, fetchImpl);
  assert.equal(ok, true);
  assert.match(url, /cost_usage_ledger\?on_conflict=run_key/);
  assert.match(opts.headers.Prefer, /ignore-duplicates/);
  assert.equal(JSON.parse(opts.body).run_key, 'gha:1:1');
});

test('recordRunCost: 실패해도 예외 없이 false', async () => {
  assert.equal(await recordRunCost(CFG, { runKey: 'x', kstDate: '2026-07-22' }, async () => ({ ok: false })), false);
  assert.equal(await recordRunCost(CFG, { runKey: 'x', kstDate: '2026-07-22' }, async () => { throw new Error('x'); }), false);
  assert.equal(await recordRunCost({}, { runKey: 'x', kstDate: '2026-07-22' }, async () => ({ ok: true })), false);
});

test('sumDailyCost: 원장 행 합산', async () => {
  const fetchImpl = async (u) => {
    assert.match(u, /kst_date=eq\.2026-07-22/);
    return { ok: true, json: async () => [
      { apify_usd: 1.0, anthropic_usd: 0.02 },
      { apify_usd: 1.5, anthropic_usd: 0.03 },
    ] };
  };
  const totals = await sumDailyCost(CFG, '2026-07-22', fetchImpl);
  assert.equal(Number(totals.apifyUsd.toFixed(2)), 2.5);
  assert.equal(Number(totals.anthropicUsd.toFixed(2)), 0.05);
  assert.equal(Number(totals.totalUsd.toFixed(2)), 2.55);
});

test('sumDailyCost: 조회 실패는 null(경고 판단 스킵)', async () => {
  assert.equal(await sumDailyCost(CFG, '2026-07-22', async () => ({ ok: false })), null);
  assert.equal(await sumDailyCost(CFG, '2026-07-22', async () => { throw new Error('x'); }), null);
});

test('maybeAlertCosts: 임계치 초과분만, 최초 1회만 발송', async () => {
  const claims = new Set();
  const sent = [];
  const fetchImpl = async (u, o) => {
    // claimAlert POST → 처음이면 삽입행 반환, 재삽입이면 빈 배열(이미 발송)
    const body = JSON.parse(o.body);
    const key = `${body.kst_date}|${body.kind}`;
    if (claims.has(key)) return { ok: true, json: async () => [] };
    claims.add(key);
    return { ok: true, json: async () => [body] };
  };
  const totals = { apifyUsd: 2.5, anthropicUsd: 0.2, totalUsd: 2.7 }; // apify>2, anthropic>0.1, total<3
  const sender = async (kind, amount, threshold) => { sent.push({ kind, amount, threshold }); };
  const fired1 = await maybeAlertCosts(CFG, '2026-07-22', totals, DEFAULT_COST_THRESHOLDS, sender, fetchImpl);
  assert.deepEqual(fired1.sort(), ['anthropic', 'apify']); // total은 미초과
  // 같은 날 재실행 → 이미 발송분은 재발송 안 함
  const fired2 = await maybeAlertCosts(CFG, '2026-07-22', totals, DEFAULT_COST_THRESHOLDS, sender, fetchImpl);
  assert.deepEqual(fired2, []);
  assert.equal(sent.length, 2);
});

test('maybeAlertCosts: Slack 전송 실패 시 claim 해제(재시도 가능)', async () => {
  const deleted = [];
  const fetchImpl = async (u, o) => {
    if (o.method === 'DELETE') { deleted.push(u); return { ok: true }; }
    return { ok: true, json: async () => [JSON.parse(o.body)] }; // 항상 새 claim 성공
  };
  const sender = async () => { throw new Error('slack down'); };
  const fired = await maybeAlertCosts(CFG, '2026-07-22', { apifyUsd: 5, anthropicUsd: 0, totalUsd: 5 }, DEFAULT_COST_THRESHOLDS, sender, fetchImpl);
  assert.deepEqual(fired, []); // 전송 실패라 발송 목록 비어야
  assert.ok(deleted.some((u) => /kind=eq\.apify/.test(u)), 'apify claim 해제');
  assert.ok(deleted.some((u) => /kind=eq\.total/.test(u)), 'total claim 해제');
});

test('maybeAlertCosts: totals null이거나 캐시 비활성이면 아무것도 안 함', async () => {
  let called = false;
  const f = async () => { called = true; return { ok: true, json: async () => [] }; };
  assert.deepEqual(await maybeAlertCosts(CFG, '2026-07-22', null, DEFAULT_COST_THRESHOLDS, async () => {}, f), []);
  assert.deepEqual(await maybeAlertCosts({}, '2026-07-22', { apifyUsd: 9, anthropicUsd: 9, totalUsd: 9 }, DEFAULT_COST_THRESHOLDS, async () => {}, f), []);
  assert.equal(called, false);
});

test('buildCostWarningText: 종류·금액·임계치·KST·담당자 멘션 포함', () => {
  const txt = buildCostWarningText('apify', 2.3456, 2, '2026-07-22', 'U0B2Y0ZC8QZ');
  assert.match(txt, /Apify/);
  assert.match(txt, /\$2\.3456/);
  assert.match(txt, /\$2\.00/);
  assert.match(txt, /2026-07-22/);
  assert.match(txt, /<@U0B2Y0ZC8QZ>/);
});

test('postCostWarning: Slack 미설정이면 throw(상위서 claim 해제)', async () => {
  await assert.rejects(() => postCostWarning({}, 'apify', 3, 2, '2026-07-22', async () => ({ json: async () => ({ ok: true }) })), /Slack not configured/);
});

test('APIFY_RATE_USD/기본 임계치 상수 고정', () => {
  assert.equal(APIFY_RATE_USD.instagram, 0.0023);
  assert.deepEqual(DEFAULT_COST_THRESHOLDS, { apify: 2, anthropic: 0.1, total: 3 });
});
