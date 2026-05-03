/**
 * ShipPredictor — Client-side prediction for ships only.
 *
 * Mirrors the authoritative server ship physics from two sources:
 *   1. websocket_server.c tick loop  → sail velocity blending + rudder steering
 *   2. sim/simulation.c sim_step     → hydrodynamic drag + position integration
 *
 * Server coordinate system: 1 server unit = 10 client pixels (WORLD_SCALE_FACTOR=10).
 * All constants below that involve speed are scaled ×10 to work in client pixel units.
 * Angular values (rad/s, degrees) are identical in both systems.
 *
 * Usage
 * -----
 *   const predictor = new ShipPredictor();
 *
 *   // Feed authoritative server updates:
 *   predictor.onServerShip(serverWorldState.ships.find(s => s.id === myShipId));
 *
 *   // Feed control inputs as they are sent to the server:
 *   predictor.onSailControl(openness, windEfficiency);
 *   predictor.onRudderControl('left' | 'right' | 'straight');
 *   predictor.onReverseThrust(true | false);
 *
 *   // Each render frame:
 *   predictor.step(dtSeconds);
 *   const ship = predictor.getPredictedShip();  // use for rendering
 */

import { Ship } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';

// ─── Server constants, ported to client pixel units ────────────────────────
// websocket_server.c  BASE_WIND_SPEED = 225 m/s  ×10 → 2250 px/s
const BASE_WIND_SPEED    = 2250;   // px/s — max sail speed at full wind + full openness
const WIND_ACCEL_RATE    = 2.0;    // seconds to reach 63% of target speed (exponential)
const REVERSE_SPEED      = BASE_WIND_SPEED * 0.0375; // 84.375 px/s
const REVERSE_ACCEL      = 0.8;    // seconds (faster time constant for reverse)
const MAX_TURN_RATE      = 2.0;    // rad/s at full rudder + full speed
const RUDDER_ADJUST_RATE = 25.0;   // degrees/s — rudder slew rate
const MAX_RUDDER_ANGLE   = 50.0;   // degrees

// simulation.c drag coefficients.
// C_QUAD_V is halved from server value (0.008) because client speed is ×10 larger
// and the formula is: drag = 1 − (C_LIN + C_QUAD × |v|).
const C_LIN_V  = 0.02;    // linear velocity drag per tick
const C_QUAD_V = 0.0008;  // quadratic velocity drag per tick (0.008 / 10 for client scale)
const C_LIN_W  = 0.04;    // linear angular drag per tick
const C_QUAD_W = 0.06;    // quadratic angular drag per tick
const MIN_DRAG = 0.60;    // drag floor (prevents over-damping in extreme cases)

// Correction blend: how quickly we snap toward authoritative state after divergence.
// Expressed as seconds to complete the correction interpolation.
const CORRECTION_DURATION  = 0.12; // seconds — fast enough to not feel laggy
const CORRECTION_SNAP_POS  = 50;   // px  — snap immediately above this divergence
const CORRECTION_SNAP_ROT  = 0.30; // rad — snap immediately above this divergence
const CORRECTION_BLEND_POS = 5;    // px  — ignore correction below this threshold
const CORRECTION_BLEND_ROT = 0.05; // rad — ignore correction below this threshold

// ─── Control state ──────────────────────────────────────────────────────────
export interface ShipControlState {
  /** Average sail openness (0–100) across all masts */
  sailOpenness: number;
  /** Average wind efficiency (0–1); 1 = pristine fibers */
  windEfficiency: number;
  /** Current rudder angle in degrees, updated each step toward targetRudderAngle */
  rudderAngle: number;
  /** Desired rudder angle in degrees (-50 = full left, +50 = full right) */
  targetRudderAngle: number;
  /** True while the helmsman holds the reverse-thrust key */
  reverseThrust: boolean;
  /** Global wind power (0–1); matches server global_sim->wind_power */
  windPower: number;
}

// ─── ShipPredictor ──────────────────────────────────────────────────────────
export class ShipPredictor {
  private authoritativeShip: Ship | null = null;
  private predictedShip: Ship | null = null;

  // Smooth correction from predicted → authoritative when diverged
  private correctionTarget: Ship | null = null;
  private correctionProgress = 0; // 0 → 1 over CORRECTION_DURATION

