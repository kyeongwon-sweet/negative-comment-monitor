-- GAS sponsoredTargets가 일시 장애일 때 마지막 성공 응답으로 degraded 운영하기 위한 단일행 캐시.
-- DB 정책을 재현하지 않고 GAS의 정규 출력만 보관한다.
create table if not exists public.gas_target_cache (
  id integer primary key,
  targets jsonb not null,
  count integer,
  fetched_at timestamptz not null default now()
);

alter table public.gas_target_cache enable row level security;
-- 정책 미생성 = anon/authenticated 차단. GitHub Actions service_role만 read/write.

-- Rollback (캐시 데이터 삭제이므로 별도 승인 후 실행):
--   drop table if exists public.gas_target_cache;
