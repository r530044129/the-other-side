import * as THREE from 'three';

export interface CameraRigState {
  time: number;
  shotId: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Normalized pointer coordinates (-1..+1, 0 = screen center) */
  pointerX: number;
  pointerY: number;
  lockMouse?: boolean;
  /** Locked-off camera: no mouse look and no idle drift (shot 6, where the waterline is drawn on the lens). */
  lockedOff?: boolean;
  /** Visual clock (stalls during the held breath) used for idle drift. */
  fxTime?: number;
  freeze?: number;
  fovPunch?: number;
  /** Height of the 2.39:1 picture as a fraction of the frame (1 = no letterbox). */
  band?: number;
  /** Extra camera height (m): lets the lens ride the water sheet while it sits at the waterline. */
  rideY?: number;
}

export interface CameraRigTelemetry {
  camPos: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  mouseYawDeg: number;
  mousePitchDeg: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

type Ease = 'smooth' | 'linear' | 'in' | 'out' | 'inout3' | 'cut';
interface CamKey {
  t: number;
  pos: [number, number, number];
  tgt: [number, number, number];
  fov: number;
  /** Easing of the segment that ARRIVES at this key. */
  ease?: Ease;
  /**
   * fov is the vertical angle of the 2.39:1 picture itself, not of the whole frame. The rig converts
   * it with the current letterbox so the composition is the same in any window shape.
   */
  band?: boolean;
}

function lookFrom(pos: [number, number, number], pitchDeg: number, dist = 8.0): [number, number, number] {
  const p = (pitchDeg * Math.PI) / 180;
  return [pos[0], pos[1] + Math.sin(p) * dist, pos[2] - Math.cos(p) * dist];
}

const P_UNDER_A: [number, number, number] = [0.0, -0.52, 3.3];
const P_UNDER_B: [number, number, number] = [0.0, -0.58, 2.9];
const P_UNDER_C: [number, number, number] = [0.0, 0.42, 3.15];
const P_UNDER_D: [number, number, number] = [0.0, -1.25, 2.9];
const P_UNDER_D2: [number, number, number] = [0.0, -1.10, 2.9];

const CAM_KEYS: CamKey[] = [
  { t: 0.0, pos: [0, 4.13, 5.2], tgt: [0, -0.26, -2.3], fov: 54 },
  { t: 7.2, pos: [0, 4.13, 5.2], tgt: [0, -0.26, -2.3], fov: 54 },
  // shot ② (Deakins): low over the water, looking slightly up, longer lens. The horizon sits on the lower
  // third of the 2.39:1 picture; the move is one slow push with a little drift to the right.
  { t: 11.4, pos: [0.3, 0.56, 6.25], tgt: [0.3, 1.52, -3.75], fov: 32, band: true, ease: 'inout3' },
  { t: 46.38, pos: [-0.12, 0.6, 5.55], tgt: [-0.12, 1.56, -4.45], fov: 32, band: true, ease: 'linear' },
  // cut on the vocal entry, back to the earlier staging for shot ③
  // (the flowers now fall about 1.6 m as they open: the frame holds the whole travel, the closed bud under the
  // upper edge, the water and the ink under it in the lower two fifths; a slow creep in, no more)
  { t: 46.4, pos: [0, 2.62, 7.9], tgt: [0, 0.10, -6.36], fov: 54, ease: 'cut' },
  { t: 51.0, pos: [0, 2.56, 7.1], tgt: [0, 0.10, -4.6], fov: 54 },
  // shot 3, second chapter: sink to a skim just above the surface, the ink blooms fill the foreground
  { t: 60.4, pos: [0, 2.5, 6.7], tgt: [0, 0.14, -4.6], fov: 54 },
  // low, looking up: the flowers come down toward the lens
  { t: 64.4, pos: [0.5, 0.62, 4.8], tgt: [0, 2.3, -4.0], fov: 60, ease: 'inout3' },
  { t: 68.6, pos: [-0.5, 0.7, 4.4], tgt: [0, 2.25, -4.0], fov: 60, ease: 'linear' },
  // third: crane straight up and look down on the three flowers and what grows beneath them
  // straight down, held for six seconds: three flowers as three discs of light on black water, none of
  // them cut by the frame, each opening in turn a bar apart; the lens sinks very slowly toward them
  { t: 71.0, pos: [0, 8.9, 0.30], tgt: [0, 0.0, -0.32], fov: 50, ease: 'inout3' },
  { t: 77.0, pos: [0, 8.45, 0.28], tgt: [0, 0.0, -0.32], fov: 50, ease: 'linear' },
  { t: 80.2, pos: [0, 2.62, 5.15], tgt: [0, 0.4, -4.4], fov: 54, ease: 'inout3' },
  { t: 85.72, pos: [0, 2.62, 5.15], tgt: [0, 0.4, -4.4], fov: 54 },
  // shot 4, chapter 1: rise with the ink
  // (framing: the three flowers sit on the middle of the picture, the light show above them and its
  //  reflection below; before, they sat on the lower third under an empty upper third)
  { t: 90.6, pos: [0, 3.15, 6.9], tgt: [0, 1.75, -6.5], fov: 50, ease: 'out' },
  { t: 98.7, pos: [0, 3.05, 7.1], tgt: [0, 1.70, -6.5], fov: 50, ease: 'linear' },
  // chapter 2: fly forward under the flowers, into the light
  { t: 103.4, pos: [0, 1.75, 3.5], tgt: [0, 3.9, -8.0], fov: 66, ease: 'in' },
  { t: 108.2, pos: [0, 1.3, -0.25], tgt: [0, 6.2, -7.0], fov: 68, ease: 'linear' },
  { t: 114.9, pos: [0, 1.55, -2.9], tgt: [0, 9.5, -6.2], fov: 70, ease: 'out' },
  // chapter 3: the whole frame folds; the camera only breathes
  { t: 128.6, pos: [0, 1.7, -2.6], tgt: [0, 9.0, -6.6], fov: 72, ease: 'linear' },
  // chapter 4: back out to the horizon where the two worlds face each other
  { t: 132.4, pos: [0, 3.0, 7.7], tgt: [0, 2.3, -6.5], fov: 60, ease: 'inout3' },
  { t: 137.0, pos: [0, 2.9, 7.4], tgt: [0, 2.2, -6.5], fov: 60, ease: 'linear' },
  // down to the water and hold there, lens half in it, for a good second before the dive
  { t: 142.4, pos: [0, 0.13, 4.7], tgt: [0, 0.72, -5.0], fov: 58, ease: 'inout3' },
  { t: 143.85, pos: [0, 0.13, 4.7], tgt: [0, 0.72, -5.0], fov: 58, ease: 'linear' },
  { t: 145.6, pos: P_UNDER_A, tgt: lookFrom(P_UNDER_A, 20), fov: 64 },
  { t: 170.0, pos: P_UNDER_B, tgt: lookFrom(P_UNDER_B, 46), fov: 66 },
  { t: 175.5, pos: P_UNDER_B, tgt: lookFrom(P_UNDER_B, 46), fov: 66 },
  // second "in rainbows": sink, tip the lens straight up, and hold on the window as one whole disc of
  // light while the figure on the other side walks across it
  { t: 181.0, pos: P_UNDER_D, tgt: lookFrom(P_UNDER_D, 83), fov: 70, ease: 'inout3' },
  { t: 189.5, pos: P_UNDER_D2, tgt: lookFrom(P_UNDER_D2, 83), fov: 70, ease: 'linear' },
  { t: 197.85, pos: P_UNDER_C, tgt: lookFrom(P_UNDER_C, 31), fov: 64, ease: 'inout3' },
  // up through the sheet on the first drum hit, then hold at its level for a second and a half
  // (the rig adds the local height of the sheet during the hold, so the lens stays just above it)
  { t: 198.3, pos: P_UNDER_C, tgt: lookFrom(P_UNDER_C, 31), fov: 64, ease: 'linear' },
  // Shot 6 is one locked-off frame, the lens half in the water at the water's rest height (1.48 m): the
  // stage above the line, the floor of the pool below it, only the water moving (as in the UE5 reference).
  // It must not move, tilt or drift: the waterline is drawn on the lens at a fixed place in the frame, and
  // the water around the lens is held at the lens height to meet it.
  { t: 198.6, pos: [0, 1.48, 5.6], tgt: [0, 1.48, -4.35], fov: 57, ease: 'inout3' },
  { t: 200.0, pos: [0, 1.48, 5.6], tgt: [0, 1.48, -4.35], fov: 57, ease: 'linear' },
  // Shot 6 stays half in the water (as at the surfacing): air and the drummer's stage above the line,
  // the floor of the pool below it. The rig keeps riding the local height of the sheet.
  { t: 215.5, pos: [0, 1.48, 5.6], tgt: [0, 1.48, -4.35], fov: 57, ease: 'linear' },
  // bass returns: push in low on one side, then arc across the stage
  // (the three coloured shadows are giants now: the lens stays back and low and looks up at them, so
  //  they tower over the water from edge to edge instead of being cropped by a push-in)
  { t: 242.5, pos: [0, 1.48, 5.6], tgt: [0, 1.48, -4.35], fov: 57, ease: 'linear' },
  { t: 243.3, pos: [0, 2.3, 7.05], tgt: [0, 1.1, -4.35], fov: 57 },
  // finale: far enough back that the great flower is whole in the picture from the moment it arrives
  { t: 254.5, pos: [0, 2.0, 7.5], tgt: [0, 1.5, -5.55], fov: 53 },
  { t: 260.2, pos: [0, 1.9, 7.6], tgt: [0, 1.5, -5.55], fov: 53, ease: 'linear' },
  // "becoming one": as the flower sinks to the waterline the lens comes down and levels out, so the
  // horizon lies exactly across the middle and the flower and its reflection make one whole shape
  // (the lens ends a hand's width above the water: only from there does the line where the flower
  //  meets its reflection fall on the middle of the picture)
  { t: 272.0, pos: [0, 0.30, 7.9], tgt: [0, 0.30, -5.55], fov: 50 },
  { t: 286.05, pos: [0, 0.30, 8.5], tgt: [0, 0.30, -5.55], fov: 50, ease: 'linear' },
];

function easeFn(u: number, e: Ease | undefined): number {
  switch (e) {
    case 'linear': return u;
    case 'cut': return u >= 1 ? 1 : 0;
    case 'in': return u * u * u;
    case 'out': return 1 - Math.pow(1 - u, 3);
    case 'inout3': return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    default: return u * u * (3 - 2 * u);
  }
}

function fullFov(k: CamKey, band: number): number {
  if (!k.band || band >= 0.999) return k.fov;
  return (2 * Math.atan(Math.tan((k.fov * Math.PI) / 360) / band) * 180) / Math.PI;
}

export function sampleCameraPath(t: number, band = 1): { pos: [number, number, number]; tgt: [number, number, number]; fov: number } {
  const K = CAM_KEYS;
  if (t <= K[0].t) return K[0];
  for (let i = 1; i < K.length; i++) {
    if (t <= K[i].t) {
      const a = K[i - 1];
      const b = K[i];
      const u = easeFn((t - a.t) / Math.max(1e-6, b.t - a.t), b.ease);
      const m = (x: number, y: number) => x + (y - x) * u;
      return {
        pos: [m(a.pos[0], b.pos[0]), m(a.pos[1], b.pos[1]), m(a.pos[2], b.pos[2])],
        tgt: [m(a.tgt[0], b.tgt[0]), m(a.tgt[1], b.tgt[1]), m(a.tgt[2], b.tgt[2])],
        fov: m(fullFov(a, band), fullFov(b, band)),
      };
    }
  }
  return K[K.length - 1];
}

/**
 * v2 Heavy Fluid-Head Cinema Camera ("慢速液压云台"):
 * - Horizon calibrated so boundless deep water spans 100% edge-to-edge horizontally and occupies
 *   the lower ~2/3 of the viewport (with dense volumetric mist veiling the far horizon so ~1/2 of
 *   the screen reads as rich visible water, and the upper ~1/2 reads as a lush Deep-Sea Misty Sky Theater!).
 * - Mouse look range HALVED (`±5.6°` yaw, `±3.5°` pitch) with ultra-slow, heavy viscous fluid-head
 *   damping (`tau ~ 0.9s`, rate = 1.15) — slow, weighted, and unmistakably cinematic!
 */
export class CinemaCameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private smoothPointerX = 0;
  private smoothPointerY = 0;
  private pointerVelX = 0;
  private pointerVelY = 0;

