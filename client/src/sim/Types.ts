import { Vec2 } from '../common/Vec2.js';
import { ShipModule } from './modules.js';
import { CarrierDetectionState } from './CarrierDetection.js';
import { PlayerInventory } from './Inventory.js';

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
  rudderAngle: number;       // Radians - visual indicator for turning (-π/4 to π/4)

  // Ship-level ammunition
  cannonAmmo: number;        // Remaining cannonballs (shared pool)
  infiniteAmmo: boolean;     // When true, cannons never run out

  // Hull integrity / water ingress (0–100; 100 = intact, 0 = sinking)
  hullHealth: number;

  // Company/faction (COMPANY_* constants)
  companyId: number;

  // Ship type (SHIP_TYPE_* constants); used for spectral/ghost rendering
  shipType: number;

  // Ship progression (from server levelStats; optional until server sends it)
  levelStats?: ShipLevelStats;
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

  // Inventory
  inventory: PlayerInventory;

  // Company/faction (COMPANY_* constants)
  companyId: number;

  // Health
  health: number;      // current HP
  maxHealth: number;   // max HP (default 100)

  // Island presence (0 = not on island)
  onIslandId: number;
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
  /** 0 = cannonball (default), 1 = bar shot */
  ammoType: number;
  smokeTrail: Array<{
    position: Vec2;
    age: number; // 0 to 1, where 1 is fully faded
    maxAge: number;
  }>;
}

/**
 * A structure placed on an island by a player.
 */
export interface PlacedStructure {
  id: number;
  type: 'wooden_floor' | 'workbench';
  islandId: number;
  x: number;
  y: number;
  companyId: number;  // COMPANY_* — faction that owns this structure (0 = neutral)
  hp: number;         // current hit points
  maxHp: number;      // maximum hit points
}

// Company identifiers (mirror server COMPANY_* constants)
export const COMPANY_NEUTRAL = 0;
export const COMPANY_PIRATES = 1;
export const COMPANY_NAVY    = 2;
export const COMPANY_GHOST   = 99; // Phantom Brig faction — hostile to all

// Ship type identifiers (mirror server SHIP_TYPE_* constants)
export const SHIP_TYPE_BRIGANTINE = 3;
export const SHIP_TYPE_GHOST      = 99; // Ghostship — autonomous enemy, spectral visual

// ─── Ship levelling ───────────────────────────────────────────────────────────

/** Mirrors server ShipAttribute enum (ship_level.h) */
export const SHIP_ATTR_WEIGHT     = 0;
export const SHIP_ATTR_RESISTANCE = 1;
export const SHIP_ATTR_DAMAGE     = 2;
export const SHIP_ATTR_CREW       = 3;
export const SHIP_ATTR_STURDINESS = 4;
export const SHIP_ATTR_COUNT      = 5;

/** Hard limits (mirrors ship_level.h constants) */
export const SHIP_LEVEL_ATTR_POINT_CAP  = 50;
export const SHIP_LEVEL_TOTAL_POINT_CAP = 65;
export const SHIP_LEVEL_XP_BASE         = 100;

/** Per-attribute point caps (mirrors SHIP_ATTR_POINTS_* constants) */
export const SHIP_ATTR_CAPS: Record<number, number> = {
  [SHIP_ATTR_WEIGHT]:     50,
  [SHIP_ATTR_RESISTANCE]: 35,
  [SHIP_ATTR_DAMAGE]:     35,
  [SHIP_ATTR_CREW]:       50,
  [SHIP_ATTR_STURDINESS]: 25,
};

export const SHIP_ATTR_NAMES: Record<number, string> = {
  [SHIP_ATTR_WEIGHT]:     'Weight',
  [SHIP_ATTR_RESISTANCE]: 'Resistance',
  [SHIP_ATTR_DAMAGE]:     'Cannon Dmg',
  [SHIP_ATTR_CREW]:       'Crew Cap',
  [SHIP_ATTR_STURDINESS]: 'Sturdiness',
};

export const SHIP_ATTR_DESC: Record<number, string> = {
  [SHIP_ATTR_WEIGHT]:     '+5% hull mass/lvl (WIP)',
  [SHIP_ATTR_RESISTANCE]: '−2% dmg taken/lvl  →  floor 30%',
  [SHIP_ATTR_DAMAGE]:     '+4% cannon dmg/lvl  →  ceil 240%',
  [SHIP_ATTR_CREW]:       '+2 max crew/lvl (WIP)',
  [SHIP_ATTR_STURDINESS]: '−3% sink rate/lvl  →  floor 25%',
};

/**
 * Mirrors server ShipLevelStats (ship_level.h).
 * Received in every ship world-state snapshot under `levelStats`.
 */
