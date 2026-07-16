export async function verifyAnthropic(env = process.env, fetchImpl = fetch) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  const model = String(env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured');
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic verification failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const payload = await response.json();
  if (!payload.id) throw new Error('Anthropic verification returned no message ID');
  return { ok: true, model: payload.model || model };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  verifyAnthropic()
    .then(({ model }) => console.log(`Anthropic API verified: ${model}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
