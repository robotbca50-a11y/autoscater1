'use strict';
/* POST /api/submit — terima klaim publik, enforce limit 2/hari di edge
   (pra-cek + backstop trigger DB), honeypot, validasi ketat, rate limit. */
const L = require('./_lib');

const SITE_RE = /^[a-z0-9_]{1,40}$/;
const TX_RE   = /^[0-9]{1,40}$/;
const MONEY_MIN = 1600, MONEY_MAX = 1000000;
const SCATTER_ALLOWED = [3, 4, 5];

module.exports = async function (req, res) {
  if (req.method !== 'POST') return L.methodNotAllowed(res);
  if (req.headers['content-type'] && req.headers['content-type'].indexOf('application/json') < 0) {
    return L.bad(res, 'BAD_TYPE', 'Format data tidak didukung.');
  }

  const ip = L.clientIp(req);
  if (!L.originOk(req)) return L.denied(res);

  let rl = L.rateLimit(ip, 60000, 8);               // 8/menit per IP
  if (!rl.ok) return L.send(res, 429, { ok: false, code: 'RATE', message: 'Terlalu sering. Coba sebentar lagi.' });

  let body;
  try { body = await L.readBody(req, 32 * 1024); }
  catch (e) { return L.bad(res, 'BAD_BODY', 'Data klaim tidak terbaca.'); }
  if (!body || typeof body !== 'object') return L.bad(res, 'BAD_BODY', 'Data klaim tidak terbaca.');

  /* honeypot: calon bot mengisi kolom tersembunyi → balas palsu "berhasil" */
  if ((body.website && String(body.website).trim()) || (body.company && String(body.company).trim())) {
    return L.ok(res, { ok: true, faked: true });
  }
  /* time-trap: kirim minimal 2,5 dtk setelah halaman dibuka */
  if (typeof body.t !== 'number' || Date.now() - body.t < 2500) {
    return L.bad(res, 'TOO_FAST', 'Mohon tunggu beberapa detik sebelum mengirim.');
  }

  const site   = String(body.site || '').trim().slice(0, 40);
  const userId = String(body.user_id || '').trim().slice(0, 64);
  const tx     = String(body.kode_tiket || '').trim().slice(0, 40);
  const betRaw = String(body.betting || '').replace(/[^\d]/g, '').slice(0, 12);
  const scatter = Number(body.scatter);

  if (!SITE_RE.test(site)) return L.bad(res, 'BAD_SITE', 'Pilih situs tujuan yang valid.');
  if (!userId || userId.length < 2) return L.bad(res, 'BAD_USER', 'User ID tidak valid.');
  if (!TX_RE.test(tx) || tx.length < 6) return L.bad(res, 'BAD_TX', 'Kode tiket tidak valid.');
  const betting = parseInt(betRaw, 10);
  if (!betting || betting < MONEY_MIN || betting > MONEY_MAX) {
    return L.bad(res, 'BAD_BET', 'Nominal bet harus antara Rp 1.600 dan Rp 1.000.000.');
  }
  if (SCATTER_ALLOWED.indexOf(scatter) < 0) return L.bad(res, 'BAD_SC', 'Jumlah scatter tidak valid.');

  try {
    /* situs harus terdaftar & aktif */
    const sites = await L.activeSites();
    if (!sites[site] || !sites[site].active) return L.bad(res, 'SITE_OFF', 'Situs tujuan sedang dinonaktifkan.');

    /* pra-cek kuota hari ini (WIB) */
    const from = L.iso(L.wibDayStartMs());
    const cnt = await L.sbCount('claims',
      'user_id=eq.' + encodeURIComponent(userId) +
      '&created_at=gte.' + encodeURIComponent(from) +
      '&created_at=lt.' + encodeURIComponent(new Date(Date.now() + 1000).toISOString()));
    if (cnt !== -1 && cnt >= 2) {
      return L.bad(res, 'LIMIT_DAILY', 'Anda sudah 2 kali claim hari ini. Coba kembali setelah ganti hari.');
    }

    const rows = await L.sbInsert('claims', {
      site, user_id: userId, kode_tiket: tx, betting, scatter
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return L.ok(res, { ok: true, row: row ? { id: row.id, status: row.status } : null });
  } catch (e) {
    if (e instanceof L.DbError) return L.bad(res, L.friendlyInsertError(e).code, L.friendlyInsertError(e).message);
    return L.fail(res, 'Gagal menghubungi penyimpanan.');
  }
};