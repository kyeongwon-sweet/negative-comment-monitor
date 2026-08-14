# 인지 광고 부정댓글 — 틱톡·유튜브(다크 광고) 확장 설계안

작성 2026-08-14 (Claude). 상태: **설계 단계** — 구현·인증·자격증명은 사용자 승인 후.

## 0. 배경·결정

- 현재 인지 광고 부정댓글 감시는 **메타(Graph 웹훅)**만 붙어 있음(`meta-ads.js`/`meta-ads-run.js`).
- 확장 대상: **틱톡·유튜브 광고 전용(다크) 크리에이티브**. 스크래핑으론 안 잡히므로 각 플랫폼 광고/데이터 API 필요.
- 사용자 확정:
  - **틱톡 = 1순위**(부정댓글 많음). 광고 대부분 **광고 전용 영상**(일부 Spark Ads 혼재).
  - **유튜브 = 우리 채널에 올린 비공개(unlisted) 업로드** → **경로 A 확정**(채널 소유자 OAuth로 업로드 나열, **Google Ads API 불필요**).

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

### 2.1 (선택) 폴링 워터마크
- 매 폴링마다 광고별 전체 댓글을 LLM에 넣으면 비용↑. dedup은 발송은 막지만 **LLM 호출은 이미 일어남**.
- 권고: 광고별 `last_seen_comment_at`(또는 마지막 코멘트ID)를 `ad_poll_state`(신규 소형 테이블: platform, ad_ref, last_seen_at, updated_at)에 저장 → 그 이후 댓글만 분류. 초기 1회는 전체.

## 3. 틱톡 어댑터 (1순위)

### 소스
- **TikTok Marketing(Business) API — 댓글 관리(Comment Management)**. 광고계정(advertiser) 소유 광고의 댓글 목록 조회.
- 필요 정보: `TIKTOK_ADVERTISER_ID`, `TIKTOK_ACCESS_TOKEN`(광고계정 OAuth), 앱 `App ID`/`Secret`.
- 폴링: advertiser의 **광고 목록 조회 → 광고 전용 영상 광고 필터 → 광고별 댓글 목록 조회**.
  - Spark Ads(공개 부스팅)는 기존 clockworks 스크래퍼로 이미 잡힐 수 있으니 **광고 전용만** 대상(광고 유형 필드로 필터, 이중수집 방지).

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

### 소스
- 광고 영상 = **우리 채널의 비공개 업로드**. 
- 채널 소유자 OAuth → **uploads 재생목록**(`channels.list` contentDetails.relatedPlaylists.uploads → `playlistItems.list`)으로 비공개 포함 전 업로드 나열 → **광고 소재 영상만 필터**.
  - ⚠️ **광고 소재 식별 규칙 필요**(§7 오픈): 영상 제목/설명 명명규칙, 태그, 또는 유지되는 영상ID 리스트.
- 영상별 **`commentThreads.list`(part=snippet, videoId, order=time)** 로 최신 댓글 조회.

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

## 7. 착수 전 확정 필요 (오픈 결정)

1. **담당자**: 틱톡/유튜브 광고 부정댓글 담당자 = 메타와 동일 **이재원(awareness)** 재사용? 아니면 플랫폼별 신규 슬롯? (기본 제안: 재사용)
2. **스레드 분리**: `channelCategory='인지 광고'`로 두면 제품별 인지 광고 스레드에 **플랫폼 혼합**(카드에 플랫폼 표기). 플랫폼별 분리 원하면 `'인지 광고 (틱톡)'` 등 카테고리 분리.
3. **틱톡**: 광고계정 ID·접근 주체, **광고 전용 vs Spark 필터 기준**.
4. **유튜브**: **광고 소재 영상 식별 규칙**(명명규칙/태그/영상ID 리스트 중 택1).
5. 승인 후 각 플랫폼 개발자 앱·OAuth·(틱톡)심사 진행.

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