  private controlState: ShipControlState = {
    sailOpenness:      0,
    windEfficiency:    1.0,
    rudderAngle:       0,
    targetRudderAngle: 0,
    reverseThrust:     false,
    windPower:         0.5, // server default
  };

  // ── Server state ingestion ──────────────────────────────────────────────

  /**
   * Call every time a server world_state arrives with this ship.
   * Drives reconciliation: small errors are blended out, large ones snap.
   */
  onServerShip(ship: Ship): void {
    this.authoritativeShip = ship;

    if (!this.predictedShip) {
      // Cold start — accept server state verbatim
      this.predictedShip = this.cloneShip(ship);
      // Sync rudder from ship data (the server broadcasts rudder_angle in radians)
      this.controlState.rudderAngle = ship.rudderAngle * (180 / Math.PI);
      return;
    }

    const posDiff = ship.position.sub(this.predictedShip.position).length();
    const rotDiff = Math.abs(this.angleDiff(ship.rotation, this.predictedShip.rotation));

    if (posDiff > CORRECTION_SNAP_POS || rotDiff > CORRECTION_SNAP_ROT) {
      // Large divergence — hard snap
      this.predictedShip = this.cloneShip(ship);
      this.correctionTarget = null;
    } else if (posDiff > CORRECTION_BLEND_POS || rotDiff > CORRECTION_BLEND_ROT) {
      // Small divergence — start a smooth blend
      this.correctionTarget   = this.cloneShip(ship);
      this.correctionProgress = 0;
    }
    // Below threshold → prediction is accurate enough, keep it unchanged
  }

  // ── Control input tracking ──────────────────────────────────────────────
  // Call these immediately after sending the matching message to the server.

  /** Called when SHIP_SAIL_CONTROL is sent to the server. */
  onSailControl(openness: number, windEfficiency = 1.0): void {
    this.controlState.sailOpenness  = Math.max(0, Math.min(100, openness));
    this.controlState.windEfficiency = Math.max(0, Math.min(1, windEfficiency));
  }

  /** Called when SHIP_RUDDER_CONTROL is sent to the server. */
  onRudderControl(direction: 'left' | 'right' | 'straight'): void {
    this.controlState.targetRudderAngle =
      direction === 'left'  ? -MAX_RUDDER_ANGLE :
      direction === 'right' ?  MAX_RUDDER_ANGLE : 0;
  }

  /** Called when the helmsman's reverse-thrust key changes state. */
  onReverseThrust(active: boolean): void {
    this.controlState.reverseThrust = active;
  }

  /**
   * Update global wind power from a server broadcast.
   * Defaults to 0.5 (server init value) until set.
   */
  setWindPower(power: number): void {
    this.controlState.windPower = power;
  }

  // ── Simulation step ─────────────────────────────────────────────────────

  /**
   * Advance the predicted ship state by `dt` seconds.
   * Should be called once per render frame (variable dt is fine).
   */
  step(dt: number): void {
    if (!this.predictedShip) return;

    const ship = this.predictedShip;
    const ctrl = this.controlState;

    // ── 1. Rudder smoothing (websocket_server.c, runs every 200ms but we apply
    //       continuously here — equivalent over the same wall-clock time) ──────
    const maxRudderChange = RUDDER_ADJUST_RATE * dt;
    const rudderDiff   = ctrl.targetRudderAngle - ctrl.rudderAngle;
    const rudderChange = Math.max(-maxRudderChange, Math.min(maxRudderChange, rudderDiff));
    ctrl.rudderAngle   = Math.max(-MAX_RUDDER_ANGLE,
                           Math.min( MAX_RUDDER_ANGLE, ctrl.rudderAngle + rudderChange));

    // ── 2. Sail velocity blending ─────────────────────────────────────────
    //    target_speed = BASE_WIND_SPEED × wind_force_factor
    //    velocity = velocity + (target_velocity - velocity) × blend
    const windForceFactor = (ctrl.windPower * ctrl.sailOpenness / 100.0) * ctrl.windEfficiency;
    const targetSpeed     = BASE_WIND_SPEED * windForceFactor;
    const blendFactor     = 1.0 - Math.exp(-dt / WIND_ACCEL_RATE);

    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);

    let vx = ship.velocity.x + (cos * targetSpeed - ship.velocity.x) * blendFactor;
    let vy = ship.velocity.y + (sin * targetSpeed - ship.velocity.y) * blendFactor;

