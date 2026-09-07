/* ============================================================
   BANDAR80 — sb.js (Supabase REST, browser)
   Dipakai oleh index.html (form publik) dan dashboard.html (owner).
   Tidak butuh extension di sisi pengunjung web.
   ============================================================ */
window.SB = (function () {
  var BASE = 'https://epzuvadrnzdnyyhwiqyc.supabase.co/rest/v1';
  var KEY  = 'sb_publishable_4GtsLX1vvVcyfyFnL91JwQ_DLh_jvjP';

  function hdr(prefer) {
    var h = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + KEY,
      'Content-Type': 'application/json'
    };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  function qp(obj) {
    var p = new URLSearchParams();
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null || v === '') return;
      p.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    });
    var s = p.toString();
    return s ? ('?' + s) : '';
  }

  function json(res) {
    return res.text().then(function (t) { return t ? JSON.parse(t) : null; });
  }

  function api(path, opts) {
    return fetch(BASE + path, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error('Supabase ' + res.status + ': ' + t); });
      }
      return json(res);
    });
  }

  /* SELECT list: GET /table?select=...&... */
  function list(table, opts) {
    var o = opts || {};
    var p = { select: o.select ? o.select.join(',') : '*', order: o.order || undefined, limit: o.limit !== undefined ? String(o.limit) : undefined };
    (o.filters || []).forEach(function (f) { p[f.k] = f.v; });
    return api('/' + table + qp(p), { method: 'GET', headers: hdr() });
  }

  /* INSERT: POST /table  (minimal = object tunggal) */
  function insert(table, row) {
    return api('/' + table, { method: 'POST', headers: hdr('return=representation'), body: JSON.stringify(row) })
      .then(function (rows) { return Array.isArray(rows) ? rows[0] : rows; });
  }

  /* UPDATE: PATCH /table?id=eq.<id> */
  function patch(table, id, obj) {
    return api('/' + table + '?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: hdr('return=representation'), body: JSON.stringify(obj) })
      .then(function (rows) { return Array.isArray(rows) ? rows[0] : rows; });
  }

  /* DELETE: DELETE /table?id=eq.<id> */
  function remove(table, id) {
    return api('/' + table + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: hdr() });
  }

  /* daftar situs aktif untuk dropdown */
  function listActiveSites() {
    return list('sites', { select: ['site_id', 'label'], filters: [{ k: 'active', v: 'eq.true' }], order: 'label.asc' });
  }

  return {
    base: BASE, key: KEY,
    list: list, insert: insert, patch: patch, remove: remove,
    listActiveSites: listActiveSites
  };
})();