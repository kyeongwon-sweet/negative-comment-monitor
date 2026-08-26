// Claude 기반 부정댓글 분류(의미 판단). 키워드로 못 잡는 표현("에바", "걍 메로나임",
// 성분 의혹, 반어 등)까지 문맥으로 판단한다.
// ANTHROPIC_API_KEY가 있을 때만 동작하고, 실패/미설정 시 null을 반환해 호출부가 키워드 분류로 폴백한다.

const CHUNK = 25;
const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt, config) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(15_000, retryAfter * 1000);
  const base = Math.max(0, Number(config?.anthropicRetryBaseMs ?? 1_000));
  return Math.min(15_000, base * (2 ** attempt));
}

async function safeAnthropicFailure(response) {
  const status = Number(response?.status || 0);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  const type = String(payload?.error?.type || payload?.type || '').toLowerCase();
  const message = String(payload?.error?.message || '').toLowerCase();
  let code = 'http';
  if (/credit balance|billing|purchase credits/.test(message)) code = 'credit';
  else if (status === 401 || status === 403 || /auth|api key|permission/.test(`${type} ${message}`)) code = 'auth';
  else if (status === 429 || /rate.limit/.test(`${type} ${message}`)) code = 'rate_limit';
  else if (status >= 500) code = 'server';
  else if (status === 400) code = 'invalid_request';
  const kind = [400, 401, 403].includes(status) ? 'persistent'
    : TRANSIENT_HTTP_STATUSES.has(status) ? 'transient'
      : 'persistent';
  return { status: status || 'http', code, kind };
}

function recordFailure(stats, failure) {
  if (!stats) return;
  stats.failedAttempts = (stats.failedAttempts || 0) + 1;
  if (failure.kind === 'persistent') stats.persistentFailures = (stats.persistentFailures || 0) + 1;
  else stats.transientFailures = (stats.transientFailures || 0) + 1;
  stats.lastFailureStatus = failure.status;
  stats.lastFailureCode = failure.code;
  stats.lastFailureKind = failure.kind;
}

async function fetchAnthropicWithRetry(url, init, config, fetchImpl, stats) {
  const maxAttempts = Math.max(1, Math.min(5, Number(config?.anthropicMaxAttempts || 4)));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (stats) stats.attempts = (stats.attempts || 0) + 1;
    try {
      const response = await fetchImpl(url, init);
      if (response.ok) return response;
      const failure = await safeAnthropicFailure(response);
      recordFailure(stats, failure);
      if (!TRANSIENT_HTTP_STATUSES.has(Number(response.status)) || attempt + 1 >= maxAttempts) return response;
      await wait(retryDelayMs(response, attempt, config));
    } catch (error) {
      recordFailure(stats, { status: 'network', code: 'network', kind: 'transient' });
      // 네트워크 예외는 fetch 내부 재시도 여부를 알 수 없고 장시간 워크플로를 붙잡을 수 있어
      // 기존 fail-soft 경로로 즉시 넘긴다. 429/5xx처럼 명시적인 일시 HTTP 응답만 재시도한다.
      throw error;
    }
  }
  return null;
}

