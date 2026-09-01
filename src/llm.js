// 공급자 독립 LLM 분류기. 기본 체인은 Gemini 무료 티어 → Anthropic → 키워드다.
// 어떤 공급자도 사용할 수 없거나 모두 실패하면 null을 반환하고 호출부가 키워드로 폴백한다.

const CHUNK = 25;
const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

let nextGeminiRequestAt = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedAttempts(value, fallback = 4) {
  return Math.max(1, Math.min(5, Number(value || fallback)));
}

function providerOrder(config = {}) {
  const requested = String(config.llmProvider || (config.geminiKey ? 'gemini' : 'anthropic')).trim().toLowerCase();
  return requested === 'anthropic' ? ['anthropic', 'gemini'] : ['gemini', 'anthropic'];
}

function providerConfigured(provider, config = {}) {
  return provider === 'gemini' ? Boolean(config.geminiKey) : Boolean(config.anthropicKey);
}

export function configuredLlmProviders(config = {}) {
  return providerOrder(config).filter((provider) => providerConfigured(provider, config));
}

export function hasConfiguredLlmProvider(config = {}) {
  return configuredLlmProviders(config).length > 0;
}

function retryDelayMs(response, attempt, baseMs) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30_000, retryAfter * 1000);
  const parsed = Number(baseMs);
  const base = Number.isFinite(parsed) ? Math.max(0, parsed) : 1_000;
  return Math.min(30_000, base * (2 ** attempt));
}

async function safeFailure(response, provider) {
  const status = Number(response?.status || 0);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  const type = String(payload?.error?.status || payload?.error?.type || payload?.type || '').toLowerCase();
  const message = String(payload?.error?.message || payload?.message || '').toLowerCase();
  let code = 'http';
  if (provider === 'anthropic' && /credit balance|billing|purchase credits/.test(message)) code = 'credit';
  else if (status === 401 || status === 403 || /auth|api key|permission|forbidden/.test(`${type} ${message}`)) code = 'auth';
  else if (status === 429 || /rate.limit|resource_exhausted|quota/.test(`${type} ${message}`)) code = 'rate_limit';
  else if (status >= 500) code = 'server';
  else if (status === 400) code = 'invalid_request';
  const kind = [400, 401, 403].includes(status) ? 'persistent'
    : TRANSIENT_HTTP_STATUSES.has(status) ? 'transient'
      : 'persistent';
  return { provider, status: status || 'http', code, kind };
}

function recordFailure(stats, failure) {
  if (!stats) return;
  stats.failedAttempts = (stats.failedAttempts || 0) + 1;
  if (failure.kind === 'persistent') stats.persistentFailures = (stats.persistentFailures || 0) + 1;
  else stats.transientFailures = (stats.transientFailures || 0) + 1;
  stats.providerFailures ||= {};
  stats.providerFailures[failure.provider] = (stats.providerFailures[failure.provider] || 0) + 1;
  stats.lastFailureProvider = failure.provider;
  stats.lastFailureStatus = failure.status;
  stats.lastFailureCode = failure.code;
  stats.lastFailureKind = failure.kind;
}

function openPersistentCircuit(stats, provider) {
  if (!stats) return;
  stats.providerCircuit ||= {};
  stats.providerCircuit[provider] = true;
}

async function fetchWithRetry(provider, url, init, config, fetchImpl, stats) {
  const maxAttempts = boundedAttempts(
    provider === 'gemini' ? config?.geminiMaxAttempts : config?.anthropicMaxAttempts,
  );
  const baseMs = provider === 'gemini'
    ? Number(config?.geminiRetryBaseMs ?? 1_000)
    : Number(config?.anthropicRetryBaseMs ?? 1_000);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (stats) {
      stats.attempts = (stats.attempts || 0) + 1;
      const key = `${provider}Attempts`;
      stats[key] = (stats[key] || 0) + 1;
    }
    try {
      const response = await fetchImpl(url, init);
      if (response.ok) return response;
      const failure = await safeFailure(response, provider);
      recordFailure(stats, failure);
      if (failure.kind === 'persistent') openPersistentCircuit(stats, provider);
      if (!TRANSIENT_HTTP_STATUSES.has(Number(response.status)) || attempt + 1 >= maxAttempts) return response;
      await wait(retryDelayMs(response, attempt, baseMs));
    } catch (error) {
      recordFailure(stats, { provider, status: 'network', code: 'network', kind: 'transient' });
      throw error;
    }
  }
  return null;
}

