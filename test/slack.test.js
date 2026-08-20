import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { actionDefinitions, assigneeForChannelCategory, assigneeForTarget, buildAlertBlocks, buildViralCopyMessage, commentDeepLink, hasProductName, productGroup, productLabel, sendAlert, verifySlackSignature, videoAssigneeFromAdTitle } from '../src/slack.js';

const assignees = {
  satellite: 'U_SATELLITE',
  viralBanner: 'U_BANNER',
  viralVideoOwned: 'U_VIDEO_OWNED',
  other: 'U_OTHER',
  owned: 'U_OWNED',
  jdBok: 'U_JDBOK',
  awareness: 'U_AWARENESS',
  sponsorship: 'U_SPONSORSHIP',
  jd: { sponsorship: 'U_JD_SPON', viralBanner: 'U_JD_BANNER', viralVideo: 'U_JD_VIDEO', satellite: 'U_JD_SAT' },
  p: { viralBanner: 'U_P_BANNER', viralVideo: 'U_P_VIDEO', powerChannel: 'U_P_POWER', sponsorship: 'U_P_SPON' },
};

test('owned media and satellite channels get moderation buttons', () => {
  assert.deepEqual(actionDefinitions({ channelCategory: '온드미디어' }).map((item) => item[1]), ['hide', 'approve', 'hold', 'unhide']);
  assert.deepEqual(actionDefinitions({ channelCategory: '위성채널_빙과' }).map((item) => item[1]), ['hide', 'approve', 'hold', 'unhide']);
});
test('external channels only get complete and ignore buttons', () => {
  assert.deepEqual(actionDefinitions({ channelCategory: '유상협찬' }).map((item) => item[1]), ['complete', 'ignore']);
});
test('Meta ad alerts expose only human hide and ignore actions', () => {
  assert.deepEqual(actionDefinitions({ source: 'meta_ads', channelCategory: '인지 광고' }).map((item) => item[1]), ['hide', 'ignore']);
});
test('TikTok ad alerts also expose hide and ignore (API 숨김 가능)', () => {
  assert.deepEqual(actionDefinitions({ source: 'tiktok_ads', channelCategory: '인지 광고' }).map((item) => item[1]), ['hide', 'unhide', 'ignore']);
});

test('YouTube ad alerts expose hide and ignore after owner OAuth connection', () => {
  assert.deepEqual(actionDefinitions({ source: 'youtube_ads', channelCategory: '인지 광고' }).map((item) => item[1]), ['hide', 'ignore']);
});
test('alert blocks include ownership-specific action buttons', () => {
  const blocks = buildAlertBlocks({ row: 1, url: 'https://example.com', channelCategory: '유상협찬' }, { id: 'c1', platform: 'youtube', text: '라라스윗 별로', risk: {} });
  assert.equal(blocks.at(-1).elements.length, 2);
});
test('routes channel categories to the requested Slack assignees', () => {
  assert.equal(assigneeForChannelCategory('위성채널_빙과', assignees), 'U_SATELLITE');
  assert.equal(assigneeForChannelCategory('바이럴(배너)', assignees), 'U_BANNER');
  assert.equal(assigneeForChannelCategory('바이럴(영상)', assignees), 'U_VIDEO_OWNED');
  assert.equal(assigneeForChannelCategory('온드미디어', assignees), 'U_VIDEO_OWNED');
  assert.equal(assigneeForChannelCategory('유상협찬', assignees), 'U_SPONSORSHIP');
  assert.equal(assigneeForChannelCategory('PPL', assignees), 'U_OTHER');
});
test('hasProductName: 상품명 없으면 false(빈값·공백·미지정), 있으면 true(기타 명명 포함)', () => {
  assert.equal(hasProductName({ productName: '' }), false);
  assert.equal(hasProductName({ productName: '   ' }), false);
  assert.equal(hasProductName({}), false);
  assert.equal(hasProductName(null), false);
  assert.equal(hasProductName({ productName: 'JD멜' }), true);
  assert.equal(hasProductName({ productName: 'DB혼' }), true); // 라벨은 기타지만 상품명은 있음 → 제외 안 함
});

