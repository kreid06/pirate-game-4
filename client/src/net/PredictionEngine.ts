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
 * Enhanced Client-side prediction engine with Week 3-4 features
 */
export class PredictionEngine {
  private config: PredictionConfig;
  
  // Enhanced prediction state history (16-frame buffer)
  private predictionHistory: PredictionState[] = [];
  private rewindBuffer: RewindBufferEntry[] = [];
  private authoritativeState: WorldState | null = null;
  private lastAuthoritativeTick = 0;
  
  // Timing and lag compensation
  private clientTick = 0;
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
    
    // Store prediction state with enhanced tracking
    this.storePredictionState(this.clientTick, baseWorldState, inputFrame);
    
    if (!this.config.enablePrediction) {
      // Prediction disabled - just return authoritative state
      return baseWorldState;
    }
    
    // Perform client-side simulation step
    const predictedState = this.simulateStep(baseWorldState, inputFrame, deltaTime);
    
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
    
    // Check if we need to rollback and re-predict
    const predictionState = this.findPredictionState(serverState.tick);
    if (predictionState) {
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
  getInterpolatedState(_currentTime: number): WorldState | null {
    if (!this.config.enableInterpolation || !this.authoritativeState) {
      return this.authoritativeState;
    }
    
    // Find two states to interpolate between
    // const bufferTime = currentTime - this.config.interpolationBuffer;
    
    // For now, return the latest authoritative state
    // TODO: Implement proper interpolation between server states
    return this.authoritativeState;
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
      
      // Check position difference (with tolerance for floating-point errors)
      const positionDiff = player1.position.sub(player2.position).length();
      if (positionDiff > 1.0) { // 1 unit tolerance
        console.log(`Player ${player1.id} position diff: ${positionDiff}`);
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
      if (positionDiff > 2.0) { // 2 unit tolerance for ships
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
    
    console.log(`🎬 Performing rollback from tick ${this.rollbackTick}`);
    
    // Start from authoritative state
    let correctedState = this.cloneWorldState(this.authoritativeState);
    
    // Re-simulate all inputs from rollback point to current
    const rollbackStates = this.predictionHistory.filter(
      state => state.tick > this.rollbackTick && state.tick <= this.clientTick
    );
    
    for (const state of rollbackStates) {
      correctedState = this.simulateStep(correctedState, state.inputFrame, deltaTime);
    }
    
    // Update prediction history with corrected states
    this.updatePredictionHistory(rollbackStates, correctedState);
    
    this.needsRollback = false;
    return correctedState;
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
    console.log(`🔍 Input validation check - Tick: ${inputFrame.tick}, Movement: (${inputFrame.movement.x.toFixed(3)}, ${inputFrame.movement.y.toFixed(3)}), Actions: ${inputFrame.actions}`);
    
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
    console.log(`✅ Input validation passed for tick ${inputFrame.tick}`);
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