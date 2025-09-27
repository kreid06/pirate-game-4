/**
 * Pirate Game Protocol Implementation Examples
 * 
 * This file contains TypeScript/JavaScript examples for implementing
 * the Pirate Game network protocol on the client side.
 * 
 * Updated: September 27, 2025
 * Server Status: ✅ UDP (Port 8080), ✅ HTTP Admin (Port 8081), ✅ WebSocket (Port 8082)
 * 
 * WORKING IMPLEMENTATION - TESTED WITH LIVE SERVER
 */

// =============================================================================
// PROTOCOL CONSTANTS
// =============================================================================

// Server endpoints (LIVE AND WORKING)
const GAME_SERVER_UDP_PORT = 8080;     // ✅ UDP for native clients
const ADMIN_PANEL_PORT = 8081;         // ✅ HTTP admin panel
const WEBSOCKET_PORT = 8082;           // ✅ WebSocket for browsers

// Protocol commands (confirmed working on server)
enum GameCommand {
    PING = 'PING',          // ✅ Returns 'PONG'
    JOIN = 'JOIN',          // ✅ Format: 'JOIN:PlayerName' -> JSON welcome
    STATE = 'STATE',        // ✅ Returns JSON game state
    QUIT = 'QUIT',          // ✅ Graceful disconnect
    INPUT = 'INPUT'         // 🚧 Future implementation
}

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface GameState {
    type: 'GAME_STATE';
    tick: number;
    time: number;
    ships: ShipData[];
    players: PlayerData[];
    projectiles: ProjectileData[];
}

interface WelcomeMessage {
    type: 'WELCOME';
    player_id: number;
    server_time: number;
    player_name: string;
}

interface ShipData {
    id: number;
    x: number;
    y: number;
    rotation: number;
    hull_hp?: number;
}

interface PlayerData {
    id: number;
    name: string;
    x: number;
    y: number;
    ship_id?: number;
}

interface ProjectileData {
    id: number;
    x: number;
    y: number;
    velocity_x: number;
    velocity_y: number;
    type: string;
}

interface PlayerInput {
    keys: number;           // WASD bitmask: W=1, A=2, S=4, D=8
    mouseButtons: number;   // Mouse buttons: Left=1, Right=2, Middle=4
    mouseX: number;         // Mouse X position (-1 to 1)
    mouseY: number;         // Mouse Y position (-1 to 1)
    actions: number;        // Action flags (jump, interact, fire, etc.)
    timestamp: number;      // Input timestamp for lag compensation
}

// =============================================================================
// WEBSOCKET CLIENT FOR BROWSERS
// =============================================================================

/**
 * WebSocket-based client for browser compatibility
 * Connects to server port 8082 with automatic protocol translation
 */
class PirateGameWebSocketClient {
    private ws: WebSocket | null = null;
    private isConnected = false;
    private playerId: number | null = null;
    private playerName: string | null = null;
    private serverTime = 0;
    private gameState: GameState | null = null;
    private pingStartTime = 0;
    private latency = 0;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000; // Start with 1 second

    constructor(
        private serverHost: string = 'localhost',
        private serverPort: number = WEBSOCKET_PORT
    ) {}

