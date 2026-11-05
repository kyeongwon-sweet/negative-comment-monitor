import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { loadOwnerVideoStates } from '../src/youtube-owner-channel.js';

// PostgREST는 limit을 크게 줘도 서버 상한(1,000행)에서 조용히 자른다(11-05: 상태표 1,758행 중 1,000행만 읽혀
// 758개 영상이 매 회차 첫 스캔처럼 재스캔 → YouTube quota 소모). 큰 limit 한 방 조회를 금지하고 페이지를 넘긴다.
test('src에 서버 상한을 넘는 한 방 조회(limit>1000)가 없다', () => {
  const dir = new URL('../src/', import.meta.url);
  const offenders = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(name, dir), 'utf8');
    for (const m of src.matchAll(/[?&]limit=(\d{4,})/g)) if (Number(m[1]) > 1000) offenders.push(`${name}: limit=${m[1]}`);
  }
  assert.deepEqual(offenders, []);
});

test('소유 영상 상태표는 1,000행을 넘어도 끝까지 페이지를 넘겨 읽는다', async () => {
  const all = Array.from({ length: 1758 }, (_, i) => ({ channel_id: 'UCa', video_id: `v${String(i).padStart(4, '0')}` }));
  const urls = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    urls.push(u.search);
    const offset = Number(u.searchParams.get('offset') || 0);
    const limit = Math.min(1000, Number(u.searchParams.get('limit') || 1000));
    return { ok: true, status: 200, json: async () => all.slice(offset, offset + limit) };
  };
  const states = await loadOwnerVideoStates({ supabaseUrl: 'https://db.test', supabaseKey: 'k' }, fetchImpl);
  assert.equal(states.size, 1758);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((s) => s.includes('order=channel_id.asc,video_id.asc')), '고유 정렬키 필수(페이지 경계 중복·누락 방지)');
});
