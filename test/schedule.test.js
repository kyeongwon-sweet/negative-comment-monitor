import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionIntervalMs, filterDueTargets, isCollectionDue } from '../src/schedule.js';

const dailyRun = Date.parse('2026-07-15T00:10:00Z'); // 09:10 KST

test('uses webhook without polling for owned Instagram', () => {
  assert.equal(collectionIntervalMs({ collector: 'graph-webhook' }, dailyRun), Infinity);
  assert.equal(isCollectionDue({ collector: 'graph-webhook' }, dailyRun), false);
});

test('checks posts within seven days and boosted posts daily from 09:10 KST', () => {
  const recent = { publishedAt: '2026-07-14T00:00:00Z', lastCollectedAt: '2026-07-14T00:10:00Z' };
  const oldBoosted = { publishedAt: '2026-05-01T00:00:00Z', isBoosted: true, lastCollectedAt: '2026-07-14T00:10:00Z' };
  assert.equal(collectionIntervalMs(recent, dailyRun), 24 * 60 * 60 * 1000);
  assert.equal(isCollectionDue(recent, dailyRun), true);
  assert.equal(isCollectionDue(oldBoosted, dailyRun), true);
  // 오늘(같은 KST일) 이미 수집했으면 그 이후 회차에선 다시 도래하지 않는다(멱등).
  const collectedToday = { publishedAt: '2026-07-14T00:00:00Z', lastCollectedAt: '2026-07-15T00:15:00Z' };
  assert.equal(isCollectionDue(collectedToday, Date.parse('2026-07-15T01:00:00Z')), false);
});

test('still collects the day when the 09:10 KST run is dropped and a later run fires', () => {
  // 근본원인 회귀 방지: GitHub 크론이 09:10 창을 놓치고 늦게(예: 10:00 KST=01:00 UTC) 실행돼도
  // '오늘 미수집'이면 그 회차가 그날 점검을 한 번 수행해야 한다.
  const recent = { publishedAt: '2026-07-18T00:00:00Z', lastCollectedAt: '2026-07-18T00:12:00Z' };
  assert.equal(isCollectionDue(recent, Date.parse('2026-07-19T01:00:00Z')), true); // 10:00 KST
  assert.equal(isCollectionDue(recent, Date.parse('2026-07-19T03:15:00Z')), true); // 12:15 KST
  // 단, 09:10 KST 이전이면 아직 도래 아님.
  assert.equal(isCollectionDue(recent, Date.parse('2026-07-18T23:00:00Z')), false); // 08:00 KST
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
