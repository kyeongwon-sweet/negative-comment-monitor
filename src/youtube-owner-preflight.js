import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkSupabaseContracts, SCHEMA_CONTRACTS } from './supabase-schema-check.js';

function envConfig(env = process.env) {
  return {
    supabaseUrl: String(env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  };
}

export async function runYouTubeOwnerPreflight(config = envConfig(), fetchImpl = fetch) {
  const checked = await checkSupabaseContracts(config, [SCHEMA_CONTRACTS.youtubeOwnerVideoState], fetchImpl);
  console.log(`[youtube-owner-preflight] OK table=${checked[0].table} pk=${checked[0].primaryKey.join(',')}`);
  return checked;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runYouTubeOwnerPreflight().catch((error) => {
    console.error(`[youtube-owner-preflight] BLOCKED — ${error.message}`);
    process.exitCode = 2;
  });
}
