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
import { BRIGANTINE_MASS } from '../common/ShipDefinitions.js';
import {
  predictShipCollisions,
  predictIslandCollisions,
  predictDockCollisions,
  DockStructure,
} from '../sim/PhysicsCollisionPredict.js';

/** Minimal island shape needed for shallow-water drag prediction. */
export interface ShallowDragIsland {
  x: number;
  y: number;
  vertices?: { x: number; y: number }[];
  shallowVertices?: { x: number; y: number }[];
}

// ─── Server constants, ported to client pixel units ────────────────────────
// websocket_server.c  BASE_WIND_SPEED = 225 m/s  ×10 → 2250 px/s
const BASE_WIND_SPEED    = 2250;   // px/s — max sail speed at full wind + full openness
const WIND_ACCEL_RATE    = 2.0;    // seconds to reach 63% of target speed (exponential)
const REVERSE_SPEED      = BASE_WIND_SPEED * 0.0375; // 84.375 px/s
const REVERSE_ACCEL      = 0.8;    // seconds (faster time constant for reverse)
const MAX_RUDDER_ANGLE   = 50.0;   // degrees
const RUDDER_ADJUST_RATE = 25.0;   // degrees/s — rudder slew rate
// Torque-based turning — mirrors server websocket_server.c + simulation.c
const MAX_RUDDER_TORQUE  = 20000;  // N⋅m at full 50° deflection
// Server stores moment_inertia as Q16_FROM_FLOAT(50000.0f), but 50000×65536=3.27B
// overflows INT32_MAX and saturates to INT32_MAX=2147483647 at runtime on x86-64.
// Effective Q16 value = INT32_MAX/65536 ≈ 32767.999, so we use 32768 here.
// → ang_accel = 20000 / 32768 = 0.6104 rad/s² (matches server q16_div result).
const MOMENT_INERTIA     = 32768;  // effective kg⋅m² after server Q16 overflow

// simulation.c drag coefficients.
// C_QUAD_V is divided by 10 from server value (0.008) because client speed is ×10 larger
// and the formula is: drag = 1 − (C_LIN + C_QUAD × |v|).
const C_LIN_V  = 0.02;    // linear velocity drag per SERVER tick
const C_QUAD_V = 0.0008;  // quadratic velocity drag per SERVER tick (0.008 / 10 for client scale)
const C_LIN_W  = 0.04;    // linear angular drag per SERVER tick
const C_QUAD_W = 0.06;    // quadratic angular drag per SERVER tick
const MIN_DRAG = 0.60;    // drag floor (prevents over-damping in extreme cases)

// CRITICAL: the server applies the drag factor ONCE PER 30 Hz SIM TICK (sim_step in
// server.c runs at TICK_RATE_HZ=30). The client steps this predictor at the 120 Hz
// client tick. Applying the per-tick factor on every 120 Hz step over-damps 4× —
// the predicted ship's top speed collapses far below the server's, so the ship
// constantly lags behind and gets dragged forward by corrections (rubberbanding
// while sailing). Drag must be scaled to elapsed time: factor^(dt × 30).
const SERVER_TICK_RATE = 30;

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
  /** World-space wind angle in radians — same CW-from-North convention as server */
  windAngle: number;
}

// ─── ShipPredictor ──────────────────────────────────────────────────────────
export class ShipPredictor {
  private authoritativeShip: Ship | null = null;
  private predictedShip: Ship | null = null;

  // Smooth correction from predicted → authoritative when diverged
  private correctionTarget: Ship | null = null;
  private correctionProgress = 0; // 0 → 1 over CORRECTION_DURATION

  // Island definitions for shallow-water drag (fed by ClientApplication)
  private islands: readonly ShallowDragIsland[] = [];

  // Other ships (cloned snapshot state, dead-reckoned between snapshots) and
  // shipyard docks — collision impulse partners for the predicted ship.
  private otherShips: Ship[] = [];
  private docks: readonly DockStructure[] = [];

  private controlState: ShipControlState = {
    sailOpenness:      0,
    windEfficiency:    1.0,
    rudderAngle:       0,
    targetRudderAngle: 0,
    reverseThrust:     false,
    windPower:         0.5, // server default
    windAngle:         0,
  };

  // ── Server state ingestion ──────────────────────────────────────────────

