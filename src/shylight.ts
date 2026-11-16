import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CLIP_BLOOM, CLIP_NAMES } from './shot2';
import { isMobile } from './device';

export interface ShylightUnitPose {
  /** 0 = faded into upper volumetric mist, 1 = fully present floating in space */
  presence: number;
  /** 0 = slender calla-lily bud, 1 = lush full 5-tier pleated silk lotus bloom */
  openAmount: number;
  /** Musical vertical bobbing / rhythmic dip offset in meters (+up, -down) */
  bobOffsetMeters: number;
  /** Internal 2700K warm COB LED & silk subsurface glow multiplier (0..1.5) */
  glowIntensity: number;
  /** Forward tilt toward camera in radians */
  tiltTowardsCameraRad?: number;
  /** Gentle axial spin in radians */
  spinRad?: number;
  /**
   * Forward playback of the three baked clips (0 bloom, 1 hover, 2 close; see shot2.ts): which clip and
   * how many seconds into it, chosen by the choreographer so each clip runs at its own speed.
   * When absent (older shots), openAmount is mapped onto the bloom clip instead.
   */
  clip?: { clip: number; t: number; from?: { clip: number; t: number; w: number } };
  /** Where this unit hangs for the current shot, and how far it falls while blooming. */
  layout?: { x: number; topY: number; z: number; scale: number; dropMeters: number; drop01: number };
  /** Suspension cable visibility (0..1). */
  cable?: number;
}

export interface ShylightEnsembleState {
  time: number;
  causticBounce?: number;
  /** 0..1: the flower is its own key light; the generic fill lights on the silk are pulled down. */
  selfLit?: number;
  /** 0..1: no light falls on the silk at all (the flowers are shapes against a bright ground). */
  silhouette?: number;
  unitA: ShylightUnitPose;
  unitB: ShylightUnitPose;
  unitC: ShylightUnitPose;
  unitGiant: ShylightUnitPose;
}

export interface ShylightUnitTelemetry {
  open: number;
  canopyWorldY: number;
  distToWaterMeters: number;
  glow: number;
  worldX: number;
  worldZ: number;
}

