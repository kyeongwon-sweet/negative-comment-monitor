function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeMrkdwn(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value, max = 700) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildHiddenYouTubeSlackBlocks(row, now = Date.now()) {
  const postUrl = String(row.post_url || '').trim();
  const comment = escapeMrkdwn(truncate(row.comment_text || ''));
  const when = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🚫 *YouTube 댓글 숨김 처리 완료*${postUrl ? `\n<${postUrl}|게시물 열기>` : ''}${comment ? `\n\n*댓글*\n${comment}` : ''}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*숨김 처리 🚫* · YouTube 소유 채널 OAuth · ${when} KST` }],
    },
  ];
}

async function updateOne(config, row, fetchImpl, now) {
  const response = await fetchImpl('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: row.slack_channel_id,
      ts: row.slack_ts,
      text: 'YouTube 댓글 숨김 처리 완료',
      blocks: buildHiddenYouTubeSlackBlocks(row, now),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.ok) return { ok: true };
  return {
    ok: false,
    ratelimited: response.status === 429 || payload.error === 'ratelimited',
    retryAfterMs: Math.max(1000, Number(response.headers?.get?.('retry-after') || 1) * 1000),
  };
}

export async function syncHiddenYouTubeSlackCards(config, rows, fetchImpl = fetch, sleep = wait, now = Date.now()) {
  if (!config.slackBotToken) throw new Error('SLACK_BOT_TOKEN is required for YouTube Slack status sync');
  const eligible = rows.filter((row) => row.slack_channel_id && row.slack_ts);
  let updated = 0;
  let failed = 0;
  for (let index = 0; index < eligible.length; index += 1) {
    const row = eligible[index];
    let result = await updateOne(config, row, fetchImpl, now);
    if (!result.ok && result.ratelimited) {
      await sleep(result.retryAfterMs);
      result = await updateOne(config, row, fetchImpl, now);
    }
    if (result.ok) updated += 1;
    else failed += 1;
    if (index < eligible.length - 1 && config.slackUpdateDelayMs > 0) await sleep(config.slackUpdateDelayMs);
  }
  return { eligible: eligible.length, updated, failed };
}
