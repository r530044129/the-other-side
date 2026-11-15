// Quick contact-sheet capture: node scripts/frames.mjs <name> t1 t2 ...   (a time may carry flags: 37.5:space, 205:strike)
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const OUT = path.join(APP, 'shots', 'frames');
fs.mkdirSync(OUT, { recursive: true });
const [name, ...times] = process.argv.slice(2);
const port = 5400 + Math.floor(Math.random() * 300);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  await page.evaluate(() => document.getElementById('start-veil')?.classList.add('awakened'));
  if (process.env.FLAG) await page.evaluate((f) => { window[f] = true; }, process.env.FLAG);
  const files = [];
  for (const spec of times) {
    const [ts, flag] = spec.split(':');
    const t = Number(ts);
    await page.evaluate(({ t, flag }) => {
      const o = { warmupFrames: 40, pointerX: 0, pointerY: 0 };
      if (flag && flag.startsWith('space')) o.spaceHeld = true;
      if (flag && flag.startsWith('tap')) o.autoTap = true;
      if (flag && flag.startsWith('strike')) o.triggerDrumStrike = true;
      const wm = flag && flag.match(/w(\d+)$/); if (wm) o.warmupFrames = Number(wm[1]);
      return window.__tos.seek(t, o);
    }, { t, flag });
    await page.waitForTimeout(60);
    const f = path.join(OUT, `${name}_${ts}.jpg`);
    await page.screenshot({ path: f, type: 'jpeg', quality: 82 });
    files.push(f);
  }
  const py = `
from PIL import Image, ImageDraw
import sys
fs=${JSON.stringify(files)}
labels=${JSON.stringify(times)}
cols=3 if len(fs)>4 else 2
w,h=640,400
rows=(len(fs)+cols-1)//cols
sheet=Image.new('RGB',(cols*w,rows*h))
for i,f in enumerate(fs):
    im=Image.open(f).resize((w,h))
    d=ImageDraw.Draw(im); d.text((8,6),labels[i],fill=(255,255,0))
    sheet.paste(im,((i%cols)*w,(i//cols)*h))
sheet.save(${JSON.stringify(path.join(OUT, name + '_sheet.jpg'))},quality=85)
`;
  fs.writeFileSync(path.join(OUT, '_sheet.py'), py);
  execSync(`python3 ${JSON.stringify(path.join(OUT, '_sheet.py'))}`);
  console.log('sheet', path.join(OUT, name + '_sheet.jpg'));
  console.log('errors', errors.length, errors.slice(0, 6).join('\n'));
} finally {
  await browser.close();
  proc.kill();
}