export interface ShylightEnsembleHandles {
  root: THREE.Group;
  ready: Promise<void>;
  update: (state: ShylightEnsembleState, dt: number) => void;
  getTelemetry: () => {
    A: ShylightUnitTelemetry;
    B: ShylightUnitTelemetry;
    C: ShylightUnitTelemetry;
    Giant: ShylightUnitTelemetry;
  };
  getLightSources: () => { pos: THREE.Vector3; glow: number }[];
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2.0 * p1 +
      (-p0 + p2) * t +
      (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
      (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
  );
}

/**
 *Bicubic Catmull-Rom Cylindrical Surface Subdivision (`144x25` -> `288x49` = `4x` smoothness!)
 * across Base Positions, Normals, `_silk_ao`, AND all 60 Blender Cloth Morph Targets!
 * - Eliminates 100% of straight polygonal chord segments on `4.5x` head-on Shot 7 close-ups AND
 *   smooths the closed-bud zigzag into continuous supple silk curves!
 */
function subdivideSilkGeometryCatmullRom(srcGeo: THREE.BufferGeometry, subU = 2, subV = 2): THREE.BufferGeometry {
  const srcPos = srcGeo.attributes.position as THREE.BufferAttribute;
  if (!srcPos || srcPos.count !== 3600) return srcGeo;

  const NU = 144;
  const NV = 25;
  const outNU = NU * subU; // 288 circumferential silk columns!
  const outNV = (NV - 1) * subV + 1; // 49 vertical rows!
  const outCount = outNU * outNV;

  const idxSrc = (i: number, j: number): number => {
    const iw = ((i % NU) + NU) % NU;
    const jc = Math.max(0, Math.min(NV - 1, j));
    return jc * NU + iw;
  };

  // Smooth the small odd-even folded-bud discretization ripple on base positions while keeping 100% of the 9-lobe silk form!
  const cleanBasePos = new Float32Array(srcPos.array.length);
  cleanBasePos.set(srcPos.array as ArrayLike<number>);
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const c = idxSrc(i, j) * 3;
      const l = idxSrc(i - 1, j) * 3;
      const r = idxSrc(i + 1, j) * 3;
      cleanBasePos[c + 0] = srcPos.array[c + 0] * 0.56 + (srcPos.array[l + 0] + srcPos.array[r + 0]) * 0.22;
      cleanBasePos[c + 1] = srcPos.array[c + 1] * 0.64 + (srcPos.array[l + 1] + srcPos.array[r + 1]) * 0.18;
      cleanBasePos[c + 2] = srcPos.array[c + 2] * 0.56 + (srcPos.array[l + 2] + srcPos.array[r + 2]) * 0.22;
    }
  }

  const resampleVec3 = (arr: ArrayLike<number>, normalizeOut = false): Float32Array => {
    const out = new Float32Array(outCount * 3);
    const rowBuf = new Float32Array(4 * 3);
    for (let oj = 0; oj < outNV; oj++) {
      const vj = oj / subV;
      const j1 = Math.min(NV - 1, Math.floor(vj));
      const tv = vj - j1;

      for (let oi = 0; oi < outNU; oi++) {
        const ui = oi / subU;
        const i1 = Math.floor(ui);
        const tu = ui - i1;

        for (let dj = -1; dj <= 2; dj++) {
          const sj = j1 + dj;
          const p0 = idxSrc(i1 - 1, sj) * 3;
          const p1 = idxSrc(i1, sj) * 3;
          const p2 = idxSrc(i1 + 1, sj) * 3;
          const p3 = idxSrc(i1 + 2, sj) * 3;
          const rb = (dj + 1) * 3;
          rowBuf[rb + 0] = catmullRom(arr[p0], arr[p1], arr[p2], arr[p3], tu);
          rowBuf[rb + 1] = catmullRom(arr[p0 + 1], arr[p1 + 1], arr[p2 + 1], arr[p3 + 1], tu);
          rowBuf[rb + 2] = catmullRom(arr[p0 + 2], arr[p1 + 2], arr[p2 + 2], arr[p3 + 2], tu);
        }

        let rx = catmullRom(rowBuf[0], rowBuf[3], rowBuf[6], rowBuf[9], tv);
        let ry = catmullRom(rowBuf[1], rowBuf[4], rowBuf[7], rowBuf[10], tv);
        let rz = catmullRom(rowBuf[2], rowBuf[5], rowBuf[8], rowBuf[11], tv);

        if (normalizeOut) {
          const len = Math.hypot(rx, ry, rz) || 1.0;
          rx /= len;
          ry /= len;
          rz /= len;
        }
        const dst = (oj * outNU + oi) * 3;
        out[dst + 0] = rx;
        out[dst + 1] = ry;
        out[dst + 2] = rz;
      }
    }
    return out;
  };

  const outGeo = new THREE.BufferGeometry();
  outGeo.setAttribute('position', new THREE.BufferAttribute(resampleVec3(cleanBasePos, false), 3));

  // Normals are worked out from the grid itself, for the rest pose and for every baked pose. The
  // compressed model stores no pose normals, and the normals Blender exported did not face the same way
  // on every tier. These always face outward, the same side the triangles below call "front".
  const gridNormals = (pos: Float32Array, add?: Float32Array): Float32Array => {
    const out = new Float32Array(outCount * 3);
    const at = (oi: number, oj: number, c: number): number => {
      const k = (oj * outNU + (((oi % outNU) + outNU) % outNU)) * 3 + c;
      return add ? pos[k] + add[k] : pos[k];
    };
    for (let oj = 0; oj < outNV; oj++) {
      const ja = Math.max(0, oj - 1);
      const jb = Math.min(outNV - 1, oj + 1);
      for (let oi = 0; oi < outNU; oi++) {
        const ux = at(oi + 1, oj, 0) - at(oi - 1, oj, 0);
        const uy = at(oi + 1, oj, 1) - at(oi - 1, oj, 1);
        const uz = at(oi + 1, oj, 2) - at(oi - 1, oj, 2);
        const vx = at(oi, jb, 0) - at(oi, ja, 0);
        const vy = at(oi, jb, 1) - at(oi, ja, 1);
        const vz = at(oi, jb, 2) - at(oi, ja, 2);
        // (crown -> hem) x (around): outward for this grid
        let nx = vy * uz - vz * uy;
        let ny = vz * ux - vx * uz;
        let nz = vx * uy - vy * ux;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-12) {
          nx /= len;
          ny /= len;
          nz /= len;
        } else {
          nx = 0;
          ny = -1;
          nz = 0;
        }
        const dst = (oj * outNU + oi) * 3;
        out[dst] = nx;
        out[dst + 1] = ny;
        out[dst + 2] = nz;
      }
    }
    return out;
  };
  const outBasePos = outGeo.attributes.position.array as Float32Array;
  const outBaseNorm = gridNormals(outBasePos);
  outGeo.setAttribute('normal', new THREE.BufferAttribute(outBaseNorm, 3));

  // Exact continuous UV & bilinear/cubic `_silk_ao`
  const outUv = new Float32Array(outCount * 2);
  const srcAo = srcGeo.attributes._silk_ao as THREE.BufferAttribute | undefined;
  const outAo = new Float32Array(outCount * 2);

  for (let oj = 0; oj < outNV; oj++) {
    const vVal = 1.0 - oj / (outNV - 1);
    const vj = oj / subV;
    const j0 = Math.min(NV - 1, Math.floor(vj));
    const j1 = Math.min(NV - 1, j0 + 1);
    const tv = vj - j0;

    for (let oi = 0; oi < outNU; oi++) {
      const uVal = oi / outNU;
      const ui = oi / subU;
      const i0 = Math.floor(ui);
      const tu = ui - i0;
      const dst2 = (oj * outNU + oi) * 2;
      outUv[dst2 + 0] = uVal;
      outUv[dst2 + 1] = vVal;

      if (srcAo) {
        const a00 = idxSrc(i0, j0) * 2;
        const a10 = idxSrc(i0 + 1, j0) * 2;
        const a01 = idxSrc(i0, j1) * 2;
        const a11 = idxSrc(i0 + 1, j1) * 2;
        const aoArr = srcAo.array;
        const ax0 = aoArr[a00] * (1 - tu) + aoArr[a10] * tu;
        const ax1 = aoArr[a01] * (1 - tu) + aoArr[a11] * tu;
        const ay0 = aoArr[a00 + 1] * (1 - tu) + aoArr[a10 + 1] * tu;
        const ay1 = aoArr[a01 + 1] * (1 - tu) + aoArr[a11 + 1] * tu;
        outAo[dst2 + 0] = ax0 * (1 - tv) + ax1 * tv;
        outAo[dst2 + 1] = ay0 * (1 - tv) + ay1 * tv;
      } else {
        outAo[dst2 + 0] = 0.75;
        outAo[dst2 + 1] = 0.85;
      }
    }
  }
  outGeo.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  outGeo.setAttribute('_silk_ao', new THREE.BufferAttribute(outAo, 2));

  // Resample all 60 Morph Targets (Position + Normal deltas!)
  if (srcGeo.morphAttributes.position) {
    // (the compressed model stores the poses as 16-bit integers: read them through the attribute, which
    // turns them back into metres)
    const srcFloat = new Float32Array(3600 * 3);
    const posOut: THREE.BufferAttribute[] = [];
    const normOut: THREE.BufferAttribute[] = [];
    for (const attr of srcGeo.morphAttributes.position as THREE.BufferAttribute[]) {
      for (let i = 0; i < 3600; i++) {
        srcFloat[i * 3] = attr.getX(i);
        srcFloat[i * 3 + 1] = attr.getY(i);
        srcFloat[i * 3 + 2] = attr.getZ(i);
      }
      const delta = resampleVec3(srcFloat, false);
      const n = gridNormals(outBasePos, delta);
      for (let k = 0; k < n.length; k++) n[k] -= outBaseNorm[k];
      posOut.push(new THREE.BufferAttribute(delta, 3));
      normOut.push(new THREE.BufferAttribute(n, 3));
    }
    outGeo.morphAttributes.position = posOut;
    outGeo.morphAttributes.normal = normOut;
  }
  outGeo.morphTargetsRelative = srcGeo.morphTargetsRelative;

  // Wrap-around seamless cylindrical triangle index buffer (`288 * 48 * 2 = 27,648` butter-smooth triangles!)
  const indices = new Uint32Array(outNU * (outNV - 1) * 6);
  let ptr = 0;
  for (let oj = 0; oj < outNV - 1; oj++) {
    for (let oi = 0; oi < outNU; oi++) {
      const nextI = (oi + 1) % outNU;
      const p00 = oj * outNU + oi;
      const p10 = oj * outNU + nextI;
      const p01 = (oj + 1) * outNU + oi;
      const p11 = (oj + 1) * outNU + nextI;
      indices[ptr++] = p00;
      indices[ptr++] = p01;
      indices[ptr++] = p10;
      indices[ptr++] = p10;
      indices[ptr++] = p01;
      indices[ptr++] = p11;
    }
  }
  outGeo.setIndex(new THREE.BufferAttribute(indices, 1));
  outGeo.computeBoundingSphere();
  return outGeo;
}

/**
 * Studio Drift *Shylight* Zijdar Crêpe Georgette Silk Shader (v2d):
 * - Unbleached warm champagne-ecru / antique pearl (`#d7c4aa`) outer pleats & warm taupe valleys;
 * - Scallop-modulated organic petal shadow (ZERO concentric target bullseye rings on head-on views!);
 * - Sculpted multi-layered honey-amber / bronze-gold ruffled stamen ribbons (`#8c4308` -> `#ffbe55` -> `#ffe8a8`,
 *   ZERO blown-out yellow-white blob on head-on Shot 7!).
 */
