import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectYouTubeOwnerChannels,
  inferOwnerVideoProduct,
  loadOwnerVideoRiskSignals,
  loadYouTubeOwnerChannelConfig,
  ownerCommentEvidence,
  prioritizeOwnerVideoPlans,
  shouldScanOwnerVideo,
  YOUTUBE_BRAND_HOSTILITY_CHANNEL_IDS,
} from '../src/youtube-owner-channel.js';

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

test('owner channel config includes the two existing owners and eight satellites', () => {
  const config = loadYouTubeOwnerChannelConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'db',
    SLACK_BOT_TOKEN: 'slack', GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    SLACK_ASSIGNEE_SATELLITE: 'U_SAT', SLACK_ASSIGNEE_JD_SATELLITE: 'U_JD_SAT',
  });
  assert.equal(config.youtubeOwnerChannels.length, 10);
  assert.equal(config.youtubeOwnerChannels.find((row) => row.channelId === 'UCxfjcCvRPOPzo6PeAttO4Dg').name, '먹짱언니');
  assert.equal(config.youtubeOwnerChannels.find((row) => row.channelId === 'UCxfjcCvRPOPzo6PeAttO4Dg').lookbackDays, 60);
  assert.equal(config.youtubeOwnerChannels.find((row) => row.name === '썰박스').channelCategory, '위성채널');
  assert.equal(config.youtubeOwnerChannels.find((row) => row.name === '썰박스').lookbackDays, 14);
  assert.equal(config.slackAssignees.jd.satellite, 'U_JD_SAT');
  assert.equal(config.youtubeOwnerAlertDelayMs, 1100);
  assert.deepEqual(config.managedChannelCategories, ['위성채널', '소유 YouTube']);
  assert.equal(YOUTUBE_BRAND_HOSTILITY_CHANNEL_IDS.has('UCxfjcCvRPOPzo6PeAttO4Dg'), true);
  assert.equal(YOUTUBE_BRAND_HOSTILITY_CHANNEL_IDS.has('UCQKpvEBNiMBrGzI2f2tAFeA'), true);
  assert.equal(config.youtubeOwnerOverloadNegativeCount, 20);
  assert.equal(config.youtubeOwnerOverloadRatioPercent, 40);
  assert.equal(config.youtubeOwnerRecentNegativeDays, 7);
  assert.equal(config.youtubeOwnerRecentNegativeRescanHours, 3);
  assert.equal(config.youtubeOwnerHistoricalNegativeThreshold, 5);
  assert.equal(config.youtubeOwnerHistoricalNegativeRescanHours, 24);
  assert.equal(config.youtubeOwnerQuickMaxThreadPages, 4);
  assert.equal(config.youtubeOwnerSpikeCommentDelta, 25);
  assert.equal(config.youtubeOwnerCoverageAlertCooldownHours, 168);
});

test('comment-count gate baselines zero and scans first-positive or changed videos only', () => {
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '0' } }, null), { due: false, reason: 'zero-baseline', current: 0 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '2' } }, null), { due: true, reason: 'first-scan', current: 2 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '2' } }, { last_scanned_count: 2 }), { due: false, reason: 'unchanged', current: 2 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '3' } }, { last_scanned_count: 2 }), { due: true, reason: 'changed', current: 3 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '0' } }, { last_scanned_count: null }), { due: true, reason: 'changed', current: 0 });
  assert.equal(shouldScanOwnerVideo({ statistics: {} }, null).reason, 'no-signal');
  assert.deepEqual(shouldScanOwnerVideo(
    { statistics: { commentCount: '27' } },
    { last_scanned_count: 26, last_scanned_at: '2026-06-01T00:00:00Z' },
    { highCommentThreshold: 200 },
  ), { due: true, reason: 'changed', current: 27 });
});

