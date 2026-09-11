// 내부 DB 라벨로 분류기 few-shot 예시셋을 갱신한다. 사람이 남긴 판정
// ([무시]=정상, 숨김/차단=부정)에서 카테고리 균형·중복 제거로 대표 예시를 뽑아
// src/classifier-exemplars.json에 쓴다. 이 파일이 바뀌면 classifier_hash가 달라져
// 캐시가 무효화되고 다음 회차부터 새 예시로 분류가 보정된다(주간 잡이 커밋).
// ⚠️ 미탐(진짜 악플 놓침)이 최악이므로 정상·부정을 균형 있게 담는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const NORMAL_DECISIONS = ['false_positive', 'ignore', 'unhide'];
const NEGATIVE_DECISIONS = ['hidden', 'hide', 'complete'];

function envFrom(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function loadEnv() {
  const env = { ...process.env };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const dotenv = envFrom(readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8'));
      for (const [k, v] of Object.entries(dotenv)) if (!env[k]) env[k] = v;
    } catch { /* no .env (CI uses real env) */ }
  }
  return env;
}

function clean(v) { return String(v == null ? '' : v).trim(); }

function required(env, name) {
  const v = clean(env[name]);
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

// 카테고리 라운드로빈으로 다양성 확보 + 중복 제거 + 짧게. cap개까지.
export function curate(rows, cap) {
  const byCategory = new Map();
  const seen = new Set();
  for (const row of rows) {
    const text = clean(row.comment_text).replace(/\s+/g, ' ').slice(0, 70);
    if (!text || text.length < 2) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const category = clean(row.category) || '(미분류)';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(text);
  }
  const buckets = [...byCategory.values()];
  const out = [];
  for (let i = 0; out.length < cap && buckets.some((b) => b.length); i += 1) {
    for (const bucket of buckets) {
      if (out.length >= cap) break;
      if (bucket.length) out.push(bucket.shift());
    }
    if (i > cap + 5) break;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function loadLabeled(env, decisions, sinceIso) {
  const base = required(env, 'SUPABASE_URL').replace(/\/$/, '');
  const key = required(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${base}/rest/v1/negative_comment_alerts`
      + '?select=category,comment_text,review_decision,reviewed_at'
      + `&review_decision=in.(${decisions.join(',')})`
      + `&reviewed_at=gte.${encodeURIComponent(sinceIso)}`
      + `&order=reviewed_at.desc&offset=${offset}&limit=1000`;
    const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Supabase load failed (${res.status})`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function main() {
  const env = loadEnv();
  const lookbackDays = Number(env.CLASSIFIER_EXEMPLAR_LOOKBACK_DAYS || 120);
  const cap = Number(env.CLASSIFIER_EXEMPLAR_CAP || 25);
  const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const normalRows = await loadLabeled(env, NORMAL_DECISIONS, sinceIso);
  const negativeRows = await loadLabeled(env, NEGATIVE_DECISIONS, sinceIso);
  const normal = curate(normalRows, cap);
  const negative = curate(negativeRows, cap);
  // 미탐 방지: 정상만 있고 부정이 없으면 예시 주입을 비활성(빈 셋)한다.
  const payload = (normal.length && negative.length)
    ? { generatedAt: new Date().toISOString().slice(0, 10), lookbackDays, normal, negative }
    : { generatedAt: new Date().toISOString().slice(0, 10), lookbackDays, normal: [], negative: [] };
  const outPath = fileURLToPath(new URL('../src/classifier-exemplars.json', import.meta.url));
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    normalCandidates: normalRows.length,
    negativeCandidates: negativeRows.length,
    normal: payload.normal.length,
    negative: payload.negative.length,
    out: 'src/classifier-exemplars.json',
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
