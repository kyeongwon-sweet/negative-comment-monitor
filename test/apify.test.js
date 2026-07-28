import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActorInput } from '../src/apify.js';

const targets = [{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }];

test('builds Instagram comment actor input', () => {
  const input = buildActorInput('instagram', {}, targets);
  assert.deepEqual(input.directUrls, targets.map((target) => target.url));
  assert.equal(input.resultsLimit, 10);
});

test('builds YouTube comment actor input', () => {
  const input = buildActorInput('youtube', {}, targets);
  assert.deepEqual(input.startUrls, targets.map((target) => ({ url: target.url })));
  assert.equal(input.sortCommentsBy, 'NEWEST_FIRST');
  assert.equal(input.oldestCommentDate, '7 days');
});

test('builds TikTok comment actor input', () => {
  const input = buildActorInput('tiktok', {}, targets);
  assert.deepEqual(input.postURLs, targets.map((target) => target.url));
  assert.equal(input.maxRepliesPerComment, 0);
});

test('builds deep scan actor input with higher comment limits', () => {
  const instagram = buildActorInput('instagram', { resultsLimit: 30 }, targets, { deepScan: true, commentLimit: 100 });
  const youtube = buildActorInput('youtube', { maxComments: 50 }, targets, { deepScan: true, commentLimit: 100 });
  const tiktok = buildActorInput('tiktok', { commentsPerPost: 50 }, targets, { deepScan: true, commentLimit: 100 });
  assert.equal(instagram.resultsLimit, 100);
  assert.equal(instagram.includeNestedComments, true);
  assert.equal(youtube.maxComments, 100);
  assert.equal(youtube.oldestCommentDate, '14 days');
  assert.equal(tiktok.commentsPerPost, 100);
  assert.equal(tiktok.maxRepliesPerComment, 15);
});

test('builds Twitter replies actor input', () => {
  const input = buildActorInput('twitter', {}, targets);
  assert.deepEqual(input.startUrls, targets.map((target) => target.url));
  assert.equal(input.useSearch, false);
  assert.equal(input.maxItems, 60);
});
