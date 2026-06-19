/**
 * Shared shipyard / dry-dock geometry — must match server dock_physics.h constants.
 *
 * Dock-local frame: +Y = mouth (open end), +X = width axis.
 * Brigantine is pinned at the dock centre with bow facing +Y (ship rot = dock rot + 90°).
 */

export const SHIPYARD_TILE   = 50;
export const SHIPYARD_ARM_T  = 50;
export const SHIPYARD_INT_W  = 240;
export const SHIPYARD_ARM_L  = 790;   // was 840 — fits brigantine (bow +415, stern −345)
export const SHIPYARD_BACK_T = 50;
export const SHIPYARD_HW     = (SHIPYARD_ARM_T + SHIPYARD_INT_W + SHIPYARD_ARM_T) / 2; // 170
export const SHIPYARD_HH     = (SHIPYARD_BACK_T + SHIPYARD_ARM_L) / 2; // 420

/** Sprite / UI height multiplier (totalH / TILE). */
export const SHIPYARD_HEIGHT_MULT = (SHIPYARD_BACK_T + SHIPYARD_ARM_L) / SHIPYARD_TILE; // 16.8

/** Brigantine build slot AABB in dock-local px (ship-local rotated +90°). */
export const BRIG_SLOT_HALF_X = 110;
export const BRIG_SLOT_Y_MIN  = -355;
export const BRIG_SLOT_Y_MAX  =  425;

export function dockLocalToWorld(
  dockX: number, dockY: number, rotDeg: number, lx: number, ly: number,
): { x: number; y: number } {
  const rad = rotDeg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return {
    x: dockX + lx * c - ly * s,
    y: dockY + lx * s + ly * c,
  };
}

/** Sample points covering the brigantine build slot (dock-local → world). */
export function brigSlotSamplePoints(dockX: number, dockY: number, rotDeg: number): { x: number; y: number }[] {
  const xs = [-BRIG_SLOT_HALF_X, 0, BRIG_SLOT_HALF_X];
  const ys = [BRIG_SLOT_Y_MIN, (BRIG_SLOT_Y_MIN + BRIG_SLOT_Y_MAX) / 2, BRIG_SLOT_Y_MAX];
  const pts: { x: number; y: number }[] = [];
  for (const lx of xs) {
    for (const ly of ys) {
      pts.push(dockLocalToWorld(dockX, dockY, rotDeg, lx, ly));
    }
  }
  return pts;
}

/** True if any part of the brigantine slot overlaps island land. */
export function brigSlotOverlapsLand(
  dockX: number, dockY: number, rotDeg: number,
  isOnLand: (wx: number, wy: number) => boolean,
): boolean {
  return brigSlotSamplePoints(dockX, dockY, rotDeg).some(p => isOnLand(p.x, p.y));
}

/** Corners of the brigantine slot in dock-local space (for ghost drawing). */
export function brigSlotCornersLocal(): { x: number; y: number }[] {
  return [
    { x: -BRIG_SLOT_HALF_X, y: BRIG_SLOT_Y_MIN },
    { x:  BRIG_SLOT_HALF_X, y: BRIG_SLOT_Y_MIN },
    { x:  BRIG_SLOT_HALF_X, y: BRIG_SLOT_Y_MAX },
    { x: -BRIG_SLOT_HALF_X, y: BRIG_SLOT_Y_MAX },
  ];
}
