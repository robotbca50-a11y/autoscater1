/* ============================================================
   build/monitor.mjs — cek status situs publik + master + database.
   Cara pakai:
     node build/monitor.mjs                    # 1x cek, cetak hasil
     node build/monitor.mjs --watch 60         # ulang tiap 60 detik
   Notifikasi Telegram opsional (env): TG_BOT_TOKEN, TG_CHAT_ID.
   Exit code: 0 = semua sehat, 1 = ada yang down (hanya mode 1x).
   ============================================================ */
import process from 'process';

const PUBLIC = process.env.PUBLIC_BASE_URL || 'https://autoscater1.vercel.app';
const MASTER = process.env.MASTER_BASE_URL || 'https://autoscater1-master.vercel.app';
const TG_BOT = process.env.TG_BOT_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT_ID || '';

async function probe(name, url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'GET' });
    return { name, url, status: r.status, ms: Date.now() - t0, ok: r.ok };
  } catch (e) {
    return { name, url, status: 0, ms: Date.now() - t0, ok: false, err: String(e.message || e) };
  }
}

async function sendTg(text) {
  if (!TG_BOT || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_BOT + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text })
    });
  } catch (e) { /* abaikan */ }
}

let prevOk = true;
let prevHad = false;

async function run() {
  const checks = await Promise.all([
    probe('publik:beranda', PUBLIC),
    probe('publik:api', PUBLIC + '/api/health'),
    probe('master:beranda', MASTER),
    probe('master:api', MASTER + '/api/health')
  ]);

  checks.forEach((c) => console.log(
    (c.ok ? 'OK ' : '!! ') + c.name + '  ' + c.url + '  ' + (c.status || 'NO-RESP') +
    ' ' + c.ms + 'ms' + (c.err ? '  ' + c.err : '')
  ));

  const down = checks.filter((c) => !c.ok);
  const nowOk = down.length === 0;

  if (!prevHad) {
    prevHad = true;
    prevOk = nowOk;
  } else if (nowOk !== prevOk) {
    if (nowOk) {
      console.log('↻ semua pulih.');
      await sendTg('🟢 AUTOSCATER MONITOR\nSemua layanan pulih kembali.');
    } else {
      console.log('⛔ ADA LAYANAN DOWN.');
      await sendTg('🔴 AUTOSCATER MONITOR\n' + down.map((c) => '• ' + c.name + ' — ' + (c.status || 'no response') + (c.err ? ' (' + c.err + ')' : '')).join('\n'));
    }
  }
  prevOk = nowOk;
  return nowOk ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const w = args.indexOf('--watch');
  const intervalSec = w >= 0 ? (parseInt(args[w + 1], 10) || 60) : 0;
  try {
    const code = await run();
    if (intervalSec === 0) process.exit(code);
    console.log('monitoring berjalan, cek tiap ' + intervalSec + ' detik. Ctrl+C untuk berhenti.');
  } catch (e) {
    console.error('monitor crash:', e && e.message);
    if (intervalSec === 0) process.exit(1);
  }
  if (intervalSec > 0) {
    setInterval(function () { run().catch(() => {}); }, Math.max(10, intervalSec) * 1000);
    /* jaga proses tetap hidup */
    setInterval(function () {}, 2 ** 31 - 1);
  }
}

main();