import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 11-04: YouTube quota 소진 → 위성 자동숨김의 소유자 토큰 검증 11/11 실패가 run.js 밖으로 던져져
// 핵심 수집 실행이 '실행 실패'로 끝났다(헬스·비용 기록 누락). 보조 단계는 반드시 try로 감싸 기록만 한다.
test('run.js: 위성 YouTube 자동숨김 실패가 핵심 실행을 실패시키지 않는다(try 안에서 호출 + 보조 헬스 기록)', () => {
  const src = readFileSync(new URL('../src/run.js', import.meta.url), 'utf8');
  const call = src.indexOf('await autoHideOrganicSatelliteYouTube(');
  assert.ok(call > 0, '호출 위치');
  const before = src.slice(Math.max(0, call - 400), call);
  assert.match(before, /try \{\s*summary\.youtubeSatelliteModeration = $/, '호출이 try 블록 첫 문장이어야 한다');
  const after = src.slice(call, call + 1500);
  assert.match(after, /catch \(error\)/);
  assert.match(after, /AUXILIARY_HEALTH_KEY: 'youtube_satellite_auto_hide'/);
});
