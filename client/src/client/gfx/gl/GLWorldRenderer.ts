/**
 * GLWorldRenderer — WebGL2 world rendering coordinator.
 *
 * Manages the full GL pipeline for world-space objects:
 *   ocean background, island resource sprites, players, cannonballs.
 *
 * Usage in RenderSystem:
 *   // After GL canvas is set up:
 *   rs.setGLRenderer(new GLWorldRenderer(glCtx));
 *
 *   // Each frame, wrap renderWorld():
 *   rs.beginGLFrame(camX, camY, zoom, elapsedSec);
 *   rs.renderWorld(worldState, camera, alpha);
 *   rs.endGLFrame();
 *
 * The two canvases are layered:
 *   [GL canvas — ocean + sprites]  ← bottom
 *   [Canvas 2D — ships, UI, text]  ← top (CSS position:absolute)
 *
 * When GLWorldRenderer is active, RenderSystem:
 *   • Clears Canvas 2D to transparent (no opaque ocean fill)
 *   • Skips drawImage calls for atlas sprites (GL already drew them)
 *   • Keeps all Canvas 2D overlay draws (hover rings, prompts, names, ships…)
 */

import { GLContext }      from './GLContext.js';
import { SpriteBatcher }  from './SpriteBatcher.js';
import { SpriteAtlas }    from './SpriteAtlas.js';
import { TextureManager } from './TextureManager.js';
import { OceanRenderer }  from './OceanRenderer.js';

// ── World-unit sizes (derived from RenderSystem sprite constants) ─────────
//   worldSize = spriteSize * worldRadius / spriteRadius
const TREE_LEAF_WORLD_W  = 256 * 72  / (256 * 0.38);  // ≈ 189.5 per size unit
const TRUNK_WORLD_W      = 96  * 18  / 30;             // ≈ 57.6 per size unit
const ROCK_WORLD_W       = 96  * 6   / 22;             // ≈ 26.2
const BOULDER_WORLD_W    = 160 * 40  / 52;             // ≈ 123.1 per size unit
const FIBER_WORLD_W      = 96  * 60  / 32;             // ≈ 180.0

// ── Player colour states ──────────────────────────────────────────────────
export type PlayerColorState = 'friendly' | 'mounted' | 'swimming' | 'enemy';

const PLAYER_COLORS: Record<PlayerColorState, string> = {
  friendly: '#00ff00',
  mounted:  '#0099ff',
  swimming: '#ff4444',
  enemy:    '#cc2222',
};

// ── GLWorldRenderer ───────────────────────────────────────────────────────

export class GLWorldRenderer {
  private readonly _gl:    GLContext;
  private readonly _tex:   TextureManager;
  private readonly _batch: SpriteBatcher;
  private readonly _atlas: SpriteAtlas;
  private readonly _ocean: OceanRenderer;

  /** Pre-baked 64×64 textures keyed by PlayerColorState. */
  private readonly _playerTex:     Map<PlayerColorState, WebGLTexture>;
  /** Pre-baked 32×32 cannonball textures: 'normal' | 'ghost'. */
  private readonly _cannonballTex: Map<string, WebGLTexture>;

  private _viewProj: Float32Array = new Float32Array(16);
  private _frameActive = false;

  constructor(ctx: GLContext) {
    this._gl    = ctx;
    this._tex   = new TextureManager(ctx.gl, 512);
    this._batch = new SpriteBatcher(ctx, this._tex);
    this._atlas = SpriteAtlas.build(ctx.gl, this._tex);
    this._ocean = new OceanRenderer(ctx);

    this._playerTex     = this._bakePlayerTextures(ctx.gl);
    this._cannonballTex = this._bakeCannonballTextures(ctx.gl);

    console.log('[GL] GLWorldRenderer ready');
  }

  // ── Frame lifecycle ───────────────────────────────────────────────────────

  /**
   * Call once at the start of each world render, BEFORE RenderSystem.renderWorld().
   */
  beginFrame(
    camX: number,
    camY: number,
    zoom: number,
    timeSec: number,
    viewWidth?: number,
    viewHeight?: number,
  ): void {
    this._gl.resize(this._gl.canvas.width, this._gl.canvas.height);
    this._gl.beginFrame();
    this._ocean.render(camX, camY, zoom, timeSec, viewWidth, viewHeight);
    this._viewProj = this._gl.buildCameraOrtho(camX, camY, zoom);
    this._tex.beginFrame(Math.round(timeSec * 60));
    this._batch.begin(this._viewProj);
    this._frameActive = true;
  }

  /**
   * Call once after RenderSystem.renderWorld() finishes to flush the batcher.
   */
  endFrame(): void {
    if (!this._frameActive) return;
    this._batch.end();
    this._frameActive = false;
  }

  /** Number of GL draw calls in the last frame (for perf HUD). */
  get drawCallCount(): number { return this._batch.drawCallCount; }

  // ── Island resources ──────────────────────────────────────────────────────

  drawTreeLeaves(
    wx: number, wy: number,
    size: number,
    tintIdx: number, rotBin: number,
    alpha: number,
  ): void {
    const uv  = this._atlas.getUV(SpriteAtlas.keyTreeLeaf(tintIdx, rotBin));
    const dim = TREE_LEAF_WORLD_W * size;
    this._batch.draw({ x: wx, y: wy, w: dim, h: dim, angle: 0,
      u0: uv.u0, v0: uv.v0, u1: uv.u1, v1: uv.v1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: this._atlas.texture });
  }

