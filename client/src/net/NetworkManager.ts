/**
 * Network Manager - Client-Server Communication
 * 
 * Manages the connection to the game server and handles all network communication.
 * Supports WebSocket with planned WebTransport upgrade.
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';
import { createShipAtPosition } from '../sim/ShipUtils.js';
import { ShipModule, ModuleKind, MODULE_TYPE_MAP } from '../sim/modules.js';

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
  CANNON_FIRE = 'cannon_fire',
  
  PING = 'ping',
  
  // Server to Client  
  HANDSHAKE_RESPONSE = 'handshake_response',
  WORLD_STATE = 'world_state',
  SNAPSHOT = 'snapshot',
  PONG = 'pong',
  MESSAGE_ACK = 'message_ack',
  MODULE_INTERACT_SUCCESS = 'module_interact_success',
  MODULE_INTERACT_FAILURE = 'module_interact_failure',
  
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
}

/**
 * Cannon fire message
 */
interface CannonFireMessage extends NetworkMessage {
  type: MessageType.CANNON_FIRE;
  timestamp: number;
  cannon_ids?: number[]; // Specific cannons to fire, or undefined for all aimed cannons
  fire_all?: boolean;    // True if double-click (fire all cannons)
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

type GameMessage = HandshakeMessage | InputMessage | MovementStateMessage | RotationUpdateMessage | ActionEventMessage | ModuleInteractMessage | ModuleInteractSuccessMessage | ModuleInteractFailureMessage | ShipSailControlMessage | ShipRudderControlMessage | ShipSailAngleControlMessage | CannonAimMessage | CannonFireMessage | PingPongMessage | WorldStateMessage | AckMessage;

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
  
