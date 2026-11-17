import { assetUrl } from './device';
import { BiolumDropSeed } from './inkField';
import { ShylightUnitPose } from './shylight';
import { StoryState, computeStoryBase, fxTimeAt, T_FLIP, T_FREEZE_IN, T_SURFACE } from './story';
import {
  DROP_G,
  S2_CYCLE_BEATS,
  S2_END,
  S2_FLOWERS,
  S3_FLOWERS,
  S2Flower,
  BLOOM_BOTTOM_T,
  BreathState,
  CLIP_BLOOM,
  breathClip,
  breathDrop01,
  breathHeights,
  breathOpen01,
  clipDuration,
  newBreath,
  setClipData,
  stepBreath,
  surgeEnvelope,
} from './shot2';

export interface ReckonerSection {
  name: string;
  start: number;
  end: number;
}

export interface ReckonerAccent {
  t: number;
  strength: number;
  kind: string;
}

export interface ReckonerCues {
  title: string;
  file: string;
  duration: number;
  bpm: number;
  beat: number;
  bar: number;
  offset: number;
  end: number;
  climax: number;
  sections: ReckonerSection[];
  beats: number[];
  accents: ReckonerAccent[];
  events: Record<string, number>;
  phrases: [number, number][];
  hits: [number, number, number][];
  envelope: {
    rate: number;
    drums: number[];
    bass: number[];
    bassFast?: number[];
    vocals?: number[];
    other?: number[];
    pitch?: number[];
  };
}

export type ShotNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ShotWindow {
  id: ShotNumber;
  label: string;
  start: number;
  end: number;
}

/** Smoothstep-interpolated keyframe curve over time. */
function keyCurve(t: number, keys: [number, number][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return v0 + (v1 - v0) * (u * u * (3 - 2 * u));
    }
  }
  return keys[keys.length - 1][1];
}

export const SHOT_WINDOWS: ShotWindow[] = [
  { id: 1, label: '① 0:00-0:10 油膜大字与旋流', start: 0.0, end: 9.8 },
  { id: 2, label: '② 0:10-0:46 纯丝三花与呼吸', start: 9.8, end: 46.4 },
  { id: 3, label: '③ 0:46-1:19 深水立体彩虹墨', start: 46.4, end: 78.6 },
  { id: 4, label: '④ 1:19-2:24 雾幕水光与升珠', start: 78.6, end: 143.8 },
  { id: 5, label: '⑤ 2:24-3:18 满幅水绸与焦散', start: 143.8, end: 197.8 },
  { id: 6, label: '⑥ 3:18-4:03 中央巨影敲水绸', start: 197.8, end: 243.3 },
  { id: 7, label: '⑦ 4:03-4:46 巨花正心终章', start: 243.3, end: 286.05 },
];

export interface TriggeredRipple {
  worldX: number;
  worldZ: number;
  radiusMeters: number;
  strength: number;
  strikeCarpetUV?: [number, number];
  reason: string;
  /** Optional shaping of the ring: iris = rainbow on its edge, decay = fade rate (1/s), k = wavelength scale, grow = spread speed scale. */
  fx?: { iris?: number; decay?: number; k?: number; grow?: number };
}

/** Result of a space press, so the caller can answer on-beat hits with sound immediately. */
export interface TapResult {
  onBeat: boolean;
  streak: number;
}

/** Shot ② (Deakins version): everything the set, the water and the lens need. */
export interface Shot2State {
  /** 0..1: the Deakins set and look are in (shot ② only for now; cut at 46.4). */
  look: number;
  /** Resonance 0..1 built by on-beat taps; decays slowly when the player stops. */
  resonance: number;
  /** Standing-wave pattern: world centre, amplitude 0..1, radius in metres, phase (flips every beat). */
  patCentre: [number, number];
  patAmp: number;
  patRadius: number;
  patPhase: number;
  /** Light surge after each strong drum hit (0..1; 0.1 s up, about half a second down). */
  surge: number;
  /** Slow level of the 'other' stem (guitar/strings): how much water light reaches the vaults. */
  otherSlow: number;
  /** Growth of the branching columns in the nave (0..1): one generation with each of B's landings. */
  columnGrow: number;
  /** Growth of the light veins under the water in shot ③ (0..1) and their brightness. */
  veinGrow: number;
  veinLevel: number;
  /** Cue for the next strong beat: a ring of water closing on B's foot. toLand = seconds until it arrives. */
  cue: { x: number; z: number; toLand: number; strength: number };
  /** Cue drops in flight or sliding down a cable: world position and brightness. */
  drops: { x: number; y: number; z: number; a: number }[];
  /** The reflection of B runs a little late (automatic thread of 'the reflection misbehaves'). */
  mirrorB: ShylightUnitPose | null;
  /** A lamp crossing the far bays behind the columns (nave-local metres) and its level 0..1. */
  sweep: { x: number; y: number; z: number; level: number };
  /** Flower shadows standing in the light the water throws on the wall (B, A, C). */
  wallShadows: { x: number; hubY: number; z: number; open: number; scale: number; level: number }[];
}

export interface DebugEventLogEntry {
  wallClock: string;
  songTimeSec: number;
  barBeat: string;
  shotId: ShotNumber;
  tag: string;
  detail: string;
}

export interface ChoreographySnapshot {
  time: number;
  duration: number;
  hasStarted: boolean;
  playing: boolean;
  playbackRate: number;
  shotId: ShotNumber;
  shotLabel: string;
  barIndex: number;
  beatInBar: number;
  beatPhase: number;
  beatSec: number;

  drumsEnv: number;
  bassEnv: number;
  vocalsEnv: number;
  otherEnv: number;

  shadowVoid: number;
  /** Shot 1 lighting state: 1 = single overhead lamp shaft, rest of the space in shadow; fades out as the blossoms take over */
  shot1Dark: number;
  /** How much of the generic ambient haze (sky mist, horizon glow, veil) is kept. Motivated lights are not scaled. */
  ambientKeep: number;
  titlePresence: number;
  balatroSwirlAmount: number;
  wallCausticIntensity: number;
  poolFloorCausticIntensity: number;
  antiGravityDropletsIntensity: number;
  volumetricShaftIntensity: number;
  endingBlackout: number;

  shylightA: ShylightUnitPose;
  shylightB: ShylightUnitPose;
  shylightC: ShylightUnitPose;
  shylightGiant: ShylightUnitPose;
  windForceB: number;
  windForceAC: number;

  biolumInkVisibility: number;
  biolumDrops: BiolumDropSeed[];
  swirlGather: number;
  bassStandingWave: number;
  carpetLevitation: number;
  carpetWaveActivity: number;

  drummerPresence: number;
  timeSinceDrummerStrike: number;
  drummerStrikeCount: number;

  feedbackStrength: number;
  breathStrength: number;

  subtlePromptText: string;
  isSpaceHeld: boolean;
  triggeredRipples: TriggeredRipple[];

  /** Story layer: the reflection as another world. */
  story: StoryState;
  /** Rig keeps posing/rendering the drummer whenever either the mist shadow or the underwater pass needs it. */
  drummerRigPresence: number;
  /** World XZ of the most recent strike (for the light that leaks up from the other side). */
  tealLeak: number;
  shot2: Shot2State;
  /** 0..1: the lens looks straight down at the water (shot ③): only the flowers' pools of light are left. */
  topDown: number;
  /** 0..1: the flowers carry no light of their own and read as dark shapes against what is behind them. */
  flowerSilhouette: number;
  /**
   * Space-key hint for the stretches where space does something: show 0..1 (dims once the player has
   * got it), toBeat = seconds until the next strong beat (or -1 when the stretch has no beat to hit),
   * pulse 0..1 on the beat.
   */
  spaceHint: { show: number; toBeat: number; pulse: number; down: boolean; mode: 'none' | 'hold' | 'tap'; label: string };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function seededHash(n: number): number {
  const x = Math.sin(n * 91.3458 + 17.23) * 47453.5453;
  return x - Math.floor(x);
}


export class MusicChoreographer {
  private cues: ReckonerCues | null = null;
  private audio: HTMLAudioElement;
  private hasStartedFlag = false;
  private isPlaying = false;
  private syntheticClockMode = false;
  private manualTime = 0;
  private playbackSpeed = 1.0;
  private loopShotId: ShotNumber | null = null;

  private isSpaceDown = false;
  private prevBreathB = 0.0;
  private prevBreathA = 0.0;
  private prevBreathC = 0.0;
  private lastDownbeatBar = -1;
  private lastPlungedInkIdx = -1;

  private shot4HoldSwirl = 0.0;

  private lastStrikeSongTime = -999;
  private lastAutoBeat = -1;
  private strikeCounter = 0;
  private latestDrummerImpactUV: [number, number] = [0.46, 0.62];

  private scheduledBiolumDrops: BiolumDropSeed[] = [];
  private pendingRipples: TriggeredRipple[] = [];
  private eventLogs: DebugEventLogEntry[] = [];
  private lastLoggedShot: ShotNumber | 0 = 0;

  /** Per-session seed: which beats fire small events and what they do. The WHEN always stays on the beat. */
  private sessionSeed = Math.random() * 500.0;
  private flowIntegral: Float32Array = new Float32Array(2);
  private skyPulseList: { birth: number; x: number; y: number; strength: number }[] = [];
  private skyPulseCount = 0;
  private bloomBurstAt = -999;
  private hueSmooth = 0;
  private prevStepTime = 0;
  private comboCount = 0;
  private echoLevel = 0;
  private revealAt = -999;
  private lastStrikeXZ: [number, number] = [0, -1.2];

  // ---- shot ②: resonance ----
  private landTimes: Record<'B' | 'A' | 'C', number[]> = { B: [], A: [], C: [] };
  private strongHits: [number, number][] = [];
  private resonance = 0;
  private resonanceSmooth = 0;
  private tapStreak = 0;
  private lastTapAt = -999;
  private lastOnBeatAt = -999;
  private lastDropBeat = -1;
  private drumDrive = 0;
  private otherSlow = 0;
  private autoTap = false;
  private s2OnBeatTaps = 0;

