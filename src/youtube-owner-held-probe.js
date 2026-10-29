// 읽기 전용 점검: 소유채널 '검토 보류(heldForReview)' 댓글을 주인 OAuth로 읽을 수 있는지,
// 보류함에 무엇이 들어 있는지(봇·사람이 숨긴 것 vs 출처 미상) 센다. 댓글을 바꾸지 않는다.
// '모든 댓글 보류' 전환 전, 보류함 → 봇 판정 → 공개 흐름의 전제를 실측하기 위한 도구다.
// 공개 레포라 로그에는 개수·채널ID만 남기고 댓글 본문·작성자는 찍지 않는다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadYouTubeOwnerTokens, refreshAndVerifyOwner } from './youtube-owner-moderation.js';

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function loadHeldProbeConfig(env = process.env) {
  return {
    googleAdsClientId: required(env, 'GOOGLE_ADS_CLIENT_ID'),
    googleAdsClientSecret: required(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    youtubeApiBase: String(env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3').trim().replace(/\/$/, ''),
    channelIds: String(env.HELD_PROBE_CHANNEL_IDS || '').split(',').map((v) => v.trim()).filter(Boolean),
    maxPages: Math.max(1, Math.min(50, Number(env.HELD_PROBE_MAX_PAGES || 20))),
  };
}

async function listHeldThreads(config, channelId, accessToken, fetchImpl) {
  const threads = [];
  let pageToken = '';
  let pages = 0;
  do {
    const url = new URL(`${config.youtubeApiBase}/commentThreads`);
    url.searchParams.set('part', 'snippet,replies');
    url.searchParams.set('allThreadsRelatedToChannelId', channelId);
    url.searchParams.set('moderationStatus', 'heldForReview');
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('textFormat', 'plainText');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reasons = (payload?.error?.errors || []).map((item) => item.reason).filter(Boolean).join(',');
      throw new Error(`commentThreads heldForReview failed (${response.status})${reasons ? `: ${reasons}` : ''}`);
    }
    threads.push(...(payload.items || []));
    pageToken = payload.nextPageToken || '';
    pages += 1;
  } while (pageToken && pages < config.maxPages);
  return { threads, truncated: Boolean(pageToken) };
}

async function loadAlertDecisions(config, fetchImpl) {
  const byId = new Map();
  for (let offset = 0; ; offset += 1000) {
    const response = await fetchImpl(
      `${config.supabaseUrl}/rest/v1/negative_comment_alerts?select=id,comment_id,review_decision&platform=eq.youtube&comment_id=not.is.null&order=id.asc&offset=${offset}&limit=1000`,
      { headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` } },
    );
    if (!response.ok) throw new Error(`Supabase alerts read failed (${response.status})`);
    const rows = await response.json();
    for (const row of rows) byId.set(String(row.comment_id), String(row.review_decision || 'none'));
    if (rows.length < 1000) break;
  }
  return byId;
}

export function summarizeHeld(threads, decisions) {
  const summary = { threads: threads.length, heldTopLevel: 0, repliesIncluded: 0, heldReplies: 0, byDecision: {} };
  const bump = (decision) => { summary.byDecision[decision] = (summary.byDecision[decision] || 0) + 1; };
  for (const thread of threads) {
    const top = thread.snippet?.topLevelComment;
    const topStatus = String(top?.snippet?.moderationStatus || '');
    if (topStatus === 'heldForReview' || !topStatus) {
      summary.heldTopLevel += 1;
      bump(decisions.get(String(top?.id || '')) || 'no-alert-row');
    }
    for (const reply of thread.replies?.comments || []) {
      summary.repliesIncluded += 1;
      if (String(reply.snippet?.moderationStatus || '') === 'heldForReview') {
        summary.heldReplies += 1;
        bump(`reply:${decisions.get(String(reply.id || '')) || 'no-alert-row'}`);
      }
    }
  }
  return summary;
}

export async function runHeldProbe(config, fetchImpl = fetch) {
  const owners = await loadYouTubeOwnerTokens(config, fetchImpl);
  const targets = config.channelIds.length ? owners.filter((o) => config.channelIds.includes(o.channelId)) : owners;
  const decisions = await loadAlertDecisions(config, fetchImpl);
  const out = [];
  for (const owner of targets) {
    try {
      const accessToken = await refreshAndVerifyOwner(config, owner, fetchImpl);
      const { threads, truncated } = await listHeldThreads(config, owner.channelId, accessToken, fetchImpl);
      out.push({ channelId: owner.channelId, truncated, ...summarizeHeld(threads, decisions) });
    } catch (error) {
      out.push({ channelId: owner.channelId, error: String(error.message || error) });
    }
  }
  return { owners: owners.length, probed: targets.length, channels: out };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const result = await runHeldProbe(loadHeldProbeConfig());
  console.log(JSON.stringify(result, null, 2));
}
