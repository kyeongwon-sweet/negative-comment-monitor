import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildYouTubeOwnerAuthorizationUrl,
  resolveSatelliteChannel,
  YOUTUBE_SATELLITE_CHANNELS,
} from '../src/youtube-satellite-oauth.js';

const requested = String(process.env.YOUTUBE_SATELLITE_CHANNEL || process.argv[2] || '').trim();
const channel = resolveSatelliteChannel(requested);
if (!channel) {
  throw new Error(`YOUTUBE_SATELLITE_CHANNEL must be one of: ${YOUTUBE_SATELLITE_CHANNELS.map((item) => item.name).join(', ')}`);
}

const redirectUri = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682').trim();
const redirect = new URL(redirectUri);
const state = randomBytes(24).toString('hex');
// OAuth client ID는 공개 식별자이며 기존 소유채널 인증에 사용한 GCP Desktop client다.
// client secret·Supabase service role은 로컬로 내리지 않고 GitHub Actions에서만 사용한다.
const clientId = String(process.env.GOOGLE_ADS_CLIENT_ID
  || '992272573531-namdimvufsbha2sgvft62vf56k2lv3mu.apps.googleusercontent.com').trim();
const outputPath = String(process.env.YOUTUBE_OWNER_OAUTH_CAPTURE
  || path.join(tmpdir(), 'negative-comment-youtube-satellite-oauth.json')).trim();
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
    await writeFile(outputPath, JSON.stringify({
      code,
      redirectUri,
      expectedChannelId: channel.channelId,
      requested: channel.name,
      capturedAt: new Date().toISOString(),
    }), { encoding: 'utf8', mode: 0o600 });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>동의 완료</title><h1>YouTube 채널 동의가 완료되었습니다.</h1><p>이 창을 닫고 Codex로 돌아가세요. 토큰 저장은 Codex가 안전하게 마무리합니다.</p>');
    console.log(JSON.stringify({ ok: true, requested: channel.name, expectedChannelId: channel.channelId, captureReady: true }));
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