    // ── 3. Reverse thrust override ────────────────────────────────────────
    if (ctrl.reverseThrust) {
      const revBlend = 1.0 - Math.exp(-dt / REVERSE_ACCEL);
      vx += (-cos * REVERSE_SPEED - vx) * revBlend;
      vy += (-sin * REVERSE_SPEED - vy) * revBlend;
    }

    // ── 4. Rudder → angular velocity ──────────────────────────────────────
    const currentSpeed = Math.sqrt(vx * vx + vy * vy);
    const speedFactor  = Math.max(0.05, currentSpeed / BASE_WIND_SPEED);
    const turnRate     = (ctrl.rudderAngle / MAX_RUDDER_ANGLE) * MAX_TURN_RATE * speedFactor;

    let angVel = ship.angularVelocity;
    if (turnRate !== 0) {
      // Only apply if rudder wants more spin than current (don't fight collision spin)
      if (!((turnRate > 0 && angVel >= turnRate) || (turnRate < 0 && angVel <= turnRate))) {
        angVel = turnRate;
      }
    }
    // No steering input: angular drag (below) decays existing spin naturally

    // ── 5. Hydrodynamic drag — matches simulation.c exactly ───────────────
    const spd   = Math.sqrt(vx * vx + vy * vy);
    const dragV = Math.max(MIN_DRAG, 1.0 - (C_LIN_V + C_QUAD_V * spd));
    vx    *= dragV;
    vy    *= dragV;

    const absW  = Math.abs(angVel);
    const dragW = Math.max(MIN_DRAG, 1.0 - (C_LIN_W + C_QUAD_W * absW));
    angVel *= dragW;

    // ── 6. Position integration ───────────────────────────────────────────
    ship.velocity        = Vec2.from(vx, vy);
    ship.angularVelocity = angVel;
    ship.position        = ship.position.add(ship.velocity.mul(dt));
    ship.rotation       += ship.angularVelocity * dt;
    ship.rotation        = this.wrapAngle(ship.rotation);

    // ── 7. Smooth correction blend ────────────────────────────────────────
    if (this.correctionTarget) {
      this.correctionProgress = Math.min(1.0, this.correctionProgress + dt / CORRECTION_DURATION);
      const alpha = this.smoothStep(this.correctionProgress);

      ship.position = Vec2.from(
        ship.position.x + (this.correctionTarget.position.x - ship.position.x) * alpha,
        ship.position.y + (this.correctionTarget.position.y - ship.position.y) * alpha,
      );
      ship.rotation = this.lerpAngle(ship.rotation, this.correctionTarget.rotation, alpha);

      if (this.correctionProgress >= 1.0) {
        // Blend complete — snap remaining delta and clear
        ship.velocity        = Vec2.from(this.correctionTarget.velocity.x, this.correctionTarget.velocity.y);
        ship.angularVelocity = this.correctionTarget.angularVelocity;
        this.correctionTarget   = null;
        this.correctionProgress = 0;
      }
    }
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  /** Returns the current predicted ship for rendering, or null before first server state. */
  getPredictedShip(): Ship | null {
    return this.predictedShip;
  }

  /** Returns the last authoritative server state (unmodified). */
  getAuthoritativeShip(): Ship | null {
    return this.authoritativeShip;
  }

  getControlState(): Readonly<ShipControlState> {
    return this.controlState;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private cloneShip(ship: Ship): Ship {
    return {
      ...ship,
      position: Vec2.from(ship.position.x, ship.position.y),
      velocity: Vec2.from(ship.velocity.x, ship.velocity.y),
      hull:     ship.hull.map(v => Vec2.from(v.x, v.y)),
      modules:  ship.modules, // shallow — modules are not mutated
    };
  }

  /** Shortest signed difference between two angles in radians. */
  private angleDiff(a: number, b: number): number {
    let d = b - a;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  /** Wrap angle to [0, 2π]. */
  private wrapAngle(a: number): number {
    const TWO_PI = 2 * Math.PI;
    a = a % TWO_PI;
    if (a < 0) a += TWO_PI;
    return a;
  }

  /** Spherical linear interpolation for angles. */
  private lerpAngle(from: number, to: number, t: number): number {
    return this.wrapAngle(from + this.angleDiff(from, to) * t);
  }

  /** Quintic ease-in-out for smooth correction blending. */
  private smoothStep(t: number): number {
    t = Math.max(0, Math.min(1, t));
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
}
