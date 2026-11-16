import * as THREE from 'three';

export interface PostPipelineState {
  feedbackStrength: number;
  breathStrength: number;
  breathPhase: number;
  time: number;
  exposure?: number;
  /** Screen-space waterline (0 = bottom, 1 = top). Everything below it is graded as underwater. */
  submergeLine?: number;
  /** 0..1: water drops on the lens (after surfacing). */
  lensDrops?: number;
  flash?: number;
  flashTint?: [number, number, number];
  chroma?: number;
  /** Depth of field: focus distance in metres, aperture 0..1, camera clip planes. */
  focusDist?: number;
  aperture?: number;
  camNear?: number;
  camFar?: number;
  /** Whole-frame mirror fold. */
  worldFold?: number;
  foldN?: number;
  foldSpin?: number;
  rush?: number;
  aspect?: number;
  /** Up to four light sources in screen space: x, y (0..1), strength. */
  shafts?: [number, number, number][];
  /** Height of the picture as a fraction of the frame (2.39:1 letterbox); 1 = no bars. */
  band?: number;
  /** 0..1: the edges of the picture fall softly out of focus (shot ②). */
  edgeSoft?: number;
  /** One strong light behind things (screen x, y, strength): its light streams past them through the fog. */
  sweepShaft?: [number, number, number];
  /** 0..1: the camera is under water — deep, contrasty teal instead of a bright milky veil. */
  underGrade?: number;
}

export interface PostPipelineHandles {
  /** 4x Hardware MSAA HDR RenderTarget — eliminates staircase aliasing on silk rims & water speculars! */
  sceneRT: THREE.WebGLRenderTarget;
  renderFinal: (renderer: THREE.WebGLRenderer, state: PostPipelineState) => void;
  resize: (width: number, height: number, dpr: number) => void;
  /** Restrict drawing to the letterboxed picture (band = its height as a fraction of the frame). */
  setBand: (band: number) => void;
  resetFeedback: (renderer: THREE.WebGLRenderer) => void;
}

