import * as THREE from 'three';
import { BiolumDropSeed, BiolumInkField, MAX_UNDERWATER_PLUMES } from './inkField';
import { OilTitleFluidSystem } from './oilFluid';
import { XPBDWaterCarpet } from './waterCarpet';
import { LAMP_BEAM_GLSL } from './lampBeam';
import { DK_FOG_GLSL, PAT_GLSL } from './shot2';

export interface WaterSystemState {
  time: number;
  shadowVoid: number;
  shot1Dark?: number;
  ambientKeep?: number;
  /** Shot 1 (0..10.5s): Real Allen-Cahn oil-on-water fluid title visibility (0..1) */
  titlePresence: number;
  balatroSwirlAmount: number;
  /** Shots 3–4 (46.4..143.8s): 3D underwater sinking bioluminescent ink plumes visibility (0..1) */
  biolumInkVisibility: number;
  biolumDrops: BiolumDropSeed[];
  swirlGather: number;
  bassStandingWave: number;
  /** Shots 5–6 (143.8..243.3s): Full-width XPBD levitating liquid-silk carpet (0..1) */
  carpetLevitation: number;
  carpetWaveActivity: number;
  otherEnergy: number;
  vocalEnergy: number;
  bassEnergy: number;
  drumEnergy: number;
  beatPhase: number;
  /** Active Shylight light cores for subsurface water scatter & speculars */
  shylightLights: { pos: THREE.Vector3; glow: number }[];
  /** Shot 6: Giant centered drummer shadow on the wide floating water carpet */
  drummerShadowIntensity: number;
  drummerShadowTex: THREE.Texture | null;
  drummerShadowMatrix: THREE.Matrix4 | null;
  endingBlackout: number;
  /** Visual clock (stalls during the held breath). Ripples and ink motion follow it. */
  fxTime?: number;
  freeze?: number;
  reflComplement?: number;
  reflShiver?: number;
  underView?: number;
  underLift?: number;
  underSpan?: number;
  shadowPass?: number;
  shadowSlide?: number;
  windowLight?: number;
  causticFractal?: number;
  endTitle?: number;
  tealLeak?: number;
  strikeAge?: number;
  strikeXZ?: [number, number];
  /** Shot ② Deakins look: black mirror, warm fog, long vertical reflections (0..1). */
  dk?: number;
  dkAxis?: [number, number, number];
  dkTop?: number;
  /** Standing-wave pattern in the surface itself. */
  pat?: { cx: number; cz: number; amp: number; radius: number; resonance: number; phase: number };
  /** Shot ⑤: how much the water splits light into colours (the two 'in rainbows' lines). */
  rainbow?: number;
  /** Shot ③: light veins under the water (L-system), growth 0..1 and brightness 0..1. */
  vein?: { grow: number; level: number };
  /** Beat cue: a ring of water closing on a point, arriving in toLand seconds. */
  cue?: { x: number; z: number; toLand: number; strength: number };
}

export interface RippleFx {
  iris?: number;
  decay?: number;
  k?: number;
  grow?: number;
}

export interface WaterPoolHandles {
  waterMesh: THREE.Mesh;
  carpet: XPBDWaterCarpet;
  inkField: BiolumInkField;
  getWaveTexture: () => THREE.Texture;
  /** Injects a strictly music/interaction-driven ripple at world coordinates `(worldX, worldZ)` (or carpet UV when levitated) */
  injectWorldRipple: (
    worldX: number,
    worldZ: number,
    radiusMeters: number,
    strength: number,
    strikeCarpetUV?: [number, number],
    fx?: RippleFx
  ) => void;
  resetSimulation: (renderer: THREE.WebGLRenderer, seedTime?: number) => void;
  stepSimulation: (renderer: THREE.WebGLRenderer, dt: number, state: WaterSystemState) => void;
  renderPlanarAndRefraction: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    mainCamera: THREE.PerspectiveCamera,
    carpetLevitation: number,
    hooks?: { beforeMirror?: () => void; afterMirror?: () => void }
  ) => void;
  resize: (width: number, height: number) => void;
}

const SIM_RES = 640;

