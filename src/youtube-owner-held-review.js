// 소유채널 '모든 댓글 검토 보류' 운영(2026-10-29 결정): 새 댓글은 YouTube가 처음부터 보류(heldForReview)하고,
// 이 봇이 "확실히 괜찮은" 댓글만 공개(published)로 바꾼다. 애매하거나 부정이면 보류에 그대로 두고 슬랙
// 데일리 스레드에 한 번 알린다(사람이 Studio에서 공개 여부 결정). 놓치면 '부정 공개'가 아니라 '공개 지연'이
// 되도록 기본값을 뒤집은 구조다.
//
// 안전장치
// - 채널별 시작시각(설정을 켠 시각) 이후 댓글만 대상. 그 전부터 보류함에 있던 것(봇·사람이 숨긴 부정, 유튜브
//   스팸 보류)은 절대 공개하지 않는다.
// - negative_comment_alerts에 행이 있는 댓글(봇·사람이 이미 판정)은 제외.
// - 한 번 처리한 댓글은 cost_usage_ledger `held-review:<id>`로 다시 보지 않는다(공개·보류 모두).
// - 판정 실패(LLM 오류·예산 소진)면 아무것도 공개하지 않고 원장도 남기지 않는다 → 다음 회차 재시도.
// 공개 레포라 로그에는 개수·채널ID만 남긴다. 댓글 본문은 슬랙(비공개)에만 쓴다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadYouTubeOwnerChannelConfig, inferOwnerVideoProduct, ownerChannelTarget } from './youtube-owner-channel.js';
import { classifyTargetsBatched, isLlmDeferred } from './hybrid-classify.js';
import { loadYouTubeOwnerTokens, refreshAndVerifyOwner } from './youtube-owner-moderation.js';
import { refreshGoogleAccessToken } from './youtube-ads.js';
import { ownerThreadRoute } from './youtube-owner-channel-run.js';
import { ensureDailyThread } from './threads.js';
import { kstDateKey } from './schedule.js';
import { claimGeminiRequestBudget } from './gemini-budget.js';
import { matchesOwnedHardHostility } from './classify.js';

const LEDGER_PREFIX = 'held-review:';

export function isYouTubeQuotaExhausted(error) {
  return /quotaExceeded|dailyLimitExceeded/i.test(String(error?.message || error || ''));
}

// "채널ID@시작시각ISO" 쉼표 목록. 시작시각이 없거나 잘못되면 그 채널은 켜지 않는다(전부 공개 위험 방지).
export function parseHeldReviewChannels(raw) {
  const out = [];
  for (const part of String(raw || '').split(',').map((v) => v.trim()).filter(Boolean)) {
    const [channelId, sinceRaw] = part.split('@').map((v) => String(v || '').trim());
    const since = Date.parse(sinceRaw || '');
    if (!channelId || !Number.isFinite(since)) throw new Error(`HELD_REVIEW_CHANNELS 항목 형식 오류(채널ID@ISO시각): ${part}`);
    out.push({ channelId, since });
  }
  return out;
}

export function loadHeldReviewConfig(env = process.env, now = Date.now()) {
  const base = loadYouTubeOwnerChannelConfig(env, now);
  return {
    ...base,
    heldReviewChannels: parseHeldReviewChannels(env.HELD_REVIEW_CHANNELS),
    heldReviewDryRun: String(env.HELD_REVIEW_DRY_RUN || 'true').toLowerCase() !== 'false',
    heldReviewModel: String(env.HELD_REVIEW_MODEL || base.ownedBrandEscalationModel || 'gemini-3.5-flash-lite').trim(),
    heldReviewMaxPages: Math.max(1, Math.min(50, Number(env.HELD_REVIEW_MAX_PAGES || 20))),
    // 보류함은 최근 이 시간치만 읽는다(페이지 전체가 이보다 오래되면 중단). 15분마다 전체를 읽으면 채널을 늘릴 때
    // 일일 quota 10,000을 넘는다(11-03 먹짱언니 확대 전 계산). 72h = 승인 봇이 사흘 연속 멈춰도 따라잡는 여유.
    heldReviewLookbackHours: Math.max(1, Math.min(24 * 30, Number(env.HELD_REVIEW_LOOKBACK_HOURS || 72))),
    // 공개 직전 2차 관문: 빠른 감시·소유채널 모니터와 같은 부정 분류기에도 걸리지 않아야 공개한다(기본 켬).
    heldReviewNegativeGate: String(env.HELD_REVIEW_NEGATIVE_GATE || 'true').toLowerCase() !== 'false',
  };
}

