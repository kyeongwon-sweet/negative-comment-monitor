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
