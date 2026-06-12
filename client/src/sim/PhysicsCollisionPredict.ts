/**
 * PhysicsCollisionPredict.ts
 *
 * Client-side prediction of ship-ship and ship-island collisions.
 * Mirrors server simulation.c logic so the client can predict collision
 * outcomes without waiting for a server round-trip, eliminating rubber-band
 * artifacts on fast-moving ships.
 *
 * All arithmetic is in client pixel space (1 px = 1 world unit on client).
 * Constants are converted from server units (1 su = 10 px / WORLD_SCALE 10).
 *
 * The server runs a two-phase pipeline each tick:
 *   1. CCD pre-pass  — swept circle vs polygon to prevent tunnelling
 *   2. Discrete pass — SAT + Baumgarte + multipoint impulse + friction
 *
 * We replicate both phases here. Warm-starting is omitted (too stateful for
 * a one-shot prediction frame); small divergences are corrected by the normal
 * server reconciliation path.
 */

import { Vec2 } from '../common/Vec2.js';
import { PolygonUtils } from '../common/PolygonUtils.js';
import { Ship } from './Types.js';

// ── Constants (client pixel space) ───────────────────────────────────────────
// Server originals in comments; converted by WORLD_SCALE = 10.

/** Server simulation tick rate. Baumgarte factors and per-tick drag multipliers
 *  on the server are defined "per 30 Hz tick"; callers may invoke these solvers
 *  at other rates (e.g. 120 Hz prediction steps), so anything per-tick must be
 *  rescaled by dt × SERVER_TICK_RATE. */
const SERVER_TICK_RATE = 30;

/** Coefficient of restitution for ship-ship collisions (dimensionless). */
const SHIP_RESTITUTION = 0.3;

/** Coulomb friction coefficient for tangential impulse (dimensionless). */
const SHIP_FRICTION = 0.35;

/** Baumgarte position-correction factor [0,1], applied per SERVER tick. */
const SHIP_BAUMGARTE = 0.4;

/** Minimum penetration ignored by Baumgarte bias (px). Server: 0.05 su. */
const SHIP_SLOP = 0.5;

/** Maximum contact points evaluated per ship pair. */
const MAX_CONTACT_POINTS = 4;

/**
 * Effective ship moment of inertia in client px² units — the SAME for every ship.
 *
 * The server stores Q16_FROM_FLOAT(50000.0f), which overflows int32 and saturates
 * to Q16_MAX, i.e. an effective 32768 in server units (recalc_ship_mass even writes
 * Q16_MAX explicitly). All server impulse solvers divide by that value. Converted
 * to client pixel space: I_px = I_su × WORLD_SCALE² = 32768 × 100 = 3,276,800.
 *
 * Do NOT use ship.momentOfInertia here — the client template value (500000) does
 * not match the server's effective runtime value and would under-rotate impulse
 * responses by ~6.5×.
 */
const SHIP_INERTIA_PX = 32768 * 100;

/** Restitution for ship-island contacts. Server apply_island_impulse: 0.15. */
const ISLAND_RESTITUTION = 0.15;

/** Coulomb friction for ship-island contacts. Server apply_island_impulse: 0.75. */
const ISLAND_FRICTION = 0.75;

/** CCD minimum displacement² before we bother sweeping (px²). Server: 0.25 su². */
const CCD_MIN_DISP_SQ = 25.0;

// ── Types ─────────────────────────────────────────────────────────────────────

