import { kstDateKey } from './schedule.js';
import { clearPlatformAlertClaim, recordPlatformOutcome } from './platform-health.js';

function safeScope(value) {
  return String(value || 'classifier').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 48) || 'classifier';
}

export function summarizeLlmHealth(stats = {}, totalComments = 0) {
  const fallbackComments = Number(stats.keywordFallbackComments || 0);
  const immediateComments = Number(stats.keywordImmediateComments || 0);
  // 구형 호출부/테스트가 새 카운트를 아직 넘기지 않아도 기존 fallback 전량을 보류로 해석한다.
  const deferredComments = stats.llmDeferredComments == null
    ? Math.max(0, fallbackComments - immediateComments)
    : Number(stats.llmDeferredComments || 0);
  const candidateComments = Number(stats.cacheHits || 0) + Number(stats.cacheMiss || 0) + Number(stats.missingKey ? fallbackComments : 0);
  // 영구(즉시 경고)는 '일시 오류 없이 영구 오류만' 난 경우. 1순위(Gemini)가 5xx·429 같은 일시 오류로
  // 실패해 폴백(Anthropic)으로 넘어갔다가 크레딧 부족으로 실패한 경우는 1순위 복구 시 자동 회복되므로
  // 일시 오류로 보고 연속 임계(기본 3회)를 따른다(10-12·10-14: 보류 1~25건이 즉시 경고로 나간 오탐).
  const transientSeen = Number(stats.transientFailures || 0) > 0;
  const persistent = Boolean(stats.missingKey || (Number(stats.persistentFailures || 0) > 0 && !transientSeen));
  const byProvider = stats.providerLastFailure || {};
  const transientEntry = Object.entries(byProvider).find(([, f]) => f?.kind === 'transient');
  const persistentEntry = Object.entries(byProvider).find(([, f]) => f?.kind === 'persistent');
  // 원인 표시는 일시 오류가 있으면 그 공급자 기준, 영구 오류 난 폴백은 부가 정보로.
  const primary = transientSeen && transientEntry ? transientEntry : null;
  const fallbackNote = primary && persistentEntry && persistentEntry[0] !== primary[0]
    ? { provider: persistentEntry[0], code: String(persistentEntry[1]?.code || '') }
    : null;
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
    keywordImmediateComments: immediateComments,
    llmDeferredComments: deferredComments,
    llmDeferredBatches: Number(stats.llmDeferredBatches || 0),
    persistent,
    failureProvider: primary ? primary[0] : String(stats.lastFailureProvider || ''),
    successfulProvider: String(stats.lastSuccessfulProvider || ''),
    failureCode: primary
      ? String(primary[1]?.code || '')
      : String(stats.lastFailureCode || (stats.missingKey ? 'missing_key' : '')),
    fallbackFailure: fallbackNote,
    degraded: fallbackComments > 0,
  };
}

