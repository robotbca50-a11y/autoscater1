importScripts('lib/constants.js', 'lib/utils.js', 'lib/parser.js', 'lib/token.js');
let _cryptoKey = null;
const CRYPTO_KEY_STORE = '_encKey_v2';
let _tgMsgQueue = [];

async function getCryptoKey() {
  if (_cryptoKey) return _cryptoKey;
  const { [CRYPTO_KEY_STORE]: raw } = await getS([CRYPTO_KEY_STORE]);
  if (raw) {
    try {
      const buf = Uint8Array.from(atob(raw), c => c.charCodeAt(0)).buffer;
      _cryptoKey = await crypto.subtle.importKey('raw', buf, 'AES-GCM', false, ['encrypt', 'decrypt']);
      return _cryptoKey;
    } catch (_) { _cryptoKey = null; }
  }
  try {
    _cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', _cryptoKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    await setS({ [CRYPTO_KEY_STORE]: b64 });
  } catch (_) { _cryptoKey = null; }
  return _cryptoKey;
}

async function encryptData(plainObj) {
  try {
    const key = await getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(plainObj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0); combined.set(new Uint8Array(cipher), iv.length);
    return btoa(String.fromCharCode(...combined));
  } catch (_) { return null; }
}

async function decryptData(b64) {
  try {
    const key = await getCryptoKey();
    const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(new TextDecoder().decode(dec));
  } catch (_) { return null; }
}

async function secureSetS(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (k.startsWith('appLog_')) {
      const enc = await encryptData(obj[k]);
      if (enc) obj[k] = enc;
    }
  }
  await setS(obj);
}

async function secureGetS(keys) {
  if (!Array.isArray(keys) || !keys.length) return {};
  const raw = await getS(keys);
  for (const k of keys) {
    if (k.startsWith('appLog_') && typeof raw[k] === 'string' && raw[k].length > 20) {
      const dec = await decryptData(raw[k]);
      if (dec) raw[k] = dec;
    }
  }
  return raw;
}
const INTEGRITY_WATCHED = ['background.js', 'tickets_monitor.js', 'lib/constants.js', 'lib/utils.js', 'lib/parser.js', 'lib/token.js'];
const INTEGRITY_STORE = '_integrityData';
const INTEGRITY_CONTENT = '_integrityContent';

async function computeFileHash(path) {
  try {
    const r = await fetch(chrome.runtime.getURL(path));
    const buf = await r.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return { hash: Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join(''), content: new TextDecoder().decode(buf) };
  } catch (_) { return null; }
}

function computeDiff(oldText, newText) {
  if (!oldText) return ['[file baru]'];
  const oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
  const newLines = newText.replace(/\r\n/g, '\n').split('\n');
  const result = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let changeCount = 0;
  for (let i = 0; i < maxLen && result.length < 15; i++) {
    const oldL = i < oldLines.length ? oldLines[i] : '';
    const newL = i < newLines.length ? newLines[i] : '';
    if (oldL !== newL) {
      changeCount++;
      if (result.length < 12) {
        const ln = `L${i + 1}`;
        if (!oldL && newL) result.push(`  + ${ln}: ${newL.slice(0, 80)}`);
        else if (oldL && !newL) result.push(`  - ${ln}: ${oldL.slice(0, 80)}`);
        else result.push(`  ~ ${ln}: ${oldL.slice(0, 40)} → ${newL.slice(0, 40)}`);
      }
    }
  }
  if (changeCount > result.length) result.push(`  ... +${changeCount - result.length} perubahan lagi`);
  return result;
}

async function checkIntegrity() {
  const { [INTEGRITY_STORE]: stored } = await getS([INTEGRITY_STORE]);
  const { [INTEGRITY_CONTENT]: contentStore = {} } = await getS([INTEGRITY_CONTENT]);
  const newHashes = {}, newContent = {};
  for (const f of INTEGRITY_WATCHED) {
    const res = await computeFileHash(f);
    if (!res) continue;
    newHashes[f] = res.hash;
    newContent[f] = res.content;
    if (stored && stored[f] && stored[f] !== res.hash) {
      const diff = computeDiff(contentStore[f] || '', res.content);
      const totalLines = res.content.replace(/\r\n/g, '\n').split('\n').length;
      const shown = diff.filter(l => !l.startsWith(' ...')).length;
      const more = diff.find(l => l.startsWith(' ...'));
      const msg = `⚠️ INTEGRITAS\n📄 ${f}\n📏 ${shown} perubahan · ${totalLines} baris\n${diff.join('\n')}`;
      enqueueTgMessage(msg);
    }
  }
  await setS({ [INTEGRITY_STORE]: newHashes, [INTEGRITY_CONTENT]: newContent });
}
let isQueueRunning = false;
let bonusTicketsTabId = null;
let lastSmbScanTime = 0;
const finalized = new Set();
const retryQueue = new Map();
const activeWorkers = new Set();
let autoTokenRefreshTimer = null;
let klaimActiveJobs = 0;
let klaimKeepAliveTimer = null;
const processingTxLocks = new Set();
const finalizeLocks = new Set();

function ck(userId, txId) {
  return (String(userId || '?') + '|' + String(txId || '?'));
}

async function getSitus() {
  try {
    const { adminUrl, sniffedFrom } = await getS(['adminUrl', 'sniffedFrom']);
    const url = adminUrl || sniffedFrom || '';
    const host = url.replace(/https?:\/\//, '').split('/')[0].split('?')[0];
    const sub = host.split('.')[0] || '';
    return sub.replace(/^(ag-|AG-)/i, '') || 'unknown';
  } catch (_) { return 'unknown'; }
}

function enqueueVerifyTicket(ticketData) {
  if (!ticketData || typeof ticketData !== 'object') return;
  const txId = sanitize(String(ticketData.transactionId || '').trim());
  const userId = sanitize(String(ticketData.userId || '').trim());
  const key = ck(userId, txId);
  if (!txId) return;
  const existing = retryQueue.get(key);
  if (existing) {
    if (existing.finalStatus === 'APPROVE' || existing.finalStatus === 'REJECT') {
      retryQueue.delete(key);
    } else {
      for (const k of Object.keys(ticketData)) { if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') existing[k] = ticketData[k]; }
      existing.updatedAt = Date.now();
      return;
    }
  }
  retryQueue.set(key, {
    txId, userId, key,
    betting: sanitize(String(ticketData.betting || ''), 50),
    scatterCount: sanitize(String(ticketData.scatterCount || ''), 20),
    hadiah: sanitize(String(ticketData.hadiah || ''), 200),
    status: sanitize(String(ticketData.status || ''), 30),
    retryCount: 0, processing: false, success: false,
    nextRetry: 0, lastError: null, addedAt: Date.now(), updatedAt: Date.now(),
    tabId: ticketData.tabId || null
  });
  processVerifyQueue();
}

function processVerifyQueue() {
  if (activeWorkers.size >= APP.MAX_WORKERS) return;
  const now = Date.now();
  for (const [key, state] of retryQueue) {
    if (state.processing && state.updatedAt && (now - state.updatedAt) > 15000) {
      state.processing = false; state.nextRetry = now; state.updatedAt = now;
      activeWorkers.delete(key);
    }
  }
  for (const [key, state] of retryQueue) {
    if (activeWorkers.size >= APP.MAX_WORKERS) break;
    if (state.finalStatus === 'APPROVE' || state.finalStatus === 'REJECT' || state.finalStatus === 'SKIP' || state.success) { retryQueue.delete(key); continue; }
    if (state.processing || state.nextRetry > Date.now()) continue;
    activeWorkers.add(key);
    runVerifyWorker(key);
  }
}

async function runVerifyWorker(key) {
  if (!key) { activeWorkers.delete(key); return; }
  const state = retryQueue.get(key);
  if (!state) { activeWorkers.delete(key); return; }
  state.processing = true; state.retryCount++; state.updatedAt = Date.now();
  if (state.finalStatus === undefined) state.finalStatus = null;
  const txId = state.txId;
  const userId = state.userId;
  try {
    const td = { userId, transactionId: txId, betting: state.betting, scatterCount: state.scatterCount, hadiah: state.hadiah, status: state.status };
    runBonusKlaimVerify(td, state.tabId || bonusTicketsTabId).then(() => {
      const s = retryQueue.get(key);
      if (s && (s.finalStatus === 'APPROVE' || s.finalStatus === 'REJECT' || s.finalStatus === 'SKIP')) retryQueue.delete(key);
      else if (s) { s.processing = false; s.nextRetry = Date.now() + 1500; s.updatedAt = Date.now(); }
      activeWorkers.delete(key); processVerifyQueue();
    }).catch(err => {
      const s = retryQueue.get(key);
      if (s) { s.lastError = err.message; s.processing = false; s.nextRetry = Date.now() + 300; s.updatedAt = Date.now(); }
      activeWorkers.delete(key); processVerifyQueue();
    });
  } catch (err) {
    state.lastError = err.message; state.processing = false; state.nextRetry = Date.now() + 300;
    activeWorkers.delete(key); processVerifyQueue();
  }
}

async function clearInflight(key) {
  const { ticketsInflight = {} } = await getS(['ticketsInflight']);
  if (!ticketsInflight[key]) return;
  const ni = { ...ticketsInflight };
  delete ni[key];
  await setS({ ticketsInflight: ni });
}

async function queryTicketsTabs() {
  try {
    const out = []; const seen = new Set();
    for (const pat of TICKETS_TAB_URLS) {
      const chunk = await new Promise(ok => chrome.tabs.query({ url: pat }, ok));
      if (chrome.runtime.lastError) continue;
      for (const t of chunk || []) {
        if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
      }
    }
    return out;
  } catch (_) { return []; }
}

async function persistTicketVerified(txId, status, userId) {
  if (!txId) return;
  const key = ck(userId, txId);
  const { ticketsDbChecked = {}, ticketsInflight = {}, ticketsActionDone = {} } = await getS(['ticketsDbChecked', 'ticketsInflight', 'ticketsActionDone']);
  const infl = { ...ticketsInflight }; delete infl[key];
  const db = { ...ticketsDbChecked, [key]: { t: Date.now(), s: status || '' } };
  const done = { ...ticketsActionDone, [key]: { t: Date.now(), a: status || '', u: userId || '' } };
  const keys = Object.keys(db);
  if (keys.length > APP.MAX_TICKETS_DB) { keys.sort((a, b) => (db[a].t || 0) - (db[b].t || 0)); for (let i = 0; i < keys.length - APP.MAX_TICKETS_DB; i++) delete db[keys[i]]; }
  const doneKeys = Object.keys(done);
  if (doneKeys.length > APP.MAX_TICKETS_DB) { doneKeys.sort((a, b) => (done[a].t || 0) - (done[b].t || 0)); for (let i = 0; i < doneKeys.length - APP.MAX_TICKETS_DB; i++) delete done[doneKeys[i]]; }
  await setS({ ticketsDbChecked: db, ticketsInflight: infl, ticketsActionDone: done });
}

async function notifyTicketsTabRescan() {
  try {
    const tabs = await queryTicketsTabs();
    const tid = tabs[0]?.id || bonusTicketsTabId;
    if (!tid) return;
    await chrome.tabs.sendMessage(tid, { action: 'triggerScan' }).catch(() => null);
  } catch (_) {}
}

async function scanTicketsAndClose() {
  if (!(await isAutoModeReady())) return;
  lastSmbScanTime = Date.now();
  let tabId;
  if (bonusTicketsTabId) {
    try {
      const t = await new Promise((ok, fail) => { chrome.tabs.get(bonusTicketsTabId, tab => { if (chrome.runtime.lastError) fail(new Error('tab gone')); else ok(tab); }); });
      if (t?.url && /bonussmb\.com\/tickets/i.test(t.url)) tabId = bonusTicketsTabId;
    } catch (_) { bonusTicketsTabId = null; }
  }
  if (!tabId) {
    const tabs = await queryTicketsTabs();
    if (tabs?.length > 0) { tabId = tabs[0].id; bonusTicketsTabId = tabId; }
  }
  if (!tabId) {
    try {
      const tab = await safeTabCreate(URLS.TICKETS, { active: false });
      bonusTicketsTabId = tab.id; tabId = tab.id;
      notify(`[SMB] Buka tab bonussmb/tickets (${new Date().toLocaleTimeString()})`);
      await waitTab(tab.id, 20000); await sleep(500);
    } catch (e) { notify('[SMB] Gagal buka tab: ' + e.message); return; }
  }
  let busy = false;
  try {
    const q = await chrome.tabs.sendMessage(tabId, { action: 'getQueueStatus' }).catch(() => null);
    busy = !!(q && (q.executing || (q.verifyingCount || 0) > 0 || (q.queueCount || 0) > 0));
  } catch (_) {}
  if (busy) {
    try { await chrome.tabs.sendMessage(tabId, { action: 'forceProcessQueue' }).catch(() => {}); } catch (_) {}
    return;
  }
  try { await chrome.tabs.sendMessage(tabId, { action: 'forceProcessQueue' }).catch(() => {}); } catch (_) {}
}

async function isAutoModeReady() {
  const { adminUrl, token, executorName, operationMode, sniffedAt } = await getS(['adminUrl', 'token', 'executorName', 'operationMode', 'sniffedAt']);
  if (operationMode === 'MANUAL') return false;
  const tokenOk = !!(token && token.length >= 10);
  const snifferRecentlyActive = !!(sniffedAt && (Date.now() - sniffedAt) < APP.SNIFFER_ACTIVE_TTL_MS);
  return !!(adminUrl && (tokenOk || snifferRecentlyActive) && executorName);
}

function setupHeaderSniffer() {
  if (!chrome.webRequest?.onBeforeSendHeaders) return;
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!details?.requestHeaders || !details.url) return;
      chrome.storage.local.get(['targetDomain'], res => {
        void chrome.runtime.lastError;
        if (!urlMatchesSnifferTarget(details.url, res.targetDomain)) return;
        const headers = details.requestHeaders;
        let host = '';
        try { host = new URL(details.url).hostname; } catch (_) {}
        const authHeader = headers.find(h => h.name.toLowerCase() === 'x-access-token');
        if (authHeader?.value && authHeader.value.length >= 10) {
          const grabbed = {
            token: authHeader.value,
            userid: (headers.find(h => h.name.toLowerCase() === 'x-agent-userid') || {}).value || '',
            pkid: (headers.find(h => h.name.toLowerCase() === 'x-agent-pkid') || {}).value || '',
            role: (headers.find(h => h.name.toLowerCase() === 'x-agent-role') || {}).value || '',
            suid: (headers.find(h => h.name.toLowerCase() === 'x-agent-suid') || {}).value || '',
            userAgent: (headers.find(h => h.name.toLowerCase() === 'x-agent-user') || {}).value || '',
            sniffedAt: Date.now(), sniffedFrom: host
          };
          chrome.storage.local.set(grabbed, () => { void chrome.runtime.lastError; });
          try {
            const parsed = new URL(details.url);
            const autoBase = parsed.protocol + '//' + parsed.host;
            chrome.storage.local.get(['adminUrl'], r2 => {
              void chrome.runtime.lastError;
              if (!r2.adminUrl || r2.adminUrl !== autoBase) {
                chrome.storage.local.set({ adminUrl: autoBase }, () => { void chrome.runtime.lastError; });
                chrome.runtime.sendMessage({ action: 'adminUrlUpdated', adminUrl: autoBase }).catch(() => {});
              }
            });
          } catch (_) {}
          saveToken(authHeader.value).catch(() => {});
          chrome.runtime.sendMessage({ action: 'tokenUpdated', token: authHeader.value }).catch(() => {});
        }
        if (/\.idrbo(1|2|3)?\.com$|idrbo(1|2|3)?\.com$/.test(host)) {
          for (const header of headers) {
            const name = (header.name || '').toLowerCase();
            const value = header.value || '';
            if (!SNIFFER_HEADERS.includes(name)) continue;
            const clean = value.replace(/^Bearer\s+/i, '').trim();
            if (!looksLikeToken(clean)) continue;
            saveToken(clean).then(saved => { if (saved) notify(`Token auto-captured dari ${host}`); }).catch(() => {});
            chrome.storage.local.set({ sniffedAt: Date.now(), sniffedFrom: host }, () => { void chrome.runtime.lastError; });
            break;
          }
        }
        try {
          const tk = extractToken(details.url);
          if (tk && tk.length >= 10) saveHistoryToken(tk).catch(() => {});
        } catch (_) {}
      });
    },
    { urls: ['*://*.idrbo.com/*', '*://*.idrbo1.com/*', '*://*.idrbo2.com/*', '*://*.idrbo3.com/*', '*://*.bandar80.idrbo2.com/*', '*://bandar80.idrbo2.com/*'] },
    ['requestHeaders', 'extraHeaders']
  );
}

