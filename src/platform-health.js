const MIGRATION = 'supabase/010_platform_collection_health.sql';

function enabled(config) {
  return Boolean(config?.supabaseUrl && config?.supabaseKey);
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

async function loadHealth(config, platform, fetchImpl) {
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/platform_collection_health?platform=eq.${encodeURIComponent(platform)}&select=*&limit=1`,
    { headers: headers(config) },
  );
  if (!response.ok) throw new Error(`health read HTTP ${response.status}; apply ${MIGRATION}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function saveHealth(config, row, fetchImpl) {
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/platform_collection_health?on_conflict=platform`, {
    method: 'POST',
    headers: headers(config, {
      'content-type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new Error(`health write HTTP ${response.status}; apply ${MIGRATION}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || row : row;
}

export async function recordPlatformOutcome(config, outcome, fetchImpl = fetch, now = Date.now()) {
  const platform = String(outcome?.platform || '').trim().toLowerCase();
  if (!platform || !enabled(config)) {
    return { persisted: false, platform, consecutiveFailures: outcome?.ok ? 0 : 1, shouldEscalate: false };
  }
  const threshold = Math.max(1, Number(config.platformFailureThreshold || 3));
  const cooldownMs = Math.max(1, Number(config.platformFailureAlertCooldownHours || 12)) * 3600e3;
  try {
    const previous = await loadHealth(config, platform, fetchImpl);
    const nowIso = new Date(now).toISOString();
    if (outcome.ok) {
      const saved = await saveHealth(config, {
        platform,
        consecutive_failures: 0,
        last_status: 'success',
        last_success_at: nowIso,
        last_failure_at: previous?.last_failure_at || null,
        last_error: null,
        last_alerted_at: null,
        updated_at: nowIso,
      }, fetchImpl);
      return { persisted: true, platform, consecutiveFailures: 0, shouldEscalate: false, row: saved };
    }

    const previousCount = previous?.last_status === 'failure' ? Number(previous.consecutive_failures || 0) : 0;
    const consecutiveFailures = previousCount + 1;
    const lastAlertedMs = Date.parse(previous?.last_alerted_at || '');
    const cooldownPassed = !Number.isFinite(lastAlertedMs) || now - lastAlertedMs >= cooldownMs;
    const shouldEscalate = consecutiveFailures >= threshold && cooldownPassed;
    const saved = await saveHealth(config, {
      platform,
      consecutive_failures: consecutiveFailures,
      last_status: 'failure',
      last_success_at: previous?.last_success_at || null,
      last_failure_at: nowIso,
      last_error: String(outcome.error || 'collection failed').slice(0, 500),
      last_alerted_at: shouldEscalate ? nowIso : previous?.last_alerted_at || null,
      updated_at: nowIso,
    }, fetchImpl);
    return { persisted: true, platform, consecutiveFailures, shouldEscalate, row: saved };
  } catch (error) {
    console.error(`[platform-health] ${platform} 상태 기록 실패(수집에는 영향 없음): ${error.message}`);
    return { persisted: false, platform, consecutiveFailures: outcome.ok ? 0 : 1, shouldEscalate: false, error: error.message };
  }
}
