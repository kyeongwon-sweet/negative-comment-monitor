import { createHash } from 'node:crypto';
import { extractPostKey } from './delta.js';

export function commentFingerprint(target, comment) {
  const platform = String(comment.platform || target.platform || '').toLowerCase();
  // 다크 광고처럼 공개 게시물 URL이 없는 소스는 어댑터가 안정적인 네이티브 키를 제공한다.
  const post = String(target.postKey || '').trim() || extractPostKey(target.url) || String(target.url || '').trim();
  const commentId = String(comment.id || '').trim();
  const identity = commentId
    ? `${platform}|${post}|id:${commentId}`
    : `${platform}|${post}|fallback:${comment.username || ''}|${comment.timestamp || ''}|${comment.text || ''}`;
  return createHash('sha256').update(identity).digest('hex');
}

function headers(config, extra = {}) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...extra,
  };
}

export async function loadSeenFingerprints(config, fingerprints, fetchImpl = fetch) {
  const unique = [...new Set(fingerprints.filter(Boolean))];
  if (!unique.length) return new Set();
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('Deduplication requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  const encoded = unique.map((value) => `"${value}"`).join(',');
  const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts?select=fingerprint&fingerprint=in.(${encodeURIComponent(encoded)})`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Dedup GET ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return new Set((await response.json()).map((row) => row.fingerprint));
}

export async function loadRecentlyAlertedPostKeys(config, sinceMs = 3 * 60 * 60 * 1000, fetchImpl = fetch, now = Date.now()) {
  if (!config.supabaseUrl || !config.supabaseKey) return new Map();
  const cutoff = encodeURIComponent(new Date(now - sinceMs).toISOString());
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/negative_comment_alerts?select=post_url,alerted_at&alerted_at=gte.${cutoff}&order=alerted_at.desc`,
    { headers: headers(config) },
  );
  if (!response.ok) throw new Error(`Recent alerts GET ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const result = new Map();
  for (const row of await response.json()) {
    const key = extractPostKey(row.post_url);
    if (key && !result.has(key)) result.set(key, row.alerted_at);
  }
  return result;
}

export async function recordAlert(config, target, comment, fingerprint, slackTs = '', classifierHash = null, fetchImpl = fetch) {
  const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts?on_conflict=fingerprint`;
  const payload = {
    fingerprint,
    platform: String(comment.platform || target.platform || ''),
    post_url: String(target.url || ''),
    comment_id: String(comment.id || '') || null,
    comment_text: String(comment.text || ''),
    slack_channel_id: String(config.slackChannelId || ''),
    slack_ts: String(slackTs || '') || null,
    classifier_hash: classifierHash || null,
    source: String(target.source || '') || null,
    meta_media_id: String(target.metaMediaId || '') || null,
    meta_ad_id: String(target.metaAdId || '') || null,
    category: String(comment.risk?.category || '') || null,
    reason: String(comment.risk?.reason || comment.risk?.matchedTerms?.join(', ') || '') || null,
    product_name: String(target.productName || '') || null,
    channel_category: String(target.channelCategory || '') || null,
    channel_name: String(target.channelName || '') || null,
    asset_name: String(target.assetName || target.adTitle || '') || null,
    comment_timestamp: String(comment.timestamp || '') || null,
    author_channel_id: String(comment.authorChannelId || '') || null,
    author_display_name: String(comment.authorDisplayName || comment.username || '') || null,
  };
  const request = (body) => fetchImpl(url, {
    method: 'POST',
    headers: headers(config, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    }),
    body: JSON.stringify(body),
  });
  let response = await request(payload);
  if (!response.ok) {
    const text = await response.text();
    // 마이그레이션과 애플리케이션 배포 사이 짧은 순서 차이에도 핵심 알림이 죽지
    // 않도록, 새 작성자 컬럼이 아직 없을 때만 구형 payload로 1회 fail-open한다.
    // 다른 4xx/5xx는 중복 삽입 위험을 피하려고 그대로 실패시킨다.
    if (response.status === 400 && /author_(?:channel_id|display_name)/i.test(text)) {
      const legacy = { ...payload };
      delete legacy.author_channel_id;
      delete legacy.author_display_name;
      response = await request(legacy);
      if (!response.ok) throw new Error(`Dedup POST ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } else {
      throw new Error(`Dedup POST ${response.status}: ${text.slice(0, 200)}`);
    }
  }
  const rows = typeof response.json === 'function' ? await response.json() : [];
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
