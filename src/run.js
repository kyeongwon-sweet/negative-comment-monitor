import { loadConfig } from './config.js';
import { runActor } from './apify.js';
import { fetchTargets, submitResult } from './gas.js';
import { normalizeDataset } from './normalize.js';
import { detectPlatform, filterEligibleSponsorships, groupApifyTargets } from './routing.js';
import { classifyNegativeComment } from './classify.js';
import { classifyCommentsLLM } from './llm.js';
import { sendAlert } from './slack.js';
import { filterDueTargets } from './schedule.js';
import { loadCommentCounts, filterChangedTargets, recordChecks, summarizeDelta, extractPostKey } from './delta.js';
import { commentFingerprint, loadRecentlyAlertedPostKeys, loadSeenFingerprints, recordAlert } from './dedup.js';

export async function runMonitor(config = loadConfig()) {
  const runNow = Date.now();
  const rawTargets = await fetchTargets(config);
  const eligibleTargets = filterEligibleSponsorships(rawTargets, config.excludedChannelCategory);
  const eligibleMappedTargets = eligibleTargets.map((target) => ({
    ...target,
    platform: String(target.platform || detectPlatform(target.url)).toLowerCase(),
    // 감시 대상 = 라라스윗 협찬 게시물 → 브랜드 컨텍스트 부여(캡션에 브랜드명이 없어도
    // 제품 관련 부정댓글을 entity 게이트가 놓치지 않게 함). brandName은 classify가 postContext로 읽음.
    brandName: target.brandName || config.brandContext,
  }));
  // 일반 게시물은 업로드 7일 후 제외. 부스팅 게시물은 기간과 무관하게 일일 확인.
  const windowCutoff = runNow - config.trackingDays * 864e5;
  const windowedTargets = eligibleMappedTargets.filter((t) => {
    const d = Date.parse(t.uploadedAt || t.publishedAt || t.postedAt || '');
    return Boolean(t.isBoosted) || !Number.isFinite(d) || d >= windowCutoff;
  });

  // Supabase의 마지막 확인·최근 알림 이력을 스케줄 입력으로 연결한다.
  let counts = {};
  let scheduledTargets = windowedTargets;
  if (config.supabaseUrl && config.supabaseKey) {
    try {
      counts = await loadCommentCounts(config, windowedTargets);
      const recentAlerts = await loadRecentlyAlertedPostKeys(config, 3 * 60 * 60 * 1000, fetch, runNow);
      scheduledTargets = windowedTargets.map((target) => ({
        ...target,
        lastCollectedAt: target.lastCollectedAt || counts[target.url]?.lastCheckedAt || '',
        recentNegativeDetectedAt: recentAlerts.get(extractPostKey(target.url)) || target.recentNegativeDetectedAt || '',
      }));
    } catch (error) {
      console.error('[schedule] Supabase 이력 조회 실패 — GAS 시각 정보로 진행:', error.message);
    }
  }
  const dueTargets = filterDueTargets(scheduledTargets, runNow);

  // 정기 확인은 댓글 수 증가분만 과금한다. 최근 부정댓글이 있는 집중 대상은
  // 대시보드 댓글 수 갱신을 기다리지 않고 15분마다 직접 수집한다.
  let targets = dueTargets;
  let deltaSkipped = 0;
  let summary_deltaBreakdown = null;
  if (config.deltaEnabled && config.supabaseUrl && config.supabaseKey) {
    try {
      if (!Object.keys(counts).length) counts = await loadCommentCounts(config, dueTargets);
      const changed = filterChangedTargets(dueTargets, counts);
      const intensive = dueTargets.filter((target) => {
        const detected = Date.parse(target.recentNegativeDetectedAt || '');
        return Number.isFinite(detected) && runNow - detected <= 3 * 60 * 60 * 1000;
      });
      targets = [...new Map([...changed, ...intensive].map((target) => [target.url, target])).values()];
      deltaSkipped = dueTargets.length - targets.length;
      summary_deltaBreakdown = summarizeDelta(dueTargets, counts);
      if (summary_deltaBreakdown.noSignal) {
        console.error(`[delta] 댓글 수 신호 없어 스킵된 대상 ${summary_deltaBreakdown.noSignal}건 — 커버리지 갭(대시보드 comments_count 미수집/URL 미매칭)`);
      }
    } catch (error) {
      console.error('[delta] 댓글 수 조회 실패 — 델타 스킵 없이 진행:', error.message);
    }
  }

  const groups = groupApifyTargets(targets);
  const scrapedTargets = [];
  let sentAlerts = 0;
  const summary = {
    fetchedTargets: rawTargets.length,
    excludedTargets: rawTargets.length - eligibleMappedTargets.length,
    windowedTargets: windowedTargets.length,
    dueTargets: dueTargets.length,
    deltaSkipped,
    eligibleTargets: targets.length,
    graphSkipped: targets.length,
    slackChannelId: config.slackChannelId,
    dryRun: config.dryRun,
    platforms: {},
  };

  for (const [platform, platformTargets] of Object.entries(groups)) {
    summary.graphSkipped -= platformTargets.length;
    if (!platformTargets.length) continue;
    try {
      const items = await runActor(config, platform, platformTargets);
      const normalized = normalizeDataset(platform, items, '');
      const single = platformTargets.length === 1;   // 단일 대상 배치면 URL 없는 댓글도 그 대상 소속
      for (const rawTarget of platformTargets) {
        const target = { ...rawTarget, caption: rawTarget.caption || (counts[rawTarget.url] || {}).caption || '' };
        const targetKey = extractPostKey(target.url);
        const targetComments = normalized.filter((comment) => {
          const ck = extractPostKey(comment.url);
          if (ck && targetKey) return ck === targetKey;        // 게시물 ID로 정확 매칭(중복 귀속 방지)
          if (single) return true;                              // 단일 대상 배치 예외
          return comment.url && comment.url === target.url;     // 그 외 정확 URL 일치만
        });
        // 1순위 LLM(의미 판단), 없거나 실패 시 키워드 분류로 폴백.
        const llm = await classifyCommentsLLM(targetComments, config);
        const classified = targetComments.map((comment, idx) => ({
          ...comment,
          risk: (llm && llm[idx]) ? { ...llm[idx], entity: { matched: true }, engine: 'llm' }
                                  : { ...classifyNegativeComment(comment, target), engine: 'keyword' },
        }));
        const alerts = classified.filter((comment) => comment.risk.alert);
        const fingerprints = alerts.map((comment) => commentFingerprint(target, comment));
        const seenFingerprints = config.dryRun ? new Set() : await loadSeenFingerprints(config, fingerprints);
        // (가) injibot이 버튼 포함으로 채널에 발송. DRY_RUN이면 실제 발송 없이 카운트/로그만.
        for (let alertIndex = 0; alertIndex < alerts.length; alertIndex += 1) {
          const comment = alerts[alertIndex];
          const fingerprint = fingerprints[alertIndex];
          if (seenFingerprints.has(fingerprint)) {
            console.error(`[dedup] already alerted: ${target.platform} | ${comment.id || fingerprint.slice(0, 12)}`);
            continue;
          }
          console.error(`[alert] ${target.platform} | ${comment.risk.category} | ${(comment.text || '').replace(/\s+/g, ' ').slice(0, 50)}`);
          if (!config.dryRun) {
            const slackResult = await sendAlert(config, target, comment);
            await recordAlert(config, target, comment, fingerprint, slackResult.ts);
          }
          sentAlerts += 1;
        }
        scrapedTargets.push(target);   // 스크레이프 성공분만 last_count 갱신 대상
      }
      summary.platforms[platform] = { targets: platformTargets.length, items: normalized.length, ok: true };
    } catch (error) {
      // 실패 시 last_count 미갱신 → 다음 실행에서 재시도됨(부정댓글 없음으로 오보하지 않음)
      summary.platforms[platform] = { targets: platformTargets.length, items: 0, ok: false, error: error.message };
    }
  }
  summary.sentAlerts = sentAlerts;

  if (summary_deltaBreakdown) summary.deltaBreakdown = summary_deltaBreakdown;
  // 성공적으로 스크레이프한 게시물의 댓글 수 기준선 갱신(다음 실행부터 증가분만).
  if (config.deltaEnabled && config.supabaseUrl && config.supabaseKey && scrapedTargets.length && !config.dryRun) {
    try {
      summary.checksUpdated = await recordChecks(config, scrapedTargets, counts);
    } catch (error) {
      console.error('[delta] last_count 갱신 실패:', error.message);
    }
  }
  const failedPlatforms = Object.entries(summary.platforms)
    .filter(([, result]) => result.ok === false)
    .map(([platform]) => platform);
  if (failedPlatforms.length) {
    throw new Error(`Platform collection failed: ${failedPlatforms.join(', ')}`);
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runMonitor()
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
