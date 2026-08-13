import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadParentText, ensureDailyThread, markCompletedThreads, cleanupOrphanedCopyMessages } from '../src/threads.js';

const CFG = { supabaseUrl: 'https://db.example', supabaseKey: 'svc', slackBotToken: 'tok', slackChannelId: 'C0BHD9S69JA' };

test('buildThreadParentText: [상품] 카테고리 부정댓글 · 날짜 + 담당자 멘션', () => {
  assert.equal(
    buildThreadParentText('2026-08-03', 'U0B2PNXSFPD', '쫀득바', '협찬 (인플루언서)'),
    '🚨 *[쫀득바] 협찬 (인플루언서) 부정댓글* · 2026-08-03\n담당자: <@U0B2PNXSFPD>',
  );
  // 담당자 없으면 담당자 줄 생략, 라벨/카테고리 없으면 기타
  assert.equal(buildThreadParentText('2026-08-03', '', '', ''), '🚨 *[기타] 기타 부정댓글* · 2026-08-03');
});

test('ensureDailyThread: 이미 있으면 슬랙 발송 없이 기존 ts 반환', async () => {
  let posted = false;
  const fetchImpl = async (url, opts) => {
    if (/slack.com/.test(url)) { posted = true; return { ok: true, json: async () => ({ ok: true, ts: 'NEW' }) }; }
    return { ok: true, json: async () => [{ slack_ts: '111.222' }] }; // select 결과 존재
  };
  const ts = await ensureDailyThread(CFG, { kstDate: '2026-07-23', assignee: 'U1' }, fetchImpl);
  assert.equal(ts, '111.222');
  assert.equal(posted, false);
});

test('ensureDailyThread: 없으면 부모 발송 + 저장 + ts 반환', async () => {
  const calls = [];
  let selectCount = 0;
  const fetchImpl = async (url, opts) => {
    if (/slack.com\/api\/chat.postMessage/.test(url)) {
      calls.push('post'); return { ok: true, json: async () => ({ ok: true, ts: '999.000' }) };
    }
    if ((opts?.method || 'GET') === 'POST') { calls.push('insert'); return { ok: true, json: async () => [] }; } // upsert
    // select: 처음엔 없음, 저장 후 재조회 시 정본 반환
    selectCount += 1;
    return { ok: true, json: async () => (selectCount === 1 ? [] : [{ slack_ts: '999.000' }]) };
  };
  const ts = await ensureDailyThread(CFG, { kstDate: '2026-07-23', assignee: 'U8' }, fetchImpl);
  assert.equal(ts, '999.000');
  assert.deepEqual(calls, ['post', 'insert']);
});

test('ensureDailyThread: 비활성/실패는 null(최상위 발송 폴백)', async () => {
  assert.equal(await ensureDailyThread({}, { kstDate: '2026-07-23', assignee: 'U1' }, async () => ({ ok: true, json: async () => [] })), null);
  assert.equal(await ensureDailyThread(CFG, { kstDate: '2026-07-23', assignee: 'U1' }, async () => { throw new Error('down'); }), null);
  // 슬랙 발송 실패(ok:false)도 null
  const f = async (url) => (/slack.com/.test(url) ? { ok: true, json: async () => ({ ok: false }) } : { ok: true, json: async () => [] });
  assert.equal(await ensureDailyThread(CFG, { kstDate: '2026-07-23', assignee: 'U1' }, f), null);
});

