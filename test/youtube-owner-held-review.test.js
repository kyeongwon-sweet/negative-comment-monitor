import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHeldReviewChannels, extractHeldComments, selectNewHeld, decideApprovals,
  judgeApprovals, buildApprovePrompt, runHeldReview, pageIsOlderThan } from '../src/youtube-owner-held-review.js';

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

test('공개 판정: 강한 모델의 일시 오류를 재시도한 뒤 운영 모델로 안전하게 폴백한다', async () => {
  const models = [];
  const fetchImpl = async (input) => {
    const model = decodeURIComponent(String(input).match(/models\/([^:]+):/)?.[1] || '');
    models.push(model);
    if (model === 'strong') return { ok: false, status: 503, json: async () => ({ error: { status: 'UNAVAILABLE' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '[{"i":0,"approve":true,"reason":""}]' }] } }] }) };
  };
  const verdicts = await judgeApprovals({
    geminiKey: 'k', heldReviewModel: 'strong', heldReviewFallbackModel: 'stable',
    geminiMaxAttempts: 2, geminiRetryBaseMs: 0,
  }, [{ text: '맛있겠다' }], fetchImpl);
  assert.deepEqual(models, ['strong', 'strong', 'stable']);
  assert.equal(verdicts[0].approve, true);
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
    if (u.includes('/channels')) { calls.verify = (calls.verify || 0) + 1; return json({ items: [{ id: 'UCa' }] }); }
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

test("공개 확인(comments.list)이 늦어도 204 접수 건은 원장에 남기고 회차 실패로 세지 않는다 — 전파 지연 오경보 방지(11-03)", async () => {
  const { fetchImpl, calls } = fakeWorld({ verifyFails: true });
  const summary = await runHeldReview(BASE, fetchImpl, Date.parse("2026-10-29T05:00:00Z"));
  assert.deepEqual(calls.publish, ["good"]);
  assert.ok(calls.ledger.includes("held-review:good"), "공개 호출 성공 건은 확인 실패여도 원장 기록");
  assert.ok(calls.ledger.includes("held-review:meh"), "보류 알림이 나간 건도 원장 기록");
  assert.equal(summary.channels[0].unverified, 1);
  assert.deepEqual(summary.errors, [], "204 접수 뒤 검증 지연은 degraded 실패가 아니다");
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

// quota(11-03 소유채널 확대 전): 목록은 재발급만, 소유 검증은 실제 공개할 때만. 보류함은 최근치만 읽는다.
test("공개할 게 없으면(dry-run 포함) 토큰 소유 검증 호출을 하지 않는다", async () => {
  const { fetchImpl, calls } = fakeWorld();
  await runHeldReview({ ...BASE, heldReviewDryRun: true }, fetchImpl, Date.parse("2026-10-29T05:00:00Z"));
  assert.equal(calls.verify || 0, 0);
});

test("실제 공개할 때는 공개 직전에 토큰 소유 채널을 검증한다", async () => {
  const { fetchImpl, calls } = fakeWorld();
  await runHeldReview(BASE, fetchImpl, Date.parse("2026-10-29T05:00:00Z"));
  assert.equal(calls.verify, 1);
  assert.deepEqual(calls.publish, ["good"]);
});

test("프로젝트 공통 quota 오류는 첫 채널에서 중단해 뒤 채널을 헛호출하지 않는다", async () => {
  let threadReads = 0;
  const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes('meta_tokens')) return response([
      { kind: 'youtube_owner:UCa', token: 'rt-a' },
      { kind: 'youtube_owner:UCb', token: 'rt-b' },
    ]);
    if (value.includes('oauth2.googleapis.com')) return response({ access_token: 'at' });
    if (value.includes('/commentThreads')) {
      threadReads += 1;
      return response({ error: { errors: [{ reason: 'quotaExceeded' }] } }, false, 403);
    }
    throw new Error(`unexpected ${value}`);
  };
  const summary = await runHeldReview({
    ...BASE,
    heldReviewChannels: [
      { channelId: 'UCa', since: SINCE },
      { channelId: 'UCb', since: SINCE },
    ],
  }, fetchImpl, Date.parse('2026-10-29T05:00:00Z'));

  assert.equal(threadReads, 1);
  assert.equal(summary.channels.length, 1);
  assert.equal(summary.quotaExhausted, true);
  assert.match(summary.errors[0], /quotaExceeded/);
});

test("pageIsOlderThan: 페이지의 모든 댓글(답글 포함)이 기준보다 오래됐을 때만 중단", () => {
  const t = (top, replies = []) => ({ snippet: { topLevelComment: { snippet: { publishedAt: top } } }, replies: { comments: replies.map((p) => ({ snippet: { publishedAt: p } })) } });
  const stop = Date.parse("2026-11-01T00:00:00Z");
  assert.equal(pageIsOlderThan([t("2026-10-30T00:00:00Z"), t("2026-10-29T00:00:00Z")], stop), true);
  assert.equal(pageIsOlderThan([t("2026-10-30T00:00:00Z", ["2026-11-02T00:00:00Z"])], stop), false, "옛 스레드에 새 답글이 있으면 계속 읽는다");
  assert.equal(pageIsOlderThan([t("2026-11-02T00:00:00Z")], stop), false);
  assert.equal(pageIsOlderThan([], stop), false);
  assert.equal(pageIsOlderThan([t("2026-10-30T00:00:00Z")], NaN), false, "기준 없으면 중단 안 함");
});

