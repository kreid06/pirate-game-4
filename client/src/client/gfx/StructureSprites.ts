/**
 * StructureSprites — cached OffscreenCanvas sprites for island placed structures.
 *
 * Base geometry is baked once per variant key, then blitted each frame via drawImage
 * (same pattern as ship hull sprites). Dynamic overlays (HP bars, schematic progress,
 * claim timers, ceiling visibility) stay on the live Canvas 2D context in RenderSystem.
 */

import type { PlacedStructure } from '../../sim/Types.js';
import { tierColor } from '../../sim/Quality.js';

export const STRUCT_TILE = 50;

/** Ownership strip color for wooden structures. */
export function structureCompanyColor(companyId: number): string {
  if (companyId === 1) return 'rgba(255, 100, 50, 0.85)';  // Pirates
  if (companyId === 2) return 'rgba(50, 130, 255, 0.85)';  // Navy
  return 'rgba(160, 160, 160, 0.60)';                       // Neutral
}

/** Flag / fort pennant color. */
export function structureFlagColor(companyId: number): string {
  if (companyId === 0) return '#888888';
  if (companyId === 1) return '#ddaa00';
  if (companyId === 2) return '#cc3333';
  if (companyId === 3) return '#3366cc';
  if (companyId === 99) return '#33cc99';
  const palette = ['#e06c22', '#22a0e0', '#22e06c', '#e022a0', '#a0e022', '#6c22e0', '#e0a022', '#22e0a0'];
  return palette[(companyId - 100) % palette.length];
}

export interface StructureSprite {
  canvas: OffscreenCanvas;
  /** Width in world units at zoom = 1. */
  w: number;
  /** Height in world units at zoom = 1. */
  h: number;
}

export class StructureSpriteCache {
  private readonly _map = new Map<string, StructureSprite>();

  get(key: string, build: () => StructureSprite): StructureSprite {
    let s = this._map.get(key);
    if (!s) {
      s = build();
      this._map.set(key, s);
    }
    return s;
  }
}

/** Quantize HP damage into 4 buckets for sprite cache keys. */
export function hpDamageBucket(hpFrac: number): number {
  return Math.min(3, Math.floor((1 - hpFrac) * 4));
}

function dmgDarkenFromBucket(bucket: number): number {
  return bucket * 0.25 * 0.75;
}

function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

function bake(draw: (ctx: OffscreenCanvasRenderingContext2D) => { w: number; h: number }): StructureSprite {
  // First pass: measure via a throwaway context at origin
  const probe = makeCanvas(1, 1);
  const dims = draw(probe.ctx);
  const pad = 2;
  const { canvas, ctx } = makeCanvas(dims.w + pad * 2, dims.h + pad * 2);
  ctx.translate(pad + dims.w / 2, pad + dims.h / 2);
  draw(ctx);
  return { canvas, w: dims.w, h: dims.h };
}

// ── Blit helper ───────────────────────────────────────────────────────────

