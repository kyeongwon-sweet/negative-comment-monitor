import { loadMetaAdsConfig } from './meta-ads.js';
import { campaignNameMatchesFilter } from './normalize.js';
import { videoAssigneeFromAdTitle } from './slack.js';

export const TIKTOK_AD_SOURCE = 'tiktok_ads';
export const DEFAULT_TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

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

function kstDate(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiHeaders(config) {
  return { 'Access-Token': config.tiktokAccessToken };
}

async function apiJson(config, pathname, query, fetchImpl) {
  const url = new URL(`${config.tiktokApiBase}/${pathname.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetchImpl(url, { headers: apiHeaders(config) });
    const payload = await response.json().catch(() => ({}));
    const rateLimited = response.status === 429 || [40000, 40100].includes(Number(payload.code));
    if (rateLimited && attempt < 4) {
      await wait(1500 * (2 ** attempt));
      continue;
    }
    if (!response.ok || Number(payload.code) !== 0) {
      throw new Error(`TikTok ${pathname} failed (${response.status}/${payload.code ?? '-'}): ${payload.message || 'unknown error'}`);
    }
    return payload.data || {};
  }
  throw new Error(`TikTok ${pathname} failed after retries`);
}

export function loadTikTokAdsConfig(env = process.env) {
  const base = loadMetaAdsConfig(env);
  return {
    ...base,
    tiktokApiBase: String(env.TIKTOK_API_BASE || DEFAULT_TIKTOK_API_BASE).trim().replace(/\/$/, ''),
    tiktokAccessToken: required(env, 'TIKTOK_ACCESS_TOKEN'),
    tiktokAppId: String(env.TIKTOK_APP_ID || '').trim(),
    tiktokAdvertiserId: required(env, 'TIKTOK_ADVERTISER_ID'),
    tiktokCampaignNameFilter: String(env.AD_CAMPAIGN_NAME_FILTER || '빙과').trim(),
    tiktokAdsProductName: String(env.TIKTOK_ADS_PRODUCT_NAME || 'JD').trim(),
    tiktokAdsChannelCategory: String(env.TIKTOK_ADS_CHANNEL_CATEGORY || '인지 광고').trim(),
    tiktokAdsLookbackDays: positiveInt(env.TIKTOK_ADS_LOOKBACK_DAYS, 7, 30),
    tiktokAdsMaxCommentsPerAdgroup: positiveInt(env.TIKTOK_ADS_MAX_COMMENTS_PER_ADGROUP, 100, 1000),
    // 최초 라이브 전환 때 과거 댓글 수백 건이 한꺼번에 Slack으로 쏟아지는 것을 막는 기준시각.
    // 값이 없으면 기존 동작대로 조회 기간 전체를 분류한다.
    tiktokAdsAlertAfter: String(env.TIKTOK_ADS_ALERT_AFTER || '').trim(),
    // comment/list는 QPS 제한이 낮다. 기본은 직렬+간격으로 두고 환경변수로만 상향한다.
    tiktokAdsConcurrency: positiveInt(env.TIKTOK_ADS_CONCURRENCY, 1, 5),
    tiktokAdsRequestDelayMs: positiveInt(env.TIKTOK_ADS_REQUEST_DELAY_MS, 1000, 5000),
    tiktokAdsAutoHide: String(env.TIKTOK_ADS_AUTO_HIDE || 'false').toLowerCase() === 'true',
  };
}

async function fetchPagedList(config, pathname, query, listKey, fetchImpl, pageSize = 1000) {
  const rows = [];
  for (let page = 1; page <= 100; page += 1) {
    const data = await apiJson(config, pathname, { ...query, page, page_size: pageSize }, fetchImpl);
    const batch = Array.isArray(data[listKey]) ? data[listKey] : [];
    rows.push(...batch);
    const totalPages = Number(data.page_info?.total_page || 1);
    if (!batch.length || page >= totalPages) break;
  }
  return rows;
}

export async function fetchTikTokCampaigns(config, fetchImpl = fetch) {
  return fetchPagedList(
    config,
    'campaign/get/',
    { advertiser_id: config.tiktokAdvertiserId },
    'list',
    fetchImpl,
  );
}

export function filterTikTokCampaigns(campaigns, keyword) {
  return (Array.isArray(campaigns) ? campaigns : [])
    .filter((campaign) => campaignNameMatchesFilter(campaign.campaign_name, keyword));
}

export async function fetchTikTokAds(config, campaignIds, fetchImpl = fetch) {
  const unique = [...new Set((campaignIds || []).map(String).filter(Boolean))];
  const ads = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const campaignBatch = unique.slice(offset, offset + 100);
    ads.push(...await fetchPagedList(
      config,
      'ad/get/',
      { advertiser_id: config.tiktokAdvertiserId, filtering: { campaign_ids: campaignBatch } },
      'list',
      fetchImpl,
    ));
  }
  return ads;
}

export async function fetchTikTokAdgroupComments(config, adgroupId, fetchImpl = fetch, now = Date.now()) {
  const end = kstDate(now);
  const start = kstDate(now - config.tiktokAdsLookbackDays * 24 * 60 * 60 * 1000);
  const maxComments = config.tiktokAdsMaxCommentsPerAdgroup;
  const pageSize = Math.min(100, maxComments);
  const comments = [];
  for (let page = 1; comments.length < maxComments && page <= 100; page += 1) {
    const data = await apiJson(config, 'comment/list/', {
      advertiser_id: config.tiktokAdvertiserId,
      search_field: 'ADGROUP_ID',
      search_value: String(adgroupId),
      start_time: start,
      end_time: end,
      sort_field: 'CREATE_TIME',
      sort_type: 'DESC',
      page,
      page_size: pageSize,
    }, fetchImpl);
    const batch = Array.isArray(data.comments) ? data.comments : [];
    comments.push(...batch);
    const totalPages = Number(data.page_info?.total_page || 1);
    if (!batch.length || page >= totalPages) break;
  }
  return comments.slice(0, maxComments);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function targetUrl(config, comment) {
  const itemId = String(comment.tiktok_item_id || '').trim();
  if (itemId) return `https://www.tiktok.com/@ad/video/${encodeURIComponent(itemId)}`;
  return `https://ads.tiktok.com/i18n/perf/creative?aadvid=${encodeURIComponent(config.tiktokAdvertiserId)}`;
}

function targetKey(comment) {
  const itemId = String(comment.tiktok_item_id || '').trim();
  if (itemId) return `tt:${itemId}`;
  return `ttad:${String(comment.ad_id || comment.adgroup_id || 'unknown')}`;
}

export function buildTikTokAdEntriesFromComments(config, comments, allowedAdIds = null) {
  const allowed = allowedAdIds instanceof Set ? allowedAdIds : null;
  const alertAfterMs = config.tiktokAdsAlertAfter ? Date.parse(config.tiktokAdsAlertAfter) : NaN;
  const grouped = new Map();
  for (const raw of (Array.isArray(comments) ? comments : [])) {
    const adId = String(raw.ad_id || '').trim();
    if (allowed && (!adId || !allowed.has(adId))) continue;
    if (!campaignNameMatchesFilter(raw.campaign_name, config.tiktokCampaignNameFilter)) continue;
    if (String(raw.comment_status || '').toUpperCase() === 'HIDDEN') continue;
    const commentId = String(raw.comment_id || '').trim();
    const text = String(raw.content || '').trim();
    if (!commentId || !text) continue;
    const createdMs = Date.parse(String(raw.create_time || ''));
    if (Number.isFinite(alertAfterMs) && Number.isFinite(createdMs) && createdMs < alertAfterMs) continue;

    const key = `${targetKey(raw)}|${adId}`;
    if (!grouped.has(key)) {
      const adTitle = String(raw.ad_name || '');
      const videoAssigneeId = videoAssigneeFromAdTitle(adTitle, config.videoAssignees);
      grouped.set(key, {
        target: {
          platform: 'tiktok',
          source: TIKTOK_AD_SOURCE,
          url: targetUrl(config, raw),
          postKey: targetKey(raw),
          channelName: 'TikTok 광고',
          channelCategory: config.tiktokAdsChannelCategory,
          productName: config.tiktokAdsProductName,
          brandName: config.brandContext,
          caption: String(raw.ad_text || raw.ad_name || ''),
          isManagedAccount: true,
          adTitle,
          extraAssignees: videoAssigneeId ? [videoAssigneeId] : [],
          tiktokAdvertiserId: config.tiktokAdvertiserId,
          tiktokAdId: adId,
          tiktokAdgroupId: String(raw.adgroup_id || ''),
          tiktokItemId: String(raw.tiktok_item_id || ''),
        },
        comments: [],
        seenIds: new Set(),
      });
    }
    const group = grouped.get(key);
    if (group.seenIds.has(commentId)) continue;
    group.seenIds.add(commentId);
    group.comments.push({
      id: commentId,
      platform: 'tiktok',
      url: group.target.url,
      username: String(raw.user_name || raw.user_id || ''),
      text,
      timestamp: String(raw.create_time || ''),
      parentId: String(raw.original_comment_id || ''),
    });
  }
  return [...grouped.values()].map(({ seenIds: _seenIds, ...entry }) => entry);
}

export async function buildTikTokAdEntries(config, fetchImpl = fetch, now = Date.now()) {
  const campaigns = filterTikTokCampaigns(
    await fetchTikTokCampaigns(config, fetchImpl),
    config.tiktokCampaignNameFilter,
  );
  if (!campaigns.length) return { entries: [], campaigns: 0, ads: 0, adgroups: 0, comments: 0 };

  const ads = await fetchTikTokAds(config, campaigns.map((campaign) => campaign.campaign_id), fetchImpl);
  const allowedAdIds = new Set(ads.map((ad) => String(ad.ad_id || '')).filter(Boolean));
  const adgroupIds = [...new Set(ads.map((ad) => String(ad.adgroup_id || '')).filter(Boolean))];
  let startedRequests = 0;
  const batches = await mapWithConcurrency(
    adgroupIds,
    config.tiktokAdsConcurrency,
    async (adgroupId) => {
      if (startedRequests > 0 && config.tiktokAdsRequestDelayMs > 0) {
        await wait(config.tiktokAdsRequestDelayMs);
      }
      startedRequests += 1;
      return fetchTikTokAdgroupComments(config, adgroupId, fetchImpl, now);
    },
  );
  const comments = batches.flat();
  return {
    entries: buildTikTokAdEntriesFromComments(config, comments, allowedAdIds),
    campaigns: campaigns.length,
    ads: ads.length,
    adgroups: adgroupIds.length,
    comments: comments.length,
  };
}
