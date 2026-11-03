// 소유채널 15분 빠른 감시(2026-11-03 사용자 승인). 3시간 크론 소유채널 모니터(youtube-owner-channel.yml)가
// GitHub 크론 드롭으로 실제 5~7시간 간격으로 돌아 부정 댓글이 몇 시간 공개로 남았다
// (예: 11-03 06:43 한 회차에서 38건 일괄 숨김, 밤 10시 댓글이 새벽 4시 숨김).
// 이 잡은 15분 루프에서 채널마다 최신 댓글 스레드 1페이지(100개, quota 1 unit)만 읽어
// 최근 N시간 안의 새 댓글을 판정하고, 부정이면 소유채널 모니터와 같은 카드+알림행(결정 없음)을 남긴다.
// 숨김은 같은 루프의 pending-hide가 한다(대상 조건=추적 영상 — 그래서 처음 본 새 영상은 이 잡이 상태표에 등록한다).
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
import { parseHeldReviewChannels } from './youtube-owner-held-review.js';

const HOUR = 60 * 60 * 1000;
const HELD_REVIEW_LEDGER_PREFIX = 'held-review:';
// 보류 후 YouTube 반영 지연(목록에 잠시 공개로 남음)을 실패로 보지 않는 유예. 15분 회차 4번.
const HOLD_STUCK_GRACE_MS = 60 * 60 * 1000;

function sbHeaders(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function safeHeldChannels(raw) {
  try { return parseHeldReviewChannels(raw); } catch { return []; }
}

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
    // '모두 보류' 누락 감시: HELD_REVIEW_CHANNELS 채널에서 이 시각 이후 봇 승인 없이 공개된 새 댓글이 있으면
    // 그 영상은 보류가 빠진 것이다(새 광고영상에 댓글만 켜고 보류를 안 거는 일이 반복됨, 11-03).
    holdWatchChannels: safeHeldChannels(env.HELD_REVIEW_CHANNELS),
    holdWatchSince: Number.isFinite(Date.parse(env.YOUTUBE_OWNER_HOLD_WATCH_SINCE || ''))
      ? Date.parse(env.YOUTUBE_OWNER_HOLD_WATCH_SINCE) : null,
    // 보류 누락 영상의 새 공개 댓글을 봇이 보류로 돌릴지(11-03 사용자 '재발방지'). 명시적으로 켤 때만.
    holdEnforce: String(env.YOUTUBE_OWNER_HOLD_ENFORCE || '').toLowerCase() === 'true',
  };
}

// 보류 채널의 공개 댓글 중 감시 시작 이후 작성됐고 봇이 공개한 기록이 없는 것 → 영상별 개수.
// (봇이 공개한 댓글은 held-review 원장에 남는다. 채널 본인 댓글은 recentCommentsByVideo가 이미 뺐다.)
export function holdLeaksByVideo(byVideo, { since, approvedIds }) {
  const leaks = new Map();
  for (const [videoId, comments] of byVideo) {
    const leaked = comments.filter((c) => Date.parse(c.timestamp) >= since && !approvedIds.has(c.id));
    if (leaked.length) leaks.set(videoId, leaked);
  }
  return leaks;
}

async function approvedByBot(config, ids, fetchImpl) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const keys = ids.slice(i, i + 50).map((id) => `"${HELD_REVIEW_LEDGER_PREFIX}${String(id).replace(/"/g, '')}"`).join(',');
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/cost_usage_ledger?select=run_key&run_key=${encodeURIComponent(`in.(${keys})`)}`,
      { headers: sbHeaders(config) },
    );
    if (!response.ok) throw new Error(`held-review 원장 조회 실패(${response.status})`);
    for (const row of await response.json()) found.add(String(row.run_key).slice(HELD_REVIEW_LEDGER_PREFIX.length));
  }
  return found;
}

// 같은 영상은 하루 한 번만 알린다(원장 키 선점). 선점 성공=true.
async function claimHoldLeak(config, kstDate, videoId, fetchImpl, prefix = 'hold-missing') {
  const runKey = `${prefix}:${kstDate}:${videoId}`;
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: sbHeaders(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify({ run_key: runKey, kst_date: kstDate, apify_usd: 0, anthropic_usd: 0 }),
  });
  if (!response.ok) throw new Error(`보류 누락 알림 선점 실패(${response.status})`);
  const rows = await response.json();
  return { claimed: Array.isArray(rows) && rows.length > 0, runKey };
}

async function releaseHoldLeak(config, runKey, fetchImpl) {
  try {
    await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?run_key=eq.${encodeURIComponent(runKey)}`, {
      method: 'DELETE', headers: sbHeaders(config, { Prefer: 'return=minimal' }),
    });
  } catch { /* Slack 실패 시 다음 회차 재시도를 위한 best-effort */ }
}

