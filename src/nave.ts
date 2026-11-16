import * as THREE from 'three';
import { DK_FOG_GLSL, PAT_GLSL, S2_NAVE } from './shot2';

/**
 * Shot ② set: a flooded nave of catenary arches (Gaudí's inverted hanging chains), seen only as dark
 * shapes going back into warm fog, with one line of sleeping-flower lamps hung along its axis.
 * Nothing here is decorated. Each lamp lights the soffit of the arches beside it, a halo of fog
 * around itself, and (through the water's mirror) a long streak below it. Water light washes the vaults.
 */
export interface NaveState {
  time: number;
  /** 0..1 presence of the whole set. */
  presence: number;
  /** Lamp level multiplier (includes the 15–20 % surge after a drum hit). */
  lampGain: number;
  /** Water light on the vaults (driven by the 'other' stem). */
  vaultWash: number;
  dkTop: number;
  blackout: number;
  /** 0..1: how far the branching columns have grown (trunk first, then each generation of branches). */
  columnGrow: number;
  /** Cue drops in flight. */
  drops: { x: number; y: number; z: number; a: number }[];
  /** Standing-wave pattern of the water (its reflected light falls on the vaults). */
  pat: { cx: number; cz: number; amp: number; radius: number; resonance: number; phase: number };
  /** Flower lights: they throw the pattern onto the vaults, and the beads catch the nearest glow. */
  lights: { x: number; y: number; z: number; glow: number }[];
  /** Pixel height of the drawing buffer over 2*tan(fov/2), for point sizes. */
  pxPerUnit: number;
  /**
   * A flower's light thrown back off the water onto the arch wall beside it, with the flower's own
   * shadow standing in that light, several times its size: hub position, 0..1 open, scale, level.
   */
  wallShadows?: { x: number; hubY: number; z: number; open: number; scale: number; level: number }[];
  /** A lamp that travels across the far bays, behind the columns (nave-local metres), and its level. */
  sweep?: { x: number; y: number; z: number; level: number };
}

export interface NaveHandles {
  group: THREE.Group;
  /** Unit vector toward the nave's vanishing point (world space). */
  axis: THREE.Vector3;
  update: (s: NaveState) => void;
  /** World position of the travelling lamp (valid after update). */
  sweepWorld: THREE.Vector3;
}

const ARCHES = 16;
const LAMPS = 8;
/** The eight fixed lamps plus the travelling one. */
const NL = LAMPS + 1;
const FOG_K = 0.030;

