import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeAndStoreYouTubeOwnerToken } from '../src/youtube-owner-oauth-exchange.js';

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => '' };
}

test('인증 코드를 교환하고 예상 소유 채널 토큰만 저장한다', async () => {
  const calls = [];
  const config = {
    googleClientId: 'client', googleClientSecret: 'secret', authorizationCode: 'code',
    redirectUri: 'http://127.0.0.1:53682', expectedChannelId: 'UC_OWNER',
    supabaseUrl: 'https://db.test', supabaseKey: 'service',
  };
  const result = await exchangeAndStoreYouTubeOwnerToken(config, async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com')) return response(200, { access_token: 'access', refresh_token: 'refresh' });
    if (String(url).includes('youtube/v3/channels')) return response(200, { items: [{ id: 'UC_OWNER', snippet: { title: '소유채널' } }] });
    if (String(url).includes('meta_tokens')) return response(201);
    throw new Error(`unexpected ${url}`);
  }, Date.parse('2026-08-14T00:00:00Z'));
  assert.equal(result.channelId, 'UC_OWNER');
  assert.equal(result.tokenKind, 'youtube_owner:UC_OWNER');
  const stored = JSON.parse(calls.find((call) => call.url.includes('meta_tokens')).init.body);
  assert.equal(stored.token, 'refresh');
  assert.equal(stored.kind, 'youtube_owner:UC_OWNER');
});

test('선택 채널이 예상 채널과 다르면 저장하지 않는다', async () => {
  const config = {
    googleClientId: 'client', googleClientSecret: 'secret', authorizationCode: 'code',
    redirectUri: 'http://127.0.0.1:53682', expectedChannelId: 'UC_EXPECTED',
    supabaseUrl: 'https://db.test', supabaseKey: 'service',
  };
  await assert.rejects(
    exchangeAndStoreYouTubeOwnerToken(config, async (url) => {
      if (String(url).includes('oauth2.googleapis.com')) return response(200, { access_token: 'access', refresh_token: 'refresh' });
      return response(200, { items: [{ id: 'UC_OTHER', snippet: { title: '다른채널' } }] });
    }),
    /OAuth channel mismatch/,
  );
});
