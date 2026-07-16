const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ageMs(target, now) {
  const published = Date.parse(target.publishedAt || target.postedAt || target.createdAt || '');
  return Number.isFinite(published) ? Math.max(0, now - published) : Infinity;
}

export function collectionIntervalMs(target, now = Date.now()) {
  if (target.collector === 'graph-webhook') return Infinity;
  if (target.recentNegativeDetectedAt) {
    const detectedAge = now - Date.parse(target.recentNegativeDetectedAt);
    if (Number.isFinite(detectedAge) && detectedAge <= 3 * HOUR) return 15 * MINUTE;
  }
  const age = ageMs(target, now);
  if (target.isBoosted || age <= 7 * DAY) return HOUR;
  if (age <= 30 * DAY) return 6 * HOUR;
  return DAY;
}

export function isCollectionDue(target, now = Date.now()) {
  const interval = collectionIntervalMs(target, now);
  if (!Number.isFinite(interval)) return false;
  const last = Date.parse(target.lastCollectedAt || '');
  return !Number.isFinite(last) || now - last >= interval;
}

export function filterDueTargets(targets, now = Date.now()) {
  return targets.filter((target) => isCollectionDue(target, now));
}
