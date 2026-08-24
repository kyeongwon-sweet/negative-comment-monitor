import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSheetRows,
  buildSheetSyncWarning,
  formatKstSeconds,
  loadNegativeCommentSheetSyncConfig,
  sheetRowFromAlert,
  syncPendingNegativeComments,
  validateSheetWebhookUrl,
} from '../src/negative-comment-sheet-sync.js';

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const config = {
  enabled: true,
  webhookUrl: 'https://script.google.com/macros/s/test/exec', webhookToken: 'secret',
  supabaseUrl: 'https://db.test', supabaseKey: 'db-key',
  slackBotToken: 'slack', slackChannelId: 'C1', assignee: 'U1',
  batchSize: 200, failureThreshold: 3, alertCooldownHours: 24,
};

test('시트 설정은 URL과 token이 모두 있을 때만 활성화한다', () => {
  assert.equal(loadNegativeCommentSheetSyncConfig({}).enabled, false);
  assert.equal(loadNegativeCommentSheetSyncConfig({
    NEGATIVE_COMMENT_SHEET_WEBHOOK_URL: 'https://script.google.com/macros/s/test/exec',
    NEGATIVE_COMMENT_SHEET_WEBHOOK_TOKEN: 'token',
  }).enabled, true);
});

test('시트 webhook은 HTTPS Apps Script /exec URL만 허용한다', () => {
  assert.equal(
    validateSheetWebhookUrl('https://script.google.com/macros/s/test/exec'),
    'https://script.google.com/macros/s/test/exec',
  );
  assert.throws(
    () => validateSheetWebhookUrl('#브이로그 #fyp #라라스윗'),
    /Apps Script \/exec URL/,
  );
  assert.throws(
    () => validateSheetWebhookUrl('https://example.com/exec'),
    /Apps Script \/exec URL/,
  );
});

test('DB 알림을 고정 11열+숨은 중복키 행으로 매핑한다', () => {
  const row = sheetRowFromAlert({
    fingerprint: 'fp', platform: 'instagram', post_url: 'https://instagram.com/p/x/',
    comment_id: 'c1', comment_text: '별로', alerted_at: '2026-08-21T00:00:00Z',
    category: '제품 불만', reason: '맛에 대한 부정 평가', product_name: 'JD멜',
    channel_category: '바이럴 (영상)', channel_name: '채널', asset_name: '소재', review_decision: null,
  });
  assert.deepEqual(row, {
    product: 'JD멜', channel: '바이럴 (영상)', reason: '맛에 대한 부정 평가',
    postUrl: 'https://instagram.com/p/x/', commentText: '별로', category: '제품 불만',
    platform: '인스타그램', channelName: '채널', assetName: '소재', status: '미처리',
    detectedAtKst: '2026-08-21 09:00:00', commentId: 'c1', fingerprint: 'fp',
  });
  assert.equal(formatKstSeconds('1787270400'), '2026-08-21 09:00:00');
});

test('웹훅 payload에는 token과 배치 rows만 보낸다', async () => {
  let body;
  const result = await appendSheetRows(config, [{ fingerprint: 'fp' }], async (_url, init) => {
    body = JSON.parse(init.body);
    return response(200, { ok: true, appended: 1, duplicates: 0 });
  });
  assert.equal(body.token, 'secret');
  assert.equal(body.rows.length, 1);
  assert.equal(result.appended, 1);
});

test('성공 시 append 후에만 outbox를 ack하고 health를 초기화한다', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/negative_comment_alerts') && (!init.method || init.method === 'GET')) {
      return response(200, [{
        id: 9, fingerprint: 'fp', platform: 'youtube', post_url: 'https://youtu.be/x', comment_id: 'c',
        comment_text: 'bad', alerted_at: '2026-08-21T00:00:00Z', category: '제품 불만', reason: '부정',
        product_name: 'JD', channel_category: '인지 광고', channel_name: '채널', asset_name: '소재',
        sheet_sync_attempts: 0,
      }]);
    }
    if (url === config.webhookUrl) return response(200, { ok: true, appended: 1, duplicates: 0 });
    if (url.includes('/negative_comment_alerts?id=in.') && init.method === 'PATCH') return response(200, [{ id: 9 }]);
    if (url.includes('/negative_comment_sheet_sync_health') && init.method === 'POST') return response(201, [{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  };
  const out = await syncPendingNegativeComments(config, fetchImpl, Date.parse('2026-08-21T01:00:00Z'));
  assert.equal(out.degraded, false);
  assert.equal(out.synced, 1);
  const webhookIndex = calls.findIndex((call) => call.url === config.webhookUrl);
  const ackIndex = calls.findIndex((call) => call.url.includes('/negative_comment_alerts?id=in.'));
  assert.ok(webhookIndex >= 0 && ackIndex > webhookIndex);
});

test('append 실패는 핵심 실행을 throw하지 않고 재시도 상태를 남긴다', async () => {
  let warningSent = false;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/negative_comment_alerts') && (!init.method || init.method === 'GET')) return response(200, [{ id: 9, fingerprint: 'fp', sheet_sync_attempts: 2 }]);
    if (url === config.webhookUrl) return response(503, { ok: false, error: 'down' });
    if (url.includes('/negative_comment_alerts?id=eq.') && init.method === 'PATCH') return response(204, {});
    if (url.includes('/negative_comment_sheet_sync_health') && (!init.method || init.method === 'GET')) {
      return response(200, [{ id: 1, consecutive_failures: 2 }]);
    }
    if (url === 'https://slack.com/api/chat.postMessage') { warningSent = true; return response(200, { ok: true }); }
    if (url.includes('/negative_comment_sheet_sync_health') && init.method === 'POST') return response(201, [{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  };
  const out = await syncPendingNegativeComments(config, fetchImpl, Date.parse('2026-08-21T01:00:00Z'));
  assert.equal(out.degraded, true);
  assert.equal(out.failures, 3);
  assert.equal(warningSent, true);
  assert.match(buildSheetSyncWarning(3, 1, 'U1'), /연속 3회 실패/);
});
