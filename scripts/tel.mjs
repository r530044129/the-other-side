// Print camera and flower telemetry at given times: node scripts/tel.mjs 97 105:space
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5700 + Math.floor(Math.random() * 200);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  for (const spec of process.argv.slice(2)) {
    const [ts, flag] = spec.split(':');
    const tel = await page.evaluate(({ t, f }) => {
      const r = window.__tos.seek(t, { warmupFrames: 30, spaceHeld: f === 'space', triggerDrumStrike: !!(f && f.startsWith('strike')) });
      const am = f && f.match(/A([0-9.]+)$/);
      return am ? window.__tos.stepSeconds(Number(am[1]), {}) : r;
    }, { t: Number(ts), f: flag });
    const pick = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.some((q) => k.toLowerCase().includes(q))));
    const flat = {};
    const walk = (o, p = '') => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p + k + '.'); else flat[p + k] = v; } };
    walk(tel);
    console.log(ts, flag ?? '', JSON.stringify(pick(flat, (process.env.KEYS ?? 'cam').split(',')), (k, v) => typeof v === 'number' ? Number(v.toFixed(3)) : v));
  }
} finally { await browser.close(); proc.kill('SIGTERM'); }
