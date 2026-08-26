import { loadConfig } from './config.js';
import { runActorBatches } from './apify.js';
import { fetchTargets, submitResult } from './gas.js';
import { normalizeDataset } from './normalize.js';
import { detectPlatform, filterEligibleSponsorships, groupApifyTargets } from './routing.js';
import { classifyTargetsBatched } from './hybrid-classify.js';
import { sendAlert, buildViralCopyMessage, postThreadText } from './slack.js';
import { filterDueTargets, isEvergreenCategory, kstDateKey } from './schedule.js';
import { loadCommentCounts, filterChangedTargets, filterBaselineTargets, filterNoSignalRescueTargets, filterDeepScanTargets, filterArchivedOrDeadTargets, recordChecks, summarizeDelta, extractPostKey } from './delta.js';
import { commentFingerprint, loadRecentlyAlertedPostKeys, loadSeenFingerprints, recordAlert } from './dedup.js';
import { estimateUsd } from './pricing.js';
import { computeClassifierHash, purgeCache } from './cache.js';
import { falsePositiveStats } from './review.js';
import { ensureDailyThread, markCompletedThreads, cleanupOrphanedCopyMessages } from './threads.js';
import { assigneeForTarget, productGroup, productLabel, hasProductName, videoAssigneeFromAdTitle } from './slack.js';
import { APIFY_LOW_BALANCE_USD, DEFAULT_COST_THRESHOLDS, estimateApifyUsd, fetchApifyUsage, maybeAlertApifyLow, maybeAlertCosts, postApifyLowWarning, postCostWarning, recordRunCost, runKey, sumDailyCost } from './cost.js';
import { hasAdRunToday } from './ad-common.js';
import { autoHideOrganicSatelliteYouTube } from './youtube-organic-auto-hide.js';
import { recordPlatformOutcome } from './platform-health.js';
import { monitorLlmHealth } from './llm-health.js';

