import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractPostKey } from './delta.js';
import {
  loadYouTubeOwnerAlerts,
  loadYouTubeOwnerTokens,
  mapVideosToOwners,
  refreshAndVerifyOwner,
  listYouTubeCommentStatesIsolated,
  rejectCommentsIsolated,
  YOUTUBE_OWNER_ALERT_SCOPES,
} from './youtube-owner-moderation.js';

export const YOUTUBE_HIDDEN_AUDIT_CONFIRMATION = 'REHIDE_VISIBLE_YOUTUBE_AD_ALERTS';
const EXPECTED_HIDDEN_DECISIONS = new Set(['hidden', 'hide', 'complete']);

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function loadYouTubeHiddenAuditConfig(env = process.env) {
  const dryRun = String(env.YOUTUBE_HIDDEN_AUDIT_DRY_RUN || 'true').toLowerCase() !== 'false';
  const repairVisible = String(env.YOUTUBE_HIDDEN_AUDIT_REPAIR_VISIBLE || 'false').toLowerCase() === 'true';
  const confirmation = String(env.YOUTUBE_HIDDEN_AUDIT_CONFIRM || '').trim();
  if (!dryRun && repairVisible && confirmation !== YOUTUBE_HIDDEN_AUDIT_CONFIRMATION) {
    throw new Error(`YouTube visible-comment repair requires YOUTUBE_HIDDEN_AUDIT_CONFIRM=${YOUTUBE_HIDDEN_AUDIT_CONFIRMATION}`);
  }
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    batchSize: positiveInt(env.YOUTUBE_HIDDEN_AUDIT_BATCH_SIZE, 50, 50),
    auditVideoIds: new Set(String(env.YOUTUBE_HIDDEN_AUDIT_VIDEO_IDS || '').split(',').map((item) => item.trim()).filter(Boolean)),
    includeOrganic: String(env.YOUTUBE_HIDDEN_AUDIT_INCLUDE_ORGANIC || 'false').toLowerCase() === 'true',
    dryRun,
    repairVisible,
  };
}

function videoIdFromAlert(alert) {
  const key = extractPostKey(alert.post_url);
  return key?.startsWith('yt:') ? key.slice(3) : '';
}

function expectedHidden(alert) {
  return EXPECTED_HIDDEN_DECISIONS.has(String(alert.review_decision || '').trim().toLowerCase());
}

async function loadAuditAlerts(config, fetchImpl) {
  const ads = await loadYouTubeOwnerAlerts({ ...config, alertScope: YOUTUBE_OWNER_ALERT_SCOPES.ADS }, fetchImpl);
  const rows = [...ads];
  if (config.includeOrganic) {
    rows.push(...await loadYouTubeOwnerAlerts({
      ...config,
      alertScope: YOUTUBE_OWNER_ALERT_SCOPES.ORGANIC_SATELLITE,
      allowedVideoIds: config.auditVideoIds,
    }, fetchImpl));
  }
  if (!config.auditVideoIds?.size) return rows;
  return rows.filter((row) => config.auditVideoIds.has(videoIdFromAlert(row)));
}

