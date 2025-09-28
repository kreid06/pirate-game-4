/**
 * Enhanced Client-Side Prediction Engine - Week 3-4 Integration
 * 
 * Complete client-side prediction system with server reconciliation:
 * - Input prediction and rollback/replay
 * - Server authoritative state reconciliation  
 * - Lag compensation with rewind buffer
 * - Smooth interpolation for rendering
 * - Anti-cheat client-side validation
 */

import { PredictionConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame, Player, Ship } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';
import { simulate } from '../sim/Physics.js';

/**
 * Server protocol packet structures
 */
export interface ServerSnapshot {
  type: 'snapshot';
  tick: number;
  timestamp: number;
  entities: Array<{
    id: number;
    type: 'ship' | 'player' | 'projectile';
    position: { x: number; y: number };
    velocity: { x: number; y: number };
    rotation?: number;
    health?: number;
    state?: number;
  }>;
}

export interface InputPacket {
  type: 'input';
  clientId: number;
  sequence: number;
  clientTime: number;
  movement: { x: number; y: number };
  actions: number;
  deltaTime: number;
}

/**
 * Client prediction state with full context
 */
interface ClientPredictionState {
  // Timing
  clientTick: number;
  serverTick: number;
  timestamp: number;
  deltaTime: number;
  
  // World state at this tick
  worldState: WorldState;
  inputFrame: InputFrame;
  
  // Network context
  networkDelay: number;
  serverConfirmed: boolean;
  predictionError: number;
  
  // Validation
  inputSequence: number;
  checksumSent: boolean;
}

/**
 * Interpolation state for smooth rendering
 */
interface InterpolationState {
  from: WorldState;
  to: WorldState;
  alpha: number;
  timestamp: number;
}

/**
 * Enhanced prediction metrics
 */
export interface EnhancedPredictionMetrics {
  // Core prediction stats
  rollbacksPerformed: number;
  averagePredictionError: number;
  maxPredictionError: number;
  correctionsApplied: number;
  
  // Network compensation
  averageNetworkDelay: number;
  maxNetworkDelay: number;
  packetsReceived: number;
  packetsLost: number;
  
  // Input validation (client-side)
  inputsGenerated: number;
  inputsDiscarded: number;
  inputRateViolations: number;
  movementAnomalies: number;
  
  // Performance
  averageSimulationTime: number;
  maxSimulationTime: number;
  bufferUtilization: number;
}

/**
 * Enhanced Client-Side Prediction Engine
 */
export class EnhancedPredictionEngine {
  private config: PredictionConfig;
  
  // Prediction state management
  private predictionBuffer: ClientPredictionState[] = [];
  private currentClientTick = 0;
  private lastServerTick = 0;
  private lastServerTimestamp = 0;
  
  // Network timing
  private networkDelay = 100; // Default 100ms
  private clockOffset = 0;
  private jitter = 0;
  
  // Interpolation
  private interpolationBuffer: WorldState[] = [];
  private renderState: InterpolationState | null = null;
  
  // Input management  
  private pendingInputs: InputPacket[] = [];
  private inputSequence = 0;
  private lastConfirmedInput = 0;
  
  // Rollback state
  private needsRollback = false;
  private rollbackToTick = 0;
  private rollbackReason = '';
  
  // Metrics and validation
  private metrics: EnhancedPredictionMetrics = {
    rollbacksPerformed: 0,
    averagePredictionError: 0,
    maxPredictionError: 0,
    correctionsApplied: 0,
    averageNetworkDelay: 100,
    maxNetworkDelay: 100,
    packetsReceived: 0,
    packetsLost: 0,
    inputsGenerated: 0,
    inputsDiscarded: 0,
    inputRateViolations: 0,
    movementAnomalies: 0,
    averageSimulationTime: 0,
    maxSimulationTime: 0,
    bufferUtilization: 0
  };
  
  // Constants
  private static readonly PREDICTION_BUFFER_SIZE = 64; // 2+ seconds at 30Hz
  private static readonly INTERPOLATION_BUFFER_SIZE = 8;  
  private static readonly MAX_ROLLBACK_FRAMES = 32;
  private static readonly INPUT_RATE_LIMIT_MS = 8.33; // 120Hz max
  
  // Static input validation state
  private static lastInputTime = 0;
  
  constructor(config: PredictionConfig) {
    this.config = config;
    this.initializeSystem();
  }
  
