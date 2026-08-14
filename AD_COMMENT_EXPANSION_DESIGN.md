# 인지 광고 부정댓글 — 틱톡·유튜브(다크 광고) 확장 설계안

작성 2026-08-14 (Claude), 2026-08-14 확정사항 반영(Codex). 상태: **TikTok 연결·구현 진행 중 / YouTube 인증 대기**.

## 0. 배경·결정

- 현재 인지 광고 부정댓글 감시는 **메타(Graph 웹훅)**만 붙어 있음(`meta-ads.js`/`meta-ads-run.js`).
- 확장 대상: **틱톡·유튜브 광고 전용(다크) 크리에이티브**. 스크래핑으론 안 잡히므로 각 플랫폼 광고/데이터 API 필요.
- 사용자 확정:
  - **틱톡 = 1순위**(부정댓글 많음). 광고 대부분 **광고 전용 영상**(일부 Spark Ads 혼재).
  - **유튜브 = 우리 채널에 올린 비공개(unlisted) 업로드** → **경로 A 확정**(채널 소유자 OAuth로 업로드 나열, **Google Ads API 불필요**).
  - **담당자 = 이재원(awareness)**, 플랫폼을 나누지 않고 **`쫀득바|인지 광고` 스레드 하나로 통합**.
  - **캠페인명에 `빙과` 포함 필수**(TikTok·Google Ads 공통).
  - TikTok advertiser ID = `7495670649415843856`.
  - Google Ads manager ID = `323-466-8229`; 산하 활성 일반 광고계정 전체 대상.

> 정정: YouTube 광고 소재 식별은 Google Ads 계정에 연결된 모든 영상이므로 Google Ads API로
> `YOUTUBE_VIDEO` 자산/업로드의 video ID를 찾고, 댓글 본문은 YouTube Data API로 읽는다.
> 따라서 Google Ads API는 소재 식별 단계에서 필요하다.

## 1. 재사용하는 기존 파이프라인 (변경 없음)

메타 어댑터와 **동일 계약**으로 재사용한다. 신규 어댑터는 아래 입력/출력만 맞추면 된다.

- **엔트리 형태**: `{ target, comments: [...] }[]` (buildMetaAdEntries와 동일 shape)
  - `target`: `{ platform, source, url, channelName, channelCategory, productName, brandName, caption, isManagedAccount, adTitle, extraAssignees, ... }`
  - `comment`: `{ id, platform, url, username, text, timestamp, parentId }`
- **분류**: `classifyTargetsBatched(entries, config, undefined, llmStats, fetchImpl)` (hybrid-classify)
- **dedup**: `commentFingerprint(target, comment)` = `extractPostKey(target.url)` + `comment.id` → `loadSeenFingerprints` / `recordAlert`
- **스레드**: `ensureDailyThread({ kstDate, scopeKey, productLabel, category, assignee })` — scopeKey = `` `${productLabel}|${category}` ``
- **발송**: `sendAlert(config, target, comment, fetchImpl, threadTs)`
- **담당자**: `assigneeForTarget(target, config.slackAssignees)` → `channelCategory`가 '인지' 포함이면 `awareness`(이재원) + `extraAssignees`(제작자)
- **비용**: `recordRunCost`/`maybeAlertCosts` (LLM 사용분)

→ **핵심 차이는 "댓글을 어디서 어떻게 가져오나"(어댑터)뿐.** 메타=웹훅 큐, 틱톡/유튜브=**폴링**.

## 2. 공통 어댑터 골격

각 플랫폼마다 메타의 2파일 구조를 그대로 미러링한다:

| 메타 | 틱톡 | 유튜브 |
|---|---|---|
| `src/meta-ads.js` (config·이벤트·엔트리빌드) | `src/tiktok-ads.js` | `src/youtube-ads.js` |
| `src/meta-ads-run.js` (오케스트레이션) | `src/tiktok-ads-run.js` | `src/youtube-ads-run.js` |

`*-run.js`는 `runMetaAds` 흐름을 복제:
1. 게이트(`inMorningWindow`) — 인지 광고 아침 관리 cadence·비용 상한 목적. 메타와 동일 정책 재사용.
2. 어댑터로 **엔트리 빌드**(폴링).
3. `classifyTargetsBatched` → 코멘트별 `alert` 필터 → dedup(`seen`) → `sendAlert`+스레드 → `recordAlert`.
4. 비용 집계.

