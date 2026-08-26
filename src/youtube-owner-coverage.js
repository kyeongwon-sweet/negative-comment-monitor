import { clearPlatformAlertClaim, recordPlatformOutcome } from './platform-health.js';

const HEALTH_KEY = 'youtube-owner-oauth-coverage';

function uniqueNames(channels = []) {
  return [...new Set(channels.map((channel) => String(channel?.name || channel?.channelId || '').trim()).filter(Boolean))];
}

export function summarizeOwnerOAuthCoverage(collected = {}) {
  const missingChannels = Array.isArray(collected.missingOAuthChannels)
    ? collected.missingOAuthChannels
    : [];
  const configured = Number(collected.totalConfiguredChannels || 0);
  const authenticated = Number(collected.authenticatedChannels ?? collected.configuredOwners ?? 0);
  return {
    configured,
    authenticated,
    missing: Math.max(0, configured - authenticated),
    missingChannels,
    complete: configured > 0 && authenticated >= configured && missingChannels.length === 0,
  };
}

export function buildOwnerOAuthCoverageMessage(coverage, config = {}) {
  const owner = String(config.slackAssignees?.other || '').trim();
  const names = uniqueNames(coverage.missingChannels);
  return [
    '⚠️ *YouTube 소유·위성채널 OAuth 커버리지 부족*',
    `인증 채널: ${coverage.authenticated}/${coverage.configured} · 미인증: ${coverage.missing}`,
    names.length ? `미인증 채널: ${names.join('·')}` : '',
    '미인증 채널은 일반 탐지에 포함될 수 있어도 소유채널 전수감시·자동숨김은 동작하지 않습니다.',
    '조치: 각 채널 관리자 OAuth 동의 후 youtube_owner:<channel_id> 토큰 저장',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function postSlack(config, text, fetchImpl) {
  if (!config.slackBotToken || !config.slackChannelId) return false;
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Slack API: ${payload.error || response.status}`);
  return true;
}

// OAuth 누락은 사용자 동의가 필요한 구조적 커버리지 제한이다. 수집 가능한 채널은 계속 처리하고,
// platform health의 쿨다운으로 주 1회 이하 경고만 보내 핵심 모니터를 실패시키지 않는다.
export async function monitorOwnerOAuthCoverage(config, collected, fetchImpl = fetch, now = Date.now()) {
  const coverage = summarizeOwnerOAuthCoverage(collected);
  const healthConfig = {
    ...config,
    platformFailureThreshold: 1,
    platformFailureAlertCooldownHours: Math.max(
      24,
      Number(config.youtubeOwnerCoverageAlertCooldownHours || 168),
    ),
  };
  const result = await recordPlatformOutcome(healthConfig, {
    platform: HEALTH_KEY,
    ok: coverage.complete,
    error: coverage.complete ? '' : `authenticated=${coverage.authenticated}/${coverage.configured}; missing=${coverage.missing}`,
  }, fetchImpl, now);
  let alerted = false;
  if (!coverage.complete && result.shouldEscalate) {
    try {
      alerted = await postSlack(config, buildOwnerOAuthCoverageMessage(coverage, config), fetchImpl);
      if (!alerted) await clearPlatformAlertClaim(healthConfig, HEALTH_KEY, fetchImpl, now).catch(() => {});
    } catch (error) {
      await clearPlatformAlertClaim(healthConfig, HEALTH_KEY, fetchImpl, now).catch(() => {});
      throw error;
    }
  }
  return { ...coverage, alerted, persisted: result.persisted, consecutiveFailures: result.consecutiveFailures };
}