/** Catenary parameter a for an inverted chain of half-width w and rise h: a * (cosh(w / a) - 1) = h. */
function solveCatenary(w: number, h: number): number {
  let lo = 0.2;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const rise = mid * (Math.cosh(w / mid) - 1);
    if (rise > h) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNave(): NaveHandles {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.set(S2_NAVE.x, 0, S2_NAVE.z);
  inner.rotation.y = -S2_NAVE.yaw;
  group.add(inner);
  inner.updateMatrixWorld(true);
  const axis = new THREE.Vector3(Math.sin(S2_NAVE.yaw), 0, -Math.cos(S2_NAVE.yaw)).normalize();
  const rand = rng(20261116);

  // ------------------------------------------------------------------ lamps (positions first: the arches need them)
  const lampWorld: THREE.Vector4[] = [];
  const lampLocal: THREE.Vector3[] = [];
  // one row, to the right of the centre line, starting in open water and going back through the arches;
  // the gaps grow with distance so the row does not read as a ruler
  const LAMP_Z = [-4.5, -9.5, -15.0, -21.0, -28.0, -36.0, -45.0, -55.0];
  for (let i = 0; i < LAMPS; i++) {
    const p = new THREE.Vector3(1.8 + (rand() - 0.5) * 0.3, 3.25 + (rand() - 0.5) * 0.45, LAMP_Z[i] + (rand() - 0.5) * 0.6);
    lampLocal.push(p);
    const w = p.clone().applyMatrix4(inner.matrixWorld);
    lampWorld.push(new THREE.Vector4(w.x, w.y, w.z, 1));
  }
  // slot for the travelling lamp (w = its level; 0 = not there)
  lampWorld.push(new THREE.Vector4(0, -50, 0, 0));
  const sweepLocal = new THREE.Vector3(0, 2.4, -34);
  const sweepWorld = new THREE.Vector3();

  const sharedUniforms = {
    uDkAxis: { value: axis.clone() },
    uDkTop: { value: 1.0 },
    uPresence: { value: 0.0 },
    uBlackout: { value: 0.0 },
    uLampGain: { value: 1.0 },
  };

  // ------------------------------------------------------------------ arches
  const pos: number[] = [];
  const nor: number[] = [];
  const kind: number[] = [];
  const SEG = 56;
  const Y0 = -0.6;
  const YTOP = 30;
  const XMAX = 34;
  const DEPTH = 1.5;
  const pushTri = (a: number[], b: number[], c: number[], n: number[], k: number) => {
    pos.push(...a, ...b, ...c);
    nor.push(...n, ...n, ...n);
    kind.push(k, k, k);
  };
  for (let i = 0; i < ARCHES; i++) {
    const z = -(10.0 + 6.0 * i);
    const W = 6.0 + (rand() - 0.5) * 0.7;
    const H = 10.6 + (rand() - 0.5) * 1.6;
    const a = solveCatenary(W, H - Y0);
    const yAt = (x: number) => H - a * (Math.cosh(x / a) - 1);
    const xs: number[] = [];
    for (let k = 0; k <= SEG; k++) {
      // denser sampling near the feet, where the chain turns steep
      const u = (k / SEG) * 2 - 1;
      xs.push(W * Math.sign(u) * (1 - Math.pow(1 - Math.abs(u), 1.6)));
    }
    const front = [0, 0, 1];
    // wall above the opening
    for (let k = 0; k < SEG; k++) {
      const x0 = xs[k];
      const x1 = xs[k + 1];
      const y0 = yAt(x0);
      const y1 = yAt(x1);
      pushTri([x0, y0, z], [x1, y1, z], [x1, YTOP, z], front, 0);
      pushTri([x0, y0, z], [x1, YTOP, z], [x0, YTOP, z], front, 0);
      // soffit: the underside of the arch, running back from the face
      const tx = x1 - x0;
      const ty = y1 - y0;
      const tl = Math.hypot(tx, ty) || 1;
      // inward normal (toward the opening)
      let nx = ty / tl;
      let ny = -tx / tl;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      const n = [nx, ny, 0];
      pushTri([x0, y0, z], [x0, y0, z - DEPTH], [x1, y1, z - DEPTH], n, 1);
      pushTri([x0, y0, z], [x1, y1, z - DEPTH], [x1, y1, z], n, 1);
    }
    // side walls
    for (const sgn of [-1, 1]) {
      const xa = sgn * W;
      const xb = sgn * XMAX;
      pushTri([xa, Y0, z], [xb, Y0, z], [xb, YTOP, z], front, 0);
      pushTri([xa, Y0, z], [xb, YTOP, z], [xa, YTOP, z], front, 0);
    }
  }
  const archGeo = new THREE.BufferGeometry();
  archGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  archGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  archGeo.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  const archUniforms = {
    ...sharedUniforms,
    uTime: { value: 0 },
    uLamps: { value: lampWorld },
    uVaultWash: { value: 0.0 },
    uPat: { value: new THREE.Vector4(0, 0, 0, 3) },
    uPatMode: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFlowers: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uShA: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uShB: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  };
  const archMat = new THREE.ShaderMaterial({
    uniforms: archUniforms,
    side: THREE.DoubleSide,
    transparent: true,
    vertexShader: /* glsl */ `
      attribute float aKind;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vKind;
      varying vec3 vLocal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vLocal = position;
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vKind = aKind;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vKind;
      varying vec3 vLocal;
      uniform float uTime;
      uniform float uPresence;
      uniform float uBlackout;
      uniform float uLampGain;
      uniform float uVaultWash;
      uniform vec4 uLamps[${NL}];
      uniform vec4 uPat;
      uniform vec4 uPatMode;
      uniform vec4 uFlowers[4];
      uniform vec4 uShA[3];
      uniform vec4 uShB[3];
      ${DK_FOG_GLSL}
      ${PAT_GLSL}

      // How strongly the rippled water gathers reflected light at a point of the pattern: where the
      // surface is curved like a lens the light gathers (bright), where it bulges it spreads (dark).
      // 'bend' shifts the lens strength per colour, which is what puts rainbow on the edges.
      // Smooth response (no hard-edged tiles): gathers to about 3x, thins to nothing.
      float patCaustic(float lap, float bend) {
        // the plain rings of the music-only state are broad and shallow, so they get more lens strength
        float f = lap * 0.020 * bend * (1.0 + 2.6 * (1.0 - uPatMode.x));
        float x = exp(-1.15 * (f + 1.0));
        return 4.5 * x / (1.0 + 2.0 * x) - 0.42;
      }

      float nHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float nNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(nHash(i), nHash(i + vec2(1.0, 0.0)), f.x), mix(nHash(i + vec2(0.0, 1.0)), nHash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 toCam = cameraPosition - vWorldPos;
        float dist = length(toCam);
        vec3 dir = -toCam / dist;
        if (dot(N, toCam) < 0.0) N = -N;

        // plaster: a little unevenness so lit soffits are not a flat gradient
        float stain = nNoise(vWorldPos.xy * 0.35 + vWorldPos.z * 0.2) * 0.6 + nNoise(vWorldPos.yx * 1.7) * 0.4;
        // Aged surface: long streaks running down the member (water has run down it for years), pores,
        // and a damp, darker foot where it stands in the water. The relief also tilts the normal, so a
        // lamp grazing the surface picks the grain out; flat shading is what made it look like a model.
        float streak = nNoise(vec2(vWorldPos.x * 7.0 + vWorldPos.z * 5.3, vWorldPos.y * 0.5));
        float pores = nNoise(vWorldPos.xy * 11.0 + vWorldPos.z * 8.0) * 0.6 + nNoise(vWorldPos.zy * 27.0 + vWorldPos.x * 21.0) * 0.4;
        float relief = streak * 0.6 + pores * 0.4;
        vec3 dpx = dFdx(vWorldPos);
        vec3 dpy = dFdy(vWorldPos);
        vec3 grad = (dpx * dFdx(relief) + dpy * dFdy(relief)) / max(dot(dpx, dpx) + dot(dpy, dpy), 1e-8);
        N = normalize(N - grad * 0.028 * smoothstep(60.0, 12.0, dist));
        float damp = 1.0 - smoothstep(0.05, 1.1, vWorldPos.y + (stain - 0.5) * 0.7);
        float albedo = (0.42 + 0.58 * stain) * (0.60 + 0.62 * relief) * mix(1.0, 0.42, damp);

        vec3 lit = vec3(0.0);
        vec3 amber = vec3(1.0, 0.60, 0.27);
        for (int i = 0; i < ${NL}; i++) {
          vec3 L = uLamps[i].xyz - vWorldPos;
          float d2 = dot(L, L);
          float ndl = max(0.0, dot(N, L * inversesqrt(d2)));
          // faces look down the nave, so a lamp only grazes them; soffits face their lamp
          lit += amber * ndl / (2.0 + d2) * mix(0.20, 1.6, vKind) * uLamps[i].w;
        }
        lit *= uLampGain * 0.115;

        // A flower's light, thrown back up off the water, washes the wall beside it, and the flower
        // stands in that light: its shadow lands on the wall several times its own size and comes down
        // and opens as the flower does. The source is a patch of bright water, so every edge is soft.
        for (int i = 0; i < 3; i++) {
          float lv = uShB[i].y;
          if (lv < 0.003) continue;
          vec3 hub = uShA[i].xyz;
          float open = uShA[i].w;
          float sc = uShB[i].x;
          // (the source sits below the surface: light off a mirror comes as if from the flower's image under it)
          vec3 S = vec3(hub.x + uShB[i].z, -0.55, hub.z + uShB[i].w);
          vec3 R = vWorldPos - S;
          float rl = length(R);
          float ndl = max(0.0, dot(N, -R / rl));
          // a pool, not a flood: it thins with height and away from the line the light travels along
          vec3 nrm = normalize(vec3(hub.x - S.x, 0.0, hub.z - S.z));
          vec3 tg = vec3(-nrm.z, 0.0, nrm.x);
          float along = dot(R, nrm);
          float side = dot(R, tg);
          float pool = exp(-(side * side) / (0.13 * along * along + 1.0)) * exp(-max(vWorldPos.y - 2.5, 0.0) / 5.0);
          pool *= smoothstep(-0.2, 1.2, vWorldPos.y) * 34.0 / (34.0 + rl * rl * 0.12);
          float occl = 0.0;
          float reach = dot(hub - S, nrm);
          if (along > reach + 0.05) {
            float k = reach / along;
            vec3 P = S + R * k;
            float u = abs(dot(P - hub, tg));
            float v = P.y - hub.y;
            float len = (0.446 - 0.056 * open) * mix(1.22, 1.08, open) * sc;
            float f = clamp(-v / len, 0.0, 1.0);
            float rad = sc * mix(0.035 + 0.115 * f, 0.07 + 0.50 * pow(f, 0.55), open);
            float pen = 0.11 * sc;
            // the hem is cut in points
            float hem = len * (0.84 + 0.16 * abs(cos(u / (0.57 * sc) * 7.85)));
            occl = smoothstep(rad + pen, rad - pen * 0.6, u) * smoothstep(-hem - pen * 0.5, -hem + pen * 0.5, v) * smoothstep(pen * 0.6, -pen * 0.4, v);
            // the cable it hangs from
            occl = max(occl, 0.55 * smoothstep(0.05 * sc, 0.0, u) * step(0.0, v));
          }
          lit += vec3(1.0, 0.66, 0.34) * ndl * pool * lv * 0.125 * (1.0 - 0.94 * occl) * mix(1.0, 0.35, vKind);
        }

        // gold water light on the vaults: strongest on the soffits low down, thinning as it climbs
        float climb = exp(-max(vWorldPos.y, 0.0) / 6.5) * smoothstep(-0.2, 0.8, vWorldPos.y);
        // The standing-wave pattern of the water, carried down the nave by the light that skims off it and
        // caught by every arch it meets: a rose window made of water light. It breathes with the flowers
        // (their light is what is being reflected), grows petals with resonance, and at high resonance
        // the colours part at the edges of each filament.
        if (uPat.z > 0.002) {
          float res = uPatMode.x;
          float src = 0.0;
          for (int i = 0; i < 3; i++) src += uFlowers[i].w;
          src = 0.30 + 0.70 * min(1.6, src);
          vec2 q = vec2(vLocal.x + 0.6, vLocal.y - 3.4) * 0.42;
          float fall = exp(-dot(q, q) / (uPat.w * uPat.w * 0.8));
          float lap = patLap(q);
          float sp = 0.14 * smoothstep(0.3, 0.9, res);
          vec3 c3 = vec3(patCaustic(lap, 1.0 - sp), patCaustic(lap, 1.0), patCaustic(lap, 1.0 + sp));
          vec3 filament = max(c3, vec3(0.0));
          vec3 tint = mix(amber, vec3(1.0, 0.86, 0.72), smoothstep(0.3, 0.9, res) * 0.6);
          float level = uPat.z * (1.0 + 0.2 * res) * src * uVaultWash * fall * smoothstep(-0.3, 1.0, vWorldPos.y);
          lit += tint * (filament * 0.0125 + 0.0016) * level * mix(0.85, 1.25, vKind);
        }

        vec3 col = lit * albedo;
        float fog = 1.0 - exp(-dist * ${FOG_K.toFixed(3)});
        col = mix(col, dkFog(dir), fog);
        // the last bays dissolve: no hard shape is left at the end of the nave
        float farFade = 1.0 - smoothstep(48.0, 92.0, dist);
        gl_FragColor = vec4(col * (1.0 - uBlackout), smoothstep(0.0, 1.0, uPresence) * farFade);
      }
    `,
  });
  const arches = new THREE.Mesh(archGeo, archMat);
  arches.frustumCulled = false;
  arches.renderOrder = -14;
  inner.add(arches);

  // ------------------------------------------------------------------ branching columns (L-system)
  // Gaudí's tree columns: a trunk that splits into three, each limb into three again, three generations,
  // every limb bending up toward the vault. One rule applied to itself; grown limb by limb with the music.
  // They are only ever dark shapes against the lamps and the fog.
  const GENERATIONS = 3;
  const colPos: number[] = [];
  const colNor: number[] = [];
  const colGrow: number[] = [];
  const RADIAL = 6;
  const ALONG = 5;
  const addLimb = (p0: THREE.Vector3, ctrl: THREE.Vector3, p1: THREE.Vector3, r0: number, r1: number, gen: number) => {
    const curve = new THREE.QuadraticBezierCurve3(p0, ctrl, p1);
    const pts: THREE.Vector3[] = [];
    const tans: THREE.Vector3[] = [];
    for (let i = 0; i <= ALONG; i++) {
      pts.push(curve.getPoint(i / ALONG));
      tans.push(curve.getTangent(i / ALONG));
    }
    const ring = (i: number, k: number): [THREE.Vector3, THREE.Vector3] => {
      const tg = tans[i];
      const side = new THREE.Vector3().crossVectors(tg, Math.abs(tg.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(side, tg).normalize();
      const a = (k / RADIAL) * Math.PI * 2;
      const n = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
      const r = r0 + (r1 - r0) * (i / ALONG);
      return [pts[i].clone().addScaledVector(n, r), n];
    };
    for (let i = 0; i < ALONG; i++) {
      for (let k = 0; k < RADIAL; k++) {
        const [a, na] = ring(i, k);
        const [b, nb] = ring(i, k + 1);
        const [c, nc] = ring(i + 1, k);
        const [d, nd] = ring(i + 1, k + 1);
        const g0 = (gen + i / ALONG) / (GENERATIONS + 1);
        const g1 = (gen + (i + 1) / ALONG) / (GENERATIONS + 1);
        for (const [v, n, g] of [[a, na, g0], [b, nb, g0], [c, nc, g1], [b, nb, g0], [d, nd, g1], [c, nc, g1]] as [THREE.Vector3, THREE.Vector3, number][]) {
          colPos.push(v.x, v.y, v.z);
          colNor.push(n.x, n.y, n.z);
          colGrow.push(g);
        }
      }
    }
  };
  const grow = (base: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, gen: number) => {
    const tip = base.clone().addScaledVector(dir, len);
    // every limb leans back toward the vertical as it goes (it is carrying a vault)
    const ctrl = base.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, -len * 0.10 * gen, 0));
    addLimb(base, ctrl, tip, rad, rad * 0.62, gen);
    if (gen >= GENERATIONS) return;
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0.3, 0.1, 1)).normalize();
    const twist = rand() * Math.PI * 2;
    for (let k = 0; k < 3; k++) {
      const az = twist + (k / 3) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const spread = 0.50 + 0.16 * rand();
      const d = dir.clone().applyAxisAngle(side, spread).applyAxisAngle(dir, az);
      d.y = Math.abs(d.y) + 0.35;
      d.normalize();
      grow(tip, d, len * (0.74 + 0.10 * rand()), rad * 0.62, gen + 1);
    }
  };
  for (const zc of [-13.0, -19.0, -25.0, -31.0]) {
    for (const sx of [-1, 1]) {
      const base = new THREE.Vector3(sx * (3.9 + rand() * 0.5), -0.5, zc + (rand() - 0.5) * 1.2);
      // a short trunk so the branching happens where the camera can see it
      grow(base, new THREE.Vector3(-sx * 0.05, 1, 0).normalize(), 3.0 + rand() * 0.5, 0.27, 0);
    }
  }
  const colGeo = new THREE.BufferGeometry();
  colGeo.setAttribute('position', new THREE.Float32BufferAttribute(colPos, 3));
  colGeo.setAttribute('normal', new THREE.Float32BufferAttribute(colNor, 3));
  colGeo.setAttribute('aGrow', new THREE.Float32BufferAttribute(colGrow, 1));
  const colUniforms = { ...sharedUniforms, uLamps: { value: lampWorld }, uGrow: { value: 0.0 } };
  const colMat = new THREE.ShaderMaterial({
    uniforms: colUniforms,
    transparent: true,
    vertexShader: /* glsl */ `
      attribute float aGrow;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vGrow;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vGrow = aGrow;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vGrow;
      uniform float uPresence;
      uniform float uBlackout;
      uniform float uLampGain;
      uniform float uGrow;
      uniform vec4 uLamps[${NL}];
      ${DK_FOG_GLSL}
      void main() {
        // nothing exists beyond the growing tip
        float alive = smoothstep(uGrow + 0.012, uGrow - 0.012, vGrow);
        if (alive < 0.01) discard;
        vec3 N = normalize(vNormalW);
        vec3 toCam = cameraPosition - vWorldPos;
        float dist = length(toCam);
        vec3 lit = vec3(0.0);
        for (int i = 0; i < ${NL}; i++) {
          vec3 L = uLamps[i].xyz - vWorldPos;
          float d2 = dot(L, L);
          lit += vec3(1.0, 0.60, 0.27) * max(0.0, dot(N, L * inversesqrt(d2))) / (2.0 + d2) * uLamps[i].w;
        }
        // the tip glows faintly while it is growing, like new wood
        float tip = exp(-((uGrow - vGrow) * (uGrow - vGrow)) / 0.0009) * step(uGrow, 0.995);
        vec3 col = lit * uLampGain * 0.16 + vec3(1.0, 0.62, 0.30) * tip * 0.10;
        float fog = 1.0 - exp(-dist * ${FOG_K.toFixed(3)});
        col = mix(col, dkFog(-toCam / dist), fog);
        float farFade = 1.0 - smoothstep(48.0, 92.0, dist);
        gl_FragColor = vec4(col * (1.0 - uBlackout), smoothstep(0.0, 1.0, uPresence) * farFade * alive);
      }
    `,
  });
  const columns = new THREE.Mesh(colGeo, colMat);
  columns.frustumCulled = false;
  columns.renderOrder = -13;
  inner.add(columns);

  // ------------------------------------------------------------------ lamp bodies (closed flowers)
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const u = i / 14;
    const r = 0.045 + 0.105 * Math.pow(u, 0.6) + 0.02 * Math.sin(u * Math.PI);
    profile.push(new THREE.Vector2(r, 0.36 - u * 0.72));
  }
  const lampGeo = new THREE.LatheGeometry(profile, 24);
  const lampUniforms = { ...sharedUniforms, uTime: { value: 0 } };
  const lampMat = new THREE.ShaderMaterial({
    uniforms: lampUniforms,
    side: THREE.DoubleSide,
    transparent: true,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aBoost;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vV;
      varying float vAng;
      varying float vSeed;
      varying float vBoost;
      uniform float uTime;
      void main() {
        vBoost = aBoost;
        vec3 p = position;
        float ang = atan(p.z, p.x);
        float u = clamp((0.36 - p.y) / 0.72, 0.0, 1.0);
        float pleat = sin(ang * 9.0 + aSeed * 30.0) * 0.014 * u;
        p.xz *= 1.0 + pleat / max(0.04, length(p.xz));
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        wp.x += 0.03 * sin(uTime * 0.27 + aSeed * 40.0) * u;
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vV = u;
        vAng = ang;
        vSeed = aSeed;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vV;
      varying float vAng;
      varying float vSeed;
      varying float vBoost;
      uniform float uPresence;
      uniform float uBlackout;
      uniform float uLampGain;
      ${DK_FOG_GLSL}
      void main() {
        vec3 toCam = cameraPosition - vWorldPos;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        float ndv = abs(dot(normalize(vNormalW), V));
        // the light sits low inside the bud and comes through the cloth: bright belly, dim collar,
        // darker pleat valleys, a lit hem
        float pleatShade = 0.84 + 0.16 * sin(vAng * 9.0 + vSeed * 30.0);
        float core = exp(-((vV - 0.72) / 0.34) * ((vV - 0.72) / 0.34));
        vec3 warm = mix(vec3(1.0, 0.50, 0.20), vec3(1.0, 0.76, 0.48), core);
        vec3 col = warm * (0.06 + 1.5 * core) * pleatShade * (0.40 + 0.60 * ndv) * uLampGain * 0.62 * vBoost;
        float fog = 1.0 - exp(-dist * ${FOG_K.toFixed(3)});
        col = mix(col, dkFog(-V), fog * 0.9);
        gl_FragColor = vec4(col * (1.0 - uBlackout), smoothstep(0.0, 1.0, uPresence));
      }
    `,
  });
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, NL);
  const seeds = new Float32Array(NL);
  const boosts = new Float32Array(NL).fill(1);
  const dummy = new THREE.Object3D();
  const cordPts: number[] = [];
  const LAMP_SCALE = 1.35;
  for (let i = 0; i < LAMPS; i++) {
    const p = lampLocal[i];
    dummy.position.copy(p);
    dummy.rotation.set(0, rand() * 6.28, 0);
    dummy.scale.setScalar(LAMP_SCALE);
    dummy.updateMatrix();
    lamps.setMatrixAt(i, dummy.matrix);
    seeds[i] = rand();
    cordPts.push(p.x, p.y + 0.36 * LAMP_SCALE, p.z, p.x, 32, p.z);
  }
  // the travelling lamp: last instance, placed every frame
  seeds[LAMPS] = 0.37;
  boosts[LAMPS] = 0.0;
  const SWEEP_SCALE = 1.9;
  dummy.position.set(0, -50, 0);
  dummy.scale.setScalar(0.0001);
  dummy.updateMatrix();
  lamps.setMatrixAt(LAMPS, dummy.matrix);
  lampGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  const boostAttr = new THREE.InstancedBufferAttribute(boosts, 1);
  boostAttr.setUsage(THREE.DynamicDrawUsage);
  lampGeo.setAttribute('aBoost', boostAttr);
  lamps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  lamps.frustumCulled = false;
  lamps.renderOrder = -12;
  inner.add(lamps);

  const cordGeo = new THREE.BufferGeometry();
  cordGeo.setAttribute('position', new THREE.Float32BufferAttribute(cordPts, 3));
  const cordMat = new THREE.LineBasicMaterial({ color: 0x050403, transparent: true, opacity: 0.0 });
  const cords = new THREE.LineSegments(cordGeo, cordMat);
  cords.frustumCulled = false;
  cords.renderOrder = -12;
  inner.add(cords);

  // ------------------------------------------------------------------ halos: each lamp lights the fog around it
  const haloGeo = new THREE.InstancedBufferGeometry();
  haloGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  haloGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const haloCentres = new Float32Array(NL * 3);
  const haloBoost = new Float32Array(NL).fill(1);
  haloBoost[LAMPS] = 0;
  for (let i = 0; i < LAMPS; i++) {
    haloCentres[i * 3] = lampLocal[i].x;
    haloCentres[i * 3 + 1] = lampLocal[i].y - 0.1;
    haloCentres[i * 3 + 2] = lampLocal[i].z;
  }
  haloCentres[LAMPS * 3 + 1] = -50;
  const haloCentreAttr = new THREE.InstancedBufferAttribute(haloCentres, 3);
  haloCentreAttr.setUsage(THREE.DynamicDrawUsage);
  haloGeo.setAttribute('aCentre', haloCentreAttr);
  const haloBoostAttr = new THREE.InstancedBufferAttribute(haloBoost, 1);
  haloBoostAttr.setUsage(THREE.DynamicDrawUsage);
  haloGeo.setAttribute('aHBoost', haloBoostAttr);
  haloGeo.instanceCount = NL;
  const haloMat = new THREE.ShaderMaterial({
    uniforms: sharedUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aCentre;
      attribute float aHBoost;
      varying vec2 vQ;
      varying float vDist;
      varying float vHB;
      void main() {
        vec4 mv = modelViewMatrix * vec4(aCentre, 1.0);
        vDist = -mv.z;
        vQ = position.xy;
        vHB = aHBoost;
        // the travelling lamp is brighter, so the fog it lights reaches further
        mv.xy += position.xy * 3.4;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vQ;
      varying float vDist;
      varying float vHB;
      uniform float uPresence;
      uniform float uBlackout;
      uniform float uLampGain;
      void main() {
        float r = length(vQ);
        if (r > 1.0 || vHB < 0.002) discard;
        // light scattered by fog around a small source: a steep core and a long soft skirt
        float glow = exp(-r * 7.0) * 0.55 + exp(-r * r * 5.5) * 0.10;
        glow *= 1.0 - smoothstep(0.75, 1.0, r);
        float air = exp(-vDist * ${(FOG_K * 0.55).toFixed(4)});
        vec3 col = vec3(1.0, 0.60, 0.28) * glow * air * uLampGain * 0.42 * vHB;
        gl_FragColor = vec4(col * (1.0 - uBlackout) * uPresence, 1.0);
      }
    `,
  });
  const halos = new THREE.Mesh(haloGeo, haloMat);
  halos.frustumCulled = false;
  halos.renderOrder = -10;
  inner.add(halos);

  // ------------------------------------------------------------------ cue drops (world space)
  const MAX_BEADS = 16;
  const beadPos = new Float32Array(MAX_BEADS * 3);
  const beadAmt = new Float32Array(MAX_BEADS);
  const beadGeo = new THREE.BufferGeometry();
  beadGeo.setAttribute('position', new THREE.BufferAttribute(beadPos, 3));
  beadGeo.setAttribute('aAmt', new THREE.BufferAttribute(beadAmt, 1));
  const beadUniforms = { uPx: { value: 800 }, uBlackout: { value: 0 } };
  const beadMat = new THREE.ShaderMaterial({
    uniforms: beadUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aAmt;
      uniform float uPx;
      varying float vAmt;
      void main() {
        vAmt = aAmt;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(0.11 * uPx / max(0.5, -mv.z), 5.0, 30.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uBlackout;
      varying float vAmt;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        // a bead of water: taller than wide, one small hot glint
        // a bead of water carrying the flower's light: a small bright body, taller than wide, in a soft halo
        float body = exp(-(d.x * d.x * 150.0 + d.y * d.y * 60.0));
        float halo = exp(-dot(d, d) * 16.0);
        vec3 col = vec3(1.0, 0.74, 0.44) * (body * 2.4 + halo * 0.20) * vAmt;
        gl_FragColor = vec4(col * (1.0 - uBlackout), 1.0);
      }
    `,
  });
  const beads = new THREE.Points(beadGeo, beadMat);
  beads.frustumCulled = false;
  beads.renderOrder = 4;
  group.add(beads);

  function update(s: NaveState) {
    const vis = s.presence > 0.003;
    group.visible = vis;
    if (!vis) return;
    sharedUniforms.uPresence.value = s.presence;
    sharedUniforms.uBlackout.value = s.blackout;
    sharedUniforms.uLampGain.value = s.lampGain;
    sharedUniforms.uDkTop.value = s.dkTop;
    archUniforms.uTime.value = s.time;
    archUniforms.uVaultWash.value = s.vaultWash;
    colUniforms.uGrow.value = s.columnGrow;
    columns.visible = s.columnGrow > 0.002;
    // on the vault the pattern is spread wider than on the water: the arch faces start well away from
    // its centre (the centre falls inside the openings)
    archUniforms.uPat.value.set(s.pat.cx, s.pat.cz, s.pat.amp, Math.max(0.5, s.pat.radius) * 2.0);
    archUniforms.uPatMode.value.set(s.pat.resonance, s.pat.phase, 0, 0);
    for (let i = 0; i < 4; i++) {
      const l = s.lights[i];
      if (l) archUniforms.uFlowers.value[i].set(l.x, l.y, l.z, l.glow);
      else archUniforms.uFlowers.value[i].set(0, 0, 0, 0);
    }
    for (let i = 0; i < 3; i++) {
      const w = s.wallShadows?.[i];
      if (w && w.level > 0.003) {
        archUniforms.uShA.value[i].set(w.x, w.hubY, w.z, w.open);
        // the bright water lies toward the lens and a little to the right of the flower, so the shadow
        // is thrown back and to the left, onto the dark wall
        archUniforms.uShB.value[i].set(w.scale, w.level, 1.2, 3.4);
      } else {
        archUniforms.uShB.value[i].set(1, 0, 0, 0);
      }
    }
    {
      const lv = s.sweep ? s.sweep.level : 0;
      if (s.sweep && lv > 0.003) {
        sweepLocal.set(s.sweep.x, s.sweep.y, s.sweep.z);
        sweepWorld.copy(sweepLocal).applyMatrix4(inner.matrixWorld);
        lampWorld[LAMPS].set(sweepWorld.x, sweepWorld.y, sweepWorld.z, 2.4 * lv);
        dummy.position.copy(sweepLocal);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(SWEEP_SCALE);
        dummy.updateMatrix();
        lamps.setMatrixAt(LAMPS, dummy.matrix);
        boosts[LAMPS] = 2.6 * lv;
        haloCentres[LAMPS * 3] = sweepLocal.x;
        haloCentres[LAMPS * 3 + 1] = sweepLocal.y - 0.1;
        haloCentres[LAMPS * 3 + 2] = sweepLocal.z;
        haloBoost[LAMPS] = 1.15 * lv;
      } else {
        lampWorld[LAMPS].set(0, -50, 0, 0);
        dummy.position.set(0, -50, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        lamps.setMatrixAt(LAMPS, dummy.matrix);
        boosts[LAMPS] = 0;
        haloBoost[LAMPS] = 0;
      }
      lamps.instanceMatrix.needsUpdate = true;
      boostAttr.needsUpdate = true;
      haloCentreAttr.needsUpdate = true;
      haloBoostAttr.needsUpdate = true;
    }
    lampUniforms.uTime.value = s.time;
    cordMat.opacity = 0.9 * s.presence * (1 - s.blackout);

    let n = 0;
    for (const d of s.drops) {
      if (n >= MAX_BEADS) break;
      // brightness: how much flower light reaches the bead
      let lightAmt = 0.32;
      for (const l of s.lights) {
        const dd = (l.x - d.x) * (l.x - d.x) + (l.y - d.y) * (l.y - d.y) + (l.z - d.z) * (l.z - d.z);
        lightAmt += (l.glow * 0.9) / (0.35 + dd);
      }
      beadPos[n * 3] = d.x;
      beadPos[n * 3 + 1] = d.y;
      beadPos[n * 3 + 2] = d.z;
      beadAmt[n] = Math.min(2.2, lightAmt) * d.a * s.presence;
      n++;
    }
    beadGeo.setDrawRange(0, n);
    (beadGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (beadGeo.attributes.aAmt as THREE.BufferAttribute).needsUpdate = true;
    beads.visible = n > 0;
    beadUniforms.uPx.value = s.pxPerUnit;
    beadUniforms.uBlackout.value = s.blackout;
  }

  return { group, axis, update, sweepWorld };
}