setupHeaderSniffer();

async function klaimFetchScatterPg(mId, sId, gameId, domain) {
  let token = await getAutoTokenFromTab(mId, sId, gameId, domain);
  if (!token) throw new Error('Token history tidak ditemukan');
  const doFetch = async tk => {
    const res = await fetch(`${URLS.HISTORY_API}?t=${encodeURIComponent(tk)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `sid=${encodeURIComponent(sId)}&gid=${encodeURIComponent(gameId)}`
    });
    if (!res.ok) throw new Error(`Gagal akses JSON history: ${res.status}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json')) {
      let j = null;
      try { j = await res.clone().json(); } catch (_) {}
      if (j && klaimInvalidSessionMsg(j)) throw new Error('INVALID_OPERATOR_SESSION: ' + klaimInvalidSessionText(j));
    }
    const d = await res.json();
    const raw = parseInt(klaimSimpleExtractScatter(d), 10) || 0;
    if (raw < 3 || raw > 5) {
      const alt = klaimScatterFallbackExtract(d);
      if (alt >= 3 && alt <= 5) return alt;
      throw new Error(`Scatter tidak valid (ditemukan: ${raw}) — data mungkin belum siap`);
    }
    return raw;
  };
  try {
    return await doFetch(token);
  } catch (err) {
    if (!isSessionOrUnknownError(err.message)) {
      if (err.message.includes('Scatter tidak valid')) {
        token = await forceRefreshHistoryToken(mId, sId, gameId, domain);
        if (!token) throw new Error('Token history tidak ditemukan setelah refresh');
        return doFetch(token);
      }
      throw err;
    }
    token = await forceRefreshHistoryToken(mId, sId, gameId, domain);
    if (!token) throw new Error('Token history tidak ditemukan setelah refresh');
    return doFetch(token);
  }
}
function klaimMaxScatterInBd(pgData) {
  const bd = pgData?.dt?.bh?.bd;
  if (!Array.isArray(bd)) return null;
  let max = 0;
  for (const item of bd) {
    const gd = item?.gd || {};
    const st = Number(gd.st);
    const sc = Number(gd.sc);
    if (st >= 21) continue;
    if (isFinite(sc) && sc > max) max = sc;
  }
  return max;
}
function klaimScatter_FreeSpin(pgData) {
  const bd = pgData?.dt?.bh?.bd;
  if (!Array.isArray(bd)) return null;
  for (let i = 0; i < bd.length; i++) {
    const gd = bd[i]?.gd || {};
    const st = Number(gd.st);
    const sc = Number(gd.sc);
    if (!isFinite(sc) || st !== 4) continue;
    if (Number(gd.nst) === 21 && sc > 0) {
      if (sc >= 5) {
        let maxSc = sc;
        for (let j = i + 1; j < bd.length; j++) {
          const g2 = bd[j]?.gd || {};
          const s2 = Number(g2.st);
          const c2 = Number(g2.sc);
          if (!isFinite(c2)) continue;
          if (s2 >= 4 && s2 < 21 && c2 > maxSc) maxSc = c2;
        }
        return maxSc;
      }
      return sc;
    }
  }
  return null;
}

function klaimScatter_TriggerSpin(pgData) {
  const bd = pgData?.dt?.bh?.bd;
  if (!Array.isArray(bd)) return null;
  for (let i = 0; i < bd.length; i++) {
    const gd = bd[i]?.gd || {};
    const st = Number(gd.st);
    const nst = Number(gd.nst);
    const sc = Number(gd.sc);
    if (!isFinite(sc)) continue;
    if (st < 4 && nst >= 4 && sc >= 3) return sc;
  }
  return null;
}

function klaimScatterConsensus(pgData) {
  const r1 = klaimScatter_FreeSpin(pgData);
  const r2 = klaimMaxScatterInBd(pgData);
  const r3 = klaimScatter_TriggerSpin(pgData);
  const valid = v => v !== null && v >= 3 && v <= 5;
  if (valid(r1) && valid(r2) && valid(r3)) {
    if (r1 === r2 || r1 === r3) return r1;
    if (r2 === r3) return r2;
    return r1;
  }
  if (valid(r1)) return r1;
  if (valid(r2)) return r2;
  if (valid(r3)) return r3;
  return null;
}

function klaimTriggerScatterInBd(pgData) {
  return klaimScatterConsensus(pgData);
}
function klaimScatterFallbackExtract(pgData) {
  if (!pgData || typeof pgData !== 'object') return 0;
  const paths = [
    () => { const t = klaimTriggerScatterInBd(pgData); return t !== null && t > 0 ? Math.min(t, 5) : 0; },
    () => { const maxSc = klaimMaxScatterInBd(pgData); return maxSc !== null ? Math.min(maxSc, 5) : 0; },
    () => { const v = klaimSimpleFindScatterRecursive(pgData); return v ? Math.min(parseInt(String(v), 10) || 0, 5) : 0; },
    () => { const s = JSON.stringify(pgData); const m = s.match(/"sc"\s*:\s*([3-9])/); return m ? Math.min(parseInt(m[1], 10), 5) : 0; },
    () => { const s = JSON.stringify(pgData); const m = s.match(/"scatterCount"\s*:\s*([3-9])/i); return m ? Math.min(parseInt(m[1], 10), 5) : 0; }
  ];
  for (const fn of paths) { try { const v = fn(); if (v >= 3 && v <= 5) return v; } catch (_) {} }
  return 0;
}

function klaimSimpleExtractScatter(pgData) {
  const trig = klaimTriggerScatterInBd(pgData);
  if (trig !== null && trig > 0) return String(Math.min(trig, 5));
  const maxSc = klaimMaxScatterInBd(pgData);
  if (maxSc !== null && maxSc > 0) return String(Math.min(maxSc, 5));
  const bd = pgData?.dt?.bh?.bd;
  if (Array.isArray(bd)) {
    const scatterTrigger = bd.find(item => Number(item?.gd?.st) === 4 && Number(item?.gd?.nst) === 21);
    if (scatterTrigger) return String(Math.min(Number(scatterTrigger?.gd?.sc ?? 0), 5));
  }
  const found = klaimSimpleFindScatterRecursive(pgData);
  const fv = Number(found ?? 0);
  return String(fv > 0 ? Math.min(fv, 5) : '0');
}

function klaimSimpleFindScatterRecursive(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) return null;
  if (Number(value?.gd?.st) === 4 && Number(value?.gd?.nst) === 21 && value.gd.sc !== undefined) return value.gd.sc;
  if (Number(value?.st) === 4 && Number(value?.nst) === 21 && value.sc !== undefined) return value.sc;
  if (Array.isArray(value)) { for (const item of value) { const f = klaimSimpleFindScatterRecursive(item, depth + 1); if (f !== null) return f; } return null; }
  for (const key of Object.keys(value)) { const f = klaimSimpleFindScatterRecursive(value[key], depth + 1); if (f !== null) return f; }
  return null;
}

function klaimInvalidSessionMsg(json) {
  if (!json || typeof json !== 'object') return null;
  const msg = String(json?.message ?? json?.msg ?? json?.Msg ?? json?.msg_text ?? json?.detail ?? json?.error ?? json?.desc ?? '').toLowerCase();
  const cd = String(json?.cd ?? json?.code ?? json?.status ?? json?.codeId ?? json?.code_id ?? '').trim();
  if (msg.includes('invalid operator session') || msg.includes('session invalid') || msg.includes('invalid session') || msg.includes('session expired') || msg.includes('expired session') || msg.includes('invalid token') || msg.includes('token expired') || msg.includes('session tidak valid')) return true;
  if (cd === '2001') return true;
  return false;
}

function klaimInvalidSessionText(json) {
  const j = json && typeof json === 'object' ? json : {};
  return String(j?.message ?? j?.msg ?? j?.detail ?? j?.error ?? j?.desc ?? 'Invalid operator session').slice(0, 120);
}

async function klaimMainProcessor(payload) {
  const { mId, sId, expectedBet = 0, expectedScatter = 0 } = payload;
  const targetDate = payload.targetDate || todayStr();
  const st = await getS(['token', 'userid', 'pkid', 'role', 'suid', 'userAgent', 'adminUrl', 'sniffedFrom']);
  if (!st.token || st.token.length < 10) throw new Error('Token belum ada — buka halaman admin (Header Sniffer)');
  const domainCandidates = [];
  const pushDomain = raw => { const d = getDomainFromUrl(raw); if (d && !domainCandidates.includes(d)) domainCandidates.push(d); };
  if (Array.isArray(payload.domains) && payload.domains.length) { for (const d of payload.domains) pushDomain(d); }
  pushDomain(st.adminUrl); pushDomain(st.sniffedFrom);
  if (!domainCandidates.length) domainCandidates.push('bandar80.idrbo2.com');
  const datesToTry = [targetDate];
  const td = new Date(targetDate);
  for (let i = 1; i <= 3; i++) { const prev = new Date(td); prev.setDate(prev.getDate() - i); datesToTry.push(prev.toISOString().slice(0, 10)); }
  const wideFrom = new Date(td); wideFrom.setDate(wideFrom.getDate() - 60);
  datesToTry.push('wide:' + wideFrom.toISOString().slice(0, 10));
  let lastFetchErr = null, matchedRecord = null, usedDomain, triedLocs = [];
  const hdrs = { 'X-Access-Token': st.token, 'X-Agent-Pkid': st.pkid || '', 'X-Agent-Role': st.role || '', 'X-Agent-Suid': st.suid || '', 'X-Agent-User': st.userAgent || '', 'X-Agent-UserId': st.userid || '' };
  const sidNorm = String(sId).trim();
  const tryFetchList = async (domain, tryDate) => {
    const wide = tryDate.startsWith('wide:');
    const start = wide ? tryDate.slice(5) : tryDate;
    const end = wide ? targetDate : tryDate;
    const maxPages = wide ? 40 : 8;
    triedLocs.push(domain + ' ' + (wide ? start + '..' + end : tryDate));
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const url = `https://${domain}/game-oc/ida/transaction/history/queryTransactionHistoryListForUser?userId=${encodeURIComponent(mId)}&pageNo=${pageNo}&pageSize=300&startDate=${start}&endDate=${end}&transactionId=`;
      const res = await fetch(url, { method: 'GET', headers: hdrs });
      if (!res.ok) return { ok: false, status: res.status };
      const rawText = await res.text();
      let json; try { json = JSON.parse(rawText); } catch (_) { json = {}; }
      if (klaimInvalidSessionMsg(json)) throw new Error('INVALID_OPERATOR_SESSION: ' + klaimInvalidSessionText(json));
      const recs = klaimExtractRecords(json);
      const found = recs.find(item => { const rs = String(klaimRecordSid(item) || '').trim(); return (rs === sidNorm || rs.includes(sidNorm)) && klaimDebitValue(item) > 0; });
      if (found) return { ok: true, records: recs, matched: found };
      if (!Array.isArray(recs) || recs.length < 300) break;
    }
    return { ok: true, records: [], matched: null };
  };
  for (const domain of domainCandidates) {
    for (const tryDate of datesToTry) {
      try {
        const r = await tryFetchList(domain, tryDate);
        if (!r.ok) { lastFetchErr = 'Gagal akses Admin (cek token / domain) — ' + domain + ' → HTTP ' + (r && r.status ? r.status : 'network'); continue; }
        if (r.matched) { matchedRecord = r.matched; payload.targetDate = tryDate; usedDomain = domain; break; }
      } catch (err) {
        if (String(err?.message || '').startsWith('INVALID_OPERATOR_SESSION')) throw err;
        lastFetchErr = 'Gagal akses Admin (cek token / domain) — ' + domain + ' → ' + String(err?.message || 'network'); continue;
      }
    }
    if (matchedRecord) break;
  }
  if (!matchedRecord) {
    const e = new Error('userId berbeda benar sedikit bos');
    e.exposeDetail = 'Tiket tidak ketemu untuk user id "' + String(mId) + '" — sudah dicari di: ' + (triedLocs.join('; ') || '-') + (lastFetchErr ? '. Catatan akses: ' + lastFetchErr : '') ;
    throw e;
  }
  const debetValue = klaimDebitValue(matchedRecord);
  if (!debetValue) throw new Error('Nilai debet invalid');
  const gameId = klaimGameId(matchedRecord);
  if (gameId !== '65' && gameId !== '74') throw new Error('Bukan Mahjong 1 atau 2');
  const scatterVal = await klaimFetchScatterPg(mId, sId, gameId, usedDomain || domainCandidates[0]);
  return { mId, sId, bet: debetValue, scatter: scatterVal, expectedBet, expectedScatter, targetDate, time: new Date().toLocaleTimeString() };
}

function klaimBroadcastResult(result) {
  try {
    const message = { action: 'KLAIM_ITEM_DONE', result };
    chrome.runtime.sendMessage(message).catch(() => {});
    chrome.tabs.query({ url: chrome.runtime.getURL('app.html') }, tabs => {
      if (chrome.runtime.lastError) return;
      for (const tab of tabs || []) { chrome.tabs.sendMessage(tab.id, message).catch(() => {}); }
    });
  } catch (_) {}
}

function klaimStartKeepAlive() { if (!klaimKeepAliveTimer) klaimKeepAliveTimer = setInterval(() => { try { chrome.storage.local.get(['token'], () => { void chrome.runtime.lastError; }); } catch (_) {} }, 20000); }
function klaimStopKeepAlive() { if (klaimKeepAliveTimer) { clearInterval(klaimKeepAliveTimer); klaimKeepAliveTimer = null; } }
function klaimFinishJob() { klaimActiveJobs = Math.max(0, klaimActiveJobs - 1); if (klaimActiveJobs === 0) klaimStopKeepAlive(); }

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'klaimKeepAlive') { klaimStartKeepAlive(); port.onDisconnect.addListener(() => klaimStopKeepAlive()); }
});

/* ================= WEB CLAIM (dashboard bandar80 → verifikasi → input web bonus) ================= */
const webClaimLocks = new Set();
let webClaimRunning = false;
const WEB_CLAIM_FORM_URL = 'https://bonussmb.com/tickets';

async function webClaimStoreAll(list) {
  list = (Array.isArray(list) ? list : []).slice(-500);
  await setS({ webClaims: list });
}

async function webClaimGetList() {
  const { webClaims } = await getS(['webClaims']);
  return Array.isArray(webClaims) ? webClaims : [];
}

async function webClaimPatch(claimId, patch) {
  const list = await webClaimGetList();
  const idx = list.findIndex(c => c.claimId === claimId);
  if (idx < 0) return list;
  list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
  await webClaimStoreAll(list);
  return list;
}

function webClaimLabel(status) {
  const map = {
    QUEUED: 'ANTRI', VERIFYING: 'MEMERIKSA', SESUAI: 'SESUAI', TIDAK_SESUAI: 'TIDAK SESUAI',
    INPUTTING: 'INPUT KE WEB BONUS', INPUT_OK: 'BERHASIL DIINPUT', INPUT_FAIL: 'INPUT GAGAL',
    ERROR: 'ERROR', NO_TOKEN: 'TOKEN KOSONG'
  };
  return map[status] || status || '?';
}

