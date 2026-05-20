/**
 * ウルトラZAIMUくん LEO版 PWA — home.js
 * ホーム画面ロジック
 */

'use strict';

/* ── ストレージキー（clockin.js と共有） ─────────────────── */
const ATTENDANCE_DATE_KEY = 'uz_attendance_date';
const ATTENDANCE_DATA_KEY = 'uz_attendance_data';

/* ── 状態 ────────────────────────────────────────────────── */
let todayAttendance = []; // { id, name, clockIn, clockOut, isActive, rowIndex }
let _activeHomeTab = null; // 'pl' | 'attendance'（null=自動判定）

/* ── 時計（リアルタイム） ────────────────────────────────── */
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  const timeEl = document.getElementById('header-time');
  if (timeEl) timeEl.textContent = `${hh}:${mm}:${ss}`;
}

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

/* ── ヘッダー日付 ────────────────────────────────────────── */
function renderHeaderDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const w = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()];

  const el = document.getElementById('header-date');
  if (el) el.textContent = `${y}年${m}月${d}日（${w}）`;
}

/* ── カラータイマー状態判定 ──────────────────────────────── */
function _getTimerState(hasItem) {
  if (!hasItem) return null;
  const now  = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  let bizDays = 0;
  const cur = new Date(now); cur.setHours(0,0,0,0);
  const end = new Date(last); end.setHours(0,0,0,0);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) bizDays++;
    cur.setDate(cur.getDate() + 1);
  }
  if (bizDays <= 1) return 'blink';
  if (bizDays <= 3) return 'red';
  return 'blue';
}

/* カラータイマークラスをドット要素に付与する
   ボタン本体ではなく、ボタン内の dot 要素にクラスを当てる。
   消灯時（state=null）はクラスなし=ダークグレー縁のみ。
   history.js buildTimerDotHTML と同じ表現を採用。 */
function _applyTimerClass(dotEl, state) {
  if (!dotEl) return;
  dotEl.classList.remove('home-timer-dot--blue','home-timer-dot--red','home-timer-dot--blink');
  if (state === 'blue')  dotEl.classList.add('home-timer-dot--blue');
  if (state === 'red')   dotEl.classList.add('home-timer-dot--red');
  if (state === 'blink') dotEl.classList.add('home-timer-dot--blink');
}