  // ---- shots ② and ③: the breath is the player's ----
  private breath: Record<'B' | 'A' | 'C', BreathState> = { B: newBreath(), A: newBreath(), C: newBreath() };
  /** Two automatic breaths of B before the key is offered: [start, end] of each hold. */
  private autoHolds: [number, number][] = [];
  /** From here the space key drives the breath; before it the piece breathes by itself. */
  private ctlStart = 28.0;
  private ctlEnd = 76.0;
  private barSec = 2.303;
  /** Changes of the driving signal after ctlStart, so A and C can follow one and two bars later. */
  private holdLog: { t: number; h: boolean }[] = [];
  private lastHoldEnd = 0;
  private fallbackUntil = -999;
  private userHolds = 0;
  private pendingIris = false;
  private breathClock = 0;
  private veinBonus = 0;
  /** Shot ③: ink set off under a flower each time a breath lands (the scheduled plumes stay separate). */
  private breathInk: BiolumDropSeed[] = [];
  private inkAll: BiolumDropSeed[] = [];
  private breathInkCount = 0;

  constructor() {
    this.audio = new Audio(assetUrl('audio/reckoner-full.m4a'));
    this.audio.preload = 'auto';
    this.audio.loop = false;
    this.audio.addEventListener('playing', () => {
      this.playBlocked = false;
    });
  }

  /** The browser refused to start the music (autoplay policy). Cleared when it plays. */
  private playBlocked = false;

  private startAudio(): void {
    this.audio.play().catch(() => {
      this.playBlocked = true;
    });
  }

  /**
   * Why the music may not be heard, as far as the page can tell. The system volume and mute switch are
   * invisible to a web page; this only sees the page's own audio.
   */
  soundIssue(): 'blocked' | 'muted' | 'quiet' | null {
    if (this.syntheticClockMode) return null;
    if (this.playBlocked) return 'blocked';
    if (this.audio.muted) return 'muted';
    if (this.audio.volume < 0.1) return 'quiet';
    return null;
  }

  async loadCues(): Promise<void> {
    const res = await fetch(import.meta.env.BASE_URL + 'audio/reckoner-full-cues.json');
    this.cues = (await res.json()) as ReckonerCues;
    // fall and rib tables of the three-clip flower (bloom / hover / close)
    setClipData(await (await fetch(import.meta.env.BASE_URL + 'models/shylight_three_clips.json')).json());
    this.buildScheduledBiolumDrops();
    for (const key of ['B', 'A', 'C'] as const) {
      const f = S2_FLOWERS[key];
      this.landTimes[key] = [];
      for (let n = 0; n < 4; n++) this.landTimes[key].push(this.beatTimeAt(f.firstLandBeat + n * S2_CYCLE_BEATS));
    }
    {
      const hold = clipDuration(CLIP_BLOOM) + 2.3;
      const l1 = this.beatTimeAt(S2_FLOWERS.B.firstLandBeat);
      const l2 = this.beatTimeAt(S2_FLOWERS.B.firstLandBeat + 16);
      this.autoHolds = [
        [l1 - BLOOM_BOTTOM_T, l1 - BLOOM_BOTTOM_T + hold],
        [l2 - BLOOM_BOTTOM_T, l2 - BLOOM_BOTTOM_T + hold],
      ];
      this.ctlStart = this.autoHolds[1][1] + 1.0;
      this.barSec = (this.beatTimeAt(40) - this.beatTimeAt(24)) / 4;
      this.lastHoldEnd = this.ctlStart;
    }
    this.strongHits = this.cues.hits.filter((h) => h[2] > 0.6).map((h) => [h[0], Math.min(1, h[2])]);
    this.pushLog('INIT', `Loaded full Reckoner cues (${this.cues.duration.toFixed(2)}s, ${this.cues.bpm} BPM)`);
  }

  private buildScheduledBiolumDrops(): void {
    this.scheduledBiolumDrops = [];
    if (!this.cues) return;

    // Schedule 3D underwater sinking bioluminescent ink plumes across Shot 3 (46.4..78.4s) & Shot 4 (86..122s)
    // Placed right in the near-foreground abyssal ocean (`worldX in [-2.6..+2.6]`, `worldZ in [-0.4..+3.2]`)
    // where Fresnel water penetration (`1 - F`) is deepest (`~85%` visibility into `y < 0`) AND clear of the
    // planar Shylight reflections so the sinking 3D stems & toroidal vortex heads read with full stereoscopic clarity!
    let idx = 0;
    for (const beatT of this.cues.beats) {
      // (shot ③'s plumes used to fall by themselves every fourth beat; now each one answers a breath)
      if (false && beatT >= 46.4 && beatT <= 59.6) {
        idx++;
        if (idx % 4 === 1) {
          const h1 = seededHash(idx * 3.17 + this.sessionSeed);
          const h2 = seededHash(idx * 7.91 + this.sessionSeed);
          const h3 = seededHash(idx * 13.37);
          this.scheduledBiolumDrops.push({
            worldX: (h1 - 0.5) * 5.2,
            worldZ: -0.4 + h2 * 3.6,
            birthTime: beatT,
            radius: 0.90 + h3 * 0.36,
            strength: 1.32 + h1 * 0.35,
            seed: (idx * 7.31) % 97,
            hueShift: (h2 - 0.5) * 0.75,
          });
        }
      }
    }
    // 1:00..1:08 — the other side grows its own three flowers, hanging upside-down under the real ones.
    const flowerSpots: [number, number, number][] = [
      [0.0, 0.75, 60.4],
      [-2.25, -0.95, 62.7],
      [2.25, -0.95, 65.0],
    ];
    flowerSpots.forEach(([x, z, wantT], i) => {
      let birth = wantT;
      let best = 1e9;
      for (const bt of this.cues!.beats) {
        const d = Math.abs(bt - wantT);
        if (d < best) { best = d; birth = bt; }
      }
      this.scheduledBiolumDrops.push({
        worldX: x,
        worldZ: z,
        birthTime: birth,
        radius: i === 0 ? 1.62 : 1.38,
        strength: 2.1,
        seed: 11.0 + i * 23.7,
        hueShift: [0.0, -0.32, 0.32][i],
        bloom: true,
      });
    });
    this.scheduledBiolumDrops.sort((p, q) => p.birthTime - q.birthTime);
    this.inkAll = this.scheduledBiolumDrops;

    // Bass-driven flow clock for the liquid light show: the low end pushes the big slow vortices.
    const env = this.cues.envelope;
    const rate = env.rate || 20;
    const bass = env.bassFast ?? env.bass;
    this.flowIntegral = new Float32Array(bass.length + 1);
    let acc = 0;
    for (let i = 0; i < bass.length; i++) {
      acc += (0.16 + 0.95 * bass[i]) / rate;
      this.flowIntegral[i + 1] = acc;
    }
  }

  get duration(): number {
    return this.cues?.duration ?? 286.05;
  }

  get muted(): boolean {
    return this.audio.muted;
  }

  setMuted(m: boolean): void {
    this.audio.muted = m;
    this.pushLog('AUDIO', m ? 'Muted audio' : 'Unmuted audio');
  }

  setPlaybackRate(rate: number): void {
    this.playbackSpeed = clamp(rate, 0.25, 2.0);
    this.audio.playbackRate = this.playbackSpeed;
    this.pushLog('SPEED', `Playback speed = ${this.playbackSpeed.toFixed(2)}x`);
  }

  setLoopShot(shotId: ShotNumber | null): void {
    this.loopShotId = shotId;
    this.pushLog('LOOP', shotId ? `Looping Shot ${shotId}` : 'Loop off (Full single-take)');
  }

  getLoopShot(): ShotNumber | null {
    return this.loopShotId;
  }

  updateDrummerImpactUV(uv: [number, number]): void {
    this.latestDrummerImpactUV = uv;
  }

  /** Time of the audio element itself (null when it is not the clock), for sync checks. */
  audioClock(): number | null {
    return this.syntheticClockMode || this.audio.paused ? null : this.audio.currentTime;
  }

  getLogs(): DebugEventLogEntry[] {
    return this.eventLogs;
  }

  setSyntheticClockMode(enabled: boolean): void {
    this.syntheticClockMode = enabled;
    if (enabled) {
      this.sessionSeed = 7.0;
      this.buildScheduledBiolumDrops();
    }
    if (enabled && !this.audio.paused) {
      this.audio.pause();
    }
  }

  private resolveShot(t: number): ShotWindow {
    for (const w of SHOT_WINDOWS) {
      if (t < w.end) return w;
    }
    return SHOT_WINDOWS[SHOT_WINDOWS.length - 1];
  }

  /**
   * Tracked beats from the analysis file. The even grid (offset + n * beat) drifts up to a quarter of a
   * second against the recording, so anything that has to sit on the drums uses these instead.
   */
  private beatTimeAt(i: number): number {
    const b = this.cues?.beats;
    if (!b || b.length < 2) return 1.178 + i * 0.5805;
    if (i <= 0) return b[0] + i * (b[1] - b[0]);
    const n = b.length - 1;
    if (i >= n) return b[n] + (i - n) * (b[n] - b[n - 1]);
    const i0 = Math.floor(i);
    return b[i0] + (b[i0 + 1] - b[i0]) * (i - i0);
  }