export function blitStructureSprite(
  ctx: CanvasRenderingContext2D,
  sprite: StructureSprite,
  screenX: number,
  screenY: number,
  zoom: number,
  rotRad: number,
  camRot: number,
  alpha = 1,
): void {
  const sw = sprite.w * zoom;
  const sh = sprite.h * zoom;
  ctx.save();
  if (alpha !== 1) ctx.globalAlpha = alpha;
  ctx.translate(screenX, screenY);
  ctx.rotate(rotRad - camRot);
  ctx.drawImage(sprite.canvas as unknown as CanvasImageSource, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
}

// ── Variant key builders ──────────────────────────────────────────────────

export interface StructureSpriteOpts {
  hovered: boolean;
  blocker?: boolean;
  companyId: number;
  hpFrac: number;
  doorOpen?: boolean;
  building?: boolean;
  fortressComplete?: boolean;
  wreckTier?: number;
  wreckHasLoot?: boolean;
  /** Wall / door orientation derived from nearest floor tile. */
  wallRotRad?: number;
}

function keyPart(opts: StructureSpriteOpts): string {
  const d = hpDamageBucket(opts.hpFrac);
  const h = opts.hovered ? 1 : 0;
  const b = opts.blocker ? 1 : 0;
  return `h${h}:b${b}:c${opts.companyId}:d${d}`;
}

// ── Bake functions ────────────────────────────────────────────────────────

export function getWoodenFloorSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `floor:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const baseColor = opts.blocker ? '#cc3322' : opts.hovered ? '#d09a3a' : '#b8832b';
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    ctx.fillStyle = baseColor;
    ctx.strokeStyle = '#7a5520';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(-sz / 2, -sz / 2, sz, sz);
    ctx.fill();
    ctx.stroke();
    if (dmgDarken > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
    }
    ctx.strokeStyle = 'rgba(90, 55, 15, 0.5)';
    ctx.lineWidth = 1;
    const third = sz / 3;
    for (let li = 1; li < 3; li++) {
      ctx.beginPath();
      ctx.moveTo(-sz / 2, -sz / 2 + li * third);
      ctx.lineTo(sz / 2, -sz / 2 + li * third);
      ctx.stroke();
    }
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(-sz / 2, -sz / 2, sz, 3);
    return { w: sz, h: sz };
  }));
}

export function getWorkbenchSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `workbench:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const bw = sz * 0.88;
    const bh = sz * 0.62;
    const bx = -bw / 2;
    const by = -bh / 2;
    ctx.fillStyle = opts.hovered ? '#5a3010' : '#4a2408';
    ctx.strokeStyle = '#2a1204';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.stroke();
    const ft = 4;
    const sx2 = bx + ft, sy2 = by + ft;
    const sw = bw - ft * 2, sh = bh - ft * 2;
    ctx.fillStyle = opts.hovered ? '#c07838' : '#a86428';
    ctx.beginPath();
    ctx.rect(sx2, sy2, sw, sh);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60, 30, 8, 0.35)';
    ctx.lineWidth = 1;
    for (let gi = 1; gi < 3; gi++) {
      const gy = sy2 + sh * (gi / 3);
      ctx.beginPath();
      ctx.moveTo(sx2, gy);
      ctx.lineTo(sx2 + sw, gy);
      ctx.stroke();
    }
    const vw = 5, vh = sh * 0.45;
    const vx = sx2 + sw - vw, vy = sy2 + (sh - vh) / 2;
    ctx.fillStyle = opts.hovered ? '#888' : '#6a6a6a';
    ctx.strokeStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.rect(vx, vy, vw, vh);
    ctx.fill();
    ctx.stroke();
    const legSz = 3.5;
    ctx.fillStyle = '#2a1204';
    for (const [lx, ly] of [[bx, by], [bx + bw - legSz, by], [bx, by + bh - legSz], [bx + bw - legSz, by + bh - legSz]]) {
      ctx.fillRect(lx, ly, legSz, legSz);
    }
    ctx.font = '10px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 210, 100, 0.9)';
    ctx.fillText('\u2692', -vw / 2, 0);
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(bx, by, bw, 3);
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    if (dmgDarken > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      ctx.fillRect(bx, by, bw, bh);
    }
    return { w: bw, h: bh };
  }));
}

