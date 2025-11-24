/**
 * Client Application - Main Client Coordinator
 * 
 * This class orchestrates all client-side systems and provides the main game loop.
 * It follows the composition pattern, delegating specific concerns to specialized systems.
 */

import { ClientConfig } from './ClientConfig.js';

// Graphics System
import { RenderSystem } from './gfx/RenderSystem.js';
import { Camera } from './gfx/Camera.js';

// Network System  
import { NetworkManager, ConnectionState } from '../net/NetworkManager.js';
import { PredictionEngine } from '../net/PredictionEngine.js';

// Gameplay Systems
import { InputManager } from './gameplay/InputManager.js';
import { ModuleInteractionSystem } from './gameplay/ModuleInteractionSystem.js';
import { PhysicsConfig } from '../sim/Types.js';

// UI System
import { UIManager } from './ui/UIManager.js';

// Audio System
import { AudioManager } from './audio/AudioManager.js';

// Core Simulation Types
import { WorldState, InputFrame } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';

/**
 * Application lifecycle states
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
 * Main client application class
 */
export class ClientApplication {
  private canvas: HTMLCanvasElement;
  private config: ClientConfig;
  private state: ClientState = ClientState.INITIALIZING;
  
  // Core Systems
  private renderSystem!: RenderSystem;
  private networkManager!: NetworkManager;
  private predictionEngine!: PredictionEngine;
  private inputManager!: InputManager;
  private uiManager!: UIManager;
  private audioManager!: AudioManager;
  private moduleInteractionSystem!: ModuleInteractionSystem;
  
  // Game State
  private authoritativeWorldState: WorldState | null = null;
  private predictedWorldState: WorldState | null = null;
  private demoWorldState: WorldState | null = null;
  private camera!: Camera;
  private hasReceivedWorldState = false; // Track if we've received at least one world state
  
  // Timing
  private running = false;
  private lastFrameTime = 0;
  private accumulator = 0;
  private readonly clientTickDuration: number; // milliseconds per client tick
  
  // Performance Tracking
  private frameCount = 0;
  private fpsTimer = 0;
  private currentFPS = 0;
  
  constructor(canvas: HTMLCanvasElement, config: ClientConfig) {
    this.canvas = canvas;
    this.config = config;
    this.clientTickDuration = 1000 / config.prediction.clientTickRate; // e.g., ~8.33ms for 120Hz
    
    console.log(`🎮 Client initialized with ${config.prediction.clientTickRate}Hz tick rate`);
  }
  
