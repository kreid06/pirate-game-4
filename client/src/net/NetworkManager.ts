/**
 * Network Manager - Client-Server Communication
 * 
 * Manages the connection to the game server and handles all network communication.
 * Supports WebSocket with planned WebTransport upgrade.
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame, Npc, Ship, IslandDef, IslandResource, IslandPreset, PlacedStructure } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';
import { createShipAtPosition } from '../sim/ShipUtils.js';
import { ShipModule, ModuleKind, MODULE_TYPE_MAP } from '../sim/modules.js';
import { parseInventoryFromServer, createEmptyInventory } from '../sim/Inventory.js';

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
  UNEQUIP = 'unequip',
  GIVE_ITEM = 'give_item',
  PLACE_PLANK = 'place_plank',
  REPAIR_PLANK = 'repair_plank',
  REPAIR_SAIL = 'repair_sail',
  USE_HAMMER = 'use_hammer',
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
  PLACE_STRUCTURE  = 'place_structure',
  STRUCTURE_INTERACT = 'structure_interact',
  PLACE_MAST_AT = 'place_mast_at',
  REPLACE_HELM = 'replace_helm',
  PLACE_DECK = 'place_deck',
  PLACE_SWIVEL_AT = 'place_swivel_at',
  CREW_ASSIGN = 'crew_assign',
  NPC_RECRUIT = 'npc_recruit',
  NPC_MOVE_ABOARD = 'npc_move_aboard',
  NPC_LOCK = 'npc_lock',
  NPC_GOTO_MODULE = 'npc_goto_module',
  NPC_MOVE_TO_POS = 'npc_move_to_pos',

  PING = 'ping',
  
  // Server to Client  
  HANDSHAKE_RESPONSE = 'handshake_response',
  WORLD_STATE = 'world_state',
  SNAPSHOT = 'snapshot',
  PONG = 'pong',
  MESSAGE_ACK = 'message_ack',
  MODULE_INTERACT_SUCCESS = 'module_interact_success',
  MODULE_INTERACT_FAILURE = 'module_interact_failure',
  
  // Server notifications
  PLAYER_BOARDED = 'player_boarded',
  STRUCTURE_PLACED = 'structure_placed',
  STRUCTURE_DEMOLISHED = 'structure_demolished',
  DEMOLISH_STRUCTURE = 'demolish_structure',
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

interface PlacePlankMessage extends NetworkMessage {
  type: MessageType.PLACE_PLANK;
  timestamp: number;
  shipId: number;
  sectionName: string;
  segmentIndex: number;
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
}

interface ReplaceHelmMessage extends NetworkMessage {
  type: MessageType.REPLACE_HELM;
  timestamp: number;
  shipId: number;
}

interface PlaceDeckMessage extends NetworkMessage {
  type: MessageType.PLACE_DECK;
  timestamp: number;
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
}

interface StructureInteractMessage extends NetworkMessage {
  type: MessageType.STRUCTURE_INTERACT;
  timestamp: number;
  structure_id: number;
}

type GameMessage = HandshakeMessage | InputMessage | MovementStateMessage | RotationUpdateMessage | ActionEventMessage | ModuleInteractMessage | ModuleInteractSuccessMessage | ModuleInteractFailureMessage | ShipSailControlMessage | ShipRudderControlMessage | ShipSailAngleControlMessage | CannonAimMessage | CannonFireMessage | CannonGroupConfigMessage | PingPongMessage | WorldStateMessage | AckMessage | SlotSelectMessage | UnequipMessage | GiveItemMessage | PlacePlankMessage | PlaceCannonMessage | PlaceCannonAtMessage | PlaceMastMessage | PlaceMastAtMessage | ReplaceHelmMessage | PlaceDeckMessage | RepairPlankMessage | RepairSailMessage | UseHammerMessage | CrewAssignMessage | PlaceSwivelAtMessage | SwivelAimMessage | HarvestResourceMessage | PlaceStructureMessage | StructureInteractMessage;

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
  /** Brigantine hull/module template — created once, reused on every GAME_STATE message. */
  private _shipTemplate: { planks: ShipModule[]; deck: ShipModule[]; ship: Ship } | null = null;
  /** Plank-health lookup buffer — cleared and refilled each tick instead of being re-allocated. */
  private readonly _plankHealthBuf = new Map<number, { health: number; maxHealth: number }>();

  // Event callbacks
  public onWorldStateReceived: ((worldState: WorldState) => void) | null = null;
  public onConnectionStateChanged: ((state: ConnectionState) => void) | null = null;
  public onModuleMountSuccess: ((moduleId: number, moduleKind: string, mountOffset?: Vec2) => void) | null = null;
  public onModuleMountFailure: ((reason: string) => void) | null = null;
  public onModuleDestroyed: ((shipId: number, moduleId: number, damage: number, hitX?: number, hitY?: number) => void) | null = null;
  public onModuleDamaged: ((shipId: number, moduleId: number, damage: number, hitX?: number, hitY?: number) => void) | null = null;
  public onShipSunk: ((shipId: number) => void) | null = null;
  public onShipSinking: ((shipId: number) => void) | null = null;
  public onShipLevelUp: ((shipId: number, attribute: string, attrLevel: number, xp: number, shipLevel: number, totalCap: number, nextUpgradeCost: number) => void) | null = null;
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
  /** Fired when a cannonball hits an NPC or player. */
  /** Fired when any weapon fires — used to render hit-scan tracers (grapeshot, canister). */
  public onCannonFireEvent: ((cannonId: number, shipId: number, x: number, y: number,
    angle: number, projectileId: number, ammoType: number) => void) | null = null;

  public onEntityHit: ((entityType: 'npc' | 'player', id: number, x: number, y: number,
    damage: number, health: number, maxHealth: number, killed: boolean) => void) | null = null;
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
  public onCannonGroupState: ((shipId: number, groups: {index: number, mode: string, cannonIds: number[], targetShipId: number}[]) => void) | null = null;
  /** Fired when the server confirms the player has boarded a ship (via ladder). */
  public onPlayerBoarded: ((shipId: number) => void) | null = null;
  /** Fired when the server responds to a harvest_resource request. */
  public onHarvestResult: ((success: boolean, wood: number, reason: string) => void) | null = null;
  /** Fired when the server responds to a harvest_fiber request. */
  public onFiberHarvestResult: ((success: boolean, fiber: number, reason: string) => void) | null = null;
  /** Fired when the server responds to a harvest_rock request. */
  public onRockHarvestResult: ((success: boolean, metal: number, reason: string) => void) | null = null;
  /**
   * Fired once on connect with the full list of server-defined islands.
   * Falls back to client defaults if the server never sends this.
   */
  public onIslands: ((islands: IslandDef[]) => void) | null = null;

  /** Fired when the server broadcasts a newly placed structure to all clients. */
  public onStructurePlaced: ((s: PlacedStructure) => void) | null = null;
  /** Fired when the server confirms a structure has been demolished. */
  public onStructureDemolished: ((id: number, x?: number, y?: number) => void) | null = null;
  /** Fired when a structure's company ownership is promoted (one-way, neutral → non-neutral). */
  public onStructureCompanyUpdated: ((id: number, companyId: number) => void) | null = null;
  /** Fired when a structure takes damage from a cannonball hit. Includes world position for FX. */
  public onStructureHpChanged: ((id: number, hp: number, maxHp: number, x: number, y: number) => void) | null = null;
  /** Fired when a cannonball hits a tree (trees are indestructible). */
  public onTreeHit: ((x: number, y: number) => void) | null = null;
  /** Fired when the server sends the full list of existing placed structures on join. */
  public onStructuresList: ((structures: PlacedStructure[]) => void) | null = null;
  /** Fired when the server confirms a workbench can be opened (E-key interact). */
  public onCraftingOpen: ((structureId: number, structureType: string) => void) | null = null;
  /** Fired when the server responds to a craft_item request. */
  public onCraftResult: ((success: boolean, recipeId: string, reason?: string) => void) | null = null;
  /** Fired when a door is toggled open or closed by any player. */
  public onDoorToggled: ((id: number, open: boolean) => void) | null = null;

  /** Fired each server tick with the current state of an active flamethrower wave. */
  public onFlameWaveUpdate: ((
    cannonId: number, shipId: number,
    x: number, y: number, angle: number, halfCone: number,
    waveDist: number, retreating: boolean, retreatDist: number,
    dead: boolean
  ) => void) | null = null;
  
  constructor(config: NetworkConfig) {
    this.config = config;
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
  async connect(playerName?: string): Promise<void> {
    if (playerName) {
      this.playerName = playerName;
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
      const handshakeMessage = {
        type: 'handshake',
        playerName: this.playerName,
        protocolVersion: 1,
        timestamp: Date.now()
      };
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
        actions: inputFrame.actions
      };
      
      this.sendMessage(message);
    }
  }
  
  /**
   * Send movement state change (HYBRID PROTOCOL)
   * Only send when movement keys change, not every frame
   */
  sendMovementState(movement: Vec2, isMoving: boolean): void {
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
      is_moving: isMoving
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
  sendShipRudderControl(turningLeft: boolean, turningRight: boolean): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: ShipRudderControlMessage = {
      type: MessageType.SHIP_RUDDER_CONTROL,
      timestamp: Date.now(),
      turning_left: turningLeft,
      turning_right: turningRight
    };

    console.log(`🚢 Rudder: ${turningLeft ? 'LEFT' : turningRight ? 'RIGHT' : 'STRAIGHT'}`);
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

  /**
   * Force-reload the player's manned cannon, discarding the current round.
   * Tells the server to reset the reload timer so the cannon reloads immediately
   * into the newly-selected ammo type.
   */
  sendForceReload(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: 'cannon_force_reload' as any, timestamp: Date.now() });
    console.log('⚡ Force reload sent');
  }

  /**
   * Notify the server that the player selected a different hotbar slot.
   */
  sendSlotSelect(slot: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.SLOT_SELECT, timestamp: Date.now(), slot });
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
  sendPlacePlank(shipId: number, sectionName: string, segmentIndex: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_PLANK, timestamp: Date.now(), shipId, sectionName, segmentIndex });
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

  /**
   * Ask the server to place a structure (wooden_floor or workbench) at world (x, y).
   * The server validates that the player is on an island, has the item, and for
   * workbench that a floor tile is close enough.
   */
  sendPlaceStructure(structureType: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door', x: number, y: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_STRUCTURE, timestamp: Date.now(), structure_type: structureType, x, y });
  }

  /**
   * Ask the server to interact with a placed structure (e.g. open a workbench).
   */
  sendStructureInteract(structureId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.STRUCTURE_INTERACT, timestamp: Date.now(), structure_id: structureId });
  }

  sendDemolishStructure(structureId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'demolish_structure', timestamp: Date.now(), structure_id: structureId }));
  }

  /** Send a crafting request to the server for the given recipe ID. */
  sendCraftItem(recipeId: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'craft_item', recipe_id: recipeId, timestamp: Date.now() }));
  }

  /**
   * Apply a hammer-boosted instant repair (10 000 HP) to the most damaged plank.
   * Called only after the player wins the client-side hammer minigame.
   */
  sendUseHammer(shipId: number, moduleId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.USE_HAMMER, timestamp: Date.now(), shipId, moduleId });
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
  sendPlaceCannonAt(shipId: number, localX: number, localY: number, rotation: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_CANNON_AT, timestamp: Date.now(), shipId, localX, localY, rotation });
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
  sendPlaceMastAt(shipId: number, localX: number, localY: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_MAST_AT, timestamp: Date.now(), shipId, localX, localY });
  }

  /**
   * Request the server to place a new swivel gun at an arbitrary ship-local position.
   * localX/localY are ship-relative coordinates; rotation is in radians ship-relative.
   * Consumes 1 ITEM_SWIVEL from the player's inventory.
   */
  sendPlaceSwivelAt(shipId: number, localX: number, localY: number, rotation: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_SWIVEL_AT, timestamp: Date.now(), shipId, localX, localY, rotation });
  }

  /**
   * Request the server to replace the helm if it was destroyed.
   * Consumes 1 ITEM_HELM from the player's inventory.
   */
  sendReplaceHelm(shipId: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.REPLACE_HELM, timestamp: Date.now(), shipId });
  }

  /**
   * Request the server to place a missing deck module on the player's ship.
   * Consumes 1 ITEM_DECK from the player's inventory.
   */
  sendPlaceDeck(): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.sendMessage({ type: MessageType.PLACE_DECK, timestamp: Date.now() });
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

  /**
   * Request the server to spend NPC XP upgrading one stat.
   * stat must be one of: 'health' | 'damage' | 'stamina' | 'weight'
   */
  sendCrewUpgrade(npcId: number, stat: string): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'upgrade_crew_stat', npcId, stat }));
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
              console.warn('Failed to parse GAME_STATE:', data);
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
        const worldState: WorldState = {
          tick: message.tick || 0,
          timestamp: Date.now(),
          ships: (message.ships || []).map((ship: any) => {
            // Use cached brigantine template — avoids recreating hull curve geometry on every tick.
            if (!this._shipTemplate) {
              const s = createShipAtPosition(Vec2.from(0, 0), 0);
              this._shipTemplate = {
                planks: s.modules.filter(m => m.kind === 'plank'),
                deck:   s.modules.filter(m => m.kind === 'deck'),
                ship:   s,
              };
            }
            const tmpl = this._shipTemplate;
            
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
              let deckStateBitsFromServer: number | undefined;
              
              for (const mod of ship.modules) {
                const kind = MODULE_TYPE_MAP.toKind(mod.typeId);
                
                if (kind === 'plank') {
                  // Plank: Server only sends health, client generates positions
                  plankHealthBuf.set(mod.id, {
                    health: mod.health ?? 10000,
                    maxHealth: mod.maxHealth ?? 10000,
                  });
                } else if (kind === 'deck') {
                  // Deck: client generates polygon from hull; track state bits to apply after
                  if (mod.stateBits !== undefined) {
                    deckStateBitsFromServer = mod.stateBits ?? 0;
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
                      maxHealth: mod.maxHealth ?? 8000,
                      stateBits: mod.state ?? 0,
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
                      maxHealth: mod.maxHealth ?? 4000,
                    };
                  }
                  
                  gameplayModules.push({
                    id: mod.id,
                    kind: kind,
                    deckId: 0,
                    localPos: Vec2.from(mod.x || 0, mod.y || 0),
                    localRot: mod.rotation || 0,
                    occupiedBy: null,
                    stateBits: mod.state ?? 0,
                    moduleData: moduleData
                  } as ShipModule);
                }
              }
              
              // Merge: Keep client-generated planks/deck (shallow-cloned from template) + server gameplay modules.
              // Plank objects are cloned so health can be updated per-tick without mutating the template.
              const clientDeck = tmpl.deck.map(p => ({
                ...p,
                stateBits: deckStateBitsFromServer !== undefined ? deckStateBitsFromServer : p.stateBits,
              }) as ShipModule);

              // Only include planks the server still reports — absence means destroyed.
              // Build with updated health directly (avoids separate filter + mutation loop).
              const activePlanks = tmpl.planks
                .filter(p => plankHealthBuf.has(p.id))
                .map(p => {
                  const d = plankHealthBuf.get(p.id)!;
                  const md = p.moduleData;
                  return {
                    ...p,
                    moduleData: md?.kind === 'plank'
                      ? { ...md, health: d.health, maxHealth: d.maxHealth }
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
              rotation: ship.rotation || 0,
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
            deckId: player.deckId || 0,
            onDeck: player.state === 'WALKING' || player.state === 'onship', // Server sends state field (WALKING, SWIMMING, etc.)
            
            // Local (ship-relative) position when on a ship
            localPosition: (player.local_x !== undefined && player.local_y !== undefined)
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
                  player.inventory.armor ?? 0,
                  player.inventory.shield ?? 0,
                )
              : createEmptyInventory(),

            companyId: player.company ?? 0,
            health: player.health ?? 100,
            maxHealth: player.max_health ?? 100,
            onIslandId: player.on_island ?? 0,
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
          })),
          carrierDetection: new Map() // Will be populated as needed
        };
        
        this.onWorldStateReceived?.(worldState);
        break;
        
      case MessageType.PONG: // Handles both 'pong' enum and text response
        this.handlePong(message);
        break;
        
      case MessageType.HANDSHAKE_RESPONSE:
        console.log('🤝 Received handshake response:', message);
        // Extract and store the server-assigned player ID
        if (message.player_id !== undefined) {
          this.assignedPlayerId = message.player_id;
          console.log(`🎮 Server assigned player ID: ${this.assignedPlayerId}`);
        }
        break;
        
      case MessageType.MESSAGE_ACK:
        if (message.status === 'npc_moved_to_module') {
          this.onNpcMoveResult?.(true, message.npcId ?? 0);
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
        this.onFiberHarvestResult?.(true, message.fiber ?? 0, '');
        break;

      case MessageType.HARVEST_FIBER_FAILURE:
        this.onFiberHarvestResult?.(false, 0, message.reason ?? 'unknown');
        break;

      case MessageType.HARVEST_ROCK_SUCCESS:
        this.onRockHarvestResult?.(true, message.metal ?? 0, '');
        break;

      case MessageType.HARVEST_ROCK_FAILURE:
        this.onRockHarvestResult?.(false, 0, message.reason ?? 'unknown');
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

      case MessageType.CANNON_GROUP_STATE: {
        const gsShipId: number = message.shipId || 0;
        const gsGroups = Array.isArray(message.groups) ? message.groups.map((g: any) => ({
          index: g.index ?? 0,
          mode: g.mode ?? 'haltfire',
          cannonIds: Array.isArray(g.cannonIds) ? g.cannonIds.map((id: any) => Number(id)) : [],
          targetShipId: g.targetShipId ?? 0,
        })) : [];
        this.onCannonGroupState?.(gsShipId, gsGroups);
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
        console.log(`💥 PLANK_HIT: ship ${plankShipId} plank ${plankId} destroyed — ${plankDmg} dmg at (${plankHitX}, ${plankHitY})`);
        this.onModuleDestroyed?.(plankShipId, plankId, plankDmg, plankHitX, plankHitY);
        break;
      }

      case 'PLANK_DAMAGED': {
        // Non-fatal plank hit — spawn damage number only
        const plankShipId: number = message.shipId || 0;
        const plankId: number = message.plankId || 0;
        const plankDamage: number = message.damage || 0;
        const plankHitX: number | undefined = message.x;
        const plankHitY: number | undefined = message.y;
        console.log(`💥 PLANK_DAMAGED: ship ${plankShipId} plank ${plankId} — ${plankDamage} dmg at (${plankHitX}, ${plankHitY})`);
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

      case 'ISLANDS': {
        const islands: IslandDef[] = (message.islands ?? []).map((isl: any) => ({
          id:        isl.id       ?? 0,
          x:         isl.x       ?? 0,
          y:         isl.y       ?? 0,
          preset:    (isl.preset ?? 'tropical') as IslandPreset,
          resources: (isl.resources ?? []).map((r: any): IslandResource => ({
            ox:   r.ox   ?? 0,
            oy:   r.oy   ?? 0,
            type: (r.type ?? 'wood') as IslandResource['type'],
          })),
        }));
        this.onIslands?.(islands);
        break;
      }

      case 'STRUCTURES': {
        const structs: PlacedStructure[] = (message.structures ?? []).map((s: any): PlacedStructure => ({
          id:        s.id       ?? 0,
          type:      s.structure_type === 'workbench'  ? 'workbench'
                   : s.structure_type === 'wall'       ? 'wall'
                   : s.structure_type === 'door_frame' ? 'door_frame'
                   : s.structure_type === 'door'       ? 'door'
                   : 'wooden_floor',
          islandId:  s.island_id ?? 0,
          x:         s.x ?? 0,
          y:         s.y ?? 0,
          companyId: s.company_id ?? 0,
          hp:        s.hp     ?? 100,
          maxHp:     s.max_hp ?? 100,
          placerName: s.placer_name ?? '',
          doorOpen:  s.open ?? false,
        }));
        this.onStructuresList?.(structs);
        break;
      }

      case 'structure_placed': {
        const sp: PlacedStructure = {
          id:        message.id       ?? 0,
          type:      message.structure_type === 'workbench'  ? 'workbench'
                   : message.structure_type === 'wall'       ? 'wall'
                   : message.structure_type === 'door_frame' ? 'door_frame'
                   : message.structure_type === 'door'       ? 'door'
                   : 'wooden_floor',
          islandId:  message.island_id ?? 0,
          x:         message.x ?? 0,
          y:         message.y ?? 0,
          companyId: message.company_id ?? 0,
          hp:        message.hp     ?? 100,
          maxHp:     message.max_hp ?? 100,
          placerName: message.placer_name ?? '',
          doorOpen:  message.open ?? false,
        };
        this.onStructurePlaced?.(sp);
        break;
      }

      case 'door_toggled':
        this.onDoorToggled?.(message.id ?? 0, message.open === true);
        break;

      case 'structure_demolished':
        this.onStructureDemolished?.(
          message.structure_id ?? message.id ?? 0,
          message.x,
          message.y,
        );
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

      case 'crafting_open':
        this.onCraftingOpen?.(message.structure_id ?? 0, message.structure_type ?? 'workbench');
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
      
      // Also periodically request game state to keep world updated
      if (Math.random() < 0.3) { // 30% chance each heartbeat to avoid spam
        this.requestGameState();
      }
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