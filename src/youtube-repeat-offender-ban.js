import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadYouTubeRepeatOffenderConfig,
  prepareYouTubeRepeatOffenderReport,
} from './youtube-repeat-offender-report.js';

export const YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRMATION = 'BAN_YOUTUBE_REPEAT_OFFENDER';

function clean(value) {
  return String(value ?? '').trim();
}

function requiredPositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

function headers(config, extra = {}) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, ...extra };
}

export function loadYouTubeRepeatOffenderBanConfig(env = process.env) {
  const confirmation = clean(env.YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRM);
  if (confirmation !== YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRMATION) {
    throw new Error(`Author ban requires YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRM=${YOUTUBE_REPEAT_OFFENDER_BAN_CONFIRMATION}`);
  }
  return {
    ...loadYouTubeRepeatOffenderConfig({ ...env, YOUTUBE_REPEAT_OFFENDER_NOTIFY_SLACK: 'false' }),
    alertId: requiredPositiveInt(env.YOUTUBE_REPEAT_OFFENDER_ALERT_ID, 'YOUTUBE_REPEAT_OFFENDER_ALERT_ID'),
    actor: clean(env.YOUTUBE_REPEAT_OFFENDER_BAN_ACTOR || 'codex-repeat-offender-ban'),
  };
}

export function buildYouTubeAuthorBanUrl(youtubeApiBase, commentId) {
  const url = new URL(`${clean(youtubeApiBase).replace(/\/$/, '')}/comments/setModerationStatus`);
  url.searchParams.set('id', clean(commentId));
  url.searchParams.set('moderationStatus', 'rejected');
  url.searchParams.set('banAuthor', 'true');
  return url;
}

export async function persistBanEvidence(config, alertIds, fetchImpl, now) {
  // banAuthor는 그 작성자의 이 채널 댓글을 모두 숨긴다 → 후보의 모든 alert 행을 author_banned로
  // 맞춘다(bulk-ban persistAuthorBanned와 동일 계약). candidate.alertIds는 리포트 단계에서 이미
  // 사람 keep 결정(오탐·무시·승인·숨김해제)을 뺀 행만이라 사람 판단을 덮지 않는다.
  // ⚠️ 전엔 증거 1행만, 그것도 review_decision=is.null일 때만 갱신 → 이미 자동숨김('hidden')된
  // 악플러는 밴해도 기록이 안 남아 다음 리포트에 계속 후보로 재등장했다(2026-10-15 UC1jnDc…).
  const ids = [...new Set((Array.isArray(alertIds) ? alertIds : [alertIds]).map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return;
  const response = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/negative_comment_alerts?id=in.(${ids.join(',')})`,
    {
      method: 'PATCH',
      headers: headers(config, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        review_decision: 'author_banned',
        reviewed_by: config.actor,
        reviewed_at: new Date(now).toISOString(),
        hidden_confirmed: true,
        hidden_confirmed_at: new Date(now).toISOString(),
      }),
    },
  );
  if (!response.ok) throw new Error(`Repeat-offender ban audit update failed (${response.status})`);
}

export async function banYouTubeRepeatOffender(
  config = loadYouTubeRepeatOffenderBanConfig(), fetchImpl = fetch, now = Date.now(),
) {
  const prepared = await prepareYouTubeRepeatOffenderReport({ ...config, notifySlack: false }, fetchImpl);
  const candidate = prepared.candidates.find((row) => row.alertIds.includes(config.alertId));
  if (!candidate) throw new Error('Selected alert is not an eligible repeat-offender candidate');

  // prepare 단계에서 같은 소유 채널의 owner OAuth로 댓글을 직접 조회해 작성자 ID와
  // 후보 임계를 검증했다. 해당 채널 토큰으로만 banAuthor를 실행한다.
  const accessToken = prepared.accessTokens.get(candidate.ownerChannelId);
  if (!accessToken) throw new Error('Owner OAuth token unavailable for selected candidate');

  const alertResponse = await fetchImpl(
    `${config.supabaseUrl}/rest/v1/negative_comment_alerts?select=comment_id&id=eq.${config.alertId}&limit=1`,
    { headers: headers(config) },
  );
  if (!alertResponse.ok) throw new Error(`Repeat-offender evidence lookup failed (${alertResponse.status})`);
  const [alert] = await alertResponse.json();
  const commentId = clean(alert?.comment_id);
  if (!commentId) throw new Error('Selected repeat-offender evidence has no comment ID');

  const response = await fetchImpl(buildYouTubeAuthorBanUrl(config.youtubeApiBase, commentId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status !== 204) {
    throw new Error(`YouTube author ban failed (${response.status})`);
  }
  await persistBanEvidence(config, candidate.alertIds, fetchImpl, now);
  return {
    banned: true,
    candidateCommentCount: candidate.commentCount,
    candidateVideoCount: candidate.videoCount,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  banYouTubeRepeatOffender()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
