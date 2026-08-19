import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPostKey, filterChangedTargets, filterBaselineTargets, filterNoSignalRescueTargets, filterDeepScanTargets, filterArchivedOrDeadTargets, summarizeDelta } from '../src/delta.js';

test('filterArchivedOrDeadTargets: 보관(ended_at)·죽은링크(not_found≥임계) 제외, 나머지 유지', () => {
  const targets = [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }];
  const counts = {
    a: { endedAt: '2026-08-10T00:00:00Z', notFoundStreak: 0 }, // 보관 → 제외
    b: { endedAt: null, notFoundStreak: 3 },                    // 죽은링크(≥2) → 제외
    c: { endedAt: null, notFoundStreak: 1 },                    // 1회는 임계 미만 → 유지(일시적일 수 있음)
    d: { endedAt: null, notFoundStreak: 0 },                    // 정상 → 유지
  };
  const { kept, skipped } = filterArchivedOrDeadTargets(targets, counts);
  assert.deepEqual(kept.map((t) => t.url).sort(), ['c', 'd']);
  assert.deepEqual(skipped.map((s) => `${s.target.url}:${s.reason}`).sort(), ['a:archived', 'b:dead-link']);
  // 임계 조정: 1회도 제외
  assert.equal(filterArchivedOrDeadTargets(targets, counts, { notFoundThreshold: 1 }).kept.map((t) => t.url).sort().join(','), 'd');
  // counts 미조회(빈 객체) = fail-open 전부 유지
  assert.equal(filterArchivedOrDeadTargets(targets, {}).kept.length, 4);
});

test('extractPostKey: 플랫폼별 게시물 ID 추출', () => {
  assert.equal(extractPostKey('https://www.instagram.com/p/DaSY7BxE6pT/'), 'ig:DaSY7BxE6pT');
  assert.equal(extractPostKey('https://www.instagram.com/reel/ABC123/'), 'ig:ABC123');
  assert.equal(extractPostKey('https://youtu.be/xObhZ0Ga7EQ'), 'yt:xObhZ0Ga7EQ');
  assert.equal(extractPostKey('https://www.youtube.com/shorts/ulySh-iHxek'), 'yt:ulySh-iHxek');
  assert.equal(extractPostKey('https://www.tiktok.com/@u/video/7656707663044185364'), 'tt:7656707663044185364');
  assert.equal(extractPostKey('https://www.tiktok.com/@pyun_lab/photo/7530011122233445566'), 'tt:7530011122233445566');
  assert.equal(extractPostKey('https://x.com/u/status/123456'), 'x:123456');
  assert.equal(extractPostKey('https://naver.com/x'), null);
});

test('filterChangedTargets: 첫확인/변화/신규글(신호없어도)은 통과, 미상·미변화는 skip', () => {
  const targets = [
    { url: 'a' }, // 첫 확인(신호 있음, last=null) → 통과
    { url: 'b' }, // 증가 → 통과
    { url: 'c' }, // 변화 없음 → skip
    { url: 'd' }, // 감소 → 통과(삭제 후 신규 댓글 가능성)
    { url: 'e' }, // 현재값 미상(last 있음) → skip
    { url: 'f' }, // 현재값 미상 + DB 미등록(postId 없음) → skip(기록 불가)
    { url: 'g' }, // 신규글: 신호 없어도 아직 미스캔 + DB 등록 → 통과(조기 감시)
    { url: 'h' }, // 이미 firstScan 했으나 여전히 신호 없음 → skip(재과금 방지)
  ];
  const counts = {
    a: { postId: '1', current: 5, last: null },
    b: { postId: '2', current: 12, last: 10 },
    c: { postId: '3', current: 8, last: 8 },
    d: { postId: '4', current: 3, last: 9 },
    e: { postId: '5', current: null, last: 4 },
    f: { postId: null, current: null, last: null },
    g: { postId: '6', current: null, last: null },
    h: { postId: '7', current: null, last: null, lastCheckedAt: '2026-07-20T00:00:00Z' },
  };
  const out = filterChangedTargets(targets, counts).map((t) => t.url);
  assert.deepEqual(out, ['a', 'b', 'd', 'g']);
});

test('summarizeDelta: 사유별 집계', () => {
  const targets = [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }, { url: 'f' }, { url: 'g' }];
  const counts = {
    a: { current: 5, last: null },  // firstScan
    b: { current: 12, last: 10 },   // changed(증가)
    c: { current: 8, last: 8 },     // unchanged
    d: { current: 3, last: 9 },     // changed(감소)
    f: { current: null, last: null }, // noSignal
    g: { current: 0, last: null },  // baseline(current=0 신규)
  };
  assert.deepEqual(summarizeDelta(targets, counts), { noSignal: 1, unchanged: 1, firstScan: 1, changed: 2, baseline: 1, scrape: 3 });
});

