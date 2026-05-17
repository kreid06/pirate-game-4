/**
 * WasmBridge.ts — TypeScript wrapper for pirate-sim.wasm
 * 
 * Provides type-safe API for calling shared C code from JavaScript.
 * Handles memory allocation and pointer management.
 */

export interface WasmModule {
  ccall: (name: string, returnType: string, argTypes: string[], args: any[]) => any;
  cwrap: (name: string, returnType: string, argTypes: string[]) => (...args: any[]) => any;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
}

export class WasmBridge {
  private module: WasmModule | null = null;
  private ready = false;

  /**
   * Load and initialize the WASM module.
   * @param wasmUrl Path to pirate-sim.wasm
   */
  async initialize(wasmUrl: string = '/wasm/pirate-sim.js'): Promise<void> {
    if (this.ready) return;

    // Emscripten creates a global Module
    const script = document.createElement('script');
    script.src = wasmUrl;
    
    return new Promise((resolve, reject) => {
      script.onload = () => {
        // Wait for Module to be ready
        setTimeout(() => {
          // @ts-ignore - Emscripten creates global Module
          if (typeof Module !== 'undefined') {
            this.module = Module;
            this.ready = true;
            resolve();
          } else {
            reject(new Error('WASM module failed to load'));
          }
        }, 100);
      };
      script.onerror = () => reject(new Error('Failed to load WASM script'));
      document.head.appendChild(script);
    });
  }

  /**
   * Check if WASM is ready
   */
  isReady(): boolean {
    return this.ready && this.module !== null;
  }

  /* ────────────────────────────────────────────────────────────────────────
     Vec2 Math
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * Calculate length of vector [x, y]
   */
  vec2Length(x: number, y: number): number {
    if (!this.module) throw new Error('WASM not initialized');
    return this.module.ccall('vec2_length_wasm', 'number', ['number', 'number'], [x, y]);
  }

  /**
   * Normalize vector [x, y]
   */
  vec2Normalize(x: number, y: number): [number, number] {
    if (!this.module) throw new Error('WASM not initialized');
    
    const ptr = this.module._malloc(8); // 2 floats
    this.module.ccall('vec2_normalize_wasm', null, 
      ['number', 'number', 'number', 'number'], 
      [x, y, ptr, ptr + 4]);
    
    const view = new Float32Array(this.module.memory.buffer, ptr, 2);
    const result: [number, number] = [view[0], view[1]];
    this.module._free(ptr);
    return result;
  }

  /**
   * Rotate vector [x, y] by radians
   */
  vec2Rotate(x: number, y: number, radians: number): [number, number] {
    if (!this.module) throw new Error('WASM not initialized');
    
    const ptr = this.module._malloc(8);
    this.module.ccall('vec2_rotate_wasm', null,
      ['number', 'number', 'number', 'number', 'number'],
      [x, y, radians, ptr, ptr + 4]);
    
    const view = new Float32Array(this.module.memory.buffer, ptr, 2);
    const result: [number, number] = [view[0], view[1]];
    this.module._free(ptr);
    return result;
  }

  /**
   * Distance between two points
   */
  vec2Distance(x1: number, y1: number, x2: number, y2: number): number {
    if (!this.module) throw new Error('WASM not initialized');
    return this.module.ccall('vec2_distance_wasm', 'number',
      ['number', 'number', 'number', 'number'],
      [x1, y1, x2, y2]);
  }

  /* ────────────────────────────────────────────────────────────────────────
     Circle Collision
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * Test if two circles overlap
   */
  circleOverlapsCircle(cx1: number, cy1: number, r1: number,
                       cx2: number, cy2: number, r2: number): boolean {
    if (!this.module) throw new Error('WASM not initialized');
    const result = this.module.ccall('circle_overlaps_circle_wasm', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number'],
      [cx1, cy1, r1, cx2, cy2, r2]);
    return result !== 0;
  }

  /* ────────────────────────────────────────────────────────────────────────
     Utilities
     ──────────────────────────────────────────────────────────────────────── */

  degToRad(degrees: number): number {
    if (!this.module) throw new Error('WASM not initialized');
    return this.module.ccall('deg_to_rad_wasm', 'number', ['number'], [degrees]);
  }

  radToDeg(radians: number): number {
    if (!this.module) throw new Error('WASM not initialized');
    return this.module.ccall('rad_to_deg_wasm', 'number', ['number'], [radians]);
  }
}

// Singleton instance
export const wasmBridge = new WasmBridge();
