/**
 * ウルトラZAIMUくん LEO版 PWA — settings.js
 * 設定画面ロジック（localStorage + GAS双方向同期版）
 *
 * 起動時: GAS getSettings → localStorage上書き → UI描画
 * 変更時: localStorage即時保存 → GAS saveSettings（バックグラウンド）
 */

'use strict';

/* ── ストレージキー ──────────────────────────────────────── */
const STORE_NAME_KEY        = 'uz_store_name';
const STAFF_MASTER_KEY      = 'uz_staff_master';
const SERVICE_MASTER_KEY    = 'uz_service_master';
const PURCHASE_MASTER_KEY   = 'uz_purchase_master';     // 6-G フェーズ2 新設
const MASTER_QUOTA_KEY      = 'uz_master_quota';        // 6-G フェーズ2 新設

/* ── デフォルト値 ────────────────────────────────────────── */
const DEFAULT_STORE_NAME = 'スナック LEO';
// 雇用形態は3種化（戦略思想§3-9-3 サイクルA）：
//   employed_full / employed_temp / contractor
const DEFAULT_STAFF = [
  { id: 1, name: 'さくら', employmentType: 'employed_full' },
  { id: 2, name: 'あかね', employmentType: 'employed_full' },
  { id: 3, name: 'みか',   employmentType: 'employed_full' },
  { id: 4, name: 'ゆき',   employmentType: 'employed_full' },
];
// 既存ユーザーのフォールバック用デフォルト（id 採番方式は sv001〜・01_商品体系.md §4-3-1）
const DEFAULT_SERVICES = [
  { id: 'sv001', name: '店内売上',     taxRate: 10 },
  { id: 'sv002', name: 'テイクアウト', taxRate:  8 },
];
const DEFAULT_PURCHASES = [];  // 業種固有・ターゲット社が納品時に投入する想定（フォールバックは空）
// 既存ユーザーで masterQuota 未投入時のフォールバック（01_商品体系.md §4-3）
const DEFAULT_MASTER_QUOTA = { serviceMasterQuota: 5, purchaseMasterQuota: 3, costOptionalQuota: 5 };

/* ── パスワード関連ヘルパー（スタッフ枠パスワード）──────────────
 * 戦略思想§3-7「商売の都合優先」+ システム仕様書§10-3 準拠：
 *   - 日常打刻はワンタップ（パスワード入力なし）
 *   - パスワードはやめたスタッフのログイン防止・退職時の枠流用に使用
 *   - オーナーが settings 画面でスタッフ追加・パスワード変更を行う
 * 形式：5桁英数字（半角英大小文字＋数字）
 * ハッシュ：SHA-256・ソルトは staffId（管理ポータルのPINと同等の方式・技術仕様書§3-6）
 * 平文はクライアント・サーバいずれにも保持しない（送信もハッシュ済み）
 */
const STAFF_PW_PATTERN = /^[A-Za-z0-9]{5}$/;

/**
 * スタッフ枠パスワードのバリデーション
 * @param {string} pw
 * @returns {boolean} 5桁英数字に合致すれば true
 */
function validateStaffPassword(pw) {
  return typeof pw === 'string' && STAFF_PW_PATTERN.test(pw);
}

/**
 * スタッフ枠パスワードをハッシュ化（SHA-256・ソルトは staffId）
 * @param {number|string} staffId
 * @param {string} password
 * @returns {Promise<string>} 16進文字列のハッシュ値
 */