/* Hanya kerjakan pengisian form bila hasil cek cocok (SESUAI). Yang tidak cocok TIDAK diinput. */
async function webClaimProcess(claim) {
  if (!claim || !claim.claimId) return;
  if (webClaimLocks.has(claim.claimId)) return;
  webClaimLocks.add(claim.claimId);
  try {
    const userId = String(claim.userId || '').trim();
    const txId = String(claim.kodeTiket || claim.transactionId || '').trim();
    const expectedBet = parseInt(String(claim.betting || '').replace(/[^\d]/g, ''), 10) || 0;
    const expectedScatter = parseInt(String(claim.scatter || '').replace(/[^\d]/g, ''), 10) || 0;
    if (!userId || !txId || !expectedBet || !expectedScatter) {
      await webClaimPatch(claim.claimId, { status: 'ERROR', label: 'Data tidak lengkap', detail: 'Periksa user id / kode tiket / betting / scatter' });
      return;
    }
    await webClaimPatch(claim.claimId, { status: 'VERIFYING', label: webClaimLabel('VERIFYING'), detail: 'Memeriksa betting & scatter ke data asli...' });
    processLog(txId, 'CLAIM_VERIFY', { userId, expectedBet, expectedScatter }, 'WEB');

    const runFetch = () => klaimMainProcessor({ mId: userId, sId: txId, expectedBet, expectedScatter, targetDate: todayStr() });
    const data = await klaimWithTimeout(runFetch(), APP.BONUS_PROCESS_TIMEOUT_MS);

    let cmp = klaimCompareResult(expectedBet, data.bet, expectedScatter, data.scatter);
    cmp.actualBet = data.bet; cmp.actualScatter = data.scatter;
    const scNum = parseInt(String(data.scatter || '0'), 10);
    if (cmp.isApprove && (scNum < 3 || scNum > 5)) {
      cmp.isApprove = false; cmp.state = 'mismatch'; cmp.label = 'TIDAK COCOK';
      cmp.detail = `Scatter tidak valid: ditemukan ${data.scatter} (harus 3-5)`; cmp.scatterMatch = false;
    }
    processLog(txId, 'CLAIM_VERIFIED', { bet: data.bet, scatter: data.scatter, isApprove: cmp.isApprove }, 'WEB');

    if (!cmp.isApprove) {
      await webClaimPatch(claim.claimId, {
        status: 'TIDAK_SESUAI', label: webClaimLabel('TIDAK_SESUAI'),
        detail: cmp.detail || 'Betting / scatter tidak cocok dengan data asli (TIDAK DIINPUT)', match: false,
        actualBet: data.bet, actualScatter: data.scatter
      });
      processLog(txId, 'CLAIM_SKIP_INPUT', { reason: 'TIDAK_SESUAI' }, 'WEB');
      return;
    }

    const st = await getS(['token', 'operationMode']);
    if (!st.token || st.token.length < 10) {
      await webClaimPatch(claim.claimId, { status: 'NO_TOKEN', label: webClaimLabel('NO_TOKEN'), detail: 'SESUAI tapi token admin belum ada — buka halaman admin (Header Sniffer)', match: true, actualBet: data.bet, actualScatter: data.scatter });
      return;
    }

    await webClaimPatch(claim.claimId, {
      status: 'SESUAI', label: webClaimLabel('SESUAI'),
      detail: `Cocok! Betting ${data.bet} & scatter ${data.scatter} — input ke web bonus...`, match: true,
      actualBet: data.bet, actualScatter: data.scatter
    });
    processLog(txId, 'CLAIM_INPUT_START', { bet: data.bet, scatter: data.scatter }, 'WEB');

    const formData = {
      site: String(claim.site || '').slice(0, 50),
      userId, kodeTiket: txId,
      betting: String(data.bet),
      scatter: String(Math.min(Math.max(scNum, 3), 5))
    };
    await webClaimPatch(claim.claimId, { status: 'INPUTTING', label: webClaimLabel('INPUTTING'), detail: 'Mengisi formulir #bonussmb/tickets...' });

    const formResult = await webClaimFillForm(formData);
    const okInput = !!(formResult && formResult.ok);
    await webClaimPatch(claim.claimId, {
      status: okInput ? 'INPUT_OK' : 'INPUT_FAIL',
      label: okInput ? webClaimLabel('INPUT_OK') : webClaimLabel('INPUT_FAIL'),
      detail: (formResult && formResult.message) || 'Toast tidak terdeteksi',
      match: true, actualBet: data.bet, actualScatter: data.scatter
    });
    processLog(txId, 'CLAIM_INPUT_DONE', { ok: okInput, message: formResult?.message }, 'WEB');
  } catch (err) {
    const errMsg = err?.message || String(err);
    processLog(String(claim.kodeTiket || ''), 'CLAIM_ERROR', { error: errMsg }, 'WEB');
    if (errMsg.startsWith('INVALID_OPERATOR_SESSION')) {
      handleInvalidOperatorSession({ userId: claim.userId, txId: claim.kodeTiket, betExpected: parseInt(claim.betting, 10) || 0, betActual: 0, scExpected: parseInt(claim.scatter, 10) || 0, scActual: 0, mode: 'WEB' }, null);
      await webClaimPatch(claim.claimId, { status: 'ERROR', label: 'INVALID SESSION', detail: 'Invalid operator session — token/admin tidak valid' });
      return;
    }
    await webClaimPatch(claim.claimId, { status: 'ERROR', label: webClaimLabel('ERROR'), detail: errMsg });
  } finally {
    webClaimLocks.delete(claim.claimId);
  }
}

async function webClaimDrain() {
  if (webClaimRunning) return;
  webClaimRunning = true;
  try {
    const list = await webClaimGetList();
    const pending = list.filter(c => c && (c.status === 'QUEUED' || c.status === 'VERIFYING' || c.status === 'SESUAI' || c.status === 'INPUTTING'));
    for (const c of pending) {
      if (!webClaimLocks.has(c.claimId)) { webClaimProcess(c).catch(() => {}); }
      await sleep(150);
    }
  } catch (_) {} finally {
    webClaimRunning = false;
  }
}

/* Isi form klaim web bonus (bonussmb.com/tickets) — port dari bg-secure.js (AUTO RELAX). */
async function webClaimFillForm(formData, formUrl) {
  const url = formUrl || WEB_CLAIM_FORM_URL;
  const fillUrl = url + (String(url).indexOf('?') >= 0 ? '&' : '?') + 'tm_fill=1';
  let lastMsg = 'Form tidak merespons';
  for (let n = 1; n <= 3; n++) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: fillUrl, active: false });
      await new Promise((res, rej) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); rej(new Error('Tab load timeout')); }, 15000);
        function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); res(); }
        }
        chrome.tabs.onUpdated.addListener(listener);
      });
      await new Promise(r => setTimeout(r, 1000));
      const [execResult] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: webClaimAutomateForm, args: [formData] });
      const result = execResult?.result || null;
      if (result && typeof result === 'object') {
        if (result.ok) return result;
        lastMsg = result.message || 'Form tidak merespons';
      } else {
        lastMsg = 'Form tidak merespons (coba ' + n + '/3)';
      }
    } catch (err) {
      lastMsg = 'Tab Ticket terganggu: ' + String((err && err.message) || err) + ' (coba ' + n + '/3)';
    } finally {
      if (tab?.id) { try { await closeTab(tab.id); } catch (_) {} }
    }
    await sleep(1500);
  }
  return { ok: false, message: lastMsg };
}

