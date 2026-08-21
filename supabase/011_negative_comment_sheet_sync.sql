-- 신규 부정댓글을 Google Sheet 로우데이터 탭에 내구성 있게 전달하기 위한 outbox 메타데이터.
-- 기존 1,211개 시딩 행은 이미 시트에 있으므로 마이그레이션 시점의 기존 알림은 synced 처리한다.

alter table public.negative_comment_alerts
  add column if not exists category text,
  add column if not exists reason text,
  add column if not exists product_name text,
  add column if not exists channel_category text,
  add column if not exists channel_name text,
  add column if not exists asset_name text,
  add column if not exists comment_timestamp text,
  add column if not exists sheet_synced_at timestamptz,
  add column if not exists sheet_sync_attempts integer not null default 0,
  add column if not exists sheet_sync_last_error text;

-- 배포 이전분은 대표님이 시트에 1,211행으로 시딩 완료. 재전송하지 않는다.
update public.negative_comment_alerts
set sheet_synced_at = now()
where sheet_synced_at is null;

create index if not exists negative_comment_alerts_sheet_pending_idx
  on public.negative_comment_alerts (alerted_at asc)
  where sheet_synced_at is null;

-- append 연속 실패와 경고 쿨다운을 실행 간 보존한다(단일행).
create table if not exists public.negative_comment_sheet_sync_health (
  id integer primary key check (id = 1),
  consecutive_failures integer not null default 0,
  last_error text,
  last_failed_at timestamptz,
  last_success_at timestamptz,
  last_alerted_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.negative_comment_sheet_sync_health (id)
values (1)
on conflict (id) do nothing;

alter table public.negative_comment_sheet_sync_health enable row level security;

-- 봇은 service role만 사용한다. anon/authenticated 정책은 만들지 않는다.

-- Rollback (sheet sync 이력 삭제이므로 별도 승인 후 실행):
--   drop table if exists public.negative_comment_sheet_sync_health;
--   drop index if exists public.negative_comment_alerts_sheet_pending_idx;
--   alter table public.negative_comment_alerts
--     drop column if exists sheet_sync_last_error,
--     drop column if exists sheet_sync_attempts,
--     drop column if exists sheet_synced_at,
--     drop column if exists comment_timestamp,
--     drop column if exists asset_name,
--     drop column if exists channel_name,
--     drop column if exists channel_category,
--     drop column if exists product_name,
--     drop column if exists reason,
--     drop column if exists category;
