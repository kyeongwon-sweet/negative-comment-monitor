import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadYouTubeOwnerTokens,
  mapVideosToOwners,
  refreshAndVerifyOwner,
  videoIdFromAlert,
} from './youtube-owner-moderation.js';
import { loadSlackAssignees } from './config.js';
import { assigneeForTarget, productGroup, productLabel } from './slack.js';
import { kstDateKey } from './schedule.js';
import { ensureDailyThread } from './threads.js';

const HUMAN_KEEP_DECISIONS = new Set(['false_positive', 'ignore', 'approve', 'unhide']);
// 이미 작성자 차단(밴)된 알림은 리포트에서 제외한다. 자동숨김('hidden')은 여전히
// 후보로 노출해 사람이 작성자 밴으로 에스컬레이션할 수 있게 남기지만, 밴이 끝난
// 작성자는 다시 올라오면 노이즈일 뿐이고 재-밴 시도는 이미 rejected라 실패한다.
const OFFENDER_REPORT_EXCLUDED_DECISIONS = new Set([...HUMAN_KEEP_DECISIONS, 'author_banned']);

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    slackDelayMs: Math.max(0, Number(env.YOUTUBE_REPEAT_OFFENDER_SLACK_DELAY_MS || 1100)),
    notifySlack: clean(env.YOUTUBE_REPEAT_OFFENDER_NOTIFY_SLACK || 'true').toLowerCase() !== 'false',
    slackAssignees: loadSlackAssignees(env),
  };
}

export function isNegativeAlertForOffenderReport(alert) {
  return !OFFENDER_REPORT_EXCLUDED_DECISIONS.has(clean(alert?.review_decision).toLowerCase());
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
      productBuckets: new Map(),
    };
    if (current.commentIds.has(commentId)) continue;
    current.alertIds.push(Number(alert.id));
    current.commentIds.add(commentId);
    current.videoIds.add(videoId);
    current.authorDisplayName = clean(alert.author_display_name || alert.authorDisplayName) || current.authorDisplayName;
    if (current.examples.length < maxExamples) {
      current.examples.push({ text: clean(alert.comment_text), postUrl: clean(alert.post_url) });
    }
    const productName = clean(alert.product_name || alert.productName);
    const group = productGroup(productName);
    const bucket = current.productBuckets.get(group) || {
      group,
      label: productLabel(group),
      productName,
      alertIds: [],
      commentIds: new Set(),
      videoIds: new Set(),
      examples: [],
    };
    bucket.productName ||= productName;
    bucket.alertIds.push(Number(alert.id));
    bucket.commentIds.add(commentId);
    bucket.videoIds.add(videoId);
    if (bucket.examples.length < maxExamples) {
      bucket.examples.push({ text: clean(alert.comment_text), postUrl: clean(alert.post_url) });
    }
    current.productBuckets.set(group, bucket);
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
      productBuckets: [...row.productBuckets.values()].map((bucket) => ({
        group: bucket.group,
        label: bucket.label,
        productName: bucket.productName,
        alertIds: bucket.alertIds.filter(Number.isFinite),
        commentCount: bucket.commentIds.size,
        videoCount: bucket.videoIds.size,
        examples: bucket.examples,
      })),
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
      'product_name', 'channel_category', 'category', 'reason',
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

