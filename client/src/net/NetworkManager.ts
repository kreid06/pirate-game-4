/**
 * Network Manager - Client-Server Communication
 * 
 * Manages the connection to the game server and handles all network communication.
 * Supports WebSocket with planned WebTransport upgrade.
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame, Npc, Ship, IslandDef, IslandResource, IslandPreset, PlacedStructure, ConstructionPhase, Company } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';
import { createShipAtPosition } from '../sim/ShipUtils.js';
import { ShipModule, ModuleKind, MODULE_TYPE_MAP } from '../sim/modules.js';
import { parseInventoryFromServer, createEmptyInventory } from '../sim/Inventory.js';
import { SchematicEntry, ShipSchematicEntry } from '../sim/Quality.js';
import { PlayerActions } from '../sim/Physics.js';

/**
 * Network connection states
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * Network statistics for monitoring
 */
export interface NetworkStats {
  ping: number;           // Round-trip time in milliseconds
  packetLoss: number;     // Percentage of lost packets
  bytesReceived: number;  // Total bytes received
  bytesSent: number;      // Total bytes sent
  messagesReceived: number; // Total messages received
  messagesSent: number;   // Total messages sent
  averageFPS: number;     // Average server tick rate received
}

/**
 * Message types for client-server communication
 */
export enum MessageType {
  // Client to Server
  HANDSHAKE = 'handshake',
  INPUT_FRAME = 'input_frame', // OLD - still supported for backward compatibility
  
  // NEW: Hybrid protocol
  MOVEMENT_STATE = 'movement_state',
  ROTATION_UPDATE = 'rotation_update',
  ACTION_EVENT = 'action_event',
  MODULE_INTERACT = 'module_interact',
  
  // Ship control messages (when mounted to helm)
  SHIP_SAIL_CONTROL = 'ship_sail_control',
  SHIP_RUDDER_CONTROL = 'ship_rudder_control',
  SHIP_SAIL_ANGLE_CONTROL = 'ship_sail_angle_control',
  
  // Cannon control messages
  CANNON_AIM = 'cannon_aim',
  CANNON_FIRE = 'fire_weapon',   // universal weapon fire (cannon, swivel, future: ballista)
  CANNON_GROUP_CONFIG = 'cannon_group_config',
  CANNON_GROUP_STATE = 'cannon_group_state',
  // Swivel control messages
  SWIVEL_AIM = 'swivel_aim',

  SLOT_SELECT = 'slot_select',
  INV_SWAP = 'inv_swap',
  DROP_ITEM = 'drop_item',
  DROP_SCHEMATIC = 'drop_schematic',
  DROP_RESOURCES = 'drop_resources',
  PICKUP_ITEM = 'pickup_item',
  UNEQUIP = 'unequip',
  GIVE_ITEM = 'give_item',
  PLACE_PLANK = 'place_plank',
  REPAIR_PLANK = 'repair_plank',
  REPAIR_SAIL = 'repair_sail',
  USE_HAMMER = 'use_hammer',
  BUCKET_FILL = 'bucket_fill',
  BUCKET_DUMP = 'bucket_dump',
  PLACE_CANNON = 'place_cannon',
  PLACE_CANNON_AT = 'place_cannon_at',
  PLACE_MAST = 'place_mast',
  HARVEST_RESOURCE = 'harvest_resource',
  HARVEST_SUCCESS  = 'harvest_success',
  HARVEST_FAILURE  = 'harvest_failure',
  HARVEST_FIBER    = 'harvest_fiber',
  HARVEST_FIBER_SUCCESS = 'harvest_fiber_success',
  HARVEST_FIBER_FAILURE = 'harvest_fiber_failure',
  HARVEST_ROCK     = 'harvest_rock',
  HARVEST_ROCK_SUCCESS  = 'harvest_rock_success',
  HARVEST_ROCK_FAILURE  = 'harvest_rock_failure',
  HARVEST_STONE     = 'harvest_stone',
  HARVEST_STONE_SUCCESS = 'harvest_stone_success',
  HARVEST_STONE_FAILURE = 'harvest_stone_failure',
  HARVEST_BOULDER_SUCCESS = 'harvest_boulder_success',
  HARVEST_BOULDER_FAILURE = 'harvest_boulder_failure',
  PLACE_STRUCTURE  = 'place_structure',
  STRUCTURE_INTERACT = 'structure_interact',
  PLACE_MAST_AT = 'place_mast_at',
  REPLACE_HELM = 'replace_helm',
  PLACE_DECK = 'place_deck',
  PLACE_RAMP = 'place_ramp',
  PLACE_HATCH_COVER = 'place_hatch_cover',
  PLACE_GUNPORT = 'place_gunport',
  TOGGLE_GUNPORT = 'toggle_gunport',
  PLAYER_SET_DECK = 'player_set_deck',
  PLACE_SWIVEL_AT = 'place_swivel_at',
  PLACE_CHEST_AT = 'place_chest_at',
  PLACE_BED_AT = 'place_bed_at',
  PLACE_WELL_AT = 'place_well_at',
  PLACE_WORKBENCH_AT = 'place_workbench_at',
  BED_TRAVEL = 'bed_travel',
  CHEST_TRANSFER = 'chest_transfer',
  LAND_CHEST_TRANSFER = 'land_chest_transfer',
  LAND_CHEST_DROP = 'land_chest_drop',
  CREW_ASSIGN = 'crew_assign',
  NPC_RECRUIT = 'npc_recruit',
  NPC_MOVE_ABOARD = 'npc_move_aboard',
  NPC_LOCK = 'npc_lock',
  NPC_GOTO_MODULE = 'npc_goto_module',
  NPC_MOVE_TO_POS = 'npc_move_to_pos',
  UPGRADE_PLAYER_STAT = 'upgrade_player_stat',
  PLAYER_LEVEL_UP = 'player_level_up',
  COMMAND = 'command',
  RESPAWN_REQUEST = 'respawn_request',
  USE_BED_ON_SHIP = 'use_bed_on_ship',
  RENAME_SHIP = 'rename_ship',

  PING = 'ping',
  
  // Server to Client  
  HANDSHAKE_RESPONSE = 'handshake_response',
  COMMAND_RESPONSE = 'command_response',
  PLAYER_TELEPORTED = 'player_teleported',
  WORLD_STATE = 'world_state',
  SNAPSHOT = 'snapshot',
  PONG = 'pong',
  MESSAGE_ACK = 'message_ack',
  MODULE_INTERACT_SUCCESS = 'module_interact_success',
  MODULE_INTERACT_FAILURE = 'module_interact_failure',
  
  // Chat
  CHAT_MESSAGE   = 'chat_message',   // client → server
  CHAT_BROADCAST = 'chat_broadcast', // server → client

  // Server notifications
  PLAYER_BOARDED = 'player_boarded',
  STRUCTURE_PLACED = 'structure_placed',
  STRUCTURE_DEMOLISHED = 'structure_demolished',
  DEMOLISH_STRUCTURE = 'demolish_structure',
  DEMOLISH_MODULE = 'demolish_module',
  REPAIR_STRUCTURE = 'repair_structure',
  CRAFTING_OPEN  = 'crafting_open',
  STRUCTURES_LIST = 'STRUCTURES',

  // Connection Management
  CONNECT = 'connect',
  DISCONNECT = 'disconnect',
  ERROR = 'error'
}

/**
 * Base network message structure
 */
interface NetworkMessage {
  type: MessageType;
  timestamp: number;
  sequenceId?: number;
}

/**
 * Handshake message for initial connection
 */
interface HandshakeMessage extends NetworkMessage {
  type: MessageType.HANDSHAKE;
  playerName: string;
  protocolVersion: number;
}

/**
 * Input frame message (server protocol format)
 */
interface InputMessage extends NetworkMessage {
  type: MessageType.INPUT_FRAME;
  timestamp: number;
  sequenceId: number;
  tick: number;
  rotation: number; // Player aim direction in radians (required by server)
  movement: {
    x: number;
    y: number;
  };
  actions: number;
  is_sprinting?: boolean;
  /** Average AOI view distance (client world units). Server uses this to tune per-player AOI radius. */
  view_radius?: number;
}

/**
 * Movement state message (HYBRID PROTOCOL)
 */
interface MovementStateMessage extends NetworkMessage {
  type: MessageType.MOVEMENT_STATE;
  timestamp: number;
  movement: {
    x: number;
    y: number;
  };
  is_moving: boolean;
  is_sprinting: boolean;
  // Semi-authority: client's predicted authoritative world position. The server
  // adopts this (anti-cheat speed-clamped) for on-foot land/dock movement instead
  // of re-integrating from direction, so reconciliation stays quiet and abrupt
  // direction changes don't rubber-band. Optional — server falls back to direction
  // integration when absent.
  px?: number;
  py?: number;
  /** Ship-local anchor when aboard (optional — keeps deck coords in sync during grapple reel). */
  plx?: number;
  ply?: number;
}

/**
 * Rotation update message (HYBRID PROTOCOL)
 */
interface RotationUpdateMessage extends NetworkMessage {
  type: MessageType.ROTATION_UPDATE;
  timestamp: number;
  rotation: number;
}

/**
 * Action event message (HYBRID PROTOCOL)
 */
interface ActionEventMessage extends NetworkMessage {
  type: MessageType.ACTION_EVENT;
  timestamp: number;
  action: string;
  target?: {
    x: number;
    y: number;
  };
}

/**
 * Ping/Pong messages for latency measurement
 */
interface PingPongMessage extends NetworkMessage {
  type: MessageType.PING | MessageType.PONG;
  clientTimestamp: number;
  serverTimestamp?: number;
}

/**
 * World state update from server
 */
interface WorldStateMessage extends NetworkMessage {
  type: MessageType.WORLD_STATE | MessageType.SNAPSHOT;
  worldState: WorldState;
  tick: number;
}

/**
 * Server acknowledgment message
 */
interface AckMessage extends NetworkMessage {
  type: MessageType.MESSAGE_ACK;
  status: string;
  structure_id?: number;
  cannon_aim_angle?: number;
}

/**
 * Module interaction message
 */
interface ModuleInteractMessage extends NetworkMessage {
  type: MessageType.MODULE_INTERACT;
  module_id: number;
}

/**
 * Module interaction success response
 */
interface ModuleInteractSuccessMessage extends NetworkMessage {
  type: MessageType.MODULE_INTERACT_SUCCESS;
  module_id: number;
  module_kind: string;
  mounted: boolean;
  mount_offset?: { x: number; y: number };
}

/**
 * Module interaction failure response
 */
interface ModuleInteractFailureMessage extends NetworkMessage {
  type: MessageType.MODULE_INTERACT_FAILURE;
  module_id?: number;
  reason: string;
}

/**
 * Cannon aim message
 */
interface CannonAimMessage extends NetworkMessage {
  type: MessageType.CANNON_AIM;
  timestamp: number;
  aim_angle: number; // Radians, relative to ship rotation
  active_groups: number[]; // Weapon group indices the player is currently aiming with
}

/**
 * Swivel aim message — ship-relative barrel heading sent by a mounted player.
 */
interface SwivelAimMessage extends NetworkMessage {
  type: MessageType.SWIVEL_AIM;
  timestamp: number;
  aim_angle: number; // Radians, relative to ship rotation
}

/**
 * Cannon fire message
 */
interface CannonFireMessage extends NetworkMessage {
  type: MessageType.CANNON_FIRE;
  timestamp: number;
  weapon_ids?: number[]; // Specific weapons to fire, or undefined for all aimed cannons
  fire_all?: boolean;    // True if double-click (fire all cannons)
  freefire?: boolean;    // True if freefire/targetfire mode — skip server aim-angle check
  ammo_type?: number;    // 0 = cannonball (default), 1 = bar shot
}

/**
 * Weapon control group configuration message.
 * Sent whenever the player changes a group's mode, cannon assignment, or target.
 */
interface CannonGroupConfigMessage extends NetworkMessage {
  type: MessageType.CANNON_GROUP_CONFIG;
  timestamp: number;
  group_index: number;          // 0–9
  mode: 'aiming' | 'freefire' | 'haltfire' | 'targetfire';
  weapon_ids: number[];         // Module IDs of cannons/swivels in this group
  target_ship_id: number;       // Server ship entity ID for targetfire; 0 otherwise
}

/**
 * Ship sail control message (when mounted to helm)
 * W/S keys control sail openness
 */
interface ShipSailControlMessage extends NetworkMessage {
  type: MessageType.SHIP_SAIL_CONTROL;
  desired_openness: number; // 0-100 in increments of 10
}

/**
 * Ship rudder control message (when mounted to helm)
 * A/D keys control rudder direction
 */
interface ShipRudderControlMessage extends NetworkMessage {
  type: MessageType.SHIP_RUDDER_CONTROL;
  turning_left: boolean;
  turning_right: boolean;
  moving_backward: boolean;
}

/**
 * Ship sail angle control message (when mounted to helm)
 * Shift+A/D keys control sail rotation angle
 */
interface ShipSailAngleControlMessage extends NetworkMessage {
  type: MessageType.SHIP_SAIL_ANGLE_CONTROL;
  desired_angle: number; // -60 to +60 degrees in increments of 6
}

interface SlotSelectMessage extends NetworkMessage {
  type: MessageType.SLOT_SELECT;
  timestamp: number;
  slot: number;
}

interface UnequipMessage extends NetworkMessage {
  type: MessageType.UNEQUIP;
}

interface GiveItemMessage extends NetworkMessage {
  type: MessageType.GIVE_ITEM;
  timestamp: number;
  slot: number;
  item: number;
  quantity: number;
}

interface RepairPlankMessage extends NetworkMessage {
  type: MessageType.REPAIR_PLANK;
  timestamp: number;
  shipId: number;
}

interface RepairSailMessage extends NetworkMessage {
  type: MessageType.REPAIR_SAIL;
  timestamp: number;
  shipId: number;
  mastIndex: number; // 0=bow, 1=mid, 2=stern
}

interface UseHammerMessage extends NetworkMessage {
  type: MessageType.USE_HAMMER;
  timestamp: number;
  shipId: number;
  moduleId: number;
}

interface BucketFillMessage extends NetworkMessage {
  type: MessageType.BUCKET_FILL;
  timestamp: number;
  success: boolean;
  deckLevel?: number;
  atWell?: boolean;
}

interface BucketDumpMessage extends NetworkMessage {
  type: MessageType.BUCKET_DUMP;
  timestamp: number;
  deckLevel?: number;
}

interface PlacePlankMessage extends NetworkMessage {
  type: MessageType.PLACE_PLANK;
  timestamp: number;
  shipId: number;
  sectionName: string;
  segmentIndex: number;
  resource_source?: 'pack' | 'ship' | 'yard' | 'auto';
  bp_index?: number;
}

interface PlaceCannonMessage extends NetworkMessage {
  type: MessageType.PLACE_CANNON;
  timestamp: number;
  shipId: number;
}

interface PlaceCannonAtMessage extends NetworkMessage {
  type: MessageType.PLACE_CANNON_AT;
  timestamp: number;
  shipId: number;
  localX: number;
  localY: number;
  rotation: number; // radians, ship-relative
}

interface PlaceMastMessage extends NetworkMessage {
  type: MessageType.PLACE_MAST;
  timestamp: number;
  shipId: number;
  mastIndex: number; // 0=bow, 1=mid, 2=stern — which specific mast slot to replace
}

interface PlaceMastAtMessage extends NetworkMessage {
  type: MessageType.PLACE_MAST_AT;
  timestamp: number;
  shipId: number;
  localX: number;
  localY: number;
  resource_source?: 'pack' | 'ship' | 'yard' | 'auto';
}

interface ReplaceHelmMessage extends NetworkMessage {
  type: MessageType.REPLACE_HELM;
  timestamp: number;
  shipId: number;
  resource_source?: 'pack' | 'ship' | 'yard' | 'auto';
}

interface PlaceDeckMessage extends NetworkMessage {
  type: MessageType.PLACE_DECK;
  timestamp: number;
  deck_level?: number;
  resource_source?: 'pack' | 'ship' | 'yard' | 'auto';
  bp_index?: number;
}

interface PlaceRampMessage extends NetworkMessage {
  type: MessageType.PLACE_RAMP;
  timestamp: number;
  shipId: number;
  snapIndex: number;
  rotation: number;  // ramp facing in radians (0, π/2, π, 3π/2)
  resource_source?: 'pack' | 'ship' | 'yard' | 'auto';
}

interface PlaceHatchCoverMessage extends NetworkMessage {
  type: MessageType.PLACE_HATCH_COVER;
  timestamp: number;
  shipId: number;
  snapIndex: number;
  resource_source?: 'pack' | 'ship' | 'yard' | 'auto';
}

interface PlaceGunportMessage extends NetworkMessage {
  type: MessageType.PLACE_GUNPORT;
  timestamp: number;
  shipId: number;
  snapIndex: number; // 0-11 (0-5 = starboard, 6-11 = port)
  resource_source?: 'pack' | 'ship' | 'yard' | 'auto';
}

interface ToggleGunportMessage extends NetworkMessage {
  type: MessageType.TOGGLE_GUNPORT;
  timestamp: number;
  shipId: number;
  gunportId: number;
}

interface PlayerSetDeckMessage extends NetworkMessage {
  type: MessageType.PLAYER_SET_DECK;
  timestamp: number;
  deckLevel: number; // 0 = lower deck, 1 = upper deck
}

interface PlaceChestAtMessage extends NetworkMessage {
  type: MessageType.PLACE_CHEST_AT;
  timestamp: number;
  shipId?: number;   // null/absent for land placement
  localX: number;
  localY: number;
  rotation: number;
  deckId?: number;
}

interface ChestTransferMessage extends NetworkMessage {
  type: MessageType.CHEST_TRANSFER;
  timestamp: number;
  shipId: number;
  moduleId: number;
  item: string;
  quantity: number;
  direction: 'deposit' | 'withdraw';
}

interface LandChestTransferMessage extends NetworkMessage {
  type: MessageType.LAND_CHEST_TRANSFER;
  timestamp: number;
  structure_id: number;
  item: string;
  quantity: number;
  direction: 'deposit' | 'withdraw';
}

interface LandChestDropMessage extends NetworkMessage {
  type: MessageType.LAND_CHEST_DROP;
  timestamp: number;
  structure_id: number;
  item: string;
  quantity: number;
}

interface PlaceSwivelAtMessage extends NetworkMessage {
  type: MessageType.PLACE_SWIVEL_AT;
  timestamp: number;
  shipId: number;
  localX: number;
  localY: number;
  rotation: number;
}

interface CrewAssignMessage extends NetworkMessage {
  type: MessageType.CREW_ASSIGN;
  timestamp: number;
  ship_id: number;
  npc_id: number;
  task: string;
}

interface HarvestResourceMessage extends NetworkMessage {
  type: MessageType.HARVEST_RESOURCE;
  timestamp: number;
}

interface PlaceStructureMessage extends NetworkMessage {
  type: MessageType.PLACE_STRUCTURE;
  timestamp: number;
  structure_type: string;
  x: number;
  y: number;
  rotation?: number;
  under_construction?: boolean;
  bp_index?: number;
}

interface StructureInteractMessage extends NetworkMessage {
  type: MessageType.STRUCTURE_INTERACT;
  timestamp: number;
  structure_id: number;
}

interface InvSwapMessage extends NetworkMessage {
  type: MessageType.INV_SWAP;
  timestamp: number;
  slot_a: number;
  slot_b: number;
}

interface DropItemMessage extends NetworkMessage {
  type: MessageType.DROP_ITEM;
  timestamp: number;
  slot: number;
}

interface DropSchematicMessage extends NetworkMessage {
  type: MessageType.DROP_SCHEMATIC;
  timestamp: number;
  /** Server-side PlayerBlueprint slot index to remove. */
  index: number;
}

interface DropResourcesMessage extends NetworkMessage {
  type: MessageType.DROP_RESOURCES;
  timestamp: number;
  kind: string;
  amount: number;
}

interface PickupItemMessage extends NetworkMessage {
  type: MessageType.PICKUP_ITEM;
  timestamp: number;
  item_id: number;
}

interface ChatMessageOut extends NetworkMessage {
  type: MessageType.CHAT_MESSAGE;
  timestamp: number;
  channel: string;
  text: string;
}

type GameMessage = HandshakeMessage | InputMessage | MovementStateMessage | RotationUpdateMessage | ActionEventMessage | ModuleInteractMessage | ModuleInteractSuccessMessage | ModuleInteractFailureMessage | ShipSailControlMessage | ShipRudderControlMessage | ShipSailAngleControlMessage | CannonAimMessage | CannonFireMessage | CannonGroupConfigMessage | PingPongMessage | WorldStateMessage | AckMessage | SlotSelectMessage | UnequipMessage | GiveItemMessage | PlacePlankMessage | PlaceCannonMessage | PlaceCannonAtMessage | PlaceMastMessage | PlaceMastAtMessage | ReplaceHelmMessage | PlaceDeckMessage | RepairPlankMessage | RepairSailMessage | UseHammerMessage | BucketFillMessage | BucketDumpMessage | CrewAssignMessage | PlaceSwivelAtMessage | SwivelAimMessage | HarvestResourceMessage | PlaceStructureMessage | StructureInteractMessage | InvSwapMessage | DropItemMessage | DropSchematicMessage | DropResourcesMessage | PickupItemMessage | ChatMessageOut | PlaceRampMessage | PlaceHatchCoverMessage | PlaceGunportMessage | ToggleGunportMessage | PlayerSetDeckMessage | PlaceChestAtMessage | ChestTransferMessage | LandChestTransferMessage | LandChestDropMessage;

