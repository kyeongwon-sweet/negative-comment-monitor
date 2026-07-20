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
  if (target.isBoosted || age <= 7 * DAY) return DAY;
  return Infinity;
}

function kstDateKey(timestamp) {
  return new Date(timestamp + 9 * HOUR).toISOString().slice(0, 10);
}

const DAILY_START_MIN = 9 * 60 + 10; // 09:10 KST

// 정규 일일 수집은 "그날 09:10 KST를 지났고 아직 오늘 안 걸렸으면" 도래한다.
// 예전엔 09:10~09:25 15분 창 안에 실행돼야만 도래했는데, GitHub 크론은 정시를
// 보장하지 않아(00시대 UTC 드롭 빈번) 창을 놓치면 그날 점검이 통째로 누락됐다.
// 마감(deadline) 방식으로 바꿔 회차가 지연돼도 그날 첫 실행이 한 번 잡게 한다.
// 하루 1회 보장은 kstDateKey(last) === kstDateKey(now) 멱등 가드가 담당한다.
function isPastDailyStart(now) {
  const kst = new Date(now + 9 * HOUR);
  const minute = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minute >= DAILY_START_MIN;
}

export function isCollectionDue(target, now = Date.now()) {
  const interval = collectionIntervalMs(target, now);
  if (!Number.isFinite(interval)) return false;
  const last = Date.parse(target.lastCollectedAt || '');
  if (interval === DAY) {
    if (Number.isFinite(last) && kstDateKey(last) === kstDateKey(now)) return false; // 오늘 이미 수집 → 멱등
    return isPastDailyStart(now); // 오늘 미수집이면 09:10 KST 지난 어느 회차든 1회 수집
  }
  return !Number.isFinite(last) || now - last >= interval;
}

export function filterDueTargets(targets, now = Date.now()) {
  return targets.filter((target) => isCollectionDue(target, now));
}