  drawTreeTrunk(
    wx: number, wy: number,
    size: number,
    state: 'normal' | 'hovered' | 'inrange',
    alpha: number,
  ): void {
    const uv  = this._atlas.getUV(SpriteAtlas.keyTrunk(state));
    const dim = TRUNK_WORLD_W * size;
    this._batch.draw({ x: wx, y: wy, w: dim, h: dim, angle: 0,
      u0: uv.u0, v0: uv.v0, u1: uv.u1, v1: uv.v1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: this._atlas.texture });
  }

  drawRock(
    wx: number, wy: number,
    toneIdx: number, shapeIdx: number,
    hovered: boolean,
    alpha: number,
  ): void {
    const uv  = this._atlas.getUV(SpriteAtlas.keyRock(toneIdx, shapeIdx, hovered));
    const dim = ROCK_WORLD_W;
    this._batch.draw({ x: wx, y: wy, w: dim, h: dim, angle: 0,
      u0: uv.u0, v0: uv.v0, u1: uv.u1, v1: uv.v1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: this._atlas.texture });
  }

  drawBoulder(
    wx: number, wy: number,
    size: number,
    toneIdx: number, shapeIdx: number,
    hovered: boolean,
    rotation: number,
    alpha: number,
  ): void {
    const uv  = this._atlas.getUV(SpriteAtlas.keyBoulder(toneIdx, shapeIdx, hovered));
    const dim = BOULDER_WORLD_W * size;
    this._batch.draw({ x: wx, y: wy, w: dim, h: dim, angle: rotation,
      u0: uv.u0, v0: uv.v0, u1: uv.u1, v1: uv.v1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: this._atlas.texture });
  }

  drawFiber(
    wx: number, wy: number,
    tintIdx: number, variantIdx: number,
    hovered: boolean,
    rotation: number,
    alpha: number,
  ): void {
    const uv  = this._atlas.getUV(SpriteAtlas.keyFiber(tintIdx, variantIdx, hovered));
    const dim = FIBER_WORLD_W;
    this._batch.draw({ x: wx, y: wy, w: dim, h: dim, angle: rotation,
      u0: uv.u0, v0: uv.v0, u1: uv.u1, v1: uv.v1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: this._atlas.texture });
  }

  // ── Players ───────────────────────────────────────────────────────────────

  /**
   * Draw the player circle body.
   * The Canvas 2D layer still draws the direction arrow, name, and status effects on top.
   */
  drawPlayer(
    wx: number, wy: number,
    radius: number,
    colorState: PlayerColorState,
    alpha: number,
  ): void {
    const tex = this._playerTex.get(colorState)!;
    const dim = radius * 2;
    this._batch.draw({ x: wx, y: wy, w: dim, h: dim, angle: 0,
      u0: 0, v0: 0, u1: 1, v1: 1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: tex });
  }

  // ── Cannonballs ───────────────────────────────────────────────────────────

  /** Draw the cannonball sphere. Trails are still rendered by Canvas 2D. */
  drawCannonball(
    wx: number, wy: number,
    radius: number,
    isGhost: boolean,
    alpha: number,
  ): void {
    const tex = this._cannonballTex.get(isGhost ? 'ghost' : 'normal')!;
    const dim = radius * 2;
    this._batch.draw({ x: wx, y: wy, w: dim, h: dim, angle: 0,
      u0: 0, v0: 0, u1: 1, v1: 1,
      r: alpha, g: alpha, b: alpha, a: alpha,
      texture: tex });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose(): void {
    this._batch.dispose();
    this._tex.dispose();
    this._ocean.dispose();
  }

  // ── Internal — texture generation ────────────────────────────────────────

  private _bakePlayerTextures(gl: WebGL2RenderingContext): Map<PlayerColorState, WebGLTexture> {
    const map = new Map<PlayerColorState, WebGLTexture>();
    const SIZE = 64;
    for (const [state, color] of Object.entries(PLAYER_COLORS) as [PlayerColorState, string][]) {
      const off = new OffscreenCanvas(SIZE, SIZE);
      const ctx = off.getContext('2d')!;
      const cx  = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 2;

      // White outline
      ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
      // Coloured body
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      // Inner shading
      const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(0,0,0,0.30)');
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();

      map.set(state, this._tex.upload(`player_${state}`, off as unknown as HTMLCanvasElement));
    }
    return map;
  }

  private _bakeCannonballTextures(gl: WebGL2RenderingContext): Map<string, WebGLTexture> {
    const map  = new Map<string, WebGLTexture>();
    const SIZE = 32;

    // Normal iron ball
    {
      const off = new OffscreenCanvas(SIZE, SIZE);
      const ctx = off.getContext('2d')!;
      const cx  = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1a'; ctx.fill();
      const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, 0, cx, cy, r);
      grad.addColorStop(0, 'rgba(120,120,130,0.8)');
      grad.addColorStop(0.5, 'rgba(60,60,70,0.4)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();
      map.set('normal', this._tex.upload('cannonball_normal', off as unknown as HTMLCanvasElement));
    }

    // Ghost spectral ball
    {
      const off = new OffscreenCanvas(SIZE, SIZE);
      const ctx = off.getContext('2d')!;
      const cx  = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#00cc66'; ctx.fill();
      const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      grad.addColorStop(0, 'rgba(180,255,220,0.7)');
      grad.addColorStop(1, 'rgba(0,80,40,0.2)');
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();
      map.set('ghost', this._tex.upload('cannonball_ghost', off as unknown as HTMLCanvasElement));
    }

    return map;
  }
}