export function buildLlmDegradedMessage(scope, health, owner = '') {
  const immediateComments = Number(health.keywordImmediateComments || 0);
  const deferredComments = health.llmDeferredComments == null
    ? Math.max(0, Number(health.keywordFallbackComments || 0) - immediateComments)
    : Number(health.llmDeferredComments || 0);
  const provider = health.failureProvider === 'gemini' ? 'Gemini'
    : health.failureProvider === 'anthropic' ? 'Anthropic'
      : 'Gemini·Anthropic';
  const cause = health.failureCode === 'credit' ? 'Anthropic 크레딧 부족'
    : health.failureCode === 'auth' || ['missing_key', 'missing_llm_key'].includes(health.failureCode) ? `${provider} 인증/키 설정 오류`
      : health.failureCode === 'daily_budget' ? '대량 작업용 Gemini 안전예산 도달(정기 감시 몫 보호 중)'
        : health.failureCode === 'daily_quota' ? `${provider} 일일 무료 한도 초과`
      : health.failureCode === 'rate_limit' ? `${provider} 무료 한도/호출 제한 초과`
        : health.failureCode === 'server' ? `${provider} 서버 오류(5xx) 재시도 소진`
          : health.persistent ? `${provider} 영구 요청 오류`
            : `${provider} 일시 오류 재시도 소진`;
  const fb = health.fallbackFailure;
  const fallbackText = fb
    ? ` (폴백 ${fb.provider === 'anthropic' ? 'Anthropic' : 'Gemini'}도 실패: ${fb.code === 'credit' ? '크레딧 부족' : fb.code || '영구 오류'})`
    : '';
  return [
    '⚠️ *LLM 분류 degraded — 문맥 판정 보류 중*',
    `구간: ${scope}`,
    `원인: ${cause}${fallbackText}`,
    `LLM 대상 ${health.candidateComments}건 중 ${deferredComments}건은 문맥 판정을 보류했고, 명백 부정 ${immediateComments}건만 키워드로 즉시 처리했습니다.`,
    `LLM 장애로 ${deferredComments}건 문맥판정 보류 중 — 알림·숨김·정상 캐시·seen 기록 없이 복구 후 자동 재분류합니다.`,
    'Gemini 키·무료 한도를 확인해 주세요(폴백 공급자 없음, 보류분은 다음 회차 자동 재분류).',
    ['rate_limit', 'daily_quota', 'daily_budget'].includes(health.failureCode)
      ? '무료 한도는 모든 구간이 함께 쓰므로 다른 구간도 보류될 수 있습니다. 이 원인 경고는 오늘 이 1장만 보냅니다.'
      : '',
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

// 강한 모델 2차 판정(hybrid-classify 승격)은 1차 성공과 무관하게 따로 실패할 수 있다(10-28: 404 모델로
// 5주간 미작동, 1차 health는 정상). 구간별 별도 원장(llm-escalation-<scope>)에 연속 실패를 세고 임계 시 알린다.
// 모델 미설정(escalation_model_unset)은 그 경로가 승격을 안 쓰는 의도된 상태라 실패로 세지 않는다.
export async function monitorEscalationHealth(config, stats = {}, options = {}, fetchImpl = fetch, now = Date.now()) {
  const scope = safeScope(options.scope);
  const checked = Number(stats.ownedEscalationChecked || 0);
  const promoted = Number(stats.ownedEscalatedAlerts || 0);
  const skipped = Number(stats.ownedEscalationSkipped || 0);
  const reason = String(stats.ownedEscalationSkipReason || '');
  const base = { checked, promoted, skipped, reason, model: String(config?.ownedBrandEscalationModel || '') };
  if (!checked && !skipped) return { ...base, inactive: true, alerted: false };
  if (!checked && reason === 'escalation_model_unset') return { ...base, inactive: true, alerted: false };
  const failed = skipped > 0;
  const platform = `llm-escalation-${scope}`.slice(0, 64);
  const healthConfig = {
    supabaseUrl: config?.supabaseUrl,
    supabaseKey: config?.supabaseKey,
    platformFailureThreshold: Math.max(1, Number(config?.llmFailureThreshold || 3)),
    platformFailureAlertCooldownHours: Math.max(1, Number(config?.llmFailureAlertCooldownHours || 12)),
  };
  const outcome = await recordPlatformOutcome(healthConfig, {
    platform,
    ok: !failed,
    error: failed ? `${reason || 'unknown'}; skipped=${skipped}; model=${base.model || '-'}` : '',
  }, fetchImpl, now);
  let alerted = false;
  if (failed && outcome.shouldEscalate && options.notify !== false && options.escalationAlert !== false) {
    const owner = config?.slackAssignees?.other ? `<@${config.slackAssignees.other}> ` : '';
    const text = [
      `⚠️ *강한 모델 2차 판정 실패 — ${options.label || scope}*`,
      `• 사유: ${reason || 'unknown'} · 이번 회차 ${skipped}건 미검토 · 연속 ${outcome.consecutiveFailures}회`,
      `• 모델: ${base.model || '(미설정)'}`,
      '• 영향: 1차가 정상으로 본 댓글의 재검토(미탐 구제)가 멈춤. 1차 실시간 감시는 계속 동작.',
      `${owner}모델명(404)·무료 한도(429)·과부하(503) 확인 필요`,
    ].join('\n');
    try {
      await postWarning(config, text, fetchImpl);
      alerted = true;
    } catch (error) {
      if (outcome.persisted) await clearPlatformAlertClaim(healthConfig, platform, fetchImpl, now);
      console.error(`[llm-health] ${scope} 승격 실패 경고 발송 실패: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  return { ...base, failed, consecutiveFailures: outcome.consecutiveFailures, alerted };
}

export async function monitorLlmHealth(config, stats, options = {}, fetchImpl = fetch, now = Date.now()) {
  const scope = safeScope(options.scope);
  const health = summarizeLlmHealth(stats, options.totalComments);
  const escalation = await monitorEscalationHealth(config, stats, options, fetchImpl, now);
  if (!health.candidateComments && !health.keywordFallbackComments) {
    return { ...health, scope, persisted: false, alerted: false, inactive: true, escalation };
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
      `::warning title=LLM classification degraded::${scope} deferred=${health.llmDeferredComments}/${health.candidateComments} immediate=${health.keywordImmediateComments} code=${health.failureCode || 'unknown'}`,
    );
  }
  const outcome = await recordPlatformOutcome(healthConfig, {
    platform,
    ok: !health.degraded,
    error: health.degraded
      ? `${health.failureCode || 'unknown'}; deferred=${health.llmDeferredComments}/${health.candidateComments}; immediate=${health.keywordImmediateComments}`
      : '',
  }, fetchImpl, now);
  let alerted = false;
  let alertError = '';
  const shouldNotify = health.degraded
    && options.notify !== false
    && (outcome.shouldEscalate || (health.persistent && !outcome.persisted));
  // 2026-10-26: Gemini 무료 하루 한도(RPD 500) 소진은 키 하나를 같이 쓰는 모든 구간(일반·메타·틱톡·
  // 유튜브 광고·소유채널)에 동시에 걸린다. 구간별 쿨다운만 있어 같은 원인 경고가 구간마다 한 장씩
  // 계속 올라왔다. rate_limit은 KST 하루 한 장만(첫 구간) 올리고 나머지 구간은 로그로만 남긴다.
  let quotaSuppressed = false;
  if (shouldNotify && ['rate_limit', 'daily_quota', 'daily_budget'].includes(health.failureCode)) {
    quotaSuppressed = !(await claimDailyQuotaWarning(config, now, fetchImpl));
    if (quotaSuppressed) console.error(`[llm-health] ${scope} 무료 한도 경고는 오늘 이미 다른 구간에서 발송됨 — 생략`);
  }
  if (shouldNotify && !quotaSuppressed) {
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
    quotaSuppressed,
    escalation,
  };
}

// 같은 KST 날짜에 첫 호출만 true. 원장 조회·기록이 실패하면 경고를 막지 않는다(fail-open: 누락보다 중복이 낫다).
async function claimDailyQuotaWarning(config, now, fetchImpl) {
  if (!config?.supabaseUrl || !config?.supabaseKey) return true;
  const kstDate = kstDateKey(now);
  try {
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
      method: 'POST',
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify({ run_key: `llm-quota-warning:${kstDate}`, kst_date: kstDate, apify_usd: 0, anthropic_usd: 0 }),
    });
    if (!response.ok) return true;
    const rows = await response.json().catch(() => null);
    return !Array.isArray(rows) || rows.length > 0;
  } catch {
    return true;
  }
}
