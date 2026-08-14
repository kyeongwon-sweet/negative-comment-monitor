import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildYouTubeAdEntries, loadYouTubeAdsConfig } from './youtube-ads.js';

function slackEscape(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function updateCreativeAssigneeBlocks(blocks, adTitle, extraAssignees) {
  if (!Array.isArray(blocks) || !String(adTitle || '').trim() || !extraAssignees?.length) {
    return { blocks, changed: false };
  }
  const next = structuredClone(blocks);
  let changed = false;
  const label = slackEscape(adTitle);

  const main = next.find((block) => block.type === 'section'
    && typeof block.text?.text === 'string'
    && /<https?:\/\/[^|>]+\|[^>]*>/.test(block.text.text));
  if (main) {
    const replaced = main.text.text.replace(/(<https?:\/\/[^|>]+\|)[^>]*(>)/, `$1${label}$2`);
    if (replaced !== main.text.text) {
      main.text.text = replaced;
      changed = true;
    }
  }

  let assigneeBlock = next.find((block) => block.type === 'section'
    && typeof block.text?.text === 'string'
    && block.text.text.startsWith('*담당자*'));
  const existing = assigneeBlock
    ? [...assigneeBlock.text.text.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1])
    : [];
  const assignees = unique([...existing, ...extraAssignees]);
  const text = `*담당자*\n${assignees.map((id) => `<@${id}>`).join(' ')}`;
  if (assigneeBlock) {
    if (assigneeBlock.text.text !== text) {
      assigneeBlock.text.text = text;
      changed = true;
    }
  } else {
    assigneeBlock = { type: 'section', text: { type: 'mrkdwn', text } };
    const actionsIndex = next.findIndex((block) => block.type === 'actions');
    next.splice(actionsIndex >= 0 ? actionsIndex : next.length, 0, assigneeBlock);
    changed = true;
  }
  return { blocks: next, changed };
}

function headers(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

async function loadThreadTs(config, kstDate, fetchImpl) {
  const scope = '쫀득바|인지 광고';
  const url = `${config.supabaseUrl}/rest/v1/alert_threads?select=slack_ts`
    + `&kst_date=eq.${encodeURIComponent(kstDate)}`
    + `&channel_category=eq.${encodeURIComponent(scope)}`
    + `&slack_channel_id=eq.${encodeURIComponent(config.slackChannelId)}&limit=1`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Thread lookup failed (${response.status})`);
  return (await response.json())[0]?.slack_ts || '';
}

async function loadYouTubeAlertRows(config, fetchImpl) {
  const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts`
    + `?select=comment_id,slack_ts&source=eq.youtube_ads`
    + `&slack_channel_id=eq.${encodeURIComponent(config.slackChannelId)}&limit=1000`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Alert lookup failed (${response.status})`);
  return response.json();
}

async function loadThreadReplies(config, threadTs, fetchImpl) {
  const url = 'https://slack.com/api/conversations.replies'
    + `?channel=${encodeURIComponent(config.slackChannelId)}`
    + `&ts=${encodeURIComponent(threadTs)}&limit=999`;
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${config.slackBotToken}` } });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Slack replies: ${payload.error || 'unknown_error'}`);
  if (payload.has_more || payload.response_metadata?.next_cursor) {
    throw new Error('Slack replies exceeded one-page safety limit; no cards were changed');
  }
  return payload.messages || [];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateSlackMessage(config, message, blocks, fetchImpl) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: config.slackChannelId,
        ts: message.ts,
        text: message.text,
        blocks,
      }),
    });
    if (response.status === 429) {
      const retrySeconds = Number(response.headers?.get?.('retry-after') || 3);
      await wait(Math.max(1, retrySeconds) * 1000);
      continue;
    }
    const payload = await response.json();
    if (!payload.ok) throw new Error(`Slack update: ${payload.error || 'unknown_error'}`);
    return;
  }
  throw new Error('Slack update: ratelimited after retries');
}

export async function retagYouTubeAds(config = loadYouTubeAdsConfig(), fetchImpl = fetch, now = Date.now()) {
  const kstDate = String(process.env.RETAG_KST_DATE || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(kstDate)) throw new Error('Missing or invalid RETAG_KST_DATE');
  const collected = await buildYouTubeAdEntries({ ...config, youtubeAdsAlertAfter: '' }, fetchImpl, now);
  const targetByCommentId = new Map();
  for (const entry of collected.entries) {
    for (const comment of entry.comments) targetByCommentId.set(String(comment.id), entry.target);
  }

  const threadTs = await loadThreadTs(config, kstDate, fetchImpl);
  if (!threadTs) throw new Error(`No awareness thread found for ${kstDate}`);
  const [rows, messages] = await Promise.all([
    loadYouTubeAlertRows(config, fetchImpl),
    loadThreadReplies(config, threadTs, fetchImpl),
  ]);
  const messageByTs = new Map(messages.map((message) => [String(message.ts), message]));
  const summary = { scannedAlerts: rows.length, liveCards: 0, mappedCards: 0, updatedCards: 0 };

  for (const row of rows) {
    const message = messageByTs.get(String(row.slack_ts || ''));
    if (!message || !Array.isArray(message.blocks)) continue;
    // 이미 완료·무시된 카드는 다시 태그해 알림을 유발하지 않는다. 미처리 버튼이 있는 카드만 수정한다.
    if (!message.blocks.some((block) => block.type === 'actions')) continue;
    summary.liveCards += 1;
    const target = targetByCommentId.get(String(row.comment_id || ''));
    if (!target?.extraAssignees?.length) continue;
    summary.mappedCards += 1;
    const updated = updateCreativeAssigneeBlocks(message.blocks, target.adTitle, target.extraAssignees);
    if (!updated.changed) continue;
    if (config.youtubeAdsAlertDelayMs > 0) await wait(config.youtubeAdsAlertDelayMs);
    await updateSlackMessage(config, message, updated.blocks, fetchImpl);
    summary.updatedCards += 1;
  }
  console.error(`[youtube-retag] alerts=${summary.scannedAlerts} live=${summary.liveCards} mapped=${summary.mappedCards} updated=${summary.updatedCards}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  retagYouTubeAds()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
