import { Vec2 } from '../common/Vec2.js';
import { ShipModule } from './modules.js';
import { CarrierDetectionState } from './CarrierDetection.js';

/**
 * Player input frame for deterministic simulation
 */
export interface InputFrame {
  tick: number;
  movement: Vec2; // Movement vector (normalized, in world coordinates)
  rotation: number; // Player aim direction in radians (for server protocol)
  actions: number; // Bitmask for actions
}

/**
 * Ship state for carrier physics
 */
export interface Ship {
  id: number;
  position: Vec2;
  rotation: number; // radians
  velocity: Vec2;
  angularVelocity: number; // rad/s
  hull: Vec2[]; // Polygon in ship-local coordinates for collision detection
  modules: ShipModule[]; // Modules placed on this ship (including deck module)
}

/**
 * Player state
 */
export interface Player {
  id: number;
  name?: string; // Player name from server
  position: Vec2;
  velocity: Vec2;
  rotation: number; // Facing direction in radians (from mouse aim)
  radius: number;
  carrierId: number; // 0 = not on ship
  deckId: number;
  onDeck: boolean;
  
  // Enhanced movement data from server (for reconciliation & debugging)
  isMoving?: boolean; // Is player actively moving (from hybrid protocol)
  movementDirection?: Vec2; // Server's stored movement direction (normalized)
}

/**
 * Cannonball projectile state
 */
export interface Cannonball {
  id: number;
  position: Vec2;
  velocity: Vec2;
  firingVelocity: Vec2; // Original firing velocity (without ship inheritance)
  radius: number;
  maxRange: number;
  distanceTraveled: number;
  timeAlive: number; // Time since firing (seconds)
  firedFrom: number; // ship id that fired this cannonball
  smokeTrail: Array<{
    position: Vec2;
    age: number; // 0 to 1, where 1 is fully faded
    maxAge: number;
  }>;
}

/**
 * Complete world state for deterministic simulation
 */
export interface WorldState {
  tick: number;
  ships: Ship[];
  players: Player[];
  cannonballs: Cannonball[];
  timestamp: number;
  // Phase 2: Add carrier detection state per player
  carrierDetection: Map<number, CarrierDetectionState>; // playerId -> detection state
}

/**
 * Physics configuration constants
 */
export const PhysicsConfig = {
  SIM_TICK_RATE: 60, // Hz (increased from 30 for smoother simulation)
  SNAPSHOT_RATE: 15, // Hz
  INTERP_BUFFER_MS: 120,
  
  // Edge tolerance
  EPS_FACTOR: 0.03, // * playerRadius
  
  // Hysteresis for on-ship detection
  N_IN: 3,  // ticks to confirm on-ship
  N_OUT: 8, // ticks to confirm off-ship
  SWITCH_COOLDOWN_MS: 200,
  
  // History for replays
  HISTORY_TICKS: 20, // ~667 ms at 30 Hz
  
  // Ice-drift damping
  ICE_DRIFT_HALF_LIFE: 0.35, // seconds
  
  // Player movement
  PLAYER_SPEED: 200, // units/second
  PLAYER_RADIUS: 8,
  
  // Cannonball physics
  CANNONBALL_SPEED: 400, // units/second
  CANNONBALL_RANGE: 800, // units
  CANNONBALL_RADIUS: 8, // bigger cannonballs for better visibility
  CANNONBALL_RELOAD_TIME: 3.0, // seconds to reload after firing
  SPLASH_RADIUS: 50, // splash effect radius
} as const;
