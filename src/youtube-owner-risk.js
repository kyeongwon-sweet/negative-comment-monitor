import { classifyNegativeComment, normalizeKoreanText } from './classify.js';

const EXPLICIT_BRAND_OR_PRODUCT_TARGET = [
  '라라스윗', '라라스위트', '쫀득바', '아이스크림', '제품', '브랜드', '회사',
  '이거', '이건', '저거', '저건', '맛', '식감', '성분', '광고',
].map(normalizeKoreanText);

const STRONG_EXPLICIT_BRAND_OR_PRODUCT_TARGET = [
  '라라스윗', '라라스위트', '쫀득바', '아이스크림', '제품', '브랜드', '회사',
].map(normalizeKoreanText);

// 소유 엔터·가십 채널의 반응성 댓글을 LLM 톤만으로 운영 조치에 반영하지 않는다.
// 라이브 키워드 안전망도 동의하는 명백 부정, 또는 댓글 본문이 브랜드/제품을 직접
// 겨냥한 브랜드 적대만 고신뢰로 인정한다. 커버리지 감사와 과부하 계산이 이 함수를 공유한다.
export function isHighConfidenceOwnerRisk(target, comment, risk) {
  if (risk?.alert !== true) return false;
  const strict = classifyNegativeComment(comment, {
    ...(target || {}),
    ownedChannelBrandHostilityScope: false,
    fullContextReview: false,
  });
  if (strict.alert === true) return true;
  if (String(risk.category || '') !== '브랜드 적대/조롱') return false;

  const normalized = normalizeKoreanText(comment?.text || comment || '');
  if (!EXPLICIT_BRAND_OR_PRODUCT_TARGET.some((keyword) => normalized.includes(keyword))) return false;
  // 브랜드·제품이 댓글 본문에 직접 명시되고 LLM도 브랜드 적대로 분류했다면,
  // 신조어·반어처럼 키워드 사전에 없는 공격도 놓치지 않는다.
  if (STRONG_EXPLICIT_BRAND_OR_PRODUCT_TARGET.some((keyword) => normalized.includes(keyword))) return true;
  return classifyNegativeComment(comment, {
    ...(target || {}),
    ownedChannelBrandHostilityScope: true,
    fullContextReview: false,
  }).alert === true;
}
