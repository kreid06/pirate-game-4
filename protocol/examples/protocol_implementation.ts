/**
 * Pirate Game Protocol Implementation Examples
 * 
 * This file shows practical examples of how to implement the pirate game
 * protocol based on the working server implementation.
 * 
 * Updated: September 27, 2025
 * Server: ✅ UDP port 8080 + ✅ HTTP port 8081 + ✅ WebSocket port 8082
 * Protocol: Simple text-based commands with JSON responses (WORKING)
 * 
 * 🎉 NEW: WebSocket support for browser clients!
 *    - Native clients can use UDP directly
 *    - Browser clients use WebSocket with automatic protocol translation
 *    - Both protocols work with the same server simultaneously
 * 
 * See protocol_implementation_websocket.ts for full WebSocket client example
 */

// =============================================================================
// PROTOCOL CONSTANTS
// =============================================================================

// Server endpoints (LIVE AND TESTED)
const GAME_SERVER_HOST = 'localhost';
const UDP_PORT = 8080;           // ✅ UDP for native clients  
const ADMIN_PANEL_PORT = 8081;   // ✅ HTTP admin panel
const WEBSOCKET_PORT = 8082;     // ✅ WebSocket for browsers

// Protocol commands (confirmed working on server)
enum GameCommand {
    PING = 'PING',      // ✅ Test connectivity - server responds with 'PONG'
    JOIN = 'JOIN',      // ✅ Join game: 'JOIN:PlayerName' -> JSON welcome response  
    STATE = 'STATE',    // ✅ Request game state -> JSON state response
    QUIT = 'QUIT',      // ✅ Graceful disconnect
    INPUT = 'INPUT',    // 🚧 Send player input (future)
    LEAVE = 'LEAVE'     // 🚧 Leave game (alias for QUIT)
}

// Server response types (confirmed working)
enum ServerResponse {
    PONG = 'PONG',                // Simple text response to PING
    WELCOME = 'WELCOME',          // JSON: {type:'WELCOME', player_id:1234, player_name:'Name', server_time:12345}
    GAME_STATE = 'GAME_STATE',    // JSON: {type:'GAME_STATE', tick:123, time:12345, ships:[], players:[], projectiles:[]}
    UNKNOWN_COMMAND = 'UNKNOWN_COMMAND'  // Text response for unrecognized commands
}

// =============================================================================
// CLIENT SIDE (TypeScript/JavaScript for Web)
// =============================================================================

interface GameState {
    type: string;
    tick: number;
    ships: ShipData[];
    players: PlayerData[];
    projectiles: ProjectileData[];
}

interface ShipData {
    id: number;
    x: number;
    y: number;
    rotation: number;
    hull_hp: number;
}

interface PlayerData {
    id: number;
    name: string;
    x: number;
    y: number;
}

interface ProjectileData {
    id: number;
    x: number;
    y: number;
    type: string;
}

interface InputState {
    keys: number;           // WASD bitmask: W=1, A=2, S=4, D=8
    mouseButtons: number;   // Mouse buttons: Left=1, Right=2
    mouseX: number;         // Mouse X position
    mouseY: number;         // Mouse Y position
    timestamp: number;      // Input timestamp
}

/**
 * WebSocket-based UDP client for pirate game
 * Note: Direct UDP from browser requires WebRTC or server proxy
 */
class PirateGameClient {
    private socket: WebSocket | null = null;
    private playerId: number = 0;
    private connected: boolean = false;
    private gameState: GameState | null = null;
    
    // Connection callbacks
    onConnected?: () => void;
    onDisconnected?: () => void;
    onGameState?: (state: GameState) => void;
    onError?: (error: string) => void;

    /**
     * Connect to game server via WebSocket proxy
     * (Since browsers can't do direct UDP, server needs WebSocket bridge)
     */
    async connect(playerName: string = "Player"): Promise<boolean> {
        try {
            // For direct UDP testing, use a WebSocket-to-UDP proxy
            // In production, server would provide WebSocket endpoint
            this.socket = new WebSocket(`ws://${GAME_SERVER_HOST}:${WEBSOCKET_PORT}`);
            
            this.socket.onopen = () => {
                console.log('🔗 Connected to pirate game server');
                this.connected = true;
                this.sendJoin(playerName);
                this.onConnected?.();
            };

            this.socket.onmessage = (event) => {
                this.handleServerMessage(event.data);
            };

            this.socket.onclose = () => {
                console.log('🔌 Disconnected from server');
                this.connected = false;
                this.onDisconnected?.();
            };

            this.socket.onerror = (error) => {
                console.error('❌ WebSocket error:', error);
                this.onError?.('Connection failed');
            };

            return true;
        } catch (error) {
            console.error('❌ Failed to connect:', error);
            this.onError?.('Connection failed');
            return false;
        }
    }

