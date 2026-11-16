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

function world({ alerted = [], failChannel = '', titleInState = true, approved = [], alreadyClaimed = [], alreadyEnforced = [], enforcedAt = NOW - 5 * 60 * 1000, holdFails = false, holdCostCalls = 0, uploads = null } = {}) {
  const calls = { stateInserts: [], cards: [], rows: [], hides: 0, holds: [], threadReads: 0, videoLookups: 0, classified: [], claims: [], releases: 0, playlistReads: [] };
  const enforcedKeys = new Set(alreadyEnforced.map((id) => `hold-enforce:${id}`));
  const claimedKeys = new Set(alreadyClaimed);
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
    if (u.includes('youtube_owner_video_state') && init.method === 'POST') { calls.stateInserts.push({ prefer: init.headers.Prefer, rows: JSON.parse(init.body) }); return json(null); }
    if (u.includes('youtube_owner_video_state')) return json(titleInState ? [{ video_id: 'v1', video_title: '멜론 쫀득바' }, { video_id: 'v2', video_title: '멜론 쫀득바' }, { video_id: 'v3', video_title: '멜론 쫀득바' }] : []);
    if (u.includes('meta_tokens')) return json([{ kind: `youtube_owner:${CH}`, token: 'rt1' }, { kind: `youtube_owner:${CH2}`, token: 'rt2' }]);
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'at' });
    if (u.includes('/commentThreads')) {
      calls.threadReads += 1;
      const channelId = new URL(u).searchParams.get('allThreadsRelatedToChannelId');
      if (channelId === failChannel) return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, false, 403);
      return json({ items: threadsByChannel[channelId] || [] });
    }
    if (u.includes('/videos?')) { calls.videoLookups += 1; return json({ items: [{ id: 'v1', snippet: { title: '[26.10]새우깡제친_main_제과', channelId: CH, publishedAt: ago(2) } }, { id: 'v3', snippet: { title: '남의 영상', channelId: 'UCother' } }] }); }
    if (u.includes('/channels') && u.includes('mine=true')) throw new Error('fast scan must not verify owner channel (quota)');
    if (u.includes('/channels')) { calls.channelLookups = (calls.channelLookups || 0) + 1; return json({ items: [{ id: CH, snippet: { title: '먹짱언니_mukzzang unnie' } }, { id: CH2, snippet: { title: '먹는김에' } }] }); }
    if (u.includes('comment_classification_cache')) return json(init.method === 'POST' ? null : []);
    if (u.includes('cost_usage_ledger') && init.method === 'POST' && String(init.body).includes('hold-enforce:')) {
      const fresh = JSON.parse(init.body).filter((row) => !enforcedKeys.has(row.run_key));
      fresh.forEach((row) => enforcedKeys.add(row.run_key));
      return json(fresh);
    }
    if (u.includes('cost_usage_ledger') && init.method === 'POST' && /hold-(missing|stuck|config-missing):/.test(String(init.body))) {
      const { run_key: key } = JSON.parse(init.body);
      calls.claims.push(key);
      if (claimedKeys.has(key)) return json([]);
      claimedKeys.add(key);
      return json([{ run_key: key }]);
    }
    if (u.includes('/playlistItems')) { calls.playlistReads.push(new URL(u).searchParams.get('playlistId')); return json({ items: uploads || [] }); }
    if (uploads && u.includes('cost_usage_ledger') && init.method === 'POST' && /yt-ad-upload-(scan|notice):/.test(String(init.body))) {
      const { run_key: key } = JSON.parse(init.body);
      calls.claims.push(key);
      if (claimedKeys.has(key)) return json([]);
      claimedKeys.add(key);
      return json([{ run_key: key }]);
    }
    if (u.includes('cost_usage_ledger') && init.method === 'DELETE') { calls.releases += 1; return json(null); }
    if (u.includes('cost_usage_ledger') && decodeURIComponent(u).includes('held-review:')) {
      return json(approved.map((id) => ({ run_key: `held-review:${id}` })));
    }
    if (u.includes('cost_usage_ledger') && decodeURIComponent(u).includes('hold-enforce:')) {
      return json(alreadyEnforced.map((id) => ({ run_key: `hold-enforce:${id}`, created_at: new Date(enforcedAt).toISOString() })));
    }
    if (u.includes('cost_usage_ledger') && decodeURIComponent(u).includes('yt-hold:')) {
      return json(holdCostCalls ? [{ run_key: `yt-hold:2026-11-02:${CH2}:${holdCostCalls}:${NOW}:v3:${encodeURIComponent('먹는김에')}` }] : []);
    }
    if (u.includes('cost_usage_ledger')) return json([]);
    if (u.includes('negative_comment_alerts') && init.method === 'POST') { calls.rows.push(JSON.parse(init.body)); return json([{ id: 1 }]); }
    if (u.includes('negative_comment_alerts')) {
      const fps = decodeURIComponent(u).match(/in\.\((.*)\)/)?.[1].split(',').map((v) => v.replace(/"/g, '')) || [];
      return json(fps.filter((fp) => alertedFps.has(fp)).map((fingerprint) => ({ fingerprint })));
    }
    if (u.includes('alert_threads')) return json([{ slack_ts: '111.222' }]);
    if (u.includes('chat.postMessage')) { calls.cards.push(JSON.parse(init.body)); return json({ ok: true, ts: `333.${calls.cards.length}` }); }
    if (u.includes('reactions')) return json({ ok: true });
    if (u.includes('setModerationStatus')) {
      const params = new URL(u).searchParams;
      if (params.get('moderationStatus') === 'heldForReview' && holdFails) return json({ error: { errors: [{ reason: 'backendError' }] } }, false, 500);
      if (params.get('moderationStatus') === 'heldForReview' && calls.holdMode) { calls.holds.push(...params.get('id').split(',')); return json({}); }
      calls.hides += 1;
      return json({});
    }
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
    { name: '썰푸는앵무새', channelId: CH2, channelCategory: '소유 YouTube' },
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
  assert.equal(summary.quotaUnits, 3, '채널 2 + 채널명 일괄 1');
  assert.equal(calls.channelLookups, 1, '채널명은 회당 한 번에');
  // 카드·행의 채널명은 설정 이름(먹는김에 설정명=옛 이름)이 아니라 실제 채널 제목
  assert.equal(calls.rows.find((r) => r.comment_id === 'bad2').channel_name, '먹는김에');
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

test('프로젝트 공통 quota 오류는 첫 채널에서 중단해 나머지 채널을 헛호출하지 않는다', async () => {
  const { fetchImpl, calls, classifier } = world({ failChannel: CH });
  const summary = await runOwnerFastScan(BASE, fetchImpl, NOW, classifier);
  assert.equal(summary.channels, 0);
  assert.equal(calls.threadReads, 1);
  assert.deepEqual(calls.rows, []);
  assert.equal(summary.quotaExhausted, true);
  assert.ok(summary.errors.some((e) => e.includes(CH) && e.includes('quotaExceeded')));
});

test('내부 Gemini 안전예산만 찬 회차는 재처리 대기이지 빠른 감시 장애가 아니다', async () => {
  const base = world();
  const budgetClassifier = async (_items, _config, _unused, stats) => {
    Object.assign(stats, {
      failedAttempts: 1,
      transientFailures: 1,
      persistentFailures: 0,
      lastFailureCode: 'daily_budget',
    });
    return null;
  };
  const summary = await runOwnerFastScan(BASE, base.fetchImpl, NOW, budgetClassifier);
  assert.ok(summary.deferred > 0);
  assert.equal(summary.budgetDeferred, summary.deferred);
  assert.equal(summary.retryDeferred, summary.deferred);
  assert.equal(summary.deferredReason, 'daily_budget');
  assert.equal(summary.errors.some((e) => e.includes('판정 보류')), false);
  assert.deepEqual(base.calls.rows, [], '보류분은 정상·seen으로 기록하지 않아 다음 회차에 다시 판정');
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

test('상태표에 없는 새 영상은 실제 채널이 맞을 때만 최소 행으로 등록한다(pending-hide 추적 대상이 되게, 기존 행 불변)', async () => {
  const { fetchImpl, calls, classifier } = world({ titleInState: false });
  const summary = await runOwnerFastScan(BASE, fetchImpl, NOW, classifier);
  const inserted = calls.stateInserts.flatMap((i) => i.rows);
  // v1은 CH 영상으로 확인 → 등록. v3 조회 응답은 다른 채널 → 등록하지 않는다.
  assert.deepEqual(inserted.map((r) => [r.channel_id, r.video_id]), [[CH, 'v1']]);
  assert.equal(inserted[0].video_title, '[26.10]새우깡제친_main_제과');
  assert.ok(!('comment_count' in inserted[0]) && !('last_scanned_count' in inserted[0]), '카운트 비움 → 3시간 모니터가 전체 스캔');
  assert.ok(calls.stateInserts.every((i) => i.prefer.includes('ignore-duplicates')), '기존 추적 행 덮어쓰기 금지');
  assert.equal(summary.newVideosTracked, 1);
});

test('dry-run은 새 영상을 상태표에 등록하지 않는다', async () => {
  const { fetchImpl, calls, classifier } = world({ titleInState: false });
  await runOwnerFastScan({ ...BASE, dryRun: true }, fetchImpl, NOW, classifier);
  assert.equal(calls.stateInserts.length, 0);
});

test('recentCommentsByVideo: 최근·비본인 댓글만, 포함 답글도 같은 영상으로', () => {
  const threads = [thread('a', 'v1', 'x', ago(1), { replies: [{ id: 'a.r', text: 'y', publishedAt: ago(10) }, { id: 'a.s', text: 'z', publishedAt: ago(2) }] })];
  const byVideo = recentCommentsByVideo(threads, CH, NOW - 6 * 3600 * 1000);
  assert.deepEqual(byVideo.get('v1').map((c) => c.id), ['a', 'a.s']);
});

// '모두 보류' 누락 감시: 보류 채널(CH2=먹는김에)에서 봇 승인 없이 공개된 새 댓글 → 영상 경고(하루 1회).
const HOLD = {
  ...BASE,
  holdWatchChannels: [{ channelId: CH2, since: Date.parse('2026-10-30T13:14:45Z') }],
  holdWatchSince: NOW - 5 * 3600 * 1000,
};
const holdPosts = (calls) => calls.cards.filter((card) => /모두 보류|보류로 못 돌린/.test(String(card.text || '')));

test('보류 누락: 보류 채널에서 봇 승인 없이 공개된 새 댓글이 있으면 그 영상을 경고한다(최상위, 스튜디오 링크)', async () => {
  const { fetchImpl, calls, classifier } = world();
  const summary = await runOwnerFastScan(HOLD, fetchImpl, NOW, classifier);
  assert.equal(summary.holdLeakVideos, 1);
  assert.equal(summary.holdLeakAlerted, 1);
  const posts = holdPosts(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread_ts, undefined, '운영 경고는 최상위');
  assert.match(posts[0].text, /studio\.youtube\.com\/video\/v3\/edit/);
  assert.match(posts[0].text, /먹는김에/);
  assert.doesNotMatch(posts[0].text, /v1/, '보류 채널이 아닌 먹짱언니(CH) 영상은 대상 아님');
});

test('보류 누락: 봇이 공개한 댓글(held-review 원장)은 누락이 아니다', async () => {
  const { fetchImpl, calls, classifier } = world({ approved: ['bad2'] });
  const summary = await runOwnerFastScan(HOLD, fetchImpl, NOW, classifier);
  assert.equal(summary.holdLeakVideos, 0);
  assert.equal(holdPosts(calls).length, 0);
});

test('보류 누락: 감시 시작 전에 달린 댓글은 세지 않는다(설정 전 댓글로 오경보 방지)', async () => {
  const { fetchImpl, calls, classifier } = world();
  const summary = await runOwnerFastScan({ ...HOLD, holdWatchSince: NOW - 1 * 3600 * 1000 }, fetchImpl, NOW, classifier);
  assert.equal(summary.holdLeakVideos, 0, 'bad2는 3시간 전 댓글');
  assert.equal(holdPosts(calls).length, 0);
});

test('보류 누락: 같은 영상은 하루 한 번만 알린다', async () => {
  const { fetchImpl, calls, classifier } = world({ alreadyClaimed: ['hold-missing:2026-11-03:v3'] });
  const summary = await runOwnerFastScan(HOLD, fetchImpl, NOW, classifier);
  assert.equal(summary.holdLeakVideos, 1);
  assert.equal(summary.holdLeakAlerted, 0);
  assert.equal(holdPosts(calls).length, 0);
});

test('보류 누락: 시작 시각 변수가 없으면 감시하지 않는다(안전 기본값)', async () => {
  const { fetchImpl, calls, classifier } = world();
  const summary = await runOwnerFastScan({ ...HOLD, holdWatchSince: null }, fetchImpl, NOW, classifier);
  assert.equal(summary.holdLeakVideos, 0);
  assert.equal(calls.claims.length, 0);
});

test('보류 누락: Slack 실패면 선점을 풀어 다음 회차가 다시 알린다', async () => {
  const base = world();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('chat.postMessage') && String(init.body).includes('모두 보류')) {
      return { ok: true, status: 200, json: async () => ({ ok: false, error: 'ratelimited' }) };
    }
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan(HOLD, fetchImpl, NOW, base.classifier);
  assert.equal(summary.holdLeakAlerted, 0);
  assert.equal(base.calls.releases, 1);
  assert.ok(summary.errors.some((e) => e.includes('보류 누락 감시 실패')));
  assert.equal(base.calls.rows.length, 3, '보류 감시 실패가 부정 카드 경로를 막지 않는다(부정 3건 모두 카드)');
});

// 봇 보류 대행(11-03 재발방지): 보류 누락 영상의 새 공개 댓글을 봇이 보류로 돌린다(한 댓글 한 번).
test("보류 대행: 첫 자동 보류 성공 직후 영상 설정 누락을 즉시 한 번 알린다", async () => {
  const { fetchImpl, calls, classifier } = world();
  calls.holdMode = true;
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, classifier);
  assert.deepEqual(calls.holds, ["bad2"]);
  assert.equal(summary.holdEnforced, 1);
  assert.equal(summary.holdConfigAlerted, 1);
  assert.equal(summary.holdLeakSilenced, 1);
  assert.equal(summary.holdLeakAlerted, 0);
  assert.equal(holdPosts(calls).length, 1);
  assert.deepEqual(calls.claims, ['hold-config-missing:v3']);
  assert.match(holdPosts(calls)[0].text, /스튜디오에서 영상별로/);
});

test("보류 대행: 같은 영상 설정 누락은 다음 날에도 즉시 알림을 반복하지 않는다", async () => {
  const { fetchImpl, calls, classifier } = world({ alreadyClaimed: ['hold-config-missing:v3'] });
  calls.holdMode = true;
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, classifier);
  assert.deepEqual(calls.holds, ['bad2']);
  assert.equal(summary.holdConfigAlerted, 0);
  assert.equal(holdPosts(calls).length, 0);
});

test("보류 대행: 보류한 지 1시간이 지났는데도 공개면(보류 안 먹음) 그때만 알린다", async () => {
  const { fetchImpl, calls, classifier } = world({
    alreadyEnforced: ["bad2"], enforcedAt: NOW - 2 * 3600 * 1000,
    alreadyClaimed: ['hold-config-missing:v3'],
  });
  calls.holdMode = true;
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, classifier);
  assert.deepEqual(calls.holds, [], '같은 댓글을 다시 보류하지 않는다(quota)');
  assert.equal(summary.holdLeakAlerted, 1);
  assert.deepEqual(calls.claims, ['hold-config-missing:v3', 'hold-stuck:2026-11-03:v3'], '설정 누락 영구 키 확인 뒤 보류 실패는 날짜별 별도 키');
  assert.match(holdPosts(calls)[0].text, /봇이 보류로 못 돌린/);
  assert.match(holdPosts(calls)[0].text, /보류 후 다시 공개/);
});

