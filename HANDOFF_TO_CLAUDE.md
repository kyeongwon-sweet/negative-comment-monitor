# 부정댓글 모니터링 알람봇 작업 인계서

## 작업 위치

`C:\Users\hwangkw\Documents\부정댓글 모니터링 알람봇`

## 목표

Google Sheets의 활성 협찬 게시물 URL을 기준으로 공개 댓글을 수집하고, 라라스윗·쫀득바에 대한 부정 댓글만 Slack 채널 `C0BHD9S69JA`에 알린다.

지원 우선순위는 Instagram, YouTube, TikTok, X(Twitter)이다. `채널 분류`에 `무상시딩`이 포함된 행은 항상 제외한다.

## 원본 데이터

- Spreadsheet ID: `10WpAQU9TAsi3hRZ3ELvcQYj7Z228ILXfF6BUGz495Ak`
- Sheet: `콘텐츠 대시보드 연동`
- 주요 열: A `업로드일`, B `게시물URL`, F `채널 분류`
- Slack 대상 채널: `C0BHD9S69JA`
- 2026-07-15 확인 기준: 게시일 2026-07-02~07-15, 무상시딩 제외 대상 189개
- 이번 주 댓글 기준: 2026-07-13 00:00 KST 이후 작성

## 수집·전송 기준

- 라라스윗 또는 쫀득바 관련 맥락이 있어야 한다.
- 제품/맛/가격 불만, 광고·바이럴 의심, 비추천·별로, 욕설·비속어 등을 탐지한다.
- 단순 욕설이나 부정 단어가 있어도 브랜드·제품과 무관하면 제외한다.
- 동일 댓글은 플랫폼 + comment ID 기준으로 중복 전송하지 않는다.
- 온드미디어·위성채널: 숨김/승인/보류/숨김해제 버튼.
- 그 외 계정: 처리완료/무시 버튼.
- 외부 계정은 실제 댓글 숨김·삭제를 시도하지 않는다.

## 운영 주기

- 보유 Instagram + 부스팅 + Graph 연결 가능: Graph API/Webhook 우선.
- 업로드 7일 이내 또는 부스팅 게시글: 1시간 간격.
- 업로드 8~30일: 6시간 간격.
- 그 이후: 하루 1회.
- 부정 댓글 탐지 후 3시간: 15분 간격.
- 모든 시간은 KST.

## 선택한 Apify Actor

- Instagram: `apify~instagram-comment-scraper`
  - `directUrls`, `resultsLimit: 10`, `includeNestedComments: false`
- YouTube: `streamers~youtube-comments-scraper`
  - `startUrls`, `maxComments: 30`, `sortCommentsBy: NEWEST_FIRST`, `oldestCommentDate: 7 days`
- TikTok: `clockworks~tiktok-comments-scraper`
  - `postURLs`, `commentsPerPost: 30`, `maxRepliesPerComment: 0`
- X(Twitter): `apidojo~twitter-replies-scraper`
  - `startUrls`, 기본 replies flow, URL 수 × 30개 상한
  - 외부 계정은 `처리완료 / 무시` 버튼만 제공
  - 기본 replies flow가 누락되는 특정 게시물만 `useSearch: true`로 재시도

토큰과 Slack 비밀값은 로컬 `.env`에 있다. 값을 출력하거나 문서·Git에 넣지 말 것. 이 대화에 노출된 토큰들이므로 운영 전 회전 권장.

## 현재 구현 파일

- `src/run.js`: 전체 실행 흐름
- `src/config.js`: 환경변수
- `src/gas.js`: GAS 대상 조회 및 결과 제출
- `src/apify.js`: Actor 실행과 플랫폼별 입력 매핑
- `src/normalize.js`: 플랫폼 결과 공통 댓글 구조 변환
- `src/classify.js`, `src/keywords.js`: 부정 댓글 분류
- `src/routing.js`: 플랫폼/Graph/Apify 라우팅, 무상시딩 제외
- `src/schedule.js`: 적응형 수집 주기
- `src/slack.js`: Slack 블록과 버튼
- `src/interaction.js`: Slack 서명 검증 및 버튼 처리
- `test/`: 테스트

