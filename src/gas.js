function endpoint(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`GAS HTTP ${response.status}: ${text.slice(0, 300)}`);
  const payload = JSON.parse(text);
  if (payload.ok === false) throw new Error(payload.error || 'GAS request failed');
  return payload;
}

export async function fetchTargets(config, fetchImpl = fetch) {
  const url = endpoint(config.gasWebAppUrl, {
    action: 'sponsoredTargets',
    key: config.gasVerifyToken,
    limit: config.targetBatchSize,
  });
  const response = await fetchImpl(url, { method: 'GET', redirect: 'follow' });
  const payload = await readJson(response);
  return payload.result?.targets || [];
}

export async function submitResult(config, target, comments, error = '', fetchImpl = fetch) {
  if (config.dryRun) return { dryRun: true, url: target.url, comments: comments.length };
  const url = endpoint(config.gasWebAppUrl, {
    action: 'sponsoredRpaResult',
    key: config.gasVerifyToken,
  });
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      row: target.row,
      url: target.url,
      channelName: target.channelName || '',
      platform: target.platform,
      collector: 'APIFY',
      slackChannelId: config.slackChannelId,
      channelCategory: target.channelCategory || '',
      comments,
      error,
    }),
  });
  return readJson(response);
}
