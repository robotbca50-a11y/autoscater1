if (typeof window.__tmLoaded === 'undefined' && String(window.location.search || '').indexOf('tm_fill=1') < 0) {
  window.__tmLoaded = true;

  const CFG = {
    POLL: 800, CLICK_DELAY: 5, AFTER_ACTION: 40, BTN_WAIT: 2500,
    DIALOG_WAIT: 3000, CONFIRM_WAIT: 3000, VERIFY_WAIT: 80, POST_ESC: 10,
    ESC_GAP: 5, RESCAN_DELAY: 200, BATCH_CB: 10, CB_INTER_CLICK: 8,
    CB_POSTCLICK: 50, CB_RECHECK_ROUNDS: 3, CB_RECHECK_WAIT: 80,
    CB_PRECLICK_SCROLL: 8, MAX_CONFIRM_RETRIES: 2,
    INTER_TICKET: 40, MAX_WORKERS: 20
  };

  const STYLE_ID = 'tm-merged-style';
  const ROW_OK = 'tm-ok-row', ROW_ERR = 'tm-err-row', ROW_PEND = 'tm-pend-row', ROW_BLUE = 'tm-blue-row', ROW_SKIP = 'tm-skip-row', ROW_BLACK = 'tm-black-row';
  const COLOR = { OK: '#00e676', ERR: '#ff1744', PEND: '#ffcc00', BLUE: '#2196f3', SKIP: '#D4EDDA', DONE: '#888888', APPROVE: '#00c853', REJECT: '#d50000', BLACK: '#111111' };

  let __timeScale = 0.85;
  const _san = (v, maxLen) => { try { return String(v ?? '').replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').trim().slice(0, maxLen || 200); } catch (_) { return ''; } };
  const _sanNum = (v, fallback) => { try { const n = Number(String(v ?? '').replace(/[^\d]/g, '')); return isNaN(n) ? (fallback ?? 0) : n; } catch (_) { return fallback ?? 0; } };
  const _situs = (() => { const h = (window.location.hostname || '').split('.')[0] || ''; return h.replace(/^(ag-|AG-)/i, '') || 'unknown'; })();
  const ck = (userId, txId) => (String(userId || '?') + '|' + String(txId || '?'));
  const retryQueue = new Map();
  const activeWorkers = new Set();
  const resultQueue = [];
  const rowColorMap = new Map();
  const pendingDecisionMap = new Map();
  const missingFromPageQueue = new Map();
  const _doneTxIds = new Map();
  const _reverifyGuard = new Map();
  function _pushRQ(item) {
    if (!item || !item.txId) return;
    if (item.isApprove === true) {
      const gRow = findRowByTxId(item.txId);
      if (gRow && getActionBadge(gRow) === 'x') {
        WARN(`[PUSH-GUARD] ${item.txId} red-X + approve diblokir di antrian — dibiarkan tanpa aksi (IGNORE)`);
        markSesuaiIgnore(item.txId, item._raw || null);
        return;
      }
    }
    if (resultQueue.some(e => e.txId === item.txId)) { LOG(`[RQ-DEDUP] ${item.txId} skip — already in queue`); return; }
    resultQueue.push(item);
    schedulePersistAll();
  }
  function _pushRQBulk(items) { if (!items || !items.length) return; for (const it of items) _pushRQ(it); }
  let isExecuting = false, executingSince = 0, _drainToken = 0;
  let lastKnownToken = '', nextPollAt = Date.now() + CFG.POLL;
  let lastProgressAt = Date.now();
  let doneTimer = null, persistColorTimer = null, pollIntervalId = null;
  let ambilInterval = null, approveInterval = null;
  let isProcessingAutomation = false, batchDrainScheduled = false;
  let colorReapplyInterval = null, _missingRetryTimer = null, _missingProcessing = false;
  let _reloadThrottle = 0;
  let _emptyQueueTimer = null;
  let _postActionRefresh = false;
  let _retryGuard = false;
  let _hardcoreGuard = false;
  let _rejectGuard = false;
  let _approveGuard = false;
  let _persistMissingTimer = null;
  const actionLocks = new Set();
  let _hardRefreshLock = false;
  const missingDataRetryMap = new Map();
  const MAX_MISSING_DATA_RETRY = 3;
  const _overrideNotified = new Set();
  const _completedTx = new Map();
  const _ignoredTx = new Set();
  let _completedTxLoaded = false;
  const _tmStatusPanel = { el: null, items: [] };
  let _cachedOperationMode = 'MANUAL';
  function refreshCachedMode() {
    try {
      chrome.storage.local.get(['operationMode'], res => {
        _cachedOperationMode = (res.operationMode || 'MANUAL').toUpperCase();
      });
    } catch (_) {}
  }
  function isAutoMode() { return _cachedOperationMode === 'AUTO'; }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const LOG = (...a) => console.log('[TM]', ...a);
  const ERR = (...a) => console.error('[TM]', ...a);
  const WARN = (...a) => console.warn('[TM]', ...a);
  const touchProgress = () => { lastProgressAt = Date.now(); };
  const ctxOk = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const isBusy = () => isExecuting || isProcessingAutomation || activeWorkers.size > 0 || resultQueue.length > 0;
  window.__tmBusy = isBusy;

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function adj(ms) { return clamp(Math.round((ms || 0) * __timeScale), 15, 60000); }
  function tune(elapsed, timeout) {
    if (!timeout || !elapsed) return;
    const r = elapsed / timeout;
    if (r >= 0.9) __timeScale = clamp(__timeScale * 1.06 + 0.02, 0.35, 1.4);
    else if (r <= 0.15) __timeScale = clamp(__timeScale * 0.94 - 0.01, 0.35, 1.4);
  }
  function tmSleep(ms) { return new Promise(r => setTimeout(r, adj(ms))); }

  function xp(path, ctx) {
    try { return document.evaluate(path, ctx || document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
    catch (_) { return null; }
  }

  function normalizeDigits(s) { return String(s ?? '').replace(/[^\d]/g, ''); }

  function normalizeMoneyLike(s) {
    const raw = String(s || '').replace(/\s+/g, '');
    const digits = raw.replace(/[^\d]/g, '');
    return digits;
  }

  function parseScatterLike(s) {
    const m = String(s || '').match(/(\d+)/);
    if (!m) return NaN;
    return parseInt(m[1], 10);
  }

  function isBettingPresent(v) {
    return normalizeMoneyLike(v).length > 0;
  }

  function isScatterPresent(v) {
    const n = parseScatterLike(v);
    return !isNaN(n) && n > 0;
  }

  function getMissingDataState(txId) {
    const key = String(txId || '').trim();
    if (!key) return null;
    if (!missingDataRetryMap.has(key)) missingDataRetryMap.set(key, { count: 0, lastAt: 0 });
    return missingDataRetryMap.get(key);
  }

  function clearMissingDataRetry(txId) {
    const key = String(txId || '').trim();
    if (!key) return;
    missingDataRetryMap.delete(key);
  }

  function markMissingDataRetry(txId) {
    const st = getMissingDataState(txId);
    if (!st) return { count: 0, exceed: false };
    st.count += 1;
    st.lastAt = Date.now();
    return { count: st.count, exceed: st.count >= MAX_MISSING_DATA_RETRY };
  }

  function hasRequiredDataForDecision(input) {
    const betting = input?.betting;
    const scatter = input?.scatter;
    const betOk = isBettingPresent(betting);
    const scatterOk = isScatterPresent(scatter);
    return { ok: betOk && scatterOk, betOk, scatterOk };
  }

  function simulateClick(el) {
    if (!el) return;
    ['mousedown', 'mouseup', 'click'].forEach(ev =>
      el.dispatchEvent(new MouseEvent(ev, { view: window, bubbles: true, cancelable: true, buttons: 1 }))
    );
  }

  let _keepAlivePort = null;
  let _keepAliveTimer = null;
  let _keepAliveReconnects = 0;
  const MAX_RECONNECT_DELAY = 5000;
  let _keepAliveAlive = false;

  function ensureKeepAlivePort() {
    try {
      if (_keepAlivePort) {
        try { _keepAlivePort.postMessage({ action: 'ping' }); } catch (_) { _keepAlivePort = null; }
        if (_keepAlivePort) return;
      }
      _keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
      _keepAliveReconnects = 0;
      _keepAlivePort.onDisconnect.addListener(() => {
        _keepAlivePort = null;
        _keepAliveReconnects++;
        const delay = Math.min(500 * Math.pow(1.3, _keepAliveReconnects), MAX_RECONNECT_DELAY);
        setTimeout(ensureKeepAlivePort, delay);
      });
      _keepAlivePort.onMessage.addListener(() => {});
    } catch (_) {
      _keepAliveReconnects++;
      const delay = Math.min(500 * Math.pow(1.3, _keepAliveReconnects), MAX_RECONNECT_DELAY);
      setTimeout(ensureKeepAlivePort, delay);
    }
  }

  function keepAliveGuard() {
    if (_keepAliveAlive) return;
    _keepAliveAlive = true;
    ensureKeepAlivePort();
    setInterval(() => {
      try { ensureKeepAlivePort(); } catch (_) {}
      try {
        chrome.runtime.sendMessage({ action: '_alivePing' }, () => {
          if (chrome.runtime.lastError) { _keepAlivePort = null; setTimeout(ensureKeepAlivePort, 100); }
        });
      } catch (_) { _keepAlivePort = null; setTimeout(ensureKeepAlivePort, 100); }
    }, 1000);
    setInterval(() => {
      try {
        if (!_keepAlivePort) ensureKeepAlivePort();
        else try { _keepAlivePort.postMessage({ action: 'ping' }); } catch (_) { _keepAlivePort = null; ensureKeepAlivePort(); }
      } catch (_) { ensureKeepAlivePort(); }
    }, 3000);
  }

  async function megaClick(el, tries = 5) {
    if (!el) return false;
    const origHref = (el.tagName === 'A' || el.tagName === 'AREA') ? (el.getAttribute('href') || '') : '';
    const hasJsHref = origHref.startsWith('javascript:');
    if (hasJsHref) el.removeAttribute('href');
    try {
      for (let t = 0; t < tries; t++) {
        try {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          await tmSleep(CFG.CLICK_DELAY);
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
          const cx = (r.left || 0) + (r.width || 12) / 2;
          const cy = (r.top || 0) + (r.height || 12) / 2;
          const ev = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: cx, clientY: cy };
          ['pointerover','pointerenter','mouseover','pointermove','mousemove',
           'pointerdown','mousedown','pointerup','mouseup','click'].forEach(n => {
            try { el.dispatchEvent(new MouseEvent(n, ev)); } catch (_) {}
          });
          el.click();
          return true;
        } catch (_) {           await tmSleep(30 * (t + 1)); }
      }
      return false;
    } finally {
      if (hasJsHref) el.setAttribute('href', origHref);
    }
  }

  function pressEscape() {
    try {
      const opts = { key: 'Escape', bubbles: true, cancelable: true, composed: true };
      document.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.dispatchEvent(new KeyboardEvent('keypress', opts));
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (_) {}
  }

  async function pressEscapeBurst(count = 3, gap = CFG.ESC_GAP) {
    for (let i = 0; i < count; i++) {
      pressEscape();
      if (i < count - 1) await tmSleep(gap);
    }
  }

  function isLikelyVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent != null) return true;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function fillTextarea(ta, text) {
    if (!ta) return;
    try {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(ta, text);
      else ta.value = text;
    } catch (_) { ta.value = text; }
    ta.focus();
    ['input', 'change', 'blur'].forEach(ev => ta.dispatchEvent(new Event(ev, { bubbles: true })));
  }

  function waitUntilTrue(fn, timeoutMs, observeTarget, observeOpts) {
    return new Promise(resolve => {
      const start = Date.now();
      const r = fn();
      if (r) { tune(Date.now() - start, timeoutMs); resolve(r); return; }
      let done = false;
      const finish = result => { if (!done) { done = true; clearTimeout(timer); obs.disconnect(); tune(Date.now() - start, timeoutMs); resolve(result); } };
      const timer = setTimeout(() => finish(fn() || null), adj(timeoutMs));
      const obs = new MutationObserver(() => { const v = fn(); if (v) finish(v); });
      obs.observe(observeTarget || document.body, observeOpts || { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }

  function injectAutoReload() {
    if (document.getElementById('__tm_guard')) return;
    try {
      chrome.runtime.sendMessage({ action: 'injectNetworkGuard' }, function(resp) {
        if (chrome.runtime.lastError || !resp || resp.status !== 'ok') { fallbackInjectGuard(); return; }
        var el = document.createElement('div');
        el.id = '__tm_guard'; el.style.display = 'none';
        document.body.appendChild(el);
      });
    } catch (_) { fallbackInjectGuard(); }
  }
  function fallbackInjectGuard() {
    if (document.getElementById('__tm_guard')) return;
    var s = document.createElement('script');
    s.id = '__tm_guard'; s.textContent = '(' + function(){
      var ec = 0, et = 0;
      var f = window.fetch;
      window.fetch = function(u, o) {
        return f.call(window, u, o).then(function(r) {
          if (r.status === 500 && typeof u === 'string' && u.indexOf('api.bonussmb.com') > -1) {
            ec++;
            if (et === 0) et = Date.now();
            if (ec >= 3 && Date.now() - et < 30000) location.reload();
            else if (Date.now() - et > 30000) { ec = 1; et = Date.now(); }
          }
          return r;
        });
      };
      var X = window.XMLHttpRequest, _o = X.prototype.open, _s = X.prototype.send;
      X.prototype.open = function(m, u) { this.__u = u; return _o.call(this, m, u); };
      X.prototype.send = function(b) {
        var x = this;
        this.addEventListener('loadend', function() {
          if (x.status === 500 && x.__u && x.__u.indexOf('api.bonussmb.com') > -1) {
            ec++;
            if (et === 0) et = Date.now();
            if (ec >= 3 && Date.now() - et < 30000) location.reload();
            else if (Date.now() - et > 30000) { ec = 1; et = Date.now(); }
          }
        });
        return _s.call(this, b);
      };
    }.toString() + ')();';
    (document.head || document.documentElement).appendChild(s);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${ROW_OK}   { background: rgba(0,230,118,0.30) !important; outline: 2px solid #00e676 !important; }
      .${ROW_OK} td { background: rgba(0,230,118,0.20) !important; }
      .${ROW_ERR}  { background: rgba(255,23,68,0.28)  !important; outline: 2px solid #ff1744 !important; }
      .${ROW_ERR} td { background: rgba(255,23,68,0.18) !important; }
      .${ROW_PEND}  { background: rgba(255,204,0,0.22) !important; outline: 2px solid #ffcc00 !important; }
      .${ROW_PEND} td { background: rgba(255,204,0,0.12) !important; }
      .${ROW_BLUE}  { background: rgba(33,150,243,0.28) !important; outline: 2px solid #2196f3 !important; }
      .${ROW_BLUE} td { background: rgba(33,150,243,0.16) !important; }
      .${ROW_SKIP}  { background: rgba(212,237,218,0.45) !important; outline: 2px solid #D4EDDA !important; }
      .${ROW_SKIP} td { background: rgba(212,237,218,0.30) !important; }
      .${ROW_BLACK} { background: #111111 !important; outline: 2px solid #000000 !important; color: #ffffff !important; }
      .${ROW_BLACK} td { background: #111111 !important; color: #ffffff !important; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectBadge() {
    if (document.getElementById('__tm_badge')) return;
    const b = document.createElement('div');
    b.id = '__tm_badge';
    Object.assign(b.style, {
      position: 'fixed', bottom: '14px', right: '14px', zIndex: '9999999',
      background: 'linear-gradient(135deg,#071428,#0d2b55)',
      color: '#3dffce', border: '1.5px solid #26ffe0aa', borderRadius: '10px',
      padding: '8px 14px', fontSize: '11px', fontFamily: 'monospace',
      boxShadow: '0 0 18px #00ffc855', pointerEvents: 'none',
      userSelect: 'none', lineHeight: '1.7'
    });
    document.body.appendChild(b);
    setInterval(() => {
      const sec = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
      const exec = isExecuting || isProcessingAutomation || activeWorkers.size > 0;
      b.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <div style="width:8px;height:8px;border-radius:50%;background:${exec ? '#ffcc00' : '#00ff88'};box-shadow:0 0 8px ${exec ? '#ffcc00' : '#00ff88'}${exec ? ';animation:pulse 1s infinite' : ''}"></div>
        <span style="font-family:Orbitron,monospace;font-weight:900;letter-spacing:1px;font-size:11px">AUTO MONITOR</span></div>
        <div style="font-size:10px;color:#5e8aaa">${new Date().toLocaleTimeString('id-ID')} | Scan: ${sec}s</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;margin-top:4px;font-size:10px">
        <span>⏳ Queue: <b style="color:#ffcc00">${retryQueue.size}</b></span>
        <span>⚡ Workers: <b style="color:#00ffe5">${activeWorkers.size}/${CFG.MAX_WORKERS}</b></span>
        <span>📋 Result: <b>${resultQueue.filter(i => i.isApprove === true).length}</b></span>
        <span>❌ Result: <b>${resultQueue.filter(i => i.isApprove === false).length}</b></span>
        <span>✅ Done: <b style="color:#00e676">${_completedTx.size}</b></span>
        <span>⏭️ Skip: <b style="color:#888">${_ignoredTx.size}</b></span>
        ${missingFromPageQueue.size > 0 ? `<span style="grid-column:1/-1">🔄 Missing: <b>${missingFromPageQueue.size}</b></span>` : ''}</div>`;
    }, 500);
  }

  function getTicketsTbody() {
    let best = null, bestScore = 0;
    document.querySelectorAll('main table, [role="main"] table, article table').forEach(table => {
      const tb = table.querySelector('tbody');
      if (!tb) return;
      const head = table.querySelector('thead');
      const text = ((head && head.textContent) || tb.textContent || '').toUpperCase();
      const n = tb.querySelectorAll(':scope > tr').length;
      let score = n;
      if (text.includes('KODE')) score += 100;
      if (text.includes('USER')) score += 20;
      if (text.includes('STATUS') || text.includes('PENDING')) score += 30;
      if (text.includes('BETTING') || text.includes('SCATTER')) score += 20;
      if (score > bestScore) { bestScore = score; best = tb; }
    });
    return best || document.querySelector('table tbody');
  }

  function getRows() {
    const tbody = getTicketsTbody();
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll(':scope > tr')).filter(r => {
      if (!r.cells || r.cells.length < 3) return false;
      if (r.cells.length === 1 && Number(r.cells[0].colSpan) > 1) return false;
      return true;
    });
  }

  function buildColMap() {
    const map = { userId: -1, kode: -1, betting: -1, scatter: -1, hadiah: -1, status: -1 };
    const tbody = getTicketsTbody();
    const table = tbody && tbody.closest('table');
    let thNodes = table
      ? Array.from(table.querySelectorAll('thead th, tr th, th'))
      : Array.from(document.querySelectorAll('table thead th, table tr th, table th'));
    thNodes.forEach((th, i) => {
      const t = th.textContent.trim().toUpperCase();
      if (t.includes('USER') || t === 'AKUN') map.userId = i;
      else if ((t.includes('SITUS') || t.includes('MEMBER')) && map.userId < 0) map.userId = i;
      if (t.includes('KODE') || t.includes('CODE')) map.kode = i;
      if (t.includes('BETTING') || t.includes('BET')) map.betting = i;
      if (t.includes('SCATTER')) map.scatter = i;
      if (t.includes('HADIAH') || t.includes('PRIZE')) map.hadiah = i;
      if (t.includes('STATUS')) map.status = i;
    });
    if (map.kode < 0) map.kode = 1;
    if (map.userId < 0) map.userId = 0;
    if (map.betting < 0) map.betting = 3;
    if (map.scatter < 0) map.scatter = 4;
    if (map.hadiah < 0) map.hadiah = 5;
    if (map.status < 0) map.status = 6;
    return map;
  }

  function extractTicketData(row, colMap) {
    const cell = idx => (idx >= 0 && row.cells && row.cells[idx]) ? _san(row.cells[idx].textContent, 300) : '';
    const rawKode = cell(colMap.kode);
    const kodeNum = rawKode.match(/\d{8,30}/);
    const txId = kodeNum ? kodeNum[0] : rawKode.replace(/\s/g, '').replace(/[^\dA-Za-z]/g, '').slice(0, 30);
    if (!txId || txId.length < 5 || txId.length > 30) return null;
    let userId = _san(cell(colMap.userId)).replace(/[^\w@.\-]/g, ' ').trim().split(/\s+/)[0] || '';
    const betting = _san(cell(colMap.betting), 50);
    const scatterRaw = _san(cell(colMap.scatter), 20);
    const hadiah = _san(cell(colMap.hadiah), 200);
    const status = _san(cell(colMap.status), 30).toUpperCase().trim();
    const scatterM = scatterRaw.match(/(\d+)/);
    let scatter = scatterM ? scatterM[1] : '';
    if (scatter) {
      const n = parseInt(scatter, 10);
      if (!isNaN(n) && n > 5) scatter = '5';
      if (!isNaN(n) && n < 3 && n > 0) {
        WARN(`[GUARD extractTicketData] Scatter ${n} < 3 pada ${txId} — dikosongkan`);
        scatter = '';
      }
    }
    if (normalizeDigits(txId).length < 10) return null;
    return { txId, userId, betting, scatter, hadiah, status };
  }

  function findRowByTxId(txId) {
    if (!txId) return null;
    const digits = normalizeDigits(txId);
    if (!digits || digits.length < 5 || digits.length > 25) return null;
    const shortDigits = digits.slice(0, 15);
    const tbody = getTicketsTbody();
    if (!tbody) return null;
    for (const row of tbody.querySelectorAll(':scope > tr')) {
      if (!row.cells || row.cells.length < 2) continue;
      for (let ci = 0; ci < Math.min(row.cells.length, 5); ci++) {
        const cd = normalizeDigits(row.cells[ci].textContent || '');
        if (cd === digits || cd === shortDigits) return row;
        if (digits.length >= 15 && cd.includes(shortDigits)) return row;
      }
    }
    const prefixes = [digits, shortDigits, digits.slice(0, 12)].filter(p => p.length >= 12);
    for (const row of tbody.querySelectorAll(':scope > tr')) {
      const rd = normalizeDigits(row.textContent || '');
      if (prefixes.some(p => rd.includes(p))) return row;
    }
    return null;
  }

  function validateRowForTxId(row, txId) {
    if (!row || !txId) return false;
    const cm = buildColMap();
    if (cm.kode < 0) return false;
    const cell = (row.cells && row.cells[cm.kode]) ? _san(row.cells[cm.kode].textContent, 300) : '';
    const kodeNum = cell.match(/\d{8,30}/);
    const rowTxId = kodeNum ? kodeNum[0] : cell.replace(/\s/g, '').replace(/[^\dA-Za-z]/g, '').slice(0, 30);
    return normalizeDigits(rowTxId) === normalizeDigits(txId);
  }

  async function waitForRowByTxId(txId, timeoutMs) {
    const target = normalizeDigits(txId);
    if (!target) return null;
    const tryFind = () => {
      const d = findRowByTxId(target);
      if (d) return d;
      for (const r of getRows()) { if (normalizeDigits(r.textContent || '') === target) return r; }
      const prefix = target.slice(0, 15);
      for (const r of getRows()) {
        const t = normalizeDigits(r.textContent || '');
        if (t.includes(target) || t.includes(prefix) || target.includes(t)) return r;
      }
      return null;
    };
    const r = tryFind();
    if (r) return r;
    try { window.scrollBy(0, 1); window.scrollBy(0, -1); } catch (_) {}
    return waitUntilTrue(tryFind, timeoutMs || 9000, document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  async function waitForFreshRowByTxId(txId, maxAttempts = 6) {
    for (let i = 0; i < maxAttempts; i++) {
      const row = findRowByTxId(txId);
      if (row && row.isConnected) return row;
      try { window.scrollBy(0, i % 3 === 0 ? 50 : 5); await tmSleep(10 + (i % 3 === 0 ? 0 : 5)); window.scrollBy(0, -(i % 3 === 0 ? 50 : 5)); } catch (_) {}
      await tmSleep(70 + i * 15);
    }
    return findRowByTxId(txId) || null;
  }

  function isTxIdInPage(txId) {
    if (!txId) return false;
    const row = findRowByTxId(txId);
    return !!(row && row.isConnected);
  }

  function getShowingTotal() {
    const allText = Array.from(document.querySelectorAll('p, span, div, td'))
      .map(el => ({ el, text: (el.textContent || '').trim() }))
      .filter(({ text }) => /showing\s+\d+/i.test(text) || /\d+\s*[-–]\s*\d+\s+out\s+of\s+\d+/i.test(text));
    for (const { text } of allText) {
      const m = text.match(/\d+\s*[-–]\s*\d+\s+out\s+of\s+(\d+)/i)
             || text.match(/showing\s+\d+\s*[-–]\s*\d+\s+of\s+(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function paintRowStyles(row, color) {
    if (!row) return;
    row.style.outline = ''; row.style.backgroundColor = ''; row.style.borderLeft = ''; row.style.transition = '';
    row.classList.remove(ROW_OK, ROW_ERR, ROW_PEND, ROW_BLUE, ROW_SKIP, ROW_BLACK);
    if (color === COLOR.OK || color === '#00c853') row.classList.add(ROW_OK);
    else if (color === COLOR.ERR || color === '#d50000' || color === '#b71c1c') row.classList.add(ROW_ERR);
    else if (color === COLOR.PEND) row.classList.add(ROW_PEND);
    else if (color === COLOR.BLUE) row.classList.add(ROW_BLUE);
    else if (color === COLOR.SKIP) row.classList.add(ROW_SKIP);
    else if (color === COLOR.BLACK) row.classList.add(ROW_BLACK);
  }

  function applyColor(row, color, txId) {
    if (!row) return;
    if (txId) rowColorMap.set(txId, color);
    if (txId && (color === COLOR.OK || color === COLOR.ERR || color === COLOR.APPROVE || color === COLOR.REJECT)) {
      mirrorDecisionsToSession();
    }
    paintRowStyles(row, color);
    persistColors();
    if (txId && (color === COLOR.OK || color === COLOR.ERR || color === COLOR.APPROVE || color === COLOR.REJECT)) {
      schedulePersistAll();
    }
  }

  function safeApplyColor(txId, expectedColor, delayMs = 250, maxRetries = 3) {
    if (!txId || !expectedColor) return;
    rowColorMap.set(txId, expectedColor);
    mirrorDecisionsToSession();
    const attempt = retries => {
      if (rowColorMap.get(txId) !== expectedColor) return;
      const row = findRowByTxId(txId);
      if (row && row.isConnected) { paintRowStyles(row, expectedColor); return; }
      if (retries > 0) setTimeout(() => attempt(retries - 1), delayMs);
    };
    persistColors();
    attempt(maxRetries);
  }

  function mirrorDecisionsToSession() {
    try {
      const obj = {};
      pendingDecisionMap.forEach((v, k) => { obj[k] = v; });
      sessionStorage.setItem('__tm_ticketsUiDecisions', JSON.stringify(obj));
      const cols = {};
      rowColorMap.forEach((v, k) => { cols[k] = { color: v, t: Date.now() }; });
      sessionStorage.setItem('__tm_ticketsUiRowColors', JSON.stringify(cols));
      sessionStorage.setItem('__tm_resultQueue', JSON.stringify(resultQueue.map(i => ({
        txId: i.txId, userId: i.userId || '', isApprove: i.isApprove,
        rejectReason: i.rejectReason || '', retryCount: i.retryCount || 0
      }))));
    } catch (_) {}
  }

  function commitFinalVerdict(txId, isApprove, reason, rawMsg, rqItem) {
    if (!txId) return;
    const color = isApprove === true ? COLOR.OK : isApprove === false ? COLOR.ERR : COLOR.PEND;
    const entry = { isApprove, reason: reason || '', color, _raw: rawMsg || null, t: Date.now() };
    pendingDecisionMap.set(txId, entry);
    rowColorMap.set(txId, color);
    if (rqItem && !resultQueue.some(e => e.txId === txId)) resultQueue.push(rqItem);
    mirrorDecisionsToSession();
    const row = findRowByTxId(txId);
    if (row && row.isConnected) paintRowStyles(row, color);
    schedulePersistAll();
    if (!ctxOk()) return;
    const obj = {};
    pendingDecisionMap.forEach((v, k) => { obj[k] = v; });
    try {
      chrome.storage.local.set({
        ticketsUiDecisions: obj,
        ticketsUiRowColors: Object.fromEntries([...rowColorMap].map(([k, c]) => [k, { color: c, t: Date.now() }])),
        tmResultQueue: resultQueue.map(i => ({
          txId: i.txId, userId: i.userId || '', isApprove: i.isApprove,
          rejectReason: i.rejectReason || '', _raw: i._raw || null, _log: i._log || null, retryCount: i.retryCount || 0
        }))
      }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
    if (isApprove === true || isApprove === false) {
      persistVerifiedResult(txId, { userId: rqItem?.userId || '', isApprove, reason: reason || '', t: Date.now() });
    }
  }

  function loadDecisionsFromSession() {
    try {
      const decRaw = sessionStorage.getItem('__tm_ticketsUiDecisions');
      if (decRaw) {
        const obj = JSON.parse(decRaw);
        Object.keys(obj).forEach(tx => {
          if (!obj[tx]) return;
          const existing = pendingDecisionMap.get(tx);
          const incoming = obj[tx];
          if (!existing || incoming.isApprove === true || incoming.isApprove === false || existing.isApprove === null) {
            pendingDecisionMap.set(tx, incoming);
            if (incoming.color) rowColorMap.set(tx, incoming.color);
          }
        });
      }
      const colRaw = sessionStorage.getItem('__tm_ticketsUiRowColors');
      if (colRaw) {
        const cobj = JSON.parse(colRaw);
        Object.keys(cobj).forEach(tx => { if (cobj[tx]?.color) rowColorMap.set(tx, cobj[tx].color); });
      }
      const rqRaw = sessionStorage.getItem('__tm_resultQueue');
      if (rqRaw) {
        const arr = JSON.parse(rqRaw);
        for (const item of arr) {
          if (item?.txId && !resultQueue.some(i => i.txId === item.txId)) resultQueue.push(item);
        }
      }
      reapplyAllRowColors();
    } catch (_) {}
  }

  let _persistAllTimer = null;
  function schedulePersistAll() {
    mirrorDecisionsToSession();
    if (_persistAllTimer) clearTimeout(_persistAllTimer);
    _persistAllTimer = setTimeout(() => {
      _persistAllTimer = null;
      try { persistDecisionsNow(); } catch (_) {}
      try { persistResultQueue(); } catch (_) {}
      try { persistRetryQueue(); } catch (_) {}
    }, 35);
  }

  function purgeStaleCompletedState() {
    const cm = buildColMap();
    let purged = 0;
    for (const txId of [..._completedTx.keys()]) {
      const row = findRowByTxId(txId);
      if (!row) continue;
      const d = extractTicketData(row, cm);
      if (d && (d.status === 'PENDING' || d.status === 'WAITING')) {
        _completedTx.delete(txId);
        if (_doneTxIds.get(txId) === 'APPROVE' || _doneTxIds.get(txId) === 'REJECT') _doneTxIds.delete(txId);
        purged++;
      }
    }
    for (const txId of [..._doneTxIds.keys()]) {
      const st = _doneTxIds.get(txId);
      if (st !== 'APPROVE' && st !== 'REJECT') continue;
      const row = findRowByTxId(txId);
      if (!row) continue;
      const d = extractTicketData(row, cm);
      if (d && (d.status === 'PENDING' || d.status === 'WAITING')) {
        _doneTxIds.delete(txId);
        _completedTx.delete(txId);
        purged++;
      }
    }
    if (purged > 0) LOG(`[STALE-PURGE] ${purged} status done/completed tapi masih PENDING — dibersihkan`);
    return purged;
  }

  function scheduleRecoverKicks() {
    const kicks = [0, 400, 1200, 2500, 5000];
    for (const ms of kicks) {
      setTimeout(() => {
        if (!ctxOk()) return;
        purgeStaleCompletedState();
        reapplyAllRowColors();
        recoverPendingWorkAfterLoad();
        if (resultQueue.length > 0 && !isExecuting) tryDrainBatch();
        if (retryQueue.size > 0) processQueue();
      }, ms);
    }
  }

  let _lastPersistColors = '';
  function persistColors() {
    if (!ctxOk()) return;
    const obj = {};
    rowColorMap.forEach((v, k) => { obj[k] = { color: v, t: Date.now() }; });
    const keys = Object.keys(obj);
    if (keys.length > 400) { keys.sort((a, b) => (obj[a].t || 0) - (obj[b].t || 0)); for (let i = 0; i < keys.length - 400; i++) delete obj[keys[i]]; }
    const json = JSON.stringify(obj);
    if (json === _lastPersistColors) return;
    _lastPersistColors = json;
    try { chrome.storage.local.set({ ticketsUiRowColors: obj }, () => { void chrome.runtime.lastError; }); } catch (_) {}
    mirrorDecisionsToSession();
  }

  function persistDecision(txId, isApprove, reason, rawMsg) {
    if (!txId) return;
    const color = isApprove === true ? COLOR.OK : isApprove === false ? COLOR.ERR : COLOR.PEND;
    const entry = { isApprove, reason: reason || '', color, _raw: rawMsg || null, t: Date.now() };
    pendingDecisionMap.set(txId, entry);
    rowColorMap.set(txId, color);
    schedulePersistAll();
    if (!ctxOk()) return;
    const obj = {};
    pendingDecisionMap.forEach((v, k) => { obj[k] = v; });
    try { chrome.storage.local.set({ ticketsUiDecisions: obj, ticketsUiRowColors: Object.fromEntries([...rowColorMap].map(([k, c]) => [k, { color: c, t: Date.now() }])) }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  }

  function clearPersistedDecision(txId) {
    pendingDecisionMap.delete(txId);
    rowColorMap.delete(txId);
    mirrorDecisionsToSession();
    if (!ctxOk()) return;
    const obj = {};
    pendingDecisionMap.forEach((v, k) => { obj[k] = v; });
    const colors = {};
    rowColorMap.forEach((v, k) => { colors[k] = { color: v, t: Date.now() }; });
    try { chrome.storage.local.set({ ticketsUiDecisions: obj, ticketsUiRowColors: colors }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  }

  function isPrematureRejectReason(reason) {
    const r = String(reason || '').toLowerCase();
    return r.includes('belum siap') || r.includes('belum tersedia')
      || r.includes('ditemukan: 0') || r.includes('ditemukan 0')
      || (r.includes('scatter tidak valid') && /\b0\b/.test(r))
      || (r.includes('gagal') && r.includes('scatter') && r.includes('0'));
  }

  function markSesuaiIgnore(txId, rawMsg) {
    if (!txId) return;
    _doneTxIds.set(txId, 'IGNORE');
    _ignoredTx.add(txId);
    persistIgnoredTx();
    let snap = null;
    const snapRow = findRowByTxId(txId);
    if (snapRow) {
      const d = extractTicketData(snapRow, buildColMap());
      if (d && (String(d.betting || '') !== '' || String(d.scatter || '') !== '')) snap = { betting: String(d.betting || ''), scatter: String(d.scatter || '') };
    }
    pendingDecisionMap.set(txId, { isApprove: 'IGNORE', reason: 'SESUAI — tanpa aksi otomatis', color: COLOR.BLUE, _raw: rawMsg || null, _snap: snap, t: Date.now() });
    rowColorMap.set(txId, COLOR.BLUE);
    mirrorDecisionsToSession();
    try {
      const obj = {};
      pendingDecisionMap.forEach((v, k) => { obj[k] = v; });
      const colors = {};
      rowColorMap.forEach((v, k) => { colors[k] = { color: v, t: Date.now() }; });
      chrome.storage.local.set({ ticketsUiDecisions: obj, ticketsUiRowColors: colors }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
    const row = findRowByTxId(txId);
    if (row && row.isConnected) applyColor(row, COLOR.BLUE, txId);
    else safeApplyColor(txId, COLOR.BLUE, 250, 3);
  }

  function clearTicketTracking(txId) {
    if (!txId) return;
    _doneTxIds.delete(txId);
    _completedTx.delete(txId);
    retryQueue.delete(txId);
    pendingDecisionMap.delete(txId);
    activeWorkers.delete(txId);
    missingFromPageQueue.delete(txId);
    missingDataRetryMap.delete(txId);
    _verifiedResultsCache.delete(txId);
    for (let i = resultQueue.length - 1; i >= 0; i--) { if (resultQueue[i]?.txId === txId) resultQueue.splice(i, 1); }
    persistRetryQueue();
    persistCompletedTx();
    persistIgnoredTx();
    persistMissingQueue();
    try {
      chrome.storage.local.get(['tmVerifiedResults', 'ticketsUiDecisions', 'ticketsUiRowColors', 'tmResultQueue'], res => {
        const updates = {};
        if (res?.tmVerifiedResults && typeof res.tmVerifiedResults === 'object' && res.tmVerifiedResults[txId]) { const obj = { ...res.tmVerifiedResults }; delete obj[txId]; updates.tmVerifiedResults = obj; }
        if (res?.ticketsUiDecisions && typeof res.ticketsUiDecisions === 'object' && res.ticketsUiDecisions[txId]) { const obj = { ...res.ticketsUiDecisions }; delete obj[txId]; updates.ticketsUiDecisions = obj; }
        if (res?.ticketsUiRowColors && typeof res.ticketsUiRowColors === 'object' && res.ticketsUiRowColors[txId]) { const obj = { ...res.ticketsUiRowColors }; delete obj[txId]; updates.ticketsUiRowColors = obj; }
        if (Array.isArray(res?.tmResultQueue)) { updates.tmResultQueue = res.tmResultQueue.filter(i => i.txId !== txId); }
        if (Object.keys(updates).length) chrome.storage.local.set(updates, () => { void chrome.runtime.lastError; });
      });
    } catch (_) {}
    LOG(`[CLEAR-TRACKING] ${txId} — semua data tracking dihapus, siap di-check ulang`);
  }

  function reapplyAllRowColors() {
    if (rowColorMap.size === 0 && pendingDecisionMap.size === 0) return;
    const cm = buildColMap();
    for (const row of getRows()) {
      const d = extractTicketData(row, cm);
      if (!d) continue;
      const dec = pendingDecisionMap.get(d.txId);
      let col = dec?.color || rowColorMap.get(d.txId);
      if (!col) {
        const text = (row.textContent || '').replace(/\s/g, '');
        for (const [tid, c] of rowColorMap) {
          if (text.includes(tid) || tid.startsWith(d.txId.slice(0, 15)) || d.txId.startsWith(tid.slice(0, 15))) { col = c; break; }
        }
      }
      if (col) paintRowStyles(row, col);
    }
  }

  let colorsLoaded = false;
  let colorsLoadedResolve = null;
  const colorsLoadedPromise = new Promise(r => { colorsLoadedResolve = r; });
  const awaitColorsLoaded = () => colorsLoadedPromise;

  function loadPersistedColors() {
    if (colorsLoaded) return;
    if (!ctxOk()) { colorsLoaded = true; colorsLoadedResolve?.(); return; }
    try {
      chrome.storage.local.get(['ticketsUiRowColors', 'ticketsUiDecisions'], res => {
        if (chrome.runtime.lastError) { colorsLoaded = true; colorsLoadedResolve?.(); return; }
        const stored = res?.ticketsUiRowColors || {};
        Object.keys(stored).forEach(tx => { const c = stored[tx]?.color; if (c && !rowColorMap.has(tx)) rowColorMap.set(tx, c); });
        const dec = res?.ticketsUiDecisions || {};
        Object.keys(dec).forEach(tx => {
          if (!dec[tx]) return;
          const incoming = dec[tx];
          const existing = pendingDecisionMap.get(tx);
          if (!existing || incoming.isApprove === true || incoming.isApprove === false || existing.isApprove === null) {
            pendingDecisionMap.set(tx, incoming);
            if (incoming.color) rowColorMap.set(tx, incoming.color);
          } else if (incoming.color) {
            rowColorMap.set(tx, incoming.color);
          }
        });
        const kick = () => { reapplyAllRowColors(); };
        kick();
        colorsLoaded = true;
        colorsLoadedResolve?.();
        loadVerifiedResultsCache(() => {
          reapplyAllRowColors();
          recoverPendingWorkAfterLoad();
        });
        scheduleRecoverKicks();
        setTimeout(kick, 300);
        setTimeout(kick, 1000);
        setTimeout(kick, 2500);
      });
    } catch (_) { colorsLoaded = true; colorsLoadedResolve?.(); }
  }

  let _verifiedResultsCache = new Map();

  function entryFromMarwanResult(r) {
    const txId = String(r.transactionId || r.txId || '').trim();
    if (!txId) return null;
    const overall = String(r.overallStatus || '').toUpperCase();
    let isApprove = overall === 'SESUAI';
    let isReject = overall === 'TIDAK_SESUAI' || overall === 'REJECT';
    if (!isApprove && !isReject) {
      if (r.betCheckStatus === 'SESUAI' && r.scatterCheckStatus === 'SESUAI') isApprove = true;
      else if (r.betCheckStatus === 'TIDAK_SESUAI' || r.scatterCheckStatus === 'TIDAK_SESUAI') isReject = true;
    }
    if (!isApprove && !isReject) {
      const t = String(r.scatterTitle || '').toLowerCase();
      if (t.includes('gagal') || t.includes('❌') || t.startsWith('error') || t.includes('tidak ditemukan')) isReject = true;
      else return null;
    }
    return {
      txId, userId: r.userId || '',
      isApprove: !!isApprove && !isReject,
      status: isApprove && !isReject ? 'SESUAI' : 'TIDAK_SESUAI',
      reason: (isApprove && !isReject) ? '' : (r.klaimRejectReason || r.scatterTitle || 'kode tiket tidak di temukan'),
      t: Date.parse(r.time) || Date.now()
    };
  }

  function entryFromVerifiedStore(v) {
    if (!v?.txId) return null;
    const txId = String(v.txId).trim();
    if (v.compareState === 'processing') return null;
    const isApprove = v.isApprove === true || v.compareState === 'match' || v.status === 'SESUAI';
    const isReject = v.isApprove === false || v.compareState === 'mismatch' || v.status === 'TIDAK_SESUAI';
    if (!isApprove && !isReject) return null;
    return {
      txId, userId: v.userId || v.mId || '',
      isApprove: !!isApprove && !isReject,
      status: isApprove && !isReject ? 'SESUAI' : 'TIDAK_SESUAI',
      reason: v.reason || v.rejectReason || '',
      t: v.t || Date.now()
    };
  }

  function mergeVerifiedEntry(a, b) {
    if (!a) return b;
    if (!b) return a;
    return (b.t || 0) >= (a.t || 0) ? b : a;
  }

  function rebuildVerifiedResultsCache(storageRes) {
    const map = new Map();
    const store = storageRes?.tmVerifiedResults;
    if (store && typeof store === 'object') {
      Object.keys(store).forEach(k => {
        const e = entryFromVerifiedStore(store[k]);
        if (e) map.set(e.txId, mergeVerifiedEntry(map.get(e.txId), e));
      });
    }
    const marwan = Array.isArray(storageRes?.marwanResults) ? storageRes.marwanResults : [];
    for (const r of marwan) {
      const e = entryFromMarwanResult(r);
      if (e) map.set(e.txId, mergeVerifiedEntry(map.get(e.txId), e));
    }
    _verifiedResultsCache = map;
  }

  function loadVerifiedResultsCache(cb) {
    if (!ctxOk()) { if (cb) cb(); return; }
    try {
      chrome.storage.local.get(['tmVerifiedResults', 'marwanResults'], res => {
        if (chrome.runtime.lastError) { if (cb) cb(); return; }
        rebuildVerifiedResultsCache(res);
        if (cb) cb();
      });
    } catch (_) { if (cb) cb(); }
  }

  function persistVerifiedResult(txId, entry) {
    if (!txId || !entry || entry.isApprove !== true && entry.isApprove !== false) return;
    const normalized = {
      txId: String(txId),
      userId: entry.userId || '',
      isApprove: entry.isApprove,
      status: entry.isApprove ? 'SESUAI' : 'TIDAK_SESUAI',
      compareState: entry.isApprove ? 'match' : 'mismatch',
      reason: entry.reason || '',
      t: entry.t || Date.now()
    };
    _verifiedResultsCache.set(String(txId), normalized);
    if (!ctxOk()) return;
    try {
      chrome.storage.local.get(['tmVerifiedResults'], res => {
        const obj = res?.tmVerifiedResults && typeof res.tmVerifiedResults === 'object' ? { ...res.tmVerifiedResults } : {};
        obj[String(txId)] = normalized;
        const keys = Object.keys(obj);
        if (keys.length > 500) {
          keys.sort((a, b) => (obj[a]?.t || 0) - (obj[b]?.t || 0));
          for (let i = 0; i < keys.length - 500; i++) delete obj[keys[i]];
        }
        chrome.storage.local.set({ tmVerifiedResults: obj }, () => { void chrome.runtime.lastError; });
      });
    } catch (_) {}
  }

  function lookupVerifiedResult(txId) {
    if (!txId) return null;
    const key = String(txId).trim();
    if (_verifiedResultsCache.has(key)) return _verifiedResultsCache.get(key);
    for (const [k, v] of _verifiedResultsCache) {
      if (k.startsWith(key.slice(0, 15)) || key.startsWith(k.slice(0, 15))) return v;
    }
    return null;
  }

  function bonussmbRowHasFinalColor(row, txId) {
    if (row) {
      if (row.classList.contains(ROW_OK) || row.classList.contains(ROW_ERR)) return true;
      if (isGreenRow(row)) return true;
      if (Array.from(row.classList).some(c => c.includes('red') || c.startsWith('bg-red'))) return true;
      const style = row.getAttribute('style') || '';
      if (/rgb\s*\(\s*2[0-5][0-9]\s*,\s*[0-9]{1,2}\s*,\s*[0-9]{1,2}/.test(style)) return true;
    }
    const col = rowColorMap.get(txId);
    return col === COLOR.OK || col === COLOR.ERR || col === COLOR.APPROVE || col === COLOR.REJECT
      || col === '#00c853' || col === '#d50000' || col === '#b71c1c';
  }

  function applyVerifiedResultToRow(data, row, verified) {
    const { txId, userId } = data;
    const isApprove = verified.isApprove === true;
    const reason = verified.reason || (isApprove ? '' : 'kode tiket tidak di temukan');
    LOG(`[HASIL-SYNC] ${txId} web tanpa warna — pulihkan dari tabel hasil (${verified.status})`);
    if (_completedTx.has(txId)) { _completedTx.delete(txId); persistCompletedTx(); }
    if (_ignoredTx.has(txId)) { _ignoredTx.delete(txId); persistIgnoredTx(); }
    _doneTxIds.delete(txId);
    if (retryQueue.has(txId)) { retryQueue.delete(txId); activeWorkers.delete(txId); }
    const logItem = {
      situs: _situs, userId: _san(userId, 100), txId,
      betExpected: data?.betting || '0', betActual: _sanNum(data?.betting, 0),
      scExpected: data?.scatter || '0', scActual: _sanNum(data?.scatter, 0),
      status: isApprove ? 'SESUAI' : 'TIDAK_SESUAI'
    };
    const rqItem = { txId, userId: _san(userId, 100), isApprove, rejectReason: reason, _raw: null, _log: logItem, retryCount: 0 };
    commitFinalVerdict(txId, isApprove, reason, null, rqItem);
    persistVerifiedResult(txId, { userId, isApprove, reason, t: verified.t || Date.now() });
    LOG(`[BATCH-QUEUE] ${txId} dari tabel hasil — antrian batch ${isApprove ? 'approve' : 'reject'}`);
    tryDrainBatch();
    return true;
  }

  function reconcileFromResultsTable(rows, colMap) {
    let synced = 0;
    for (const row of rows) {
      const data = extractTicketData(row, colMap);
      if (!data || (data.status !== 'PENDING' && data.status !== 'WAITING')) continue;
      const txId = data.txId;
      if (!txId || pendingDecisionMap.has(txId)) continue;
      if (bonussmbRowHasFinalColor(row, txId)) continue;
      if (retryQueue.has(txId) || activeWorkers.has(txId)) continue;
      const verified = lookupVerifiedResult(txId);
      if (!verified || (verified.isApprove !== true && verified.isApprove !== false)) continue;
      if (verified.isApprove === false && isPrematureRejectReason(verified.reason)) continue;
      if (applyVerifiedResultToRow(data, row, verified)) synced++;
    }
    return synced;
  }

  function syncHighlightsFromStorage() {
    if (!ctxOk()) return;
    chrome.storage.local.get(['marwanResults', 'tmVerifiedResults'], res => {
      if (chrome.runtime.lastError) return;
      rebuildVerifiedResultsCache(res);
      const results = Array.isArray(res?.marwanResults) ? res.marwanResults : [];
      for (const r of results) {
        const txId = String(r.transactionId || '').trim();
        if (!txId) continue;
        const isFail = (() => {
          const t = String(r.scatterTitle || '').toLowerCase();
          return t.includes('gagal') || t.includes('❌') || t.startsWith('error') || t.includes('tidak ditemukan');
        })();
        if (!rowColorMap.has(txId)) rowColorMap.set(txId, isFail ? COLOR.ERR : COLOR.OK);
      }
      reapplyAllRowColors();
    });
  }

  function startColorReapplyLoop() {
    if (colorReapplyInterval) return;
    colorReapplyInterval = setInterval(() => {
      if (!ctxOk()) { clearInterval(colorReapplyInterval); colorReapplyInterval = null; return; }
      if (isExecuting || isProcessingAutomation) return;
      reapplyAllRowColors();
    }, 700);
  }

  function flushColorsNow() {
    if (persistColorTimer) { clearTimeout(persistColorTimer); persistColorTimer = null; }
    const obj = {};
    rowColorMap.forEach((v, k) => { obj[k] = { color: v, t: Date.now() }; });
    try { chrome.storage.local.set({ ticketsUiRowColors: obj }, () => { void chrome.runtime.lastError; }); } catch (_) {}
    mirrorDecisionsToSession();
  }

  function persistDecisionsNow() {
    mirrorDecisionsToSession();
    if (!ctxOk()) return;
    const obj = {};
    pendingDecisionMap.forEach((v, k) => { obj[k] = v; });
    const colors = {};
    rowColorMap.forEach((v, k) => { colors[k] = { color: v, t: Date.now() }; });
    try { chrome.storage.local.set({ ticketsUiDecisions: obj, ticketsUiRowColors: colors }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  }

  function persistResultQueue() {
    if (!ctxOk()) return;
    try {
      if (resultQueue.length === 0) {
        chrome.storage.local.remove('tmResultQueue', () => { void chrome.runtime.lastError; });
        return;
      }
      const arr = resultQueue.map(item => ({
        txId: item.txId, userId: item.userId || '', isApprove: item.isApprove,
        rejectReason: item.rejectReason || '', _raw: item._raw || null, _log: item._log || null, retryCount: item.retryCount || 0
      }));
      chrome.storage.local.set({ tmResultQueue: arr }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  let _resultQueueHydrated = false;
  function loadResultQueue() {
    if (!ctxOk() || _resultQueueHydrated) return;
    _resultQueueHydrated = true;
    try {
      chrome.storage.local.get(['tmResultQueue'], res => {
        if (chrome.runtime.lastError) return;
        const arr = res?.tmResultQueue || [];
        if (!arr.length) return;
        let loaded = 0;
        for (const item of arr) {
          if (!item?.txId || resultQueue.some(i => i.txId === item.txId)) continue;
          if (_doneTxIds.get(item.txId) === 'APPROVE' || _doneTxIds.get(item.txId) === 'REJECT') continue;
          resultQueue.push(item);
          loaded++;
        }
        if (loaded > 0) {
          LOG(`[ResultQueue] Restored ${loaded} item ke antrian batch`);
          schedulePersistAll();
          if (!isExecuting) tryDrainBatch();
        } else {
          chrome.storage.local.remove('tmResultQueue', () => { void chrome.runtime.lastError; });
        }
      });
    } catch (_) {}
  }

  function recoverPendingWorkAfterLoad() {
    if (!ctxOk()) return;
    purgeStaleCompletedState();
    loadResultQueue();
    reapplyAllRowColors();
    const colMap = buildColMap();
    let recovered = 0;
    for (const row of getRows()) {
      const data = extractTicketData(row, colMap);
      if (!data || (data.status !== 'PENDING' && data.status !== 'WAITING')) continue;
      const txId = data.txId;
      if (!txId) continue;
      if (_doneTxIds.get(txId) === 'APPROVE' || _doneTxIds.get(txId) === 'REJECT') continue;
      const dec = pendingDecisionMap.get(txId);
      if (!dec || (dec.isApprove !== true && dec.isApprove !== false)) continue;
      if (retryQueue.has(txId)) {
        retryQueue.delete(txId);
        activeWorkers.delete(txId);
      }
      if (!resultQueue.some(i => i.txId === txId)) {
        LOG(`[RELOAD-RECOVER] ${txId} keputusan tersimpan (${dec.isApprove ? 'SESUAI' : 'REJECT'}) — pulihkan antrian batch`);
        _pushRQ({ txId, userId: data.userId || '', isApprove: dec.isApprove, rejectReason: dec.reason || '', _raw: dec._raw || null, _log: dec._log || null, retryCount: 0 });
        recovered++;
      }
      if (dec.color) applyColor(row, dec.color, txId);
    }
    if (recovered > 0) {
      LOG(`[RELOAD-RECOVER] Total ${recovered} tiket dipulihkan ke antrian batch`);
      schedulePersistAll();
      if (!isExecuting) tryDrainBatch();
    }
    const synced = reconcileFromResultsTable(getRows(), colMap);
    if (synced > 0) {
      LOG(`[HASIL-SYNC] ${synced} tiket dipulihkan dari tabel hasil bot`);
      schedulePersistAll();
      if (!isExecuting) tryDrainBatch();
    }
    if (retryQueue.size > 0) processQueue();
  }

  function getRowCheckbox(row) {
    if (!row) return null;
    if (row.cells && row.cells[0]) {
      let cb = row.cells[0].querySelector('button[role="checkbox"], input[type="checkbox"], [aria-checked], [data-state]');
      if (!cb) {
        cb = row.cells[0].querySelector('.check, [class*="checkbox"], [class*="check"], [class*="select"], button, label, a');
        const all = row.cells[0].querySelectorAll('button, label, a, div');
        for (const el of all) {
          const cls = ((el.className || '') + ' ' + (el.getAttribute('role') || '')).toLowerCase();
          if (cls.includes('check') || cls.includes('checkbox') || cls.includes('select')) { cb = el; break; }
        }
      }
      if (!cb && row.cells[0].children.length === 1) cb = row.cells[0].children[0];
      if (cb) return cb.tagName === 'INPUT' ? cb : (cb.closest('button') || cb);
    }
    const allChildren = row.cells && row.cells[0] ? Array.from(row.cells[0].querySelectorAll('*')) : [];
    for (const el of allChildren) {
      if (el.tagName === 'INPUT' || el.getAttribute('role') === 'checkbox') return el;
      if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked') return el;
      const cls = ((el.className || '') + ' ' + (el.getAttribute('role') || '')).toLowerCase();
      if (cls.includes('checkbox') || cls.includes('select') || cls.includes('check')) return el;
    }
    return null;
  }

  function isCheckboxChecked(cb) {
    if (!cb) return false;
    if (cb.tagName === 'INPUT') return !!cb.checked;
    return cb.getAttribute('aria-checked') === 'true' || cb.getAttribute('data-state') === 'checked';
  }

  async function forceCheckboxChecked(cb) {
    if (!cb || isCheckboxChecked(cb)) return true;
    await megaClick(cb, 5);
    await tmSleep(CFG.BATCH_CB + 20);
    return isCheckboxChecked(cb);
  }

  function isGreenRow(tr) {
    if (tr.classList.contains(ROW_OK)) return true;
    if (Array.from(tr.classList).some(c => c === 'bg-green' || c.startsWith('bg-green-'))) return true;
    const style = tr.getAttribute('style');
    if (style && style.includes('green')) return true;
    const bgCol = window.getComputedStyle(tr).backgroundColor;
    if (!bgCol || !bgCol.startsWith('rgb')) return false;
    const parts = bgCol.match(/\d+/g);
    if (parts && parts.length >= 3) {
      const r = parseInt(parts[0]), g = parseInt(parts[1]), b = parseInt(parts[2]);
      return (g > r + 20) && (g > b + 20) && g > 100;
    }
    return false;
  }

  function getRowActionCell(row) {
    return row?.cells ? row.cells[1] || row.querySelector('td:nth-child(2)') : null;
  }

  function svgToClickable(svg) {
    if (!svg) return null;
    return svg.closest('button') || svg.closest('[role="button"]') || svg;
  }

  function findFloatingBulkAction(kind) {
    const roots = Array.from(document.querySelectorAll('motion-div, div, nav, span')).filter(el => {
      if (!isLikelyVisible(el)) return false;
      const hasUp = el.querySelector('svg.lucide-thumbs-up, svg[class*="thumbs-up"]');
      const hasDown = el.querySelector('svg.lucide-thumbs-down, svg[class*="thumbs-down"]');
      if (!hasUp && !hasDown) return false;
      if (el.closest('thead') || el.closest('tbody tr')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 20 && r.width < 400;
    });
    for (const root of roots) {
      const map = { approve: 'svg.lucide-thumbs-up.text-green-600, svg.lucide-thumbs-up, svg[class*="thumbs-up"], svg.lucide-list-checks', reject: 'svg.lucide-thumbs-down.text-red-600, svg.lucide-thumbs-down, svg[class*="thumbs-down"]', process: 'svg.lucide-list-check.text-\\[#fdc700\\], svg.lucide-list-check, svg.lucide-list, svg.lucide-clipboard-list' };
      const hit = root.querySelector(map[kind]);
      if (hit) return svgToClickable(hit);
    }
    return null;
  }

  function getTicketsTheadRow() {
    const tbody = getTicketsTbody();
    const table = tbody && tbody.closest('table');
    return table ? table.querySelector('thead tr') : document.querySelector('main table thead tr');
  }

  function getTheadActionTh() {
    const tr = getTicketsTheadRow();
    if (!tr) return null;
    const ths = Array.from(tr.querySelectorAll('th'));
    for (const th of ths) {
      if (th.querySelector('svg.lucide-thumbs-up.text-green-600, svg.lucide-thumbs-up, svg.lucide-thumbs-down.text-red-600, svg.lucide-thumbs-down, svg[class*="thumbs-up"], svg[class*="thumbs-down"], svg.lucide-list-checks, svg.lucide-list-check.text-\\[#fdc700\\], svg.lucide-list-check, div > div > svg')) return th;
    }
    return ths[1] || ths[0];
  }

  const SEL_MAP = { approve: 'svg.lucide-thumbs-up.text-green-600, svg.lucide-thumbs-up, svg[class*="thumbs-up"], svg.lucide-list-checks', reject: 'svg.lucide-thumbs-down.text-red-600, svg.lucide-thumbs-down, svg[class*="thumbs-down"]', process: 'svg.lucide-list-check.text-\\[#fdc700\\], svg.lucide-list-check, svg.lucide-list, svg.lucide-clipboard-list' };

  function findTheadBulkAction(kind) {
    const actionTh = getTheadActionTh();
    const thead = getTicketsTheadRow();
    const sel = SEL_MAP;
    if (actionTh) {
      const hit = actionTh.querySelector(sel[kind]);
      if (hit) return svgToClickable(hit);
    }
    if (thead) {
      const hit = Array.from(thead.querySelectorAll(sel[kind])).find(x => !x.closest('tbody'));
      if (hit) return svgToClickable(hit);
    }
    return findFloatingBulkAction(kind);
  }

  function findBulkAction(kind, row) {
    for (const fn of [
      () => findTheadActionSvg(kind),
      () => findFloatingBulkAction(kind),
      () => findTheadBulkAction(kind),
      () => {
        const cell = getRowActionCell(row);
        if (!cell) return null;
        const svg = cell.querySelector(SEL_MAP[kind]);
        return svg ? svgToClickable(svg) : null;
      }
    ]) {
      const el = fn();
      if (el && isLikelyVisible(el)) return el;
    }
    return null;
  }

  async function waitForBulkAction(kind, row, timeoutMs) {
    return waitUntilTrue(() => findBulkAction(kind, row), timeoutMs || 6000, document.body, { childList: true, subtree: true, attributes: true });
  }

  function findYellowListCheck() {
    const svg = document.querySelector('svg.lucide-list-check.text-\\[#fdc700\\]');
    if (svg) return svg.closest('button') || svg;
    const all = Array.from(document.querySelectorAll('svg.lucide-list-check')).filter(s => {
      const cls = s.getAttribute('class') || '';
      return cls.includes('#fdc700') || cls.includes('fdc700');
    });
    if (all.length) { const s = all[0]; return s.closest('button') || s; }
    return findTheadBulkAction('process');
  }

  function findTheadActionSvg(kind) {
    const sel = kind === 'approve' ? 'svg.lucide-thumbs-up' : 'svg.lucide-thumbs-down';
    const colorCls = kind === 'approve' ? 'text-green-600' : 'text-red-600';
    const idx = kind === 'approve' ? 1 : 2;
    const xpPath = `/html/body/div/div/main/div/div[4]/div[2]/div/table/thead/tr/th[1]/div/div/svg[${idx}]`;
    try {
      const byXp = document.evaluate(xpPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (byXp && byXp.matches?.(sel)) return svgToClickable(byXp);
    } catch (_) {}
    const inThead = document.querySelector(`thead ${sel}.${colorCls}, thead ${sel}`);
    if (inThead) return svgToClickable(inThead);
    const theadRow = getTicketsTheadRow();
    if (theadRow) {
      const allSvg = Array.from(theadRow.querySelectorAll(`div > div > svg, th ${sel}`));
      const hit = kind === 'approve' ? allSvg[0] : allSvg[1];
      if (hit) return svgToClickable(hit);
    }
    return null;
  }

  function getActionBadge(row) {
    if (!row || !row.cells) return null;
    const cm = buildColMap();
    const kodeIdx = (cm && cm.kode >= 0) ? cm.kode : 2;
    const userIdx = (cm && cm.userId >= 0) ? cm.userId : 3;
    const prio = [row.cells[kodeIdx], row.cells[userIdx]].filter(Boolean);
    const rest = Array.from(row.cells).filter(c => c !== prio[0] && c !== prio[1]);
    let hasCheck = false, hasX = false;
    const scanCell = (cell) => {
      const svgs = cell.querySelectorAll('svg');
      for (let i = 0; i < svgs.length; i++) {
        const c = svgs[i].getAttribute('class') || '';
        if (c.indexOf('lucide-badge-check') > -1 && (c.indexOf('text-green') > -1 || c.indexOf('text-emerald') > -1 || c.indexOf('text-success') > -1)) hasCheck = true;
        if (c.indexOf('lucide-badge-x') > -1 && (c.indexOf('text-red') > -1 || c.indexOf('text-destructive') > -1 || c.indexOf('destructive') > -1 || c.indexOf('text-danger') > -1)) hasX = true;
        if ((c.indexOf('lucide-x-circle') > -1 || c.indexOf('circle-x') > -1 || c.indexOf('x-circle') > -1) && (c.indexOf('text-red') > -1 || c.indexOf('text-destructive') > -1 || c.indexOf('destructive') > -1)) hasX = true;
      }
      const bx = cell.querySelector('svg.lucide-badge-x, svg.lucide-x-circle, [class*="circle-x"], [class*="x-circle"]');
      if (bx) {
        const sc = (bx.getAttribute('class')) || '';
        const redish = sc.indexOf('text-red') > -1 || sc.indexOf('text-destructive') > -1 || sc.indexOf('destructive') > -1 || sc.indexOf('text-danger') > -1;
        const fill = (bx.getAttribute('fill') || '').toLowerCase();
        const stroke = (bx.getAttribute('stroke') || '').toLowerCase();
        if (redish || fill.includes('red') || stroke.includes('red') || fill === '#ef4444' || fill === '#dc2626' || stroke === '#ef4444' || stroke === '#dc2626') hasX = true;
      }
    };
    for (const cell of prio) scanCell(cell);
    if (hasX) return 'x';
    for (const cell of rest) scanCell(cell);
    if (hasX) return 'x';
    if (hasCheck) return 'check';
    return null;
  }

  function isAnyBlockingDialogOpen() {
    return !!document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
  }

  async function ensureNoBlockingDialog() {
    if (!isAnyBlockingDialogOpen()) return;
    await pressEscapeBurst(2, 18);
    if (isAnyBlockingDialogOpen()) await pressEscapeBurst(2, 20);
  }

  async function waitModalGone(maxMs) {
    const deadline = Date.now() + (maxMs || CFG.POST_ESC + 3000);
    while (Date.now() < deadline) {
      if (!isAnyBlockingDialogOpen()) return true;
      await tmSleep(60);
    }
    await pressEscapeBurst(2, 40);
    return !isAnyBlockingDialogOpen();
  }

  function findRejectTextarea() {
    const prim = xp('/html/body/div[3]/div[1]/div/div[3]/textarea') || xp('/html/body/div[4]/div[1]/div/div[3]/textarea');
    if (prim && isLikelyVisible(prim)) return prim;
    const bodyDivs = Array.from(document.body.children).filter(el => el.tagName === 'DIV');
    for (const div of bodyDivs.slice(-8).reverse()) {
      const ta = div.querySelector('textarea');
      if (ta && (isLikelyVisible(ta) || ta.tagName === 'TEXTAREA')) return ta;
    }
    for (let i = 2; i <= 10; i++) {
      for (let j = 1; j <= 3; j++) {
        for (const v of [`/html/body/div[${i}]/div[${j}]/div/div[3]/textarea`, `/html/body/div[${i}]/div[${j}]/div/div[2]/textarea`, `/html/body/div[${i}]/div[${j}]/div/textarea`]) {
          const el = xp(v);
          if (el && el.tagName === 'TEXTAREA') return el;
        }
      }
    }
    return document.querySelector('div[role="dialog"] textarea, [class*="modal"] textarea, body > div textarea, textarea');
  }

  function findConfirmBtn() {
    for (let i = 2; i <= 10; i++) {
      const b = xp(`/html/body/div[${i}]/div[2]/button[2]`) || xp(`/html/body/div[${i}]/div[1]/button[2]`);
      if (b && isLikelyVisible(b)) return b;
    }
    const bodyDivs = Array.from(document.body.children).filter(el => el.tagName === 'DIV');
    for (const div of bodyDivs.slice(-6).reverse()) {
      const btns = Array.from(div.querySelectorAll('button')).filter(isLikelyVisible);
      if (btns.length >= 2) return btns[1];
      if (btns.length === 1 && /konfirm|setuju|approve|^ya$|yes|iya|^ok$|lanjut|submit/i.test(btns[0].textContent.trim())) return btns[0];
    }
    return Array.from(document.querySelectorAll('button')).filter(isLikelyVisible)
      .find(b => (b.textContent || '').includes('Ya, Setujui') || /konfirm|setuju|approve|^ya$|yes|iya|^ok$|lanjut|submit/i.test(b.textContent.trim())) || null;
  }

  function findRejectConfirmBtn() {
    return Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && (b.textContent || '').includes('Ya, Tolak')) || findConfirmBtn();
  }

  function waitRejectTextarea(timeoutMs) {
    return waitUntilTrue(findRejectTextarea, timeoutMs || CFG.DIALOG_WAIT, document.body, { childList: true, subtree: true, attributes: true });
  }

  function waitConfirmBtn(timeoutMs) {
    return waitUntilTrue(findConfirmBtn, timeoutMs || CFG.CONFIRM_WAIT, document.body, { childList: true, subtree: true, attributes: true });
  }

  function enqueueTicket(data) {
    if (!data || typeof data !== 'object') return;
    const txId = String(data?.txId || '').trim();
    if (!txId) return;
    if (_doneTxIds.has(txId)) { LOG(`[ENQ-DONE] ${txId} skip — already done`); return; }
    if (_completedTx.has(txId)) { LOG(`[ENQ-COMPLETED] ${txId} skip — already processed`); return; }
    if (_ignoredTx.has(txId)) { LOG(`[ENQ-IGNORED] ${txId} skip — ignored`); return; }
    if (resultQueue.some(i => i.txId === txId)) return;
    const row = findRowByTxId(txId);
    if (row && !validateRowForTxId(row, txId)) {
      WARN(`[GUARD] enqueueTicket: row mismatch untuk ${txId} — mencari row yang benar`);
      let fixedRow = null;
      for (const rr of getRows()) {
        const d = extractTicketData(rr, buildColMap());
        if (d && d.txId === txId) { fixedRow = rr; break; }
      }
      if (fixedRow) {
        const cm = buildColMap();
        const correctData = extractTicketData(fixedRow, cm);
        if (correctData) {
          data.userId = correctData.userId || data.userId;
          data.betting = correctData.betting || data.betting;
          data.scatter = correctData.scatter || data.scatter;
          data.hadiah = correctData.hadiah || data.hadiah;
          data.status = correctData.status || data.status;
        }
      }
    }
    const existing = retryQueue.get(txId);
    if (existing) {
      if (existing.finalStatus === 'APPROVE' || existing.finalStatus === 'REJECT') return;
      Object.assign(existing, data, { updatedAt: Date.now() });
      applyPendingColorByTxId(txId);
      return;
    }
    retryQueue.set(txId, {
      txId, userId: data.userId || '', betting: data.betting || '',
      scatter: data.scatter || '', hadiah: data.hadiah || '', status: data.status || '',
      retryCount: 0, processing: false, success: false,
      nextRetry: 0, lastError: null, addedAt: Date.now(), updatedAt: Date.now()
    });
    persistRetryQueue();
    applyPendingColorByTxId(txId);
    schedulePersistAll();
    processQueue();
  }

  function processQueue() {
    if (!ctxOk()) return;
    if (!isAutoMode()) return;
    const now = Date.now();
    for (const [txId, state] of retryQueue) {
      if (state.processing && state.updatedAt && now - state.updatedAt > 120000) {
        WARN(`Worker ${txId} stale >120s — release`);
        state.processing = false; state.nextRetry = now + 300;
        activeWorkers.delete(txId);
        if (activeWorkers.size === 0 && resultQueue.length > 0) tryDrainBatch();
      }
    }
    for (const [txId, state] of retryQueue) {
      if (activeWorkers.size >= CFG.MAX_WORKERS) break;
      if (state.success) { retryQueue.delete(txId); continue; }
      if (state.processing || state.nextRetry > now) continue;
      activeWorkers.add(txId);
      state.updatedAt = Date.now();
      runTicketWorker(txId);
    }
  }

  async function runTicketWorker(txId) {
    const state = retryQueue.get(txId);
    if (!state) { activeWorkers.delete(txId); if (activeWorkers.size === 0 && resultQueue.length > 0) tryDrainBatch(); return; }
    if (state.isApprove === true || state.isApprove === false) {
      if (state.isApprove === false && isPrematureRejectReason(state.rejectReason)) {
        delete state.isApprove;
        delete state.rejectReason;
        delete state._raw;
        delete state._log;
        clearPersistedDecision(txId);
        const row = findRowByTxId(txId);
        if (row) applyColor(row, COLOR.PEND, txId);
        LOG(`[RE-CHECK worker] ${txId} reject prematur — verifikasi ulang via API`);
      } else {
        activeWorkers.delete(txId);
        retryQueue.delete(txId);
        const row = findRowByTxId(txId);
        if (state.isApprove === true && row && getActionBadge(row) === 'x') {
          WARN(`[NO-APPROVE worker] ${txId} red-X + keputusan approve — dibiarkan tanpa aksi (IGNORE)`);
          markSesuaiIgnore(txId, state._raw || null);
        } else {
          _pushRQ({ txId, userId: state.userId || '', isApprove: state.isApprove, rejectReason: state.rejectReason || '', _raw: state._raw || null, _log: state._log || null, retryCount: state.retryCount || 0 });
        }
        if (!isExecuting) tryDrainBatch();
        processQueue();
        return;
      }
    }
    state.processing = true; state.retryCount++; state.updatedAt = Date.now();
    if (state.finalStatus === undefined) state.finalStatus = null;
    const row = findRowByTxId(txId);
    if (row) applyColor(row, COLOR.PEND, txId);
    try {
      const resp = await trySendVerify(state, row);
      if (!resp || resp.status === 'error') {
        state.lastError = resp?.reason || 'no response';
        state.processing = false; state.nextRetry = Date.now() + 300;
        activeWorkers.delete(txId); if (activeWorkers.size === 0 && resultQueue.length > 0) tryDrainBatch(); processQueue(); return;
      }
      if (resp.status === 'in_db' || resp.status === 'already_done') {
        state.success = true; retryQueue.delete(txId);
        activeWorkers.delete(txId);
        const finishRow = findRowByTxId(txId);
        if (finishRow) applyColor(finishRow, COLOR.DONE, txId);
        _completedTx.set(txId, { status: 'DONE', userId: state.userId || '', t: Date.now() }); persistCompletedTx();
        if (activeWorkers.size === 0 && resultQueue.length > 0) tryDrainBatch();
        processQueue(); return;
      }
      if (resp.status === 'queued') {
        if (state) { state.processing = false; state.nextRetry = Date.now() + 60000; state.updatedAt = Date.now(); }
        activeWorkers.delete(txId);
        if (activeWorkers.size === 0 && resultQueue.length > 0) tryDrainBatch();
        return;
      }
      if (resp.status === 'in_progress') return;
      state.processing = false; state.nextRetry = Date.now() + 300;
      activeWorkers.delete(txId);
      if (activeWorkers.size === 0 && resultQueue.length > 0) tryDrainBatch();
      processQueue();
    } catch (err) {
      state.lastError = err.message;
      state.processing = false; state.nextRetry = Date.now() + 300;
      activeWorkers.delete(txId);
      if (activeWorkers.size === 0 && resultQueue.length > 0) tryDrainBatch();
      processQueue();
    }
  }

  function trySendVerify(state, row) {
    return new Promise(resolve => {
      var timed = false;
      var timer = setTimeout(function () { timed = true; resolve({ status: 'error', reason: 'timeout 95s' }); }, 95000);
      try {
        chrome.runtime.sendMessage({
          action: 'verifyBonusTicket',
          ticketData: { userId: state.userId, transactionId: state.txId, betting: state.betting, scatterCount: state.scatter, hadiah: state.hadiah, status: state.status }
        }, function (resp) {
          if (timed) return;
          clearTimeout(timer);
          resolve(resp || { status: 'error', reason: chrome.runtime.lastError?.message || 'no response' });
        });
      } catch (e) { if (!timed) { clearTimeout(timer); resolve({ status: 'error', reason: e.message }); } }
    });
  }


  function applyPendingColorByTxId(txId) {
    if (resultQueue.some(i => i.txId === txId)) return;
    const dec = pendingDecisionMap.get(txId);
    const row = findRowByTxId(txId);
    if (!row) return;
    if (dec && (dec.isApprove === true || dec.isApprove === false) && dec.color) {
      applyColor(row, dec.color, txId);
      return;
    }
    applyColor(row, COLOR.PEND, txId);
  }

  function countPendingTicketsInTable() {
    const colMap = buildColMap();
    let n = 0;
    for (const row of getRows()) {
      const data = extractTicketData(row, colMap);
      if (data && (data.status === 'PENDING' || data.status === 'WAITING')) n++;
    }
    return n;
  }

  function shouldApproveFromResult(msg) {
    const overall = String(msg?.overallStatus || '').toUpperCase().trim();
    const bet = String(msg?.betCheckStatus || '').toUpperCase().trim();
    const sc = String(msg?.scatterCheckStatus || '').toUpperCase().trim();
    const had = String(msg?.hadiahStatus || '').toUpperCase().trim();
    const title = String(msg?.scatterTitle || '').toLowerCase();
    const titleRaw = String(msg?.scatterTitle || '');
    if (title.includes('session timeout') || (title.includes('timeout') && !title.includes('menunggu')) || overall.includes('TIMEOUT')) return 'SESSION_TIMEOUT';
    if (overall === 'RETRY' || title.includes('detail_processor') || title.includes('tidak merespons') || title.includes('error detail') || title.includes('tab detail tidak') || title.includes('content script')) return 'RETRY';
    if (title.includes('belum siap') || title.includes('belum tersedia') || title.includes('data mungkin belum')) return 'RETRY';
    const scatterNum = parseInt(String(msg?.scatterTitle || '').replace(/[^0-9]/g, ''), 10);
    const scatterIsValid = scatterNum >= 3 && scatterNum <= 5;
    if (title.includes('tidak ditemukan') || title.includes('no_data') || title.includes('no data') ||
        title.includes('userId berbeda') ||
        title.includes('error') || title === '' || title === '0') return false;
    if (!isNaN(scatterNum) && scatterNum > 0 && !scatterIsValid) {
      WARN && WARN(`[GUARD] Scatter ${scatterNum} di luar range 3-5 — paksa REJECT`);
      return false;
    }
    if (overall.includes('TIDAK') || bet.includes('TIDAK') || sc.includes('TIDAK') || had.includes('TIDAK') || had.includes('NOT')) return false;
    if (overall === 'SESUAI' && scatterIsValid) return true;
    return false;
  }

  function buildRejectReason(betCheckStatus, scatterCheckStatus, hadiahStatus, debetValue, scatterTitle, expectedPrize) {
    const st = String(scatterTitle || '').toUpperCase();
    if (st.includes('NO_DATA') || String(scatterTitle || '').toLowerCase().includes('no data') || String(scatterTitle || '').toLowerCase().includes('userId berbeda')) return 'userId berbeda benar sedikit bos';
    const parts = [];
    if (betCheckStatus === 'TIDAK_SESUAI') parts.push(`Bet tidak sesuai (admin: ${debetValue || 'N/A'})`);
    if (scatterCheckStatus === 'TIDAK_SESUAI') parts.push(`Scatter tidak sesuai (ditemukan: ${scatterTitle || 'N/A'})`);
    if (hadiahStatus && hadiahStatus !== 'VALID' && hadiahStatus !== 'SKIP') parts.push(`Hadiah tidak sesuai (seharusnya: ${expectedPrize || 'N/A'})`);
    if (!parts.length) parts.push(`Verifikasi gagal: ${scatterTitle || 'data tidak cocok'}`);
    return parts.join('; ');
  }

  function confirmDecisionSafe(item) {
    if (!item) return item;
    const row = findRowByTxId(item.txId);
    if (item.isApprove === true && row && getActionBadge(row) === 'x') {
      WARN(`[NO-APPROVE confirmDecisionSafe] ${item.txId} red-X + keputusan approve — dibatalkan, dibiarkan (IGNORE)`);
      return { ...item, isApprove: 'IGNORE', rejectReason: '' };
    }
    if (!item._raw) return item;
    const d = shouldApproveFromResult(item._raw);
    if (d === 'SESSION_TIMEOUT') return { ...item, isApprove: 'SESSION_TIMEOUT' };
    if (item.isApprove === 'IGNORE') return item;
    if (d === true && row && getActionBadge(row) === 'x') {
      WARN(`[NO-APPROVE confirmDecisionSafe] ${item.txId} red-X + SESUAI — approve dilarang, dibiarkan (IGNORE)`);
      return { ...item, isApprove: 'IGNORE', rejectReason: '' };
    }
    const safeApprove = d === true;
    if (safeApprove !== item.isApprove) {
      WARN(`Koreksi keputusan ${item.txId}: ${item.isApprove} → ${safeApprove}`);
      return { ...item, isApprove: safeApprove, rejectReason: safeApprove ? '' : buildRejectReason(item._raw.betCheckStatus, item._raw.scatterCheckStatus, item._raw.hadiahStatus, item._raw.debetValue, item._raw.scatterTitle, item._raw.expectedPrize) };
    }
    return item;
  }

  async function batchClickCheckboxes(entries) {
    try {
    LOG(`Centang ${entries.length} baris...`);
    for (const entry of entries) {
      const txId = entry.txId;
      if (!txId) continue;
      let freshRow = findRowByTxId(txId);
      if (!freshRow) { try { window.scrollBy(0, 50); await tmSleep(40); window.scrollBy(0, -50); } catch (_) {} freshRow = findRowByTxId(txId); }
      if (!freshRow) {
        try { const tbody = getTicketsTbody(); if (tbody) tbody.scrollIntoView({ behavior: 'instant', block: 'nearest' }); } catch (_) {}
        await tmSleep(80);
        freshRow = findRowByTxId(txId);
      }
      if (!freshRow) {
        WARN(`[CB] Row tidak ditemukan: ${txId}`);
        if (!missingFromPageQueue.has(txId)) {
          const existing = resultQueue.find(i => i.txId === txId);
          missingFromPageQueue.set(txId, { txId, userId: existing ? existing.userId || '' : '', isApprove: existing ? existing.isApprove : null, rejectReason: existing ? existing.rejectReason : '', _raw: existing ? existing._raw : null, addedAt: Date.now(), retryCount: 0 });
          persistMissingQueue();
        }
        continue;
      }
      entry.row = freshRow;
      const cb = getRowCheckbox(freshRow);
      if (!cb) { WARN(`[CB] Checkbox tidak ditemukan: ${txId}`); continue; }
      await forceCheckboxChecked(cb);
      await tmSleep(CFG.CB_INTER_CLICK);
    }
    await tmSleep(CFG.CB_POSTCLICK);
    let missed = entries.filter(e => {
      const row = findRowByTxId(e.txId);
      if (!row) return true;
      e.row = row;
      const cb = getRowCheckbox(row);
      return !cb || !isCheckboxChecked(cb);
    });
    if (missed.length > 0) {
      for (let r2 = 0; r2 < 3; r2++) {
        if (missed.length === 0) break;
        LOG(`[CB] ${missed.length} re-click attempt ${r2+1}/3...`);
        await tmSleep(CFG.CB_RECHECK_WAIT);
        for (const entry of missed) {
          const row = findRowByTxId(entry.txId);
          if (!row) { continue; }
          entry.row = row;
          const cb = getRowCheckbox(row);
          if (!cb) continue;
          row.scrollIntoView({ block: 'center', behavior: 'instant' });
          await tmSleep(CFG.CB_PRECLICK_SCROLL);
          await forceCheckboxChecked(cb);
          await tmSleep(CFG.CB_INTER_CLICK);
        }
        await tmSleep(CFG.CB_RECHECK_WAIT);
        missed = missed.filter(m => {
          const r = findRowByTxId(m.txId);
          if (!r) return true;
          const c = getRowCheckbox(r);
          return !c || !isCheckboxChecked(c);
        });
      }
      if (missed.length > 0) WARN(`[CB] ${missed.length} entri tetap tidak tercentang setelah 3x retry`);
    }
    for (const entry of entries) { const r = findRowByTxId(entry.txId); if (r) entry.row = r; }
    LOG(`[CB] Selesai centang ${entries.length} entri`);
    } catch (e) { ERR('[batchClickCheckboxes] exception:', e.message); }
  }

  async function batchVerifyCheckboxes(entries) {
    try {
    let problems = entries.filter(e => e && e.txId);
    if (!problems.length) return true;
    for (let round = 0; round < CFG.CB_RECHECK_ROUNDS; round++) {
      if (problems.length === 0) break;
      if (round > 0) await tmSleep(CFG.CB_RECHECK_WAIT);
      const still = [];
      for (const entry of problems) {
        const row = findRowByTxId(entry.txId);
        if (!row) { if (round < CFG.CB_RECHECK_ROUNDS - 1) { still.push(entry); try { window.scrollBy(0, 2); window.scrollBy(0, -2); } catch (_) {} } continue; }
        entry.row = row;
        const cb = getRowCheckbox(row);
        if (!cb || !isCheckboxChecked(cb)) {
          if (cb) { row.scrollIntoView({ block: 'center', behavior: 'instant' }); await tmSleep(CFG.CB_PRECLICK_SCROLL); await forceCheckboxChecked(cb); await tmSleep(CFG.CB_POSTCLICK); }
          const cbAfter = getRowCheckbox(findRowByTxId(entry.txId) || row);
          if (!cbAfter || !isCheckboxChecked(cbAfter)) still.push(entry);
        }
      }
      problems = still;
    }
    if (problems.length > 0) WARN(`[Verify] ${problems.length} checkbox masih bermasalah`);
    return problems.length === 0;
    } catch (e) { ERR('[batchVerifyCheckboxes] exception:', e.message); return false; }
  }

  async function batchPrepareSelection(entries) {
    try {
    if (!entries.length) return false;
    const totalBefore = getShowingTotal();
    await batchClickCheckboxes(entries);
    if (!entries.length) return false;
    const totalAfter = getShowingTotal();
    if (totalBefore !== null && totalAfter !== null && totalAfter > totalBefore) {
      LOG(`Mutasi baru terdeteksi! Before: ${totalBefore}, After: ${totalAfter}`);
      const stillInPage = entries.filter(e => isTxIdInPage(e.txId));
      const pushedOut = entries.filter(e => !isTxIdInPage(e.txId));
      if (pushedOut.length > 0) {
        for (const e of pushedOut) {
          if (!missingFromPageQueue.has(e.txId)) {
            const existing = resultQueue.find(i => i.txId === e.txId);
            missingFromPageQueue.set(e.txId, { txId: e.txId, isApprove: existing ? existing.isApprove : null, rejectReason: existing ? existing.rejectReason : '', _raw: existing ? existing._raw : null, addedAt: Date.now(), retryCount: 0 });
            persistMissingQueue();
          }
        }
        entries.length = 0;
        entries.push(...stillInPage);
        if (entries.length === 0) { scheduleMissingQueueRetry(3000); return false; }
      }
    }
    if (!(await batchVerifyCheckboxes(entries))) { hardRefreshRetry('batch_verify_failed'); return false; }
    const listCheck = findYellowListCheck();
    if (listCheck) {
      await megaClick(listCheck, 3);
      await sleep(300);
      pressEscape();
      await tmSleep(CFG.POST_ESC);
      const stillHere = [];
      for (const entry of entries) {
        const freshRow = await waitForFreshRowByTxId(entry.txId, 12);
        if (freshRow) { entry.row = freshRow; stillHere.push(entry); }
      }
      entries.length = 0;
      entries.push(...stillHere);
      if (!entries.length) { hardRefreshRetry('selection_lost_after_listcheck'); return false; }
      await batchClickCheckboxes(entries);
      const verifyOk = await batchVerifyCheckboxes(entries);
      if (!verifyOk) { hardRefreshRetry('batch_verify_failed_after_listcheck'); return false; }
    }
    return true;
    } catch (e) { ERR('[batchPrepareSelection] exception:', e.message); hardRefreshRetry('batch_prepare_exception'); return false; }
  }

  async function fillRejectDialogAndConfirm(reason, expectedTxIds) {
    try {
    let textarea = await waitRejectTextarea(CFG.DIALOG_WAIT);
    if (!textarea) {
      for (let i = 0; i < 3; i++) { await tmSleep(250); textarea = findRejectTextarea(); if (textarea && isLikelyVisible(textarea)) break; }
    }
    if (!textarea || !isLikelyVisible(textarea)) { hardRefreshRetry('reject_textarea_missing'); return false; }
    fillTextarea(textarea, reason);
    await tmSleep(200);
    if (expectedTxIds && expectedTxIds.length) {
      try {
        for (const txId of expectedTxIds) {
          const row = findRowByTxId(txId) || (expectedTxIds.length === 1 ? await waitForFreshRowByTxId(txId, 5) : null);
          if (!row) continue;
          const cm = buildColMap();
          const d = extractTicketData(row, cm);
          if (d) {
            const bet0 = _sanNum(d.betting, 0) === 0;
            const sc0 = _sanNum(d.scatter, 0) === 0;
            if (bet0 || sc0) {
              await tmSleep(300);
              const d2 = extractTicketData(row, buildColMap());
              const bet = _sanNum(d2?.betting || d?.betting, 0);
              const sc = _sanNum(d2?.scatter || d?.scatter, 0);
              if (bet === 0 && sc === 0) {
                LOG(`[REJECT-DATA] ${txId}: bet=0, sc=0 setelah re-check — reject (data tiket tidak ditemukan)`);
              } else if (sc === 0) {
                LOG(`[REJECT-DATA] ${txId}: scatter=0 setelah re-check — reject (scatter tidak ditemukan)`);
              } else {
                LOG(`[REJECT-DATA] ${txId}: data valid setelah re-check (bet=${bet}, sc=${sc}) — tetap reject sesuai keputusan awal`);
              }
            }
          }
        }
      } catch (_) { WARN('[REJECT-DATA] Gagal re-verify — lanjut reject'); }
    }
    let confirmBtn = findRejectConfirmBtn();
    if (!confirmBtn) confirmBtn = await waitConfirmBtn(CFG.CONFIRM_WAIT);
    if (!confirmBtn) {
      for (let i = 0; i < 3; i++) {
        confirmBtn = Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Tolak'));
        if (confirmBtn) break;
        await tmSleep(300);
      }
    }
    if (!confirmBtn) { await pressEscapeBurst(2, 20); hardRefreshRetry('reject_confirm_missing'); return false; }
    await megaClick(confirmBtn, 2);
    await tmSleep(300);
    let still = Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Tolak'));
    if (still) {
      still.click();
      await tmSleep(300);
      still = Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Tolak'));
      if (still) {
        await pressEscapeBurst(3, 20);
        await waitModalGone(800);
        hardRefreshRetry('reject_confirm_stuck');
        return false;
      }
    }
    await waitModalGone(500);
    return true;
    } catch (e) { WARN('[fillRejectDialog] exception:', e.message); await pressEscapeBurst(2, 20); return false; }
  }

  async function fillApproveDialogAndConfirm(expectedTxIds) {
    try {
      const ids = Array.isArray(expectedTxIds) ? expectedTxIds.map(t => String(t).trim()).filter(Boolean) : [];
      if (ids.length) {
        for (const id of ids) {
          const r0 = findRowByTxId(id);
          if (r0 && getActionBadge(r0) === 'x') {
            WARN(`[CONFIRM-GUARD] ${id} badge-X muncul sebelum konfirmasi approve — batal, markSesuaiIgnore`);
            await pressEscapeBurst(3, 30);
            await waitModalGone(1200);
            markSesuaiIgnore(id, null);
            return false;
          }
        }
      }
    let confirmBtn = await waitConfirmBtn(CFG.CONFIRM_WAIT);
    if (!confirmBtn) {
      for (let i = 0; i < 2; i++) {
        confirmBtn = Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Setujui'));
        if (confirmBtn) break;
        await tmSleep(250);
      }
    }
    if (!confirmBtn) { hardRefreshRetry('approve_confirm_missing'); return false; }
      if (ids.length) {
        for (const id of ids) {
          const r1 = findRowByTxId(id);
          if (r1 && getActionBadge(r1) === 'x') {
            WARN(`[CONFIRM-GUARD] ${id} badge-X terdeteksi saat dialog approve terbuka — batal, markSesuaiIgnore`);
            await pressEscapeBurst(3, 30);
            await waitModalGone(1200);
            markSesuaiIgnore(id, null);
            return false;
          }
        }
      }
    await megaClick(confirmBtn, 3);
    await tmSleep(300);
    let still = Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Setujui'));
    if (still) {
      still.click();
      await tmSleep(300);
      still = Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Setujui'));
      if (still) {
        await pressEscapeBurst(3, 30);
        await waitModalGone(1200);
        hardRefreshRetry('approve_confirm_stuck');
        return false;
      }
    }
    await waitModalGone(1200);
    return true;
    } catch (e) { WARN('[fillApproveDialog] exception:', e.message); await pressEscapeBurst(2, 20); return false; }
  }

  async function executeSingleRejectFlow(row, txId, reason, actualBet, actualSc) {
    txId = String(txId || '').trim();
    if (!txId) return false;
    if (actionLocks.has('REJECT:' + txId)) return false;
    actionLocks.add('REJECT:' + txId);
    try {
      const r = reason || 'kode tiket tidak di temukan';
      await ensureNoBlockingDialog();
      let freshRow = await waitForFreshRowByTxId(txId, 8) || row;
      let freshUserId = '';
      if (freshRow) {
        if (!validateRowForTxId(freshRow, txId)) {
          WARN(`[GUARD] executeSingleRejectFlow: row mismatch untuk ${txId} — mencari ulang`);
          freshRow = null;
          for (const rr of getRows()) {
            const d = extractTicketData(rr, buildColMap());
            if (d && d.txId === txId) { freshRow = rr; break; }
          }
        }
        if (freshRow) { const cm = buildColMap(); const rd = extractTicketData(freshRow, cm); if (rd) freshUserId = rd.userId || ''; }
      }
      if (!freshRow) { ERR(`Single reject: row tidak ditemukan ${txId}`); if (!missingFromPageQueue.has(txId)) { missingFromPageQueue.set(txId, { txId, userId: freshUserId || '', isApprove: false, rejectReason: reason || '', _raw: null, addedAt: Date.now(), retryCount: 0 }); persistMissingQueue(); } hardRefreshRetry('single_reject_row_missing'); return false; }
      const prep = [{ txId, row: freshRow, userId: freshUserId }];
      if (!(await batchPrepareSelection(prep))) { hardRefreshRetry('single_reject_prepare_failed'); return false; }
      row = await waitForFreshRowByTxId(txId, 8) || freshRow;
      let btnReject = await waitForBulkAction('reject', row, 3000);
      if (!btnReject) btnReject = await waitForBulkAction('reject', row, 2000);
      if (!btnReject) { ERR('Reject btn tidak ada'); hardRefreshRetry('single_reject_button_missing'); return false; }
      await megaClick(btnReject, 3);
      await tmSleep(40);
      const ok = await fillRejectDialogAndConfirm(r, [txId]);
      if (ok) {
        clearPersistedDecision(txId);
        _doneTxIds.set(txId, 'REJECT');
        _completedTx.set(txId, { status: 'REJECTED', userId: freshUserId || '', t: Date.now() }); persistCompletedTx();
        const colorRow = findRowByTxId(txId) || row;
        if (colorRow && validateRowForTxId(colorRow, txId)) applyColor(colorRow, COLOR.REJECT, txId);
        sendLogResult(txId, colorRow, freshUserId, false, r, actualBet, actualSc);
        try { chrome.runtime.sendMessage({ action: 'ticketActionDone', transactionId: txId, userId: freshUserId, actionTaken: 'REJECT', rejectReason: r }, () => { void chrome.runtime.lastError; }); } catch (_) {}
        if (retryQueue.size === 0 && resultQueue.length === 0 && activeWorkers.size === 0) { clearTicketTracking(txId); }
      }
      if (!ok) hardRefreshRetry('single_reject_failed');
      return ok;
    } finally {
      actionLocks.delete('REJECT:' + txId);
    }
  }

  async function executeSingleApproveFlow(row, txId, actualBet, actualSc) {
    txId = String(txId || '').trim();
    if (!txId) return false;
    if (actionLocks.has('APPROVE:' + txId)) return false;
    actionLocks.add('APPROVE:' + txId);
    try {
      const badgeRow = findRowByTxId(txId) || row;
      if (badgeRow && getActionBadge(badgeRow) === 'x') {
        WARN(`[NO-APPROVE] ${txId} red-X — eksekusi approve dibatalkan, tiket dibiarkan tanpa aksi`);
        markSesuaiIgnore(txId, null);
        return true;
      }
      await ensureNoBlockingDialog();
      let freshRow = await waitForFreshRowByTxId(txId, 8) || row;
      let freshUserId = '';
      if (freshRow) {
        if (!validateRowForTxId(freshRow, txId)) {
          WARN(`[GUARD] executeSingleApproveFlow: row mismatch untuk ${txId} — mencari ulang`);
          freshRow = null;
          for (const rr of getRows()) {
            const d = extractTicketData(rr, buildColMap());
            if (d && d.txId === txId) { freshRow = rr; break; }
          }
        }
        if (freshRow) { const cm = buildColMap(); const rd = extractTicketData(freshRow, cm); if (rd) freshUserId = rd.userId || ''; }
      }
      if (!freshRow) { ERR(`Single approve: row tidak ditemukan ${txId}`); if (!missingFromPageQueue.has(txId)) { missingFromPageQueue.set(txId, { txId, userId: freshUserId || '', isApprove: true, rejectReason: '', _raw: null, addedAt: Date.now(), retryCount: 0 }); persistMissingQueue(); } hardRefreshRetry('single_approve_row_missing'); return false; }
      const prep = [{ txId, row: freshRow, userId: freshUserId }];
      if (!(await batchPrepareSelection(prep))) { hardRefreshRetry('single_approve_prepare_failed'); return false; }
      const rowAfterPrep = await waitForFreshRowByTxId(txId, 8) || prep[0].row;
      let btnApprove = await waitForBulkAction('approve', rowAfterPrep, 3000);
      if (!btnApprove) btnApprove = await waitForBulkAction('approve', rowAfterPrep, 2000);
      if (!btnApprove) { ERR('Approve btn tidak ada'); hardRefreshRetry('single_approve_button_missing'); return false; }
      await megaClick(btnApprove, 3);
      await tmSleep(40);
      const ok = await fillApproveDialogAndConfirm([txId]);
      if (ok) {
        clearPersistedDecision(txId);
        _doneTxIds.set(txId, 'APPROVE');
        _completedTx.set(txId, { status: 'APPROVED', userId: freshUserId || '', t: Date.now() }); persistCompletedTx();
        const colorRow = findRowByTxId(txId) || rowAfterPrep;
        if (colorRow && validateRowForTxId(colorRow, txId)) applyColor(colorRow, COLOR.APPROVE, txId);
        sendLogResult(txId, colorRow, freshUserId, true, '', actualBet, actualSc);
        try { chrome.runtime.sendMessage({ action: 'ticketActionDone', transactionId: txId, userId: freshUserId, actionTaken: 'APPROVE' }, () => { void chrome.runtime.lastError; }); } catch (_) {}
      }
      if (!ok) hardRefreshRetry('single_approve_failed');
      return ok;
    } finally {
      actionLocks.delete('APPROVE:' + txId);
    }
  }

  async function resolveRowsForItems(items) {
    const out = [];
    for (const item of items) {
      const row = item.row || await waitForRowByTxId(item.txId, 12000);
      if (row) out.push({ ...item, row });
      else { ERR('Baris tidak ditemukan:', item.txId); if (!missingFromPageQueue.has(item.txId)) { missingFromPageQueue.set(item.txId, { ...item, addedAt: Date.now(), retryCount: 0 }); persistMissingQueue(); } }
    }
    return out;
  }

  function sortItemsByRowOrder(items) {
    const tbody = getTicketsTbody();
    const allRows = tbody ? Array.from(tbody.querySelectorAll(':scope > tr')) : [];
    return items.slice().sort((a, b) => {
      const ra = a.row || findRowByTxId(a.txId);
      const rb = b.row || findRowByTxId(b.txId);
      return (ra ? allRows.indexOf(ra) : 9999) - (rb ? allRows.indexOf(rb) : 9999);
    });
  }

  async function executeBatchApprovePerRow(entries) {
    let n = 0;
    const tbody = getTicketsTbody();
    const allRows = tbody ? Array.from(tbody.querySelectorAll(':scope > tr')) : [];
    const sorted = entries.slice().sort((a, b) => {
      const ra = findRowByTxId(a.txId), rb = findRowByTxId(b.txId);
      return (ra ? allRows.indexOf(ra) : 9999) - (rb ? allRows.indexOf(rb) : 9999);
    });
    for (const item of sorted) {
      let freshRow = findRowByTxId(item.txId);
      if (!freshRow) freshRow = await waitForFreshRowByTxId(item.txId, 15);
      if (freshRow) item.row = freshRow;
      else { ERR(`[BatchApprovePerRow] Row tidak ditemukan: ${item.txId}`); if (!missingFromPageQueue.has(item.txId)) { missingFromPageQueue.set(item.txId, { ...item, addedAt: Date.now(), retryCount: 0 }); persistMissingQueue(); } continue; }
      if (await executeSingleApproveFlow(item.row, item.txId, item._log?.betActual, item._log?.scActual)) n++;
      await tmSleep(100);
    }
    if (n > 0) schedulePostActionRefresh();
    return n > 0;
  }

  async function executeBatchApprove(items) {
    if (!items.length) return true;
    const safe = sortItemsByRowOrder(items.map(confirmDecisionSafe)).filter(it => it.isApprove === true);
    LOG(`BATCH APPROVE ${safe.length} tiket`);
    const entries = [];
    for (const item of safe) {
      let freshRow = findRowByTxId(item.txId);
      if (!freshRow) {
        try {
          const tbody = getTicketsTbody();
          if (tbody) tbody.scrollIntoView({ behavior: 'instant' });
          await tmSleep(200);
          window.scrollTo(0, 0); await tmSleep(100);
          for (let s = 0; s < 100; s += 10) { window.scrollBy(0, s); await tmSleep(5); }
          window.scrollTo(0, 0); await tmSleep(100);
        } catch (_) {}
        freshRow = await waitForFreshRowByTxId(item.txId, 12);
      }
      if (freshRow) {
        if (getActionBadge(freshRow) === 'x') {
          WARN(`[NO-APPROVE] ${item.txId} red-X — dikeluarkan dari batch approve, dibiarkan`);
          markSesuaiIgnore(item.txId, item._raw || null);
          continue;
        }
        entries.push({ ...item, row: freshRow });
      }
      else { ERR(`[BatchApprove] Row tidak ditemukan: ${item.txId}`); if (!missingFromPageQueue.has(item.txId)) { missingFromPageQueue.set(item.txId, { ...item, addedAt: Date.now(), retryCount: 0 }); persistMissingQueue(); } }
    }
    if (!entries.length) { hardRefreshRetry('batch_approve_no_entries'); return false; }
    entries.sort((a, b) => {
      const allRows = (getTicketsTbody() ? Array.from(getTicketsTbody().querySelectorAll(':scope > tr')) : []);
      return (a.row ? allRows.indexOf(a.row) : 9999) - (b.row ? allRows.indexOf(b.row) : 9999);
    });
    if (!(await batchPrepareSelection(entries))) { LOG('batchPrepareSelection gagal — per baris'); hardRefreshRetry('batch_approve_prepare_failed'); return executeBatchApprovePerRow(entries); }
    let btnApprove = await waitForBulkAction('approve', entries[0]?.row, 3000);
    if (!btnApprove) { LOG('Coba approve per baris'); hardRefreshRetry('batch_approve_button_missing'); return executeBatchApprovePerRow(entries); }
    await megaClick(btnApprove, 4);
    await tmSleep(CFG.AFTER_ACTION);
    const confirmOk = await fillApproveDialogAndConfirm(entries.map(e => e.txId));
    if (!confirmOk) { pressEscape(); hardRefreshRetry('batch_approve_confirm_failed'); return executeBatchApprovePerRow(entries); }
    await tmSleep(250);
    const colMapAP = buildColMap();
    const processed = [], unprocessed = [];
    for (const entry of entries) {
      const { txId, row } = entry;
      let postRow = findRowByTxId(txId);
      for (let w = 0; w < 3 && postRow; w++) {
        const d = postRow ? extractTicketData(postRow, colMapAP) : null;
        if (d && d.status !== 'PENDING' && d.status !== 'WAITING') break;
        await tmSleep(200);
        postRow = findRowByTxId(txId);
      }
      if (!postRow) {
        processed.push(entry); LOG(`[BatchApprove-Verify] ${txId} row hilang — dianggap terproses`);
      } else {
        const d = extractTicketData(postRow, colMapAP);
        if (d && d.status !== 'PENDING' && d.status !== 'WAITING') {
          processed.push(entry); LOG(`[BatchApprove-Verify] ${txId} status ${d.status} — terproses`);
        } else {
          unprocessed.push(entry); WARN(`[BatchApprove-Verify] ${txId} masih PENDING — tidak terproses`);
        }
      }
    }
    if (unprocessed.length > 0) {
      WARN(`[BatchApprove] ${unprocessed.length}/${entries.length} tiket tidak terproses — akan di-retry`);
    }
    for (const entry of processed) {
      const { txId, row } = entry;
      clearPersistedDecision(txId);
      const colorRow = findRowByTxId(txId) || row;
      if (colorRow) applyColor(colorRow, COLOR.APPROVE, txId);
      sendLogResult(txId, colorRow, entry._log?.userId || '', true, '', entry._log?.betActual, entry._log?.scActual);
      try { chrome.runtime.sendMessage({ action: 'ticketActionDone', transactionId: txId, actionTaken: 'APPROVE' }, () => { void chrome.runtime.lastError; }); } catch (_) {}
      _doneTxIds.set(txId, 'APPROVE');
      _completedTx.set(txId, { status: 'APPROVED', userId: entry._log?.userId || '', t: Date.now() }); persistCompletedTx();
    }
    if (processed.length > 0) chromeNotif('BATCH APPROVED', `${processed.length} tiket disetujui`);
    if (missingFromPageQueue.size > 0) scheduleMissingQueueRetry(2000);
    schedulePostActionRefresh();
    return processed.length > 0;
  }

  async function executeBatchRejectPerRow(entries, reason) {
    let okCount = 0;
    for (const entry of sortItemsByRowOrder(entries)) {
      const { txId, row } = entry;
      if (await executeSingleRejectFlow(row, txId, reason, entry._log?.betActual, entry._log?.scActual)) okCount++;
      await tmSleep(100);
    }
    if (okCount > 0) schedulePostActionRefresh();
    return okCount > 0;
  }

  async function executeBatchReject(items, rejectReason) {
    if (!items.length) return true;
    const reason = rejectReason || 'kode tiket tidak di temukan';
    const safe = sortItemsByRowOrder(items.map(confirmDecisionSafe));
    LOG(`BATCH REJECT ${safe.length} tiket`);
    const entries = await resolveRowsForItems(safe);
    if (!entries.length) { hardRefreshRetry('batch_reject_no_entries'); return false; }
    if (!(await batchPrepareSelection(entries))) { LOG('batchPrepareSelection gagal — per baris'); hardRefreshRetry('batch_reject_prepare_failed'); return executeBatchRejectPerRow(entries, reason); }
    let btnReject = await waitForBulkAction('reject', entries[0]?.row, 3000);
    if (!btnReject) { LOG('Coba reject per baris'); hardRefreshRetry('batch_reject_button_missing'); return executeBatchRejectPerRow(entries, reason); }
    await megaClick(btnReject, 4);
    await tmSleep(CFG.AFTER_ACTION);
    if (!(await fillRejectDialogAndConfirm(reason, entries.map(e => e.txId)))) { pressEscape(); hardRefreshRetry('batch_reject_confirm_failed'); return executeBatchRejectPerRow(entries, reason); }
    await tmSleep(250);
    const colMapRJ = buildColMap();
    const processedRJ = [], unprocessedRJ = [];
    for (const entry of entries) {
      const { txId, row } = entry;
      let postRow = findRowByTxId(txId);
      for (let w = 0; w < 3 && postRow; w++) {
        const d = postRow ? extractTicketData(postRow, colMapRJ) : null;
        if (d && d.status !== 'PENDING' && d.status !== 'WAITING') break;
        await tmSleep(200);
        postRow = findRowByTxId(txId);
      }
      if (!postRow) {
        processedRJ.push(entry); LOG(`[BatchReject-Verify] ${txId} row hilang — dianggap terproses`);
      } else {
        const d = extractTicketData(postRow, colMapRJ);
        if (d && d.status !== 'PENDING' && d.status !== 'WAITING') {
          processedRJ.push(entry); LOG(`[BatchReject-Verify] ${txId} status ${d.status} — terproses`);
        } else {
          unprocessedRJ.push(entry); WARN(`[BatchReject-Verify] ${txId} masih PENDING — tidak terproses`);
        }
      }
    }
    if (unprocessedRJ.length > 0) {
      WARN(`[BatchReject] ${unprocessedRJ.length}/${entries.length} tiket tidak terproses — akan di-retry`);
    }
    for (const entry of processedRJ) {
      const { txId, row } = entry;
      clearPersistedDecision(txId);
      const colorRow = findRowByTxId(txId) || row;
      if (colorRow) applyColor(colorRow, COLOR.REJECT, txId);
      sendLogResult(txId, colorRow, entry._log?.userId || '', false, reason, entry._log?.betActual, entry._log?.scActual);
      try { chrome.runtime.sendMessage({ action: 'ticketActionDone', transactionId: txId, actionTaken: 'REJECT', rejectReason: reason }, () => { void chrome.runtime.lastError; }); } catch (_) {}
      _doneTxIds.set(txId, 'REJECT');
      _completedTx.set(txId, { status: 'REJECTED', userId: entry._log?.userId || '', t: Date.now() }); persistCompletedTx();
    }
    if (processedRJ.length > 0) chromeNotif('BATCH REJECTED', `${processedRJ.length} tiket | ${reason.slice(0, 60)}`);
    if (missingFromPageQueue.size > 0) scheduleMissingQueueRetry(2000);
    schedulePostActionRefresh();
    return processedRJ.length > 0;
  }

  async function handleSessionTimeoutItem(txId) {
    const row = findRowByTxId(txId);
    if (row) applyColor(row, '#ff6600', txId);
    try {
      const resp = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'refreshApiToken', transactionId: txId }, r => { void chrome.runtime.lastError; resolve(r); });
      });
      if (resp?.ok) { LOG(`Token refreshed untuk ${txId}`); return true; }
    } catch (_) {}
    LOG(`Token refresh gagal untuk ${txId}`);
    return false;
  }

  async function filterDoneTickets() {
    try {
      const doneRes = await new Promise(r => chrome.storage.local.get(['ticketsActionDone'], r));
      const doneMap = doneRes?.ticketsActionDone || {};
      if (Object.keys(doneMap).length === 0 || resultQueue.length === 0) return;
      let changed = false;
      for (let i = resultQueue.length - 1; i >= 0; i--) {
        const item = resultQueue[i];
        const compositeKey = ck(item.userId || '', item.txId);
        if (!doneMap[compositeKey]) continue;
        const row = findRowByTxId(item.txId);
        if (!row) {
          LOG(`[Guard-Done] ${item.txId} (user: ${item.userId || '?'}) sudah di ticketsActionDone — skip (row hilang)`);
          resultQueue.splice(i, 1);
        } else {
          LOG(`[Guard-Done] ${item.txId} row masih ada — batalkan ticketsActionDone, proses ulang`);
          delete doneMap[compositeKey];
          changed = true;
        }
      }
      if (changed) await chrome.storage.local.set({ ticketsActionDone: doneMap }).catch(() => {});
    } catch (_) {}
  }

  function tryDrainBatch() {
    if (!isAutoMode()) { signalDoneIfClear(); return; }
    if (batchDrainScheduled) return;
    batchDrainScheduled = true;
    setTimeout(async () => {
      batchDrainScheduled = false;
      if (resultQueue.length === 0) { signalDoneIfClear(); return; }
      if (isExecuting) {
        if (executingSince && Date.now() - executingSince > 60000) { WARN('isExecuting stale >60s — force reset'); isExecuting = false; executingSince = 0; }
        else { setTimeout(() => tryDrainBatch(), 2000); return; }
      }
      if (activeWorkers.size > 0) {
        setTimeout(() => tryDrainBatch(), 300); return;
      }
      const approve = resultQueue.filter(i => i.isApprove === true).length;
      const reject = resultQueue.filter(i => i.isApprove === false).length;
      LOG(`BATCH GATE OPEN! Approve: ${approve} | Reject: ${reject} | Total: ${resultQueue.length}`);
      await pressEscapeBurst(4, CFG.ESC_GAP);
      await tmSleep(CFG.POST_ESC);
      if (isAnyBlockingDialogOpen()) { try { (document.body || document.documentElement).click(); } catch (_) {} await pressEscapeBurst(3, CFG.ESC_GAP); await tmSleep(80); }
      await filterDoneTickets();
      if (resultQueue.length === 0) { signalDoneIfClear(); return; }
      try { await drainQueue(); } catch (e) { ERR('tryDrainBatch error:', e); }
    }, 120);
  }

  async function drainReject(rejectGroups) {
    try {
    for (const [reason, group] of rejectGroups) {
      let target = [...group];
      for (const item of group) {
        for (let rc = 0; rc < 2; rc++) {
          const r = findRowByTxId(item.txId);
          if (r) {
            const cm = buildColMap();
            const d = extractTicketData(r, cm);
            const be = _sanNum(d?.betting, 0), sc = _sanNum(d?.scatter, 0);
            if (d && be > 0 && sc > 0) {
              LOG(`[REJECT-RECHECK] ${item.txId} data valid di percobaan ${rc+1} (bet=${be}, sc=${sc}) — tetap reject`);
              break;
            }
          }
          await tmSleep(300);
        }
      }
    let remaining = [...target];
      let attempts = 0;
      while (remaining.length > 0 && attempts < 2) {
        attempts++;
        try {
          const ok = await executeBatchReject(remaining, reason);
          if (ok) { remaining = []; break; }
        } catch (e) { ERR(`[REJECT-THROW] percobaan ${attempts}: ${e.message}`); if (attempts >= 2) break; }
        LOG(`[REJECT-RETRY] percobaan ${attempts}/2 gagal untuk ${remaining.length} item`);
        await tmSleep(300);
        remaining = remaining.map(it => ({ ...it, row: findRowByTxId(it.txId) || it.row })).filter(it => {
          if (_doneTxIds.get(it.txId)) return false;
          if (!findRowByTxId(it.txId)) { missingFromPageQueue.set(it.txId, { ...it, addedAt: Date.now(), retryCount: 0 }); persistMissingQueue(); return false; }
          return true;
        });
      }
      if (remaining.length > 0) { remaining = remaining.filter(it => !_doneTxIds.get(it.txId)); _pushRQBulk(remaining); }
      await tmSleep(CFG.INTER_TICKET);
    }
    LOG(`[PHASE-REJECT] selesai`);
    } catch (e) { ERR('[drainReject] exception:', e.message); }
  }

  async function drainApprove(finalApprove) {
    try {
    let remaining = [...finalApprove];
    let attempts = 0;
    while (remaining.length > 0 && attempts < 2) {
      attempts++;
      try {
        const ok = await executeBatchApprove(remaining);
        if (ok) { remaining = []; break; }
      } catch (e) { ERR(`[APPROVE-THROW] percobaan ${attempts}: ${e.message}`); if (attempts >= 2) break; }
        LOG(`[APPROVE-RETRY] percobaan ${attempts}/2 gagal untuk ${remaining.length} item`);
        await tmSleep(300);
        remaining = remaining.map(it => ({ ...it, row: findRowByTxId(it.txId) || it.row })).filter(it => {
          if (_doneTxIds.get(it.txId)) return false;
          if (!findRowByTxId(it.txId)) { missingFromPageQueue.set(it.txId, { ...it, addedAt: Date.now(), retryCount: 0 }); persistMissingQueue(); return false; }
          return true;
        });
      }
      if (remaining.length > 0) { remaining = remaining.filter(it => !_doneTxIds.get(it.txId)); _pushRQBulk(remaining); }
    LOG(`[PHASE-APPROVE] selesai`);
    } catch (e) { ERR('[drainApprove] exception:', e.message); }
  }

  async function drainQueue() {
    if (isExecuting) {
      if (executingSince && Date.now() - executingSince > 60000) { isExecuting = false; executingSince = 0; }
      else return;
    }
    const token = ++_drainToken;
    isExecuting = true;
    executingSince = Date.now();
    const pending = [];
    while (resultQueue.length > 0) { const it = resultQueue.shift(); if (it && !_doneTxIds.get(it.txId)) pending.push(it); }
    try {
      const sessionItems = [], approveItems = [], rejectItems = [];
      for (const item of pending) {
        if (item.isApprove === 'SESSION_TIMEOUT') sessionItems.push(item);
        else if (item.isApprove === true) approveItems.push(item);
        else rejectItems.push(item);
      }
      for (const item of sessionItems) await handleSessionTimeoutItem(item.txId);
      const finalApprove = [];
      for (const item of approveItems.map(confirmDecisionSafe)) {
        if (item.isApprove === 'IGNORE') {
          markSesuaiIgnore(item.txId, item._raw || null);
          continue;
        }
        if (item.isApprove !== true) continue;
        if (!isTxIdInPage(item.txId)) {
          if (!missingFromPageQueue.has(item.txId)) {
            missingFromPageQueue.set(item.txId, { ...item, addedAt: Date.now(), retryCount: 0 });
            persistMissingQueue();
            LOG(`[DrainQueue-Missing] ${item.txId} tidak di halaman — simpan ke missing queue untuk retry`);
          }
          continue;
        }
        const row = findRowByTxId(item.txId);
        if (row && getActionBadge(row) === 'x') {
          WARN(`[NO-APPROVE] ${item.txId} red-X — approve dilarang, tiket dibiarkan tanpa aksi`);
          markSesuaiIgnore(item.txId, item._raw || null);
          continue;
        }
        finalApprove.push(item);
      }
      const rejectGroups = new Map();
      for (const item of rejectItems.map(confirmDecisionSafe)) {
        if (item.isApprove === true || item.isApprove === 'SESSION_TIMEOUT' || item.isApprove === 'IGNORE') continue;
        if (!isTxIdInPage(item.txId)) {
          if (!missingFromPageQueue.has(item.txId)) {
            missingFromPageQueue.set(item.txId, { ...item, addedAt: Date.now(), retryCount: 0 });
            persistMissingQueue();
            LOG(`[DrainQueue-Missing] ${item.txId} tidak di halaman — simpan ke missing queue untuk retry`);
          }
          continue;
        }
        const row = findRowByTxId(item.txId);
        if (row && getActionBadge(row) === 'x') {
          LOG(`[Badge-X-Match] ${item.txId} red-X + TIDAK_SESUAI — auto-reject`);
        }
        const reason = item.rejectReason || 'kode tiket tidak di temukan';
        if (!rejectGroups.has(reason)) rejectGroups.set(reason, []);
        rejectGroups.get(reason).push({ ...item, row });
      }
      if (finalApprove.length > 0) {
        LOG(`[PHASE-APPROVE] ${finalApprove.length} tiket — mulai`);
        if (_approveGuard) {
          _pushRQBulk(finalApprove);
        } else {
          _approveGuard = true;
          try { await drainApprove(finalApprove); } finally { _approveGuard = false; }
        }
      }
      if (rejectGroups.size > 0) {
        LOG(`[PHASE-REJECT] ${rejectGroups.size} group(s) — mulai`);
        if (_rejectGuard) {
          for (const [, group] of rejectGroups) { _pushRQBulk(group); }
        } else {
          _rejectGuard = true;
          try { await drainReject(rejectGroups); } finally { _rejectGuard = false; }
        }
      }
      if (resultQueue.length > 0 || missingFromPageQueue.size > 0) {
        if (Date.now() - _reloadThrottle < 8000) { LOG(`[REFRESH-THROTTLE] reload ditunda — tunggu 8s`); return; }
        _reloadThrottle = Date.now();
        LOG(`[REFRESH] Muat ulang halaman untuk data segar sebelum lanjut ${resultQueue.length + missingFromPageQueue.size} sisa...`);
        persistStateBeforeReload();
        setTimeout(() => { location.reload(); }, 100);
        return;
      }
      if (missingFromPageQueue.size > 0) {
        LOG(`[PHASE-RETRY] ${missingFromPageQueue.size} di missing queue — retry`);
        await processMissingFromPageQueue(true);
        if (resultQueue.length > 0) { LOG(`[RETRY-AGAIN] ${resultQueue.length} item baru — lanjut`); }
        if (missingFromPageQueue.size > 0) scheduleMissingQueueRetry(1000);
      }
      if (_postActionRefresh && resultQueue.length === 0) {
        _postActionRefresh = false;
        LOG('[POST-ACTION] Refresh setelah batch selesai');
        persistStateBeforeReload();
        setTimeout(() => { try { location.reload(); } catch (_) {} }, 500);
        return;
      }
    } catch (e) {
      ERR('drainQueue error:', e.message);
      for (const item of pending) {
        if (!missingFromPageQueue.has(item.txId)) {
          missingFromPageQueue.set(item.txId, { ...item, addedAt: Date.now(), retryCount: 0 });
        }
      }
      persistMissingQueue();
      persistRetryQueue();
    }
    finally {
      if (token === _drainToken) { isExecuting = false; executingSince = 0; }
      signalDoneIfClear();
      drainRetry();
      hardcoreRecover();
      persistRetryQueue();
      schedulePersistAll();
      if (resultQueue.length > 0) setTimeout(() => tryDrainBatch(), 0);
    }
  }

  function getQueueStatusPayload() {
    const pendingInTable = countPendingTicketsInTable();
    let skipInDom = 0;
    const colMap = buildColMap();
    for (const row of getRows()) {
      const data = extractTicketData(row, colMap);
      if (!data) continue;
      if ((data.status === 'PENDING' || data.status === 'WAITING') && (rowColorMap.get(data.txId) === COLOR.SKIP || pendingDecisionMap.has(data.txId))) skipInDom++;
    }
    return {
      awaitingCount: retryQueue.size, queueCount: resultQueue.length, verifyingCount: activeWorkers.size,
      pendingInTable, pendingCount: pendingInTable, pendingDecisionCount: pendingDecisionMap.size,
      missingCount: missingFromPageQueue.size, isExecuting, busy: isBusy() || pendingInTable > 0 || retryQueue.size > 0 || skipInDom > 0,
      queue: resultQueue.length, executing: isExecuting,
      canClose: !isBusy() && pendingInTable === 0 && retryQueue.size === 0 && skipInDom === 0 && missingFromPageQueue.size === 0
    };
  }

  let _signalScanGuard = false;
  function signalDoneIfClear() {
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(async () => {
      doneTimer = null;
      try {
        const payload = getQueueStatusPayload();
        if (retryQueue.size === 0 && resultQueue.length === 0 && activeWorkers.size === 0 && !isExecuting && missingFromPageQueue.size === 0) {
          if (payload.pendingInTable > 0 && !_signalScanGuard) {
            _signalScanGuard = true;
            setTimeout(() => { _signalScanGuard = false; scanAndProcess().catch(e => ERR('Pending scan error:', e)); }, 500);
            return;
          }
          LOG('Tidak ada antrian — minta background tutup tab');
          try { chrome.runtime.sendMessage({ action: 'ticketsIdle', ...payload }, () => { void chrome.runtime.lastError; }); } catch (_) {}
        }
      } catch (e) { ERR('signalDoneIfClear error:', e); }
    }, 1200);
  }

  function scheduleMissingQueueRetry(delayMs = 2000) {
    if (missingFromPageQueue.size === 0) { if (_missingRetryTimer) { clearTimeout(_missingRetryTimer); _missingRetryTimer = null; } return; }
    if (_missingRetryTimer) return;
    _missingRetryTimer = setTimeout(() => { _missingRetryTimer = null; processMissingFromPageQueue().catch(e => ERR('Missing retry error:', e)); }, delayMs);
  }

  async function processMissingFromPageQueue(fromDrainQueue = false) {
    if (missingFromPageQueue.size === 0) return;
    if (!fromDrainQueue && isExecuting) { scheduleMissingQueueRetry(1000); return; }
    if (_missingProcessing) { scheduleMissingQueueRetry(1000); return; }
    _missingProcessing = true;
    LOG(`[MissingQueue] Proses ${missingFromPageQueue.size} tiket missing...`);
    try {
      const found = [];
      for (const [txId, item] of missingFromPageQueue) {
        item.retryCount = (item.retryCount || 0) + 1;
        if (_doneTxIds.get(txId)) {
          missingFromPageQueue.delete(txId);
          clearPersistedDecision(txId);
          LOG(`[MissingQueue-DONE] ${txId} sudah diproses — hapus dari missing`);
          continue;
        }
        if (isTxIdInPage(txId)) {
          const row = findRowByTxId(txId);
          const badge = row ? getActionBadge(row) : null;
          const cm = buildColMap();
          const rowData = row ? extractTicketData(row, cm) : null;
          if (badge === 'x' && item.isApprove === false) {
            missingFromPageQueue.delete(txId);
            LOG(`[Badge-X-Match] ${txId} red-X + TIDAK_SESUAI di missing queue — auto-reject`);
            found.push({ ...item, userId: (rowData && rowData.userId) || item.userId || '' });
            const savedColor = rowColorMap.get(txId);
            if (savedColor && row) paintRowStyles(row, savedColor);
            continue;
          }
          found.push({ ...item, userId: (rowData && rowData.userId) || item.userId || '' });
          missingFromPageQueue.delete(txId);
          const savedColor = rowColorMap.get(txId);
          if (savedColor && row) paintRowStyles(row, savedColor);
        }
        else {
          item.lastRetry = Date.now();
          item.nextRetry = Date.now() + 2000;
          const retryCount = item.retryCount || 0;
          const elapsed = Date.now() - (item.addedAt || Date.now());
          const hasPersisted = pendingDecisionMap.has(txId);
          if (hasPersisted && (retryCount >= 60 || elapsed > 600000)) {
            WARN(`[MissingQueue-RECOVER] ${txId} stuck ${retryCount}x/${Math.round(elapsed/1000)}s — hapus (sudah tidak di halaman)`);
            missingFromPageQueue.delete(txId);
            clearPersistedDecision(txId);
            continue;
          }
          if (!hasPersisted && (retryCount >= 5 || elapsed > 120000)) {
            WARN(`[MissingQueue] ${txId} tanpa decision ${retryCount}x — hapus (tidak di halaman)`);
            missingFromPageQueue.delete(txId);
            continue;
          }
        }
      }
      persistMissingQueue();
      if (found.length > 0) { _pushRQBulk(found); tryDrainBatch(); }
      if (missingFromPageQueue.size > 0) scheduleMissingQueueRetry(1000);
    } catch (e) { ERR('[MissingQueue] error:', e.message); scheduleMissingQueueRetry(1000); }
    finally { _missingProcessing = false; }
  }

  function auditMutations() {
    if (!ctxOk()) return;
    if (isExecuting || _missingProcessing) return;
    let active = 0, finalized = 0, inProgress = 0, changed = 0, requeued = 0;
    const colMap = buildColMap();
    for (const row of getRows()) {
      const data = extractTicketData(row, colMap);
      if (!data || (data.status !== 'PENDING' && data.status !== 'WAITING')) continue;
      const txId = data.txId;
      if (!txId) continue;
      if (getActionBadge(row) !== 'x') continue;
      active++;
      const done = _doneTxIds.get(txId);
      if (done === 'APPROVE' || done === 'REJECT' || done === 'SKIP') { finalized++; continue; }
      const dec = pendingDecisionMap.get(txId);
      if (done === 'IGNORE' || (dec && dec.isApprove === 'IGNORE')) {
        const snap = dec ? dec._snap : null;
        if (snap && snap.betting !== undefined && snap.scatter !== undefined) {
          const curBet = _sanNum(data?.betting, 0), curSc = _sanNum(data?.scatter, 0);
          const snapBet = _sanNum(snap.betting, 0), snapSc = _sanNum(snap.scatter, 0);
          if (curBet !== snapBet || curSc !== snapSc) {
            WARN(`[MUTASI-BERUBAH] ${txId} data mutasi berubah (bet ${snapBet}→${curBet}, scatter ${snapSc}→${curSc}) — cek ulang`);
            _doneTxIds.delete(txId);
            _ignoredTx.delete(txId);
            clearPersistedDecision(txId);
            enqueueTicket(data);
            changed++;
            continue;
          }
        }
        finalized++;
        continue;
      }
      if (resultQueue.some(i => i.txId === txId) || retryQueue.has(txId) || missingFromPageQueue.has(txId) || activeWorkers.has(txId)) { inProgress++; continue; }
      if (dec && (dec.isApprove === true || dec.isApprove === false)) { inProgress++; continue; }
      WARN(`[MUTASI-AUDIT] ${txId} mutasi belum ada keputusan final — enqueue verifikasi`);
      enqueueTicket(data);
      requeued++;
    }
    if (active > 0) LOG(`[MUTASI-AUDIT] ${active} mutasi aktif | selesai=${finalized} proses=${inProgress} berubah=${changed} verifikasi=${requeued}`);
  }

  async function drainRetry() {
    if (_retryGuard) return;
    _retryGuard = true;
    try {
      if (!ctxOk() || isExecuting || _missingProcessing) return;
      const colMap = buildColMap();
      let found = 0;
      for (const row of getRows()) {
        const data = extractTicketData(row, colMap);
        if (!data || (data.status !== 'PENDING' && data.status !== 'WAITING')) continue;
        const txId = data.txId;
        if (!txId) continue;
        if (_doneTxIds.get(txId) === 'APPROVE' || _doneTxIds.get(txId) === 'REJECT') continue;
        if (resultQueue.some(i => i.txId === txId)) continue;
        if (retryQueue.has(txId)) continue;
        if (missingFromPageQueue.has(txId)) continue;
        const dec = pendingDecisionMap.get(txId);
        if (!dec) continue;
        if (dec.isApprove === 'IGNORE') {
          if (_doneTxIds.get(txId) !== 'IGNORE') { _doneTxIds.set(txId, 'IGNORE'); }
          if (!_ignoredTx.has(txId)) { _ignoredTx.add(txId); persistIgnoredTx(); }
          applyColor(row, COLOR.BLUE, txId);
          continue;
        }
        if (dec.isApprove === true || dec.isApprove === false) {
          if (dec.isApprove === false && isPrematureRejectReason(dec.reason)) {
            clearPersistedDecision(txId);
            applyColor(row, COLOR.PEND, txId);
            enqueueTicket(data);
            found++;
            continue;
          }
          _pushRQ({ txId, userId: data.userId || '', isApprove: dec.isApprove, rejectReason: dec.reason || '', _raw: null, _log: dec._log || null, retryCount: 0 });
          if (row) applyColor(row, COLOR.PEND, txId);
          found++;
        }
      }
      if (found > 0) { LOG(`[DrainRetry] ${found} item di-queue ulang`); tryDrainBatch(); }
    } catch (e) { ERR('[DrainRetry] error:', e.message); }
    finally { _retryGuard = false; }
  }

  async function hardcoreRecover() {
    if (_hardcoreGuard) return;
    _hardcoreGuard = true;
    try {
      if (!ctxOk()) return;
      const colMap = buildColMap();
      let recovered = 0;
      for (const row of getRows()) {
        const data = extractTicketData(row, colMap);
        if (!data || (data.status !== 'PENDING' && data.status !== 'WAITING')) continue;
        const txId = data.txId;
        if (!txId) continue;
        if (_doneTxIds.get(txId) === 'APPROVE' || _doneTxIds.get(txId) === 'REJECT') continue;
        if (resultQueue.some(i => i.txId === txId)) continue;
        if (retryQueue.has(txId)) continue;
        if (missingFromPageQueue.has(txId)) continue;
        if (activeWorkers.has(txId)) continue;
        const dec = pendingDecisionMap.get(txId);
        if (!dec) continue;
        if (dec.isApprove === 'IGNORE') {
          if (_doneTxIds.get(txId) !== 'IGNORE') { _doneTxIds.set(txId, 'IGNORE'); }
          if (!_ignoredTx.has(txId)) { _ignoredTx.add(txId); persistIgnoredTx(); }
          applyColor(row, COLOR.BLUE, txId);
          continue;
        }
        if (dec.isApprove !== true && dec.isApprove !== false) {
          enqueueTicket(data);
          recovered++;
          continue;
        }
        _pushRQ({ txId, userId: data.userId || '', isApprove: dec.isApprove, rejectReason: dec.reason || '', _raw: null, _log: null, retryCount: 0 });
        if (row) applyColor(row, COLOR.PEND, txId);
        recovered++;
      }
      if (recovered > 0) { LOG(`[HARDCORE] ${recovered} orphan item di-recover`); tryDrainBatch(); }
    } catch (e) { ERR('[HARDCORE] error:', e.message); }
    finally { _hardcoreGuard = false; }
  }

  function persistMissingQueue() {
    if (!ctxOk()) return;
    if (_persistMissingTimer) { clearTimeout(_persistMissingTimer); }
    _persistMissingTimer = setTimeout(() => {
      _persistMissingTimer = null;
      const obj = {};
      missingFromPageQueue.forEach((v, k) => { obj[k] = v; });
      try { chrome.storage.local.set({ tmMissingQueue: obj }, () => { void chrome.runtime.lastError; }); } catch (_) {}
    }, 150);
  }

  function loadMissingQueue() {
    if (!ctxOk()) return;
    try {
      chrome.storage.local.get(['tmMissingQueue'], res => {
        if (chrome.runtime.lastError) return;
        const stored = res?.tmMissingQueue || {};
        let loaded = 0;
        Object.keys(stored).forEach(tx => {
          if (!missingFromPageQueue.has(tx)) {
            const item = stored[tx];
            if (item && item.txId) {
              item.retryCount = item.retryCount || 0;
              item.addedAt = item.addedAt || Date.now();
              item.nextRetry = 0;
              missingFromPageQueue.set(tx, item);
              loaded++;
            }
          }
        });
        if (loaded > 0) { LOG(`[MissingQueue] Loaded ${loaded} dari storage`); scheduleMissingQueueRetry(1000); }
      });
    } catch (_) {}
  }

  function sendLogResult(txId, row, userId, isApprove, reason, actualBet, actualSc) {
    try {
      let lr = row || findRowByTxId(txId);
      if (lr && !validateRowForTxId(lr, txId)) {
        WARN(`[GUARD sendLogResult] row mismatch untuk ${txId} — mencari row yang benar`);
        lr = null;
        for (const rr of getRows()) {
          const d = extractTicketData(rr, buildColMap());
          if (d && d.txId === txId) { lr = rr; break; }
        }
      }
      if (!lr) return;
      const cm = buildColMap();
      const d = extractTicketData(lr, cm);
      if (!d) return;
      if (userId && d.userId && userId !== d.userId) {
        WARN(`[GUARD sendLogResult] userId mismatch: passed "${userId}" vs row "${d.userId}" untuk ${txId} — pakai row userId`);
      }
      const finalUserId = d.userId || userId || '';
      const beNum = _sanNum(d.betting, 0);
      const scNum = _sanNum(d.scatter, 0);
      const reBet = (actualBet !== undefined && actualBet !== null) ? actualBet : beNum;
      const reSc = (actualSc !== undefined && actualSc !== null) ? actualSc : scNum;
      chrome.runtime.sendMessage({
        action: 'logResult', situs: _situs, userId: finalUserId,
        txId, betExpected: d.betting || '0', betActual: reBet,
        scExpected: d.scatter || '0', scActual: reSc,
        status: isApprove ? 'SESUAI' : 'TIDAK_SESUAI',
        rejectReason: reason || '', mode: isAutoMode() ? 'AUTO' : 'MANUAL'
      }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function persistRetryQueue() {
    if (!ctxOk()) return;
    try {
      const arr = [];
      retryQueue.forEach((v, k) => {
        arr.push({ txId: v.txId, userId: v.userId, betting: v.betting, scatter: v.scatter, hadiah: v.hadiah, status: v.status, retryCount: v.retryCount || 0, addedAt: v.addedAt || Date.now(), finalStatus: v.finalStatus || null, isApprove: v.isApprove !== undefined ? v.isApprove : undefined, rejectReason: v.rejectReason || '', _raw: v._raw || null, _log: v._log || null });
      });
      chrome.storage.local.set({ tmRetryQueue: arr }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function loadRetryQueue() {
    if (!ctxOk()) return;
    try {
      chrome.storage.local.get(['tmRetryQueue'], res => {
        if (chrome.runtime.lastError) return;
        const arr = res?.tmRetryQueue || [];
        if (!arr.length) return;
        awaitColorsLoaded().then(() => {
          try {
            if (!ctxOk()) return;
            let loaded = 0;
            for (const item of arr) {
              const dec = pendingDecisionMap.get(item.txId);
              if (dec && (dec.isApprove === true || dec.isApprove === false)) {
                if (!resultQueue.some(i => i.txId === item.txId) && !_doneTxIds.get(item.txId)) {
                  _pushRQ({ txId: item.txId, userId: item.userId || '', isApprove: dec.isApprove, rejectReason: dec.reason || '', _raw: dec._raw || null, _log: dec._log || null, retryCount: 0 });
                  loaded++;
                }
                continue;
              }
              if (!retryQueue.has(item.txId) && !_doneTxIds.get(item.txId) && !resultQueue.some(i => i.txId === item.txId) && !_completedTx.has(item.txId) && !_ignoredTx.has(item.txId)) {
                retryQueue.set(item.txId, { txId: item.txId, userId: item.userId || '', betting: item.betting || '', scatter: item.scatter || '', hadiah: item.hadiah || '', status: item.status || '', retryCount: item.retryCount || 0, processing: false, success: false, nextRetry: 0, lastError: null, addedAt: item.addedAt || Date.now(), updatedAt: Date.now(), isApprove: item.isApprove, rejectReason: item.rejectReason || '', _raw: item._raw || null, _log: item._log || null, finalStatus: item.finalStatus || null });
                applyPendingColorByTxId(item.txId);
                loaded++;
              }
            }
            if (loaded > 0) { LOG(`[RetryQueue] Restored ${loaded} items from storage`); }
            let applied = 0;
            for (const [txId, state] of retryQueue) {
              const savedDec = state.isApprove !== undefined ? state : pendingDecisionMap.get(txId);
              if (!savedDec) continue;
              if (savedDec.isApprove === 'IGNORE') {
                retryQueue.delete(txId); activeWorkers.delete(txId);
                continue;
              }
              if (savedDec.isApprove === true || savedDec.isApprove === false) {
                const row = findRowByTxId(txId);
                if (savedDec.isApprove === true && row && getActionBadge(row) === 'x') {
                  WARN(`[NO-APPROVE restore] ${txId} red-X + keputusan approve — dibiarkan tanpa aksi (IGNORE)`);
                  markSesuaiIgnore(txId, savedDec._raw || null);
                  retryQueue.delete(txId); activeWorkers.delete(txId);
                  continue;
                }
                if (savedDec.isApprove === false && isPrematureRejectReason(savedDec.rejectReason || savedDec.reason)) {
                  delete state.isApprove;
                  delete state.rejectReason;
                  delete state._raw;
                  delete state._log;
                  clearPersistedDecision(txId);
                  LOG(`[RetryQueue] ${txId} reject prematur — verifikasi ulang via API`);
                  continue;
                }
                retryQueue.delete(txId); activeWorkers.delete(txId);
                _pushRQ({ txId, userId: state.userId || '', isApprove: savedDec.isApprove, rejectReason: savedDec.rejectReason || savedDec.reason || '', _raw: savedDec._raw || null, _log: savedDec._log || null, retryCount: 0 });
                applied++;
              }
            }
            if (applied > 0) { LOG(`[RetryQueue] ${applied} item langsung diproses sesuai keputusan tersimpan`); if (!isExecuting) tryDrainBatch(); }
            recoverPendingWorkAfterLoad();
            processQueue();
            syncAllStatesToApp();
          } catch (e) { ERR('[loadRetryQueue apply] exception:', e.message); processQueue(); }
          chrome.storage.local.remove('tmRetryQueue', () => { void chrome.runtime.lastError; });
        });
      });
    } catch (_) {}
  }

  function persistCompletedTx() {
    try {
      const arr = []; _completedTx.forEach((v, k) => arr.push({ txId: k, status: v.status, userId: v.userId || '', t: v.t }));
      chrome.storage.local.set({ tmCompletedTx: arr }, () => { void chrome.runtime.lastError; });
      syncAllStatesToApp();
    } catch (_) {}
  }

  function persistIgnoredTx() {
    try {
      chrome.storage.local.set({ tmIgnoredTx: Array.from(_ignoredTx) }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function syncAllStatesToApp() {
    try {
      const all = [];
      const seen = new Set();
      _completedTx.forEach((v, txId) => {
        if (seen.has(txId)) return; seen.add(txId);
        all.push({ txId, userId: v.userId || '', status: v.status || 'DONE', t: v.t || Date.now() });
      });
      pendingDecisionMap.forEach((dec, txId) => {
        if (seen.has(txId)) return; seen.add(txId);
        all.push({ txId, userId: dec.userId || '', status: 'PENDING', t: dec.t || Date.now() });
      });
      retryQueue.forEach((state, txId) => {
        if (seen.has(txId)) return; seen.add(txId);
        all.push({ txId, userId: state.userId || '', status: 'PENDING', t: state.addedAt || Date.now() });
      });
      resultQueue.forEach(item => {
        if (seen.has(item.txId)) return; seen.add(item.txId);
        all.push({ txId: item.txId, userId: item.userId || '', status: 'PENDING', t: Date.now() });
      });
      chrome.storage.local.set({ tmAllTickets: all }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function loadCompletedTx() {
    if (!ctxOk() || _completedTxLoaded) return;
    _completedTxLoaded = true;
    try {
      chrome.storage.local.get(['tmCompletedTx', 'tmIgnoredTx'], res => {
        if (chrome.runtime.lastError) return;
        const arr = res?.tmCompletedTx || [];
        for (const item of arr) {
          if (item.txId && !_completedTx.has(item.txId)) {
            _completedTx.set(item.txId, { status: item.status || 'DONE', userId: item.userId || '', t: item.t || Date.now() });
          }
        }
        const ign = res?.tmIgnoredTx || [];
        for (const txId of ign) { if (txId) _ignoredTx.add(txId); }
        if (arr.length > 0) LOG(`[CompletedTx] Loaded ${arr.length} items`);
        if (ign.length > 0) LOG(`[IgnoredTx] Loaded ${ign.length} items`);
        purgeStaleCompletedState();
        recoverPendingWorkAfterLoad();
        syncAllStatesToApp();
        chrome.storage.local.remove(['tmCompletedTx', 'tmIgnoredTx'], () => { void chrome.runtime.lastError; });
      });
    } catch (_) {}
  }

  function chromeNotif(title, message) {
    try { chrome.runtime.sendMessage({ action: 'showNotification', title: `AutoScater | ${title}`, message: String(message || '').slice(0, 200) }).catch(() => {}); } catch (_) {}
  }

  function persistStateBeforeReload() {
    try {
      for (const item of resultQueue) {
        if (!pendingDecisionMap.has(item.txId) && (item.isApprove === true || item.isApprove === false)) {
          pendingDecisionMap.set(item.txId, { isApprove: item.isApprove, reason: item.rejectReason || '', color: item.isApprove ? COLOR.OK : COLOR.ERR, _raw: item._raw || null, _log: item._log || null, t: Date.now() });
          rowColorMap.set(item.txId, item.isApprove ? COLOR.OK : COLOR.ERR);
        }
      }
    } catch (_) {}
    try { mirrorDecisionsToSession(); } catch (_) {}
    try { persistDecisionsNow(); } catch (_) {}
    try { persistMissingQueue(); } catch (_) {}
    try { persistRetryQueue(); } catch (_) {}
    try { persistResultQueue(); } catch (_) {}
    try { flushColorsNow(); } catch (_) {}
    try { persistIgnoredTx(); } catch (_) {}
  }

  function hardRefreshRetry(reason) {
    if (_hardRefreshLock) return;
    _hardRefreshLock = true;
    setTimeout(() => { _hardRefreshLock = false; }, 5000);
    try { LOG(`[HARD-REFRESH] ${reason || 'retry'}`); } catch (_) {}
    persistStateBeforeReload();
    setTimeout(() => { try { location.reload(); } catch (_) {} }, 120);
  }

  async function runAutoAmbil() {
    if (isBusy() || isProcessingAutomation) return;
    if (!ctxOk() || !(await isTmAutoModeReady())) return;
    isProcessingAutomation = true;
    try {
      const rows = Array.from(document.querySelectorAll('tbody tr'));
      const toCheck = [];
      const colMap = buildColMap();
      for (const tr of rows) {
        if (!isGreenRow(tr)) continue;
        if (tr.querySelector('td:nth-child(2) svg.text-red-600, td:nth-child(3) svg.text-red-600, td:nth-child(2) svg.text-red-500, td:nth-child(3) svg.text-red-500')) continue;
        if (tr.querySelector('svg.lucide-thumbs-up')) continue;
        const data = extractTicketData(tr, colMap);
        if (data?.txId) { const cb = getRowCheckbox(tr); if (cb && !isCheckboxChecked(cb)) toCheck.push(data.txId); }
      }
      if (!toCheck.length) return;
      for (const txId of toCheck) {
        const row = findRowByTxId(txId);
        if (!row) continue;
        const cb = getRowCheckbox(row);
        if (!cb || isCheckboxChecked(cb)) continue;
        await megaClick(cb, 3);
        await tmSleep(150);
      }
      await sleep(500);
      const bulkSvg = Array.from(document.querySelectorAll('svg.lucide-list-check')).find(s => (s.getAttribute('class') || '').includes('text-[#fdc700]') && (s.closest('thead') || !s.closest('tbody')));
      const btn = bulkSvg ? bulkSvg.closest('button') : bulkSvg;
      if (btn) { simulateClick(btn); await sleep(1200); pressEscape(); await sleep(200); pressEscape(); await sleep(300); }
    } catch (e) { ERR('[Auto Ambil]', e.message); }
    finally { isProcessingAutomation = false; }
  }

  async function runAutoApprove() {
    if (isBusy() || isProcessingAutomation) return;
    if (!ctxOk() || !(await isTmAutoModeReady())) return;
    isProcessingAutomation = true;
    try {
      const rows = Array.from(document.querySelectorAll('tbody tr'));
      const toCheck = [];
      const colMap = buildColMap();
      for (const tr of rows) {
        if (!isGreenRow(tr)) continue;
        if (getActionBadge(tr) === 'x') continue;
        if (tr.querySelector('td:nth-child(2) svg.text-red-600, td:nth-child(3) svg.text-red-600, td:nth-child(2) svg.text-red-500, td:nth-child(3) svg.text-red-500')) continue;
        if (!tr.querySelector('svg.lucide-thumbs-up')) continue;
        const data = extractTicketData(tr, colMap);
        if (data?.txId) { const cb = getRowCheckbox(tr); if (cb && !isCheckboxChecked(cb)) toCheck.push(data.txId); }
      }
      if (!toCheck.length) return;
      for (const txId of toCheck) {
        const row = findRowByTxId(txId);
        if (!row) continue;
        const cb = getRowCheckbox(row);
        if (!cb || isCheckboxChecked(cb)) continue;
        await megaClick(cb, 3);
        await tmSleep(150);
      }
      await sleep(CFG.VERIFY_WAIT);
      let allChecked = true;
      for (const txId of toCheck) {
        const row = findRowByTxId(txId);
        if (!row) { allChecked = false; continue; }
        const cb = getRowCheckbox(row);
        if (!cb || isCheckboxChecked(cb)) continue;
        allChecked = false;
        await megaClick(cb, 3);
        await tmSleep(100);
      }
      if (!allChecked) await sleep(1200);
      let appSvg = Array.from(document.querySelectorAll('svg.lucide-thumbs-up')).find(s => s.closest('thead') || !s.closest('tbody'));
      let btnApprove = appSvg ? (appSvg.closest('button') || appSvg) : null;
      if (!btnApprove) {
        const bulkSvg = Array.from(document.querySelectorAll('svg.lucide-list-check')).find(s => (s.getAttribute('class') || '').includes('text-[#fdc700]') && (s.closest('thead') || !s.closest('tbody')));
        if (bulkSvg) { simulateClick(bulkSvg.closest('button') || bulkSvg); await sleep(900); btnApprove = (document.querySelector('svg.lucide-thumbs-up')?.closest('button') || null); }
      }
      if (!btnApprove) return;
      simulateClick(btnApprove);
      await sleep(900);
      const btnConfirm = Array.from(document.querySelectorAll('button')).find(b => (b.innerText || b.textContent || '').includes('Ya, Setujui'));
      if (btnConfirm) { simulateClick(btnConfirm); await sleep(1200); chromeNotif('BATCH APPROVED', `${toCheck.length} tiket berhasil di-approve`); }
    } catch (e) { ERR('[Auto Approve]', e.message); }
    finally { isProcessingAutomation = false; }
  }

  function updateAutomationLoops() {
    if (!ctxOk()) return;
    chrome.storage.local.get(['autoAmbilScatter', 'autoApproveScatter', 'operationMode'], res => {
      if (chrome.runtime.lastError) return;
      const isAuto = (res.operationMode || 'MANUAL') === 'AUTO';
      if (isAuto && res.autoAmbilScatter) { if (!ambilInterval) { ambilInterval = setInterval(runAutoAmbil, 15000); LOG('[Ambil Loop] Started'); } }
      else { if (ambilInterval) { clearInterval(ambilInterval); ambilInterval = null; LOG('[Ambil Loop] Stopped'); } }
      if (isAuto && res.autoApproveScatter) { if (!approveInterval) { approveInterval = setInterval(runAutoApprove, 15000); LOG('[Approve Loop] Started'); } }
      else { if (approveInterval) { clearInterval(approveInterval); approveInterval = null; LOG('[Approve Loop] Stopped'); } }
    });
  }

  function registerTab() {
    if (!ctxOk()) return;
    try { chrome.runtime.sendMessage({ action: 'registerTicketsTab' }, resp => { if (chrome.runtime.lastError) { ERR('Register gagal:', chrome.runtime.lastError.message); return; } LOG('Tab terdaftar:', resp?.status); }); } catch (e) { ERR('Register exception:', e.message); }
  }

  async function isTmAutoModeReady() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(['operationMode', 'adminUrl', 'token', 'executorName', 'sniffedAt'], res => {
          if (chrome.runtime.lastError) { resolve(false); return; }
          if ((res.operationMode || 'MANUAL') === 'MANUAL') { resolve(false); return; }
          const tokenOk = !!(res.token && res.token.length >= 10);
          const snifferOk = !!(res.sniffedAt && (Date.now() - res.sniffedAt) < 2 * 60 * 60 * 1000);
          resolve(!!(res.adminUrl && (tokenOk || snifferOk) && res.executorName));
        });
      } catch (_) { resolve(false); }
    });
  }

  function checkTokenFreshness() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(['token', 'tokenUpdatedAt'], res => {
          if (chrome.runtime.lastError) { resolve(''); return; }
          const tok = res?.token || '';
          const at = res?.tokenUpdatedAt ? new Date(res.tokenUpdatedAt).toLocaleTimeString('id-ID') : '-';
          if (!tok) LOG('[TOKEN] Kosong!');
          else if (tok !== lastKnownToken) { LOG(`[TOKEN] ${lastKnownToken ? 'BERUBAH' : 'Pertama'} — jam: ${at}`); lastKnownToken = tok; }
          resolve(tok);
        });
      } catch (e) { ERR('checkTokenFreshness:', e.message); resolve(''); }
    });
  }

  async function scanAndProcess() {
    if (!ctxOk()) { stopMonitorTimers(); return; }
    touchProgress();
    await awaitColorsLoaded();
    if (!(await isTmAutoModeReady())) return;
    for (const [txId, g] of _reverifyGuard) { if (Date.now() - g.t > 180000) _reverifyGuard.delete(txId); }
    reapplyAllRowColors();
    if (isExecuting && executingSince && Date.now() - executingSince > 60000) { isExecuting = false; executingSince = 0; WARN('scanAndProcess force-release isExecuting'); }
    if (isExecuting) return;
    if (isProcessingAutomation) return;
    nextPollAt = Date.now() + CFG.POLL;
    if (missingFromPageQueue.size > 0 && !isExecuting) {
      const appeared = [];
      for (const [txId, item] of missingFromPageQueue) {
        if (isTxIdInPage(txId)) {
          appeared.push(item);
          missingFromPageQueue.delete(txId);
        } else {
          const retryCount = item.retryCount || 0;
          const elapsed = Date.now() - (item.addedAt || Date.now());
          if (pendingDecisionMap.has(txId) && (retryCount >= 60 || elapsed > 600000)) {
            WARN(`[MissingQueue-RECOVER] ${txId} stuck ${retryCount}x — keep retrying`);
          } else if (!pendingDecisionMap.has(txId) && (retryCount >= 5 || elapsed > 120000)) {
            WARN(`[MissingQueue] ${txId} tanpa decision — keep retrying (${retryCount}x)`);
          }
        }
      }
      if (missingFromPageQueue.size > 0) persistMissingQueue();
      if (appeared.length > 0) { _pushRQBulk(appeared); setTimeout(() => tryDrainBatch(), 300); }
    }
    const rows = getRows();
    const colMap = buildColMap();
    if (!rows.length) { signalDoneIfClear(); return; }
    const hasilSynced = reconcileFromResultsTable(rows, colMap);
    if (hasilSynced > 0) LOG(`[HASIL-SYNC] ${hasilSynced} tiket dipulihkan dari tabel hasil (scan)`);
    let enqueued = 0;
    for (const row of rows) {
      const data = extractTicketData(row, colMap);
      if (!data || (data.status !== 'PENDING' && data.status !== 'WAITING')) continue;
      const { txId, userId } = data;
      if (_doneTxIds.get(txId) === 'SKIP') {
        applyColor(row, COLOR.BLACK, txId);
        continue;
      }
      if (_doneTxIds.get(txId) === 'IGNORE' || pendingDecisionMap.get(txId)?.isApprove === 'IGNORE') {
        if (_doneTxIds.get(txId) !== 'IGNORE') { _doneTxIds.set(txId, 'IGNORE'); }
        if (!_ignoredTx.has(txId)) { _ignoredTx.add(txId); persistIgnoredTx(); }
        applyColor(row, COLOR.BLUE, txId);
        continue;
      }
      if ((_doneTxIds.has(txId) || _completedTx.has(txId) || _ignoredTx.has(txId))) {
        LOG(`[RECOVER] ${txId} di done/ignored tapi masih ${data.status} di halaman — clear, proses ulang`);
        clearPersistedDecision(txId);
        _doneTxIds.delete(txId);
        if (_completedTx.delete(txId)) persistCompletedTx();
        if (_ignoredTx.delete(txId)) persistIgnoredTx();
        rowColorMap.delete(txId);
      }
      const req = hasRequiredDataForDecision(data);
      if (!req.ok) {
        const retry = markMissingDataRetry(txId);
        const rowNow = findRowByTxId(txId) || row;
        if (rowNow) applyColor(rowNow, COLOR.PEND, txId);
        if (retry.exceed) {
          clearMissingDataRetry(txId);
          WARN(`[MUTASI-LAMA] ${txId} data kosong ${retry.count}x — enqueue (retry nanti)`);
        } else {
          WARN(`[GUARD missing-data] ${txId} betting/scatter belum siap (try ${retry.count}/${MAX_MISSING_DATA_RETRY})`);
          continue;
        }
      }
      if (_doneTxIds.get(txId) === 'APPROVE') { continue; }
      const savedDec = pendingDecisionMap.get(txId);
      if (savedDec) {
        applyColor(row, savedDec.color, txId);
        const badge = getActionBadge(row);
        if (savedDec.isApprove === 'IGNORE') {
          if (_doneTxIds.get(txId) !== 'IGNORE') { _doneTxIds.set(txId, 'IGNORE'); }
          if (!_ignoredTx.has(txId)) { _ignoredTx.add(txId); persistIgnoredTx(); }
          applyColor(row, COLOR.BLUE, txId);
          continue;
        }
        if (savedDec.isApprove === true) {
          if (badge === 'x') {
            WARN(`[NO-APPROVE] ${txId} red-X + keputusan approve — dibatalkan, tiket dibiarkan tanpa aksi`);
            markSesuaiIgnore(txId, savedDec._raw);
            continue;
          }
          if (retryQueue.has(txId) || activeWorkers.has(txId)) { continue; }
          if (!resultQueue.some(i => i.txId === txId)) {
            LOG(`[BATCH-QUEUE] ${txId} keputusan approve tersimpan — masuk antrian batch approve`);
            _pushRQ({ txId, userId: _san(userId, 100), isApprove: true, rejectReason: '', _raw: savedDec._raw || null, _log: savedDec._log || null, retryCount: 0 });
          }
          tryDrainBatch();
        } else if (savedDec.isApprove === false) {
          if (_doneTxIds.get(txId) === 'REJECT') { LOG(`[RE-REJECT-CLEAR] ${txId} sudah reject — clear + re-analisa`); clearPersistedDecision(txId); _doneTxIds.delete(txId); enqueueTicket(data); continue; }
          if (badge === 'x') {
            LOG(`[MATCH-X] ${txId} red-X + TIDAK_SESUAI — auto-reject`);
            _pushRQ({ txId, userId: _san(userId, 100), isApprove: false, rejectReason: savedDec.reason || 'kode tiket tidak di temukan', _raw: null, _log: null, retryCount: 0 });
            tryDrainBatch();
            continue;
          }
          if (isPrematureRejectReason(savedDec.reason)) {
            const rqIdx = resultQueue.findIndex(i => i.txId === txId);
            if (rqIdx >= 0) resultQueue.splice(rqIdx, 1);
            LOG(`[RE-CHECK] ${txId} reject prematur (${savedDec.reason}) — verifikasi ulang, JANGAN auto-vonis`);
            clearPersistedDecision(txId);
            applyColor(row, COLOR.PEND, txId);
            if (!retryQueue.has(txId) && !activeWorkers.has(txId)) enqueueTicket(data);
            continue;
          }
          if (retryQueue.has(txId) || activeWorkers.has(txId)) { continue; }
          if (!resultQueue.some(i => i.txId === txId)) {
            LOG(`[BATCH-QUEUE] ${txId} keputusan reject tersimpan — masuk antrian batch reject`);
            _pushRQ({ txId, userId: _san(userId, 100), isApprove: false, rejectReason: savedDec.reason || 'kode tiket tidak di temukan', _raw: savedDec._raw || null, _log: savedDec._log || null, retryCount: 0 });
          }
          tryDrainBatch();
        }
        else if (savedDec.isApprove === null) { LOG(`[Resend] ${txId} SESSION_TIMEOUT — verifikasi ulang`); enqueueTicket(data); }
        continue;
      }
      if (resultQueue.some(i => i.txId === txId)) continue;
      const inQueue = retryQueue.has(txId);
      if (inQueue) {
        const state = retryQueue.get(txId);
        if (!state) continue;
        if (state.finalStatus === 'APPROVE' || state.finalStatus === 'REJECT') continue;
        if (state.success) { retryQueue.delete(txId); continue; }
        if (!rowColorMap.has(txId) && !pendingDecisionMap.has(txId)) applyColor(row, COLOR.PEND, txId);
        if (!state.processing && !activeWorkers.has(txId) && state.nextRetry <= Date.now()) processQueue();
        continue;
      }
      const existingColor = rowColorMap.get(txId);
      if (existingColor === COLOR.BLUE || existingColor === COLOR.SKIP) {
        if (existingColor === COLOR.SKIP) { continue; }
        applyColor(row, COLOR.BLUE, txId);
        continue;
      }
      const isRedColor = existingColor === COLOR.ERR || existingColor === COLOR.REJECT || existingColor === '#d50000' || existingColor === '#b71c1c';
      const isGreenColor = !isRedColor && (existingColor === COLOR.OK || existingColor === COLOR.APPROVE || existingColor === '#00c853');
      if (isRedColor || isGreenColor) {
        const badge = getActionBadge(row);
        const isUserOverride = (badge === 'check' && isRedColor) || (badge === 'x' && isGreenColor);
        if (badge === 'check' && !isUserOverride) {
          const be = _sanNum(data?.betting, 0), sc = _sanNum(data?.scatter, 0);
          const logItem = { situs: _situs, userId: _san(userId, 100), txId, betExpected: data?.betting || '0', betActual: be, scExpected: data?.scatter || '0', scActual: sc, status: 'SESUAI' };
          _pushRQ({ txId, userId: _san(userId, 100), isApprove: true, rejectReason: '', _raw: null, _log: logItem, retryCount: 0 });
          tryDrainBatch();
          continue;
        }
        if (badge === 'x' && !isUserOverride) {
          if (_doneTxIds.get(txId) === 'REJECT') { LOG(`[RE-REJECT-CLEAR] ${txId} badge-x + reject — clear + re-analisa`); _doneTxIds.delete(txId); clearPersistedDecision(txId); enqueueTicket(data); continue; }
          const be = _sanNum(data?.betting, 0), sc = _sanNum(data?.scatter, 0);
          const logItem = { situs: _situs, userId: _san(userId, 100), txId, betExpected: data?.betting || '0', betActual: be, scExpected: data?.scatter || '0', scActual: sc, status: 'TIDAK_SESUAI' };
          _pushRQ({ txId, userId: _san(userId, 100), isApprove: false, rejectReason: 'kode tiket tidak di temukan', _raw: null, _log: logItem, retryCount: 0 });
          tryDrainBatch();
          continue;
        }
        if (isUserOverride) {
          const forcedApprove = isGreenColor;
          const reason = forcedApprove ? '' : 'kode tiket tidak di temukan';
          const be = _sanNum(data?.betting, 0), sc = _sanNum(data?.scatter, 0);
          const logItem = { situs: _situs, userId: _san(userId, 100), txId, betExpected: data?.betting || '0', betActual: be, scExpected: data?.scatter || '0', scActual: sc, status: forcedApprove ? 'SESUAI' : 'TIDAK_SESUAI' };
          if (forcedApprove) {
            WARN(`[NO-APPROVE OVERRIDE] ${txId} user override approve terdeteksi (badge=${badge}) — dibatalkan, tiket dibiarkan tanpa aksi`);
            markSesuaiIgnore(txId, null);
            continue;
          }
          if (_overrideNotified.has(txId)) {
            _pushRQ({ txId, userId: _san(userId, 100), isApprove: forcedApprove, rejectReason: reason, _raw: null, _log: null, retryCount: 0 });
            tryDrainBatch();
            continue;
          }
          _overrideNotified.add(txId);
          WARN(`[GUARD-OVERRIDE] ${txId} user override terdeteksi: badge=${badge} color=${existingColor} — paksa REJECT`);
          _pushRQ({ txId, userId: _san(userId, 100), isApprove: forcedApprove, rejectReason: reason, _raw: null, _log: logItem, retryCount: 0 });
          tryDrainBatch();
          continue;
        }
        if (isRedColor && !badge) {
          const rg = _reverifyGuard.get(txId);
          const savedCol = rowColorMap.get(txId) || existingColor || COLOR.PEND;
          if (rg) {
            if (rg.count >= 5 && Date.now() - rg.t < 15000) {
              paintRowStyles(row, savedCol);
              LOG(`[GUARD-REVERIFY] ${txId} skip (red/no-badge) — ${rg.count}x re-verify dlm ${((Date.now()-rg.t)/1000).toFixed(0)}s`);
              continue;
            }
            if (Date.now() - rg.t > 15000) _reverifyGuard.set(txId, { count: 1, t: Date.now() });
            else _reverifyGuard.set(txId, { count: rg.count + 1, t: Date.now() });
          } else _reverifyGuard.set(txId, { count: 1, t: Date.now() });
          WARN(`[RE-INPUT] ${txId} previously rejected (#${_reverifyGuard.get(txId).count}) — verifikasi ulang`);
          if (_completedTx.has(txId) || _ignoredTx.has(txId)) {
            LOG(`[RE-INPUT-SKIP] ${txId} sudah selesai (completed/ignored) — warna dipertahankan, tanpa reproses`);
            paintRowStyles(row, savedCol);
            continue;
          }
          chrome.runtime.sendMessage({ action: 'removeLogEntry', txId }, () => { void chrome.runtime.lastError; });
          clearPersistedDecision(txId);
          applyColor(row, COLOR.PEND, txId);
        } else {
          paintRowStyles(row, rowColorMap.get(txId) || existingColor || COLOR.PEND);
          continue;
        }
      }
      if (_completedTx.has(txId) || _ignoredTx.has(txId)) { continue; }
      if (!bonussmbRowHasFinalColor(row, txId) && !pendingDecisionMap.has(txId)) {
        const verified = lookupVerifiedResult(txId);
        if (verified && (verified.isApprove === true || verified.isApprove === false)
            && !(verified.isApprove === false && isPrematureRejectReason(verified.reason))) {
          applyVerifiedResultToRow(data, row, verified);
          continue;
        }
      }
      if (!rowColorMap.has(txId) && !pendingDecisionMap.has(txId)) {
        LOG(`[GUARD-COLORLESS] ${txId} pending tanpa warna/keputusan — enqueue verifikasi`);
        applyColor(row, COLOR.PEND, txId);
      }
      enqueueTicket(data);
      enqueued++;
    }
    if (enqueued > 0) LOG(`${enqueued} tiket baru ditambahkan`);
    signalDoneIfClear();
    if (resultQueue.length > 0 && !isExecuting) tryDrainBatch();
    flushColorsNow();
    drainRetry();
    auditMutations();
  }

  function stopMonitorTimers() {
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
  }

  function initUserActionDetector() {
    let userDialogTxId = null, userDialogLog = null, userActionType = null;
    let _realUserClick = false;
    let _realUserClickTimer = null;
    document.addEventListener('pointerdown', e => {
      if (!e.isTrusted) return;
      const btn = e.target.closest('button');
      if (btn && (btn.textContent.includes('Ya, Setujui') || btn.textContent.includes('Ya, Tolak'))) {
        _realUserClick = true;
        if (_realUserClickTimer) clearTimeout(_realUserClickTimer);
        _realUserClickTimer = setTimeout(() => { _realUserClick = false; }, 3000);
      } else {
        _realUserClick = false;
        if (_realUserClickTimer) { clearTimeout(_realUserClickTimer); _realUserClickTimer = null; }
      }
    }, true);
    document.addEventListener('click', e => {
      if (!_realUserClick) return;
      _realUserClick = false;
      const btn = e.target.closest('button');
      if (!btn) return;
      const isSetuju = btn.textContent.includes('Ya, Setujui');
      const isTolak = btn.textContent.includes('Ya, Tolak');
      if (!isSetuju && !isTolak) return;
      const dialog = btn.closest('div[role="dialog"], div.modal, .fixed, [class*="modal"]');
      if (!dialog) return;
      const txIds = [];
      try {
        const grid = dialog.querySelector('.grid.grid-cols-\\[auto_1fr\\]');
        if (grid) {
          const allEls = Array.from(grid.querySelectorAll('span, div, p, label'));
          for (const el of allEls) {
            if (allEls.some(p => p !== el && el.contains(p))) continue;
            const t = (el.textContent || '').trim();
            const m = t.match(/\d{8,}/);
            if (m && !txIds.includes(m[0])) txIds.push(m[0]);
          }
        }
      } catch (_) {}
      if (txIds.length === 0) return;
      const cm = buildColMap();
      for (const txId of txIds) {
        const row = findRowByTxId(txId);
        if (!row) continue;
        const d = extractTicketData(row, cm);
        if (!d) continue;
        const beNum = _sanNum(d?.betting, 0);
        const scNum = _sanNum(d?.scatter, 0);
        const logItem = { situs: _situs, userId: _san(d?.userId || '', 100), txId, betExpected: d?.betting || '0', betActual: beNum, scExpected: d?.scatter || '0', scActual: scNum, status: isSetuju ? 'SESUAI' : 'TIDAK_SESUAI', mode: 'USER' };
        chrome.runtime.sendMessage({ action: 'logResult', ...logItem }, () => { void chrome.runtime.lastError; });
        _doneTxIds.set(txId, isSetuju ? 'APPROVE' : 'REJECT');
        _overrideNotified.add(txId);
        if (!isSetuju && retryQueue.size === 0 && resultQueue.length === 0 && activeWorkers.size === 0) { clearTicketTracking(txId); }
      }
      userDialogLog = null; userDialogTxId = null; userActionType = null;
    }, true);
    const observer = new MutationObserver(() => {
      if (!ctxOk()) { observer.disconnect(); return; }
      const setujuBtn = Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Setujui'));
      const tolakBtn = !setujuBtn ? Array.from(document.querySelectorAll('button')).find(b => isLikelyVisible(b) && b.textContent.includes('Ya, Tolak')) : null;
      const btn = setujuBtn || tolakBtn;
      if (btn && !isExecuting && userDialogTxId === null) {
        userActionType = setujuBtn ? 'SESUAI' : 'TIDAK_SESUAI';
        const dialog = btn.closest('div[role="dialog"], div.modal, .fixed, [class*="modal"]');
        if (dialog) {
          try {
            const grid = dialog.querySelector('.grid.grid-cols-\\[auto_1fr\\]');
            if (grid) {
              const allEls = Array.from(grid.querySelectorAll('span, div, p, label'));
              for (const el of allEls) {
                if (allEls.some(p => p !== el && el.contains(p))) continue;
                const t = (el.textContent || '').trim();
                const m = t.match(/\d{8,}/);
                if (m) { userDialogTxId = m[0]; break; }
              }
            }
          } catch (_) {}
          if (userDialogTxId) {
            const row = findRowByTxId(userDialogTxId);
            if (row) {
              const cm = buildColMap();
              const d = extractTicketData(row, cm);
              const be = _sanNum(d?.betting, 0), sc = _sanNum(d?.scatter, 0);
              userDialogLog = { situs: _situs, userId: _san(d?.userId || '', 100), txId: userDialogTxId, betExpected: be, betActual: be, scExpected: sc, scActual: sc };
            } else { userDialogTxId = null; userDialogLog = null; }
          }
        }
      }
      if (userDialogTxId && !btn && !isExecuting && !_doneTxIds.get(userDialogTxId)) {
        if (userDialogLog) {
          chrome.runtime.sendMessage({ action: 'logResult', ...userDialogLog, status: userActionType || 'USER', mode: 'USER' }, () => { void chrome.runtime.lastError; });
          _doneTxIds.set(userDialogTxId, userActionType === 'SESUAI' ? 'APPROVE' : 'REJECT');
          _overrideNotified.add(userDialogTxId);
        }
        userDialogTxId = null; userDialogLog = null; userActionType = null;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  function startEmptyQueueRefresh() {
    if (_emptyQueueTimer) clearInterval(_emptyQueueTimer);
    let idleRefreshes = 0;
    _emptyQueueTimer = setInterval(() => {
      if (!ctxOk()) { stopEmptyQueueRefresh(); return; }
      if (resultQueue.length > 0 || missingFromPageQueue.size > 0 || isExecuting || isProcessingAutomation || _postActionRefresh) { idleRefreshes = 0; return; }
      if (Date.now() - _reloadThrottle < 8000) return;
      idleRefreshes++;
      if (idleRefreshes > 5) { LOG('[EMPTY-QUEUE] 5× idle refresh tanpa progress — stop'); stopEmptyQueueRefresh(); return; }
      _reloadThrottle = Date.now();
      LOG(`[EMPTY-QUEUE] ${idleRefreshes}/5 idle — refresh halaman`);
      persistStateBeforeReload();
      setTimeout(() => { try { location.reload(); } catch (_) {} }, 100);
    }, 30000);
  }

  function stopEmptyQueueRefresh() {
    if (_emptyQueueTimer) { clearInterval(_emptyQueueTimer); _emptyQueueTimer = null; }
  }

  function schedulePostActionRefresh() {
    _postActionRefresh = true;
  }

  function setMaxPageEntries() {
    try {
      const sel = document.querySelector('select[name$="_length"], select[aria-controls], select.data-table-length, select[class*="length"], [class*="dataTable"] select, label select');
      if (!sel || sel.tagName !== 'SELECT') return;
      let maxVal = '500', maxNum = 0;
      for (const opt of sel.options) {
        const n = parseInt(opt.value, 10);
        if (n > maxNum) { maxNum = n; maxVal = opt.value; }
      }
      if (sel.value !== maxVal) {
        sel.value = maxVal;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        LOG(`[PAGE] Set entries ke ${maxVal}`);
      }
    } catch (_) {}
  }

  function init() {
    try {
    refreshCachedMode();
    setMaxPageEntries();
    injectStyles();
    injectBadge();
    injectAutoReload();
    registerTab();
    keepAliveGuard();
    loadDecisionsFromSession();
    loadPersistedColors();
    syncHighlightsFromStorage();
    loadMissingQueue();
    loadRetryQueue();
    loadCompletedTx();
    if (missingFromPageQueue.size > 0) scheduleMissingQueueRetry(500);
    updateAutomationLoops();
    startColorReapplyLoop();
    initUserActionDetector();
    window.addEventListener('beforeunload', () => { try { persistStateBeforeReload(); } catch (_) {} });
    window.addEventListener('pagehide', () => { try { persistStateBeforeReload(); } catch (_) {} });
    document.addEventListener('visibilitychange', () => {
      if (!ctxOk()) return;
      if (document.hidden) return;
      try {
        reapplyAllRowColors();
        if (isAutoMode()) {
          if (retryQueue.size > 0) processQueue();
          if (resultQueue.length > 0 && !isExecuting) tryDrainBatch();
        }
        if (missingFromPageQueue.size > 0) scheduleMissingQueueRetry(500);
        ensureKeepAlivePort();
        void scanAndProcess().catch(e => ERR('Visibility scan error:', e));
        if (isAutoMode()) void drainQueue().catch(() => {});
        touchProgress();
      } catch (e) { ERR('[visibilitychange] exception:', e.message); }
    });
    setInterval(() => {
      try {
      if (!ctxOk()) return;
      const now = Date.now();
      for (const [txId, state] of retryQueue) {
        if (state.finalStatus === 'APPROVE' || state.finalStatus === 'REJECT') { retryQueue.delete(txId); continue; }
        if (state.processing && state.updatedAt && (now - state.updatedAt) > 15000) {
          state.processing = false; state.nextRetry = now; state.updatedAt = now;
          activeWorkers.delete(txId);
        }
      }
      for (const [txId] of missingFromPageQueue) {
        if (_doneTxIds.get(txId)) { missingFromPageQueue.delete(txId); clearPersistedDecision(txId); }
      }
      const now2 = Date.now();
      for (const [txId, state] of retryQueue) {
        if (state.success || _completedTx.has(txId)) { retryQueue.delete(txId); continue; }
        if (!isTxIdInPage(txId) && state.updatedAt && (now2 - state.updatedAt) > 300000) {
          LOG(`[ORPHAN] ${txId} hilang dari page >5m tanpa hasil — pindah ke ignored`);
          _ignoredTx.add(txId); persistIgnoredTx();
          retryQueue.delete(txId); activeWorkers.delete(txId);
        }
      }
      processQueue();
      if (retryQueue.size > 0) persistRetryQueue();
      if (_completedTx.size > 0) {
        const cutoff = Date.now() - 86400000;
        for (const [txId, v] of _completedTx) { if (v.t && v.t < cutoff) _completedTx.delete(txId); }
        persistCompletedTx();
      }
      if (_ignoredTx.size > 0) {
        if (_ignoredTx.size > 500) { const arr = Array.from(_ignoredTx).slice(0, 100); _ignoredTx.clear(); arr.forEach(t => _ignoredTx.add(t)); }
      }
      if (missingFromPageQueue.size > 0) scheduleMissingQueueRetry(500);
      if (isAutoMode()) {
        if (resultQueue.length > 0 && !isExecuting) tryDrainBatch();
        drainRetry();
        hardcoreRecover();
      }
      syncAllStatesToApp();
    } catch (e) { ERR('[cleanup-interval] exception:', e.message); }
    }, 2000);
    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !ctxOk()) return;
        if (changes.ticketsUiRowColors) { const nv = changes.ticketsUiRowColors.newValue || {}; Object.keys(nv).forEach(tx => { if (nv[tx]?.color) rowColorMap.set(tx, nv[tx].color); }); reapplyAllRowColors(); }
        if (changes.marwanResults || changes.tmVerifiedResults) {
          syncHighlightsFromStorage();
          if (changes.tmVerifiedResults) void scanAndProcess();
        }
        if (changes.autoAmbilScatter || changes.autoApproveScatter || changes.operationMode) { refreshCachedMode(); updateAutomationLoops(); }
      });
    }
    startEmptyQueueRefresh();
    checkTokenFreshness().then(tok => LOG(`Token init: ${tok ? tok.slice(0, 20) + '...' : 'KOSONG'}`)).catch(e => ERR('Token init error:', e));
    setTimeout(() => { scanAndProcess().catch(e => ERR('Init scan error:', e)); }, 200);
    stopMonitorTimers();
    pollIntervalId = setInterval(() => { if (!ctxOk()) { stopMonitorTimers(); return; } scanAndProcess().catch(e => ERR('Poll scan error:', e)); }, CFG.POLL);
    setInterval(() => {
      if (!ctxOk()) return;
      if (!pollIntervalId) {
        WARN('[WATCHDOG] pollIntervalId hilang — restart');
        pollIntervalId = setInterval(() => { if (!ctxOk()) { stopMonitorTimers(); return; } scanAndProcess().catch(e => ERR('Poll scan error:', e)); }, CFG.POLL);
      }
      if (!_keepAliveAlive) { WARN('[WATCHDOG] keepAlive hilang — restart'); keepAliveGuard(); }
    }, 5000);
    touchProgress();
    LOG('TM ready');
  } catch (e) { ERR('[init] exception:', e.message); }
  }
  window.__tmForceScan = function () { if (ctxOk()) void scanAndProcess(); }; 
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'integrityWarning') {
      const existing = document.getElementById('__im_warn');
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.id = '__im_warn';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#d50000;color:#fff;padding:12px 20px;font:bold 14px monospace;text-align:left;box-shadow:0 4px 12px rgba(0,0,0,.5);max-height:40vh;overflow-y:auto;white-space:pre-wrap;word-break:break-all';
      banner.textContent = msg.text || '⚠️ PERINGATAN INTEGRITAS';
      document.body.prepend(banner);
      return true;
    }
    if (msg.action === 'bonusTicketResult') {
      try {
        if (!ctxOk()) { sendResponse({ status: 'dead' }); return true; }
        touchProgress();
        const txId = msg.transactionId;
        if (_doneTxIds.get(txId)) { LOG(`[API-GUARD] ${txId} sudah done — ignore`); retryQueue.delete(txId); activeWorkers.delete(txId); processQueue(); sendResponse({ status: 'already_done' }); return true; }
        if (msg.invalidOperatorSession === true || String(msg?.overallStatus || '').toUpperCase() === 'INVALID_SESSION') {
          LOG(`[INVALID-SESSION] ${txId} — skip antrean, mark HITAM (tanpa approve/reject)`);
          retryQueue.delete(txId);
          activeWorkers.delete(txId);
          clearMissingDataRetry(txId);
          rowColorMap.set(txId, COLOR.BLACK);
          const row = findRowByTxId(txId);
          if (row) applyColor(row, COLOR.BLACK, txId);
          else safeApplyColor(txId, COLOR.BLACK, 250, 3);
          _ignoredTx.add(txId);
          _doneTxIds.set(txId, 'SKIP');
          processQueue();
          sendResponse({ status: 'skipped' });
          return true;
        }
        const decision = shouldApproveFromResult(msg);
        activeWorkers.delete(txId);
        if (activeWorkers.size === 0 && resultQueue.length > 0) { setTimeout(() => tryDrainBatch(), 0); }
        const stateNow = retryQueue.get(txId);
        let freshRow = findRowByTxId(txId);
        if (freshRow) {
          const freshCheck = extractTicketData(freshRow, buildColMap());
          const apiUserId = _san(msg.userId, 100);
          if (freshCheck && apiUserId && freshCheck.userId && freshCheck.userId !== apiUserId) {
            WARN(`[GUARD userId] ${txId} table userId "${freshCheck.userId}" ≠ API userId "${apiUserId}" — mencari row yang benar`);
            freshRow = null;
            for (const rr of getRows()) {
              const dd = extractTicketData(rr, buildColMap());
              if (dd && dd.userId === apiUserId && dd.txId === txId) { freshRow = rr; break; }
            }
            if (!freshRow) {
              WARN(`[GUARD userId] ${txId} tidak ada row dengan userId="${apiUserId}" — reject`);
              const reason = `UserId mismatch: table="${freshCheck.userId}" api="${apiUserId}"`;
              commitFinalVerdict(txId, false, reason, msg, { txId, userId: apiUserId, isApprove: false, rejectReason: reason, _raw: null, _log: msg._log || null, retryCount: 0 });
              if (!isExecuting) tryDrainBatch();
              sendResponse({ status: 'guard_userid_mismatch' }); return true;
            }
          }
        }
        const freshData = freshRow ? extractTicketData(freshRow, buildColMap()) : null;
        const reqNow = hasRequiredDataForDecision({
          betting: freshData?.betting || stateNow?.betting || '',
          scatter: freshData?.scatter || stateNow?.scatter || ''
        });
        if (!reqNow.ok && decision !== true) {
          const mr = markMissingDataRetry(txId);
          if (decision === false && mr.count >= 2) {
            clearMissingDataRetry(txId);
            retryQueue.delete(txId);
            const reason = buildRejectReason(msg.betCheckStatus, msg.scatterCheckStatus, msg.hadiahStatus, msg.debetValue, msg.scatterTitle, msg.expectedPrize);
            LOG(`[API-REJECT] ${txId} ${mr.count}x TIDAK_SESUAI reject — ${reason}`);
            commitFinalVerdict(txId, false, reason, msg, { txId, userId: _san(msg.userId, 100), isApprove: false, rejectReason: reason, _raw: null, _log: msg._log || null, retryCount: 0 });
            if (!isExecuting) tryDrainBatch();
            sendResponse({ status: 'queued' }); return true;
          }
          const s = retryQueue.get(txId);
          if (mr.exceed) {
            clearMissingDataRetry(txId);
            LOG(`[MUTASI-EXCEED] ${txId} ${mr.count}x data kosong — re-enqueue`);
            retryQueue.delete(txId);
            const row = findRowByTxId(txId);
            if (row) {
              const data = extractTicketData(row, buildColMap());
              if (data) enqueueTicket(data);
            }
            sendResponse({ status: 'retry_missing_data' }); return true;
          }
          if (s) {
            s.processing = false;
            s.nextRetry = Date.now() + 450;
            s.updatedAt = Date.now();
          }
          const retryRow = findRowByTxId(txId);
          if (retryRow) applyColor(retryRow, COLOR.PEND, txId);
          processQueue();
          sendResponse({ status: 'retry_missing_data' }); return true;
        }
        clearMissingDataRetry(txId);
        if (decision === 'SESSION_TIMEOUT') {
          const s = retryQueue.get(txId);
          if (s) { s.processing = false; s.nextRetry = Date.now() + 2000; s.updatedAt = Date.now(); }
          persistDecision(txId, null, '', msg);
          _pushRQ({ txId, userId: _san(msg.userId, 100), isApprove: 'SESSION_TIMEOUT', rejectReason: '', _raw: null, retryCount: 0 });
          if (!isExecuting) tryDrainBatch();
          sendResponse({ status: 'queued_timeout' }); return true;
        }
        if (decision === 'RETRY') {
          const s = retryQueue.get(txId);
          if (s) { s.processing = false; s.nextRetry = Date.now() + 300; s.retryCount = (s.retryCount || 0) + 1; s.lastError = 'retryable'; s.updatedAt = Date.now(); }
          else { const row = findRowByTxId(txId); if (row) { const d = extractTicketData(row, buildColMap()); if (d) enqueueTicket(d); } }
          persistDecision(txId, null, 'RETRY', msg);
          const retryRow = findRowByTxId(txId);
          if (retryRow) applyColor(retryRow, COLOR.PEND, txId);
          processQueue();
          sendResponse({ status: 'retry' }); return true;
        }
        if (decision === true) {
          retryQueue.delete(txId);
          const scatterNum = parseInt(String(msg?.scatterTitle || '').replace(/[^0-9]/g, ''), 10);
          if (isNaN(scatterNum) || scatterNum < 3 || scatterNum > 5) {
            WARN(`[GUARD FINAL] Scatter ${scatterNum} tidak valid — blokir approve ${txId}`);
            const reason = `Scatter tidak valid: ${msg?.scatterTitle || 'kosong'} (harus 3-5)`;
            LOG(`Hasil: ${txId} → TIDAK_SESUAI | ${reason}`);
            commitFinalVerdict(txId, false, reason, msg, { txId, userId: _san(msg.userId, 100), isApprove: false, rejectReason: reason, _raw: null, _log: msg._log || null, retryCount: 0 });
            if (!isExecuting) tryDrainBatch();
            sendResponse({ status: 'queued' }); return true;
          }
          const sesuaiRow = findRowByTxId(txId);
          if (sesuaiRow && getActionBadge(sesuaiRow) === 'x') {
            LOG(`Hasil: ${txId} → SESUAI tapi badge MERAH (X) — diabaikan, biarkan user yang menentukan approve/reject`);
            markSesuaiIgnore(txId, msg);
            if (!isExecuting) tryDrainBatch();
            sendResponse({ status: 'ignored' }); return true;
          }
          LOG(`Hasil: ${txId} → SESUAI`);
          commitFinalVerdict(txId, true, '', msg, { txId, userId: _san(msg.userId, 100), isApprove: true, rejectReason: '', _raw: msg, _log: msg._log || null, retryCount: 0 });
          if (!isExecuting) tryDrainBatch();
          sendResponse({ status: 'queued' }); return true;
        }
        retryQueue.delete(txId);
        const reason = msg.klaimRejectReason || (msg.fromKlaim && msg.klaimDetail ? `${msg.klaimLabel || 'TIDAK COCOK'} — ${msg.klaimDetail}` : '') || buildRejectReason(msg.betCheckStatus, msg.scatterCheckStatus, msg.hadiahStatus, msg.debetValue, msg.scatterTitle, msg.expectedPrize);
        const label = msg.klaimLabel || 'TIDAK_SESUAI';
        LOG(`Hasil: ${txId} → ${label}${msg.klaimDetail ? ' | ' + msg.klaimDetail : ''}`);
        commitFinalVerdict(txId, false, reason, msg, { txId, userId: _san(msg.userId, 100), isApprove: false, rejectReason: _san(reason, 500), _raw: null, _log: msg._log || null, retryCount: 0 });
        if (!isExecuting) tryDrainBatch();
        sendResponse({ status: 'queued' }); return true;
      } catch (e) { ERR('bonusTicketResult error:', e.message); try { sendResponse({ status: 'error', reason: e.message }); } catch (_) {} return true; }
    }
    if (msg.action === 'triggerScan') {
      if (!ctxOk()) { stopMonitorTimers(); sendResponse({ status: 'dead' }); return true; }
      chrome.storage.local.get(['operationMode'], function (res) {
        if ((res.operationMode || 'MANUAL') === 'MANUAL') { sendResponse({ status: 'manual' }); return; }
        _cachedOperationMode = (res.operationMode || 'MANUAL').toUpperCase();
        reapplyAllRowColors();
        if (isBusy()) { processQueue(); if (resultQueue.length > 0 && !isExecuting) tryDrainBatch(); sendResponse({ status: 'busy_partial' }); return; }
        void scanAndProcess();
        sendResponse({ status: 'ok' });
      });
      return true;
    }
    if (msg.action === 'forceProcessQueue') {
      if (!ctxOk()) { sendResponse({ status: 'dead' }); return true; }
      chrome.storage.local.get(['operationMode'], (res) => {
        const mode = (res.operationMode || 'MANUAL').toUpperCase();
        _cachedOperationMode = mode;
        if (mode !== 'AUTO') { sendResponse({ status: 'manual' }); return; }
        try {
          if (isExecuting && executingSince && Date.now() - executingSince > 60000) { isExecuting = false; executingSince = 0; }
          reapplyAllRowColors();
          for (const [txId, state] of retryQueue) {
            if (state.processing && state.updatedAt && (Date.now() - state.updatedAt) > 15000) {
              state.processing = false; state.nextRetry = Date.now(); state.updatedAt = Date.now();
              activeWorkers.delete(txId);
            }
            if (state.finalStatus === 'APPROVE' || state.finalStatus === 'REJECT') { retryQueue.delete(txId); continue; }
          }
          processQueue();
          drainRetry();
          hardcoreRecover();
          if (resultQueue.length > 0 && !isExecuting) tryDrainBatch();
          void scanAndProcess().catch(() => {});
          schedulePersistAll();
        } catch (_) {}
        sendResponse({ status: 'ok' });
      });
      return true;
    }
    if (msg.action === 'keepAlivePong') {
      _keepAliveReconnects = 0;
      if (!_keepAlivePort) ensureKeepAlivePort();
      if (ctxOk() && isAutoMode()) {
        try {
          if (isExecuting && executingSince && Date.now() - executingSince > 60000) { isExecuting = false; executingSince = 0; }
          for (const [txId, state] of retryQueue) {
            if (state.processing && state.updatedAt && (Date.now() - state.updatedAt) > 15000) {
              state.processing = false; state.nextRetry = Date.now(); state.updatedAt = Date.now();
              activeWorkers.delete(txId);
            }
          }
          processQueue();
          drainRetry();
          hardcoreRecover();
          if (resultQueue.length > 0 && !isExecuting) tryDrainBatch();
          void scanAndProcess().catch(() => {});
          schedulePersistAll();
        } catch (_) {}
      }
      sendResponse({ status: 'ok' });
      return true;
    }
    if (msg.action === 'getQueueStatus') { sendResponse({ status: 'ok', ...getQueueStatusPayload() }); return true; }
    return false;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 450));
  else setTimeout(init, 450);
  window.__tmRetryMissing = function () { if (!_missingProcessing) scheduleMissingQueueRetry(500); };
  window.__tmProcessQueue = processQueue;
}