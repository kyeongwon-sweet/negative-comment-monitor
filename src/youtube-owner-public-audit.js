// 소유채널 공개 댓글 매일 재감사(2026-10-30 사용자 승인). '새 기준은 새 댓글에만'(10-12) 때문에 기준을 강화해도
// 이미 판정된 옛 공개 댓글은 계속 공개로 남았다(품절 반박·출연자 비하 등 사람이 손으로 찾아 숨김).
// 이 잡은 소유채널의 현재 공개 댓글 전체를 현재 기준으로 다시 판정하되, **자동으로 숨기지 않는다**:
// - 부정 판정은 데일리 스레드에 카드로 올리고 알림행을 review_decision='hold'로 적재한다.
//   'hold'는 youtube-owner-pending-hide(15분 자동숨김)의 대상이 아니다 → 사람이 [숨김]을 눌러 decision=hide가
//   되어야만 숨겨진다(10-05·10-12 월요일 일괄숨김 사고 재발 방지).
// - 이미 알림행이 있는 댓글(봇·사람이 판정)은 다시 올리지 않는다. 사람이 [승인]/[무시]하면 영구 제외.
// - 분류 캐시는 우회해 현재 기준으로 판정하되 캐시에 쓰지 않는다(정규 감시 경로에 영향 없음).
// 공개 레포라 로그에는 개수·영상ID·댓글ID만 남긴다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadYouTubeOwnerChannelConfig, ownerChannelTarget } from './youtube-owner-channel.js';
import { loadYouTubeOwnerTokens, refreshAndVerifyOwner } from './youtube-owner-moderation.js';
import { ownerThreadRoute } from './youtube-owner-channel-run.js';
import { classifyTargetsBatched, isLlmDeferred } from './hybrid-classify.js';
import { suppressLowConfidenceOwnerRisks } from './youtube-owner-risk.js';
import { commentFingerprint, loadSeenFingerprints } from './dedup.js';
import { computeClassifierHash } from './cache.js';
import { ensureDailyThread } from './threads.js';
import { kstDateKey } from './schedule.js';
import { sendAlert } from './slack.js';

export const PUBLIC_AUDIT_ACTOR = 'owner-public-audit';

export function loadPublicAuditConfig(env = process.env, now = Date.now()) {
  const base = loadYouTubeOwnerChannelConfig(env, now);
  const managed = new Set([...(base.managedChannelCategories || []), '소유 youtube', '위성채널']);
  return {
    ...base,
    // 카드에 [숨김] 버튼이 붙도록 소유 YouTube·위성채널을 관리 카테고리로 취급한다(owner OAuth 숨김 경로).
    managedChannelCategories: [...managed],
    publicAuditDryRun: String(env.PUBLIC_AUDIT_DRY_RUN || 'true').toLowerCase() !== 'false',
    publicAuditMaxCards: Math.max(1, Math.min(200, Number(env.PUBLIC_AUDIT_MAX_CARDS || 30))),
    publicAuditMaxPages: Math.max(1, Math.min(100, Number(env.PUBLIC_AUDIT_MAX_PAGES || 30))),
    publicAuditMaxReplyPages: Math.max(1, Math.min(20, Number(env.PUBLIC_AUDIT_MAX_REPLY_PAGES || 5))),
  };
}

function sbHeaders(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

async function googleGet(config, resource, params, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/${resource}`);
  for (const [key, value] of Object.entries(params)) if (value !== '' && value != null) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean).join(',');
    throw new Error(`YouTube ${resource} failed (${response.status})${reasons ? `: ${reasons}` : ''}`);
  }
  return payload;
}

export function normalizeAuditComment(comment, videoId, parentId = '') {
  const s = comment?.snippet || {};
  const authorChannelId = typeof s.authorChannelId === 'object' ? s.authorChannelId?.value : s.authorChannelId;
  return {
    id: String(comment?.id || ''),
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(comment?.id || '')}`,
    username: String(s.authorDisplayName || ''),
    authorChannelId: String(authorChannelId || ''),
    authorDisplayName: String(s.authorDisplayName || ''),
    text: String(s.textOriginal ?? s.textDisplay ?? ''),
    timestamp: String(s.publishedAt || s.updatedAt || ''),
    parentId: String(parentId || s.parentId || ''),
  };
}

