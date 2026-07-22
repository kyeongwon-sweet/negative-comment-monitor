import test from 'node:test';
import assert from 'node:assert/strict';
import { FALSE_POSITIVE_REASONS, falsePositiveStats, loadFalsePositives, recordFalsePositive } from '../src/review.js';

const CFG = { supabaseUrl: 'https://db.example', supabaseKey: 'svc' };

test('FALSE_POSITIVE_REASONS: 6개 사유(#5)', () => {
  assert.deepEqual(FALSE_POSITIVE_REASONS.map((r) => r.value),
    ['unrelated', 'positive_neutral', 'joke_meme', 'insult_other', 'competitor_neutral', 'other']);
});

test('loadFalsePositives: 오탐 지문 Set 반환, 쿼리에 review_decision=false_positive 포함', async () => {
  let url;
  const fetchImpl = async (u) => { url = u; return { ok: true, json: async () => [{ fingerprint: 'fp1' }, { fingerprint: 'fp3' }] }; };
  const set = await loadFalsePositives(CFG, ['fp1', 'fp2', 'fp3'], fetchImpl);
  assert.match(url, /negative_comment_alerts/);
  assert.match(url, /review_decision=eq\.false_positive/);
  assert.equal(set.has('fp1'), true);
  assert.equal(set.has('fp3'), true);
  assert.equal(set.has('fp2'), false);
});

test('loadFalsePositives: 실패/비활성/빈 입력은 빈 Set(억제 안 함)', async () => {
  assert.equal((await loadFalsePositives(CFG, ['fp1'], async () => ({ ok: false }))).size, 0);
  assert.equal((await loadFalsePositives(CFG, ['fp1'], async () => { throw new Error('x'); })).size, 0);
  assert.equal((await loadFalsePositives({}, ['fp1'], async () => ({ ok: true, json: async () => [] }))).size, 0);
  assert.equal((await loadFalsePositives(CFG, [], async () => ({ ok: true, json: async () => [] }))).size, 0);
});

test('recordFalsePositive: slack_channel_id+slack_ts로 식별(댓글 원문 미사용) + 필드 세팅', async () => {
  let url; let body;
  const fetchImpl = async (u, o) => { url = u; body = JSON.parse(o.body); return { ok: true }; };
  const ok = await recordFalsePositive(CFG, {
    slackChannelId: 'C1', slackTs: '1.2', reviewedBy: 'U9', reason: 'joke_meme', now: Date.parse('2026-07-22T00:00:00Z'),
  }, fetchImpl);
  assert.equal(ok, true);
  assert.match(url, /slack_channel_id=eq\.C1/);
  assert.match(url, /slack_ts=eq\.1\.2/);
  assert.equal(body.review_decision, 'false_positive');
  assert.equal(body.reviewed_by, 'U9');
  assert.equal(body.false_positive_reason, 'joke_meme');
  assert.equal(body.reviewed_at, '2026-07-22T00:00:00.000Z');
  assert.ok(!('comment_text' in body), '댓글 원문을 넣지 않는다');
});

test('recordFalsePositive: ts 없으면 fingerprint로 폴백, 둘 다 없으면 false', async () => {
  let url;
  const fetchImpl = async (u) => { url = u; return { ok: true }; };
  assert.equal(await recordFalsePositive(CFG, { fingerprint: 'fpX', reviewedBy: 'U9' }, fetchImpl), true);
  assert.match(url, /fingerprint=eq\.fpX/);
  assert.equal(await recordFalsePositive(CFG, { reviewedBy: 'U9' }, fetchImpl), false);
});

test('recordFalsePositive: 주어지지 않은 필드는 덮어쓰지 않음(사유만 갱신 시 reviewed_by 보존)', async () => {
  let body;
  const fetchImpl = async (u, o) => { body = JSON.parse(o.body); return { ok: true }; };
  await recordFalsePositive(CFG, { slackChannelId: 'C1', slackTs: '1.2', reason: 'other' }, fetchImpl);
  assert.ok(!('reviewed_by' in body), 'reviewedBy 미제공 시 reviewed_by 미포함');
  assert.equal(body.false_positive_reason, 'other');
});

test('recordFalsePositive: 실패해도 예외 없이 false(버튼 UX 유지)', async () => {
  assert.equal(await recordFalsePositive(CFG, { fingerprint: 'x' }, async () => ({ ok: false })), false);
  assert.equal(await recordFalsePositive(CFG, { fingerprint: 'x' }, async () => { throw new Error('x'); }), false);
});

test('falsePositiveStats: classifier_hash별 오탐률(#8)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      { classifier_hash: 'h1', review_decision: 'false_positive' },
      { classifier_hash: 'h1', review_decision: null },
      { classifier_hash: 'h1', review_decision: null },
      { classifier_hash: 'h2', review_decision: 'false_positive' },
    ],
  });
  const stats = await falsePositiveStats(CFG, fetchImpl);
  assert.equal(stats.h1.alerts, 3);
  assert.equal(stats.h1.falsePositives, 1);
  assert.equal(stats.h1.rate, 0.333);
  assert.equal(stats.h2.rate, 1);
});
