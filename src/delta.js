// 델타 스킵: 댓글 수가 늘어난 게시물만 스크레이프해 Apify 과금을 최소화한다.
// 현재 댓글 수 신호는 대시보드가 매일 수집하는 Supabase post_daily_stats.comments_count를 재사용(무상).
// 마지막 확인 시점의 댓글 수는 post_comment_checks.last_count에 저장.
//   - 체크 이력이 없으면(처음) 스크레이프해 기존 댓글까지 1회 스캔한다.
//   - 이후에는 current_count > last_count 인 글만 스크레이프한다.
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
  for (let off = 0; ; off += 1000) {
    const chunk = await sbGet(config, `sponsored_posts?select=id,url,content_summary&order=id&offset=${off}&limit=1000`, fetchImpl);
    for (const p of chunk) {
      const k = extractPostKey(p.url);
      if (k && !keyToId[k]) { keyToId[k] = p.id; keyToCaption[k] = p.content_summary || ''; }
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
    };
  }
  return out;
}

// 순수 함수: 스크레이프해야 할 대상만 남긴다.
//   현재 댓글 수 신호가 없으면(매칭 실패/미수집) 무조건 skip → 안 바뀐 글 무한 재과금 방지.
//   (이렇게 스킵된 글 수는 호출부에서 로그로 표면화해 커버리지 갭을 드러낸다.)
export function filterChangedTargets(targets, counts) {
  return targets.filter((t) => {
    const c = counts[t.url] || {};
    if (c.current == null) return false;   // 댓글 수 신호 없음 → skip(비용 안전)
    if (c.last == null) return true;        // 첫 확인(신호 있음) → 최근 댓글 1회 스캔
    return c.current > c.last;              // 이후엔 댓글 수 증가분만
  });
}

// 델타 스킵 사유별 집계(로그·요약용).
export function summarizeDelta(targets, counts) {
  let noSignal = 0, unchanged = 0, firstScan = 0, increased = 0;
  for (const t of targets) {
    const c = counts[t.url] || {};
    if (c.current == null) noSignal++;
    else if (c.last == null) firstScan++;
    else if (c.current > c.last) increased++;
    else unchanged++;
  }
  return { noSignal, unchanged, firstScan, increased, scrape: firstScan + increased };
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
