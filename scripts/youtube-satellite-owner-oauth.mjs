import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { exchangeAndStoreYouTubeOwnerToken } from '../src/youtube-owner-oauth-exchange.js';
import {
  buildYouTubeOwnerAuthorizationUrl,
  resolveSatelliteChannel,
  YOUTUBE_SATELLITE_CHANNELS,
} from '../src/youtube-satellite-oauth.js';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const requested = String(process.env.YOUTUBE_SATELLITE_CHANNEL || process.argv[2] || '').trim();
const channel = resolveSatelliteChannel(requested);
if (!channel) {
  throw new Error(`YOUTUBE_SATELLITE_CHANNEL must be one of: ${YOUTUBE_SATELLITE_CHANNELS.map((item) => item.name).join(', ')}`);
}

const redirectUri = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682').trim();
const redirect = new URL(redirectUri);
const state = randomBytes(24).toString('hex');
const clientId = required('GOOGLE_ADS_CLIENT_ID');
const configBase = {
  googleClientId: clientId,
  googleClientSecret: required('GOOGLE_ADS_CLIENT_SECRET'),
  redirectUri,
  expectedChannelId: channel.channelId,
  supabaseUrl: required('SUPABASE_URL').replace(/\/$/, ''),
  supabaseKey: required('SUPABASE_SERVICE_ROLE_KEY'),
};
const authorizationUrl = buildYouTubeOwnerAuthorizationUrl({ clientId, redirectUri, state });

let settled = false;
const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  server.close();
  console.error('[youtube-satellite-oauth] timed out waiting for consent');
  process.exitCode = 1;
}, 10 * 60 * 1000);

const server = createServer(async (request, response) => {
  const incoming = new URL(request.url || '/', redirectUri);
  if (incoming.pathname !== redirect.pathname) {
    response.writeHead(404).end('Not found');
    return;
  }
  if (settled) {
    response.writeHead(409).end('OAuth session already completed');
    return;
  }
  const code = incoming.searchParams.get('code') || '';
  const returnedState = incoming.searchParams.get('state') || '';
  const oauthError = incoming.searchParams.get('error') || '';
  if (returnedState !== state || (!code && !oauthError)) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OAuth callback validation failed.');
    return;
  }
  settled = true;
  clearTimeout(timeout);
  try {
    if (oauthError) throw new Error(`Google OAuth denied: ${oauthError}`);
    const result = await exchangeAndStoreYouTubeOwnerToken({ ...configBase, authorizationCode: code });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>인증 완료</title><h1>YouTube 채널 인증이 완료되었습니다.</h1><p>이 창을 닫고 Codex로 돌아가세요.</p>');
    console.log(JSON.stringify({ ok: true, requested: channel.name, channelId: result.channelId, channelTitle: result.channelTitle, expiresAt: result.expiresAt }));
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('YouTube 채널 인증에 실패했습니다. Codex에서 오류를 확인하세요.');
    console.error(`[youtube-satellite-oauth] ${error.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  console.log(`[youtube-satellite-oauth] channel=${channel.name} ${channel.handle} expected=${channel.channelId}`);
  console.log(`[youtube-satellite-oauth] open this URL and consent with that channel's owner/manager account:\n${authorizationUrl}`);
});
