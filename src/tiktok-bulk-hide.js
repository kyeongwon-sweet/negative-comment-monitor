import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  fetchTikTokCampaigns,
  filterTikTokCampaigns,
  fetchTikTokAds,
  fetchTikTokAdgroupComments,
} from './tiktok-ads.js';

// 틱톡 광고 부정댓글 일괄 숨김. 유튜브 owner-moderation 패턴 미러링 + 동일 안전장치:
//  - dry-run 기본 true, 라이브는 TIKTOK_BULK_HIDE_CONFIRM 확인 토큰 필요(오발 방지)
//  - 사람이 결정한 행(review_decision 존재: hide/complete/false_positive)은 제외 → 미처리(null)만
//  - 배치 실패 시 이진분할로 문제 댓글만 격리(정상분은 계속 숨김)
//  - 확정 성공분만 DB review_decision=hidden 기록(대상은 전부 unreviewed라 오귀속 없음)
//  - 토큰은 서버(GitHub Actions) 시크릿에서만 주입. 숨김 API는 web/injibot-action에서 검증된 것과 동일.

export const TIKTOK_BULK_HIDE_CONFIRMATION = 'HIDE_ALL_TIKTOK_AD_ALERTS';
const DEFAULT_TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function loadTikTokBulkHideConfig(env = process.env) {
  const dryRun = String(env.TIKTOK_BULK_HIDE_DRY_RUN || 'true').toLowerCase() !== 'false';
  const confirmation = String(env.TIKTOK_BULK_HIDE_CONFIRM || '').trim();
  if (!dryRun && confirmation !== TIKTOK_BULK_HIDE_CONFIRMATION) {
    throw new Error(`Destructive TikTok moderation requires TIKTOK_BULK_HIDE_CONFIRM=${TIKTOK_BULK_HIDE_CONFIRMATION}`);
  }
  return {
    advertiserId: required(env, 'TIKTOK_ADVERTISER_ID'),
    accessToken: required(env, 'TIKTOK_ACCESS_TOKEN'),
    apiBase: String(env.TIKTOK_API_BASE || DEFAULT_TIKTOK_API_BASE).trim().replace(/\/$/, ''),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackBotToken: required(env, 'SLACK_BOT_TOKEN'),
    slackChannelId: required(env, 'SLACK_CHANNEL_ID'),
    threadTs: required(env, 'TIKTOK_BULK_HIDE_THREAD_TS_CSV')
      .split(',').map((v) => v.trim()).filter(Boolean),
    dryRun,
    auditOnly: String(env.TIKTOK_BULK_HIDE_AUDIT_ONLY || 'false').toLowerCase() === 'true',
    // web/injibot-action에서 라이브 검증된 값: HIDE는 40002 거절, HIDDEN/BIDDING이 실제 숨김 성공.
    operation: String(env.TIKTOK_HIDE_OPERATION || 'HIDDEN').trim(),
    adType: String(env.TIKTOK_HIDE_AD_TYPE || 'BIDDING').trim(),
    batchSize: positiveInt(env.TIKTOK_BULK_HIDE_BATCH_SIZE, 20, 100),
    limit: positiveInt(env.TIKTOK_BULK_HIDE_LIMIT, 0, 100000), // 0 = 전체. 샘플 검증용으로 소량 지정.
    actor: String(env.TIKTOK_BULK_HIDE_ACTOR || 'bulk-tiktok-hide').trim(),
    requestDelayMs: positiveInt(env.TIKTOK_BULK_HIDE_REQUEST_DELAY_MS, 1000, 10000),
    slackUpdateDelayMs: positiveInt(env.TIKTOK_HIDDEN_SLACK_DELAY_MS, 1100, 10000),
    tiktokCampaignNameFilter: String(env.AD_CAMPAIGN_NAME_FILTER || '빙과,쫀득바').trim(),
    tiktokAdsLookbackDays: positiveInt(env.TIKTOK_BULK_HIDE_VERIFY_LOOKBACK_DAYS, 30, 90),
    tiktokAdsMaxCommentsPerAdgroup: 1000,
  };
}

