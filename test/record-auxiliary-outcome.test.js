import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAuxiliaryOutcomeConfig, recordAuxiliaryOutcome } from '../src/record-auxiliary-outcome.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('보조 단계 outcome과 임계·쿨다운 설정을 읽는다', () => {
  const config = loadAuxiliaryOutcomeConfig({
    AUXILIARY_HEALTH_KEY: 'youtube_ads', AUXILIARY_OUTCOME: 'failure',
    AUXILIARY_FAILURE_THRESHOLD: '3', AUXILIARY_ALERT_COOLDOWN_HOURS: '24',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key',
  });
  assert.equal(config.platform, 'youtube_ads');
  assert.equal(config.ok, false);
  assert.equal(config.health.platformFailureThreshold, 3);
  assert.equal(config.health.platformFailureAlertCooldownHours, 24);
});

test('임계 전 YouTube Ads 실패는 기록만 하고 Slack 경고하지 않는다', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (!init.method) return response(200, [{ platform: 'youtube_ads', last_status: 'failure', consecutive_failures: 1 }]);
    return response(201, [{ platform: 'youtube_ads', consecutive_failures: 2 }]);
  };
  const result = await recordAuxiliaryOutcome({
    AUXILIARY_HEALTH_KEY: 'youtube_ads', AUXILIARY_OUTCOME: 'failure', AUXILIARY_FAILURE_THRESHOLD: '3',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key',
  }, fetchImpl, Date.parse('2026-08-24T00:00:00Z'));
  assert.equal(result.consecutiveFailures, 2);
  assert.equal(result.notified, false);
  assert.equal(calls.some(([url]) => url === 'https://slack.com/api/chat.postMessage'), false);
});

test('성공 outcome은 연속 실패를 0으로 초기화한다', async () => {
  const fetchImpl = async (_url, init = {}) => {
    if (!init.method) return response(200, [{ platform: 'youtube_ads', last_status: 'failure', consecutive_failures: 4 }]);
    return response(201, [{ platform: 'youtube_ads', consecutive_failures: 0 }]);
  };
  const result = await recordAuxiliaryOutcome({
    AUXILIARY_HEALTH_KEY: 'youtube_ads', AUXILIARY_OUTCOME: 'success',
    SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key',
  }, fetchImpl);
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(result.notified, false);
});
