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
const SIM_TICK = 1 / SERVER_TICK_RATE; // fixed physics step — MUST match server cadence

// Server slews each manned mast's angle toward desired_sail_angle at this rate
// (websocket_server.c MAX_UNMANNED_SAIL_TURN_RATE, same as rigger NPCs).
const SAIL_TURN_RATE = 1.2; // rad/s

// POSITION correction thresholds. Position snaps the PHYSICS state instantly and
// folds the visual jump into a decaying render offset (see getRenderErrorOffset).
// (ROTATION uses no thresholds — its rendered heading is a damped follow of the
// physics heading, see getRenderRotation — so it has no snap/blend constant.)
const CORRECTION_SNAP_POS  = 50;   // px  — above this: hard pop, position offset cleared
const CORRECTION_BLEND_POS = 5;    // px  — below this on BOTH channels: leave physics untouched
const CORRECTION_BLEND_ROT = 0.01; // rad — below this on BOTH channels: leave physics untouched

// Decaying-offset ease time constant for POSITION corrections.
const ERR_DECAY_TAU_POS = 0.08; // s — position ease (~250 ms to settle)

// Render-heading damped-follow time constant. The rendered rotation eases toward
// the predicted physics rotation with this τ every frame (never snaps). Smaller =
// tighter/more responsive, larger = smoother/laggier. 0.10 s lags a full-speed
// turn (~0.34 rad/s) by ~0.034 rad (~2°) — imperceptible — while killing all snaps.
const RENDER_ROT_FOLLOW_TAU = 0.10; // s