async function hashStaffPassword(staffId, password) {
  const salted  = `staff:${staffId}:${password}`;
  const encoded = new TextEncoder().encode(salted);
  const buf     = await crypto.subtle.digest('SHA-256', encoded);
  const bytes   = Array.from(new Uint8Array(buf));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── localStorage アクセサ ───────────────────────────────── */
function getStoreName() {
  return localStorage.getItem(STORE_NAME_KEY) || DEFAULT_STORE_NAME;
}

function _saveStoreName(name) {
  localStorage.setItem(STORE_NAME_KEY, name);
}

function getStaffList() {
  try {
    const saved = localStorage.getItem(STAFF_MASTER_KEY);
    return saved ? JSON.parse(saved) : [...DEFAULT_STAFF];
  } catch { return [...DEFAULT_STAFF]; }
}

function _saveStaffList(list) {
  localStorage.setItem(STAFF_MASTER_KEY, JSON.stringify(list));
}

function getServiceList() {
  try {
    const saved = localStorage.getItem(SERVICE_MASTER_KEY);
    return saved ? JSON.parse(saved) : [...DEFAULT_SERVICES];
  } catch { return [...DEFAULT_SERVICES]; }
}

function _saveServiceList(list) {
  localStorage.setItem(SERVICE_MASTER_KEY, JSON.stringify(list));
}

/* ── 仕入原価マスタ（6-G フェーズ2 新設）─────────────────── */
function getPurchaseList() {
  try {
    const saved = localStorage.getItem(PURCHASE_MASTER_KEY);
    return saved ? JSON.parse(saved) : [...DEFAULT_PURCHASES];
  } catch { return [...DEFAULT_PURCHASES]; }
}

function _savePurchaseList(list) {
  localStorage.setItem(PURCHASE_MASTER_KEY, JSON.stringify(list));
}

/* ── マスタ件数枠（6-G フェーズ2 新設・運営付与の枠数キャッシュ）─ */
function getMasterQuota() {
  try {
    const saved = localStorage.getItem(MASTER_QUOTA_KEY);
    if (!saved) return { ...DEFAULT_MASTER_QUOTA };
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === 'object'
        && typeof parsed.serviceMasterQuota === 'number'
        && typeof parsed.purchaseMasterQuota === 'number') {
      return parsed;
    }
    return { ...DEFAULT_MASTER_QUOTA };
  } catch { return { ...DEFAULT_MASTER_QUOTA }; }
}

function _saveMasterQuota(quota) {
  if (!quota || typeof quota !== 'object') return;
  localStorage.setItem(MASTER_QUOTA_KEY, JSON.stringify(quota));
}

/* ── GAS 同期 ────────────────────────────────────────────── */

/**
 * 起動時にGASからマスタ設定を取得し、localStorageとUIを更新する。
 * GAS失敗時はlocalStorageのデータをそのまま使用。
 */
async function loadSettingsFromGAS() {
  try {
    const res = await callGAS('getSettings', {});
    if (res && res.status === 'ok' && res.data) {
      const { storeName, staffList, serviceList, purchaseMasterList, masterQuota, businessHours } = res.data;
      if (storeName   != null) _saveStoreName(storeName);
      if (Array.isArray(staffList))   _saveStaffList(staffList);
      if (Array.isArray(serviceList)) _saveServiceList(serviceList);
      // 6-G フェーズ2：仕入マスタを受け取る
      if (Array.isArray(purchaseMasterList)) _savePurchaseList(purchaseMasterList);
      // 6-G フェーズ2：マスタ件数枠を受け取る（null なら既存ユーザー扱い・フォールバック）
      if (masterQuota && typeof masterQuota === 'object') {
        _saveMasterQuota(masterQuota);
      }
      // businessHours も localStorage に保存（A-9：基本情報・出勤履歴判定で使用）
      if (businessHours && typeof businessHours === 'object' && businessHours.open && businessHours.close) {
        try { localStorage.setItem('uz_business_hours', JSON.stringify(businessHours)); } catch { /* ignore */ }
      } else {
        try { localStorage.removeItem('uz_business_hours'); } catch { /* ignore */ }
      }
      // UIを最新データで再描画
      initBasicInfo();
      renderStaffList();
      renderServiceList();
      renderPurchaseList();
      updateGasStatus(true);
    } else {
      updateGasStatus(false);
    }
  } catch {
    updateGasStatus(false);
  }
  // コスト科目マスタも並行取得
  loadCostMasterFromGAS();
}

/**
 * 現在のlocalStorage全設定をGASに保存（バックグラウンド・失敗はサイレント）。
 *
 * 6-G フェーズ2：
 *   サービスマスタ／仕入マスタの追加・更新・削除はサーバ側専用 action
 *   （addServiceItem / updateServiceItem / deleteServiceItem / addPurchaseItem /
 *    updatePurchaseItem / deletePurchaseItem）で行う。saveSettings には serviceList /
 *   purchaseMasterList を含めない（サーバ側のID採番・枠超過チェックと競合するため）。
 */
