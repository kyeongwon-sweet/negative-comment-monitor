// 분류기 오탐([무시]) 주간 감사 워치독. 사람이 false_positive/ignore로 내린 댓글을
// 최근 N일 기준으로 모아 카테고리·오탐사유·예시로 요약해 Slack에 보고한다. 자동 재학습은
// 하지 않는다(프롬프트 개선은 사람이 반영) — 이 리포트는 그 수동 루프를 반자동화하는 신호다.
// 원문(comment_text)은 이미 알림 시점에 negative_comment_alerts에 있으므로 그대로 읽는다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IGNORE_DECISIONS = ['false_positive', 'ignore'];
// review.js FALSE_POSITIVE_REASONS와 라벨 일치.
const FP_REASON_LABELS = {
  unrelated: '제품 무관',
  positive_neutral: '긍정/중립',
  joke_meme: '농담/밈',
  insult_other: '타인 대상 욕설',
  competitor_neutral: '경쟁제품 중립 비교',
  other: '기타',
};

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function required(env, name) {
  const value = clean(env[name]);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function loadFalsePositiveAuditConfig(env = process.env) {
  return {
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackChannelId: clean(env.SLACK_CHANNEL_ID),
    lookbackDays: positiveInt(env.FALSE_POSITIVE_AUDIT_LOOKBACK_DAYS, 7, 90),
    minCount: positiveInt(env.FALSE_POSITIVE_AUDIT_MIN_COUNT, 5, 100000),
    maxSamplesPerCategory: positiveInt(env.FALSE_POSITIVE_AUDIT_MAX_SAMPLES, 3, 10),
    notifySlack: clean(env.FALSE_POSITIVE_AUDIT_NOTIFY_SLACK || 'true').toLowerCase() !== 'false',
    // 분류기 튜닝 담당(인지광고 담당자=기본 멘션). 없으면 멘션 생략.
    mention: clean(env.SLACK_ASSIGNEE_AWARENESS || env.SLACK_ASSIGNEE_OTHER || ''),
  };
}

function supabaseHeaders(config) {
  return { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
}

// 최근 sinceIso 이후 사람이 [무시]/오탐 처리한 알림 전량(페이지네이션).
export async function loadFalsePositiveCorpus(config, sinceIso, fetchImpl = fetch) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${config.supabaseUrl}/rest/v1/negative_comment_alerts`
      + '?select=id,platform,source,category,comment_text,reason,false_positive_reason,product_name,channel_category,reviewed_at,review_decision'
      + `&review_decision=in.(${IGNORE_DECISIONS.join(',')})`
      + `&reviewed_at=gte.${encodeURIComponent(sinceIso)}`
      + `&order=reviewed_at.desc&offset=${offset}&limit=1000`;
    const response = await fetchImpl(url, { headers: supabaseHeaders(config) });
    if (!response.ok) throw new Error(`False-positive corpus load failed (${response.status})`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function sortDesc(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function summarizeFalsePositiveCorpus(rows, { maxSamplesPerCategory = 3 } = {}) {
  const byCategory = {};
  const byPlatform = {};
  const byReason = {};
  const byProduct = {};
  const samples = {};
  for (const row of rows || []) {
    const category = clean(row.category) || '(미분류)';
    byCategory[category] = (byCategory[category] || 0) + 1;
    const platform = clean(row.platform) || '(none)';
    byPlatform[platform] = (byPlatform[platform] || 0) + 1;
    const reasonKey = clean(row.false_positive_reason);
    const reason = FP_REASON_LABELS[reasonKey] || reasonKey || '(미기입)';
    byReason[reason] = (byReason[reason] || 0) + 1;
    const product = clean(row.product_name) || '(none)';
    byProduct[product] = (byProduct[product] || 0) + 1;
    if (!samples[category]) samples[category] = [];
    if (samples[category].length < maxSamplesPerCategory) {
      const text = clean(row.comment_text).replace(/\s+/g, ' ').slice(0, 60);
      if (text) samples[category].push(text);
    }
  }
  return {
    total: (rows || []).length,
    byCategory: sortDesc(byCategory),
    byPlatform: sortDesc(byPlatform),
    byReason: sortDesc(byReason),
    byProduct: sortDesc(byProduct),
    samples,
  };
}

export function buildFalsePositiveAuditText(summary, { lookbackDays = 7, mention = '' } = {}) {
  if (!summary || !summary.total) return '';
  const mentionPrefix = mention ? `<@${mention}> ` : '';
  const lines = [];
  lines.push(`:mag: *분류기 오탐([무시]) 감사 — 최근 ${lookbackDays}일*`);
  lines.push(`${mentionPrefix}사람이 [무시]/오탐 처리한 댓글 *${summary.total}건*. 아래 유형이 반복 과탐되면 프롬프트(src/llm.js) 규칙을 완화하세요.`);
  lines.push('');
  lines.push('*카테고리별 (과탐 많은 순)*');
  for (const [category, count] of summary.byCategory.slice(0, 8)) lines.push(`• ${category}: ${count}`);
  lines.push('');
  lines.push('*오탐 사유*');
  for (const [reason, count] of summary.byReason.slice(0, 8)) lines.push(`• ${reason}: ${count}`);
  lines.push('');
  lines.push('*상위 카테고리 예시 (원문 일부)*');
  for (const [category] of summary.byCategory.slice(0, 4)) {
    const examples = (summary.samples[category] || []).map((text) => `“${text}”`).join(' / ');
    if (examples) lines.push(`• [${category}] ${examples}`);
  }
  lines.push('');
  lines.push(`플랫폼: ${summary.byPlatform.map(([platform, count]) => `${platform} ${count}`).join(', ')}`);
  return lines.join('\n').slice(0, 39_000);
}

async function postSlack(config, text, fetchImpl) {
  if (!config.notifySlack || !config.slackBotToken || !config.slackChannelId) return false;
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slackBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: config.slackChannelId, text }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Slack false-positive audit failed (${response.status})`);
  return true;
}

export async function runFalsePositiveAudit(
  config = loadFalsePositiveAuditConfig(), fetchImpl = fetch, now = Date.now(),
) {
  const sinceIso = new Date(now - config.lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await loadFalsePositiveCorpus(config, sinceIso, fetchImpl);
  const summary = summarizeFalsePositiveCorpus(rows, { maxSamplesPerCategory: config.maxSamplesPerCategory });
  // 표본이 임계 미만이면 조용히 종료(주간 노이즈 방지). 결과워치독은 count>0 신호만 낸다.
  const belowThreshold = summary.total < config.minCount;
  let posted = false;
  if (!belowThreshold) {
    const text = buildFalsePositiveAuditText(summary, { lookbackDays: config.lookbackDays, mention: config.mention });
    posted = await postSlack(config, text, fetchImpl);
  }
  return {
    lookbackDays: config.lookbackDays,
    total: summary.total,
    minCount: config.minCount,
    belowThreshold,
    posted,
    byCategory: summary.byCategory,
    byReason: summary.byReason,
    byProduct: summary.byProduct,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runFalsePositiveAudit()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
