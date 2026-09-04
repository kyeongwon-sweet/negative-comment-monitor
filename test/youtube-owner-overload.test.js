import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessOwnerCommentOverload,
  buildCumulativeOwnerOverloadAssessments,
  buildOwnerOverloadBlocks,
  buildOwnerOverloadWarning,
  maybeWarnOwnerCommentOverload,
} from '../src/youtube-owner-overload.js';
import { suppressLowConfidenceOwnerRisks } from '../src/youtube-owner-risk.js';

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const config = {
  supabaseUrl: 'https://db.test', supabaseKey: 'service',
  slackBotToken: 'slack', slackChannelId: 'C1',
  youtubeOwnerOverloadNegativeCount: 20,
  youtubeOwnerOverloadRatioPercent: 40,
  youtubeOwnerOverloadMinComments: 10,
  youtubeOwnerOverloadCooldownHours: 24,
};

const target = {
  youtubeVideoId: 'Video_ABC-1', channelName: '썰푸는앵무새', caption: '테스트 <영상>',
  ownerChannelId: 'UCQKpvEBNiMBrGzI2f2tAFeA',
  ownedChannelBrandHostilityScope: true,
};

test('부정 수 또는 최소 표본 비율이 임계치를 넘을 때만 과부하로 판정한다', () => {
  const comments = Array.from({ length: 10 }, (_, index) => ({ text: index < 4 ? '쫀득바 맛없음' : '광고 잘 만들었네' }));
  assert.equal(assessOwnerCommentOverload(comments, comments.map((_, i) => ({ alert: i < 4 })), config, target).overloaded, true);
  assert.equal(assessOwnerCommentOverload(comments.slice(0, 5), comments.slice(0, 5).map((_, i) => ({ alert: i < 3 })), config, target).overloaded, false);
  const many = Array.from({ length: 30 }, (_, index) => ({ text: index < 20 ? '라라스윗 사지마' : '좋아요' }));
  assert.equal(assessOwnerCommentOverload(many, many.map((_, i) => ({ alert: i < 20 })), config, target).overloaded, true);
});

test('엔터·가십 반응을 LLM이 과민 판정해도 과부하 고신뢰 수치에서는 제외한다', () => {
  const comments = [
    { text: '광고 참신하다 잘 만들었네' },
    { text: '이 광고 발연기네 ㅋㅋ' },
    { text: '너나 닥쳐 신고할게요' },
    { text: '배우 누구예요?' },
    { text: '라라스윗 왤케 비호감' },
    { text: '쫀득바 맛없으니 사지마' },
  ];
  const risks = comments.map((_, index) => ({
    alert: true,
    category: index < 5 ? '브랜드 적대/조롱' : '제품 불만',
  }));
  const result = assessOwnerCommentOverload(comments, risks, config, target);
  assert.equal(result.rawNegatives, 6);
  assert.equal(result.negatives, 2);
  assert.equal(result.suppressedNegatives, 4);
  assert.equal(result.overloaded, false);
});

test('누적 과부하는 사람의 유지 결정과 과민 LLM 오탐을 제외하고 모든 추적 영상을 평가한다', () => {
  const targets = [
    { ...target, youtubeVideoId: 'video-a', youtubeCommentCount: 50 },
    { ...target, youtubeVideoId: 'video-b', youtubeCommentCount: 10 },
    { ...target, youtubeVideoId: 'video-third-party', youtubeCommentCount: 10, ownedChannelBrandHostilityScope: false },
  ];
  const rows = [];
  for (let index = 0; index < 20; index += 1) {
    rows.push({
      comment_id: `a-${index}`,
      comment_text: '쫀득바 맛없으니 사지마',
      category: '제품 불만',
      post_url: 'https://www.youtube.com/watch?v=video-a',
      review_decision: 'hidden',
    });
  }
  rows.push(
    {
      comment_id: 'a-fp', comment_text: '쫀득바 맛없으니 사지마', category: '제품 불만',
      post_url: 'https://www.youtube.com/watch?v=video-a', review_decision: 'false_positive',
    },
    {
      comment_id: 'a-chat', comment_text: '광고 참신하다 잘 만들었네', category: '브랜드 적대/조롱',
      post_url: 'https://www.youtube.com/watch?v=video-a', review_decision: 'hidden',
    },
  );
  for (let index = 0; index < 4; index += 1) {
    rows.push({
      comment_id: `b-${index}`,
      comment_text: '라라스윗 진짜 비호감',
      category: '브랜드 적대/조롱',
      post_url: 'https://youtube.com/shorts/video-b',
      review_decision: null,
    });
  }
  rows.push({
    comment_id: 'third', comment_text: '쫀득바 맛없음', category: '제품 불만',
    post_url: 'https://youtube.com/watch?v=video-third-party', review_decision: null,
  });

  const result = buildCumulativeOwnerOverloadAssessments(targets, rows, config);
  assert.deepEqual(result.map(({ target: row, assessment }) => [
    row.youtubeVideoId, assessment.negatives, assessment.total, assessment.cumulative,
  ]), [
    ['video-a', 20, 50, true],
    ['video-b', 4, 10, true],
  ]);
});

test('소유채널 개별 알림도 동일 고신뢰 게이트를 쓰고 일반 채널은 건드리지 않는다', () => {
  const comments = [
    { text: '광고 참신하다 잘 만들었네' },
    { text: '이 광고 발연기네 ㅋㅋ' },
    { text: '라라스윗 진짜 극혐' },
    { text: '쫀득바 맛없으니 사지마' },
  ];
  const risks = comments.map((_, index) => ({
    alert: true,
    category: index < 3 ? '브랜드 적대/조롱' : '제품 불만',
  }));
  const filtered = suppressLowConfidenceOwnerRisks(target, comments, risks);
  assert.deepEqual(filtered.map((risk) => risk.alert), [false, false, true, true]);
  assert.equal(filtered[0].ownerLowConfidenceSuppressed, true);
  assert.equal(suppressLowConfidenceOwnerRisks(
    { ...target, ownedChannelBrandHostilityScope: false }, comments, risks,
  ), risks);
});

