'use strict';
/* POST /api/auth {pin} → token sesi owner (cookie httpOnly + kembalian token) */
const L = require('./_lib');

module.exports = async function (req, res) {
  if (req.method !== 'POST') return L.methodNotAllowed(res);
  if (!L.ownerOk()) return L.denied(res);

  const ip = L.clientIp(req);
  if (!L.originOk(req)) return L.denied(res);

  let rl = L.rateLimit(ip, 60000, 10);
  if (!rl.ok) return L.send(res, 429, { ok: false, code: 'RATE', message: 'Terlalu sering mencoba. Tunggu sebentar.' });

  let body;
  try { body = await L.readBody(req, 8 * 1024); }
  catch (e) { return L.bad(res, 'BAD_BODY', 'Data tidak terbaca.'); }

  if (!L.pinMatches(body && body.pin)) {
    return L.denied(res);
  }

  const token = L.signSession(ip);
  const cookie =
    'owner_tok=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + Math.floor(12 * 3600);

  return L.ok(res, { ok: true, token }, {
    'Set-Cookie': cookie,
    'Cache-Control': 'no-store'
  });
};