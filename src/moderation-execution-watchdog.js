import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSlackAssignees } from './config.js';
import { assigneeForTarget, productGroup, productLabel } from './slack.js';
import { ensureDailyThread } from './threads.js';
import { isUnresolvedModeration, unresolvedKind } from './moderation-state.js';

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
  };
}

export async function loadUnresolvedModerationRows(config, fetchImpl = fetch) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
    url.searchParams.set('select', [
      'id', 'platform', 'source', 'post_url', 'review_decision', 'hidden_confirmed',
      'product_name', 'channel_category', 'channel_name', 'slack_channel_id', 'slack_ts', 'alerted_at',
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

export function buildUnresolvedMessage(config, group) {
  const c = group.counts;
  const assignee = group.assignee ? `<@${group.assignee}> ` : '';
  const links = group.rows.slice(0, config.maxLinksPerMessage)
    .map((row, index) => `• <${slackCardLink(config, row)}|미해결 카드 ${index + 1}>`);
  const omitted = group.rows.length - links.length;
  return [
    `⚠️ *실제 숨김 미확인* · ${group.platform} · ${group.rows.length}건`,
    `${assignee}판정과 플랫폼 실행을 분리해 점검했습니다. 아래 건은 실제 숨김이 확인되지 않았습니다.`,
    `수동 숨김 필요 ${c.manual_hide_required || 0} · API 확인 대기 ${c.hide_pending_confirmation || 0} · 보류 ${c.hold || 0} · 미결 ${c.unreviewed || 0}`,
    ...links,
    ...(omitted > 0 ? [`• 외 ${omitted}건`] : []),
    '_hidden_confirmed=true로 확인된 건만 완료로 집계합니다._',
  ].join('\n');
}

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
  for (const group of groups) {
    const claim = await claimDailyGroup(config, date, group.key, fetchImpl);
    if (!claim.claimed) { deduped += 1; continue; }
    try {
      const threadTs = await ensureDailyThread(config, {
        kstDate: date,
        scopeKey: `${group.label}|${group.category}`,
        productLabel: group.label,
        category: group.category,
        assignee: group.assignee,
      }, fetchImpl);
      await postSlack(config, buildUnresolvedMessage(config, group), threadTs, fetchImpl);
      alerted += 1;
    } catch (error) {
      await releaseClaim(config, claim.runKey, fetchImpl);
      throw error;
    }
  }
  return { unresolved: rows.length, groups: groups.length, alerted, deduped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runModerationExecutionWatchdog()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => { console.error(`[moderation-execution-watchdog] ${error.message}`); process.exitCode = 1; });
}