test('과부하 경고는 Studio 링크·담당자를 포함하고 Slack 성공 뒤 쿨다운 상태를 남긴다', async () => {
  const calls = [];
  const assessment = { total: 50, negatives: 25, ratioPercent: 50, overloaded: true };
  const result = await maybeWarnOwnerCommentOverload(
    config, target, assessment, '123.45', 'U1',
    async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).includes('/platform_collection_health?platform=')) return response(200, []);
      if (String(input).includes('/platform_collection_health?on_conflict=')) {
        return response(200, [{ platform: 'hashed', last_alerted_at: '2026-08-26T00:00:00Z' }]);
      }
      if (String(input).includes('slack.com/api/chat.postMessage')) return response(200, { ok: true });
      throw new Error(`unexpected ${input}`);
    },
    Date.parse('2026-08-26T00:00:00Z'),
  );
  assert.equal(result.alerted, true);
  const slack = calls.find((call) => call.url.includes('chat.postMessage'));
  const body = JSON.parse(slack.init.body);
  assert.equal(body.thread_ts, '123.45');
  assert.match(body.text, /<@U1>/);
  assert.match(body.text, /썰푸는앵무새 \(UCQKpvEBNiMBrGzI2f2tAFeA\) 채널로 전환/);
  assert.match(body.text, /댓글창 사용 중지 권고/);
  assert.match(body.text, /댓글 → 꺼짐/);
  assert.match(body.text, /studio\.youtube\.com\/video\/Video_ABC-1\/edit/);
  assert.match(body.text, /studio\.youtube\.com\/channel\/UCQKpvEBNiMBrGzI2f2tAFeA\/comments/);
  assert.match(body.text, /테스트 &lt;영상&gt;/);
  assert.equal(body.blocks.length, 2);
  const actions = body.blocks.find((block) => block.type === 'actions');
  assert.deepEqual(
    actions.elements.map((element) => element.action_id),
    ['youtube_owner_disable_comments_open', 'youtube_owner_watch_video', 'youtube_owner_manage_comments'],
  );
  assert.equal(actions.elements[0].style, 'danger');
  assert.equal(actions.elements[0].text.text, 'Studio에서 댓글 끄기');
  assert.equal(actions.elements[0].url, 'https://studio.youtube.com/video/Video_ABC-1/edit');
});

test('채널 ID가 없으면 잘못된 채널 URL 대신 Studio 홈과 채널 전환 안내를 쓴다', () => {
  const text = buildOwnerOverloadWarning(
    { ...target, ownerChannelId: '', channelId: '' },
    { total: 30, negatives: 20, ratioPercent: 66.7 },
    '',
  );
  assert.match(text, /썰푸는앵무새 채널로 전환/);
  assert.match(text, /<https:\/\/studio\.youtube\.com\/video\/Video_ABC-1\/edit\|댓글 설정 바로 열기>/);
  assert.match(text, /<https:\/\/studio\.youtube\.com\/\|썰푸는앵무새 댓글 관리>/);
});

test('과부하 액션은 소유 영상·채널의 안전한 Studio URL만 사용한다', () => {
  const blocks = buildOwnerOverloadBlocks(
    target,
    { total: 51, negatives: 20, ratioPercent: 39.2 },
    'U1',
  );
  const actions = blocks.find((block) => block.type === 'actions').elements;
  assert.equal(actions[0].url, 'https://studio.youtube.com/video/Video_ABC-1/edit');
  assert.equal(actions[1].url, 'https://www.youtube.com/watch?v=Video_ABC-1');
  assert.equal(actions[2].url, 'https://studio.youtube.com/channel/UCQKpvEBNiMBrGzI2f2tAFeA/comments');
  assert.equal(actions.some((element) => element.value), false);
});

test('누적 후보 일괄 알림은 이번 확인 비율로 오표기하지 않고 누적 부정 수를 표시한다', () => {
  const text = buildOwnerOverloadWarning(
    target,
    { total: 796, negatives: 796, ratioPercent: 100, cumulative: true },
    'U1',
  );
  assert.match(text, /최근 감시 기간 누적 부정댓글 796개/);
  assert.doesNotMatch(text, /이번 확인 댓글/);
});

test('일반·위성 target에는 과부하 경고 상태조회도 하지 않는다', async () => {
  let called = false;
  const result = await maybeWarnOwnerCommentOverload(
    config,
    { ...target, ownedChannelBrandHostilityScope: false },
    { total: 100, negatives: 100, ratioPercent: 100, overloaded: true },
    '1.2', '',
    async () => { called = true; throw new Error('must not call'); },
  );
  assert.equal(result.checked, false);
  assert.equal(called, false);
});

test('소유 영상도 과부하가 아니면 기존 경고 쿨다운을 지우는 health success를 기록하지 않는다', async () => {
  let called = false;
  const result = await maybeWarnOwnerCommentOverload(
    config,
    target,
    { total: 100, negatives: 3, ratioPercent: 3, overloaded: false },
    '1.2', '',
    async () => { called = true; throw new Error('must not call'); },
  );
  assert.equal(result.checked, true);
  assert.equal(result.alerted, false);
  assert.equal(called, false);
});
