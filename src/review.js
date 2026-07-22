// 사람 검토(Slack [무시] → 오탐) 피드백. negative_comment_alerts에 기록·조회.
// 원칙:
//  - 행 식별은 (slack_channel_id + slack_ts) 우선, 없으면 alert fingerprint. 댓글 원문은 쓰지 않는다.
//  - 사람의 false_positive 판정은 classifier_hash가 바뀌어도 우선 적용(지문 기준, 해시 무관).
//  - 조회/기록 실패는 예외를 삼켜 분류·버튼 UX를 막지 않는다(누락 방지 > 비용).
//  - negative_comment_alerts fingerprint 중복방지(dedup)는 그대로 유지된다.

const FP = 'false_positive';

// #5 오탐 사유 선택지(자동 파인튜닝/원문 누적 없이 유형만 집계).
export const FALSE_POSITIVE_REASONS = [
  { value: 'unrelated', label: '제품 무관' },
  { value: 'positive_neutral', label: '긍정/중립' },
  { value: 'joke_meme', label: '농담/밈' },
  { value: 'insult_other', label: '타인 대상 욕설' },
  { value: 'competitor_neutral', label: '경쟁제품 중립 비교' },
  { value: 'other', label: '기타' },
];

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export function reviewEnabled(config) {
  return Boolean(config && config.supabaseUrl && config.supabaseKey);
}

// 오탐으로 표시된 지문 Set. best-effort(실패=빈 Set → 억제 안 함; 재알림은 dedup가 막음).
export async function loadFalsePositives(config, fingerprints, fetchImpl = fetch) {
  const set = new Set();
  const unique = [...new Set((fingerprints || []).filter(Boolean))];
  if (!reviewEnabled(config) || !unique.length) return set;
  try {
    const CHUNK = 50;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const enc = unique.slice(i, i + CHUNK).map((v) => `"${v}"`).join(',');
      const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts`
        + `?select=fingerprint&review_decision=eq.${FP}&fingerprint=in.(${encodeURIComponent(enc)})`;
      const res = await fetchImpl(url, { headers: headers(config) });
      if (!res.ok) return new Set();
      for (const r of await res.json()) set.add(r.fingerprint);
    }
  } catch {
    return new Set();
  }
  return set;
}

// [무시] → 오탐 기록. reviewedBy/reason/classifierHash는 주어진 것만 갱신(빈 값으로 덮어쓰지 않음).
export async function recordFalsePositive(config, params, fetchImpl = fetch) {
  if (!reviewEnabled(config)) return false;
  const { slackChannelId, slackTs, fingerprint, reviewedBy, reason, classifierHash, now = Date.now() } = params;
  let filter;
  if (slackChannelId && slackTs) {
    filter = `slack_channel_id=eq.${encodeURIComponent(slackChannelId)}&slack_ts=eq.${encodeURIComponent(slackTs)}`;
  } else if (fingerprint) {
    filter = `fingerprint=eq.${encodeURIComponent(fingerprint)}`;
  } else {
    return false;
  }
  const patch = { review_decision: FP, reviewed_at: new Date(now).toISOString() };
  if (reviewedBy) patch.reviewed_by = reviewedBy;
  if (reason != null && reason !== '') patch.false_positive_reason = reason;
  if (classifierHash) patch.classifier_hash = classifierHash;
  try {
    const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/negative_comment_alerts?${filter}`, {
      method: 'PATCH',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// #8 classifier_hash별 오탐률 = false_positive 수 / 전체 알림 수. best-effort, 페이지네이션.
export async function falsePositiveStats(config, fetchImpl = fetch, { maxRows = 5000 } = {}) {
  if (!reviewEnabled(config)) return null;
  try {
    const byHash = {};
    for (let off = 0; off < maxRows; off += 1000) {
      const res = await fetchImpl(
        `${config.supabaseUrl}/rest/v1/negative_comment_alerts?select=classifier_hash,review_decision&order=alerted_at.desc&offset=${off}&limit=1000`,
        { headers: headers(config) },
      );
      if (!res.ok) return null;
      const rows = await res.json();
      for (const r of rows) {
        const h = r.classifier_hash || 'unknown';
        byHash[h] = byHash[h] || { alerts: 0, falsePositives: 0 };
        byHash[h].alerts += 1;
        if (r.review_decision === FP) byHash[h].falsePositives += 1;
      }
      if (rows.length < 1000) break;
    }
    for (const h of Object.keys(byHash)) {
      const s = byHash[h];
      s.rate = s.alerts ? Number((s.falsePositives / s.alerts).toFixed(3)) : 0;
    }
    return byHash;
  } catch {
    return null;
  }
}