async function waitForGeminiSlot(config) {
  const interval = Math.max(0, Number(config?.geminiRequestIntervalMs ?? 1_500));
  const remaining = nextGeminiRequestAt - Date.now();
  if (remaining > 0) await wait(remaining);
  nextGeminiRequestAt = Date.now() + interval;
}

const OWNED_CHANNEL_POLICY =
  "\n소유 YouTube 채널 확대 정책(댓글 앞에 [소유채널] 표시가 있는 경우에만 적용):\n" +
  "- 제품 불만뿐 아니라 라라스윗 브랜드·회사·마케팅을 향한 적대·혐오도 부정입니다(예: '라라스윗 왤케 비호감').\n" +
  "- 허위광고·조작·사실 왜곡 지적(예: '허위로 만들어 이미지 망침', '언급한 적 없다'), 법적 위협·저격(예: '소속사한테 고소'), 브랜드나 캠페인을 깎아내리는 냉소·조롱(예: '존나 설레는 댓글창 열기', '두쫀쿠가 더 팔리겠다')도 부정입니다.\n" +
  "- 단, 부정의 대상이 제품·브랜드·회사·마케팅임이 댓글 자체에서 분명해야 합니다. 부정적인 말투만으로 브랜드 공격이라고 추측하지 마세요.\n" +
  "- 댓글러끼리의 다툼·욕설·신고 언급, 정치·연예인·배우 알아보기, 제품과 무관한 드립은 정상입니다.\n" +
  "- 광고 배우의 연기·연출만 평가하는 '발연기', 단순 '광고네' 인지, '광고 참신하다/잘 만들었다' 같은 칭찬은 정상입니다.\n" +
  "- 단순 질문·사실 확인·가격/구매처·재고 언급·제품과 무관한 농담은 기존처럼 정상입니다.\n" +
  "- [소유채널] 표시가 없는 일반 협찬·제3자 채널에는 이 확대 정책을 절대 적용하지 마세요.\n";

const PROMPT_HEAD =
  "당신은 '라라스윗'(저당 아이스크림·디저트 브랜드, 대표 제품 '쫀득바') 협찬 게시물의 댓글 검토 담당입니다.\n" +
  "아래 댓글 중 **제품·음식·브랜드에 대한 부정적 언급**만 골라내세요(관리·삭제 대상).\n\n" +
  "부정으로 판단(alert=true):\n" +
  "- 맛·식감·품질·양·가격 불만이나 혹평 (예: '맛없어', '별로', '돈아깝', '과일 저건 좀 에바')\n" +
  "- 광고/바이럴/협찬 냉소·의심, 허위·과대광고 지적 (예: '또 바이럴이네', '허위광고하지마라')\n" +
  "- 성분·진위 의혹 (예: '성분표에 멜론이 없던데요?')\n" +
  "- 경쟁 제품을 들어 **라라스윗/쫀득바를 깎아내림** (예: '걍 메로나임', '이거 살 바엔 메로나 먹지', '쫀득바보다 메론바가 낫다')\n" +
  "- 구매 만류 (예: '사지 마세요')\n" +
  "- **제품/브랜드를 향한** 욕설·비속어 (예: '이 아이스크림 존나 맛없어 씨발', '라라스윗 광고 지겹다 꺼져')\n" +
  "정상으로 판단(alert=false):\n" +
  "- 긍정·중립·감탄·질문·태그·이모지, 제품과 무관한 잡담, 인플루언서 개인 칭찬.\n" +
  "- **'광고'라는 단어가 있어도 팬이 호감·기대·구매의향을 표현하면 정상.** 예: '후님이 광고하니까 꼭 먹어볼게요🥰 잘생겼어용', '헐 후님이 광고를 하시다니!!', '터후님 광고 너무 잘찍으세요 아자스'.\n" +
  "- 다른 매장·다른 제품·다른 일상 언급 등 **제품/브랜드를 직접 깎아내리지 않는 잡담·가용성 관찰은 정상.** 예: '지금 베라 갈려고 했는데 이게 왜 나오는데', 'gs네 cu면 갈만했는데 까비', '먹는 애를 본 적이 없는데', '단 하나도 본 적 없는데'.\n" +
  "- **욕설·비속어라도 제품/브랜드가 아니라 다른 댓글러를 향하거나(댓글 싸움: '꺼져', '닥쳐', '새끼') 제품과 무관한 화풀이면 정상.** 제품·브랜드·맛·광고를 겨냥한 욕설만 부정.\n" +
  "- **경쟁 제품을 단순 언급·사실 정정·취향 표현만** 하고 라라스윗/쫀득바를 깎아내리지 않으면 정상 (예: '메로나는 참외맛임', '메로나도 맛있죠', '메론바가 원조지'). 경쟁품 이름이 있다고 부정 아님.\n" +
  "- '광고', '바이럴', '별로', 경쟁제품명이 있어도 문장 전체가 긍정이거나 다른 대상을 부정하고 라라스윗 제품은 칭찬하면 정상.\n" +
  "  예: '다른 광고는 별로 안 사먹고 싶었는데 이건 너무 사먹고 싶다'는 정상.\n" +
  "- 욕설이라도 명백한 애정·감탄이면 정상 (예: '존맛', '미쳤다 맛있어').\n\n";

