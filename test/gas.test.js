import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTargets, loadTargetCache, resolveTargetUrls, saveTargetCache } from '../src/gas.js';

const CFG = { gasWebAppUrl: 'https://script.google.com/x/exec', gasVerifyToken: 'tok', targetBatchSize: 300 };

test('GAS 캐시 저장 스키마 오류는 core를 막지 않고 적용할 migration을 명시한다', async () => {
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    await saveTargetCache(
      { supabaseUrl: 'https://db.test', supabaseKey: 'k' }, [{ url: 'u1' }],
      async () => ({ ok: false, status: 400 }), Date.parse('2026-08-20T00:00:00Z'),
    );
  } finally {
    console.error = original;
  }
  assert.match(messages.join('\n'), /009_gas_target_cache\.sql/);
  assert.match(messages.join('\n'), /primary key \(id\)/);
});

test('GAS 캐시 조회 스키마 오류도 fail-open하고 적용할 migration을 명시한다', async () => {
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  let result;
  try {
    result = await loadTargetCache(
      { supabaseUrl: 'https://db.test', supabaseKey: 'k' },
      async () => ({ ok: false, status: 404 }),
    );
  } finally {
    console.error = original;
  }
  assert.equal(result, null);
  assert.match(messages.join('\n'), /009_gas_target_cache\.sql/);
});

test('fetchTargets: 정상 JSON이면 targets 반환', async () => {
  let requestedUrl;
  let requestedOptions;
  const fetchImpl = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return { ok: true, text: async () => JSON.stringify({ ok: true, result: { targets: [{ url: 'u1' }], total: 1 } }) };
  };
  const out = await fetchTargets(CFG, fetchImpl);
  assert.deepEqual(out, [{ url: 'u1' }]);
  assert.equal(requestedUrl.searchParams.get('limit'), '300');
  assert.match(requestedUrl.searchParams.get('_cb'), /^\d+$/);
  assert.equal(requestedOptions.cache, 'no-store');
  assert.equal(requestedOptions.headers['cache-control'], 'no-cache');
});

test('fetchTargets: 상한(batch cap) truncation이면 실패(returned≥limit & total>returned)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      ok: true,
      result: { targets: Array.from({ length: 699 }, (_, i) => ({ url: `u${i}` })), total: 817 },
    }),
  });
  await assert.rejects(
    () => fetchTargets({ ...CFG, gasFetchRetries: 1 }, fetchImpl),
    /returned=699, expected=817, limit=300/,
  );
});

test('fetchTargets: 상한과 무관한 소량 불일치(returned≪limit)는 run을 죽이지 않고 받은 대상으로 진행', async () => {
  // 구 응답(메타 없음): total=dedup 전. limit=1000이라 상한 truncation 아님 → 진행해야 함.
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      ok: true,
      result: { targets: Array.from({ length: 822 }, (_, i) => ({ url: `u${i}` })), total: 823 },
    }),
  });
  const out = await fetchTargets({ ...CFG, targetBatchSize: 1000, gasFetchRetries: 1 }, fetchImpl);
  assert.equal(out.length, 822);
});

test('fetchTargets: GAS v83(total=targets.length)+dedup 1건은 정상 통과(실패·경고 없음)', async () => {
  // 실측(v83): total=822=targets, meta.rawEligibleCount=823, duplicateCount=1 → 기대(823-1)=822=returned → 정상.
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      ok: true,
      result: {
        targets: Array.from({ length: 822 }, (_, i) => ({ url: `u${i}` })),
        total: 822, meta: { rawEligibleCount: 823, duplicateCount: 1 },
      },
    }),
  });
  const out = await fetchTargets({ ...CFG, targetBatchSize: 1000, gasFetchRetries: 1 }, fetchImpl);
  assert.equal(out.length, 822);
});

