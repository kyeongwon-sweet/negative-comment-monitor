import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const monitorWorkflow = readFileSync(new URL('../.github/workflows/monitor.yml', import.meta.url), 'utf8');

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
