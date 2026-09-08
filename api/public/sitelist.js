'use strict';
/* GET /api/sitelist — daftar situs aktif untuk dropdown form */
const L = require('./_lib');

module.exports = async function (req, res) {
  if (req.method !== 'GET') return L.methodNotAllowed(res);

  let rl = L.rateLimit(L.clientIp(req), 60000, 120);
  if (!rl.ok) return L.send(res, 429, { ok: false, code: 'RATE', message: 'Terlalu sering.' });

  try {
    const sites = await L.activeSites();
    const out = Object.keys(sites)
      .filter(function (k) { return sites[k].active; })
      .map(function (k) { return { site_id: k, label: sites[k].label }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label); });
    return L.ok(res, { ok: true, sites: out });
  } catch (e) {
    return L.fail(res, 'Gagal mengambil daftar situs.');
  }
};