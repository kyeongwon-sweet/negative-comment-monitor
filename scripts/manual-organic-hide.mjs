// 수동 owned/organic 부정댓글 숨김 표준 절차(재발방지).
//
// 왜 필요한가: 분류기 미탐분을 손으로 숨길 때, slack_ts를 얻으려 채널 최상위에
// 단독 카드를 올리거나(스레드 규칙 위반) 컬럼명을 잘못 넣는 실수가 반복됐다.
// 이 스크립트는 항상 ensureDailyThread로 (상품×카테고리) 정규 데일리 스레드를
// 확보해 그 '스레드 답글'로 알림을 남기고, 그 답글 ts를 공유 slack_ts로 써서
// negative_comment_alerts에 올바른 스키마로 적재한다. 숨김 실행은 owner OAuth가
// 필요하므로 여기서 직접 하지 않고, 마지막에 실행할 gh 명령을 출력한다.
//
// 사용법:
//   node scripts/manual-organic-hide.mjs <batch.json> [--commit]
//   (기본 DRY-RUN: 실제 Slack/DB 쓰기 없이 계획만 출력. --commit 시 실제 실행)
//
// batch.json 형식:
// {
//   "postUrl": "https://www.youtube.com/watch?v=...",
//   "platform": "youtube",              // youtube | instagram | tiktok
//   "productName": "JD",                 // productGroup으로 라벨 산출(예: JD→쫀득바)
//   "channelCategory": "소유 YouTube",   // 스레드 스코프 카테고리
//   "channelName": "먹는김에",
//   "category": "브랜드 적대/조롱",       // 알림 category(선택)
//   "assignee": "U0B2Y0ZC8QZ",           // 스레드 담당자 멘션(선택, 없으면 멘션 없음)
//   "kstDate": "2026-09-22",             // 선택, 기본 오늘 KST
//   "comments": [ { "id": "Ug...", "author": "@name", "text": "..." }, ... ]
// }

import fs from 'node:fs';
import { commentFingerprint } from '../src/dedup.js';
import { ensureDailyThread } from '../src/threads.js';
import { productGroup, productLabel } from '../src/slack.js';

function loadEnv() {
  // .env가 있으면 병합(로컬), 없으면 process.env만.
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      if (!(key in env)) env[key] = line.slice(i + 1).trim();
    }
  } catch { /* .env 없음: process.env 사용 */ }
  return env;
}

function kstToday() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

async function main() {
  const batchPath = process.argv[2];
  const commit = process.argv.includes('--commit');
  if (!batchPath) throw new Error('배치 JSON 경로를 넘겨주세요: node scripts/manual-organic-hide.mjs <batch.json> [--commit]');
  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  const env = loadEnv();

  const config = {
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackChannelId: String(env.SLACK_CHANNEL_ID || 'C0BHD9S69JA').trim(),
  };
  for (const k of ['supabaseUrl', 'supabaseKey', 'slackBotToken']) {
    if (!config[k]) throw new Error(`환경변수 누락: ${k}`);
  }

  const platform = String(batch.platform || 'youtube').toLowerCase();
  const postUrl = String(batch.postUrl || '').trim();
  const channelCategory = String(batch.channelCategory || '').trim();
  const productName = String(batch.productName || '').trim();
  const label = productLabel(productGroup(productName));
  const scopeKey = `${label}|${channelCategory}`;
  const kstDate = String(batch.kstDate || kstToday()).trim();
  const target = { platform, url: postUrl };
  const comments = Array.isArray(batch.comments) ? batch.comments : [];
  if (!postUrl || !channelCategory || !comments.length) {
    throw new Error('batch.postUrl / channelCategory / comments 는 필수입니다.');
  }

  const rows = comments.map((c) => ({
    platform,
    source: null, // organic(소유/위성/협찬 등 비광고). 광고면 이 스크립트 대상 아님.
    post_url: postUrl,
    comment_id: String(c.id || '').trim(),
    comment_text: String(c.text || ''),
    fingerprint: commentFingerprint(target, { platform, id: String(c.id || '').trim() }),
    category: String(batch.category || '브랜드 적대/조롱'),
    channel_category: channelCategory,
    channel_name: String(batch.channelName || ''),
    product_name: productName,
    author_display_name: String(c.author || ''),
    slack_channel_id: config.slackChannelId,
    review_decision: null,
  }));

  console.log(`대상: ${scopeKey} · ${platform} · ${rows.length}건 (kst ${kstDate})`);
  console.log(`스레드 스코프키: ${scopeKey}${batch.assignee ? ` · 담당자 <@${batch.assignee}>` : ' · (담당자 멘션 없음)'}`);

  if (!commit) {
    console.log('\n[DRY-RUN] 실제 쓰기 없음. 계획:');
    console.log(' 1) ensureDailyThread 로 정규 스레드 확보(없으면 생성)');
    console.log(' 2) 요약을 스레드 답글로 게시');
    console.log(' 3) 위 답글 ts를 slack_ts로 17행 적재');
    console.log(' 4) 아래 gh 명령으로 owner OAuth 숨김 실행');
    console.log(`    gh workflow run youtube-owner-comment-hide.yml -f slack_channel_id=${config.slackChannelId} -f slack_ts=<답글ts> -f alert_scope=organic_satellite`);
    console.log('\n실행하려면 --commit 을 붙이세요.');
    return;
  }

  // 1) 정규 데일리 스레드(상품×카테고리) 확보 — 절대 최상위 단독 카드 금지.
  const parentTs = await ensureDailyThread(config, {
    kstDate, scopeKey, productLabel: label, category: channelCategory, assignee: String(batch.assignee || ''),
  });
  if (!parentTs) throw new Error('ensureDailyThread 실패(스레드 미확보) — 최상위 게시로 폴백하지 않고 중단.');
  console.log('스레드 parent ts:', parentTs);

  // 2) 요약을 스레드 답글로.
  const summary = `⚠️ *[${label}] ${channelCategory} 미탐 부정댓글 수동 숨김* — ${batch.channelName || ''}\n`
    + `게시물: ${postUrl}\n분류기 미탐 ${rows.length}건 일괄 숨김 처리.`;
  const rep = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slackBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, thread_ts: parentTs, text: summary }),
  });
  const rj = await rep.json();
  if (!rj.ok) throw new Error(`스레드 답글 실패: ${rj.error}`);
  console.log('스레드 답글 ts:', rj.ts);

  // 3) 답글 ts를 공유 slack_ts로 적재.
  const withTs = rows.map((r) => ({ ...r, slack_ts: rj.ts, alerted_at: new Date().toISOString() }));
  const H = { apikey: config.supabaseKey, authorization: `Bearer ${config.supabaseKey}`, 'content-type': 'application/json' };
  const ins = await fetch(`${config.supabaseUrl}/rest/v1/negative_comment_alerts`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(withTs),
  });
  const ij = await ins.json();
  if (!Array.isArray(ij)) throw new Error(`적재 실패: ${JSON.stringify(ij).slice(0, 200)}`);
  console.log(`적재 완료: ${ij.length}행, slack_ts=${rj.ts}`);

  console.log('\n다음(숨김 실행):');
  console.log(`  gh workflow run youtube-owner-comment-hide.yml -f slack_channel_id=${config.slackChannelId} -f slack_ts=${rj.ts} -f alert_scope=organic_satellite`);
}

main().catch((err) => { console.error('실패:', err.message); process.exit(1); });
