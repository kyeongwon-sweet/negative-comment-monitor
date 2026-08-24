import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectYouTubeOwnerChannels,
  inferOwnerVideoProduct,
  loadYouTubeOwnerChannelConfig,
  shouldScanOwnerVideo,
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
});

test('comment-count gate baselines zero and scans first-positive or changed videos only', () => {
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '0' } }, null), { due: false, reason: 'zero-baseline', current: 0 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '2' } }, null), { due: true, reason: 'first-scan', current: 2 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '2' } }, { last_scanned_count: 2 }), { due: false, reason: 'unchanged', current: 2 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '3' } }, { last_scanned_count: 2 }), { due: true, reason: 'changed', current: 3 });
  assert.deepEqual(shouldScanOwnerVideo({ statistics: { commentCount: '0' } }, { last_scanned_count: null }), { due: true, reason: 'changed', current: 0 });
  assert.equal(shouldScanOwnerVideo({ statistics: {} }, null).reason, 'no-signal');
});

test('고댓글 영상은 댓글수 불변이어도 일일 심층검사하고 강제검사는 캐시를 우회한다', () => {
  const now = Date.parse('2026-08-24T00:00:00Z');
  const video = { id: 'viral', statistics: { commentCount: '495' } };
  const stale = { last_scanned_count: 495, last_scanned_at: '2026-08-22T00:00:00Z' };
  assert.deepEqual(shouldScanOwnerVideo(video, stale, {
    now, highCommentThreshold: 200, highCommentRescanHours: 24,
  }), { due: true, reason: 'high-comment-cadence', current: 495, deepScan: true });
  assert.equal(shouldScanOwnerVideo(video, { ...stale, last_scanned_at: '2026-08-23T23:00:00Z' }, {
    now, highCommentThreshold: 200, highCommentRescanHours: 24,
  }).due, false);
  assert.deepEqual(shouldScanOwnerVideo(video, stale, {
    now, forceVideoIds: new Set(['viral']), forceReclassify: true,
  }), { due: true, reason: 'forced-deep-scan', current: 495, deepScan: true, forceReclassify: true });
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
      return json([{ channel_id: 'owner-1', video_id: 'same', comment_count: 2, last_scanned_count: 2, last_scanned_at: '2026-08-19T00:00:00Z' }]);
    }
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
      { contentDetails: { videoId: 'zero', videoPublishedAt: '2026-08-19T00:00:00Z' } },
    ] });
    if (url.pathname.endsWith('/videos')) return json({ items: [
      { id: 'same', snippet: { channelId: 'owner-1', channelTitle: '먹짱언니', title: '쫀득바', publishedAt: '2026-08-19T00:00:00Z' }, statistics: { commentCount: '2' } },
      { id: 'changed', snippet: { channelId: 'owner-1', channelTitle: '먹짱언니', title: '멜론바', publishedAt: '2026-08-19T00:00:00Z' }, statistics: { commentCount: '1' } },
      { id: 'zero', snippet: { channelId: 'owner-1', channelTitle: '먹짱언니', title: '쫀득바', publishedAt: '2026-08-19T00:00:00Z' }, statistics: { commentCount: '0' } },
    ] });
    if (url.pathname.endsWith('/commentThreads')) return json({ items: [{
      snippet: { totalReplyCount: 0, topLevelComment: { id: 'comment-1', snippet: { authorDisplayName: 'u', textOriginal: '별로', publishedAt: '2026-08-20T00:00:00Z' } } },
    }] });
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
  assert.equal(result.videos, 3);
  assert.equal(result.due, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.zeroBaseline, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.stateUpdates.length, 3);
  assert.ok(result.stateUpdates.every((row) => Object.hasOwn(row, 'last_scanned_count') && Object.hasOwn(row, 'last_scanned_at')));
  assert.equal(result.entries[0].target.source, undefined);
  assert.equal(result.entries[0].comments[0].id, 'comment-1');
  assert.equal(calls.filter((url) => url.pathname.endsWith('/commentThreads')).length, 1);
});

test('collector isolates one owner OAuth failure and continues another owner', async () => {
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'db.test' && url.pathname.endsWith('/youtube_owner_video_state')) return json([]);
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
