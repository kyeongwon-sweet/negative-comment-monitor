import { classifyNegativeComment, needsContextualReview } from './classify.js';
import { classifyCommentsLLM, hasConfiguredLlmProvider } from './llm.js';
import { commentFingerprint } from './dedup.js';
import {
  cacheEnabled,
  classificationCacheFingerprint,
  computeClassifierHash,
  lookupCache,
  storeCache,
} from './cache.js';
import { loadFalsePositives } from './review.js';
import { isAdCommentSource } from './routing.js';

// 사람이 오탐(false_positive)으로 표시한 지문의 강제 정상 결과(분류기 해시와 무관하게 최우선).
function humanFalsePositiveResult() {
  return { alert: false, category: '정상댓글', priority: 'none', entity: { matched: true }, engine: 'human-fp', reason: '사람 오탐 판정(false_positive)' };
}

const LLM_BATCH = 25; // 실행 전체 문맥 후보를 25개 단위로 통합해 LLM 호출 수를 줄인다.

// 한 게시물: 키워드 분류 + 문맥 후보 판별 + 캐시 조회. LLM이 필요한 캐시 미스만 pending으로 돌려준다.
// 캐시 관련 어떤 실패든 classifierHash=null로 두고 실시간 분류로 진행(누락 방지 우선).
async function prepareLocal(comments, target, config, stats, fetchImpl) {
  const out = comments.map((comment) => ({ ...classifyNegativeComment(comment, target), engine: 'keyword' }));
  const reviewIndexes = [];
  // 광고 지면(메타·틱톡·유튜브)은 '모든 댓글이 그 제품 얘기'다. 브랜드명 미언급·신종 표현(예: "수돗물 향")도
  // 놓치지 않게 키워드 게이트를 건너뛰고 전 댓글을 LLM 문맥 판정으로 보낸다(볼륨 적음, 리콜 우선).
  const reviewAll = isAdCommentSource(target)
    || target?.fullContextReview === true
    || target?.ownedChannelBrandHostilityScope === true;
  for (let index = 0; index < comments.length; index += 1) {
    if (reviewAll || needsContextualReview(comments[index], target)) reviewIndexes.push(index);
  }
  if (!reviewIndexes.length) return { out, pending: [], classifierHash: null };
  if (!hasConfiguredLlmProvider(config)) {
    if (stats) {
      stats.keywordFallback = true;
      stats.keywordFallbackBatches = (stats.keywordFallbackBatches || 0) + 1;
      stats.keywordFallbackComments = (stats.keywordFallbackComments || 0) + reviewIndexes.length;
      stats.missingKey = true;
      stats.lastFailureCode = 'missing_llm_key';
      stats.lastFailureKind = 'persistent';
      stats.persistentFailures = (stats.persistentFailures || 0) + 1;
    }
    return { out, pending: [], classifierHash: null };
  }

  let classifierHash = null;
  let cacheHits = new Map();
  const cacheFingerprintByIndex = new Map();
  const alertFingerprintByIndex = new Map();
  if (cacheEnabled(config)) {
    try {
      classifierHash = computeClassifierHash(config);
      const reviewItems = reviewIndexes.map((index) => {
        const fingerprint = classificationCacheFingerprint(target, comments[index]);
        cacheFingerprintByIndex.set(index, fingerprint);
        alertFingerprintByIndex.set(index, commentFingerprint(target, comments[index]));
        return { index, fingerprint };
      });
      cacheHits = target?.bypassClassificationCache === true
        ? new Map()
        : await lookupCache(config, reviewItems, classifierHash, fetchImpl);
    } catch {
      classifierHash = null;
      cacheHits = new Map();
    }
  }
  for (const index of reviewIndexes) {
    if (cacheHits.has(index)) out[index] = { ...cacheHits.get(index), entity: { matched: true }, engine: 'llm-cache' };
  }
  const missIndexes = reviewIndexes.filter((index) => !cacheHits.has(index));
  if (stats) {
    stats.cacheHits = (stats.cacheHits || 0) + cacheHits.size;
    stats.cacheMiss = (stats.cacheMiss || 0) + missIndexes.length;
  }
  const pending = missIndexes.map((index) => ({
    index,
    comment: comments[index],
    cacheFingerprint: cacheFingerprintByIndex.get(index) || null,
    alertFingerprint: alertFingerprintByIndex.get(index) || commentFingerprint(target, comments[index]),
  }));
  return { out, pending, classifierHash };
}