**메타와 다른 점**: 웹훅 큐 테이블(`meta_ad_comment_events`)이 없다. 폴링으로 매 실행 시 **현재 댓글을 직접 조회**하고, **재알림 방지는 기존 fingerprint dedup**로 처리(별도 processed 마킹 불필요). 단, API 호출량·비용 절감을 위해 "이번에 새로 본 댓글만" 거르는 얕은 워터마크(마지막 처리 시각/코멘트ID)를 플랫폼별 소형 테이블에 둘 수 있음(선택, 2.1 참고).

### 2.1 폴링 워터마크 (**사실상 필수** — Codex 지적)
- 매 폴링마다 광고별 전체 댓글을 LLM에 넣으면 비용↑. dedup은 발송은 막지만 **LLM 호출은 이미 일어남**. → 선택 아님, **필수**.
- 광고별 `last_seen_comment_at`(또는 마지막 코멘트ID)를 `ad_poll_state`(신규 소형 테이블: platform, ad_ref, last_seen_at, updated_at)에 저장 → 그 이후 댓글만 분류. 초기 1회는 전체.
- ⚠️ **워터마크는 "처리 성공 후"에만 갱신**하고, **짧은 중첩 구간(look-back overlap)**을 둔다(예: last_seen − 수 분). 실패 시 미갱신으로 재시도, 경계 시각 댓글 유실 방지. dedup fingerprint가 중첩분 재발송을 막으므로 안전.

## 3. 틱톡 어댑터 (1순위)

### 소스 — ✅ 공식 API 확정 (2026-08-14 문서검증)
TikTok Business API v1.3 (`business-api.tiktok.com`) 댓글 엔드포인트(공식 SDK 확인):
- `GET /open_api/v1.3/comment/list/` — **"Get comments for your ads"**. 필수: `advertiser_id, start_time, end_time, search_field, search_value, access_token`. 선택: `comment_type, comment_status(공개/숨김), sort_*, page*`.
- `POST /open_api/v1.3/comment/status/update/` — 공개↔**숨김** (→ 카드 [숨김] 버튼이 이걸 호출).
- `GET /open_api/v1.3/comment/reference/` — 대댓글(관련 댓글). `POST comment/post`(답글)·`comment/delete`(삭제)도 있음.
- ⇒ **광고 댓글 조회 + 숨김 모두 API 가능**(첫 검색의 "API 없음"은 오답, 공식 SDK로 반증).

**폴링 모델(확정)**: `comment/list`가 **advertiser_id + [start_time,end_time]** 창 기반이라, 광고별 순회 없이 **"advertiser 한 계정에 대해 지난 창 이후 신규 댓글"**을 한 번에 조회 → §2.1 워터마크(마지막 end_time, 짧은 중첩)와 정확히 맞음. `comment_status=public`으로 미처리만 좁힐 수 있음.
- 필요 정보: `TIKTOK_ADVERTISER_ID`(=`7495670649415843856`, 시크릿), `TIKTOK_ACCESS_TOKEN`(광고계정 OAuth), 앱 `App ID`/`Secret`.
- Spark Ads(공개 부스팅)는 기존 clockworks 스크래퍼로 이미 잡힐 수 있음 → dedup 키(ad_id+comment_id, §11-1)로 이중수집 무해화(같은 comment_id면 fingerprint 동일).

**실계정 검증 남음(승인된 인증 후)**: ① 정확한 권한 스코프 이름(댓글 관리 permission) ② **다크(비-Spark) 광고 댓글이 comment/list에 실제로 나오는지**(문서상 "your ads"라 포함 유력하나 실측 필요) ③ rate limit ④ search_field 허용값(ad_id/campaign 등).

### 매핑
- `target.platform='tiktok'`, `source='tiktok_ads'`, `channelCategory='인지 광고'`(메타와 동일 → 담당자=awareness/이재원, 스레드 병합), `url`=틱톡 영상 URL(`/video/{id}`), `adTitle`=광고 이름(제작자 태그 추출은 메타의 `videoAssigneeFromAdTitle` 재사용 가능 시).
- `comment`: `{ id: 틱톡 comment_id, platform:'tiktok', url, username, text, timestamp }`.
- dedup 키: `extractPostKey(url)` = `tt:{videoId}` + comment_id (기존 함수 그대로 동작).

### 신규 env
```
TIKTOK_APP_ID / TIKTOK_APP_SECRET / TIKTOK_ACCESS_TOKEN / TIKTOK_ADVERTISER_ID
TIKTOK_ADS_WINDOW_START/END (메타와 동일 기본 8/11), TIKTOK_ADS_FORCE
```

### 불확실(구현 시 실측)
- 앱 **심사 승인** 여부·기간(댓글 관리 권한). 리드타임 있음.
- 토큰 만료·갱신(메타의 `meta-token-refresh.yml` 패턴 재사용 가능).
- **숨김(hide) API** 지원 여부(2차, §6).

