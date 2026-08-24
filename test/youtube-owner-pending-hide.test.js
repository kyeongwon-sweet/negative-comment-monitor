import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPendingModerationMadeProgress,
  combinePendingModerationResults,
  hidePendingYouTubeOwnerAlerts,
  loadTrackedOwnerVideoIds,
  pendingOwnerModerationConfig,
} from '../src/youtube-owner-pending-hide.js';
import { YOUTUBE_OWNER_ALERT_SCOPES } from '../src/youtube-owner-moderation.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const base = {
  supabaseUrl: 'https://db.test',
  supabaseKey: 'service',
  dryRun: false,
};

test('저장된 소유 채널 영상 ID를 중복 없이 모더레이션 허용목록으로 읽는다', async () => {
  let requested = '';
  const ids = await loadTrackedOwnerVideoIds(base, async (input) => {
    requested = String(input);
    return response(200, [{ video_id: 'videoA' }, { video_id: 'videoA' }, { video_id: 'videoB' }]);
  });
  assert.deepEqual([...ids], ['videoA', 'videoB']);
  assert.match(requested, /youtube_owner_video_state/);
  assert.match(requested, /select=video_id/);
});

test('15분 경량 모더레이션은 오가닉과 광고 범위를 모두 기존 엔진으로 처리한다', async () => {
  const received = [];
  const result = await hidePendingYouTubeOwnerAlerts(
    base,
    async () => response(200, [{ video_id: 'videoA' }]),
    Date.parse('2026-08-21T00:00:00Z'),
    async (config) => {
      received.push(config);
      return {
        alertScope: config.alertScope,
        eligibleCandidates: 1,
        trackedEligibleCandidates: 1,
        matchedCandidates: 1,
        attempted: 1,
        hidden: 1,
        moderationFailed: 0,
      };
    },
  );
  assert.equal(result.hidden, 2);
  assert.equal(result.trackedVideos, 1);
  assert.deepEqual(received.map((item) => item.alertScope), [
    YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
    YOUTUBE_OWNER_ALERT_SCOPES.ADS,
  ]);
  assert.equal(received.every((item) => item.autoHideAllNegatives), true);
  assert.deepEqual([...received[0].allowedVideoIds], ['videoA']);
  assert.equal(received[0].actor, 'youtube-owner-pending-auto-hide');
});

test('추적 영상이 없으면 OAuth·YouTube 모더레이션을 호출하지 않는다', async () => {
  let called = false;
  const result = await hidePendingYouTubeOwnerAlerts(
    base,
    async () => response(200, []),
    Date.now(),
    async () => { called = true; },
  );
  assert.equal(called, false);
  assert.equal(result.skipped, 'no-tracked-owner-videos');
});

test('경량 모더레이션 설정은 실제 숨김·50개 배치로 고정한다', () => {
  const config = pendingOwnerModerationConfig({ dryRun: true }, new Set(['videoA']));
  assert.equal(config.dryRun, false);
  assert.equal(config.singleAlert, false);
  assert.equal(config.batchSize, 50);
  assert.equal(config.alertScope, YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE);
});

test('두 범위 결과를 합쳐 pending 처리량을 정확히 노출한다', () => {
  const result = combinePendingModerationResults([
    { alertScope: 'organic_satellite', eligibleCandidates: 3, matchedCandidates: 2, attempted: 2, hidden: 2 },
    { alertScope: 'youtube_ads', eligibleCandidates: 5, matchedCandidates: 4, attempted: 4, hidden: 3 },
  ]);
  assert.equal(result.eligibleCandidates, 8);
  assert.equal(result.matchedCandidates, 6);
  assert.equal(result.attempted, 6);
  assert.equal(result.hidden, 5);
  assert.equal(result.scopes.length, 2);
});

test('처리 대상이 있는데 attempted·해결 신호가 모두 0이면 무음 성공을 거부한다', () => {
  assert.throws(() => assertPendingModerationMadeProgress({
    trackedEligibleCandidates: 4,
    matchedCandidates: 4,
    attempted: 0,
    unavailableOrAlreadyHidden: 0,
    moderationFailed: 0,
    channelFailures: 0,
  }), /made no progress/);
});

test('이미 숨김·삭제되어 unavailable로 수렴한 대상은 정상 진행으로 인정한다', () => {
  assert.doesNotThrow(() => assertPendingModerationMadeProgress({
    trackedEligibleCandidates: 4,
    matchedCandidates: 4,
    attempted: 0,
    unavailableOrAlreadyHidden: 4,
  }));
});