test("보류 대행: 봇 보류 API가 실패하면 알린다", async () => {
  const { fetchImpl, calls, classifier } = world({ holdFails: true });
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, classifier);
  assert.equal(summary.holdLeakAlerted, 1);
  assert.equal(summary.holdConfigAlerted, 1);
  assert.ok(holdPosts(calls).some((post) => /봇 보류 실패/.test(post.text)));
  assert.ok(holdPosts(calls).some((post) => /공개로 남아 있을 수 있습니다/.test(post.text)));
  assert.ok(summary.errors.some((e) => e.includes('보류 대행 실패')));
});

test("보류 대행: 이미 한 번 보류를 시도한 댓글은 다시 하지 않고, 반영 지연(1시간 안)은 알리지 않는다", async () => {
  const { fetchImpl, calls, classifier } = world({ alreadyEnforced: ["bad2"], alreadyClaimed: ['hold-config-missing:v3'] });
  calls.holdMode = true;
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, classifier);
  assert.deepEqual(calls.holds, []);
  assert.equal(summary.holdEnforced, 0);
  assert.equal(holdPosts(calls).length, 0);
});

test("보류 대행: 설정이 꺼져 있으면 경고만 하고 보류하지 않는다", async () => {
  const { fetchImpl, calls, classifier } = world();
  calls.holdMode = true;
  const summary = await runOwnerFastScan(HOLD, fetchImpl, NOW, classifier);
  assert.deepEqual(calls.holds, []);
  assert.equal(summary.holdLeakAlerted, 1);
});

