// 인지 광고 '아침 배치' 결과 워치독 — 별도 워크플로에서 KST 13/16시(신뢰 시간대)에 실행.
// 기존 heartbeat는 "monitor.yml이 돌았나"만 보므로, monitor는 돌았지만 meta-ads 스텝이
// 창(KST 8~11) 밖이라 스킵돼 배치가 조용히 누락되는 경우(주말 30건 적체 사고)를 못 잡는다.
// → 여기선 결과(증상)를 직접 본다: '아침 창 시작(08:00) 전에 들어온 웹훅 이벤트가
//   워치독 시점(정오 이후)에도 미처리로 남아있으면' 아침 배치가 안 돈 것 → 자가치유 + 경고.
// DB(meta_ad_comment_events)만 조회. 정상이면 조용히 종료(알림 없음).

const HOUR = 3600 * 1000;
function kstDate(now) { return new Date(now + 9 * HOUR).toISOString().slice(0, 10); }
function fmtKst(ms) { return ms == null ? '없음' : new Date(ms + 9 * HOUR).toISOString().slice(0, 16).replace('T', ' ') + ' KST'; }

// 아침 창 시작 순간(오늘 KST windowStart:00). 이 시각 '이전'에 수신된 이벤트는 창 안에 처리됐어야 한다.
export function morningStartInstant(now, windowStart = 8) {
  const hh = String(windowStart).padStart(2, '0');
  return Date.parse(`${kstDate(now)}T${hh}:00:00+09:00`);
}

// events: 미처리(processed_at=null) 웹훅 이벤트들. 창 시작 전 수신분이 남아있으면 backlog(=배치 누락).
export function evaluateBacklog(events, now = Date.now(), windowStart = 8) {
  const cutoff = morningStartInstant(now, windowStart);
  const stale = (events || [])
    .map((e) => Date.parse(e.received_at || ''))
    .filter((t) => Number.isFinite(t) && t < cutoff);
  return { stale: stale.length, oldest: stale.length ? Math.min(...stale) : null, total: (events || []).length };
}

export function buildBacklogMessage(now, res, assigneeOther = '') {
  const owner = String(assigneeOther || '').trim();
  return [
    '⚠️ *인지 광고 아침 배치 미실행 의심*',
    `오늘(${kstDate(now)}) 아침 창(KST 8~11) 이전 수신 웹훅 댓글이 미처리로 남아 있습니다.`,
    `미처리(창 전 수신) ${res.stale}건 · 가장 오래된 수신 ${fmtKst(res.oldest)} · 전체 미처리 ${res.total}건`,
    '자가치유: monitor.yml 강제 실행(META_ADS_FORCE)을 요청했습니다. 반영 안 되면 스케줄/큐를 확인하세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function fetchUnprocessed(env, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!base || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = `${base}/rest/v1/meta_ad_comment_events?select=received_at&processed_at=is.null&order=received_at.asc&limit=500`;
  const res = await fetchImpl(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function dispatchMonitor(env, fetchImpl) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  if (!repo || !token) return false; // 토큰 없으면 자가치유 생략(경고는 계속)
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'ncm-meta-watchdog' },
    body: JSON.stringify({ ref }),
  });
  return res.ok;
}

async function postSlack(env, text, fetchImpl) {
  const token = String(env.SLACK_BOT_TOKEN || '').trim();
  const channel = String(env.SLACK_CHANNEL_ID || '').trim();
  if (!token || !channel) throw new Error('Missing Slack configuration');
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

export async function runMetaBatchWatchdog(env = process.env, now = Date.now(), fetchImpl = fetch) {
  const windowStart = Number(env.META_ADS_WINDOW_START || 8);
  const events = await fetchUnprocessed(env, fetchImpl);
  const res = evaluateBacklog(events, now, windowStart);
  if (res.stale === 0) {
    console.log(`[meta-watchdog] OK — 창 전 미처리 없음(전체 미처리 ${res.total})`);
    return { warned: false, dispatched: false };
  }
  const dispatched = await dispatchMonitor(env, fetchImpl).catch(() => false);
  await postSlack(env, buildBacklogMessage(now, res, env.SLACK_ASSIGNEE_OTHER), fetchImpl);
  console.error(`[meta-watchdog] STALE — 창 전 미처리 ${res.stale}건(가장 오래됨 ${fmtKst(res.oldest)}) → dispatch=${dispatched}, 경고 발송`);
  return { warned: true, dispatched };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runMetaBatchWatchdog().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