/* ── アラートドット描画（補助） ─────────────────────────── */
function createAlertDot(urgent) {
  const dot = document.createElement('span');
  dot.className = urgent ? 'adot adot--red-blink' : 'adot adot--blue';
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function renderAlerts(alerts) {
  const { hasUncollected, hasPayable, hasUnrecordedClockOut } = alerts;
  /* カラータイマーはボタン内のドット要素（id=dot-uncollected/dot-payable）に当てる */
  _applyTimerClass(document.getElementById('dot-uncollected'), _getTimerState(hasUncollected));
  _applyTimerClass(document.getElementById('dot-payable'),     _getTimerState(hasPayable));
  const clockDot = document.getElementById('dot-clockout');
  if (clockDot) {
    clockDot.innerHTML = '';
    if (hasUnrecordedClockOut) {
      clockDot.appendChild(createAlertDot(true));
      clockDot.setAttribute('title', '退勤未記録（24時間経過）');
    }
  }
}

/* ── 勤怠リスト描画 ──────────────────────────────────────── */
function renderStaffList() {
  const container = document.getElementById('staff-list');
  if (!container) return;

  // 業態テンプレートのUI用語を取得（出勤中/入店中・退勤/退店等）
  const labels = (typeof deriveUILabels === 'function') ? deriveUILabels() : {
    clockin_active: '出勤中',
    clockout_label: '退勤',
    attendance_empty: '本日の出勤記録がありません',
  };

  const active   = todayAttendance.filter(s => s.isActive);
  const inactive = todayAttendance.filter(s => !s.isActive);
  const display  = [...active, ...inactive].slice(0, 6);

  if (display.length === 0) {
    container.innerHTML = `
      <div class="staff-item">
        <span class="staff-marker staff-marker--off">☆</span>
        <div class="staff-info">
          <div class="staff-name" style="color:var(--uz-muted)">${escapeHtml(labels.attendance_empty || '本日の出勤記録がありません')}</div>
        </div>
      </div>`;
    return;
  }

  container.innerHTML = display.map(s => {
    const ci = escapeHtml(s.clockIn || '—');
    const co = s.clockOut ? escapeHtml(s.clockOut) : '';
    if (s.isActive) {
      // 入店中（出勤中）：黄色●点滅 + 入店時刻
      return `
        <div class="staff-item">
          <span class="staff-marker staff-marker--active" aria-label="${escapeHtml(labels.clockin_active)}" title="${escapeHtml(labels.clockin_active)}"></span>
          <div class="staff-info">
            <div class="staff-name">${escapeHtml(s.name)}</div>
            <div class="staff-time">${ci}</div>
          </div>
          <span class="staff-status staff-status--active">${escapeHtml(labels.clockin_active)}</span>
          <button class="staff-clockout-btn" type="button" onclick="handleClockOut(${s.id})">${escapeHtml(labels.clockout_label || '退勤')}</button>
        </div>`;
    } else {
      // 退店済み（退勤済み）：グレー☆ + 入店→退店時刻
      return `
        <div class="staff-item">
          <span class="staff-marker staff-marker--off" aria-hidden="true">☆</span>
          <div class="staff-info">
            <div class="staff-name" style="color:var(--uz-muted)">${escapeHtml(s.name)}</div>
            <div class="staff-time">${ci} → ${co}</div>
          </div>
        </div>`;
    }
  }).join('');
}

/* ── 勤怠データをlocalStorageから即時描画 ────────────────── */
function renderStaffFromLocalStorage() {
  const savedDate = localStorage.getItem(ATTENDANCE_DATE_KEY);
  if (savedDate !== todayStr()) return; // 日付違いは無視

  try {
    const saved = JSON.parse(localStorage.getItem(ATTENDANCE_DATA_KEY)) || [];
    todayAttendance = saved;
    renderStaffList();
  } catch { /* localStorageが壊れていても無視 */ }
}

/* ── GAS から勤怠データを取得 ────────────────────────────── */
async function loadAttendance() {
  try {
    const res = await callGAS('getAttendance', { date: todayStr() });
    if (res && res.status === 'ok' && res.data) {
      const { attendance, hasUnrecordedClockOut } = res.data;

      // GASデータで todayAttendance を上書き
      todayAttendance = attendance.map(r => ({
        id:       r.staffId,
        name:     r.staffName,
        clockIn:  r.clockIn,
        clockOut: r.clockOut || null,
        isActive: r.isActive,
        rowIndex: r.rowIndex ?? null,
      }));

      // localStorageを最新データで更新（clockin.jsと共有）
      localStorage.setItem(ATTENDANCE_DATE_KEY, todayStr());
      localStorage.setItem(ATTENDANCE_DATA_KEY, JSON.stringify(todayAttendance));

      renderStaffList();
      _autoSwitchTab(); // 出勤データ取得後に自動タブ判定

      // 退店未記録フラグをアラートに反映（他フラグは既描画のまま更新）
      if (hasUnrecordedClockOut) {
        const clockDot = document.getElementById('dot-clockout');
        if (clockDot && !clockDot.hasChildNodes()) {
          clockDot.appendChild(createAlertDot(true));
          clockDot.setAttribute('title', '退勤未記録（24時間経過）');
        }
      }
    }
  } catch {
    // GAS失敗時はlocalStorageの描画をそのまま維持
  }
}

/* ── GAS から未収・買掛フラグを取得してカラータイマー更新 ─ */
async function loadAlerts() {
  renderAlerts({ hasUncollected: false, hasPayable: false, hasUnrecordedClockOut: false });
  try {
    const res = await callGAS('getUncollected', {});
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      const hasUncollected = res.data.some(r => r.type === 'uncollected');
      const hasPayable     = res.data.some(r => r.type === 'payable');
      renderAlerts({ hasUncollected, hasPayable, hasUnrecordedClockOut: false });
    }
  } catch { /* GAS失敗時はタイマーなし */ }
}

/* ── 損益サマリー描画 ────────────────────────────────────── */

/* 科目別内訳キャッシュ */
let _plBreakdown = { sales: [], cogs: [], sga: [] };

