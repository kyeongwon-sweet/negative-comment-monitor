import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// classifier_hash = 분류에 영향을 주는 소스 파일들의 내용 해시 + 모델 ID.
// keywords.js / classify.js / llm.js(LLM 프롬프트·출력 스키마 포함) 중 하나라도 바뀌면
// 해시가 달라져 기존 캐시(정상 판정 포함)가 자동 무효화된다. 수동 버전 번호를 쓰지 않는다.
const SOURCE_FILES = ['keywords.js', 'classify.js', 'llm.js'];

// 줄바꿈(LF/CRLF) 차이만으로 캐시가 갈리지 않도록 정규화 — 로직이 같으면 해시도 같다.
function normalize(text) {
  return String(text).replace(/\r\n/g, '\n');
}

let cachedSourceHash = null;
function sourceHash() {
  if (cachedSourceHash) return cachedSourceHash;
  const h = createHash('sha256');
  for (const name of SOURCE_FILES) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
    h.update(name).update('\0').update(normalize(readFileSync(path, 'utf8'))).update('\0');
  }
  cachedSourceHash = h.digest('hex');
  return cachedSourceHash;
}

// config.anthropicModel까지 포함(모델 교체도 재분류를 유발). 파일 읽기 실패 시 throw →
// 호출부(cache.js)가 잡아서 캐시 없이 실시간 분류로 폴백한다.
export function computeClassifierHash(config = {}) {
  const model = config.anthropicModel || 'claude-haiku-4-5-20251001';
  return createHash('sha256').update(sourceHash()).update('|model:').update(model).digest('hex');
}
