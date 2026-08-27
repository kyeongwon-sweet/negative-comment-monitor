import { loadMetaAdsConfig } from './meta-ads.js';
import { campaignNameMatchesFilter } from './normalize.js';
import { videoAssigneeFromAdTitle } from './slack.js';

export const YOUTUBE_AD_SOURCE = 'youtube_ads';
export const DEFAULT_GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com';
export const DEFAULT_GOOGLE_ADS_API_VERSION = 'v25';
export const DEFAULT_YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function nonnegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function parseCsv(value) {
  return unique(String(value || '').split(','));
}

function apiErrorMessage(payload) {
  if (typeof payload?.error === 'string') {
    const description = String(payload.error_description || '').trim();
    return description ? `${payload.error}: ${description}` : payload.error;
  }
  return payload?.error?.message || payload?.message || 'unknown error';
}

export function loadYouTubeAdsConfig(env = process.env) {
  const base = loadMetaAdsConfig(env);
  return {
    ...base,
    googleAdsApiBase: String(env.GOOGLE_ADS_API_BASE || DEFAULT_GOOGLE_ADS_API_BASE).trim().replace(/\/$/, ''),
    googleAdsApiVersion: String(env.GOOGLE_ADS_API_VERSION || DEFAULT_GOOGLE_ADS_API_VERSION).trim(),
    googleAdsDeveloperToken: required(env, 'GOOGLE_ADS_DEVELOPER_TOKEN'),
    googleAdsLoginCustomerId: digits(required(env, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID')),
    googleAdsCustomerIds: parseCsv(env.GOOGLE_ADS_CUSTOMER_IDS).map(digits).filter(Boolean),
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    googleAdsRefreshToken: required(env, 'GOOGLE_ADS_REFRESH_TOKEN'),
    youtubeRefreshToken: required(env, 'YOUTUBE_ADS_REFRESH_TOKEN'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || DEFAULT_YOUTUBE_API_BASE).trim().replace(/\/$/, ''),
    youtubeAdsChannelId: String(env.YOUTUBE_ADS_CHANNEL_ID || '').trim(),
    youtubeAdsCampaignNameFilter: String(env.AD_CAMPAIGN_NAME_FILTER || '빙과').trim(),
    youtubeAdsTargetVideoIds: parseCsv(env.YOUTUBE_ADS_TARGET_VIDEO_IDS),
    youtubeAdsProductName: String(env.YOUTUBE_ADS_PRODUCT_NAME || 'JD').trim(),
    youtubeAdsChannelCategory: String(env.YOUTUBE_ADS_CHANNEL_CATEGORY || '인지 광고').trim(),
    youtubeAdsLookbackDays: positiveInt(env.YOUTUBE_ADS_LOOKBACK_DAYS, 14, 90),
    youtubeAdsMaxThreadPages: positiveInt(env.YOUTUBE_ADS_MAX_THREAD_PAGES, 10, 100),
    youtubeAdsMaxReplyPages: positiveInt(env.YOUTUBE_ADS_MAX_REPLY_PAGES, 100, 100),
    youtubeAdsDeepMaxThreadPages: positiveInt(env.YOUTUBE_ADS_DEEP_MAX_THREAD_PAGES, 100, 100),
    youtubeAdsHighCommentThreshold: positiveInt(env.YOUTUBE_ADS_HIGH_COMMENT_THRESHOLD, 200, 100_000),
    youtubeAdsAlertAfter: String(env.YOUTUBE_ADS_ALERT_AFTER || '').trim(),
    // 대량 과거 알림은 Slack 채널별 전송 제한을 넘지 않도록 메시지 사이를 띄운다.
    // 정기 실행은 소량이므로 기본 0ms, 수동 백필 워크플로만 1.2초를 사용한다.
    youtubeAdsAlertDelayMs: nonnegativeInt(env.YOUTUBE_ADS_ALERT_DELAY_MS, 0, 10_000),
    youtubeAdsSlackRetries: positiveInt(env.YOUTUBE_ADS_SLACK_RETRIES, 5, 10),
    // 사용자가 확정한 운영정책: 부정 판정 카드를 먼저 Slack에 보낸 뒤 소유 채널 OAuth로 자동 숨김.
    youtubeOwnerAutoHide: String(env.YOUTUBE_OWNER_AUTO_HIDE || 'false').toLowerCase() === 'true',
  };
}

export async function refreshGoogleAccessToken(config, refreshToken, fetchImpl = fetch) {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleAdsClientId,
      client_secret: config.googleAdsClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google OAuth refresh failed (${response.status}): ${apiErrorMessage(payload)}`);
  }
  return payload.access_token;
}

export async function googleAdsSearch(config, customerId, query, accessToken, fetchImpl = fetch) {
  const id = digits(customerId);
  const response = await fetchImpl(
    `${config.googleAdsApiBase}/${config.googleAdsApiVersion}/customers/${id}/googleAds:searchStream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': config.googleAdsDeveloperToken,
        'login-customer-id': config.googleAdsLoginCustomerId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google Ads query failed for ${id} (${response.status}): ${apiErrorMessage(payload)}`);
  }
  return (Array.isArray(payload) ? payload : []).flatMap((batch) => batch.results || []);
}

export async function fetchActiveGoogleAdsCustomerIds(config, accessToken, fetchImpl = fetch) {
  if (config.googleAdsCustomerIds.length) return config.googleAdsCustomerIds;
  const rows = await googleAdsSearch(config, config.googleAdsLoginCustomerId, [
    'SELECT customer_client.client_customer, customer_client.id, customer_client.manager,',
    'customer_client.level, customer_client.status',
    'FROM customer_client',
    "WHERE customer_client.status = 'ENABLED'",
  ].join(' '), accessToken, fetchImpl);
  return unique(rows
    .map((row) => row.customerClient)
    .filter((client) => client && !client.manager && Number(client.level) > 0)
    .map((client) => digits(client.id || client.clientCustomer)));
}

export async function fetchMatchingGoogleAdsCampaigns(config, customerId, accessToken, fetchImpl = fetch) {
  const rows = await googleAdsSearch(config, customerId, [
    'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,',
    'campaign.advertising_channel_sub_type',
    'FROM campaign',
    "WHERE campaign.status != 'REMOVED'",
  ].join(' '), accessToken, fetchImpl);
  const keyword = config.youtubeAdsCampaignNameFilter;
  return rows
    .map((row) => ({
      customerId: digits(customerId),
      id: String(row.campaign?.id || ''),
      name: String(row.campaign?.name || ''),
      status: String(row.campaign?.status || ''),
      type: String(row.campaign?.advertisingChannelType || ''),
      subtype: String(row.campaign?.advertisingChannelSubType || ''),
    }))
    .filter((campaign) => campaign.id && campaignNameMatchesFilter(campaign.name, keyword));
}

function gaqlIdList(ids) {
  const safe = unique(ids).map(digits).filter(Boolean);
  return safe.length ? `(${safe.join(',')})` : '(0)';
}

function normalizeAssetResult(row) {
  const id = String(row.asset?.youtubeVideoAsset?.youtubeVideoId || '').trim();
  if (!id) return null;
  return {
    videoId: id,
    title: String(row.asset?.youtubeVideoAsset?.youtubeVideoTitle || row.asset?.name || ''),
    adName: String(row.adName || row.adGroupAd?.ad?.name || ''),
    assetResourceName: String(row.asset?.resourceName || ''),
    campaignId: String(row.campaign?.id || ''),
    campaignName: String(row.campaign?.name || ''),
  };
}

function adAssetResourceNames(ad = {}) {
  return unique([
    ad.videoAd?.video?.asset,
    ...(ad.videoResponsiveAd?.videos || []).map((item) => item.asset),
    ...(ad.demandGenVideoResponsiveAd?.videos || []).map((item) => item.asset),
    ...(ad.responsiveDisplayAd?.youtubeVideos || []).map((item) => item.asset),
  ]);
}

async function fetchAssetsByResourceNames(config, customerId, resourceNames, accessToken, fetchImpl) {
  const names = unique(resourceNames);
  const rows = [];
  for (let offset = 0; offset < names.length; offset += 100) {
    const literals = names.slice(offset, offset + 100)
      .map((name) => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
    rows.push(...await googleAdsSearch(config, customerId, [
      'SELECT asset.resource_name, asset.id, asset.name, asset.type,',
      'asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title',
      'FROM asset',
      `WHERE asset.resource_name IN (${literals})`,
    ].join(' '), accessToken, fetchImpl));
  }
  return rows;
}

export async function fetchYouTubeVideoAssets(config, customerId, campaigns, accessToken, fetchImpl = fetch) {
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const campaignIds = [...campaignById.keys()];
  if (!campaignIds.length) return [];
  const idList = gaqlIdList(campaignIds);
  const commonSelect = [
    'campaign.id, campaign.name, asset.resource_name, asset.id, asset.name, asset.type,',
    'asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title',
  ].join(' ');
  const queries = [
    `SELECT ${commonSelect}, ad_group_ad.ad.name FROM ad_group_ad_asset_view WHERE campaign.id IN ${idList} AND asset.type = 'YOUTUBE_VIDEO'`,
    `SELECT ${commonSelect} FROM asset_group_asset WHERE campaign.id IN ${idList} AND asset.type = 'YOUTUBE_VIDEO'`,
    `SELECT ${commonSelect} FROM campaign_asset WHERE campaign.id IN ${idList} AND asset.type = 'YOUTUBE_VIDEO'`,
  ];
  const resolved = [];
  for (const query of queries) resolved.push(...await googleAdsSearch(config, customerId, query, accessToken, fetchImpl));

  // 일부 레거시 Video/Display 광고는 asset view보다 ad 본문에만 영상 자산 참조가 남아 있다.
  const adRows = await googleAdsSearch(config, customerId, [
    'SELECT campaign.id, campaign.name, ad_group_ad.ad.id, ad_group_ad.ad.name,',
    'ad_group_ad.ad.video_ad.video.asset, ad_group_ad.ad.video_responsive_ad.videos,',
    'ad_group_ad.ad.demand_gen_video_responsive_ad.videos,',
    'ad_group_ad.ad.responsive_display_ad.youtube_videos',
    'FROM ad_group_ad',
    `WHERE campaign.id IN ${idList} AND ad_group_ad.status != 'REMOVED'`,
  ].join(' '), accessToken, fetchImpl);
  const refs = [];
  const refCampaigns = new Map();
  for (const row of adRows) {
    for (const resourceName of adAssetResourceNames(row.adGroupAd?.ad)) {
      refs.push(resourceName);
      if (!refCampaigns.has(resourceName)) refCampaigns.set(resourceName, []);
      refCampaigns.get(resourceName).push({
        id: String(row.campaign?.id || ''),
        name: String(row.campaign?.name || ''),
        adName: String(row.adGroupAd?.ad?.name || ''),
      });
    }
  }
  const directAssets = await fetchAssetsByResourceNames(config, customerId, refs, accessToken, fetchImpl);
  for (const row of directAssets) {
    const campaignsForAsset = refCampaigns.get(row.asset?.resourceName) || [{}];
    for (const campaign of campaignsForAsset) {
      resolved.push({ ...row, campaign, adName: campaign.adName || '' });
    }
  }

  const byVideo = new Map();
  for (const row of resolved) {
    const item = normalizeAssetResult(row);
    if (!item || !campaignById.has(item.campaignId)) continue;
    if (!byVideo.has(item.videoId)) {
      byVideo.set(item.videoId, {
        ...item,
        customerId: digits(customerId),
        campaignIds: [],
        campaignNames: [],
        adNames: [],
      });
    }
    const current = byVideo.get(item.videoId);
    if (item.campaignId && !current.campaignIds.includes(item.campaignId)) current.campaignIds.push(item.campaignId);
    if (item.campaignName && !current.campaignNames.includes(item.campaignName)) current.campaignNames.push(item.campaignName);
    if (item.adName && !current.adNames.includes(item.adName)) current.adNames.push(item.adName);
    if (!current.title && item.title) current.title = item.title;
  }
  return [...byVideo.values()];
}

async function youtubeJson(config, pathname, query, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`YouTube ${pathname} failed (${response.status}): ${apiErrorMessage(payload)}`);
    error.status = response.status;
    error.reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
    throw error;
  }
  return payload;
}

export async function fetchOwnedYouTubeChannel(config, accessToken, fetchImpl = fetch) {
  const payload = await youtubeJson(config, 'channels', { part: 'id,snippet,contentDetails', mine: 'true', maxResults: 50 }, accessToken, fetchImpl);
  const channels = Array.isArray(payload.items) ? payload.items : [];
  const selected = config.youtubeAdsChannelId
    ? channels.find((channel) => channel.id === config.youtubeAdsChannelId)
    : channels[0];
  if (!selected) {
    throw new Error(config.youtubeAdsChannelId
      ? `YouTube OAuth token does not own configured channel ${config.youtubeAdsChannelId}`
      : 'YouTube OAuth token does not expose an owned channel');
  }
  return selected;
}

export async function fetchOwnedYouTubeVideos(config, videoAssets, channelId, accessToken, fetchImpl = fetch) {
  const ids = unique(videoAssets.map((asset) => asset.videoId));
  const assetById = new Map(videoAssets.map((asset) => [asset.videoId, asset]));
  const videos = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const payload = await youtubeJson(config, 'videos', {
      part: 'id,snippet,status,statistics', id: ids.slice(offset, offset + 50).join(','), maxResults: 50,
    }, accessToken, fetchImpl);
    for (const item of payload.items || []) {
      // Google Ads의 일치 캠페인에 연결된 영상 자산 자체를 수집 신뢰 경계로 삼는다.
      // Google Ads UI에서 업로드한 영상은 현재 OAuth 채널과 다른 광고용 채널에 귀속될 수 있으므로
      // 채널 ID가 다르다는 이유만으로 댓글 수집 대상에서 제외하지 않는다. 대신 관리 가능 여부를
      // 따로 표시해 비소유 영상에 숨김 같은 관리 버튼이 노출되지 않게 한다.
      videos.push({
        ...item,
        adAsset: assetById.get(item.id),
        isOwnedChannel: String(item.snippet?.channelId || '') === String(channelId),
      });
    }
  }
  return videos;
}

function normalizeYouTubeComment(comment, videoId, parentId = '') {
  const snippet = comment?.snippet || {};
  return {
    id: String(comment?.id || ''),
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(comment?.id || '')}`,
    username: String(snippet.authorDisplayName || ''),
    text: String(snippet.textOriginal || snippet.textDisplay || ''),
    timestamp: String(snippet.publishedAt || snippet.updatedAt || ''),
    parentId: String(parentId || snippet.parentId || ''),
  };
}

async function fetchAllReplies(config, parentId, videoId, accessToken, fetchImpl) {
  const replies = [];
  let pageToken = '';
  for (let page = 0; page < (config.youtubeAdsMaxReplyPages || 100); page += 1) {
    const payload = await youtubeJson(config, 'comments', {
      part: 'id,snippet', parentId, maxResults: 100, textFormat: 'plainText', pageToken,
    }, accessToken, fetchImpl);
    replies.push(...(payload.items || []).map((comment) => normalizeYouTubeComment(comment, videoId, parentId)));
    pageToken = String(payload.nextPageToken || '');
    if (!pageToken) break;
  }
  return replies;
}

export async function fetchYouTubeVideoComments(config, videoId, accessToken, fetchImpl = fetch) {
  const comments = [];
  let pageToken = '';
  try {
    for (let page = 0; page < config.youtubeAdsMaxThreadPages; page += 1) {
      const payload = await youtubeJson(config, 'commentThreads', {
        part: 'id,snippet,replies', videoId, order: 'time', maxResults: 100,
        textFormat: 'plainText', pageToken,
      }, accessToken, fetchImpl);
      for (const thread of payload.items || []) {
        const top = thread.snippet?.topLevelComment;
        if (!top?.id) continue;
        comments.push(normalizeYouTubeComment(top, videoId));
        const embedded = thread.replies?.comments || [];
        const totalReplies = Number(thread.snippet?.totalReplyCount || 0);
        if (totalReplies > embedded.length) {
          comments.push(...await fetchAllReplies(config, top.id, videoId, accessToken, fetchImpl));
        } else {
          comments.push(...embedded.map((comment) => normalizeYouTubeComment(comment, videoId, top.id)));
        }
      }
      pageToken = String(payload.nextPageToken || '');
      if (!pageToken) break;
    }
  } catch (error) {
    if (error.reasons?.includes('commentsDisabled') || error.reasons?.includes('videoNotFound')) return [];
    throw error;
  }
  const byId = new Map(comments.filter((comment) => comment.id).map((comment) => [comment.id, comment]));
  return [...byId.values()];
}

function commentAfter(comment, cutoffMs) {
  const parsed = Date.parse(comment.timestamp || '');
  return !Number.isFinite(parsed) || parsed >= cutoffMs;
}

export async function buildYouTubeAdEntries(config, fetchImpl = fetch, now = Date.now()) {
  const adsToken = await refreshGoogleAccessToken(config, config.googleAdsRefreshToken, fetchImpl);
  const youtubeToken = await refreshGoogleAccessToken(config, config.youtubeRefreshToken, fetchImpl);
  const customerIds = await fetchActiveGoogleAdsCustomerIds(config, adsToken, fetchImpl);
  const campaigns = [];
  const assets = [];
  for (const customerId of customerIds) {
    const matching = await fetchMatchingGoogleAdsCampaigns(config, customerId, adsToken, fetchImpl);
    campaigns.push(...matching);
    assets.push(...await fetchYouTubeVideoAssets(config, customerId, matching, adsToken, fetchImpl));
  }
  const byVideo = new Map();
  const targetVideoIds = new Set(config.youtubeAdsTargetVideoIds || []);
  for (const asset of assets) {
    if (targetVideoIds.size && !targetVideoIds.has(String(asset.videoId))) continue;
    if (!byVideo.has(asset.videoId)) byVideo.set(asset.videoId, {
      ...asset,
      campaignIds: [],
      campaignNames: [],
      adNames: [],
    });
    const current = byVideo.get(asset.videoId);
    current.campaignIds = unique([...current.campaignIds, ...(asset.campaignIds || [])]);
    current.campaignNames = unique([...current.campaignNames, ...(asset.campaignNames || [])]);
    current.adNames = unique([...current.adNames, ...(asset.adNames || [])]);
    if (!current.title && asset.title) current.title = asset.title;
  }

  const channel = await fetchOwnedYouTubeChannel(config, youtubeToken, fetchImpl);
  const videos = await fetchOwnedYouTubeVideos(config, [...byVideo.values()], channel.id, youtubeToken, fetchImpl);
  const cutoffMs = config.youtubeAdsAlertAfter
    ? Date.parse(config.youtubeAdsAlertAfter)
    : now - config.youtubeAdsLookbackDays * 24 * 60 * 60 * 1000;
  const safeCutoff = Number.isFinite(cutoffMs) ? cutoffMs : 0;
  const entries = [];
  let commentCount = 0;
  for (const video of videos) {
    const totalComments = Number(video.statistics?.commentCount);
    const highComment = Number.isFinite(totalComments)
      && totalComments >= config.youtubeAdsHighCommentThreshold;
    const scanConfig = highComment
      ? { ...config, youtubeAdsMaxThreadPages: config.youtubeAdsDeepMaxThreadPages }
      : config;
    const comments = (await fetchYouTubeVideoComments(scanConfig, video.id, youtubeToken, fetchImpl))
      .filter((comment) => comment.text.trim() && commentAfter(comment, safeCutoff));
    commentCount += comments.length;
    if (!comments.length) continue;
    const campaignNames = video.adAsset?.campaignNames || [];
    const adNames = video.adAsset?.adNames || [];
    const extraAssignees = unique(adNames
      .map((name) => videoAssigneeFromAdTitle(name, config.videoAssignees))
      .filter(Boolean));
    const title = String(video.snippet?.title || video.adAsset?.title || video.id);
    entries.push({
      target: {
        platform: 'youtube',
        source: YOUTUBE_AD_SOURCE,
        postKey: `yt:${video.id}`,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
        channelName: String(video.snippet?.channelTitle || channel.snippet?.title || ''),
        channelCategory: config.youtubeAdsChannelCategory,
        productName: config.youtubeAdsProductName,
        brandName: config.brandContext,
        caption: [title, ...adNames, ...campaignNames].filter(Boolean).join(' / '),
        isManagedAccount: Boolean(video.isOwnedChannel),
        // 카드 링크명과 제작자 태그 모두 실제 광고 소재명(ad_group_ad.ad.name)을 우선한다.
        // 구형/무명 광고만 캠페인명·영상 제목으로 폴백한다.
        adTitle: adNames[0] || (campaignNames[0] ? `${campaignNames[0]} · ${title}` : title),
        campaignName: campaignNames.join(' / '),
        googleAdsCustomerId: video.adAsset?.customerId || '',
        googleAdsCampaignIds: video.adAsset?.campaignIds || [],
        youtubeVideoId: video.id,
        extraAssignees,
        fullContextReview: highComment,
      },
      comments,
    });
  }
  return {
    customers: customerIds.length,
    campaigns: campaigns.length,
    assets: assets.length,
    videos: videos.length,
    ownedVideos: videos.filter((video) => video.isOwnedChannel).length,
    externalVideos: videos.filter((video) => !video.isOwnedChannel).length,
    namedAdVideos: videos.filter((video) => (video.adAsset?.adNames || []).length > 0).length,
    creatorAssignedVideos: videos.filter((video) => (video.adAsset?.adNames || [])
      .some((name) => videoAssigneeFromAdTitle(name, config.videoAssignees))).length,
    comments: commentCount,
    entries,
    channelId: channel.id,
  };
}
