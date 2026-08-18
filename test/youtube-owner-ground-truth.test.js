import test from 'node:test';
import assert from 'node:assert/strict';
import { groundTruthVerdict, loadGroundTruthConfig } from '../src/youtube-owner-ground-truth.js';

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
