/**
 * Simple GameEngine for Local Testing
 * 
 * A minimal game engine that provides basic physics simulation and rendering
 * without complex networking or client architecture dependencies.
 */

import { WorldState, Ship, InputFrame } from '../sim/Types.js';
import { Vec2 } from '../common/Vec2.js';
import { ModuleUtils } from '../sim/modules.js';
import { createCurvedShipHull } from '../sim/ShipUtils.js';
import { simulate } from '../sim/Physics.js';

/**
 * Simple GameEngine for local testing and development
 */
export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private worldState: WorldState;
  private running = false;
  private animationId: number | null = null;
  private lastTime = 0;
  
  // Input state
  private keys = new Set<string>();
  private currentInput: InputFrame = {
    tick: 0,
    movement: Vec2.zero(),
    rotation: 0,
    actions: 0 // Bitmask for actions
  };
  
  // Physics constants
  private readonly FIXED_TIMESTEP = 1000 / 30; // 30 Hz physics
  private accumulator = 0;
  
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D rendering context');
    }
    this.ctx = ctx;
    
    // Initialize with basic world state
    this.worldState = this.createInitialWorld();
    
    // Set up input handling
    this.setupInputHandlers();
    
    console.log('🏴‍☠️ Simple GameEngine initialized for local testing');
  }

  /**
   * Create initial world state for local testing
   */
  private createInitialWorld(): WorldState {
    // Generate curved ship hull
    const shipHull = createCurvedShipHull();
    
    // Create a pirate ship
    const ship: Ship = {
      id: 1,
      position: Vec2.from(600, 400),
      rotation: 0,
      velocity: Vec2.zero(),
      angularVelocity: 0,
      hull: shipHull,
      mass: 5000,
      momentOfInertia: 50000,
      maxSpeed: 10,
      turnRate: 0.5,
      waterDrag: 0.98,
      angularDrag: 0.95,
      modules: [
        // Ship deck (interior floor)
        ModuleUtils.createShipDeckFromPolygon(shipHull, 200),
        
        // Ship planks for hull coverage
        ...ModuleUtils.createShipPlanksFromSegments(100),
        
        // Ship modules
        ModuleUtils.createDefaultModule(1000, 'helm', Vec2.from(-90, 0)),
        ModuleUtils.createDefaultModule(1001, 'mast', Vec2.from(165, 0)),
        ModuleUtils.createDefaultModule(1002, 'mast', Vec2.from(-35, 0)),
        ModuleUtils.createDefaultModule(1003, 'mast', Vec2.from(-235, 0)),
        
        // Cannons
        ModuleUtils.createDefaultModule(1004, 'cannon', Vec2.from(-35, 75)),
        ModuleUtils.createDefaultModule(1005, 'cannon', Vec2.from(65, 75)),
        ModuleUtils.createDefaultModule(1006, 'cannon', Vec2.from(-135, 75)),
        ModuleUtils.createDefaultModule(1007, 'cannon', Vec2.from(-35, -75)),
        ModuleUtils.createDefaultModule(1008, 'cannon', Vec2.from(65, -75)),
        ModuleUtils.createDefaultModule(1009, 'cannon', Vec2.from(-135, -75)),
      ]
    };

    return {
      tick: 0,
      timestamp: Date.now(),
      ships: [ship],
      players: [{
        id: 1,
        position: Vec2.from(600, 400),
        velocity: Vec2.zero(),
        rotation: 0,
        radius: 8,
        onDeck: true,
        carrierId: ship.id,
        deckId: ship.modules[0].id
      }],
      cannonballs: [],
      carrierDetection: new Map()
    };
  }

  /**
   * Set up keyboard input handling
   */
  private setupInputHandlers(): void {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
  }

  /**
   * Update input state based on current key presses
   */
  private updateInput(): void {
    let movement = Vec2.zero();
    
    if (this.keys.has('w') || this.keys.has('arrowup')) {
      movement = movement.add(Vec2.from(0, -1));
    }
    if (this.keys.has('s') || this.keys.has('arrowdown')) {
      movement = movement.add(Vec2.from(0, 1));
    }
    if (this.keys.has('a') || this.keys.has('arrowleft')) {
      movement = movement.add(Vec2.from(-1, 0));
    }
    if (this.keys.has('d') || this.keys.has('arrowright')) {
      movement = movement.add(Vec2.from(1, 0));
    }

    // Normalize diagonal movement
    if (movement.length() > 0) {
      movement = movement.normalize();
    }

    this.currentInput = {
      tick: this.worldState.tick,
      movement,
      rotation: 0,
      actions: 0
    };
  }

  /**
   * Game loop with fixed timestep physics
   */
  private gameLoop = (currentTime: number) => {
    if (!this.running) return;

    const deltaTime = currentTime - this.lastTime;
    this.lastTime = currentTime;
    
    this.accumulator += deltaTime;

    // Run physics at fixed timestep
    while (this.accumulator >= this.FIXED_TIMESTEP) {
      this.updateInput();
      this.worldState = simulate(this.worldState, this.currentInput, this.FIXED_TIMESTEP / 1000);
      this.accumulator -= this.FIXED_TIMESTEP;
    }

    // Render
    this.render();

    this.animationId = requestAnimationFrame(this.gameLoop);
  };

  /**
   * Simple rendering
   */
  private render(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    
    // Clear canvas
    ctx.fillStyle = '#001122';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Simple camera - center on player
    const player = this.worldState.players[0];
    if (player) {
      ctx.save();
      ctx.translate(canvas.width / 2 - player.position.x, canvas.height / 2 - player.position.y);
      
      // Draw ships
      for (const ship of this.worldState.ships) {
        this.drawShip(ship);
      }
      
      // Draw player
      this.drawPlayer(player);
      
      ctx.restore();
    }
    
    // Draw UI
    ctx.fillStyle = 'white';
    ctx.font = '16px Arial';
    ctx.fillText('🏴‍☠️ Pirate Game - Local Test', 10, 30);
    ctx.fillText('WASD to move', 10, 50);
    ctx.fillText(`Tick: ${this.worldState.tick}`, 10, 70);
  }

  /**
   * Draw a ship with basic rendering
   */
  private drawShip(ship: Ship): void {
    const ctx = this.ctx;
    
    ctx.save();
    ctx.translate(ship.position.x, ship.position.y);
    ctx.rotate(ship.rotation);
    
    // Draw hull
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < ship.hull.length; i++) {
      const point = ship.hull[i];
      if (i === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    }
    ctx.closePath();
    ctx.stroke();
    
    // Fill hull
    ctx.fillStyle = '#DEB887';
    ctx.fill();
    
    // Draw modules (simplified - just draw basic shapes)
    for (const module of ship.modules) {
      if (module.kind === 'mast') {
        ctx.fillStyle = '#654321';
        ctx.fillRect(module.localPos.x - 3, module.localPos.y - 20, 6, 40);
      } else if (module.kind === 'cannon') {
        ctx.fillStyle = '#444444';
        ctx.fillRect(module.localPos.x - 8, module.localPos.y - 4, 16, 8);
      } else if (module.kind === 'helm') {
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.arc(module.localPos.x, module.localPos.y, 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    
    ctx.restore();
  }

  /**
   * Draw the player
   */
  private drawPlayer(player: any): void {
    const ctx = this.ctx;
    
    ctx.fillStyle = '#FF6B6B';
    ctx.beginPath();
    ctx.arc(player.position.x, player.position.y, player.radius, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /**
   * Start the game engine
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('⚠️ GameEngine already running');
      return;
    }

    try {
      console.log('🚀 Starting simple GameEngine...');
      
      this.running = true;
      this.lastTime = performance.now();
      this.animationId = requestAnimationFrame(this.gameLoop);
      
      console.log('✅ GameEngine started successfully');
      console.log('Use WASD keys to move the player');
      
    } catch (error) {
      console.error('❌ Failed to start GameEngine:', error);
      throw error;
    }
  }

  /**
   * Stop the game engine
   */
  shutdown(): void {
    if (!this.running) {
      console.warn('⚠️ GameEngine not running');
      return;
    }

    try {
      console.log('🛑 Stopping GameEngine...');
      
      this.running = false;
      if (this.animationId !== null) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
      
      console.log('✅ GameEngine stopped successfully');
      
    } catch (error) {
      console.error('❌ Failed to stop GameEngine:', error);
      throw error;
    }
  }

  /**
   * Get current world state
   */
  getWorldState(): WorldState {
    return this.worldState;
  }

  /**
   * Get running status
   */
  isRunning(): boolean {
    return this.running;
  }
}

export default GameEngine;