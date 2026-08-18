import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoHideMetaAwareness,
  autoHideTikTokAwareness,
  loadActionableAwarenessAlerts,
} from '../src/awareness-auto-hide.js';

const CFG = {
  supabaseUrl: 'https://db.test',
  supabaseKey: 'svc',
  slackBotToken: 'xoxb-test',
  metaGraphBase: 'https://graph.test',
  metaTokenKind: 'ig_ads',
  tiktokApiBase: 'https://tiktok.test/open_api/v1.3',
  tiktokAccessToken: 'tt-token',
  tiktokAdvertiserId: 'adv1',
};

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('상시 자동 숨김은 미처리만, 명시적 백로그 정리는 hide/complete도 포함하고 오탐은 제외한다', async () => {
  const rows = [
    { id: 1, comment_id: 'new', review_decision: null },
    { id: 2, comment_id: 'hide', review_decision: 'hide', reviewed_by: 'U1' },
    { id: 3, comment_id: 'complete', review_decision: 'complete', reviewed_by: 'U2' },
    { id: 4, comment_id: 'fp', review_decision: 'false_positive', reviewed_by: 'U3' },
    { id: 5, comment_id: 'ignore', review_decision: 'ignore', reviewed_by: 'U4' },
    { id: 6, comment_id: 'hidden', review_decision: 'hidden' },
    { id: 7, comment_id: 'abnormal', review_decision: null, reviewed_by: 'U5' },
    { id: 8, comment_id: 'unhide', review_decision: 'unhide', reviewed_by: 'U6' },
  ];
  const fetchImpl = async () => response(200, rows);
  assert.deepEqual(
    (await loadActionableAwarenessAlerts(CFG, 'meta_ads', fetchImpl)).map((row) => row.comment_id),
    ['new'],
  );
  assert.deepEqual(
    (await loadActionableAwarenessAlerts(CFG, 'meta_ads', fetchImpl, { includeHumanDecisions: true }))
      .map((row) => row.comment_id),
    ['new', 'hide', 'complete'],
  );
});

test('Meta 자동 숨김은 중복 comment_id를 한 번만 호출하고 Slack 성공 뒤 미처리 감사행만 갱신한다', async () => {
  const calls = [];
  const rows = [
    { id: 1, comment_id: 'c1', comment_text: '별로', post_url: 'https://instagram.test/p/1', review_decision: null, reviewed_by: null, reviewed_at: null, slack_channel_id: 'C1', slack_ts: '1.1' },
    { id: 2, comment_id: 'c1', comment_text: '별로', post_url: 'https://instagram.test/p/1', review_decision: 'hide', reviewed_by: 'U1', reviewed_at: '2026-08-18T00:00:00Z' },
  ];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('negative_comment_alerts?select=')) return response(200, rows);
    if (url.includes('/meta_tokens?')) return response(200, [{ token: 'META' }]);
    if (url === 'https://graph.test/c1?hide=true') return response(200, { success: true });
    if (url === 'https://slack.com/api/chat.update') return response(200, { ok: true });
    if (url.includes('negative_comment_alerts?id=in.')) return response(200, [{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  };
  const result = await autoHideMetaAwareness(CFG, fetchImpl, Date.parse('2026-08-18T01:00:00Z'), { includeHumanDecisions: true });
  assert.deepEqual(result, {
    actionable: 2, hidden: 1, unavailable: 0, failed: 0, dbUpdated: 1,
    slack: { updated: 1, unavailable: 0, failed: 0 },
  });
  assert.equal(calls.filter((call) => call.url.includes('graph.test/c1')).length, 1);
  const slackIndex = calls.findIndex((call) => call.url.includes('slack.com/api/chat.update'));
  const patchIndex = calls.findIndex((call) => call.url.includes('negative_comment_alerts?id=in.'));
  assert.ok(slackIndex >= 0 && patchIndex > slackIndex);
  assert.equal(JSON.parse(calls[patchIndex].init.body).review_decision, 'hidden');
});

test('Meta Slack 일시 실패는 DB 완료 처리를 보류해 다음 회차 재시도를 보장한다', async () => {
  let patched = false;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('negative_comment_alerts?select=')) return response(200, [
      { id: 1, comment_id: 'c1', review_decision: null, slack_channel_id: 'C1', slack_ts: '1.1' },
    ]);
    if (url.includes('/meta_tokens?')) return response(200, [{ token: 'META' }]);
    if (url.includes('graph.test/c1')) return response(200, { success: true });
    if (url.includes('slack.com/api/chat.update')) return response(200, { ok: false, error: 'ratelimited' });
    if (url.includes('negative_comment_alerts?id=in.')) { patched = true; return response(200, []); }
    throw new Error(`unexpected ${url}`);
  };
  const result = await autoHideMetaAwareness(CFG, fetchImpl);
  assert.equal(result.slack.failed, 1);
  assert.equal(result.dbUpdated, 0);
  assert.equal(patched, false);
});

test('Meta #100/33은 Slack에 비노출만 표시하고 hidden 감사값은 위조하지 않는다', async () => {
  const patched = [];
  const slackBodies = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('negative_comment_alerts?select=')) return response(200, [
      { id: 1, comment_id: 'gone', review_decision: null, slack_channel_id: 'C1', slack_ts: '1.1' },
      { id: 2, comment_id: 'denied', review_decision: null },
    ]);
    if (url.includes('/meta_tokens?')) return response(200, [{ token: 'META' }]);
    if (url.includes('/gone?hide=true')) return response(400, { error: { code: 100, error_subcode: 33 } });
    if (url.includes('/denied?hide=true')) return response(403, { error: { code: 10 } });
    if (url.includes('slack.com/api/chat.update')) {
      slackBodies.push(JSON.parse(init.body));
      return response(200, { ok: true });
    }
    if (url.includes('negative_comment_alerts?id=in.')) {
      patched.push(JSON.parse(init.body));
      return response(200, [{ id: 1 }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await autoHideMetaAwareness(CFG, fetchImpl);
  assert.equal(result.hidden, 0);
  assert.equal(result.unavailable, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.dbUpdated, 0);
  assert.match(slackBodies[0].text, /비노출/);
  assert.equal(patched.length, 0);
});

test('TikTok 자동 숨김은 실패 댓글만 격리하고 성공한 미처리 행만 기록한다', async () => {
  const patchBodies = [];
  const statusCalls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('negative_comment_alerts?select=')) return response(200, [
      { id: 1, comment_id: 'good', review_decision: null },
      { id: 2, comment_id: 'bad', review_decision: null },
      { id: 3, comment_id: 'fp', review_decision: 'false_positive', reviewed_by: 'U1' },
    ]);
    if (url.endsWith('/comment/status/update/')) {
      const ids = JSON.parse(init.body).comment_ids;
      statusCalls.push(ids);
      return ids.includes('bad') ? response(400, { code: 40002, message: 'bad comment' }) : response(200, { code: 0 });
    }
    if (url.includes('negative_comment_alerts?id=in.')) {
      patchBodies.push(JSON.parse(init.body));
      return response(200, [{ id: 1 }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await autoHideTikTokAwareness(CFG, fetchImpl);
  assert.equal(result.actionable, 2);
  assert.equal(result.hidden, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.dbUpdated, 1);
  assert.deepEqual(result.slack, { eligible: 0, updated: 0, unavailable: 0, failed: 0 });
  assert.deepEqual(statusCalls, [['good', 'bad'], ['good'], ['bad']]);
  assert.equal(patchBodies[0].review_decision, 'hidden');
});
