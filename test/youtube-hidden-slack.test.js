import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHiddenYouTubeSlackBlocks, syncHiddenYouTubeSlackCards } from '../src/youtube-hidden-slack.js';

test('숨김 완료 카드는 댓글을 보존하되 버튼 없이 감사 상태만 표시한다', () => {
  const blocks = buildHiddenYouTubeSlackBlocks({
    post_url: 'https://youtube.com/watch?v=video1',
    comment_text: '제품 <별로> & 이상함',
  }, Date.parse('2026-08-14T12:00:00Z'));
  assert.equal(blocks.some((block) => block.type === 'actions'), false);
  assert.match(blocks[0].text.text, /숨김 처리 완료/);
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
  assert.deepEqual(result, { eligible: 1, updated: 1, failed: 0 });
  assert.deepEqual(sleeps, [2000]);
});
