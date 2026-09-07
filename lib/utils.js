function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getS(keys) {
  return new Promise(r => chrome.storage.local.get(keys, res => { const e = chrome.runtime.lastError; if (e) { try { console.warn('getS error:', e.message); } catch (_) {} chrome.runtime.lastError = null; r({}); } else r(res); }));
}

function setS(data) {
  return new Promise(r => chrome.storage.local.set(data, () => { const e = chrome.runtime.lastError; if (e) { try { console.warn('setS error:', e.message); } catch (_) {} chrome.runtime.lastError = null; } r(); }));
}

function notify(msg) {
  chrome.runtime.sendMessage({ action: 'updateStatus', status: msg }).catch(() => {});
}

function resolveUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL(path)
    : path;
}

function extractToken(url) {
  if (!url) return '';
  const s = String(url);
  const m1 = s.match(/redirect\.html[^"'\s]*[?&]t=([A-Za-z0-9_.~-]{10,})/i);
  if (m1) return m1[1];
  const m2 = s.match(/GetBetHistory[^"'\s]*[?&]t=([^&\s"']{10,})/i);
  if (m2) return m2[1];
  const m3 = s.match(/[?&]t=([A-Za-z0-9_.~-]{10,})/i);
  return m3 ? m3[1] : '';
}

const _TOKEN_PATTERNS = [/^[A-Za-z0-9_\-]{32,}$/, /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/, /^eyJ[A-Za-z0-9_\-]+/];
function looksLikeToken(v) {
  if (!v || v.length < 20) return false;
  return _TOKEN_PATTERNS.some(p => p.test(v));
}

function parseAmount(v) {
  if (!v) return 0;
  let s = String(v).replace(/rp/ig, '').replace(/\s+/g, '');
  if (!s) return 0;
  const hasDot = s.includes('.');
  const hasCom = s.includes(',');
  if (hasDot && hasCom) {
    s = s.lastIndexOf('.') > s.lastIndexOf(',') ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (hasCom) {
    s = s.split(',').pop().length === 2 ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (hasDot) {
    s = s.split('.').pop().length === 2 ? s : s.replace(/\./g, '');
  }
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  return isFinite(n) ? n : 0;
}

function extractScatterNum(t) {
  if (!t) return '';
  const m = String(t).match(/(\d+)/);
  return m ? String(Math.min(parseInt(m[1], 10), 5)) : '';
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
}

function escapeAttr(v) {
  return String(v ?? '').replace(/[\\'"]/g, '');
}

function extractRuntimeConfigFromHistoryUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const encApi = parsed.searchParams.get('api') || '';
    const decApi = encApi ? decodeURIComponent(encApi) : '';
    const apiHost = decApi.split('/web-api')[0] || '';
    const tokMatch = rawUrl.match(/GetBetHistory&lang=en&t=([^&\s]+)/i) || rawUrl.match(/[?&]t=([^&\s]+)/i);
    const gameIdM = parsed.pathname.match(/\/history\/(\d+)\.html/i);
    return {
      token: tokMatch ? tokMatch[1] : '',
      historyHost: parsed.host || '',
      apiHost,
      historyGameId: gameIdM ? gameIdM[1] : '74'
    };
  } catch {
    return null;
  }
}
