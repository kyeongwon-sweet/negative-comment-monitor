// 인지 광고(메타·틱톡·유튜브) 댓글 source 집합. 단일 소스로 두고 slack(카드=제작자만 태그)과
// hybrid-classify(전 댓글 문맥판정=reviewAll)가 공유해 3플랫폼 동작을 통일한다. 신규 플랫폼은 여기만 추가.
export const AD_COMMENT_SOURCES = new Set(['meta_ads', 'tiktok_ads', 'youtube_ads']);
export function isAdCommentSource(target) {
  return AD_COMMENT_SOURCES.has(String(target?.source || ''));
}

export function detectPlatform(url) {
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'instagram.com') return 'instagram';
  if (host === 'youtube.com' || host === 'youtu.be') return 'youtube';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'twitter';
  throw new Error(`Unsupported platform URL: ${url}`);
}

export function chooseCollector(target) {
  const platform = String(target.platform || detectPlatform(target.url)).toLowerCase();
  const graphEligible = platform === 'instagram' && Boolean(target.isBoosted) && Boolean(target.isManagedAccount) && Boolean(target.mediaId);
  return graphEligible ? 'graph' : 'apify';
}

export function isEligibleSponsorship(target, excludedCategory = '무상시딩') {
  const url = String(target.url || '').trim();
  const category = String(target.channelCategory || target.channelClassification || '').trim();
  if (!url) return false;
  // A blank category cannot be proven to be outside the excluded category.
  // Skip it safely instead of aborting monitoring for every other valid target.
  if (!category) return false;
  return !category.toLowerCase().includes(String(excludedCategory).trim().toLowerCase());
}

export function filterEligibleSponsorships(targets, excludedCategory = '무상시딩') {
  return targets.filter((target) => isEligibleSponsorship(target, excludedCategory));
}

export function isManagedChannel(target, managedCategories = ['온드미디어', '위성채널']) {
  const category = String(target.channelCategory || target.channelClassification || '').trim().toLowerCase();
  return managedCategories.some((value) => category.includes(String(value).trim().toLowerCase()));
}

export function groupApifyTargets(targets) {
  const groups = { instagram: [], youtube: [], tiktok: [], twitter: [] };
  for (const target of targets) {
    if (chooseCollector(target) === 'graph') continue;
    const platform = String(target.platform || detectPlatform(target.url)).toLowerCase();
    groups[platform].push({ ...target, platform });
  }
  return groups;
}