function sbHeaders(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function inList(ids) {
  return `in.(${ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',')})`;
}

async function googleGet(url, accessToken, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean).join(',');
    throw new Error(`YouTube ${new URL(url).pathname.split('/').at(-1)} failed (${response.status})${reasons ? `: ${reasons}` : ''}`);
  }
  return payload;
}

// 보류 스레드에서 보류 상태인 최상위 댓글·답글을 평평하게 꺼낸다.
export function extractHeldComments(threads) {
  const out = [];
  const push = (comment, videoId, parentId) => {
    const s = comment?.snippet || {};
    if (String(s.moderationStatus || '') !== 'heldForReview') return;
    out.push({
      id: String(comment.id || ''),
      videoId: String(s.videoId || videoId || ''),
      parentId: parentId || '',
      text: String(s.textOriginal ?? s.textDisplay ?? ''),
      author: String(s.authorDisplayName || ''),
      authorChannelId: String(s.authorChannelId?.value || ''),
      publishedAt: String(s.publishedAt || ''),
    });
  };
  for (const thread of threads) {
    const top = thread?.snippet?.topLevelComment;
    const videoId = String(thread?.snippet?.videoId || '');
    push(top, videoId, '');
    for (const reply of thread?.replies?.comments || []) push(reply, videoId, String(top?.id || ''));
  }
  return out.filter((c) => c.id);
}

// 페이지 안 모든 댓글(최상위+답글)이 stopBefore보다 오래됐는가. 목록은 최신순이므로 그 뒤 페이지도 더 오래됐다.
export function pageIsOlderThan(items, stopBefore) {
  if (!Number.isFinite(stopBefore) || !items?.length) return false;
  return items.every((thread) => {
    const times = [thread?.snippet?.topLevelComment, ...(thread?.replies?.comments || [])]
      .map((c) => Date.parse(c?.snippet?.publishedAt || '')).filter(Number.isFinite);
    return times.length > 0 && times.every((t) => t < stopBefore);
  });
}

async function listHeldThreads(config, channelId, accessToken, fetchImpl, stopBefore = NaN) {
  const threads = [];
  let pageToken = '';
  let pages = 0;
  do {
    const url = new URL(`${config.youtubeApiBase}/commentThreads`);
    url.searchParams.set('part', 'snippet,replies');
    url.searchParams.set('allThreadsRelatedToChannelId', channelId);
    url.searchParams.set('moderationStatus', 'heldForReview');
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('textFormat', 'plainText');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const payload = await googleGet(url, accessToken, fetchImpl);
    threads.push(...(payload.items || []));
    pageToken = payload.nextPageToken || '';
    pages += 1;
    if (pageIsOlderThan(payload.items, stopBefore)) return { threads, truncated: false, pages };
  } while (pageToken && pages < config.heldReviewMaxPages);
  return { threads, truncated: Boolean(pageToken), pages };
}

async function existingIds(config, table, column, ids, fetchImpl) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = `${config.supabaseUrl}/rest/v1/${table}?select=${column}&${column}=${encodeURIComponent(inList(chunk))}`;
    const response = await fetchImpl(url, { headers: sbHeaders(config) });
    if (!response.ok) throw new Error(`Supabase ${table} read failed (${response.status})`);
    for (const row of await response.json()) found.add(String(row[column]));
  }
  return found;
}

