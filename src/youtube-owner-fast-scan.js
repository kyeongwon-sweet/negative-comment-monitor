// 소유채널 15분 빠른 감시(2026-11-03 사용자 승인). 3시간 크론 소유채널 모니터(youtube-owner-channel.yml)가
// GitHub 크론 드롭으로 실제 5~7시간 간격으로 돌아 부정 댓글이 몇 시간 공개로 남았다
// (예: 11-03 06:43 한 회차에서 38건 일괄 숨김, 밤 10시 댓글이 새벽 4시 숨김).
// 이 잡은 15분 루프에서 채널마다 최신 댓글 스레드 1페이지(100개, quota 1 unit)만 읽어
// 최근 N시간 안의 새 댓글을 판정하고, 부정이면 소유채널 모니터와 같은 카드+알림행(결정 없음)을 남긴다.
// 숨김은 같은 루프의 pending-hide가 한다(기존 대상 조건 그대로 — 추적 영상만).
// - 전체 영상 목록·통계 조회(회당 ~70 unit)는 하지 않는다: 프로젝트 일일 quota 10,000을 지킨다
//   (회당 채널 11 + 채널명 1 = 12 unit).
// - 공개 댓글만 읽으므로 토큰 소유 검증(channels mine, 1 unit)은 생략하고 재발급만 한다.
// - 한계: order=time은 스레드(최상위 댓글) 기준이라 옛 스레드에 새로 달린 답글은 3시간 모니터가 잡는다.
// 공개 레포라 로그에는 개수·영상ID·댓글ID만 남긴다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadYouTubeOwnerChannelConfig, ownerChannelTarget } from './youtube-owner-channel.js';
import { loadYouTubeOwnerTokens } from './youtube-owner-moderation.js';
import { refreshGoogleAccessToken } from './youtube-ads.js';
import { ownerThreadRoute } from './youtube-owner-channel-run.js';
import { googleGet, loadVideoTitles, normalizeAuditComment } from './youtube-owner-public-audit.js';
import { classifyTargetsBatched, isLlmDeferred } from './hybrid-classify.js';
import { suppressLowConfidenceOwnerRisks } from './youtube-owner-risk.js';
import { commentFingerprint, loadSeenFingerprints, recordAlert } from './dedup.js';
import { computeClassifierHash } from './cache.js';
import { ensureDailyThread } from './threads.js';
import { kstDateKey } from './schedule.js';
import { sendAlert } from './slack.js';
import { retrySlackRateLimit } from './youtube-ads-run.js';

const HOUR = 60 * 60 * 1000;

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function loadFastScanConfig(env = process.env, now = Date.now()) {
  return {
    ...loadYouTubeOwnerChannelConfig(env, now),
    fastScanLookbackHours: clampInt(env.YOUTUBE_OWNER_FAST_LOOKBACK_HOURS, 6, 1, 48),
    // 폭주 방어: 한 회차 카드 상한. 넘친 건은 다음 회차(알림행 없으니 다시 후보)가 이어받는다.
    fastScanMaxAlerts: clampInt(env.YOUTUBE_OWNER_FAST_MAX_ALERTS, 40, 1, 200),
  };
}

// 채널 최신 스레드 1페이지에서 최근 댓글(최상위+포함 답글)만 영상별로 모은다. 채널 본인 댓글은 제외.
export function recentCommentsByVideo(threads, channelId, cutoff) {
  const byVideo = new Map();
  const add = (videoId, comment) => {
    if (!videoId || !comment.id || comment.authorChannelId === channelId) return;
    const at = Date.parse(comment.timestamp);
    if (!Number.isFinite(at) || at < cutoff) return;
    if (!byVideo.has(videoId)) byVideo.set(videoId, []);
    byVideo.get(videoId).push(comment);
  };
  for (const thread of threads || []) {
    const videoId = String(thread?.snippet?.videoId || '');
    const top = thread?.snippet?.topLevelComment;
    add(videoId, normalizeAuditComment(top, videoId));
    for (const reply of thread?.replies?.comments || []) add(videoId, normalizeAuditComment(reply, videoId, top?.id));
  }
  return byVideo;
}

