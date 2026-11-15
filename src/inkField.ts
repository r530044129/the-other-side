import * as THREE from 'three';

export interface BiolumDropSeed {
  /** World X coordinate (`-3.4m .. +3.4m`) where the ink drop pierces the ocean surface */
  worldX: number;
  /** World Z coordinate (`-3.8m .. +2.8m`) in the near-to-mid deep water */
  worldZ: number;
  birthTime: number;
  /** Plume characteristic scale in meters (`~0.65m .. 1.05m`) */
  radius: number;
  strength: number;
  seed: number;
  hueShift: number;
  /** One of the three upside-down ink flowers: larger, hangs in place under a real flower. */
  bloom?: boolean;
  /** Seconds this plume lives (default 34). The ones a breath sets off are shorter. */
  life?: number;
}

export const MAX_UNDERWATER_PLUMES = 8;

/**
 * Packs active 3D underwater sinking ink plumes (`y < 0`) at `currentTime` into GPU uniform arrays
 * so the 3D water raymarcher in `waterPool.ts` renders true volumetric subsurface ink clouds!
 *
 * Each plume:
 * - Pierces `y = 0` at `birthTime`, plunging rapidly in the first `0.8s` and then billowing deeper
 *   down to `y = -0.55m .. -2.65m` as a 3D mushrooming vortex ring + trailing vertical ink stem!
 * - Illuminates the dark abyssal water volume around it via subsurface isotropic scattering!
 */
export class BiolumInkField {
  readonly plumePosRadius: THREE.Vector4[] = Array.from(
    { length: MAX_UNDERWATER_PLUMES },
    () => new THREE.Vector4(0, -10, 0, 0)
  );
  readonly plumeMeta: THREE.Vector4[] = Array.from(
    { length: MAX_UNDERWATER_PLUMES },
    () => new THREE.Vector4(0, 0, 0, 0)
  );

  liveDropCount = 0;

  updateAtTime(
    currentTime: number,
    allScheduledDrops: BiolumDropSeed[],
    swirlGather: number,
    globalVisibility: number,
    realTime: number = currentTime
  ): number {
    if (globalVisibility <= 0.002) {
      this.liveDropCount = 0;
      for (let i = 0; i < MAX_UNDERWATER_PLUMES; i++) {
        this.plumePosRadius[i].set(0, -20, 0, 0);
        this.plumeMeta[i].set(0, 0, 0, 0);
      }
      return 0;
    }

    const MAX_AGE = 34.0;
    const active: { d: BiolumDropSeed; age: number }[] = [];
    for (let i = allScheduledDrops.length - 1; i >= 0; i--) {
      const d = allScheduledDrops[i];
      const age = currentTime - d.birthTime;
      if (age >= 0.01 && age < (d.life ?? MAX_AGE)) {
        active.push({ d, age });
        if (active.length >= MAX_UNDERWATER_PLUMES) break;
      }
    }

    this.liveDropCount = active.length;
    for (let i = 0; i < MAX_UNDERWATER_PLUMES; i++) {
      if (i < active.length) {
        const { d, age } = active[i];
        // Optional Shot 4 vortex gathering pulls underwater ink plumes gently inward toward center!
        const gatherPull = 1.0 / (1.0 + swirlGather * 0.28);
        const angle = swirlGather * 0.42;
        const cs = Math.cos(angle);
        const sn = Math.sin(angle);
        const wx = (d.worldX * cs - (d.worldZ - 0.2) * sn) * gatherPull;
        const wz = 0.2 + (d.worldX * sn + (d.worldZ - 0.2) * cs) * gatherPull;

        // Plunge depth below water surface `y = 0`: fast initial plunge -> buoyant vortex mushroom drift down to -2.8m!
        // During Shot 4's quiet vocal breath-hold (`78.6s..85.7s`), plumes sink deeper & dim gracefully into dark sapphire coils!
        // Gravity flip (85.72): everything that sank is pulled back up through the surface.
        const flipRise = THREE.MathUtils.smoothstep(realTime, 85.72, 86.75);
        const baseSink = d.bloom
          ? 0.22 + 0.92 * (1.0 - Math.exp(-age / 2.6))
          : 0.26 + 1.05 * (1.0 - Math.exp(-age / 1.45)) + 0.055 * age;
        const sinkDepth = baseSink * (1.0 - flipRise) - 0.12 * flipRise;
        const lifeEnv =
          THREE.MathUtils.smoothstep(age, 0.0, d.bloom ? 1.6 : 0.25) *
          (d.bloom ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(age, (d.life ?? MAX_AGE) * 0.45, (d.life ?? MAX_AGE) * 0.8)) *
          (1.0 + 0.9 * THREE.MathUtils.smoothstep(realTime, 85.72, 86.1));

        this.plumePosRadius[i].set(wx, -sinkDepth, wz, d.radius);
        this.plumeMeta[i].set(age, d.strength * lifeEnv * globalVisibility, d.seed, d.hueShift);
      } else {
        this.plumePosRadius[i].set(0, -20, 0, 0);
        this.plumeMeta[i].set(0, 0, 0, 0);
      }
    }

    return this.liveDropCount;
  }
}
