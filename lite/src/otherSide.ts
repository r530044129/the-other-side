import * as THREE from 'three';
import { StoryState } from './story';
import { S2_FLOWERS } from './shot2';

/**
 * The other side: things that only exist because the reflection is its own world.
 * - Liquid light show across the sky (oil-projector look, same family as the opening oil title)
 * - Three points of light the oil gathers into, which rise and become the flowers
 * - Ink that falls upward on the gravity flip
 * - The last point of light
 */
export interface OtherSideHandles {
  group: THREE.Group;
  update: (story: StoryState, time: number, blackout: number) => void;
}

// where the three points of light end up: the closed buds of shot ② (B, A, C)
const FLOWER_POS: [number, number, number][] = [
  [S2_FLOWERS.B.x, S2_FLOWERS.B.topY - 0.35, S2_FLOWERS.B.z],
  [S2_FLOWERS.A.x, S2_FLOWERS.A.topY - 0.35, S2_FLOWERS.A.z],
  [S2_FLOWERS.C.x, S2_FLOWERS.C.topY - 0.35, S2_FLOWERS.C.z],
];
const ORB_START: [number, number, number][] = [
  [0.0, 0.07, 0.75],
  [-1.85, 0.07, 0.95],
  [1.85, 0.07, 0.95],
];

