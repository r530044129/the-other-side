/**
 * Shot ② (0:10–0:46), Deakins version. Everything here is a pure function of song time so that
 * seeking stays deterministic. Spec: 11_狄金斯方向改动清单_v2.md.
 *
 * The flower uses the re-baked model shylight_three_clips.glb: three clips that join without a fade,
 *   bloom  2.333 s   bud -> full bloom (falls, opens because of the fall, overshoots, settles)
 *   hover  4.625 s   one slow breath, loops
 *   close  3.500 s   full bloom -> bud (rises while folding; ends at rest)
 * Each clip is only ever played forward at its own speed. The bud pause is the last frame of close.
 * Per-frame fall and rib angle come from shylight_three_clips.json (24 fps tables).
 */

export const S2_START = 9.8;
export const S2_END = 46.4;

export const CLIP_BLOOM = 0;
export const CLIP_HOVER = 1;
export const CLIP_CLOSE = 2;
export const CLIP_NAMES = ['bloom', 'hover', 'close'] as const;

interface ClipTable {
  duration: number;
  /** Fall of the hub per frame, 0 = bud height, 1 = hover height (overshoot goes slightly above 1). */
  drop: number[];
  /** Rib opening per frame, 0 = bud, 1 = full bloom. */
  open: number[];
}
const FPS = 24;
// Fallback shapes until the JSON is loaded (same durations, straight ramps).
let TABLES: ClipTable[] = [
  { duration: 56 / FPS, drop: [0, 1], open: [0, 1] },
  { duration: 111 / FPS, drop: [1, 1], open: [1, 1] },
  { duration: 84 / FPS, drop: [1, 0], open: [1, 0] },
];
/** Time inside bloom at which the flower reaches its lowest point; this is what lands on the beat. */
export let BLOOM_BOTTOM_T = 1.667;

/** Feed the tables exported next to the model (public/models/shylight_three_clips.json). */
export function setClipData(json: {
  clips: Record<string, { duration_s: number; hub_drop_m_per_frame: number[]; rib_angle_deg_per_frame: number[] }>;
}): void {
  const hoverDrop = json.clips.hover.hub_drop_m_per_frame[0];
  const ribs = json.clips.bloom.rib_angle_deg_per_frame;
  const rib0 = ribs[0];
  const rib1 = ribs[ribs.length - 1];
  TABLES = CLIP_NAMES.map((name) => {
    const c = json.clips[name];
    return {
      duration: c.duration_s,
      drop: c.hub_drop_m_per_frame.map((d) => d / hoverDrop),
      open: c.rib_angle_deg_per_frame.map((r) => (r - rib0) / (rib1 - rib0)),
    };
  });
  const bd = TABLES[CLIP_BLOOM].drop;
  let iMax = 0;
  for (let i = 1; i < bd.length; i++) if (bd[i] > bd[iMax]) iMax = i;
  BLOOM_BOTTOM_T = iMax / FPS;
}

export function clipDuration(clip: number): number {
  return TABLES[clip].duration;
}

/** One flower of the trio in shot ②: where it hangs, how far it falls, which beat it first lands on. */
export interface S2Flower {
  x: number;
  z: number;
  /** Hub height while closed (m). */
  topY: number;
  /** How far the hub falls from bud to hover (m). */
  dropM: number;
  scale: number;
  /** Tracked-beat index on which it first reaches its lowest point; later ones follow every cycle. */
  firstLandBeat: number;
}

/**
 * Near / middle / far, low / middle / high. B is the hero on the left third and falls almost to the
 * water; A and C hang deeper in the nave and stop higher. They land one bar apart (B, A, C).
 */
export const S2_FLOWERS: Record<'B' | 'A' | 'C', S2Flower> = {
  B: { x: -1.2, z: 1.5, topY: 2.2, dropM: 1.50, scale: 1.3, firstLandBeat: 24 },
  A: { x: 0.85, z: -2.6, topY: 3.0, dropM: 1.55, scale: 1.3, firstLandBeat: 28 },
  C: { x: -1.0, z: -7.6, topY: 4.15, dropM: 1.55, scale: 1.3, firstLandBeat: 32 },
};
/**
 * Shot ③ (the earlier room): the same breath, the same fall. These flowers are twice the size of
 * shot ②'s, so they start higher; in bloom the lowest silk hangs 0.35 m (B) and 0.55 m (A, C) over the water.
 */
