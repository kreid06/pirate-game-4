/**
 * WasmBridge.ts — TypeScript wrapper for pirate-sim.wasm
 *
 * Provides a type-safe API over the shared C physics library compiled to WASM.
 * Handles memory allocation and pointer management.
 *
 * Usage:
 *   await wasmBridge.initialize();
 *   const len = wasmBridge.vec2Length(3, 4); // → 5
 */

/* ─────────────────────────────────────────────────────────────────────────
   Emscripten module interface
   ───────────────────────────────────────────────────────────────────────── */

export interface WasmModule {
  ccall: (name: string, returnType: string | null, argTypes: string[], args: unknown[]) => unknown;
  cwrap: (name: string, returnType: string | null, argTypes: string[]) => (...args: unknown[]) => unknown;
  _malloc: (size: number) => number;
  _free:   (ptr: number) => void;
  HEAPF32: Float32Array;
  HEAP32:  Int32Array;
  onRuntimeInitialized?: () => void;
}

/* ─────────────────────────────────────────────────────────────────────────
   Collision manifold (matches C wasm-bridge layout: 6 floats)
   ───────────────────────────────────────────────────────────────────────── */

export interface CollisionManifold {
  hit:      boolean;
  normalX:  number;
  normalY:  number;
  depth:    number;
  contactX: number;
  contactY: number;
}

/* ─────────────────────────────────────────────────────────────────────────
   WasmBridge class
   ───────────────────────────────────────────────────────────────────────── */

export class WasmBridge {
  private mod: WasmModule | null = null;
  private _ready = false;

  /* ── Lifecycle ─────────────────────────────────────────────────────────── */

