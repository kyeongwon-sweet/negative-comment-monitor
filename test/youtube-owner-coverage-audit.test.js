import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isHighConfidenceOwnerAuditRisk,
  loadOwnerCoverageAuditConfig,
  selectOwnerAuditVideos,
  summarizeOwnerDetectionAudit,
} from '../src/youtube-owner-coverage-audit.js';
import { commentFingerprint } from '../src/dedup.js';

function candidate(id, count) {
  return { video: { id, statistics: { commentCount: String(count) } } };
}

test('coverage audit selects explicit videos or highest-comment samples deterministically', () => {
  const candidates = [candidate('low', 2), candidate('high', 100), candidate('mid', 20)];
  assert.deepEqual(selectOwnerAuditVideos(candidates, new Set(), 2).map((row) => row.video.id), ['high', 'mid']);
  assert.deepEqual(selectOwnerAuditVideos(candidates, new Set(['low']), 5).map((row) => row.video.id), ['low']);
});

test('coverage audit separates recorded, missing, deferred, and reports pipeline candidate rate', () => {
  const entries = [{
    target: { platform: 'youtube', postKey: 'yt:v1', youtubeVideoId: 'v1', videoTitle: 'video', channelName: 'owner' },
    comments: [
      { id: 'seen', platform: 'youtube', text: '라라스윗 맛없음' },
      { id: 'missing', platform: 'youtube', text: '쫀득바 사지마' },
      { id: 'deferred', platform: 'youtube', text: '광고?' },
      { id: 'normal', platform: 'youtube', text: '좋아요' },
    ],
  }];
  const risks = [[
    { alert: true },
    { alert: true },
    { alert: false, deferred: true, category: 'llm_deferred' },
    { alert: false },
  ]];
  const seen = new Set([commentFingerprint(entries[0].target, entries[0].comments[0])]);
  const summary = summarizeOwnerDetectionAudit(entries, risks, seen, { authenticatedChannels: 2 });

  assert.equal(summary.publicComments, 4);
  assert.equal(summary.negativeCandidates, 2);
  assert.equal(summary.alreadyAlerted, 1);
  assert.equal(summary.missing, 1);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.pipelineMissRatePercent, 50);
  assert.equal(summary.videos[0].missing, 1);
});

test('coverage audit counts brand-directed hard negatives but suppresses praise, acting critique, and user fights', () => {
  const entry = {
    target: {
      platform: 'youtube', postKey: 'yt:entertainment', productName: 'JD', brandName: '라라스윗',
      caption: '라라스윗 쫀득바 광고', ownedChannelBrandHostilityScope: true,
    },
  };
  assert.equal(isHighConfidenceOwnerAuditRisk(entry, { text: '광고 참신하다 잘만들었네' }, { alert: true, category: '브랜드 적대/조롱' }), false);
  assert.equal(isHighConfidenceOwnerAuditRisk(entry, { text: '이 광고 발연기네 ㅋㅋ' }, { alert: true, category: '브랜드 적대/조롱' }), false);
  assert.equal(isHighConfidenceOwnerAuditRisk(entry, { text: '너나 닥쳐 병신아' }, { alert: true, category: '욕설/비속어' }), false);
  assert.equal(isHighConfidenceOwnerAuditRisk(entry, { text: '라라스윗 왤케 비호감' }, { alert: true, category: '브랜드 적대/조롱' }), true);
  assert.equal(isHighConfidenceOwnerAuditRisk(entry, { text: '쫀득바 맛없으니 사지마' }, { alert: true, category: '제품 불만' }), true);
  assert.equal(isHighConfidenceOwnerAuditRisk(entry, { text: '허위광고 하지마라' }, { alert: true, category: '광고/바이럴 의심' }), true);
});

test('coverage audit defaults to live-cache consistency and non-singleton escalation thresholds', () => {
  const config = loadOwnerCoverageAuditConfig({
    SUPABASE_URL: 'https://db.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    SLACK_BOT_TOKEN: 'slack-token',
    GOOGLE_ADS_CLIENT_ID: 'client-id',
    GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  });
  assert.equal(config.auditForceReclassify, false);
  assert.equal(config.auditMissingAlertThreshold, 3);
  assert.equal(config.auditDeferredAlertThreshold, 25);
});