test('고댓글 영상은 댓글수 불변이어도 일일 심층검사하고 강제검사는 캐시를 우회한다', () => {
  const now = Date.parse('2026-08-24T00:00:00Z');
  const video = { id: 'viral', statistics: { commentCount: '495' } };
  const stale = { last_scanned_count: 495, last_scanned_at: '2026-08-22T00:00:00Z' };
  assert.deepEqual(shouldScanOwnerVideo(video, stale, {
    now, highCommentThreshold: 200, highCommentRescanHours: 24,
  }), { due: true, reason: 'high-comment-cadence', current: 495, highComment: true, deepScan: true });
  assert.equal(shouldScanOwnerVideo(video, { ...stale, last_scanned_at: '2026-08-23T23:00:00Z' }, {
    now, highCommentThreshold: 200, highCommentRescanHours: 24,
  }).due, false);
  assert.deepEqual(shouldScanOwnerVideo(video, stale, {
    now, forceVideoIds: new Set(['viral']), forceReclassify: true,
  }), { due: true, reason: 'forced-deep-scan', current: 495, deepScan: true, forceReclassify: true });
  assert.deepEqual(shouldScanOwnerVideo({ ...video, statistics: { commentCount: '496' } }, {
    last_scanned_count: 495, last_scanned_at: '2026-08-23T23:00:00Z',
  }, { now, highCommentThreshold: 200, highCommentRescanHours: 24 }), {
    due: true, reason: 'changed', current: 496, highComment: true,
  });
});

test('댓글 급증 영상은 24시간 딥 cadence 전이어도 즉시 딥스캔한다', () => {
  const now = Date.parse('2026-09-05T00:00:00Z');
  const recent = { last_scanned_count: 495, last_scanned_at: '2026-09-04T23:00:00Z' };
  assert.deepEqual(shouldScanOwnerVideo({ id: 'viral', statistics: { commentCount: '525' } }, recent, {
    now,
    highCommentThreshold: 200,
    highCommentRescanHours: 24,
    spikeCommentDelta: 25,
  }), {
    due: true,
    reason: 'comment-spike',
    current: 525,
    highComment: true,
    spike: true,
    increase: 30,
    deepScan: true,
  });
  assert.equal(shouldScanOwnerVideo({ id: 'viral', statistics: { commentCount: '510' } }, recent, {
    now,
    highCommentThreshold: 200,
    highCommentRescanHours: 24,
    spikeCommentDelta: 25,
  }).deepScan, undefined);
});

test('급증·강제·고댓글 딥 후보를 일반 변화보다 먼저 처리한다', () => {
  const plans = prioritizeOwnerVideoPlans([
    { video: { id: 'changed' }, decision: { due: true, reason: 'changed', current: 400 } },
    { video: { id: 'risk' }, decision: { due: true, reason: 'recent-negative-cadence', current: 20, riskScan: true } },
    { video: { id: 'deep' }, decision: { due: true, reason: 'high-comment-cadence', current: 500, deepScan: true } },
    { video: { id: 'spike' }, decision: { due: true, reason: 'comment-spike', current: 250, deepScan: true, spike: true } },
    { video: { id: 'forced' }, decision: { due: true, reason: 'forced-deep-scan', current: 10, deepScan: true } },
  ]);
  assert.deepEqual(plans.map((plan) => plan.video.id), ['forced', 'spike', 'deep', 'risk', 'changed']);
});

test('YouTube 통계보다 실측 페이지네이션 수가 크면 실측값으로 고댓글을 보정한다', () => {
  assert.equal(ownerCommentEvidence(150, {
    reportedThreadCount: 260,
    threadCount: 200,
    comments: Array.from({ length: 210 }),
  }), 260);
});

