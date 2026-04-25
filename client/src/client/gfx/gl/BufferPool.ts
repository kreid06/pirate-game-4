/**
 * BufferPool — VAO / VBO management helpers.
 *
 * Provides:
 *   • GpuBuffer: a single typed GPU buffer with resize-aware upload
 *   • VertexLayout: declarative attribute binding helper
 *   • QuadIndexBuffer: shared EBO for quad (2-triangle) rendering
 *
 * All buffers use DYNAMIC_DRAW since sprite / particle data changes every frame.
 */

// ── GpuBuffer ─────────────────────────────────────────────────────────────

/** Wraps a single WebGLBuffer with typed CPU-side staging data. */
export class GpuBuffer {
  public readonly buf:  WebGLBuffer;
  public readonly type: 'array' | 'element';
  private _gl:          WebGL2RenderingContext;
  private _glTarget:    number;
  private _byteLength:  number;

  constructor(gl: WebGL2RenderingContext, type: 'array' | 'element', initialBytes: number) {
    this._gl       = gl;
    this.type      = type;
    this._glTarget = type === 'array' ? gl.ARRAY_BUFFER : gl.ELEMENT_ARRAY_BUFFER;
    this.buf       = gl.createBuffer()!;
    this._byteLength = 0;
    // Pre-allocate GPU memory
    gl.bindBuffer(this._glTarget, this.buf);
    gl.bufferData(this._glTarget, initialBytes, gl.DYNAMIC_DRAW);
    this._byteLength = initialBytes;
    gl.bindBuffer(this._glTarget, null);
  }

  bind(): void {
    this._gl.bindBuffer(this._glTarget, this.buf);
  }

  unbind(): void {
    this._gl.bindBuffer(this._glTarget, null);
  }

  /**
   * Upload a typed array sub-region, growing the buffer if needed.
   * Caller must have this buffer bound.
   */
  upload(data: ArrayBufferView, byteOffset = 0): void {
    const gl   = this._gl;
    const need = byteOffset + data.byteLength;
    if (need > this._byteLength) {
      // Grow by doubling
      const newSize = Math.max(need, this._byteLength * 2);
      gl.bufferData(this._glTarget, newSize, gl.DYNAMIC_DRAW);
      this._byteLength = newSize;
    }
    gl.bufferSubData(this._glTarget, byteOffset, data);
  }

  dispose(): void {
    this._gl.deleteBuffer(this.buf);
  }
}

// ── VertexLayout ──────────────────────────────────────────────────────────

export interface AttribDesc {
  /** GLSL attribute location */
  location:   number;
  /** Number of components (1–4) */
  size:       number;
  /** gl.FLOAT, gl.UNSIGNED_BYTE, etc. */
  glType:     number;
  /** Whether to normalise integer types to [0,1] */
  normalized: boolean;
  /** Byte offset within the vertex or instance stride */
  offset:     number;
  /** 0 = per-vertex, 1 = per-instance */
  divisor:    number;
}

/**
 * Bind a set of vertex attributes for a given stride.
 * Assumes the relevant VBO is already bound.
 */
export function applyVertexLayout(
  gl: WebGL2RenderingContext,
  attribs: AttribDesc[],
  stride: number,
): void {
  for (const a of attribs) {
    if (a.location < 0) continue;
    gl.enableVertexAttribArray(a.location);
    gl.vertexAttribPointer(a.location, a.size, a.glType, a.normalized, stride, a.offset);
    gl.vertexAttribDivisor(a.location, a.divisor);
  }
}

/** Disable all attributes in the layout (used on VAO unbind). */
export function disableVertexLayout(
  gl: WebGL2RenderingContext,
  attribs: AttribDesc[],
): void {
  for (const a of attribs) {
    if (a.location < 0) continue;
    gl.disableVertexAttribArray(a.location);
    gl.vertexAttribDivisor(a.location, 0);
  }
}

// ── QuadIndexBuffer ───────────────────────────────────────────────────────

/**
 * Shared element buffer for drawing N quads as triangle pairs.
 * Indices follow the pattern: [0,1,2, 2,3,0] per quad.
 *
 * Usage:
 *   const qib = new QuadIndexBuffer(gl, 8192);
 *   qib.bind();
 *   gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, instanceCount);
 *
 * For instanced rendering the index buffer covers a single quad (6 indices).
 * Each instance draws its own quad via per-instance attribute data.
 */
export class QuadIndexBuffer {
  public readonly buf: WebGLBuffer;
  private _gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this._gl = gl;
    this.buf = gl.createBuffer()!;

    // A single quad: two triangles, CCW winding
    const indices = new Uint16Array([0, 1, 2, 2, 3, 0]);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  bind(): void {
    this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, this.buf);
  }

  dispose(): void {
    this._gl.deleteBuffer(this.buf);
  }
}
