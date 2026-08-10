import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBacklog, morningStartInstant, buildBacklogMessage } from '../src/meta-batch-watchdog.js';

const NOW = Date.parse('2026-08-10T04:00:00Z'); // 13:00 KST (워치독 실행 시점)

test('morningStartInstant: 오늘 KST windowStart:00', () => {
  assert.equal(morningStartInstant(NOW, 8), Date.parse('2026-08-10T08:00:00+09:00'));
});

test('evaluateBacklog: 창(08:00) 전 수신 미처리분만 stale', () => {
  const events = [
    { received_at: '2026-08-09T20:00:00Z' }, // 05:00 KST 08-10, 창 전 → stale
    { received_at: '2026-08-10T00:30:00Z' }, // 09:30 KST, 창 중 → not
    { received_at: '2026-08-10T03:00:00Z' }, // 12:00 KST, 창 후 → not
  ];
  const r = evaluateBacklog(events, NOW, 8);
  assert.equal(r.stale, 1);
  assert.equal(r.total, 3);
  assert.equal(r.oldest, Date.parse('2026-08-09T20:00:00Z'));
});

test('evaluateBacklog: 창 이후 수신만 있으면 stale 0 (정상 대기)', () => {
  const events = [
    { received_at: '2026-08-10T02:30:00Z' }, // 11:30 KST, 창 후 → 정상 대기
    { received_at: '2026-08-10T03:30:00Z' }, // 12:30 KST → 정상 대기
  ];
  const r = evaluateBacklog(events, NOW, 8);
  assert.equal(r.stale, 0);
  assert.equal(r.total, 2);
});

test('evaluateBacklog: 미처리 없음 → stale 0', () => {
  assert.equal(evaluateBacklog([], NOW, 8).stale, 0);
});

test('buildBacklogMessage: 담당자 멘션·건수 포함', () => {
  const msg = buildBacklogMessage(NOW, { stale: 5, oldest: Date.parse('2026-08-09T20:00:00Z'), total: 7 }, 'UHKW');
  assert.match(msg, /인지 광고 아침 배치 미실행 의심/);
  assert.match(msg, /미처리\(창 전 수신\) 5건/);
  assert.match(msg, /<@UHKW>/);
});
