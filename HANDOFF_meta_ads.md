# 인계: Meta(IG) 광고 댓글 모더레이션 (negative-comment-monitor)

> 새 Claude 세션이 이어받는 문서. repo `kyeongwon-sweet/negative-comment-monitor` (master), 로컬 `C:\Users\hwangkw\Documents\부정댓글 모니터링 알람봇`.

## 목표
인스타 광고 댓글을 봇이 수집 → LLM 악플 분류 → 담당자 스레드 알림 → **[숨김] 버튼(사람 클릭)으로 Meta Graph API 숨김**.

## 사용자 확정 사항
- **방식 ②**: 봇으로 흡수 + 상품×카테고리 라우팅.
- **상품 = 쫀득바(현재 이것만), 카테고리 = [인지 광고](신규), 담당자 = 황경원**(`U0B2Y0ZC8QZ`).
- **알림 채널 = 기존 `C0BHD9S69JA`** (협찬 악플과 동일). 스레드 스코프 = `쫀득바|인지 광고`.
- **숨김 = 사람이** ([숨김] 클릭 시 Meta API 숨김, 자동숨김 금지).
- **광고계정 = `act_550617335901928`**("라라스윗 서브광고계정", 활성).
- 토큰: 사용자 단기 발급 → 60일 장기 교환 → 자동갱신.

## ⚠️ 중복 금지 — 별개 시스템 존재 (건드리지 말 것)
회사 다른 분의 IG 댓글 모더레이션이 이미 운영 중: 채널 `#통합_dm댓글승인관리`(`C0B9RR4E8NR`) + 시트 "인스타그램_댓글_자동화"(`1PTunbNbzFH_ecUsKqDmHA_XU4RIo2p2L3ZndxEWbw8M`), 숨김/승인/보류/숨김해제 버튼 + 6단계 승인 거버넌스. 우리는 Meta 토큰으로 자립 수집하는 **별도 경로**를 만든다.

## 완료 상태 (2026-08-04)
토큰 관리 모듈(`ddbc72b`)과 광고 댓글 경로:
- `src/meta-token.js`: `exchangeLongLivedToken`(fb_exchange_token, 60일), `ensureFreshToken`(만료 7일 이내 재교환), `loadMetaToken`/`saveMetaToken`(Supabase `meta_tokens`, kind='ig_ads'). Graph v26.0.
- `scripts/meta-token-exchange.mjs`(최초 교환), `scripts/meta-token-refresh.mjs` + `.github/workflows/meta-token-refresh.yml`(매일 09:17 KST).
- `supabase/006-meta-tokens.sql` DDL 실행 완료.
- 권한 실측 완료: `ads_read`, `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`, `pages_show_list`. `lalasweet_icecream` 연결 페이지와 광고계정 `act_550617335901928` 접근 확인.
- 동적 광고 creative에는 `effective_instagram_story_id`가 없어 광고 열거 방식 대신 Meta 공식 권장 Webhook 사용.
- `supabase/007_meta_ad_comment_events.sql` 실행 완료: 광고댓글 대기열 + 알림 출처/광고 식별 컬럼.
- Vercel `/api/meta/instagram-comments`: HMAC 검증 후 `ad_id`가 있는 댓글 이벤트만 대기열 저장.
- 기존 15분 `monitor.yml` 안에서 `src/meta-ads-run.js` 실행: 기존 캐시/LLM/중복방지/스레드/비용집계 재사용.
- 라우팅: `[쫀득바] 인지 광고`, 황경원. 버튼은 `[숨김]`·`[무시]`만.
- Vercel injibot-action: DB의 Slack channel+ts로 Meta 댓글 ID를 조회한 뒤 `POST /{comment-id}?hide=true`; Graph 성공 전에는 Slack 답글을 삭제하지 않음.
- 회귀: monitor 176 tests, influencer-seeding web 160 tests + Next production build 통과.

## 🚧 남은 블로커 (사용자 입력 필요)
1. 채팅에 노출되지 않은 새 단기 토큰을 로컬 `.env`의 `META_SHORT_TOKEN`에 저장.
2. App ID(`965303019541316`)와 App Secret을 `.env`의 `META_APP_ID`·`META_APP_SECRET`에 저장(채팅 금지).
3. 장기 토큰 교환 후 Vercel에 `META_APP_SECRET`·`META_WEBHOOK_VERIFY_TOKEN`을 설정하고 Meta 앱 Webhook callback을 운영 URL에 연결.

## 자격증명 준비 후 마무리 순서
1. `node scripts/meta-token-exchange.mjs` → 60일 토큰을 Supabase에 저장.
2. GitHub 시크릿 `META_APP_ID`·`META_APP_SECRET` 등록(갱신 workflow용).
3. Vercel 운영 env 2개 등록 후 프로덕션 배포.
4. Meta 앱 Webhooks 제품에서 Instagram `comments` 구독 + callback 검증.
5. 테스트 광고 댓글 1건으로 수신→분류→Slack→사람 `[숨김]`을 종단 검증.

## 참고
- 담당자 폴백: JD/P 지정조합 외 전부 황경원(`SLACK_ASSIGNEE_OTHER`)(커밋 `89347a2`).
- 협찬 봇의 slack.js/threads.js/injibot 라우트 구조 재사용.
- Graph API v26.0. 토큰은 Supabase `meta_tokens`(kind='ig_ads')에서 `loadMetaToken`/`ensureFreshToken`로 읽기.