## 4. 유튜브 어댑터 (경로 A)

### 소스 (식별 = "구글애즈 계정으로 올린 모든 영상")
사용자 결정: 광고 소재 = **Google Ads 계정으로 올린 모든 영상**. 명명규칙/수동리스트 아님. 두 방법이 있고, ⚠️ **대리신호 함정 주의**(아래):

- **경로 B(권장·정본): Google Ads API로 영상 자산 나열.** 광고계정 OAuth → 광고에 쓰인 YouTube 영상 자산의 `video_id` 목록을 **정확히** 확보 → 그 영상만 감시. "구글애즈 영상"의 **정본 소스**.
- **경로 A(단축): 채널 uploads 중 '비공개' 필터.** 채널 소유자 OAuth → uploads 재생목록 나열 → `privacyStatus='unlisted'`만. 인증 1개로 간단하지만 **"비공개 = 구글애즈 영상"은 대리신호**다. 유기적 비공개 업로드가 섞이거나 광고 영상이 공개면 오탐/누락. ([[proxy-signal-vs-real-state]] 교훈)
- **구현 시 검증**: 실계정에서 "채널 비공개 업로드 집합"과 "Google Ads 영상 자산 집합"이 **일치하는지** 대조. 일치하면 경로 A로 단순화 가능(채널 OAuth만), 불일치면 경로 B(Google Ads API OAuth 추가)로 확정. → 인증 범위가 이 검증 결과로 갈림.
- 확정된 영상별 **`commentThreads.list`(part=snippet, videoId, order=time)** 로 최신 댓글 조회. 대댓글은 `comments.list(parentId)` 보완(§11-4).
- ✅ 검증(2026-08-14): 숨김/모더레이션은 **`comments.setModerationStatus`**(값 published/heldForReview/rejected)이며 **채널·영상 소유자 OAuth 필수**. 우리 채널 소유라 충족. 비공개(unlisted) 영상 댓글 읽기는 소유자 OAuth로 가능 예상 → 테스트 영상으로 실측 확정.

### 매핑
- `target.platform='youtube'`, `source='youtube_ads'`, `channelCategory='인지 광고'`, `url`=`https://www.youtube.com/watch?v={id}`(또는 shorts), `adTitle`=영상 제목.
- `comment`: `{ id: youtube comment id, platform:'youtube', url, username(authorDisplayName), text(textOriginal), timestamp }`.
- dedup 키: `extractPostKey(url)` = `yt:{videoId}` + comment id.

### 신규 env
```
YT_ADS_CLIENT_ID / YT_ADS_CLIENT_SECRET / YT_ADS_REFRESH_TOKEN (채널 소유자 OAuth)
YT_ADS_CHANNEL_ID, YT_ADS_WINDOW_START/END, YT_ADS_FORCE
```
- 공개 댓글 읽기만이면 API 키로도 가능하나, **비공개 영상 + 모더레이션(숨김)** 위해 채널 OAuth 권장(단일 경로로 통일).

### 불확실(구현 시 실측)
- 비공개 영상 댓글 읽기: 소유자 OAuth면 확실. 쿼터(Data API quota) 관리.
- 광고 소재 영상 식별 규칙 확정 필요(§7).

## 5. 스케줄링

- `monitor.yml`에 메타 스텝과 나란히 두 스텝 추가(각 `node src/tiktok-ads-run.js`, `node src/youtube-ads-run.js`), `if: always()` + 자체 `inMorningWindow` 게이트. 아침 브래킷 크론(08:3x/08:5x·10:0x)이 그대로 커버.
- 또는 별도 워크플로로 분리(폴링 빈도·쿼터를 독립 관리하고 싶을 때). 1차는 monitor.yml 통합 권고(운영 단순).

## 6. 2차 — 숨김/모더레이션 (web injibot-action)

- 카드 [숨김] 버튼 처리는 **web `influencer-seeding` `injibot-action/route.ts`** 소관(메타는 Graph API로 hide).
- 틱톡: 댓글 관리 API의 hide 지원 시 추가. 유튜브: `comments.setModerationStatus`(채널 OAuth). 
- 1차(감지·알림) 먼저, 숨김은 2차. `source`(`tiktok_ads`/`youtube_ads`)로 분기.

## 7. 확정된 결정 (2026-08-14 사용자)