/**
 * Main network manager class
 */
export class NetworkManager {
  private config: NetworkConfig;
  private socket: WebSocket | null = null;
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  
  // Connection management
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnecting = false; // Flag to prevent race conditions
  
  // Player management
  private assignedPlayerId: number | null = null;
  
  // Message handling
  private messageSequenceId = 0;
  private pendingPings = new Map<number, number>(); // sequenceId -> timestamp
  private playerName: string = 'Player_' + Math.random().toString(36).substr(2, 5);
  private accessToken: string | null = null;
  
  // Statistics tracking
  private stats: NetworkStats = {
    ping: 0,
    packetLoss: 0,
    bytesReceived: 0,
    bytesSent: 0,
    messagesReceived: 0,
    messagesSent: 0,
    averageFPS: 30
  };
  
  private latency = 0;

  // ── Per-tick allocation caches ────────────────────────────────────────────
  /** Per-ship hull/module template — keyed by ship_id, created once per ship.
   *  Plank IDs are stamped to match the server's MID(ship_seq, offset) encoding
   *  so that plankHealthBuf lookups and damage-event module finds both work. */
  private readonly _shipTemplates = new Map<number, { planks: ShipModule[]; deck: ShipModule[]; ship: Ship }>();
  /** Plank-health lookup buffer — cleared and refilled each tick instead of being re-allocated. */
  private readonly _plankHealthBuf = new Map<number, { health: number; targetHealth: number; maxHealth: number; qualityTier?: number; qualityDurabilityQ8?: number; qualityWeaponDmgQ8?: number }>();

  // Event callbacks
  public onWorldStateReceived: ((worldState: WorldState) => void) | null = null;
  /** Current world wind direction (radians, 0=North, clockwise). Updated from GAME_STATE. */
  public windAngle: number = 0;
  /** Current world wind strength (0–1). Updated from GAME_STATE. */
  public windStrength: number = 0.5;
  public onCompanyCreated: ((company: Company) => void) | null = null;
  public onConnectionStateChanged: ((state: ConnectionState) => void) | null = null;
  public onModuleMountSuccess: ((moduleId: number, moduleKind: string, mountOffset?: Vec2) => void) | null = null;
  public onModuleMountFailure: ((reason: string) => void) | null = null;
  public onModuleDestroyed: ((shipId: number, moduleId: number, damage: number, hitX?: number, hitY?: number, wreckageUntilMs?: number) => void) | null = null;
  public onModuleDamaged: ((shipId: number, moduleId: number, damage: number, hitX?: number, hitY?: number) => void) | null = null;
  public onShipSunk: ((shipId: number) => void) | null = null;
  public onShipSinking: ((shipId: number) => void) | null = null;
  public onShipLevelUp: ((shipId: number, attribute: string, attrLevel: number, xp: number, shipLevel: number, totalCap: number, nextUpgradeCost: number) => void) | null = null;
  public onShipXpGained: ((shipId: number, xp: number, x: number, y: number, shared: boolean) => void) | null = null;
  public onShipUnclaimed: ((shipId: number) => void) | null = null;
  public onShipClaimed: ((shipId: number, companyId: number) => void) | null = null;
  public onFlagPlanted: ((shipId: number, planterId: number, planterCompany: number) => void) | null = null;
  public onFlagUpdate: ((shipId: number, planterId: number, planterCompany: number, progressMs: number, totalMs: number, contested: boolean) => void) | null = null;
  public onFlagRemoved: ((shipId: number) => void) | null = null;
  public onFlagCaptureComplete: ((shipId: number, planterCompany: number) => void) | null = null;
  public onSalvageSuccess: ((item: number, quantity: number) => void) | null = null;
  /** Fired when the server sends the player's full schematic (blueprint) list. */
  public onSchematicList: ((items: SchematicEntry[]) => void) | null = null;
  /** Fired when the server sends a ship's shared schematic pool. */
  public onShipSchematicList: ((shipId: number, items: ShipSchematicEntry[]) => void) | null = null;
  /** Fired when the player salvages a quality blueprint from a wreck. */
  public onSalvageBlueprint: ((item: number, tier: number, crafts: number,
    wreckId: number, bpRemaining: number, lootRemaining: number) => void) | null = null;
  /** Fired when the server responds to a craft_blueprint request. */
  public onCraftBlueprintResult: ((success: boolean, index: number, reason: string,
    item: number, tier: number, craftsRemaining: number) => void) | null = null;
  public onNpcUnclaimed: ((npcId: number) => void) | null = null;
  public onShipRenamed: ((shipId: number, name: string) => void) | null = null;
  public onNpcDialogue: ((npcId: number, npcName: string, text: string) => void) | null = null;
  /**
   * Fired when the server accepts or rejects a Move To module command.
   * ok=true → module dispatched successfully; ok=false → module was occupied or invalid.
   */
  public onNpcMoveResult: ((ok: boolean, npcId: number) => void) | null = null;
  /** Fired when the server confirms an NPC stat upgrade. */
  public onNpcStatUp: ((npcId: number, stat: string, statLevel: number, xp: number,
    maxHealth: number, npcLevel: number,
    statHealth: number, statDamage: number, statStamina: number, statWeight: number,
    statPoints: number) => void) | null = null;
  /** Fired when the server confirms a player stat upgrade. */
  public onPlayerStatUp: ((stat: string, statLevel: number, xp: number,
    maxHealth: number, maxStamina: number, playerLevel: number,
    statHealth: number, statDamage: number, statStamina: number, statWeight: number,
    statPoints: number) => void) | null = null;
  /** Fired when the server sends {type:"ack"} — the final handshake confirmation that the
   *  player has been spawned and is ready to play. */
  public onPlayerAck: (() => void) | null = null;
  /** Fired when a cannonball hits an NPC or player. */
  /** Fired when any weapon fires — used to render hit-scan tracers (grapeshot, canister). */
  public onCannonFireEvent: ((cannonId: number, shipId: number, x: number, y: number,
    angle: number, projectileId: number, ammoType: number) => void) | null = null;

  /** Fired when the server confirms the player has mounted an island cannon structure.
   *  `mountX`/`mountY` are the world-space coordinates the player should snap to. */
  public onIslandCannonMounted: ((structureId: number, aimAngle: number, reloadMs: number, mountX: number, mountY: number, facingAngle: number) => void) | null = null;
  /** Fired when server returns authoritative current island-cannon aim in message_ack. */
  public onIslandCannonAimSync: ((structureId: number, aimAngle: number) => void) | null = null;
  /** Fired when an island cannon starts or finishes reloading. */
  public onStructureReload: ((structureId: number, reloadMs: number, loadedAmmo: number) => void) | null = null;
  /** Fired when the player tries to fire an island cannon but has no cannonballs. */
  public onNoAmmo: (() => void) | null = null;
  /** Fired when the server acks a bucket fill or dump action. */
  public onBucketAck: ((status: string, extra?: { amount?: number; bucketFill?: number; remainingMs?: number }) => void) | null = null;
  /** Fired when the server echoes the authoritative deck level after a player_set_deck request.
   *  deckLevel is the server's current value — may differ from what was requested if the
   *  validation was rejected, in which case the client should roll back its local state. */
  public onDeckLevelAck: ((deckLevel: number) => void) | null = null;
  /** Fired when the server confirms grapple boarding with authoritative spawn pose. */
  public onGrappleBoarded: ((board: {
    shipId: number;
    deckLevel: number;
    x: number;
    y: number;
    localX: number;
    localY: number;
  }) => void) | null = null;

  public onEntityHit: ((entityType: 'npc' | 'player', id: number, x: number, y: number,
    damage: number, health: number, maxHealth: number, killed: boolean, killerShipId: number) => void) | null = null;
  /** Fired when liquid flame ignites an entity or wooden module. */
  public onFireEffect: ((entityType: 'npc' | 'player' | 'module', id: number, x: number, y: number,
    durationMs: number, shipId?: number, moduleId?: number) => void) | null = null;
  /** Fired when a burning entity or module's fire timer expires. */
  public onFireExtinguished: ((entityType: 'npc' | 'player' | 'module', id: number,
    shipId?: number, moduleId?: number) => void) | null = null;
  /** Fired each 500ms tick with updated sail fiber fire intensity. */
  public onSailFiberFire: ((shipId: number, moduleId: number, intensity: number,
    fiberHealth: number, windEfficiency: number) => void) | null = null;
  /** Fired when a player performs a sword swing (for arc animation). */
  public onSwordSwing: ((playerId: number, x: number, y: number, angle: number, range: number) => void) | null = null;
  public onLadderState: ((shipId: number, moduleId: number, retracted: boolean) => void) | null = null;
  /** Fired when the server broadcasts the authoritative weapon group state for a ship. */
  public onCannonGroupState: ((shipId: number, groups: {index: number, mode: string, cannonIds: number[], targetShipId: number, gunportsOpen: boolean, name: string}[]) => void) | null = null;
  /** Fired when the server confirms a gunport was toggled (open or closed). mass is the updated ship mass in kg (if provided). */
  public onGunportState: ((shipId: number, gunportId: number, isOpen: boolean, mass?: number) => void) | null = null;
  /** Fired when the server blocks a cannon fire attempt because its gunport is closed. */
  public onGunportBlocked: ((cannonId: number, gunportId: number) => void) | null = null;
  /** Fired when the server confirms the player has boarded a ship (via ladder). */
  public onPlayerBoarded: ((shipId: number) => void) | null = null;
  /** Fired when the server responds to a harvest_resource request. */
  public onHarvestResult: ((success: boolean, wood: number, reason: string) => void) | null = null;
  /** Fired when the server responds to a harvest_fiber request. */
  public onFiberHarvestResult: ((success: boolean, fiber: number, reason: string, wood?: number) => void) | null = null;
  /** Fired when the server responds to a harvest_rock request. */
  public onRockHarvestResult: ((success: boolean, metal: number, reason: string) => void) | null = null;
  /** Fired when the server responds to a harvest_stone request. */
  public onStoneHarvestResult: ((success: boolean, stone: number, reason: string) => void) | null = null;
  /** Fired when the server responds to a harvest_boulder request. */
  public onBoulderHarvestResult: ((success: boolean, metal: number, stone: number, reason: string) => void) | null = null;
  /** Fired when any action is rejected by the server due to insufficient stamina. */
  public onNoStamina: (() => void) | null = null;
  /**
   * Fired once on connect with the full list of server-defined islands.
   * Falls back to client defaults if the server never sends this.
   */
  public onIslands: ((islands: IslandDef[]) => void) | null = null;

  /** World map dimensions received from the server via MAP_INFO. */
  public mapWidth: number = 90000;
  public mapHeight: number = 90000;
  public mapCenterX: number = 45000;
  public mapCenterY: number = 45000;
  public mapWrap: boolean = true;
  /** Average AOI view radius (client world units) from the latest ray cast. Set by ClientApplication each frame. */
  public viewRadius: number = 0;
  /** Fired when the server broadcasts a resource_damaged event. */
  public onResourceDamaged: ((islandId: number, ox: number, oy: number, hp: number, maxHp: number) => void) | null = null;
  /** Fired when a depleted resource respawns (resource_respawned event). */
  public onResourceRespawned: ((islandId: number, ri: number, ox: number, oy: number, hp: number, maxHp: number) => void) | null = null;

  /** Fired when the server broadcasts a newly placed structure to all clients. */
  public onStructurePlaced: ((s: PlacedStructure) => void) | null = null;
  /** Fired when the server confirms a structure has been demolished. */
  public onStructureDemolished: ((id: number, x?: number, y?: number) => void) | null = null;
  /** Fired when the server broadcasts that a ship module was demolished. */
  public onModuleDemolished: ((shipId: number, moduleId: number) => void) | null = null;
  /** Fired when a structure's company ownership is promoted (one-way, neutral → non-neutral). */
  public onStructureCompanyUpdated: ((id: number, companyId: number) => void) | null = null;
  /** Fired when a structure takes damage from a cannonball hit. Includes world position for FX. */
  public onStructureHpChanged: ((id: number, hp: number, maxHp: number, x: number, y: number, targetHp?: number) => void) | null = null;
  /** Fired when a cannonball hits a tree (trees are indestructible). */
  public onTreeHit: ((x: number, y: number) => void) | null = null;
  /** Fired when the server sends the full list of existing placed structures on join. */
  public onStructuresList: ((structures: PlacedStructure[]) => void) | null = null;
  /** Fired when a shipwreck spawns at sea (after a ship sinks). */
  public onWreckSpawned: ((wreck: PlacedStructure) => void) | null = null;
  /** Fired when a shipwreck is removed (salvaged or auto-despawned). */
  public onWreckRemoved: ((id: number) => void) | null = null;
  /** Fired every grapple-pull tick to update a wreck's world position. */
  public onWreckPositionUpdate: ((id: number, x: number, y: number) => void) | null = null;
  /** Fired when a grappled wreck is auto-salvaged — shows a loot notification. */
  public onWreckLoot: ((playerId: number, x: number, y: number, wood: number, fiber: number, metal: number, stone: number, items: number, blueprints: number) => void) | null = null;
  /** Fired when the server confirms a workbench can be opened (E-key interact). */
  public onCraftingOpen: ((structureId: number, structureType: string, moduleId: number) => void) | null = null;
  /** Fired when the server confirms a craft_item request. */
  public onCraftResult: ((success: boolean, recipeId: string, reason?: string) => void) | null = null;
  /** Fired when a player-funded structure repair starts. */
  public onRepairStarted: ((structureId: number, playerId: number, hp: number, maxHp: number, targetHp: number) => void) | null = null;
  /** Fired when an in-progress repair is cancelled (by the same player re-interacting). */
  public onRepairCancelled: ((structureId: number, playerId: number) => void) | null = null;
  /** Fired when a repair finishes (target_hp == max_hp). */
  public onRepairComplete: ((structureId: number, playerId: number) => void) | null = null;
  /** Fired when the server rejects a repair_structure request. */
  public onRepairFail: ((structureId: number, reason: string) => void) | null = null;
  /** Fired when an island territory changes ownership (flag fort placed or destroyed). */
  public onTerritoryUpdate: ((islandId: number, companyId: number, claimed: boolean, fortX: number, fortY: number, fortRadius: number, isCompanyFortress: boolean) => void) | null = null;
  /** Fired when a claiming flag's progress changes. */
  public onClaimFlagProgress: ((structId: number, progressMs: number, contested: boolean, targetsFortress: boolean, state?: number, graceMs?: number, graceTotal?: number, total?: number) => void) | null = null;
  public onTerritoryFlipped: ((flagId: number, orphanedStructureId: number, oldCompanyId: number, newCompanyId: number, islandId: number) => void) | null = null;
  /** Fired when the server updates a structure's per-structure dominance list
   * (after a successful claim flag capture). Replaces the previous dominators
   * array for the named structure id. */
  public onStructureDominators: ((structureId: number, dominators: number[]) => void) | null = null;
  /** Fired when a claiming flag finishes capturing territory. */
  public onTerritoryCaptured: ((islandId: number, newCompanyId: number) => void) | null = null;
  /** Fired when a Company Fortress build timer updates (≈1/s). */
  public onFortressBuildProgress: ((structId: number, companyId: number, islandId: number, progressMs: number, totalMs: number, contested: boolean) => void) | null = null;
  /** Fired when a Company Fortress finishes building (15 min complete). */
  public onFortressComplete: ((structId: number, companyId: number, islandId: number) => void) | null = null;
  /** Fired when a Company Fortress is captured by an enemy claim flag. */
  public onFortressCaptured: ((structId: number, newCompanyId: number, oldCompanyId: number, islandId: number) => void) | null = null;
  /** Fired when a Flag Fort crosses (in either direction) the 30%-HP active gate. */
  public onFlagFortActive: ((structId: number, companyId: number, islandId: number, active: boolean, claimPhase: number) => void) | null = null;
  /** Fired ≈1/s for each flag fort to resync its heal/contested state. */
  public onFlagFortBuildProgress: ((structId: number, hp: number, maxHp: number, contested: boolean, active: boolean, claimPhase: number, claimProgressMs: number, claimTotalMs: number, claimState: number, claimGraceMs: number, targetHp?: number) => void) | null = null;
  /** Fired when the server sends updated ship-construction state for a shipyard. */
  public onShipyardState: ((
    structureId: number,
    phase: 'empty' | 'building',
    modulesPlaced: string[],
    shipSpawned?: number,
    scaffoldedShipId?: number,
    spawnerPlayerId?: number,
    yardResources?: { wood: number; fiber: number; metal: number; stone: number },
    playerResources?: { wood: number; fiber: number; metal: number; stone: number },
  ) => void) | null = null;
  /** Fired when a shipyard action is rejected (e.g. ship_limit, missing_materials). */
  public onShipyardActionFail: ((reason: string) => void) | null = null;
  /** Fired when the server sends land chest state (after E-key interact or after a transfer). */
  public onLandChestState: ((structureId: number, resources: { wood: number; fiber: number; metal: number; stone: number }, playerResources?: { wood: number; fiber: number; metal: number; stone: number }, readOnly?: boolean) => void) | null = null;
  /** Fired when the server rejects a structure placement with a reason string. */
  public onPlacementFailed: ((reason: string, x: number, y: number, structureType: string, blockerId: number | null) => void) | null = null;
  /** Fired when a door is toggled open or closed by any player. */
  public onDoorToggled: ((id: number, open: boolean) => void) | null = null;
  /** Fired when a door's lock state is changed. Also includes updated open state. */
  public onDoorLockToggled: ((id: number, locked: boolean, open: boolean) => void) | null = null;

  /** Fired when the server confirms a bed interaction (island bed or ship bed).
   *  bedId > 0 for island beds; shipId > 0 for ship beds. */
  public onBedUsed: ((bedId?: number, x?: number, y?: number, shipId?: number) => void) | null = null;
  public onRespawnMap: ((ships: import('../client/ui/RespawnScreen.js').RespawnMapShip[]) => void) | null = null;
  /** Fired when the server rejects a bed use due to cooldown.
   *  remainingMs is the time left in ms before the bed can be used again. */
  public onBedCooldown: ((remainingMs: number) => void) | null = null;
  /** Fired when bed fast travel fails. */
  public onBedTravelFail: ((reason: string) => void) | null = null;

  /** Fired when the server responds to a player command. */
  public onCommandResponse: ((text: string, success: boolean) => void) | null = null;

  /** Fired when the server teleports a player (e.g. TpPlayerToShip command). */
  public onPlayerTeleported: ((playerId: number, x: number, y: number, parentShip: number, localX: number, localY: number) => void) | null = null;

  /** Fired each server tick with the current state of an active flamethrower wave. */
  public onFlameWaveUpdate: ((
    cannonId: number, shipId: number,
    x: number, y: number, angle: number, halfCone: number,
    waveDist: number, retreating: boolean, retreatDist: number,
    dead: boolean
  ) => void) | null = null;

  /** Fired when a new tombstone is spawned (player death). */
  public onTombstoneSpawned: ((tombstone: import('../sim/Types').Tombstone) => void) | null = null;
  /** Fired when a tombstone is collected by a player. */
  public onTombstoneCollected: ((id: number, playerId: number) => void) | null = null;

  /** Fired when a chat broadcast arrives from the server. */
  public onChatMessage: ((channel: string, senderName: string, text: string) => void) | null = null;
  /** Fired when a tombstone despawns (15-min TTL expired). */
  public onTombstoneDespawned: ((id: number) => void) | null = null;
  /** Fired when the server sends tombstone item contents (response to tombstone_open). */
  public onTombstoneItems: ((id: number, ownerName: string, slots: Array<[number, number]>, equip: Record<string, number>) => void) | null = null;
  
  constructor(config: NetworkConfig) {
    this.config = config;
    // Expose browser-console debug helper: paste a GAME_STATE JSON string and
    // get a full diagnostic without having to intercept a live tick.
    (window as any).__debugGameState = (input: string | object) =>
      NetworkManager.analyzeGameState(input);
  }

