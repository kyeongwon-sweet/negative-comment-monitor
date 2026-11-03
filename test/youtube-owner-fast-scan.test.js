import test from 'node:test';
import assert from 'node:assert/strict';
import { runOwnerFastScan, recentCommentsByVideo } from '../src/youtube-owner-fast-scan.js';
import { commentFingerprint } from '../src/dedup.js';

const CH = 'UCxfjcCvRPOPzo6PeAttO4Dg';
const CH2 = 'UCQKpvEBNiMBrGzI2f2tAFeA';
const NOW = Date.parse('2026-11-03T03:00:00Z');
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();

function thread(id, videoId, text, publishedAt, { author = 'UCx', replies = [] } = {}) {
  return {
    snippet: {
      videoId, totalReplyCount: replies.length,
      topLevelComment: { id, snippet: { textOriginal: text, publishedAt, authorChannelId: { value: author }, authorDisplayName: '@a' } },
    },
    replies: { comments: replies.map((r) => ({ id: r.id, snippet: { textOriginal: r.text, publishedAt: r.publishedAt, authorChannelId: { value: 'UCr' } } })) },
  };
}

function world({ alerted = [], failChannel = '', titleInState = true } = {}) {
  const calls = { cards: [], rows: [], hides: 0, threadReads: 0, videoLookups: 0, classified: [] };
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
  const threadsByChannel = {
    [CH]: [
      thread('bad1', 'v1', '싸가지가 읍네', ago(1), { replies: [{ id: 'bad1.r', text: '맛있겠다', publishedAt: ago(0.5) }] }),
      thread('old', 'v1', '싸가지 옛날 댓글', ago(30)),
      thread('own', 'v1', '고정 댓글', ago(1), { author: CH }),
      thread('seen', 'v2', '싸가지 이미 알림', ago(2)),
    ],
    [CH2]: [thread('bad2', 'v3', '싸가지 없다', ago(3))],
  };
  const alertedFps = new Set(alerted.map(([vid, id]) => commentFingerprint(
    { platform: 'youtube', postKey: `yt:${vid}`, url: `https://www.youtube.com/watch?v=${vid}` }, { id, platform: 'youtube' },
  )));
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('youtube_owner_video_state')) return json(titleInState ? [{ video_id: 'v1', video_title: '멜론 쫀득바' }, { video_id: 'v2', video_title: '멜론 쫀득바' }, { video_id: 'v3', video_title: '멜론 쫀득바' }] : []);
    if (u.includes('meta_tokens')) return json([{ kind: `youtube_owner:${CH}`, token: 'rt1' }, { kind: `youtube_owner:${CH2}`, token: 'rt2' }]);
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'at' });
    if (u.includes('/commentThreads')) {
      calls.threadReads += 1;
      const channelId = new URL(u).searchParams.get('allThreadsRelatedToChannelId');
      if (channelId === failChannel) return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, false, 403);
      return json({ items: threadsByChannel[channelId] || [] });
    }
    if (u.includes('/videos?')) { calls.videoLookups += 1; return json({ items: [{ id: 'v1', snippet: { title: '[26.10]새우깡제친_main_제과' } }] }); }
    if (u.includes('/channels')) throw new Error('fast scan must not verify owner channel (quota)');
    if (u.includes('comment_classification_cache')) return json(init.method === 'POST' ? null : []);
    if (u.includes('cost_usage_ledger')) return json([]);
    if (u.includes('negative_comment_alerts') && init.method === 'POST') { calls.rows.push(JSON.parse(init.body)); return json([{ id: 1 }]); }
    if (u.includes('negative_comment_alerts')) {
      const fps = decodeURIComponent(u).match(/in\.\((.*)\)/)?.[1].split(',').map((v) => v.replace(/"/g, '')) || [];
      return json(fps.filter((fp) => alertedFps.has(fp)).map((fingerprint) => ({ fingerprint })));
    }
    if (u.includes('alert_threads')) return json([{ slack_ts: '111.222' }]);
    if (u.includes('chat.postMessage')) { calls.cards.push(JSON.parse(init.body)); return json({ ok: true, ts: `333.${calls.cards.length}` }); }
    if (u.includes('reactions')) return json({ ok: true });
    if (u.includes('setModerationStatus')) { calls.hides += 1; return json({}); }
    throw new Error(`unexpected ${u}`);
  };
  const classifier = async (items) => {
    calls.classified.push(...items.map((item) => item.text));
    return items.map((item) => (item.text.includes('싸가지')
      ? { alert: true, category: '브랜드 적대/조롱', reason: '출연자 비하', priority: 'high' }
      : { alert: false, category: '정상', reason: '', priority: 'normal' }));
  };
  return { fetchImpl, calls, classifier };
}