export const S3_FLOWERS: Record<'B' | 'A' | 'C', S2Flower> = {
  B: { x: 0.0, z: 0.85, topY: 3.05, dropM: 1.58, scale: 2.65, firstLandBeat: 0 },
  A: { x: -2.25, z: -0.95, topY: 3.15, dropM: 1.7, scale: 2.15, firstLandBeat: 0 },
  C: { x: 2.25, z: -0.95, topY: 3.15, dropM: 1.7, scale: 2.15, firstLandBeat: 0 },
};
/**
 * 5 bars. The baked clips add up to 4.5 bars (1 + 2 + 1.5), so a 4-bar cycle would mean cutting the
 * hover in half; 5 bars plays all three whole and leaves about a second of closed bud.
 */
export const S2_CYCLE_BEATS = 20;
export const S2_HOVER_LOOPS = 1;

/** Nave of catenary arches behind the flowers: origin on the water, axis yawed toward +x. */
export const S2_NAVE = { x: 2.0, z: 0.0, yaw: 0.19 };

export interface ClipSample {
  /** CLIP_BLOOM, CLIP_HOVER or CLIP_CLOSE. */
  clip: number;
  /** Seconds into that clip. */
  t: number;
}

/** Clip position tau seconds after the bloom started (negative = still a bud). */
export function clipAtTau(tau: number): ClipSample {
  const tb = TABLES[CLIP_BLOOM].duration;
  const th = TABLES[CLIP_HOVER].duration;
  const tc = TABLES[CLIP_CLOSE].duration;
  if (tau < 0) return { clip: CLIP_CLOSE, t: tc };
  if (tau < tb) return { clip: CLIP_BLOOM, t: tau };
  const h = tau - tb;
  if (h < th * S2_HOVER_LOOPS) return { clip: CLIP_HOVER, t: h % th };
  return { clip: CLIP_CLOSE, t: Math.min(tc, h - th * S2_HOVER_LOOPS) };
}

/** landTimes = the moments the flower is at its lowest; the bloom starts BLOOM_BOTTOM_T before each. */
export function clipForFlower(t: number, landTimes: number[]): ClipSample {
  let tau = -1;
  for (let i = 0; i < landTimes.length; i++) {
    const start = landTimes[i] - BLOOM_BOTTOM_T;
    if (t >= start) tau = t - start;
    else break;
  }
  return clipAtTau(tau);
}

function table(arr: number[], t: number): number {
  const f = Math.max(0, Math.min(arr.length - 1, t * FPS));
  const i = Math.min(arr.length - 2, Math.floor(f));
  if (i < 0) return arr[0];
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}

/** 0 = hub at bud height, 1 = hub at hover height. */
export function clipDrop01(s: ClipSample): number {
  return table(TABLES[s.clip].drop, s.t);
}
/** 0 = closed bud, 1 = full bloom. */
export function clipOpen01(s: ClipSample): number {
  return Math.max(0, Math.min(1, table(TABLES[s.clip].open, s.t)));
}

/**
 * A flower's breath as the player (or the piece itself) drives it: while 'held' it blooms and then
 * hovers; when let go it closes. All three clips only ever run forward. Changing one's mind mid-way
 * (letting go during the fall, pressing again during the rise) jumps to the other clip at the same
 * hub height and cross-fades the cloth over a third of a second.
 */
export interface BreathState {
  clip: number;
  t: number;
  /** Pose being faded out after a change of mind. */
  from: ClipSample | null;
  /** 0..1 progress of that fade. */
  fade: number;
}
export function newBreath(): BreathState {
  return { clip: CLIP_CLOSE, t: 1e3, from: null, fade: 1 };
}
const BREATH_FADE = 0.32;

/** Time inside bloom (falling part) or close at which the hub is at drop d. */
function timeForDrop(clip: number, d: number): number {
  const arr = TABLES[clip].drop;
  if (clip === CLIP_BLOOM) {
    const iEnd = Math.round(BLOOM_BOTTOM_T * FPS);
    for (let i = 1; i <= iEnd && i < arr.length; i++) {
      if (arr[i] >= d) return (i - 1 + (d - arr[i - 1]) / Math.max(1e-6, arr[i] - arr[i - 1])) / FPS;
    }
    return BLOOM_BOTTOM_T;
  }
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] <= d) return (i - 1 + (arr[i - 1] - d) / Math.max(1e-6, arr[i - 1] - arr[i])) / FPS;
  }
  return TABLES[clip].duration;
}