  /**
   * Initialize all client systems
   */
  async initialize(): Promise<void> {
    try {
      this.state = ClientState.INITIALIZING;
      console.log('⚡ Initializing client systems...');
      
      // Initialize Camera first (needed by other systems)
      this.camera = new Camera(
        { width: this.canvas.width, height: this.canvas.height },
        { position: Vec2.from(600, 400), zoom: 1.0, rotation: 0 }
      );
      
      // Initialize Graphics System
      this.renderSystem = new RenderSystem(this.canvas, this.config.graphics);
      await this.renderSystem.initialize();
      
      // Initialize Network System
      this.networkManager = new NetworkManager(this.config.network);
      this.networkManager.setWorldStateHandler(this.onServerWorldState.bind(this));
      this.networkManager.setConnectionStateHandler(this.onConnectionStateChanged.bind(this));
      
      // Initialize Prediction Engine
      this.predictionEngine = new PredictionEngine(this.config.prediction);
      
      // Initialize Input System
      this.inputManager = new InputManager(this.canvas, this.config.input);
      this.inputManager.onInputFrame = this.onInputFrame.bind(this);
      
      // HYBRID PROTOCOL: Wire up state change callbacks
      this.inputManager.onMovementStateChange = (movement, isMoving) => {
        this.networkManager.sendMovementState(movement, isMoving);
      };
      this.inputManager.onRotationUpdate = (rotation) => {
        this.networkManager.sendRotationUpdate(rotation);
      };
      this.inputManager.onActionEvent = (action, target) => {
        if (action === 'interact') {
          // Player pressed E - interact with hovered module
          const hoveredModule = this.renderSystem.getHoveredModule();
          
          if (hoveredModule) {
            const playerId = this.networkManager.getAssignedPlayerId();
            if (playerId !== null) {
              // Check if player is close enough to the module
              const worldState = this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
              if (!worldState) return;
              
              const player = worldState.players.find(p => p.id === playerId);
              
              if (player) {
                // Calculate module world position
                const cos = Math.cos(hoveredModule.ship.rotation);
                const sin = Math.sin(hoveredModule.ship.rotation);
                const moduleWorldX = hoveredModule.ship.position.x + 
                  (hoveredModule.module.localPos.x * cos - hoveredModule.module.localPos.y * sin);
                const moduleWorldY = hoveredModule.ship.position.y + 
                  (hoveredModule.module.localPos.x * sin + hoveredModule.module.localPos.y * cos);
                const moduleWorldPos = Vec2.from(moduleWorldX, moduleWorldY);
                
                const distance = player.position.sub(moduleWorldPos).length();
                const maxInteractDistance = 50; // Maximum interaction range
                
                if (distance <= maxInteractDistance) {
                  console.log(`🎯 [INTERACTION] Player interacting with ${hoveredModule.module.kind.toUpperCase()} (ID: ${hoveredModule.module.id}) at distance ${distance.toFixed(1)}px`);
                  this.networkManager.sendModuleInteract(hoveredModule.module.id);
                } else {
                  console.log(`❌ [INTERACTION] ${hoveredModule.module.kind.toUpperCase()} too far: ${distance.toFixed(1)}px > ${maxInteractDistance}px`);
                }
              }
            }
          } else {
            console.log(`⚠️ [INTERACTION] No module hovered - move mouse over a module and press E`);
          }
        } else {
          // Other actions go to server
          this.networkManager.sendAction(action, target);
        }
      };
      
      // Set up mouse tracking for mouse-relative movement
      this.setupMouseTracking();
      
      // Set up debug keyboard shortcuts
      this.setupDebugKeys();
      
      // Initialize UI System
      this.uiManager = new UIManager(this.canvas, this.config);
      
      // Initialize Audio System  
      this.audioManager = new AudioManager(this.config.audio);
      await this.audioManager.initialize();
      
      // Initialize Gameplay Systems
      this.moduleInteractionSystem = new ModuleInteractionSystem();
      
      // Set up module interaction callback to send to server
      this.moduleInteractionSystem.onModuleInteract = (moduleId: number) => {
        this.networkManager.sendModuleInteract(moduleId);
      };
      
      // Set up canvas resize handler
      this.setupCanvasResizeHandler();
      
      console.log('✅ All client systems initialized successfully');
      
    } catch (error) {
      this.state = ClientState.ERROR;
      console.error('❌ Failed to initialize client systems:', error);
      throw error;
    }
  }
  
  /**
   * Start the client application (connect to server and begin game loop)
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('⚠️ Client is already running');
      return;
    }
    
    try {
      console.log('🚀 Starting client application...');
      
      // Try to connect to server, but continue even if it fails
      this.state = ClientState.CONNECTING;
      try {
        await this.networkManager.connect('Player'); // Default player name
        console.log('✅ Connected to physics server');
      } catch (serverError) {
        console.warn('⚠️ Could not connect to physics server:', serverError);
        console.log('🎮 Running in offline mode - UI and local systems will work');
        this.state = ClientState.DISCONNECTED;
        // Create demo world state for offline testing
        this.demoWorldState = this.createDemoWorldState();
        // Continue execution - we can still show UI and test locally
      }
      
      // Start game loop regardless of server connection
      this.running = true;
      this.lastFrameTime = performance.now();
      requestAnimationFrame(this.gameLoop.bind(this));
      
      console.log('✅ Client application started successfully');
      
    } catch (error) {
      this.state = ClientState.ERROR;
      console.error('❌ Failed to start client application:', error);
      throw error;
    }
  }
  
  /**
   * Shutdown the client application gracefully
   */
  shutdown(): void {
    console.log('🛑 Shutting down client application...');
    
    this.running = false;
    this.state = ClientState.DISCONNECTED;
    
    // Shutdown all systems
    this.networkManager?.disconnect();
    this.audioManager?.shutdown();
    this.inputManager?.shutdown();
    this.uiManager?.shutdown();
    this.renderSystem?.shutdown();
    
    console.log('✅ Client application shutdown complete');
  }
  
