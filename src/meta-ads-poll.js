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
  const fields = 'id,name,updated_time,creative{effective_instagram_media_id,source_instagram_media_id}';
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
      if (!adId || isConversionAd(adTitle)) continue;
      for (const raw of [ad.creative?.effective_instagram_media_id, ad.creative?.source_instagram_media_id]) {
        const mediaId = String(raw || '');
        if (mediaId && !byMedia.has(mediaId)) byMedia.set(mediaId, { adId, adTitle });
      }
    }
    next = String(payload.paging?.next || '');
  }
  return byMedia;
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
  if (!events.length) return 0;
  let stored = 0;
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
  }
  return stored;
}

export async function pollMetaAdComments(config = loadMetaAdsConfig(), fetchImpl = fetch, now = Date.now(), env = process.env) {
  const intervalMinutes = Math.max(15, Number(env.META_ADS_POLL_INTERVAL_MINUTES || 60));
  const runKey = metaPollBlockKey(now, intervalMinutes);
  const force = String(env.META_ADS_POLL_FORCE || '').toLowerCase() === 'true';
  if (!force && !(await claimPollBlock(config, runKey, now, fetchImpl))) return { skipped: 'already-polled', stored: 0 };
  try {
    const tokenRow = await loadMetaToken(config, config.metaTokenKind || 'ig_ads', fetchImpl);
    if (!tokenRow?.token) throw new Error('Meta poll token not found');
    const media = await fetchMetaAdMedia(config, tokenRow.token, requiredAccount(env), fetchImpl);
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
    const stored = await storePolledEvents(config, events, fetchImpl);
    return {
      adsMedia: media.size,
      positiveCommentMedia: [...commentCounts.values()].filter((count) => Number(count) > 0).length,
      unknownCommentMedia: [...media.keys()].filter((mediaId) => commentCounts.get(mediaId) == null).length,
      scannedMedia,
      comments: events.length,
      stored,
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