async function saveSettingsToGAS() {
  try {
    await callGAS('saveSettings', {
      storeName:   getStoreName(),
      staffList:   getStaffList(),
    });
  } catch {
    // localStorageには保存済みのため、GAS失敗はサイレントフェイル
  }
}

/**
 * スタッフマスタのみをGASに保存（storeName / serviceListに影響しない）。
 */
async function saveStaffListToGAS() {
  try {
    await callGAS('saveStaffList', { staffList: getStaffList() });
  } catch {
    // localStorageには保存済みのため、GAS失敗はサイレントフェイル
  }
}

/* ── コスト科目マスタ GAS同期 ──────────────────────────── */
async function loadCostMasterFromGAS() {
  try {
    const res = await callGAS('getCostMaster', {});
    if (res && res.status === 'ok' && Array.isArray(res.data)) {
      saveCostMasterToStorage(res.data);
      renderCostMaster();
    }
  } catch { /* サイレントフェイル */ }
}

async function saveCostMasterToGAS(list) {
  try {
    await callGAS('saveCostMaster', { costMasterList: list });
  } catch { /* サイレントフェイル */ }
}

function updateGasStatus(connected) {
  const el = document.getElementById('gas-status-val');
  if (!el) return;
  if (connected) {
    el.textContent = '接続済み ✓';
    el.style.color = 'var(--uz-green)';
  } else {
    el.textContent = '未接続（ローカル保存）';
    el.style.color = 'var(--uz-muted)';
  }
}

/* ── 初期化 ──────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // まずlocalStorageで即時描画
  initStaffList();
  initServiceList();
  initPurchaseList();
  initCostMaster();
  initBasicInfo();
  bindStaffAdd();
  bindServiceAdd();
  bindPurchaseAdd();
  bindCostMasterSave();
  bindVersionTapDebug();
  // GASから最新データを取得して上書き
  loadSettingsFromGAS();
});

/* ── 基本情報セクション（読み取り専用） ──────────────────── */
function initBasicInfo() {
  // 店舗名はlocalStorage即時値で先に描画
  const storeEl = document.getElementById('info-store-name');
  if (storeEl) storeEl.textContent = getStoreName() || '—';

  // 営業時間（A-9：businessHours が設定されていれば表示・未設定なら行ごと非表示）
  _renderBusinessHoursRow();
}

/**
 * 基本情報セクションの「営業時間」行を描画。
 * businessHours が localStorage にあれば「19:00 〜 翌03:00」形式で表示・無ければ行ごと非表示。
 * GAS同期完了後にも呼び出される。
 */
function _renderBusinessHoursRow() {
  const row = document.getElementById('info-business-hours-row');
  const val = document.getElementById('info-business-hours');
  if (!row || !val) return;

  let formatted = null;
  try {
    if (typeof getBusinessHours === 'function' && typeof formatBusinessHours === 'function') {
      const bh = getBusinessHours();
      formatted = formatBusinessHours(bh);
    }
  } catch { formatted = null; }

  if (formatted) {
    val.textContent = formatted;
    row.hidden = false;
  } else {
    row.hidden = true;
  }
}

/* ── バージョン5タップで GAS接続情報を展開（隠しコマンド） ── */
function bindVersionTapDebug() {
  const ver = document.getElementById('info-version');
  const dbg = document.getElementById('info-debug');
  if (!ver || !dbg) return;

  let count = 0;
  let timer = null;
  ver.addEventListener('click', () => {
    count++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { count = 0; }, 1200);
    if (count >= 5) {
      count = 0;
      dbg.hidden = !dbg.hidden;
      if (!dbg.hidden) {
        // WebアプリURL を埋め込み（app.js の GAS_URL を参照）
        const urlEl = document.getElementById('gas-url-val');
        try {
          if (urlEl && typeof GAS_URL === 'string') urlEl.textContent = GAS_URL;
        } catch { /* ignore */ }
      }
    }
  });
}

/* ── スタッフマスタ ──────────────────────────────────────── */
function initStaffList() {
  renderStaffList();
}

