// Per-shot frame-cost probe: real rAF playback intervals + GPU-synced forced-frame cost.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5400 + Math.floor(Math.random() * 200);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP_DIR, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.DPR ?? 1) })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 20000 });
  await page.evaluate(() => document.getElementById('start-veil')?.classList.add('awakened'));
  if (process.env.FLAG) await page.evaluate((f) => { window[f] = true; }, process.env.FLAG);
  const times = (process.argv[2] ?? '5,20,60,82,94,120,134,160,185,205,218,230,260,275').split(',').map(Number);
  console.log('t(s)  | forced ms/frame avg  p95  max | rAF fps  p95ms  maxms  >33ms');
  for (const t of times) {
    const r = await page.evaluate(async (t) => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      window.__tos.seek(t, { warmupFrames: 20 });
      const px = new Uint8Array(4);
      let cpu = 0, tot = 0;
      for (let i = 0; i < 40; i++) {
        const a = performance.now();
        window.__tos.stepSeconds(1 / 60, {});
        const b = performance.now();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const c = performance.now();
        if (i >= 5) { cpu += b - a; tot += c - a; }
      }
      return { cpu: cpu / 35, tot: tot / 35, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight };
    }, t);
    console.log(t, 'cpu', r.cpu.toFixed(1), 'total', r.tot.toFixed(1), r.w + 'x' + r.h);
  }
  if (errs.length) console.log('ERRORS', errs);
} finally {
  await browser.close();
  proc.kill('SIGTERM');
}
