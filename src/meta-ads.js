import { loadMetaToken } from './meta-token.js';
import { videoAssigneeFromAdTitle } from './slack.js';

export const META_AD_SOURCE = 'meta_ads';

// 이름→Slack ID 매핑 JSON(META_AD_VIDEO_ASSIGNEES). 파싱 실패는 빈 맵.
function parseVideoAssignees(raw) {
  try { const m = JSON.parse(String(raw || '{}')); return m && typeof m === 'object' ? m : {}; }
  catch { return {}; }
}
export const DEFAULT_META_GRAPH = 'https://graph.facebook.com/v26.0';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function headers(config, extra = {}) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...extra,
  };
}

// Meta 광고댓글 전용 실행은 Apify/GAS 설정을 요구하지 않는다.
export function loadMetaAdsConfig(env = process.env) {
  return {
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackChannelId: String(env.SLACK_CHANNEL_ID || 'C0BHD9S69JA').trim(),
    slackBotToken: required(env, 'SLACK_BOT_TOKEN'),
    slackAssignees: { other: String(env.SLACK_ASSIGNEE_OTHER || 'U0B2Y0ZC8QZ').trim() },
    managedChannelCategories: [],
    brandContext: String(env.BRAND_CONTEXT || '라라스윗 쫀득바').trim(),
    anthropicKey: String(env.ANTHROPIC_API_KEY || '').trim(),
    anthropicModel: String(env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001').trim(),
    metaGraphBase: String(env.META_GRAPH_BASE || DEFAULT_META_GRAPH).trim().replace(/\/$/, ''),
    metaTokenKind: String(env.META_TOKEN_KIND || 'ig_ads').trim(),
    metaAdsProductName: String(env.META_ADS_PRODUCT_NAME || 'JD').trim(),
    metaAdsChannelCategory: String(env.META_ADS_CHANNEL_CATEGORY || '인지 광고').trim(),
    metaAdsInstagramUsername: String(env.META_ADS_INSTAGRAM_USERNAME || 'lalasweet_icecream').trim(),
    videoAssignees: parseVideoAssignees(env.META_AD_VIDEO_ASSIGNEES),
    dryRun: String(env.DRY_RUN || 'false').toLowerCase() === 'true',
    costThresholds: { apify: 2, anthropic: 0.1, total: 3 },
  };
}

export async function loadPendingMetaAdEvents(config, limit = 100, fetchImpl = fetch) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const fields = [
    'id', 'comment_id', 'ig_user_id', 'media_id', 'original_media_id', 'ad_id', 'ad_title',
    'username', 'comment_text', 'parent_comment_id', 'event_time', 'received_at',
  ].join(',');
  const url = `${config.supabaseUrl}/rest/v1/meta_ad_comment_events`
    + `?select=${fields}&processed_at=is.null&order=received_at.asc&limit=${safeLimit}`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Meta event queue GET ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function loadStoredToken(config, fetchImpl) {
  try {
    return (await loadMetaToken(config, config.metaTokenKind || 'ig_ads', fetchImpl))?.token || '';
  } catch {
    return '';
  }
}

export async function loadMetaMedia(config, mediaId, token, fetchImpl = fetch) {
  if (!mediaId || !token) return null;
  const fields = encodeURIComponent('id,permalink,caption,username,timestamp');
  const response = await fetchImpl(`${config.metaGraphBase}/${encodeURIComponent(mediaId)}?fields=${fields}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data && !data.error ? data : null;
}

// Webhook 이벤트를 기존 분류기 입력(entries)으로 변환한다.
// 광고 소재가 unpublished/dynamic이라 permalink 조회가 실패해도 댓글 본문 분류는 계속한다.
export async function buildMetaAdEntries(config, events, fetchImpl = fetch) {
  if (!Array.isArray(events) || !events.length) return [];
  const token = await loadStoredToken(config, fetchImpl);
  const mediaIds = [...new Set(events.map((event) => event.media_id || event.original_media_id).filter(Boolean))];
  const mediaById = new Map();
  for (const mediaId of mediaIds) {
    const media = await loadMetaMedia(config, mediaId, token, fetchImpl);
    if (media) mediaById.set(String(mediaId), media);
  }

  const fallbackUrl = `https://www.instagram.com/${encodeURIComponent(config.metaAdsInstagramUsername)}/`;
  const grouped = new Map();
  for (const event of events) {
    const mediaId = String(event.media_id || event.original_media_id || 'unknown');
    const key = `${mediaId}|${event.ad_id}`;
    const media = mediaById.get(mediaId) || {};
    if (!grouped.has(key)) {
      // 광고 이름(ad_title) 마지막 이름 = 영상 담당자 → 기본 담당자와 함께 태그.
      const videoAssigneeId = videoAssigneeFromAdTitle(event.ad_title, config.videoAssignees);
      grouped.set(key, {
        target: {
          platform: 'instagram',
          source: META_AD_SOURCE,
          url: String(media.permalink || fallbackUrl),
          channelName: config.metaAdsInstagramUsername,
          channelCategory: config.metaAdsChannelCategory,
          productName: config.metaAdsProductName,
          brandName: config.brandContext,
          caption: String(media.caption || event.ad_title || ''),
          isManagedAccount: true,
          metaMediaId: mediaId === 'unknown' ? '' : mediaId,
          metaAdId: String(event.ad_id || ''),
          adTitle: String(event.ad_title || ''),
          extraAssignees: videoAssigneeId ? [videoAssigneeId] : [],
        },
        comments: [],
      });
    }
    grouped.get(key).comments.push({
      id: String(event.comment_id || ''),
      platform: 'instagram',
      url: String(media.permalink || fallbackUrl),
      username: String(event.username || ''),
      text: String(event.comment_text || ''),
      timestamp: String(event.event_time || event.received_at || ''),
      parentId: String(event.parent_comment_id || ''),
      metaEventId: event.id,
    });
  }
  return [...grouped.values()];
}

export async function markMetaAdEventsProcessed(config, ids, fetchImpl = fetch, now = Date.now()) {
  const unique = [...new Set(ids.map((id) => String(id || '')).filter((id) => /^\d+$/.test(id)))];
  if (!unique.length) return 0;
  const encoded = unique.join(',');
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/meta_ad_comment_events?id=in.(${encodeURIComponent(encoded)})`,
    {
      method: 'PATCH',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ processed_at: new Date(now).toISOString(), last_error: null }),
    },
  );
  if (!response.ok) throw new Error(`Meta event queue PATCH ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return unique.length;
}

export async function markMetaAdEventsFailed(config, ids, error, fetchImpl = fetch) {
  const unique = [...new Set(ids.map((id) => String(id || '')).filter((id) => /^\d+$/.test(id)))];
  if (!unique.length) return 0;
  const encoded = unique.join(',');
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/meta_ad_comment_events?id=in.(${encodeURIComponent(encoded)})`,
    {
      method: 'PATCH',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ last_error: String(error?.message || error || 'unknown error').slice(0, 500) }),
    },
  );
  return response.ok ? unique.length : 0;
}
