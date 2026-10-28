// 분류 결과 캐시(Supabase comment_classification_cache).
// 목적: 같은 댓글(comment_fingerprint)을 분류기(classifier_hash)가 바뀌지 않은 동안 다시
// LLM에 보내지 않아 Anthropic 호출 수를 줄인다. 부정/정상 판정 모두 캐시한다.
// 원칙: 조회·저장·정리 어느 단계가 실패하든 예외를 삼키고 '캐시 없음'처럼 동작해
//       실시간 분류가 그대로 진행된다(비용 절감보다 댓글 누락 방지 우선).
// negative_comment_alerts fingerprint 중복방지와는 별개 테이블·별개 키다.
import { createHash } from 'node:crypto';
import { computeClassifierHash } from './classifier-hash.js';
import { commentFingerprint } from './dedup.js';

const RETENTION_DAYS = 90;
const READ_CHUNK = 50; // IN 목록 URL 길이 방어

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export function cacheEnabled(config) {
  return Boolean(config && config.supabaseUrl && config.supabaseKey);
}

// 알림 dedup 지문은 comment_id 기준으로 고정해야 댓글당 알림이 하나만 나간다.
// 반면 분류 캐시는 댓글 본문이 편집되면 반드시 무효화돼야 하므로 텍스트 해시를 더한다.
// cache-v2 접두어는 기존 텍스트 비민감 캐시와 완전히 분리하는 버전 경계다.
export function classificationCacheFingerprint(target, comment) {
  const alertFingerprint = commentFingerprint(target, comment);
  const textHash = createHash('sha256').update(String(comment?.text || '')).digest('hex');
  return createHash('sha256').update(`cache-v2|${alertFingerprint}|text:${textHash}`).digest('hex');
}

// reviewItems: [{ index, fingerprint }]. 반환: Map<index, {alert,category,reason,priority}>(히트만).
// 어떤 오류든 부분 반영 없이 빈 Map으로 폴백한다.
//
// 이월(carry-forward, 2026-10-12 결정 '새 기준은 새 댓글에만'): 현재 classifier_hash 행이 없으면
// 이전 해시의 가장 최근 판정을 그대로 쓴다. 주간 예시 갱신·분류기 코드 변경으로 해시가 바뀔 때마다
// 이미 판정한 옛 댓글 ~750건을 재판정하면, 비결정 LLM 탓에 ~20%가 뒤집혀 며칠 공개돼 있던 댓글이
// 월요일에 일괄 숨김(10-05 164건·10-12 130건)되고 Gemini 한도도 터졌다. 이월 히트는 carriedFromHash로
// 표시돼 호출부가 현재 해시로 다시 저장한다(90일 정리에 사라지지 않게). 본문이 편집되면 지문이 달라
// 이월되지 않고 새로 판정한다. config.classificationCacheCarryForward === false면 예전 동작(현재 해시만).
export async function lookupCache(config, reviewItems, classifierHash, fetchImpl = fetch) {
  const hits = new Map();
  if (!cacheEnabled(config) || !classifierHash || !reviewItems.length) return hits;
  try {
    const indexByFp = new Map(reviewItems.map((r) => [r.fingerprint, r.index]));
    const fps = [...indexByFp.keys()];
    for (let i = 0; i < fps.length; i += READ_CHUNK) {
      const chunk = fps.slice(i, i + READ_CHUNK);
      const encoded = chunk.map((v) => `"${v}"`).join(',');
      const carryForward = config.classificationCacheCarryForward !== false;
      const url = `${config.supabaseUrl}/rest/v1/comment_classification_cache`
        + '?select=fingerprint,classifier_hash,alert,category,reason,priority,created_at'
        + (carryForward ? '' : `&classifier_hash=eq.${encodeURIComponent(classifierHash)}`)
        + `&fingerprint=in.(${encodeURIComponent(encoded)})`
        + '&order=created_at.desc';
      const res = await fetchImpl(url, { headers: headers(config) });
      if (!res.ok) return new Map(); // 조회 실패 → 전부 미스 취급(폴백)
      // 지문별로 현재 해시 행 우선, 없으면 가장 최근(created_at desc 첫 행) 이전 해시 행.
      const chosen = new Map();
      for (const row of await res.json()) {
        const prev = chosen.get(row.fingerprint);
        if (!prev || (prev.classifier_hash !== classifierHash && row.classifier_hash === classifierHash)) {
          chosen.set(row.fingerprint, row);
        }
      }
      for (const row of chosen.values()) {
        const index = indexByFp.get(row.fingerprint);
        if (index != null) {
          hits.set(index, {
            alert: row.alert === true,
            category: row.category || (row.alert ? '부정언급' : '정상댓글'),
            reason: row.alert ? String(row.reason || '') : '',
            priority: row.priority || 'normal',
            ...(row.classifier_hash !== classifierHash ? { carriedFromHash: String(row.classifier_hash || '') } : {}),
          });
        }
      }
    }
  } catch {
    return new Map();
  }
  return hits;
}

// entries: [{ fingerprint, result:{alert,category,reason,priority} }]. best-effort 저장.
export async function storeCache(config, entries, classifierHash, fetchImpl = fetch) {
  if (!cacheEnabled(config) || !classifierHash || !entries.length) return 0;
  try {
    // 2026-10-28 재발방지: 같은 fingerprint가 한 배열에 두 번 들어가면 ON CONFLICT DO UPDATE 전체가
    // 거부된다(cardinality_violation → 500). 소유채널 강한 모델 승격 댓글은 1차 결과와 승격 결과가
    // 둘 다 쌓이고, 같은 링크의 미러링 대상은 같은 댓글을 두 번 낸다. 나중 결과(승격)를 남긴다.
    const byFingerprint = new Map();
    for (const entry of entries) if (entry?.fingerprint) byFingerprint.set(entry.fingerprint, entry);
    const rows = [...byFingerprint.values()].map((e) => ({
      fingerprint: e.fingerprint,
      classifier_hash: classifierHash,
      alert: e.result.alert === true,
      category: e.result.category || (e.result.alert ? '부정언급' : '정상댓글'),
      reason: e.result.alert ? String(e.result.reason || '') : '',
      priority: e.result.priority || 'normal',
    }));
    const res = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/comment_classification_cache?on_conflict=fingerprint,classifier_hash`,
      {
        method: 'POST',
        headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      },
    );
    if (!res.ok) {
      // best-effort는 유지하되 조용히 삼키지 않는다 — 저장이 계속 실패하면 매 회차 같은 댓글을 다시 LLM에 보낸다.
      const detail = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      console.error(`[cache] 분류 캐시 저장 실패 ${res.status ?? ''} rows=${rows.length}${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
      return 0;
    }
    return rows.length;
  } catch (error) {
    console.error(`[cache] 분류 캐시 저장 예외: ${String(error?.message || error).slice(0, 200)}`);
    return 0;
  }
}

// 90일 초과 캐시 정리(best-effort). DML이라 서비스키로 실행 가능(DDL 아님).
export async function purgeCache(config, fetchImpl = fetch, now = Date.now()) {
  if (!cacheEnabled(config)) return 0;
  try {
    const cutoff = new Date(now - RETENTION_DAYS * 864e5).toISOString();
    const res = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/comment_classification_cache?created_at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE', headers: headers(config, { Prefer: 'return=minimal' }) },
    );
    return res.ok ? 1 : 0;
  } catch {
    return 0;
  }
}

export { computeClassifierHash, RETENTION_DAYS };