test("보류 대행은 채널 단위로 한 요청에 묶는다(영상별 호출 금지 — quota)", async () => {
  const base = world();
  base.calls.holdMode = true;
  let holdRequests = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/commentThreads') && u.searchParams.get('allThreadsRelatedToChannelId') === CH2) {
      return { ok: true, status: 200, json: async () => ({ items: [
        thread('a1', 'v3', '맛있겠다', ago(1)), thread('a2', 'v4', '좋아요', ago(1)), thread('a3', 'v5', '최고', ago(2)),
      ] }) };
    }
    if (u.pathname.endsWith('/setModerationStatus') && u.searchParams.get('moderationStatus') === 'heldForReview') holdRequests += 1;
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, base.classifier);
  assert.equal(summary.holdLeakVideos, 3);
  assert.equal(holdRequests, 1, '영상 3개라도 채널 한 번');
  assert.deepEqual(base.calls.holds.sort(), ['a1', 'a2', 'a3']);
  assert.equal(summary.holdEnforced, 3);
});

test("quota 브레이크: 보류 대행은 멈춰도 설정 누락은 즉시 알리고 부정 판정·숨김은 유지한다", async () => {
  const base = world({ alreadyEnforced: ["bad2"], enforcedAt: NOW - 2 * 3600 * 1000 });
  base.calls.holdMode = true;
  const fetchImpl = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('cost_usage_ledger') && u.includes('yt-units:')) return { ok: true, status: 200, json: async () => [{ run_key: 'yt-units:2026-11-02:x:1.1.1.1:7000' }] };
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, base.classifier);
  assert.deepEqual(base.calls.holds, []);
  assert.equal(summary.holdEnforced, 0);
  assert.match(summary.holdEnforceBraked, /70%/);
  assert.equal(summary.holdConfigAlerted, 1, '브레이크 중에도 설정 누락은 즉시 알림');
  assert.equal(holdPosts(base.calls).length, 1, '보류 실패가 아니라 설정 누락 알림만 보냄');
  assert.match(holdPosts(base.calls)[0].text, /공개로 남아 있을 수 있습니다/);
  assert.ok(base.calls.rows.length > 0, '부정 댓글 카드·알림행(→자동숨김)은 그대로');
});

