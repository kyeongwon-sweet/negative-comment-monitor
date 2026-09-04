import { loadMetaAdsConfig } from './meta-ads.js';
import { fetchYouTubeVideoCommentsWithMeta } from './youtube-ads.js';
import { loadYouTubeOwnerTokens, refreshAndVerifyOwner } from './youtube-owner-moderation.js';
import { YOUTUBE_SATELLITE_CHANNELS } from './youtube-satellite-oauth.js';
import { extractPostKey } from './delta.js';

export const YOUTUBE_OWNER_CHANNELS = Object.freeze([
  // 실사례 Xj9usm-lkxw(2026-07-02)를 포함하도록 기존 소유 채널은 최초 60일 창으로 본다.
  // 신규 위성 OAuth 채널은 비용 스파이크를 막기 위해 기본 14일로 시작한다.
  { name: '먹짱언니', channelId: 'UCxfjcCvRPOPzo6PeAttO4Dg', channelCategory: '소유 YouTube', lookbackDays: 60 },
  { name: '썰푸는앵무새', channelId: 'UCQKpvEBNiMBrGzI2f2tAFeA', channelCategory: '소유 YouTube', lookbackDays: 60 },
  ...YOUTUBE_SATELLITE_CHANNELS.map(({ name, channelId }) => ({
    name,
    channelId,
    channelCategory: '위성채널',
    lookbackDays: 14,
  })),
]);