function webClaimAutomateForm(data) {
  function wait(ms) { return new Promise(res => setTimeout(res, ms)); }
  function selNumericInput(placeholders) {
    const inputs = Array.from(document.querySelectorAll('input[inputmode="numeric"], input[type="text"]'));
    for (const ph of placeholders) {
      const el = inputs.find(i => (i.placeholder || '').toLowerCase() === String(ph).toLowerCase());
      if (el) return el;
    }
    const last = inputs.filter(i => i.offsetParent !== null && (i.placeholder || '').trim() !== '');
    return last.length ? last[last.length - 1] : (inputs[inputs.length - 1] || null);
  }
  function triggerInput(el, value) {
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    try { const desc = Object.getOwnPropertyDescriptor(proto, 'value'); if (desc && desc.set) desc.set.call(el, value); else el.value = value; } catch (_) { el.value = value; }
    ['input', 'change'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
  }
  async function waitForOptions(timeout) {
    const start = Date.now();
    while (Date.now() - start < (timeout || 500)) {
      const opts = Array.from(document.querySelectorAll('[role="option"], .select2__option')).filter(o => o.offsetParent !== null);
      if (opts.length > 0) return opts;
      await wait(5);
    }
    return [];
  }
  async function pickOptionByText(container, preferredText) {
    try {
      if (!container) return false;
      container.click(); await wait(80);
      const inner = container.querySelector('input, [role="combobox"]');
      if (inner) { inner.focus(); inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(120); }
      else { container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(120); }
      const opts = await waitForOptions(600);
      if (!opts.length) return false;
      let target = null;
      if (preferredText) {
        const kw = String(preferredText).toLowerCase();
        target = opts.find(o => String(o.textContent || '').toLowerCase().includes(kw)) || null;
      }
      if (!target) target = opts[0];
      target.click(); await wait(120);
      return true;
    } catch (e) { return false; }
  }
  async function fillScatter(scatterValue) {
    try {
      const xpath = '//*[@id="radix-«r9»"]/div[2]/form/div[8]/div[2]/div/div';
      let container = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!container) {
        const cbs = Array.from(document.querySelectorAll('[role="dialog"] div[role="combobox"], [role="dialog"] div > div[class*="select"]'));
        if (!cbs.length) return false;
        container = cbs[cbs.length - 1];
      }
      const ctrl = container.querySelector('div[role="combobox"], div > div') || container;
      ctrl.click(); await wait(60);
      const inner = ctrl.querySelector('input, [role="combobox"]');
      if (inner) { inner.focus(); inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(80); }
      else { ctrl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(80); }
      let opts = []; const t0 = Date.now();
      while (Date.now() - t0 < 1800) {
        opts = Array.from(document.querySelectorAll('[role="option"]')).filter(o => o.offsetParent !== null);
        if (opts.length) break;
        await wait(50);
      }
      const val = parseInt(String(scatterValue), 10);
      const match = opts.find(o => String(o.textContent || '').trim() === String(val));
      if (match) { match.click(); await wait(120); return true; }
      if (val >= 3 && val <= 5 && opts.length > val - 3) { opts[val - 3].click(); await wait(120); return true; }
      return false;
    } catch (e) { return false; }
  }
  async function waitForToast(timeout) {
    const startTime = Date.now(); let lastContent = '';
    while (Date.now() - startTime < (timeout || 8000)) {
      const section = document.querySelector('section[aria-label="Notifications alt+T"][tabindex="-1"][aria-live="polite"]');
      if (section) {
        const currentContent = (section.textContent || '').trim();
        if (currentContent && currentContent !== lastContent) {
          lastContent = currentContent;
          await new Promise(r => setTimeout(r, 150));
          const finalContent = (section.textContent || '').trim();
          if (finalContent) return finalContent;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }
  function isLikelySuccess(msg) {
    const m = String(msg || '').toLowerCase();
    return !m.includes('gagal') && !m.includes('error') && !m.includes('tidak valid') && !m.includes('tidak ditemukan') && (m.includes('berhasil') || m.includes('sukses') || m.includes('tersimpan') || m.includes('masuk') || m.includes('klaim'));
  }
  return (async () => { try {
    await wait(1800);
    const openBtn = document.evaluate('//*[@id="root"]/div/main/div/div[1]/button', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || Array.from(document.querySelectorAll('button')).find(b => /tambah|klaim|new|create/i.test(b.textContent || '')) || null;
    if (!openBtn) return { ok: false, message: 'Tombol tambah klaim tidak ditemukan' };
    openBtn.click(); await wait(900);
    const dialog = document.querySelector('[role="dialog"]') || null;
    const form = (dialog && dialog.querySelector('form')) || document.querySelector('form') || null;
    if (!form) return { ok: false, message: 'Modal form tidak terbuka' };

    const situsDropdown = document.evaluate('//*[@id="radix-«r9»"]/div[2]/form/div[1]/div[2]/div', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (situsDropdown) await pickOptionByText(situsDropdown, data.site || '');
    await wait(120);
    const tipeDropdown = document.evaluate('//*[@id="radix-«r9»"]/div[2]/form/div[2]/div[2]/div', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (tipeDropdown) await pickOptionByText(tipeDropdown, '');
    await wait(120);

    const userInput = form.querySelector('input[placeholder="User ID"]') || dialog.querySelector('input[placeholder="User ID"]');
    if (userInput) { triggerInput(userInput, data.userId); await wait(100); }
    const kodeInput = form.querySelector('input[placeholder="Kode Tiket"]') || dialog.querySelector('input[placeholder="Kode Tiket"]');
    if (kodeInput) { triggerInput(kodeInput, data.kodeTiket); await wait(100); }
    const bettingInput = selNumericInput(['#######', 'Betting', 'Bet', 'Nominal']);
    if (bettingInput) { triggerInput(bettingInput, data.betting); await wait(120); }

    const scatterOk = await fillScatter(data.scatter);
    if (!scatterOk) return { ok: false, message: 'Scatter tidak valid atau tidak ditemukan' };
    await wait(150);

    const saveBtn = dialog.querySelector('button[data-slot="button"]') || Array.from(form.querySelectorAll('button')).pop() || null;
    if (!saveBtn) return { ok: false, message: 'Tombol simpan tidak ditemukan' };
    saveBtn.click();
    const toastMessage = await waitForToast();
    const finalMessage = toastMessage || 'Toast tidak terdeteksi';
    return { ok: isLikelySuccess(finalMessage), message: finalMessage };
  } catch (errFill) { return { ok: false, message: 'Script form gagal: ' + String((errFill && errFill.message) || errFill) }; }
  })();
}

async function klaimRunSingleTask(payload) {
  klaimActiveJobs++; klaimStartKeepAlive();
  const userId = sanitize(payload?.mId || ''), txId = sanitize(payload?.sId || '');
  processLog(txId, 'KLAIM_START', { userId, expectedBet: payload?.expectedBet, expectedScatter: payload?.expectedScatter }, 'USER');
  try {
    const data = await klaimMainProcessor(payload);
    processLog(txId, 'KLAIM_DONE', { bet: data.bet, scatter: data.scatter, expectedBet: data.expectedBet, expectedScatter: data.expectedScatter }, 'USER');
    klaimBroadcastResult({ success: true, mId: data.mId, sId: data.sId, status: 'completed', data });
    const bet = sanitizeNum(data.expectedBet), scatter = sanitizeNum(data.expectedScatter);
    const actualBet = sanitizeNum(data.bet), actualScatter = sanitizeNum(data.scatter);
    const ok = actualBet >= bet && actualScatter >= 3 && actualScatter <= 5;
    const status = ok ? 'SESUAI' : 'TIDAK_SESUAI';
    processLog(txId, 'KLAIM_COMPARE', { bet, actualBet, scatter, actualScatter, status }, 'USER');
    const row = { userId: sanitize(data.mId), txId: sanitize(data.sId), betExpected: bet, betActual: actualBet, scExpected: scatter, scActual: actualScatter, status, mode: 'USER' };
    queueTgNotif(row);
    await writeLogEntry(await getSitus(), row.userId, row.txId, row.betExpected, row.betActual, row.scExpected, row.scActual, row.status, row.mode);
  } catch (err) {
    processLog(txId, 'KLAIM_ERROR', { error: err.message }, 'USER');
    if (String(err?.message || '').startsWith('INVALID_OPERATOR_SESSION')) {
      klaimFinishJob();
      await handleInvalidOperatorSession({ userId, txId, betExpected: sanitizeNum(payload?.expectedBet), betActual: 0, scExpected: sanitizeNum(payload?.expectedScatter), scActual: 0 }, null);
      return;
    }
    klaimBroadcastResult({
      success: false, mId: payload?.mId, sId: payload?.sId, status: 'failed',
      error: err.message,
      data: { mId: payload?.mId, sId: payload?.sId, bet: '', scatter: '', expectedBet: payload?.expectedBet || 0, expectedScatter: payload?.expectedScatter || 0, targetDate: payload?.targetDate || todayStr(), error: err.message }
    });
    const row = { userId, txId, betExpected: sanitizeNum(payload?.expectedBet), betActual: 0, scExpected: sanitizeNum(payload?.expectedScatter), scActual: 0, status: 'GAGAL', mode: 'USER' };
    queueTgNotif(row);
    await writeLogEntry(await getSitus(), row.userId, row.txId, row.betExpected, row.betActual, row.scExpected, row.scActual, row.status, row.mode);
  }
  klaimFinishJob();
}


async function notifyBonusTicketResult(tabId, payload) {
  const send = tid => { if (!tid) return; chrome.tabs.sendMessage(tid, payload).catch(() => {}); };
  if (tabId) { send(tabId); return; }
  if (bonusTicketsTabId) { send(bonusTicketsTabId); return; }
  const tabs = await queryTicketsTabs();
  if (tabs && tabs[0]) { bonusTicketsTabId = tabs[0].id; send(tabs[0].id); }
}

async function notifyTicketsTabShowWarning(text) {
  if (!text) return;
  const tabs = await queryTicketsTabs();
  for (const t of tabs) { try { await chrome.tabs.sendMessage(t.id, { action: 'integrityWarning', text }); } catch (_) {} }
}

function sanitize(v, maxLen) {
  const s = String(v ?? '');
  return s.replace(/[\0\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').slice(0, maxLen || 500);
}

function sanitizeNum(v, fallback = 0) {
  const n = Number(String(v ?? '').replace(/[^0-9.,]/g, '').replace(/,/g, '.'));
  return isNaN(n) ? fallback : n;
}

let _processLogQ = Promise.resolve();
function processLog(txId, step, data, source) {
  _processLogQ = _processLogQ.then(async () => {
    try {
      const now = new Date();
      const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
      const today = todayStr();
      const fileKey = 'processLog_' + today;
      const { [fileKey]: _raw } = await getS([fileKey]);
      const lines = Array.isArray(_raw) ? _raw : [];
      const src = source || 'SYSTEM';
      const tx = txId || '-';
      const detail = typeof data === 'object' ? JSON.stringify(data) : String(data || '');
      lines.push(`[${ts}] [${src}] [${tx}] ${step} | ${detail}`);
      if (lines.length > 10000) lines.splice(0, lines.length - 10000);
      await setS({ [fileKey]: lines });
    } catch (_) {}
  }).catch(() => {});
}

let _writeQ = Promise.resolve();
function writeLogEntry(situs, userId, txId, betExpected, betActual, scExpected, scActual, status, mode) {
  _writeQ = _writeQ.then(async () => {
    try {
      const today = todayStr();
      const logKey = 'appLog_' + today;
      const { [logKey]: _raw } = await secureGetS([logKey]);
      const existing = Array.isArray(_raw) ? _raw : [];
      const row = {
        situs: sanitize(situs), userId: sanitize(userId), txId: sanitize(txId),
        betExpected: sanitizeNum(betExpected), betActual: sanitizeNum(betActual),
        scExpected: sanitizeNum(scExpected), scActual: sanitizeNum(scActual),
        status: sanitize(status), mode: sanitize(mode), t: Date.now()
      };
      existing.push(row);
      if (existing.length > 5000) existing.splice(0, existing.length - 5000);
      await secureSetS({ [logKey]: existing });
    } catch (_) {}
  }).catch(() => {});
  return _writeQ;
}

const TG_BOT_TOKEN = '8707249523:AAHgPjGyf5STEdT8bebTFoWQFNMUX9IOHPU';
const TG_CHAT_ID = '8695482058';

function tgEscape(v) {
  return String(v ?? '').replace(/[\0-\x1F\x7F-\x9F<>"'&]/g, '').slice(0, 100);
}

function csvSafe(v) {
  const s = String(v ?? '');
  const stripped = s.replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  if (/^[=+\-@\t\r]/.test(stripped)) return "'" + stripped;
  return stripped;
}

function queueTgNotif(row) {
  const rawTid = String(row.txId || '').replace(/[\s\r\n]+/g, '').replace(/[^0-9A-Za-z\-]/g, '');
  const digits = rawTid.replace(/\D/g, '');
  const sanitizedTid = digits.length < 8 || digits.length > 30 ? digits.slice(0, 30) : rawTid;
  if (rawTid !== sanitizedTid) console.warn(`[TG-SANITIZE] txId diperbaiki: ${rawTid.slice(0, 50)} → ${sanitizedTid}`);
  const emoji = row.status === 'SESUAI' ? '\u2705' : '\u274C';
  const mode = (row.mode || 'AUTO').toUpperCase();
  const uid = tgEscape(row.userId);
  const tid = tgEscape(sanitizedTid);
  const st = tgEscape(row.status);
  const suffix = mode === 'CEK' ? '' : ` ( ${mode} )`;
  const reasonPart = row.rejectReason ? ` | ⚠️ ${tgEscape(String(row.rejectReason).slice(0, 120))}` : '';
  const text = `${emoji} ${uid} | ${tid} | Bet: ${row.betExpected}/${row.betActual} | SC: ${row.scExpected}/${row.scActual} | ${st}${reasonPart}${suffix}`;
  enqueueTgMessage(text);
}

let _tgSendQueue = [];
let _tgSending = false;
const TG_SEND_DELAY_MS = 350;

function _sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _processTgSendQueue() {
  if (_tgSending || !_tgSendQueue.length) return;
  _tgSending = true;
  try {
    while (_tgSendQueue.length > 0) {
      const item = _tgSendQueue.shift();
      const result = await sendTgNow(item.text);
      if (result.status === 429) {
        const wait = (result.retryAfter || 5) * 1000;
        console.warn('[TG-QUEUE] 429 rate limit, waiting', wait, 'ms');
        _tgSendQueue.unshift(item);
        await _sleepMs(wait);
        continue;
      }
      if (!result.ok) {
        console.warn('[TG-QUEUE] Failed (HTTP', result.status, '), queuing retry');
        _tgMsgQueue.push({ text: item.text, attempt: 1, at: Date.now() });
        persistTgRetryQueue();
      }
      if (_tgSendQueue.length > 0) await _sleepMs(TG_SEND_DELAY_MS);
    }
  } finally { _tgSending = false; }
}

function enqueueTgMessage(text) {
  _tgSendQueue.push({ text });
  _processTgSendQueue().catch(e => console.error('[TG-QUEUE] process error:', e));
}

async function sendTgNow(text) {
  const safe = text.replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').slice(0, 4000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: safe }),
      signal: ctrl.signal
    });
    if (res.ok) {
      console.log('[TG-NOW] OK:', safe.slice(0, 50));
      return { ok: true, status: res.status };
    }
    const retryAfter = parseInt(res.headers?.get?.('Retry-After') || '0', 10);
    const body = await res.text().catch(() => '');
    console.error('[TG-NOW] FAIL HTTP', res.status, '| retry:', retryAfter, '| body:', body.slice(0, 200));
    return { ok: false, status: res.status, retryAfter };
  } catch (e) {
    console.error('[TG-NOW] Error:', e?.name || e?.message || e);
    return { ok: false, status: 0, retryAfter: 0 };
  } finally { clearTimeout(timer); }
}

const INTEGRITY_FILES = ['background.js','tickets_monitor.js','popup.js','content.js','bridge-scatter.js','detail_processor.js','manifest.json','app.js','lib/constants.js','lib/utils.js','lib/parser.js','lib/token.js'];
const INTEGRITY_KEY = '_codeHash_';
const INTEGRITY_CONTENT_KEY = '_codeContent_';

async function _fetchFileText(url) {
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) return null;
  return r.text().catch(() => null);
}

async function _hashFile(url) {
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) return '';
  const b = await r.arrayBuffer().catch(() => null);
  if (!b) return '';
  const h = await crypto.subtle.digest('SHA-256', b).catch(() => null);
  if (!h) return '';
  return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2,'0')).join('');
}

function _diffLines(oldText, newText) {
  if (!oldText || !newText) return [];
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const added = [], removed = [];
  const oldSet = new Set(oldLines.map(l => l.trim()));
  const newSet = new Set(newLines.map(l => l.trim()));
  for (let i = 0; i < newLines.length; i++) { if (!oldSet.has(newLines[i].trim())) added.push({ line: i + 1, text: newLines[i] }); }
  for (let i = 0; i < oldLines.length; i++) { if (!newSet.has(oldLines[i].trim())) removed.push({ line: i + 1, text: oldLines[i] }); }
  const maxShow = 25;
  const out = [];
  for (const r of removed.slice(0, maxShow)) out.push({ line: r.line, type: '-', text: r.text });
  if (removed.length > maxShow) out.push({ line: 0, type: '...', text: `(-${removed.length - maxShow} lagi)` });
  for (const a of added.slice(0, maxShow)) out.push({ line: a.line, type: '+', text: a.text });
  if (added.length > maxShow) out.push({ line: 0, type: '...', text: `(+${added.length - maxShow} lagi)` });
  return out;
}

async function _runIntegrityCheck() {
  try {
    const now = Date.now();
    const { [INTEGRITY_KEY]: stored, [INTEGRITY_CONTENT_KEY]: storedContent } = await getS([INTEGRITY_KEY, INTEGRITY_CONTENT_KEY]);
    const current = {};
    const currentContent = {};
    let changed = [], missing = [];
    for (const f of INTEGRITY_FILES) {
      const url = chrome.runtime.getURL(f);
      const h = await _hashFile(url);
      if (!h) { missing.push(f); continue; }
      current[f] = h;
      if (stored && stored[f] && stored[f] !== h) changed.push(f);
    }
    if (changed.length > 0 || !stored) {
      for (const f of changed.length > 0 ? changed : INTEGRITY_FILES) {
        const url = chrome.runtime.getURL(f);
        const text = await _fetchFileText(url);
        if (text !== null) currentContent[f] = text;
      }
    }
    if (changed.length > 0) {
      const details = [];
      for (const f of changed) {
        const oldText = storedContent?.[f] || '';
        const newText = currentContent[f] || '';
        const diffs = _diffLines(oldText, newText);
        const removed = diffs.filter(d => d.type === '-').length;
        const added = diffs.filter(d => d.type === '+').length;
        let fileDetail = `📁 ${f} (${oldText.split('\n').length}→${newText.split('\n').length} baris, -${removed}+${added})`;
        for (const d of diffs) {
          if (d.type === '...') fileDetail += `\n  ${d.text}`;
          else fileDetail += `\n  ${d.type} L${d.line}: ${d.text}`;
        }
        details.push(fileDetail);
      }
      const detailMsg = details.join('\n\n');
      const shortMsg = `🚨 INTEGRITY BREACH — ${changed.join(', ')}`;
      enqueueTgMessage(shortMsg + '\n\n' + detailMsg);
      notifyTicketsTabShowWarning('🚨 PERINGATAN INTEGRITAS — File: ' + changed.join(', ') + '\n\n' + detailMsg);
    }
    if (!stored) {
      await setS({ [INTEGRITY_KEY]: current, [INTEGRITY_CONTENT_KEY]: currentContent });
    }
    if (changed.length > 0 || missing.length > 0) console.warn('[INTEGRITY]', { changed, missing });
  } catch (e) { console.error('[INTEGRITY] error:', e); }
}


_runIntegrityCheck().catch(() => {});
setInterval(() => _runIntegrityCheck().catch(() => {}), 300000);

function persistTgRetryQueue() {
  const clean = _tgMsgQueue.slice(-200);
  setS({ _tgMsgRetryQueue: clean }).catch(() => {});
}

let _tgFlushing = false;

async function flushTgRetryQueue() {
  if (_tgFlushing || !_tgMsgQueue.length) return;
  _tgFlushing = true;
  try {
    const now = Date.now();
    const still = [];
    const toSend = [];
    for (const entry of _tgMsgQueue) {
      if (entry.attempt > 10) {
        console.warn('[TG-RETRY] Max attempts reached, dropping:', entry.text.slice(0, 40));
        continue;
      }
      if (now - entry.at < entry.attempt * 3000) { still.push(entry); continue; }
      toSend.push(entry);
    }
    _tgMsgQueue = still;
    persistTgRetryQueue();
    for (const entry of toSend) {
      const result = await sendTgNow(entry.text);
      if (result.ok) {
        console.log('[TG-RETRY] OK:', entry.text.slice(0, 40), '| attempt:', entry.attempt);
      } else {
        entry.attempt++;
        entry.at = Date.now();
        _tgMsgQueue.push(entry);
        console.warn('[TG-RETRY] FAIL:', entry.text.slice(0, 40), '| attempt:', entry.attempt, '| HTTP', result.status);
      }
      await _sleepMs(TG_SEND_DELAY_MS);
    }
    persistTgRetryQueue();
  } finally { _tgFlushing = false; }
}

async function sendTelegramFile() {
  const today = todayStr();
  const logKey = 'appLog_' + today;
  const { [logKey]: _raw } = await secureGetS([logKey]);
  const rows = Array.isArray(_raw) ? _raw : [];
  if (!rows.length) return;
  const header = 'SITUS\tUserID\tKode Tiket\tBet\tRealBet\tSC\tRealSC\tStatus\tmode';
  const lines = rows.map(r => csvSafe(r.situs??'') + '\t' + csvSafe(r.userId??'') + '\t' + csvSafe(r.txId??'') + '\t' + (r.betExpected??'') + '\t' + (r.betActual??'') + '\t' + (r.scExpected??'') + '\t' + (r.scActual??'') + '\t' + csvSafe(r.status??'') + '\t' + csvSafe(r.mode??''));
  const text = header + '\n' + lines.join('\n');
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT_ID);
  fd.append('document', new Blob([text], { type: 'text/plain' }), 'auto_log_' + today + '.txt');
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  } catch (_) {}
}

function formatBetLog(v) {
  const n = klaimNormalizeBet(v);
  return n ? 'Rp ' + n.toLocaleString('id-ID') : 'Rp 0';
}

function formatScLog(v) {
  const n = klaimNormalizeScatter(v);
  return n ? 'x' + n : 'x0';
}

async function sendBonusKlaimOutcome(txId, cmp, td, tabId, extra = {}) {
  const userId = td?.userId || '';
  const key = ck(userId, txId);
  const overall = extra.overallStatus || (cmp.isApprove ? 'SESUAI' : 'TIDAK_SESUAI');
  const logOpts = { situs: await getSitus(), userId, txId, betExpected: td?.betting || 0, betActual: cmp.actualBet, scExpected: td?.scatterCount || 0, scActual: cmp.actualScatter, status: overall };
  const payload = {
    action: 'bonusTicketResult', transactionId: txId, userId: userId, overallStatus: overall,
    betCheckStatus: cmp.betMatch ? 'SESUAI' : 'TIDAK_SESUAI',
    scatterCheckStatus: cmp.scatterMatch ? 'SESUAI' : 'TIDAK_SESUAI',
    hadiahStatus: 'SKIP', debetValue: klaimFormatBet(cmp.actualBet),
    scatterTitle: klaimFormatScatter(cmp.actualScatter),
    klaimLabel: cmp.label, klaimDetail: cmp.detail,
    klaimRejectReason: klaimUiRejectReason(cmp), fromKlaim: true,
    _log: logOpts
  };
  await clearInflight(key);
  const qEntry = retryQueue.get(key);
  if (qEntry) qEntry.finalStatus = cmp.isApprove ? 'APPROVE' : 'REJECT';
  await notifyBonusTicketResult(tabId, payload);
  try {
    const stRes = await getS(['executorName', 'marwanResults', 'batchStats']);
    const executor = stRes.executorName || 'AutoBonus';
    const results = Array.isArray(stRes.marwanResults) ? stRes.marwanResults : [];
    const stats = stRes.batchStats || { totalInput: 0, processed: 0, timeout: 0, invalid: 0 };
    const autoRow = {
      userId: userId, transactionId: txId, betAmount: td?.betting || '',
      scatterCount: td?.scatterCount || '', totalPrize: td?.hadiah || '',
      debetValue: klaimFormatBet(cmp.actualBet) || '',
      scatterTitle: klaimFormatScatter(cmp.actualScatter) || '',
      betCheckStatus: cmp.betMatch ? 'SESUAI' : 'TIDAK_SESUAI',
      scatterCheckStatus: cmp.scatterMatch ? 'SESUAI' : 'TIDAK_SESUAI',
      hadiahStatus: 'SKIP', overallStatus: overall, executorName: executor, time: new Date().toISOString()
    };
    results.push(autoRow);
    stats.processed = (stats.processed || 0) + 1;
    await setS({ marwanResults: results, batchStats: stats });
    await postResult(autoRow);
  } catch (_) {}
  if (cmp.isApprove && userId && txId) { saveTokenAnchor(userId, txId).catch(() => {}); }
}

function klaimWithTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout ' + ms + 'ms')), ms); })]).finally(() => clearTimeout(timer));
}

const INVALID_ALERT_PAGE = 'alert.html';
let _invalidAlertTabId = null;
let _lastInvalidAlertAt = 0;

