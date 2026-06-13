/**
 * Client-Side Prediction Engine with Rewind Buffer
 * 
 * Enhanced prediction system for Week 3-4 with lag compensation:
 * - 16-frame ring buffer for ≥350ms coverage
 * - Client-side prediction with server reconciliation
 * - Input validation and anomaly detection
 * - Rollback and replay for smooth gameplay
 */

import { PredictionConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';
import { simulate } from '../sim/Physics.js';
import { createCarrierDetectionState, DETECTION_CONFIG, ShipDetectionState, CarrierDetectionState } from '../sim/CarrierDetection.js';
import { CollisionContext } from '../sim/IslandCollisions.js';

/**
 * Prediction state entry with enhanced tracking
 */
interface PredictionState {
  tick: number;
  worldState: WorldState;
  inputFrame: InputFrame;
  timestamp: number;
  serverConfirmed: boolean;        // Server has confirmed this state
  predictionError: number;         // Magnitude of prediction error
  correctionApplied: boolean;      // Correction was applied to this state
}

/**
 * Rewind buffer entry for lag compensation
 */
interface RewindBufferEntry {
  tick: number;
  worldState: WorldState;
  inputFrame: InputFrame;
  timestamp: number;
  networkDelay: number;           // Estimated network delay when created
}

/**
 * Input validation metrics
 */
interface InputValidationMetrics {
  totalInputs: number;
  invalidInputs: number;
  inputRateViolations: number;
  duplicateInputs: number;
  timestampAnomalies: number;
  lastInputTimestamp: number;
}

/**
 * Prediction performance metrics
 */
interface PredictionMetrics {
  rollbacksPerformed: number;
  averagePredictionError: number;
  maxPredictionError: number;
  correctionsApplied: number;
  serverMispredictions: number;
}

/**
 * Server state buffer entry for interpolation
 */
interface ServerStateEntry {
  worldState: WorldState;
  tick: number;
  timestamp: number;
  receiveTime: number; // Client time when received
}

/**
 * Enhanced Client-side prediction engine with Week 3-4 features
 */
export class PredictionEngine {
  private config: PredictionConfig;

  /** ID of the local player — set by ClientApplication after assignment. */
  public localPlayerId: number | null = null;

  /** Static world geometry used for client-side collision prediction.
   *  Updated from ClientApplication when structures/islands are loaded or change.
   *  Held by reference — NOT cloned per prediction tick. */
  private collisionCtx: CollisionContext | null = null;

  public setCollisionContext(ctx: CollisionContext): void {
    this.collisionCtx = ctx;
  }
  
  // Enhanced prediction state history (16-frame buffer)
  private predictionHistory: PredictionState[] = [];
  private rewindBuffer: RewindBufferEntry[] = [];
  private authoritativeState: WorldState | null = null;
  private lastAuthoritativeTick = 0;
  
  // Server state buffer for interpolation
  private serverStateBuffer: ServerStateEntry[] = [];
  private static readonly MAX_SERVER_STATES = 10;
  
  // Timing and lag compensation
  private clientTick = 0;
  private clientTickAtLastServerState = 0;
  private estimatedNetworkDelay = 0;
  private serverTickOffset = 0;
  // RTT expressed in server ticks. The local input made "now" will be applied by the server
  // roughly this many ticks ahead of the last snapshot we received, so we label predictions
  // with this lead. That makes server reconciliation compare the same logical tick (the one
  // the server actually applied our input on) instead of a tick that's ~RTT stale.
  private rttTicks = 0;
  // Cap the lead so it can never outrun the prediction-history window (else the matching
  // prediction would be evicted before its server snapshot returns). ~333ms RTT at 30 Hz.
  private static readonly MAX_RTT_TICKS = 10;
  
  // Forced server correction: there is NO movement-prediction reconciliation (the client has
  // semi-authority — the server adopts our position). The only correction is for deliberate
  // server moves the client can't know about (teleport, respawn, forced dismount): when the
  // server places us further than this many units from the running prediction, adopt it.
  private static readonly FORCED_CORRECTION_THRESHOLD = 60.0;
  
  // Input validation
  private inputValidation: InputValidationMetrics = {
    totalInputs: 0,
    invalidInputs: 0,
    inputRateViolations: 0,
    duplicateInputs: 0,
    timestampAnomalies: 0,
    lastInputTimestamp: 0
  };
  
  // Performance metrics
  private predictionMetrics: PredictionMetrics = {
    rollbacksPerformed: 0,
    averagePredictionError: 0,
    maxPredictionError: 0,
    correctionsApplied: 0,
    serverMispredictions: 0
  };
  
  // Carrier detection state persisted across prediction frames.
  // Each frame starts from the raw server state (empty carrierDetection), so without this
  // the detection confirmationTicks would always be 0 and onDeck would flicker every frame.
  private persistentCarrierDetection: Map<number, CarrierDetectionState> = new Map();

  // Running, accumulated predicted world. The local player's position persists across ticks
  // and is advanced one sim step per client tick (120 Hz). Remote entities are refreshed from
  // the latest server snapshot each tick. This is what makes prediction feel 120 Hz instead of
  // snapping to the 30 Hz server cadence.
  private runningPredicted: WorldState | null = null;
  // Snap if a server correction is larger than this (units) — e.g. teleport / respawn.
  private static readonly RECONCILE_SNAP_DIST = 80.0;

  // ── Smooth error correction (projective smoothing) ──────────────────────────
  // When the server corrects the predicted local player, we snap the SIMULATION to the
  // authoritative truth (keeping prediction accurate) but carry the visual discrepancy as a
  // decaying offset so the on-screen sprite eases into place instead of popping. This removes
  // the 30 Hz judder that discrete per-correction blends would otherwise create.
  private localRenderErrorOffset: Vec2 = Vec2.zero();
  // Errors above this are treated as hard snaps (teleport/respawn) — no visual smoothing.
  private static readonly SMOOTH_ERROR_MAX = 60.0;
  // Clamp the accumulated visual offset so repeated same-direction errors can't rubber-band.
  private static readonly SMOOTH_OFFSET_CLAMP = 40.0;
  // Exponential decay time-constant (seconds) for the visual offset → ~smooth over ~100 ms.
  private static readonly SMOOTH_TAU = 0.09;

  // Ring buffer constants (16 frames = ~350ms at 60Hz)
  private static readonly REWIND_BUFFER_SIZE = 16;
  // Sized to hold the rollback window (rollbackLimit) plus the RTT lead (MAX_RTT_TICKS) plus a
  // little margin, in client ticks (×4 at 120/30 Hz): (48 + 10 + 4) × 4 = 248 → round to 256.
  // Ensures the prediction labelled with a server tick survives until that tick's snapshot
  // returns ~RTT later. If a match is ever missed at extreme ping, reconciliation just skips
  // that frame (findPredictionState → null) — safe degradation, no snap.
  private static readonly MAX_PREDICTION_HISTORY = 256;
  
  constructor(config: PredictionConfig) {
    this.config = config;
    this.initializeBuffers();
  }
  
  /**
   * Update network latency estimate for dynamic interpolation buffer
   */
  updateNetworkLatency(pingMs: number): void {
    // One-way latency is half of round-trip time (ping)
    const oneWayLatency = pingMs / 2;
    
    // Smooth the estimate with exponential moving average
    const alpha = 0.1; // Smoothing factor
    this.estimatedNetworkDelay = this.estimatedNetworkDelay * (1 - alpha) + oneWayLatency * alpha;
    
    // Calculate dynamic interpolation buffer
    // Buffer = one-way latency + server tick time + jitter margin
    const serverTickTime = 1000 / this.config.serverTickRate;
    const jitterMargin = 30; // 30ms safety margin for network jitter
    const dynamicBuffer = this.estimatedNetworkDelay + serverTickTime + jitterMargin;
    
    // Update config with dynamic buffer (but cap at reasonable limits)
    const minBuffer = 50; // Minimum 50ms
    const maxBuffer = 300; // Maximum 300ms
    this.config.interpolationBuffer = Math.max(minBuffer, Math.min(maxBuffer, dynamicBuffer));

    // Prediction lead, in server ticks, = full RTT / server tick time. Smoothed implicitly via
    // estimatedNetworkDelay (one-way) ×2. Clamped so it never exceeds the history window.
    const fullRttMs = this.estimatedNetworkDelay * 2;
    this.rttTicks = Math.min(
      PredictionEngine.MAX_RTT_TICKS,
      Math.max(0, Math.round(fullRttMs / serverTickTime))
    );
    
    // Log occasionally for debugging
    if (Math.random() < 0.01) {
      console.log(`📡 Network: ping=${pingMs.toFixed(0)}ms, buffer=${this.config.interpolationBuffer.toFixed(0)}ms, lead=${this.rttTicks} ticks`);
    }
  }
  
  /**
   * Initialize ring buffers for prediction and rewind
   */
  private initializeBuffers(): void {
    this.rewindBuffer = [];
    this.predictionHistory = [];
  }
  
  /**
   * Enhanced update with input validation and rewind buffer management
   */
  update(baseWorldState: WorldState, inputFrame: InputFrame, deltaTime: number): WorldState {
    this.clientTick++;
    
    // Calculate server tick: last server tick + number of client ticks / ratio
    // Server runs at 30Hz, client at 120Hz, so every 4 client ticks = 1 server tick
    const clientToServerRatio = this.config.clientTickRate / this.config.serverTickRate; // 120/30 = 4
    
    // If this is the first update after receiving server state, reset client tick base
    if (!this.clientTickAtLastServerState) {
      this.clientTickAtLastServerState = this.clientTick;
    }
    
    const clientTicksSinceLastServer = this.clientTick - this.clientTickAtLastServerState;
    const serverTickOffset = Math.floor(clientTicksSinceLastServer / clientToServerRatio);
    // Add the RTT lead so the input we make now is labelled with the tick the server will
    // actually apply it on (last snapshot + full RTT). Reconciliation then compares matching
    // logical ticks instead of a ~RTT-stale tick, which avoids false corrections on high ping.
    const estimatedServerTick = this.lastAuthoritativeTick + this.rttTicks + serverTickOffset;
    
    // Override input frame tick with estimated server tick
    inputFrame.tick = estimatedServerTick;
    
    // Ensure movement is a proper Vec2 object
    if (inputFrame.movement && typeof inputFrame.movement === 'object' && !('mul' in inputFrame.movement)) {
      // Convert plain object to Vec2
      const plainObj = inputFrame.movement as any;
      inputFrame.movement = Vec2.from(plainObj.x || 0, plainObj.y || 0);
    }
    
    // Validate input frame
    if (!this.validateInputFrame(inputFrame)) {
      console.warn('🚨 Input validation failed, using previous input');
      // Use last valid input or neutral input
      const lastState = this.predictionHistory[this.predictionHistory.length - 1];
      inputFrame = lastState?.inputFrame || { tick: this.clientTick, movement: Vec2.zero(), actions: 0 };
    }
    
    // Store in rewind buffer for lag compensation
    this.updateRewindBuffer(this.clientTick, baseWorldState, inputFrame, deltaTime);
    
    if (!this.config.enablePrediction) {
      // Prediction disabled - just return authoritative state
      return baseWorldState;
    }

    // Build the state we simulate from this tick.
    //
    // CRITICAL: we do NOT re-simulate one step from the frozen server snapshot every tick —
    // that would make the local player move only when a new 30 Hz snapshot arrives (the
    // "feels like 30 Hz" bug). Instead we keep an accumulated running prediction and advance
    // the LOCAL player from its own previous predicted position each 120 Hz tick. Remote
    // entities (ships, other players, NPCs, islands) are refreshed from the latest server
    // snapshot so collision and carrier data stay current.
    const stateForSim = this.buildSimBase(baseWorldState);

    const predictedState = this.simulateStep(stateForSim, inputFrame, deltaTime);

    // Carry forward carrier detection + running prediction into the next frame
    this.persistentCarrierDetection = new Map(predictedState.carrierDetection);
    this.runningPredicted = predictedState;
    
    // Store prediction state using the estimated server tick
    this.storePredictionState(inputFrame.tick, predictedState, inputFrame);
    
    return predictedState;
  }

  /**
   * Construct the world state to simulate from for this tick.
   *
   * Remote entities come from the freshest server snapshot (`baseWorldState`); the local
   * player is carried over from the accumulated running prediction so its position advances
   * smoothly at the client tick rate rather than snapping to the 30 Hz server cadence.
   */
  private buildSimBase(baseWorldState: WorldState): WorldState {
    const carrierDetection = this.persistentCarrierDetection.size > 0
      ? new Map(this.persistentCarrierDetection)
      : new Map(baseWorldState.carrierDetection);

    // No accumulated state yet, or we don't know the local player — just use the server snapshot.
    const localId = this.localPlayerId;
    if (!this.runningPredicted || localId === null) {
      return { ...baseWorldState, carrierDetection };
    }

    const runningLocal = this.runningPredicted.players.find(p => p.id === localId);
    if (!runningLocal) {
      return { ...baseWorldState, carrierDetection };
    }

    // Splice the accumulated local player into the fresh server world: keep the predicted
    // position/velocity, but adopt the server's authoritative movement-state flags so the
    // correct physics branch (land / deck / swim) is selected immediately on a transition.
    const serverLocal = baseWorldState.players.find(p => p.id === localId);
    const mergedLocal = serverLocal
      ? {
          ...serverLocal,               // ALL server flags (authoritative)
          position: runningLocal.position,
          velocity: runningLocal.velocity,
          // localPosition (ship-local anchor) ownership depends on mount state:
          //   • Mounted: the SERVER anchor wins — local_x/local_y is the module mount point
          //     (e.g. steering wheel). Using the predicted value would keep the player locked
          //     to their pre-mount deck position and never snap them onto the module.
          //   • Walking on deck: the PREDICTED anchor wins — it advances at client rate with
          //     input. Resetting it to the server's RTT-old anchor every tick would yank the
          //     player backwards each simulation step (rubberbanding while walking on deck).
          localPosition: serverLocal.isMounted
            ? serverLocal.localPosition
            : (runningLocal.localPosition ?? serverLocal.localPosition),
          // deckId: CLIENT semi-authority — the RenderSystem state machine transitions this
          // immediately when the player enters/exits a ramp zone, then sends player_set_deck
          // to the server. Until the server echoes back the new deck_level (one RTT later),
          // the snapshot still carries the old deck. Overwriting with the stale server value
          // every merge would apply the WRONG per-deck collision filter for the full RTT,
          // letting players walk through ramp walls or fall through upper-deck floors.
          // We keep the client's locally-transitioned value; forced corrections (teleport /
          // respawn) set it directly in onAuthoritativeState's position-correction block.
          deckId: runningLocal.deckId,
        }
      : { ...runningLocal };

    const players = baseWorldState.players.map(p => (p.id === localId ? mergedLocal : p));
    if (!players.some(p => p.id === localId)) {
      players.push(mergedLocal);
    }

    return { ...baseWorldState, players, carrierDetection };
  }
  
  /**
   * Handle new authoritative state from server
   */
  onAuthoritativeState(serverState: WorldState): void {
    // Build seeded carrier detection from server-reported player states.
    // For on-ship players, start with confirmationTicks well above threshold so rollback
    // re-simulations (and the next update() call) immediately treat the player as on-deck.
    // For off-ship players, use a fresh empty state to clear any stale on-ship detection.
    const seededDetection = new Map<number, CarrierDetectionState>();
    for (const player of serverState.players) {
      if (player.carrierId > 0) {
        const det = createCarrierDetectionState();
        det.currentCarrierId = player.carrierId;
        det.candidateStates.set(player.carrierId, {
          shipId: player.carrierId,
          penetrationDepth: 50.0,
          relativeVelocity: 0,
          confirmationTicks: DETECTION_CONFIG.CONFIRM_IN_TICKS + 10,
          lastDetected: serverState.timestamp,
        } satisfies ShipDetectionState);
        seededDetection.set(player.id, det);
      } else {
        seededDetection.set(player.id, createCarrierDetectionState());
      }
    }
    this.authoritativeState = { ...serverState, carrierDetection: seededDetection };
    // Also sync the persistent detection used by update() each frame
    this.persistentCarrierDetection = new Map(seededDetection);
    this.lastAuthoritativeTick = serverState.tick;
    
    // Reset client tick offset when we get a new server state
    this.clientTickAtLastServerState = this.clientTick;
    
    // Add to server state buffer for interpolation
    this.addServerState(serverState);
    
    // ── Forced-correction check (NO movement prediction reconciliation) ──────────
    //
    // The client has semi-authority over its own movement: it simulates locally and the
    // server adopts the reported position (speed-clamped). Comparing prediction history
    // against RTT-old snapshots and rolling back was fighting that authority model — every
    // rollback WAS the rubberband, and abrupt direction changes made it useless.
    //
    // The only correction that remains is for DELIBERATE server moves the client cannot
    // know about (teleport, respawn, forced dismount, admin moves): if the server places
    // us far from where we think we are, adopt the server position outright.
    if (this.runningPredicted && this.localPlayerId !== null) {
      const serverPlayer = serverState.players.find(p => p.id === this.localPlayerId);
      const runningLocal = this.runningPredicted.players.find(p => p.id === this.localPlayerId);

      if (serverPlayer && runningLocal) {
        const posDiff = serverPlayer.position.sub(runningLocal.position).length();

        if (posDiff > PredictionEngine.FORCED_CORRECTION_THRESHOLD) {
          console.log(`📍 Forced server correction | Tick ${serverState.tick} | Pos diff: ${posDiff.toFixed(1)}u | adopting server position`);

          // Fold the visual discrepancy into the decaying render offset when it's small
          // enough to ease; true teleports (respawn etc.) pop instantly.
          const errorVec = runningLocal.position.sub(serverPlayer.position);
          if (posDiff > PredictionEngine.SMOOTH_ERROR_MAX) {
            this.localRenderErrorOffset = Vec2.zero();
          } else {
            let off = this.localRenderErrorOffset.add(errorVec);
            const offLen = off.length();
            if (offLen > PredictionEngine.SMOOTH_OFFSET_CLAMP) {
              off = off.mul(PredictionEngine.SMOOTH_OFFSET_CLAMP / offLen);
            }
            this.localRenderErrorOffset = off;
          }

          runningLocal.position      = serverPlayer.position.clone();
          runningLocal.velocity      = serverPlayer.velocity.clone();
          runningLocal.localPosition = serverPlayer.localPosition
            ? serverPlayer.localPosition.clone()
            : undefined;
          // Also adopt the server's deck level on a hard correction (teleport /
          // respawn / forced dismount may land the player on a different deck).
          runningLocal.deckId        = serverPlayer.deckId;
        }
      }
    }

    // Clean up old prediction states
    this.cleanupOldStates(serverState.tick);
  }

  /**
   * Immediately update the local player's deckId in the running predicted state.
   *
   * Called by ClientApplication whenever the RenderSystem deck-level state machine
   * transitions (fall through hole / climb ramp).  The state machine fires before
   * the next prediction tick, so the collision resolver uses the correct per-deck
   * filter without waiting for the server echo (one RTT later).
   */
  setLocalPlayerDeckLevel(deckLevel: number): void {
    if (!this.runningPredicted || this.localPlayerId === null) return;
    const local = this.runningPredicted.players.find(p => p.id === this.localPlayerId);
    if (local) local.deckId = deckLevel;
  }

  
  /**
   * Get interpolated state for rendering
   */
  getInterpolatedState(currentTime: number): WorldState | null {
    if (!this.config.enableInterpolation || this.serverStateBuffer.length === 0) {
      if (this.serverStateBuffer.length === 0) {
        console.warn('⚠️ No server states in buffer - waiting for data');
      }
      return this.authoritativeState;
    }
    
    // Use interpolation buffer delay to smooth out network jitter
    const renderTime = currentTime - this.config.interpolationBuffer;
    
    // Find two states to interpolate between
    let fromState: ServerStateEntry | null = null;
    let toState: ServerStateEntry | null = null;
    
    for (let i = 0; i < this.serverStateBuffer.length - 1; i++) {
      const current = this.serverStateBuffer[i];
      const next = this.serverStateBuffer[i + 1];
      
      if (current.receiveTime <= renderTime && next.receiveTime >= renderTime) {
        fromState = current;
        toState = next;
        break;
      }
    }
    
    // Handle cases where we can't find two states to interpolate between
    if (!fromState || !toState) {
      if (this.serverStateBuffer.length > 0) {
        const latestState = this.serverStateBuffer[this.serverStateBuffer.length - 1];
        const oldestState = this.serverStateBuffer[0];
        
        // If we're ahead of the latest state, just use the latest state (no extrapolation)
        if (renderTime >= latestState.receiveTime) {
          return latestState.worldState;
        }
        
        // If we're behind the buffer, use oldest state
        if (renderTime < oldestState.receiveTime) {
          if (Math.random() < 0.05) {
            console.warn(`⚠️ Render time ${renderTime.toFixed(1)} behind oldest state ${oldestState.receiveTime.toFixed(1)} - buffer underrun`);
          }
          return oldestState.worldState;
        }
      }
      return this.authoritativeState;
    }
    
    // Calculate interpolation factor
    const timeDelta = toState.receiveTime - fromState.receiveTime;
    if (timeDelta === 0) {
      return fromState.worldState;
    }
    
    const alpha = (renderTime - fromState.receiveTime) / timeDelta;
    
    // Debug: Log abnormal time deltas (server updates should be ~50ms at 20Hz)
    if ((timeDelta < 30 || timeDelta > 100) && Math.random() < 0.02) {
      console.warn(`⚠️ Unusual server update interval: ${timeDelta.toFixed(1)}ms (expected ~50ms at 20Hz)`);
    }
    
    // Be conservative with alpha - stay within known data
    const clampedAlpha = Math.max(0, Math.min(1.0, alpha));
    
    // Interpolate between the two states
    return this.interpolateStates(fromState.worldState, toState.worldState, clampedAlpha);
  }
  
  /**
   * Extrapolate state forward based on velocity (for smooth 60Hz rendering with 20Hz server)
   * Conservative extrapolation to avoid jitter from snap-backs
   */
  private extrapolateState(state: WorldState, deltaTime: number): WorldState {
    // Use conservative damping to reduce jitter from corrections
    const dampingFactor = 0.75; // Lower damping for maximum smoothness
    
    return {
      tick: state.tick,
      timestamp: state.timestamp + deltaTime * 1000,
      ships: state.ships.map(ship => ({
        ...ship,
        position: ship.position.add(ship.velocity.mul(deltaTime * dampingFactor)),
        rotation: ship.rotation + ship.angularVelocity * deltaTime * dampingFactor
      })),
      players: state.players.map(player => ({
        ...player,
        position: player.position.add(player.velocity.mul(deltaTime * dampingFactor))
      })),
      cannonballs: state.cannonballs.map(ball => ({
        ...ball,
        position: ball.position.add(ball.velocity.mul(deltaTime * dampingFactor))
      })),
      npcs: state.npcs,
      tombstones: state.tombstones,
      droppedItems: state.droppedItems ?? [],
      companies: state.companies ?? [],
      carrierDetection: new Map(state.carrierDetection)
    };
  }
  
  /**
   * Add server state to interpolation buffer
   */
  private addServerState(worldState: WorldState): void {
    const entry: ServerStateEntry = {
      worldState: this.cloneWorldState(worldState),
      tick: worldState.tick,
      timestamp: worldState.timestamp,
      receiveTime: performance.now()
    };
    
    this.serverStateBuffer.push(entry);
    
    // Keep buffer size limited
    if (this.serverStateBuffer.length > PredictionEngine.MAX_SERVER_STATES) {
      this.serverStateBuffer.shift();
    }
    
  }
  
  /**
   * Interpolate between two world states
   */
  private interpolateStates(from: WorldState, to: WorldState, alpha: number): WorldState {
    // Apply smoothing curve for more natural motion (ease-out)
    const smoothAlpha = this.smoothStep(alpha);
    
    return {
      tick: Math.round(from.tick + (to.tick - from.tick) * alpha),
      timestamp: from.timestamp + (to.timestamp - from.timestamp) * alpha,
      ships: this.interpolateShips(from.ships, to.ships, alpha), // LINEAR - handles varying server intervals better
      players: this.interpolatePlayers(from.players, to.players, alpha), // LINEAR - matches ship interpolation for mounted players
      cannonballs: this.interpolateCannonballs(from.cannonballs, to.cannonballs, smoothAlpha),
      npcs: this.interpolateNpcs(from.npcs, to.npcs, alpha), // LINEAR - matches player/ship interpolation
      tombstones: to.tombstones ?? [],
      droppedItems: to.droppedItems ?? [],
      companies: to.companies ?? [],
      carrierDetection: new Map(from.carrierDetection)
    };
  }
  
  /**
   * Smooth step function for natural interpolation (quintic ease-in-out for extra smoothness)
   */
  private smoothStep(t: number): number {
    // Strict clamp - no extrapolation to avoid jitter
    t = Math.max(0, Math.min(1.0, t));
    
    // Quintic ease-in-out: 6t⁵ - 15t⁴ + 10t³ (smoother than cubic)
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  
  /**
   * Interpolate ship positions and rotations
   */
  private interpolateShips(fromShips: any[], toShips: any[], alpha: number): any[] {
    const result = [];

    // Build O(1) lookup to avoid O(N²) .find() per ship
    const fromById = new Map<number, any>();
    for (const s of fromShips) fromById.set(s.id, s);

    if (fromShips.length !== toShips.length) {
      console.warn(`⚠️ Ship count mismatch! From: ${fromShips.length}, To: ${toShips.length}`);
    }

    for (const toShip of toShips) {
      const fromShip = fromById.get(toShip.id);

      if (!fromShip) {
        console.warn(`⚠️ Ship ${toShip.id} missing in from state - can't interpolate, using toShip directly`);
        result.push(toShip);
        continue;
      }

      result.push({
        ...toShip,
        position: this.lerpVec2(fromShip.position, toShip.position, alpha),
        velocity: this.lerpVec2(fromShip.velocity, toShip.velocity, alpha),
        rotation: this.lerpAngle(fromShip.rotation, toShip.rotation, alpha),
        angularVelocity: fromShip.angularVelocity + (toShip.angularVelocity - fromShip.angularVelocity) * alpha
      });
    }

    return result;
  }
  
  /**
   * Interpolate player positions
   */
  private interpolatePlayers(fromPlayers: any[], toPlayers: any[], alpha: number): any[] {
    const result = [];

    // Build O(1) lookup to avoid O(N²) .find() per player
    const fromById = new Map<number, any>();
    for (const p of fromPlayers) fromById.set(p.id, p);

    for (const toPlayer of toPlayers) {
      const fromPlayer = fromById.get(toPlayer.id);

      if (!fromPlayer) {
        result.push(toPlayer);
        continue;
      }

      result.push({
        ...toPlayer,
        position: this.lerpVec2(fromPlayer.position, toPlayer.position, alpha),
        velocity: this.lerpVec2(fromPlayer.velocity, toPlayer.velocity, alpha)
      });
    }

    return result;
  }
  
  /**
   * Interpolate NPC positions, rotations, and local (deck) positions.
   * NPCs on a ship also have localPosition interpolated so they glide smoothly
   * across the deck between server ticks.
   */
  private interpolateNpcs(fromNpcs: any[], toNpcs: any[], alpha: number): any[] {
    const result = [];

    const fromById = new Map<number, any>();
    for (const n of fromNpcs) fromById.set(n.id, n);

    for (const toNpc of toNpcs) {
      const fromNpc = fromById.get(toNpc.id);

      if (!fromNpc) {
        result.push(toNpc);
        continue;
      }

      const interpolated: any = {
        ...toNpc,
        position: this.lerpVec2(fromNpc.position, toNpc.position, alpha),
        rotation: this.lerpAngle(fromNpc.rotation ?? 0, toNpc.rotation ?? 0, alpha),
      };

      // Interpolate deck-local position when the NPC is aboard a ship
      if (fromNpc.localPosition && toNpc.localPosition) {
        interpolated.localPosition = this.lerpVec2(fromNpc.localPosition, toNpc.localPosition, alpha);
      }

      result.push(interpolated);
    }

    return result;
  }

  /**
   * Interpolate cannonball positions
   */
  private interpolateCannonballs(fromBalls: any[], toBalls: any[], alpha: number): any[] {
    const result = [];

    // Build O(1) lookup to avoid O(N²) .find() per cannonball
    const fromById = new Map<number, any>();
    for (const b of fromBalls) fromById.set(b.id, b);

    for (const toBall of toBalls) {
      const fromBall = fromById.get(toBall.id);

      if (!fromBall) {
        result.push(toBall);
        continue;
      }

      result.push({
        ...toBall,
        position: this.lerpVec2(fromBall.position, toBall.position, alpha),
        velocity: this.lerpVec2(fromBall.velocity, toBall.velocity, alpha)
      });
    }

    return result;
  }
  
  /**
   * Linear interpolation between two Vec2 vectors
   */
  private lerpVec2(from: Vec2, to: Vec2, alpha: number): Vec2 {
    return Vec2.from(
      from.x + (to.x - from.x) * alpha,
      from.y + (to.y - from.y) * alpha
    );
  }
  
  /**
   * Linear interpolation for angles (handles wrapping)
   */
  private lerpAngle(from: number, to: number, alpha: number): number {
    // Normalize angles to [-PI, PI]
    const normalizeAngle = (angle: number) => {
      while (angle > Math.PI) angle -= 2 * Math.PI;
      while (angle < -Math.PI) angle += 2 * Math.PI;
      return angle;
    };
    
    from = normalizeAngle(from);
    to = normalizeAngle(to);
    
    // Take shortest path
    let diff = to - from;
    if (diff > Math.PI) diff -= 2 * Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    
    return normalizeAngle(from + diff * alpha);
  }
  
  /**
   * Check if client-side prediction is enabled
   */
  isPredictionEnabled(): boolean {
    return this.config.enablePrediction;
  }
  
  /**
   * Get prediction statistics for debugging
   */
  getPredictionStats(): {
    clientTick: number;
    authoritativeTick: number;
    predictionHistory: number;
    rollbacksPerformed: number;
  } {
    return {
      clientTick: this.clientTick,
      authoritativeTick: this.lastAuthoritativeTick,
      predictionHistory: this.predictionHistory.length,
      rollbacksPerformed: 0 // TODO: Track rollbacks
    };
  }
  
  // Private methods
  
  private simulateStep(worldState: WorldState, inputFrame: InputFrame, deltaTime: number): WorldState {
    return simulate(worldState, inputFrame, deltaTime, this.collisionCtx);
  }
  
  private storePredictionState(tick: number, worldState: WorldState, inputFrame: InputFrame): void {
    const state: PredictionState = {
      tick,
      // Only the local player is ever read back from history — keep the snapshot lightweight.
      worldState: this.cloneLocalSnapshot(worldState),
      inputFrame: { 
        tick: inputFrame.tick,
        movement: inputFrame.movement.clone ? inputFrame.movement.clone() : Vec2.from(inputFrame.movement.x, inputFrame.movement.y),
        actions: inputFrame.actions,
        rotation: inputFrame.rotation
      },
      timestamp: Date.now(),
      serverConfirmed: false,
      predictionError: 0,
      correctionApplied: false
    };
    
    this.predictionHistory.push(state);
    
    // Limit history size using enhanced buffer size
    if (this.predictionHistory.length > PredictionEngine.MAX_PREDICTION_HISTORY) {
      this.predictionHistory.shift();
    }
  }
  
  private findPredictionState(tick: number): PredictionState | null {
    return this.predictionHistory.find(state => state.tick === tick) || null;
  }
  
  /**
   * Current decaying visual offset for the local player, advanced by `dtSeconds`. The renderer
   * adds this to the predicted position so server corrections ease in smoothly. Returns a copy.
   */
  public getRenderErrorOffset(dtSeconds: number): Vec2 {
    const off = this.localRenderErrorOffset;
    if (off.x === 0 && off.y === 0) return Vec2.zero();
    const decay = Math.exp(-Math.max(0, dtSeconds) / PredictionEngine.SMOOTH_TAU);
    this.localRenderErrorOffset = off.mul(decay);
    // Snap tiny residuals to zero to avoid endless sub-pixel drift.
    if (this.localRenderErrorOffset.lengthSq() < 0.01) this.localRenderErrorOffset = Vec2.zero();
    return this.localRenderErrorOffset.clone();
  }
  
  /**
   * Blend between two world states for smooth corrections
   */
  private blendWorldStates(from: WorldState, to: WorldState, alpha: number): WorldState {
    return {
      tick: to.tick,
      timestamp: to.timestamp,
      ships: to.ships.map((toShip, i) => {
        const fromShip = from.ships[i];
        if (!fromShip) return toShip;
        
        return {
          ...toShip,
          position: fromShip.position.lerp(toShip.position, alpha),
          velocity: fromShip.velocity.lerp(toShip.velocity, alpha),
        };
      }),
      players: to.players.map((toPlayer, i) => {
        const fromPlayer = from.players[i];
        if (!fromPlayer) return toPlayer;
        
        return {
          ...toPlayer,
          position: fromPlayer.position.lerp(toPlayer.position, alpha),
          velocity: fromPlayer.velocity.lerp(toPlayer.velocity, alpha),
        };
      }),
      cannonballs: to.cannonballs, // Don't smooth projectiles
      npcs: to.npcs,
      tombstones: to.tombstones ?? [],
      droppedItems: to.droppedItems ?? [],
      companies: to.companies ?? [],
      carrierDetection: to.carrierDetection,
    };
  }
  
  private cleanupOldStates(currentTick: number): void {
    // Remove prediction states older than rollback limit
    const minTick = currentTick - this.config.rollbackLimit;
    this.predictionHistory = this.predictionHistory.filter(
      state => state.tick >= minTick
    );
  }
  
  /**
   * Lightweight clone for the per-tick history/rewind buffers. These are only ever read for the
   * LOCAL player (reconciliation comparison + input replay), so cloning the entire world (all
   * ships/players/cannonballs) at 120 Hz × 128 history entries is pure GC pressure. We copy only
   * the local player and leave the other collections as cheap empty arrays.
   */
  private cloneLocalSnapshot(worldState: WorldState): WorldState {
    const localId = this.localPlayerId;
    const src = localId !== null
      ? worldState.players.find(p => p.id === localId)
      : worldState.players[0];
    const players = src
      ? [{
          ...src,
          position: src.position ? src.position.clone() : Vec2.zero(),
          velocity: src.velocity ? src.velocity.clone() : Vec2.zero(),
          localPosition: src.localPosition ? src.localPosition.clone() : undefined,
        }]
      : [];
    return {
      tick: worldState.tick,
      timestamp: worldState.timestamp,
      ships: [],
      players,
      cannonballs: [],
      npcs: [],
      tombstones: [],
      droppedItems: [],
      companies: [],
      carrierDetection: new Map(),
    } as WorldState;
  }

  private cloneWorldState(worldState: WorldState): WorldState {
    // Deep clone world state for prediction
    return {
      tick: worldState.tick,
      timestamp: worldState.timestamp,
      ships: worldState.ships.map(ship => ({
        ...ship,
        position: ship.position ? ship.position.clone() : Vec2.zero(),
        velocity: ship.velocity ? ship.velocity.clone() : Vec2.zero(),
        hull: ship.hull ? ship.hull.map(point => point ? point.clone() : Vec2.zero()) : [],
        modules: ship.modules ? ship.modules.map(module => ({ ...module })) : []
      })),
      players: worldState.players.map(player => ({
        ...player,
        position: player.position ? player.position.clone() : Vec2.zero(),
        velocity: player.velocity ? player.velocity.clone() : Vec2.zero()
      })),
      cannonballs: worldState.cannonballs.map(ball => ({
        ...ball,
        position: ball.position ? ball.position.clone() : Vec2.zero(),
        velocity: ball.velocity ? ball.velocity.clone() : Vec2.zero(),
        firingVelocity: ball.firingVelocity ? ball.firingVelocity.clone() : Vec2.zero(),
        smokeTrail: ball.smokeTrail ? ball.smokeTrail.map(smoke => ({
          ...smoke,
          position: smoke.position ? smoke.position.clone() : Vec2.zero()
        })) : []
      })),
      npcs: worldState.npcs || [],
      tombstones: worldState.tombstones ?? [],
      droppedItems: worldState.droppedItems ?? [],
      companies: worldState.companies ?? [],
      carrierDetection: new Map(worldState.carrierDetection)
    };
  }
  
  /**
   * Input validation for Week 3-4 anti-cheat
   */
  private validateInputFrame(inputFrame: InputFrame): boolean {
    const now = Date.now();
    this.inputValidation.totalInputs++;
    
    // ✅ Input validation debug logging
    
    // Check movement magnitude (reasonable bounds)
    const movementMagnitude = Math.sqrt(inputFrame.movement.x * inputFrame.movement.x + inputFrame.movement.y * inputFrame.movement.y);
    if (movementMagnitude > 1.5) { // Allow some tolerance for diagonal movement
      this.inputValidation.invalidInputs++;
      console.log(`❌ Input rejected - Movement magnitude too high: ${movementMagnitude.toFixed(3)}`);
      return false;
    }
    
    // Check for timestamp anomalies (but don't reject based on timing)
    if (this.inputValidation.lastInputTimestamp > 0) {
      const timeDelta = now - this.inputValidation.lastInputTimestamp;
      if (timeDelta > 100 || timeDelta < 0) { // More than 100ms gap or negative time
        this.inputValidation.timestampAnomalies++;
        console.log(`⚠️ Timestamp anomaly detected: ${timeDelta}ms delta`);
      }
    }
    
    this.inputValidation.lastInputTimestamp = now;
    return true;
  }
  
  /**
   * Update rewind buffer for lag compensation
   */
  private updateRewindBuffer(tick: number, worldState: WorldState, inputFrame: InputFrame, deltaTime: number): void {
    const entry: RewindBufferEntry = {
      tick,
      // Lightweight: only the local player is needed for lag-comp queries.
      worldState: this.cloneLocalSnapshot(worldState),
      inputFrame: { ...inputFrame },
      timestamp: Date.now(),
      networkDelay: this.estimatedNetworkDelay
    };
    
    this.rewindBuffer.push(entry);
    
    // Maintain ring buffer size (16 frames)
    if (this.rewindBuffer.length > PredictionEngine.REWIND_BUFFER_SIZE) {
      this.rewindBuffer.shift();
    }
  }
  
  /**
   * Get rewind buffer state for server validation
   */
  public getRewindBufferState(serverTick: number): RewindBufferEntry | null {
    // Find the closest rewind buffer entry to the server tick
    return this.rewindBuffer.find(entry => entry.tick === serverTick) || null;
  }
  
  /**
   * Enhanced prediction statistics with Week 3-4 metrics
   */
  public getEnhancedPredictionStats(): {
    prediction: PredictionMetrics;
    inputValidation: InputValidationMetrics;
    rewindBuffer: {
      size: number;
      oldestTick: number;
      newestTick: number;
      coverage: number; // milliseconds of coverage
    };
  } {
    const oldestEntry = this.rewindBuffer[0];
    const newestEntry = this.rewindBuffer[this.rewindBuffer.length - 1];
    
    return {
      prediction: this.predictionMetrics,
      inputValidation: this.inputValidation,
      rewindBuffer: {
        size: this.rewindBuffer.length,
        oldestTick: oldestEntry?.tick || 0,
        newestTick: newestEntry?.tick || 0,
        coverage: newestEntry && oldestEntry ? newestEntry.timestamp - oldestEntry.timestamp : 0
      }
    };
  }
}