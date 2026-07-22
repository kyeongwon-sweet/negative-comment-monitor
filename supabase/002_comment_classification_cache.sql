-- 분류 결과 캐시. 같은 댓글(fingerprint)을 분류기(classifier_hash)가 바뀌지 않은 동안
-- 다시 LLM에 보내지 않기 위한 테이블. negative_comment_alerts(중복방지)와는 별개.
-- classifier_hash에는 keywords.js/classify.js/llm.js(프롬프트·출력스키마)+모델 ID가 반영돼,
-- 분류 로직이 바뀌면 새 해시로 저장되며 옛 캐시는 자연히 조회되지 않는다(자동 무효화).
create table if not exists public.comment_classification_cache (
  fingerprint text not null,
  classifier_hash text not null,
  alert boolean not null,
  category text not null,
  reason text not null default '',
  priority text not null default 'normal',
  created_at timestamptz not null default now(),
  primary key (fingerprint, classifier_hash)
);

-- 90일 초과분 정리(purgeCache의 created_at < cutoff DELETE)용 인덱스.
create index if not exists comment_classification_cache_created_at_idx
  on public.comment_classification_cache (created_at);

alter table public.comment_classification_cache enable row level security;

-- The monitor uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- Do not expose this table to anon/authenticated roles.

-- Rollback:
--   drop table if exists public.comment_classification_cache;
-- (캐시만 제거되며 분류·알림·중복방지에는 영향 없음 — 다음 실행부터 전량 실시간 분류로 복귀.)
