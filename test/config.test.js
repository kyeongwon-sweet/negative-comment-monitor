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
});

test('LLM 기본 공급자는 현재 무료 Gemini 안정 모델이고 Anthropic은 폴백 설정으로 남는다', () => {
  const config = loadConfig({ ...BASE_ENV, GEMINI_API_KEY: 'gemini', ANTHROPIC_API_KEY: 'anthropic' });
  assert.equal(config.llmProvider, 'gemini');
  assert.equal(config.geminiModel, 'gemini-3.1-flash-lite');
  assert.equal(config.geminiRequestIntervalMs, 1500);
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
