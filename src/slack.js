import { createHmac, timingSafeEqual } from 'node:crypto';
import { isManagedChannel } from './routing.js';

const DEFAULT_COMPLETED_THREAD_EMOJI = '\uC644\uB8CC\uB290\uB08C\uD45C';
const managedActions = [['숨김', 'hide', 'danger'], ['승인', 'approve', 'primary'], ['보류', 'hold'], ['숨김해제', 'unhide']];
const externalActions = [['✅ 완료', 'complete', 'primary'], ['🙈 무시', 'ignore']];
const metaAdActions = [['숨김', 'hide', 'danger'], ['🙈 무시', 'ignore']];

function button([text, actionId, style], value) {
  return { type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value, ...(style ? { style } : {}) };
}

export function actionDefinitions(target, managedCategories) {
  if (target?.source === 'meta_ads') return metaAdActions;
  return isManagedChannel(target, managedCategories) ? managedActions : externalActions;
}

export function assigneeForChannelCategory(channelCategory, assignees = {}) {
  const category = String(channelCategory || '').trim().toLowerCase();
  if (category.includes('위성채널')) return assignees.satellite || '';
  if (category.includes('바이럴') && category.includes('배너')) return assignees.viralBanner || '';
  if ((category.includes('바이럴') && category.includes('영상')) || category.includes('온드미디어')) {
    return assignees.viralVideoOwned || '';
  }
  if (category.includes('협찬')) return assignees.sponsorship || '';
  return assignees.other || '';
}

// 상품 코드(sponsored_posts.product_name)로 상품군 판정.
//   - 'jd 들어간 상품'(JD멜/JD망/JD혼=쫀득바) → 'jd'
//   - 'p로 시작하는 상품'(P혼/P망=파인트) → 'p'
//   - 그 외(듬뿍바 DB·C·ZB·BA 등) → 'other'(기존 카테고리 담당자 유지)
export function productGroup(productName) {
  const p = String(productName || '').trim().toLowerCase();
  if (!p) return 'other';
  if (p.includes('jd')) return 'jd';
  if (p.startsWith('p')) return 'p';
  return 'other';
}

// 광고 이름 마지막 '_' 뒤 이름 = 영상 담당자. 매핑(이름→Slack ID)에서 변환, 없으면 ''.
// 예: "[26.07]F_V_JD멜_..._260731_빙과_정요한" → 정요한 → <@ID>
export function videoAssigneeFromAdTitle(adTitle, videoAssignees = {}) {
  const parts = String(adTitle || '').split('_');
  const name = parts.length ? parts[parts.length - 1].trim() : '';
  if (!name) return '';
  return videoAssignees[name] || '';
}

// 상품군 → 스레드 라벨(표시명). jd=쫀득바, p=파인트, 그 외=기타.
export function productLabel(group) {
  if (group === 'jd') return '쫀득바';
  if (group === 'p') return '파인트';
  return '기타';
}

// 담당자 라우팅 = (상품군 × 채널카테고리).
//   - JD/P 상품의 지정 조합은 해당 담당자로.
//   - 그 외(기타 제품 DB·C·ZB·BA 등 + 기타 채널 + 미지정 조합)는 모두 담당자 other(황경원).
export function assigneeForTarget(target, assignees = {}) {
  const category = String(target?.channelCategory || '').trim().toLowerCase();
  const group = productGroup(target?.productName);
  const isBanner = category.includes('바이럴') && category.includes('배너');
  const isVideo = category.includes('바이럴') && category.includes('영상');
  const isSatellite = category.includes('위성채널');
  const isSponsorship = category.includes('협찬');
  if (group === 'jd') {
    if (isSponsorship && assignees.jd?.sponsorship) return assignees.jd.sponsorship;
    if (isBanner && assignees.jd?.viralBanner) return assignees.jd.viralBanner;
    if (isVideo && assignees.jd?.viralVideo) return assignees.jd.viralVideo;
    if (isSatellite && assignees.jd?.satellite) return assignees.jd.satellite;
  } else if (group === 'p') {
    if (isBanner && assignees.p?.viralBanner) return assignees.p.viralBanner;
    if (isVideo && assignees.p?.viralVideo) return assignees.p.viralVideo;
  }
  return assignees.other || '';
}