interface CCDHit {
  t: number;   // time of impact ∈ [0,1]
  nx: number;  // collision normal x
  ny: number;  // collision normal y
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Transform a ship's local-space hull to world space. */
function hullToWorld(ship: Ship): Vec2[] {
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  return ship.hull.map(v => Vec2.from(
    ship.position.x + v.x * cos - v.y * sin,
    ship.position.y + v.x * sin + v.y * cos,
  ));
}

/** Bounding radius from the hull (maximum vertex distance from origin + buffer). */
function boundingRadius(ship: Ship): number {
  let max = 0;
  for (const v of ship.hull) {
    const d = Math.sqrt(v.x * v.x + v.y * v.y);
    if (d > max) max = d;
  }
  return max + 10;
}

/** Ray-cast point-in-polygon test (world-space vertices). */
function pointInPoly(px: number, py: number, poly: Vec2[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = poly[i], vj = poly[j];
    if ((vi.y > py) !== (vj.y > py)) {
      const ix = (vj.x - vi.x) * (py - vi.y) / (vj.y - vi.y) + vi.x;
      if (px < ix) inside = !inside;
    }
  }
  return inside;
}

// ── CCD: swept circle vs line segment ─────────────────────────────────────────
// Direct port of server ccd_swept_circle_segment().
// Returns earliest TOI t ∈ [0,1] with the outward collision normal, or null.

function ccdCircleSegment(
  ax: number, ay: number,   // circle start (pre-integration position)
  bx: number, by: number,   // circle end   (post-integration position)
  radius: number,
  p0x: number, p0y: number, // segment start
  p1x: number, p1y: number, // segment end
): CCDHit | null {
  const dx = bx - ax, dy = by - ay;
  const moveLenSq = dx * dx + dy * dy;
  if (moveLenSq < 1e-12) return null;

  // Edge outward normal (left-hand of edge direction for CCW winding)
  const ex = p1x - p0x, ey = p1y - p0y;
  const edgeLen = Math.sqrt(ex * ex + ey * ey);
  if (edgeLen < 1e-6) return null;
  const enx = -ey / edgeLen, eny = ex / edgeLen;

  // Signed distances from line
  const d0 = (ax - p0x) * enx + (ay - p0y) * eny;
  const d1 = (bx - p0x) * enx + (by - p0y) * eny;
  const dd = d1 - d0;
  if (Math.abs(dd) < 1e-10) return null;

  // Solve for circle surface touching the line
  const targetD = d0 > 0 ? radius : -radius;
  const t = (targetD - d0) / dd;
  if (t < 0 || t > 1) return null;

  // Contact point on the infinite line at time t
  const cx = ax + dx * t, cy = ay + dy * t;

  // Project onto finite segment
  const proj = ((cx - p0x) * ex + (cy - p0y) * ey) / (edgeLen * edgeLen);
  if (proj >= 0 && proj <= 1) {
    return { t, nx: d0 > 0 ? enx : -enx, ny: d0 > 0 ? eny : -eny };
  }

  // Missed the face — check endpoint capsules
  let bestT = 2.0, bestNx = 0, bestNy = 0;
  for (let ep = 0; ep < 2; ep++) {
    const ppx = ep === 0 ? p0x : p1x;
    const ppy = ep === 0 ? p0y : p1y;
    const ox = ax - ppx, oy = ay - ppy;
    const a = moveLenSq;
    const b = 2 * (ox * dx + oy * dy);
    const c = ox * ox + oy * oy - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    const tEp = (-b - sq) / (2 * a);
    if (tEp >= 0 && tEp <= 1 && tEp < bestT) {
      bestT = tEp;
      const hx = ax + dx * tEp - ppx, hy = ay + dy * tEp - ppy;
      const hl = Math.sqrt(hx * hx + hy * hy);
      if (hl > 1e-6) { bestNx = hx / hl; bestNy = hy / hl; }
    }
  }
  if (bestT <= 1) return { t: bestT, nx: bestNx, ny: bestNy };
  return null;
}

/** Swept circle vs convex polygon — earliest hit across all edges. */
function ccdCirclePolygon(
  ax: number, ay: number, bx: number, by: number,
  radius: number, poly: Vec2[],
): CCDHit | null {
  let best: CCDHit | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p0 = poly[i], p1 = poly[(i + 1) % n];
    const hit = ccdCircleSegment(ax, ay, bx, by, radius, p0.x, p0.y, p1.x, p1.y);
    if (hit && (best === null || hit.t < best.t)) best = hit;
  }
  return best;
}

// ── SAT: polygon-polygon narrow phase ─────────────────────────────────────────
// Returns collision normal (pointing from poly1 toward poly2) and overlap depth,
// or null if no collision.

interface SATResult { normal: Vec2; depth: number; }

function satPolygons(
  poly1: Vec2[], center1: Vec2,
  poly2: Vec2[], center2: Vec2,
): SATResult | null {
  let minDepth = Infinity;
  let minAxis = Vec2.zero();

  for (let pass = 0; pass < 2; pass++) {
    const poly = pass === 0 ? poly1 : poly2;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const v1 = poly[i], v2 = poly[(i + 1) % n];
      const ex = v2.x - v1.x, ey = v2.y - v1.y;
      const len = Math.sqrt(ex * ex + ey * ey);
      if (len < 1e-6) continue;
      const axis = Vec2.from(-ey / len, ex / len);

      let min1 = Infinity, max1 = -Infinity;
      let min2 = Infinity, max2 = -Infinity;
      for (const p of poly1) { const d = p.dot(axis); if (d < min1) min1 = d; if (d > max1) max1 = d; }
      for (const p of poly2) { const d = p.dot(axis); if (d < min2) min2 = d; if (d > max2) max2 = d; }

      const overlap = Math.min(max1, max2) - Math.max(min1, min2);
      if (overlap <= 0) return null; // Separating axis found — no collision

      if (overlap < minDepth) {
        minDepth = overlap;
        minAxis = axis;
      }
    }
  }

  // Ensure normal points from poly1's center to poly2's center
  if (center2.sub(center1).dot(minAxis) < 0) minAxis = minAxis.mul(-1);
  return { normal: minAxis, depth: minDepth };
}

// ── CCD pre-pass ──────────────────────────────────────────────────────────────
// For each fast-moving ship, sweep its bounding circle against all other ship
// hulls. Mirrors server's CCD pre-pass in sim_handle_collisions().