// 11-04 재발방지: 승인 프롬프트만 보고 공개한 댓글을 빠른 감시 분류기가 뒤늦게 부정으로 잡았고('테무광고가 좋아지는 영상'),
// 봇이 공개한 댓글은 유튜브에서 다시 숨겨지지 않아 스튜디오 삭제만 남았다 → 공개 직전에 같은 부정 분류기로 2차 확인.
function gatedWorld() {
  const base = fakeWorld();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('comment_classification_cache')) return { ok: true, status: 200, json: async () => (init.method === 'POST' ? null : []) };
    return base.fetchImpl(url, init);
  };
  return { ...base, fetchImpl };
}
const GATED = { ...BASE, heldReviewNegativeGate: true, youtubeOwnerChannels: [{ channelId: 'UCa', name: '먹는김에', channelCategory: '소유 YouTube' }], managedChannelCategories: ['소유 youtube'] };
const verdict = (alert, category = '') => ({ alert, category, reason: '', priority: alert ? 'high' : 'normal', engine: 'llm' });

test('2차 관문: 승인 프롬프트가 공개라 해도 부정 분류기가 부정이면 공개하지 않고 보류로 둔다', async () => {
  const { fetchImpl, calls } = gatedWorld();
  const classifier = async (items) => items.map(() => verdict(true, '브랜드 적대/조롱'));
  const summary = await runHeldReview(GATED, fetchImpl, Date.parse('2026-10-29T05:00:00Z'), classifier);
  assert.deepEqual(calls.publish, [], '공개 호출 없음');
  assert.equal(summary.channels[0].negativeGateBlocked, 1);
  assert.equal(summary.channels[0].kept, 2, '분류기 차단분도 보류 알림 묶음에 들어간다');
  assert.match(calls.slack[0].text, /부정 분류기/);
});

test('2차 관문: 부정 분류기도 괜찮다고 하면 그대로 공개한다', async () => {
  const { fetchImpl, calls } = gatedWorld();
  const classifier = async (items) => items.map(() => verdict(false, '정상'));
  const summary = await runHeldReview(GATED, fetchImpl, Date.parse('2026-10-29T05:00:00Z'), classifier);
  assert.deepEqual(calls.publish, ['good']);
  assert.equal(summary.channels[0].negativeGateBlocked, 0);
});

test('2차 관문: 분류기가 실패하면 공개하지 않는다(fail-closed)', async () => {
  const { fetchImpl, calls } = gatedWorld();
  const classifier = async () => { throw new Error('LLM down'); };
  const summary = await runHeldReview(GATED, fetchImpl, Date.parse('2026-10-29T05:00:00Z'), classifier);
  assert.deepEqual(calls.publish, []);
  assert.equal(summary.channels[0].negativeGateBlocked, 1);
});

test('2차 관문은 운영 설정에서 기본으로 켜져 있다(HELD_REVIEW_NEGATIVE_GATE=false로만 끔)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/youtube-owner-held-review.js', import.meta.url), 'utf8');
  assert.match(src, /heldReviewNegativeGate: String\(env\.HELD_REVIEW_NEGATIVE_GATE \|\| 'true'\)/);
  assert.match(src, /config\.heldReviewNegativeGate === true\s*\n?\s*\? await gateApprovalsWithClassifier/);
});

test('quota 브레이크: 사용률이 높으면 승인 봇 회차를 건너뛴다(보류함 읽기·공개 없음, 댓글은 비공개로 대기)', async () => {
  const { fetchImpl: baseFetch, calls } = fakeWorld();
  let threadReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('/commentThreads')) threadReads += 1;
    if (u.includes('cost_usage_ledger') && u.includes('yt-units:')) return { ok: true, status: 200, json: async () => [{ run_key: 'yt-units:2026-10-28:x:1.1.1.1:6500' }] };
    return baseFetch(url, init);
  };
  const summary = await runHeldReview(BASE, fetchImpl, Date.parse('2026-10-29T05:00:00Z'));
  assert.match(summary.skipped, /quota-brake/);
  assert.equal(threadReads, 0);
  assert.deepEqual(calls.publish, []);
});

// 11-05 quota 절감: 승인 봇은 주기(기본 60분) 칸을 원장으로 선점해 그 칸에 한 번만 돈다(15분 루프·시간별 잡 공용).
function slotWorld(taken) {
  const base = fakeWorld();
  let threadReads = 0;
  const slots = [];
  const fetchImpl = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('/commentThreads')) threadReads += 1;
    if (u.includes('cost_usage_ledger') && init.method === 'POST' && String(init.body).includes('held-review-slot:')) {
      slots.push(JSON.parse(init.body).run_key);
      return { ok: true, status: 201, json: async () => (taken ? [] : [JSON.parse(init.body)]) };
    }
    return base.fetchImpl(url, init);
  };
  return { ...base, fetchImpl, reads: () => threadReads, slots };
}

test('승인 봇 주기: 이번 칸을 이미 다른 회차가 잡았으면 보류함을 읽지 않고 건너뛴다', async () => {
  const w = slotWorld(true);
  const summary = await runHeldReview({ ...BASE, heldReviewEveryMinutes: 60 }, w.fetchImpl, Date.parse('2026-10-29T05:10:00Z'));
  assert.match(summary.skipped, /slot-taken\(60m\)/);
  assert.equal(w.reads(), 0);
  assert.deepEqual(w.calls.publish, []);
});

test('승인 봇 주기: 새 칸이면 평소대로 돌고, 칸 키는 시각 문자열이 아닌 숫자 칸이다', async () => {
  const w = slotWorld(false);
  const now = Date.parse('2026-10-29T05:10:00Z');
  await runHeldReview({ ...BASE, heldReviewEveryMinutes: 60 }, w.fetchImpl, now);
  assert.deepEqual(w.calls.publish, ['good']);
  assert.deepEqual(w.slots, [`held-review-slot:60:${Math.floor(now / 3600000)}`]);
});