const BASE = {
  youtubeOwnerChannels: [
    { name: '먹짱언니', channelId: CH, channelCategory: '소유 YouTube' },
    { name: '먹는김에', channelId: CH2, channelCategory: '소유 YouTube' },
  ],
  googleAdsClientId: 'c', googleAdsClientSecret: 's', youtubeApiBase: 'https://yt.test/youtube/v3',
  supabaseUrl: 'https://db.test', supabaseKey: 'svc', slackBotToken: 'xb', slackChannelId: 'C1', slackAssignees: {},
  managedChannelCategories: ['소유 youtube', '위성채널'], youtubeOwnerDefaultProductName: 'JD',
  fastScanLookbackHours: 6, fastScanMaxAlerts: 40, youtubeOwnerAlertDelayMs: 0,
  geminiKey: 'k', ownedBrandEscalationModel: 'gemini-3.5-flash-lite', slackPostMinIntervalMs: 0, dryRun: false,
};

test('빠른 감시: 채널당 1페이지(1 unit)만 읽고, 최근 6시간 새 댓글만 판정해 카드+일반 알림행(자동숨김 대상)으로 남긴다', async () => {
  const { fetchImpl, calls, classifier } = world({ alerted: [['v2', 'seen']] });
  const summary = await runOwnerFastScan(BASE, fetchImpl, NOW, classifier);
  assert.equal(calls.threadReads, 2, '채널당 commentThreads 1회');
  assert.equal(summary.quotaUnits, 2);
  assert.equal(summary.channels, 2);
  // 30시간 전 댓글·채널 본인 댓글·이미 알림행 있는 댓글은 판정하지 않는다
  // (약한 모델+강한 모델이 같은 목 분류기를 쓰므로 중복 제거 후 비교)
  assert.deepEqual([...new Set(calls.classified)].sort(), ['맛있겠다', '싸가지 없다', '싸가지가 읍네'].sort());
  assert.equal(summary.alreadyAlerted, 1);
  assert.deepEqual(calls.rows.map((r) => r.comment_id).sort(), ['bad1', 'bad2']);
  for (const row of calls.rows) {
    assert.equal(row.review_decision, undefined, '결정 없음 → 같은 루프 pending-hide가 숨김(재감사의 hold와 다름)');
    assert.equal(row.channel_category, '소유 YouTube');
  }
  assert.equal(calls.cards.length, 2);
  assert.ok(calls.cards.every((card) => card.thread_ts === '111.222'), '최상위 단독 카드 금지');
  assert.equal(calls.hides, 0, '숨김은 이 잡이 아니라 pending-hide가 한다');
  assert.deepEqual(summary.errors, []);
});

test('한 채널 quota 오류는 다른 채널을 막지 않고 errors에 남긴다', async () => {
  const { fetchImpl, calls, classifier } = world({ failChannel: CH });
  const summary = await runOwnerFastScan(BASE, fetchImpl, NOW, classifier);
  assert.equal(summary.channels, 1);
  assert.deepEqual(calls.rows.map((r) => r.comment_id), ['bad2']);
  assert.ok(summary.errors.some((e) => e.includes(CH) && e.includes('quotaExceeded')));
});

test('dry-run은 카드·행을 만들지 않는다', async () => {
  const { fetchImpl, calls, classifier } = world();
  const summary = await runOwnerFastScan({ ...BASE, dryRun: true }, fetchImpl, NOW, classifier);
  assert.equal(summary.flagged, 3);
  assert.deepEqual([calls.cards.length, calls.rows.length], [0, 0]);
});

test('회차 카드 상한을 넘으면 나머지는 다음 회차로 미룬다(알림행이 없어 다시 후보)', async () => {
  const { fetchImpl, calls, classifier } = world();
  const summary = await runOwnerFastScan({ ...BASE, fastScanMaxAlerts: 1 }, fetchImpl, NOW, classifier);
  assert.equal(calls.rows.length, 1);
  assert.equal(summary.capped, 2, '부정 3건 중 1건만 이번 회차');
});

test('상태표에 제목이 없는 새 영상은 videos.list로 제목을 채워 상품을 맞게 라우팅한다', async () => {
  const { fetchImpl, calls, classifier } = world({ titleInState: false });
  await runOwnerFastScan(BASE, fetchImpl, NOW, classifier);
  assert.ok(calls.videoLookups >= 1);
  assert.equal(calls.rows.find((r) => r.comment_id === 'bad1').product_name, '제과');
});

test('recentCommentsByVideo: 최근·비본인 댓글만, 포함 답글도 같은 영상으로', () => {
  const threads = [thread('a', 'v1', 'x', ago(1), { replies: [{ id: 'a.r', text: 'y', publishedAt: ago(10) }, { id: 'a.s', text: 'z', publishedAt: ago(2) }] })];
  const byVideo = recentCommentsByVideo(threads, CH, NOW - 6 * 3600 * 1000);
  assert.deepEqual(byVideo.get('v1').map((c) => c.id), ['a', 'a.s']);
});
