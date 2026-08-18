import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeAdEntries,
  fetchMatchingGoogleAdsCampaigns,
  loadYouTubeAdsConfig,
} from '../src/youtube-ads.js';
import { hasYouTubeAdsRunToday, inYouTubeAdsWindow, ownerModerationConfigFromAds, retrySlackRateLimit, youtubeDailyRunKey } from '../src/youtube-ads-run.js';

const CFG = {
  googleAdsApiBase: 'https://googleads.test',
  googleAdsApiVersion: 'v25',
  googleAdsDeveloperToken: 'dev',
  googleAdsLoginCustomerId: '3234668229',
  googleAdsCustomerIds: [],
  googleAdsClientId: 'client',
  googleAdsClientSecret: 'secret',
  googleAdsRefreshToken: 'ads-refresh',
  youtubeRefreshToken: 'youtube-refresh',
  youtubeApiBase: 'https://youtube.test/youtube/v3',
  youtubeAdsChannelId: 'channel-1',
  youtubeAdsCampaignNameFilter: '빙과',
  youtubeAdsProductName: 'JD',
  youtubeAdsChannelCategory: '인지 광고',
  youtubeAdsLookbackDays: 14,
  youtubeAdsMaxThreadPages: 10,
  youtubeAdsAlertAfter: '2026-08-01T00:00:00Z',
  brandContext: '라라스윗 쫀득바',
  videoAssignees: { '정요한': 'U_VIDEO' },
};

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

test('loadYouTubeAdsConfig separates Google Ads and channel-owner refresh tokens', () => {
  const config = loadYouTubeAdsConfig({
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'db', SLACK_BOT_TOKEN: 'slack',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'dev', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '323-466-8229',
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'ads', YOUTUBE_ADS_REFRESH_TOKEN: 'youtube',
    SLACK_ASSIGNEE_AWARENESS: 'U1', AD_CAMPAIGN_NAME_FILTER: '빙과',
  });
  assert.equal(config.googleAdsLoginCustomerId, '3234668229');
  assert.equal(config.googleAdsRefreshToken, 'ads');
  assert.equal(config.youtubeRefreshToken, 'youtube');
  assert.equal(config.youtubeAdsCampaignNameFilter, '빙과');
  assert.deepEqual(config.youtubeAdsTargetVideoIds, []);
  assert.equal(config.slackAssignees.awareness, 'U1');
  assert.equal(config.youtubeAdsAlertDelayMs, 0);
  assert.equal(config.youtubeAdsSlackRetries, 5);
  assert.equal(config.youtubeOwnerAutoHide, false);
});

test('ownerModerationConfigFromAds reuses only server credentials for post-alert auto-hide', () => {
  const owner = ownerModerationConfigFromAds({
    ...CFG, supabaseUrl: 'https://db.test', supabaseKey: 'db', slackBotToken: 'slack',
  });
  assert.equal(owner.dryRun, false);
  assert.equal(owner.singleAlert, false);
  assert.equal(owner.googleAdsClientId, 'client');
  assert.equal(owner.supabaseKey, 'db');
  assert.equal(owner.actor, 'youtube-auto-hide-owner-oauth');
});

test('retrySlackRateLimit retries only Slack rate-limit failures', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await retrySlackRateLimit(async () => {
    calls += 1;
    if (calls < 3) throw new Error('Slack API: ratelimited');
    return { ok: true };
  }, { maxRetries: 4, retryDelayMs: 100, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 200]);

  await assert.rejects(
    retrySlackRateLimit(async () => { throw new Error('Slack API: invalid_auth'); }),
    /invalid_auth/,
  );
});

test('fetchMatchingGoogleAdsCampaigns enforces the exact 빙과 substring locally', async () => {
  const fetchImpl = async () => jsonResponse([{ results: [
    { campaign: { id: '1', name: '[빙과] 인지', status: 'ENABLED', advertisingChannelType: 'VIDEO' } },
    { campaign: { id: '2', name: '[제과] 인지', status: 'ENABLED', advertisingChannelType: 'VIDEO' } },
  ] }]);
  const rows = await fetchMatchingGoogleAdsCampaigns(CFG, '815', 'token', fetchImpl);
  assert.deepEqual(rows.map((row) => row.id), ['1']);
});

