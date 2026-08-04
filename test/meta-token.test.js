import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeLongLivedToken, ensureFreshToken, saveMetaToken } from '../src/meta-token.js';

const CFG = { supabaseUrl: 'https://db.example', supabaseKey: 'svc' };

test('exchangeLongLivedToken: fb_exchange_token 호출 + expires_in 파싱', async () => {
  let calledUrl = '';
  const fetchImpl = async (url) => {
    calledUrl = String(url);
    return { ok: true, text: async () => JSON.stringify({ access_token: 'LONG', expires_in: 5184000 }) };
  };
  const out = await exchangeLongLivedToken({ token: 'SHORT', appId: 'APP', appSecret: 'SEC' }, fetchImpl);
  assert.equal(out.token, 'LONG');
  assert.equal(out.expiresInSec, 5184000);
  assert.match(calledUrl, /grant_type=fb_exchange_token/);
  assert.match(calledUrl, /fb_exchange_token=SHORT/);
  assert.match(calledUrl, /client_id=APP/);
});

test('exchangeLongLivedToken: 실패 시 토큰/시크릿 없이 상태코드+메시지만', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'bad token' } }) });
  await assert.rejects(
    () => exchangeLongLivedToken({ token: 'x', appId: 'a', appSecret: 'SECRETVAL' }, fetchImpl),
    (e) => e.message.includes('400') && e.message.includes('bad token') && !e.message.includes('SECRETVAL'),
  );
});

test('exchangeLongLivedToken: 인자 누락 시 에러', async () => {
  await assert.rejects(() => exchangeLongLivedToken({ token: '', appId: 'a', appSecret: 'b' }, async () => ({})));
});

test('ensureFreshToken: 만료 여유 있으면 갱신 안 함', async () => {
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  const fetchImpl = async (url) => {
    if (/meta_tokens/.test(String(url))) return { ok: true, json: async () => [{ token: 'CUR', expires_at: future }] };
    throw new Error('교환 호출되면 안 됨');
  };
  const out = await ensureFreshToken(CFG, { kind: 'ig_ads', appId: 'a', appSecret: 'b' }, fetchImpl);
  assert.equal(out.refreshed, false);
  assert.equal(out.token, 'CUR');
});

test('ensureFreshToken: 만료 임박이면 재교환 + 저장', async () => {
  const soon = new Date(Date.now() + 2 * 864e5).toISOString(); // 2일 뒤 → 7일 임계 이내
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (/meta_tokens/.test(u) && (!opts || (opts.method || 'GET') === 'GET')) {
      return { ok: true, json: async () => [{ token: 'OLD', expires_at: soon }] };
    }
    if (/oauth\/access_token/.test(u)) {
      calls.push('exchange');
      return { ok: true, text: async () => JSON.stringify({ access_token: 'NEW', expires_in: 5184000 }) };
    }
    if (/meta_tokens/.test(u) && opts.method === 'POST') { calls.push('save'); return { ok: true, text: async () => '' }; }
    throw new Error('unexpected ' + u);
  };
  const out = await ensureFreshToken(CFG, { kind: 'ig_ads', appId: 'a', appSecret: 'b' }, fetchImpl);
  assert.equal(out.refreshed, true);
  assert.equal(out.token, 'NEW');
  assert.deepEqual(calls, ['exchange', 'save']);
});

test('ensureFreshToken: 저장된 토큰 없으면 명확한 에러', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  await assert.rejects(() => ensureFreshToken(CFG, { kind: 'ig_ads', appId: 'a', appSecret: 'b' }, fetchImpl), /토큰 없음/);
});

test('saveMetaToken: expires_at을 now+expiresIn으로 upsert', async () => {
  let body = null;
  const fetchImpl = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, text: async () => '' }; };
  const now = Date.parse('2026-08-04T00:00:00Z');
  const expiresAt = await saveMetaToken(CFG, 'ig_ads', 'TKN', 5184000, fetchImpl, now);
  assert.equal(body.kind, 'ig_ads');
  assert.equal(body.token, 'TKN');
  assert.equal(expiresAt, new Date(now + 5184000 * 1000).toISOString());
});
