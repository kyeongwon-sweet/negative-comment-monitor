-- 모니터 헬스체크(heartbeat) — 단일 행(id=1).
-- 봇이 매 실행마다 last_run_at을, 09:10 KST 이후 정상 완료한 일일 점검마다
-- last_daily_pass_at / last_daily_pass_kst_date 를 갱신한다.
-- 마감 시각(기본 13:00 KST)까지 오늘 일일 점검이 안 되면 Slack 경고를 보내고
-- last_warning_kst_date 로 하루 1회만 알린다.
create table if not exists public.monitor_heartbeat (
  id smallint primary key default 1,
  last_run_at timestamptz,
  last_daily_pass_at timestamptz,
  last_daily_pass_kst_date text,
  last_warning_kst_date text,
  updated_at timestamptz not null default now(),
  constraint monitor_heartbeat_singleton check (id = 1)
);

insert into public.monitor_heartbeat (id) values (1) on conflict (id) do nothing;

alter table public.monitor_heartbeat enable row level security;

-- The monitor uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- Do not expose this table to anon/authenticated roles.