// 여러 게시물을 한 번에 분류. 문맥 후보(캐시 미스)를 실행 전체에서 25개 단위로 통합해 LLM에 보낸다.
// 반환: entries와 같은 순서·길이의 결과 배열들(각 out[idx]는 해당 게시물 댓글에 정확히 귀속).
// 어떤 LLM/캐시 실패(호출 실패·부분 응답 누락·JSON 파싱 실패)도 키워드 안전경로로 폴백한다.
export async function classifyTargetsBatched(entries, config, llmClassifier = classifyCommentsLLM, stats = null, fetchImpl = fetch) {
  const prepared = [];
  for (const entry of entries) {
    try {
      prepared.push(await prepareLocal(entry.comments, entry.target, config, stats, fetchImpl));
    } catch {
      // 준비 단계 실패는 그 게시물만 키워드로 폴백(전체 중단 없음).
      const safe = Array.isArray(entry.comments) ? entry.comments : [];
      prepared.push({ out: safe.map((comment) => ({ ...classifyNegativeComment(comment, entry.target), engine: 'keyword' })), pending: [], classifierHash: null });
    }
  }

  // 사람 오탐(false_positive) 지문은 분류기 해시와 무관하게 정상으로 강제(#3). 키워드 알림·LLM 후보
  // 모두 대상. 한 번만 조회(실행 전체), 실패 시 억제 안 함(재알림은 dedup가 막음).
  const kwAlertRefs = [];   // 키워드 단계 알림 위치
  const pendingRefs = [];   // LLM 후보(캐시 미스)
  for (let e = 0; e < prepared.length; e += 1) {
    for (const p of prepared[e].pending) pendingRefs.push({
      entry: e,
      index: p.index,
      comment: p.comment,
      cacheFingerprint: p.cacheFingerprint,
      alertFingerprint: p.alertFingerprint,
    });
    prepared[e].out.forEach((risk, index) => {
      if (risk.alert) kwAlertRefs.push({
        entry: e,
        index,
        alertFingerprint: commentFingerprint(entries[e].target, entries[e].comments[index]),
      });
    });
  }
  let fpSet = new Set();
  if (cacheEnabled(config)) {
    const fps = [...kwAlertRefs, ...pendingRefs].map((r) => r.alertFingerprint).filter(Boolean);
    if (fps.length) {
      try { fpSet = await loadFalsePositives(config, fps, fetchImpl); } catch { fpSet = new Set(); }
    }
  }
  for (const ref of kwAlertRefs) {
    if (ref.alertFingerprint && fpSet.has(ref.alertFingerprint)) prepared[ref.entry].out[ref.index] = humanFalsePositiveResult();
  }

  // 실행 전체 pending 평탄화 — 원 게시물(entry)·댓글 인덱스 귀속 보존. FP 지문은 LLM 제외(정상 강제).
  const flat = [];
  for (const ref of pendingRefs) {
    if (ref.alertFingerprint && fpSet.has(ref.alertFingerprint)) { prepared[ref.entry].out[ref.index] = humanFalsePositiveResult(); continue; }
    flat.push(ref);
  }
  const classifierHash = prepared.find((p) => p.classifierHash)?.classifierHash || null;

  function recordKeywordFallback(count) {
    if (!stats || !count) return;
    stats.keywordFallback = true;
    stats.keywordFallbackBatches = (stats.keywordFallbackBatches || 0) + 1;
    stats.keywordFallbackComments = (stats.keywordFallbackComments || 0) + count;
  }

  const toStore = [];
  for (let start = 0; start < flat.length; start += LLM_BATCH) {
    const slice = flat.slice(start, start + LLM_BATCH);
    // 크레딧·키·권한·잘못된 요청 같은 영구 오류는 같은 회차에서 다시 시도해도 회복되지 않는다.
    // 첫 실패 뒤 남은 배치는 호출하지 않고 폴백 수만 정확히 기록한다(400×N 요청 폭주 방지).
    if (stats?.llmCircuitOpen === true) {
      recordKeywordFallback(slice.length);
      continue;
    }
    let reviewed = null;
    try {
      reviewed = await llmClassifier(slice.map((s) => ({
        ...s.comment,
        ownedChannelBrandHostilityScope:
          entries[s.entry]?.target?.ownedChannelBrandHostilityScope === true,
      })), config, undefined, stats);
    } catch {
      reviewed = null; // 호출 실패 → 이 배치는 키워드 유지
    }
    if (!reviewed) {
      recordKeywordFallback(slice.length);
      continue; // JSON 파싱 실패 등으로 null → 키워드 폴백
    }
    for (let k = 0; k < slice.length; k += 1) {
      const result = reviewed[k];
      if (!result) continue; // 일부 응답 누락/부족 → 해당 항목만 키워드 유지
      const { entry, index, cacheFingerprint } = slice[k];
      prepared[entry].out[index] = { ...result, entity: { matched: true }, engine: 'llm' };
      if (classifierHash && cacheFingerprint) toStore.push({ fingerprint: cacheFingerprint, result });
    }
  }
  if (classifierHash && toStore.length) await storeCache(config, toStore, classifierHash, fetchImpl);

  return prepared.map((p) => p.out);
}

// 단일 게시물 편의 래퍼(기존 호출부·테스트 호환). 내부적으로 배치 경로를 재사용.
export async function classifyCommentsHybrid(comments, target, config, llmClassifier = classifyCommentsLLM, stats = null) {
  const [result] = await classifyTargetsBatched([{ comments, target }], config, llmClassifier, stats);
  return result || comments.map((comment) => ({ ...classifyNegativeComment(comment, target), engine: 'keyword' }));
}
