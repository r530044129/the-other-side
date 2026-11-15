import * as THREE from 'three';
import { LAMP_BEAM_GLSL } from './lampBeam';
import { DK_FOG_GLSL } from './shot2';

export interface GalleryUpdateState {
  time: number;
  shadowVoid: number;
  shot1Dark?: number;
  ambientKeep?: number;
  /** Active warm 2700K Shylight core positions & intensities (up to 4) */
  shylightLights: { pos: THREE.Vector3; glow: number }[];
  /** Shot 4 (1:25.7 ~ 2:23.8): Golden water-caustic mist curtains rising into the upper sky-theater (0..1) */
  wallCausticIntensity: number;
  /** Shots 5–6 (2:23.8 ~ 4:03.3): Wide abyssal swimming-pool bottom caustics + hanging refracted light curtains (0..1) */
  poolFloorCausticIntensity: number;
  /** Live PDE wave height texture for floor & mist caustics */
  causticWaveTex: THREE.Texture | null;
  /** Shot 6: Giant centered drummer shadow projected in the upper-center volumetric mist screen! */
  drummerShadowIntensity: number;
  drummerShadowTex: THREE.Texture | null;
  drummerShadowMatrix: THREE.Matrix4 | null;
  /** Shot 5 liftoff progress (0..1) for peeling liquid-pearl droplet strings */
  carpetLevitation?: number;
  /** Shot 6 seconds since Spacebar strike + 3D world impact coordinates for 3D splash burst & floor caustic shockwave */
  timeSinceDrummerStrike?: number;
  strikeWorldPos?: [number, number, number];
  /** Shot 4 second half (2:05 ~ 2:23.8): Anti-gravity rising liquid water pearls (0..1) */
  antiGravityDropletsIntensity: number;
  /** Global overhead Tyndall volumetric sky-light curtain intensity */
  volumetricShaftIntensity: number;
  /** Finale global blackout fade */
  endingBlackout: number;
  /** Shot ② Deakins look (0..1): warm near-black fog, no teal mist, no light curtains. */
  dk?: number;
  dkAxis?: [number, number, number];
  dkTop?: number;
  /** Shot ⑤: how much the water splits light into colours. */
  rainbow?: number;
  /** Story layer */
  underAmt?: number;
  underSpan?: number;
  causticFractal?: number;
  drummerEcho?: number;
  drummerReveal?: number;
  triShadow?: number;
  triSpread?: number;
  echoTextures?: [THREE.Texture, THREE.Texture];
}

export interface GalleryRigHandles {
  root: THREE.Group;
  poolBounds: {
    halfW: number;
    zBack: number;
    zFront: number;
    waterY: number;
    basinFloorY: number;
  };
  update: (state: GalleryUpdateState) => void;
}

/**
 * v2 3A "Deep-Sea / Misty Sky-Light Theater" (`深海/迷雾天光剧场`):
 * - ZERO pool rims, ZERO walkways, ZERO cramped concrete walls, ZERO dead #000000 black regions!
 * - Boundless ocean-scale water coordinates (`36m wide x 38m deep`) seamlessly melting into a 360°
 *   volumetric mist theater dome filled with layered deep-slate/teal/warm-amber atmospheric fog,
 *   slanting multi-curtain Tyndall God-rays, floating backlit atmospheric dust motes, water-bounced
 *   volumetric caustics, and (in Shots 5–6) hanging refracted volumetric light curtains + wide abyssal
 *   swimming-pool caustics + a giant centered glowing mist backdrop for the drummer's shadow!
 */