// Above this instantaneous heading gap the follow snaps instead of easing, so a
// genuine teleport / carrier swap doesn't spin the ship for a second. Normal-play
// corrections are <0.1 rad, far below this, so they always ease.
const RENDER_ROT_SNAP = Math.PI / 2; // rad (90°)

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
  // Snapshot of predictedShip taken at the START of each step(), before physics advance.
  // Used by renderFrame to sub-tick lerp prev→current with the accumulator alpha, identical
  // to how the player prediction uses prevPredictedWorldState. Without this, the ship renders
  // at discrete 120 Hz positions and appears choppy at any display rate below 120 fps.
  private prevPredictedShip: Ship | null = null;

  // Decaying render-time POSITION error offset (same technique as the player
  // prediction's localRenderErrorOffset). When a correction arrives, the PHYSICS
  // state snaps to the corrected pose immediately (so the simulation never
  // accumulates error and velocity is exact from the next tick), while the VISUAL
  // discrepancy is folded into this offset and eased out exponentially every frame.
  private renderErrOffsetPos = Vec2.zero();

  // Smoothed render HEADING. Rotation is NOT corrected via a snap+offset like
  // position — that always popped on big corrections (the offset got cleared) and
  // the front-loaded exponential decay still read as a "snap". Instead the rendered
  // heading is a critically-damped follow of the predicted physics heading: every
  // render frame it eases toward the (sub-tick-interpolated) physics rotation, so it
  // is mathematically incapable of a discontinuity. Ships yaw slowly (~0.34 rad/s at
  // most), so the follow lag is only ~2° — invisible — while position stays fully
  // predicted. null until the first frame seeds it from the physics heading.
  private smoothRenderRot: number | null = null;

  // Island definitions for shallow-water drag (fed by ClientApplication)
  private islands: readonly ShallowDragIsland[] = [];
  // Pre-computed bounding radii for each island's sand and shallow polygons.
  // Recomputed only when setIslands() is called (once, on ISLANDS message), not
  // every physics tick — shallowWaterDepth() was iterating all vertices per call.
  private _islandBounds: Array<{ shallowR: number; sandR: number }> = [];

  // Other ships (cloned snapshot state, dead-reckoned between snapshots) and
  // shipyard docks — collision impulse partners for the predicted ship.
  private otherShips: Ship[] = [];
  private docks: readonly DockStructure[] = [];

  // Fixed-step accumulator. The physics MUST advance in whole 1/30 s ticks:
  // the server's "blend velocity toward target, then multiply by drag" pair does
  // not commute across step sizes, so integrating at 120 Hz (even with
  // rate-corrected exponents) settles at a measurably different equilibrium
  // speed than the server. That few-percent cruise-speed gap re-triggers the
  // correction blend on nearly every snapshot while sails are open — the
  // visible choppiness. Stepping at exactly dt = 1/30 makes simulateShip
  // bit-for-bit equivalent to the server formulas.
  private tickAccumulator = 0;

  // Predicted per-mast sail angles (radians), keyed by module id. Server slews
  // each manned mast toward desired_sail_angle at SAIL_TURN_RATE; the snapshot
  // angle is RTT-stale while rotating. Re-seeded from every snapshot, slewed
  // locally toward the helmsman's last sail-angle control input.
  private predictedMastAngles = new Map<number, number>();
  private desiredSailAngleRad: number | null = null;

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

    // Re-seed predicted mast angles from the fresh snapshot. The slew below
    // (and in step) then extrapolates them toward the helmsman's desired angle,
    // covering the snapshot-age staleness while sails rotate.
    this.predictedMastAngles.clear();
    for (const mod of ship.modules) {
      if (mod.kind === 'mast' && mod.moduleData) {
        const md = mod.moduleData as { angle?: number };
        this.predictedMastAngles.set(mod.id, md.angle ?? 0);
      }
    }

    // Forward-project the authoritative state to "now" using the same physics
    // step the prediction runs, in ≤ one-server-tick substeps. The other-ship
    // clones (fed via setOtherShips just before this call) are equally stale,
    // so dead-reckon them forward by the same age in lockstep.
    const projected = this.cloneShip(ship);
    let remaining = Math.max(0, Math.min(0.5, snapshotAgeMs / 1000));
    const maxSub = SIM_TICK;
    while (remaining > 1e-4) {
      const sub = Math.min(maxSub, remaining);
      this.advanceOtherShips(sub);
      this.advanceSailAngles(sub);
      this.simulateShip(projected, sub);
      remaining -= sub;
    }

    // dPos / dRot = projected − predicted (how far the corrected pose is AHEAD of the
    // current prediction). angleDiff(a, b) = b − a, so pass (predicted, projected).
    const dPos    = projected.position.sub(this.predictedShip.position);
    const dRot    = this.angleDiff(this.predictedShip.rotation, projected.rotation);
    const posDiff = dPos.length();
    const rotDiff = Math.abs(dRot);

    // Below threshold on BOTH channels → prediction is accurate enough, leave it.
    if (posDiff <= CORRECTION_BLEND_POS && rotDiff <= CORRECTION_BLEND_ROT) {
      return;
    }

    // Adopt the forward-projected server pose as the new PHYSICS state (so the next
    // tick advances on the server's trajectory). POSITION folds its visual jump into
    // a decaying offset so the on-screen position stays continuous; ROTATION does NOT
    // use an offset at all — the rendered heading is a damped follow of this physics
    // heading (see getRenderRotation / smoothRenderRot), which can never pop. Snapping
    // the physics rotation here is therefore invisible: the follow just eases toward
    // the new heading. This split is why rotation no longer "snaps due to correction".

    // Keep the prev→current sub-tick lerp segment on the new trajectory; otherwise
    // the lerp would mix the old and new trajectories for one tick (a one-frame wobble).
    if (this.prevPredictedShip) {
      this.prevPredictedShip.position        = this.prevPredictedShip.position.add(dPos);
      this.prevPredictedShip.rotation       += dRot;
      this.prevPredictedShip.velocity        = Vec2.from(projected.velocity.x, projected.velocity.y);
      this.prevPredictedShip.angularVelocity = projected.angularVelocity;
    }

    // ── Position channel — snap physics, ease the render offset ───────────
    if (posDiff > CORRECTION_SNAP_POS) {
      // Teleport / heavy desync — hard pop (intended), clear the offset.
      this.renderErrOffsetPos = Vec2.zero();
    } else if (posDiff > CORRECTION_BLEND_POS) {
      // Ease: cancel the physics jump, then clamp runaway same-sign accumulation.
      let offPos = this.renderErrOffsetPos.sub(dPos);
      if (offPos.length() > CORRECTION_SNAP_POS) offPos = Vec2.zero();
      this.renderErrOffsetPos = offPos;
    }

    this.predictedShip = projected;
  }

  /**
   * Decaying visual POSITION error offset, advanced by `dtSeconds` (call once per
   * render frame). The renderer ADDS this to the lerped predicted position so
   * position corrections ease in smoothly instead of stepping per physics tick.
   * (Rotation is handled separately by getRenderRotation — see that method.)
   */
  getRenderErrorOffset(dtSeconds: number): { pos: Vec2; rot: number } {
    const result = { pos: this.renderErrOffsetPos.clone(), rot: 0 };
    if (dtSeconds > 0) {
      const decayPos = Math.exp(-dtSeconds / ERR_DECAY_TAU_POS);
      this.renderErrOffsetPos = this.renderErrOffsetPos.mul(decayPos);
      // Kill sub-pixel remnants so the offset reaches exactly zero.
      if (this.renderErrOffsetPos.lengthSq() < 0.01) this.renderErrOffsetPos = Vec2.zero();
    }
    return result;
  }

  /**
   * Rendered ship heading: a critically-damped follow of the predicted physics
   * heading. Call once per render frame. Unlike position, rotation is NOT corrected
   * via snap+decaying-offset (that popped whenever the offset was cleared and the
   * front-loaded decay still read as a "snap"). Instead the rendered heading always
   * eases toward the sub-tick-interpolated physics heading, so it is mathematically
   * incapable of a discontinuity. Ships yaw slowly, so the follow lag (~2° at full
   * turn rate) is invisible while position remains fully predicted.
   *
   * @param extraDtSeconds Render-frame time elapsed beyond the last step() (the
   *   engine's sub-client-tick remainder), used for the prev→current physics lerp.
   * @param frameDtSeconds This render frame's delta time, drives the ease rate.
   */
  getRenderRotation(extraDtSeconds: number, frameDtSeconds: number): number {
    if (!this.predictedShip) return this.smoothRenderRot ?? 0;

    // Sub-tick-interpolated physics heading = the target the render eases toward.
    // angleDiff(a, b) = shortest (b − a), so angleDiff(prev, predicted) = predicted − prev.
    const alpha = this.getSubTickAlpha(extraDtSeconds);
    const prev  = this.prevPredictedShip ?? this.predictedShip;
    let target  = prev.rotation + this.angleDiff(prev.rotation, this.predictedShip.rotation) * alpha;
    target = this.wrapAngle(target);

    // First frame (or after a reset): seed directly, no ease.
    if (this.smoothRenderRot === null) {
      this.smoothRenderRot = target;
      return target;
    }

    // delta = shortest arc FROM smoothRenderRot TO target = angleDiff(smooth, target).
    // (Swapping the args inverts the sign and makes the follow diverge — the heading
    // runs away from the target and wraps around forever, i.e. the ship spins.)
    const delta = this.angleDiff(this.smoothRenderRot, target);
    if (Math.abs(delta) > RENDER_ROT_SNAP) {
      // Genuine teleport / carrier swap — snap rather than spin for a second.
      this.smoothRenderRot = target;
    } else if (frameDtSeconds > 0) {
      const k = 1 - Math.exp(-frameDtSeconds / RENDER_ROT_FOLLOW_TAU);
      this.smoothRenderRot = this.wrapAngle(this.smoothRenderRot + delta * k);
    }
    return this.smoothRenderRot;
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
   * Called when SHIP_SAIL_ANGLE_CONTROL is sent to the server (degrees, −60…+60).
   * The server slews each manned mast toward this at SAIL_TURN_RATE; mirroring the
   * slew locally keeps the predicted sail-to-wind alignment (and thus thrust) in
   * sync while the sails rotate, instead of lagging by the snapshot age.
   */
  onSailAngleControl(desiredAngleDeg: number): void {
    this.desiredSailAngleRad = desiredAngleDeg * Math.PI / 180;
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
    // Pre-compute per-island bounding radii so shallowWaterDepth() doesn't
    // iterate all vertices on every physics tick (120 Hz × island count).
    this._islandBounds = islands.map(isl => {
      let shallowR = 0;
      let sandR    = 0;
      if (isl.shallowVertices) {
        for (const v of isl.shallowVertices) {
          const r = Math.hypot(v.x - isl.x, v.y - isl.y);
          if (r > shallowR) shallowR = r;
        }
      }
      if (isl.vertices) {
        for (const v of isl.vertices) {
          const r = Math.hypot(v.x - isl.x, v.y - isl.y);
          if (r > sandR) sandR = r;
        }
      }
      return { shallowR, sandR };
    });
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

    // Fixed-step accumulator: physics ONLY advances in whole server ticks (1/30 s)
    // so the blend+drag composition is identical to the server's (see field docs).
    // The leftover fraction drives the renderer's sub-tick lerp via getSubTickAlpha.
    this.tickAccumulator += dt;
    // Cap after tab-out / long stalls — don't grind through seconds of catch-up.
    if (this.tickAccumulator > 0.25) this.tickAccumulator = 0.25;

    while (this.tickAccumulator >= SIM_TICK) {
      this.tickAccumulator -= SIM_TICK;
      // Snapshot before advancing so renderFrame can lerp prev→current.
      this.prevPredictedShip = this.cloneShip(this.predictedShip);
      this.advanceTick(SIM_TICK);
    }
  }

  /** One whole physics tick (dt = SIM_TICK), exactly mirroring a server tick. */
  private advanceTick(dt: number): void {
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
    // Dead-reckon the other-ship clones exactly once per tick, then simulate.
    // Corrections are NOT blended here: onServerShip snaps the physics state and
    // folds the visual delta into the decaying render error offset instead.
    this.advanceOtherShips(dt);
    this.advanceSailAngles(dt);
    this.simulateShip(this.predictedShip, dt);
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

        // Prefer the locally-slewed mast angle (mirrors the server's 1.2 rad/s
        // slew toward the helm's desired angle) over the RTT-stale snapshot value.
        const mastAngle = this.predictedMastAngles.get(mod.id) ?? md.angle ?? 0;
        const sailWorld = mastAngle + ship.rotation + Math.PI / 2;
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
   * Slew predicted mast angles toward the helm's desired sail angle, mirroring
   * the server (websocket_server.c: MAX_UNMANNED_SAIL_TURN_RATE = 1.2 rad/s).
   * Must be called exactly once per time advance (like advanceOtherShips) —
   * NOT from simulateShip, which also runs on the correction-blend target.
   * No-op until the helmsman has sent a sail-angle control; the map is then
   * re-seeded from every snapshot, so a wrong guess (e.g. no rigger manning
   * the mast, where the server freezes the sail) only persists for one
   * snapshot interval.
   */
  private advanceSailAngles(dt: number): void {
    if (this.desiredSailAngleRad === null) return;
    const maxStep = SAIL_TURN_RATE * dt;
    for (const [id, cur] of this.predictedMastAngles) {
      let diff = this.desiredSailAngleRad - cur;
      while (diff >  Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const step = Math.max(-maxStep, Math.min(maxStep, diff));
      this.predictedMastAngles.set(id, cur + step);
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
    for (let i = 0; i < this.islands.length; i++) {
      const isl     = this.islands[i];
      const bounds  = this._islandBounds[i];
      const sand    = isl.vertices;
      const shallow = isl.shallowVertices;
      if (!sand || sand.length < 3 || !shallow || shallow.length < 3) continue;

      // Broad phase: use pre-cached bounding radii (computed once in setIslands).
      const dx = px - isl.x, dy = py - isl.y;
      const distSq = dx * dx + dy * dy;
      const shallowBoundR = bounds.shallowR;
      const polyBoundR    = bounds.sandR;
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

  /**
   * Returns the predicted ship state from one physics tick (1/30 s) ago.
   * Pair with getPredictedShip() and lerp by getSubTickAlpha() to render the
   * ship smoothly between the fixed 30 Hz physics ticks.
   */
  getPrevPredictedShip(): Ship | null {
    return this.prevPredictedShip ?? this.predictedShip;
  }

  /**
   * Fraction (0–1) of the current physics tick already elapsed. Use as the lerp
   * factor between getPrevPredictedShip() and getPredictedShip() when rendering.
   * The predictor's physics deliberately advances in whole 1/30 s server ticks
   * (see tickAccumulator docs), so the renderer must use THIS alpha — not the
   * client's 120 Hz fixed-step alpha — to bridge the 33 ms position steps.
   *
   * @param extraDtSeconds Render-frame time already elapsed beyond the last
   *   step() call (the engine's sub-client-tick remainder), so the lerp stays
   *   smooth past the 120 Hz step quantization.
   */
  getSubTickAlpha(extraDtSeconds = 0): number {
    return Math.min(1, (this.tickAccumulator + extraDtSeconds) / SIM_TICK);
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
}
