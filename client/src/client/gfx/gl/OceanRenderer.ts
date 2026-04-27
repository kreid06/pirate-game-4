/**
 * OceanRenderer — animated tiled caustic water background.
 *
 * Renders a full-screen quad using a GLSL Voronoi (F1/F2) caustic shader
 * that matches the look of top-down tropical water: bright caustic edge
 * lines around darker blob-shaped cell interiors.
 *
 * The pattern is in world space — it tiles and scrolls naturally as the
 * camera moves, exactly like the grid lines do.
 *
 * Usage:
 *   const ocean = new OceanRenderer(ctx);
 *   // each frame:
 *   ocean.render(cameraX, cameraY, zoom, elapsedSeconds);
 */

import { GLContext }     from './GLContext.js';
import { ShaderProgram } from './ShaderProgram.js';
import { GpuBuffer }     from './BufferPool.js';

// ── Shader sources (inlined — no async file loading) ─────────────────────

const VERT_SRC = /* glsl */`#version 300 es
precision mediump float;

layout(location = 0) in vec2 a_clipPos;

uniform vec2  u_cameraPos;
uniform float u_zoom;
uniform vec2  u_resolution;

out vec2 v_worldPos;

void main() {
  gl_Position = vec4(a_clipPos, 0.0, 1.0);
  vec2 ndc    = a_clipPos;
  vec2 pixel  = (ndc * 0.5 + 0.5) * u_resolution;
  // WebGL NDC Y is +1 at top; 2D canvas Y is 0 at top — flip Y offset
  // so the pattern scrolls in the same direction as everything else.
  vec2 offset = vec2(pixel.x - u_resolution.x * 0.5,
                     u_resolution.y * 0.5 - pixel.y);
  v_worldPos  = u_cameraPos + offset / u_zoom;
}`;

const FRAG_SRC = /* glsl */`#version 300 es
precision mediump float;

in vec2 v_worldPos;

uniform float u_time;
uniform vec2  u_cameraPos;
uniform float u_zoom;

out vec4 fragColor;

// ── Helpers ──────────────────────────────────────────────────────────────

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// Smooth value noise returning a 2D vector — used for domain warping.
vec2 smoothNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 a = hash2(i + vec2(0.0, 0.0));
  vec2 b = hash2(i + vec2(1.0, 0.0));
  vec2 c = hash2(i + vec2(0.0, 1.0));
  vec2 d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Returns (F1, F2): distances to nearest and second-nearest Voronoi sites.
// Uses a 3×3 neighbourhood — fast enough for a full-screen shader while
// still producing clean cell edges at the scales we render at.
// Cell centres drift slowly over time to animate the caustic pattern.
vec2 voronoiF1F2(vec2 p, float t, float speed) {
  vec2  i  = floor(p);
  vec2  f  = fract(p);
  float F1 = 9.0;
  float F2 = 9.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 nb   = vec2(float(x), float(y));
      vec2 seed = hash2(i + nb);
      vec2 pt   = 0.5 + 0.45 * sin(t * speed + 6.2831 * seed);
      float d   = length(nb + pt - f);
      if      (d < F1) { F2 = F1; F1 = d; }
      else if (d < F2) { F2 = d; }
    }
  }
  return vec2(F1, F2);
}

// ── Main ──────────────────────────────────────────────────────────────────

void main() {
  const float SCALE = 0.0050;
  vec2  wp = v_worldPos * SCALE;
  float t  = u_time;

  // ── Domain warp ───────────────────────────────────────────────────────
  const float WARP_STR = 0.55;
  vec2 warp1 = smoothNoise2(wp * 1.3 + vec2(t * 0.035,  t * 0.022)) * 2.0 - 1.0;
  vec2 warp2 = smoothNoise2(wp * 2.1 + vec2(t * 0.018, -t * 0.029)) * 2.0 - 1.0;
  vec2 warped = wp + (warp1 + warp2 * 0.5) * WARP_STR;

  // ── Single Voronoi pass (3×3, fast) ──────────────────────────────────
  vec2  v1    = voronoiF1F2(warped, t, 0.10);
  float edge1 = v1.y - v1.x;

  // Derive inner detail from the warp noise magnitude — free, no extra Voronoi
  float warpMag = length(warp1 * 0.6 + warp2 * 0.3);
  float edge2   = clamp(warpMag * 0.9, 0.0, 1.0);

  // ── Colour palette ────────────────────────────────────────────────────
  vec3 deepCell = vec3(0.012, 0.643, 0.780);
  vec3 fillBlue = vec3(0.067, 0.737, 0.855);
  vec3 caustic  = vec3(0.600, 0.918, 0.953);

  float interior = smoothstep(0.55, 0.05, v1.x);
  vec3  color    = mix(fillBlue, deepCell, interior * 0.55);

  float ePrimary = 1.0 - smoothstep(0.0, 0.10, edge1);
  color = mix(color, caustic, ePrimary * 0.88);

  float eSecond = 1.0 - smoothstep(0.35, 0.55, edge2);
  color = mix(color, mix(caustic, fillBlue, 0.55), eSecond * 0.30);

  float shimmer = sin(v1.x * 11.0 + t * 0.60) * 0.012;
  color = clamp(color + shimmer, 0.0, 1.0);

  fragColor = vec4(color, 1.0);
}`;

// ── OceanRenderer ─────────────────────────────────────────────────────────

export class OceanRenderer {
  private readonly _gl:   WebGL2RenderingContext;
  private readonly _ctx:  GLContext;
  private readonly _prog: ShaderProgram;
  private readonly _vbo:  GpuBuffer;
  private readonly _vao:  WebGLVertexArrayObject;

  constructor(ctx: GLContext) {
    const gl    = ctx.gl;
    this._gl    = gl;
    this._ctx   = ctx;
    this._prog  = ShaderProgram.create(gl, VERT_SRC, FRAG_SRC, 'ocean');

    // Full-screen quad: two CCW triangles covering NDC [-1,1]²
    // prettier-ignore
    const verts = new Float32Array([
      -1, -1,   1, -1,   1,  1,
      -1, -1,   1,  1,  -1,  1,
    ]);

    this._vbo = new GpuBuffer(gl, 'array', verts.byteLength);
    this._vbo.bind();
    this._vbo.upload(verts);
    this._vbo.unbind();

    this._vao = gl.createVertexArray()!;
    gl.bindVertexArray(this._vao);
    this._vbo.bind();
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 2 * 4, 0);
    gl.bindVertexArray(null);
    this._vbo.unbind();

    console.log('[GL] OceanRenderer ready');
  }

  /**
   * Draw the ocean background.
   * Call this FIRST in the frame (before SpriteBatcher).
   *
   * @param camX     Camera world-space X
   * @param camY     Camera world-space Y
   * @param zoom     Pixels per world unit
   * @param timeSec  Elapsed time in seconds (monotonically increasing)
   */
  render(
    camX: number,
    camY: number,
    zoom: number,
    timeSec: number,
    viewWidth?: number,
    viewHeight?: number,
  ): void {
    const gl   = this._gl;
    const prog = this._prog;
    const rw = viewWidth  ?? this._ctx.width;
    const rh = viewHeight ?? this._ctx.height;

    prog.use();
    prog.setUniform2f('u_cameraPos',  camX, camY);
    prog.setUniform1f('u_zoom',       zoom);
    prog.setUniform2f('u_resolution', rw, rh);
    prog.setUniform1f('u_time',       timeSec);

    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this._prog.dispose();
    this._vbo.dispose();
    this._gl.deleteVertexArray(this._vao);
  }
}
