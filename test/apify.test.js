import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActorInput, chunkActorTargets, runActor, runActorBatches } from '../src/apify.js';

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

test('TikTok targets are split into bounded batches while other platforms remain single-run', () => {
  const many = Array.from({ length: 123 }, (_, i) => ({ url: `https://tiktok.test/${i}` }));
  assert.deepEqual(chunkActorTargets('tiktok', many, { tiktokBatchSize: 50 }).map((batch) => batch.length), [50, 50, 23]);
  assert.deepEqual(chunkActorTargets('instagram', many, { tiktokBatchSize: 50 }).map((batch) => batch.length), [123]);
});

test('TikTok batch failure is isolated and successful batches are preserved', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://tiktok.test/${i}` }));
  let calls = 0;
  const runner = async (config, platform, batch) => {
    calls += 1;
    if (calls === 2) throw new Error('batch timeout');
    return batch.map((target) => ({ url: target.url }));
  };
  const result = await runActorBatches(
    { tiktokBatchSize: 2 }, 'tiktok', many, async () => {}, {}, runner,
  );
  assert.equal(result.totalBatches, 3);
  assert.deepEqual(result.successes.map((success) => success.targets.length), [2, 1]);
  assert.deepEqual(result.failures.map((failure) => failure.targets.length), [2]);
  assert.match(result.failures[0].error, /batch timeout/);
});

test('timed-out Apify run is aborted so it cannot keep consuming budget', async () => {
  const requested = [];
  const fetchImpl = async (url, options = {}) => {
    requested.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).includes('/acts/')) {
      return { ok: true, text: async () => JSON.stringify({ data: { id: 'run-1', status: 'RUNNING', defaultDatasetId: 'ds-1' } }) };
    }
    if (String(url).includes('/abort')) return { ok: true, text: async () => '{}' };
    throw new Error(`unexpected request ${url}`);
  };
  await assert.rejects(
    () => runActor({
      actors: { tiktok: { id: 'actor', input: {} } }, apifyApiToken: 'secret',
      runTimeoutMs: 0, pollIntervalMs: 0,
    }, 'tiktok', targets, fetchImpl),
    /timed out/,
  );
  assert.equal(requested.some((request) => request.url.includes('/actor-runs/run-1/abort') && request.method === 'POST'), true);
});
