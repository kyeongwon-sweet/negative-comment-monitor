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

// 11-04: quota 소진 중 YouTube 보조 기능 경고가 기능마다·성공/실패 교차마다 재발송됐다.
// '할당량 소진' 알림이 이미 나간 날(PT)엔 YouTube 보조 degraded 알림을 막고, last_alerted_at도 찍지 않는다.
function quotaWorld({ exhausted }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (String(url).includes('cost_usage_ledger')) {
      const key = decodeURIComponent(String(url).match(/run_key=eq\.([^&]+)/)?.[1] || '');
      return response(200, exhausted ? [{ run_key: key }] : []);
    }
    if (!init.method) return response(200, [{ platform: 'youtube_owner_pending_hide', last_status: 'failure', consecutive_failures: 2 }]);
    if (String(url).includes('chat.postMessage')) return response(200, { ok: true });
    return response(201, [JSON.parse(init.body)]);
  };
  return { calls, fetchImpl };
}
const QUOTA_ENV = {
  AUXILIARY_HEALTH_KEY: 'youtube_owner_pending_hide', AUXILIARY_OUTCOME: 'failure', AUXILIARY_FAILURE_THRESHOLD: '3',
  SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'key', SLACK_BOT_TOKEN: 'xb', SLACK_CHANNEL_ID: 'C1',
};

test('quota 소진일엔 YouTube 보조 실패가 임계를 넘어도 개별 경고하지 않고 알림 시각도 남기지 않는다', async () => {
  const { calls, fetchImpl } = quotaWorld({ exhausted: true });
  const result = await recordAuxiliaryOutcome(QUOTA_ENV, fetchImpl, Date.parse('2026-11-04T02:30:00Z'));
  assert.equal(result.quotaBlocked, true);
  assert.equal(result.notified, false);
  assert.equal(result.consecutiveFailures, 3, '실패는 그대로 센다');
  assert.ok(!calls.some(([url]) => url.includes('chat.postMessage')));
  const saved = calls.find(([url, init]) => url.includes('platform_collection_health') && init.method === 'POST');
  assert.equal(JSON.parse(saved[1].body).last_alerted_at ?? null, null, '리셋 뒤 진짜 실패는 쿨다운 없이 바로 알린다');
});

test('quota가 소진되지 않은 날엔 기존대로 임계에서 경고한다', async () => {
  const { calls, fetchImpl } = quotaWorld({ exhausted: false });
  const result = await recordAuxiliaryOutcome(QUOTA_ENV, fetchImpl, Date.parse('2026-11-04T02:30:00Z'));
  assert.equal(result.quotaBlocked, false);
  assert.equal(result.notified, true);
  assert.ok(calls.some(([url]) => url.includes('chat.postMessage')));
});
