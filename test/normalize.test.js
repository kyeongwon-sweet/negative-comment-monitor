import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComment } from '../src/normalize.js';

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

