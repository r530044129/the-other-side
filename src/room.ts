import * as THREE from 'three';

/**
 * The room: monumental board-formed concrete slabs standing in the water, far enough to dissolve into
 * the mist, and ranks of sleeping lamps hanging in the depth. Nothing here emits on its own account:
 * the slabs only receive light thrown up by the water (caustics), by the flowers and by the sky show,
 * and the lamps wake with the strings. Each stem of the song owns one behaviour:
 *   drums  -> every hit kicks the caustic net
 *   bass   -> slow swell of the net scale
 *   vocals -> colour, and thin threads of light that climb the walls
 *   other  -> how many of the sleeping lamps are awake
 */
export interface RoomState {
  time: number;
  presence: number;
  drums: number;
  bass: number;
  vocals: number;
  other: number;
  beat: number;
  beatKick: number;
  /** 0 = gold caustics, 1 = teal (ink in the water). */
  ink: number;
  /** 0..1: how far the light threads have climbed. */
  veins: number;
  /** Colour thrown by the sky show / the oil title (linear rgb, 0 when none). */
  showTint: [number, number, number];
  showAmt: number;
  ambientKeep: number;
  blackout: number;
  /** Overall light reaching the slabs (the title shot keeps them almost dark). */
  level: number;
  lights: { x: number; y: number; z: number; glow: number }[];
}

