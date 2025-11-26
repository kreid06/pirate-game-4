/**
 * UDP Network Manager - Dual Protocol Client
 * 
 * Handles communication with the C-based physics server using both:
 * 1. Text-based protocol for basic commands (PING, JOIN, STATE, ECHO)
 * 2. Binary protocol for real-time game data (inputs, snapshots)
 * 
 * Since browsers don't support raw UDP, this uses WebSocket
 * with a UDP bridge on the server side.
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame, Ship, Player, Cannonball } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';
import { BRIGANTINE_PHYSICS } from '../common/ShipDefinitions.js';

// Protocol constants matching server
const PROTOCOL_VERSION = 1;
const MAX_PACKET_SIZE = 1400;

// Packet types from server protocol
export enum PacketType {
  CLIENT_HANDSHAKE = 1,
  SERVER_HANDSHAKE = 2,
  CLIENT_INPUT = 3,
  SERVER_SNAPSHOT = 4,
  CLIENT_ACK = 5,
  HEARTBEAT = 6
}

// Network connection states
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting', 
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

// Network statistics
export interface NetworkStats {
  ping: number;
  packetLoss: number;
  bytesReceived: number;
  bytesSent: number;
  packetsReceived: number;
  packetsSent: number;
  messagesReceived: number; // Alias for packetsReceived for compatibility
  messagesSent: number;     // Alias for packetsSent for compatibility
  averageFPS: number;       // Server tick rate
  connectionState: ConnectionState;
}

// Client handshake packet structure
interface ClientHandshakePacket {
  type: PacketType.CLIENT_HANDSHAKE;
  version: number;
  clientId: number;
  playerName: string;
  checksum: number;
}

// Server handshake response
interface ServerHandshakePacket {
  type: PacketType.SERVER_HANDSHAKE;
  version: number;
  playerId: number;
  serverTime: number;
  checksum: number;
}

// Client input packet - matches server CmdPacket struct
interface ClientInputPacket {
  type: PacketType.CLIENT_INPUT;
  version: number;
  sequence: number;
  deltaTime: number;  // dt_ms - delta time echo for RTT
  thrust: number;     // Q0.15 fixed-point [-1.0, 1.0]
  turn: number;       // Q0.15 fixed-point [-1.0, 1.0] 
  actions: number;    // Bitfield actions
  clientTime: number; // Client timestamp (ms)
  checksum: number;   // Simple checksum for corruption detection
}

// Server snapshot header - matches server SnapHeader struct
interface ServerSnapshotPacket {
  type: PacketType.SERVER_SNAPSHOT;
  version: number;
  serverTime: number;   // Server tick timestamp
  baseId: number;       // Baseline snapshot ID for delta compression
  snapId: number;       // This snapshot ID
  aoiCell: number;      // AOI cell ID for validation
  entityCount: number;  // Number of entities in this snapshot
  flags: number;        // Compression flags, priority tier
  checksum: number;     // Packet integrity
  entities: EntityUpdate[];
}

// Entity update structure - matches server EntityUpdate struct
interface EntityUpdate {
  entityId: number;      // Entity identifier
  posX: number;          // Position X * 512 (1/512m precision)
  posY: number;          // Position Y * 512
  velX: number;          // Velocity X * 256 (1/256 m/s precision)
  velY: number;          // Velocity Y * 256
  rotation: number;      // Rotation * 1024/2π (1/1024 radian precision)
  stateFlags: number;    // Health, actions, module states
  reserved: number;      // Padding for alignment
}

/**
 * UDP Network Manager for binary protocol communication
 */
export class UDPNetworkManager {
  private config: NetworkConfig;
  private socket: WebSocket | null = null;
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  
  // Protocol state
  private clientId: number;
  private playerId: number = 0;
  private localSequence: number = 0;
  private remoteSequence: number = 0;
  
  // Statistics
  private stats: NetworkStats = {
    ping: 0,
    packetLoss: 0,
    bytesReceived: 0,
    bytesSent: 0,
    packetsReceived: 0,
    packetsSent: 0,
    messagesReceived: 0,
    messagesSent: 0,
    averageFPS: 0,
    connectionState: ConnectionState.DISCONNECTED
  };
  
