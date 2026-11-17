import * as THREE from 'three';
import { quality, onQualityChange } from './device';

export interface DrummerShadowState {
  presence: number;
  time: number;
  beatSec: number;
  /** Tracked-beat position at a given song time; the nod follows the real drums when this is given. */
  beatPosAt?: (t: number) => number;
  timeSinceStrike: number;
  strikeHandIndex: number;
  /** Live camera position so the stick-to-water ripple aligns 1:1 along the viewer's sightline! */
  cameraWorldPos?: THREE.Vector3;
  echo?: number;
}

export interface DrummerShadowTelemetry {
  presence: number;
  mode: 'idle-nod' | 'strike';
  nodDepth: number;
  stickLiftR: number;
  stickLiftL: number;
  shadowImpactWaterUV: [number, number];
  strikeWorldPos?: [number, number, number];
}

export interface DrummerShadowHandles {
  shadowMaskTexture: THREE.Texture;
  echoTextures: [THREE.Texture, THREE.Texture];
  shadowProjMatrix: THREE.Matrix4;
  projectorWorldPos: THREE.Vector3;
  updateAndRenderShadow: (renderer: THREE.WebGLRenderer, state: DrummerShadowState) => DrummerShadowTelemetry;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

function nodCurve(ph: number): number {
  const p = mod(ph, 1.0);
  if (p < 0.5) return 1.0 - easeOutCubic(p / 0.5);
  if (p < 0.78) return 0.0;
  const x = (p - 0.78) / 0.22;
  return x * x;
}

/**
 * Shot 6 shadow-play drummer: a hidden rig in front of the projector, rendered into a mask that the mist,
 * sky and water sample as a soft shadow.
 *
 * Motion (rewritten 2026-11-15):
 * - Idle: head nods on the tracked beat, sticks tap the air on the eighths, slow breath.
 * - Space: the stick whips from the ready V straight into the water (no wind-up, so the hit lands on the press),
 *   bounces once, then rebounds ABOVE THE HEAD with the stick cocked back, hangs, and settles.
 *   Hands alternate; a hit on a bar's downbeat comes down with both sticks and swings the crash.
 * - Whole body follows through: hips dip, torso lunges on the hit and arches back on the lift, neck and head
 *   arrive late, hair later still.
 * - Fast strokes are rendered as several shutter sub-frames averaged into the mask, so the stick smears.
 * - Kit in front of him: snare, a rack tom on the bass drum right under the hands, and a crash out past the sticks.
 */
export function createDrummerShadowSystem(): DrummerShadowHandles {
  const shadowScene = new THREE.Scene();
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

  const rig = new THREE.Group();
  // Pure expressive 3/4-left silhouette (-0.49*PI) so head/jaw/curl profile, leaned shoulders, BOTH arms,
  // drumsticks, snare, and boom crash cymbal stand separate with unmistakable Whiplash theatrical clarity!
  rig.position.set(0.30, 1.38, -2.25);
  rig.rotation.y = -Math.PI * 0.49;
  rig.scale.setScalar(1.86);
  shadowScene.add(rig);

  const Y = new THREE.Vector3(0, 1, 0);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 14);

