/**
 * Which machine is this, and how much picture can it afford?
 *
 * A phone or tablet gets the "mobile" profile: fewer pixels and fewer blur taps, the same picture otherwise.
 * The desktop profile holds exactly the values the piece was built with, so nothing changes there.
 *
 * `?mobile=1` forces the mobile profile on a desktop (for testing), `?mobile=0` forces the desktop one.
 */
const params = new URLSearchParams(window.location.search);
const forced = params.get('mobile');

const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
const touchPoints = navigator.maxTouchPoints || 0;

/** A touch-first device: phone or tablet (an iPad reports itself as a Mac, but it has touch points and a coarse pointer). */
export const isMobile = forced === '1' ? true : forced === '0' ? false : coarse && touchPoints > 0;

export interface QualityProfile {
  /** Widest internal picture, in pixels. */
  maxRenderW: number;
  /** Canvas options: both are wasted on a phone (the picture is drawn into its own buffer first). */
  canvasAntialias: boolean;
  preserveDrawingBuffer: boolean;
  /** Frame-rate guard: lowest render scale, and the frame time (ms) above which it steps down. */
  minRenderScale: number;
  slowFrameMs: number;
  /** MSAA samples of the main scene buffer (0 = none). */
  msaaSamples: number;
  /** Blur tap counts in the lens pass (dofTaps 0 = no depth of field). */
  dofTaps: number;
  shaftTaps: number;
  sweepTaps: number;
  /** Planar reflection / refraction of the water: fixed size on mobile, null = sized from the window. */
  waterRTSize: [number, number] | null;
  /** Redraw the water's reflection every n-th frame (1 = every frame). */
  reflectEvery: number;
  /** Drummer shadow: mask size and the most shutter sub-frames per strike. */
  shadowRes: number;
  shadowBlurSamples: number;
  /** Solver substeps of the water cloth (runs on the CPU). */
  carpetSubsteps: number;
  /**
   * Tallest the picture may be, as a fraction of the screen height. A phone held sideways in Safari is
   * wider than 2.39:1, so without this it would get no black bars at all (and the song line, the hint and
   * the timeline would sit on the picture). Below 1 the bars are always there, the opening included.
   */
  letterboxMax: number;
}

/**
 * desktop: the values the piece was built with.
 * high: recent phones (iPhone 13 and later, flagship Android).
 * mid:  iPhone 11-12, mid-range Android: no MSAA, smaller picture and buffers.
 * low:  older and budget phones: no depth of field, reflection redrawn every other frame, lighter cloth.
 */
export type Tier = 'desktop' | 'high' | 'mid' | 'low';
const PHONE_BASE = { canvasAntialias: false, preserveDrawingBuffer: false, slowFrameMs: 27.0, letterboxMax: 0.84 };
const TIERS: Record<Tier, QualityProfile> = {
  desktop: {
    maxRenderW: 2560, canvasAntialias: true, preserveDrawingBuffer: true, minRenderScale: 0.62, slowFrameMs: 31.5,
    msaaSamples: 4, dofTaps: 16, shaftTaps: 8, sweepTaps: 30, waterRTSize: null, reflectEvery: 1,
    shadowRes: 1024, shadowBlurSamples: 10, carpetSubsteps: 2, letterboxMax: 1.0,
  },
  high: {
    ...PHONE_BASE, maxRenderW: 1200, minRenderScale: 0.5,
    msaaSamples: 2, dofTaps: 8, shaftTaps: 5, sweepTaps: 12, waterRTSize: [480, 300], reflectEvery: 1,
    shadowRes: 512, shadowBlurSamples: 4, carpetSubsteps: 2,
  },
  mid: {
    ...PHONE_BASE, maxRenderW: 960, minRenderScale: 0.55,
    msaaSamples: 0, dofTaps: 6, shaftTaps: 4, sweepTaps: 8, waterRTSize: [384, 240], reflectEvery: 1,
    shadowRes: 384, shadowBlurSamples: 3, carpetSubsteps: 2,
  },
  low: {
    ...PHONE_BASE, maxRenderW: 720, minRenderScale: 0.6,
    msaaSamples: 0, dofTaps: 0, shaftTaps: 3, sweepTaps: 6, waterRTSize: [256, 160], reflectEvery: 2,
    shadowRes: 256, shadowBlurSamples: 2, carpetSubsteps: 1,
  },
};
const ORDER: Tier[] = ['high', 'mid', 'low'];

