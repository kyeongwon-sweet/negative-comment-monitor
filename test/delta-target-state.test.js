import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCommentCountStates,
  filterArchivedOrDeadTargets,
  filterBaselineTargets,
  filterChangedTargets,
  loadCommentCounts,
  loadCommentCountsOptimized,
} from '../src/delta.js';

const CFG = {
  supabaseUrl: 'https://db.test',
  supabaseKey: 'service',
  monitorTargetStateMode: 'optimized',
};

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const targets = [
  { url: 'https://www.instagram.com/p/POST_A/' },
  { url: 'https://www.instagram.com/reel/POST_A/?utm_source=x' },
  { url: 'https://www.youtube.com/watch?v=VIDEO_B' },
  { url: 'https://naver.com/not-supported' },
];

test('optimized target-state RPC는 고유 게시물 키만 보내고 KST 30일 cutoff·기존 shape를 보존한다', async () => {
  let request;
  const now = Date.parse('2026-10-26T16:30:00Z'); // 2026-10-27 01:30 KST
  const out = await loadCommentCountsOptimized(CFG, targets, async (input, init) => {
    request = { url: String(input), init };
    return response(200, [
      {
        normalized_key: 'ig:POST_A', post_id: 'post-a', content_summary: 'caption',
        product_name: 'JD', ended_at: null, not_found_streak: 1, asset_name: 'asset-a',
        current_count: '12', last_count: '10', last_checked_at: '2026-10-26T00:00:00Z',
      },
      {
        normalized_key: 'yt:VIDEO_B', post_id: 'post-b', content_summary: null,
        product_name: null, ended_at: '2026-10-20', not_found_streak: 0, asset_name: null,
        current_count: null, last_count: null, last_checked_at: null,
      },
    ]);
  }, now);

  assert.equal(request.url, 'https://db.test/rest/v1/rpc/monitor_comment_target_state');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), {
    p_keys: ['ig:POST_A', 'yt:VIDEO_B'],
    p_cutoff: '2026-09-27',
  });
  assert.deepEqual(out[targets[0].url], {
    postId: 'post-a', current: 12, last: 10, lastCheckedAt: '2026-10-26T00:00:00Z',
    caption: 'caption', productName: 'JD', endedAt: null, notFoundStreak: 1, assetName: 'asset-a',
  });
  assert.deepEqual(out[targets[1].url], out[targets[0].url], '같은 identity key의 URL 변형은 같은 상태를 쓴다');
  assert.equal(out[targets[2].url].endedAt, '2026-10-20');
  assert.deepEqual(out[targets[3].url], {
    postId: null, current: null, last: null, lastCheckedAt: '', caption: '', productName: '',
    endedAt: null, notFoundStreak: 0, assetName: '',
  });
});

test('1,000개를 넘는 대상 키는 PostgREST 행 상한 아래로 청크하고 중복 키는 한 번만 요청한다', async () => {
  const largeTargets = Array.from({ length: 1001 }, (_, index) => ({
    url: `https://www.instagram.com/p/POST_${index}/`,
  }));
  largeTargets.push({ url: 'https://www.instagram.com/reel/POST_0/' });
  const batches = [];
  const out = await loadCommentCountsOptimized(CFG, largeTargets, async (_input, init) => {
    const body = JSON.parse(init.body);
    batches.push(body.p_keys);
    return response(200, body.p_keys.map((key) => ({
      normalized_key: key, post_id: `id-${key}`, current_count: 1, last_count: 1,
    })));
  });

  assert.deepEqual(batches.map((batch) => batch.length), [500, 500, 1]);
  assert.equal(new Set(batches.flat()).size, 1001);
  assert.equal(out[largeTargets[0].url].postId, 'id-ig:POST_0');
  assert.equal(out[largeTargets.at(-1).url].postId, 'id-ig:POST_0');
});