/** Advance one flower. Returns true on the step in which it reaches the bottom of its fall. */
export function stepBreath(s: BreathState, held: boolean, dt: number): boolean {
  const tb = TABLES[CLIP_BLOOM].duration;
  const th = TABLES[CLIP_HOVER].duration;
  const tc = TABLES[CLIP_CLOSE].duration;
  if (held && s.clip === CLIP_CLOSE) {
    if (s.t >= tc - 1e-3) {
      s.clip = CLIP_BLOOM;
      s.t = 0;
      s.from = null;
      s.fade = 1;
    } else {
      const d = clipDrop01(s);
      s.from = { clip: s.clip, t: s.t };
      s.clip = CLIP_BLOOM;
      s.t = timeForDrop(CLIP_BLOOM, d);
      s.fade = 0;
    }
  } else if (!held && s.clip === CLIP_BLOOM) {
    const d = Math.min(1, clipDrop01(s));
    s.from = { clip: s.clip, t: s.t };
    s.clip = CLIP_CLOSE;
    s.t = timeForDrop(CLIP_CLOSE, d);
    s.fade = 0;
  } else if (!held && s.clip === CLIP_HOVER) {
    s.from = { clip: s.clip, t: s.t };
    s.clip = CLIP_CLOSE;
    s.t = 0;
    s.fade = 0;
  }
  let landed = false;
  if (s.clip === CLIP_BLOOM) {
    const t0 = s.t;
    s.t += dt;
    if (t0 < BLOOM_BOTTOM_T && s.t >= BLOOM_BOTTOM_T) landed = true;
    if (s.t >= tb) {
      s.clip = CLIP_HOVER;
      s.t -= tb;
    }
  } else if (s.clip === CLIP_HOVER) {
    s.t = (s.t + dt) % th;
  } else {
    s.t = Math.min(tc, s.t + dt);
  }
  if (s.fade < 1) {
    s.fade = Math.min(1, s.fade + dt / BREATH_FADE);
    if (s.fade >= 1) s.from = null;
  }
  return landed;
}

/** Weight of the outgoing pose (1 right after a change of mind, 0 once the fade is done). */
export function breathFromWeight(s: BreathState): number {
  if (!s.from) return 0;
  const u = 1 - s.fade;
  return u * u * (3 - 2 * u);
}
export function breathDrop01(s: BreathState): number {
  const w = breathFromWeight(s);
  return w > 0 && s.from ? clipDrop01(s) * (1 - w) + clipDrop01(s.from) * w : clipDrop01(s);
}
export function breathOpen01(s: BreathState): number {
  const w = breathFromWeight(s);
  return w > 0 && s.from ? clipOpen01(s) * (1 - w) + clipOpen01(s.from) * w : clipOpen01(s);
}
/** The clip sample to hand to the flower, with the outgoing pose when a fade is running. */
export function breathClip(s: BreathState): { clip: number; t: number; from?: { clip: number; t: number; w: number } } {
  const w = breathFromWeight(s);
  return w > 0 && s.from ? { clip: s.clip, t: s.t, from: { clip: s.from.clip, t: s.from.t, w } } : { clip: s.clip, t: s.t };
}
/** World height of the hub and of the lowest silk tip for a breathing flower in shot ②'s layout. */
export function breathHeights(f: S2Flower, s: BreathState): { hubY: number; tipY: number; open: number } {
  const open = breathOpen01(s);
  const hubY = f.topY - breathDrop01(s) * f.dropM;
  const tipY = hubY + (-0.446 + 0.056 * open) * rigAspect(open) * f.scale;
  return { hubY, tipY, open };
}

/** Vertical stretch the rig applies (matches shylight.ts): slender when closed. */
export function rigAspect(open01: number): number {
  return 1.22 + (1.08 - 1.22) * open01;
}

/** World height of the hub and of the lowest silk tip for a flower at clip sample s. */
export function flowerHeights(f: S2Flower, s: ClipSample): { hubY: number; tipY: number; open: number } {
  const open = clipOpen01(s);
  const hubY = f.topY - clipDrop01(s) * f.dropM;
  // lowest silk below the hub, in rig units: -0.446 as a bud, -0.39 in bloom (model v2; the first model was -0.276)
  const rimY = -0.446 + 0.056 * open;
  const tipY = hubY + rimY * rigAspect(open) * f.scale;
  return { hubY, tipY, open };
}

/** Gravity used for the cue drops (slightly slower than real so the fall can be read). */
export const DROP_G = 7.2;

/**
 * "Surge": how light answers a drum hit in this shot. Rises in 0.1 s, falls over about half a second.
 * age = seconds since the hit.
 */
export function surgeEnvelope(age: number): number {
  if (age <= 0) return 0;
  if (age < 0.1) {
    const u = age / 0.1;
    return u * u * (3 - 2 * u);
  }
  return Math.exp(-(age - 0.1) / 0.2);
}

/**
 * Shared fog for the Deakins set (sky dome, far water, arches, lamps). Warm near-black air that
 * thickens toward the horizon, and one very weak top light: a mass of lit haze high in the last bays
 * of the nave, which is what the arches are silhouetted against.
 * Requires uniforms: uDkAxis (unit vector toward the nave's vanishing point), uDkTop.
 */
