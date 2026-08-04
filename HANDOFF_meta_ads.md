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

## 이미 완료 (커밋 `ddbc72b`, 169 tests)
토큰 관리 모듈:
- `src/meta-token.js`: `exchangeLongLivedToken`(fb_exchange_token, 60일), `ensureFreshToken`(만료 7일 이내 재교환), `loadMetaToken`/`saveMetaToken`(Supabase `meta_tokens`, kind='ig_ads'). Graph v21.0.
- `scripts/meta-token-exchange.mjs`(최초 교환), `scripts/meta-token-refresh.mjs` + `.github/workflows/meta-token-refresh.yml`(매일 09:17 KST).
- `supabase/006-meta-tokens.sql`(**DDL 미실행** — Supabase SQL 에디터에서 실행 필요).

## 🚧 블로커 (진행 전 필요 — 사용자 대기)
1. **올바른 권한 토큰.** 사용자 최초 토큰은 `ads_management, ads_read, public_profile`만 → 댓글 불가(`pages:[]`). 재발급 필요: `instagram_manage_comments` + `instagram_basic` + `pages_read_engagement` + `pages_show_list` + `ads_read`, **IG 연결 FB 페이지 선택 필수**(페이지 없는 IG 로그인이면 `instagram_business_manage_comments`).
2. **App ID + App Secret**(fb_exchange_token 필수).
3. 위 3개를 **로컬 `.env`**(`META_APP_ID`·`META_APP_SECRET`·`META_SHORT_TOKEN`)에. 채팅 금지.

## 토큰 준비되면 순서
1. `006-meta-tokens.sql` DDL 실행.
2. `node scripts/meta-token-exchange.mjs`(env로 자격증명) → 60일 토큰 저장.
3. GitHub 시크릿 `META_APP_ID`·`META_APP_SECRET` 등록.
4. **수집**: `act_550617335901928` 광고 열거 → creative의 IG 미디어 → `/{ig-media}/comments` → `classifyTargetsBatched` 재사용 → 악플만.
5. **라우팅**: `assigneeForTarget({channelCategory:'인지 광고', productName:'쫀득바'})`. '인지 광고'는 JD 규칙 밖 → **폴백 other=황경원으로 이미 라우팅됨**(신규 변수 불필요). 스레드 `쫀득바|인지 광고`.
6. **[숨김] 버튼**: injibot-action 라우트(influencer-seeding `web/app/api/slack/injibot-action/route.ts`) 또는 신규 핸들러 → Meta Graph `POST /{ig-comment-id}` (hide=true), 저장 토큰 사용. 사람 클릭만.
7. 테스트 댓글 검증 후 배포.

## 참고
- 담당자 폴백: JD/P 지정조합 외 전부 황경원(`SLACK_ASSIGNEE_OTHER`)(커밋 `89347a2`).
- 협찬 봇의 slack.js/threads.js/injibot 라우트 구조 재사용.
- Graph API v21.0. 토큰은 Supabase `meta_tokens`(kind='ig_ads')에서 `loadMetaToken`/`ensureFreshToken`로 읽기.