  /**
   * Diagnose a raw GAME_STATE payload.
   *
   * Usage from the browser console:
   *   __debugGameState('{"type":"GAME_STATE","tick":1,...}')
   *   __debugGameState(someAlreadyParsedObject)
   *
   * Prints a structured report — no return value needed.
   */
  static analyzeGameState(input: string | object): void {
    // ── 1. Parse ────────────────────────────────────────────────────────────
    let gs: any;
    if (typeof input === 'string') {
      const raw = input.startsWith('GAME_STATE:') ? input.substring(11) : input;
      try {
        gs = JSON.parse(raw);
      } catch (e) {
        const head = raw.substring(0, 400);
        const tail = raw.length > 400 ? `…${raw.substring(raw.length - 100)}` : '';
        console.error(
          `❌ [analyzeGameState] JSON.parse failed (${raw.length} bytes)\n` +
          `  Error : ${e}\n` +
          `  Head  : ${head}${tail}`
        );
        return;
      }
    } else {
      gs = input;
    }

    const WARN = 'color:orange;font-weight:bold';
    const ERR  = 'color:red;font-weight:bold';
    const OK   = 'color:green;font-weight:bold';
    const issues: Array<{ level: 'warn'|'error'; msg: string }> = [];
    const w = (msg: string) => issues.push({ level: 'warn',  msg });
    const e = (msg: string) => issues.push({ level: 'error', msg });

    // ── 2. Top-level ────────────────────────────────────────────────────────
    if (gs.type && gs.type !== 'GAME_STATE') e(`type="${gs.type}" — expected "GAME_STATE"`);
    if (typeof gs.tick !== 'number')         e('missing numeric "tick"');

    // ── 3. Per-typeId rules ──────────────────────────────────────────────────
    // deck_id: null = field absent (old server), 0 = lower, 1 = upper, 255 = deck-independent
    // required_fields: fields the server MUST send for this typeId
    // deck_must: exact deck_id the module must carry (undefined = flexible)
    type ModRule = {
      name: string;
      requiredFields?: string[];
      deck_must?: number;    // exact required deck_id
      deck_allow?: number[]; // allowed deck_id values (if not deck_must)
      posRequired?: boolean; // must carry x/y
      singleton?: boolean;   // at most one per ship
    };
    const TYPE_RULES: Record<number, ModRule> = {
      0:  { name:'helm',           posRequired:true,  deck_allow:[0,1],    singleton:true,  requiredFields:['wheelRot','state']          },
      1:  { name:'seat',           posRequired:true,  deck_allow:[0,1,255]                                                               },
      2:  { name:'cannon',         posRequired:true,  deck_allow:[0,1],                     requiredFields:['aimDir','state','gunportSnapIdx'] },
      3:  { name:'mast',           posRequired:true,  deck_must:255,                         requiredFields:['openness','sailAngle']       },
      4:  { name:'steering-wheel', posRequired:true,  deck_allow:[0,1]                                                                   },
      5:  { name:'ladder',         posRequired:true,  deck_must:255,       singleton:true                                                },
      6:  { name:'plank',                             deck_allow:[0,1,255], requiredFields:['health','maxHealth']                        },
      7:  { name:'deck',                              deck_allow:[0,1],    requiredFields:['health','stateBits']                         },
      8:  { name:'swivel',         posRequired:true,  deck_allow:[0,1,255]                                                               },
      9:  { name:'ramp',           posRequired:true,  deck_must:255                                                                      },
      10: { name:'hatch_cover',    posRequired:true,  deck_allow:[0,1]                                                                   },
      11: { name:'gunport',        posRequired:true,  deck_allow:[0,1],    requiredFields:['isOpen','snapIndex']                         },
      12: { name:'workbench',      posRequired:true,  deck_allow:[0,1,255]                                                               },
      13: { name:'chest',          posRequired:true,  deck_allow:[0,1,255]                                                               },
      14: { name:'bed',            posRequired:true,  deck_allow:[0,1,255]                                                               },
      15: { name:'well',           posRequired:true,  deck_must:0,         singleton:true                                      },
    };

    // ── 4. Ships ─────────────────────────────────────────────────────────────
    for (const ship of (gs.ships ?? [])) {
      const sid = `ship[${ship.id ?? '?'}]`;
      if (typeof ship.id       !== 'number') { e(`${sid}: missing id`);       continue; }
      if (typeof ship.x        !== 'number') e(`${sid}: missing x`);
      if (typeof ship.y        !== 'number') e(`${sid}: missing y`);
      if (typeof ship.rotation !== 'number') e(`${sid}: missing rotation`);
      if (!Number.isFinite(ship.x)) e(`${sid}: x=${ship.x} is not finite`);
      if (!Number.isFinite(ship.y)) e(`${sid}: y=${ship.y} is not finite`);
      if (!Array.isArray(ship.modules)) { e(`${sid}: modules is not an array`); continue; }

      const seenIds = new Map<number, number>(); // id → first index
      const singletons = new Set<number>();      // typeIds already seen once

      const rows: Array<Record<string,string>> = [];
      for (let mi = 0; mi < ship.modules.length; mi++) {
        const mod = ship.modules[mi];
        if (mod == null) { e(`${sid}[${mi}]: null/undefined module`); continue; }

        const mid = `${sid}/mod[id=${mod.id ?? '?'} idx=${mi}]`;
        if (typeof mod.id     === 'undefined') { e(`${mid}: missing id`);     continue; }
        if (typeof mod.typeId === 'undefined') { e(`${mid}: missing typeId`); continue; }

        const rule = TYPE_RULES[mod.typeId as number];
        const typeName = rule?.name ?? `UNKNOWN(${mod.typeId})`;

        // Duplicate ID
        if (seenIds.has(mod.id)) {
          e(`${mid}: DUPLICATE id — first seen at index ${seenIds.get(mod.id)}`);
        } else {
          seenIds.set(mod.id, mi);
        }

        // Unknown typeId
        if (!rule) w(`${mid}: unknown typeId ${mod.typeId}`);

        // Singleton (ladder, helm — only one per ship)
        if (rule?.singleton) {
          if (singletons.has(mod.typeId)) w(`${mid}: more than one ${typeName} on this ship`);
          singletons.add(mod.typeId);
        }

        // deck_id checks
        const dk: number | undefined = mod.deck_id;
        if (dk !== undefined) {
          if (dk !== 0 && dk !== 1 && dk !== 255)
            e(`${mid}: deck_id=${dk} is not 0/1/255`);
          if (rule?.deck_must !== undefined && dk !== rule.deck_must)
            e(`${mid}: ${typeName} must have deck_id=${rule.deck_must} but got ${dk}`);
          if (rule?.deck_allow && rule.deck_must === undefined && !rule.deck_allow.includes(dk))
            w(`${mid}: ${typeName} has deck_id=${dk}, expected one of [${rule.deck_allow}]`);
        } else if (rule?.deck_must !== undefined) {
          w(`${mid}: ${typeName} missing deck_id (expected ${rule.deck_must})`);
        }

        // Positions
        if (rule?.posRequired) {
          if (mod.x === undefined || mod.y === undefined)
            e(`${mid}: ${typeName} missing x/y position`);
          else {
            if (!Number.isFinite(mod.x)) e(`${mid}: x=${mod.x} is not finite`);
            if (!Number.isFinite(mod.y)) e(`${mid}: y=${mod.y} is not finite`);
            const dist = Math.sqrt(mod.x * mod.x + mod.y * mod.y);
            if (dist > 500) w(`${mid}: position (${mod.x},${mod.y}) is >500px from ship center`);
          }
        }

        // Health sanity
        if (mod.health !== undefined && mod.maxHealth !== undefined &&
            mod.maxHealth > 0 && mod.health > mod.maxHealth * 1.01)
          e(`${mid}: health=${mod.health} > maxHealth=${mod.maxHealth}`);

        // Required fields per type
        for (const rf of (rule?.requiredFields ?? [])) {
          if (mod[rf] === undefined) w(`${mid}: ${typeName} missing expected field "${rf}"`);
        }

        rows.push({
          idx: String(mi),
          id:  String(mod.id),
          type: typeName,
          deck: dk !== undefined ? String(dk) : '—',
          pos: mod.x !== undefined ? `(${mod.x},${mod.y})` : '—',
          health: mod.health !== undefined ? `${mod.health}/${mod.maxHealth ?? '?'}` : '—',
        });
      }

      // Print module table for this ship
      console.groupCollapsed(`  📦 ${sid}  (${ship.modules.length} modules, company=${ship.company ?? '?'})`);
      console.table(rows);
      console.groupEnd();
    }

    // ── 5. Players ──────────────────────────────────────────────────────────
    for (const p of (gs.players ?? [])) {
      const pid = `player[${p.id ?? '?'}]`;
      if (typeof p.world_x !== 'number') e(`${pid}: missing world_x`);
      if (typeof p.world_y !== 'number') e(`${pid}: missing world_y`);
      if (!Number.isFinite(p.world_x))   e(`${pid}: world_x=${p.world_x} is not finite`);
      if (!Number.isFinite(p.world_y))   e(`${pid}: world_y=${p.world_y} is not finite`);
      if (p.parent_ship !== undefined && typeof p.parent_ship !== 'number')
        w(`${pid}: parent_ship is "${p.parent_ship}" (expected number)`);
      if (p.inventory) {
        if (!Array.isArray(p.inventory.slots))
          e(`${pid}: inventory.slots is not an array`);
        else {
          for (let si = 0; si < p.inventory.slots.length; si++) {
            const slot = p.inventory.slots[si];
            if (slot !== null && typeof slot === 'object' && typeof slot.item === 'undefined')
              w(`${pid}: inventory.slots[${si}] missing "item" field`);
          }
        }
      }
    }

    // ── 6. NPCs ─────────────────────────────────────────────────────────────
    for (const n of (gs.npcs ?? [])) {
      const nid = `npc[${n.id ?? '?'}]`;
      if (!Number.isFinite(n.x)) e(`${nid}: x=${n.x} is not finite`);
      if (!Number.isFinite(n.y)) e(`${nid}: y=${n.y} is not finite`);
    }

    // ── 7. Print summary ────────────────────────────────────────────────────
    const sep = '─'.repeat(72);
    const errors = issues.filter(i => i.level === 'error');
    const warns  = issues.filter(i => i.level === 'warn');

    console.group(
      `%c🔍 analyzeGameState  tick=${gs.tick ?? '?'}  ` +
      `ships=${gs.ships?.length ?? 0}  players=${gs.players?.length ?? 0}  npcs=${gs.npcs?.length ?? 0}`,
      errors.length ? ERR : warns.length ? WARN : OK
    );
    if (errors.length === 0 && warns.length === 0) {
      console.log('%c✅ No issues found', OK);
    } else {
      if (errors.length) {
        console.log(`%c❌ ${errors.length} error(s):`, ERR);
        for (const i of errors) console.error('  •', i.msg);
      }
      if (warns.length) {
        console.log(`%c⚠ ${warns.length} warning(s):`, WARN);
        for (const i of warns) console.warn('  •', i.msg);
      }
    }
    console.log(sep);
    console.groupEnd();
  }
  
  /**
   * Set handler for world state updates
   */
  setWorldStateHandler(handler: (worldState: WorldState) => void): void {
    this.onWorldStateReceived = handler;
  }

  /**
   * Set handler for connection state changes  
   */
  setConnectionStateHandler(handler: (state: ConnectionState) => void): void {
    this.onConnectionStateChanged = handler;
  }

  /**
   * Get network statistics
   */
  getStats(): NetworkStats {
    return {
      ping: this.latency,
      packetLoss: 0, // WebSocket handles reliability
      bytesReceived: this.stats.bytesReceived,
      bytesSent: this.stats.bytesSent,
      messagesReceived: this.stats.messagesReceived,
      messagesSent: this.stats.messagesSent,
      averageFPS: 0 // TODO: Calculate from server updates
    };
  }
  
  /**
   * Connect to the game server
   */
  async connect(playerName?: string, accessToken?: string): Promise<void> {
    if (playerName) {
      this.playerName = playerName;
    }
    if (accessToken) {
      this.accessToken = accessToken;
    }
    
    // Stronger protection against duplicate connections
    if (this.isConnecting || 
        this.connectionState === ConnectionState.CONNECTING || 
        this.connectionState === ConnectionState.CONNECTED) {
      console.log(`⚠️ Already connecting/connected (state: ${this.connectionState}, isConnecting: ${this.isConnecting}), skipping duplicate connection attempt`);
      return;
    }
    
    this.isConnecting = true;
    
    // Close any existing socket before creating new one
    if (this.socket) {
      console.log(`🔌 Closing existing socket before reconnection`);
      this.socket.close();
      this.socket = null;
    }
    
    this.connectionState = ConnectionState.CONNECTING;
    const connectionId = Math.random().toString(36).substr(2, 9);
    console.log(`🌐 [${connectionId}] Connecting to server: ${this.config.serverUrl}`);
    
    try {
      // Create WebSocket connection
      console.log(`🔌 [${connectionId}] Creating new WebSocket connection`);
      console.log(`🔌 [${connectionId}] URL: ${this.config.serverUrl}`);
      console.log(`🔌 [${connectionId}] Current socket state: ${this.socket ? 'exists' : 'null'}`);
      this.socket = new WebSocket(this.config.serverUrl);
      
      // Set up event handlers
      this.setupSocketHandlers();
      
      // Wait for connection with timeout
      await this.waitForConnection();
      
      // Send handshake
      await this.sendHandshake();
      
      // Start heartbeat
      this.startHeartbeat();
      
      this.connectionState = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      this.isConnecting = false; // Reset connection flag on success
      
      console.log('✅ Connected to server');
      this.onConnectionStateChanged?.(ConnectionState.CONNECTED);
      
    } catch (error) {
      this.connectionState = ConnectionState.ERROR;
      this.isConnecting = false; // Reset connection flag on error
      console.error('❌ Failed to connect to server:', error);
      
      // Attempt reconnection
      this.scheduleReconnect();
      throw error;
    }
  }
  
  /**
   * Disconnect from the server
   */
  disconnect(): void {
    console.log('🔌 Disconnecting from server...');
    
    this.connectionState = ConnectionState.DISCONNECTED;
    this.isConnecting = false; // Reset connection flag on disconnect
    
    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    
    // Close socket
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    
    this.onConnectionStateChanged?.(ConnectionState.DISCONNECTED);
    console.log('✅ Disconnected from server');
  }
  
