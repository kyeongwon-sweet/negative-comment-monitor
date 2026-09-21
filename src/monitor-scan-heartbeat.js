const MIGRATION = 'supabase/013_monitor_scan_heartbeats.sql';

function enabled(config) {
  return Boolean(config?.supabaseUrl && config?.supabaseKey);
}

function headers(config, extra = {}) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...extra,
  };
}

function baseUrl(config) {
  return String(config.supabaseUrl || '').replace(/\/$/, '');
}

function scanKey(details, scannedAt) {
  const runId = String(details.runId || '').trim();
  const runAttempt = Math.max(1, Number(details.runAttempt || 1));
  const iteration = Math.max(1, Number(details.iteration || 1));
  return runId
    ? `${runId}:${runAttempt}:${iteration}`
    : `local:${new Date(scannedAt).toISOString()}:${iteration}`;
}

export async function recordMonitorScanHeartbeat(
  config,
  details = {},
  fetchImpl = fetch,
) {
  if (!enabled(config)) return { persisted: false, reason: 'not_configured' };
  const scannedAt = Number.isFinite(Number(details.scannedAt))
    ? Number(details.scannedAt)
    : Date.now();
  const row = {
    scan_key: scanKey(details, scannedAt),
    scanned_at: new Date(scannedAt).toISOString(),
    run_id: String(details.runId || '').trim() || null,
    run_attempt: Math.max(1, Number(details.runAttempt || 1)),
    iteration: Math.max(1, Number(details.iteration || 1)),
    trigger_event: String(details.triggerEvent || '').trim() || null,
    trigger_schedule: String(details.triggerSchedule || '').trim() || null,
  };
  const response = await fetchImpl(
    `${baseUrl(config)}/rest/v1/monitor_scan_heartbeats?on_conflict=scan_key`,
    {
      method: 'POST',
      headers: headers(config, {
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(row),
    },
  );
  if (!response.ok) {
    throw new Error(`scan heartbeat write HTTP ${response.status}; apply ${MIGRATION}`);
  }
  return { persisted: true, scanKey: row.scan_key, scannedAt };
}

export async function fetchMonitorScanHeartbeats(
  config,
  { from, to, limit = 1000 } = {},
  fetchImpl = fetch,
) {
  if (!enabled(config)) return [];
  const fromMs = Number(from);
  const toMs = Number(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return [];
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
  const url = new URL(`${baseUrl(config)}/rest/v1/monitor_scan_heartbeats`);
  url.searchParams.set('select', 'scanned_at');
  url.searchParams.set('scanned_at', `gte.${new Date(fromMs).toISOString()}`);
  url.searchParams.append('scanned_at', `lte.${new Date(toMs).toISOString()}`);
  url.searchParams.set('order', 'scanned_at.asc');
  url.searchParams.set('limit', String(safeLimit));
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) {
    throw new Error(`scan heartbeat read HTTP ${response.status}; apply ${MIGRATION}`);
  }
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : [])
    .map((row) => Date.parse(row?.scanned_at || ''))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= fromMs && timestamp <= toMs);
}
