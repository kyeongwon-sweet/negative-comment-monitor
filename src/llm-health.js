import { clearPlatformAlertClaim, recordPlatformOutcome } from './platform-health.js';

function safeScope(value) {
  return String(value || 'classifier').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 48) || 'classifier';
}

export function summarizeLlmHealth(stats = {}, totalComments = 0) {
  const fallbackComments = Number(stats.keywordFallbackComments || 0);
  const candidateComments = Number(stats.cacheHits || 0) + Number(stats.cacheMiss || 0) + Number(stats.missingKey ? fallbackComments : 0);
  const persistent = Boolean(stats.missingKey || Number(stats.persistentFailures || 0) > 0);
  return {
    totalComments: Math.max(0, Number(totalComments || 0)),
    candidateComments,
    successfulCalls: Number(stats.calls || 0),
    reviewedComments: Number(stats.reviewed || 0),
    failedAttempts: Number(stats.failedAttempts || 0),
    persistentFailures: Number(stats.persistentFailures || 0),
    transientFailures: Number(stats.transientFailures || 0),
    keywordFallback: fallbackComments > 0,
    keywordFallbackBatches: Number(stats.keywordFallbackBatches || 0),
    keywordFallbackComments: fallbackComments,
    persistent,
    failureCode: String(stats.lastFailureCode || (stats.missingKey ? 'missing_key' : '')),
    degraded: fallbackComments > 0,
  };
}

export function buildLlmDegradedMessage(scope, health, owner = '') {
  const cause = health.failureCode === 'credit' ? 'Anthropic 크레딧 부족'
    : health.failureCode === 'auth' || health.failureCode === 'missing_key' ? 'Anthropic 인증/키 설정 오류'
      : health.persistent ? 'Anthropic 영구 요청 오류'
        : 'Anthropic 일시 오류 재시도 소진';
  return [
    '⚠️ *LLM 분류 degraded — 키워드 폴백 중*',
    `구간: ${scope}`,
    `원인: ${cause}`,
    `LLM 대상 ${health.candidateComments}건 중 ${health.keywordFallbackComments}건이 키워드 판정으로 대체됐습니다.`,
    '브랜드 적대·비꼼·문맥형 부정댓글을 놓칠 위험이 있습니다. Anthropic 결제·키·실행 로그를 확인해 주세요.',
    owner ? `담당자: <@${owner}>` : '',
  ].filter(Boolean).join('\n');
}

async function postWarning(config, text, fetchImpl) {
  if (!config?.slackBotToken || !config?.slackChannelId) throw new Error('Missing Slack LLM health configuration');
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Slack API: ${payload.error || response.status}`);
  return payload;
}

export async function monitorLlmHealth(config, stats, options = {}, fetchImpl = fetch, now = Date.now()) {
  const scope = safeScope(options.scope);
  const health = summarizeLlmHealth(stats, options.totalComments);
  if (!health.candidateComments && !health.keywordFallbackComments) {
    return { ...health, scope, persisted: false, alerted: false, inactive: true };
  }
  const platform = `llm-${scope}`;
  const healthConfig = {
    supabaseUrl: config?.supabaseUrl,
    supabaseKey: config?.supabaseKey,
    platformFailureThreshold: health.persistent ? 1 : Math.max(1, Number(config?.llmFailureThreshold || 3)),
    platformFailureAlertCooldownHours: Math.max(1, Number(config?.llmFailureAlertCooldownHours || 12)),
  };
  if (health.degraded) {
    console.error(
      `::warning title=LLM classification degraded::${scope} fallback=${health.keywordFallbackComments}/${health.candidateComments} code=${health.failureCode || 'unknown'}`,
    );
  }
  const outcome = await recordPlatformOutcome(healthConfig, {
    platform,
    ok: !health.degraded,
    error: health.degraded
      ? `${health.failureCode || 'unknown'}; fallback=${health.keywordFallbackComments}/${health.candidateComments}`
      : '',
  }, fetchImpl, now);
  let alerted = false;
  let alertError = '';
  const shouldNotify = health.degraded
    && options.notify !== false
    && (outcome.shouldEscalate || (health.persistent && !outcome.persisted));
  if (shouldNotify) {
    try {
      await postWarning(
        config,
        buildLlmDegradedMessage(options.label || scope, health, config?.slackAssignees?.other),
        fetchImpl,
      );
      alerted = true;
    } catch (error) {
      alertError = String(error.message || error).slice(0, 200);
      if (outcome.persisted && outcome.shouldEscalate) {
        await clearPlatformAlertClaim(healthConfig, platform, fetchImpl, now);
      }
      console.error(`[llm-health] ${scope} Slack 경고 실패(분류에는 영향 없음): ${alertError}`);
    }
  }
  return {
    ...health,
    scope,
    persisted: outcome.persisted,
    consecutiveFailures: outcome.consecutiveFailures,
    shouldEscalate: outcome.shouldEscalate,
    alerted,
    alertError,
  };
}
