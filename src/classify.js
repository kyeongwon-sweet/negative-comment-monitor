import {
  DISCOVERY_KEYWORDS,
  ENTITY_KEYWORDS,
  OWNED_BRAND_HOSTILITY_KEYWORDS,
  PROFANITY_KEYWORDS,
} from './keywords.js';

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
  '먹어볼게', '먹어봐야', '사먹어볼', '꼭먹', '응원', '잘찍', '잘 찍',
  '광고를하시다니', '광고를 하시다니',
];

const HARD_DISSATISFACTION = [
  '비추천', '비추', '맛없', '노맛', '실망', '최악', '돈아깝', '돈 아깝', '역겨',
  '기대이하', '먹기싫', '환불', '사지마', '사지 마', '거르세요',
];

// LLM이 꺼져도 놓치면 안 되는 명시적 광고 기만 주장만 분리한다.
// 단순한 '광고/바이럴/광고 같음'은 문맥 의존 신호라 이 목록에 넣지 않는다.
const HARD_MARKETING_DISTRUST = [
  '뒷광고', '허위', '허위광고', '허위 광고', '과대광고', '과대 광고',
  '과장광고', '과장 광고', '조작', '주작', '사기', '돈받고', '돈 받고',
  '광고 너무 심', '바이럴 너무 심', '광고 지겹', '광고 그만', '광고 도배',
];

const PRODUCT_COMPLAINT_CONTEXT = [
  '라라스윗', '라라스위트', '쫀득바', '아이스크림', '제품',
  '이거', '이건', '저거', '저건', '맛', '식감', '가격', '품질', '양', '성분',
];

function hasProductComplaintContext(text, entity) {
  return entity.commentMatches.length > 0
    || findMatches(text, PRODUCT_COMPLAINT_CONTEXT).length > 0;
}

function hasExplicitCompetitorDegradation(text, competitorMatches) {
  if (!competitorMatches.length) return false;
  const normalized = normalizeKoreanText(text);
  return [
    /(?:쫀득바|라라스윗|라라스위트|이거|저거).*(?:살바엔|먹을바엔|고를바엔)/,
    /(?:쫀득바|라라스윗|라라스위트).*(?:보다).*(?:더낫|낫다|더좋|더맛있)/,
    /(?:더낫|낫다|더좋|더맛있).*(?:쫀득바|라라스윗|라라스위트)/,
    /(?:살바엔|먹을바엔|고를바엔).*(?:메로나|메론바|비비빅|스크류바|죠스바|수박바|더위사냥|붕어싸만코|설레임|월드콘)/,
    /(?:메로나|메론바|비비빅|스크류바|죠스바|수박바|더위사냥|붕어싸만코|설레임|월드콘).*(?:가|이)?(?:훨씬|더)?(?:낫다|나음|좋다|맛있다)/,
  ].some((pattern) => pattern.test(normalized));
}