test('optimized RPC 장애는 같은 회차에 legacy 경로로 fallback해 대상·최신값을 놓치지 않는다', async () => {
  const calls = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const out = await loadCommentCounts(CFG, [targets[0]], async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/rpc/monitor_comment_target_state')) return response(404, { message: 'missing' });
      if (url.includes('/sponsored_posts?')) return response(200, [{
        id: 'post-a', url: targets[0].url, content_summary: 'legacy-caption', product_name: 'P말',
        ended_at: null, not_found_streak: 0, asset_name: 'legacy-asset',
      }]);
      if (url.includes('/post_daily_stats?')) return response(200, [{
        post_id: 'post-a', comments_count: 21, measured_at: '2026-10-26',
      }]);
      if (url.includes('/post_comment_checks?')) return response(200, [{
        post_id: 'post-a', last_count: 20, last_checked_at: '2026-10-25T00:00:00Z',
      }]);
      throw new Error(`unexpected ${url}`);
    }, Date.parse('2026-10-26T16:30:00Z'));
    assert.equal(out[targets[0].url].current, 21);
    assert.equal(out[targets[0].url].last, 20);
    assert.equal(calls.filter(({ url }) => url.includes('/sponsored_posts?')).length, 1);
    assert.match(calls.find(({ url }) => url.includes('/post_daily_stats?')).url, /measured_at=gte\.2026-09-27/);
    assert.match(calls.find(({ url }) => url.includes('/post_daily_stats?')).url, /order=measured_at\.desc,post_id\.asc/);
    assert.match(calls.find(({ url }) => url.includes('/post_comment_checks?')).url, /order=post_id\.asc/);
    assert.match(errors.join('\n'), /falling back to legacy/);
  } finally {
    console.error = originalError;
  }
});

test('shadow 모드는 불일치를 표면화하되 legacy 판정 결과를 유지한다', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const out = await loadCommentCounts({ ...CFG, monitorTargetStateMode: 'shadow' }, [targets[0]], async (input) => {
      const url = String(input);
      if (url.endsWith('/rpc/monitor_comment_target_state')) return response(200, [{
        normalized_key: 'ig:POST_A', post_id: 'post-a', current_count: 99, last_count: 20,
      }]);
      if (url.includes('/sponsored_posts?')) return response(200, [{ id: 'post-a', url: targets[0].url }]);
      if (url.includes('/post_daily_stats?')) return response(200, [{ post_id: 'post-a', comments_count: 21 }]);
      if (url.includes('/post_comment_checks?')) return response(200, [{ post_id: 'post-a', last_count: 20 }]);
      throw new Error(`unexpected ${url}`);
    });
    assert.equal(out[targets[0].url].current, 21, 'shadow에서 운영 판정은 legacy 결과를 쓴다');
    assert.match(errors.join('\n'), /shadow mismatch/);
    assert.match(errors.join('\n'), /current/);
  } finally {
    console.error = originalError;
  }
});

test('동일 상태는 target set·baseline·종료 제외·alert 후보가 두 경로에서 완전히 같다', () => {
  const state = {
    [targets[0].url]: { postId: 'a', current: 3, last: 2, endedAt: null, notFoundStreak: 0 },
    [targets[2].url]: { postId: 'b', current: 0, last: null, endedAt: null, notFoundStreak: 0 },
    dead: { postId: 'c', current: 2, last: 1, endedAt: null, notFoundStreak: 2 },
  };
  const optimized = structuredClone(state);
  assert.deepEqual(compareCommentCountStates(state, optimized), { match: true, mismatchCount: 0, mismatches: [] });
  const parityTargets = [{ url: targets[0].url }, { url: targets[2].url }, { url: 'dead' }];
  assert.deepEqual(filterChangedTargets(parityTargets, state), filterChangedTargets(parityTargets, optimized));
  assert.deepEqual(filterBaselineTargets(parityTargets, state), filterBaselineTargets(parityTargets, optimized));
  assert.deepEqual(filterArchivedOrDeadTargets(parityTargets, state), filterArchivedOrDeadTargets(parityTargets, optimized));
});
