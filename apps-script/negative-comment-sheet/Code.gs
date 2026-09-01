const NEGATIVE_COMMENT_SPREADSHEET_ID_ = '1TBMDj6-dElbXcW3MeZOXO-td6zRYATLt-DsRgxjmHwY';
// 탭 이름은 팀 운영 중 바뀔 수 있으므로 식별에는 쓰지 않고 진단용으로만 둔다.
const NEGATIVE_COMMENT_SHEET_NAME_ = '+ 부정댓글리스트(경원 26.08~)';
const NEGATIVE_COMMENT_SHEET_GID_ = 338810723;
const NEGATIVE_COMMENT_TOKEN_PROPERTY_ = 'NEGATIVE_COMMENT_SHEET_TOKEN';
const VISIBLE_HEADERS_ = [
  '상품', '채널', '악플 분류 이유', '게시글 링크', '악플 내용', '분류', '플랫폼',
  '채널명(계정)', '소재명', '처리상태', '탐지일시(KST)',
];
const INTERNAL_HEADERS_ = ['_comment_id', '_fingerprint'];

function doGet(e) {
  return json_({ ok: true, service: 'negative-comment-sheet-webhook' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e && e.postData && e.postData.contents || '{}');
    verifyToken_(body.token);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length > 500) throw new Error('rows exceeds 500');
    const result = appendNegativeCommentRows_(rows);
    return json_({ ok: true, received: rows.length, appended: result.appended, duplicates: result.duplicates });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message || error) });
  }
}

function appendNegativeCommentRows_(rows) {
  // 기존 메타 댓글 자동화의 bound script와 격리한 standalone 웹앱이므로 script lock을 쓴다.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getTargetSheet_();
    ensureHeaders_(sheet);
    const existing = existingKeys_(sheet);
    const output = [];
    let duplicates = 0;
    rows.forEach(function(row) {
      const fingerprint = clean_(row && row.fingerprint);
      const commentId = clean_(row && row.commentId);
      const platform = clean_(row && row.platform).toLowerCase();
      const fallback = fallbackKey_(row && row.postUrl, row && row.commentText);
      const nativeKey = commentId ? platform + '\u001f' + commentId : '';
      if ((fingerprint && existing.fingerprints[fingerprint])
        || (nativeKey && existing.commentIds[nativeKey])
        || (fallback && existing.fallbacks[fallback])) {
        duplicates += 1;
        return;
      }
      output.push([
        safeCell_(row.product), safeCell_(row.channel), safeCell_(row.reason), safeUrl_(row.postUrl),
        safeCell_(row.commentText), safeCell_(row.category), safeCell_(row.platform),
        safeCell_(row.channelName), safeCell_(row.assetName), safeCell_(row.status),
        safeCell_(row.detectedAtKst), safeCell_(commentId), safeCell_(fingerprint),
      ]);
      if (fingerprint) existing.fingerprints[fingerprint] = true;
      if (nativeKey) existing.commentIds[nativeKey] = true;
      if (fallback) existing.fallbacks[fallback] = true;
    });
    if (output.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, output.length, VISIBLE_HEADERS_.length + INTERNAL_HEADERS_.length)
        .setValues(output);
    }
    sheet.hideColumns(VISIBLE_HEADERS_.length + 1, INTERNAL_HEADERS_.length);
    return { appended: output.length, duplicates: duplicates };
  } finally {
    lock.releaseLock();
  }
}

function getTargetSheet_() {
  const spreadsheet = SpreadsheetApp.openById(NEGATIVE_COMMENT_SPREADSHEET_ID_);
  const sheet = spreadsheet.getSheets().find(function(candidate) {
    return candidate.getSheetId() === NEGATIVE_COMMENT_SHEET_GID_;
  });
  if (!sheet) {
    throw new Error('Target sheet gid not found: ' + NEGATIVE_COMMENT_SHEET_GID_);
  }
  return sheet;
}

function ensureHeaders_(sheet) {
  const width = VISIBLE_HEADERS_.length + INTERNAL_HEADERS_.length;
  const current = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  VISIBLE_HEADERS_.forEach(function(header, index) {
    if (clean_(current[index]) !== header) throw new Error('Visible header mismatch at column ' + (index + 1));
  });
  INTERNAL_HEADERS_.forEach(function(header, offset) {
    const index = VISIBLE_HEADERS_.length + offset;
    if (current[index] && clean_(current[index]) !== header) throw new Error('Internal column conflict at ' + (index + 1));
    if (!current[index]) sheet.getRange(1, index + 1).setValue(header);
  });
}

function existingKeys_(sheet) {
  const out = { fingerprints: {}, commentIds: {}, fallbacks: {} };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  const rows = sheet.getRange(2, 1, lastRow - 1, VISIBLE_HEADERS_.length + INTERNAL_HEADERS_.length).getDisplayValues();
  rows.forEach(function(row) {
    const platform = clean_(row[6]).toLowerCase();
    const commentId = clean_(row[11]);
    const fingerprint = clean_(row[12]);
    const fallback = fallbackKey_(row[3], row[4]);
    if (fingerprint) out.fingerprints[fingerprint] = true;
    if (commentId) out.commentIds[platform + '\u001f' + commentId] = true;
    if (fallback) out.fallbacks[fallback] = true;
  });
  return out;
}

function fallbackKey_(url, text) {
  const u = clean_(url).replace(/#.*$/, '');
  const t = clean_(text).replace(/\s+/g, ' ');
  return u && t ? u + '\u001f' + t : '';
}

function safeCell_(value) {
  const text = clean_(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function safeUrl_(value) {
  const text = clean_(value);
  return /^https?:\/\//i.test(text) ? text : safeCell_(text);
}

function clean_(value) {
  return String(value == null ? '' : value).trim();
}

function verifyToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty(NEGATIVE_COMMENT_TOKEN_PROPERTY_);
  if (!expected || clean_(token) !== expected) throw new Error('Invalid verification token');
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

// 최초 1회만 Apps Script 편집기에서 직접 실행. 토큰은 코드에 저장하지 않고 Script Properties에 보관한다.
function setNegativeCommentSheetToken_(token) {
  if (!clean_(token)) throw new Error('token is required');
  PropertiesService.getScriptProperties().setProperty(NEGATIVE_COMMENT_TOKEN_PROPERTY_, clean_(token));
  const sheet = getTargetSheet_();
  ensureHeaders_(sheet);
  sheet.hideColumns(VISIBLE_HEADERS_.length + 1, INTERNAL_HEADERS_.length);
}