function renderStaffList() {
  const container = document.getElementById('staff-list-container');
  if (!container) return;

  const list = getStaffList();

  if (list.length === 0) {
    container.innerHTML = `
      <div style="padding:16px;color:var(--uz-muted);font-size:13px;text-align:center;">
        スタッフが登録されていません
      </div>`;
    return;
  }

  container.innerHTML = list.map(s => {
    const empType = _normalizeEmpType(s.employmentType);
    const badge = _empTypeBadge(empType);
    return `
      <div class="staff-row" id="staff-row-${s.id}">
        <span class="staff-row__name">${escHtml(s.name)}</span>
        ${badge}
        <button class="staff-edit-btn"
                type="button"
                onclick="editStaff(${s.id})"
                aria-label="${escHtml(s.name)}を編集">
          編集
        </button>
        <button class="staff-delete-btn"
                type="button"
                onclick="deleteStaff(${s.id})"
                aria-label="${escHtml(s.name)}を削除">
          削除
        </button>
      </div>
    `;
  }).join('');
}

/**
 * 雇用形態 3種化（サイクルA）：旧 'employed' / 未設定は employed_full に寄せる
 */
function _normalizeEmpType(value) {
  if (value === 'employed_full' || value === 'employed_temp' || value === 'contractor') return value;
  return 'employed_full';
}

/**
 * 雇用形態バッジ HTML 生成
 *   - employed_full : 常勤雇用（既存 employed バッジ流用）
 *   - employed_temp : 臨時アルバイト（新規・既存 employed バッジ流用＋ラベル変更）
 *   - contractor    : 委託・外注（既存 contractor バッジ流用）
 */
function _empTypeBadge(empType) {
  if (empType === 'contractor') {
    return `<span class="staff-emp-badge staff-emp-badge--contractor">委託・外注</span>`;
  }
  if (empType === 'employed_temp') {
    return `<span class="staff-emp-badge staff-emp-badge--employed">臨時アルバイト</span>`;
  }
  // employed_full（旧 employed 含む）
  return `<span class="staff-emp-badge staff-emp-badge--employed">常勤雇用</span>`;
}

function editStaff(id) {
  const list  = getStaffList();
  const staff = list.find(s => s.id === id);
  if (!staff) return;

  const row = document.getElementById(`staff-row-${id}`);
  if (!row) return;

  const empType = _normalizeEmpType(staff.employmentType);
  row.innerHTML = `
    <input type="text"
           id="staff-edit-name-${id}"
           class="settings-input"
           style="flex:1;min-width:80px;height:40px;font-size:14px;"
           value="${escHtml(staff.name)}"
           maxlength="20"
           autocomplete="off"
           aria-label="スタッフ名">
    <select id="staff-edit-emp-${id}"
            class="form-select"
            style="height:40px;font-size:13px;flex-shrink:0;"
            aria-label="雇用形態">
      <option value="employed_full"${empType === 'employed_full' ? ' selected' : ''}>常勤雇用（社員）</option>
      <option value="employed_temp"${empType === 'employed_temp' ? ' selected' : ''}>臨時アルバイト</option>
      <option value="contractor"${empType === 'contractor' ? ' selected' : ''}>委託・外注</option>
    </select>
    <input type="text"
           id="staff-edit-password-${id}"
           class="settings-input"
           style="flex:1;min-width:120px;height:40px;font-size:14px;"
           placeholder="パスワード変更（任意・5桁英数字）"
           maxlength="5"
           autocomplete="off"
           aria-label="パスワード変更">
    <button class="staff-save-btn"
            type="button"
            onclick="saveEditStaff(${id})"
            aria-label="保存">
      保存
    </button>
    <button class="staff-cancel-btn"
            type="button"
            onclick="renderStaffList()"
            aria-label="キャンセル">
      キャンセル
    </button>
  `;
  document.getElementById(`staff-edit-name-${id}`)?.focus();
}

