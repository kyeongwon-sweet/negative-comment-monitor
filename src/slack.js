import { createHmac, timingSafeEqual } from 'node:crypto';
import { isManagedChannel, isAdCommentSource } from './routing.js';

const DEFAULT_COMPLETED_THREAD_EMOJI = '\uC644\uB8CC\uB290\uB08C\uD45C';
const managedActions = [['숨김', 'hide', 'danger'], ['승인', 'approve', 'primary'], ['보류', 'hold'], ['숨김해제', 'unhide']];
const externalActions = [['✅ 완료', 'complete', 'primary'], ['🙈 무시', 'ignore']];
const metaAdActions = [['숨김', 'hide', 'danger'], ['🙈 무시', 'ignore']];
const tiktokAdActions = [['숨김', 'hide', 'danger'], ['숨김해제', 'unhide'], ['🙈 무시', 'ignore']];

function button([text, actionId, style], value) {
  return { type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value, ...(style ? { style } : {}) };
}

export function actionDefinitions(target, managedCategories) {
  // 광고(메타·틱톡·유튜브) 댓글은 플랫폼 API로 숨김 가능 → [숨김]/[무시].
  // YouTube는 Vercel이 검증된 channel+ts만 Actions에 전달하고, 소유자 OAuth로 비동기 숨김한다.
  if (target?.source === 'tiktok_ads') return tiktokAdActions;
  if (['meta_ads', 'youtube_ads'].includes(target?.source)) return metaAdActions;
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
// 예(메타): "[26.07]F_V_JD멜_..._260731_빙과_정요한" → 정요한 → <@ID>
// ⚠️ 틱톡은 광고명 끝에 고유 해시가 붙는다(예 "..._빙과_요한_dc811cf2ba") → 해시/숫자 꼬리를 벗겨
//    실제 이름 세그먼트를 찾는다. 또 틱톡은 이름(given name)만 쓰기도 함(요한↔정요한) → 정확 일치가
//    없으면 맵 키 중 그 이름으로 '유일하게' 끝나는 항목만 매칭(모호하면 미매칭=오태그 방지).
export function videoAssigneeFromAdTitle(adTitle, videoAssignees = {}) {
  const parts = String(adTitle || '').split('_').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const isTail = (s) => /^[0-9a-f]{6,}$/i.test(s) || /^\d{5,}$/.test(s); // 해시·날짜 등 꼬리
  let idx = parts.length - 1;
  while (idx > 0 && isTail(parts[idx])) idx -= 1;
  const name = parts[idx];
  if (!name) return '';
  if (videoAssignees[name]) return videoAssignees[name];              // 정확 일치(메타 풀네임)
  const suffix = Object.keys(videoAssignees).filter((k) => k !== name && k.endsWith(name));
  return suffix.length === 1 ? videoAssignees[suffix[0]] : '';         // 유일 접미 일치만(요한→정요한)
}

// 상품군 → 스레드 라벨(표시명). jd=쫀득바, p=파인트, 그 외=기타.
export function productLabel(group) {
  if (group === 'jd') return '쫀득바';
  if (group === 'p') return '파인트';
  return '기타';
}

// 상품명이 있는지(공백 제외). 상품명이 없는 제품(위성/온드 등 미지정)은 부정댓글 알림 대상에서 제외한다.
// 주의: '기타' 라벨은 빈 상품명 + 이름은 있으나 미매칭(듬뿍바 DB/C/ZB/BA 등)을 함께 포함하므로,
// 라벨('기타')이 아니라 상품명 원본이 비었는지로 판정해야 명명된 기타 제품을 잘못 제외하지 않는다.
export function hasProductName(target) {
  return String(target?.productName || '').trim().length > 0;
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
  const isPowerChannel = category.includes('파워채널') || category.includes('매거진'); // 협찬 (파워채널/매거진)
  const isOwned = category.includes('온드'); // 온드미디어
  const isAwareness = category.includes('인지'); // 인지(메타) 광고 부정댓글 전용 담당자
  if (group === 'jd') {
    // 쫀득바 협찬(인플루언서)만 김바다. 파워채널/매거진은 매치 제외 → 아래로 흘러 other(황경원).
    if (isSponsorship && !isPowerChannel && assignees.jd?.sponsorship) return assignees.jd.sponsorship;
    if (isBanner && assignees.jd?.viralBanner) return assignees.jd.viralBanner;
    if (isVideo && assignees.jd?.viralVideo) return assignees.jd.viralVideo;
    if (isSatellite && assignees.jd?.satellite) return assignees.jd.satellite;
  } else if (group === 'p') {
    if (isPowerChannel && assignees.p?.powerChannel) return assignees.p.powerChannel; // 파인트 파워채널=이도경
    if (isSponsorship && assignees.p?.sponsorship) return assignees.p.sponsorship;     // 파인트 협찬(인플루언서)=손유곤
    if (isBanner && assignees.p?.viralBanner) return assignees.p.viralBanner;
    if (isVideo && assignees.p?.viralVideo) return assignees.p.viralVideo;
  }
  // 온드미디어는 상품군 무관 전담(김바다). 위성채널은 상품군 무관 이세진(base satellite).
  if (isOwned && assignees.owned) return assignees.owned;
  if (isSatellite && assignees.satellite) return assignees.satellite;
  // 인지 광고는 상품군과 무관하게 전용 담당자로. 미지정이면 기존 기본값(other)로 폴백.
  if (isAwareness && assignees.awareness) return assignees.awareness;
  return assignees.other || '';
}

// 인스타그램 게시물 permalink + 댓글 id → 댓글 직링크(그 댓글로 점프). 예:
//   https://www.instagram.com/p/ABC/  +  123  →  https://www.instagram.com/p/ABC/c/123/
// instagram + 숫자 comment id일 때만. 그 외(유튜브/틱톡/비표준 URL)는 원본 URL 유지.
// 공개 지면 댓글은 점프됨. 광고 전용 지면 댓글은 여전히 안 보이지만 원본 대비 손해 없음.
export function commentDeepLink(url, platform, commentId) {
  const u = String(url || '').trim();
  const cid = String(commentId || '').trim();
  if (String(platform || '') !== 'instagram' || !/^\d+$/.test(cid)) return u;
  const m = u.match(/^(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[^/?#]+)\/?/i);
  if (!m) return u;
  return `${m[1]}/c/${cid}/`;
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
    channelCategory: target.channelCategory || '',
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
  // 링크는 댓글 직링크(instagram + 숫자 comment id일 때). 공개 지면 댓글은 클릭 시 그 댓글로 점프.
  const linkUrl = commentDeepLink(target.url, comment.platform, comment.id);
  const mainLine = `<${linkUrl}|${channel}>${companyPart} / ${author} / ${text}`;
  const baseAssignee = assigneeForTarget(target, assignees);
  const extras = (Array.isArray(target.extraAssignees) ? target.extraAssignees : []).filter(Boolean);
  // 인지 광고(메타·틱톡·유튜브) 카드는 제작자(영상담당자)만 태그한다(부모 스레드 담당자는 별도 유지).
  //   - 제작자가 매핑되면 그 사람만, 매핑 없으면 baseAssignee(awareness)로 폴백해 담당자 공란 방지.
  // 그 외 채널은 기존대로 기본 담당자 + 추가 태그.
  // 인지 광고 + 모든 바이럴(배너·영상) 개별 카드는 소재명의 영상 제작자만 태그한다.
  //   - 제작자(extras)가 있으면 그 사람만, 없으면 baseAssignee로 폴백(담당자 공란 방지).
  //   - 그 외 채널(협찬·위성·온드 등)은 기존대로 기본 담당자 + 추가 태그.
  // 최우선 override: 상품명 또는 소재명(asset_name/광고명)에 'JD복'이 들어가면
  // 카테고리·제작자 무관하게 지정 담당자(이재원). 협찬은 asset_name이 비는 경우가 있어
  // product_name도 반드시 함께 확인한다.
  const soje = String(target.assetName || target.adTitle || '');
  const productName = String(target.productName || '');
  const jdBok = (/JD복/i.test(soje) || /JD복/i.test(productName)) ? (assignees.jdBok || '') : '';
  const isCreatorCard = isAdCommentSource(target) || isViral;
  const assigneeIds = jdBok
    ? [jdBok]
    : isCreatorCard
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

// 스레드에 Block Kit 답글 발송. text는 알림/접근성용 fallback으로 항상 함께 보낸다.
export async function postThreadBlocks(config, threadTs, text, blocks, fetchImpl = fetch) {
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: config.slackChannelId,
      text,
      blocks,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    }),
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