export function createWaterPoolSystem(
  _renderer: THREE.WebGLRenderer,
  poolBounds: { halfW: number; zBack: number; zFront: number; waterY: number; basinFloorY: number }
): WaterPoolHandles {
  const poolWidth = poolBounds.halfW * 2.0; // 36.0m boundless width!
  const poolLength = poolBounds.zFront - poolBounds.zBack; // 38.0m boundless depth!
  const poolCenterZ = (poolBounds.zFront + poolBounds.zBack) * 0.5; // -7.0m

  const carpet = new XPBDWaterCarpet(poolWidth, poolLength, poolCenterZ, 112, 116);
  const inkField = new BiolumInkField();
  const oilFluid = new OilTitleFluidSystem();

  const dummyBlackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  dummyBlackTex.needsUpdate = true;

  // 1. GPU 2D PDE Wave Heightfield (focused on the central 16m x 14m action stage for high crispness!)
  const rtOptions: THREE.RenderTargetOptions = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  };
  let waveRT0 = new THREE.WebGLRenderTarget(SIM_RES, SIM_RES, rtOptions);
  let waveRT1 = new THREE.WebGLRenderTarget(SIM_RES, SIM_RES, rtOptions);

  // Trilinear Mipmapped Planar Reflection & Refraction RTs -> buttery smooth, ZERO reflection staircase aliasing!
  const reflRT = new THREE.WebGLRenderTarget(1024, 640, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
  });

  const refrRT = new THREE.WebGLRenderTarget(1280, 800, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });

  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  const MAX_DROPS = 12;
  const dropCenters = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4(-10, -10, 0, 0));

  const waveStepMat = new THREE.ShaderMaterial({
    uniforms: {
      tPrev: { value: waveRT0.texture },
      uTexelSize: { value: new THREE.Vector2(1.0 / SIM_RES, 1.0 / SIM_RES) },
      uDamping: { value: 0.991 },
      uWaveSpeed: { value: 0.24 },
      uDropCount: { value: 0 },
      uDrops: { value: dropCenters },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tPrev;
      uniform vec2 uTexelSize;
      uniform float uDamping;
      uniform float uWaveSpeed;
      uniform int uDropCount;
      uniform vec4 uDrops[${MAX_DROPS}];

      void main() {
        vec2 dx = vec2(uTexelSize.x, 0.0);
        vec2 dy = vec2(0.0, uTexelSize.y);
        vec4 c = texture2D(tPrev, vUv);
        float h = c.r;
        float hPrev = c.g;

        float hL = texture2D(tPrev, vUv - dx).r;
        float hR = texture2D(tPrev, vUv + dx).r;
        float hD = texture2D(tPrev, vUv - dy).r;
        float hU = texture2D(tPrev, vUv + dy).r;
        float hDL = texture2D(tPrev, vUv - dx - dy).r;
        float hDR = texture2D(tPrev, vUv + dx - dy).r;
        float hUL = texture2D(tPrev, vUv - dx + dy).r;
        float hUR = texture2D(tPrev, vUv + dx + dy).r;

        float laplacian = (hL + hR + hD + hU) * 0.20 + (hDL + hDR + hUL + hUR) * 0.05 - h;
        float hNext = (2.0 * h - hPrev) + laplacian * uWaveSpeed;
        // A little viscosity: the velocity field is diffused as well as the height. It rounds sharp wave
        // fronts, so rings stay smooth instead of breaking into a checkerboard.
        float pL = texture2D(tPrev, vUv - dx).g;
        float pR = texture2D(tPrev, vUv + dx).g;
        float pD = texture2D(tPrev, vUv - dy).g;
        float pU = texture2D(tPrev, vUv + dy).g;
        float lapPrev = (pL + pR + pD + pU) * 0.25 - hPrev;
        float lapNow = (hL + hR + hD + hU) * 0.25 - h;
        hNext += (lapNow - lapPrev) * 0.045;

        vec2 edgeDist = min(vUv, 1.0 - vUv);
        float sponge = smoothstep(0.0, 0.06, min(edgeDist.x, edgeDist.y));
        hNext *= uDamping * (0.88 + 0.12 * sponge);

        for (int i = 0; i < ${MAX_DROPS}; i++) {
          if (i >= uDropCount) break;
          vec4 d = uDrops[i];
          vec2 diff = vUv - d.xy;
          float r = length(diff);
          float rad = max(0.005, d.z);
          float env = exp(-pow(r / rad, 2.0));
          float ringWave = (1.0 - 2.0 * pow(r / rad, 2.0)) * env;
          hNext += d.w * ringWave;
        }

        // once the water is nearly still, let it come fully to rest instead of trembling for ever
        hNext *= mix(0.975, 1.0, smoothstep(0.0, 0.004, abs(hNext) + abs(h - hPrev)));
        hNext = clamp(hNext, -1.8, 1.8);
        gl_FragColor = vec4(hNext, h, 0.0, 1.0);
      }
    `,
  });

  const simScene = new THREE.Scene();
  const simQuad = new THREE.Mesh(quadGeo, waveStepMat);
  simScene.add(simQuad);

  const pendingDrops: { x: number; y: number; radius: number; strength: number }[] = [];

  // Strictly rhythm/interaction-triggered 3D dispersion wave packets (ZERO random ripples!)
  const MAX_PACKETS = 24;
  interface RhythmWavePacket {
    worldX: number;
    worldZ: number;
    carpetU: number;
    carpetV: number;
    isCarpetSpace: boolean;
    birthTime: number;
    amplitude: number;
    radiusScale: number;
    fx: [number, number, number, number];
  }
  const activePackets: RhythmWavePacket[] = [];
  // xyz = (posX, posZ_or_V, age), w = amp * (isCarpetSpace ? -1 : +1)
  const packetUniformData = Array.from({ length: MAX_PACKETS }, () => new THREE.Vector4(0, 0, -100, 0));
  // per packet: x = rainbow edge, y = fade rate, z = wavelength scale, w = spread speed scale
  const packetFxData = Array.from({ length: MAX_PACKETS }, () => new THREE.Vector4(0, 0.46, 1, 1));
  const lightUniformData = Array.from({ length: 4 }, () => new THREE.Vector4(0, 4, -1, 0));

  // Tileable 32^3 RGBA value-noise lattice: one trilinear fetch replaces 8 hashes per 3D noise octave
  // (the underwater ink raymarch evaluates thousands of octaves per pixel — this is what keeps Shots 3-4 fluid).
  const NOISE3D_RES = 32;
  const noise3DData = new Uint8Array(NOISE3D_RES * NOISE3D_RES * NOISE3D_RES * 4);
  let noiseSeed = 0x2f6b9c3d;
  for (let i = 0; i < noise3DData.length; i++) {
    noiseSeed ^= noiseSeed << 13;
    noiseSeed ^= noiseSeed >>> 17;
    noiseSeed ^= noiseSeed << 5;
    noise3DData[i] = (noiseSeed >>> 0) & 255;
  }
  const noise3DTex = new THREE.Data3DTexture(noise3DData, NOISE3D_RES, NOISE3D_RES, NOISE3D_RES);
  noise3DTex.format = THREE.RGBAFormat;
  noise3DTex.type = THREE.UnsignedByteType;
  noise3DTex.minFilter = THREE.LinearFilter;
  noise3DTex.magFilter = THREE.LinearFilter;
  noise3DTex.wrapS = THREE.RepeatWrapping;
  noise3DTex.wrapT = THREE.RepeatWrapping;
  noise3DTex.wrapR = THREE.RepeatWrapping;
  noise3DTex.unpackAlignment = 1;
  noise3DTex.needsUpdate = true;

  // Light veins for shot ③: an L-system drawn once into a texture. R = brightness of the vein,
  // G = how late that part grows (0 at a flower's foot, 1 at the last twigs).
  const veinTex = (() => {
    const N = 1024;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = N;
      c.height = N;
      const g = c.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, N, N);
      g.lineCap = 'round';
      return [c, g] as const;
    };
    const [cGlow, gGlow] = mk();
    const [cTime, gTime] = mk();
    // world (x in -6.5..6.5, z in -5.6..4.8) -> pixels
    const px = (x: number) => (x / 13.0 + 0.5) * N;
    const pz = (z: number) => ((z + 5.6) / 10.4) * N;
    let seed = 20261115;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const seg = (x0: number, z0: number, x1: number, z1: number, w: number, t0: number, t1: number) => {
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        const a = i / steps;
        const b = (i + 1) / steps;
        const ax = x0 + (x1 - x0) * a, az = z0 + (z1 - z0) * a, bx = x0 + (x1 - x0) * b, bz = z0 + (z1 - z0) * b;
        const tt = Math.round(255 * Math.min(1, t0 + (t1 - t0) * (a + b) * 0.5));
        gTime.strokeStyle = `rgb(${tt},${tt},${tt})`;
        gTime.lineWidth = Math.max(10, w * 9);
        gTime.beginPath(); gTime.moveTo(px(ax), pz(az)); gTime.lineTo(px(bx), pz(bz)); gTime.stroke();
      }
      gGlow.strokeStyle = '#fff';
      gGlow.lineWidth = w;
      gGlow.beginPath(); gGlow.moveTo(px(x0), pz(z0)); gGlow.lineTo(px(x1), pz(z1)); gGlow.stroke();
    };
    // one rule: a vein runs on, bends a little, and now and then splits in two; each split is thinner and later
    const growVein = (x: number, z: number, ang: number, len: number, w: number, t: number, depth: number) => {
      if (depth > 6 || w < 0.5 || Math.abs(x) > 6.2 || z < -5.3 || z > 4.5) return;
      const n = 3 + Math.floor(rnd() * 2);
      let cx = x, cz = z, ca = ang, ct = t;
      for (let i = 0; i < n; i++) {
        ca += (rnd() - 0.5) * 0.55;
        const nx = cx + Math.cos(ca) * len / n, nz = cz + Math.sin(ca) * len / n;
        const nt = ct + (0.115 / n) * (0.8 + 0.4 * rnd());
        seg(cx, cz, nx, nz, w, ct, nt);
        cx = nx; cz = nz; ct = nt;
      }
      const kids = depth < 2 ? 2 : rnd() < 0.72 ? 2 : 1;
      for (let k = 0; k < kids; k++) {
        const spread = (kids === 1 ? (rnd() - 0.5) * 0.5 : (k === 0 ? -1 : 1) * (0.38 + 0.3 * rnd()));
        growVein(cx, cz, ca + spread, len * (0.70 + 0.12 * rnd()), w * 0.72, ct, depth + 1);
      }
    };
    // roots at the three flower feet (earlier staging of shot ③), each sending trunks toward the others and outward
    const feet: [number, number][] = [[0.0, 0.75], [-2.25, -0.95], [2.25, -0.95]];
    feet.forEach(([fx, fz], i) => {
      for (let k = 0; k < 5; k++) {
        const base = (k / 5) * Math.PI * 2 + i * 0.7 + (rnd() - 0.5) * 0.4;
        growVein(fx, fz, base, 1.5 + rnd() * 0.5, 4.2, 0.0, 0);
      }
    });
    // soft glow around the lines
    const [cOut, gOut] = mk();
    gOut.filter = 'blur(5px)';
    gOut.drawImage(cGlow, 0, 0);
    gOut.filter = 'none';
    gOut.globalCompositeOperation = 'lighter';
    gOut.drawImage(cGlow, 0, 0);
    const glow = gOut.getImageData(0, 0, N, N).data;
    const time = gTime.getImageData(0, 0, N, N).data;
    const data = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      data[i * 4] = glow[i * 4];
      data[i * 4 + 1] = time[i * 4];
      data[i * 4 + 3] = 255;
    }
    void cOut;
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  })();

  const waterUniforms = {
    tNoise3D: { value: noise3DTex },
    tInkVolume: { value: null as THREE.Texture | null },
    tWave: { value: waveRT0.texture },
    tReflection: { value: reflRT.texture },
    tRefraction: { value: refrRT.texture },
    tOilPaint: { value: oilFluid.paintRT.texture },
    tOilOff: { value: oilFluid.offTexture },
    tOilImg: { value: oilFluid.filmTex },
    uOilThin: { value: 0.0 },
    uTexelSize: { value: new THREE.Vector2(1.0 / SIM_RES, 1.0 / SIM_RES) },
    uTime: { value: 0.0 },
    uTitlePresence: { value: 1.0 },
    uBalatroSwirl: { value: 0.0 },
    uInkVisibility: { value: 0.0 },
    uInkCount: { value: 0 },
    uPlumePos: { value: inkField.plumePosRadius },
    uPlumeMeta: { value: inkField.plumeMeta },
    uBassStandingWave: { value: 0.0 },
    uCarpetLevitation: { value: 0.0 },
    uPackets: { value: packetUniformData },
    uPacketFx: { value: packetFxData },
    uDk: { value: 0.0 },
    uDkAxis: { value: new THREE.Vector3(0, 0, -1) },
    uDkTop: { value: 1.0 },
    uPat: { value: new THREE.Vector4(0, 0, 0, 3) },
    uPatMode: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCue: { value: new THREE.Vector4(0, 0, 9, 0) },
    uMicro: { value: 0.0 },
    uRainbow: { value: 0.0 },
    // the swell field of the lifted sheet, for per-pixel normals (see carpetPoint in the shader)
    uCarpetDims: { value: new THREE.Vector3(poolWidth, poolLength, poolCenterZ) },
    uCarpetWave: { value: new THREE.Vector4(0, 0, 1, 0) },
    uCarpetLift: { value: 0.0 },
    uCarpetStrikes: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uCarpetAnalyticN: { value: 1.0 },
    tVein: { value: veinTex as THREE.Texture },
    uVein: { value: new THREE.Vector2(0, 0) },
    uLights: { value: lightUniformData },
    uDrummerShadow: { value: 0.0 },
    uDrummerTex: { value: dummyBlackTex as THREE.Texture },
    uDrummerMat: { value: new THREE.Matrix4() },
    uBlackout: { value: 0.0 },
    uShot1Dark: { value: 0.0 },
    uAmbientKeep: { value: 1.0 },
    uReflComplement: { value: 0.0 },
    uReflShiver: { value: 0.0 },
    uUnderView: { value: 0.0 },
    uShadowPass: { value: 0.0 },
    uShadowSlide: { value: 0.0 },
    uWindowLight: { value: 1.0 },
    uFractal: { value: 0.0 },
    uEndTitle: { value: 0.0 },
    tTitleMask: { value: oilFluid.maskTex as THREE.Texture },
    uTealLeak: { value: 0.0 },
    uStrikeAge: { value: 99.0 },
    uStrikeXZ: { value: new THREE.Vector2(0, -1.2) },
    uRealTime: { value: 0.0 },
  };

  const waterMat = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vGeomNormal;
      varying vec4 vScreenPos;

      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vGeomNormal = normalize(mat3(modelMatrix) * normal);
        vScreenPos = projectionMatrix * viewMatrix * wp;
        gl_Position = vScreenPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vGeomNormal;
      varying vec4 vScreenPos;

      uniform sampler2D tWave;
      uniform sampler2D tReflection;
      uniform sampler2D tRefraction;
      uniform sampler2D tOilPaint;
      uniform sampler2D tOilOff;
      uniform sampler2D tOilImg;
      uniform float uOilThin;
      // Shot ① film, read straight from the authored picture (full resolution, filtered) through the
      // flow-carried offset field. rgb = film colour, a = film height / coverage.
      vec4 oilFilm(vec2 uv) {
        vec2 src = uv + texture2D(tOilOff, uv).xy;
        vec3 c = texture2D(tOilImg, src).rgb;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec2 e = smoothstep(0.0, 0.10, uv) * smoothstep(0.0, 0.10, 1.0 - uv);
        vec2 es = smoothstep(0.0, 0.02, src) * smoothstep(0.0, 0.02, 1.0 - src);
        float keep = smoothstep(uOilThin * 1.2 - 0.2, uOilThin * 1.2, lum) * e.x * e.y * es.x * es.y;
        return vec4(c * keep, smoothstep(0.008, 0.22, lum) * keep);
      }
      precision highp sampler3D;
      uniform sampler3D tNoise3D;
      #ifndef INK_PASS
      uniform sampler2D tInkVolume;
      #endif
      uniform vec2 uTexelSize;
      uniform float uTime;
      uniform float uTitlePresence;
      uniform float uBalatroSwirl;
      uniform float uInkVisibility;
      uniform int uInkCount;
      uniform vec4 uPlumePos[${MAX_UNDERWATER_PLUMES}];
      uniform vec4 uPlumeMeta[${MAX_UNDERWATER_PLUMES}];
      uniform float uBassStandingWave;
      uniform float uCarpetLevitation;
      uniform vec4 uPackets[${MAX_PACKETS}];
      uniform vec4 uPacketFx[${MAX_PACKETS}];
      uniform float uDk;
      uniform vec4 uPat;
      uniform vec4 uPatMode;
      uniform vec4 uCue;
      uniform float uMicro;
      uniform float uRainbow;
      uniform vec3 uCarpetDims;      // grounded width, length, z centre
      uniform vec4 uCarpetWave;      // x = song time, y = wave activity, z = musical gain, w = under-span
      uniform float uCarpetLift;
      uniform vec4 uCarpetStrikes[6]; // uvX, uvY, age, strength
      uniform float uCarpetAnalyticN;
      uniform sampler2D tVein;
      uniform vec2 uVein;
      uniform vec4 uLights[4];
      uniform float uDrummerShadow;
      uniform sampler2D uDrummerTex;
      uniform mat4 uDrummerMat;
      uniform float uBlackout;
      uniform float uShot1Dark;
      uniform float uAmbientKeep;
      uniform float uReflComplement;
      uniform float uReflShiver;
      uniform float uUnderView;
      uniform float uShadowPass;
      uniform float uShadowSlide;
      uniform float uWindowLight;
      uniform float uFractal;
      uniform float uEndTitle;
      uniform sampler2D tTitleMask;
      uniform float uTealLeak;
      uniform float uStrikeAge;
      uniform vec2 uStrikeXZ;
      uniform float uRealTime;
      ${LAMP_BEAM_GLSL}
      ${DK_FOG_GLSL}

      ${PAT_GLSL}

      // Short wind waves riding on whatever the large surface is doing: seven trains, each shorter than
      // the last, every one heading a different way, moving at the speed real water of that wavelength
      // moves (slowed a little). Patches of more and less wind drift across so it is never uniform, and
      // trains too fine for the pixel grid fade out instead of sparkling.
      vec2 microWaveGrad(vec2 p, float t) {
        vec2 g = vec2(0.0);
        float foot = max(fwidth(p.x), fwidth(p.y));
        float gust = 0.50 + 0.95 * lbNoise(p * 0.11 + vec2(t * 0.05, -t * 0.035));
        float ang = 0.6;
        float lambda = 2.6;
        for (int i = 0; i < 7; i++) {
          float k = 6.2832 / lambda;
          vec2 d = vec2(cos(ang), sin(ang));
          float th = dot(d, p) * k - 1.95 * sqrt(k) * t + float(i) * 1.7;
          float aa = 1.0 - smoothstep(0.20, 0.45, foot / lambda);
          g += d * ((cos(th) + 0.30 * cos(2.0 * th)) * 0.060 * aa);
          ang += 2.39996;
          lambda *= 0.70;
        }
        return g * gust;
      }

      float hash31(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }

      // Quintic-faded value noise from the 32^3 lattice texture (single hardware-trilinear fetch)
      vec4 vnoise3v4(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return texture(tNoise3D, (i + f + 0.5) / 32.0);
      }

      float vnoise3(vec3 p) {
        return vnoise3v4(p).r;
      }

      // Three decorrelated fbm channels in one pass (domain-warp vector)
      vec3 fbm3v(vec3 p) {
        vec3 s = vec3(0.0);
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          s += a * vnoise3v4(p).gba;
          p = p * 2.05 + vec3(4.1, 7.3, 2.9);
          a *= 0.5;
        }
        return s;
      }

      float fbm3(vec3 p) {
        float s = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          s += a * vnoise3(p);
          p = p * 2.05 + vec3(4.1, 7.3, 2.9);
          a *= 0.5;
        }
        return s;
      }

      // 5-stop chroma-preserving mother-of-pearl thermal rainbow for 3D underwater ink plumes!
      vec3 underwaterThermalSpectrum(float u, float hueShift) {
        float x = clamp(u + hueShift * 0.10, 0.0, 1.0);
        vec3 c0GlacialCyan = vec3(0.12, 0.84, 0.98);
        vec3 c1AbyssIndigo = vec3(0.32, 0.44, 0.98);
        vec3 c2OrchidSilk  = vec3(0.68, 0.34, 0.90);
        vec3 c3RoseCoral   = vec3(0.96, 0.44, 0.64);
        vec3 c4AmberCore   = vec3(1.00, 0.72, 0.28);
        if (x < 0.25) return mix(c0GlacialCyan, c1AbyssIndigo, x / 0.25);
        if (x < 0.50) return mix(c1AbyssIndigo, c2OrchidSilk, (x - 0.25) / 0.25);
        if (x < 0.75) return mix(c2OrchidSilk, c3RoseCoral, (x - 0.50) / 0.25);
        return mix(c3RoseCoral, c4AmberCore, (x - 0.75) / 0.25);
      }

      // 3-octave variant for the fine ridge layer (its 4th octave was sub-pixel at viewing distance)
      float ridgeFbm3Fine(vec3 p) {
        float s = 0.0;
        float a = 0.55;
        for (int i = 0; i < 3; i++) {
          float n = 1.0 - abs(vnoise3(p) * 2.0 - 1.0);
          s += a * (n * n);
          p = p * 2.12 + vec3(3.7, 6.9, 2.3);
          a *= 0.48;
        }
        return s + 0.012;
      }

      float ridgeFbm3(vec3 p) {
        float s = 0.0;
        float a = 0.55;
        for (int i = 0; i < 4; i++) {
          float n = 1.0 - abs(vnoise3(p) * 2.0 - 1.0);
          s += a * (n * n);
          p = p * 2.12 + vec3(3.7, 6.9, 2.3);
          a *= 0.48;
        }
        return s;
      }

      /**
       * Evaluates High-Schmidt-Number (Sc >> 1000) Macro Ink-in-Water 3D Volume at underwater point P (y < 0)!
       * Carves crisp Alberto Seveso folded ink curtains, rolled Rayleigh-Taylor mushroom vortex spirals,
       * and slender vertical feeder stems plunging down from y = 0, with deep Prussian-indigo internal fold shadows!
       */
      vec4 sampleUnderwaterInkVolume(vec3 P) {
        vec3 totalGlow = vec3(0.0);
        float totalDensity = 0.0;
        vec3 upLightDir = normalize(vec3(0.15, 0.88, 0.44));

        for (int i = 0; i < ${MAX_UNDERWATER_PLUMES}; i++) {
          if (i >= uInkCount) break;
          vec4 pl = uPlumePos[i]; // xyz = vortex head 3D center (y < 0), w = scale R
          vec4 mt = uPlumeMeta[i]; // x = age, y = strength, z = seed, w = hueShift

          float R = pl.w * (0.38 + 0.62 * (1.0 - exp(-mt.x / 2.6)));
          vec3 relHead = P - pl.xyz;
          if (abs(relHead.x) > R * 2.05 || abs(relHead.z) > R * 2.05 || P.y < pl.y - R * 1.45 || P.y > -0.015) continue;

          // Helical swirl + domain-warped curl displacement -> crisp rolled ink curtains rather than blurry Gaussian steam!
          vec3 seedOff = vec3(mt.z * 1.31, mt.z * 0.73, mt.z * 2.17);
          float twistAng = (P.y - pl.y) * 2.2 + mt.z * 0.5;
          float csT = cos(twistAng);
          float snT = sin(twistAng);
          vec3 twistedRel = vec3(relHead.x * csT - relHead.z * snT, relHead.y, relHead.x * snT + relHead.z * csT);
          vec3 qP = pl.xyz + twistedRel;

          vec3 warp = (fbm3v(qP * 2.55 + seedOff + vec3(0.0, mt.x * 0.15, 0.0)) - 0.5) * (R * 0.56);

          vec3 wp = qP + warp;

          // 1. Rolled 3D Rayleigh-Taylor Mushroom Cap + Curled Toroidal Vortex Lip at pl.xyz
          vec2 dXZ = wp.xz - pl.xz;
          float rHoriz = length(dXZ);
          // Concave-underneath umbrella cap curve: yCap drops slightly at rHoriz ~ 0.58*R (rolled lip!)
          float umbrellaY = pl.y + R * 0.22 * (1.0 - 1.65 * (rHoriz * rHoriz) / max(0.02, R * R));
          float capShellDist = abs(wp.y - umbrellaY) / (R * 0.21);
          float capRadialMask = 1.0 - smoothstep(R * 0.62, R * 1.02, rHoriz);
          float umbrellaCap = exp(-capShellDist * capShellDist * 2.6) * capRadialMask;

          // Tight curled toroidal vortex ring tucked beneath the mushroom rim
          float torusDist = length(vec2(rHoriz - R * 0.58, (wp.y - (pl.y - R * 0.08)) * 1.45)) / (R * 0.25);
          float vortexRing = exp(-torusDist * torusDist * 3.4);

          // 2. Slender Vertical Feeder Stem + Secondary Ribbon Tendrils plunging straight down from y = -0.02 to pl.y!
          float stemMaskY = smoothstep(pl.y - R * 0.05, pl.y + R * 0.22, wp.y) * smoothstep(-0.01, -0.09, wp.y);
          float stemRadius = R * (0.12 + 0.06 * sin(wp.y * 7.5 + mt.z));
          float stem = stemMaskY * exp(-(rHoriz * rHoriz) / max(0.003, stemRadius * stemRadius));

          // Secondary trailing tendrils around the stem
          vec2 tendrilOff = dXZ - vec2(sin(wp.y * 4.6 + mt.z), cos(wp.y * 4.2 - mt.z)) * (R * 0.24);
          float tendril = stemMaskY * 0.72 * exp(-dot(tendrilOff, tendrilOff) / max(0.0025, R * R * 0.016));

          // Crisp ridge-billow ink curtain folds (high contrast between razor-thin ink ribbons & clear dark water!)
          float ridgeA = ridgeFbm3(wp * 4.2 - seedOff);
          float ridgeB = ridgeFbm3Fine(wp * 8.1 + seedOff * 1.7);
          float crispCurtains = smoothstep(0.24, 0.76, ridgeA * 0.72 + ridgeB * 0.42);

          float rawMacro = umbrellaCap * 1.25 + vortexRing * 1.55 + stem * 1.35 + tendril * 0.95;
          float dens = smoothstep(0.08, 0.78, rawMacro * (0.32 + 1.05 * crispCurtains)) * mt.y * 1.65;

          if (dens > 0.006) {
            // Sharp internal 3D self-shadowing: lit upper crowns & outer folds glow vivid bioluminescent mother-of-pearl,
            // while tucked inner folds & undersides drop to deep velvety Prussian-indigo / sumi-black (#040b18)!
            vec3 approxNorm = normalize(vec3(dXZ.x, (wp.y - pl.y) * 1.65 + 0.22, dXZ.y) + vec3(1e-4));
            float sunFacing = clamp(0.5 + 0.5 * dot(approxNorm, upLightDir), 0.0, 1.0);
            float foldCrest = smoothstep(0.25, 0.85, ridgeA);

            float normOutward = clamp(max(rHoriz / (R * 0.98), (pl.y - wp.y) / (R * 0.58)), 0.0, 1.0);
            float stemWarmBoost = (stem + tendril * 0.5) * 0.42;
            float ageWarm = smoothstep(0.08, 3.2, mt.x);
            float uTherm = clamp((1.0 - pow(normOutward, 0.75)) * ageWarm + stemWarmBoost, 0.0, 1.0);

            vec3 litBiolum = underwaterThermalSpectrum(uTherm, mt.w);
            vec3 deepPrussianFold = vec3(0.012, 0.032, 0.085);
            float shadeMix = clamp(sunFacing * (0.45 + 0.65 * foldCrest), 0.0, 1.0);
            vec3 inkColor = mix(deepPrussianFold, litBiolum * 1.42, pow(shadeMix, 1.15));

            totalGlow += inkColor * dens;
            totalDensity += dens * 1.35;
          }
        }

        return vec4(totalGlow, totalDensity);
      }

      // Five-ink psychedelic ramp (magenta, tangerine, gold, teal, violet), smooth and cyclic.
      vec3 psyRamp(float x) {
        float f = fract(x) * 5.0;
        vec3 c0 = vec3(1.00, 0.08, 0.52);
        vec3 c1 = vec3(1.00, 0.46, 0.05);
        vec3 c2 = vec3(1.00, 0.84, 0.16);
        vec3 c3 = vec3(0.03, 0.82, 0.74);
        vec3 c4 = vec3(0.42, 0.16, 0.98);
        vec3 c = mix(c0, c1, smoothstep(0.0, 1.0, f));
        c = mix(c, c2, smoothstep(1.0, 2.0, f));
        c = mix(c, c3, smoothstep(2.0, 3.0, f));
        c = mix(c, c4, smoothstep(3.0, 4.0, f));
        c = mix(c, c0, smoothstep(4.0, 5.0, f));
        return c;
      }

      // World position of the lifted sheet at (u, v): a copy of sampleTargetCarpetField in waterCarpet.ts.
      // Keep the two in step.
      vec3 carpetPoint(vec2 uv) {
        float lev = clamp(uCarpetLevitation, 0.0, 1.0);
        float sl = lev * lev * (3.0 - 2.0 * lev);
        float t = uCarpetWave.x;
        float span = uCarpetWave.w;
        float W = mix(uCarpetDims.x, 16.0 + 8.0 * span, sl);
        float L = mix(uCarpetDims.y, 9.6 + 7.4 * span, sl);
        float Zc = mix(uCarpetDims.z, -1.2 - 1.3 * span, sl);
        float nx = (uv.x - 0.5) * 2.0;
        float nz = (0.5 - uv.y) * 2.0;
        float anx = abs(nx);
        float anz = abs(nz);
        float cornerRoundZ = 1.0 - 0.24 * pow(anx, 2.6) * sl;
        float cornerRoundX = 1.0 - 0.10 * pow(anz, 2.8) * sl;
        float wavyHemZ = (sin(nx * 3.6 + t * 1.45) * 0.34 + cos(nx * 6.8 - t * 1.95) * 0.16) * pow(anz, 1.6) * sl;
        float wavyHemX = sin(nz * 3.2 - t * 1.35) * 0.28 * pow(anx, 1.8) * sl;
        float bx = nx * 0.5 * W * cornerRoundX + wavyHemX;
        float bz = Zc + nz * 0.5 * L * cornerRoundZ + wavyHemZ;

        float dome = exp(-(nx * nx * 1.35 + nz * nz * 1.45));
        float arch = sin(lev * 3.14159265) * (dome * 0.78 - (1.0 - dome) * 0.32);
        float baseY = (1.48 + 0.95 * uCarpetLift) * sl + arch;
        float act = uCarpetWave.y * sl;

        float climax = smoothstep(178.0, 185.0, t) * (1.0 - smoothstep(193.0, 197.5, t));
        const float om = 2.25;
        float grand = sin(bx * 0.56 + om * t + sin(bz * 0.45 - t * 0.72) * 0.65);
        float diag = sin(bx * 0.92 - bz * 0.78 + om * 1.35 * t + 0.8);
        float drape = cos(bx * 1.25 + bz * 0.80 + om * 1.55 * t) * 0.25;
        float climaxWave = sin(bx * 0.46 - bz * 0.38 + t * 2.05) * 0.44 + cos(bx * 0.88 + bz * 0.62 - t * 2.65) * 0.24;
        float edgeF = 0.35 * anx * anx + 0.65 * pow(anz, 1.8);
        float hem = sin(bx * 1.08 + t * 2.55 + nz * 1.4) * edgeF * 0.34;
        float wave = ((grand * 0.32 + diag * 0.20 + drape * 0.11 + hem) * uCarpetWave.z + climaxWave * climax * 0.85) * act;

        for (int i = 0; i < 6; i++) {
          vec4 st = uCarpetStrikes[i];
          if (st.w <= 0.0) continue;
          float r = length(vec2((uv.x - st.x) * W, (st.y - uv.y) * L));
          float age = st.z;
          float bowl = -0.34 * exp(-(r * r) / 0.32) * exp(-age * 7.5);
          float rimD = (r - (0.48 + age * 1.8)) / 0.28;
          float crown = 0.21 * exp(-rimD * rimD) * exp(-age * 3.2);
          float frontR = 0.35 + age * 3.15;
          float envD = (r - frontR * 0.72) / max(0.38, frontR * 0.48);
          float env = exp(-envD * envD) * exp(-age * 1.15) * smoothstep(0.02, 0.14, age);
          wave += (bowl + crown + 0.16 * cos((r - frontR) * 4.6) * env) * st.w * sl;
        }

        float ox = -cos(bx * 0.56 + om * t) * (0.16 + 0.12 * climax) * act;
        float oz = sin(bz * 0.62 + t * 1.15) * 0.09 * act;
        return vec3(bx + ox, baseY + wave, bz + oz);
      }

      void main() {
        // Map central stage [-8..+8] x [-8..+6] onto tWave UV [0..1] (when grounded) or carpet vUv (when airborne)
        vec2 stageWaveUv = mix(
          clamp(vec2(vWorldPos.x / 16.0 + 0.5, 0.5 - (vWorldPos.z + 1.0) / 14.0), 0.002, 0.998),
          vUv,
          uCarpetLevitation
        );

        vec2 dx = vec2(uTexelSize.x, 0.0);
        vec2 dy = vec2(0.0, uTexelSize.y);
        float hL = texture2D(tWave, stageWaveUv - dx).r;
        float hR = texture2D(tWave, stageWaveUv + dx).r;
        float hD = texture2D(tWave, stageWaveUv - dy).r;
        float hU = texture2D(tWave, stageWaveUv + dy).r;
        vec2 pdeGrad = vec2(hR - hL, hU - hD) * 0.42;

        // Strictly Music-Driven & Interaction-Driven 3D Dispersion Ripples (ZERO random ripples!)
        vec2 capGrad = vec2(0.0);
        float ringCrestSum = 0.0;
        float irisAmt = 0.0;
        float patFoot = max(fwidth(vWorldPos.x), fwidth(vWorldPos.z));

        for (int i = 0; i < ${MAX_PACKETS}; i++) {
          vec4 pkt = uPackets[i];
          float age = pkt.z;
          float rawW = pkt.w;
          float amp = abs(rawW);
          if (age <= 0.0 || age > 5.2 || amp <= 0.001) continue;

          vec2 delta;
          if (rawW < 0.0) {
            // Carpet UV space (16.0m x 9.6m)
            delta = vec2((vUv.x - pkt.x) * 16.0, (pkt.y - vUv.y) * 9.6);
          } else {
            // World ocean space (worldX, worldZ)
            delta = vec2(vWorldPos.x - pkt.x, vWorldPos.z - pkt.y);
          }

          vec4 fxp = uPacketFx[i];
          float r = length(delta);
          float maxR = 0.22 + age * 1.25 * fxp.w;
          if (r > maxR + 0.35) continue;

          // Smooth physical gravity-capillary wave packet (3–4 supple sculptural liquid swells, NOT thin wireframe rings!)
          float innerFade = smoothstep(0.03, 0.18, r);
          float outerFade = smoothstep(maxR + 0.25, maxR - 0.22, r);
          float bell = exp(-pow(abs((r - maxR * 0.62) / max(0.18, maxR * 0.42)), 2.0));
          float timeDecay = exp(-age * fxp.y) * smoothstep(0.0, 0.10, age);
          float env = innerFade * outerFade * (0.35 + 0.65 * bell) * timeDecay * amp;

          if (env > 0.001) {
            float k = 15.5 * fxp.z; // ~40cm rich sculptural wavelength -> 3D liquid volume waves with zero moiré aliasing!
            // the rainbow lives on the leading edge of an on-beat ring
            irisAmt += fxp.x * env * smoothstep(maxR * 0.35, maxR * 0.9, r) * 2.2;
            float phase = k * r - 13.5 * age;
            float s = sin(phase);
            float c = cos(phase);
            vec2 dir = r > 0.0001 ? (delta / r) : vec2(0.0, 1.0);
            capGrad += dir * c * env * 0.36;
            ringCrestSum += max(0.0, s) * env;
          }
        }

        // Standing-wave pattern: part of the surface, so reflections, glints and the pool of light all bend with it.
        if (uPat.z > 0.002) {
          vec2 pq = vWorldPos.xz - uPat.xy;
          const float pe = 0.03;
          float phx = patHeight(pq + vec2(pe, 0.0), patFoot) - patHeight(pq - vec2(pe, 0.0), patFoot);
          float phz = patHeight(pq + vec2(0.0, pe), patFoot) - patHeight(pq - vec2(0.0, pe), patFoot);
          vec2 patGrad = vec2(phx, phz) / (2.0 * pe) * uPat.z * 0.080;
          capGrad += patGrad;
          float pr = length(pq);
          irisAmt += smoothstep(0.30, 0.95, uPatMode.x) * exp(-(pr * pr) / (uPat.w * uPat.w)) * clamp(length(patGrad) * 4.0, 0.0, 1.0);
        }
        irisAmt = clamp(irisAmt, 0.0, 1.0);

        // Beat cue: one ridge of water closing on the flower's foot; it reaches the centre exactly on the
        // strong beat. It is relief like everything else, and reads through the glint it carries inward.
        float cueSheen = 0.0;
        if (uCue.w > 0.002 && uCue.z > 0.0 && uCue.z < 1.05) {
          vec2 cd = vWorldPos.xz - uCue.xy;
          float cr = length(cd);
          float cR = uCue.z * 1.55 + 0.05;
          float cw = 0.085 + 0.10 * uCue.z;
          float cx = (cr - cR) / cw;
          float cprof = exp(-cx * cx);
          float camp = uCue.w * smoothstep(1.05, 0.80, uCue.z) * (0.45 + 0.55 * smoothstep(1.0, 0.0, uCue.z));
          capGrad += (cd / max(cr, 1e-3)) * (-2.0 * cx) * cprof * camp * 0.48;
          ringCrestSum += cprof * camp * 1.3;
          cueSheen = cprof * camp;
        }

        if (uMicro > 0.002) capGrad += microWaveGrad(vWorldPos.xz, uRealTime) * uMicro;

        // Subtle long-wavelength deep-sea swell (synced strictly to Reckoner's 103.36 BPM bar breath, never noisy)
        float oceanBreathPhase = uTime * 1.35;
        vec2 deepSwellGrad = vec2(
          cos(vWorldPos.x * 0.28 + vWorldPos.z * 0.18 + oceanBreathPhase) * 0.012,
          sin(vWorldPos.z * 0.32 - vWorldPos.x * 0.15 + oceanBreathPhase * 0.5) * 0.014
        );

        // Shot 4 Bass 2D Crossed-Diamond & Radial Faraday Interference Lattice (85.7s+ — ZERO 1D horizontal zebra stripes!)
        float standingCrest = 0.0;
        if (uBassStandingWave > 0.002) {
          // Crossed diagonal + radial wavevectors around the trio stage so crests form organic 2D diamond liquid cells!
          vec2 kDiagA = vec2(1.48, 1.32);
          vec2 kDiagB = vec2(-1.42, 1.38);
          float wA = sin(dot(vWorldPos.xz, kDiagA) - uTime * 2.45);
          float wB = sin(dot(vWorldPos.xz, kDiagB) - uTime * 2.15 + 1.2);
          float rCenter = length(vWorldPos.xz - vec2(0.0, -0.2));
          float wRad = cos(rCenter * 2.15 - uTime * 2.85) * exp(-rCenter * 0.14);
          float lattice = (wA * wB) * 0.65 + wRad * 0.45;
          vec2 latGrad = (kDiagA * cos(dot(vWorldPos.xz, kDiagA) - uTime * 2.45) * wB +
                          kDiagB * wA * cos(dot(vWorldPos.xz, kDiagB) - uTime * 2.15 + 1.2)) * 0.024;
          capGrad += latGrad * uBassStandingWave;
          standingCrest = pow(max(0.0, lattice), 2.4) * uBassStandingWave * 0.68;
        }

        // Sample Shot 1 Oil-Film Fluid (RECKONER Allen-Cahn oil lenses!) in foreground ocean box
        // x in [-4.85m .. +4.85m] (~9.7m wide across foreground!), z in [-1.85m .. +3.00m]!
        vec4 oilSample = vec4(0.0);
        vec2 oilGrad = vec2(0.0);
        float oilBox = 0.0;
        if (uTitlePresence > 0.002 && uCarpetLevitation < 0.05) {
          vec2 oilUv = vec2(
            vWorldPos.x / 20.0 + 0.5,
            0.5 - (vWorldPos.z + 2.93) / 19.0
          );
          vec2 ob = smoothstep(0.01, 0.12, oilUv) * smoothstep(0.01, 0.12, 1.0 - oilUv);
          oilBox = ob.x * ob.y;
          if (oilUv.x > 0.01 && oilUv.x < 0.99 && oilUv.y > 0.01 && oilUv.y < 0.99) {
            oilSample = oilFilm(oilUv);
            float epsO = 2.5 / 512.0;
            float oL = oilFilm(oilUv - vec2(epsO, 0.0)).a;
            float oR = oilFilm(oilUv + vec2(epsO, 0.0)).a;
            float oD = oilFilm(oilUv - vec2(0.0, epsO * 2.0)).a;
            float oU = oilFilm(oilUv + vec2(0.0, epsO * 2.0)).a;
            // Physical convex oil-drop meniscus lens normal!
            oilGrad = vec2(oR - oL, -(oU - oD)) * 0.22 * uTitlePresence;
          }
        }

        // Shot 1 Balatro swirl on the water itself: a slow rotating spiral of low swells centred under the title.
        // Seen only where the lamp catches it (glints and reflections wind around the word).
        if (uBalatroSwirl > 0.002 && uShot1Dark > 0.002) {
          vec2 sp = vWorldPos.xz - vec2(0.0, 0.55);
          float sr = length(sp) + 1e-3;
          float sa = atan(sp.y, sp.x);
          float spiralPhase = sa * 3.0 + sr * 2.6 - uTime * 0.9;
          float env = exp(-sr * sr / 30.0) * smoothstep(0.2, 1.2, sr);
          // gradient of sin(spiralPhase) w.r.t. x,z
          vec2 dPhase = vec2(-sp.y, sp.x) / (sr * sr) * 3.0 + sp / sr * 2.6;
          capGrad += cos(spiralPhase) * dPhase * env * 0.045 * uBalatroSwirl;
        }

        // Franklin's "oil on troubled waters": thick oil film slightly calms high-frequency ripples underneath it
        float oilCalm = 1.0 - 0.55 * clamp(oilSample.a * uTitlePresence, 0.0, 1.0);
        vec2 totalGrad = (pdeGrad + capGrad + deepSwellGrad) * oilCalm + oilGrad;

        // The lifted sheet: its normal is worked out here, per pixel, from the same swell formula that
        // places the vertices. Normals carried by the vertices are only linear inside each 20 cm cell, and
        // the underwater window is so sensitive to the normal that every cell edge showed as a ridge.
        vec3 geomN = vGeomNormal;
        if (uCarpetLevitation > 0.002 && uCarpetAnalyticN > 0.5) {
          const float e = 1.0 / 1024.0;
          vec3 p0 = carpetPoint(vUv);
          vec3 pu = carpetPoint(vUv + vec2(e, 0.0));
          vec3 pv = carpetPoint(vUv + vec2(0.0, e));
          vec3 nA = cross(pv - p0, pu - p0);
          nA *= nA.y < 0.0 ? -1.0 : 1.0;
          geomN = normalize(nA + vec3(0.0, 1e-7, 0.0));
        }
        vec3 baseN = normalize(gl_FrontFacing ? geomN : -geomN);
        vec3 N = normalize(baseN + vec3(-totalGrad.x, 0.0, -totalGrad.y) * 0.95);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float NoV = clamp(dot(N, V), 0.004, 1.0);

        // =====================================================================
        // TRUE 3A GAME SINGLE-LAYER WATER: SCHLICK FRESNEL + DEEP VOLUMETRIC REFRACTION!
        // - Near foreground (NoV ~ 0.35..0.58): Fresnel is low (~0.06..0.18), so 1 - Fresnel (~85%!)
        //   PENETRATES DEEP INTO THE ABYSSAL WATER VOLUME (y < 0), revealing meters of 3D underwater depth,
        //   subsurface volumetric light shafts, and 3D sinking bioluminescent ink clouds!
        // - Far distance (NoV -> 0.05): Fresnel -> 0.85+, smoothly becoming a dark atmospheric mirror
        //   before melting seamlessly into the Deep-Sea Volumetric Mist Theater!
        // =====================================================================
        float F0 = 0.022;
        float fresnel = F0 + (1.0 - F0) * pow(1.0 - NoV, 5.0);

        vec2 screenUV = clamp(vScreenPos.xy / max(0.001, vScreenPos.w) * 0.5 + 0.5, 0.002, 0.998);

        // Snell's Law Refracted Underwater Ray (IOR_air / IOR_water = 1.0 / 1.333 = 0.75)!
        vec3 refrRay = refract(-V, N, 0.75);
        if (dot(refrRay, refrRay) < 0.01) {
          refrRay = normalize(vec3(-V.x * 0.5, -0.85, -V.z * 0.5));
        }

        // 1. Crystal-Clear Dark Obsidian-Navy Underwater Volume (#020710) + Diagonal Subsurface Tyndall Shafts!
        // Keeps un-inked water deep, dark, and glassy so 3D bioluminescent plumes & planar reflections pop with huge contrast!
        float opticalPathFactor = 1.0 / max(0.22, -refrRay.y);
        vec3 subProbe1 = vWorldPos + refrRay * 0.95;
        vec3 subProbe2 = vWorldPos + refrRay * 2.35;
        float diagBeamCoord = subProbe1.x * 0.72 - subProbe1.y * 0.45 - subProbe1.z * 0.28;
        float subShafts = pow(max(0.0, 0.5 + 0.5 * sin(diagBeamCoord * 1.35 + uTime * 0.18)), 4.0) *
                          exp(-dot(vWorldPos.xz, vWorldPos.xz) / 38.0);
        float subCausticNear = pow(max(0.0, 0.5 + 0.5 * sin(subProbe1.x * 1.85 + cos(subProbe1.z * 1.65 - uTime * 0.75))), 4.5);

        vec3 deepScatterBase =
          vec3(0.0025, 0.0075, 0.0155) +
          vec3(0.0085, 0.0220, 0.0350) * subShafts +
          vec3(0.0045, 0.0125, 0.0210) * subCausticNear;

        // Focused warm subsurface shafts piercing INTO the dark water directly beneath active Shylight blossoms!
        for (int i = 0; i < 4; i++) {
          float g = uLights[i].w;
          if (g <= 0.005) continue;
          float dSub = length(subProbe1.xz - uLights[i].xz);
          float subCone = exp(-(dSub * dSub) / 2.6);
          deepScatterBase += vec3(0.032, 0.022, 0.011) * g * subCone;
        }

        // Oil lens refractive caustic focus into the underwater volume right beneath "RECKONER" in Shot 1!
        if (oilSample.a > 0.01 && uTitlePresence > 0.002) {
          float oilFocus = clamp(length(oilGrad) * 6.5, 0.0, 1.8);
          deepScatterBase += vec3(0.065, 0.042, 0.016) * oilFocus * uTitlePresence;
        }

        // Shot 1: the only light is the overhead lamp. Outside its pool the water body falls to near-black;
        // inside it, lamp light that entered the surface glows faintly in the volume below.
        float s1Pool = 0.0;
        if (uShot1Dark > 0.002) {
          s1Pool = lbIrradiance(vec3(vWorldPos.x, 0.0, vWorldPos.z));
          float s1Sub = lbIrradiance(subProbe1) * 0.7 + lbIrradiance(subProbe2) * 0.3;
          vec3 s1Body = deepScatterBase * 0.12
                      + vec3(0.010, 0.026, 0.034) * s1Pool
                      + LB_COL * 0.075 * s1Sub * (0.55 + 0.45 * subCausticNear);
          deepScatterBase = mix(deepScatterBase, s1Body, uShot1Dark);
        }

        vec3 underwaterVolumeCol = deepScatterBase * clamp(opticalPathFactor * 0.55, 0.50, 1.35);

        // Shot ③: veins of light under the water, an L-system that grows out from the foot of each flower
        // until the three are joined. They lie about half a metre down and are seen through the surface,
        // so every ripple bends them. A slow pulse runs outward along them from the flowers.
        if (uVein.y > 0.002) {
          vec3 pv = vWorldPos + refrRay * (0.55 / max(0.25, -refrRay.y));
          vec2 vuv = vec2(pv.x / 13.0 + 0.5, (pv.z + 5.6) / 10.4);
          if (vuv.x > 0.0 && vuv.x < 1.0 && vuv.y > 0.0 && vuv.y < 1.0) {
            vec4 vt = texture2D(tVein, vuv);
            float arrived = smoothstep(uVein.x + 0.02, uVein.x - 0.05, vt.g);
            float tip = exp(-((vt.g - uVein.x) * (vt.g - uVein.x)) / 0.0012) * step(uVein.x, 0.985);
            float pulse = 0.62 + 0.38 * sin(vt.g * 34.0 - uRealTime * 2.2);
            vec3 veinCol = mix(vec3(1.0, 0.74, 0.40), vec3(0.42, 0.90, 0.84), smoothstep(0.25, 1.0, vt.g) * 0.55);
            underwaterVolumeCol += (veinCol * arrived * pulse * 0.30 + vec3(1.0, 0.80, 0.52) * tip * 0.38) * vt.r * uVein.y;
          }
        }

        // Shot ②: black mirror. The body carries no blue; only the light that falls in under a flower
        // glows faintly amber in the water beneath it.
        if (uDk > 0.002) {
          vec3 dkBody = vec3(0.0008, 0.0007, 0.0006);
          for (int i = 0; i < 4; i++) {
            float g = uLights[i].w;
            if (g <= 0.005) continue;
            float dSub = length(subProbe1.xz - uLights[i].xz);
            float hL = max(0.2, uLights[i].y);
            dkBody += vec3(0.034, 0.020, 0.008) * g * exp(-(dSub * dSub) / 1.6) / (0.6 + hL * hL);
          }
          underwaterVolumeCol = mix(underwaterVolumeCol, dkBody, uDk);
        }

        // 2. SHOT 3–4 TRUE 3D UNDERWATER VOLUMETRIC INK RAYMARCHING (y < 0)!
        // 30-step refracted underwater raymarching with Interleaved Gradient Noise (IGN) per-pixel ray-offset jitter
        // -> 100% ZERO onion-ring slice banding, razor-crisp folded ink curtains, & zero milky water washout!
        float inkSurfaceEntryRing = 0.0;
        #ifdef INK_PASS
        if (!(uInkVisibility > 0.002 && uInkCount > 0 && uCarpetLevitation < 0.25)) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }
        #endif
        if (uInkVisibility > 0.002 && uInkCount > 0 && uCarpetLevitation < 0.25) {
          vec3 accumInkLight = vec3(0.0);
          float transmittance = 1.0;
          #ifdef INK_PASS
          const int STEPS = 21;
          float ds = 0.168; // Covers s = 0.05m .. 3.59m at fine 11.8cm volumetric resolution!
          // Jorge Jimenez Interleaved Gradient Noise (IGN) — optimal blue-noise-like spatial distribution for raymarching!
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));

          vec3 waterExtinction = vec3(0.58, 0.32, 0.20);

          // Exact ray-vs-plume-AABB clipping: only march the step indices that can touch any plume box
          // (same boxes as the early-out inside sampleUnderwaterInkVolume, so the image is identical).
          float tLo = 1e5;
          float tHi = -1e5;
          vec3 safeRay = vec3(
            abs(refrRay.x) < 1e-4 ? 1e-4 : refrRay.x,
            abs(refrRay.y) < 1e-4 ? -1e-4 : refrRay.y,
            abs(refrRay.z) < 1e-4 ? 1e-4 : refrRay.z
          );
          vec3 invRay = 1.0 / safeRay;
          for (int i = 0; i < ${MAX_UNDERWATER_PLUMES}; i++) {
            if (i >= uInkCount) break;
            vec4 bpl = uPlumePos[i];
            vec4 bmt = uPlumeMeta[i];
            float bR = bpl.w * (0.38 + 0.62 * (1.0 - exp(-bmt.x / 2.6)));
            vec3 bMin = vec3(bpl.x - bR * 2.05, bpl.y - bR * 1.45, bpl.z - bR * 2.05);
            vec3 bMax = vec3(bpl.x + bR * 2.05, -0.015, bpl.z + bR * 2.05);
            vec3 tA = (bMin - vWorldPos) * invRay;
            vec3 tB = (bMax - vWorldPos) * invRay;
            vec3 tN = min(tA, tB);
            vec3 tF = max(tA, tB);
            float tEnter = max(max(tN.x, tN.y), tN.z);
            float tExit = min(min(tF.x, tF.y), tF.z);
            if (tExit > max(tEnter, 0.0)) {
              tLo = min(tLo, max(tEnter, 0.0));
              tHi = max(tHi, tExit);
            }
          }
          int kStart = int(max(0.0, floor((tLo - 0.05) / ds - ign)));
          int kEnd = int(min(float(STEPS - 1), ceil((tHi - 0.05) / ds - ign)));

          for (int stepIdx = 0; stepIdx < STEPS; stepIdx++) {
            int kIdx = kStart + stepIdx;
            if (kIdx > kEnd) break;
            float sDist = 0.05 + (float(kIdx) + ign) * ds;
            vec3 sampleP = vWorldPos + refrRay * sDist;
            vec4 inkVol = sampleUnderwaterInkVolume(sampleP);

            if (inkVol.a > 0.003) {
              vec3 depthFilter = exp(-waterExtinction * sDist * 0.68);
              float stepAbsorb = 1.0 - exp(-inkVol.a * ds * 1.95);
              accumInkLight += transmittance * inkVol.rgb * depthFilter * ds * 1.88;
              transmittance *= (1.0 - stepAbsorb * 0.85);
              if (transmittance < 0.03) break;
            }
          }
          gl_FragColor = vec4(accumInkLight, transmittance);
          return;
          #else
          // Half-resolution ink volume (rendered by the INK_PASS variant of this shader just before the main pass)
          // the ink buffer is rendered small with a jittered march: a 5-tap tent hides both
          vec2 inkPx = vec2(dFdx(screenUV.x), dFdy(screenUV.y)) * 2.2;
          vec4 inkVolSample = texture2D(tInkVolume, screenUV) * 0.36
            + (texture2D(tInkVolume, screenUV + inkPx) + texture2D(tInkVolume, screenUV - inkPx)
            + texture2D(tInkVolume, screenUV + vec2(inkPx.x, -inkPx.y)) + texture2D(tInkVolume, screenUV + vec2(-inkPx.x, inkPx.y))) * 0.16;
          accumInkLight = inkVolSample.rgb;
          transmittance = inkVolSample.a;
          #endif

          // Tight localized subsurface glow + surface y = 0 entry meniscus ring right where each ink stem pierces the water!
          vec3 tightPlumeHalo = vec3(0.0);
          for (int i = 0; i < ${MAX_UNDERWATER_PLUMES}; i++) {
            if (i >= uInkCount) break;
            vec4 pl = uPlumePos[i];
            vec4 mt = uPlumeMeta[i];
            float dEntry = length(vWorldPos.xz - pl.xz);
            // Crisp glowing surface entry meniscus ring right above the vertical underwater stem (proves y=0 skin vs y<0 stem!)
            float entryWave = exp(-pow(abs((dEntry - min(0.65, 0.08 + mt.x * 0.28)) / 0.045), 2.0)) * exp(-mt.x * 0.55);
            float stemCollar = exp(-(dEntry * dEntry) / 0.025) * smoothstep(6.0, 0.2, mt.x);
            inkSurfaceEntryRing += (entryWave * 0.85 + stemCollar * 0.65) * mt.y;

            // Tight 3D subsurface scattering restricted strictly within ~0.9m of the submerged vortex head (NO full-screen milky washout!)
            float dist3D = length(subProbe1 - pl.xyz);
            float tightScatter = exp(-(dist3D * dist3D) / 0.85) * mt.y;
            tightPlumeHalo += vec3(0.035, 0.14, 0.22) * tightScatter * 0.18;
          }

          underwaterVolumeCol = underwaterVolumeCol * transmittance + accumInkLight + tightPlumeHalo;
        }

        // 3. Planar Surface Mirror Reflection (crisp obsidian-mirror reflection on calm water, blurring ONLY on steep wave slopes!)
        vec2 reflDistort = totalGrad * vec2(0.052, 0.068) + N.xz * 0.018;
        vec2 reflUV = clamp(vec2(screenUV.x, 1.0 - screenUV.y) + reflDistort, 0.002, 0.998);
        float slopeBlurLod = clamp(length(totalGrad) * 2.2, 0.0, 1.5);
        // The reflection is its own world: sometimes it shivers out of register with what it mirrors.
        reflUV.x = clamp(reflUV.x + uReflShiver * 0.014 * sin(screenUV.y * 140.0 + uRealTime * 46.0), 0.002, 0.998);
        vec3 planarRefl = texture2DLodEXT(tReflection, reflUV, slopeBlurLod).rgb;
        if (uDk > 0.002) {
          // Every light in the mirror is drawn out into a long vertical streak toward the viewer.
          // Where a ring carries rainbow, red and blue leave the surface at slightly different angles.
          vec3 acc = vec3(0.0);
          float ws = 0.0;
          vec2 disp = reflDistort * irisAmt * 0.32;
          for (int k = 0; k < 10; k++) {
            float f = float(k) / 9.0;
            float w = exp(-f * 2.4);
            vec2 uvk = reflUV + vec2(totalGrad.x * 0.03 * f, 0.010 - f * f * 0.32);
            float lodk = slopeBlurLod + f * 2.2;
            vec3 smp;
            if (irisAmt > 0.01) {
              smp.r = texture2DLodEXT(tReflection, clamp(uvk + disp, 0.002, 0.998), lodk).r;
              smp.g = texture2DLodEXT(tReflection, clamp(uvk, 0.002, 0.998), lodk).g;
              smp.b = texture2DLodEXT(tReflection, clamp(uvk - disp, 0.002, 0.998), lodk).b;
            } else {
              smp = texture2DLodEXT(tReflection, clamp(uvk, 0.002, 0.998), lodk).rgb;
            }
            acc += smp * w;
            ws += w;
          }
          planarRefl = mix(planarRefl, acc / ws * 1.7, uDk);
        }
        if (uReflShiver > 0.002) {
          planarRefl.r = texture2DLodEXT(tReflection, clamp(reflUV + vec2(0.006, 0.0) * uReflShiver, 0.002, 0.998), slopeBlurLod).r;
          planarRefl.b = texture2DLodEXT(tReflection, clamp(reflUV - vec2(0.006, 0.0) * uReflShiver, 0.002, 0.998), slopeBlurLod).b;
        }
        // ...and later it answers in the complementary colour: amber above, cold teal below.
        if (uReflComplement > 0.002) {
          float cMax = max(planarRefl.r, max(planarRefl.g, planarRefl.b));
          float cMin = min(planarRefl.r, min(planarRefl.g, planarRefl.b));
          vec3 comp = vec3(cMax + cMin) - planarRefl;
          comp = comp * vec3(0.72, 1.06, 1.16) + vec3(0.0, 0.012, 0.016) * cMax;
          planarRefl = mix(planarRefl, comp, uReflComplement);
        }

        // Combine Deep Refracted Underwater Volume (1 - fresnel) + Crisp Mirror Reflection!
        vec3 waterCol = underwaterVolumeCol * (1.0 - fresnel) + planarRefl * (0.42 + 0.65 * fresnel);

        // 4. Specular Grazing Highlights from Overhead Misty Sky-Theater & Floating Silk Blossoms
        vec3 R = reflect(-V, N);
        vec3 skyShaftDir = normalize(vec3(-0.18, 0.36, -1.0));
        float skySpec = pow(max(0.0, dot(R, skyShaftDir)), 28.0) * fresnel;
        waterCol += vec3(0.065, 0.082, 0.098) * skySpec * (1.0 - 0.92 * uShot1Dark) * (1.0 - uDk);

        float crestFactor = clamp(ringCrestSum + length(pdeGrad) * 2.2 + standingCrest * 0.72, 0.0, 1.5);
        waterCol += mix(mix(vec3(0.038, 0.052, 0.068), vec3(0.0, 0.0, 0.0), uDk), vec3(0.18, 0.12, 0.048), clamp(uBassStandingWave, 0.0, 1.0)) *
                    crestFactor * (0.32 + 0.68 * fresnel) * mix(1.0, 0.08 + 1.4 * s1Pool, uShot1Dark);

        // Shot 1 lamp glints: the overhead lamp catching the slow swell inside its pool of light.
        if (uShot1Dark > 0.002) {
          vec3 Lb = normalize(LB_POS - vWorldPos);
          vec3 Hb = normalize(Lb + V);
          float nh = max(0.0, dot(N, Hb));
          float lampSpec = pow(nh, 220.0) * 2.4 + pow(nh, 36.0) * 0.10;
          waterCol += LB_COL * lampSpec * s1Pool * (0.3 + 0.7 * fresnel) * uShot1Dark;
        }
        // Surface entry meniscus ring right where each ink drop pierces y = 0 above its submerged 3D stem!
        // (the drawn cyan ring where each ink drop entered is gone; the entry is a real ripple only)
        waterCol += vec3(0.28, 0.65, 0.85) * inkSurfaceEntryRing * 0.0;

        for (int i = 0; i < 4; i++) {
          float g = uLights[i].w;
          if (g <= 0.004) continue;
          vec3 lPos = uLights[i].xyz;
          vec3 L = normalize(lPos - vWorldPos);
          vec3 H = normalize(L + V);
          float ggxTight = pow(max(0.0, dot(N, H)), 96.0);
          float ggxSoft  = pow(max(0.0, dot(N, H)), 16.0);
          float dHoriz = length(vWorldPos.xz - lPos.xz);
          float atten = 1.0 / (1.0 + 0.14 * dHoriz * dHoriz);
          vec3 glintCol = vec3(0.42, 0.27, 0.12);
          if (irisAmt > 0.01) {
            // rainbow belongs to the light leaving the slopes, not to a painted line
            float ph = dot(totalGrad, vec2(2.3, 1.7)) * 1.05 + dHoriz * 0.42;
            vec3 spectrum = 0.5 + 0.5 * cos(6.2832 * (ph + vec3(0.0, 0.33, 0.67)));
            glintCol = mix(glintCol, spectrum * 0.50, irisAmt * 0.85);
          }
          waterCol += glintCol * g * atten * (ggxTight * 1.45 + ggxSoft * (0.12 + crestFactor * 0.48));
          // the closing ring always carries a little of the flower's light, even while the flower is only an ember
          waterCol += glintCol * max(g, 0.55) * atten * cueSheen * (0.55 + 1.5 * ggxSoft);
          if (uDk > 0.002) {
            // Pool of light at the foot of the flower: tight and bright when it hangs low, wide and faint
            // when it is high. Slopes that face the flower catch more of it, which is what draws the rings.
            vec2 toL = lPos.xz - vWorldPos.xz;
            float hL = max(0.22, lPos.y);
            float pool = min(5.0, g * hL / pow(hL * hL + dHoriz * dHoriz, 1.5));
            float facing = clamp(0.5 + dot(totalGrad, toL / max(dHoriz, 0.08)) * 2.4, 0.0, 1.7);
            waterCol += glintCol * pool * 0.085 * (0.22 + facing) * uDk;
          }
        }

        // 5. SHOT 1 OIL-FILM LENS SHADING (RECKONER)
        // Light from the overhead lamp passes through the oil lenses: the convex domes focus it (caustic
        // brightening in the letter cores, dark at the steep rim), red and blue bend by different amounts
        // (dispersion fringes), the thin rim shows interference colour, and the dome catches a sharp glint.
        if (oilSample.a > 0.004 && uTitlePresence > 0.002 && uCarpetLevitation < 0.05) {
          float oilAlpha = smoothstep(0.02, 0.30, oilSample.a) * uTitlePresence;
          vec2 oilUvC = vec2(vWorldPos.x / 20.0 + 0.5, 0.5 - (vWorldPos.z + 2.93) / 19.0);
          vec2 lensOff = totalGrad * 0.0010;
          // Liquid-light lettering: colour is read off the film thickness, like oil on a wet slide.
          // The paint field is advected by the fluid, so the bands crawl and fold with the swirl.
          vec3 paintRaw = oilFilm(oilUvC + lensOff).rgb;
          // The film's colour is the authored picture itself (carried by the flow); the engine only lights it.
          vec3 oilBody = max(vec3(0.0), mix(vec3(dot(paintRaw, vec3(0.2126, 0.7152, 0.0722))), paintRaw, 1.4));

          float epsC = 3.0 / 512.0;
          float lC = oilSample.a;
          float lapL = oilFilm(oilUvC + vec2(epsC, 0.0)).a + oilFilm(oilUvC - vec2(epsC, 0.0)).a
                     + oilFilm(oilUvC + vec2(0.0, epsC)).a + oilFilm(oilUvC - vec2(0.0, epsC)).a - 4.0 * lC;
          vec3 oilCaust = clamp(1.0 - lapL * vec3(5.2, 6.0, 6.8), 0.18, 2.6);

          // Lamp pool on the oil (falls off away from the lamp axis, never fully black so the word stays legible).
          float oilLamp = 0.30 + 1.10 * lbIrradiance(vec3(vWorldPos.x, 0.0, vWorldPos.z)) / max(0.0001, lbIrradiance(vec3(LB_POS.x, 0.0, LB_POS.z)));
          vec3 lampTint = mix(vec3(1.0), LB_COL / 0.62, uShot1Dark * 0.22);
          oilLamp = 0.45 + 0.34 * oilLamp;
          vec3 litOil = oilBody * mix(vec3(1.0), oilCaust, 0.25) * oilLamp * lampTint * 0.72;
          // low warm light catches the raised edges of the bands
          litOil += vec3(1.0, 0.70, 0.36) * min(1.0, length(oilGrad) * 5.0) * oilLamp * 0.16;

          vec3 Lo = normalize(LB_POS - vWorldPos);
          vec3 Ho = normalize(Lo + V);
          float nh = max(0.0, dot(N, Ho));
          float oilGlint = pow(nh, 420.0) * 4.0 + pow(nh, 90.0) * 0.35;
          float oilFres = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
          litOil += vec3(1.0, 0.86, 0.66) * oilGlint * smoothstep(0.25, 0.7, oilSample.a);
          litOil += planarRefl * oilFres * 0.5;

          // Oil sits on top of the dark water volume; the thick cores hide what is below.
          waterCol = mix(waterCol, litOil, oilAlpha);
        }

        // Shot ①: the same oil lies thin over the whole pool, not only in the letters. Broken islands and
        // streaks of interference colour drift on the black water around the title and wind up with the
        // swirl once the song starts. Thin film is dimmer than the thick lettering, and it only shows
        // where some light reaches it, so the far water still falls away into the dark.
        if (uTitlePresence > 0.002 && uCarpetLevitation < 0.05) {
          vec2 fp = vWorldPos.xz - vec2(0.0, 0.55);
          float fr = length(fp);
          float wind = uBalatroSwirl * (0.9 + uRealTime * 0.16) * exp(-fr * 0.16);
          float cw = cos(wind);
          float sw = sin(wind);
          vec2 sp = vec2(fp.x * cw - fp.y * sw, fp.x * sw + fp.y * cw);
          vec2 warp = vec2(lbNoise(sp * 0.55 + vec2(uRealTime * 0.030, 1.7)), lbNoise(sp.yx * 0.55 + vec2(5.2, -uRealTime * 0.024)));
          vec2 wq = sp * 0.42 + (warp - 0.5) * 2.4;
          float thick = lbNoise(wq) * 0.58 + lbNoise(wq * 2.1 + 3.7) * 0.30 + lbNoise(wq * 4.6 + 9.1) * 0.12;
          float island = lbNoise(wq * 0.62 + 11.0) * 0.65 + thick * 0.35;
          float cover = smoothstep(0.40, 0.60, island) * (1.0 - 0.6 * smoothstep(0.66, 0.84, island));
          float filmPh = thick * 2.6 + island * 1.3 + fr * 0.05 + uRealTime * 0.045;
          vec3 film;
          film.r = psyRamp(filmPh + 0.03).r;
          film.g = psyRamp(filmPh).g;
          film.b = psyRamp(filmPh - 0.03).b;
          // dark seams where one colour hands over to the next, as in the lettering
          float seam = abs(fract(filmPh * 5.0) - 0.5) * 2.0;
          film *= 0.50 + 0.50 * smoothstep(0.0, 0.25, 1.0 - seam * seam * seam);
          float wideLight = 0.10 + 1.15 * lbIrradiance(vec3(vWorldPos.x * 0.50, 0.0, 0.35 + (vWorldPos.z - 0.35) * 0.50));
          float letter = smoothstep(0.02, 0.30, oilSample.a);
          float nearFade = 1.0 - smoothstep(22.0, 34.0, length(vWorldPos - cameraPosition));
          waterCol += film * cover * wideLight * (0.55 + 0.9 * fresnel) * 0.070 * uTitlePresence * (1.0 - letter) * nearFade * (1.0 - 0.9 * oilBox);
        }

        // =====================================================================
        // SHOTS 5–6 (2:23.8 ~ 4:03.3): BILLOWING CRYSTAL-OBSIDIAN & SAPPHIRE LIQUID-SILK CARPET!
        // =====================================================================
        if (uCarpetLevitation > 0.002) {
          // 1. Organic Rounded Superellipse + Flowing Sinusoidal Silk Boundary (100% ZERO 90-degree corners or neon border!)
          vec2 cNorm = (vUv - 0.5) * 2.0; // -1..+1
          float superR = pow(pow(abs(cNorm.x), 3.6) + pow(abs(cNorm.y), 3.2), 1.0 / 3.4);
          float silkWaveEdge =
            0.032 * sin(cNorm.x * 5.5 + uTime * 1.65) * abs(cNorm.y) +
            0.024 * cos(cNorm.y * 4.5 - uTime * 1.35) * abs(cNorm.x);
          float orgEdge = superR + silkWaveEdge;

          // Combine geometric XPBD 3D cloth wave normal (vGeomNormal) with fine capillary/strike ripples!
          // Fine ripples seen at a grazing angle average out (as they do in any real lens): keeping them
          // sharp there turns the sheet into zebra foil.
          float faceOn = smoothstep(0.04, 0.42, dot(baseN, V));
          float rippleKeep = mix(0.16, 0.85, faceOn);
          vec3 clothN = normalize(mix(vec3(0.0, 1.0, 0.0), baseN, mix(0.5, 1.0, faceOn)) + vec3(-totalGrad.x, 0.0, -totalGrad.y) * rippleKeep);
          float clothNoV = clamp(dot(clothN, V), 0.04, 1.0);
          float clothFresnel = 0.024 + 0.976 * pow(1.0 - clothNoV, 4.6);

          vec2 refrOffset = (clothN.xz * 0.11 + totalGrad * 0.06) * uCarpetLevitation;
          vec3 refractedBg;
          refractedBg.r = texture2D(tRefraction, clamp(screenUV + refrOffset * 1.08, 0.002, 0.998)).r;
          refractedBg.g = texture2D(tRefraction, clamp(screenUV + refrOffset * 1.00, 0.002, 0.998)).g;
          refractedBg.b = texture2D(tRefraction, clamp(screenUV + refrOffset * 0.92, 0.002, 0.998)).b;

          // 2. Crystal-Dark Obsidian & Sapphire Liquid Glass Body (NEVER flat milky grey-teal!):
          // Deep Beer-Lambert sapphire-obsidian troughs let the golden floor caustics refract dimly through from below!
          float waveElev = clamp((vWorldPos.y - 1.48 * uCarpetLevitation) * 1.65, -1.0, 1.0);
          vec3 deepObsidianGlass = vec3(0.0030, 0.0085, 0.0165) + vec3(0.005, 0.014, 0.024) * max(0.0, waveElev);
          // Beer-Lambert: path length through the sheet grows at grazing angles -> deep teal absorption,
          // so the carpet reads as a thick transmissive water body rather than a milky diffuse sheet.
          float pathLen = 0.35 / max(0.18, clothNoV);
          vec3 absorb = exp(-vec3(1.55, 0.62, 0.38) * pathLen);
          vec3 clearRefractedCaustics = refractedBg * absorb;
          vec3 thickWaterBody = deepObsidianGlass + clearRefractedCaustics * 0.96;

          // After we have been to the other side, every strike lets its cold light well up through the cloth.
          if (uTealLeak > 0.002 && uStrikeAge < 4.0) {
            float lr = length(vWorldPos.xz - uStrikeXZ);
            float spread = 0.55 + uStrikeAge * 2.3;
            float well = exp(-(lr * lr) / (spread * spread)) * exp(-uStrikeAge * 1.25) * smoothstep(0.0, 0.08, uStrikeAge);
            float veins = 0.55 + 0.45 * sin(lr * 9.0 - uStrikeAge * 7.0 + totalGrad.x * 30.0);
            thickWaterBody += vec3(0.02, 0.62, 0.58) * well * veins * 0.75 * uTealLeak;
          }

          // 3. Sculptural 3D Cloth Wave-Slope Lighting (makes every billowing silk swell & crater pop in 3D!):
          vec3 keyLightA = normalize(vec3(-1.8, 5.2, 1.8) - vWorldPos);
          vec3 HA = normalize(keyLightA + V);
          vec3 warmStageBack = normalize(vec3(0.0, 3.6, -4.2) - vWorldPos);
          vec3 HBack = normalize(warmStageBack + V);

          // Grazing directional sheen across 3D cloth wave slopes (clothN.x / clothN.z / waveElev)
          float slopeFacing = pow(clamp(0.48 + 0.52 * dot(clothN, normalize(vec3(-0.42, 0.68, 0.60))), 0.0, 1.0), 2.8);
          float crestRidge = smoothstep(-0.08, 0.42, waveElev) * (0.45 + 0.55 * length(clothN.xz) * 2.2);

          float specCrystal = pow(max(0.0, dot(clothN, HA)), 128.0);
          float specBroad   = pow(max(0.0, dot(clothN, HA)), 22.0);
          float specBackRim = pow(max(0.0, dot(clothN, HBack)), 18.0) * (0.35 + 0.65 * clothFresnel);

          // Soft, physically refracting rounded liquid meniscus lip (warm pearl-amber & silver, ZERO neon-cyan outline!)
          float meniscusLip = smoothstep(0.86, 0.955, orgEdge) * (1.0 - smoothstep(0.955, 0.995, orgEdge));

          // Warm 2700K stage-fan reflection boost during Shot 6 drummer scene
          vec3 stageWarmTint = mix(vec3(0.72, 0.84, 0.94), vec3(1.00, 0.72, 0.36), 0.45 + 0.48 * uDrummerShadow);

          // High-impact golden-champagne & aqua specular crest rings around drumstick strikes!
          vec3 rippleImpactGold = (vec3(1.15, 0.80, 0.34) + vec3(0.22, 0.52, 0.72)) * pow(crestFactor, 1.6) * 1.55 * mix(0.05, 0.55, faceOn);

          vec3 airborneSpecs =
            vec3(1.15, 0.90, 0.56) * specCrystal * 2.6 +
            stageWarmTint * (specBroad * 0.10 + crestRidge * 0.025 + slopeFacing * 0.012) +
            mix(vec3(0.18, 0.28, 0.36), vec3(0.68, 0.44, 0.18), uDrummerShadow) * specBackRim * 0.85 +
            mix(vec3(0.26, 0.34, 0.40), vec3(0.55, 0.42, 0.24), uDrummerShadow) * meniscusLip * 0.42 +
            rippleImpactGold;

          float carpetShadow = 1.0;
          if (uDrummerShadow > 0.002) {
            vec4 projClip = uDrummerMat * vec4(vWorldPos, 1.0);
            if (projClip.w > 0.05) {
              vec2 sUv = projClip.xy / projClip.w;
              if (sUv.x > 0.01 && sUv.x < 0.99 && sUv.y > 0.01 && sUv.y < 0.99) {
                // Soft penumbra shadow cast by the giant drummer onto the hovering liquid silk!
                float px = 0.0055;
                float occ = texture2D(uDrummerTex, sUv).a * 0.40
                          + texture2D(uDrummerTex, sUv + vec2(px, 0.0)).a * 0.15
                          + texture2D(uDrummerTex, sUv - vec2(px, 0.0)).a * 0.15
                          + texture2D(uDrummerTex, sUv + vec2(0.0, px)).a * 0.15
                          + texture2D(uDrummerTex, sUv - vec2(0.0, px)).a * 0.15;
                carpetShadow = mix(1.0, 0.36, occ * uDrummerShadow);
              }
            }
          }

          vec2 clothReflUV = clamp(vec2(screenUV.x, 1.0 - screenUV.y) + clothN.xz * 0.045 * mix(0.45, 1.0, faceOn) + totalGrad * 0.05 * rippleKeep, 0.002, 0.998);
          vec3 clothRefl = texture2DLodEXT(tReflection, clothReflUV, mix(3.2, 0.5, faceOn)).rgb;
          // water, not chrome: the mirror image loses red inside the sheet and never reaches full strength
          clothRefl *= vec3(0.62, 0.80, 0.86);
          // light from behind the stage bleeds through the thin crests
          thickWaterBody += mix(vec3(0.012, 0.075, 0.085), vec3(0.11, 0.07, 0.022), uDrummerShadow) * crestRidge * (1.0 - faceOn) * 0.9;

          vec3 airborneCol =
            thickWaterBody * (1.0 - clothFresnel * 0.48) * carpetShadow +
            (clothRefl * (0.04 + 0.62 * clothFresnel) + airborneSpecs) * mix(1.0, 0.58, 1.0 - carpetShadow);

          // Smooth organic rounded silk-hem dissolve into refracted background (zero rectangular slab corners!)
          float featherAlpha = 1.0 - smoothstep(0.92, 0.995, orgEdge);
          airborneCol = mix(refractedBg, airborneCol, featherAlpha);

          float carpetMix = smoothstep(0.0, 1.0, uCarpetLevitation);

          // ===================================================================
          // THE OTHER SIDE: looking up at the surface from below.
          // Snell's window: everything above the water is squeezed into a bright disc (critical angle 48.6 deg);
          // outside it the surface is a total-internal-reflection mirror of the world below.
          // ===================================================================
          if (!gl_FrontFacing && uUnderView > 0.5) {
            vec3 nDown = normalize(mix(vec3(0.0, -1.0, 0.0), clothN, 0.55));
            float cosI = clamp(dot(nDown, V), 0.0, 1.0);
            // each wavelength has a slightly different critical angle -> a thin spectral fringe on the rim
            // (with uRainbow the colours part further at the rim: red sees a slightly wider window than blue)
            float rb = 0.010 * uRainbow;
            vec3 win = vec3(
              smoothstep(0.640 - rb, 0.676 - rb, cosI),
              smoothstep(0.652, 0.688, cosI),
              smoothstep(0.666 + rb, 0.702 + rb, cosI));
            float core = smoothstep(0.66, 1.0, cosI);

            // through the window: the lit world above, bent by every swell
            vec2 wOff = clothN.xz * 0.16 + totalGrad * 0.08;
            vec3 above = texture2D(tRefraction, clamp(screenUV + wOff, 0.002, 0.998)).rgb;
            float lens = pow(clamp(dot(clothN, vec3(0.0, -1.0, 0.0)), 0.0, 1.0), 26.0);
            float lensFine = pow(clamp(1.0 - length(totalGrad) * 1.6, 0.0, 1.0), 6.0);
            vec3 skyLight = mix(vec3(0.03, 0.40, 0.50), vec3(1.0, 0.66, 0.30), pow(core, 1.35)) * (0.30 + 0.80 * core);
            skyLight *= 0.42 + 1.0 * lens * (0.55 + 0.45 * lensFine);
            skyLight += vec3(1.0, 0.86, 0.60) * pow(lens, 4.0) * pow(core, 2.0) * 0.55;

            // something very large stands on the other side and slides across the light
            float occ = 0.0;
            if (uShadowPass > 0.002) {
              // window-space projection: the figure towers over the disc of light above the camera
              vec2 sUv = vec2((vWorldPos.x - cameraPosition.x) / 2.6 + 0.5 + uShadowSlide * 1.5 + clothN.x * 0.05,
                              (vWorldPos.z - cameraPosition.z + 1.05) / 2.6 + 0.70 + clothN.z * 0.05);
              if (sUv.x > 0.03 && sUv.x < 0.97 && sUv.y > 0.03 && sUv.y < 0.97) {
                float px = 0.007;
                occ = texture2D(uDrummerTex, sUv).a * 0.28
                    + texture2D(uDrummerTex, sUv + vec2(px, px)).a * 0.18
                    + texture2D(uDrummerTex, sUv - vec2(px, px)).a * 0.18
                    + texture2D(uDrummerTex, sUv + vec2(-px, px)).a * 0.18
                    + texture2D(uDrummerTex, sUv + vec2(px, -px)).a * 0.18;
              }
            }
            vec3 windowCol = (skyLight * uWindowLight + above * vec3(0.30, 0.34, 0.36)) * mix(1.0, 0.07, occ * uShadowPass);
            // "In rainbows": the rim of the window is where water turns light into its colours. A full band of
            // spectrum sits on the edge, red outside, violet inside, and it wobbles with every wave above.
            if (uRainbow > 0.002) {
              // (measured on a calmer normal than the window itself, so the bow stays one soft arc and does
              // not break into coloured islands on every wave; it is light, so it is pale, never paint)
              vec3 nRim = normalize(mix(vec3(0.0, -1.0, 0.0), clothN, 0.26));
              float cosR = clamp(dot(nRim, V), 0.0, 1.0);
              float rimT = clamp((cosR - 0.612) / 0.092, 0.0, 1.0);
              float rimEnv = sin(rimT * 3.14159);
              rimEnv *= rimEnv;
              vec3 spec = 0.5 + 0.5 * cos(6.28318 * (rimT * 0.80 - vec3(0.0, 0.33, 0.67)));
              spec = mix(spec, vec3(1.0), 0.30);
              windowCol += spec * rimEnv * uRainbow * (0.22 + 0.34 * lens) * uWindowLight * mix(1.0, 0.25, occ * uShadowPass);
            }

            // outside the window: mirror of the pool floor, cold and dim
            vec2 tirUV = clamp(vec2(screenUV.x, 1.0 - screenUV.y) + clothN.xz * 0.07 + totalGrad * 0.05, 0.002, 0.998);
            vec3 tir = texture2DLodEXT(tReflection, tirUV, 0.6).rgb;
            vec3 murk = vec3(0.004, 0.030, 0.040);
            vec3 tirCol = tir * vec3(0.55, 0.92, 1.0) * 0.85 + murk;
            tirCol += vec3(0.03, 0.20, 0.22) * pow(lens, 2.0) * 0.22;
            // light net crawling over the underside so the mirror is never a flat wall
            vec2 cp = vWorldPos.xz * 1.35 + clothN.xz * 1.6;
            float cA = sin(cp.x * 2.1 + sin(cp.y * 1.7 + uTime * 0.6) * 1.6);
            float cB = sin(cp.y * 2.6 - sin(cp.x * 1.3 - uTime * 0.5) * 1.8);
            float cNet = pow(clamp(1.0 - abs(cA + cB) * 0.5, 0.0, 1.0), 6.0);
            vec3 netCol = vec3(0.10, 0.40, 0.42) * cNet;
            if (uRainbow > 0.002) {
              // the same net seen in red and in blue lies a little apart: coloured edges on every filament
              float cR = pow(clamp(1.0 - abs(sin((cp.x + 0.07) * 2.1 + sin(cp.y * 1.7 + uTime * 0.6) * 1.6) + cB) * 0.5, 0.0, 1.0), 6.0);
              float cBl = pow(clamp(1.0 - abs(cA + sin((cp.y - 0.07) * 2.6 - sin(cp.x * 1.3 - uTime * 0.5) * 1.8)) * 0.5, 0.0, 1.0), 6.0);
              // the core of each filament stays the colour of the water; only its two edges take colour
              netCol += (vec3(0.52, 0.20, 0.10) * max(cR - cNet, 0.0) + vec3(0.14, 0.16, 0.62) * max(cBl - cNet, 0.0)) * uRainbow * 0.9;
            }
            tirCol += netCol * 0.30;

            vec3 underCol = mix(tirCol, windowCol, win);
            float dCam = length(vWorldPos - cameraPosition);
            underCol = mix(underCol, murk * 1.4, 1.0 - exp(-dCam * 0.055));
            float underFeather = 1.0 - smoothstep(0.90, 0.995, orgEdge);
            airborneCol = mix(murk * 1.4, underCol, underFeather);
            carpetMix = 1.0;
          }

          waterCol = mix(waterCol, airborneCol, carpetMix);
        }

        // Last image: RECKONER exists only as a reflection. There is nothing above the water to cast it.
        if (uEndTitle > 0.002 && gl_FrontFacing) {
          vec3 Rt = reflect(-V, normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.55)));
          if (Rt.z < -0.02) {
            float tHit = (-2.4 - vWorldPos.z) / Rt.z;
            vec3 Ph = vWorldPos + Rt * tHit;
            vec2 tuv = vec2(Ph.x / 9.2 + 0.5, (Ph.y - 0.18) / 2.35);
            if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) {
              float m = texture2D(tTitleMask, tuv).r;
              float halo = texture2D(tTitleMask, tuv).g;
              float ink = smoothstep(0.42, 0.78, m);
              waterCol += (vec3(1.0, 0.86, 0.62) * ink * 0.95 + vec3(0.9, 0.55, 0.25) * smoothstep(0.42, 0.9, m) * 0.12 + halo * 0.0) * uEndTitle;
            }
          }
        }

        // =====================================================================
        // VOLUMETRIC SEA-MIST HORIZON DISSOLVE ("平面放满整个屏幕，渐渐淡去，看不到远处")
        // Melts the far half of the boundless ocean seamlessly into the exact horizon mist color of galleryScene.ts!
        // =====================================================================
        float groundedOnly = 1.0 - smoothstep(0.12, 0.85, uCarpetLevitation) * 0.92;
        if (!gl_FrontFacing && uUnderView > 0.5) groundedOnly = 0.0;
        float distFromCam = length(vWorldPos - cameraPosition);
        float zFog = smoothstep(-4.0, -24.0, vWorldPos.z) * groundedOnly;
        float radialFog = smoothstep(12.0, 30.0, distFromCam) * groundedOnly;
        float mistFactor = clamp(max(zFog, radialFog), 0.0, 1.0);

        float azim = atan(vWorldPos.x, -(vWorldPos.z - cameraPosition.z));
        // Must equal the sky dome at elev ~ 0 (galleryScene skyDome: midTeal*mist + warm*glow + cool lift),
        // otherwise the far edge of the water reads as a hard seam against the sky.
        vec3 horizonSeaMist =
          vec3(0.0180, 0.0285, 0.0395) * 0.80 +
          vec3(0.0340, 0.0265, 0.0195) * exp(-azim * azim * 1.35) * 0.80 +
          vec3(0.014, 0.022, 0.032) * 0.75;

        // Shot 1: far water dissolves into darkness (same factor as the sky dome, so no horizon seam).
        horizonSeaMist *= mix(1.0, 0.10, uShot1Dark) * uAmbientKeep;
        float mistAmt = smoothstep(0.0, 1.0, mistFactor);
        if (uDk > 0.002) {
          // same air as the nave: the far water goes into the fog of the set, with no horizon line
          vec3 dkDir = normalize(vec3(-V.x, 0.0, -V.z) + vec3(1e-5));
          horizonSeaMist = mix(horizonSeaMist, dkFog(dkDir), uDk);
          mistAmt = mix(mistAmt, (1.0 - exp(-distFromCam * 0.050)) * groundedOnly, uDk);
        }
        waterCol = mix(waterCol, horizonSeaMist, mistAmt);

        // Shot 1: lamp-lit haze hanging between the eye and the water.
        if (uShot1Dark > 0.002) {
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          waterCol += lbScatter(cameraPosition, -V, distFromCam, ign) * uShot1Dark * (1.0 - 0.75 * uTitlePresence);
        }

        gl_FragColor = vec4(max(vec3(0.0), waterCol * (1.0 - uBlackout)), 1.0);
      }
    `,
    extensions: {
      shaderTextureLod: true,
    } as unknown as Record<string, boolean>,
  });

  const waterMesh = new THREE.Mesh(carpet.geometry, waterMat);

  // Half-resolution underwater ink volume pass (Shots 3-4). Same shader, INK_PASS variant writes
  // (accumulated ink light, transmittance); the main water pass composites it. 4x fewer raymarched pixels.
  const inkRT = new THREE.WebGLRenderTarget(2, 2, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  waterUniforms.tInkVolume.value = inkRT.texture;
  const inkMat = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    side: THREE.DoubleSide,
    defines: { INK_PASS: 1 },
    vertexShader: waterMat.vertexShader,
    fragmentShader: waterMat.fragmentShader,
    extensions: waterMat.extensions,
  });
  const inkScene = new THREE.Scene();
  const inkMesh = new THREE.Mesh(carpet.geometry, inkMat);
  inkMesh.frustumCulled = false;
  inkScene.add(inkMesh);
  const drawSize = new THREE.Vector2();
  const mirrorCamera = new THREE.PerspectiveCamera();

  function syncPacketUniforms(currentTime: number) {
    for (let i = 0; i < MAX_PACKETS; i++) {
      if (i < activePackets.length) {
        const p = activePackets[i];
        const age = Math.max(0.001, currentTime - p.birthTime);
        if (p.isCarpetSpace) {
          packetUniformData[i].set(p.carpetU, p.carpetV, age, -p.amplitude);
        } else {
          packetUniformData[i].set(p.worldX, p.worldZ, age, p.amplitude);
        }
      } else {
        packetUniformData[i].set(0, 0, -100, 0);
      }
      if (i < activePackets.length) {
        const f = activePackets[i].fx;
        packetFxData[i].set(f[0], f[1], f[2], f[3]);
      } else {
        packetFxData[i].set(0, 0.46, 1, 1);
      }
    }
  }

  function injectWorldRipple(
    worldX: number,
    worldZ: number,
    radiusMeters = 0.35,
    strength = 0.65,
    strikeCarpetUV?: [number, number],
    fx?: RippleFx
  ) {
    const isCarpet = Boolean(strikeCarpetUV);
    const simU = isCarpet ? strikeCarpetUV![0] : THREE.MathUtils.clamp(worldX / 16.0 + 0.5, 0.05, 0.95);
    const simV = isCarpet ? strikeCarpetUV![1] : THREE.MathUtils.clamp(0.5 - (worldZ + 1.0) / 14.0, 0.05, 0.95);

    if (pendingDrops.length < MAX_DROPS) {
      pendingDrops.push({
        x: simU,
        y: simV,
        radius: THREE.MathUtils.clamp(radiusMeters / 15.0, 0.012, 0.055),
        strength,
      });
    }

    activePackets.unshift({
      worldX,
      worldZ,
      carpetU: simU,
      carpetV: simV,
      isCarpetSpace: isCarpet,
      birthTime: waterUniforms.uTime.value,
      amplitude: Math.min(1.65, strength * 1.35),
      radiusScale: radiusMeters / 0.35,
      fx: [fx?.iris ?? 0, fx?.decay ?? 0.46, fx?.k ?? 1, fx?.grow ?? 1],
    });
    if (activePackets.length > MAX_PACKETS) {
      activePackets.pop();
    }

    if (strikeCarpetUV) {
      carpet.injectStrike(strikeCarpetUV[0], strikeCarpetUV[1], strength);
    }
  }

  function resetSimulation(rendererInstance: THREE.WebGLRenderer, seedTime = 0) {
    activePackets.length = 0;
    pendingDrops.length = 0;
    waterUniforms.uTime.value = seedTime;
    carpet.resetFlat();

    // Clear PDE wave RTs so zero stale ripples persist across timeline jumps!
    const prevRT = rendererInstance.getRenderTarget();
    const prevCol = rendererInstance.getClearColor(new THREE.Color());
    const prevAlpha = rendererInstance.getClearAlpha();
    rendererInstance.setClearColor(0x000000, 0);
    rendererInstance.setRenderTarget(waveRT0);
    rendererInstance.clear();
    rendererInstance.setRenderTarget(waveRT1);
    rendererInstance.clear();
    rendererInstance.setClearColor(prevCol, prevAlpha);
    rendererInstance.setRenderTarget(prevRT);

    if (seedTime < 11.5) {
      oilFluid.resetAndSeed(rendererInstance);
    }
    syncPacketUniforms(seedTime);
  }

  function stepSimulation(rendererInstance: THREE.WebGLRenderer, dt: number, state: WaterSystemState) {
    const fxT = state.fxTime ?? state.time;
    waterUniforms.uTime.value = fxT;
    waterUniforms.uRealTime.value = state.time;
    waterUniforms.uReflComplement.value = state.reflComplement ?? 0;
    waterUniforms.uReflShiver.value = state.reflShiver ?? 0;
    waterUniforms.uUnderView.value = state.underView ?? 0;
    waterUniforms.uShadowPass.value = state.shadowPass ?? 0;
    waterUniforms.uShadowSlide.value = state.shadowSlide ?? 0;
    waterUniforms.uWindowLight.value = state.windowLight ?? 1;
    waterUniforms.uFractal.value = state.causticFractal ?? 0;
    waterUniforms.uEndTitle.value = state.endTitle ?? 0;
    waterUniforms.uTealLeak.value = state.tealLeak ?? 0;
    waterUniforms.uStrikeAge.value = state.strikeAge ?? 99;
    if (state.strikeXZ) waterUniforms.uStrikeXZ.value.set(state.strikeXZ[0], state.strikeXZ[1]);
    waterUniforms.uTitlePresence.value = state.titlePresence;
    waterUniforms.uBalatroSwirl.value = state.balatroSwirlAmount;
    waterUniforms.uInkVisibility.value = state.biolumInkVisibility;
    waterUniforms.uBassStandingWave.value = state.bassStandingWave;
    waterUniforms.uCarpetLevitation.value = state.carpetLevitation;
    waterUniforms.uDrummerShadow.value = state.drummerShadowIntensity;
    waterUniforms.uBlackout.value = state.endingBlackout;
    waterUniforms.uShot1Dark.value = state.shot1Dark ?? 0.0;
    waterUniforms.uAmbientKeep.value = state.ambientKeep ?? 1.0;
    waterUniforms.uDk.value = state.dk ?? 0.0;
    if (state.dkAxis) waterUniforms.uDkAxis.value.set(state.dkAxis[0], state.dkAxis[1], state.dkAxis[2]);
    waterUniforms.uDkTop.value = state.dkTop ?? 1.0;
    if (state.pat) {
      waterUniforms.uPat.value.set(state.pat.cx, state.pat.cz, state.pat.amp, Math.max(0.5, state.pat.radius));
      waterUniforms.uPatMode.value.set(state.pat.resonance, state.pat.phase, 0, 0);
    } else {
      waterUniforms.uPat.value.z = 0;
    }
    waterUniforms.uRainbow.value = state.rainbow ?? 0;
    // the floating sheet carries the full set of short waves; water lying on the ground only a trace, with the strings
    waterUniforms.uMicro.value = Math.max(state.carpetLevitation, 0.10 * (0.3 + 0.7 * state.otherEnergy));
    waterUniforms.uVein.value.set(state.vein?.grow ?? 0, state.vein?.level ?? 0);
    if (state.cue) waterUniforms.uCue.value.set(state.cue.x, state.cue.z, state.cue.toLand, state.cue.strength);
    else waterUniforms.uCue.value.w = 0;
    if (state.drummerShadowTex) waterUniforms.uDrummerTex.value = state.drummerShadowTex;
    if (state.drummerShadowMatrix) waterUniforms.uDrummerMat.value.copy(state.drummerShadowMatrix);

    for (let i = 0; i < 4; i++) {
      if (i < state.shylightLights.length) {
        const l = state.shylightLights[i];
        lightUniformData[i].set(l.pos.x, l.pos.y, l.pos.z, l.glow);
      } else {
        lightUniformData[i].set(0, 5, -1, 0);
      }
    }

    // 1. Step Shot 1 Real Navier-Stokes + Allen-Cahn Oil-on-Water Title Fluid (0..10.5s)
    oilFluid.step(rendererInstance, dt, state.time, state.titlePresence);
    waterUniforms.tOilPaint.value = oilFluid.paintRT.texture;
    waterUniforms.tOilOff.value = oilFluid.offTexture;
    waterUniforms.uOilThin.value = oilFluid.thin;

    // 2. Update Shots 3–4 3D Sinking Underwater Bioluminescent Ink Plumes (y < 0)
    const livePlumes = inkField.updateAtTime(
      Math.min(fxT, state.time),
      state.biolumDrops,
      state.swirlGather,
      state.biolumInkVisibility,
      state.time
    );
    waterUniforms.uInkCount.value = livePlumes;

    // 3. Step XPBD Full-Width Levitating Water Silk Carpet (Shots 5–6)
    waterUniforms.uCarpetWave.value.set(
      state.time,
      state.carpetWaveActivity,
      0.92 + 0.45 * state.otherEnergy + 0.32 * state.vocalEnergy,
      state.underSpan ?? 0
    );
    waterUniforms.uCarpetLift.value = state.underLift ?? 0;
    waterUniforms.uCarpetAnalyticN.value = (window as any).__carpetVertexN ? 0.0 : 1.0;
    carpet.step(dt, {
      levitation: state.carpetLevitation,
      time: state.time,
      otherEnergy: state.otherEnergy,
      vocalEnergy: state.vocalEnergy,
      bassEnergy: state.bassEnergy,
      drumEnergy: state.drumEnergy,
      beatPhase: state.beatPhase,
      waveActivity: state.carpetWaveActivity,
      underLift: state.underLift ?? 0,
      underSpan: state.underSpan ?? 0,
    });
    carpet.writeStrikes(waterUniforms.uCarpetStrikes.value);

    // NO RANDOM DRIPS! Only clean up expired rhythm/interaction wave packets.
    for (let i = activePackets.length - 1; i >= 0; i--) {
      const age = fxT - activePackets[i].birthTime;
      if (age < 0 || age > 5.0) {
        activePackets.splice(i, 1);
      }
    }
    syncPacketUniforms(fxT);
    if ((state.freeze ?? 0) > 0.6) {
      pendingDrops.length = 0;
      return;
    }

    // 4. Step GPU 2D PDE Wave Heightfield
    const count = Math.min(pendingDrops.length, MAX_DROPS);
    waveStepMat.uniforms.uDropCount.value = count;
    for (let i = 0; i < count; i++) {
      const d = pendingDrops[i];
      dropCenters[i].set(d.x, d.y, d.radius, d.strength);
    }
    pendingDrops.length = 0;

    waveStepMat.uniforms.tPrev.value = waveRT0.texture;
    const prevRT = rendererInstance.getRenderTarget();
    simQuad.material = waveStepMat;
    rendererInstance.setRenderTarget(waveRT1);
    rendererInstance.render(simScene, orthoCam);
    [waveRT0, waveRT1] = [waveRT1, waveRT0];

    rendererInstance.setRenderTarget(prevRT);
    waterUniforms.tWave.value = waveRT0.texture;
  }

  function renderPlanarAndRefraction(
    rendererInstance: THREE.WebGLRenderer,
    scene: THREE.Scene,
    mainCamera: THREE.PerspectiveCamera,
    carpetLevitation: number,
    hooks?: { beforeMirror?: () => void; afterMirror?: () => void }
  ) {
    const mirrorPlaneY = carpetLevitation > 0.02 ? carpet.meanWaveHeight : poolBounds.waterY;

    mirrorCamera.copy(mainCamera);
    mirrorCamera.position.y = 2.0 * mirrorPlaneY - mainCamera.position.y;
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(mainCamera.quaternion);
    const target = mainCamera.position.clone().add(lookDir);
    target.y = 2.0 * mirrorPlaneY - target.y;
    mirrorCamera.up.set(0, 1, 0);
    mirrorCamera.lookAt(target);
    mirrorCamera.updateMatrixWorld();
    mirrorCamera.projectionMatrix.copy(mainCamera.projectionMatrix);

    waterMesh.visible = false;
    const prevRT = rendererInstance.getRenderTarget();

    if (
      waterUniforms.uInkVisibility.value > 0.002 &&
      waterUniforms.uInkCount.value > 0 &&
      carpetLevitation < 0.25
    ) {
      rendererInstance.getDrawingBufferSize(drawSize);
      const iw = Math.max(2, Math.floor(drawSize.x * 0.36));
      const ih = Math.max(2, Math.floor(drawSize.y * 0.36));
      if (inkRT.width !== iw || inkRT.height !== ih) inkRT.setSize(iw, ih);
      inkMesh.matrixWorld.copy(waterMesh.matrixWorld);
      inkMesh.matrixAutoUpdate = false;
      const prevColor = rendererInstance.getClearColor(new THREE.Color());
      const prevAlpha = rendererInstance.getClearAlpha();
      rendererInstance.setClearColor(0x000000, 1);
      rendererInstance.setRenderTarget(inkRT);
      rendererInstance.clear();
      rendererInstance.render(inkScene, mainCamera);
      rendererInstance.setClearColor(prevColor, prevAlpha);
    }

    hooks?.beforeMirror?.();
    rendererInstance.setRenderTarget(reflRT);
    rendererInstance.clear();
    if (!(window as any).__noMirror) rendererInstance.render(scene, mirrorCamera);
    hooks?.afterMirror?.();

    if (carpetLevitation > 0.002) {
      rendererInstance.setRenderTarget(refrRT);
      rendererInstance.clear();
      rendererInstance.render(scene, mainCamera);
    }

    rendererInstance.setRenderTarget(prevRT);
    waterMesh.visible = true;
  }

  function resize(width: number, height: number) {
    const rw = Math.max(640, Math.min(1400, Math.floor(width * 0.7)));
    const rh = Math.max(400, Math.min(880, Math.floor(height * 0.7)));
    reflRT.setSize(rw, rh);
    refrRT.setSize(rw, rh);
  }

  return {
    waterMesh,
    carpet,
    inkField,
    getWaveTexture: () => waveRT0.texture,
    injectWorldRipple,
    resetSimulation,
    stepSimulation,
    renderPlanarAndRefraction,
    resize,
  };
}
