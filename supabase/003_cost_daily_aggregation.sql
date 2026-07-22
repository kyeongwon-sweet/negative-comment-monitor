-- 일별(KST) 비용 집계 + 경고 상태. GitHub Actions 요약만으로는 실행 간 누적이 불가능해
-- 최소 집계 테이블을 둔다. 분류·알림·중복방지·캐시와는 독립적이다.

-- 실행별 비용 원장. run_key = github_run_id + attempt(또는 고유 실행 ID)로 멱등 →
-- 재시도해도 같은 실행이 중복 합산되지 않는다. KST 일자 합은 이 원장을 SUM해서 구한다.
create table if not exists public.cost_usage_ledger (
  run_key text primary key,
  kst_date date not null,
  apify_usd double precision not null default 0,
  anthropic_usd double precision not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists cost_usage_ledger_kst_date_idx
  on public.cost_usage_ledger (kst_date);

-- 경고 발송 기록. (kst_date, kind) 유일 → 임계치 종류별 하루 최초 초과 1회만 발송.
-- kind: 'apify' | 'anthropic' | 'total'.
create table if not exists public.cost_alert_log (
  kst_date date not null,
  kind text not null,
  threshold_usd double precision not null,
  amount_usd double precision not null,
  alerted_at timestamptz not null default now(),
  primary key (kst_date, kind)
);

alter table public.cost_usage_ledger enable row level security;
alter table public.cost_alert_log enable row level security;

-- The monitor uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- Do not expose these tables to anon/authenticated roles.

-- Rollback:
--   drop table if exists public.cost_alert_log;
--   drop table if exists public.cost_usage_ledger;
-- (집계·경고만 사라지고 분류·알림엔 영향 없음.)
