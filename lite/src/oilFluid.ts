import * as THREE from 'three';
import { isMobile, assetUrl } from './device';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const MAT_W = 1024;
const MAT_H = 512;
const SIM_W = 256;
const SIM_H = 128;

/**
 * Generates the exact Wyman CIE 1931 Visible-Spectrum Thin-Film Interference Lookup Table (`512x2` RGBA16F)
 * adapted directly from `reckoner-liquid-light.html`!
 * - Row 0 (`v = 0.25`): Curated amber / rose-magenta / abyssal-teal palette-pulled interference spectrum;
 * - Row 1 (`v = 0.75`): True physical soap/oil thin-film spectrum.
 */
export function createWymanThinFilmLUT(): THREE.DataTexture {
  const N = 512;
  const LUT_MAX = 2000.0;
  const n = 1.45;
  const data = new Float32Array(N * 2 * 4);

  const g = (x: number, m: number, a: number, b: number) => {
    const t = (x - m) / (x < m ? a : b);
    return Math.exp(-0.5 * t * t);
  };
  const xb = (l: number) =>
    1.056 * g(l, 599.8, 37.9, 31.0) +
    0.362 * g(l, 442.0, 16.0, 26.7) -
    0.065 * g(l, 501.1, 20.4, 26.2);
  const yb = (l: number) =>
    0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const zb = (l: number) =>
    1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  const toRgb = (X: number, Y: number, Z: number): [number, number, number] => [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ];

  const W: [number, number, number] = [0, 0, 0];
  for (let l = 380; l <= 780; l += 4) {
    W[0] += 0.5 * xb(l);
    W[1] += 0.5 * yb(l);
    W[2] += 0.5 * zb(l);
  }
  const wr = toRgb(W[0], W[1], W[2]);

  const HIN = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];
  const HOUT = [-20, 32, 40, 52, 158, 168, 175, 184, 196, 292, 320, 333, 340];
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const remapHue = (h: number) => {
    for (let j = 0; j < 12; j++) {
      if (h <= HIN[j + 1]) {
        let f = (h - HIN[j]) / 30;
        if (j === 3 || j === 8) {
          f = clamp01((f - 0.3) / 0.4);
          f = f * f * (3 - 2 * f);
        }
        return HOUT[j] + f * (HOUT[j + 1] - HOUT[j]);
      }
    }
    return h;
  };

  const toHsv = ([r, gC, b]: number[]): [number, number, number] => {
    const M = Math.max(r, gC, b);
    const m = Math.min(r, gC, b);
    const C = M - m;
    let h = 0;
    if (C > 1e-6) {
      h = M === r ? ((gC - b) / C) % 6 : M === gC ? (b - r) / C + 2 : (r - gC) / C + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, M > 0 ? C / M : 0, M];
  };

  const fromHsv = (h: number, s: number, v: number): [number, number, number] => {
    const hh = ((h % 360) + 360) % 360;
    const fn = (k: number) => {
      const x = (k + hh / 60) % 6;
      return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
    };
    return [fn(5), fn(3), fn(1)];
  };

  for (let i = 0; i < N; i++) {
    const d = (i / (N - 1)) * LUT_MAX;
    let X = 0;
    let Y = 0;
    let Z = 0;
    for (let l = 380; l <= 780; l += 4) {
      const s = Math.sin((2 * Math.PI * n * d) / l);
      const R = s * s;
      X += R * xb(l);
      Y += R * yb(l);
      Z += R * zb(l);
    }
    const c = toRgb(X, Y, Z).map((v, k) => Math.max(0, v / wr[k]));
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const sat = c.map((v) => Math.max(0, lum + (v - lum) * 1.2));
    const [h, s, v] = toHsv(sat);
    const pal = fromHsv(remapHue(h), Math.min(1, s * 1.1), v);
    const pl = 0.2126 * pal[0] + 0.7152 * pal[1] + 0.0722 * pal[2];
    const k = pl > 1e-4 ? Math.pow(lum / pl, 0.5) : 1;
    for (let j = 0; j < 3; j++) {
      data[i * 4 + j] = Math.min(4, pal[j] * k);
      data[(N + i) * 4 + j] = sat[j];
    }
    data[i * 4 + 3] = 1;
    data[(N + i) * 4 + 3] = 1;
  }

  // Phone GPUs cannot filter 32-bit float textures (the lookup would read as black), so they get the same
  // table in 16-bit floats, which is more than a colour ramp needs.
  const tex = isMobile
    ? new THREE.DataTexture(Uint16Array.from(data, (v) => THREE.DataUtils.toHalfFloat(v)), N, 2, THREE.RGBAFormat, THREE.HalfFloatType)
    : new THREE.DataTexture(data, N, 2, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates the bold, commanding classic upright uppercase serif `"RECKONER"` oil-stamp mask
 * (`R`: thick oil letter core, `G`: surrounding water-clearing moat just like `reckoner-liquid-light.html`!).
 */
function createOilTitleMaskTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = MAT_W;
  canvas.height = MAT_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, MAT_W, MAT_H);

  // Classic monumental upright uppercase serif typography — stretched vertically 1.95x inside texture space
  // to pre-compensate for the 24° perspective water foreshortening so on screen RECKONER looks stately & tall!
  const fontFamily = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
  let fs = Math.round(MAT_H * 0.25);
  ctx.font = `700 ${fs}px ${fontFamily}`;
  const label = 'RECKONER';
  const measured = ctx.measureText(label).width;
  if (measured > MAT_W * 0.86) {
    fs = Math.floor((fs * MAT_W * 0.86) / measured);
    ctx.font = `700 ${fs}px ${fontFamily}`;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = MAT_W * 0.5;
  const cy = MAT_H * 0.52;

  // Channel G: blurred outer moat that clears stray oil drops away from the letters so RECKONER pops cleanly!
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.0, 1.95);
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${Math.max(4, Math.round(fs * 0.14))}px)`;
  ctx.strokeStyle = 'rgb(0, 255, 0)';
  ctx.fillStyle = 'rgb(0, 255, 0)';
  ctx.lineWidth = fs * 0.36;
  ctx.lineJoin = 'round';
  ctx.strokeText(label, 0, 0);
  ctx.fillText(label, 0, 0);
  ctx.restore();

  // Channel R: slightly rounded liquid-surface-tension oil letter fill!
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.0, 1.95);
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(2.0px)';
  ctx.strokeStyle = 'rgb(255, 0, 0)';
  ctx.fillStyle = 'rgb(255, 0, 0)';
  ctx.lineWidth = fs * 0.035;
  ctx.lineJoin = 'round';
  ctx.strokeText(label, 0, 0);
  ctx.fillText(label, 0, 0);
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeRT(w: number, h: number, mips = false): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: mips,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Real-time GPU 2D Navier-Stokes + Allen-Cahn Immiscible Oil-on-Water Phase-Separation +
 * Wyman CIE 1931 Thin-Film Interference Lens Simulator for Shot ① (`0:00 ~ 0:10.5`).
 *
 * Upgraded from `reckoner-liquid-light.html` to `1024x512` RGBA16F resolution and embedded directly
 * onto our 3D perspective boundless ocean water surface!
 * - `0.0s .. 1.9s`: Thick, glassy amber-gold oil letters `"RECKONER"` with rounded surface-tension
 *   menisci, companion oil droplets, and genuine thin-film interference rainbow edges rest on the dark sea.
 * - `1.9s .. 9.8s`: Multi-vortex Balatro-inspired counter-rotating fluid velocity splats churn the
 *   Navier-Stokes field, physically stretching, necking, and snapping the oil letters into cohesive
 *   surface-tension oil ribbons and round beads (thanks to Allen-Cahn `phi - phi^3 + eps^2 * lap(phi)`)
 *   before gracefully dispersing into the dark ocean!
 */
export class OilTitleFluidSystem {
  readonly lutTex: THREE.DataTexture;
  readonly maskTex: THREE.CanvasTexture;

  private vel0 = makeRT(SIM_W, SIM_H);
  private vel1 = makeRT(SIM_W, SIM_H);
  private curlRT = makeRT(SIM_W, SIM_H);
  /** Where each point of the film came from (uv offset into the authored film picture), carried by the flow. */
  private off0 = makeRT(MAT_W, MAT_H);
  private off1 = makeRT(MAT_W, MAT_H);
  private readonly advOffMat: THREE.ShaderMaterial;
  readonly filmTex: THREE.Texture;
  /** 0..~0.5: how far the film has thinned away. */
  thin = 0;
  private divRT = makeRT(SIM_W, SIM_H);
  private prs0 = makeRT(SIM_W, SIM_H);
  private prs1 = makeRT(SIM_W, SIM_H);

  private mat0 = makeRT(MAT_W, MAT_H, true);
  private mat1 = makeRT(MAT_W, MAT_H, true);
  /** Final painted oil RGBA texture (`rgb` = amber glass + Wyman thin-film interference color, `a` = oil lens height/mask) */
  readonly paintRT = makeRT(MAT_W, MAT_H, false);

  private readonly quad: FullScreenQuad;
  private readonly initMat: THREE.ShaderMaterial;
  private readonly advVelMat: THREE.ShaderMaterial;
  private readonly curlMat: THREE.ShaderMaterial;
  private readonly forcesMat: THREE.ShaderMaterial;
  private readonly divMat: THREE.ShaderMaterial;
  private readonly jacobiMat: THREE.ShaderMaterial;
  private readonly gradMat: THREE.ShaderMaterial;
  private readonly advMatShader: THREE.ShaderMaterial;
  private readonly reactMat: THREE.ShaderMaterial;
  private paintMat: THREE.ShaderMaterial;

  private seeded = false;
  private simClock = 0;

  constructor() {
    this.lutTex = createWymanThinFilmLUT();
    this.maskTex = createOilTitleMaskTexture();

    const simTexel = new THREE.Vector2(1.0 / SIM_W, 1.0 / SIM_H);
    const matTexel = new THREE.Vector2(1.0 / MAT_W, 1.0 / MAT_H);
    const aspect = MAT_W / MAT_H; // 2.0

    // 1. Seed initial scattered oil beads + clear moat + thick "RECKONER" oil letters!
    this.initMat = new THREE.ShaderMaterial({
      uniforms: {
        tMask: { value: this.maskTex },
        uAspect: { value: aspect },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tMask;
        uniform float uAspect;

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }
        float fbm(vec2 p) {
          float s = 0.0;
          float a = 0.5;
          for (int i = 0; i < 5; i++) {
            s += a * vnoise(p);
            p = p * 2.03 + 17.1;
            a *= 0.5;
          }
          return s;
        }

        void main() {
          vec2 p = vec2(vUv.x * uAspect, vUv.y);
          // Subtle ambient background oil droplets around the outer perimeter (like a classic 60s oil slide!)
          float blobNoise = 0.66 * vnoise(p * 4.2 + 2.1) + 0.34 * vnoise(p * 8.4 + 5.7);
          float edgeVignette = smoothstep(0.95, 0.55, max(abs(vUv.x - 0.5) * 2.0, abs(vUv.y - 0.5) * 2.0));
          float phi = tanh((blobNoise * edgeVignette - 0.56) * 16.0);

          // Add 8 curated companion round oil beads flanking the title
          vec2 beads[8];
          beads[0] = vec2(0.14, 0.24); beads[1] = vec2(0.86, 0.26);
          beads[2] = vec2(0.22, 0.78); beads[3] = vec2(0.79, 0.76);
          beads[4] = vec2(0.09, 0.52); beads[5] = vec2(0.91, 0.49);
          beads[6] = vec2(0.42, 0.19); beads[7] = vec2(0.61, 0.81);
          for (int i = 0; i < 8; i++) {
            vec2 d = (vUv - beads[i]) * vec2(uAspect, 1.0);
            float r = 0.022 + 0.014 * float(i % 3);
            float m = smoothstep(r, r * 0.65, length(d));
            phi = mix(phi, 1.0, m);
          }

          float film = 0.62 + 0.82 * fbm(p * 4.2 + 7.3);

          // Stamp RECKONER mask: G clears water moat around text, R fills thick oil into letterforms!
          vec4 k = texture2D(tMask, vUv);
          phi = mix(phi, -1.0, clamp(k.g * 1.15, 0.0, 1.0));
          phi = mix(phi, 1.0, clamp(k.r * 1.25, 0.0, 1.0));
          film = mix(film, 0.72 + 0.65 * vUv.x + 0.22 * sin(vUv.y * 9.0), clamp(k.r, 0.0, 1.0));

          gl_FragColor = vec4(phi, 0.0, 0.0, film);
        }
      `,
    });

    this.advVelMat = new THREE.ShaderMaterial({
      uniforms: {
        tVel: { value: null },
        uTexel: { value: simTexel },
        uDt: { value: 0.016 },
        uDiss: { value: 0.99 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tVel;
        uniform vec2 uTexel;
        uniform float uDt;
        uniform float uDiss;
        void main() {
          vec2 c = vUv - uDt * texture2D(tVel, vUv).xy * uTexel;
          gl_FragColor = vec4(texture2D(tVel, c).xy * uDiss, 0.0, 1.0);
        }
      `,
    });

    this.curlMat = new THREE.ShaderMaterial({
      uniforms: {
        tVel: { value: null },
        uTexel: { value: simTexel },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tVel;
        uniform vec2 uTexel;
        void main() {
          float L = texture2D(tVel, vUv - vec2(uTexel.x, 0.0)).y;
          float R = texture2D(tVel, vUv + vec2(uTexel.x, 0.0)).y;
          float B = texture2D(tVel, vUv - vec2(0.0, uTexel.y)).x;
          float T = texture2D(tVel, vUv + vec2(0.0, uTexel.y)).x;
          gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
        }
      `,
    });

    // Vorticity confinement + Allen-Cahn surface tension + Balatro multi-vortex stir!
    this.forcesMat = new THREE.ShaderMaterial({
      uniforms: {
        tVel: { value: null },
        tCurl: { value: null },
        tMat: { value: null },
        uTexel: { value: simTexel },
        uDt: { value: 0.016 },
        uSwirlStrength: { value: 0.0 },
        uTime: { value: 0.0 },
        uAspect: { value: aspect },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tVel;
        uniform sampler2D tCurl;
        uniform sampler2D tMat;
        uniform vec2 uTexel;
        uniform float uDt;
        uniform float uSwirlStrength;
        uniform float uTime;
        uniform float uAspect;

        void main() {
          vec2 tx = vec2(uTexel.x, 0.0);
          vec2 ty = vec2(0.0, uTexel.y);
          float L = texture2D(tCurl, vUv - tx).x;
          float R = texture2D(tCurl, vUv + tx).x;
          float B = texture2D(tCurl, vUv - ty).x;
          float T = texture2D(tCurl, vUv + ty).x;
          float C = texture2D(tCurl, vUv).x;

          vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
          f /= length(f) + 1e-4;
          f *= 4.0 * C;
          f.y = -f.y;

          vec2 v = texture2D(tVel, vUv).xy + f * uDt;

          // Oil-water interfacial surface tension force (pulls stretched oil threads into round droplets!)
          float pC = texture2D(tMat, vUv).x;
          float pL = texture2D(tMat, vUv - tx).x;
          float pR = texture2D(tMat, vUv + tx).x;
          float pB = texture2D(tMat, vUv - ty).x;
          float pT = texture2D(tMat, vUv + ty).x;
          float lap = pL + pR + pB + pT - 4.0 * pC;
          float mu = pC * pC * pC - pC - 1.0 * lap;
          v += 0.0 * mu * 0.5 * vec2(pR - pL, pT - pB) * uDt * (0.15 + 0.85 * uSwirlStrength);

          // Balatro-style hypnotic swirl from t = 1.9 s: one coherent differential rotation around the title
          // centre (fast in the middle, slower outward) so the letters wind into long spiral ribbons instead of
          // tearing, plus a gentle off-centre counter eddy that slowly orbits for an organic, non-mechanical twist.
          if (uSwirlStrength > 0.001) {
            vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
            float r2 = dot(p, p);
            float omega = 36.0 * exp(-r2 / 0.42) + 4.0;
            v += vec2(-p.y, p.x) * omega * uSwirlStrength * uDt;
            vec2 c2 = 0.34 * vec2(cos(uTime * 0.42), sin(uTime * 0.42) * 0.55);
            vec2 d2 = p - c2;
            v -= vec2(-d2.y, d2.x) * 26.0 * exp(-dot(d2, d2) / 0.05) * uSwirlStrength * uDt;
          }

          // Keep fluid bounded away from outer texture borders
          vec2 edge = smoothstep(0.0, 0.08, vUv) * smoothstep(0.0, 0.08, 1.0 - vUv);
          v *= edge.x * edge.y;

          gl_FragColor = vec4(v, 0.0, 1.0);
        }
      `,
    });

    this.divMat = new THREE.ShaderMaterial({
      uniforms: {
        tVel: { value: null },
        uTexel: { value: simTexel },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tVel;
        uniform vec2 uTexel;
        void main() {
          float L = texture2D(tVel, vUv - vec2(uTexel.x, 0.0)).x;
          float R = texture2D(tVel, vUv + vec2(uTexel.x, 0.0)).x;
          float B = texture2D(tVel, vUv - vec2(0.0, uTexel.y)).y;
          float T = texture2D(tVel, vUv + vec2(0.0, uTexel.y)).y;
          gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
        }
      `,
    });

    this.jacobiMat = new THREE.ShaderMaterial({
      uniforms: {
        tP: { value: null },
        tDiv: { value: null },
        uTexel: { value: simTexel },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tP;
        uniform sampler2D tDiv;
        uniform vec2 uTexel;
        void main() {
          float L = texture2D(tP, vUv - vec2(uTexel.x, 0.0)).x;
          float R = texture2D(tP, vUv + vec2(uTexel.x, 0.0)).x;
          float B = texture2D(tP, vUv - vec2(0.0, uTexel.y)).x;
          float T = texture2D(tP, vUv + vec2(0.0, uTexel.y)).x;
          float d = texture2D(tDiv, vUv).x;
          gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
        }
      `,
    });

    this.gradMat = new THREE.ShaderMaterial({
      uniforms: {
        tP: { value: null },
        tVel: { value: null },
        uTexel: { value: simTexel },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tP;
        uniform sampler2D tVel;
        uniform vec2 uTexel;
        void main() {
          float L = texture2D(tP, vUv - vec2(uTexel.x, 0.0)).x;
          float R = texture2D(tP, vUv + vec2(uTexel.x, 0.0)).x;
          float B = texture2D(tP, vUv - vec2(0.0, uTexel.y)).x;
          float T = texture2D(tP, vUv + vec2(0.0, uTexel.y)).x;
          vec2 v = texture2D(tVel, vUv).xy - 0.5 * vec2(R - L, T - B);
          gl_FragColor = vec4(v, 0.0, 1.0);
        }
      `,
    });

    this.advMatShader = new THREE.ShaderMaterial({
      uniforms: {
        tVel: { value: null },
        tMat: { value: null },
        uSimTexel: { value: simTexel },
        uDt: { value: 0.016 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tVel;
        uniform sampler2D tMat;
        uniform vec2 uSimTexel;
        uniform float uDt;
        void main() {
          vec2 c = vUv - uDt * texture2D(tVel, vUv).xy * uSimTexel;
          gl_FragColor = texture2D(tMat, c);
        }
      `,
    });

    // Allen-Cahn phase-field un-mixing (phi += M * (eps^2 * lap + phi - phi^3) - dissolveSink)
    // Keeps oil crisp & immiscible with rounded surface-tension edges even while swirling & thinning out!
    this.reactMat = new THREE.ShaderMaterial({
      uniforms: {
        tMat: { value: null },
        tVel: { value: null },
        uTexel: { value: matTexel },
        uTitleHold: { value: 1.0 },
        uDissolveSink: { value: 0.0 },
        uTime: { value: 0.0 },
        uAspect: { value: aspect },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tMat;
        uniform sampler2D tVel;
        uniform vec2 uTexel;
        uniform float uTitleHold;
        uniform float uDissolveSink;
        uniform float uTime;
        uniform float uAspect;

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        void main() {
          vec4 C = texture2D(tMat, vUv);
          vec4 L = texture2D(tMat, vUv - vec2(uTexel.x, 0.0));
          vec4 R = texture2D(tMat, vUv + vec2(uTexel.x, 0.0));
          vec4 B = texture2D(tMat, vUv - vec2(0.0, uTexel.y));
          vec4 T = texture2D(tMat, vUv + vec2(0.0, uTexel.y));
          vec4 lap = L + R + B + T - 4.0 * C;

          float phi = C.x;
          float film = C.w;

          // Mass-compensating Allen-Cahn phase reaction:
          // Between 0s..6.4s (uDissolveSink == 0), adds a gentle positive droplet-growth bias (+0.0045)
          // to counter semi-Lagrangian numerical diffusion so at t = 5.0s the swirling amber oil ribbons
          // & Plateau-Rayleigh droplets stay 100% rich, thick, and glossy!
          float mobility = mix(0.072, 0.014, uTitleHold);
          float massPreserveBias = (1.0 - step(0.001, uDissolveSink)) * 0.0042 * max(0.0, 1.0 - phi * phi);
          phi += mobility * (2.4 * lap.x + phi - phi * phi * phi) + massPreserveBias;

          // Disperse cleanly ONLY during 6.5s..9.0s!
          phi -= uDissolveSink * max(1.0 - phi * phi * 0.20, 0.35);

          float spd = length(texture2D(tVel, vUv).xy);
          film += 0.055 * lap.w + (1.0 - film) * 0.0015;
          vec2 q = vUv * vec2(uAspect, 1.0);
          float n = vnoise(q * 28.0 + vec2(uTime * 0.8, -uTime * 0.6)) - 0.5;
          film += 0.014 * n * smoothstep(0.3, 8.0, spd);

          gl_FragColor = vec4(clamp(phi, -1.05, 1.05), 0.0, 0.0, clamp(film, 0.32, 1.85));
        }
      `,
    });

    // Paint shader directly modeled on FS.paint from reckoner-liquid-light.html!
    // Amber glass in the thick oil interior + Wyman CIE 1931 thin-film interference rainbow along the thin curved meniscus rim!
    this.paintMat = new THREE.ShaderMaterial({
      uniforms: {
        tMat: { value: null },
        tLUT: { value: this.lutTex },
        uTexel: { value: matTexel },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tMat;
        uniform sampler2D tLUT;
        uniform vec2 uTexel;

        vec3 sampleWymanLUT(float opdNm, float trueMix) {
          float x = clamp(opdNm / 2000.0, 0.0, 1.0);
          return mix(
            texture2D(tLUT, vec2(x, 0.25)).rgb,
            texture2D(tLUT, vec2(x, 0.75)).rgb,
            trueMix
          );
        }

        void main() {
          vec4 m = texture2D(tMat, vUv);
          // Multi-tap blurred oil profile (mb) for smooth 3D convex oil-drop dome thickness & meniscus rim!
          vec2 r1 = uTexel * 3.5;
          vec2 r2 = uTexel * 8.0;
          vec4 mb = (
            texture2D(tMat, vUv + vec2(r1.x, 0.0)) +
            texture2D(tMat, vUv - vec2(r1.x, 0.0)) +
            texture2D(tMat, vUv + vec2(0.0, r1.y)) +
            texture2D(tMat, vUv - vec2(0.0, r1.y)) +
            texture2D(tMat, vUv + vec2(r2.x, r2.y)) +
            texture2D(tMat, vUv - vec2(r2.x, r2.y)) +
            texture2D(tMat, vUv + vec2(-r2.x, r2.y)) +
            texture2D(tMat, vUv + vec2(r2.x, -r2.y))
          ) * 0.125;

          float oilMask = smoothstep(-0.42, 0.42, m.x);
          // Convex dome thickness: 0 at outer meniscus rim -> 1 in the thick amber-glass center.
          float domeProf = smoothstep(-0.30, 0.92, mb.x);
          float thinRim = clamp(1.0 - domeProf, 0.0, 1.0);

          // Thin-film spectrum: optical path follows the film field and thins toward the rim,
          // so the rim cycles through gold / magenta / violet / teal like oil on a wet road.
          float opd = 560.0 * m.w * (0.05 + domeProf * 1.05) + 120.0;
          vec3 filmSpectrum = sampleWymanLUT(opd, 0.9);
          // The LUT is pastel near white; push saturation so the rim reads as oil-slick colour, not chalk.
          float fl = dot(filmSpectrum, vec3(0.2126, 0.7152, 0.0722));
          filmSpectrum = max(vec3(0.0), fl + (filmSpectrum - fl) * 1.7) * 0.85;

          // Deep honey-amber glass; slightly lighter and more golden where the dome is thick (light pools there).
          vec3 amberGlass = mix(vec3(0.50, 0.13, 0.012), vec3(0.88, 0.40, 0.050), domeProf)
                          * mix(0.80, 1.05, smoothstep(0.5, 1.5, m.w));
          // Interference colour lives in a narrow band at the meniscus (where the phase field crosses over),
          // plus a faint marbled sheen across the glass that follows the film-thickness field.
          float meniscus = smoothstep(-0.70, -0.15, mb.x) * (1.0 - smoothstep(0.20, 0.75, mb.x));
          float sheen = 0.10 * smoothstep(0.9, 1.5, m.w);
          float rimBand = clamp(meniscus * 0.95 + sheen, 0.0, 0.95);
          vec3 oilColor = mix(amberGlass, filmSpectrum, rimBand);
          // Black at the very edge (light refracts away at the steep meniscus) gives the letters a crisp contour.
          oilColor *= mix(0.25, 1.0, smoothstep(0.06, 0.45, oilMask));

          // Smooth dome lens height for the water shader (normals, refraction, caustics, glints).
          float lensHeight = oilMask * (0.22 + 0.78 * domeProf);
          gl_FragColor = vec4(oilColor * oilMask, lensHeight);
        }
      `,
    });

    // Shot ① film: the user's authored picture (public/img/reckoner-film.jpg) is the film at rest.
    // The flow carries a uv-offset field, so the picture winds up without blurring; as the film thins,
    // the dimmest (thinnest) parts let go first and the bands break into streaks.
    this.filmTex = new THREE.TextureLoader().load(assetUrl('img/reckoner-film.jpg'));
    this.filmTex.colorSpace = THREE.SRGBColorSpace;
    this.filmTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.filmTex.generateMipmaps = true;
    this.filmTex.anisotropy = 8;
    this.advOffMat = new THREE.ShaderMaterial({
      uniforms: {
        tVel: { value: null },
        tOff: { value: null },
        uSimTexel: { value: new THREE.Vector2(1 / SIM_W, 1 / SIM_H) },
        uDt: { value: 0.016 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tVel;
        uniform sampler2D tOff;
        uniform vec2 uSimTexel;
        uniform float uDt;
        void main() {
          vec2 d = uDt * texture2D(tVel, vUv).xy * uSimTexel;
          gl_FragColor = vec4(texture2D(tOff, vUv - d).xy - d, 0.0, 1.0);
        }
      `,
    });
    this.paintMat = new THREE.ShaderMaterial({
      uniforms: {
        tMat: { value: null },
        tOff: { value: this.off0.texture },
        tImg: { value: this.filmTex },
        uThin: { value: 0.0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tOff;
        uniform sampler2D tImg;
        uniform float uThin;
        void main() {
          vec2 src = vUv + texture2D(tOff, vUv).xy;
          vec3 c = texture2D(tImg, src).rgb;
          float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
          vec2 e = smoothstep(0.0, 0.10, vUv) * smoothstep(0.0, 0.10, 1.0 - vUv);
          vec2 es = smoothstep(0.0, 0.02, src) * smoothstep(0.0, 0.02, 1.0 - src);
          float keep = smoothstep(uThin * 1.2 - 0.2, uThin * 1.2, lum) * e.x * e.y * es.x * es.y;
          // a = film height for the water shader (relief, glints, coverage); bare black water where the picture is dark
          gl_FragColor = vec4(c * keep, smoothstep(0.008, 0.22, lum) * keep);
        }
      `,
    });

    this.quad = new FullScreenQuad(this.initMat);
  }

  private runPass(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  /** Flow-carried uv offset into the film picture; the water shader samples the picture itself at full resolution. */
  get offTexture(): THREE.Texture {
    return this.off0.texture;
  }

  resetAndSeed(renderer: THREE.WebGLRenderer): void {
    this.thin = 0;
    const prevRT = renderer.getRenderTarget();
    const prevCol = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();

    renderer.setClearColor(0x000000, 0);
    for (const rt of [this.vel0, this.vel1, this.prs0, this.prs1, this.curlRT, this.divRT, this.off0, this.off1]) {
      renderer.setRenderTarget(rt);
      renderer.clear();
    }
    renderer.setClearColor(prevCol, prevAlpha);

    this.runPass(renderer, this.initMat, this.mat0);
    this.paintMat.uniforms.tOff.value = this.off0.texture;
    this.paintMat.uniforms.uThin.value = 0.0;
    this.paintMat.uniforms.tMat.value = this.mat0.texture;
    this.runPass(renderer, this.paintMat, this.paintRT);

    renderer.setRenderTarget(prevRT);
    this.seeded = true;
    this.simClock = 0;
  }

  step(renderer: THREE.WebGLRenderer, dt: number, songTime: number, visibility: number): void {
    if (visibility <= 0.002) return;
    if (!this.seeded || (songTime < 0.15 && this.simClock > 0.5)) {
      this.resetAndSeed(renderer);
    }

    const stepDt = Math.min(0.025, Math.max(0.004, dt));
    this.simClock = songTime;

    // 0..1.9s: gentle breathing stillness holding crisp thick oil letters;
    // 1.9s..9.8s: swirling Balatro Navier-Stokes eddies stretch & tear the oil letters into ribbons & beads!
    const swirlAmt =
      THREE.MathUtils.smoothstep(songTime, 1.85, 3.8) *
      (1.0 - THREE.MathUtils.smoothstep(songTime, 9.0, 10.8));
    const titleHold = 1.0 - THREE.MathUtils.smoothstep(songTime, 1.85, 2.8);
    // ZERO sink before t = 6.45s so t = 5.0s (`m1_03`) is at peak swirling amber-iridescent beauty!
    const dissolveSink = THREE.MathUtils.smoothstep(songTime, 7.4, 9.6) * 0.06;

    const prevRT = renderer.getRenderTarget();

    // 1. Advect velocity
    this.advVelMat.uniforms.tVel.value = this.vel0.texture;
    this.advVelMat.uniforms.uDt.value = stepDt;
    this.advVelMat.uniforms.uDiss.value = Math.exp(-stepDt / 2.2);
    this.runPass(renderer, this.advVelMat, this.vel1);
    [this.vel0, this.vel1] = [this.vel1, this.vel0];

    // 2. Curl + Vorticity Confinement + Oil Surface Tension + Balatro Eddies
    this.curlMat.uniforms.tVel.value = this.vel0.texture;
    this.runPass(renderer, this.curlMat, this.curlRT);

    this.forcesMat.uniforms.tVel.value = this.vel0.texture;
    this.forcesMat.uniforms.tCurl.value = this.curlRT.texture;
    this.forcesMat.uniforms.tMat.value = this.mat0.texture;
    this.forcesMat.uniforms.uDt.value = stepDt;
    this.forcesMat.uniforms.uSwirlStrength.value = swirlAmt;
    this.forcesMat.uniforms.uTime.value = songTime;
    this.runPass(renderer, this.forcesMat, this.vel1);
    [this.vel0, this.vel1] = [this.vel1, this.vel0];

    // 3. Divergence + 14 Jacobi Pressure Projections + Gradient Subtract
    this.divMat.uniforms.tVel.value = this.vel0.texture;
    this.runPass(renderer, this.divMat, this.divRT);

    for (let i = 0; i < 14; i++) {
      this.jacobiMat.uniforms.tP.value = this.prs0.texture;
      this.jacobiMat.uniforms.tDiv.value = this.divRT.texture;
      this.runPass(renderer, this.jacobiMat, this.prs1);
      [this.prs0, this.prs1] = [this.prs1, this.prs0];
    }

    this.gradMat.uniforms.tP.value = this.prs0.texture;
    this.gradMat.uniforms.tVel.value = this.vel0.texture;
    this.runPass(renderer, this.gradMat, this.vel1);
    [this.vel0, this.vel1] = [this.vel1, this.vel0];

    // 4. Advect Oil Phase-Field + Allen-Cahn Un-mixing Reaction
    this.advMatShader.uniforms.tVel.value = this.vel0.texture;
    this.advMatShader.uniforms.tMat.value = this.mat0.texture;
    this.advMatShader.uniforms.uDt.value = stepDt;
    this.runPass(renderer, this.advMatShader, this.mat1);
    [this.mat0, this.mat1] = [this.mat1, this.mat0];

    this.reactMat.uniforms.tMat.value = this.mat0.texture;
    this.reactMat.uniforms.tVel.value = this.vel0.texture;
    this.reactMat.uniforms.uTitleHold.value = titleHold;
    this.reactMat.uniforms.uDissolveSink.value = dissolveSink;
    this.reactMat.uniforms.uTime.value = songTime;
    this.runPass(renderer, this.reactMat, this.mat1);
    [this.mat0, this.mat1] = [this.mat1, this.mat0];

    // 5. Carry the film picture with the flow, then paint it
    this.advOffMat.uniforms.tVel.value = this.vel0.texture;
    this.advOffMat.uniforms.tOff.value = this.off0.texture;
    this.advOffMat.uniforms.uDt.value = stepDt;
    this.runPass(renderer, this.advOffMat, this.off1);
    [this.off0, this.off1] = [this.off1, this.off0];
    this.paintMat.uniforms.tOff.value = this.off0.texture;
    this.thin = THREE.MathUtils.smoothstep(songTime, 6.2, 9.8) * 0.5;
    this.paintMat.uniforms.uThin.value = this.thin;
    this.paintMat.uniforms.tMat.value = this.mat0.texture;
    this.runPass(renderer, this.paintMat, this.paintRT);

    renderer.setRenderTarget(prevRT);
  }
}
