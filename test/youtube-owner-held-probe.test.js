import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHeld } from '../src/youtube-owner-held-probe.js';

test('보류함 요약: 봇이 숨긴 것과 출처 미상을 나눠 세고 보류 답글도 따로 센다', () => {
  const decisions = new Map([['a', 'hidden'], ['r2', 'hidden']]);
  const threads = [
    { snippet: { topLevelComment: { id: 'a', snippet: { moderationStatus: 'heldForReview' } } } },
    { snippet: { topLevelComment: { id: 'b', snippet: { moderationStatus: 'heldForReview' } } } },
    {
      snippet: { topLevelComment: { id: 'c', snippet: { moderationStatus: 'published' } } },
      replies: { comments: [
        { id: 'r1', snippet: { moderationStatus: 'published' } },
        { id: 'r2', snippet: { moderationStatus: 'heldForReview' } },
      ] },
    },
  ];
  const s = summarizeHeld(threads, decisions);
  assert.equal(s.threads, 3);
  assert.equal(s.heldTopLevel, 2);
  assert.equal(s.repliesIncluded, 2);
  assert.equal(s.heldReplies, 1);
  assert.deepEqual(s.byDecision, { hidden: 1, 'no-alert-row': 1, 'reply:hidden': 1 });
});
