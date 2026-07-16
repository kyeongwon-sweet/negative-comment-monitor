import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAnthropic } from '../src/verify-anthropic.js';

test('verifies Anthropic without exposing the API key', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ id: 'msg_test', model: 'claude-haiku-4-5-20251001' }) };
  };
  const result = await verifyAnthropic({ ANTHROPIC_API_KEY: 'secret-key' }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(request.options.headers['x-api-key'], 'secret-key');
  assert.equal(JSON.parse(request.options.body).max_tokens, 8);
});

test('rejects missing Anthropic configuration', async () => {
  await assert.rejects(() => verifyAnthropic({}, async () => {}), /not configured/);
});
