import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadYouTubeAdAlerts, loadYouTubeOwnerModerationConfig } from './youtube-owner-moderation.js';
import { syncHiddenYouTubeSlackCards } from './youtube-hidden-slack.js';

export const YOUTUBE_HIDDEN_SLACK_SYNC_CONFIRMATION = 'SYNC_ALL_HIDDEN_YOUTUBE_CARDS';

export async function runHiddenYouTubeSlackSync(config = loadYouTubeOwnerModerationConfig(), fetchImpl = fetch) {
  if (String(process.env.YOUTUBE_HIDDEN_SLACK_SYNC_CONFIRM || '').trim() !== YOUTUBE_HIDDEN_SLACK_SYNC_CONFIRMATION) {
    throw new Error(`Slack sync requires YOUTUBE_HIDDEN_SLACK_SYNC_CONFIRM=${YOUTUBE_HIDDEN_SLACK_SYNC_CONFIRMATION}`);
  }
  const rows = (await loadYouTubeAdAlerts(config, fetchImpl))
    .filter((row) => row.review_decision === 'hidden');
  const result = await syncHiddenYouTubeSlackCards(config, rows, fetchImpl);
  return { hiddenRows: rows.length, ...result };
}

async function writeSummary(result) {
  const file = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!file) return;
  await appendFile(file, [
    '## YouTube 숨김 Slack 카드 동기화',
    '',
    `- DB hidden 행: ${result.hiddenRows}`,
    `- Slack 갱신 대상: ${result.eligible}`,
    `- 갱신 성공: ${result.updated}`,
    `- 원본 메시지 없음/수정 불가: ${result.unavailable}`,
    `- 갱신 실패: ${result.failed}`,
    `- 실패 원인: ${JSON.stringify(result.failureReasons)}`,
    '',
  ].join('\n'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runHiddenYouTubeSlackSync()
    .then(async (result) => {
      console.log(JSON.stringify(result));
      await writeSummary(result);
      if (result.failed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
