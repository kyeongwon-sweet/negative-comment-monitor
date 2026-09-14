import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepeatOffenderCandidates,
  buildRepeatOffenderSlackText,
  isNegativeAlertForOffenderReport,
} from '../src/youtube-repeat-offender-report.js';

function row(id, author, video, decision = 'hidden', name = '악플러', owner = 'UC_OWNER') {
  return {
    id,
    comment_id: `c${id}`,
    comment_text: `악플 ${id}`,
    post_url: `https://www.youtube.com/watch?v=${video}`,
    review_decision: decision,
    author_channel_id: author,
    author_display_name: name,
    owner_channel_id: owner,
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
});
