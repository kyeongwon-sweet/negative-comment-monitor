import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { saveMetaToken } from './meta-token.js';

const ALLOWED_TARGETS = new Set(['google_ads', 'youtube_ads']);

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadGoogleOAuthRefreshExchangeConfig(env = process.env) {
  const target = required(env, 'GOOGLE_OAUTH_TARGET').toLowerCase();
  if (!ALLOWED_TARGETS.has(target)) throw new Error('GOOGLE_OAUTH_TARGET must be google_ads or youtube_ads');
  return {
    target,
    tokenKind: `oauth_ephemeral:${target}`,
    clientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    clientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    authorizationCode: required(env, 'GOOGLE_OAUTH_AUTH_CODE'),
    redirectUri: String(env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682').trim(),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
  };
}

export async function exchangeAndStageGoogleRefreshToken(config, fetchImpl = fetch, now = Date.now()) {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: config.authorizationCode,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.refresh_token) {
    throw new Error(`Google OAuth exchange failed (${response.status}): ${String(payload.error || 'missing refresh token').slice(0, 100)}`);
  }

  // Supabase is only a short-lived handoff. The local promoter copies the token to the
  // final GitHub secret and deletes this row immediately, without printing the token.
  const expiresAt = await saveMetaToken(config, config.tokenKind, payload.refresh_token, 24 * 60 * 60, fetchImpl, now);
  return { target: config.target, tokenKind: config.tokenKind, expiresAt };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  exchangeAndStageGoogleRefreshToken(loadGoogleOAuthRefreshExchangeConfig())
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