// 이미 판정된(알림행 있음) 댓글과 처리 원장에 있는 댓글을 뺀, 시작시각 이후 새 보류 댓글.
export function selectNewHeld(held, { since, ownerChannelId, alerted, processed }) {
  return held.filter((c) => {
    const at = Date.parse(c.publishedAt);
    if (!Number.isFinite(at) || at < since) return false;
    if (c.authorChannelId && c.authorChannelId === ownerChannelId) return false;
    if (alerted.has(c.id) || processed.has(`${LEDGER_PREFIX}${c.id}`)) return false;
    return true;
  });
}

const APPROVE_PROMPT_HEAD =
  "당신은 '라라스윗'(저당 아이스크림·디저트 브랜드)이 직접 운영하는 유튜브 채널의 댓글을 공개해도 되는지 고르는 담당입니다.\n" +
  "이 채널은 모든 댓글을 먼저 숨겨 두고, 아래 기준에서 **확실히 괜찮은 댓글만** 공개합니다. 조금이라도 애매하면 공개하지 마세요(approve=false). 공개를 놓쳐도 사람이 나중에 보지만, 잘못 공개하면 브랜드에 해가 됩니다.\n\n" +
  "공개(approve=true)는 이런 경우만:\n" +
  "- 제품·영상·출연자에 대한 칭찬·호감·응원·구매의향 (예: '맛있겠다', '이거 무조건 사야함 개맛있음', '광고 잘 만들었다', '○○님 최고')\n" +
  "- 구매·가격·정보를 묻는 구체적인 질문 (예: '어디서 팔아요?', '얼마에요?', '혹시 bgm 뭘까요?')\n" +
  "- 이모지·감탄·순번(1빠)·친구 태그처럼 내용 없는 무해한 반응\n\n" +
  "공개 금지(approve=false):\n" +
  "- 제품·브랜드·광고에 대한 불만·조롱·냉소·의심 (광고 피로, '이거 광고였어??', 복붙·재탕, 철 지남, 뒷광고, 악플 구경을 기대하는 '설레는 댓글창 열기')\n" +
  "- 유행·인기를 부정 ('한번도 못봤는데', '나만 모름', '처음 봄', '누군데 그래서', '누가 먹음')\n" +
  "- '이게 뭔데', '그게 뭔데', '고1인데 이게 뭔데', '그래서 ○○가 뭔데요;;;'처럼 모른다며 시큰둥하게 되묻는 말(2026-10-30 사람 판정: 숨김)\n" +
  "- 영상 속 장면·설정·가격·판매처 반박 ('품절 아니던데', '온라인도 파는데', '요즘은 3000원이던데')\n" +
  "- 경쟁 제품 언급·비교·'○○맛', '○○랑 비슷', 따라하기·짝퉁 지적, 원산지(중국산) 의심\n" +
  "- 출연자·창작자·광고 속 인물에 대한 비하·욕·외모 지적·조롱 ('싸가지가 없네', '돼지인가', '표정 개꼽네', '멍청')\n" +
  "- 욕설·비속어·패드립, 정치, 다른 연예인·인물 언급, 댓글러끼리 다툼\n" +
  "- 의미가 불분명하거나 비꼬는지 판단이 어려운 말\n";

const APPROVE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { i: { type: 'integer' }, approve: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['i', 'approve', 'reason'],
    additionalProperties: false,
  },
};

export function buildApprovePrompt(comments) {
  return APPROVE_PROMPT_HEAD
    + '\n댓글 목록:\n'
    + comments.map((c, i) => `${i}. ${String(c.text || '').slice(0, 300).replace(/\n/g, ' ')}`).join('\n')
    + '\n\nJSON 배열로만 답하세요: [{"i":번호,"approve":true|false,"reason":"공개 안 하면 한줄 이유(공개면 빈 문자열)"}]';
}