function runCCDPrepass(ships: Ship[], dt: number): void {
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    const dispX = s.velocity.x * dt;
    const dispY = s.velocity.y * dt;
    if (dispX * dispX + dispY * dispY < CCD_MIN_DISP_SQ) continue;

    // Post-integration position is s.position; pre-integration = pos - disp
    const bx = s.position.x, by = s.position.y;
    const ax = bx - dispX, ay = by - dispY;
    const sr = boundingRadius(s);

    for (let j = 0; j < ships.length; j++) {
      if (i === j) continue;
      const other = ships[j];

      // Sweep broad-phase
      const or2 = boundingRadius(other);
      const sweepR = sr + or2 + Math.sqrt(dispX * dispX + dispY * dispY) * 0.5;
      const midX = (ax + bx) * 0.5, midY = (ay + by) * 0.5;
      const odx = other.position.x - midX, ody = other.position.y - midY;
      if (odx * odx + ody * ody > sweepR * sweepR) continue;

      const otherHull = hullToWorld(other);
      const hit = ccdCirclePolygon(ax, ay, bx, by, sr, otherHull);
      if (!hit) continue;

      // Rewind ship to just before impact
      const safeT = Math.max(hit.t - 0.01, 0);
      s.position = Vec2.from(ax + dispX * safeT, ay + dispY * safeT);

      // Reflect velocity (restitution = SHIP_RESTITUTION)
      const vn = s.velocity.x * hit.nx + s.velocity.y * hit.ny;
      if (vn < 0) {
        s.velocity = Vec2.from(
          s.velocity.x - (1 + SHIP_RESTITUTION) * vn * hit.nx,
          s.velocity.y - (1 + SHIP_RESTITUTION) * vn * hit.ny,
        );
      }
      break; // One CCD hit per ship per tick, matching server
    }
  }
}

// ── Discrete SAT + multipoint impulse ─────────────────────────────────────────
// Mirrors server handle_ship_collisions(): SAT narrow phase, contact manifold
// from penetrating vertices, Baumgarte position correction, and iterative
// normal + friction impulse.

