/* ============================================================
   BANDAR80 — sb.js (klien web PUBLIK → /api/*)
   Dipakai index.html. TIDAK ada kunci/URL Supabase di browser:
   semua akses lewat serverless API sesama domain.
   ============================================================ */
window.SB = (function () {
  function esc(v) { return encodeURIComponent(String(v == null ? '' : v)); }
  function call(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
    if (body) opt.body = JSON.stringify(body);
    return fetch(url, opt).then(function (res) {
      return res.json().catch(function () { return { ok: false, code: 'BAD_HTTP', message: 'Server error' }; })
        .then(function (d) {
          if (!res.ok || d === null || d.ok === false) {
            var e = new Error((d && d.message) || ('HTTP ' + res.status));
            e.code = (d && d.code) || ('HTTP' + res.status);
            e.http = res.status;
            throw e;
          }
          return d;
        });
    });
  }

  function get(path, params) {
    var qs = Object.keys(params || {}).map(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return '';
      return esc(k) + '=' + esc(v);
    }).filter(Boolean).join('&');
    return call('GET', path + (qs ? '?' + qs : ''));
  }
  function post(path, obj) { return call('POST', path, obj || {}); }

  return {
    /* dropdown situs */
    listActiveSites: function () {
      return get('/api/sitelist').then(function (d) { return d.sites || []; });
    },
    /* kirim klaim (via API, ada penegakan limit 2/hari) */
    insert: function (table, row) {
      if (table !== 'claims') return Promise.reject(Object.assign(new Error('tidak didukung'), { code: 'NS' }));
      return post('/api/submit', row).then(function (d) { return d.row || []; });
    },
    /* lacak status + kuota user */
    list: function (table, opts) {
      if (table !== 'claims') return Promise.reject(Object.assign(new Error('tidak didukung'), { code: 'NS' }));
      var u = (opts && opts.filters || []).filter(function (f) { return f.k === 'user_id'; })[0] || null;
      var uid = u ? String(u.v).replace(/^eq\./, '') : '';
      if (!uid) return Promise.reject(Object.assign(new Error('user_id wajib'), { code: 'BAD_USER' }));
      return get('/api/track', { user_id: uid }).then(function (d) { return d.rows || []; });
    },
    /* kuota hari ini utk user */
    today: function (userId) {
      return get('/api/track', { user_id: userId }).then(function (d) { return { used: d.used, max: d.max }; });
    }
  };
})();