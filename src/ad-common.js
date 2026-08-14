import { kstDateKey } from './schedule.js';

// 광고 어댑터(메타·틱톡·유튜브) 공통 유틸. 각 어댑터는 자기 이름의 얇은 wrapper로 노출하고
// 로직은 여기 단일 소스로 둔다(중복 제거 — 창 판정·원장키·실행여부를 한 곳에서 유지).

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
