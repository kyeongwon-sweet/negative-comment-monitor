-- Reduce negative-comment-monitor PostgREST egress without changing decisions.
--
-- The old client downloaded every sponsored post and every post_daily_stats row
-- from the last 30 days on every wake.  This RPC accepts only the target identity
-- keys for the current run and returns one exact state row per matching post.
-- The application keeps a legacy fallback and can shadow-compare both paths.

create or replace function public.monitor_comment_target_state(
  p_keys text[],
  p_cutoff date
)
returns table (
  normalized_key text,
  post_id uuid,
  content_summary text,
  product_name text,
  ended_at date,
  not_found_streak integer,
  asset_name text,
  current_count bigint,
  last_count bigint,
  last_checked_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.normalized_key,
    p.id as post_id,
    p.content_summary,
    p.product_name,
    p.ended_at::date,
    coalesce(p.not_found_streak, 0)::integer,
    p.asset_name,
    latest.comments_count::bigint as current_count,
    checks.last_count::bigint,
    checks.last_checked_at
  from public.sponsored_posts p
  left join lateral (
    select s.comments_count
    from public.post_daily_stats s
    where s.post_id = p.id
      and s.measured_at >= p_cutoff
      and s.comments_count is not null
    -- post_daily_stats has UNIQUE(post_id, measured_at), so this uses that index
    -- backwards and cannot tie on a date.
    order by s.measured_at desc
    limit 1
  ) latest on true
  left join public.post_comment_checks checks on checks.post_id = p.id
  where p.normalized_key = any(coalesce(p_keys, array[]::text[]));
$$;

revoke all on function public.monitor_comment_target_state(text[], date) from public;
revoke all on function public.monitor_comment_target_state(text[], date) from anon;
revoke all on function public.monitor_comment_target_state(text[], date) from authenticated;
grant execute on function public.monitor_comment_target_state(text[], date) to service_role;

-- Rollback (only after the optimized application path is disabled):
--   drop function if exists public.monitor_comment_target_state(text[], date);
