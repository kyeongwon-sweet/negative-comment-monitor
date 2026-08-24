import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const target = String(process.argv[2] || '').trim().toLowerCase();
const targetSecret = {
  google_ads: 'GOOGLE_ADS_REFRESH_TOKEN',
  youtube_ads: 'YOUTUBE_ADS_REFRESH_TOKEN',
}[target];
if (!targetSecret) throw new Error('Usage: node scripts/promote-google-oauth-token.mjs <google_ads|youtube_ads>');

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

const localEnv = parseEnv(await readFile('.env', 'utf8'));
const supabaseUrl = String(process.env.SUPABASE_URL || localEnv.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || localEnv.SUPABASE_SERVICE_ROLE_KEY || '');
if (!supabaseUrl || !supabaseKey) throw new Error('Local Supabase service credentials are missing');

const tokenKind = `oauth_ephemeral:${target}`;
const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
const response = await fetch(`${supabaseUrl}/rest/v1/meta_tokens?select=token&kind=eq.${encodeURIComponent(tokenKind)}&limit=1`, { headers });
if (!response.ok) throw new Error(`OAuth handoff read failed (${response.status})`);
const token = (await response.json())[0]?.token;
if (!token) throw new Error(`OAuth handoff row not found for ${target}`);

const gh = spawnSync('gh', ['secret', 'set', targetSecret, '--repo', 'kyeongwon-sweet/negative-comment-monitor'], {
  input: `${token}\n`,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
if (gh.status !== 0) throw new Error(`GitHub secret update failed (${gh.status})`);

const cleanup = await fetch(`${supabaseUrl}/rest/v1/meta_tokens?kind=eq.${encodeURIComponent(tokenKind)}`, {
  method: 'DELETE',
  headers,
});
if (!cleanup.ok) throw new Error(`OAuth handoff cleanup failed (${cleanup.status})`);
console.log(JSON.stringify({ target, secret: targetSecret, promoted: true, handoffDeleted: true }));