function supabaseHeaders(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function encodedIdList(values) {
  return values.map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
}

// 사람이 아직 결정하지 않은(review_decision null) tiktok_ads 알림만. hide/complete/false_positive는 제외.
export async function loadUnhiddenTikTokAlerts(config, fetchImpl = fetch) {
  const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts`
    + '?select=id,comment_id,post_url,comment_text,slack_channel_id,slack_ts'
    + '&source=eq.tiktok_ads&review_decision=is.null&comment_id=not.is.null&order=id.asc';
  const res = await fetchImpl(url, { headers: supabaseHeaders(config) });
  if (!res.ok) throw new Error(`Supabase read failed (${res.status})`);
  return res.json();
}

export async function loadAllTikTokAlerts(config, fetchImpl = fetch) {
  const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts`
    + '?select=id,comment_id,post_url,comment_text,slack_channel_id,slack_ts,review_decision,reviewed_by,reviewed_at'
    + '&source=eq.tiktok_ads&comment_id=not.is.null&order=id.asc';
  const res = await fetchImpl(url, { headers: supabaseHeaders(config) });
  if (!res.ok) throw new Error(`Supabase audit read failed (${res.status})`);
  return res.json();
}

// 링크로 지정된 부모 스레드의 답글만 scope로 사용한다. 서로 다른 플랫폼 카드가 섞인
// 인지 광고 스레드이므로 이후 DB source=tiktok_ads 조건과 교차해야 한다.
export async function loadScopedSlackMessages(config, fetchImpl = fetch) {
  const messages = new Map();
  for (const threadTs of config.threadTs) {
    let cursor = '';
    do {
      const url = new URL('https://slack.com/api/conversations.replies');
      url.searchParams.set('channel', config.slackChannelId);
      url.searchParams.set('ts', threadTs);
      url.searchParams.set('limit', '200');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.slackBotToken}` } });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.ok) throw new Error(`Slack thread read failed (${payload.error || res.status})`);
      for (const message of (payload.messages || [])) {
        if (String(message.ts) !== String(threadTs)) messages.set(String(message.ts), message);
      }
      cursor = String(payload.response_metadata?.next_cursor || '').trim();
    } while (cursor);
  }
  return messages;
}

// TikTok comment/status/update. 성공=code 0. rate-limit(40000/40100/429) 지수 백오프.
export async function hideTikTokCommentBatch(config, commentIds, fetchImpl = fetch, sleep = wait) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetchImpl(`${config.apiBase}/comment/status/update/`, {
      method: 'POST',
      headers: { 'Access-Token': config.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        advertiser_id: config.advertiserId,
        comment_ids: commentIds,
        operation: config.operation,
        ad_type: config.adType,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const code = Number(payload.code);
    const rateLimited = response.status === 429 || [40000, 40100].includes(code);
    if (rateLimited && attempt < 4) { await sleep(1500 * (2 ** attempt)); continue; }
    if (response.ok && code === 0) return { ok: true };
    return { ok: false, code, message: String(payload.message || `HTTP ${response.status}`).slice(0, 200) };
  }
  return { ok: false, message: 'rate limited after retries' };
}

// 배치 실패 시 이진분할로 문제 댓글만 격리. 성공한 comment_id 목록 반환. 실패분은 result.failed에 기록.
export async function hideWithIsolation(config, ids, fetchImpl, sleep, result) {
  if (!ids.length) return [];
  const r = await hideTikTokCommentBatch(config, ids, fetchImpl, sleep);
  if (r.ok) return ids;
  if (ids.length === 1) {
    // comment_id는 Actions 로그/요약에 남기지 않는다.
    result.failed.push({ code: r.code, error: r.message });
    return [];
  }
  const mid = Math.floor(ids.length / 2);
  const left = await hideWithIsolation(config, ids.slice(0, mid), fetchImpl, sleep, result);
  const right = await hideWithIsolation(config, ids.slice(mid), fetchImpl, sleep, result);
  return [...left, ...right];
}

// 확정 성공분만 review_decision=hidden + 행위자/시각. 대상은 전부 unreviewed라 사람 결정 덮어쓰기 없음.
export async function persistHiddenRows(config, rowIds, fetchImpl = fetch, now = Date.now()) {
  if (!rowIds.length) return 0;
  let updated = 0;
  for (const batch of chunk(rowIds, 100)) {
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${encodeURIComponent(encodedIdList(batch))})&source=eq.tiktok_ads`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify({ review_decision: 'hidden', reviewed_by: config.actor, reviewed_at: new Date(now).toISOString() }),
      },
    );
    if (!response.ok) throw new Error(`Supabase moderation audit update failed (${response.status})`);
    const rows = await response.json().catch(() => []);
    updated += Array.isArray(rows) ? rows.length : 0;
  }
  return updated;
}

