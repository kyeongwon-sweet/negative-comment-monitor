// 모니터 헬스체크(heartbeat).
//  - 매 실행: last_run_at 갱신. 09:10 KST 이후 정상 완료 실행이면 그날 '일일 점검 완료'로 기록.
//  - 마감(기본 13:00 KST)까지 오늘 일일 점검이 없으면 Slack에 경고(하루 1회).
//    → GitHub 크론이 하루 종일 안 돌거나 수집이 계속 실패해 '조용히' 누락되는 걸 드러낸다.
//  - HEARTBEAT_URL이 설정돼 있으면 정상 일일 점검마다 ping(외부 dead-man's-switch용).
// 모든 경로는 fail-safe: 테이블 미존재/Supabase 오류가 모니터링을 절대 중단시키지 않는다.
import { kstDateKey } from './schedule.js';

const HOUR = 3600 * 1000;
export const DEFAULT_STALE_DEADLINE_MIN = 13 * 60; // 13:00 KST

function kstMinute(now) {
  const kst = new Date(now + 9 * HOUR);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

function sbHeaders(config) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    'Content-Type': 'application/json',
  };
}

async function readHeartbeat(config, fetchImpl) {
  const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/monitor_heartbeat?id=eq.1&select=*`, {
    headers: sbHeaders(config),
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function upsertHeartbeat(config, patch, fetchImpl) {
  const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/monitor_heartbeat?on_conflict=id`, {
    method: 'POST',
    headers: { ...sbHeaders(config), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ id: 1, ...patch }]),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function pingExternal(url, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST' });
  if (!res.ok) throw new Error(`heartbeat ping ${res.status}`);
}

// 매 실행 종료 시 호출. dailyPassRan=true면 그날 정규 점검을 정상 수행한 것으로 기록.
export async function updateHeartbeat(config, { dailyPassRan }, now = Date.now(), fetchImpl = fetch) {
  if (!config.supabaseUrl || !config.supabaseKey || config.dryRun) return;
  const iso = new Date(now).toISOString();
  const patch = { last_run_at: iso, updated_at: iso };
  if (dailyPassRan) {
    patch.last_daily_pass_at = iso;
    patch.last_daily_pass_kst_date = kstDateKey(now);
  }
  try {
    await upsertHeartbeat(config, patch, fetchImpl);
  } catch (error) {
    console.error('[heartbeat] 기록 실패(무시):', error.message);
  }
  if (dailyPassRan && config.heartbeatUrl) {
    try {
      await pingExternal(config.heartbeatUrl, fetchImpl);
    } catch (error) {
      console.error('[heartbeat] 외부 ping 실패(무시):', error.message);
    }
  }
}

export function buildStaleMessage(row, now, assigneeOther = '') {
  const kstStr = new Date(now + 9 * HOUR).toISOString().slice(0, 16).replace('T', ' ');
  const last = row?.last_daily_pass_kst_date || '기록 없음';
  const owner = String(assigneeOther || '').trim();
  return [
    '⚠️ *부정댓글 모니터링 — 오늘 일일 점검 미완료*',
    `마지막 정상 점검일(KST): ${last}`,
    `현재 ${kstStr} KST가 지났는데 오늘(${kstDateKey(now)}) 일일 수집이 완료되지 않았습니다.`,
    'GitHub Actions 스케줄 실행/실패를 확인하세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function postSlack(config, text, fetchImpl) {
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text }),
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

// 마감(13:00 KST 등)까지 오늘 일일 점검이 없으면 경고(하루 1회). 반환: {warned, reason} | null.
export async function checkAndWarnStale(config, now = Date.now(), fetchImpl = fetch) {
  if (!config.supabaseUrl || !config.supabaseKey || config.dryRun) return null;
  const deadline = Number.isFinite(config.heartbeatStaleDeadlineMin)
    ? config.heartbeatStaleDeadlineMin
    : DEFAULT_STALE_DEADLINE_MIN;
  if (kstMinute(now) < deadline) return null; // 아직 마감 전 → 정상 대기
  let row;
  try {
    row = await readHeartbeat(config, fetchImpl);
  } catch (error) {
    console.error('[heartbeat] 조회 실패(무시):', error.message);
    return null;
  }
  if (!row) return null;
  const today = kstDateKey(now);
  if (row.last_daily_pass_kst_date === today) return null; // 오늘 점검 완료 → 정상
  if (row.last_warning_kst_date === today) return { warned: false, reason: 'already-warned' }; // 오늘 이미 경고
  if (!config.slackBotToken || !config.slackChannelId) return null;
  try {
    await postSlack(config, buildStaleMessage(row, now, config.slackAssignees?.other), fetchImpl);
    await upsertHeartbeat(config, { last_warning_kst_date: today }, fetchImpl);
    return { warned: true, reason: 'stale', lastPass: row.last_daily_pass_kst_date || null };
  } catch (error) {
    console.error('[heartbeat] 경고 발송 실패(무시):', error.message);
    return null;
  }
}