test('악플 이력이 있는 소유 영상은 공개 댓글수 불변이어도 위험도별 주기로 재스캔한다', () => {
  const now = Date.parse('2026-08-26T03:00:00Z');
  const video = { id: 'owned-risk', statistics: { commentCount: '13' } };
  const recentRisk = new Map([['owned-risk', { alertCount: 2, lastAlertAt: '2026-08-25T03:00:00Z' }]]);
  assert.deepEqual(shouldScanOwnerVideo(video, {
    last_scanned_count: 13, last_scanned_at: '2026-08-25T23:00:00Z',
  }, {
    now, riskSignals: recentRisk, recentNegativeDays: 7, recentNegativeRescanHours: 3,
  }), {
    due: true, reason: 'recent-negative-cadence', current: 13, riskScan: true,
  });
  assert.equal(shouldScanOwnerVideo(video, {
    last_scanned_count: 13, last_scanned_at: '2026-08-26T02:00:00Z',
  }, {
    now, riskSignals: recentRisk, recentNegativeDays: 7, recentNegativeRescanHours: 3,
  }).due, false);

  const historicalRisk = new Map([['owned-risk', { alertCount: 5, lastAlertAt: '2026-08-01T03:00:00Z' }]]);
  assert.deepEqual(shouldScanOwnerVideo(video, {
    last_scanned_count: 13, last_scanned_at: '2026-08-24T03:00:00Z',
  }, {
    now,
    riskSignals: historicalRisk,
    recentNegativeDays: 7,
    historicalNegativeThreshold: 5,
    historicalNegativeRescanHours: 24,
  }), {
    due: true, reason: 'historical-negative-cadence', current: 13, riskScan: true,
  });
});

test('소유 영상 위험 신호는 YouTube 알림만 집계하고 사람 유지 결정은 제외한다', async () => {
  const now = Date.parse('2026-08-26T03:00:00Z');
  const seen = [];
  const signals = await loadOwnerVideoRiskSignals({
    supabaseUrl: 'https://db.test', supabaseKey: 'db', youtubeOwnerRiskLookbackDays: 60,
  }, async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    return json([
      { post_url: 'https://youtube.com/watch?v=owned1', alerted_at: '2026-08-24T00:00:00Z', review_decision: 'hidden' },
      { post_url: 'https://youtube.com/shorts/owned1', alerted_at: '2026-08-25T00:00:00Z', review_decision: null },
      { post_url: 'https://youtube.com/watch?v=owned1', alerted_at: '2026-08-26T00:00:00Z', review_decision: 'false_positive' },
      { post_url: 'https://instagram.com/p/not-youtube', alerted_at: '2026-08-26T00:00:00Z', review_decision: null },
    ]);
  }, now);
  assert.deepEqual(signals.get('owned1'), { alertCount: 2, lastAlertAt: '2026-08-25T00:00:00.000Z' });
  assert.equal(seen[0].searchParams.get('platform'), 'eq.youtube');
  assert.match(seen[0].searchParams.get('alerted_at'), /^gte\.2026-06-/);
});

test('product inference keeps organic routing useful without changing posted_at', () => {
  assert.equal(inferOwnerVideoProduct({ snippet: { title: '부모님도 홀딱 빠진 멜론바' } }), 'JD');
  assert.equal(inferOwnerVideoProduct({ snippet: { title: '라라스윗 파인트 신상' } }), 'P');
  assert.equal(inferOwnerVideoProduct({ snippet: { title: '듬뿍바 리뷰' } }), 'DB');
});

