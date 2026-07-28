import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPostKey, filterChangedTargets, filterNoSignalRescueTargets, summarizeDelta } from '../src/delta.js';

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
  const targets = [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }, { url: 'f' }];
  const counts = {
    a: { current: 5, last: null },  // firstScan
    b: { current: 12, last: 10 },   // changed(증가)
    c: { current: 8, last: 8 },     // unchanged
    d: { current: 3, last: 9 },     // changed(감소)
    f: { current: null, last: null }, // noSignal
  };
  assert.deepEqual(summarizeDelta(targets, counts), { noSignal: 1, unchanged: 1, firstScan: 1, changed: 2, scrape: 3 });
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

test('filterNoSignalRescueTargets: 이미 확인 이력이 있는 noSignal만 최신순 제한 rescue', () => {
  const targets = [
    { url: 'old-nosignal', uploadedAt: '2026-07-20T00:00:00Z' },
    { url: 'new-nosignal', uploadedAt: '2026-07-28T00:00:00Z' },
    { url: 'fresh-nosignal', uploadedAt: '2026-07-29T00:00:00Z' },
    { url: 'changed', uploadedAt: '2026-07-30T00:00:00Z' },
  ];
  const counts = {
    'old-nosignal': { postId: '1', current: null, last: null, lastCheckedAt: '2026-07-27T00:00:00Z' },
    'new-nosignal': { postId: '2', current: null, last: null, lastCheckedAt: '2026-07-27T00:00:00Z' },
    'fresh-nosignal': { postId: '3', current: null, last: null },
    changed: { postId: '4', current: 2, last: 1, lastCheckedAt: '2026-07-27T00:00:00Z' },
  };
  const out = filterNoSignalRescueTargets(targets, counts, { limit: 1 }).map((t) => t.url);
  assert.deepEqual(out, ['new-nosignal']);
});
