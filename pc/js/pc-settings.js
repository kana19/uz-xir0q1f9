/* pc-settings.js — PC版 設定（店舗情報・サービスマスタ・仕入マスタ・販管費マスタ・スタッフマスタ）
 *
 * 6-G フェーズ2（v0.5.6 連動）：
 *   - getSettings 応答から masterQuota / purchaseMasterList を取得
 *   - サービスマスタ・仕入マスタに「＋追加」「削除」ボタン
 *   - 枠超過時は追加抑止（モーダル＋ヒント表示）
 *   - サーバ側 addServiceItem / deleteServiceItem / addPurchaseItem / deletePurchaseItem を使用
 *   - 販管費マスタ（コード8〜31）は既存のインライン編集＋一括保存方式を維持
 */
'use strict';

let settings = null;
let costMaster = [];
let purchaseList = [];
let masterQuota = { serviceMasterQuota: 5, purchaseMasterQuota: 3, costOptionalQuota: 5 };

document.addEventListener('DOMContentLoaded', async () => {
  pcBootstrap('settings.html', '設定');
  await loadAll();
  document.getElementById('btn-save-store').addEventListener('click', saveStore);
  document.getElementById('btn-save-cm').addEventListener('click', saveCM);
  document.getElementById('svc-add-btn').addEventListener('click', addService);
  document.getElementById('pur-add-btn').addEventListener('click', addPurchase);
  const svcNameInput = document.getElementById('svc-add-name');
  if (svcNameInput) svcNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addService(); });
  const purNameInput = document.getElementById('pur-add-name');
  if (purNameInput) purNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPurchase(); });
});

async function loadAll() {
  const [sRes, cmRes] = await Promise.all([
    callGAS('getSettings', {}).catch(() => null),
    callGAS('getCostMaster', {}).catch(() => null),
  ]);
  settings = (sRes && sRes.status === 'ok' && sRes.data) ? sRes.data : {};
  // 6-G フェーズ2：マスタ件数枠を取得（未投入の既存ユーザーはフォールバック値を使う）
  if (settings.masterQuota && typeof settings.masterQuota === 'object') {
    masterQuota = {
      serviceMasterQuota: Number(settings.masterQuota.serviceMasterQuota) || 5,
      purchaseMasterQuota: Number(settings.masterQuota.purchaseMasterQuota) || 3,
      costOptionalQuota: Number(settings.masterQuota.costOptionalQuota) || 5
    };
  }
  // 6-G フェーズ2：仕入マスタを取得（getSettings 応答から優先・なければ空）
  if (Array.isArray(settings.purchaseMasterList)) {
    purchaseList = settings.purchaseMasterList;
  } else {
    purchaseList = [];
  }
  // 販管費マスタは既存通り getCostMaster 経由（getSettings の costMasterList より優先）
  if (cmRes && cmRes.status === 'ok' && Array.isArray(cmRes.data) && cmRes.data.length > 0) {
    costMaster = cmRes.data;
  } else if (Array.isArray(settings.costMasterList) && settings.costMasterList.length > 0) {
    costMaster = settings.costMasterList;
  } else {
    costMaster = getCostMaster();
  }
  renderStore();
  renderServices();
  renderPurchases();
  renderCM();
  renderStaff();
}

function renderStore() {
  const name = settings?.storeName || localStorage.getItem('uz_store_name') || '';
  const owner = settings?.ownerName || '';
  document.getElementById('s-store').value = name;
  document.getElementById('s-owner').value = owner;
}

async function saveStore() {
  const storeName = document.getElementById('s-store').value.trim();
  const ownerName = document.getElementById('s-owner').value.trim();
  localStorage.setItem('uz_store_name', storeName);
  const res = await callGAS('saveSettings', { storeName, ownerName }).catch(() => null);
  if (res && res.status === 'ok') {
    showToast('店舗情報を保存しました', 'success');
  } else {
    showToast('保存失敗（ローカルには保存）', 'error');
  }
}

/* ── サービスマスタ ─────────────────────────────────────── */
function getServiceListFromState() {
  let svcs = settings?.serviceList ?? settings?.services ?? [];
  if (typeof svcs === 'string') { try { svcs = JSON.parse(svcs); } catch { svcs = []; } }
  if (!Array.isArray(svcs)) svcs = [];
  return svcs;
}