test('productGroup: JD 포함=jd, P로 시작=p, 그 외=other', () => {
  assert.equal(productGroup('JD멜'), 'jd');
  assert.equal(productGroup('JD망'), 'jd');
  assert.equal(productGroup('P혼'), 'p');
  assert.equal(productGroup('P망'), 'p');
  assert.equal(productGroup('DB혼'), 'other');
  assert.equal(productGroup('C혼'), 'other');
  assert.equal(productGroup(''), 'other');
});
test('videoAssigneeFromAdTitle: 광고명 마지막 이름을 Slack ID로 매핑', () => {
  const map = { '정요한': 'U_VIDEO', '김유진': 'U_KJ' };
  assert.equal(videoAssigneeFromAdTitle('[26.07]F_V_JD멜_인지_쫀득바출시_인물리뷰형_레시피따라하기_main.릴스_이나연.X_1P_김유진_260731_빙과_정요한', map), 'U_VIDEO');
  assert.equal(videoAssigneeFromAdTitle('a_b_없는이름', map), ''); // 미매핑 → ''
  assert.equal(videoAssigneeFromAdTitle('', map), '');
  assert.equal(videoAssigneeFromAdTitle('단일세그먼트', map), ''); // '_' 없음 → 미매핑
  // 틱톡: 끝의 해시 꼬리 제거 + given-name(요한) 유일 접미 매칭 → 정요한
  assert.equal(videoAssigneeFromAdTitle('TT_26.08_..._260814_빙과_요한_dc811cf2ba', map), 'U_VIDEO');
  assert.equal(videoAssigneeFromAdTitle('...빙과_정요한_ab12cd34ef', map), 'U_VIDEO'); // 풀네임+해시
  // 모호(접미 여러 개) → 미매칭(오태그 방지)
  assert.equal(videoAssigneeFromAdTitle('x_유진_9f8e7d6c', { '김유진': 'U_KJ', '박유진': 'U_PJ' }), '');
  // 이름 아닌 세그먼트(빙과)만 남으면 미매칭
  assert.equal(videoAssigneeFromAdTitle('a_빙과_deadbeef99', map), '');
});
test('commentDeepLink: 인스타 게시물+숫자 댓글id → 댓글 직링크, 그 외 원본', () => {
  assert.equal(commentDeepLink('https://www.instagram.com/p/ABC/', 'instagram', '123'), 'https://www.instagram.com/p/ABC/c/123/');
  assert.equal(commentDeepLink('https://www.instagram.com/reel/XYZ/?utm=1', 'instagram', '456'), 'https://www.instagram.com/reel/XYZ/c/456/');
  assert.equal(commentDeepLink('https://www.instagram.com/p/ABC/', 'youtube', '123'), 'https://www.instagram.com/p/ABC/'); // 인스타 아님
  assert.equal(commentDeepLink('https://www.instagram.com/p/ABC/', 'instagram', 'abc'), 'https://www.instagram.com/p/ABC/'); // 숫자 아님
  assert.equal(commentDeepLink('https://www.instagram.com/lalasweet_icecream/', 'instagram', '123'), 'https://www.instagram.com/lalasweet_icecream/'); // 게시물 permalink 아님(폴백 계정URL)
});

