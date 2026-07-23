import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadParentText, ensureDailyThread } from '../src/threads.js';

const CFG = { supabaseUrl: 'https://db.example', supabaseKey: 'svc', slackBotToken: 'tok', slackChannelId: 'C0BHD9S69JA' };

test('buildThreadParentText: [분류] 날짜 @담당자 형식', () => {
  assert.equal(
    buildThreadParentText('바이럴 (배너)', '2026-07-23', 'U09RCJ1B9ML'),
    '🚨 *[바이럴 (배너)]* 부정댓글 · 2026-07-23 <@U09RCJ1B9ML>',
  );
  assert.match(buildThreadParentText('', '2026-07-23', ''), /\[기타\]/); // 분류 없으면 기타, 멘션 없음
});

test('ensureDailyThread: 이미 있으면 슬랙 발송 없이 기존 ts 반환', async () => {
  let posted = false;
  const fetchImpl = async (url, opts) => {
    if (/slack.com/.test(url)) { posted = true; return { ok: true, json: async () => ({ ok: true, ts: 'NEW' }) }; }
    return { ok: true, json: async () => [{ slack_ts: '111.222' }] }; // select 결과 존재
  };
  const ts = await ensureDailyThread(CFG, { kstDate: '2026-07-23', channelCategory: '바이럴 (배너)', assignee: 'U1' }, fetchImpl);
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
  const ts = await ensureDailyThread(CFG, { kstDate: '2026-07-23', channelCategory: '온드미디어', assignee: 'U8' }, fetchImpl);
  assert.equal(ts, '999.000');
  assert.deepEqual(calls, ['post', 'insert']);
});

test('ensureDailyThread: 비활성/실패는 null(최상위 발송 폴백)', async () => {
  assert.equal(await ensureDailyThread({}, { kstDate: '2026-07-23', channelCategory: 'x' }, async () => ({ ok: true, json: async () => [] })), null);
  assert.equal(await ensureDailyThread(CFG, { kstDate: '2026-07-23', channelCategory: 'x' }, async () => { throw new Error('down'); }), null);
  // 슬랙 발송 실패(ok:false)도 null
  const f = async (url) => (/slack.com/.test(url) ? { ok: true, json: async () => ({ ok: false }) } : { ok: true, json: async () => [] });
  assert.equal(await ensureDailyThread(CFG, { kstDate: '2026-07-23', channelCategory: 'x' }, f), null);
});
