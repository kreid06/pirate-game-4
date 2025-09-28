/**
 * Enhanced Game Engine Integration
 * 
 * Complete integration of all client systems:
 * - Enhanced prediction engine with Week 3-4 server compatibility
 * - Network manager with protocol bridging
 * - Physics simulation with deterministic rollback
 * - Rendering pipeline with smooth interpolation
 */

import { GameEngine } from './GameEngine.js';
import { ClientConfig, DEFAULT_CLIENT_CONFIG } from './ClientConfig.js';
import { EnhancedPredictionEngine } from '../net/EnhancedPredictionEngine.js';
import { EnhancedNetworkManager, ConnectionState } from '../net/EnhancedNetworkManager.js';
import { WorldState, InputFrame } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';

/**
 * Enhanced client application state
 */
export enum ClientState {
  INITIALIZING = 'initializing',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  IN_GAME = 'in_game',
  DISCONNECTED = 'disconnected',
  ERROR = 'error'
}

/**
 * Client performance metrics
 */
export interface ClientMetrics {
  // Frame timing
  fps: number;
  frameTime: number;
  averageFrameTime: number;
  
  // Network performance
  networkLatency: number;
  packetLossRate: number;
  connectionState: string;
  
  // Prediction performance
  rollbacksPerSecond: number;
  predictionAccuracy: number;
  
  // Rendering performance
  drawCalls: number;
  entitiesRendered: number;
  particlesActive: number;
}

/**
 * Enhanced Game Engine with full multiplayer support
 * Uses composition instead of inheritance to avoid conflicts
 */
export class EnhancedGameEngine {
  private config: ClientConfig;
  private state = ClientState.INITIALIZING;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  
  // Base game engine for local functionality
  private baseEngine: GameEngine;
  
  // Core systems
  private predictionEngine: EnhancedPredictionEngine;
  private networkManager: EnhancedNetworkManager;
  
  // Game loop management
  private running = false;
  private animationId: number | null = null;
  
  // World state management
  private clientWorldState: WorldState;
  private authorativeWorldState: WorldState | null = null;
  private renderWorldState: WorldState;
  
  // Input management
  private currentInput: InputFrame;
  private inputHistory: InputFrame[] = [];
  private keys = new Set<string>();
  
  // Timing
  private lastUpdateTime = 0;
  private accumulatedTime = 0;
  private fixedTimeStep: number;
  
  // Performance tracking
  private frameCount = 0;
  private lastFpsUpdate = 0;
  private frameTimes: number[] = [];
  private metrics: ClientMetrics = {
    fps: 0,
    frameTime: 0,
    averageFrameTime: 0,
    networkLatency: 0,
    packetLossRate: 0,
    connectionState: 'disconnected',
    rollbacksPerSecond: 0,
    predictionAccuracy: 0,
    drawCalls: 0,
    entitiesRendered: 0,
    particlesActive: 0
  };
  
  constructor(canvas: HTMLCanvasElement, config: ClientConfig = DEFAULT_CLIENT_CONFIG) {
    this.canvas = canvas;
    this.config = config;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D rendering context');
    }
    this.ctx = ctx;
    
    this.fixedTimeStep = 1000 / config.prediction.clientTickRate; // Convert Hz to ms
    
    // Initialize base engine for fallback functionality
    this.baseEngine = new GameEngine(canvas);
    
    // Initialize core systems
    this.predictionEngine = new EnhancedPredictionEngine(config.prediction);
    this.networkManager = new EnhancedNetworkManager(config.network, this.predictionEngine);
    
    // Initialize world state
    this.clientWorldState = this.createEmptyWorldState();
    this.renderWorldState = this.createEmptyWorldState();
    this.currentInput = this.createNeutralInput();
    
    // Set up input handling
    this.setupInputHandlers();
    
    // Set up network callbacks
    this.setupNetworkCallbacks();
    
