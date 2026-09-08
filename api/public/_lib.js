'use strict';
/* ============================================================
   BANDAR80 — api/public/_lib.js
   Helper bersama untuk fungsi serverless Vercel di situs PUBLIK.
   Kunci Supabase berada DI SINI (env server), tidak pernah
   dikirim ke browser.
   ============================================================ */

const SB_URL = process.env.SUPABASE_URL || 'https://epzuvadrnzdnyyhwiqyc.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_4GtsLX1vvVcyfyFnL91JwQ_DLh_jvjP';

const WIB_MS = 7 * 3600 * 1000;

/* ---------- respons JSON ---------- */
function send(res, code, obj, extra) {
  res.statusCode = code;
  if (extra) for (const k in extra) res.setHeader(k, extra[k]);
  if (code >= 400) res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
const ok     = (res, obj) => send(res, 200, obj);
const denied = (res) => send(res, 403, { ok: false, code: 'FORBIDDEN', message: 'Akses ditolak.' });
function bad(res, code, message, extra) { send(res, 400, { ok: false, code, message }, extra); }
function fail(res, message) { send(res, 500, { ok: false, code: 'SERVER', message: message || 'Gangguan server.' }); }
function methodNotAllowed(res) { send(res, 405, { ok: false, code: 'METHOD', message: 'Metode tidak didukung.' }); }

/* ---------- baca body JSON (dengan batas ukuran) ---------- */
function readBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > maxBytes) { reject(new Error('PAYLOAD_TOO_BIG')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------- IP + guard origin (anti abuse lintas situs) ---------- */
function clientIp(req) {
  const x = req.headers['x-forwarded-for'];
  if (x) return String(x).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '?';
}
function originOk(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const o = String(req.headers['origin'] || '').toLowerCase();
  if (!o) return true;
  try {
    const u = new URL(o);
    const h = u.hostname;
    return h === host || h.endsWith('.vercel.app');
  } catch (e) { return false; }
}

/* ---------- rate limit sederhana (per lambda; cukup memberatkan bot) ---------- */
const buckets = new Map();
function rateLimit(ip, winMs, max) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.reset) { b = { n: 0, reset: now + winMs }; buckets.set(ip, b); }
  if (buckets.size > 20000) {
    for (const [key, val] of buckets) if (now > val.reset) buckets.delete(key);
  }
  b.n++;
  return { ok: b.n <= max, n: b.n, retryAfterMs: Math.max(0, b.reset - now) };
}

/* ---------- waktu WIB (batas 2 klaim/hari, reset tengah malam WIB) ---------- */
function wibDayStartMs() {
  return Date.parse(new Date(Date.now() + WIB_MS).toISOString().slice(0, 10) + 'T00:00:00Z') - WIB_MS;
}
function iso(ts) { return new Date(ts).toISOString(); }

/* ---------- Supabase REST ---------- */
function sbh(prefer, key) {
  const k = key || SB_KEY;
  const h = { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  return h;
}
async function sbGet(path, qs, key) {
  const res = await fetch(SB_URL + '/rest/v1/' + path + (qs ? '?' + qs : ''), { headers: sbh(null, key) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('DB ' + res.status + ': ' + t); }
  return res.json();
}
async function sbCount(path, qs, key) {
  const res = await fetch(SB_URL + '/rest/v1/' + path + '?select=id&' + qs, { headers: sbh('count=exact', key) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('DB ' + res.status + ': ' + t); }
  await res.text();
  const m = /^.*\/(\d+|\*)$/.exec(res.headers.get('content-range') || '');
  return m ? parseInt(m[1], 10) : -1;
}
async function sbInsert(table, row, prefer, key) {
  const res = await fetch(SB_URL + '/rest/v1/' + table, {
    method: 'POST', headers: sbh(prefer || 'return=representation', key), body: JSON.stringify(row)
  });
  const t = await res.text();
  if (!res.ok) throw new DbError(res.status, t);
  return t ? JSON.parse(t) : null;
}

function DbError(status, bodyText) {
  const e = new Error(bodyText || ('DB ' + status));
  e.status = status; e.bodyText = bodyText || '';
  return e;
}

function friendlyInsertError(err) {
  const s = String(err.bodyText || err.message || '');
  if (/maksimal 2 klaim per user id per hari/i.test(s)) {
    return { code: 'LIMIT_DAILY', message: 'Anda sudah 2 kali claim hari ini. Coba kembali setelah ganti hari.' };
  }
  if (/pengajuan klaim dibuka/i.test(s)) {
    return { code: 'SVC_HOURS', message: 'Pendaftaran klaim dibuka 00.00 s/d 23.50 WIB. Coba kembali setelah ganti hari.' };
  }
  if (/betting\s*>\s*0|check constraint/i.test(s)) {
    return { code: 'BET_INVALID', message: 'Nominal bet tidak valid.' };
  }
  return { code: 'DB_INSERT', message: 'Klaim sedang ramai, coba beberapa saat lagi.' };
}

/* ---------- daftar situs aktif (cache 60 dtk) ---------- */
let sitesCache = null, sitesAt = 0;
async function activeSites() {
  const now = Date.now();
  if (sitesCache && now - sitesAt < 60000) return sitesCache;
  const rows = await sbGet('sites', 'select=site_id,label,active');
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r) { map[r.site_id] = { label: r.label, active: !!r.active }; });
  sitesCache = map; sitesAt = now;
  return map;
}

module.exports = {
  send, ok, denied, bad, fail, methodNotAllowed,
  readBody, clientIp, originOk, rateLimit,
  wibDayStartMs, iso,
  sbGet, sbCount, sbInsert, DbError, friendlyInsertError,
  activeSites,
  SB_URL
};