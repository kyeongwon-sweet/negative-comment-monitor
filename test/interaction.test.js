import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleSlackInteraction } from '../src/interaction.js';

test('forwards a verified action to GAS and updates the Slack message', async () => {
  const secret = 'secret'; const timestamp = '1000';
  const payload = { user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '1.2', blocks: [{ type: 'actions' }] }, actions: [{ action_id: 'complete', value: JSON.stringify({ row: 7, commentId: 'c1' }) }] };
  const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return new Response(JSON.stringify({ ok: true, ts: '1.2' })); };
  const request = new Request('https://example.com/slack/actions', { method: 'POST', headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature, 'content-type': 'application/x-www-form-urlencoded' }, body: rawBody });
  const response = await handleSlackInteraction({ slackSigningSecret: secret, slackBotToken: 'token', gasWebAppUrl: 'https://example.com/gas', gasVerifyToken: 'key' }, request, fetchImpl, 1000 * 1000);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.decision, 'complete');
  assert.match(calls[1].url, /chat\.update/);
});

test('rejects an invalid Slack signature', async () => {
  const request = new Request('https://example.com/slack/actions', { method: 'POST', headers: { 'x-slack-request-timestamp': '1000', 'x-slack-signature': 'v0=bad' }, body: 'payload={}' });
  const response = await handleSlackInteraction({ slackSigningSecret: 'secret' }, request, async () => { throw new Error('must not call'); }, 1000 * 1000);
  assert.equal(response.status, 401);
});

function signedRequest(payload, secret = 'secret', timestamp = '1000') {
  const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  return new Request('https://example.com/slack/actions', { method: 'POST', headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature, 'content-type': 'application/x-www-form-urlencoded' }, body: rawBody });
}

const REVIEW_CFG = { slackSigningSecret: 'secret', slackBotToken: 'token', gasWebAppUrl: 'https://example.com/gas', gasVerifyToken: 'key', supabaseUrl: 'https://db.example', supabaseKey: 'svc' };

test('[무시] 클릭 → GAS 갱신 + false_positive 기록(slack_channel_id+slack_ts) + 사유 선택 노출', async () => {
  const payload = { user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '1.2', blocks: [{ type: 'section' }, { type: 'actions' }] }, actions: [{ action_id: 'ignore', value: JSON.stringify({ row: 7, commentId: 'c1', platform: 'tiktok', url: 'https://t/1' }) }] };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (/negative_comment_alerts/.test(String(url))) return { ok: true, text: async () => '' };
    return new Response(JSON.stringify({ ok: true, ts: '1.2' }));
  };
  const response = await handleSlackInteraction(REVIEW_CFG, signedRequest(payload), fetchImpl, 1000 * 1000);
  assert.equal(response.status, 200);
  const gas = calls.find((c) => /\/gas/.test(c.url));
  assert.equal(JSON.parse(gas.body).decision, 'ignore');
  const fp = calls.find((c) => /negative_comment_alerts/.test(c.url));
  assert.ok(fp, 'false_positive PATCH 발생');
  assert.equal(fp.method, 'PATCH');
  assert.match(fp.url, /slack_channel_id=eq\.C1/);
  assert.match(fp.url, /slack_ts=eq\.1\.2/);
  assert.equal(JSON.parse(fp.body).review_decision, 'false_positive');
  // 메시지 업데이트 블록에 오탐 사유 static_select 포함
  const update = calls.find((c) => /chat\.update/.test(c.url));
  const blocks = JSON.parse(update.body).blocks;
  const hasSelect = blocks.some((b) => b.type === 'actions' && b.elements?.some((e) => e.action_id === 'fp_reason'));
  assert.equal(hasSelect, true);
});

test('오탐 사유(fp_reason) 선택 → GAS 호출 없이 사유만 갱신', async () => {
  const payload = { user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '1.2', blocks: [{ type: 'section' }] }, actions: [{ action_id: 'fp_reason', selected_option: { value: 'joke_meme' } }] };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (/negative_comment_alerts/.test(String(url))) return { ok: true, text: async () => '' };
    return new Response(JSON.stringify({ ok: true, ts: '1.2' }));
  };
  const response = await handleSlackInteraction(REVIEW_CFG, signedRequest(payload), fetchImpl, 1000 * 1000);
  assert.equal(response.status, 200);
  assert.equal(calls.some((c) => /\/gas/.test(c.url)), false, 'fp_reason은 GAS 호출 안 함');
  const fp = calls.find((c) => /negative_comment_alerts/.test(c.url));
  assert.equal(JSON.parse(fp.body).false_positive_reason, 'joke_meme');
});
