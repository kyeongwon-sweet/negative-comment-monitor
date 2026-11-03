import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// YouTube Data API가 실제로 거부하는 파라미터 조합을 소스 단계에서 막는다.
// 11-03: held-review가 comments.list에 id+maxResults를 함께 보내 400 unexpectedParameter →
// 공개 기록 누락 → 보류 누락 경보 오탐 2회. 테스트 목이 이 조합을 받아줘서 운영 전에 못 잡았다.
// (videos.list·channels.list는 id+maxResults를 허용 — 실측. comments.list만 거부.)
const SRC = new URL('../src/', import.meta.url);

function commentsListCalls(source) {
  const calls = [];
  // ① URL 빌더: new URL(`${...}/comments`) 뒤 searchParams.set(...) 묶음(다음 fetch/await 전까지)
  for (const match of source.matchAll(/\/comments`\)/g)) {
    const rest = source.slice(match.index);
    const end = rest.search(/\bawait\b|fetchImpl\(|googleJson\(|googleGet\(/);
    calls.push(rest.slice(0, end > 0 ? end : 400));
  }
  // ② 객체 파라미터: youtubeJson(config, 'comments', { ... }) / googleGet(config, 'comments', { ... })
  for (const match of source.matchAll(/['"]comments['"]\s*,\s*\{/g)) {
    const rest = source.slice(match.index);
    calls.push(rest.slice(0, rest.indexOf('}') + 1));
  }
  return calls;
}

test('comments.list 호출은 id와 maxResults를 함께 보내지 않는다(YouTube 400 unexpectedParameter)', () => {
  let checked = 0;
  for (const name of readdirSync(SRC).filter((file) => file.endsWith('.js'))) {
    const source = readFileSync(new URL(name, SRC), 'utf8');
    for (const call of commentsListCalls(source)) {
      checked += 1;
      const hasId = /searchParams\.set\(\s*['"]id['"]/.test(call) || /[{,]\s*id\s*:/.test(call);
      const hasMax = /maxResults/.test(call);
      assert.ok(!(hasId && hasMax), `${name}: comments.list에 id와 maxResults를 함께 보냄\n${call.slice(0, 300)}`);
    }
  }
  assert.ok(checked >= 5, `comments.list 호출을 찾지 못함(검사 대상 ${checked}) — 패턴이 깨졌는지 확인`);
});

test('계약 검사기는 11-03 버그 형태를 실제로 잡는다', () => {
  const buggy = "const url = new URL(`${config.youtubeApiBase}/comments`);\n url.searchParams.set('part', 'snippet');\n url.searchParams.set('id', ids);\n url.searchParams.set('maxResults', '50');\n const payload = await googleGet(url);";
  const calls = commentsListCalls(buggy);
  assert.equal(calls.length, 1);
  assert.ok(/searchParams\.set\(\s*['"]id['"]/.test(calls[0]) && /maxResults/.test(calls[0]));
});
