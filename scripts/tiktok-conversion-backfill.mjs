import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadTikTokAdsConfig } from '../src/tiktok-ads.js';
import {
  augustConversionLookbackDays,
  encryptConversionExport,
  runTikTokConversionBackfill,
} from '../src/tiktok-conversion-backfill.js';

const CONFIRMATION = 'HIDE_TIKTOK_CONVERSION_AUGUST_2026';
const dryRun = String(process.env.TIKTOK_CONVERSION_DRY_RUN || 'true').toLowerCase() !== 'false';
if (!dryRun && String(process.env.TIKTOK_CONVERSION_HIDE_CONFIRM || '') !== CONFIRMATION) {
  throw new Error(`Live conversion hide requires TIKTOK_CONVERSION_HIDE_CONFIRM=${CONFIRMATION}`);
}

const base = loadTikTokAdsConfig(process.env);
const now = Date.now();
const config = {
  ...base,
  dryRun: true,
  tiktokCampaignNameFilter: '전환',
  tiktokAdsLookbackDays: augustConversionLookbackDays(now),
  tiktokAdsMaxCommentsPerAdgroup: 1000,
  tiktokAdsAlertAfter: '',
};
const result = await runTikTokConversionBackfill(config, { dryRun, now });
const payload = {
  generatedAt: new Date().toISOString(),
  scope: { platform: '틱톡', campaignNameContains: '전환', monthKst: '2026-08' },
  summary: result.summary,
  rows: result.rows,
};
const encrypted = encryptConversionExport(payload, process.env.TIKTOK_CONVERSION_EXPORT_PUBLIC_KEY_B64);
const outputPath = path.resolve(process.env.TIKTOK_CONVERSION_EXPORT_PATH || 'outputs/tiktok-conversion-2026-08.enc.json');
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(encrypted), 'utf8');

// 공개 Actions 로그에는 댓글·comment_id·소재명을 쓰지 않고 집계만 남긴다.
console.log(JSON.stringify(result.summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const s = result.summary;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    '## TikTok 전환 캠페인 8월 부정댓글 일회성 처리',
    '',
    `- 모드: ${dryRun ? '읽기 전용' : '숨김 + 실제 상태 검증'}`,
    `- 캠페인 / 광고 / 광고그룹: ${s.campaigns} / ${s.ads} / ${s.adgroups}`,
    `- API 원본 댓글 / 부정 후보: ${s.rawComments} / ${s.negativeCandidates}`,
    `- 실제 HIDDEN / 공개 잔여 / 조회 누락: ${s.hidden} / ${s.visible} / ${s.missing}`,
    `- API 실패: ${s.apiFailures}`,
    '',
    '> 댓글 원문과 식별자는 RSA+AES 암호화 파일에만 저장되며 로그에는 남지 않습니다.',
    '',
  ].join('\n'), 'utf8');
}
