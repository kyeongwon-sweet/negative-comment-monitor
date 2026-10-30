import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicAudit, auditAlertRow, PUBLIC_AUDIT_ACTOR } from '../src/youtube-owner-public-audit.js';
import { commentFingerprint } from '../src/dedup.js';
import { actionDefinitions } from '../src/slack.js';

const CH = 'UCxfjcCvRPOPzo6PeAttO4Dg';

function world({ alerted = [], llm = 'ok' } = {}) {
  const calls = { cards: [], rows: [], hides: 0 };
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
  const threads = [
    { snippet: { videoId: 'v1', totalReplyCount: 1, topLevelComment: { id: 'bad', snippet: { textOriginal: '싸가지가 읍네', authorChannelId: { value: 'UCx' }, authorDisplayName: '@a' } } },
      replies: { comments: [{ id: 'bad.r', snippet: { textOriginal: '맛있겠다', authorChannelId: { value: 'UCy' } } }] } },
    { snippet: { videoId: 'v1', totalReplyCount: 0, topLevelComment: { id: 'owner', snippet: { textOriginal: '고정 댓글', authorChannelId: { value: CH } } } } },
    { snippet: { videoId: 'v1', totalReplyCount: 0, topLevelComment: { id: 'decided', snippet: { textOriginal: '광고 지겹다', authorChannelId: { value: 'UCz' } } } } },
  ];
  const target = { platform: 'youtube', postKey: 'yt:v1', url: 'https://www.youtube.com/watch?v=v1' };
  const alertedFps = new Set(alerted.map((id) => commentFingerprint(target, { id, platform: 'youtube' })));
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('youtube_owner_video_state')) return json([{ video_id: 'v1', video_title: '멜론 쫀득바' }]);
    if (u.includes('meta_tokens')) return json([{ kind: `youtube_owner:${CH}`, token: 'rt' }]);
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'at' });
    if (u.includes('/channels') && u.includes('mine=true')) return json({ items: [{ id: CH }] });
    if (u.includes('/channels')) return json({ items: [{ snippet: { title: '먹짱언니_mukzzang unnie' } }] });
    if (u.includes('/commentThreads')) return json({ items: threads });
    if (u.includes('negative_comment_alerts') && init.method === 'POST') { calls.rows.push(JSON.parse(init.body)); return json(null); }
    if (u.includes('negative_comment_alerts')) {
      const fps = decodeURIComponent(u).match(/in\.\((.*)\)/)?.[1].split(',').map((v) => v.replace(/"/g, '')) || [];
      return json(fps.filter((fp) => alertedFps.has(fp)).map((fingerprint) => ({ fingerprint })));
    }
    if (u.includes('alert_threads')) return json([{ slack_ts: '111.222' }]);
    if (u.includes('chat.postMessage')) { calls.cards.push(JSON.parse(init.body)); return json({ ok: true, ts: '333.444' }); }
    if (u.includes('reactions.remove')) return json({ ok: true });
    if (u.includes('setModerationStatus')) { calls.hides += 1; return json({}); }
    throw new Error(`unexpected ${u}`);
  };
  // 약한 모델이 '싸가지'만 부정, 강한 모델도 동의(게이트 통과) — 나머지는 정상.
  const classifier = async (items) => (llm === 'fail' ? null : items.map((item) => (item.text.includes('싸가지')
    ? { alert: true, category: '브랜드 적대/조롱', reason: '출연자 비하', priority: 'high' }
    : { alert: false, category: '정상', reason: '', priority: 'normal' })));
  return { fetchImpl, calls, classifier };
}

const BASE = {
  youtubeOwnerChannels: [{ name: '먹짱언니', channelId: CH, channelCategory: '소유 YouTube' }],
  googleAdsClientId: 'c', googleAdsClientSecret: 's', youtubeApiBase: 'https://yt.test/youtube/v3',
  supabaseUrl: 'https://db.test', supabaseKey: 'svc', slackBotToken: 'xb', slackChannelId: 'C1', slackAssignees: {},
  managedChannelCategories: ['소유 youtube', '위성채널'], youtubeOwnerDefaultProductName: 'JD',
  publicAuditDryRun: false, publicAuditMaxCards: 30, publicAuditMaxPages: 5, publicAuditMaxReplyPages: 2,
  geminiKey: 'k', ownedBrandEscalationModel: 'gemini-3.5-flash-lite', slackPostMinIntervalMs: 0,
};

test('재감사: 부정은 카드+hold 행으로만 올리고 절대 숨기지 않는다, 채널 본인·이미 판정된 댓글 제외', async () => {
  const { fetchImpl, calls, classifier } = world({ alerted: ['decided'] });
  const summary = await runPublicAudit(BASE, fetchImpl, Date.parse('2026-10-30T02:00:00Z'), classifier);
  assert.equal(summary.flagged, 1);
  assert.equal(summary.cardsPosted, 1);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0].comment_id, 'bad');
  assert.equal(summary.publicComments, 3, '본인 고정댓글 제외(최상위2+답글1)');
  assert.equal(summary.alreadyJudged, 1);
  assert.equal(calls.hides, 0, '재감사는 숨김 API를 부르지 않는다');
  assert.equal(calls.cards.length, summary.cardsPosted);
  for (const row of calls.rows) {
    assert.equal(row.review_decision, 'hold', '15분 자동숨김(pending-hide)이 가져가지 않도록 hold');
    assert.equal(row.reviewed_by, PUBLIC_AUDIT_ACTOR);
  }
  assert.ok(calls.cards.every((card) => card.thread_ts === '111.222'), '최상위 단독 카드 금지');
});

test('재감사 카드는 소유 YouTube에도 [숨김] 버튼이 붙는다', () => {
  const defs = actionDefinitions({ platform: 'youtube', channelCategory: '소유 YouTube' }, BASE.managedChannelCategories);
  assert.ok(defs.some(([, action]) => action === 'hide'));
});

test('dry-run은 카드·행을 만들지 않는다', async () => {
  const { fetchImpl, calls, classifier } = world();
  const summary = await runPublicAudit({ ...BASE, publicAuditDryRun: true }, fetchImpl, Date.parse('2026-10-30T02:00:00Z'), classifier);
  assert.equal(summary.flagged, 2, '싸가지(LLM) + 광고 지겹다(하드넷)');
  assert.deepEqual([calls.cards.length, calls.rows.length, calls.hides], [0, 0, 0]);
});

test('알림행 형식: hold·재감사 행위자·작성자 정보', () => {
  const row = auditAlertRow({ slackChannelId: 'C1' }, { url: 'u', productName: 'JD', channelCategory: '소유 YouTube', channelName: 'n' },
    { id: 'c1', text: 't', authorChannelId: 'UCa', authorDisplayName: '@a', risk: { category: 'x', reason: 'r' } }, 'fp', '1.2', 'h', '2026-10-30T00:00:00Z');
  assert.equal(row.review_decision, 'hold');
  assert.equal(row.source, null);
  assert.equal(row.author_channel_id, 'UCa');
});

test('판정 실패(LLM null)면 LLM 판정분은 카드 없이 보류로 남기고, 결정적 하드넷 표현만 카드로 올린다', async () => {
  const { fetchImpl, calls, classifier } = world({ llm: 'fail' });
  const summary = await runPublicAudit(BASE, fetchImpl, Date.parse('2026-10-30T02:00:00Z'), classifier);
  assert.deepEqual(calls.rows.map((r) => r.comment_id), ['decided']);
  assert.equal(calls.hides, 0);
  assert.ok(summary.deferred > 0);
  assert.ok(summary.errors.length > 0);
});