const OWNED_CHANNEL_POLICY =
  "\n소유 YouTube 채널 확대 정책(댓글 앞에 [소유채널] 표시가 있는 경우에만 적용):\n" +
  "- 제품 불만뿐 아니라 라라스윗 브랜드·회사·마케팅을 향한 적대·혐오도 부정입니다(예: '라라스윗 왤케 비호감').\n" +
  "- 허위광고·조작·사실 왜곡 지적(예: '허위로 만들어 이미지 망침', '언급한 적 없다'), 법적 위협·저격(예: '소속사한테 고소'), 브랜드나 캠페인을 깎아내리는 냉소·조롱(예: '존나 설레는 댓글창 열기', '두쫀쿠가 더 팔리겠다')도 부정입니다.\n" +
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
  "- **욕설·비속어라도 제품/브랜드가 아니라 다른 댓글러를 향하거나(댓글 싸움: '꺼져', '닥쳐', '새끼') 제품과 무관한 화풀이면 정상.** 제품·브랜드·맛·광고를 겨냥한 욕설만 부정.\n" +
  "- **경쟁 제품을 단순 언급·사실 정정·취향 표현만** 하고 라라스윗/쫀득바를 깎아내리지 않으면 정상 (예: '메로나는 참외맛임', '메로나도 맛있죠', '메론바가 원조지'). 경쟁품 이름이 있다고 부정 아님.\n" +
  "- '광고', '바이럴', '별로', 경쟁제품명이 있어도 문장 전체가 긍정이거나 다른 대상을 부정하고 라라스윗 제품은 칭찬하면 정상.\n" +
  "  예: '다른 광고는 별로 안 사먹고 싶었는데 이건 너무 사먹고 싶다'는 정상.\n" +
  "- 욕설이라도 명백한 애정·감탄이면 정상 (예: '존맛', '미쳤다 맛있어').\n\n";

const PROMPT_TAIL =
  '\n\nJSON 배열로만 답하세요: [{"i":번호,"alert":true|false,' +
  '"category":"제품 불만|광고/바이럴 의심|성분/진위 의혹|경쟁품 비교|판매방식 불만|욕설/비속어|브랜드 적대/조롱|정상",' +
  '"reason":"한줄 근거, 한자 쓰지 말고 순우리말로(예: 貶下→깎아내림, 是非→시비) (정상이면 빈 문자열)"}]';

// comments: [{text}], 반환: [{alert, category, reason, priority}] (입력 순서) 또는 null(폴백).
// stats(선택): 사용량 계측 누산기. 댓글 내용/키는 절대 기록하지 않고 호출수·토큰수만 누적.
export async function classifyCommentsLLM(comments, config, fetchImpl = fetch, stats = null) {
  if (!config.anthropicKey || !comments.length) return null;
  const model = config.anthropicModel || 'claude-haiku-4-5-20251001';
  const out = [];
  for (let i = 0; i < comments.length; i += CHUNK) {
    const chunk = comments.slice(i, i + CHUNK);
    const hasOwnedChannelContext = chunk.some((comment) => comment?.ownedChannelBrandHostilityScope === true);
    const numbered = chunk.map((c, j) => {
      const scope = c?.ownedChannelBrandHostilityScope === true ? '[소유채널] ' : '';
      return `${j}. ${scope}${String(c.text || '').slice(0, 300)}`;
    }).join('\n');
    const prompt = PROMPT_HEAD + (hasOwnedChannelContext ? OWNED_CHANNEL_POLICY : '')
      + '댓글 목록:\n' + numbered + PROMPT_TAIL;
    try {
      const res = await fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      }, config, fetchImpl, stats);
      if (!res?.ok) return null;
      const data = await res.json();
      if (stats) {   // 사용량 누적(내용·키 미기록, 토큰수만)
        const u = data.usage || {};
        stats.calls += 1;
        stats.reviewed += chunk.length;
        stats.inputTokens += u.input_tokens || 0;
        stats.outputTokens += u.output_tokens || 0;
        stats.cacheRead += u.cache_read_input_tokens || 0;
        stats.cacheCreate += u.cache_creation_input_tokens || 0;
      }
      const txt = (data.content || []).map((b) => b.text || '').join('');
      const m = txt.match(/\[[\s\S]*\]/);
      const arr = m ? JSON.parse(m[0]) : [];
      const byI = {};
      for (const a of arr) if (a && typeof a.i === 'number') byI[a.i] = a;
      for (let j = 0; j < chunk.length; j++) {
        const a = byI[j] || {};
        const alert = a.alert === true;
        const category = alert ? (a.category || '부정언급') : '정상댓글';
        out.push({
          alert,
          category,
          reason: alert ? String(a.reason || category).slice(0, 200) : '',
          priority: category === '욕설/비속어' ? 'high' : 'normal',
        });
      }
    } catch {
      return null; // 어떤 청크든 실패하면 전체 폴백(부분 판정 혼용 방지)
    }
  }
  return out;
}
