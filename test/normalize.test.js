import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComment, campaignNameMatchesFilter } from '../src/normalize.js';

test('normalizes common Apify comment shapes', () => {
  assert.deepEqual(normalizeComment('youtube', {
    commentId: 'c1',
    commentText: '별로예요',
    authorName: 'tester',
    publishedAt: '2026-07-15T00:00:00Z',
    likes: 2,
    videoUrl: 'https://youtu.be/x',
  }), {
    id: 'c1', platform: 'youtube', url: 'https://youtu.be/x', username: 'tester',
    text: '별로예요', timestamp: '2026-07-15T00:00:00Z', likeCount: 2,
  });
});

test('drops items without comment text', () => {
  assert.equal(normalizeComment('instagram', { id: 'x' }, 'https://instagram.com/p/x'), null);
});

test('campaignNameMatchesFilter: 콤마 다중 키워드 중 하나라도 포함하면 매칭(빙과/쫀득바)', () => {
  // 실측: 틱톡 캠페인=빙과, 유튜브 캠페인=쫀득바 → 한 변수로 둘 다 잡아야 함.
  assert.equal(campaignNameMatchesFilter('[빙과] 인지', '빙과,쫀득바'), true);
  assert.equal(campaignNameMatchesFilter('쫀득바 출시 영상', '빙과,쫀득바'), true);
  assert.equal(campaignNameMatchesFilter('전환 상시', '빙과,쫀득바'), false);
  // 단일 키워드·공백 포함도 정상
  assert.equal(campaignNameMatchesFilter('[빙과] 인지', '빙과'), true);
  assert.equal(campaignNameMatchesFilter('쫀득바 영상', ' 빙과 , 쫀득바 '), true);
  // 빈 필터 = 전체 허용
  assert.equal(campaignNameMatchesFilter('아무거나', ''), true);
});

