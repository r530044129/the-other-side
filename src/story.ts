/**
 * Story timeline for "the reflection is another world".
 * Everything here is a pure function of song time, so seeking is deterministic.
 * Interaction-dependent values (space presses, drum combos) are filled in by the choreographer.
 */

export const T_FREEZE_IN = 78.6;
/** The wind-down before the bass: the visual clock slows from T_FREEZE_IN and stands still from T_STILL. */
export const T_STILL = 84.2;
export const T_FREEZE_HOLD = T_FREEZE_IN + (T_STILL - T_FREEZE_IN) * 0.5;
export const T_FLIP = 85.72;
export const T_DIVE = 143.87;
export const T_SURFACE = 198.48;
export const T_MERGE_IN = 260.2;
export const T_MERGE_DONE = 272.0;

export interface StoryState {
  /** Visual clock: stalls during the held breath (78.6..85.7) and resumes on the bass entry. */
  fxTime: number;
  /** 1 while the world is held still. */
  freeze: number;
  /** 0..1 over the five seconds before that: lamps going out, flowers rising and closing, water settling. */
  windDown: number;
  /** Seconds since the gravity flip (negative before). */
  flipAge: number;
  /** Beads of water hanging / falling upward (0..1). */
  risingPearls: number;

  /** Liquid light show in the sky. */
  skyShow: number;
  skyFront: number;
  skyFlow: number;
  skySwirl: number;
  skyHue: number;
  skyGain: number;
  kaleido: number;
  kaleidoSeed: number;
  /** How much the sky's oil film takes the shape of a Julia set (0..1). */
  julia: number;
  /** Up to three breath rings pushed into the sky: [centreX, centreY, age, strength]. */
  skyPulses: [number, number, number, number][];

  /** Reflection disobedience. */
  reflComplement: number;
  reflShiver: number;
  mirrorB: { active: boolean; open: number; glow: number; spin: number };
  mirrorGiant: { active: boolean; open: number; glow: number; spin: number };

  /** Three points of light the oil gathers into (0..1 travel, 0..1 brightness). */
  orbTravel: number;
  orbGlow: number;

  /** The other side. */
  underAmt: number;
  underView: number;
  submergeLine: number;
  /** 0..1: the water splits light into colours (shot ⑤). */
  rainbow: number;
  /** 0..1: water drops still on the lens after surfacing. */
  lensDrops: number;
  underSpan: number;
  causticFractal: number;
  shadowPass: number;
  shadowSlide: number;
  windowLight: number;
  /** 0..1: the lens looks straight up and the window is one whole disc of light (shot ⑤, second verse). */
  winPoster: number;
  /** Where the figure stands across that disc: 1 = off to one side, 0 = in the middle. */
  winSlide: number;

  /** Surfacing and drummer. */
  surfaceAge: number;
  flash: number;
  flashTint: [number, number, number];
  chroma: number;
  drummerEcho: number;
  drummerReveal: number;
  recap: number;
  recapAge: number;

  /** Finale. */
  merge: number;
  endPoint: number;
  endTitle: number;

