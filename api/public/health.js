'use strict';
/* GET /api/health — status API publik + database (untuk monitor) */
const L = require('./_lib');

module.exports = async function (req, res) {
  if (req.method !== 'GET') return L.methodNotAllowed(res);

  const start = Date.now();
  let db = 'down', api = 'down';
  try {
    const r = await fetch(L.SB_URL + '/rest/v1/', { method: 'GET' });
    db = r.status === 401 || r.status === 200 ? 'ok' : ('down(' + r.status + ')');
  } catch (e) { db = 'down'; }
  try {
    const sites = await L.activeSites();
    api = sites ? 'ok' : 'down';
  } catch (e) { api = 'down'; }

  return L.ok(res, {
    ok: db === 'ok' && api === 'ok',
    api, db, ms: Date.now() - start, ts: new Date().toISOString()
  });
};