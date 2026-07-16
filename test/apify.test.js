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

test('builds Twitter replies actor input', () => {
  const input = buildActorInput('twitter', {}, targets);
  assert.deepEqual(input.startUrls, targets.map((target) => target.url));
  assert.equal(input.useSearch, false);
  assert.equal(input.maxItems, 60);
});