export function getWallSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `wall:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const THICK = 0.18;
    const ww = sz;
    const wh = sz * THICK;
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    ctx.fillStyle = opts.hovered ? '#7a5030' : '#5c3a1a';
    ctx.strokeStyle = '#2e1a08';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(-ww / 2, -wh / 2, ww, wh);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(40, 20, 5, 0.4)';
    ctx.lineWidth = 0.8;
    for (let li = 1; li < 3; li++) {
      const gx = -ww / 2 + ww * (li / 3);
      ctx.beginPath();
      ctx.moveTo(gx, -wh / 2);
      ctx.lineTo(gx, wh / 2);
      ctx.stroke();
    }
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(-ww / 2, -wh / 2, ww, 2);
    if (dmgDarken > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      ctx.fillRect(-ww / 2, -wh / 2, ww, wh);
    }
    return { w: ww, h: wh };
  }));
}

export function getDoorFrameSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `door_frame:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const THICK = 0.18;
    const ww = sz;
    const wh = sz * THICK;
    const POST = sz * 0.14;
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    ctx.fillStyle = opts.hovered ? '#9a6040' : '#7a4820';
    ctx.strokeStyle = '#3e200c';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-ww / 2, -POST / 2, POST, POST);
    ctx.strokeRect(-ww / 2, -POST / 2, POST, POST);
    ctx.fillRect(ww / 2 - POST, -POST / 2, POST, POST);
    ctx.strokeRect(ww / 2 - POST, -POST / 2, POST, POST);
    ctx.strokeStyle = 'rgba(120, 70, 30, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(-ww / 2 + POST, -wh / 2);
    ctx.lineTo(ww / 2 - POST, -wh / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-ww / 2 + POST, wh / 2);
    ctx.lineTo(ww / 2 - POST, wh / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(-ww / 2, -POST / 2, POST, 2);
    if (dmgDarken > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      ctx.fillRect(-ww / 2, -POST / 2, POST, POST);
      ctx.fillRect(ww / 2 - POST, -POST / 2, POST, POST);
    }
    return { w: ww, h: POST };
  }));
}

export function getDoorSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const open = opts.doorOpen ? 1 : 0;
  const key = `door:${keyPart(opts)}:o${open}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const THICK = 0.18;
    const ww = sz;
    const wh = sz * THICK;
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    if (!opts.doorOpen) {
      ctx.fillStyle = opts.hovered ? '#9a6040' : '#7a4820';
      ctx.strokeStyle = '#3e200c';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(-ww / 2, -wh / 2, ww, wh);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(30, 12, 4, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -wh / 2);
      ctx.lineTo(0, wh / 2);
      ctx.stroke();
      if (dmgDarken > 0.01) {
        ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
        ctx.fillRect(-ww / 2, -wh / 2, ww, wh);
      }
    } else {
      const postSz = sz * 0.15;
      ctx.fillStyle = opts.hovered ? '#9a6040' : '#7a4820';
      ctx.strokeStyle = '#3e200c';
      ctx.lineWidth = 1.5;
      ctx.fillRect(-ww / 2, -wh / 2, postSz, wh);
      ctx.strokeRect(-ww / 2, -wh / 2, postSz, wh);
      ctx.fillRect(ww / 2 - postSz, -wh / 2, postSz, wh);
      ctx.strokeRect(ww / 2 - postSz, -wh / 2, postSz, wh);
      ctx.strokeStyle = 'rgba(150, 100, 60, 0.35)';
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(-ww / 2, -wh / 2, ww, wh);
      ctx.setLineDash([]);
    }
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(-ww / 2, -wh / 2, ww, 2);
    return { w: ww, h: wh };
  }));
}

export function getWoodCeilingSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `ceiling:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const fillCol = opts.hovered ? '#c8924a' : '#96642a';
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    ctx.fillStyle = fillCol;
    ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
    ctx.strokeStyle = 'rgba(50, 25, 5, 0.5)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-sz / 2, -sz / 2); ctx.lineTo(sz / 2, sz / 2);
    ctx.moveTo(sz / 2, -sz / 2); ctx.lineTo(-sz / 2, sz / 2);
    ctx.moveTo(-sz / 2, 0); ctx.lineTo(sz / 2, 0);
    ctx.stroke();
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(-sz / 2, -sz / 2, sz, 2);
    if (dmgDarken > 0.01) {
      ctx.globalAlpha = dmgDarken;
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
      ctx.globalAlpha = 1;
    }
    return { w: sz, h: sz };
  }));
}