export async function runOwnerFastScan(config, fetchImpl = fetch, now = Date.now(), classifier = undefined) {
  const summary = {
    channels: 0, threadsRead: 0, recentComments: 0, alreadyAlerted: 0, classified: 0,
    flagged: 0, sentAlerts: 0, capped: 0, deferred: 0, quotaUnits: 0,
    ownerGateSuppressed: 0, ownerGateUnreviewed: 0, errors: [],
  };
  const cutoff = now - config.fastScanLookbackHours * HOUR;
  const titles = await loadVideoTitles(config, fetchImpl);
  const tokens = new Map((await loadYouTubeOwnerTokens(config, fetchImpl)).map((o) => [o.channelId, o]));
  const entries = [];
  const accessTokens = new Map();
  const tokenFor = async (owner) => {
    if (!accessTokens.has(owner.channelId)) accessTokens.set(owner.channelId, await refreshGoogleAccessToken(config, owner.refreshToken, fetchImpl));
    return accessTokens.get(owner.channelId);
  };
  // 카드·시트의 채널명은 실제 채널 제목으로(설정 이름은 옛 이름일 수 있음: 11-03 먹는김에가 '썰푸는앵무새'로 표기).
  // 전 채널을 한 번에 조회(1 unit). 실패하면 설정 이름으로 폴백한다.
  const channelTitles = new Map();
  try {
    const firstOwner = config.youtubeOwnerChannels.map((c) => tokens.get(c.channelId)).find(Boolean);
    if (firstOwner) {
      const info = await googleGet(config, 'channels', {
        part: 'snippet', id: config.youtubeOwnerChannels.map((c) => c.channelId).join(','), maxResults: 50,
      }, await tokenFor(firstOwner), fetchImpl);
      summary.quotaUnits += 1;
      for (const item of info.items || []) channelTitles.set(String(item.id), String(item.snippet?.title || ''));
    }
  } catch (error) {
    summary.errors.push(`채널명 조회 실패(설정 이름 사용): ${String(error.message || error).slice(0, 120)}`);
  }
  for (const channel of config.youtubeOwnerChannels) {
    const owner = tokens.get(channel.channelId);
    if (!owner) { summary.errors.push(`${channel.channelId}: owner token 없음`); continue; }
    try {
      const accessToken = await tokenFor(owner);
      const payload = await googleGet(config, 'commentThreads', {
        part: 'snippet,replies', allThreadsRelatedToChannelId: channel.channelId, maxResults: 100,
        textFormat: 'plainText', order: 'time',
      }, accessToken, fetchImpl);
      summary.quotaUnits += 1;
      summary.channels += 1;
      summary.threadsRead += (payload.items || []).length;
      const byVideo = recentCommentsByVideo(payload.items, channel.channelId, cutoff);
      const missing = [...byVideo.keys()].filter((id) => !titles.get(id));
      for (let i = 0; i < missing.length; i += 50) {
        // 상태표에 없는 새 영상은 제목을 채워야 상품 라우팅이 JD 폴백으로 새지 않는다(10-30 제과 오배정).
        const info = await googleGet(config, 'videos', { part: 'snippet', id: missing.slice(i, i + 50).join(','), maxResults: 50 }, accessToken, fetchImpl);
        summary.quotaUnits += 1;
        for (const item of info.items || []) titles.set(String(item.id), String(item.snippet?.title || ''));
      }
      for (const [videoId, comments] of byVideo) {
        const video = { id: videoId, snippet: { title: titles.get(videoId) || '' } };
        const channelName = channelTitles.get(channel.channelId) || channel.name || channel.channelId;
        const target = ownerChannelTarget(config, channel, channelName, video, videoId, { current: comments.length });
        entries.push({ target, comments });
        summary.recentComments += comments.length;
      }
    } catch (error) {
      // 한 채널 장애(401·quota)는 다른 채널을 막지 않는다. 다음 15분 회차가 다시 읽는다.
      summary.errors.push(`${channel.channelId}: ${String(error.message || error).slice(0, 160)}`);
    }
  }

  // 이미 알림행이 있는 댓글(이 잡·3시간 모니터·사람 판정)은 다시 판정하지 않는다.
  const fresh = [];
  for (const entry of entries) {
    const fps = entry.comments.map((comment) => commentFingerprint(entry.target, comment));
    const seen = config.dryRun ? new Set() : await loadSeenFingerprints(config, fps, fetchImpl);
    const comments = entry.comments.filter((_, i) => !seen.has(fps[i]));
    summary.alreadyAlerted += entry.comments.length - comments.length;
    if (comments.length) fresh.push({ target: entry.target, comments });
  }
  summary.classified = fresh.reduce((sum, e) => sum + e.comments.length, 0);
  if (!fresh.length) return summary;

  // 분류 캐시는 3시간 모니터와 공유한다(같은 댓글을 두 잡이 따로 판정하지 않게).
  const llmStats = {};
  const risksPerEntry = await classifyTargetsBatched(fresh, config, classifier, llmStats, fetchImpl);
  let classifierHash = null;
  try { classifierHash = computeClassifierHash(config); } catch { classifierHash = null; }
  const flagged = [];
  fresh.forEach(({ target, comments }, e) => {
    const risks = risksPerEntry[e] || [];
    summary.deferred += risks.filter((risk) => isLlmDeferred(risk)).length;
    const gated = suppressLowConfidenceOwnerRisks(target, comments, risks);
    gated.forEach((risk, i) => {
      if (risk?.ownerLowConfidenceSuppressed === true) {
        summary.ownerGateSuppressed += 1;
        if (risk.engine === 'llm' && risk.ownedEscalationReviewed !== true) summary.ownerGateUnreviewed += 1;
      }
      if (risk?.alert === true) flagged.push({ target, comment: { ...comments[i], risk } });
    });
  });
  summary.flagged = flagged.length;
  if (summary.deferred > 0) summary.errors.push(`판정 보류 ${summary.deferred}건(LLM 실패·예산) — 다음 회차 재판정`);
  if (summary.ownerGateUnreviewed > 0) {
    // 강한 모델 2차 판정 없이 부정을 억제했다 = 설정 누락(OWNED_BRAND_ESCALATION_MODEL) 신호.
    summary.errors.push(`강한 모델 미검토 억제 ${summary.ownerGateUnreviewed}건`);
  }

  const threads = new Map();
  for (const item of flagged) {
    if (config.dryRun) {
      console.error(`[owner-fast-scan:dry-alert] ${item.target.youtubeVideoId} ${item.comment.id} engine=${item.comment.risk.engine || ''} category=${item.comment.risk.category || ''}`);
      continue;
    }
    if (summary.sentAlerts >= config.fastScanMaxAlerts) { summary.capped += 1; continue; }
    const route = ownerThreadRoute(item.target, config.slackAssignees);
    if (!threads.has(route.scopeKey)) {
      threads.set(route.scopeKey, await ensureDailyThread(config, {
        kstDate: kstDateKey(now), scopeKey: route.scopeKey, productLabel: route.label, category: route.category, assignee: route.assignee,
      }, fetchImpl));
    }
    const threadTs = threads.get(route.scopeKey);
    if (!threadTs) throw new Error('빠른 감시 카드 스레드 확보 실패 — 최상위 게시로 폴백하지 않음');
    if (config.youtubeOwnerAlertDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.youtubeOwnerAlertDelayMs));
    const fingerprint = commentFingerprint(item.target, item.comment);
    const slack = await retrySlackRateLimit(
      () => sendAlert(config, item.target, item.comment, fetchImpl, threadTs),
      { maxRetries: 5, retryDelayMs: 3000 },
    );
    await recordAlert(config, item.target, item.comment, fingerprint, slack.ts, classifierHash, fetchImpl);
    summary.sentAlerts += 1;
  }
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runOwnerFastScan(loadFastScanConfig())
    .then((summary) => {
      console.log(JSON.stringify(summary));
      if (summary.errors.length) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[owner-fast-scan] ${error.message}`);
      process.exitCode = 1;
    });
}
