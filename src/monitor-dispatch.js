export async function dispatchMonitor(env = process.env, fetchImpl = fetch, options = {}) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or token');

  const body = { ref };
  if (options.chain) {
    body.inputs = {
      monitor_chain: 'true',
      monitor_chain_max_per_day: String(options.maxPerDay || ''),
      monitor_chain_smoke: options.smoke ? 'true' : 'false',
      monitor_chain_floor: options.floor ? 'true' : 'false',
      monitor_chain_floor_minutes: String(options.floorMinutes || ''),
      monitor_chain_floor_max_per_day: String(options.floorMaxPerDay || ''),
    };
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/monitor.yml/dispatches`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': options.chain ? 'ncm-monitor-chain' : 'ncm-heartbeat',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GitHub dispatch API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return true;
}

export async function dispatchFloorWake(env = process.env, fetchImpl = fetch, options = {}) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const token = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  const ref = String(env.GITHUB_REF_NAME || 'master').trim() || 'master';
  const wakeAt = Number(options.wakeAt);
  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or token');
  if (!Number.isFinite(wakeAt)) throw new Error('Missing floor wake timestamp');

  const url = `https://api.github.com/repos/${repo}/actions/workflows/monitor-floor-wake.yml/dispatches`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ncm-monitor-floor-wake',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        wake_at: new Date(wakeAt).toISOString(),
        monitor_chain_floor_minutes: String(options.floorMinutes || ''),
        monitor_chain_floor_max_per_day: String(options.floorMaxPerDay || ''),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub floor wake dispatch API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return true;
}
