import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  autoRestoreYouTubeFalsePositives,
  loadYouTubeAutoRestoreConfig,
} from './youtube-comment-restore.js';

export async function runYouTubeFalsePositiveAutoRestore(
  config = loadYouTubeAutoRestoreConfig(), fetchImpl = fetch, now = Date.now(),
) {
  return autoRestoreYouTubeFalsePositives(config, fetchImpl, now);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runYouTubeFalsePositiveAutoRestore()
    .then((result) => {
      // 공개 Actions 로그에는 댓글 ID·본문·OAuth 토큰을 기록하지 않는다.
      console.log(JSON.stringify(result));
      if (result.failed || result.unverified || result.slackFailed) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[youtube-fp-auto-restore:degraded] ${error.message}`);
      process.exitCode = 2;
    });
}