function _renderPLValues(pl) {
  const now = new Date();
  const monthRaw = pl.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [year, month] = String(monthRaw).includes('-')
    ? String(monthRaw).split('-').map(Number)
    : [pl.year ?? now.getFullYear(), Number(monthRaw)];

  const monthLabel = document.getElementById('pl-month-label');
  if (monthLabel) monthLabel.textContent = `${year}年${month}月（当月累計）`;

  const rows = [
    { id: 'pl-sales',  value: pl.sales           },
    { id: 'pl-cogs',   value: pl.cogs             },
    { id: 'pl-gross',  value: pl.grossProfit      },
    { id: 'pl-sga',    value: pl.sga              },
    { id: 'pl-profit', value: pl.operatingProfit  },
  ];

  rows.forEach(({ id, value }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = formatYen(value);
    el.classList.toggle('pl-value--negative', value < 0);
  });
}

function _renderPLError() {
  const monthLabel = document.getElementById('pl-month-label');
  if (monthLabel) monthLabel.textContent = 'データ取得エラー';

  ['pl-sales', 'pl-cogs', 'pl-gross', 'pl-sga', 'pl-profit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '¥—';
  });
}

/* 科目別内訳を getHistory から集計してキャッシュ */
async function _loadBreakdown(month) {
  try {
    /* getHistoryは売上・コスト混在で返す。typeフィールドで分離する */
    const res = await callGAS('getHistory', { month }).catch(() => null);
    const data = (res?.status === 'ok' && Array.isArray(res.data)) ? res.data : [];

    const salesMap = {}, cogsMap = {}, sgaMap = {};

    data.forEach(r => {
      if (r.type === 'sales') {
        /* 売上：itemName（GASフィールド名）でサービス別集計 */
        const name = r.itemName || '売上';
        salesMap[name] = (salesMap[name] || 0) + (Number(r.amount) || 0);

      } else if (r.type === 'cost') {
        /* コスト：divisionCode '1'=仕入原価 / それ以外=販管費 */
        const name = r.itemName || '経費';
        const amt  = Number(r.amount) || 0;
        if (String(r.divisionCode) === '1') {
          cogsMap[name] = (cogsMap[name] || 0) + amt;
        } else {
          sgaMap[name] = (sgaMap[name] || 0) + amt;
        }
      }
    });

    const toArr = map => Object.entries(map)
      .map(([name, amt]) => ({ name, amt }))
      .sort((a, b) => b.amt - a.amt);

    _plBreakdown = { sales: toArr(salesMap), cogs: toArr(cogsMap), sga: toArr(sgaMap) };
  } catch {
    _plBreakdown = { sales: [], cogs: [], sga: [] };
  }
}

/* アコーディオン開閉 */
function togglePlAccordion(key) {
  const detail = document.getElementById(`pl-detail-${key}`);
  const chev   = document.getElementById(`pl-chev-${key}`);
  const btn    = detail?.previousElementSibling;
  if (!detail) return;

  const isOpen = !detail.hidden;

  if (isOpen) {
    detail.hidden = true;
    chev?.classList.remove('pl-chevron--open');
    btn?.setAttribute('aria-expanded', 'false');
  } else {
    /* 内訳を描画してから展開 */
    const items = _plBreakdown[key] || [];
    if (items.length === 0) {
      detail.innerHTML = '<div class="pl-detail-row" style="color:var(--uz-text3);font-size:12px;padding:4px 0;">内訳データなし</div>';
    } else {
      detail.innerHTML = items.map(it =>
        `<div class="pl-detail-row">
          <span class="pl-detail-row__name">${escapeHtml(it.name)}</span>
          <span class="pl-detail-row__val">${formatYen(it.amt)}</span>
        </div>`
      ).join('');
    }
    detail.hidden = false;
    chev?.classList.add('pl-chevron--open');
    btn?.setAttribute('aria-expanded', 'true');
  }
}

async function loadPL() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthStr = `${year}-${month}`;

  try {
    const [res] = await Promise.all([
      callGAS('getSummary', { month: monthStr }),
      _loadBreakdown(monthStr),   /* 内訳を並行取得 */
    ]);
    if (res && res.status === 'ok' && res.data) {
      _renderPLValues(res.data);
    } else {
      _renderPLError();
    }
  } catch {
    _renderPLError();
  }
}

