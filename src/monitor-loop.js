import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasRecentNegativeAlerts } from './intensive-gate.js';
import { recordMonitorScanHeartbeat } from './monitor-scan-heartbeat.js';

const MINUTE = 60 * 1000;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(' ')} failed (${signal || code})`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function forceFirstMonitor({ eventName, schedule, iteration }) {
  return iteration === 0 && (eventName !== 'schedule' || schedule !== '*/15 * * * *');
}

export async function runMonitorLoop(env = process.env, options = {}) {
  const iterations = positiveInt(env.MONITOR_LOOP_ITERATIONS, env.MONITOR_TRIGGER_EVENT === 'schedule' ? 4 : 1);
  const intervalMs = positiveInt(env.MONITOR_LOOP_INTERVAL_MS, 15 * MINUTE);
  const eventName = String(env.MONITOR_TRIGGER_EVENT || '').trim();
  const schedule = String(env.MONITOR_TRIGGER_SCHEDULE || '').trim();
  const gateConfig = {
    supabaseUrl: String(env.SUPABASE_URL || '').trim(),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  };
  const gate = options.gate || ((config) => hasRecentNegativeAlerts(config));
  const execute = options.runCommand || runCommand;
  const sleep = options.sleep || delay;
  const recordHeartbeat = options.recordHeartbeat || ((details) => recordMonitorScanHeartbeat(gateConfig, details));
  const now = options.now || Date.now;
  let dependenciesInstalled = false;
  let monitorRuns = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let gateOpen = false;
    let gateState = 'closed';
    try {
      gateOpen = await gate(gateConfig);
      gateState = gateOpen ? 'open' : 'closed';
    } catch (error) {
      gateOpen = true;
      gateState = 'fail-open';
      console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} gate_error=${error.message}`);
    }

    const forced = forceFirstMonitor({ eventName, schedule, iteration });
    const shouldRun = forced || gateOpen;
    console.error(
      `[monitor-loop] iteration=${iteration + 1}/${iterations} gate=${gateState} forced=${forced} decision=${shouldRun ? 'run' : 'skip'}`,
    );

    if (shouldRun) {
      if (!dependenciesInstalled) {
        console.error('[monitor-loop] installing dependencies once before the first full scan');
        await execute('npm', ['install', '--ignore-scripts'], env);
        dependenciesInstalled = true;
      }
      await execute('npm', ['start'], env);
      monitorRuns += 1;
      try {
        const scannedAt = now();
        await recordHeartbeat({
          scannedAt,
          runId: env.GITHUB_RUN_ID,
          runAttempt: env.GITHUB_RUN_ATTEMPT,
          iteration: iteration + 1,
          triggerEvent: eventName,
          triggerSchedule: schedule,
        });
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} scan_heartbeat=${new Date(scannedAt).toISOString()}`);
      } catch (error) {
        // The scan itself succeeded. Heartbeat persistence must never turn a healthy
        // collection into a failed collection; the watchdog falls back to run starts.
        console.error(`[monitor-loop] iteration=${iteration + 1}/${iterations} heartbeat_write_error=${error.message}`);
      }
    } else {
      console.error(
        `[monitor-loop] iteration=${iteration + 1}/${iterations} gate_supabase_get=1 monitor_external_api_calls=0`,
      );
    }

    if (iteration + 1 < iterations) {
      if (eventName === 'schedule' && schedule === '*/15 * * * *' && !gateOpen) {
        console.error('[monitor-loop] intensive gate closed; ending loop early so floor/backup schedules are not blocked');
        break;
      }
      console.error(`[monitor-loop] sleeping ${Math.round(intervalMs / MINUTE)} minutes before the next gate check`);
      await sleep(intervalMs);
    }
  }

  console.error(`[monitor-loop] complete iterations=${iterations} full_scans=${monitorRuns}`);
  return { iterations, monitorRuns, dependenciesInstalled };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMonitorLoop().catch((error) => {
    console.error(`[monitor-loop] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
