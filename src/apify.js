const API = 'https://api.apify.com/v2';

async function apifyJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`Apify HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function actorUrl(actorId, token) {
  return `${API}/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}`;
}

function deepInputOverrides(platform, commentLimit) {
  const limit = Number.isFinite(Number(commentLimit)) ? Number(commentLimit) : 100;
  if (platform === 'instagram') return { resultsLimit: limit, includeNestedComments: true };
  if (platform === 'youtube') return { maxComments: limit, oldestCommentDate: '14 days' };
  if (platform === 'tiktok') return { commentsPerPost: limit, maxRepliesPerComment: 15 };
  if (platform === 'twitter') return { maxItems: Math.max(limit, 10) };
  return {};
}

export function buildActorInput(platform, actorInput, targets, options = {}) {
  const urls = targets.map((target) => target.url);
  const extra = options.deepScan ? deepInputOverrides(platform, options.commentLimit) : {};
  if (platform === 'instagram') {
    return { resultsLimit: 10, includeNestedComments: false, ...actorInput, ...extra, directUrls: urls };
  }
  if (platform === 'youtube') {
    return {
      maxComments: 30,
      sortCommentsBy: 'NEWEST_FIRST',
      oldestCommentDate: '7 days',
      ...actorInput,
      ...extra,
      startUrls: urls.map((url) => ({ url })),
    };
  }
  if (platform === 'tiktok') {
    return { commentsPerPost: 30, maxRepliesPerComment: 0, ...actorInput, ...extra, postURLs: urls };
  }
  if (platform === 'twitter') {
    return { maxItems: Math.max(10, urls.length * 30), useSearch: false, ...actorInput, ...extra, startUrls: urls };
  }
  throw new Error(`Unsupported Apify platform: ${platform}`);
}

export async function runActor(config, platform, targets, fetchImpl = fetch, options = {}) {
  const actor = config.actors[platform];
  const input = buildActorInput(platform, actor.input, targets, options);
  const started = await apifyJson(actorUrl(actor.id, config.apifyApiToken), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, fetchImpl);
  const run = started.data;
  const deadline = Date.now() + config.runTimeoutMs;
  let status = run.status;

  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() >= deadline) throw new Error(`Apify ${platform} run timed out`);
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    const current = await apifyJson(`${API}/actor-runs/${run.id}?token=${encodeURIComponent(config.apifyApiToken)}`, {}, fetchImpl);
    status = current.data.status;
  }
  if (status !== 'SUCCEEDED') throw new Error(`Apify ${platform} run ended with ${status}`);

  const datasetId = run.defaultDatasetId;
  const dataset = await apifyJson(`${API}/datasets/${datasetId}/items?clean=true&format=json&token=${encodeURIComponent(config.apifyApiToken)}`, {}, fetchImpl);
  return Array.isArray(dataset) ? dataset : [];
}