/* ── 退勤処理（ホーム画面から） ──────────────────────────── */
async function handleClockOut(staffId) {
  const record = todayAttendance.find(s => s.id === staffId);
  if (!record) return;

  if (!confirm(`${record.name}さんを退勤記録しますか？`)) return;

  const now = new Date();
  const clockOutTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  try {
    const result = await callGAS('clockOut', {
      staffId:     record.id,
      clockOutTime,
      rowIndex:    record.rowIndex ?? null,
    });
    if (result.status !== 'ok') throw new Error(result.message || '登録エラー');

    record.clockOut = clockOutTime;
    record.isActive = false;

    // localStorageを更新してclockIn画面と同期
    localStorage.setItem(ATTENDANCE_DATE_KEY, todayStr());
    localStorage.setItem(ATTENDANCE_DATA_KEY, JSON.stringify(todayAttendance));

    renderStaffList();
    showToast(`${record.name}さんの退勤を記録しました`, 'success');

  } catch (e) {
    showToast('退勤記録に失敗しました：' + e.message, 'error');
  }
}

/* ── XSSエスケープ ───────────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── 確定申告タイマー ────────────────────────────────────── */
function renderTaxTimer() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const el    = document.getElementById('tax-timer');
  if (!el) return;

  const inPeriod = (month === 2 && day >= 16) || (month === 3 && day <= 15);
  if (!inPeriod) { el.style.display = 'none'; return; }

  const deadline = new Date(now.getFullYear(), 2, 15); // 3/15
  const diffMs   = deadline - now;
  const diffDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

  if (diffDays <= 3) {
    el.className = 'tax-timer-red';
    el.textContent = `確定申告期限まであと ${diffDays}日！（3/15締切）`;
  } else {
    el.className = 'tax-timer-blue';
    el.textContent = `確定申告受付中　あと ${diffDays}日（3/15締切）`;
  }
  el.style.display = 'block';
}

/* ── 初期化 ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  renderHeaderDate();
  startClock();
  renderTaxTimer();

  // タブ初期表示（損益）
  switchHomeTab('pl', true);

  // localStorageで即時描画 → GASで上書き
  renderStaffFromLocalStorage();
  loadAttendance();
  loadAlerts();
  loadPL();

  if (document.body.classList.contains('is-ipad')) {
    initIpadHome();
  }
});

/* ── iPad ホームダッシュボード ────────────────────────────── */
async function initIpadHome() {
  if (!document.body.classList.contains('is-ipad')) return;
  const dashboard = document.getElementById('ipad-home-dashboard');
  if (!dashboard) return;

  const now          = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  // 月選択プルダウン初期化
  _initMonthSelect(currentMonth);

  // 確定申告タイマー
  _renderIpadTaxTimer();

  // DL・コピーボタン
  document.getElementById('ipad-btn-copy')?.addEventListener('click', _ipadCopyPL);
  document.getElementById('ipad-btn-dl')?.addEventListener('click', _ipadToggleTaxDLPanel);

  // 税理士用CSV DL実行ボタン
  document.getElementById('ipad-tax-dl-exec')?.addEventListener('click', () => {
    const from = document.getElementById('ipad-tax-from')?.value;
    const to   = document.getElementById('ipad-tax-to')?.value;
    downloadTaxCSVByRange(from, to, document.getElementById('ipad-tax-dl-exec'));
  });

  // 当月損益を表示
  const summary = await callGAS('getSummary', { month: currentMonth }).catch(() => null);
  if (summary && summary.status === 'ok' && summary.data) {
    _renderIpadPLRows(summary.data);
  }

  // 直近入力を右カラムに表示
  _renderIpadRecentEntries(currentMonth);

  // 月次損益グラフ
  _renderIpadMonthlyChart(now.getFullYear());

  // iPad出勤状況を左カラムに表示
  _renderIpadAttendance();
}

