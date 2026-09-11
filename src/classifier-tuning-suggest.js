// 반자동 분류기 튜닝 제안. 사람이 남긴 판정 라벨([무시]=정상, [숨김/차단]=부정)을 LLM이
// 분석해 "과탐/미탐 경향 + src/llm.js 프롬프트 수정안 초안"을 만들어 Slack에 올린다.
// 자동 반영은 하지 않는다 — 사람이 초안을 보고 승인·수정해 llm.js에 반영하는 반자동 루프다.
// ⚠️ 이 봇의 최악 실패는 미탐(진짜 악플 놓침)이라, 제안엔 과억제 위험 경고를 함께 요구한다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 정상(오탐) = 사람이 부정 아니라고 되돌린 것. 부정(정탐) = 사람이 숨김/차단/완료로 확정한 것.
const NORMAL_DECISIONS = ['false_positive', 'ignore', 'unhide'];
const NEGATIVE_DECISIONS = ['hidden', 'hide', 'complete'];

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function required(env, name) {
  const value = clean(env[name]);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function loadClassifierTuningConfig(env = process.env) {
  return {
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackChannelId: clean(env.SLACK_CHANNEL_ID),
    geminiKey: clean(env.GEMINI_API_KEY),
    geminiModel: clean(env.GEMINI_MODEL) || 'gemini-3.1-flash-lite',
    anthropicKey: clean(env.ANTHROPIC_API_KEY),
    anthropicModel: clean(env.ANTHROPIC_MODEL) || 'claude-haiku-4-5-20251001',
    lookbackDays: positiveInt(env.CLASSIFIER_TUNING_LOOKBACK_DAYS, 30, 180),
    maxExamplesPerLabel: positiveInt(env.CLASSIFIER_TUNING_MAX_EXAMPLES, 40, 200),
    minNormal: positiveInt(env.CLASSIFIER_TUNING_MIN_NORMAL, 10, 100000),
    notifySlack: clean(env.CLASSIFIER_TUNING_NOTIFY_SLACK || 'true').toLowerCase() !== 'false',
    mention: clean(env.SLACK_ASSIGNEE_AWARENESS || env.SLACK_ASSIGNEE_OTHER || ''),
  };
}

function supabaseHeaders(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

// 라벨 코퍼스 로드: 정상(오탐)·부정(정탐) 각각. review.js 원칙대로 원문은 알림행에 이미 있으므로 읽는다.
export async function loadLabeledCorpus(config, sinceIso, fetchImpl = fetch) {
  const decisions = [...NORMAL_DECISIONS, ...NEGATIVE_DECISIONS];
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts`
      + '?select=review_decision,category,comment_text,reason,product_name,channel_category,source,reviewed_at'
      + `&review_decision=in.(${decisions.join(',')})`
      + `&reviewed_at=gte.${encodeURIComponent(sinceIso)}`
      + `&order=reviewed_at.desc&offset=${offset}&limit=1000`;
    const response = await fetchImpl(url, { headers: supabaseHeaders(config) });
    if (!response.ok) throw new Error(`Labeled corpus load failed (${response.status})`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const normal = [];
  const negative = [];
  for (const row of rows) {
    const decision = clean(row.review_decision).toLowerCase();
    if (NORMAL_DECISIONS.includes(decision)) normal.push(row);
    else if (NEGATIVE_DECISIONS.includes(decision)) negative.push(row);
  }
  return { normal, negative };
}

function exampleLines(rows, cap) {
  const seen = new Set();
  const lines = [];
  for (const row of rows) {
    const text = clean(row.comment_text).replace(/\s+/g, ' ').slice(0, 80);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const category = clean(row.category) || '미분류';
    const scope = clean(row.channel_category) || clean(row.source) || '-';
    lines.push(`- [${category}|${scope}] ${text}`);
    if (lines.length >= cap) break;
  }
  return lines;
}

export function buildTuningPrompt(corpus, { maxExamplesPerLabel = 40 } = {}) {
  const normalLines = exampleLines(corpus.normal, maxExamplesPerLabel);
  const negativeLines = exampleLines(corpus.negative, maxExamplesPerLabel);
  return [
    "당신은 저당 아이스크림 브랜드 '라라스윗'의 부정댓글 분류기(LLM 프롬프트 기반, src/llm.js)를 개선하는 튜닝 분석가입니다.",
    '아래는 사람이 최근 직접 판정한 실제 라벨입니다. 이 데이터로 분류기가 \'진짜 부정\'과 \'정상\'을 더 잘 구분하도록 프롬프트 개선안을 제시하세요.',
    '',
    '현재 스코프 규칙 요약:',
    '- 기본(위성/온드/협찬)=제품·브랜드 직접 비방 + 광고 냉소·피로 + 정치만 부정. 타 인물 언급·캐주얼 욕설·경쟁품 단순비교·외국어 잡담은 정상.',
    '- 인지광고([인지광고] 스코프)=위 완화분(타 인물 언급·문맥없는 적대·발연기·댓글싸움)도 부정.',
    '- 정치 비하는 어디서든 부정.',
    '',
    `[정상] 사람이 부정 아니라고 되돌린 오탐 예시 (${corpus.normal.length}건 중 표본):`,
    ...(normalLines.length ? normalLines : ['- (없음)']),
    '',
    `[부정] 숨김·차단 처리된 부정 예시 (대부분 자동숨김, ${corpus.negative.length}건 중 표본):`,
    ...(negativeLines.length ? negativeLines : ['- (없음)']),
    '',
    '다음을 한국어로, 간결하고 실행 가능하게 출력하세요:',
    '1. *과탐 경향*: 반복 오탐되는 유형/카테고리와 근거(정상 예시). 완화할 구체 문구·예외.',
    '2. *미탐 위험*: 정상 예시 중 사실 부정에 가까운 게 섞였는지, 부정 예시에서 놓치기 쉬운 패턴.',
    '3. *llm.js 수정안 초안*: 추가/수정할 규칙을 base와 [인지광고] 스코프로 구분해 제시(예시 포함).',
    '4. *⚠️ 과억제 위험*: 이 제안이 진짜 악플 미탐으로 이어질 수 있는 지점과 안전장치.',
    '반드시 사람 승인 후 반영한다는 전제로, 단정적 지시가 아니라 근거 있는 제안으로 쓰세요.',
  ].join('\n');
}

async function callGemini(config, prompt, fetchImpl) {
  if (!config.geminiKey) return null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'x-goog-api-key': config.geminiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2000 },
    }),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const text = (data.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('')
    .trim();
  return text || null;
}

async function callAnthropic(config, prompt, fetchImpl) {
  if (!config.anthropicKey) return null;
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const text = (data.content || []).map((block) => block?.text || '').join('').trim();
  return text || null;
}

// Gemini 우선, 실패 시 Anthropic. 둘 다 실패하면 null.
export async function requestTuningSuggestion(config, prompt, fetchImpl = fetch) {
  try {
    const gemini = await callGemini(config, prompt, fetchImpl);
    if (gemini) return { provider: 'gemini', text: gemini };
  } catch { /* fall through */ }
  try {
    const anthropic = await callAnthropic(config, prompt, fetchImpl);
    if (anthropic) return { provider: 'anthropic', text: anthropic };
  } catch { /* fall through */ }
  return null;
}

export function buildTuningSlackText(suggestion, { normalCount, negativeCount, lookbackDays, mention = '', provider = '' }) {
  const mentionPrefix = mention ? `<@${mention}> ` : '';
  return [
    `:brain: *분류기 정확도 튜닝 제안 (반자동, ${provider || 'LLM'}) — 최근 ${lookbackDays}일*`,
    `${mentionPrefix}사람 라벨 기반 개선안 *초안*입니다. 정상(오탐) ${normalCount}건 · 부정(숨김·차단) ${negativeCount}건 분석.`,
    '아래는 제안일 뿐이며, 검토·승인 후 src/llm.js에 반영하세요(자동 반영 안 함).',
    '',
    clean(suggestion).slice(0, 37_000),
  ].join('\n');
}

async function postSlack(config, text, fetchImpl) {
  if (!config.notifySlack || !config.slackBotToken || !config.slackChannelId) return false;
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Slack tuning suggestion failed (${response.status})`);
  return true;
}

export async function runClassifierTuningSuggest(
  config = loadClassifierTuningConfig(), fetchImpl = fetch, now = Date.now(),
) {
  const sinceIso = new Date(now - config.lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const corpus = await loadLabeledCorpus(config, sinceIso, fetchImpl);
  // 정상 표본이 너무 적으면 제안이 빈약하므로 조용히 종료.
  if (corpus.normal.length < config.minNormal) {
    return { skipped: 'insufficient-labels', normalCount: corpus.normal.length, negativeCount: corpus.negative.length, posted: false };
  }
  const prompt = buildTuningPrompt(corpus, { maxExamplesPerLabel: config.maxExamplesPerLabel });
  const suggestion = await requestTuningSuggestion(config, prompt, fetchImpl);
  if (!suggestion) {
    return { skipped: 'llm-unavailable', normalCount: corpus.normal.length, negativeCount: corpus.negative.length, posted: false };
  }
  const text = buildTuningSlackText(suggestion.text, {
    normalCount: corpus.normal.length,
    negativeCount: corpus.negative.length,
    lookbackDays: config.lookbackDays,
    mention: config.mention,
    provider: suggestion.provider,
  });
  const posted = await postSlack(config, text, fetchImpl);
  return {
    normalCount: corpus.normal.length,
    negativeCount: corpus.negative.length,
    provider: suggestion.provider,
    posted,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runClassifierTuningSuggest()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
