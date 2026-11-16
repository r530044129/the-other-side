import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * The drum strike's crown splash, baked in Blender (Mantaflow FLIP, see public/baked/splash/splash_manifest.json).
 * Each GLB holds 40 frame meshes (topology changes every frame, so frames are swapped, not morphed).
 * Units: y up, still water at y = 0, impact at the origin, crown rim radius 1.0 at the peak frame.
 *
 * Shading is done here rather than with three's transmission (which would render the scene once more):
 * the water behind is read from the refraction image the water pass has already drawn, bent by the normal,
 * plus a Fresnel reflection of the warm stage light and a thin backlit rim, as in a photographed splash.
 */

export interface BakedSplashState {
  /** Seconds since the last strike (large when none). */
  strikeAge: number;
  /** World position of the strike on the water. */
  strikePos?: [number, number, number];
  /** Height of the water surface there. */
  waterY: number;
  /** 0..1: whether splashes belong in this part of the piece. */
  presence: number;
  /** Screen-space image of what lies behind the water (rendered without the splash). */
  refraction: THREE.Texture | null;
  blackout: number;
}

interface Variant {
  frames: THREE.BufferGeometry[];
  fps: number;
}

const WORLD_SCALE = 0.85; // crown radius in metres at its peak
const PLAY_RATE = 1.0; // 1 = the slow-motion speed the bake was made for (40 frames at 24 fps = 1.67 s)

export function createBakedSplash() {
  const group = new THREE.Group();
  group.name = 'bakedSplash';
  group.visible = false;

  const uniforms = {
    tRefraction: { value: null as THREE.Texture | null },
    uKey: { value: new THREE.Vector3(1.0, 0.72, 0.38) },
    uFade: { value: 1.0 },
    uBlackout: { value: 0.0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vW;
      varying vec4 vClip;
      varying float vH;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vH = position.y;
        vClip = projectionMatrix * viewMatrix * wp;
        gl_Position = vClip;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tRefraction;
      uniform vec3 uKey;
      uniform float uFade;
      uniform float uBlackout;
      varying vec3 vN;
      varying vec3 vW;
      varying vec4 vClip;
      varying float vH;
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        vec3 N = normalize(vN);
        if (dot(N, V) < 0.0) N = -N;
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

        // what lies behind, bent by the water (thin sheets bend little, edge-on ones a lot)
        vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
        vec2 bend = N.xy * (0.035 + 0.06 * (1.0 - ndv));
        vec3 behind = texture2D(tRefraction, clamp(suv - bend, 0.002, 0.998)).rgb;
        behind *= vec3(0.82, 0.92, 0.95);

        // The stage light sits behind the splash: it shows as a bright rim wherever the water is
        // seen edge-on, and as glints on the curved fingers and droplets.
        vec3 L = normalize(vec3(0.0, 0.55, -1.0));
        float back = pow(clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0), 2.0);
        float rim = pow(1.0 - ndv, 3.0) * (0.35 + 0.65 * back);
        vec3 H = normalize(L + V);
        float spec = pow(max(dot(N, H), 0.0), 90.0);
        float through = pow(max(dot(-N, L), 0.0), 4.0) * (1.0 - fres);

        vec3 col = behind * (1.0 - fres)
                 + uKey * (rim * 1.25 + spec * 2.6 + through * 0.35)
                 + uKey * fres * 0.12;
        // the very foot of the sheet melts into the water it rises from (the cut at y = 0 is hidden)
        float foot = smoothstep(0.0, 0.05, vH);
        // clear water: seen face-on it is mostly the stage behind, bent; only its edges and glints are lit
        float a = foot * uFade * (0.28 + 0.72 * max(fres, min(1.0, rim + spec)));
        gl_FragColor = vec4(col * (1.0 - uBlackout), a);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.frustumCulled = false;
  group.add(mesh);

  const variants: Variant[] = [];
  let lastStrikeAge = 1e9;
  let current = 0;

  const ready = (async () => {
    try {
      const man = await (await fetch(import.meta.env.BASE_URL + 'baked/splash/splash_manifest.json')).json();
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      for (const v of man.variants as { file: string; fps: number }[]) {
        const gltf = await loader.loadAsync(import.meta.env.BASE_URL + 'baked/splash/' + v.file);
        const byName: Record<string, THREE.BufferGeometry> = {};
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) byName[m.name || m.parent?.name || ''] = m.geometry;
        });
        const names = Object.keys(byName).sort();
        variants.push({ frames: names.map((n) => byName[n]), fps: v.fps || 24 });
      }
    } catch (e) {
      console.warn('[splash] baked splash not loaded', e);
    }
  })();

  function update(state: BakedSplashState) {
    const age = state.strikeAge;
    if (!variants.length || state.presence < 0.01 || !state.strikePos || age < 0) {
      group.visible = false;
      lastStrikeAge = age;
      return;
    }
    // a new strike: alternate the two takes so consecutive hits are not identical
    if (age < lastStrikeAge - 0.05) current = (current + 1) % variants.length;
    lastStrikeAge = age;

    const v = variants[current];
    const f = Math.floor(age * v.fps * PLAY_RATE) + 2; // frames 0-1 hold the falling drop: start at the impact
    if (f >= v.frames.length) {
      group.visible = false;
      return;
    }
    mesh.geometry = v.frames[f];
    group.visible = true;
    group.position.set(state.strikePos[0], state.waterY - 0.012, state.strikePos[2]);
    group.scale.setScalar(WORLD_SCALE);
    const tail = (v.frames.length - f) / 8;
    uniforms.uFade.value = Math.min(1, tail) * state.presence;
    uniforms.tRefraction.value = state.refraction;
    uniforms.uBlackout.value = state.blackout;
  }

  return { group, update, ready };
}