function esc(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Slack 블록/텍스트 길이 방어. 긴 댓글이 블록 한도(section text 3000자)를 넘기지 않게 자른다.
function truncate(text, max = 500) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 작성시간을 KST 'YYYY-MM-DD HH:mm KST'로. epoch(초/밀리초)·ISO 모두 처리.
export function formatKst(ts) {
  if (!ts && ts !== 0) return '-';
  const s = String(ts).trim();
  let ms;
  if (/^\d{9,}$/.test(s)) ms = Number(s) * (s.length <= 10 ? 1000 : 1);
  else { const t = Date.parse(s); if (!Number.isFinite(t)) return s; ms = t; }
  const k = new Date(ms + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 16).replace('T', ' ') + ' KST';
}

export function buildAlertBlocks(target, comment, managedCategories = ['온드미디어', '위성채널'], assignees = {}) {
  const value = JSON.stringify({
    row: target.row,
    commentId: comment.id,
    platform: comment.platform,
    url: target.url,
    source: target.source || '',
  });
  const reason = comment.risk?.matchedTerms?.join(', ') || comment.risk?.reason || '부정 표현';
  // 채널명(업체명) / 작성자 / 댓글 — 한 라인. 채널명은 게시글 링크, 업체명은 바이럴만.
  const isViral = /바이럴/.test(target.channelCategory || '');
  const company = esc(String(target.company || '').trim());
  // 링크 텍스트: 메타 광고는 광고 이름 원본(adTitle), 그 외는 채널명.
  const channel = esc(target.adTitle || target.channelName || '-');
  const author = esc(comment.username || '-');
  const text = esc(truncate(String(comment.text || '').replace(/\s+/g, ' ').trim()));
  const companyPart = (isViral && company) ? ` (${company})` : '';
  const mainLine = `<${target.url}|${channel}>${companyPart} / ${author} / ${text}`;
  const baseAssignee = assigneeForTarget(target, assignees);
  const extras = (Array.isArray(target.extraAssignees) ? target.extraAssignees : []).filter(Boolean);
  // 메타 광고 카드는 제작자(영상담당자)만 태그한다(부모 스레드 담당자=황경원은 별도 유지).
  //   - 제작자가 매핑되면 그 사람만, 매핑 없으면 황경원(other)으로 폴백해 담당자 공란 방지.
  // 그 외 채널은 기존대로 기본 담당자 + 추가 태그.
  const isMetaAd = String(target?.source || '') === 'meta_ads';
  const assigneeIds = isMetaAd
    ? [...new Set((extras.length ? extras : (baseAssignee ? [baseAssignee] : [])))]
    : [...new Set([baseAssignee, ...extras].filter(Boolean))];
  return [
    { type: 'header', text: { type: 'plain_text', text: `🚨 부정댓글 감지 — ${comment.platform}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*[${esc(productLabel(productGroup(target.productName)))}] ${esc(target.channelCategory || '-')}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: mainLine } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*현재상태*\n미처리 ⏳' },
      { type: 'mrkdwn', text: `*작성시간*\n${formatKst(comment.timestamp)}` },
    ] },
    { type: 'section', text: { type: 'mrkdwn', text: `*분류 근거*\n${esc(reason)}` } },
    ...(assigneeIds.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*담당자*\n${assigneeIds.map((id) => `<@${id}>`).join(' ')}` } }] : []),
    { type: 'actions', elements: actionDefinitions(target, managedCategories).map((definition) => button(definition, value)) },
  ];
}

export async function sendAlert(config, target, comment, fetchImpl = fetch, threadTs = null) {
  if (!config.slackBotToken) throw new Error('Missing environment variable: SLACK_BOT_TOKEN');
  const blocks = buildAlertBlocks(target, comment, config.managedChannelCategories, config.slackAssignees);
  if (threadTs) {
    await fetchImpl('https://slack.com/api/reactions.remove', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: config.slackChannelId,
        timestamp: threadTs,
        name: config.completedThreadEmoji || DEFAULT_COMPLETED_THREAD_EMOJI,
      }),
    }).then((x) => x.json()).catch(() => ({}));
  }
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: config.slackChannelId,
      text: `부정댓글 감지: ${truncate(comment.text, 200)}`,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),   // 날짜×분류 스레드에 답글로. 없으면 최상위 발송.
    }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

// 바이럴(영상/배너) 업체별 복사용 메시지. 담당자가 그대로 복사해 업체에 보낼 수 있게.
//   [업체명]
//
//   담당자님 하기 게시물 댓글 관리 부탁 드립니다!
//   <게시물 URL들>
// items: [{ url, nickname, text }] — 부정댓글별로 "링크 / 닉네임 / 댓글내용" 한 줄. (url+text로 중복 제거)
// 코드블록으로 감싸 Slack 자체 [복사] 버튼 노출. 코드블록을 깨는 백틱은 제거.
export function buildViralCopyMessage(company, items) {
  const head = String(company || '').replace(/`/g, '').trim() || '-';
  const seen = new Set();
  const lines = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const url = String(it?.url || '').trim();
    const nick = (String(it?.nickname || '').replace(/`/g, '').trim()) || '-';
    const text = String(it?.text || '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
    if (!url && !text) continue;
    const key = `${url}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${url} / ${nick} / ${text}`);
  }
  return `\`\`\`\n[${head}]\n\n담당자님 하기 게시물에 광고의심 및 부정댓글 관리 부탁 드립니다!\n${lines.join('\n')}\n\`\`\``;
}

// 스레드에 일반 텍스트 답글 발송(복사용 메시지 등). 링크 미리보기(unfurl) 끔.
export async function postThreadText(config, threadTs, text, fetchImpl = fetch) {
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false }),
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(`Slack API: ${payload.error || 'unknown_error'}`);
  return payload;
}

export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!signingSecret || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const left = Buffer.from(expected); const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
