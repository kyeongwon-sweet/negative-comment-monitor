// Meta(Facebook/Instagram) 액세스 토큰 관리.
//   - 단기 토큰(1시간) → 장기 사용자 토큰(약 60일) 교환.
//   - 장기 토큰은 만료 임박 시 재교환으로 60일 연장(Meta는 마지막 갱신 24h 경과 후 재교환 시 만료 리셋).
//   - 토큰 값은 Supabase meta_tokens 테이블에 저장(자동 갱신이 GitHub 시크릿을 건드리지 않게).
//   - app_secret 등 자격증명은 절대 로그/에러에 노출하지 않는다.

const DEFAULT_GRAPH = 'https://graph.facebook.com/v26.0';

function graphBase(config) {
  return (config && config.metaGraphBase) || DEFAULT_GRAPH;
}

// 단기/장기 토큰을 장기 토큰으로 교환(fb_exchange_token). 동일 호출로 장기 토큰 갱신도 가능.
export async function exchangeLongLivedToken({ token, appId, appSecret, graphBase: base = DEFAULT_GRAPH }, fetchImpl = fetch) {
  if (!token || !appId || !appSecret) throw new Error('exchangeLongLivedToken: token/appId/appSecret 필요');
  const url = `${base}/oauth/access_token`
    + `?grant_type=fb_exchange_token`
    + `&client_id=${encodeURIComponent(appId)}`
    + `&client_secret=${encodeURIComponent(appSecret)}`
    + `&fb_exchange_token=${encodeURIComponent(token)}`;
  const res = await fetchImpl(url, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) {
    // 응답에 토큰/시크릿이 되비쳐 들어갈 수 있어 상태코드+error 메시지만 남긴다.
    let detail = '';
    try { detail = JSON.parse(text)?.error?.message || ''; } catch { detail = ''; }
    throw new Error(`Meta 토큰 교환 실패 ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error('Meta 토큰 교환 응답에 access_token 없음');
  // expires_in(초)이 없으면 보수적으로 60일로 가정.
  const expiresInSec = Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : 60 * 24 * 3600;
  return { token: data.access_token, expiresInSec };
}

async function sb(config, path, options, fetchImpl) {
  const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      ...(options && options.headers ? options.headers : {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${options?.method || 'GET'} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

// 저장된 토큰 조회. 없으면 null.
export async function loadMetaToken(config, kind, fetchImpl = fetch) {
  const res = await sb(config, `meta_tokens?select=token,expires_at&kind=eq.${encodeURIComponent(kind)}&limit=1`, {}, fetchImpl);
  const rows = await res.json();
  return rows[0] || null;
}

// 토큰 upsert(kind 유니크). expires_at은 ISO 문자열.
export async function saveMetaToken(config, kind, token, expiresInSec, fetchImpl = fetch, now = Date.now()) {
  const expiresAt = new Date(now + Math.max(0, Number(expiresInSec) || 0) * 1000).toISOString();
  await sb(config, `meta_tokens?on_conflict=kind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ kind, token, expires_at: expiresAt, updated_at: new Date(now).toISOString() }),
  }, fetchImpl);
  return expiresAt;
}

// 만료 임박(refreshBeforeDays 이내)이면 재교환해 저장하고 최신 토큰을 반환한다.
// 자동 갱신 워크플로·수집 직전 호출용. 자격증명은 인자로만 받고 저장하지 않는다.
export async function ensureFreshToken(config, { kind, appId, appSecret, refreshBeforeDays = 7 }, fetchImpl = fetch, now = Date.now()) {
  const current = await loadMetaToken(config, kind, fetchImpl);
  if (!current || !current.token) throw new Error(`meta_tokens에 '${kind}' 토큰 없음 — 최초 교환(scripts/meta-token-exchange) 필요`);
  const expiresMs = Date.parse(current.expires_at || '');
  const thresholdMs = now + refreshBeforeDays * 24 * 3600 * 1000;
  if (Number.isFinite(expiresMs) && expiresMs > thresholdMs) {
    return { token: current.token, refreshed: false, expiresAt: current.expires_at };
  }
  // 만료 임박 → 현재 장기 토큰으로 재교환(연장).
  const { token, expiresInSec } = await exchangeLongLivedToken({ token: current.token, appId, appSecret, graphBase: graphBase(config) }, fetchImpl);
  const expiresAt = await saveMetaToken(config, kind, token, expiresInSec, fetchImpl, now);
  return { token, refreshed: true, expiresAt };
}
