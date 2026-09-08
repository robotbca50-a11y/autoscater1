'use strict';
/* GET /api/health — status situs publik + API master + database */
const L = require('./_lib');

const PUBLIC = process.env.PUBLIC_BASE_URL || 'https://autoscater1.vercel.app';

module.exports = async function (req, res) {
  if (req.method !== 'GET') return L.methodNotAllowed(res);

  const start = Date.now();
  let db = 'down', api = 'down', pub = 'down';

  try {
    const r = await fetch(L.SB_URL + '/rest/v1/', { method: 'GET' });
    db = r.status === 401 || r.status === 200 ? 'ok' : 'down(' + r.status + ')';
  } catch (e) { db = 'down'; }
  try {
    const r = await fetch(PUBLIC + '/api/health', { method: 'GET' });
    const j = await r.json().catch(function () { return null; });
    api = r.ok && j && j.ok ? 'ok' : 'down(' + r.status + ')';
  } catch (e) { api = 'down'; }
  try {
    const r = await fetch(PUBLIC, { method: 'GET' });
    pub = r.ok ? 'ok' : 'down(' + r.status + ')';
  } catch (e) { pub = 'down'; }

  return L.ok(res, {
    ok: db === 'ok' && api === 'ok' && pub === 'ok',
    public: pub, publicApi: api, db,
    publicUrl: PUBLIC,
    ms: Date.now() - start, ts: new Date().toISOString()
  });
};