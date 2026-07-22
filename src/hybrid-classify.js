import { classifyNegativeComment, needsContextualReview } from './classify.js';
import { classifyCommentsLLM } from './llm.js';
import { commentFingerprint } from './dedup.js';
import { cacheEnabled, computeClassifierHash, lookupCache, storeCache } from './cache.js';

// 키워드(무료·즉시) + Anthropic(문맥 후보만) 하이브리드 분류.
// 문맥 후보는 먼저 캐시(comment_fingerprint + classifier_hash)를 조회해 히트분은 LLM 호출을
// 건너뛴다. 캐시 관련 어떤 실패든 실시간 LLM 분류로 폴백한다(누락 방지 우선).
export async function classifyCommentsHybrid(comments, target, config, llmClassifier = classifyCommentsLLM, stats = null) {
  const keywordResults = comments.map((comment) => classifyNegativeComment(comment, target));
  const out = keywordResults.map((risk) => ({ ...risk, engine: 'keyword' }));

  const reviewIndexes = [];
  for (let index = 0; index < comments.length; index += 1) {
    if (needsContextualReview(comments[index], target)) reviewIndexes.push(index);
  }
  if (!reviewIndexes.length || !config.anthropicKey) return out;

  // 캐시 조회(문맥 후보만). 실패 시 classifierHash=null → 이후 저장도 건너뛰고 전량 LLM.
  let classifierHash = null;
  let cacheHits = new Map(); // reviewIndex -> result
  const fingerprintByIndex = new Map();
  if (cacheEnabled(config)) {
    try {
      classifierHash = computeClassifierHash(config);
      const reviewItems = reviewIndexes.map((index) => {
        const fingerprint = commentFingerprint(target, comments[index]);
        fingerprintByIndex.set(index, fingerprint);
        return { index, fingerprint };
      });
      cacheHits = await lookupCache(config, reviewItems, classifierHash);
    } catch {
      classifierHash = null;
      cacheHits = new Map();
    }
  }

  // 캐시 미스만 LLM에 보낸다.
  const missIndexes = reviewIndexes.filter((index) => !cacheHits.has(index));
  const missComments = missIndexes.map((index) => comments[index]);
  if (stats) {
    stats.cacheHits = (stats.cacheHits || 0) + cacheHits.size;
    stats.cacheMiss = (stats.cacheMiss || 0) + missIndexes.length;
  }
  const reviewed = missComments.length ? await llmClassifier(missComments, config, undefined, stats) : [];

  // 캐시 히트 적용(이전 LLM 판정 재사용).
  for (const index of reviewIndexes) {
    if (cacheHits.has(index)) out[index] = { ...cacheHits.get(index), entity: { matched: true }, engine: 'llm-cache' };
  }

  // LLM 결과 적용 + 새 판정 저장(best-effort). reviewed=null(LLM 실패)이면 미스분은 키워드 판정 유지.
  if (reviewed) {
    const toStore = [];
    for (let position = 0; position < missIndexes.length; position += 1) {
      const index = missIndexes[position];
      const result = reviewed[position];
      if (result) {
        out[index] = { ...result, entity: { matched: true }, engine: 'llm' };
        if (classifierHash) toStore.push({ fingerprint: fingerprintByIndex.get(index), result });
      }
    }
    if (classifierHash && toStore.length) await storeCache(config, toStore, classifierHash);
  }
  return out;
}
