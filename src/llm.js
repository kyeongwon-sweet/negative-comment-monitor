// Claude 기반 부정댓글 분류(의미 판단). 키워드로 못 잡는 표현("에바", "걍 메로나임",
// 성분 의혹, 반어 등)까지 문맥으로 판단한다.
// ANTHROPIC_API_KEY가 있을 때만 동작하고, 실패/미설정 시 null을 반환해 호출부가 키워드 분류로 폴백한다.

const CHUNK = 25;

const PROMPT_HEAD =
  "당신은 '라라스윗'(저당 아이스크림·디저트 브랜드, 대표 제품 '쫀득바') 협찬 게시물의 댓글 검토 담당입니다.\n" +
  "아래 댓글 중 **제품·음식·브랜드에 대한 부정적 언급**만 골라내세요(관리·삭제 대상).\n\n" +
  "부정으로 판단(alert=true):\n" +
  "- 맛·식감·품질·양·가격 불만이나 혹평 (예: '맛없어', '별로', '돈아깝', '과일 저건 좀 에바')\n" +
  "- 광고/바이럴/협찬 냉소·의심, 허위·과대광고 지적 (예: '또 바이럴이네', '허위광고하지마라')\n" +
  "- 성분·진위 의혹 (예: '성분표에 멜론이 없던데요?')\n" +
  "- 경쟁 제품과 비교하며 깎아내림 (예: '걍 메로나임', '그냥 메론바 맛남')\n" +
  "- 구매 만류 (예: '사지 마세요')\n" +
  "- **제품/브랜드를 향한** 욕설·비속어 (예: '이 아이스크림 존나 맛없어 씨발', '라라스윗 광고 지겹다 꺼져')\n" +
  "정상으로 판단(alert=false):\n" +
  "- 긍정·중립·감탄·질문·태그·이모지, 제품과 무관한 잡담, 인플루언서 개인 칭찬.\n" +
  "- **욕설·비속어라도 제품/브랜드가 아니라 다른 댓글러를 향하거나(댓글 싸움: '꺼져', '닥쳐', '새끼') 제품과 무관한 화풀이면 정상.** 제품·브랜드·맛·광고를 겨냥한 욕설만 부정.\n" +
  "- '광고', '바이럴', '별로', 경쟁제품명이 있어도 문장 전체가 긍정이거나 다른 대상을 부정하고 라라스윗 제품은 칭찬하면 정상.\n" +
  "  예: '다른 광고는 별로 안 사먹고 싶었는데 이건 너무 사먹고 싶다'는 정상.\n" +
  "- 욕설이라도 명백한 애정·감탄이면 정상 (예: '존맛', '미쳤다 맛있어').\n\n";

const PROMPT_TAIL =
  '\n\nJSON 배열로만 답하세요: [{"i":번호,"alert":true|false,' +
  '"category":"제품 불만|광고/바이럴 의심|성분/진위 의혹|경쟁품 비교|판매방식 불만|욕설/비속어|정상",' +
  '"reason":"한줄 근거, 한자 쓰지 말고 순우리말로(예: 貶下→깎아내림, 是非→시비) (정상이면 빈 문자열)"}]';

// comments: [{text}], 반환: [{alert, category, reason, priority}] (입력 순서) 또는 null(폴백).
export async function classifyCommentsLLM(comments, config, fetchImpl = fetch) {
  if (!config.anthropicKey || !comments.length) return null;
  const model = config.anthropicModel || 'claude-haiku-4-5-20251001';
  const out = [];
  for (let i = 0; i < comments.length; i += CHUNK) {
    const chunk = comments.slice(i, i + CHUNK);
    const numbered = chunk.map((c, j) => `${j}. ${String(c.text || '').slice(0, 300)}`).join('\n');
    const prompt = PROMPT_HEAD + '댓글 목록:\n' + numbered + PROMPT_TAIL;
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) return null;
      const data = await res.json();
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