  /**
   * Send handshake to server after connection
   */
  private async sendHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('No socket available'));
        return;
      }
      
      // Send JSON handshake that server expects
      const handshakeMessage: Record<string, unknown> = {
        type: 'handshake',
        playerName: this.playerName,
        protocolVersion: 1,
        timestamp: Date.now()
      };
      if (this.accessToken) {
        handshakeMessage.token = this.accessToken;
      }
      const handshakeJson = JSON.stringify(handshakeMessage);
      
      // Set timeout for handshake response
      const timeout = setTimeout(() => {
        console.warn('⚠️ Handshake timeout - server may not be responding');
        // Don't reject, just continue - server might be processing
        resolve();
      }, 5000);
      
      // Wait for handshake_response or any acknowledgment
      const originalHandler = this.socket.onmessage;
      this.socket.onmessage = (event) => {
        try {
          const data = event.data;
          console.log('📨 Handshake response received:', data);
          
          // Parse JSON response and look for player_id assignment
          let response: any = {};
          try {
            response = JSON.parse(data);
          } catch {
            // Handle text responses as backup
            response = { type: 'text', message: data };
          }
          
          // Check for handshake_response with player_id
          if (response.type === 'handshake_response' && response.player_id) {
            this.assignedPlayerId = response.player_id;
            console.log(`🎮 Server assigned player ID: ${this.assignedPlayerId}`);
            clearTimeout(timeout);
            this.socket!.onmessage = originalHandler;
            console.log('🤝 Handshake completed - Player ID received');
            this.requestGameState();
            this.requestStructures();
            resolve();
          } else if (data.includes('message_ack') || data.includes('status') || data.startsWith('PONG')) {
            // Fallback acknowledgment
            clearTimeout(timeout);
            this.socket!.onmessage = originalHandler;
            console.log('🤝 Handshake completed - Server acknowledged');
            this.requestGameState();
            this.requestStructures();
            resolve();
          } else {
            // Non-handshake message arrived first (e.g. ISLANDS/STRUCTURES sent before
            // handshake_response by an older server build). Restore the main handler and
            // forward the current event through it so no data is lost.
            clearTimeout(timeout);
            this.socket!.onmessage = originalHandler;
            console.log('🤝 Handshake completed (server responded with non-handshake first)');
            // Forward this event to the main handler so ISLANDS/STRUCTURES aren't dropped
            if (originalHandler) {
              try { originalHandler.call(this.socket!, event); } catch { /* ignore */ }
            }
            this.requestGameState();
            this.requestStructures();
            resolve();
          }
        } catch (error) {
          console.warn('Error during handshake:', error);
          // Still continue - server is responding
          clearTimeout(timeout);
          this.socket!.onmessage = originalHandler;
          console.log('🤝 Handshake completed (server alive)');
          this.requestGameState();
          this.requestStructures();
          resolve();
        }
      };
      
      // Send the JSON handshake
      try {
        this.socket.send(handshakeJson);
        this.stats.messagesSent++;
        this.stats.bytesSent += handshakeJson.length;
        console.log('📤 Sent handshake:', handshakeJson);
      } catch (error) {
        clearTimeout(timeout);
        console.error('❌ Failed to send handshake:', error);
        reject(error);
      }
    });
  }
  
  /**
   * Request current game state from server
   */
  private requestGameState(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send('STATE');
      this.stats.messagesSent++;
      this.stats.bytesSent += 5;
      console.log('📤 Requested game state from server');
    }
  }

  /** Ask the server to re-send the full placed-structures list. */
  requestStructures(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send('GET_STRUCTURES');
      this.stats.messagesSent++;
      this.stats.bytesSent += 14;
      console.log('📤 Requested structures list from server');
    }
  }
  
  /**
   * Send input frame to server
   */
  sendInput(inputFrame: InputFrame): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      console.log(`🚫 Cannot send input - Connection state: ${this.connectionState}, Socket: ${this.socket ? 'exists' : 'null'}`);
      return; // Not connected
    }

    // Temporarily disable input filtering to debug - send all input frames
    const hasMovement = inputFrame.movement.lengthSq() > 0;
    const hasActions = inputFrame.actions !== 0;
    const shouldSend = true; // Always send for debugging
    
    if (shouldSend) {
      // Validate movement vector before sending
      const movementMagnitude = Math.sqrt(inputFrame.movement.lengthSq());
      if (movementMagnitude > 1.1) { // Allow small tolerance for floating point precision
        console.warn(`⚠️ Movement vector too large: ${movementMagnitude.toFixed(3)}, normalizing...`);
        inputFrame.movement = inputFrame.movement.normalize();
      }
      
      // Server expects movement as {x, y} object and rotation in radians
      const message: InputMessage = {
        type: MessageType.INPUT_FRAME,
        timestamp: Date.now(),
        sequenceId: this.messageSequenceId++,
        tick: inputFrame.tick,
        rotation: inputFrame.rotation,
        movement: {
          x: inputFrame.movement.x,
          y: inputFrame.movement.y
        },
        actions: inputFrame.actions,
        is_sprinting: (inputFrame.actions & PlayerActions.SPRINT) !== 0,
        view_radius: this.viewRadius > 0 ? Math.round(this.viewRadius) : undefined
      };
      
      this.sendMessage(message);
    }
  }
  
  /**
   * Send movement state change (HYBRID PROTOCOL)
   * Only send when movement keys change, not every frame
   */
  sendMovementState(movement: Vec2, isMoving: boolean, isSprinting: boolean = false, position?: Vec2, localPosition?: Vec2): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: MovementStateMessage = {
      type: MessageType.MOVEMENT_STATE,
      timestamp: Date.now(),
      movement: {
        x: movement.x,
        y: movement.y
      },
      is_moving: isMoving,
      is_sprinting: isSprinting,
      // Semi-authority: report the client's authoritative world position so the
      // server can adopt it for land/dock walking (see MovementStateMessage docs).
      ...(position ? { px: Math.round(position.x * 10) / 10, py: Math.round(position.y * 10) / 10 } : {}),
      ...(localPosition ? {
        plx: Math.round(localPosition.x * 10) / 10,
        ply: Math.round(localPosition.y * 10) / 10,
      } : {}),
    };

    this.sendMessage(message);
  }

  /**
   * Send rotation update (HYBRID PROTOCOL)
   * Only send when rotation changes >3 degrees
   */
  sendRotationUpdate(rotation: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: RotationUpdateMessage = {
      type: MessageType.ROTATION_UPDATE,
      timestamp: Date.now(),
      rotation: rotation
    };

    this.sendMessage(message);
  }

  /**
   * Send action event (HYBRID PROTOCOL)
   * Send immediately when actions occur
   */
  sendAction(action: string, target?: Vec2): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: ActionEventMessage = {
      type: MessageType.ACTION_EVENT,
      timestamp: Date.now(),
      action: action,
      target: target ? {
        x: target.x,
        y: target.y
      } : undefined
    };

    if (action !== 'block') {
      console.log(`⚡ Action: ${action}${target ? ` at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})` : ''}`);
    }
    this.sendMessage(message);
  }

  /** Fire the grapple hook toward a world-space target.
   *  charge: 0.0 (min range) … 1.0 (full range). */
  sendFireGrapple(target: Vec2, charge: number = 1.0): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg = {
      type: MessageType.ACTION_EVENT,
      timestamp: Date.now(),
      action: 'fire_grapple',
      target: { x: target.x, y: target.y },
      charge: Math.max(0, Math.min(1, charge)),
    };
    console.log(`🪝 fire_grapple charge=${charge.toFixed(2)} at (${target.x.toFixed(1)},${target.y.toFixed(1)})`);
    this.sendMessage(msg as any);
  }

  /** Release the currently active grapple hook. */
  sendReleaseGrapple(): void {
    this.sendAction('release_grapple');
  }

  /** Start reeling the grapple rope in or out. */
  sendGrappleReelStart(direction: 'in' | 'out'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.ACTION_EVENT, timestamp: Date.now(), action: 'grapple_reel_start', direction } as any);
  }

  /** Stop reeling — rope stays at current length. */
  sendGrappleReelStop(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.ACTION_EVENT, timestamp: Date.now(), action: 'grapple_reel_stop' } as any);
  }

  sendBoardShip(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.ACTION_EVENT, timestamp: Date.now(), action: 'board_ship' } as any);
  }

  /**
   * Send ship sail control (when mounted to helm)
   * W/S keys adjust desired sail openness
   */
  sendShipSailControl(desiredOpenness: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    // Clamp to 0-100 and round to nearest 10
    const clampedOpenness = Math.max(0, Math.min(100, Math.round(desiredOpenness / 10) * 10));

    const message: ShipSailControlMessage = {
      type: MessageType.SHIP_SAIL_CONTROL,
      timestamp: Date.now(),
      desired_openness: clampedOpenness
    };

    console.log(`⛵ Sail control: ${clampedOpenness}% openness`);
    this.sendMessage(message);
  }

  /**
   * Send ship rudder control (when mounted to helm)
   * A/D keys control turning
   */
  sendShipRudderControl(turningLeft: boolean, turningRight: boolean, movingBackward: boolean = false): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: ShipRudderControlMessage = {
      type: MessageType.SHIP_RUDDER_CONTROL,
      timestamp: Date.now(),
      turning_left: turningLeft,
      turning_right: turningRight,
      moving_backward: movingBackward
    };

    console.log(`🚢 Rudder: ${turningLeft ? 'LEFT' : turningRight ? 'RIGHT' : 'STRAIGHT'}${movingBackward ? ' REVERSE' : ''}`);
    this.sendMessage(message);
  }

  /**
   * Send ship sail angle control (when mounted to helm)
   * Shift+A/D keys rotate sails
   */
  sendShipSailAngleControl(desiredAngle: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    // Clamp to -60 to +60 and round to nearest 6
    const clampedAngle = Math.max(-60, Math.min(60, Math.round(desiredAngle / 6) * 6));

    const message: ShipSailAngleControlMessage = {
      type: MessageType.SHIP_SAIL_ANGLE_CONTROL,
      timestamp: Date.now(),
      desired_angle: clampedAngle
    };

    console.log(`🌀 Sail angle: ${clampedAngle}°`);
    this.sendMessage(message);
  }

  private lastAimSentTime: number = 0;
  private readonly AIM_SEND_INTERVAL_MS = 50; // 20 Hz max

  /**
   * Send cannon aim update (right-click hold + mouse move)
   * Aim angle is relative to ship rotation
   */
  sendCannonAim(aimAngle: number, activeGroups: number[] = []): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const now = Date.now();
    if (now - this.lastAimSentTime < this.AIM_SEND_INTERVAL_MS) {
      return; // throttle to 20 Hz
    }
    this.lastAimSentTime = now;

    const message: CannonAimMessage = {
      type: MessageType.CANNON_AIM,
      timestamp: now,
      aim_angle: aimAngle,
      active_groups: activeGroups
    };

    this.sendMessage(message);
  }

  /**
   * Send swivel gun aim direction.
   * @param aimAngle - Ship-relative aim angle in radians
   */
  sendSwivelAim(aimAngle: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const now = Date.now();
    if (now - this.lastAimSentTime < this.AIM_SEND_INTERVAL_MS) {
      return; // throttle to 20 Hz
    }
    this.lastAimSentTime = now;

    const message: SwivelAimMessage = {
      type: MessageType.SWIVEL_AIM,
      timestamp: now,
      aim_angle: aimAngle,
    };

    this.sendMessage(message);
  }

  /**
   * Send cannon fire command
   * @param cannonIds - Specific cannon IDs to fire, or undefined for aimed cannons
   * @param fireAll - True if double-click (fire all cannons)
   * @param ammoType - 0 = cannonball, 1 = bar shot
   * @param freefire - True for freefire/targetfire groups (server skips aim-angle check)
   */
  sendCannonFire(cannonIds?: number[], fireAll: boolean = false, ammoType: number = 0, freefire: boolean = false): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: CannonFireMessage = {
      type: MessageType.CANNON_FIRE,
      timestamp: Date.now(),
      weapon_ids: cannonIds,
      fire_all: fireAll,
      freefire: freefire || undefined,
      ammo_type: ammoType
    };

    console.log(`💥 Cannon fire: ${fireAll ? 'ALL' : cannonIds ? `IDs ${cannonIds.join(',')}` : 'aimed'}${freefire ? ' FREEFIRE' : ''}`);
    this.sendMessage(message);
  }

  /**
   * Call this whenever a group's mode, cannon assignment, or target changes.
   *
   * @param groupIndex     0–9 group slot
   * @param mode           New firing mode
   * @param cannonIds      Module IDs of cannons in this group
   * @param targetShipId   Server ship entity ID for targetfire; 0 otherwise
   */
  sendCannonGroupConfig(
    groupIndex: number,
    mode: 'aiming' | 'freefire' | 'haltfire' | 'targetfire',
    cannonIds: number[],
    targetShipId: number = 0
  ): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }
    const message: CannonGroupConfigMessage = {
      type: MessageType.CANNON_GROUP_CONFIG,
      timestamp: Date.now(),
      group_index: groupIndex,
      mode,
      weapon_ids: cannonIds,
      target_ship_id: targetShipId
    };
    console.log(`🎯 Group ${groupIndex} config → mode=${mode} weapons=[${cannonIds.join(',')}] target=${targetShipId}`);
    this.sendMessage(message);
  }

  /** Toggle gunports open/closed for all cannons in the given weapon group indices (R key at helm). */
  sendGroupGunportToggle(groupIndices: number[]): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'gunport_group_toggle', groups: groupIndices, timestamp: Date.now() }));
    console.log(`🔳 Group gunport toggle → groups=[${groupIndices.join(',')}]`);
  }

  /** Rename a weapon group on the given ship. Max 23 chars. */
  sendRenameWeaponGroup(shipId: number, groupIndex: number, name: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'rename_weapon_group', shipId, groupIndex, name: name.slice(0, 23), timestamp: Date.now() }));
  }

  /**
   * Force-reload the player's manned cannon, discarding the current round.
   * Tells the server to reset the reload timer so the cannon reloads immediately
   * into the newly-selected ammo type.
   */
  sendForceReload(ammoType: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: 'cannon_force_reload' as any, timestamp: Date.now(), ammo_type: ammoType });
    console.log(`⚡ Force reload sent (ammo_type=${ammoType})`);
  }

  /**
   * Notify the server that the player selected a different hotbar slot.
   */
  sendSlotSelect(slot: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.SLOT_SELECT, timestamp: Date.now(), slot });
  }

  /** Swap two inventory slots. Server will swap items and broadcast updated inventory. */
  sendInvSwap(slotA: number, slotB: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.INV_SWAP, timestamp: Date.now(), slot_a: slotA, slot_b: slotB });
  }

  sendDropItem(slot: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.DROP_ITEM, timestamp: Date.now(), slot });
  }

  sendDropSchematic(index: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.DROP_SCHEMATIC, timestamp: Date.now(), index });
  }

  sendDropResources(kind: string, amount: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.DROP_RESOURCES, timestamp: Date.now(), kind, amount });
  }

  sendChatMessage(channel: string, text: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.CHAT_MESSAGE, timestamp: Date.now(), channel, text });
  }

  sendPickupItem(itemId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PICKUP_ITEM, timestamp: Date.now(), item_id: itemId });
  }

  /**
   * Notify the server that the player unequipped (deselected) their active hotbar slot.
   * Server sets active_slot = 255 as a "nothing equipped" sentinel.
   */
  sendUnequip(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.UNEQUIP, timestamp: Date.now() });
  }

  /**
   * Equip an armour item from the given inventory slot index.
   * The server determines which equipment slot based on the item type.
   */
  sendEquipArmor(slotIdx: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'equip_armor', slot_idx: slotIdx, timestamp: Date.now() }));
  }

  /**
   * Unequip an armour piece from the given equipment slot name
   * (helm | torso | legs | feet | hands | shield).
   * The item is returned to the player's inventory.
   */
  sendUnequipArmor(slot: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'unequip_armor', slot, timestamp: Date.now() }));
  }

  /**
   * Give an item directly to the local player (admin/test helper).
   * Sends a give_item message to the server.
   */
  sendGiveItem(slot: number, itemId: number, quantity: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.GIVE_ITEM, timestamp: Date.now(), slot, item: itemId, quantity });
  }

  /**
   * Request the server to place a plank in a missing hull slot.
   * Server picks the first destroyed plank (100-109) and restores it, consuming 1 ITEM_PLANK.
   */
  sendPlacePlank(shipId: number, sectionName: string, segmentIndex: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto', bpIndex?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: PlacePlankMessage = { type: MessageType.PLACE_PLANK, timestamp: Date.now(), shipId, sectionName, segmentIndex, resource_source: resourceSource };
    if (bpIndex !== undefined && bpIndex >= 0) msg.bp_index = bpIndex;
    this.sendMessage(msg);
  }

  /**
   * Request the server to repair the most damaged plank on the player's ship.
   * Consumes 1 ITEM_REPAIR_KIT from the player's inventory.
   */
  sendRepairPlank(shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.REPAIR_PLANK, timestamp: Date.now(), shipId });
  }

  /**
   * Request the server to permanently remove a ship module (axe + E).
   * Server validates proximity and company before removing.
   */
  sendDemolishModule(shipId: number, moduleId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.DEMOLISH_MODULE, timestamp: Date.now(), shipId, moduleId }));
    console.log(`🪓 Demolish module ${moduleId} on ship ${shipId}`);
  }

  /** Request server to salvage a ship module and grant loot. */
  sendSalvageModule(shipId: number, moduleId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'salvage_module', timestamp: Date.now(), shipId, moduleId }));
    console.log(`🪓 Salvage module ${moduleId} on ship ${shipId}`);
  }

  /**
   * Request server to harvest the nearest wood resource on the current island.
   * Requires the axe to be in the active hotbar slot.
   * Server grants planks and sends harvest_success / harvest_failure in response.
   */
  sendHarvestResource(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.HARVEST_RESOURCE, timestamp: Date.now() });
  }

  /** Request server to harvest the nearest fiber plant on the current island. */
  sendHarvestFiber(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'harvest_fiber', timestamp: Date.now() }));
  }

  /** Request server to mine the nearest rock outcrop on the current island. */
  sendHarvestRock(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'harvest_rock', timestamp: Date.now() }));
  }

  /** Request server to mine the nearest boulder on the current island (requires pickaxe). */
  sendHarvestBoulder(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'harvest_boulder', timestamp: Date.now() }));
  }

  /** Request server to pick up stone from the nearest rock outcrop (no tool required). */
  sendHarvestStone(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'harvest_stone', timestamp: Date.now() }));
  }

  sendCollectTombstone(id: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'collect_tombstone', id, timestamp: Date.now() }));
  }

  /** Ask the server to open the tombstone storage menu (sends back tombstone_items). */
  sendTombstoneOpen(id: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'tombstone_open', id, timestamp: Date.now() }));
  }

  /** Take one inventory slot from a tombstone. */
  sendTombstoneTakeSlot(tombstoneId: number, slot: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'tombstone_take_slot', id: tombstoneId, slot, timestamp: Date.now() }));
  }

  /**
   * Ask the server to place a structure (wooden_floor or workbench) at world (x, y).
   * The server validates that the player is on an island, has the item, and for
   * workbench that a floor tile is close enough.
   */
  sendPlaceStructure(structureType: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag' | 'chest' | 'bed', x: number, y: number, rotationDeg = 0, underConstruction = false, bpIndex?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: PlaceStructureMessage = { type: MessageType.PLACE_STRUCTURE, timestamp: Date.now(), structure_type: structureType, x, y, rotation: rotationDeg };
    if (underConstruction) msg.under_construction = true;
    if (bpIndex !== undefined && bpIndex >= 0) msg.bp_index = bpIndex;
    this.sendMessage(msg);
  }

  /** Send a ship-construction action to the server. */
  sendShipyardAction(shipyardId: number, action: string, module?: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: Record<string, unknown> = { type: 'shipyard_action', shipyard_id: shipyardId, action };
    if (module) msg['module'] = module;
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * Ask the server to interact with a placed structure (e.g. open a workbench).
   */
  sendStructureInteract(structureId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.STRUCTURE_INTERACT, timestamp: Date.now(), structure_id: structureId });
  }

  /** Ask the server to lock or unlock a door (own company only). */
  sendStructureLock(structureId: number, locked: boolean): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'structure_lock', timestamp: Date.now(), structure_id: structureId, locked }));
  }

  /** Request the player's current schematic (blueprint) list from the server. */
  sendRequestSchematics(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'request_schematics', timestamp: Date.now() }));
  }

  sendRequestShipSchematics(shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'request_ship_schematics', timestamp: Date.now(), ship_id: shipId }));
  }

  sendShipSchematicDeposit(shipId: number, playerBpIndex: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({
      type: 'ship_schematic_deposit',
      timestamp: Date.now(),
      ship_id: shipId,
      player_bp_index: playerBpIndex,
    }));
  }

  sendShipSchematicWithdraw(shipId: number, poolIndex: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({
      type: 'ship_schematic_withdraw',
      timestamp: Date.now(),
      ship_id: shipId,
      pool_index: poolIndex,
    }));
  }

  sendShipSchematicReorder(shipId: number, itemId: number, order: number[]): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({
      type: 'ship_schematic_reorder',
      timestamp: Date.now(),
      ship_id: shipId,
      item: itemId,
      order,
    }));
  }

  /** Craft one item from the schematic at the given index (must be at a workbench). */
  sendCraftBlueprint(index: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'craft_blueprint', timestamp: Date.now(), index }));
  }

  sendDemolishStructure(structureId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'demolish_structure', timestamp: Date.now(), structure_id: structureId }));
  }

  /** Initiate (or, if already in progress by this player, cancel) a structure repair. */
  sendRepairStructure(structureId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'repair_structure', timestamp: Date.now(), structure_id: structureId }));
  }

  /** Send a raw crafting request to the server for the given recipe ID. */
  sendCraftItem(recipeId: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'craft_item', recipe_id: recipeId, timestamp: Date.now() }));
  }

  /**
   * Send a player command (e.g. "/spawn ship") to the server.
   * The server will reply with a `command_response` message.
   */
  sendCommand(command: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      this.onCommandResponse?.('Not connected to server.', false);
      return;
    }
    this.socket.send(JSON.stringify({ type: MessageType.COMMAND, command, timestamp: Date.now() }));
  }

  /**
   * Apply a hammer-boosted instant repair (10 000 HP) to the most damaged plank.
   * Called only after the player wins the client-side hammer minigame.
   */
  sendUseHammer(shipId: number, moduleId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.USE_HAMMER, timestamp: Date.now(), shipId, moduleId });
  }

  /** Send bucket fill result after the scoop minigame completes. */
  sendBucketFill(success: boolean, deckLevel?: number, atWell?: boolean): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({
      type: MessageType.BUCKET_FILL,
      timestamp: Date.now(),
      success,
      deckLevel,
      atWell,
    });
  }

  /** Dump water from the bucket (right-click while holding water). */
  sendBucketDump(deckLevel?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({
      type: MessageType.BUCKET_DUMP,
      timestamp: Date.now(),
      deckLevel,
    });
  }

  /**
   * Request the server to repair torn sail fibers on a specific mast.
   * Consumes 1 ITEM_REPAIR_KIT from the player's inventory.
   * mastIndex: 0=bow, 1=mid, 2=stern.
   */
  sendRepairSail(shipId: number, mastIndex: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.REPAIR_SAIL, timestamp: Date.now(), shipId, mastIndex });
  }

  /**
   * Request the server to replace a destroyed cannon on the player's ship.
   * Server finds the first missing cannon slot (base+1..base+6) and recreates it,
   * consuming 1 ITEM_CANNON from the player's inventory.
   */
  sendPlaceCannon(shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_CANNON, timestamp: Date.now(), shipId });
  }

  /**
   * Request the server to place a new cannon at an arbitrary ship-local position.
   * localX/localY are ship-relative coordinates; rotation is in radians ship-relative.
   * Consumes 1 ITEM_CANNON from the player's inventory.
   */
  sendPlaceCannonAt(shipId: number, localX: number, localY: number, rotation: number, snapIndex?: number, deckId?: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto', bpIndex?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = { type: MessageType.PLACE_CANNON_AT, timestamp: Date.now(), shipId, localX, localY, rotation, resource_source: resourceSource };
    if (snapIndex !== undefined && snapIndex >= 0 && snapIndex <= 11) msg.snapIndex = snapIndex;
    if (deckId !== undefined) msg.deckId = deckId;
    if (bpIndex !== undefined && bpIndex >= 0) msg.bp_index = bpIndex;
    this.sendMessage(msg);
  }

  /**
   * Request the server to replace a destroyed mast on the player's ship.
   * Server finds the first missing mast slot (base+7..base+9) and recreates it,
   * consuming 1 ITEM_SAIL from the player's inventory.
   */
  sendPlaceMast(shipId: number, mastIndex: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_MAST, timestamp: Date.now(), shipId, mastIndex });
  }

  /**
   * Request the server to place a new mast at an arbitrary ship-local position.
   * localX/localY are ship-relative coordinates.
   * Consumes 1 ITEM_SAIL from the player's inventory.
   */
  sendPlaceMastAt(shipId: number, localX: number, localY: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto', bpIndex?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = { type: MessageType.PLACE_MAST_AT, timestamp: Date.now(), shipId, localX, localY, resource_source: resourceSource };
    if (bpIndex !== undefined && bpIndex >= 0) msg.bp_index = bpIndex;
    this.sendMessage(msg);
  }

  /**
   * Request the server to place a new swivel gun at an arbitrary ship-local position.
   * localX/localY are ship-relative coordinates; rotation is in radians ship-relative.
   * Consumes 1 ITEM_SWIVEL from the player's inventory.
   */
  sendPlaceSwivelAt(shipId: number, localX: number, localY: number, rotation: number, deckId?: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto', bpIndex?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = { type: MessageType.PLACE_SWIVEL_AT, timestamp: Date.now(), shipId, localX, localY, rotation, resource_source: resourceSource };
    if (deckId !== undefined) msg.deckId = deckId;
    if (bpIndex !== undefined && bpIndex >= 0) msg.bp_index = bpIndex;
    this.sendMessage(msg);
  }

  /**
   * Request the server to place a resource chest at a free position on the player's ship or on land.
   * Consumes 1 ITEM_RESOURCE_CHEST from the player's inventory.
   */
  sendPlaceChestAt(shipId: number | null, localX: number, localY: number, rotation: number, deckId?: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = { type: MessageType.PLACE_CHEST_AT, timestamp: Date.now(), localX, localY, rotation, resource_source: resourceSource };
    if (shipId !== null) msg.shipId = shipId;
    if (deckId !== undefined) msg.deckId = deckId;
    this.sendMessage(msg);
  }

  sendPlaceBedAt(shipId: number | null, localX: number, localY: number, rotation: number, deckId?: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = { type: MessageType.PLACE_BED_AT, timestamp: Date.now(), localX, localY, rotation, resource_source: resourceSource };
    if (shipId !== null) msg.shipId = shipId;
    if (deckId !== undefined) msg.deckId = deckId;
    this.sendMessage(msg);
  }

  sendPlaceWellAt(
    shipId: number,
    localX: number,
    localY: number,
    rotation: number,
    deckId: number = 0,
    resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto',
  ): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = {
      type: MessageType.PLACE_WELL_AT,
      timestamp: Date.now(),
      shipId,
      localX,
      localY,
      rotation,
      deckId,
      resource_source: resourceSource,
    };
    this.sendMessage(msg);
  }

  sendPlaceWorkbenchAt(
    shipId: number,
    localX: number,
    localY: number,
    rotation: number,
    deckId?: number,
    resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto',
  ): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = {
      type: MessageType.PLACE_WORKBENCH_AT,
      timestamp: Date.now(),
      shipId,
      localX,
      localY,
      rotation,
      resource_source: resourceSource,
    };
    if (deckId !== undefined) msg.deckId = deckId;
    this.sendMessage(msg);
  }

  sendBedTravel(
    source: { islandBedId?: number; shipId?: number; moduleId?: number },
    target: { islandBedId?: number; shipId?: number; moduleId?: number },
  ): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: any = { type: MessageType.BED_TRAVEL, timestamp: Date.now() };
    if (source.islandBedId) msg.source_island_bed = source.islandBedId;
    if (source.shipId)      msg.source_ship_id = source.shipId;
    if (source.moduleId)    msg.source_module_id = source.moduleId;
    if (target.islandBedId) msg.target_island_bed = target.islandBedId;
    if (target.shipId)      msg.target_ship_id = target.shipId;
    if (target.moduleId)    msg.target_module_id = target.moduleId;
    this.sendMessage(msg);
  }

  /**
   * Transfer resources between a chest module and the player's own inventory.
   * direction: 'deposit' = player inventory → chest; 'withdraw' = chest → player inventory.
   */
  sendChestTransfer(shipId: number, moduleId: number, item: string, quantity: number, direction: 'deposit' | 'withdraw'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.CHEST_TRANSFER, timestamp: Date.now(), shipId, moduleId, item, quantity, direction });
  }

  /**
   * Transfer resources between a land chest (placed structure) and the player's pack.
   * direction: 'deposit' = player → chest; 'withdraw' = chest → player.
   */
  sendLandChestTransfer(structureId: number, item: string, quantity: number, direction: 'deposit' | 'withdraw'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.LAND_CHEST_TRANSFER, timestamp: Date.now(), structure_id: structureId, item, quantity, direction });
  }

  sendLandChestDrop(structureId: number, item: string, quantity: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.LAND_CHEST_DROP, timestamp: Date.now(), structure_id: structureId, item, quantity });
  }

  /**
   * Request the server to replace the helm if it was destroyed.
   * Consumes 1 ITEM_HELM from the player's inventory.
   */
  sendReplaceHelm(shipId: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.REPLACE_HELM, timestamp: Date.now(), shipId, resource_source: resourceSource });
  }

  /**
   * Request the server to place a missing deck module on the player's ship.
   * Consumes 1 ITEM_DECK from the player's inventory.
   */
  sendPlaceDeck(deckLevel: number = 0, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto', bpIndex?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: PlaceDeckMessage = { type: MessageType.PLACE_DECK, timestamp: Date.now(), deck_level: deckLevel, resource_source: resourceSource };
    if (bpIndex !== undefined && bpIndex >= 0) msg.bp_index = bpIndex;
    this.sendMessage(msg);
  }

  /**
   * Request the server to place a ramp at the given snap-point index on the player's ship.
   * Consumes 1 ITEM_RAMP from the player's inventory.
   */
  sendPlaceRamp(shipId: number, snapIndex: number, rotation: number = 0, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_RAMP, timestamp: Date.now(), shipId, snapIndex, rotation, resource_source: resourceSource });
  }

  /**
   * Request the server to place a hatch cover at the given snap-point index on the player's ship.
   * Consumes 1 ITEM_WOOD_CEILING from the player's inventory.
   * Mutually exclusive with a ramp at the same snap point.
   */
  sendPlaceHatchCover(shipId: number, snapIndex: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_HATCH_COVER, timestamp: Date.now(), shipId, snapIndex, resource_source: resourceSource });
  }

  /**
   * Request the server to place a gunport door at the given snap-point index (0-11) on the player's ship.
   * Consumes 1 ITEM_DOOR from the player's inventory.
   */
  sendPlaceGunport(shipId: number, snapIndex: number, resourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto'): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_GUNPORT, timestamp: Date.now(), shipId, snapIndex, resource_source: resourceSource });
  }

  /**
   * Request the server to toggle a gunport open/closed.
   * Can be called when player is near a gunport (E-key), mounted at a cannon at that gunport (R-key),
   * or at the helm with a weapon group selected (R-key toggles all gunports in the group).
   */
  sendToggleGunport(shipId: number, gunportId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.TOGGLE_GUNPORT, timestamp: Date.now(), shipId, gunportId });
  }

  /**
   * Notify the server when the local player's deck-level state machine
   * transitions (fall through hole / climb ramp). The server uses this to
   * filter per-deck module collisions (lower deck → only masts collide).
   */
  sendPlayerSetDeck(deckLevel: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLAYER_SET_DECK, timestamp: Date.now(), deckLevel });
  }

  /**
   * Send crew task assignments from the manning-priority panel.
   * One message per NPC — server uses task to drive WorldNpc state transitions.
   */
  sendCrewAssign(shipId: number, assignments: Array<{ npcId: number; task: string }>): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    for (const { npcId, task } of assignments) {
      this.sendMessage({
        type: MessageType.CREW_ASSIGN,
        timestamp: Date.now(),
        ship_id: shipId,
        npc_id: npcId,
        task,
      });
    }
  }

  /**
   * Recruit a neutral (company 0) NPC into the player's company.
   * The NPC must be free-standing in the world (shipId 0, companyId 0).
   */
  sendNpcRecruit(npcId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.NPC_RECRUIT, timestamp: Date.now(), npcId }));
  }

  /**
   * Move a recruited NPC aboard the player's current ship.
   * The NPC must already belong to the player's company.
   */
  sendNpcMoveAboard(npcId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.NPC_MOVE_ABOARD, timestamp: Date.now(), npcId }));
  }

  /**
   * Lock or unlock an NPC to their current module.
   * When locked the crew panel and auto cannon-sector dispatch cannot reassign them.
   */
  sendNpcLock(npcId: number, locked: boolean): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.NPC_LOCK, timestamp: Date.now(), npcId, locked }));
  }

  /**
   * Direct an NPC to a specific module on their ship by module ID.
   * Clears any existing task lock so the NPC walks to the commanded post.
   */
  sendNpcGotoModule(npcId: number, moduleId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.NPC_GOTO_MODULE, timestamp: Date.now(), npcId, moduleId }));
  }

  /**
   * Dismiss whichever NPC is currently stationed at a cannon/swivel module,
   * freeing the slot so the player can immediately mount it.
   */
  sendDismissNpc(moduleId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'dismiss_npc', timestamp: Date.now(), moduleId }));
  }

  /**
   * Walk an NPC to a world position or board/walk on a specific ship.
   * shipId=0  → detach from current ship, walk to world coords.
   * shipId>0  → attach to that ship and walk to the clicked on-deck position.
   */
  sendNpcMoveToPos(npcId: number, worldX: number, worldY: number, shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({
      type: MessageType.NPC_MOVE_TO_POS, timestamp: Date.now(),
      npcId, worldX, worldY, shipId,
    }));
  }

  /**
   * Request the server to spend XP upgrading one attribute on the player's ship.
   * attribute must be one of: 'weight' | 'resistance' | 'damage' | 'crew' | 'sturdiness'
   */
  sendUpgradeShipAttribute(shipId: number, attribute: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'upgrade_ship', shipId, attribute }));
  }

  sendUnclaimShip(shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'unclaim_ship', shipId }));
  }

  sendClaimShip(shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'claim_ship', shipId }));
  }

  sendPlantClaimFlag(shipId: number, x?: number, y?: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: Record<string, unknown> = { type: 'plant_claim_flag', shipId };
    if (x !== undefined && y !== undefined) { msg.x = x; msg.y = y; }
    this.socket.send(JSON.stringify(msg));
  }

  sendRemoveClaimFlag(shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'remove_claim_flag', shipId }));
  }

  sendNpcUnclaim(npcId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'npc_unclaim', npcId }));
  }

  /**
   * Request the server to spend NPC XP upgrading one stat.
   * stat must be one of: 'health' | 'damage' | 'stamina' | 'weight'
   */
  sendCrewUpgrade(npcId: number, stat: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'upgrade_crew_stat', npcId, stat }));
  }

  sendCreateCompany(name: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'create_company', name }));
  }

  sendJoinCompany(companyId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'join_company', companyId }));
  }

  /**
   * Request the server to spend a player stat point upgrading one player stat.
   * stat must be one of: 'health' | 'damage' | 'stamina' | 'weight'
   */
  sendPlayerStatUpgrade(stat: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.UPGRADE_PLAYER_STAT, stat }));
  }

  sendPlayerLevelUp(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.PLAYER_LEVEL_UP }));
  }

  /** Send a respawn request to the server. */
  sendRespawnRequest(choice: {
    islandId?: number;
    islandBedId?: number;
    shipId?: number;
    moduleId?: number;
  }): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    const msg: Record<string, unknown> = { type: MessageType.RESPAWN_REQUEST };
    if (choice.islandBedId !== undefined) msg.islandBedId = choice.islandBedId;
    if (choice.shipId !== undefined && choice.moduleId !== undefined) {
      msg.shipId = choice.shipId;
      msg.moduleId = choice.moduleId;
    } else if (choice.islandId !== undefined) {
      msg.islandId = choice.islandId;
    }
    this.socket.send(JSON.stringify(msg));
  }

  sendRenameShip(shipId: number, name: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: MessageType.RENAME_SHIP, shipId, name: name.slice(0, 31) }));
  }

  /**
   * Get current network statistics
   */
  getNetworkStats(): NetworkStats {
    return { ...this.stats };
  }
  
  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }
  
  /**
   * Get the server-assigned player ID
   */
  getAssignedPlayerId(): number | null {
    return this.assignedPlayerId;
  }
  
  // Private methods
  
  private setupSocketHandlers(): void {
    if (!this.socket) return;
    
    this.socket.onopen = (_event) => {
      console.log('🔗 WebSocket opened');
    };
    
    this.socket.onmessage = (event) => {
      try {
        const data = event.data;
        
        // Handle both JSON and text responses from server
        let message: any;
        if (data.startsWith('{')) {
          // JSON response
          try {
            message = JSON.parse(data);
          } catch (parseError) {
            console.warn('Failed to parse JSON message:', data);
            return;
          }
        } else {
          // Text response (like PONG, WELCOME) - convert to expected format
          if (data === 'PONG') {
            message = {
              type: 'pong',
              timestamp: Date.now(),
              sequenceId: this.messageSequenceId - 1
            };
          } else if (data.startsWith('WELCOME')) {
            message = {
              type: 'welcome',
              message: data,
              timestamp: Date.now()
            };
          } else if (data.startsWith('GAME_STATE:')) {
            // Parse game state JSON
            try {
              const stateJson = data.substring(11); // Remove "GAME_STATE:" prefix
              const gameState = JSON.parse(stateJson);
              message = {
                type: 'GAME_STATE',
                ...gameState,
                timestamp: Date.now()
              };
            } catch (parseError) {
              const raw = data.substring(11);
              const head = raw.substring(0, 300);
              const tail = raw.length > 300 ? `…${raw.substring(raw.length - 100)}` : '';
              console.error(
                `❌ [GAME_STATE] JSON.parse failed (payload ${raw.length} bytes)\n` +
                `  Error : ${parseError}\n` +
                `  Head  : ${head}${tail}`
              );
              return;
            }
          } else {
            // Unknown text message - log and continue
            console.log('📦 Server text message:', data);
            message = {
              type: 'text',
              message: data,
              timestamp: Date.now()
            };
          }
        }
        
        this.handleMessage(message);
        this.stats.messagesReceived++;
        this.stats.bytesReceived += data.length;
      } catch (error) {
        console.error('Failed to process message:', error, 'Data:', event.data);
        // Still count the message for stats
        this.stats.messagesReceived++;
        this.stats.bytesReceived += event.data.length;
      }
    };
    
    this.socket.onclose = (event) => {
      console.log('🔌 WebSocket closed:', event.code, event.reason);
      
      if (this.connectionState === ConnectionState.CONNECTED) {
        // Unexpected disconnection - attempt reconnect
        this.connectionState = ConnectionState.DISCONNECTED;
        this.onConnectionStateChanged?.(ConnectionState.DISCONNECTED);
        this.scheduleReconnect();
      }
    };
    
    this.socket.onerror = (event) => {
      console.error('❌ WebSocket error:', event);
      this.connectionState = ConnectionState.ERROR;
    };
  }
  
  private async waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('No socket created'));
        return;
      }
      
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, this.config.timeoutDuration);
      
      this.socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      
      this.socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Connection failed'));
      };
    });
  }
  
  private handleMessage(message: any): void {
    switch (message.type) {
      case MessageType.WORLD_STATE:
      case MessageType.SNAPSHOT:
        if (message.worldState) {
          this.onWorldStateReceived?.(message.worldState);
        }
        break;
        
      case 'GAME_STATE': // Handle server's GAME_STATE response
        // Convert server GAME_STATE to client WorldState format
        try {
        const worldState: WorldState = {
          tick: message.tick || 0,
          timestamp: Date.now(),
          ships: (message.ships || []).map((ship: any) => {
            // Use per-ship cached template — created once per ship_id to avoid
            // recreating hull curve geometry on every tick.
            // Plank IDs in the template are stamped to match the server's MID encoding:
            //   MID(ship_seq, MODULE_OFFSET_PLANK(i)) = (ship_seq << 8) | (0x0C + i)
            // The server sends "seq" explicitly; on older builds fall back to the low byte of ship_id.
            const shipId = ship.id || 0;
            if (!this._shipTemplates.has(shipId)) {
              const s = createShipAtPosition(Vec2.from(0, 0), 0);
              const shipSeq = (ship.seq !== undefined ? ship.seq : shipId) & 0xFF;
              const MID_PLANK_BASE  = 0x0C;           // MODULE_OFFSET_PLANK(0)
              const MID_DECK_LOWER  = 0x16;           // MODULE_OFFSET_DECK_LOWER
              const MID_DECK_UPPER  = 0x17;           // MODULE_OFFSET_DECK_UPPER
              let plankIdx = 0;
              s.modules = s.modules.map(m => {
                if (m.kind === 'plank') {
                  const newId = (shipSeq << 8) | (MID_PLANK_BASE + plankIdx++);
                  return { ...m, id: newId };
                }
                if (m.kind === 'deck') {
                  // Assign distinct IDs per deck level so hammer targeting works correctly
                  const deckOff = m.deckId === 1 ? MID_DECK_UPPER : MID_DECK_LOWER;
                  return { ...m, id: (shipSeq << 8) | deckOff };
                }
                return m;
              });
              this._shipTemplates.set(shipId, {
                planks: s.modules.filter(m => m.kind === 'plank'),
                deck:   s.modules.filter(m => m.kind === 'deck'),
                ship:   s,
              });
            }
            const tmpl = this._shipTemplates.get(shipId)!;
            
            // Parse modules from server if available
            // Server sends: modules: [{id, typeId, x, y, rotation}, ...]
            // Each module has:
            //   - id: unique module identifier
            //   - typeId: numeric type (0=HELM, 1=SEAT, 2=CANNON, 3=MAST, 5=LADDER, 6=PLANK, 7=DECK)
            //   - x, y: position relative to ship center (in client coordinates)
            //   - rotation: module rotation in radians
            
            // IMPORTANT: Planks and deck are client-generated from hull geometry
            // Server only sends health/status data for planks
            // Gameplay modules (cannons, masts, helm) come with full transform data
            
            let serverModules: ShipModule[] | undefined;
            if (ship.modules && Array.isArray(ship.modules)) {
              // Separate gameplay modules from structural modules
              const gameplayModules: ShipModule[] = [];
              const plankHealthBuf = this._plankHealthBuf;
              plankHealthBuf.clear();
              // Track health per deck_id (0=lower, 1=upper) — replaced single-deck variables
              const deckHealthMap = new Map<number, { health: number; targetHealth: number; maxHealth: number; stateBits: number; qualityTier?: number; qualityDurabilityQ8?: number; qualityWeaponDmgQ8?: number }>();
              
              for (const mod of ship.modules) {
                if (mod == null) {
                  console.warn(`⚠ [GAME_STATE] ship ${ship.id}: null/undefined module entry — skipping`);
                  continue;
                }
                if (typeof mod.id === 'undefined' || typeof mod.typeId === 'undefined') {
                  console.warn(`⚠ [GAME_STATE] ship ${ship.id}: module missing id or typeId:`, mod);
                  continue;
                }
                const kind = MODULE_TYPE_MAP.toKind(mod.typeId);
                
                if (kind === 'plank') {
                  // Plank: Server only sends health + quality, client generates positions
                  plankHealthBuf.set(mod.id, {
                    health: mod.health ?? 10000,
                    targetHealth: mod.targetHealth ?? mod.maxHealth ?? 10000,
                    maxHealth: mod.maxHealth ?? 10000,
                    qualityTier:         typeof mod.qt === 'number' && mod.qt >= 1 ? mod.qt : undefined,
                    qualityDurabilityQ8: typeof mod.qd === 'number' ? mod.qd : undefined,
                    qualityWeaponDmgQ8:  typeof mod.qw === 'number' ? mod.qw : undefined,
                  });
                } else if (kind === 'deck') {
                  // Deck: client generates polygon from hull; only include if server confirms it exists
                  // AND its health is > 0. Health=0 means destroyed — treat as absent.
                  const deckHealth = mod.health ?? 1; // fall back to 1 (alive) for old server builds
                  if (deckHealth > 0) {
                    // deck_id 0=lower, 1=upper; old server (no deck_id field) defaults to 0
                    const deckId = mod.deck_id ?? 0;
                    deckHealthMap.set(deckId, {
                      health:       mod.health         ?? deckHealth,
                      targetHealth: mod.targetHealth   ?? mod.maxHealth ?? deckHealth,
                      maxHealth:    mod.maxHealth      ?? deckHealth,
                      stateBits:    mod.stateBits      ?? 0,
                      qualityTier:         typeof mod.qt === 'number' && mod.qt >= 1 ? mod.qt : undefined,
                      qualityDurabilityQ8: typeof mod.qd === 'number' ? mod.qd : undefined,
                      qualityWeaponDmgQ8:  typeof mod.qw === 'number' ? mod.qw : undefined,
                    });
                  }
                } else {
                  // Gameplay modules: Full transform data from server
                  let moduleData: any = undefined;
                  
                  if (kind === 'cannon') {
                    moduleData = {
                      kind: 'cannon',
                      aimDirection: mod.aimDir ?? 0,
                      maxAimSpeed: 1.0,
                      fireRange: 500,
                      reloadTime: 3.0,
                      timeSinceLastFire: 0,
                      ammunition: mod.ammo ?? 50,
                      maxAmmunition: 50,
                      health: mod.health ?? 8000,
                      targetHealth: mod.targetHealth ?? mod.maxHealth ?? 8000,
                      maxHealth: mod.maxHealth ?? 8000,
                      stateBits: mod.state ?? 0,
                      gunportSnapIdx: mod.gunportSnapIdx ?? 255,
                    };
                  } else if (kind === 'helm' || kind === 'steering-wheel') {
                    moduleData = {
                      kind: kind,
                      maxTurnRate: 1.0,
                      responsiveness: 0.8,
                      currentInput: Vec2.from(0, 0),
                      wheelRotation: mod.wheelRot ?? 0,
                      occupied: mod.occupied ?? false,
                      health: mod.health ?? 10000,
                      targetHealth: mod.targetHealth ?? mod.maxHealth ?? 10000,
                      maxHealth: mod.maxHealth ?? 10000,
                    };
                  } else if (kind === 'mast') {
                    moduleData = {
                      kind: 'mast',
                      sailState: 'full',
                      openness: mod.openness ?? 0,
                      angle: mod.sailAngle ?? 0,
                      windEfficiency: mod.windEfficiency ?? 1.0,
                      fiberHealth: mod.fiberHealth ?? 15000,
                      fiberMaxHealth: mod.fiberMaxHealth ?? 15000,
                      sailFireIntensity: mod.fiberFireIntensity ?? 0,
                      radius: 15,
                      height: 120,
                      sailWidth: 80,
                      sailColor: '#F5F5DC',
                      health: mod.health ?? 15000,
                      targetHealth: mod.targetHealth ?? mod.maxHealth ?? 15000,
                      maxHealth: mod.maxHealth ?? 15000,
                    };
                  } else if (kind === 'ladder') {
                    moduleData = {
                      kind: 'ladder',
                      length: 40,
                      width: 20,
                      climbSpeed: 2.0,
                      deployState: 'deployed',
                      // Derive extended from state bits: MODULE_STATE_RETRACTED = (1 << 10) = 1024
                      // NOTE: bit 0 is MODULE_STATE_ACTIVE (always set) — do NOT use & 1
                      extended: !((mod.state ?? 0) & 1024),
                    };
                  } else if (kind === 'swivel') {
                    moduleData = {
                      kind: 'swivel',
                      aimDirection: mod.aimDir ?? 0,
                      desiredAimDirection: mod.aimDir ?? 0,
                      reloadTime: 1.2,
                      timeSinceLastFire: 0,
                      health: mod.health ?? 4000,
                      targetHealth: mod.targetHealth ?? mod.maxHealth ?? 4000,
                      maxHealth: mod.maxHealth ?? 4000,
                    };
                  } else if (kind === 'gunport') {
                    moduleData = {
                      kind: 'gunport',
                      // is_open is encoded in the server's stateBits or a custom field
                      isOpen: !!(mod.isOpen ?? mod.is_open ?? false),
                      snapIndex: mod.snapIndex ?? -1,
                    };
                  } else if (kind === 'chest') {
                    moduleData = {
                      kind: 'chest',
                      wood:        mod.wood        ?? 0,
                      fiber:       mod.fiber       ?? 0,
                      metal:       mod.metal       ?? 0,
                      stone:       mod.stone       ?? 0,
                    };
                  } else if (kind === 'workbench') {
                    moduleData = { kind: 'workbench' };
                  } else if (kind === 'bed') {
                    moduleData = { kind: 'bed' };
                  }
                  
                  // Guard against duplicate IDs sent by the server (e.g. the ladder
                  // being emitted twice when loading from a save that was written
                  // before the world_save dedup fix landed).
                  if (gameplayModules.some(m => m.id === mod.id)) continue;
                  gameplayModules.push({
                    id: mod.id,
                    kind: kind,
                    deckId: mod.deck_id ?? 255, // 255=deck-independent fallback; 0=lower, 1=upper when server sends it
                    localPos: Vec2.from(mod.x ?? 0, mod.y ?? 0),
                    localRot: mod.rotation ?? 0,
                    occupiedBy: null,
                    stateBits: mod.state ?? 0,
                    health: typeof mod.health === 'number' ? mod.health : undefined,
                    qualityTier: typeof mod.qt === 'number' && mod.qt >= 0 ? mod.qt : undefined,
                    qualityWeaponDmgQ8: typeof mod.qw === 'number' ? mod.qw : undefined,
                    qualitySailEffQ8: typeof mod.qse === 'number' ? mod.qse : undefined,
                    qualityDurabilityQ8: typeof mod.qd === 'number' ? mod.qd : undefined,
                    moduleData: moduleData
                  } as ShipModule);
                }
              }
              
              // Merge: Keep client-generated planks/deck (shallow-cloned from template) + server gameplay modules.
              // Only include each template deck if the server reported that deck level as present.
              // This ensures lower and upper deck health are tracked independently.
              const clientDeck = tmpl.deck
                .filter(p => deckHealthMap.has(p.deckId))
                .map(p => {
                  const dmd  = p.moduleData as any;
                  const dhd  = deckHealthMap.get(p.deckId)!;
                  return {
                    ...p,
                    stateBits:           dhd.stateBits,
                    qualityTier:         dhd.qualityTier,
                    qualityDurabilityQ8: dhd.qualityDurabilityQ8,
                    qualityWeaponDmgQ8:  dhd.qualityWeaponDmgQ8,
                    moduleData: dmd ? {
                      ...dmd,
                      health:       dhd.health,
                      targetHealth: dhd.targetHealth,
                      maxHealth:    dhd.maxHealth,
                    } : dmd,
                  } as ShipModule;
                });

              // Include ALL 10 template plank slots. Slots the server reports get real health;
              // slots absent from the server (never placed or destroyed) get health=0 so the
              // renderer can draw them as a dark "missing" placeholder.
              const activePlanks = tmpl.planks.map(p => {
                  const d = plankHealthBuf.get(p.id);
                  const md = p.moduleData;
                  return {
                    ...p,
                    qualityTier:         d?.qualityTier,
                    qualityDurabilityQ8: d?.qualityDurabilityQ8,
                    qualityWeaponDmgQ8:  d?.qualityWeaponDmgQ8,
                    moduleData: md?.kind === 'plank'
                      ? { ...md,
                          health:       d ? d.health       : 0,
                          targetHealth: d ? d.targetHealth : 0,
                          maxHealth:    d ? d.maxHealth    : md.maxHealth }
                      : md,
                  } as ShipModule;
                });

              // Combine: client planks/deck + server gameplay modules
              serverModules = [...clientDeck, ...activePlanks, ...gameplayModules];
            }
            
            // Override with server's authoritative state
            return {
              ...tmpl.ship,
              id: ship.id || 0,
              position: Vec2.from(ship.x || 0, ship.y || 0),
              rotation: Number.isFinite(ship.rotation) ? ship.rotation : 0,
              velocity: Vec2.from(ship.velocity_x || 0, ship.velocity_y || 0),
              angularVelocity: ship.angular_velocity || 0,
              
              // Use server modules if provided, otherwise keep client defaults
              modules: serverModules || tmpl.ship.modules,
              
              // Parse physics properties from server (override defaults if provided)
              // Server sends: mass, moment_of_inertia, max_speed, turn_rate, water_drag, angular_drag
              mass: ship.mass ?? tmpl.ship.mass,
              momentOfInertia: ship.moment_of_inertia ?? tmpl.ship.momentOfInertia,
              maxSpeed: ship.max_speed ?? tmpl.ship.maxSpeed,
              turnRate: ship.turn_rate ?? tmpl.ship.turnRate,
              waterDrag: ship.water_drag ?? tmpl.ship.waterDrag,
              angularDrag: ship.angular_drag ?? tmpl.ship.angularDrag,
              rudderAngle: ship.rudder_angle ?? 0,
              cannonAmmo: ship.ammo ?? 0,
              infiniteAmmo: ship.infiniteAmmo ?? true,
              hullHealth: ship.hullHealth ?? 100,
              companyId: ship.company ?? 0,
              shipType: ship.shipType ?? 3,
              shipName: ship.name ?? '',
              npcLevel: ship.npcLevel != null ? (ship.npcLevel as number) : undefined,
              levelStats: ship.levelStats ? {
                levels: [
                  ship.levelStats.weight     ?? 1,
                  ship.levelStats.resistance ?? 1,
                  ship.levelStats.damage     ?? 1,
                  ship.levelStats.crew       ?? 1,
                  ship.levelStats.sturdiness ?? 1,
                ],
                xp:              ship.levelStats.xp              ?? 0,
                maxCrew:         ship.levelStats.maxCrew          ?? 9,
                shipLevel:       ship.levelStats.shipLevel        ?? ship.levelStats.totalPoints ?? 0,
                totalCap:        ship.levelStats.totalCap         ?? 65,
                nextUpgradeCost: ship.levelStats.nextUpgradeCost  ?? 0,
                attrCaps: [
                  ship.levelStats.attrCaps?.weight     ?? 50,
                  ship.levelStats.attrCaps?.resistance ?? 35,
                  ship.levelStats.attrCaps?.damage     ?? 35,
                  ship.levelStats.attrCaps?.crew       ?? 50,
                  ship.levelStats.attrCaps?.sturdiness ?? 25,
                ],
              } : tmpl.ship.levelStats,
              claimFlag: ship.claimFlag ? {
                planterId:      ship.claimFlag.planterId      ?? 0,
                planterCompany: ship.claimFlag.planterCompany ?? 0,
                progressMs:     ship.claimFlag.progressMs     ?? 0,
                totalMs:        ship.claimFlag.totalMs        ?? 300000,
                contested:      ship.claimFlag.contested      ?? false,
                localX:         ship.claimFlag.localX         ?? 0,
                localY:         ship.claimFlag.localY         ?? -100,
              } : undefined,
            };
          }),
          players: (message.players || []).map((player: any) => ({
            id: player.id || 0,
            name: player.name || `Player_${player.id || 0}`,
            position: Vec2.from(player.world_x || 0, player.world_y || 0), // Server sends world_x, world_y
            velocity: player.velocity 
              ? Vec2.from(player.velocity.x || 0, player.velocity.y || 0) 
              : Vec2.from(player.velocity_x || 0, player.velocity_y || 0), // Server sends velocity_x,velocity_y
            rotation: player.rotation || 0, // Server sends rotation (facing direction)
            radius: player.radius || 8,
            carrierId: player.parent_ship || 0, // Server sends parent_ship
            deckId: player.deck_index ?? player.deck_level ?? player.deckId ?? 1, // deck_level: 0=lower, 1=upper (default upper)
            onDeck: player.state === 'WALKING' || player.state === 'onship', // Server sends state field (WALKING, SWIMMING, etc.)
            movementState: player.state ?? undefined,
            
            // Local (ship-relative) position — only valid when on a ship.
            // The server always serialises local_x/local_y (0,0 when swimming),
            // so we must gate on parent_ship to avoid overwriting the predicted
            // deck anchor with a stale {0,0} from the previous swim snapshot.
            // buildSimBase uses `runningLocal.localPosition ?? serverLocal.localPosition`,
            // so undefined here correctly falls through to the server's boarding value.
            localPosition: (player.parent_ship > 0 &&
                            player.local_x !== undefined && player.local_y !== undefined)
              ? Vec2.from(player.local_x, player.local_y)
              : undefined,
            
            // Enhanced movement data from server (hybrid protocol)
            isMoving: player.is_moving !== undefined ? player.is_moving : undefined,
            movementDirection: (player.movement_direction_x !== undefined && player.movement_direction_y !== undefined)
              ? Vec2.from(player.movement_direction_x, player.movement_direction_y)
              : undefined,
            
            // Mount state from server
            isMounted: player.is_mounted || false,
            mountedModuleId: player.mounted_module_id || undefined,
            mountOffset: (player.mount_offset_x !== undefined && player.mount_offset_y !== undefined)
              ? Vec2.from(player.mount_offset_x, player.mount_offset_y)
              : undefined,

            // Inventory from server
            inventory: player.inventory
              ? parseInventoryFromServer(
                  player.inventory.slots,
                  player.inventory.activeSlot ?? 0,
                  player.inventory.equip?.helm   ?? 0,
                  player.inventory.equip?.torso  ?? 0,
                  player.inventory.equip?.legs   ?? 0,
                  player.inventory.equip?.feet   ?? 0,
                  player.inventory.equip?.hands  ?? 0,
                  player.inventory.equip?.shield ?? 0,
                  player.inventory.res_wood  ?? 0,
                  player.inventory.res_fiber ?? 0,
                  player.inventory.res_metal ?? 0,
                  player.inventory.res_stone ?? 0,
                )
              : createEmptyInventory(),

            companyId: player.company ?? 0,
            health: player.health ?? 100,
            maxHealth: player.max_health ?? 100,
            stamina: player.stamina ?? undefined,
            maxStamina: player.max_stamina ?? 100,
            oxygen: player.oxygen ?? undefined,
            maxOxygen: player.max_oxygen ?? 100,
            onIslandId: player.on_island ?? 0,
            onDockId: player.on_dock ?? 0,
            level: player.player_level ?? 1,
            xp: player.player_xp ?? 0,
            statHealth: player.stat_health ?? 0,
            statDamage: player.stat_damage ?? 0,
            statStamina: player.stat_stamina ?? 0,
            statWeight: player.stat_weight ?? 0,
            statPoints: player.stat_points ?? 0,
            speedMult: typeof player.speed_mult === 'number' ? player.speed_mult : 1.0,
            canSprint: typeof player.can_sprint === 'boolean' ? player.can_sprint : true,
            grappleState: typeof player.grapple_state === 'number' ? player.grapple_state : undefined,
            grappleX: typeof player.grapple_x === 'number' ? player.grapple_x : undefined,
            grappleY: typeof player.grapple_y === 'number' ? player.grapple_y : undefined,
            grappleRopeLength: typeof player.grapple_rope === 'number' ? player.grapple_rope : undefined,
            grappleTargetType: typeof player.grapple_target === 'number' ? player.grapple_target : undefined,
            grapplePulled: player.grapple_pulled === 1 || player.grapple_pulled === true,
            grappleAnchorX: typeof player.grapple_anchor_x === 'number' ? player.grapple_anchor_x : undefined,
            grappleAnchorY: typeof player.grapple_anchor_y === 'number' ? player.grapple_anchor_y : undefined,
            bucketFill: typeof player.bucket_fill === 'number'
              ? (Math.max(0, Math.min(2, player.bucket_fill)) as 0 | 1 | 2)
              : undefined,
          })),
          cannonballs: (message.projectiles || []).map((ball: any) => ({
            id: ball.id || 0,
            position: Vec2.from(ball.x || 0, ball.y || 0),
            velocity: Vec2.from(ball.vx || 0, ball.vy || 0),
            firingVelocity: Vec2.from(ball.vx || 0, ball.vy || 0),
            radius: 6,
            maxRange: 800,
            distanceTraveled: 0,
            timeAlive: 0,
            firedFrom: ball.owner || 0,
            ammoType: ball.type ?? 0,   // Server sends "type": 0=cannonball, 1=bar shot
            smokeTrail: []
          })),
          npcs: (message.npcs || []).map((n: any): Npc => ({
            id: n.id || 0,
            name: n.name || 'Sailor',
            type: n.type ?? 0,
            position: Vec2.from(n.x || 0, n.y || 0),
            localPosition: Vec2.from(n.local_x || 0, n.local_y || 0),
            rotation: n.rotation || 0,
            interactRadius: n.interact_radius ?? 40,
            shipId: n.ship_id || 0,
            state: n.state ?? 0,
            role: n.role ?? 0,
            companyId: n.company ?? 0,
            ownerId:   n.owner_id ?? 0,
            assignedWeaponId: n.assigned_weapon_id ?? 0,
            // Crew levelling
            npcLevel:   n.npc_level   ?? 1,
            health:     n.health      ?? 100,
            maxHealth:  n.max_health  ?? 100,
            xp:         n.xp          ?? 0,
            statHealth:  n.stat_health  ?? 0,
            statDamage:  n.stat_damage  ?? 0,
            statStamina: n.stat_stamina ?? 0,
            statWeight:  n.stat_weight  ?? 0,
            statPoints:  n.stat_points  ?? 0,
            locked:      !!(n.locked),
            deckLevel:   n.deck_level   ?? 1,
          })),
          carrierDetection: new Map(), // Will be populated as needed
          tombstones: (message.tombstones ?? []).map((t: any) => ({
            id:          t.id          ?? 0,
            x:           t.x           ?? 0,
            y:           t.y           ?? 0,
            ownerName:   t.ownerName   ?? '',
            remainingMs: t.remainingMs ?? 0,
          })),
          droppedItems: (message.droppedItems ?? []).map((d: any) => ({
            id:          d.id          ?? 0,
            itemKind:    d.itemKind    ?? 0,
            quantity:    d.quantity    ?? 0,
            x:           d.x           ?? 0,
            y:           d.y           ?? 0,
            remainingMs: d.remainingMs ?? undefined,
            shipId:      d.shipId      ?? undefined,
            deckLevel:   d.deckLevel   ?? undefined,
            isSchematic: d.isSchematic ?? false,
            crafts:      d.crafts      ?? undefined,
            tier:        d.tier        ?? undefined,
            quality:     d.quality     ?? undefined,
            stats:       Array.isArray(d.stats) ? d.stats : undefined,
          })),
          companies: (message.companies ?? []).map((c: any): Company => ({
            id:         c.id         ?? 0,
            name:       c.name       ?? '',
            founderId:  c.founderId  ?? 0,
          })),
        };
        
        this.onWorldStateReceived?.(worldState);
        // Parse world wind fields attached to GAME_STATE
        if (typeof message.windAngle    === 'number') this.windAngle    = message.windAngle;
        if (typeof message.windStrength === 'number') this.windStrength = message.windStrength;
        } catch (gsErr: any) {
          console.error(
            `❌ [GAME_STATE] Processing threw on tick ${message?.tick ?? '?'}\n` +
            `  Error : ${gsErr?.message ?? gsErr}\n` +
            `  Stack : ${gsErr?.stack ?? '(no stack)'}`
          );
          // Run the full structural analyser so the console shows exactly what's wrong
          NetworkManager.analyzeGameState(message);
        }
        break;
        
      case MessageType.PONG: // Handles both 'pong' enum and text response
        this.handlePong(message);
        break;

      case 'WORLD_STATE' as any: // Server broadcast (uppercase); carries windPower + windDirection
        if (typeof message.windDirection === 'number') this.windAngle    = message.windDirection;
        if (typeof message.windPower     === 'number') this.windStrength = message.windPower;
        break;

      case 'company_created' as any:
        if (message.company) {
          const co: Company = {
            id:        message.company.id        ?? 0,
            name:      message.company.name      ?? '',
            founderId: message.company.founderId ?? 0,
          };
          this.onCompanyCreated?.(co);
        }
        break;
        
      case MessageType.HANDSHAKE_RESPONSE:
        console.log('🤝 Received handshake response:', message);
        // Extract and store the server-assigned player ID
        if (message.player_id !== undefined) {
          this.assignedPlayerId = message.player_id;
          console.log(`🎮 Server assigned player ID: ${this.assignedPlayerId}`);
        }
        break;
        
      case 'ack':
        console.log('✅ Server ack received — player ready to play');
        this.onPlayerAck?.();
        break;

      case MessageType.MESSAGE_ACK:
        if (message.status === 'npc_moved_to_module') {
          this.onNpcMoveResult?.(true, message.npcId ?? 0);
        } else if (message.status === 'no_stamina') {
          this.onNoStamina?.();
        }
        break;

      case 'error':
        if (message.message === 'module_occupied' || message.message === 'cannot_goto_module') {
          this.onNpcMoveResult?.(false, message.npcId ?? 0);
        }
        break;
        
      case MessageType.MODULE_INTERACT_SUCCESS:
        this.handleModuleInteractSuccess(message as ModuleInteractSuccessMessage);
        break;
        
      case MessageType.MODULE_INTERACT_FAILURE:
        this.handleModuleInteractFailure(message as ModuleInteractFailureMessage);
        break;

      case MessageType.PLAYER_BOARDED: {
        const boardedShipId: number = message.ship_id || 0;
        this.onPlayerBoarded?.(boardedShipId);
        break;
      }

      case MessageType.HARVEST_SUCCESS:
        this.onHarvestResult?.(true, message.wood ?? message.planks ?? 0, '');
        break;

      case MessageType.HARVEST_FAILURE:
        this.onHarvestResult?.(false, 0, message.reason ?? 'unknown');
        break;

      case MessageType.HARVEST_FIBER_SUCCESS:
        this.onFiberHarvestResult?.(true, message.fiber ?? 0, '', message.wood ?? 0);
        break;

      case MessageType.HARVEST_FIBER_FAILURE:
        this.onFiberHarvestResult?.(false, 0, message.reason ?? 'unknown', 0);
        break;

      case MessageType.HARVEST_ROCK_SUCCESS:
        this.onRockHarvestResult?.(true, message.metal ?? 0, '');
        break;

      case MessageType.HARVEST_ROCK_FAILURE:
        this.onRockHarvestResult?.(false, 0, message.reason ?? 'unknown');
        break;

      case MessageType.HARVEST_STONE_SUCCESS:
        this.onStoneHarvestResult?.(true, message.stone ?? 0, '');
        break;

      case MessageType.HARVEST_STONE_FAILURE:
        this.onStoneHarvestResult?.(false, 0, message.reason ?? 'unknown');
        break;

      case MessageType.HARVEST_BOULDER_SUCCESS:
        this.onBoulderHarvestResult?.(true, message.metal ?? 0, message.stone ?? 0, '');
        break;

      case MessageType.HARVEST_BOULDER_FAILURE:
        this.onBoulderHarvestResult?.(false, 0, 0, message.reason ?? 'unknown');
        break;

      case 'npc_dialogue':
        console.log(`💬 [NPC] ${message.npc_name}: "${message.text}"`);
        this.onNpcDialogue?.(message.npc_id, message.npc_name, message.text);
        break;

      case 'NPC_STAT_UP': {
        this.onNpcStatUp?.(
          message.npcId, message.stat, message.level, message.xp,
          message.maxHealth, message.npcLevel,
          message.statHealth, message.statDamage, message.statStamina, message.statWeight,
          message.statPoints ?? 0,
        );
        break;
      }

      case 'PLAYER_STAT_UP': {
        this.onPlayerStatUp?.(
          message.stat, message.level, message.xp,
          message.maxHealth, message.maxStamina ?? 100,
          message.playerLevel,
          message.statHealth, message.statDamage, message.statStamina, message.statWeight,
          message.statPoints ?? 0,
        );
        break;
      }

      case 'PLAYER_LEVEL_UP': {
        // Server confirmed a player level-up; refresh xp and playerLevel
        this.onPlayerStatUp?.(
          'level', 0, message.xp ?? 0,
          0, 0,
          message.playerLevel ?? 1,
          0, 0, 0, 0,
          message.statPoints ?? 0,
        );
        break;
      }

      case MessageType.CANNON_GROUP_STATE: {
        const gsShipId: number = message.shipId || 0;
        const gsGroups = Array.isArray(message.groups) ? message.groups.map((g: any) => ({
          index: g.index ?? 0,
          mode: g.mode ?? 'haltfire',
          cannonIds: Array.isArray(g.cannonIds) ? g.cannonIds.map((id: any) => Number(id)) : [],
          targetShipId: g.targetShipId ?? 0,
          gunportsOpen: !!g.gunportsOpen,
          name: typeof g.name === 'string' ? g.name : '',
        })) : [];
        this.onCannonGroupState?.(gsShipId, gsGroups);
        break;
      }

      case 'gunport_state': {
        const gpShipId: number = message.shipId || 0;
        const gpId: number = message.gunportId || 0;
        const gpOpen: boolean = !!message.isOpen;
        const gpMass: number | undefined = typeof message.mass === 'number' ? message.mass : undefined;
        this.onGunportState?.(gpShipId, gpId, gpOpen, gpMass);
        break;
      }

      case 'gunport_blocked': {
        // Only process if this message is for the local player
        if (message.player_id === this.assignedPlayerId) {
          const gpbCannonId: number = message.cannon_id || 0;
          const gpbGunportId: number = message.gunport_id || 0;
          this.onGunportBlocked?.(gpbCannonId, gpbGunportId);
        }
        break;
      }

      case 'MODULE_HIT': {
        const shipId: number = message.shipId || 0;
        const moduleId: number = message.moduleId || 0;
        const hitDmg: number = message.damage || 0;
        const hitX: number | undefined = message.x;
        const hitY: number | undefined = message.y;
        console.log(`💥 MODULE_HIT: ship ${shipId} module ${moduleId} destroyed`);
        this.onModuleDestroyed?.(shipId, moduleId, hitDmg, hitX, hitY);
        break;
      }

      case 'MODULE_DAMAGED': {
        // Non-fatal interior module hit — spawn damage number only
        const shipId: number = message.shipId || 0;
        const moduleId: number = message.moduleId || 0;
        const damage: number = message.damage || 0;
        const hitX: number | undefined = message.x;
        const hitY: number | undefined = message.y;
        console.log(`💥 MODULE_DAMAGED: ship ${shipId} module ${moduleId} took ${damage} damage at (${hitX}, ${hitY})`);
        this.onModuleDamaged?.(shipId, moduleId, damage, hitX, hitY);
        break;
      }

      case 'PLANK_HIT': {
        // Plank destroyed — remove immediately so it disappears before the next GAME_STATE
        const plankShipId: number = message.shipId || 0;
        const plankId: number = message.plankId || 0;
        const plankDmg: number = message.damage || 0;
        const plankHitX: number | undefined = message.x;
        const plankHitY: number | undefined = message.y;
        const wreckageUntilMs: number | undefined = message.wreckageUntilMs;
        const _tmplHit = this._shipTemplates.get(plankShipId);
        const _tmplHitIds = _tmplHit?.planks.map(p => '0x' + p.id.toString(16)) ?? [];
        console.log(`💥 PLANK_HIT: ship=${plankShipId} plankId=0x${plankId.toString(16)} dmg=${plankDmg}\n  tmpl has id? ${_tmplHit?.planks.some(p => p.id === plankId)}  tmpl=[${_tmplHitIds.join(', ')}]`);
        this.onModuleDestroyed?.(plankShipId, plankId, plankDmg, plankHitX, plankHitY, wreckageUntilMs);
        break;
      }

      case 'PLANK_DAMAGED': {
        // Non-fatal plank hit — spawn damage number only
        const plankShipId: number = message.shipId || 0;
        const plankId: number = message.plankId || 0;
        const plankDamage: number = message.damage || 0;
        const plankHitX: number | undefined = message.x;
        const plankHitY: number | undefined = message.y;
        const _tmplDmg = this._shipTemplates.get(plankShipId);
        const _tmplDmgIds = _tmplDmg?.planks.map(p => '0x' + p.id.toString(16)) ?? [];
        console.log(`💥 PLANK_DAMAGED: ship=${plankShipId} plankId=0x${plankId.toString(16)} dmg=${plankDamage}\n  tmpl has id? ${_tmplDmg?.planks.some(p => p.id === plankId)}  tmpl=[${_tmplDmgIds.join(', ')}]`);
        this.onModuleDamaged?.(plankShipId, plankId, plankDamage, plankHitX, plankHitY);
        break;
      }

      case 'HULL_HIT': {
        // Cannonball passed through the hull interior without hitting a specific module.
        // Still show explosion + damage number at the hit position.
        const hullShipId: number = message.shipId || 0;
        const hullDmg: number = message.damage || 0;
        const hullHitX: number | undefined = message.x;
        const hullHitY: number | undefined = message.y;
        console.log(`💥 HULL_HIT: ship ${hullShipId} took ${hullDmg} hull damage at (${hullHitX}, ${hullHitY})`);
        // Re-use onModuleDamaged with moduleId=0 — ClientApplication handles id=0 gracefully
        this.onModuleDamaged?.(hullShipId, 0, hullDmg, hullHitX, hullHitY);
        break;
      }

      case 'SHIP_SINK': {
        const sunkShipId: number = message.shipId || 0;
        console.log(`🌊 SHIP_SINK: ship ${sunkShipId} has sunk!`);
        this.onShipSunk?.(sunkShipId);
        break;
      }

      case 'SHIP_SINKING': {
        const sinkingShipId: number = message.shipId || 0;
        console.log(`🌊 SHIP_SINKING: ship ${sinkingShipId} is sinking!`);
        this.onShipSinking?.(sinkingShipId);
        break;
      }

      case 'ship_renamed': {
        const renamedShipId: number = message.shipId || 0;
        const newShipName: string = message.name ?? '';
        this.onShipRenamed?.(renamedShipId, newShipName);
        break;
      }

      case 'ENTITY_HIT': {
        const hitEntityType: 'npc' | 'player' = message.entityType === 'player' ? 'player' : 'npc';
        this.onEntityHit?.(
          hitEntityType,
          message.id       ?? 0,
          message.x        ?? 0,
          message.y        ?? 0,
          message.damage   ?? 0,
          message.health   ?? 0,
          message.maxHealth ?? 100,
          message.killed   ?? false,
          message.killerShipId ?? message.attackerShipId ?? message.shipId ?? 0,
        );
        break;
      }

      case 'FIRE_EFFECT': {
        console.log(`[NET] FIRE_EFFECT received: entityType=${message.entityType} shipId=${message.shipId} moduleId=${message.moduleId} id=${message.id}`);
        const fireEntityType: 'npc' | 'player' | 'module' =
          message.entityType === 'player' ? 'player' :
          message.entityType === 'module' ? 'module' : 'npc';
        const fireId = message.entityType === 'module'
          ? (message.moduleId ?? 0)
          : (message.id ?? 0);
        this.onFireEffect?.(
          fireEntityType,
          fireId,
          message.x        ?? 0,
          message.y        ?? 0,
          message.durationMs ?? 10000,
          message.shipId   ?? undefined,
          message.moduleId ?? undefined,
        );
        break;
      }

      case 'FIRE_EXTINGUISHED': {
        const extEntityType: 'npc' | 'player' | 'module' =
          message.entityType === 'player' ? 'player' :
          message.entityType === 'module' ? 'module' : 'npc';
        const extId = message.entityType === 'module'
          ? (message.moduleId ?? 0)
          : (message.id ?? 0);
        this.onFireExtinguished?.(
          extEntityType,
          extId,
          message.shipId   ?? undefined,
          message.moduleId ?? undefined,
        );
        break;
      }

      case 'SAIL_FIBER_FIRE': {
        // Real-time sail fiber fire intensity update
        this.onSailFiberFire?.(
          message.shipId    ?? 0,
          message.moduleId  ?? 0,
          message.intensity ?? 0,
          message.fiberHealth ?? 0,
          message.windEff   ?? 1.0,
        );
        break;
      }

      case 'MAP_INFO': {
        this.mapWidth   = message.width   ?? 90000;
        this.mapHeight  = message.height  ?? 90000;
        this.mapCenterX = message.centerX ?? this.mapWidth  / 2;
        this.mapCenterY = message.centerY ?? this.mapHeight / 2;
        this.mapWrap    = message.wrap    ?? true;
        break;
      }

      case 'ISLANDS': {
        const now = performance.now();
        /** Ray-cast even-odd PIP for world-space polygon rings. */
        const pipInRing = (poly: {x:number,y:number}[], wx: number, wy: number): boolean => {
          let inside = false;
          const n = poly.length;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if ((yi > wy) !== (yj > wy) && wx < (xj - xi) * (wy - yi) / (yj - yi) + xi)
              inside = !inside;
          }
          return inside;
        };
        const isInMetalPolys = (metalPolys: {x:number,y:number}[][]|undefined, islX: number, islY: number, ox: number, oy: number): boolean => {
          if (!metalPolys) return false;
          const wx = islX + ox, wy = islY + oy;
          return metalPolys.some(ring => pipInRing(ring, wx, wy));
        };
        const islands: IslandDef[] = (message.islands ?? []).map((isl: any) => {
          const islX = isl.x ?? 0;
          const islY = isl.y ?? 0;
          const metalPolys: {x:number,y:number}[][] | undefined = isl.metalPolys
            ? (isl.metalPolys as any[][]).map((ring: any[]) => ring.map((v: any) => ({ x: v.x ?? 0, y: v.y ?? 0 })))
            : undefined;
          return {
          id:        isl.id       ?? 0,
          x:         islX,
          y:         islY,
          preset:    (isl.preset ?? 'tropical') as IslandPreset,
          resources: (isl.resources ?? []).map((r: any): IslandResource => ({
            ox:         r.ox    ?? 0,
            oy:         r.oy    ?? 0,
            type:       (r.type ?? 'wood') as IslandResource['type'],
            size:       r.size  ?? 1.0,
            hp:         r.hp    ?? 100,
            maxHp:      r.maxHp ?? 100,
            depletedAt: (r.hp <= 0) ? now : undefined,
            metal:      r.type === 'boulder' ? isInMetalPolys(metalPolys, islX, islY, r.ox ?? 0, r.oy ?? 0) : undefined,
          })),
          vertices: isl.vertices?.length >= 3
            ? (isl.vertices as any[]).map((v: any) => ({ x: v.x ?? 0, y: v.y ?? 0 }))
            : undefined,
          grassVertices: isl.grassVertices?.length >= 3
            ? (isl.grassVertices as any[]).map((v: any) => ({ x: v.x ?? 0, y: v.y ?? 0 }))
            : undefined,
          shallowVertices: isl.shallowVertices?.length >= 3
            ? (isl.shallowVertices as any[]).map((v: any) => ({ x: v.x ?? 0, y: v.y ?? 0 }))
            : undefined,
          stonePolys: isl.stonePolys
            ? (isl.stonePolys as any[][]).map((ring: any[]) => ring.map((v: any) => ({ x: v.x ?? 0, y: v.y ?? 0 })))
            : undefined,
          metalPolys,
          };
        });
        this.onIslands?.(islands);
        break;
      }

      case 'resource_damaged': {
        this.onResourceDamaged?.(
          message.island_id ?? 0,
          message.ox        ?? 0,
          message.oy        ?? 0,
          message.hp        ?? 0,
          message.maxHp     ?? 1,
        );
        break;
      }

      case 'resource_respawned': {
        this.onResourceRespawned?.(
          message.island_id ?? 0,
          message.ri        ?? 0,
          message.ox        ?? 0,
          message.oy        ?? 0,
          message.hp        ?? 100,
          message.maxHp     ?? 100,
        );
        break;
      }

      case 'STRUCTURES': {
        const structs: PlacedStructure[] = (message.structures ?? []).map((s: any): PlacedStructure => ({
          id:        s.id       ?? 0,
          type:      s.structure_type === 'workbench'    ? 'workbench'
                   : s.structure_type === 'wall'         ? 'wall'
                   : s.structure_type === 'door_frame'   ? 'door_frame'
                   : s.structure_type === 'door'         ? 'door'
                   : s.structure_type === 'shipyard'     ? 'shipyard'
                   : s.structure_type === 'wreck'        ? 'wreck'
                   : s.structure_type === 'wood_ceiling' ? 'wood_ceiling'
                   : s.structure_type === 'cannon'       ? 'cannon'
                   : s.structure_type === 'flag_fort'    ? 'flag_fort'
                   : s.structure_type === 'claim_flag'   ? 'claim_flag'
                   : s.structure_type === 'company_fortress' ? 'company_fortress'
                   : s.structure_type === 'chest'        ? 'chest'
                   : s.structure_type === 'bed'          ? 'bed'
                   : 'wooden_floor',
          islandId:  s.island_id ?? 0,
          x:         s.x ?? 0,
          y:         s.y ?? 0,
          companyId: s.company_id ?? 0,
          hp:        s.hp     ?? 100,
          maxHp:     s.max_hp ?? 100,
          placerName: s.placer_name ?? '',
          doorOpen:  s.open ?? false,
          doorLocked: s.locked === true,
          rotation:  s.rotation ?? 0,
          cannonAimAngle: typeof s.cannon_aim_angle === 'number' ? s.cannon_aim_angle : undefined,
          cannonReloadMs: typeof s.cannon_reload_ms === 'number' ? s.cannon_reload_ms : undefined,
          cannonLoadedAmmo: typeof s.cannon_loaded_ammo === 'number' ? s.cannon_loaded_ammo : undefined,
          claimContested:        s.claim_contested        === true,
          claimTargetsFortress:  s.claim_targets_fortress  === true,
          claimLinkedFort:       typeof s.claim_linked_fort  === 'number' ? s.claim_linked_fort  : undefined,
          claimSourceEnemy:      typeof s.claim_source_enemy === 'number' ? s.claim_source_enemy : undefined,
          claimState:            typeof s.claim_state === 'number' ? s.claim_state : undefined,
          claimGraceMs:          typeof s.claim_grace_ms === 'number' ? s.claim_grace_ms : undefined,
          claimOrphaned:         s.claim_orphaned        === true,
          dominators:            Array.isArray(s.dominators) ? (s.dominators as number[]) : [],
          fortressBuildProgress: typeof s.fortress_build_progress === 'number' ? s.fortress_build_progress : undefined,
          fortressComplete:      s.fortress_complete       === true,
          fortressContested:     s.fortress_contested      === true,
          claimPhase:            typeof s.claim_phase === 'number' ? s.claim_phase : undefined,
          claimPhaseProgressMs:  typeof s.claim_progress_ms === 'number' && s.claim_phase === 0 ? s.claim_progress_ms : undefined,
          claimPhaseTotalMs:     typeof s.claim_total_ms === 'number' ? s.claim_total_ms : undefined,
          targetHp:              typeof s.target_hp === 'number' ? s.target_hp : undefined,
          chestResources: (s.structure_type === 'chest' || s.structure_type === 'shipyard') ? {
            wood:  s.chest_wood  ?? 0,
            fiber: s.chest_fiber ?? 0,
            metal: s.chest_metal ?? 0,
            stone: s.chest_stone ?? 0,
          } : undefined,
          wreckTier: typeof s.wreck_tier === 'number' ? s.wreck_tier : undefined,
          qualityTier: typeof s.qt === 'number' && s.qt >= 0 ? s.qt : undefined,
          construction: s.structure_type === 'shipyard' ? {
            phase: (s.construction_phase === 'building' ? 'building' : 'empty') as ConstructionPhase,
            modulesPlaced: Array.isArray(s.modules_placed) ? s.modules_placed : [],
            scaffoldedShipId: s.scaffolded_ship_id ?? 0,
          } : undefined,
        }));
        this.onStructuresList?.(structs);
        break;
      }

      case 'structure_placed': {
        const sp: PlacedStructure = {
          id:        message.id       ?? 0,
          type:      message.structure_type === 'workbench'    ? 'workbench'
                   : message.structure_type === 'wall'         ? 'wall'
                   : message.structure_type === 'door_frame'   ? 'door_frame'
                   : message.structure_type === 'door'         ? 'door'
                   : message.structure_type === 'shipyard'     ? 'shipyard'
                   : message.structure_type === 'wreck'        ? 'wreck'
                   : message.structure_type === 'wood_ceiling' ? 'wood_ceiling'
                   : message.structure_type === 'cannon'       ? 'cannon'
                   : message.structure_type === 'flag_fort'    ? 'flag_fort'
                   : message.structure_type === 'claim_flag'   ? 'claim_flag'
                   : message.structure_type === 'company_fortress' ? 'company_fortress'
                   : message.structure_type === 'chest'        ? 'chest'
                   : message.structure_type === 'bed'          ? 'bed'
                   : 'wooden_floor',
          islandId:  message.island_id ?? 0,
          x:         message.x ?? 0,
          y:         message.y ?? 0,
          companyId: message.company_id ?? 0,
          hp:        message.hp     ?? 100,
          maxHp:     message.max_hp ?? 100,
          placerName: message.placer_name ?? '',
          doorOpen:  message.open ?? false,
          doorLocked: message.locked === true,
          rotation:  message.rotation ?? 0,
          cannonAimAngle: typeof message.cannon_aim_angle === 'number' ? message.cannon_aim_angle : undefined,
          cannonReloadMs: typeof message.cannon_reload_ms === 'number' ? message.cannon_reload_ms : undefined,
          cannonLoadedAmmo: typeof message.cannon_loaded_ammo === 'number' ? message.cannon_loaded_ammo : undefined,
          claimTargetsFortress: message.claim_targets_fortress  === true,
          claimLinkedFort:      typeof message.claim_linked_fort  === 'number' ? message.claim_linked_fort  : undefined,
          claimSourceEnemy:     typeof message.claim_source_enemy === 'number' ? message.claim_source_enemy : undefined,
          claimState:           typeof message.claim_state === 'number' ? message.claim_state : undefined,
          claimGraceMs:         typeof message.claim_grace_ms === 'number' ? message.claim_grace_ms : undefined,
          claimOrphaned:        message.claim_orphaned        === true,
          fortressBuildProgress: typeof message.fortress_build_progress === 'number' ? message.fortress_build_progress : undefined,
          fortressComplete:     message.fortress_complete       === true,
          fortressContested:    message.fortress_contested      === true,
          claimPhase:           typeof message.claim_phase === 'number' ? message.claim_phase : undefined,
          claimPhaseProgressMs: typeof message.claim_progress_ms === 'number' && message.claim_phase === 0 ? message.claim_progress_ms : undefined,
          claimPhaseTotalMs:    typeof message.claim_total_ms === 'number' ? message.claim_total_ms : undefined,
          targetHp:             typeof message.target_hp === 'number' ? message.target_hp : undefined,
          chestResources: (message.structure_type === 'chest' || message.structure_type === 'shipyard') ? {
            wood:  message.chest_wood  ?? 0,
            fiber: message.chest_fiber ?? 0,
            metal: message.chest_metal ?? 0,
            stone: message.chest_stone ?? 0,
          } : undefined,
          wreckTier: typeof message.wreck_tier === 'number' ? message.wreck_tier : undefined,
          qualityTier: typeof message.qt === 'number' && message.qt >= 0 ? message.qt : undefined,
        };
        this.onStructurePlaced?.(sp);
        break;
      }

      case 'wreck_spawned': {
        const lootCount = message.loot_count ?? 0;
        const bpCount   = message.bp_count ?? 0;
        const displayHp = Math.max(lootCount, bpCount, 1);
        const w: PlacedStructure = {
          id:        message.id       ?? 0,
          type:      'wreck',
          islandId:  0,
          x:         message.x        ?? 0,
          y:         message.y        ?? 0,
          companyId: 0,
          hp:        displayHp,
          maxHp:     displayHp,
          placerName: message.wreck_type === 'schematic_cache' ? 'workbench_ruin'
                    : message.wreck_type === 'chest_ruin' ? 'chest_ruin' : 'shipwreck',
          wreckTier: typeof message.wreck_tier === 'number' ? message.wreck_tier : undefined,
          chestResources: message.wreck_type === 'chest_ruin' ? {
            wood:  message.wood  ?? 0,
            fiber: message.fiber ?? 0,
            metal: message.metal ?? 0,
            stone: message.stone ?? 0,
          } : undefined,
        };
        this.onWreckSpawned?.(w);
        this.onStructurePlaced?.(w);
        break;
      }

      case 'wreck_removed':
        this.onWreckRemoved?.(message.id ?? 0);
        this.onStructureDemolished?.(message.id ?? 0);
        break;

      case 'wreck_update':
        // Move an existing wreck to the reported position (sent every tick while grapple-pulled).
        if (typeof message.id === 'number' && typeof message.x === 'number' && typeof message.y === 'number') {
          this.onWreckPositionUpdate?.(message.id, message.x, message.y);
        }
        break;

      case 'wreck_loot':
        // Auto-salvage notification sent when a grappled wreck is pulled to the player.
        if (typeof message.playerId === 'number') {
          this.onWreckLoot?.(
            message.playerId,
            message.x ?? 0,
            message.y ?? 0,
            message.wood  ?? 0,
            message.fiber ?? 0,
            message.metal ?? 0,
            message.stone ?? 0,
            message.items ?? 0,
            message.blueprints ?? 0,
          );
        }
        break;

      case 'territory_update':
        this.onTerritoryUpdate?.(
          message.island_id          ?? 0,
          message.company_id         ?? 0,
          message.claimed === true,
          message.fort_x             ?? 0,
          message.fort_y             ?? 0,
          message.fort_radius        ?? 600,
          message.is_company_fortress === true,
        );
        break;

      case 'claim_flag_progress':
        this.onClaimFlagProgress?.(
          message.structure_id       ?? message.id ?? 0,
          message.progress_ms        ?? message.progress ?? 0,
          message.contested          === true,
          message.targets_fortress   === true,
          typeof message.state === 'number' ? message.state : undefined,
          typeof message.grace_ms === 'number' ? message.grace_ms : undefined,
          typeof message.grace_total === 'number' ? message.grace_total : undefined,
          typeof message.total === 'number' ? message.total : undefined,
        );
        break;

      case 'territory_flipped':
        this.onTerritoryFlipped?.(
          message.flag_id ?? 0,
          message.orphaned_structure_id ?? 0,
          message.old_company_id ?? 0,
          message.new_company_id ?? 0,
          message.island_id ?? 0,
        );
        break;

      case 'structure_dominators': {
        const sid = (message.structure_id ?? 0) as number;
        const list = (message.dominators ?? []) as number[];
        this.onStructureDominators?.(sid, list);
        break;
      }

      case 'fortress_build_progress':
        this.onFortressBuildProgress?.(
          message.structure_id  ?? 0,
          message.company_id    ?? 0,
          message.island_id     ?? 0,
          message.progress_ms   ?? 0,
          message.total_ms      ?? 900000,
          message.contested     === true,
        );
        break;

      case 'fortress_complete':
        this.onFortressComplete?.(
          message.structure_id  ?? 0,
          message.company_id    ?? 0,
          message.island_id     ?? 0,
        );
        break;

      case 'flag_fort_build_progress':
        // Periodic flag-fort heal resync. We deliberately do NOT route this
        // through the Company-Fortress callbacks — the active gate is at 30%
        // HP (not 100%), and the announcement copy is different. The render
        // system has a dedicated handler that updates hp/contested only.
        this.onFlagFortBuildProgress?.(
          message.structure_id  ?? 0,
          typeof message.hp     === 'number' ? message.hp     : 0,
          typeof message.max_hp === 'number' ? message.max_hp : 500,
          message.contested     === true,
          message.fortress_complete === true,
          typeof message.claim_phase === 'number' ? message.claim_phase : 2,
          typeof message.claim_progress_ms === 'number' ? message.claim_progress_ms : 0,
          typeof message.claim_total_ms === 'number' ? message.claim_total_ms : 60000,
          typeof message.claim_state === 'number' ? message.claim_state : 0,
          typeof message.claim_grace_ms === 'number' ? message.claim_grace_ms : 0,
          typeof message.target_hp === 'number' ? message.target_hp : undefined,
        );
        break;

      case 'flag_fort_active':
        // Activation/deactivation transition for a flag fort. We pipe both
        // directions through the existing fortress_complete callback by
        // toggling fortressComplete on the cached structure.
        this.onFlagFortActive?.(
          message.structure_id  ?? 0,
          message.company_id    ?? 0,
          message.island_id     ?? 0,
          message.active        === true,
          typeof message.claim_phase === 'number' ? message.claim_phase : (message.active ? 2 : 1),
        );
        break;

      case 'fortress_captured':
        this.onFortressCaptured?.(
          message.structure_id   ?? 0,
          message.new_company_id ?? 0,
          message.old_company_id ?? 0,
          message.island_id      ?? 0,
        );
        break;

      case 'territory_captured':
        this.onTerritoryCaptured?.(
          message.island_id      ?? 0,
          message.new_company_id ?? message.company_id ?? 0,
        );
        break;

      case 'door_toggled':
        this.onDoorToggled?.(message.id ?? 0, message.open === true);
        break;

      case 'door_lock_toggled':
        this.onDoorLockToggled?.(message.id ?? 0, message.locked === true, message.open === true);
        break;

      case 'respawn_map': {
        const rawShips = (message.ships ?? []) as Array<Record<string, unknown>>;
        const ships = rawShips.map(s => ({
          id: Number(s.id ?? 0),
          name: String(s.name ?? ''),
          x: Number(s.x ?? 0),
          y: Number(s.y ?? 0),
          rotation: Number(s.rotation ?? 0),
          beds: ((s.beds ?? []) as Array<Record<string, unknown>>).map(b => ({
            moduleId: Number(b.moduleId ?? 0),
            localX: Number(b.localX ?? 0),
            localY: Number(b.localY ?? 0),
          })),
        }));
        this.onRespawnMap?.(ships);
        break;
      }

      case 'bed_used':
        this.onBedUsed?.(
          message.bed_id  as number | undefined,
          message.x       as number | undefined,
          message.y       as number | undefined,
          message.ship_id as number | undefined,
        );
        break;

      case 'bed_cooldown':
        this.onBedCooldown?.(message.remaining_ms as number ?? 0);
        break;

      case 'bed_travel_fail':
        this.onBedTravelFail?.(message.reason as string ?? 'unknown');
        break;

      case 'bed_travel_ok':
        break;

      case 'structure_demolished':
        this.onStructureDemolished?.(
          message.structure_id ?? message.id ?? 0,
          message.x,
          message.y,
        );
        break;

      case 'module_demolished':
        this.onModuleDemolished?.(message.shipId ?? 0, message.moduleId ?? 0);
        break;

      case 'structure_company_updated':
        this.onStructureCompanyUpdated?.(message.structure_id ?? 0, message.company_id ?? 0);
        break;

      case 'structure_hp_changed':
        this.onStructureHpChanged?.(
          message.structure_id ?? 0,
          message.hp ?? 0,
          message.max_hp ?? 100,
          message.x ?? 0,
          message.y ?? 0,
          typeof message.target_hp === 'number' ? message.target_hp : undefined,
        );
        break;

      case 'tree_cannonball_hit':
        this.onTreeHit?.(message.x ?? 0, message.y ?? 0);
        break;

      case 'craft_result':
        this.onCraftResult?.(
          message.success === true,
          message.recipe_id ?? '',
          message.reason,
        );
        break;

      case 'repair_started':
        this.onRepairStarted?.(
          message.structure_id ?? 0,
          message.player_id ?? 0,
          message.hp ?? 0,
          message.max_hp ?? 0,
          message.target_hp ?? 0,
        );
        break;

      case 'repair_cancelled':
        this.onRepairCancelled?.(message.structure_id ?? 0, message.player_id ?? 0);
        break;

      case 'repair_complete':
        this.onRepairComplete?.(message.structure_id ?? 0, message.player_id ?? 0);
        break;

      case 'repair_fail':
        this.onRepairFail?.(message.structure_id ?? 0, message.reason ?? 'unknown');
        break;

      case MessageType.COMMAND_RESPONSE:
      case 'command_response':
        this.onCommandResponse?.(message.text ?? message.message ?? '', message.success !== false);
        break;

      case 'player_teleported':
        this.onPlayerTeleported?.(
          message.player_id ?? 0,
          message.x ?? 0,
          message.y ?? 0,
          message.parent_ship ?? 0,
          message.local_x ?? 0,
          message.local_y ?? 0,
        );
        break;

      case 'crafting_open':
        this.onCraftingOpen?.(
          message.structure_id ?? 0,
          message.structure_type ?? 'workbench',
          message.module_id ?? 0,
        );
        break;

      case 'land_chest_state': {
        const res = { wood: message.wood ?? 0, fiber: message.fiber ?? 0, metal: message.metal ?? 0, stone: message.stone ?? 0 };
        const playerRes = (message.player_wood != null) ? { wood: message.player_wood ?? 0, fiber: message.player_fiber ?? 0, metal: message.player_metal ?? 0, stone: message.player_stone ?? 0 } : undefined;
        const readOnly = message.read_only === true;
        this.onLandChestState?.(message.structure_id ?? 0, res, playerRes, readOnly);
        break;
      }

      case 'shipyard_state': {
        const phase = message.phase === 'building' ? 'building' : 'empty' as const;
        const modules: string[] = Array.isArray(message.modules_placed) ? message.modules_placed : [];
        const yardResources = {
          wood:  message.wood  ?? 0,
          fiber: message.fiber ?? 0,
          metal: message.metal ?? 0,
          stone: message.stone ?? 0,
        };
        const playerResources = (message.player_wood != null) ? {
          wood:  message.player_wood  ?? 0,
          fiber: message.player_fiber ?? 0,
          metal: message.player_metal ?? 0,
          stone: message.player_stone ?? 0,
        } : undefined;
        this.onShipyardState?.(
          message.structure_id ?? 0, phase, modules,
          message.ship_spawned, message.scaffolded_ship_id, message.spawner_player_id,
          yardResources, playerResources,
        );
        break;
      }

      case 'shipyard_action_fail':
        this.onShipyardActionFail?.(message.reason ?? 'unknown');
        break;

      case 'FLAME_CONE_FIRE': // legacy — ignore
        break;

      case 'CANNON_FIRE_EVENT': {
        this.onCannonFireEvent?.(
          message.cannonId    ?? 0,
          message.shipId      ?? 0,
          message.x           ?? 0,
          message.y           ?? 0,
          message.angle       ?? 0,
          message.projectileId ?? 0,
          message.ammoType    ?? 0,
        );
        break;
      }

      case 'island_cannon_mounted': {
        this.onIslandCannonMounted?.(
          message.structure_id ?? 0,
          message.aim_angle    ?? 0,
          message.reload_ms    ?? 0,
          message.mount_x      ?? 0,
          message.mount_y      ?? 0,
          message.rotation     ?? 0,
        );
        break;
      }

      case 'FLAME_WAVE_UPDATE': {
        this.onFlameWaveUpdate?.(
          message.cannonId    ?? 0,
          message.shipId      ?? 0,
          message.x           ?? 0,
          message.y           ?? 0,
          message.angle       ?? 0,
          message.halfCone    ?? 0.2618,
          message.waveDist    ?? 0,
          message.retreating  ?? false,
          message.retreatDist ?? 0,
          message.dead        ?? false,
        );
        break;
      }

      case 'ladder_state': {
        this.onLadderState?.(
          message.ship_id  ?? 0,
          message.module_id ?? 0,
          message.retracted ?? false,
        );
        break;
      }

      case 'SWORD_SWING': {
        this.onSwordSwing?.(
          message.playerId ?? 0,
          message.x        ?? 0,
          message.y        ?? 0,
          message.angle    ?? 0,
          message.range    ?? 80,
        );
        break;
      }

      case 'SHIP_LEVEL_UP': {
        const lvlShipId:         number = message.shipId          || 0;
        const lvlAttribute:      string = message.attribute        || '';
        const lvlAttrLevel:      number = message.level            || 1;
        const lvlXp:             number = message.xp               ?? 0;
        const lvlShipLevel:      number = message.shipLevel        ?? 0;
        const lvlTotalCap:       number = message.totalCap         || 65;
        const lvlNextCost:       number = message.nextUpgradeCost  ?? 0;
        console.log(`⬆️  SHIP_LEVEL_UP: ship ${lvlShipId} ${lvlAttribute} → L${lvlAttrLevel} | ship level ${lvlShipLevel}/${lvlTotalCap} | next cost ${lvlNextCost} | ${lvlXp} XP left`);
        this.onShipLevelUp?.(lvlShipId, lvlAttribute, lvlAttrLevel, lvlXp, lvlShipLevel, lvlTotalCap, lvlNextCost);
        break;
      }

      case 'ship_xp_gained': {
        const xpShipId: number  = message.shipId  || 0;
        const xpAmount: number  = message.xp      || 0;
        const xpX: number       = message.x       ?? 0;
        const xpY: number       = message.y       ?? 0;
        const xpShared: boolean = message.shared   ?? false;
        this.onShipXpGained?.(xpShipId, xpAmount, xpX, xpY, xpShared);
        break;
      }

      case 'ship_unclaimed': {
        const unclaimedShipId: number = message.shipId || 0;
        console.log(`⚓ ship_unclaimed: ship ${unclaimedShipId} is now unclaimed`);
        this.onShipUnclaimed?.(unclaimedShipId);
        break;
      }

      case 'ship_claimed': {
        const claimedShipId: number  = message.shipId    || 0;
        const claimedCompany: number = message.companyId ?? 0;
        console.log(`⚓ ship_claimed: ship ${claimedShipId} → company ${claimedCompany}`);
        this.onShipClaimed?.(claimedShipId, claimedCompany);
        break;
      }

      case 'flag_planted': {
        console.log(`🚩 flag_planted: ship ${message.shipId} by player ${message.planterId} (company ${message.planterCompany})`);
        this.onFlagPlanted?.(message.shipId ?? 0, message.planterId ?? 0, message.planterCompany ?? 0);
        break;
      }

      case 'flag_update': {
        // Keep ship claimFlag state in sync (ship broadcast already has it, but this is a faster path)
        this.onFlagUpdate?.(message.shipId ?? 0, message.planterId ?? 0, message.planterCompany ?? 0,
          message.progressMs ?? 0, message.totalMs ?? 300000, message.contested ?? false);
        break;
      }

      case 'flag_removed': {
        console.log(`🚩 flag_removed: ship ${message.shipId} by player ${message.removerId}`);
        this.onFlagRemoved?.(message.shipId ?? 0);
        break;
      }

      case 'flag_capture_complete': {
        console.log(`🚩 flag_capture_complete: ship ${message.shipId} → company ${message.planterCompany}`);
        this.onFlagCaptureComplete?.(message.shipId ?? 0, message.planterCompany ?? 0);
        break;
      }

      case 'salvage_success': {
        const salvageItem: number = message.item     ?? 0;
        const salvageQty:  number = message.quantity ?? 1;
        console.log(`🪵 salvage_success: item ${salvageItem} ×${salvageQty} (wreck_id=${message.wreck_id ?? '?'}, remaining=${message.remaining ?? '?'})`);
        this.onSalvageSuccess?.(salvageItem, salvageQty);
        break;
      }

      case 'npc_unclaimed': {
        const unclaimedNpcId: number = message.npcId || 0;
        console.log(`⚓ npc_unclaimed: NPC ${unclaimedNpcId} is now unclaimed`);
        this.onNpcUnclaimed?.(unclaimedNpcId);
        break;
      }

      case 'schematic_list': {
        const rawItems: any[] = Array.isArray(message.items) ? message.items : [];
        const items: SchematicEntry[] = rawItems.map((it: any) => ({
          index:  typeof it.i === 'number' ? it.i : 0,
          item:   typeof it.item === 'number' ? it.item : 0,
          quality: typeof it.q === 'number' ? it.q : 0,
          tier:   typeof it.tier === 'number' ? it.tier : 0,
          crafts: typeof it.crafts === 'number' ? it.crafts : 0,
          stats:  Array.isArray(it.stats) ? it.stats.map((s: any) => (typeof s === 'number' ? s : 0)) : [0, 0, 0, 0, 0],
        }));
        this.onSchematicList?.(items);
        break;
      }

      case 'ship_schematic_list': {
        const shipId: number = message.ship_id ?? 0;
        const rawItems: any[] = Array.isArray(message.items) ? message.items : [];
        const items: ShipSchematicEntry[] = rawItems.map((it: any) => ({
          index:  typeof it.i === 'number' ? it.i : 0,
          item:   typeof it.item === 'number' ? it.item : 0,
          quality: typeof it.q === 'number' ? it.q : 0,
          tier:   typeof it.tier === 'number' ? it.tier : 0,
          crafts: typeof it.crafts === 'number' ? it.crafts : 0,
          prio:   typeof it.prio === 'number' ? it.prio : 0,
          stats:  Array.isArray(it.stats) ? it.stats.map((s: any) => (typeof s === 'number' ? s : 0)) : [0, 0, 0, 0, 0],
        }));
        this.onShipSchematicList?.(shipId, items);
        break;
      }

      case 'salvage_blueprint': {
        this.onSalvageBlueprint?.(
          message.item ?? 0,
          message.tier ?? 0,
          message.crafts ?? 0,
          message.wreck_id ?? 0,
          message.bp_remaining ?? 0,
          message.loot_remaining ?? 0,
        );
        break;
      }

      case 'craft_blueprint_result': {
        this.onCraftBlueprintResult?.(
          message.success === true,
          message.index ?? -1,
          message.reason ?? '',
          message.item ?? 0,
          message.tier ?? 0,
          message.crafts_remaining ?? 0,
        );
        break;
      }

      case 'place_structure_fail':
        console.warn(`[place_structure_fail] type=${message.structure_type ?? '?'} reason=${message.reason ?? '?'} pos=(${message.x ?? '?'}, ${message.y ?? '?'})${message.blocker_id != null ? ` blocker_id=${message.blocker_id}` : ''}`);
        this.onPlacementFailed?.(
          message.reason ?? 'unknown',
          message.x ?? 0,
          message.y ?? 0,
          message.structure_type ?? '',
          message.blocker_id != null ? (message.blocker_id as number) : null,
        );
        break;

      case 'tombstone_spawned': {
        this.onTombstoneSpawned?.({
          id:          message.id          ?? 0,
          x:           message.x           ?? 0,
          y:           message.y           ?? 0,
          ownerName:   message.ownerName   ?? '',
          remainingMs: message.ttlMs       ?? 900000,
          slots:       message.slots,
          armor:       message.armor,
          shield:      message.shield,
        });
        break;
      }

      case 'tombstone_collected':
        this.onTombstoneCollected?.(message.id ?? 0, message.playerId ?? 0);
        break;

      case 'tombstone_despawned':
        this.onTombstoneDespawned?.(message.id ?? 0);
        break;

      case 'tombstone_items':
        this.onTombstoneItems?.(
          message.id ?? 0,
          message.ownerName ?? '',
          message.slots ?? [],
          message.equip ?? {}
        );
        break;

      case 'structure_reload':
        if (typeof message.structure_id === 'number' && typeof message.reload_ms === 'number') {
          const loadedAmmo = typeof message.loaded_ammo === 'number' ? message.loaded_ammo : 0;
          this.onStructureReload?.(message.structure_id, message.reload_ms, loadedAmmo);
        }
        break;

      case 'tombstone_collect_fail':
        // silently ignore — server already sent reason
        break;

      case MessageType.CHAT_BROADCAST:
        this.onChatMessage?.(
          message.channel   ?? 'global',
          message.senderName ?? 'Unknown',
          message.text       ?? ''
        );
        break;

      case 'message_ack':
        if (message.status === 'aim_updated' &&
            typeof message.structure_id === 'number' &&
            typeof message.cannon_aim_angle === 'number') {
          this.onIslandCannonAimSync?.(message.structure_id, message.cannon_aim_angle);
        }
        if (message.status === 'no_ammo') {
          this.onNoAmmo?.();
        }
        if (typeof message.status === 'string' && message.status.startsWith('bucket_')) {
          this.onBucketAck?.(message.status, {
            amount: typeof message.amount === 'number' ? message.amount : undefined,
            bucketFill: typeof message.bucketFill === 'number' ? message.bucketFill : undefined,
            remainingMs: typeof message.remainingMs === 'number' ? message.remainingMs : undefined,
          });
        }
        break;

      case 'deck_level_ack':
        // Server echoes the authoritative deck level after every player_set_deck request.
        // If the transition was rejected, deckLevel differs from what the client requested —
        // fire the callback so RenderSystem and PredictionEngine can roll back.
        if (typeof message.deckLevel === 'number') {
          this.onDeckLevelAck?.(message.deckLevel);
        }
        break;

      case 'grapple_boarded':
        if (typeof message.deckLevel === 'number') {
          this.onDeckLevelAck?.(message.deckLevel);
        }
        if (typeof message.x === 'number' && typeof message.y === 'number') {
          this.onGrappleBoarded?.({
            shipId: message.ship_id ?? 0,
            deckLevel: message.deckLevel ?? 1,
            x: message.x,
            y: message.y,
            localX: message.local_x ?? 0,
            localY: message.local_y ?? 0,
          });
        }
        break;

      default:
        break;
    }
  }
  
  private handlePong(pongMessage: PingPongMessage): void {
    // Since server just sends "PONG" text, use the most recent ping timestamp
    if (this.pendingPings.size > 0) {
      // Get the most recent ping timestamp (should only be one)
      const timestamps = Array.from(this.pendingPings.values());
      const sendTime = timestamps[timestamps.length - 1];
      
      // Calculate ping
      const ping = Date.now() - sendTime;
      this.latency = ping; // Update latency field
      this.stats.ping = ping;
      
      // Clear all pending pings
      this.pendingPings.clear();
      
      console.log(`🏓 Ping: ${ping}ms`);
    }
  }
  
  /**
   * Handle successful module interaction (mounting)
   */
  private handleModuleInteractSuccess(message: ModuleInteractSuccessMessage): void {
    // Ladder toggle responses have an "action" field instead of "module_kind".
    // They are not mount events — just acknowledge the state change.
    const action = (message as any).action as string | undefined;
    if (action === 'ladder_retracted' || action === 'ladder_extended') {
      console.log(`🪜 Ladder interact success: ${action}`);
      return;
    }
    if (action === 'unmounted') {
      // Server acknowledged dismount — mount state is updated via GAME_STATE / onMountStateUpdate
      console.log('🎮 Module interact success: unmounted');
      return;
    }

    // Guard: module_kind missing on unexpected response shapes
    if (!message.module_kind) {
      console.warn('⚠️ module_interact_success missing module_kind, ignoring', message);
      return;
    }

    console.log(`✅ [MOUNT] Successfully mounted to ${message.module_kind.toUpperCase()} (ID: ${message.module_id})`);
    
    // Parse mount offset if provided
    let mountOffset: Vec2 | undefined;
    if (message.mount_offset) {
      mountOffset = Vec2.from(message.mount_offset.x, message.mount_offset.y);
    }
    
    // Notify application layer
    this.onModuleMountSuccess?.(message.module_id, message.module_kind, mountOffset);
  }
  
  /**
   * Handle failed module interaction
   */
  private handleModuleInteractFailure(message: ModuleInteractFailureMessage): void {
    console.log(`❌ [MOUNT] Failed to mount: ${message.reason}`);
    this.onModuleMountFailure?.(message.reason);
  }
  
  /**
   * Send module interaction to server
   */
  sendToggleLadder(moduleId: number): void {
    this.sendMessage({ type: 'toggle_ladder' as any, module_id: moduleId, moduleId, timestamp: Date.now() } as any);
  }

  sendModuleInteract(moduleId: number): void {
    const message: ModuleInteractMessage = {
      type: MessageType.MODULE_INTERACT,
      module_id: moduleId,
      timestamp: Date.now()
    };
    
    this.sendMessage(message);
  }
  
  private sendMessage(message: GameMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ [NETWORK] Cannot send message - socket not connected');
      return;
    }
    
    try {
      const data = JSON.stringify(message);
      this.socket.send(data);
      this.stats.messagesSent++;
      this.stats.bytesSent += data.length;
      
      // Log MODULE_INTERACT messages
      if (message.type === MessageType.MODULE_INTERACT) {
        console.log(`📤 [NETWORK] Sent MODULE_INTERACT for module ${(message as any).module_id}`);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }
  
  private startHeartbeat(): void {
    // Send ping every heartbeat interval
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.config.heartbeatInterval);
  }
  
  private sendPing(): void {
    const sequenceId = this.messageSequenceId++;
    const timestamp = Date.now();
    
    // For now, send simple PING text that server expects
    // Store the timestamp for the most recent ping
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send('PING');
      // Clear old pings and store only the latest
      this.pendingPings.clear();
      this.pendingPings.set(sequenceId, timestamp);
      this.stats.messagesSent++;
      this.stats.bytesSent += 4; // PING length
      
      // Clean up old pings (prevent memory leak)
      const oldPingThreshold = timestamp - 10000; // 10 seconds
      for (const [id, time] of this.pendingPings.entries()) {
        if (time < oldPingThreshold) {
          this.pendingPings.delete(id);
        }
      }
    }
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('❌ Max reconnection attempts reached');
      this.connectionState = ConnectionState.ERROR;
      this.isConnecting = false; // Reset flag when giving up
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff
    
    console.log(`🔄 Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    this.connectionState = ConnectionState.RECONNECTING;
    this.isConnecting = false; // Reset flag before scheduling reconnect
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('Reconnection failed:', error);
      });
    }, delay);
  }
}