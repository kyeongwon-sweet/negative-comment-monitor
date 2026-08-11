function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function threadsEnabled(config) {
  return Boolean(config && config.supabaseUrl && config.supabaseKey && config.slackBotToken && config.slackChannelId);
}

export function buildThreadParentText(kstDate, assignee = '', productLabel = '', category = '') {
  const scope = `[${productLabel || '기타'}] ${category || '기타'}`;
  const assigneeLine = assignee ? `\n담당자: <@${assignee}>` : '';
  return `🚨 *${scope} 부정댓글* · ${kstDate}${assigneeLine}`;
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

// 스레드는 (상품 × 카테고리)별로 분리한다. alert_threads.channel_category 컬럼을
// 스코프 키(예: "쫀득바|바이럴 (배너)")로 재사용해 스키마 변경 없이 유니크를 유지한다.
// scopeKey는 (상품라벨 × 카테고리)마다 유일하며, 해당 스코프의 담당자는 결정적이라 스레드당 1명이다.
export async function ensureDailyThread(config, { kstDate, scopeKey, productLabel = '', category = '', assignee = '' }, fetchImpl = fetch) {
  if (!threadsEnabled(config)) return null;
  const scope = scopeKey || `${productLabel || '기타'}|${category || '기타'}`;
  try {
    const existing = await selectThreadTs(config, kstDate, scope, fetchImpl);
    if (existing) return existing;

    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: config.slackChannelId, text: buildThreadParentText(kstDate, assignee, productLabel, category) }),
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
      if ((parent.reactions || []).some((x) => x.name === emoji)) continue;
      const replies = msgs.filter((m) => m.ts !== ts);
      // 답글을 다 못 받아왔으면(reply_count > 조회된 답글) 처리 여부 확인 불가 → 보수적으로 스킵(오반응 방지).
      if (Number(parent.reply_count || 0) > replies.length) continue;
      // 미처리 카드 = 버튼(actions 블록)이 남아있는 답글. 완료·숨김(삭제)·무시·메타숨김(버튼 제거)은 모두 처리됨.
      // 미처리 카드가 하나도 없으면 = 그 날짜×분류 부정댓글 전부 처리 → 부모에 완료 이모지.
      const unhandled = replies.filter((m) => Array.isArray(m.blocks) && m.blocks.some((b) => b.type === 'actions'));
      if (unhandled.length > 0) continue;
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

// 카드 URL 집합 추출: 알림카드(actions 버튼)의 button value(JSON)에서 게시물 url.
function cardPostUrls_(msgs, parentTs) {
  const urls = new Set();
  for (const m of msgs) {
    if (m.ts === parentTs) continue;
    const act = (m.blocks || []).find((b) => b.type === 'actions');
    if (!act) continue;
    try {
      const u = JSON.parse(act.elements?.[0]?.value || '{}').url;
      if (u) urls.add(String(u));
    } catch { /* 무시 */ }
  }
  return urls;
}

// 고아 복사메시지 정리: 카드가 완료/숨김으로 삭제돼 '복사메시지만 남은' 경우 그 복사메시지를 지운다.
// 복사메시지의 모든 게시물 URL이 스레드 내 살아있는 카드에 없으면(=고아) 삭제. 매 실행 끝에 호출.
export async function cleanupOrphanedCopyMessages(config, kstDate, fetchImpl = fetch) {
  if (!threadsEnabled(config)) return 0;
  try {
    const url = `${config.supabaseUrl}/rest/v1/alert_threads?select=slack_ts`
      + `&kst_date=eq.${encodeURIComponent(kstDate)}`
      + `&slack_channel_id=eq.${encodeURIComponent(config.slackChannelId)}`;
    const res = await fetchImpl(url, { headers: headers(config) });
    if (!res.ok) return 0;
    const rows = await res.json();
    let deleted = 0;
    for (const r of rows) {
      const ts = r.slack_ts;
      if (!ts) continue;
      const rep = await fetchImpl(
        `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(config.slackChannelId)}&ts=${encodeURIComponent(ts)}&limit=100`,
        { headers: { authorization: `Bearer ${config.slackBotToken}` } },
      ).then((x) => x.json()).catch(() => ({}));
      const msgs = rep.messages || [];
      if (msgs.length < 2) continue;
      const cardUrls = cardPostUrls_(msgs, ts);
      for (const m of msgs) {
        if (m.ts === ts || !/^```/.test(m.text || '')) continue;
        const urls = m.text.match(/https?:\/\/[^\s`<>|]+/g) || [];
        if (!urls.length) continue;
        // 하나라도 살아있는 카드가 있으면 유지, 전부 없으면(고아) 삭제.
        if (urls.some((u) => cardUrls.has(u))) continue;
        const del = await fetchImpl('https://slack.com/api/chat.delete', {
          method: 'POST',
          headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ channel: config.slackChannelId, ts: m.ts }),
        }).then((x) => x.json()).catch(() => ({}));
        if (del.ok) deleted += 1;
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}
