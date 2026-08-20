import { spawnSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const capturePath = String(process.env.YOUTUBE_OWNER_OAUTH_CAPTURE
  || path.join(tmpdir(), 'negative-comment-youtube-satellite-oauth.json')).trim();
const workflow = 'youtube-owner-oauth-exchange.yml';

function gh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    input: options.input,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${String(result.stderr || '').trim().slice(0, 300)}`);
  return String(result.stdout || '').trim();
}

const capture = JSON.parse(await readFile(capturePath, 'utf8'));
const code = String(capture.code || '').trim();
const expectedChannelId = String(capture.expectedChannelId || '').trim();
if (!code || !expectedChannelId) throw new Error('OAuth capture is incomplete');
const startedAt = Date.now();

try {
  // 인증 코드는 명령행 인자·로그에 넣지 않고 stdin으로 Actions Secret에 전달한다.
  gh(['secret', 'set', 'YOUTUBE_OWNER_AUTH_CODE'], { input: code });
  gh(['workflow', 'run', workflow, '-f', `expected_channel_id=${expectedChannelId}`]);

  let runId = '';
  for (let attempt = 0; attempt < 20 && !runId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const raw = gh(['run', 'list', '--workflow', workflow, '--event', 'workflow_dispatch', '--limit', '5', '--json', 'databaseId,createdAt']);
    const runs = JSON.parse(raw || '[]');
    const matched = runs.find((run) => Date.parse(run.createdAt) >= startedAt - 5000);
    if (matched) runId = String(matched.databaseId);
  }
  if (!runId) throw new Error('Could not locate the OAuth exchange workflow run');
  const watched = spawnSync('gh', ['run', 'watch', runId, '--exit-status'], {
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (watched.status !== 0) throw new Error(`OAuth exchange workflow failed (run ${runId})`);
  console.log(JSON.stringify({ ok: true, requested: capture.requested, expectedChannelId, workflowRunId: runId }));
} finally {
  try { gh(['secret', 'delete', 'YOUTUBE_OWNER_AUTH_CODE']); } catch { /* 이미 없으면 무시 */ }
  try { await unlink(capturePath); } catch { /* 이미 없으면 무시 */ }
}
