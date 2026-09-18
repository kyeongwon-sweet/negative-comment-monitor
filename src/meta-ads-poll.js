import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { kstDateKey } from './schedule.js';
import { isConversionAd, loadMetaAdsConfig } from './meta-ads.js';
import { loadMetaToken } from './meta-token.js';

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function graphHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function requiredAccount(env = process.env) {
  const value = String(env.META_AD_ACCOUNT_ID || '').trim();
  if (!value) throw new Error('Missing environment variable: META_AD_ACCOUNT_ID');
  return value.startsWith('act_') ? value : `act_${value}`;
}

export function metaPollBlockKey(now = Date.now(), intervalMinutes = 60) {
  const intervalMs = Math.max(15, Number(intervalMinutes) || 60) * 60_000;
  return `meta-comment-poll:${Math.floor(now / intervalMs)}`;
}

async function claimPollBlock(config, runKey, now, fetchImpl) {
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: headers(config, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    }),
    body: JSON.stringify([{ run_key: runKey, kst_date: kstDateKey(now), apify_usd: 0, anthropic_usd: 0 }]),
  });
  if (!response.ok) throw new Error(`Meta poll claim failed (${response.status})`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function releasePollBlock(config, runKey, fetchImpl) {
  await fetchImpl(
    `${config.supabaseUrl}/rest/v1/cost_usage_ledger?run_key=eq.${encodeURIComponent(runKey)}`,
    { method: 'DELETE', headers: headers(config) },
  ).catch(() => {});
}

export async function fetchMetaAdMedia(config, token, accountId, fetchImpl = fetch) {
  const fields = 'id,name,updated_time,campaign{name},creative{effective_instagram_media_id,source_instagram_media_id,actor_id,instagram_actor_id}';
  let next = `${config.metaGraphBase}/${encodeURIComponent(accountId)}/ads`
    + `?fields=${encodeURIComponent(fields)}&limit=100`
    + `&effective_status=${encodeURIComponent(JSON.stringify(['ACTIVE']))}&sort=updated_time_descending`;
  const byMedia = new Map();
  for (let page = 0; next && page < 20; page += 1) {
    const response = await fetchImpl(next, { headers: graphHeaders(token) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Graph pagination이 뒷 페이지에서 일시 500을 내도 이미 확보한 활성 소재는 보존한다.
      if (byMedia.size > 0 && response.status >= 500) break;
      const code = Number(payload.error?.code || 0);
      const type = String(payload.error?.type || '').replace(/[^A-Za-z]/g, '').slice(0, 40);
      throw new Error(`Meta ads poll failed (${response.status}; code=${code}${type ? `; type=${type}` : ''})`);
    }
    for (const ad of payload.data || []) {
      const adId = String(ad.id || '');
      const adTitle = String(ad.name || '');
      const campaignName = String(ad.campaign?.name || '');
      const actorId = String(ad.creative?.actor_id || ad.creative?.instagram_actor_id || '');
      if (!adId || isConversionAd(adTitle)) continue;
      for (const raw of [ad.creative?.effective_instagram_media_id, ad.creative?.source_instagram_media_id]) {
        const mediaId = String(raw || '');
        if (mediaId && !byMedia.has(mediaId)) {
          byMedia.set(mediaId, {
            adId,
            adTitle,
            campaignName,
            ...(actorId ? { actorId } : {}),
          });
        }
      }
    }
    next = String(payload.paging?.next || '');
  }
  return byMedia;
}

// 웹훅은 앱에 연결된 Page/Instagram 프로페셔널 계정의 댓글만 전달한다.
// 파트너십 광고처럼 제3자 계정의 미디어는 Marketing API poll로는 보이지만
// 우리 앱의 웹훅 유입 대상이 아니므로, zero-inflow 진단에서 별도로 구분한다.
export async function fetchManagedMetaActorIds(config, token, fetchImpl = fetch) {
  let next = `${config.metaGraphBase}/me/accounts`
    + `?fields=${encodeURIComponent('id,instagram_business_account{id}')}&limit=100`;
  const ids = new Set();
  for (let page = 0; next && page < 10; page += 1) {
    const response = await fetchImpl(next, { headers: graphHeaders(token) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = Number(payload.error?.code || 0);
      throw new Error(`Meta managed account lookup failed (${response.status}; code=${code})`);
    }
    for (const item of payload.data || []) {
      const pageId = String(item.id || '');
      const igId = String(item.instagram_business_account?.id || '');
      if (pageId) ids.add(pageId);
      if (igId) ids.add(igId);
    }
    next = String(payload.paging?.next || '');
  }
  return ids;
}

const DEFAULT_WEBHOOK_PERMISSIONS = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_manage_comments',
];

// zero-inflow 진단은 Marketing API poll 성공만으로 webhook 건강을 단정하면 안 된다.
// 토큰 권한·관리 Page/IG 수·각 Page의 앱 구독을 함께 확인해, 권한 회수나
// subscribed_apps 이탈을 정상 무댓글로 오인하지 않게 한다.
export async function fetchMetaWebhookHealth(config, token, {
  appId = '',
  requiredPermissions = DEFAULT_WEBHOOK_PERMISSIONS,
} = {}, fetchImpl = fetch) {
  const permissionUrl = `${config.metaGraphBase}/me/permissions?limit=100`;
  const accountsUrl = `${config.metaGraphBase}/me/accounts`
    + `?fields=${encodeURIComponent('id,instagram_business_account{id},access_token')}&limit=100`;
  const [permissionResponse, accountsResponse] = await Promise.all([
    fetchImpl(permissionUrl, { headers: graphHeaders(token) }),
    fetchImpl(accountsUrl, { headers: graphHeaders(token) }),
  ]);
  const permissionPayload = await permissionResponse.json().catch(() => ({}));
  const accountsPayload = await accountsResponse.json().catch(() => ({}));
  if (!permissionResponse.ok) {
    const code = Number(permissionPayload.error?.code || 0);
    throw new Error(`Meta permission lookup failed (${permissionResponse.status}; code=${code})`);
  }
  if (!accountsResponse.ok) {
    const code = Number(accountsPayload.error?.code || 0);
    throw new Error(`Meta managed account lookup failed (${accountsResponse.status}; code=${code})`);
  }

  const grantedPermissions = new Set(
    (permissionPayload.data || [])
      .filter((item) => String(item.status || '').toLowerCase() === 'granted')
      .map((item) => String(item.permission || ''))
      .filter(Boolean),
  );
  const required = [...new Set((requiredPermissions || []).map(String).map((value) => value.trim()).filter(Boolean))];
  const missingPermissions = required.filter((permission) => !grantedPermissions.has(permission));
  const pages = (accountsPayload.data || []).map((item) => ({
    pageId: String(item.id || ''),
    igId: String(item.instagram_business_account?.id || ''),
    pageToken: String(item.access_token || ''),
  })).filter((item) => item.pageId);
  const actorIds = new Set();
  for (const page of pages) {
    actorIds.add(page.pageId);
    if (page.igId) actorIds.add(page.igId);
  }

  const normalizedAppId = String(appId || '').trim();
  let subscribedPages = null;
  let subscriptionErrors = 0;
  if (normalizedAppId) {
    const checks = await Promise.all(pages.map(async (page) => {
      if (!page.pageToken) return { subscribed: false, error: true };
      const url = `${config.metaGraphBase}/${encodeURIComponent(page.pageId)}/subscribed_apps`
        + '?fields=id,subscribed_fields&limit=100';
      try {
        const response = await fetchImpl(url, { headers: graphHeaders(page.pageToken) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return { subscribed: false, error: true };
        const app = (payload.data || []).find((item) => String(item.id || '') === normalizedAppId);
        const fields = app?.subscribed_fields || app?.fields || [];
        return { subscribed: Boolean(app) && fields.map(String).includes('feed'), error: false };
      } catch {
        return { subscribed: false, error: true };
      }
    }));
    subscribedPages = checks.filter((check) => check.subscribed).length;
    subscriptionErrors = checks.filter((check) => check.error).length;
  }

  return {
    actorIds,
    managedPages: pages.length,
    managedInstagramAccounts: pages.filter((page) => page.igId).length,
    subscribedPages,
    subscriptionErrors,
    missingPermissions,
  };
}

export async function fetchMetaMediaCommentCounts(config, token, mediaIds, fetchImpl = fetch) {
  const counts = new Map();
  const ids = [...new Set(mediaIds.map(String).filter(Boolean))];
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const url = `${config.metaGraphBase}/?ids=${encodeURIComponent(batch.join(','))}&fields=comments_count`;
    const response = await fetchImpl(url, { headers: graphHeaders(token) });
    if (!response.ok) continue;
    const payload = await response.json().catch(() => ({}));
    for (const id of batch) {
      const raw = payload[id]?.comments_count;
      counts.set(id, raw == null || !Number.isFinite(Number(raw)) ? null : Math.max(0, Number(raw)));
    }
  }
  return counts;
}

export async function fetchRecentMetaMediaComments(
  config,
  token,
  mediaId,
  { cutoffMs, maxPages = 3 } = {},
  fetchImpl = fetch,
) {
  const fields = 'id,text,username,timestamp,parent_id,hidden';
  let next = `${config.metaGraphBase}/${encodeURIComponent(mediaId)}/comments`
    + `?fields=${encodeURIComponent(fields)}&order=reverse_chronological&limit=100`;
  const out = [];
  for (let page = 0; next && page < Math.max(1, maxPages); page += 1) {
    const response = await fetchImpl(next, { headers: graphHeaders(token) });
    if (!response.ok) {
      if ([400, 403, 404].includes(response.status)) return out;
      throw new Error(`Meta media comments poll failed (${response.status})`);
    }
    const payload = await response.json();
    let reachedCutoff = false;
    for (const comment of payload.data || []) {
      const eventMs = Date.parse(String(comment.timestamp || ''));
      if (Number.isFinite(cutoffMs) && Number.isFinite(eventMs) && eventMs < cutoffMs) {
        reachedCutoff = true;
        continue;
      }
      if (comment.hidden === true) continue;
      const id = String(comment.id || '');
      const text = String(comment.text || '').trim();
      if (!id || !text) continue;
      out.push({
        comment_id: id,
        media_id: mediaId,
        username: comment.username ? String(comment.username) : null,
        comment_text: text,
        parent_comment_id: comment.parent_id ? String(comment.parent_id) : null,
        event_time: Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : null,
      });
    }
    if (reachedCutoff) break;
    next = String(payload.paging?.next || '');
  }
  return out;
}

async function storePolledEvents(config, events, fetchImpl) {
  if (!events.length) return { count: 0, commentIds: [] };
  let stored = 0;
  const commentIds = [];
  for (let index = 0; index < events.length; index += 200) {
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/meta_ad_comment_events?on_conflict=comment_id`, {
      method: 'POST',
      headers: headers(config, {
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation',
      }),
      body: JSON.stringify(events.slice(index, index + 200)),
    });
    if (!response.ok) throw new Error(`Meta poll queue insert failed (${response.status})`);
    const rows = await response.json().catch(() => []);
    stored += Array.isArray(rows) ? rows.length : 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row?.comment_id || '');
      if (id) commentIds.push(id);
    }
  }
  return { count: stored, commentIds };
}

export async function pollMetaAdComments(config = loadMetaAdsConfig(), fetchImpl = fetch, now = Date.now(), env = process.env) {
  const intervalMinutes = Math.max(15, Number(env.META_ADS_POLL_INTERVAL_MINUTES || 60));
  const runKey = metaPollBlockKey(now, intervalMinutes);
  const force = String(env.META_ADS_POLL_FORCE || '').toLowerCase() === 'true';
  if (!force && !(await claimPollBlock(config, runKey, now, fetchImpl))) return { skipped: 'already-polled', stored: 0 };
  try {
    const tokenRow = await loadMetaToken(config, config.metaTokenKind || 'ig_ads', fetchImpl);
    if (!tokenRow?.token) throw new Error('Meta poll token not found');
    const requiredPermissions = String(
      env.META_REQUIRED_WEBHOOK_PERMISSIONS || DEFAULT_WEBHOOK_PERMISSIONS.join(','),
    ).split(',').map((value) => value.trim()).filter(Boolean);
    const [media, webhookHealth] = await Promise.all([
      fetchMetaAdMedia(config, tokenRow.token, requiredAccount(env), fetchImpl),
      fetchMetaWebhookHealth(config, tokenRow.token, {
        appId: env.META_APP_ID,
        requiredPermissions,
      }, fetchImpl),
    ]);
    const managedActorIds = webhookHealth.actorIds;
    const commentCounts = await fetchMetaMediaCommentCounts(config, tokenRow.token, [...media.keys()], fetchImpl);
    const cutoffMs = now - Math.max(1, Number(env.META_ADS_POLL_LOOKBACK_HOURS || 72)) * 3600_000;
    const maxPages = Math.max(1, Math.min(10, Number(env.META_ADS_POLL_MAX_PAGES || 3)));
    const concurrency = Math.max(1, Math.min(12, Number(env.META_ADS_POLL_CONCURRENCY || 8)));
    const events = [];
    let scannedMedia = 0;
    const pendingMedia = [...media].filter(([mediaId]) => commentCounts.get(mediaId) !== 0);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, pendingMedia.length) }, async () => {
      while (cursor < pendingMedia.length) {
        const [mediaId, ad] = pendingMedia[cursor];
        cursor += 1;
        // Dark-ad media는 comments_count를 생략할 수 있다. 명시적 0만 스킵하고
        // 미상(null)은 실제 comments edge를 열어 미탐을 막는다.
        const comments = await fetchRecentMetaMediaComments(config, tokenRow.token, mediaId, { cutoffMs, maxPages }, fetchImpl);
        scannedMedia += 1;
        events.push(...comments.map((comment) => ({
          ...comment,
          ig_user_id: 'poll',
          original_media_id: null,
          ad_id: ad.adId,
          ad_title: ad.adTitle || null,
        })));
      }
    }));
    const storedResult = await storePolledEvents(config, events, fetchImpl);
    const insertedIds = new Set(storedResult.commentIds);
    let storedManaged = 0;
    let storedPartner = 0;
    let storedUnknownActor = Math.max(0, storedResult.count - insertedIds.size);
    for (const event of events) {
      if (!insertedIds.has(String(event.comment_id || ''))) continue;
      const actorId = String(media.get(String(event.media_id || ''))?.actorId || '');
      if (!actorId) storedUnknownActor += 1;
      else if (managedActorIds.has(actorId)) storedManaged += 1;
      else storedPartner += 1;
    }
    return {
      adsMedia: media.size,
      positiveCommentMedia: [...commentCounts.values()].filter((count) => Number(count) > 0).length,
      unknownCommentMedia: [...media.keys()].filter((mediaId) => commentCounts.get(mediaId) == null).length,
      scannedMedia,
      comments: events.length,
      stored: storedResult.count,
      storedManaged,
      storedPartner,
      storedUnknownActor,
      managedPages: webhookHealth.managedPages,
      managedInstagramAccounts: webhookHealth.managedInstagramAccounts,
      subscribedPages: webhookHealth.subscribedPages,
      subscriptionErrors: webhookHealth.subscriptionErrors,
      missingPermissions: webhookHealth.missingPermissions,
    };
  } catch (error) {
    if (!force) await releasePollBlock(config, runKey, fetchImpl);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  pollMetaAdComments()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
