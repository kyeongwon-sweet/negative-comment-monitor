import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { commentFingerprint, loadSeenFingerprints, recordAlert } from './dedup.js';
import { computeClassifierHash } from './cache.js';
import { ensureDailyThread } from './threads.js';
import { kstDateKey } from './schedule.js';
import {
  assigneeForTarget,
  productGroup,
  productLabel,
  sendAlert,
  videoAssigneeFromAdTitle,
} from './slack.js';
import {
  fetchActiveGoogleAdsCustomerIds,
  fetchOwnedYouTubeChannel,
  fetchOwnedYouTubeVideos,
  fetchYouTubeVideoComments,
  googleAdsSearch,
  loadYouTubeAdsConfig,
  refreshGoogleAccessToken,
} from './youtube-ads.js';
import { retrySlackRateLimit } from './youtube-ads-run.js';

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function gaqlIdList(ids) {
  const safe = unique(ids).map(digits).filter(Boolean);
  return safe.length ? `(${safe.join(',')})` : '(0)';
}

function gaqlStringList(values) {
  return unique(values).map((value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
}

export function adGroupNameMatches(name, filter) {
  const haystack = String(name || '').trim().toLowerCase();
  const needles = String(filter || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return Boolean(haystack && needles.length && needles.some((needle) => haystack.includes(needle)));
}

export async function fetchMatchingAdGroups(config, customerId, filter, accessToken, fetchImpl = fetch) {
  const rows = await googleAdsSearch(config, customerId, [
    'SELECT campaign.id, campaign.name, campaign.status,',
    'ad_group.id, ad_group.name, ad_group.status',
    'FROM ad_group',
    "WHERE campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'",
  ].join(' '), accessToken, fetchImpl);
  return rows.map((row) => ({
    customerId: digits(customerId),
    campaignId: String(row.campaign?.id || ''),
    campaignName: String(row.campaign?.name || ''),
    id: String(row.adGroup?.id || ''),
    name: String(row.adGroup?.name || ''),
  })).filter((row) => row.id && adGroupNameMatches(row.name, filter));
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
    const literals = gaqlStringList(names.slice(offset, offset + 100));
    if (!literals) continue;
    rows.push(...await googleAdsSearch(config, customerId, [
      'SELECT asset.resource_name, asset.name, asset.type,',
      'asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title',
      'FROM asset',
      `WHERE asset.resource_name IN (${literals})`,
    ].join(' '), accessToken, fetchImpl));
  }
  return rows;
}

function addVideoAsset(byVideo, row) {
  const videoId = String(row.asset?.youtubeVideoAsset?.youtubeVideoId || '').trim();
  if (!videoId) return;
  if (!byVideo.has(videoId)) byVideo.set(videoId, {
    videoId,
    title: String(row.asset?.youtubeVideoAsset?.youtubeVideoTitle || row.asset?.name || ''),
    customerIds: [],
    campaignNames: [],
    adGroupNames: [],
    adNames: [],
  });
  const current = byVideo.get(videoId);
  current.customerIds = unique([...current.customerIds, row.customerId]);
  current.campaignNames = unique([...current.campaignNames, row.campaign?.name]);
  current.adGroupNames = unique([...current.adGroupNames, row.adGroup?.name]);
  current.adNames = unique([...current.adNames, row.adName, row.adGroupAd?.ad?.name]);
  if (!current.title) current.title = String(row.asset?.youtubeVideoAsset?.youtubeVideoTitle || row.asset?.name || '');
}

export async function fetchAdGroupVideoAssets(config, customerId, adGroups, accessToken, fetchImpl = fetch) {
  const groupById = new Map(adGroups.map((group) => [group.id, group]));
  if (!groupById.size) return [];
  const idList = gaqlIdList([...groupById.keys()]);
  const rows = await googleAdsSearch(config, customerId, [
    'SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.name,',
    'asset.resource_name, asset.name, asset.type,',
    'asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title',
    'FROM ad_group_ad_asset_view',
    `WHERE ad_group.id IN ${idList} AND asset.type = 'YOUTUBE_VIDEO'`,
  ].join(' '), accessToken, fetchImpl);

  // 레거시 Video/Display 광고는 asset view가 아닌 광고 본문에만 영상 참조가 남을 수 있다.
  const adRows = await googleAdsSearch(config, customerId, [
    'SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.name,',
    'ad_group_ad.ad.video_ad.video.asset, ad_group_ad.ad.video_responsive_ad.videos,',
    'ad_group_ad.ad.demand_gen_video_responsive_ad.videos,',
    'ad_group_ad.ad.responsive_display_ad.youtube_videos',
    'FROM ad_group_ad',
    `WHERE ad_group.id IN ${idList} AND ad_group_ad.status != 'REMOVED'`,
  ].join(' '), accessToken, fetchImpl);
  const refs = new Map();
  for (const row of adRows) {
    for (const resourceName of adAssetResourceNames(row.adGroupAd?.ad)) {
      if (!refs.has(resourceName)) refs.set(resourceName, []);
      refs.get(resourceName).push(row);
    }
  }
  for (const assetRow of await fetchAssetsByResourceNames(config, customerId, [...refs.keys()], accessToken, fetchImpl)) {
    for (const source of refs.get(assetRow.asset?.resourceName) || []) {
      rows.push({ ...assetRow, campaign: source.campaign, adGroup: source.adGroup, adName: source.adGroupAd?.ad?.name });
    }
  }

  const byVideo = new Map();
  for (const row of rows) {
    if (!groupById.has(String(row.adGroup?.id || ''))) continue;
    addVideoAsset(byVideo, { ...row, customerId: digits(customerId) });
  }
  return [...byVideo.values()];
}

async function loadSeenInBatches(config, fingerprints, fetchImpl) {
  const seen = new Set();
  for (let offset = 0; offset < fingerprints.length; offset += 75) {
    const batch = await loadSeenFingerprints(config, fingerprints.slice(offset, offset + 75), fetchImpl);
    for (const value of batch) seen.add(value);
  }
  return seen;
}

export function summarizeAdGroupAudit(entries, risksPerEntry, seen) {
  const videos = [];
  let comments = 0;
  let negatives = 0;
  let alreadyAlerted = 0;
  let missing = 0;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    let videoNegative = 0;
    let videoSeen = 0;
    let videoMissing = 0;
    comments += entry.comments.length;
    for (let commentIndex = 0; commentIndex < entry.comments.length; commentIndex += 1) {
      const risk = risksPerEntry[entryIndex]?.[commentIndex] || { alert: false };
      if (!risk.alert) continue;
      videoNegative += 1;
      const fingerprint = commentFingerprint(entry.target, entry.comments[commentIndex]);
      if (seen.has(fingerprint)) videoSeen += 1;
      else videoMissing += 1;
    }
    negatives += videoNegative;
    alreadyAlerted += videoSeen;
    missing += videoMissing;
    videos.push({
      videoId: entry.target.youtubeVideoId,
      title: entry.target.videoTitle,
      comments: entry.comments.length,
      negatives: videoNegative,
      alreadyAlerted: videoSeen,
      missing: videoMissing,
    });
  }
  return { videoCount: videos.length, comments, negatives, alreadyAlerted, missing, videos };
}

async function applyMissingAlerts(config, entries, risksPerEntry, seen, fetchImpl, now) {
  if (String(process.env.APPLY_MISSING || '').toLowerCase() !== 'true') return 0;
  let inserted = 0;
  let classifierHash = null;
  try { classifierHash = computeClassifierHash(config); } catch { classifierHash = null; }
  const threads = new Map();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const { target, comments } = entries[entryIndex];
    for (let commentIndex = 0; commentIndex < comments.length; commentIndex += 1) {
      const risk = risksPerEntry[entryIndex]?.[commentIndex] || { alert: false };
      if (!risk.alert) continue;
      const comment = { ...comments[commentIndex], risk };
      const fingerprint = commentFingerprint(target, comment);
      if (seen.has(fingerprint)) continue;
      const label = productLabel(productGroup(target.productName));
      const category = target.channelCategory || '인지 광고';
      const scopeKey = `${label}|${category}`;
      if (!threads.has(scopeKey)) {
        threads.set(scopeKey, await ensureDailyThread(config, {
          kstDate: kstDateKey(now), scopeKey, productLabel: label, category,
          assignee: assigneeForTarget(target, config.slackAssignees),
        }, fetchImpl));
      }
      const slack = await retrySlackRateLimit(
        () => sendAlert(config, target, comment, fetchImpl, threads.get(scopeKey)),
        { maxRetries: config.youtubeAdsSlackRetries },
      );
      const row = await recordAlert(config, target, comment, fingerprint, slack.ts, classifierHash, fetchImpl);
      if (row) inserted += 1;
      seen.add(fingerprint);
    }
  }
  return inserted;
}