    console.log('🚀 Enhanced Game Engine initialized');
    console.log(`   Fixed timestep: ${this.fixedTimeStep}ms (${config.prediction.clientTickRate}Hz)`);
    console.log(`   Server tick rate: ${config.prediction.serverTickRate}Hz`);
  }
  
  /**
   * Start the enhanced game engine
   */
  public async start(): Promise<void> {
    console.log('🎮 Starting Enhanced Game Engine...');
    
    try {
      // Connect to server
      this.state = ClientState.CONNECTING;
      await this.networkManager.connect();
      
      this.state = ClientState.CONNECTED;
      console.log('✅ Connected to game server');
      
      // Start the game loop
      this.startGameLoop();
      
      // Start metrics collection
      this.startMetricsCollection();
      
      this.state = ClientState.IN_GAME;
      console.log('🎮 Game started successfully');
      
    } catch (error) {
      console.error('❌ Failed to start game:', error);
      this.state = ClientState.ERROR;
      throw error;
    }
  }
  
  /**
   * Start the main game loop
   */
  private startGameLoop(): void {
    if (this.running) {
      return;
    }
    
    this.running = true;
    this.lastUpdateTime = performance.now();
    this.gameLoop(this.lastUpdateTime);
  }
  
  /**
   * Stop the game engine
   */
  public stop(): void {
    this.state = ClientState.DISCONNECTED;
    this.running = false;
    
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    
    this.networkManager.disconnect();
    
    console.log('🛑 Enhanced Game Engine stopped');
  }
  
  /**
   * Main game loop with fixed timestep
   */
  protected gameLoop(currentTime: number): void {
    const deltaTime = currentTime - this.lastUpdateTime;
    this.lastUpdateTime = currentTime;
    
    // Accumulate time for fixed timestep updates
    this.accumulatedTime += deltaTime;
    
    // Update input
    this.updateInput();
    
    // Fixed timestep updates
    while (this.accumulatedTime >= this.fixedTimeStep) {
      this.fixedUpdate(this.fixedTimeStep);
      this.accumulatedTime -= this.fixedTimeStep;
    }
    
    // Variable timestep rendering
    this.render(currentTime);
    
    // Update performance metrics
    this.updatePerformanceMetrics(deltaTime);
    
    // Continue game loop
    if (this.running) {
      requestAnimationFrame((time) => this.gameLoop(time));
    }
  }
  
  /**
   * Fixed timestep update for deterministic simulation
   */
  private fixedUpdate(deltaTime: number): void {
    if (this.state !== ClientState.IN_GAME) {
      return;
    }
    
    // Send input to server
    if (this.networkManager.isConnected()) {
      this.networkManager.sendInput(this.currentInput, deltaTime);
    }
    
    // Run client-side prediction
    this.clientWorldState = this.predictionEngine.update(
      this.clientWorldState,
      this.currentInput,
      deltaTime
    );
    
    // Store input in history
    this.inputHistory.push({ ...this.currentInput });
    if (this.inputHistory.length > 120) { // 1 second history at 120Hz
      this.inputHistory.shift();
    }
  }
  
  /**
   * Render the game world
   */
  private render(currentTime: number): void {
    // Get interpolated world state for smooth rendering
    this.renderWorldState = this.predictionEngine.getInterpolatedState(currentTime) || this.clientWorldState;
    
    // Clear canvas
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Render world
    this.renderWorld(this.renderWorldState);
    
    // Render UI overlays
    this.renderUI();
    
    // Update render metrics
    this.metrics.entitiesRendered = 
      this.renderWorldState.ships.length + 
      this.renderWorldState.players.length + 
      this.renderWorldState.cannonballs.length;
  }
  
  /**
   * Render the game world
   */
  private renderWorld(worldState: WorldState): void {
    const ctx = this.canvas.getContext('2d')!;
    
    // Simple rendering implementation
    ctx.save();
    
    // Center camera on first player (if exists)
    if (worldState.players.length > 0) {
      const player = worldState.players[0];
      ctx.translate(
        this.canvas.width / 2 - player.position.x,
        this.canvas.height / 2 - player.position.y
      );
    }
    
    // Render ships
    ctx.fillStyle = '#8B4513';
    for (const ship of worldState.ships) {
      ctx.save();
      ctx.translate(ship.position.x, ship.position.y);
      ctx.rotate(ship.rotation);
      ctx.fillRect(-50, -20, 100, 40); // Simple ship representation
      ctx.restore();
    }
    
    // Render players
    ctx.fillStyle = '#FF6B6B';
    for (const player of worldState.players) {
      ctx.beginPath();
      ctx.arc(player.position.x, player.position.y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Render cannonballs
    ctx.fillStyle = '#2C3E50';
    for (const cannonball of worldState.cannonballs) {
      ctx.beginPath();
      ctx.arc(cannonball.position.x, cannonball.position.y, 3, 0, Math.PI * 2);
      ctx.fill();
      
      // Render smoke trail
      ctx.fillStyle = '#BDC3C7';
      for (const smoke of cannonball.smokeTrail) {
        ctx.globalAlpha = 1 - smoke.age;
        ctx.beginPath();
        ctx.arc(smoke.position.x, smoke.position.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#2C3E50';
    }
    
    ctx.restore();
  }
  
  /**
   * Render UI overlays
   */
  private renderUI(): void {
    if (!this.config.debug.enabled) {
      return;
    }
    
    const ctx = this.canvas.getContext('2d')!;
    
    // Network stats
    if (this.config.debug.showNetworkStats) {
      this.renderNetworkStats(ctx);
    }
    
    // Performance stats
    if (this.config.debug.showPerformanceStats) {
      this.renderPerformanceStats(ctx);
    }
    
    // Prediction stats
    this.renderPredictionStats(ctx);
  }
  
  /**
   * Update input from user
   */
  private updateInput(): void {
    // Get movement input
    const movement = new Vec2(0, 0);
    if (this.keys.has('w') || this.keys.has('W') || this.keys.has('ArrowUp')) movement.y -= 1;
    if (this.keys.has('s') || this.keys.has('S') || this.keys.has('ArrowDown')) movement.y += 1;
    if (this.keys.has('a') || this.keys.has('A') || this.keys.has('ArrowLeft')) movement.x -= 1;
    if (this.keys.has('d') || this.keys.has('D') || this.keys.has('ArrowRight')) movement.x += 1;
    
    // Normalize movement
    if (movement.length() > 0) {
      movement.normalize();
    }
    
    // Get action input
    let actions = 0;
    if (this.keys.has(' ')) actions |= 1; // Jump
    if (this.keys.has('e') || this.keys.has('E')) actions |= 2; // Interact
    if (this.keys.has('q') || this.keys.has('Q')) actions |= 4; // Dismount
    if (this.keys.has('f') || this.keys.has('F')) actions |= 8; // Destroy plank
    
    // Update current input
    this.currentInput = {
      tick: this.clientWorldState.tick + 1,
      movement,
      actions
    };
  }
  
  /**
   * Set up input event handlers
   */
  private setupInputHandlers(): void {
    // Key event handlers
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      this.keys.add(e.key);
    });
    
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.keys.delete(e.key);
    });
    
    // Focus handling to clear keys when window loses focus
    window.addEventListener('blur', () => {
      this.keys.clear();
    });
  }
  private setupNetworkCallbacks(): void {
    this.networkManager.setCallbacks({
      onConnected: () => {
        console.log('🌐 Connected to server');
        this.state = ClientState.CONNECTED;
      },
      
      onDisconnected: () => {
        console.log('🌐 Disconnected from server');
        this.state = ClientState.DISCONNECTED;
      },
      
      onSnapshot: (snapshot) => {
        // Handled by prediction engine
      },
      
      onError: (error) => {
        console.error('🌐 Network error:', error);
        this.state = ClientState.ERROR;
      }
    });
  }
  
  /**
   * Create empty world state
   */
  private createEmptyWorldState(): WorldState {
    return {
      tick: 0,
      timestamp: Date.now(),
      ships: [],
      players: [],
      cannonballs: [],
      carrierDetection: new Map()
    };
  }
  
  /**
   * Create neutral input
   */
  private createNeutralInput(): InputFrame {
    return {
      tick: 0,
      movement: Vec2.zero(),
      actions: 0
    };
  }
  
  /**
   * Start metrics collection
   */
  private startMetricsCollection(): void {
    setInterval(() => {
      this.updateMetrics();
    }, 1000); // Update every second
  }
  
  /**
   * Update performance metrics
   */
  private updatePerformanceMetrics(deltaTime: number): void {
    this.frameCount++;
    this.frameTimes.push(deltaTime);
    
    // Keep last 60 frame times
    if (this.frameTimes.length > 60) {
      this.frameTimes.shift();
    }
    
    // Update FPS every second
    const now = Date.now();
    if (now - this.lastFpsUpdate >= 1000) {
      this.metrics.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
    
    // Calculate average frame time
    this.metrics.frameTime = deltaTime;
    this.metrics.averageFrameTime = 
      this.frameTimes.reduce((sum, time) => sum + time, 0) / this.frameTimes.length;
  }
  
  /**
   * Update all metrics
   */
  private updateMetrics(): void {
    // Network metrics
    const networkMetrics = this.networkManager.getMetrics();
    this.metrics.networkLatency = networkMetrics.latency;
    this.metrics.packetLossRate = networkMetrics.packetsLost / Math.max(1, networkMetrics.packetsSent) * 100;
    this.metrics.connectionState = networkMetrics.connectionState;
    
    // Prediction metrics
    const predictionMetrics = this.predictionEngine.getMetrics();
    this.metrics.rollbacksPerSecond = predictionMetrics.rollbacksPerformed; // Will need rate calculation
    this.metrics.predictionAccuracy = 100 - predictionMetrics.averagePredictionError;
  }
  
  /**
   * Render network statistics
   */
  private renderNetworkStats(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    
    let y = 20;
    const lineHeight = 16;
    
    ctx.fillText(`Connection: ${this.metrics.connectionState}`, 10, y); y += lineHeight;
    ctx.fillText(`Latency: ${this.metrics.networkLatency.toFixed(1)}ms`, 10, y); y += lineHeight;
    ctx.fillText(`Packet Loss: ${this.metrics.packetLossRate.toFixed(1)}%`, 10, y); y += lineHeight;
  }
  
  /**
   * Render performance statistics
   */
  private renderPerformanceStats(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    
    let y = 20;
    const lineHeight = 16;
    const x = this.canvas.width - 200;
    
    ctx.fillText(`FPS: ${this.metrics.fps}`, x, y); y += lineHeight;
    ctx.fillText(`Frame Time: ${this.metrics.frameTime.toFixed(1)}ms`, x, y); y += lineHeight;
    ctx.fillText(`Avg Frame: ${this.metrics.averageFrameTime.toFixed(1)}ms`, x, y); y += lineHeight;
    ctx.fillText(`Entities: ${this.metrics.entitiesRendered}`, x, y); y += lineHeight;
  }
  
  /**
   * Render prediction statistics
   */
  private renderPredictionStats(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#FFFF00';
    ctx.font = '12px monospace';
    
    let y = this.canvas.height - 60;
    const lineHeight = 16;
    
    ctx.fillText(`Rollbacks/sec: ${this.metrics.rollbacksPerSecond}`, 10, y); y += lineHeight;
    ctx.fillText(`Prediction Accuracy: ${this.metrics.predictionAccuracy.toFixed(1)}%`, 10, y); y += lineHeight;
    ctx.fillText(`Client Tick: ${this.clientWorldState.tick}`, 10, y); y += lineHeight;
  }
  
  /**
   * Get client performance metrics
   */
  public getMetrics(): ClientMetrics {
    return { ...this.metrics };
  }
  
  /**
   * Get current client state
   */
  public getState(): ClientState {
    return this.state;
  }
}