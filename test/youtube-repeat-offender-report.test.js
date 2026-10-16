import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepeatOffenderCandidates,
  buildRepeatOffenderRoutes,
  buildRepeatOffenderSlackText,
  isNegativeAlertForOffenderReport,
} from '../src/youtube-repeat-offender-report.js';

function row(id, author, video, decision = 'hidden', name = '악플러', owner = 'UC_OWNER', product = 'JD') {
  return {
    id,
    comment_id: `c${id}`,
    comment_text: `악플 ${id}`,
    post_url: `https://www.youtube.com/watch?v=${video}`,
    review_decision: decision,
    author_channel_id: author,
    author_display_name: name,
    owner_channel_id: owner,
    product_name: product,
  };
}

test('사람이 오탐·유지한 댓글과 이미 밴된 작성자는 상습 악플러 집계에서 제외한다', () => {
  // author_banned = 이미 밴 완료 → 다시 후보로 올리지 않는다.
  for (const decision of ['false_positive', 'ignore', 'approve', 'unhide', 'author_banned']) {
    assert.equal(isNegativeAlertForOffenderReport({ review_decision: decision }), false);
  }
  // 'hidden'(자동숨김)은 여전히 후보로 노출 → 사람이 작성자 밴으로 에스컬레이션할 수 있게.
  for (const decision of [null, 'hidden', 'complete', 'hold']) {
    assert.equal(isNegativeAlertForOffenderReport({ review_decision: decision }), true);
  }
});

test('이미 author_banned인 작성자는 후보에서 빠지고 hidden 작성자는 남는다', () => {
  const candidates = buildRepeatOffenderCandidates([
    row(1, 'UC_BANNED', 'video1', 'author_banned'), row(2, 'UC_BANNED', 'video2', 'author_banned'),
    row(3, 'UC_HIDDEN', 'video1', 'hidden'), row(4, 'UC_HIDDEN', 'video2', 'hidden'),
  ], { minComments: 3, minVideos: 2 });
  assert.deepEqual(candidates.map((r) => r.authorChannelId), ['UC_HIDDEN']);
});

test('2026-10-15 재발방지: 밴된 작성자는 그 채널의 나머지 hidden 행이 남아 있어도 후보에서 통째로 빠진다', () => {
  const candidates = buildRepeatOffenderCandidates([
    // 증거 1행만 author_banned, 나머지는 자동숨김 hidden(이전 단일밴이 남기던 상태)
    row(1, 'UC_BANNED', 'video1', 'author_banned'), row(2, 'UC_BANNED', 'video2'), row(3, 'UC_BANNED', 'video3'), row(4, 'UC_BANNED', 'video4'),
    // 같은 작성자라도 다른 소유 채널은 별개 밴 단위 → 그 채널 기준으로 다시 판단
    row(5, 'UC_BANNED', 'video5', 'hidden', '악플러', 'UC_OTHER'), row(6, 'UC_BANNED', 'video6', 'hidden', '악플러', 'UC_OTHER'),
  ], { minComments: 3, minVideos: 2 });
  assert.deepEqual(candidates.map((r) => [r.ownerChannelId, r.authorChannelId]), [['UC_OTHER', 'UC_BANNED']]);
});

test('작성자별 3건 이상 또는 서로 다른 영상 2개 이상을 후보로 집계한다', () => {
  const candidates = buildRepeatOffenderCandidates([
    row(1, 'UC_A', 'video1'), row(2, 'UC_A', 'video1'), row(3, 'UC_A', 'video1'),
    row(4, 'UC_B', 'video1'), row(5, 'UC_B', 'video2'),
    row(6, 'UC_C', 'video1'), row(7, 'UC_C', 'video1', 'false_positive'),
  ], { minComments: 3, minVideos: 2, maxExamples: 2 });
  assert.deepEqual(candidates.map((row) => [row.authorChannelId, row.commentCount, row.videoCount]), [
    ['UC_A', 3, 1], ['UC_B', 2, 2],
  ]);
  assert.equal(candidates[0].examples.length, 2);
});

