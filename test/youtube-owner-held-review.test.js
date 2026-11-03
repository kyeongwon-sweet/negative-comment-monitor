import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHeldReviewChannels, extractHeldComments, selectNewHeld, decideApprovals,
  judgeApprovals, buildApprovePrompt, runHeldReview,
} from '../src/youtube-owner-held-review.js';

const SINCE = Date.parse('2026-10-29T03:00:00Z');

test('채널 설정: 시작시각 없는 항목은 거부(전부 공개 위험)', () => {
  assert.deepEqual(parseHeldReviewChannels('UCa@2026-10-29T03:00:00Z'), [{ channelId: 'UCa', since: SINCE }]);
  assert.deepEqual(parseHeldReviewChannels(''), []);
  assert.throws(() => parseHeldReviewChannels('UCa'), /형식 오류/);
});

test('보류 추출: 보류 상태인 최상위·답글만, 공개된 것은 제외', () => {
  const held = extractHeldComments([{
    snippet: { videoId: 'v1', topLevelComment: { id: 't1', snippet: { moderationStatus: 'heldForReview', textOriginal: 'a', publishedAt: '2026-10-29T04:00:00Z' } } },
    replies: { comments: [
      { id: 'r1', snippet: { moderationStatus: 'published', textOriginal: 'b' } },
      { id: 'r2', snippet: { moderationStatus: 'heldForReview', textOriginal: 'c', publishedAt: '2026-10-29T05:00:00Z' } },
    ] },
  }]);
  assert.deepEqual(held.map((c) => [c.id, c.videoId, c.parentId]), [['t1', 'v1', ''], ['r2', 'v1', 't1']]);
});

test('대상 선별: 시작시각 이전(기존 숨김·스팸)·알림행 있음·처리 원장·채널 본인은 절대 대상 아님', () => {
  const held = [
    { id: 'old', publishedAt: '2026-10-29T02:59:59Z' },
    { id: 'alerted', publishedAt: '2026-10-29T04:00:00Z' },
    { id: 'done', publishedAt: '2026-10-29T04:00:00Z' },
    { id: 'owner', publishedAt: '2026-10-29T04:00:00Z', authorChannelId: 'UCa' },
    { id: 'bad-date', publishedAt: '' },
    { id: 'new', publishedAt: '2026-10-29T04:00:00Z' },
  ];
  const out = selectNewHeld(held, { since: SINCE, ownerChannelId: 'UCa', alerted: new Set(['alerted']), processed: new Set(['held-review:done']) });
  assert.deepEqual(out.map((c) => c.id), ['new']);
});

test('하드넷 표현은 모델이 공개라 해도 보류', () => {
  const out = decideApprovals([{ text: '그래서 이거 누가 먹음?' }, { text: '두근두근 설레는댓글창 열기' }, { text: '맛있겠다' }], [{ approve: true }, { approve: true }, { approve: true }]);
  assert.deepEqual(out.map((c) => c.approve), [false, false, true]);
});

test('공개 판정: 응답 누락은 보류, 호출 실패는 null(아무것도 공개 안 함)', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '[{"i":0,"approve":true,"reason":""}]' }] } }] }) });
  const verdicts = await judgeApprovals({ geminiKey: 'k', heldReviewModel: 'm' }, [{ text: 'a' }, { text: 'b' }], ok);
  assert.deepEqual(verdicts.map((v) => v.approve), [true, false]);
  const fail = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await judgeApprovals({ geminiKey: 'k', heldReviewModel: 'm' }, [{ text: 'a' }], fail), null);
  assert.equal(await judgeApprovals({ geminiKey: '', heldReviewModel: 'm' }, [{ text: 'a' }], ok), null);
});

test('공개 프롬프트에 사람 기준(유행 부정·출연자 비하·장면 반박)이 들어간다', () => {
  const prompt = buildApprovePrompt([{ text: 'x' }]);
  for (const phrase of ['나만 모름', '싸가지가 없네', '품절 아니던데', '그게 뭔데', '조금이라도 애매하면 공개하지 마세요']) assert.ok(prompt.includes(phrase), phrase);
});

