import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnresolvedMessage,
  groupUnresolvedModerationRows,
  loadUnresolvedModerationRows,
  runModerationExecutionWatchdog,
  unresolvedActionLink,
} from '../src/moderation-execution-watchdog.js';

const CFG = {
  supabaseUrl: 'https://db.test', supabaseKey: 'svc',
  slackBotToken: 'bot', slackChannelId: 'CMAIN', slackWorkspaceHost: 'workspace.test',
  managedChannelCategories: ['온드미디어', '위성채널'], maxLinksPerMessage: 12,
  slackAssignees: { satellite: 'U_SAT', sponsorship: 'U_SPON', other: 'U_OTHER', jd: {}, p: {}, jg: {} },
};

const rows = [
  { id: 1, platform: 'tiktok', source: null, post_url: 'https://www.tiktok.com/@sat/video/1', review_decision: 'hide', hidden_confirmed: false, product_name: 'JD멜', channel_category: '위성채널', slack_channel_id: 'C1', slack_ts: '1.1' },
  { id: 2, platform: 'tiktok', source: null, post_url: 'https://www.tiktok.com/@sat/video/2', review_decision: 'hold', hidden_confirmed: false, product_name: 'JD멜', channel_category: '위성채널', slack_channel_id: 'C1', slack_ts: '1.2' },
  { id: 3, platform: 'youtube', source: 'youtube_ads', post_url: 'https://www.youtube.com/watch?v=ad3', review_decision: 'hide', hidden_confirmed: false, product_name: 'JD멜', channel_category: '인지 광고', slack_channel_id: 'C1', slack_ts: '1.3' },
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
  assert.match(message, /www\.tiktok\.com\/@sat\/video\/1\|▶ 영상 열기/);
  assert.match(message, /www\.tiktok\.com\/@sat\/video\/2\|▶ 영상 열기/);
  assert.doesNotMatch(message, /workspace\.test\/archives\/C1\/p11/);
  assert.doesNotMatch(message, /comment_id/);
});

test('수동숨김 대상은 post_url, 자동숨김 대상은 Slack 카드로 라우팅', () => {
  assert.deepEqual(unresolvedActionLink(CFG, rows[0], 0), {
    url: 'https://www.tiktok.com/@sat/video/1', label: '▶ 영상 열기', manual: true,
  });
  assert.deepEqual(unresolvedActionLink(CFG, rows[2], 2), {
    url: 'https://workspace.test/archives/C1/p13', label: '미해결 카드 3', manual: false,
  });

  const sponsorship = {
    ...rows[2], id: 5, platform: 'instagram', source: 'meta_ads',
    post_url: 'https://www.instagram.com/p/sponsored5/', channel_category: '협찬 (인플루언서)',
  };
  assert.deepEqual(unresolvedActionLink(CFG, sponsorship, 0), {
    url: sponsorship.post_url, label: '▶ 영상 열기', manual: true,
  });

  const explicitlyManual = {
    ...rows[2], id: 6, review_decision: 'manual_hide_required',
    post_url: 'https://www.youtube.com/watch?v=manual6',
  };
  assert.deepEqual(unresolvedActionLink(CFG, explicitlyManual, 0), {
    url: explicitlyManual.post_url, label: '▶ 영상 열기', manual: true,
  });
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
  assert.deepEqual(first, { unresolved: 2, groups: 1, alerted: 1, deduped: 0, reissued: 0, reissueFailed: 0 });
  assert.deepEqual(second, { unresolved: 2, groups: 1, alerted: 0, deduped: 1, reissued: 0, reissueFailed: 0 });
  assert.equal(slackBodies.length, 1);
  assert.equal(slackBodies[0].thread_ts, 'parent.1');
});