export function getChestSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `chest:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const cw = sz * 0.72;
    const ch = sz * 0.52;
    const cx2 = -cw / 2;
    const cy2 = -ch / 2;
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    ctx.fillStyle = opts.hovered ? '#7a4820' : '#5c3210';
    ctx.strokeStyle = '#2a1204';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cx2, cy2, cw, ch);
    ctx.fill();
    ctx.stroke();
    const lidH = ch * 0.35;
    ctx.fillStyle = opts.hovered ? '#c0813a' : '#a06428';
    ctx.fillRect(cx2, cy2, cw, lidH);
    ctx.strokeRect(cx2, cy2, cw, lidH);
    const ltW = cw * 0.12, ltH = ch * 0.20;
    ctx.fillStyle = '#d4a040';
    ctx.strokeStyle = '#7a5010';
    ctx.fillRect(-ltW / 2, cy2 + lidH - ltH / 2, ltW, ltH);
    ctx.strokeRect(-ltW / 2, cy2 + lidH - ltH / 2, ltW, ltH);
    ctx.strokeStyle = 'rgba(40, 20, 8, 0.55)';
    ctx.beginPath();
    ctx.moveTo(cx2, cy2 + lidH);
    ctx.lineTo(cx2 + cw, cy2 + lidH);
    ctx.stroke();
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(cx2, cy2, cw, 2.5);
    if (dmgDarken > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      ctx.fillRect(cx2, cy2, cw, ch);
    }
    return { w: cw, h: ch };
  }));
}

export function getCannonBaseSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `cannon_base:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    ctx.fillStyle = opts.hovered ? '#b06030' : '#8B4513';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-15, -10, 30, 20);
    ctx.strokeRect(-15, -10, 30, 20);
    ctx.fillStyle = structureCompanyColor(opts.companyId);
    ctx.fillRect(-8, -4, 16, 2.5);
    if (dmgDarken > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      ctx.fillRect(-15, -10, 30, 20);
    }
    return { w: 30, h: 20 };
  }));
}

export function getCannonBarrelSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `cannon_barrel:h${opts.hovered ? 1 : 0}:d${hpDamageBucket(opts.hpFrac)}`;
  return cache.get(key, () => bake((ctx) => {
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    ctx.fillStyle = opts.hovered ? '#aaaaaa' : '#333333';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(-8, -40);
    ctx.lineTo(8, -40);
    ctx.lineTo(8, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (dmgDarken > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      ctx.fillRect(-8, -40, 16, 40);
    }
    return { w: 16, h: 40 };
  }));
}

export function getWreckSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const tier = opts.wreckTier ?? -1;
  const key = `wreck:h${opts.hovered ? 1 : 0}:t${tier}:l${opts.wreckHasLoot ? 1 : 0}`;
  return cache.get(key, () => bake((ctx) => {
    const wrsz = 60;
    ctx.fillStyle = '#5a3a18';
    ctx.strokeStyle = '#2e1a08';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-wrsz * 0.55, -wrsz * 0.25);
    ctx.lineTo(wrsz * 0.50, -wrsz * 0.30);
    ctx.lineTo(wrsz * 0.65, wrsz * 0.10);
    ctx.lineTo(wrsz * 0.20, wrsz * 0.35);
    ctx.lineTo(-wrsz * 0.60, wrsz * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#2e1a08';
    ctx.lineWidth = 1;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(-wrsz * 0.5, i * wrsz * 0.12);
      ctx.lineTo(wrsz * 0.5, i * wrsz * 0.12);
      ctx.stroke();
    }
    ctx.strokeStyle = '#7a5520';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-wrsz * 0.1, -wrsz * 0.05);
    ctx.lineTo(-wrsz * 0.1 + wrsz * 0.05, -wrsz * 0.5);
    ctx.stroke();
    if (opts.wreckHasLoot) {
      const glintColor = tier >= 0 ? tierColor(tier) : 'rgba(255, 220, 80, 0.85)';
      ctx.fillStyle = glintColor;
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    return { w: wrsz * 1.3, h: wrsz * 1.1 };
  }));
}

