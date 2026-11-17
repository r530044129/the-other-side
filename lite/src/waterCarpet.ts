import { quality } from './device';
import * as THREE from 'three';

export interface WaterCarpetWaveForces {
  /** 0 = boundless ocean water plane y = 0.0, 1 = full-width levitated liquid-silk flying carpet! */
  levitation: number;
  time: number;
  otherEnergy: number;
  vocalEnergy: number;
  bassEnergy: number;
  drumEnergy: number;
  beatPhase: number;
  waveActivity: number;
  /** Seen from below: the cloth hovers higher and spreads wider so it becomes a ceiling. */
  underLift?: number;
  underSpan?: number;
  /** Metres the sheet reaches further toward the camera (shot 6: its near edge goes behind the lens, so the
   *  only edges left in the picture are the swells themselves). */
  nearReach?: number;
  /** A locked-off lens sitting half in the water (shot 6): around it the water is held at the lens height,
   *  so the 3D surface meets the lens exactly where the waterline is drawn on it. Swells and strike waves
   *  fade out toward the lens. [lens x, lens z, strength 0..1]. */
  lensCalm?: [number, number, number];
}

export interface CarpetStrikeImpulse {
  uvX: number;
  uvY: number;
  strength: number;
}

/**
 * v2 Boundless Ocean -> Full-Width Levitating Liquid-Silk Flying Carpet (`XPBDWaterCarpet`):
 * - Grounded state (`levitation = 0`, Shots 1–4 & 7): Spans `36m wide x 38m deep` (`x in [-18..+18]`,
 *   `z in [-26..+12]`) so the water fills 100% of the screen width and dissolves seamlessly into sea mist!
 * - Levitated state (`levitation = 1`, Shots 5–6): Gathers smoothly into a colossal **`15.4m wide x 9.8m deep`**
 *   hovering liquid-silk ribbon (`~92%` of viewport width! Zero tiny square patch!) floating at `y = 1.62m`
 *   above the `-1.05m` abyssal caustic floor (`~2.67m` vertical air separation filled with hanging refracted light curtains!).
 */
export class XPBDWaterCarpet {
  readonly nu: number;
  readonly nv: number;
  readonly width: number;
  readonly length: number;
  readonly zCenter: number;
  readonly count: number;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly previous: Float32Array;
  readonly normals: Float32Array;
  readonly heightOffsets: Float32Array;

  private readonly ca: Int32Array;
  private readonly cb: Int32Array;
  private readonly restLengths: Float32Array;
  private readonly kind: Uint8Array;
  private readonly lambda: Float32Array;
  private readonly stiffCount: number;

  readonly geometry: THREE.BufferGeometry;
  private readonly pendingStrikes: CarpetStrikeImpulse[] = [];
  private readonly activeStrikes: { uvX: number; uvY: number; age: number; strength: number }[] = [];

  meanWaveHeight = 0;
  maxWaveAmplitude = 0;

