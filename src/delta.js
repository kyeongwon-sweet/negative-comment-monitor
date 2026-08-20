// 델타 스킵: 댓글 수가 늘어난 게시물만 스크레이프해 Apify 과금을 최소화한다.
// 현재 댓글 수 신호는 대시보드가 매일 수집하는 Supabase post_daily_stats.comments_count를 재사용(무상).
// 마지막 확인 시점의 댓글 수는 post_comment_checks.last_count에 저장.
//   - 체크 이력이 없으면(신규글) 댓글 수 신호가 아직 없어도 1회 스크레이프해 조기 감시한다(DB 등록분만).
//   - 이후에는 current_count가 last_count와 달라진(증가·감소 모두) 글을 스크레이프한다.
//     (댓글 삭제로 카운트가 줄어도 그 사이 새 댓글이 달렸을 수 있어 재스캔; 중복 알림은 fingerprint로 방지)
//   - 현재 댓글 수를 모르면(매칭 실패/미수집) 재과금 방지로 건너뛴다.

export function extractPostKey(url) {
  const u = String(url || '');
  let m;
  if (/instagram\.com/i.test(u)) { m = u.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/); return m ? 'ig:' + m[1] : null; }
  if (/youtube\.com|youtu\.be/i.test(u)) { m = u.match(/(?:shorts\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/); return m ? 'yt:' + m[1] : null; }
  if (/tiktok\.com/i.test(u)) { m = u.match(/\/(?:video|photo)\/(\d+)/); return m ? 'tt:' + m[1] : null; }
  if (/x\.com|twitter\.com/i.test(u)) { m = u.match(/\/status\/(\d+)/); return m ? 'x:' + m[1] : null; }
  return null;
}

async function sbGet(config, path, fetchImpl) {
  const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: config.supabaseKey, Authorization: 'Bearer ' + config.supabaseKey },
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// targets(url 보유) → { [url]: { postId, current, last } }
export async function loadCommentCounts(config, targets, fetchImpl = fetch, now = Date.now()) {
  // 1) sponsored_posts 전량 → 게시물키→{id, 캡션} 매핑
  const keyToId = {};
  const keyToCaption = {};
  const keyToProduct = {};
  const keyToEnded = {};      // 게시물키 → ended_at(보관처리/종료). 있으면 부정댓글 알림 제외.
  const keyToNotFound = {};   // 게시물키 → not_found_streak(연속 미조회=죽은 링크).
  const keyToAsset = {};      // 게시물키 → asset_name(소재명). 바이럴 카드 제작자 추출용.
  for (let off = 0; ; off += 1000) {
    const chunk = await sbGet(config, `sponsored_posts?select=id,url,content_summary,product_name,ended_at,not_found_streak,asset_name&order=id&offset=${off}&limit=1000`, fetchImpl);
    for (const p of chunk) {
      const k = extractPostKey(p.url);
      if (k && !keyToId[k]) {
        keyToId[k] = p.id; keyToCaption[k] = p.content_summary || ''; keyToProduct[k] = p.product_name || '';
        keyToEnded[k] = p.ended_at || null; keyToNotFound[k] = Number(p.not_found_streak || 0);
        keyToAsset[k] = p.asset_name || '';
      }
    }
    if (chunk.length < 1000) break;
  }
  // 2) 최근 30일 내 가장 최신 comments_count → post별 최신값(신호 커버리지 최대화)
  const cutoff = new Date(now - 30 * 864e5).toISOString().slice(0, 10);
  const latest = {};
  for (let off = 0; ; off += 1000) {
    const rows = await sbGet(config, `post_daily_stats?select=post_id,comments_count,measured_at&measured_at=gte.${cutoff}&comments_count=not.is.null&order=measured_at.desc&offset=${off}&limit=1000`, fetchImpl);
    for (const r of rows) if (latest[r.post_id] === undefined) latest[r.post_id] = r.comments_count;
    if (rows.length < 1000) break;
  }
  // 3) post_comment_checks last_count
  const checks = {};
  for (let off = 0; ; off += 1000) {
    const rows = await sbGet(config, `post_comment_checks?select=post_id,last_count,last_checked_at&offset=${off}&limit=1000`, fetchImpl);
    for (const r of rows) checks[r.post_id] = { lastCount: r.last_count, lastCheckedAt: r.last_checked_at || '' };
    if (rows.length < 1000) break;
  }
  const out = {};
  for (const t of targets) {
    const k = extractPostKey(t.url);
    const id = k ? keyToId[k] || null : null;
    out[t.url] = {
      postId: id,
      current: id != null ? (latest[id] ?? null) : null,
      last: id != null ? (checks[id]?.lastCount ?? null) : null,
      lastCheckedAt: id != null ? (checks[id]?.lastCheckedAt || '') : '',
      caption: k ? (keyToCaption[k] || '') : '',
      productName: k ? (keyToProduct[k] || '') : '',
      endedAt: k ? (keyToEnded[k] || null) : null,
      notFoundStreak: k ? (keyToNotFound[k] || 0) : 0,
      assetName: k ? (keyToAsset[k] || '') : '',
    };
  }
  return out;
}

