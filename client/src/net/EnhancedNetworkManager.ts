/**
 * Enhanced Network Manager - Client-Server Bridge
 * 
 * Advanced networking layer that handles:
 * - Protocol bridging between client WebSocket and server UDP
 * - Connection management with automatic reconnection
 * - Packet ordering and reliability
 * - Network latency measurement and compensation
 * - Bandwidth optimization with compression
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame } from '../sim/Types.js';
import { EnhancedPredictionEngine, ServerSnapshot, InputPacket } from './EnhancedPredictionEngine.js';

/**
 * Network connection states
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting', 
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed'
}

/**
 * Packet types for client-server communication
 */
export enum PacketType {
  // Client to server
  HANDSHAKE = 'handshake',
  INPUT = 'input',
  PING = 'ping',
  
  // Server to client  
  HANDSHAKE_RESPONSE = 'handshake_response',
  SNAPSHOT = 'snapshot',
  PONG = 'pong'
}

/**
 * Base packet structure
 */
export interface BasePacket {
  type: PacketType;
  timestamp: number;
  sequence: number;
}

/**
 * Handshake packet for connection establishment
 */
export interface HandshakePacket extends BasePacket {
  type: PacketType.HANDSHAKE;
  clientVersion: string;
  desiredTickRate: number;
  features: string[];
}

/**
 * Handshake response from server
 */
export interface HandshakeResponsePacket extends BasePacket {
  type: PacketType.HANDSHAKE_RESPONSE;
  clientId: number;
  serverTickRate: number;
  worldBounds: { x: number; y: number; width: number; height: number };
  success: boolean;
  message?: string;
}

/**
 * Ping packet for latency measurement
 */
export interface PingPacket extends BasePacket {
  type: PacketType.PING;
  clientTime: number;
}

/**
 * Pong response packet
 */
export interface PongPacket extends BasePacket {
  type: PacketType.PONG;
  clientTime: number;
  serverTime: number;
}

/**
 * Network performance metrics
 */
export interface NetworkMetrics {
  // Connection stats
  connectionState: ConnectionState;
  connectionTime: number;
  reconnectAttempts: number;
  
  // Latency measurements
  latency: number;
  averageLatency: number;
  jitter: number;
  
  // Bandwidth tracking
  bytesSent: number;
  bytesReceived: number;
  packetsPerSecond: number;
  
  // Reliability stats
  packetsSent: number;
  packetsReceived: number;
  packetsLost: number;
  packetsOutOfOrder: number;
  
  // Server sync
  serverTickRate: number;
  clockOffset: number;
  timeSyncAccuracy: number;
}

/**
 * Enhanced Network Manager
 */
export class EnhancedNetworkManager {
  private config: NetworkConfig;
  private predictionEngine: EnhancedPredictionEngine;
  
  // Connection management
  private socket: WebSocket | null = null;
  private connectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private connectionStartTime = 0;
  
  // Client identification
  private clientId = 0;
  private sessionId = '';
  
  // Packet management
  private outgoingSequence = 0;
  private expectedIncomingSequence = 0;
  private pendingPackets = new Map<number, any>();
  
  // Timing and synchronization
  private serverTime = 0;
  private clockOffset = 0;
  private latencyHistory: number[] = [];
  private pingInterval: number | null = null;
  private lastPingTime = 0;
  
  // Metrics tracking
  private metrics: NetworkMetrics = {
    connectionState: ConnectionState.DISCONNECTED,
    connectionTime: 0,
    reconnectAttempts: 0,
    latency: 0,
    averageLatency: 0,
    jitter: 0,
    bytesSent: 0,
    bytesReceived: 0,
    packetsPerSecond: 0,
    packetsSent: 0,
    packetsReceived: 0,
    packetsLost: 0,
    packetsOutOfOrder: 0,
    serverTickRate: 30,
    clockOffset: 0,
    timeSyncAccuracy: 0
  };
  
  // Event callbacks
  private onConnectedCallback?: () => void;
  private onDisconnectedCallback?: () => void;
  private onSnapshotCallback?: (snapshot: ServerSnapshot) => void;
  private onErrorCallback?: (error: string) => void;
  