## 현재 검증 상태

`npm.cmd test` 실행 결과 25개 테스트가 모두 통과했다.

```powershell
cd 'C:\Users\hwangkw\Documents\부정댓글 모니터링 알람봇'
npm.cmd test
```

## 현재 차단 요소

사용자가 아래 GAS 웹 앱 URL을 제공했고 `.env`에 반영했다.

`https://script.google.com/macros/s/AKfycbzwJ5VoWqaNmtxBLg3uW5pdhUaiWYNQeESy7ejlCSEb08Hxd9CaYDilwue3EgLG8vU-/exec`

배포 ID는 `AKfycbzwJ5VoWqaNmtxBLg3uW5pdhUaiWYNQeESy7ejlCSEb08Hxd9CaYDilwue3EgLG8vU-`이다. 실행에는 배포 ID가 아니라 위 `/exec` URL을 사용한다.

`.env`의 아래 값은 아직 비어 있다.

```env
GAS_VERIFY_TOKEN=
```

기존 GAS가 `sponsoredTargets`, `sponsoredRpaResult`, `sponsoredSlackAction`을 실제로 지원하는지 반드시 코드 또는 응답으로 검증한다. 지원하지 않으면 기존 GAS에 호환 endpoint를 추가하고 새 버전으로 배포한다.

## 다음 작업 순서

1. GAS 검증 키를 기존 Script Properties에서 확인하거나 새로 발급하고 `GAS_VERIFY_TOKEN`에 저장한다. 채팅/로그에 출력하지 않는다.
2. `DRY_RUN=true` 상태로 `sponsoredTargets`를 호출한다.
3. 대상 수, 날짜, URL, 채널 분류를 읽어 189개 범위와 재검증한다.
4. Actor별 실제 게시물 1개로 소액 smoke test를 수행한다.
5. 댓글 본문·comment ID·작성시간·원본 URL 매핑을 확인한다.
6. 이번 주 작성 댓글만 남기고 분류 결과를 수동 샘플 검토한다.
7. 오탐이 없으면 `DRY_RUN=false`로 전환해 Slack 채널에 전송한다.
8. Slack에서 실제 메시지, 링크, 버튼 종류와 중복 방지를 확인한다.
9. 비용과 Actor run ID, 성공/실패 대상 수를 작업 결과에 기록한다.

## 중요한 검증 원칙

- 실제 수집하지 못한 플랫폼을 `부정 댓글 없음`으로 보고하지 않는다.
- 시트 데이터, Actor dataset, Slack 실제 메시지로 완료를 입증한다.
- 댓글 30개/일은 알림 수가 아니라 Actor가 반환한 전체 결과 수에 따라 과금된다는 점을 유지한다.
- 반복 조회로 같은 댓글이 다시 과금될 수 있으므로 최근 댓글 상한과 수집 주기를 지킨다.
- 현재 일부 소스 파일의 한국어가 mojibake처럼 보일 수 있다. 실행 전 `src/config.js`, `src/keywords.js`, `src/classify.js`, `src/routing.js`의 실제 UTF-8 문자열을 반드시 점검하고, 깨져 있다면 정상 한국어로 복구한 뒤 테스트를 추가한다.

## 추가 플랫폼 검토 결과

- X/Twitter: `apidojo~twitter-replies-scraper`로 구현에 추가됨. 실제 URL smoke test가 남아 있음.
- 네이버 클립: 공개 댓글 API가 확인되지 않아 실제 URL 기반 RPA 파일럿 필요.
- 카카오 숏폼: 공개 API가 확인되지 않고 앱/로그인 의존성이 커 모바일 RPA 가능성 검토 필요.
- 추가 플랫폼 외부 계정에는 우선 처리완료/무시 버튼만 제공한다.