  /**
   * Initialize the prediction system
   */
  private initializeSystem(): void {
    this.predictionBuffer = [];
    this.interpolationBuffer = [];
    this.pendingInputs = [];
    this.renderState = null;
    
    console.log('🎯 Enhanced Prediction Engine initialized');
    console.log(`   Buffer size: ${EnhancedPredictionEngine.PREDICTION_BUFFER_SIZE} frames`);
    console.log(`   Max rollback: ${EnhancedPredictionEngine.MAX_ROLLBACK_FRAMES} frames`);
    console.log(`   Input rate limit: ${EnhancedPredictionEngine.INPUT_RATE_LIMIT_MS}ms`);
  }
  
  /**
   * Main prediction update - called every client frame
   */
  public update(currentWorldState: WorldState, inputFrame: InputFrame, deltaTime: number): WorldState {
    const startTime = performance.now();
    
    this.currentClientTick++;
    this.inputSequence++;
    
    // Validate input before processing
    if (!this.validateClientInput(inputFrame)) {
      this.metrics.inputsDiscarded++;
      // Use last valid input or neutral input
      inputFrame = this.getLastValidInput() || this.createNeutralInput();
    } else {
      this.metrics.inputsGenerated++;
    }
    
    // Create input packet for server
    const inputPacket = this.createInputPacket(inputFrame, deltaTime);
    this.pendingInputs.push(inputPacket);
    
    // Trim pending inputs buffer
    if (this.pendingInputs.length > 60) { // 2 seconds worth
      this.pendingInputs = this.pendingInputs.slice(-60);
    }
    
    // Perform rollback if needed
    if (this.needsRollback) {
      currentWorldState = this.performRollbackAndReplay(currentWorldState, deltaTime);
    }
    
    // Run client-side prediction
    const predictedState = this.runPredictionStep(currentWorldState, inputFrame, deltaTime);
    
    // Store prediction state  
    this.storePredictionState(predictedState, inputFrame, deltaTime);
    
    // Update metrics
    const simulationTime = performance.now() - startTime;
    this.updatePerformanceMetrics(simulationTime);
    
    return predictedState;
  }
  
  /**
   * Handle authoritative state from server
   */
  public onServerSnapshot(snapshot: ServerSnapshot): void {
    this.metrics.packetsReceived++;
    
    // Update network timing
    this.updateNetworkTiming(snapshot);
    
    // Convert server snapshot to world state
    const serverState = this.convertSnapshotToWorldState(snapshot);
    
    // Add to interpolation buffer
    this.addToInterpolationBuffer(serverState);
    
    // Check for prediction errors and rollback
    this.checkPredictionAccuracy(serverState);
    
    // Confirm inputs that server has processed
    this.confirmProcessedInputs(snapshot.tick);
    
    this.lastServerTick = snapshot.tick;
    this.lastServerTimestamp = snapshot.timestamp;
  }
  
  /**
   * Get interpolated state for smooth rendering
   */
  public getInterpolatedState(renderTime: number): WorldState | null {
    if (!this.config.enableInterpolation || this.interpolationBuffer.length < 2) {
      return this.interpolationBuffer[this.interpolationBuffer.length - 1] || null;
    }
    
    // Calculate interpolation time (render behind server by buffer amount)
    const interpolationTime = renderTime - this.config.interpolationBuffer;
    
    // Find two states to interpolate between
    let fromState: WorldState | null = null;
    let toState: WorldState | null = null;
    
    for (let i = 0; i < this.interpolationBuffer.length - 1; i++) {
      const current = this.interpolationBuffer[i];
      const next = this.interpolationBuffer[i + 1];
      
      if (current.timestamp <= interpolationTime && interpolationTime <= next.timestamp) {
        fromState = current;
        toState = next;
        break;
      }
    }
    
    if (!fromState || !toState) {
      // Use latest state if no interpolation possible
      return this.interpolationBuffer[this.interpolationBuffer.length - 1] || null;
    }
    
    // Calculate interpolation alpha
    const totalTime = toState.timestamp - fromState.timestamp;
    const elapsedTime = interpolationTime - fromState.timestamp;
    const alpha = totalTime > 0 ? Math.min(1.0, elapsedTime / totalTime) : 0;
    
    // Perform interpolation
    return this.interpolateWorldStates(fromState, toState, alpha);
  }
  
  /**
   * Get pending input packet for network transmission
   */
  public getPendingInputPacket(): InputPacket | null {
    return this.pendingInputs.shift() || null;
  }
  
  /**
   * Get prediction statistics
   */
  public getMetrics(): EnhancedPredictionMetrics {
    // Calculate buffer utilization
    this.metrics.bufferUtilization = 
      (this.predictionBuffer.length / EnhancedPredictionEngine.PREDICTION_BUFFER_SIZE) * 100;
    
    return { ...this.metrics };
  }
  
