import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHiddenYouTubeSlackBlocks, syncHiddenYouTubeSlackCards } from '../src/youtube-hidden-slack.js';

test('숨김 완료 카드는 댓글을 보존하되 버튼 없이 감사 상태만 표시한다', () => {
  const blocks = buildHiddenYouTubeSlackBlocks({
    post_url: 'https://youtube.com/watch?v=video1&lc=comment1',
    comment_text: '제품 <별로> & 이상함',
  }, Date.parse('2026-08-14T12:00:00Z'));
  assert.equal(blocks.some((block) => block.type === 'actions'), false);
  assert.match(blocks[0].text.text, /숨김 처리 완료/);
  assert.match(blocks[0].text.text, /video1&amp;lc=comment1/);
  assert.match(blocks[0].text.text, /&lt;별로&gt; &amp; 이상함/);
});

test('Slack chat.update rate limit은 Retry-After 후 한 번 재시도한다', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await syncHiddenYouTubeSlackCards({
    slackBotToken: 'token', slackUpdateDelayMs: 0,
  }, [{ slack_channel_id: 'C1', slack_ts: '1.2', post_url: 'https://youtube.com/watch?v=v1' }], async () => {
    calls += 1;
    if (calls === 1) return {
      ok: false, status: 429, headers: { get: () => '2' }, json: async () => ({ ok: false, error: 'ratelimited' }),
    };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  }, async (ms) => { sleeps.push(ms); });
  assert.deepEqual(result, { eligible: 1, updated: 1, unavailable: 0, failed: 0, failureReasons: {} });
  assert.deepEqual(sleeps, [2000]);
});

test('삭제됐거나 수정 불가능한 Slack 카드는 실패 대신 unavailable로 집계한다', async () => {
  const result = await syncHiddenYouTubeSlackCards({
    slackBotToken: 'token', slackUpdateDelayMs: 0,
  }, [
    { slack_channel_id: 'C1', slack_ts: '1.2' },
    { slack_channel_id: 'C1', slack_ts: '1.3' },
  ], async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: false, error: 'message_not_found' }),
  }));
  assert.deepEqual(result, { eligible: 2, updated: 0, unavailable: 2, failed: 0, failureReasons: {} });
});

test('그 외 Slack 오류는 원인별로 집계한다', async () => {
  const result = await syncHiddenYouTubeSlackCards({
    slackBotToken: 'token', slackUpdateDelayMs: 0,
  }, [{ slack_channel_id: 'C1', slack_ts: '1.2' }], async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: false, error: 'not_in_channel' }),
  }));
  assert.deepEqual(result, {
    eligible: 1,
    updated: 0,
    unavailable: 0,
    failed: 1,
    failureReasons: { not_in_channel: 1 },
  });
});
