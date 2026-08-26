import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOwnerOAuthCoverageMessage,
  monitorOwnerOAuthCoverage,
  summarizeOwnerOAuthCoverage,
} from '../src/youtube-owner-coverage.js';

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

test('OAuth coverage summary uses all configured channels as denominator', () => {
  const coverage = summarizeOwnerOAuthCoverage({
    totalConfiguredChannels: 10,
    authenticatedChannels: 2,
    missingOAuthChannels: [{ name: '썰박스' }, { name: '썰뜨기' }],
  });
  assert.deepEqual(coverage, {
    configured: 10,
    authenticated: 2,
    missing: 8,
    missingChannels: [{ name: '썰박스' }, { name: '썰뜨기' }],
    complete: false,
  });
  assert.match(buildOwnerOAuthCoverageMessage(coverage, { slackAssignees: { other: 'U_OWNER' } }), /인증 채널: 2\/10/);
  assert.match(buildOwnerOAuthCoverageMessage(coverage), /썰박스·썰뜨기/);
});

test('missing OAuth posts a cooldown-protected warning but stays fail-soft', async () => {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.hostname === 'db.test' && options.method !== 'POST') return json([]);
    if (url.hostname === 'db.test' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return json([{ ...body, last_alerted_at: body.last_alerted_at }], 201);
    }
    if (url.hostname === 'slack.com') return json({ ok: true, ts: '1' });
    throw new Error(`unexpected ${url}`);
  };
  const config = {
    supabaseUrl: 'https://db.test', supabaseKey: 'svc',
    slackBotToken: 'slack', slackChannelId: 'C1', slackAssignees: { other: 'U1' },
    youtubeOwnerCoverageAlertCooldownHours: 168,
  };
  const result = await monitorOwnerOAuthCoverage(config, {
    totalConfiguredChannels: 2,
    authenticatedChannels: 1,
    configuredOwners: 1,
    missingOAuthChannels: [{ name: '미연결', channelId: 'missing' }],
  }, fetchImpl, Date.parse('2026-08-26T00:00:00Z'));

  assert.equal(result.alerted, true);
  assert.equal(result.missing, 1);
  assert.equal(calls.filter((call) => call.url.hostname === 'slack.com').length, 1);
});
