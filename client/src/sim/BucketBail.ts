/**
 * Bucket bail mechanics — shared client validation mirroring server bucket_bail.c.
 */

import type { Ship } from './Types.js';
import { GUNPORT_SNAP_POINTS } from './modules.js';

export const BUCKET_FILL_COOLDOWN_MS = 1250;
export const BUCKET_PROXIMITY_PX = 60;
export const BUCKET_BAIL_HALF_HP = 2;
export const BUCKET_BAIL_FULL_HP = 4;
export const BUCKET_LOWER_SCOOP_FILL = 0.25;
export const BUCKET_UPPER_SCOOP_FILL = 0.75;
export const BUCKET_WELL_SCOOP_FILL = 0.01;
/** Match server BUCKET_SCOOP_FILL_GRACE — minigame delay vs passive hull heal. */
export const BUCKET_SCOOP_FILL_GRACE = 0.03;

export type BucketFillLevel = 0 | 1 | 2;

export function getWaterFill(hullHealth: number): number {
  return Math.max(0, Math.min(1, 1 - hullHealth / 100));
}

/** Flood overlay intensity for a deck once waterFill crosses a scoop threshold. */
export function computeDeckFloodTint(waterFill: number, threshold: number): number {
  if (waterFill < threshold) return 0;
  const span = 1 - threshold;
  return span > 0 ? Math.min(1, (waterFill - threshold) / span) : 1;
}

function dist2d(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
}

export function nearWell(ship: Ship, localX: number, localY: number): boolean {
  for (const mod of ship.modules) {
    if (mod.kind !== 'well') continue;
    if (mod.deckId !== 0) continue;
    if (dist2d(localX, localY, mod.localPos.x, mod.localPos.y) <= BUCKET_PROXIMITY_PX) return true;
  }
  return false;
}

export function shipHasWell(ship: Ship): boolean {
  return ship.modules.some(m => m.kind === 'well');
}

export function canScoopWater(
  ship: Ship,
  deckLevel: number,
  hullHealth: number,
  localX: number,
  localY: number,
): boolean {
  const fill = getWaterFill(hullHealth);
  if (fill <= 0) return false;
  const meets = (threshold: number) => fill >= threshold - BUCKET_SCOOP_FILL_GRACE;
  if (deckLevel === 0) {
    if (nearWell(ship, localX, localY)) return meets(BUCKET_WELL_SCOOP_FILL);
    return meets(BUCKET_LOWER_SCOOP_FILL);
  }
  if (deckLevel === 1) {
    return meets(BUCKET_UPPER_SCOOP_FILL);
  }
  return false;
}

function nearOpenGunport(ship: Ship, localX: number, localY: number): boolean {
  for (const mod of ship.modules) {
    if (mod.kind !== 'gunport') continue;
    const md = mod.moduleData as { isOpen?: boolean; snapIndex?: number } | undefined;
    if (!md?.isOpen) continue;
    const idx = md.snapIndex ?? 255;
    const snap = idx < GUNPORT_SNAP_POINTS.length ? GUNPORT_SNAP_POINTS[idx] : null;
    const gx = snap?.x ?? mod.localPos.x;
    const gy = snap?.y ?? mod.localPos.y;
    if (dist2d(localX, localY, gx, gy) <= BUCKET_PROXIMITY_PX) return true;
  }
  return false;
}

function nearMissingPlank(ship: Ship, localX: number, localY: number): boolean {
  for (const mod of ship.modules) {
    if (mod.kind !== 'plank') continue;
    const md = mod.moduleData as { health?: number } | undefined;
    const health = md?.health ?? mod.health ?? 0;
    if (health > 0) continue;
    if (dist2d(localX, localY, mod.localPos.x, mod.localPos.y) <= BUCKET_PROXIMITY_PX) return true;
  }
  return false;
}

/** Minimum distance from a ship-local point to the hull polygon edge (client px). */
function distToHullEdge(localX: number, localY: number, hull: { x: number; y: number }[]): number {
  const n = hull.length;
  if (n < 3) return Infinity;
  let minDistSq = Infinity;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const lenSq = ex * ex + ey * ey;
    let t = 0;
    if (lenSq > 1e-10) {
      t = ((localX - a.x) * ex + (localY - a.y) * ey) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = a.x + t * ex;
    const cy = a.y + t * ey;
    const dx = localX - cx;
    const dy = localY - cy;
    minDistSq = Math.min(minDistSq, dx * dx + dy * dy);
  }
  return Math.sqrt(minDistSq);
}

function nearHullEdge(ship: Ship, localX: number, localY: number): boolean {
  if (ship.hull.length < 3) return false;
  return distToHullEdge(localX, localY, ship.hull) <= BUCKET_PROXIMITY_PX;
}

export function isValidDumpZone(ship: Ship, deckLevel: number, localX: number, localY: number): boolean {
  if (deckLevel === 1) return nearHullEdge(ship, localX, localY);
  if (deckLevel === 0) {
    return nearOpenGunport(ship, localX, localY) || nearMissingPlank(ship, localX, localY);
  }
  return false;
}

export function getBailAmount(fill: BucketFillLevel): number {
  if (fill >= 2) return BUCKET_BAIL_FULL_HP;
  if (fill >= 1) return BUCKET_BAIL_HALF_HP;
  return 0;
}

export function bucketFillLabel(fill: BucketFillLevel): string {
  if (fill >= 2) return 'Full bucket';
  if (fill >= 1) return 'Half bucket';
  return 'Empty bucket';
}
