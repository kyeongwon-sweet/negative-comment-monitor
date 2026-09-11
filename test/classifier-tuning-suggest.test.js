import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadLabeledCorpus,
  buildTuningPrompt,
  requestTuningSuggestion,
  buildTuningSlackText,
  runClassifierTuningSuggest,
} from '../src/classifier-tuning-suggest.js';

const dbRows = [
  { review_decision: 'false_positive', category: '브랜드 적대/조롱', comment_text: '재력보소 이재용 저리가라', channel_category: '위성채널' },
  { review_decision: 'ignore', category: '욕설/비속어', comment_text: '개웃기네 ㅋㅋ', channel_category: '위성채널' },
  { review_decision: 'unhide', category: '경쟁품 비교', comment_text: '걍 메로나임', channel_category: '협찬' },
  { review_decision: 'hidden', category: '제품 불만', comment_text: '맛없어서 사지마세요', channel_category: '인지 광고' },
  { review_decision: 'hide', category: '브랜드 적대/조롱', comment_text: '라라스윗 극혐 불매한다', channel_category: '소유 YouTube' },
];

const baseConfig = {
  supabaseUrl: 'https://db.test', supabaseKey: 'k',
  slackBotToken: 't', slackChannelId: 'C1',
  geminiKey: 'g', geminiModel: 'gemini-x', anthropicKey: 'a', anthropicModel: 'claude-x',
  lookbackDays: 30, maxExamplesPerLabel: 40, minNormal: 2, notifySlack: true, mention: 'U_OWNER',
};

test('loadLabeledCorpus: in 필터로 조회하고 정상/부정으로 분리한다', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return { ok: true, json: async () => (urls.length === 1 ? dbRows : []) }; };
  const corpus = await loadLabeledCorpus(baseConfig, '2026-08-01T00:00:00Z', fetchImpl);
  assert.equal(corpus.normal.length, 3); // false_positive, ignore, unhide
  assert.equal(corpus.negative.length, 2); // hidden, hide
  assert.match(urls[0], /review_decision=in\.\(false_positive,ignore,unhide,hidden,hide,complete\)/);
});

test('buildTuningPrompt: 정상·부정 예시와 스코프 규칙·4개 출력항목을 포함한다', () => {
  const corpus = { normal: dbRows.slice(0, 3), negative: dbRows.slice(3) };
  const prompt = buildTuningPrompt(corpus);
  assert.match(prompt, /\[정상\]/);
  assert.match(prompt, /\[부정\]/);
  assert.match(prompt, /재력보소 이재용 저리가라/);
  assert.match(prompt, /라라스윗 극혐 불매한다/);
  assert.match(prompt, /인지광고/);
  assert.match(prompt, /과억제 위험/);
});

test('requestTuningSuggestion: Gemini 성공, 실패 시 Anthropic 폴백', async () => {
  const geminiOk = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '제안A' }] } }] }) });
  assert.deepEqual(await requestTuningSuggestion(baseConfig, 'p', geminiOk), { provider: 'gemini', text: '제안A' });

  const fetchImpl = async (url) => {
    if (String(url).includes('generativelanguage')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ content: [{ text: '제안B' }] }) };
  };
  assert.deepEqual(await requestTuningSuggestion(baseConfig, 'p', fetchImpl), { provider: 'anthropic', text: '제안B' });

  const bothFail = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await requestTuningSuggestion(baseConfig, 'p', bothFail), null);
});

test('buildTuningSlackText: 초안 성격·건수·멘션·승인 안내를 포함한다', () => {
  const text = buildTuningSlackText('여기 제안 본문', { normalCount: 12, negativeCount: 8, lookbackDays: 30, mention: 'U_OWNER', provider: 'gemini' });
  assert.match(text, /튜닝 제안/);
  assert.match(text, /<@U_OWNER>/);
  assert.match(text, /정상\(오탐\) 12건 · 부정\(숨김·차단\) 8건/);
  assert.match(text, /자동 반영 안 함/);
  assert.match(text, /여기 제안 본문/);
});

test('runClassifierTuningSuggest: 정상 라벨 부족이면 조용히, 충분하면 초안 발송', async () => {
  const makeFetch = (posts, rows) => async (url, init) => {
    if (String(url).includes('/negative_comment_alerts')) return { ok: true, json: async () => rows };
    if (String(url).includes('generativelanguage')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '개선안 초안' }] } }] }) };
    posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  // 정상 부족(minNormal 5 > 3)
  const quiet = await runClassifierTuningSuggest({ ...baseConfig, minNormal: 5 }, makeFetch([], dbRows));
  assert.equal(quiet.skipped, 'insufficient-labels');
  assert.equal(quiet.posted, false);
  // 충분(minNormal 2 <= 3) → 발송
  const posts = [];
  const loud = await runClassifierTuningSuggest({ ...baseConfig, minNormal: 2 }, makeFetch(posts, dbRows));
  assert.equal(loud.posted, true);
  assert.equal(loud.provider, 'gemini');
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /개선안 초안/);
});
