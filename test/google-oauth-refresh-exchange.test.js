import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exchangeAndStageGoogleRefreshToken,
  loadGoogleOAuthRefreshExchangeConfig,
} from '../src/google-oauth-refresh-exchange.js';

test('Google OAuth refresh exchange config allows only known destinations', () => {
  assert.equal(loadGoogleOAuthRefreshExchangeConfig({
    GOOGLE_OAUTH_TARGET: 'google_ads',
    GOOGLE_ADS_CLIENT_ID: 'id',
    GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_OAUTH_AUTH_CODE: 'code',
    SUPABASE_URL: 'https://db.test',
    SUPABASE_SERVICE_ROLE_KEY: 'key',
  }).tokenKind, 'oauth_ephemeral:google_ads');
  assert.throws(() => loadGoogleOAuthRefreshExchangeConfig({ GOOGLE_OAUTH_TARGET: 'other' }), /google_ads or youtube_ads/);
});

test('Google OAuth refresh exchange stages token without returning it', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh-secret' }), { status: 200 });
    }
    return new Response('', { status: 201 });
  };
  const result = await exchangeAndStageGoogleRefreshToken({
    target: 'youtube_ads',
    tokenKind: 'oauth_ephemeral:youtube_ads',
    clientId: 'id',
    clientSecret: 'secret',
    authorizationCode: 'code',
    redirectUri: 'http://127.0.0.1:53682',
    supabaseUrl: 'https://db.test',
    supabaseKey: 'key',
  }, fetchImpl, 0);
  assert.equal(result.target, 'youtube_ads');
  assert.equal('token' in result, false);
  assert.equal(requests.length, 2);
  assert.match(requests[1].options.body, /refresh-secret/);
});