// 보관처리(ended_at 존재)·죽은 링크(not_found_streak ≥ 임계) 게시물은 부정댓글 알림 대상에서 제외한다.
// counts 미조회(빈 객체)면 fail-open으로 전부 유지(신호 없어 잘못 스킵 방지). 임계 기본 2(연속 미조회=지속적 dead).
export function filterArchivedOrDeadTargets(targets, counts = {}, options = {}) {
  const notFoundThreshold = Number.isFinite(Number(options.notFoundThreshold)) ? Number(options.notFoundThreshold) : 2;
  const kept = [];
  const skipped = [];
  for (const t of targets) {
    const c = counts[t.url] || {};
    const archived = Boolean(c.endedAt);
    const dead = Number(c.notFoundStreak || 0) >= notFoundThreshold;
    if (archived || dead) skipped.push({ target: t, reason: archived ? 'archived' : 'dead-link' });
    else kept.push(t);
  }
  return { kept, skipped };
}

// 순수 함수: 스크레이프해야 할 대상만 남긴다.
//   현재 댓글 수 신호가 없으면(매칭 실패/미수집) 무조건 skip → 안 바뀐 글 무한 재과금 방지.
//   (이렇게 스킵된 글 수는 호출부에서 로그로 표면화해 커버리지 갭을 드러낸다.)
function deltaReason_(target, counts) {
  const c = counts[target.url] || {};
  // ?좉퇋湲(DB ?깅줉??+ ?꾩쭅 ??踰덈룄 ?ㅼ틪 ????? ?볤????좏샇媛 ?꾩쭅 ?놁뼱??1???ㅼ틪?쒕떎.
  // ??쒕낫??comments_count ?섏쭛 吏?곗쑝濡??좉퇋湲??媛먯떆?먯꽌 ?꾨씫?섎뜕 媛?諛⑹?. ?ㅼ틪?섎㈃ last_checked_at??
  // 湲곕줉???ㅼ쓬遺?곕뒗 ?ъ뒪罹??????ш낵湲??놁쓬). postId ?녿뒗(DB 誘몃벑濡? 湲? 湲곕줉 遺덇????쒖쇅.
  // 신규글(미확인)인데 current=0(댓글 0)이면 스크레이프 불필요 → baseline(last_count=0)만 기록해
  // 비용 절감. 이후 댓글이 생기면 current>0이 되어 changed로 감지된다.
  if (c.last == null && !c.lastCheckedAt && c.postId) return (c.current != null && Number(c.current) === 0) ? 'baseline' : 'firstScan';
  if (c.current == null) return '';   // 洹????좏샇 ?놁쓬 ??skip(鍮꾩슜 ?덉쟾)
  if (c.last == null) return 'firstScan';        // 泥??뺤씤(?좏샇 ?덉쓬) ??理쒓렐 ?볤? 1???ㅼ틪
  return c.current !== c.last ? 'changed' : '';            // ?댄썑??利앷?쨌媛먯냼 紐⑤몢 ?ъ뒪罹???젣濡?移댁슫??以꾩뼱?????볤? 媛?? 以묐났? fingerprint dedup 諛⑹?)
}

function firstScanPriority_(target, counts) {
  const c = counts[target.url] || {};
  const currentScore = Number.isFinite(Number(c.current)) ? Number(c.current) : -1;
  const dateScore = Date.parse(target.uploadedAt || target.publishedAt || target.postedAt || '') || 0;
  return currentScore * 1e13 + dateScore;
}

function targetDateMs_(target) {
  return Date.parse(target.uploadedAt || target.publishedAt || target.postedAt || '') || 0;
}

