/**
 * ウルトラZAIMUくん LEO版 GAS — sales_ranking.gs
 * 売上サービスカテゴリのランキング集計
 *
 * 既存の doGet の switch 文に以下を追記してください:
 * ─────────────────────────────────────────────────────────
 *   case 'getSalesCategoryRanking':
 *     return jsonResponse(getSalesCategoryRanking_(data.months));
 * ─────────────────────────────────────────────────────────
 *
 * sales シート列構成（既存に合わせること）:
 *   A: 発生日, ..., (serviceCode列は既存シートを確認して COL_SERVICE_CODE を調整)
 *
 * 注意: COL_SERVICE_CODE は sales シートの実際の列位置（0始まり）に合わせること
 */

function getSalesCategoryRanking_(months) {
  const monthsNum = parseInt(months, 10) || 1;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('sales');
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const lastCol = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // ヘッダー行から serviceCode 列を特定
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const COL_DATE         = headers.findIndex(h => /^(日付|発生日|date)/i.test(String(h)));
  const COL_SERVICE_CODE = headers.findIndex(h => /^(サービスコード|serviceCode|service_code)/i.test(String(h)));

  // ヘッダーで見つからない場合のフォールバック（列位置を直接指定）
  const dateCol    = COL_DATE         >= 0 ? COL_DATE         : 0;
  const svcCodeCol = COL_SERVICE_CODE >= 0 ? COL_SERVICE_CODE : 1;

  // 直近 N ヶ月の閾値
  const now       = new Date();
  const threshold = new Date(now.getFullYear(), now.getMonth() - monthsNum, now.getDate());

  const counter = new Map();
  data.forEach(function(row) {
    const rawDate = row[dateCol];
    if (!rawDate) return;
    const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    if (isNaN(date.getTime()) || date < threshold) return;

    const code = String(row[svcCodeCol] || '').trim();
    if (!code) return;
    counter.set(code, (counter.get(code) || 0) + 1);
  });

  return Array.from(counter.entries())
    .map(function(entry) { return { code: entry[0], count: entry[1] }; })
    .sort(function(a, b) { return b.count - a.count; });
}