// DB에서 이미 숨김이 기대되는 YouTube 광고 댓글 전체를 소유 채널 OAuth로 대조한다.
// repairVisible=true인 라이브 실행만 실제 공개 댓글을 rejected로 되돌린다.
// review_decision/reviewed_by/reviewed_at은 사람/자동 처리 감사 원본이므로 쓰지 않는다.
export async function auditHiddenYouTubeOwnerAlerts(
  config = loadYouTubeHiddenAuditConfig(),
  fetchImpl = fetch,
) {
  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  if (!owners.length) throw new Error('No stored YouTube owner OAuth tokens');
  const alerts = await loadAuditAlerts(config, fetchImpl);
  const candidates = alerts.filter(expectedHidden);

  const accessTokens = new Map();
  const validOwners = [];
  let ownerTokenFailures = 0;
  for (const owner of owners) {
    try {
      accessTokens.set(owner.channelId, await refreshAndVerifyOwner(config, owner, fetchImpl));
      validOwners.push(owner);
    } catch {
      ownerTokenFailures += 1;
    }
  }
  if (!validOwners.length) throw new Error(`All stored YouTube owner OAuth tokens failed (${ownerTokenFailures}/${owners.length})`);

  const validCandidates = candidates.filter((row) => row.comment_id && videoIdFromAlert(row));
  const mapped = await mapVideosToOwners(config, validCandidates, validOwners, accessTokens, fetchImpl);
  const groups = new Map();
  let unmatchedRows = 0;
  let malformedRows = candidates.length - validCandidates.length;
  for (const row of validCandidates) {
    const ownerId = mapped.ownerByVideo.get(videoIdFromAlert(row));
    if (!ownerId) {
      unmatchedRows += 1;
      continue;
    }
    if (!groups.has(ownerId)) groups.set(ownerId, new Set());
    groups.get(ownerId).add(String(row.comment_id));
  }

  const result = {
    dryRun: config.dryRun,
    repairVisible: config.repairVisible,
    totalAlerts: alerts.length,
    expectedHiddenRows: candidates.length,
    uniqueComments: [...groups.values()].reduce((sum, ids) => sum + ids.size, 0),
    ownerTokens: owners.length,
    validOwnerTokens: validOwners.length,
    ownerTokenFailures,
    ownerMappingFailures: mapped.ownerErrors.length,
    malformedRows,
    unmatchedRows,
    rejected: 0,
    heldForReview: 0,
    missing: 0,
    visible: 0,
    lookupFailed: 0,
    channelFailures: 0,
    repairAttempted: 0,
    repaired: 0,
    disappearedDuringRepair: 0,
    repairFailed: 0,
    repairUnverified: 0,
    remainingVisible: 0,
    owners: [],
  };

  for (const owner of validOwners) {
    const ids = [...(groups.get(owner.channelId) || [])];
    const ownerResult = {
      target: ids.length,
      rejected: 0,
      heldForReview: 0,
      missing: 0,
      visible: 0,
      lookupFailed: 0,
      repaired: 0,
      remainingVisible: 0,
      failed: false,
    };
    if (!ids.length) {
      result.owners.push(ownerResult);
      continue;
    }
    const states = await listYouTubeCommentStatesIsolated(
      config, ids, accessTokens.get(owner.channelId), fetchImpl,
    );
    if (states.channelError) {
      ownerResult.failed = true;
      result.channelFailures += 1;
      result.owners.push(ownerResult);
      continue;
    }
    ownerResult.rejected = states.rejected.size;
    ownerResult.heldForReview = states.heldForReview.size;
    ownerResult.missing = states.missing.size;
    ownerResult.visible = states.visible.size;
    ownerResult.lookupFailed = states.failed.length;
    result.rejected += states.rejected.size;
    result.heldForReview += states.heldForReview.size;
    result.missing += states.missing.size;
    result.visible += states.visible.size;
    result.lookupFailed += states.failed.length;

    const visibleIds = [...states.visible];
    ownerResult.remainingVisible = visibleIds.length;
    if (!config.dryRun && config.repairVisible && visibleIds.length) {
      result.repairAttempted += visibleIds.length;
      const moderation = await rejectCommentsIsolated(
        config,
        visibleIds,
        accessTokens.get(owner.channelId),
        fetchImpl,
        async () => {},
      );
      ownerResult.repaired = moderation.confirmed.length;
      ownerResult.remainingVisible = Math.max(
        0,
        visibleIds.length - moderation.confirmed.length - moderation.unavailable.length,
      );
      result.repaired += moderation.confirmed.length;
      result.disappearedDuringRepair += moderation.unavailable.length;
      result.repairFailed += moderation.failed.length;
      result.repairUnverified += moderation.acceptedUnverified.length;
      if (moderation.channelError) {
        ownerResult.failed = true;
        result.channelFailures += 1;
      }
    }
    result.remainingVisible += ownerResult.remainingVisible;
    result.owners.push(ownerResult);
  }
  return result;
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  const lines = [
    '## YouTube 광고 숨김 전수 감사', '',
    `- 모드: ${result.dryRun ? 'DRY RUN(읽기전용)' : result.repairVisible ? '공개 잔여 자동 재숨김' : '읽기전용'}`,
    `- 숨김 기대 행: ${result.expectedHiddenRows} (고유 댓글 ${result.uniqueComments})`,
    `- 실제 rejected: ${result.rejected}`,
    `- 검토 대기(비공개·가역): ${result.heldForReview}`,
    `- 목록 미발견(숨김 또는 삭제): ${result.missing}`,
    `- 실제 공개: ${result.visible}`,
    `- 재숨김 시도/확정: ${result.repairAttempted}/${result.repaired}`,
    `- 재숨김 중 소멸: ${result.disappearedDuringRepair}`,
    `- 최종 공개 또는 확인 대기: ${result.remainingVisible}`,
    `- 조회/재숨김 실패: ${result.lookupFailed}/${result.repairFailed} (채널 실패 ${result.channelFailures})`,
    `- 소유 채널 미매칭/불량 행: ${result.unmatchedRows}/${result.malformedRows}`, '',
    '> 댓글 ID·본문·작성자·영상 ID·OAuth 토큰은 로그와 요약에 기록하지 않습니다.', '',
  ];
  await appendFile(file, lines.join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  auditHiddenYouTubeOwnerAlerts()
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await writeSummary(result);
      if (!result.dryRun && result.repairVisible && (
        result.remainingVisible || result.repairFailed || result.lookupFailed || result.channelFailures
      )) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(String(error.message || error));
      process.exitCode = 1;
    });
}
