import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groundTruthVerdict,
  loadAuditAlert,
  loadGroundTruthConfig,
} from '../src/youtube-owner-ground-truth.js';

function response(status, payload = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('ground truth audit requires only secret-backed credentials and a DB alert id', () => {
  const config = loadGroundTruthConfig({
    GOOGLE_ADS_CLIENT_ID: 'client', GOOGLE_ADS_CLIENT_SECRET: 'secret',
    SUPABASE_URL: 'https://db.test/', SUPABASE_SERVICE_ROLE_KEY: 'service',
    YOUTUBE_OWNER_AUDIT_ALERT_ID: '671',
  });
  assert.equal(config.supabaseUrl, 'https://db.test');
  assert.equal(config.alertId, '671');
  assert.equal(config.maxPagesPerStatus, 50);
});

test('discoverable moderation state wins over direct id lookup ambiguity', () => {
  assert.equal(groundTruthVerdict({
    direct: { found: true, moderationStatus: '' },
    discoverable: { found: true, status: 'published', complete: true },
  }), 'published');
});

test('지상진실 감사는 광고뿐 아니라 소유채널 오가닉(source=null) 행도 받는다', async () => {
  const config = {
    supabaseUrl: 'https://db.test', supabaseKey: 'service', alertId: '7',
  };
  const alert = await loadAuditAlert(config, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('platform'), 'eq.youtube');
    assert.equal(url.searchParams.has('source'), false);
    return response(200, [{
      id: 7, comment_id: 'comment', post_url: 'https://youtu.be/videoAAAA01',
      review_decision: 'false_positive', source: null, platform: 'youtube',
    }]);
  });
  assert.equal(alert.videoId, 'videoAAAA01');
  assert.equal(alert.source, null);
});

test('complete absence is rejected-or-deleted, truncated scan stays unknown', () => {
  assert.equal(groundTruthVerdict({
    direct: { found: false, moderationStatus: '' },
    discoverable: { found: false, status: '', complete: true },
  }), 'rejected_or_deleted');
  assert.equal(groundTruthVerdict({
    direct: { found: false, moderationStatus: '' },
    discoverable: { found: false, status: '', complete: false },
  }), 'unknown_incomplete_scan');
});
