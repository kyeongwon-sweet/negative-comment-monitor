# 위성 YouTube 소유 채널 OAuth 등록

위성채널 오가닉 부정댓글 자동숨김은 아래 8개 YouTube 채널 중 소유자 OAuth가 저장된 채널에서만 동작한다.

| 채널 | 핸들 | 검증 channel ID |
|---|---|---|
| 썰박스 | `@ssulbox-1` | `UCE5iE_6o4EU6x9CR6TnsXHw` |
| 썰뜨기 | `@sseoltteugi` | `UCASoOEk77g0NTcblPf0RuBg` |
| 이슈뜨기 | `@issuetteugi` | `UC5DKlx4R-7siM65GdlP1hnA` |
| 이슈박스 | `@issuebox_x` | `UC9PyxanftI-l-j3I9vvb9Nw` |
| 유머박스 | `@humorrbox` | `UC6oZw_I2oO_nKjIEfBt1l0A` |
| 정리해드림 | `@allkill_2424` | `UC_rgT8r47YzIE7lXia03Nmg` |
| 매일1분 | `@just1min_2424` | `UC_rLu8ulIc3pQ0zoq36Jxow` |
| 이걸몰라? | `@whydontuknow2424` | `UCQRxcMlnRXUHP5lHRmhcjdA` |

## 채널별 등록

로컬 `.env`에 기존 Google OAuth client와 Supabase service role 설정이 있는 PC에서 한 채널씩 실행한다.

```powershell
$env:YOUTUBE_SATELLITE_CHANNEL='썰박스'
node --env-file=.env scripts/youtube-satellite-owner-oauth.mjs
```

출력된 Google 동의 URL을 열고 정확한 채널의 소유자/관리자 계정으로 동의한다. 콜백 후 도구가 `channels.list(mine=true)`의 channel ID를 표와 대조하며, 다른 채널이면 토큰을 저장하지 않는다. 성공 토큰은 Supabase `meta_tokens`의 `youtube_owner:<channel-id>`로 저장된다. 인증 코드·access token·refresh token은 로그에 출력하지 않는다.

각 채널마다 명령의 채널명만 바꾸어 반복한다. OAuth 동의가 없는 채널과 TikTok 위성, 협찬 제3자 채널은 알림만 유지되고 자동숨김되지 않는다.