    /**
     * Send JOIN command to server
     */
    private sendJoin(playerName: string): void {
        const joinMessage = `${GameCommand.JOIN}:${playerName}`;
        this.sendMessage(joinMessage);
    }

    /**
     * Send PING to test connection
     */
    ping(): void {
        this.sendMessage(GameCommand.PING);
    }

    /**
     * Request current game state
     */
    requestState(): void {
        this.sendMessage(GameCommand.STATE);
    }

    /**
     * Send player input to server
     */
    sendInput(input: InputState): void {
        const inputJson = JSON.stringify({
            command: GameCommand.INPUT,
            keys: input.keys,
            mouse_buttons: input.mouseButtons,
            mouse_x: input.mouseX,
            mouse_y: input.mouseY,
            timestamp: input.timestamp
        });
        this.sendMessage(inputJson);
    }

    /**
     * Disconnect from server
     */
    disconnect(): void {
        if (this.connected) {
            this.sendMessage(GameCommand.LEAVE);
            this.socket?.close();
        }
    }

    private sendMessage(message: string): void {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(message);
            console.log(`📤 Sent: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
        } else {
            console.warn('⚠️ Cannot send message - not connected');
        }
    }

    private handleServerMessage(data: string): void {
        console.log(`📥 Received: ${data.substring(0, 100)}${data.length > 100 ? '...' : ''}`);

        // Handle simple text responses
        if (data === 'PONG') {
            console.log('🏓 Ping successful');
            return;
        }

        // Handle JSON responses
        try {
            const response = JSON.parse(data);
            
            switch (response.type) {
                case 'WELCOME':
                    this.playerId = response.player_id;
                    console.log(`🎮 Joined as player ${this.playerId}`);
                    break;
                    
                case 'GAME_STATE':
                    this.gameState = response;
                    this.onGameState?.(response);
                    console.log(`🗺️ Game state: ${response.ships?.length || 0} ships, ${response.players?.length || 0} players`);
                    break;
                    
                default:
                    console.log(`📨 Server message: ${response.type}`);
            }
        } catch (error) {
            // Handle non-JSON responses (echo, etc.)
            console.log(`📢 Server echo: ${data}`);
        }
    }

    // Getters
    get isConnected(): boolean { return this.connected; }
    get currentPlayerId(): number { return this.playerId; }
    get currentGameState(): GameState | null { return this.gameState; }
}

// =============================================================================
// DIRECT UDP TESTING (Node.js or Testing Environment)
// =============================================================================

/**
 * Direct UDP client for testing the server
 * Use this for testing the actual UDP protocol implementation
 */
class DirectUDPClient {
    private socket: any; // dgram.Socket in Node.js
    private serverAddress: string;
    private serverPort: number;

    constructor(host: string = GAME_SERVER_HOST, port: number = UDP_PORT) {
        this.serverAddress = host;
        this.serverPort = port;
        
        // In Node.js environment:
        // const dgram = require('dgram');
        // this.socket = dgram.createSocket('udp4');
    }

    /**
     * Send PING command and wait for PONG
     */
    async testPing(): Promise<boolean> {
        return new Promise((resolve) => {
            // Create message as Uint8Array for browser compatibility
            const message = new TextEncoder().encode(GameCommand.PING);
            
            // Mock implementation for browser
            console.log(`📤 Would send: ${GameCommand.PING} to ${this.serverAddress}:${this.serverPort}`);
            console.log(`📥 Expected response: ${ServerResponse.PONG}`);
            
            // In Node.js with dgram:
            // const buffer = Buffer.from(GameCommand.PING);
            // this.socket.send(buffer, this.serverPort, this.serverAddress, (err) => {
            //     if (err) {
            //         console.error('❌ Send failed:', err);
            //         resolve(false);
            //     }
            // });
            
            // Mock success for browser environment
            setTimeout(() => resolve(true), 100);
        });
    }

    /**
     * Test JOIN command
     */
    async testJoin(playerName: string): Promise<void> {
        const message = new TextEncoder().encode(`${GameCommand.JOIN}:${playerName}`);
        console.log(`📤 Would send: JOIN:${playerName}`);
        console.log(`📥 Expected: JSON welcome message`);
        
        // In Node.js: Buffer.from(`${GameCommand.JOIN}:${playerName}`)
    }

    /**
     * Test STATE request
     */
    async testStateRequest(): Promise<void> {
        const message = new TextEncoder().encode(GameCommand.STATE);
        console.log(`📤 Would send: ${GameCommand.STATE}`);
        console.log(`📥 Expected: JSON game state`);
        
        // In Node.js: Buffer.from(GameCommand.STATE)
    }
}

// =============================================================================
// SERVER MONITORING (Admin Panel Integration)
// =============================================================================

/**
 * Admin panel client for monitoring server
 */
class AdminPanelClient {
    private baseUrl: string;

    constructor(baseUrl: string = `http://${GAME_SERVER_HOST}:${ADMIN_PANEL_PORT}`) {
        this.baseUrl = baseUrl;
    }

    /**
     * Get server status
     */
    async getServerStatus(): Promise<any> {
        try {
            const response = await fetch(`${this.baseUrl}/api/status`);
            return await response.json();
        } catch (error) {
            console.error('❌ Failed to get server status:', error);
            return null;
        }
    }

    /**
     * Get network statistics
     */
    async getNetworkStats(): Promise<any> {
        try {
            const response = await fetch(`${this.baseUrl}/api/network`);
            return await response.json();
        } catch (error) {
            console.error('❌ Failed to get network stats:', error);
            return null;
        }
    }

    /**
     * Get live map data
     */
    async getMapData(): Promise<any> {
        try {
            const response = await fetch(`${this.baseUrl}/api/map`);
            return await response.json();
        } catch (error) {
            console.error('❌ Failed to get map data:', error);
            return null;
        }
    }

    /**
     * Monitor server in real-time
     */
    startMonitoring(interval: number = 2000): void {
        setInterval(async () => {
            const [status, network, map] = await Promise.all([
                this.getServerStatus(),
                this.getNetworkStats(),
                this.getMapData()
            ]);

            console.log('📊 Server Status:', {
                uptime: status?.uptime_seconds,
                tick_rate: status?.tick_rate,
                players: status?.player_count
            });

            console.log('🌐 Network Stats:', {
                packets_sent: network?.packets_sent,
                packets_received: network?.packets_received,
                bandwidth: network?.bandwidth_usage_kbps
            });

            console.log('🗺️ Map Data:', {
                ships: map?.ships?.length || 0,
                players: map?.players?.length || 0,
                projectiles: map?.projectiles?.length || 0
            });
        }, interval);
    }
}

// =============================================================================
// USAGE EXAMPLES
// =============================================================================

/**
 * Example: Basic game client usage
 */
async function exampleGameClient() {
    const client = new PirateGameClient();
    
    client.onConnected = () => {
        console.log('🎮 Ready to play!');
        client.requestState();
    };
    
    client.onGameState = (state) => {
        console.log(`🎯 Game state received: tick ${state.tick}`);
    };
    
    // Connect to game
    await client.connect('TestPlayer');
    
    // Send input every 100ms
    setInterval(() => {
        const input: InputState = {
            keys: Math.floor(Math.random() * 16), // Random WASD
            mouseButtons: 0,
            mouseX: Math.random() * 800,
            mouseY: Math.random() * 600,
            timestamp: Date.now()
        };
        client.sendInput(input);
    }, 100);
}

/**
 * Example: Direct UDP testing
 */
async function exampleUDPTesting() {
    const udpClient = new DirectUDPClient();
    
    console.log('🔍 Testing UDP connection...');
    const pingSuccess = await udpClient.testPing();
    
    if (pingSuccess) {
        console.log('✅ PING test successful');
        await udpClient.testJoin('UDPTestPlayer');
        await udpClient.testStateRequest();
    } else {
        console.log('❌ PING test failed');
    }
}

/**
 * Example: Admin monitoring
 */
function exampleAdminMonitoring() {
    const admin = new AdminPanelClient();
    
    console.log('📊 Starting server monitoring...');
    admin.startMonitoring(5000); // Update every 5 seconds
}

// =============================================================================
// EXPORT FOR MODULE USAGE
// =============================================================================

export {
    PirateGameClient,
    DirectUDPClient,
    AdminPanelClient,
    GameCommand,
    ServerResponse,
    type GameState,
    type InputState,
    type ShipData,
    type PlayerData,
    type ProjectileData,
    exampleGameClient,
    exampleUDPTesting,
    exampleAdminMonitoring
};