async function sendTgInvalidOperatorSession(entry) {
  try {
    const { operationMode } = await getS(['operationMode']);
    const mode = (entry?.mode || operationMode || 'AUTO').toUpperCase();
    const expBet = klaimNormalizeBet(entry?.betExpected);
    const expSc = klaimNormalizeScatter(entry?.scExpected);
    const uid = tgEscape(entry?.userId || '');
    const rawTid = String(entry?.txId || '').replace(/[\s\r\n]+/g, '').replace(/[^0-9A-Za-z\-]/g, '');
    const tid = tgEscape(rawTid);
    const betStr = expBet ? 'Rp ' + expBet.toLocaleString('id-ID') : 'Rp 0';
    const text = `❌ ${uid} | ${tid} | Bet: ${betStr}/${expBet || 0} | SC: ${expSc}/${expSc} | TIDAK_SESUAI | ⚠️ Invalid operator session ⚠️\nSILAH KAN LAPOR CS LINE ( ${mode} )`;
    await enqueueTgMessage(text);
  } catch (_) {}
}

async function openInvalidSessionAlert(entry) {
  try {
    if (_invalidAlertTabId) {
      try {
        await chrome.tabs.sendMessage(_invalidAlertTabId, { action: 'showInvalidSessionAlert', entry });
        return;
      } catch (_) { _invalidAlertTabId = null; }
    }
    const now = Date.now();
    if (now - _lastInvalidAlertAt < 8000) return;
    _lastInvalidAlertAt = now;
    try {
      chrome.notifications.create('invalidSessionAlert', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '⚠️ INVALID OPERATOR SESSION ⚠️',
        message: 'DUARRRR MEMEW — LAPOR CS LINE RUSAK SCATER NYA !!!\nUID: ' + String(entry?.userId || '') + ' | TX: ' + String(entry?.txId || ''),
        priority: 2,
        requireInteraction: true,
        silent: false
      });
    } catch (_) {}
    const url = chrome.runtime.getURL(INVALID_ALERT_PAGE) + '?uid=' + encodeURIComponent(String(entry?.userId || '')) + '&tx=' + encodeURIComponent(String(entry?.txId || '')) + '&ts=' + now;
    const tab = await chrome.tabs.create({ url, active: true });
    _invalidAlertTabId = tab?.id || null;
    if (tab?.windowId) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    }
  } catch (_) {}
}

async function handleInvalidOperatorSession(entry, tabId) {
  const userId = String(entry?.userId || '');
  const txId = String(entry?.txId || '');
  try { await writeLogEntry(await getSitus(), userId, txId, entry?.betExpected || 0, 0, entry?.scExpected || 0, 0, 'INVALID_SESSION', 'AUTO'); } catch (_) {}
  await sendTgInvalidOperatorSession(entry).catch(() => {});
  await openInvalidSessionAlert(entry).catch(() => {});
  await notifyBonusTicketResult(tabId, { action: 'bonusTicketResult', transactionId: txId, userId: userId, overallStatus: 'INVALID_SESSION', betCheckStatus: 'UNKNOWN', scatterCheckStatus: 'UNKNOWN', hadiahStatus: 'SKIP', scatterTitle: 'Invalid operator session', klaimLabel: 'INVALID_SESSION', klaimDetail: 'Invalid operator session', klaimRejectReason: 'Invalid operator session', fromKlaim: true, invalidOperatorSession: true });
}

async function runBonusKlaimVerify(td, tabId) {
  if (!td || typeof td !== 'object') throw new Error('ticketData tidak valid');
  const txId = String(td.transactionId || '').trim();
  if (!txId) throw new Error('transactionId kosong');
  const userId = String(td.userId || '').trim();
  const lockKey = ck(userId, txId);
  if (processingTxLocks.has(lockKey)) return;
  processingTxLocks.add(lockKey);
  const expectedBet = td.betting;
  const expectedScatter = td.scatterCount;
  try {
    const runFetch = () => klaimMainProcessor({ mId: userId, sId: txId, expectedBet, expectedScatter, targetDate: todayStr() });
    const data = await klaimWithTimeout(runFetch(), APP.BONUS_PROCESS_TIMEOUT_MS);
    if (data.mId && userId && String(data.mId).trim().toLowerCase() !== String(userId).trim().toLowerCase()) {
      notify(`[GUARD userId] ${txId} API returned userId "${data.mId}" !== expected "${userId}" — skip`);
      const cmp = klaimCompareResult(expectedBet, 0, expectedScatter, 0, 'UserId mismatch: API returned different user');
      await sendBonusKlaimOutcome(txId, cmp, td, tabId);
      return;
    }
    let cmp = klaimCompareResult(expectedBet, data.bet, expectedScatter, data.scatter);
    cmp.actualBet = data.bet; cmp.actualScatter = data.scatter;
    const scNum = parseInt(String(data.scatter || '0'), 10);
    if (cmp.isApprove && (scNum < 3 || scNum > 5)) {
      notify(`[GUARD] Scatter tidak valid (${data.scatter}) pada ${txId} — paksa TIDAK_SESUAI`);
      cmp.isApprove = false;
      cmp.state = 'mismatch';
      cmp.label = 'TIDAK COCOK';
      cmp.detail = `Scatter tidak valid: ditemukan ${data.scatter} (harus 3-5)`;
      cmp.scatterMatch = false;
    }
    if (!cmp.isApprove) {
      let cmp2 = null;
      try {
        const data2 = await klaimWithTimeout(runFetch(), APP.BONUS_PROCESS_TIMEOUT_MS);
        cmp2 = klaimCompareResult(expectedBet, data2.bet, expectedScatter, data2.scatter);
        cmp2.actualBet = data2.bet; cmp2.actualScatter = data2.scatter;
        const sc2 = parseInt(String(data2.scatter || '0'), 10);
        if (cmp2.isApprove && (sc2 < 3 || sc2 > 5)) { cmp2.isApprove = false; cmp2.scatterMatch = false; }
      } catch (e2) {
        if (String(e2?.message || '').startsWith('INVALID_OPERATOR_SESSION')) { cmp2 = null; }
      }
      if (cmp2 && cmp2.isApprove) {
        notify(`[2x-CEK] Cek kedua cocok (${txId}) — batal REJECT, jadikan SESUAI`);
        cmp = cmp2;
      } else if (cmp2) {
        notify(`[2x-CEK] Cek kedua tetap TIDAK_SESUAI (${txId}) — lanjut REJECT`);
        cmp = cmp2;
      } else {
        notify(`[2x-CEK] Cek kedua gagal (${txId}) — pakai hasil pertama`);
      }
    }
    await sendBonusKlaimOutcome(txId, cmp, td, tabId);
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (errMsg.startsWith('INVALID_OPERATOR_SESSION')) {
      const q = retryQueue.get(lockKey);
      if (q) q.finalStatus = 'SKIP';
      await clearInflight(lockKey);
      await handleInvalidOperatorSession({ userId, txId, betExpected: expectedBet, betActual: 0, scExpected: expectedScatter, scActual: 0 }, tabId);
      return;
    }
    const kind = klaimClassifyBonusError(errMsg);
    if (kind === 'SESSION_TIMEOUT' || kind === 'RETRY') {
      await clearInflight(lockKey);
      await notifyBonusTicketResult(tabId, { action: 'bonusTicketResult', transactionId: txId, userId: userId, overallStatus: kind === 'SESSION_TIMEOUT' ? 'SESSION_TIMEOUT' : 'RETRY', betCheckStatus: 'UNKNOWN', scatterCheckStatus: 'UNKNOWN', hadiahStatus: 'SKIP', scatterTitle: errMsg, fromKlaim: true });
      return;
    }
    const cmp = klaimCompareResult(expectedBet, 0, expectedScatter, 0, errMsg);
    await sendBonusKlaimOutcome(txId, cmp, td, tabId);
  } finally {
    processingTxLocks.delete(lockKey);
  }
}

async function safeTabCreate(url, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try { return await chrome.tabs.create({ url, active: false, ...opts }); } catch (e) {
      if (i < 2) await sleep((e.message && e.message.toLowerCase().includes('dragging')) ? 50 : 100);
    }
  }
  try {
    const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
    if (win.tabs?.[0]) return win.tabs[0];
  } catch (_) {}
  throw new Error('Gagal membuka tab baru.');
}

async function closeTab(id) {
  if (!id) return;
  try { chrome.tabs.get(id, t => { if (!chrome.runtime.lastError && t) chrome.tabs.remove(id, () => { void chrome.runtime.lastError; }); }); } catch (_) {}
}

function waitTab(tabId, timeout = 25000) {
  return new Promise(resolve => {
    let done = false;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(result); } };
    const timer = setTimeout(() => finish(false), timeout);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, t => { if (chrome.runtime.lastError || (t && t.status === 'complete')) finish(true); });
  });
}


async function postResult(row) {
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}, ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const line = `${dateStr}\t${row.userId || ''}\t${row.transactionId || ''}\t${row.betAmount || row.debetValue || ''}\t${row.scatterCount || ''}\t${row.executorName || ''}`;
  try {
    await fetch(URLS.APPS_SCRIPT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: line });
  } catch (_) {}
  try {
    await fetch(URLS.GAS, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: line });
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener((tid, ci) => {
  const url = ci.url || '';
  if (!url) return;
  const tk = extractToken(url);
  if (tk && tk.length > 10) saveHistoryToken(tk);
  if (url.includes('/transaction-record.html') && ci.status === 'complete') {
    getS(['adminUrl']).then(res => {
      try {
        const parsed = new URL(url); const base = parsed.protocol + '//' + parsed.host;
        if (base && base !== (res.adminUrl || '')) { setS({ adminUrl: base }); chrome.runtime.sendMessage({ action: 'adminUrlUpdated', adminUrl: base }).catch(() => {}); }
      } catch (_) {}
    });
  }
  if (url.includes('bonussmb.com') && url.includes('/tickets') && ci.status === 'complete') { bonusTicketsTabId = tid; }
});

function finalize(result, txId, detailTabId) {
  if (!txId) txId = 'INVALID-' + Date.now();
  txId = String(txId).trim();
  if (!txId) txId = 'INVALID-' + Date.now();
  const fkey = ck(result?.userId, txId);
  if (finalizeLocks.has(fkey)) return;
  if (finalized.has(fkey)) return;
  finalizeLocks.add(fkey);
  finalized.add(fkey);
  (async () => {
    try {
      const res = await getS(['executorName', 'marwanResults', 'batchStats']);
      const executor = res.executorName || 'Unknown';
      const results = Array.isArray(res.marwanResults) ? res.marwanResults : [];
      const stats = res.batchStats || { totalInput: 0, processed: 0, timeout: 0, invalid: 0 };
      const row = { ...result, scatterCount: result.scatterCount || '', totalPrize: result.totalPrize || '', debetValue: result.debetValue || '', executorName: executor };
      const bm = parseAmount(row.betAmount); const ba = parseAmount(row.debetValue);
      row.betCheckStatus = (!bm || !ba) ? 'UNKNOWN' : bm === ba ? 'SESUAI' : 'TIDAK_SESUAI';
      const sm = String(row.scatterCount || ''); const sd = extractScatterNum(row.scatterTitle);
      row.scatterCheckStatus = (!sm || !sd) ? 'UNKNOWN' : sm === sd ? 'SESUAI' : 'TIDAK_SESUAI';
      const scatterNum = parseInt(sd, 10);
      const scatterValid = scatterNum >= 3 && scatterNum <= 5;
      if (!scatterValid && row.scatterCheckStatus !== 'UNKNOWN') {
        row.scatterCheckStatus = 'TIDAK_SESUAI';
        notify(`[GUARD] Scatter tidak valid (${sd || 'kosong'}) — hasil ditolak otomatis: ${txId}`);
      }
      const scatterLow = String(row.scatterTitle || '').toLowerCase();
      if (scatterLow.includes('detail_processor') || scatterLow.includes('tidak merespons') || scatterLow.includes('error detail') || scatterLow.includes('tab detail tidak') || scatterLow.includes('content script')) {
        row.overallStatus = 'RETRY';
      } else if (String(row.scatterTitle || '').toUpperCase().includes('NO_DATA') || String(row.scatterTitle || '').toLowerCase().includes('userId berbeda')) {
        row.scatterTitle = 'userId berbeda benar sedikit bos'; row.betCheckStatus = 'TIDAK_SESUAI'; row.scatterCheckStatus = 'TIDAK_SESUAI'; row.hadiahStatus = 'TIDAK_SESUAI'; row.overallStatus = 'TIDAK_SESUAI';
      } else {
        row.overallStatus = (row.betCheckStatus === 'SESUAI' && row.scatterCheckStatus === 'SESUAI' && String(row.hadiahStatus || '').toUpperCase() === 'VALID') ? 'SESUAI' : 'TIDAK_SESUAI';
      }
      processLog(txId, 'FINALIZE', { bet: row.betCheckStatus, sc: row.scatterCheckStatus, status: row.overallStatus, betAmount: row.betAmount, debet: row.debetValue, scCount: row.scatterCount, scTitle: row.scatterTitle }, 'BOT');
      if (row.overallStatus === 'SESUAI' && row.userId && txId) saveTokenAnchor(row.userId, txId).catch(() => {});
      results.push(row);
      stats.processed = (stats.processed || 0) + 1;
      if (String(row.scatterTitle || '').includes('Timeout')) stats.timeout = (stats.timeout || 0) + 1;
      if (String(row.transactionId || '').startsWith('INVALID_TX_')) stats.invalid = (stats.invalid || 0) + 1;
      await setS({ marwanResults: results, batchStats: stats });
      await postResult(row);
      if (detailTabId) await closeTab(detailTabId);
      const { processingCount: pc } = await getS(['processingCount']);
      await setS({ processingCount: Math.max(0, (pc || 1) - 1) });
      triggerQueue();
    } catch (_) {
      const { processingCount: pc } = await getS(['processingCount']);
      await setS({ processingCount: Math.max(0, (pc || 1) - 1) });
      triggerQueue();
    } finally {
      finalizeLocks.delete(fkey);
    }
  })();
}

function triggerQueue() { setTimeout(runQueue, 0); }

async function runQueue() {
  if (isQueueRunning) return;
  isQueueRunning = true;
  try {
    while (true) {
      const st = await getS(['txQueue', 'processingCount']);
      const queue = Array.isArray(st.txQueue) ? st.txQueue : [];
      const cnt = st.processingCount || 0;
      if (queue.length === 0 && cnt === 0) { notify('Semua transaksi selesai diproses.'); break; }
      if (queue.length === 0 || cnt >= APP.PARALLEL_LIMIT) break;
      const item = queue[0];
      await setS({ txQueue: queue.slice(1), processingCount: cnt + 1 });
      notify(`Aktif: ${cnt + 1}/${APP.PARALLEL_LIMIT}, sisa antrian: ${queue.length - 1}`);
      processOne(item).catch(e => console.error('processOne error:', e));
    }
  } finally { isQueueRunning = false; }
}