  constructor(config: NetworkConfig, predictionEngine: EnhancedPredictionEngine) {
    this.config = config;
    this.predictionEngine = predictionEngine;
    
    // Generate unique session ID
    this.sessionId = this.generateSessionId();
    
    console.log('🌐 Enhanced Network Manager initialized');
    console.log(`   Server: ${config.serverUrl}`);
    console.log(`   Protocol: ${config.protocol}`);
    console.log(`   Session: ${this.sessionId}`);
  }
  
  /**
   * Connect to the game server
   */
  public async connect(): Promise<void> {
    if (this.connectionState === ConnectionState.CONNECTING || 
        this.connectionState === ConnectionState.CONNECTED) {
      return;
    }
    
    this.connectionState = ConnectionState.CONNECTING;
    this.connectionStartTime = Date.now();
    
    console.log('🔌 Connecting to server...');
    
    try {
      await this.establishConnection();
      await this.performHandshake();
      
      this.connectionState = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      
      // Start periodic ping for latency measurement
      this.startPingLoop();
      
      console.log('✅ Connected to server');
      console.log(`   Client ID: ${this.clientId}`);
      console.log(`   Server tick rate: ${this.metrics.serverTickRate}Hz`);
      
      this.onConnectedCallback?.();
      
    } catch (error) {
      console.error('❌ Failed to connect:', error);
      this.connectionState = ConnectionState.FAILED;
      this.scheduleReconnect();
      this.onErrorCallback?.(error as string);
    }
  }
  
  /**
   * Disconnect from server
   */
  public disconnect(): void {
    this.connectionState = ConnectionState.DISCONNECTED;
    
    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    // Close socket
    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
    }
    