// 보류 대행을 아직 한 적 없는 댓글 ID만 돌려준다(원장 hold-enforce:<id> 선점, 이미 있으면 제외).
async function claimHoldEnforce(config, kstDate, ids, fetchImpl) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/cost_usage_ledger?on_conflict=run_key`, {
    method: 'POST',
    headers: sbHeaders(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify(unique.map((id) => ({ run_key: `hold-enforce:${id}`, kst_date: kstDate, apify_usd: 0, anthropic_usd: 0 }))),
  });
  if (!response.ok) throw new Error(`보류 대행 선점 실패(${response.status})`);
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).map((row) => String(row.run_key).slice('hold-enforce:'.length));
}

async function registerNewOwnerVideos(config, channelId, items, now, fetchImpl) {
  const rows = items.map((item) => ({
    channel_id: channelId,
    video_id: String(item.id),
    video_title: String(item.snippet?.title || ''),
    published_at: item.snippet?.publishedAt || null,
    last_seen_at: new Date(now).toISOString(),
  }));
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/youtube_owner_video_state?on_conflict=channel_id,video_id`, {
    method: 'POST',
    headers: sbHeaders(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(`상태표 등록 실패(${response.status})`);
  return rows.length;
}

// 이미 보류를 시도한 댓글의 시도 시각(원장 created_at). 시도 후 한참 지나도 공개면 보류가 안 먹은 것.
async function holdEnforceTimes(config, ids, fetchImpl) {
  const times = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const keys = ids.slice(i, i + 50).map((id) => `"hold-enforce:${String(id).replace(/"/g, '')}"`).join(',');
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/cost_usage_ledger?select=run_key,created_at&run_key=${encodeURIComponent(`in.(${keys})`)}`,
      { headers: sbHeaders(config) },
    );
    if (!response.ok) throw new Error(`보류 대행 원장 조회 실패(${response.status})`);
    for (const row of await response.json()) times.set(String(row.run_key).slice('hold-enforce:'.length), Date.parse(row.created_at));
  }
  return times;
}

// 소유자 토큰으로 댓글을 보류(heldForReview)로 돌린다. 50개씩 한 요청(50 unit). 성공한 개수를 돌려준다.
async function holdComments(config, ids, accessToken, fetchImpl) {
  let held = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = new URL(`${config.youtubeApiBase}/comments/setModerationStatus`);
    url.searchParams.set('id', chunk.join(','));
    url.searchParams.set('moderationStatus', 'heldForReview');
    const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`setModerationStatus ${response.status}`);
    held += chunk.length;
  }
  return held;
}

export function holdLeakMessage(items, assignee = '') {
  const enforced = items.reduce((sum, it) => sum + (it.enforced || 0), 0);
  const lines = [
    `:warning: *'모두 보류' 빠진 영상 ${items.length}개* — 봇 승인 없이 새 댓글이 바로 공개됐습니다.`,
    ...(enforced ? [`봇이 그 댓글 ${enforced}개를 일단 보류로 돌렸습니다(괜찮은 댓글은 승인 봇이 15분 안에 다시 공개).`] : []),
    '스튜디오에서 영상별로 댓글 검토를 *모두 보류*로 바꿔주세요(댓글 켜짐/꺼짐은 그대로). 부정 댓글은 빠른 감시가 따로 숨깁니다.',
    '이미 *모두 보류*로 되어 있다면 그 댓글 작성자가 "승인된 사용자" 목록에 있거나 사람이 직접 승인한 경우입니다 — 아래 댓글을 확인해주세요.',
    ...items.map((it) => `• <https://studio.youtube.com/video/${it.videoId}/edit|${it.videoId}> · ${it.channelName}${it.title ? ` · ${it.title.slice(0, 40)}` : ''} · 공개된 새 댓글 ${it.count}개`
      + (it.leaked || []).slice(0, 3).map((c) => ` <https://www.youtube.com/watch?v=${it.videoId}&lc=${c.id}|댓글>`).join('')),
  ];
  if (assignee) lines.push(`담당자: <@${assignee}>`);
  return lines.join('\n');
}

