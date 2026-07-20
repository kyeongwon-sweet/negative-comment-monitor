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

export function loadConfig(env = process.env) {
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
      sponsorship: String(env.SLACK_ASSIGNEE_SPONSORSHIP || '').trim(),
    },
    supabaseUrl: String(env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
    supabaseKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    deltaEnabled: String(env.DELTA_ENABLED || 'true').toLowerCase() !== 'false',
    // 감시 대상은 전부 라라스윗 협찬 게시물이므로, 브랜드 컨텍스트를 부여해
    // classify의 entity 게이트가 브랜드 관련 부정댓글을 놓치지 않게 한다.
    brandContext: String(env.BRAND_CONTEXT || '라라스윗').trim(),
    // 업로드 후 N일이 지나면 댓글 트래킹 중단(사용자 지시: 7일).
    trackingDays: Number(env.TRACKING_DAYS || 7),
    // LLM 분류(의미 기반). 키 있으면 자동 사용, 없거나 실패 시 키워드 분류로 폴백.
    anthropicKey: String(env.ANTHROPIC_API_KEY || '').trim(),
    anthropicModel: String(env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001').trim(),
    sourceSpreadsheetId: String(env.SOURCE_SPREADSHEET_ID || '10WpAQU9TAsi3hRZ3ELvcQYj7Z228ILXfF6BUGz495Ak').trim(),
    sourceSheetName: String(env.SOURCE_SHEET_NAME || '콘텐츠 대시보드 연동').trim(),
    excludedChannelCategory: String(env.EXCLUDED_CHANNEL_CATEGORY || '무상시딩').trim(),
    managedChannelCategories: String(env.MANAGED_CHANNEL_CATEGORIES || '온드미디어,위성채널').split(',').map((value) => value.trim()).filter(Boolean),
    targetBatchSize: Number(env.TARGET_BATCH_SIZE || 20),
    pollIntervalMs: Number(env.APIFY_POLL_INTERVAL_MS || 5000),
    runTimeoutMs: Number(env.APIFY_RUN_TIMEOUT_MS || 600000),
    dryRun: String(env.DRY_RUN || 'true').toLowerCase() !== 'false',
    actors: {
      instagram: { id: required(env, 'APIFY_INSTAGRAM_ACTOR_ID'), input: json(env, 'APIFY_INSTAGRAM_INPUT_JSON') },
      youtube: { id: required(env, 'APIFY_YOUTUBE_ACTOR_ID'), input: json(env, 'APIFY_YOUTUBE_INPUT_JSON') },
      tiktok: { id: required(env, 'APIFY_TIKTOK_ACTOR_ID'), input: json(env, 'APIFY_TIKTOK_INPUT_JSON') },
      twitter: { id: required(env, 'APIFY_TWITTER_ACTOR_ID'), input: json(env, 'APIFY_TWITTER_INPUT_JSON') },
    },
  };
}