function runDiscreteShipCollisions(ships: Ship[], dt: number): void {
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const ship1 = ships[i], ship2 = ships[j];

      // Broad phase
      const dx = ship2.position.x - ship1.position.x;
      const dy = ship2.position.y - ship1.position.y;
      const r1 = boundingRadius(ship1), r2 = boundingRadius(ship2);
      const combined = r1 + r2;
      if (dx * dx + dy * dy >= combined * combined) continue;

      const hull1 = hullToWorld(ship1);
      const hull2 = hullToWorld(ship2);

      // SAT narrow phase
      const sat = satPolygons(hull1, ship1.position, hull2, ship2.position);
      if (!sat) continue;

      const { normal, depth } = sat;
      const nx = normal.x, ny = normal.y;

      // ── Contact manifold: penetrating vertices ────────────────────────────
      const cpx: number[] = [], cpy: number[] = [];

      for (const v of hull2) {
        if (cpx.length >= MAX_CONTACT_POINTS) break;
        if (pointInPoly(v.x, v.y, hull1)) { cpx.push(v.x); cpy.push(v.y); }
      }
      for (const v of hull1) {
        if (cpx.length >= MAX_CONTACT_POINTS) break;
        if (pointInPoly(v.x, v.y, hull2)) { cpx.push(v.x); cpy.push(v.y); }
      }

      // Fallback: two support vertices when no penetrating vertices found
      if (cpx.length === 0) {
        let best1 = -Infinity, best2 = Infinity;
        let sv1x = ship1.position.x, sv1y = ship1.position.y;
        let sv2x = ship2.position.x, sv2y = ship2.position.y;
        for (const v of hull1) {
          const p = v.x * nx + v.y * ny;
          if (p > best1) { best1 = p; sv1x = v.x; sv1y = v.y; }
        }
        for (const v of hull2) {
          const p = v.x * nx + v.y * ny;
          if (p < best2) { best2 = p; sv2x = v.x; sv2y = v.y; }
        }
        cpx.push(sv1x, sv2x);
        cpy.push(sv1y, sv2y);
      }

      // ── Baumgarte position correction ─────────────────────────────────────
      // Server applies the 0.4 factor once per 30 Hz tick; scale by elapsed
      // time so faster callers don't over-correct (4× at 120 Hz).
      const corrScale = Math.min(1, dt * SERVER_TICK_RATE);
      const corr = SHIP_BAUMGARTE * Math.max(depth - SHIP_SLOP, 0) * 0.5 * corrScale;
      ship1.position = ship1.position.sub(normal.mul(corr));
      ship2.position = ship2.position.add(normal.mul(corr));

      // ── Impulse solve ─────────────────────────────────────────────────────
      const p1x = ship1.position.x, p1y = ship1.position.y;
      const p2x = ship2.position.x, p2y = ship2.position.y;
      let v1x = ship1.velocity.x, v1y = ship1.velocity.y;
      let v2x = ship2.velocity.x, v2y = ship2.velocity.y;
      let w1 = ship1.angularVelocity, w2 = ship2.angularVelocity;

      const m1 = ship1.mass > 0 ? ship1.mass : 5000;
      const m2 = ship2.mass > 0 ? ship2.mass : 5000;
      // Server uses the saturated Q16_MAX inertia for every ship — see SHIP_INERTIA_PX.
      const I1 = SHIP_INERTIA_PX;
      const I2 = SHIP_INERTIA_PX;

      const nContacts = Math.min(cpx.length, MAX_CONTACT_POINTS);
      const P_n = new Array<number>(nContacts).fill(0);
      let dv1x = 0, dv1y = 0, dw1 = 0;
      let dv2x = 0, dv2y = 0, dw2 = 0;

      for (let ci = 0; ci < nContacts; ci++) {
        const r1x = cpx[ci] - p1x, r1y = cpy[ci] - p1y;
        const r2x = cpx[ci] - p2x, r2y = cpy[ci] - p2y;

        // Velocity at contact point (v + ω × r, 2-D scalar cross)
        const vc1x = v1x - r1y * w1, vc1y = v1y + r1x * w1;
        const vc2x = v2x - r2y * w2, vc2y = v2y + r2x * w2;

        // Relative normal velocity: (vc1 − vc2)·n > 0 means approaching
        const vrelN = (vc1x - vc2x) * nx + (vc1y - vc2y) * ny;

        const r1xn = r1x * ny - r1y * nx; // 2-D cross: r1 × n
        const r2xn = r2x * ny - r2y * nx;

        const denom = 1 / m1 + 1 / m2 + r1xn * r1xn / I1 + r2xn * r2xn / I2;
        if (denom < 1e-10) continue;

        // Baumgarte velocity bias to drive out residual penetration.
        // Server: β / dt_tick with dt_tick = 1/30 s — the bias is a target
        // separation VELOCITY, so it must not grow when our step dt shrinks.
        const bias = SHIP_BAUMGARTE * SERVER_TICK_RATE * Math.max(depth - SHIP_SLOP, 0);
        if (vrelN <= 0 && bias < 1e-4) continue; // Separating and no penetration

        let J = (-(1 + SHIP_RESTITUTION) * vrelN - bias) / denom;
        if (J > 0) J = 0; // Compression-only

        P_n[ci] = J;
        dv1x += J * nx / m1;   dv1y += J * ny / m1;   dw1 += J * r1xn / I1;
        dv2x -= J * nx / m2;   dv2y -= J * ny / m2;   dw2 -= J * r2xn / I2;
      }

      // ── Friction impulse ──────────────────────────────────────────────────
      for (let ci = 0; ci < nContacts; ci++) {
        if (P_n[ci] >= 0) continue; // No normal impulse → no friction

        const r1x = cpx[ci] - p1x, r1y = cpy[ci] - p1y;
        const r2x = cpx[ci] - p2x, r2y = cpy[ci] - p2y;

        // Post-normal-impulse contact velocity
        const cv1x = (v1x + dv1x) - r1y * (w1 + dw1);
        const cv1y = (v1y + dv1y) + r1x * (w1 + dw1);
        const cv2x = (v2x + dv2x) - r2y * (w2 + dw2);
        const cv2y = (v2y + dv2y) + r2x * (w2 + dw2);

        const relX = cv1x - cv2x, relY = cv1y - cv2y;
        const vn = relX * nx + relY * ny;
        const vtX = relX - vn * nx, vtY = relY - vn * ny;
        const vtLen = Math.sqrt(vtX * vtX + vtY * vtY);
        if (vtLen < 0.001) continue;

        const tx = vtX / vtLen, ty = vtY / vtLen;
        const r1xt = r1x * ty - r1y * tx;
        const r2xt = r2x * ty - r2y * tx;
        const denomF = 1 / m1 + 1 / m2 + r1xt * r1xt / I1 + r2xt * r2xt / I2;
        if (denomF < 1e-10) continue;

        let Jf = -vtLen / denomF;
        const JfMax = SHIP_FRICTION * Math.abs(P_n[ci]);
        Jf = Math.max(-JfMax, Math.min(JfMax, Jf));

        dv1x += Jf * tx / m1;   dv1y += Jf * ty / m1;   dw1 += Jf * r1xt / I1;
        dv2x -= Jf * tx / m2;   dv2y -= Jf * ty / m2;   dw2 -= Jf * r2xt / I2;
      }

      // Write back
      ship1.velocity = Vec2.from(v1x + dv1x, v1y + dv1y);
      ship2.velocity = Vec2.from(v2x + dv2x, v2y + dv2y);
      ship1.angularVelocity = w1 + dw1;
      ship2.angularVelocity = w2 + dw2;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Predict ship-ship collision responses for one simulation substep.
 * Call AFTER position integration (so ships' current positions are the
 * post-integration end-points that CCD can trace back from).
 *
 * @param ships - Mutable ship array from the cloned world state
 * @param dt    - Substep delta time in seconds
 */
export function predictShipCollisions(ships: Ship[], dt: number): void {
  if (ships.length < 2) return;
  runCCDPrepass(ships, dt);
  runDiscreteShipCollisions(ships, dt);
}

// ── Dock (shipyard) U-wall collisions ─────────────────────────────────────────
// Port of server dock_physics.c handle_ship_dock_collisions(): 3 wall OBBs in
// dock-local space (left arm, right arm, back wall), solved with SAT + Baumgarte
// position correction + accumulated normal/friction impulses, a final
// equal-and-opposite reaction pass, and the in-dock angular velocity cap +
// extra angular drag. The server's translational/rotational CCD pre-passes and
// contact-cache warm start are omitted: at 120 Hz prediction steps the per-step
// displacement (< 2 px) can't tunnel a 50 px wall, and divergence is mopped up
// by normal reconciliation.

/** Minimal placed-structure shape needed for dock collision prediction. */
export interface DockStructure {
  type: string;
  x: number;
  y: number;
  /** Rotation in degrees (default 0). */
  rotation?: number;
  construction?: { scaffoldedShipId?: number };
}

// Dock geometry in client pixels (matches dock_physics.c defines)
const DOCK_HW     = 170;
const DOCK_HH     = 445;
const DOCK_ARM_T  = 50;
const DOCK_BACK_T = 50;

const DOCK_RESTITUTION       = 0.18;
const DOCK_WALL_FRICTION     = 0.6;
const DOCK_BAUMGARTE         = 0.3;  // per server tick
const DOCK_SLOP              = 0.5;  // px
const DOCK_N_ITER            = 3;
const DOCK_OMEGA_FLOOR       = 0.04; // rad/s
const DOCK_ANGULAR_EXTRA_DRAG = 0.80; // per server tick, applied near docks

/** The three dock walls as AABBs in dock-local space {cx, cy, hx, hy}. */
const DOCK_WALLS = [
  { cx: -(DOCK_HW - DOCK_ARM_T / 2), cy: 0,                              hx: DOCK_ARM_T / 2, hy: DOCK_HH },
  { cx:  (DOCK_HW - DOCK_ARM_T / 2), cy: 0,                              hx: DOCK_ARM_T / 2, hy: DOCK_HH },
  { cx: 0,                           cy: -(DOCK_HH - DOCK_BACK_T / 2),   hx: DOCK_HW,        hy: DOCK_BACK_T / 2 },
] as const;

interface DockWallContact { pen: number; nx: number; ny: number; cx: number; cy: number; }

/**
 * Per-wall SAT: hull polygon (dock-local px) vs wall AABB.
 * Direct port of server dock_wall_sat(). Returns penetration depth, outward
 * normal (wall → ship), and a contact point, or null when separated.
 */
function dockWallSat(
  hdx: number[], hdy: number[],
  dcx: number, dcy: number, dhx: number, dhy: number,
  originLx: number, originLy: number,
): DockWallContact | null {
  const N = hdx.length;
  let minPen = Infinity, bestNx = 1, bestNy = 0;

  // ── AABB axis X ──
  let hmn = hdx[0], hmx = hdx[0];
  for (let i = 1; i < N; i++) { if (hdx[i] < hmn) hmn = hdx[i]; if (hdx[i] > hmx) hmx = hdx[i]; }
  if (hmx < dcx - dhx || hmn > dcx + dhx) return null;
  {
    const a = hmx - (dcx - dhx), b = (dcx + dhx) - hmn;
    if (a < b) { if (a < minPen) { minPen = a; bestNx =  1; bestNy = 0; } }
    else       { if (b < minPen) { minPen = b; bestNx = -1; bestNy = 0; } }
  }

  // ── AABB axis Y ──
  hmn = hdy[0]; hmx = hdy[0];
  for (let i = 1; i < N; i++) { if (hdy[i] < hmn) hmn = hdy[i]; if (hdy[i] > hmx) hmx = hdy[i]; }
  if (hmx < dcy - dhy || hmn > dcy + dhy) return null;
  {
    const a = hmx - (dcy - dhy), b = (dcy + dhy) - hmn;
    if (a < b) { if (a < minPen) { minPen = a; bestNx = 0; bestNy =  1; } }
    else       { if (b < minPen) { minPen = b; bestNx = 0; bestNy = -1; } }
  }

  // ── Hull edge normals ──
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const ex = hdx[j] - hdx[i], ey = hdy[j] - hdy[i];
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 0.5) continue;
    const nx = -ey / len, ny = ex / len;

    let phMin = Infinity, phMax = -Infinity;
    for (let k = 0; k < N; k++) {
      const p = hdx[k] * nx + hdy[k] * ny;
      if (p < phMin) phMin = p;
      if (p > phMax) phMax = p;
    }
    const ap = [
      (dcx - dhx) * nx + (dcy - dhy) * ny, (dcx + dhx) * nx + (dcy - dhy) * ny,
      (dcx - dhx) * nx + (dcy + dhy) * ny, (dcx + dhx) * nx + (dcy + dhy) * ny,
    ];
    let awMin = ap[0], awMax = ap[0];
    for (let k = 1; k < 4; k++) { if (ap[k] < awMin) awMin = ap[k]; if (ap[k] > awMax) awMax = ap[k]; }
    if (phMax < awMin || phMin > awMax) return null;
    const a = phMax - awMin, b = awMax - phMin;
    if (a < b) { if (a < minPen) { minPen = a; bestNx =  nx; bestNy =  ny; } }
    else       { if (b < minPen) { minPen = b; bestNx = -nx; bestNy = -ny; } }
  }

  // Orient normal: wall → ship origin
  if ((originLx - dcx) * bestNx + (originLy - dcy) * bestNy < 0) {
    bestNx = -bestNx; bestNy = -bestNy;
  }

  // ── Contact point: centroid of hull vertices inside the AABB, else the
  //    support vertex most penetrating along -normal ──
  let sumCx = 0, sumCy = 0, nIn = 0;
  for (let i = 0; i < N; i++) {
    if (hdx[i] >= dcx - dhx && hdx[i] <= dcx + dhx &&
        hdy[i] >= dcy - dhy && hdy[i] <= dcy + dhy) {
      sumCx += hdx[i]; sumCy += hdy[i]; nIn++;
    }
  }
  let cx: number, cy: number;
  if (nIn > 0) {
    cx = sumCx / nIn;
    cy = sumCy / nIn;
  } else {
    let bestP = Infinity;
    cx = hdx[0]; cy = hdy[0];
    for (let i = 0; i < N; i++) {
      const p = hdx[i] * bestNx + hdy[i] * bestNy;
      if (p < bestP) { bestP = p; cx = hdx[i]; cy = hdy[i]; }
    }
  }

  return { pen: minPen, nx: bestNx, ny: bestNy, cx, cy };
}