export function getFlagFortSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `flag_fort:${keyPart(opts)}`;
  return cache.get(key, () => bake((ctx) => {
    const hpFrac = opts.hpFrac;
    const ts = 44;
    const stoneR = Math.round(hpFrac * 120 + 60);
    const stoneG = Math.round(hpFrac * 100 + 50);
    const stoneB = Math.round(hpFrac * 80 + 40);
    const companyColor = structureFlagColor(opts.companyId);
    ctx.fillStyle = opts.hovered ? '#c8a860' : `rgb(${stoneR},${stoneG},${stoneB})`;
    ctx.strokeStyle = '#2a1a0a';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-ts * 0.45, -ts * 0.45, ts * 0.9, ts * 0.9);
    ctx.strokeRect(-ts * 0.45, -ts * 0.45, ts * 0.9, ts * 0.9);
    ctx.fillStyle = opts.hovered ? '#ddb870' : `rgb(${Math.min(255, stoneR + 15)},${Math.min(255, stoneG + 10)},${Math.min(255, stoneB + 8)})`;
    const mw = ts * 0.22, mh = ts * 0.2;
    for (let m = -1; m <= 1; m++) {
      ctx.fillRect(m * ts * 0.3 - mw / 2, -ts * 0.45 - mh, mw, mh);
      ctx.strokeRect(m * ts * 0.3 - mw / 2, -ts * 0.45 - mh, mw, mh);
    }
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ts * 0.08, -ts * 0.45);
    ctx.lineTo(ts * 0.08, -ts * 0.45 - ts * 0.75);
    ctx.stroke();
    ctx.fillStyle = companyColor;
    ctx.beginPath();
    ctx.moveTo(ts * 0.08, -ts * 0.45 - ts * 0.75);
    ctx.lineTo(ts * 0.08 + ts * 0.4, -ts * 0.45 - ts * 0.55);
    ctx.lineTo(ts * 0.08, -ts * 0.45 - ts * 0.35);
    ctx.closePath();
    ctx.fill();
    return { w: ts * 1.2, h: ts * 1.5 };
  }));
}

export function getCompanyFortressSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const complete = opts.fortressComplete ? 1 : 0;
  const key = `fortress:${keyPart(opts)}:f${complete}`;
  return cache.get(key, () => bake((ctx) => {
    const ts = 60;
    const hpFrac = opts.hpFrac;
    const stoneR = Math.round(hpFrac * 110 + 60);
    const stoneG = Math.round(hpFrac * 90 + 45);
    const stoneB = Math.round(hpFrac * 70 + 35);
    const companyColor = structureFlagColor(opts.companyId);
    const wallColor = opts.fortressComplete
      ? (opts.hovered ? '#c8a860' : `rgb(${stoneR},${stoneG},${stoneB})`)
      : '#887766';
    ctx.fillStyle = wallColor;
    ctx.strokeStyle = '#2a1a0a';
    ctx.lineWidth = 2;
    ctx.fillRect(-ts * 0.5, -ts * 0.5, ts, ts);
    ctx.strokeRect(-ts * 0.5, -ts * 0.5, ts, ts);
    const ctw = ts * 0.22;
    for (const [cx2, cy2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
      ctx.fillRect(cx2 * ts * 0.5 - ctw * (cx2 > 0 ? 0 : 1), cy2 * ts * 0.5 - ctw * (cy2 > 0 ? 0 : 1), ctw, ctw);
      ctx.strokeRect(cx2 * ts * 0.5 - ctw * (cx2 > 0 ? 0 : 1), cy2 * ts * 0.5 - ctw * (cy2 > 0 ? 0 : 1), ctw, ctw);
    }
    if (opts.fortressComplete) {
      ctx.strokeStyle = '#555';
      ctx.beginPath();
      ctx.moveTo(0, -ts * 0.5);
      ctx.lineTo(0, -ts * 0.5 - ts * 1.0);
      ctx.stroke();
      ctx.fillStyle = companyColor;
      ctx.beginPath();
      ctx.moveTo(0, -ts * 0.5 - ts * 1.0);
      ctx.lineTo(ts * 0.55, -ts * 0.5 - ts * 0.7);
      ctx.lineTo(0, -ts * 0.5 - ts * 0.4);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = '#b8a060cc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-ts * 0.5, -ts * 0.5); ctx.lineTo(ts * 0.5, ts * 0.5);
      ctx.moveTo(ts * 0.5, -ts * 0.5); ctx.lineTo(-ts * 0.5, ts * 0.5);
      ctx.stroke();
    }
    return { w: ts * 1.1, h: ts * 1.6 };
  }));
}

