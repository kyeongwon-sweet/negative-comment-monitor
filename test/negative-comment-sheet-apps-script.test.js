import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Apps Script 수신기는 정확한 스프레드시트·탭 gid와 내부 dedup 열을 고정한다', async () => {
  const source = await readFile(new URL('../apps-script/negative-comment-sheet/Code.gs', import.meta.url), 'utf8');
  assert.match(source, /1TBMDj6-dElbXcW3MeZOXO-td6zRYATLt-DsRgxjmHwY/);
  assert.match(source, /\+ 8월_부정댓글리스트\(경원\)/);
  assert.match(source, /338810723/);
  assert.match(source, /_comment_id/);
  assert.match(source, /_fingerprint/);
  assert.match(source, /LockService\.getScriptLock/);
  assert.match(source, /hideColumns/);
  assert.doesNotMatch(source, /NEGATIVE_COMMENT_SHEET_TOKEN\s*=\s*['"][^'"]+['"]/);
});