export interface RoomHandles {
  group: THREE.Group;
  update: (s: RoomState) => void;
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

const COMMON_GLSL = /* glsl */ `
  float rHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float rNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(rHash(i), rHash(i + vec2(1.0, 0.0)), f.x), mix(rHash(i + vec2(0.0, 1.0)), rHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float rFbm2(vec2 p) {
    return 0.62 * rNoise(p) + 0.38 * rNoise(p * 2.03 + vec2(1.7, 9.2));
  }
  float rFbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      s += a * rNoise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return s;
  }
`;

export function createRoom(): RoomHandles {
  const group = new THREE.Group();
  const rand = rng(20261115);

  // ---------------------------------------------------------------- slabs
  const slabDefs: { x: number; z: number; w: number; h: number; d: number; yaw: number }[] = [];
  const backX = [-20.5, -13.6, -6.8, 0.0, 6.8, 13.6, 20.5];
  for (let i = 0; i < backX.length; i++) {
    slabDefs.push({
      x: backX[i] + (i === 3 ? 0 : (rand() - 0.5) * 0.8),
      z: -14.5 - rand() * 3.2 - Math.abs(backX[i]) * 0.12,
      w: i === 3 ? 6.4 : 4.6 + rand() * 1.6,
      h: 15 + rand() * 7,
      d: 1.3,
      yaw: (rand() - 0.5) * 0.22 - backX[i] * 0.012,
    });
  }
  for (const side of [-1, 1]) {
    slabDefs.push({ x: side * 13.2, z: -8.2, w: 5.4, h: 19, d: 1.3, yaw: side * -0.95 });
    slabDefs.push({ x: side * 15.4, z: -1.6, w: 5.0, h: 22, d: 1.3, yaw: side * -1.2 });
    slabDefs.push({ x: side * 9.6, z: -19.5, w: 3.8, h: 24, d: 1.2, yaw: side * -0.3 });
  }

  const slabUniforms = {
    uTime: { value: 0 },
    uPresence: { value: 0 },
    uDrums: { value: 0 },
    uBass: { value: 0 },
    uVocals: { value: 0 },
    uInk: { value: 0 },
    uVeins: { value: 0 },
    uShowTint: { value: new THREE.Vector3() },
    uShowAmt: { value: 0 },
    uAmbientKeep: { value: 1 },
    uBlackout: { value: 0 },
    uLevel: { value: 1 },
    uLights: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  };

  const slabMat = new THREE.ShaderMaterial({
    uniforms: slabUniforms,
    transparent: true,
    vertexShader: /* glsl */ `
      attribute float aSlab;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec2 vFace;
      varying float vSlab;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vFace = uv;
        vSlab = aSlab;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec2 vFace;
      varying float vSlab;
      uniform float uTime;
      uniform float uPresence;
      uniform float uDrums;
      uniform float uBass;
      uniform float uVocals;
      uniform float uInk;
      uniform float uVeins;
      uniform vec3 uShowTint;
      uniform float uShowAmt;
      uniform float uAmbientKeep;
      uniform float uBlackout;
      uniform float uLevel;
      uniform vec4 uLights[4];
      ${COMMON_GLSL}

      // refractive caustic cusp network (two advected layers)
      float causticNet(vec2 p, float t) {
        vec2 z1 = p * 1.25 + vec2(t * 0.30, -t * 0.22);
        vec2 z2 = p * 1.95 + vec2(-t * 0.26, t * 0.31) + vec2(2.7, -1.9);
        for (int i = 0; i < 4; i++) {
          z1 += 0.46 * vec2(sin(z1.y * 1.85 + t * 0.82), cos(z1.x * 1.75 - t * 0.70));
          z2 += 0.40 * vec2(cos(z2.y * 2.10 - t * 0.95), sin(z2.x * 2.00 + t * 0.78));
        }
        float c1 = pow(clamp(1.0 - abs(sin(z1.x) + cos(z1.y)) * 0.54, 0.0, 1.0), 5.0);
        float c2 = pow(clamp(1.0 - abs(cos(z2.x) - sin(z2.y)) * 0.54, 0.0, 1.0), 6.0);
        return c1 * 1.25 + c2 * 0.9;
      }

      void main() {
        vec3 N = normalize(vNormalW);
        // coordinate running along the wall face
        float along = dot(vWorldPos.xz, vec2(-N.z, N.x)) + vSlab * 7.3;
        float y = vWorldPos.y;

        // board-formed concrete: horizontal pour seams, vertical board grain, stains bleeding down, tie holes
        float seam = smoothstep(0.035, 0.0, abs(fract(y / 1.35) - 0.5) - 0.468);
        float boards = rNoise(vec2(along * 9.0, floor(y / 1.35) * 3.1 + vSlab));
        float stain = rFbm2(vec2(along * 0.9, y * 0.16 + vSlab * 3.0));
        float grain = rFbm2(vec2(along * 26.0, y * 2.2));
        vec2 tieCell = vec2(fract(along / 1.2) - 0.5, fract(y / 1.35) - 0.5);
        float tie = smoothstep(0.045, 0.02, length(tieCell * vec2(1.2, 1.35)));
        float albedo = 0.55 + 0.25 * boards * 0.6 + 0.30 * stain + 0.12 * grain;
        albedo *= 1.0 - 0.45 * seam - 0.6 * tie;
        // a faint bump so raking light reads the surface
        float bump = (grain - 0.5) * 0.5 + (boards - 0.5) * 0.2;

        // --- light thrown up by the water
        float t = uTime;
        float swell = 1.0 + 0.22 * uBass;
        float net = causticNet(vec2(along, y * 1.15) * 0.66 / swell, t);
        float climb = exp(-max(y, 0.0) / (3.6 + 2.0 * uBass)) * smoothstep(-0.2, 0.4, y);
        // light only reaches the wall in slow drifting patches; between them the concrete stays dark
        float lightPatch = smoothstep(0.38, 0.72, rFbm2(vec2(along * 0.11 + t * 0.028, y * 0.09 - t * 0.017) + vSlab));
        climb *= 0.22 + 0.78 * lightPatch;
        float kick = 0.55 + 1.65 * uDrums;
        vec3 gold = vec3(1.00, 0.62, 0.24);
        vec3 teal = vec3(0.10, 0.78, 0.74);
        vec3 causticCol = mix(gold, teal, uInk);
        // the vocal line bends the colour a little toward rose
        causticCol = mix(causticCol, vec3(1.0, 0.42, 0.55), 0.22 * uVocals * (1.0 - uInk));
        causticCol = mix(causticCol, uShowTint * 1.2 + 0.05, clamp(uShowAmt, 0.0, 1.0) * 0.7);
        vec3 col = causticCol * net * climb * kick * 0.19 * (1.0 + 0.6 * bump) * mix(1.0, 0.62, uInk);

        // soft bounce wash under the net so the wall never reads as a flat black card
        col += causticCol * climb * 0.022 * (0.6 + 0.8 * stain);

        // --- threads of light climbing with the voice
        if (uVeins > 0.002) {
          float cell = floor(along / 0.85);
          float h = rHash(vec2(cell, vSlab * 3.0));
          float xIn = fract(along / 0.85) - 0.5 + 0.10 * sin(y * 0.9 + h * 20.0) + 0.03 * sin(y * 3.1 + h * 7.0);
          float line = exp(-xIn * xIn * 900.0) * step(0.45, h);
          float top = uVeins * (3.0 + 9.0 * h);
          float head = exp(-((y - top) / 0.5) * ((y - top) / 0.5));
          float body = smoothstep(top, top - 0.4, y) * smoothstep(-0.1, 0.4, y);
          col += vec3(0.16, 0.95, 0.88) * line * (body * (0.10 + 0.35 * uVocals) + head * 0.9) * 0.55;
        }

        // --- the flowers light the slabs they face
        for (int i = 0; i < 4; i++) {
          float g = uLights[i].w;
          if (g <= 0.004) continue;
          vec3 L = uLights[i].xyz - vWorldPos;
          float d2 = dot(L, L);
          float ndl = max(0.0, dot(N, normalize(L)) * 0.7 + 0.3);
          col += vec3(1.0, 0.70, 0.38) * g * ndl * 1.1 / (14.0 + d2) * (0.75 + 0.5 * bump);
        }

        // --- sky show spill from above
        col += uShowTint * uShowAmt * 0.10 * smoothstep(0.0, 14.0, y) * (0.5 + 0.5 * N.y + 0.5);

        col *= albedo;

        // --- atmosphere: the slabs stand in mist; base haze thickest at the waterline, tops lost in the dark
        float dist = length(vWorldPos - cameraPosition);
        col *= uLevel;
        float fog = 1.0 - exp(-dist * 0.040);
        float lowHaze = exp(-max(y, 0.0) / 2.2);
        vec3 mistCol = (vec3(0.020, 0.028, 0.038) + vec3(0.022, 0.016, 0.010) * lowHaze) * uAmbientKeep;
        mistCol += causticCol * 0.012 * lowHaze * kick;
        col = mix(col, mistCol, clamp(fog * (0.55 + 0.45 * lowHaze), 0.0, 1.0));
        col *= 1.0 - smoothstep(6.0, 16.0, y) * 0.9;

        col *= (1.0 - uBlackout);
        gl_FragColor = vec4(max(col, vec3(0.0)), smoothstep(0.0, 0.6, uPresence));
      }
    `,
  });

  {
    const geos: THREE.BufferGeometry[] = [];
    slabDefs.forEach((s, i) => {
      const g = new THREE.BoxGeometry(s.w, s.h, s.d, 1, 1, 1);
      const m = new THREE.Matrix4()
        .makeRotationY(s.yaw)
        .setPosition(s.x, s.h * 0.5 - 1.2, s.z);
      g.applyMatrix4(m);
      const ids = new Float32Array(g.attributes.position.count).fill(i);
      g.setAttribute('aSlab', new THREE.BufferAttribute(ids, 1));
      geos.push(g);
    });
    // manual merge (all non-indexed to keep it simple)
    let total = 0;
    const parts = geos.map((g) => {
      const ng = g.toNonIndexed();
      total += ng.attributes.position.count;
      return ng;
    });
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    const ids = new Float32Array(total);
    let o = 0;
    for (const g of parts) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array as Float32Array, o * 3);
      nor.set(g.attributes.normal.array as Float32Array, o * 3);
      uvs.set(g.attributes.uv.array as Float32Array, o * 2);
      ids.set(g.attributes.aSlab.array as Float32Array, o);
      o += n;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    merged.setAttribute('aSlab', new THREE.BufferAttribute(ids, 1));
    const mesh = new THREE.Mesh(merged, slabMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -12;
    group.add(mesh);
  }

  // ---------------------------------------------------------------- sleeping lamps
  const LAMP_POS: [number, number, number, number][] = [];
  for (const x of [-12, -8.4, -5, 5, 8.4, 12]) LAMP_POS.push([x, 3.7, -7.0, 0]);
  for (const x of [-10.5, -7, -3.5, 0, 3.5, 7, 10.5]) LAMP_POS.push([x, 4.7, -11.0, 1]);
  for (const x of [-10, -6, -2, 2, 6, 10]) LAMP_POS.push([x, 5.8, -15.0, 2]);
  const LAMPS = LAMP_POS.length;
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const u = i / 14;
    // closed pleated sleeve: narrow collar, slight belly, open hem
    const r = 0.05 + 0.13 * Math.pow(u, 0.55) + 0.03 * Math.sin(u * Math.PI);
    profile.push(new THREE.Vector2(r, 0.62 - u * 1.24));
  }
  const lampGeo = new THREE.LatheGeometry(profile, 28);
  const seeds = new Float32Array(LAMPS);
  const lampUniforms = {
    uTime: { value: 0 },
    uPresence: { value: 0 },
    uWake: { value: 0 },
    uBeat: { value: 0 },
    uKick: { value: 0 },
    uAmbientKeep: { value: 1 },
    uBlackout: { value: 0 },
    uShowTint: { value: new THREE.Vector3() },
    uShowAmt: { value: 0 },
  };
  const lampMat = new THREE.ShaderMaterial({
    uniforms: lampUniforms,
    side: THREE.DoubleSide,
    transparent: true,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vV;
      varying float vSeed;
      varying float vAng;
      uniform float uTime;
      void main() {
        vec3 p = position;
        float ang = atan(p.z, p.x);
        // pleats, deeper toward the hem, breathing very slightly
        float u = clamp((0.62 - p.y) / 1.24, 0.0, 1.0);
        float pleat = sin(ang * 11.0 + aSeed * 30.0) * 0.022 * u;
        p.xz *= 1.0 + pleat / max(0.05, length(p.xz)) + 0.03 * sin(uTime * 0.5 + aSeed * 50.0) * u;
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        wp.x += 0.05 * sin(uTime * 0.31 + aSeed * 40.0) * u;
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vV = u;
        vSeed = aSeed;
        vAng = ang;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vV;
      varying float vSeed;
      varying float vAng;
      uniform float uPresence;
      uniform float uWake;
      uniform float uBeat;
      uniform float uKick;
      uniform float uAmbientKeep;
      uniform float uBlackout;
      uniform vec3 uShowTint;
      uniform float uShowAmt;
      ${COMMON_GLSL}
      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float ndv = abs(dot(N, V));
        // awake when the strings swell past this lamp's own threshold
        float awake = smoothstep(vSeed - 0.10, vSeed + 0.14, uWake);
        // on some beats one or two sleepers blink
        float blink = step(0.93, rHash(vec2(vSeed * 91.7, floor(uBeat)))) * uKick;
        float glow = 0.035 + awake * 0.42 + blink * 0.5;
        // light comes from a core near the hem and transmits through the cloth: brightest where the
        // fabric faces us, pleat valleys darker, collar dim
        float pleatShade = 0.62 + 0.38 * sin(vAng * 11.0 + vSeed * 30.0);
        float core = exp(-((vV - 0.80) / 0.36) * ((vV - 0.80) / 0.36));
        vec3 warm = mix(vec3(1.0, 0.62, 0.30), vec3(1.0, 0.80, 0.56), core);
        vec3 col = warm * glow * (0.10 + 1.25 * core) * pleatShade * (0.45 + 0.55 * ndv);
        // asleep: just a silhouette catching a little rim from the mist and the show
        // (1 - ndv can dip a hair below zero where the cloth faces the lens; pow of a negative is undefined)
        float rim = pow(max(0.0, 1.0 - ndv), 2.5);
        col += (vec3(0.020, 0.018, 0.016) * uAmbientKeep + uShowTint * uShowAmt * 0.05) * (0.35 + rim) * pleatShade;
        float dist = length(vWorldPos - cameraPosition);
        float fog = 1.0 - exp(-dist * 0.034);
        vec3 mistCol = vec3(0.020, 0.028, 0.038) * uAmbientKeep;
        col = mix(col, mistCol + col * 0.30, fog);
        col *= (1.0 - uBlackout);
        gl_FragColor = vec4(col, smoothstep(0.0, 0.6, uPresence));
      }
    `,
  });
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, LAMPS);
  const dummy = new THREE.Object3D();
  const cordPts: number[] = [];
  for (let i = 0; i < LAMPS; i++) {
    const [x0, y0, z0, row] = LAMP_POS[i];
    const x = x0 + (rand() - 0.5) * 0.5;
    const y = y0 + (rand() - 0.5) * 0.7;
    const z = z0 + (rand() - 0.5) * 0.8;
    const sc = 1.25 + rand() * 0.35;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand() * 6.28, 0);
    dummy.scale.setScalar(sc);
    dummy.updateMatrix();
    lamps.setMatrixAt(i, dummy.matrix);
    // the swell wakes the centre first and spreads outward, row by row
    seeds[i] = 0.30 + 0.30 * (Math.abs(x0) / 12) + 0.14 * row + 0.05 * rand();
    cordPts.push(x, y + 0.62 * sc, z, x, 30, z);
  }
  const cordGeo = new THREE.BufferGeometry();
  cordGeo.setAttribute('position', new THREE.Float32BufferAttribute(cordPts, 3));
  const cordMat = new THREE.LineBasicMaterial({ color: 0x1c1712, transparent: true, opacity: 0.0 });
  const cords = new THREE.LineSegments(cordGeo, cordMat);
  cords.frustumCulled = false;
  cords.renderOrder = -11;
  group.add(cords);
  lampGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  lamps.frustumCulled = false;
  lamps.renderOrder = -11;
  group.add(lamps);

  function update(s: RoomState) {
    const vis = s.presence > 0.003;
    group.visible = vis && !(window as unknown as { __noRoom?: boolean }).__noRoom;
    if (!vis) return;
    const su = slabUniforms;
    su.uTime.value = s.time;
    su.uPresence.value = s.presence;
    su.uDrums.value = s.drums;
    su.uBass.value = s.bass;
    su.uVocals.value = s.vocals;
    su.uInk.value = s.ink;
    su.uVeins.value = s.veins;
    su.uShowTint.value.set(s.showTint[0], s.showTint[1], s.showTint[2]);
    su.uShowAmt.value = s.showAmt;
    su.uAmbientKeep.value = s.ambientKeep;
    su.uBlackout.value = s.blackout;
    su.uLevel.value = s.level;
    for (let i = 0; i < 4; i++) {
      const l = s.lights[i];
      if (l) su.uLights.value[i].set(l.x, l.y, l.z, l.glow);
      else su.uLights.value[i].set(0, 0, 0, 0);
    }
    const lu = lampUniforms;
    lu.uTime.value = s.time;
    lu.uPresence.value = s.presence;
    lu.uWake.value = s.other;
    lu.uBeat.value = s.beat;
    lu.uKick.value = s.beatKick;
    lu.uAmbientKeep.value = s.ambientKeep;
    lu.uBlackout.value = s.blackout;
    lu.uShowTint.value.set(s.showTint[0], s.showTint[1], s.showTint[2]);
    lu.uShowAmt.value = s.showAmt;
    cordMat.opacity = 0.55 * Math.min(1, s.presence / 0.6) * (1 - s.blackout);
  }

  return { group, update };
}
