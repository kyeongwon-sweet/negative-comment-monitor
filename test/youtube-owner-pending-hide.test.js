import test from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('15분 경량 모더레이션은 오가닉 소유 범위와 keep 가드를 사용하는 기존 엔진을 재사용한다', async () => {
  let received;
  const result = await hidePendingYouTubeOwnerAlerts(
    base,
    async () => response(200, [{ video_id: 'videoA' }]),
    Date.parse('2026-08-21T00:00:00Z'),
    async (config) => {
      received = config;
      return { hidden: 2, moderationFailed: 0 };
    },
  );
  assert.equal(result.hidden, 2);
  assert.equal(result.trackedVideos, 1);
  assert.equal(received.alertScope, YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE);
  assert.equal(received.autoHideAllNegatives, true);
  assert.deepEqual([...received.allowedVideoIds], ['videoA']);
  assert.equal(received.actor, 'youtube-owner-pending-auto-hide');
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
