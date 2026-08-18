import { loadMetaAdsConfig } from './meta-ads.js';
import { loadTikTokAdsConfig } from './tiktok-ads.js';
import { autoHideMetaAwareness, autoHideTikTokAwareness } from './awareness-auto-hide.js';

const confirmed = String(process.env.AWARENESS_AUTO_HIDE_CONFIRM || '') === 'AUTO_HIDE_ALL_AWARENESS_NEGATIVES';
if (!confirmed) throw new Error('Missing AWARENESS_AUTO_HIDE_CONFIRM');

const options = { includeHumanDecisions: true };
const meta = await autoHideMetaAwareness(loadMetaAdsConfig(), fetch, Date.now(), options);
const tiktok = await autoHideTikTokAwareness(loadTikTokAdsConfig(), fetch, Date.now(), options);
console.log(JSON.stringify({ meta, tiktok }, null, 2));
if (meta.failed || tiktok.failed || meta.slack.failed || tiktok.slack.failed) process.exitCode = 1;
