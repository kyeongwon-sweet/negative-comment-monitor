import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadYouTubeRepeatOffenderConfig,
  prepareYouTubeRepeatOffenderReport,
} from './youtube-repeat-offender-report.js';
import { buildYouTubeAuthorBanUrl } from './youtube-repeat-offender-ban.js';

// 상습 악플러 후보 전원(또는 승인된 alert ID 부분집합)을 한 번의 실행으로 밴한다.
// prepare 단계에서 소유 채널 OAuth로 후보를 검증한 뒤, 후보별 대표 댓글에
// setModerationStatus(rejected, banAuthor=true)를 걸어 그 작성자의 모든 댓글을
// 소유 채널에서 숨기고 향후 댓글을 차단한다. 단건 ban 워크플로를 후보 수만큼
// 반복하면 매번 전체 리포트를 재계산해 쿼터를 낭비하므로, 대량은 이 경로로 처리한다.
export const YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRMATION = 'BAN_ALL_YOUTUBE_REPEAT_OFFENDERS';

function clean(value) {
  return String(value ?? '').trim();
}

function alertIdSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter(Number.isSafeInteger),
  );
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export function loadYouTubeRepeatOffenderBulkBanConfig(env = process.env) {
  const dryRun = clean(env.YOUTUBE_REPEAT_OFFENDER_BULK_BAN_DRY_RUN || 'true').toLowerCase() !== 'false';
  const confirmation = clean(env.YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRM);
  if (!dryRun && confirmation !== YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRMATION) {
    throw new Error(`Live bulk ban requires YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRM=${YOUTUBE_REPEAT_OFFENDER_BULK_BAN_CONFIRMATION}`);
  }
  return {
    ...loadYouTubeRepeatOffenderConfig({ ...env, YOUTUBE_REPEAT_OFFENDER_NOTIFY_SLACK: 'false' }),
    dryRun,
    // 비우면 현재 후보 전원. 지정하면 그 alert ID를 포함하는 후보만 밴(사람이 승인한 부분집합).
    allowedAlertIds: alertIdSet(env.YOUTUBE_REPEAT_OFFENDER_ALERT_IDS),
    actor: clean(env.YOUTUBE_REPEAT_OFFENDER_BULK_BAN_ACTOR || 'codex-repeat-offender-bulk-ban'),
    banDelayMs: Number.isFinite(Number(env.YOUTUBE_REPEAT_OFFENDER_BULK_BAN_DELAY_MS))
      ? Math.max(0, Number(env.YOUTUBE_REPEAT_OFFENDER_BULK_BAN_DELAY_MS))
      : 300,
  };
}

export function selectBulkBanCandidates(candidates, allowedAlertIds) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!(allowedAlertIds instanceof Set) || allowedAlertIds.size === 0) return list;
  return list.filter((row) => (row.alertIds || []).some((id) => allowedAlertIds.has(Number(id))));
}

export function buildBulkBanInventory(selected) {
  const byOwner = {};
  for (const row of selected) {
    const key = row.ownerChannelName || row.ownerChannelId || '소유 채널';
    byOwner[key] = (byOwner[key] || 0) + 1;
  }
  return {
    selected: selected.length,
    byOwner,
    candidates: selected.map((row) => ({
      ownerChannelId: row.ownerChannelId,
      ownerChannelName: row.ownerChannelName || row.ownerChannelId,
      authorChannelId: row.authorChannelId,
      handle: row.handle || row.authorDisplayName || '',
      commentCount: row.commentCount,
      videoCount: row.videoCount,
      evidenceAlertId: row.evidenceAlertId,
      alertIds: row.alertIds || [],
    })),
  };
}

async function commentIdsByAlert(config, alertIds, fetchImpl) {
  const map = new Map();
  const ids = [...new Set(alertIds.filter(Number.isSafeInteger))];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/negative_comment_alerts?select=id,comment_id&id=in.(${batch.join(',')})`,
      { headers: headers(config) },
    );
    if (!response.ok) throw new Error(`Bulk ban evidence lookup failed (${response.status})`);
    for (const row of await response.json()) map.set(Number(row.id), clean(row.comment_id));
  }
  return map;
}

// banAuthor는 이미 그 작성자의 모든 댓글을 숨긴다. DB도 후보의 모든 미결 alert 행을
// hidden으로 맞춰, 다음 리포트가 같은 작성자를 다시 후보로 올리지 않게 한다.
async function persistAuthorAlertsHidden(config, alertIds, fetchImpl, now) {
  const ids = [...new Set((alertIds || []).map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return;
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${ids.join(',')})&review_decision=is.null`,
    {
      method: 'PATCH',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        review_decision: 'hidden',
        reviewed_by: config.actor,
        reviewed_at: new Date(now).toISOString(),
      }),
    },
  );
  if (!response.ok) throw new Error(`Bulk ban audit update failed (${response.status})`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// prepared = { candidates, accessTokens }. dryRun이면 인벤토리만 반환하고 아무것도 밴하지 않는다.
export async function executeBulkBan(config, prepared, fetchImpl = fetch, now = Date.now()) {
  const selected = selectBulkBanCandidates(prepared.candidates, config.allowedAlertIds);
  const inventory = buildBulkBanInventory(selected);
  const base = {
    dryRun: config.dryRun,
    totalCandidates: (prepared.candidates || []).length,
    selected: selected.length,
    byOwner: inventory.byOwner,
    inventory: inventory.candidates,
  };
  if (config.dryRun) return { ...base, banned: 0, failed: [], skipped: [] };

  const evidenceIds = selected.map((row) => Number(row.evidenceAlertId)).filter(Number.isSafeInteger);
  const commentByAlert = await commentIdsByAlert(config, evidenceIds, fetchImpl);
  let banned = 0;
  const failed = [];
  const skipped = [];
  for (const candidate of selected) {
    const token = prepared.accessTokens?.get(candidate.ownerChannelId);
    const commentId = commentByAlert.get(Number(candidate.evidenceAlertId));
    if (!token) { skipped.push({ authorChannelId: candidate.authorChannelId, reason: 'no-owner-token' }); continue; }
    if (!commentId) { skipped.push({ authorChannelId: candidate.authorChannelId, reason: 'no-comment-id' }); continue; }
    try {
      const response = await fetchImpl(buildYouTubeAuthorBanUrl(config.youtubeApiBase, commentId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 204) {
        failed.push({ authorChannelId: candidate.authorChannelId, status: response.status });
        continue;
      }
      await persistAuthorAlertsHidden(config, candidate.alertIds, fetchImpl, now);
      banned += 1;
      if (config.banDelayMs > 0) await wait(config.banDelayMs);
    } catch (error) {
      failed.push({ authorChannelId: candidate.authorChannelId, error: clean(error?.message || error).slice(0, 200) });
    }
  }
  return { ...base, banned, failed, skipped };
}

export async function banAllYouTubeRepeatOffenders(
  config = loadYouTubeRepeatOffenderBulkBanConfig(), fetchImpl = fetch, now = Date.now(),
) {
  const prepared = await prepareYouTubeRepeatOffenderReport({ ...config, notifySlack: false }, fetchImpl);
  return executeBulkBan(config, prepared, fetchImpl, now);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  banAllYouTubeRepeatOffenders()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