// 채널 전체 공개 스레드(최상위+답글)를 영상별로 모은다. 채널 본인 댓글은 제외.
export async function listPublicCommentsByVideo(config, channelId, accessToken, fetchImpl) {
  const byVideo = new Map();
  const add = (videoId, comment) => {
    if (!videoId || !comment.id || comment.authorChannelId === channelId) return;
    if (!byVideo.has(videoId)) byVideo.set(videoId, []);
    byVideo.get(videoId).push(comment);
  };
  let pageToken = '';
  let pages = 0;
  do {
    const payload = await googleGet(config, 'commentThreads', {
      part: 'snippet,replies', allThreadsRelatedToChannelId: channelId, maxResults: 100,
      textFormat: 'plainText', order: 'time', pageToken,
    }, accessToken, fetchImpl);
    for (const thread of payload.items || []) {
      const videoId = String(thread?.snippet?.videoId || '');
      const top = thread?.snippet?.topLevelComment;
      add(videoId, normalizeAuditComment(top, videoId));
      const embedded = thread?.replies?.comments || [];
      const total = Number(thread?.snippet?.totalReplyCount || 0);
      if (total > embedded.length) {
        let replyToken = '';
        for (let page = 0; page < config.publicAuditMaxReplyPages; page += 1) {
          const replies = await googleGet(config, 'comments', {
            part: 'id,snippet', parentId: top?.id, maxResults: 100, textFormat: 'plainText', pageToken: replyToken,
          }, accessToken, fetchImpl);
          for (const reply of replies.items || []) add(videoId, normalizeAuditComment(reply, videoId, top?.id));
          replyToken = String(replies.nextPageToken || '');
          if (!replyToken) break;
        }
      } else {
        for (const reply of embedded) add(videoId, normalizeAuditComment(reply, videoId, top?.id));
      }
    }
    pageToken = String(payload.nextPageToken || '');
    pages += 1;
  } while (pageToken && pages < config.publicAuditMaxPages);
  return { byVideo, truncated: Boolean(pageToken) };
}