// 반환: [{approve, reason}] 또는 null(실패 → 아무것도 공개하지 않음).
export async function judgeApprovals(config, comments, fetchImpl = fetch, now = Date.now()) {
  if (!comments.length) return [];
  if (!config.geminiKey) return null;
  const out = [];
  for (let start = 0; start < comments.length; start += 25) {
    const chunk = comments.slice(start, start + 25);
    const budget = await claimGeminiRequestBudget({ ...config, geminiQuotaClass: 'escalation' }, fetchImpl, now);
    if (!budget?.allowed) return null;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.heldReviewModel)}:generateContent`;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': config.geminiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildApprovePrompt(chunk) }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: APPROVE_SCHEMA, maxOutputTokens: 2000, temperature: 0 },
        }),
      });
    } catch {
      return null;
    }
    if (!response?.ok) return null;
    const data = await response.json().catch(() => null);
    const text = (data?.candidates || []).flatMap((c) => c?.content?.parts || []).map((p) => p?.text || '').join('');
    let rows;
    try { rows = JSON.parse(String(text).match(/\[[\s\S]*\]/)?.[0] || 'null'); } catch { rows = null; }
    if (!Array.isArray(rows)) return null;
    const byIndex = new Map(rows.filter((r) => Number.isInteger(r?.i)).map((r) => [r.i, r]));
    for (let i = 0; i < chunk.length; i += 1) {
      const row = byIndex.get(i);
      // 누락 응답은 공개하지 않는다(보류 유지). 보류 쪽 실패는 안전하다.
      out.push({ approve: row?.approve === true, reason: String(row?.reason || (row ? '' : '응답 누락')) });
    }
  }
  return out;
}

// 링크·연락처가 든 댓글은 스팸 가능성이 있어 자동 공개하지 않는다(YouTube '기본' 검토가 보류한 건 포함).
const LINK_PATTERN = /(https?:\/\/|www\.|\.com\b|\.kr\b|\.net\b|\.ly\b|t\.me\/|open\.kakao|카톡\s*아이디|텔레그램)/i;

// 공개 직전 2차 관문(11-04 재발방지). 승인 프롬프트만으로 공개한 댓글을 빠른 감시의 부정 분류기가 뒤늦게
// 부정으로 잡는 일이 반복됐고('저거 편의점에 많던데', '테무광고가 좋아지는 영상'), 봇이 한 번 공개한 댓글은
// 다시 숨김(rejected)이 유튜브에서 먹지 않아 스튜디오 삭제만 남았다. 그래서 공개 후보를 같은 분류기에 한 번 더
// 돌려, 부정(alert)이거나 판정이 미뤄지면(LLM 실패·예산) 공개하지 않고 보류로 둔다. 분류 자체가 실패해도 보류.
export async function gateApprovalsWithClassifier(config, channelId, decided, fetchImpl = fetch, classifier = undefined) {
  const candidates = decided.filter((c) => c.approve);
  if (!candidates.length) return decided;
  const channel = (config.youtubeOwnerChannels || []).find((c) => c.channelId === channelId)
    || { channelId, name: channelId, channelCategory: '소유 YouTube' };
  const titles = await loadVideoTitles(config, candidates.map((c) => c.videoId), fetchImpl);
  const byVideo = new Map();
  for (const c of candidates) {
    if (!byVideo.has(c.videoId)) byVideo.set(c.videoId, []);
    byVideo.get(c.videoId).push(c);
  }
  const groups = [...byVideo.entries()];
  const entries = groups.map(([videoId, comments]) => ({
    target: ownerChannelTarget(config, channel, channel.name || channelId, { snippet: { title: titles.get(videoId) || '' } }, videoId, {}),
    comments: comments.map((c) => ({
      id: c.id, platform: 'youtube', text: c.text, timestamp: c.publishedAt, username: c.author, authorChannelId: c.authorChannelId,
    })),
  }));
  let risks = null;
  try {
    risks = await classifyTargetsBatched(entries, config, classifier, {}, fetchImpl);
  } catch {
    risks = null;
  }
  const blocked = new Map();
  groups.forEach(([, comments], g) => comments.forEach((c, i) => {
    const risk = risks?.[g]?.[i];
    if (!risk) blocked.set(c.id, '부정 분류 실패(공개 보류)');
    else if (isLlmDeferred(risk)) blocked.set(c.id, '부정 분류 판정 보류(공개 보류)');
    else if (risk.alert === true) blocked.set(c.id, `부정 분류기: ${risk.category || '부정'}`);
  }));
  return decided.map((c) => (blocked.has(c.id) ? { ...c, approve: false, reason: blocked.get(c.id) } : c));
}

// 하드넷(확정 부정 표현)·링크가 걸리면 모델이 공개라 해도 보류.
export function decideApprovals(comments, verdicts) {
  return comments.map((comment, index) => {
    if (matchesOwnedHardHostility(comment.text)) return { ...comment, approve: false, reason: '부정 확정 표현' };
    if (LINK_PATTERN.test(String(comment.text || ''))) return { ...comment, approve: false, reason: '링크 포함(스팸 가능)' };
    const v = verdicts[index] || { approve: false, reason: '판정 없음' };
    return { ...comment, approve: v.approve === true, reason: v.reason };
  });
}

async function publishComments(config, ids, accessToken, fetchImpl) {
  const ok = [];
  const failed = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = new URL(`${config.youtubeApiBase}/comments/setModerationStatus`);
    url.searchParams.set('id', chunk.join(','));
    url.searchParams.set('moderationStatus', 'published');
    const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.ok) ok.push(...chunk);
    else failed.push(...chunk.map((id) => ({ id, status: response.status })));
  }
  // 공개 확인: comments.list의 moderationStatus(소유자 토큰). published 또는 생략=공개.
  // ⚠️ comments.list는 id와 maxResults를 함께 받지 않는다(400 unexpectedParameter, 11-03 첫 공개 때 실패).
  // 확인 단계가 실패해도 공개 호출은 이미 성공했으므로 throw하지 않고 '미확인'으로 돌려준다.
  const verified = new Set();
  let verifyError = '';
  try {
    for (let i = 0; i < ok.length; i += 50) {
      const url = new URL(`${config.youtubeApiBase}/comments`);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('id', ok.slice(i, i + 50).join(','));
      const payload = await googleGet(url, accessToken, fetchImpl);
      for (const item of payload.items || []) {
        const status = String(item?.snippet?.moderationStatus || 'published');
        if (status === 'published') verified.add(String(item.id));
      }
    }
  } catch (error) {
    verifyError = String(error.message || error).slice(0, 160);
  }
  return { published: ok, verified: [...verified], unverified: ok.filter((id) => !verified.has(id)), failed, verifyError };
}

async function recordProcessed(config, ids, kstDate, fetchImpl) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: sbHeaders(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify(unique.map((id) => ({ run_key: `${LEDGER_PREFIX}${id}`, kst_date: kstDate, apify_usd: 0, anthropic_usd: 0 }))),
  });
  if (!response.ok) throw new Error(`held-review 원장 기록 실패(${response.status})`);
}

async function releaseProcessed(config, ids, fetchImpl) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  try {
    const keys = unique.map((id) => `"${LEDGER_PREFIX}${String(id).replace(/"/g, '')}"`).join(',');
    await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?run_key=${encodeURIComponent(`in.(${keys})`)}`, {
      method: 'DELETE', headers: sbHeaders(config, { Prefer: 'return=minimal' }),
    });
  } catch { /* 지우기 실패 = 그 댓글은 보류로 남는다(공개 안 됨). 안전한 쪽이라 best-effort. */ }
}

async function loadVideoTitles(config, videoIds, fetchImpl) {
  const titles = new Map();
  const ids = [...new Set(videoIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = `${config.supabaseUrl}/rest/v1/youtube_owner_video_state?select=video_id,video_title&video_id=${encodeURIComponent(inList(chunk))}`;
    const response = await fetchImpl(url, { headers: sbHeaders(config) });
    if (!response.ok) continue;
    for (const row of await response.json()) titles.set(String(row.video_id), String(row.video_title || ''));
  }
  return titles;
}

export function heldDigestText(label, kept) {
  const lines = kept.slice(0, 40).map((c) => `• <https://www.youtube.com/watch?v=${c.videoId}&lc=${c.id}|${c.videoId}> ${c.author} — ${String(c.text).replace(/\s+/g, ' ').slice(0, 160)}${c.reason ? ` _(${c.reason})_` : ''}`);
  const more = kept.length > 40 ? `\n…외 ${kept.length - 40}건` : '';
  return `🔒 *[${label}] 소유채널 보류 댓글 ${kept.length}건* — 봇이 공개하지 않고 보류로 둠(부정·애매).\n`
    + `공개할 댓글만 YouTube Studio › 댓글 › '검토를 위해 보류됨'에서 승인하세요. 그대로 두면 계속 비공개입니다.\n`
    + lines.join('\n') + more;
}

