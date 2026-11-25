// 소유채널 보조 모니터(youtube-owner-channel.yml) 예약 실행 대타.
// 11-24~25: '17 */3' 크론이 실제로는 8~12시간 간격으로만 떠서(GitHub 크론 지연·드롭) 워치독 경고가 반복됐다.
// 메인 감시(monitor.yml)는 self-chain으로 ~45분마다 확실히 돌므로, 그 끝에서 이 스크립트가
// '최근 정상 회차가 N시간(기본 3.5) 넘게 없고, 지금 돌거나 대기 중인 회차도 없으면' 한 번 실행시킨다.
// 크론이 제때 뜨면 아무것도 하지 않는다(회차 수는 설계값 3시간 간격을 넘지 않는다).
import { evaluateOwnerWorkflowHealth, githubJson } from './youtube-owner-watchdog.js';

const RUNS_PATH = '/actions/workflows/youtube-owner-channel.yml/runs?per_page=10';
export const DEFAULT_KICK_AFTER_HOURS = 3.5;

export async function kickOwnerMonitorIfDue(env = process.env, now = Date.now(), fetchImpl = fetch) {
  const afterHours = Number(env.YOUTUBE_OWNER_KICK_AFTER_HOURS || DEFAULT_KICK_AFTER_HOURS);
  const threshold = now - afterHours * 3600 * 1000;
  const runs = (await githubJson(env, RUNS_PATH, {}, fetchImpl)).workflow_runs || [];
  const active = runs.filter((run) => run.status !== 'completed');
  if (active.length) return { kicked: false, reason: 'active', active: active.length };
  // 기준 시각 이후 완료 회차만 최신순으로 job을 본다(대개 API 1~2회). 정상 회차 하나면 충분하다.
  const recent = runs
    .filter((run) => Date.parse(run.run_started_at || run.created_at || '') >= threshold)
    .sort((a, b) => Date.parse(b.run_started_at || b.created_at) - Date.parse(a.run_started_at || a.created_at));
  for (const run of recent) {
    const jobs = (await githubJson(env, `/actions/runs/${run.id}/jobs?per_page=10`, {}, fetchImpl)).jobs || [];
    const health = evaluateOwnerWorkflowHealth([run], new Map([[String(run.id), jobs]]), now, afterHours);
    if (health.healthy) return { kicked: false, reason: 'recent_healthy', lastHealthyAt: health.lastHealthyAt };
  }
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  await githubJson(env, '/actions/workflows/youtube-owner-channel.yml/dispatches', {
    method: 'POST', body: JSON.stringify({ ref, inputs: { dry_run: 'false', scheduled_kick: 'true' } }),
  }, fetchImpl);
  return { kicked: true, reason: 'stale', afterHours };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  kickOwnerMonitorIfDue()
    .then((result) => console.log(`[youtube-owner-kick] ${JSON.stringify(result)}`))
    .catch((error) => {
      // 보조 단계: 실패해도 메인 감시를 실패로 만들지 않는다(워치독이 2차 안전망).
      console.error(`[youtube-owner-kick] ${error.message}`);
    });
}
