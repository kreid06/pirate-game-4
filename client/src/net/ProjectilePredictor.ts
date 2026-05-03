/**
 * ProjectilePredictor — Zero-latency client-side cannonball prediction.
 *
 * When the local player fires a cannon, call `fire()` immediately so the
 * cannonball appears on screen with no network round-trip delay.  The
 * predicted projectile is simulated locally and removed as soon as the
 * server confirms a matching one (or after the maximum lifetime elapses).
 *
 * Server physics (simulation.c  update_projectile_physics):
 *   • Straight-line integration:  position += velocity × dt  (no gravity — top-down)
 *   • Default lifetime: 4 000 ms effective age (doubles over land)
 *   • No drag on projectiles
 *
 * Coordinate system: client pixels (server units × 10).
 */

import { Cannonball } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';

// Maximum lifetime in milliseconds (matches server default).
const MAX_LIFETIME_MS = 4000;

// Reconciliation tolerances when matching a predicted shot to a server-confirmed one.
const MATCH_POS_TOLERANCE = 80;  // px  — allow for a frame or two of travel
const MATCH_VEL_TOLERANCE = 50;  // px/s

// Predicted IDs are negative so they never collide with server-assigned IDs.
let nextPredictedId = -1;

// ─── Internal predicted-projectile record ───────────────────────────────────
interface PredictedProjectile {
  id: number;
  position: Vec2;
  velocity: Vec2;
  firingVelocity: Vec2;
  radius: number;
  ageMs: number;
  /** True once a server-confirmed match has been found — will be removed next step. */
  confirmed: boolean;
}

// ─── ProjectilePredictor ────────────────────────────────────────────────────
export class ProjectilePredictor {
  private predicted = new Map<number, PredictedProjectile>();

  /**
   * Set of projectile IDs that have already been seen from the server.
   * Used during reconciliation to avoid re-matching already-known projectiles.
   */
  private knownServerIds = new Set<number>();

  // ── Firing ────────────────────────────────────────────────────────────────

  /**
   * Spawn a locally-predicted cannonball immediately when the player fires.
   *
   * @param position  Muzzle position in client pixels.
   * @param velocity  Initial velocity in client pixels/second.
   * @param radius    Visual radius in pixels (default 6).
   * @returns  The negative predicted ID.
   */
  fire(position: Vec2, velocity: Vec2, radius = 6): number {
    const id = nextPredictedId--;
    const proj: PredictedProjectile = {
      id,
      position:       Vec2.from(position.x, position.y),
      velocity:       Vec2.from(velocity.x, velocity.y),
      firingVelocity: Vec2.from(velocity.x, velocity.y),
      radius,
      ageMs:     0,
      confirmed: false,
    };
    this.predicted.set(id, proj);
    return id;
  }

  // ── Per-frame simulation ──────────────────────────────────────────────────

  /**
   * Advance all live predicted projectiles.
   * Call once per render frame with the elapsed time in milliseconds.
   */
  step(dtMs: number): void {
    const dtSec = dtMs / 1000;

    for (const [id, proj] of this.predicted) {
      // Remove confirmed or expired projectiles
      if (proj.confirmed || proj.ageMs >= MAX_LIFETIME_MS) {
        this.predicted.delete(id);
        continue;
      }

      // Straight-line integration — exactly matches simulation.c
      proj.position = proj.position.add(proj.velocity.mul(dtSec));
      proj.ageMs   += dtMs;
    }
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  /**
   * Compare the current server projectile list against local predictions.
   *
   * Any server projectile that hasn't been seen before and is spatially
   * close to a predicted one is treated as the server-confirmed version of
   * that prediction.  The predicted entry is marked confirmed and removed on
   * the next `step()`.
   *
   * Call this every time a new server world_state / snapshot arrives.
   */
  reconcile(serverProjectiles: Cannonball[]): void {
    // Collect newly-arrived server projectiles (not seen in any previous tick)
    const newServerProjectiles: Cannonball[] = [];
    for (const sp of serverProjectiles) {
      if (!this.knownServerIds.has(sp.id)) {
        newServerProjectiles.push(sp);
      }
    }

    // Rebuild the known-ID set for next frame
    this.knownServerIds = new Set(serverProjectiles.map(p => p.id));

    // Try to match each new server projectile to an unconfirmed prediction
    for (const sp of newServerProjectiles) {
      let bestMatch: PredictedProjectile | null = null;
      let bestScore = Infinity;

      for (const proj of this.predicted.values()) {
        if (proj.confirmed) continue;

        const posDiff = sp.position.sub(proj.position).length();
        const velDiff = sp.velocity.sub(proj.velocity).length();

        if (posDiff < MATCH_POS_TOLERANCE && velDiff < MATCH_VEL_TOLERANCE) {
          // Use combined distance + velocity difference as score
          const score = posDiff + velDiff;
          if (score < bestScore) {
            bestScore = score;
            bestMatch = proj;
          }
        }
      }

      if (bestMatch) {
        bestMatch.confirmed = true;
      }
    }
  }

  // ── Rendering helper ──────────────────────────────────────────────────────

  /**
   * Returns all live (unconfirmed) predicted projectiles as `Cannonball` objects,
   * ready to be merged into the render world state alongside server-confirmed ones.
   *
   * The IDs are negative so the renderer can optionally distinguish them
   * (e.g. for a slightly different visual style while unconfirmed).
   */
  getPredictedCannonballs(): Cannonball[] {
    const result: Cannonball[] = [];
    for (const proj of this.predicted.values()) {
      if (!proj.confirmed) {
        result.push(this.toCannonball(proj));
      }
    }
    return result;
  }

  /** Total count of live predicted projectiles (useful for debug overlays). */
  get count(): number {
    return this.predicted.size;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private toCannonball(proj: PredictedProjectile): Cannonball {
    return {
      id:               proj.id,
      position:         proj.position,
      velocity:         proj.velocity,
      firingVelocity:   proj.firingVelocity,
      radius:           proj.radius,
      maxRange:         Infinity,
      distanceTraveled: proj.velocity.length() * (proj.ageMs / 1000),
      timeAlive:        proj.ageMs / 1000,
      firedFrom:        0,
      ammoType:         0,
      smokeTrail:       [],
    };
  }
}
