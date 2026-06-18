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
import { WorldState, InputFrame, PhysicsConfig } from '../sim/Types.js';
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
  receiveTime: number; // Client time (performance.now) when received
  serverTime: number;  // Server clock in ms (tick × SERVER_MS_PER_TICK) — monotonic, jitter-free
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
  // 16 entries × 33ms = ~530ms of server time covered, well above the 300ms max buffer.
  private static readonly MAX_SERVER_STATES = 16;

  // ── Server-clock-locked interpolation timeline ──────────────────────────────
  // Playback is paced on the server's own monotonic clock (derived from the snapshot
  // `tick`, which the server sets to its get_time_ms()/33), NOT on packet ARRIVAL
  // time. Arrival time carries network jitter, so using it stretches/compresses the
  // interpolation alpha and makes remote ships micro-accelerate every frame. The
  // server clock is regularly spaced, so interpolating against it is jitter-immune.
  //
  // serverClockOffset maps local→server time: serverTime ≈ localTime − serverClockOffset.
  // Estimated as the MINIMUM observed (receiveTime − serverTime) so it locks onto the
  // least-delayed packet (true offset), immune to per-packet jitter, then drifts slowly
  // upward to follow genuine latency/clock skew increases.
  private serverClockOffset: number | null = null;
  // Smoothed render delay (= serverClockOffset + interpolationBuffer) actually applied to
  // renderTime. serverClockOffset is stepped at the 30 Hz packet rate and interpolationBuffer
  // at the ping rate; applying those steps directly makes renderTime jump every ~33 ms, which
  // shimmers the world (very visible once the camera is locked to a moving ship). We ease the
  // applied delay toward its target each render frame so the steps become smooth sub-pixel
  // per-frame changes. Clock drift is slow, so the easing lag is negligible.
  private _renderDelaySmoothed: number | null = null;
  private _lastRenderDelayTime = 0;

  // ── Interpolation telemetry (gated; set true to log per-second interp/hold stats) ──
  // Kept after the jitter hunt: this is the fastest way to re-diagnose any future
  // interpolation regression (interp vs hold counts, buffer cadence, clock-offset stability).
  // When false the only cost is one boolean check per frame.
  public static DEBUG_INTERP = false;
  private _diag = {
    t0: 0, frames: 0, interp: 0, holdNew: 0, holdOld: 0, disabled: 0,
    shipMoved: 0, lastShipX: NaN, lastShipId: -1,
    alphaMin: 1, alphaMax: 0,
  };
  private static readonly RENDER_DELAY_TAU = 0.25;  // s — gentle; clock drift is slow
  private static readonly RENDER_DELAY_SNAP = 50;   // ms — beyond this, snap (resync/teleport)
  // Server physics runs at exactly 30 Hz → 1000/30 = 33.333... ms per tick.
  // Using the integer 33 caused a 10 ms/second cumulative drift (3 s per 5 min).
  private static readonly SERVER_MS_PER_TICK = 1000 / 30;
  // Smoothing factor for the clock offset (per snapshot). We track a STABLE AVERAGE offset,
  // not the minimum-transit packet. Min-tracking anchored renderTime to the lowest-latency
  // packet — the most-forward position — which ate the buffer margin and caused hold-newest
  // whenever cadence/jitter exceeded the slack (the oscillating 30 Hz we observed). A slow EMA
  // toward the typical offset keeps renderTime a reliable `buffer` ms behind the newest
  // snapshot; transit jitter is absorbed by the buffer + the per-frame _renderDelaySmoothed ease.
  // ~0.05 at ~20 snapshots/s ⇒ ~1 s time constant: stable, still tracks real clock drift.
  private static readonly CLOCK_EMA_ALPHA = 0.05;
  // Resync guard: if a fresh sample diverges from the tracked offset by more than this,
  // the offset has clearly mis-latched (tick discontinuity, tab resume, clock jump, or a
  // bad latch the slow drift can't crawl back from in a session). Snap to the sample
  // instead of crawling. Normal transit jitter is a few ms, well under this, so steady-state
  // min-tracking is unaffected. Without this, a single bad latch pins renderTime forever and
  // every frame falls into the hold-newest branch → permanent 30 Hz instead of interpolation.
  private static readonly CLOCK_RESYNC_MS = 500;
  
  // Timing and lag compensation
  private clientTick = 0;
  private clientTickAtLastServerState = 0;
  private estimatedNetworkDelay = 0;
  // Observed real-time cadence between DISTINCT server snapshots. The server may broadcast
  // slower than its 30 Hz sim (we've seen ~20 Hz with 133 ms bursts), so the interpolation
  // buffer must cover the actual packet interval, not the tick interval — otherwise renderTime
  // outruns the newest snapshot during a gap and we fall into hold-newest (visible 30 Hz).
  private _snapshotIntervalMs = PredictionEngine.SERVER_MS_PER_TICK; // EMA of receive spacing
  private _maxRecentIntervalMs = PredictionEngine.SERVER_MS_PER_TICK; // decaying worst-case gap
  private _lastSnapshotReceive = 0;
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

  // Track the client tick when the local player boarded a ship (carrierId 0 → >0).
  // Used to widen the server-deck-trust window so a single boarding frame isn't the
  // only moment the server's authoritative deck_level is applied.
  private _boardingClientTick: number = -1;
  private static readonly BOARDING_DECK_TRUST_TICKS = 15; // ~125 ms at 8ms/tick
  
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

  // ── Ship rendering ───────────────────────────────────────────────────────
  // Ships are rendered straight from the server-clock-driven linear interpolation
  // (see getInterpolatedState + interpolateShips). No second smoothing stage is
  // applied: a frameDt-dependent follower reintroduced jitter, so the clean,
  // evenly-distributed interpolated transform is passed through unmodified.

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
    const oneWayLatency = pingMs / 2;

    // Fast-start: on the first sample, jump straight to the measured value so we
    // don't spend the first few seconds at the cold-start default (100ms buffer).
    const alpha = this.estimatedNetworkDelay === 0 ? 1.0 : 0.1;
    this.estimatedNetworkDelay = this.estimatedNetworkDelay * (1 - alpha) + oneWayLatency * alpha;
    
    // Recompute the interpolation buffer from the latest latency estimate.
    this._recomputeBuffer();

    const serverTickTime = 1000 / this.config.serverTickRate;
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
   * Size the interpolation buffer so renderTime always sits behind a snapshot we actually have.
   *
   * Driven by the OBSERVED snapshot cadence (`_snapshotIntervalMs` / `_maxRecentIntervalMs`),
   * not the nominal tick rate, because the server can broadcast slower/irregularly (~20 Hz with
   * 133 ms bursts seen in the wild). The buffer must exceed the worst recent gap + transit, or
   * renderTime outruns the newest snapshot during a gap → hold-newest → visible 30 Hz.
   *
   * Self-tuning: if the server later delivers a clean 30 Hz, the observed interval collapses to
   * ~33 ms and the buffer shrinks back toward the 100 ms floor — no permanent added latency.
   */
  private _recomputeBuffer(): void {
    const jitterMargin = 40;
    // Cover the worst recent gap; the EMA keeps it from collapsing on a lucky run of tight packets.
    const cadence = Math.max(this._snapshotIntervalMs, this._maxRecentIntervalMs);
    const dynamicBuffer = this.estimatedNetworkDelay + cadence + jitterMargin;
    const minBuffer = Math.ceil(3 * PredictionEngine.SERVER_MS_PER_TICK); // 100 ms at 30 Hz
    const maxBuffer = 350;
    this.config.interpolationBuffer = Math.max(minBuffer, Math.min(maxBuffer, dynamicBuffer));
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
          // deckId: CLIENT semi-authority during ramp transitions — the RenderSystem state
          // machine transitions this immediately when the player enters/exits a ramp zone,
          // then sends player_set_deck to the server.  Until the server echoes back the new
          // deck_level (one RTT later) the snapshot still carries the old deck.  Overwriting
          // with the stale server value every tick would apply the WRONG per-deck collision
          // filter for the full RTT, letting players walk through ramp walls or fall through
          // upper-deck floors.  We keep the client value — EXCEPT within the first
          // BOARDING_DECK_TRUST_TICKS ticks after boarding (carrierId changed 0 → non-zero),
          // where we trust the server's authoritative deck_level unconditionally.
          deckId: (() => {
            const boardingNow = serverLocal.carrierId > 0 && runningLocal.carrierId === 0;
            if (boardingNow) {
              // Record the tick we first saw the boarding so the grace window can be measured.
              this._boardingClientTick = this.clientTick;
            }
            const inBoardingWindow = this._boardingClientTick >= 0 &&
              (this.clientTick - this._boardingClientTick) < PredictionEngine.BOARDING_DECK_TRUST_TICKS;
            // Reset boarding window when the player dismounts
            if (serverLocal.carrierId === 0 && runningLocal.carrierId > 0) {
              this._boardingClientTick = -1;
            }
            return (boardingNow || inBoardingWindow)
              ? serverLocal.deckId   // boarding window: trust server's authoritative deck_level
              : runningLocal.deckId; // normal walking / ramp transition: keep client value
          })(),
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
        // ── Latency-robust trigger decision ──────────────────────────────────────
        // The server snapshot reflects the position the CLIENT itself reported at
        // serverState.tick (semi-authority: the server adopts our position). The
        // running prediction has since advanced by roughly v×RTT — that lead is
        // legitimate, NOT a misprediction. Comparing the snapshot against the current
        // running position therefore inflates the error by the lead and, past ~500 ms
        // RTT while sprinting (120 u/s × 0.5 s = 60 u), trips a FALSE correction that
        // snaps the player backward every snapshot.
        //
        // To isolate genuine server-forced moves (teleport / respawn / forced dismount)
        // from ordinary lead, compare the snapshot against the client's OWN prediction
        // at the SAME server tick when it's still in history. That difference is
        // latency-independent. Only when no matching prediction exists (extreme ping /
        // history eviction) do we fall back to the running position, with a threshold
        // widened by the maximum distance the player could have legitimately travelled
        // during the round trip so the lead alone never trips it.
        const matchedLocal = this.findClosestPredictionLocal(serverState.tick, 2);

        let triggered: boolean;
        if (matchedLocal) {
          const mispredict = serverPlayer.position.sub(matchedLocal.position).length();
          triggered = mispredict > PredictionEngine.FORCED_CORRECTION_THRESHOLD;
        } else {
          const fullRttSec = (this.estimatedNetworkDelay * 2) / 1000;
          const sprintLead = PhysicsConfig.PLAYER_WALK_SPEED
            * PhysicsConfig.PLAYER_SPRINT_MULT * fullRttSec;
          const dynThreshold = PredictionEngine.FORCED_CORRECTION_THRESHOLD + sprintLead;
          triggered = serverPlayer.position.sub(runningLocal.position).length() > dynThreshold;
        }

        const posDiff = serverPlayer.position.sub(runningLocal.position).length();

        if (triggered) {
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
   * Remote-entity snapshot interpolation (rewritten clean).
   *
   * Model: keep a small buffer of authoritative server snapshots, each tagged with a
   * server-clock time (tick × 33.33ms). Each render frame we pick a renderTime slightly
   * in the past (so we always have a snapshot ahead to interpolate toward), find the two
   * snapshots straddling it, and LINEARLY interpolate between them. The fraction `alpha`
   * is derived from the server clock, so it advances perfectly evenly between snapshots —
   * filling the 120 Hz frames at uniform spacing with no spline overshoot.
   *
   * No extrapolation: if renderTime runs past the newest snapshot (a late/missed packet)
   * we HOLD the newest known state until the next packet arrives. A brief micro-freeze is
   * preferred over dead-reckoning that overshoots and then snaps back.
   *
   * The local player is handled separately by prediction and spliced in by the renderer;
   * this path only produces smooth remote entities (ships, other players, NPCs, balls).
   */
  getInterpolatedState(currentTime: number): WorldState | null {
    if (!this.config.enableInterpolation || this.serverStateBuffer.length === 0) {
      if (PredictionEngine.DEBUG_INTERP) { this._diag.disabled++; this._diagTick(currentTime, null); }
      return this.authoritativeState;
    }

    // ── Render clock ─────────────────────────────────────────────────────────
    // renderTime = local time mapped onto the server clock (via the jitter-immune
    // serverClockOffset) minus the interpolation buffer. The applied delay
    // (offset + buffer) is eased toward its target so the discrete steps in offset
    // (30 Hz packet rate) and buffer (ping rate) don't perturb renderTime and shimmer
    // the world. The ease only ever holds the delay slightly behind target, so renderTime
    // stays monotonic (currentTime advances a full frame each call, far more than the
    // sub-millisecond per-frame delay change).
    const targetDelay = (this.serverClockOffset ?? 0) + this.config.interpolationBuffer;
    if (this._renderDelaySmoothed === null) {
      this._renderDelaySmoothed = targetDelay;
    } else {
      const gap = targetDelay - this._renderDelaySmoothed;
      if (Math.abs(gap) > PredictionEngine.RENDER_DELAY_SNAP) {
        this._renderDelaySmoothed = targetDelay; // big change → snap (initial sync / resync)
      } else {
        const sdt = Math.max(0, (currentTime - this._lastRenderDelayTime) / 1000);
        this._renderDelaySmoothed += gap * (1 - Math.exp(-sdt / PredictionEngine.RENDER_DELAY_TAU));
      }
    }
    this._lastRenderDelayTime = currentTime;
    const renderTime = currentTime - this._renderDelaySmoothed;

    const buf = this.serverStateBuffer;
    const newest = buf[buf.length - 1];
    const oldest = buf[0];

    // ── Buffer boundaries: HOLD, never extrapolate ──────────────────────────
    if (renderTime >= newest.serverTime) {
      this._pruneHullCache(newest.worldState);
      if (PredictionEngine.DEBUG_INTERP) { this._diag.holdNew++; this._diagTick(currentTime, newest.worldState); }
      return newest.worldState;        // ahead of newest packet — hold latest
    }
    if (renderTime <= oldest.serverTime) {
      this._pruneHullCache(oldest.worldState);
      if (PredictionEngine.DEBUG_INTERP) { this._diag.holdOld++; this._diagTick(currentTime, oldest.worldState); }
      return oldest.worldState;        // behind oldest packet — hold earliest
    }

    // ── Find the straddling pair and LINEARLY interpolate ───────────────────
    for (let i = 0; i < buf.length - 1; i++) {
      const from = buf[i];
      const to   = buf[i + 1];
      if (from.serverTime <= renderTime && renderTime <= to.serverTime) {
        const span = to.serverTime - from.serverTime;
        if (span <= 0) {               // duplicate/late tick — nothing to interpolate
          this._pruneHullCache(from.worldState);
          if (PredictionEngine.DEBUG_INTERP) { this._diag.holdNew++; this._diagTick(currentTime, from.worldState); }
          return from.worldState;
        }
        const alpha = (renderTime - from.serverTime) / span; // intrinsically within [0,1]
        const out = this.interpolateStates(from.worldState, to.worldState, alpha);
        this._pruneHullCache(out);
        if (PredictionEngine.DEBUG_INTERP) {
          this._diag.interp++;
          this._diag.alphaMin = Math.min(this._diag.alphaMin, alpha);
          this._diag.alphaMax = Math.max(this._diag.alphaMax, alpha);
          this._diagTick(currentTime, out);
        }
        return out;
      }
    }

    // Unreachable (renderTime is between oldest and newest) — hold newest defensively.
    this._pruneHullCache(newest.worldState);
    if (PredictionEngine.DEBUG_INTERP) { this._diag.holdNew++; this._diagTick(currentTime, newest.worldState); }
    return newest.worldState;
  }

  /** TEMP DIAG: tally per-frame interpolation outcome + sample ship motion; log at 1 Hz. */
  private _diagTick(currentTime: number, state: WorldState | null): void {
    const d = this._diag;
    d.frames++;

    // Track whether a sample ship's rendered X actually changes frame-to-frame.
    const ship = state?.ships?.[0];
    if (ship) {
      if (ship.id !== d.lastShipId) { d.lastShipId = ship.id; d.lastShipX = NaN; }
      if (!Number.isNaN(d.lastShipX) && Math.abs(ship.position.x - d.lastShipX) > 1e-4) d.shipMoved++;
      d.lastShipX = ship.position.x;
    }

    if (d.t0 === 0) d.t0 = currentTime;
    if (currentTime - d.t0 >= 1000) {
      const buf = this.serverStateBuffer;
      const ticks = buf.map(e => e.tick);
      const spacings: number[] = [];
      for (let i = 1; i < buf.length; i++) spacings.push(+(buf[i].serverTime - buf[i - 1].serverTime).toFixed(1));
      console.log(
        `[INTERP] ${d.frames}f/s | interp=${d.interp} holdNew=${d.holdNew} holdOld=${d.holdOld} off=${d.disabled}` +
        ` | shipPosChanged=${d.shipMoved}/${d.frames}f` +
        ` | alpha=[${d.alphaMin.toFixed(2)},${d.alphaMax.toFixed(2)}]` +
        ` | bufLen=${buf.length} ticks=${ticks.join(',')} spacingMs=${spacings.join(',')}` +
        ` | offset=${(this.serverClockOffset ?? 0).toFixed(0)} buf=${this.config.interpolationBuffer.toFixed(0)} delay=${(this._renderDelaySmoothed ?? 0).toFixed(0)}`,
      );
      this._diag = { t0: currentTime, frames: 0, interp: 0, holdNew: 0, holdOld: 0, disabled: 0,
                     shipMoved: 0, lastShipX: d.lastShipX, lastShipId: d.lastShipId, alphaMin: 1, alphaMax: 0 };
    }
  }

  /** Drop cached hull geometry for ships that no longer exist (memory hygiene only). */
  private _pruneHullCache(worldState: WorldState): void {
    if (this._hullRefCache.size > worldState.ships.length + 4) {
      const live = new Set(worldState.ships.map(s => s.id));
      for (const id of this._hullRefCache.keys()) {
        if (!live.has(id)) this._hullRefCache.delete(id);
      }
    }
  }
  
  /**
   * Add server state to interpolation buffer
   */
  private addServerState(worldState: WorldState): void {
    const receiveTime = performance.now();
    // Server clock for this snapshot: tick × (1000/30) ms.
    // Tick is the monotonic sim tick counter (incremented once per physics step).
    const serverTime = worldState.tick * PredictionEngine.SERVER_MS_PER_TICK;

    // ── Clock offset estimation ────────────────────────────────────────────────
    // serverClockOffset maps local time → server time: serverTime ≈ localTime - offset.
    // We track a STABLE AVERAGE of (receiveTime - serverTime), not the minimum. The mean
    // keeps renderTime a predictable `buffer` ms behind the newest snapshot; the buffer and
    // the per-frame render-delay ease absorb transit jitter. A discontinuity (tick jump, tab
    // resume, clock skew) is snapped so a mis-latch can't pin renderTime forever (the 30 Hz bug).
    const sample = receiveTime - serverTime;

    if (this.serverClockOffset === null) {
      this.serverClockOffset = sample;
    } else if (Math.abs(sample - this.serverClockOffset) > PredictionEngine.CLOCK_RESYNC_MS) {
      this.serverClockOffset = sample;   // discontinuity → snap
    } else {
      this.serverClockOffset += (sample - this.serverClockOffset) * PredictionEngine.CLOCK_EMA_ALPHA;
    }

    // ── Deduplicate ticks ──────────────────────────────────────────────────────
    // A retransmit or duplicate packet with the same tick would waste a buffer
    // slot and evict a valid older state.  Update in-place instead of pushing.
    const existingIdx = this.serverStateBuffer.findIndex(e => e.tick === worldState.tick);
    if (existingIdx >= 0) {
      this.serverStateBuffer[existingIdx] = {
        worldState: this.cloneWorldState(worldState),
        tick: worldState.tick,
        timestamp: worldState.timestamp,
        receiveTime,
        serverTime,
      };
      return;
    }

    // ── Observed cadence (distinct ticks only) ──────────────────────────────────
    // Track the real receive spacing between fresh snapshots and re-size the buffer to
    // cover it. The server's broadcast cadence (not its tick rate) is what determines how
    // far back renderTime must sit to always have a snapshot ahead to interpolate toward.
    if (this._lastSnapshotReceive > 0) {
      const interval = receiveTime - this._lastSnapshotReceive;
      if (interval > 0 && interval < 1000) { // ignore the first packet after a long stall
        this._snapshotIntervalMs += (interval - this._snapshotIntervalMs) * 0.2; // EMA
        // Decaying worst-case: jump up to big gaps instantly, relax slowly afterward.
        this._maxRecentIntervalMs = Math.max(interval, this._maxRecentIntervalMs * 0.98);
        this._recomputeBuffer();
      }
    }
    this._lastSnapshotReceive = receiveTime;

    const entry: ServerStateEntry = {
      worldState: this.cloneWorldState(worldState),
      tick: worldState.tick,
      timestamp: worldState.timestamp,
      receiveTime,
      serverTime,
    };
    
    this.serverStateBuffer.push(entry);
    
    if (this.serverStateBuffer.length > PredictionEngine.MAX_SERVER_STATES) {
      this.serverStateBuffer.shift();
    }
  }
  
  /**
   * Linearly interpolate every entity collection between two server snapshots.
   * `alpha` is the server-clock fraction within the [from, to] tick window.
   */
  private interpolateStates(
    from: WorldState,
    to: WorldState,
    alpha: number,
  ): WorldState {
    return {
      tick: Math.round(from.tick + (to.tick - from.tick) * alpha),
      timestamp: from.timestamp + (to.timestamp - from.timestamp) * alpha,
      ships:       this.interpolateShips(from.ships, to.ships, alpha),
      players:     this.interpolatePlayers(from.players, to.players, alpha),
      cannonballs: this.interpolateCannonballs(from.cannonballs, to.cannonballs, alpha),
      npcs:        this.interpolateNpcs(from.npcs, to.npcs, alpha),
      tombstones:  to.tombstones ?? [],
      droppedItems: to.droppedItems ?? [],
      companies:   to.companies ?? [],
      carrierDetection: new Map(from.carrierDetection),
    };
  }
  
  /**
   * Interpolate ship positions and rotations with pure LINEAR interpolation.
   *
   * `alpha` comes from the server clock (see getInterpolatedState), so it
   * advances perfectly evenly between two 30 Hz snapshots. A plain lerp therefore
   * fills the intermediate 120 Hz frames at uniform spacing — e.g.
   * (10,10)→(20,20) renders as (12.5,12.5)(15,15)(17.5,17.5)(20,20).
   *
   * Cubic splines (Hermite / Catmull-Rom) were tried previously but their tangents
   * (whether server-velocity or finite-difference) produce non-uniform frame spacing
   * and can overshoot, which is read as jitter. Rotation uses the same uniform lerp
   * with a shortest-arc unwrap to handle the ±π discontinuity.
   */
  private interpolateShips(
    fromShips: any[], toShips: any[], alpha: number,
  ): any[] {
    const result = [];
    const fromById = new Map<number, any>();
    for (const s of fromShips) fromById.set(s.id, s);

    for (const toShip of toShips) {
      const fromShip = fromById.get(toShip.id);
      if (!fromShip) {
        // Ship not yet in the previous snapshot (just spawned / first frame).
        // Show at final position — will be smooth from next frame onward.
        result.push(toShip);
        continue;
      }

      // ── Pure linear position ─────────────────────────────────────────────────
      // alpha is derived from the SERVER clock in getInterpolatedState, so it
      // advances evenly (0.25, 0.5, 0.75, 1.0 across a 30→120 Hz segment). A plain
      // lerp therefore distributes frames perfectly evenly between the two server
      // states — e.g. (10,10)→(20,20) renders as (12.5,12.5)(15,15)(17.5,17.5)(20,20).
      // Cubic splines (Catmull-Rom/Hermite) are intentionally NOT used here: their
      // frame spacing is non-uniform and their tangents can overshoot, which reads
      // as the residual jitter we were chasing. Server positions are already in
      // client-pixel space (scaled ×10), so no extra scaling is needed.
      const pos = this.lerpVec2(fromShip.position, toShip.position, alpha);

      // ── Shortest-arc linear rotation ─────────────────────────────────────────
      let rotErr = toShip.rotation - fromShip.rotation;
      while (rotErr >  Math.PI) rotErr -= 2 * Math.PI;
      while (rotErr < -Math.PI) rotErr += 2 * Math.PI;
      const rot = fromShip.rotation + rotErr * alpha;

      result.push({
        ...toShip,
        position:        pos,
        rotation:        rot,
        // Interpolate velocity so mounted-player anchoring uses smooth vel
        velocity:        this.lerpVec2(fromShip.velocity, toShip.velocity, alpha),
        angularVelocity: fromShip.angularVelocity + (toShip.angularVelocity - fromShip.angularVelocity) * alpha,
      });
    }

    return result;
  }

  /**
   * Interpolate remote player positions — pure linear (uniform frame spacing).
   */
  private interpolatePlayers(fromPlayers: any[], toPlayers: any[], alpha: number): any[] {
    const result = [];
    const fromById = new Map<number, any>();
    for (const p of fromPlayers) fromById.set(p.id, p);

    for (const toPlayer of toPlayers) {
      const fromPlayer = fromById.get(toPlayer.id);
      if (!fromPlayer) {
        result.push(toPlayer);   // just appeared — show at final position
        continue;
      }

      result.push({
        ...toPlayer,
        position: this.lerpVec2(fromPlayer.position, toPlayer.position, alpha),
        velocity: (fromPlayer.velocity && toPlayer.velocity)
          ? this.lerpVec2(fromPlayer.velocity, toPlayer.velocity, alpha)
          : toPlayer.velocity,
      });
    }

    return result;
  }

  /**
   * Interpolate NPC positions, rotations, and deck-local positions — pure linear.
   */
  private interpolateNpcs(fromNpcs: any[], toNpcs: any[], alpha: number): any[] {
    const result = [];
    const fromById = new Map<number, any>();
    for (const n of fromNpcs) fromById.set(n.id, n);

    for (const toNpc of toNpcs) {
      const fromNpc = fromById.get(toNpc.id);
      if (!fromNpc) {
        result.push(toNpc);   // just appeared — show at final position
        continue;
      }

      const interpolated: any = {
        ...toNpc,
        position: this.lerpVec2(fromNpc.position, toNpc.position, alpha),
        rotation: this.lerpAngle(fromNpc.rotation ?? 0, toNpc.rotation ?? 0, alpha),
      };

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
    const normalizeAngle = (angle: number) => {
      while (angle > Math.PI) angle -= 2 * Math.PI;
      while (angle < -Math.PI) angle += 2 * Math.PI;
      return angle;
    };
    from = normalizeAngle(from);
    to   = normalizeAngle(to);
    let diff = to - from;
    if (diff > Math.PI)  diff -= 2 * Math.PI;
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
   * Find the local player's stored prediction at (or nearest within ±tol of) a server
   * tick. Used by the forced-correction gate to compare the server snapshot against the
   * client's own same-tick prediction, isolating genuine server-forced moves from the
   * legitimate v×RTT lead. A small tolerance absorbs ±1 tick error in the RTT-lead label.
   * Returns the local player snapshot (with a cloned position) or null when no prediction
   * within tolerance survives in history (extreme ping / eviction).
   */
  private findClosestPredictionLocal(tick: number, tol: number): { position: Vec2 } | null {
    let best: PredictionState | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const state of this.predictionHistory) {
      const delta = Math.abs(state.tick - tick);
      if (delta <= tol && delta < bestDelta) {
        best = state;
        bestDelta = delta;
        if (delta === 0) break;
      }
    }
    if (!best) return null;
    const local = this.localPlayerId !== null
      ? best.worldState.players.find(p => p.id === this.localPlayerId)
      : best.worldState.players[0];
    return local?.position ? { position: local.position } : null;
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

  // Per-ship hull geometry cache: hull arrays are static (shape never changes) so we
  // reuse the same reference across all cloned snapshots.  Cloning 47 Vec2 objects
  // per ship per state arrival (30 Hz × 8 ships = 11,280 allocations/s) was a major
  // GC pressure source causing periodic main-thread pauses visible as snap frames.
  private _hullRefCache = new Map<number, any[]>();

  private cloneWorldState(worldState: WorldState): WorldState {
    return {
      tick: worldState.tick,
      timestamp: worldState.timestamp,
      ships: worldState.ships.map(ship => {
        // Hull geometry is set once on ship creation and never changes.
        // Share the same array reference across all buffer entries.
        let hullRef = this._hullRefCache.get(ship.id);
        if (!hullRef || hullRef !== ship.hull) {
          // First time or hull replaced (shouldn't happen, but be safe)
          hullRef = ship.hull ?? [];
          this._hullRefCache.set(ship.id, hullRef);
        }
        return {
          ...ship,
          position: ship.position ? ship.position.clone() : Vec2.zero(),
          velocity: ship.velocity ? ship.velocity.clone() : Vec2.zero(),
          hull: hullRef,                    // shared ref — never mutated after parse
          modules: ship.modules ? ship.modules.map(m => ({ ...m })) : [],
        };
      }),
      players: worldState.players.map(player => ({
        ...player,
        position: player.position ? player.position.clone() : Vec2.zero(),
        velocity: player.velocity ? player.velocity.clone() : Vec2.zero(),
      })),
      cannonballs: worldState.cannonballs.map(ball => ({
        ...ball,
        position: ball.position ? ball.position.clone() : Vec2.zero(),
        velocity: ball.velocity ? ball.velocity.clone() : Vec2.zero(),
        firingVelocity: ball.firingVelocity ? ball.firingVelocity.clone() : Vec2.zero(),
        // smokeTrail is client-side only (not received from server), so no need to clone
        smokeTrail: ball.smokeTrail ?? [],
      })),
      npcs: worldState.npcs || [],
      tombstones: worldState.tombstones ?? [],
      droppedItems: worldState.droppedItems ?? [],
      companies: worldState.companies ?? [],
      carrierDetection: new Map(worldState.carrierDetection),
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