# 부정댓글 모니터링 알람봇

활성 협찬 게시물의 라라스윗·쫀득바 관련 부정 댓글을 탐지해 Slack 채널 `C0BHD9S69JA`로 알립니다. `채널 분류`에 `무상시딩`이 포함된 행은 제외합니다.

## 비용 최적화 수집

- 관리 계정의 Instagram 부스팅 게시물: Graph API 우선
- Graph 웹훅 연결 대상: 폴링하지 않음
- 게시 후 7일 이내 또는 부스팅 중: 1시간 간격
- 게시 후 8~30일: 6시간 간격
- 30일 초과: 하루 1회
- 부정 댓글 발견 직후: 3시간 동안 15분 간격
- 나머지 Instagram·YouTube·TikTok: Apify 배치 수집

실행기를 자주 호출해도 `lastCollectedAt`을 기준으로 도래한 게시물만 수집합니다. GAS의 `sponsoredTargets` 응답에 `publishedAt`, `lastCollectedAt`, `recentNegativeDetectedAt`을 포함해야 적응형 주기가 적용됩니다.

## Slack 버튼

- `온드미디어`, `위성채널`: `숨김`, `승인`, `보류`, `숨김해제`
- 그 외 계정: `✅ 완료`, `🙈 무시`

관리 버튼은 실제 계정 권한이 있는 경우에만 노출합니다. Slack 인터랙션 요청은 `X-Slack-Signature` 검증 후 처리해야 합니다.
`handleSlackInteraction()`은 클릭 요청을 검증하고 GAS `sponsoredSlackAction`으로 전달한 뒤, 처리 결과와 처리자를 원래 Slack 메시지에 갱신합니다.

## 실행

1. `.env.example`을 `.env`로 복사하고 실제 비밀값을 로컬 실행 환경에만 입력합니다.
2. 처음에는 `DRY_RUN=true`로 실행합니다.
3. `npm test`로 분류·라우팅·버튼·주기 테스트를 수행합니다.
4. `npm start`를 실행합니다.

채팅에 노출된 Slack 토큰은 재발급한 뒤 `SLACK_BOT_TOKEN`에 넣는 것을 권장합니다.
