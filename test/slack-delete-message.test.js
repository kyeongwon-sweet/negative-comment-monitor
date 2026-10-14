import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteSlackMessage } from '../scripts/slack-delete-message.mjs';

function response(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

test('guarded Slack deletion verifies author, text, exact ts, and absence afterwards', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === 'auth.test') return response({ ok: true, bot_id: 'B_INJI' });
    if (method === 'conversations.history' && calls.filter((call) => call.method === method).length === 1) {
      return response({ ok: true, messages: [{ ts: '1791955024.862959', bot_id: 'B_INJI', text: '부정댓글 모니터링 실행 실패' }] });
    }
    if (method === 'chat.delete') return response({ ok: true });
    return response({ ok: true, messages: [] });
  };

  const result = await deleteSlackMessage({
    SLACK_BOT_TOKEN: 'token',
    SLACK_DELETE_CHANNEL_ID: 'C0BHD9S69JA',
    SLACK_DELETE_MESSAGE_TS: '1791955024.862959',
    SLACK_DELETE_EXPECTED_TEXT: '부정댓글 모니터링 실행 실패',
    SLACK_DELETE_CONFIRM: 'DELETE C0BHD9S69JA 1791955024.862959',
  }, fetchImpl);

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.method), [
    'auth.test',
    'conversations.history',
    'chat.delete',
    'conversations.history',
  ]);
});

test('guarded Slack deletion refuses a different bot author', async () => {
  const fetchImpl = async (url) => {
    const method = String(url).split('/').at(-1);
    if (method === 'auth.test') return response({ ok: true, bot_id: 'B_INJI' });
    return response({ ok: true, messages: [{ ts: '1.2', bot_id: 'B_OTHER', text: 'expected' }] });
  };
  await assert.rejects(
    deleteSlackMessage({
      SLACK_BOT_TOKEN: 'token',
      SLACK_DELETE_CHANNEL_ID: 'C1',
      SLACK_DELETE_MESSAGE_TS: '1.2',
      SLACK_DELETE_EXPECTED_TEXT: 'expected',
      SLACK_DELETE_CONFIRM: 'DELETE C1 1.2',
    }, fetchImpl),
    /not authored/,
  );
});