function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,240,215,0.85)');
  grd.addColorStop(0.35, 'rgba(255,190,120,0.22)');
  grd.addColorStop(0.7, 'rgba(255,150,80,0.05)');
  grd.addColorStop(1.0, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createOtherSide(): OtherSideHandles {
  const group = new THREE.Group();

  // ------------------------------------------------------------------ liquid light sky
  const skyUniforms = {
    uShow: { value: 0 },
    uFront: { value: 0 },
    uFlow: { value: 0 },
    uSwirl: { value: 0 },
    uHue: { value: 0 },
    uGain: { value: 1 },
    uKaleido: { value: 0 },
    uKaleidoSeed: { value: 0 },
    uJulia: { value: 0 },
    uJuliaC: { value: new THREE.Vector2(-0.8, 0.156) },
    uPulses: { value: [new THREE.Vector4(0, 0, 99, 0), new THREE.Vector4(0, 0, 99, 0), new THREE.Vector4(0, 0, 99, 0)] },
    uBlackout: { value: 0 },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform float uShow;
      uniform float uFront;
      uniform float uFlow;
      uniform float uSwirl;
      uniform float uHue;
      uniform float uGain;
      uniform float uKaleido;
      uniform float uKaleidoSeed;
      uniform vec4 uPulses[3];
      uniform float uBlackout;
      uniform float uJulia;
      uniform vec2 uJuliaC;

      mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

      // Oil-in-a-dish field: repeated domain warping gives fat slow cells with thin bright rims.
      vec3 oilField(vec2 p, float tt) {
        vec2 q = p;
        float a = 1.0;
        for (int i = 0; i < 5; i++) {
          float fi = float(i);
          q += (0.62 / a) * sin(q.yx * (0.9 + 0.35 * fi) * a * 0.62 + vec2(tt * (0.9 - 0.13 * fi), -tt * (0.7 + 0.11 * fi)) + fi * 1.7);
          q = rot(0.55 + 0.07 * fi) * q;
          a *= 1.32;
        }
        float cellA = sin(q.x * 1.25 + 0.6 * sin(q.y * 0.9 + tt * 0.4));
        float cellB = cos(q.y * 1.4 - 0.5 * sin(q.x * 1.1 - tt * 0.3));
        float f = cellA * cellB;
        float thick = 0.5 + 0.5 * sin(q.x * 0.8 + q.y * 0.6 + f * 2.2);
        return vec3(f, thick, length(q - p));
      }

      vec3 palette(float x) {
        // amber -> rose -> deep teal -> pearl, never the full rainbow
        vec3 amber = vec3(1.00, 0.42, 0.06);
        vec3 rose = vec3(0.86, 0.10, 0.26);
        vec3 teal = vec3(0.00, 0.46, 0.56);
        vec3 pearl = vec3(1.00, 0.70, 0.36);
        float k = fract(x) * 4.0;
        vec3 c = mix(amber, rose, smoothstep(0.0, 1.0, k));
        c = mix(c, teal, smoothstep(1.0, 2.0, k));
        c = mix(c, pearl, smoothstep(2.0, 3.0, k));
        c = mix(c, amber, smoothstep(3.0, 4.0, k));
        return c;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float elev = dir.y;
        float azim = atan(dir.x, -dir.z);
        // Only the half of the dome the camera faces; mapped like a huge curved projection wall.
        vec2 p = vec2(azim * 1.55, elev * 2.6);

        // Breath rings pushed into the light by the player's flower
        float ringGlow = 0.0;
        for (int i = 0; i < 3; i++) {
          vec4 pl = uPulses[i];
          if (pl.w <= 0.001 || pl.z > 9.0) continue;
          vec2 d = (p - pl.xy * vec2(1.55, 2.6) * vec2(1.0, 0.5)) * vec2(1.0, 1.25);
          float r = length(d) + 1e-4;
          float R = 0.08 + pl.z * 0.34;
          float w = 0.10 + pl.z * 0.035;
          float env = exp(-pl.z * 0.42) * smoothstep(0.0, 0.25, pl.z) * pl.w;
          float band = exp(-((r - R) / w) * ((r - R) / w));
          p += (d / r) * band * env * 0.34;
          ringGlow += band * env;
        }

        // Kaleidoscope patch
        vec2 kc = vec2((uKaleidoSeed - 0.5) * 1.5, 0.75 + 0.5 * fract(uKaleidoSeed * 7.31));
        vec2 kd = p - kc;
        float kr = length(kd);
        float kMask = (1.0 - smoothstep(0.50, 0.56, kr)) * uKaleido;
        if (kMask > 0.001) {
          float seg = 3.14159265 / (4.0 + floor(fract(uKaleidoSeed * 3.7) * 3.0));
          float ka = atan(kd.y, kd.x) + uFlow * 0.05;
          ka = abs(mod(ka, 2.0 * seg) - seg);
          vec2 kp = kc + kr * vec2(cos(ka), sin(ka)) * 1.6;
          p = mix(p, kp, kMask);
        }

        p = rot(uSwirl * 0.35 * exp(-dot(p - vec2(0.0, 0.9), p - vec2(0.0, 0.9)) * 0.35)) * (p - vec2(0.0, 0.9)) + vec2(0.0, 0.9);

        // Julia set as the thickness of the film: the oil no longer drifts at random but settles along
        // the filaments of a fractal that the bass keeps reshaping (the constant c turns with the low end).
        // Smooth iteration count and an orbit trap give soft bands; nothing here has a hard edge.
        float jBand = 0.0;
        float jTrap = 0.0;
        if (uJulia > 0.002) {
          // centred where the camera looks during the middle of the shot, large enough to fill the frame
          vec2 z = rot(0.35) * ((p - vec2(0.0, 1.45)) * vec2(0.50, 0.66));
          float m = 26.0;
          float trap = 10.0;
          for (int i = 0; i < 26; i++) {
            z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + uJuliaC;
            float d2 = dot(z, z);
            trap = min(trap, d2);
            if (d2 > 64.0) {
              m = float(i) - log2(log2(d2)) + 2.585;
              break;
            }
          }
          jBand = clamp(m / 26.0, 0.0, 1.0);
          jTrap = sqrt(trap);
          // the oil cells are dragged along the fractal's contours
          float ja = 6.2832 * (jBand * 2.0 + jTrap * 0.6);
          p += uJulia * 0.30 * vec2(cos(ja), sin(ja)) * (0.35 + 0.65 * jBand);
        }

        vec3 o = oilField(p * 1.05 + vec2(0.0, -uFlow * 0.10), uFlow);
        float f = o.x;
        float blob = smoothstep(0.10, 0.62, abs(f));
        float rim = smoothstep(0.16, 0.02, abs(abs(f) - 0.22));
        float hueCoord = 0.10 + 0.22 * o.y + 0.16 * sign(f) + 0.055 * o.z + uHue * 0.75 + uJulia * (0.85 * jBand + 0.30 * jTrap);
        vec3 col = palette(hueCoord) * blob * (0.16 + 0.84 * o.y * o.y);
        col += palette(hueCoord + 0.33) * rim * 0.34;
        // thin-film shimmer inside the thick cells
        col *= 0.72 + 0.46 * sin(o.z * 13.0 + f * 17.0);
        // dark gaps stay truly dark
        col *= smoothstep(0.0, 0.30, abs(f) - 0.07);
        // interference bands hugging the fractal: bright filaments where the film thins toward the set
        if (uJulia > 0.002) {
          float bands = 0.5 + 0.5 * sin(jBand * 34.0 - uFlow * 0.9 + jTrap * 5.0);
          vec3 filmCol = palette(0.15 + jBand * 1.7 + jTrap * 0.4 + uHue * 0.75);
          col = mix(col, col * (0.35 + 1.15 * bands) + filmCol * bands * bands * 0.30 * smoothstep(0.02, 0.5, jBand), uJulia);
        }
        col += vec3(1.0, 0.92, 0.80) * ringGlow * 0.22;
        col = mix(col, col * 1.5 + vec3(0.05, 0.04, 0.03), kMask * 0.6);

        // Rising reveal front: the ink that flew up spreads into the sky from the horizon
        float h = elev * 2.6;
        float wob = 0.12 * sin(azim * 5.0 + uFlow * 1.2) + 0.06 * sin(azim * 11.0 - uFlow * 2.0);
        float rev = 1.0 - smoothstep(uFront - 0.38, uFront, h + wob);
        float lead = exp(-((h + wob - uFront + 0.10) / 0.10) * ((h + wob - uFront + 0.10) / 0.10)) * step(uFront, 2.9);
        col = col * rev + vec3(0.25, 0.85, 0.95) * lead * 0.55;

        float horizonFade = smoothstep(0.015, 0.20, elev);
        float sideFade = 1.0 - smoothstep(1.35, 2.3, abs(azim));
        float topFade = 1.0 - 0.45 * smoothstep(0.55, 1.0, elev);
        col *= horizonFade * sideFade * topFade * uShow * uGain * 0.50 * (1.0 - uBlackout);
        gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(47, 48, 32), skyMat);
  sky.renderOrder = -18;
  sky.frustumCulled = false;
  group.add(sky);

  // ------------------------------------------------------------------ light orbs + last point
  const glowTex = makeGlowTexture();
  const orbs: THREE.Sprite[] = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.SpriteMaterial({
      map: glowTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      color: new THREE.Color(1.0, 0.86, 0.62),
    });
    const sp = new THREE.Sprite(m);
    sp.visible = false;
    sp.renderOrder = 6;
    group.add(sp);
    orbs.push(sp);
  }

  // ------------------------------------------------------------------ ink that falls upward
  const RISE_COUNT = 1800;
  const seeds = new Float32Array(RISE_COUNT * 4);
  const origins = new Float32Array(RISE_COUNT * 3);
  const spots: [number, number][] = [[0.0, 0.75], [-2.25, -0.95], [2.25, -0.95]];
  let s = 1234.5;
  const rnd = () => {
    s = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < RISE_COUNT; i++) {
    const inFlower = i < RISE_COUNT * 0.72;
    const sp = spots[i % 3];
    const ang = rnd() * Math.PI * 2;
    const rad = inFlower ? Math.pow(rnd(), 0.7) * 0.85 : 0;
    origins[i * 3] = inFlower ? sp[0] + Math.cos(ang) * rad : (rnd() - 0.5) * 9.0;
    origins[i * 3 + 1] = inFlower ? -0.15 - rnd() * 1.1 : -0.1 - rnd() * 0.6;
    origins[i * 3 + 2] = inFlower ? sp[1] + Math.sin(ang) * rad : -2.5 + rnd() * 5.5;
    seeds[i * 4] = rnd();
    seeds[i * 4 + 1] = rnd();
    seeds[i * 4 + 2] = rnd();
    seeds[i * 4 + 3] = inFlower ? 1 : 0;
  }
  const riseGeo = new THREE.BufferGeometry();
  riseGeo.setAttribute('position', new THREE.BufferAttribute(origins, 3));
  riseGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const riseUniforms = { uAge: { value: -1 }, uGain: { value: 0 }, uPx: { value: 1 } };
  const riseMat = new THREE.ShaderMaterial({
    uniforms: riseUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uAge;
      uniform float uPx;
      varying float vLife;
      varying float vHue;
      varying float vBright;
      varying float vLen;
      void main() {
        float delay = aSeed.x * 0.9 * (1.0 - 0.5 * aSeed.w);
        float a = max(0.0, uAge - delay);
        vec3 p = position;
        float v0 = 1.6 + aSeed.y * 2.4;
        float rise = v0 * a + 0.75 * a * a;
        // strands curl and fan out as they climb, like ink in water played backwards
        float curl = a * (0.6 + aSeed.z);
        p.x += sin(curl * 2.1 + aSeed.x * 40.0) * 0.16 * a + (position.x) * 0.14 * a * a * 0.25;
        p.z += cos(curl * 1.7 + aSeed.y * 31.0) * 0.16 * a - 0.35 * a * a * 0.3;
        p.y += rise;
        vLife = smoothstep(0.0, 0.12, a) * (1.0 - smoothstep(9.0, 15.0, p.y));
        vHue = clamp(p.y / 9.0, 0.0, 1.0);
        // most threads are faint; a few carry the light (no uniform swarm)
        vBright = 0.10 + 0.90 * pow(aSeed.z, 4.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // a thread, not a ball: its length is the distance it travels in a twelfth of a second
        float speed = v0 + 1.5 * a;
        float len = clamp(speed * 0.085, 0.10, 0.75) * (0.6 + 0.8 * aSeed.y);
        vLen = len;
        gl_PointSize = clamp(len * uPx / max(0.6, -mv.z), 3.0, 120.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uGain;
      varying float vLife;
      varying float vHue;
      varying float vBright;
      varying float vLen;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        // a hair-thin vertical streak, tapering to nothing behind a small bright head
        float w = 0.012 / max(vLen, 0.1);
        float along = clamp(0.5 - d.y, 0.0, 1.0);            // 0 at the tail (bottom), 1 at the head (top)
        float taper = smoothstep(0.0, 0.85, along) * smoothstep(1.0, 0.94, along);
        float body = exp(-(d.x * d.x) / (w * w)) * taper * taper;
        float head = exp(-(d.x * d.x + (d.y + 0.44) * (d.y + 0.44) * 0.25) / (w * w * 2.4));
        vec3 ink = mix(vec3(0.16, 0.52, 0.62), vec3(1.0, 0.62, 0.26), smoothstep(0.2, 0.9, vHue));
        vec3 col = ink * body * 0.42 + mix(ink, vec3(1.0, 0.86, 0.66), 0.4) * head * 0.9;
        gl_FragColor = vec4(col * vLife * vBright * uGain, 1.0);
      }
    `,
  });
  const risePoints = new THREE.Points(riseGeo, riseMat);
  risePoints.frustumCulled = false;
  risePoints.renderOrder = 5;
  risePoints.visible = false;
  group.add(risePoints);

  const tmp = new THREE.Vector3();
  function ease(u: number): number {
    const c = Math.max(0, Math.min(1, u));
    return c * c * (3 - 2 * c);
  }

  function update(story: StoryState, time: number, blackout: number) {
    skyUniforms.uShow.value = story.skyShow;
    sky.visible = story.skyShow > 0.003;
    skyUniforms.uFront.value = story.skyFront;
    skyUniforms.uFlow.value = story.skyFlow;
    skyUniforms.uSwirl.value = story.skySwirl;
    skyUniforms.uHue.value = story.skyHue;
    skyUniforms.uGain.value = story.skyGain;
    skyUniforms.uKaleido.value = story.kaleido;
    skyUniforms.uKaleidoSeed.value = story.kaleidoSeed;
    skyUniforms.uJulia.value = story.julia;
    // c walks a circle of radius 0.7885 (the classic family of connected, lace-like sets); the bass turns it
    const ja = 2.35 + story.skyFlow * 0.115;
    skyUniforms.uJuliaC.value.set(0.7885 * Math.cos(ja), 0.7885 * Math.sin(ja));
    skyUniforms.uBlackout.value = blackout;
    for (let i = 0; i < 3; i++) {
      const pl = story.skyPulses[i];
      if (pl) skyUniforms.uPulses.value[i].set(pl[0], pl[1], pl[2], pl[3]);
      else skyUniforms.uPulses.value[i].set(0, 0, 99, 0);
    }

    // Three points of light: gather on the water where the title was, then rise into the flowers.
    for (let i = 0; i < 3; i++) {
      const sp = orbs[i];
      // The three glowing balls are gone (they read as cheap sprites); the buds kindle by themselves.
      const g = 0.0 * story.orbGlow;
      sp.visible = g > 0.004;
      if (!sp.visible) continue;
      const u = ease((story.orbTravel - i * 0.09) / 0.82);
      const a = ORB_START[i];
      const b = FLOWER_POS[i];
      tmp.set(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
      // slight outward arc so the three paths read separately
      tmp.x += Math.sin(u * Math.PI) * (i === 0 ? 0.0 : i === 1 ? -0.35 : 0.35);
      tmp.z += Math.sin(u * Math.PI) * 0.4;
      sp.position.copy(tmp);
      const pulse = 1.0 + 0.12 * Math.sin(time * 5.2 + i * 2.1);
      const sc = (0.5 - 0.12 * u) * pulse;
      sp.scale.set(sc, sc, 1);
      (sp.material as THREE.SpriteMaterial).opacity = g * (1.0 - blackout);
      (sp.material as THREE.SpriteMaterial).color.setRGB(1.5 * g, 1.25 * g, 0.9 * g);
    }
    // The last point of light.
    const last = orbs[3];
    last.visible = story.endPoint > 0.004;
    if (last.visible) {
      last.position.set(0, 0.16, 0.38);
      const e = story.endPoint;
      // a small ember, not a ball of glow
      const sc = 0.42 * (0.6 + 0.4 * e) * (1.0 + 0.05 * Math.sin(time * 3.1));
      last.scale.set(sc, sc, 1);
      (last.material as THREE.SpriteMaterial).color.setRGB(2.2 * e, 1.6 * e, 0.95 * e);
    }

    // Ink falling upward: on the flip, and once more in the recap.
    let age = story.flipAge;
    let gain = age >= 0 && age < 9.0 ? 1.0 - ease((age - 5.5) / 3.5) : 0.0;
    if (story.recapAge >= 0 && story.recapAge < 9.0 && story.recap > 0.01) {
      age = story.recapAge;
      gain = 0.55 * (1.0 - ease((age - 5.5) / 3.5));
    }
    risePoints.visible = gain > 0.004;
    riseUniforms.uAge.value = age;
    riseUniforms.uGain.value = gain * (1.0 - blackout);
  }

  return {
    group,
    update,
    get risePx() {
      return riseUniforms.uPx;
    },
  } as OtherSideHandles & { risePx: { value: number } };
}
