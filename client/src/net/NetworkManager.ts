/**
 * Network Manager - Client-Server Communication
 * 
 * Manages the connection to the game server and handles all network communication.
 * Supports WebSocket with planned WebTransport upgrade.
 */

import { NetworkConfig } from '../client/ClientConfig.js';
import { WorldState, InputFrame } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';

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
  INPUT_FRAME = 'input_frame', 
  PING = 'ping',
  
  // Server to Client  
  HANDSHAKE_RESPONSE = 'handshake_response',
  WORLD_STATE = 'world_state',
  SNAPSHOT = 'snapshot',
  PONG = 'pong',
  MESSAGE_ACK = 'message_ack',
  
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
  protocolVersion: string;
}

/**
 * Input frame message
 */
interface InputMessage extends NetworkMessage {
  type: MessageType.INPUT_FRAME;
  inputFrame: InputFrame;
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

type GameMessage = HandshakeMessage | InputMessage | PingPongMessage | WorldStateMessage | AckMessage;

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
      
      // Send handshake
      await this.sendHandshake();
      
      // Start heartbeat
      this.startHeartbeat();
      
      this.connectionState = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      
      console.log('✅ Connected to server');
      this.onConnectionStateChanged?.(ConnectionState.CONNECTED);
      
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
      
      // Send JOIN command that server expects
      const joinCommand = `JOIN:${this.playerName}`;
      
      // Set timeout for handshake response
      const timeout = setTimeout(() => {
        console.warn('⚠️ Handshake timeout - server may not be responding');
        // Don't reject, just continue - server might be processing
        resolve();
      }, 5000);
      
      // Wait for WELCOME response or any acknowledgment
      const originalHandler = this.socket.onmessage;
      this.socket.onmessage = (event) => {
        try {
          const data = event.data;
          console.log('📨 Handshake response received:', data);
          
          // Check for WELCOME response, message ack, or any response
          if (data.startsWith('WELCOME') || 
              data.includes('message_ack') ||
              data.includes('status') ||
              data.startsWith('PONG')) {
            clearTimeout(timeout);
            this.socket!.onmessage = originalHandler;
            console.log('🤝 Handshake completed - Server acknowledged');
            
            // After successful handshake, request initial game state
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
      
      // Send the JOIN command
      try {
        this.socket.send(joinCommand);
        this.stats.messagesSent++;
        this.stats.bytesSent += joinCommand.length;
        console.log('📤 Sent handshake:', joinCommand);
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
          ships: (message.ships || []).map((ship: any) => ({
            id: ship.id || 0,
            position: ship.position ? Vec2.from(ship.position.x || 0, ship.position.y || 0) : Vec2.zero(),
            velocity: ship.velocity ? Vec2.from(ship.velocity.x || 0, ship.velocity.y || 0) : Vec2.zero(),
            rotation: ship.rotation || 0,
            angularVelocity: ship.angularVelocity || 0,
            hull: (ship.hull || []).map((point: any) => 
              point ? Vec2.from(point.x || 0, point.y || 0) : Vec2.zero()
            ),
            modules: ship.modules || []
          })),
          players: (message.players || []).map((player: any) => ({
            id: player.id || 0,
            position: player.position ? Vec2.from(player.position.x || 0, player.position.y || 0) : Vec2.zero(),
            velocity: player.velocity ? Vec2.from(player.velocity.x || 0, player.velocity.y || 0) : Vec2.zero(),
            radius: player.radius || 8,
            carrierId: player.carrierId || 0,
            deckId: player.deckId || 0,
            onDeck: player.onDeck || false
          })),
          cannonballs: (message.projectiles || []).map((ball: any) => ({
            id: ball.id || 0,
            position: ball.position ? Vec2.from(ball.position.x || 0, ball.position.y || 0) : Vec2.zero(),
            velocity: ball.velocity ? Vec2.from(ball.velocity.x || 0, ball.velocity.y || 0) : Vec2.zero(),
            firingVelocity: ball.firingVelocity ? Vec2.from(ball.firingVelocity.x || 0, ball.firingVelocity.y || 0) : Vec2.zero(),
            smokeTrail: (ball.smokeTrail || []).map((smoke: any) => ({
              position: smoke.position ? Vec2.from(smoke.position.x || 0, smoke.position.y || 0) : Vec2.zero(),
              age: smoke.age || 0
            }))
          })),
          carrierDetection: new Map() // Will be populated as needed
        };
        
        console.log(`🗺️ Received game state - Tick: ${worldState.tick}, Players: ${worldState.players.length}, Ships: ${worldState.ships.length}`);
        this.onWorldStateReceived?.(worldState);
        break;
        
      case MessageType.PONG: // Handles both 'pong' enum and text response
        this.handlePong(message);
        break;
        
      case MessageType.HANDSHAKE_RESPONSE:
        console.log('🤝 Received handshake response:', message);
        break;
        
      case MessageType.MESSAGE_ACK:
        console.log('✅ Server acknowledged message:', message.status);
        break;
        
      default:
        console.log('📦 Received message:', message.type, message);
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
    // TODO: Use JSON format when server fully supports it
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send('PING');
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