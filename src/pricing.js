// Anthropic 토큰 단가(핵심 분류 로직과 분리 — 단가 변경 시 이 파일만 수정).
// 단위: USD per 1,000,000 tokens. 값 출처: Anthropic 공개 요금(Haiku 4.5 입력 $1 / 출력 $5,
// 프롬프트 캐시 읽기 $0.10 / 캐시 생성 $1.25). 모델 추가 시 아래 표에 항목만 넣으면 된다.
export const TOKEN_PRICES_USD = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 },
};

// 표에 없는 모델은 Haiku 4.5 단가로 근사(비용은 참고용 추정치라 과금 정확도보다 중단 방지 우선).
const DEFAULT_PRICE = { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 };

// usage: { inputTokens, outputTokens, cacheRead, cacheCreate } (누락 필드는 0으로 간주).
export function estimateUsd(usage = {}, model = 'claude-haiku-4-5-20251001') {
  const p = TOKEN_PRICES_USD[model] || DEFAULT_PRICE;
  const inTok = usage.inputTokens || 0;
  const outTok = usage.outputTokens || 0;
  const cacheRead = usage.cacheRead || 0;
  const cacheCreate = usage.cacheCreate || 0;
  return (inTok * p.input + outTok * p.output + cacheRead * p.cacheRead + cacheCreate * p.cacheCreate) / 1e6;
}
