import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeFalsePositiveCorpus,
  buildFalsePositiveAuditText,
  loadFalsePositiveCorpus,
  runFalsePositiveAudit,
} from '../src/false-positive-audit.js';

const rows = [
  { platform: 'youtube', category: '브랜드 적대/조롱', comment_text: '재력보소 이재용 저리가라', false_positive_reason: 'unrelated', product_name: 'JD' },
  { platform: 'youtube', category: '브랜드 적대/조롱', comment_text: '내가 너의 이상형이다', false_positive_reason: 'joke_meme', product_name: 'JD' },
  { platform: 'instagram', category: '욕설/비속어', comment_text: '개웃기네 ㅋㅋ', false_positive_reason: 'insult_other', product_name: 'P' },
  { platform: 'tiktok', category: '경쟁품 비교', comment_text: '걍 메로나임', false_positive_reason: 'competitor_neutral', product_name: '' },
  { platform: 'youtube', category: '브랜드 적대/조롱', comment_text: '슈기님은 신전이 레전드', false_positive_reason: '', product_name: 'JD' },
];

test('summarize: 카테고리·사유·플랫폼 집계와 카테고리별 예시 캡을 만든다', () => {
  const s = summarizeFalsePositiveCorpus(rows, { maxSamplesPerCategory: 2 });
  assert.equal(s.total, 5);
  assert.deepEqual(s.byCategory[0], ['브랜드 적대/조롱', 3]);
  // 오탐 사유 라벨 매핑 + 미기입 처리
  const reasonMap = Object.fromEntries(s.byReason);
  assert.equal(reasonMap['제품 무관'], 1);
  assert.equal(reasonMap['(미기입)'], 1);
  // 예시는 카테고리당 최대 2개
  assert.equal(s.samples['브랜드 적대/조롱'].length, 2);
});

test('buildText: 총계·카테고리·멘션을 포함하고 표본 0이면 빈 문자열', () => {
  const s = summarizeFalsePositiveCorpus(rows);
  const text = buildFalsePositiveAuditText(s, { lookbackDays: 7, mention: 'U_OWNER' });
  assert.match(text, /최근 7일/);
  assert.match(text, /\*5건\*/);
  assert.match(text, /<@U_OWNER>/);
  assert.match(text, /브랜드 적대\/조롱: 3/);
  assert.equal(buildFalsePositiveAuditText({ total: 0 }), '');
});

test('loadFalsePositiveCorpus: false_positive+ignore를 in 필터로 조회하고 페이지네이션한다', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => (urls.length === 1 ? rows : []) };
  };
  const out = await loadFalsePositiveCorpus({ supabaseUrl: 'https://db.test', supabaseKey: 'k' }, '2026-09-01T00:00:00Z', fetchImpl);
  assert.equal(out.length, 5);
  assert.match(urls[0], /review_decision=in\.\(false_positive,ignore\)/);
  assert.match(urls[0], /reviewed_at=gte\./);
});

test('runAudit: 임계 미만이면 조용히(발송 안 함), 임계 이상이면 채널에 리포트 발송', async () => {
  const base = {
    supabaseUrl: 'https://db.test', supabaseKey: 'k', slackBotToken: 't', slackChannelId: 'C1',
    lookbackDays: 7, maxSamplesPerCategory: 3, notifySlack: true, mention: 'U_OWNER',
  };
  const makeFetch = (posts) => async (url, init) => {
    if (String(url).includes('/negative_comment_alerts')) return { ok: true, json: async () => rows };
    posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  // 임계 미만(minCount 10 > 5) → 조용
  const quietPosts = [];
  const quiet = await runFalsePositiveAudit({ ...base, minCount: 10 }, makeFetch(quietPosts));
  assert.equal(quiet.belowThreshold, true);
  assert.equal(quiet.posted, false);
  assert.equal(quietPosts.length, 0);
  // 임계 이상(minCount 3 <= 5) → 발송
  const posts = [];
  const loud = await runFalsePositiveAudit({ ...base, minCount: 3 }, makeFetch(posts));
  assert.equal(loud.belowThreshold, false);
  assert.equal(loud.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C1');
  assert.match(posts[0].text, /분류기 오탐/);
});