test('collector lists recent uploads and calls commentThreads only for changed counts', async () => {
  const now = Date.parse('2026-08-20T03:00:00Z');
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'db.test' && url.pathname.endsWith('/youtube_owner_video_state')) {
      return json([
        { channel_id: 'owner-1', video_id: 'same', comment_count: 2, last_scanned_count: 2, last_scanned_at: '2026-08-19T00:00:00Z' },
        { channel_id: 'owner-1', video_id: 'stale-high', comment_count: 149, last_scanned_count: 149, last_scanned_at: '2026-08-20T02:00:00Z' },
      ]);
    }
    if (url.hostname === 'db.test' && url.pathname.endsWith('/negative_comment_alerts')) return json([]);
    if (url.hostname === 'db.test' && url.pathname.endsWith('/meta_tokens')) {
      return json([{ kind: 'youtube_owner:owner-1', token: 'refresh', expires_at: '2099-01-01T00:00:00Z' }]);
    }
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'access' });
    if (url.pathname.endsWith('/channels') && url.searchParams.get('mine') === 'true') return json({ items: [{ id: 'owner-1' }] });
    if (url.pathname.endsWith('/channels')) return json({ items: [{
      id: 'owner-1', snippet: { title: '먹짱언니' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
    }] });
    if (url.pathname.endsWith('/playlistItems')) return json({ items: [
      { contentDetails: { videoId: 'same', videoPublishedAt: '2026-08-19T00:00:00Z' } },
      { contentDetails: { videoId: 'changed', videoPublishedAt: '2026-08-19T00:00:00Z' } },
      { contentDetails: { videoId: 'stale-high', videoPublishedAt: '2026-08-19T00:00:00Z' } },
      { contentDetails: { videoId: 'zero', videoPublishedAt: '2026-08-19T00:00:00Z' } },
    ] });
    if (url.pathname.endsWith('/videos')) return json({ items: [
      { id: 'same', snippet: { channelId: 'owner-1', channelTitle: '먹짱언니', title: '쫀득바', publishedAt: '2026-08-19T00:00:00Z' }, statistics: { commentCount: '2' } },
      { id: 'changed', snippet: { channelId: 'owner-1', channelTitle: '먹짱언니', title: '멜론바', publishedAt: '2026-08-19T00:00:00Z' }, statistics: { commentCount: '1' } },
      { id: 'stale-high', snippet: { channelId: 'owner-1', channelTitle: '먹짱언니', title: '쫀득바', publishedAt: '2026-08-19T00:00:00Z' }, statistics: { commentCount: '150' } },
      { id: 'zero', snippet: { channelId: 'owner-1', channelTitle: '먹짱언니', title: '쫀득바', publishedAt: '2026-08-19T00:00:00Z' }, statistics: { commentCount: '0' } },
    ] });
    if (url.pathname.endsWith('/commentThreads')) {
      const videoId = url.searchParams.get('videoId');
      return json({
        pageInfo: { totalResults: videoId === 'stale-high' ? 250 : 1 },
        items: [{
          snippet: { totalReplyCount: 0, topLevelComment: { id: `comment-${videoId}`, snippet: { authorDisplayName: 'u', textOriginal: '별로', publishedAt: '2026-08-20T00:00:00Z' } } },
        }],
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const config = loadYouTubeOwnerChannelConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'db', SLACK_BOT_TOKEN: 'slack',
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    YOUTUBE_OWNER_CHANNELS_JSON: JSON.stringify([{ name: '먹짱언니', channelId: 'owner-1', channelCategory: '소유 YouTube' }]),
  });
  // 테스트용 토큰과 일치하는 채널만 남긴다.
  config.youtubeOwnerChannels = config.youtubeOwnerChannels.filter((row) => row.channelId === 'owner-1');
  const result = await collectYouTubeOwnerChannels(config, fetchImpl, now);
  assert.equal(result.channels, 1);
  assert.equal(result.totalConfiguredChannels, 1);
  assert.equal(result.authenticatedChannels, 1);
  assert.deepEqual(result.missingOAuthChannels, []);
  assert.equal(result.videos, 4);
  assert.equal(result.due, 2);
  assert.equal(result.deepDue, 1);
  assert.equal(result.paginationDeepDue, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.zeroBaseline, 1);
  assert.equal(result.entries.length, 2);
  assert.equal(result.stateUpdates.length, 4);
  assert.ok(result.stateUpdates.every((row) => Object.hasOwn(row, 'last_scanned_count') && Object.hasOwn(row, 'last_scanned_at')));
  assert.equal(result.stateUpdates.find((row) => row.video_id === 'stale-high').last_scanned_count, 250);
  assert.equal(result.entries[0].target.source, undefined);
  assert.deepEqual(result.entries.map((entry) => entry.comments[0].id).sort(), ['comment-changed', 'comment-stale-high']);
  assert.equal(calls.filter((url) => url.pathname.endsWith('/commentThreads')).length, 2);
});

