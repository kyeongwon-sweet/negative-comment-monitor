// 크봉(크런치봉봉) 판정 단일 정본. 2026-11-25 사용자 지정:
// '크봉'·'BB바'·'BB말'·'BB초'·'봉봉'·'크런치봉봉'이 들어 있으면 다른 신호와 무관하게 무조건 크봉(상품코드 'BB').
// 상품명·소재명·캠페인명·광고명·영상 제목/설명·게시물 캡션 어디에 있어도 같다.
export const KBONG_PRODUCT_CODE = 'BB';
export const KBONG_RE = /크봉|봉봉|bb(?:바|말|초)/i;

export function isKbongText(...texts) {
  return texts.some((text) => KBONG_RE.test(String(text || '')));
}

// 텍스트 중 하나라도 크봉이면 'BB', 아니면 원래 상품명 그대로.
export function kbongProductName(productName, ...texts) {
  return isKbongText(productName, ...texts) ? KBONG_PRODUCT_CODE : productName;
}
