import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/015_monitor_target_state.sql', import.meta.url), 'utf8');

test('monitor target-state RPC는 요청 키만 조회하고 최신 non-null 댓글 상태를 한 행으로 만든다', () => {
  assert.match(sql, /create or replace function public\.monitor_comment_target_state\s*\(/i);
  assert.match(sql, /where p\.normalized_key = any\(/i);
  assert.match(sql, /left join lateral\s*\(\s*select s\.comments_count/i);
  assert.match(sql, /s\.post_id = p\.id/i);
  assert.match(sql, /s\.measured_at >= p_cutoff/i);
  assert.match(sql, /s\.comments_count is not null/i);
  assert.match(sql, /unique\(post_id, measured_at\)/i);
  assert.match(sql, /order by s\.measured_at desc\s*limit 1/i);
  assert.match(sql, /left join public\.post_comment_checks checks on checks\.post_id = p\.id/i);
});

test('monitor target-state RPC 권한은 service_role만 허용하고 감사 이력/과부하 테이블을 건드리지 않는다', () => {
  assert.match(sql, /security invoker/i);
  assert.match(sql, /revoke all on function public\.monitor_comment_target_state\(text\[\], date\) from public/i);
  assert.match(sql, /from anon/i);
  assert.match(sql, /from authenticated/i);
  assert.match(sql, /grant execute on function public\.monitor_comment_target_state\(text\[\], date\) to service_role/i);
  assert.doesNotMatch(sql, /negative_comment_alerts/i);
});