test('2026-10-21 재발방지: 수동 숨김 대상은 원래 카드가 살아 있을 때만 "처리 카드" 링크를 함께 준다', async () => {
  const { markLiveCards } = await import('../src/moderation-execution-watchdog.js');
  // 실제 사례: 바치케 바이럴(배너) IG — 담당자가 인스타에서 직접 숨겼지만 [✅ 완료]를 누를 카드를 못 찾음
  const banner = {
    id: 6782, platform: 'instagram', source: null, post_url: 'https://www.instagram.com/p/Dd_Uz2Cmd9v/',
    review_decision: null, hidden_confirmed: false, product_name: 'P바치', channel_category: '바이럴 (배너)',
    slack_channel_id: 'C1', slack_ts: '1790987861.547549',
  };
  const deleted = { ...banner, id: 6783, post_url: 'https://www.instagram.com/p/gone/', slack_ts: '1790987861.000001' };
  const asked = [];
  await markLiveCards(CFG, [banner, deleted], async (input) => {
    const url = new URL(String(input));
    asked.push(url.searchParams.get('ts'));
    return url.searchParams.get('ts') === banner.slack_ts
      ? response(200, { ok: true, messages: [{ ts: banner.slack_ts, thread_ts: '1790987860.899049' }] })
      : response(200, { ok: false, error: 'thread_not_found' });
  });
  assert.deepEqual(asked, [banner.slack_ts, deleted.slack_ts]);
  assert.deepEqual(unresolvedActionLink(CFG, banner, 0), {
    url: banner.post_url, label: '▶ 영상 열기', manual: true,
    cardUrl: 'https://workspace.test/archives/C1/p1790987861547549?thread_ts=1790987860.899049&cid=C1',
  });
  assert.deepEqual(unresolvedActionLink(CFG, deleted, 0), { url: deleted.post_url, label: '▶ 영상 열기', manual: true });

  const [group] = groupUnresolvedModerationRows([banner, deleted], CFG);
  const message = buildUnresolvedMessage(CFG, group);
  assert.match(message, /Dd_Uz2Cmd9v\/\|▶ 영상 열기> · <https:\/\/workspace\.test\/archives\/C1\/p1790987861547549\?thread_ts=1790987860\.899049&cid=C1\|처리 카드>/);
  assert.doesNotMatch(message, /p1790987861000001/);
  assert.match(message, /\[✅ 완료\]/);
});

test('2026-10-21 재발방지: 원래 카드가 지워진 수동 처리 건은 [완료]/[무시] 카드를 재발급하고 행의 카드 위치를 옮긴다', async () => {
  const { markLiveCards, reissueDeadCards, buildReissuedCardBlocks } = await import('../src/moderation-execution-watchdog.js');
  const cfg = { ...CFG, reissuePostIntervalMs: 0 };
  const gone = {
    id: 9001, platform: 'tiktok', source: null, post_url: 'https://www.tiktok.com/@sat/video/9',
    review_decision: 'hide', hidden_confirmed: false, product_name: 'JD멜', channel_category: '위성채널',
    slack_channel_id: 'C1', slack_ts: '100.1', comment_text: '맛없어 <script>',
  };
  const flaky = { ...gone, id: 9002, slack_ts: '100.2' };
  const orphan = { ...gone, id: 9003, slack_ts: '100.3' };
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push(`${init.method || 'GET'} ${url.replace(/\?.*$/, '')}${url.includes('id=eq.') ? ` ${url.match(/id=eq\.(\d+)/)[1]}` : ''}`);
    if (url.includes('conversations.replies')) {
      const ts = new URL(url).searchParams.get('ts');
      if (ts === '100.2') return response(200, { ok: false, error: 'ratelimited' }); // 일시 오류
      return response(200, { ok: false, error: 'thread_not_found' });
    }
    if (url.endsWith('chat.postMessage')) {
      const body = JSON.parse(init.body);
      assert.equal(body.thread_ts, 'parent.1');
      return response(200, { ok: true, channel: 'C1', ts: `new.${calls.length}` });
    }
    if (url.includes('/negative_comment_alerts?id=eq.')) {
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ['slack_channel_id', 'slack_ts']);
      assert.match(url, /hidden_confirmed=eq\.false/);
      return url.includes('id=eq.9003') ? response(200, []) : response(200, [{ id: 9001 }]);
    }
    if (url.endsWith('chat.delete')) return response(200, { ok: true });
    throw new Error(`unexpected ${url}`);
  };
  await markLiveCards(cfg, [gone, flaky, orphan], fetchImpl);
  assert.deepEqual([gone.card_alive, flaky.card_alive, orphan.card_alive], [false, null, false]);
  const result = await reissueDeadCards(cfg, [gone, flaky, orphan], 'parent.1', fetchImpl);
  assert.deepEqual(result, { reissued: 1, failed: 1 });
  // 성공: 행이 새 카드를 가리키고, 요약 링크도 새 카드로
  assert.equal(gone.card_alive, true);
  assert.match(gone.slack_ts, /^new\./);
  assert.equal(unresolvedActionLink(cfg, gone).cardUrl, `https://workspace.test/archives/C1/p${gone.slack_ts.replace('.', '')}?thread_ts=parent.1&cid=C1`);
  // 일시 오류 행은 재발급하지 않는다(중복 카드 방지)
  assert.equal(calls.filter((c) => c.includes('9002')).length, 0);
  // 행 갱신 실패 → 새 카드 삭제(고아 카드 금지), 행은 그대로
  assert.ok(calls.some((c) => c.endsWith('chat.delete')));
  assert.equal(orphan.slack_ts, '100.3');
  // 버튼: complete/ignore, value엔 라우트 분기용 키만
  const blocks = buildReissuedCardBlocks(gone);
  const actions = blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(actions.map((a) => a.action_id), ['complete', 'ignore']);
  assert.deepEqual(JSON.parse(actions[0].value), { source: '', platform: 'tiktok', channelCategory: '위성채널' });
  assert.match(JSON.stringify(blocks), /&lt;script&gt;/);
});
