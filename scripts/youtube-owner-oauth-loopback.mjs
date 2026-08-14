import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const redirectUri = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://127.0.0.1:53682').trim();
const expectedState = String(process.env.GOOGLE_OAUTH_STATE || '').trim();
const outputPath = String(process.env.GOOGLE_OAUTH_OUTPUT || path.join(tmpdir(), 'negative-comment-youtube-owner-oauth.json')).trim();
const redirect = new URL(redirectUri);

if (!expectedState) throw new Error('GOOGLE_OAUTH_STATE is required');

const server = createServer(async (request, response) => {
  const incoming = new URL(request.url || '/', redirectUri);
  if (incoming.pathname !== redirect.pathname) {
    response.writeHead(404).end('Not found');
    return;
  }
  const code = incoming.searchParams.get('code') || '';
  const state = incoming.searchParams.get('state') || '';
  const error = incoming.searchParams.get('error') || '';
  if (state !== expectedState || (!code && !error)) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OAuth callback validation failed.');
    return;
  }
  await writeFile(outputPath, JSON.stringify({ code, error, redirectUri }), { encoding: 'utf8', mode: 0o600 });
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><meta charset="utf-8"><title>인증 완료</title><h1>인증 정보를 받았습니다.</h1><p>이 창을 닫고 Codex로 돌아가세요.</p>');
  console.log('[youtube-owner-oauth] callback received');
  server.close();
});

server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  console.log(`[youtube-owner-oauth] listening on ${redirectUri}`);
});
