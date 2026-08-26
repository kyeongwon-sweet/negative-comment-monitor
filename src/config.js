function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function json(env, name, fallback = {}) {
  const raw = String(env[name] || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (error) { throw new Error(`${name} must be valid JSON: ${error.message}`); }
}

function kstDate(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function scheduledRoutingActive(effectiveDateKst, now = Date.now()) {
  const date = String(effectiveDateKst || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && kstDate(now) >= date;
}

function scheduledAssignee(env, currentName, nextName, active) {
  const current = String(env[currentName] || '').trim();
  const next = String(env[nextName] || '').trim();
  return active && next ? next : current;
}

export function loadConfig(env = process.env, now = Date.now()) {
  const nextRoutingActive = scheduledRoutingActive(env.SLACK_ROUTING_EFFECTIVE_DATE_KST, now);
  return {
    gasWebAppUrl: required(env, 'GAS_WEB_APP_URL'),
    gasVerifyToken: required(env, 'GAS_VERIFY_TOKEN'),
    apifyApiToken: required(env, 'APIFY_API_TOKEN'),
    slackChannelId: String(env.SLACK_CHANNEL_ID || 'C0BHD9S69JA').trim(),
    slackBotToken: String(env.SLACK_BOT_TOKEN || '').trim(),
    slackSigningSecret: String(env.SLACK_SIGNING_SECRET || '').trim(),
    slackAssignees: {
      satellite: String(env.SLACK_ASSIGNEE_SATELLITE || '').trim(),
      viralBanner: String(env.SLACK_ASSIGNEE_VIRAL_BANNER || '').trim(),
      viralVideoOwned: String(env.SLACK_ASSIGNEE_VIRAL_VIDEO_OWNED || '').trim(),
      other: String(env.SLACK_ASSIGNEE_OTHER || '').trim(),
      owned: String(env.SLACK_ASSIGNEE_OWNED || '').trim(),      // 온드미디어(상품군 무관)=김바다
      jdBok: String(env.SLACK_ASSIGNEE_JDBOK || '').trim(),      // 소재명에 'JD복' 포함 시 최우선 담당자=이재원
      awareness: scheduledAssignee(env, 'SLACK_ASSIGNEE_AWARENESS', 'SLACK_ASSIGNEE_AWARENESS_NEXT', nextRoutingActive),
      sponsorship: String(env.SLACK_ASSIGNEE_SPONSORSHIP || '').trim(),
      // 상품별 담당자(상품 코드 × 카테고리). 미지정 조합/상품은 위 카테고리 기본값으로 폴백.
      jd: {
        sponsorship: scheduledAssignee(env, 'SLACK_ASSIGNEE_JD_SPONSORSHIP', 'SLACK_ASSIGNEE_JD_SPONSORSHIP_NEXT', nextRoutingActive),
        viralBanner: scheduledAssignee(env, 'SLACK_ASSIGNEE_JD_VIRAL_BANNER', 'SLACK_ASSIGNEE_JD_VIRAL_BANNER_NEXT', nextRoutingActive),
        viralVideo: scheduledAssignee(env, 'SLACK_ASSIGNEE_JD_VIRAL_VIDEO', 'SLACK_ASSIGNEE_JD_VIRAL_VIDEO_NEXT', nextRoutingActive),
        satellite: scheduledAssignee(env, 'SLACK_ASSIGNEE_JD_SATELLITE', 'SLACK_ASSIGNEE_JD_SATELLITE_NEXT', nextRoutingActive),
      },
      p: {
        viralBanner: String(env.SLACK_ASSIGNEE_P_VIRAL_BANNER || '').trim(),
        viralVideo: String(env.SLACK_ASSIGNEE_P_VIRAL_VIDEO || '').trim(),
        powerChannel: String(env.SLACK_ASSIGNEE_P_POWER_CHANNEL || '').trim(), // 파인트 협찬(파워채널/매거진)=이도경
        sponsorship: String(env.SLACK_ASSIGNEE_P_SPONSORSHIP || '').trim(),   // 파인트 협찬(인플루언서)=손유곤
      },
    },
    // 이름→Slack ID 맵(META_AD_VIDEO_ASSIGNEES). 바이럴 카드 소재명에서 제작자 추출·태그용. 파싱 실패=빈 맵.
    videoAssignees: (() => { try { const m = JSON.parse(env.META_AD_VIDEO_ASSIGNEES || '{}'); return (m && typeof m === 'object') ? m : {}; } catch { return {}; } })(),
    supabaseUrl: String(env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    googleAdsClientId: String(env.GOOGLE_ADS_CLIENT_ID || '').trim(),
    googleAdsClientSecret: String(env.GOOGLE_ADS_CLIENT_SECRET || '').trim(),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    youtubeSatelliteAutoHide: String(env.YOUTUBE_SATELLITE_AUTO_HIDE || 'false').toLowerCase() === 'true',
    deltaEnabled: String(env.DELTA_ENABLED || 'true').toLowerCase() !== 'false',
    // 감시 대상은 전부 라라스윗 협찬 게시물이므로, 브랜드 컨텍스트를 부여해
    // classify의 entity 게이트가 브랜드 관련 부정댓글을 놓치지 않게 한다.
    brandContext: String(env.BRAND_CONTEXT || '라라스윗').trim(),
    // 업로드 후 N일이 지나면 댓글 트래킹 중단(사용자 지시: 7일).
    trackingDays: Number(env.TRACKING_DAYS || 7),
    // LLM 분류(의미 기반). 기본은 Gemini 무료 티어, 실패 시 Anthropic, 최종 키워드 폴백.
    llmProvider: String(env.LLM_PROVIDER || 'gemini').trim().toLowerCase(),
    geminiKey: String(env.GEMINI_API_KEY || '').trim(),
    geminiModel: String(env.GEMINI_MODEL || 'gemini-3.1-flash-lite').trim(),
    geminiRequestIntervalMs: Math.max(0, Number(env.GEMINI_REQUEST_INTERVAL_MS || 1500)),
    geminiRetryBaseMs: Math.max(0, Number(env.GEMINI_RETRY_BASE_MS || 1000)),
    geminiMaxAttempts: Math.max(1, Math.min(5, Number(env.GEMINI_MAX_ATTEMPTS || 4))),
    anthropicKey: String(env.ANTHROPIC_API_KEY || '').trim(),
    anthropicModel: String(env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001').trim(),
    llmFailureThreshold: Math.max(1, Number(env.LLM_FAILURE_THRESHOLD || 3)),
    llmFailureAlertCooldownHours: Math.max(1, Number(env.LLM_FAILURE_ALERT_COOLDOWN_HOURS || 12)),
    sourceSpreadsheetId: String(env.SOURCE_SPREADSHEET_ID || '10WpAQU9TAsi3hRZ3ELvcQYj7Z228ILXfF6BUGz495Ak').trim(),
    sourceSheetName: String(env.SOURCE_SHEET_NAME || '콘텐츠 대시보드 연동').trim(),
    excludedChannelCategory: String(env.EXCLUDED_CHANNEL_CATEGORY || '무상시딩').trim(),
    managedChannelCategories: String(env.MANAGED_CHANNEL_CATEGORIES || '온드미디어,위성채널').split(',').map((value) => value.trim()).filter(Boolean),
    // GAS에서 evergreen(온드/위성) 보조 상한으로 쓰인다. 낮으면 전체 대상이 조용히 잘린다.
    targetBatchSize: Number(env.TARGET_BATCH_SIZE || 1000),
    // Apps Script가 간헐적으로 HTML 오류 페이지를 반환해도 한 회차 안에서 회복한다.
    gasFetchRetries: Number(env.GAS_FETCH_RETRIES || 8),
    notFoundSkipThreshold: Number(env.NOT_FOUND_SKIP_THRESHOLD || 2), // not_found 연속 N회 이상=죽은 링크로 보고 알림 제외
    firstScanLimit: Number(env.FIRST_SCAN_LIMIT || 60),
    noSignalScanLimit: Number(env.NO_SIGNAL_SCAN_LIMIT || 20),
    deepScanLimit: Number(env.DEEP_SCAN_LIMIT || 15),
    deepScanCommentThreshold: Number(env.DEEP_SCAN_COMMENT_THRESHOLD || 10),
    deepScanRecentCommentThreshold: Number(env.DEEP_SCAN_RECENT_COMMENT_THRESHOLD || 5),
    deepScanCommentLimit: Number(env.DEEP_SCAN_COMMENT_LIMIT || 100),
    pollIntervalMs: Number(env.APIFY_POLL_INTERVAL_MS || 5000),
    runTimeoutMs: Number(env.APIFY_RUN_TIMEOUT_MS || 600000),
    // 위성 TikTok 대량 도입 시 단일 actor 10분 초과를 막는다. 성공 청크만 기준선을 전진시킨다.
    tiktokBatchSize: Math.max(1, Number(env.APIFY_TIKTOK_BATCH_SIZE || 50)),
    // 단일 플랫폼 일시 실패는 fail-soft. 연속 N회째부터만 핵심 실패로 승격하고 쿨다운 동안 재알림하지 않는다.
    platformFailureThreshold: Math.max(1, Number(env.PLATFORM_FAILURE_THRESHOLD || 3)),
    platformFailureAlertCooldownHours: Math.max(1, Number(env.PLATFORM_FAILURE_ALERT_COOLDOWN_HOURS || 12)),
    dryRun: String(env.DRY_RUN || 'true').toLowerCase() !== 'false',
    actors: {
      instagram: { id: required(env, 'APIFY_INSTAGRAM_ACTOR_ID'), input: json(env, 'APIFY_INSTAGRAM_INPUT_JSON') },
      youtube: { id: required(env, 'APIFY_YOUTUBE_ACTOR_ID'), input: json(env, 'APIFY_YOUTUBE_INPUT_JSON') },
      tiktok: { id: required(env, 'APIFY_TIKTOK_ACTOR_ID'), input: json(env, 'APIFY_TIKTOK_INPUT_JSON') },
      twitter: { id: required(env, 'APIFY_TWITTER_ACTOR_ID'), input: json(env, 'APIFY_TWITTER_INPUT_JSON') },
    },
  };
}
