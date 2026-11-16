import { createBakedSplash } from './bakedSplash';
import { createSoundHint } from './soundHint';
import * as THREE from 'three';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import { CinemaCameraRig } from './cameraRig';
import {
  ChoreographySnapshot,
  MusicChoreographer,
  SHOT_WINDOWS,
  ShotNumber,
} from './choreographer';
import { createDrummerShadowSystem, DrummerShadowTelemetry } from './drummerShadow';
import { createGalleryScene } from './galleryScene';
import { createPostPipeline } from './postPipeline';
import { createShylightEnsemble } from './shylight';
import { createWaterPoolSystem } from './waterPool';
import { createOtherSide } from './otherSide';
import { createRoom } from './room';
import { sstep } from './story';
import { createNave } from './nave';
import { isMobile, quality } from './device';

declare global {
  interface Window {
    __tos?: {
      ready: boolean;
      seek: (
        sec: number,
        opts?: {
          playing?: boolean;
          spaceHeld?: boolean;
          triggerDrumStrike?: boolean;
          pointerX?: number;
          pointerY?: number;
          warmupFrames?: number;
          dtStep?: number;
          /** Shot ②: tap by itself on every beat during the warm-up (to look at the resonance). */
          autoTap?: boolean;
        }
      ) => Record<string, unknown>;
      stepSeconds: (
        durationSec: number,
        opts?: { spaceHeld?: boolean; dtStep?: number }
      ) => Record<string, unknown>;
      pressSpaceDown: () => void;
      pressSpaceUp: () => void;
      setPointer: (nx: number, ny: number) => void;
      toggleDebugPanel: (force?: boolean) => void;
      /** Real playback (audio clock) from a given time; for hitch and sync probes. */
      playFrom: (sec: number) => void;
      getTelemetrySnapshot: () => Record<string, unknown>;
    };
  }
}

// Per-shot exposure grade (keyed to the shot windows in choreographer.ts). Smooth, deterministic, music-timed.
const EXPOSURE_KEYS: [number, number][] = [
  [0.0, 1.55], [9.0, 1.55], [13.0, 1.62], [46.38, 1.62], [46.4, 1.30], [52.0, 1.22], [78.6, 1.20],
  [85.7, 1.12], [90.0, 1.22], [143.2, 1.26], [146.0, 1.50], [196.0, 1.50], [199.4, 1.18], [243.3, 1.40], [249.0, 0.92],
  [286.05, 0.92],
];
// Lens focus: a few keyed subjects, eased between; the distance is measured from the live camera.
const FOCUS_KEYS: [number, number, number, number, number][] = [
  // t, x, y, z, aperture
  [0.0, 0, 0.0, 0.0, 0.5],
  [7.2, 0, 0.0, 0.0, 0.5],
  // shot ②: focus rides on the hero flower B; the nave and its lamps fall soft
  [11.4, -1.2, 1.3, 1.5, 0.36],
  [46.38, -1.2, 1.3, 1.5, 0.36],
  [46.4, 0, 2.3, 0.3, 0.80],
  [68.8, 0, 2.3, 0.3, 0.80],
  // seen from straight above: flowers and water both held in focus
  [71.0, 0, 1.0, -0.32, 0.28],
  [77.0, 0, 1.0, -0.32, 0.28],
  [80.2, 0, 2.3, 0.3, 0.80],
  [90.0, 0, 2.6, 0.0, 0.22],
  [100.0, 0, 2.6, 0.0, 0.22],
  // the camera brushes past flower B: hold it sharp so the weave reads, the far flowers and the room go soft;
  // then rack to the ceiling as the lens tilts up
  [102.5, 0, 1.5, 0.85, 0.50],
  [107.2, 0, 1.5, 0.85, 0.50],
  [110.0, 0, 7.0, -7.0, 0.12],
  [129.0, 0, 7.0, -7.0, 0.12],
  [133.0, 0, 2.6, 0.0, 0.22],
  [143.0, 0, 1.2, 0.0, 0.22],
  [146.0, 0, 1.0, 0.0, 0.16],
  [197.5, 0, 1.0, 0.0, 0.16],
  // shot 6: focus on the middle of the water, so the swell in front is sharp and the stage only a little soft
  [199.4, 0, 1.5, 1.8, 0.16],
  [243.3, 0, 1.5, 1.8, 0.16],
  [254.5, 0, 2.06, 0.38, 0.85],
  [286.05, 0, 0.6, 0.38, 0.85],
];
const focusTmp = { x: 0, y: 0, z: 0, a: 0 };
const shaftTmp = new THREE.Vector3();
function sampleFocus(t: number): typeof focusTmp {
  const K = FOCUS_KEYS;
  let i = 1;
  while (i < K.length - 1 && t > K[i][0]) i++;
  const k0 = K[i - 1];
  const k1 = K[i];
  let u = Math.max(0, Math.min(1, (t - k0[0]) / Math.max(1e-6, k1[0] - k0[0])));
  u = u * u * (3 - 2 * u);
  focusTmp.x = k0[1] + (k1[1] - k0[1]) * u;
  focusTmp.y = k0[2] + (k1[2] - k0[2]) * u;
  focusTmp.z = k0[3] + (k1[3] - k0[3]) * u;
  focusTmp.a = k0[4] + (k1[4] - k0[4]) * u;
  return focusTmp;
}
function focusDistAt(t: number, camPos: THREE.Vector3): number {
  const f = sampleFocus(t);
  return Math.max(0.6, Math.hypot(camPos.x - f.x, camPos.y - f.y, camPos.z - f.z));
}
function apertureAt(t: number): number {
  return sampleFocus(t).a;
}

