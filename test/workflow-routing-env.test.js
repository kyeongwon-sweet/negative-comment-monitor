import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const monitorWorkflow = readFileSync(new URL('../.github/workflows/monitor.yml', import.meta.url), 'utf8');
const awarenessAutoHideWorkflow = readFileSync(
  new URL('../.github/workflows/awareness-auto-hide.yml', import.meta.url),
  'utf8',
);

test('협찬 파워채널 담당자 변수를 메인 감시 런타임에 전달한다', () => {
  assert.match(
    monitorWorkflow,
    /SLACK_ASSIGNEE_JD_POWER_CHANNEL:\s*\$\{\{\s*vars\.SLACK_ASSIGNEE_JD_POWER_CHANNEL\s*\}\}/,
  );
  assert.match(
    monitorWorkflow,
    /SLACK_ASSIGNEE_P_POWER_CHANNEL:\s*\$\{\{\s*vars\.SLACK_ASSIGNEE_P_POWER_CHANNEL\s*\}\}/,
  );
});

test('제과 담당자 변수를 일반·광고 알림 런타임 모두에 전달한다', () => {
  for (const variable of [
    'SLACK_ASSIGNEE_JG_PRIMARY',
    'SLACK_ASSIGNEE_JG_ADDITIONAL',
  ]) {
    const pattern = new RegExp(`${variable}:\\s*\\$\\{\\{\\s*vars\\.${variable}\\s*\\}\\}`, 'g');
    assert.equal([...monitorWorkflow.matchAll(pattern)].length, 4, `${variable} must reach four alert-producing steps`);
  }
});

test('Meta 자동숨김 제외 계정 변수를 정기·수동 실행 모두에 전달한다', () => {
  const pattern = /META_AUTO_HIDE_EXCLUDED_IG_USER_IDS:\s*\$\{\{\s*vars\.META_AUTO_HIDE_EXCLUDED_IG_USER_IDS\s*\}\}/;
  assert.match(monitorWorkflow, pattern);
  assert.match(awarenessAutoHideWorkflow, pattern);
});
