import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditHiddenYouTubeOwnerAlerts,
  loadYouTubeHiddenAuditConfig,
  YOUTUBE_HIDDEN_AUDIT_CONFIRMATION,
} from '../src/youtube-owner-hidden-audit.js';

const BASE_ENV = {
  GOOGLE_ADS_CLIENT_ID: 'client',
  GOOGLE_ADS_CLIENT_SECRET: 'secret',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
};

const CFG = {
  googleAdsClientId: 'client', googleAdsClientSecret: 'secret',
  supabaseUrl: 'https://db.test', supabaseKey: 'service',
  youtubeApiBase: 'https://youtube.test/youtube/v3', batchSize: 50,
  dryRun: true, repairVisible: false,
};

function response(status, payload = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function fixtureFetch({ live = false } = {}) {
  const calls = [];
  let repaired = false;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/rest/v1/meta_tokens')) {
      return response(200, [{ kind: 'youtube_owner:ownerA', token: 'refreshA' }]);
    }
    if (url.includes('/rest/v1/negative_comment_alerts')) {
      if (init.method === 'PATCH') throw new Error('audit must not mutate review decisions');
      return response(200, [
        { id: 1, comment_id: 'rejectedA', post_url: 'https://youtube.com/watch?v=videoA1', review_decision: 'hidden' },
        { id: 2, comment_id: 'visibleA', post_url: 'https://youtube.com/watch?v=videoA1', review_decision: 'complete', reviewed_by: 'U1' },
        { id: 3, comment_id: 'missingA', post_url: 'https://youtube.com/watch?v=videoA1', review_decision: 'hide', reviewed_by: 'U2' },
        { id: 4, comment_id: 'ignoredA', post_url: 'https://youtube.com/watch?v=videoA1', review_decision: 'false_positive', reviewed_by: 'U3' },
      ]);
    }
    if (url.includes('oauth2.googleapis.com')) return response(200, { access_token: 'accessA' });
    if (url.includes('/channels')) return response(200, { items: [{ id: 'ownerA' }] });
    if (url.includes('/videos')) return response(200, { items: [{ id: 'videoA1', snippet: { channelId: 'ownerA' } }] });
    if (url.includes('/comments/setModerationStatus')) {
      assert.equal(live, true);
      assert.deepEqual(new URL(url).searchParams.get('id').split(','), ['visibleA']);
      repaired = true;
      return response(204);
    }
    if (url.includes('/comments?')) {
      const ids = new URL(url).searchParams.get('id').split(',');
      const part = new URL(url).searchParams.get('part');
      const items = [];
      if (ids.includes('rejectedA')) items.push({ id: 'rejectedA', snippet: { moderationStatus: 'rejected' } });
      if (ids.includes('visibleA') && !repaired) items.push({ id: 'visibleA', snippet: { moderationStatus: 'published' } });
      // rejectCommentsIsolated의 재확인은 part=id이며, repaired 뒤에는 빈 목록을 반환한다.
      if (part === 'id' && !repaired && ids.includes('visibleA')) items.push({ id: 'visibleA' });
      return response(200, { items });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}

test('YouTube hidden audit 설정은 라이브 복구 확인문구를 요구한다', () => {
  assert.equal(loadYouTubeHiddenAuditConfig(BASE_ENV).dryRun, true);
  assert.throws(() => loadYouTubeHiddenAuditConfig({
    ...BASE_ENV,
    YOUTUBE_HIDDEN_AUDIT_DRY_RUN: 'false',
    YOUTUBE_HIDDEN_AUDIT_REPAIR_VISIBLE: 'true',
  }), /REHIDE_VISIBLE_YOUTUBE_AD_ALERTS/);
  const config = loadYouTubeHiddenAuditConfig({
    ...BASE_ENV,
    YOUTUBE_HIDDEN_AUDIT_DRY_RUN: 'false',
    YOUTUBE_HIDDEN_AUDIT_REPAIR_VISIBLE: 'true',
    YOUTUBE_HIDDEN_AUDIT_CONFIRM: YOUTUBE_HIDDEN_AUDIT_CONFIRMATION,
  });
  assert.equal(config.repairVisible, true);
});

test('YouTube hidden audit dry-run은 rejected/공개/누락을 전수 집계하고 쓰지 않는다', async () => {
  const { fetchImpl, calls } = fixtureFetch();
  const result = await auditHiddenYouTubeOwnerAlerts(CFG, fetchImpl);
  assert.equal(result.expectedHiddenRows, 3);
  assert.equal(result.uniqueComments, 3);
  assert.equal(result.rejected, 1);
  assert.equal(result.visible, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.repairAttempted, 0);
  assert.equal(result.remainingVisible, 1);
  assert.equal(calls.some((call) => call.init.method === 'POST' && call.url.includes('setModerationStatus')), false);
  assert.equal(calls.some((call) => call.init.method === 'PATCH'), false);
  assert.equal(JSON.stringify(result).includes('visibleA'), false);
});

test('YouTube hidden audit 라이브는 확인된 공개 댓글만 재숨김하고 감사 DB를 보존한다', async () => {
  const { fetchImpl, calls } = fixtureFetch({ live: true });
  const result = await auditHiddenYouTubeOwnerAlerts(
    { ...CFG, dryRun: false, repairVisible: true }, fetchImpl,
  );
  assert.equal(result.repairAttempted, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.remainingVisible, 0);
  assert.equal(result.repairFailed, 0);
  assert.equal(calls.filter((call) => call.url.includes('/comments/setModerationStatus')).length, 1);
  assert.equal(calls.some((call) => call.init.method === 'PATCH'), false);
  assert.equal(JSON.stringify(result).includes('visibleA'), false);
});