async function processOne(item) {
  const { userId, transactionId } = item;
  finalized.delete(ck(userId, transactionId));
  if (!item.processable) { finalize({ userId: userId || '-', transactionId, scatterTitle: 'Data tidak lengkap', checkLink: item.checkLink || '' }, transactionId, null); return; }
  const timeoutMs = item.fromBonusSmb ? APP.BONUS_PROCESS_TIMEOUT_MS : APP.PROCESS_TIMEOUT_MS;
  const timeoutId = setTimeout(() => { finalize({ userId, transactionId, debetValue: 'N/A', scatterTitle: 'Timeout proses', checkLink: '' }, transactionId, null); }, timeoutMs);
  try {
    const st = await getS(['adminUrl', 'sniffedFrom', 'token', 'userid', 'pkid', 'role', 'suid', 'userAgent']);
    const adminBase = st.adminUrl || (st.sniffedFrom ? `https://${st.sniffedFrom}` : '');
    if (!adminBase) { clearTimeout(timeoutId); finalize({ userId: userId || '-', transactionId, scatterTitle: 'adminUrl belum diisi. Buka halaman admin game dulu.' }, transactionId, null); return; }
    const domain = getDomainFromUrl(adminBase);
    const targetDate = item.todayDate || todayStr();
    const startDate = item.startDate || targetDate;
    const endDate = item.endDate || targetDate;
    const hdrs = { 'X-Access-Token': st.token || '', 'X-Agent-Pkid': st.pkid || '', 'X-Agent-Role': st.role || '', 'X-Agent-Suid': st.suid || '', 'X-Agent-User': st.userAgent || '', 'X-Agent-UserId': st.userid || '' };
    let listUrl = `https://${domain}/game-oc/ida/transaction/history/queryTransactionHistoryListForUser?userId=${encodeURIComponent(userId)}&pageNo=1&pageSize=300&startDate=${startDate}&endDate=${endDate}&transactionId=${encodeURIComponent(transactionId)}`;
    let listRes = await fetch(listUrl, { method: 'GET', headers: hdrs });
    if (!listRes.ok) { clearTimeout(timeoutId); finalize({ userId, transactionId, debetValue: 'N/A', scatterTitle: `Gagal akses Admin: ${listRes.status}` }, transactionId, null); return; }
    let listJson; try { listJson = await listRes.json(); } catch (_) { listJson = {}; }
    if (klaimInvalidSessionMsg(listJson)) throw new Error('INVALID_OPERATOR_SESSION: ' + klaimInvalidSessionText(listJson));
    let allRecords = klaimExtractRecords(listJson);
    let matchedRecord = allRecords.find(item => { const sid = String(klaimRecordSid(item) || '').trim(); return (sid === String(transactionId).trim() || sid.includes(String(transactionId).trim())) && klaimDebitValue(item) > 0; });
    if (!matchedRecord && allRecords.length >= 300) {
      for (let pg = 2; pg <= 10 && !matchedRecord; pg++) {
        const pgUrl = `https://${domain}/game-oc/ida/transaction/history/queryTransactionHistoryListForUser?userId=${encodeURIComponent(userId)}&pageNo=${pg}&pageSize=300&startDate=${startDate}&endDate=${endDate}&transactionId=`;
        const pgRes = await fetch(pgUrl, { method: 'GET', headers: hdrs });
        if (!pgRes.ok) break;
        let pgJson; try { pgJson = await pgRes.json(); } catch (_) { break; }
        if (klaimInvalidSessionMsg(pgJson)) throw new Error('INVALID_OPERATOR_SESSION: ' + klaimInvalidSessionText(pgJson));
        const pgRecs = klaimExtractRecords(pgJson);
        if (!pgRecs.length) break;
        allRecords = allRecords.concat(pgRecs);
        matchedRecord = pgRecs.find(item => { const sid = String(klaimRecordSid(item) || '').trim(); return (sid === String(transactionId).trim() || sid.includes(String(transactionId).trim())) && klaimDebitValue(item) > 0; });
      }
    }
    if (!matchedRecord) { clearTimeout(timeoutId); finalize({ userId, transactionId, debetValue: 'N/A', scatterTitle: 'userId berbeda benar sedikit bos' }, transactionId, null); return; }
    await processOneFromRecord(matchedRecord, allRecords, userId, transactionId, domain, st, timeoutId);
  } catch (e) {
    clearTimeout(timeoutId);
    if (String(e?.message || '').startsWith('INVALID_OPERATOR_SESSION')) {
      await handleInvalidOperatorSession({ userId, txId: transactionId, betExpected: 0, betActual: 0, scExpected: 0, scActual: 0 }, null);
      await skipQueueItem(userId, transactionId);
      return;
    }
    finalize({ userId, transactionId, debetValue: 'N/A', scatterTitle: 'Error: ' + e.message }, transactionId, null);
  }
}

async function skipQueueItem(userId, txId) {
  try {
    const { processingCount: pc } = await getS(['processingCount']);
    await setS({ processingCount: Math.max(0, (pc || 1) - 1) });
  } catch (_) {}
  triggerQueue();
}

async function processOneFromRecord(record, records, userId, transactionId, domain, st, timeoutId) {
  const debetValue = klaimDebitValue(record);
  const gameId = klaimGameId(record);
  let scatterTitle = 'Scatter tidak ditemukan';
  if (!debetValue || debetValue <= 0) {
    clearTimeout(timeoutId);
    finalize({ userId, transactionId, debetValue: 'N/A', scatterTitle: 'Nilai debet tidak valid — tolak' }, transactionId, null);
    return;
  }
  if (gameId !== '65' && gameId !== '74') {
    clearTimeout(timeoutId);
    finalize({ userId, transactionId, debetValue: String(debetValue || '0'), scatterTitle: 'Bukan Mahjong 1 atau 2 — tolak' }, transactionId, null);
    return;
  }
  try {
    const txShort = String(transactionId).slice(0, 19);
    let sc = await klaimFetchScatterPg(userId, txShort, gameId, domain);
    if (!(sc >= 3 && sc <= 5)) {
      try {
        const sc2 = await klaimFetchScatterPg(userId, txShort, gameId, domain);
        if (sc2 >= 3 && sc2 <= 5) sc = sc2;
      } catch (e2) {
        if (String(e2?.message || '').startsWith('INVALID_OPERATOR_SESSION')) throw e2;
      }
    }
    if (sc >= 3 && sc <= 5) {
      scatterTitle = String(sc);
    } else if (sc > 0) {
      throw new Error(`Scatter tidak valid: ${sc} (harus 3-5)`);
    } else {
      scatterTitle = 'Scatter tidak ditemukan';
    }
  } catch (err) {
    if (String(err?.message || '').startsWith('INVALID_OPERATOR_SESSION')) throw err;
    scatterTitle = isSessionOrUnknownError(err.message) ? 'SESSION TIMEOUT' : (err.message || 'Error scatter');
  }
  clearTimeout(timeoutId);
  finalize({ userId, transactionId, debetValue: String(debetValue || '0'), scatterTitle, gameId }, transactionId, null);
}

async function ensureTicketsTabOpen() {
  if (bonusTicketsTabId) {
    try {
      const t = await new Promise((ok, fail) => { chrome.tabs.get(bonusTicketsTabId, tab => { if (chrome.runtime.lastError) fail(new Error('tab gone')); else ok(tab); }); });
      if (t?.url && /bonussmb\.com\/tickets/i.test(t.url)) { chrome.tabs.sendMessage(bonusTicketsTabId, { action: 'triggerScan' }).catch(() => {}); return bonusTicketsTabId; }
    } catch (_) { bonusTicketsTabId = null; }
  }
  const tabs = await queryTicketsTabs();
  if (tabs?.length > 0) { bonusTicketsTabId = tabs[0].id; chrome.tabs.sendMessage(bonusTicketsTabId, { action: 'triggerScan' }).catch(() => {}); return bonusTicketsTabId; }
  try {
    const tab = await safeTabCreate(URLS.TICKETS, { active: false });
    bonusTicketsTabId = tab.id;
    notify(`[SMB] Buka tab bonussmb/tickets (${new Date().toLocaleTimeString()})`);
    await waitTab(tab.id, 20000);
    await sleep(500);
    return tab.id;
  } catch (e) { notify('[SMB] Gagal buka tab: ' + e.message); return null; }
}


async function getTicketsTabId() { const tabs = await queryTicketsTabs(); return tabs.length > 0 ? tabs[0].id : null; }

async function closeTicketsTab() {
  const tabId = await getTicketsTabId();
  if (tabId) { try { await chrome.tabs.remove(tabId); } catch (_) {} if (bonusTicketsTabId === tabId) bonusTicketsTabId = null; }
}

function parseCekRekCustomHeaders(rawHeaders) {
  const result = {};
  if (!rawHeaders) return result;
  const trimmedAll = String(rawHeaders).trim();
  const isRawToken = /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(trimmedAll) || (/^[A-Za-z0-9_\-.~]{30,}$/.test(trimmedAll) && !trimmedAll.includes('\n') && !trimmedAll.includes(':'));
  if (isRawToken) { result['X-Access-Token'] = trimmedAll; return result; }
  const lines = trimmedAll.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(trimmed)) { result['X-Access-Token'] = trimmed; continue; }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) { const key = trimmed.slice(0, colonIdx).trim(); const val = trimmed.slice(colonIdx + 1).trim(); if (key && val) result[key] = val; }
    else { const spaceIdx = trimmed.indexOf(' '); if (spaceIdx > 0) { const key = trimmed.slice(0, spaceIdx).trim(); const val = trimmed.slice(spaceIdx + 1).trim(); if (key && val) result[key] = val; } }
  }
  return result;
}

