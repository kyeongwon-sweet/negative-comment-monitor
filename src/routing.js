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
  if (!category) throw new Error(`Target is missing channelCategory: ${url}`);
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
