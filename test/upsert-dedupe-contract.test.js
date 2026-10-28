import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 2026-10-28 재발방지 계약: PostgREST 'merge-duplicates'(ON CONFLICT DO UPDATE)로 여러 행을 한 번에
// 보내면, 같은 충돌키가 배열 안에 두 번 있을 때 문장 전체가 500으로 거부된다(소유채널 state 2행 중복 사고).
// merge-duplicates를 쓰는 파일은 아래 목록에 분류돼 있어야 한다. 새 파일이 생기면 이 테스트가 실패한다 →
// 여러 행을 보내면 충돌키 기준 중복 제거를 넣고 BULK에, 한 행만 보내면 SINGLE에 추가할 것.
const BULK_WITH_DEDUPE = {
  'cache.js': 'storeCache — fingerprint 기준 Map 병합',
  'delta.js': 'recordChecks — post_id seen Set',
  'youtube-owner-channel.js': 'saveOwnerVideoStates — dedupeOwnerStateRows',
};
const SINGLE_ROW = ['gas.js', 'meta-token.js', 'monitor-scan-heartbeat.js', 'negative-comment-sheet-sync.js', 'platform-health.js'];

test('merge-duplicates 업서트를 쓰는 파일은 모두 중복 방어 여부가 분류돼 있다', () => {
  const srcDir = path.resolve('src');
  const users = fs.readdirSync(srcDir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => fs.readFileSync(path.join(srcDir, name), 'utf8').includes('merge-duplicates'))
    .sort();
  const known = [...Object.keys(BULK_WITH_DEDUPE), ...SINGLE_ROW].sort();
  assert.deepEqual(users, known, '새 merge-duplicates 사용처: 다중 행이면 충돌키 중복 제거 후 BULK_WITH_DEDUPE에 등록');
});