export const DK_FOG_GLSL = /* glsl */ `
  uniform vec3 uDkAxis;
  uniform float uDkTop;
  vec3 dkFog(vec3 dir) {
    float elev = max(dir.y, 0.0);
    vec3 flatDir = normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-5));
    float az = max(0.0, dot(flatDir, uDkAxis));
    float band = exp(-pow(elev / 0.20, 1.4));
    vec3 col = vec3(0.0015, 0.0012, 0.0010) * (0.30 + 1.70 * band);
    // top light: brightest a little above the horizon at the far end of the nave
    float lift = exp(-((elev - 0.11) / 0.16) * ((elev - 0.11) / 0.16));
    float core = pow(az, 30.0) * lift;
    float wide = pow(az, 5.0) * exp(-pow(elev / 0.30, 2.0));
    col += (vec3(0.021, 0.0155, 0.010) * core + vec3(0.0036, 0.0028, 0.0019) * wide) * uDkTop;
    return col;
  }
`;

/**
 * Standing-wave pattern of the water in shot ② (shared by the water itself and by the vaults that
 * catch its reflected light). Requires uniforms: uPat (xy centre, z amplitude, w radius), uPatMode
 * (x resonance 0..1, y phase).
 */
export const PAT_GLSL = /* glsl */ `
  // Standing waves (cymatics): fixed cells in which the surface itself rises and falls. Rings on the
  // beat, petals between beats; resonance (uPatMode.x) brings in higher angular orders. foot = metres
  // per pixel, so that orders finer than the pixel grid fade instead of shimmering.
  float patHeight(vec2 q, float foot) {
    float r = length(q) + 1e-4;
    float th = atan(q.y, q.x);
    float res = uPatMode.x;
    float c = cos(uPatMode.y);
    float s = sin(uPatMode.y);
    float env = exp(-(r * r) / (uPat.w * uPat.w));
    float att = 1.0 / sqrt(1.0 + r * 0.8);
    const float K0 = 7.0;
    float aa0 = 1.0 - smoothstep(0.22, 0.48, foot * K0 / 6.2832);
    float aa1 = 1.0 - smoothstep(0.22, 0.48, foot * K0 * 1.9 / 6.2832);
    float aa2 = 1.0 - smoothstep(0.22, 0.48, foot * K0 * 2.5 / 6.2832);
    float h = cos(r * K0 - 0.7) * c * aa0;
    h += 0.55 * cos(r * K0 * 0.62 + 1.1) * s;
    float w6 = 0.20 + 0.80 * smoothstep(0.04, 0.38, res);
    h += w6 * 0.85 * cos(th * 6.0) * cos(r * K0 * 1.27 + 0.4) * s * smoothstep(0.15, 1.0, r) * aa0;
    float w12 = smoothstep(0.28, 0.68, res);
    h += w12 * 0.75 * cos(th * 12.0 + 0.6) * cos(r * K0 * 1.9 - 0.9) * c * smoothstep(0.5, 1.6, r) * aa1;
    float w18 = smoothstep(0.58, 1.0, res);
    h += w18 * 0.65 * cos(th * 18.0) * cos(r * K0 * 2.5 + 0.2) * s * smoothstep(0.9, 2.2, r) * aa2;
    return h * env * att;
  }

  // Curvature of the same surface (what gathers or spreads reflected light), in one evaluation: each
  // mode's curvature is its own wavenumber squared times the mode. Used for the light on the vaults.
  float patLap(vec2 q) {
    float r = length(q) + 1e-4;
    float th = atan(q.y, q.x);
    float res = uPatMode.x;
    float c = cos(uPatMode.y);
    float s = sin(uPatMode.y);
    float env = exp(-(r * r) / (uPat.w * uPat.w));
    float att = 1.0 / sqrt(1.0 + r * 0.8);
    const float K0 = 7.0;
    float l = cos(r * K0 - 0.7) * c;
    l += 0.55 * 0.384 * cos(r * K0 * 0.62 + 1.1) * s;
    float w6 = 0.20 + 0.80 * smoothstep(0.04, 0.38, res);
    l += w6 * 0.85 * 1.61 * cos(th * 6.0) * cos(r * K0 * 1.27 + 0.4) * s * smoothstep(0.15, 1.0, r);
    float w12 = smoothstep(0.28, 0.68, res);
    l += w12 * 0.75 * 3.61 * cos(th * 12.0 + 0.6) * cos(r * K0 * 1.9 - 0.9) * c * smoothstep(0.5, 1.6, r);
    float w18 = smoothstep(0.58, 1.0, res);
    l += w18 * 0.65 * 6.25 * cos(th * 18.0) * cos(r * K0 * 2.5 + 0.2) * s * smoothstep(0.9, 2.2, r);
    return -l * K0 * K0 * env * att;
  }
`;