const PROMPT_TAIL =
  '\n\nJSON 배열로만 답하세요: [{"i":번호,"alert":true|false,' +
  '"category":"제품 불만|광고/바이럴 의심|성분/진위 의혹|경쟁품 비교|판매방식 불만|욕설/비속어|브랜드 적대/조롱|정상",' +
  '"reason":"한줄 근거, 한자 쓰지 말고 순우리말로(예: 貶下→깎아내림, 是非→시비) (정상이면 빈 문자열)"}]';

const RESULT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      i: { type: 'integer' },
      alert: { type: 'boolean' },
      category: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['i', 'alert', 'category', 'reason'],
    additionalProperties: false,
  },
};

function buildPrompt(chunk) {
  const hasOwnedChannelContext = chunk.some((comment) => comment?.ownedChannelBrandHostilityScope === true);
  const numbered = chunk.map((comment, index) => {
    const scope = comment?.ownedChannelBrandHostilityScope === true ? '[소유채널] ' : '';
    return `${index}. ${scope}${String(comment?.text || '').slice(0, 300)}`;
  }).join('\n');
  return PROMPT_HEAD + (hasOwnedChannelContext ? OWNED_CHANNEL_POLICY : '')
    + '댓글 목록:\n' + numbered + PROMPT_TAIL;
}

function parseResults(text, chunkLength) {
  const match = String(text || '').match(/\[[\s\S]*\]/);
  const array = match ? JSON.parse(match[0]) : [];
  const byIndex = new Map();
  for (const row of array) if (row && Number.isInteger(row.i)) byIndex.set(row.i, row);
  const out = [];
  for (let index = 0; index < chunkLength; index += 1) {
    const row = byIndex.get(index);
    // 누락/불완전 응답을 정상(false)으로 대리판정하면 캐시·seen이 오염된다. 호출부가 해당 슬롯을
    // llm_deferred로 보류하도록 null을 유지한다.
    if (!row || typeof row.alert !== 'boolean') { out.push(null); continue; }
    const alert = row.alert === true;
    const category = alert ? String(row.category || '부정언급') : '정상댓글';
    out.push({
      alert,
      category,
      reason: alert ? String(row.reason || category).slice(0, 200) : '',
      priority: category === '욕설/비속어' ? 'high' : 'normal',
    });
  }
  return out;
}

