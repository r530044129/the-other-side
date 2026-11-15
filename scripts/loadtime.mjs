// Time from navigation to "ready" (model parsed, subdivided, shaders prewarmed): node scripts/loadtime.mjs [runs]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runs = Number(process.argv[2] ?? 2);
const port = 5400 + Math.floor(Math.random() * 300);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (let i = 0; i < runs; i++) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 120000 });
    console.log(`run ${i + 1}: ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`, errs.length ? errs : '');
    await page.close();
  }
} finally {
  await browser.close();
  proc.kill();
}
