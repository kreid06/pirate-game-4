/**
 * SpriteBatcher — instanced quad renderer.
 *
 * Renders up to MAX_SPRITES_PER_BATCH sprites in a single GL draw call per
 * texture. Sprites are submitted via `draw()` between `begin()` and `end()`.
 *
 * Instance layout (13 floats = 52 bytes per sprite):
 *   offset  0: a_pos    vec2  (x, y)   world centre
 *   offset  8: a_size   vec2  (w, h)   world size
 *   offset 16: a_angle  float          rotation (radians)
 *   offset 20: a_uvRect vec4  (u0,v0,u1,v1)
 *   offset 36: a_tint   vec4  (r,g,b,a) premultiplied
 *
 * Flush triggers:
 *   • texture changes between successive draw() calls
 *   • staging buffer full (MAX_SPRITES_PER_BATCH)
 *   • explicit end() call
 */

import { GLContext }       from './GLContext.js';
import { ShaderProgram }   from './ShaderProgram.js';
import { GpuBuffer, QuadIndexBuffer } from './BufferPool.js';
import { TextureManager }  from './TextureManager.js';

// ── Shader sources ────────────────────────────────────────────────────────

const VERT_SRC = /* glsl */`#version 300 es
precision mediump float;

layout(location = 0) in vec2  a_quad;    // per-vertex unit quad [0,1]×[0,1]
layout(location = 1) in vec2  a_pos;     // per-instance world centre
layout(location = 2) in vec2  a_size;    // per-instance world size
layout(location = 3) in float a_angle;   // per-instance rotation (radians)
layout(location = 4) in vec4  a_uvRect;  // per-instance (u0,v0,u1,v1)
layout(location = 5) in vec4  a_tint;    // per-instance premultiplied RGBA

uniform mat4 u_viewProj;

out vec2 v_uv;
out vec4 v_tint;

void main() {
  vec2 local = (a_quad - 0.5) * a_size;
  float s = sin(a_angle);
  float c = cos(a_angle);
  vec2 rot = vec2(c * local.x - s * local.y,
                  s * local.x + c * local.y);
  gl_Position = u_viewProj * vec4(rot + a_pos, 0.0, 1.0);
  v_uv   = a_uvRect.xy + a_quad * (a_uvRect.zw - a_uvRect.xy);
  v_tint = a_tint;
}`;

const FRAG_SRC = /* glsl */`#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_tint;

uniform sampler2D u_texture;

out vec4 fragColor;

void main() {
  fragColor = texture(u_texture, v_uv) * v_tint;
}`;

// ── Constants ─────────────────────────────────────────────────────────────

export const MAX_SPRITES_PER_BATCH = 8192;

/** Floats packed per sprite instance. */
const FLOATS_PER_SPRITE = 13;
const BYTES_PER_SPRITE  = FLOATS_PER_SPRITE * 4; // 52 bytes

// ── Types ─────────────────────────────────────────────────────────────────

export interface SpriteSubmit {
  /** World-space centre position. */
  x: number;
  y: number;
  /** World-space size. */
  w: number;
  h: number;
  /** Rotation in radians (0 = up/positive-Y). */
  angle: number;
  /** UV rect within the texture atlas (0–1 range). */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Premultiplied RGBA tint (each component 0–1). */
  r: number;
  g: number;
  b: number;
  a: number;
  /** WebGL texture to sample. Flush is triggered on texture change. */
  texture: WebGLTexture;
}

// ── SpriteBatcher ─────────────────────────────────────────────────────────

export class SpriteBatcher {
  private readonly _gl:       WebGL2RenderingContext;
  private readonly _prog:     ShaderProgram;
  private readonly _texMgr:   TextureManager;

  private readonly _quadVbo:  GpuBuffer;           // static unit quad geometry
  private readonly _instVbo:  GpuBuffer;           // per-instance data
  private readonly _ebo:      QuadIndexBuffer;      // 6 indices for 1 quad
  private readonly _vao:      WebGLVertexArrayObject;

  private readonly _staging:  Float32Array;         // CPU-side staging buffer
  private _spriteCount = 0;
  private _curTex:     WebGLTexture | null = null;
  private _drawCalls   = 0;                         // profiling

  private _viewProj: Float32Array = new Float32Array(16);

  constructor(ctx: GLContext, texMgr: TextureManager) {
    const gl     = ctx.gl;
    this._gl     = gl;
    this._texMgr = texMgr;
    this._prog   = ShaderProgram.create(gl, VERT_SRC, FRAG_SRC, 'sprite');

    // Static unit quad: 4 corners [0,0] [1,0] [1,1] [0,1]
    this._quadVbo = new GpuBuffer(gl, 'array', 4 * 2 * 4);
    this._quadVbo.bind();
    this._quadVbo.upload(new Float32Array([0,0, 1,0, 1,1, 0,1]));
    this._quadVbo.unbind();

    this._instVbo = new GpuBuffer(gl, 'array', MAX_SPRITES_PER_BATCH * BYTES_PER_SPRITE);
    this._ebo     = new QuadIndexBuffer(gl);
    this._staging = new Float32Array(MAX_SPRITES_PER_BATCH * FLOATS_PER_SPRITE);

    this._vao = gl.createVertexArray()!;
    this._buildVAO();
  }