export function getClaimFlagSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const key = `claim_flag:c${opts.companyId}`;
  return cache.get(key, () => bake((ctx) => {
    const ringR = 18;
    const companyColor = structureFlagColor(opts.companyId);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, ringR * 0.6);
    ctx.lineTo(0, -ringR - 14);
    ctx.stroke();
    ctx.fillStyle = companyColor;
    ctx.beginPath();
    ctx.moveTo(0, -ringR - 14);
    ctx.lineTo(13, -ringR - 5);
    ctx.lineTo(0, -ringR + 4);
    ctx.closePath();
    ctx.fill();
    return { w: ringR * 2 + 20, h: ringR * 2 + 30 };
  }));
}

function drawShipyardBody(ctx: OffscreenCanvasRenderingContext2D, sz: number, hovered: boolean, companyId: number, building: boolean, dmgDarken: number): { w: number; h: number } {
  const ARM_T = sz * 1.00;
  const INT_W = sz * 4.80;
  const ARM_L = sz * 16.80;
  const BACK_T = sz * 1.00;
  const totalW = ARM_T + INT_W + ARM_T;
  const totalH = BACK_T + ARM_L;
  const hw = totalW / 2, hh = totalH / 2;

  const uPath = () => {
    ctx.beginPath();
    ctx.moveTo(-hw, -hh);
    ctx.lineTo(hw, -hh);
    ctx.lineTo(hw, hh);
    ctx.lineTo(hw - ARM_T, hh);
    ctx.lineTo(hw - ARM_T, -hh + BACK_T);
    ctx.lineTo(-hw + ARM_T, -hh + BACK_T);
    ctx.lineTo(-hw + ARM_T, hh);
    ctx.lineTo(-hw, hh);
    ctx.closePath();
  };

  ctx.fillStyle = hovered ? '#4a6852' : '#2e4a36';
  ctx.strokeStyle = '#1a2a1e';
  ctx.lineWidth = 2;
  uPath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = 'rgba(10, 20, 10, 0.28)';
  ctx.lineWidth = 0.8;
  const plankStep = ARM_T / 2.5;
  for (let p = plankStep; p < totalH; p += plankStep) {
    const py = -hh + p;
    ctx.beginPath(); ctx.moveTo(-hw, py); ctx.lineTo(-hw + ARM_T, py); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hw - ARM_T, py); ctx.lineTo(hw, py); ctx.stroke();
  }
  for (let p = plankStep; p < INT_W; p += plankStep) {
    const px = -hw + ARM_T + p;
    ctx.beginPath(); ctx.moveTo(px, -hh); ctx.lineTo(px, -hh + BACK_T); ctx.stroke();
  }

  ctx.fillStyle = 'rgba(10, 40, 65, 0.72)';
  ctx.fillRect(-hw + ARM_T, -hh + BACK_T, INT_W, ARM_L);

  if (building) {
    const shpHW = INT_W * 0.36;
    const shpTop = -hh + BACK_T + ARM_L * 0.05;
    const shpBot = hh - ARM_L * 0.05;
    const shpLen = shpBot - shpTop;
    ctx.fillStyle = 'rgba(68, 46, 20, 0.30)';
    ctx.strokeStyle = 'rgba(155, 115, 60, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, shpTop);
    ctx.bezierCurveTo(shpHW * 0.5, shpTop + shpLen * 0.07, shpHW, shpTop + shpLen * 0.22, shpHW, shpTop + shpLen * 0.65);
    ctx.bezierCurveTo(shpHW, shpTop + shpLen * 0.85, shpHW * 0.5, shpBot, 0, shpBot);
    ctx.bezierCurveTo(-shpHW * 0.5, shpBot, -shpHW, shpTop + shpLen * 0.85, -shpHW, shpTop + shpLen * 0.65);
    ctx.bezierCurveTo(-shpHW, shpTop + shpLen * 0.22, -shpHW * 0.5, shpTop + shpLen * 0.07, 0, shpTop);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const bayX0 = -hw + ARM_T, bayX1 = hw - ARM_T;
    const bayY0 = -hh + BACK_T, bayY1 = hh;
    const bayW = bayX1 - bayX0, bayH = bayY1 - bayY0;
    ctx.fillStyle = 'rgba(110, 75, 30, 0.72)';
    ctx.fillRect(bayX0, bayY0, bayW, bayH);
    ctx.strokeStyle = 'rgba(65, 42, 14, 0.50)';
    ctx.lineWidth = 0.9;
    const boardSpacing = ARM_T * 0.55;
    for (let oy = boardSpacing; oy < bayH; oy += boardSpacing) {
      ctx.beginPath(); ctx.moveTo(bayX0, bayY0 + oy); ctx.lineTo(bayX1, bayY0 + oy); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(145, 105, 50, 0.70)';
    ctx.strokeRect(bayX0, bayY0, bayW, bayH);
    const postHeight = ARM_T * 1.4;
    const postY0 = bayY1 - ARM_T;
    ctx.strokeStyle = 'rgba(190, 150, 85, 0.90)';
    ctx.lineWidth = 2.5;
    for (const px of [bayX0, 0, bayX1]) {
      ctx.beginPath();
      ctx.moveTo(px, postY0 + ARM_T * 0.1);
      ctx.lineTo(px, postY0 - postHeight * 0.4);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(200, 160, 80, 0.70)';
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(bayX0, postY0 - postHeight * 0.4);
    ctx.lineTo(bayX1, postY0 - postHeight * 0.4);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = 'rgba(155, 115, 60, 0.65)';
    ctx.lineWidth = 2;
    for (const mf of [0.28, 0.60]) {
      const mpy = -hh + BACK_T + ARM_L * mf;
      const mhw = INT_W * 0.36;
      ctx.beginPath(); ctx.moveTo(0, mpy - ARM_T * 0.25); ctx.lineTo(0, mpy + ARM_T * 0.25); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-mhw * 0.4, mpy); ctx.lineTo(mhw * 0.4, mpy); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(190, 150, 85, 0.85)';
    ctx.lineWidth = 1.8;
    for (const frac of [0.25, 0.50, 0.75]) {
      const bpy = -hh + BACK_T + ARM_L * frac;
      ctx.beginPath(); ctx.moveTo(-hw + ARM_T, bpy); ctx.lineTo(hw - ARM_T, bpy); ctx.stroke();
      const pLen = ARM_T * 0.30;
      ctx.beginPath(); ctx.moveTo(-hw + ARM_T, bpy - pLen); ctx.lineTo(-hw + ARM_T, bpy + pLen); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hw - ARM_T, bpy - pLen); ctx.lineTo(hw - ARM_T, bpy + pLen); ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(160, 120, 60, 0.45)';
    const bFracs = [0, 0.25, 0.50, 0.75, 1.0];
    for (let bi = 0; bi < bFracs.length - 1; bi++) {
      const y0 = -hh + BACK_T + ARM_L * bFracs[bi];
      const y1 = -hh + BACK_T + ARM_L * bFracs[bi + 1];
      ctx.beginPath(); ctx.moveTo(-hw, y0); ctx.lineTo(-hw + ARM_T, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-hw + ARM_T, y0); ctx.lineTo(-hw, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hw - ARM_T, y0); ctx.lineTo(hw, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hw, y0); ctx.lineTo(hw - ARM_T, y1); ctx.stroke();
    }
  }

  ctx.fillStyle = 'rgba(190, 150, 85, 0.95)';
  const bollardR = 3.5;
  ctx.beginPath(); ctx.arc(-hw + ARM_T * 0.5, hh - ARM_T * 0.4, bollardR, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(hw - ARM_T * 0.5, hh - ARM_T * 0.4, bollardR, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = structureCompanyColor(companyId);
  ctx.fillRect(-hw, -hh, totalW, 3);
  if (dmgDarken > 0.01) {
    ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
    uPath();
    ctx.fill();
  }
  return { w: totalW, h: totalH };
}

export function getShipyardSprite(cache: StructureSpriteCache, opts: StructureSpriteOpts): StructureSprite {
  const building = opts.building ? 1 : 0;
  const key = `shipyard:${keyPart(opts)}:b${building}`;
  return cache.get(key, () => bake((ctx) => {
    const sz = STRUCT_TILE;
    const dmgDarken = dmgDarkenFromBucket(hpDamageBucket(opts.hpFrac));
    return drawShipyardBody(ctx, sz, opts.hovered, opts.companyId, !!opts.building, dmgDarken);
  }));
}

/** Resolve sprite + draw rotation for a placed structure base layer. */
export function getStructureBaseSprite(
  cache: StructureSpriteCache,
  s: PlacedStructure,
  opts: StructureSpriteOpts,
): { sprite: StructureSprite; rotRad: number } | null {
  const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
  const fullOpts = { ...opts, hpFrac };

  switch (s.type) {
    case 'wooden_floor':
      return { sprite: getWoodenFloorSprite(cache, fullOpts), rotRad: (s.rotation ?? 0) * Math.PI / 180 };
    case 'workbench':
      return { sprite: getWorkbenchSprite(cache, fullOpts), rotRad: (s.rotation ?? 0) * Math.PI / 180 };
    case 'wall':
      return { sprite: getWallSprite(cache, fullOpts), rotRad: opts.wallRotRad ?? 0 };
    case 'door_frame':
      return { sprite: getDoorFrameSprite(cache, fullOpts), rotRad: opts.wallRotRad ?? 0 };
    case 'door':
      return { sprite: getDoorSprite(cache, { ...fullOpts, doorOpen: s.doorOpen === true }), rotRad: opts.wallRotRad ?? 0 };
    case 'wood_ceiling':
      return { sprite: getWoodCeilingSprite(cache, fullOpts), rotRad: (s.rotation ?? 0) * Math.PI / 180 };
    case 'chest':
      return { sprite: getChestSprite(cache, fullOpts), rotRad: 0 };
    case 'cannon':
      return { sprite: getCannonBaseSprite(cache, fullOpts), rotRad: (s.rotation ?? 0) * Math.PI / 180 };
    case 'wreck':
      return { sprite: getWreckSprite(cache, {
        ...fullOpts,
        wreckTier: s.wreckTier,
        wreckHasLoot: s.hp > 0,
      }), rotRad: 0.61 };
    case 'shipyard':
      return { sprite: getShipyardSprite(cache, {
        ...fullOpts,
        building: s.construction?.phase === 'building',
      }), rotRad: (s.rotation ?? 0) * Math.PI / 180 };
    case 'flag_fort':
      return { sprite: getFlagFortSprite(cache, fullOpts), rotRad: 0 };
    case 'company_fortress':
      return { sprite: getCompanyFortressSprite(cache, {
        ...fullOpts,
        fortressComplete: s.fortressComplete ?? false,
      }), rotRad: 0 };
    case 'claim_flag':
      return { sprite: getClaimFlagSprite(cache, fullOpts), rotRad: 0 };
    default:
      return null;
  }
}
