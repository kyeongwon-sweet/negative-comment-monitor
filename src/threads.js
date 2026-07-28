// 날짜 × 채널분류별 '부모 스레드' 관리. 부정댓글은 이 스레드의 답글로 발송돼 하루 단위로 묶인다.
// 부모 ts는 alert_threads((kst_date, channel_category, slack_channel_id) → slack_ts)에 저장해 그날 재사용.
// 어떤 실패(테이블 없음/네트워크/슬랙)든 null을 반환해 호출부가 기존 최상위 발송으로 폴백한다.

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function threadsEnabled(config) {
  return Boolean(config && config.supabaseUrl && config.supabaseKey && config.slackBotToken && config.slackChannelId);
}

export function buildThreadParentText(channelCategory, kstDate, assignee = '') {
  const assigneeLine = assignee ? `\n담당자: <@${assignee}>` : '';
  return `🚨 *[${channelCategory || '기타'}]* 부정댓글 · ${kstDate}${assigneeLine}`;
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

// (kst_date, channel_category)별 부모 스레드 ts를 얻거나 없으면 만들어 반환. 실패 시 null(→ 최상위 발송 폴백).
export async function ensureDailyThread(config, { kstDate, channelCategory, assignee = '' }, fetchImpl = fetch) {
  if (!threadsEnabled(config)) return null;
  const category = channelCategory || '기타';
  try {
    const existing = await selectThreadTs(config, kstDate, category, fetchImpl);
    if (existing) return existing;

    // 부모 메시지 발송
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: config.slackChannelId, text: buildThreadParentText(category, kstDate, assignee) }),
    });
    const payload = await res.json();
    if (!payload.ok || !payload.ts) return null;

    // 멱등 저장(동시 실행 레이스 방지: 충돌하면 아래 재조회로 정본 ts 사용)
    await fetchImpl(`${config.supabaseUrl}/rest/v1/alert_threads?on_conflict=kst_date,channel_category,slack_channel_id`, {
      method: 'POST',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({ kst_date: kstDate, channel_category: category, slack_channel_id: config.slackChannelId, slack_ts: payload.ts }),
    });
    const canonical = await selectThreadTs(config, kstDate, category, fetchImpl);
    return canonical || payload.ts;
  } catch {
    return null;
  }
}

// 오늘 스레드 중 답글이 0개(담당자가 모두 처리)인데 완료 반응이 없는 것에 :완료느낌표:를 단다.
// injibot-action(Vercel) 라우트가 버튼 클릭 시 즉시 달지만, 그 라우트 토큰 이슈에도 견고하도록
// 봇이 매 실행마다 백업 점검한다. 봇 토큰(reactions:write 확인됨) 사용, best-effort.
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
      if (!msgs.length) continue;                        // 조회 실패/삭제된 부모 → 건너뜀
      if (msgs.filter((m) => m.ts !== ts).length > 0) continue; // 아직 미처리 답글 있음
      if ((msgs[0].reactions || []).some((x) => x.name === emoji)) continue; // 이미 달림
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