  /**
   * Reset prediction engine state
   */
  public reset(): void {
    this.predictionBuffer = [];
    this.interpolationBuffer = [];
    this.pendingInputs = [];
    this.currentClientTick = 0;
    this.lastServerTick = 0;
    this.needsRollback = false;
    
    // Reset metrics
    this.metrics = {
      rollbacksPerformed: 0,
      averagePredictionError: 0,
      maxPredictionError: 0,
      correctionsApplied: 0,
      averageNetworkDelay: this.networkDelay,
      maxNetworkDelay: this.networkDelay,
      packetsReceived: 0,
      packetsLost: 0,
      inputsGenerated: 0,
      inputsDiscarded: 0,
      inputRateViolations: 0,
      movementAnomalies: 0,
      averageSimulationTime: 0,
      maxSimulationTime: 0,
      bufferUtilization: 0
    };
    
    console.log('🔄 Enhanced Prediction Engine reset');
  }
  
  // === PRIVATE IMPLEMENTATION === 
  
  private validateClientInput(inputFrame: InputFrame): boolean {
    // Rate limiting check
    const currentTime = Date.now();
    
    if (currentTime - EnhancedPredictionEngine.lastInputTime < EnhancedPredictionEngine.INPUT_RATE_LIMIT_MS) {
      this.metrics.inputRateViolations++;
      return false;
    }
    
    // Movement bounds checking  
    const movementMagnitude = inputFrame.movement.length();
    if (movementMagnitude > 1.5) { // Allow some tolerance
      this.metrics.movementAnomalies++;
      return false;
    }
    
    EnhancedPredictionEngine.lastInputTime = currentTime;
    return true;
  }
  
  private createInputPacket(inputFrame: InputFrame, deltaTime: number): InputPacket {
    return {
      type: 'input',
      clientId: 1, // TODO: Get from network manager
      sequence: this.inputSequence,
      clientTime: Date.now(),
      movement: { 
        x: inputFrame.movement.x, 
        y: inputFrame.movement.y 
      },
      actions: inputFrame.actions,
      deltaTime: deltaTime
    };
  }
  
  private runPredictionStep(worldState: WorldState, inputFrame: InputFrame, deltaTime: number): WorldState {
    if (!this.config.enablePrediction) {
      return worldState;
    }
    
    // Clone state for prediction
    const predictedState = this.cloneWorldState(worldState);
    
    // Run simulation step
    const simulatedState = simulate(predictedState, inputFrame, deltaTime);
    
    return simulatedState;
  }
  
  private storePredictionState(worldState: WorldState, inputFrame: InputFrame, deltaTime: number): void {
    const predictionState: ClientPredictionState = {
      clientTick: this.currentClientTick,
      serverTick: this.lastServerTick,
      timestamp: Date.now(),
      deltaTime,
      worldState: this.cloneWorldState(worldState),
      inputFrame: { ...inputFrame },
      networkDelay: this.networkDelay,
      serverConfirmed: false,
      predictionError: 0,
      inputSequence: this.inputSequence,
      checksumSent: false
    };
    
    this.predictionBuffer.push(predictionState);
    
    // Maintain buffer size
    if (this.predictionBuffer.length > EnhancedPredictionEngine.PREDICTION_BUFFER_SIZE) {
      this.predictionBuffer.shift();
    }
  }
  
  private performRollbackAndReplay(currentState: WorldState, deltaTime: number): WorldState {
    console.log(`🔄 Performing rollback to tick ${this.rollbackToTick} (${this.rollbackReason})`);
    
    this.metrics.rollbacksPerformed++;
    
    // Find rollback point
    const rollbackStateIndex = this.predictionBuffer.findIndex(
      state => state.clientTick === this.rollbackToTick
    );
    
    if (rollbackStateIndex === -1) {
      console.warn('❌ Could not find rollback state, using current state');
      this.needsRollback = false;
      return currentState;
    }
    
    // Get the corrected state from server
    const rollbackState = this.predictionBuffer[rollbackStateIndex];
    let replayState = this.cloneWorldState(rollbackState.worldState);
    
    // Replay all inputs from rollback point to current
    for (let i = rollbackStateIndex + 1; i < this.predictionBuffer.length; i++) {
      const state = this.predictionBuffer[i];
      replayState = simulate(replayState, state.inputFrame, state.deltaTime);
      
      // Update the stored prediction with corrected state
      this.predictionBuffer[i].worldState = this.cloneWorldState(replayState);
      this.predictionBuffer[i].serverConfirmed = false; // Mark as needing re-confirmation
    }
    
    this.needsRollback = false;
    return replayState;
  }
  
