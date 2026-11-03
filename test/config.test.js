import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, scheduledRoutingActive } from '../src/config.js';

const BASE_ENV = {
  GAS_WEB_APP_URL: 'https://gas.test/exec',
  GAS_VERIFY_TOKEN: 'gas',
  APIFY_API_TOKEN: 'apify',
  APIFY_INSTAGRAM_ACTOR_ID: 'instagram',
  APIFY_YOUTUBE_ACTOR_ID: 'youtube',
  APIFY_TIKTOK_ACTOR_ID: 'tiktok',
  APIFY_TWITTER_ACTOR_ID: 'twitter',
  SLACK_ROUTING_EFFECTIVE_DATE_KST: '2026-08-17',
  SLACK_ASSIGNEE_JD_PRIMARY: 'U_JD_PRIMARY',
  SLACK_ASSIGNEE_JD_VIRAL: 'U_JD_VIRAL',
  SLACK_ASSIGNEE_JD_POWER_CHANNEL: 'U09RCJ1B9ML',
  SLACK_ASSIGNEE_JD_SPONSORSHIP: 'OLD_SPONSORSHIP',
  SLACK_ASSIGNEE_JD_VIRAL_BANNER: 'OLD_BANNER',
  SLACK_ASSIGNEE_JD_VIRAL_VIDEO: 'OLD_VIDEO',
  SLACK_ASSIGNEE_JD_SATELLITE: 'OLD_SATELLITE',
  SLACK_ASSIGNEE_JD_SPONSORSHIP_NEXT: 'U0BEVSGM2CD',
  SLACK_ASSIGNEE_JD_VIRAL_BANNER_NEXT: 'U09RCJ1B9ML',
  SLACK_ASSIGNEE_JD_VIRAL_VIDEO_NEXT: 'U08S4MCC4HY',
  SLACK_ASSIGNEE_JD_SATELLITE_NEXT: 'U0BEVSGM2CD',
  SLACK_ASSIGNEE_OTHER: 'U0B2Y0ZC8QZ',
  SLACK_ASSIGNEE_AWARENESS: 'U09RCJ1B9ML',
  SLACK_ASSIGNEE_AWARENESS_NEXT: 'U0B2Y0ZC8QZ',
  SLACK_ASSIGNEE_JG_PRIMARY: 'U0BBTQLRYR2',
  SLACK_ASSIGNEE_JG_ADDITIONAL: 'U06BCNFKWLW,U09PNBJNHS7,U06EE6J8KJN',
};

test('scheduled routing switches exactly at 2026-08-17 00:00 KST', () => {
  assert.equal(scheduledRoutingActive('2026-08-17', Date.parse('2026-08-16T14:59:59Z')), false);
  assert.equal(scheduledRoutingActive('2026-08-17', Date.parse('2026-08-16T15:00:00Z')), true);
});

test('JD routing keeps current assignees through Sunday and activates requested mapping Monday', () => {
  const before = loadConfig(BASE_ENV, Date.parse('2026-08-16T14:59:59Z'));
  assert.deepEqual(before.slackAssignees.jd, {
    primary: 'U_JD_PRIMARY', viral: 'U_JD_VIRAL', satellite: 'OLD_SATELLITE',
  });

  const after = loadConfig(BASE_ENV, Date.parse('2026-08-16T15:00:00Z'));
  assert.deepEqual(after.slackAssignees.jd, {
    primary: 'U_JD_PRIMARY', viral: 'U_JD_VIRAL', satellite: 'U0BEVSGM2CD',
  });
  assert.equal(after.slackAssignees.other, 'U0B2Y0ZC8QZ');
  assert.equal(before.slackAssignees.awareness, 'U09RCJ1B9ML');
  assert.equal(after.slackAssignees.awareness, 'U0B2Y0ZC8QZ');
  assert.deepEqual(after.slackAssignees.jg, {
    primary: 'U0BBTQLRYR2',
    additional: ['U06BCNFKWLW', 'U09PNBJNHS7', 'U06EE6J8KJN'],
  });
});

test('missing NEXT value safely falls back to the current assignee after the effective date', () => {
  const config = loadConfig({ ...BASE_ENV, SLACK_ASSIGNEE_JD_SATELLITE_NEXT: '' }, Date.parse('2026-08-17T00:00:00Z'));
  assert.equal(config.slackAssignees.jd.satellite, 'OLD_SATELLITE');
});

test('TikTok collection safety defaults are bounded and persistent failures need three runs', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.tiktokBatchSize, 50);
  assert.equal(config.platformFailureThreshold, 3);
  assert.equal(config.platformFailureAlertCooldownHours, 12);
  assert.equal(config.monitorTargetStateMode, 'shadow');
  assert.equal(loadConfig({ ...BASE_ENV, MONITOR_TARGET_STATE_MODE: 'shadow' }).monitorTargetStateMode, 'shadow');
  assert.equal(loadConfig({ ...BASE_ENV, MONITOR_TARGET_STATE_MODE: 'typo' }).monitorTargetStateMode, 'shadow');
});