test("보류 대행 전용 일일 상한: 1,000 unit를 쓰면 추가 보류를 멈추고 부정 판정은 유지한다", async () => {
  const base = world({ holdCostCalls: 20 });
  base.calls.holdMode = true;
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true, holdEnforceDailyUnitCap: 1_000 }, base.fetchImpl, NOW, base.classifier);
  assert.deepEqual(base.calls.holds, []);
  assert.equal(summary.holdEnforced, 0);
  assert.equal(summary.holdEnforceDailyUnits, 1_000);
  assert.equal(summary.holdEnforceBraked, 'hold-daily-cap(1000/1000)');
  assert.equal(summary.holdConfigAlerted, 1);
  assert.equal(holdPosts(base.calls).length, 1, '상한 중단이어도 설정 누락은 즉시 알림');
  assert.ok(base.calls.rows.length > 0, '부정 댓글 판정·카드 경로는 그대로');
});

test("보류 대행 사용량 원장을 읽지 못하면 0으로 간주하지 않고 fail-closed로 멈춘다", async () => {
  const base = world();
  base.calls.holdMode = true;
  const fetchImpl = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('cost_usage_ledger') && u.includes('yt-hold:') && (init.method || 'GET') === 'GET') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, base.classifier);
  assert.deepEqual(base.calls.holds, []);
  assert.equal(summary.holdEnforceBraked, 'hold-ledger-unavailable');
  assert.ok(summary.errors.some((e) => e.includes('보류 대행 사용량 조회 실패')));
  assert.equal(summary.holdConfigAlerted, 1);
  assert.equal(holdPosts(base.calls).length, 1, '원장 장애 중에도 설정 누락은 즉시 알림');
  assert.ok(base.calls.rows.length > 0, '부정 댓글 판정·카드 경로는 그대로');
});