  private checkPredictionAccuracy(serverState: WorldState): void {
    // Find our predicted state at the same server tick
    const predictedState = this.predictionBuffer.find(
      state => state.serverTick === serverState.tick
    );
    
    if (!predictedState) {
      return; // No prediction to compare
    }
    
    // Calculate prediction error
    const error = this.calculateStateError(predictedState.worldState, serverState);
    
    if (error > this.config.predictionErrorThreshold) {
      console.log(`🚨 Large prediction error detected: ${error.toFixed(2)} units`);
      console.log(`   Server tick: ${serverState.tick}, Client tick: ${predictedState.clientTick}`);
      
      // Schedule rollback
      this.needsRollback = true;
      this.rollbackToTick = predictedState.clientTick;
      this.rollbackReason = `Prediction error: ${error.toFixed(2)}`;
      
      this.metrics.correctionsApplied++;
    }
    
    // Update error metrics
    this.updateErrorMetrics(error);
    
    // Mark prediction as confirmed by server
    predictedState.serverConfirmed = true;
    predictedState.predictionError = error;
  }
  
  private calculateStateError(predicted: WorldState, authoritative: WorldState): number {
    let maxError = 0;
    
    // Compare player positions (most important)
    for (const authPlayer of authoritative.players) {
      const predPlayer = predicted.players.find(p => p.id === authPlayer.id);
      if (predPlayer) {
        const positionError = authPlayer.position.distanceTo(predPlayer.position);
        maxError = Math.max(maxError, positionError);
      }
    }
    
    // Compare ship positions  
    for (const authShip of authoritative.ships) {
      const predShip = predicted.ships.find(s => s.id === authShip.id);
      if (predShip) {
        const positionError = authShip.position.distanceTo(predShip.position);
        maxError = Math.max(maxError, positionError);
      }
    }
    
    return maxError;
  }
  
  private updateNetworkTiming(snapshot: ServerSnapshot): void {
    const now = Date.now();
    const roundTripTime = now - snapshot.timestamp;
    
    // Update network delay (one-way)
    this.networkDelay = roundTripTime / 2;
    this.metrics.averageNetworkDelay = 
      (this.metrics.averageNetworkDelay * 0.9) + (this.networkDelay * 0.1);
    this.metrics.maxNetworkDelay = Math.max(this.metrics.maxNetworkDelay, this.networkDelay);
    
    // Update clock offset
    const serverTime = snapshot.timestamp + this.networkDelay;
    this.clockOffset = serverTime - now;
  }
  
  private convertSnapshotToWorldState(snapshot: ServerSnapshot): WorldState {
    // Convert server's compressed snapshot format to client WorldState
    const worldState: WorldState = {
      tick: snapshot.tick,
      timestamp: snapshot.timestamp,
      ships: [],
      players: [],
      cannonballs: [],
      carrierDetection: new Map()
    };
    
    // Convert entities
    for (const entity of snapshot.entities) {
      switch (entity.type) {
        case 'ship':
          worldState.ships.push({
            id: entity.id,
            position: new Vec2(entity.position.x, entity.position.y),
            velocity: new Vec2(entity.velocity.x, entity.velocity.y),
            rotation: entity.rotation || 0,
            angularVelocity: 0, // TODO: Get from server data
            hull: [], // TODO: Get from entity data
            modules: []
          } as Ship);
          break;
          
        case 'player':
          worldState.players.push({
            id: entity.id,
            position: new Vec2(entity.position.x, entity.position.y),
            velocity: new Vec2(entity.velocity.x, entity.velocity.y),
            onDeck: true, // TODO: Get from state flags
            carrierId: 0 // TODO: Get from entity data
          } as Player);
          break;
          
        case 'projectile':
          worldState.cannonballs.push({
            id: entity.id,
            position: new Vec2(entity.position.x, entity.position.y),
            velocity: new Vec2(entity.velocity.x, entity.velocity.y),
            firingVelocity: new Vec2(entity.velocity.x, entity.velocity.y),
            radius: 2, // Default cannonball radius
            maxRange: 1000, // Default max range
            distanceTraveled: 0, // TODO: Calculate from server data
            timeAlive: 0, // TODO: Calculate from server data
            firedFrom: 0, // TODO: Get from server data
            smokeTrail: []
          });
          break;
      }
    }
    
    return worldState;
  }
  