export function createGalleryScene(): GalleryRigHandles {
  const root = new THREE.Group();

  // Boundless water domain so left, right, and far edges NEVER expose a pool border!
  const poolBounds = {
    halfW: 18.0,
    zBack: -26.0,
    zFront: 12.0,
    waterY: 0.0,
    basinFloorY: -1.05,
  };

  const dummyBlackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  dummyBlackTex.needsUpdate = true;

  const lightArray = Array.from({ length: 4 }, () => new THREE.Vector4(0, 3, -1, 0));

  // ============================================================================
  // 1. 360° VOLUMETRIC MIST SKY-LIGHT THEATER DOME (Replaces empty black background!)
  // ============================================================================
  const skyUniforms = {
    uTime: { value: 0.0 },
    uGodRayBoost: { value: 0.5 },
    uMistCaustics: { value: 0.0 },
    uLights: { value: lightArray },
    uDrummerShadow: { value: 0.0 },
    uDrummerTex: { value: dummyBlackTex as THREE.Texture },
    uDrummerMat: { value: new THREE.Matrix4() },
    uUnder: { value: 0.0 },
    uBlackout: { value: 0.0 },
    uShot1Dark: { value: 0.0 },
    uAmbientKeep: { value: 1.0 },
    uDk: { value: 0.0 },
    uDkAxis: { value: new THREE.Vector3(0, 0, -1) },
    uDkTop: { value: 1.0 },
  };

  const skyGeo = new THREE.SphereGeometry(52.0, 64, 40);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vDir = normalize(wp.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vDir;

      uniform float uTime;
      uniform float uGodRayBoost;
      uniform float uMistCaustics;
      uniform vec4 uLights[4];
      uniform float uDrummerShadow;
      uniform sampler2D uDrummerTex;
      uniform mat4 uDrummerMat;
      uniform float uUnder;
      uniform float uBlackout;
      uniform float uShot1Dark;
      uniform float uAmbientKeep;
      uniform float uDk;
      ${LAMP_BEAM_GLSL}
      ${DK_FOG_GLSL}

      float hash21(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
          mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      float fbmMist(vec2 p) {
        float s = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
          s += a * vnoise(p);
          p = p * 2.04 + vec2(3.7, 8.1);
          a *= 0.5;
        }
        return s;
      }

      // Roger Deakins Blade Runner 2049 Wallace HQ dual-advected refractive caustic cusp network!
      float mistCausticPattern(vec2 p, float t) {
        vec2 z1 = p * 1.45 + vec2(t * 0.34, -t * 0.28);
        vec2 z2 = p * 2.15 + vec2(-t * 0.29, t * 0.38) + vec2(2.7, -1.9);
        for (int i = 0; i < 4; i++) {
          z1 += 0.44 * vec2(sin(z1.y * 1.85 + t * 0.92), cos(z1.x * 1.75 - t * 0.78));
          z2 += 0.38 * vec2(cos(z2.y * 2.10 - t * 1.05), sin(z2.x * 2.00 + t * 0.85));
        }
        float cusp1 = pow(clamp(1.0 - abs(sin(z1.x) + cos(z1.y)) * 0.54, 0.0, 1.0), 5.4);
        float cusp2 = pow(clamp(1.0 - abs(cos(z2.x) - sin(z2.y)) * 0.54, 0.0, 1.0), 6.0);
        return cusp1 * 1.35 + cusp2 * 0.95;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float elev = dir.y; // 0 = water horizon, +0.5 = high sky, <0 = deep below horizon
        float azim = atan(dir.x, -dir.z); // 0 = straight ahead (-Z)

        // 1. Rich Deakins Deep-Sea Atmospheric Mist Base (NO dead #000000 anywhere!)
        // Horizon glows softly with nocturnal slate-teal & warm amber mist, deepening gently upward into midnight indigo-slate
        float horizonGlow = exp(-pow(abs(max(-0.15, elev - 0.02) / 0.24), 2.0));
        float upperCanopy = smoothstep(-0.05, 0.58, elev);

        vec2 cloudUv = vec2(azim * 2.1, elev * 3.4);
        float mistBillowA = fbmMist(cloudUv + vec2(uTime * 0.018, -uTime * 0.012));
        float mistBillowB = fbmMist(cloudUv * 1.85 + vec2(-uTime * 0.024, uTime * 0.015) + 11.3);
        float mistDensity = 0.55 + 0.45 * (mistBillowA * 0.65 + mistBillowB * 0.35);

        // Deeper zenith negative space (Deakins: big dark masses), mist only thickens toward the horizon band.
        vec3 deepZenithSlate = vec3(0.0030, 0.0048, 0.0078);
        vec3 midTealMist     = vec3(0.0180, 0.0285, 0.0395);
        vec3 warmHorizonMist = vec3(0.0340, 0.0265, 0.0195);
        float canopyDark = smoothstep(-0.02, 0.42, elev);
        float mistContrast = mix(0.55 + 0.45 * (mistBillowA * 0.65 + mistBillowB * 0.35),
                                 0.25 + 0.95 * smoothstep(0.25, 0.85, mistBillowA * 0.7 + mistBillowB * 0.3),
                                 canopyDark);

        vec3 col = mix(midTealMist, deepZenithSlate, canopyDark) * mistContrast;
        col += warmHorizonMist * horizonGlow * (0.65 + 0.35 * mistBillowA) * exp(-azim * azim * 1.35);
        col += vec3(0.014, 0.022, 0.032) * horizonGlow * 0.75;

        // 2. Slanting Overhead Tyndall Volumetric Sky-Light Curtains (organic FBM cloud-gap breakup — never parallel 2D stripes!)
        if (elev > -0.08) {
          float slantCoord = azim * 3.0 - elev * 1.38;
          // Cloud-gap modulation breaks up the shafts into organic cinema light curtains piercing rolling sea fog!
          float cloudGapA = smoothstep(0.40, 0.80, fbmMist(vec2(slantCoord * 1.45 + uTime * 0.015, elev * 1.8 - uTime * 0.02)));
          float cloudGapB = 0.55 + 0.45 * fbmMist(vec2(slantCoord * 3.4 - uTime * 0.025, elev * 2.6));

          float shaft1 = exp(-pow(abs((slantCoord + 0.62) / 0.48), 2.0));
          float shaft2 = exp(-pow(abs((slantCoord - 0.12) / 0.58), 2.0));
          float shaft3 = exp(-pow(abs((slantCoord - 0.95) / 0.44), 2.0));

          float vertEnvelope = smoothstep(-0.06, 0.16, elev) * (1.0 - smoothstep(0.52, 0.92, elev));
          float organicMask = cloudGapA * cloudGapB * vertEnvelope * (0.78 + 0.55 * uGodRayBoost);

          vec3 coolRayCol = vec3(0.040, 0.066, 0.088) * (shaft1 + shaft3);
          vec3 warmRayCol = vec3(0.150, 0.098, 0.044) * shaft2 * 1.35;
          col += (coolRayCol + warmRayCol) * organicMask;
        }

        // Generic haze is scaled per shot; the motivated lights below are added at full strength.
        col *= uAmbientKeep;
        vec3 dkHalo = vec3(0.0);

        // 3. Atmospheric Mie Scattering Halos in the Mist around Active Floating Shylights!
        for (int i = 0; i < 4; i++) {
          float g = uLights[i].w;
          if (g <= 0.005) continue;
          vec3 toLampDir = normalize(uLights[i].xyz - cameraPosition);
          float cosAng = max(0.0, dot(dir, toLampDir));
          float mieHalo = pow(cosAng, 9.0) * 0.45 + pow(cosAng, 36.0) * 0.85;
          vec3 haloAdd = vec3(0.085, 0.052, 0.022) * g * mieHalo * mistDensity;
          col += haloAdd;
          dkHalo += haloAdd;
        }

        // 4. Shot 4 (1:25.7+): Roger Deakins Blade Runner 2049 Wallace HQ Golden Caustic Light-Nets!
        // Sweeps high-contrast, razor-sharp 2900K golden-amber refractive caustic cusp filaments diagonally across
        // the upper volumetric mist curtains over deep teal-obsidian shadow cells!
        if (uMistCaustics > 0.002 && elev > -0.06) {
          vec2 cUv = vec2(azim * 3.8 - elev * 1.35, elev * 5.2 + azim * 0.55);
          float cuspFilaments = mistCausticPattern(cUv, uTime);
          // Only 2-3 slow diagonal light sweeps pass through the caustic net; between them the sky stays dark.
          float sweepCoord = azim * 1.55 - elev * 2.4 + uTime * 0.035;
          float sweeps = pow(max(0.0, sin(sweepCoord * 2.6)), 7.0) * (0.55 + 0.45 * sin(sweepCoord * 0.9 + 1.3));
          float curtainBands = max(0.0, sweeps);
          float cMask = smoothstep(-0.03, 0.10, elev) * (1.0 - smoothstep(0.30, 0.62, elev)) * exp(-azim * azim * 0.9);

          vec3 warmAmberWash = vec3(0.020, 0.012, 0.004) * mistDensity * curtainBands;
          vec3 sharpWallaceGold = vec3(0.62, 0.38, 0.11) * cuspFilaments * curtainBands * (0.72 + 0.45 * mistBillowA);
          col += (warmAmberWash + sharpWallaceGold) * cMask * uMistCaustics;
        }

        // 5. Shot 6 (3:17.8 ~ 4:03.3): Grand Stage-Wide Deakins 2700K Volumetric Backlight Fan!
        // Replaces any isolated small oval with a sweeping atmospheric amber-gold theatrical haze fan across the upper stage!
        if (uDrummerShadow > 0.002 && elev > -0.10) {
          float fanHoriz = exp(-azim * azim * 1.10);
          float fanVert = exp(-pow(abs((elev - 0.15) / 0.20), 2.0));
          vec2 rayOrigin = vec2(0.02, 0.10);
          vec2 deltaAng = vec2(azim, elev) - rayOrigin;
          float radialAngle = atan(deltaAng.y, deltaAng.x);
          float crepRays = 0.68 + 0.32 * pow(max(0.0, 0.5 + 0.5 * sin(radialAngle * 9.0 + fbmMist(vec2(radialAngle * 2.2, uTime * 0.04)) * 3.2)), 2.0);
          vec3 stageFanCol = vec3(0.105, 0.060, 0.021) * fanHoriz * fanVert * crepRays * (0.72 + 0.42 * mistDensity);
          col += stageFanCol * uDrummerShadow;
        }

        // Horizon seam lock: the far water plane fades to exactly this color (waterPool horizonSeaMist),
        // so the sky must converge to it in the band where the water plane ends (elev ~ -0.07).
        vec3 seaSeamCol = vec3(0.0180, 0.0285, 0.0395) * 0.80 +
                          vec3(0.0340, 0.0265, 0.0195) * exp(-azim * azim * 1.35) * 0.80 +
                          vec3(0.014, 0.022, 0.032) * 0.75;
        seaSeamCol *= uAmbientKeep;
        col = mix(seaSeamCol, col, smoothstep(-0.06, 0.09, elev));

        // Shot ②: one warm, nearly black body of air. The flowers light it (halos); the only other light
        // is the weak top light at the far end of the nave. No teal, no curtains.
        if (uDk > 0.002) {
          col = mix(col, dkFog(dir) + dkHalo * 1.25, uDk);
        }

        // Shot 1: the whole space sinks into shadow; the only light is the overhead lamp shaft
        // falling through the haze onto the title. (waterPool darkens its horizon mist by the same factor.)
        if (uShot1Dark > 0.002) {
          col *= mix(1.0, 0.10, uShot1Dark);
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          col += lbScatter(cameraPosition, dir, 60.0, ign) * uShot1Dark;
        }

        // Seen from the other side: no sky, only deep water that brightens slightly toward the surface.
        if (uUnder > 0.002) {
          vec3 murk = vec3(0.0035, 0.026, 0.034) * (0.75 + 1.6 * smoothstep(-0.2, 0.9, elev));
          col = mix(col, murk, uUnder);
        }

        gl_FragColor = vec4(col * (1.0 - uBlackout), 1.0);
      }
    `,
  });
  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.renderOrder = -20;
  root.add(skyDome);

  // ============================================================================
  // 2. VOLUMETRIC MIST VEIL PLANES + SHOT 6 CENTERED DRUMMER SHADOW MIST SCREEN!
  // ============================================================================
  // True 3D layered translucent volumetric light curtains in world space (z = -7.5m, -4.2m, -1.8m)
  // giving genuine 3D parallax when the slow fluid-head camera glides, AND serving in Shot 6 as the
  // luminous upper-center volumetric mist screen (z = -3.85m) onto which the GIANT CENTERED DRUMMER
  // SHADOW is projected directly above the full-width floating water silk carpet!
  const mistScreenUniforms = {
    uTime: { value: 0.0 },
    uGodRayBoost: { value: 0.5 },
    uMistCaustics: { value: 0.0 },
    uDrummerShadow: { value: 0.0 },
    uDrummerTex: { value: dummyBlackTex as THREE.Texture },
    uDrummerMat: { value: new THREE.Matrix4() },
    uUnder: { value: 0.0 },
    uEcho: { value: 0.0 },
    uReveal: { value: 0.0 },
    uTri: { value: 0.0 },
    uTriSpread: { value: 0.07 },
    uEchoTex1: { value: dummyBlackTex as THREE.Texture },
    uEchoTex2: { value: dummyBlackTex as THREE.Texture },
    uBlackout: { value: 0.0 },
    uShot1Dark: { value: 0.0 },
    uAmbientKeep: { value: 1.0 },
    uDk: { value: 0.0 },
  };

  const mistScreenGeo = new THREE.PlaneGeometry(24.0, 11.0, 1, 1);
  const mistScreenMat = new THREE.ShaderMaterial({
    uniforms: mistScreenUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec2 vUv;

      uniform float uTime;
      uniform float uGodRayBoost;
      uniform float uMistCaustics;
      uniform float uDrummerShadow;
      uniform sampler2D uDrummerTex;
      uniform mat4 uDrummerMat;
      uniform float uUnder;
      uniform float uEcho;
      uniform float uReveal;
      uniform float uTri;
      uniform float uTriSpread;
      uniform sampler2D uEchoTex1;
      uniform sampler2D uEchoTex2;
      uniform float uBlackout;
      uniform float uShot1Dark;
      uniform float uAmbientKeep;
      uniform float uDk;

      float hash21(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
          mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      float fbm(vec2 p) {
        float s = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          s += a * vnoise(p);
          p = p * 2.02 + vec2(5.1, 2.9);
          a *= 0.5;
        }
        return s;
      }

      void main() {
        vec2 cUv = (vUv - 0.5) * 2.0;
        float edgeFade = (1.0 - smoothstep(0.45, 0.98, abs(cUv.x))) *
                         smoothstep(-0.96, -0.45, cUv.y) *
                         (1.0 - smoothstep(0.55, 0.98, cUv.y));

        float fogTex = 0.62 + 0.38 * fbm(vWorldPos.xy * 0.42 + vec2(uTime * 0.05, -uTime * 0.03));

        // Ambient slanting volumetric light veil in 3D space
        float slant = sin(vWorldPos.x * 0.55 - vWorldPos.y * 0.38 + 0.6) * 0.5 + 0.5;
        vec3 baseMistCol = mix(vec3(0.015, 0.026, 0.036), vec3(0.048, 0.034, 0.018), slant) * fogTex;
        float baseAlpha = edgeFade * 0.15 * (0.6 + 0.4 * uGodRayBoost) * (0.55 + 0.45 * fogTex) * uAmbientKeep;

        vec3 outRgb = baseMistCol;
        float outAlpha = baseAlpha;

        // Shot 4 Wallace HQ 3D Midground Volumetric Caustic Curtain Veil (z = -3.45m right behind blossoms A & C!)
        if (uMistCaustics > 0.002) {
          vec2 wq = vec2(vWorldPos.x * 0.58 - vWorldPos.y * 0.24 + uTime * 0.30, vWorldPos.y * 0.72 - uTime * 0.25);
          for (int i = 0; i < 3; i++) {
            wq += 0.42 * vec2(sin(wq.y * 1.9 + uTime * 0.85), cos(wq.x * 1.8 - uTime * 0.75));
          }
          float cusp = pow(clamp(1.0 - abs(sin(wq.x) + cos(wq.y)) * 0.54, 0.0, 1.0), 5.6);
          // Narrow diagonal sweeps only (matches sky sweeps); dark between them.
          float sweepW = vWorldPos.x * 0.21 - vWorldPos.y * 0.33 + uTime * 0.035;
          float shaftMask = pow(max(0.0, sin(sweepW * 2.6)), 6.0) * edgeFade;
          vec3 wallaceVeil = vec3(0.50, 0.30, 0.082) * cusp * fogTex * shaftMask * uMistCaustics;
          outRgb += wallaceVeil;
          outAlpha = clamp(outAlpha + cusp * 0.26 * shaftMask * uMistCaustics, 0.0, 0.88);
        }

        // Shot 6 (3:17.8 ~ 4:03.3): GIANT CENTERED DRUMMER SHADOW WITH MULTI-SCALE PENUMBRA & CREPUSCULAR RAYS!
        if (uDrummerShadow > 0.002) {
          // Broad stage-wide Deakins 2700K amber volumetric mist fan (no isolated small orange oval!)
          vec2 stageDist = vec2(vWorldPos.x / 8.8, (vWorldPos.y - 2.68) / 3.45);
          float stageGlow = exp(-dot(stageDist, stageDist) * 0.92) * (0.68 + 0.42 * fogTex);
          float spotCore = exp(-dot(vec2(vWorldPos.x / 4.2, (vWorldPos.y - 2.55) / 2.2), vec2(vWorldPos.x / 4.2, (vWorldPos.y - 2.55) / 2.2)) * 1.15);

          float coreOcc = 0.0;
          float softPenumbra = 0.0;
          float revealOcc = 0.0;
          float crepuscularShaft = 0.0;
          vec3 triOcc = vec3(0.0);

          vec4 projClip = uDrummerMat * vec4(vWorldPos.x / 1.6, 0.25 + (vWorldPos.y - 0.25) / 1.6, vWorldPos.z, 1.0);
          if (projClip.w > 0.05) {
            vec2 sUv = projClip.xy / projClip.w;
            // Smoothly fade the drummer's lower legs/throne into the rising stage mist right above the hovering water (y ~ 1.55m -> 2.15m)!
            float lowerMistFade = smoothstep(1.52, 2.18, vWorldPos.y);
            if (sUv.x > 0.01 && sUv.x < 0.99 && sUv.y > 0.01 && sUv.y < 0.99) {
              // 1. Multi-scale optical penumbra (wider misty softness toward outer extremities, zero 1px vector cutout!)
              float extDist = length(sUv - vec2(0.50, 0.46));
              float rInner = 0.0040 + extDist * 0.0032;
              float rOuter = 0.0120 + extDist * 0.0090;

              float c0 = texture2D(uDrummerTex, sUv).a;
              float ring1 = (
                texture2D(uDrummerTex, sUv + vec2(rInner, 0.0)).a +
                texture2D(uDrummerTex, sUv - vec2(rInner, 0.0)).a +
                texture2D(uDrummerTex, sUv + vec2(0.0, rInner)).a +
                texture2D(uDrummerTex, sUv - vec2(0.0, rInner)).a +
                texture2D(uDrummerTex, sUv + vec2(rInner * 0.7, rInner * 0.7)).a +
                texture2D(uDrummerTex, sUv + vec2(-rInner * 0.7, rInner * 0.7)).a +
                texture2D(uDrummerTex, sUv + vec2(rInner * 0.7, -rInner * 0.7)).a +
                texture2D(uDrummerTex, sUv + vec2(-rInner * 0.7, -rInner * 0.7)).a
              ) * 0.125;

              float ring2 = (
                texture2D(uDrummerTex, sUv + vec2(rOuter, 0.0)).a +
                texture2D(uDrummerTex, sUv - vec2(rOuter, 0.0)).a +
                texture2D(uDrummerTex, sUv + vec2(0.0, rOuter)).a +
                texture2D(uDrummerTex, sUv - vec2(0.0, rOuter)).a +
                texture2D(uDrummerTex, sUv + vec2(rOuter * 0.7, rOuter * 0.7)).a +
                texture2D(uDrummerTex, sUv + vec2(-rOuter * 0.7, rOuter * 0.7)).a +
                texture2D(uDrummerTex, sUv + vec2(rOuter * 0.7, -rOuter * 0.7)).a +
                texture2D(uDrummerTex, sUv + vec2(-rOuter * 0.7, -rOuter * 0.7)).a
              ) * 0.125;

              coreOcc = (c0 * 0.42 + ring1 * 0.40 + ring2 * 0.18) * lowerMistFade;
              softPenumbra = (ring1 * 0.45 + ring2 * 0.55) * lowerMistFade;
              revealOcc = (c0 * 0.6 + ring1 * 0.4) * lowerMistFade;

              // Three coloured lamps stand apart behind him, so he throws three shadows, each missing one colour.
              if (uTri > 0.01) {
                vec2 dA = vec2(uTriSpread, 0.006);
                vec2 dB = vec2(-uTriSpread * 1.15, -0.004);
                float bl = 0.014;
                float oA = (texture2D(uDrummerTex, sUv + dA).a * 2.0 + texture2D(uDrummerTex, sUv + dA + vec2(bl, 0.0)).a + texture2D(uDrummerTex, sUv + dA - vec2(bl, 0.0)).a) * 0.25;
                float oB = (texture2D(uDrummerTex, sUv + dB).a * 2.0 + texture2D(uDrummerTex, sUv + dB + vec2(bl, 0.0)).a + texture2D(uDrummerTex, sUv + dB - vec2(bl, 0.0)).a) * 0.25;
                triOcc = vec3(oA, c0 * 0.5 + ring1 * 0.5, oB) * lowerMistFade;
                softPenumbra = max(softPenumbra, max(oA, oB) * lowerMistFade);
              }

              // Tape-delay echoes: on-beat streaks split the shadow into late copies of itself.
              if (uEcho > 0.01) {
                vec2 o1 = sUv + vec2(0.085, 0.004);
                vec2 o2 = sUv - vec2(0.105, -0.006);
                float e1 = (texture2D(uEchoTex1, o1).a * 2.0 + texture2D(uEchoTex1, o1 + vec2(0.006, 0.0)).a + texture2D(uEchoTex1, o1 - vec2(0.006, 0.0)).a) * 0.25;
                float e2 = (texture2D(uEchoTex2, o2).a * 2.0 + texture2D(uEchoTex2, o2 + vec2(0.008, 0.0)).a + texture2D(uEchoTex2, o2 - vec2(0.008, 0.0)).a) * 0.25;
                float eOcc = max(e1 * 0.66, e2 * 0.46) * uEcho * lowerMistFade;
                coreOcc = max(coreOcc, eOcc);
                softPenumbra = max(softPenumbra, eOcc * 0.85);
              }

              // 2. Radial Crepuscular Shadow Rays streaming outward from the 2700K backlight center (0.50, 0.44)!
              vec2 toSpot = vec2(0.50, 0.44) - sUv;
              float occRay = 0.0;
              for (int k = 1; k <= 5; k++) {
                float fk = float(k) * 0.026;
                occRay += texture2D(uDrummerTex, clamp(sUv + toSpot * fk, 0.01, 0.99)).a;
              }
              crepuscularShaft = 1.0 - (occRay / 5.0) * 0.52 * lowerMistFade;
            } else {
              crepuscularShaft = 1.0;
            }
          }

          // Warm 2700K golden rim-scatter wrap glowing around the drummer's curls, shoulders, arms & sticks!
          // Rim glow removed: a real silhouette in backlit haze has a soft penumbra, not a luminous outline.
          float goldenRimWrap = 0.0;

          vec3 litAmberMist =
            vec3(0.30, 0.180, 0.066) * (stageGlow * 0.42 + spotCore * 0.80) * crepuscularShaft * (1.0 - coreOcc * 0.90) +
            vec3(0.82, 0.52, 0.18) * goldenRimWrap * 0.75;

          // Velvety smoked-indigo shadow umbra (never harsh 2D #000000 ink!)
          vec3 velvetUmbra = vec3(0.010, 0.012, 0.018) + vec3(0.024, 0.016, 0.008) * fogTex;

          float drumMistAlpha = clamp(stageGlow * 0.62 + softPenumbra * 0.65, 0.0, 0.90) * uDrummerShadow;
          vec3 oneLamp = mix(litAmberMist, velvetUmbra, smoothstep(0.04, 0.88, coreOcc) * 0.88);
          if (uTri > 0.01) {
            // red, teal and gold lamps; a shadow of one lamp is still lit by the other two
            float stageL = (stageGlow * 0.46 + spotCore * 0.86) * crepuscularShaft;
            vec3 triLit =
              vec3(0.40, 0.045, 0.085) * (1.0 - triOcc.x * 0.96) +
              vec3(0.035, 0.24, 0.27) * (1.0 - triOcc.y * 0.96) +
              vec3(0.25, 0.155, 0.03) * (1.0 - triOcc.z * 0.96);
            float allOcc = triOcc.x * triOcc.y * triOcc.z;
            vec3 threeLamps = mix(triLit * stageL * 0.62, velvetUmbra, smoothstep(0.1, 0.9, allOcc) * 0.8);
            oneLamp = mix(oneLamp, threeLamps, uTri);
          }
          outRgb = mix(outRgb, oneLamp, drumMistAlpha);
          outAlpha = max(outAlpha, drumMistAlpha * edgeFade);

          // For an instant the shadow is not a shadow: the lit body shows through, then it is gone again.
          if (uReveal > 0.004) {
            float bodyShade = 0.55 + 0.45 * smoothstep(1.8, 4.6, vWorldPos.y) + 0.35 * fogTex;
            vec3 lit = vec3(1.35, 0.86, 0.36) * bodyShade + vec3(0.10, 0.55, 0.60) * (1.0 - smoothstep(0.2, 0.9, revealOcc)) * 0.8;
            outRgb = mix(outRgb, lit, revealOcc * uReveal);
            outAlpha = max(outAlpha, revealOcc * uReveal * 0.95);
          }
        }

        // Shot 1: the veil goes almost unseen; the lamp shaft in the sky dome is the only lit air.
        float s1Keep = (1.0 - 0.88 * uShot1Dark) * (1.0 - uUnder) * (1.0 - uDk);
        gl_FragColor = vec4(outRgb * (1.0 - uBlackout) * s1Keep, outAlpha * (1.0 - uBlackout) * s1Keep);
      }
    `,
  });
  const mistScreenMesh = new THREE.Mesh(mistScreenGeo, mistScreenMat);
  mistScreenMesh.position.set(0.0, 2.85, -3.45);
  mistScreenMesh.renderOrder = -5;
  root.add(mistScreenMesh);

  // ============================================================================
  // 3. ABYSSAL SWIMMING-POOL CAUSTIC FLOOR + HANGING REFRACTED LIGHT CURTAINS (Shots 5–6!)
  // ============================================================================
  const basinFloorUniforms = {
    uTime: { value: 0.0 },
    uFloorCaustics: { value: 0.0 },
    tWave: { value: dummyBlackTex as THREE.Texture },
    uDrummerShadow: { value: 0.0 },
    uDrummerTex: { value: dummyBlackTex as THREE.Texture },
    uDrummerMat: { value: new THREE.Matrix4() },
    uFractal: { value: 0.0 },
    uUnderSpan: { value: 0.0 },
    uStrikeAge: { value: 999.0 },
    uStrikeXZ: { value: new THREE.Vector2(-0.8, -2.1) },
    uBlackout: { value: 0.0 },
    uRainbow: { value: 0.0 },
  };

  const basinFloorGeo = new THREE.PlaneGeometry(34.0, 32.0, 1, 1);
  basinFloorGeo.rotateX(-Math.PI * 0.5);
  const basinFloorMat = new THREE.ShaderMaterial({
    uniforms: basinFloorUniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      uniform float uTime;
      uniform float uFloorCaustics;
      uniform sampler2D tWave;
      uniform float uDrummerShadow;
      uniform sampler2D uDrummerTex;
      uniform mat4 uDrummerMat;
      uniform float uFractal;
      uniform float uUnderSpan;
      uniform float uStrikeAge;
      uniform vec2 uStrikeXZ;
      uniform float uBlackout;
      uniform float uRainbow;

      // Pool-floor caustic web: iterated warp of the light field (no lattice, so no jigsaw tiling).
        float poolWeb(vec2 q, float tt) {
          vec2 i = q;
          float c = 1.0;
          const float inten = 0.0065;
          for (int n = 0; n < 5; n++) {
            float tn = tt * (1.0 - (3.5 / float(n + 1)));
            i = q + vec2(cos(tn - i.x) + sin(tn + i.y), sin(tn - i.y) + cos(tn + i.x));
            c += 1.0 / length(vec2(q.x / (sin(i.x + tn) / inten), q.y / (cos(i.y + tn) / inten)));
          }
          c /= 5.0;
          c = 1.17 - pow(max(c, 0.0), 1.4);
          return min(pow(abs(c), 7.0), 2.0);
        }

      vec3 computeWideSwimmingPoolCaustics(vec2 worldXZ, vec2 carpetUv, float t) {
        float eps = 1.0 / 512.0;
        float hL = texture2D(tWave, carpetUv - vec2(eps, 0.0)).r;
        float hR = texture2D(tWave, carpetUv + vec2(eps, 0.0)).r;
        float hD = texture2D(tWave, carpetUv - vec2(0.0, eps)).r;
        float hU = texture2D(tWave, carpetUv + vec2(0.0, eps)).r;
        float hC = texture2D(tWave, carpetUv).r;
        vec2 liveGrad = vec2(hR - hL, hU - hD) * 3.2;
        float liveShock = abs((hL + hR + hD + hU) - 4.0 * hC) * 28.0;

        vec2 p = vec2(worldXZ.x * 1.05, worldXZ.y * 1.25) + liveGrad * 0.55;
        // (light nets under real water flicker quickly; this used to drift)
        float tt = t * 0.66;
        // Self-organisation: for a while the caustic net folds itself into a mirrored fractal lattice.
        if (uFractal > 0.002) {
          vec2 f = vec2(worldXZ.x, worldXZ.y + 0.4) * 0.62;
          float sc = 1.0;
          for (int k = 0; k < 4; k++) {
            f = abs(f) - vec2(0.92, 0.62);
            float ang = 0.62 + 0.05 * sin(t * 0.21);
            f = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * f;
            f *= 1.34;
            sc *= 1.34;
          }
          vec2 pf = f / sc * 6.5 + liveGrad * 0.4;
          p = mix(p, pf, uFractal);
        }
        // Two slightly offset layers = the faint chromatic split of real refracted sunlight.
        float cuspA = poolWeb(p - vec2(250.0, 250.0), tt);
        float cuspB = poolWeb(p * 1.012 - vec2(249.97, 249.98), tt + 0.03);
        float swellBand = 0.70 + 0.30 * sin(worldXZ.x * 0.55 + 1.6 * t);

        cuspA = smoothstep(0.22, 1.9, cuspA);
        cuspB = smoothstep(0.22, 1.9, cuspB);
        // the ripple of a strike focuses light on the floor; kept soft so it is a swell, not a stack of bright rings
        float focus = (cuspA * 1.6 + cuspB * 0.7) * swellBand + min(liveShock, 1.1) * 0.42;

        float prism = clamp(cuspA - cuspB, -1.0, 1.0);
        vec3 warmGold = vec3(1.00, 0.72, 0.28);
        vec3 coolAqua = vec3(0.20, 0.86, 0.98);
        vec3 warmAmber = vec3(1.00, 0.50, 0.20);
        // 'in rainbows': the edges of every filament split further and take stronger colours
        vec3 edgeCol = prism > 0.0 ? mix(coolAqua, vec3(0.30, 0.45, 1.00), uRainbow * 0.6) : mix(warmAmber, vec3(1.00, 0.22, 0.42), uRainbow * 0.7);
        vec3 tint = mix(warmGold, edgeCol, clamp(abs(prism) * (0.42 + 1.1 * uRainbow), 0.0, 1.0));

        return tint * focus;
      }

      void main() {
        // Rich dark #020710 abyssal floor so floating height & sharp golden-aqua caustics read with huge contrast!
        vec3 abyssBase = vec3(0.0020, 0.0048, 0.0095);
        if (uFloorCaustics <= 0.002) {
          gl_FragColor = vec4(abyssBase * (1.0 - uBlackout), 1.0);
          return;
        }

        vec2 carpetNorm = vec2(
          vWorldPos.x / (8.2 + 4.2 * uUnderSpan),
          (vWorldPos.z - (-1.2 - 1.3 * uUnderSpan)) / (5.0 + 3.9 * uUnderSpan)
        );
        float superFoot = pow(pow(abs(carpetNorm.x), 3.2) + pow(abs(carpetNorm.y), 3.0), 1.0 / 3.1);
        float insideWide = 1.0 - smoothstep(0.76, 1.14, superFoot);

        vec2 carpetUv = clamp(vec2(carpetNorm.x * 0.5 + 0.5, 0.5 - carpetNorm.y * 0.5), 0.01, 0.99);
        vec3 caustics = computeWideSwimmingPoolCaustics(vWorldPos.xz, carpetUv, uTime);

        // Synchronized Expanding Golden-Prismatic Floor Caustic Shockwave Ring on Spacebar Drumstick Strike!
        vec3 strikeShockCol = vec3(0.0);
        if (uStrikeAge >= 0.0 && uStrikeAge < 2.2) {
          float dImpact = length(vWorldPos.xz - uStrikeXZ);
          float rShock = 0.22 + uStrikeAge * 4.85;
          // one broad soft swell of light instead of two drawn rings and a flash
          float primaryRing = exp(-pow(abs((dImpact - rShock) / 0.95), 2.0)) * 0.30;
          float echoRing = 0.0;
          float centralFlash = exp(-(dImpact * dImpact) / 1.2) * smoothstep(0.0, 0.1, uStrikeAge) * exp(-uStrikeAge * 2.2) * 0.25;
          float shockDecay = exp(-uStrikeAge * 1.35);
          strikeShockCol = (vec3(1.25, 0.84, 0.32) * (primaryRing + centralFlash * 1.4) +
                            vec3(0.28, 0.88, 1.00) * echoRing) * shockDecay;
        }

        // soft sand ripples, so the light has something to land on
        float sandPh = vWorldPos.x * 4.6 + 1.5 * sin(vWorldPos.z * 1.3 + 0.7 * sin(vWorldPos.x * 0.6)) + vWorldPos.z * 0.9;
        float sand = 0.5 + 0.5 * sin(sandPh);
        float sandShade = 0.72 + 0.42 * sand * sand;
        vec3 col = abyssBase * (0.8 + 0.6 * sand) + (caustics * 0.42 * sandShade + strikeShockCol * 0.80) * insideWide * uFloorCaustics;

        if (uDrummerShadow > 0.002) {
          vec4 projClip = uDrummerMat * vec4(vWorldPos, 1.0);
          if (projClip.w > 0.05) {
            vec2 sUv = projClip.xy / projClip.w;
            if (sUv.x > 0.01 && sUv.x < 0.99 && sUv.y > 0.01 && sUv.y < 0.99) {
              float occ = texture2D(uDrummerTex, sUv).a;
              col *= mix(1.0, 0.38, occ * uDrummerShadow);
            }
          }
        }

        // Distance mist blend on the abyssal floor
        float farMist = smoothstep(-5.5, -14.0, vWorldPos.z);
        col = mix(col, mix(vec3(0.010, 0.017, 0.025), vec3(0.0035, 0.026, 0.034), uUnderSpan), farMist);

        gl_FragColor = vec4(col * (1.0 - uBlackout), 1.0);
      }
    `,
  });
  const basinFloorMesh = new THREE.Mesh(basinFloorGeo, basinFloorMat);
  basinFloorMesh.position.set(0, poolBounds.basinFloorY, -4.0);
  root.add(basinFloorMesh);

  // Hanging Refracted Volumetric Light Curtains beneath the Wide Floating Water Carpet (图 3 竖向绿线!)
  const curtainUniforms = {
    uTime: { value: 0.0 },
    uIntensity: { value: 0.0 },
    tWave: { value: dummyBlackTex as THREE.Texture },
    uBlackout: { value: 0.0 },
  };
  const curtainGroup = new THREE.Group();
  const curtainMat = new THREE.ShaderMaterial({
    uniforms: curtainUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uIntensity;
      uniform sampler2D tWave;
      uniform float uBlackout;

      void main() {
        if (uIntensity <= 0.002) discard;
        // Cubic bell vertical & horizontal feathering tucked safely below the hovering carpet (y = 1.32m -> -1.05m)
        // so ZERO horizontal step-edges or milky fog sheets ever appear!
        float vertBell = pow(max(0.0, sin(clamp(vUv.y, 0.0, 1.0) * 3.14159265)), 1.85); // max(): sin(pi) can be -1e-8 -> pow NaN -> black scanline
        float horizFade = 1.0 - smoothstep(0.48, 0.96, abs(vUv.x - 0.5) * 2.0);

        float carpetU = clamp(vWorldPos.x / 16.0 + 0.5, 0.02, 0.98);
        float carpetV = clamp(0.5 - (vWorldPos.z - (-1.2)) / 9.6, 0.02, 0.98);
        float liveH = texture2D(tWave, vec2(carpetU, carpetV)).r;

        // Sharp refracted caustic Tyndall filaments (pow 6.5..8.0 — delicate golden/aqua light shafts over clear dark air!)
        float xRay = vWorldPos.x + (1.0 - vUv.y) * 0.32;
        float fluteA = pow(max(0.0, 0.5 + 0.5 * sin(xRay * 2.05 + uTime * 2.25 + liveH * 4.5)), 6.5);
        float fluteB = pow(max(0.0, 0.5 + 0.5 * cos(xRay * 3.85 - uTime * 1.65 - vWorldPos.z * 0.9)), 7.5);
        float rays = fluteA * 1.15 + fluteB * 0.85 + abs(liveH) * 1.45;

        vec3 rayCol = mix(vec3(0.18, 0.58, 0.72), vec3(1.00, 0.68, 0.25), fluteA * 0.80 + 0.15) * rays;
        gl_FragColor = vec4(rayCol * vertBell * horizFade * uIntensity * 0.062 * (1.0 - uBlackout), 1.0);
      }
    `,
  });

  // Pulled safely inside the carpet footprint (z in [0.5 .. -3.1], top y = 1.32m < 1.48m carpet!) — zero step artifacts!
  for (const cz of [0.5, -0.7, -1.9, -3.1]) {
    const slice = new THREE.Mesh(new THREE.PlaneGeometry(14.6, 2.36, 1, 1), curtainMat);
    slice.position.set(0, 0.14, cz);
    curtainGroup.add(slice);
  }
  root.add(curtainGroup);

  // ============================================================================
  // 3B. SHOT 6 GOLDEN BALLISTIC SPLASH BURST + SHOT 5 LIFTOFF DRIPPING LIQUID PEARLS!
  // ============================================================================
  const NUM_SPLASH = 128;
  const splashSeeds = new Float32Array(NUM_SPLASH * 4);
  const splashDummyPos = new Float32Array(NUM_SPLASH * 3);
  for (let i = 0; i < NUM_SPLASH; i++) {
    splashSeeds[i * 4 + 0] = fractSin(i * 17.31 + 0.3);
    splashSeeds[i * 4 + 1] = fractSin(i * 53.79 + 1.7);
    splashSeeds[i * 4 + 2] = fractSin(i * 89.13 + 2.9);
    splashSeeds[i * 4 + 3] = i / NUM_SPLASH;
  }
  const splashGeo = new THREE.BufferGeometry();
  splashGeo.setAttribute('position', new THREE.BufferAttribute(splashDummyPos, 3));
  splashGeo.setAttribute('aSplashSeed', new THREE.BufferAttribute(splashSeeds, 4));

  const splashUniforms = {
    uTime: { value: 0.0 },
    uStrikeAge: { value: 999.0 },
    uStrikeOrigin: { value: new THREE.Vector3(-0.8, 1.48, -2.1) },
    uLiftoffPeel: { value: 0.0 },
    uBlackout: { value: 0.0 },
  };
  const splashMat = new THREE.ShaderMaterial({
    uniforms: splashUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSplashSeed;
      uniform float uTime;
      uniform float uStrikeAge;
      uniform vec3 uStrikeOrigin;
      uniform float uLiftoffPeel;
      varying float vAlpha;
      varying float vStretchY;
      varying vec3 vCol;

      void main() {
        vec3 worldP = vec3(0.0, -50.0, 0.0);
        vAlpha = 0.0;
        vStretchY = 1.0;
        vCol = vec3(1.0, 0.78, 0.42);

        if (uStrikeAge >= 0.0 && uStrikeAge < 1.35) {
          // Mode A: Shot 6 Ballistic Rayleigh-Crown Splash Burst + Central Jet from exact drumstick impact!
          float t = uStrikeAge;
          float ang = aSplashSeed.w * 6.2831853 + (aSplashSeed.x - 0.5) * 0.35;
          float isJet = step(0.80, aSplashSeed.y);
          float vRad = mix(1.35 + aSplashSeed.x * 2.55, 0.18 + aSplashSeed.x * 0.55, isJet);
          float vUp  = mix(1.95 + aSplashSeed.y * 2.35, 3.15 + aSplashSeed.z * 2.25, isJet);
          float grav = 9.4;

          vec2 horizDir = vec2(cos(ang), sin(ang));
          float rOut = 0.12 + vRad * t * (1.0 - 0.18 * t);
          float yArc = vUp * t - 0.5 * grav * t * t;

          if (yArc > -0.18) {
            worldP = uStrikeOrigin + vec3(horizDir.x * rOut, yArc, horizDir.y * rOut);
            float vyInst = abs(vUp - grav * t);
            vStretchY = clamp(1.0 + vyInst * 0.42, 1.0, 3.2);
            vAlpha = smoothstep(0.0, 0.02, t) * (1.0 - smoothstep(0.75, 1.28, t)) * smoothstep(-0.18, 0.02, yArc);
            vCol = mix(vec3(1.00, 0.74, 0.34), vec3(0.78, 0.92, 1.00), aSplashSeed.z * 0.38);
          }
        } else if (uLiftoffPeel > 0.01) {
          // Mode B: Shot 5 Liftoff Trailing Liquid-Pearl Strings dripping from the rising central liquid dome!
          float strIdx = floor(aSplashSeed.w * 24.0);
          float sx = (fract(sin(strIdx * 12.9898) * 43758.5) - 0.5) * 9.5;
          float sz = -1.2 + (fract(sin(strIdx * 78.233) * 24634.6) - 0.5) * 5.2;
          float domeH = 1.48 * uLiftoffPeel + 0.55 * sin(uLiftoffPeel * 3.14159) * exp(-(sx * sx + sz * sz) / 22.0);
          float fallFrac = fract(aSplashSeed.y + uTime * (0.65 + 0.45 * aSplashSeed.x));
          worldP = vec3(sx + (aSplashSeed.z - 0.5) * 0.08, max(0.02, domeH * (1.0 - fallFrac)), sz);
          vStretchY = 1.45;
          vAlpha = sin(uLiftoffPeel * 3.14159) * sin(fallFrac * 3.14159) * 0.88;
          vCol = mix(vec3(0.72, 0.90, 0.98), vec3(1.00, 0.80, 0.46), aSplashSeed.x * 0.65);
        }

        vec4 mv = modelViewMatrix * vec4(worldP, 1.0);
        float px = (13.0 + aSplashSeed.x * aSplashSeed.x * 26.0) / max(2.8, -mv.z) * vStretchY;
        gl_PointSize = vAlpha > 0.002 ? clamp(px, 1.6, 8.0) : 0.0;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vAlpha;
      varying float vStretchY;
      varying vec3 vCol;
      uniform float uBlackout;

      void main() {
        if (vAlpha <= 0.003) discard;
        // the point is taller than wide by vStretchY: a drop drawn out along its flight
        vec2 uv = (gl_PointCoord - 0.5) * vec2(2.25 * vStretchY, 2.25);
        float r2 = dot(uv, uv);
        if (r2 > 1.0) discard;

        vec3 N = normalize(vec3(uv.x, -uv.y, sqrt(max(0.0, 1.0 - r2))));
        float pinSpec = pow(max(0.0, dot(N, normalize(vec3(-0.22, 0.65, 0.72)))), 72.0);
        float lowerFocus = pow(max(0.0, dot(N, normalize(vec3(0.18, -0.72, 0.67)))), 10.0);
        float edgeAA = 1.0 - smoothstep(0.72, 1.0, sqrt(r2));

        vec3 beadCol = vec3(0.015, 0.028, 0.042) + vCol * (0.38 + lowerFocus * 1.45) + vec3(2.1, 1.85, 1.45) * pinSpec;
        gl_FragColor = vec4(beadCol * (1.0 - uBlackout), clamp((0.50 + pinSpec * 0.40) * edgeAA * vAlpha, 0.0, 0.98) * (1.0 - uBlackout));
      }
    `,
  });
  const splashPoints = new THREE.Points(splashGeo, splashMat);
  root.add(splashPoints);

  // ============================================================================
  // 4. BACKLIT ATMOSPHERIC DUST MOTES + SHOT 4 ANTI-GRAVITY LIQUID WATER PEARLS
  // ============================================================================
  // 4A. Constant subtle atmospheric volumetric motes drifting in the upper Tyndall light beams
  const NUM_AIR_DUST = 220;
  const dustPos = new Float32Array(NUM_AIR_DUST * 3);
  const dustSeed = new Float32Array(NUM_AIR_DUST * 3);
  for (let i = 0; i < NUM_AIR_DUST; i++) {
    const r1 = fractSin(i * 12.9898 + 1.1);
    const r2 = fractSin(i * 78.233 + 2.2);
    const r3 = fractSin(i * 43.123 + 3.3);
    dustPos[i * 3 + 0] = (r1 - 0.5) * 15.0;
    dustPos[i * 3 + 1] = 0.25 + r2 * 5.2;
    dustPos[i * 3 + 2] = -9.0 + r3 * 12.5;
    dustSeed[i * 3 + 0] = r1;
    dustSeed[i * 3 + 1] = r2;
    dustSeed[i * 3 + 2] = r3;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 3));
  const dustUniforms = {
    uTime: { value: 0.0 },
    uLights: { value: lightArray },
    uBlackout: { value: 0.0 },
    uShot1Dark: { value: 0.0 },
    uDk: { value: 0.0 },
  };
  const dustMat = new THREE.ShaderMaterial({
    uniforms: dustUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aSeed;
      uniform float uTime;
      uniform vec4 uLights[4];
      uniform float uShot1Dark;
      uniform float uDk;
      varying float vAlpha;
      varying vec3 vCol;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.18 + aSeed.y * 6.28) * 0.45;
        p.y += cos(uTime * 0.14 + aSeed.x * 6.28) * 0.25;

        float lampGlow = 0.0;
        for (int i = 0; i < 4; i++) {
          if (uLights[i].w > 0.01) {
            float d = length(p - uLights[i].xyz);
            lampGlow += uLights[i].w * 2.25 / (1.4 + d * d);
          }
        }
        lampGlow = clamp(lampGlow, 0.0, 1.45);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float distFade = smoothstep(16.0, 3.0, -mv.z) * smoothstep(1.6, 3.2, -mv.z);
        vAlpha = (0.22 + 0.45 * aSeed.z + lampGlow * 0.55) * distFade;
        vCol = mix(mix(vec3(0.42, 0.68, 0.85), vec3(0.95, 0.72, 0.42), aSeed.x), vec3(1.00, 0.80, 0.44), clamp(lampGlow * 0.75, 0.0, 1.0));
        // Shot 1: dust exists only where the overhead lamp shaft catches it (cone axis at x=0, z=0.35).
        if (uShot1Dark > 0.002) {
          float cr = 0.30 + max(0.0, 9.5 - p.y) * 0.34;
          float rr = length(p.xz - vec2(0.0, 0.35)) / cr;
          float inBeam = exp(-rr * rr * 2.0);
          vAlpha = mix(vAlpha, (0.35 + 0.65 * aSeed.z) * inBeam * 1.6 * distFade, uShot1Dark);
          vCol = mix(vCol, vec3(1.00, 0.84, 0.60), uShot1Dark);
        }
        // Shot ②: motes exist only where a flower lights them, and they are amber like everything else.
        if (uDk > 0.002) {
          vAlpha = mix(vAlpha, lampGlow * 0.22 * distFade, uDk);
          vCol = mix(vCol, vec3(1.00, 0.74, 0.42), uDk);
        }
        gl_PointSize = clamp((13.0 + aSeed.y * 15.0) / max(1.8, -mv.z), 1.6, 6.8);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vAlpha;
      varying vec3 vCol;
      uniform float uBlackout;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        if (r > 1.0) discard;
        float g = exp(-r * r * 3.6);
        gl_FragColor = vec4(vCol * g * vAlpha * 0.48 * (1.0 - uBlackout), 1.0);
      }
    `,
  });
  root.add(new THREE.Points(dustGeo, dustMat));

  // 4B. Shot 4 Anti-Gravity Rising Liquid Water Pearls (Death Stranding / Avatar 3A World-Scale Liquid Beads!)
  // Organized into 3 graceful helical updraft streams lifting directly out of the water surface (`y = 0`)
  // beneath blossoms B `(0, +0.85)`, A `(-2.25, -0.95)`, and C `(+2.25, -0.95)`!
  // Strict physical size hierarchy: 86% delicate `1.5px–4.5px` shimmering liquid pinpricks, 14% `5px–9.5px`
  // refractive 3D liquid beads (dark liquid core + razor pinpoint specular + warm lower caustic focus, ZERO soap-bubble ring!).
  const NUM_PEARLS = 560;
  const motePositions = new Float32Array(NUM_PEARLS * 3);
  const moteSeeds = new Float32Array(NUM_PEARLS * 3);
  const streamCenters: [number, number][] = [
    [0.0, 0.85],
    [-2.25, -0.95],
    [2.25, -0.95],
  ];
  for (let i = 0; i < NUM_PEARLS; i++) {
    const r1 = fractSin(i * 19.19 + 0.7);
    const r2 = fractSin(i * 67.31 + 1.9);
    const r3 = fractSin(i * 31.77 + 4.3);
    const r4 = fractSin(i * 91.13 + 2.7);
    const streamIdx = i % 3;
    const [cx, cz] = streamCenters[streamIdx];
    // 78% concentrated in helical updraft columns around B, A, C; 22% gentle wider stage mist drift
    const radialSpread = r4 < 0.78 ? 0.25 + Math.pow(r1, 0.75) * 1.45 : 1.5 + r1 * 2.8;
    const theta = r3 * Math.PI * 2.0;
    motePositions[i * 3 + 0] = cx + Math.cos(theta) * radialSpread;
    motePositions[i * 3 + 1] = r2 * 4.1;
    // Keep z <= 2.8m so NO particle ever flies close to the camera (`z = 6.45m`) as an oversized circle!
    motePositions[i * 3 + 2] = THREE.MathUtils.clamp(cz + Math.sin(theta) * radialSpread * 0.85, -4.2, 2.75);
    moteSeeds[i * 3 + 0] = r1;
    moteSeeds[i * 3 + 1] = r2;
    moteSeeds[i * 3 + 2] = r3;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(moteSeeds, 3));

  const moteUniforms = {
    uTime: { value: 0.0 },
    uIntensity: { value: 0.0 },
    uMistCaustics: { value: 0.0 },
    uLights: { value: lightArray },
    uBlackout: { value: 0.0 },
  };
  const moteMat = new THREE.ShaderMaterial({
    uniforms: moteUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aSeed;
      uniform float uTime;
      uniform float uIntensity;
      uniform float uMistCaustics;
      uniform vec4 uLights[4];
      varying float vAlpha;
      varying float vIsBead;
      varying vec3 vLightTint;

      void main() {
        vec3 p = position;
        // 86% fine shimmering 1.5-4.5px micro-droplets; 14% crisp 5.0-9.2px 3D refractive liquid beads!
        float isBead = step(0.86, aSeed.y);
        vIsBead = isBead;

        float speed = mix(0.18, 0.31, aSeed.x);
        float hCycle = fract((p.y / 4.1) + uTime * speed * 0.24 + aSeed.y);
        // Lift gracefully out of the water surface y = 0.03m up into the golden blossoms & Wallace mist shafts!
        p.y = 0.03 + hCycle * 4.05;

        // Gentle helical updraft swirl as droplets ascend
        float swirlAng = hCycle * 2.4 + uTime * 0.38 + aSeed.z * 6.28318;
        p.x += cos(swirlAng) * 0.14 * sin(hCycle * 3.14159);
        p.z += sin(swirlAng) * 0.14 * sin(hCycle * 3.14159);

        // Brighten dramatically inside the warm Shylight cones & diagonal Wallace caustic shafts, dim outside!
        float lampIllum = 0.16;
        for (int i = 0; i < 4; i++) {
          if (uLights[i].w > 0.01) {
            float d = length(p - uLights[i].xyz);
            lampIllum += uLights[i].w * 2.15 / (0.55 + d * d);
          }
        }
        float shaftBand = pow(max(0.0, 0.5 + 0.5 * sin(p.x * 0.85 - p.y * 0.55 + uTime * 0.28)), 2.0) * uMistCaustics;
        lampIllum = clamp(lampIllum + shaftBand * 0.65, 0.14, 2.15);

        float lifeFade = smoothstep(0.0, 0.12, hCycle) * (1.0 - smoothstep(0.82, 1.0, hCycle));
        vAlpha = lifeFade * uIntensity * clamp(lampIllum * 0.72, 0.0, 1.0);
        vLightTint = mix(vec3(0.46, 0.62, 0.70), vec3(1.00, 0.80, 0.46), clamp(lampIllum * 0.75, 0.0, 1.0));

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // Strict physical millimeter perspective scale: 1.6px..4.4px micro-pearls, 5.2px..9.4px hero beads (NEVER > 9.8px!)
        // fine drops are drawn as short rising streaks (they move), beads stay round
        float worldFactor = mix(30.0 + aSeed.x * 34.0, 34.0 + aSeed.z * 16.0, isBead);
        gl_PointSize = clamp(worldFactor / max(3.6, -mv.z), 3.0, 14.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vAlpha;
      varying float vIsBead;
      varying vec3 vLightTint;
      uniform float uBlackout;

      void main() {
        if (vAlpha <= 0.003) discard;
        // Subtle vertical prolate teardrop stretch as liquid pearl rises!
        vec2 uv = (gl_PointCoord - 0.5) * vec2(2.18, 1.92);
        float r2 = dot(uv, uv);
        if (r2 > 1.0) discard;

        if (vIsBead < 0.5) {
          // Delicate shimmering 1.6-4.4px golden-ivory & aqua liquid pinprick
          // a thin vertical streak with a brighter leading end: water rising, not dust hanging
          vec2 q = gl_PointCoord - 0.5;
          float along = clamp(0.5 - q.y, 0.0, 1.0);
          float pin = exp(-(q.x * q.x) / 0.0090) * smoothstep(0.0, 0.8, along) * smoothstep(1.0, 0.9, along);
          pin = pin * pin * (0.35 + 0.65 * along);
          gl_FragColor = vec4(vLightTint * (0.95 * pin) * (1.0 - uBlackout), pin * vAlpha * 0.62 * (1.0 - uBlackout));
          return;
        }

        // Analytic 3D Refractive Water Bead (N = normalize(vec3(uv.x, -uv.y, sqrt(1.0 - r2))) — ZERO soap-bubble ring!):
        // Water droplets have a DARK abyssal-refracting interior body, a razor-sharp upper-inner HDR pinpoint specular
        // glint toward the 2700K flower heart, and a warm golden caustic lens focus at the lower meniscus!
        vec3 N = normalize(vec3(uv.x, -uv.y, sqrt(max(0.0, 1.0 - r2))));
        vec3 L = normalize(vec3(-0.28, 0.68, 0.67));
        vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));

        float pinSpec = pow(max(0.0, dot(N, H)), 96.0);
        float lowerCausticFocus = pow(max(0.0, dot(N, normalize(vec3(0.22, -0.76, 0.61)))), 14.0);
        float softEdgeAA = 1.0 - smoothstep(0.78, 1.0, sqrt(r2));

        vec3 darkRefractedCore = vec3(0.012, 0.024, 0.038);
        vec3 beadRgb = darkRefractedCore
                     + vLightTint * (lowerCausticFocus * 1.45 + 0.14)
                     + vec3(1.85, 1.68, 1.38) * pinSpec;

        float beadAlpha = clamp((0.68 + pinSpec * 0.32 + lowerCausticFocus * 0.25) * softEdgeAA * vAlpha, 0.0, 0.96);
        gl_FragColor = vec4(beadRgb * (1.0 - uBlackout), beadAlpha * (1.0 - uBlackout));
      }
    `,
  });
  const motePoints = new THREE.Points(moteGeo, moteMat);
  root.add(motePoints);

  function update(state: GalleryUpdateState) {
    for (let i = 0; i < 4; i++) {
      if (i < state.shylightLights.length) {
        const l = state.shylightLights[i];
        lightArray[i].set(l.pos.x, l.pos.y, l.pos.z, l.glow);
      } else {
        lightArray[i].set(0, 5, -1, 0);
      }
    }

    skyUniforms.uTime.value = state.time;
    skyUniforms.uGodRayBoost.value = state.volumetricShaftIntensity;
    skyUniforms.uMistCaustics.value = state.wallCausticIntensity;
    skyUniforms.uDrummerShadow.value = state.drummerShadowIntensity;
    skyUniforms.uBlackout.value = state.endingBlackout;
    skyUniforms.uShot1Dark.value = state.shot1Dark ?? 0.0;
    mistScreenUniforms.uShot1Dark.value = state.shot1Dark ?? 0.0;
    skyUniforms.uAmbientKeep.value = state.ambientKeep ?? 1.0;
    mistScreenUniforms.uAmbientKeep.value = state.ambientKeep ?? 1.0;
    dustUniforms.uShot1Dark.value = state.shot1Dark ?? 0.0;
    const dk = state.dk ?? 0.0;
    skyUniforms.uDk.value = dk;
    mistScreenUniforms.uDk.value = dk;
    dustUniforms.uDk.value = dk;
    if (state.dkAxis) skyUniforms.uDkAxis.value.set(state.dkAxis[0], state.dkAxis[1], state.dkAxis[2]);
    skyUniforms.uDkTop.value = state.dkTop ?? 1.0;
    if (state.drummerShadowTex) skyUniforms.uDrummerTex.value = state.drummerShadowTex;
    if (state.drummerShadowMatrix) skyUniforms.uDrummerMat.value.copy(state.drummerShadowMatrix);

    mistScreenUniforms.uTime.value = state.time;
    mistScreenUniforms.uGodRayBoost.value = state.volumetricShaftIntensity;
    mistScreenUniforms.uMistCaustics.value = state.wallCausticIntensity;
    mistScreenUniforms.uDrummerShadow.value = state.drummerShadowIntensity;
    mistScreenUniforms.uBlackout.value = state.endingBlackout;
    if (state.drummerShadowTex) mistScreenUniforms.uDrummerTex.value = state.drummerShadowTex;
    if (state.drummerShadowMatrix) mistScreenUniforms.uDrummerMat.value.copy(state.drummerShadowMatrix);

    basinFloorUniforms.uTime.value = state.time;
    basinFloorUniforms.uFloorCaustics.value = state.poolFloorCausticIntensity;
    basinFloorUniforms.uDrummerShadow.value = state.drummerShadowIntensity;
    basinFloorUniforms.uStrikeAge.value = state.timeSinceDrummerStrike ?? 999.0;
    if (state.strikeWorldPos) {
      basinFloorUniforms.uStrikeXZ.value.set(state.strikeWorldPos[0], state.strikeWorldPos[2]);
    }
    basinFloorUniforms.uBlackout.value = state.endingBlackout;
    if (state.causticWaveTex) basinFloorUniforms.tWave.value = state.causticWaveTex;
    if (state.drummerShadowTex) basinFloorUniforms.uDrummerTex.value = state.drummerShadowTex;
    if (state.drummerShadowMatrix) basinFloorUniforms.uDrummerMat.value.copy(state.drummerShadowMatrix);

    curtainUniforms.uTime.value = state.time;
    curtainUniforms.uIntensity.value = state.poolFloorCausticIntensity;
    curtainUniforms.uBlackout.value = state.endingBlackout;
    if (state.causticWaveTex) curtainUniforms.tWave.value = state.causticWaveTex;
    curtainGroup.visible = state.poolFloorCausticIntensity > 0.003;

    const lev = state.carpetLevitation ?? 0.0;
    const liftoffPeel = lev > 0.02 && lev < 0.96 && state.time < 160.0 && (state.underAmt ?? 0) < 0.05 ? lev : 0.0;
    const strikeAge = state.timeSinceDrummerStrike ?? 999.0;
    splashUniforms.uTime.value = state.time;
    splashUniforms.uStrikeAge.value = strikeAge;
    splashUniforms.uLiftoffPeel.value = liftoffPeel;
    splashUniforms.uBlackout.value = state.endingBlackout;
    if (state.strikeWorldPos) {
      splashUniforms.uStrikeOrigin.value.set(
        state.strikeWorldPos[0],
        state.strikeWorldPos[1],
        state.strikeWorldPos[2]
      );
    }
    splashPoints.visible = (strikeAge >= 0.0 && strikeAge < 1.35) || liftoffPeel > 0.01;

    dustUniforms.uTime.value = state.time;
    dustUniforms.uBlackout.value = state.endingBlackout;

    skyUniforms.uUnder.value = state.underAmt ?? 0;
    mistScreenUniforms.uUnder.value = state.underAmt ?? 0;
    mistScreenUniforms.uEcho.value = state.drummerEcho ?? 0;
    mistScreenUniforms.uReveal.value = state.drummerReveal ?? 0;
    mistScreenUniforms.uTri.value = state.triShadow ?? 0;
    mistScreenUniforms.uTriSpread.value = state.triSpread ?? 0.07;
    if (state.echoTextures) {
      mistScreenUniforms.uEchoTex1.value = state.echoTextures[0];
      mistScreenUniforms.uEchoTex2.value = state.echoTextures[1];
    }
    basinFloorUniforms.uFractal.value = state.causticFractal ?? 0;
    basinFloorUniforms.uUnderSpan.value = state.underSpan ?? 0;
    basinFloorUniforms.uRainbow.value = state.rainbow ?? 0;
    moteUniforms.uTime.value = state.time;
    moteUniforms.uIntensity.value = state.antiGravityDropletsIntensity;
    moteUniforms.uMistCaustics.value = state.wallCausticIntensity;
    moteUniforms.uBlackout.value = state.endingBlackout;
    motePoints.visible = state.antiGravityDropletsIntensity > 0.002;
  }

  return {
    root,
    poolBounds,
    update,
  };
}

function fractSin(x: number): number {
  const s = Math.sin(x) * 43758.5453123;
  return s - Math.floor(s);
}
