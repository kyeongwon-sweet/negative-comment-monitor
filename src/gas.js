function endpoint(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`GAS HTTP ${response.status}: ${text.slice(0, 300)}`);
  // GAS는 스크립트 예외 시 200 + HTML 오류 페이지를 반환한다(예: 시트 헤더 누락으로 throw).
  // 그대로 JSON.parse하면 "Unexpected token '<'"라는 암호 같은 오류만 남아 진단이 늦다.
  // → HTML을 감지해 실제 원인(errorMessage)을 담은 명확한 오류로 바꿔 던진다(로그/알림 즉시 진단).
  if (text.trimStart().startsWith('<')) {
    const m = text.match(/errorMessage[^>]*>([\s\S]*?)<\/div>/);
    const detail = (m ? m[1] : text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`GAS가 JSON 대신 오류 페이지 반환(시트 헤더 누락 등 스크립트 오류 가능): ${detail}`);
  }
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