test('alert card(메타 광고): 카드 담당자는 제작자(영상담당자)만, 황경원 제외', () => {
  const blocks = buildAlertBlocks(
    { url: 'https://example.com', channelCategory: '인지 광고', productName: 'JD', source: 'meta_ads', extraAssignees: ['U_VIDEO'] },
    { id: 'c1', platform: 'instagram', text: '라라스윗 별로', risk: {} },
    undefined,
    assignees,
  );
  assert.ok(blocks.some((b) => b.text?.text === '*담당자*\n<@U_VIDEO>'));
  assert.ok(!blocks.some((b) => b.text?.text?.includes('U_OTHER')));
});
test('alert card(메타 광고): 제작자 매핑 없으면 인지 광고 담당자(awareness)로, 미지정 시 other 폴백', () => {
  const target = { url: 'https://example.com', channelCategory: '인지 광고', productName: 'JD', source: 'meta_ads', extraAssignees: [] };
  const comment = { id: 'c1', platform: 'instagram', text: '라라스윗 별로', risk: {} };
  // 제작자(extraAssignees) 없으면 인지 광고 전용 담당자(awareness = 이재원)
  const withAwareness = buildAlertBlocks(target, comment, undefined, assignees);
  assert.ok(withAwareness.some((b) => b.text?.text === '*담당자*\n<@U_AWARENESS>'));
  // awareness 미지정이면 기존대로 other(황경원)로 폴백
  const noAwareness = buildAlertBlocks(target, comment, undefined, { other: 'U_OTHER' });
  assert.ok(noAwareness.some((b) => b.text?.text === '*담당자*\n<@U_OTHER>'));
});
test('alert card(바이럴): 소재명 제작자(extraAssignees)만 태그, 없으면 base 폴백', () => {
  const comment = { id: 'c1', platform: 'instagram', text: '별로', risk: {} };
  // 제작자 있으면 그 사람만(황경원/기타 base 제외)
  const withCreator = buildAlertBlocks({ url: 'https://example.com', channelCategory: '바이럴 (영상)', productName: 'JD멜', extraAssignees: ['U_VIDEO'] }, comment, undefined, assignees);
  assert.ok(withCreator.some((b) => b.text?.text === '*담당자*\n<@U_VIDEO>'));
  // 제작자 매핑 없으면 base(JD 바이럴 영상 담당)로 폴백
  const noCreator = buildAlertBlocks({ url: 'https://example.com', channelCategory: '바이럴 (영상)', productName: 'JD멜', extraAssignees: [] }, comment, undefined, assignees);
  assert.ok(noCreator.some((b) => b.text?.text === '*담당자*\n<@U_JD_VIDEO>'));
  // 배너도 동일
  const banner = buildAlertBlocks({ url: 'https://example.com', channelCategory: '바이럴 (배너)', productName: 'JD멜', extraAssignees: ['U_VIDEO'] }, comment, undefined, assignees);
  assert.ok(banner.some((b) => b.text?.text === '*담당자*\n<@U_VIDEO>'));
});
test('alert card: 소재명에 JD복 포함 시 카테고리·제작자 무관 이재원(jdBok) 최우선', () => {
  const comment = { id: 'c1', platform: 'instagram', text: '별로', risk: {} };
  // 바이럴(제작자 있어도) 소재명 JD복이면 override
  const a = buildAlertBlocks({ url: 'https://x', channelCategory: '바이럴 (영상)', productName: 'JD복', assetName: 'F_V_JD복_바이럴_main_빙과_정요한', extraAssignees: ['U_VIDEO'] }, comment, undefined, assignees);
  assert.ok(a.some((b) => b.text?.text === '*담당자*\n<@U_JDBOK>'));
  // 위성채널(base 이세진)도 JD복 소재명이면 override
  const b = buildAlertBlocks({ url: 'https://x', channelCategory: '위성채널', productName: 'DB혼', assetName: 'JD복_상시_빙과_홍정민' }, comment, undefined, assignees);
  assert.ok(b.some((x) => x.text?.text === '*담당자*\n<@U_JDBOK>'));
  // 광고 카드는 adTitle 소재명 기준
  const c = buildAlertBlocks({ url: 'https://x', channelCategory: '인지 광고', source: 'meta_ads', adTitle: 'TT_JD복_인지_main_빙과_정요한', extraAssignees: ['U_VIDEO'] }, comment, undefined, assignees);
  assert.ok(c.some((x) => x.text?.text === '*담당자*\n<@U_JDBOK>'));
  // JD복 없으면 override 안 됨(제작자 유지)
  const d = buildAlertBlocks({ url: 'https://x', channelCategory: '바이럴 (영상)', productName: 'JD멜', assetName: 'F_V_JD멜_빙과_정요한', extraAssignees: ['U_VIDEO'] }, comment, undefined, assignees);
  assert.ok(d.some((x) => x.text?.text === '*담당자*\n<@U_VIDEO>'));
});
test('alert card(틱톡·유튜브 광고): 메타와 동일하게 제작자만 태그(awareness 카드 중복 제외)', () => {
  for (const source of ['tiktok_ads', 'youtube_ads']) {
    const blocks = buildAlertBlocks(
      { url: 'https://example.com', channelCategory: '인지 광고', productName: 'JD', source, extraAssignees: ['U_VIDEO'] },
      { id: 'c1', platform: source === 'tiktok_ads' ? 'tiktok' : 'youtube', text: '별로', risk: {} },
      undefined, assignees,
    );
    assert.ok(blocks.some((b) => b.text?.text === '*담당자*\n<@U_VIDEO>'), `${source} 카드는 제작자만`);
    assert.ok(!blocks.some((b) => b.text?.text?.includes('U_AWARENESS')), `${source} 카드에 awareness 중복 태그 없어야`);
  }
});
test('alert card: 메타 광고는 링크 텍스트에 광고 이름 원본(adTitle) 사용', () => {
  const ad = '[26.07]F_V_JD멜_인지_쫀득바출시_인물리뷰형_main.릴스_이나연.X_1P_김유진_260731_빙과_정요한';
  const blocks = buildAlertBlocks(
    { url: 'https://www.instagram.com/p/x/', channelName: 'lalasweet_icecream', channelCategory: '인지 광고', productName: 'JD', source: 'meta_ads', adTitle: ad },
    { id: 'c1', platform: 'instagram', username: 'u', text: 't', risk: {} },
    [], assignees,
  );
  assert.ok(blocks[2].text.text.startsWith(`<https://www.instagram.com/p/x/|${ad}>`));
});
test('buildViralCopyMessage: 업체별 링크/닉네임/댓글내용 + 중복 제거', () => {
  const msg = buildViralCopyMessage('루나앤코코', [
    { url: 'https://insta/p/A/', nickname: 'user1', text: '광고 별로' },
    { url: 'https://insta/p/A/', nickname: 'user1', text: '광고 별로' }, // 중복 제거
    { url: 'https://insta/p/B/', nickname: 'user2', text: '맛없어요' },
  ]);
  assert.equal(msg, '```\n[루나앤코코]\n\n담당자님 하기 게시물에 광고의심 및 부정댓글 관리 부탁 드립니다!\nhttps://insta/p/A/ / user1 / 광고 별로\nhttps://insta/p/B/ / user2 / 맛없어요\n```');
});
test('productLabel: jd=쫀득바, p=파인트, 그 외=기타', () => {
  assert.equal(productLabel('jd'), '쫀득바');
  assert.equal(productLabel('p'), '파인트');
  assert.equal(productLabel('other'), '기타');
});
test('assigneeForTarget: 상품×카테고리 라우팅 + 미지정은 카테고리 기본값 폴백', () => {
  // JD 상품
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '협찬 (인플루언서)' }, assignees), 'U_JD_SPON');
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '바이럴 (배너)' }, assignees), 'U_JD_BANNER');
  assert.equal(assigneeForTarget({ productName: 'JD망', channelCategory: '바이럴 (영상)' }, assignees), 'U_JD_VIDEO');
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '위성채널' }, assignees), 'U_JD_SAT');
  // P 상품(배너·영상만 지정) — 나머지 조합은 기타로 황경원(other)
  assert.equal(assigneeForTarget({ productName: 'P혼', channelCategory: '바이럴 (배너)' }, assignees), 'U_P_BANNER');
  assert.equal(assigneeForTarget({ productName: 'P망', channelCategory: '바이럴 (영상)' }, assignees), 'U_P_VIDEO');
  assert.equal(assigneeForTarget({ productName: 'P혼', channelCategory: '협찬 (인플루언서)' }, assignees), 'U_P_SPON'); // 파인트 협찬(인플루언서)=손유곤
  // 파인트 파워채널/매거진 = 이도경(p.powerChannel, 협찬 인플루언서보다 우선)
  assert.equal(assigneeForTarget({ productName: 'P혼', channelCategory: '협찬 (파워채널/매거진)' }, assignees), 'U_P_POWER');
  assert.equal(assigneeForTarget({ productName: 'P혼', channelCategory: '협찬 (매거진)' }, assignees), 'U_P_POWER');
  // 쫀득바 협찬(인플루언서)=김바다(jd.sponsorship), 파워채널/매거진=황경원(other)
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '협찬 (인플루언서)' }, assignees), 'U_JD_SPON');
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '협찬 (파워채널/매거진)' }, assignees), 'U_OTHER');
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '협찬 (매거진)' }, assignees), 'U_OTHER');
  // 온드미디어는 상품군 무관 owned(김바다)
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '온드미디어' }, assignees), 'U_OWNED');
  assert.equal(assigneeForTarget({ productName: 'DB혼', channelCategory: '온드미디어' }, assignees), 'U_OWNED');
  // 위성채널은 상품군 무관하게 항상 이세진(base satellite) — JD/P/기타 전부
  assert.equal(assigneeForTarget({ productName: 'DB딸', channelCategory: '위성채널' }, assignees), 'U_SATELLITE');
  assert.equal(assigneeForTarget({ productName: 'P혼', channelCategory: '위성채널' }, assignees), 'U_SATELLITE');
  assert.equal(assigneeForTarget({ channelCategory: '위성채널' }, assignees), 'U_SATELLITE'); // 상품명 없어도 위성=이세진
  // 그 외 기타 상품(듬뿍바 등) 비-위성 조합은 황경원(other)
  assert.equal(assigneeForTarget({ productName: 'DB혼', channelCategory: '바이럴 (배너)' }, assignees), 'U_OTHER');
  assert.equal(assigneeForTarget({ productName: 'DB혼', channelCategory: '협찬 (인플루언서)' }, assignees), 'U_OTHER');
  // 상품 정보 없음 → 기타 → 황경원(other)
  assert.equal(assigneeForTarget({ channelCategory: '유상협찬' }, assignees), 'U_OTHER');
  // 인지(메타) 광고는 상품군 무관 전용 담당자(awareness). 미지정 시 other로 폴백.
  assert.equal(assigneeForTarget({ productName: 'JD멜', channelCategory: '인지 광고' }, assignees), 'U_AWARENESS');
  assert.equal(assigneeForTarget({ channelCategory: '인지 광고' }, assignees), 'U_AWARENESS');
  assert.equal(assigneeForTarget({ channelCategory: '인지 광고' }, { other: 'U_OTHER' }), 'U_OTHER');
});
test('alert card category line shows product label (상품 × 카테고리)', () => {
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '바이럴 (배너)', productName: 'JD멜' },
    { id: 'c1', platform: 'instagram', text: '라라스윗 별로', risk: {} },
    undefined,
    assignees,
  );
  assert.ok(blocks.some((b) => b.text?.text === '*[쫀득바] 바이럴 (배너)*'));
});
test('alert card label falls back to 기타 when product unknown', () => {
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '유상협찬' },
    { id: 'c1', platform: 'instagram', text: 'x', risk: {} },
  );
  assert.ok(blocks.some((b) => b.text?.text === '*[기타] 유상협찬*'));
});
test('alert blocks mention the category assignee', () => {
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '바이럴(배너)', productName: 'JD멜' },
    { id: 'c1', platform: 'instagram', text: '라라스윗 별로', risk: {} },
    undefined,
    assignees,
  );
  assert.ok(blocks.some((block) => block.text?.text === '*담당자*\n<@U_JD_BANNER>'));
});
test('작성자는 메인 라인에만, 필드엔 중복 없음(B2)', () => {
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '유상협찬' },
    { id: 'c1', platform: 'instagram', username: 'hater123', text: '라라스윗 별로', risk: {} },
  );
  const mainLine = blocks[2].text.text;
  assert.match(mainLine, /hater123/); // 메인 라인에 작성자 있음
  const fieldsBlock = blocks.find((b) => Array.isArray(b.fields));
  assert.ok(!fieldsBlock.fields.some((f) => f.text.includes('*작성자*'))); // 필드에 작성자 중복 없음
  assert.equal(fieldsBlock.fields.length, 2); // 현재상태 + 작성시간
});
test('긴 댓글은 잘려서 블록 한도 방어(B3)', () => {
  const long = '가'.repeat(2000);
  const blocks = buildAlertBlocks(
    { row: 1, url: 'https://example.com', channelCategory: '유상협찬' },
    { id: 'c1', platform: 'instagram', username: 'u', text: long, risk: {} },
  );
  assert.ok(blocks[2].text.text.length < 700); // 500자 + 링크/작성자 오버헤드
  assert.match(blocks[2].text.text, /…/);
});
test('verifies valid Slack signatures and rejects stale requests', () => {
  const secret = 'test-secret'; const timestamp = '1000'; const rawBody = 'payload=x';
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody, now: 1000 * 1000 }), true);
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody, now: 2000 * 1000 }), false);
});

