import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSlackAssignees } from './config.js';
import { assigneeForTarget, productGroup, productLabel } from './slack.js';
import { ensureDailyThread } from './threads.js';
import {
  MANUAL_HIDE_REQUIRED,
  canRequestAutomaticHide,
  isUnresolvedModeration,
  unresolvedKind,
} from './moderation-state.js';

function clean(value) {
  return String(value ?? '').trim();
}

function required(env, name) {
  const value = clean(env[name]);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export function kstDate(now = Date.now()) {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

export function loadModerationExecutionWatchdogConfig(env = process.env, now = Date.now()) {
  return {
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackBotToken: required(env, 'SLACK_BOT_TOKEN'),
    slackChannelId: clean(env.SLACK_CHANNEL_ID) || 'C0BHD9S69JA',
    slackWorkspaceHost: clean(env.SLACK_WORKSPACE_HOST) || 'lalasweethq.slack.com',
    slackAssignees: loadSlackAssignees(env, now),
    managedChannelCategories: clean(env.MANAGED_CHANNEL_CATEGORIES || '온드미디어,위성채널')
      .split(',').map((value) => value.trim()).filter(Boolean),
    maxLinksPerMessage: Math.max(1, Math.min(30, Number(env.MODERATION_WATCHDOG_MAX_LINKS || 12))),
    reissuePostIntervalMs: Math.max(0, Number(env.MODERATION_WATCHDOG_REISSUE_INTERVAL_MS ?? 1100) || 0),
  };
}

export async function loadUnresolvedModerationRows(config, fetchImpl = fetch) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
    url.searchParams.set('select', [
      'id', 'platform', 'source', 'post_url', 'review_decision', 'hidden_confirmed',
      'product_name', 'channel_category', 'channel_name', 'slack_channel_id', 'slack_ts', 'alerted_at',
      'comment_text',
    ].join(','));
    url.searchParams.set('hidden_confirmed', 'eq.false');
    url.searchParams.set('channel_category', 'not.is.null');
    url.searchParams.set('or', '(review_decision.is.null,review_decision.in.(hide,hold,manual_hide_required))');
    url.searchParams.set('order', 'alerted_at.asc');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '1000');
    const response = await fetchImpl(url, { headers: headers(config) });
    if (!response.ok) throw new Error(`Unresolved moderation lookup failed (${response.status})`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  // category 이전 레거시(null/공백)는 대표 승인 전까지 의도적으로 건드리지 않는다.
  return rows.filter((row) => clean(row.channel_category) && isUnresolvedModeration(row));
}

function targetFromRow(row) {
  return {
    platform: clean(row.platform).toLowerCase(),
    source: row.source == null ? '' : clean(row.source),
    productName: clean(row.product_name),
    channelCategory: clean(row.channel_category),
    channelName: clean(row.channel_name),
  };
}

export function groupUnresolvedModerationRows(rows, config) {
  const groups = new Map();
  for (const row of rows) {
    const target = targetFromRow(row);
    const label = productLabel(productGroup(target.productName));
    const category = target.channelCategory;
    const platform = target.platform || 'unknown';
    const key = `${label}|${category}|${platform}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, label, category, platform,
        assignee: assigneeForTarget(target, config.slackAssignees),
        rows: [], counts: { unreviewed: 0, hold: 0, manual_hide_required: 0, hide_pending_confirmation: 0 },
      });
    }
    const group = groups.get(key);
    const kind = unresolvedKind({ ...row, ...target }, config.managedChannelCategories);
    group.rows.push(row);
    group.counts[kind] = (group.counts[kind] || 0) + 1;
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}

function slackCardLink(config, row) {
  const channel = clean(row.slack_channel_id);
  const ts = clean(row.slack_ts).replace('.', '');
  return channel && ts ? `https://${config.slackWorkspaceHost}/archives/${channel}/p${ts}` : clean(row.post_url);
}

export function unresolvedActionLink(config, row, index = 0) {
  const target = targetFromRow(row);
  const kind = unresolvedKind({ ...row, ...target }, config.managedChannelCategories);
  const manual = kind === MANUAL_HIDE_REQUIRED
    || !canRequestAutomaticHide(target, config.managedChannelCategories);
  const postUrl = clean(row.post_url);

  // TikTok organic and third-party sponsorship cards may have been removed while the
  // actual manual action point remains the platform post. Do not send operators to a
  // stale Slack permalink for rows the bot cannot moderate through an API.
  // 2026-10-21: 그런데 링크가 게시물뿐이라, 플랫폼에서 직접 숨긴 담당자가 [✅ 완료]를 누를
  // 원래 카드를 찾지 못해 같은 건이 매일 다시 경고됐다(바치케 배너 IG, 10-03 카드). 카드가 남아 있으면
  // 처리 카드 링크도 함께 준다(완료를 누르면 카드는 삭제되고 그 행은 미해결에서 빠진다).
  if (manual && postUrl) {
    // 카드가 지워졌을 수 있으므로(죽은 링크 방지) 실제 존재가 확인된 카드만 붙인다(markLiveCards).
    const thread = clean(row.card_thread_ts);
    const cardUrl = row.card_alive === true
      ? `${slackCardLink(config, row)}${thread ? `?thread_ts=${thread}&cid=${clean(row.slack_channel_id)}` : ''}`
      : '';
    return { url: postUrl, label: '▶ 영상 열기', manual: true, ...(cardUrl ? { cardUrl } : {}) };
  }

  return {
    url: slackCardLink(config, row),
    label: `미해결 카드 ${index + 1}`,
    manual,
  };
}

export function buildUnresolvedMessage(config, group) {
  const c = group.counts;
  const assignee = group.assignee ? `<@${group.assignee}> ` : '';
  const links = group.rows.slice(0, config.maxLinksPerMessage)
    .map((row, index) => unresolvedActionLink(config, row, index))
    .map(({ url, label, cardUrl }) => `• <${url}|${label}>${cardUrl ? ` · <${cardUrl}|처리 카드>` : ''}`);
  const omitted = group.rows.length - links.length;
  return [
    `⚠️ *실제 숨김 미확인* · ${group.platform} · ${group.rows.length}건`,
    `${assignee}판정과 플랫폼 실행을 분리해 점검했습니다. 아래 건은 실제 숨김이 확인되지 않았습니다.`,
    `수동 숨김 필요 ${c.manual_hide_required || 0} · API 확인 대기 ${c.hide_pending_confirmation || 0} · 보류 ${c.hold || 0} · 미결 ${c.unreviewed || 0}`,
    ...links,
    ...(omitted > 0 ? [`• 외 ${omitted}건`] : []),
    '_플랫폼에서 직접 숨겼다면 *처리 카드*에서 [✅ 완료]를 눌러 주세요. 오탐이면 [🙈 무시]. 누르기 전까지는 매일 다시 알립니다._',
  ].join('\n');
}

// 수동 숨김 대상 행의 원래 카드가 슬랙에 아직 있는지 확인한다(conversations.replies는 답글 ts로도 그 메시지를 돌려준다).
// card_alive: true=있음, false=슬랙이 '없다'고 확답(재발급 대상), null=확인 실패(링크도 재발급도 안 함 — 일시 오류로 중복 카드 방지).
const CARD_GONE_ERRORS = new Set(['thread_not_found', 'message_not_found']);
export async function markLiveCards(config, rows, fetchImpl = fetch) {
  for (const row of rows) {
    const channel = clean(row.slack_channel_id);
    const ts = clean(row.slack_ts);
    if (!channel || !ts) continue;
    try {
      const url = new URL('https://slack.com/api/conversations.replies');
      url.searchParams.set('channel', channel);
      url.searchParams.set('ts', ts);
      url.searchParams.set('limit', '1');
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.slackBotToken}` } });
      const payload = await response.json().catch(() => ({}));
      const card = payload.ok ? (payload.messages || []).find((message) => message.ts === ts) : null;
      if (card) row.card_alive = true;
      else if (payload.ok || CARD_GONE_ERRORS.has(payload.error)) row.card_alive = false;
      else { row.card_alive = null; continue; }
      // 카드는 스레드 답글이라 thread_ts가 있어야 링크가 그 답글로 바로 열린다.
      if (card?.thread_ts && card.thread_ts !== ts) row.card_thread_ts = card.thread_ts;
    } catch {
      row.card_alive = null;
    }
  }
  return rows;
}

function slackText(value, max = 300) {
  const text = clean(value).replace(/\s+/g, ' ').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 원래 카드가 지워진 수동 처리 대상에 [✅ 완료]/[🙈 무시] 카드를 다시 만든다(2026-10-21: 14건이
// 누를 버튼 없이 매일 재경고). 버튼 클릭은 기존 Vercel injibot-action이 (채널, ts)로 행을 찾아
// complete/false_positive를 기록하므로, 새 카드의 ts를 행에 다시 적어 주기만 하면 된다.
// value는 라우트가 분기에 쓰는 source/platform/channelCategory만 담는다(댓글 원문·ID 없음).
export function buildReissuedCardBlocks(row) {
  const value = JSON.stringify({
    source: row.source == null ? '' : clean(row.source),
    platform: clean(row.platform).toLowerCase(),
    channelCategory: clean(row.channel_category),
  });
  const postUrl = clean(row.post_url);
  const quote = clean(row.comment_text) ? `> ${slackText(row.comment_text)}\n` : '';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `🔁 *처리 카드 재발급* · ${slackText(row.channel_category)} · ${slackText(row.platform)}\n원래 카드가 지워져 다시 만들었습니다. 플랫폼에서 직접 숨겼다면 [✅ 완료], 오탐이면 [🙈 무시].` } },
    { type: 'section', text: { type: 'mrkdwn', text: `${quote}${postUrl ? `<${postUrl}|▶ 영상 열기>` : '(게시물 링크 없음)'}` } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '✅ 완료' }, action_id: 'complete', value, style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: '🙈 무시' }, action_id: 'ignore', value },
    ] },
  ];
}

async function slackCall(config, method, body, fetchImpl) {
  const response = await fetchImpl(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => ({}));
}

// markLiveCards 뒤에 호출: card_alive === false인 행만 재발급. 행 갱신이 실패하면 새 카드를 지운다
// (눌러도 기록될 행이 없는 고아 카드를 남기지 않는다).
export async function reissueDeadCards(config, rows, threadTs, fetchImpl = fetch) {
  let reissued = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.card_alive !== false || !Number.isSafeInteger(Number(row.id))) continue;
    if (reissued + failed > 0 && config.reissuePostIntervalMs > 0) await wait(config.reissuePostIntervalMs);
    const posted = await slackCall(config, 'chat.postMessage', {
      channel: config.slackChannelId,
      text: '처리 카드 재발급',
      blocks: buildReissuedCardBlocks(row),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }, fetchImpl);
    if (!posted.ok || !posted.ts) { failed += 1; continue; }
    const channel = clean(posted.channel) || config.slackChannelId;
    let linked = false;
    try {
      const response = await fetchImpl(
        `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=eq.${Number(row.id)}&hidden_confirmed=eq.false`,
        {
          method: 'PATCH',
          headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
          body: JSON.stringify({ slack_channel_id: channel, slack_ts: posted.ts }),
        },
      );
      linked = response.ok && (await response.json().catch(() => [])).length === 1;
    } catch { linked = false; }
    if (!linked) {
      await slackCall(config, 'chat.delete', { channel, ts: posted.ts }, fetchImpl).catch(() => ({}));
      failed += 1;
      continue;
    }
    Object.assign(row, { slack_channel_id: channel, slack_ts: posted.ts, card_alive: true, ...(threadTs ? { card_thread_ts: threadTs } : {}) });
    reissued += 1;
  }
  return { reissued, failed };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function claimDailyGroup(config, date, groupKey, fetchImpl) {
  const digest = createHash('sha256').update(groupKey).digest('hex').slice(0, 16);
  const runKey = `moderation-unconfirmed:${date}:${digest}`;
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify({ run_key: runKey, kst_date: date, apify_usd: 0, anthropic_usd: 0 }),
  });
  if (!response.ok) throw new Error(`Moderation watchdog claim failed (${response.status})`);
  const rows = await response.json();
  return { claimed: Array.isArray(rows) && rows.length > 0, runKey };
}

async function releaseClaim(config, runKey, fetchImpl) {
  try {
    await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?run_key=eq.${encodeURIComponent(runKey)}`, {
      method: 'DELETE', headers: headers(config, { Prefer: 'return=minimal' }),
    });
  } catch { /* Slack 실패 시 다음 회차 재시도를 위한 best-effort */ }
}

async function postSlack(config, text, threadTs, fetchImpl) {
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Slack API: ${payload.error || response.status}`);
}

export async function runModerationExecutionWatchdog(
  config = loadModerationExecutionWatchdogConfig(), fetchImpl = fetch, now = Date.now(),
) {
  const rows = await loadUnresolvedModerationRows(config, fetchImpl);
  const groups = groupUnresolvedModerationRows(rows, config);
  const date = kstDate(now);
  let alerted = 0;
  let deduped = 0;
  let reissued = 0;
  let reissueFailed = 0;
  for (const group of groups) {
    const claim = await claimDailyGroup(config, date, group.key, fetchImpl);
    if (!claim.claimed) { deduped += 1; continue; }
    try {
      const manualShown = group.rows.slice(0, config.maxLinksPerMessage).filter((row) => unresolvedActionLink(config, row).manual);
      await markLiveCards(config, manualShown, fetchImpl);
      const threadTs = await ensureDailyThread(config, {
        kstDate: date,
        scopeKey: `${group.label}|${group.category}`,
        productLabel: group.label,
        category: group.category,
        assignee: group.assignee,
      }, fetchImpl);
      // 요약보다 먼저 재발급해야 요약의 '처리 카드' 링크가 새 카드를 가리킨다.
      const reissue = await reissueDeadCards(config, manualShown, threadTs, fetchImpl);
      reissued += reissue.reissued;
      reissueFailed += reissue.failed;
      await postSlack(config, buildUnresolvedMessage(config, group), threadTs, fetchImpl);
      alerted += 1;
    } catch (error) {
      await releaseClaim(config, claim.runKey, fetchImpl);
      throw error;
    }
  }
  return { unresolved: rows.length, groups: groups.length, alerted, deduped, reissued, reissueFailed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runModerationExecutionWatchdog()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => { console.error(`[moderation-execution-watchdog] ${error.message}`); process.exitCode = 1; });
}