async function saveEditStaff(id) {
  const nameEl = document.getElementById(`staff-edit-name-${id}`);
  const empEl  = document.getElementById(`staff-edit-emp-${id}`);
  const pwEl   = document.getElementById(`staff-edit-password-${id}`);
  if (!nameEl || !empEl) return;

  const name = nameEl.value.trim();
  if (!name) return showToast('スタッフ名を入力してください', 'error');

  const list = getStaffList();
  if (list.some(s => s.id !== id && s.name === name)) {
    return showToast('同じ名前のスタッフが既に登録されています', 'error');
  }

  // パスワード変更（任意・空欄なら既存の passwordHash を維持）
  const pwInput = pwEl ? pwEl.value.trim() : '';
  let passwordUpdate = null;
  if (pwInput) {
    if (!validateStaffPassword(pwInput)) {
      return showToast('パスワードは5桁の半角英数字で入力してください', 'error');
    }
    const passwordHash = await hashStaffPassword(id, pwInput);
    passwordUpdate = {
      passwordHash,
      passwordUpdatedAt: new Date().toISOString(),
    };
  }

  const newList = list.map(s =>
    s.id === id
      ? { ...s, name, employmentType: _normalizeEmpType(empEl.value), ...(passwordUpdate || {}) }
      : s
  );
  _saveStaffList(newList);
  renderStaffList();
  const msg = passwordUpdate
    ? `${name}を更新しました（パスワード変更含む）✓`
    : `${name}を更新しました ✓`;
  showToast(msg, 'success');
  saveStaffListToGAS();
}

function deleteStaff(id) {
  const list   = getStaffList();
  const target = list.find(s => s.id === id);
  if (!target) return;

  if (!confirm(`「${target.name}」を削除しますか？\n出退勤の記録済みデータには影響しません。`)) return;

  const newList = list.filter(s => s.id !== id);
  _saveStaffList(newList);
  renderStaffList();
  showToast(`${target.name}を削除しました`, 'success');
  saveStaffListToGAS();
}

function bindStaffAdd() {
  const btn       = document.getElementById('staff-add-btn');
  const input     = document.getElementById('staff-add-input');
  const empSelect = document.getElementById('staff-add-emp');
  const pwInput   = document.getElementById('staff-add-password');
  if (!btn || !input) return;

  const doAdd = async () => {
    const name = input.value.trim();
    if (!name) return showToast('スタッフ名を入力してください', 'error');

    // パスワードバリデーション（5桁英数字必須）
    const password = pwInput ? pwInput.value.trim() : '';
    if (!validateStaffPassword(password)) {
      return showToast('パスワードは5桁の半角英数字で入力してください', 'error');
    }

    const list = getStaffList();

    if (list.some(s => s.name === name)) {
      return showToast('同じ名前のスタッフが既に登録されています', 'error');
    }

    const maxId         = list.length > 0 ? Math.max(...list.map(s => s.id)) : 0;
    const newId         = maxId + 1;
    const employmentType = _normalizeEmpType(empSelect ? empSelect.value : '');
    const passwordHash  = await hashStaffPassword(newId, password);
    const passwordUpdatedAt = new Date().toISOString();
    const newList       = [...list, {
      id: newId,
      name,
      employmentType,
      passwordHash,
      passwordUpdatedAt,
    }];
    _saveStaffList(newList);

    input.value = '';
    if (empSelect) empSelect.value = 'employed_full';
    if (pwInput) pwInput.value = '';
    renderStaffList();
    showToast(`${name}を追加しました ✓`, 'success');
    saveStaffListToGAS();
  };

  btn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  if (pwInput) {
    pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  }
}

/* ── サービスマスタ ──────────────────────────────────────── */
function initServiceList() {
  renderServiceList();
}

function renderServiceList() {
  const container = document.getElementById('service-list-container');
  if (!container) return;

  const list = getServiceList();
  const quota = getMasterQuota().serviceMasterQuota;

  let html = list.map(s => {
    const idKey = String(s.id || s.code || '');  // 旧データ互換（code フィールドも受ける）
    return `
      <div class="staff-row" id="service-row-${escHtml(idKey)}">
        <span class="staff-row__name">${escHtml(s.name)}</span>
        <span class="service-tax-badge">税率 ${s.taxRate}%</span>
        <button class="staff-delete-btn"
                type="button"
                onclick="deleteService('${escHtml(idKey)}')"
                aria-label="${escHtml(s.name)}を削除">削除</button>
      </div>
    `;
  }).join('');

  html += `
    <div class="staff-row" style="opacity:0.5;">
      <span class="staff-row__name">諸口</span>
      <span class="service-tax-badge">税率 10%</span>
      <span style="font-size:12px;color:var(--uz-muted);padding:0 4px;">固定</span>
    </div>`;

  container.innerHTML = html;

  // 件数バッジ表示（運営付与枠 vs 現使用件数）
  const badge = document.getElementById('service-count-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = ` ${list.length}/${quota}`;
  }
  // 追加フォーム表示制御
  const addRow = document.getElementById('service-add-row');
  const hint   = document.getElementById('service-limit-hint');
  const atMax  = list.length >= quota;
  if (addRow) addRow.hidden = atMax;
  if (hint) {
    hint.hidden = !atMax;
    hint.textContent = `件数枠の上限（${quota}件）に達しています。追加するにはターゲット社にご相談ください。`;
  }
}

