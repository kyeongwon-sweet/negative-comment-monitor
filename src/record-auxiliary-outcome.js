import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordPlatformOutcome } from './platform-health.js';
import { notifyAuxiliaryDegraded } from './notify-auxiliary-degraded.js';

export function loadAuxiliaryOutcomeConfig(env = process.env) {
  return {
    platform: String(env.AUXILIARY_HEALTH_KEY || 'auxiliary').trim().toLowerCase(),
    ok: String(env.AUXILIARY_OUTCOME || '').trim().toLowerCase() === 'success',
    reason: String(env.AUXILIARY_REASON || '보조 단계 실패 — 실행 로그 확인').trim(),
    health: {
      supabaseUrl: String(env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
      supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
      platformFailureThreshold: Math.max(1, Number(env.AUXILIARY_FAILURE_THRESHOLD || 3)),
      platformFailureAlertCooldownHours: Math.max(1, Number(env.AUXILIARY_ALERT_COOLDOWN_HOURS || 24)),
    },
  };
}

export async function recordAuxiliaryOutcome(env = process.env, fetchImpl = fetch, now = Date.now()) {
  const config = loadAuxiliaryOutcomeConfig(env);
  const result = await recordPlatformOutcome(config.health, {
    platform: config.platform,
    ok: config.ok,
    error: config.ok ? '' : config.reason,
  }, fetchImpl, now);
  let notified = false;
  if (result.shouldEscalate) {
    await notifyAuxiliaryDegraded({
      ...env,
      AUXILIARY_REASON: `${config.reason} (연속 ${result.consecutiveFailures}회)`,
    }, fetchImpl);
    notified = true;
  }
  return { ...result, notified };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  recordAuxiliaryOutcome()
    .then((result) => console.log(JSON.stringify({
      platform: result.platform,
      ok: result.consecutiveFailures === 0,
      consecutiveFailures: result.consecutiveFailures,
      notified: result.notified,
      persisted: result.persisted,
    })))
    .catch((error) => {
      // 상태 기록 자체도 보조 기능이다. 핵심 monitor를 다시 failure로 만들지 않는다.
      console.error(`[auxiliary-health:degraded] ${error.message}`);
    });
}