test('sendAlert: threadTs 주면 thread_ts로 답글 발송, 없으면 최상위', async () => {
  const cfg = { slackBotToken: 'tok', slackChannelId: 'C1', managedChannelCategories: [], slackAssignees: {} };
  const target = { url: 'https://x.com/u/status/1', channelName: 'ch', channelCategory: '바이럴 (배너)', platform: 'twitter' };
  const comment = { id: 'c1', platform: 'twitter', text: '광고 별로', username: 'u', timestamp: '1700000000' };
  let body;
  const fetchImpl = async (url, opts) => { body = JSON.parse(opts.body); return { json: async () => ({ ok: true, ts: '1.1' }) }; };
  await sendAlert(cfg, target, comment, fetchImpl, '555.666');
  assert.equal(body.thread_ts, '555.666');
  await sendAlert(cfg, target, comment, fetchImpl); // threadTs 없음
  assert.ok(!('thread_ts' in body), '스레드 없으면 최상위 발송');
});

test('sendAlert: 기존 완료 스레드에 새 답글을 달기 전에 완료 반응을 제거', async () => {
  const cfg = { slackBotToken: 'tok', slackChannelId: 'C1', managedChannelCategories: [], slackAssignees: {} };
  const target = { url: 'https://x.com/u/status/1', channelName: 'ch', channelCategory: 'PPL', platform: 'twitter' };
  const comment = { id: 'c1', platform: 'twitter', text: '광고 별로', username: 'u', timestamp: '1700000000' };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { json: async () => ({ ok: true, ts: '1.1' }) };
  };
  await sendAlert(cfg, target, comment, fetchImpl, '555.666');
  assert.match(calls[0].url, /reactions\.remove/);
  assert.equal(calls[0].body.timestamp, '555.666');
  assert.equal(calls[0].body.name, '완료느낌표');
  assert.match(calls[1].url, /chat\.postMessage/);
  assert.equal(calls[1].body.thread_ts, '555.666');
});
