/**
 * Network Manager - Client-Server Communication
 * 
 * Manages the connection to the game server and handles all network communication.
 * Supports WebSocket with planned WebTransport upgrade.
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame } from '../sim/Types.js';

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
  INPUT_FRAME = 'input_frame',
  PING = 'ping',
  
  // Server to Client  
  WORLD_STATE = 'world_state',
  PONG = 'pong',
  
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
 * Input frame message
 */
interface InputMessage extends NetworkMessage {
  type: MessageType.INPUT_FRAME;
  inputFrame: InputFrame;
}

/**
 * World state message
 */
interface WorldStateMessage extends NetworkMessage {
  type: MessageType.WORLD_STATE;
  worldState: WorldState;
}

/**
 * Ping/Pong messages for latency measurement
 */
interface PingPongMessage extends NetworkMessage {
  type: MessageType.PING | MessageType.PONG;
  clientTimestamp: number;
}

/**
 * Union of all message types
 */
type GameMessage = InputMessage | WorldStateMessage | PingPongMessage | NetworkMessage;

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
  
  // Message handling
  private messageSequenceId = 0;
  private pendingPings = new Map<number, number>(); // sequenceId -> timestamp
  
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
  
  // Event callbacks
  public onWorldStateReceived: ((worldState: WorldState) => void) | null = null;
  public onConnectionStateChanged: ((connected: boolean) => void) | null = null;
  
  constructor(config: NetworkConfig) {
    this.config = config;
  }
  
  /**
   * Connect to the game server
   */
  async connect(): Promise<void> {
    if (this.connectionState === ConnectionState.CONNECTING || 
        this.connectionState === ConnectionState.CONNECTED) {
      return; // Already connecting or connected
    }
    
    this.connectionState = ConnectionState.CONNECTING;
    console.log(`🌐 Connecting to server: ${this.config.serverUrl}`);
    
    try {
      // Create WebSocket connection
      this.socket = new WebSocket(this.config.serverUrl);
      
      // Set up event handlers
      this.setupSocketHandlers();
      
      // Wait for connection with timeout
      await this.waitForConnection();
      
      // Start heartbeat
      this.startHeartbeat();
      
      this.connectionState = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      
      console.log('✅ Connected to server');
      this.onConnectionStateChanged?.(true);
      
    } catch (error) {
      this.connectionState = ConnectionState.ERROR;
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
    
    this.onConnectionStateChanged?.(false);
    console.log('✅ Disconnected from server');
  }
  
  /**
   * Send input frame to server
   */
  sendInput(inputFrame: InputFrame): void {
    if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
      return; // Not connected
    }
    
    const message: InputMessage = {
      type: MessageType.INPUT_FRAME,
      timestamp: Date.now(),
      sequenceId: this.messageSequenceId++,
      inputFrame
    };
    
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
  
  // Private methods
  
  private setupSocketHandlers(): void {
    if (!this.socket) return;
    
    this.socket.onopen = (event) => {
      console.log('🔗 WebSocket opened');
    };
    
    this.socket.onmessage = (event) => {
      try {
        const message: GameMessage = JSON.parse(event.data);
        this.handleMessage(message);
        this.stats.messagesReceived++;
        this.stats.bytesReceived += event.data.length;
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };
    
    this.socket.onclose = (event) => {
      console.log('🔌 WebSocket closed:', event.code, event.reason);
      
      if (this.connectionState === ConnectionState.CONNECTED) {
        // Unexpected disconnection - attempt reconnect
        this.connectionState = ConnectionState.DISCONNECTED;
        this.onConnectionStateChanged?.(false);
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
  
  private handleMessage(message: GameMessage): void {
    switch (message.type) {
      case MessageType.WORLD_STATE:
        const worldStateMsg = message as WorldStateMessage;
        this.onWorldStateReceived?.(worldStateMsg.worldState);
        break;
        
      case MessageType.PONG:
        const pongMsg = message as PingPongMessage;
        this.handlePong(pongMsg);
        break;
        
      default:
        console.warn('Unknown message type:', message.type);
        break;
    }
  }
  
  private handlePong(pongMessage: PingPongMessage): void {
    if (!pongMessage.sequenceId) return;
    
    const sendTime = this.pendingPings.get(pongMessage.sequenceId);
    if (sendTime) {
      // Calculate ping
      const ping = Date.now() - sendTime;
      this.stats.ping = ping;
      this.pendingPings.delete(pongMessage.sequenceId);
    }
  }
  
  private sendMessage(message: GameMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    
    try {
      const data = JSON.stringify(message);
      this.socket.send(data);
      this.stats.messagesSent++;
      this.stats.bytesSent += data.length;
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
    
    const pingMessage: PingPongMessage = {
      type: MessageType.PING,
      timestamp,
      sequenceId,
      clientTimestamp: timestamp
    };
    
    this.pendingPings.set(sequenceId, timestamp);
    this.sendMessage(pingMessage);
    
    // Clean up old pings (prevent memory leak)
    const oldPingThreshold = timestamp - 10000; // 10 seconds
    for (const [id, time] of this.pendingPings.entries()) {
      if (time < oldPingThreshold) {
        this.pendingPings.delete(id);
      }
    }
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('❌ Max reconnection attempts reached');
      this.connectionState = ConnectionState.ERROR;
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff
    
    console.log(`🔄 Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    this.connectionState = ConnectionState.RECONNECTING;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('Reconnection failed:', error);
      });
    }, delay);
  }
}