test('fetchTargets: v83에서 total=targets.length여도 상한 잘림은 rawEligible−dup로 감지해 실패', async () => {
  // dedup(2) 제외 기대 1003인데 상한(1000)에 걸려 1000만 반환 → 잘림 → fail-loud(699/817 방어 복원).
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      ok: true,
      result: {
        targets: Array.from({ length: 1000 }, (_, i) => ({ url: `u${i}` })),
        total: 1000, meta: { rawEligibleCount: 1005, duplicateCount: 2 },
      },
    }),
  });
  await assert.rejects(
    () => fetchTargets({ ...CFG, targetBatchSize: 1000, gasFetchRetries: 1 }, fetchImpl),
    /returned=1000, expected=1003, limit=1000/,
  );
});

test('fetchTargets: 대상 증가로 상한이 잘리면 다음 재시도에서 limit를 자동 확장한다', async () => {
  const requestedLimits = [];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    requestedLimits.push(Number(url.searchParams.get('limit')));
    if (calls === 1) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          result: {
            targets: Array.from({ length: 1025 }, (_, i) => ({ url: `u${i}` })),
            total: 1025,
            meta: { rawEligibleCount: 1029, duplicateCount: 2 },
          },
        }),
      };
    }
    return {
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        result: {
          targets: Array.from({ length: 1027 }, (_, i) => ({ url: `u${i}` })),
          total: 1027,
          meta: { rawEligibleCount: 1029, duplicateCount: 2 },
        },
      }),
    };
  };
  const out = await fetchTargets({ ...CFG, targetBatchSize: 1000, gasFetchRetries: 2 }, fetchImpl);
  assert.equal(out.length, 1027);
  assert.deepEqual(requestedLimits, [1000, 2000]);
});

test('fetchTargets: GAS가 HTML 오류 페이지 주면 원인 담긴 명확한 오류로 throw(#7 시트 헤더 등)', async () => {
  const html = '<!DOCTYPE html><html><head><title>오류</title></head><body><div class="errorMessage">Error: 필수 헤더 누락: 채널명 (\'Code\' 파일, 2054행)</div></body></html>';
  const fetchImpl = async () => ({ ok: true, text: async () => html });
  await assert.rejects(
    () => fetchTargets({ ...CFG, gasFetchRetries: 1 }, fetchImpl),
    (e) => /오류 페이지 반환/.test(e.message) && /필수 헤더 누락: 채널명/.test(e.message),
  );
});

test('fetchTargets: HTTP 오류는 상태코드 포함 throw', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => fetchTargets({ ...CFG, gasFetchRetries: 1 }, fetchImpl), /GAS HTTP 500/);
});

test('fetchTargets: GAS 전면 실패 + 캐시 존재 → degraded로 캐시 대상 반환', async () => {
  const CFG2 = { ...CFG, gasFetchRetries: 1, supabaseUrl: 'https://db.test', supabaseKey: 'k' };
  const html = '<!DOCTYPE html><html><body>err</body></html>';
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('gas_target_cache')) {
      return { ok: true, json: async () => [{ targets: [{ url: 'https://www.instagram.com/p/A/' }], count: 1, fetched_at: '2026-08-19T00:00:00Z' }] };
    }
    return { ok: true, text: async () => html }; // GAS HTML 오류
  };
  const out = await fetchTargets(CFG2, fetchImpl, Date.parse('2026-08-19T02:00:00Z'));
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://www.instagram.com/p/A/');
  assert.equal(out.degradedFallback?.source, 'gas-cache');
  assert.equal(out.degradedFallback?.ageHours, 2);
});

test('fetchTargets: GAS 실패 + 캐시 없음이면 기존대로 throw(무단 degraded 금지)', async () => {
  const CFG2 = { ...CFG, gasFetchRetries: 1, supabaseUrl: 'https://db.test', supabaseKey: 'k' };
  const fetchImpl = async (url) => {
    if (String(url).includes('gas_target_cache')) return { ok: true, json: async () => [] };
    return { ok: true, text: async () => '<html>err</html>' };
  };
  await assert.rejects(() => fetchTargets(CFG2, fetchImpl, Date.now()));
});

