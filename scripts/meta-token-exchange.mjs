// 최초 1회: 단기(또는 장기) 토큰을 장기 토큰으로 교환해 Supabase meta_tokens에 저장.
// 자격증명은 env로만 받는다(코드/로그에 남기지 않음). 실행:
//   META_SHORT_TOKEN=... META_APP_ID=... META_APP_SECRET=... \
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/meta-token-exchange.mjs
import { exchangeLongLivedToken, saveMetaToken } from '../src/meta-token.js';

const kind = process.env.META_TOKEN_KIND || 'ig_ads';
const shortToken = process.env.META_SHORT_TOKEN;
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
const config = { supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY };

if (!shortToken || !appId || !appSecret) {
  console.error('META_SHORT_TOKEN / META_APP_ID / META_APP_SECRET 필요');
  process.exit(1);
}
if (!config.supabaseUrl || !config.supabaseKey) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요');
  process.exit(1);
}

const { token, expiresInSec } = await exchangeLongLivedToken({ token: shortToken, appId, appSecret });
const expiresAt = await saveMetaToken(config, kind, token, expiresInSec);
// 토큰 값은 출력하지 않는다. 만료일과 남은 일수만.
const days = Math.round(expiresInSec / 86400);
console.log(`[meta-token] '${kind}' 장기토큰 저장 완료. 만료 ${expiresAt} (약 ${days}일).`);
