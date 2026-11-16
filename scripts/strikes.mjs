// Play a stretch while pressing space like a player, record the camera every frame, and save frames.
// node scripts/strikes.mjs <name> <startSec> <seconds> <pressEverySec>
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP, 'shots', 'frames');
fs.mkdirSync(OUT, { recursive: true });
const [name = 'strikes', startS = '205', durS = '6', everyS = '0.6'] = process.argv.slice(2);
const port = 5600 + Math.floor(Math.random() * 300);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 90000 });
  await page.evaluate(() => document.getElementById('start-veil')?.classList.add('awakened'));
  // the mouse is put in a corner on purpose: a locked-off camera must ignore it
  await page.evaluate((t) => window.__tos.seek(t, { warmupFrames: 40, pointerX: 0.9, pointerY: -0.8 }), Number(startS));
  const dt = 1 / 30;
  const steps = Math.round(Number(durS) / dt);
  const every = Math.round(Number(everyS) / dt);
  const cams = [];
  const files = [];
  for (let i = 0; i < steps; i++) {
    const down = i % every === 0;
    const tel = await page.evaluate(
      ({ down, up, dt }) => {
        if (down) window.__tos.pressSpaceDown();
        if (up) window.__tos.pressSpaceUp();
        return window.__tos.stepSeconds(dt, { dtStep: dt });
      },
      { down, up: i % every === 2, dt }
    );
    cams.push({ t: tel.songTimeSec, p: tel.camera.camPos, l: tel.camera.lookAt });
    if (i % every === Math.round(0.45 / dt)) {
      const f = path.join(OUT, `${name}_${tel.songTimeSec.toFixed(2)}.jpg`);
      await page.screenshot({ path: f, type: 'jpeg', quality: 82 });
      files.push(f);
    }
  }
  let maxStep = 0, maxDev = 0;
  for (let i = 1; i < cams.length; i++) {
    const a = cams[i - 1], b = cams[i];
    const d = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]) + Math.hypot(b.l[0] - a.l[0], b.l[1] - a.l[1], b.l[2] - a.l[2]);
    maxStep = Math.max(maxStep, d);
    maxDev = Math.max(maxDev, Math.hypot(b.p[0] - cams[0].p[0], b.p[1] - cams[0].p[1], b.p[2] - cams[0].p[2]));
  }
  console.log(`frames ${cams.length}  camera first ${JSON.stringify(cams[0].p)} look ${JSON.stringify(cams[0].l)}`);
  console.log(`max frame-to-frame camera+target change ${maxStep.toFixed(5)} m, max drift from start ${maxDev.toFixed(5)} m`);
  const py = `
from PIL import Image, ImageDraw
fs=${JSON.stringify(files)}
w,h=640,400; cols=3; rows=(len(fs)+cols-1)//cols
sheet=Image.new('RGB',(cols*w,rows*h))
for i,f in enumerate(fs):
    im=Image.open(f).resize((w,h)); ImageDraw.Draw(im).text((8,6),f.split('_')[-1][:-4],fill=(255,255,0))
    sheet.paste(im,((i%cols)*w,(i//cols)*h))
sheet.save(${JSON.stringify(path.join(OUT, name + '_sheet.jpg'))},quality=85)
`;
  execSync(`python3 -I -c '${py.replace(/'/g, "'\\''")}'`);
  console.log('sheet', path.join(OUT, name + '_sheet.jpg'), 'errors', errs.length, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  proc.kill('SIGTERM');
}
