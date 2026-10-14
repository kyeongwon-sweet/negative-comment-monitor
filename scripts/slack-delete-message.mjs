function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function slackCall(method, token, body, fetchImpl) {
  const response = await fetchImpl(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`${method} failed: ${payload.error || response.status}`);
  }
  return payload;
}

export async function deleteSlackMessage(env = process.env, fetchImpl = fetch) {
  const token = required(env, 'SLACK_BOT_TOKEN');
  const channel = required(env, 'SLACK_DELETE_CHANNEL_ID');
  const ts = required(env, 'SLACK_DELETE_MESSAGE_TS');
  const expectedText = required(env, 'SLACK_DELETE_EXPECTED_TEXT');
  const expectedConfirm = `DELETE ${channel} ${ts}`;
  if (String(env.SLACK_DELETE_CONFIRM || '').trim() !== expectedConfirm) {
    throw new Error(`confirmation mismatch; expected: ${expectedConfirm}`);
  }

  const auth = await slackCall('auth.test', token, {}, fetchImpl);
  const history = await slackCall('conversations.history', token, {
    channel,
    oldest: ts,
    latest: ts,
    inclusive: true,
    limit: 1,
  }, fetchImpl);
  const message = (history.messages || []).find((item) => String(item.ts) === ts);
  if (!message) throw new Error('target Slack message not found');
  if (!String(message.text || '').includes(expectedText)) {
    throw new Error('target Slack message text guard failed');
  }
  if (auth.bot_id && message.bot_id !== auth.bot_id) {
    throw new Error(`target was not authored by the authenticated bot (${auth.bot_id})`);
  }
  if (!auth.bot_id && auth.user_id && message.user !== auth.user_id) {
    throw new Error(`target was not authored by the authenticated user (${auth.user_id})`);
  }

  await slackCall('chat.delete', token, { channel, ts }, fetchImpl);
  const after = await slackCall('conversations.history', token, {
    channel,
    oldest: ts,
    latest: ts,
    inclusive: true,
    limit: 1,
  }, fetchImpl);
  if ((after.messages || []).some((item) => String(item.ts) === ts)) {
    throw new Error('Slack deletion verification failed');
  }
  return { ok: true, channel, ts };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  deleteSlackMessage()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
