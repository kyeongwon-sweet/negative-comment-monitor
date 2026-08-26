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
      // 공개 복원 미확인은 DB에 1회 격리됐으면 반복 장애가 아니다. 격리 쓰기 자체가
      // 실패한 경우에만 degraded로 남겨 무음 유실을 막는다.
      if (result.failed || result.manualMarkFailed || result.slackFailed) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`[youtube-fp-auto-restore:degraded] ${error.message}`);
      process.exitCode = 2;
    });
}
