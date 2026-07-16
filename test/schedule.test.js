import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionIntervalMs, filterDueTargets, isCollectionDue } from '../src/schedule.js';

const dailyRun = Date.parse('2026-07-15T00:10:00Z'); // 09:10 KST

test('uses webhook without polling for owned Instagram', () => {
  assert.equal(collectionIntervalMs({ collector: 'graph-webhook' }, dailyRun), Infinity);
  assert.equal(isCollectionDue({ collector: 'graph-webhook' }, dailyRun), false);
});

test('checks posts within seven days and boosted posts daily at 09:10 KST', () => {
  const recent = { publishedAt: '2026-07-14T00:00:00Z', lastCollectedAt: '2026-07-14T00:10:00Z' };
  const oldBoosted = { publishedAt: '2026-05-01T00:00:00Z', isBoosted: true, lastCollectedAt: '2026-07-14T00:10:00Z' };
  assert.equal(collectionIntervalMs(recent, dailyRun), 24 * 60 * 60 * 1000);
  assert.equal(isCollectionDue(recent, dailyRun), true);
  assert.equal(isCollectionDue(oldBoosted, dailyRun), true);
  assert.equal(isCollectionDue(recent, Date.parse('2026-07-15T01:00:00Z')), false);
});

test('excludes ordinary posts older than seven days', () => {
  assert.equal(collectionIntervalMs({ publishedAt: '2026-07-01T00:00:00Z' }, dailyRun), Infinity);
});

test('temporarily checks every 15 minutes for three hours after a negative detection', () => {
  const now = Date.parse('2026-07-15T01:00:00Z');
  const base = { publishedAt: '2026-07-14T00:00:00Z', recentNegativeDetectedAt: '2026-07-15T00:00:00Z' };
  assert.equal(collectionIntervalMs(base, now), 15 * 60 * 1000);
  assert.equal(isCollectionDue({ ...base, lastCollectedAt: '2026-07-15T00:40:00Z' }, now), true);
  assert.equal(isCollectionDue({ ...base, lastCollectedAt: '2026-07-15T00:50:00Z' }, now), false);
});

test('does not collect the same daily target twice on the same KST date', () => {
  const targets = [
    { publishedAt: '2026-07-14T00:00:00Z', lastCollectedAt: '2026-07-14T00:10:00Z' },
    { publishedAt: '2026-07-14T00:00:00Z', lastCollectedAt: '2026-07-15T00:11:00Z' },
  ];
  assert.equal(filterDueTargets(targets, dailyRun).length, 1);
});
