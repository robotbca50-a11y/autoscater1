import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import obfuscator from 'javascript-obfuscator';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PRESET = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,          // WAJIB false: getS/setS dll dipakai lintas file via importScripts
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayThreshold: 0.7,
  selfDefending: false,          // nonaktif agar tidak menjebak user (loop Pause)
  debugProtection: false,
  disableConsoleOutput: false,
  target: 'node',
  simplify: true,
  transformObjectKeys: false,
  splitStrings: false
};
const PRESET_WEB = { ...PRESET, disableConsoleOutput: true };

function ob(code, preset) {
  return obfuscator.obfuscate(code, preset).getObfuscatedCode();
}
function check(name, outPath) {
  try { execSync(`node --check "${outPath}"`, { stdio: 'pipe' }); console.log(`  OK   ${name}`); return true; }
  catch (e) { console.log(`  FAIL ${name}: ${String(e.stderr || e.message)}`); return false; }
}
function checkHtml(name, html) {
  const scripts = [...html.matchAll(INLINE)].map(m => m[1]).filter(s => s.trim());
  let ok = true;
  scripts.forEach((s, i) => {
    const tmp = join(process.env.TEMP, `_ob_${Date.now()}_${i}.js`);
    writeFileSync(tmp, s, 'utf8');
    try { execSync(`node --check "${tmp}"`, { stdio: 'pipe' }); }
    catch (e) { console.log(`  FAIL inline ${name}[${i}]: ${String(e.stderr || e.message)}`); ok = false; }
    finally { rmSync(tmp, { force: true }); }
  });
  if (ok) console.log(`  OK   inline ${name} (${scripts.length} script)`);
  return ok;
}

/* ============================================================
   1) WEB (deploy/) — dipakai sebagai isi repo → supaya yang
   disajikan online bukan kode asli yang mudah dibaca.
   ============================================================ */
const webSrc = join(root, 'web');
const outWeb = join(root, 'deploy');
if (existsSync(outWeb)) rmSync(outWeb, { recursive: true, force: true });
mkdirSync(outWeb, { recursive: true });

const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';
const CFG_INJECT =
  `<script>window.__CFG__=window.__CFG__||{};window.__CFG__.SUPABASE_URL='${SB_URL}';window.__CFG__.SB_KEY='${SB_KEY}';</script>`;

for (const name of ['index.html', 'dashboard.html']) {
  const file = join(webSrc, name);
  if (!existsSync(file)) continue;
  let html = readFileSync(file, 'utf8');
  html = html.replace('<script src="sb.js"></script>', CFG_INJECT + '<script src="sb.js"></script>');
  const obfHtml = html.replace(INLINE, (match, code) => {
    const obf = ob(code, PRESET_WEB);
    return `<script>${obf}</script>`;
  });
  writeFileSync(join(outWeb, name), obfHtml, 'utf8');
  console.log('web  ' + name + '  (inline script obfuscated)');
  checkHtml(name, obfHtml);
}

const sbRaw = readFileSync(join(webSrc, 'sb.js'), 'utf8');
writeFileSync(join(outWeb, 'sb.js'), ob(sbRaw, PRESET_WEB), 'utf8');
console.log('web  sb.js (obfuscated)');

copyFileSync(join(root, 'messageImage_1787629523742.jpg'), join(outWeb, 'messageImage_1787629523742.jpg'));
mkdirSync(join(outWeb, 'supabase'), { recursive: true });
copyFileSync(join(webSrc, 'supabase', 'setup.sql'), join(outWeb, 'supabase', 'setup.sql'));
console.log('web  asset jpg + supabase/setup.sql copied');

/* ============================================================
   2) EXTENSION (dist-extension/) — versi aman utk dipasang.
   ============================================================ */
const extFiles = [
  'background.js', 'app.js', 'popup.js', 'content.js', 'detail_processor.js',
  'tickets_monitor.js', 'bridge-scatter.js', 'web_claim_bridge.js', 'sb.js',
  'lib/constants.js', 'lib/utils.js', 'lib/parser.js', 'lib/token.js',
  'app.html', 'app.css', 'manifest.json', 'web_claim_dashboard.html',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  'videos/lofi.mp4', 'messageImage_1787629523742.jpg'
];
const exHtmlObf = ['web_claim_dashboard.html', 'app.html'];
const outExt = join(root, 'dist-extension');
if (existsSync(outExt)) rmSync(outExt, { recursive: true, force: true });
mkdirSync(outExt, { recursive: true });

let failed = 0;
for (const rel of extFiles) {
  const src = join(root, rel);
  if (!existsSync(src)) { console.log('skip (missing) ' + rel); continue; }
  const dst = join(outExt, rel);
  mkdirSync(dirname(dst), { recursive: true });
  if (rel.endsWith('.js')) {
    writeFileSync(dst, ob(readFileSync(src, 'utf8'), PRESET), 'utf8');
    if (!check(rel, dst)) failed++;
  } else if (exHtmlObf.includes(rel)) {
    const obfHtml = readFileSync(src, 'utf8').replace(INLINE, (m, code) => `<script>${ob(code, PRESET)}</script>`);
    writeFileSync(dst, obfHtml, 'utf8');
    if (!checkHtml(rel, obfHtml)) failed++;
  } else {
    copyFileSync(src, dst);
    console.log('copy ' + rel);
  }
}

console.log(failed ? `\n[done] ${failed} file JS PERLU dicek manual` : '\n[done] all good');