function escapeMrkdwn(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hiddenSlackBlocks(row, now, originalMessage = null) {
  const when = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const retained = Array.isArray(originalMessage?.blocks)
    ? originalMessage.blocks
      .filter((block) => block.type !== 'actions')
      .filter((block) => !JSON.stringify(block).includes('숨김 처리 🚫'))
      .map((block) => {
        if (block.type !== 'section' || block.text?.type !== 'mrkdwn') return block;
        return {
          ...block,
          text: {
            ...block.text,
            text: String(block.text.text || '').replace(/(현재상태\s*\n)(미처리[^\n]*)/u, '$1숨김 처리됨 🚫'),
          },
        };
      })
    : [];
  if (!retained.length) {
    const post = escapeMrkdwn(String(row.post_url || '').trim());
    const comment = escapeMrkdwn(String(row.comment_text || '').slice(0, 700));
    retained.push({ type: 'section', text: { type: 'mrkdwn', text: `🚫 *TikTok 댓글 숨김 처리 완료*${post ? `\n<${post}|게시물 열기>` : ''}${comment ? `\n\n*댓글*\n${comment}` : ''}` } });
  }
  retained.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*숨김 처리 🚫* · TikTok 광고계정 일괄 · ${when} KST` }] });
  return retained;
}

// 숨김된 댓글 카드를 '숨김 처리됨'으로 갱신(best-effort). 실패/누락은 집계만 하고 진행.
export async function syncHiddenTikTokSlackCards(config, rows, scopedMessages, fetchImpl = fetch, sleep = wait, now = Date.now()) {
  const eligible = rows.filter((r) => r.slack_channel_id && r.slack_ts);
  let updated = 0, unavailable = 0, failed = 0;
  for (let i = 0; i < eligible.length; i += 1) {
    const row = eligible[i];
    const res = await fetchImpl('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: row.slack_channel_id,
        ts: row.slack_ts,
        text: String(scopedMessages.get(String(row.slack_ts))?.text || 'TikTok 댓글 숨김 처리 완료'),
        blocks: hiddenSlackBlocks(row, now, scopedMessages.get(String(row.slack_ts))),
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (res.ok && payload.ok) updated += 1;
    else if (payload.error === 'message_not_found' || payload.error === 'cant_update_message') unavailable += 1;
    else failed += 1;
    if (i < eligible.length - 1 && config.slackUpdateDelayMs > 0) await sleep(config.slackUpdateDelayMs);
  }
  return { eligible: eligible.length, updated, unavailable, failed };
}

// TikTok comment/list는 광고 댓글의 공개/숨김 상태를 함께 반환한다. 상태 변경 응답(code=0)
// 뒤에 실제 HIDDEN 상태를 재조회해 확인된 행만 DB/Slack에 완료 반영한다.
export async function verifyHiddenTikTokComments(config, expectedIds, fetchImpl = fetch, now = Date.now()) {
  const scanConfig = {
    ...config,
    tiktokApiBase: config.apiBase,
    tiktokAccessToken: config.accessToken,
    tiktokAdvertiserId: config.advertiserId,
  };
  const campaigns = filterTikTokCampaigns(
    await fetchTikTokCampaigns(scanConfig, fetchImpl),
    config.tiktokCampaignNameFilter,
  );
  const ads = await fetchTikTokAds(scanConfig, campaigns.map((c) => c.campaign_id), fetchImpl);
  const adgroupIds = [...new Set(ads.map((a) => String(a.adgroup_id || '')).filter(Boolean))];
  const statusById = new Map();
  for (const adgroupId of adgroupIds) {
    const rows = await fetchTikTokAdgroupComments(scanConfig, adgroupId, fetchImpl, now);
    for (const row of rows) statusById.set(String(row.comment_id || ''), String(row.comment_status || '').toUpperCase());
  }
  const hiddenIds = [], visibleIds = [], missingIds = [];
  for (const id of expectedIds) {
    const status = statusById.get(String(id));
    if (status === 'HIDDEN') hiddenIds.push(id);
    else if (status) visibleIds.push(id);
    else missingIds.push(id);
  }
  return { hiddenIds, visibleIds, missingIds, campaigns: campaigns.length, ads: ads.length, adgroups: adgroupIds.length };
}

export async function bulkHideTikTokAlerts(config = loadTikTokBulkHideConfig(), fetchImpl = fetch, now = Date.now(), sleep = wait, verifyImpl = verifyHiddenTikTokComments) {
  const scopedMessages = await loadScopedSlackMessages(config, fetchImpl);
  const allAlerts = config.auditOnly
    ? await loadAllTikTokAlerts(config, fetchImpl)
    : await loadUnhiddenTikTokAlerts(config, fetchImpl);
  const alerts = allAlerts.filter((a) => scopedMessages.has(String(a.slack_ts)));
  const byComment = new Map();
  for (const a of alerts) {
    const cid = String(a.comment_id);
    if (!byComment.has(cid)) byComment.set(cid, []);
    byComment.get(cid).push(a);
  }
  let commentIds = [...byComment.keys()];
  if (config.limit) commentIds = commentIds.slice(0, config.limit);
  const result = {
    dryRun: config.dryRun,
    auditOnly: config.auditOnly,
    requestedThreads: config.threadTs.length,
    scopedSlackReplies: scopedMessages.size,
    totalSourceUnhiddenRows: allAlerts.length,
    totalUnhiddenRows: alerts.length,
    uniqueComments: byComment.size,
    targetComments: commentIds.length,
    hidden: 0,
    dbUpdated: 0,
    failed: [],
    repairEligibleVisible: 0,
    repairBlockedByDecision: 0,
    repairedVisible: 0,
    repairStillVisible: 0,
    verification: null,
    slack: null,
  };
  if (config.auditOnly) {
    const initial = await verifyImpl(config, commentIds, fetchImpl, now);
    const keepDecisions = new Set(['false_positive', 'ignore', 'approve', 'hold', 'unhide']);
    const repairableVisibleIds = initial.visibleIds.filter((cid) => {
      const rows = byComment.get(cid) || [];
      // 같은 댓글에 사람의 keep/unhide 결정이 하나라도 있으면 fail-closed. 그 외에는
      // DB hidden, 사람 hide/complete, 미처리 자동숨김 대상을 실제 HIDDEN으로 수렴시킨다.
      return !rows.some((row) => keepDecisions.has(String(row.review_decision || '').trim().toLowerCase()));
    });
    result.repairEligibleVisible = repairableVisibleIds.length;
    result.repairBlockedByDecision = initial.visibleIds.length - repairableVisibleIds.length;

    let verified = initial;
    if (!config.dryRun && repairableVisibleIds.length) {
      const accepted = [];
      for (const batch of chunk(repairableVisibleIds, config.batchSize)) {
        accepted.push(...await hideWithIsolation(config, batch, fetchImpl, sleep, result));
        if (config.requestDelayMs > 0) await sleep(config.requestDelayMs);
      }
      // API code=0은 접수 신호일 뿐이다. 전체 범위를 다시 읽어 실제 HIDDEN인 경우만
      // 복구 성공으로 집계한다. 기존 review_decision/reviewed_by는 감사 원본이라 PATCH하지 않는다.
      verified = await verifyImpl(config, commentIds, fetchImpl, now);
      const initiallyVisible = new Set(repairableVisibleIds);
      result.repairedVisible = verified.hiddenIds.filter((id) => initiallyVisible.has(id)).length;
      result.repairStillVisible = verified.visibleIds.filter((id) => initiallyVisible.has(id)).length;
      const missingAfterRepair = verified.missingIds.filter((id) => initiallyVisible.has(id)).length;
      const acceptedSet = new Set(accepted);
      const notAccepted = repairableVisibleIds.filter((id) => !acceptedSet.has(id)).length;
      if (result.repairStillVisible) {
        result.failed.push({ code: 'verification_visible', error: `${result.repairStillVisible} comment(s) still visible after repair` });
      }
      if (missingAfterRepair) {
        result.failed.push({ code: 'verification_missing', error: `${missingAfterRepair} comment(s) missing during repair verification` });
      }
      // hideWithIsolation already records individual API failures without identifiers.
      if (notAccepted && !result.failed.length) {
        result.failed.push({ code: 'repair_not_accepted', error: `${notAccepted} comment(s) were not accepted for repair` });
      }
    }
    result.verification = {
      hidden: verified.hiddenIds.length,
      visible: verified.visibleIds.length,
      missing: verified.missingIds.length,
      campaigns: verified.campaigns,
      ads: verified.ads,
      adgroups: verified.adgroups,
    };
    result.hidden = verified.hiddenIds.length;
    if (!config.dryRun && result.repairedVisible) {
      const repaired = new Set(repairableVisibleIds.filter((id) => verified.hiddenIds.includes(id)));
      const rows = [...repaired].flatMap((cid) => byComment.get(cid) || []);
      result.slack = await syncHiddenTikTokSlackCards(config, rows, scopedMessages, fetchImpl, sleep, now);
    }
    return result;
  }
  if (config.dryRun || !commentIds.length) return result;

  const hiddenIds = [];
  for (const batch of chunk(commentIds, config.batchSize)) {
    const ok = await hideWithIsolation(config, batch, fetchImpl, sleep, result);
    hiddenIds.push(...ok);
    if (config.requestDelayMs > 0) await sleep(config.requestDelayMs);
  }
  const verified = await verifyImpl(config, hiddenIds, fetchImpl, now);
  result.verification = {
    hidden: verified.hiddenIds.length,
    visible: verified.visibleIds.length,
    missing: verified.missingIds.length,
    campaigns: verified.campaigns,
    ads: verified.ads,
    adgroups: verified.adgroups,
  };
  result.hidden = verified.hiddenIds.length;

  const rowIds = verified.hiddenIds.flatMap((cid) => (byComment.get(cid) || []).map((r) => r.id));
  result.dbUpdated = await persistHiddenRows(config, rowIds, fetchImpl, now);

  if (verified.hiddenIds.length) {
    const rows = verified.hiddenIds.flatMap((cid) => byComment.get(cid) || []);
    result.slack = await syncHiddenTikTokSlackCards(config, rows, scopedMessages, fetchImpl, sleep, now);
  }
  return result;
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## TikTok 광고 댓글 일괄 숨김',
    '',
    `- 모드: ${result.dryRun ? 'DRY RUN(읽기전용)' : '실제 숨김'}`,
    `- 감사 전용: ${result.auditOnly ? '예' : '아니오'}`,
    `- 요청 스레드: ${result.requestedThreads}개 (답글 ${result.scopedSlackReplies}개)`,
    `- 전체 TikTok 미처리 행: ${result.totalSourceUnhiddenRows}`,
    `- 미처리 대상 행: ${result.totalUnhiddenRows} (고유 댓글 ${result.uniqueComments})`,
    `- 이번 대상 댓글: ${result.targetComments}`,
    `- 숨김 성공: ${result.hidden}`,
    result.auditOnly ? `- 실제 공개 복구: 대상 ${result.repairEligibleVisible}, 성공 ${result.repairedVisible}, 여전히 공개 ${result.repairStillVisible}, 사람 결정으로 제외 ${result.repairBlockedByDecision}` : null,
    `- DB 기록: ${result.dbUpdated}`,
    `- 실패: ${result.failed.length}`,
    result.verification ? `- TikTok 상태 재확인: HIDDEN ${result.verification.hidden}, 공개 ${result.verification.visible}, 조회누락 ${result.verification.missing}` : '- TikTok 상태 재확인: (건너뜀)',
    result.slack ? `- Slack 카드: 갱신 ${result.slack.updated}/대상 ${result.slack.eligible} (누락 ${result.slack.unavailable}, 실패 ${result.slack.failed})` : '- Slack 카드: (건너뜀)',
  ].filter(Boolean);
  if (result.failed.length) lines.push('', '### 실패 댓글(식별자 비공개)', ...result.failed.slice(0, 20).map((f) => `- [${f.code ?? '-'}] ${f.error}`));
  await appendFile(file, `${lines.join('\n')}\n`).catch(() => {});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  bulkHideTikTokAlerts()
    .then(async (result) => {
      await writeSummary(result);
      console.log(JSON.stringify(result, null, 2));
      if (result.failed.length || result.repairStillVisible) process.exitCode = 1;
    })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
