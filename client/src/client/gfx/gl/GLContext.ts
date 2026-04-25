/**
 * GLContext — WebGL2 context wrapper.
 *
 * Owns the WebGL2 rendering context and provides helpers for:
 *   • Initialisation with capability check
 *   • Canvas resize handling
 *   • Per-frame clear
 *   • Orthographic camera matrix
 *   • Graceful fallback detection
 */

export interface GLCapabilities {
  floatTextures: boolean;
  instancedArrays: boolean;   // always true in WebGL2 core
  maxTextureSize: number;
  maxTextureUnits: number;
}

export class GLContext {
  public readonly gl: WebGL2RenderingContext;
  public readonly canvas: HTMLCanvasElement;
  public readonly caps: GLCapabilities;

  public width  = 0;
  public height = 0;

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl     = gl;
    this.caps   = this._queryCapabilities();
    this._configureDefaults();
    this.resize(canvas.width, canvas.height);
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Attempt to create a WebGL2 context on the given canvas.
   * Returns null if unavailable — caller should fall back to Canvas 2D.
   */
  static create(canvas: HTMLCanvasElement): GLContext | null {
    const gl = canvas.getContext('webgl2', {
      alpha:                 true,   // transparent so Canvas 2D UI overlay composites on top
      antialias:             false,
      depth:                 false,  // pure 2D — layer order via draw order
      stencil:               false,
      premultipliedAlpha:    false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;

    if (!gl) {
      console.warn('[GL] WebGL2 not available — falling back to Canvas 2D');
      return null;
    }

    console.log('[GL] WebGL2 context created');
    return new GLContext(canvas, gl);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Call whenever the canvas is resized. */
  resize(w: number, h: number): void {
    this.width  = w;
    this.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  /** Clear colour buffer at the start of each frame. */
  beginFrame(): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);   // fully transparent — ocean shader fills the background
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // ── Matrix helpers ────────────────────────────────────────────────────────

  /**
   * Column-major orthographic projection matrix (Float32Array, mat4).
   * Y-down convention to match Canvas 2D / world space.
   */
  buildOrthoMatrix(
    left: number, right: number,
    top:  number, bottom: number,
  ): Float32Array {
    const lr = 1 / (right - left);
    const tb = 1 / (top   - bottom);
    // prettier-ignore
    return new Float32Array([
      2 * lr,                    0,  0, 0,
      0,                    2 * tb,  0, 0,
      0,                         0, -1, 0,
      -(right + left) * lr, -(top + bottom) * tb, 0, 1,
    ]);
  }

  /**
   * Camera-centred ortho matrix.
   *   zoom = 1.0  → 1 pixel == 1 world unit
   *   zoom = 0.5  → zoomed out 2× (more world visible)
   */
  buildCameraOrtho(camX: number, camY: number, zoom: number): Float32Array {
    const hw = this.width  / 2 / zoom;
    const hh = this.height / 2 / zoom;
    return this.buildOrthoMatrix(camX - hw, camX + hw, camY - hh, camY + hh);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _queryCapabilities(): GLCapabilities {
    const gl = this.gl;
    return {
      floatTextures:   !!gl.getExtension('EXT_color_buffer_float'),
      instancedArrays: true,
      maxTextureSize:  gl.getParameter(gl.MAX_TEXTURE_SIZE)          as number,
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)   as number,
    };
  }

  private _configureDefaults(): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // premultiplied alpha
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }
}
