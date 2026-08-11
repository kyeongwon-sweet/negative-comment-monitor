import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTargetSyncGap, buildGapMessage } from '../src/target-sync-watchdog.js';
import { extractPostKey } from '../src/delta.js';

const NOW = Date.parse('2026-08-10T05:00:00Z'); // KST 14:00, cutoff(4h) = 2026-08-10T01:00:00Z

test('evaluateTargetSyncGap: 유예초과+댓글있음+감시카테고리+GAS없음 만 갭', () => {
  const posts = [
    { id: 'gap1', channel_type: '위성채널', url: 'https://www.instagram.com/p/AAA/', created_at: '2026-08-09T20:00:00Z' }, // 갭
    { id: 'recent', channel_type: '위성채널', url: 'https://www.instagram.com/p/BBB/', created_at: '2026-08-10T04:30:00Z' }, // 유예내 → 대기
    { id: 'nocomment', channel_type: '위성채널', url: 'https://www.instagram.com/p/CCC/', created_at: '2026-08-09T20:00:00Z' }, // 댓글없음
    { id: 'excl', channel_type: '무상시딩 (영상)', url: 'https://www.instagram.com/p/DDD/', created_at: '2026-08-09T20:00:00Z' }, // 미감시 카테고리
    { id: 'ingas', channel_type: '위성채널', url: 'https://www.instagram.com/p/EEE/', created_at: '2026-08-09T20:00:00Z' }, // GAS에 있음
  ];
  const commentSet = new Set(['gap1', 'recent', 'excl', 'ingas']); // nocomment만 댓글 없음
  const targetKeys = new Set([extractPostKey('https://www.instagram.com/p/EEE/')]);
  const monitoredCats = new Set(['위성채널']); // 무상시딩은 봇 미감시(GAS 타겟에 없음)
  const gaps = evaluateTargetSyncGap({ posts, commentSet, targetKeys, monitoredCats }, NOW, 4).map((p) => p.id);
  assert.deepEqual(gaps, ['gap1']);
});

test('evaluateTargetSyncGap: 갭 없으면 빈 배열', () => {
  const posts = [{ id: 'x', channel_type: '위성채널', url: 'https://www.instagram.com/p/ZZZ/', created_at: '2026-08-10T04:50:00Z' }];
  const gaps = evaluateTargetSyncGap({ posts, commentSet: new Set(['x']), targetKeys: new Set(), monitoredCats: new Set(['위성채널']) }, NOW, 4);
  assert.equal(gaps.length, 0); // 유예 내(대기)
});

test('buildGapMessage: 건수·채널·담당자 포함', () => {
  const msg = buildGapMessage(NOW, [{ channel_type: '위성채널' }, { channel_type: '바이럴 (영상)' }], 'UHKW');
  assert.match(msg, /신규글 감시 누락 의심/);
  assert.match(msg, /2건/);
  assert.match(msg, /<@UHKW>/);
});