test('LLM 기본 공급자는 현재 무료 Gemini 안정 모델이고 Anthropic은 폴백 설정으로 남는다', () => {
  const config = loadConfig({ ...BASE_ENV, GEMINI_API_KEY: 'gemini', ANTHROPIC_API_KEY: 'anthropic' });
  assert.equal(config.llmProvider, 'gemini');
  assert.equal(config.geminiModel, 'gemini-3.1-flash-lite');
  assert.equal(config.geminiRequestIntervalMs, 1500);
  assert.equal(config.geminiQuotaClass, 'live');
  assert.equal(config.geminiRollingRequestBudget, 480);
  assert.equal(config.geminiBulkRollingRequestBudget, 300);
  assert.equal(config.geminiQuotaWindowHours, 24);
  assert.equal(config.geminiKey, 'gemini');
  assert.equal(config.anthropicKey, 'anthropic');
});

test('기한부 담당자 override: 지정일(KST, 당일 포함)까지만 임시 담당, 지나면 자동 복귀', async () => {
  const { overrideAssignee, loadSlackAssignees } = await import('../src/config.js');
  const { loadMetaAdsConfig } = await import('../src/meta-ads.js');
  const { assigneeForTarget } = await import('../src/slack.js');
  const env = {
    SLACK_ASSIGNEE_PBACHI: 'U_LEEJW',
    SLACK_ASSIGNEE_PBACHI_OVERRIDE: 'U_KIMBN@2026-10-13',
  };
  const at = (iso) => Date.parse(iso);
  // 10-06 KST(시작) · 10-13 23:59 KST(마지막 날) → 김보나
  assert.equal(overrideAssignee(env, 'SLACK_ASSIGNEE_PBACHI', at('2026-10-06T09:00:00+09:00')), 'U_KIMBN');
  assert.equal(overrideAssignee(env, 'SLACK_ASSIGNEE_PBACHI', at('2026-10-13T23:59:00+09:00')), 'U_KIMBN');
  // 10-14 00:00 KST부터 자동으로 이재원
  assert.equal(overrideAssignee(env, 'SLACK_ASSIGNEE_PBACHI', at('2026-10-14T00:00:00+09:00')), 'U_LEEJW');
  // 형식 오류·미설정 → 기본 담당자
  assert.equal(overrideAssignee({ ...env, SLACK_ASSIGNEE_PBACHI_OVERRIDE: 'U_KIMBN' }, 'SLACK_ASSIGNEE_PBACHI', at('2026-10-06T09:00:00+09:00')), 'U_LEEJW');
  assert.equal(overrideAssignee({ SLACK_ASSIGNEE_PBACHI: 'U_LEEJW' }, 'SLACK_ASSIGNEE_PBACHI'), 'U_LEEJW');
  // 일반 알림·광고 알림 라우팅 모두 반영(바치케 전 카테고리)
  const adEnv = { ...env, SUPABASE_URL: 'https://db.test/', SUPABASE_SERVICE_ROLE_KEY: 'svc', SLACK_BOT_TOKEN: 'x' };
  for (const now of [at('2026-10-06T09:00:00+09:00')]) {
    for (const assignees of [loadSlackAssignees(env, now), loadMetaAdsConfig(adEnv, now).slackAssignees]) {
      for (const c of ['인지 광고', '바이럴 (배너)', '협찬 (인플루언서)', '위성채널']) {
        assert.equal(assigneeForTarget({ productName: 'P바치', channelCategory: c }, assignees), 'U_KIMBN', c);
      }
    }
  }
  assert.equal(assigneeForTarget({ productName: 'P바치', channelCategory: '인지 광고' }, loadSlackAssignees(env, at('2026-10-14T09:00:00+09:00'))), 'U_LEEJW');
});

test('바치케 협찬 (파워채널/먹스타)만 PBACHI_MUKSTAR(김보나), 나머지 바치케는 전담(이재원) — 일반·광고 로더 공통', async () => {
  const { loadSlackAssignees } = await import('../src/config.js');
  const { loadMetaAdsConfig } = await import('../src/meta-ads.js');
  const { assigneeForTarget } = await import('../src/slack.js');
  const env = { SLACK_ASSIGNEE_PBACHI: 'U_LEEJW', SLACK_ASSIGNEE_PBACHI_MUKSTAR: 'U_KIMBN', SLACK_ASSIGNEE_OTHER: 'U_OTHER' };
  const adEnv = { ...env, SUPABASE_URL: 'https://db.test/', SUPABASE_SERVICE_ROLE_KEY: 'svc', SLACK_BOT_TOKEN: 'x' };
  const now = Date.parse('2026-10-15T09:00:00+09:00');
  for (const assignees of [loadSlackAssignees(env, now), loadMetaAdsConfig(adEnv, now).slackAssignees]) {
    assert.equal(assigneeForTarget({ productName: 'P바치', channelCategory: '협찬 (파워채널/먹스타)' }, assignees), 'U_KIMBN');
    for (const c of ['협찬 (파워채널/매거진)', '협찬 (인플루언서)', '인지 광고', '바이럴 (배너)', '위성채널']) {
      assert.equal(assigneeForTarget({ productName: 'P바치', channelCategory: c }, assignees), 'U_LEEJW', c);
    }
    // 다른 상품군 먹스타는 영향 없음
    assert.notEqual(assigneeForTarget({ productName: 'JD멜', channelCategory: '협찬 (파워채널/먹스타)' }, assignees), 'U_KIMBN');
  }
  // 변수 비면 바치케 전담으로 폴백
  assert.equal(assigneeForTarget({ productName: 'P바치', channelCategory: '협찬 (파워채널/먹스타)' }, loadSlackAssignees({ SLACK_ASSIGNEE_PBACHI: 'U_LEEJW' }, now)), 'U_LEEJW');
});