  // Event callbacks
  public onWorldStateReceived: ((worldState: WorldState) => void) | null = null;
  public onConnectionStateChanged: ((state: ConnectionState) => void) | null = null;
  public onModuleMountSuccess: ((moduleId: number, moduleKind: string, mountOffset?: Vec2) => void) | null = null;
  public onModuleMountFailure: ((reason: string) => void) | null = null;
  
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
            resolve();
          } else if (data.includes('message_ack') || data.includes('status') || data.startsWith('PONG')) {
            // Fallback acknowledgment
            clearTimeout(timeout);
            this.socket!.onmessage = originalHandler;
            console.log('🤝 Handshake completed - Server acknowledged');
            this.requestGameState();
            resolve();
          } else {
            // Any response means server is alive - accept it
            clearTimeout(timeout);
            this.socket!.onmessage = originalHandler;
            console.log('🤝 Handshake completed (server responded)');
            this.requestGameState();
            resolve();
          }
        } catch (error) {
          console.warn('Error during handshake:', error);
          // Still continue - server is responding
          clearTimeout(timeout);
          this.socket!.onmessage = originalHandler;
          console.log('🤝 Handshake completed (server alive)');
          this.requestGameState();
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
      this.stats.bytesSent += 5; // 'STATE'.length
      console.log('📤 Requested game state from server');
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
      console.log(`🔍 Input frame check - Movement: ${hasMovement}, Actions: ${hasActions}, Sending: ${shouldSend}`);
      
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
      
      console.log(`🎮 Sending input - Movement: (${inputFrame.movement.x.toFixed(2)}, ${inputFrame.movement.y.toFixed(2)}), Rotation: ${inputFrame.rotation.toFixed(2)} rad, Magnitude: ${movementMagnitude.toFixed(2)}, Actions: ${inputFrame.actions}`);
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

    console.log(`⚡ Action: ${action}${target ? ` at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})` : ''}`);
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

  /**
   * Send cannon aim update (right-click hold + mouse move)
   * Aim angle is relative to ship rotation
   */
  sendCannonAim(aimAngle: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: CannonAimMessage = {
      type: MessageType.CANNON_AIM,
      timestamp: Date.now(),
      aim_angle: aimAngle
    };

    // Only log occasionally to avoid spam
    if (Math.random() < 0.05) {
      console.log(`🎯 Cannon aim: ${(aimAngle * 180 / Math.PI).toFixed(1)}°`);
    }
    this.sendMessage(message);
  }

  /**
   * Send cannon fire command
   * @param cannonIds - Specific cannon IDs to fire, or undefined for aimed cannons
   * @param fireAll - True if double-click (fire all cannons)
   */
  sendCannonFire(cannonIds?: number[], fireAll: boolean = false): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return;
    }

    const message: CannonFireMessage = {
      type: MessageType.CANNON_FIRE,
      timestamp: Date.now(),
      cannon_ids: cannonIds,
      fire_all: fireAll
    };

    console.log(`💥 Cannon fire: ${fireAll ? 'ALL' : cannonIds ? `IDs ${cannonIds.join(',')}` : 'aimed'}`);
    this.sendMessage(message);
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
            // Create proper ship with brigantine design (hull, deck, planks, modules)
            // This ensures all ships have the correct visual appearance and collision geometry
            const position = Vec2.from(ship.x || 0, ship.y || 0);
            const rotation = ship.rotation || 0;
            const properShip = createShipAtPosition(position, rotation);
            
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
              const plankHealthUpdates = new Map<number, number>();
              
              for (const mod of ship.modules) {
                const kind = MODULE_TYPE_MAP.toKind(mod.typeId);
                
                if (kind === 'plank') {
                  // Plank: Server only sends health, client generates positions
                  plankHealthUpdates.set(mod.id, mod.health ?? 100);
                } else if (kind === 'deck') {
                  // Deck: Client generates from hull, server sends ID only
                  // Skip - client already has deck module
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
                      maxAmmunition: 50
                    };
                  } else if (kind === 'helm' || kind === 'steering-wheel') {
                    moduleData = {
                      kind: kind,
                      maxTurnRate: 1.0,
                      responsiveness: 0.8,
                      currentInput: Vec2.from(0, 0),
                      wheelRotation: mod.wheelRot ?? 0,
                      occupied: mod.occupied ?? false
                    };
                  } else if (kind === 'mast') {
                    moduleData = {
                      kind: 'mast',
                      sailState: 'full',
                      openness: mod.openness ?? 0,
                      angle: mod.sailAngle ?? 0,
                      radius: 15,
                      height: 120,
                      sailWidth: 80,
                      sailColor: '#F5F5DC'
                    };
                  } else if (kind === 'ladder') {
                    moduleData = {
                      kind: 'ladder',
                      length: 40,
                      width: 20,
                      climbSpeed: 2.0,
                      deployState: 'deployed'
                    };
                  }
                  
                  gameplayModules.push({
                    id: mod.id,
                    kind: kind,
                    deckId: 0,
                    localPos: Vec2.from(mod.x || 0, mod.y || 0),
                    localRot: mod.rotation || 0,
                    occupiedBy: null,
                    stateBits: 0,
                    moduleData: moduleData
                  } as ShipModule);
                }
              }
              
              // Merge: Keep client-generated planks/deck, add server gameplay modules
              const clientPlanks = properShip.modules.filter(m => m.kind === 'plank');
              const clientDeck = properShip.modules.filter(m => m.kind === 'deck');
              
              // Update plank health from server data
              for (const plank of clientPlanks) {
                const serverHealth = plankHealthUpdates.get(plank.id);
                if (serverHealth !== undefined && plank.moduleData && plank.moduleData.kind === 'plank') {
                  plank.moduleData.health = serverHealth;
                }
              }
              
              // Combine: client planks/deck + server gameplay modules
              serverModules = [...clientDeck, ...clientPlanks, ...gameplayModules];
            }
            
            // Override with server's authoritative state
            return {
              ...properShip,
              id: ship.id || properShip.id, // Use server-assigned ship ID
              velocity: Vec2.from(ship.velocity_x || 0, ship.velocity_y || 0),
              angularVelocity: ship.angular_velocity || 0,
              
              // Use server modules if provided, otherwise keep client defaults
              modules: serverModules || properShip.modules,
              
              // Parse physics properties from server (override defaults if provided)
              // Server sends: mass, moment_of_inertia, max_speed, turn_rate, water_drag, angular_drag
              mass: ship.mass ?? properShip.mass,
              momentOfInertia: ship.moment_of_inertia ?? properShip.momentOfInertia,
              maxSpeed: ship.max_speed ?? properShip.maxSpeed,
              turnRate: ship.turn_rate ?? properShip.turnRate,
              waterDrag: ship.water_drag ?? properShip.waterDrag,
              angularDrag: ship.angular_drag ?? properShip.angularDrag,
              rudderAngle: ship.rudder_angle ?? 0,
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
              : undefined
          })),
          cannonballs: (message.projectiles || []).map((ball: any) => ({
            id: ball.id || 0,
            position: Vec2.from(ball.x || 0, ball.y || 0),
            velocity: Vec2.from(ball.vx || 0, ball.vy || 0),
            firingVelocity: Vec2.from(ball.vx || 0, ball.vy || 0), // Server doesn't send separate firingVelocity
            radius: 6, // Slightly less than cannon barrel width (~8-10 pixels)
            maxRange: 800,
            distanceTraveled: 0, // Server doesn't send this yet
            timeAlive: 0, // Server doesn't send this yet
            firedFrom: ball.owner || 0,
            smokeTrail: [] // No smoke trail from server yet
          })),
          carrierDetection: new Map() // Will be populated as needed
        };
        
        // Debug: Log cannonballs received
        if (worldState.cannonballs.length > 0) {
          console.log(`💥 Received ${worldState.cannonballs.length} cannonballs:`, worldState.cannonballs.map(cb => ({
            id: cb.id,
            pos: `(${cb.position.x.toFixed(1)}, ${cb.position.y.toFixed(1)})`,
            vel: `(${cb.velocity.x.toFixed(1)}, ${cb.velocity.y.toFixed(1)})`
          })));
        }
        
        
        // Debug: Log ship and player data
        if (worldState.ships.length > 0) {
          const ship = worldState.ships[0];
        }
        if (worldState.players.length > 0) {
          const player = worldState.players[0];
        }
        
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
        break;
        
      case MessageType.MODULE_INTERACT_SUCCESS:
        this.handleModuleInteractSuccess(message as ModuleInteractSuccessMessage);
        break;
        
      case MessageType.MODULE_INTERACT_FAILURE:
        this.handleModuleInteractFailure(message as ModuleInteractFailureMessage);
        break;
        
      default:
        console.log('📦 Received message:', message.type, message);
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