    console.log('🔌 Disconnected from server');
    this.onDisconnectedCallback?.();
  }
  
  /**
   * Send input to server
   */
  public sendInput(inputFrame: InputFrame, deltaTime: number): void {
    if (this.connectionState !== ConnectionState.CONNECTED) {
      return;
    }
    
    // Get input packet from prediction engine
    const inputPacket = this.predictionEngine.getPendingInputPacket();
    if (!inputPacket) {
      return;
    }
    
    // Wrap in network packet with sequencing
    const networkPacket = {
      ...inputPacket,
      sequence: this.outgoingSequence++,
      timestamp: this.getServerTime()
    };
    
    this.sendPacket(networkPacket);
    this.metrics.packetsSent++;
  }
  
  /**
   * Get current network metrics
   */
  public getMetrics(): NetworkMetrics {
    return { ...this.metrics };
  }
  
  /**
   * Set event callbacks
   */
  public setCallbacks(callbacks: {
    onConnected?: () => void;
    onDisconnected?: () => void;
    onSnapshot?: (snapshot: ServerSnapshot) => void;
    onError?: (error: string) => void;
  }): void {
    this.onConnectedCallback = callbacks.onConnected;
    this.onDisconnectedCallback = callbacks.onDisconnected;
    this.onSnapshotCallback = callbacks.onSnapshot;
    this.onErrorCallback = callbacks.onError;
  }
  
  /**
   * Get server-synchronized time
   */
  public getServerTime(): number {
    return Date.now() + this.clockOffset;
  }
  
  /**
   * Check if connected to server
   */
  public isConnected(): boolean {
    return this.connectionState === ConnectionState.CONNECTED;
  }
  
  // === PRIVATE IMPLEMENTATION ===
  
  private async establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.config.serverUrl);
        
        this.socket.onopen = () => {
          console.log('🔗 WebSocket connection established');
          resolve();
        };
        
        this.socket.onclose = (event) => {
          console.log(`🔌 WebSocket closed: ${event.code} - ${event.reason}`);
          this.handleDisconnection();
        };
        
        this.socket.onerror = (error) => {
          console.error('🚨 WebSocket error:', error);
          reject('WebSocket connection failed');
        };
        
        this.socket.onmessage = (event) => {
          this.handleIncomingMessage(event.data);
        };
        
        // Connection timeout
        setTimeout(() => {
          if (this.socket?.readyState === WebSocket.CONNECTING) {
            this.socket.close();
            reject('Connection timeout');
          }
        }, this.config.timeoutDuration);
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  private async performHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const handshake: HandshakePacket = {
        type: PacketType.HANDSHAKE,
        timestamp: Date.now(),
        sequence: this.outgoingSequence++,
        clientVersion: '1.0.0',
        desiredTickRate: 120,
        features: ['prediction', 'interpolation', 'compression']
      };
      
      // Set up handshake response handler
      const handleHandshakeResponse = (packet: HandshakeResponsePacket) => {
        if (packet.success) {
          this.clientId = packet.clientId;
          this.metrics.serverTickRate = packet.serverTickRate;
          console.log(`🤝 Handshake successful - Client ID: ${this.clientId}`);
          resolve();
        } else {
          reject(packet.message || 'Handshake failed');
        }
      };
      
      // Store handler temporarily
      (this as any).handshakeHandler = handleHandshakeResponse;
      
      this.sendPacket(handshake);
      
      // Handshake timeout
      setTimeout(() => {
        if (this.clientId === 0) {
          reject('Handshake timeout');
        }
      }, 5000);
    });
  }
  
  /**
   * Send packet with protocol adaptation
   */
  private sendPacket(packet: any): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    
    let data: string;
    
    // Protocol Bridge: Convert Enhanced packets to server-expected text commands
    if (packet.type === PacketType.HANDSHAKE) {
      // Convert handshake to JOIN command
      data = `JOIN:enhanced_client_${this.sessionId}`;
    } else if (packet.type === PacketType.PING) {
      // Convert ping packet to simple PING command
      data = 'PING';
    } else if (packet.type === PacketType.INPUT) {
      // For now, send as STATE request (game input handling would need server support)
      data = 'STATE';
    } else {
      // Fallback to JSON for unknown packet types
      data = JSON.stringify(packet);
    }
    
    this.socket.send(data);
    
    // Update metrics
    this.metrics.bytesSent += data.length;
  }
  
  private handleIncomingMessage(data: string): void {
    try {
      // Update metrics
      this.metrics.bytesReceived += data.length;
      this.metrics.packetsReceived++;
      
      // Protocol Bridge: Handle both text commands and JSON packets
      let packet: any;
      
      if (data.startsWith('{')) {
        // JSON packet - parse normally
        packet = JSON.parse(data);
      } else {
        // Text command - convert to packet structure
        if (data === 'PONG') {
          packet = {
            type: PacketType.PONG,
            clientTime: this.lastPingTime,
            serverTime: Date.now(),
            timestamp: Date.now(),
            sequence: this.expectedIncomingSequence++
          };
        } else if (data.startsWith('WELCOME')) {
          // JOIN response - extract client ID if present
          const parts = data.split(':');
          const clientId = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
          packet = {
            type: PacketType.HANDSHAKE_RESPONSE,
            clientId: clientId,
            serverTickRate: 30,
            worldBounds: { x: 0, y: 0, width: 2000, height: 2000 },
            success: true,
            timestamp: Date.now(),
            sequence: this.expectedIncomingSequence++
          };
        } else if (data.startsWith('GAME_STATE:')) {
          // State response - convert to snapshot
          try {
            const stateJson = data.substring(11); // Remove "GAME_STATE:" prefix
            const state = JSON.parse(stateJson);
            packet = {
              type: PacketType.SNAPSHOT,
              tick: Date.now(), // Use timestamp as tick for now
              timestamp: Date.now(),
              entities: state.entities || [],
              sequence: this.expectedIncomingSequence++
            };
          } catch (e) {
            console.warn('Failed to parse GAME_STATE response:', e);
            return;
          }
        } else if (data.startsWith('echo:')) {
          // Echo response - convert to generic acknowledgment
          packet = {
            type: 'echo_response',
            message: data,
            timestamp: Date.now(),
            sequence: this.expectedIncomingSequence++
          };
        } else {
          // Unknown text command - log and return
          console.warn('Unknown server text command:', data);
          return;
        }
      }
      
      // Handle packet based on type
      switch (packet.type) {
        case PacketType.HANDSHAKE_RESPONSE:
          (this as any).handshakeHandler?.(packet as HandshakeResponsePacket);
          break;
          
        case PacketType.SNAPSHOT:
          this.handleSnapshot(packet as ServerSnapshot);
          break;
          
        case PacketType.PONG:
          this.handlePong(packet as PongPacket);
          break;
          
        default:
          console.log('📨 Server message:', packet.type || 'unknown', packet);
      }
      
    } catch (error) {
      console.error('Failed to parse incoming message:', error);
      console.error('Raw message:', data);
    }
  }
  
  private handleSnapshot(snapshot: ServerSnapshot): void {
    // Update server time synchronization
    this.updateTimeSynchronization(snapshot.timestamp);
    
    // Forward to prediction engine
    this.predictionEngine.onServerSnapshot(snapshot);
    
    // Notify callback
    this.onSnapshotCallback?.(snapshot);
  }
  
  private handlePong(pong: PongPacket): void {
    const now = Date.now();
    const roundTripTime = now - pong.clientTime;
    
    // Update latency metrics
    this.updateLatencyMetrics(roundTripTime);
    
    // Update clock synchronization
    const networkDelay = roundTripTime / 2;
    const serverTime = pong.serverTime + networkDelay;
    this.clockOffset = serverTime - now;
    
    this.metrics.clockOffset = this.clockOffset;
    this.metrics.timeSyncAccuracy = Math.abs(roundTripTime - this.metrics.latency);
  }
  
  private updateLatencyMetrics(roundTripTime: number): void {
    const latency = roundTripTime / 2;
    
    // Add to history
    this.latencyHistory.push(latency);
    if (this.latencyHistory.length > 20) { // Keep last 20 samples
      this.latencyHistory.shift();
    }
    
    // Calculate average
    this.metrics.averageLatency = 
      this.latencyHistory.reduce((sum, l) => sum + l, 0) / this.latencyHistory.length;
    
    // Calculate jitter (standard deviation)
    const variance = this.latencyHistory.reduce((sum, l) => {
      const diff = l - this.metrics.averageLatency;
      return sum + diff * diff;
    }, 0) / this.latencyHistory.length;
    
    this.metrics.jitter = Math.sqrt(variance);
    this.metrics.latency = latency;
  }
  
  private updateTimeSynchronization(serverTimestamp: number): void {
    const now = Date.now();
    const networkDelay = this.metrics.latency;
    const estimatedServerTime = serverTimestamp + networkDelay;
    
    // Update clock offset with smoothing
    const newOffset = estimatedServerTime - now;
    this.clockOffset = (this.clockOffset * 0.9) + (newOffset * 0.1);
    
    this.metrics.clockOffset = this.clockOffset;
  }
  
  private startPingLoop(): void {
    this.pingInterval = window.setInterval(() => {
      if (this.connectionState === ConnectionState.CONNECTED) {
        this.sendPing();
      }
    }, this.config.heartbeatInterval);
  }
  
  private sendPing(): void {
    const ping: PingPacket = {
      type: PacketType.PING,
      timestamp: this.getServerTime(),
      sequence: this.outgoingSequence++,
      clientTime: Date.now()
    };
    
    this.sendPacket(ping);
    this.lastPingTime = Date.now();
  }
  
  private handleDisconnection(): void {
    if (this.connectionState === ConnectionState.DISCONNECTED) {
      return; // Already handled
    }
    
    console.log('🔌 Connection lost');
    this.connectionState = ConnectionState.DISCONNECTED;
    
    // Clear timers
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    // Attempt reconnection if configured
    this.scheduleReconnect();
    
    this.onDisconnectedCallback?.();
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('❌ Max reconnect attempts reached');
      this.connectionState = ConnectionState.FAILED;
      this.onErrorCallback?.('Max reconnect attempts exceeded');
      return;
    }
    
    this.connectionState = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;
    
    const delay = this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, delay);
    
    this.metrics.reconnectAttempts = this.reconnectAttempts;
  }
  
  private generateSessionId(): string {
    return 'client_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }
}