-- Slack [무시] → 사람 오탐(false_positive) 피드백을 기록하기 위한 컬럼.
-- 사람 판정은 분류기 해시가 바뀌어도 우선 적용되며(재알림 금지), classifier hash별 오탐률 집계에 쓰인다.
alter table public.negative_comment_alerts
  add column if not exists review_decision text,        -- 예: 'false_positive'
  add column if not exists reviewed_by text,            -- Slack user id
  add column if not exists reviewed_at timestamptz,
  add column if not exists false_positive_reason text,  -- 사유 코드(제품무관/긍정중립/농담밈/타인욕설/경쟁중립/기타)
  add column if not exists classifier_hash text;        -- 알림 당시 classifier_hash(오탐률 집계용)

-- 오탐 지문 조회(loadFalsePositives)·해시별 집계 가속.
create index if not exists negative_comment_alerts_review_idx
  on public.negative_comment_alerts (review_decision);
create index if not exists negative_comment_alerts_classifier_hash_idx
  on public.negative_comment_alerts (classifier_hash);

-- Rollback:
--   drop index if exists public.negative_comment_alerts_classifier_hash_idx;
--   drop index if exists public.negative_comment_alerts_review_idx;
--   alter table public.negative_comment_alerts
--     drop column if exists classifier_hash,
--     drop column if exists false_positive_reason,
--     drop column if exists reviewed_at,
--     drop column if exists reviewed_by,
--     drop column if exists review_decision;
