import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSupabaseContracts, SCHEMA_CONTRACTS, validateTableContract } from '../src/supabase-schema-check.js';

function definition(columns, primaryKey = []) {
  return {
    properties: Object.fromEntries(columns.map((column) => [column, {
      type: 'string',
      ...(primaryKey.includes(column) ? { description: 'Note:\nThis is a Primary Key.<pk/>' } : {}),
    }])),
  };
}

test('owner state 계약은 테이블·전체 컬럼·복합 PK를 검증한다', () => {
  const contract = SCHEMA_CONTRACTS.youtubeOwnerVideoState;
  const result = validateTableContract(definition(contract.columns, contract.primaryKey), contract);
  assert.deepEqual(result.primaryKey, ['channel_id', 'video_id']);
});

test('테이블·컬럼·PK 누락은 적용할 migration까지 명확히 안내한다', () => {
  const contract = SCHEMA_CONTRACTS.youtubeOwnerVideoState;
  assert.throws(() => validateTableContract(null, contract), /008_youtube_owner_video_state\.sql/);
  assert.throws(() => validateTableContract(definition(contract.columns.filter((c) => c !== 'last_seen_at'), contract.primaryKey), contract), /last_seen_at/);
  assert.throws(() => validateTableContract(definition(contract.columns, ['video_id']), contract), /primary key mismatch/);
});

test('OpenAPI self-check는 서비스 역할로 스키마를 읽고 계약을 적용한다', async () => {
  const contract = SCHEMA_CONTRACTS.gasTargetCache;
  const calls = [];
  const result = await checkSupabaseContracts(
    { supabaseUrl: 'https://db.test', supabaseKey: 'service-key' },
    [contract],
    async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ definitions: { gas_target_cache: definition(contract.columns, contract.primaryKey) } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  );
  assert.equal(result[0].table, 'gas_target_cache');
  assert.equal(calls[0].options.headers.Accept, 'application/openapi+json');
});