export async function auditYouTubeAdGroup(config = loadYouTubeAdsConfig(), fetchImpl = fetch, now = Date.now()) {
  const filter = String(process.env.YOUTUBE_ADGROUP_NAME_FILTER || '무디').trim();
  const adsToken = await refreshGoogleAccessToken(config, config.googleAdsRefreshToken, fetchImpl);
  const youtubeToken = await refreshGoogleAccessToken(config, config.youtubeRefreshToken, fetchImpl);
  const customerIds = await fetchActiveGoogleAdsCustomerIds(config, adsToken, fetchImpl);
  const groups = [];
  const assets = [];
  for (const customerId of customerIds) {
    const matching = await fetchMatchingAdGroups(config, customerId, filter, adsToken, fetchImpl);
    groups.push(...matching);
    assets.push(...await fetchAdGroupVideoAssets(config, customerId, matching, adsToken, fetchImpl));
  }
  const merged = new Map();
  for (const asset of assets) {
    if (!merged.has(asset.videoId)) merged.set(asset.videoId, { ...asset });
    else {
      const current = merged.get(asset.videoId);
      current.campaignNames = unique([...current.campaignNames, ...asset.campaignNames]);
      current.adGroupNames = unique([...current.adGroupNames, ...asset.adGroupNames]);
      current.adNames = unique([...current.adNames, ...asset.adNames]);
    }
  }
  const channel = await fetchOwnedYouTubeChannel(config, youtubeToken, fetchImpl);
  const videos = await fetchOwnedYouTubeVideos(config, [...merged.values()], channel.id, youtubeToken, fetchImpl);
  const entries = [];
  for (const video of videos) {
    const adAsset = video.adAsset || {};
    const comments = await fetchYouTubeVideoComments({ ...config, youtubeAdsMaxThreadPages: 100 }, video.id, youtubeToken, fetchImpl);
    const adTitle = adAsset.adNames?.[0] || adAsset.title || String(video.snippet?.title || video.id);
    entries.push({
      target: {
        platform: 'youtube', source: 'youtube_ads', postKey: `yt:${video.id}`,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
        youtubeVideoId: video.id, videoTitle: String(video.snippet?.title || adAsset.title || video.id),
        channelName: String(video.snippet?.channelTitle || channel.snippet?.title || ''),
        channelCategory: config.youtubeAdsChannelCategory, productName: 'JD멜', brandName: config.brandContext,
        caption: [video.snippet?.title, ...adAsset.adNames, ...adAsset.adGroupNames, ...adAsset.campaignNames].filter(Boolean).join(' / '),
        adTitle, assetName: adTitle, isManagedAccount: Boolean(video.isOwnedChannel),
        extraAssignees: unique((adAsset.adNames || []).map((name) => videoAssigneeFromAdTitle(name, config.videoAssignees)).filter(Boolean)),
      },
      comments: comments.filter((comment) => comment.text.trim()),
    });
  }
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const risksPerEntry = await classifyTargetsBatched(entries, { ...config, dryRun: true }, undefined, stats, fetchImpl);
  const fingerprints = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = 0; j < entries[i].comments.length; j += 1) {
      if (risksPerEntry[i]?.[j]?.alert) fingerprints.push(commentFingerprint(entries[i].target, entries[i].comments[j]));
    }
  }
  const seen = await loadSeenInBatches(config, fingerprints, fetchImpl);
  const summary = {
    filter, customerCount: customerIds.length, adGroupCount: groups.length,
    adGroupNames: unique(groups.map((group) => group.name)),
    ...summarizeAdGroupAudit(entries, risksPerEntry, seen),
    inserted: 0,
    llm: stats,
  };
  summary.inserted = await applyMissingAlerts(config, entries, risksPerEntry, seen, fetchImpl, now);
  return summary;
}