export function buildRepeatOffenderRoutes(candidates, assignees = {}) {
  const routes = new Map();
  for (const candidate of candidates || []) {
    for (const bucket of candidate.productBuckets || []) {
      const group = bucket.group || productGroup(bucket.productName);
      const label = bucket.label || productLabel(group);
      const route = routes.get(group) || {
        group,
        label,
        scopeKey: `${label}|인지 광고`,
        assignee: assigneeForTarget(
          { productName: bucket.productName || label, channelCategory: '인지 광고' },
          assignees,
        ),
        candidates: [],
      };
      route.candidates.push({
        ...candidate,
        alertIds: bucket.alertIds,
        evidenceAlertId: bucket.alertIds?.[0] || null,
        commentCount: bucket.commentCount,
        videoCount: bucket.videoCount,
        examples: bucket.examples,
        productBuckets: undefined,
      });
      routes.set(group, route);
    }
  }
  return [...routes.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'));
}

export function buildRepeatOffenderSlackText(candidates, summary, route = {}) {
  const categoryLabel = route.label ? `[${route.label}] 인지 광고 · ` : '';
  const assigneeLine = route.assignee ? `<@${route.assignee}> 검토 부탁드립니다.` : '담당자 확인이 필요합니다.';
  const lines = [
    `🚨 *${categoryLabel}YouTube 소유채널 상습 악플러 후보*`,
    assigneeLine,
    `기준: 소유 채널 전체 이력에서 악플 ${summary.minComments}건+ 또는 ${summary.minVideos}개+ 영상 · 이 제품 관련 후보 ${candidates.length}명`,
  ];
  candidates.forEach((row, index) => {
    const label = slackEscape(row.handle || row.authorDisplayName || '작성자');
    const owner = slackEscape(row.ownerChannelName || row.ownerChannelId || '소유 채널');
    lines.push('', `${index + 1}. *${owner}* · <https://www.youtube.com/channel/${encodeURIComponent(row.authorChannelId)}|${label}> — 악플 ${row.commentCount}건 · 영상 ${row.videoCount}개`);
    for (const example of row.examples || []) {
      const text = slackEscape(example.text).slice(0, 180);
      lines.push(`   • “${text}”${example.postUrl ? ` — <${example.postUrl}|영상>` : ''}`);
    }
  });
  if (summary.unresolvedAuthorAlerts) lines.push('', `작성자 확인 불가 ${summary.unresolvedAuthorAlerts}건은 후보 집계에서 제외했습니다.`);
  lines.push('', '검토 후보만 안내했습니다. 작성자 차단·댓글 숨김은 실행하지 않았습니다.');
  return lines.join('\n').slice(0, 39_000);
}

async function postSlack(config, text, threadTs, fetchImpl) {
  if (!config.notifySlack || !config.slackBotToken || !config.slackChannelId) return false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: config.slackChannelId, text, thread_ts: threadTs }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.ok) return true;
    if ((response.status === 429 || payload.error === 'ratelimited') && attempt < 5) {
      const retrySeconds = Number(response.headers?.get?.('retry-after') || 0);
      await wait(Math.max(1000, retrySeconds * 1000, config.slackDelayMs));
      continue;
    }
    throw new Error(`Slack repeat-offender report failed (${response.status}): ${payload.error || 'unknown_error'}`);
  }
  return false;
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
    categoryRoutes: 0,
    slackMessages: 0,
    slackSent: false,
  };
  return { summary, candidates, accessTokens };
}

export async function runYouTubeRepeatOffenderReport(
  config = loadYouTubeRepeatOffenderConfig(), fetchImpl = fetch,
) {
  const prepared = await prepareYouTubeRepeatOffenderReport(config, fetchImpl);
  if (prepared.candidates.length) {
    const routes = buildRepeatOffenderRoutes(prepared.candidates, config.slackAssignees);
    prepared.summary.categoryRoutes = routes.length;
    // 수동 dry/report 실행(notify_slack=false)은 부모 스레드조차 만들지 않는다.
    // 알림 활성 회차만 카테고리별 부모를 보장한 뒤 반드시 답글로 발송한다.
    if (config.notifySlack && config.slackBotToken && config.slackChannelId) {
      for (const route of routes) {
        const threadTs = await ensureDailyThread(config, {
          kstDate: kstDateKey(Date.now()),
          scopeKey: route.scopeKey,
          productLabel: route.label,
          category: '인지 광고',
          assignee: route.assignee,
        }, fetchImpl);
        if (!threadTs) throw new Error(`Unable to ensure repeat-offender thread: ${route.scopeKey}`);
        // 후보를 한 덩어리 리포트로 다시 합치지 않는다. 담당자가 각 후보를
        // 독립된 스레드 답글로 검토할 수 있게 제품 버킷별 한 명씩 발송한다.
        for (const candidate of route.candidates) {
          const sent = await postSlack(
            config,
            buildRepeatOffenderSlackText([candidate], prepared.summary, route),
            threadTs,
            fetchImpl,
          );
          if (sent) prepared.summary.slackMessages += 1;
          if (config.slackDelayMs > 0) await wait(config.slackDelayMs);
        }
      }
    }
    prepared.summary.slackSent = prepared.summary.slackMessages > 0;
  }
  return { summary: prepared.summary, candidates: prepared.candidates };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runYouTubeRepeatOffenderReport()
    .then(({ summary }) => console.log(JSON.stringify(summary)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
