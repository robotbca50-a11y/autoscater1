'use strict';
/* ============================================================
   BANDAR80 — api/master/_lib.js
   Helper bersama fungsi serverless Vercel di situs MASTER (terpisah).
   Termasuk: autentikasi PIN + token HMAC, akses admin ke Supabase.
   ============================================================ */

const crypto = require('crypto');

const SB_URL  = process.env.SUPABASE_URL || 'https://epzuvadrnzdnyyhwiqyc.supabase.co';
const SB_KEY  = process.env.SUPABASE_KEY || 'sb_publishable_4GtsLX1vvVcyfyFnL91JwQ_DLh_jvjP';
const SB_SVC  = process.env.SUPABASE_SERVICE_KEY || '';   // opsional: akses penuh admin
const OW_SECRET = process.env.OWNER_SECRET || '';          // wajib diisikan di Vercel
const OW_PIN    = process.env.OWNER_PIN || '';             // PIN login owner
const TOKEN_TTL = 12 * 3600 * 1000;                        // 12 jam

const WIB_MS = 7 * 3600 * 1000;

/* ---------- respons ---------- */
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
const unauth = (res) => send(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Sesi berakhir. Login ulang.' });
function bad(res, code, message) { send(res, 400, { ok: false, code, message }); }
function fail(res, message) { send(res, 500, { ok: false, code: 'SERVER', message: message || 'Gangguan server.' }); }
function methodNotAllowed(res) { send(res, 405, { ok: false, code: 'METHOD', message: 'Metode tidak didukung.' }); }

/* ---------- body ---------- */
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

/* ---------- IP, origin, rate ---------- */
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
    return u.hostname === host || u.hostname.endsWith('.vercel.app');
  } catch (e) { return false; }
}
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

/* ---------- token owner (HMAC-SHA256, ikat ke IP pemakai) ---------- */
function hmac(payload) {
  return crypto.createHmac('sha256', OW_SECRET).update(payload).digest('hex');
}
function signSession(ip) {
  const exp = Date.now() + TOKEN_TTL;
  const core = exp + '.' + ip;
  return core + '.' + hmac(core);
}
function verifySession(token, ip) {
  if (!token || !OW_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const core = parts[0] + '.' + parts[1];
  const exp = parseInt(parts[0], 10);
  if (!exp || Date.now() > exp) return null;
  const expect = hmac(core);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  const bindIp = parts[1];
  if (bindIp && ip && bindIp !== ip) return null;      // token dikunci ke IP
  return { exp, ip: bindIp };
}
function readToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.indexOf('Bearer ') === 0) return h.slice(7).trim();
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)owner_tok=([^;]+)/.exec(cookies);
  return m ? decodeURIComponent(m[1]) : '';
}
function ownerOk() {
  return !!OW_PIN;
}
function pinMatches(pin) {
  if (!OW_PIN) return false;
  if (OW_PIN.indexOf('sha256:') === 0) {
    const want = OW_PIN.slice(7);
    const got = crypto.createHash('sha256').update(String(pin)).digest('hex');
    const a = Buffer.from(want); const b = Buffer.from(got);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const a = Buffer.from(String(OW_PIN)); const b = Buffer.from(String(pin));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireOwner(req, res) {
  if (!ownerOk()) { denied(res); return null; }
  const ip = clientIp(req);
  const tok = readToken(req);
  if (!verifySession(tok, ip)) { unauth(res); return null; }
  return { ip };
}

/* ---------- WIB ---------- */
function wibDayStartMs() {
  return Date.parse(new Date(Date.now() + WIB_MS).toISOString().slice(0, 10) + 'T00:00:00Z') - WIB_MS;
}
function iso(ts) { return new Date(ts).toISOString(); }

/* ---------- Supabase REST (admin boleh pakai service key bila ada) ---------- */
function admKey() { return SB_SVC || SB_KEY; }
function sbh(prefer, key) {
  const k = key || admKey();
  const h = { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  return h;
}
async function sbGet(path, qs, key) {
  const res = await fetch(SB_URL + '/rest/v1/' + path + (qs ? '?' + qs : ''), { headers: sbh(null, key) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('DB ' + res.status + ': ' + t); }
  return res.json();
}
async function sbDelete(id, key) {
  const res = await fetch(SB_URL + '/rest/v1/claims?id=eq.' + encodeURIComponent(id), {
    method: 'DELETE', headers: sbh(null, key)
  });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (t || '(ditolak policy)'));
  return true;
}
async function sbPatch(id, obj, key) {
  const res = await fetch(SB_URL + '/rest/v1/claims?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', headers: sbh('return=minimal', key), body: JSON.stringify(obj)
  });
  const t = await res.text();
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + t);
  return true;
}

module.exports = {
  send, ok, denied, unauth, bad, fail, methodNotAllowed,
  readBody, clientIp, originOk, rateLimit,
  hmac, signSession, verifySession, readToken, requireOwner, pinMatches, ownerOk,
  wibDayStartMs, iso,
  sbGet, sbDelete, sbPatch, sbh, admKey,
  SB_URL, SB_KEY
};