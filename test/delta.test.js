import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPostKey, filterChangedTargets, summarizeDelta } from '../src/delta.js';

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

test('filterChangedTargets: 첫확인/변화(증가·감소)는 통과, 미상·미변화는 skip', () => {
  const targets = [
    { url: 'a' }, // 첫 확인(신호 있음, last=null) → 통과
    { url: 'b' }, // 증가 → 통과
    { url: 'c' }, // 변화 없음 → skip
    { url: 'd' }, // 감소 → 통과(삭제 후 신규 댓글 가능성 — 블라인드스팟 방지)
    { url: 'e' }, // 현재값 미상(last 있음) → skip
    { url: 'f' }, // 현재값 미상(첫 확인) → skip(비용 안전)
  ];
  const counts = {
    a: { postId: '1', current: 5, last: null },
    b: { postId: '2', current: 12, last: 10 },
    c: { postId: '3', current: 8, last: 8 },
    d: { postId: '4', current: 3, last: 9 },
    e: { postId: '5', current: null, last: 4 },
    f: { postId: null, current: null, last: null },
  };
  const out = filterChangedTargets(targets, counts).map((t) => t.url);
  assert.deepEqual(out, ['a', 'b', 'd']);
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