test("보류 대행 전용 상한: 앞쪽 기존 처리건을 빼고 뒤의 신규 댓글에 남은 1회 예산을 쓴다", async () => {
  const base = world({ alreadyEnforced: ['old-hold'], holdCostCalls: 19 });
  base.calls.holdMode = true;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/commentThreads') && u.searchParams.get('allThreadsRelatedToChannelId') === CH2) {
      return { ok: true, status: 200, json: async () => ({ items: [
        thread('old-hold', 'v3', '전에 보류됨', ago(1)),
        thread('fresh-hold', 'v4', '새 댓글', ago(1)),
      ] }) };
    }
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan(
    { ...HOLD, holdEnforce: true, holdEnforceDailyUnitCap: 1_000 },
    fetchImpl,
    NOW,
    base.classifier,
  );
  assert.deepEqual(base.calls.holds, ['fresh-hold']);
  assert.equal(summary.holdEnforced, 1);
  assert.equal(summary.holdEnforceDailyUnits, 1_000);
});

test("절약 모드: 보류 대행은 일시정지해도 설정 누락은 즉시 알린다", async () => {
  const base = world({ alreadyEnforced: ["bad2"], enforcedAt: NOW - 2 * 3600 * 1000 });
  base.calls.holdMode = true;
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true, holdEnforcePaused: 'quota-plan' }, base.fetchImpl, NOW, base.classifier);
  assert.deepEqual(base.calls.holds, [], '보류 요청(50 unit) 없음');
  assert.equal(summary.holdEnforceBraked, 'quota-plan');
  assert.equal(summary.holdConfigAlerted, 1);
  assert.equal(holdPosts(base.calls).length, 1, '절약 모드여도 설정 누락은 즉시 알림');
  assert.ok(base.calls.rows.length > 0, '부정 댓글 카드·알림행(→자동숨김)은 그대로');
});

