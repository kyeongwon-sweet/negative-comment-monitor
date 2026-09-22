import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchMonitor } from '../src/monitor-dispatch.js';

const ENV = {
  GITHUB_REPOSITORY: 'owner/repo',
  GH_TOKEN: 'token',
  GITHUB_REF_NAME: 'master',
};

test('ordinary recovery dispatch keeps the existing input-free contract', async () => {
  let request;
  await dispatchMonitor(ENV, async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  });

  assert.match(request.url, /monitor\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(request.options.body), { ref: 'master' });
});

test('self-chain dispatch marks only the internal continuation and propagates its cap', async () => {
  let request;
  await dispatchMonitor(ENV, async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  }, { chain: true, maxPerDay: 7 });

  assert.deepEqual(JSON.parse(request.options.body), {
    ref: 'master',
    inputs: {
      monitor_chain: 'true',
      monitor_chain_max_per_day: '7',
      monitor_chain_smoke: 'false',
    },
  });
});

test('self-chain smoke marker is propagated to the queued continuation', async () => {
  let request;
  await dispatchMonitor(ENV, async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  }, { chain: true, maxPerDay: 1, smoke: true });

  assert.equal(JSON.parse(request.options.body).inputs.monitor_chain_smoke, 'true');
});
