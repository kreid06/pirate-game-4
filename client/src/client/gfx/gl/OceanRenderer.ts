/**
 * OceanRenderer — animated full-screen ocean background.
 *
 * Renders a full-screen quad using GLSL Worley-noise foam and sine-wave
 * ripples. Must be drawn first in the frame (before sprites) to act as the
 * background. Writes alpha=1 so it fully covers the GL canvas.
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
  v_worldPos  = u_cameraPos + (pixel - u_resolution * 0.5) / u_zoom;
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

float worley(vec2 p) {
  vec2  i       = floor(p);
  vec2  f       = fract(p);
  float minDist = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 nb  = vec2(float(x), float(y));
      vec2 pt  = hash2(i + nb);
      pt       = 0.5 + 0.5 * sin(u_time * 0.4 + 6.2831 * pt);
      float d  = length(nb + pt - f);
      minDist  = min(minDist, d);
    }
  }
  return minDist;
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = fract(sin(dot(i + vec2(0.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ── Main ──────────────────────────────────────────────────────────────────

void main() {
  float SCALE = 0.0028;
  vec2  wp    = v_worldPos * SCALE;
  float t     = u_time;

  // Depth gradient
  float depthNoise  = valueNoise(wp * 0.6 + vec2(t * 0.015, t * 0.010));
  vec3  deepColor   = vec3(0.039, 0.165, 0.322);
  vec3  midColor    = vec3(0.082, 0.376, 0.741);
  vec3  shallowColor= vec3(0.118, 0.565, 1.000);
  vec3  baseColor   = mix(deepColor, mix(midColor, shallowColor, depthNoise), depthNoise);

  // Wave ripples
  float wd1    = wp.x * 1.4 + wp.y * 0.5 - t * 0.22;
  float wd2    = wp.x * 0.8 - wp.y * 1.2 - t * 0.154;
  float ripple = pow(abs(sin(wd1 * 6.0)), 12.0) * 0.20
               + pow(abs(sin(wd2 * 5.0)), 14.0) * 0.12;

  // Worley foam
  float w1   = worley(wp * 3.5 + vec2( t * 0.08,  t * 0.04));
  float w2   = worley(wp * 6.0 + vec2(-t * 0.05,  t * 0.07));
  float foam = clamp(smoothstep(0.50, 0.38, w1)
                   + smoothstep(0.45, 0.35, w2) * 0.55, 0.0, 1.0);

  // Sparkle
  float sparkle = pow(valueNoise(wp * 18.0 + vec2(t * 0.25, -t * 0.18)), 6.0) * 0.35;

  // Compose
  vec3 color = baseColor;
  color = mix(color, shallowColor + 0.12, ripple * 0.55);
  color = mix(color, vec3(0.82, 0.90, 1.00), foam * 0.65);
  color = mix(color, vec3(1.0), sparkle);

  // Subtle depth vignette
  float dist    = length(v_worldPos - u_cameraPos) * 0.00035;
  float vignette = 1.0 - clamp(dist * dist * 0.18, 0.0, 0.22);
  color *= vignette;

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
  render(camX: number, camY: number, zoom: number, timeSec: number): void {
    const gl   = this._gl;
    const prog = this._prog;

    prog.use();
    prog.setUniform2f('u_cameraPos',  camX, camY);
    prog.setUniform1f('u_zoom',       zoom);
    prog.setUniform2f('u_resolution', this._ctx.width, this._ctx.height);
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
