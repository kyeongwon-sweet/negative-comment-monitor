-- Meta(IG/FB) 액세스 토큰 저장소. 자동 갱신이 GitHub 시크릿을 건드리지 않고 여기서 갱신한다.
-- 토큰 값은 service_role만 접근(민감). RLS로 anon 차단.
create table if not exists meta_tokens (
  kind        text primary key,               -- 예: 'ig_ads'
  token       text not null,
  expires_at  timestamptz not null,
  updated_at  timestamptz not null default now()
);

alter table meta_tokens enable row level security;
-- 정책 미생성 = anon/authenticated 접근 불가(service_role은 RLS 우회). 의도적.