/** Woven linen scan shared by every flower (2K, tiled). Loaded once. */
let weaveTexCache: { normal: THREE.Texture; pack: THREE.Texture } | null = null;
function getWeaveTextures(): { normal: THREE.Texture; pack: THREE.Texture } {
  if (weaveTexCache) return weaveTexCache;
  const loader = new THREE.TextureLoader();
  const load = (url: string) => {
    const t = loader.load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  weaveTexCache = {
    normal: load(import.meta.env.BASE_URL + 'textures/linen-woven/normal.jpg'),
    pack: load(import.meta.env.BASE_URL + 'textures/linen-woven/pack_height_opacity_ao.jpg'),
  };
  return weaveTexCache;
}

function createZijdarPureSilkMaterial(
  silkUniforms: {
    uSilkBloom: { value: number };
    uSilkGlowScale: { value: number };
    uPresenceFade: { value: number };
    uHeadOnMode: { value: number };
  },
  tierWarmth: number,
  tierIndex: number,
  morphPair: { value: THREE.Vector4 }
): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    // matte cloth: backlit silk has no highlight and mirrors nothing
    roughness: 0.95,
    metalness: 0.0,
    ior: 1.45,
    specularIntensity: 0.0,
    sheen: 0.12,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color().setRGB(0.90, 0.88, 0.84, THREE.LinearSRGBColorSpace),
    side: THREE.DoubleSide,
    envMapIntensity: 0.0,
    transparent: true,
    opacity: 1.0,
  });

  const weaveTex = getWeaveTextures();
  const uid = Math.random().toString(36).slice(2, 8);
  mat.customProgramCacheKey = () => `zijdar-silk-backlit-v7-${uid}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSilkBloom = silkUniforms.uSilkBloom;
    shader.uniforms.uSilkGlowScale = silkUniforms.uSilkGlowScale;
    shader.uniforms.uPresenceFade = silkUniforms.uPresenceFade;
    shader.uniforms.uHeadOnMode = silkUniforms.uHeadOnMode;
    shader.uniforms.uTierWarmth = { value: tierWarmth };
    shader.uniforms.uTierIndex = { value: tierIndex };
    shader.uniforms.uMorphPair = morphPair;
    shader.uniforms.uWeaveNormal = { value: weaveTex.normal };
    shader.uniforms.uWeavePack = { value: weaveTex.pack };
    shader.uniforms.uMorphPairB = (morphPair as unknown as { b: { value: THREE.Vector4 } }).b;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 _silk_ao;
        uniform float uSilkBloom;
        uniform float uTierIndex;
        uniform float uHeadOnMode;
        // xy = indices of the two baked cloth poses being blended, zw = their weights
        uniform vec4 uMorphPair;
        // the same for a second pose that is being faded out (weights are zero when there is none)
        uniform vec4 uMorphPairB;
        varying vec3 vBulbView;
        varying vec3 vSilkLocalPos;
        varying vec2 vSilkUv;
        varying float vSilkAo;`
      )
      .replace(
        '#include <morphnormal_vertex>',
        // Only two baked poses are ever blended at once. The stock chunk walks all 86 targets for every
        // vertex; reading just the two that matter is what makes the flowers affordable.
        `#ifdef USE_MORPHNORMALS
          objectNormal += getMorph( gl_VertexID, int( uMorphPair.x ), 1 ).xyz * uMorphPair.z
                        + getMorph( gl_VertexID, int( uMorphPair.y ), 1 ).xyz * uMorphPair.w;
          if ( uMorphPairB.z + uMorphPairB.w > 0.0 ) {
            objectNormal += getMorph( gl_VertexID, int( uMorphPairB.x ), 1 ).xyz * uMorphPairB.z
                          + getMorph( gl_VertexID, int( uMorphPairB.y ), 1 ).xyz * uMorphPairB.w;
          }
        #endif`
      )
      .replace(
        '#include <morphtarget_vertex>',
        `#ifdef USE_MORPHTARGETS
          transformed += getMorph( gl_VertexID, int( uMorphPair.x ), 0 ).xyz * uMorphPair.z
                       + getMorph( gl_VertexID, int( uMorphPair.y ), 0 ).xyz * uMorphPair.w;
          if ( uMorphPairB.z + uMorphPairB.w > 0.0 ) {
            transformed += getMorph( gl_VertexID, int( uMorphPairB.x ), 0 ).xyz * uMorphPairB.z
                         + getMorph( gl_VertexID, int( uMorphPairB.y ), 0 ).xyz * uMorphPairB.w;
          }
        #endif
        float silkV = 1.0 - uv.y; // 0 = crown, 1 = scalloped petal tip

        // 1. Physical 3D Radial Silk Accordion Pleats & Organic Asymmetric Petal Curl!
        float radXZ = length(transformed.xz);
        vec2 radDir = radXZ > 1e-4 ? (transformed.xz / radXZ) : vec2(1.0, 0.0);
        // (the 45 evenly spaced flutes are gone: they read as a moulded part, not as cloth)
        float finePleatWave = 0.0;
        float organicPetalVar = sin(uv.x * 5.0 * 6.2831853 + uTierIndex * 1.9) * 0.5 +
                                cos(uv.x * 3.0 * 6.2831853 - uTierIndex * 1.3) * 0.5;
        float skirtWeight = smoothstep(0.08, 0.75, silkV);

        // Real 3D vertex accordion flutes + delicate organic petal tip curl!
        transformed.xz += radDir * (finePleatWave * 0.0028 + organicPetalVar * 0.0075 * uSilkBloom) * skirtWeight;
        transformed.y  += organicPetalVar * 0.0065 * skirtWeight * uSilkBloom;

        // 2. Head-On Shot 7 Botanical Lotus Tier Expansion & Intricate Ruffled Stamen Rosette!
        // Expands Tiers 2..5 radially in head-on mode into lush overlapping scalloped lotus petals, and curls
        // Tier 4 & Tier 5 into an open golden stamen rosette with closed central lotus carpel (zero dark center hole!)
        // (model v2 has its own flounces, pointed tips and tier spread: the two shader reshapes below and
        // the hem frill are switched off; kept in the source in case an older model is loaded again)
        if (false && uHeadOnMode > 0.5 && uTierIndex > 0.5) {
          float tierScale = 1.0;
          if (uTierIndex < 1.5) tierScale = mix(0.65, 1.38, silkV);
          else if (uTierIndex < 2.5) tierScale = mix(0.60, 1.62, silkV);
          else if (uTierIndex < 3.5) tierScale = mix(0.45, 2.35, silkV);
          else tierScale = mix(0.18, 2.55, silkV);

          float lobeFlute = cos(uv.x * 9.0 * 6.2831853) * 0.08 + sin(uv.x * 27.0 * 6.2831853 + uTierIndex * 2.1) * 0.11 * step(2.5, uTierIndex);
          transformed.xz *= mix(1.0, tierScale + lobeFlute * silkV, uSilkBloom);
          transformed.y -= step(2.5, uTierIndex) * uSilkBloom * silkV * (0.055 + 0.025 * (uTierIndex - 3.0));
        } else if (false && uTierIndex > 2.5) {
          float innerDrape = uSilkBloom * silkV;
          transformed.y -= innerDrape * (0.046 + 0.022 * (uTierIndex - 3.0));
          transformed.xz *= 1.0 + innerDrape * 0.24;
        }

        // a light, uneven frill along each hem
        float hemW = smoothstep(0.80, 1.0, silkV);
        float frill = sin(uv.x * 27.0 * 6.2831853 + uTierIndex * 2.3 + 1.7 * sin(uv.x * 7.0 * 6.2831853));
        transformed.y += frill * 0.0 * hemW;

        vBulbView = (modelViewMatrix * vec4(0.0, -0.115, 0.0, 1.0)).xyz;
        vSilkLocalPos = transformed;
        vSilkUv = vec2(uv.x, silkV);
        vSilkAo = mix(_silk_ao.x, _silk_ao.y, uSilkBloom);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uSilkBloom;
        uniform float uSilkGlowScale;
        uniform float uPresenceFade;
        uniform float uHeadOnMode;
        uniform float uTierWarmth;
        uniform float uTierIndex;
        // woven linen scan: tangent-space normal, and (height, opacity, ao) packed in one image
        uniform sampler2D uWeaveNormal;
        uniform sampler2D uWeavePack;
        varying vec3 vSilkLocalPos;
        varying vec2 vSilkUv;
        varying float vSilkAo;
        varying vec3 vBulbView;
        // The cloth is cut as a circle: u runs once round the skirt, v from crown to hem. Repeats are chosen
        // so the threads come out roughly square on the open skirt; each tier is shifted so seams do not line up.
        vec2 skWeaveUv(vec2 uv, float tier) {
          return uv * vec2(2.7, 0.6) + vec2(tier * 0.37, tier * 0.61);
        }

        float skHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float skNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(skHash(i), skHash(i + vec2(1.0, 0.0)), f.x), mix(skHash(i + vec2(0.0, 1.0)), skHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        // Fine irregular creases running from crown to hem (the cloth is crinkled, not fluted).
        float skCrease(vec2 uv, float tier) {
          float a = skNoise(vec2(uv.x * 96.0 + tier * 13.0, uv.y * 3.2));
          float b = skNoise(vec2(uv.x * 210.0 - tier * 7.0, uv.y * 7.0 + 3.1));
          return a * 0.65 + b * 0.35;
        }
        // How many of the tiers inside this one lie between the lamp and this point of the cloth.
        // Every tier is a shorter skirt than the one outside it, with a scalloped hem (nine lobes, each
        // tier turned a little against the next), so the count changes along petal-shaped edges.
        // Model v2 (numbers from shylight_three_clips.json, "tiers"): each tier is close to a cone hanging
        // from its crown, opening from a few degrees (bud) to 55/44/36/30/24 degrees (full bloom). A ray from
        // the lamp to this point of cloth passes through an inner tier if it meets that cone before the
        // tier's hem; the hem is nine pointed petals, each tier turned against the next.
        float skLayersInside(vec3 p, float tier) {
          const vec3 lamp = vec3(0.0, -0.115, 0.0);
          float rP = length(p.xz);
          float dd = lamp.y - p.y;                       // how far below the lamp this point hangs
          float az = atan(-p.z, p.x) / 6.2831853;        // turns, same sense as the model file
          float n = 0.0;
          for (int j = 1; j < 5; j++) {
            float fj = float(j);
            if (fj <= tier + 0.5) continue;
            float crown   = j == 1 ? 0.036 : j == 2 ? 0.066 : j == 3 ? 0.090 : 0.106;
            float aOpen   = j == 1 ? 0.768 : j == 2 ? 0.628 : j == 3 ? 0.524 : 0.419;
            float aShut   = j == 1 ? 0.096 : j == 2 ? 0.087 : j == 3 ? 0.079 : 0.070;
            float lenTip  = j == 1 ? 0.408 : j == 2 ? 0.372 : j == 3 ? 0.330 : 0.275;
            float lenCleft= j == 1 ? 0.262 : j == 2 ? 0.235 : j == 3 ? 0.243 : 0.246;
            float tipTurn = j == 1 ? 0.0556 : j == 2 ? 0.0208 : j == 3 ? 0.0764 : 0.0347;
            float ogB     = j == 1 ? 0.36 : j == 2 ? 0.36 : j == 3 ? 0.55 : 0.80;
            float alpha = mix(aShut, aOpen, uSilkBloom);
            float ta = tan(alpha);
            float h = -lamp.y - crown;                   // lamp below this tier's crown
            float den = rP - dd * ta;
            if (den <= 1e-4) continue;                   // the ray stays inside this cone: nothing in the way
            float u = h * ta / den;
            float slant = (h + u * dd) / cos(alpha);
            float tt = abs(fract((az - tipTurn) * 9.0 + 0.5) - 0.5) * 2.0;   // 0 at a petal tip, 1 in the cleft
            float len = mix(lenCleft, lenTip, pow(max(1.0 - tt, 0.0), ogB));
            n += (1.0 - smoothstep(len - 0.030, len + 0.012, slant)) * smoothstep(1.0, 0.86, u);
          }
          return n;
        }`
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `// The cloth itself is a cool white; all the warmth comes from the lamp inside (added as emission below).
        // What the scene's own lights add on top is kept small, so the flower is never lit like a solid object.
        vec3 silkAlbedo = vec3(0.150, 0.146, 0.138) * (0.55 + 0.45 * vSilkAo) * uPresenceFade;
        vec4 diffuseColor = vec4( silkAlbedo, opacity * smoothstep(0.0, 0.05, uPresenceFade) );`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        // crease relief: tilt the normal across the creases (along u), plus the weave when seen close
        float crU = fwidth(vSilkUv.x) * 1.5 + 0.0009;
        float creaseSlope = (skCrease(vSilkUv + vec2(crU, 0.0), uTierIndex) - skCrease(vSilkUv - vec2(crU, 0.0), uTierIndex))
                          / (2.0 * crU) * 0.0030 * smoothstep(0.04, 0.22, vSilkUv.y);
        vec3 dPosX = dFdx(vViewPosition);
        vec3 dPosY = dFdy(vViewPosition);
        vec3 tangU = normalize(dPosX * dFdx(vSilkUv.x) + dPosY * dFdy(vSilkUv.x) + vec3(1e-5));
        vec3 tangV = normalize(dPosX * dFdx(vSilkUv.y) + dPosY * dFdy(vSilkUv.y) + vec3(1e-5));
        vec2 weaveUv = skWeaveUv(vSilkUv, uTierIndex);
        vec3 weaveN = texture2D(uWeaveNormal, weaveUv).xyz * 2.0 - 1.0;
        normal = normalize(normal + tangU * (clamp(creaseSlope, -0.55, 0.55) + weaveN.x * 0.55) + tangV * weaveN.y * 0.55);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // ---- Backlit silk ----
        // Light leaves the lamp, meets the cloth at some angle, and comes out the other side scattered.
        // Brightness follows that angle and the distance to the lamp, so folds that lie along the rays go
        // dark (the lines you see in real pleated silk); cloth seen edge-on is darker still, because the
        // eye looks through more of it.
        vec3 fragView = -vViewPosition;
        vec3 toBulb = vBulbView - fragView;
        float dBulb = length(toBulb);
        vec3 Lb = toBulb / max(dBulb, 1e-4);
        vec3 Vn = normalize(vViewPosition);
        float nl = dot(normal, Lb);
        float ndv = clamp(abs(dot(normal, Vn)), 0.0, 1.0);

        // local distance to the lamp (model units), so the look does not change with how big the flower is drawn
        float dLoc = length(vSilkLocalPos - vec3(0.0, -0.115, 0.0));
        float irr = 1.0 / pow(0.012 + dLoc * dLoc, 0.95);

        float incidence = pow(clamp(abs(nl), 0.0, 1.0), 0.75);
        // The inner tiers hang almost along the rays from the lamp, so by angle alone they would be the
        // darkest cloth in the flower. In the real thing they are the brightest: the light bounces between
        // the crowded layers of the heart. The deeper the tier, the less its brightness depends on the angle.
        incidence = mix(incidence, 1.0, 0.17 * uTierIndex);
        // the eye is either on the lamp's side of this piece of cloth (sees it lit) or behind it (sees light through it)
        float sameSide = smoothstep(-0.15, 0.15, nl);
        float through = mix(0.80, 0.62, sameSide);
        float edgeOn = mix(0.34, 1.0, smoothstep(0.02, 0.55, ndv));

        // inner tiers in the way: each takes some light and leaves it warmer
        float layers = skLayersInside(vSilkLocalPos, uTierIndex);
        vec3 perLayer = vec3(0.74, 0.685, 0.60);
        vec3 layerT = pow(perLayer, vec3(layers));

        // creases hold a little shadow; the rolled hem is double cloth, a thin darker line
        float crease = skCrease(vSilkUv, uTierIndex);
        float creaseShade = mix(0.74, 1.06, smoothstep(0.25, 0.75, crease));
        float hemLine = 1.0 - 0.50 * smoothstep(0.952, 0.978, vSilkUv.y) * (1.0 - smoothstep(0.992, 1.0, vSilkUv.y));
        float bakedFold = mix(0.60, 1.0, pow(clamp(vSilkAo, 0.0, 1.0), 1.2));

        // the weave itself: thick threads and slubs hold light back, the gaps between threads let it through.
        // Centred on the scan's averages (height 0.41, opacity 0.94) so that from far away, where the
        // texture blurs to its mean, the flower is exactly as bright as before.
        vec3 weave = texture2D(uWeavePack, weaveUv).rgb;
        float weaveLight = clamp(1.0 - (weave.r - 0.407) * 1.15 + (0.939 - weave.g) * 0.9, 0.35, 1.9) * mix(0.9, 1.0, weave.b / 0.942);

        // Seams: each petal is its own panel, sewn to the next along a line from crown to tip (nine of them),
        // and the skirt is gathered onto a band just under the crown. A seam is double cloth: a thin dark line.
        float seamU = abs(fract(vSilkUv.x * 9.0 + 0.5) - 0.5) / 9.0;
        float seamW = 0.0011 + fwidth(vSilkUv.x) * 0.9;
        float seam = 1.0 - smoothstep(seamW * 0.5, seamW, seamU);
        float bandV = abs(vSilkUv.y - 0.085);
        float bandW = 0.004 + fwidth(vSilkUv.y) * 0.9;
        seam = max(seam, 1.0 - smoothstep(bandW * 0.5, bandW, bandV));
        float seamShade = 1.0 - 0.42 * seam;

        float amount = irr * incidence * through * edgeOn * creaseShade * hemLine * bakedFold * weaveLight * seamShade;
        // warm at the heart where the light is strong, paler toward the rim where only a little arrives
        vec3 lampCol = mix(vec3(1.0, 0.915, 0.79), vec3(1.0, 0.74, 0.43), smoothstep(4.0, 46.0, irr));
        vec3 silkLight = lampCol * layerT * amount * 0.034;
        // a faint scatter inside the cloth so nothing falls to pure black between folds
        // light bounced around inside the flower: the heart glows whatever way the cloth is turned
        silkLight += lampCol * layerT * irr * 0.0085 * (1.0 + 0.5 * uTierIndex) * bakedFold * creaseShade;
        totalEmissiveRadiance += silkLight * uSilkGlowScale * uPresenceFade;`
      );
  };

  return mat;
}

interface BuiltSilkUnit {
  anchor: THREE.Group;
  flowerPivot: THREE.Group;
  rigClone: THREE.Group;
  hubNode: THREE.Object3D | null;
  ledCoreLight: THREE.PointLight;
  silkMeshes: THREE.Mesh[];
  /** Per silk mesh: the two morph targets being blended and their weights (read by its material). */
  morphPairs: Record<string, { value: THREE.Vector4 }>;
  cable: THREE.Mesh;
  cableUniforms: { uGlow: { value: number }; uOpacity: { value: number }; uHubY: { value: number } };
  silkUniforms: {
    uSilkBloom: { value: number };
    uSilkGlowScale: { value: number };
    uPresenceFade: { value: number };
    uHeadOnMode: { value: number };
  };
  baseX: number;
  baseY: number;
  baseZ: number;
  isFinaleGiant: boolean;
  scale: number;
  /** Scale actually used this frame (a shot layout may override the build scale). */
  liveScale: number;
  telemetry: ShylightUnitTelemetry;
}

export function createShylightEnsemble(
  renderer: THREE.WebGLRenderer,
  waterY = 0.0
): ShylightEnsembleHandles {
  const root = new THREE.Group();
  const units: Record<'A' | 'B' | 'C' | 'Giant', BuiltSilkUnit | null> = {
    A: null,
    B: null,
    C: null,
    Giant: null,
  };

  // Calibrated directional & hemisphere silk illumination matching Reference Image 5 (`web_preview/index.html`)
  const hemiSky = new THREE.Color().setRGB(0.28, 0.25, 0.21, THREE.LinearSRGBColorSpace);
  const hemiGround = new THREE.Color().setRGB(0.16, 0.13, 0.09, THREE.LinearSRGBColorSpace);
  // Ambient fill kept low: each shylight's own LED core is the key light; fill only keeps the silk from going void.
  const silkHemiLight = new THREE.HemisphereLight(hemiSky, hemiGround, 0.15 * Math.PI);
  root.add(silkHemiLight);

  const silkWarmUplight = new THREE.DirectionalLight(
    new THREE.Color().setRGB(1.0, 0.90, 0.76, THREE.LinearSRGBColorSpace),
    0.58
  );
  silkWarmUplight.position.set(2.9, -1.3, 1.9);
  root.add(silkWarmUplight);

  const silkFillUplight = new THREE.DirectionalLight(
    new THREE.Color().setRGB(0.92, 0.87, 0.79, THREE.LinearSRGBColorSpace),
    0.12
  );
  silkFillUplight.position.set(-2.6, -0.6, 1.6);
  root.add(silkFillUplight);

  const silkMistRimLight = new THREE.DirectionalLight(
    new THREE.Color().setRGB(0.68, 0.80, 0.92, THREE.LinearSRGBColorSpace),
    0.14
  );
  silkMistRimLight.position.set(-3.6, 3.5, 0.8);
  root.add(silkMistRimLight);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envTex = pmrem.fromScene(roomEnv, 0.04).texture;
  roomEnv.dispose();
  pmrem.dispose();

  const defaultTel = (): ShylightUnitTelemetry => ({
    open: 0,
    canopyWorldY: 4.5,
    distToWaterMeters: 4.5,
    glow: 0,
    worldX: 0,
    worldZ: 0,
  });

  // gathered crown cap (see buildPureFlowerUnit): a lathe with shallow pleats, mapped to the very top of
  // the silk's own UV range so the silk shader treats it as cloth next to the lamp
  const crownGeo = (() => {
    const prof: [number, number][] = [[0.004, 0.118], [0.009, 0.090], [0.020, 0.058], [0.040, 0.030], [0.061, 0.009], [0.074, -0.010], [0.079, -0.026]];
    const SEG = 72;
    const pos: number[] = [];
    const uvs: number[] = [];
    const ao: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < prof.length; i++) {
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        const grow = i / (prof.length - 1);
        const r = prof[i][0] * (1 + 0.07 * grow * Math.cos(a * 18));
        pos.push(Math.cos(a) * r, prof[i][1], Math.sin(a) * r);
        uvs.push(k / SEG, 1 - 0.05 * grow);
        ao.push(0.82, 0.86);
      }
    }
    for (let i = 0; i < prof.length - 1; i++) {
      for (let k = 0; k < SEG; k++) {
        const a = i * (SEG + 1) + k;
        const b = a + SEG + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('_silk_ao', new THREE.Float32BufferAttribute(ao, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  })();

  // unit cylinder standing on its base (y from 0 to 1), scaled per frame into the cable
  const cableGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  cableGeo.translate(0, 0.5, 0);

  // Morph-weight curves of the three clips, per silk mesh name. Poses are read straight from these
  // (no mixer): the choreographer says which clip and what time, and the weights are written as they are.
  const clipCurves: { duration: number; byMesh: Record<string, THREE.Interpolant> }[] = [];

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const ready = new Promise<void>((resolve, reject) => {
    loader.load(
      import.meta.env.BASE_URL + 'models/shylight_three_clips_q16_meshopt.glb',
      (gltf) => {
        const srcRoot = gltf.scene;
        for (const name of CLIP_NAMES) {
          const clip = THREE.AnimationClip.findByName(gltf.animations, name);
          if (!clip) throw new Error(`shylight_three_clips.glb: missing clip "${name}"`);
          const byMesh: Record<string, THREE.Interpolant> = {};
          for (const tr of clip.tracks) {
            if (!tr.name.endsWith('.morphTargetInfluences')) continue;
            byMesh[tr.name.split('.')[0]] = (tr as unknown as { createInterpolant: (r?: unknown) => THREE.Interpolant }).createInterpolant(undefined);
          }
          clipCurves.push({ duration: clip.duration, byMesh });
        }

        // 1. Soften `_silk_ao` on inner stamen tiers AND apply Bicubic Catmull-Rom `288x49` Subdivision
        //    to all 5 silk meshes once at load time -> 100% butter-smooth scalloped rims even at 4.6x close-up!
        const lightSilkGeo: Record<string, THREE.BufferGeometry> = {};
        srcRoot.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh && obj.name.startsWith('Silk_')) {
            const mesh = obj as THREE.Mesh;
            if (mesh.name === 'Silk_Tier5_Stamen') {
              const aoAttr = mesh.geometry.attributes._silk_ao as THREE.BufferAttribute | undefined;
              if (aoAttr) {
                for (let i = 0; i < aoAttr.count; i++) {
                  aoAttr.setXY(i, 0.52 + 0.48 * aoAttr.getX(i), 0.56 + 0.44 * aoAttr.getY(i));
                }
                aoAttr.needsUpdate = true;
              }
            } else if (mesh.name === 'Silk_Tier4_InnerRuf') {
              const aoAttr = mesh.geometry.attributes._silk_ao as THREE.BufferAttribute | undefined;
              if (aoAttr) {
                for (let i = 0; i < aoAttr.count; i++) {
                  aoAttr.setXY(i, 0.35 + 0.65 * aoAttr.getX(i), 0.42 + 0.58 * aoAttr.getY(i));
                }
                aoAttr.needsUpdate = true;
              }
            }
            // On a phone the small lamps are subdivided around the rim only (288x25, half the vertices, every
            // one of which carries 60 morph targets through the reflection and the main pass). The rim stays
            // round; only the finale's giant flower, seen close, gets the full 288x49 (kept below).
            if (isMobile) lightSilkGeo[mesh.name] = subdivideSilkGeometryCatmullRom(mesh.geometry, 2, 1);
            mesh.geometry = subdivideSilkGeometryCatmullRom(mesh.geometry);
          }
        });

        const buildPureFlowerUnit = (cfg: {
          x: number;
          y: number;
          z: number;
          scale: number;
          isFinaleGiant?: boolean;
        }): BuiltSilkUnit => {
          const anchor = new THREE.Group();
          anchor.position.set(cfg.x, cfg.y, cfg.z);
          anchor.scale.setScalar(cfg.scale);
          anchor.visible = false;
          root.add(anchor);

          const flowerPivot = new THREE.Group();
          anchor.add(flowerPivot);

          const rigClone = new THREE.Group();
          flowerPivot.add(rigClone);

          const foundHub = srcRoot.getObjectByName('ShylightHub');
          if (foundHub) {
            rigClone.add(foundHub.clone(true));
          }

          const isGiant = Boolean(cfg.isFinaleGiant);
          const silkUniforms = {
            uSilkBloom: { value: 0.0 },
            uSilkGlowScale: { value: 1.0 },
            uPresenceFade: { value: 0.0 },
            uHeadOnMode: { value: isGiant ? 1.0 : 0.0 },
          };
          const morphPairs: Record<string, { value: THREE.Vector4 }> = {};
          const mkPair = (name: string) =>
            (morphPairs[name] = Object.assign({ value: new THREE.Vector4(0, 0, 0, 0) }, { b: { value: new THREE.Vector4(0, 0, 0, 0) } }));
          const tierMats: Record<string, THREE.MeshPhysicalMaterial> = {
            Silk_Tier1_Outer: createZijdarPureSilkMaterial(silkUniforms, 0.04, 0.0, mkPair('Silk_Tier1_Outer')),
            Silk_Tier2_UpperMid: createZijdarPureSilkMaterial(silkUniforms, 0.24, 1.0, mkPair('Silk_Tier2_UpperMid')),
            Silk_Tier3_LowerMid: createZijdarPureSilkMaterial(silkUniforms, 0.48, 2.0, mkPair('Silk_Tier3_LowerMid')),
            Silk_Tier4_InnerRuf: createZijdarPureSilkMaterial(silkUniforms, 0.86, 3.0, mkPair('Silk_Tier4_InnerRuf')),
            Silk_Tier5_Stamen: createZijdarPureSilkMaterial(silkUniforms, 1.00, 4.0, mkPair('Silk_Tier5_Stamen')),
          };
          Object.values(tierMats).forEach((m) => {
            // envMapIntensity is 0, so the map adds nothing to the picture; a phone skips sampling it
            if (!isMobile) m.envMap = envTex;
          });

          // Stagger petal azimuthal angles (+20 deg per tier) like a real botanical lotus / camellia
          // so consecutive scalloped tiers alternate organically instead of aligning in mechanical spokes!
          const tierAzimuthOffsets: Record<string, number> = {
            Silk_Tier1_Outer: 0.0,
            // model v2: the turn of each tier (0, 20, 7.5, 27.5, 12.5 degrees) is already in the meshes
            Silk_Tier2_UpperMid: 0.0,
            Silk_Tier3_LowerMid: 0.0,
            Silk_Tier4_InnerRuf: 0.0,
            Silk_Tier5_Stamen: 0.0,
          };

          let hubNode: THREE.Object3D | null = null;
          const nodesToRemove: THREE.Object3D[] = [];
          const silkMeshes: THREE.Mesh[] = [];

          rigClone.traverse((obj) => {
            if (obj.name === 'ShylightHub') {
              hubNode = obj;
              return;
            }
            if (obj === rigClone) return;

            if ((obj as THREE.Mesh).isMesh && obj.name.startsWith('Silk_')) {
              const mesh = obj as THREE.Mesh;
              if (!isGiant && lightSilkGeo[mesh.name]) mesh.geometry = lightSilkGeo[mesh.name];
              mesh.material = tierMats[mesh.name] ?? tierMats.Silk_Tier1_Outer;
              mesh.rotation.y = tierAzimuthOffsets[mesh.name] ?? 0.0;
              mesh.updateMorphTargets();
              mesh.frustumCulled = false;
              silkMeshes.push(mesh);
            } else if (!obj.children.some((c) => c.name.startsWith('Silk_'))) {
              nodesToRemove.push(obj);
            }
          });

          for (const rem of nodesToRemove) {
            rem.parent?.remove(rem);
          }

          // Crown: where the five tiers are gathered onto the cable. Without it the flower is an open tube
          // at the top and a camera above it looks straight down the hole. A small gathered bell of the
          // same silk closes it; it sits right over the lamp, so it glows.
          if (hubNode) {
            const crown = new THREE.Mesh(
              crownGeo,
              createZijdarPureSilkMaterial(silkUniforms, 0.04, 0.0, mkPair('Crown'))
            );
            crown.frustumCulled = false;
            (hubNode as THREE.Object3D).add(crown);
          }

          const ledCoreLight = new THREE.PointLight(
            new THREE.Color().setRGB(1.0, 0.66, 0.26, THREE.LinearSRGBColorSpace),
            0.0,
            6.5 * cfg.scale,
            1.8
          );
          // The light lives at the top level and is moved to the hub every frame. If it sat inside the unit
          // it would drop out of the scene whenever the unit is hidden; the number of lights would change,
          // and three.js recompiles every lit material when that happens (a visible freeze).
          root.add(ledCoreLight);

          // Suspension cable: a thin thread from the hub up into the dark. It only catches the flower's own
          // light for the first metre or so. (No ring, no ribs.)
          const cableUniforms = { uGlow: { value: 0 }, uOpacity: { value: 0 }, uHubY: { value: 0 } };
          const cable = new THREE.Mesh(
            cableGeo,
            new THREE.ShaderMaterial({
              uniforms: cableUniforms,
              transparent: true,
              depthWrite: false,
              vertexShader: /* glsl */ `
                varying float vWorldY;
                varying vec3 vN;
                varying vec3 vV;
                void main() {
                  vec4 wp = modelMatrix * vec4(position, 1.0);
                  vWorldY = wp.y;
                  vN = normalize(mat3(modelMatrix) * vec3(normal.x, 0.0, normal.z));
                  vV = normalize(cameraPosition - wp.xyz);
                  gl_Position = projectionMatrix * viewMatrix * wp;
                }
              `,
              fragmentShader: /* glsl */ `
                precision highp float;
                varying float vWorldY;
                varying vec3 vN;
                varying vec3 vV;
                uniform float uGlow;
                uniform float uOpacity;
                uniform float uHubY;
                void main() {
                  float h = max(0.0, vWorldY - uHubY);
                  float rimF = max(0.0, 1.0 - abs(dot(normalize(vN), normalize(vV))));
                  float rim = 0.35 + 0.65 * rimF * rimF;
                  vec3 col = vec3(1.0, 0.68, 0.36) * uGlow * 0.16 * exp(-h * 1.5) * rim + vec3(0.0045, 0.0038, 0.0030);
                  gl_FragColor = vec4(col, uOpacity * (1.0 - smoothstep(9.0, 16.0, h)));
                }
              `,
            })
          );
          cable.visible = false;
          cable.frustumCulled = false;
          cable.renderOrder = 2;
          anchor.add(cable);

          return {
            anchor,
            flowerPivot,
            rigClone,
            hubNode,
            ledCoreLight,
            silkMeshes,
            morphPairs,
            cable,
            cableUniforms,
            silkUniforms,
            baseX: cfg.x,
            baseY: cfg.y,
            baseZ: cfg.z,
            isFinaleGiant: isGiant,
            scale: cfg.scale,
            liveScale: cfg.scale,
            telemetry: defaultTel(),
          };
        };

        // Trio B, A, C (Shots 2–4 — exact locked parameters from Milestone 1 & 2!)
        units.B = buildPureFlowerUnit({
          x: 0.0,
          y: 2.74,
          z: 0.85,
          scale: 2.65,
        });
        units.A = buildPureFlowerUnit({
          x: -2.25,
          y: 2.94,
          z: -0.95,
          scale: 2.15,
        });
        units.C = buildPureFlowerUnit({
          x: 2.25,
          y: 2.94,
          z: -0.95,
          scale: 2.15,
        });

        // Shot 7 Cathedral-Scale Colossal Finale Blossom (`scale = 4.65, y = 2.06m`):
        // Rotated `-88.5°` around `+X` so its 288-segment butter-smooth scalloped lotus mandala & intricate
        // honey-gold stamen rosette gaze 100% straight at the viewer while mirroring grandly in the ocean below!
        units.Giant = buildPureFlowerUnit({
          x: 0.0,
          y: 2.06,
          z: 0.38,
          scale: 4.65,
          isFinaleGiant: true,
        });

        resolve();
      },
      undefined,
      (err) => reject(err)
    );
  });

  const tmpWorldPos = new THREE.Vector3();

  function applyPoseToUnit(u: BuiltSilkUnit | null, pose: ShylightUnitPose, time: number) {
    if (!u) return;
    const pres = THREE.MathUtils.clamp(pose.presence, 0, 1);
    if (pres <= 0.002) {
      u.anchor.visible = false;
      u.ledCoreLight.intensity = 0;
      u.telemetry = {
        open: 0,
        canopyWorldY: 4.5,
        distToWaterMeters: 4.5 - waterY,
        glow: 0,
        worldX: u.baseX,
        worldZ: u.baseZ,
      };
      return;
    }

    u.anchor.visible = true;
    const lay = pose.layout;
    const smoothPres = pres * pres * (3 - 2 * pres);
    const mistDriftY = (1.0 - smoothPres) * 0.58;
    const open = THREE.MathUtils.clamp(pose.openAmount, 0, 1);
    // Shot ② hands over a clip and a time that only move forward. Older shots still give a single
    // open amount; it is mapped onto the bloom clip.
    const sample = pose.clip ?? { clip: CLIP_BLOOM, t: open * (clipCurves[CLIP_BLOOM]?.duration ?? 2.333) };
    // the pose being faded out after a change of mind (shot ② / ③ breathing), if any
    const fromS = pose.clip?.from;
    const writePair = (target: THREE.Vector4, clipIdx: number, time: number, meshName: string, scale: number) => {
      const curves = clipCurves[clipIdx];
      const curve = curves?.byMesh[meshName];
      if (!curve) return;
      const tt = Math.max(0, Math.min(curves.duration, time));
      // the clip is linear between neighbouring keys, so at most two targets carry weight
      const w = curve.evaluate(tt) as ArrayLike<number>;
      let i0 = 0, w0 = 0, i1 = 0, w1 = 0;
      for (let k = 0; k < w.length; k++) {
        const v = w[k];
        if (v > w0) { i1 = i0; w1 = w0; i0 = k; w0 = v; }
        else if (v > w1) { i1 = k; w1 = v; }
      }
      target.set(i0, i1, w0 * scale, w1 * scale);
    };
    for (const mesh of u.silkMeshes) {
      const pair = u.morphPairs[mesh.name] as { value: THREE.Vector4; b?: { value: THREE.Vector4 } } | undefined;
      if (!pair) continue;
      const wFrom = fromS ? Math.max(0, Math.min(1, fromS.w)) : 0;
      writePair(pair.value, sample.clip, sample.t, mesh.name, 1 - wFrom);
      if (pair.b) {
        if (fromS && wFrom > 0) writePair(pair.b.value, fromS.clip, fromS.t, mesh.name, wFrom);
        else pair.b.value.set(0, 0, 0, 0);
      }
    }

    if (u.hubNode) {
      u.hubNode.position.set(0, u.isFinaleGiant ? 0.22 : 0.0, 0);
    }

    const unitScale = lay ? lay.scale : u.scale;
    u.anchor.scale.setScalar(unitScale);
    if (lay) {
      // The fall is the hub's own fall from the bake, rescaled to this shot's height.
      u.anchor.position.set(lay.x, lay.topY + mistDriftY - lay.drop01 * lay.dropMeters, lay.z);
    } else {
      const exhaleDescent = u.isFinaleGiant ? 0.0 : -0.26 * open;
      u.anchor.position.set(
        u.baseX,
        u.baseY + mistDriftY + exhaleDescent + pose.bobOffsetMeters * smoothPres,
        u.baseZ
      );
    }

    const cableAmt = (pose.cable ?? 0) * smoothPres;
    u.cable.visible = cableAmt > 0.003;
    if (u.cable.visible) {
      const rWorld = 0.0042;
      u.cable.scale.set(rWorld / unitScale, 40.0 / unitScale, rWorld / unitScale);
      u.cableUniforms.uOpacity.value = cableAmt;
      u.cableUniforms.uHubY.value = u.anchor.position.y;
    }

    if (u.isFinaleGiant) {
      // At coda wind-down (open small), tilt gracefully (-52 deg -> -88.5 deg) so in m4_04 (280s)
      // the viewer sees the supple elongated champagne-silk lotus bud in 3/4 profile rather than an axial star!
      const tiltToFaceCamera = -Math.PI * THREE.MathUtils.lerp(0.28, 0.492, smoothstepLocal(0.18, 0.55, open));
      u.flowerPivot.rotation.set(
        tiltToFaceCamera,
        0.0,
        Math.sin(time * 0.24) * 0.035
      );
      u.rigClone.scale.set(1.0, 1.0, 1.0);
      u.rigClone.rotation.set(0, pose.spinRad ?? 0, 0);
    } else {
      const slenderAspectY = THREE.MathUtils.lerp(1.22, 1.08, open);
      u.rigClone.scale.set(1.0, slenderAspectY, 1.0);
      const gentlePeekTilt = -0.04 - 0.18 * open;
      const swayZ = Math.sin(time * 0.55 + u.baseX) * 0.025 * smoothPres;
      u.flowerPivot.rotation.set(gentlePeekTilt, pose.spinRad ?? 0, swayZ);
      u.rigClone.rotation.set(0, 0, 0);
    }

    const glow = Math.max(0, pose.glowIntensity) * smoothPres;
    u.silkUniforms.uSilkBloom.value = open;
    u.silkUniforms.uSilkGlowScale.value = (u.isFinaleGiant ? 0.92 + 0.40 * open : 0.86 + 0.40 * open) * glow;
    u.silkUniforms.uPresenceFade.value = smoothPres;

    u.ledCoreLight.intensity = (u.isFinaleGiant ? 1.10 + 1.40 * open : 0.48 + 0.78 * open) * glow;
    u.cableUniforms.uGlow.value = glow * (0.4 + 0.6 * open);

    u.anchor.updateMatrixWorld(true);
    if (u.hubNode) {
      u.hubNode.getWorldPosition(tmpWorldPos);
    } else {
      u.anchor.getWorldPosition(tmpWorldPos);
    }
    u.ledCoreLight.position.set(0, -0.145, 0);
    (u.hubNode ?? u.anchor).localToWorld(u.ledCoreLight.position);
    const skirtTipY = u.isFinaleGiant
      ? tmpWorldPos.y - 0.38 * unitScale
      : tmpWorldPos.y - 0.42 * unitScale;
    const distWater = Math.max(0.18, skirtTipY - waterY);

    u.telemetry = {
      open: Number(open.toFixed(3)),
      canopyWorldY: Number(skirtTipY.toFixed(3)),
      distToWaterMeters: Number(distWater.toFixed(3)),
      glow: Number(glow.toFixed(3)),
      worldX: Number((lay ? lay.x : u.baseX).toFixed(2)),
      worldZ: Number((lay ? lay.z : u.baseZ).toFixed(2)),
    };
    u.liveScale = unitScale;
  }

  function update(state: ShylightEnsembleState, _dt: number) {
    const cb = state.causticBounce ?? 0;
    const pulse = 0.85 + 0.15 * Math.sin(state.time * 2.35);
    // Shot ②: the flower is the key. External fill drops to a trace so the silk reads bright inside,
    // dark outside, and the cool rim (a second hue) is removed.
    const self = THREE.MathUtils.clamp(state.selfLit ?? 0, 0, 1);
    silkHemiLight.intensity = 0.15 * Math.PI * (1.0 - 0.93 * self);
    silkWarmUplight.intensity = (0.58 + cb * 0.22 * pulse) * (1.0 - 0.95 * self);
    silkFillUplight.intensity = (0.22 + cb * 0.12 * pulse) * (1.0 - 0.95 * self);
    silkMistRimLight.intensity = 0.14 * (1.0 - self);
    {
      const sil = 1.0 - 0.93 * THREE.MathUtils.clamp(state.silhouette ?? 0, 0, 1);
      silkHemiLight.intensity *= sil;
      silkWarmUplight.intensity *= sil;
      silkFillUplight.intensity *= sil;
      silkMistRimLight.intensity *= sil;
    }

    applyPoseToUnit(units.A, state.unitA, state.time);
    applyPoseToUnit(units.B, state.unitB, state.time);
    applyPoseToUnit(units.C, state.unitC, state.time);
    applyPoseToUnit(units.Giant, state.unitGiant, state.time);
  }

  function getTelemetry() {
    return {
      A: units.A?.telemetry ?? defaultTel(),
      B: units.B?.telemetry ?? defaultTel(),
      C: units.C?.telemetry ?? defaultTel(),
      Giant: units.Giant?.telemetry ?? defaultTel(),
    };
  }

  function getLightSources(): { pos: THREE.Vector3; glow: number }[] {
    const out: { pos: THREE.Vector3; glow: number }[] = [];
    for (const key of ['B', 'A', 'C', 'Giant'] as const) {
      const u = units[key];
      if (u && u.anchor.visible && u.telemetry.glow > 0.01) {
        const p = new THREE.Vector3();
        if (u.hubNode) {
          u.hubNode.getWorldPosition(p);
          if (!u.isFinaleGiant) p.y -= 0.18 * u.liveScale;
        } else {
          u.anchor.getWorldPosition(p);
        }
        out.push({ pos: p, glow: u.telemetry.glow * (0.45 + 0.55 * u.telemetry.open) });
      }
    }
    return out;
  }

  return {
    root,
    ready,
    update,
    getTelemetry,
    getLightSources,
  };
}

function smoothstepLocal(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
