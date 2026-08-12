function endpoint(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`GAS HTTP ${response.status}: ${text.slice(0, 300)}`);
  // GAS는 스크립트 예외 시 200 + HTML 오류 페이지를 반환한다(예: 시트 헤더 누락으로 throw).
  // 그대로 JSON.parse하면 "Unexpected token '<'"라는 암호 같은 오류만 남아 진단이 늦다.
  // → HTML을 감지해 실제 원인(errorMessage)을 담은 명확한 오류로 바꿔 던진다(로그/알림 즉시 진단).
  if (text.trimStart().startsWith('<')) {
    const m = text.match(/errorMessage[^>]*>([\s\S]*?)<\/div>/);
    const detail = (m ? m[1] : text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`GAS가 JSON 대신 오류 페이지 반환(시트 헤더 누락 등 스크립트 오류 가능): ${detail}`);
  }
  const payload = JSON.parse(text);
  if (payload.ok === false) throw new Error(payload.error || 'GAS request failed');
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTiktokShortUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'vt.tiktok.com' || host === 'vm.tiktok.com';
  } catch {
    return false;
  }
}

async function resolveTiktokShortUrl(url, fetchImpl) {
  const attempts = [
    { method: 'HEAD', redirect: 'follow' },
    { method: 'GET', redirect: 'follow' },
  ];
  let lastError;
  for (const options of attempts) {
    try {
      const response = await fetchImpl(url, options);
      const resolved = String(response.url || '').trim();
      if (resolved && resolved !== url && /tiktok\.com/i.test(resolved)) return resolved;
      if (response.ok && resolved) return resolved;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) console.error(`[gas] TikTok short URL resolve failed: ${url} — ${lastError.message}`);
  return url;
}

export async function resolveTargetUrls(targets, fetchImpl = fetch) {
  const out = [];
  for (const target of targets) {
    const url = String(target.url || '').trim();
    if (!isTiktokShortUrl(url)) {
      out.push(target);
      continue;
    }
    const resolvedUrl = await resolveTiktokShortUrl(url, fetchImpl);
    out.push(resolvedUrl && resolvedUrl !== url ? { ...target, originalUrl: target.originalUrl || url, url: resolvedUrl } : target);
  }
  return out;
}

export async function fetchTargets(config, fetchImpl = fetch) {
  const url = endpoint(config.gasWebAppUrl, {
    action: 'sponsoredTargets',
    key: config.gasVerifyToken,
    limit: config.targetBatchSize,
    // Apps Script/중간 프록시가 같은 GET을 재사용하지 못하게 매 호출을 고유하게 만든다.
    // 서버가 no-store를 반환해도 클라이언트 쪽 방어를 함께 둔다.
    _cb: Date.now(),
  });
  const maxAttempts = Math.max(1, Number(config.gasFetchRetries || 4));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      });
      const payload = await readJson(response);
      const targets = payload.result?.targets || [];
      const total = Number(payload.result?.total);
      const cap = Number(config.targetBatchSize);
      // 진짜 상한(batch cap) truncation일 때만 전체 실패(699/817 재발 방지): 받은 대상이 상한에
      // 도달했는데 total이 그보다 크면 = 상한에 잘린 것 → fail-loud.
      if (Number.isFinite(total) && total > targets.length && Number.isFinite(cap) && targets.length >= cap) {
        throw new Error(
          `GAS 대상이 상한으로 잘렸습니다: returned=${targets.length}, total=${total}, limit=${config.targetBatchSize}. `
          + 'TARGET_BATCH_SIZE를 올리거나 GAS evergreen 상한을 확인하세요.',
        );
      }
      // 상한과 무관한 소량 불일치(GAS가 특정 행을 간헐적으로 드롭, returned≪limit)는 전체 모니터링을
      // 중단하지 않는다 — 받은 대상으로 진행하고 경고만 남긴다(로그=비-침묵). 진짜 감시 누락은
      // target-sync-watchdog가 DB↔GAS 대조로 독립 감지·알림하므로 여기서 run을 죽일 필요가 없다.
      if (Number.isFinite(total) && total > targets.length) {
        console.error(
          `[gas] 대상 일부 누락(상한 아님): returned=${targets.length}, total=${total}, limit=${config.targetBatchSize}. `
          + '받은 대상으로 진행합니다(감시 누락 감지는 target-sync-watchdog).',
        );
      }
      return resolveTargetUrls(targets, fetchImpl);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const delayMs = Math.min(1500 * attempt, 5000);
      console.error(`[gas] sponsoredTargets 조회 실패(${attempt}/${maxAttempts}) — ${delayMs}ms 후 재시도: ${error.message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export async function submitResult(config, target, comments, error = '', fetchImpl = fetch) {
  if (config.dryRun) return { dryRun: true, url: target.url, comments: comments.length };
  const url = endpoint(config.gasWebAppUrl, {
    action: 'sponsoredRpaResult',
    key: config.gasVerifyToken,
  });
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      row: target.row,
      url: target.url,
      channelName: target.channelName || '',
      platform: target.platform,
      collector: 'APIFY',
      slackChannelId: config.slackChannelId,
      channelCategory: target.channelCategory || '',
      comments,
      error,
    }),
  });
  return readJson(response);
}
