import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadTikTokAdsConfig } from '../src/tiktok-ads.js';
import { augustConversionLookbackDays } from '../src/tiktok-conversion-backfill.js';
import { loadYouTubeAdsConfig } from '../src/youtube-ads.js';
import { encryptAugustProductExport, runAugustProductRestore } from '../src/august-product-restore.js';

const CONFIRMATION = 'HIDE_TIKTOK_CONVERSION_AUGUST_2026';
const dryRun = String(process.env.AUGUST_PRODUCT_RESTORE_DRY_RUN || 'true').toLowerCase() !== 'false';
if (!dryRun && String(process.env.AUGUST_PRODUCT_RESTORE_CONFIRM || '') !== CONFIRMATION) {
  throw new Error(`Live conversion hide requires AUGUST_PRODUCT_RESTORE_CONFIRM=${CONFIRMATION}`);
}

const now = Date.now();
const youtube = loadYouTubeAdsConfig(process.env);
const tiktokBase = loadTikTokAdsConfig(process.env);
const tiktok = {
  ...tiktokBase,
  dryRun: true,
  tiktokCampaignNameFilter: '',
  tiktokAdsLookbackDays: augustConversionLookbackDays(now),
  tiktokAdsMaxCommentsPerAdgroup: 1000,
  tiktokAdsAlertAfter: '',
};
const result = await runAugustProductRestore({
  supabaseUrl: youtube.supabaseUrl,
  supabaseKey: youtube.supabaseKey,
  youtube,
  tiktok,
}, { dryRun, now });
const payload = {
  generatedAt: new Date().toISOString(),
  scope: { monthKst: '2026-08', sources: ['youtube_ads', 'tiktok_ads', 'owned_youtube'] },
  summary: result.summary,
  rows: result.rows,
  pintRows: result.pintRows,
};
const encrypted = encryptAugustProductExport(payload, process.env.AUGUST_PRODUCT_EXPORT_PUBLIC_KEY_B64);
const outputPath = path.resolve(process.env.AUGUST_PRODUCT_EXPORT_PATH || 'outputs/august-product-restore-2026-08.enc.json');
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(encrypted), 'utf8');

const s = result.summary;
const safeSummary = {
  dryRun,
  augustAlerts: s.augustAlerts,
  outputRows: s.outputRows,
  pintRows: result.pintRows.length,
  coverage: s.coverage,
  youtubeApi: s.youtubeApi,
  tiktokApi: s.tiktokApi,
  conversion: s.conversion,
};
console.log(JSON.stringify(safeSummary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    '## 2026-08 광고 부정댓글 상품 복원',
    '',
    `- 모드: ${dryRun ? '읽기 전용' : 'TikTok 전환 숨김 + 실제 상태 검증'}`,
    `- 복원 산출 행 / P* 행: ${s.outputRows} / ${result.pintRows.length}`,
    `- YouTube 광고 매칭: ${s.coverage.youtubeAds.mapped}/${s.coverage.youtubeAds.alerts}`,
    `- TikTok 광고 매칭: ${s.coverage.tiktokAds.mapped}/${s.coverage.tiktokAds.alerts}`,
    `- 소유 YouTube 매칭: ${s.coverage.ownerYouTube.mapped}/${s.coverage.ownerYouTube.alerts}`,
    `- TikTok 전환 부정후보 / HIDDEN / 공개잔여: ${s.conversion.negativeCandidates} / ${s.conversion.hidden} / ${s.conversion.visible}`,
    '',
    '> 댓글 원문·댓글 ID·소재명은 RSA+AES 암호화 결과에만 저장되며 공개 로그에는 남지 않습니다.',
    '',
  ].join('\n'), 'utf8');
}
