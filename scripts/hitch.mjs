// Real-time playback hitch probe: plays from START for DUR seconds with the real audio clock and
// reports every long frame (song time, frame gap) and the audio/visual clock difference.
// node scripts/hitch.mjs [start=0] [dur=20] [dpr=2]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const start = Number(process.argv[2] ?? 0), dur = Number(process.argv[3] ?? 20), dpr = Number(process.argv[4] ?? 2);
const port = 6000 + Math.floor(Math.random() * 90);
const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: dpr })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?clean=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 60000 });
  console.log('load to ready ms', Date.now() - t0);
  await page.evaluate((start) => {
    window.__gaps = []; window.__sync = [];
    let last = performance.now();
    const loop = (now) => {
      const gap = now - last; last = now;
      const tel = window.__tos.getTelemetrySnapshot();
      if (gap > 40) window.__gaps.push([Number(tel.songTimeSec.toFixed(2)), Math.round(gap)]);
      if (tel.audioTimeSec !== null && tel.audioTimeSec !== undefined) window.__sync.push([tel.songTimeSec, tel.audioTimeSec]);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, start);
  await page.keyboard.press('Space');
  if (start > 0) await page.evaluate((s) => window.__tos.playFrom(s), start);
  await page.waitForTimeout(dur * 1000);
  const res = await page.evaluate(() => {
    const s = window.__sync; let maxd = 0, at = 0;
    for (const [v, a] of s) { const d = v - a; if (Math.abs(d) > Math.abs(maxd)) { maxd = d; at = a; } }
    const tel = window.__tos.getTelemetrySnapshot();
    return { gaps: window.__gaps, frames: s.length, maxClockDiff: maxd, atAudio: at, endDiff: s.length ? s[s.length - 1][0] - s[s.length - 1][1] : null, fps: tel.fps, end: tel.songTimeSec };
  });
  console.log('long frames [songTime, ms]:', JSON.stringify(res.gaps));
  console.log('frames', res.frames, 'avg fps', (res.frames / dur).toFixed(1), 'end song time', res.end);
  console.log('visual minus audio clock: worst', res.maxClockDiff?.toFixed(3), 'at audio', res.atAudio?.toFixed(2), 'at end', res.endDiff?.toFixed(3));
  console.log('errors', errs);
} finally { await browser.close(); proc.kill(); }
