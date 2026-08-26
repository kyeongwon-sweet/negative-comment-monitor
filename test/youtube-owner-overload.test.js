import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessOwnerCommentOverload,
  buildOwnerOverloadWarning,
  maybeWarnOwnerCommentOverload,
} from '../src/youtube-owner-overload.js';

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const config = {
  supabaseUrl: 'https://db.test', supabaseKey: 'service',
  slackBotToken: 'slack', slackChannelId: 'C1',
  youtubeOwnerOverloadNegativeCount: 20,
  youtubeOwnerOverloadRatioPercent: 40,
  youtubeOwnerOverloadMinComments: 10,
  youtubeOwnerOverloadCooldownHours: 24,
};

const target = {
  youtubeVideoId: 'Video_ABC-1', channelName: '썰푸는앵무새', caption: '테스트 <영상>',
  ownedChannelBrandHostilityScope: true,
};

test('부정 수 또는 최소 표본 비율이 임계치를 넘을 때만 과부하로 판정한다', () => {
  const comments = Array.from({ length: 10 }, (_, index) => ({ text: String(index) }));
  assert.equal(assessOwnerCommentOverload(comments, comments.map((_, i) => ({ alert: i < 4 })), config).overloaded, true);
  assert.equal(assessOwnerCommentOverload(comments.slice(0, 5), comments.slice(0, 5).map((_, i) => ({ alert: i < 3 })), config).overloaded, false);
  const many = Array.from({ length: 30 }, () => ({ text: 'x' }));
  assert.equal(assessOwnerCommentOverload(many, many.map((_, i) => ({ alert: i < 20 })), config).overloaded, true);
});

test('과부하 경고는 Studio 링크·담당자를 포함하고 Slack 성공 뒤 쿨다운 상태를 남긴다', async () => {
  const calls = [];
  const assessment = { total: 50, negatives: 25, ratioPercent: 50, overloaded: true };
  const result = await maybeWarnOwnerCommentOverload(
    config, target, assessment, '123.45', 'U1',
    async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).includes('/platform_collection_health?platform=')) return response(200, []);
      if (String(input).includes('/platform_collection_health?on_conflict=')) {
        return response(200, [{ platform: 'hashed', last_alerted_at: '2026-08-26T00:00:00Z' }]);
      }
      if (String(input).includes('slack.com/api/chat.postMessage')) return response(200, { ok: true });
      throw new Error(`unexpected ${input}`);
    },
    Date.parse('2026-08-26T00:00:00Z'),
  );
  assert.equal(result.alerted, true);
  const slack = calls.find((call) => call.url.includes('chat.postMessage'));
  const body = JSON.parse(slack.init.body);
  assert.equal(body.thread_ts, '123.45');
  assert.match(body.text, /<@U1>/);
  assert.match(body.text, /studio\.youtube\.com\/video\/Video_ABC-1\/edit/);
  assert.match(body.text, /테스트 &lt;영상&gt;/);
});

test('일반·위성 target에는 과부하 경고 상태조회도 하지 않는다', async () => {
  let called = false;
  const result = await maybeWarnOwnerCommentOverload(
    config,
    { ...target, ownedChannelBrandHostilityScope: false },
    { total: 100, negatives: 100, ratioPercent: 100, overloaded: true },
    '1.2', '',
    async () => { called = true; throw new Error('must not call'); },
  );
  assert.equal(result.checked, false);
  assert.equal(called, false);
});
