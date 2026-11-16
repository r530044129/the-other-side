// Where does a frame go? node scripts/bisect.mjs 138 250   (CPU-only time vs GPU-synced time, with parts switched off)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5900 + Math.floor(Math.random() * 90);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?${process.env.QUERY ?? ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  await page.evaluate(() => { window.__noGuard = true; });
  const flagSets = (process.env.FLAGS ?? ',__noWater,__noFlowers,__noGallery,__noMirror,__noDof').split(',');
  for (const t of process.argv.slice(2).map(Number)) {
    for (const fl of flagSets) {
      const r = await page.evaluate(async ({ t, fl, sp }) => {
        for (const k of ['__noWater', '__noFlowers', '__noGallery', '__noMirror', '__noDof', '__noNave']) window[k] = false;
        for (const k of fl.split('+')) if (k) window[k] = true;
        const gl = document.querySelector('canvas').getContext('webgl2');
        window.__tos.seek(t, { warmupFrames: 20, spaceHeld: sp });
        const px = new Uint8Array(4);
        const cpu = [], full = [];
        for (let i = 0; i < 30; i++) {
          const a = performance.now();
          window.__tos.stepSeconds(1 / 60, {});
          const b = performance.now();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          cpu.push(b - a); full.push(performance.now() - a);
        }
        const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
        return { cpu: med(cpu), full: med(full), px: window.__tos.getTelemetrySnapshot().renderPixels };
      }, { t, fl, sp: !process.env.NOSPACE });
      console.log(String(t).padStart(4), (fl || 'all on').padEnd(14), 'cpu', r.cpu.toFixed(1).padStart(6), 'cpu+gpu', r.full.toFixed(1).padStart(6), r.px.join('x'));
    }
  }
} finally { await browser.close(); proc.kill('SIGTERM'); }