  /**
   * Load and initialise the WASM module.
   * @param scriptUrl  URL of the Emscripten JS loader (default: /wasm/pirate-sim.js)
   */
  async initialize(scriptUrl = '/wasm/pirate-sim.js'): Promise<void> {
    if (this._ready) return;

    return new Promise<void>((resolve, reject) => {
      // Pre-configure Module before the script runs so Emscripten picks it up.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).Module = {
        onRuntimeInitialized: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.mod   = (window as any).Module as WasmModule;
          this._ready = true;
          resolve();
        },
      };

      const script = document.createElement('script');
      script.src     = scriptUrl;
      script.onerror = () => reject(new Error(`Failed to load WASM script: ${scriptUrl}`));
      document.head.appendChild(script);
    });
  }

  get isReady(): boolean { return this._ready; }

  private assertReady(): WasmModule {
    if (!this.mod || !this._ready) throw new Error('WasmBridge: not initialized');
    return this.mod;
  }

  /* ── Scratch-buffer helpers ────────────────────────────────────────────── */

  /** Allocate n floats, write fn, read result, free. */
  private withFloatBuf<T>(nFloats: number, fn: (ptr: number, view: Float32Array) => T): T {
    const m   = this.assertReady();
    const ptr = m._malloc(nFloats * 4);
    const view = m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + nFloats);
    const result = fn(ptr, view);
    m._free(ptr);
    return result;
  }

  /* ── Vec2 math ─────────────────────────────────────────────────────────── */

  vec2Length(x: number, y: number): number {
    return this.assertReady().ccall('vec2_length_wasm', 'number', ['number', 'number'], [x, y]) as number;
  }

  vec2Normalize(x: number, y: number): [number, number] {
    return this.withFloatBuf(2, (ptr, v) => {
      this.assertReady().ccall('vec2_normalize_wasm', null,
        ['number', 'number', 'number', 'number'], [x, y, ptr, ptr + 4]);
      return [v[0], v[1]] as [number, number];
    });
  }

  vec2Rotate(x: number, y: number, radians: number): [number, number] {
    return this.withFloatBuf(2, (ptr, v) => {
      this.assertReady().ccall('vec2_rotate_wasm', null,
        ['number', 'number', 'number', 'number', 'number'], [x, y, radians, ptr, ptr + 4]);
      return [v[0], v[1]] as [number, number];
    });
  }

  vec2Distance(x1: number, y1: number, x2: number, y2: number): number {
    return this.assertReady().ccall('vec2_distance_wasm', 'number',
      ['number', 'number', 'number', 'number'], [x1, y1, x2, y2]) as number;
  }

  /* ── Utilities ─────────────────────────────────────────────────────────── */

  degToRad(degrees: number): number {
    return this.assertReady().ccall('deg_to_rad_wasm', 'number', ['number'], [degrees]) as number;
  }

  radToDeg(radians: number): number {
    return this.assertReady().ccall('rad_to_deg_wasm', 'number', ['number'], [radians]) as number;
  }

  /* ── Collision ─────────────────────────────────────────────────────────── */

  private readManifold(view: Float32Array): CollisionManifold {
    return {
      hit:      view[0] !== 0,
      normalX:  view[1],
      normalY:  view[2],
      depth:    view[3],
      contactX: view[4],
      contactY: view[5],
    };
  }

  circleVsCircle(cx1: number, cy1: number, r1: number,
                  cx2: number, cy2: number, r2: number): CollisionManifold {
    return this.withFloatBuf(6, (ptr, v) => {
      this.assertReady().ccall('circle_vs_circle_wasm', null,
        ['number','number','number','number','number','number','number'],
        [cx1, cy1, r1, cx2, cy2, r2, ptr]);
      return this.readManifold(v);
    });
  }

  aabbVsCircle(minX: number, minY: number, maxX: number, maxY: number,
               cx: number, cy: number, r: number): CollisionManifold {
    return this.withFloatBuf(6, (ptr, v) => {
      this.assertReady().ccall('aabb_vs_circle_wasm', null,
        ['number','number','number','number','number','number','number','number'],
        [minX, minY, maxX, maxY, cx, cy, r, ptr]);
      return this.readManifold(v);
    });
  }

  /**
   * Polygon vs Circle collision (SAT).
   * @param verts  Flat array [x0,y0, x1,y1, ...]
   */
  polyVsCircle(verts: number[], cx: number, cy: number, r: number): CollisionManifold {
    const m   = this.assertReady();
    const n   = verts.length; // number of floats (2 per vertex)
    const vertsPtr = m._malloc(n * 4);
    m.HEAPF32.set(verts, vertsPtr >> 2);

    return this.withFloatBuf(6, (outPtr, v) => {
      m.ccall('poly_vs_circle_wasm', null,
        ['number','number','number','number','number','number'],
        [vertsPtr, n / 2, cx, cy, r, outPtr]);
      const result = this.readManifold(v);
      m._free(vertsPtr);
      return result;
    });
  }

  /* ── Ship physics ──────────────────────────────────────────────────────── */

  /**
   * Advance ship state by dt seconds.
   * @param state  [posX, posY, velX, velY, rotation, angularVel, sailOpenness, rudderAngle]
   * @returns      Updated state array (same layout, mutated in place).
   */
  shipStep(state: Float32Array, sailDelta: -1 | 0 | 1, rudderDelta: -1 | 0 | 1, dt: number): void {
    const m   = this.assertReady();
    const ptr = m._malloc(32); // 8 floats
    m.HEAPF32.set(state, ptr >> 2);
    m.ccall('ship_step_wasm', null,
      ['number','number','number','number'], [ptr, sailDelta, rudderDelta, dt]);
    state.set(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + 8));
    m._free(ptr);
  }

  /**
   * Advance player state by dt seconds.
   * @param state  [posX, posY, velX, velY, rotation]
   */
  playerStep(state: Float32Array, moveX: number, moveY: number, sprinting: boolean, dt: number): void {
    const m   = this.assertReady();
    const ptr = m._malloc(20); // 5 floats
    m.HEAPF32.set(state, ptr >> 2);
    m.ccall('player_step_wasm', null,
      ['number','number','number','number','number'],
      [ptr, moveX, moveY, sprinting ? 1 : 0, dt]);
    state.set(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + 5));
    m._free(ptr);
  }

  /**
   * Advance projectile state by dt seconds.
   * @param state  [posX, posY, velX, velY, lifetime]
   * @returns true if still alive.
   */
  projectileStep(state: Float32Array, dt: number): boolean {
    const m   = this.assertReady();
    const ptr = m._malloc(20); // 5 floats
    m.HEAPF32.set(state, ptr >> 2);
    const alive = m.ccall('projectile_step_wasm', 'number', ['number','number'], [ptr, dt]) as number;
    state.set(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + 5));
    m._free(ptr);
    return alive !== 0;
  }

  /**
   * Convex polygon vs convex polygon collision (SAT).
   * @param vertsA  Flat array [x0,y0, x1,y1, ...] for polygon A
   * @param vertsB  Flat array [x0,y0, x1,y1, ...] for polygon B
   */
  polyVsPoly(vertsA: number[], vertsB: number[]): CollisionManifold {
    const m    = this.assertReady();
    const nA   = vertsA.length;
    const nB   = vertsB.length;
    const ptrA = m._malloc(nA * 4);
    const ptrB = m._malloc(nB * 4);
    m.HEAPF32.set(vertsA, ptrA >> 2);
    m.HEAPF32.set(vertsB, ptrB >> 2);

    return this.withFloatBuf(6, (outPtr, v) => {
      m.ccall('poly_vs_poly_wasm', null,
        ['number','number','number','number','number'],
        [ptrA, nA / 2, ptrB, nB / 2, outPtr]);
      const result = this.readManifold(v);
      m._free(ptrA);
      m._free(ptrB);
      return result;
    });
  }
}

// Singleton instance
export const wasmBridge = new WasmBridge();