// 2026-11-03 사용자 지시: "떵개 바치케만 유진님". 떵개의 다른 상품·바치케의 다른 크리에이터는 기존 담당 그대로,
// 부모 스레드(바치케|협찬)도 기존 담당 그대로 — 카드만 김유진.
test('떵개×바치케 협찬 카드만 김유진, 부모 스레드·다른 크리에이터·다른 상품은 기존 담당 — 일반·광고 로더 공통', async () => {
  const { loadSlackAssignees } = await import('../src/config.js');
  const { loadMetaAdsConfig } = await import('../src/meta-ads.js');
  const { assigneeForTarget, buildAlertBlocks } = await import('../src/slack.js');
  const env = {
    SLACK_ASSIGNEE_SPONSORSHIP_CREATORS: '[{"creator":"떵개","product":"P바치","assignee":"U_KIMYJ"}]',
    SLACK_ASSIGNEE_PBACHI: 'U_LEEJW', SLACK_ASSIGNEE_PBACHI_MUKSTAR: 'U_KIMBN',
    SLACK_ASSIGNEE_JD_PRIMARY: 'U_KIMBD', SLACK_ASSIGNEE_OTHER: 'U_OTHER',
  };
  const adEnv = { ...env, SUPABASE_URL: 'https://db.test/', SUPABASE_SERVICE_ROLE_KEY: 'svc', SLACK_BOT_TOKEN: 'x' };
  const now = Date.parse('2026-11-03T09:00:00+09:00');
  const cardIds = (target, assignees) => [...new Set(JSON.stringify(buildAlertBlocks(
    target, { id: '1', platform: 'instagram', text: 't', risk: {} }, [], assignees,
  )).match(/U_[A-Z]+/g) || [])];
  for (const assignees of [loadSlackAssignees(env, now), loadMetaAdsConfig(adEnv, now).slackAssignees]) {
    for (const channelName of ['떵개떵', '떵개떵 (인스타/미러링)', '떵 개떵']) {
      for (const channelCategory of ['협찬 (인플루언서)', '협찬 (파워채널/먹스타)']) {
        const target = { productName: 'P바치', channelName, channelCategory, url: 'u' };
        assert.deepEqual(cardIds(target, assignees), ['U_KIMYJ'], `${channelName}/${channelCategory} 카드`);
        // 부모 스레드 담당은 상품×카테고리 기준 그대로(인플루언서=이재원, 먹스타=김보나)
        assert.equal(assigneeForTarget(target, assignees), channelCategory.includes('먹스타') ? 'U_KIMBN' : 'U_LEEJW');
      }
    }
    // 바치케의 다른 크리에이터 협찬 카드는 기존 담당
    assert.deepEqual(cardIds({ productName: 'P바치', channelName: '와뜨기', channelCategory: '협찬 (인플루언서)', url: 'u' }, assignees), ['U_LEEJW']);
    assert.deepEqual(cardIds({ productName: 'P바치', channelName: '돼지만두', channelCategory: '협찬 (파워채널/먹스타)', url: 'u' }, assignees), ['U_KIMBN']);
    // 떵개의 다른 상품 협찬 카드는 그 상품 담당
    assert.deepEqual(cardIds({ productName: 'JD멜', channelName: '떵개떵', channelCategory: '협찬 (인플루언서)', url: 'u' }, assignees), ['U_KIMBD']);
    // 협찬이 아닌 바치케 카드는 규칙 밖
    assert.deepEqual(cardIds({ productName: 'P바치', channelName: '떵개떵', channelCategory: '인지 광고', url: 'u' }, assignees), ['U_LEEJW']);
  }
  // 잘못된 JSON·형식은 규칙 없음(전체 라우팅을 깨지 않음)
  for (const raw of ['{떵개', '{"떵개":"U_KIMYJ"}', '[{"creator":"떵개"}]']) {
    const broken = loadSlackAssignees({ ...env, SLACK_ASSIGNEE_SPONSORSHIP_CREATORS: raw }, now);
    assert.deepEqual(broken.sponsorshipCreators, [], raw);
    assert.deepEqual(cardIds({ productName: 'P바치', channelName: '떵개떵', channelCategory: '협찬 (인플루언서)', url: 'u' }, broken), ['U_LEEJW'], raw);
  }
});