async function postDigest(config, kept, now, fetchImpl) {
  const titles = await loadVideoTitles(config, kept.map((c) => c.videoId), fetchImpl);
  const groups = new Map();
  for (const c of kept) {
    const productName = inferOwnerVideoProduct({ id: c.videoId, snippet: { title: titles.get(c.videoId) || '' } }, config.youtubeOwnerDefaultProductName || 'JD');
    const route = ownerThreadRoute({ platform: 'youtube', channelCategory: '소유 YouTube', productName }, config.slackAssignees);
    if (!groups.has(route.scopeKey)) groups.set(route.scopeKey, { route, items: [] });
    groups.get(route.scopeKey).items.push(c);
  }
  let posted = 0;
  for (const { route, items } of groups.values()) {
    const ts = await ensureDailyThread(config, {
      kstDate: kstDateKey(now), scopeKey: route.scopeKey, productLabel: route.label, category: route.category, assignee: route.assignee,
    }, fetchImpl);
    if (!ts) throw new Error('보류 알림 스레드 확보 실패');
    const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: config.slackChannelId, thread_ts: ts, text: heldDigestText(route.label, items), unfurl_links: false }),
    });
    const body = await response.json().catch(() => ({}));
    if (!body.ok) throw new Error(`보류 알림 게시 실패: ${body.error || response.status}`);
    posted += items.length;
  }
  return posted;
}