  private addToInterpolationBuffer(worldState: WorldState): void {
    this.interpolationBuffer.push(worldState);
    
    // Maintain buffer size
    if (this.interpolationBuffer.length > EnhancedPredictionEngine.INTERPOLATION_BUFFER_SIZE) {
      this.interpolationBuffer.shift();
    }
    
    // Sort by timestamp to handle out-of-order packets
    this.interpolationBuffer.sort((a, b) => a.timestamp - b.timestamp);
  }
  
  private interpolateWorldStates(from: WorldState, to: WorldState, alpha: number): WorldState {
    const interpolated: WorldState = {
      tick: to.tick,
      timestamp: from.timestamp + (to.timestamp - from.timestamp) * alpha,
      ships: [],
      players: [],
      cannonballs: [],
      carrierDetection: new Map()
    };
    
    // Interpolate ships
    for (const toShip of to.ships) {
      const fromShip = from.ships.find(s => s.id === toShip.id);
      if (fromShip) {
        interpolated.ships.push({
          ...toShip,
          position: fromShip.position.lerp(toShip.position, alpha),
          velocity: fromShip.velocity.lerp(toShip.velocity, alpha),
          rotation: this.lerpAngle(fromShip.rotation, toShip.rotation, alpha)
        });
      } else {
        interpolated.ships.push(toShip);
      }
    }
    
    // Interpolate players
    for (const toPlayer of to.players) {
      const fromPlayer = from.players.find(p => p.id === toPlayer.id);
      if (fromPlayer) {
        interpolated.players.push({
          ...toPlayer,
          position: fromPlayer.position.lerp(toPlayer.position, alpha),
          velocity: fromPlayer.velocity.lerp(toPlayer.velocity, alpha)
        });
      } else {
        interpolated.players.push(toPlayer);
      }
    }
    
    // For projectiles, don't interpolate (too fast-moving)
    interpolated.cannonballs = [...to.cannonballs];
    
    return interpolated;
  }
  
  private lerpAngle(from: number, to: number, alpha: number): number {
    // Handle angle wrapping
    let diff = to - from;
    if (diff > Math.PI) diff -= 2 * Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    return from + diff * alpha;
  }
  
  private confirmProcessedInputs(serverTick: number): void {
    // Mark all inputs up to server tick as confirmed
    for (const state of this.predictionBuffer) {
      if (state.serverTick <= serverTick) {
        state.serverConfirmed = true;
      }
    }
    
    this.lastConfirmedInput = serverTick;
  }
  
  private updateErrorMetrics(error: number): void {
    this.metrics.averagePredictionError = 
      (this.metrics.averagePredictionError * 0.95) + (error * 0.05);
    this.metrics.maxPredictionError = Math.max(this.metrics.maxPredictionError, error);
  }
  
  private updatePerformanceMetrics(simulationTime: number): void {
    this.metrics.averageSimulationTime = 
      (this.metrics.averageSimulationTime * 0.95) + (simulationTime * 0.05);
    this.metrics.maxSimulationTime = Math.max(this.metrics.maxSimulationTime, simulationTime);
  }
  
  private cloneWorldState(worldState: WorldState): WorldState {
    return {
      tick: worldState.tick,
      timestamp: worldState.timestamp,
      ships: worldState.ships.map(ship => ({
        ...ship,
        position: ship.position.clone(),
        velocity: ship.velocity.clone(),
        hull: ship.hull.map(point => point.clone()),
        modules: [...ship.modules]
      })),
      players: worldState.players.map(player => ({
        ...player,
        position: player.position.clone(),
        velocity: player.velocity.clone()
      })),
      cannonballs: worldState.cannonballs.map(ball => ({
        ...ball,
        position: ball.position.clone(),
        velocity: ball.velocity.clone(),
        firingVelocity: ball.firingVelocity.clone(),
        smokeTrail: ball.smokeTrail?.map(smoke => ({
          ...smoke,
          position: smoke.position.clone()
        })) || []
      })),
      carrierDetection: new Map(worldState.carrierDetection)
    };
  }
  
  private getLastValidInput(): InputFrame | null {
    for (let i = this.predictionBuffer.length - 1; i >= 0; i--) {
      const state = this.predictionBuffer[i];
      if (state.inputFrame) {
        return { ...state.inputFrame };
      }
    }
    return null;
  }
  
  private createNeutralInput(): InputFrame {
    return {
      tick: this.currentClientTick,
      movement: Vec2.zero(),
      actions: 0
    };
  }
}