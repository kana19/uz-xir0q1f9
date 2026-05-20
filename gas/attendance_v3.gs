/**
 * ウルトラZAIMUくん LEO版 GAS — attendance_v3.gs
 * attendance列構成 v3（9列）対応・マイグレーション・全アクション
 *
 * 列構成:
 * A: 入店日, B: スタッフID, C: スタッフ名, D: 雇用形態,
 * E: 入店時刻, F: 退店日, G: 退店時刻, H: 登録日時,
 * I: 案件ID（サイクルA・PC操作で後付け紐付け運用）
 *
 * 既存の doGet の switch 文に以下を追記してください:
 * ─────────────────────────────────────────────────────────
 *   case 'clockIn':
 *     return jsonResponse(_doClockInV3(data));
 *   case 'clockOut':
 *     return jsonResponse(_doClockOutV3(data));
 *   case 'updateAttendance':
 *     return jsonResponse(_doUpdateAttendanceV3(data));
 *   case 'getAttendanceByMonth':
 *     return jsonResponse(_doGetAttendanceByMonthV3(data));
 *   case 'runAttendanceMigrationV3':
 *     return jsonResponse(setupAttendanceMigrationV3());
 * ─────────────────────────────────────────────────────────
 */

/* ══════════════════════════════════════════════════════════
   ヘルパー関数
   ══════════════════════════════════════════════════════════ */

/**
 * 時刻値を {h, m} に変換（Spreadsheet シリアル日時対応）
 */
function _parseHHMM(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
  if (val instanceof Date) return { h: val.getUTCHours(), m: val.getUTCMinutes() };
  const d = new Date(val);
  if (!isNaN(d.getTime())) return { h: d.getUTCHours(), m: d.getUTCMinutes() };
  return null;
}