function fakeWorld({ llmOk = true, verifyFails = false, publishFails = false } = {}) {
  const calls = { publish: [], slack: [], ledger: [], released: [], order: [] };
  const threads = [
    { snippet: { videoId: 'v1', topLevelComment: { id: 'oldHidden', snippet: { moderationStatus: 'heldForReview', textOriginal: '광고 지겹다', publishedAt: '2026-10-20T00:00:00Z' } } } },
    { snippet: { videoId: 'v1', topLevelComment: { id: 'good', snippet: { moderationStatus: 'heldForReview', textOriginal: '맛있겠다', publishedAt: '2026-10-29T04:00:00Z' } } } },
    { snippet: { videoId: 'v1', topLevelComment: { id: 'meh', snippet: { moderationStatus: 'heldForReview', textOriginal: '먹태깡이랑 비슷', publishedAt: '2026-10-29T04:10:00Z' } } } },
  ];
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('meta_tokens')) return json([{ kind: 'youtube_owner:UCa', token: 'rt' }]);
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'at' });
    if (u.includes('/channels')) return json({ items: [{ id: 'UCa' }] });
    if (u.includes('/commentThreads')) return json({ items: threads });
    if (u.includes('negative_comment_alerts')) return json([]);
    if (u.includes('cost_usage_ledger') && init.method === 'DELETE') {
      calls.released.push(...(decodeURIComponent(u).match(/held-review:[^",)]+/g) || []));
      return json(null);
    }
    if (u.includes('cost_usage_ledger') && init.method === 'POST') {
      const rows = JSON.parse(init.body);
      if (Array.isArray(rows)) { calls.ledger.push(...rows.map((r) => r.run_key)); calls.order.push(...rows.map((r) => `ledger:${r.run_key}`)); }
      return json([]);
    }
    if (u.includes('cost_usage_ledger')) return json([]);
    if (u.includes('generativelanguage')) {
      if (!llmOk) return json({}, false, 503);
      return json({ candidates: [{ content: { parts: [{ text: '[{"i":0,"approve":true,"reason":""},{"i":1,"approve":false,"reason":"경쟁품 비교"}]' }] } }] });
    }
    if (u.includes('setModerationStatus')) {
      calls.publish.push(new URL(u).searchParams.get('id'));
      calls.order.push(`publish:${new URL(u).searchParams.get('id')}`);
      if (publishFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (u.includes('/comments?')) {
      // 실제 YouTube: comments.list는 id와 maxResults를 함께 받으면 400 unexpectedParameter(11-03 운영 실패 재현).
      const params = new URL(u).searchParams;
      if (verifyFails || (params.has('id') && params.has('maxResults'))) return json({ error: { errors: [{ reason: 'unexpectedParameter' }] } }, false, 400);
      return json({ items: [{ id: 'good', snippet: { moderationStatus: 'published' } }] });
    }
    if (u.includes('youtube_owner_video_state')) return json([{ video_id: 'v1', video_title: '멜론 쫀득바' }]);
    if (u.includes('alert_threads')) return json([{ slack_ts: '111.222' }]);
    if (u.includes('slack.com/api/chat.postMessage')) { calls.slack.push(JSON.parse(init.body)); return json({ ok: true, ts: '333.444' }); }
    throw new Error(`unexpected ${u}`);
  };
  return { fetchImpl, calls };
}

const BASE = {
  heldReviewChannels: [{ channelId: 'UCa', since: SINCE }], heldReviewDryRun: false, heldReviewModel: 'm', heldReviewMaxPages: 5,
  geminiKey: 'k', googleAdsClientId: 'c', googleAdsClientSecret: 's', youtubeApiBase: 'https://yt.test/youtube/v3',
  supabaseUrl: 'https://db.test', supabaseKey: 'svc', slackBotToken: 'xb', slackChannelId: 'C1', slackAssignees: {},
};

test('운영 흐름: 괜찮은 새 댓글만 공개, 애매한 건 보류+스레드 알림, 시작 전 보류(기존 숨김)는 손대지 않음', async () => {
  const { fetchImpl, calls } = fakeWorld();
  const summary = await runHeldReview(BASE, fetchImpl, Date.parse('2026-10-29T05:00:00Z'));
  assert.deepEqual(calls.publish, ['good']);
  assert.equal(summary.channels[0].approved, 1);
  assert.equal(summary.channels[0].kept, 1);
  assert.equal(calls.slack.length, 1);
  assert.equal(calls.slack[0].thread_ts, '111.222', '최상위 단독 게시 금지 — 데일리 스레드 답글');
  assert.match(calls.slack[0].text, /먹태깡이랑 비슷/);
  assert.doesNotMatch(calls.slack[0].text, /광고 지겹다/);
  assert.deepEqual(calls.ledger.sort(), ['held-review:good', 'held-review:meh']);
  assert.deepEqual(summary.errors, []);
});

test('판정 실패면 아무것도 공개하지 않고 원장도 남기지 않는다(다음 회차 재시도)', async () => {
  const { fetchImpl, calls } = fakeWorld({ llmOk: false });
  const summary = await runHeldReview(BASE, fetchImpl, Date.parse('2026-10-29T05:00:00Z'));
  assert.deepEqual(calls.publish, []);
  assert.deepEqual(calls.ledger, []);
  assert.equal(calls.slack.length, 0);
  assert.equal(summary.errors.length, 1);
});

test('dry-run은 공개·알림·원장 쓰기를 하지 않는다', async () => {
  const { fetchImpl, calls } = fakeWorld();
  const summary = await runHeldReview({ ...BASE, heldReviewDryRun: true }, fetchImpl, Date.parse('2026-10-29T05:00:00Z'));
  assert.deepEqual([calls.publish, calls.slack, calls.ledger], [[], [], []]);
  assert.equal(summary.channels[0].approved, 1);
  assert.equal(summary.channels[0].kept, 1);
});

test('링크·메신저 유도가 든 댓글은 모델이 공개라 해도 보류(스팸)', () => {
  const out = decideApprovals(
    [{ text: '맛있겠다 https://bit.ly/x' }, { text: '부업 문의 open.kakao 로' }, { text: '맛있겠다' }],
    [{ approve: true }, { approve: true }, { approve: true }],
  );
  assert.deepEqual(out.map((c) => c.approve), [false, false, true]);
});

test("공개 확인(comments.list)이 실패해도 공개된 댓글은 원장에 남긴다 — 보류 누락 경보 오탐 방지(11-03)", async () => {
  const { fetchImpl, calls } = fakeWorld({ verifyFails: true });
  const summary = await runHeldReview(BASE, fetchImpl, Date.parse("2026-10-29T05:00:00Z"));
  assert.deepEqual(calls.publish, ["good"]);
  assert.ok(calls.ledger.includes("held-review:good"), "공개 호출 성공 건은 확인 실패여도 원장 기록");
  assert.ok(calls.ledger.includes("held-review:meh"), "보류 알림이 나간 건도 원장 기록");
  assert.equal(summary.channels[0].unverified, 1);
  assert.ok(summary.errors.some((e) => e.includes("미확인 1")));
});

test("선기록: 공개 전에 원장을 남긴다(봇이 공개한 댓글은 반드시 원장이 있다 — 보류 누락 오탐 방지)", async () => {
  const { fetchImpl, calls } = fakeWorld();
  await runHeldReview(BASE, fetchImpl, Date.parse("2026-10-29T05:00:00Z"));
  const ledgerAt = calls.order.indexOf("ledger:held-review:good");
  const publishAt = calls.order.indexOf("publish:good");
  assert.ok(ledgerAt >= 0 && publishAt >= 0);
  assert.ok(ledgerAt < publishAt, "원장 → 공개 순서");
});

test("선기록: 공개 호출이 실패하면 원장을 지워 다음 회차가 다시 시도한다", async () => {
  const { fetchImpl, calls } = fakeWorld({ publishFails: true });
  const summary = await runHeldReview(BASE, fetchImpl, Date.parse("2026-10-29T05:00:00Z"));
  assert.deepEqual(calls.released, ["held-review:good"]);
  assert.equal(summary.channels[0].publishFailed, 1);
  assert.ok(summary.errors.some((e) => e.includes("공개 실패 1")));
});
