-- YouTube 소유채널 상습 악플러를 comment_id가 아닌 안정적인 작성자 채널 ID로 집계한다.
-- 새 댓글은 수집 시점에 저장하고, 과거 댓글은 owner OAuth comments.list로 best-effort 보강한다.
alter table public.negative_comment_alerts
  add column if not exists author_channel_id text,
  add column if not exists author_display_name text;

create index if not exists negative_comment_alerts_youtube_author_idx
  on public.negative_comment_alerts (author_channel_id, alerted_at desc)
  where platform = 'youtube' and author_channel_id is not null;

-- 기존 RLS/service-role 계약을 그대로 사용한다.

-- Rollback (작성자 집계 이력이 삭제되므로 별도 승인 후 실행):
--   drop index if exists public.negative_comment_alerts_youtube_author_idx;
--   alter table public.negative_comment_alerts
--     drop column if exists author_display_name,
--     drop column if exists author_channel_id;