test('markCompletedThreads: 미처리 카드(버튼) 없으면 완료느낌표(무시·숨김 처리분 남아도), 미처리·이미반응은 스킵', async () => {
  const CFG = { supabaseUrl: 'https://db', supabaseKey: 'k', slackBotToken: 'tok', slackChannelId: 'C1' };
  // T0=답글0(전부 삭제,→달림), T1=미처리 카드(버튼 있음,→스킵), T2=이미반응(→스킵), T3=처리분만(버튼 제거,→달림)
  const added = [];
  const fetchImpl = async (u, o) => {
    if (/alert_threads/.test(u)) return { ok: true, json: async () => [{ slack_ts: 'T0' }, { slack_ts: 'T1' }, { slack_ts: 'T2' }, { slack_ts: 'T3' }] };
    if (/conversations\.replies/.test(u)) {
      const ts = new URL(u).searchParams.get('ts');
      if (ts === 'T0') return { json: async () => ({ messages: [{ ts: 'T0', reactions: [] }] }) };
      if (ts === 'T1') return { json: async () => ({ messages: [{ ts: 'T1', reactions: [] }, { ts: 'r1', blocks: [{ type: 'section' }, { type: 'actions' }] }] }) };
      if (ts === 'T2') return { json: async () => ({ messages: [{ ts: 'T2', reactions: [{ name: '완료느낌표' }] }] }) };
      if (ts === 'T3') return { json: async () => ({ messages: [{ ts: 'T3', reactions: [] }, { ts: 'r3', blocks: [{ type: 'section' }, { type: 'context' }] }] }) };
    }
    if (/reactions\.add/.test(u)) { added.push(JSON.parse(o.body).timestamp); return { json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const marked = await markCompletedThreads(CFG, '2026-07-28', '완료느낌표', fetchImpl);
  assert.equal(marked, 2);
  assert.deepEqual(added.sort(), ['T0', 'T3']); // 미처리 카드 없는 T0(전부삭제)·T3(무시/숨김처리)만
});

test('markCompletedThreads: 비활성/조회실패는 0(무해)', async () => {
  assert.equal(await markCompletedThreads({}, '2026-07-28', '완료느낌표', async () => ({ ok: true, json: async () => [] })), 0);
  const CFG = { supabaseUrl: 'https://db', supabaseKey: 'k', slackBotToken: 't', slackChannelId: 'C1' };
  assert.equal(await markCompletedThreads(CFG, '2026-07-28', '완료느낌표', async () => ({ ok: false })), 0);
});

test('markCompletedThreads: replies 배열이 부모만 반환돼도 reply_count가 있으면 완료 반응을 달지 않음', async () => {
  const CFG = { supabaseUrl: 'https://db', supabaseKey: 'k', slackBotToken: 'tok', slackChannelId: 'C1' };
  const added = [];
  const fetchImpl = async (u, o) => {
    if (/alert_threads/.test(u)) return { ok: true, json: async () => [{ slack_ts: 'T0' }] };
    if (/conversations\.replies/.test(u)) return { json: async () => ({ messages: [{ ts: 'T0', reply_count: 1, reactions: [] }] }) };
    if (/reactions\.add/.test(u)) { added.push(JSON.parse(o.body).timestamp); return { json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const marked = await markCompletedThreads(CFG, '2026-07-30', '완료느낌표', fetchImpl);
  assert.equal(marked, 0);
  assert.deepEqual(added, []);
});

test('cleanupOrphanedCopyMessages: 카드 없는 게시물의 복사메시지만 삭제', async () => {
  const CFG = { supabaseUrl: 'https://db', supabaseKey: 'k', slackBotToken: 'tok', slackChannelId: 'C1' };
  const deleted = [];
  const cardBlock = { type: 'actions', elements: [{ value: JSON.stringify({ url: 'https://insta/p/A/' }) }] };
  const fetchImpl = async (u, o) => {
    if (/alert_threads/.test(u)) return { ok: true, json: async () => [{ slack_ts: 'T0' }] };
    if (/conversations\.replies/.test(u)) return { json: async () => ({ messages: [
      { ts: 'T0' },
      { ts: 'c1', blocks: [cardBlock] },                                     // 살아있는 카드(A)
      { ts: 'copyA', text: '```\n[업체]\n\n요청\nhttps://insta/p/A/\n```' }, // A 복사 → 유지
      { ts: 'copyB', text: '```\n[업체]\n\n요청\nhttps://insta/p/B/\n```' }, // B 복사(고아) → 삭제
    ] }) };
    if (/chat\.delete/.test(u)) { deleted.push(JSON.parse(o.body).ts); return { json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const n = await cleanupOrphanedCopyMessages(CFG, '2026-08-06', fetchImpl);
  assert.equal(n, 1);
  assert.deepEqual(deleted, ['copyB']);
});

test('cleanupOrphanedCopyMessages: 무시로 버튼 빠진 카드도 살아있음 → 복사메시지 유지(딥링크 키 매칭)', async () => {
  const CFG = { supabaseUrl: 'https://db', supabaseKey: 'k', slackBotToken: 'tok', slackChannelId: 'C1' };
  const deleted = [];
  // 무시(오탐) 처리된 카드: actions 버튼 없이 section에 딥링크(.../p/AAA/c/123/)만 남는다.
  const ignoredCard = { ts: 'card', blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: '<https://www.instagram.com/p/AAA/c/123/|user> / 댓글' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '무시(오탐)' }] },
  ] };
  const fetchImpl = async (u, o) => {
    if (/alert_threads/.test(u)) return { ok: true, json: async () => [{ slack_ts: 'T0' }] };
    if (/conversations\.replies/.test(u)) return { json: async () => ({ messages: [
      { ts: 'T0' },
      ignoredCard,                                                                          // 무시 카드(AAA) — 살아있음
      { ts: 'copyAAA', text: '```\n[업체]\n\n요청\nhttps://www.instagram.com/p/AAA/\n```' }, // AAA 복사 → 유지
      { ts: 'copyBBB', text: '```\n[업체]\n\n요청\nhttps://www.instagram.com/p/BBB/\n```' }, // BBB 카드 없음(고아) → 삭제
    ] }) };
    if (/chat\.delete/.test(u)) { deleted.push(JSON.parse(o.body).ts); return { json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const n = await cleanupOrphanedCopyMessages(CFG, '2026-08-13', fetchImpl);
  assert.equal(n, 1);
  assert.deepEqual(deleted, ['copyBBB']); // 무시 카드의 복사(AAA)는 유지, 카드 없는 BBB만 삭제
});