test('buildYouTubeAdEntries discovers manager child, ad video, top comment and all replies', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === 'oauth2.googleapis.com') {
      const refresh = new URLSearchParams(String(init.body)).get('refresh_token');
      return jsonResponse({ access_token: refresh === 'ads-refresh' ? 'ads-access' : 'youtube-access' });
    }
    if (url.hostname === 'googleads.test') {
      const query = JSON.parse(init.body).query;
      if (query.includes('FROM customer_client')) {
        return jsonResponse([{ results: [
          { customerClient: { id: '8151438670', clientCustomer: 'customers/8151438670', manager: false, level: '1', status: 'ENABLED' } },
          { customerClient: { id: '3234668229', manager: true, level: '0', status: 'ENABLED' } },
        ] }]);
      }
      if (query.includes('FROM campaign ')) {
        return jsonResponse([{ results: [
          { campaign: { id: 'cp1', name: '[빙과] 쫀득바 인지', status: 'ENABLED', advertisingChannelType: 'VIDEO' } },
          { campaign: { id: 'cp2', name: '[전환] 기타', status: 'ENABLED', advertisingChannelType: 'VIDEO' } },
        ] }]);
      }
      if (query.includes('FROM ad_group_ad_asset_view')) {
        return jsonResponse([{ results: [{
          campaign: { id: 'cp1', name: '[빙과] 쫀득바 인지' },
          adGroupAd: { ad: { name: '[26.08]F_V_JD_인지_빙과_정요한' } },
          asset: { resourceName: 'customers/8151438670/assets/9', youtubeVideoAsset: { youtubeVideoId: 'abc123XYZ', youtubeVideoTitle: '광고영상' } },
        }] }]);
      }
      return jsonResponse([{ results: [] }]);
    }
    if (url.pathname.endsWith('/channels')) {
      return jsonResponse({ items: [{ id: 'channel-1', snippet: { title: '라라스윗' } }] });
    }
    if (url.pathname.endsWith('/videos')) {
      assert.equal(url.searchParams.get('id'), 'abc123XYZ');
      return jsonResponse({ items: [{
        id: 'abc123XYZ', snippet: { channelId: 'channel-1', channelTitle: '라라스윗', title: '쫀득바 광고', description: '' }, status: { privacyStatus: 'unlisted' },
      }] });
    }
    if (url.pathname.endsWith('/commentThreads')) {
      return jsonResponse({ items: [{
        id: 'thread1',
        snippet: {
          totalReplyCount: 2,
          topLevelComment: { id: 'top1', snippet: { authorDisplayName: 'u1', textOriginal: '별로', publishedAt: '2026-08-14T01:00:00Z' } },
        },
        replies: { comments: [{ id: 'reply1', snippet: { authorDisplayName: 'u2', textOriginal: '맞아', publishedAt: '2026-08-14T02:00:00Z', parentId: 'top1' } }] },
      }] });
    }
    if (url.pathname.endsWith('/comments')) {
      assert.equal(url.searchParams.get('parentId'), 'top1');
      return jsonResponse({ items: [
        { id: 'reply1', snippet: { authorDisplayName: 'u2', textOriginal: '맞아', publishedAt: '2026-08-14T02:00:00Z', parentId: 'top1' } },
        { id: 'reply2', snippet: { authorDisplayName: 'u3', textOriginal: '노맛', publishedAt: '2026-08-14T03:00:00Z', parentId: 'top1' } },
      ] });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await buildYouTubeAdEntries(CFG, fetchImpl, Date.parse('2026-08-14T09:00:00Z'));
  assert.equal(result.customers, 1);
  assert.equal(result.campaigns, 1);
  assert.equal(result.assets, 1);
  assert.equal(result.videos, 1);
  assert.equal(result.comments, 3);
  assert.equal(result.namedAdVideos, 1);
  assert.equal(result.creatorAssignedVideos, 1);
  assert.equal(result.entries[0].target.source, 'youtube_ads');
  assert.equal(result.entries[0].target.postKey, 'yt:abc123XYZ');
  assert.equal(result.entries[0].target.productName, 'JD');
  assert.equal(result.entries[0].target.adTitle, '[26.08]F_V_JD_인지_빙과_정요한');
  assert.deepEqual(result.entries[0].target.extraAssignees, ['U_VIDEO']);
  assert.deepEqual(result.entries[0].comments.map((comment) => comment.id), ['top1', 'reply1', 'reply2']);
  assert.equal(calls.filter((call) => call.url.hostname === 'oauth2.googleapis.com').length, 2);
});

