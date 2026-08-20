-- Owner OAuth가 있는 YouTube 채널의 최근 업로드 댓글수 델타 상태.
-- 실제 댓글 ID/OAuth 토큰은 저장하지 않는다. 댓글수 변화가 있을 때만 commentThreads를 다시 읽는다.
create table if not exists public.youtube_owner_video_state (
  channel_id text not null,
  video_id text not null,
  video_title text,
  published_at timestamptz,
  comment_count bigint,
  last_scanned_count bigint,
  last_seen_at timestamptz not null default now(),
  last_scanned_at timestamptz,
  primary key (channel_id, video_id)
);

create index if not exists youtube_owner_video_state_recent_idx
  on public.youtube_owner_video_state (channel_id, published_at desc);

alter table public.youtube_owner_video_state enable row level security;
-- 정책 미생성 = anon/authenticated 차단. GitHub Actions의 service_role만 read/write.

-- Rollback (데이터 삭제이므로 별도 승인 후 실행):
--   drop table if exists public.youtube_owner_video_state;