test('같은 작성자라도 숨김 실행 단위인 소유 채널별로 후보를 분리한다', () => {
  const candidates = buildRepeatOffenderCandidates([
    row(1, 'UC_A', 'video1', 'hidden', '악플러', 'UC_OWNER_1'),
    row(2, 'UC_A', 'video2', 'hidden', '악플러', 'UC_OWNER_2'),
  ], { minComments: 3, minVideos: 2 });
  assert.equal(candidates.length, 0);
});

test('Slack 후보 리포트는 채널 링크·건수·영상수·예시를 포함한다', () => {
  const text = buildRepeatOffenderSlackText([{
    ownerChannelId: 'UC_OWNER', ownerChannelName: '썰푸는앵무새',
    authorChannelId: 'UC_A', authorDisplayName: '작성자', handle: '@handle',
    commentCount: 4, videoCount: 2, examples: [{ text: '별로', postUrl: 'https://youtube.com/watch?v=v1' }],
  }], { minComments: 3, minVideos: 2, unresolvedAuthorAlerts: 1 });
  assert.match(text, /youtube\.com\/channel\/UC_A/);
  assert.match(text, /@handle/);
  assert.match(text, /썰푸는앵무새/);
  assert.match(text, /악플 4건 · 영상 2개/);
  assert.match(text, /작성자 확인 불가 1건/);
  assert.match(text, /차단·댓글 숨김은 실행하지 않았습니다/);
  assert.doesNotMatch(text, /차단 승인용 alert ID/);
});

test('자격은 작성자 전체 이력으로 판정하되 제품별 인지광고 스레드로 나눈다', () => {
  const candidates = buildRepeatOffenderCandidates([
    row(1, 'UC_A', 'video1', 'hidden', '악플러', 'UC_OWNER', 'JG'),
    row(2, 'UC_A', 'video2', 'hidden', '악플러', 'UC_OWNER', 'JD멜'),
  ], { minComments: 3, minVideos: 2, maxExamples: 2 });
  assert.equal(candidates.length, 1, '두 제품에 걸친 2개 영상이면 반복 후보 자격을 유지');

  const routes = buildRepeatOffenderRoutes(candidates, {
    other: 'U_HWANG', awareness: 'U_HWANG',
    jg: { primary: 'U0BBTQLRYR2' },
  });
  assert.deepEqual(routes.map((route) => [route.scopeKey, route.assignee]), [
    ['제과|인지 광고', 'U0BBTQLRYR2'],
    ['쫀득바|인지 광고', 'U_HWANG'],
  ]);
  assert.equal(routes[0].candidates[0].commentCount, 1);
  assert.equal(routes[1].candidates[0].commentCount, 1);
});

test('2026-10-16 재발방지: 이미 알린 후보(같은 악플 수)는 다시 올리지 않고, 악플이 늘면 다시 알린다', async () => {
  const { filterUnreportedRoutes, repeatOffenderReportKey } = await import('../src/youtube-repeat-offender-report.js');
  const route = { group: 'jd', label: '쫀득바', candidates: [
    { ownerChannelId: 'UC_OWNER', authorChannelId: 'UC_A', commentCount: 2 },
    { ownerChannelId: 'UC_OWNER', authorChannelId: 'UC_B', commentCount: 3 },
  ] };
  const reported = new Set([
    repeatOffenderReportKey({ ownerChannelId: 'UC_OWNER', authorChannelId: 'UC_A', commentCount: 2 }, route), // 어제 알림, 변화 없음
    repeatOffenderReportKey({ ownerChannelId: 'UC_OWNER', authorChannelId: 'UC_B', commentCount: 2 }, route), // 어제 2건 → 오늘 3건
  ]);
  const { routes, skipped } = filterUnreportedRoutes([route], reported);
  assert.equal(skipped, 1);
  assert.deepEqual(routes[0].candidates.map((c) => c.authorChannelId), ['UC_B']);
  // 전원 이미 알렸으면 제품군 자체가 빠진다(빈 부모 스레드 생성 방지).
  const all = new Set(route.candidates.map((c) => repeatOffenderReportKey(c, route)));
  assert.deepEqual(filterUnreportedRoutes([route], all).routes, []);
  // 다른 제품군 버킷은 별개 키
  assert.notEqual(repeatOffenderReportKey(route.candidates[0], route), repeatOffenderReportKey(route.candidates[0], { group: 'p' }));
});