export function createPostPipeline(width: number, height: number, dpr: number): PostPipelineHandles {
  const effW = Math.max(1, Math.floor(width * dpr));
  const effH = Math.max(1, Math.floor(height * dpr));

  // WebGL2 4x MSAA HDR multisampled scene buffer (solves all jagged wireframe/reflection aliasing!)
  const sceneRT = new THREE.WebGLRenderTarget(effW, effH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,
  });
  sceneRT.depthTexture = new THREE.DepthTexture(effW, effH);
  sceneRT.depthTexture.type = THREE.UnsignedIntType;

  // Full-res lens buffer: scene after depth of field
  const dofRT = new THREE.WebGLRenderTarget(effW, effH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });

  // Bloom mip chain (1/2 .. 1/64): wide, energy-spread halation instead of a single blur
  const BLOOM_LEVELS = 6;
  const mkRT = (w: number, h: number) =>
    new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
  const bloomDown: THREE.WebGLRenderTarget[] = [];
  const bloomUp: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < BLOOM_LEVELS; i++) {
    bloomDown.push(mkRT(effW >> (i + 1), effH >> (i + 1)));
    bloomUp.push(mkRT(effW >> (i + 1), effH >> (i + 1)));
  }

  // Half-res soft cinematic bloom buffers (horizontal + vertical separable Gaussian)
  const bloomW = Math.max(1, Math.floor(effW * 0.5));
  const bloomH = Math.max(1, Math.floor(effH * 0.5));
  const bloomRT0 = new THREE.WebGLRenderTarget(bloomW, bloomH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  const bloomRT1 = new THREE.WebGLRenderTarget(bloomW, bloomH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });

  // Half-res ping-pong buffers for delicate vocal analog feedback
  let fbRT0 = new THREE.WebGLRenderTarget(bloomW, bloomH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  let fbRT1 = new THREE.WebGLRenderTarget(bloomW, bloomH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });

  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  const vert = /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  // 1A. Soft Cinematic Highlight Extract + Horizontal Blur
  const bloomBlurHMat = new THREE.ShaderMaterial({
    uniforms: {
      tInput: { value: sceneRT.texture },
      uTexel: { value: new THREE.Vector2(1.0 / bloomW, 1.0 / bloomH) },
    },
    vertexShader: vert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tInput;
      uniform vec2 uTexel;

      vec3 extractSoftHighlight(vec3 c) {
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float knee = smoothstep(0.68, 1.78, lum);
        return min(c, vec3(4.5)) * knee;
      }

      void main() {
        float dx = uTexel.x * 1.65;
        vec3 sum = extractSoftHighlight(texture2D(tInput, vUv).rgb) * 0.227027;
        sum += extractSoftHighlight(texture2D(tInput, vUv + vec2(dx * 1.3846, 0.0)).rgb) * 0.316216;
        sum += extractSoftHighlight(texture2D(tInput, vUv - vec2(dx * 1.3846, 0.0)).rgb) * 0.316216;
        sum += extractSoftHighlight(texture2D(tInput, vUv + vec2(dx * 3.2307, 0.0)).rgb) * 0.070270;
        sum += extractSoftHighlight(texture2D(tInput, vUv - vec2(dx * 3.2307, 0.0)).rgb) * 0.070270;
        gl_FragColor = vec4(sum, 1.0);
      }
    `,
  });

  // 1B. Vertical Bloom Blur
  const bloomBlurVMat = new THREE.ShaderMaterial({
    uniforms: {
      tInput: { value: bloomRT0.texture },
      uTexel: { value: new THREE.Vector2(1.0 / bloomW, 1.0 / bloomH) },
    },
    vertexShader: vert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tInput;
      uniform vec2 uTexel;

      void main() {
        float dy = uTexel.y * 1.65;
        vec3 sum = texture2D(tInput, vUv).rgb * 0.227027;
        sum += texture2D(tInput, vUv + vec2(0.0, dy * 1.3846)).rgb * 0.316216;
        sum += texture2D(tInput, vUv - vec2(0.0, dy * 1.3846)).rgb * 0.316216;
        sum += texture2D(tInput, vUv + vec2(0.0, dy * 3.2307)).rgb * 0.070270;
        sum += texture2D(tInput, vUv - vec2(0.0, dy * 3.2307)).rgb * 0.070270;
        gl_FragColor = vec4(sum, 1.0);
      }
    `,
  });


  // 1C. Bloom chain: 13-tap downsample and 9-tap tent upsample
  const bloomDownMat = new THREE.ShaderMaterial({
    uniforms: {
      tInput: { value: null as THREE.Texture | null },
      uTexel: { value: new THREE.Vector2() },
      uPrefilter: { value: 0.0 },
    },
    vertexShader: vert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tInput;
      uniform vec2 uTexel;
      uniform float uPrefilter;
      vec3 pre(vec3 c) {
        if (uPrefilter < 0.5) return c;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float knee = smoothstep(0.62, 1.70, lum);
        // Karis weight tames single hot pixels so highlights do not flicker
        return min(c, vec3(5.0)) * knee / (1.0 + lum * 0.18);
      }
      // One invalid pixel (NaN or Inf from any material) would be spread by the blur chain into a large
      // black rectangle for a frame. Anything that is not a finite colour becomes black here, once.
      vec3 sane(vec3 c) {
        bool bad = any(isnan(c)) || any(isinf(c)) || !(c.r == c.r && c.g == c.g && c.b == c.b);
        return bad ? vec3(0.0) : clamp(c, vec3(0.0), vec3(256.0));
      }
      vec3 tap(vec2 o) { return pre(sane(texture2D(tInput, vUv + o * uTexel).rgb)); }
      void main() {
        vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
        vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
        vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
        vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0)), l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
        vec3 sum = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
        gl_FragColor = vec4(sum, 1.0);
      }
    `,
  });
  const bloomUpMat = new THREE.ShaderMaterial({
    uniforms: {
      tLow: { value: null as THREE.Texture | null },
      tHigh: { value: null as THREE.Texture | null },
      uTexel: { value: new THREE.Vector2() },
      uWeight: { value: 1.0 },
    },
    vertexShader: vert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLow;
      uniform sampler2D tHigh;
      uniform vec2 uTexel;
      uniform float uWeight;
      void main() {
        vec2 d = uTexel;
        vec3 s = texture2D(tLow, vUv).rgb * 4.0;
        s += (texture2D(tLow, vUv + vec2(d.x, 0.0)).rgb + texture2D(tLow, vUv - vec2(d.x, 0.0)).rgb
            + texture2D(tLow, vUv + vec2(0.0, d.y)).rgb + texture2D(tLow, vUv - vec2(0.0, d.y)).rgb) * 2.0;
        s += texture2D(tLow, vUv + d).rgb + texture2D(tLow, vUv - d).rgb
           + texture2D(tLow, vUv + vec2(d.x, -d.y)).rgb + texture2D(tLow, vUv + vec2(-d.x, d.y)).rgb;
        gl_FragColor = vec4(texture2D(tHigh, vUv).rgb * uWeight + s / 16.0, 1.0);
      }
    `,
  });

  // 1D. Depth of field: golden-spiral gather weighted by each tap's own circle of confusion
  const dofMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: sceneRT.texture },
      tDepth: { value: sceneRT.depthTexture },
      uTexel: { value: new THREE.Vector2(1.0 / effW, 1.0 / effH) },
      uNear: { value: 0.12 },
      uFar: { value: 90.0 },
      uFocus: { value: 6.0 },
      uAperture: { value: 0.0 },
      uMaxRadius: { value: 8.0 },
    },
    vertexShader: vert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tScene;
      uniform sampler2D tDepth;
      uniform vec2 uTexel;
      uniform float uNear;
      uniform float uFar;
      uniform float uFocus;
      uniform float uAperture;
      uniform float uMaxRadius;
      // One invalid pixel (NaN or Inf from any material) would be spread by the blur chain into a large
      // black rectangle for a frame. Anything that is not a finite colour becomes black here, once.
      vec3 sane(vec3 c) {
        bool bad = any(isnan(c)) || any(isinf(c)) || !(c.r == c.r && c.g == c.g && c.b == c.b);
        return bad ? vec3(0.0) : clamp(c, vec3(0.0), vec3(256.0));
      }
      float linDepth(vec2 uv) {
        float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
        return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
      }
      float cocAt(vec2 uv) {
        float d = linDepth(uv);
        float c = (d - uFocus) / max(d, 0.05);
        // foreground blurs faster than background, background is capped (cinema prime at a wide stop)
        c = c < 0.0 ? -c * 1.6 : c * 0.62;
        return clamp(c * uAperture, 0.0, 1.0);
      }
      void main() {
        vec3 centre = sane(texture2D(tScene, vUv).rgb);
        float coc = cocAt(vUv);
        if (uAperture < 0.01 || coc < 0.04) { gl_FragColor = vec4(centre, 1.0); return; }
        float R = coc * uMaxRadius;
        vec3 acc = centre;
        float wsum = 1.0;
        const float GA = 2.39996323;
        float rot = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
        for (int i = 1; i <= 16; i++) {
          float fi = float(i);
          float r = sqrt(fi / 16.0) * R;
          vec2 o = vec2(cos(fi * GA + rot), sin(fi * GA + rot)) * r * uTexel;
          vec2 uv = clamp(vUv + o, 0.001, 0.999);
          vec3 c = sane(texture2D(tScene, uv).rgb);
          float tc = cocAt(uv);
          // a sharp neighbour must not smear into the blur; bright taps bloom into bokeh discs
          float w = smoothstep(0.0, 0.5, tc * uMaxRadius - r * 0.55 + 0.6);
          w *= 1.0 + 0.55 * min(dot(c, vec3(0.2126, 0.7152, 0.0722)), 4.0);
          acc += c * w;
          wsum += w;
        }
        gl_FragColor = vec4(acc / wsum, 1.0);
      }
    `,
  });

  // 2. Analog Video Feedback Update Pass
  const feedbackUpdateMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: sceneRT.texture },
      tPrevFeedback: { value: fbRT0.texture },
      uFeedbackStrength: { value: 0.0 },
      uTime: { value: 0.0 },
    },
    vertexShader: vert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tScene;
      uniform sampler2D tPrevFeedback;
      uniform float uFeedbackStrength;
      uniform float uTime;

      void main() {
        if (uFeedbackStrength <= 0.001) {
          gl_FragColor = vec4(0.0);
          return;
        }
        vec2 centered = vUv - vec2(0.5, 0.54);
        float angle = 0.012 * sin(uTime * 0.30 + 0.7);
        float c = cos(angle);
        float s = sin(angle);
        vec2 rotated = mat2(c, -s, s, c) * (centered * 0.978);
        vec2 prevUv = clamp(rotated + vec2(0.5, 0.54), 0.002, 0.998);

        vec3 prevCol = texture2D(tPrevFeedback, prevUv).rgb * vec3(0.96, 0.93, 0.98);
        vec3 sceneCol = texture2D(tScene, vUv).rgb;
        float lum = dot(sceneCol, vec3(0.2126, 0.7152, 0.0722));
        vec3 seed = sceneCol * smoothstep(0.06, 0.42, lum);

        float persistence = mix(0.72, 0.91, clamp(uFeedbackStrength, 0.0, 1.0));
        vec3 outCol = prevCol * persistence + seed * (0.24 * uFeedbackStrength);
        gl_FragColor = vec4(min(outCol, vec3(2.2)), 1.0);
      }
    `,
  });

  // 3. Final Composite: Soft Anamorphic Halation + Blender-Exact AgX Tone Mapping + 35mm Kodak Grain
  const compositeMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: sceneRT.texture },
      tBloom: { value: bloomRT1.texture },
      tFeedback: { value: fbRT0.texture },
      uFeedbackStrength: { value: 0.0 },
      uBreathStrength: { value: 0.0 },
      uBreathPhase: { value: 0.0 },
      uExposure: { value: 0.96 },
      uTime: { value: 0.0 },
      uSubmerge: { value: -1.0 },
      uLensDrops: { value: 0.0 },
      uFlash: { value: 0.0 },
      uFlashTint: { value: new THREE.Vector3(1, 1, 1) },
      uChroma: { value: 1.0 },
      uFold: { value: 0.0 },
      uFoldN: { value: 6.0 },
      uFoldSpin: { value: 0.0 },
      uRush: { value: 0.0 },
      uAspect: { value: 1.78 },
      tBright: { value: null as THREE.Texture | null },
      uShaft: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uSweep: { value: new THREE.Vector3() },
      uBand: { value: 1.0 },
      uEdgeSoft: { value: 0.0 },
      uUnderGrade: { value: 0.0 },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 800) },
    },
    vertexShader: vert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tScene;
      uniform sampler2D tBloom;
      uniform sampler2D tFeedback;
      uniform float uFeedbackStrength;
      uniform float uBreathStrength;
      uniform float uBreathPhase;
      uniform float uExposure;
      uniform float uTime;
      uniform float uSubmerge;
      uniform float uLensDrops;
      uniform float uFlash;
      uniform vec3 uFlashTint;
      uniform float uChroma;
      uniform float uFold;
      uniform float uFoldN;
      uniform float uFoldSpin;
      uniform float uRush;
      uniform float uAspect;
      uniform sampler2D tBright;
      uniform vec3 uShaft[4];
      uniform vec3 uSweep;
      uniform float uBand;
      uniform float uEdgeSoft;
      uniform float uUnderGrade;
      uniform vec2 uTexel;

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      // The waterline across a half-submerged lens, as a height on screen for a given x (aspect-scaled).
      // From the measured UE5 reference: a 3–5 s swell, chop about once a second, a degree or two of roll;
      // plus the bow a wide lens gives any line this close to it (the edges bend upward).
      float wlAt(float xa) {
        return 0.5 + (uSubmerge - 0.5) * uBand
             + xa * 0.026 * sin(uTime * 0.83)
             + 0.030 * sin(xa * 1.7 + uTime * 1.3)
             + 0.007 * sin(xa * 4.3 - uTime * 6.6 + 0.8 * sin(xa * 1.1 + uTime))
             + 0.0022 * sin(xa * 13.0 + uTime * 9.1)
             + 0.040 * xa * xa * uBand;
      }

      // Exact Troy Sobotka / Blender / Three.js AgX Tone Mapping (Linear Rec.709 -> AgX Log -> Contrast Curve -> sRGB)
      // Preserves creamy warm ivory silk highlights & golden amber glow without skewing to yellow or clipping white!
      vec3 agxDefaultContrastApprox(vec3 x) {
        vec3 x2 = x * x;
        vec3 x4 = x2 * x2;
        return + 15.5     * x4 * x2
               - 40.14    * x4 * x
               + 31.96    * x4
               - 6.868    * x2 * x
               + 0.4298   * x2
               + 0.1191   * x
               - 0.00232;
      }

      vec3 agxToneMapping(vec3 color) {
        const mat3 agxMat = mat3(
          0.842479062253094,  0.0423282422610123, 0.0423756549057051,
          0.0784335999999992, 0.878468636469772,  0.0784336,
          0.0792237451477643, 0.0791661274605434, 0.879142973793104
        );
        const mat3 agxMatInv = mat3(
          1.19687900512017,   -0.0528968517574562, -0.0529716355144438,
         -0.0980208811401368,  1.15190312990417,   -0.0980434501171241,
         -0.0990297440797205, -0.0989611768448433,  1.15107367264116
        );
        const float minEv = -12.47393;
        const float maxEv = 4.026069;

        vec3 val = agxMat * max(color, vec3(1e-6));
        val = clamp(log2(val), minEv, maxEv);
        val = (val - minEv) / (maxEv - minEv);
        val = agxDefaultContrastApprox(val);

        // Subtle AgX "Punchy / Golden" look boost so shadows stay velvety deep while silks stay creamy
        float luma = dot(val, vec3(0.2126, 0.7152, 0.0722));
        val = luma + (val - luma) * 1.12;
        val = agxMatInv * val;
        // AgX output is display-encoded; linearize so linearToSRGB below does not encode twice (grey-veil fix)
        val = pow(max(val, vec3(0.0)), vec3(2.2));
        return clamp(val, 0.0, 1.0);
      }

      vec3 linearToSRGB(vec3 lin) {
        vec3 lo = lin * 12.92;
        vec3 hi = 1.055 * pow(max(lin, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
        return mix(lo, hi, step(vec3(0.0031308), lin));
      }

      void main() {
        if (uBand < 0.999 && abs(vUv.y - 0.5) > 0.5 * uBand + 0.003) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
        vec2 centered = vUv - 0.5;
        float r2 = dot(centered, centered);
        float breathWarp = sin(uBreathPhase) * 0.0038 * uBreathStrength * (1.0 - r2);
        vec2 sampleUv = clamp(vUv + centered * breathWarp, 0.001, 0.999);

        // Waterline sweeping through the lens when the camera crosses the surface.
        // A lens half in the water does not show a thin line: the meniscus on the glass is a thick band.
        // Its upper lip is dark, its middle looks up at the underside of the surface, and below it is water.
        float lineActive = step(-0.2, uSubmerge);
        float crossing = lineActive * step(uSubmerge, 1.2);
        float xa = (vUv.x - 0.5) * uAspect;
        float wl = wlAt(xa);
        // The meniscus is a lens of water a few per cent of the frame thick, fatter where the swell piles up.
        float thick = (0.012 + 0.022 * pow(0.5 + 0.5 * sin(xa * 2.3 - uTime * 1.7 + 0.9 * sin(xa * 0.9 + uTime * 0.5)), 1.6)) * (0.7 + 0.3 * uBand);
        float dLine = vUv.y - wl;
        float dN = dLine / thick;                                   // +1 at its top edge, -1 at its foot
        float inBand = (1.0 - smoothstep(0.85, 1.0, abs(dN))) * crossing;
        // its body (everything under the bright rim) looks back down into the water: total reflection
        float bandMid = inBand * (1.0 - smoothstep(0.55, 0.80, dN));
        // a thin dark line just under the rim, where the curved water turns the view away from any light
        float bandLip = crossing * exp(-((dN - 0.62) / 0.08) * ((dN - 0.62) / 0.08));
        float band = bandMid;
        float under = max(smoothstep(-thick + 0.003, -thick - 0.003, dLine) * lineActive, bandMid);
        sampleUv += under * vec2(sin(vUv.y * 13.0 + uTime * 1.25), cos(vUv.x * 10.0 + uTime * 1.05)) * 0.0024;
        // inside the band the picture is the water below it, mirrored and stretched (total reflection)
        sampleUv.y = mix(sampleUv.y, wl - thick - (dLine + thick) * 2.6, bandMid);
        sampleUv.x = mix(sampleUv.x, 0.5 + (sampleUv.x - 0.5) * 0.93, bandMid);
        sampleUv.x += bandMid * 0.008 * sin(xa * 23.0 + uTime * 5.0);
        // just above the lip a film of water still runs off the glass
        sampleUv.y += crossing * 0.010 * exp(-max(dLine - thick, 0.0) / 0.018) * step(thick, dLine) * (0.6 + 0.4 * sin(xa * 31.0 + uTime * 3.0));

        // Drops left on the lens. They are far out of focus, so each one is a soft patch that bends the
        // picture behind it; they dry one by one.
        float dropShade = 0.0;
        float dropGlint = 0.0;
        if (uLensDrops > 0.002) {
          float above = smoothstep(thick, thick + 0.03, dLine) + (1.0 - crossing);
          above = clamp(above, 0.0, 1.0);
          for (int L = 0; L < 2; L++) {
            float sc = L == 0 ? 3.1 : 6.3;
            float fl = float(L);
            vec2 g = vec2(xa, vUv.y) * sc + vec2(3.7 * fl, 1.3 * fl);
            float colId = floor(g.x);
            // the heavier ones creep down the glass
            g.y += uTime * (L == 0 ? 0.016 : 0.004) * (0.3 + hash12(vec2(colId, 7.0 + fl)));
            vec2 gi = floor(g);
            vec2 gf = fract(g) - 0.5;
            float h = hash12(gi + 17.3 * fl + 0.5);
            float thr = 1.0 - (L == 0 ? 0.40 : 0.24) * uLensDrops;
            float alive = smoothstep(thr, thr + 0.07, h);
            if (alive < 0.002) continue;
            vec2 c = (vec2(hash12(gi + 1.7), hash12(gi + 5.3)) - 0.5) * 0.46;
            float r = mix(0.11, 0.24, hash12(gi + 9.1)) * (0.55 + 0.45 * alive);
            vec2 dv = (gf - c) * vec2(1.0, 0.86);
            float dd = length(dv) / r;
            if (dd >= 1.0) continue;
            // no outline, no highlight: water this close to the glass is only a soft bend in the picture
            float m = smoothstep(1.0, 0.0, dd);
            m = m * m * alive * above;
            sampleUv -= vec2(dv.x / uAspect, dv.y) / sc * 1.25 * m;
            dropShade += m * (1.0 - m) * 0.30;
            dropGlint += m * m * 0.12;
          }
        }
        sampleUv = clamp(sampleUv, 0.001, 0.999);

        // The whole world folds into a ring of mirrors: one wedge of the frame (the sky and the flowers above
        // the lens) is repeated around the centre.
        if (uFold > 0.002) {
          vec2 q = (sampleUv - vec2(0.5, 0.5)) * vec2(uAspect, 1.0);
          float rr = length(q);
          float seg = 6.2831853 / uFoldN;
          float a = atan(q.y, q.x) + uFoldSpin;
          a = abs(mod(a, seg) - 0.5 * seg);
          float aim = 1.5708 - 0.25 * seg + 0.18 * sin(uFoldSpin * 0.7);
          float rad = 0.07 + rr * (0.86 - 0.10 * sin(uFoldSpin * 1.3));
          vec2 f = rad * vec2(cos(a + aim), sin(a + aim));
          vec2 fUv = f / vec2(uAspect, 1.0) + vec2(0.5, 0.36);
          fUv = abs(mod(fUv + 1.0, 2.0) - 1.0);
          sampleUv = clamp(mix(sampleUv, fUv, uFold), 0.001, 0.999);
        }

        // Subtle optical lens chromatic micro-dispersion near outer frame corners (35mm cinema prime lens feel)
        vec2 caOffset = centered * (r2 * 0.0022 * uChroma + 0.0009 * (uChroma - 1.0)) + vec2(0.0, inBand * 0.004);
        vec3 hdrCol;
        hdrCol.r = texture2D(tScene, clamp(sampleUv + caOffset, 0.001, 0.999)).r;
        hdrCol.g = texture2D(tScene, sampleUv).g;
        hdrCol.b = texture2D(tScene, clamp(sampleUv - caOffset, 0.001, 0.999)).b;

        // Soft edges: toward the sides of the picture the image slips gently out of focus
        // (the look of an old lens with its outer field left uncorrected; no flare, no heavy vignette).
        if (uEdgeSoft > 0.004) {
          vec2 e = vec2(centered.x, centered.y / max(uBand, 0.2)) * 2.0;
          float edge = smoothstep(0.42, 1.25, dot(e, e)) * uEdgeSoft;
          if (edge > 0.004) {
            vec3 acc = hdrCol;
            float rad = edge * 7.0;
            for (int i = 0; i < 8; i++) {
              float a = 0.7854 * float(i) + 0.4;
              vec2 o = vec2(cos(a), sin(a)) * uTexel * rad * (i < 4 ? 1.0 : 0.5);
              acc += texture2D(tScene, clamp(sampleUv + o, 0.001, 0.999)).rgb;
            }
            hdrCol = mix(hdrCol, acc / 9.0, min(1.0, edge * 1.6));
          }
        }

        // Speed streaks: the edges of the frame smear toward the vanishing point while the camera flies.
        if (uRush > 0.004) {
          vec2 dir = (sampleUv - vec2(0.5, 0.56));
          float edge = smoothstep(0.02, 0.42, dot(dir, dir) * 2.2);
          float jit = fract(sin(dot(vUv * 913.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
          vec3 acc = hdrCol;
          for (int i = 1; i <= 7; i++) {
            float k = (float(i) - 0.5 + jit) / 7.0;
            acc += texture2D(tScene, clamp(sampleUv - dir * k * 0.16 * uRush * edge, 0.001, 0.999)).rgb;
          }
          hdrCol = mix(hdrCol, acc / 8.0, min(1.0, uRush * 1.4) * edge);
        }

        // Add soft atmospheric optical bloom / halation
        vec3 bloomCol = texture2D(tBloom, sampleUv).rgb;
        // wide chain: tight glow plus a faint warm halation skirt, as on film stock
        hdrCol += bloomCol * vec3(0.105, 0.092, 0.084);
        // Halation: on film, strong highlights scatter back through the base and come up as a tight
        // red-orange fringe around lamps and glints. (tBright is the scene's highlights at 1/8 size.)
        hdrCol += texture2D(tBright, sampleUv).rgb * vec3(0.085, 0.026, 0.008);

        // Light shafts: haze between the lens and each lamp scatters its light, and anything standing in the
        // way (petals, sleeves, the cords) cuts dark fingers into it.
        {
          float sj = fract(sin(dot(vUv * 711.0 + uTime * 3.0, vec2(12.9898, 78.233))) * 43758.5453);
          vec3 shaftSum = vec3(0.0);
          for (int i = 0; i < 4; i++) {
            float g = uShaft[i].z;
            if (g < 0.004) continue;
            vec2 toL = uShaft[i].xy - sampleUv;
            float dl = length(toL * vec2(uAspect, 1.0));
            float fall = exp(-dl * 3.1) * smoothstep(0.0, 0.05, dl);
            if (fall < 0.01) continue;
            vec3 acc = vec3(0.0);
            for (int k = 0; k < 8; k++) {
              float f = (float(k) + 0.25 + 0.5 * sj) / 8.0;
              acc += texture2D(tBright, clamp(sampleUv + toL * f * 0.92, 0.002, 0.998)).rgb * (0.55 + 0.45 * f);
            }
            shaftSum += acc * 0.125 * fall * g;
          }
          hdrCol += shaftSum * vec3(0.30, 0.25, 0.20);
        }

        // The travelling lamp (shot ②): its light streams outward through the fog, and whatever stands
        // between it and the lens (the branching columns, the arch feet, a hanging bud) leaves a dark
        // finger in that light. As the lamp moves, the fingers swing across the picture and the water.
        if (uSweep.z > 0.004) {
          vec2 toL = uSweep.xy - sampleUv;
          float dl = length(toL * vec2(uAspect, 1.0));
          float reach = exp(-dl * 3.2);
          // fixed (not animated) dither: hides the steps without adding crawl
          float dj = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec3 acc = vec3(0.0);
          float wsum = 0.0;
          for (int k = 0; k < 30; k++) {
            float f = (float(k) + dj) / 30.0;
            // sample from this pixel toward the lamp, weighted toward the lamp's end
            vec2 uvk = clamp(sampleUv + toL * (0.10 + 0.90 * f), 0.002, 0.998);
            vec3 c = texture2D(tScene, uvk).rgb;
            float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
            // only the lamp's own lit fog is a source: light from anything else on the way is ignored
            vec2 dq = (uvk - uSweep.xy) * vec2(uAspect, 1.0);
            float nearLamp = exp(-dot(dq, dq) / 0.010);
            float w = 0.35 + 0.65 * f;
            acc += min(c, vec3(1.2)) * smoothstep(0.012, 0.070, lum) * nearLamp * w;
            wsum += w;
          }
          acc /= wsum;
          hdrCol += acc * reach * uSweep.z * vec3(1.05, 0.92, 0.78) * 1.0;
        }

        if (uFeedbackStrength > 0.001) {
          vec3 fbCol = texture2D(tFeedback, sampleUv).rgb;
          hdrCol += fbCol * 0.55 * uFeedbackStrength;
        }

        if (under > 0.001) {
          vec3 uw = hdrCol * vec3(0.80, 0.96, 1.02);
          // slow shafts leaning in from the surface
          float lean = (vUv.x - 0.5) * (1.0 + (1.0 - vUv.y) * 0.9);
          float sh = pow(max(0.0, sin(lean * 15.0 + uTime * 0.22) * 0.5 + 0.5), 7.0)
                   * (0.6 + 0.4 * sin(lean * 37.0 - uTime * 0.31));
          uw += vec3(0.030, 0.150, 0.165) * sh * smoothstep(0.05, 0.95, vUv.y) * 0.20;
          // drifting motes of marine snow
          vec2 g = vUv * vec2(26.0, 15.0) + vec2(uTime * 0.035, uTime * 0.06);
          vec2 gi = floor(g);
          vec2 gf = fract(g) - 0.5;
          float hsh = hash12(gi);
          vec2 jit = vec2(hash12(gi + 3.1), hash12(gi + 7.7)) - 0.5;
          float mote = smoothstep(0.045 + 0.03 * hsh, 0.0, length(gf - jit * 0.7)) * step(0.62, hsh);
          uw += vec3(0.20, 0.42, 0.42) * mote * (0.35 + 0.65 * sin(uTime * 0.9 + hsh * 40.0) * 0.5 + 0.5) * 0.10;
          uw += vec3(0.0012, 0.008, 0.011);
          uw *= 1.0 - smoothstep(0.18, 0.80, r2) * 0.38;
          hdrCol = mix(hdrCol, uw, under);
        }
        // The meniscus. Its top edge catches whatever light is above the water just over it (amber on the
        // drummer's stage, cold under the night sky), flaring in short glints where the line tilts; its body
        // glows near the rim and sinks to dim teal at its foot, with fine streaks running along it.
        if (crossing > 0.001) {
          vec2 aUv = vec2(vUv.x, clamp(wl + thick + 0.035, 0.002, 0.998));
          vec3 aboveC = texture2D(tBright, aUv).rgb * 1.6 + texture2D(tScene, aUv).rgb;
          float aL = dot(aboveC, vec3(0.2126, 0.7152, 0.0722));
          vec3 keyTint = mix(vec3(1.0, 0.80, 0.55), clamp(aboveC / max(aL, 1e-3), 0.0, 2.5), 0.45);
          float slope = (wlAt(xa + 0.02) - wlAt(xa - 0.02)) / 0.04;
          float glint = 0.5 + 0.5 * sin(xa * 7.0 + uTime * 2.1 + slope * 9.0 + 1.3 * sin(xa * 2.3 - uTime * 0.7));
          glint = 0.30 + 0.70 * glint * glint * glint;
          float rimE = (0.18 + 2.6 * aL) * glint;
          hdrCol *= 1.0 - 0.55 * bandLip;
          float bodyLight = smoothstep(-1.0, 0.7, dN);
          // (the water under it sets the hue low down; near the rim it takes the colour of the light above)
          vec3 bodyCol = hdrCol * mix(vec3(0.50, 0.80, 0.88), vec3(0.85, 0.82, 0.78), bodyLight) * (0.35 + 1.3 * bodyLight * bodyLight)
                       + keyTint * aL * 0.45 * bodyLight * bodyLight * bodyLight
                       + vec3(0.006, 0.024, 0.028) * bodyLight;
          hdrCol = mix(hdrCol, bodyCol, bandMid);
          float streak = pow(0.5 + 0.5 * sin(dN * 9.0 + xa * 3.0 + 1.2 * sin(xa * 11.0 + uTime * 3.0)), 6.0);
          hdrCol += keyTint * streak * bandMid * (0.02 + aL * 0.25);
          hdrCol += keyTint * crossing * exp(-((dN - 0.86) / 0.10) * ((dN - 0.86) / 0.10)) * rimE;
          // and a hair-thin second glint at the very top, where the film of water meets the glass
          hdrCol += keyTint * crossing * exp(-((dN - 1.03) / 0.05) * ((dN - 1.03) / 0.05)) * rimE * 0.4;
        }
        hdrCol *= 1.0 - min(0.3, dropShade);
        hdrCol *= 1.0 + dropGlint;
        hdrCol = hdrCol * (1.0 + 1.8 * uFlash) + uFlashTint * uFlash * 0.42;

        // Gentle cinema lens vignette (keeps atmospheric mist rich in center while grounding corners)
        // Under water, light is lost quickly: what is not lit directly falls to a deep blue-green, and only
        // the surface glints and the shafts stay bright. (A power curve on the scene light: mid-tones drop,
        // highlights keep their place.)
        if (uUnderGrade > 0.002) {
          vec3 deep = pow(max(hdrCol, vec3(0.0)), vec3(1.58, 1.50, 1.50)) * vec3(1.12, 1.20, 1.16);
          hdrCol = mix(hdrCol, deep, uUnderGrade);
        }
        float vig = 1.0 - smoothstep(0.16, 0.86, r2) * 0.34;
        hdrCol *= uExposure * vig;

        vec3 mapped = agxToneMapping(hdrCol);
        vec3 srgb = linearToSRGB(mapped);

        // Fine 35mm organic film grain (eliminates 8-bit banding in deep volumetric sea mist!)
        // Print look: a gentle S-curve (deeper blacks, a soft shoulder), cool shadows against warm highlights.
        float pl = dot(srgb, vec3(0.2126, 0.7152, 0.0722));
        srgb = mix(srgb, srgb * srgb * (3.0 - 2.0 * srgb), 0.42);
        srgb += vec3(-0.010, 0.002, 0.014) * (1.0 - smoothstep(0.0, 0.40, pl)) * smoothstep(0.0, 0.06, pl)
              + vec3(0.016, 0.005, -0.018) * smoothstep(0.45, 1.0, pl);
        // 35mm grain: two sizes of clump, strongest in the mid-tones, nearly gone in pure black and in the
        // lamps; it also hides banding and the upscale from the internal resolution.
        vec2 gp = gl_FragCoord.xy + fract(uTime * vec2(7.13, 3.71)) * 137.0;
        float grain = (hash12(gp) - 0.5) * 0.62 + (hash12(floor(gp * 0.5) + 31.7) - 0.5) * 0.38;
        float gAmp = (2.0 + 9.0 * sqrt(clamp(pl, 0.0, 1.0)) * (1.0 - 0.55 * pl)) / 255.0;
        srgb = clamp(srgb + grain * gAmp, 0.0, 1.0);

        // 2.39:1 picture: everything outside the band is black
        float bar = smoothstep(0.5 * uBand - 0.0012, 0.5 * uBand + 0.0012, abs(vUv.y - 0.5));
        srgb *= 1.0 - bar * step(uBand, 0.999);

        gl_FragColor = vec4(srgb, 1.0);
      }
    `,
  });

  const postScene = new THREE.Scene();
  const postQuad = new THREE.Mesh(quadGeo, compositeMat);
  postScene.add(postQuad);

  function renderFinal(renderer: THREE.WebGLRenderer, state: PostPipelineState) {
    // 0. Depth of field into the lens buffer
    dofMat.uniforms.uNear.value = state.camNear ?? 0.12;
    dofMat.uniforms.uFar.value = state.camFar ?? 90.0;
    dofMat.uniforms.uFocus.value = state.focusDist ?? 6.0;
    dofMat.uniforms.uAperture.value = state.aperture ?? 0.0;
    dofMat.uniforms.uMaxRadius.value = Math.max(4.0, sceneRT.height * 0.0105);
    postQuad.material = dofMat;
    renderer.setRenderTarget(dofRT);
    renderer.render(postScene, orthoCam);

    // 1. Bloom mip chain
    postQuad.material = bloomDownMat;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? dofRT : bloomDown[i - 1];
      bloomDownMat.uniforms.tInput.value = src.texture;
      bloomDownMat.uniforms.uTexel.value.set(1.0 / src.width, 1.0 / src.height);
      bloomDownMat.uniforms.uPrefilter.value = i === 0 ? 1.0 : 0.0;
      renderer.setRenderTarget(bloomDown[i]);
      renderer.render(postScene, orthoCam);
    }
    postQuad.material = bloomUpMat;
    const BW = [1.0, 0.92, 0.84, 0.78, 0.72, 0.66];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      const low = i === BLOOM_LEVELS - 2 ? bloomDown[i + 1] : bloomUp[i + 1];
      bloomUpMat.uniforms.tLow.value = low.texture;
      bloomUpMat.uniforms.tHigh.value = bloomDown[i].texture;
      bloomUpMat.uniforms.uTexel.value.set(1.0 / low.width, 1.0 / low.height);
      bloomUpMat.uniforms.uWeight.value = BW[i];
      renderer.setRenderTarget(bloomUp[i]);
      renderer.render(postScene, orthoCam);
    }

    // 2. Analog video feedback
    feedbackUpdateMat.uniforms.tScene.value = sceneRT.texture;
    feedbackUpdateMat.uniforms.tPrevFeedback.value = fbRT0.texture;
    feedbackUpdateMat.uniforms.uFeedbackStrength.value = state.feedbackStrength;
    feedbackUpdateMat.uniforms.uTime.value = state.time;
    postQuad.material = feedbackUpdateMat;
    renderer.setRenderTarget(fbRT1);
    renderer.render(postScene, orthoCam);
    const tmp = fbRT0;
    fbRT0 = fbRT1;
    fbRT1 = tmp;

    // 3. Final AgX + Halation + Film Grain composite to screen
    compositeMat.uniforms.tScene.value = dofRT.texture;
    compositeMat.uniforms.tBloom.value = bloomUp[0].texture;
    compositeMat.uniforms.tFeedback.value = fbRT0.texture;
    compositeMat.uniforms.uFeedbackStrength.value = state.feedbackStrength;
    compositeMat.uniforms.uBreathStrength.value = state.breathStrength;
    compositeMat.uniforms.uBreathPhase.value = state.breathPhase;
    compositeMat.uniforms.uExposure.value = state.exposure ?? 0.96;
    compositeMat.uniforms.uTime.value = state.time;
    compositeMat.uniforms.uSubmerge.value = state.submergeLine ?? -1.0;
    compositeMat.uniforms.uLensDrops.value = state.lensDrops ?? 0.0;
    compositeMat.uniforms.uFlash.value = state.flash ?? 0.0;
    const ft = state.flashTint ?? [1, 1, 1];
    compositeMat.uniforms.uFlashTint.value.set(ft[0], ft[1], ft[2]);
    compositeMat.uniforms.uChroma.value = state.chroma ?? 1.0;
    compositeMat.uniforms.uFold.value = state.worldFold ?? 0.0;
    compositeMat.uniforms.uFoldN.value = state.foldN ?? 6.0;
    compositeMat.uniforms.uFoldSpin.value = state.foldSpin ?? 0.0;
    compositeMat.uniforms.uRush.value = state.rush ?? 0.0;
    compositeMat.uniforms.uAspect.value = state.aspect ?? 1.78;
    compositeMat.uniforms.tBright.value = bloomDown[2].texture;
    compositeMat.uniforms.uBand.value = state.band ?? 1.0;
    compositeMat.uniforms.uEdgeSoft.value = state.edgeSoft ?? 0.0;
    compositeMat.uniforms.uUnderGrade.value = state.underGrade ?? 0.0;
    compositeMat.uniforms.uTexel.value.set(1.0 / dofRT.width, 1.0 / dofRT.height);
    {
      const sw = state.sweepShaft;
      compositeMat.uniforms.uSweep.value.set(sw ? sw[0] : 0, sw ? sw[1] : 0, sw ? sw[2] : 0);
    }
    for (let i = 0; i < 4; i++) {
      const sh = state.shafts?.[i];
      compositeMat.uniforms.uShaft.value[i].set(sh ? sh[0] : 0, sh ? sh[1] : 0, sh ? sh[2] : 0);
    }

    postQuad.material = compositeMat;
    renderer.setRenderTarget(null);
    renderer.render(postScene, orthoCam);
  }

  function resize(w: number, h: number, newDpr: number) {
    const nw = Math.max(1, Math.floor(w * newDpr));
    const nh = Math.max(1, Math.floor(h * newDpr));
    const bw = Math.max(1, Math.floor(nw * 0.5));
    const bh = Math.max(1, Math.floor(nh * 0.5));
    sceneRT.setSize(nw, nh);
    dofRT.setSize(nw, nh);
    dofMat.uniforms.uTexel.value.set(1.0 / nw, 1.0 / nh);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bloomDown[i].setSize(Math.max(1, nw >> (i + 1)), Math.max(1, nh >> (i + 1)));
      bloomUp[i].setSize(Math.max(1, nw >> (i + 1)), Math.max(1, nh >> (i + 1)));
    }
    bloomRT0.setSize(bw, bh);
    bloomRT1.setSize(bw, bh);
    fbRT0.setSize(bw, bh);
    fbRT1.setSize(bw, bh);
    bloomBlurHMat.uniforms.uTexel.value.set(1.0 / bw, 1.0 / bh);
    bloomBlurVMat.uniforms.uTexel.value.set(1.0 / bw, 1.0 / bh);
  }

  function setBand(band: number) {
    const on = band < 0.999;
    for (const rt of [sceneRT, dofRT]) {
      rt.scissorTest = on;
      if (on) {
        // a margin beyond the picture, so blur and bloom taps near its edge still find real pixels
        const hh = Math.min(rt.height, Math.ceil(rt.height * (band + 0.06)));
        rt.scissor.set(0, Math.floor((rt.height - hh) / 2), rt.width, hh);
      } else {
        rt.scissor.set(0, 0, rt.width, rt.height);
      }
    }
  }

  function resetFeedback(renderer: THREE.WebGLRenderer) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(fbRT0);
    renderer.clearColor();
    renderer.setRenderTarget(fbRT1);
    renderer.clearColor();
    renderer.setRenderTarget(prev);
  }

  return {
    sceneRT,
    renderFinal,
    resize,
    setBand,
    resetFeedback,
  };
}
