// Shot ② motion check: steps 12.5..46.3 s at 60 fps and reports the largest per-frame change of each flower.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5900 + Math.floor(Math.random() * 90);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  const res = await page.evaluate(() => {
    const out = { B: { maxDy: 0, at: 0, maxDo: 0, atO: 0 }, A: { maxDy: 0, at: 0, maxDo: 0, atO: 0 }, C: { maxDy: 0, at: 0, maxDo: 0, atO: 0 } };
    const trace = [];
    let tel = window.__tos.seek(12.5, { warmupFrames: 4 });
    let prev = tel.shylight;
    let glowMaxStep = 0;
    for (let i = 0; i < Math.round((46.3 - 12.5) * 60); i++) {
      tel = window.__tos.stepSeconds(1 / 60);
      const cur = tel.shylight;
      for (const k of ['B', 'A', 'C']) {
        const dy = Math.abs(cur[k].canopyWorldY - prev[k].canopyWorldY);
        const dOpen = Math.abs(cur[k].open - prev[k].open);
        if (dy > out[k].maxDy) { out[k].maxDy = dy; out[k].at = tel.songTimeSec; }
        if (dOpen > out[k].maxDo) { out[k].maxDo = dOpen; out[k].atO = tel.songTimeSec; }
        glowMaxStep = Math.max(glowMaxStep, Math.abs(cur[k].glow - prev[k].glow));
      }
      if (i % 30 === 0) trace.push([tel.songTimeSec.toFixed(2), cur.B.canopyWorldY.toFixed(2), cur.B.open.toFixed(2), cur.A.canopyWorldY.toFixed(2), cur.A.open.toFixed(2), cur.C.canopyWorldY.toFixed(2), cur.C.open.toFixed(2)].join(' '));
      prev = cur;
    }
    return { out, glowMaxStep, trace };
  });
  console.log(JSON.stringify(res.out), 'max glow step per frame', res.glowMaxStep.toFixed(4));
  console.log('t  B.y B.open  A.y A.open  C.y C.open');
  console.log(res.trace.join('\n'));
} finally { await browser.close(); proc.kill(); }