test('fetchTargets: transient GAS HTML/404는 재시도 후 성공하면 targets 반환', async () => {
  let calls = 0;
  const cacheBusters = [];
  const fetchImpl = async (url) => {
    calls += 1;
    cacheBusters.push(url.searchParams.get('_cb'));
    if (calls === 1) return { ok: false, status: 404, text: async () => '<!DOCTYPE html><html>Drive temporary error</html>' };
    if (calls === 2) return { ok: true, text: async () => '<!DOCTYPE html><html>Temporary Apps Script HTML</html>' };
    return { ok: true, text: async () => JSON.stringify({ ok: true, result: { targets: [{ url: 'u2' }] } }) };
  };
  const out = await fetchTargets({ ...CFG, gasFetchRetries: 3 }, fetchImpl);
  assert.equal(calls, 3);
  assert.equal(new Set(cacheBusters).size, 3);
  assert.deepEqual(out, [{ url: 'u2' }]);
});

test('resolveTargetUrls: TikTok vt/vm short URLs are replaced with canonical redirected URLs', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://vt.tiktok.com/ZSYabc123/');
    assert.equal(options.redirect, 'follow');
    assert.equal(options.method, 'HEAD');
    return { ok: true, url: 'https://www.tiktok.com/@humorbox_/photo/7530011122233445566' };
  };
  const out = await resolveTargetUrls([
    { url: 'https://vt.tiktok.com/ZSYabc123/', channelCategory: '협찬' },
    { url: 'https://www.tiktok.com/@u/video/7656707663044185364', channelCategory: '협찬' },
  ], fetchImpl);
  assert.deepEqual(out, [
    {
      url: 'https://www.tiktok.com/@humorbox_/photo/7530011122233445566',
      originalUrl: 'https://vt.tiktok.com/ZSYabc123/',
      channelCategory: '협찬',
    },
    { url: 'https://www.tiktok.com/@u/video/7656707663044185364', channelCategory: '협찬' },
  ]);
});

test('GAS evergreen 상한 초과는 원인을 명시하고 대상에 표시한다(요청 limit로 못 올림)', async () => {
  const { fetchTargets } = await import('../src/gas.js');
  const { buildGapMessage } = await import('../src/target-sync-watchdog.js');
  const targets = Array.from({ length: 1029 }, (_, i) => ({ url: `https://www.youtube.com/watch?v=v${i}`, channelCategory: '위성채널' }));
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'gas.test') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ ok: true, result: { total: 1029, targets,
          meta: { evergreenCount: 1096, evergreenLimit: 1000, rawEligibleCount: 1126, returnedCount: 1029, duplicateCount: 5 } } }),
        json: async () => ({ ok: true, result: { total: 1029, targets,
          meta: { evergreenCount: 1096, evergreenLimit: 1000, rawEligibleCount: 1126, returnedCount: 1029, duplicateCount: 5 } } }) };
    }
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '', json: async () => ({}) };
  };
  const out = await fetchTargets({ gasWebAppUrl: 'https://gas.test/exec', gasVerifyToken: 'k', targetBatchSize: 2000, gasFetchRetries: 1 }, fetchImpl);
  assert.equal(out.length, 1029);
  assert.deepEqual(out.evergreenCapped, { evergreenCount: 1096, evergreenLimit: 1000, dropped: 96, supplemented: 0 });
  const msg = buildGapMessage(Date.parse('2026-10-11T03:00:00Z'), [{ channel_type: '위성채널' }], 'U1', out.evergreenCapped);
  assert.match(msg, /evergreen 1096건 > 상한 1000/);
  assert.doesNotMatch(buildGapMessage(Date.now(), [{ channel_type: '위성채널' }], 'U1'), /원인 확인됨/);
});