export function filterChangedTargets(targets, counts, options = {}) {
  const firstScanLimit = Number(options.firstScanLimit);
  if (!Number.isFinite(firstScanLimit) || firstScanLimit < 0) {
    // 'baseline'(current=0 신규)은 스크레이프 대상 아님 — changed/firstScan만.
    return targets.filter((t) => { const r = deltaReason_(t, counts); return r === 'changed' || r === 'firstScan'; });
  }
  const changed = [];
  const firstScan = [];
  for (const target of targets) {
    const reason = deltaReason_(target, counts);
    if (reason === 'changed') changed.push(target);
    else if (reason === 'firstScan') firstScan.push(target);
  }
  const limitedFirstScan = firstScan
    .map((target, index) => ({ target, index, priority: firstScanPriority_(target, counts) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, Math.max(0, firstScanLimit))
    .map((item) => item.target);
  return [...changed, ...limitedFirstScan];
}

// current=0(댓글 0) 신규글 = 스크레이프 없이 last_count=0 baseline만 기록할 대상(비용 절감).
export function filterBaselineTargets(targets, counts) {
  return targets.filter((t) => deltaReason_(t, counts) === 'baseline');
}

export function filterNoSignalRescueTargets(targets, counts, options = {}) {
  const limit = Number(options.limit);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return targets
    .filter((target) => {
      const c = counts[target.url] || {};
      // 이미 한 번 확인 이력이 있는데도 comments_count 신호가 없는 글만 별도 rescue한다.
      // 신규 noSignal 글은 firstScanLimit 대기열에서 처리해 firstScan 비용상한을 우회하지 않게 한다.
      return Boolean(c.postId) && c.current == null && Boolean(c.lastCheckedAt);
    })
    // stale-first 공정 순환: 가장 오래 안 본 것부터 rescue. (과거엔 게시일 최신순이라 옛 noSignal
    // 게시물이 신규글에 계속 밀려 영영 재스캔 안 되던 블라인드 스팟이 있었음.)
    // lastCheckedAt 오름차순 → 모든 noSignal 게시물이 돌아가며 스캔된다.
    .map((target, index) => ({ target, index, lastMs: Date.parse((counts[target.url] || {}).lastCheckedAt || '') || 0 }))
    .sort((a, b) => a.lastMs - b.lastMs || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((item) => item.target);
}

export function filterDeepScanTargets(targets, counts, options = {}) {
  const limit = Number(options.limit);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const now = Number(options.now || Date.now());
  const threshold = Number.isFinite(Number(options.commentThreshold)) ? Number(options.commentThreshold) : 10;
  const recentThreshold = Number.isFinite(Number(options.recentCommentThreshold)) ? Number(options.recentCommentThreshold) : threshold;
  const trackingDays = Number.isFinite(Number(options.trackingDays)) ? Number(options.trackingDays) : 14;
  const day = 24 * 60 * 60 * 1000;
  return targets
    .filter((target) => {
      const c = counts[target.url] || {};
      const current = Number(c.current);
      const published = targetDateMs_(target);
      const ageDays = published ? Math.max(0, (now - published) / day) : Infinity;
      const requiredComments = ageDays <= 7 ? recentThreshold : threshold;
      if (!Number.isFinite(current) || current < requiredComments) return false;
      let intervalDays = Infinity;
      if (target.isBoosted || ageDays <= 7) intervalDays = 1;
      else if (ageDays <= trackingDays) intervalDays = 2;
      else if (String(target.channelCategory || '').includes('온드') || String(target.channelCategory || '').includes('위성') || String(target.channelCategory || '').includes('?⑤뱶') || String(target.channelCategory || '').includes('?꾩꽦')) intervalDays = 7;
      if (!Number.isFinite(intervalDays)) return false;
      const last = Date.parse(c.lastCheckedAt || '');
      if (!Number.isFinite(last)) return true;
      return now - last >= intervalDays * day;
    })
    .map((target, index) => ({ target: { ...target, deepScan: true }, index, current: Number((counts[target.url] || {}).current || 0), dateMs: targetDateMs_(target) }))
    .sort((a, b) => b.current - a.current || b.dateMs - a.dateMs || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((item) => item.target);
}

export function filterChangedTargetsUnlimited(targets, counts) {
  return targets.filter((t) => {
    const c = counts[t.url] || {};
    // 신규글(DB 등록됨 + 아직 한 번도 스캔 안 함)은 댓글수 신호가 아직 없어도 1회 스캔한다.
    // 대시보드 comments_count 수집 지연으로 신규글이 감시에서 누락되던 갭 방지. 스캔하면 last_checked_at이
    // 기록돼 다음부터는 재스캔 안 함(재과금 없음). postId 없는(DB 미등록) 글은 기록 불가라 제외.
    if (c.last == null && !c.lastCheckedAt && c.postId) return true;
    if (c.current == null) return false;   // 그 외 신호 없음 → skip(비용 안전)
    if (c.last == null) return true;        // 첫 확인(신호 있음) → 최근 댓글 1회 스캔
    return c.current !== c.last;            // 이후엔 증가·감소 모두 재스캔(삭제로 카운트 줄어도 새 댓글 가능; 중복은 fingerprint dedup 방지)
  });
}

// 델타 스킵 사유별 집계(로그·요약용).
export function summarizeDelta(targets, counts) {
  let noSignal = 0, unchanged = 0, firstScan = 0, changed = 0, baseline = 0;
  for (const t of targets) {
    const c = counts[t.url] || {};
    if (c.current == null) noSignal++;
    else if (c.last == null) { if (Number(c.current) === 0) baseline++; else firstScan++; } // current=0 신규는 baseline(무스크레이프)
    else if (c.current !== c.last) changed++;
    else unchanged++;
  }
  return { noSignal, unchanged, firstScan, changed, baseline, scrape: firstScan + changed };
}

// 스크레이프 성공한 대상의 last_count를 현재값으로 갱신(다음 실행부터 증가분만).
export async function recordChecks(config, scrapedTargets, counts, fetchImpl = fetch, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const rows = [];
  const seen = new Set();
  for (const t of scrapedTargets) {
    const c = counts[t.url];
    if (!c || !c.postId || seen.has(c.postId)) continue;
    seen.add(c.postId);
    rows.push({ post_id: c.postId, last_count: c.current != null ? c.current : c.last, last_checked_at: iso });
  }
  if (!rows.length) return 0;
  const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/post_comment_checks?on_conflict=post_id`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseKey, Authorization: 'Bearer ' + config.supabaseKey,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return rows.length;
}