async function cekRekFetchViaApi(domain, userId, customHeaders) {
  try {
    if (!domain || !userId) throw new Error('domain/userId kosong');
    const url = `https://${domain}/game-oc/ida/playerInfo/getInfoPage?accountId=${encodeURIComponent(userId)}&accountIdDim=1&playerId=&bankCode=&bankName=&lastName=&mobile=&pageNo=1&pageSize=50&realName=&referralId=&registerTimeFinally=&registerTimeStart=&registerTimeStartDim=0&remark=&remarkDim=0&state=&status=&auditStatus=&orderColumn=recordDate&orderType=desc`;
    const headers = typeof customHeaders === 'object' && !Array.isArray(customHeaders) ? customHeaders : parseCekRekCustomHeaders(customHeaders);
    const res = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const records = json?.result?.pages?.records;
    if (!records?.length) throw new Error('User tidak ditemukan / records kosong');
    const playerData = records[0];
    return { noRek: playerData?.bankCode || playerData?.accountNo || playerData?.bankNo || '-', nama: playerData?.realName || playerData?.lastName || playerData?.fullName || playerData?.name || '-', jenisBankName: playerData?.bankName || playerData?.bankNameStr || playerData?.bank || '-' };
  } catch (e) { throw e; }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'keepAlive') {
    port.onMessage.addListener(msg => {
      if (msg.action === 'ping') {
        try { port.postMessage({ action: 'pong' }); } catch (_) {}
      }
    });
    port.onDisconnect.addListener(() => {
      setTimeout(async () => {
        const tabId = bonusTicketsTabId || await (async () => {
          const tabs = await queryTicketsTabs();
          return tabs?.length > 0 ? tabs[0].id : null;
        })();
        if (!tabId) return;
        try {
          await chrome.tabs.sendMessage(tabId, { action: 'forceProcessQueue' });
        } catch (_) {
          try { await chrome.tabs.reload(tabId, { bypassCache: false }); } catch (_) {}
          try { bonusTicketsTabId = tabId; } catch (_) {}
        }
      }, 1500);
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => { try { const pick = INTEGRITY_FILES[Math.floor(Math.random() * INTEGRITY_FILES.length)]; const _icd = window.___icd || (window.___icd = {}); const now = Date.now(); if (_icd[pick] && now - _icd[pick] < 60000) return; const url = chrome.runtime.getURL(pick); const h = await _hashFile(url); const { [INTEGRITY_KEY]: stored, [INTEGRITY_CONTENT_KEY]: storedContent } = await getS([INTEGRITY_KEY, INTEGRITY_CONTENT_KEY]); if (stored && stored[pick] && stored[pick] !== h) { _icd[pick] = now; const oldText = storedContent?.[pick] || ''; const newText = await _fetchFileText(url) || ''; const diffs = _diffLines(oldText, newText); const removed = diffs.filter(d => d.type === '-').length; const added = diffs.filter(d => d.type === '+').length; let detail = `📁 ${pick} (${oldText.split('\n').length}→${newText.split('\n').length} baris, -${removed}+${added})`; for (const d of diffs) { if (d.type === '...') detail += `\n  ${d.text}`; else detail += `\n  ${d.type} L${d.line}: ${d.text}`; } enqueueTgMessage(`🚨 INTEGRITY BREACH (real-time): ${pick}\n${detail}`); notifyTicketsTabShowWarning(`🚨 PERINGATAN INTEGRITAS (real-time): ${pick}\n${detail}`); } } catch (_) {} })();
  if (msg.action === 'setOperationMode') {
    (async () => {
      try {
        await setS({ operationMode: msg.mode === 'MANUAL' ? 'MANUAL' : 'AUTO' });
        const tabs = await queryTicketsTabs();
        for (const tab of tabs) { try { await chrome.tabs.sendMessage(tab.id, { action: 'modeChanged', mode: msg.mode }); } catch (_) {} }
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (msg.action === 'updateTargetDomain') {
    (async () => { try { await setS({ targetDomain: msg.domain || '' }); notify(`Target domain diperbarui: ${msg.domain || '(kosong)'}`); sendResponse({ ok: true }); } catch (e) { sendResponse({ ok: false, error: e.message }); } })();
    return true;
  }
  switch (msg.action) {
    case 'refreshApiToken':
      (async () => {
        try {
          const { adminUrl } = await getS(['adminUrl']);
          if (!adminUrl) { sendResponse({ ok: false, error: 'adminUrl not set' }); return; }
          const tab = await chrome.tabs.create({ url: adminUrl, active: false });
          await waitTab(tab.id, 20000); await sleep(600);
          const { token } = await getS(['token']);
          await chrome.tabs.remove(tab.id).catch(() => {});
          sendResponse(token && token.length > 10 ? { ok: true, token } : { ok: false, error: 'token still empty after refresh' });
        } catch (e) { sendResponse({ ok: false, error: e.message }); }
      })();
      return true;
    case 'registerTicketsTab':
      bonusTicketsTabId = sender.tab?.id || bonusTicketsTabId;
      sendResponse({ status: 'ok' });
      return true;
    case '_alivePing':
      sendResponse({ status: 'ok' });
      return true;
    case 'invalidSessionAlertClosed':
      if (sender.tab?.id && sender.tab.id === _invalidAlertTabId) _invalidAlertTabId = null;
      sendResponse({ status: 'ok' });
      return true;
    case 'invalidSessionKeepFocus':
      (async () => {
        try {
          if (_invalidAlertTabId) { const tab = await new Promise(ok => chrome.tabs.get(_invalidAlertTabId, ok)); if (!chrome.runtime.lastError && tab) { await chrome.tabs.update(_invalidAlertTabId, { active: true }); } else { _invalidAlertTabId = null; } }
        } catch (_) { _invalidAlertTabId = null; }
        sendResponse({ status: 'ok' });
      })();
      return true;
    case 'testInvalidSessionAlert':
      (async () => {
        try {
          _lastInvalidAlertAt = 0;
          let entry = { userId: 'hokiudore', txId: '2081566454871960576', betExpected: 4000, betActual: 4000, scExpected: 3, scActual: 3, mode: 'TEST' };
          try {
            const { marwanResults } = await getS(['marwanResults']);
            const last = Array.isArray(marwanResults) && marwanResults.length ? marwanResults[marwanResults.length - 1] : null;
            if (last && (last.userId || last.transactionId)) {
              entry = {
                userId: String(last.userId || entry.userId),
                txId: String(last.transactionId || last.sId || entry.txId),
                betExpected: klaimNormalizeBet(last.betAmount ?? last.debetValue ?? last.expectedBet),
                betActual: klaimNormalizeBet(last.debetValue ?? last.betActual),
                scExpected: klaimNormalizeScatter(last.scatterCount ?? last.expectedScatter),
                scActual: klaimNormalizeScatter(last.scatterTitle ?? last.scatterCount),
                mode: 'TEST'
              };
            }
          } catch (_) {}
          await sendTgInvalidOperatorSession(entry);
          await openInvalidSessionAlert(entry);
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false, error: (e && e.message) || 'gagal' }); }
      })();
      return true;
    case 'injectNetworkGuard':
      (async () => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN',
            func: function() {
              var ec = 0, et = 0;
              var f = window.fetch;
              window.fetch = function(u, o) {
                return f.call(window, u, o).then(function(r) {
                  if (r.status === 500 && typeof u === 'string' && u.indexOf('api.bonussmb.com') > -1) { ec++; if (et === 0) et = Date.now(); if (ec >= 3 && Date.now() - et < 30000) location.reload(); else if (Date.now() - et > 30000) { ec = 1; et = Date.now(); } }
                  return r;
                });
              };
              var X = window.XMLHttpRequest, _o = X.prototype.open, _s = X.prototype.send;
              X.prototype.open = function(m, u) { this.__u = u; return _o.call(this, m, u); };
              X.prototype.send = function(b) {
                var x = this;
                this.addEventListener('loadend', function() {
                  if (x.status === 500 && x.__u && x.__u.indexOf('api.bonussmb.com') > -1) { ec++; if (et === 0) et = Date.now(); if (ec >= 3 && Date.now() - et < 30000) location.reload(); else if (Date.now() - et > 30000) { ec = 1; et = Date.now(); } }
                });
                return _s.call(this, b);
              };
            }
          });
          sendResponse({ status: 'ok' });
        } catch (e) { sendResponse({ status: 'error', reason: e.message }); }
      })();
      return true;
    case 'ticketActionDone': {
      const rawTxId = String(msg.transactionId || '').replace(/[\s\r\n]+/g, '').replace(/[^0-9A-Za-z\-]/g, '');
      const txDigits = rawTxId.replace(/\D/g, '');
      if (txDigits.length < 8 || txDigits.length > 30) { sendResponse({ status: 'invalid' }); return true; }
      const txId = rawTxId;
      const userId = String(msg.userId || '').replace(/[\s\r\n]+/g, '').replace(/[^0-9A-Za-z@.\-_]/g, '').trim();
      const action = String(msg.actionTaken || msg.status || '').replace(/[^A-Z_]/g, '').toUpperCase();
      (async () => { try { if (!txId) { sendResponse({ status: 'invalid' }); return; } await persistTicketVerified(txId, action || 'DONE', userId); notifyTicketsTabRescan(); sendResponse({ status: 'ok' }); } catch (e) { sendResponse({ status: 'error', reason: e.message }); } })();
      return true;
    }
    case 'verifyBonusTicket': {
      const td = msg.ticketData;
      if (!td?.transactionId) { sendResponse({ status: 'invalid' }); return true; }
      const rawTxId = String(td.transactionId || '').replace(/[\s\r\n]+/g, '').replace(/[^0-9A-Za-z\-]/g, '');
      const rawUserId = String(td.userId || '').replace(/[\s\r\n]+/g, '').replace(/[^0-9A-Za-z@.\-_]/g, '');
      const txDigits = rawTxId.replace(/\D/g, '');
      if (txDigits.length < 8 || txDigits.length > 30) { sendResponse({ status: 'error', reason: 'invalid txId' }); return true; }
      (async () => {
        try {
          const userId = rawUserId;
          const txId = rawTxId;
          const st = await getS(['operationMode', 'token', 'adminUrl', 'sniffedFrom', 'startDate', 'endDate', 'historyHost', 'apiHost', 'historyGameId', 'executorName']);
          const notifyTabId = sender.tab?.id || bonusTicketsTabId;
          if (!st.token || st.token.length < 10) {
            sendResponse({ status: 'error', reason: 'Token belum ada — buka halaman admin (Header Sniffer)' });
            await notifyBonusTicketResult(notifyTabId, { action: 'bonusTicketResult', transactionId: txId, userId, overallStatus: 'SESSION_TIMEOUT', betCheckStatus: 'UNKNOWN', scatterCheckStatus: 'UNKNOWN', hadiahStatus: 'SKIP', scatterTitle: 'Token belum ada', fromKlaim: true });
            return;
          }
          const safeData = { transactionId: txId, userId, betting: String(td.betting || '').replace(/[^\d]/g, '').slice(0, 20), scatterCount: String(td.scatterCount || '').replace(/[^\d]/g, '').slice(0, 5), hadiah: String(td.hadiah || '').replace(/[<>"'&]/g, '').slice(0, 100), status: String(td.status || '').replace(/[^A-Za-z]/g, '').slice(0, 20), tabId: notifyTabId };
          enqueueVerifyTicket(safeData);
          sendResponse({ status: 'queued' });
        } catch (err) { sendResponse({ status: 'error', reason: err?.message || 'unexpected error' }); }
      })();
      return true;
    }
    case 'KLAIM_PROCESS_DATA': {
      (async () => {
        const klaimPayload = msg.payload;
        if (!klaimPayload?.sId) { sendResponse({ status: 'invalid' }); return; }
        klaimRunSingleTask(klaimPayload);
        sendResponse({ status: 'ok' });
      })();
      return true;
    }
    case 'CLAIM_WEB_SUBMIT': {
      (async () => {
        try {
          const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
          const userId = String(p.userId || '').replace(/[\s\r\n]+/g, '').replace(/[^\w@.\-]/g, '').trim().slice(0, 100);
          const kodeTiket = String(p.kodeTiket || p.transactionId || '').replace(/[\s\r\n]+/g, '').trim().slice(0, 30);
          const betting = parseInt(String(p.betting || '').replace(/[^\d]/g, ''), 10) || 0;
          const scatter = parseInt(String(p.scatter || '').replace(/[^\d]/g, ''), 10) || 0;
          const site = String(p.site || '').replace(/[^a-zA-Z0-9\.\-_]/g, '').trim().slice(0, 50);
          if (!userId || !kodeTiket || !betting || scatter < 3 || scatter > 5) {
            sendResponse({ status: 'invalid', error: 'Data klaim tidak lengkap / scatter harus 3-5', payload: { userId, kodeTiket, betting, scatter, site } });
            return;
          }
          const claimId = 'web_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
          const list = await webClaimGetList();
          const dup = list.find(c => c && c.userId === userId && c.kodeTiket === kodeTiket && (c.status === 'QUEUED' || c.status === 'VERIFYING' || c.status === 'SESUAI' || c.status === 'INPUTTING'));
          if (dup) { sendResponse({ status: 'duplicate', claimId: dup.claimId, message: 'Klaim ini masih dalam proses' }); return; }
          const claim = { claimId, site, userId, kodeTiket, betting, scatter, status: 'QUEUED', label: webClaimLabel('QUEUED'), detail: 'Menunggu antrian verifikasi', match: null, actualBet: '', actualScatter: '', createdAt: Date.now(), updatedAt: Date.now(), source: 'web' };
          list.push(claim);
          await webClaimStoreAll(list);
          sendResponse({ status: 'queued', claimId, ok: true });
          webClaimDrain();
        } catch (err) { sendResponse({ status: 'error', error: err?.message || 'unexpected error' }); }
      })();
      return true;
    }
    case 'CLAIM_WEB_STATUS': {
      (async () => {
        try {
          const list = await webClaimGetList();
          sendResponse({ status: 'ok', ok: true, list });
        } catch (err) { sendResponse({ status: 'error', error: err?.message || 'error' }); }
      })();
      return true;
    }
    case 'CLAIM_WEB_CLEAR': {
      (async () => {
        try {
          const onlyDone = !!(msg.payload && msg.payload.onlyDone);
          let list = await webClaimGetList();
          if (onlyDone) list = list.filter(c => !c || (c.status !== 'QUEUED' && c.status !== 'VERIFYING' && c.status !== 'SESUAI' && c.status !== 'INPUTTING'));
          else list = [];
          await webClaimStoreAll(list);
          sendResponse({ status: 'ok', ok: true });
        } catch (err) { sendResponse({ status: 'error', error: err?.message || 'error' }); }
      })();
      return true;
    }
    case 'logResult':
      (async () => {
        try {
          const r = { situs: msg.situs || await getSitus(), userId: msg.userId || '', txId: msg.txId || '', betExpected: msg.betExpected ?? 0, betActual: msg.betActual ?? 0, scExpected: msg.scExpected ?? 0, scActual: msg.scActual ?? 0, status: msg.status || '', rejectReason: msg.rejectReason || '', mode: msg.mode || 'AUTO' };
          processLog(r.txId, 'LOG_RESULT', { status: r.status, mode: r.mode, bet: r.betExpected + '/' + r.betActual, sc: r.scExpected + '/' + r.scActual }, r.mode);
          await writeLogEntry(r.situs, r.userId, r.txId, r.betExpected, r.betActual, r.scExpected, r.scActual, r.status, r.mode);
          console.log('[BG-logResult] Sending TG for:', r.txId, r.status);
          queueTgNotif(r);
          sendResponse({ ok: true });
        } catch (e) { console.error('[BG-logResult] Error:', e); sendResponse({ ok: false, error: e.message }); }
      })();
      return true;
    case 'testTg':
      (async () => {
        try {
          console.log('[TEST-TG] Sending...');
          const result = await sendTgNow('TEST TG - ' + new Date().toLocaleString('id-ID'));
          console.log('[TEST-TG] Result:', result);
          sendResponse({ ok: result.ok, status: result.status });
        } catch (e) { console.error('[TEST-TG] Error:', e); sendResponse({ ok: false, error: e.message }); }
      })();
      return true;
    case 'downloadProcessLog':
      (async () => {
        try {
          const today = todayStr();
          const fileKey = 'processLog_' + today;
          const { [fileKey]: _raw } = await getS([fileKey]);
          const lines = Array.isArray(_raw) ? _raw : [];
          if (!lines.length) { sendResponse({ ok: false, empty: true }); return; }
          const header = 'Waktu\tSource\tTX_ID\tStep\tDetail';
          const text = header + '\n' + lines.join('\n');
          const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
          await chrome.downloads.download({ url: dataUri, filename: 'process_log_' + today + '.txt', conflictAction: 'overwrite', saveAs: false });
          sendResponse({ ok: true });
        } catch (_) { sendResponse({ ok: false }); }
      })();
      return true;
    case 'downloadLog':
      (async () => {
        try {
          const today = todayStr();
          const logKey = 'appLog_' + today;
          const { [logKey]: _raw } = await secureGetS([logKey]);
          const rows = Array.isArray(_raw) ? _raw : [];
          if (!rows.length) { sendResponse({ ok: false, empty: true }); return; }
          const header = 'SITUS\tUserID\tKode Tiket\tBet\tRealBet\tSC\tRealSC\tStatus\tmode';
          const lines = rows.map(r => csvSafe(r.situs??'') + '\t' + csvSafe(r.userId??'') + '\t' + csvSafe(r.txId??'') + '\t' + (r.betExpected??'') + '\t' + (r.betActual??'') + '\t' + (r.scExpected??'') + '\t' + (r.scActual??'') + '\t' + csvSafe(r.status??'') + '\t' + csvSafe(r.mode??''));
          const text = header + '\n' + lines.join('\n');
          const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
          await chrome.downloads.download({ url: dataUri, filename: 'auto_log.txt', conflictAction: 'overwrite', saveAs: false });
          sendResponse({ ok: true });
        } catch (_) { sendResponse({ ok: false }); }
      })();
      return true;
    case 'removeLogEntry':
      (async () => {
        try {
          const txId = msg.txId;
          if (!txId) { sendResponse({ ok: false }); return; }
          _writeQ = _writeQ.then(async () => {
            const today = todayStr();
            const logKey = 'appLog_' + today;
            const { [logKey]: _raw } = await secureGetS([logKey]);
            const rows = Array.isArray(_raw) ? _raw : [];
            const filtered = rows.filter(r => String(r.txId ?? '') !== String(txId));
            if (filtered.length !== rows.length) await secureSetS({ [logKey]: filtered });
          }).catch(() => {});
          await _writeQ;
          sendResponse({ ok: true });
        } catch (_) { sendResponse({ ok: false }); }
      })();
      return true;
    case 'runIntegrityCheck':
      _runIntegrityCheck().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    case 'startBatchProcess':
      (async () => {
        try {
          const { operationMode } = await getS(['operationMode']);
          if (operationMode === 'MANUAL') { sendResponse({ status: 'manual_mode_blocked' }); return; }
          finalized.clear();
          isQueueRunning = false;
          await setS({ processingCount: 0 });
          sendResponse({ status: 'batchStarted' });
          triggerQueue();
        } catch (e) { sendResponse({ status: 'error', error: e.message }); }
      })();
      return true;
    case 'openLink': {
      (async () => {
        const { url, userId, transactionId, debetValue, mainTabId } = msg;
        try { const tk = extractToken(url || ''); if (tk?.length >= 10) await saveHistoryToken(tk); } catch (_) {}
        let gameId = '74';
        try { const gm = (url || '').match(/\/history\/(\d+)\.html/i); if (gm) gameId = gm[1]; } catch (_) {}
        const { adminUrl, sniffedFrom } = await getS(['adminUrl', 'sniffedFrom']);
        const domain = getDomainFromUrl(adminUrl || sniffedFrom || 'bandar80.idrbo2.com');
        const txShort = String(transactionId || '').slice(0, 19);
        let scatterTitle = 'Scatter tidak ditemukan';
        try {
          const sc = await klaimFetchScatterPg(userId, txShort, gameId, domain);
          if (sc >= 3 && sc <= 5) {
            scatterTitle = String(sc);
          } else if (sc > 0) {
            scatterTitle = 'Scatter tidak valid (' + sc + ')';
          } else {
            scatterTitle = 'Scatter tidak ditemukan';
          }
        } catch (err) { scatterTitle = isSessionOrUnknownError(err.message) ? 'SESSION TIMEOUT' : (err.message || 'Error scatter'); }
        if (mainTabId) closeTab(mainTabId).catch(() => {});
        finalize({ userId, transactionId, debetValue, scatterTitle }, transactionId, null);
        sendResponse({ status: 'ok' });
      })();
      return true;
    }
    case 'processComplete':
      finalize(msg.result, msg.result.transactionId, msg.detailTabId);
      sendResponse({ status: 'ok' });
      return true;
    case 'processError':
      finalize(msg.result, msg.result.transactionId, msg.detailTabId || null);
      sendResponse({ status: 'ok' });
      return true;
    case 'getSmbScanStatus': {
      const remaining = Math.max(0, Math.ceil((lastSmbScanTime + APP.SMB_SCAN_INTERVAL_MS - Date.now()) / 1000));
      sendResponse({ nextScanIn: remaining, lastScanAt: lastSmbScanTime });
      return true;
    }
    case 'ticketsIdle':
      sendResponse({ status: 'ok' });
      return true;
    case 'getAdminUrl':
      getS(['adminUrl']).then(res => sendResponse({ adminUrl: res.adminUrl || '' }), () => sendResponse({ adminUrl: '' }));
      return true;
    case 'showNotification': {
      const notifId = 'tm_notif_' + Date.now();
      try { chrome.notifications.create(notifId, { type: 'basic', iconUrl: 'icons/icon48.png', title: msg.title || 'AutoScater', message: msg.message || '', priority: 2 }, () => { void chrome.runtime.lastError; }); } catch (_) {}
      sendResponse({ status: 'ok' });
      return true;
    }
    case 'CEK_REK_PROCESS': {
      const cekRekConfig = msg.config;
      if (!cekRekConfig?.userIds?.length) { sendResponse({ status: 'invalid' }); return true; }
      (async () => {
        try {
          const st = await getS(['adminUrl', 'sniffedFrom']);
          let domain = getDomainFromUrl(st.adminUrl || st.sniffedFrom || '');
          if (!domain) { sendResponse({ status: 'error', error: 'Domain target tidak ditemukan' }); return; }
          const parsedCustomHeaders = parseCekRekCustomHeaders(cekRekConfig.headers || '');
          const allUserIds = cekRekConfig.userIds.map(u => u.trim()).filter(Boolean);
          const total = allUserIds.length;
          const results = allUserIds.map(uid => ({ userId: uid, noRek: '...', time: '', status: 'PROSES' }));
          const broadcastProgress = () => {
            const payload = { action: 'CEK_REK_PROGRESS', results: results.slice() };
            chrome.runtime.sendMessage(payload).catch(() => {});
            chrome.tabs.query({ url: chrome.runtime.getURL('app.html') }, tabs => { for (const tab of tabs || []) chrome.tabs.sendMessage(tab.id, payload).catch(() => {}); });
          };
          broadcastProgress();
          await Promise.allSettled(allUserIds.map(async (uid, idx) => {
            try {
              const rekData = await cekRekFetchViaApi(domain, uid, parsedCustomHeaders);
              results[idx] = { userId: uid, nama: rekData.nama || '-', jenisBankName: rekData.jenisBankName || '-', noRek: rekData.noRek || '-', time: new Date().toLocaleTimeString(), status: 'BERHASIL' };
            } catch (err) { results[idx] = { userId: uid, noRek: '-', time: new Date().toLocaleTimeString(), status: `GAGAL — ${err.message}` }; }
            broadcastProgress();
          }));
          await setS({ cekRekResults: results });
          notify(`Cek Rek selesai: ${results.filter(r => r.status === 'BERHASIL').length}/${total} ID berhasil`);
          sendResponse({ status: 'done', results });
        } catch (err) { notify('Cek Rek error: ' + err.message); sendResponse({ status: 'error', error: err.message }); }
      })();
      return true;
    }
    default: return false;
  }
});

setInterval(async () => {
  try {
  const s = await getS(['dailySession']);
  const session = s?.dailySession;
  if (!session || session.date !== todayStr()) {
    notify(`[SMB] Hari baru (${todayStr()})! Session direset.`);
    cachedHistoryToken = ''; cachedHistoryTokenAt = 0;
    await setS({ historyToken: '', historyTokenAt: 0 });
    const { tokenAnchor: a, adminUrl: au, sniffedFrom: sf } = await getS(['tokenAnchor', 'adminUrl', 'sniffedFrom']);
    if (a?.userId && a?.transactionId) {
      const domain = getDomainFromUrl(au || sf || 'bandar80.idrbo2.com');
      refreshHistoryTokenViaTab(a.userId, a.transactionId, '74', domain).catch(() => {});
    }
  }
  } catch (_) {}
}, 60000);

function registerAlarms() {
  chrome.alarms.create('scanTickets', { periodInMinutes: APP.SMB_SCAN_INTERVAL_MS / 60000 });
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.25 });
  chrome.alarms.create('contentKeepAlive', { periodInMinutes: 0.166 });
  chrome.alarms.create('autoDownloadLog', { periodInMinutes: 60 });
  chrome.alarms.create('integrityCheck', { periodInMinutes: 1 });
}
registerAlarms();
chrome.runtime.onInstalled.addListener(() => registerAlarms());
chrome.runtime.onStartup.addListener(() => registerAlarms());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'scanTickets') scanTicketsAndClose().catch(() => {});
  if (alarm.name === 'keepAlive') forceProcessTicketsTab().catch(() => {});
  if (alarm.name === 'contentKeepAlive') sendContentKeepAlive().catch(() => {});
  if (alarm.name === 'autoDownloadLog') autoDownloadLog().catch(() => {});
  if (alarm.name === 'integrityCheck') checkIntegrity().catch(() => {});
});