  /**
   * Main game loop - handles timing, input, prediction, and rendering
   */
  private gameLoop(currentTime: number): void {
    if (!this.running) return;
    
    const deltaTime = currentTime - this.lastFrameTime;
    this.lastFrameTime = currentTime;
    
    // Cap delta time to prevent spiral of death
    const clampedDelta = Math.min(deltaTime, 100); // Max 100ms
    this.accumulator += clampedDelta;
    
    // Update FPS tracking
    this.updateFPSTracking(deltaTime);
    
    // Fixed timestep client updates (prediction, input processing)
    while (this.accumulator >= this.clientTickDuration) {
      this.updateClient(this.clientTickDuration);
      this.accumulator -= this.clientTickDuration;
    }
    
    // Variable timestep updates (UI, audio, etc.)
    this.updateVariableTimestep(clampedDelta);
    
    // Render frame with interpolation
    const alpha = this.accumulator / this.clientTickDuration;
    this.renderFrame(alpha);
    
    // Continue game loop
    requestAnimationFrame(this.gameLoop.bind(this));
  }
  
  /**
   * Fixed timestep client updates (120Hz prediction)
   */
  private updateClient(deltaTime: number): void {
    const dt = deltaTime / 1000; // Convert to seconds
    
    // Update input (collect current input state)
    this.inputManager.update(dt);
    
    // Update prediction engine (client-side simulation)
    if (this.authoritativeWorldState && this.state === ClientState.IN_GAME) {
      this.predictedWorldState = this.predictionEngine.update(
        this.authoritativeWorldState,
        this.inputManager.getCurrentInputFrame(),
        dt
      );
      
      // Update camera based on predicted state
      if (this.predictedWorldState) {
        this.updateCamera(this.predictedWorldState, dt);
        
        // Update input manager with current player position and velocity for hybrid protocol
        const assignedPlayerId = this.networkManager.getAssignedPlayerId();
        const player = assignedPlayerId !== null 
          ? this.predictedWorldState.players.find(p => p.id === assignedPlayerId)
          : this.predictedWorldState.players[0];
        
        if (player) {
          this.inputManager.setPlayerPosition(player.position);
          this.inputManager.setPlayerVelocity(player.velocity); // For stop detection
        }
      }
      
      // Update module interactions
      this.moduleInteractionSystem.update(this.predictedWorldState || this.authoritativeWorldState, dt);
    }
  }
  
  /**
   * Variable timestep updates (UI, audio, particles)
   */
  private updateVariableTimestep(deltaTime: number): void {
    const dt = deltaTime / 1000;
    
    // Update UI system
    this.uiManager.update(dt);
    
    // Update audio system
    this.audioManager.update(dt);
    
    // Update render system (particles, effects)
    this.renderSystem.update(dt);
  }
  