function _initMonthSelect(currentMonth) {
  const sel = document.getElementById('ipad-month-select');
  if (!sel) return;
  const now = new Date();
  for (let i = 0; i < 13; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = `${d.getFullYear()}年${d.getMonth()+1}月`;
    sel.appendChild(opt);
  }
  sel.value = currentMonth;
  sel.addEventListener('change', async () => {
    const res = await callGAS('getSummary', { month: sel.value }).catch(() => null);
    if (res && res.status === 'ok' && res.data) _renderIpadPLRows(res.data);
  });
}

function _renderIpadPLRows(d) {
  const sales  = d.sales           ?? 0;
  const cogs   = d.cogs            ?? 0;
  const sga    = d.sga             ?? 0;
  const gross  = d.grossProfit     ?? (sales - cogs);
  const profit = d.operatingProfit ?? (gross - sga);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = formatYen(v); };
  set('ipad-pl-sales',  sales);
  set('ipad-pl-cogs',   cogs);
  set('ipad-pl-gross',  gross);
  set('ipad-pl-sga',    sga);
  set('ipad-pl-profit', profit);

  const profEl = document.getElementById('ipad-pl-profit');
  if (profEl) profEl.style.color = '';
}

function _renderIpadTaxTimer() {
  const el = document.getElementById('ipad-tax-timer-right');
  if (!el) return;
  const now = new Date();
  const m   = now.getMonth() + 1;
  const d   = now.getDate();
  const inPeriod = (m === 2 && d >= 16) || (m === 3 && d <= 15);
  if (!inPeriod) { el.style.display = 'none'; return; }
  const deadline = new Date(now.getFullYear(), 2, 15);
  const diffDays = Math.max(0, Math.ceil((deadline - now) / 86400000));
  el.className   = diffDays <= 3 ? 'tax-timer-red' : 'tax-timer-blue';
  el.textContent = diffDays <= 3
    ? `確定申告期限まであと ${diffDays}日！（3/15締切）`
    : `確定申告受付中　あと ${diffDays}日（3/15締切）`;
  el.style.display = 'block';
}