// 11-09 재발방지: 보류 대행 비용을 채널·영상 단위로 원장에 남겨 할당량 경고가 원인 채널을 짚게 한다.
test("보류 대행 비용 기록: 채널당 요청 수·영상ID·채널명을 yt-hold 원장에 남긴다", async () => {
  const base = world();
  base.calls.holdMode = true;
  const holdCostKeys = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/commentThreads') && u.searchParams.get('allThreadsRelatedToChannelId') === CH2) {
      return { ok: true, status: 200, json: async () => ({ items: [
        thread('a1', 'v3', '맛있겠다', ago(1)), thread('a2', 'v4', '좋아요', ago(1)),
      ] }) };
    }
    if (init.method === 'POST' && String(init.body || '').includes('"yt-hold:')) {
      holdCostKeys.push(JSON.parse(init.body).run_key);
      return { ok: true, status: 201, json: async () => [] };
    }
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, base.classifier);
  assert.equal(summary.holdEnforced, 2);
  assert.equal(holdCostKeys.length, 1, '채널 한 번 보류 = 기록 한 줄');
  const { parseHoldCostKey } = await import('../src/youtube-quota-meter.js');
  const parsed = parseHoldCostKey(holdCostKeys[0]);
  assert.equal(parsed.channelId, CH2);
  assert.equal(parsed.calls, 1);
  assert.deepEqual(parsed.videoIds.sort(), ['v3', 'v4']);
  assert.ok(parsed.channelName, '채널명이 남는다');
});

