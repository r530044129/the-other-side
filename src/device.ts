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
  /** MSAA samples of the main scene buffer. */
  msaaSamples: number;
  /** Blur tap counts in the lens pass. */
  dofTaps: number;
  shaftTaps: number;
  sweepTaps: number;
  /** Planar reflection / refraction of the water: fixed size on mobile, null = sized from the window. */
  waterRTSize: [number, number] | null;
  /** Drummer shadow: mask size and the most shutter sub-frames per strike. */
  shadowRes: number;
  shadowBlurSamples: number;
}

const DESKTOP: QualityProfile = {
  maxRenderW: 2560,
  canvasAntialias: true,
  preserveDrawingBuffer: true,
  minRenderScale: 0.62,
  slowFrameMs: 31.5,
  msaaSamples: 4,
  dofTaps: 16,
  shaftTaps: 8,
  sweepTaps: 30,
  waterRTSize: null,
  shadowRes: 1024,
  shadowBlurSamples: 10,
};

const MOBILE: QualityProfile = {
  maxRenderW: 1440,
  canvasAntialias: false,
  preserveDrawingBuffer: false,
  minRenderScale: 0.5,
  // step down before 30 fps is lost, not after: a phone only gets hotter as the song goes on
  slowFrameMs: 27.0,
  msaaSamples: 2,
  dofTaps: 10,
  shaftTaps: 5,
  sweepTaps: 16,
  waterRTSize: [640, 400],
  shadowRes: 512,
  shadowBlurSamples: 4,
};

export const quality: QualityProfile = isMobile ? MOBILE : DESKTOP;
