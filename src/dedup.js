import { createHash } from 'node:crypto';
import { extractPostKey } from './delta.js';

export function commentFingerprint(target, comment) {
  const platform = String(comment.platform || target.platform || '').toLowerCase();
  const post = extractPostKey(target.url) || String(target.url || '').trim();
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

export async function recordAlert(config, target, comment, fingerprint, slackTs = '', fetchImpl = fetch) {
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/negative_comment_alerts?on_conflict=fingerprint`, {
    method: 'POST',
    headers: headers(config, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    }),
    body: JSON.stringify({
      fingerprint,
      platform: String(comment.platform || target.platform || ''),
      post_url: String(target.url || ''),
      comment_id: String(comment.id || '') || null,
      comment_text: String(comment.text || ''),
      slack_channel_id: String(config.slackChannelId || ''),
      slack_ts: String(slackTs || '') || null,
    }),
  });
  if (!response.ok) throw new Error(`Dedup POST ${response.status}: ${(await response.text()).slice(0, 200)}`);
}