test("보류 대행 비용 예약이 실패하면 API 호출을 막고 선점을 풀어 다음 회차에 재시도한다", async () => {
  const base = world();
  base.calls.holdMode = true;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST' && String(init.body || '').includes('"yt-hold:')) throw new Error('db down');
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true }, fetchImpl, NOW, base.classifier);
  assert.deepEqual(base.calls.holds, []);
  assert.equal(summary.holdEnforced, 0);
  assert.ok(summary.errors.some((e) => e.includes('보류 대행 사용량 기록 실패')));
  assert.equal(base.calls.releases, 1, 'hold-enforce 선점을 풀어 DB 복구 뒤 재시도');
  assert.ok(base.calls.rows.length > 0, '부정 댓글 판정·카드 경로는 그대로');
});

// 11-16 재발방지: 사람이 고칠 '모두 보류' 요청은 상품 스레드에 그 상품 담당자를 태그한다.
const ROUTED = { jd: { primary: 'UJD' }, jg: { primary: 'UJG', additional: ['UJG2'] }, other: 'UOPS' };

test('설정 누락 즉시 알림은 최상위가 아니라 상품 스레드에 상품 담당자를 태그한다(운영 담당 아님)', async () => {
  const { fetchImpl, calls, classifier } = world();
  calls.holdMode = true;
  const summary = await runOwnerFastScan({ ...HOLD, holdEnforce: true, slackAssignees: ROUTED }, fetchImpl, NOW, classifier);
  assert.equal(summary.holdConfigAlerted, 1);
  const [post] = holdPosts(calls);
  assert.equal(post.thread_ts, '111.222');
  assert.match(post.text, /<@UJD>/, 'v3=쫀득바 → 쫀득바 담당');
  assert.doesNotMatch(post.text, /UOPS/);
});

const adItem = (videoId, title, hoursAgo, privacyStatus = 'unlisted') => ({
  snippet: { title, publishedAt: ago(hoursAgo), resourceId: { videoId } },
  contentDetails: { videoId, videoPublishedAt: ago(hoursAgo) },
  status: { privacyStatus },
});
const UPLOADS = [
  adItem('ad1', '[26.11]F_V_BT틱_인지_var1__이선민_261116_제과_김하영', 1),
  adItem('ad2', '[26.11]F_V_BT틱_인지_var2__이선민_261116_제과_김하영', 1),
  adItem('old', '[26.11]F_V_BT틱_인지_main__이선민_261113_제과_모현진', 10),
  adItem('pub', '오늘의 먹방 브이로그', 1, 'public'),
];
const AD = { ...HOLD, adUploadNotice: true, adUploadNoticeSince: NOW - 5 * 3600 * 1000, slackAssignees: ROUTED };

