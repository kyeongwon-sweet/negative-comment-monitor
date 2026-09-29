import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chainNextMonitor } from './monitor-chain.js';

export async function runMonitorFloorWake(env = process.env, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || delay;
  const chain = options.chain || ((details) => chainNextMonitor(env, details));
  const wakeAt = Date.parse(String(env.MONITOR_FLOOR_WAKE_AT || ''));
  if (!Number.isFinite(wakeAt)) throw new Error('MONITOR_FLOOR_WAKE_AT must be an ISO timestamp');

  const waitMs = Math.max(0, wakeAt - now());
  console.error(`[monitor-floor-wake] target=${new Date(wakeAt).toISOString()} wait_ms=${waitMs}`);
  if (waitMs > 0) await sleep(waitMs);

  const result = await chain({
    gateOpen: false,
    scannedThisRun: false,
    now: now(),
  });
  console.error(`[monitor-floor-wake] complete chain=${result.reason}`);
  return { wakeAt, waitMs, chain: result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMonitorFloorWake().catch((error) => {
    console.error(`[monitor-floor-wake] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