/** A first guess before anything is drawn: from the GPU name (Android shows it, iPhones do not), memory and cores. */
function guessTier(): Tier {
  if (!isMobile) return 'desktop';
  const forcedTier = params.get('tier') as Tier | null;
  if (forcedTier && TIERS[forcedTier]) return forcedTier;
  let best: Tier = 'high';
  const cap = (t: Tier) => {
    if (ORDER.indexOf(t) > ORDER.indexOf(best)) best = t;
  };
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (mem !== undefined && mem <= 2) cap('low');
  else if (mem !== undefined && mem <= 4) cap('mid');
  if ((navigator.hardwareConcurrency || 8) <= 4) cap('low');
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'low';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const adreno = /Adreno[^0-9]*(\d+)/i.exec(name);
    const mali = /Mali-?([GT])(\d+)/i.exec(name);
    if (adreno) {
      const n = Number(adreno[1]);
      if (n < 600) cap('low');
      else if (n < 640) cap('mid');
    } else if (mali) {
      const n = Number(mali[2]);
      if (mali[1].toUpperCase() === 'T' || n < 57) cap('low');
      else if (n < 710) cap('mid');
    } else if (/PowerVR|Vivante|VideoCore/i.test(name)) cap('low');
  } catch {}
  return best;
}

export let tier: Tier = guessTier();
/** The live settings. Changed in place by setTier, so every reader sees the current level. */
export const quality: QualityProfile = { ...TIERS[tier] };
const listeners: (() => void)[] = [];

/** Run `fn` whenever the level changes (render targets resize, shader loop counts update, ...). */
export function onQualityChange(fn: () => void): void {
  listeners.push(fn);
}

export function setTier(t: Tier): void {
  if (t === tier || !TIERS[t]) return;
  tier = t;
  Object.assign(quality, TIERS[t]);
  for (const fn of listeners) fn();
}

/** The next lighter level, or null when already at the lightest. */
export function lowerTier(): Tier | null {
  const i = ORDER.indexOf(tier);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

/**
 * Phones load a lighter copy of the heavy files from public/m/ (about 9 MB in all instead of 27):
 * the song at 80 kbps, the flower with every third cloth frame, one splash take with fewer faces, the
 * ink cloud as grey WebP, the weave maps at 512 and the oil film as WebP. Everything else is shared.
 */
const LITE: Record<string, string> = {
  'audio/reckoner-full.m4a': 'm/audio/reckoner-full.m4a',
  'models/shylight_three_clips_q16_meshopt.glb': 'm/models/shylight_three_clips_q16_meshopt.glb',
  'baked/splash/splash_manifest.json': 'm/baked/splash/splash_manifest.json',
  'baked/splash/splash_a.glb': 'm/baked/splash/splash_a.glb',
  'baked/ink/ink_manifest.json': 'm/baked/ink/ink_manifest.json',
  'textures/linen-woven/normal.jpg': 'm/textures/linen-woven/normal.jpg',
  'textures/linen-woven/pack_height_opacity_ao.jpg': 'm/textures/linen-woven/pack_height_opacity_ao.jpg',
  'img/reckoner-film.jpg': 'm/img/reckoner-film.webp',
};

/** URL of a file in public/, swapped for its light copy on a phone. */
export function assetUrl(path: string): string {
  if (isMobile) {
    if (LITE[path]) return import.meta.env.BASE_URL + LITE[path];
    // the light ink frames are listed by the light manifest
    if (path.startsWith('baked/ink/') && path.endsWith('.webp')) return import.meta.env.BASE_URL + 'm/' + path;
  }
  return import.meta.env.BASE_URL + path;
}