test('새 광고 영상: 보류 채널 업로드 목록에서 찾아 댓글 전에 상품 스레드로 담당자에게 한 번 요청한다', async () => {
  const { fetchImpl, calls, classifier } = world({ uploads: UPLOADS });
  const summary = await runOwnerFastScan(AD, fetchImpl, NOW, classifier);
  assert.deepEqual(calls.playlistReads, [`UU${CH2.slice(2)}`], '보류 채널(CH2)만, 1 unit');
  assert.equal(summary.adUploadChannelsScanned, 1);
  assert.equal(summary.adUploadsRecent, 3, '48시간 안 광고 3개(공개 일반 영상 제외)');
  assert.equal(summary.adUploadNoticed, 2, '배포 기준 시각 이전(old)은 알리지 않는다');
  const post = calls.cards.find((c) => /새 광고 영상/.test(c.text || ''));
  assert.equal(post.thread_ts, '111.222');
  assert.match(post.text, /새 광고 영상 2개/);
  assert.match(post.text, /studio\.youtube\.com\/video\/ad1\/edit/);
  assert.doesNotMatch(post.text, /video\/old\/|video\/pub\//);
  assert.match(post.text, /<@UJG> <@UJG2>/, '제과 → 제과 주담당+추가 담당');
  assert.ok(calls.claims.includes('yt-ad-upload-notice:ad1'));
});

test('새 광고 영상: 같은 시간대에는 목록을 다시 읽지 않고, 이미 알린 영상은 반복하지 않는다', async () => {
  const hourKey = 'yt-ad-upload-scan:2026-11-03T12';
  const sameHour = world({ uploads: UPLOADS, alreadyClaimed: [hourKey] });
  await runOwnerFastScan(AD, sameHour.fetchImpl, NOW, sameHour.classifier);
  assert.equal(sameHour.calls.playlistReads.length, 0);
  const notified = world({ uploads: UPLOADS, alreadyClaimed: ['yt-ad-upload-notice:ad1', 'yt-ad-upload-notice:ad2'] });
  const summary = await runOwnerFastScan(AD, notified.fetchImpl, NOW, notified.classifier);
  assert.equal(summary.adUploadNoticed, 0);
  assert.equal(notified.calls.cards.filter((c) => /새 광고 영상/.test(c.text || '')).length, 0);
});

test('새 광고 영상: Slack 실패면 그 영상 선점만 풀어 다음 시간에 다시 알리고, 부정 카드 경로는 유지한다', async () => {
  const base = world({ uploads: UPLOADS });
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('chat.postMessage') && String(init.body).includes('새 광고 영상')) {
      return { ok: true, status: 200, json: async () => ({ ok: false, error: 'ratelimited' }) };
    }
    return base.fetchImpl(url, init);
  };
  const summary = await runOwnerFastScan(AD, fetchImpl, NOW, base.classifier);
  assert.equal(summary.adUploadNoticed, 0);
  assert.equal(base.calls.releases, 2, 'ad1·ad2 선점 해제');
  assert.ok(summary.errors.some((e) => e.includes('광고 업로드 알림 실패')));
  assert.equal(base.calls.rows.length, 3);
});

test('새 광고 영상: dry-run·끄기 설정이면 목록을 읽지 않는다', async () => {
  for (const cfg of [{ ...AD, dryRun: true }, { ...AD, adUploadNotice: false }]) {
    const { fetchImpl, calls, classifier } = world({ uploads: UPLOADS });
    await runOwnerFastScan(cfg, fetchImpl, NOW, classifier);
    assert.equal(calls.playlistReads.length, 0);
  }
});