test('Google Ads campaign videos remain collectible when the ad upload channel differs', async () => {
  const config = { ...CFG, googleAdsCustomerIds: ['8151438670'] };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return jsonResponse({ access_token: 'access' });
    if (url.hostname === 'googleads.test') {
      const query = JSON.parse(init.body).query;
      if (query.includes('FROM campaign ')) return jsonResponse([{ results: [{ campaign: { id: 'cp1', name: '[빙과] 인지', status: 'ENABLED' } }] }]);
      if (query.includes('FROM ad_group_ad_asset_view')) return jsonResponse([{ results: [{ campaign: { id: 'cp1', name: '[빙과] 인지' }, asset: { youtubeVideoAsset: { youtubeVideoId: 'foreign1' } } }] }]);
      return jsonResponse([{ results: [] }]);
    }
    if (url.pathname.endsWith('/channels')) return jsonResponse({ items: [{ id: 'channel-1', snippet: { title: '라라스윗' } }] });
    if (url.pathname.endsWith('/videos')) return jsonResponse({ items: [{ id: 'foreign1', snippet: { channelId: 'other-channel', channelTitle: 'Google Ads 영상', title: '광고 영상' } }] });
    if (url.pathname.endsWith('/commentThreads')) return jsonResponse({ items: [{
      id: 'thread1',
      snippet: {
        totalReplyCount: 0,
        topLevelComment: { id: 'top1', snippet: { authorDisplayName: 'u1', textOriginal: '별로', publishedAt: '2026-08-14T01:00:00Z' } },
      },
    }] });
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await buildYouTubeAdEntries(config, fetchImpl, Date.parse('2026-08-14T09:00:00Z'));
  assert.equal(result.videos, 1);
  assert.equal(result.ownedVideos, 0);
  assert.equal(result.externalVideos, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].target.isManagedAccount, false);
});

test('inYouTubeAdsWindow and daily ledger key follow the shared resilient morning policy', () => {
  const kst8 = Date.parse('2026-08-14T23:10:00Z');
  const kst12 = Date.parse('2026-08-15T03:10:00Z');
  assert.equal(inYouTubeAdsWindow(kst8, {}), true);
  assert.equal(inYouTubeAdsWindow(kst12, {}), false);
  assert.equal(inYouTubeAdsWindow(kst12, { YOUTUBE_ADS_FORCE: 'true' }), true);
  assert.equal(youtubeDailyRunKey(CFG, Date.parse('2026-08-13T23:10:00Z')), 'daily:youtube-ads:3234668229:2026-08-14');
});

test('hasYouTubeAdsRunToday skips only when the daily success row exists and fails open', async () => {
  const now = Date.parse('2026-08-13T23:10:00Z');
  const config = { ...CFG, supabaseUrl: 'https://db.test', supabaseKey: 'key' };
  const found = await hasYouTubeAdsRunToday(config, now, async () => jsonResponse([{ run_key: youtubeDailyRunKey(config, now) }]));
  assert.equal(found, true);
  assert.equal(await hasYouTubeAdsRunToday(config, now, async () => jsonResponse({}, 500)), false);
});
