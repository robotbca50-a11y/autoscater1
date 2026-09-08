'use strict';
/* GET /api/track?user_id=... — lacak status klaim + sisa kuota hari ini */
const L = require('./_lib');

module.exports = async function (req, res) {
  if (req.method !== 'GET') return L.methodNotAllowed(res);

  const ip = L.clientIp(req);
  let rl = L.rateLimit(ip, 60000, 60);
  if (!rl.ok) return L.send(res, 429, { ok: false, code: 'RATE', message: 'Terlalu sering. Coba sebentar lagi.' });

  const url = new URL(req.url, 'http://x');
  const userId = String(url.searchParams.get('user_id') || '').trim().slice(0, 64);
  if (!userId) return L.bad(res, 'BAD_USER', 'Isi User ID dulu.');

  try {
    const from = L.iso(L.wibDayStartMs());
    const used = await L.sbCount('claims',
      'user_id=eq.' + encodeURIComponent(userId) +
      '&created_at=gte.' + encodeURIComponent(from) +
      '&created_at=lt.' + encodeURIComponent(new Date(Date.now() + 1000).toISOString()));

    const rows = await L.sbGet('claims',
      'select=id,site,user_id,kode_tiket,betting,scatter,status,label,detail,created_at,updated_at' +
      '&user_id=eq.' + encodeURIComponent(userId) +
      '&order=created_at.desc&limit=20');

    return L.ok(res, { ok: true, used: used === -1 ? 0 : used, max: 2, rows: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    return L.fail(res, 'Gagal menghubungi penyimpanan.');
  }
};