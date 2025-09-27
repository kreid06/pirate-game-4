/**
 * Client-Side Prediction Engine
 * 
 * Handles client-side prediction for responsive gameplay while maintaining
 * server authority. Runs at 120Hz for smooth input response.
 */

import { PredictionConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame } from '../sim/Types.js';
import { simulate } from '../sim/Physics.js';

/**
 * Prediction state entry
 */
interface PredictionState {
  tick: number;
  worldState: WorldState;
  inputFrame: InputFrame;
  timestamp: number;
}

/**
 * Client-side prediction engine
 */
export class PredictionEngine {
  private config: PredictionConfig;
  
  // Prediction state history
  private predictionHistory: PredictionState[] = [];
  private authoritativeState: WorldState | null = null;
  private lastAuthoritativeTick = 0;
  
  // Timing
  private clientTick = 0;
  
  // Rollback and correction
  private needsRollback = false;
  private rollbackTick = 0;
  
  constructor(config: PredictionConfig) {
    this.config = config;
  }
  
  /**
   * Update prediction with new input
   */
  update(baseWorldState: WorldState, inputFrame: InputFrame, deltaTime: number): WorldState {
    this.clientTick++;
    
    // Store input frame for potential rollback
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
      inputFrame: { ...inputFrame },
      timestamp: Date.now()
    };
    
    this.predictionHistory.push(state);
    
    // Limit history size
    const maxHistorySize = this.config.rollbackLimit + 10;
    if (this.predictionHistory.length > maxHistorySize) {
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
        position: ship.position.clone(),
        velocity: ship.velocity.clone(),
        hull: ship.hull.map(point => point.clone()),
        modules: ship.modules.map(module => ({ ...module }))
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
        smokeTrail: ball.smokeTrail ? ball.smokeTrail.map(smoke => ({
          ...smoke,
          position: smoke.position.clone()
        })) : []
      })),
      carrierDetection: new Map(worldState.carrierDetection)
    };
  }
}