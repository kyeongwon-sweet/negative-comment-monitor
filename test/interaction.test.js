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