export const YOUTUBE_BRAND_HOSTILITY_CHANNEL_IDS = new Set([
  'UCxfjcCvRPOPzo6PeAttO4Dg', // 먹짱언니
  'UCQKpvEBNiMBrGzI2f2tAFeA', // 썰푸는앵무새
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const RISK_EXCLUDED_DECISIONS = new Set(['false_positive', 'ignore', 'unhide', 'approve']);

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function nonnegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function positiveNumber(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function csvSet(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function parseExtraChannels(raw) {
  if (!String(raw || '').trim()) return [];
  const parsed = JSON.parse(String(raw));
  if (!Array.isArray(parsed)) throw new Error('YOUTUBE_OWNER_CHANNELS_JSON must be an array');
  return parsed.map((row) => ({
    name: String(row?.name || '').trim(),
    channelId: String(row?.channelId || '').trim(),
    channelCategory: String(row?.channelCategory || '소유 YouTube').trim(),
    lookbackDays: positiveInt(row?.lookbackDays, 14, 90),
  })).filter((row) => row.channelId);
}

function uniqueChannels(channels) {
  const byId = new Map();
  for (const channel of channels) {
    if (!channel.channelId || byId.has(channel.channelId)) continue;
    byId.set(channel.channelId, channel);
  }
  return [...byId.values()];
}

export function loadYouTubeOwnerChannelConfig(env = process.env, now = Date.now()) {
  const base = loadMetaAdsConfig(env, now);
  const satellite = String(env.SLACK_ASSIGNEE_SATELLITE || '').trim();
  return {
    ...base,
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    youtubeAdsMaxThreadPages: positiveInt(env.YOUTUBE_OWNER_MAX_THREAD_PAGES, 10, 100),
    youtubeAdsMaxReplyPages: positiveInt(env.YOUTUBE_OWNER_MAX_REPLY_PAGES, 100, 100),
    youtubeOwnerQuickMaxThreadPages: positiveInt(env.YOUTUBE_OWNER_QUICK_MAX_THREAD_PAGES, 4, 10),
    youtubeOwnerDeepMaxThreadPages: positiveInt(env.YOUTUBE_OWNER_DEEP_MAX_THREAD_PAGES, 100, 100),
    youtubeOwnerHighCommentThreshold: positiveInt(env.YOUTUBE_OWNER_HIGH_COMMENT_THRESHOLD, 200, 100_000),
    youtubeOwnerHighCommentRescanHours: positiveInt(env.YOUTUBE_OWNER_HIGH_COMMENT_RESCAN_HOURS, 24, 168),
    // 통계상 댓글수가 이만큼 급증하면 24시간 cadence를 기다리지 않고 즉시 전수 딥스캔한다.
    youtubeOwnerSpikeCommentDelta: positiveInt(env.YOUTUBE_OWNER_SPIKE_COMMENT_DELTA, 25, 100_000),
    // 숨김으로 공개 commentCount가 내려가면 신규 댓글 유입과 상쇄돼 델타가 0이 될 수 있다.
    // 최근 악플 영상은 3시간, 과거 악플 누적 영상은 하루 주기로만 재확인해 이 구멍을
    // 막되 전체 소유 영상을 매번 읽는 비용은 피한다.
    youtubeOwnerRiskLookbackDays: positiveInt(env.YOUTUBE_OWNER_RISK_LOOKBACK_DAYS, 60, 90),
    youtubeOwnerRecentNegativeDays: positiveInt(env.YOUTUBE_OWNER_RECENT_NEGATIVE_DAYS, 7, 30),
    youtubeOwnerRecentNegativeRescanHours: positiveNumber(env.YOUTUBE_OWNER_RECENT_NEGATIVE_RESCAN_HOURS, 3, 24),
    youtubeOwnerHistoricalNegativeThreshold: positiveInt(env.YOUTUBE_OWNER_HISTORICAL_NEGATIVE_THRESHOLD, 5, 10_000),
    youtubeOwnerHistoricalNegativeRescanHours: positiveNumber(env.YOUTUBE_OWNER_HISTORICAL_NEGATIVE_RESCAN_HOURS, 24, 168),
    youtubeOwnerForceVideoIds: csvSet(env.YOUTUBE_OWNER_FORCE_VIDEO_IDS),
    youtubeOwnerForceReclassify: String(env.YOUTUBE_OWNER_FORCE_RECLASSIFY || 'false').toLowerCase() === 'true',
    youtubeOwnerLookbackDays: positiveInt(env.YOUTUBE_OWNER_LOOKBACK_DAYS, 14, 90),
    youtubeOwnerMaxUploadPages: positiveInt(env.YOUTUBE_OWNER_MAX_UPLOAD_PAGES, 10, 100),
    youtubeOwnerDefaultProductName: String(env.YOUTUBE_OWNER_DEFAULT_PRODUCT_NAME || 'JD').trim(),
    youtubeOwnerAlertDelayMs: nonnegativeInt(env.YOUTUBE_OWNER_ALERT_DELAY_MS, 1100, 10_000),
    youtubeOwnerAutoHide: String(env.YOUTUBE_OWNER_CHANNEL_AUTO_HIDE || 'true').toLowerCase() !== 'false',
    youtubeOwnerOverloadNegativeCount: positiveInt(env.YOUTUBE_OWNER_OVERLOAD_NEGATIVE_COUNT, 20, 10_000),
    youtubeOwnerOverloadRatioPercent: positiveNumber(env.YOUTUBE_OWNER_OVERLOAD_RATIO_PERCENT, 40, 100),
    youtubeOwnerOverloadMinComments: positiveInt(env.YOUTUBE_OWNER_OVERLOAD_MIN_COMMENTS, 10, 10_000),
    youtubeOwnerOverloadCooldownHours: positiveNumber(env.YOUTUBE_OWNER_OVERLOAD_COOLDOWN_HOURS, 24, 168),
    youtubeOwnerCoverageAlertCooldownHours: positiveNumber(
      env.YOUTUBE_OWNER_COVERAGE_ALERT_COOLDOWN_HOURS,
      168,
      24 * 30,
    ),
    youtubeOwnerChannels: uniqueChannels([
      ...YOUTUBE_OWNER_CHANNELS,
      ...parseExtraChannels(env.YOUTUBE_OWNER_CHANNELS_JSON),
    ]),
    managedChannelCategories: ['위성채널', '소유 YouTube'],
    slackAssignees: {
      ...base.slackAssignees,
      satellite,
      jd: { satellite: String(env.SLACK_ASSIGNEE_JD_SATELLITE || satellite).trim() },
    },
  };
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

async function youtubeJson(config, pathname, query, accessToken, fetchImpl) {
  const url = new URL(`${config.youtubeApiBase}/${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean);
    const error = new Error(`YouTube ${pathname} failed (${response.status})${reasons.length ? `: ${reasons.join(',')}` : ''}`);
    error.status = response.status;
    error.reasons = reasons;
    throw error;
  }
  return payload;
}

function chunks(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

export async function loadOwnerVideoStates(config, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/youtube_owner_video_state?select=channel_id,video_id,comment_count,last_scanned_count,last_scanned_at&limit=10000`,
    { headers: headers(config) },
  );
  if (!response.ok) {
    throw new Error(`YouTube owner state GET failed (${response.status}); run supabase/008_youtube_owner_video_state.sql`);
  }
  const rows = await response.json();
  return new Map(rows.map((row) => [String(row.video_id), row]));
}

export async function saveOwnerVideoStates(config, rows, fetchImpl = fetch) {
  if (!rows.length) return 0;
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/youtube_owner_video_state?on_conflict=channel_id,video_id`,
    {
      method: 'POST',
      headers: headers(config, {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(rows),
    },
  );
  if (!response.ok) throw new Error(`YouTube owner state UPSERT failed (${response.status})`);
  return rows.length;
}

export async function loadOwnerVideoRiskSignals(config, fetchImpl = fetch, now = Date.now()) {
  const cutoff = new Date(now - config.youtubeOwnerRiskLookbackDays * DAY_MS).toISOString();
  const signals = new Map();
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
    url.searchParams.set('select', 'post_url,alerted_at,review_decision');
    url.searchParams.set('platform', 'eq.youtube');
    url.searchParams.set('alerted_at', `gte.${cutoff}`);
    url.searchParams.set('order', 'alerted_at.asc');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '1000');
    const response = await fetchImpl(url, { headers: headers(config) });
    if (!response.ok) throw new Error(`YouTube owner risk GET failed (${response.status})`);
    const rows = await response.json();
    for (const row of rows) {
      if (RISK_EXCLUDED_DECISIONS.has(String(row.review_decision || '').trim().toLowerCase())) continue;
      const key = extractPostKey(row.post_url);
      if (!key?.startsWith('yt:')) continue;
      const videoId = key.slice(3);
      const previous = signals.get(videoId) || { alertCount: 0, lastAlertAt: null };
      const alertedAt = Date.parse(row.alerted_at || '');
      signals.set(videoId, {
        alertCount: previous.alertCount + 1,
        lastAlertAt: Number.isFinite(alertedAt)
          ? new Date(Math.max(alertedAt, Date.parse(previous.lastAlertAt || '') || 0)).toISOString()
          : previous.lastAlertAt,
      });
    }
    if (rows.length < 1000) break;
  }
  return signals;
}

export function inferOwnerVideoProduct(video, fallback = 'JD') {
  const text = `${video?.snippet?.title || ''} ${video?.snippet?.description || ''}`.toLowerCase();
  if (/파인트|p(?:혼|망|딸|애)/i.test(text)) return 'P';
  if (/듬뿍|db(?:혼|망|딸|애)/i.test(text)) return 'DB';
  if (/쫀득|멜론바|망고바|jd(?:멜|망|혼|복)/i.test(text)) return 'JD';
  return String(fallback || 'JD').trim() || 'JD';
}

function ownerChannelTarget(config, channel, channelName, video, videoId, decision) {
  const ownedChannelBrandHostilityScope = YOUTUBE_BRAND_HOSTILITY_CHANNEL_IDS.has(channel.channelId);
  return {
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    postKey: `yt:${videoId}`,
    channelName,
    channelCategory: channel.channelCategory,
    productName: inferOwnerVideoProduct(video, config.youtubeOwnerDefaultProductName),
    brandName: config.brandContext,
    caption: [video.snippet?.title, video.snippet?.description].filter(Boolean).join(' / '),
    youtubeVideoId: videoId,
    youtubeCommentCount: Number.isFinite(Number(decision?.current)) ? Number(decision.current) : null,
    ownerChannelId: channel.channelId,
    isManagedAccount: true,
    // 대표님 승인 B 정책은 먹짱언니·썰푸는앵무새에만 적용한다. 위성·협찬·제3자
    // 채널에는 이 플래그를 절대 전달하지 않는다.
    ownedChannelBrandHostilityScope,
    fullContextReview: ownedChannelBrandHostilityScope || decision?.highComment === true,
    bypassClassificationCache: decision?.forceReclassify === true,
  };
}

export function shouldScanOwnerVideo(video, previous, options = {}) {
  const current = Number(video?.statistics?.commentCount);
  if (!Number.isFinite(current) || current < 0) return { due: false, reason: 'no-signal', current: null };
  const videoId = String(video?.id || '').trim();
  const forceVideoIds = options.forceVideoIds instanceof Set ? options.forceVideoIds : new Set();
  if (videoId && forceVideoIds.has(videoId)) {
    return { due: true, reason: 'forced-deep-scan', current, deepScan: true, forceReclassify: options.forceReclassify === true };
  }
  const highComment = current >= Number(options.highCommentThreshold || Number.MAX_SAFE_INTEGER);
  if (!previous) return {
    due: current > 0,
    reason: current > 0 ? 'first-scan' : 'zero-baseline',
    current,
    ...(current > 0 && highComment ? { highComment: true, deepScan: true } : {}),
  };
  const rawLast = previous.last_scanned_count;
  const last = rawLast == null || rawLast === '' ? Number.NaN : Number(rawLast);
  const lastScanned = Date.parse(previous.last_scanned_at || '');
  const cadenceMs = Number(options.highCommentRescanHours || 24) * 60 * 60 * 1000;
  const now = Number(options.now || Date.now());
  const deepDue = highComment && (!Number.isFinite(lastScanned) || now - lastScanned >= cadenceMs);
  const increase = Number.isFinite(last) ? current - last : 0;
  const spike = increase >= Number(options.spikeCommentDelta || Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(last) || last !== current) return {
    due: true,
    reason: spike ? 'comment-spike' : 'changed',
    current,
    ...(highComment ? { highComment: true } : {}),
    ...(spike ? { spike: true, increase } : {}),
    ...(deepDue || spike ? { deepScan: true } : {}),
  };
  if (highComment) {
    if (deepDue) return { due: true, reason: 'high-comment-cadence', current, highComment: true, deepScan: true };
  }
  const riskSignals = options.riskSignals instanceof Map ? options.riskSignals : new Map();
  const risk = riskSignals.get(videoId);
  if (risk) {
    const lastAlertAt = Date.parse(risk.lastAlertAt || '');
    const recentWindowMs = Number(options.recentNegativeDays || 7) * DAY_MS;
    const isRecent = Number.isFinite(lastAlertAt) && now - lastAlertAt <= recentWindowMs;
    const isHistoricallyHighRisk = Number(risk.alertCount || 0) >= Number(options.historicalNegativeThreshold || 5);
    const riskCadenceHours = isRecent
      ? Number(options.recentNegativeRescanHours || 3)
      : isHistoricallyHighRisk
        ? Number(options.historicalNegativeRescanHours || 24)
        : 0;
    if (riskCadenceHours > 0) {
      const riskDue = !Number.isFinite(lastScanned) || now - lastScanned >= riskCadenceHours * 60 * 60 * 1000;
      if (riskDue) return {
        due: true,
        reason: isRecent ? 'recent-negative-cadence' : 'historical-negative-cadence',
        current,
        riskScan: true,
      };
    }
  }
  return { due: false, reason: 'unchanged', current };
}

// 워크플로 제한이나 개별 API 실패가 생겨도 중요한 영상을 먼저 처리하도록 한다.
// 강제 검사 → 댓글 급증 → 정기 딥 → 위험영상 → 일반 변화 순이며, 같은 등급은 댓글수가 큰 순서다.
export function prioritizeOwnerVideoPlans(plans) {
  const rank = (decision) => {
    if (!decision?.due) return 9;
    if (decision.reason === 'forced-deep-scan') return 0;
    if (decision.spike) return 1;
    if (decision.deepScan) return 2;
    if (decision.riskScan) return 3;
    return 4;
  };
  return [...(plans || [])].sort((a, b) => (
    rank(a.decision) - rank(b.decision)
    || Number(b.decision?.current || 0) - Number(a.decision?.current || 0)
    || String(a.video?.id || '').localeCompare(String(b.video?.id || ''))
  ));
}

export function ownerCommentEvidence(reportedCount, scan = {}) {
  const candidates = [reportedCount, scan.reportedThreadCount, scan.threadCount, scan.comments?.length]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return candidates.length ? Math.max(...candidates) : null;
}

export async function fetchRecentOwnerUploads(config, channel, accessToken, fetchImpl = fetch, now = Date.now()) {
  const channelPayload = await youtubeJson(config, 'channels', {
    part: 'id,snippet,contentDetails', id: channel.channelId, maxResults: 1,
  }, accessToken, fetchImpl);
  const actual = (channelPayload.items || []).find((item) => String(item.id) === channel.channelId);
  const uploads = actual?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`Owned channel has no uploads playlist (${channel.channelId})`);

  const lookbackDays = positiveInt(channel.lookbackDays, config.youtubeOwnerLookbackDays, 90);
  const cutoff = now - lookbackDays * DAY_MS;
  const playlistItems = [];
  let pageToken = '';
  for (let page = 0; page < config.youtubeOwnerMaxUploadPages; page += 1) {
    const payload = await youtubeJson(config, 'playlistItems', {
      part: 'id,snippet,contentDetails', playlistId: uploads, maxResults: 50, pageToken,
    }, accessToken, fetchImpl);
    let reachedOld = false;
    for (const item of payload.items || []) {
      const published = Date.parse(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '');
      if (Number.isFinite(published) && published < cutoff) { reachedOld = true; continue; }
      const videoId = String(item.contentDetails?.videoId || item.snippet?.resourceId?.videoId || '');
      if (videoId) playlistItems.push({ videoId, publishedAt: new Date(published || now).toISOString() });
    }
    pageToken = String(payload.nextPageToken || '');
    if (!pageToken || reachedOld) break;
  }

  const details = [];
  for (const batch of chunks(playlistItems, 50)) {
    const payload = await youtubeJson(config, 'videos', {
      part: 'id,snippet,statistics,status', id: batch.map((item) => item.videoId).join(','), maxResults: 50,
    }, accessToken, fetchImpl);
    details.push(...(payload.items || []));
  }
  return {
    channelName: String(actual?.snippet?.title || channel.name || channel.channelId),
    videos: details,
  };
}

function stateRow(channel, video, current, now, scanned, previous = null, preserveScanMarker = false) {
  return {
    channel_id: channel.channelId,
    video_id: String(video.id),
    video_title: String(video.snippet?.title || '').slice(0, 500),
    published_at: String(video.snippet?.publishedAt || new Date(now).toISOString()),
    comment_count: current,
    last_seen_at: new Date(now).toISOString(),
    // PostgREST bulk upsert는 배열 행들의 키 집합이 다르면 400을 낼 수 있다. 변화 없음 행도
    // 직전 스캔 값을 명시해 모든 행을 동일한 완전 스키마로 보낸다.
    last_scanned_count: scanned ? current : Number(previous?.last_scanned_count),
    // 고댓글 영상의 빠른 변화 스캔은 제한된 최신 페이지만 보므로 일일 전수검사 기준시각을
    // 전진시키지 않는다. last_scanned_at은 이 경우 마지막 전수검사 시각으로 유지한다.
    last_scanned_at: scanned
      ? (preserveScanMarker ? (previous?.last_scanned_at || null) : new Date(now).toISOString())
      : (previous?.last_scanned_at || null),
  };
}

export async function collectYouTubeOwnerChannels(config, fetchImpl = fetch, now = Date.now()) {
  const states = await loadOwnerVideoStates(config, fetchImpl);
  let riskSignals = new Map();
  let riskSignalFailure = '';
  try {
    riskSignals = await loadOwnerVideoRiskSignals(config, fetchImpl, now);
  } catch (error) {
    riskSignalFailure = String(error?.message || error);
    console.error(`[youtube-owner-channel:risk-degraded] ${riskSignalFailure}`);
  }
  const storedOwners = await loadYouTubeOwnerTokens(config, fetchImpl);
  const configured = new Map(config.youtubeOwnerChannels.map((channel) => [channel.channelId, channel]));
  const owners = storedOwners.filter((owner) => configured.has(owner.channelId));
  const authenticatedChannelIds = new Set(owners.map((owner) => owner.channelId));
  const missingOAuthChannels = config.youtubeOwnerChannels
    .filter((channel) => !authenticatedChannelIds.has(channel.channelId))
    .map((channel) => ({
      name: channel.name,
      channelId: channel.channelId,
      channelCategory: channel.channelCategory,
    }));
  if (!owners.length) throw new Error('No configured YouTube owner OAuth channels are available');
  const entries = [];
  const trackedTargets = [];
  const stateUpdates = [];
  const allowedVideoIds = new Set();
  const channelFailures = [];
  const counts = {
    ownerTokens: storedOwners.length,
    // configuredOwners는 기존 소비자 호환을 위해 '인증되어 실제 실행 가능한 채널 수' 의미를 유지한다.
    configuredOwners: owners.length,
    totalConfiguredChannels: config.youtubeOwnerChannels.length,
    authenticatedChannels: owners.length,
    missingOAuthChannels,
    channels: 0,
    videos: 0,
    due: 0,
    deepDue: 0,
    spikeDue: 0,
    paginationDeepDue: 0,
    riskDue: 0,
    unchanged: 0,
    zeroBaseline: 0,
    noSignal: 0,
    comments: 0,
  };

  for (const owner of owners) {
    const channel = configured.get(owner.channelId);
    try {
      const accessToken = await refreshAndVerifyOwner(config, owner, fetchImpl);
      const collected = await fetchRecentOwnerUploads(config, channel, accessToken, fetchImpl, now);
      counts.channels += 1;
      counts.videos += collected.videos.length;
      const plans = prioritizeOwnerVideoPlans(collected.videos.map((video) => {
        const videoId = String(video.id || '');
        const previous = states.get(videoId);
        const decision = shouldScanOwnerVideo(video, previous, {
          now,
          forceVideoIds: config.youtubeOwnerForceVideoIds,
          forceReclassify: config.youtubeOwnerForceReclassify,
          highCommentThreshold: config.youtubeOwnerHighCommentThreshold,
          highCommentRescanHours: config.youtubeOwnerHighCommentRescanHours,
          spikeCommentDelta: config.youtubeOwnerSpikeCommentDelta,
          riskSignals,
          recentNegativeDays: config.youtubeOwnerRecentNegativeDays,
          recentNegativeRescanHours: config.youtubeOwnerRecentNegativeRescanHours,
          historicalNegativeThreshold: config.youtubeOwnerHistoricalNegativeThreshold,
          historicalNegativeRescanHours: config.youtubeOwnerHistoricalNegativeRescanHours,
        });
        return { video, videoId, previous, decision };
      }));
      for (const plan of plans) {
        const { video, videoId, previous, decision } = plan;
        if (!videoId) continue;
        allowedVideoIds.add(videoId);
        // 과부하 평가는 이번 회차에 댓글 본문을 읽은 영상만이 아니라 감시 중인
        // 모든 소유 영상을 대상으로 한다. 그래야 델타가 없는 오래된 바이럴 영상도
        // 누적 악플 임계에 도달했을 때 알림에서 사라지지 않는다.
        const target = ownerChannelTarget(
          config, channel, collected.channelName, video, videoId, decision,
        );
        trackedTargets.push(target);
        if (decision.reason === 'no-signal') { counts.noSignal += 1; continue; }
        if (decision.reason === 'zero-baseline') {
          counts.zeroBaseline += 1;
          stateUpdates.push(stateRow(channel, video, decision.current, now, true));
          continue;
        }
        if (!decision.due) {
          counts.unchanged += 1;
          stateUpdates.push(stateRow(channel, video, decision.current, now, false, previous));
          continue;
        }
        counts.due += 1;
        if (decision.spike) counts.spikeDue += 1;
        if (decision.riskScan) counts.riskDue += 1;
        let actualDeepScan = decision.deepScan === true;
        const scanConfig = actualDeepScan
          ? { ...config, youtubeAdsMaxThreadPages: config.youtubeOwnerDeepMaxThreadPages }
          : decision.highComment
            ? { ...config, youtubeAdsMaxThreadPages: config.youtubeOwnerQuickMaxThreadPages }
            : config;
        let scan = await fetchYouTubeVideoCommentsWithMeta(scanConfig, videoId, accessToken, fetchImpl);
        const observedCount = ownerCommentEvidence(decision.current, scan);
        const statisticsUnderstated = decision.highComment !== true
          && Number.isFinite(observedCount)
          && observedCount >= config.youtubeOwnerHighCommentThreshold;
        if (!actualDeepScan && statisticsUnderstated) {
          actualDeepScan = true;
          counts.paginationDeepDue += 1;
          // 기본 10페이지에서 이미 끝까지 읽었다면 재호출하지 않는다. 잘렸을 때만 100페이지로 이어간다.
          if (scan.truncated) {
            scan = await fetchYouTubeVideoCommentsWithMeta(
              { ...config, youtubeAdsMaxThreadPages: config.youtubeOwnerDeepMaxThreadPages },
              videoId,
              accessToken,
              fetchImpl,
            );
          }
        }
        if (actualDeepScan) counts.deepDue += 1;
        const comments = scan.comments;
        // statistics.commentCount가 실측보다 뒤처지면 실측치를 checkpoint로 저장한다.
        // 통계가 따라잡기 전까지 다음 회차에도 변화로 인식되어 재확인되므로 stale 신호에
        // 기대어 신규 댓글을 놓치는 구간을 만들지 않는다.
        const checkpointCount = statisticsUnderstated ? observedCount : decision.current;
        target.youtubeCommentCount = checkpointCount;
        target.fullContextReview = target.ownedChannelBrandHostilityScope
          || decision.highComment === true
          || actualDeepScan;
        counts.comments += comments.length;
        stateUpdates.push(stateRow(
          channel, video, checkpointCount, now, true, previous,
          decision.highComment === true && actualDeepScan !== true,
        ));
        if (!comments.length) continue;
        entries.push({
          target,
          comments,
        });
      }
    } catch (error) {
      channelFailures.push({ channelId: owner.channelId, error: String(error?.message || error) });
    }
  }
  return {
    ...counts,
    entries,
    trackedTargets,
    stateUpdates,
    allowedVideoIds,
    channelFailures,
    riskSignals: riskSignals.size,
    riskSignalFailure,
  };
}