export interface ShipLevelStats {
  /** Current level (1 = baseline) for each attribute, indexed by SHIP_ATTR_* */
  levels: number[];   // length 5
  /** Unspent XP pool */
  xp: number;
  /** Pre-computed max crew from server */
  maxCrew: number;
  /** Ship level = sum of all points spent across all attributes (= sum of levels[i] − 1) */
  shipLevel: number;
  /** Cap for total ship level (= SHIP_LEVEL_TOTAL_POINT_CAP) */
  totalCap: number;
  /**
   * Unified cost for the NEXT upgrade of ANY attribute at the current ship level.
   * Formula: XP_BASE * (shipLevel + 1).  0 when fully capped.
   */
  nextUpgradeCost: number;
  /** Per-attribute point caps sent by server */
  attrCaps: number[];  // length 5
}

// All NPCs are sailors for now — company/alliance system will handle friend/foe later.
// NPC_TYPE_SAILOR is always 0 from the server; kept for future protocol compatibility.
export const NPC_TYPE_SAILOR = 0;

// NPC movement/AI state (mirrors server WorldNpcState enum)
export const NPC_STATE_IDLE      = 0;
export const NPC_STATE_MOVING    = 1;
export const NPC_STATE_AT_GUN    = 2;
/** @deprecated use NPC_STATE_AT_GUN */
export const NPC_STATE_AT_CANNON = 2;
export const NPC_STATE_REPAIRING = 3;

/**
 * Visible world NPC entity (sailor crew member)
 */
export interface Npc {
  id: number;
  name: string;
  type: number;           // Always NPC_TYPE_SAILOR (0) for now
  position: Vec2;         // World position (fallback when not on a ship)
  localPosition: Vec2;    // Ship-local position in client pixels (used when shipId != 0)
  rotation: number;       // Facing direction in radians
  interactRadius: number; // Distance within which the player can press E
  shipId: number;         // 0 = free-standing in the world
  state: number;          // NPC_STATE_* — used for movement animation
  role: number;           // NPC_ROLE_* — 1=gunner, 3=rigger
  companyId: number;      // COMPANY_* — faction this NPC belongs to
  assignedWeaponId: number; // Module ID of cannon/swivel/mast this NPC is stationed at (0 if none)

  // Crew levelling
  npcLevel: number;       // 1–66 (1 base + 65 upgrades)
  health: number;         // current HP
  maxHealth: number;      // max HP (base 100 + statHealth * 20)
  xp: number;             // XP progress toward next global level
  statHealth: number;     // upgrade levels, no individual cap (+20 max HP each)
  statDamage: number;     // upgrade levels (+10% damage each)
  statStamina: number;    // upgrade levels (+10% reload/work speed each)
  statWeight: number;     // upgrade levels (+10% carry capacity each)
  statPoints: number;     // unspent stat points = (npcLevel - 1) - total spent
  locked: boolean;        // when true: pinned to current module; crew panel cannot reassign
}

/**
/**
 * Island preset names — must match server-side ISLAND_PRESET_* constants.
 */
export type IslandPreset = 'tropical' | 'jungle' | 'desert' | 'rocky' | 'pine';

/**
 * A single resource node on an island (offset from island centre in world px).
 */
export interface IslandResource {
  ox: number;
  oy: number;
  type: 'wood' | 'fiber' | 'food' | 'rock';
}

/**
 * Server-authoritative island definition.
 * Sent once via the ISLANDS message on player connect.
 */
export interface IslandDef {
  id: number;
  x: number;
  y: number;
  preset: IslandPreset;
  resources: IslandResource[];
}

/**
 * Complete world state for deterministic simulation
 */
export interface WorldState {
  tick: number;
  ships: Ship[];
  players: Player[];
  cannonballs: Cannonball[];
  npcs: Npc[];
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

// ── Build / Ghost placement system ──────────────────────────────────────────

/**
 * Module kinds that can be ghost-placed as planning markers.
 * Subset of ModuleKind — only buildable module types.
 */
export type GhostModuleKind = 'plank' | 'cannon' | 'mast' | 'helm' | 'deck' | 'swivel';

/**
 * A client-local "ghost" placement — a translucent planning marker showing
 * where the player intends to place a module in the future.
 * Ghost placements are purely client-side and never sent to the server.
 * (Exception: server-side destroyed-module slots are shown via the existing
 * snap-point ghost system and not tracked here.)
 */
export interface GhostPlacement {
  /** Unique client-local identifier. */
  id: string;
  /** Type of module this ghost represents. */
  kind: GhostModuleKind;
  /** ID of the ship this ghost is attached to. */
  shipId: number;
  /** Ship-local position. */
  localPos: { x: number; y: number };
  /** Ship-local rotation in radians. */
  localRot: number;
}

// ── Weapon control groups ──────────────────────────────────────────────────

/** Firing mode for a weapon control group. */
export type WeaponGroupMode = 'aiming' | 'freefire' | 'haltfire' | 'targetfire';

/** State for one of the 10 user-defined weapon control groups. */
export interface WeaponGroupState {
  /** Module IDs of cannons assigned to this group. */
  cannonIds: number[];
  /** Current firing mode for this group. */
  mode: WeaponGroupMode;
  /** For targetfire mode: the ship ID the group is locked onto. -1 = none. */
  targetId: number;
}