test('filterChangedTargets: firstScanLimit은 첫확인만 댓글수 높은 순으로 제한하고 변화글은 유지', () => {
  const targets = [
    { url: 'first-low', uploadedAt: '2026-07-28T00:00:00Z' },
    { url: 'changed-a' },
    { url: 'first-high', uploadedAt: '2026-07-27T00:00:00Z' },
    { url: 'changed-b' },
    { url: 'first-mid', uploadedAt: '2026-07-26T00:00:00Z' },
  ];
  const counts = {
    'first-low': { postId: '1', current: 1, last: null },
    'changed-a': { postId: '2', current: 11, last: 10 },
    'first-high': { postId: '3', current: 50, last: null },
    'changed-b': { postId: '4', current: 3, last: 9 },
    'first-mid': { postId: '5', current: 20, last: null },
  };
  const out = filterChangedTargets(targets, counts, { firstScanLimit: 2 }).map((t) => t.url);
  assert.deepEqual(out, ['changed-a', 'changed-b', 'first-high', 'first-mid']);
});

test('filterBaselineTargets: current=0 신규글만 baseline(무스크레이프), firstScan/changed에서 제외', () => {
  const targets = [
    { url: 'zero-new' },      // current=0 미확인 → baseline
    { url: 'pos-new' },       // current=5 미확인 → firstScan
    { url: 'zero-checked' },  // current=0 확인됨 → unchanged(제외)
  ];
  const counts = {
    'zero-new': { postId: '1', current: 0, last: null },
    'pos-new': { postId: '2', current: 5, last: null },
    'zero-checked': { postId: '3', current: 0, last: 0, lastCheckedAt: '2026-07-27T00:00:00Z' },
  };
  assert.deepEqual(filterBaselineTargets(targets, counts).map((t) => t.url), ['zero-new']);
  const scrape = filterChangedTargets(targets, counts, { firstScanLimit: 60 }).map((t) => t.url);
  assert.ok(!scrape.includes('zero-new'), 'baseline은 스크레이프 제외');
  assert.ok(scrape.includes('pos-new'), 'current>0 신규는 firstScan');
});

test('filterNoSignalRescueTargets: 확인 이력 있는 noSignal만, 가장 오래 안 본 것 먼저(stale-first)', () => {
  const targets = [
    { url: 'stale-nosignal', uploadedAt: '2026-07-20T00:00:00Z' },
    { url: 'recent-nosignal', uploadedAt: '2026-07-29T00:00:00Z' },
    { url: 'fresh-never', uploadedAt: '2026-07-29T00:00:00Z' },
    { url: 'changed', uploadedAt: '2026-07-30T00:00:00Z' },
  ];
  const counts = {
    'stale-nosignal': { postId: '1', current: null, last: null, lastCheckedAt: '2026-07-24T00:00:00Z' },  // 가장 오래 안 봄
    'recent-nosignal': { postId: '2', current: null, last: null, lastCheckedAt: '2026-07-28T00:00:00Z' }, // 최근에 봄
    'fresh-never': { postId: '3', current: null, last: null },  // lastCheckedAt 없음 → firstScan 대기열(rescue 제외)
    changed: { postId: '4', current: 2, last: 1, lastCheckedAt: '2026-07-27T00:00:00Z' },  // 신호 있음 → 제외
  };
  const out = filterNoSignalRescueTargets(targets, counts, { limit: 1 }).map((t) => t.url);
  // 게시일은 recent가 더 최신이지만, '오래 안 본' stale-nosignal이 우선 rescue돼야 한다(공정 순환).
  assert.deepEqual(out, ['stale-nosignal']);
});

test('filterDeepScanTargets: high-comment posts are limited by cadence and marked deepScan', () => {
  const now = Date.parse('2026-07-28T00:00:00Z');
  const targets = [
    { url: 'daily-due', uploadedAt: '2026-07-26T00:00:00Z' },
    { url: 'daily-not-yet', uploadedAt: '2026-07-27T00:00:00Z' },
    { url: 'two-day-due', uploadedAt: '2026-07-18T00:00:00Z' },
    { url: 'low-comment', uploadedAt: '2026-07-26T00:00:00Z' },
  ];
  const counts = {
    'daily-due': { current: 12, lastCheckedAt: '2026-07-26T23:00:00Z' },
    'daily-not-yet': { current: 15, lastCheckedAt: '2026-07-27T12:00:00Z' },
    'two-day-due': { current: 20, lastCheckedAt: '2026-07-25T00:00:00Z' },
    'low-comment': { current: 9, lastCheckedAt: '2026-07-20T00:00:00Z' },
  };
  const out = filterDeepScanTargets(targets, counts, {
    limit: 2,
    commentThreshold: 10,
    trackingDays: 14,
    now,
  });
  assert.deepEqual(out.map((t) => t.url), ['two-day-due', 'daily-due']);
  assert.equal(out.every((t) => t.deepScan), true);
});

test('filterDeepScanTargets: recent posts can use a lower comment threshold', () => {
  const now = Date.parse('2026-07-28T00:00:00Z');
  const targets = [
    { url: 'recent-low', uploadedAt: '2026-07-27T00:00:00Z' },
    { url: 'old-low', uploadedAt: '2026-07-18T00:00:00Z' },
  ];
  const counts = {
    'recent-low': { current: 5, lastCheckedAt: '2026-07-26T00:00:00Z' },
    'old-low': { current: 5, lastCheckedAt: '2026-07-25T00:00:00Z' },
  };
  const out = filterDeepScanTargets(targets, counts, {
    limit: 10,
    commentThreshold: 10,
    recentCommentThreshold: 5,
    trackingDays: 14,
    now,
  });
  assert.deepEqual(out.map((t) => t.url), ['recent-low']);
});
