import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const monitorWorkflow = readFileSync(new URL('../.github/workflows/monitor.yml', import.meta.url), 'utf8');
const awarenessAutoHideWorkflow = readFileSync(
  new URL('../.github/workflows/awareness-auto-hide.yml', import.meta.url),
  'utf8',
);
const ownerChannelWorkflow = readFileSync(
  new URL('../.github/workflows/youtube-owner-channel.yml', import.meta.url),
  'utf8',
);
const repeatOffenderWorkflow = readFileSync(
  new URL('../.github/workflows/youtube-repeat-offender-report.yml', import.meta.url),
  'utf8',
);
const heartbeatWorkflow = readFileSync(new URL('../.github/workflows/heartbeat.yml', import.meta.url), 'utf8');

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

test('상습 악플러 리포트가 제품별 인지광고 담당자 변수를 전달받는다', () => {
  for (const variable of [
    'SLACK_ASSIGNEE_OTHER',
    'SLACK_ASSIGNEE_AWARENESS',
    'SLACK_ASSIGNEE_P_AWARENESS',
    'SLACK_ASSIGNEE_JG_PRIMARY',
  ]) {
    const pattern = new RegExp(`${variable}:\\s*\\$\\{\\{\\s*vars\\.${variable}\\s*\\}\\}`);
    assert.match(repeatOffenderWorkflow, pattern);
  }
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

test('소유 YouTube→인지광고 스레드 담당자 변수를 owner-channel 런타임에 전달한다', () => {
  // 소유 YouTube 제과 영상(맛피아 건물주)은 '인지 광고' 스레드로 라우팅되므로
  // owner-channel.yml이 jg·파인트 인지 담당자 변수를 넘겨야 other(황경원) 폴백을 막는다.
  for (const variable of [
    'SLACK_ASSIGNEE_JG_PRIMARY',
    'SLACK_ASSIGNEE_JG_ADDITIONAL',
    'SLACK_ASSIGNEE_P_AWARENESS',
  ]) {
    const pattern = new RegExp(`${variable}:\\s*\\$\\{\\{\\s*vars\\.${variable}\\s*\\}\\}`);
    assert.match(ownerChannelWorkflow, pattern);
  }
});

test('Meta 자동숨김 제외 계정 변수를 정기·수동 실행 모두에 전달한다', () => {
  const pattern = /META_AUTO_HIDE_EXCLUDED_IG_USER_IDS:\s*\$\{\{\s*vars\.META_AUTO_HIDE_EXCLUDED_IG_USER_IDS\s*\}\}/;
  assert.match(monitorWorkflow, pattern);
  assert.match(awarenessAutoHideWorkflow, pattern);
});

test('메인 감시는 예약 run 내부 15분 간격 4회 루프를 사용한다', () => {
  assert.match(monitorWorkflow, /timeout-minutes:\s*70/);
  assert.match(monitorWorkflow, /run:\s*node src\/monitor-loop\.js/);
  assert.match(monitorWorkflow, /MONITOR_LOOP_ITERATIONS:\s*\$\{\{ github\.event_name == 'schedule' && '4' \|\| '1' \}\}/);
  assert.match(monitorWorkflow, /MONITOR_LOOP_INTERVAL_MS:\s*'900000'/);
  assert.doesNotMatch(monitorWorkflow, /id:\s*intensive_gate/);
  assert.match(monitorWorkflow, /group:\s*negative-comment-monitor-production[\s\S]*cancel-in-progress:\s*false/);
  assert.match(monitorWorkflow, /cron:\s*'17 1-22\/3 \* \* \*'/);
});

test('하트비트는 하루 두 번을 유지하며 3.5시간 공백 임계를 전달한다', () => {
  assert.equal((heartbeatWorkflow.match(/- cron:/g) || []).length, 2);
  assert.match(heartbeatWorkflow, /HEARTBEAT_MAX_GAP_MINUTES:\s*\$\{\{ inputs\.max_gap_minutes \|\| '210' \}\}/);
  assert.match(heartbeatWorkflow, /HEARTBEAT_ALERT_COOLDOWN_HOURS:\s*'24'/);
  assert.match(heartbeatWorkflow, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.match(heartbeatWorkflow, /max_gap_minutes:/);
});
