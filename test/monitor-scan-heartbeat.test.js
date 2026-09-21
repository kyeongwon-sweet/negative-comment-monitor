import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchMonitorScanHeartbeats,
  recordMonitorScanHeartbeat,
} from '../src/monitor-scan-heartbeat.js';

const CONFIG = { supabaseUrl: 'https://db.test/', supabaseKey: 'service-role' };

test('successful scan heartbeat is idempotent per run attempt and iteration', async () => {
  let request;
  const result = await recordMonitorScanHeartbeat(CONFIG, {
    scannedAt: Date.parse('2026-09-21T07:50:00Z'),
    runId: '35567978343',
    runAttempt: 2,
    iteration: 4,
    triggerEvent: 'schedule',
    triggerSchedule: '*/15 * * * *',
  }, async (url, options) => {
    request = { url: String(url), options };
    return new Response(null, { status: 201 });
  });

  assert.equal(result.persisted, true);
  assert.match(request.url, /monitor_scan_heartbeats\?on_conflict=scan_key$/);
  assert.match(request.options.headers.Prefer, /merge-duplicates/);
  assert.deepEqual(JSON.parse(request.options.body), {
    scan_key: '35567978343:2:4',
    scanned_at: '2026-09-21T07:50:00.000Z',
    run_id: '35567978343',
    run_attempt: 2,
    iteration: 4,
    trigger_event: 'schedule',
    trigger_schedule: '*/15 * * * *',
  });
});

test('heartbeat reader returns only valid measured timestamps', async () => {
  let requestUrl = '';
  const timestamps = await fetchMonitorScanHeartbeats(CONFIG, {
    from: Date.parse('2026-09-21T06:00:00Z'),
    to: Date.parse('2026-09-21T10:15:00Z'),
  }, async (url) => {
    requestUrl = String(url);
    return new Response(JSON.stringify([
      { scanned_at: '2026-09-21T07:02:00Z' },
      { scanned_at: 'invalid' },
      { scanned_at: '2026-09-21T07:50:00Z' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  assert.deepEqual(timestamps, [
    Date.parse('2026-09-21T07:02:00Z'),
    Date.parse('2026-09-21T07:50:00Z'),
  ]);
  assert.match(requestUrl, /scanned_at=gte\./);
  assert.match(requestUrl, /scanned_at=lte\./);
  assert.match(requestUrl, /order=scanned_at\.asc/);
});

test('heartbeat storage errors name the required migration', async () => {
  await assert.rejects(
    recordMonitorScanHeartbeat(CONFIG, { iteration: 1 }, async () => new Response(null, { status: 404 })),
    /013_monitor_scan_heartbeats\.sql/,
  );
});