  // ── Frame API ─────────────────────────────────────────────────────────────

  /** Call once before submitting sprites for the frame. */
  begin(viewProj: Float32Array): void {
    this._viewProj  = viewProj;
    this._spriteCount = 0;
    this._curTex    = null;
    this._drawCalls = 0;
  }

  /** Submit a sprite. Flushes automatically on texture change or buffer full. */
  draw(s: SpriteSubmit): void {
    if (s.texture !== this._curTex && this._spriteCount > 0) {
      this._flush();
    }
    this._curTex = s.texture;

    const i   = this._spriteCount * FLOATS_PER_SPRITE;
    const buf = this._staging;

    buf[i + 0]  = s.x;
    buf[i + 1]  = s.y;
    buf[i + 2]  = s.w;
    buf[i + 3]  = s.h;
    buf[i + 4]  = s.angle;
    buf[i + 5]  = s.u0;
    buf[i + 6]  = s.v0;
    buf[i + 7]  = s.u1;
    buf[i + 8]  = s.v1;
    buf[i + 9]  = s.r;
    buf[i + 10] = s.g;
    buf[i + 11] = s.b;
    buf[i + 12] = s.a;

    this._spriteCount++;
    if (this._spriteCount >= MAX_SPRITES_PER_BATCH) {
      this._flush();
    }
  }

  /**
   * Convenience: draw a sprite using a canvas texture from TextureManager.
   * Looks up the texture by key, uploading it if missing/stale.
   */
  drawCanvas(
    key:    string | object,
    source: HTMLCanvasElement | OffscreenCanvas,
    x: number, y: number, w: number, h: number,
    angle = 0,
    alpha = 1,
  ): void {
    let entry = this._texMgr.get(key);
    if (!entry) {
      this._texMgr.upload(key, source as HTMLCanvasElement);
      entry = this._texMgr.get(key)!;
    }
    this.draw({
      x, y, w, h, angle,
      u0: 0, v0: 0, u1: 1, v1: 1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: entry.tex,
    });
  }

  /** Flush any remaining sprites and finish the frame. */
  end(): void {
    if (this._spriteCount > 0) this._flush();
  }

  /** Number of GL draw calls issued in the last frame (for profiling). */
  get drawCallCount(): number { return this._drawCalls; }

  dispose(): void {
    this._prog.dispose();
    this._quadVbo.dispose();
    this._instVbo.dispose();
    this._ebo.dispose();
    this._gl.deleteVertexArray(this._vao);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _flush(): void {
    if (this._spriteCount === 0 || this._curTex === null) return;

    const gl    = this._gl;
    const count = this._spriteCount;

    // Upload instance data for this batch
    this._instVbo.bind();
    this._instVbo.upload(
      this._staging.subarray(0, count * FLOATS_PER_SPRITE),
    );

    // Draw
    gl.bindVertexArray(this._vao);
    this._ebo.bind();

    this._prog.use();
    this._prog.setUniformMat4('u_viewProj', this._viewProj);
    this._texMgr.bind(this._curTex, 0);
    this._prog.setUniform1i('u_texture', 0);

    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);

    gl.bindVertexArray(null);
    this._instVbo.unbind();

    this._drawCalls++;
    this._spriteCount = 0;
    this._curTex      = null;
  }

  private _buildVAO(): void {
    const gl = this._gl;
    gl.bindVertexArray(this._vao);

    // ── Attribute 0: per-vertex unit quad ──────────────────────────────────
    this._quadVbo.bind();
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 2 * 4, 0);
    gl.vertexAttribDivisor(0, 0);  // per-vertex

    // ── Attributes 1–5: per-instance data ─────────────────────────────────
    this._instVbo.bind();

    // a_pos (location 1): vec2 @ offset 0
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, BYTES_PER_SPRITE, 0);
    gl.vertexAttribDivisor(1, 1);

    // a_size (location 2): vec2 @ offset 8
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, BYTES_PER_SPRITE, 8);
    gl.vertexAttribDivisor(2, 1);

    // a_angle (location 3): float @ offset 16
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, BYTES_PER_SPRITE, 16);
    gl.vertexAttribDivisor(3, 1);

    // a_uvRect (location 4): vec4 @ offset 20
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, BYTES_PER_SPRITE, 20);
    gl.vertexAttribDivisor(4, 1);

    // a_tint (location 5): vec4 @ offset 36
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, BYTES_PER_SPRITE, 36);
    gl.vertexAttribDivisor(5, 1);

    // Bind EBO inside the VAO so it's remembered
    this._ebo.bind();

    gl.bindVertexArray(null);
    // Unbind after VAO to avoid polluting state
    this._quadVbo.unbind();
    this._instVbo.unbind();

    console.log('[GL] SpriteBatcher VAO built');
  }
}
