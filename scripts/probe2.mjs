// Shot ② probe: node scripts/probe2.mjs "<js expression using tel>" t1 t2 ...   prints telemetry excerpts per time
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [expr, ...times] = process.argv.slice(2);
const port = 5700 + Math.floor(Math.random() * 200);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  for (const ts of times) {
    const out = await page.evaluate(({ t, expr }) => {
      const tel = window.__tos.seek(t, { warmupFrames: 6 });
      return JSON.stringify(new Function('tel', 'return ' + expr)(tel));
    }, { t: Number(ts), expr });
    console.log(ts, out);
  }
} finally { await browser.close(); proc.kill(); }
