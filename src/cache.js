// 분류 결과 캐시(Supabase comment_classification_cache).
// 목적: 같은 댓글(comment_fingerprint)을 분류기(classifier_hash)가 바뀌지 않은 동안 다시
// LLM에 보내지 않아 Anthropic 호출 수를 줄인다. 부정/정상 판정 모두 캐시한다.
// 원칙: 조회·저장·정리 어느 단계가 실패하든 예외를 삼키고 '캐시 없음'처럼 동작해
//       실시간 분류가 그대로 진행된다(비용 절감보다 댓글 누락 방지 우선).
// negative_comment_alerts fingerprint 중복방지와는 별개 테이블·별개 키다.
import { computeClassifierHash } from './classifier-hash.js';

const RETENTION_DAYS = 90;
const READ_CHUNK = 50; // IN 목록 URL 길이 방어

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export function cacheEnabled(config) {
  return Boolean(config && config.supabaseUrl && config.supabaseKey);
}

// reviewItems: [{ index, fingerprint }]. 반환: Map<index, {alert,category,reason,priority}>(히트만).
// 어떤 오류든 부분 반영 없이 빈 Map으로 폴백한다.
export async function lookupCache(config, reviewItems, classifierHash, fetchImpl = fetch) {
  const hits = new Map();
  if (!cacheEnabled(config) || !classifierHash || !reviewItems.length) return hits;
  try {
    const indexByFp = new Map(reviewItems.map((r) => [r.fingerprint, r.index]));
    const fps = [...indexByFp.keys()];
    for (let i = 0; i < fps.length; i += READ_CHUNK) {
      const chunk = fps.slice(i, i + READ_CHUNK);
      const encoded = chunk.map((v) => `"${v}"`).join(',');
      const url = `${config.supabaseUrl}/rest/v1/comment_classification_cache`
        + '?select=fingerprint,alert,category,reason,priority'
        + `&classifier_hash=eq.${encodeURIComponent(classifierHash)}`
        + `&fingerprint=in.(${encodeURIComponent(encoded)})`;
      const res = await fetchImpl(url, { headers: headers(config) });
      if (!res.ok) return new Map(); // 조회 실패 → 전부 미스 취급(폴백)
      for (const row of await res.json()) {
        const index = indexByFp.get(row.fingerprint);
        if (index != null) {
          hits.set(index, {
            alert: row.alert === true,
            category: row.category || (row.alert ? '부정언급' : '정상댓글'),
            reason: row.alert ? String(row.reason || '') : '',
            priority: row.priority || 'normal',
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
    const rows = entries.map((e) => ({
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
    return res.ok ? rows.length : 0;
  } catch {
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