async function deleteService(id) {
  const list   = getServiceList();
  const target = list.find(s => String(s.id || s.code) === String(id));
  if (!target) return;

  if (list.length <= 1) return showToast('最低1種のサービスが必要です', 'error');

  if (!confirm(`「${target.name}」を削除しますか？\n登録済みの売上データには影響しません。`)) return;

  // サーバ側 deleteServiceItem を呼ぶ（サーバ側 serviceList が真実の所在地）
  try {
    const res = await callGAS('deleteServiceItem', { id: String(target.id || target.code) });
    if (res && res.status === 'ok' && Array.isArray(res.serviceList)) {
      _saveServiceList(res.serviceList);
      renderServiceList();
      showToast(`${target.name}を削除しました`, 'success');
    } else {
      showToast((res && res.message) || '削除に失敗しました', 'error');
    }
  } catch {
    showToast('通信エラーで削除できませんでした', 'error');
  }
}

function bindServiceAdd() {
  const btn       = document.getElementById('service-add-btn');
  const nameInput = document.getElementById('service-add-name');
  const taxSelect = document.getElementById('service-add-tax');
  if (!btn || !nameInput || !taxSelect) return;

  const doAdd = async () => {
    const name    = nameInput.value.trim();
    const taxRate = parseInt(taxSelect.value);

    if (!name) return showToast('サービス名を入力してください', 'error');
    if (name.length > 30) return showToast('サービス名は30文字以内で入力してください', 'error');

    // クライアント側でも枠超過チェック（即時フィードバック・サーバ側でも再チェック）
    const list = getServiceList();
    const quota = getMasterQuota().serviceMasterQuota;
    if (list.length >= quota) {
      return showToast(`件数枠の上限（${quota}件）に達しています`, 'error');
    }
    if (list.some(s => s.name === name)) {
      return showToast('同じ名前のサービスが既に登録されています', 'error');
    }

    // サーバ側で sv001〜採番＋枠超過チェック＋保存
    btn.disabled = true;
    try {
      const res = await callGAS('addServiceItem', { name, taxRate });
      if (res && res.status === 'ok' && Array.isArray(res.serviceList)) {
        _saveServiceList(res.serviceList);
        nameInput.value = '';
        taxSelect.value = '10';
        renderServiceList();
        showToast(`${name}を追加しました ✓`, 'success');
      } else if (res && res.code === 'quota_exceeded') {
        showToast(res.message || '件数枠の上限に達しています', 'error');
        // 枠数キャッシュを最新化（運営側で枠を絞った直後の同期遅延ケース）
        if (typeof res.quota === 'number') {
          const q = getMasterQuota();
          q.serviceMasterQuota = res.quota;
          _saveMasterQuota(q);
        }
        renderServiceList();
      } else {
        showToast((res && res.message) || '追加に失敗しました', 'error');
      }
    } catch {
      showToast('通信エラーで追加できませんでした', 'error');
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', doAdd);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
}

/* ── 仕入原価マスタ（6-G フェーズ2 新設）────────────────── */
function initPurchaseList() {
  renderPurchaseList();
}

function renderPurchaseList() {
  const container = document.getElementById('purchase-list-container');
  if (!container) return;

  const list = getPurchaseList();
  const quota = getMasterQuota().purchaseMasterQuota;

  let html = list.map(p => {
    const idKey = String(p.id || '');
    const rate = (p.defaultTaxRate !== undefined) ? p.defaultTaxRate : (p.taxRate !== undefined ? p.taxRate : 10);
    return `
      <div class="staff-row" id="purchase-row-${escHtml(idKey)}">
        <span class="staff-row__name">${escHtml(p.name)}</span>
        <span class="service-tax-badge">税率 ${rate}%</span>
        <button class="staff-delete-btn"
                type="button"
                onclick="deletePurchase('${escHtml(idKey)}')"
                aria-label="${escHtml(p.name)}を削除">削除</button>
      </div>
    `;
  }).join('');

  html += `
    <div class="staff-row" style="opacity:0.5;">
      <span class="staff-row__name">諸口</span>
      <span class="service-tax-badge">税率 10%</span>
      <span style="font-size:12px;color:var(--uz-muted);padding:0 4px;">固定</span>
    </div>`;

  container.innerHTML = html;

  const badge = document.getElementById('purchase-count-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = ` ${list.length}/${quota}`;
  }
  const addRow = document.getElementById('purchase-add-row');
  const hint   = document.getElementById('purchase-limit-hint');
  const atMax  = list.length >= quota;
  if (addRow) addRow.hidden = atMax;
  if (hint) {
    hint.hidden = !atMax;
    hint.textContent = `件数枠の上限（${quota}件）に達しています。追加するにはターゲット社にご相談ください。`;
  }
}

async function deletePurchase(id) {
  const list = getPurchaseList();
  const target = list.find(p => String(p.id) === String(id));
  if (!target) return;

  if (!confirm(`「${target.name}」を削除しますか？\n登録済みのコストデータには影響しません。`)) return;

  try {
    const res = await callGAS('deletePurchaseItem', { id: String(target.id) });
    if (res && res.status === 'ok' && Array.isArray(res.purchaseMasterList)) {
      _savePurchaseList(res.purchaseMasterList);
      renderPurchaseList();
      showToast(`${target.name}を削除しました`, 'success');
    } else {
      showToast((res && res.message) || '削除に失敗しました', 'error');
    }
  } catch {
    showToast('通信エラーで削除できませんでした', 'error');
  }
}

function bindPurchaseAdd() {
  const btn       = document.getElementById('purchase-add-btn');
  const nameInput = document.getElementById('purchase-add-name');
  const taxSelect = document.getElementById('purchase-add-tax');
  if (!btn || !nameInput || !taxSelect) return;

  const doAdd = async () => {
    const name = nameInput.value.trim();
    const taxRate = parseInt(taxSelect.value);

    if (!name) return showToast('科目名を入力してください', 'error');
    if (name.length > 30) return showToast('科目名は30文字以内で入力してください', 'error');

    const list = getPurchaseList();
    const quota = getMasterQuota().purchaseMasterQuota;
    if (list.length >= quota) {
      return showToast(`件数枠の上限（${quota}件）に達しています`, 'error');
    }
    if (list.some(p => p.name === name)) {
      return showToast('同じ名前の科目が既に登録されています', 'error');
    }

    btn.disabled = true;
    try {
      const res = await callGAS('addPurchaseItem', { name, defaultTaxRate: taxRate });
      if (res && res.status === 'ok' && Array.isArray(res.purchaseMasterList)) {
        _savePurchaseList(res.purchaseMasterList);
        nameInput.value = '';
        taxSelect.value = '10';
        renderPurchaseList();
        showToast(`${name}を追加しました ✓`, 'success');
      } else if (res && res.code === 'quota_exceeded') {
        showToast(res.message || '件数枠の上限に達しています', 'error');
        if (typeof res.quota === 'number') {
          const q = getMasterQuota();
          q.purchaseMasterQuota = res.quota;
          _saveMasterQuota(q);
        }
        renderPurchaseList();
      } else {
        showToast((res && res.message) || '追加に失敗しました', 'error');
      }
    } catch {
      showToast('通信エラーで追加できませんでした', 'error');
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', doAdd);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
}

/* ── コスト科目マスタ UI ─────────────────────────────────── */
function initCostMaster() {
  renderCostMaster();
}

function renderCostMaster() {
  const container = document.getElementById('cost-master-container');
  if (!container) return;

  const master = getCostMaster();

  const TAX_OPTIONS = [
    { value: 10, label: '10%'       },
    { value:  8, label: '8%（軽減）' },
    { value:  0, label: '0%（非課税）' },
  ];

  function taxSelect(id, current) {
    const opts = TAX_OPTIONS.map(o =>
      `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`
    ).join('');
    return `<select id="${id}" class="form-select" style="width:120px;height:36px;font-size:13px;">${opts}</select>`;
  }

  // 仕入原価
  const costItems   = master.filter(i => i.divisionCode === '1');
  // 販管費 固定
  const fixedItems  = master.filter(i => i.divisionCode === '2' && i.type === 'fixed');
  // 販管費 任意（科目番号26〜30）
  const customItems = master.filter(i => i.divisionCode === '2' && i.type === 'custom');

  function fixedRow(item) {
    const rowLabel = item.taxRow ? `${item.taxRow}　` : '';
    return `
      <div class="staff-row" style="align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="staff-row__name" style="flex:1;min-width:120px;font-size:13px;">
          ${rowLabel}${escHtml(item.name)}
        </span>
        ${taxSelect(`cm-tax-${item.code}`, item.taxRate)}
      </div>`;
  }

  function customRow(item) {
    return `
      <div class="staff-row" style="align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:12px;color:var(--uz-muted);min-width:32px;flex-shrink:0;">${item.taxRow}</span>
        <input type="text"
               id="cm-name-${item.code}"
               class="settings-input"
               style="flex:1;min-width:100px;height:36px;font-size:13px;"
               placeholder="任意科目名（空欄で非表示）"
               maxlength="20"
               autocomplete="off"
               value="${escHtml(item.name)}">
        ${taxSelect(`cm-tax-${item.code}`, item.taxRate)}
      </div>`;
  }

  let html = '';

  html += `<div style="padding:8px 16px 4px;font-size:12px;font-weight:700;color:var(--uz-muted);">▸ 仕入原価</div>`;
  html += costItems.map(fixedRow).join('');

  html += `<div style="padding:12px 16px 4px;font-size:12px;font-weight:700;color:var(--uz-muted);">▸ 販管費（固定科目）</div>`;
  html += fixedItems.map(fixedRow).join('');

  html += `<div style="padding:12px 16px 4px;font-size:12px;font-weight:700;color:var(--uz-muted);">▸ 販管費（任意科目 番号26〜30）</div>`;
  html += customItems.map(customRow).join('');

  html += `
    <div style="padding:8px 16px 10px;">
      <p style="font-size:12px;color:var(--uz-muted);line-height:1.6;">
        固定科目は名称変更不可・税率のみ変更可。<br>
        任意科目は科目名を入力すると有効になります。<br>
        科目番号は確定申告書（収支内訳書）の科目番号に対応しています。
      </p>
    </div>`;

  container.innerHTML = html;
}

function bindCostMasterSave() {
  document.getElementById('cost-master-save-btn')?.addEventListener('click', () => {
    const master = getCostMaster();

    const updated = master.map(item => {
      const taxEl  = document.getElementById(`cm-tax-${item.code}`);
      const nameEl = document.getElementById(`cm-name-${item.code}`);

      const taxRate = taxEl ? parseInt(taxEl.value) : item.taxRate;
      const name    = item.type === 'custom' && nameEl
        ? nameEl.value.trim()
        : item.name;

      return { ...item, name, taxRate };
    });

    saveCostMasterToStorage(updated);
    showToast('科目マスタを保存しました ✓', 'success');
    renderCostMaster();
    saveCostMasterToGAS(updated);
  });
}

/* ── XSSエスケープ ───────────────────────────────────────── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════
   iPad 設定アコーディオン
   ══════════════════════════════════════════════════════════ */

/**
 * 設定セクションアコーディオン切り替え
 * @param {HTMLButtonElement} btn - .settings-accordion-btn
 */
function toggleSettingsAccordion(btn) {
  // iPad以外はアコーディオン不使用（非iPadでは常時展開）
  if (!document.body.classList.contains('is-ipad')) return;

  const bodyId = btn.getAttribute('aria-controls');
  const bodyEl = document.getElementById(bodyId);
  if (!bodyEl) return;

  const isExpanded = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!isExpanded));
  if (isExpanded) {
    bodyEl.setAttribute('hidden', '');
  } else {
    bodyEl.removeAttribute('hidden');
  }
}

// iPad初期状態：基本情報セクションは折りたたむ
document.addEventListener('DOMContentLoaded', () => {
  if (!document.body.classList.contains('is-ipad')) return;
  ['sec-info-body'].forEach(id => {
    const bodyEl = document.getElementById(id);
    if (bodyEl) bodyEl.setAttribute('hidden', '');
    const btn = document.querySelector(`[aria-controls="${id}"]`);
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
});
