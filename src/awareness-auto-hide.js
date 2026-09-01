import { loadMetaToken } from './meta-token.js';
import { hideWithIsolation, syncHiddenTikTokSlackCards } from './tiktok-bulk-hide.js';

const KEEP_DECISIONS = new Set(['false_positive', 'ignore']);

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadActionableAwarenessAlerts(
  config,
  source,
  fetchImpl = fetch,
  { includeHumanDecisions = false } = {},
) {
  const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts`
    + '?select=id,comment_id,comment_text,post_url,review_decision,reviewed_by,reviewed_at,slack_channel_id,slack_ts'
    + `&source=eq.${encodeURIComponent(source)}&comment_id=not.is.null&order=id.asc&limit=2000`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Awareness alert lookup failed (${response.status})`);
  const rows = await response.json();
  return rows.filter((row) => {
    const decision = String(row.review_decision || '').trim().toLowerCase();
    if (KEEP_DECISIONS.has(decision) || decision === 'hidden') return false;
    // 상시 자동 처리에서는 아직 사람이 누르지 않은 새 카드만 대상으로 삼는다.
    // 일회성 백로그 정리만 hide/complete를 다시 API에 보내 실제 숨김을 수렴시킨다.
    if (decision) return includeHumanDecisions && ['hide', 'complete'].includes(decision);
    // 판단값 없이 사람 이력만 존재하는 비정상 행은 안전하게 제외한다.
    if (!decision && (row.reviewed_by || row.reviewed_at)) return false;
    return true;
  });
}

async function persistAutoHidden(config, source, rows, fetchImpl, now) {
  const ids = rows
    .filter((row) => !row.review_decision && !row.reviewed_by && !row.reviewed_at)
    .map((row) => row.id);
  let updated = 0;
  for (const batch of chunk(ids, 100)) {
    const encoded = batch.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',');
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${encodeURIComponent(encoded)})&source=eq.${encodeURIComponent(source)}`,
      {
        method: 'PATCH',
        headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify({
          review_decision: 'hidden',
          reviewed_by: `${source}-auto-hide`,
          reviewed_at: new Date(now).toISOString(),
        }),
      },
    );
    if (!response.ok) throw new Error(`Awareness audit update failed (${response.status})`);
    const result = await response.json().catch(() => []);
    updated += Array.isArray(result) ? result.length : 0;
  }
  return updated;
}

async function persistModerationUnavailable(config, source, rows, fetchImpl, now) {
  const ids = rows
    .filter((row) => !row.review_decision && !row.reviewed_by && !row.reviewed_at)
    .map((row) => row.id);
  let updated = 0;
  for (const batch of chunk(ids, 100)) {
    const encoded = batch.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',');
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${encodeURIComponent(encoded)})&source=eq.${encodeURIComponent(source)}`,
      {
        method: 'PATCH',
        headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify({
          // hidden 성공을 위조하지 않고, 같은 영구 오류를 매 회차 재호출하지 않는 종결 상태다.
          review_decision: 'unavailable',
          reviewed_by: `${source}-auto-hide`,
          reviewed_at: new Date(now).toISOString(),
        }),
      },
    );
    if (!response.ok) throw new Error(`Awareness unavailable update failed (${response.status})`);
    const result = await response.json().catch(() => []);
    updated += Array.isArray(result) ? result.length : 0;
  }
  return updated;
}

export function classifyMetaModerationFailure(response, payload = {}) {
  const code = Number(payload.error?.code || 0);
  const subcode = Number(payload.error?.error_subcode || 0);
  if (Number(response?.status) === 400 && code === 100 && subcode === 33) {
    return { reason: 'object_unavailable', code, subcode };
  }
  // #3(capability), #10/#200(permission)은 동일 요청을 다시 보내도 회복되지 않는다.
  // #190(토큰 만료), #4/#17(rate limit), 5xx는 시스템 복구가 필요하므로 hard failure로 남긴다.
  if ([3, 10, 200].includes(code)) return { reason: 'permission_denied', code, subcode };
  return null;
}

function metaHiddenBlocks(row, now) {
  const when = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const unavailable = Boolean(row.moderationUnavailable);
  const permissionDenied = row.moderationUnavailableReason === 'permission_denied';
  const title = permissionDenied
    ? 'Instagram 광고 댓글 자동 숨김 불가'
    : unavailable ? 'Instagram 광고 댓글 비노출 확인 완료' : 'Instagram 광고 댓글 자동 숨김 완료';
  const context = permissionDenied
    ? 'Meta 앱의 해당 댓글 모더레이션 권한 없음 · 영구 재시도 중단'
    : unavailable ? 'Meta에서 이미 삭제·숨김되어 조회 불가' : 'Meta Graph API 자동 숨김';
  const status = permissionDenied ? '모더레이션 불가 ⚠️' : '비노출 처리 🚫';
  const text = String(row.comment_text || '').slice(0, 700)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const post = String(row.post_url || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `🚫 *${title}*${post ? `\n<${post}|게시물 열기>` : ''}${text ? `\n\n*댓글*\n${text}` : ''}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${status}* · ${context} · ${when} KST` }] },
  ];
}

