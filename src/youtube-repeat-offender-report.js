import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadYouTubeOwnerTokens,
  mapVideosToOwners,
  refreshAndVerifyOwner,
  videoIdFromAlert,
} from './youtube-owner-moderation.js';

const HUMAN_KEEP_DECISIONS = new Set(['false_positive', 'ignore', 'approve', 'unhide']);

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.floor(parsed)) : fallback;
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function clean(value) {
  return String(value ?? '').trim();
}

function authorIdFromSnippet(snippet) {
  const raw = snippet?.authorChannelId;
  return clean(typeof raw === 'object' ? raw?.value : raw);
}

export function loadYouTubeRepeatOffenderConfig(env = process.env) {
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    youtubeApiBase: clean(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').replace(/\/$/, ''),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackChannelId: clean(env.SLACK_CHANNEL_ID),
    minComments: positiveInt(env.YOUTUBE_REPEAT_OFFENDER_MIN_COMMENTS, 3, 10_000),
    minVideos: positiveInt(env.YOUTUBE_REPEAT_OFFENDER_MIN_VIDEOS, 2, 10_000),
    maxExamples: positiveInt(env.YOUTUBE_REPEAT_OFFENDER_MAX_EXAMPLES, 2, 5),
    notifySlack: clean(env.YOUTUBE_REPEAT_OFFENDER_NOTIFY_SLACK || 'true').toLowerCase() !== 'false',
  };
}

export function isNegativeAlertForOffenderReport(alert) {
  return !HUMAN_KEEP_DECISIONS.has(clean(alert?.review_decision).toLowerCase());
}

export function buildRepeatOffenderCandidates(alerts, options = {}) {
  const minComments = positiveInt(options.minComments, 3, 10_000);
  const minVideos = positiveInt(options.minVideos, 2, 10_000);
  const maxExamples = positiveInt(options.maxExamples, 2, 5);
  const byAuthor = new Map();
  for (const alert of alerts || []) {
    if (!isNegativeAlertForOffenderReport(alert)) continue;
    const authorChannelId = clean(alert.author_channel_id || alert.authorChannelId);
    const ownerChannelId = clean(alert.owner_channel_id || alert.ownerChannelId);
    const commentId = clean(alert.comment_id);
    const videoId = videoIdFromAlert(alert);
    if (!authorChannelId || !commentId || !videoId) continue;
    // YouTube의 "채널에서 사용자 숨기기"는 작성자 전역이 아니라 소유 채널별
    // 조치다. 같은 작성자가 여러 소유 채널에 댓글을 남겨도 후보와 승인 단위를
    // 섞지 않는다.
    const key = `${ownerChannelId}\u001f${authorChannelId}`;
    const current = byAuthor.get(key) || {
      ownerChannelId,
      authorChannelId,
      authorDisplayName: '',
      alertIds: [],
      commentIds: new Set(),
      videoIds: new Set(),
      examples: [],
    };
    if (current.commentIds.has(commentId)) continue;
    current.alertIds.push(Number(alert.id));
    current.commentIds.add(commentId);
    current.videoIds.add(videoId);
    current.authorDisplayName = clean(alert.author_display_name || alert.authorDisplayName) || current.authorDisplayName;
    if (current.examples.length < maxExamples) {
      current.examples.push({ text: clean(alert.comment_text), postUrl: clean(alert.post_url) });
    }
    byAuthor.set(key, current);
  }
  return [...byAuthor.values()]
    .map((row) => ({
      ownerChannelId: row.ownerChannelId,
      authorChannelId: row.authorChannelId,
      authorDisplayName: row.authorDisplayName,
      alertIds: row.alertIds.filter(Number.isFinite),
      evidenceAlertId: row.alertIds.find(Number.isFinite) || null,
      commentCount: row.commentIds.size,
      videoCount: row.videoIds.size,
      examples: row.examples,
    }))
    .filter((row) => row.commentCount >= minComments || row.videoCount >= minVideos)
    .sort((a, b) => b.commentCount - a.commentCount || b.videoCount - a.videoCount
      || a.authorChannelId.localeCompare(b.authorChannelId));
}

