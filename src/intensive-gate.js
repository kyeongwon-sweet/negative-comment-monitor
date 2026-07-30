import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 60 * 60 * 1000;

function headers(config) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
  };
}

export async function hasRecentNegativeAlerts(config, { now = Date.now(), sinceMs = 3 * HOUR, fetchImpl = fetch } = {}) {
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for intensive gate');
  }
  const cutoff = encodeURIComponent(new Date(now - sinceMs).toISOString());
  const url = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/negative_comment_alerts?select=fingerprint&alerted_at=gte.${cutoff}&limit=1`;
  const response = await fetchImpl(url, { headers: headers(config) });
  if (!response.ok) throw new Error(`Intensive gate GET ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

function appendGitHubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

async function main() {
  const config = {
    supabaseUrl: String(process.env.SUPABASE_URL || '').trim(),
    supabaseKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  };
  try {
    const shouldRun = await hasRecentNegativeAlerts(config);
    appendGitHubOutput('should_run', shouldRun ? 'true' : 'false');
    console.error(`[intensive-gate] recent negative alerts within 3h: ${shouldRun ? 'yes' : 'no'}`);
  } catch (error) {
    // Fail open: if the cheap gate cannot verify state, run the full monitor rather than risking missed intensive checks.
    appendGitHubOutput('should_run', 'true');
    console.error(`[intensive-gate] ${error.message} - fail-open; running full monitor`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    appendGitHubOutput('should_run', 'true');
    console.error(`[intensive-gate] unexpected failure - fail-open; running full monitor: ${error.message}`);
  });
}