  /** Whole-frame kaleidoscope fold (0..1), number of mirror segments and its rotation. */
  worldFold: number;
  foldN: number;
  foldSpin: number;
  /** Radial speed streaks while the camera flies through the light (0..1). */
  rush: number;
  /** Three coloured lamps split the drummer into three coloured shadows (0..1) and how far apart. */
  triShadow: number;
  triSpread: number;
  /** 0..1: those shadows grow to fill the wall. */
  triGiant: number;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function sstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Visual clock with the 6.7 s stall. Eases to a stop, restarts instantly on the flip. */
export function fxTimeAt(t: number): number {
  if (t <= T_FREEZE_IN) return t;
  if (t < T_STILL) {
    // slows evenly to a stop over five and a half seconds (it used to stop within 0.8 s and then sit still for six)
    const span = T_STILL - T_FREEZE_IN;
    const u = (t - T_FREEZE_IN) / span;
    return T_FREEZE_IN + span * (u - 0.5 * u * u);
  }
  if (t < T_FLIP) return T_FREEZE_HOLD;
  return t - (T_FLIP - T_FREEZE_HOLD);
}

export function computeStoryBase(t: number): StoryState {
  const fx = fxTimeAt(t);
  // true stillness is only the last second and a half; before it the scene winds down in plain sight
  const freeze = sstep(T_STILL - 0.7, T_STILL + 0.1, t) * (t < T_FLIP ? 1 : 0);
  const windDown = sstep(T_FREEZE_IN, T_STILL - 0.2, t) * (t < T_FLIP ? 1 : 0);
  const flipAge = t - T_FLIP;

  const hangIn = sstep(T_FREEZE_IN, 80.6, t);
  const risingPearls =
    (t < T_FLIP ? 0.55 * hangIn : 1.0) * (1.0 - sstep(141.0, 144.2, t)) +
    0.8 * sstep(229.5, 231.0, t) * (1.0 - sstep(240.5, 243.5, t));

  const recap = sstep(229.6, 231.2, t) * (1.0 - sstep(240.8, 243.4, t));
  const skyMain = sstep(T_FLIP, T_FLIP + 1.6, t) * (1.0 - sstep(138.5, 144.0, t));
  const skyShow = Math.max(skyMain, recap * 0.85);
  const skyFront = t < 200 ? Math.max(0, flipAge) * 0.46 : 3.0;

  const reflComplement =
    sstep(128.4, 130.6, t) * (1.0 - sstep(138.5, 143.5, t)) +
    0.78 * sstep(247.0, 254.0, t) * (1.0 - 0.62 * sstep(T_MERGE_IN, T_MERGE_DONE, t)) * (1.0 - sstep(277.0, 281.0, t));

  const orbTravel = sstep(9.0, 11.9, t);
  const orbGlow = sstep(8.2, 9.4, t) * (1.0 - sstep(11.6, 13.4, t));

  const underAmt = sstep(T_DIVE, T_DIVE + 1.6, t) * (1.0 - sstep(T_SURFACE - 0.7, T_SURFACE, t));
  const underView = t > T_DIVE + 0.1 && t < T_SURFACE - 0.05 ? 1 : 0;
  // Waterline across the lens. Going under: it comes up to the middle of the picture, stays there for a
  // second while the camera holds still, then closes over on the dive. Coming up: it drops to the middle
  // on the first drum hit, stays about a second and a half, then drains away.
  let submergeLine = -0.25;
  if (t < 170) {
    submergeLine = -0.25 + 0.66 * sstep(T_DIVE - 1.45, T_DIVE - 1.0, t) + 0.84 * sstep(T_DIVE - 0.03, T_DIVE + 0.42, t);
  } else {
    submergeLine =
      1.25 -
      0.72 * sstep(T_SURFACE - 0.18, T_SURFACE + 0.12, t) -
      0.13 * sstep(T_SURFACE + 0.12, T_SURFACE + 1.5, t) -
      0.65 * sstep(T_SURFACE + 1.5, T_SURFACE + 2.15, t);
  }
  // 'In rainbows' is sung twice under the water (152..169 and 179..197): colour arrives with the first
  // and is full with the second.
  const rainbow =
    (0.55 * sstep(151.5, 158.0, t) + 0.45 * sstep(179.0, 186.0, t)) * (1.0 - sstep(T_SURFACE - 1.2, T_SURFACE + 0.2, t));
  // Drops left on the lens after surfacing; they dry over about eight seconds.
  const lensDrops = sstep(T_SURFACE + 0.05, T_SURFACE + 0.35, t) * (1.0 - sstep(T_SURFACE + 1.8, T_SURFACE + 8.0, t));
  const underSpan = sstep(144.4, 150.0, t) * (1.0 - sstep(193.5, 197.4, t));
  const causticFractal = sstep(160.0, 167.0, t) * (1.0 - sstep(175.5, 182.0, t));
  const shadowPass = sstep(179.5, 185.0, t) * (1.0 - sstep(T_SURFACE - 0.4, T_SURFACE + 0.3, t));
  const shadowSlide = -0.62 * (1.0 - sstep(179.5, 196.0, t));
  const windowLight = 1.0 - 0.35 * sstep(184.0, 196.0, t);
  const winPoster = sstep(176.0, 181.0, t) * (1.0 - sstep(189.5, 194.0, t));
  const winSlide = 1.0 - sstep(180.0, 189.0, t);

  const surfaceAge = t - T_SURFACE;
  let flash = 0;
  let flashTint: [number, number, number] = [1.0, 0.86, 0.62];
  if (flipAge >= 0 && flipAge < 1.6) {
    // a surge, not a flash: a tenth of a second up, half a second down
    flash = 0.26 * Math.min(1, flipAge / 0.1) * Math.exp(-Math.max(0, flipAge - 0.1) * 3.2);
    flashTint = [0.55, 0.85, 1.0];
  } else if (surfaceAge >= -0.05 && surfaceAge < 1.8) {
    flash = 0.38 * Math.min(1, Math.max(0, surfaceAge + 0.05) / 0.1) * Math.exp(-Math.max(0, surfaceAge - 0.05) * 3.2);
  } else if (t > 271 && t < 279) {
    flash = 0.05 * sstep(271.0, 274.0, t) * (1.0 - sstep(276.0, 279.0, t));
    flashTint = [0.8, 0.92, 1.0];
  }
  const chroma =
    1.0 +
    // (the red/blue split bursts on the flip, the dive and the surfacing are removed)
    0.0 * (flipAge + surfaceAge + T_DIVE);

  const merge = sstep(T_MERGE_IN, T_MERGE_DONE, t);
  const endPoint = sstep(278.0, 280.5, t) * (1.0 - sstep(283.6, 285.4, t));
  const endTitle = sstep(279.6, 281.8, t) * (1.0 - sstep(284.0, 285.6, t));

  return {
    fxTime: fx,
    freeze,
    windDown,
    flipAge,
    risingPearls,
    skyShow,
    skyFront,
    skyFlow: fx * 0.22,
    skySwirl: 0.55 * Math.sin(fx * 0.11),
    skyHue: 0,
    skyGain: 1,
    kaleido: 0,
    kaleidoSeed: 0,
    // the Julia film is switched off (it read as mould)
    julia: 0.0 * skyShow,
    skyPulses: [],
    reflComplement,
    reflShiver: 0,
    mirrorB: { active: false, open: 0, glow: 1, spin: 0 },
    mirrorGiant: { active: false, open: 0, glow: 1, spin: 0 },
    orbTravel,
    orbGlow,
    underAmt,
    underView,
    submergeLine,
    rainbow,
    lensDrops,
    underSpan,
    causticFractal,
    shadowPass,
    shadowSlide,
    winPoster,
    winSlide,
    windowLight,
    surfaceAge,
    flash,
    flashTint,
    chroma,
    drummerEcho: 0,
    drummerReveal: 0,
    recap,
    recapAge: t - 229.6,
    merge,
    endPoint,
    endTitle,
    worldFold: 0,
    foldN: 6,
    foldSpin: 0,
    // radial speed streaks removed
    rush: 0.0 * sstep(98.7, 101.2, t),
    triShadow: sstep(215.5, 217.6, t) * (1.0 - sstep(240.8, 243.4, t)),
    triSpread: 0.07,
    triGiant: sstep(216.0, 220.5, t) * (1.0 - sstep(239.0, 243.0, t)),
  };
}
