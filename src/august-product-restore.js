import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { extractPostKey } from './delta.js';
import { campaignNameMatchesFilter } from './normalize.js';
import {
  fetchActiveGoogleAdsCustomerIds,
  fetchMatchingGoogleAdsCampaigns,
  fetchYouTubeVideoAssets,
  refreshGoogleAccessToken,
} from './youtube-ads.js';
import {
  buildTikTokAdEntriesFromComments,
  fetchTikTokAdgroupComments,
  fetchTikTokAds,
  fetchTikTokCampaigns,
} from './tiktok-ads.js';
import { inferOwnerVideoProduct, YOUTUBE_OWNER_CHANNELS } from './youtube-owner-channel.js';
import { runTikTokConversionBackfill } from './tiktok-conversion-backfill.js';

const AUGUST_START = '2026-07-31T15:00:00Z';
const SEPTEMBER_START = '2026-08-31T15:00:00Z';

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function chunks(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

async function loadPaged(config, pathname, fetchImpl = fetch) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const separator = pathname.includes('?') ? '&' : '?';
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/${pathname}${separator}offset=${offset}&limit=1000`,
      { headers: headers(config) },
    );
    if (!response.ok) throw new Error(`Supabase export read failed (${response.status})`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

export async function loadAugustAlerts(config, fetchImpl = fetch) {
  return loadPaged(
    config,
    'negative_comment_alerts'
      + '?select=id,source,platform,comment_id,comment_text,post_url,alerted_at,review_decision'
      + `&alerted_at=gte.${encodeURIComponent(AUGUST_START)}`
      + `&alerted_at=lt.${encodeURIComponent(SEPTEMBER_START)}`
      + '&order=id.asc',
    fetchImpl,
  );
}

export async function loadOwnerVideoCatalog(config, fetchImpl = fetch) {
  const ownedChannelIds = new Set(YOUTUBE_OWNER_CHANNELS
    .filter((channel) => channel.channelCategory === '소유 YouTube')
    .map((channel) => channel.channelId));
  const channelNameById = new Map(YOUTUBE_OWNER_CHANNELS.map((channel) => [channel.channelId, channel.name]));
  const rows = await loadPaged(
    config,
    'youtube_owner_video_state?select=channel_id,video_id,video_title,published_at&order=video_id.asc',
    fetchImpl,
  );
  return new Map(rows
    .filter((row) => ownedChannelIds.has(String(row.channel_id || '')))
    .map((row) => [String(row.video_id || ''), {
      ...row,
      channel_name: channelNameById.get(String(row.channel_id || '')) || '',
    }]));
}

// 소재/캠페인 명명 규칙에서 정확한 상품 코드가 있으면 그대로 보존한다.
// 단독 영문 P, 1P 같은 제작 규격은 파인트 코드로 오인하지 않고 한글이 뒤따르는 P*만 허용한다.
export function productCodesFromText(value) {
  const text = String(value || '');
  const matches = text.match(/(?:^|[^A-Za-z0-9가-힣])((?:JD|DB|ZB|BA)[가-힣A-Za-z0-9]*|P[가-힣]+|C[가-힣]+)(?=$|[^A-Za-z0-9가-힣])/giu) || [];
  const codes = matches.map((match) => match.replace(/^[^A-Za-z0-9가-힣]+/u, '').trim());
  return unique(codes);
}

export function inferProductFromEvidence(evidence, fallback = '미확인') {
  for (const value of evidence || []) {
    const codes = productCodesFromText(value);
    if (codes.length) return { product: codes.join('/'), evidence: String(value), ambiguous: codes.length > 1 };
  }
  const joined = (evidence || []).join(' ');
  if (/파인트/i.test(joined)) return { product: 'P', evidence: joined, ambiguous: false };
  if (/쫀득|멜론바|망고바/i.test(joined)) return { product: 'JD', evidence: joined, ambiguous: false };
  if (/듬뿍/i.test(joined)) return { product: 'DB', evidence: joined, ambiguous: false };
  return { product: fallback, evidence: '', ambiguous: false };
}

export async function loadYouTubeAdCreativeMap(config, fetchImpl = fetch) {
  const accessToken = await refreshGoogleAccessToken(config, config.googleAdsRefreshToken, fetchImpl);
  const customerIds = await fetchActiveGoogleAdsCustomerIds(config, accessToken, fetchImpl);
  const assets = [];
  let campaigns = 0;
  for (const customerId of customerIds) {
    const matching = await fetchMatchingGoogleAdsCampaigns(config, customerId, accessToken, fetchImpl);
    campaigns += matching.length;
    assets.push(...await fetchYouTubeVideoAssets(config, customerId, matching, accessToken, fetchImpl));
  }
  const byVideo = new Map();
  for (const asset of assets) {
    const videoId = String(asset.videoId || '').trim();
    if (!videoId) continue;
    if (!byVideo.has(videoId)) byVideo.set(videoId, { adNames: [], campaignNames: [], titles: [] });
    const row = byVideo.get(videoId);
    row.adNames = unique([...row.adNames, ...(asset.adNames || []), asset.adName]);
    row.campaignNames = unique([...row.campaignNames, ...(asset.campaignNames || []), asset.campaignName]);
    row.titles = unique([...row.titles, asset.title]);
  }
  return { byVideo, campaigns, assets: assets.length };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export async function loadTikTokAdCommentContext(config, fetchImpl = fetch, now = Date.now(), sleep = wait) {
  const campaigns = await fetchTikTokCampaigns(config, fetchImpl);
  const ads = await fetchTikTokAds(config, campaigns.map((campaign) => campaign.campaign_id), fetchImpl);
  const campaignById = new Map(campaigns.map((campaign) => [String(campaign.campaign_id || ''), campaign]));
  const adById = new Map(ads.map((ad) => [String(ad.ad_id || ''), ad]));
  const adgroupIds = unique(ads.map((ad) => ad.adgroup_id));
  let started = 0;
  const pages = await mapWithConcurrency(adgroupIds, config.tiktokAdsConcurrency, async (adgroupId) => {
    if (started > 0 && config.tiktokAdsRequestDelayMs > 0) await sleep(config.tiktokAdsRequestDelayMs);
    started += 1;
    return fetchTikTokAdgroupComments(config, adgroupId, fetchImpl, now);
  });
  const comments = pages.flat().map((comment) => {
    const ad = adById.get(String(comment.ad_id || '')) || {};
    const campaign = campaignById.get(String(comment.campaign_id || ad.campaign_id || '')) || {};
    return {
      ...comment,
      ad_name: comment.ad_name || ad.ad_name || ad.ad_text || '',
      campaign_name: comment.campaign_name || campaign.campaign_name || '',
      campaign_id: comment.campaign_id || ad.campaign_id || campaign.campaign_id || '',
      adgroup_id: comment.adgroup_id || ad.adgroup_id || '',
    };
  });
  return { campaigns, ads, adgroupIds, comments };
}

function alertVideoId(alert) {
  const key = String(extractPostKey(alert.post_url) || '');
  return key.startsWith('yt:') ? key.slice(3) : '';
}

function kstTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function processingStatus(decision) {
  const value = String(decision || '').trim().toLowerCase();
  if (value === 'hidden') return '숨김완료';
  if (['false_positive', 'ignore', 'ignored', 'unhide', 'unhidden', 'approved'].includes(value)) return '공개유지(사람 결정)';
  if (value === 'unavailable') return '노출없음';
  if (value === 'completed') return '처리완료';
  return value || '미처리';
}

function restoredRow(alert, { product, channel, platform, creativeName }) {
  return {
    comment_id: String(alert.comment_id || ''),
    '상품': String(product || '미확인'),
    '채널': channel,
    '게시글_링크': String(alert.post_url || ''),
    '악플_내용': String(alert.comment_text || ''),
    '플랫폼': platform,
    '소재명': String(creativeName || ''),
    '처리상태': processingStatus(alert.review_decision),
    '탐지일시_KST': kstTimestamp(alert.alerted_at),
  };
}

function productCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row['상품']] = (counts[row['상품']] || 0) + 1;
  return counts;
}

export function restoreRowsFromContexts(alerts, youtubeContext, tiktokContext, ownerCatalog) {
  const tiktokByComment = new Map(tiktokContext.comments
    .map((comment) => [String(comment.comment_id || ''), comment])
    .filter(([id]) => id));
  const rows = [];
  const coverage = {
    youtubeAds: { alerts: 0, mapped: 0, ambiguous: 0 },
    tiktokAds: { alerts: 0, mapped: 0, ambiguous: 0 },
    ownerYouTube: { alerts: 0, mapped: 0, ambiguous: 0 },
  };

  for (const alert of alerts) {
    if (alert.source === 'youtube_ads' && alert.platform === 'youtube') {
      coverage.youtubeAds.alerts += 1;
      const creative = youtubeContext.byVideo.get(alertVideoId(alert));
      const evidence = creative ? [...creative.adNames, ...creative.campaignNames, ...creative.titles] : [];
      const inferred = inferProductFromEvidence(evidence);
      if (creative) coverage.youtubeAds.mapped += 1;
      if (inferred.ambiguous) coverage.youtubeAds.ambiguous += 1;
      rows.push(restoredRow(alert, {
        product: inferred.product,
        channel: '인지 광고',
        platform: '유튜브',
        creativeName: creative?.adNames?.[0] || creative?.campaignNames?.[0] || creative?.titles?.[0] || '',
      }));
      continue;
    }
    if (alert.source === 'tiktok_ads' && alert.platform === 'tiktok') {
      coverage.tiktokAds.alerts += 1;
      const comment = tiktokByComment.get(String(alert.comment_id || ''));
      const inferred = inferProductFromEvidence([comment?.ad_name, comment?.campaign_name]);
      if (comment) coverage.tiktokAds.mapped += 1;
      if (inferred.ambiguous) coverage.tiktokAds.ambiguous += 1;
      rows.push(restoredRow(alert, {
        product: inferred.product,
        channel: campaignNameMatchesFilter(comment?.campaign_name, '전환') ? '전환 광고' : '인지 광고',
        platform: '틱톡',
        creativeName: comment?.ad_name || comment?.campaign_name || '',
      }));
      continue;
    }
    if (alert.source == null && alert.platform === 'youtube') {
      const videoId = alertVideoId(alert);
      const video = ownerCatalog.get(videoId);
      if (!video) continue;
      coverage.ownerYouTube.alerts += 1;
      const product = inferOwnerVideoProduct({ snippet: { title: video.video_title || '' } }, '미확인');
      coverage.ownerYouTube.mapped += 1;
      rows.push(restoredRow(alert, {
        product,
        channel: '소유 YouTube',
        platform: '유튜브',
        creativeName: video.video_title || '',
      }));
    }
  }

  return { rows, coverage, productCounts: productCounts(rows) };
}

export function conversionCollectedFromTikTokContext(config, context) {
  const campaigns = context.campaigns.filter((campaign) => campaignNameMatchesFilter(campaign.campaign_name, '전환'));
  const campaignIds = new Set(campaigns.map((campaign) => String(campaign.campaign_id || '')).filter(Boolean));
  const ads = context.ads.filter((ad) => campaignIds.has(String(ad.campaign_id || '')));
  const allowedAdIds = new Set(ads.map((ad) => String(ad.ad_id || '')).filter(Boolean));
  const adgroupIds = new Set(ads.map((ad) => String(ad.adgroup_id || '')).filter(Boolean));
  const comments = context.comments.filter((comment) => allowedAdIds.has(String(comment.ad_id || '')));
  return {
    entries: buildTikTokAdEntriesFromComments({ ...config, tiktokCampaignNameFilter: '전환' }, comments, allowedAdIds),
    campaigns: campaigns.length,
    ads: ads.length,
    adgroups: adgroupIds.size,
    comments: comments.length,
  };
}

export async function runAugustProductRestore(
  config,
  { dryRun = true, fetchImpl = fetch, now = Date.now(), sleep = wait } = {},
) {
  const [alerts, youtubeContext, ownerCatalog] = await Promise.all([
    loadAugustAlerts(config, fetchImpl),
    loadYouTubeAdCreativeMap(config.youtube, fetchImpl),
    loadOwnerVideoCatalog(config, fetchImpl),
  ]);
  const tiktokContext = await loadTikTokAdCommentContext(config.tiktok, fetchImpl, now, sleep);
  const restored = restoreRowsFromContexts(alerts, youtubeContext, tiktokContext, ownerCatalog);
  const conversionCollected = conversionCollectedFromTikTokContext(config.tiktok, tiktokContext);
  const conversion = await runTikTokConversionBackfill(
    { ...config.tiktok, tiktokCampaignNameFilter: '전환' },
    { dryRun, fetchImpl, now, sleep, collected: conversionCollected },
  );
  const existingCommentIds = new Set(restored.rows.map((row) => row.comment_id));
  const newConversionRows = conversion.rows.filter((row) => !existingCommentIds.has(String(row.comment_id || '')));
  const rows = [...restored.rows, ...newConversionRows];
  return {
    rows,
    pintRows: rows.filter((row) => String(row['상품'] || '').toUpperCase().startsWith('P')),
    summary: {
      augustAlerts: alerts.length,
      outputRows: rows.length,
      restoredRows: restored.rows.length,
      newConversionRows: newConversionRows.length,
      coverage: restored.coverage,
      productCounts: productCounts(rows),
      youtubeApi: { campaigns: youtubeContext.campaigns, assets: youtubeContext.assets },
      tiktokApi: {
        campaigns: tiktokContext.campaigns.length,
        ads: tiktokContext.ads.length,
        adgroups: tiktokContext.adgroupIds.length,
        rawComments: tiktokContext.comments.length,
      },
      conversion: conversion.summary,
    },
  };
}

export function encryptAugustProductExport(payload, publicKeyBase64) {
  const publicKey = Buffer.from(String(publicKeyBase64 || ''), 'base64').toString('utf8');
  if (!publicKey.includes('BEGIN PUBLIC KEY')) throw new Error('Missing or invalid export public key');
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = publicEncrypt({
    key: publicKey,
    oaepHash: 'sha256',
    padding: constants.RSA_PKCS1_OAEP_PADDING,
  }, key);
  return {
    version: 1,
    algorithm: 'RSA-OAEP-SHA256+A256GCM',
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
