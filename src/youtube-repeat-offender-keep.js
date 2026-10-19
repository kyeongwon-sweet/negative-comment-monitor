import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordKeepDecision } from './youtube-repeat-offender-report.js';

// 사람이 "이 작성자는 차단하지 말고 두기"로 정한 결정을 기록한다.
// 기록되면 결정 당시 악플 수 이하인 동안 상습 악플러 후보·카드·대량 차단에서 빠진다.
// 사용: node src/youtube-repeat-offender-keep.js <소유채널ID>:<작성자채널ID>:<결정 당시 악플 수> [...]
// 되돌리기: cost_usage_ledger에서 run_key=offender-keep:{소유채널}:{작성자}:{수} 행 삭제.
export function parseKeepArgs(args) {
  return (args || []).map((arg) => {
    const [ownerChannelId, authorChannelId, count] = String(arg).trim().split(':');
    const commentCount = Number(count);
    if (!/^UC[\w-]{22}$/.test(ownerChannelId || '') || !/^UC[\w-]{22}$/.test(authorChannelId || '')
      || !Number.isSafeInteger(commentCount) || commentCount < 1) {
      throw new Error(`Invalid keep decision "${arg}" (expected <ownerUC...>:<authorUC...>:<commentCount>)`);
    }
    return { ownerChannelId, authorChannelId, commentCount };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = {
    supabaseUrl: String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
    supabaseKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  };
  Promise.resolve()
    .then(async () => {
      if (!config.supabaseUrl || !config.supabaseKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
      const decisions = parseKeepArgs(process.argv.slice(2));
      if (!decisions.length) throw new Error('No keep decisions given');
      for (const decision of decisions) console.log(await recordKeepDecision(config, decision));
    })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
