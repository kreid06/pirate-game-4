/**
 * TextureManager — upload and cache WebGL textures.
 *
 * Handles:
 *   • Uploading HTMLCanvasElement / OffscreenCanvas / ImageData as GL textures
 *   • LRU eviction when cache exceeds a memory budget
 *   • Optional mipmap generation for downscaled sprites
 *   • A "white 1×1 pixel" fallback texture for untextured quads
 */

export interface TextureEntry {
  tex:    WebGLTexture;
  width:  number;
  height: number;
  lastUsedFrame: number;
}

export class TextureManager {
  private readonly _gl:      WebGL2RenderingContext;
  private readonly _cache    = new Map<string | object, TextureEntry>();
  private readonly _maxEntries: number;
  private _frame = 0;

  /** A 1×1 opaque white texture useful as a "no texture" sentinel. */
  public readonly white: WebGLTexture;

  constructor(gl: WebGL2RenderingContext, maxEntries = 256) {
    this._gl         = gl;
    this._maxEntries = maxEntries;
    this.white       = this._createWhite();
  }

  // ── Frame tracking ────────────────────────────────────────────────────────

  /** Call once at the start of each frame to drive LRU eviction. */
  beginFrame(frameIndex: number): void {
    this._frame = frameIndex;
  }

  // ── Upload / retrieve ─────────────────────────────────────────────────────

  /**
   * Upload a canvas/image source and cache it under `key`.
   * If `key` already exists the texture is re-uploaded (updated).
   * Pass a stable object reference (e.g. the OffscreenCanvas itself) as key
   * to avoid string allocations in hot paths.
   */
  upload(
    key:    string | object,
    source: HTMLCanvasElement | OffscreenCanvas | ImageData,
    opts: { mipmap?: boolean; linear?: boolean } = {},
  ): WebGLTexture {
    const gl       = this._gl;
    let entry      = this._cache.get(key);
    let tex: WebGLTexture;

    if (entry) {
      tex = entry.tex;
    } else {
      this._maybeEvict();
      tex = gl.createTexture()!;
    }

    gl.bindTexture(gl.TEXTURE_2D, tex);

    const filter = opts.linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mipmap ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (source instanceof ImageData) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as HTMLCanvasElement);
    }

    if (opts.mipmap) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const w = source instanceof ImageData ? source.width  : (source as HTMLCanvasElement).width;
    const h = source instanceof ImageData ? source.height : (source as HTMLCanvasElement).height;

    entry = { tex, width: w, height: h, lastUsedFrame: this._frame };
    this._cache.set(key, entry);
    return tex;
  }

  /**
   * Retrieve a cached texture without re-uploading.
   * Updates the LRU timestamp.
   */
  get(key: string | object): TextureEntry | undefined {
    const entry = this._cache.get(key);
    if (entry) entry.lastUsedFrame = this._frame;
    return entry;
  }

  /**
   * Bind a texture to a texture unit.
   *   gl.uniform1i(loc, unit) must be set separately.
   */
  bind(tex: WebGLTexture, unit = 0): void {
    const gl = this._gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  bindWhite(unit = 0): void {
    this.bind(this.white, unit);
  }

  /** Delete a specific cache entry. */
  evict(key: string | object): void {
    const entry = this._cache.get(key);
    if (entry) {
      this._gl.deleteTexture(entry.tex);
      this._cache.delete(key);
    }
  }

  /** Release all GPU textures. */
  dispose(): void {
    for (const entry of this._cache.values()) {
      this._gl.deleteTexture(entry.tex);
    }
    this._cache.clear();
    this._gl.deleteTexture(this.white);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _createWhite(): WebGLTexture {
    const gl  = this._gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  private _maybeEvict(): void {
    if (this._cache.size < this._maxEntries) return;
    // Evict the least-recently-used entry
    let oldest = Infinity;
    let oldKey: (string | object) | null = null;
    for (const [k, v] of this._cache) {
      if (v.lastUsedFrame < oldest) { oldest = v.lastUsedFrame; oldKey = k; }
    }
    if (oldKey !== null) this.evict(oldKey);
  }
}