  /** Continuous tracked-beat position at time t (integer = on a beat). */
  private beatPos(t: number): number {
    const b = this.cues?.beats;
    if (!b || b.length < 2) return (t - 1.178) / 0.5805;
    const n = b.length - 1;
    if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]);
    if (t >= b[n]) return n + (t - b[n]) / (b[n] - b[n - 1]);
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - b[lo]) / (b[lo + 1] - b[lo]);
  }

  /** Tracked-beat position at an arbitrary time (for systems that pose themselves at offset times). */
  beatPosAt(t: number): number {
    return this.beatPos(t);
  }

  /** Debug/verification: tap by itself on every beat of shot ②. */
  setAutoTap(on: boolean): void {
    this.autoTap = on;
  }

  /** Is the breath being held at this moment (by the piece, the player, or the fallback)? */
  private driverAt(time: number): boolean {
    if (time < this.ctlStart) {
      for (const [a, b] of this.autoHolds) if (time >= a && time < b) return true;
      return false;
    }
    let h = false;
    for (const e of this.holdLog) {
      if (e.t <= time) h = e.h;
      else break;
    }
    return h;
  }

  /** Space going down while the breath is the player's: on a strong beat the landing will carry colour. */
  private breathPress(t: number): TapResult {
    const nearest = 2 * Math.round(this.beatPos(t) / 2);
    const off = t - this.beatTimeAt(nearest);
    const onBeat = off > -0.20 && off < 0.22;
    this.userHolds++;
    if (onBeat) {
      this.tapStreak = t - this.lastOnBeatAt < 14 ? this.tapStreak + 1 : 1;
      this.resonance = Math.min(1, this.resonance + 0.16 + 0.04 * Math.min(this.tapStreak, 4));
      this.lastOnBeatAt = t;
      this.s2OnBeatTaps++;
      this.pendingIris = true;
    } else {
      this.tapStreak = 0;
    }
    this.pushLog(onBeat ? 'BREATH_ON' : 'BREATH', `off=${(off * 1000).toFixed(0)}ms res=${this.resonance.toFixed(2)}`);
    return { onBeat, streak: this.tapStreak };
  }

  private formatBarBeat(t: number): { barIndex: number; beatInBar: number; beatPhase: number; text: string } {
    // Bars and beats come from the tracked beats of the recording. The even grid (offset + n * beat)
    // drifts up to a quarter of a second against the drums and barely correlates with them.
    const relBeats = Math.max(0, this.beatPos(t));
    const totalBeatInt = Math.floor(relBeats);
    const barIndex = Math.floor(totalBeatInt / 4) + 1;
    const beatInBar = (totalBeatInt % 4) + 1;
    const beatPhase = relBeats - totalBeatInt;
    return {
      barIndex,
      beatInBar,
      beatPhase,
      text: `${String(barIndex).padStart(3, '0')}:${beatInBar}.${Math.floor(beatPhase * 10)}`,
    };
  }

  pushLog(tag: string, detail: string): void {
    const t = this.manualTime;
    const shot = this.resolveShot(t);
    const bb = this.formatBarBeat(t);
    const now = new Date();
    const wallClock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    this.eventLogs.push({
      wallClock,
      songTimeSec: Number(t.toFixed(3)),
      barBeat: bb.text,
      shotId: shot.id,
      tag,
      detail,
    });
    if (this.eventLogs.length > 160) {
      this.eventLogs.shift();
    }
  }

  startExperience(): void {
    if (this.hasStartedFlag && this.isPlaying) return;
    if (this.manualTime >= this.duration - 0.5) {
      this.seek(0.0, { playing: true });
    }
    this.hasStartedFlag = true;
    this.play();
    this.pushLog('START', 'Performance awakened');
  }

  play(): void {
    this.hasStartedFlag = true;
    this.isPlaying = true;
    if (this.syntheticClockMode) return;
    try {
      this.audio.currentTime = this.manualTime;
      this.audio.playbackRate = this.playbackSpeed;
    } catch {}
    this.startAudio();
  }

  pause(): void {
    this.isPlaying = false;
    this.audio.pause();
    this.pushLog('PAUSE', `Paused at ${this.manualTime.toFixed(2)}s`);
  }

  toggleDebugPlayPause(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
      this.pushLog('PLAY', `Resumed at ${this.manualTime.toFixed(2)}s`);
    }
  }

  private pushBreathInk(k: 'B' | 'A' | 'C', birthTime: number): void {
    const f = S3_FLOWERS[k];
    const main = k === 'B';
    const n = this.breathInkCount++;
    const h = seededHash(n * 5.31 + 2.7);
    this.breathInk.push({
      // a little toward the lens, clear of the flower's own reflection
      worldX: f.x + (h - 0.5) * 0.5,
      worldZ: f.z + (main ? 0.95 : 0.75),
      birthTime,
      radius: main ? 1.0 : 0.8,
      strength: main ? 1.5 : 1.15,
      seed: (n * 7.31 + 3.0) % 97,
      hueShift: (((n * 0.37) % 1) - 0.5) * 0.9,
      life: 16.0,
    });
    if (this.breathInk.length > 14) this.breathInk.shift();
  }

  private mergeInk(): void {
    this.inkAll = this.breathInk.length
      ? this.scheduledBiolumDrops.concat(this.breathInk).sort((p, q) => p.birthTime - q.birthTime)
      : this.scheduledBiolumDrops;
  }

  onSpaceDown(): TapResult | null {
    if (!this.hasStartedFlag || this.manualTime >= this.duration - 0.3) {
      this.startExperience();
      return null;
    }
    if (this.isSpaceDown) return null;
    this.isSpaceDown = true;
    if (this.manualTime >= this.ctlStart && this.manualTime < this.ctlEnd) {
      return this.breathPress(this.manualTime);
    }

    const shot = this.resolveShot(this.manualTime).id;
    if (shot === 6) {
      this.lastStrikeSongTime = this.manualTime;
      this.strikeCounter++;
      const [uHit, vHit] = this.latestDrummerImpactUV;
      const jitterX = (seededHash(this.strikeCounter * 3.7) - 0.5) * 0.012;
      const jitterY = (seededHash(this.strikeCounter * 7.1) - 0.5) * 0.012;
      const cu = clamp(uHit + jitterX, 0.14, 0.86);
      const cv = clamp(vHit + jitterY, 0.12, 0.90);
      this.pendingRipples.push({
        worldX: (cu - 0.5) * 16.0,
        worldZ: -1.2 + (0.5 - cv) * 9.6,
        radiusMeters: 0.54,
        strength: 1.65,
        strikeCarpetUV: [cu, cv],
        reason: 'drummer-space-strike',
      });
      this.lastStrikeXZ = [(cu - 0.5) * 16.0, -1.2 + (0.5 - cv) * 9.6];
      const ph = this.formatBarBeat(this.manualTime).beatPhase;
      const offBeatSec = Math.min(ph, 1.0 - ph) * (this.cues?.beat ?? 0.5805);
      const halfPh = (ph * 2.0) % 1.0;
      const offHalfSec = Math.min(halfPh, 1.0 - halfPh) * 0.5 * (this.cues?.beat ?? 0.5805);
      if (Math.min(offBeatSec, offHalfSec) < 0.085) this.comboCount++;
      else this.comboCount = 0;
      if (this.manualTime > 204.0 && seededHash(this.strikeCounter * 5.3 + this.sessionSeed) < 0.24) {
        this.revealAt = this.manualTime;
      }
      this.pushLog('DRUM_HIT', `Space strike #${this.strikeCounter} combo=${this.comboCount} -> carpetUV=(${cu.toFixed(2)}, ${cv.toFixed(2)})`);
    } else if (shot === 4 && this.manualTime >= T_FLIP + 0.6 && this.manualTime < 141.5) {
      // Breathing into the sky: the hero flower exhales and a ring pushes through the liquid light.
      this.skyPulseCount++;
      const hx = seededHash(this.skyPulseCount * 2.71 + this.sessionSeed);
      const hy = seededHash(this.skyPulseCount * 6.13 + this.sessionSeed);
      this.skyPulseList.unshift({ birth: this.manualTime, x: (hx - 0.5) * 0.9, y: 0.50 + hy * 0.5, strength: 1.0 });
      if (this.skyPulseList.length > 2) this.skyPulseList.length = 2;
      this.bloomBurstAt = this.manualTime;
      this.pendingRipples.push({ worldX: 0.0, worldZ: 0.75, radiusMeters: 0.46, strength: 0.9, reason: 'sky-breath' });
      this.pushLog('SKY_BREATH', `Breath #${this.skyPulseCount} pushed into the light`);
    }
    return null;
  }

  onSpaceUp(): void {
    this.isSpaceDown = false;
  }

  seek(sec: number, opts?: { playing?: boolean; spaceHeld?: boolean; triggerDrumStrike?: boolean }): void {
    const clamped = clamp(sec, 0, this.duration);
    this.manualTime = clamped;
    this.hasStartedFlag = clamped > 0.001 || Boolean(opts?.playing);
    try {
      this.audio.currentTime = clamped;
    } catch {}
    if (opts?.playing !== undefined) {
      if (opts.playing) {
        this.isPlaying = true;
        if (!this.syntheticClockMode) this.startAudio();
      } else {
        this.isPlaying = false;
        this.audio.pause();
      }
    }

    this.skyPulseList = [];
    this.bloomBurstAt = -999;
    this.comboCount = 0;
    this.echoLevel = 0;
    this.revealAt = -999;
    this.prevStepTime = clamped;
    this.hueSmooth = this.sampleEnvelope('pitch', clamped);
    this.lastDownbeatBar = -1;
    this.lastPlungedInkIdx = -1;
    this.resonance = 0;
    this.resonanceSmooth = 0;
    this.s2OnBeatTaps = 0;
    this.holdLog = [];
    this.fallbackUntil = -999;
    this.userHolds = 0;
    this.pendingIris = false;
    this.lastHoldEnd = Math.max(this.ctlStart, clamped);
    this.breathInk = [];
    this.breathInkCount = 0;
    if (clamped > 48.0 && clamped < 78.0) {
      // jumping into shot ③: the water already holds what the last breaths left
      (['B', 'A', 'C'] as const).forEach((k, i) => {
        const bt = clamped - 1.5 - 2.5 * i;
        if (bt > 46.6) this.pushBreathInk(k, bt);
      });
    }
    this.mergeInk();
    this.breath = { B: newBreath(), A: newBreath(), C: newBreath() };
    // pre-roll the automatic part so a jump lands in the right pose
    for (let ts = Math.max(0, clamped - 14.0); ts < clamped; ts += 1 / 30) {
      stepBreath(this.breath.B, this.driverAt(ts), 1 / 30);
      stepBreath(this.breath.A, this.driverAt(ts - this.barSec), 1 / 30);
      stepBreath(this.breath.C, this.driverAt(ts - 2 * this.barSec), 1 / 30);
    }
    this.breathClock = clamped;
    this.tapStreak = 0;
    this.lastTapAt = -999;
    this.lastOnBeatAt = -999;
    this.lastDropBeat = Math.floor(this.beatPos(clamped));
    this.drumDrive = this.sampleEnvelope('drums', clamped);
    this.otherSlow = this.sampleEnvelope('other', clamped);

    this.isSpaceDown = Boolean(opts?.spaceHeld);

    if (opts?.triggerDrumStrike) {
      this.lastStrikeSongTime = clamped - 0.025;
      this.strikeCounter++;
      const [cu, cv] = this.latestDrummerImpactUV;
      this.pendingRipples.push({
        worldX: (cu - 0.5) * 16.0,
        worldZ: -1.2 + (0.5 - cv) * 9.6,
        radiusMeters: 0.54,
        strength: 1.65,
        strikeCarpetUV: [cu, cv],
        reason: 'seek-drum-strike',
      });
    } else {
      this.lastStrikeSongTime = clamped > T_SURFACE && clamped < T_SURFACE + 2.5 ? T_SURFACE : -999;
    }

    this.pushLog('SEEK', `Jumped to ${clamped.toFixed(2)}s (${this.resolveShot(clamped).label})`);
  }

  private sampleEnvelope(channel: keyof ReckonerCues['envelope'], t: number): number {
    if (!this.cues || !this.cues.envelope) return 0;
    const arr = this.cues.envelope[channel] as number[] | undefined;
    if (!arr || arr.length === 0) return 0;
    const rate = this.cues.envelope.rate || 20;
    const idxFloat = Math.max(0, t * rate);
    const i0 = Math.min(arr.length - 1, Math.floor(idxFloat));
    const i1 = Math.min(arr.length - 1, i0 + 1);
    const frac = idxFloat - i0;
    return arr[i0] * (1 - frac) + arr[i1] * frac;
  }

  step(dt: number): ChoreographySnapshot {
    if (this.isPlaying) {
      // The audio element is the clock whenever it is running. (It used to be followed only while the
      // picture was within 0.35 s of it; one long frame was enough to leave the picture running late for
      // the rest of the song.)
      if (!this.syntheticClockMode && !this.audio.paused && !this.audio.seeking) {
        this.manualTime = this.audio.currentTime;
      } else {
        this.manualTime = Math.min(this.duration, this.manualTime + dt * this.playbackSpeed);
      }

      if (this.loopShotId !== null) {
        const win = SHOT_WINDOWS.find((w) => w.id === this.loopShotId);
        if (win && this.manualTime >= win.end) {
          this.manualTime = win.start + 0.02;
          try {
            this.audio.currentTime = this.manualTime;
          } catch {}
        }
      } else if (this.manualTime >= this.duration) {
        this.isPlaying = false;
      }
    }

    const t = this.manualTime;
    const shotWin = this.resolveShot(t);
    const shotId = shotWin.id;

    if (shotId !== this.lastLoggedShot) {
      this.lastLoggedShot = shotId;
      this.pushLog('SHOT', `Entered ${shotWin.label}`);
    }

    const bb = this.formatBarBeat(t);
    const beatSec = this.cues?.beat ?? 0.5805;
    const story = computeStoryBase(t);
    const freeze = story.freeze;
    const globalBeat = (bb.barIndex - 1) * 4 + (bb.beatInBar - 1);
    const beatAge = bb.beatPhase * beatSec;
    const strongBeat = bb.beatInBar === 1 || bb.beatInBar === 3;
    const hEvent = seededHash(globalBeat * 1.618 + this.sessionSeed);
    const hPick = seededHash(globalBeat * 4.271 + this.sessionSeed * 1.7);

    // The first drum hit back (198.5) pulls the camera out of the water and lands as a strike.
    if (this.prevStepTime < T_SURFACE && t >= T_SURFACE && t - this.prevStepTime < 0.5) {
      this.lastStrikeSongTime = T_SURFACE;
      const [cu, cv] = this.latestDrummerImpactUV;
      this.lastStrikeXZ = [(cu - 0.5) * 16.0, -1.2 + (0.5 - cv) * 9.6];
      this.pendingRipples.push({
        worldX: this.lastStrikeXZ[0],
        worldZ: this.lastStrikeXZ[1],
        radiusMeters: 0.6,
        strength: 1.8,
        strikeCarpetUV: [cu, cv],
        reason: 'surfacing-first-drum',
      });
    }
    this.prevStepTime = t;
    const drumsEnv = this.sampleEnvelope('drums', t);
    const bassEnv = this.sampleEnvelope('bass', t);
    const vocalsEnv = this.sampleEnvelope('vocals', t);
    const otherEnv = this.sampleEnvelope('other', t);

    // =========================================================================
    // SHOT 1 (0:00 ~ 0:09.8): Allen-Cahn Oil-Film "RECKONER" + Navier-Stokes Swirl Melt
    // =========================================================================
    const balatroSwirlAmount =
      smoothstep(1.85, 5.2, t) * (1.0 - smoothstep(8.5, 11.2, t));
    // Suppress RECKONER oil title prior to user awakening (`!hasStartedFlag`) so pre-enter UI stays serene & uncluttered,
    // coalescing smoothly onto the water as Shot 1 begins!
    const titleAwake = this.hasStartedFlag ? smoothstep(0.0, 0.55, t + 0.25) : 0.0;
    const titlePresence = titleAwake * (1.0 - smoothstep(8.0, 9.6, t));
    const shadowVoid = 0.94 + 0.025 * smoothstep(9.5, 50.0, t);
    const shot1Dark = 1.0 - smoothstep(9.2, 13.5, t);
    // Per-shot ambient haze: each shot is lit by its own motivated lights (lamps, flowers, stage fan);
    // the generic grey haze between them is pulled down so the frame keeps true blacks.
    const topDown = smoothstep(69.2, 71.0, t) * (1.0 - smoothstep(77.0, 78.8, t));
    const ambientKeep = (1.0 - 0.8 * topDown) * keyCurve(t, [
      [0.0, 1.0], [12.0, 0.42], [46.4, 0.42], [50.0, 0.36], [78.6, 0.36], [84.0, 0.45],
      [143.8, 0.45], [150.0, 0.55], [197.8, 0.55], [203.0, 0.34], [243.3, 0.34], [249.0, 0.30], [286.05, 0.30],
    ]);

    // =========================================================================
    // SHOTS 2–4 (0:09.8 ~ 2:23.8): Pure Wire-Free Silk Flowers B (first) -> A & C (~1s delay)
    // =========================================================================
    const retractAtShot5 = 1.0 - smoothstep(141.6, 144.4, t);
    const recapFlowers = story.recap;
    const presB = Math.max(smoothstep(10.6, 12.6, t) * retractAtShot5, recapFlowers * smoothstep(229.6, 230.4, t));
    const presA = Math.max(smoothstep(11.2, 13.3, t) * retractAtShot5, recapFlowers * smoothstep(230.2, 231.0, t));
    const presC = Math.max(smoothstep(11.5, 13.6, t) * retractAtShot5, recapFlowers * smoothstep(230.8, 231.6, t));

    // Rhythmic musical vertical dip synced strictly to Reckoner's bar/downbeat!
    // At the downbeat (`barRad ~ -PI/2` / `cos = -1`), Hero B dips gently toward the water surface
    // and emits THE SINGLE MUSICAL RIPPLE directly underneath `(0.0, +0.75)`!
    const barProgress = (bb.beatInBar - 1 + bb.beatPhase) / 4.0; // 0..1 across each 4-beat bar (2.322s)
    // The per-bar nod (dipPulse) is gone: barProgress wraps from 1 to 0, so it moved the flower 14 cm in
    // a single frame. Only the continuous sway is left for the shots that still use the old motion.
    const gentleSway = Math.sin(barProgress * Math.PI * 2.0) * 0.06;

    const quietTurn = freeze;
    const bobGain = (0.65 + 0.45 * otherEnv + 0.25 * drumsEnv) * (1.0 - freeze);

    const bobB = gentleSway * bobGain;
    const bobA = Math.sin((barProgress - 0.25) * Math.PI * 2.0) * 0.05 * bobGain;
    const bobC = Math.sin((barProgress - 0.30) * Math.PI * 2.0) * 0.05 * bobGain;

    // STRICT MUSICAL RIPPLE DISCIPLINE ("和音乐节奏无关的不要出现涟漪！要么就是灯往下下探了一下产生涟漪"):
    // 1. In Shots 2–4: When Hero B dips down on the musical bar downbeat (`every 2 bars = 4.64s`), emit ONE pure ripple directly beneath B `(0.0, +0.75)`!
    if (presB > 0.55 && t >= S2_END && t < 141.0 && quietTurn < 0.5) {
      if (bb.barIndex !== this.lastDownbeatBar && bb.beatInBar === 1 && bb.beatPhase < 0.35) {
        this.lastDownbeatBar = bb.barIndex;
        if (bb.barIndex % 2 === 1) {
          this.pendingRipples.push({
            worldX: 0.0,
            worldZ: 0.75,
            radiusMeters: 0.40,
            strength: 0.78,
            reason: 'musical-bar-dip-B',
          });
        }
      }
    }
    // 2. In Shot 7 Finale (`t >= 248s`): Serene cathedral heartbeat ripple every 2 bars beneath the Giant Blossom!
    if (shotId === 7 && t >= 248.5 && t <= 281.0) {
      if (bb.barIndex !== this.lastDownbeatBar && bb.beatInBar === 1 && bb.beatPhase < 0.35) {
        this.lastDownbeatBar = bb.barIndex;
        if (bb.barIndex % 2 === 1) {
          this.pendingRipples.push({
            worldX: 0.0,
            worldZ: 0.38,
            radiusMeters: 0.48,
            strength: 0.72,
            reason: 'finale-drum-whisper',
          });
        }
      }
    }

    // 3. In Shots 3–4: When a scheduled 3D bioluminescent ink drop pierces the surface at `birthTime`,
    //    emit ONE clean entry ripple at its exact `(worldX, worldZ)` impact point!
    for (let i = 0; i < this.scheduledBiolumDrops.length; i++) {
      const drop = this.scheduledBiolumDrops[i];
      if (t >= drop.birthTime && t - drop.birthTime < 0.12 && i !== this.lastPlungedInkIdx) {
        this.lastPlungedInkIdx = i;
        this.pendingRipples.push({
          worldX: drop.worldX,
          worldZ: drop.worldZ,
          radiusMeters: 0.38,
          strength: 0.72,
          reason: 'ink-drop-plunge',
        });
      }
    }

    // Shylight Breathing Curve (`Shot 2 Spacebar delayed mirror` vs `Shots 3–4 automatic musical breath`)
    let openB = 0.0;
    let openA = 0.0;
    let openC = 0.0;

    // Shot ②: the flowers breathe by themselves, each on a 5-bar cycle, one bar apart. Bloom, hover and
    // close are three baked clips, each played forward at its own speed.
    const inS2 = t < S2_END;
    // The breath: two automatic ones, then the space key (hold = bloom and hover, let go = close).
    // If nobody presses for ten seconds the flowers take one breath by themselves.
    let userHeld = this.isSpaceDown;
    if (this.autoTap && t >= this.ctlStart) userHeld = (t - this.ctlStart) % 9.2 < 5.2;
    let heldNow = false;
    if (t < this.ctlStart) {
      heldNow = this.driverAt(t);
    } else if (t < this.ctlEnd) {
      if (!userHeld && t >= this.fallbackUntil && t - this.lastHoldEnd > 10.0 && this.isPlaying) {
        this.fallbackUntil = t + clipDuration(CLIP_BLOOM) + 2.3;
      }
      heldNow = userHeld || t < this.fallbackUntil;
      // seen from straight above the flowers always open, B first, A and C a bar and two bars later
      if (t >= 69.6 && t < 75.6) heldNow = true;
    }
    if (t >= this.ctlStart) {
      const last = this.holdLog.length ? this.holdLog[this.holdLog.length - 1].h : false;
      if (heldNow !== last) {
        this.holdLog.push({ t, h: heldNow });
        if (this.holdLog.length > 64) this.holdLog.shift();
        if (!heldNow) this.lastHoldEnd = t;
      }
      if (heldNow) this.lastHoldEnd = t;
    }
    const dtSong = clamp(t - this.breathClock, 0, 0.25);
    this.breathClock = t;
    const landedB = stepBreath(this.breath.B, heldNow, dtSong);
    const landedA = stepBreath(this.breath.A, this.driverAt(t - this.barSec), dtSong);
    const landedC = stepBreath(this.breath.C, this.driverAt(t - 2 * this.barSec), dtSong);
    const hB = breathHeights(S2_FLOWERS.B, this.breath.B);
    const hA = breathHeights(S2_FLOWERS.A, this.breath.A);
    const hC = breathHeights(S2_FLOWERS.C, this.breath.C);
    const inBreath3 = !inS2 && t < 76.5;
    // A and C answer B one and two bars late, so a breath begun near the end of shot ③ is still under
    // way after 76.5 s: each flower finishes the breath it is in before it is handed back.
    const breathBusy = (st: BreathState): boolean => breathDrop01(st) > 0.004 || breathOpen01(st) > 0.02;
    const tail3 = !inS2 && t >= 76.5 && t < 81.5;
    const in3 = {
      B: inBreath3 || (tail3 && breathBusy(this.breath.B)),
      A: inBreath3 || (tail3 && breathBusy(this.breath.A)),
      C: inBreath3 || (tail3 && breathBusy(this.breath.C)),
    };
    if (inS2) {
      openB = hB.open;
      openA = hA.open;
      openC = hC.open;
    } else if (inBreath3) {
      // shot ③ (still the earlier staging): the same breath, in the player's hands
      openB = hB.open;
      openA = hA.open;
      openC = hC.open;
    } else {
      const autoBlend = t > T_FREEZE_IN ? 1.0 : smoothstep(76.5, 78.4, t);
      const climaxBoost = smoothstep(85.6, 88.5, t) * (1.0 - smoothstep(141.0, 145.0, t));

      const phraseBreathB = 0.58 + 0.36 * Math.sin((t - 85.7) * 0.76 + 1.1) + 0.12 * climaxBoost + 0.08 * vocalsEnv;
      const phraseBreathA = 0.55 + 0.35 * Math.sin((t - 86.4) * 0.76 + 1.1) + 0.10 * climaxBoost + 0.07 * vocalsEnv;
      const phraseBreathC = 0.55 + 0.35 * Math.sin((t - 86.6) * 0.76 + 1.1) + 0.10 * climaxBoost + 0.07 * vocalsEnv;

      // From the end of shot ③ to the bass entry the flowers stay shut (they used to open again by
      // themselves, in place, only to close for the held breath; now that opening means falling, a
      // flower that opens without falling looks wrong). Any that is still open closes as it rises.
      const shutUntilFlip = t < T_FLIP;
      const targetAutoB = shutUntilFlip ? 0.10 : clamp01(phraseBreathB * (1.0 - 0.65 * quietTurn)) * retractAtShot5;
      const targetAutoA = shutUntilFlip ? 0.08 : clamp01(phraseBreathA * (1.0 - 0.65 * quietTurn)) * retractAtShot5;
      const targetAutoC = shutUntilFlip ? 0.08 : clamp01(phraseBreathC * (1.0 - 0.65 * quietTurn)) * retractAtShot5;

      openB = clamp01(this.prevBreathB * (1.0 - autoBlend) + targetAutoB * autoBlend);
      openA = clamp01(this.prevBreathA * (1.0 - autoBlend) + targetAutoA * autoBlend);
      openC = clamp01(this.prevBreathC * (1.0 - autoBlend) + targetAutoC * autoBlend);

      // Held breath (78.6..85.7): the flowers close tight and stay there. On the bass entry they burst open.
      if (t > T_FREEZE_IN && t < T_FLIP) {
        // the wind-down: the flowers close slowly from wherever they are (no jump to a fixed pose)
        const hold = smoothstep(T_FREEZE_IN, T_FREEZE_IN + 4.6, t);
        openB = openB + (0.10 - openB) * hold;
        openA = openA + (0.08 - openA) * hold;
        openC = openC + (0.08 - openC) * hold;
      } else if (t >= T_FLIP && t < T_FLIP + 7.0) {
        const age = t - T_FLIP;
        const burst = (1.0 - Math.exp(-age * 9.0)) * Math.exp(-Math.max(0, age - 1.2) * 0.75);
        const settle = smoothstep(0.0, 5.0, age);
        openB = clamp01(0.16 + (openB - 0.16) * settle + burst * (1.0 - 0.16));
        openA = clamp01(0.14 + (openA - 0.14) * settle + burst * (1.0 - 0.14) * smoothstep(0.1, 0.5, age));
        openC = clamp01(0.14 + (openC - 0.14) * settle + burst * (1.0 - 0.14) * smoothstep(0.18, 0.6, age));
      }
      // A breath pushed into the sky (space in the light theatre): quick full bloom of the hero flower.
      const sinceBurst = t - this.bloomBurstAt;
      if (sinceBurst >= 0 && sinceBurst < 2.2) {
        const k = (1.0 - Math.exp(-sinceBurst * 12.0)) * Math.exp(-sinceBurst * 1.9);
        openB = clamp01(openB + (1.0 - openB) * k);
      }
      if (recapFlowers > 0.01) {
        openB = Math.max(openB, 0.88 * recapFlowers);
        openA = Math.max(openA, 0.84 * recapFlowers);
        openC = Math.max(openC, 0.84 * recapFlowers);
      }
    }

    // Spacebar-driven downward breath wind ripples directly underneath B (`(0, +0.75)`), A (`(-2.25, -0.95)`), C (`(+2.25, -0.95)`)!
    const rateB = Math.abs(openB - this.prevBreathB) / Math.max(0.008, dt);
    const rateA = Math.abs(openA - this.prevBreathA) / Math.max(0.008, dt);
    const rateC = Math.abs(openC - this.prevBreathC) / Math.max(0.008, dt);

    const altB = Math.max(0.42, 1.02 + bobB - openB * 0.32);
    const altAC = Math.max(0.65, 1.48 + bobA - openA * 0.26);
    const windForceB = Number((((rateB * 1.4 + openB * 0.4) / (altB * altB)) * presB).toFixed(3));
    const windForceAC = Number((((rateA * 1.1 + openA * 0.3) / (altAC * altAC)) * presA).toFixed(3));

    if (tail3) {
      if (in3.B) openB = hB.open;
      if (in3.A) openA = hA.open;
      if (in3.C) openC = hC.open;
    }
    this.prevBreathB = openB;
    this.prevBreathA = openA;
    this.prevBreathC = openC;

    // =========================================================================
    // SHOTS 3 & 4 (0:46.4 ~ 2:23.8): 3D Underwater Ink Plumes + Mist Caustics + Rising Pearls
    // =========================================================================
    const biolumInkVisibility = smoothstep(46.3, 47.8, t) * (1.0 - smoothstep(86.5, 87.7, t));

    if (this.isSpaceDown && shotId === 4) {
      this.shot4HoldSwirl = clamp01(this.shot4HoldSwirl + dt * 1.1);
    } else {
      this.shot4HoldSwirl = clamp01(this.shot4HoldSwirl - dt * 1.2);
    }
    const swirlGather = 0.0;

    const bassStandingWave =
      smoothstep(85.5, 87.8, t) * (1.0 - smoothstep(142.0, 145.5, t)) * (0.48 + 0.52 * bassEnv);

    const wallCausticShot4 =
      smoothstep(85.6, 89.0, t) * (1.0 - smoothstep(141.5, 146.0, t)) * (0.75 + 0.35 * bassEnv + this.shot4HoldSwirl * 0.3);
    const wallCausticShot7 = smoothstep(248.0, 256.0, t) * (1.0 - smoothstep(277.0, 284.0, t)) * 0.12;
    // The golden sky caustic ribbons read as generic smoke; the motivated shylight glows carry these shots instead.
    const wallCausticIntensity = clamp(wallCausticShot4 * 0.55 + wallCausticShot7, 0, 1.35) * 0.0;

    const antiGravityDropletsIntensity = story.risingPearls;

    // =========================================================================
    // SHOTS 5 & 6 (2:23.8 ~ 4:03.3): Full-Width Water Silk Carpet + Centered Giant Drummer Shadow
    // =========================================================================
    const carpetLevitation = smoothstep(143.8, 150.5, t) * (1.0 - smoothstep(243.0, 251.0, t));
    const shot6Calming = smoothstep(196.5, 202.5, t);
    const carpetWaveActivity = 1.0 - 0.45 * shot6Calming;

    const poolFloorCausticIntensity =
      smoothstep(144.8, 151.5, t) * (1.0 - smoothstep(242.5, 249.5, t)) * (0.82 + 0.28 * otherEnv);

    const drummerPresence = smoothstep(198.0, 199.5, t) * (1.0 - smoothstep(241.0, 244.8, t));
    const timeSinceDrummerStrike =
      this.lastStrikeSongTime > 0 && t >= this.lastStrikeSongTime
        ? t - this.lastStrikeSongTime
        : 999;

    // =========================================================================
    // SHOT 7 (4:03.3 ~ 4:46.05): Giant Pure Silk Flower Facing 100% Straight At Screen!
    // =========================================================================
    const giantPresence = smoothstep(245.2, 252.5, t) * (1.0 - smoothstep(277.6, 280.6, t));
    const codaWindDown = 1.0 - smoothstep(277.5, 285.2, t);
    const giantBreathWave = 0.5 + 0.5 * Math.sin((t - 257.5) * 0.55);
    // Creator: the flower heart faces the camera through the end. Mid-open petals read as a spiky star, so the
    // blossom stays near full bloom and breathes mostly through its light; the coda fades it rather than closing it.
    const giantOpen = clamp01(0.84 + 0.16 * giantBreathWave);
    const giantBobIdle = Math.sin((t - 248.0) * 0.42) * 0.05;
    // Merge: the flower lowers until the waterline cuts it in half; its reflection completes it.
    const giantBob = giantBobIdle * (1.0 - story.merge) - 1.92 * story.merge;
    const mergeShine = story.merge * (0.55 + 0.75 * smoothstep(266.0, 271.5, t)) * (1.0 - smoothstep(276.4, 279.5, t));

    // Constant lush overhead Tyndall sky-theater light curtains (strongest in Shots 4–7)
    const volumetricShaftIntensity =
      (0.45 + carpetLevitation * 0.55 + giantPresence * 0.72 + wallCausticShot4 * 0.35) *
      (1.0 - smoothstep(280.0, 285.8, t));

    const endingBlackout = smoothstep(284.3, 285.9, t);

    // the analog video feedback trail is removed
    const feedbackStrength = 0.0 * vocalsEnv;
    const breathStrength = smoothstep(46.4, 54.0, t) * 0.45 * codaWindDown;

    // No sentences on screen any more: wherever space does something, a small key icon says so.
    const subtlePromptText = '';

    // ---- Story layer: values that depend on the beat grid, the seed, or the player ----
    const fIdx = Math.max(0, Math.min(this.flowIntegral.length - 1.001, t * (this.cues?.envelope.rate || 20)));
    const fI0 = Math.floor(fIdx);
    const flowNow = this.flowIntegral[fI0] + (this.flowIntegral[fI0 + 1] - this.flowIntegral[fI0]) * (fIdx - fI0);
    story.skyFlow = flowNow;
    story.skySwirl = 0.55 * Math.sin(story.fxTime * 0.11) + this.shot4HoldSwirl * 0.9;
    const pitchNow = this.sampleEnvelope('pitch', t);
    this.hueSmooth += (pitchNow - this.hueSmooth) * Math.min(1.0, dt * 2.6);
    story.skyHue = this.hueSmooth * smoothstep(103.5, 107.0, t);
    story.skyGain = 0.72 + 0.42 * bassEnv + 0.22 * Math.exp(-beatAge * 5.0) * drumsEnv + 0.12 * vocalsEnv;

    // Kaleidoscope: on some strong beats a patch of sky folds into mirror symmetry for one beat.
    const kaleidoWindow = smoothstep(104.0, 106.0, t) * (1.0 - smoothstep(140.0, 142.0, t)) + story.recap;
    if (kaleidoWindow > 0.01 && bb.beatInBar === 1 && hEvent < 0.46) {
      // kaleidoscope patches are switched off (too sharp for this piece); shot ④ gets re-planned later
      story.kaleido = 0.0;
      story.kaleidoSeed = hPick;
    }

    // Chapter 3 of the sky show: the whole frame folds into a mandala. The number of mirrors changes on
    // every downbeat, and each beat gives the tunnel a small push.
    {
      const foldIn = smoothstep(114.9, 115.5, t) * (1.0 - smoothstep(128.3, 128.9, t));
      const FOLDS = [6, 8, 5, 12, 7, 10, 6, 9];
      story.foldN = FOLDS[((bb.barIndex % FOLDS.length) + FOLDS.length) % FOLDS.length];
      // each new bar the mirrors open for an instant and close on the new count
      const barAge = (bb.beatInBar - 1 + bb.beatPhase) * beatSec;
      const reopen = 1.0 - 0.55 * Math.exp(-barAge * 7.0);
      // the whole-frame mirror fold is switched off as well
      story.worldFold = 0.0 * foldIn * reopen;
      story.foldSpin = story.fxTime * 0.16 + bb.barIndex * 0.83 + 0.10 * Math.exp(-beatAge * 6.0) * drumsEnv;
      story.rush = Math.min(1, story.rush * (0.7 + 0.5 * Math.exp(-beatAge * 4.0)));
      // the three shadows stand further apart once they are giants
      story.triSpread = (0.055 + 0.05 * drumsEnv + 0.03 * Math.exp(-beatAge * 6.0)) * (1.0 + 0.35 * story.triGiant);
    }

    // Shot 6, second chapter: the drummer plays the backbeat by himself when nobody is hitting,
    // so the stage keeps erupting with the song.
    if (t > 215.5 && t < 241.0 && this.isPlaying) {
      const isBack = bb.beatInBar === 2 || bb.beatInBar === 4;
      if (isBack && globalBeat !== this.lastAutoBeat && bb.beatPhase < 0.3 && t - this.lastStrikeSongTime > 0.3) {
        this.lastAutoBeat = globalBeat;
        this.lastStrikeSongTime = t - bb.beatPhase * beatSec;
        const [cu, cv] = this.latestDrummerImpactUV;
        this.lastStrikeXZ = [(cu - 0.5) * 16.0, -1.2 + (0.5 - cv) * 9.6];
        this.pendingRipples.push({
          worldX: this.lastStrikeXZ[0],
          worldZ: this.lastStrikeXZ[1],
          radiusMeters: 0.5,
          strength: 0.85,
          strikeCarpetUV: [cu, cv],
          reason: 'auto-backbeat',
        });
      }
    }

    // Breath rings in the sky: a quiet automatic one every 4 bars, louder ones from the player.
    const pulses: [number, number, number, number][] = [];
    if (story.skyShow > 0.05 && t > T_FLIP + 2.0) {
      const bar4 = Math.floor((bb.barIndex - 1) / 4);
      const bar4Start = this.beatTimeAt(bar4 * 16);
      const h4 = seededHash(bar4 * 9.17 + this.sessionSeed);
      pulses.push([(h4 - 0.5) * 0.7, 0.62 + 0.3 * seededHash(bar4 * 3.3), t - bar4Start, 0.42]);
    }
    for (const p of this.skyPulseList) {
      const age = t - p.birth;
      if (age >= 0 && age < 9.0) pulses.push([p.x, p.y, age, p.strength]);
    }
    story.skyPulses = pulses;

    // Small shivers of the mirror on random strong beats while the other side grows its own things.
    const shiverWindow = smoothstep(47.0, 50.0, t) * (1.0 - smoothstep(76.0, 78.6, t)) + smoothstep(119.0, 122.0, t) * (1.0 - smoothstep(140.0, 143.0, t));
    if (shiverWindow > 0.01 && strongBeat && hEvent > 0.62) {
      // the red/blue zig-zag shiver of the reflection is removed
      story.reflShiver = 0.0 * shiverWindow;
    }
    // (The on-beat inner-light jump, glowKick, is removed: the inner light follows the breath only.)
    const flipGlow = t >= T_FLIP ? 1.1 * Math.exp(-(t - T_FLIP) * 1.1) : 0.0;
    // Shot ④, first chapter: once the film of light is up behind them the three flowers go dark and stand
    // against it as shapes; their own light comes back when the lens starts forward under them.
    const silhouette4 = smoothstep(88.0, 91.0, t) * (1.0 - smoothstep(99.0, 102.0, t));
    const holdDim = 1.0 - 0.5 * story.windDown;

    // Finale: before the merge the mirrored flower breathes against the real one.
    const antiWave = 1.0 - giantBreathWave;
    const mirrorIndep = smoothstep(248.0, 252.0, t) * (1.0 - story.merge);
    story.mirrorGiant = {
      active: mirrorIndep > 0.01,
      open: clamp01(giantOpen + (0.70 + 0.30 * antiWave - giantOpen) * mirrorIndep),
      glow: ((0.86 + 0.40 * giantBreathWave) * (1.0 - mirrorIndep) + (0.55 + 1.05 * antiWave) * mirrorIndep) * (0.28 + 0.72 * codaWindDown),
      spin: Math.sin((t - 248.0) * 0.16) * 0.18 * (1.0 - 2.0 * mirrorIndep),
    };

    // Drummer: on-beat streaks split the shadow into tape-delay echoes; some strikes flash the lit body.
    const sinceStrike = t - this.lastStrikeSongTime;
    if (sinceStrike > 2.6) this.comboCount = 0;
    const echoTarget = this.comboCount >= 3 && shotId === 6 ? 1.0 : 0.0;
    this.echoLevel += (echoTarget - this.echoLevel) * Math.min(1.0, dt * (echoTarget > this.echoLevel ? 5.0 : 1.4));
    story.drummerEcho = Math.max(this.echoLevel, story.recap * 0.9) * drummerPresence;
    const sinceReveal = t - this.revealAt;
    // the one-frame flash of the lit body is removed
    story.drummerReveal = 0.0 * sinceReveal;

    const drummerRigPresence = Math.max(drummerPresence, story.shadowPass);
    const tealLeak = smoothstep(198.3, 199.0, t) * (1.0 - smoothstep(243.0, 247.0, t));

    // =========================================================================
    // SHOT ② (Deakins version): cue drops, resonance, standing wave, surge
    // =========================================================================
    // the nave comes up out of the dark only after the earlier room has gone (see main.ts): 9.5 to 12 s
    const look = inS2 ? smoothstep(9.5, 12.0, t) : 0.0;
    const bp = this.beatPos(t);
    const s2Poses: Partial<Record<'B' | 'A' | 'C', ShylightUnitPose>> = {};
    const s2Drops: { x: number; y: number; z: number; a: number }[] = [];
    // Shot ③ layout: the flower falls as it opens, as in shot ②. From 76.5 to 81.5 s the height is handed back
    // to the earlier fixed positions (legacyY = build height - 0.26 * open + bob), without a jump.
    const lay3 = (k: 'B' | 'A' | 'C', buildY: number, open: number, bob: number): ShylightUnitPose['layout'] => {
      if (inS2 || t >= 81.5) return undefined;
      const f = S3_FLOWERS[k];
      const fallY = f.topY - breathDrop01(this.breath[k]) * f.dropM;
      const legacyY = buildY - 0.26 * open + bob;
      const back = smoothstep(76.5, 81.5, t);
      return { x: f.x, topY: fallY + (legacyY - fallY) * back, z: f.z, scale: f.scale, dropMeters: 0, drop01: 0 };
    };
    let s2Mirror: ShylightUnitPose | null = null;
    if (inS2) {
      // Each bud arrives dark and then catches like an ember: the light comes up a moment after the
      // shape, flares slightly, and settles. (This replaces the three glowing balls.)
      const kindle = (a: number): number =>
        smoothstep(a + 0.5, a + 2.2, t) * (1.0 + 0.9 * Math.exp(-Math.pow((t - (a + 2.3)) / 0.7, 2.0)));
      const mk = (f: S2Flower, st: BreathState, pres: number, h: { open: number }): ShylightUnitPose => ({
        presence: pres,
        openAmount: h.open,
        bobOffsetMeters: 0,
        // the inner light is the breath: an ember while closed, full when open. It follows the fall
        // (about a second) rather than the ribs, which snap open in half that time.
        // (closed, the bud is nearly a silhouette against the lit air: the light is what the opening brings)
        glowIntensity: (0.13 + 1.19 * smoothstep(0.0, 1.0, breathDrop01(st))) * kindle(f === S2_FLOWERS.B ? 10.6 : f === S2_FLOWERS.A ? 11.2 : 11.5),
        clip: breathClip(st),
        layout: { x: f.x, topY: f.topY, z: f.z, scale: f.scale, dropMeters: f.dropM, drop01: breathDrop01(st) },
        cable: 1,
      });
      s2Poses.B = mk(S2_FLOWERS.B, this.breath.B, presB, hB);
      s2Poses.A = mk(S2_FLOWERS.A, this.breath.A, presA, hA);
      s2Poses.C = mk(S2_FLOWERS.C, this.breath.C, presC, hC);

      // each landing sends a ring out from the flower's foot; B's carries colour if the press was on a strong beat
      const land = (f: S2Flower, hit: boolean, main: boolean) => {
        if (!hit || !this.isPlaying) return;
        const iris = main && this.pendingIris ? 1.0 : 0.0;
        if (main) this.pendingIris = false;
        this.pendingRipples.push({
          worldX: f.x, worldZ: f.z, radiusMeters: main ? 0.5 : 0.34, strength: main ? 1.0 : 0.6,
          reason: 'breath-landing', fx: { iris, decay: iris > 0 ? 0.42 : 0.7, k: 0.85, grow: iris > 0 ? 1.35 : 1.0 },
        });
      };
      land(S2_FLOWERS.B, landedB, true);
      land(S2_FLOWERS.A, landedA, false);
      land(S2_FLOWERS.C, landedC, false);

      // Cue drops: a bead runs down the cable, leaves the lowest tip and meets the water exactly on a beat.
      // B drips on every strong beat (that is where the player's ring appears); A and C on every other one.
      const dropsOn = (key: 'B' | 'A' | 'C', i: number): boolean =>
        key === 'B' ? ((i % 2) + 2) % 2 === 0 : key === 'A' ? ((i % 4) + 4) % 4 === 2 : ((i % 4) + 4) % 4 === 0;
      const pres: Record<'B' | 'A' | 'C', number> = { B: presB, A: presA, C: presC };
      const iNow = Math.floor(bp);
      for (const key of ['B', 'A', 'C'] as const) {
        const f = S2_FLOWERS[key];
        if (pres[key] < 0.6) continue;
        for (let i = iNow; i <= iNow + 4; i++) {
          if (!dropsOn(key, i)) continue;
          const tLand = this.beatTimeAt(i);
          if (tLand < 13.2 || tLand > S2_END) continue;
          // release time from the height the tip is at now (the flower follows the player, so its future is not known)
          const hNow = key === 'B' ? hB : key === 'A' ? hA : hC;
          const tipY = Math.max(0.02, hNow.tipY);
          const tRel = tLand - Math.sqrt((2 * tipY) / DROP_G);
          if (t >= tRel && t < tLand) {
            const dtf = t - tRel;
            s2Drops.push({ x: f.x, y: Math.max(0, tipY - 0.5 * DROP_G * dtf * dtf), z: f.z, a: 1.0 });
          } else if (t >= tRel - 1.25 && t < tRel - 0.22) {
            // sliding down the cable toward the hub (it then passes through the flower unseen)
            const u = (t - (tRel - 1.25)) / 1.03;
            const hub = hNow.hubY;
            s2Drops.push({ x: f.x, y: hub + 0.04 + (1 - u) * (1 - u) * 2.6, z: f.z, a: 0.55 * smoothstep(0.0, 0.25, u) });
          }
        }
        // landing: one small ring under the flower, on the beat
        if (this.isPlaying && iNow !== this.lastDropBeat && dropsOn(key, iNow)) {
          const tLand = this.beatTimeAt(iNow);
          if (tLand >= 13.2 && t - tLand < 0.2) {
            this.pendingRipples.push({
              worldX: f.x, worldZ: f.z, radiusMeters: 0.2, strength: key === 'B' ? 0.34 : 0.26,
              reason: `cue-drop-${key}`, fx: { iris: 0, decay: 1.5, k: 1.25, grow: 0.8 },
            });
          }
        }
      }
      if (this.isPlaying && iNow !== this.lastDropBeat) {
        this.lastDropBeat = iNow;
      }
    }

    // shot ③: the same landings, at the earlier flower positions
    if ((inBreath3 || tail3) && this.isPlaying) {
      // each landing sends out a ring and lets a plume of ink go into the water under the flower:
      // in shot ② the vault answers a breath, here the deep does
      const land3 = (k: 'B' | 'A' | 'C') => {
        const f = S3_FLOWERS[k];
        const main = k === 'B';
        this.pendingRipples.push({ worldX: f.x, worldZ: f.z, radiusMeters: main ? 0.46 : 0.36, strength: main ? 0.95 : 0.6, reason: 'breath-landing' });
        this.pushBreathInk(k, t);
        this.mergeInk();
      };
      if (landedB) {
        land3('B');
        this.pendingIris = false;
      }
      if (landedA) land3('A');
      if (landedC) land3('C');
    }

    // Resonance fades slowly once the player stops landing on the beat.
    if (t - this.lastOnBeatAt > 14.0) this.resonance *= Math.exp(-dt / 9.0);
    if (!inS2 && !inBreath3) this.resonance = 0;
    this.resonanceSmooth += (this.resonance - this.resonanceSmooth) * (1 - Math.exp(-dt / 0.45));
    // Drum stem, smoothed so the pattern swells instead of twitching (0.1 s up, 0.5 s down).
    this.drumDrive += (drumsEnv - this.drumDrive) * (1 - Math.exp(-dt / (drumsEnv > this.drumDrive ? 0.1 : 0.5)));
    this.otherSlow += (otherEnv - this.otherSlow) * (1 - Math.exp(-dt / 1.2));
    let surge = 0;
    if (inS2) {
      for (const [ht, hs] of this.strongHits) {
        if (ht > t) break;
        if (t - ht < 1.4) surge = Math.max(surge, surgeEnvelope(t - ht) * hs);
      }
    }
    const patIn = smoothstep(12.6, 16.0, t);
    // Columns: the trunk rises with the first breath, then one generation of branches every four bars.
    let columnGrow = 0;
    for (let k = 0; k < 4; k++) {
      const tk = this.beatTimeAt(S2_FLOWERS.B.firstLandBeat + 16 * k) - 1.2;
      columnGrow += 0.25 * smoothstep(tk, tk + 3.4, t);
    }
    columnGrow = inS2 ? Math.min(1, columnGrow + 0.12 * this.resonanceSmooth) : 0;
    // Veins under the water (shot ③): one generation with each sung line; every landing of a breath
    // pushes them a little further.
    const veinBase =
      0.34 * smoothstep(46.6, 55.5, t) + 0.33 * smoothstep(57.5, 66.5, t) + 0.33 * smoothstep(69.3, 77.5, t);
    if (inBreath3 && landedB) this.veinBonus = Math.min(0.3, this.veinBonus + 0.06);
    if (!inBreath3) this.veinBonus = 0;
    const veinGrow = Math.min(1, veinBase + this.veinBonus);
    // the light veins under the water are switched off (too busy)
    const veinLevel = 0.0 * smoothstep(46.6, 48.5, t);
    // next strong beat: the ring closes on B's foot over the last second before it
    const iCue = 2 * Math.ceil(bp / 2);
    const tCue = this.beatTimeAt(iCue);
    const cueOn = inS2 && tCue >= 13.2 && tCue < S2_END;
    const shot2: Shot2State = {
      look,
      resonance: this.resonanceSmooth,
      patCentre: [S2_FLOWERS.B.x, S2_FLOWERS.B.z],
      // seven parts music, three parts playing
      patAmp: look * patIn * (0.42 + 0.28 * this.drumDrive + 0.30 * this.resonanceSmooth),
      patRadius: 3.1 + 2.4 * this.resonanceSmooth,
      patPhase: Math.PI * bp,
      surge,
      otherSlow: this.otherSlow,
      columnGrow,
      veinGrow,
      veinLevel,
      // (the closing ring that cued every strong beat is gone: the breath is held, not tapped)
      cue: { x: S2_FLOWERS.B.x, z: S2_FLOWERS.B.z, toLand: tCue - t, strength: 0 * (cueOn ? 1 : 0) },
      drops: s2Drops,
      mirrorB: s2Mirror,
      // (the lamp that glided across the far end of the nave in the second half of the shot is removed:
      //  2026-11-16, the user found a moving lamp there odd; level is held at 0)
      sweep: {
        x: -10.5 + 21.0 * smoothstep(28.5, 47.0, t) * 0.5 + 21.0 * 0.5 * clamp01((t - 28.5) / 18.5),
        y: 2.5 + 0.25 * Math.sin((t - 28.5) * 0.35),
        z: -35.0,
        level: 0,
      },
      wallShadows: inS2
        ? [{
            x: S2_FLOWERS.B.x,
            hubY: hB.hubY,
            z: S2_FLOWERS.B.z,
            open: hB.open,
            scale: S2_FLOWERS.B.scale,
            level: look * presB * smoothstep(12.5, 15.0, t) * (0.10 + 0.90 * smoothstep(0.0, 1.0, breathDrop01(this.breath.B))),
          }]
        : [],
    };

    // ---- space-key hint (shots ②, ④, ⑥) ----
    const spaceHint: ChoreographySnapshot['spaceHint'] = { show: 0, toBeat: -1, pulse: 0, down: this.isSpaceDown, mode: 'none', label: '' };
    if (this.hasStartedFlag) {
      const fade = (a: number, b: number) => smoothstep(a, a + 1.0, t) * (1.0 - smoothstep(b - 1.0, b, t));
      const strongNext = this.beatTimeAt(2 * Math.ceil(bp / 2)) - t;
      const strongAge = t - this.beatTimeAt(2 * Math.floor(bp / 2));
      if (t > this.ctlStart - 0.6 && t < this.ctlEnd) {
        // the key is offered once the two automatic breaths are over
        spaceHint.show = fade(this.ctlStart - 0.6, this.ctlEnd) * (this.userHolds >= 3 ? 0.45 : 1.0);
        spaceHint.toBeat = this.isSpaceDown ? -1 : strongNext;
        spaceHint.pulse = 0.55 * surgeEnvelope(strongAge);
        spaceHint.mode = 'hold';
        spaceHint.label = '长按';
      } else if (t > T_FLIP + 0.6 && t < 141.5) {
        spaceHint.show = fade(T_FLIP + 0.6, 141.5) * (this.skyPulseCount >= 2 ? 0.35 : 1.0);
        spaceHint.pulse = 0.5 + 0.5 * Math.sin(t * 1.1);
        spaceHint.mode = 'tap';
        spaceHint.label = '轻点';
      } else if (t > 199.5 && t < 241.0) {
        spaceHint.show = fade(199.5, 241.0) * (this.strikeCounter >= 4 ? 0.35 : 1.0);
        spaceHint.toBeat = strongNext;
        spaceHint.pulse = surgeEnvelope(strongAge);
        spaceHint.mode = 'tap';
        spaceHint.label = '轻点';
      }
    }

    const emitted = this.pendingRipples.slice();
    this.pendingRipples.length = 0;

    return {
      time: t,
      duration: this.duration,
      hasStarted: this.hasStartedFlag,
      playing: this.isPlaying,
      playbackRate: this.playbackSpeed,
      shotId,
      shotLabel: shotWin.label,
      barIndex: bb.barIndex,
      beatInBar: bb.beatInBar,
      beatPhase: Number(bb.beatPhase.toFixed(3)),
      beatSec,

      drumsEnv: Number(drumsEnv.toFixed(3)),
      bassEnv: Number(bassEnv.toFixed(3)),
      vocalsEnv: Number(vocalsEnv.toFixed(3)),
      otherEnv: Number(otherEnv.toFixed(3)),

      shadowVoid: Number(shadowVoid.toFixed(3)),
      shot1Dark: Number(shot1Dark.toFixed(3)),
      ambientKeep: Number(ambientKeep.toFixed(3)),
      titlePresence: Number(titlePresence.toFixed(3)),
      balatroSwirlAmount: Number(balatroSwirlAmount.toFixed(3)),
      wallCausticIntensity: Number(wallCausticIntensity.toFixed(3)),
      poolFloorCausticIntensity: Number(poolFloorCausticIntensity.toFixed(3)),
      antiGravityDropletsIntensity: Number(antiGravityDropletsIntensity.toFixed(3)),
      volumetricShaftIntensity: Number(volumetricShaftIntensity.toFixed(3)),
      endingBlackout: Number(endingBlackout.toFixed(3)),

      shylightB: s2Poses.B ?? {
        layout: lay3('B', 2.74, openB, bobB + 1.25 * recapFlowers + 0.42 * story.windDown),
        presence: presB,
        openAmount: openB,
        // in the recap over the water carpet the flowers hang above the crests instead of standing in them
        // (they also draw upward during the wind-down before the bass)
        bobOffsetMeters: bobB + 1.25 * recapFlowers + 0.42 * story.windDown,
        glowIntensity: (0.96 + 0.24 * openB + flipGlow) * holdDim * (1.0 - 0.9 * silhouette4),
        clip: in3.B ? breathClip(this.breath.B) : undefined,
        // the trio hangs from cables in every shot it appears in, not only in shot ②
        cable: 1,
      },
      shylightA: s2Poses.A ?? {
        layout: lay3('A', 2.94, openA, bobA + 1.15 * recapFlowers + 0.34 * story.windDown),
        presence: presA,
        openAmount: openA,
        bobOffsetMeters: bobA + 1.15 * recapFlowers + 0.34 * story.windDown,
        glowIntensity: (0.90 + 0.22 * openA + flipGlow * 0.8) * holdDim * (1.0 - 0.9 * silhouette4),
        clip: in3.A ? breathClip(this.breath.A) : undefined,
        // the trio hangs from cables in every shot it appears in, not only in shot ②
        cable: 1,
      },
      shylightC: s2Poses.C ?? {
        layout: lay3('C', 2.94, openC, bobC + 1.15 * recapFlowers + 0.34 * story.windDown),
        presence: presC,
        openAmount: openC,
        bobOffsetMeters: bobC + 1.15 * recapFlowers + 0.34 * story.windDown,
        glowIntensity: (0.90 + 0.22 * openC + flipGlow * 0.8) * holdDim * (1.0 - 0.9 * silhouette4),
        clip: in3.C ? breathClip(this.breath.C) : undefined,
        // the trio hangs from cables in every shot it appears in, not only in shot ②
        cable: 1,
      },
      shylightGiant: {
        presence: giantPresence,
        openAmount: giantOpen,
        bobOffsetMeters: giantBob,
        glowIntensity: (0.86 + 0.40 * giantBreathWave + mergeShine) * (0.28 + 0.72 * codaWindDown),
        spinRad: Math.sin((t - 248.0) * 0.16) * 0.18,
      },
      windForceB,
      windForceAC,

      biolumInkVisibility: Number(biolumInkVisibility.toFixed(3)),
      biolumDrops: this.inkAll,
      swirlGather: Number(swirlGather.toFixed(3)),
      bassStandingWave: Number(bassStandingWave.toFixed(3)),
      carpetLevitation: Number(carpetLevitation.toFixed(3)),
      carpetWaveActivity: Number(carpetWaveActivity.toFixed(3)),

      drummerPresence: Number(drummerPresence.toFixed(3)),
      timeSinceDrummerStrike: Number(timeSinceDrummerStrike.toFixed(3)),
      drummerStrikeCount: this.strikeCounter,

      feedbackStrength: Number(feedbackStrength.toFixed(3)),
      breathStrength: Number(breathStrength.toFixed(3)),

      subtlePromptText,
      isSpaceHeld: this.isSpaceDown,
      triggeredRipples: emitted,

      story,
      drummerRigPresence,
      tealLeak,
      shot2,
      topDown,
      flowerSilhouette: silhouette4,
      spaceHint,
    };
  }
}
