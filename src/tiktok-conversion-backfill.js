import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { buildTikTokAdEntries } from './tiktok-ads.js';
import { hideWithIsolation, verifyHiddenTikTokComments } from './tiktok-bulk-hide.js';

const AUGUST_PREFIX = '2026-08-';

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function productFromConversionAdTitle(adTitle, fallback = 'JD') {
  const match = String(adTitle || '').match(/(?:^|_)([^_]+)_전환(?:_|$)/i);
  return String(match?.[1] || fallback || 'JD').trim();
}

export function formatTikTokKst(timestamp) {
  const raw = String(timestamp || '').trim();
  let ms;
  if (/^\d{9,13}$/.test(raw)) ms = Number(raw) * (raw.length <= 10 ? 1000 : 1);
  else ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function reasonForRisk(risk) {
  return String(risk?.reason || risk?.matchedTerms?.join(', ') || '부정 표현').trim();
}

export function collectAugustConversionCandidates(entries, risksPerEntry, config) {
  const byCommentId = new Map();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    for (let commentIndex = 0; commentIndex < entry.comments.length; commentIndex += 1) {
      const comment = entry.comments[commentIndex];
      const risk = risksPerEntry[entryIndex]?.[commentIndex] || { alert: false };
      if (!risk.alert) continue;
      const detectedAt = formatTikTokKst(comment.timestamp);
      if (!detectedAt.startsWith(AUGUST_PREFIX)) continue;
      const commentId = String(comment.id || '').trim();
      if (!commentId || byCommentId.has(commentId)) continue;
      byCommentId.set(commentId, {
        commentId,
        row: {
          '상품': productFromConversionAdTitle(entry.target.adTitle, config.tiktokAdsProductName),
          '채널': '전환 광고',
          '악플_분류_이유': reasonForRisk(risk),
          '게시글_링크': String(entry.target.url || ''),
          '악플_내용': String(comment.text || ''),
          '분류': String(risk.category || '부정언급'),
          '플랫폼': '틱톡',
          '채널명_계정': String(entry.target.channelName || 'TikTok 광고'),
          '소재명': String(entry.target.adTitle || ''),
          '처리상태': '숨김대상(읽기전용)',
          '탐지일시_KST': detectedAt,
        },
      });
    }
  }
  return [...byCommentId.values()];
}

function moderationConfig(config) {
  return {
    ...config,
    apiBase: config.tiktokApiBase,
    accessToken: config.tiktokAccessToken,
    advertiserId: config.tiktokAdvertiserId,
    operation: 'HIDDEN',
    adType: 'BIDDING',
    batchSize: 20,
  };
}

export async function runTikTokConversionBackfill(
  config,
  { dryRun = true, fetchImpl = fetch, now = Date.now(), sleep = wait } = {},
) {
  const collected = await buildTikTokAdEntries(config, fetchImpl, now);
  const stats = { calls: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const risks = await classifyTargetsBatched(collected.entries, config, undefined, stats, fetchImpl);
  const candidates = collectAugustConversionCandidates(collected.entries, risks, config);
  const ids = candidates.map((item) => item.commentId);
  const failures = [];
  let verification = { hiddenIds: [], visibleIds: ids, missingIds: [], campaigns: 0, ads: 0, adgroups: 0 };

  if (!dryRun && ids.length) {
    const bulkConfig = moderationConfig(config);
    for (const batch of chunk(ids, 20)) {
      await hideWithIsolation(bulkConfig, batch, fetchImpl, sleep, { failed: failures });
      if (config.tiktokAdsRequestDelayMs > 0) await sleep(config.tiktokAdsRequestDelayMs);
    }
    await sleep(2000);
    verification = await verifyHiddenTikTokComments(bulkConfig, ids, fetchImpl, now);
    // 전파 지연·일시 실패로 아직 공개인 댓글은 한 번만 재시도하고 다시 지상진실을 확인한다.
    if (verification.visibleIds.length) {
      for (const batch of chunk(verification.visibleIds, 20)) {
        await hideWithIsolation(bulkConfig, batch, fetchImpl, sleep, { failed: failures });
      }
      await sleep(2000);
      verification = await verifyHiddenTikTokComments(bulkConfig, ids, fetchImpl, now);
    }
  }

  const hidden = new Set(verification.hiddenIds.map(String));
  const rows = candidates.map(({ commentId, row }) => ({
    ...row,
    '처리상태': dryRun ? '숨김대상(읽기전용)' : (hidden.has(String(commentId)) ? '숨김완료' : '숨김실패'),
  }));
  return {
    rows,
    summary: {
      dryRun,
      campaigns: collected.campaigns,
      ads: collected.ads,
      adgroups: collected.adgroups,
      rawComments: collected.comments,
      negativeCandidates: candidates.length,
      hidden: dryRun ? 0 : verification.hiddenIds.length,
      visible: dryRun ? 0 : verification.visibleIds.length,
      missing: dryRun ? 0 : verification.missingIds.length,
      apiFailures: failures.length,
      llm: {
        calls: stats.calls,
        reviewed: stats.reviewed,
        cacheHits: stats.cacheHits,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
      },
    },
  };
}

export function encryptConversionExport(payload, publicKeyBase64) {
  const publicKey = Buffer.from(String(publicKeyBase64 || ''), 'base64').toString('utf8');
  if (!publicKey.includes('BEGIN PUBLIC KEY')) throw new Error('Missing or invalid export public key');
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = publicEncrypt({
    key: publicKey,
    oaepHash: 'sha256',
    padding: constants.RSA_PKCS1_OAEP_PADDING,
  }, key);
  return {
    version: 1,
    algorithm: 'RSA-OAEP-SHA256+A256GCM',
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