  /**
   * Render a frame with interpolation
   */
  private renderFrame(alpha: number): void {
    // Get interpolated state for smooth rendering of other entities
    const currentTime = performance.now();
    const interpolatedState = this.predictionEngine.getInterpolatedState(currentTime);
    
    // Build hybrid world: predicted local player + interpolated other entities
    const assignedPlayerId = this.networkManager.getAssignedPlayerId();
    let worldToRender = interpolatedState || this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
    
    // If we have both predicted and interpolated states, create hybrid
    if (assignedPlayerId !== null && this.predictedWorldState && interpolatedState) {
      const predictedPlayer = this.predictedWorldState.players.find(p => p.id === assignedPlayerId);
      
      if (predictedPlayer) {
        // Get current rotation from input manager
        const currentRotation = this.inputManager.getCurrentInputFrame().rotation;
        
        // Clone interpolated state and replace our player with predicted version (including rotation)
        worldToRender = {
          ...interpolatedState,
          players: interpolatedState.players.map(p => 
            p.id === assignedPlayerId ? { ...predictedPlayer, rotation: currentRotation } : p
          )
        };
      }
    }
    
    if (!worldToRender) {
      // Render loading/connection screen
      this.renderSystem.renderLoadingScreen(this.state, this.camera);
    } else {
      // Render game world with hybrid state
      this.renderSystem.renderWorld(worldToRender, this.camera, alpha);
      
      // Render UI overlay
      this.uiManager.render(this.renderSystem.getContext(), {
        worldState: worldToRender,
        camera: this.camera,
        fps: this.currentFPS,
        networkStats: this.networkManager.getStats(),
        config: this.config,
        assignedPlayerId: this.networkManager.getAssignedPlayerId()
      });
    }
  }
  
  /**
   * Update camera based on world state
   */
  private updateCamera(worldState: WorldState, dt: number): void {
    // Find our player using the server-assigned player ID
    const assignedPlayerId = this.networkManager.getAssignedPlayerId();
    const player = assignedPlayerId !== null 
      ? worldState.players.find(p => p.id === assignedPlayerId)
      : worldState.players[0]; // Fallback to first player if no ID assigned yet
    
    if (!player) {
      // Only warn if we've received at least one world state (avoid spam during initial connection)
      if (this.hasReceivedWorldState && assignedPlayerId !== null) {
        console.warn(`No player found for camera following (assigned ID: ${assignedPlayerId})`);
      }
      return;
    }
    
    // Smooth camera follow with lerp for grid stability
    // Fast lerp keeps camera responsive while smoothing out prediction jitter
    const currentPos = this.camera.getState().position;
    const lerpFactor = 1.0 - Math.pow(0.001, dt); // Frame-rate independent smoothing
    const smoothedX = currentPos.x + (player.position.x - currentPos.x) * lerpFactor;
    const smoothedY = currentPos.y + (player.position.y - currentPos.y) * lerpFactor;
    
    this.camera.setPosition(Vec2.from(smoothedX, smoothedY));
  }
  
  /**
   * Handle input frame from input manager
   */
  private onInputFrame(inputFrame: InputFrame): void {
    // Send input to server
    this.networkManager.sendInput(inputFrame);
  }
  
  /**
   * Handle authoritative world state from server
   */
  private onServerWorldState(worldState: WorldState): void {
    this.authoritativeWorldState = worldState;
    
    // Mark that we've received at least one world state (suppresses early camera warnings)
    if (!this.hasReceivedWorldState && worldState.players.length > 0) {
      this.hasReceivedWorldState = true;
    }
    
    // Update prediction engine with authoritative state
    this.predictionEngine.onAuthoritativeState(worldState);
    
    // Update game state if we just entered the game
    if (this.state === ClientState.CONNECTED) {
      this.state = ClientState.IN_GAME;
      console.log('🎮 Entered game world');
    }
  }
  
  /**
   * Handle connection state changes
   */
  private onConnectionStateChanged(state: ConnectionState): void {
    if (state === ConnectionState.CONNECTED) {
      this.state = ClientState.CONNECTED;
      console.log('🌐 Connected to server');
    } else if (state === ConnectionState.DISCONNECTED || state === ConnectionState.ERROR) {
      this.state = ClientState.DISCONNECTED;
      console.log('🔌 Disconnected from server:', state);
      
      // TODO: Handle reconnection logic
    } else if (state === ConnectionState.CONNECTING) {
      this.state = ClientState.CONNECTING;
      console.log('🔄 Connecting to server...');
    }
  }
  
