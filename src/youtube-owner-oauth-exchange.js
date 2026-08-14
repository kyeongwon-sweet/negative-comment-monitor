import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { saveMetaToken } from './meta-token.js';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadYouTubeOwnerOAuthConfig(env = process.env) {
  return {
    googleClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    authorizationCode: required(env, 'YOUTUBE_OWNER_AUTH_CODE'),
    redirectUri: String(env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682').trim(),
    expectedChannelId: required(env, 'YOUTUBE_OWNER_EXPECTED_CHANNEL_ID'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
  };
}

async function safeJson(response) {
  return response.json().catch(() => ({}));
}

export async function exchangeAndStoreYouTubeOwnerToken(config, fetchImpl = fetch, now = Date.now()) {
  const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      code: config.authorizationCode,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const token = await safeJson(tokenResponse);
  if (!tokenResponse.ok || !token.access_token || !token.refresh_token) {
    throw new Error(`YouTube owner OAuth exchange failed (${tokenResponse.status}): ${String(token.error || 'missing token').slice(0, 100)}`);
  }

  const channelResponse = await fetchImpl(
    'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true&maxResults=50',
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  const channelPayload = await safeJson(channelResponse);
  if (!channelResponse.ok) throw new Error(`YouTube owner verification failed (${channelResponse.status})`);
  const channels = Array.isArray(channelPayload.items) ? channelPayload.items : [];
  const channel = channels.find((item) => String(item.id) === String(config.expectedChannelId));
  if (!channel) {
    const ids = channels.map((item) => String(item.id || '')).filter(Boolean).join(',') || 'none';
    throw new Error(`OAuth channel mismatch: expected ${config.expectedChannelId}, received ${ids}`);
  }

  const expiresInSec = Number(token.refresh_token_expires_in) > 0
    ? Number(token.refresh_token_expires_in)
    : 180 * 24 * 60 * 60;
  const kind = `youtube_owner:${channel.id}`;
  const expiresAt = await saveMetaToken(config, kind, token.refresh_token, expiresInSec, fetchImpl, now);
  return { channelId: channel.id, channelTitle: String(channel.snippet?.title || ''), tokenKind: kind, expiresAt };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  exchangeAndStoreYouTubeOwnerToken(loadYouTubeOwnerOAuthConfig())
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
