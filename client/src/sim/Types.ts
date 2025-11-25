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
  
  // Brigantine physics properties (from server or ship definitions)
  mass: number;              // kg
  momentOfInertia: number;   // kg⋅m²
  maxSpeed: number;          // m/s - velocity magnitude limit
  turnRate: number;          // rad/s - angular velocity limit
  waterDrag: number;         // 0-1 coefficient (multiply velocity each frame)
  angularDrag: number;       // 0-1 coefficient (multiply angular velocity each frame)
}

/**
 * Player state
 */
export interface Player {
  id: number;
  name?: string; // Player name from server
  position: Vec2; // World position
  velocity: Vec2;
  rotation: number; // Facing direction in radians (from mouse aim)
  radius: number;
  carrierId: number; // 0 = not on ship (parent_ship from server)
  deckId: number;
  onDeck: boolean;
  
  // Local (ship-relative) position - used when on a ship
  localPosition?: Vec2; // Position relative to ship (local_x, local_y from server)
  
  // Module mounting state
  isMounted: boolean; // Is player mounted to a module
  mountedModuleId?: number; // ID of mounted module (helm, cannon, seat, etc.)
  mountOffset?: Vec2; // Offset from module position (e.g., {x: -10, y: 0} for helm)
  
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
  
  // Player movement speeds
  PLAYER_WALK_SPEED: 1000, // units/second when walking on ship (5x faster: 200 * 5)
  PLAYER_SWIM_SPEED: 140, // units/second when swimming (unchanged)
  PLAYER_SPEED: 200, // Deprecated - use WALK_SPEED or SWIM_SPEED
  PLAYER_RADIUS: 8, // Match server radius for collision detection
  
  // Cannonball physics
  CANNONBALL_SPEED: 400, // units/second
  CANNONBALL_RANGE: 800, // units
  CANNONBALL_RADIUS: 8, // bigger cannonballs for better visibility
  CANNONBALL_RELOAD_TIME: 3.0, // seconds to reload after firing
  SPLASH_RADIUS: 50, // splash effect radius
} as const;
