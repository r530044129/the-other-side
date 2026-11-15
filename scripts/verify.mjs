import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(APP_DIR, 'shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const args = process.argv.slice(2);
const milestoneArg = args.find((a) => a.startsWith('--milestone='))?.split('=')[1] ?? 'all';

function startViteServer(port = 5192) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: APP_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    const onData = (chunk) => {
      const txt = chunk.toString();
      if (!resolved && (txt.includes('Local:') || txt.includes(String(port)))) {
        resolved = true;
        resolve({ proc, url: `http://127.0.0.1:${port}` });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      if (!resolved) reject(err);
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ proc, url: `http://127.0.0.1:${port}` });
      }
    }, 3500);
  });
}

async function run() {
  const port = 5200 + Math.floor(Math.random() * 200);
  const { proc, url } = await startViteServer(port);
  const consoleErrors = [];
  const pageErrors = [];
  const telemetryLog = {};

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined,
      args: [
        '--use-angle=metal',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--enable-webgl2-compute-context',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });

    await page.goto(`${url}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__tos && window.__tos.ready), { timeout: 20000 });

    const capture = async (name, fn) => {
      const tel = await page.evaluate(fn);
      await page.waitForTimeout(40);
      const outPath = path.join(SHOTS_DIR, name);
      await page.screenshot({ path: outPath });
      telemetryLog[name] = tel;
      console.log(`Captured ${name} @ t=${tel?.songTimeSec ?? '?'}s`);
    };

    const runM1 = milestoneArg === '1' || milestoneArg === 'all';
    const runM2 = milestoneArg === '2' || milestoneArg === 'all';
    const runM3 = milestoneArg === '3' || milestoneArg === 'all';
    const runM4 = milestoneArg === '4' || milestoneArg === 'all';

    // =========================================================================
    // MILESTONE 1: Entrance UI + Shot 1 (0~9.8s) + Shot 2 (9.8~46.4s)
    // =========================================================================
    if (runM1) {
      // 1A. Entrance veil UI (t=0.0s, before click/Space — serene misty water theater without title collision!)
      await capture('m1_01_entrance_ui_0s.png', () => {
        document.body.classList.remove('clean-mode');
        window.__tos.toggleDebugPanel(false);
        window.__tos.setPointer(0, 0);
        return window.__tos.seek(0.0, { playing: false, warmupFrames: 1 });
      });

      // Switch to clean curatorial view (start veil awakened) for Shots 1..2
      await page.evaluate(() => {
        document.getElementById('start-veil')?.classList.add('awakened');
      });

      // 1B. Shot 1 sequence: 1.0s (oil-film RECKONER calm) -> 5.0s (Balatro polar swirl stretching/melting) -> 8.8s (nearly dissolved into dark waves)
      await capture('m1_02_shot1_title_calm_1s.png', () =>
        window.__tos.seek(1.0, { warmupFrames: 18, pointerX: 0, pointerY: 0 })
      );
      await capture('m1_03_shot1_balatro_melt_5s.png', () =>
        window.__tos.seek(5.0, { warmupFrames: 24, pointerX: 0, pointerY: 0 })
      );
      await capture('m1_04_shot1_dissolved_8_8s.png', () =>
        window.__tos.seek(8.8, { warmupFrames: 24, pointerX: 0, pointerY: 0 })
      );

      // 1C. Shot 2 sequential emergence: 11.4s (Hero B emerging first!) -> 14.3s (right after Beat 1 bar downbeat dip so the SINGLE musical ripple directly beneath B is crisply visible!)
      await capture('m1_05_shot2_B_emerges_first_11_1s.png', () =>
        window.__tos.seek(11.4, { warmupFrames: 24 })
      );
      await capture('m1_06_shot2_trio_idle_prompt_15s.png', () =>
        window.__tos.seek(14.35, { warmupFrames: 90 })
      );

      // 1D. Shot 2 Spacebar delayed-mirror breathing sequence + downward wind ripples:
      // Step 1: Hold Space for 0.65s -> B is noticeably exhaling open (~0.65), while A & C are just beginning (~0.05..0.12)!
      await capture('m1_07_shot2_space_hold_early_B_leads.png', () => {
        window.__tos.seek(20.0, { warmupFrames: 20, spaceHeld: false });
        return window.__tos.stepSeconds(0.65, { spaceHeld: true });
      });

      // Step 2: Continue holding Space another 0.90s -> B is at full lotus bloom (~1.0) & A/C have caught up into full bloom (~0.88..0.95) with ripples directly below!
      await capture('m1_08_shot2_space_hold_full_trio_bloom.png', () =>
        window.__tos.stepSeconds(0.95, { spaceHeld: true })
      );

      // Step 3: Release Space immediately (even mid-breath test: seek to partial open 0.55 then release 0.45s) -> B immediately closes ahead while A/C mirror with delay!
      await capture('m1_09_shot2_space_release_immediate_close.png', () =>
        window.__tos.stepSeconds(0.55, { spaceHeld: false })
      );
    }

    // =========================================================================
    // MILESTONE 2: Shot 3 (46.4~78.6s) + Shot 4 (78.6~143.8s)
    // =========================================================================
    if (runM2) {
      await page.evaluate(() => {
        document.getElementById('start-veil')?.classList.add('awakened');
        window.__tos.toggleDebugPanel(false);
        window.__tos.setPointer(0, 0);
      });

      await capture('m2_01_shot3_biolum_ink_early_52s.png', () =>
        window.__tos.seek(52.5, { warmupFrames: 36 })
      );
      await capture('m2_02_shot3_biolum_ink_rich_70s.png', () =>
        window.__tos.seek(70.5, { warmupFrames: 36 })
      );
      await capture('m2_03_shot4_breath_hold_82s.png', () =>
        window.__tos.seek(82.0, { warmupFrames: 36 })
      );
      await capture('m2_04_shot4_wallace_caustics_bass_94s.png', () =>
        window.__tos.seek(94.0, { warmupFrames: 40 })
      );
      await capture('m2_05_shot4_antigrav_motes_134s.png', () =>
        window.__tos.seek(134.0, { warmupFrames: 42, spaceHeld: true })
      );
    }

    // =========================================================================
    // MILESTONE 3: Shot 5 (143.8~197.8s) + Shot 6 (197.8~243.3s)
    // =========================================================================
    if (runM3) {
      await page.evaluate(() => {
        document.getElementById('start-veil')?.classList.add('awakened');
        window.__tos.toggleDebugPanel(false);
        window.__tos.setPointer(0, 0);
      });

      await capture('m3_01_shot5_carpet_liftoff_147s.png', () =>
        window.__tos.seek(147.2, { warmupFrames: 48 })
      );
      await capture('m3_02_shot5_flying_carpet_caustics_170s.png', () =>
        window.__tos.seek(170.0, { warmupFrames: 65 })
      );
      await capture('m3_03_shot5_flying_carpet_crest_188s.png', () =>
        window.__tos.seek(188.0, { warmupFrames: 65 })
      );
      await capture('m3_04_shot6_drummer_shadow_idle_205s.png', () =>
        window.__tos.seek(205.0, { warmupFrames: 60 })
      );
      await capture('m3_05_shot6_drummer_space_strike_impact.png', () => {
        window.__tos.seek(218.0, { warmupFrames: 55 });
        window.__tos.pressSpaceDown();
        return window.__tos.stepSeconds(0.068, {});
      });
      await capture('m3_06_shot6_drummer_strike_ripples_after.png', () => {
        window.__tos.pressSpaceUp();
        return window.__tos.stepSeconds(0.32, {});
      });
    }

    // =========================================================================
    // MILESTONE 4: Shot 7 (243.3~286.05s) + Extreme Mouse Bounds + [D] Debug HUD
    // =========================================================================
    if (runM4) {
      await page.evaluate(() => {
        document.getElementById('start-veil')?.classList.add('awakened');
        window.__tos.toggleDebugPanel(false);
        window.__tos.setPointer(0, 0);
      });

      await capture('m4_01_shot7_carpet_settling_247s.png', () =>
        window.__tos.seek(247.0, { warmupFrames: 55 })
      );
      await capture('m4_02_shot7_giant_shylight_bloom_260s.png', () =>
        window.__tos.seek(260.5, { warmupFrames: 110 })
      );
      await capture('m4_03_shot7_giant_shylight_breath_271s.png', () =>
        window.__tos.seek(266.2, { warmupFrames: 110 })
      );
      await capture('m4_04_shot7_coda_fade_283s.png', () =>
        window.__tos.seek(279.8, { warmupFrames: 90 })
      );

      // Extreme mouse-look boundary checks (no leaks!)
      await capture('m4_05_mouse_bound_top_left_shot2.png', () =>
        window.__tos.seek(24.0, { warmupFrames: 30, spaceHeld: true, pointerX: -1.0, pointerY: -1.0 })
      );
      await capture('m4_06_mouse_bound_bottom_right_shot5.png', () =>
        window.__tos.seek(174.0, { warmupFrames: 55, pointerX: 1.0, pointerY: 1.0 })
      );

      // [D] Debug Telemetry & Scrubber Panel check
      await capture('m4_07_debug_panel_telemetry.png', () => {
        window.__tos.setPointer(0, 0);
        window.__tos.toggleDebugPanel(true);
        const snap = window.__tos.seek(218.5, { warmupFrames: 45, triggerDrumStrike: true });
        window.__tos.toggleDebugPanel(true);
        return snap;
      });
    }

    const report = {
      timestamp: new Date().toISOString(),
      milestone: milestoneArg,
      consoleErrors,
      pageErrors,
      zeroErrors: consoleErrors.length === 0 && pageErrors.length === 0,
      telemetrySummary: telemetryLog,
    };
    fs.writeFileSync(path.join(SHOTS_DIR, 'verify_report.json'), JSON.stringify(report, null, 2));
    console.log('Zero Errors:', report.zeroErrors, '| Errors count:', consoleErrors.length + pageErrors.length);
    if (!report.zeroErrors) {
      console.error('Console/Page Errors:', consoleErrors, pageErrors);
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    proc.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