  /**
   * Set up mouse tracking for mouse-relative movement
   */
  private setupMouseTracking(): void {
    this.canvas.addEventListener('mousemove', (event) => {
      // Get mouse position in screen coordinates
      const rect = this.canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      
      // Convert screen coordinates to world coordinates using camera
      const worldPos = this.camera.screenToWorld(Vec2.from(screenX, screenY));
      
      // Debug: Log mouse position updates (temporarily)
      
      // Update input manager with mouse world position
      this.inputManager.updateMouseWorldPosition(worldPos);
      
      // Update render system for hover detection
      this.renderSystem.updateMousePosition(worldPos);
    });
    
    console.log('🖱️ Mouse tracking initialized for directional movement');
  }
  
  /**
   * Set up debug keyboard shortcuts
   */
  private setupDebugKeys(): void {
    window.addEventListener('keydown', (e) => {
      // Only handle if not typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      switch (e.key) {
        case 'l':
        case 'L':
          this.renderSystem.toggleHoverBoundaries();
          e.preventDefault();
          break;
      }
    });
    
    console.log('⌨️ Debug keys initialized (L = toggle hover boundaries)');
  }
  
  /**
   * Setup canvas resize handler
   */
  private setupCanvasResizeHandler(): void {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        this.canvas.width = width;
        this.canvas.height = height;
        
        // Update camera viewport
        this.camera.setViewport({ width, height });
        
        // Update render system
        this.renderSystem.onCanvasResize(width, height);
        
        // Update UI system
        this.uiManager.onCanvasResize(width, height);
      }
    });
    
    resizeObserver.observe(this.canvas);
  }
  
  /**
   * Update FPS tracking
   */
  private updateFPSTracking(deltaTime: number): void {
    this.frameCount++;
    this.fpsTimer += deltaTime;
    
    // Update FPS every second
    if (this.fpsTimer >= 1000) {
      this.currentFPS = Math.round((this.frameCount * 1000) / this.fpsTimer);
      this.frameCount = 0;
      this.fpsTimer = 0;
    }
  }
  
  /**
   * Get current client state for debugging
   */
  getState(): ClientState {
    return this.state;
  }
  
  /**
   * Get current configuration
   */
  getConfig(): ClientConfig {
    return this.config;
  }
  
  /**
   * Update configuration (saves to localStorage)
   */
  updateConfig(newConfig: Partial<ClientConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    // Apply config changes to systems
    this.renderSystem.updateConfig(this.config.graphics);
    this.audioManager.updateConfig(this.config.audio);
    this.inputManager.updateConfig(this.config.input);
    
    console.log('⚙️ Client configuration updated');
  }

  /**
   * Create demo world state for offline mode
   */
  private createDemoWorldState(): WorldState {
    return {
      tick: 0,
      timestamp: Date.now(),
      ships: [
        {
          id: 1,
          position: Vec2.from(600, 400), // Center of screen
          velocity: Vec2.zero(),
          rotation: 0,
          angularVelocity: 0,
          hull: [
            Vec2.from(-60, -20),
            Vec2.from(60, -20),
            Vec2.from(60, 20),
            Vec2.from(-60, 20)
          ],
          modules: [
            {
              id: 1,
              kind: 'deck',
              deckId: 0,
              localPos: Vec2.zero(),
              localRot: 0,
              occupiedBy: null,
              stateBits: 0
            },
            {
              id: 2, 
              kind: 'helm',
              deckId: 0,
              localPos: Vec2.from(0, -10),
              localRot: 0,
              occupiedBy: null,
              stateBits: 0
            }
          ],
          // Brigantine physics properties (match server)
          mass: 5000,                    // kg
          momentOfInertia: 500000,       // kg⋅m²
          maxSpeed: 30,                  // m/s
          turnRate: 0.5,                 // rad/s
          waterDrag: 0.98,               // coefficient (0-1)
          angularDrag: 0.95              // coefficient (0-1)
        }
      ],
      players: [
        {
          id: 1,
          position: Vec2.from(600, 400), // Same as ship position
          velocity: Vec2.zero(),
          rotation: 0, // Facing right
          radius: PhysicsConfig.PLAYER_RADIUS,
          carrierId: 1, // On the demo ship
          deckId: 0,
          onDeck: true
        }
      ],
      cannonballs: [],
      carrierDetection: new Map()
    };
  }
}