/* ── iPad 直近入力テーブル ──────────────────────────── */
async function _renderIpadRecentEntries(month) {
  const tbody = document.getElementById('ipad-recent-body');
  const empty = document.getElementById('ipad-recent-empty');
  if (!tbody) return;

  try {
    const [salesRes, costRes] = await Promise.all([
      callGAS('getHistory', { type: 'sales', month }).catch(() => null),
      callGAS('getHistory', { type: 'cost',  month }).catch(() => null),
    ]);

    const items = [];
    if (salesRes && salesRes.status === 'ok' && Array.isArray(salesRes.data)) {
      salesRes.data.forEach(r => items.push({
        name:   r.service || r.serviceName || '売上',
        amount: r.taxIncluded ?? r.amount ?? 0,
        type:   'sales',
        date:   String(r.date || ''),
      }));
    }
    if (costRes && costRes.status === 'ok' && Array.isArray(costRes.data)) {
      costRes.data.forEach(r => items.push({
        name:   r.itemName || r.item || 'コスト',
        amount: r.taxIncluded ?? r.amount ?? 0,
        type:   'cost',
        date:   String(r.date || ''),
      }));
    }

    items.sort((a, b) => b.date.localeCompare(a.date));
    const top = items.slice(0, 15);

    if (top.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    tbody.innerHTML = top.map(it => {
      const md    = it.date.replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
      const nm    = escapeHtml(it.name).substring(0, 12);
      const badge = it.type === 'sales'
        ? '<span style="color:var(--uz-gold);font-size:11px;">売上</span>'
        : '<span style="color:var(--uz-red);font-size:11px;">コスト</span>';
      const cls   = it.type === 'sales' ? 'recent-sales' : 'recent-cost';
      return `<tr>
        <td style="font-size:13px;white-space:nowrap;">${md}</td>
        <td>${badge}</td>
        <td style="font-size:13px;">${nm}</td>
        <td class="${cls}">${formatYen(it.amount)}</td>
      </tr>`;
    }).join('');
  } catch {
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
  }
}

/* ── iPad 出勤状況（ダッシュボード左カラム） ──────── */
async function _renderIpadAttendance() {
  const container = document.getElementById('ipad-staff-list');
  if (!container) return;

  // todayAttendance は home.js の既存グローバル変数を使用
  // 既にfetchAttendance()で取得済みのはず
  if (todayAttendance.length === 0) {
    container.innerHTML = '<div style="padding:14px;font-size:13px;color:var(--uz-text2);">出勤データなし</div>';
    return;
  }

  container.innerHTML = todayAttendance.map(s => {
    const status = s.isActive
      ? '<span style="color:var(--uz-green);font-weight:600;">出勤中</span>'
      : '<span style="color:var(--uz-text2);">退勤済</span>';
    const time = s.clockIn ? s.clockIn : '—';
    const out  = s.clockOut ? ` → ${s.clockOut}` : '';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--uz-border);">
      <div>
        <span style="font-size:14px;font-weight:500;">${escapeHtml(s.name)}</span>
        <span style="font-size:12px;color:var(--uz-text2);margin-left:8px;">${time}${out}</span>
      </div>
      ${status}
    </div>`;
  }).join('');
}

/* ── iPad 月次損益グラフ ────────────────────────────── */
let _ipadChart = null;

async function _renderIpadMonthlyChart(year) {
  const canvas  = document.getElementById('ipad-pl-chart');
  const loading = document.getElementById('ipad-chart-loading');
  if (!canvas || typeof Chart === 'undefined') return;

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      return callGAS('getSummary', { month: `${year}-${m}` }).catch(() => null);
    })
  );

  if (loading) loading.style.display = 'none';

  const labels     = results.map((_, i) => `${i + 1}月`);
  const salesData  = results.map(r =>
    (r && r.status === 'ok' && r.data) ? (r.data.sales ?? 0) : 0
  );
  const profitData = results.map(r => {
    if (!r || r.status !== 'ok' || !r.data) return 0;
    const d = r.data;
    return d.operatingProfit ?? ((d.sales ?? 0) - (d.cogs ?? 0) - (d.sga ?? 0));
  });

  if (_ipadChart) { _ipadChart.destroy(); _ipadChart = null; }

  const _cs = getComputedStyle(document.documentElement);
  const _cSales   = _cs.getPropertyValue('--uz-sales').trim()   || '#333333';
  const _cProfit  = _cs.getPropertyValue('--uz-profit').trim()  || '#27AE60';
  const _cMuted   = _cs.getPropertyValue('--uz-text2').trim()   || '#666666';
  const _cGrid    = _cs.getPropertyValue('--uz-border').trim()  || 'rgba(0,0,0,0.10)';

  _ipadChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '売上',
          data: salesData,
          backgroundColor: _cSales + 'B3',
          borderColor: _cSales,
          borderWidth: 1,
          borderRadius: 3,
        },
        {
          label: '経常利益',
          data: profitData,
          backgroundColor: _cProfit + 'B3',
          borderColor: _cProfit,
          borderWidth: 1,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: _cMuted, font: { size: 11 } } },
      },
      scales: {
        x: {
          ticks: { color: _cMuted, font: { size: 10 } },
          grid:  { color: _cGrid },
        },
        y: {
          ticks: {
            color: _cMuted,
            font:  { size: 10 },
            callback: v => {
              const abs = Math.abs(v);
              if (abs >= 10000) return (v < 0 ? '-' : '') + Math.round(abs / 10000) + '万';
              return v;
            },
          },
          grid: { color: _cGrid },
        },
      },
    },
  });
}

function _ipadToggleTaxDLPanel() {
  const panel   = document.getElementById('ipad-tax-dl-panel');
  const fromSel = document.getElementById('ipad-tax-from');
  const toSel   = document.getElementById('ipad-tax-to');
  if (!panel) return;

  if (panel.hidden) {
    // 初回表示時にプルダウンを生成
    if (!fromSel?.options.length) {
      const now      = new Date();
      const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const fromDefault = `${Math.max(now.getFullYear(), 2025)}-01`;
      buildMonthOptions(fromSel, fromDefault);
      buildMonthOptions(toSel,   curMonth);
    }
    panel.hidden = false;
  } else {
    panel.hidden = true;
  }
}

function _ipadCopyPL() {
  const rows = [
    ['売上',     document.getElementById('ipad-pl-sales')?.textContent   || '—'],
    ['仕入原価', document.getElementById('ipad-pl-cogs')?.textContent    || '—'],
    ['粗利',     document.getElementById('ipad-pl-gross')?.textContent   || '—'],
    ['販管費',   document.getElementById('ipad-pl-sga')?.textContent     || '—'],
    ['経常利益', document.getElementById('ipad-pl-profit')?.textContent  || '—'],
  ];
  const text = rows.map(r => `${r[0]}\t${r[1]}`).join('\n');
  navigator.clipboard?.writeText(text)
    .then(() => showToast('損益データをコピーしました', 'success'))
    .catch(() => showToast('コピーに失敗しました', 'error'));
}

async function loadSidebarRecent() {
  const container = document.getElementById('sidebar-recent');
  if (!container) return;

  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  try {
    const [salesRes, costRes] = await Promise.all([
      callGAS('getHistory', { type: 'sales', month }).catch(() => null),
      callGAS('getHistory', { type: 'cost',  month }).catch(() => null),
    ]);

    const items = [];
    if (salesRes && salesRes.status === 'ok' && Array.isArray(salesRes.data)) {
      salesRes.data.slice(0, 5).forEach(r => items.push({
        name:  r.service || r.serviceName || '売上',
        amount: r.taxIncluded ?? r.amount ?? 0,
        type:  'sales',
        date:  String(r.date || ''),
      }));
    }
    if (costRes && costRes.status === 'ok' && Array.isArray(costRes.data)) {
      costRes.data.slice(0, 5).forEach(r => items.push({
        name:  r.itemName || r.item || 'コスト',
        amount: r.taxIncluded ?? r.amount ?? 0,
        type:  'cost',
        date:  String(r.date || ''),
      }));
    }

    items.sort((a, b) => b.date.localeCompare(a.date));
    const top = items.slice(0, 8);

    if (top.length === 0) {
      container.innerHTML = '<div class="sidebar-recent__title">今月の記録なし</div>';
      return;
    }

    container.innerHTML = `<div class="sidebar-recent__title">最近の入力</div>`
      + top.map(it => {
          const md    = it.date.replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3');
          const nm    = escapeHtml(it.name).substring(0, 10);
          const color = it.type === 'sales' ? 'var(--uz-gold)' : 'var(--uz-red)';
          return `<div class="sidebar-recent__item">
            <span class="sidebar-recent__item-name">${md} ${nm}</span>
            <span class="sidebar-recent__item-amt" style="color:${color}">${formatYen(it.amount)}</span>
          </div>`;
        }).join('');
  } catch {
    container.innerHTML = '';
  }
}

/* ── ホームタブ切替 ──────────────────────────────────────── */

/**
 * タブ切替
 * tab: 'pl' | 'attendance'
 * auto: true=自動判定（強制上書きしない）
 */
function switchHomeTab(tab, auto) {
  const tabPl   = document.getElementById('tab-pl');
  const tabAtt  = document.getElementById('tab-attendance');
  const panelPl = document.getElementById('panel-pl');
  const panelAt = document.getElementById('panel-attendance');
  if (!tabPl || !tabAtt || !panelPl || !panelAt) return;

  // 自動判定時はユーザーが既に手動で選択していれば従う
  if (auto && _activeHomeTab !== null) return;

  _activeHomeTab = tab;

  if (tab === 'pl') {
    tabPl.classList.add('active');
    tabAtt.classList.remove('active');
    panelPl.style.display = '';
    panelAt.style.display = 'none';
  } else {
    tabAtt.classList.add('active');
    tabPl.classList.remove('active');
    panelAt.style.display = '';
    panelPl.style.display = 'none';
  }
}

/**
 * 出勤データ取得後に自動タブ判定
 * 仕様（02_画面仕様.md §3）：
 *   1名以上出勤中 → 出勤状況タブをデフォルト表示
 *   出勤中ゼロ   → 損益タブをデフォルト表示
 */
function _autoSwitchTab() {
  const hasActive = todayAttendance.some(s => s.isActive);
  switchHomeTab(hasActive ? 'attendance' : 'pl', true);
}

/**
 * 出勤バナー通知
 * msg: 「〇〇さんが出勤しました」等
 */
function showAttendanceBanner(msg) {
  const el = document.getElementById('home-attendance-banner');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}