function recordSuccess(stats, provider, chunkLength, usage = {}) {
  if (!stats) return;
  const input = Number(usage.input || 0);
  const output = Number(usage.output || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheCreate = Number(usage.cacheCreate || 0);
  stats.calls = (stats.calls || 0) + 1;
  stats.reviewed = (stats.reviewed || 0) + chunkLength;
  stats.inputTokens = (stats.inputTokens || 0) + input;
  stats.outputTokens = (stats.outputTokens || 0) + output;
  stats.cacheRead = (stats.cacheRead || 0) + cacheRead;
  stats.cacheCreate = (stats.cacheCreate || 0) + cacheCreate;
  const prefix = provider === 'gemini' ? 'gemini' : 'anthropic';
  stats[`${prefix}Calls`] = (stats[`${prefix}Calls`] || 0) + 1;
  stats[`${prefix}InputTokens`] = (stats[`${prefix}InputTokens`] || 0) + input;
  stats[`${prefix}OutputTokens`] = (stats[`${prefix}OutputTokens`] || 0) + output;
  if (provider === 'anthropic') {
    stats.anthropicCacheRead = (stats.anthropicCacheRead || 0) + cacheRead;
    stats.anthropicCacheCreate = (stats.anthropicCacheCreate || 0) + cacheCreate;
  }
  stats.lastSuccessfulProvider = provider;
}

async function classifyWithAnthropic(prompt, chunkLength, config, fetchImpl, stats) {
  const response = await fetchWithRetry('anthropic', 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, config, fetchImpl, stats);
  if (!response?.ok) return null;
  const data = await response.json();
  const usage = data.usage || {};
  const result = parseResults((data.content || []).map((block) => block.text || '').join(''), chunkLength);
  recordSuccess(stats, 'anthropic', chunkLength, {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheCreate: usage.cache_creation_input_tokens,
  });
  return result;
}

async function classifyWithGemini(prompt, chunkLength, config, fetchImpl, stats) {
  await waitForGeminiSlot(config);
  const model = config.geminiModel || DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetchWithRetry('gemini', endpoint, {
    method: 'POST',
    headers: { 'x-goog-api-key': config.geminiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: RESULT_SCHEMA,
        maxOutputTokens: 2000,
        temperature: 0,
      },
    }),
  }, config, fetchImpl, stats);
  if (!response?.ok) return null;
  const data = await response.json();
  const usage = data.usageMetadata || {};
  const text = (data.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('');
  const result = parseResults(text, chunkLength);
  recordSuccess(stats, 'gemini', chunkLength, {
    input: usage.promptTokenCount,
    output: usage.candidatesTokenCount,
    cacheRead: usage.cachedContentTokenCount,
  });
  return result;
}

async function classifyChunk(prompt, chunkLength, config, fetchImpl, stats) {
  const providers = configuredLlmProviders(config);
  for (const provider of providers) {
    if (stats?.providerCircuit?.[provider]) continue;
    try {
      const result = provider === 'gemini'
        ? await classifyWithGemini(prompt, chunkLength, config, fetchImpl, stats)
        : await classifyWithAnthropic(prompt, chunkLength, config, fetchImpl, stats);
      if (result) return result;
    } catch {
      // 공급자 실패는 다음 공급자로 격리한다. 원문·키·응답 본문은 로그에 남기지 않는다.
    }
  }
  if (stats) {
    const remaining = providers.filter((provider) => !stats?.providerCircuit?.[provider]);
    stats.llmCircuitOpen = providers.length > 0 && remaining.length === 0;
  }
  return null;
}

// comments: [{text}], 반환: [{alert, category, reason, priority}] 또는 null(키워드 폴백).
// stats에는 댓글 내용/키 없이 공급자별 호출·토큰·실패 집계만 누적한다.
export async function classifyCommentsLLM(comments, config, fetchImpl = fetch, stats = null) {
  if (!hasConfiguredLlmProvider(config) || !comments.length) return null;
  const out = [];
  for (let index = 0; index < comments.length; index += CHUNK) {
    const chunk = comments.slice(index, index + CHUNK);
    const result = await classifyChunk(buildPrompt(chunk), chunk.length, config, fetchImpl, stats);
    if (!result) return null;
    out.push(...result);
  }
  return out;
}
