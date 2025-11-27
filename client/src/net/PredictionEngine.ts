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
  
  // Rollback and correction
  private needsRollback = false;
  private rollbackTick = 0;
  
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
  
  // Ring buffer constants (16 frames = ~350ms at 60Hz)
  private static readonly REWIND_BUFFER_SIZE = 16;
  private static readonly MAX_PREDICTION_HISTORY = 32;
  
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
    
    // Log occasionally for debugging
    if (Math.random() < 0.01) {
      console.log(`📡 Network: ping=${pingMs.toFixed(0)}ms, buffer=${this.config.interpolationBuffer.toFixed(0)}ms`);
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
    const estimatedServerTick = this.lastAuthoritativeTick + serverTickOffset;
    
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
    
    // Perform client-side simulation step
    const predictedState = this.simulateStep(baseWorldState, inputFrame, deltaTime);
    
    // Store prediction state using the estimated server tick
    this.storePredictionState(inputFrame.tick, predictedState, inputFrame);
    
    // Handle rollback if needed
    if (this.needsRollback) {
      return this.performRollback(predictedState, deltaTime);
    }
    
    return predictedState;
  }
  
  /**
   * Handle new authoritative state from server
   */
  onAuthoritativeState(serverState: WorldState): void {
    this.authoritativeState = serverState;
    this.lastAuthoritativeTick = serverState.tick;
    
    // Reset client tick offset when we get a new server state
    this.clientTickAtLastServerState = this.clientTick;
    
    // Add to server state buffer for interpolation
    this.addServerState(serverState);
    
    const predictionState = this.findPredictionState(serverState.tick);
    
    if (predictionState) {
      const serverPlayer = serverState.players[0];
      const predictedPlayer = predictionState.worldState.players[0];
      
      if (serverPlayer && predictedPlayer) {
        const serverVel = serverPlayer.velocity.length();
        const predictedVel = predictedPlayer.velocity.length();
        const posDiff = serverPlayer.position.sub(predictedPlayer.position).length();
        
        // Only log significant differences
        if (posDiff > 5.0 || Math.abs(serverVel - predictedVel) > 1.0) {
          console.log(`⚠️ Prediction error | Tick ${serverState.tick} | Pos diff: ${posDiff.toFixed(2)}u | Vel diff: ${Math.abs(serverVel - predictedVel).toFixed(2)} | Server vel: (${serverPlayer.velocity.x.toFixed(2)}, ${serverPlayer.velocity.y.toFixed(2)}) = ${serverVel.toFixed(2)} | Predicted vel: (${predictedPlayer.velocity.x.toFixed(2)}, ${predictedPlayer.velocity.y.toFixed(2)}) = ${predictedVel.toFixed(2)}`);
        }
      }
      
      // Compare server state with our prediction at the same tick
      if (this.statesDiffer(serverState, predictionState.worldState)) {
        console.log(`🔄 Server correction detected at tick ${serverState.tick}`);
        this.scheduleRollback(serverState.tick);
      }
    }
    
    // Clean up old prediction states
    this.cleanupOldStates(serverState.tick);
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
    
    // Debug log occasionally to confirm interpolation is happening
    if (Math.random() < 0.002) { // ~0.2% chance per frame = once every few seconds
      console.log(`🔄 Interpolating: alpha=${clampedAlpha.toFixed(3)}, from tick ${fromState.worldState.tick} to ${toState.worldState.tick}`);
    }
    
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
    
    // DEBUG: Log enhanced movement data from server (sample rate to avoid spam)
    if (Math.random() < 0.05 && worldState.players.length > 0) { // 5% sample rate
      const player = worldState.players[0];
      if (player.isMoving !== undefined || player.movementDirection !== undefined) {
        console.log(`📊 Server Player State - Velocity: (${player.velocity.x.toFixed(2)}, ${player.velocity.y.toFixed(2)}), ` +
                    `isMoving: ${player.isMoving}, ` +
                    `movementDir: ${player.movementDirection ? `(${player.movementDirection.x.toFixed(2)}, ${player.movementDirection.y.toFixed(2)})` : 'N/A'}`);
      }
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
    
    // DEBUG: Log ship count mismatch
    if (fromShips.length !== toShips.length) {
      console.warn(`⚠️ Ship count mismatch! From: ${fromShips.length}, To: ${toShips.length}`);
    }
    
    for (const toShip of toShips) {
      const fromShip = fromShips.find(s => s.id === toShip.id);
      
      if (!fromShip) {
        console.warn(`⚠️ Ship ${toShip.id} missing in from state - can't interpolate, using toShip directly`);
        result.push(toShip);
        continue;
      }
      
      const interpolated = {
        ...toShip,
        position: this.lerpVec2(fromShip.position, toShip.position, alpha),
        velocity: this.lerpVec2(fromShip.velocity, toShip.velocity, alpha),
        rotation: this.lerpAngle(fromShip.rotation, toShip.rotation, alpha),
        angularVelocity: fromShip.angularVelocity + (toShip.angularVelocity - fromShip.angularVelocity) * alpha
      };
      
      // Log interpolated ship state occasionally
      if (Math.random() < 0.02) { // 2% sample
        console.log(`🚢 Ship ${toShip.id} interpolated (α=${alpha.toFixed(3)}) | From pos: (${fromShip.position.x.toFixed(1)}, ${fromShip.position.y.toFixed(1)}) rot: ${fromShip.rotation.toFixed(2)} | To pos: (${toShip.position.x.toFixed(1)}, ${toShip.position.y.toFixed(1)}) rot: ${toShip.rotation.toFixed(2)} | Result pos: (${interpolated.position.x.toFixed(1)}, ${interpolated.position.y.toFixed(1)}) rot: ${interpolated.rotation.toFixed(2)}`);
      }
      
      result.push(interpolated);
    }
    
    return result;
  }
  
  /**
   * Interpolate player positions
   */
  private interpolatePlayers(fromPlayers: any[], toPlayers: any[], alpha: number): any[] {
    const result = [];
    
    for (const toPlayer of toPlayers) {
      const fromPlayer = fromPlayers.find(p => p.id === toPlayer.id);
      
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
   * Interpolate cannonball positions
   */
  private interpolateCannonballs(fromBalls: any[], toBalls: any[], alpha: number): any[] {
    const result = [];
    
    for (const toBall of toBalls) {
      const fromBall = fromBalls.find(b => b.id === toBall.id);
      
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
    // Run one step of client-side simulation
    return simulate(worldState, inputFrame, deltaTime);
  }
  
  private storePredictionState(tick: number, worldState: WorldState, inputFrame: InputFrame): void {
    const state: PredictionState = {
      tick,
      worldState: this.cloneWorldState(worldState),
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
  
  private statesDiffer(state1: WorldState, state2: WorldState): boolean {
    // Compare key aspects of world state to detect meaningful differences
    
    // Compare player positions (most important for prediction)
    if (state1.players.length !== state2.players.length) return true;
    
    for (let i = 0; i < state1.players.length; i++) {
      const player1 = state1.players[i];
      const player2 = state2.players[i];
      
      if (!player1 || !player2) return true;
      
      // Check position difference with velocity-based tolerance
      const positionDiff = player1.position.sub(player2.position).length();
      
      // Check velocity difference (important for detecting input desync)
      const velocityDiff = player1.velocity.sub(player2.velocity).length();
      
      // Higher tolerance for moving players to prevent choppy rendering
      const velocity1 = player1.velocity.length();
      const velocity2 = player2.velocity.length();
      const isMoving = velocity1 > 0.1 || velocity2 > 0.1;
      
      // Dynamic tolerance based on movement state
      const baseTolerance = this.config.predictionErrorThreshold; // 5.0 units
      const movementTolerance = isMoving ? baseTolerance * 2.0 : baseTolerance; // Double when moving
      
      // Trigger rollback if EITHER position OR velocity differs significantly
      // Velocity threshold of 10.0 units/s to avoid constant corrections during normal deceleration
      // (input lag causes ~7 units/s difference during stop, which is acceptable)
      if (positionDiff > movementTolerance || velocityDiff > 10.0) {
        return true;
      }
      
      // Check other important player state
      if (player1.onDeck !== player2.onDeck || 
          player1.carrierId !== player2.carrierId) {
        return true;
      }
    }
    
    // Compare ship positions
    if (state1.ships.length !== state2.ships.length) return true;
    
    for (let i = 0; i < state1.ships.length; i++) {
      const ship1 = state1.ships[i];
      const ship2 = state2.ships[i];
      
      if (!ship1 || !ship2) return true;
      
      const positionDiff = ship1.position.sub(ship2.position).length();
      if (positionDiff > 5.0) { // Increased from 2.0 to 5.0 units tolerance for ships
        return true;
      }
    }
    
    // States are similar enough
    return false;
  }
  
  private scheduleRollback(fromTick: number): void {
    this.needsRollback = true;
    this.rollbackTick = fromTick;
  }
  
  private performRollback(currentPredictedState: WorldState, deltaTime: number): WorldState {
    if (!this.authoritativeState) {
      this.needsRollback = false;
      return currentPredictedState;
    }
    
    console.log(`🎬 Performing rollback from tick ${this.rollbackTick} WITH SMOOTHING`);
    
    // Start from authoritative state
    let correctedState = this.cloneWorldState(this.authoritativeState);
    
    // Re-simulate all inputs from rollback point to current
    const rollbackStates = this.predictionHistory.filter(
      state => state.tick > this.rollbackTick && state.tick <= this.clientTick
    );
    
    for (const state of rollbackStates) {
      correctedState = this.simulateStep(correctedState, state.inputFrame, deltaTime);
    }
    
    // Apply smooth correction instead of instant snap
    // Blend between current prediction and corrected state for smoother visual result
    const smoothingFactor = 0.15; // 15% towards correction per frame for gentler corrections
    const blendedState = this.blendWorldStates(currentPredictedState, correctedState, smoothingFactor);
    
    console.log(`🔄 Smoothed correction: ${smoothingFactor * 100}% blend applied`);
    
    // Update prediction history with corrected states
    this.updatePredictionHistory(rollbackStates, blendedState);
    
    this.needsRollback = false;
    return blendedState;
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
      carrierDetection: to.carrierDetection,
    };
  }
  
  private updatePredictionHistory(rollbackStates: PredictionState[], finalState: WorldState): void {
    // Update stored states with corrected predictions
    // This is a simplified implementation - real version would update each intermediate state
    if (rollbackStates.length > 0) {
      const lastState = rollbackStates[rollbackStates.length - 1];
      lastState.worldState = this.cloneWorldState(finalState);
    }
  }
  
  private cleanupOldStates(currentTick: number): void {
    // Remove prediction states older than rollback limit
    const minTick = currentTick - this.config.rollbackLimit;
    this.predictionHistory = this.predictionHistory.filter(
      state => state.tick >= minTick
    );
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
      worldState: this.cloneWorldState(worldState),
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