-- Core monitor scan completion ledger.
-- GitHub workflow run start times are not scan times because one run may contain
-- several 15-minute iterations. Keep the actual successful scan completions so
-- the watchdog measures coverage gaps instead of scheduler/job duration gaps.
create table if not exists public.monitor_scan_heartbeats (
  scan_key text primary key,
  scanned_at timestamptz not null,
  run_id text,
  run_attempt integer,
  iteration integer not null check (iteration > 0),
  trigger_event text,
  trigger_schedule text,
  created_at timestamptz not null default now()
);

create index if not exists monitor_scan_heartbeats_scanned_at_idx
  on public.monitor_scan_heartbeats (scanned_at desc);

alter table public.monitor_scan_heartbeats enable row level security;
-- anon/authenticated policies intentionally omitted. GitHub Actions service_role only.

-- Rollback (coverage history is diagnostic only):
--   drop table if exists public.monitor_scan_heartbeats;