/** {h, m} → "HH:MM" */
function _toHHMM(h, m) {
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** 時刻値 → "HH:MM"（Spreadsheet シリアル対応） */
function _normalizeTimeStr(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (/^\d{1,2}:\d{2}/.test(s)) return s.slice(0, 5);
  const t = _parseHHMM(val);
  return t ? _toHHMM(t.h, t.m) : '';
}

/** Date → "YYYY-MM-DD" */
function _dateToStr(d) {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** "YYYY-MM-DD" または Date → Date（スプレッドシートの日付シリアル対応） */
function _parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  const s = String(val).trim();
  const parts = s.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 翌日の "YYYY-MM-DD" を返す */
function _nextDay(dateStr) {
  const d = _parseDate(dateStr);
  if (!d) return String(dateStr);
  d.setDate(d.getDate() + 1);
  return _dateToStr(d);
}

/** clockIn / clockOut 時刻から日跨ぎを判定して退店日を計算 */
function _resolveClockOutDate(clockInDateStr, clockInTime, clockOutTime, explicitClockOutDate) {
  if (explicitClockOutDate) return explicitClockOutDate;
  const ci = _parseHHMM(clockInTime);
  const co = _parseHHMM(clockOutTime);
  if (ci && co && (co.h * 60 + co.m) < (ci.h * 60 + ci.m)) {
    return _nextDay(clockInDateStr);
  }
  return clockInDateStr;
}

/* ══════════════════════════════════════════════════════════
   setupAttendanceMigrationV3
   旧7列 → 新8列 変換
   ══════════════════════════════════════════════════════════ */

function setupAttendanceMigrationV3() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('attendance');
  if (!sheet) return { status: 'error', message: 'attendance シートが見つかりません' };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  Logger.log('Migration: rows=' + lastRow + ', cols=' + lastCol);

  if (lastRow < 1) {
    Logger.log('Migration: empty sheet, nothing to do');
    return { status: 'ok', message: 'シートが空のためスキップしました', migrated: 0 };
  }

  // 既に8列なら何もしない
  if (lastCol >= 8) {
    Logger.log('Migration: already 8 columns, skipping');
    return { status: 'ok', message: '既にv3形式（8列）です。スキップしました', migrated: 0 };
  }

  const data    = sheet.getRange(1, 1, lastRow, Math.max(lastCol, 7)).getValues();
  const newData = [];
  let   migrated = 0;

  for (var i = 0; i < data.length; i++) {
    const row = data[i];
    // 旧列: A=日付, B=ID, C=名前, D=雇用形態, E=入店時刻, F=退店時刻, G=登録日時
    const rawDate    = row[0];
    const staffId    = row[1];
    const staffName  = row[2];
    const empType    = row[3];
    const ciTimeRaw  = row[4];
    const coTimeRaw  = row[5];
    const regAt      = row[6];

    // 入店日
    let clockInDate = '';
    if (rawDate instanceof Date) {
      clockInDate = _dateToStr(rawDate);
    } else {
      const d = _parseDate(rawDate);
      clockInDate = d ? _dateToStr(d) : String(rawDate);
    }

    // 入店時刻（24h超の場合は-24して翌日扱い）
    let clockInStr  = '';
    const ciParsed  = _parseHHMM(ciTimeRaw);
    if (ciParsed) {
      if (ciParsed.h >= 24) {
        clockInStr  = _toHHMM(ciParsed.h - 24, ciParsed.m);
        clockInDate = _nextDay(clockInDate);
      } else {
        clockInStr = _toHHMM(ciParsed.h, ciParsed.m);
      }
    }

    // 退店日・退店時刻（24h超またはout<in → 翌日）
    let clockOutDate = '';
    let clockOutStr  = '';
    const hasCoTime  = coTimeRaw !== '' && coTimeRaw !== null && coTimeRaw !== undefined;
    if (hasCoTime) {
      const coParsed = _parseHHMM(coTimeRaw);
      if (coParsed) {
        if (coParsed.h >= 24) {
          clockOutStr  = _toHHMM(coParsed.h - 24, coParsed.m);
          clockOutDate = _nextDay(clockInDate);
        } else {
          clockOutStr  = _toHHMM(coParsed.h, coParsed.m);
          // 退店 < 入店 → 翌日
          if (ciParsed && (coParsed.h * 60 + coParsed.m) < (ciParsed.h * 60 + ciParsed.m)) {
            clockOutDate = _nextDay(clockInDate);
          } else {
            clockOutDate = clockInDate;
          }
        }
      }
    }

    newData.push([
      clockInDate,   // A: 入店日
      staffId,       // B: スタッフID
      staffName,     // C: スタッフ名
      empType,       // D: 雇用形態
      clockInStr,    // E: 入店時刻
      clockOutDate,  // F: 退店日
      clockOutStr,   // G: 退店時刻
      regAt,         // H: 登録日時
    ]);
    migrated++;
    Logger.log('Row ' + (i + 1) + ': ' + clockInDate + ' ' + clockInStr + ' | out: ' + clockOutDate + ' ' + clockOutStr);
  }

  // 一時シートに書き出し
  const tempName  = 'attendance_v3_temp';
  let   tempSheet = ss.getSheetByName(tempName);
  if (tempSheet) ss.deleteSheet(tempSheet);
  tempSheet = ss.insertSheet(tempName);
  if (newData.length > 0) {
    tempSheet.getRange(1, 1, newData.length, 8).setValues(newData);
  }

  // 旧シート削除 → リネーム
  ss.deleteSheet(sheet);
  tempSheet.setName('attendance');

  Logger.log('Migration complete: ' + migrated + ' rows');
  return { status: 'ok', message: migrated + '行をv3形式に変換しました', migrated: migrated };
}

/* ══════════════════════════════════════════════════════════
   clockIn アクション（v3）
   ══════════════════════════════════════════════════════════ */

function _doClockInV3(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName('attendance');
  if (!sheet) sheet = ss.insertSheet('attendance');

  const clockInDate    = data.date          || data.clockInDate  || '';
  const staffId        = data.staffId       || '';
  const staffName      = data.staffName     || '';
  const employmentType = data.employmentType || '';
  const clockInTime    = data.clockInTime   || data.clockIn      || '';
  const clockOutTime   = data.clockOutTime  || data.clockOut     || '';
  const clockOutDate   = clockOutTime
    ? _resolveClockOutDate(clockInDate, clockInTime, clockOutTime, data.clockOutDate || '')
    : '';
  const projectId      = String(data.projectId || '');

  sheet.appendRow([
    clockInDate,              // A
    staffId,                  // B
    staffName,                // C
    employmentType,           // D
    clockInTime,              // E
    clockOutDate,             // F
    clockOutTime,             // G
    new Date(),               // H
    projectId,                // I 案件ID（サイクルA・通常は空文字でPC操作で後付け）
  ]);

  return { status: 'ok', rowIndex: sheet.getLastRow() };
}

/* ══════════════════════════════════════════════════════════
   clockOut アクション（v3）
   ══════════════════════════════════════════════════════════ */

function _doClockOutV3(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('attendance');
  if (!sheet) return { status: 'error', message: 'attendance シートが見つかりません' };

  const rowIndex     = Number(data.rowIndex);
  const clockOutTime = data.clockOutTime || data.clockOut || '';

  if (!rowIndex || !clockOutTime) {
    return { status: 'error', message: 'rowIndex と clockOutTime は必須です' };
  }

  // 入店日・入店時刻を取得して退店日を計算
  const rawClockInDate = sheet.getRange(rowIndex, 1).getValue();
  const rawClockInTime = sheet.getRange(rowIndex, 5).getValue();
  const clockInDateStr = rawClockInDate instanceof Date ? _dateToStr(rawClockInDate) : String(rawClockInDate);
  const clockInTime    = _normalizeTimeStr(rawClockInTime);

  const clockOutDate = _resolveClockOutDate(
    clockInDateStr, clockInTime, clockOutTime, data.clockOutDate || ''
  );

  sheet.getRange(rowIndex, 6).setValue(clockOutDate);
  sheet.getRange(rowIndex, 7).setValue(clockOutTime);

  return { status: 'ok' };
}

/* ══════════════════════════════════════════════════════════
   updateAttendance アクション（v3）
   ══════════════════════════════════════════════════════════ */

function _doUpdateAttendanceV3(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('attendance');
  if (!sheet) return { status: 'error', message: 'attendance シートが見つかりません' };

  const rowIndex = Number(data.rowIndex);
  if (!rowIndex) return { status: 'error', message: 'rowIndex は必須です' };

  const clockInDate  = data.date        || data.clockInDate  || '';
  const staffId      = data.staffId     || '';
  const staffName    = data.staffName   || '';
  const clockInTime  = data.clockIn     || data.clockInTime  || '';
  const clockOutTime = (data.clockOut !== undefined) ? (data.clockOut || '') :
                       (data.clockOutTime !== undefined) ? (data.clockOutTime || '') : undefined;

  if (clockInDate)  sheet.getRange(rowIndex, 1).setValue(clockInDate);
  if (staffId)      sheet.getRange(rowIndex, 2).setValue(staffId);
  if (staffName)    sheet.getRange(rowIndex, 3).setValue(staffName);
  if (clockInTime)  sheet.getRange(rowIndex, 5).setValue(clockInTime);

  if (clockOutTime !== undefined) {
    if (!clockOutTime) {
      sheet.getRange(rowIndex, 6).setValue('');
      sheet.getRange(rowIndex, 7).setValue('');
    } else {
      const baseDate = clockInDate ||
        (function() {
          const v = sheet.getRange(rowIndex, 1).getValue();
          return v instanceof Date ? _dateToStr(v) : String(v);
        })();
      const baseCiTime = clockInTime ||
        _normalizeTimeStr(sheet.getRange(rowIndex, 5).getValue());

      const clockOutDate = _resolveClockOutDate(
        baseDate, baseCiTime, clockOutTime, data.clockOutDate || ''
      );
      sheet.getRange(rowIndex, 6).setValue(clockOutDate);
      sheet.getRange(rowIndex, 7).setValue(clockOutTime);
    }
  }

  // I列(9) projectId 更新（payload に含まれる場合のみ・空文字での解除も許容）
  // サイクルA：稼働メモ→案件 後付け紐付けのPC操作経路
  if (data.projectId !== undefined) {
    sheet.getRange(rowIndex, 9).setValue(String(data.projectId || ''));
  }

  return { status: 'ok' };
}

/* ══════════════════════════════════════════════════════════
   getAttendanceByMonth アクション（v3）
   ══════════════════════════════════════════════════════════ */

function _doGetAttendanceByMonthV3(data) {
  const month = data.month || '';
  if (!month) return { status: 'error', message: 'month は必須です (YYYY-MM)' };

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('attendance');
  if (!sheet) return { status: 'ok', data: [] };

  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { status: 'ok', data: [] };

  // 9列目（I列・案件ID）が存在する場合のみ projectId を読み出す（後方互換）
  const lastCol = Math.max(8, Math.min(9, sheet.getLastColumn()));
  const rows   = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const result = [];

  for (var i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawCiDate = row[0];
    const staffId   = row[1];
    const staffName = row[2];
    const empType   = row[3];
    const ciTimeRaw = row[4];
    const rawCoDate = row[5];
    const coTimeRaw = row[6];
    const regAt     = row[7];
    const projectId = lastCol >= 9 ? String(row[8] || '') : '';   // I列・案件ID（サイクルA）

    const clockInDate  = rawCiDate instanceof Date  ? _dateToStr(rawCiDate)  : String(rawCiDate  || '');
    const clockOutDate = rawCoDate instanceof Date   ? _dateToStr(rawCoDate)  : String(rawCoDate  || '');
    const clockInTime  = _normalizeTimeStr(ciTimeRaw);
    const clockOutTime = _normalizeTimeStr(coTimeRaw);

    // 月フィルタ（入店日ベース）
    if (!clockInDate.startsWith(month)) continue;

    const is_overnight = !!(clockOutDate && clockOutDate !== '' && clockOutDate !== clockInDate);

    // 勤務時間（分）
    let workMinutes = null;
    if (clockInTime && clockOutTime) {
      const ci = _parseHHMM(clockInTime);
      const co = _parseHHMM(clockOutTime);
      if (ci && co) {
        let total = (co.h * 60 + co.m) - (ci.h * 60 + ci.m);
        if (is_overnight) total += 24 * 60;
        if (total > 0) workMinutes = total;
      }
    }

    result.push({
      rowIndex:       i + 1,
      date:           clockInDate,
      clockInDate,
      staffId:        String(staffId  || ''),
      staffName:      String(staffName || ''),
      employmentType: String(empType  || ''),
      clockIn:        clockInTime,
      clockOut:       clockOutTime,
      clockOutDate,
      is_overnight,
      workMinutes,
      projectId,                   // I列・案件ID（サイクルA・後付け紐付け運用）
    });
  }

  return { status: 'ok', data: result };
}
