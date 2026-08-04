// 매일 실행: Meta 장기토큰이 만료 임박(기본 7일 이내)이면 재교환해 60일 연장.
// env: META_APP_ID, META_APP_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { ensureFreshToken } from '../src/meta-token.js';

const kind = process.env.META_TOKEN_KIND || 'ig_ads';
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
const config = { supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY };
if (!appId || !appSecret || !config.supabaseUrl || !config.supabaseKey) {
  console.error('META_APP_ID / META_APP_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요');
  process.exit(1);
}
try {
  const r = await ensureFreshToken(config, { kind, appId, appSecret, refreshBeforeDays: 7 });
  console.log(`[meta-token] '${kind}' ${r.refreshed ? '갱신함' : '갱신 불필요'} — 만료 ${r.expiresAt}`);
} catch (e) {
  console.error(`[meta-token] 갱신 실패: ${e.message}`);
  process.exit(1);
}