/**
 * Predict ship vs dock (shipyard) U-wall collision responses.
 * Call AFTER position integration. The ship scaffolded inside a dock is exempt,
 * matching the server.
 *
 * @param ships - Mutable ship array (positions/velocities updated in place)
 * @param docks - Placed structures; non-shipyards are ignored
 * @param dt    - Step delta time in seconds
 */
export function predictDockCollisions(
  ships: Ship[],
  docks: readonly DockStructure[],
  dt: number,
): void {
  if (!docks || docks.length === 0) return;

  for (const dock of docks) {
    if (dock.type !== 'shipyard') continue;
    const scaffoldedId = dock.construction?.scaffoldedShipId ?? 0;
    const dockRad = (dock.rotation ?? 0) * Math.PI / 180;
    const dc = Math.cos(dockRad), ds = Math.sin(dockRad);

    for (const ship of ships) {
      if (scaffoldedId && ship.id === scaffoldedId) continue;
      if (ship.hull.length < 3) continue;

      // Broad phase
      const brad = boundingRadius(ship);
      const ddx = ship.position.x - dock.x, ddy = ship.position.y - dock.y;
      const broad = brad + DOCK_HH + DOCK_HW;
      if (ddx * ddx + ddy * ddy > broad * broad) continue;

      // Hull + ship origin in dock-local space
      const cs = Math.cos(ship.rotation), ss = Math.sin(ship.rotation);
      const N = ship.hull.length;
      const hdx = new Array<number>(N), hdy = new Array<number>(N);
      for (let vi = 0; vi < N; vi++) {
        const wx = ship.position.x + ship.hull[vi].x * cs - ship.hull[vi].y * ss;
        const wy = ship.position.y + ship.hull[vi].x * ss + ship.hull[vi].y * cs;
        const rx = wx - dock.x, ry = wy - dock.y;
        hdx[vi] =  rx * dc + ry * ds;
        hdy[vi] = -rx * ds + ry * dc;
      }
      let lx =  ddx * dc + ddy * ds;
      let ly = -ddx * ds + ddy * dc;

      // Velocity in dock-local space
      const vxDl =  ship.velocity.x * dc + ship.velocity.y * ds;
      const vyDl = -ship.velocity.x * ds + ship.velocity.y * dc;
      const omega0 = ship.angularVelocity;

      const mass = ship.mass > 0 ? ship.mass : 5000;
      const invMass = 1 / mass;
      const invInertia = 1 / SHIP_INERTIA_PX;

      let totalPushX = 0, totalPushY = 0;
      const P_n = [0, 0, 0];
      const P_f = [0, 0, 0];
      let curVx = vxDl, curVy = vyDl, curW = omega0;

      // Per-server-tick factors, rescaled to this step's dt
      const corrScale = Math.min(1, dt * SERVER_TICK_RATE);

      for (let iter = 0; iter < DOCK_N_ITER; iter++) {
        for (let wi = 0; wi < 3; wi++) {
          const w = DOCK_WALLS[wi];
          const sat = dockWallSat(hdx, hdy, w.cx, w.cy, w.hx, w.hy, lx, ly);
          if (!sat) continue;
          const { pen, nx, ny, cx, cy } = sat;

          // Positional correction (Baumgarte-style spreading, dt-scaled)
          const corr = DOCK_BAUMGARTE * Math.max(pen - DOCK_SLOP, 0) * corrScale;
          if (corr > 0) {
            lx += nx * corr; ly += ny * corr;
            for (let vi = 0; vi < N; vi++) { hdx[vi] += nx * corr; hdy[vi] += ny * corr; }
            totalPushX += nx * corr; totalPushY += ny * corr;
          }

          // Lever arm from ship origin to contact point
          const rx = cx - lx, ry = cy - ly;

          // Velocity at contact: v_cm + ω×r
          const vcX = curVx + curW * -ry;
          const vcY = curVy + curW *  rx;
          const vcN = vcX * nx + vcY * ny;

          // ── Normal impulse with Baumgarte velocity bias ──
          const rxn = rx * ny - ry * nx;
          const denom = invMass + rxn * rxn * invInertia;
          if (denom < 1e-10) continue;

          // bias = β / dt_tick × pen — a target separation velocity, defined
          // against the SERVER tick so it doesn't blow up at small client dt.
          const bias = DOCK_BAUMGARTE * SERVER_TICK_RATE * Math.max(pen - DOCK_SLOP, 0);

          const dP = (-(1 + DOCK_RESTITUTION) * vcN + bias) / denom;
          const PnNew = Math.max(P_n[wi] + dP, 0);
          const J = PnNew - P_n[wi];
          P_n[wi] = PnNew;

          curVx += J * nx * invMass;
          curVy += J * ny * invMass;
          curW  += (rx * (J * ny) - ry * (J * nx)) * invInertia;

          // ── Friction impulse (Coulomb, clamped against accumulated P_n) ──
          const vcX2 = curVx + curW * -ry;
          const vcY2 = curVy + curW *  rx;
          const vcN2 = vcX2 * nx + vcY2 * ny;
          const vtX = vcX2 - vcN2 * nx;
          const vtY = vcY2 - vcN2 * ny;
          const vtLen = Math.sqrt(vtX * vtX + vtY * vtY);
          if (vtLen > 0.001) {
            const tx = vtX / vtLen, ty = vtY / vtLen;
            const rxt = rx * ty - ry * tx;
            const denomT = invMass + rxt * rxt * invInertia;
            if (denomT > 1e-10) {
              const dPf = -vtLen / denomT;
              const PfMax = DOCK_WALL_FRICTION * P_n[wi];
              let PfNew = P_f[wi] + dPf;
              if (PfNew >  PfMax) PfNew =  PfMax;
              if (PfNew < -PfMax) PfNew = -PfMax;
              const Jf = PfNew - P_f[wi];
              P_f[wi] = PfNew;
              curVx += Jf * tx * invMass;
              curVy += Jf * ty * invMass;
              curW  += (rx * (Jf * ty) - ry * (Jf * tx)) * invInertia;
            }
          }
        }
      }

      // ── Equal-and-opposite reaction pass: zero any residual approach ──
      for (let wi = 0; wi < 3; wi++) {
        if (P_n[wi] <= 0) continue;
        const w = DOCK_WALLS[wi];
        const sat = dockWallSat(hdx, hdy, w.cx, w.cy, w.hx, w.hy, lx, ly);
        if (!sat) continue;

        const rx = sat.cx - lx, ry = sat.cy - ly;
        const vcX = curVx + curW * -ry;
        const vcY = curVy + curW *  rx;
        const vcN = vcX * sat.nx + vcY * sat.ny;

        if (vcN < 0) {
          const rxn = rx * sat.ny - ry * sat.nx;
          const denom = invMass + rxn * rxn * invInertia;
          if (denom < 1e-10) continue;
          const J = -vcN / denom;
          curVx += J * sat.nx * invMass;
          curVy += J * sat.ny * invMass;
          curW  += rxn * J * invInertia;
          P_n[wi] += J;
        }
      }

      // ── Angular velocity cap + extra in-dock angular drag ──
      // The server limits ω so the fastest hull vertex can't sweep further than
      // its clearance to the nearest inner wall in one SERVER tick, and bleeds
      // angular momentum at ×0.80/tick while inside the dock's broad phase.
      {
        const dtTick = 1 / SERVER_TICK_RATE;
        const aiCap = DOCK_HW - DOCK_ARM_T;   // 120 px inner half-width
        const biCap = DOCK_HH - DOCK_BACK_T;  // 395 px inner half-height

        let omegaMax = 1e10;
        for (let vi = 0; vi < N; vi++) {
          const dvx = hdx[vi] - lx, dvy = hdy[vi] - ly;
          const R = Math.sqrt(dvx * dvx + dvy * dvy);
          if (R < 0.5) continue;

          let minCl = 1e10;
          if (hdx[vi] > -aiCap) minCl = Math.min(minCl, hdx[vi] + aiCap);
          if (hdx[vi] <  aiCap) minCl = Math.min(minCl, aiCap - hdx[vi]);
          if (hdy[vi] > -biCap && Math.abs(hdx[vi]) < aiCap) {
            minCl = Math.min(minCl, hdy[vi] + biCap);
          }
          if (minCl < 0) minCl = 0;

          const wLim = minCl / (R * dtTick);
          if (wLim < omegaMax) omegaMax = wLim;
        }
        if (omegaMax < DOCK_OMEGA_FLOOR) omegaMax = DOCK_OMEGA_FLOOR;

        curW *= Math.pow(DOCK_ANGULAR_EXTRA_DRAG, dt * SERVER_TICK_RATE);
        if (curW >  omegaMax) curW =  omegaMax;
        if (curW < -omegaMax) curW = -omegaMax;
      }

      // ── Write back position (dock-local → world) ──
      if (totalPushX * totalPushX + totalPushY * totalPushY > 0.0001) {
        ship.position = Vec2.from(
          dock.x + lx * dc - ly * ds,
          dock.y + lx * ds + ly * dc,
        );
      }

      // ── Write back velocity delta (rotate dock-local → world) ──
      const dvX = curVx - vxDl, dvY = curVy - vyDl, dW = curW - omega0;
      if (dvX * dvX + dvY * dvY > 1e-8 || Math.abs(dW) > 1e-8) {
        const dvwX = dvX * dc - dvY * ds;
        const dvwY = dvX * ds + dvY * dc;
        ship.velocity = Vec2.from(ship.velocity.x + dvwX, ship.velocity.y + dvwY);
        ship.angularVelocity = ship.angularVelocity + dW;
      }
    }
  }
}

