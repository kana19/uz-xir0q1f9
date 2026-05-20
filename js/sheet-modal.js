/**
 * sheet-modal.js — 汎用シートモーダル（§12.5-1準拠）
 *
 * 使用前提: app.js（showToast）・sheet-modal.css をロード済みであること
 *
 * API:
 *   SheetModal.open(options)
 *   SheetModal.close()
 *   SheetModal.showValidationError(fieldSelector, message)
 *   SheetModal.confirmOptional(message, onConfirm)
 *
 * options:
 *   title        {string}   ヘッダータイトル
 *   bodyHtml     {string}   フォームHTML（sm-body に差し込む）
 *   submitLabel  {string}   送信ボタンのラベル（省略時: '登録する'）
 *   onRender     {Function} bodyHtml を DOM に差し込んだ直後に呼ばれるフック
 *   onSubmit     {Function} async。true を返すと自動close、false/void で開いたまま
 *   onClose      {Function} モーダルが閉じた後に呼ばれる後処理
 */

'use strict';

window.SheetModal = (() => {
  let _inst = null;        // 現在開いているモーダルの要素群
  let _popFn = null;       // popstate リスナー
  let _pushedState = false; // history.pushState したかどうか

  /* ── DOM生成ヘルパー ──────────────────────────────────── */
  function _el(tag, cls, attrs = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }

  /* ── ドラッグ閉じ ─────────────────────────────────────── */
  function _bindDrag(sheet) {
    let startY = 0, dragY = 0, active = false;

    sheet.addEventListener('touchstart', e => {
      startY = e.touches[0].clientY;
      dragY  = 0;
      active = true;
      sheet.style.transition = 'none';
    }, { passive: true });

    sheet.addEventListener('touchmove', e => {
      if (!active) return;
      dragY = e.touches[0].clientY - startY;
      if (dragY < 0) dragY = 0;
      sheet.style.transform = `translateY(${dragY}px)`;
    }, { passive: true });

    sheet.addEventListener('touchend', () => {
      if (!active) return;
      active = false;
      if (dragY >= 80) {
        close();
      } else {
        sheet.style.transition = 'transform 0.15s ease-out';
        sheet.style.transform  = 'translateY(0)';
        setTimeout(() => { if (sheet.isConnected) sheet.style.transition = ''; }, 150);
      }
      startY = 0;
      dragY  = 0;
    });
  }

  /* ── open ────────────────────────────────────────────── */
  function open(options = {}) {
    if (_inst) close();

    // ── オーバーレイ
    const overlay = _el('div', 'sm-overlay', { 'aria-hidden': 'true' });

    // ── シート本体
    const sheet = _el('div', 'sm-sheet', {
      role: 'dialog', 'aria-modal': 'true',
    });

    const handle = _el('div', 'sm-handle', { 'aria-hidden': 'true' });

    const header = _el('div', 'sm-header');
    const titleEl = _el('span', 'sm-title');
    titleEl.textContent = options.title || '';
    const closeBtn = _el('button', 'sm-close-btn', {
      type: 'button', 'aria-label': '閉じる',
    });
    closeBtn.textContent = '✕';
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = _el('div', 'sm-body');
    body.innerHTML = options.bodyHtml || '';

    /* sm-sticky-header が含まれている場合はsm-bodyの外に移動
       （overflow-y:autoの親の中ではstickyが効かないため） */
    const stickyHeader = body.querySelector('.sm-sticky-header');

    sheet.appendChild(handle);
    sheet.appendChild(header);
    if (stickyHeader) {
      sheet.appendChild(stickyHeader); /* sm-bodyの前に挿入 */
    }
    sheet.appendChild(body);

    // onSubmit が提供された場合のみ SheetModal 管理のフッターボタンを表示
    let submitBtn = null;
    if (typeof options.onSubmit === 'function') {
      const footer = _el('div', 'sm-footer');
      submitBtn = _el('button', 'sm-submit-btn', { type: 'button' });
      submitBtn.textContent = options.submitLabel || '登録する';
      footer.appendChild(submitBtn);
      sheet.appendChild(footer);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(sheet);
    document.body.classList.add('sm-open');

    _inst = { overlay, sheet, body, submitBtn, options };

    // ── イベント：閉じる
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', close);

    // ── Androidバックボタン
    _pushedState = true;
    history.pushState({ smOpen: true }, '');
    window.addEventListener('popstate', _popFn = () => {
      _pushedState = false;
      close();
    });

    // ── ドラッグ
    _bindDrag(sheet);

    // ── 送信ボタン（onSubmit 提供時のみ）
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const origLabel = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = '送信中...';
        try {
          const result = await options.onSubmit();
          if (result === true) close();
        } finally {
          if (submitBtn.isConnected) {
            submitBtn.disabled    = false;
            submitBtn.textContent = origLabel;
          }
        }
      });
    }

    // ── onRender（DOM差し込み直後）
    if (typeof options.onRender === 'function') {
      options.onRender();
    }

    // ── アニメーションで表示
    requestAnimationFrame(() => {
      overlay.classList.add('sm-overlay--show');
      sheet.classList.add('sm-sheet--open');
    });
  }

  /* ── close ───────────────────────────────────────────── */
  function close() {
    if (!_inst) return;
    const { overlay, sheet, options } = _inst;
    _inst = null;

    // popstate リスナー解除
    if (_popFn) {
      window.removeEventListener('popstate', _popFn);
      _popFn = null;
    }
    // pushState した分を戻す（close がUI操作によるものの場合）
    if (_pushedState) {
      _pushedState = false;
      if (history.state?.smOpen) history.back();
    }

    overlay.classList.remove('sm-overlay--show');
    sheet.style.transition = 'transform 0.25s ease-in';
    sheet.style.transform  = 'translateY(100%)';

    setTimeout(() => {
      overlay.remove();
      sheet.remove();
      document.body.classList.remove('sm-open');
      if (typeof options.onClose === 'function') options.onClose();
    }, 250);
  }

  /* ── showValidationError ─────────────────────────────── */
  function showValidationError(fieldSelector, message) {
    if (_inst) {
      const el = _inst.sheet.querySelector(fieldSelector);
      if (el) {
        el.classList.add('sm-field-error');
        const removeErr = () => {
          el.classList.remove('sm-field-error');
          el.removeEventListener('change', removeErr);
          el.removeEventListener('input',  removeErr);
          el.removeEventListener('focus',  removeErr);
        };
        el.addEventListener('change', removeErr);
        el.addEventListener('input',  removeErr);
        el.addEventListener('focus',  removeErr);
      }
    }
    if (typeof showToast === 'function') showToast(message, 'error');
  }

  /* ── confirmOptional ─────────────────────────────────── */
  function confirmOptional(message, onConfirm) {
    if (window.confirm(message)) onConfirm();
  }

  return { open, close, showValidationError, confirmOptional };
})();
