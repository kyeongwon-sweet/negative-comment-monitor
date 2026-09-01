import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMetaAdMedia, fetchMetaMediaCommentCounts, fetchRecentMetaMediaComments, metaPollBlockKey } from '../src/meta-ads-poll.js';

const CFG = { metaGraphBase: 'https://graph.test/v26.0' };

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('Meta poll block key is stable within the configured interval', () => {
  assert.equal(metaPollBlockKey(Date.parse('2026-09-01T01:01:00Z'), 60), metaPollBlockKey(Date.parse('2026-09-01T01:59:00Z'), 60));
  assert.notEqual(metaPollBlockKey(Date.parse('2026-09-01T01:59:00Z'), 60), metaPollBlockKey(Date.parse('2026-09-01T02:00:00Z'), 60));
});

test('Meta poll maps active ad creatives and excludes conversion ads', async () => {
  const media = await fetchMetaAdMedia(CFG, 'TOKEN', 'act_1', async () => response(200, {
    data: [
      { id: 'a1', name: '인지_소재', campaign: { name: '[빙과] 파인트 인지' }, creative: { effective_instagram_media_id: 'm1' } },
      { id: 'a2', name: 'F_I_JD_전환_소재', creative: { effective_instagram_media_id: 'm2' } },
    ],
  }));
  assert.deepEqual([...media], [['m1', { adId: 'a1', adTitle: '인지_소재', campaignName: '[빙과] 파인트 인지' }]]);
});

test('Meta poll batches media comment-count lookups before opening comment pages', async () => {
  const counts = await fetchMetaMediaCommentCounts(CFG, 'TOKEN', ['m1', 'm2'], async () => response(200, {
    m1: { comments_count: 3 }, m2: {},
  }));
  assert.deepEqual([...counts], [['m1', 3], ['m2', null]]);
});

test('Meta poll keeps only recent visible comments and stops at cutoff', async () => {
  let calls = 0;
  const rows = await fetchRecentMetaMediaComments(CFG, 'TOKEN', 'm1', {
    cutoffMs: Date.parse('2026-09-01T00:00:00Z'), maxPages: 3,
  }, async () => {
    calls += 1;
    return response(200, {
      data: [
        { id: 'new', text: '별로', timestamp: '2026-09-01T01:00:00Z' },
        { id: 'hidden', text: '숨김', timestamp: '2026-09-01T01:00:00Z', hidden: true },
        { id: 'old', text: '과거', timestamp: '2026-08-31T23:00:00Z' },
      ],
      paging: { next: 'https://graph.test/next' },
    });
  });
  assert.equal(calls, 1);
  assert.deepEqual(rows.map((row) => row.comment_id), ['new']);
});
