import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTargets } from '../src/gas.js';

const CFG = { gasWebAppUrl: 'https://script.google.com/x/exec', gasVerifyToken: 'tok', targetBatchSize: 300 };

test('fetchTargets: 정상 JSON이면 targets 반환', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, result: { targets: [{ url: 'u1' }] } }) });
  const out = await fetchTargets(CFG, fetchImpl);
  assert.deepEqual(out, [{ url: 'u1' }]);
});

test('fetchTargets: GAS가 HTML 오류 페이지 주면 원인 담긴 명확한 오류로 throw(#7 시트 헤더 등)', async () => {
  const html = '<!DOCTYPE html><html><head><title>오류</title></head><body><div class="errorMessage">Error: 필수 헤더 누락: 채널명 (\'Code\' 파일, 2054행)</div></body></html>';
  const fetchImpl = async () => ({ ok: true, text: async () => html });
  await assert.rejects(
    () => fetchTargets(CFG, fetchImpl),
    (e) => /오류 페이지 반환/.test(e.message) && /필수 헤더 누락: 채널명/.test(e.message),
  );
});

test('fetchTargets: HTTP 오류는 상태코드 포함 throw', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => fetchTargets(CFG, fetchImpl), /GAS HTTP 500/);
});