function renderServices() {
  const svcs = getServiceListFromState();
  const body = document.getElementById('svc-body');
  const quota = masterQuota.serviceMasterQuota;

  if (svcs.length === 0) {
    body.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align:center;padding:20px;">登録なし</td></tr>`;
  } else {
    body.innerHTML = svcs.map(s => {
      const idKey = escHtml(String(s.id || s.code || ''));
      return `<tr>
        <td>${idKey}</td>
        <td>${escHtml(s.name||'')}</td>
        <td>${Number(s.taxRate)||0}%</td>
        <td><button class="pc-btn pc-btn--ghost" type="button" onclick="deleteService('${idKey}')">削除</button></td>
      </tr>`;
    }).join('');
  }

  const badge = document.getElementById('svc-count-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = ` ${svcs.length}/${quota}`;
  }
  const addRow = document.getElementById('svc-add-row');
  const hint = document.getElementById('svc-limit-hint');
  const atMax = svcs.length >= quota;
  if (addRow) addRow.style.display = atMax ? 'none' : '';
  if (hint) {
    hint.hidden = !atMax;
    hint.textContent = `件数枠の上限（${quota}件）に達しています。追加するにはターゲット社にご相談ください。`;
  }
}

async function addService() {
  const nameEl = document.getElementById('svc-add-name');
  const taxEl  = document.getElementById('svc-add-tax');
  const btn    = document.getElementById('svc-add-btn');
  const name = nameEl.value.trim();
  const taxRate = parseInt(taxEl.value);
  if (!name) return showToast('サービス名を入力してください', 'error');
  if (name.length > 30) return showToast('サービス名は30文字以内で入力してください', 'error');

  const list = getServiceListFromState();
  if (list.length >= masterQuota.serviceMasterQuota) {
    return showToast(`件数枠の上限（${masterQuota.serviceMasterQuota}件）に達しています`, 'error');
  }
  if (list.some(s => s.name === name)) {
    return showToast('同じ名前のサービスが既に登録されています', 'error');
  }

  btn.disabled = true;
  try {
    const res = await callGAS('addServiceItem', { name, taxRate });
    if (res && res.status === 'ok' && Array.isArray(res.serviceList)) {
      settings.serviceList = res.serviceList;
      nameEl.value = '';
      taxEl.value = '10';
      renderServices();
      showToast(`${name}を追加しました`, 'success');
    } else if (res && res.code === 'quota_exceeded') {
      showToast(res.message || '件数枠の上限に達しています', 'error');
      if (typeof res.quota === 'number') {
        masterQuota.serviceMasterQuota = res.quota;
      }
      renderServices();
    } else {
      showToast((res && res.message) || '追加に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteService(id) {
  const list = getServiceListFromState();
  const target = list.find(s => String(s.id || s.code) === String(id));
  if (!target) return;
  if (list.length <= 1) return showToast('最低1種のサービスが必要です', 'error');
  if (!confirm(`「${target.name}」を削除しますか？\n登録済みの売上データには影響しません。`)) return;
  try {
    const res = await callGAS('deleteServiceItem', { id: String(target.id || target.code) });
    if (res && res.status === 'ok' && Array.isArray(res.serviceList)) {
      settings.serviceList = res.serviceList;
      renderServices();
      showToast(`${target.name}を削除しました`, 'success');
    } else {
      showToast((res && res.message) || '削除に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  }
}

/* ── 仕入原価マスタ（6-G フェーズ2 新設）─────────────── */
function renderPurchases() {
  const body = document.getElementById('pur-body');
  const quota = masterQuota.purchaseMasterQuota;

  if (!Array.isArray(purchaseList) || purchaseList.length === 0) {
    body.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align:center;padding:20px;">登録なし</td></tr>`;
  } else {
    body.innerHTML = purchaseList.map(p => {
      const idKey = escHtml(String(p.id || ''));
      const rate = (p.defaultTaxRate !== undefined) ? p.defaultTaxRate : (p.taxRate !== undefined ? p.taxRate : 10);
      return `<tr>
        <td>${idKey}</td>
        <td>${escHtml(p.name||'')}</td>
        <td>${Number(rate)||0}%</td>
        <td><button class="pc-btn pc-btn--ghost" type="button" onclick="deletePurchase('${idKey}')">削除</button></td>
      </tr>`;
    }).join('');
  }

  const badge = document.getElementById('pur-count-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = ` ${purchaseList.length}/${quota}`;
  }
  const addRow = document.getElementById('pur-add-row');
  const hint = document.getElementById('pur-limit-hint');
  const atMax = purchaseList.length >= quota;
  if (addRow) addRow.style.display = atMax ? 'none' : '';
  if (hint) {
    hint.hidden = !atMax;
    hint.textContent = `件数枠の上限（${quota}件）に達しています。追加するにはターゲット社にご相談ください。`;
  }
}

async function addPurchase() {
  const nameEl = document.getElementById('pur-add-name');
  const taxEl  = document.getElementById('pur-add-tax');
  const btn    = document.getElementById('pur-add-btn');
  const name = nameEl.value.trim();
  const taxRate = parseInt(taxEl.value);
  if (!name) return showToast('科目名を入力してください', 'error');
  if (name.length > 30) return showToast('科目名は30文字以内で入力してください', 'error');

  if (purchaseList.length >= masterQuota.purchaseMasterQuota) {
    return showToast(`件数枠の上限（${masterQuota.purchaseMasterQuota}件）に達しています`, 'error');
  }
  if (purchaseList.some(p => p.name === name)) {
    return showToast('同じ名前の科目が既に登録されています', 'error');
  }

  btn.disabled = true;
  try {
    const res = await callGAS('addPurchaseItem', { name, defaultTaxRate: taxRate });
    if (res && res.status === 'ok' && Array.isArray(res.purchaseMasterList)) {
      purchaseList = res.purchaseMasterList;
      nameEl.value = '';
      taxEl.value = '10';
      renderPurchases();
      showToast(`${name}を追加しました`, 'success');
    } else if (res && res.code === 'quota_exceeded') {
      showToast(res.message || '件数枠の上限に達しています', 'error');
      if (typeof res.quota === 'number') {
        masterQuota.purchaseMasterQuota = res.quota;
      }
      renderPurchases();
    } else {
      showToast((res && res.message) || '追加に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deletePurchase(id) {
  const target = purchaseList.find(p => String(p.id) === String(id));
  if (!target) return;
  if (!confirm(`「${target.name}」を削除しますか？\n登録済みのコストデータには影響しません。`)) return;
  try {
    const res = await callGAS('deletePurchaseItem', { id: String(target.id) });
    if (res && res.status === 'ok' && Array.isArray(res.purchaseMasterList)) {
      purchaseList = res.purchaseMasterList;
      renderPurchases();
      showToast(`${target.name}を削除しました`, 'success');
    } else {
      showToast((res && res.message) || '削除に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
  }
}

/* ── 販管費マスタ（既存維持・販管費専用に役割明確化）─────── */
function renderCM() {
  const body = document.getElementById('cm-body');
  // 仕入原価行（divisionCode='1'）を除外して販管費のみ表示
  // 既存データの divisionCode が未設定の場合は販管費扱い（後方互換）
  const filtered = costMaster.filter(row => {
    return !row.divisionCode || row.divisionCode === '2';
  });
  body.innerHTML = filtered.map((row) => {
    const i = costMaster.indexOf(row);
    const fixed = row.type === 'fixed';
    const taxOpts = [0,8,10].map(v => `<option value="${v}" ${Number(row.taxRate)===v?'selected':''}>${v}%</option>`).join('');
    const nameCell = fixed
      ? `<input type="text" class="pc-input cm-name" value="${escHtml(row.name||'')}" data-i="${i}" disabled style="width:100%;opacity:0.6;">`
      : `<input type="text" class="pc-input cm-name" value="${escHtml(row.name||'')}" data-i="${i}" placeholder="任意科目名" style="width:100%;">`;
    return `<tr>
      <td>${escHtml(row.code||'')}</td>
      <td>${nameCell}</td>
      <td><select class="pc-select cm-tax" data-i="${i}">${taxOpts}</select></td>
      <td>${fixed ? '固定' : '任意'}</td>
    </tr>`;
  }).join('');
}

async function saveCM() {
  document.querySelectorAll('.cm-name').forEach(inp => {
    const i = Number(inp.dataset.i);
    if (costMaster[i] && costMaster[i].type !== 'fixed') costMaster[i].name = inp.value.trim();
  });
  document.querySelectorAll('.cm-tax').forEach(sel => {
    const i = Number(sel.dataset.i);
    if (costMaster[i]) costMaster[i].taxRate = Number(sel.value);
  });
  saveCostMasterToStorage(costMaster);
  const res = await callGAS('saveCostMaster', { costMasterList: costMaster }).catch(() => null);
  if (res && res.status === 'ok') {
    showToast('販管費マスタを保存しました', 'success');
  } else {
    showToast('保存失敗（ローカルには保存）', 'error');
  }
}

/**
 * employmentType 正規化（3種化対応・サイクルA）
 *   旧 'employed' および未設定はすべて 'employed_full' に寄せる
 */
function normalizeEmpType(value) {
  if (value === 'employed_full' || value === 'employed_temp' || value === 'contractor') return value;
  return 'employed_full';
}

/**
 * costCategory 正規化
 *   contractor時のコスト科目：'21'（外注工賃）/ '25'（税理士等の報酬）
 *   未設定・不正値は '21' にフォールバック
 */
function normalizeCostCategory(value) {
  if (value === '21' || value === '25') return value;
  return '21';
}

function renderStaff() {
  let staff = settings?.staffList ?? settings?.staff ?? [];
  if (typeof staff === 'string') { try { staff = JSON.parse(staff); } catch { staff = []; } }
  if (!Array.isArray(staff)) staff = [];
  const body = document.getElementById('staff-body');
  if (staff.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px;">登録なし</td></tr>`;
    return;
  }
  body.innerHTML = staff.map(s => {
    const empType = normalizeEmpType(s.employmentType);
    const costCat = normalizeCostCategory(s.costCategory);
    const sid = escHtml(String(s.id || ''));
    const empOpts = [
      ['employed_full', '常勤雇用(社員)'],
      ['employed_temp', '臨時アルバイト'],
      ['contractor',    '委託・外注']
    ].map(([v, label]) =>
      `<option value="${v}"${v === empType ? ' selected' : ''}>${label}</option>`
    ).join('');
    const costOpts = [
      ['21', '21:外注工賃'],
      ['25', '25:税理士等の報酬']
    ].map(([v, label]) =>
      `<option value="${v}"${v === costCat ? ' selected' : ''}>${label}</option>`
    ).join('');
    const costSelectDisabled = empType !== 'contractor';
    return `<tr>
      <td>${sid}</td>
      <td>${escHtml(s.name||'')}</td>
      <td>
        <select class="pc-select staff-emp-select" data-staff-id="${sid}" style="width:180px;">
          ${empOpts}
        </select>
      </td>
      <td>
        <select class="pc-select staff-cost-select" data-staff-id="${sid}" style="width:180px;"${costSelectDisabled ? ' disabled' : ''}>
          ${costOpts}
        </select>
      </td>
      <td>${escHtml(s.note||'')}</td>
    </tr>`;
  }).join('');

  // 雇用形態セレクトに変更ハンドラを束ねる(インライン保存)
  body.querySelectorAll('.staff-emp-select').forEach(sel => {
    sel.addEventListener('change', () => saveStaffEmpType(sel));
  });
  // コスト科目セレクトに変更ハンドラを束ねる(インライン保存)
  body.querySelectorAll('.staff-cost-select').forEach(sel => {
    sel.addEventListener('change', () => saveStaffCostCategory(sel));
  });
}

/**
 * 雇用形態セレクトを変更したらその場でGASに保存する
 *  - 全員分の最新 staffList を再構築して saveStaffList で送信
 *  - 楽観的に settings.staffList を更新
 *  - 委託・外注以外に変更時はコスト科目セレクトを非活性化
 */
async function saveStaffEmpType(selectEl) {
  const targetId = selectEl.dataset.staffId;
  const newType = normalizeEmpType(selectEl.value);
  let list = settings?.staffList ?? settings?.staff ?? [];
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) list = [];

  const updated = list.map(s => {
    if (String(s.id) === String(targetId)) {
      return { ...s, employmentType: newType };
    }
    return s;
  });

  selectEl.disabled = true;
  let res;
  try {
    res = await callGAS('saveStaffList', { staffList: updated });
  } catch (e) {
    selectEl.disabled = false;
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
    return;
  }
  selectEl.disabled = false;

  if (res && res.status === 'ok') {
    settings.staffList = updated;
    // 同じ行のコスト科目セレクトの活性状態を更新
    const costSel = document.querySelector(`.staff-cost-select[data-staff-id="${targetId}"]`);
    if (costSel) costSel.disabled = (newType !== 'contractor');
    showToast('雇用形態を保存しました', 'success');
  } else {
    showToast('保存失敗：' + (res && res.message || '不明なエラー'), 'error');
  }
}

/**
 * コスト科目セレクトを変更したらその場でGASに保存する
 *  - contractor のスタッフのみ意味を持つ
 *  - 21:外注工賃 / 25:税理士等の報酬
 */
async function saveStaffCostCategory(selectEl) {
  const targetId = selectEl.dataset.staffId;
  const newCat = normalizeCostCategory(selectEl.value);
  let list = settings?.staffList ?? settings?.staff ?? [];
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) list = [];

  const updated = list.map(s => {
    if (String(s.id) === String(targetId)) {
      return { ...s, costCategory: newCat };
    }
    return s;
  });

  selectEl.disabled = true;
  let res;
  try {
    res = await callGAS('saveStaffList', { staffList: updated });
  } catch (e) {
    selectEl.disabled = false;
    showToast('通信エラー：' + (e.message || 'unknown'), 'error');
    return;
  }
  selectEl.disabled = false;

  if (res && res.status === 'ok') {
    settings.staffList = updated;
    showToast('コスト科目を保存しました', 'success');
  } else {
    showToast('保存失敗：' + (res && res.message || '不明なエラー'), 'error');
  }
}