async function loadYouTubeAlerts(config, fetchImpl) {
  const rows = [];
  let authorSchemaAvailable = true;
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`);
    const baseColumns = [
      'id', 'source', 'platform', 'comment_id', 'comment_text', 'post_url', 'review_decision',
    ];
    url.searchParams.set('select', [...baseColumns, 'author_channel_id', 'author_display_name'].join(','));
    url.searchParams.set('platform', 'eq.youtube');
    url.searchParams.set('comment_id', 'not.is.null');
    url.searchParams.set('order', 'alerted_at.asc');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '1000');
    let response = await fetchImpl(url, { headers: headers(config) });
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 400 && /author_channel_id|author_display_name/i.test(text)) {
        authorSchemaAvailable = false;
        url.searchParams.set('select', baseColumns.join(','));
        response = await fetchImpl(url, { headers: headers(config) });
      }
      if (!response.ok) throw new Error(`YouTube author alert query failed (${response.status})`);
    }
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return { rows, authorSchemaAvailable };
}

async function fetchCommentAuthors(config, alerts, ownerByVideo, accessTokens, fetchImpl) {
  const byComment = new Map();
  let unresolved = 0;
  let requested = 0;
  let returnedCount = 0;
  let authorFieldMissing = 0;
  let notReturned = 0;
  const groups = new Map();
  for (const alert of alerts) {
    const existingId = clean(alert.author_channel_id);
    if (existingId) {
      byComment.set(clean(alert.comment_id), {
        authorChannelId: existingId,
        authorDisplayName: clean(alert.author_display_name),
      });
      continue;
    }
    // 과거 자동숨김(rejected) 댓글은 comments.list(id=...)에서도 더 이상 반환되지
    // 않아 매일 같은 무의미한 조회만 만든다. 신규 댓글은 숨기기 전에 작성자 ID를
    // alert 행에 저장하므로, 작성자 없는 과거 hidden 행은 복구 불가로 즉시 제외한다.
    if (clean(alert.review_decision).toLowerCase() === 'hidden') {
      unresolved += 1;
      continue;
    }
    const ownerId = ownerByVideo.get(videoIdFromAlert(alert));
    if (!ownerId || !accessTokens.get(ownerId)) { unresolved += 1; continue; }
    if (!groups.has(ownerId)) groups.set(ownerId, []);
    groups.get(ownerId).push(alert);
  }
  const failures = [];
  for (const [ownerId, ownerAlerts] of groups) {
    const accessToken = accessTokens.get(ownerId);
    for (const batch of chunk(ownerAlerts, 50)) {
      requested += batch.length;
      const url = new URL(`${config.youtubeApiBase}/comments`);
      url.searchParams.set('part', 'id,snippet');
      url.searchParams.set('id', batch.map((row) => row.comment_id).join(','));
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        failures.push({ ownerId, status: response.status });
        unresolved += batch.length;
        continue;
      }
      const returnedIds = new Set();
      for (const item of payload.items || []) {
        const commentId = clean(item.id);
        const authorChannelId = authorIdFromSnippet(item.snippet);
        if (!commentId) continue;
        returnedIds.add(commentId);
        returnedCount += 1;
        if (!authorChannelId) { unresolved += 1; authorFieldMissing += 1; continue; }
        byComment.set(commentId, {
          authorChannelId,
          authorDisplayName: clean(item.snippet?.authorDisplayName),
        });
      }
      const missingCount = batch.filter((row) => !returnedIds.has(clean(row.comment_id))).length;
      notReturned += missingCount;
      unresolved += missingCount;
    }
  }
  return {
    byComment,
    unresolved,
    failures,
    requested,
    returned: returnedCount,
    authorFieldMissing,
    notReturned,
  };
}

async function persistAuthors(config, alerts, fetchImpl) {
  const grouped = new Map();
  for (const alert of alerts) {
    const authorChannelId = clean(alert.author_channel_id);
    if (!authorChannelId || !alert.id) continue;
    const key = `${authorChannelId}\u001f${clean(alert.author_display_name)}`;
    if (!grouped.has(key)) grouped.set(key, { authorChannelId, authorDisplayName: clean(alert.author_display_name), ids: [] });
    grouped.get(key).ids.push(alert.id);
  }
  let updated = 0;
  for (const group of grouped.values()) {
    for (const ids of chunk(group.ids, 100)) {
      const response = await fetchImpl(
        `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${ids.map(Number).filter(Number.isFinite).join(',')})&author_channel_id=is.null`,
        {
          method: 'PATCH',
          headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
          body: JSON.stringify({
            author_channel_id: group.authorChannelId,
            author_display_name: group.authorDisplayName || null,
          }),
        },
      );
      if (!response.ok) continue;
      const rows = await response.json().catch(() => []);
      updated += Array.isArray(rows) ? rows.length : 0;
    }
  }
  return updated;
}

async function fetchAuthorHandles(config, candidates, accessToken, fetchImpl) {
  const handles = new Map();
  const ids = [...new Set(candidates.flatMap((row) => [row.authorChannelId, row.ownerChannelId]).filter(Boolean))];
  for (const batch of chunk(ids, 50)) {
    const url = new URL(`${config.youtubeApiBase}/channels`);
    url.searchParams.set('part', 'id,snippet');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('maxResults', '50');
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) continue;
    const payload = await response.json().catch(() => ({}));
    for (const item of payload.items || []) {
      const customUrl = clean(item.snippet?.customUrl);
      if (!item.id) continue;
      handles.set(clean(item.id), {
        handle: customUrl ? (customUrl.startsWith('@') ? customUrl : `@${customUrl}`) : '',
        title: clean(item.snippet?.title),
      });
    }
  }
  return handles;
}

function slackEscape(value) {
  return clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildRepeatOffenderSlackText(candidates, summary) {
  const lines = [
    '🚨 *YouTube 소유채널 상습 악플러 후보*',
    `기준: 악플 ${summary.minComments}건+ 또는 ${summary.minVideos}개+ 영상 · 후보 ${candidates.length}명`,
  ];
  candidates.forEach((row, index) => {
    const label = slackEscape(row.handle || row.authorDisplayName || '작성자');
    const owner = slackEscape(row.ownerChannelName || row.ownerChannelId || '소유 채널');
    lines.push('', `${index + 1}. *${owner}* · <https://www.youtube.com/channel/${encodeURIComponent(row.authorChannelId)}|${label}> — 악플 ${row.commentCount}건 · 영상 ${row.videoCount}개`);
    if (row.evidenceAlertId) lines.push(`   • 차단 승인용 alert ID: ${row.evidenceAlertId}`);
    for (const example of row.examples || []) {
      const text = slackEscape(example.text).slice(0, 180);
      lines.push(`   • “${text}”${example.postUrl ? ` — <${example.postUrl}|영상>` : ''}`);
    }
  });
  if (summary.unresolvedAuthorAlerts) lines.push('', `작성자 확인 불가 ${summary.unresolvedAuthorAlerts}건은 후보 집계에서 제외했습니다.`);
  lines.push('', '차단은 후보 확인 후 Studio에서 수동 처리하거나, 위 alert ID로 보호된 차단 워크플로를 실행하세요.');
  return lines.join('\n').slice(0, 39_000);
}

