import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnresolvedMessage,
  groupUnresolvedModerationRows,
  loadUnresolvedModerationRows,
  runModerationExecutionWatchdog,
} from '../src/moderation-execution-watchdog.js';

const CFG = {
  supabaseUrl: 'https://db.test', supabaseKey: 'svc',
  slackBotToken: 'bot', slackChannelId: 'CMAIN', slackWorkspaceHost: 'workspace.test',
  managedChannelCategories: ['온드미디어', '위성채널'], maxLinksPerMessage: 12,
  slackAssignees: { satellite: 'U_SAT', sponsorship: 'U_SPON', other: 'U_OTHER', jd: {}, p: {}, jg: {} },
};

const rows = [
  { id: 1, platform: 'tiktok', source: null, review_decision: 'hide', hidden_confirmed: false, product_name: 'JD멜', channel_category: '위성채널', slack_channel_id: 'C1', slack_ts: '1.1' },
  { id: 2, platform: 'tiktok', source: null, review_decision: 'hold', hidden_confirmed: false, product_name: 'JD멜', channel_category: '위성채널', slack_channel_id: 'C1', slack_ts: '1.2' },
  { id: 3, platform: 'youtube', source: 'youtube_ads', review_decision: 'hide', hidden_confirmed: false, product_name: 'JD멜', channel_category: '인지 광고', slack_channel_id: 'C1', slack_ts: '1.3' },
  { id: 4, platform: 'instagram', source: null, review_decision: null, hidden_confirmed: false, product_name: '', channel_category: null },
];

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

test('미실행 조회는 hidden_confirmed=false + hide/hold/null이며 legacy category null을 제외', async () => {
  let requested;
  const result = await loadUnresolvedModerationRows(CFG, async (input) => {
    requested = new URL(String(input));
    return response(200, rows);
  });
  assert.equal(requested.searchParams.get('hidden_confirmed'), 'eq.false');
  assert.match(requested.searchParams.get('or'), /review_decision\.in\.\(hide,hold,manual_hide_required\)/);
  assert.deepEqual(result.map((row) => row.id), [1, 2, 3]);
});

test('카테고리×플랫폼 그룹에서 유기 TikTok hide는 수동 미실행으로 집계', () => {
  const groups = groupUnresolvedModerationRows(rows.slice(0, 3), CFG);
  const tiktok = groups.find((group) => group.platform === 'tiktok');
  assert.equal(tiktok.rows.length, 2);
  assert.equal(tiktok.assignee, 'U_SAT');
  assert.equal(tiktok.counts.manual_hide_required, 1);
  assert.equal(tiktok.counts.hold, 1);
  const message = buildUnresolvedMessage(CFG, tiktok);
  assert.match(message, /실제 숨김 미확인/);
  assert.match(message, /수동 숨김 필요 1/);
  assert.match(message, /workspace\.test\/archives\/C1\/p11/);
  assert.doesNotMatch(message, /comment_id/);
});

test('워치독은 일일 멱등 claim 뒤 기존 담당 스레드에만 알리고 재실행은 dedup', async () => {
  const slackBodies = [];
  let claimed = false;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/negative_comment_alerts')) return response(200, rows.slice(0, 2));
    if (url.includes('cost_usage_ledger?on_conflict=run_key')) {
      if (claimed) return response(201, []);
      claimed = true;
      return response(201, [{ run_key: 'claimed' }]);
    }
    if (url.includes('/alert_threads?select=slack_ts')) return response(200, [{ slack_ts: 'parent.1' }]);
    if (url === 'https://slack.com/api/chat.postMessage') {
      slackBodies.push(JSON.parse(init.body));
      return response(200, { ok: true, ts: 'reply.1' });
    }
    throw new Error(`unexpected ${url}`);
  };
  const first = await runModerationExecutionWatchdog(CFG, fetchImpl, Date.parse('2026-09-22T09:00:00Z'));
  const second = await runModerationExecutionWatchdog(CFG, fetchImpl, Date.parse('2026-09-22T10:00:00Z'));
  assert.deepEqual(first, { unresolved: 2, groups: 1, alerted: 1, deduped: 0 });
  assert.deepEqual(second, { unresolved: 2, groups: 1, alerted: 0, deduped: 1 });
  assert.equal(slackBodies.length, 1);
  assert.equal(slackBodies[0].thread_ts, 'parent.1');
});
