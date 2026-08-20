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
};

test('scheduled routing switches exactly at 2026-08-17 00:00 KST', () => {
  assert.equal(scheduledRoutingActive('2026-08-17', Date.parse('2026-08-16T14:59:59Z')), false);
  assert.equal(scheduledRoutingActive('2026-08-17', Date.parse('2026-08-16T15:00:00Z')), true);
});

test('JD routing keeps current assignees through Sunday and activates requested mapping Monday', () => {
  const before = loadConfig(BASE_ENV, Date.parse('2026-08-16T14:59:59Z'));
  assert.deepEqual(before.slackAssignees.jd, {
    sponsorship: 'OLD_SPONSORSHIP', viralBanner: 'OLD_BANNER', viralVideo: 'OLD_VIDEO', satellite: 'OLD_SATELLITE',
  });

  const after = loadConfig(BASE_ENV, Date.parse('2026-08-16T15:00:00Z'));
  assert.deepEqual(after.slackAssignees.jd, {
    sponsorship: 'U0BEVSGM2CD',
    viralBanner: 'U09RCJ1B9ML',
    viralVideo: 'U08S4MCC4HY',
    satellite: 'U0BEVSGM2CD',
  });
  assert.equal(after.slackAssignees.other, 'U0B2Y0ZC8QZ');
  assert.equal(before.slackAssignees.awareness, 'U09RCJ1B9ML');
  assert.equal(after.slackAssignees.awareness, 'U0B2Y0ZC8QZ');
});

test('missing NEXT value safely falls back to the current assignee after the effective date', () => {
  const config = loadConfig({ ...BASE_ENV, SLACK_ASSIGNEE_JD_VIRAL_VIDEO_NEXT: '' }, Date.parse('2026-08-17T00:00:00Z'));
  assert.equal(config.slackAssignees.jd.viralVideo, 'OLD_VIDEO');
});

test('TikTok collection safety defaults are bounded and persistent failures need three runs', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.tiktokBatchSize, 50);
  assert.equal(config.platformFailureThreshold, 3);
  assert.equal(config.platformFailureAlertCooldownHours, 12);
});
