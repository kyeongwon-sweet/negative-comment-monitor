-- 날짜 × 채널분류별 '부모 스레드' ts 저장. 부정댓글은 이 스레드의 답글로 묶여 발송된다.
-- 분류·알림·중복방지와 독립적이며, 미실행 시 봇은 기존 최상위 메시지 방식으로 자동 폴백한다.
create table if not exists public.alert_threads (
  kst_date date not null,
  channel_category text not null,
  slack_channel_id text not null,
  slack_ts text not null,
  created_at timestamptz not null default now(),
  primary key (kst_date, channel_category, slack_channel_id)
);

alter table public.alert_threads enable row level security;

-- The monitor uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- Do not expose this table to anon/authenticated roles.

-- Rollback:
--   drop table if exists public.alert_threads;
-- (스레드 묶음만 사라지고 알림 자체엔 영향 없음 — 최상위 메시지 방식으로 복귀.)