async function syncMetaSlack(config, rows, fetchImpl, now) {
  let updated = 0, unavailable = 0, failed = 0;
  for (const row of rows.filter((item) => item.slack_channel_id && item.slack_ts)) {
    const response = await fetchImpl('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: row.slack_channel_id,
        ts: row.slack_ts,
        text: row.moderationUnavailableReason === 'permission_denied'
          ? 'Instagram 광고 댓글 자동 숨김 불가'
          : row.moderationUnavailable ? 'Instagram 광고 댓글 비노출 확인 완료' : 'Instagram 광고 댓글 자동 숨김 완료',
        blocks: metaHiddenBlocks(row, now),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.ok) updated += 1;
    else if (payload.error === 'message_not_found' || payload.error === 'cant_update_message') unavailable += 1;
    else failed += 1;
  }
  return { updated, unavailable, failed };
}

export async function autoHideMetaAwareness(
  config,
  fetchImpl = fetch,
  now = Date.now(),
  options = {},
) {
  const rows = await loadActionableAwarenessAlerts(config, 'meta_ads', fetchImpl, options);
  const token = rows.length ? await loadMetaToken(config, config.metaTokenKind || 'ig_ads', fetchImpl) : null;
  if (rows.length && !token?.token) throw new Error('Meta awareness token not found');
  const rowsByComment = new Map();
  for (const row of rows) {
    const id = String(row.comment_id);
    if (!rowsByComment.has(id)) rowsByComment.set(id, []);
    rowsByComment.get(id).push(row);
  }
  const succeeded = [], unavailable = [], failed = [];
  for (const [commentId, commentRows] of rowsByComment) {
    const response = await fetchImpl(
      `${config.metaGraphBase}/${encodeURIComponent(commentId)}?hide=true`,
      { method: 'POST', headers: { Authorization: `Bearer ${token.token}` } },
    );
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.success === true) succeeded.push(...commentRows);
    else {
      const terminal = classifyMetaModerationFailure(response, payload);
      if (terminal) {
        // 객체 소멸(#100/33)과 영구 권한 오류(#3/#10/#200)를 hidden으로 위조하지 않는다.
        // unavailable로 수렴시켜 run 실패·무한 재시도만 막는다.
        unavailable.push(...commentRows.map((row) => ({
          ...row,
          moderationUnavailable: true,
          moderationUnavailableReason: terminal.reason,
        })));
      } else failed.push(String(payload.error?.message || `HTTP ${response.status}`).slice(0, 160));
    }
  }
  const slackRows = [...succeeded, ...unavailable]
    .filter((row) => !row.review_decision && !row.reviewed_by && !row.reviewed_at);
  const slack = slackRows.length
    ? await syncMetaSlack(config, slackRows, fetchImpl, now)
    : { updated: 0, unavailable: 0, failed: 0 };
  // Slack 일시 장애면 DB를 완료 처리하지 않아 다음 회차가 API(멱등)+Slack을 함께 재시도한다.
  // hidden과 unavailable은 서로 다른 감사 상태로 기록한다. Slack 일시 장애가 있으면 둘 다 다음 회차로 미룬다.
  const dbUpdated = slack.failed ? 0 : await persistAutoHidden(config, 'meta_ads', succeeded, fetchImpl, now);
  const unavailableDbUpdated = slack.failed
    ? 0
    : await persistModerationUnavailable(config, 'meta_ads', unavailable, fetchImpl, now);
  return {
    actionable: rows.length,
    hidden: new Set(succeeded.map((row) => String(row.comment_id))).size,
    unavailable: new Set(unavailable.map((row) => String(row.comment_id))).size,
    failed: failed.length,
    dbUpdated,
    unavailableDbUpdated,
    slack,
  };
}

export async function autoHideTikTokAwareness(
  config,
  fetchImpl = fetch,
  now = Date.now(),
  options = {},
) {
  const rows = await loadActionableAwarenessAlerts(config, 'tiktok_ads', fetchImpl, options);
  const byComment = new Map();
  for (const row of rows) {
    const id = String(row.comment_id);
    if (!byComment.has(id)) byComment.set(id, []);
    byComment.get(id).push(row);
  }
  const succeededIds = [];
  const isolation = { failed: [] };
  const bulkConfig = {
    accessToken: config.tiktokAccessToken,
    advertiserId: config.tiktokAdvertiserId,
    apiBase: config.tiktokApiBase,
    operation: 'HIDDEN',
    adType: 'BIDDING',
  };
  for (const ids of chunk([...byComment.keys()], 20)) {
    succeededIds.push(...await hideWithIsolation(bulkConfig, ids, fetchImpl, wait, isolation));
  }
  const succeeded = succeededIds.flatMap((id) => byComment.get(id) || []);
  const newRows = succeeded.filter((row) => !row.review_decision && !row.reviewed_by && !row.reviewed_at);
  const slackConfig = {
    ...config,
    slackUpdateDelayMs: 1100,
  };
  const slack = newRows.length
    ? await syncHiddenTikTokSlackCards(slackConfig, newRows, new Map(), fetchImpl, wait, now)
    : { updated: 0, unavailable: 0, failed: 0 };
  const dbUpdated = slack.failed ? 0 : await persistAutoHidden(config, 'tiktok_ads', succeeded, fetchImpl, now);
  return { actionable: rows.length, hidden: succeededIds.length, failed: isolation.failed.length, dbUpdated, slack };
}