async function sendContentKeepAlive() {
  try {
    let tabId = null;
    if (bonusTicketsTabId) {
      try {
        const t = await new Promise((ok, fail) => { chrome.tabs.get(bonusTicketsTabId, tab => { if (chrome.runtime.lastError) fail(new Error('tab gone')); else ok(tab); }); });
        if (t?.url && /bonussmb\.com\/tickets/i.test(t.url)) tabId = bonusTicketsTabId;
      } catch (_) { bonusTicketsTabId = null; }
    }
    if (!tabId) {
      const tabs = await queryTicketsTabs();
      if (tabs?.length > 0) { tabId = tabs[0].id; bonusTicketsTabId = tabId; }
    }
    if (!tabId) return;
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'keepAlivePong' });
      try { await chrome.tabs.sendMessage(tabId, { action: 'forceProcessQueue' }); } catch (_) {}
    } catch (_) {
      try { await chrome.tabs.reload(tabId, { bypassCache: false }); } catch (_) {}
    }
  } catch (_) {}
}

async function forceProcessTicketsTab() {
  try {
    if (!(await isAutoModeReady())) return;
    let tabId = null;
    if (bonusTicketsTabId) {
      try {
        const t = await new Promise((ok, fail) => { chrome.tabs.get(bonusTicketsTabId, tab => { if (chrome.runtime.lastError) fail(new Error('tab gone')); else ok(tab); }); });
        if (t?.url && /bonussmb\.com\/tickets/i.test(t.url)) tabId = bonusTicketsTabId;
      } catch (_) { bonusTicketsTabId = null; }
    }
    if (!tabId) {
      const tabs = await queryTicketsTabs();
      if (tabs?.length > 0) { tabId = tabs[0].id; bonusTicketsTabId = tabId; }
    }
    if (!tabId) {
      try {
        const tab = await safeTabCreate(URLS.TICKETS, { active: false });
        if (tab?.id) { bonusTicketsTabId = tab.id; tabId = tab.id; }
      } catch (_) {}
    }
    if (!tabId) return;
    try { await chrome.tabs.sendMessage(tabId, { action: 'forceProcessQueue' }).catch(() => {}); } catch (_) {}
  } catch (_) {}
}

async function autoDownloadLog() {
  try {
    const today = todayStr();
    const logKey = 'appLog_' + today;
    const { [logKey]: _raw } = await secureGetS([logKey]);
    const rows = Array.isArray(_raw) ? _raw : [];
    if (!rows.length) return;
    const header = 'SITUS\tUserID\tKode Tiket\tBet\tRealBet\tSC\tRealSC\tStatus\tmode';
    const lines = rows.map(r => csvSafe(r.situs??'') + '\t' + csvSafe(r.userId??'') + '\t' + csvSafe(r.txId??'') + '\t' + (r.betExpected??'') + '\t' + (r.betActual??'') + '\t' + (r.scExpected??'') + '\t' + (r.scActual??'') + '\t' + csvSafe(r.status??'') + '\t' + csvSafe(r.mode??''));
    const text = header + '\n' + lines.join('\n');
    const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    await chrome.downloads.download({ url: dataUri, filename: 'auto_log.txt', conflictAction: 'overwrite', saveAs: false });
    sendTelegramFile().catch(() => {});
  } catch (_) {}
}

queryTicketsTabs().then(tabs => {
  if (tabs?.[0]) bonusTicketsTabId = tabs[0].id;
  scanTicketsAndClose();
});

chrome.action.onClicked.addListener(() => { try { chrome.tabs.create({ url: chrome.runtime.getURL('app.html'), active: true }); } catch (_) {} });

(async () => {
  try {
  checkIntegrity().catch(() => {});
  const { operationMode, _tgMsgRetryQueue } = await getS(['operationMode', '_tgMsgRetryQueue']);
  if (!operationMode) await setS({ operationMode: 'MANUAL' });
  if (Array.isArray(_tgMsgRetryQueue)) _tgMsgQueue = _tgMsgRetryQueue;
  (function tgFlushLoop() { flushTgRetryQueue().catch(() => {}).then(() => setTimeout(tgFlushLoop, 5000)); })();
  notify(await isAutoModeReady() ? 'Auto-monitor siap' : 'Menunggu konfigurasi (Admin URL, Token, Eksekutor) untuk mode otomatis');
  webClaimDrain().catch(() => {});
  if (!autoTokenRefreshTimer) {
    autoTokenRefreshTimer = setInterval(async () => {
      try {
      const now = Date.now();
      if (cachedHistoryToken && (now - cachedHistoryTokenAt) < APP.HISTORY_TOKEN_TTL_MS) return;
      const { historyToken, historyTokenAt } = await getS(['historyToken', 'historyTokenAt']);
      if (historyToken && historyTokenAt && (now - historyTokenAt) < APP.HISTORY_TOKEN_TTL_MS) {
        cachedHistoryToken = historyToken; cachedHistoryTokenAt = historyTokenAt; return;
      }
      const { tokenAnchor, adminUrl, sniffedFrom } = await getS(['tokenAnchor', 'adminUrl', 'sniffedFrom']);
      if (!tokenAnchor?.userId || !tokenAnchor?.transactionId) return;
      const domain = getDomainFromUrl(adminUrl || sniffedFrom || 'bandar80.idrbo2.com');
      await refreshHistoryTokenViaTab(tokenAnchor.userId, tokenAnchor.transactionId, '74', domain).catch(() => {});
      } catch (_) {}
    }, 60000);
  }
  } catch (_) {}
})();

/* ================= SUPABASE WORKER (1 otak → banyak situs) =================
   Data klaim masuk via web publik (index.html / dashboard.html) ke Supabase.
   Extension di PC owner ini yang jadi "otak": polling klaim PENDING,
   verifikasi betting/scatter ke data asli (RELAX AA), baru input ke web bonus
   TUJUAN SITUS masing-masing (bonus_url), lalu auto-cek scatter / approve /
   reject tetap dijalankan oleh tickets_monitor pada dashboard bonus tujuan. */
const SBW_URL = 'https://epzuvadrnzdnyyhwiqyc.supabase.co/rest/v1';
const SBW_KEY = 'sb_publishable_4GtsLX1vvVcyfyFnL91JwQ_DLh_jvjP';
const SBW_LABEL = { PENDING: 'ANTRI', VERIFYING: 'MEMERIKSA', SESUAI: 'SESUAI', TIDAK_SESUAI: 'TIDAK SESUAI', INPUTTING: 'INPUT WEB BONUS', INPUT_OK: 'BERHASIL DIINPUT', INPUT_FAIL: 'INPUT GAGAL', NO_TOKEN: 'TOKEN KOSONG', ERROR: 'ERROR' };
const sbwLocks = new Set();
let sbwBusy = false;
let sbwSites = {}; let sbwSitesAt = 0;
let sbwTimer = null;

async function sbwFetch(pathname, opts) {
  const opt = opts || {};
  const hdrs = Object.assign({ apikey: SBW_KEY, Authorization: 'Bearer ' + SBW_KEY }, opt.headers || {});
  const res = await fetch(SBW_URL + pathname, { method: opt.method || 'GET', headers: hdrs, body: opt.body });
  if (!res.ok) throw new Error('SB ' + res.status);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
function sbwBuildQP(filters) {
  const p = new URLSearchParams();
  for (const k of Object.keys(filters || {})) { const v = filters[k]; if (v !== undefined && v !== null && v !== '') p.set(k, v); }
  const s = p.toString(); return s ? ('?' + s) : '';
}

async function sbwPatchClaim(id, obj) {
  obj.updated_at = new Date().toISOString();
  await sbwFetch('/claims?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(obj) });
}

async function sbwLoadSites(force) {
  if (!force && sbwSitesAt && (Date.now() - sbwSitesAt) < 300000) return sbwSites;
  try {
    const rows = await sbwFetch('/sites?select=site_id,label,check_domains,bonus_url,form_site_value,active');
    const map = {};
    for (const r of Array.isArray(rows) ? rows : []) map[r.site_id] = r;
    sbwSites = map; sbwSitesAt = Date.now();
  } catch (_) {}
  return sbwSites;
}

async function sbwProcessOne(row) {
  const id = row.id;
  if (sbwLocks.has(id)) return;
  sbwLocks.add(id);
  try {
    await sbwLoadSites();
    const cfg = sbwSites[row.site] || null;
    if (!cfg || !cfg.active) {
      await sbwPatchClaim(id, { status: 'ERROR', label: 'SITUS TIDAK TERDAFTAR', detail: 'Situs ' + (row.site || '?') + ' tidak terdaftar atau belum aktif di registri — TIDAK diinput.' });
      return;
    }
    if (!cfg.bonus_url) {
      await sbwPatchClaim(id, { status: 'ERROR', label: 'SITUS BELUM KONFIGURASI', detail: 'Web bonus tujuan ' + cfg.label + ' belum diisi (bonus_url) — TIDAK diinput agar tidak salah target.' });
      return;
    }
    const userId = String(row.user_id || '').replace(/[\s\r\n]+/g, '').trim();
    const txId = String(row.kode_tiket || '').replace(/[\s\r\n]+/g, '').trim();
    const expectedBet = parseInt(String(row.betting || '').replace(/[^\d]/g, ''), 10) || 0;
    const expectedScatter = parseInt(String(row.scatter || ''), 10) || 0;
    if (!userId || !txId || !expectedBet) {
      await sbwPatchClaim(id, { status: 'ERROR', label: 'DATA TIDAK LENGKAP', detail: 'Periksa user id / kode tiket / betting.' });
      return;
    }
    await sbwPatchClaim(id, { status: 'VERIFYING', label: 'MEMERIKSA', detail: 'Cek betting & scatter ke data asli (' + cfg.label + ')...' });
    processLog(txId, 'SBW_VERIFY', { site: row.site, userId, expectedBet, expectedScatter }, 'CLOUD');

    const data = await klaimWithTimeout(
      klaimMainProcessor({ mId: userId, sId: txId, expectedBet, expectedScatter, targetDate: todayStr(), domains: cfg.check_domains || [] }),
      APP.BONUS_PROCESS_TIMEOUT_MS || 60000
    );
    let cmp = klaimCompareResult(expectedBet, data.bet, expectedScatter, data.scatter);
    cmp.actualBet = data.bet; cmp.actualScatter = data.scatter;
    const scNum = parseInt(String(data.scatter || '0'), 10);
    if (cmp.isApprove && (scNum < 3 || scNum > 5)) {
      cmp.isApprove = false; cmp.state = 'mismatch'; cmp.label = 'TIDAK COCOK';
      cmp.detail = 'Scatter tidak valid: ditemukan ' + data.scatter + ' (harus 3-5)'; cmp.scatterMatch = false;
    }
    processLog(txId, 'SBW_VERIFIED', { bet: data.bet, scatter: data.scatter, isApprove: cmp.isApprove }, 'CLOUD');

    if (!cmp.isApprove) {
      await sbwPatchClaim(id, { status: 'TIDAK_SESUAI', label: 'TIDAK SESUAI', match: false, detail: cmp.detail || 'Betting / scatter tidak cocok dengan data asli (TIDAK DIINPUT)', actual_bet: String(data.bet), actual_scatter: String(data.scatter) });
      processLog(txId, 'SBW_SKIP_INPUT', { reason: 'TIDAK_SESUAI' }, 'CLOUD');
      return;
    }

    await sbwPatchClaim(id, { status: 'SESUAI', label: 'SESUAI', match: true, detail: 'Cocok! Betting ' + data.bet + ' & scatter ' + data.scatter + ' — input ke ' + cfg.label + '...', actual_bet: String(data.bet), actual_scatter: String(data.scatter) });
    processLog(txId, 'SBW_INPUT_START', { site: row.site, target: cfg.bonus_url }, 'CLOUD');

    const formData = {
      site: cfg.form_site_value || row.site,
      userId, kodeTiket: txId,
      betting: String(data.bet),
      scatter: String(Math.min(Math.max(scNum, 3), 5))
    };
    await sbwPatchClaim(id, { status: 'INPUTTING', label: 'INPUT WEB BONUS', detail: 'Mengisi formulir ' + cfg.label + '...' });
    processLog(txId, 'SBW_INPUTTING', { target: cfg.bonus_url }, 'CLOUD');

    const formResult = await webClaimFillForm(formData, cfg.bonus_url);
    const okInput = !!(formResult && formResult.ok);
    await sbwPatchClaim(id, {
      status: okInput ? 'INPUT_OK' : 'INPUT_FAIL',
      label: okInput ? 'BERHASIL DIINPUT' : 'INPUT GAGAL',
      detail: (formResult && formResult.message) || 'Toast tidak terdeteksi',
      match: true, actual_bet: String(data.bet), actual_scatter: String(data.scatter)
    });
    processLog(txId, 'SBW_INPUT_DONE', { ok: okInput, message: formResult?.message, target: cfg.bonus_url }, 'CLOUD');
  } catch (err) {
    const errMsg = err?.message || String(err);
    processLog(String(row.kode_tiket || ''), 'SBW_ERROR', { error: errMsg, site: row.site }, 'CLOUD');
    if (errMsg.startsWith('INVALID_OPERATOR_SESSION')) {
      handleInvalidOperatorSession({ userId: row.user_id, txId: row.kode_tiket, betExpected: parseInt(row.betting, 10) || 0, betActual: 0, scExpected: parseInt(row.scatter, 10) || 0, scActual: 0, mode: 'CLOUD' }, null);
      await sbwPatchClaim(id, { status: 'ERROR', label: 'INVALID SESSION', detail: 'Invalid operator session — token/admin tidak valid.' });
      return;
    }
    if (errMsg === 'userId berbeda benar sedikit bos') {
      await sbwPatchClaim(id, { status: 'ID_SALAH', label: 'PERLU CEK ID', detail: (err && err.exposeDetail) || ('Tiket tidak ketemu untuk user id "' + String(row.user_id || '') + '" — perbaiki user id / kode tiket lalu tekan Cek Ulang.') });
      return;
    }
    await sbwPatchClaim(id, { status: 'ERROR', label: 'ERROR', detail: errMsg });
  } finally {
    sbwLocks.delete(id);
  }
}

async function sbwDrain() {
  if (sbwBusy) return;
  sbwBusy = true;
  try {
    const st = await getS(['token', 'operationMode']);
    if (!st.token || st.token.length < 10) return; // bot belum siap, tunggu cycle berikutnya
    const rows = await sbwFetch('/claims?select=*&status=eq.PENDING&order=created_at.asc&limit=8');
    if (!Array.isArray(rows) || !rows.length) return;
    for (const row of rows) {
      if (sbwLocks.has(row.id)) continue;
      await sbwProcessOne(row).catch(() => {});
      await sleep(200);
    }
  } catch (_) {
  } finally {
    sbwBusy = false;
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm && alarm.name === 'sbw-poll') sbwDrain().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { try { chrome.alarms.create('sbw-poll', { periodInMinutes: 0.5 }); } catch (_) {} });

(function sbwBoot() {
  try { chrome.alarms.create('sbw-poll', { periodInMinutes: 0.5 }); } catch (_) {}
  (function loop() {
    if (!sbwTimer) sbwTimer = setInterval(() => { sbwDrain().catch(() => {}); }, 8000);
  })();
  setTimeout(() => { sbwDrain().catch(() => {}); }, 4000);
})();