function exposureAt(t: number): number {
  if (t <= EXPOSURE_KEYS[0][0]) return EXPOSURE_KEYS[0][1];
  for (let i = 1; i < EXPOSURE_KEYS.length; i++) {
    const [t1, e1] = EXPOSURE_KEYS[i];
    if (t <= t1) {
      const [t0, e0] = EXPOSURE_KEYS[i - 1];
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return e0 + (e1 - e0) * (u * u * (3 - 2 * u));
    }
  }
  return EXPOSURE_KEYS[EXPOSURE_KEYS.length - 1][1];
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatMMSS(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rem.toFixed(2).padStart(5, '0')}`;
}

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('clean') === '1') {
    document.body.classList.add('clean-mode');
  }
  // Phones and tablets: lighter picture (see device.ts), touch instead of the space key, landscape only.
  if (isMobile) document.body.classList.add('is-mobile');
  const ENTER_LABEL = isMobile ? '轻触画面进入' : '点击画面 或 按下 SPACE 进入';
  const REENTER_LABEL = isMobile ? '轻触画面重新进入' : '点击画面 或 按下 SPACE 重新进入';

  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const startVeil = document.getElementById('start-veil')!;
  const subtlePromptEl = document.getElementById('subtle-prompt')!;
  // loading takes a while (the flower model is large): say so instead of inviting a click that does nothing
  const veilTextEl = startVeil.querySelector('.veil-text') as HTMLElement;
  const veilReadyLabel = ENTER_LABEL;
  veilTextEl.textContent = '正在载入 …';
  const debugPanelEl = document.getElementById('debug-panel')!;
  const spaceHintEl = document.getElementById('space-hint') as HTMLElement;
  const spaceHintLabelEl = spaceHintEl.querySelector('.mode-label') as HTMLElement;
  if (isMobile) {
    // no space key on a phone: the same cap reads 长按 屏幕 / 轻点 屏幕
    const keyEl = spaceHintEl.querySelector('.key') as HTMLElement;
    if (keyEl.firstChild) keyEl.firstChild.textContent = '屏幕';
  }
  const lyricEl = document.getElementById('lyric-line') as HTMLElement;
  const albumCardEl = document.getElementById('album-card') as HTMLElement;
  const timelineEl = document.getElementById('timeline') as HTMLElement;
  const timelineTimeEl = timelineEl.querySelector('.time') as HTMLElement;
  // Lyric lines are read from a file the owner fills in (start, end, text); nothing shows while it is empty.
  let lyricLines: { start: number; end: number; text: string }[] = [];
  let lyricShown = -1;
  fetch(import.meta.env.BASE_URL + 'lyrics/reckoner-lyrics.json')
    .then((r) => (r.ok ? r.json() : { lines: [] }))
    .then((j: { lines?: { start: number; end: number; text: string }[] }) => {
      lyricLines = (j.lines ?? []).filter((l) => l.text && l.text.trim().length > 0);
    })
    .catch(() => {});

  const dbgShotName = document.getElementById('dbg-shot-name')!;
  const dbgPlayBtn = document.getElementById('dbg-play-btn') as HTMLButtonElement;
  const dbgScrubber = document.getElementById('dbg-scrubber') as HTMLInputElement;
  const dbgTimecode = document.getElementById('dbg-timecode')!;
  const dbgLoopBtn = document.getElementById('dbg-loop-btn') as HTMLButtonElement;
  const dbgMuteBtn = document.getElementById('dbg-mute-btn') as HTMLButtonElement;
  const dbgSpeedSelect = document.getElementById('dbg-speed-select') as HTMLSelectElement;
  const dbgCopyBtn = document.getElementById('dbg-copy-btn') as HTMLButtonElement;
  const dbgMetrics = document.getElementById('dbg-metrics')!;
  const dbgLog = document.getElementById('dbg-log')!;

  const stemBars = {
    drums: document.getElementById('bar-drums')!,
    bass: document.getElementById('bar-bass')!,
    vocals: document.getElementById('bar-vocals')!,
    other: document.getElementById('bar-other')!,
  };
  const stemVals = {
    drums: document.getElementById('val-drums')!,
    bass: document.getElementById('val-bass')!,
    vocals: document.getElementById('val-vocals')!,
    other: document.getElementById('val-other')!,
  };
  const shotButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#dbg-shot-buttons [data-shot]')
  );

  // Internal resolution: never more than MAX_RENDER_W pixels across, whatever the screen. On a 4K or
  // Retina display the picture is drawn at about 2560 wide and scaled up; grain and the soft lens hide
  // the difference, and every full-screen pass costs half as much. (?maxw=3840 lifts the cap.)
  const MAX_RENDER_W = Number(params.get('maxw')) || quality.maxRenderW;
  const pickDpr = () => Math.min(window.devicePixelRatio || 1, 2, MAX_RENDER_W / Math.max(1, window.innerWidth));
  const dpr = pickDpr();
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: quality.canvasAntialias,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: quality.preserveDrawingBuffer,
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x010102, 1);
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010102);

  const cameraRig = new CinemaCameraRig(window.innerWidth / Math.max(1, window.innerHeight));
  const gallery = createGalleryScene();
  scene.add(gallery.root);

  const waterPool = createWaterPoolSystem(renderer, gallery.poolBounds);
  scene.add(waterPool.waterMesh);

  const shylights = createShylightEnsemble(renderer, gallery.poolBounds.waterY);
  scene.add(shylights.root);

  const otherSide = createOtherSide() as ReturnType<typeof createOtherSide> & { risePx: { value: number } };
  scene.add(otherSide.group);
  const room = createRoom();
  scene.add(room.group);
  const nave = createNave();
  scene.add(nave.group);
  const dkAxis: [number, number, number] = [nave.axis.x, nave.axis.y, nave.axis.z];

  const drummerShadow = createDrummerShadowSystem();
  const soundHint = createSoundHint();
  const splash = createBakedSplash();
  scene.add(splash.group);
  const postPipeline = createPostPipeline(window.innerWidth, window.innerHeight, dpr);
  const choreographer = new MusicChoreographer();

  await Promise.all([choreographer.loadCues(), shylights.ready, splash.ready]);
  dbgScrubber.max = choreographer.duration.toFixed(2);

  // Normalized mouse pointer (-1..+1) for silky bounded camera parallax
  let pointerX = 0;
  let pointerY = 0;
  let isDebugOpen = params.get('debug') === '1';
  if (isDebugOpen) debugPanelEl.classList.remove('hidden');

  let isScrubbing = false;
  let fpsSmooth = 60.0;
  let latestSnap: ChoreographySnapshot = choreographer.step(0.016);
  let latestDrummerTel: DrummerShadowTelemetry = {
    presence: 0,
    mode: 'idle-nod',
    nodDepth: 0,
    stickLiftR: 0.6,
    stickLiftL: 0.5,
    shadowImpactWaterUV: [0.64, 0.70],
  };

  const tmpSize = new THREE.Vector2();
  // ?prof=1: GPU time of each stage (timer queries) and CPU time, as running averages in window.__prof
  const PROF = params.get('prof') === '1';
  const profGl = renderer.getContext() as WebGL2RenderingContext;
  const tq = PROF ? profGl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const prof: Record<string, number> = {};
  const pending: { q: WebGLQuery; name: string }[] = [];
  let curQ: WebGLQuery | null = null;
  let curName = '';
  let cpuT = 0;
  const avg = (k: string, v: number) => (prof[k] = prof[k] === undefined ? v : prof[k] * 0.9 + v * 0.1);
  const mark = (next: string | null) => {
    if (!PROF) return;
    const now = performance.now();
    if (curName) avg('cpu:' + curName, now - cpuT);
    cpuT = now;
    if (tq) {
      if (curQ) {
        profGl.endQuery(tq.TIME_ELAPSED_EXT);
        pending.push({ q: curQ, name: curName });
        curQ = null;
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        const { q, name } = pending[i];
        if (profGl.getQueryParameter(q, profGl.QUERY_RESULT_AVAILABLE)) {
          if (!profGl.getParameter(tq.GPU_DISJOINT_EXT)) avg('gpu:' + name, profGl.getQueryParameter(q, profGl.QUERY_RESULT) / 1e6);
          profGl.deleteQuery(q);
          pending.splice(i, 1);
        }
      }
      if (next) {
        curQ = profGl.createQuery();
        profGl.beginQuery(tq.TIME_ELAPSED_EXT, curQ!);
      }
    }
    curName = next ?? '';
  };
  (window as any).__prof = prof;
  function renderOneFrame(dt: number, snapCameraImmediately = false): ChoreographySnapshot {
    mark('cpu-start');
    const snap = choreographer.step(dt);
    latestSnap = snap;
    const story = snap.story;
    const s2 = snap.shot2;
    // 2.39:1 picture inside whatever window we have
    // (the bars close in as the camera comes down from the title, so the oil lettering is not cropped)
    const bandFull = Math.min(1.0, cameraRig.camera.aspect / 2.39);
    let band = 1.0 + (bandFull - 1.0) * sstep(7.4, 11.2, snap.time);
    // a phone keeps its bars from the first frame (see letterboxMax in device.ts)
    band = Math.min(band, quality.letterboxMax);
    // weak top light of the nave, breathing very slowly with the strings
    const dkTop = 0.85 + 0.25 * s2.otherSlow;
    const fovPunch =
      (story.flipAge >= 0 ? 3.5 * Math.exp(-story.flipAge * 2.2) : 0) +
      (story.surfaceAge >= 0 ? 7.0 * Math.exp(-story.surfaceAge * 2.6) : 0);

    // Shot 6: the lens is locked off, half in the water (no riding the swell, no drift, no mouse look).
    // The water is held at the lens height around it instead (lensCalm below), so nothing a strike does to
    // the water can move the picture or wash over the lens.
    const rideY = 0;
    const lockedOff = snap.time > 198.3 && snap.time < 243.3;
    // 1. Update Camera FIRST so sightline-locked effects use exact current frame eye position!
    if (snapCameraImmediately) {
      cameraRig.snapTo({
        time: snap.time,
        shotId: snap.shotId,
        pointerX,
        pointerY,
        fxTime: story.fxTime,
        freeze: story.freeze,
        fovPunch,
        band,
        rideY,
        lockedOff,
      });
    } else {
      cameraRig.update(
        {
          time: snap.time,
          shotId: snap.shotId,
          pointerX,
          pointerY,
          fxTime: story.fxTime,
          freeze: story.freeze,
          fovPunch,
          band,
          rideY,
          lockedOff,
        },
        dt
      );
    }

    // 2. Update Pure Wire-Free Shylight Ensemble (B, A, C & Finale Giant)
    const shyState = {
      time: snap.time,
      causticBounce: snap.wallCausticIntensity,
      selfLit: s2.look,
      silhouette: snap.flowerSilhouette,
      unitA: snap.shylightA,
      unitB: snap.shylightB,
      unitC: snap.shylightC,
      unitGiant: snap.shylightGiant,
    };
    shylights.update(shyState, dt);
    // The reflection is rendered from its own poses when it stops obeying.
    const mirrorOverride = story.mirrorB.active || story.mirrorGiant.active || s2.mirrorB !== null;
    const mirrorB = s2.mirrorB
      ? s2.mirrorB
      : story.mirrorB.active
        ? { ...snap.shylightB, openAmount: story.mirrorB.open, glowIntensity: story.mirrorB.glow }
        : snap.shylightB;
    const mirrorGiant = story.mirrorGiant.active
      ? { ...snap.shylightGiant, openAmount: story.mirrorGiant.open, glowIntensity: story.mirrorGiant.glow, spinRad: story.mirrorGiant.spin }
      : snap.shylightGiant;
    const activeLights = shylights.getLightSources();

    mark('drummer');
    // 3. Update Hidden 3D Drummer & Render Offscreen Centered Shadow Silhouette Mask (Shot 6)
    latestDrummerTel = drummerShadow.updateAndRenderShadow(renderer, {
      presence: snap.drummerRigPresence,
      echo: story.drummerEcho,
      time: snap.time,
      beatSec: snap.beatSec,
      beatPosAt: (tt: number) => choreographer.beatPosAt(tt),
      timeSinceStrike: snap.timeSinceDrummerStrike,
      strikeHandIndex: snap.drummerStrikeCount,
      cameraWorldPos: cameraRig.camera.position,
    });
    choreographer.updateDrummerImpactUV(latestDrummerTel.shadowImpactWaterUV);

    // 4. Inject strictly rhythm/interaction-triggered world ripples (ZERO random ripples!)
    for (const r of snap.triggeredRipples) {
      waterPool.injectWorldRipple(r.worldX, r.worldZ, r.radiusMeters, r.strength, r.strikeCarpetUV, r.fx);
    }

    mark('sim');
    // 5. Step Boundless Water Pool PDE, Oil-Film Title Fluid, 3D Underwater Ink & Full-Width XPBD Water Carpet
    waterPool.stepSimulation(renderer, dt, {
      time: snap.time,
      shadowVoid: snap.shadowVoid,
      shot1Dark: snap.shot1Dark,
      ambientKeep: snap.ambientKeep,
      titlePresence: snap.titlePresence,
      balatroSwirlAmount: snap.balatroSwirlAmount,
      biolumInkVisibility: snap.biolumInkVisibility,
      biolumDrops: snap.biolumDrops,
      swirlGather: snap.swirlGather,
      bassStandingWave: snap.bassStandingWave,
      carpetLevitation: snap.carpetLevitation,
      carpetWaveActivity: snap.carpetWaveActivity,
      otherEnergy: snap.otherEnv,
      vocalEnergy: snap.vocalsEnv,
      bassEnergy: snap.bassEnv,
      drumEnergy: snap.drumsEnv,
      beatPhase: snap.beatPhase,
      shylightLights: activeLights,
      drummerShadowIntensity: snap.drummerPresence,
      drummerShadowTex: drummerShadow.shadowMaskTexture,
      drummerShadowMatrix: drummerShadow.shadowProjMatrix,
      endingBlackout: snap.endingBlackout,
      fxTime: story.fxTime,
      freeze: story.freeze,
      reflComplement: story.reflComplement,
      reflShiver: story.reflShiver,
      underView: story.underView,
      rainbow: story.rainbow,
      underLift: story.underSpan,
      underSpan: story.underSpan,
      // shot 6: the water reaches past the lens, so it has no near edge in the picture (grown while the lens
      // is still at the surface, coming up)
      // shot 6: the water reaches past the lens, so it meets the half-submerged lens with no edge of its own
      carpetReach: 5.5 * sstep(198.6, 200.4, snap.time),
      // the water around the locked-off lens stays at the lens height (the lens is at the rest height 1.48 m)
      lensCalm: [0, 5.6, sstep(198.4, 199.2, snap.time) * (1.0 - sstep(242.5, 243.4, snap.time))],
      // shot 6 only (the dive at 143 s keeps seeing the pool's top under its waterline, on purpose)
      splitLine:
        snap.time > 198.7 && snap.time < 243.3
          ? [story.submergeLine, band, cameraRig.camera.aspect, snap.time]
          : undefined,
      shadowPass: story.shadowPass,
      shadowSlide: story.shadowSlide,
      winPoster: story.winPoster,
      winSlide: story.winSlide,
      windowLight: story.windowLight,
      causticFractal: story.causticFractal,
      endTitle: story.endTitle,
      tealLeak: snap.tealLeak,
      strikeAge: snap.timeSinceDrummerStrike,
      strikeXZ: latestDrummerTel.strikeWorldPos
        ? [latestDrummerTel.strikeWorldPos[0], latestDrummerTel.strikeWorldPos[2]]
        : undefined,
      dk: s2.look,
      dkAxis,
      dkTop,
      pat: {
        cx: s2.patCentre[0],
        cz: s2.patCentre[1],
        amp: s2.patAmp,
        radius: s2.patRadius,
        resonance: s2.resonance,
        phase: s2.patPhase,
      },
      cue: s2.cue,
      vein: { grow: s2.veinGrow, level: s2.veinLevel },
      poolTop: snap.topDown,
    });

    // 6. Update Deep-Sea Misty Sky-Theater, Hanging Refracted Curtains, Pool Caustics & Rising Pearls
    gallery.update({
      time: story.fxTime,
      shadowVoid: snap.shadowVoid,
      shot1Dark: snap.shot1Dark,
      ambientKeep: snap.ambientKeep,
      shylightLights: activeLights,
      wallCausticIntensity: snap.wallCausticIntensity,
      // under the lifted sheet the floor light stays a calm glow, not a field of bright blots
      poolFloorCausticIntensity: snap.poolFloorCausticIntensity,
      causticWaveTex: waterPool.getWaveTexture(),
      drummerShadowIntensity: snap.drummerPresence,
      drummerShadowTex: drummerShadow.shadowMaskTexture,
      drummerShadowMatrix: drummerShadow.shadowProjMatrix,
      carpetLevitation: snap.carpetLevitation,
      timeSinceDrummerStrike: snap.timeSinceDrummerStrike,
      strikeWorldPos: latestDrummerTel.strikeWorldPos,
      antiGravityDropletsIntensity: snap.antiGravityDropletsIntensity,
      volumetricShaftIntensity: snap.volumetricShaftIntensity,
      endingBlackout: snap.endingBlackout,
      underAmt: story.underAmt,
      rainbow: story.rainbow,
      underSpan: story.underSpan,
      causticFractal: story.causticFractal,
      drummerEcho: story.drummerEcho,
      drummerReveal: story.drummerReveal,
      triShadow: story.triShadow,
      triSpread: story.triSpread,
      triGiant: story.triGiant,
      echoTextures: drummerShadow.echoTextures,
      dk: s2.look,
      dkAxis,
      dkTop,
    });

    otherSide.update(story, snap.time, snap.endingBlackout);
    {
      const t = snap.time;
      const live = 1.0 - story.freeze;
      let lampsLeft = 1.0;
      if (story.windDown > 0.0) {
        const stepF = Math.max(0, choreographer.beatPosAt(t) - choreographer.beatPosAt(78.6));
        const whole = Math.floor(stepF);
        const eased = whole + sstep(0.0, 0.35, stepF - whole);
        lampsLeft = Math.max(0.0, 1.0 - eased / 8.5);
      }
      let presence =
        (0.5 * sstep(0.4, 3.0, t) + 0.5 * sstep(9.0, 13.5, t)) * (1.0 - sstep(85.72, 88.2, t)) +
        0.62 * sstep(249.0, 256.0, t) * (1.0 - sstep(279.0, 283.5, t));
      presence = Math.min(1, presence);
      // seen from straight above the walls are only clutter: let them sink into the dark
      presence *= 1.0 - 0.96 * sstep(68.6, 70.6, t) * (1.0 - sstep(77.0, 79.6, t));
      // shot ② has its own set (nave.ts); the slab room steps aside for it
      // The room is gone before the nave starts to appear. (Cross-fading them made the nearest arch
      // punch a hard-edged hole in the room the moment it became visible.)
      presence *= 1.0 - sstep(8.4, 9.5, t) * (t < 46.4 ? 1 : 0);
      presence *= 1.0 - s2.look;
      const hueT = t * 0.21;
      const titleTint: [number, number, number] = [
        0.5 + 0.5 * Math.cos(hueT),
        0.5 + 0.5 * Math.cos(hueT + 2.09),
        0.5 + 0.5 * Math.cos(hueT + 4.19),
      ];
      const h = story.skyHue * 6.2832;
      const skyTint: [number, number, number] = [
        0.62 + 0.38 * Math.cos(h),
        0.42 + 0.30 * Math.cos(h + 2.4),
        0.46 + 0.38 * Math.cos(h + 4.0),
      ];
      const titleAmt = snap.titlePresence * (1.0 - sstep(9.0, 12.5, t)) * 0.45;
      const showAmt = Math.max(titleAmt, story.skyShow * (t < 200 ? 1 : 0));
      const tint = story.skyShow > titleAmt ? skyTint : titleTint;
      room.update({
        time: story.fxTime,
        presence,
        drums: snap.drumsEnv * live,
        bass: snap.bassEnv * live,
        vocals: snap.vocalsEnv * live,
        // wind-down before the bass: the hanging lamps go out a few at a time, one step on each beat
        other: snap.otherEnv * (0.35 + 0.65 * sstep(12.0, 30.0, t)) * lampsLeft,
        beat: choreographer.beatPosAt(t),
        beatKick: Math.exp(-snap.beatPhase * 0.5805 * 5.0) * live,
        ink: sstep(47.5, 60.0, t) * (1.0 - sstep(85.7, 88.5, t)),
        veins: sstep(47.0, 78.0, t) * (1.0 - sstep(85.7, 87.2, t)),
        showTint: tint,
        showAmt,
        ambientKeep: snap.ambientKeep,
        blackout: snap.endingBlackout,
        // shot ③: the walls stand back so that the flowers' own light is what lights the picture
        level: (0.32 + 0.68 * sstep(9.0, 14.0, t)) * (t >= 46.4 && t < 90 ? 0.42 : 1.0),
        // from shot ③ on only five of the nineteen lamps are left; the finale has none
        lampOthers: t < 46.4 ? 1 : 0,
        lampKeep: t < 200 ? 1 : 0,
        lights: activeLights.map((l) => ({ x: l.pos.x, y: l.pos.y, z: l.pos.z, glow: l.glow })),
      });
    }
    renderer.getDrawingBufferSize(tmpSize);
    otherSide.risePx.value = tmpSize.y / (2.0 * Math.tan((cameraRig.camera.fov * Math.PI) / 360.0));
    nave.update({
      time: snap.time,
      presence: s2.look,
      // lamps answer a drum hit with a surge (about 17 %), never a flash
      lampGain: (0.86 + 0.14 * s2.otherSlow) * (1.0 + 0.17 * s2.surge),
      vaultWash: (0.35 + 0.65 * s2.otherSlow) * (1.0 + 0.17 * s2.surge),
      dkTop,
      blackout: snap.endingBlackout,
      columnGrow: s2.columnGrow,
      pat: {
        cx: s2.patCentre[0],
        cz: s2.patCentre[1],
        amp: s2.patAmp,
        radius: s2.patRadius,
        resonance: s2.resonance,
        phase: s2.patPhase,
      },
      drops: s2.drops,
      lights: activeLights.map((l) => ({ x: l.pos.x, y: l.pos.y, z: l.pos.z, glow: l.glow })),
      pxPerUnit: otherSide.risePx.value,
      wallShadows: s2.wallShadows,
      sweep: s2.sweep,
    });

    // Baked crown splash on each drum strike (shot 6). It is hidden while the water draws its
    // refraction image, which the splash itself then reads to show the stage through the water.
    // (the strike point follows the stick's shadow on the water and can land right under the lens; the
    //  splash is kept at least 3 m out so it reads as a crown, not a wall of water on the glass)
    let splashPos = latestDrummerTel.strikeWorldPos;
    if (splashPos) {
      const cam = cameraRig.camera.position;
      const minAhead = 3.0;
      if (cam.z - splashPos[2] < minAhead) splashPos = [splashPos[0], splashPos[1], cam.z - minAhead];
    }
    splash.update({
      strikeAge: snap.timeSinceDrummerStrike,
      strikePos: splashPos,
      // (with the lens half in the water the splash rises from the waterline drawn on the lens, never below it)
      waterY: splashPos
        ? Math.max(
            waterPool.carpet.heightAtWorld(splashPos[0], splashPos[2]),
            story.submergeLine > -0.2 && story.submergeLine < 1.2 ? cameraRig.camera.position.y - 0.05 : -99
          )
        : waterPool.carpet.meanWaveHeight,
      presence: snap.drummerPresence * (snap.carpetLevitation > 0.5 ? 1 : 0),
      refraction: waterPool.getRefractionTexture(),
      blackout: snap.endingBlackout,
    });
    mark('refl+refr');
    const splashShown = splash.group.visible;
    splash.group.visible = false;
    // 7. Render Planar Water Mirror Reflection & Airborne Carpet Background Caustic Refraction
    waterPool.renderPlanarAndRefraction(
      renderer,
      scene,
      cameraRig.camera,
      snap.carpetLevitation,
      mirrorOverride
        ? {
            beforeMirror: () => shylights.update({ ...shyState, unitB: mirrorB, unitGiant: mirrorGiant }, 0),
            afterMirror: () => shylights.update(shyState, 0),
          }
        : undefined
    );

    mark('scene');
    splash.group.visible = splashShown;
    // 8. Render HDR Main Scene + ACES Filmic / Analog Video Feedback Composite
    // only the 2.39:1 picture is drawn; the black bars cost nothing
    postPipeline.setBand(band);
    renderer.setRenderTarget(postPipeline.sceneRT);
    renderer.clear();
    waterPool.waterMesh.visible = !(window as any).__noWater;
    shylights.root.visible = !(window as any).__noFlowers;
    gallery.root.visible = !(window as any).__noGallery;
    if ((window as any).__noNave) nave.group.visible = false;
    renderer.render(scene, cameraRig.camera);
    mark('post');

    const shaftScreen: [number, number, number][] = [];
    {
      // shot ②: the nave's own fog and halos carry the air; the screen-space shafts stay only as a trace
      // (screen-space light shafts are off everywhere now: they were noisy)
      const dry = 0.0 * (1.0 - story.underAmt) * (1.0 - story.worldFold) * (1.0 - 0.8 * s2.look);
      for (const l of shylights.getLightSources()) {
        shaftTmp.set(l.pos.x, l.pos.y, l.pos.z).project(cameraRig.camera);
        const inFront = shaftTmp.z < 1 ? 1 : 0;
        shaftScreen.push([shaftTmp.x * 0.5 + 0.5, shaftTmp.y * 0.5 + 0.5, Math.min(1.6, l.glow) * dry * inFront]);
      }
    }
    // the travelling lamp of shot ②: where it is on screen, for the shadows it throws through the fog
    let sweepShaft: [number, number, number] | undefined;
    if (s2.sweep.level > 0.003 && s2.look > 0.01) {
      shaftTmp.copy(nave.sweepWorld).project(cameraRig.camera);
      if (shaftTmp.z < 1) sweepShaft = [shaftTmp.x * 0.5 + 0.5, shaftTmp.y * 0.5 + 0.5, s2.sweep.level * s2.look];
    }
    postPipeline.renderFinal(renderer, {
      sweepShaft,
      feedbackStrength: snap.feedbackStrength,
      breathStrength: snap.breathStrength,
      breathPhase: snap.time * 1.25,
      time: snap.time,
      exposure: 0.96 * exposureAt(snap.time),
      submergeLine: story.submergeLine,
      lensDrops: story.lensDrops,
      flash: story.flash,
      flashTint: story.flashTint,
      chroma: story.chroma,
      focusDist: focusDistAt(snap.time, cameraRig.camera.position),
      aperture: (window as any).__noDof ? 0 : apertureAt(snap.time),
      camNear: cameraRig.camera.near,
      camFar: cameraRig.camera.far,
      worldFold: story.worldFold,
      foldN: story.foldN,
      foldSpin: story.foldSpin,
      rush: story.rush,
      aspect: cameraRig.camera.aspect,
      shafts: shaftScreen,
      band,
      edgeSoft: s2.look * 0.4,
      underGrade: story.underAmt,
    });
    mark(null);

    // Ask for sound: a few seconds after the music starts, and for as long as the page can see a problem
    soundHint.update(snap.hasStarted && snap.playing, choreographer.soundIssue(), performance.now());

    // 9. Sync Whisper-Quiet Entrance / Prompt UI & [D] Debug Telemetry HUD
    if (snap.hasStarted && snap.time < snap.duration - 0.15) {
      startVeil.classList.add('awakened');
    } else if (snap.time >= snap.duration - 0.15 && !snap.playing) {
      startVeil.querySelector('.veil-text')!.textContent = REENTER_LABEL;
      startVeil.classList.remove('awakened');
    }

    // Space-key hint and lyric line both live in the lower black bar (or just inside the picture when
    // the window is so wide that there is no bar).
    {
      const barPx = (1.0 - band) * 0.5 * window.innerHeight;
      // Everything sits inside the 2.39:1 picture (never straddling the edge of a black bar):
      // the key just above the picture's lower edge, the lyric line above the key, the card in the top left corner.
      const hintBottom = barPx + 26;
      // record card sits in the upper bar; full for the first quarter minute, then it steps back
      albumCardEl.style.setProperty('--card-top', `${(barPx + 20).toFixed(0)}px`);
      albumCardEl.style.setProperty('--card-o', !snap.hasStarted || snap.time < 15 || snap.time > snap.duration - 6 ? '1' : '0.34');
      timelineEl.style.setProperty('--progress', `${((snap.time / snap.duration) * 100).toFixed(2)}%`);
      timelineTimeEl.textContent = `${formatClock(snap.time)} / ${formatClock(snap.duration)}`;
      spaceHintEl.classList.toggle('down', snap.spaceHint.down);
      const h = snap.spaceHint;
      spaceHintEl.dataset.mode = h.mode;
      if (spaceHintLabelEl.textContent !== h.label && h.label) spaceHintLabelEl.textContent = h.label;
      spaceHintEl.style.setProperty('--hint-bottom', `${hintBottom.toFixed(0)}px`);
      spaceHintEl.style.setProperty('--show', h.show.toFixed(3));
      // The key sits still: no beat glow and no closing frame (they pulled the eye away from the picture).
      spaceHintEl.style.setProperty('--pulse', '0');
      if (false && h.toBeat > 0 && h.toBeat < 1.05) {
        // a frame closes on the key and meets it on the beat, like the ring on the water
        const k = h.toBeat / 1.05;
        spaceHintEl.style.setProperty('--approach-sx', (1 + 0.5 * k).toFixed(3));
        spaceHintEl.style.setProperty('--approach-sy', (1 + 1.7 * k).toFixed(3));
        spaceHintEl.style.setProperty('--approach-o', ((1 - k) * 0.9).toFixed(3));
      } else {
        spaceHintEl.style.setProperty('--approach-o', '0');
      }

      lyricEl.style.setProperty('--lyric-bottom', `${(hintBottom + 30 + 26).toFixed(0)}px`);
      let idx = -1;
      for (let i = 0; i < lyricLines.length; i++) {
        if (snap.time >= lyricLines[i].start && snap.time < lyricLines[i].end) {
          idx = i;
          break;
        }
      }
      if (!snap.hasStarted) idx = -1;
      if (idx !== lyricShown) {
        lyricShown = idx;
        if (idx >= 0) lyricEl.textContent = lyricLines[idx].text;
        lyricEl.classList.toggle('visible', idx >= 0);
      }
    }

    if (snap.subtlePromptText) {
      subtlePromptEl.textContent = snap.subtlePromptText;
      subtlePromptEl.classList.add('visible');
    } else {
      subtlePromptEl.classList.remove('visible');
    }

    if (isDebugOpen) {
      updateDebugHud(snap);
    }

    return snap;
  }

  function buildTelemetryObject(): Record<string, unknown> {
    const snap = latestSnap;
    const shyTel = shylights.getTelemetry();
    const camTel = cameraRig.getTelemetry();
    return {
      songTimeSec: Number(snap.time.toFixed(3)),
      audioTimeSec: choreographer.audioClock(),
      timecode: formatMMSS(snap.time),
      barBeat: `${snap.barIndex}:${snap.beatInBar}.${Math.floor(snap.beatPhase * 10)}`,
      shotId: snap.shotId,
      shotLabel: snap.shotLabel,
      playing: snap.playing,
      speed: snap.playbackRate,
      fps: Number(fpsSmooth.toFixed(1)),
      renderPixels: [postPipeline.sceneRT.width, postPipeline.sceneRT.height],
      spaceHeld: snap.isSpaceHeld,
      stems: {
        drums: snap.drumsEnv,
        bass: snap.bassEnv,
        vocals: snap.vocalsEnv,
        other: snap.otherEnv,
      },
      shylight: {
        B: shyTel.B,
        A: shyTel.A,
        C: shyTel.C,
        Giant: shyTel.Giant,
        windForceB: snap.windForceB,
        windForceAC: snap.windForceAC,
      },
      waterAndCloth: {
        titlePresence: snap.titlePresence,
        balatroSwirl: snap.balatroSwirlAmount,
        biolumInkVis: snap.biolumInkVisibility,
        liveInkDrops: waterPool.inkField.liveDropCount,
        swirlGather: snap.swirlGather,
        bassStandingWave: snap.bassStandingWave,
        carpetLevitation: snap.carpetLevitation,
        carpetMeanHeightM: waterPool.carpet.meanWaveHeight,
        carpetMaxWaveAmpM: waterPool.carpet.maxWaveAmplitude,
      },
      shot2: {
        look: Number(snap.shot2.look.toFixed(3)),
        resonance: Number(snap.shot2.resonance.toFixed(3)),
        patAmp: Number(snap.shot2.patAmp.toFixed(3)),
        surge: Number(snap.shot2.surge.toFixed(3)),
        drops: snap.shot2.drops.length,
      },
      lighting: {
        shadowVoid: snap.shadowVoid,
        shot1Dark: snap.shot1Dark,
      ambientKeep: snap.ambientKeep,
        wallCaustics: snap.wallCausticIntensity,
        floorCaustics: snap.poolFloorCausticIntensity,
        volumetricShafts: snap.volumetricShaftIntensity,
        risingMotes: snap.antiGravityDropletsIntensity,
        feedback: snap.feedbackStrength,
        blackout: snap.endingBlackout,
      },
      drummer: latestDrummerTel,
      camera: camTel,
      recentLogs: choreographer.getLogs().slice(-12),
    };
  }

  function updateDebugHud(snap: ChoreographySnapshot) {
    dbgShotName.textContent = snap.shotLabel;
    dbgPlayBtn.textContent = snap.playing ? '❚❚ Pause' : '▶ Play';
    if (!isScrubbing) {
      dbgScrubber.value = snap.time.toFixed(2);
    }
    dbgTimecode.textContent = `${formatMMSS(snap.time)} / ${formatMMSS(snap.duration)}`;

    shotButtons.forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.shot) === snap.shotId);
    });

    const loopId = choreographer.getLoopShot();
    dbgLoopBtn.textContent = loopId ? `Loop Shot: #${loopId}` : 'Loop Shot: OFF';
    dbgLoopBtn.classList.toggle('active', loopId !== null);

    stemBars.drums.style.width = `${Math.round(snap.drumsEnv * 100)}%`;
    stemBars.bass.style.width = `${Math.round(snap.bassEnv * 100)}%`;
    stemBars.vocals.style.width = `${Math.round(snap.vocalsEnv * 100)}%`;
    stemBars.other.style.width = `${Math.round(snap.otherEnv * 100)}%`;
    stemVals.drums.textContent = snap.drumsEnv.toFixed(2);
    stemVals.bass.textContent = snap.bassEnv.toFixed(2);
    stemVals.vocals.textContent = snap.vocalsEnv.toFixed(2);
    stemVals.other.textContent = snap.otherEnv.toFixed(2);

    const shy = shylights.getTelemetry();
    const cam = cameraRig.getTelemetry();
    dbgMetrics.textContent = [
      `TIME ${formatMMSS(snap.time)} (${snap.time.toFixed(2)}s) | BAR ${String(snap.barIndex).padStart(3, '0')}:${snap.beatInBar}.${Math.floor(snap.beatPhase * 10)} | FPS ${fpsSmooth.toFixed(0)} | SPACE ${snap.isSpaceHeld ? 'HELD' : 'UP'}`,
      `CAM  pos=(${cam.camPos.join(', ')}) yaw=${cam.mouseYawDeg}° pitch=${cam.mousePitchDeg}° fov=${cam.fov}°`,
      `SHY  B[open=${shy.B.open.toFixed(2)} h=${shy.B.distToWaterMeters.toFixed(2)}m wind=${snap.windForceB.toFixed(2)}] A[${shy.A.open.toFixed(2)}] C[${shy.C.open.toFixed(2)}] Giant[${shy.Giant.open.toFixed(2)}]`,
      `RES  look=${snap.shot2.look.toFixed(2)} resonance=${snap.shot2.resonance.toFixed(2)} pat=${snap.shot2.patAmp.toFixed(2)} surge=${snap.shot2.surge.toFixed(2)} drops=${snap.shot2.drops.length}`,
      `H2O  title=${snap.titlePresence.toFixed(2)} swirl=${snap.balatroSwirlAmount.toFixed(2)} ink=${snap.biolumInkVisibility.toFixed(2)}(${waterPool.inkField.liveDropCount}d) stand=${snap.bassStandingWave.toFixed(2)}`,
      `CLTH lev=${snap.carpetLevitation.toFixed(2)} meanY=${waterPool.carpet.meanWaveHeight.toFixed(2)}m amp=${waterPool.carpet.maxWaveAmplitude.toFixed(2)}m floorCaust=${snap.poolFloorCausticIntensity.toFixed(2)}`,
      `LGT  void=${snap.shadowVoid.toFixed(2)} wallCaust=${snap.wallCausticIntensity.toFixed(2)} godRay=${snap.volumetricShaftIntensity.toFixed(2)} motes=${snap.antiGravityDropletsIntensity.toFixed(2)}`,
      `DRUM pres=${latestDrummerTel.presence.toFixed(2)} mode=${latestDrummerTel.mode} nod=${latestDrummerTel.nodDepth.toFixed(2)} hitUV=(${latestDrummerTel.shadowImpactWaterUV.join(',')}) strikes=${snap.drummerStrikeCount}`,
    ].join('\n');

    const logs = choreographer.getLogs().slice(-6);
    dbgLog.innerHTML = logs
      .map(
        (l) =>
          `<div>[${l.songTimeSec.toFixed(2)}s | B${l.barBeat} | S${l.shotId}] <b>${l.tag}</b> ${l.detail}</div>`
      )
      .join('');
  }

  // =========================================================================
  // USER INPUT HANDLERS (Entrance Click, Spacebar, Silky Mouse Look, [D] Debug)
  // =========================================================================
  startVeil.addEventListener('click', () => {
    choreographer.startExperience();
  });

  // Drag anywhere outside the timeline / debug panel / start veil to look around a little.
  // The view stays where the player leaves it; the heavy spring in cameraRig gives the weight.
  {
    let dragId: number | null = null;
    let lastX = 0;
    let lastY = 0;
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    canvas.style.touchAction = 'none';
    // Touch: a finger that stays within this many pixels is a press; beyond it, a drag.
    const TOUCH_SLOP_PX = 14;
    let fingers = 0;
    let touchSpace = false;
    let touchLooking = false;
    let downX = 0;
    let downY = 0;
    const releaseTouchSpace = () => {
      if (!touchSpace) return;
      touchSpace = false;
      choreographer.onSpaceUp();
    };
    // no long-press menu, no pinch zoom of the page
    if (isMobile) {
      window.addEventListener('contextmenu', (e) => e.preventDefault());
      document.addEventListener('gesturestart', (e) => e.preventDefault());
    }
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('#timeline, #debug-panel, #start-veil, #rotate-hint, button, input')) return;
      if (e.pointerType === 'touch') {
        fingers++;
        if (fingers > 1) {
          // a second finger means "I am moving the view", never a press
          releaseTouchSpace();
          touchLooking = true;
          return;
        }
        // One finger down is the space key going down, at once, so a tap lands on the beat and a hold
        // is a hold. If the finger then travels, it turns into a look-around and the key is let go.
        touchSpace = true;
        touchLooking = false;
        downX = e.clientX;
        downY = e.clientY;
        choreographer.onSpaceDown();
      }
      dragId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      document.body.classList.add('look-drag');
    });
    window.addEventListener('pointermove', (e) => {
      if (dragId !== e.pointerId) return;
      if (e.pointerType === 'touch' && !touchLooking) {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) < TOUCH_SLOP_PX) return;
        touchLooking = true;
        releaseTouchSpace();
        lastX = e.clientX;
        lastY = e.clientY;
        return;
      }
      // dragging right/down turns the view like UE5 mouse-look (drag right = look right, drag up = look up): full range takes ~a quarter screen
      const k = 2.0 / Math.max(200, window.innerWidth * 0.25);
      pointerX = clamp1(pointerX + (e.clientX - lastX) * k);
      pointerY = clamp1(pointerY + (e.clientY - lastY) * k);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endDrag = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        fingers = Math.max(0, fingers - 1);
        if (dragId === e.pointerId) releaseTouchSpace();
      }
      if (dragId !== e.pointerId) return;
      dragId = null;
      document.body.classList.remove('look-drag');
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) {
        // (No sound on taps: the synthesised drop pulled people out of the song. The reward is in the water.)
        choreographer.onSpaceDown();
      }
    } else if (e.key === 'd' || e.key === 'D') {
      isDebugOpen = !isDebugOpen;
      debugPanelEl.classList.toggle('hidden', !isDebugOpen);
      if (isDebugOpen) updateDebugHud(latestSnap);
    }
  });

  // Jump in the song: timeline click, or the arrow keys (ten seconds a press).
  function jumpTo(sec: number) {
    const target = Math.max(0, Math.min(choreographer.duration - 0.5, sec));
    waterPool.resetSimulation(renderer, target);
    postPipeline.resetFeedback(renderer);
    // a jump keeps a pause the player asked for
    choreographer.seek(target, { playing: !userPaused });
  }
  let userPaused = false;
  const setUserPaused = (p: boolean) => {
    userPaused = p;
    timelineEl.classList.toggle('paused', p);
    if (p) choreographer.pause();
    else choreographer.startExperience();
  };
  if (isMobile) {
    // Landscape only for now: turning the phone upright pauses the song under the "rotate" card,
    // and turning it back carries on (unless the player had paused it themself).
    const portrait = window.matchMedia('(orientation: portrait)');
    let pausedByRotation = false;
    portrait.addEventListener('change', () => {
      if (portrait.matches) {
        if (latestSnap.playing && !userPaused) {
          pausedByRotation = true;
          setUserPaused(true);
        }
      } else if (pausedByRotation) {
        pausedByRotation = false;
        setUserPaused(false);
      }
    });
  }
  {
    const ticks = timelineEl.querySelector('.ticks') as HTMLElement;
    for (const w of SHOT_WINDOWS.slice(1)) {
      const i = document.createElement('i');
      i.style.left = `${((w.start / choreographer.duration) * 100).toFixed(2)}%`;
      ticks.appendChild(i);
    }
    const trackEl = timelineEl.querySelector('.track') as HTMLElement;
    const ppEl = timelineEl.querySelector('.pp') as HTMLElement;
    ppEl.addEventListener('click', (e) => {
      e.stopPropagation();
      ppEl.blur();
      if (!latestSnap.hasStarted) choreographer.startExperience();
      else setUserPaused(!userPaused);
    });
    timelineEl.addEventListener('click', (e) => {
      const r = trackEl.getBoundingClientRect();
      if (e.clientX < r.left - 2) return;
      jumpTo(((e.clientX - r.left) / Math.max(1, r.width)) * choreographer.duration);
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      e.preventDefault();
      jumpTo(latestSnap.time + (e.code === 'ArrowRight' ? 10 : -10));
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      choreographer.onSpaceUp();
    }
  });

  window.addEventListener('blur', () => {
    choreographer.onSpaceUp();
  });

  // Debug Panel Controls
  dbgPlayBtn.addEventListener('click', () => {
    choreographer.toggleDebugPlayPause();
  });

  dbgScrubber.addEventListener('pointerdown', () => {
    isScrubbing = true;
  });
  window.addEventListener('pointerup', () => {
    isScrubbing = false;
  });
  dbgScrubber.addEventListener('input', () => {
    const targetSec = parseFloat(dbgScrubber.value);
    waterPool.resetSimulation(renderer, targetSec);
    postPipeline.resetFeedback(renderer);
    choreographer.seek(targetSec);
    for (let i = 0; i < 12; i++) {
      renderOneFrame(0.016, i === 0);
    }
  });

  shotButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.shot) as ShotNumber;
      const win = SHOT_WINDOWS.find((w) => w.id === id);
      if (!win) return;
      if (choreographer.getLoopShot() !== null) {
        choreographer.setLoopShot(id);
      }
      const jumpSec = win.start + (id === 1 ? 0.0 : 0.25);
      waterPool.resetSimulation(renderer, jumpSec);
      postPipeline.resetFeedback(renderer);
      choreographer.seek(jumpSec, { playing: true });
    });
  });

  dbgLoopBtn.addEventListener('click', () => {
    const cur = choreographer.getLoopShot();
    choreographer.setLoopShot(cur === null ? latestSnap.shotId : null);
    updateDebugHud(latestSnap);
  });

  dbgMuteBtn.addEventListener('click', () => {
    const nextMute = !choreographer.muted;
    choreographer.setMuted(nextMute);
    dbgMuteBtn.textContent = nextMute ? '🔇 Muted' : '🔊 Audio';
  });

  dbgSpeedSelect.addEventListener('change', () => {
    choreographer.setPlaybackRate(parseFloat(dbgSpeedSelect.value));
  });

  dbgCopyBtn.addEventListener('click', () => {
    const json = JSON.stringify(buildTelemetryObject(), null, 2);
    console.info('[TOS_DEBUG_SNAPSHOT]', json);
    navigator.clipboard?.writeText(json).catch(() => {});
    dbgCopyBtn.textContent = 'Copied!';
    setTimeout(() => {
      dbgCopyBtn.textContent = 'Copy Snapshot JSON';
    }, 1200);
  });

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // keep whatever the frame-rate guard has settled on (turning a phone must not undo it)
    const newDpr = pickDpr() * renderScale;
    renderer.setPixelRatio(newDpr);
    renderer.setSize(w, h);
    cameraRig.resize(w / Math.max(1, h));
    waterPool.resize(w, h);
    postPipeline.resize(w, h, newDpr);
  });

  // =========================================================================
  // AUTOMATED DETERMINISTIC VERIFICATION HOOK (`window.__tos`)
  // =========================================================================
  window.__tos = {
    ready: true,
    seek(sec, opts) {
      if (opts?.pointerX !== undefined) pointerX = opts.pointerX;
      if (opts?.pointerY !== undefined) pointerY = opts.pointerY;
      // For Shot 1 Navier-Stokes oil fluid (`sec > 2.0 && sec < 11.0`), simulate continuously from `0.0s`
      // at `dt = 1/30` so the real Allen-Cahn oil letters swirl & ribbon authentically up to `sec`!
      const isShot1FluidMelt = sec > 2.0 && sec < 10.8;
      const dtStep = opts?.dtStep ?? (isShot1FluidMelt ? 1 / 30 : 1 / 60);
      const warmup = isShot1FluidMelt ? Math.round(sec / dtStep) : opts?.warmupFrames ?? 36;
      const startSec = isShot1FluidMelt ? 0.0 : Math.max(0, sec - warmup * dtStep);

      choreographer.setSyntheticClockMode(true);
      choreographer.setAutoTap(Boolean(opts?.autoTap));
      waterPool.resetSimulation(renderer, startSec);
      postPipeline.resetFeedback(renderer);
      if (sec <= 0.001 && !(opts?.playing ?? false)) {
        choreographer.seek(0.0, { playing: false, spaceHeld: false });
        renderOneFrame(dtStep, true);
        return buildTelemetryObject();
      }
      choreographer.seek(startSec, {
        playing: false,
        spaceHeld: opts?.spaceHeld ?? false,
      });
      choreographer.play();

      for (let i = 0; i < warmup; i++) {
        if (opts?.triggerDrumStrike && i === warmup - 4) {
          choreographer.onSpaceDown();
        } else if (opts?.triggerDrumStrike && i === warmup - 2) {
          choreographer.onSpaceUp();
        }
        renderOneFrame(dtStep, i === 0);
      }
      if (!(opts?.playing ?? false)) {
        choreographer.pause();
        if (isDebugOpen) updateDebugHud(latestSnap);
      }
      return buildTelemetryObject();
    },
    stepSeconds(durationSec, opts) {
      const dtStep = opts?.dtStep ?? 1 / 60;
      const steps = Math.max(1, Math.round(durationSec / dtStep));
      choreographer.setSyntheticClockMode(true);
      if (opts?.spaceHeld !== undefined) {
        if (opts.spaceHeld) choreographer.onSpaceDown();
        else choreographer.onSpaceUp();
      }
      choreographer.play();
      for (let i = 0; i < steps; i++) {
        renderOneFrame(dtStep, false);
      }
      choreographer.pause();
      return buildTelemetryObject();
    },
    pressSpaceDown() {
      choreographer.onSpaceDown();
    },
    pressSpaceUp() {
      choreographer.onSpaceUp();
    },
    setPointer(nx, ny) {
      pointerX = nx;
      pointerY = ny;
    },
    playFrom(sec) {
      choreographer.setSyntheticClockMode(false);
      choreographer.setAutoTap(false);
      waterPool.resetSimulation(renderer, sec);
      postPipeline.resetFeedback(renderer);
      choreographer.seek(sec, { playing: true });
    },
    toggleDebugPanel(force) {
      isDebugOpen = force !== undefined ? force : !isDebugOpen;
      debugPanelEl.classList.toggle('hidden', !isDebugOpen);
      if (isDebugOpen) updateDebugHud(latestSnap);
    },
    getTelemetrySnapshot() {
      return buildTelemetryObject();
    },
  };

  // Warm-up: visit every part of the piece once before anything is shown, so that shaders are compiled
  // and the flowers' morph data is on the GPU. Without this each flower froze the picture for a third of
  // a second the first time it appeared (10.6–11.6 s), and every new element later did the same.
  {
    for (const tt of [11.0, 12.6, 13.4, 13.9, 14.6, 15.8, 16.4, 30.0, 47.0, 52.0, 62.0, 73.0, 86.5, 95.0, 110.0, 144.6, 150.0, 170.0, 199.0, 205.0, 232.0, 250.0, 262.0, 281.0]) {
      waterPool.resetSimulation(renderer, tt);
      choreographer.seek(tt, { playing: false });
      renderOneFrame(0.016, true);
      renderOneFrame(0.016, false);
    }
    waterPool.resetSimulation(renderer, 0);
    postPipeline.resetFeedback(renderer);
    choreographer.seek(0.0, { playing: false });
    startVeil.classList.remove('awakened');
    veilTextEl.textContent = veilReadyLabel;
  }

  // Render initial standby frame (`t = 0.00s`)
  renderOneFrame(0.016, true);

  let lastMs = performance.now();
  let frameMsEma = 16.7;
  let slowFrames = 0;
  let fastFrames = 0;
  let renderScale = 1.0;
  let pendingScale: number | null = null;
  let guardDownLocked = false;
  // ?fps=1: a small frame-rate and render-size readout in the top right corner, for testing on a phone
  let fpsEl: HTMLElement | null = null;
  let fpsTick = 0;
  if (params.get('fps') === '1') {
    fpsEl = document.createElement('div');
    fpsEl.style.cssText =
      'position:fixed;top:max(8px,env(safe-area-inset-top));right:max(10px,env(safe-area-inset-right));z-index:70;' +
      'font:11px/1.3 ui-monospace,Menlo,monospace;color:rgba(240,212,172,.9);background:rgba(0,0,0,.45);' +
      'padding:3px 7px;border-radius:5px;pointer-events:none;white-space:pre';
    document.body.appendChild(fpsEl);
  }
  let dropCheck: { frames: number; msBefore: number; scaleBefore: number } | null = null;
  function animate(nowMs: number) {
    requestAnimationFrame(animate);
    const rawDt = (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const dt = Math.min(0.05, Math.max(0.001, rawDt));
    fpsSmooth = fpsSmooth * 0.92 + (1.0 / Math.max(0.001, rawDt)) * 0.08;
    // A change of render resolution is applied before the frame is drawn. Resizing after drawing (as it
    // used to) throws the finished frame away, and the whole screen shows black for one frame.
    if (pendingScale !== null) {
      renderScale = pendingScale;
      pendingScale = null;
      const baseDpr = pickDpr();
      renderer.setPixelRatio(baseDpr * renderScale);
      renderer.setSize(window.innerWidth, window.innerHeight);
      postPipeline.resize(window.innerWidth, window.innerHeight, baseDpr * renderScale);
    }
    renderOneFrame(dt, false);
    if (fpsEl && ++fpsTick % 20 === 0) {
      fpsEl.textContent = `${fpsSmooth.toFixed(0)} fps  ${canvas.width}×${canvas.height}  ×${renderScale.toFixed(2)}${isMobile ? '  mobile' : ''}`;
    }

    // Frame-rate guard: if the machine cannot hold 30 fps, render slightly fewer pixels rather than stutter.
    // (Skipped while the tab is hidden or right after a hitch, so one long frame never triggers it.)
    if (rawDt < 0.25 && !document.hidden && !(window as any).__noGuard) {
      frameMsEma = frameMsEma * 0.94 + rawDt * 1000 * 0.06;
      slowFrames = frameMsEma > quality.slowFrameMs ? slowFrames + 1 : 0;
      fastFrames = frameMsEma < 19.0 ? fastFrames + 1 : 0;
      let next = renderScale;
      // A step down that bought nothing means pixels are not what holds the frame back (a phone in
      // Low Power Mode is simply capped at 30 fps): take the step back and stop stepping down.
      if (dropCheck && --dropCheck.frames <= 0) {
        if (frameMsEma > dropCheck.msBefore - 1.0) {
          next = dropCheck.scaleBefore;
          guardDownLocked = true;
        }
        dropCheck = null;
      }
      const floor = quality.minRenderScale;
      if (next !== renderScale) {
        // reverting, decided above
      } else if (!guardDownLocked && !dropCheck && slowFrames > 50 && renderScale > floor) {
        next = Math.max(floor, renderScale - 0.1);
        dropCheck = { frames: 150, msBefore: frameMsEma, scaleBefore: renderScale };
      } else if (fastFrames > 600 && renderScale < 1.0) next = Math.min(1.0, renderScale + 0.1);
      if (next !== renderScale) {
        pendingScale = next;
        slowFrames = 0;
        fastFrames = 0;
      }
    }
  }
  requestAnimationFrame(animate);
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap The Other Side:', err);
});