  constructor(width = 36.0, length = 38.0, zCenter = -7.0, nu = 108, nv = 112) {
    this.nu = nu;
    this.nv = nv;
    this.width = width;
    this.length = length;
    this.zCenter = zCenter;
    this.count = (nu + 1) * (nv + 1);

    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.previous = new Float32Array(this.count * 3);
    this.normals = new Float32Array(this.count * 3);
    this.heightOffsets = new Float32Array(this.count);

    const a: number[] = [];
    const b: number[] = [];
    const rest: number[] = [];
    const kind: number[] = [];
    const id = (i: number, j: number): number => j * (nu + 1) + i;

    const add = (i: number, j: number, di: number, dj: number, k: number): void => {
      if (i + di > nu || i + di < 0 || j + dj > nv || j + dj < 0) return;
      a.push(id(i, j));
      b.push(id(i + di, j + dj));
      rest.push(Math.hypot((di * width) / nu, (dj * length) / nv));
      kind.push(k);
    };

    for (let par = 0; par < 2; par++) {
      for (let j = 0; j <= nv; j++) {
        for (let i = par; i <= nu; i += 2) add(i, j, 1, 0, 0);
      }
    }
    for (let par = 0; par < 2; par++) {
      for (let j = par; j <= nv; j += 2) {
        for (let i = 0; i <= nu; i++) add(i, j, 0, 1, 0);
      }
    }
    this.stiffCount = a.length;

    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        add(i, j, 1, 1, 1);
        add(i, j, -1, 1, 1);
        add(i, j, 2, 0, 2);
        add(i, j, 0, 2, 2);
      }
    }

    this.ca = Int32Array.from(a);
    this.cb = Int32Array.from(b);
    this.restLengths = Float32Array.from(rest);
    this.kind = Uint8Array.from(kind);
    this.lambda = new Float32Array(a.length);

    const indices: number[] = [];
    const uvs = new Float32Array(this.count * 2);

    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const idx = id(i, j);
        uvs[idx * 2 + 0] = i / nu;
        uvs[idx * 2 + 1] = 1.0 - j / nv;
      }
    }

    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p00 = id(i, j);
        const p10 = id(i + 1, j);
        const p01 = id(i, j + 1);
        const p11 = id(i + 1, j + 1);
        indices.push(p00, p01, p10, p10, p01, p11);
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);

    this.resetFlat();
  }

  resetFlat(): void {
    const { nu, nv, width, length, zCenter } = this;
    this.velocities.fill(0);
    this.heightOffsets.fill(0);
    this.activeStrikes.length = 0;
    for (let j = 0; j <= nv; j++) {
      const z = zCenter + (j / nv - 0.5) * length;
      for (let i = 0; i <= nu; i++) {
        const x = (i / nu - 0.5) * width;
        const p = (j * (nu + 1) + i) * 3;
        this.positions[p + 0] = x;
        this.positions[p + 1] = 0.0;
        this.positions[p + 2] = z;
        this.normals[p + 0] = 0.0;
        this.normals[p + 1] = 1.0;
        this.normals[p + 2] = 0.0;
      }
    }
    this.previous.set(this.positions);
    this.syncGeometry();
  }

  private lastForces: WaterCarpetWaveForces | null = null;

  /** Height of the sheet above a world point (same field the mesh is built from). */
  heightAtWorld(x: number, z: number): number {
    const f = this.lastForces;
    if (!f || f.levitation <= 0.001) return 0;
    const lev = Math.min(1, Math.max(0, f.levitation));
    const sl = lev * lev * (3 - 2 * lev);
    const span = f.underSpan ?? 0;
    const w = this.width + (16.0 + 8.0 * span - this.width) * sl;
    const reach = f.nearReach ?? 0;
    const l = this.length + (9.6 + 7.4 * span + reach - this.length) * sl;
    const zc = this.zCenter + (-1.2 - 1.3 * span + 0.5 * reach - this.zCenter) * sl;
    const u = Math.min(1, Math.max(0, x / w + 0.5));
    const v = Math.min(1, Math.max(0, 0.5 - (z - zc) / l));
    return this.sampleTargetCarpetField(u, v, f).targetY;
  }

  /** Live strikes for the water shader (uvX, uvY, age, strength); unused slots get strength 0. */
  writeStrikes(out: THREE.Vector4[]): void {
    for (let i = 0; i < out.length; i++) {
      const st = this.activeStrikes[i];
      if (st) out[i].set(st.uvX, st.uvY, st.age, st.strength);
      else out[i].set(0, 0, 0, 0);
    }
  }

  injectStrike(uvX: number, uvY: number, strength = 1.0): void {
    this.pendingStrikes.push({ uvX, uvY, strength });
  }

  private readonly fieldOut = { targetY: 0, targetX: 0, targetZ: 0 };

  private sampleTargetCarpetField(
    u: number,
    v: number,
    forces: WaterCarpetWaveForces
  ): { targetY: number; targetX: number; targetZ: number } {
    const lev = THREE.MathUtils.clamp(forces.levitation, 0, 1);
    const smoothLev = lev * lev * (3 - 2 * lev);
    const t = forces.time;

    // Grounded: 36m x 38m centered at z = -7.0m (fills 100% boundless ocean!)
    // Levitated: 16.0m wide x 9.6m deep centered at z = -1.2m (~94% of screen width!)
    const span = forces.underSpan ?? 0;
    const targetW = THREE.MathUtils.lerp(this.width, 16.0 + 8.0 * span, smoothLev);
    const reach = forces.nearReach ?? 0;
    const targetL = THREE.MathUtils.lerp(this.length, 9.6 + 7.4 * span + reach, smoothLev);
    const targetZCenter = THREE.MathUtils.lerp(this.zCenter, -1.2 - 1.3 * span + 0.5 * reach, smoothLev);

    const nx = (u - 0.5) * 2.0; // -1..+1
    const nz = (0.5 - v) * 2.0; // -1 (back) .. +1 (front)

    // Organic flowing silk-ribbon planform: pull in the 4 corners smoothly + add gentle sinusoidal silk-hem waves
    // so ZERO rigid 90-degree rectangular table corners or ruler-straight edges ever appear!
    const cornerRoundZ = 1.0 - 0.24 * Math.pow(Math.abs(nx), 2.6) * smoothLev;
    const cornerRoundX = 1.0 - 0.10 * Math.pow(Math.abs(nz), 2.8) * smoothLev;
    const wavyHemZ =
      (Math.sin(nx * 3.6 + t * 1.45) * 0.34 + Math.cos(nx * 6.8 - t * 1.95) * 0.16) *
      Math.pow(Math.abs(nz), 1.6) *
      smoothLev;
    const wavyHemX =
      Math.sin(nz * 3.2 - t * 1.35) * 0.28 * Math.pow(Math.abs(nx), 1.8) * smoothLev;

    const baseX = nx * 0.5 * targetW * cornerRoundX + wavyHemX;
    const baseZ = targetZCenter + nz * 0.5 * targetL * cornerRoundZ + wavyHemZ;

    // 1. Liftoff Arch Choreography (144s..150.5s, m3_01 at 147.2s):
    // Center domes gracefully upward first while outer silk hems trail downward like peeling liquid satin!
    const liftoffBell = Math.sin(lev * Math.PI);
    const centerDome = Math.exp(-(nx * nx * 1.35 + nz * nz * 1.45));
    const liftoffArchOffset = liftoffBell * (centerDome * 0.78 - (1.0 - centerDome) * 0.32);

    const baseHoverY = (1.48 + 0.95 * (forces.underLift ?? 0)) * smoothLev + liftoffArchOffset;
    const act = forces.waveActivity * smoothLev;

    // 2. Flowing Billowing 3D Liquid-Silk Waves (m3_02 S-curve swells -> m3_03 majestic ±0.56m climax crest!):
    const climaxBoost =
      THREE.MathUtils.smoothstep(t, 178.0, 185.0) *
      (1.0 - THREE.MathUtils.smoothstep(t, 193.0, 197.5));
    const omega = 2.25;
    const grandSwell = Math.sin(baseX * 0.56 + omega * t + Math.sin(baseZ * 0.45 - t * 0.72) * 0.65);
    const diagRibbon = Math.sin(baseX * 0.92 - baseZ * 0.78 + omega * 1.35 * t + 0.8);
    const silkDrape = Math.cos(baseX * 1.25 + baseZ * 0.80 + omega * 1.55 * t) * 0.25;

    // Climax sweeping diagonal wave crest peaking dramatically around x = -1.2m..+1.8m at t = 188s!
    const climaxWave =
      Math.sin(baseX * 0.46 - baseZ * 0.38 + t * 2.05) * 0.44 +
      Math.cos(baseX * 0.88 + baseZ * 0.62 - t * 2.65) * 0.24;

    // Free-fluttering silk hem undulation along front & back edges
    const edgeFactor = 0.35 * Math.pow(Math.abs(nx), 2.0) + 0.65 * Math.pow(Math.abs(nz), 1.8);
    // (the hem flutter belongs to a free edge; once the edge is behind the lens it would only ruffle the foreground)
    const hemFlutter = (Math.sin(baseX * 1.08 + t * 2.55 + nz * 1.4) * edgeFactor * 0.34) / (1.0 + 0.4 * reach);

    const musicalGain = 0.92 + 0.45 * forces.otherEnergy + 0.32 * forces.vocalEnergy;
    let waveOffset =
      ((grandSwell * 0.32 + diagRibbon * 0.20 + silkDrape * 0.11 + hemFlutter) * musicalGain +
        climaxWave * climaxBoost * 0.85) *
      act;

    // 3. Physical 3D Drumstick Strike Crater & Propagating Gravity-Wave Rings (Shot 6 Spacebar!):
    for (let sIdx = 0; sIdx < this.activeStrikes.length; sIdx++) {
      const st = this.activeStrikes[sIdx];
      const dxM = (u - st.uvX) * targetW;
      const dzM = (st.uvY - v) * targetL;
      const r = Math.hypot(dxM, dzM);
      const age = st.age;
      // Immediate deep -0.34m 3D impact crater + +0.20m raised circular crown rim (m3_05 at 0.067s!)
      const craterDecay = Math.exp(-age * 7.5);
      const craterBowl = -0.34 * Math.exp(-(r * r) / 0.32) * craterDecay;
      const crownRim = 0.21 * Math.exp(-Math.pow((r - (0.48 + age * 1.8)) / 0.28, 2.0)) * Math.exp(-age * 3.2);
      // Expanding 3D sculptural concentric wave train (m3_06 at 0.38s+!)
      const frontR = 0.35 + age * 3.15;
      const waveEnv =
        Math.exp(-Math.pow((r - frontR * 0.72) / Math.max(0.38, frontR * 0.48), 2.0)) *
        Math.exp(-age * 1.15) *
        THREE.MathUtils.smoothstep(age, 0.02, 0.14);
      const ringTrain = 0.16 * Math.cos((r - frontR) * 4.6) * waveEnv;
      waveOffset += (craterBowl + crownRim + ringTrain) * st.strength * smoothLev;
    }

    const orbitalX = -Math.cos(baseX * 0.56 + omega * t) * (0.16 + 0.12 * climaxBoost) * act;
    const orbitalZ = Math.sin(baseZ * 0.62 + t * 1.15) * 0.09 * act;

    // calm zone around a lens sitting in the water (see lensCalm)
    let calm = 1.0;
    const lc = forces.lensCalm;
    if (lc && lc[2] > 0) {
      const dl = Math.hypot(baseX - lc[0], baseZ - lc[1]);
      calm = 1.0 - lc[2] * (1.0 - THREE.MathUtils.smoothstep(dl, 0.8, 5.0));
    }

    const out = this.fieldOut;
    out.targetX = baseX + orbitalX * calm;
    out.targetY = baseHoverY + waveOffset * calm;
    out.targetZ = baseZ + orbitalZ * calm;
    return out;
  }

  step(dt: number, forces: WaterCarpetWaveForces): void {
    this.lastForces = forces;
    const lev = THREE.MathUtils.clamp(forces.levitation, 0, 1);
    if (lev <= 0.001) {
      if (this.meanWaveHeight !== 0 || this.maxWaveAmplitude !== 0) {
        this.resetFlat();
        this.meanWaveHeight = 0;
        this.maxWaveAmplitude = 0;
      }
      this.pendingStrikes.length = 0;
      this.activeStrikes.length = 0;
      return;
    }

    const substeps = quality.carpetSubsteps;
    const dtClamped = Math.min(0.025, Math.max(0.004, dt));
    const h = dtClamped / substeps;
    const h2 = h * h;
    const { nu, nv } = this;
    const cols = nu + 1;
    const x = this.positions;
    const v = this.velocities;
    const old = this.previous;

    for (let i = this.activeStrikes.length - 1; i >= 0; i--) {
      this.activeStrikes[i].age += dtClamped;
      if (this.activeStrikes[i].age > 3.2) {
        this.activeStrikes.splice(i, 1);
      }
    }

    // Drummer center strike velocity impulse + persistent 3D crater registration!
    while (this.pendingStrikes.length > 0) {
      const st = this.pendingStrikes.shift()!;
      this.activeStrikes.unshift({ uvX: st.uvX, uvY: st.uvY, age: 0.0, strength: st.strength });
      if (this.activeStrikes.length > 6) this.activeStrikes.pop();

    }

    // The sheet IS the swell field now. It used to be a cloth pulled toward this field through
    // stretch, shear and bend constraints; the slack in those constraints is what crumpled the water
    // into foil. Large shapes come from the field (long swells rolling right to left, the strike
    // crater and its rings); everything finer is done by the water shader's own waves.
    void h2;
    void old;
    for (let j = 0; j <= nv; j++) {
      const vv = 1.0 - j / nv;
      for (let i = 0; i <= nu; i++) {
        const p = (j * cols + i) * 3;
        const tgt = this.sampleTargetCarpetField(i / nu, vv, forces);
        x[p + 0] = tgt.targetX;
        x[p + 1] = tgt.targetY;
        x[p + 2] = tgt.targetZ;
      }
    }
    v.fill(0);

    this.computeNormalsAndMetrics(lev);
    this.syncGeometry();
  }

  private computeNormalsAndMetrics(lev: number): void {
    const x = this.positions;
    const n = this.normals;
    const cols = this.nu + 1;
    const nu = this.nu;
    const nv = this.nv;
    const baseY = 1.62 * (lev * lev * (3 - 2 * lev));

    let sumY = 0;
    let maxAmp = 0;

    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const idx = j * cols + i;
        const p = idx * 3;
        const yVal = x[p + 1];
        sumY += yVal;
        const off = yVal - baseY;
        this.heightOffsets[idx] = off;
        if (Math.abs(off) > maxAmp) maxAmp = Math.abs(off);

        const l = (j * cols + Math.max(0, i - 1)) * 3;
        const r = (j * cols + Math.min(nu, i + 1)) * 3;
        const u = (Math.max(0, j - 1) * cols + i) * 3;
        const d = (Math.min(nv, j + 1) * cols + i) * 3;

        const tx = x[r + 0] - x[l + 0];
        const ty = x[r + 1] - x[l + 1];
        const tz = x[r + 2] - x[l + 2];

        const bx = x[d + 0] - x[u + 0];
        const by = x[d + 1] - x[u + 1];
        const bz = x[d + 2] - x[u + 2];

        const nx = by * tz - bz * ty;
        const ny = bz * tx - bx * tz;
        const nz = bx * ty - by * tx;
        const inv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz + 1e-14);
        n[p + 0] = nx * inv;
        n[p + 1] = ny * inv;
        n[p + 2] = nz * inv;
      }
    }

    this.meanWaveHeight = Number((sumY / this.count).toFixed(3));
    this.maxWaveAmplitude = Number(maxAmp.toFixed(3));
  }

  private syncGeometry(): void {
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
  }
}