export async function runMonitor(config = loadConfig()) {
  const runNow = Date.now();
  const rawTargets = await fetchTargets(config, fetch, runNow);
  // GAS 전면 실패 시 캐시로 degraded 운영 중이면 하루 1회 Slack 경고(원인=GAS 복구 필요).
  if (rawTargets.degradedFallback && config.supabaseUrl && config.supabaseKey && config.slackBotToken) {
    try {
      const kstDate = kstDateKey(runNow);
      const dkey = `gas-degraded:${kstDate}`;
      if (!(await hasAdRunToday(config, dkey))) {
        const d = rawTargets.degradedFallback;
        const age = d.ageHours != null ? `${d.ageHours.toFixed(1)}시간 전` : '시각 미상';
        await postThreadText(config, undefined, `:warning: *부정댓글 모니터링 degraded 모드* — GAS sponsoredTargets 전면 실패로 캐시된 대상 ${d.count}건(${age} 기준)으로 운영 중입니다. 신규 게시물 반영이 지연되니 GAS 웹앱을 점검·복구해 주세요.`);
        await recordRunCost(config, { runKey: dkey, kstDate, apifyUsd: 0, anthropicUsd: 0 }, fetch);
      }
    } catch (error) {
      console.error('[gas-degraded] 경고 발송 실패(무시):', error.message);
    }
  }
  const missingCategoryTargets = rawTargets.filter((target) => {
    const url = String(target.url || '').trim();
    const category = String(target.channelCategory || target.channelClassification || '').trim();
    return url && !category;
  });
  for (const target of missingCategoryTargets) {
    console.warn(`::warning title=Skipped target with missing channel category::${target.url}`);
  }
  const eligibleTargets = filterEligibleSponsorships(rawTargets, config.excludedChannelCategory);
  const eligibleMappedTargets = eligibleTargets.map((target) => ({
    ...target,
    platform: String(target.platform || detectPlatform(target.url)).toLowerCase(),
    trackingDays: config.trackingDays,
    // 감시 대상 = 라라스윗 협찬 게시물 → 브랜드 컨텍스트 부여(캡션에 브랜드명이 없어도
    // 제품 관련 부정댓글을 entity 게이트가 놓치지 않게 함). brandName은 classify가 postContext로 읽음.
    brandName: target.brandName || config.brandContext,
  }));
  // 일반 게시물은 업로드 7일 후 제외. 부스팅 게시물은 기간과 무관하게 일일 확인.
  const windowCutoff = runNow - config.trackingDays * 864e5;
  const windowedTargets = eligibleMappedTargets.filter((t) => {
    const d = Date.parse(t.uploadedAt || t.publishedAt || t.postedAt || '');
    // 부스팅·온드/위성(evergreen)은 기간 무관, 그 외 일반글만 업로드 7일 이내.
    return Boolean(t.isBoosted) || isEvergreenCategory(t.channelCategory) || !Number.isFinite(d) || d >= windowCutoff;
  });

  // Supabase의 마지막 확인·최근 알림 이력을 스케줄 입력으로 연결한다.
  let counts = {};
  let scheduledTargets = windowedTargets;
  if (config.supabaseUrl && config.supabaseKey) {
    try {
      counts = await loadCommentCounts(config, windowedTargets);
      const recentAlerts = await loadRecentlyAlertedPostKeys(config, 3 * 60 * 60 * 1000, fetch, runNow);
      scheduledTargets = windowedTargets.map((target) => {
        const assetName = target.assetName || counts[target.url]?.assetName || '';
        // 모든 바이럴(배너·영상) 카드는 소재명(asset_name)에서 영상 제작자를 추출해 태그한다.
        const isViral = /바이럴/.test(target.channelCategory || '');
        const creator = (isViral && assetName) ? videoAssigneeFromAdTitle(assetName, config.videoAssignees) : '';
        return {
          ...target,
          lastCollectedAt: target.lastCollectedAt || counts[target.url]?.lastCheckedAt || '',
          recentNegativeDetectedAt: recentAlerts.get(extractPostKey(target.url)) || target.recentNegativeDetectedAt || '',
          productName: target.productName || counts[target.url]?.productName || '',
          assetName,
          extraAssignees: creator ? [creator] : (target.extraAssignees || []),
        };
      });
    } catch (error) {
      console.error('[schedule] Supabase 이력 조회 실패 — GAS 시각 정보로 진행:', error.message);
    }
  }
  const dueTargetsAll = filterDueTargets(scheduledTargets, runNow);
  // 보관처리(ended_at)·게시글 링크 이동 불가(not_found 연속)인 게시물은 부정댓글 알림 대상에서 제외한다.
  // counts 미조회 시 fail-open(전부 유지). 스크레이프 전에 컷 → 비용도 절감.
  const { kept: dueTargets, skipped: archivedOrDead } = filterArchivedOrDeadTargets(dueTargetsAll, counts, { notFoundThreshold: config.notFoundSkipThreshold });
  if (archivedOrDead.length) {
    const arc = archivedOrDead.filter((s) => s.reason === 'archived').length;
    console.error(`[skip:archived-or-dead] ${archivedOrDead.length}건 제외(보관 ${arc}·죽은링크 ${archivedOrDead.length - arc})`);
  }

  // 정기 확인은 댓글 수 증가분만 과금한다. 최근 부정댓글이 있는 집중 대상은
  // 대시보드 댓글 수 갱신을 기다리지 않고 15분마다 직접 수집한다.
  let targets = dueTargets;
  let baselineTargets = [];
  let deltaSkipped = 0;
  let summary_deltaBreakdown = null;
  if (config.deltaEnabled && config.supabaseUrl && config.supabaseKey) {
    try {
      if (!Object.keys(counts).length) counts = await loadCommentCounts(config, dueTargets);
      const changed = filterChangedTargets(dueTargets, counts, { firstScanLimit: config.firstScanLimit });
      baselineTargets = filterBaselineTargets(dueTargets, counts); // current=0 신규 = 무스크레이프 baseline
      const noSignalRescue = filterNoSignalRescueTargets(dueTargets, counts, { limit: config.noSignalScanLimit });
      const deepScan = filterDeepScanTargets(dueTargets, counts, {
        limit: config.deepScanLimit,
        commentThreshold: config.deepScanCommentThreshold,
        recentCommentThreshold: config.deepScanRecentCommentThreshold,
        trackingDays: config.trackingDays,
        now: runNow,
      });
      const intensive = dueTargets.filter((target) => {
        const detected = Date.parse(target.recentNegativeDetectedAt || '');
        return Number.isFinite(detected) && runNow - detected <= 3 * 60 * 60 * 1000;
      });
      targets = [...new Map([...changed, ...noSignalRescue, ...intensive, ...deepScan].map((target) => [target.url, target])).values()];
      deltaSkipped = dueTargets.length - targets.length;
      summary_deltaBreakdown = summarizeDelta(dueTargets, counts);
      summary_deltaBreakdown.firstScanLimit = config.firstScanLimit;
      summary_deltaBreakdown.noSignalScanLimit = config.noSignalScanLimit;
      summary_deltaBreakdown.noSignalRescue = noSignalRescue.length;
      summary_deltaBreakdown.deepScanLimit = config.deepScanLimit;
      summary_deltaBreakdown.deepScanCommentThreshold = config.deepScanCommentThreshold;
      summary_deltaBreakdown.deepScanRecentCommentThreshold = config.deepScanRecentCommentThreshold;
      summary_deltaBreakdown.deepScan = deepScan.length;
      summary_deltaBreakdown.scrapeAfterLimit = targets.length;
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
  // LLM 사용량 계측(내용·키 미기록, 카운트/토큰만). cacheHits/cacheMiss=분류 캐시 적중 현황.
  const llmStats = { calls: 0, attempts: 0, failedAttempts: 0, persistentFailures: 0, transientFailures: 0, reviewed: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, cacheHits: 0, cacheMiss: 0 };
  const apifyCommentsByPlatform = {}; // 플랫폼별 수집 댓글 수(Apify 비용 추정 입력)
  const summary = {
    fetchedTargets: rawTargets.length,
    excludedTargets: rawTargets.length - eligibleMappedTargets.length,
    missingCategoryTargets: missingCategoryTargets.length,
    windowedTargets: windowedTargets.length,
    dueTargets: dueTargets.length,
    deltaSkipped,
    eligibleTargets: targets.length,
    graphSkipped: targets.length,
    slackChannelId: config.slackChannelId,
    dryRun: config.dryRun,
    platforms: {},
  };

  // Phase 1: 플랫폼별 스크레이프 → (게시물, 댓글) 엔트리 수집. 플랫폼 실패는 그 플랫폼만 기록.
  const entries = [];
  for (const [platform, platformTargets] of Object.entries(groups)) {
    summary.graphSkipped -= platformTargets.length;
    if (!platformTargets.length) continue;
    const platformRuns = [
      { deepScan: false, targets: platformTargets.filter((target) => !target.deepScan) },
      { deepScan: true, targets: platformTargets.filter((target) => target.deepScan) },
    ].filter((item) => item.targets.length);
    const platformSummary = {
      targets: platformTargets.length,
      succeededTargets: 0,
      failedTargets: 0,
      items: 0,
      ok: true,
      batches: 0,
      failedBatches: 0,
      deepTargets: platformTargets.filter((target) => target.deepScan).length,
    };
    for (const platformRun of platformRuns) {
      const batchResult = await runActorBatches(config, platform, platformRun.targets, fetch, {
        deepScan: platformRun.deepScan,
        commentLimit: config.deepScanCommentLimit,
      });
      platformSummary.batches += batchResult.totalBatches;
      platformSummary.failedBatches += batchResult.failures.length;
      platformSummary.failedTargets += batchResult.failures.reduce((sum, failure) => sum + failure.targets.length, 0);
      for (const success of batchResult.successes) {
        const normalized = normalizeDataset(platform, success.items, '');
        platformSummary.items += normalized.length;
        platformSummary.succeededTargets += success.targets.length;
        apifyCommentsByPlatform[platform] = (apifyCommentsByPlatform[platform] || 0) + normalized.length;
        const single = success.targets.length === 1;   // 단일 대상 배치면 URL 없는 댓글도 그 대상 소속
        for (const rawTarget of success.targets) {
          const target = { ...rawTarget, caption: rawTarget.caption || (counts[rawTarget.url] || {}).caption || '' };
          const targetKey = extractPostKey(target.url);
          const targetComments = normalized.filter((comment) => {
            const ck = extractPostKey(comment.url);
            if (ck && targetKey) return ck === targetKey;        // 게시물 ID로 정확 매칭(중복 귀속 방지)
            if (single) return true;                              // 단일 대상 배치 예외
            return comment.url && comment.url === target.url;     // 그 외 정확 URL 일치만
          });
          entries.push({ target, comments: targetComments });
          scrapedTargets.push(target);   // 성공 청크만 last_count 갱신 대상
        }
      }
      if (batchResult.failures.length) {
        platformSummary.ok = false;
        platformSummary.error = batchResult.failures.map((failure) => failure.error).join(' | ').slice(0, 500);
      }
    }
    summary.platforms[platform] = platformSummary;
  }

  // Phase 2: 실행 전체 문맥 후보를 25개 단위로 통합 분류(캐시 미스만 LLM). 결과는 entries와 동일 순서·귀속.
  const risksPerEntry = await classifyTargetsBatched(entries, config, undefined, llmStats);

  // 알림 당시 classifier_hash 기록용(오탐률 집계·오탐 우선적용 감사). 계산 실패는 무해(null 저장).
  let classifierHash = null;
  try { classifierHash = computeClassifierHash(config); } catch { classifierHash = null; }

  // 날짜×채널분류 스레드 ts를 실행 내 캐시(분류당 1회만 조회/생성). 실패 시 null → 최상위 발송 폴백.
  const kstDateForThreads = kstDateKey(runNow);
  const threadTsByScope = new Map();
  async function resolveThreadTs(target) {
    // 스레드는 (상품 × 카테고리)별로 분리한다. 스코프의 담당자는 결정적이라 스레드당 1명.
    const label = productLabel(productGroup(target.productName));
    const category = target.channelCategory || '기타';
    const scopeKey = `${label}|${category}`;
    if (threadTsByScope.has(scopeKey)) return threadTsByScope.get(scopeKey);
    const assignee = assigneeForTarget(target, config.slackAssignees);
    const ts = await ensureDailyThread(config, { kstDate: kstDateForThreads, scopeKey, productLabel: label, category, assignee });
    threadTsByScope.set(scopeKey, ts);
    return ts;
  }

  // Phase 3: 게시물별 dedup + 알림 발송(날짜×분류 스레드에 답글로, injibot 버튼 포함). DRY_RUN이면 카운트/로그만.
  // 바이럴(영상/배너)은 새 알림이 있으면 업체별 '복사용 메시지'를 스레드에 하나 더 남긴다.
  const viralCopyGroups = new Map(); // key: `${threadTs}||${업체}` → { threadTs, company, items:[{url,nickname,text}] }
  for (let e = 0; e < entries.length; e += 1) {
    const { target, comments } = entries[e];
    // 상품명이 없는 제품(위성/온드 등 미지정)은 부정댓글 알림을 보내지 않는다(스레드도 생성 안 함).
    if (!hasProductName(target)) {
      if (comments.length) console.error(`[skip:no-product] ${target.platform} | ${target.url || target.channelName || ''}`);
      continue;
    }
    const risks = risksPerEntry[e] || [];
    const classified = comments.map((comment, idx) => ({ ...comment, risk: risks[idx] || { alert: false } }));
    const alerts = classified.filter((comment) => comment.risk.alert);
    const fingerprints = alerts.map((comment) => commentFingerprint(target, comment));
    const seenFingerprints = config.dryRun ? new Set() : await loadSeenFingerprints(config, fingerprints);
    const cat = String(target.channelCategory || '');
    const isViralVideoBanner = cat.includes('바이럴') && (cat.includes('영상') || cat.includes('배너'));
    for (let alertIndex = 0; alertIndex < alerts.length; alertIndex += 1) {
      const comment = alerts[alertIndex];
      const fingerprint = fingerprints[alertIndex];
      if (seenFingerprints.has(fingerprint)) {
        console.error(`[dedup] already alerted: ${target.platform} | ${comment.id || fingerprint.slice(0, 12)}`);
        continue;
      }
      console.error(`[alert] ${target.platform} | ${comment.risk.category} | ${(comment.text || '').replace(/\s+/g, ' ').slice(0, 50)}`);
      if (!config.dryRun) {
        const threadTs = await resolveThreadTs(target);
        const slackResult = await sendAlert(config, target, comment, undefined, threadTs);
        await recordAlert(config, target, comment, fingerprint, slackResult.ts, classifierHash);
        // 바이럴 영상/배너 → 업체별 복사메시지 아이템(링크/닉네임/댓글내용) 수집.
        if (isViralVideoBanner) {
          const company = String(target.company || target.channelName || '').trim();
          const key = `${threadTs}||${company}`;
          if (!viralCopyGroups.has(key)) viralCopyGroups.set(key, { threadTs, company, items: [] });
          viralCopyGroups.get(key).items.push({ url: target.url, nickname: comment.username, text: comment.text });
        }
      }
      sentAlerts += 1;
    }
  }
  summary.sentAlerts = sentAlerts;

  // 바이럴(영상/배너) 업체별 복사용 메시지 발송(best-effort — 실패해도 알림 본류엔 영향 없음).
  if (!config.dryRun && viralCopyGroups.size) {
    for (const group of viralCopyGroups.values()) {
      try {
        await postThreadText(config, group.threadTs, buildViralCopyMessage(group.company, group.items));
      } catch (error) {
        console.error('[copy] 업체 복사메시지 발송 실패(무시):', error.message);
      }
    }
  }

  // LLM 사용량 요약 + 예상 비용(단가는 pricing.js에 분리).
  const estUsd = estimateUsd(llmStats, config.anthropicModel);
  summary.llm = { ...llmStats, estUsd: Number(estUsd.toFixed(5)) };
  try {
    summary.llmHealth = await monitorLlmHealth(config, llmStats, {
      scope: 'core', label: '일반 협찬·바이럴·위성 모니터',
      totalComments: entries.reduce((sum, entry) => sum + entry.comments.length, 0),
      notify: !config.dryRun,
    }, fetch, runNow);
  } catch (error) {
    summary.llmHealth = { degraded: true, healthCheckFailed: true, error: String(error.message || error).slice(0, 200) };
    console.error(`[llm-health:degraded] 상태 경고 실패 — ${error.message}`);
  }
  console.error(`[llm] calls=${llmStats.calls} attempts=${llmStats.attempts || 0} failed=${llmStats.failedAttempts || 0} fallback=${llmStats.keywordFallbackComments || 0} reviewed=${llmStats.reviewed} cacheHit=${llmStats.cacheHits} cacheMiss=${llmStats.cacheMiss} in=${llmStats.inputTokens} out=${llmStats.outputTokens} promptCacheR=${llmStats.cacheRead} promptCacheC=${llmStats.cacheCreate} est=$${estUsd.toFixed(5)} (${config.anthropicModel})`);

  // 90일 초과 분류 캐시 정리(best-effort — 실패해도 무시).
  if (!config.dryRun) await purgeCache(config);

  // 오늘 스레드 중 답글 0개(전부 처리)인데 완료 반응 없는 것에 :완료느낌표: 백업 부착(best-effort).
  if (!config.dryRun) {
    try {
      // 카드가 처리(완료/숨김)로 삭제돼 복사메시지만 남은 고아 먼저 정리 → 이후 0답글 스레드에 완료느낌표.
      const cleaned = await cleanupOrphanedCopyMessages(config, kstDateKey(runNow));
      if (cleaned) console.error(`[thread] 고아 복사메시지 ${cleaned}개 삭제`);
      const marked = await markCompletedThreads(config, kstDateKey(runNow));
      if (marked) console.error(`[thread] 완료 스레드 ${marked}개에 완료느낌표 부착`);
    } catch (error) {
      console.error('[thread] 완료 반응 부착 실패(무시):', error.message);
    }
  }

  // 일별(KST) 비용 누적 + 임계치 경고. run_key 멱등(재시도 중복합산 방지), 임계치별 하루 1회 발송.
  // 비용 경로의 어떤 실패도 모니터링 본류를 막지 않는다.
  if (config.supabaseUrl && config.supabaseKey && !config.dryRun) {
    try {
      const kstDate = kstDateKey(runNow);
      const runApifyUsd = estimateApifyUsd(apifyCommentsByPlatform);
      await recordRunCost(config, { runKey: runKey(process.env, runNow), kstDate, apifyUsd: runApifyUsd, anthropicUsd: estUsd });
      const daily = await sumDailyCost(config, kstDate);
      summary.cost = { kstDate, runApifyUsd: Number(runApifyUsd.toFixed(4)), runAnthropicUsd: Number(estUsd.toFixed(5)), daily };
      const thresholds = config.costThresholds || DEFAULT_COST_THRESHOLDS;
      const fired = await maybeAlertCosts(config, kstDate, daily, thresholds,
        (kind, amount, threshold) => postCostWarning(config, kind, amount, threshold, kstDate));
      if (fired.length) {
        summary.cost.alertsFired = fired;
        console.error(`[cost] 일일 비용 경고 발송: ${fired.join(', ')} (KST ${kstDate})`);
      }
    } catch (error) {
      console.error('[cost] 비용 집계/경고 실패(무시):', error.message);
    }

    // #8 classifier_hash별 오탐률 집계(best-effort).
    try {
      const reviewStats = await falsePositiveStats(config);
      if (reviewStats) summary.reviewStats = reviewStats;
    } catch (error) {
      console.error('[review] 오탐률 집계 실패(무시):', error.message);
    }

    // Apify 잔여 한도 경고(재발방지: 예산 소진으로 수집이 조용히 멈추는 것 방지). 하루 1회.
    try {
      const usage = await fetchApifyUsage(config.apifyApiToken);
      if (usage) {
        summary.apifyUsage = { usedUsd: Number(usage.usedUsd.toFixed(2)), maxUsd: usage.maxUsd, remainingUsd: Number(usage.remainingUsd.toFixed(2)) };
        const thr = config.apifyLowBalanceUsd || APIFY_LOW_BALANCE_USD;
        const fired = await maybeAlertApifyLow(config, kstDateKey(runNow), usage, thr,
          (u) => postApifyLowWarning(config, u, thr));
        if (fired) console.error(`[apify] 잔여 한도 부족 경고 발송: 잔여 $${usage.remainingUsd.toFixed(2)} < $${thr}`);
      }
    } catch (error) {
      console.error('[apify] 잔여 한도 조회/경고 실패(무시):', error.message);
    }
  }

  if (summary_deltaBreakdown) summary.deltaBreakdown = summary_deltaBreakdown;
  // 스크레이프분 + baseline(current=0 신규, 무스크레이프)의 last_count 기준선 갱신(다음 실행부터 증가분만).
  // baseline은 recordChecks가 counts.current(=0)를 그대로 기록 → 재firstScan 없이 0 기준선만 남긴다.
  const toRecord = [...scrapedTargets, ...baselineTargets];
  if (config.deltaEnabled && config.supabaseUrl && config.supabaseKey && toRecord.length && !config.dryRun) {
    try {
      summary.checksUpdated = await recordChecks(config, toRecord, counts);
    } catch (error) {
      console.error('[delta] last_count 갱신 실패:', error.message);
    }
  }
  // 위성 YouTube 오가닉 부정댓글만 소유 채널 OAuth로 자동 숨김한다. 허용 영상 집합은
  // 이번 GAS 대상 중 channelCategory=위성채널인 YouTube로 만들기 때문에 협찬 3자·TikTok·
  // 온드 YouTube는 source=null이어도 처리되지 않는다. 사람의 유지 결정은 moderation 모듈이 보존한다.
  if (!config.dryRun && config.youtubeSatelliteAutoHide) {
    summary.youtubeSatelliteModeration = await autoHideOrganicSatelliteYouTube(
      config,
      windowedTargets,
      fetch,
      runNow,
    );
  }
  // 플랫폼 실패는 우선 fail-soft: 성공 플랫폼/청크 결과와 last_count를 보존하고 실패 청크만 다음 회차 재시도.
  // 연속 실패 임계치에 도달한 플랫폼만 쿨다운 단위로 핵심 실패 알림에 승격한다.
  const persistentFailures = [];
  for (const [platform, result] of Object.entries(summary.platforms)) {
    const health = await recordPlatformOutcome(config, {
      platform,
      ok: result.ok !== false,
      error: result.error || '',
    }, fetch, runNow);
    result.consecutiveFailures = health.consecutiveFailures;
    result.healthPersisted = health.persisted;
    if (health.shouldEscalate) persistentFailures.push(`${platform}(${health.consecutiveFailures})`);
    if (result.ok === false) {
      console.error(
        `[platform:degraded] ${platform} failedBatches=${result.failedBatches}/${result.batches} `
        + `failedTargets=${result.failedTargets} consecutive=${health.consecutiveFailures}; 다음 회차 재시도`,
      );
    }
  }
  if (persistentFailures.length) {
    throw new Error(`Persistent platform collection failure: ${persistentFailures.join(', ')}`);
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
