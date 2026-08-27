import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractPostKey } from './delta.js';
import {
  fetchTikTokAdgroupComments,
  fetchTikTokAds,
  fetchTikTokCampaigns,
  loadTikTokAdsConfig,
} from './tiktok-ads.js';
import {
  fetchActiveGoogleAdsCustomerIds,
  fetchMatchingGoogleAdsCampaigns,
  fetchYouTubeVideoAssets,
  loadYouTubeAdsConfig,
  refreshGoogleAccessToken,
} from './youtube-ads.js';
import { replaceOwnerAssigneeBlock } from './youtube-ads-retag.js';

const SOURCES = ['meta_ads', 'tiktok_ads', 'youtube_ads'];
const AWARENESS_SCOPE = '쫀득바|인지 광고';

function headers(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

export function isPintCampaign(value) {
  return /파인트/i.test(String(value || ''));
}

function kstDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) : '';
}

export function selectPintAwarenessAlerts(alerts, candidates) {
  const meta = candidates.metaCommentIds || new Set();
  const tiktok = candidates.tiktokCommentIds || new Set();
  const youtube = candidates.youtubeVideoIds || new Set();
  return (alerts || []).filter((row) => {
    const source = String(row.source || '');
    if (source === 'meta_ads') return meta.has(String(row.comment_id || ''));
    if (source === 'tiktok_ads') return tiktok.has(String(row.comment_id || ''));
    if (source !== 'youtube_ads') return false;
    const key = extractPostKey(row.post_url);
    return key.startsWith('yt:') && youtube.has(key.slice(3));
  });
}

async function loadAlerts(config, fetchImpl) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
  url.searchParams.set('select', 'id,source,comment_id,post_url,slack_ts,alerted_at');
  url.searchParams.set('source', `in.(${SOURCES.join(',')})`);
  url.searchParams.set('slack_channel_id', `eq.${config.slackChannelId}`);
  url.searchParams.set('order', 'alerted_at.asc');
  url.searchParams.set('limit', '10000');
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Alert lookup failed (${response.status})`);
  return response.json();
}

async function loadMetaPintCommentIds(config, fetchImpl) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/meta_ad_comment_events`);
  url.searchParams.set('select', 'comment_id');
  url.searchParams.set('ad_title', 'ilike.*파인트*');
  url.searchParams.set('limit', '10000');
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Meta candidate lookup failed (${response.status})`);
  return new Set((await response.json()).map((row) => String(row.comment_id || '')).filter(Boolean));
}

async function loadTikTokPintCommentIds(config, fetchImpl, now) {
  const scanConfig = { ...config, tiktokAdsLookbackDays: 30, tiktokAdsMaxCommentsPerAdgroup: 1000 };
  const campaigns = (await fetchTikTokCampaigns(scanConfig, fetchImpl))
    .filter((campaign) => isPintCampaign(campaign.campaign_name));
  if (!campaigns.length) return new Set();
  const ads = await fetchTikTokAds(scanConfig, campaigns.map((campaign) => campaign.campaign_id), fetchImpl);
  const adgroupIds = unique(ads.map((ad) => ad.adgroup_id));
  const ids = new Set();
  for (let index = 0; index < adgroupIds.length; index += 1) {
    if (index > 0 && scanConfig.tiktokAdsRequestDelayMs > 0) await wait(scanConfig.tiktokAdsRequestDelayMs);
    const comments = await fetchTikTokAdgroupComments(scanConfig, adgroupIds[index], fetchImpl, now);
    for (const comment of comments) {
      const id = String(comment.comment_id || '').trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function loadYouTubePintVideoIds(config, fetchImpl) {
  const accessToken = await refreshGoogleAccessToken(config, config.googleAdsRefreshToken, fetchImpl);
  const customerIds = await fetchActiveGoogleAdsCustomerIds(config, accessToken, fetchImpl);
  const videoIds = new Set();
  for (const customerId of customerIds) {
    const campaigns = await fetchMatchingGoogleAdsCampaigns(config, customerId, accessToken, fetchImpl);
    const pintCampaigns = campaigns.filter((campaign) => isPintCampaign(campaign.name));
    if (!pintCampaigns.length) continue;
    const assets = await fetchYouTubeVideoAssets(config, customerId, pintCampaigns, accessToken, fetchImpl);
    for (const asset of assets) if (asset.videoId) videoIds.add(String(asset.videoId));
  }
  return videoIds;
}

async function loadThreadTs(config, date, fetchImpl) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/alert_threads`);
  url.searchParams.set('select', 'slack_ts');
  url.searchParams.set('kst_date', `eq.${date}`);
  url.searchParams.set('channel_category', `eq.${AWARENESS_SCOPE}`);
  url.searchParams.set('slack_channel_id', `eq.${config.slackChannelId}`);
  url.searchParams.set('limit', '1');
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Thread lookup failed (${response.status})`);
  return (await response.json())[0]?.slack_ts || '';
}

async function loadThreadReplies(config, threadTs, fetchImpl) {
  const messages = [];
  let cursor = '';
  do {
    const url = new URL('https://slack.com/api/conversations.replies');
    url.searchParams.set('channel', config.slackChannelId);
    url.searchParams.set('ts', threadTs);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${config.slackBotToken}` },
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(`Slack replies failed: ${payload.error || 'unknown_error'}`);
    messages.push(...(payload.messages || []));
    cursor = String(payload.response_metadata?.next_cursor || '');
  } while (cursor);
  return messages;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateSlackMessage(config, message, blocks, fetchImpl) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: config.slackChannelId, ts: message.ts, text: message.text, blocks }),
    });
    if (response.status === 429) {
      await wait(Math.max(1, Number(response.headers?.get?.('retry-after') || 3)) * 1000);
      continue;
    }
    const payload = await response.json();
    if (!payload.ok) throw new Error(`Slack update failed: ${payload.error || 'unknown_error'}`);
    return;
  }
  throw new Error('Slack update failed: ratelimited after retries');
}

