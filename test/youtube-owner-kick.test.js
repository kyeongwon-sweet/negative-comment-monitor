import test from 'node:test';
import assert from 'node:assert/strict';
import { kickOwnerMonitorIfDue } from '../src/youtube-owner-kick.js';

const NOW = Date.parse('2026-11-25T01:00:00Z');
const ENV = { GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'gh', GITHUB_REF_NAME: 'master' };
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

function job(ok = true) {
  const c = ok ? 'success' : 'failure';
  return [{ name: 'monitor', steps: [
    { name: 'Verify owner-channel schema contract', conclusion: c },
    { name: 'Run owner-channel monitor', conclusion: c },
  ] }];
}
const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });

function world(runs, jobsById = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/runs?')) return json({ workflow_runs: runs });
    const m = url.match(/\/runs\/(\d+)\/jobs/);
    if (m) return json({ jobs: jobsById[m[1]] || [] });
    if (url.endsWith('/dispatches')) return json(null, 204);
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

test('최근 3.5시간 안에 정상 회차가 있으면 아무것도 하지 않는다', async () => {
  const w = world([{ id: 1, status: 'completed', run_started_at: hoursAgo(1) }], { 1: job() });
  const r = await kickOwnerMonitorIfDue(ENV, NOW, w.fetchImpl);
  assert.equal(r.kicked, false);
  assert.equal(r.reason, 'recent_healthy');
  assert.equal(w.calls.some((c) => c.url.endsWith('/dispatches')), false);
});

test('11-25 재발방지: 크론이 밀려 3.5시간 넘게 정상 회차가 없으면 live 예산으로 한 번 실행시킨다', async () => {
  const w = world([
    { id: 2, status: 'completed', run_started_at: hoursAgo(2) },
    { id: 1, status: 'completed', run_started_at: hoursAgo(9) },
  ], { 2: job(false), 1: job() });
  const r = await kickOwnerMonitorIfDue(ENV, NOW, w.fetchImpl);
  assert.equal(r.kicked, true);
  const dispatch = w.calls.find((c) => c.url.endsWith('/dispatches'));
  assert.deepEqual(JSON.parse(dispatch.options.body), { ref: 'master', inputs: { dry_run: 'false', scheduled_kick: 'true' } });
  // 기준 시각보다 오래된 회차(9시간 전)의 job은 조회하지 않는다.
  assert.equal(w.calls.some((c) => c.url.includes('/runs/1/jobs')), false);
});

test('이미 돌거나 대기 중인 회차가 있으면 중복 실행하지 않는다', async () => {
  const w = world([
    { id: 3, status: 'queued', run_started_at: hoursAgo(0) },
    { id: 1, status: 'completed', run_started_at: hoursAgo(9) },
  ]);
  const r = await kickOwnerMonitorIfDue(ENV, NOW, w.fetchImpl);
  assert.equal(r.kicked, false);
  assert.equal(r.reason, 'active');
  assert.equal(w.calls.length, 1);
});
