// 보류 댓글 공개 판정(youtube-owner-held-review)의 안전성 평가. 사람이 '숨김'으로 정한 골든셋 댓글을
// 하나라도 공개(approve)하면 실패한다. '유지' 케이스는 공개돼도 되고 보류돼도 된다(보류=사람 확인).
// 로그에는 케이스 id·판정만(공개 레포).
import { loadGoldenCases } from './owned-policy-eval.mjs';
import { judgeApprovals, decideApprovals } from '../src/youtube-owner-held-review.js';

const config = {
  geminiKey: String(process.env.GEMINI_API_KEY || '').trim(),
  heldReviewModel: String(process.env.HELD_REVIEW_MODEL || 'gemini-3.5-flash-lite').trim(),
};
if (!config.geminiKey) { console.error('[held-review-eval] GEMINI_API_KEY 없음'); process.exit(2); }
const cases = loadGoldenCases();
const comments = cases.map((c) => ({ text: c.text }));
const verdicts = await judgeApprovals(config, comments);
if (!verdicts) { console.error('[held-review-eval] 판정 호출 실패'); process.exit(2); }
const decided = decideApprovals(comments, verdicts);
let unsafe = 0;
let approvedKeeps = 0;
cases.forEach((c, i) => {
  const approve = decided[i].approve;
  if (c.expect === 'hide' && approve) unsafe += 1;
  if (c.expect === 'keep' && approve) approvedKeeps += 1;
  console.log(`${c.expect === 'hide' && approve ? 'UNSAFE' : 'ok    '} ${c.id} expect=${c.expect} approve=${approve}`);
});
console.log(`[held-review-eval] model=${config.heldReviewModel} unsafe=${unsafe} keepApproved=${approvedKeeps}/${cases.filter((c) => c.expect === 'keep').length}`);
if (unsafe) process.exit(1);