// 봇 보류가 안 먹은 경우에만 사람에게 알린다(11-03 사용자: 보류 누락은 알림 말고 봇이 알아서).
export function holdStuckMessage(items, assignee = '') {
  const lines = [
    `:warning: *봇이 보류로 못 돌린 공개 댓글* — 영상 ${items.length}개`,
    '새 영상의 공개 댓글은 봇이 자동으로 보류하는데, 아래 댓글은 보류가 실패했거나 보류 후에도 다시 공개돼 있습니다.',
    '사람이 스튜디오에서 직접 승인했거나, 작성자가 "승인된 사용자"이면 정상일 수 있습니다. 아니면 확인해주세요.',
    ...items.map((it) => `• <https://studio.youtube.com/video/${it.videoId}/edit|${it.videoId}> · ${it.channelName}${it.title ? ` · ${it.title.slice(0, 40)}` : ''} · ${it.problem.length}개(${it.reason})`
      + it.problem.slice(0, 3).map((c) => ` <https://www.youtube.com/watch?v=${it.videoId}&lc=${c.id}|댓글>`).join('')),
  ];
  if (assignee) lines.push(`담당자: <@${assignee}>`);
  return lines.join('\n');
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
    ownerGateSuppressed: 0, ownerGateUnreviewed: 0, holdLeakVideos: 0, holdLeakAlerted: 0, holdLeakSilenced: 0, holdEnforced: 0,
    newVideosTracked: 0, errors: [],
  };
  const holdSince = new Map((config.holdWatchChannels || []).map((c) => [
    c.channelId, Math.max(c.since, config.holdWatchSince ?? Infinity),
  ]));
  const holdCandidates = []; // { channelId, channelName, videoId, comments }
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
      const newVideos = [];
      for (let i = 0; i < missing.length; i += 50) {
        // 상태표에 없는 새 영상은 제목을 채워야 상품 라우팅이 JD 폴백으로 새지 않는다(10-30 제과 오배정).
        const info = await googleGet(config, 'videos', { part: 'snippet', id: missing.slice(i, i + 50).join(','), maxResults: 50 }, accessToken, fetchImpl);
        summary.quotaUnits += 1;
        for (const item of info.items || []) {
          titles.set(String(item.id), String(item.snippet?.title || ''));
          if (String(item.snippet?.channelId || '') === channel.channelId) newVideos.push(item);
        }
      }
      // pending-hide는 상태표(추적) 영상만 숨긴다. 3시간 모니터가 새 영상을 등록하기 전(실제 5~7시간)엔
      // 빠른 감시 알림이 숨겨지지 않았다(11-03 5VNRIdPcGE4). 실제 채널이 확인된 새 영상만 최소 행으로 등록 —
      // 기존 행은 건드리지 않고(ignore-duplicates), 카운트는 비워 두어 3시간 모니터가 첫 스캔처럼 전체를 읽는다.
      if (newVideos.length && !config.dryRun) {
        try {
          summary.newVideosTracked += await registerNewOwnerVideos(config, channel.channelId, newVideos, now, fetchImpl);
        } catch (error) {
          summary.errors.push(`새 영상 등록 실패 ${channel.channelId}: ${String(error.message || error).slice(0, 120)}`);
        }
      }
      for (const [videoId, comments] of byVideo) {
        const video = { id: videoId, snippet: { title: titles.get(videoId) || '' } };
        const channelName = channelTitles.get(channel.channelId) || channel.name || channel.channelId;
        const target = ownerChannelTarget(config, channel, channelName, video, videoId, { current: comments.length });
        entries.push({ target, comments });
        summary.recentComments += comments.length;
        if (Number.isFinite(holdSince.get(channel.channelId))) {
          holdCandidates.push({ channelId: channel.channelId, channelName, videoId, title: titles.get(videoId) || '', comments });
        }
      }
    } catch (error) {
      // 한 채널 장애(401·quota)는 다른 채널을 막지 않는다. 다음 15분 회차가 다시 읽는다.
      summary.errors.push(`${channel.channelId}: ${String(error.message || error).slice(0, 160)}`);
    }
  }

  // '모두 보류' 누락 감시. 실패해도 부정 판정·카드 경로는 계속 간다.
  try {
    const ids = holdCandidates.flatMap((c) => c.comments.map((comment) => comment.id));
    const approvedIds = ids.length ? await approvedByBot(config, ids, fetchImpl) : new Set();
    const leaks = [];
    for (const candidate of holdCandidates) {
      const leaked = holdLeaksByVideo(new Map([[candidate.videoId, candidate.comments]]), {
        since: holdSince.get(candidate.channelId), approvedIds,
      }).get(candidate.videoId) || [];
      if (leaked.length) leaks.push({ ...candidate, count: leaked.length, leaked });
    }
    summary.holdLeakVideos = leaks.length;
    // 봇이 '모두 보류'를 대신한다: 새 영상에 사람이 보류를 안 걸어도(유튜브 API로는 영상 보류 설정을 못 바꿈)
    // 봇 승인 없이 공개된 새 댓글을 즉시 보류로 돌린다 → 다음 회차 승인 봇이 판정해 괜찮은 건 다시 공개.
    // 결과적으로 '모두 보류'와 같고 노출은 최대 한 회차(15분). 그래서 누락 자체는 알리지 않고(11-03 사용자 지시),
    // 봇 보류가 실패했거나 보류 후에도 공개로 남은 댓글만 알린다(hold-stuck, 영상당 하루 1회).
    if (leaks.length && !config.dryRun && config.holdEnforce) {
      // 채널 단위로 묶어 한 요청(50개까지 50 unit)에 보류한다 — 영상마다 따로 부르면 소유채널 확대 시 quota가 샌다.
      const byChannel = new Map();
      for (const leak of leaks) {
        if (!byChannel.has(leak.channelId)) byChannel.set(leak.channelId, []);
        byChannel.get(leak.channelId).push(leak);
      }
      for (const [channelId, channelLeaks] of byChannel) {
        const owner = tokens.get(channelId);
        if (!owner) {
          for (const leak of channelLeaks) { leak.problem = leak.leaked; leak.reason = '소유자 토큰 없음'; }
          continue;
        }
        try {
          // 댓글당 한 번만(원장 선점). YouTube가 보류를 무시하는 예외 댓글을 매 회차 다시 보류해 quota를 태우지 않게.
          const allIds = channelLeaks.flatMap((leak) => leak.leaked.map((c) => c.id));
          const fresh = new Set(await claimHoldEnforce(config, kstDateKey(now), allIds, fetchImpl));
          if (fresh.size) await holdComments(config, [...fresh], await tokenFor(owner), fetchImpl);
          // 예전에 이미 보류했는데 또 공개 = 보류가 안 먹음(사람 승인·승인된 사용자 등). 반영 지연은 유예한다.
          const retried = allIds.filter((id) => !fresh.has(id));
          const triedAt = retried.length ? await holdEnforceTimes(config, retried, fetchImpl) : new Map();
          for (const leak of channelLeaks) {
            leak.enforced = leak.leaked.filter((c) => fresh.has(c.id)).length;
            summary.holdEnforced += leak.enforced;
            leak.problem = leak.leaked.filter((c) => !fresh.has(c.id) && now - (triedAt.get(c.id) ?? now) >= HOLD_STUCK_GRACE_MS);
            if (leak.problem.length) leak.reason = '보류 후 다시 공개';
          }
        } catch (error) {
          for (const leak of channelLeaks) { leak.problem = leak.leaked; leak.reason = '봇 보류 실패'; }
          summary.errors.push(`보류 대행 실패 ${channelId}: ${String(error.message || error).slice(0, 120)}`);
        }
      }
    }
    // 봇 보류 대행이 켜져 있으면 보류 누락 자체는 알리지 않는다(봇이 처리). 보류가 안 먹은 댓글만 알린다.
    const enforcing = config.holdEnforce && !config.dryRun;
    const toAlert = enforcing ? leaks.filter((leak) => leak.problem?.length) : leaks;
    summary.holdLeakSilenced = leaks.length - toAlert.length;
    if (toAlert.length && !config.dryRun) {
      const kstDate = kstDateKey(now);
      const claimed = [];
      for (const leak of toAlert) {
        const claim = await claimHoldLeak(config, kstDate, leak.videoId, fetchImpl, enforcing ? 'hold-stuck' : 'hold-missing');
        if (claim.claimed) claimed.push({ ...leak, runKey: claim.runKey });
      }
      if (claimed.length) {
        try {
          const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel: config.slackChannelId, text: (enforcing ? holdStuckMessage : holdLeakMessage)(claimed, config.slackAssignees?.other || ''), unfurl_links: false }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) throw new Error(`Slack: ${payload.error || response.status}`);
          summary.holdLeakAlerted = claimed.length;
        } catch (error) {
          for (const leak of claimed) await releaseHoldLeak(config, leak.runKey, fetchImpl);
          throw error;
        }
      }
    }
    // 원인 추적용(공개 레포: ID·시각만): 11-03 첫 경고는 이미 '모두 보류'인 영상이었다(승인된 사용자·수정 댓글 의심).
    if (leaks.length) console.error(`[owner-fast-scan:hold-missing] ${leaks.map((l) => `${l.videoId}=${l.leaked.map((c) => `${c.id}@${c.timestamp}${c.updatedAt && c.updatedAt !== c.timestamp ? `~${c.updatedAt}` : ''}`).join(',')}`).join(' ')}`);
  } catch (error) {
    summary.errors.push(`보류 누락 감시 실패: ${String(error.message || error).slice(0, 160)}`);
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
