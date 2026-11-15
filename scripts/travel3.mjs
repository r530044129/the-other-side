// Shot ③ height check: node scripts/travel3.mjs <from> <to> [hold from] [hold to]
// Plays forward in small steps (no seeks in between) and prints the three flowers' heights.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [from, to, h0, h1] = process.argv.slice(2).map(Number);
const port = 5700 + Math.floor(Math.random() * 200);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  const rows = await page.evaluate(({ from, to, h0, h1 }) => {
    const out = [];
    window.__tos.seek(from, { warmupFrames: 2 });
    let prev = null;
    for (let t = from; t < to; t += 0.1) {
      const held = Number.isFinite(h0) && t >= h0 && t < h1;
      const tel = window.__tos.stepSeconds(0.1, { spaceHeld: held, dtStep: 1 / 60 });
      const s = tel.shylight;
      const y = [s.B.canopyWorldY, s.A.canopyWorldY, s.C.canopyWorldY];
      const jump = prev ? Math.max(...y.map((v, i) => Math.abs(v - prev[i]))) : 0;
      prev = y;
      out.push(`${tel.songTimeSec.toFixed(1)}  B ${y[0].toFixed(2)} open ${s.B.open.toFixed(2)}  A ${y[1].toFixed(2)} open ${s.A.open.toFixed(2)}  C ${y[2].toFixed(2)} open ${s.C.open.toFixed(2)}  step ${jump.toFixed(3)}${held ? '  held' : ''}`);
    }
    return out;
  }, { from, to, h0, h1 });
  const big = rows.filter((r) => Number(r.split('step ')[1].split(' ')[0]) > 0.12);
  console.log(rows.filter((_, i) => i % 5 === 0).join('\n'));
  console.log('steps over 0.12 m per 0.1 s:', big.length ? '\n' + big.join('\n') : 'none');
} finally { await browser.close(); proc.kill(); }