/** Minimal island shape needed for ship-island collision prediction. */
export interface PredictIsland {
  vertices?: readonly { x: number; y: number }[];
}

/**
 * Rigid-body impulse at a ship-island contact point.
 * Direct port of server apply_island_impulse(): normal impulse with e = 0.15
 * followed by a Coulomb friction impulse (μ = 0.75), both with torque response.
 */
function applyIslandImpulse(
  ship: Ship,
  nx: number, ny: number,    // pushout normal (island → ship)
  cpX: number, cpY: number,  // contact point (world px, pre-pushout vertex)
): void {
  let vx = ship.velocity.x, vy = ship.velocity.y;
  let omega = ship.angularVelocity;

  // Lever arm uses the post-pushout ship position, matching server call order
  const rx = cpX - ship.position.x, ry = cpY - ship.position.y;
  const vcX = vx + omega * -ry;
  const vcY = vy + omega *  rx;
  const vcN = vcX * nx + vcY * ny;
  if (vcN >= 0) return; // already separating

  const invM = 1 / (ship.mass > 0 ? ship.mass : 5000);
  const invI = 1 / SHIP_INERTIA_PX;

  // Normal impulse
  const rxn = rx * ny - ry * nx;
  const denom = invM + rxn * rxn * invI;
  if (denom <= 1e-10) return;

  let Jn = -(1 + ISLAND_RESTITUTION) * vcN / denom;
  if (Jn < 0) Jn = 0;
  vx    += Jn * nx * invM;
  vy    += Jn * ny * invM;
  omega += rxn * Jn * invI;

  // Friction impulse (Coulomb, clamped by μ·Jn)
  const vcX2 = vx + omega * -ry;
  const vcY2 = vy + omega *  rx;
  const vcN2 = vcX2 * nx + vcY2 * ny;
  const vtX = vcX2 - vcN2 * nx;
  const vtY = vcY2 - vcN2 * ny;
  const vtLen = Math.sqrt(vtX * vtX + vtY * vtY);
  if (vtLen > 0.001) {
    const tx = vtX / vtLen, ty = vtY / vtLen;
    const rxt = rx * ty - ry * tx;
    const denomT = invM + rxt * rxt * invI;
    if (denomT > 1e-10) {
      let Jf = -vtLen / denomT;
      const JfMax = ISLAND_FRICTION * Jn;
      Jf = Math.max(-JfMax, Math.min(JfMax, Jf));
      vx    += Jf * tx * invM;
      vy    += Jf * ty * invM;
      omega += rxt * Jf * invI;
    }
  }

  ship.velocity = Vec2.from(vx, vy);
  ship.angularVelocity = omega;
}

