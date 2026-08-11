// 타겟 동기화 결과 워치독 — 별도 워크플로에서 신뢰 시간대(KST 13/22)에 실행.
// 봇은 GAS 시트 타겟만 감시하므로, DB(대시보드)에 신규글이 추가돼도 시트 동기화(pullFromDB)가
// 지연/실패하거나 GAS 대상 상한·엔드포인트가 어긋나면 봇이 그 글을 못 본다(실측: 신규 98건 미감시 사고).
// → '봇이 감시하는 카테고리의 신규 활성글(댓글 있음)이 유예시간 지나도 봇 GAS 타겟에 없으면' 경고.
// DB + GAS만 조회(Apify/Anthropic 없음). 정상이면 조용히 종료.
import { fetchTargets } from './gas.js';
import { extractPostKey } from './delta.js';

const HOUR = 3600 * 1000;
const norm = (s) => String(s || '').replace(/\s+/g, ''); // 채널유형 공백차이 흡수(정규화)
function kstDate(now) { return new Date(now + 9 * HOUR).toISOString().slice(0, 10); }

// posts: DB 최근 활성글, commentSet: 댓글>0 post_id 집합, targetKeys: GAS 타겟 키 집합,
// monitoredCats: GAS 타겟에 존재하는(=봇이 감시하는) 정규화 카테고리 집합.
export function evaluateTargetSyncGap({ posts, commentSet, targetKeys, monitoredCats }, now = Date.now(), graceHours = 4) {
  const cutoff = now - graceHours * HOUR;
  return (posts || []).filter((p) => {
    const created = Date.parse(p.created_at || '');
    if (!Number.isFinite(created) || created >= cutoff) return false; // 유예 안 지남 → 정상 동기화 대기
    if (!commentSet.has(p.id)) return false;                          // 댓글 없음 → 감시 불필요
    if (!monitoredCats.has(norm(p.channel_type))) return false;       // 봇 미감시 카테고리(무상시딩 등) 제외
    return !targetKeys.has(extractPostKey(p.url));                    // GAS 타겟에 없음 = 갭
  });
}

export function buildGapMessage(now, gaps, assigneeOther = '') {
  const byCat = {};
  for (const g of gaps) { const c = g.channel_type || '?'; byCat[c] = (byCat[c] || 0) + 1; }
  const owner = String(assigneeOther || '').trim();
  return [
    '⚠️ *신규글 감시 누락 의심 (DB↔모니터링 시트 동기화 갭)*',
    `오늘(${kstDate(now)}) DB엔 있고 댓글도 있는데 봇 GAS 타겟엔 없는 신규 활성글 ${gaps.length}건 (유예 초과).`,
    '채널별: ' + Object.entries(byCat).map(([c, n]) => `${c} ${n}`).join(' · '),
    'DB→시트 동기화(pullFromDB) 지연/실패 또는 GAS 대상 상한·엔드포인트 불일치를 확인하세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function sbAll(env, path, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!base || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const out = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetchImpl(`${base}/rest/v1/${path}&offset=${off}&limit=1000`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
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

export async function runTargetSyncWatchdog(env = process.env, now = Date.now(), fetchImpl = fetch) {
  const graceHours = Number(env.TARGET_SYNC_GRACE_HOURS || 4);
  const minGap = Number(env.TARGET_SYNC_MIN_GAP || 10);
  const gasConfig = {
    gasWebAppUrl: env.GAS_WEB_APP_URL, gasVerifyToken: env.GAS_VERIFY_TOKEN,
    targetBatchSize: Number(env.TARGET_BATCH_SIZE || 1000), gasFetchRetries: Number(env.GAS_FETCH_RETRIES || 4),
  };
  const targets = await fetchTargets(gasConfig, fetchImpl);
  const targetKeys = new Set(targets.map((t) => extractPostKey(t.url)).filter(Boolean));
  const monitoredCats = new Set(targets.map((t) => norm(t.channelCategory)).filter(Boolean));

  const since = new Date(now - 7 * 24 * HOUR).toISOString();
  const posts = await sbAll(env, `sponsored_posts?select=id,channel_type,url,created_at&ended_at=is.null&created_at=gte.${since}&order=created_at.desc`, fetchImpl);
  const cut30 = new Date(now - 30 * 24 * HOUR).toISOString().slice(0, 10);
  const commentSet = new Set((await sbAll(env, `post_daily_stats?select=post_id&comments_count=gt.0&measured_at=gte.${cut30}`, fetchImpl)).map((r) => r.post_id));

  const gaps = evaluateTargetSyncGap({ posts, commentSet, targetKeys, monitoredCats }, now, graceHours);
  if (gaps.length < minGap) {
    console.log(`[target-sync-watchdog] OK — 갭 ${gaps.length}건(임계 ${minGap} 미만), GAS타겟 ${targets.length}`);
    return { warned: false, gaps: gaps.length };
  }
  await postSlack(env, buildGapMessage(now, gaps, env.SLACK_ASSIGNEE_OTHER), fetchImpl);
  console.error(`[target-sync-watchdog] GAP — 신규 미감시 ${gaps.length}건 → 경고 발송 (GAS타겟 ${targets.length})`);
  return { warned: true, gaps: gaps.length };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runTargetSyncWatchdog().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
