/**
 * UDP Network Manager - Binary Protocol Client
 * 
 * Handles communication with the C-based physics server using the binary UDP protocol.
 * Since browsers don't support raw UDP, this uses WebRTC DataChannels or WebSocket
 * with a UDP bridge on the server side.
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame, Ship, Player, Cannonball } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';

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

// Client input packet
interface ClientInputPacket {
  type: PacketType.CLIENT_INPUT;
  version: number;
  sequence: number;
  deltaTime: number;
  thrust: number;    // Q0.15 fixed-point [-1.0, 1.0]
  turn: number;      // Q0.15 fixed-point [-1.0, 1.0] 
  actions: number;   // Bitfield
  clientTime: number;
  checksum: number;
}

// Server snapshot header
interface ServerSnapshotPacket {
  type: PacketType.SERVER_SNAPSHOT;
  version: number;
  serverTime: number;
  baseId: number;
  snapId: number;
  aoiCell: number;
  entityCount: number;
  flags: number;
  checksum: number;
  entities: EntityUpdate[];
}

// Entity update structure
interface EntityUpdate {
  entityId: number;
  posX: number;     // Quantized position
  posY: number;
  velX: number;     // Quantized velocity
  velY: number;
  rotation: number; // Quantized rotation
  stateFlags: number;
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
    connectionState: ConnectionState.DISCONNECTED
  };
  
  // Timing
  private lastPingTime: number = 0;
  private serverTimeOffset: number = 0;
  
  // Event handlers
  private onWorldStateUpdate: ((worldState: WorldState) => void) | null = null;
  private onConnectionStateChange: ((state: ConnectionState) => void) | null = null;
  
  constructor(config: NetworkConfig) {
    this.config = config;
    this.clientId = Math.floor(Math.random() * 0xFFFFFFFF);
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
      this.socket = new WebSocket(`${wsUrl}/game`);
      this.socket.binaryType = 'arraybuffer';
      
      this.setupSocketHandlers();
      
      // Wait for connection
      await this.waitForConnection();
      
      // Send handshake
      await this.sendHandshake(playerName);
      
    } catch (error) {
      this.setConnectionState(ConnectionState.ERROR);
      throw error;
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
    
    this.sendBinaryPacket(packet);
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
        this.handleBinaryMessage(event.data);
        this.stats.bytesReceived += event.data.byteLength;
        this.stats.packetsReceived++;
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
        reject(new Error('Connection timeout'));
      }, 10000);
      
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Connection failed'));
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
    
    this.sendBinaryPacket(packet);
    
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
        console.warn('Unknown packet type:', type);
    }
  }
  
  private handleServerHandshake(view: DataView): void {
    const packet: ServerHandshakePacket = {
      type: view.getUint8(0),
      version: view.getUint8(1),
      playerId: view.getUint16(2, true), // little-endian
      serverTime: view.getUint32(4, true),
      checksum: view.getUint16(8, true)
    };
    
    if (packet.version !== PROTOCOL_VERSION) {
      console.error('Protocol version mismatch');
      this.setConnectionState(ConnectionState.ERROR);
      return;
    }
    
    this.playerId = packet.playerId;
    this.serverTimeOffset = packet.serverTime - performance.now();
    
    console.log(`🏴‍☠️ Connected as player ${this.playerId}`);
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
        stateFlags: 0
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
      offset++; // Skip reserved byte
      entities.push(entity);
    }
    
    // Convert to WorldState and notify handlers
    const worldState = this.snapshotToWorldState(header, entities);
    if (this.onWorldStateUpdate) {
      this.onWorldStateUpdate(worldState);
    }
  }
  
  private handleHeartbeat(view: DataView): void {
    // Calculate ping from heartbeat response
    const serverTime = view.getUint32(4, true);
    const currentTime = performance.now();
    this.stats.ping = currentTime - this.lastPingTime;
    
    // Send heartbeat back for keepalive
    this.sendHeartbeat();
  }
  
  private sendBinaryPacket(packet: any): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    
    const buffer = this.serializePacket(packet);
    this.socket.send(buffer);
    this.stats.bytesSent += buffer.byteLength;
    this.stats.packetsSent++;
  }
  
  private serializePacket(packet: any): ArrayBuffer {
    // This is a simplified serialization - in practice you'd want
    // proper binary packing to match the C struct layout exactly
    const buffer = new ArrayBuffer(256); // Max packet size
    const view = new DataView(buffer);
    let offset = 0;
    
    view.setUint8(offset++, packet.type);
    view.setUint8(offset++, packet.version || PROTOCOL_VERSION);
    
    // Pack remaining fields based on packet type
    switch (packet.type) {
      case PacketType.CLIENT_HANDSHAKE:
        view.setUint32(offset, packet.clientId, true); offset += 4;
        // Pack player name (16 bytes)
        const nameBytes = new TextEncoder().encode(packet.playerName);
        const nameView = new Uint8Array(buffer, offset, 16);
        nameView.set(nameBytes.slice(0, 15));
        offset += 16;
        break;
        
      case PacketType.CLIENT_INPUT:
        view.setUint16(offset, packet.sequence, true); offset += 2;
        view.setUint16(offset, packet.deltaTime, true); offset += 2;
        view.setInt16(offset, packet.thrust, true); offset += 2;
        view.setInt16(offset, packet.turn, true); offset += 2;
        view.setUint16(offset, packet.actions, true); offset += 2;
        view.setUint32(offset, packet.clientTime, true); offset += 4;
        break;
    }
    
    // Add checksum
    view.setUint16(offset, 0, true); // Placeholder checksum
    
    return buffer.slice(0, offset + 2);
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
          modules: []
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
    this.sendBinaryPacket(packet);
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
  
  // Utility methods for fixed-point conversion
  
  private floatToQ15(value: number): number {
    // Convert float [-1.0, 1.0] to Q0.15 fixed-point
    return Math.round(Math.max(-1.0, Math.min(1.0, value)) * 32767);
  }
  
  private q15ToFloat(value: number): number {
    // Convert Q0.15 fixed-point to float
    return value / 32767.0;
  }
  
  private unquantizePosition(pos: number): number {
    return (pos - 32768) / 512.0;
  }
  
  private unquantizeVelocity(vel: number): number {
    return (vel - 32768) / 256.0;
  }
  
  private unquantizeRotation(rot: number): number {
    return rot * (2 * Math.PI) / 1024.0;
  }
}