test('collector isolates one owner OAuth failure and continues another owner', async () => {
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'db.test' && url.pathname.endsWith('/youtube_owner_video_state')) return json([]);
    if (url.hostname === 'db.test' && url.pathname.endsWith('/negative_comment_alerts')) return json([]);
    if (url.hostname === 'db.test' && url.pathname.endsWith('/meta_tokens')) return json([
      { kind: 'youtube_owner:bad', token: 'bad-refresh' },
      { kind: 'youtube_owner:good', token: 'good-refresh' },
    ]);
    if (url.hostname === 'oauth2.googleapis.com') {
      const refresh = new URLSearchParams(String(init.body)).get('refresh_token');
      return refresh === 'bad-refresh' ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'access' });
    }
    if (url.pathname.endsWith('/channels') && url.searchParams.get('mine') === 'true') return json({ items: [{ id: 'good' }] });
    if (url.pathname.endsWith('/channels')) return json({ items: [{ id: 'good', snippet: { title: 'good' }, contentDetails: { relatedPlaylists: { uploads: 'UU' } } }] });
    if (url.pathname.endsWith('/playlistItems')) return json({ items: [] });
    throw new Error(`unexpected ${url}`);
  };
  const config = loadYouTubeOwnerChannelConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'db', SLACK_BOT_TOKEN: 'slack',
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    YOUTUBE_OWNER_CHANNELS_JSON: JSON.stringify([
      { name: 'bad', channelId: 'bad' }, { name: 'good', channelId: 'good' },
    ]),
  });
  config.youtubeOwnerChannels = config.youtubeOwnerChannels.filter((row) => ['bad', 'good'].includes(row.channelId));
  const result = await collectYouTubeOwnerChannels(config, fetchImpl);
  assert.equal(result.channels, 1);
  assert.equal(result.channelFailures.length, 1);
  assert.equal(result.channelFailures[0].channelId, 'bad');
});

test('collector reports configured channels without owner OAuth instead of shrinking the denominator', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'db.test' && url.pathname.endsWith('/youtube_owner_video_state')) return json([]);
    if (url.hostname === 'db.test' && url.pathname.endsWith('/negative_comment_alerts')) return json([]);
    if (url.hostname === 'db.test' && url.pathname.endsWith('/meta_tokens')) {
      return json([{ kind: 'youtube_owner:connected', token: 'refresh' }]);
    }
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'access' });
    if (url.pathname.endsWith('/channels') && url.searchParams.get('mine') === 'true') return json({ items: [{ id: 'connected' }] });
    if (url.pathname.endsWith('/channels')) return json({ items: [{
      id: 'connected', snippet: { title: 'connected' }, contentDetails: { relatedPlaylists: { uploads: 'UU' } },
    }] });
    if (url.pathname.endsWith('/playlistItems')) return json({ items: [] });
    throw new Error(`unexpected ${url}`);
  };
  const config = loadYouTubeOwnerChannelConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'db', SLACK_BOT_TOKEN: 'slack',
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    YOUTUBE_OWNER_CHANNELS_JSON: JSON.stringify([
      { name: '연결됨', channelId: 'connected' },
      { name: '미연결', channelId: 'missing' },
    ]),
  });
  config.youtubeOwnerChannels = config.youtubeOwnerChannels.filter((row) => ['connected', 'missing'].includes(row.channelId));

  const result = await collectYouTubeOwnerChannels(config, fetchImpl);
  assert.equal(result.totalConfiguredChannels, 2);
  assert.equal(result.authenticatedChannels, 1);
  assert.equal(result.channels, 1);
  assert.deepEqual(result.missingOAuthChannels, [{
    name: '미연결', channelId: 'missing', channelCategory: '소유 YouTube',
  }]);
});