  // Higher eye + gentle downward tilt puts the boundless water horizon near ~36% from top (~64% lower screen = 2/3!),
  // while dense horizon mist melts the far 15% seamlessly into the upper volumetric sky-theater!
  private currentPos = new THREE.Vector3(0.0, 2.28, 6.45);
  private currentTarget = new THREE.Vector3(0.0, 0.92, -6.50);
  private currentFov = 54.0;

  private lastTelemetry: CameraRigTelemetry = {
    camPos: [0, 2.28, 6.45],
    lookAt: [0, 0.92, -6.5],
    fov: 54.0,
    mouseYawDeg: 0,
    mousePitchDeg: 0,
  };

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(54.0, aspect, 0.12, 90.0);
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentTarget);
    this.camera.updateMatrixWorld();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  snapTo(state: CameraRigState): CameraRigTelemetry {
    this.smoothPointerX = state.lockMouse || state.lockedOff ? 0 : clamp(state.pointerX, -1, 1);
    this.smoothPointerY = state.lockMouse || state.lockedOff ? 0 : clamp(state.pointerY, -1, 1);
    this.pointerVelX = 0;
    this.pointerVelY = 0;
    return this.update(state, 12.0);
  }

  update(state: CameraRigState, dt: number): CameraRigTelemetry {
    const t = state.time;

    // 1. One continuous take, authored as keyframes. Big moves land on song events (flip 85.7, dive 143.9,
    //    surfacing 198.5); everything between is slow drift. The path is a pure function of time.
    const fx = state.fxTime ?? t;
    const pose = sampleCameraPath(t, state.band ?? 1);
    // (no idle drift while the lens is locked off: shot 6)
    const driftAmt = (1.0 - (state.freeze ?? 0)) * (state.lockedOff ? 0.0 : 1.0);
    const theatre = smoothstep(88.0, 94.0, t) * (1.0 - smoothstep(134.0, 141.0, t));
    const under = smoothstep(145.5, 150.0, t) * (1.0 - smoothstep(194.0, 197.6, t));
    const breathX = Math.sin(fx * 0.16) * 0.038 * driftAmt + theatre * Math.sin((fx - 88.0) * 0.105) * 0.85 + under * Math.sin(fx * 0.21) * 0.22;
    const breathY = Math.cos(fx * 0.13) * 0.022 * driftAmt + under * Math.sin(fx * 0.17 + 1.3) * 0.06;
    const basePos = new THREE.Vector3(pose.pos[0] + breathX, pose.pos[1] + breathY + (state.rideY ?? 0), pose.pos[2] + under * Math.cos(fx * 0.13) * 0.18);
    const baseTarget = new THREE.Vector3(
      pose.tgt[0] - theatre * Math.sin((fx - 88.0) * 0.105) * 0.9 + under * Math.sin(fx * 0.15 + 0.6) * 0.5,
      pose.tgt[1] + (state.rideY ?? 0),
      pose.tgt[2]
    );
    this.currentPos.copy(basePos);
    this.currentTarget.copy(baseTarget);
    this.currentFov = pose.fov + (state.fovPunch ?? 0);

    // 2. Halved Mouse-Look Range + Heavy Viscous Cinema Fluid-Head Inertia ("慢才会显得高级")
    const targetPX = state.lockMouse || state.lockedOff ? 0 : clamp(state.pointerX, -1, 1);
    const targetPY = state.lockMouse || state.lockedOff ? 0 : clamp(state.pointerY, -1, 1);

    if (dt >= 5.0) {
      this.smoothPointerX = targetPX;
      this.smoothPointerY = targetPY;
      this.pointerVelX = 0;
      this.pointerVelY = 0;
    } else {
      // Critically damped 2nd-order fluid-head spring (`omega = 1.35 rad/s` -> slow, silky, weighted glide!)
      const stepDt = Math.min(0.05, Math.max(0.001, dt));
      const omega = 2.6;
      const kSpring = omega * omega;
      const cDamp = 2.0 * omega * 1.08;

      const ax = (targetPX - this.smoothPointerX) * kSpring - this.pointerVelX * cDamp;
      const ay = (targetPY - this.smoothPointerY) * kSpring - this.pointerVelY * cDamp;
      this.pointerVelX += ax * stepDt;
      this.pointerVelY += ay * stepDt;
      this.smoothPointerX = clamp(this.smoothPointerX + this.pointerVelX * stepDt, -1, 1);
      this.smoothPointerY = clamp(this.smoothPointerY + this.pointerVelY * stepDt, -1, 1);
    }

    const shapedX = Math.tanh(this.smoothPointerX * 1.1) / Math.tanh(1.1);
    const shapedY = Math.tanh(this.smoothPointerY * 1.1) / Math.tanh(1.1);

    // Halved angular limits: ±5.6° horizontal, ±3.5° vertical!
    const maxYawDeg = 9.0;
    const maxPitchDeg = 5.0;
    const yawRad = THREE.MathUtils.degToRad(-shapedX * maxYawDeg);
    const pitchRad = THREE.MathUtils.degToRad(-shapedY * maxPitchDeg);

    const finalPos = this.currentPos.clone();
    // keep translation tiny: window-shadow / water shaders are keyed to the eye position
    finalPos.x += shapedX * 0.04;
    finalPos.y += -shapedY * 0.02;

    const viewVec = this.currentTarget.clone().sub(finalPos);
    const dist = viewVec.length();
    const dir = viewVec.normalize();

    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRad);
    dir.applyQuaternion(qYaw);
    const rightAxis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const qPitch = new THREE.Quaternion().setFromAxisAngle(rightAxis, pitchRad);
    dir.applyQuaternion(qPitch);

    const finalLookAt = finalPos.clone().addScaledVector(dir, dist);

    this.camera.fov = this.currentFov;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(finalPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(finalLookAt);
    this.camera.updateMatrixWorld();

    this.lastTelemetry = {
      camPos: [
        Number(finalPos.x.toFixed(3)),
        Number(finalPos.y.toFixed(3)),
        Number(finalPos.z.toFixed(3)),
      ],
      lookAt: [
        Number(finalLookAt.x.toFixed(3)),
        Number(finalLookAt.y.toFixed(3)),
        Number(finalLookAt.z.toFixed(3)),
      ],
      fov: Number(this.currentFov.toFixed(2)),
      mouseYawDeg: Number((shapedX * maxYawDeg).toFixed(2)),
      mousePitchDeg: Number((-shapedY * maxPitchDeg).toFixed(2)),
    };

    return this.lastTelemetry;
  }

  getTelemetry(): CameraRigTelemetry {
    return this.lastTelemetry;
  }
}