export async function runHeldReview(config, fetchImpl = fetch, now = Date.now(), classifier = undefined) {
  const summary = { dryRun: config.heldReviewDryRun, model: config.heldReviewModel, channels: [], errors: [] };
  if (!config.heldReviewChannels.length) return { ...summary, note: 'HELD_REVIEW_CHANNELS 비어 있음(기능 꺼짐)' };
  const owners = new Map((await loadYouTubeOwnerTokens(config, fetchImpl)).map((o) => [o.channelId, o]));
  const kstDate = kstDateKey(now);
  for (const { channelId, since } of config.heldReviewChannels) {
    const row = { channelId, since: new Date(since).toISOString(), held: 0, candidates: 0, approved: 0, kept: 0, publishFailed: 0, unverified: 0, truncated: false };
    summary.channels.push(row);
    try {
      const owner = owners.get(channelId);
      if (!owner) throw new Error('owner token 없음');
      // 목록 읽기는 재발급만(검증 호출 1 unit 절약). 실제 공개 직전에만 토큰 소유 채널을 검증한다.
      let accessToken = await refreshGoogleAccessToken(config, owner.refreshToken, fetchImpl);
      const stopBefore = Math.max(since, now - config.heldReviewLookbackHours * 60 * 60 * 1000);
      const { threads, truncated, pages } = await listHeldThreads(config, channelId, accessToken, fetchImpl, stopBefore);
      row.pages = pages;
      row.truncated = truncated;
      const held = extractHeldComments(threads);
      row.held = held.length;
      const recent = held.filter((c) => Date.parse(c.publishedAt) >= since);
      const ids = recent.map((c) => c.id);
      const alerted = ids.length ? await existingIds(config, 'negative_comment_alerts', 'comment_id', ids, fetchImpl) : new Set();
      const processed = ids.length ? await existingIds(config, 'cost_usage_ledger', 'run_key', ids.map((id) => `${LEDGER_PREFIX}${id}`), fetchImpl) : new Set();
      const candidates = selectNewHeld(held, { since, ownerChannelId: channelId, alerted, processed });
      row.candidates = candidates.length;
      if (!candidates.length) continue;
      const verdicts = await judgeApprovals(config, candidates, fetchImpl, now);
      if (!verdicts) throw new Error('공개 판정 실패(LLM 오류·예산) — 아무것도 공개하지 않음');
      const decided = config.heldReviewNegativeGate === true
        ? await gateApprovalsWithClassifier(config, channelId, decideApprovals(candidates, verdicts), fetchImpl, classifier)
        : decideApprovals(candidates, verdicts);
      row.negativeGateBlocked = decided.filter((c) => /^부정 분류/.test(c.reason || '')).length;
      const toApprove = decided.filter((c) => c.approve);
      const kept = decided.filter((c) => !c.approve);
      if (config.heldReviewDryRun) {
        row.approved = toApprove.length;
        row.kept = kept.length;
        continue;
      }
      // 선기록(write-ahead): 공개하기 '전에' 원장을 남긴다. 봇이 공개한 댓글은 예외 없이 원장이 있어야
      // 보류 누락 경보(빠른 감시)가 '봇 승인 없이 공개'로 오탐하지 않는다(11-03 두 번 오탐: 공개 후 확인
      // 단계 실패로 원장 미기록). 원장 쓰기가 실패하면 공개하지 않는다(throw). 공개 호출이 실패한 건만
      // 원장에서 지워 다음 회차에 재시도한다(지우기도 실패하면 그 댓글은 보류로 남는다 = 안전한 쪽).
      const approveIds = toApprove.map((c) => c.id);
      await recordProcessed(config, approveIds, kstDate, fetchImpl);
      const result = approveIds.length
        ? await publishComments(config, approveIds, (accessToken = await refreshAndVerifyOwner(config, owner, fetchImpl)), fetchImpl)
        : { published: [], verified: [], unverified: [], failed: [], verifyError: '' };
      if (result.failed.length) await releaseProcessed(config, result.failed.map((f) => f.id), fetchImpl);
      row.approved = result.verified.length;
      row.unverified = result.unverified.length;
      row.publishFailed = result.failed.length;
      // 보류 유지 건은 알림이 나간 뒤에만 원장에 남긴다(알림 실패 시 다음 회차 재판정·재알림).
      if (kept.length) await postDigest(config, kept, now, fetchImpl);
      await recordProcessed(config, kept.map((c) => c.id), kstDate, fetchImpl);
      row.kept = kept.length;
      // setModerationStatus가 204를 반환한 건은 YouTube가 공개 요청을 접수한 것이다. 직후
      // comments.list에는 전파 지연으로 아직 heldForReview가 보일 수 있으므로 unverified는
      // 관측 지표로만 남긴다. 이를 회차 실패로 세면 실제 장애가 아닌 전파 지연만으로
      // auxiliary health가 연속 실패해 degraded 경고를 낸다(11-03 운영 재현).
      // 반면 POST 자체 실패분은 원장도 해제했으므로 실제 실패로 계속 보고한다.
      if (result.failed.length) {
        summary.errors.push(`${channelId}: 공개 실패 ${result.failed.length}·미확인 ${result.unverified.length}${result.verifyError ? ` (${result.verifyError})` : ''}`);
      }
    } catch (error) {
      row.error = String(error.message || error);
      summary.errors.push(`${channelId}: ${row.error}`);
      // YouTube 일일 quota는 같은 Google 프로젝트의 모든 소유채널에 공통이다. 첫 소진 뒤
      // 나머지 채널을 계속 호출하지 않고 다음 reset 회차에 재개한다(댓글은 보류 상태라 안전).
      if (isYouTubeQuotaExhausted(error)) {
        summary.quotaExhausted = true;
        break;
      }
    }
  }
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runHeldReview(loadHeldReviewConfig())
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (summary.errors.length) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[youtube-owner-held-review] ${error.message}`);
      process.exitCode = 1;
    });
}
