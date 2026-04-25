#version 300 es
precision mediump float;

in vec2 v_worldPos;

uniform float u_time;        // seconds since start
uniform vec2  u_cameraPos;   // for depth-fog reference
uniform float u_zoom;        // zoom level — dampen animation at high zoom

out vec4 fragColor;

// ── Helpers ───────────────────────────────────────────────────────────────

// Cheap 2D hash
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// Smooth cellular / Worley noise — returns distance to nearest point
float worley(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float minDist = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point    = hash2(i + neighbor);
      // Animate the cell points
      point = 0.5 + 0.5 * sin(u_time * 0.4 + 6.2831 * point);
      vec2  diff = neighbor + point - f;
      float d    = length(diff);
      minDist = min(minDist, d);
    }
  }
  return minDist;
}

// Classic smooth noise (value noise via quintic interp)
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic
  float a = fract(sin(dot(i + vec2(0.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ── Main ──────────────────────────────────────────────────────────────────

void main() {
  // Scale world pos to noise domain.
  // Divide by a large world-unit scale so tiles look ocean-sized at 1× zoom.
  float SCALE = 0.0028;
  vec2  wp    = v_worldPos * SCALE;
  float t     = u_time;

  // ── Base ocean color ──────────────────────────────────────────────────
  // Deep  #0a2a52  →  Mid  #1560bd  →  Shallow  #1e90ff
  // Depth gradient: use a slow sine wave of value noise
  float depthNoise = valueNoise(wp * 0.6 + vec2(t * 0.015, t * 0.010));
  vec3 deepColor    = vec3(0.039, 0.165, 0.322);   // #0a2a52
  vec3 midColor     = vec3(0.082, 0.376, 0.741);   // #1560bd
  vec3 shallowColor = vec3(0.118, 0.565, 1.000);   // #1e90ff
  vec3 baseColor    = mix(deepColor, mix(midColor, shallowColor, depthNoise), depthNoise);

  // ── Wave ripple lines — scrolling sine bands ──────────────────────────
  float waveSpeed  = 0.22;
  float waveDir1   = wp.x * 1.4 + wp.y * 0.5 - t * waveSpeed;
  float waveDir2   = wp.x * 0.8 - wp.y * 1.2 - t * waveSpeed * 0.7;
  float wave1 = pow(abs(sin(waveDir1 * 6.0)), 12.0);
  float wave2 = pow(abs(sin(waveDir2 * 5.0)), 14.0);
  float ripple = wave1 * 0.20 + wave2 * 0.12;

  // ── Worley foam ───────────────────────────────────────────────────────
  // Two octaves of animated Worley noise at different scales/directions
  vec2  foamOff1 = vec2(t * 0.08,  t * 0.04);
  vec2  foamOff2 = vec2(-t * 0.05, t * 0.07);
  float w1 = worley(wp * 3.5 + foamOff1);
  float w2 = worley(wp * 6.0 + foamOff2);
  // Foam appears where Worley distance is small (near cell centres)
  float foam1 = smoothstep(0.50, 0.38, w1);
  float foam2 = smoothstep(0.45, 0.35, w2) * 0.55;
  float foam  = clamp(foam1 + foam2, 0.0, 1.0);

  // ── Highlight sparkle — high-freq value noise ────────────────────────
  float sparkle = valueNoise(wp * 18.0 + vec2(t * 0.25, -t * 0.18));
  sparkle = pow(sparkle, 6.0) * 0.35;

  // ── Compose ───────────────────────────────────────────────────────────
  vec3 color = baseColor;
  // Ripple brightens the water slightly
  color = mix(color, shallowColor + 0.12, ripple * 0.55);
  // Foam: white-ish froth
  vec3 foamColor = vec3(0.82, 0.90, 1.00);
  color = mix(color, foamColor, foam * 0.65);
  // Sparkle: near-white glints
  color = mix(color, vec3(1.0, 1.0, 1.0), sparkle);

  // Subtle vignette around camera centre to suggest depth
  float dist = length(v_worldPos - u_cameraPos) * 0.00035;
  float vignette = 1.0 - clamp(dist * dist * 0.18, 0.0, 0.22);
  color *= vignette;

  fragColor = vec4(color, 1.0);
}
