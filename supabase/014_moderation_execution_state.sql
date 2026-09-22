-- 사람의 숨김 결정(review_decision='hide')과 플랫폼의 실제 숨김 성공을 분리한다.
-- review_decision은 감사 이력, hidden_confirmed는 플랫폼 지상진실이다.
alter table public.negative_comment_alerts
  add column if not exists hidden_confirmed boolean not null default false,
  add column if not exists hidden_confirmed_at timestamptz;

-- hidden/author_banned은 기존 코드에서도 플랫폼 API 성공 뒤에만 기록한 값이다.
-- hide/hold/complete 및 legacy null 행은 의도적으로 백필하지 않는다.
update public.negative_comment_alerts
set hidden_confirmed = true,
    hidden_confirmed_at = coalesce(hidden_confirmed_at, reviewed_at, alerted_at, now())
where review_decision in ('hidden', 'author_banned')
  and hidden_confirmed = false;

create index if not exists negative_comment_alerts_unconfirmed_moderation_idx
  on public.negative_comment_alerts (hidden_confirmed, review_decision, alerted_at);

-- 기존 negative_comment_alerts RLS 정책을 그대로 사용한다. 봇 service role만 읽고 쓴다.
