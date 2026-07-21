import { DISCOVERY_KEYWORDS, ENTITY_KEYWORDS, PROFANITY_KEYWORDS } from './keywords.js';

export function normalizeKoreanText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._\-~!?,:;()[\]{}'"`]+/g, '');
}

function findMatches(text, keywords) {
  const normalized = normalizeKoreanText(text);
  const seen = new Set();
  return keywords.filter((keyword) => {
    const normalizedKeyword = normalizeKoreanText(keyword);
    if (seen.has(normalizedKeyword) || !normalized.includes(normalizedKeyword)) return false;
    seen.add(normalizedKeyword);
    return true;
  });
}

function flattenGroups(groups) {
  return Object.values(groups).flat();
}

const POSITIVE_CONTEXT = [
  '맛있', '존맛', '사먹고싶', '사고싶', '먹고싶', '먹어보고싶', '좋아', '좋음', '최고',
  '추천', '기대', '대박', '인정', '궁금', '주문하고싶', '구매하고싶',
];

const HARD_DISSATISFACTION = [
  '비추천', '비추', '맛없', '노맛', '실망', '최악', '돈아깝', '돈 아깝', '역겨',
  '기대이하', '먹기싫', '환불', '사지마', '사지 마', '거르세요',
];

function hasPositiveContext(text) {
  return findMatches(text, POSITIVE_CONTEXT).length > 0;
}

export function findEntityContext(comment, target = {}) {
  const commentText = String(comment?.text || comment || '');
  const postContext = [
    target.productName,
    target.projectName,
    target.caption,
    target.postTitle,
    target.brandName,
  ].filter(Boolean).join(' ');
  const allEntities = flattenGroups(ENTITY_KEYWORDS);
  const commentMatches = findMatches(commentText, allEntities);
  const postMatches = findMatches(postContext, allEntities);
  return {
    matched: commentMatches.length > 0 || postMatches.length > 0,
    commentMatches,
    postMatches,
  };
}

export function classifyNegativeComment(comment, target = {}) {
  const text = String(comment?.text || comment || '').trim();
  const entity = findEntityContext(comment, target);
  if (!text || !entity.matched) {
    return { alert: false, category: '관련없음', priority: 'none', entity, matches: [] };
  }

  const profanity = findMatches(text, PROFANITY_KEYWORDS);
  const marketing = findMatches(text, DISCOVERY_KEYWORDS.marketingDistrust);
  const dissatisfaction = findMatches(text, DISCOVERY_KEYWORDS.dissatisfaction);
  const sales = findMatches(text, DISCOVERY_KEYWORDS.salesComplaint);
  const competitor = findMatches(text, DISCOVERY_KEYWORDS.competitorMention || []);
  const authenticity = findMatches(text, DISCOVERY_KEYWORDS.authenticityDoubt || []);
  const matches = [...new Set([...profanity, ...marketing, ...dissatisfaction, ...sales, ...competitor, ...authenticity])];
  if (!matches.length) {
    return { alert: false, category: '정상댓글', priority: 'none', entity, matches: [] };
  }

  // 광고·바이럴·별로·경쟁제품·성분의혹은 문맥에 따라 긍정 문장에도 등장한다
  // (예: "편의점에 없던데 먹고싶어요"의 '없던데'). 명백한 욕설/제품 불만/판매 문제만
  // 즉시 탐지하고, 그 외에는 긍정 의도가 함께 있으면 키워드 오탐으로 보고 정상 처리한다.
  // Anthropic이 설정된 환경에서는 run.js의 의미 분류(LLM)가 이 규칙보다 우선한다.
  const hardDissatisfaction = findMatches(text, HARD_DISSATISFACTION);
  const immediateNegative = profanity.length || hardDissatisfaction.length || sales.length;
  if (!immediateNegative && hasPositiveContext(text)) {
    return {
      alert: false,
      category: '정상댓글',
      priority: 'none',
      entity,
      matches,
      reason: '긍정 문맥 예외',
    };
  }

  let category = '부정언급';
  if (profanity.length) category = '욕설/비속어';
  else if (authenticity.length) category = '성분/진위 의혹';
  else if (sales.length) category = '판매방식 불만';
  else if (dissatisfaction.length) category = '제품 불만';
  else if (competitor.length) category = '경쟁품 비교';
  else if (marketing.length) category = '광고/바이럴 의심';

  return {
    alert: true,
    category,
    priority: profanity.length ? 'high' : 'normal',
    entity,
    matches,
    reason: `${category}: ${matches.join(', ')}`,
  };
}

export function needsContextualReview(comment, target = {}) {
  const text = String(comment?.text || comment || '').trim();
  const entity = findEntityContext(comment, target);
  if (!text || !entity.matched) return false;
  const profanity = findMatches(text, PROFANITY_KEYWORDS);
  const hardDissatisfaction = findMatches(text, HARD_DISSATISFACTION);
  const sales = findMatches(text, DISCOVERY_KEYWORDS.salesComplaint);
  const authenticity = findMatches(text, DISCOVERY_KEYWORDS.authenticityDoubt || []);
  if (profanity.length || hardDissatisfaction.length || sales.length) return false;
  const marketing = findMatches(text, DISCOVERY_KEYWORDS.marketingDistrust);
  const dissatisfaction = findMatches(text, DISCOVERY_KEYWORDS.dissatisfaction);
  const competitor = findMatches(text, DISCOVERY_KEYWORDS.competitorMention || []);
  // 성분/진위 의혹도 문맥 판단 대상 → LLM으로 보내 긍정/부정 가린다(즉시 하드판정 금지).
  return marketing.length > 0 || dissatisfaction.length > 0 || competitor.length > 0 || authenticity.length > 0;
}