  // Timing
  private lastPingTime: number = 0;
  private serverTimeOffset: number = 0;
  private lastSnapshotTime: number = 0;
  private snapshotCount: number = 0;
  
  // Event handlers
  private onWorldStateUpdate: ((worldState: WorldState) => void) | null = null;
  private onConnectionStateChange: ((state: ConnectionState) => void) | null = null;
  private onTextMessage: ((message: string) => void) | null = null; // For text protocol responses
  
  constructor(config: NetworkConfig) {
    this.config = config;
    this.clientId = Math.floor(Math.random() * 0xFFFFFFFF);
  }
  
  /**
   * Send text-based protocol command (PING, JOIN, STATE, ECHO)
   */
  sendTextCommand(command: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('Cannot send text command - not connected');
      return;
    }
    
    this.socket.send(command);
    console.log(`📤 Sent text command: ${command}`);
  }
  
  /**
   * Connect to the game server
   */
  async connect(playerName: string): Promise<void> {
    if (this.connectionState !== ConnectionState.DISCONNECTED) {
      throw new Error('Already connected or connecting');
    }
    
    this.setConnectionState(ConnectionState.CONNECTING);
    
    try {
      // For browsers, we use WebSocket with a UDP bridge on the server
      const wsUrl = this.config.serverUrl.replace('udp://', 'ws://');
      console.log(`🔌 Attempting to connect to: ${wsUrl}/game`);
      this.socket = new WebSocket(`${wsUrl}/game`);
      this.socket.binaryType = 'arraybuffer';
      
      this.setupSocketHandlers();
      
      // Wait for connection
      await this.waitForConnection();
      
      // Send handshake
      await this.sendHandshake(playerName);
      
    } catch (error) {
      this.setConnectionState(ConnectionState.ERROR);
      console.error('🚫 Connection failed:', error);
      throw new Error(`Failed to connect to server at ${this.config.serverUrl}: ${error}`);
    }
  }
  
  /**
   * Send player input to server
   */
  sendInput(inputFrame: InputFrame): void {
    if (this.connectionState !== ConnectionState.CONNECTED) {
      return;
    }
    
    const packet: ClientInputPacket = {
      type: PacketType.CLIENT_INPUT,
      version: PROTOCOL_VERSION,
      sequence: this.localSequence++,
      deltaTime: 16, // Fixed 16ms for 60fps client
      thrust: this.floatToQ15(inputFrame.movement.y), // Forward/backward
      turn: this.floatToQ15(inputFrame.movement.x),   // Left/right turning
      actions: inputFrame.actions, // Already a bitmask
      clientTime: performance.now(),
      checksum: 0
    };
    
    // Calculate checksum after serialization
    const buffer = this.serializePacket(packet);
    const checksumValue = this.calculateChecksum(buffer, buffer.byteLength - 2); // Exclude checksum field
    const view = new DataView(buffer);
    view.setUint16(buffer.byteLength - 2, checksumValue, true); // Update checksum
    
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buffer);
      this.stats.bytesSent += buffer.byteLength;
      this.stats.packetsSent++;
      this.stats.messagesSent++;
    }
  }
  
  /**
   * Set world state update handler
   */
  setWorldStateHandler(handler: (worldState: WorldState) => void): void {
    this.onWorldStateUpdate = handler;
  }
  
  /**
   * Set connection state change handler
   */
  setConnectionStateHandler(handler: (state: ConnectionState) => void): void {
    this.onConnectionStateChange = handler;
  }
  
  /**
   * Set text message handler for text protocol responses
   */
  setTextMessageHandler(handler: (message: string) => void): void {
    this.onTextMessage = handler;
  }
  
  /**
   * Get current network statistics
   */
  getStats(): NetworkStats {
    this.stats.connectionState = this.connectionState;
    return { ...this.stats };
  }
  
  /**
   * Disconnect from server
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setConnectionState(ConnectionState.DISCONNECTED);
  }
  
  // Private methods
  
  private setupSocketHandlers(): void {
    if (!this.socket) return;
    
    this.socket.onopen = (_event) => {
      console.log('🔗 WebSocket connected to server');
    };
    
    this.socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary protocol message
        this.handleBinaryMessage(event.data);
        this.stats.bytesReceived += event.data.byteLength;
        this.stats.packetsReceived++;
        this.stats.messagesReceived++; // Compatibility alias
      } else if (typeof event.data === 'string') {
        // Text protocol message
        console.log(`📥 Received text message: ${event.data}`);
        this.handleTextMessage(event.data);
        this.stats.bytesReceived += event.data.length;
        this.stats.packetsReceived++;
        this.stats.messagesReceived++;
      }
    };
    
    this.socket.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      this.setConnectionState(ConnectionState.ERROR);
    };
    
    this.socket.onclose = (event) => {
      console.log('🔌 WebSocket disconnected:', event.code, event.reason);
      this.setConnectionState(ConnectionState.DISCONNECTED);
    };
  }
  
  private async waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('No socket'));
        return;
      }
      
      if (this.socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after 10 seconds. Is the server running at ${this.config.serverUrl}?`));
      }, 10000);
      
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket connection failed. Server may not be running or accessible at ${this.config.serverUrl}`));
      }, { once: true });
    });
  }
  
  private async sendHandshake(playerName: string): Promise<void> {
    const packet: ClientHandshakePacket = {
      type: PacketType.CLIENT_HANDSHAKE,
      version: PROTOCOL_VERSION,
      clientId: this.clientId,
      playerName: playerName.substring(0, 15), // Truncate to fit packet
      checksum: 0
    };
    
    // Calculate checksum after serialization
    const buffer = this.serializePacket(packet);
    const checksumValue = this.calculateChecksum(buffer, buffer.byteLength - 2); // Exclude checksum field
    const view = new DataView(buffer);
    view.setUint16(buffer.byteLength - 2, checksumValue, true); // Update checksum
    
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buffer);
      this.stats.bytesSent += buffer.byteLength;
      this.stats.packetsSent++;
      this.stats.messagesSent++;
    }
    
    // Wait for server handshake response
    await this.waitForHandshakeResponse();
  }
  
  private async waitForHandshakeResponse(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Handshake timeout'));
      }, 5000);
      
      const originalHandler = this.onConnectionStateChange;
      this.onConnectionStateChange = (state) => {
        if (state === ConnectionState.CONNECTED) {
          clearTimeout(timeout);
          this.onConnectionStateChange = originalHandler;
          resolve();
        } else if (state === ConnectionState.ERROR) {
          clearTimeout(timeout);
          this.onConnectionStateChange = originalHandler;
          reject(new Error('Handshake failed'));
        }
      };
    });
  }
  
  private handleBinaryMessage(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    
    switch (type) {
      case PacketType.SERVER_HANDSHAKE:
        this.handleServerHandshake(view);
        break;
      case PacketType.SERVER_SNAPSHOT:
        this.handleServerSnapshot(view);
        break;
      case PacketType.HEARTBEAT:
        this.handleHeartbeat(view);
        break;
      default:
        console.warn('Unknown binary packet type:', type);
    }
  }
  
  private handleTextMessage(message: string): void {
    // Handle text protocol responses (PONG, WELCOME, GAME_STATE, ECHO)
    console.log(`📝 Processing text message: ${message}`);
    
    // Try to parse as JSON first
    try {
      const json = JSON.parse(message);
      if (json.type === 'WELCOME') {
        // Handle JOIN response
        console.log(`🎮 Welcome message received for player ${json.player_id}`);
        this.playerId = json.player_id;
        if (this.connectionState === ConnectionState.CONNECTING) {
          this.setConnectionState(ConnectionState.CONNECTED);
        }
      } else if (json.type === 'GAME_STATE') {
        // Handle STATE response - convert to WorldState if needed
        console.log(`🗺️ Game state received: tick ${json.tick}`);
        // Could convert this to a WorldState and call onWorldStateUpdate if needed
      }
    } catch (error) {
      // Not JSON, handle simple text responses
      if (message === 'PONG') {
        console.log('🏓 PONG received');
      } else {
        console.log(`📨 Text response: ${message}`);
      }
    }
    
    // Forward to text message handler if set
    if (this.onTextMessage) {
      this.onTextMessage(message);
    }
  }
  
  private handleServerHandshake(view: DataView): void {
    // Validate packet checksum first
    const packetSize = 10; // ServerHandshake size: type(1) + version(1) + playerId(2) + serverTime(4) + checksum(2)
    const receivedChecksum = view.getUint16(8, true);
    const buffer = new ArrayBuffer(packetSize);
    const tempView = new DataView(buffer);
    for (let i = 0; i < packetSize; i++) {
      tempView.setUint8(i, view.getUint8(i));
    }
    const calculatedChecksum = this.calculateChecksum(buffer, packetSize - 2);
    
    if (receivedChecksum !== calculatedChecksum) {
      console.warn('🚨 Server handshake checksum mismatch');
      // Continue anyway for now, but log the issue
    }
    
    const packet: ServerHandshakePacket = {
      type: view.getUint8(0),
      version: view.getUint8(1),
      playerId: view.getUint16(2, true), // little-endian
      serverTime: view.getUint32(4, true),
      checksum: receivedChecksum
    };
    
    if (packet.version !== PROTOCOL_VERSION) {
      console.error('🚨 Protocol version mismatch: expected', PROTOCOL_VERSION, 'got', packet.version);
      this.setConnectionState(ConnectionState.ERROR);
      return;
    }
    
    this.playerId = packet.playerId;
    this.serverTimeOffset = packet.serverTime - performance.now();
    
    console.log(`🏴‍☠️ Connected as player ${this.playerId}, server time offset: ${this.serverTimeOffset}ms`);
    this.setConnectionState(ConnectionState.CONNECTED);
  }
  
  private handleServerSnapshot(view: DataView): void {
    // Parse snapshot header
    let offset = 0;
    const header = {
      type: view.getUint8(offset++),
      version: view.getUint8(offset++),
      serverTime: view.getUint32(offset, true),
      baseId: 0,
      snapId: 0,
      aoiCell: 0,
      entityCount: 0,
      flags: 0,
      checksum: 0
    };
    offset += 4;
    header.baseId = view.getUint16(offset, true);
    offset += 2;
    header.snapId = view.getUint16(offset, true);
    offset += 2;
    header.aoiCell = view.getUint16(offset, true);
    offset += 2;
    header.entityCount = view.getUint8(offset++);
    header.flags = view.getUint8(offset++);
    header.checksum = view.getUint16(offset, true);
    offset += 2;
    
    // Parse entities
    const entities: EntityUpdate[] = [];
    for (let i = 0; i < header.entityCount; i++) {
      const entity: EntityUpdate = {
        entityId: view.getUint16(offset, true),
        posX: 0,
        posY: 0,
        velX: 0,
        velY: 0,
        rotation: 0,
        stateFlags: 0,
        reserved: 0
      };
      offset += 2;
      entity.posX = view.getUint16(offset, true);
      offset += 2;
      entity.posY = view.getUint16(offset, true);
      offset += 2;
      entity.velX = view.getUint16(offset, true);
      offset += 2;
      entity.velY = view.getUint16(offset, true);
      offset += 2;
      entity.rotation = view.getUint16(offset, true);
      offset += 2;
      entity.stateFlags = view.getUint8(offset++);
      entity.reserved = view.getUint8(offset++); // Read reserved byte
      entities.push(entity);
    }
    
    // Convert to WorldState and notify handlers
    const worldState = this.snapshotToWorldState(header, entities);
    if (this.onWorldStateUpdate) {
      this.onWorldStateUpdate(worldState);
    }
    
    // Update FPS tracking
    const now = performance.now();
    if (this.lastSnapshotTime > 0) {
      const deltaTime = now - this.lastSnapshotTime;
      const instantFPS = 1000 / deltaTime; // Convert ms to fps
      // Simple moving average
      this.stats.averageFPS = (this.stats.averageFPS * 0.9) + (instantFPS * 0.1);
    }
    this.lastSnapshotTime = now;
    this.snapshotCount++;
  }
  
  private handleHeartbeat(view: DataView): void {
    // Calculate ping from heartbeat response
    const serverTime = view.getUint32(4, true);
    const currentTime = performance.now();
    this.stats.ping = currentTime - this.lastPingTime;
    
    // Send heartbeat back for keepalive
    this.sendHeartbeat();
  }
  
  private serializePacket(packet: any): ArrayBuffer {
    // Serialize packets to match exact C struct layout from server
    let buffer: ArrayBuffer;
    let view: DataView;
    let offset = 0;
    
    switch (packet.type) {
      case PacketType.CLIENT_HANDSHAKE:
        // struct ClientHandshake: type(1) + version(1) + client_id(4) + player_name(16) + checksum(2) = 24 bytes
        buffer = new ArrayBuffer(24);
        view = new DataView(buffer);
        view.setUint8(offset++, packet.type);
        view.setUint8(offset++, packet.version || PROTOCOL_VERSION);
        view.setUint32(offset, packet.clientId, true); offset += 4;
        // Pack player name (16 bytes, null-terminated)
        const nameBytes = new TextEncoder().encode(packet.playerName);
        const nameView = new Uint8Array(buffer, offset, 16);
        nameView.fill(0); // Clear to null bytes
        nameView.set(nameBytes.slice(0, 15)); // Leave room for null terminator
        offset += 16;
        view.setUint16(offset, packet.checksum || 0, true); // checksum
        break;
        
      case PacketType.CLIENT_INPUT:
        // struct CmdPacket: type(1) + version(1) + seq(2) + dt_ms(2) + thrust(2) + turn(2) + actions(2) + client_time(4) + checksum(2) = 18 bytes
        buffer = new ArrayBuffer(18);
        view = new DataView(buffer);
        view.setUint8(offset++, packet.type);
        view.setUint8(offset++, packet.version || PROTOCOL_VERSION);
        view.setUint16(offset, packet.sequence, true); offset += 2;
        view.setUint16(offset, packet.deltaTime, true); offset += 2;
        view.setInt16(offset, packet.thrust, true); offset += 2;
        view.setInt16(offset, packet.turn, true); offset += 2;
        view.setUint16(offset, packet.actions, true); offset += 2;
        view.setUint32(offset, packet.clientTime, true); offset += 4;
        view.setUint16(offset, packet.checksum || 0, true); // checksum
        break;
        
      case PacketType.HEARTBEAT:
        // Minimal heartbeat packet: type(1) + version(1) + client_time(4) = 6 bytes
        buffer = new ArrayBuffer(6);
        view = new DataView(buffer);
        view.setUint8(offset++, packet.type);
        view.setUint8(offset++, packet.version || PROTOCOL_VERSION);
        view.setUint32(offset, packet.clientTime, true);
        break;
        
      default:
        throw new Error(`Unknown packet type: ${packet.type}`);
    }
    
    return buffer;
  }
  
  private snapshotToWorldState(header: any, entities: EntityUpdate[]): WorldState {
    // Convert binary entity updates back to game world state
    const ships: Ship[] = [];
    const cannonballs: Cannonball[] = [];
    const players: Player[] = [];
    
    for (const entity of entities) {
      // Unquantize positions and rotations
      const pos = new Vec2(
        this.unquantizePosition(entity.posX),
        this.unquantizePosition(entity.posY)
      );
      const vel = new Vec2(
        this.unquantizeVelocity(entity.velX),
        this.unquantizeVelocity(entity.velY)
      );
      const rotation = this.unquantizeRotation(entity.rotation);
      
      // Create appropriate game entity based on ID or flags
      // This is simplified - real implementation would have proper entity types
      if (entity.entityId < 1000) {
        // Ship entities
        ships.push({
          id: entity.entityId,
          position: pos,
          velocity: vel,
          rotation: rotation,
          angularVelocity: 0, // Not transmitted in this simplified version
          hull: [], // Will be filled from ship data
          modules: [],
          // Brigantine physics properties (UDP protocol doesn't send these, use defaults)
          mass: BRIGANTINE_PHYSICS.mass,
          momentOfInertia: BRIGANTINE_PHYSICS.momentOfInertia,
          maxSpeed: BRIGANTINE_PHYSICS.maxSpeed,
          turnRate: BRIGANTINE_PHYSICS.turnRate,
          waterDrag: BRIGANTINE_PHYSICS.waterDrag,
          angularDrag: BRIGANTINE_PHYSICS.angularDrag,
          rudderAngle: 0
        });
      } else {
        // Projectile entities  
        cannonballs.push({
          id: entity.entityId,
          position: pos,
          velocity: vel,
          firingVelocity: vel.clone(), // Assume same as current velocity
          radius: 0.1,
          maxRange: 100,
          distanceTraveled: 0,
          timeAlive: 0,
          firedFrom: 0, // Unknown for now
          smokeTrail: []
        });
      }
    }
    
    return {
      tick: header.snapId,
      ships,
      cannonballs,
      players,
      timestamp: header.serverTime,
      carrierDetection: new Map()
    };
  }
  
  private sendHeartbeat(): void {
    const packet = {
      type: PacketType.HEARTBEAT,
      version: PROTOCOL_VERSION,
      clientTime: performance.now()
    };
    
    const buffer = this.serializePacket(packet);
    
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buffer);
      this.stats.bytesSent += buffer.byteLength;
      this.stats.packetsSent++;
      this.stats.messagesSent++;
    }
    
    this.lastPingTime = performance.now();
  }
  
  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    }
  }
  
  // Quantization helpers - must match server protocol.h exactly
  
  private floatToQ15(value: number): number {
    // Convert float [-1.0, 1.0] to Q0.15 fixed-point
    return Math.round(Math.max(-1.0, Math.min(1.0, value)) * 32767);
  }
  
  private q15ToFloat(value: number): number {
    // Convert Q0.15 fixed-point to float
    return value / 32767.0;
  }
  
  private quantizePosition(pos: number): number {
    // Matches server: pos * 512.0f + 32768.0f (bias for signed range)
    return Math.round(pos * 512.0 + 32768.0) & 0xFFFF;
  }
  
  private unquantizePosition(pos: number): number {
    // Matches server: (pos - 32768) / 512.0f
    return (pos - 32768) / 512.0;
  }
  
  private quantizeVelocity(vel: number): number {
    // Matches server: vel * 256.0f + 32768.0f
    return Math.round(vel * 256.0 + 32768.0) & 0xFFFF;
  }
  
  private unquantizeVelocity(vel: number): number {
    // Matches server: (vel - 32768) / 256.0f
    return (vel - 32768) / 256.0;
  }
  
  private quantizeRotation(angle: number): number {
    // Matches server: normalize to [0, 2π) then quantize
    while (angle < 0) angle += 2 * Math.PI;
    while (angle >= 2 * Math.PI) angle -= 2 * Math.PI;
    return Math.round(angle * 1024.0 / (2 * Math.PI)) & 0xFFFF;
  }
  
  private unquantizeRotation(rot: number): number {
    // Matches server: rot * 2π / 1024.0f
    return rot * (2 * Math.PI) / 1024.0;
  }
  
  private calculateChecksum(buffer: ArrayBuffer, length: number): number {
    // Simple checksum algorithm matching server implementation
    const bytes = new Uint8Array(buffer, 0, length);
    let sum = 0;
    
    for (let i = 0; i < length; i++) {
      sum += bytes[i];
      sum = (sum & 0xFFFF) + (sum >> 16); // Fold carry bits
    }
    
    return (~sum) & 0xFFFF; // One's complement
  }
}