  /**
   * Call every time a server world_state arrives with this ship.
   * Drives reconciliation: small errors are blended out, large ones snap.
   *
   * @param snapshotAgeMs How old the snapshot is (≈ ½ RTT + snapshot cadence).
   *   CRITICAL for rubberband-free sailing: the snapshot describes where the ship
   *   WAS, not where it is. Comparing/blending against the raw snapshot drags the
   *   predicted ship backwards by speed × age on every snapshot (e.g. 200 px/s ×
   *   130 ms ≈ 26 px — far above the blend threshold), creating a constant
   *   speed-proportional sawtooth. We forward-project the snapshot by its age
   *   through the same physics step before using it.
   */
  onServerShip(ship: Ship, snapshotAgeMs = 0): void {
    this.authoritativeShip = ship;

    // Re-sync rudder if prediction drifted (lost control message / missed ack).
    // Server broadcasts rudder_angle in radians; ours slews locally at 25°/s.
    const serverRudderDeg = ship.rudderAngle * (180 / Math.PI);
    if (Math.abs(serverRudderDeg - this.controlState.rudderAngle) > 15) {
      this.controlState.rudderAngle = serverRudderDeg;
    }

    if (!this.predictedShip) {
      // Cold start — accept server state verbatim
      this.predictedShip = this.cloneShip(ship);
      this.controlState.rudderAngle = serverRudderDeg;
      return;
    }

    // Forward-project the authoritative state to "now" using the same physics
    // step the prediction runs, in ≤ one-server-tick substeps. The other-ship
    // clones (fed via setOtherShips just before this call) are equally stale,
    // so dead-reckon them forward by the same age in lockstep.
    const projected = this.cloneShip(ship);
    let remaining = Math.max(0, Math.min(0.5, snapshotAgeMs / 1000));
    const maxSub = 1 / SERVER_TICK_RATE;
    while (remaining > 1e-4) {
      const sub = Math.min(maxSub, remaining);
      this.advanceOtherShips(sub);
      this.simulateShip(projected, sub);
      remaining -= sub;
    }

    const posDiff = projected.position.sub(this.predictedShip.position).length();
    const rotDiff = Math.abs(this.angleDiff(projected.rotation, this.predictedShip.rotation));

    if (posDiff > CORRECTION_SNAP_POS || rotDiff > CORRECTION_SNAP_ROT) {
      // Large divergence — hard snap
      this.predictedShip = projected;
      this.correctionTarget = null;
    } else if (posDiff > CORRECTION_BLEND_POS || rotDiff > CORRECTION_BLEND_ROT) {
      // Small divergence — start a smooth blend
      this.correctionTarget   = projected;
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

  /** Update world-space wind angle from a server broadcast. */
  setWindAngle(angle: number): void {
    this.controlState.windAngle = angle;
  }

  /**
   * Provide island definitions for shallow-water drag prediction.
   * Server applies up to an extra ×0.90/tick drag inside the shallow ring
   * around islands (simulation.c) — without mirroring it the predicted ship
   * overshoots hard whenever sailing near land.
   */
  setIslands(islands: readonly ShallowDragIsland[]): void {
    this.islands = islands;
  }

  /**
   * Provide the latest snapshot of ALL ships so collision impulses (ship-ship
   * CCD + SAT + impulse, identical to the server pipeline) can be predicted.
   * The predicted ship itself is excluded; the rest are cloned so the solver
   * can mutate them freely. Call on every snapshot, BEFORE onServerShip —
   * the forward projection then advances these clones by the snapshot age too.
   */
  setOtherShips(allShips: readonly Ship[], selfShipId: number): void {
    this.otherShips = allShips
      .filter(s => s.id !== selfShipId)
      .map(s => this.cloneShip(s));
  }

  /**
   * Provide placed structures so dock (shipyard) U-wall collisions can be
   * predicted. Non-shipyard structures are filtered out here.
   */
  setStructures(structures: readonly DockStructure[]): void {
    this.docks = structures.filter(s => s.type === 'shipyard');
  }

  // ── Simulation step ─────────────────────────────────────────────────────

  /**
   * Advance the predicted ship state by `dt` seconds.
   * Should be called once per render frame (variable dt is fine).
   */
  step(dt: number): void {
    if (!this.predictedShip) return;

    const ctrl = this.controlState;

    // ── 1. Rudder smoothing (websocket_server.c, runs every 200ms but we apply
    //       continuously here — equivalent over the same wall-clock time) ──────
    const maxRudderChange = RUDDER_ADJUST_RATE * dt;
    const rudderDiff   = ctrl.targetRudderAngle - ctrl.rudderAngle;
    const rudderChange = Math.max(-maxRudderChange, Math.min(maxRudderChange, rudderDiff));
    ctrl.rudderAngle   = Math.max(-MAX_RUDDER_ANGLE,
                           Math.min( MAX_RUDDER_ANGLE, ctrl.rudderAngle + rudderChange));

    // ── 2-6. Shared physics core (also used to forward-project snapshots) ──
    // Dead-reckon the other-ship clones exactly once per step, then simulate.
    this.advanceOtherShips(dt);
    this.simulateShip(this.predictedShip, dt);

    // ── 7. Smooth correction blend ────────────────────────────────────────
    const ship = this.predictedShip;
    if (this.correctionTarget) {
      // CRITICAL: advance the correction target through the SAME physics as the
      // predicted ship. The target is the server state forward-projected to the
      // snapshot's arrival time — if left frozen, every blend step pulls the
      // predicted ship backwards toward a stale position (≈ speed × blend age),
      // which reads as constant lag/rubberbanding whenever small corrections
      // are active (e.g. tacking through the wind, where transient divergence
      // keeps restarting the blend on every snapshot).
      this.simulateShip(this.correctionTarget, dt);

      this.correctionProgress = Math.min(1.0, this.correctionProgress + dt / CORRECTION_DURATION);
      const alpha = this.smoothStep(this.correctionProgress);

      ship.position = Vec2.from(
        ship.position.x + (this.correctionTarget.position.x - ship.position.x) * alpha,
        ship.position.y + (this.correctionTarget.position.y - ship.position.y) * alpha,
      );
      ship.rotation = this.lerpAngle(ship.rotation, this.correctionTarget.rotation, alpha);

      // Blend kinematics too. Velocity error is the SOURCE of repeated position
      // divergence — snapshots arrive faster than CORRECTION_DURATION, so the
      // old "snap velocity at completion" never ran and Δv persisted forever,
      // re-diverging the position right after every partial correction.
      ship.velocity = Vec2.from(
        ship.velocity.x + (this.correctionTarget.velocity.x - ship.velocity.x) * alpha,
        ship.velocity.y + (this.correctionTarget.velocity.y - ship.velocity.y) * alpha,
      );
      ship.angularVelocity +=
        (this.correctionTarget.angularVelocity - ship.angularVelocity) * alpha;

      if (this.correctionProgress >= 1.0) {
        // Blend complete — snap remaining delta and clear
        ship.velocity        = Vec2.from(this.correctionTarget.velocity.x, this.correctionTarget.velocity.y);
        ship.angularVelocity = this.correctionTarget.angularVelocity;
        this.correctionTarget   = null;
        this.correctionProgress = 0;
      }
    }
  }

  /**
   * Server-mirrored ship physics for one `dt` step, applied in-place to `ship`.
   * Used both for the live prediction (step) and for forward-projecting server
   * snapshots by their network age (onServerShip), guaranteeing both paths
   * advance through identical physics.
   */
  private simulateShip(ship: Ship, dt: number): void {
    const ctrl = this.controlState;

    // ── 2. Sail velocity blending ─────────────────────────────────────────
    //    Mirrors server exactly: wind_force_factor = wind_power × openness × efficiency × align
    //    Sail alignment: sail world angle vs wind angle (±15°=100%, ±90°=15%, linear blend)
    //
    //    IMPORTANT: read sail state from the LIVE authoritative modules, not from the
    //    one-shot control inputs. The server only applies a sail-control message when a
    //    rigger (NPC/crew) is actually manning the mast — if we trusted the control input
    //    the client would predict thrust that the server never applies. The snapshot's
    //    mast openness/efficiency is what the server really uses, and it also carries the
    //    per-sail quality multiplier (qse) that boosts wind efficiency on quality sails.
    const moduleSource = this.authoritativeShip ?? ship;
    let totalAlign = 0, totalOpenness = 0, totalEff = 0, mastCount = 0;
    for (const mod of moduleSource.modules) {
      if (mod.kind === 'mast' && mod.moduleData) {
        const md = mod.moduleData as { angle?: number; openness?: number; windEfficiency?: number };
        totalOpenness += md.openness ?? 0;

        // Wind efficiency boosted by sail-effectiveness quality (server: se_q8 / 256).
        let eff = md.windEfficiency ?? 1.0;
        const seQ8 = (mod as { qualitySailEffQ8?: number }).qualitySailEffQ8;
        if (seQ8 !== undefined && seQ8 > 256) eff *= seQ8 / 256;
        totalEff += eff;

        const sailWorld = (md.angle ?? 0) + ship.rotation + Math.PI / 2;
        let diff = sailWorld - ctrl.windAngle;
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const absDiff = Math.abs(diff);
        const FULL_EFF = 15 * Math.PI / 180;
        const NO_EFF   = 90 * Math.PI / 180;
        totalAlign += absDiff <= FULL_EFF ? 1.0
                    : absDiff >= NO_EFF   ? 0.15
                    : 1.0 - 0.85 * (absDiff - FULL_EFF) / (NO_EFF - FULL_EFF);
        mastCount++;
      }
    }
    const avgSailOpenness = mastCount > 0 ? totalOpenness / mastCount : 0;
    const avgWindEff      = mastCount > 0 ? totalEff      / mastCount : 1.0;
    const avgSailAlign    = mastCount > 0 ? totalAlign    / mastCount : 1.0;
    const windForceFactor = (ctrl.windPower * avgSailOpenness / 100.0)
                            * avgWindEff * avgSailAlign;

    // Mass scaling — mirrors server: same load% = same speed regardless of Weight level.
    // effective_mass = raw_mass * (base_cap / weight_cap); base_cap = 6000 kg.
    // Use the authoritative ship for mass/levels — the predicted clone goes stale.
    const weightCap     = 6000 + ((moduleSource.levelStats?.levels?.[0] ?? 1) - 1) * 400;
    const effectiveMass = moduleSource.mass > 0
      ? moduleSource.mass * (6000 / weightCap)
      : BRIGANTINE_MASS;
    const massRatio     = effectiveMass > 0 ? BRIGANTINE_MASS / effectiveMass : 1.0;
    const targetSpeed = BASE_WIND_SPEED * windForceFactor * massRatio;
    const blendFactor = 1.0 - Math.exp(-dt / WIND_ACCEL_RATE);

    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);

    let vx = ship.velocity.x + (cos * targetSpeed - ship.velocity.x) * blendFactor;
    let vy = ship.velocity.y + (sin * targetSpeed - ship.velocity.y) * blendFactor;

    // ── 3. Reverse thrust override — only when sails are fully closed ────────
    // Server gates on the ACTUAL avg mast openness (avg_sail_openness == 0.0f),
    // so use the live module value, not the optimistic control input.
    if (ctrl.reverseThrust && avgSailOpenness === 0) {
      const revSpeed = REVERSE_SPEED * massRatio;
      const revBlend = 1.0 - Math.exp(-dt / REVERSE_ACCEL);
      vx += (-cos * revSpeed - vx) * revBlend;
      vy += (-sin * revSpeed - vy) * revBlend;
    }

    // ── 4. Rudder → torque → angular acceleration (mirrors server sim_step) ──
    // net_torque += rudder_factor * MAX_RUDDER_TORQUE
    // ang_accel   = net_torque / moment_inertia
    // angVel     += ang_accel * dt   (drag applied in step 5)
    const rudderNorm = ctrl.rudderAngle / MAX_RUDDER_ANGLE; // -1 to +1
    const angAccel   = (rudderNorm * MAX_RUDDER_TORQUE) / MOMENT_INERTIA; // rad/s²
    let angVel = ship.angularVelocity + angAccel * dt;

    // ── 5. Hydrodynamic drag — matches simulation.c, rate-corrected ───────
    // Server multiplies by the factor once per 30 Hz tick; we step at 120 Hz, so
    // raise the per-tick factor to the power (dt × 30) to apply the same total
    // damping over the same wall-clock time (exponent 0.25 per 120 Hz step).
    const dragExp = dt * SERVER_TICK_RATE;
    const spd   = Math.sqrt(vx * vx + vy * vy);
    const dragV = Math.pow(Math.max(MIN_DRAG, 1.0 - (C_LIN_V + C_QUAD_V * spd)), dragExp);
    vx    *= dragV;
    vy    *= dragV;

    const absW  = Math.abs(angVel);
    const dragW = Math.pow(Math.max(MIN_DRAG, 1.0 - (C_LIN_W + C_QUAD_W * absW)), dragExp);
    angVel *= dragW;

    // ── 5b. Shallow-water drag — mirrors simulation.c (applied after base drag).
    // Gradient: ×0.90/tick at the island sand boundary → ×1.0 at the shallow
    // ring's outer edge. Hits BOTH velocity and angular velocity. Without this
    // the predicted ship blows past the server's whenever sailing near land.
    {
      const depth = this.shallowWaterDepth(ship.position.x, ship.position.y);
      if (depth > 0) {
        const MAX_DRAG_COEFF = 0.90;
        const shallowDrag = Math.pow(1.0 - depth * (1.0 - MAX_DRAG_COEFF), dragExp);
        vx     *= shallowDrag;
        vy     *= shallowDrag;
        angVel *= shallowDrag;
      }
    }

    // ── 6. Position integration ───────────────────────────────────────────
    ship.velocity        = Vec2.from(vx, vy);
    ship.angularVelocity = angVel;
    ship.position        = ship.position.add(ship.velocity.mul(dt));
    ship.rotation       += ship.angularVelocity * dt;
    ship.rotation        = this.wrapAngle(ship.rotation);

    // ── 7. Collision impulses — mirrors the server's post-integration pass ──
    this.applyCollisionImpulses(ship, dt);
  }

  /**
   * Server-mirrored collision pipeline for one step, applied after position
   * integration (matching server.c tick order):
   *   1. Ship-ship   — CCD pre-pass + SAT + multipoint impulse + friction
   *   2. Dock U-walls— SAT + Baumgarte + impulse + friction + ω cap
   *   3. Ship-island — vertex pushout + contact-point impulse + friction
   *
   * Other ships are dead-reckoned forward via advanceOtherShips() (called once
   * per time advance by step/onServerShip, NOT here — simulateShip also runs on
   * the correction-blend target, which must not double-advance them); their
   * clones are refreshed from every snapshot via setOtherShips(), keeping
   * accumulated drift below one snapshot interval.
   */
  private applyCollisionImpulses(ship: Ship, dt: number): void {
    const colliders = [ship, ...this.otherShips];
    if (colliders.length > 1) predictShipCollisions(colliders, dt);
    if (this.docks.length > 0) predictDockCollisions(colliders, this.docks, dt);
    if (this.islands.length > 0) predictIslandCollisions(colliders, this.islands);
  }

  /** Dead-reckon other-ship clones so the contact solver sees them roughly
   *  where the server does. Must be called exactly once per time advance. */
  private advanceOtherShips(dt: number): void {
    for (const other of this.otherShips) {
      other.position  = other.position.add(other.velocity.mul(dt));
      other.rotation += other.angularVelocity * dt;
    }
  }

  /**
   * Port of island_shallow_water_depth (island.h) for polygon islands with an
   * explicit shallow polygon: 0 outside the shallow ring / inside the island,
   * 1.0 right at the sand boundary, linear gradient between. Islands without
   * explicit shallow vertices have no shallow zone (matches server).
   */
  private shallowWaterDepth(px: number, py: number): number {
    let maxDepth = 0;
    for (const isl of this.islands) {
      const sand = isl.vertices;
      const shallow = isl.shallowVertices;
      if (!sand || sand.length < 3 || !shallow || shallow.length < 3) continue;

      // Broad phase: bounding radius of the shallow polygon around island centre.
      const dx = px - isl.x, dy = py - isl.y;
      const distSq = dx * dx + dy * dy;
      let shallowBoundR = 0;
      let polyBoundR = 0;
      for (const v of shallow) {
        const r = Math.hypot(v.x - isl.x, v.y - isl.y);
        if (r > shallowBoundR) shallowBoundR = r;
      }
      for (const v of sand) {
        const r = Math.hypot(v.x - isl.x, v.y - isl.y);
        if (r > polyBoundR) polyBoundR = r;
      }
      if (distSq > shallowBoundR * shallowBoundR) continue;
      if (this.pointInPoly(px, py, sand)) continue;        // inside the island
      if (!this.pointInPoly(px, py, shallow)) continue;    // outside the shallow ring

      // Gradient: 1.0 at sand edge, 0.0 at shallow boundary (server formula).
      const edgeDist = this.polyEdgeDist(px, py, sand);
      const shallowDepth = shallowBoundR - polyBoundR;
      if (shallowDepth <= 0 || edgeDist >= shallowDepth) continue;
      const t = 1.0 - edgeDist / shallowDepth;
      const d = t > 1 ? 1 : t;
      if (d > maxDepth) maxDepth = d;
    }
    return maxDepth;
  }

  private pointInPoly(px: number, py: number, poly: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      if ((a.y > py) !== (b.y > py)) {
        const xi = a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y);
        if (px < xi) inside = !inside;
      }
    }
    return inside;
  }

  private polyEdgeDist(px: number, py: number, poly: { x: number; y: number }[]): number {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      const ex = b.x - a.x, ey = b.y - a.y;
      const len2 = ex * ex + ey * ey;
      if (len2 < 1e-6) continue;
      let t = ((px - a.x) * ex + (py - a.y) * ey) / len2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const cx = a.x + t * ex, cy = a.y + t * ey;
      const d = Math.hypot(px - cx, py - cy);
      if (d < best) best = d;
    }
    return best === Infinity ? 0 : best;
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
