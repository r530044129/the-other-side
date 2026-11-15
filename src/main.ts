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
  [0.0, 1.55], [9.0, 1.55], [13.0, 1.34], [46.38, 1.34], [46.4, 1.30], [52.0, 1.22], [78.6, 1.20],
  [85.7, 1.12], [90.0, 1.22], [143.2, 1.26], [146.0, 1.50], [196.0, 1.50], [199.4, 1.18], [243.3, 1.40], [255.0, 1.36],
  [286.05, 1.45],
];
// Lens focus: a few keyed subjects, eased between; the distance is measured from the live camera.
const FOCUS_KEYS: [number, number, number, number, number][] = [
  // t, x, y, z, aperture
  [0.0, 0, 0.0, 0.0, 0.5],
  [7.2, 0, 0.0, 0.0, 0.5],
  // shot ②: focus rides on the hero flower B; the nave and its lamps fall soft
  [11.4, -1.2, 1.3, 1.5, 0.62],
  [46.38, -1.2, 1.3, 1.5, 0.62],
  [46.4, 0, 2.3, 0.3, 0.80],
  [78.6, 0, 2.3, 0.3, 0.80],
  [90.0, 0, 2.6, 0.0, 0.22],
  [100.0, 0, 2.6, 0.0, 0.22],
  [105.0, 0, 7.0, -7.0, 0.12],
  [129.0, 0, 7.0, -7.0, 0.12],
  [133.0, 0, 2.6, 0.0, 0.22],
  [143.0, 0, 1.2, 0.0, 0.22],
  [146.0, 0, 1.0, 0.0, 0.16],
  [197.5, 0, 1.0, 0.0, 0.16],
  [199.4, 0, 1.6, -2.4, 0.34],
  [243.3, 0, 1.6, -2.4, 0.34],
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
  return Math.max(1.2, Math.hypot(camPos.x - f.x, camPos.y - f.y, camPos.z - f.z));
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

  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const startVeil = document.getElementById('start-veil')!;
  const subtlePromptEl = document.getElementById('subtle-prompt')!;
  // loading takes a while (the flower model is large): say so instead of inviting a click that does nothing
  const veilTextEl = startVeil.querySelector('.veil-text') as HTMLElement;
  const veilReadyLabel = veilTextEl.textContent ?? '';
  veilTextEl.textContent = '正在载入 …';
  const debugPanelEl = document.getElementById('debug-panel')!;
  const spaceHintEl = document.getElementById('space-hint') as HTMLElement;
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

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
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
  const postPipeline = createPostPipeline(window.innerWidth, window.innerHeight, dpr);
  const choreographer = new MusicChoreographer();

  await Promise.all([choreographer.loadCues(), shylights.ready]);
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
  function renderOneFrame(dt: number, snapCameraImmediately = false): ChoreographySnapshot {
    const snap = choreographer.step(dt);
    latestSnap = snap;
    const story = snap.story;
    const s2 = snap.shot2;
    // 2.39:1 picture inside whatever window we have
    // (the bars close in as the camera comes down from the title, so the oil lettering is not cropped)
    const bandFull = Math.min(1.0, cameraRig.camera.aspect / 2.39);
    const band = 1.0 + (bandFull - 1.0) * sstep(7.4, 11.2, snap.time);
    // weak top light of the nave, breathing very slowly with the strings
    const dkTop = 0.85 + 0.25 * s2.otherSlow;
    const fovPunch =
      (story.flipAge >= 0 ? 3.5 * Math.exp(-story.flipAge * 2.2) : 0) +
      (story.surfaceAge >= 0 ? 7.0 * Math.exp(-story.surfaceAge * 2.6) : 0);

    // While the lens sits at the waterline after surfacing it rides the near edge of the sheet.
    let rideY = 0;
    {
      const rideEnv = sstep(198.3, 198.7, snap.time) * (1.0 - sstep(199.8, 200.7, snap.time));
      if (rideEnv > 0.001) {
        const h = waterPool.carpet.heightAtWorld(0, 3.4) - 1.48 * 1.0;
        rideY = Math.max(-0.3, Math.min(0.3, h)) * 0.7 * rideEnv;
      }
    }
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
        },
        dt
      );
    }

    // 2. Update Pure Wire-Free Shylight Ensemble (B, A, C & Finale Giant)
    const shyState = {
      time: snap.time,
      causticBounce: snap.wallCausticIntensity,
      selfLit: s2.look,
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
      shadowPass: story.shadowPass,
      shadowSlide: story.shadowSlide,
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
    });

    // 6. Update Deep-Sea Misty Sky-Theater, Hanging Refracted Curtains, Pool Caustics & Rising Pearls
    gallery.update({
      time: story.fxTime,
      shadowVoid: snap.shadowVoid,
      shot1Dark: snap.shot1Dark,
      ambientKeep: snap.ambientKeep,
      shylightLights: activeLights,
      wallCausticIntensity: snap.wallCausticIntensity,
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
      presence *= 1.0 - 0.85 * sstep(69.0, 71.8, t) * (1.0 - sstep(75.4, 78.2, t));
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
        level: 0.32 + 0.68 * sstep(9.0, 14.0, t),
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
    });

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

    // 8. Render HDR Main Scene + ACES Filmic / Analog Video Feedback Composite
    renderer.setRenderTarget(postPipeline.sceneRT);
    renderer.clear();
    waterPool.waterMesh.visible = !(window as any).__noWater;
    shylights.root.visible = !(window as any).__noFlowers;
    gallery.root.visible = !(window as any).__noGallery;
    if ((window as any).__noNave) nave.group.visible = false;
    renderer.render(scene, cameraRig.camera);

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
    postPipeline.renderFinal(renderer, {
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
      edgeSoft: s2.look,
    });

    // 9. Sync Whisper-Quiet Entrance / Prompt UI & [D] Debug Telemetry HUD
    if (snap.hasStarted && snap.time < snap.duration - 0.15) {
      startVeil.classList.add('awakened');
    } else if (snap.time >= snap.duration - 0.15 && !snap.playing) {
      startVeil.querySelector('.veil-text')!.textContent = '点击画面 或 按下 SPACE 重新进入';
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
      spaceHintEl.style.setProperty('--hint-bottom', `${hintBottom.toFixed(0)}px`);
      spaceHintEl.style.setProperty('--show', h.show.toFixed(3));
      spaceHintEl.style.setProperty('--pulse', h.pulse.toFixed(3));
      if (h.toBeat > 0 && h.toBeat < 1.05) {
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
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('#timeline, #debug-panel, #start-veil, button, input')) return;
      dragId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      document.body.classList.add('look-drag');
    });
    window.addEventListener('pointermove', (e) => {
      if (dragId !== e.pointerId) return;
      // dragging right/down turns the view like UE5 mouse-look (drag right = look right, drag up = look up): full range takes ~a quarter screen
      const k = 2.0 / Math.max(200, window.innerWidth * 0.25);
      pointerX = clamp1(pointerX + (e.clientX - lastX) * k);
      pointerY = clamp1(pointerY + (e.clientY - lastY) * k);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const endDrag = (e: PointerEvent) => {
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
    const newDpr = Math.min(window.devicePixelRatio || 1, 2);
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
      const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(baseDpr * renderScale);
      renderer.setSize(window.innerWidth, window.innerHeight);
      postPipeline.resize(window.innerWidth, window.innerHeight, baseDpr * renderScale);
    }
    renderOneFrame(dt, false);

    // Frame-rate guard: if the machine cannot hold 30 fps, render slightly fewer pixels rather than stutter.
    // (Skipped while the tab is hidden or right after a hitch, so one long frame never triggers it.)
    if (rawDt < 0.25 && !document.hidden) {
      frameMsEma = frameMsEma * 0.94 + rawDt * 1000 * 0.06;
      slowFrames = frameMsEma > 31.5 ? slowFrames + 1 : 0;
      fastFrames = frameMsEma < 19.0 ? fastFrames + 1 : 0;
      let next = renderScale;
      if (slowFrames > 50 && renderScale > 0.62) next = Math.max(0.62, renderScale - 0.1);
      else if (fastFrames > 600 && renderScale < 1.0) next = Math.min(1.0, renderScale + 0.1);
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
