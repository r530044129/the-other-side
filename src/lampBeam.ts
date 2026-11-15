/**
 * Shot 1 motivated key light: one overhead lamp (out of frame, above the title) shining straight down
 * through low sea haze. It is the only light source in the opening; everything outside its cone stays
 * in shadow. Shared by the sky dome (beam seen against the dark space) and the water surface
 * (air in-scatter between the eye and the water, plus the pool of light on the water).
 *
 * Requires uniforms: uTime, uShot1Dark.
 */
export const LAMP_BEAM_GLSL = /* glsl */ `
  const vec3 LB_POS = vec3(0.0, 9.5, 0.35);
  const float LB_SLOPE = 0.34;
  const float LB_R0 = 0.30;
  const float LB_RMAX = 4.2;
  const vec3 LB_COL = vec3(0.62, 0.53, 0.40);

  float lbHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float lbNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(lbHash(i), lbHash(i + vec2(1.0, 0.0)), f.x),
               mix(lbHash(i + vec2(0.0, 1.0)), lbHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  // Radius of the lamp cone at height y (soft edge, wider toward the water).
  float lbConeRadius(float y) {
    return LB_R0 + max(0.0, LB_POS.y - y) * LB_SLOPE;
  }

  // Light reaching a point (0 outside the cone). Used for the pool of light on the water.
  float lbIrradiance(vec3 p) {
    float r = length(p.xz - LB_POS.xz);
    float cr = lbConeRadius(p.y);
    float h = max(0.0, LB_POS.y - p.y);
    return exp(-pow(r / cr, 2.0) * 1.6) / (1.0 + 0.010 * h * h);
  }

  // Single-scattered lamp light along the eye ray segment [0, tMax] through drifting haze.
  // The march is clipped to the beam's bounding cylinder so it stays cheap and sharp.
  vec3 lbScatter(vec3 ro, vec3 rd, float tMax, float jitter) {
    vec2 oc = ro.xz - LB_POS.xz;
    float a = dot(rd.xz, rd.xz);
    float b = dot(oc, rd.xz);
    float c = dot(oc, oc) - LB_RMAX * LB_RMAX;
    float disc = b * b - a * c;
    if (a < 1e-5 || disc <= 0.0) return vec3(0.0);
    float sq = sqrt(disc);
    float t0 = max(0.0, (-b - sq) / a);
    float t1 = min(tMax, (-b + sq) / a);
    if (t1 <= t0) return vec3(0.0);

    const int N = 14;
    float dt = (t1 - t0) / float(N);
    float core = 0.0;
    float halo = 0.0;
    for (int i = 0; i < N; i++) {
      vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
      if (p.y < 0.0 || p.y > LB_POS.y) continue;
      float r = length(p.xz - LB_POS.xz);
      float cr = lbConeRadius(p.y);
      float h = LB_POS.y - p.y;
      float fall = 1.0 / (1.0 + 0.010 * h * h);
      // Haze hugs the water: denser near the surface, thinning upward, slowly drifting.
      float hazeH = 0.30 + 0.70 * exp(-p.y * 0.42);
      float drift = lbNoise(vec2(p.x * 0.85 + uTime * 0.06, p.y * 0.55 - uTime * 0.10) + p.z * 0.45);
      float drift2 = lbNoise(vec2(p.z * 1.7 - uTime * 0.05, p.y * 1.3 + p.x * 0.6) + 7.1);
      // Wispy, high-contrast haze: sheets of light with dark gaps between, not a flat grey column.
      float wisp = smoothstep(0.30, 0.85, drift * 0.7 + drift2 * 0.3);
      float dens = hazeH * (0.10 + 1.40 * wisp * wisp);
      core += exp(-pow(r / cr, 2.0) * 2.4) * fall * dens * dt;
      // Light spilling from the cone into the surrounding haze, so the dark reads as air, not void.
      halo += exp(-pow(r / (cr * 2.3), 2.0)) * fall * hazeH * dt;
    }
    return LB_COL * (core * 0.050 + halo * 0.0012);
  }
`;
