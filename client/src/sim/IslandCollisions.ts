/**
 * Client-side island collision resolution.
 *
 * All math mirrors the server's websocket_server.c so that the predicted
 * player position is already collision-correct before it reaches the server.
 * This eliminates the reconciliation spikes caused by "walk into wall, server
 * pushes back" divergences.
 *
 * Constants and algorithms are exact ports from:
 *   server/src/net/websocket_server.c  — island walking collision block
 *   server/src/net/dock_physics.c      — wall_get_rad
 *   server/include/net/cannon_fire.h   — TREE_TRUNK_R_PX
 */

import { Vec2 } from '../common/Vec2.js';
import { PlacedStructure } from './Types.js';

// ── Constants (mirrors server) ────────────────────────────────────────────────
const PLAYER_R        = 8.0;   // player collision radius (client px)
const TREE_TRUNK_R_PX = 18.0;  // tree trunk collision radius (client px)
const BOULDER_BASE_R  = 38.0;  // boulder base collision radius (client px)
const WALL_HALF_W     = 25.0;  // wall OBB half-width (client px)
const WALL_HALF_H     = 5.0;   // wall OBB half-height (client px)
const WALL_GET_RAD_MAX_DIST2 = 35.0 * 35.0;

// Boulder ellipse shape variants (index 0–4) — mirrors server BSX/BSY/BSR arrays.
const BOULDER_SX = [1.00, 0.88, 1.18, 0.72, 1.35];
const BOULDER_SY = [0.72, 0.88, 0.60, 1.00, 0.50];
const BOULDER_SR = [0.00, 0.40, -0.20, 1.20, 0.15];

// ── Collision context ─────────────────────────────────────────────────────────

/**
 * Holds static world geometry needed for client-side collision prediction.
 * Updated from ClientApplication whenever structures or islands change.
 * Stored on PredictionEngine; NOT cloned per-tick (no GC cost).
 */
/** Minimal island shape needed for collision — subset of IslandDef / RenderIslandInput. */
export interface CollisionIsland {
  id: number;
  x: number;
  y: number;
  /** Polygon coastline (world-space). Absent for circular islands. */
  vertices?: { x: number; y: number }[];
  resources: { ox: number; oy: number; type: string; size: number; hp: number }[];
}