  function addMesh(
    geo: THREE.BufferGeometry,
    parent: THREE.Object3D,
    pos?: THREE.Vector3,
    rot?: [number, number, number] | null
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, coreMat);
    if (pos) m.position.copy(pos);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    parent.add(m);
    return m;
  }

  function placeLimb(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, rScale: number): THREE.Mesh {
    const d = b.clone().sub(a);
    const len = d.length();
    m.position.copy(a).addScaledVector(d, 0.5);
    m.scale.set(rScale, Math.max(len, 1e-5), rScale);
    if (len > 1e-5) m.quaternion.setFromUnitVectors(Y, d.divideScalar(len));
    return m;
  }

  function addStandTube(a: THREE.Vector3, b: THREE.Vector3, r: number, parent: THREE.Object3D): THREE.Mesh {
    return placeLimb(addMesh(UNIT_CYL, parent), a, b, r);
  }

  function makeAnatomicalForearmGeo(): THREE.LatheGeometry {
    // Bottom (0 = elbow) -> muscular brachioradialis belly (0.28) -> slender wrist (1.0 = hand)
    // Wait: placeLimb aligns -0.5..+0.5 along a->b! Let's build y in [-0.5 .. +0.5]!
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12; // 0 = elbow (-0.5), 1 = wrist (+0.5)
      const muscle = 0.92 + 0.22 * Math.sin(Math.min(1, u * 1.6) * Math.PI) - 0.36 * Math.pow(u, 1.35);
      pts.push(new THREE.Vector2(muscle, u - 0.5));
    }
    return new THREE.LatheGeometry(pts, 14);
  }

  function makeBicepSleeveGeo(): THREE.LatheGeometry {
    // 0 = shoulder (-0.5) -> rolled t-shirt cuff swell (0.48) -> bicep/elbow (+0.5)
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      const sleeve = u < 0.52 ? 1.16 + 0.08 * Math.sin(u * 6.0) : 0.86 - 0.10 * (u - 0.52);
      pts.push(new THREE.Vector2(sleeve, u - 0.5));
    }
    return new THREE.LatheGeometry(pts, 14);
  }

  function cymbalGeo(R: number): THREE.LatheGeometry {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const u = i / 14;
      const r = u * R;
      const bell = 0.032 * Math.exp(-Math.pow(u / 0.22, 2));
      const bow = -0.022 * Math.pow(u, 1.30);
      // Slight thickness so edge-on cymbal never looks paper-thin or disconnected
      pts.push(new THREE.Vector2(r, bell + bow + 0.004));
    }
    for (let i = 14; i >= 0; i--) {
      const u = i / 14;
      const r = u * R;
      const bell = 0.032 * Math.exp(-Math.pow(u / 0.22, 2));
      const bow = -0.022 * Math.pow(u, 1.30);
      pts.push(new THREE.Vector2(r, bell + bow - 0.004));
    }
    return new THREE.LatheGeometry(pts, 28);
  }

  // =========================================================================
  // 1. GROUNDED JAZZ / INDIE-ROCK DRUM KIT SILHOUETTE (Zero floating saucers!)
  // =========================================================================
  // Drummer throne + tripod base
  addMesh(new THREE.CylinderGeometry(0.16, 0.15, 0.065, 18), rig, V(0, 0.50, -0.04));
  addStandTube(V(0, 0.02, -0.04), V(0, 0.50, -0.04), 0.020, rig);

  // Snare drum in front of waist + basket stand (anchors the musician silhouette!)
  const snarePos = V(0.06, 0.68, 0.42);
  addMesh(new THREE.CylinderGeometry(0.175, 0.175, 0.115, 22), rig, snarePos, [-0.14, 0, 0.06]);
  addStandTube(V(0.06, 0.02, 0.42), V(0.06, 0.62, 0.42), 0.018, rig);
  addStandTube(V(0.06, 0.56, 0.42), V(-0.08, 0.65, 0.36), 0.012, rig);
  addStandTube(V(0.06, 0.56, 0.42), V(0.20, 0.65, 0.48), 0.012, rig);

  // Bass drum, low, with a rack tom mounted on it: the tom sits right under the hands, so every stroke reads as
  // hitting a drum in front of him before the stick carries on into the water.
  addMesh(new THREE.CylinderGeometry(0.24, 0.24, 0.24, 24), rig, V(-0.08, 0.28, 0.62), [Math.PI * 0.5, 0, 0]);
  addMesh(new THREE.CylinderGeometry(0.13, 0.13, 0.16, 20), rig, V(-0.06, 0.64, 0.70), [-0.45, 0, 0]);
  addStandTube(V(-0.07, 0.50, 0.64), V(-0.06, 0.60, 0.69), 0.014, rig);

  // Crash cymbal on a boom stand IN FRONT of him, out past the sticks and a little above the hands; tilted so its
  // face turns toward him and it reads as a slanted disc in profile.
  const crashPos = V(-0.04, 1.14, 0.94);
  // Upright, tripod legs, and a boom that passes through the top of the upright: counterweight -> cymbal.
  addStandTube(V(-0.06, 0.02, 1.03), V(-0.06, 0.93, 1.03), 0.019, rig);
  addStandTube(V(-0.06, 0.24, 1.03), V(-0.06, 0.02, 1.20), 0.013, rig);
  addStandTube(V(-0.06, 0.24, 1.03), V(-0.06, 0.02, 0.88), 0.013, rig);
  addStandTube(V(-0.06, 0.82, 1.08), crashPos.clone().add(V(0, -0.04, 0)), 0.014, rig);
  addMesh(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 10), rig, V(-0.06, 0.82, 1.08), [0.9, 0, 0]);
  const CRASH_TILT = -0.32;
  const crashPivot = new THREE.Group();
  crashPivot.position.copy(crashPos);
  rig.add(crashPivot);
  const crashWob = new THREE.Group();
  crashWob.rotation.set(CRASH_TILT, 0, -0.10);
  crashPivot.add(crashWob);
  addMesh(cymbalGeo(0.235), crashWob);
  addMesh(new THREE.CylinderGeometry(0.018, 0.022, 0.055, 10), crashWob, V(0, 0.032, 0));

  // =========================================================================
  // 2. ATHLETIC HUMAN MUSICIAN SCULPTURE (Zero spiky cones!)
  // =========================================================================
  const pelvis = new THREE.Group();
  pelvis.position.set(0, 0.56, -0.03);
  rig.add(pelvis);
  addMesh(new THREE.SphereGeometry(0.125, 18, 14), pelvis, V(0, 0.0, 0)).scale.set(1.12, 0.82, 0.92);

  const torso = new THREE.Group();
  pelvis.add(torso);
  // Sculpted organic t-shirt torso (waist -> ribcage/latissimus V-taper -> broad athletic shoulders)
  const torsoPts: THREE.Vector2[] = [
    new THREE.Vector2(0.105, 0.00),
    new THREE.Vector2(0.112, 0.12),
    new THREE.Vector2(0.128, 0.26),
    new THREE.Vector2(0.146, 0.40),
    new THREE.Vector2(0.138, 0.49),
    new THREE.Vector2(0.068, 0.53),
  ];
  const torsoMesh = addMesh(new THREE.LatheGeometry(torsoPts, 20), torso, V(0, 0.0, 0.01), [0.06, 0, 0]);
  torsoMesh.scale.set(1.18, 1.0, 0.80);
  // Natural upper-back / trapezius curve & crew-neck shirt collar
  addMesh(new THREE.SphereGeometry(0.12, 16, 12), torso, V(0, 0.43, -0.015)).scale.set(1.22, 0.72, 0.88);
  addMesh(new THREE.TorusGeometry(0.062, 0.016, 10, 20), torso, V(0, 0.505, 0.032), [Math.PI * 0.46, 0, 0]);
  // Broad anatomical deltoid caps
  addMesh(new THREE.SphereGeometry(0.072, 14, 12), torso, V(-0.165, 0.455, 0.018)).scale.set(1.05, 0.92, 0.95);
  addMesh(new THREE.SphereGeometry(0.072, 14, 12), torso, V(0.165, 0.455, 0.018)).scale.set(1.05, 0.92, 0.95);

  const neck = new THREE.Group();
  neck.position.set(0, 0.51, 0.035);
  torso.add(neck);
  addMesh(new THREE.CylinderGeometry(0.046, 0.056, 0.12, 14), neck, V(0, 0.048, 0.006), [0.14, 0, 0]).scale.set(0.92, 1.0, 1.04);

  const head = new THREE.Group();
  head.position.set(0, 0.102, 0.016);
  neck.add(head);
  // Cranium + facial profile (smooth brow, subtle rounded nose bridge, natural jawline — NO sharp cones!)
  addMesh(new THREE.SphereGeometry(0.098, 22, 18), head, V(0, 0.096, -0.008)).scale.set(0.86, 1.04, 1.08);
  addMesh(new THREE.SphereGeometry(0.074, 18, 14), head, V(0, 0.054, 0.032)).scale.set(0.80, 0.95, 0.96);
  // Jaw & chin curve
  addMesh(new THREE.CapsuleGeometry(0.036, 0.042, 8, 12), head, V(0, 0.026, 0.046), [Math.PI * 0.36, 0, 0]).scale.set(0.84, 1.0, 0.88);
  // Smooth organic brow & nose bridge
  addMesh(new THREE.CapsuleGeometry(0.013, 0.032, 6, 10), head, V(0, 0.078, 0.092), [-0.32, 0, 0]);

  // Soft, natural tousled wavy curl mass (14 overlapping rounded ellipsoids — 100% ZERO sharp spikes!)
  const hairGroup = new THREE.Group();
  head.add(hairGroup);
  addMesh(new THREE.SphereGeometry(0.104, 20, 16), hairGroup, V(0, 0.114, -0.014)).scale.set(0.92, 0.96, 1.12);
  const hairCurls: [number, number, number, number, number, number][] = [
    [0.0, 0.168, 0.038, 0.046, 0.034, 0.054],
    [-0.036, 0.160, 0.025, 0.042, 0.032, 0.048],
    [0.036, 0.160, 0.025, 0.042, 0.032, 0.048],
    [0.0, 0.172, -0.018, 0.052, 0.038, 0.056],
    [-0.048, 0.145, -0.025, 0.044, 0.040, 0.052],
    [0.048, 0.145, -0.025, 0.044, 0.040, 0.052],
    [0.0, 0.142, -0.072, 0.056, 0.048, 0.052],
    [-0.038, 0.108, -0.082, 0.045, 0.048, 0.046],
    [0.038, 0.108, -0.082, 0.045, 0.048, 0.046],
    [0.0, 0.072, -0.078, 0.048, 0.044, 0.042],
    [0.0, 0.148, 0.068, 0.038, 0.026, 0.038], // soft forehead fringe curl
  ];
  for (const [hx, hy, hz, sx, sy, sz] of hairCurls) {
    addMesh(new THREE.SphereGeometry(1.0, 12, 10), hairGroup, V(hx, hy, hz)).scale.set(sx, sy, sz);
  }

  const sR = new THREE.Object3D();
  sR.position.set(-0.168, 0.455, 0.018);
  torso.add(sR);
  const sL = new THREE.Object3D();
  sL.position.set(0.168, 0.455, 0.018);
  torso.add(sL);
  const hR = new THREE.Object3D();
  hR.position.set(-0.088, -0.02, 0.03);
  pelvis.add(hR);
  const hL = new THREE.Object3D();
  hL.position.set(0.088, -0.02, 0.03);
  pelvis.add(hL);

  const bicepGeo = makeBicepSleeveGeo();
  const forearmGeo = makeAnatomicalForearmGeo();

  function makeArm() {
    const hand = addMesh(new THREE.SphereGeometry(0.038, 12, 10), rig);
    hand.scale.set(0.80, 0.94, 1.28);
    const tip = addMesh(new THREE.SphereGeometry(0.016, 10, 8), rig);
    tip.scale.set(0.85, 1.45, 0.85);
    return {
      upper: addMesh(bicepGeo, rig),
      elbow: addMesh(new THREE.SphereGeometry(0.040, 12, 10), rig),
      fore: addMesh(forearmGeo, rig),
      hand,
      // A touch thicker than a real stick so it survives the penumbra blur on the mist and still reads.
      stick: addMesh(new THREE.CylinderGeometry(0.0085, 0.0135, 1, 10), rig),
      tip,
    };
  }

  function makeLeg() {
    return {
      thigh: addMesh(new THREE.CylinderGeometry(0.78, 1.02, 1, 12), rig),
      knee: addMesh(new THREE.SphereGeometry(0.056, 12, 10), rig),
      shin: addMesh(new THREE.CylinderGeometry(0.66, 0.90, 1, 12), rig),
      foot: addMesh(new THREE.CapsuleGeometry(0.040, 0.17, 6, 10), rig),
    };
  }

  const arms = { R: makeArm(), L: makeArm() };
  const legs = { R: makeLeg(), L: makeLeg() };
  const ARM = { up: 0.30, fore: 0.285 };
  const LEG = { thigh: 0.43, shin: 0.43 };
  const STICK = { len: 0.58, grip: 0.08 };

  function ik(
    S: THREE.Vector3,
    T: THREE.Vector3,
    l1: number,
    l2: number,
    pole: THREE.Vector3,
    outMid: THREE.Vector3,
    outEnd: THREE.Vector3
  ) {
    const dir = T.clone().sub(S);
    const d = dir.length();
    dir.divideScalar(d || 1);
    const dc = clamp(d, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const p = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    outMid.copy(S).addScaledVector(dir, a).addScaledVector(p, h);
    outEnd.copy(S).addScaledVector(dir, dc);
  }

  const POLE = {
    R: V(-0.55, -0.70, -0.45).normalize(),
    L: V(0.55, -0.70, -0.45).normalize(),
  };

  function toRig(obj: THREE.Object3D): THREE.Vector3 {
    const out = new THREE.Vector3();
    obj.getWorldPosition(out);
    return rig.worldToLocal(out);
  }

  // =========================================================================
  // 3. MOTION — key poses, strike timeline, whole-body follow-through
  // =========================================================================
  // An arm pose lives in the drummer's side plane (the plane the shadow shows):
  //   th = arm direction from the shoulder (0 = straight forward, +PI/2 = straight up)
  //   r  = shoulder-to-hand reach,  ph = stick angle in the same plane,  x = hand depth offset (toward centre)
  type Side = 'R' | 'L';
  interface ArmPose { th: number; r: number; ph: number; x: number }
  const DEG = Math.PI / 180;
  const KEY: Record<Side, { ready: ArmPose; impact: ArmPose; high: ArmPose; hang: ArmPose }> = {
    // Ready: hands at chest height in front, sticks raised in a V, so a press whips straight down with no wind-up lag.
    // Impact: arm thrown forward-down, stick tip driven into the water (both hands land on the same spot).
    // High: rebound ABOVE the head, stick cocked up and back behind it — the exaggerated, readable apex.
    R: {
      ready: { th: 8 * DEG, r: 0.44, ph: 40 * DEG, x: 0.06 },
      impact: { th: -20 * DEG, r: 0.58, ph: -62 * DEG, x: 0.10 },
      high: { th: 112 * DEG, r: 0.565, ph: 154 * DEG, x: 0.03 },
      hang: { th: 116 * DEG, r: 0.57, ph: 164 * DEG, x: 0.03 },
    },
    L: {
      ready: { th: 0 * DEG, r: 0.43, ph: 30 * DEG, x: -0.06 },
      impact: { th: -19 * DEG, r: 0.58, ph: -60 * DEG, x: -0.10 },
      high: { th: 104 * DEG, r: 0.56, ph: 140 * DEG, x: -0.03 },
      hang: { th: 108 * DEG, r: 0.565, ph: 150 * DEG, x: -0.03 },
    },
  };

  const T_HIT = 0.055; // ready -> water: a whip, a few frames, smeared by the shutter
  const T_CONTACT = 0.10; // stick bounces once off the surface
  const T_TOP = 0.42; // rebound arrives above the head (with a little overshoot)
  const T_HANG = 0.68; // hangs up there, drifting further back
  const T_SETTLE = 1.18; // back to ready
  const ACTIVE_WINDOW = T_SETTLE + 0.05;

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const sstep = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const easeOutBack = (t: number, s: number) => {
    const u = t - 1;
    return 1 + u * u * ((s + 1) * u + s);
  };
  function mixPose(a: ArmPose, b: ArmPose, tArm: number, tStick = tArm): ArmPose {
    return { th: lerp(a.th, b.th, tArm), r: lerp(a.r, b.r, tArm), ph: lerp(a.ph, b.ph, tStick), x: lerp(a.x, b.x, tArm) };
  }

  // ---- Strike log: a pure function of song time, so the tape-delay echoes and motion-blur sub-frames can re-pose any instant.
  interface Strike { t: number; hands: Side | 'B' }
  const strikes: Strike[] = [];
  let lastSAge = 999;
  let lastIdx = -1;
  let beatPosFn: ((t: number) => number) | null = null;
  let beatLenSec = 0.5805;

  function beatPhaseAt(t: number): number {
    return beatPosFn ? beatPosFn(t) : t / beatLenSec;
  }

  function registerStrike(tStrike: number, idx: number) {
    // Alternate hands; a hit landing right on a bar's downbeat comes down with BOTH sticks.
    const bp = beatPhaseAt(tStrike);
    const toBar = Math.abs(bp - Math.round(bp / 4) * 4);
    const onDownbeat = toBar < 0.16;
    const prev = strikes[strikes.length - 1];
    const tooSoonForDouble = prev ? tStrike - prev.t < 0.22 : false;
    let hands: Side | 'B';
    if (onDownbeat && !tooSoonForDouble) hands = 'B';
    else {
      const lastSingle = [...strikes].reverse().find((s) => s.hands !== 'B' && tStrike - s.t < 2.5);
      hands = lastSingle ? (lastSingle.hands === 'R' ? 'L' : 'R') : idx % 2 === 0 ? 'R' : 'L';
    }
    strikes.push({ t: tStrike, hands });
    if (strikes.length > 12) strikes.shift();
  }

  function usesSide(s: Strike, side: Side) {
    return s.hands === side || s.hands === 'B';
  }

  /** Small air-taps on the beat while waiting (alternating sticks on the eighths), plus a slow breath. */
  function readyPose(side: Side, t: number): ArmPose {
    const k = KEY[side].ready;
    const ph = beatPhaseAt(t) + (side === 'L' ? 0.5 : 0.0);
    const tap = nodCurve(ph) * (side === 'L' ? 0.75 : 1.0);
    const breath = Math.sin((t / 3.7) * Math.PI * 2.0);
    return { th: k.th - 0.075 * tap + 0.012 * breath, r: k.r, ph: k.ph - 0.20 * tap + 0.02 * breath, x: k.x };
  }

  /** One strike's arm trajectory, `a` seconds after the press, starting from `start`. */
  function strikeArm(side: Side, a: number, start: ArmPose, ready: ArmPose): ArmPose {
    const K = KEY[side];
    if (a < T_HIT) {
      const u = a / T_HIT;
      // Arm accelerates into the hit; the wrist (stick angle) lags then snaps — that is the whip.
      return mixPose(start, K.impact, u * u, u * u * u);
    }
    if (a < T_CONTACT) {
      const v = (a - T_HIT) / (T_CONTACT - T_HIT);
      const b = Math.sin(v * Math.PI);
      return { th: K.impact.th + 0.05 * b, r: K.impact.r - 0.01 * b, ph: K.impact.ph + 0.32 * b, x: K.impact.x };
    }
    if (a < T_TOP) {
      const u = (a - T_CONTACT) / (T_TOP - T_CONTACT);
      const eArm = easeOutBack(u, 1.15);
      const eStick = easeOutBack(clamp((u - 0.12) / 0.88, 0, 1), 1.5);
      return mixPose(K.impact, K.high, eArm, eStick);
    }
    if (a < T_HANG) {
      const v = smoother((a - T_TOP) / (T_HANG - T_TOP));
      return mixPose(K.high, K.hang, v);
    }
    if (a < T_SETTLE) {
      const v = smoother((a - T_HANG) / (T_SETTLE - T_HANG));
      return mixPose(K.hang, ready, v, smoother(clamp((a - T_HANG) / (T_SETTLE - T_HANG - 0.06), 0, 1)));
    }
    return ready;
  }

  function armPoseAt(side: Side, t: number): { pose: ArmPose; lift: number } {
    const ready = readyPose(side, t);
    let last: Strike | null = null;
    let prev: Strike | null = null;
    for (let i = strikes.length - 1; i >= 0; i--) {
      const s = strikes[i];
      if (s.t > t || !usesSide(s, side)) continue;
      if (!last) last = s;
      else {
        prev = s;
        break;
      }
    }
    let pose = ready;
    if (last && t - last.t < ACTIVE_WINDOW) {
      // A new hit starts from wherever this arm was (often still up high from the last one — a bigger whip).
      let start = readyPose(side, last.t);
      if (prev && last.t - prev.t < ACTIVE_WINDOW) {
        start = strikeArm(side, last.t - prev.t, readyPose(side, prev.t), readyPose(side, last.t));
      }
      pose = strikeArm(side, t - last.t, start, ready);
    } else {
      // Off-hand counter-balance: while the other stick hits, this one lifts a little.
      const other = strikes.length ? strikes[strikes.length - 1] : null;
      if (other && other.t <= t && !usesSide(other, side)) {
        const a = t - other.t;
        const bump = a < 0.06 ? a / 0.06 : Math.exp(-(a - 0.06) / 0.22);
        pose = { ...ready, th: ready.th + 0.12 * bump, ph: ready.ph + 0.30 * bump };
      }
    }
    const lift = clamp((pose.th - KEY[side].impact.th) / (KEY[side].high.th - KEY[side].impact.th), 0, 1.1);
    return { pose, lift };
  }

  interface Body { impact: number; raise: number; sideImp: number; sideRaise: number; dbl: number }
  function bodyAt(t: number): Body {
    let impact = 0;
    let raise = 0;
    let sideImp = 0;
    let sideRaise = 0;
    let dbl = 0;
    for (let i = strikes.length - 1; i >= 0; i--) {
      const s = strikes[i];
      const a = t - s.t;
      if (a < 0) continue;
      if (a > 1.6) break;
      const w = s.hands === 'B' ? 1.35 : 1.0;
      const sign = s.hands === 'R' ? -1 : s.hands === 'L' ? 1 : 0;
      const imp = (a < T_HIT ? Math.pow(a / T_HIT, 2) : Math.exp(-(a - T_HIT) / 0.17)) * w;
      const rs = sstep(0.08, 0.40, a) * (1 - sstep(T_HANG - 0.06, T_SETTLE, a)) * w;
      if (imp > impact) {
        impact = imp;
        sideImp = sign * imp;
      }
      if (rs > raise) {
        raise = rs;
        sideRaise = sign * rs;
      }
      if (s.hands === 'B') dbl = Math.max(dbl, Math.exp(-a * 2.6));
    }
    return { impact, raise, sideImp, sideRaise, dbl };
  }

  function headPitchAt(t: number): number {
    const b = bodyAt(t);
    const nod = nodCurve(beatPhaseAt(t));
    return 0.30 * nod + 0.30 * b.impact - 0.16 * b.raise;
  }

  function poseArm(side: Side, p: ArmPose) {
    const a = arms[side];
    const S = toRig(side === 'R' ? sR : sL);
    const hand = V(S.x + p.x, S.y + p.r * Math.sin(p.th), S.z + p.r * Math.cos(p.th));
    const stickDir = V(-p.x * 0.15, Math.sin(p.ph), Math.cos(p.ph)).normalize();
    const E = V(0, 0, 0);
    const Hc = V(0, 0, 0);
    ik(S, hand, ARM.up, ARM.fore, POLE[side], E, Hc);
    placeLimb(a.upper, S, E, 0.052);
    a.elbow.position.copy(E);
    placeLimb(a.fore, E, Hc, 0.044);
    a.hand.position.copy(Hc);
    a.hand.quaternion.setFromUnitVectors(Y, stickDir);
    const butt = Hc.clone().addScaledVector(stickDir, -STICK.grip);
    const tip = Hc.clone().addScaledVector(stickDir, STICK.len - STICK.grip);
    placeLimb(a.stick, butt, tip, 1);
    a.tip.position.copy(tip);
    a.tip.quaternion.setFromUnitVectors(Y, stickDir);
    return tip;
  }

  function poseLeg(side: Side, ankle: THREE.Vector3, toeDir: THREE.Vector3) {
    const g = legs[side];
    const Hp = toRig(side === 'R' ? hR : hL);
    const K = V(0, 0, 0);
    const A = V(0, 0, 0);
    const pole = V(side === 'R' ? -0.18 : 0.18, 0.55, 1.0).normalize();
    ik(Hp, ankle, LEG.thigh, LEG.shin, pole, K, A);
    placeLimb(g.thigh, Hp, K, 0.068);
    g.knee.position.copy(K);
    placeLimb(g.shin, K, A, 0.052);
    const heel = A.clone().addScaledVector(toeDir, -0.03).add(V(0, -0.03, 0));
    const toe = A.clone().addScaledVector(toeDir, 0.18).add(V(0, -0.04, 0));
    g.foot.position.addVectors(heel, toe).multiplyScalar(0.5);
    g.foot.quaternion.setFromUnitVectors(Y, toe.clone().sub(heel).normalize());
  }

  // Placement of the hidden rig in front of the projector (tunable from the console in dev builds).
  const PLACE = { x: 0.30, y: 0.86, z: -2.25, rotY: -Math.PI * 0.49, scale: 1.52 };
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) (globalThis as unknown as { __drummerPlace?: typeof PLACE }).__drummerPlace = PLACE;

  /** Pose the whole rig for song time `t`. Pure in `t` given the strike log. */
  function poseAt(t: number) {
    rig.position.set(PLACE.x, PLACE.y, PLACE.z);
    rig.rotation.y = PLACE.rotY;
    rig.scale.setScalar(PLACE.scale);

    const beatPh = beatPhaseAt(t);
    const nod = nodCurve(beatPh);
    const nodLag = nodCurve(beatPh - 0.06);
    const breath = Math.sin((t / 3.7) * Math.PI * 2.0);
    const b = bodyAt(t);
    const bLag1 = bodyAt(t - 0.035);
    const bLag2 = bodyAt(t - 0.07);

    // Overlapping action: hips lead, torso follows, neck and head arrive late, hair later still.
    pelvis.position.y = 0.56 - 0.010 * nodLag - 0.028 * b.impact + 0.014 * b.raise;
    torso.rotation.x = 0.13 + 0.065 * nodLag + 0.012 * breath + 0.24 * b.impact - 0.13 * b.raise;
    torso.rotation.z = 0.025 * Math.sin((t / (beatLenSec * 4.0)) * Math.PI * 2.0) + 0.07 * b.sideRaise;
    torso.rotation.y = 0.12 * b.sideImp;
    neck.rotation.x = 0.16 * nod + 0.22 * bLag1.impact - 0.08 * bLag1.raise;
    head.rotation.x = -0.05 + 0.30 * nod + 0.30 * bLag2.impact - 0.16 * bLag2.raise;
    const hairLag = headPitchAt(t - 0.09) - headPitchAt(t);
    hairGroup.rotation.x = clamp(0.85 * hairLag, -0.32, 0.32);
    hairGroup.position.y = 0.012 * clamp(hairLag, -1, 1);
    rig.updateMatrixWorld(true);

    const aR = armPoseAt('R', t);
    const aL = armPoseAt('L', t);
    poseArm('R', aR.pose);
    poseArm('L', aL.pose);

    const kick = nodCurve(beatPh) * 0.03 + b.dbl * 0.05;
    poseLeg('R', V(-0.08, 0.12 + kick, 0.34), V(0, 0.1 + kick * 2.0, 1).normalize());
    poseLeg('L', V(0.14, 0.12 + 0.03 * nod, 0.30), V(0, 0.1, 1).normalize());

    // The crash rings off every hit, and swings hard on a double.
    const lastS = strikes.length ? strikes[strikes.length - 1] : null;
    const sAge = lastS && lastS.t <= t ? t - lastS.t : 999;
    const ring = Math.exp(-sAge * 3.2);
    crashWob.rotation.x = CRASH_TILT + 0.016 * Math.sin(t * 7.5) + (0.07 + 0.16 * b.dbl) * ring * Math.sin(sAge * 19.0);
    crashWob.rotation.z = -0.10 + 0.05 * b.dbl * Math.sin(sAge * 13.0 + 1.0);

    rig.updateMatrixWorld(true);
    return { nod, liftR: aR.lift, liftL: aL.lift, striking: sAge < 0.54 };
  }

  // =========================================================================
  // 4. PROJECTOR, MASK TARGETS, SHUTTER
  // =========================================================================
  const projectorWorldPos = new THREE.Vector3(0.0, 2.88, 2.85);
  const projectorTarget = new THREE.Vector3(0.0, 2.52, -2.25);
  const projCam = new THREE.PerspectiveCamera(46, 1.0, 0.8, 18.0);
  projCam.position.copy(projectorWorldPos);
  projCam.lookAt(projectorTarget);
  projCam.updateProjectionMatrix();
  projCam.updateMatrixWorld();

  const biasMat = new THREE.Matrix4().set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0
  );
  const shadowProjMatrix = new THREE.Matrix4()
    .copy(biasMat)
    .multiply(projCam.projectionMatrix)
    .multiply(projCam.matrixWorldInverse);

  const rtOpts = {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: true,
  } as const;
  const shadowRT = new THREE.WebGLRenderTarget(quality.shadowRes, quality.shadowRes, rtOpts);
  // Tape-delay echoes: the same drummer, a little late and a little later.
  const echoRT1 = new THREE.WebGLRenderTarget(quality.shadowRes / 2, quality.shadowRes / 2, rtOpts);
  const echoRT2 = new THREE.WebGLRenderTarget(quality.shadowRes / 2, quality.shadowRes / 2, rtOpts);
  // Scratch target for one shutter sub-frame.
  const subRT = new THREE.WebGLRenderTarget(quality.shadowRes, quality.shadowRes, rtOpts);

  onQualityChange(() => {
    shadowRT.setSize(quality.shadowRes, quality.shadowRes);
    subRT.setSize(quality.shadowRes, quality.shadowRes);
    echoRT1.setSize(quality.shadowRes / 2, quality.shadowRes / 2);
    echoRT2.setSize(quality.shadowRes / 2, quality.shadowRes / 2);
  });

  // Accumulates sub-frames into a mask: a real shadow of a fast stick is a soft smear, not a crisp stick.
  const accumMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: subRT.texture }, uWeight: { value: 1.0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D uTex; uniform float uWeight; varying vec2 vUv; void main(){ gl_FragColor = texture2D(uTex, vUv) * uWeight; }',
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const accumScene = new THREE.Scene();
  const accumQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), accumMat);
  accumQuad.frustumCulled = false;
  accumScene.add(accumQuad);
  const accumCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const SHUTTER_SEC = 0.028;

  function renderInto(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(shadowScene, projCam);
  }

  function isMoving(t: number) {
    const s = strikes.length ? strikes[strikes.length - 1] : null;
    return !!s && s.t <= t + 1e-3 && t - s.t < ACTIVE_WINDOW;
  }

  function poseAndRender(renderer: THREE.WebGLRenderer, t: number, target: THREE.WebGLRenderTarget, maxSamples: number) {
    const prevRT = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);

    const n = isMoving(t) ? maxSamples : 1;
    let result: ReturnType<typeof poseAt> | null = null;
    if (n <= 1) {
      result = poseAt(t);
      renderInto(renderer, target);
    } else {
      renderer.setRenderTarget(target);
      renderer.clear();
      accumMat.uniforms.uWeight.value = 1.0 / n;
      // Last sample is "now", so the reported pose matches the frame.
      for (let i = n - 1; i >= 0; i--) {
        const r = poseAt(t - (SHUTTER_SEC * i) / (n - 1));
        if (i === 0) result = r;
        renderInto(renderer, subRT);
        renderer.setRenderTarget(target);
        renderer.render(accumScene, accumCam);
      }
    }

    renderer.autoClear = prevAuto;
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.setRenderTarget(prevRT);
    return result!;
  }

  // Where the stick tip actually lands at impact (both hands aim at the same spot), in rig space.
  let impactTipLocal: THREE.Vector3 | null = null;
  function computeImpactTip(): THREE.Vector3 {
    rig.position.set(PLACE.x, PLACE.y, PLACE.z);
    rig.rotation.y = PLACE.rotY;
    rig.scale.setScalar(PLACE.scale);
    pelvis.position.y = 0.56 - 0.028;
    torso.rotation.set(0.13 + 0.24, 0, 0);
    neck.rotation.x = 0;
    head.rotation.x = 0;
    rig.updateMatrixWorld(true);
    const tR = poseArm('R', KEY.R.impact);
    const tL = poseArm('L', KEY.L.impact);
    return tR.add(tL).multiplyScalar(0.5);
  }

  function updateAndRenderShadow(
    renderer: THREE.WebGLRenderer,
    state: DrummerShadowState
  ): DrummerShadowTelemetry {
    if (state.presence <= 0.002) {
      return {
        presence: 0,
        mode: 'idle-nod',
        nodDepth: 0,
        stickLiftR: 0.65,
        stickLiftL: 0.42,
        shadowImpactWaterUV: [0.45, 0.60],
        strikeWorldPos: [-0.8, 1.48, -2.1],
      };
    }

    beatPosFn = state.beatPosAt ?? null;
    beatLenSec = Math.max(0.25, state.beatSec || 0.5805);

    // Seeking backwards wipes the log; a fresh press (age drops, or a new strike index) adds to it.
    if (strikes.length && strikes[strikes.length - 1].t > state.time + 0.01) {
      strikes.length = 0;
      lastIdx = -1;
    }
    const isNewPress =
      state.timeSinceStrike < 5 &&
      (state.timeSinceStrike < lastSAge - 0.02 || (state.strikeHandIndex !== lastIdx && lastIdx >= 0 && state.timeSinceStrike < 0.2));
    if (isNewPress) {
      const tS = state.time - state.timeSinceStrike;
      const last = strikes[strikes.length - 1];
      if (!last || Math.abs(last.t - tS) > 0.02) registerStrike(tS, state.strikeHandIndex);
    }
    lastSAge = state.timeSinceStrike;
    lastIdx = state.strikeHandIndex;

    if ((state.echo ?? 0) > 0.01) {
      poseAndRender(renderer, state.time - beatLenSec * 0.5, echoRT1, 3);
      poseAndRender(renderer, state.time - beatLenSec * 1.0, echoRT2, 3);
    }
    if (!impactTipLocal) impactTipLocal = computeImpactTip();
    const { nod, liftR, liftL, striking } = poseAndRender(renderer, state.time, shadowRT, quality.shadowBlurSamples);

    // Zero-gap sightline lock onto the `16.0m x 9.6m` billowing liquid-silk carpet (`y = 1.48m`, centered at `z = -1.2m`)!
    const tipWorldImpact = rig.localToWorld(impactTipLocal.clone());

    const projDir = tipWorldImpact.clone().sub(projectorWorldPos);
    const mistScreenZ = -3.45;
    const hoverWaterY = 1.48;
    let impactUV: [number, number] = [0.45, 0.60];
    let hitWorld: [number, number, number] = [-0.8, hoverWaterY, -2.1];

    if (Math.abs(projDir.z) > 1e-4) {
      const tMist = (mistScreenZ - projectorWorldPos.z) / projDir.z;
      const mistShadowTip = projectorWorldPos.clone().addScaledVector(projDir, Math.max(0.5, tMist));

      const camPos = state.cameraWorldPos ?? new THREE.Vector3(0.0, 2.22, 7.17);
      const viewRay = mistShadowTip.clone().sub(camPos);
      if (Math.abs(viewRay.y) > 1e-4) {
        const tWater = (hoverWaterY - camPos.y) / viewRay.y;
        if (tWater > 0) {
          const hitX = camPos.x + viewRay.x * tWater;
          const hitZ = camPos.z + viewRay.z * tWater;
          const u = clamp(hitX / 16.0 + 0.5, 0.12, 0.88);
          const v = clamp(0.5 - (hitZ - -1.2) / 9.6, 0.08, 0.92);
          impactUV = [Number(u.toFixed(3)), Number(v.toFixed(3))];
          hitWorld = [Number(hitX.toFixed(3)), hoverWaterY, Number(hitZ.toFixed(3))];
        }
      }
    }

    return {
      presence: Number(state.presence.toFixed(3)),
      mode: striking ? 'strike' : 'idle-nod',
      nodDepth: Number(nod.toFixed(3)),
      stickLiftR: Number(liftR.toFixed(3)),
      stickLiftL: Number(liftL.toFixed(3)),
      shadowImpactWaterUV: impactUV,
      strikeWorldPos: hitWorld,
    };
  }

  return {
    shadowMaskTexture: shadowRT.texture,
    echoTextures: [echoRT1.texture, echoRT2.texture],
    shadowProjMatrix,
    projectorWorldPos,
    updateAndRenderShadow,
  };
}
