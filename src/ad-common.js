import { kstDateKey } from './schedule.js';

// 광고 어댑터(메타·틱톡·유튜브) 공통 유틸. 각 어댑터는 자기 이름의 얇은 wrapper로 노출하고
// 로직은 여기 단일 소스로 둔다(중복 제거 — 창 판정·원장키·실행여부를 한 곳에서 유지).

// 인지 광고는 어댑터 config의 고정 상품(JD)보다 실제 캠페인 정체성이 우선한다.
// Meta는 campaign_name이 없을 수 있어 소재명(adTitle)을 보조 신호로 사용한다.
// JD복은 별도 최우선 라우팅 계약이므로 파인트 오인보다 먼저 보호한다.
export function awarenessProductName(defaultProductName, campaignName = '', adTitle = '') {
  const fallback = String(defaultProductName || '').trim();
  const identity = `${String(campaignName || '')} ${String(adTitle || '')}`;
  if (/JD복/i.test(`${fallback} ${identity}`)) return fallback;
  return /파인트/i.test(identity) ? 'P' : fallback;
}

// KST 아침 배치 창 판정. prefix = 'META_ADS' | 'TIKTOK_ADS' | 'YOUTUBE_ADS'.
// {prefix}_FORCE=true면 시간 무관 실행(수동), 아니면 KST {prefix}_WINDOW_START(8)~END(11)시.
export function inAdMorningWindow(now = Date.now(), env = process.env, prefix) {
  if (String(env[`${prefix}_FORCE`] || '').toLowerCase() === 'true') return true;
  const start = Number(env[`${prefix}_WINDOW_START`] || 8);
  const end = Number(env[`${prefix}_WINDOW_END`] || 11);
  const kstHour = new Date(now + 9 * 3600 * 1000).getUTCHours();
  return kstHour >= start && kstHour <= end;
}

// 일일 실행 원장 키. scope = 'tiktok-ads' | 'youtube-ads', id = advertiser/customer id.
export function dailyAdRunKey(scope, id, now = Date.now()) {
  return `daily:${scope}:${id}:${kstDateKey(now)}`;
}

// 문맥판정 보류가 있으면 일일 성공키를 쓰지 않는다. 비용 원장은 실행별 키로 남고,
// hasAdRunToday는 false를 유지하므로 같은 아침 창의 다음 웨이크가 자동 재분류한다.
export function adClassificationLedgerKey(scope, dailyKey, stats = {}, now = Date.now(), env = process.env) {
  if (Number(stats.llmDeferredComments || 0) <= 0) return dailyKey;
  return `${scope}-deferred:${env.GITHUB_RUN_ID || now}:${env.GITHUB_RUN_ATTEMPT || '1'}`;
}

// 오늘 이미 성공 실행했는지: cost_usage_ledger에 runKey 존재 여부.
// ⚠️ 조회 실패는 false(fail-open) — 원장 장애로 감시가 안 도는 것보다 재실행이 낫다.
export async function hasAdRunToday(config, runKey, fetchImpl = fetch) {
  if (!config.supabaseUrl || !config.supabaseKey) return false;
  try {
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/cost_usage_ledger?select=run_key&run_key=eq.${encodeURIComponent(runKey)}&limit=1`,
      { headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` } },
    );
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}
