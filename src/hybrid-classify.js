import { classifyNegativeComment, needsContextualReview } from './classify.js';
import { classifyCommentsLLM } from './llm.js';

export async function classifyCommentsHybrid(comments, target, config, llmClassifier = classifyCommentsLLM) {
  const keywordResults = comments.map((comment) => classifyNegativeComment(comment, target));
  const reviewIndexes = [];
  for (let index = 0; index < comments.length; index += 1) {
    if (needsContextualReview(comments[index], target)) reviewIndexes.push(index);
  }
  if (!reviewIndexes.length || !config.anthropicKey) {
    return keywordResults.map((risk) => ({ ...risk, engine: 'keyword' }));
  }
  const reviewComments = reviewIndexes.map((index) => comments[index]);
  const reviewed = await llmClassifier(reviewComments, config);
  if (!reviewed) return keywordResults.map((risk) => ({ ...risk, engine: 'keyword' }));
  const out = keywordResults.map((risk) => ({ ...risk, engine: 'keyword' }));
  for (let position = 0; position < reviewIndexes.length; position += 1) {
    const index = reviewIndexes[position];
    if (reviewed[position]) out[index] = { ...reviewed[position], entity: { matched: true }, engine: 'llm' };
  }
  return out;
}
