import { createHash } from 'node:crypto';
import { recordPlatformOutcome } from './platform-health.js';
import { postThreadText } from './slack.js';

function safeVideoId(target) {
  return String(target?.youtubeVideoId || '').trim();
}

function escapeMrkdwn(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function overloadHealthKey(videoId) {
  return `youtube-owner-overload:${createHash('sha256').update(videoId).digest('hex').slice(0, 20)}`;
}

export function assessOwnerCommentOverload(comments, risks, config) {
  const total = Array.isArray(comments) ? comments.length : 0;
  const negatives = (Array.isArray(risks) ? risks : []).filter((risk) => risk?.alert === true).length;
  const ratioPercent = total ? (negatives / total) * 100 : 0;
  const countThreshold = Number(config.youtubeOwnerOverloadNegativeCount || 20);
  const ratioThreshold = Number(config.youtubeOwnerOverloadRatioPercent || 40);
  const minComments = Number(config.youtubeOwnerOverloadMinComments || 10);
  const overloaded = negatives >= countThreshold
    || (total >= minComments && ratioPercent >= ratioThreshold);
  return { total, negatives, ratioPercent, countThreshold, ratioThreshold, minComments, overloaded };
}

export function buildOwnerOverloadWarning(target, assessment, assignee = '') {
  const videoId = safeVideoId(target);
  const mention = assignee ? `<@${assignee}> ` : '';
  const channelId = String(target?.ownerChannelId || target?.channelId || '').trim();
  const channelName = escapeMrkdwn(String(target?.channelName || channelId || '소유 채널').trim().slice(0, 80));
  const title = escapeMrkdwn(String(target?.caption || target?.channelName || videoId).split(' / ')[0].slice(0, 120));
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const studioCommentsUrl = channelId
    ? `https://studio.youtube.com/channel/${encodeURIComponent(channelId)}/comments`
    : 'https://studio.youtube.com/';
  const studioVideoUrl = videoId
    ? `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`
    : 'https://studio.youtube.com/';
  const channelLabel = channelId ? `${channelName} (${escapeMrkdwn(channelId)})` : channelName;
  return `🚨 *소유 YouTube 댓글 과부하 — 댓글창 사용 중지 권고*\n`
    + `${mention}${title}\n`
    + `이번 확인 댓글 ${assessment.total}개 중 부정 ${assessment.negatives}개 (${assessment.ratioPercent.toFixed(1)}%)입니다.\n`
    + `과부하 임계치에 도달했습니다. 하나씩 숨기기보다 이 영상의 댓글을 사용 중지해 주세요.\n`
    + `${channelLabel} 채널로 전환한 뒤 영상 설정에서 '댓글 → 꺼짐'으로 저장하세요.\n`
    + `<${watchUrl}|영상 열기> · <${studioVideoUrl}|댓글 설정 바로 열기> · <${studioCommentsUrl}|${channelName} 댓글 관리>`;
}

export async function maybeWarnOwnerCommentOverload(
  config, target, assessment, threadTs, assignee = '', fetchImpl = fetch, now = Date.now(),
) {
  if (target?.ownedChannelBrandHostilityScope !== true || !safeVideoId(target)) {
    return { checked: false, alerted: false };
  }
  const healthConfig = {
    ...config,
    platformFailureThreshold: 1,
    platformFailureAlertCooldownHours: config.youtubeOwnerOverloadCooldownHours || 24,
  };
  const platform = overloadHealthKey(safeVideoId(target));
  const health = await recordPlatformOutcome(healthConfig, {
    platform,
    ok: !assessment.overloaded,
    error: assessment.overloaded
      ? `negative=${assessment.negatives}/${assessment.total} (${assessment.ratioPercent.toFixed(1)}%)`
      : null,
  }, fetchImpl, now);
  if (!assessment.overloaded || (!health.shouldEscalate && health.persisted)) {
    return { checked: true, alerted: false, health };
  }
  try {
    await postThreadText(
      config,
      threadTs,
      buildOwnerOverloadWarning(target, assessment, assignee),
      fetchImpl,
    );
    return { checked: true, alerted: true, health };
  } catch (error) {
    // 경고 전송 실패 시 쿨다운 claim을 해제해 다음 회차가 다시 시도할 수 있게 한다.
    await recordPlatformOutcome(healthConfig, { platform, ok: true }, fetchImpl, now).catch(() => null);
    return { checked: true, alerted: false, health, error: String(error?.message || error) };
  }
}
