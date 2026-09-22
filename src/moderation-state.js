import { isAdCommentSource, isManagedChannel } from './routing.js';

export const MANUAL_HIDE_REQUIRED = 'manual_hide_required';
export const KEEP_REVIEW_DECISIONS = new Set(['approve', 'false_positive', 'ignore', 'unhide']);
export const UNRESOLVED_REVIEW_DECISIONS = new Set(['', 'hide', 'hold', MANUAL_HIDE_REQUIRED]);

function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isSponsorshipTarget(target) {
  return clean(target?.channelCategory ?? target?.channel_category).includes('협찬');
}

// 플랫폼 API로 실제 숨김을 실행할 수 있는지를 한 곳에서 판정한다.
// automatic: 광고 API로 확정 가능, conditional: owner OAuth가 연결된 YouTube만 가능,
// manual: 제3자 협찬·유기 TikTok/Instagram처럼 봇이 숨길 수 없음.
export function moderationCapability(target, managedCategories = ['온드미디어', '위성채널']) {
  const platform = clean(target?.platform);
  const source = clean(target?.source);
  if (isSponsorshipTarget(target)) return { mode: 'manual', reason: 'third_party_sponsorship' };
  if (isAdCommentSource({ source })) return { mode: 'automatic', reason: `${source}_api` };
  if (platform === 'youtube' && isManagedChannel(target, managedCategories)) {
    return { mode: 'conditional', reason: 'youtube_owner_oauth' };
  }
  if (platform === 'tiktok') return { mode: 'manual', reason: 'tiktok_organic_api_unavailable' };
  if (platform === 'instagram') return { mode: 'manual', reason: 'instagram_organic_owner_unverified' };
  return { mode: 'manual', reason: 'platform_owner_unverified' };
}

export function canRequestAutomaticHide(target, managedCategories) {
  return moderationCapability(target, managedCategories).mode !== 'manual';
}

export function normalizeHideDecision(target, managedCategories) {
  return canRequestAutomaticHide(target, managedCategories) ? 'hide' : MANUAL_HIDE_REQUIRED;
}

// hidden/author_banned은 기존부터 API 성공 뒤에만 쓰던 값이다. 마이그레이션 전후의
// 무중단 배포를 위해 이 두 레거시 확정값만 호환하고, hide/hold/complete는 절대 확정으로 보지 않는다.
export function isHiddenConfirmed(row) {
  if (row?.hidden_confirmed === true) return true;
  return ['hidden', 'author_banned'].includes(clean(row?.review_decision));
}

export function isUnresolvedModeration(row) {
  if (isHiddenConfirmed(row)) return false;
  return UNRESOLVED_REVIEW_DECISIONS.has(clean(row?.review_decision));
}

export function unresolvedKind(row, managedCategories) {
  const decision = clean(row?.review_decision);
  if (decision === 'hold') return 'hold';
  if (decision === MANUAL_HIDE_REQUIRED) return MANUAL_HIDE_REQUIRED;
  if (decision === 'hide' && !canRequestAutomaticHide(row, managedCategories)) return MANUAL_HIDE_REQUIRED;
  if (decision === 'hide') return 'hide_pending_confirmation';
  return 'unreviewed';
}