export interface CollisionContext {
  islands: CollisionIsland[];
  /** All placed structures across all islands. Used for wall OBB collision. */
  structures: readonly PlacedStructure[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mirrors server wall_get_rad():
 * Finds the nearest wooden_floor tile within 35px and returns
 * atan2(dy, dx) + π/2 as the wall's orientation.
 */
function wallGetRad(wallX: number, wallY: number, allStructures: readonly PlacedStructure[]): number {
  let bestDist2 = WALL_GET_RAD_MAX_DIST2;
  let bestRad   = 0;
  for (const s of allStructures) {
    if (s.type !== 'wooden_floor') continue;
    const dx = wallX - s.x;
    const dy = wallY - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestRad   = Math.atan2(dy, dx) + Math.PI / 2;
    }
  }
  return bestRad;
}

/**
 * Single wall / closed-door OBB push-out.
 * Mutates px/py in-place; returns whether a collision occurred.
 */
function resolveWallOBB(
  px: number, py: number,
  wallX: number, wallY: number, wrad: number,
  out: { x: number; y: number }
): boolean {
  const wc  = Math.cos(-wrad);
  const wsn = Math.sin(-wrad);
  const cpx = px - wallX;
  const cpy = py - wallY;
  const lx  = cpx * wc  - cpy * wsn;
  const ly  = cpx * wsn + cpy * wc;

  const clampX = Math.max(-WALL_HALF_W, Math.min(WALL_HALF_W, lx));
  const clampY = Math.max(-WALL_HALF_H, Math.min(WALL_HALF_H, ly));
  const dlx = lx - clampX;
  const dly = ly - clampY;
  const distSq = dlx * dlx + dly * dly;

  if (distSq >= PLAYER_R * PLAYER_R || distSq < 0.0001) return false;

  const dist = Math.sqrt(distSq);
  const pen  = PLAYER_R - dist;
  const pushLx = (dlx / dist) * pen;
  const pushLy = (dly / dist) * pen;
  const wcb  = Math.cos(wrad);
  const wsnb = Math.sin(wrad);
  out.x += pushLx * wcb - pushLy * wsnb;
  out.y += pushLx * wsnb + pushLy * wcb;
  return true;
}

/**
 * Deterministic uint32 seed for a boulder resource, matching server bseed.
 * Uses the same bit pattern as the C unsigned integer arithmetic.
 */
function boulderSeed(ox: number, oy: number): number {
  const ioX = ox | 0;
  const ioY = oy | 0;
  // Emulate C unsigned 32-bit multiply + XOR using Math.imul.
  // Constants must exactly match server island.h / websocket_server.c:
  //   73856093 = 0x0466F45D
  //   19349663 = 0x0127409F
  const a = Math.imul(ioX, 0x0466F45D) >>> 0;
  const b = Math.imul(ioY, 0x0127409F) >>> 0;
  return (a ^ b) >>> 0;
}

// ── Public collision API ──────────────────────────────────────────────────────

/**
 * Run all island-surface collisions (walls, doors, trees, boulders) on a
 * candidate player position, returning the corrected position.
 *
 * Mirrors the collision block in websocket_server.c island-walking section.
 *
 * @param pos         Candidate world-space position (client units)
 * @param island      IslandDef for the island the player is on
 * @param ctx         Collision context with all structures
 */
export function resolveIslandCollisions(
  pos: Vec2,
  island: CollisionIsland,
  ctx: CollisionContext,
): Vec2 {
  let nx = pos.x;
  let ny = pos.y;
  const out = { x: nx, y: ny };

  // ── 1. Walls and closed doors ────────────────────────────────────────────
  for (const s of ctx.structures) {
    if (s.islandId !== island.id) continue;
    const isWall     = s.type === 'wall';
    const isClosedDoor = s.type === 'door' && !s.doorOpen;
    if (!isWall && !isClosedDoor) continue;

    out.x = nx;
    out.y = ny;
    const wrad = wallGetRad(s.x, s.y, ctx.structures);
    if (resolveWallOBB(nx, ny, s.x, s.y, wrad, out)) {
      nx = out.x;
      ny = out.y;
    }
  }

  // ── 2. Tree trunks (alive wood resources) ────────────────────────────────
  for (const res of island.resources) {
    if (res.type !== 'wood') continue;
    if (res.hp <= 0) continue;  // depleted — no collision
    const trunkR    = TREE_TRUNK_R_PX * res.size;
    const combinedR = PLAYER_R + trunkR;
    const tx = island.x + res.ox;
    const ty = island.y + res.oy;
    const dx = nx - tx;
    const dy = ny - ty;
    const distSq = dx * dx + dy * dy;
    if (distSq < combinedR * combinedR && distSq > 0.0001) {
      const dist = Math.sqrt(distSq);
      const pen  = combinedR - dist;
      nx += (dx / dist) * pen;
      ny += (dy / dist) * pen;
    }
  }

  // ── 3. Boulders (ellipse collision) ─────────────────────────────────────
  for (const res of island.resources) {
    if (res.type !== 'boulder') continue;
    if (res.hp <= 0) continue;
    const seed = boulderSeed(res.ox, res.oy);
    const bsi  = (seed >>> 4) % 5;
    const ax   = BOULDER_BASE_R * res.size * BOULDER_SX[bsi];
    const ay   = BOULDER_BASE_R * res.size * BOULDER_SY[bsi];
    const theta = BOULDER_SR[bsi] + ((seed >>> 8) & 0xFF) / 256 * (2 * Math.PI);
    const cosT  = Math.cos(theta);
    const sinT  = Math.sin(theta);

    const bx = island.x + res.ox;
    const by = island.y + res.oy;
    let dx  = nx - bx;
    let dy  = ny - by;
    let distSq = dx * dx + dy * dy;
    if (distSq < 1e-4) { dx = PLAYER_R; dy = 0; distSq = PLAYER_R * PLAYER_R; }
    const dist = Math.sqrt(distSq);
    const unx = dx / dist;
    const uny = dy / dist;

    const unxL =  unx * cosT + uny * sinT;
    const unyL = -unx * sinT + uny * cosT;
    const invAx = unxL / ax;
    const invAy = unyL / ay;
    const rEff  = 1 / Math.sqrt(invAx * invAx + invAy * invAy);
    const minDist = PLAYER_R + rEff;
    if (dist >= minDist) continue;

    const dxL  =  dx * cosT + dy * sinT;
    const dyL  = -dx * sinT + dy * cosT;
    const gxL  = dxL / (ax * ax);
    const gyL  = dyL / (ay * ay);
    let gn = Math.sqrt(gxL * gxL + gyL * gyL);
    if (gn < 1e-6) gn = 1;
    const nxL = gxL / gn;
    const nyL = gyL / gn;
    const nxW = nxL * cosT - nyL * sinT;
    const nyW = nxL * sinT + nyL * cosT;
    const pen = minDist - dist;
    nx += nxW * pen;
    ny += nyW * pen;
  }

  return Vec2.from(nx, ny);
}

/**
 * Check whether a world-space position is inside the island's surface polygon.
 * Returns true if still on the island. For non-polygon islands (circular), always
 * returns true (server handles the boundary transition authoritatively).
 */
export function isInsideIsland(pos: Vec2, island: CollisionIsland): boolean {
  if (!island.vertices || island.vertices.length < 3) {
    return true; // non-polygon — let server handle boundary
  }
  return pointInPolygon(pos.x, pos.y, island.vertices);
}

/** Ray-casting point-in-polygon test. */
function pointInPolygon(px: number, py: number, verts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x; const yi = verts[i].y;
    const xj = verts[j].x; const yj = verts[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
                      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Shipyard dock collision — mirrors dock_physics.c ─────────────────────────
// Geometry constants must match dock_physics.c exactly.
const DOCK_HW     = 170;   // half-width of the U
const DOCK_HH     = 445;   // half-height of each arm
const DOCK_ARM_T  = 50;    // arm wall thickness
const DOCK_BACK_T = 50;    // back wall thickness

/**
 * OBB circle pushout in dock-local space.
 * Mirrors dock_obb_pushout(): only pushes when the player is OUTSIDE the OBB
 * (d2 > 0); when the centre is inside (d2 == 0) the player is on the walkable
 * surface and no push occurs.
 */
function dockOBBPushout(
  cx: number, cy: number, hx: number, hy: number,
  r: number, p: { lx: number; ly: number }
): void {
  const dx  = p.lx - cx;
  const dy  = p.ly - cy;
  const clX = Math.max(-hx, Math.min(hx, dx));
  const clY = Math.max(-hy, Math.min(hy, dy));
  const px  = dx - clX;
  const py  = dy - clY;
  const d2  = px * px + py * py;
  if (d2 < r * r && d2 > 0.0001) {
    const d   = Math.sqrt(d2);
    const pen = r - d;
    p.lx += (px / d) * pen;
    p.ly += (py / d) * pen;
  }
}

/**
 * True if a world-space position is on a walkable dock surface.
 * Mirrors server dock_point_on_surface() (dock_physics.c).
 *
 * Used by client prediction to detect when the player has walked off the dock
 * so the client can clear onDockId and switch physics models in the same tick
 * the server would — preventing the temporary rubberbanding on dock exit.
 */
export function isDockPointOnSurface(pos: Vec2, dock: PlacedStructure): boolean {
  const rad  = (dock.rotation ?? 0) * Math.PI / 180;
  const cosN = Math.cos(-rad);
  const sinN = Math.sin(-rad);
  const dx   = pos.x - dock.x;
  const dy   = pos.y - dock.y;
  const lx   = dx * cosN - dy * sinN;
  const ly   = dx * sinN + dy * cosN;

  const hasScaffolding = dock.construction?.phase === 'building';
  const P  = 10;                    // padding ≈ player radius — matches server
  const ai = DOCK_HW - DOCK_ARM_T; // arm inner edge = 120

  // Left arm top surface
  if (lx >= -(DOCK_HW + P) && lx <= -(ai - P) && Math.abs(ly) <= DOCK_HH + P) return true;
  // Right arm top surface
  if (lx >=  (ai - P)      && lx <=  (DOCK_HW + P) && Math.abs(ly) <= DOCK_HH + P) return true;
  // Back wall top surface
  if (Math.abs(lx) <= DOCK_HW + P &&
      ly >= -(DOCK_HH + P) && ly <= -(DOCK_HH - DOCK_BACK_T - P)) return true;
  // Interior bay — only walkable when ship is under construction
  if (hasScaffolding && Math.abs(lx) <= ai + P &&
      ly >= -(DOCK_HH - DOCK_BACK_T - P) && ly <= DOCK_HH + P) return true;

  return false;
}

/**
 * Resolve dock U-wall OBB pushout for a player on a shipyard dock.
 * Mirrors server dock_apply_player_collision() (dock_physics.c).
 *
 * @param pos           Candidate world-space position
 * @param dock          The shipyard PlacedStructure (type === 'shipyard')
 * @returns             Corrected world-space position
 */
export function resolveDockCollisions(pos: Vec2, dock: PlacedStructure): Vec2 {
  const rad   = (dock.rotation ?? 0) * Math.PI / 180;
  const cosN  = Math.cos(-rad);
  const sinN  = Math.sin(-rad);

  // World → dock-local
  const dx = pos.x - dock.x;
  const dy = pos.y - dock.y;
  const p = {
    lx: dx * cosN - dy * sinN,
    ly: dx * sinN + dy * cosN,
  };

  const hasScaffolding = dock.construction?.phase === 'building';
  const ai = DOCK_HW - DOCK_ARM_T;   // inner arm edge = 120

  // Left arm:  centre (-145, 0), half-extents (25, 445)
  dockOBBPushout(-(DOCK_HW - DOCK_ARM_T / 2),  0, DOCK_ARM_T / 2, DOCK_HH, PLAYER_R, p);
  // Right arm: centre (+145, 0), half-extents (25, 445)
  dockOBBPushout( (DOCK_HW - DOCK_ARM_T / 2),  0, DOCK_ARM_T / 2, DOCK_HH, PLAYER_R, p);
  // Back wall: centre (0, -420), half-extents (170, 25)
  dockOBBPushout(0, -(DOCK_HH - DOCK_BACK_T / 2), DOCK_HW,  DOCK_BACK_T / 2, PLAYER_R, p);
  // Front scaffolding wall (only while ship is being built):
  // centre (0, +420), half-extents (120, 25)
  if (hasScaffolding) {
    dockOBBPushout(0, DOCK_HH - DOCK_BACK_T / 2, ai, DOCK_BACK_T / 2, PLAYER_R, p);
  }

  // Dock-local → world
  const cosF = Math.cos(rad);
  const sinF = Math.sin(rad);
  return Vec2.from(
    dock.x + p.lx * cosF - p.ly * sinF,
    dock.y + p.lx * sinF + p.ly * cosF,
  );
}