function hasExplicitAuthenticityAttack(text, authenticityMatches) {
  if (!authenticityMatches.length) return false;
  const normalized = normalizeKoreanText(text);
  return /(?:가짜|짝퉁|카피|표절)/.test(normalized)
    || /성분표.*(?:없|안들|안넣)/.test(normalized);
}

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
  const ownedBrandHostility = target?.ownedChannelBrandHostilityScope === true
    ? findMatches(text, OWNED_BRAND_HOSTILITY_KEYWORDS)
    : [];
  const matches = [...new Set([
    ...profanity, ...marketing, ...dissatisfaction, ...sales, ...competitor, ...authenticity,
    ...ownedBrandHostility,
  ])];
  if (!matches.length) {
    return { alert: false, category: '정상댓글', priority: 'none', entity, matches: [] };
  }

  const hardDissatisfaction = findMatches(text, HARD_DISSATISFACTION);
  const hardMarketing = findMatches(text, HARD_MARKETING_DISTRUST);
  const positiveContext = hasPositiveContext(text);
  const productComplaintContext = hasProductComplaintContext(text, entity);
  const explicitProductDissatisfaction = dissatisfaction.length > 0 && productComplaintContext;
  const productTargetedProfanity = profanity.length > 0 && productComplaintContext;
  const explicitCompetitorDegradation = hasExplicitCompetitorDegradation(text, competitor);
  const explicitAuthenticityAttack = hasExplicitAuthenticityAttack(text, authenticity);

  // #7 경쟁품 단순 언급·사실 정정·취향 표현은 그 자체로 부정이 아니다. 라라스윗/쫀득바를 명시적으로
  // 깎아내리는지는 LLM이 문맥으로 판단한다(needsContextualReview=true). 경쟁품 외 다른 부정 신호가
  // 없으면 키워드 단계에서는 정상 처리해, LLM 미설정/실패 시에도 단순 언급을 오탐하지 않는다.
  // (명백 불만 HARD·판매 문제가 함께 있으면 아래 즉시탐지로 넘어간다.)
  const hasNonCompetitorSignal = profanity.length || marketing.length || dissatisfaction.length
    || sales.length || authenticity.length || hardDissatisfaction.length;
  if (competitor.length && !hasNonCompetitorSignal) {
    if (explicitCompetitorDegradation) {
      return {
        alert: true,
        category: '경쟁품 비교',
        priority: 'normal',
        entity,
        matches,
        reason: `경쟁품 비교: ${matches.join(', ')}`,
      };
    }
    return { alert: false, category: '정상댓글', priority: 'none', entity, matches, reason: '경쟁품 단순 언급(문맥 검토 대상)' };
  }

  // 광고·바이럴·별로·경쟁제품·성분의혹·욕설은 문맥에 따라 긍정 문장이나 제품 무관에도 등장한다
  // (예: '없던데'는 가용성 긍정, '꺼져/닥쳐/새끼' 등 욕설은 제품이 아니라 댓글러끼리 싸움일 수 있음).
  // 명백한 제품 불만(HARD)/판매 문제만 즉시 탐지하고, 나머지는 긍정 문맥이면 정상 처리 + LLM 검토로 넘긴다.
  // Anthropic이 설정된 환경에서는 run.js의 의미 분류(LLM)가 이 규칙보다 우선한다.
  // 브랜드 적대 확장은 소유채널에서만 명백 표현을 즉시 잡는 LLM 장애용 안전망이다.
  const immediateNegative = hardDissatisfaction.length
    || hardMarketing.length
    || sales.length
    || ownedBrandHostility.length
    || explicitCompetitorDegradation
    || explicitAuthenticityAttack
    || (explicitProductDissatisfaction && !positiveContext)
    || (productTargetedProfanity && !positiveContext);
  if (!immediateNegative && positiveContext) {
    return {
      alert: false,
      category: '정상댓글',
      priority: 'none',
      entity,
      matches,
      reason: '긍정 문맥 예외',
    };
  }

  // LLM 장애 시 문맥 의존 신호를 알림으로 승격하지 않는다. '광고'라는 단어, 경쟁품 단순 언급,
  // 제품 무관 욕설·잡담, 애매한 성분/진위 표현은 LLM이 복구되면 재검토하되 폴백에서는 정상이다.
  if (!immediateNegative) {
    return {
      alert: false,
      category: '정상댓글',
      priority: 'none',
      entity,
      matches,
      reason: '문맥 의존 신호(LLM 검토 대상)',
    };
  }

  let category = '부정언급';
  if (ownedBrandHostility.length) category = '브랜드 적대/조롱';
  else if (profanity.length) category = '욕설/비속어';
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
  if (hardDissatisfaction.length || sales.length) return false;
  const marketing = findMatches(text, DISCOVERY_KEYWORDS.marketingDistrust);
  const dissatisfaction = findMatches(text, DISCOVERY_KEYWORDS.dissatisfaction);
  const competitor = findMatches(text, DISCOVERY_KEYWORDS.competitorMention || []);
  // 성분/진위 의혹·욕설도 문맥 판단 대상 → LLM으로 보내 "제품 겨냥인지" 가린다(즉시 하드판정 금지).
  // 욕설은 특히 댓글러끼리 싸움('꺼져/닥쳐')이 협찬글에서 오탐되므로 LLM이 제품 겨냥 여부를 판정.
  return marketing.length > 0 || dissatisfaction.length > 0 || competitor.length > 0 || authenticity.length > 0 || profanity.length > 0;
}
