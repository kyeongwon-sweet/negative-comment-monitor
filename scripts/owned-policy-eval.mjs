// 소유 YouTube 채널 사람 판정(golden set)을 실제 운영 분류 경로에 그대로 통과시켜 맞는지 본다.
// 경로 = classifyCommentsHybrid(1차 약한 모델 → 소유 스코프 강한 모델 2차 → 하드넷) → 소유 게이트.
// 프롬프트·하드넷·모델을 바꾸기 전후에 돌려 '사람이 숨긴 것을 놓치거나 둔 것을 숨기는지' 확인한다.
// 공개 레포라 로그에는 케이스 id·판정·엔진만 남기고 댓글 본문은 찍지 않는다.
// Supabase를 넘기지 않는다: 운영 분류 캐시(이월 포함)가 끼면 프롬프트가 아니라 옛 판정을 재게 된다.
import { readFileSync } from 'node:fs';
import { classifyCommentsHybrid } from '../src/hybrid-classify.js';
import { classifyCommentsLLM } from '../src/llm.js';
import { suppressLowConfidenceOwnerRisks } from '../src/youtube-owner-risk.js';

export const EVAL_TARGET = Object.freeze({
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=owned-policy-eval',
  postKey: 'yt:owned-policy-eval',
  brandName: '라라스윗',
  channelCategory: '소유 YouTube',
  ownedChannelBrandHostilityScope: true,
  fullContextReview: true,
});

export function loadGoldenCases(path = new URL('../test/fixtures/owned-channel-policy-golden.json', import.meta.url)) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw?.cases) ? raw.cases : [];
}

export function evalConfig(env = process.env) {
  return {
    llmProvider: 'gemini',
    geminiKey: String(env.GEMINI_API_KEY || '').trim(),
    geminiModel: String(env.GEMINI_MODEL || 'gemini-3.1-flash-lite').trim(),
    ownedBrandEscalationModel: String(env.OWNED_BRAND_ESCALATION_MODEL || 'gemini-3.5-flash-lite').trim(),
    geminiRequestIntervalMs: 1500,
  };
}

function verdict(result) {
  if (!result) return 'none';
  return result.alert === true ? 'hide' : 'keep';
}

export async function runOwnedPolicyEval(cases, config, classifier = classifyCommentsLLM) {
  const comments = cases.map((item) => ({ text: item.text }));
  const stats = {};
  const risks = await classifyCommentsHybrid(comments, EVAL_TARGET, config, classifier, stats);
  const final = suppressLowConfidenceOwnerRisks(EVAL_TARGET, comments, risks);
  // 단계별 진단(어느 모델이 놓쳤는지). 운영 판정은 위 final이다.
  // 운영처럼 스코프 플래그를 붙여야 [소유채널] 정책이 프롬프트에 들어간다.
  const scoped = comments.map((comment) => ({ ...comment, ownedChannelBrandHostilityScope: true }));
  const weak = await classifier(scoped, { ...config, ownedBrandEscalationModel: '' }) || [];
  const strong = config.ownedBrandEscalationModel
    ? await classifier(scoped, { ...config, geminiModel: config.ownedBrandEscalationModel }) || []
    : [];
  const rows = cases.map((item, index) => ({
    id: item.id,
    expect: item.expect,
    got: verdict(final[index]),
    engine: final[index]?.engine || '',
    category: final[index]?.category || '',
    weak: verdict(weak[index]),
    strong: verdict(strong[index]),
  }));
  const mismatches = rows.filter((row) => row.got !== row.expect);
  return { rows, mismatches, stats };
}

async function main() {
  const config = evalConfig();
  if (!config.geminiKey) {
    console.error('[owned-policy-eval] GEMINI_API_KEY 없음');
    process.exit(2);
  }
  const cases = loadGoldenCases();
  const { rows, mismatches, stats } = await runOwnedPolicyEval(cases, config);
  console.log(`[owned-policy-eval] weak=${config.geminiModel} strong=${config.ownedBrandEscalationModel} cases=${rows.length}`);
  for (const row of rows) {
    const mark = row.got === row.expect ? 'ok  ' : 'MISS';
    console.log(`${mark} ${row.id} expect=${row.expect} got=${row.got} engine=${row.engine} category=${row.category} weak=${row.weak} strong=${row.strong}`);
  }
  console.log(`[owned-policy-eval] match=${rows.length - mismatches.length}/${rows.length} escalationChecked=${stats.ownedEscalationChecked || 0} escalated=${stats.ownedEscalatedAlerts || 0} escalationSkipped=${stats.ownedEscalationSkipped || 0}`);
  if (mismatches.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  await main();
}
