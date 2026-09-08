/* Isi form klaim web bonus (bonussmb.com/tickets).
   Port penuh dari AUTO RELAX - AA/modules/bg-secure.js (automateForm).
   Di-inject ke tab tersembunyi via chrome.scripting.executeScript({files}),
   lalu background mengirim {action:'fillClaim', data} → sendResponse({ok,message}). */
(function () {
  if (window.__claimFillPageLoaded) return;
  window.__claimFillPageLoaded = true;

  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function triggerInput(el, value) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }
  async function waitForOptions(timeout) {
    if (timeout === undefined) timeout = 500;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const opts = Array.from(document.querySelectorAll('[role="option"], .select2__option')).filter(o => o.offsetParent !== null);
      if (opts.length > 0) return opts;
      await wait(5);
    }
    return [];
  }
  async function clickArrowDownAndSelect(ctrl) {
    try {
      if (!ctrl) return false;
      ctrl.click(); await wait(80);
      const inner = ctrl.querySelector('input, [role="combobox"]');
      if (inner) { inner.focus(); inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(120); }
      else { ctrl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(120); }
      const opts = await waitForOptions(500);
      if (opts.length) { opts[0].click(); return true; }
    } catch (e) { /* abaikan */ }
    return false;
  }
  function isFilled(v) { return v !== undefined && v !== null && v !== ''; }
  function validateScatter(value) {
    if (!isFilled(value)) return null;
    const str = value.toString().trim();
    if (!/^\d+$/.test(str)) return null;
    const n = parseInt(str, 10);
    if (n >= 3) return Math.min(n, 5);
    return null;
  }
  async function fillScatter(scatterValue) {
    if (!scatterValue || !validateScatter(scatterValue)) return false;
    const xpath = '//*[@id="radix-«r9»"]/div[2]/form/div[8]/div[2]/div/div';
    const container = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (!container) return false;
    const ctrl = container.querySelector('div[role="combobox"], div > div');
    if (!ctrl) return false;
    ctrl.click(); await wait(50);
    const inner = ctrl.querySelector('input, [role="combobox"]');
    if (inner) { inner.focus(); inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(80); }
    else { ctrl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(80); }
    let opts = []; const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      opts = Array.from(document.querySelectorAll('[role="option"]')).filter(o => o.offsetParent !== null);
      if (opts.length) break;
      await wait(50);
    }
    const val = validateScatter(scatterValue);
    if (!val) return false;
    const match = opts.find(o => o.textContent.trim() === String(val));
    if (match) { match.click(); await wait(100); return true; }
    if (val >= 3 && val <= 5 && opts.length > val - 3) { opts[val - 3].click(); await wait(100); return true; }
    return false;
  }
  async function waitForToast(timeout) {
    if (timeout === undefined) timeout = 12000;
    const startTime = Date.now(); let lastContent = '';
    while (Date.now() - startTime < timeout) {
      const section = document.querySelector('section[aria-label="Notifications alt+T"][tabindex="-1"][aria-live="polite"]');
      if (section) {
        const currentContent = (section.textContent || '').trim();
        if (currentContent && currentContent !== lastContent) {
          lastContent = currentContent;
          await new Promise(r => setTimeout(r, 100));
          const finalContent = (section.textContent || '').trim();
          if (finalContent) return finalContent;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }
  function isLikelySuccess(msg) {
    const m = String(msg || '').toLowerCase();
    return !m.includes('gagal') && !m.includes('error') && !m.includes('tidak valid') && !m.includes('tidak ditemukan') && (m.includes('berhasil') || m.includes('sukses') || m.includes('tersimpan') || m.includes('masuk') || m.includes('klaim'));
  }
  const findOpenBtn = () => document.evaluate('//*[@id="root"]/div/main/div/div[1]/button', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
    || Array.from(document.querySelectorAll('button')).find(b => /tambah|klaim|new|create/i.test(b.textContent || '')) || null;

  async function claimFillRun(data) {
    try {
      await wait(1500);
      const userIdVal = data.hasTS ? data.userId + ' TS' : data.userId;
      let openBtn = findOpenBtn();
      const t0open = Date.now();
      while (!openBtn && Date.now() - t0open < 10000) { await wait(500); openBtn = findOpenBtn(); }
      if (!openBtn) return { ok: false, message: 'Tombol tambah klaim tidak ditemukan' };
      openBtn.click();
      await wait(800);
      const situsDropdown = document.evaluate('//*[@id="radix-«r9»"]/div[2]/form/div[1]/div[2]/div', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (situsDropdown) await clickArrowDownAndSelect(situsDropdown);
      await wait(100);
      const tipeDropdown = document.evaluate('//*[@id="radix-«r9»"]/div[2]/form/div[2]/div[2]/div', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (tipeDropdown) await clickArrowDownAndSelect(tipeDropdown);
      await wait(100);
      const userInput = document.querySelector('input[placeholder="User ID"]');
      if (userInput) { triggerInput(userInput, userIdVal); await wait(100); }
      const kodeInput = document.querySelector('input[placeholder="Kode Tiket"]');
      if (kodeInput) { triggerInput(kodeInput, data.kodeTiket); await wait(100); }
      const bettingInput = document.querySelector('input[type="text"][inputmode="numeric"][placeholder="#######"]');
      if (bettingInput) { triggerInput(bettingInput, data.betting); await wait(100); }
      await wait(150);
      const scatterOk = await fillScatter(data.scatter);
      if (!scatterOk) return { ok: false, message: 'Scatter tidak valid atau tidak ditemukan' };
      const saveBtn = document.querySelector('button[data-slot="button"]');
      if (saveBtn) saveBtn.click();
      const toastMessage = await waitForToast();
      const finalMessage = toastMessage || 'Toast tidak terdeteksi';
      return { ok: isLikelySuccess(finalMessage), message: finalMessage };
    } catch (errFill) {
      return { ok: false, message: 'Script form gagal: ' + String((errFill && errFill.message) || errFill) };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.action !== 'fillClaim') return;
    claimFillRun(msg.data || {}).then(res => {
      try { sendResponse(res); } catch (_) {}
    }).catch(err => {
      try { sendResponse({ ok: false, message: 'Script form gagal: ' + String(err && err.message || err) }); } catch (_) {}
    });
    return true;
  });
})();