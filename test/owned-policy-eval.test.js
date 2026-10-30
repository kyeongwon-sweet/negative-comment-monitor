import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadGoldenCases, runOwnedPolicyEval, EVAL_TARGET } from '../scripts/owned-policy-eval.mjs';
import { classifyCommentsHybrid } from '../src/hybrid-classify.js';

const WORKFLOW = readFileSync(new URL('../.github/workflows/owned-policy-eval.yml', import.meta.url), 'utf8');
const OWNER_WORKFLOW = readFileSync(new URL('../.github/workflows/youtube-owner-channel.yml', import.meta.url), 'utf8');

test('golden set: 사람 판정 케이스는 id 유일·expect 값 고정·숨김/유지 둘 다 있음', () => {
  const cases = loadGoldenCases();
  assert.ok(cases.length >= 20);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'id 중복');
  for (const c of cases) {
    assert.ok(['hide', 'keep'].includes(c.expect), c.id);
    assert.ok(String(c.text || '').trim(), c.id);
  }
  assert.ok(cases.some((c) => c.expect === 'hide'));
  assert.ok(cases.some((c) => c.expect === 'keep'));
});

test('eval 워크플로 기본 모델이 운영 소유채널 워크플로와 같다(다른 모델을 재면 의미 없음)', () => {
  const weak = OWNER_WORKFLOW.match(/GEMINI_MODEL:\s*(\S+)/)?.[1];
  const strong = OWNER_WORKFLOW.match(/OWNED_BRAND_ESCALATION_MODEL:[^\n]*\|\| '([^']+)'/)?.[1];
  assert.ok(weak && strong);
  assert.match(WORKFLOW, new RegExp(`inputs\\.weak_model \\|\\| '${weak}'`));
  assert.match(WORKFLOW, new RegExp(`inputs\\.escalation_model \\|\\| '${strong}'`));
});

test('eval은 운영과 같은 경로를 탄다: 하드넷·게이트 반영, 단계별 진단, 불일치 집계', async () => {
  const cases = [
    { id: 'a', expect: 'hide', text: '또 광고냐' },
    { id: 'b', expect: 'keep', text: '어디서 팔아요?' },
    { id: 'c', expect: 'hide', text: '요즘은 3000원이던데' },
  ];
  const allNormal = async (items) => items.map(() => ({ alert: false, category: '정상', reason: '', priority: 'normal' }));
  const { rows, mismatches } = await runOwnedPolicyEval(cases, { geminiKey: 'k', ownedBrandEscalationModel: 'gemini-3.5-flash-lite' }, allNormal);
  assert.deepEqual(rows.map((r) => r.got), ['hide', 'keep', 'keep']);
  assert.equal(rows[0].engine, 'keyword-hard-owned');
  assert.deepEqual(mismatches.map((r) => r.id), ['c']);
  assert.equal(rows[2].weak, 'keep');
  assert.equal(rows[2].strong, 'keep');
});

test('eval 대상은 운영 소유채널 스코프와 같은 플래그를 쓴다([소유채널] 정책이 실제로 붙음)', async () => {
  let prompts = [];
  const capture = async (items) => { prompts.push(items); return items.map(() => ({ alert: false, category: '정상', reason: '', priority: 'normal' })); };
  await classifyCommentsHybrid([{ text: '첨봄 진짜' }], EVAL_TARGET, { geminiKey: 'k' }, capture);
  assert.equal(prompts[0][0].ownedChannelBrandHostilityScope, true);
});
