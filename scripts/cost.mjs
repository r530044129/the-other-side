// A/B cost probe in one page (same GPU contention for every variant): node scripts/cost.mjs <time> [dpr]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = Number(process.argv[2] ?? 20), dpr = Number(process.argv[3] ?? 2);
const flags = (process.argv[4] ?? '__noNave,__noWater,__noMirror,__noFlowers,__noDof,__noGallery').split(',');
const port = 6100 + Math.floor(Math.random() * 90);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: dpr })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  const res = await page.evaluate(({ t, flags }) => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    const px = new Uint8Array(4);
    window.__tos.seek(t, { warmupFrames: 30 });
    const measure = () => {
      for (let i = 0; i < 6; i++) window.__tos.stepSeconds(1 / 600);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const a = performance.now();
      for (let i = 0; i < 30; i++) { window.__tos.stepSeconds(1 / 600); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      return (performance.now() - a) / 30;
    };
    const out = {};
    const base = [];
    base.push(measure());
    for (const f of flags) { window[f] = true; out[f] = measure(); window[f] = false; base.push(measure()); }
    out.base = base;
    return out;
  }, { t, flags });
  const b = res.base.reduce((x, y) => x + y, 0) / res.base.length;
  console.log(`t=${t} base ${b.toFixed(1)} ms (runs ${res.base.map((x) => x.toFixed(1)).join(' ')})`);
  for (const f of flags) console.log(`  ${f.padEnd(14)} ${res[f].toFixed(1)} ms  saves ${(b - res[f]).toFixed(1)}`);
} finally { await browser.close(); proc.kill(); }