async function writeStepSummary(summary) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## YouTube 광고세트 댓글 전수 확인', '',
    `- 광고세트 필터: ${summary.filter}`,
    `- 검색 고객계정 / 일치 광고세트 / 영상: ${summary.customerCount} / ${summary.adGroupCount} / ${summary.videoCount}`,
    `- 댓글·대댓글 / 부정 / 기존 알림 / 누락: ${summary.comments} / ${summary.negatives} / ${summary.alreadyAlerted} / ${summary.missing}`,
    `- 신규 알림·DB 적재: ${summary.inserted}`, '',
    '| 영상 | 댓글 | 부정 | 기존 | 누락 |', '|---|---:|---:|---:|---:|',
    ...summary.videos.map((video) => `| [${String(video.title || video.videoId).replace(/\|/g, '\\|')}](https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}) | ${video.comments} | ${video.negatives} | ${video.alreadyAlerted} | ${video.missing} |`),
    '', '> 공개 로그에는 댓글 ID·본문·OAuth 토큰을 기록하지 않습니다.', '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  auditYouTubeAdGroup()
    .then(async (summary) => {
      console.log(JSON.stringify({
        filter: summary.filter, customerCount: summary.customerCount, adGroupCount: summary.adGroupCount,
        videoCount: summary.videoCount, comments: summary.comments, negatives: summary.negatives,
        alreadyAlerted: summary.alreadyAlerted, missing: summary.missing, inserted: summary.inserted,
      }));
      await writeStepSummary(summary);
    })
    .catch((error) => {
      console.error(`[youtube-adgroup-audit] ${error.message}`);
      process.exitCode = 1;
    });
}