test('evergreen 상한 초과분은 DB 활성 온드/위성 글로 보충한다(중복·비evergreen·비지원 플랫폼 제외)', async () => {
  const { fetchTargets } = await import('../src/gas.js');
  const gasTargets = [
    { row: 10, url: 'https://www.tiktok.com/@a/video/111/', channelName: '썰박스(틱톡)', channelCategory: '위성채널', platform: 'tiktok', company: '' },
  ];
  const meta = { evergreenCount: 1096, evergreenLimit: 1000, rawEligibleCount: 1126, returnedCount: 1, duplicateCount: 5 };
  const dbRows = [
    { id: 1, url: 'https://www.tiktok.com/@a/video/111/', channel_type: '위성채널', account_name: '썰박스 (틱톡)', posted_at: '2026-10-05T00:00:00Z' }, // 이미 있음
    { id: 2, url: 'https://www.tiktok.com/@b/photo/222/', channel_type: '위성채널', account_name: '', posted_at: '2026-10-11T00:00:00Z' },
    { id: 3, url: 'https://www.youtube.com/watch?v=abcDEF12345', channel_type: '위성채널', account_name: '썰박스 (유튜브)', posted_at: null },
    { id: 4, url: 'https://www.instagram.com/p/XYZ/', channel_type: '바이럴 (배너)', account_name: 'x', posted_at: null }, // 비evergreen
    { id: 5, url: 'https://www.threads.net/@c/post/1', channel_type: '위성채널', account_name: 'y', posted_at: null }, // 비지원 플랫폼
    { id: 6, url: 'https://www.instagram.com/reel/OWN1/', channel_type: '온드미디어', account_name: 'lm', posted_at: null },
  ];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body });
    if (url.hostname === 'gas.test') return ok({ ok: true, result: { total: 1, targets: gasTargets, meta } });
    if (url.hostname === 'db.test' && url.pathname.endsWith('/sponsored_posts')) {
      assert.equal(url.searchParams.get('ended_at'), 'is.null');
      return ok(Number(url.searchParams.get('offset')) === 0 ? dbRows : []);
    }
    if (url.hostname === 'db.test') return ok([]); // 캐시 저장
    throw new Error(`unexpected ${url}`);
  };
  const out = await fetchTargets({
    gasWebAppUrl: 'https://gas.test/exec', gasVerifyToken: 'k', targetBatchSize: 2000, gasFetchRetries: 1,
    supabaseUrl: 'https://db.test', supabaseKey: 'svc',
  }, fetchImpl);
  assert.deepEqual(out.map((t) => t.url), [
    'https://www.tiktok.com/@a/video/111/',
    'https://www.tiktok.com/@b/photo/222/',
    'https://www.youtube.com/watch?v=abcDEF12345',
    'https://www.instagram.com/reel/OWN1/',
  ]);
  assert.equal(out.evergreenCapped.supplemented, 3);
  const yt = out.find((t) => t.platform === 'youtube');
  assert.equal(yt.channelCategory, '위성채널');
  assert.equal(yt.channelName, '썰박스 (유튜브)');
  assert.equal(yt.source, 'db-evergreen-supplement');
});

test('evergreen 상한 미초과면 DB 보충을 하지 않는다', async () => {
  const { fetchTargets } = await import('../src/gas.js');
  let dbCalls = 0;
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body });
    if (url.hostname === 'gas.test') return ok({ ok: true, result: { total: 1, targets: [{ url: 'https://www.tiktok.com/@a/video/1/', channelCategory: '위성채널', platform: 'tiktok' }],
      meta: { evergreenCount: 900, evergreenLimit: 1000, rawEligibleCount: 1, returnedCount: 1, duplicateCount: 0 } } });
    if (url.pathname.endsWith('/sponsored_posts')) dbCalls += 1;
    return ok([]);
  };
  const out = await fetchTargets({ gasWebAppUrl: 'https://gas.test/exec', gasVerifyToken: 'k', targetBatchSize: 2000, gasFetchRetries: 1, supabaseUrl: 'https://db.test', supabaseKey: 'svc' }, fetchImpl);
  assert.equal(out.length, 1);
  assert.equal(dbCalls, 0);
  assert.equal(out.evergreenCapped, undefined);
});
