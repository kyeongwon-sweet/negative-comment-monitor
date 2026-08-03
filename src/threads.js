function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function threadsEnabled(config) {
  return Boolean(config && config.supabaseUrl && config.supabaseKey && config.slackBotToken && config.slackChannelId);
}

export function buildThreadParentText(kstDate, assignee = '') {
  const assigneeLine = assignee ? `\n담당자: <@${assignee}>` : '';
  return `🚨 부정댓글 · ${kstDate}${assigneeLine}`;
}

async function selectThreadTs(config, kstDate, channelCategory, fetchImpl) {
  const url = `${config.supabaseUrl}/rest/v1/alert_threads`
    + `?select=slack_ts&kst_date=eq.${encodeURIComponent(kstDate)}`
    + `&channel_category=eq.${encodeURIComponent(channelCategory)}`
    + `&slack_channel_id=eq.${encodeURIComponent(config.slackChannelId)}`;
  const res = await fetchImpl(url, { headers: headers(config) });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.slack_ts || null;
}

// 스레드는 담당자별로 분리한다(담당자 1명당 하루 1스레드). alert_threads.channel_category 컬럼을
// 담당자ID 스코프 키로 재사용해 스키마 변경 없이 (kst_date, 담당자, channel) 유니크를 유지한다.
export async function ensureDailyThread(config, { kstDate, assignee = '' }, fetchImpl = fetch) {
  if (!threadsEnabled(config)) return null;
  const scope = assignee || '기타';
  try {
    const existing = await selectThreadTs(config, kstDate, scope, fetchImpl);
    if (existing) return existing;

    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: config.slackChannelId, text: buildThreadParentText(kstDate, assignee) }),
    });
    const payload = await res.json();
    if (!payload.ok || !payload.ts) return null;

    await fetchImpl(`${config.supabaseUrl}/rest/v1/alert_threads?on_conflict=kst_date,channel_category,slack_channel_id`, {
      method: 'POST',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({ kst_date: kstDate, channel_category: scope, slack_channel_id: config.slackChannelId, slack_ts: payload.ts }),
    });
    const canonical = await selectThreadTs(config, kstDate, scope, fetchImpl);
    return canonical || payload.ts;
  } catch {
    return null;
  }
}

export async function markCompletedThreads(config, kstDate, emoji = '완료느낌표', fetchImpl = fetch) {
  if (!threadsEnabled(config)) return 0;
  try {
    const url = `${config.supabaseUrl}/rest/v1/alert_threads?select=slack_ts`
      + `&kst_date=eq.${encodeURIComponent(kstDate)}`
      + `&slack_channel_id=eq.${encodeURIComponent(config.slackChannelId)}`;
    const res = await fetchImpl(url, { headers: headers(config) });
    if (!res.ok) return 0;
    const rows = await res.json();
    let marked = 0;
    for (const r of rows) {
      const ts = r.slack_ts;
      if (!ts) continue;
      const rep = await fetchImpl(
        `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(config.slackChannelId)}&ts=${encodeURIComponent(ts)}&limit=50`,
        { headers: { authorization: `Bearer ${config.slackBotToken}` } },
      ).then((x) => x.json()).catch(() => ({}));
      const msgs = rep.messages || [];
      if (!msgs.length) continue;
      const parent = msgs.find((m) => m.ts === ts) || msgs[0];
      if (Number(parent.reply_count || 0) > 0) continue;
      if (msgs.some((m) => m.ts !== ts)) continue;
      if ((parent.reactions || []).some((x) => x.name === emoji)) continue;
      const add = await fetchImpl('https://slack.com/api/reactions.add', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: config.slackChannelId, timestamp: ts, name: emoji }),
      }).then((x) => x.json()).catch(() => ({}));
      if (add.ok || add.error === 'already_reacted') marked += 1;
    }
    return marked;
  } catch {
    return 0;
  }
}
