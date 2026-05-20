/**
 * staff-clockin.js v3 — スタッフ専用タイムカードPWA
 * v4: ボタンラベル統一（再表示廃止・0〜23時対応・日跨ぎ自動判定）
 * v5: localStorage で staffId 保持（PWAホーム画面起動時のゼロタップ対応）
 */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbwBDHj9-p6ZT6ExXrxF1Q-XwiEkNMPwDc0aAuk7zptivRhWhepvaCDsjaIJd7WHh_h9-A/exec';
const WD = ['日','月','火','水','木','金','土'];
const STAFF_ID_KEY = 'uz_staff_id';

let state = {
  staffId:'', staffName:'', storeName:'',
  myRecord:null, todayList:[], myMonthly:[],
  isPunching:false, isEditingTime:false, editHour:0, editMin:0,
};

async function callGAS(action, data={}) {
  const url = `${GAS_URL}?action=${encodeURIComponent(action)}&data=${encodeURIComponent(JSON.stringify(data))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP '+res.status);
  const json = await res.json();
  if (json && json.status==='ok') return json.data ?? json;
  throw new Error(json?.message || 'GAS エラー');
}

document.addEventListener('DOMContentLoaded', async () => {
  startClock();

  // 1. URLパラメータから取得試行（初回・オーナーから共有URL）
  let staffId = new URLSearchParams(location.search).get('staff') || '';

  // 2. URLになければ localStorage から復元（PWAホーム画面起動）
  if (!staffId) {
    try { staffId = localStorage.getItem(STAFF_ID_KEY) || ''; } catch(e) {}
  }

  if (!staffId) {
    showError('URLが正しくありません','staff=スタッフIDパラメータが必要です。\nオーナーから共有されたURLを使用してください。');
    return;
  }

  state.staffId = staffId;

  try {
    const v = await callGAS('validateStaff', { staffId });
    if (!v || !v.valid) {
      // 無効な staffId は localStorage からも削除（古い端末等の救済）
      try { localStorage.removeItem(STAFF_ID_KEY); } catch(e) {}
      showError('スタッフが見つかりません',`スタッフID「${staffId}」は登録されていません。\nオーナーに確認してください。`);
      return;
    }

    // 3. 有効が確認できた段階で localStorage に保存（2回目以降のゼロタップ起動用）
    try { localStorage.setItem(STAFF_ID_KEY, staffId); } catch(e) {}

    state.staffName  = v.staffName;
    state.storeName  = v.storeName;
    document.getElementById('header-store').textContent = state.storeName || 'ULTRA ZAIMU';
    document.getElementById('header-name').textContent  = state.staffName;
    document.getElementById('section-today-title').textContent = '今日の出勤状況';
    hideLoading();
    await loadAttendanceData();
  } catch(e) { showError('接続エラー','通信に失敗しました。\nWi-Fiや電波状況を確認してください。\n\n'+e.message); }
});

function startClock() {
  function tick() {
    const now=new Date(), hh=String(now.getHours()).padStart(2,'0'), mm=String(now.getMinutes()).padStart(2,'0'), ts=`${hh}:${mm}`;
    const ht=document.getElementById('header-time'); if(ht) ht.textContent=ts;
    const hd=document.getElementById('header-date'); if(hd) hd.textContent=`${now.getMonth()+1}/${now.getDate()}（${WD[now.getDay()]}）`;
    if(!state.isEditingTime){ const pt=document.getElementById('punch-current-time'); if(pt) pt.textContent=ts; }
  }
  tick(); setInterval(tick,10000);
}

async function loadAttendanceData() {
  const today=todayStr();
  const result=await callGAS('getAttendanceForStaff',{staffId:state.staffId,month:today.substring(0,7)});
  state.myRecord=result.myRecord||null; state.todayList=result.todayList||[]; state.myMonthly=result.myMonthly||[];
  renderAll();
}
function renderAll() { renderPunchArea(); renderTodayList(); renderMonthly(); }

function renderPunchArea() {
  const rec=state.myRecord, area=document.getElementById('punch-area');
  const isActive=rec&&rec.isActive, isDone=rec&&!rec.isActive;
  const badgeClass=isActive?'active':'inactive';
  const badgeText=isActive?'出勤中':'未出勤';
  const btnClass=isActive?'clockout-btn':'clockin-btn';
  const btnIcon=isActive?'🔴':'🟢';
  const btnLabel=isActive?'退勤':'出勤';
  const subInfo=isActive
    ?`<div class="ci-info">出勤：<span class="ci-time">${rec.clockIn}</span></div>`
    :isDone?`<div class="prev-record">直前：${rec.clockIn} 〜 ${rec.clockOut||'--:--'}</div>`:'';

  area.innerHTML=`
    <div class="status-badge ${badgeClass}"><span class="status-dot"></span><span>${badgeText}</span></div>
    ${subInfo}
    <div class="current-time-display" id="current-time-block">
      <div class="current-time-big" id="punch-current-time">--:--</div>
      <div class="current-time-label">現在時刻</div>
    </div>
    <button class="punch-btn ${btnClass}" id="punch-btn" onclick="onPunchTap()">
      <span class="punch-btn-icon">${btnIcon}</span>
      <span class="punch-btn-label">${btnLabel}</span>
    </button>
    <button class="time-edit-trigger" id="time-edit-trigger" onclick="openTimeEdit()">🕐 時刻を変更して${btnLabel}</button>
    <div class="time-edit-panel" id="time-edit-panel" style="display:none">
      <div class="time-edit-title">時刻を入力</div>
      <div class="time-spinner-row">
        <div class="time-spinner-col">
          <button class="spin-btn" onclick="adjustTime('h',1)">▲</button>
          <div class="spin-val" id="edit-hh">00</div>
          <button class="spin-btn" onclick="adjustTime('h',-1)">▼</button>
        </div>
        <div class="time-colon">:</div>
        <div class="time-spinner-col">
          <button class="spin-btn" onclick="adjustTime('m',15)">▲</button>
          <div class="spin-val" id="edit-mm">00</div>
          <button class="spin-btn" onclick="adjustTime('m',-15)">▼</button>
        </div>
      </div>
      <div class="time-edit-hint">時間±1・分±15分</div>
      <div class="time-edit-actions">
        <button class="time-cancel-btn" onclick="closeTimeEdit()">キャンセル</button>
        <button class="time-confirm-btn" onclick="onPunchWithEditedTime()">この時刻で${btnLabel}</button>
      </div>
    </div>`;

  const now=new Date(), pt=document.getElementById('punch-current-time');
  if(pt) pt.textContent=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

function openTimeEdit() {
  const now=new Date();
  state.editHour=now.getHours(); state.editMin=Math.floor(now.getMinutes()/5)*5; state.isEditingTime=true;
  document.getElementById('time-edit-panel').style.display='';
  document.getElementById('time-edit-trigger').style.display='none';
  document.getElementById('current-time-block').style.display='none';
  document.getElementById('punch-btn').style.display='none';
  updateSpinner();
}
function closeTimeEdit() {
  state.isEditingTime=false;
  document.getElementById('time-edit-panel').style.display='none';
  document.getElementById('time-edit-trigger').style.display='';
  document.getElementById('current-time-block').style.display='';
  document.getElementById('punch-btn').style.display='';
}
function adjustTime(unit,delta) {
  if(unit==='h') state.editHour=(state.editHour+delta+24)%24;
  else state.editMin=(state.editMin+delta+60)%60;
  updateSpinner();
}
function updateSpinner() {
  document.getElementById('edit-hh').textContent=String(state.editHour).padStart(2,'0');
  document.getElementById('edit-mm').textContent=String(state.editMin).padStart(2,'0');
}

async function onPunchTap() {
  if(state.isPunching) return;
  const now=new Date();
  await executePunch(`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`);
}
async function onPunchWithEditedTime() {
  if(state.isPunching) return;
  closeTimeEdit();
  await executePunch(`${String(state.editHour).padStart(2,'0')}:${String(state.editMin).padStart(2,'0')}`);
}

async function executePunch(time) {
  if(state.isPunching) return;
  state.isPunching=true;
  const btn=document.getElementById('punch-btn');
  if(btn) btn.classList.add('punching');
  const rec=state.myRecord, date=todayStr();
  try {
    if(rec&&rec.isActive) {
      await callGAS('clockOut',{staffId:state.staffId,rowIndex:rec.rowIndex,clockOutTime:time});
      state.myRecord={...rec,clockOut:time,isActive:false};
      showBanner(`退勤しました（${time}）`);
    } else {
      const settings=await callGAS('getSettings',{});
      const staff=(settings.staffList||[]).find(s=>s.id===state.staffId)||{};
      const result=await callGAS('clockIn',{staffId:state.staffId,staffName:state.staffName,employmentType:staff.employmentType||'employed_full',date,clockInTime:time});
      state.myRecord={rowIndex:result.rowIndex||0,date,clockIn:time,clockOut:null,isActive:true};
      showBanner(`出勤しました（${time}）`);
    }
    await loadAttendanceData();
  } catch(e) {
    showBanner('⚠️ 通信エラー。もう一度試してください。');
    console.error(e);
  } finally {
    setTimeout(()=>{ const b=document.getElementById('punch-btn'); if(b) b.classList.remove('punching'); state.isPunching=false; },500);
  }
}

function renderTodayList() {
  const card=document.getElementById('today-card');
  if(!state.todayList.length){ card.innerHTML=`<div class="today-empty">まだ誰も出勤していません</div>`; return; }
  card.innerHTML=state.todayList.map(s=>`
    <div class="staff-row ${s.isSelf?'self-row':''} ${s.isActive?'active-row':''}">
      <div class="staff-avatar">${(s.staffName||'？').charAt(0)}</div>
      <div class="staff-info">
        <div class="staff-name-text">${esc(s.staffName)}</div>
        ${s.isSelf?'<div class="self-label">あなた</div>':''}
      </div>
      <div class="staff-status-tag ${s.isActive?'in':'out'}">${s.isActive?'出勤中':'未出勤'}</div>
    </div>`).join('');
}

function renderMonthly() {
  const list=document.getElementById('monthly-list'), count=document.getElementById('monthly-count');
  const mo=parseInt(todayStr().substring(5,7),10);
  document.getElementById('monthly-title-text').textContent=`${mo}月の記録`;
  count.textContent=`${state.myMonthly.length}件`;
  if(!state.myMonthly.length){ list.innerHTML='<div class="monthly-empty">記録がありません</div>'; return; }
  list.innerHTML=state.myMonthly.map(r=>{
    const d=new Date(r.date+'T00:00:00');
    const coTxt=r.clockOut?r.clockOut:`<span style="color:var(--green)">出勤中</span>`;
    return `<div class="monthly-row">
      <div class="monthly-date-col"><div class="monthly-date-day">${d.getDate()}</div><div class="monthly-date-wd">${WD[d.getDay()]}</div></div>
      <div class="monthly-times">
        <div class="monthly-time-row">${r.clockIn||'--:--'}<span class="sep">〜</span>${coTxt}</div>
        ${r.isActive?`<div class="monthly-time-active">● 出勤中</div>`:''}
      </div>
      <div class="monthly-duration">${r.workMinutes?fmtMin(r.workMinutes):''}</div>
    </div>`;
  }).join('');
}

function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtMin(min){ const h=Math.floor(min/60),m=min%60; return h===0?`${m}分`:`${h}h${m>0?m+'m':''}`; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showBanner(msg){ const el=document.getElementById('banner'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3500); }
function hideLoading(){ const el=document.getElementById('loading-screen'); el.classList.add('hidden'); setTimeout(()=>el.style.display='none',400); document.getElementById('main-screen').classList.add('show'); }
function showError(title,msg){ document.getElementById('loading-screen').classList.add('hidden'); document.getElementById('error-title').textContent=title; document.getElementById('error-msg').textContent=msg; document.getElementById('error-screen').classList.add('show'); }