export async function retagPintAwarenessCards(env = process.env, fetchImpl = fetch, now = Date.now()) {
  const youtubeConfig = loadYouTubeAdsConfig(env);
  const tiktokConfig = loadTikTokAdsConfig(env);
  const assigneeIds = unique([
    youtubeConfig.slackAssignees.p?.sponsorship,
    youtubeConfig.slackAssignees.p?.viralVideo,
  ]);
  if (assigneeIds.length !== 2) throw new Error('Pint awareness requires two configured assignees');
  const apply = String(env.APPLY || 'false').toLowerCase() === 'true';

  const [alerts, metaCommentIds, tiktokCommentIds, youtubeVideoIds] = await Promise.all([
    loadAlerts(youtubeConfig, fetchImpl),
    loadMetaPintCommentIds(youtubeConfig, fetchImpl),
    loadTikTokPintCommentIds(tiktokConfig, fetchImpl, now),
    loadYouTubePintVideoIds(youtubeConfig, fetchImpl),
  ]);
  const candidates = selectPintAwarenessAlerts(alerts, { metaCommentIds, tiktokCommentIds, youtubeVideoIds });
  const dates = unique(candidates.map((row) => kstDate(row.alerted_at)));
  const messageByTs = new Map();
  for (const date of dates) {
    const threadTs = await loadThreadTs(youtubeConfig, date, fetchImpl);
    if (!threadTs) continue;
    for (const message of await loadThreadReplies(youtubeConfig, threadTs, fetchImpl)) {
      messageByTs.set(String(message.ts || ''), message);
    }
  }

  const bySource = Object.fromEntries(SOURCES.map((source) => [source, 0]));
  const summary = { apply, candidates: candidates.length, liveCards: 0, changedCards: 0, updatedCards: 0, bySource };
  for (const row of candidates) {
    summary.bySource[row.source] += 1;
    const message = messageByTs.get(String(row.slack_ts || ''));
    if (!message || !Array.isArray(message.blocks)) continue;
    summary.liveCards += 1;
    const updated = replaceOwnerAssigneeBlock(message.blocks, assigneeIds);
    if (!updated.changed) continue;
    summary.changedCards += 1;
    if (!apply) continue;
    await updateSlackMessage(youtubeConfig, message, updated.blocks, fetchImpl);
    summary.updatedCards += 1;
    await wait(1200);
  }
  console.error(`[pint-awareness-retag] apply=${apply} candidates=${summary.candidates} live=${summary.liveCards} changed=${summary.changedCards} updated=${summary.updatedCards}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  retagPintAwarenessCards()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
