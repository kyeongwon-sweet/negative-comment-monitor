// 일별(KST) 비용 누적 + 임계치 Slack 경고.
// - 누적은 '실행 1회'가 아니라 KST 하루 합. GitHub Actions 요약만으론 실행 간 누적이 안 되므로
//   Supabase cost_usage_ledger(run_key 멱등)에 실행별로 적고, 그날 합을 조회한다.
// - run_key = github_run_id + attempt → 재시도해도 같은 실행이 중복 합산되지 않는다.
// - 경고는 임계치(apify/anthropic/total)별로 하루 최초 초과 시 1회만(cost_alert_log 원자적 삽입).
// - 비용 경로의 어떤 실패도 모니터링 본류를 막지 않는다(전부 best-effort).

// Apify 비용 추정 단가(댓글당 USD). 실제 청구는 Apify 콘솔이 정본이며 이 값은 '경고용' 근사치다.
// (전수 스윕 실측 $2.9833 / 1430댓글 ≈ $0.00209와 부합.)
export const APIFY_RATE_USD = { instagram: 0.0023, tiktok: 0.001, youtube: 0.0015, twitter: 0.001 };
const DEFAULT_RATE_USD = 0.0015;

// 승인된 기본 임계치(USD/일).
export const DEFAULT_COST_THRESHOLDS = { apify: 2, anthropic: 0.1, total: 3 };

export function estimateApifyUsd(commentsByPlatform = {}) {
  let usd = 0;
  for (const [platform, count] of Object.entries(commentsByPlatform)) {
    usd += (APIFY_RATE_USD[platform] ?? DEFAULT_RATE_USD) * (count || 0);
  }
  return usd;
}

// 실행 고유키: GitHub Actions run id + attempt(멱등). 없으면 로컬 실행용 폴백.
export function runKey(env = process.env, fallbackNow = 0) {
  const id = String(env.GITHUB_RUN_ID || '').trim();
  const attempt = String(env.GITHUB_RUN_ATTEMPT || '1').trim();
  return id ? `gha:${id}:${attempt}` : `local:${fallbackNow}`;
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function costEnabled(config) {
  return Boolean(config && config.supabaseUrl && config.supabaseKey);
}

// 실행별 비용을 원장에 멱등 기록(같은 run_key 재시도는 무시). best-effort.
export async function recordRunCost(config, entry, fetchImpl = fetch) {
  if (!costEnabled(config)) return false;
  try {
    const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
      method: 'POST',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({
        run_key: entry.runKey,
        kst_date: entry.kstDate,
        apify_usd: entry.apifyUsd || 0,
        anthropic_usd: entry.anthropicUsd || 0,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// KST 일자 누적 합. 실패 시 null(경고 판단 스킵).
export async function sumDailyCost(config, kstDate, fetchImpl = fetch) {
  if (!costEnabled(config)) return null;
  try {
    const res = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/cost_usage_ledger?select=apify_usd,anthropic_usd&kst_date=eq.${encodeURIComponent(kstDate)}`,
      { headers: headers(config) },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    let apifyUsd = 0;
    let anthropicUsd = 0;
    for (const r of rows) { apifyUsd += r.apify_usd || 0; anthropicUsd += r.anthropic_usd || 0; }
    return { apifyUsd, anthropicUsd, totalUsd: apifyUsd + anthropicUsd };
  } catch {
    return null;
  }
}

// (kst_date, kind) 원자적 삽입 성공 시에만 true → 하루·종류별 최초 1회. 이미 있으면 false.
async function claimAlert(config, kstDate, kind, thresholdUsd, amountUsd, fetchImpl) {
  const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_alert_log?on_conflict=kst_date,kind`, {
    method: 'POST',
    headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify({ kst_date: kstDate, kind, threshold_usd: thresholdUsd, amount_usd: amountUsd }),
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0; // 새로 삽입된 경우만(중복은 빈 배열)
}

// Slack 전송 실패 시 claim을 해제해 다음 실행이 재시도하게 한다(경고 유실 방지).
async function releaseAlert(config, kstDate, kind, fetchImpl) {
  try {
    await fetchImpl(
      `${config.supabaseUrl}/rest/v1/cost_alert_log?kst_date=eq.${encodeURIComponent(kstDate)}&kind=eq.${encodeURIComponent(kind)}`,
      { method: 'DELETE', headers: headers(config, { Prefer: 'return=minimal' }) },
    );
  } catch { /* 무시 */ }
}

const KIND_LABEL = { apify: 'Apify', anthropic: 'Anthropic', total: '전체' };

export function buildCostWarningText(kind, amount, threshold, kstDate, assignee = '') {
  const mention = assignee ? ` <@${assignee}>` : '';
  return `💸 *일일 비용 경고 (KST ${kstDate})*${mention}\n`
    + `${KIND_LABEL[kind] || kind} 사용량 $${amount.toFixed(4)} 가 임계치 $${threshold.toFixed(2)}를 초과했습니다.`;
}

// 임계치별 최초 초과 1회 경고. sender(kind, amount, threshold)는 실제 Slack 전송(실패 시 throw).
// 반환: 실제 발송된 kind 목록. costEnabled 아니거나 조회 실패면 아무것도 안 함.
export async function maybeAlertCosts(config, kstDate, totals, thresholds, sender, fetchImpl = fetch) {
  if (!costEnabled(config) || !totals) return [];
  const checks = [
    ['apify', totals.apifyUsd, thresholds.apify],
    ['anthropic', totals.anthropicUsd, thresholds.anthropic],
    ['total', totals.totalUsd, thresholds.total],
  ];
  const fired = [];
  for (const [kind, amount, threshold] of checks) {
    if (!(amount > threshold)) continue;
    let claimed = false;
    try {
      claimed = await claimAlert(config, kstDate, kind, threshold, amount, fetchImpl);
    } catch {
      claimed = false;
    }
    if (!claimed) continue;
    try {
      await sender(kind, amount, threshold);
      fired.push(kind);
    } catch {
      await releaseAlert(config, kstDate, kind, fetchImpl); // 전송 실패 → 재시도 가능하게 해제
    }
  }
  return fired;
}

// Slack 채널로 경고 텍스트 전송(chat.postMessage). 실패 시 throw(maybeAlertCosts가 처리).
export async function postCostWarning(config, kind, amount, threshold, kstDate, fetchImpl = fetch) {
  if (!config.slackBotToken || !config.slackChannelId) throw new Error('Slack not configured for cost warning');
  const assignee = (config.slackAssignees && config.slackAssignees.other) || '';
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text: buildCostWarningText(kind, amount, threshold, kstDate, assignee) }),
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}