async function loadVideoTitles(config, fetchImpl) {
  const titles = new Map();
  for (let offset = 0; ; offset += 1000) {
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/youtube_owner_video_state?select=video_id,video_title&order=video_id.asc&offset=${offset}&limit=1000`,
      { headers: sbHeaders(config) },
    );
    if (!response.ok) throw new Error(`youtube_owner_video_state read failed (${response.status})`);
    const rows = await response.json();
    for (const row of rows) titles.set(String(row.video_id), String(row.video_title || ''));
    if (rows.length < 1000) break;
  }
  return titles;
}

async function seenFingerprints(config, fingerprints, fetchImpl) {
  const seen = new Set();
  for (let i = 0; i < fingerprints.length; i += 50) {
    for (const fp of await loadSeenFingerprints(config, fingerprints.slice(i, i + 50), fetchImpl)) seen.add(fp);
  }
  return seen;
}

// 'hold'로 적재해 15분 자동숨김(pending-hide)에서 빠지게 한다. 사람이 [숨김]을 눌러야 decision=hide.
export function auditAlertRow(config, target, comment, fingerprint, slackTs, classifierHash, nowIso) {
  return {
    fingerprint,
    platform: 'youtube',
    post_url: String(target.url || ''),
    comment_id: String(comment.id || '') || null,
    comment_text: String(comment.text || ''),
    slack_channel_id: String(config.slackChannelId || ''),
    slack_ts: String(slackTs || '') || null,
    classifier_hash: classifierHash || null,
    source: null,
    category: String(comment.risk?.category || '') || null,
    reason: String(comment.risk?.reason || '') || null,
    product_name: String(target.productName || '') || null,
    channel_category: String(target.channelCategory || '') || null,
    channel_name: String(target.channelName || '') || null,
    comment_timestamp: String(comment.timestamp || '') || null,
    author_channel_id: String(comment.authorChannelId || '') || null,
    author_display_name: String(comment.authorDisplayName || comment.username || '') || null,
    review_decision: 'hold',
    reviewed_by: PUBLIC_AUDIT_ACTOR,
    reviewed_at: nowIso,
  };
}

async function insertAuditAlert(config, row, fetchImpl) {
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/negative_comment_alerts?on_conflict=fingerprint`, {
    method: 'POST',
    headers: sbHeaders(config, { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new Error(`재감사 알림행 적재 실패(${response.status}): ${(await response.text()).slice(0, 160)}`);
}

export async function runPublicAudit(config, fetchImpl = fetch, now = Date.now(), classifier = undefined) {
  const summary = {
    dryRun: config.publicAuditDryRun, channels: [], videos: 0, publicComments: 0, alreadyJudged: 0,
    reviewed: 0, flagged: 0, deferred: 0, cardsPosted: 0, cardsCapped: 0, errors: [],
  };
  const titles = await loadVideoTitles(config, fetchImpl);
  const tokens = new Map((await loadYouTubeOwnerTokens(config, fetchImpl)).map((o) => [o.channelId, o]));
  const entries = [];
  for (const channel of config.youtubeOwnerChannels) {
    const owner = tokens.get(channel.channelId);
    const row = { channelId: channel.channelId, videos: 0, comments: 0, truncated: false };
    summary.channels.push(row);
    if (!owner) { row.error = 'owner token 없음'; continue; }
    try {
      const accessToken = await refreshAndVerifyOwner(config, owner, fetchImpl);
      const info = await googleGet(config, 'channels', { part: 'snippet', id: channel.channelId, maxResults: 1 }, accessToken, fetchImpl);
      const channelName = String(info?.items?.[0]?.snippet?.title || channel.name || channel.channelId);
      const { byVideo, truncated } = await listPublicCommentsByVideo(config, channel.channelId, accessToken, fetchImpl);
      row.truncated = truncated;
      for (const [videoId, comments] of byVideo) {
        const video = { id: videoId, snippet: { title: titles.get(videoId) || '' }, statistics: { commentCount: String(comments.length) } };
        const target = ownerChannelTarget(config, channel, channelName, video, videoId, { current: comments.length, forceReclassify: true });
        entries.push({ target, comments });
        row.videos += 1;
        row.comments += comments.length;
      }
    } catch (error) {
      row.error = String(error.message || error);
      summary.errors.push(`${channel.channelId}: ${row.error}`);
    }
  }
  summary.videos = entries.length;
  summary.publicComments = entries.reduce((sum, e) => sum + e.comments.length, 0);

  // 이미 알림행이 있는 댓글(봇·사람 판정)은 다시 판정하지 않는다.
  const fresh = [];
  for (const entry of entries) {
    const fps = entry.comments.map((comment) => commentFingerprint(entry.target, comment));
    const seen = await seenFingerprints(config, fps, fetchImpl);
    const comments = entry.comments.filter((_, i) => !seen.has(fps[i]));
    summary.alreadyJudged += entry.comments.length - comments.length;
    if (comments.length) fresh.push({ target: entry.target, comments });
  }
  summary.reviewed = fresh.reduce((sum, e) => sum + e.comments.length, 0);
  if (!fresh.length) return summary;

  const llmStats = {};
  const risksPerEntry = await classifyTargetsBatched(
    fresh, { ...config, classificationCacheReadOnly: true }, classifier, llmStats, fetchImpl,
  );
  let classifierHash = null;
  try { classifierHash = computeClassifierHash(config); } catch { classifierHash = null; }
  const flagged = [];
  fresh.forEach(({ target, comments }, e) => {
    const risks = risksPerEntry[e] || [];
    summary.deferred += risks.filter((risk) => isLlmDeferred(risk)).length;
    const gated = suppressLowConfidenceOwnerRisks(target, comments, risks);
    gated.forEach((risk, i) => {
      if (risk?.alert === true) flagged.push({ target, comment: { ...comments[i], risk } });
    });
  });
  summary.flagged = flagged.length;
  if (summary.deferred > 0) summary.errors.push(`판정 보류 ${summary.deferred}건(LLM 실패·예산) — 다음 회차 재판정`);

  const threads = new Map();
  const nowIso = new Date(now).toISOString();
  for (const item of flagged) {
    if (config.publicAuditDryRun) {
      console.error(`[owner-public-audit:dry-flag] ${item.target.youtubeVideoId} ${item.comment.id} engine=${item.comment.risk.engine || ''} category=${item.comment.risk.category || ''}`);
      continue;
    }
    if (summary.cardsPosted >= config.publicAuditMaxCards) { summary.cardsCapped += 1; continue; }
    const route = ownerThreadRoute(item.target, config.slackAssignees);
    if (!threads.has(route.scopeKey)) {
      threads.set(route.scopeKey, await ensureDailyThread(config, {
        kstDate: kstDateKey(now), scopeKey: route.scopeKey, productLabel: route.label, category: route.category, assignee: route.assignee,
      }, fetchImpl));
    }
    const threadTs = threads.get(route.scopeKey);
    if (!threadTs) throw new Error('재감사 카드 스레드 확보 실패 — 최상위 게시로 폴백하지 않음');
    const comment = { ...item.comment, risk: { ...item.comment.risk, reason: `[매일 재감사·자동 숨김 안 함, 확인 후 숨김] ${item.comment.risk.reason || ''}`.trim() } };
    const slack = await sendAlert(config, item.target, comment, fetchImpl, threadTs);
    const fingerprint = commentFingerprint(item.target, comment);
    await insertAuditAlert(config, auditAlertRow(config, item.target, comment, fingerprint, slack.ts, classifierHash, nowIso), fetchImpl);
    summary.cardsPosted += 1;
  }
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runPublicAudit(loadPublicAuditConfig())
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (summary.errors.length) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[owner-public-audit] ${error.message}`);
      process.exitCode = 1;
    });
}
