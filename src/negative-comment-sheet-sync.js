import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLATFORM_LABELS = {
  instagram: '인스타그램',
  youtube: '유튜브',
  tiktok: '틱톡',
  twitter: '트위터',
};

const REVIEW_LABELS = {
  hidden: '숨김완료',
  false_positive: '오탐(무시)',
  ignore: '오탐(무시)',
  complete: '완료',
  approve: '승인',
  hold: '보류',
  unhide: '숨김해제',
};

function clean(value) {
  return String(value ?? '').trim();
}

export function validateSheetWebhookUrl(value) {
  const raw = clean(value);
  try {
    const url = new URL(raw);
    const allowedHost = url.hostname === 'script.google.com'
      || url.hostname.endsWith('.script.googleusercontent.com');
    if (url.protocol !== 'https:' || !allowedHost || !/\/exec\/?$/.test(url.pathname)) {
      throw new Error('not an Apps Script /exec URL');
    }
    return url.toString();
  } catch {
    throw new Error('NEGATIVE_COMMENT_SHEET_WEBHOOK_URL must be an HTTPS Apps Script /exec URL');
  }
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export function loadNegativeCommentSheetSyncConfig(env = process.env) {
  const webhookUrl = clean(env.NEGATIVE_COMMENT_SHEET_WEBHOOK_URL);
  const webhookToken = clean(env.NEGATIVE_COMMENT_SHEET_WEBHOOK_TOKEN);
  const enabled = Boolean(webhookUrl && webhookToken);
  return {
    enabled,
    webhookUrl,
    webhookToken,
    supabaseUrl: clean(env.SUPABASE_URL).replace(/\/$/, ''),
    supabaseKey: clean(env.SUPABASE_SERVICE_ROLE_KEY),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackChannelId: clean(env.SLACK_CHANNEL_ID),
    assignee: clean(env.SLACK_ASSIGNEE_OTHER),
    batchSize: Math.min(500, Math.max(1, Number(env.NEGATIVE_COMMENT_SHEET_BATCH_SIZE || 200))),
    failureThreshold: Math.max(1, Number(env.NEGATIVE_COMMENT_SHEET_FAILURE_THRESHOLD || 3)),
    alertCooldownHours: Math.max(1, Number(env.NEGATIVE_COMMENT_SHEET_ALERT_COOLDOWN_HOURS || 24)),
  };
}

export function formatKstSeconds(value) {
  if (!value && value !== 0) return '';
  const raw = String(value).trim();
  let ms;
  if (/^\d{9,}$/.test(raw)) ms = Number(raw) * (raw.length <= 10 ? 1000 : 1);
  else ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

export function sheetRowFromAlert(row) {
  const platform = clean(row.platform).toLowerCase();
  return {
    product: clean(row.product_name),
    channel: clean(row.channel_category),
    reason: clean(row.reason),
    postUrl: clean(row.post_url),
    commentText: clean(row.comment_text),
    category: clean(row.category),
    platform: PLATFORM_LABELS[platform] || clean(row.platform),
    channelName: clean(row.channel_name),
    assetName: clean(row.asset_name),
    status: REVIEW_LABELS[clean(row.review_decision).toLowerCase()] || '미처리',
    detectedAtKst: formatKstSeconds(row.comment_timestamp || row.alerted_at),
    commentId: clean(row.comment_id),
    fingerprint: clean(row.fingerprint),
  };
}

export async function loadPendingSheetAlerts(config, fetchImpl = fetch) {
  const select = [
    'id', 'fingerprint', 'platform', 'post_url', 'comment_id', 'comment_text', 'alerted_at',
    'review_decision', 'category', 'reason', 'product_name', 'channel_category', 'channel_name',
    'asset_name', 'comment_timestamp', 'sheet_sync_attempts',
  ].join(',');
  const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
  url.searchParams.set('select', select);
  url.searchParams.set('sheet_synced_at', 'is.null');
  url.searchParams.set('order', 'alerted_at.asc');
  url.searchParams.set('limit', String(config.batchSize));
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Sheet outbox query failed (${response.status})`);
  return response.json();
}

export async function appendSheetRows(config, rows, fetchImpl = fetch) {
  // Secret 슬롯에 댓글 캡션 같은 임의 문자열이 덮어써져도 fetch까지 전달하지 않는다.
  // 명확한 degraded 원인으로 기록해 다음 회차 재시도·운영 경고가 작동하게 한다.
  const webhookUrl = validateSheetWebhookUrl(config.webhookUrl);
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.webhookToken, rows }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!response.ok || !payload?.ok) {
    throw new Error(`Sheet webhook failed (${response.status}): ${clean(payload?.error || text).slice(0, 200)}`);
  }
  return payload;
}

async function markRowsSynced(config, ids, fetchImpl) {
  if (!ids.length) return 0;
  const encoded = ids.map((id) => Number(id)).filter(Number.isFinite).join(',');
  const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${encoded})&sheet_synced_at=is.null`;
  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify({
      sheet_synced_at: new Date().toISOString(),
      sheet_sync_last_error: null,
    }),
  });
  if (!response.ok) throw new Error(`Sheet outbox ack failed (${response.status})`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function markRowsFailed(config, rows, error, fetchImpl) {
  const message = clean(error?.message || error).slice(0, 500);
  for (const row of rows) {
    const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=eq.${encodeURIComponent(row.id)}&sheet_synced_at=is.null`;
    await fetchImpl(url, {
      method: 'PATCH',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        sheet_sync_attempts: Number(row.sheet_sync_attempts || 0) + 1,
        sheet_sync_last_error: message,
      }),
    }).catch(() => null);
  }
}

async function loadHealth(config, fetchImpl) {
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/negative_comment_sheet_sync_health?select=*&id=eq.1&limit=1`,
    { headers: headers(config) },
  );
  if (!response.ok) return null;
  return (await response.json())[0] || null;
}

async function saveHealth(config, body, fetchImpl) {
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/negative_comment_sheet_sync_health?on_conflict=id`,
    {
      method: 'POST',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify({ id: 1, ...body, updated_at: new Date().toISOString() }),
    },
  );
  if (!response.ok) return null;
  return (await response.json())[0] || null;
}

export function buildSheetSyncWarning(failures, pending, assignee = '') {
  const mention = assignee ? ` <@${assignee}>` : '';
  return `⚠️ *부정댓글 로우데이터 시트 동기화 지연*${mention}\n`
    + `연속 ${failures}회 실패, 미전송 ${pending}건입니다. 핵심 댓글 수집·Slack 알림은 정상이며 시트 전송은 다음 회차에 자동 재시도합니다.`;
}

async function sendWarning(config, failures, pending, fetchImpl) {
  if (!config.slackBotToken || !config.slackChannelId) return false;
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text: buildSheetSyncWarning(failures, pending, config.assignee) }),
  });
  const payload = await response.json();
  return Boolean(payload.ok);
}

async function recordFailure(config, pendingRows, error, fetchImpl, now) {
  await markRowsFailed(config, pendingRows, error, fetchImpl);
  const current = await loadHealth(config, fetchImpl);
  const failures = Number(current?.consecutive_failures || 0) + 1;
  const lastAlerted = Date.parse(current?.last_alerted_at || '');
  const cooldownElapsed = !Number.isFinite(lastAlerted)
    || now - lastAlerted >= config.alertCooldownHours * 3600 * 1000;
  let alertedAt = current?.last_alerted_at || null;
  if (failures >= config.failureThreshold && cooldownElapsed) {
    if (await sendWarning(config, failures, pendingRows.length, fetchImpl)) alertedAt = new Date(now).toISOString();
  }
  await saveHealth(config, {
    consecutive_failures: failures,
    last_error: clean(error?.message || error).slice(0, 500),
    last_failed_at: new Date(now).toISOString(),
    last_alerted_at: alertedAt,
    last_success_at: current?.last_success_at || null,
  }, fetchImpl);
  return failures;
}

export async function syncPendingNegativeComments(
  config = loadNegativeCommentSheetSyncConfig(), fetchImpl = fetch, now = Date.now(),
) {
  if (!config.enabled) return { enabled: false, pending: 0, synced: 0, degraded: false };
  if (!config.supabaseUrl || !config.supabaseKey) {
    return { enabled: true, pending: 0, synced: 0, degraded: true, error: 'Supabase configuration missing' };
  }
  let pendingRows = [];
  try {
    pendingRows = await loadPendingSheetAlerts(config, fetchImpl);
    if (!pendingRows.length) {
      await saveHealth(config, { consecutive_failures: 0, last_error: null, last_success_at: new Date(now).toISOString() }, fetchImpl);
      return { enabled: true, pending: 0, synced: 0, degraded: false };
    }
    const result = await appendSheetRows(config, pendingRows.map(sheetRowFromAlert), fetchImpl);
    const synced = await markRowsSynced(config, pendingRows.map((row) => row.id), fetchImpl);
    await saveHealth(config, { consecutive_failures: 0, last_error: null, last_success_at: new Date(now).toISOString() }, fetchImpl);
    return {
      enabled: true,
      pending: pendingRows.length,
      appended: Number(result.appended || 0),
      duplicates: Number(result.duplicates || 0),
      synced,
      degraded: false,
    };
  } catch (error) {
    const failures = await recordFailure(config, pendingRows, error, fetchImpl, now).catch(() => 0);
    return {
      enabled: true,
      pending: pendingRows.length,
      synced: 0,
      degraded: true,
      failures,
      error: clean(error?.message || error),
    };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  syncPendingNegativeComments()
    .then((summary) => {
      // comment_id·원문·token은 공개 로그에 쓰지 않는다.
      console.log(JSON.stringify(summary));
    });
}