    /**
     * Connect to the pirate game server via WebSocket
     */
    async connect(): Promise<boolean> {
        const wsUrl = `ws://${this.serverHost}:${this.serverPort}`;
        console.log(`🔗 Connecting to pirate server: ${wsUrl}`);
        
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(wsUrl);
                
                const timeout = setTimeout(() => {
                    this.ws?.close();
                    reject(new Error('Connection timeout'));
                }, 10000); // 10 second timeout
                
                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    console.log('✅ Connected to pirate server');
                    this.onConnected();
                    resolve(true);
                };
                
                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };
                
                this.ws.onerror = (error) => {
                    clearTimeout(timeout);
                    console.error('❌ WebSocket error:', error);
                    reject(error);
                };
                
                this.ws.onclose = (event) => {
                    clearTimeout(timeout);
                    this.isConnected = false;
                    const wasConnected = this.playerId !== null;
                    this.playerId = null;
                    this.playerName = null;
                    
                    console.log(`🔌 Disconnected from server (code: ${event.code})`);
                    this.onDisconnected(event.code, event.reason);
                    
                    // Auto-reconnect logic
                    if (wasConnected && this.reconnectAttempts < this.maxReconnectAttempts && !event.wasClean) {
                        this.attemptReconnect();
                    }
                };
                
            } catch (error) {
                reject(error);
            }
        });
    }

    private async attemptReconnect(): Promise<void> {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff
        
        console.log(`🔄 Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
        
        setTimeout(async () => {
            try {
                await this.connect();
                if (this.playerName) {
                    // Rejoin with same player name
                    this.joinGame(this.playerName);
                }
            } catch (error) {
                console.error('❌ Reconnect failed:', error);
            }
        }, delay);
    }

    private handleMessage(data: string) {
        console.log(`📨 Received: ${data}`);
        
        // Handle simple text responses
        if (data === 'PONG') {
            this.latency = Date.now() - this.pingStartTime;
            console.log(`🏓 Pong received! Latency: ${this.latency}ms`);
            this.onPong(this.latency);
            return;
        }
        
        if (data === 'UNKNOWN_COMMAND') {
            console.warn('⚠️ Server doesn\'t recognize command');
            this.onError('Unknown command sent to server');
            return;
        }
        
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'WELCOME':
                    this.playerId = message.player_id;
                    this.playerName = message.player_name;
                    this.serverTime = message.server_time;
                    console.log(`🎮 Joined game as "${this.playerName}" (ID: ${this.playerId})`);
                    this.onPlayerWelcome(message as WelcomeMessage);
                    break;
                    
                case 'GAME_STATE':
                    this.gameState = message as GameState;
                    console.log(`🌍 Game state: Tick ${message.tick}, Time: ${message.time}ms`);
                    console.log(`   Ships: ${message.ships?.length || 0}, Players: ${message.players?.length || 0}, Projectiles: ${message.projectiles?.length || 0}`);
                    this.onGameStateUpdate(message as GameState);
                    break;
                    
                case 'PLAYER_JOINED':
                    console.log(`👋 Player joined: ${message.player_name} (ID: ${message.player_id})`);
                    this.onPlayerJoined(message);
                    break;
                    
                case 'PLAYER_LEFT':
                    console.log(`👋 Player left: ${message.player_name} (ID: ${message.player_id})`);
                    this.onPlayerLeft(message);
                    break;
                    
                case 'ERROR':
                    console.error(`⚠️ Server error: ${message.message || message.error}`);
                    this.onError(message.message || message.error || 'Unknown server error');
                    break;
                    
                default:
                    console.log('❓ Unknown message type:', message.type, message);
                    this.onUnknownMessage(message);
            }
        } catch (error) {
            // Handle malformed JSON or other text responses
            console.log('📝 Non-JSON message:', data);
            this.onTextMessage(data);
        }
    }

    private sendMessage(data: string | object): boolean {
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('⚠️ Cannot send message: not connected');
            return false;
        }
        
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        console.log(`📤 Sending: ${message}`);
        
        try {
            this.ws.send(message);
            return true;
        } catch (error) {
            console.error('❌ Failed to send message:', error);
            return false;
        }
    }

    // =============================================================================
    // GAME PROTOCOL METHODS
    // =============================================================================

    /**
     * Join the game with a player name
     */
    joinGame(playerName: string): boolean {
        if (!playerName || playerName.trim().length === 0) {
            console.error('❌ Player name cannot be empty');
            return false;
        }
        
        const trimmedName = playerName.trim().substring(0, 32); // Limit name length
        console.log(`🚀 Joining game as "${trimmedName}"`);
        return this.sendMessage(`JOIN:${trimmedName}`);
    }

    /**
     * Send ping to measure latency
     */
    ping(): boolean {
        this.pingStartTime = Date.now();
        console.log('🏓 Sending ping...');
        return this.sendMessage('PING');
    }

    /**
     * Request current game state
     */
    requestGameState(): boolean {
        console.log('🌍 Requesting game state...');
        return this.sendMessage('STATE');
    }

    /**
     * Send player input to server (future implementation)
     */
    sendInput(input: PlayerInput): boolean {
        if (!this.playerId) {
            console.warn('⚠️ Cannot send input: not joined to game');
            return false;
        }
        
        return this.sendMessage({
            type: 'INPUT_UPDATE',
            player_id: this.playerId,
            input: input,
            timestamp: Date.now()
        });
    }

    /**
     * Send chat message (future implementation)
     */
    sendChat(message: string): boolean {
        if (!this.playerId) {
            console.warn('⚠️ Cannot send chat: not joined to game');
            return false;
        }
        
        if (!message || message.trim().length === 0) {
            return false;
        }
        
        return this.sendMessage({
            type: 'CHAT_MESSAGE',
            player_id: this.playerId,
            message: message.trim().substring(0, 256), // Limit message length
            timestamp: Date.now()
        });
    }

    /**
     * Leave the game gracefully
     */
    leaveGame(): boolean {
        console.log('🚪 Leaving game...');
        const success = this.sendMessage('QUIT');
        if (success) {
            // Give server time to process quit, then disconnect
            setTimeout(() => this.disconnect(), 100);
        }
        return success;
    }

    /**
     * Disconnect from server
     */
    disconnect(): void {
        if (this.ws) {
            console.log('🔌 Disconnecting from server...');
            this.ws.close(1000, 'Client disconnect');
        }
    }

    // =============================================================================
    // EVENT HANDLERS (Override these in your implementation)
    // =============================================================================

    protected onConnected(): void {
        // Called when WebSocket connection is established
    }

    protected onDisconnected(code: number, reason: string): void {
        // Called when connection is lost
    }

    protected onPlayerWelcome(data: WelcomeMessage): void {
        // Called when successfully joined game
    }

    protected onGameStateUpdate(state: GameState): void {
        // Called when game state is received
    }

    protected onPlayerJoined(data: any): void {
        // Called when another player joins
    }

    protected onPlayerLeft(data: any): void {
        // Called when a player leaves
    }

    protected onPong(latency: number): void {
        // Called when ping response is received
    }

    protected onError(error: string): void {
        // Called when an error occurs
    }

    protected onTextMessage(message: string): void {
        // Called for non-JSON text messages
    }

    protected onUnknownMessage(message: any): void {
        // Called for unknown JSON message types
    }

    // =============================================================================
    // PUBLIC GETTERS
    // =============================================================================

    get connected(): boolean { return this.isConnected; }
    get currentPlayerId(): number | null { return this.playerId; }
    get currentPlayerName(): string | null { return this.playerName; }
    get currentGameState(): GameState | null { return this.gameState; }
    get currentLatency(): number { return this.latency; }
    get currentServerTime(): number { return this.serverTime; }
}

// =============================================================================
// USAGE EXAMPLES
// =============================================================================

/**
 * Example 1: Basic WebSocket client usage
 */
class ExamplePirateClient extends PirateGameWebSocketClient {
    constructor() {
        super('localhost', 8082);
    }

    protected onConnected(): void {
        console.log('🎉 Connected! Joining as TestPlayer...');
        this.joinGame('TestPlayer');
        
        // Start periodic ping for latency monitoring
        setInterval(() => this.ping(), 5000);
        
        // Request game state periodically
        setInterval(() => this.requestGameState(), 2000);
    }

    protected onPlayerWelcome(data: WelcomeMessage): void {
        console.log(`🎮 Welcome message received!`, data);
        // Start game loop, enable UI, etc.
    }

    protected onGameStateUpdate(state: GameState): void {
        console.log(`🌍 Game state updated:`, state);
        // Update game rendering, entity positions, etc.
    }

    protected onError(error: string): void {
        console.error(`🚨 Game error: ${error}`);
        // Handle errors, show user notification, etc.
    }
}

/**
 * Example 2: Testing multiple protocols
 */
async function testPirateGameProtocols() {
    console.log('🧪 Testing Pirate Game Protocols...\n');
    
    // Test WebSocket connection
    console.log('1. Testing WebSocket Protocol (Port 8082)');
    const wsClient = new ExamplePirateClient();
    
    try {
        await wsClient.connect();
        console.log('✅ WebSocket connection successful!\n');
        
        // Give it a moment then disconnect
        setTimeout(() => {
            wsClient.leaveGame();
        }, 5000);
        
    } catch (error) {
        console.error('❌ WebSocket connection failed:', error);
    }
    
    console.log('2. Manual UDP Testing (Use netcat):');
    console.log('   echo "PING" | nc -u localhost 8080');
    console.log('   echo "JOIN:TestPlayer" | nc -u localhost 8080');
    console.log('   echo "STATE" | nc -u localhost 8080\n');
    
    console.log('3. Admin Panel Testing:');
    console.log('   Open: http://localhost:8081');
    console.log('   Live map: Click "Live Map" tab\n');
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Create input state from keyboard/mouse events
 */
function createInputState(keyStates: Record<string, boolean>, mouseState: any): PlayerInput {
    let keys = 0;
    if (keyStates['KeyW'] || keyStates['ArrowUp']) keys |= 1;     // W
    if (keyStates['KeyA'] || keyStates['ArrowLeft']) keys |= 2;   // A  
    if (keyStates['KeyS'] || keyStates['ArrowDown']) keys |= 4;   // S
    if (keyStates['KeyD'] || keyStates['ArrowRight']) keys |= 8;  // D
    
    let mouseButtons = 0;
    if (mouseState.leftButton) mouseButtons |= 1;
    if (mouseState.rightButton) mouseButtons |= 2;
    if (mouseState.middleButton) mouseButtons |= 4;
    
    return {
        keys,
        mouseButtons,
        mouseX: mouseState.x || 0,
        mouseY: mouseState.y || 0,
        actions: 0, // Future: jump, interact, fire, etc.
        timestamp: Date.now()
    };
}

/**
 * Admin panel API helper
 */
class AdminPanelAPI {
    constructor(private baseUrl: string = `http://localhost:${ADMIN_PANEL_PORT}`) {}
    
    async getServerStatus() {
        const response = await fetch(`${this.baseUrl}/api/status`);
        return response.json();
    }
    
    async getGameState() {
        const response = await fetch(`${this.baseUrl}/api/map`);
        return response.json();
    }
    
    async getPhysicsObjects() {
        const response = await fetch(`${this.baseUrl}/api/physics`);
        return response.json();
    }
    
    async getNetworkStats() {
        const response = await fetch(`${this.baseUrl}/api/network`);
        return response.json();
    }
}

// Export for use in other modules
export {
    PirateGameWebSocketClient,
    ExamplePirateClient,
    AdminPanelAPI,
    GameCommand,
    testPirateGameProtocols,
    createInputState,
    type GameState,
    type WelcomeMessage,
    type PlayerInput,
    type ShipData,
    type PlayerData,
    type ProjectileData
};