/**
 * Predict ship-island collision responses.
 * For polygon islands (with `vertices`): push the deepest hull vertex out and
 * apply the server's contact-point impulse (handle_island_collisions →
 * apply_island_impulse). Circular bump-islands (no `vertices`) are skipped —
 * server data doesn't expose the beach radius to the client.
 *
 * @param ships   - Mutable ship array from the cloned world state
 * @param islands - Island definitions received from the server ISLANDS message
 */
export function predictIslandCollisions(ships: Ship[], islands: readonly PredictIsland[]): void {
  if (!islands || islands.length === 0) return;

  for (const isl of islands) {
    if (!isl.vertices || isl.vertices.length < 3) continue; // Skip non-polygon islands
    const islandPoly = isl.vertices.map(v => Vec2.from(v.x, v.y));

    for (const ship of ships) {
      // Broad-phase: bounding circle vs island AABB
      const r = boundingRadius(ship);
      let islMinX = Infinity, islMaxX = -Infinity, islMinY = Infinity, islMaxY = -Infinity;
      for (const v of islandPoly) {
        if (v.x < islMinX) islMinX = v.x; if (v.x > islMaxX) islMaxX = v.x;
        if (v.y < islMinY) islMinY = v.y; if (v.y > islMaxY) islMaxY = v.y;
      }
      const islCx = (islMinX + islMaxX) * 0.5, islCy = (islMinY + islMaxY) * 0.5;
      const islHalfW = (islMaxX - islMinX) * 0.5 + r, islHalfH = (islMaxY - islMinY) * 0.5 + r;
      const shipToCx = ship.position.x - islCx, shipToCy = ship.position.y - islCy;
      if (Math.abs(shipToCx) > islHalfW || Math.abs(shipToCy) > islHalfH) continue;

      // Narrow phase: find deepest hull vertex inside island polygon
      const shipHull = hullToWorld(ship);
      let maxPen = 0, pushNx = 0, pushNy = 0;
      let cpX = 0, cpY = 0; // contact point = deepest penetrating vertex

      for (const v of shipHull) {
        if (!pointInPoly(v.x, v.y, islandPoly)) continue;

        // Closest point on island boundary → push outward
        const vVec = Vec2.from(v.x, v.y);
        const nearest = PolygonUtils.closestPointOnPolygon(vVec, islandPoly);
        const depth = vVec.distanceTo(nearest);
        if (depth > maxPen) {
          maxPen = depth;
          const outDir = vVec.sub(nearest);
          const len = outDir.length();
          if (len > 1e-6) { pushNx = outDir.x / len; pushNy = outDir.y / len; }
          cpX = v.x; cpY = v.y;
        }
      }

      if (maxPen <= 0) continue;

      // Push ship out of island (server pushes by full depth, then impulses)
      ship.position = Vec2.from(
        ship.position.x + pushNx * maxPen,
        ship.position.y + pushNy * maxPen,
      );

      applyIslandImpulse(ship, pushNx, pushNy, cpX, cpY);
    }
  }
}
