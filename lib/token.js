let cachedHistoryToken = '';
let cachedHistoryTokenAt = 0;

async function saveToken(tk) {
  if (!tk || tk.length < 10) return false;
  await setS({ token: tk, tokenUpdatedAt: Date.now() });
  chrome.runtime.sendMessage({ action: 'tokenUpdated', token: tk }).catch(() => {});
  return true;
}

async function getHistoryToken() {
  const now = Date.now();
  if (cachedHistoryToken && (now - cachedHistoryTokenAt) < APP.HISTORY_TOKEN_TTL_MS) return cachedHistoryToken;
  const { historyToken, historyTokenAt } = await getS(['historyToken', 'historyTokenAt']);
  if (historyToken && historyTokenAt && (now - historyTokenAt) < APP.HISTORY_TOKEN_TTL_MS) {
    cachedHistoryToken = historyToken;
    cachedHistoryTokenAt = historyTokenAt;
    return historyToken;
  }
  return null;
}

async function saveHistoryToken(tk) {
  if (!tk || tk.length < 10) return false;
  cachedHistoryToken = tk;
  cachedHistoryTokenAt = Date.now();
  await setS({ historyToken: tk, historyTokenAt: Date.now() });
  chrome.runtime.sendMessage({ action: 'historyTokenUpdated', historyToken: tk }).catch(() => {});
  return true;
}

async function getAutoTokenFromTab(mId, sId, gameId, domain) {
  const cached = await getHistoryToken();
  if (cached) return cached;
  return refreshHistoryTokenViaTab(mId, sId, gameId, domain);
}

async function refreshHistoryTokenViaTab(mId, sId, gameId, domain) {
  return new Promise(resolve => {
    const invoice = `${sId}-${sId}-106-0`;
    const gameName = gameId || '74';
    const host = (domain || 'bandar80.idrbo2.com').replace(/^https?:\/\//, '').split('/')[0];
    const url = `https://${host}/keterangan-detail.html?playerName=${encodeURIComponent(mId)}&invoice=${encodeURIComponent(invoice)}&gamename=${encodeURIComponent(gameName)}&tablekey=7`;
    let resolved = false, tabId = null, pollTimer = null;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (tabId) { chrome.tabs.remove(tabId).catch(() => {}); tabId = null; }
    };
    const finish = (token) => {
      if (resolved) return;
      resolved = true; cleanup();
      if (token) saveHistoryToken(token).catch(() => {});
      resolve(token || null);
    };
    const tryExtractTokenFromUrl = (currentUrl) => {
      if (!currentUrl || !currentUrl.includes('t=')) return;
      try {
        const parsed = new URL(currentUrl);
        const t = parsed.searchParams.get('t');
        if (t && t.length >= 10) { finish(t); return; }
      } catch (_) {}
      const m = currentUrl.match(/[?&]t=([A-Za-z0-9_.~-]{10,})/);
      if (m && m[1] && m[1].length >= 10) finish(m[1]);
    };
    const onUpdate = (updId, info) => { if (updId === tabId && info.url) tryExtractTokenFromUrl(info.url); };
    const startPolling = (tid) => {
      pollTimer = setInterval(() => {
        if (resolved) { clearInterval(pollTimer); pollTimer = null; return; }
        chrome.tabs.get(tid, tab => {
          if (chrome.runtime.lastError || !tab || !tab.url) return;
          tryExtractTokenFromUrl(tab.url);
        });
      }, 200);
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
    safeTabCreate(url, { active: false }).then(tab => { tabId = tab.id; startPolling(tab.id); setTimeout(() => finish(null), 15000); }).catch(() => finish(null));
  });
}

async function forceRefreshHistoryToken(mId, sId, gameId, domain) {
  cachedHistoryToken = '';
  cachedHistoryTokenAt = 0;
  await setS({ historyToken: '', historyTokenAt: 0 });
  return refreshHistoryTokenViaTab(mId, sId, gameId, domain);
}

async function saveTokenAnchor(userId, transactionId) {
  if (!userId || !transactionId) return;
  const { tokenAnchor: cur } = await getS(['tokenAnchor']);
  if (cur && cur.userId === userId && cur.transactionId === transactionId) return;
  await setS({ tokenAnchor: { userId, transactionId, savedAt: Date.now() } });
  chrome.runtime.sendMessage({ action: 'tokenAnchorUpdated', anchor: { userId, transactionId } }).catch(() => {});
}

function getDomainFromUrl(raw) {
  return (raw || '').replace(/^https?:\/\//, '').split('/')[0];
}

function urlMatchesSnifferTarget(urlStr, targetDomain) {
  if (!urlStr) return false;
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    if (/\.idrbo(1|2|3)?\.com$|idrbo(1|2|3)?\.com$/.test(host)) return true;
    if (/^public[.\-]/.test(host) || /^public-api[.\-]/.test(host)) return false;
    const td = (targetDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!td) return false;
    return host === td || host.endsWith('.' + td);
  } catch (_) { return false; }
}