async function postSlack(config, text, fetchImpl) {
  if (!config.notifySlack || !config.slackBotToken || !config.slackChannelId) return false;
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Slack repeat-offender report failed (${response.status})`);
  return true;
}

export async function prepareYouTubeRepeatOffenderReport(
  config = loadYouTubeRepeatOffenderConfig(), fetchImpl = fetch,
) {
  const loaded = await loadYouTubeAlerts(config, fetchImpl);
  const alerts = loaded.rows.filter(isNegativeAlertForOffenderReport);
  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  const accessTokens = new Map();
  const ownerTokenFailures = [];
  for (const owner of owners) {
    try { accessTokens.set(owner.channelId, await refreshAndVerifyOwner(config, owner, fetchImpl)); }
    catch (error) { ownerTokenFailures.push({ channelId: owner.channelId, error: clean(error?.message || error).slice(0, 200) }); }
  }
  const { ownerByVideo, ownerErrors } = await mapVideosToOwners(config, alerts, owners, accessTokens, fetchImpl);
  const ownedAlerts = alerts.filter((row) => ownerByVideo.has(videoIdFromAlert(row)));
  const authorLookup = await fetchCommentAuthors(config, ownedAlerts, ownerByVideo, accessTokens, fetchImpl);
  const enriched = ownedAlerts.map((row) => {
    const author = authorLookup.byComment.get(clean(row.comment_id));
    const ownerChannelId = ownerByVideo.get(videoIdFromAlert(row)) || '';
    return author
      ? {
          ...row,
          owner_channel_id: ownerChannelId,
          author_channel_id: author.authorChannelId,
          author_display_name: author.authorDisplayName,
        }
      : { ...row, owner_channel_id: ownerChannelId };
  });
  const authorsPersisted = loaded.authorSchemaAvailable
    ? await persistAuthors(config, enriched, fetchImpl)
    : 0;
  const candidates = buildRepeatOffenderCandidates(enriched, config);
  const firstToken = accessTokens.values().next().value;
  const handles = firstToken ? await fetchAuthorHandles(config, candidates, firstToken, fetchImpl) : new Map();
  for (const row of candidates) {
    const author = handles.get(row.authorChannelId) || {};
    const owner = handles.get(row.ownerChannelId) || {};
    row.handle = author.handle || row.authorDisplayName;
    row.ownerChannelName = owner.title || row.ownerChannelId;
  }
  const summary = {
    youtubeAlerts: alerts.length,
    authorSchemaAvailable: loaded.authorSchemaAvailable,
    ownedAlerts: ownedAlerts.length,
    authorsPersisted,
    unresolvedAuthorAlerts: authorLookup.unresolved,
    authorLookupRequested: authorLookup.requested,
    authorLookupReturned: authorLookup.returned,
    authorFieldMissing: authorLookup.authorFieldMissing,
    commentsNotReturned: authorLookup.notReturned,
    lookupFailures: authorLookup.failures.length,
    ownerTokenFailures: ownerTokenFailures.length,
    ownerMappingFailures: ownerErrors.length,
    minComments: config.minComments,
    minVideos: config.minVideos,
    candidates: candidates.length,
    slackSent: false,
  };
  return { summary, candidates, accessTokens };
}

export async function runYouTubeRepeatOffenderReport(
  config = loadYouTubeRepeatOffenderConfig(), fetchImpl = fetch,
) {
  const prepared = await prepareYouTubeRepeatOffenderReport(config, fetchImpl);
  if (prepared.candidates.length) {
    prepared.summary.slackSent = await postSlack(
      config,
      buildRepeatOffenderSlackText(prepared.candidates, prepared.summary),
      fetchImpl,
    );
  }
  return { summary: prepared.summary, candidates: prepared.candidates };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runYouTubeRepeatOffenderReport()
    .then(({ summary }) => console.log(JSON.stringify(summary)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
