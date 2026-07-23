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
