import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheEnabled,
  classificationCacheFingerprint,
  lookupCache,
  storeCache,
  purgeCache,
} from '../src/cache.js';
import { commentFingerprint } from '../src/dedup.js';

const CFG = { supabaseUrl: 'https://db.example', supabaseKey: 'svc-key' };
const HASH = 'a'.repeat(64);

test('분류 캐시 지문만 본문 편집에 민감하고 알림 dedup 지문은 comment_id 기준으로 유지된다', () => {
  const target = { platform: 'youtube', postKey: 'yt:video1' };
  const before = { id: 'comment1', platform: 'youtube', text: '맛있어요' };
  const edited = { ...before, text: '라라스윗 쥐도 먹기 싫어짐 전량 폐기' };
  assert.equal(commentFingerprint(target, before), commentFingerprint(target, edited));
  assert.notEqual(classificationCacheFingerprint(target, before), classificationCacheFingerprint(target, edited));
  assert.equal(classificationCacheFingerprint(target, before).length, 64);
});

test('cacheEnabled: url+key 있어야 true', () => {
  assert.equal(cacheEnabled(CFG), true);
  assert.equal(cacheEnabled({ supabaseUrl: 'x' }), false);
  assert.equal(cacheEnabled({}), false);
  assert.equal(cacheEnabled(null), false);
});

test('lookupCache: 히트를 index별로 반환하고 alert/reason 정규화', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /comment_classification_cache/);
    // 이월(carry-forward) 기본: 해시로 거르지 않고 지문 전체 이력을 최신순으로 읽는다.
    assert.doesNotMatch(url, /classifier_hash=eq\./);
    assert.match(url, /order=created_at\.desc/);
    return {
      ok: true,
      json: async () => [
        { fingerprint: 'fp1', classifier_hash: HASH, alert: true, category: '제품 불만', reason: '맛 혹평', priority: 'normal' },
        { fingerprint: 'fp2', classifier_hash: HASH, alert: false, category: '정상댓글', reason: '', priority: 'normal' },
      ],
    };
  };
  const items = [{ index: 3, fingerprint: 'fp1' }, { index: 7, fingerprint: 'fp2' }, { index: 9, fingerprint: 'fp3' }];
  const hits = await lookupCache(CFG, items, HASH, fetchImpl);
  assert.equal(hits.size, 2);
  assert.deepEqual(hits.get(3), { alert: true, category: '제품 불만', reason: '맛 혹평', priority: 'normal' });
  assert.equal(hits.get(7).alert, false);
  assert.equal(hits.get(7).reason, ''); // 정상은 reason 빈 값 유지
  assert.equal(hits.has(9), false); // fp3는 캐시에 없음(미스)
});

test('lookupCache: 조회 실패(non-ok)면 전부 미스(빈 Map)', async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => [] });
  const hits = await lookupCache(CFG, [{ index: 0, fingerprint: 'fp1' }], HASH, fetchImpl);
  assert.equal(hits.size, 0);
});

test('lookupCache: fetch 예외도 빈 Map으로 폴백', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const hits = await lookupCache(CFG, [{ index: 0, fingerprint: 'fp1' }], HASH, fetchImpl);
  assert.equal(hits.size, 0);
});

test('lookupCache: 캐시 비활성/해시 없음이면 조회 안 함', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => [] }; };
  assert.equal((await lookupCache({}, [{ index: 0, fingerprint: 'x' }], HASH, fetchImpl)).size, 0);
  assert.equal((await lookupCache(CFG, [{ index: 0, fingerprint: 'x' }], null, fetchImpl)).size, 0);
  assert.equal(called, false);
});

test('storeCache: 행 구성(정상은 reason 빈 값) + merge-duplicates 업서트', async () => {
  let body; let url;
  const fetchImpl = async (u, opts) => { url = u; body = JSON.parse(opts.body); return { ok: true }; };
  const n = await storeCache(CFG, [
    { fingerprint: 'fp1', result: { alert: true, category: '욕설/비속어', reason: '제품 겨냥 욕설', priority: 'high' } },
    { fingerprint: 'fp2', result: { alert: false, category: '정상댓글', reason: '무시될 값', priority: 'normal' } },
  ], HASH, fetchImpl);
  assert.equal(n, 2);
  assert.match(url, /on_conflict=fingerprint,classifier_hash/);
  assert.equal(body[0].classifier_hash, HASH);
  assert.equal(body[0].reason, '제품 겨냥 욕설');
  assert.equal(body[1].alert, false);
  assert.equal(body[1].reason, ''); // 정상 판정은 reason 저장 안 함
});

test('storeCache: 실패해도 예외 없이 0 반환(분류에 영향 없음)', async () => {
  assert.equal(await storeCache(CFG, [{ fingerprint: 'fp', result: { alert: true } }], HASH, async () => ({ ok: false })), 0);
  assert.equal(await storeCache(CFG, [{ fingerprint: 'fp', result: { alert: true } }], HASH, async () => { throw new Error('x'); }), 0);
  assert.equal(await storeCache({}, [{ fingerprint: 'fp', result: {} }], HASH, async () => ({ ok: true })), 0);
});

test('purgeCache: cutoff 이전 행 DELETE, 실패는 무시', async () => {
  let method; let url;
  const fetchImpl = async (u, opts) => { url = u; method = opts.method; return { ok: true }; };
  await purgeCache(CFG, fetchImpl, Date.parse('2026-07-22T00:00:00Z'));
  assert.equal(method, 'DELETE');
  assert.match(url, /created_at=lt\./);
  assert.match(decodeURIComponent(url), /2026-04-23/); // 90일 전
  assert.equal(await purgeCache(CFG, async () => { throw new Error('x'); }), 0);
});

test('lookupCache 이월: 현재 해시 행이 없으면 이전 해시의 최신 판정을 쓰고 carriedFromHash로 표시', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      // created_at desc 순서(최신 먼저)
      { fingerprint: 'old-only', classifier_hash: 'prev-2', alert: false, category: '정상댓글', reason: '', priority: 'normal', created_at: '2026-10-05' },
      { fingerprint: 'old-only', classifier_hash: 'prev-1', alert: true, category: '제품 불만', reason: 'x', priority: 'normal', created_at: '2026-09-28' },
      { fingerprint: 'both', classifier_hash: 'prev-2', alert: true, category: '광고/바이럴 의심', reason: 'y', priority: 'normal', created_at: '2026-10-05' },
      { fingerprint: 'both', classifier_hash: HASH, alert: false, category: '정상댓글', reason: '', priority: 'normal', created_at: '2026-09-01' },
    ],
  });
  const hits = await lookupCache(CFG, [{ index: 0, fingerprint: 'old-only' }, { index: 1, fingerprint: 'both' }], HASH, fetchImpl);
  assert.deepEqual(hits.get(0), { alert: false, category: '정상댓글', reason: '', priority: 'normal', carriedFromHash: 'prev-2' }, '가장 최근 이전 판정 유지');
  assert.deepEqual(hits.get(1), { alert: false, category: '정상댓글', reason: '', priority: 'normal' }, '현재 해시 행이 있으면 그게 우선');
});

test('lookupCache 이월 끄기(classificationCacheCarryForward=false)면 예전처럼 현재 해시만', async () => {
  let seenUrl = '';
  const fetchImpl = async (url) => { seenUrl = url; return { ok: true, json: async () => [] }; };
  await lookupCache({ ...CFG, classificationCacheCarryForward: false }, [{ index: 0, fingerprint: 'fp' }], HASH, fetchImpl);
  assert.match(seenUrl, /classifier_hash=eq\./);
});
