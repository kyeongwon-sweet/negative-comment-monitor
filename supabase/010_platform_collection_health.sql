-- 플랫폼별 수집 장애의 연속 횟수를 기록한다.
-- 단일·일시 장애는 fail-soft, N회 연속 장애만 상위 실패 알림으로 승격하기 위한 상태다.
create table if not exists public.platform_collection_health (
  platform text primary key,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_status text not null default 'success' check (last_status in ('success', 'failure')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  last_alerted_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.platform_collection_health enable row level security;
-- anon/authenticated 정책 없음. GitHub Actions service_role만 read/write.

-- Rollback (상태 이력 삭제이므로 별도 승인 후 실행):
--   drop table if exists public.platform_collection_health;
