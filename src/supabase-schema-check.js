function headers(config) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    Accept: 'application/openapi+json',
  };
}

export const SCHEMA_CONTRACTS = Object.freeze({
  youtubeOwnerVideoState: Object.freeze({
    table: 'youtube_owner_video_state',
    migration: 'supabase/008_youtube_owner_video_state.sql',
    columns: Object.freeze([
      'channel_id', 'video_id', 'video_title', 'published_at', 'comment_count',
      'last_scanned_count', 'last_seen_at', 'last_scanned_at',
    ]),
    primaryKey: Object.freeze(['channel_id', 'video_id']),
  }),
  gasTargetCache: Object.freeze({
    table: 'gas_target_cache',
    migration: 'supabase/009_gas_target_cache.sql',
    columns: Object.freeze(['id', 'targets', 'count', 'fetched_at']),
    primaryKey: Object.freeze(['id']),
  }),
});

function primaryKeyColumns(definition) {
  return Object.entries(definition?.properties || {})
    .filter(([, property]) => String(property?.description || '').includes('<pk/>'))
    .map(([name]) => name);
}

export function validateTableContract(definition, contract) {
  if (!definition) {
    throw new Error(`Supabase schema missing table '${contract.table}'; apply ${contract.migration}`);
  }
  const available = new Set(Object.keys(definition.properties || {}));
  const missing = contract.columns.filter((column) => !available.has(column));
  if (missing.length) {
    throw new Error(`Supabase schema '${contract.table}' missing column(s): ${missing.join(', ')}; apply ${contract.migration}`);
  }
  const actualPk = primaryKeyColumns(definition).sort();
  const expectedPk = [...contract.primaryKey].sort();
  if (actualPk.join(',') !== expectedPk.join(',')) {
    throw new Error(`Supabase schema '${contract.table}' primary key mismatch: expected (${expectedPk.join(', ')}), got (${actualPk.join(', ') || 'none'}); apply ${contract.migration}`);
  }
  return { table: contract.table, columns: contract.columns.length, primaryKey: expectedPk };
}

export async function checkSupabaseContracts(config, contracts, fetchImpl = fetch) {
  if (!config?.supabaseUrl || !config?.supabaseKey) throw new Error('Missing Supabase schema-check configuration');
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/`, { headers: headers(config) });
  if (!response.ok) throw new Error(`Supabase OpenAPI schema lookup failed (${response.status})`);
  const spec = await response.json();
  return contracts.map((contract) => validateTableContract(spec?.definitions?.[contract.table], contract));
}
