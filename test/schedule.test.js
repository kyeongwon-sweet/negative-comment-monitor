import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionIntervalMs, filterDueTargets } from '../src/schedule.js';

const now = Date.parse('2026-07-15T09:00:00Z');
test('uses webhook without polling for owned Instagram', () => {
  assert.equal(collectionIntervalMs({ collector: 'graph-webhook' }, now), Infinity);
});
test('checks new or boosted posts hourly and old posts daily', () => {
  assert.equal(collectionIntervalMs({ publishedAt: '2026-07-14T09:00:00Z' }, now), 60 * 60 * 1000);
  assert.equal(collectionIntervalMs({ publishedAt: '2026-05-01T09:00:00Z' }, now), 24 * 60 * 60 * 1000);
});
test('temporarily checks every 15 minutes after a negative detection', () => {
  assert.equal(collectionIntervalMs({ recentNegativeDetectedAt: '2026-07-15T08:00:00Z' }, now), 15 * 60 * 1000);
});
test('filters targets that are not due', () => {
  const targets = [
    { publishedAt: '2026-07-14T09:00:00Z', lastCollectedAt: '2026-07-15T08:30:00Z' },
    { publishedAt: '2026-07-14T09:00:00Z', lastCollectedAt: '2026-07-15T07:00:00Z' },
  ];
  assert.equal(filterDueTargets(targets, now).length, 1);
});