1. **담당자**: 틱톡/유튜브 모두 **이재원(awareness) 재사용** ✅. `channelCategory`에 '인지' 포함 → `assigneeForTarget`이 그대로 awareness로 라우팅(코드 변경 없음).
2. **스레드**: **`인지 광고` 하나로 통합** ✅. `channelCategory='인지 광고'` 유지 → 제품별 인지 광고 스레드에 메타·틱톡·유튜브 카드가 **함께** 쌓임(카드에 플랫폼 표기). 별도 카테고리 안 만듦.
3. **틱톡 광고계정(advertiser) ID**: 확보됨 ✅. ⚠️ **repo가 PUBLIC이라 값은 문서에 미기재** — 구현 시 GitHub 시크릿 `TIKTOK_ADVERTISER_ID`로 주입. 광고 전용 vs Spark 필터: 광고 유형 필드로 광고 전용만(구현 시 확정).
4. **유튜브 식별**: **"구글애즈 계정으로 올린 모든 영상"을 대상** ✅ → §4 갱신 참고. 명명규칙/수동리스트 아님.

승인 후 각 플랫폼 개발자 앱·OAuth·(틱톡)심사 진행.

## 8. 롤아웃 순서 (권고)

1. **유튜브 경로 A 먼저 PoC** — 인증이 채널 OAuth 하나라 빠름. `youtube-ads.js` 어댑터 + monitor 스텝 + 테스트(폴링·dedup·스레드).
2. **틱톡** — 앱 심사 병행 착수(리드타임). 승인 후 `tiktok-ads.js` 어댑터.
   - 사용자 우선순위는 틱톡이나, **심사 리드타임 동안 유튜브를 먼저 끝내는** 병행이 총 소요 최단.
3. 각 1차(감지·알림) 검증 후 2차(숨김) 추가.

## 9. 테스트·검증

- 어댑터 단위테스트: 폴링 응답 mock → 엔트리 shape, dedup 키(`tt:`/`yt:`), 스레드 scopeKey, 담당자(awareness) 검증. (기존 `test/` 패턴).
- 라이브 검증: 광고 1개에 테스트 댓글 → 감지→스레드→담당자→완료느낌표 end-to-end (메타 go-live 때와 동일 절차, 최소 표본).
- 비용: LLM 호출 수·est USD 로그 확인, 폴링 워터마크로 재분류 억제 확인.

## 10. 계약(유지)

GAS 메타필드(rawEligibleCount/duplicateCount), 인지=이재원, 비용/기본=황경원, 데드존 브래킷+heartbeat, repo PUBLIC, 처리이력 보존, 삭제 전 검증 — 전부 유지. 신규 플랫폼은 위 어댑터로만 추가(파이프라인 불변).

## 11. 구현 전 필수 기술조건 (Codex 보완)

1. **틱톡 dedup 키 = 광고/소재 ID 기반.** 다크 틱톡 광고는 공개 `/video/{id}` URL이 없을 수 있음 → `extractPostKey(url)`가 null/폴백이 되어 URL 기반 fingerprint가 충돌 위험. **`ad_id`(또는 creative_id) + `comment_id`로 안정적 고유 키**를 만들 것. 카드 링크는 메타처럼 폴백(광고계정/프로필) 사용.
2. **`productName` 명시 → 기존 스레드 라우팅.** 두 어댑터의 `target.productName`을 설정해 `productLabel(productGroup(productName))`이 **'쫀득바'**로 해석되게 해야 인지 광고 스레드로 정확히 병합됨(메타는 `metaAdsProductName='JD'→'쫀득바'`). 구현 시 productGroup 매핑 실측 확인(결과가 '쫀득바' 라벨이면 OK).
3. **폴링 워터마크 필수** — §2.1 참고(처리 성공 후 갱신 + 짧은 중첩).
4. **YouTube 답글 전체 수집**: `commentThreads.list`만으로 대댓글이 잘릴 수 있음 → 필요 시 `comments.list`(parentId)로 보완.
5. **틱톡 권한·다크 지원 범위 사전 검증**: 댓글 **조회·숨김** 권한과 **다크 광고 지원 여부**를 공식 API 문서 + 실제 광고계정으로 구현 전 검증(과대약속 금지).

## 12. 계정·자격증명 (값은 로컬 비공개 메모리 — PUBLIC repo 미기재)

- 틱톡 advertiser ID: 확보됨 → 시크릿 `TIKTOK_ADVERTISER_ID`.
- Google Ads Manager(MCC) 계정: 확보됨(경로 B 사용 시) → 시크릿 `GOOGLE_ADS_MANAGER_ID`.
- 실제 값은 `[[ad-comment-expansion-plan]]` 로컬 메모리 참조. 구현 시 GitHub 시크릿으로만 주입.
