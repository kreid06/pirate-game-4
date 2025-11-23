/**
 * Brigantine Loadout Tester
 * 
 * Standalone test application for visualizing and testing brigantine loadouts
 * Run this independently without needing server connection
 */

import { Vec2 } from '../common/Vec2.js';
import { WorldState } from '../sim/Types.js';
import { RenderSystem } from '../client/gfx/RenderSystem.js';
import { Camera, Viewport } from '../client/gfx/Camera.js';
import { DEFAULT_CLIENT_CONFIG } from '../client/ClientConfig.js';
import {
  BrigantineTestBuilder,
  BrigantineLoadouts,
  createTestBrigantine,
  BrigantineLoadout
} from './BrigantineTestBuilder.js';

/**
 * Test application for brigantine loadouts
 */
export class BrigantineLoadoutTester {
  private canvas: HTMLCanvasElement;
  private renderSystem: RenderSystem;
  private camera: Camera;
  private builder: BrigantineTestBuilder;
  private currentLoadoutIndex = 0;
  private loadouts: BrigantineLoadout[];
  private worldState: WorldState;
  private uiContainer: HTMLDivElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    
    // Initialize render system
    this.renderSystem = new RenderSystem(canvas, DEFAULT_CLIENT_CONFIG.graphics);
    
    // Initialize camera
    const viewport: Viewport = { width: canvas.width, height: canvas.height };
    this.camera = new Camera(viewport, {
      position: Vec2.zero(),
      zoom: 0.5,
      rotation: 0
    });
    
    this.builder = new BrigantineTestBuilder();
    this.loadouts = BrigantineLoadouts.getAll();
    
    // Initialize world state
    this.worldState = {
      tick: 0,
      timestamp: performance.now(),
      ships: [],
      players: [],
      cannonballs: [],
      carrierDetection: new Map()
    };
    
    // Initialize with combat loadout
    this.loadCurrentLoadout();
    
    // Create UI
    this.uiContainer = this.createUI();
    
    // Setup input
    this.setupInput();
    
    // Start render loop
    this.startRenderLoop();
  }

  /**
   * Load current loadout from index
   */
  private loadCurrentLoadout(): void {
    const loadout = this.loadouts[this.currentLoadoutIndex];
    this.builder.loadLoadout(loadout);
    
    // Create world state with single ship
    const ship = this.builder.build(Vec2.zero(), 0);
    
    this.worldState = {
      tick: 0,
      timestamp: performance.now(),
      ships: [ship],
      players: [],
      cannonballs: [],
      carrierDetection: new Map()
    };
    
    // Reset camera position (no need to follow in test mode)
    const currentState = this.camera.getState();
    this.camera.setPosition(Vec2.zero());
  }

  /**
   * Create UI controls
   */
  private createUI(): HTMLDivElement {
    const container = document.createElement('div');
    container.style.cssText = `
      position: fixed;
      top: 20px;
      left: 20px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 20px;
      border-radius: 8px;
      font-family: monospace;
      z-index: 1000;
      max-width: 400px;
    `;
    
    // Title
    const title = document.createElement('h2');
    title.textContent = 'Brigantine Loadout Tester';
    title.style.marginTop = '0';
    container.appendChild(title);
    
    // Current loadout info
    const loadoutInfo = document.createElement('div');
    loadoutInfo.id = 'loadout-info';
    loadoutInfo.style.marginBottom = '15px';
    container.appendChild(loadoutInfo);
    
    // Navigation buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.style.marginBottom = '15px';
    
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '← Previous';
    prevBtn.onclick = () => this.previousLoadout();
    prevBtn.style.cssText = 'margin-right: 10px; padding: 8px 16px; cursor: pointer;';
    
    const nextBtn = document.createElement('button');
    nextBtn.textContent = 'Next →';
    nextBtn.onclick = () => this.nextLoadout();
    nextBtn.style.cssText = 'padding: 8px 16px; cursor: pointer;';
    
    buttonContainer.appendChild(prevBtn);
    buttonContainer.appendChild(nextBtn);
    container.appendChild(buttonContainer);
    
    // Stats display
    const stats = document.createElement('div');
    stats.id = 'loadout-stats';
    stats.style.cssText = 'font-size: 12px; line-height: 1.5;';
    container.appendChild(stats);
    
    // Controls help
    const help = document.createElement('div');
    help.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #555; font-size: 11px;';
    help.innerHTML = `
      <strong>Controls:</strong><br>
      Arrow Keys: Previous/Next loadout<br>
      Mouse Wheel: Zoom<br>
      Mouse Drag: Pan camera<br>
      R: Reset camera
    `;
    container.appendChild(help);
    
    document.body.appendChild(container);
    this.updateUI();
    
    return container;
  }

  /**
   * Update UI with current loadout info
   */
  private updateUI(): void {
    const loadout = this.loadouts[this.currentLoadoutIndex];
    const stats = this.builder.getStats();
    
    const loadoutInfo = document.getElementById('loadout-info');
    if (loadoutInfo) {
      loadoutInfo.innerHTML = `
        <strong>${loadout.name}</strong> (${this.currentLoadoutIndex + 1}/${this.loadouts.length})<br>
        <span style="color: #aaa;">${loadout.description}</span>
      `;
    }
    
    const statsEl = document.getElementById('loadout-stats');
    if (statsEl) {
      let statsHtml = `<strong>Modules:</strong> ${stats.total} total<br>`;
      
      const typeArray = Array.from(stats.byType.entries())
        .filter(([kind]) => kind !== 'deck' && kind !== 'plank')
        .sort((a, b) => b[1] - a[1]);
      
      for (const [kind, count] of typeArray) {
        statsHtml += `&nbsp;&nbsp;${kind}: ${count}<br>`;
      }
      
      statsEl.innerHTML = statsHtml;
    }
  }

  /**
   * Setup input handlers
   */
  private setupInput(): void {
    // Keyboard
    window.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowLeft':
          this.previousLoadout();
          e.preventDefault();
          break;
        case 'ArrowRight':
          this.nextLoadout();
          e.preventDefault();
          break;
        case 'r':
        case 'R':
          this.camera.setPosition(Vec2.zero());
          this.camera.setZoom(0.5);
          break;
        case 'l':
        case 'L':
          this.renderSystem.toggleHoverBoundaries();
          e.preventDefault();
          break;
      }
    });
    
    // Mouse wheel zoom
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const currentZoom = this.camera.getState().zoom;
      this.camera.setZoom(currentZoom * delta);
    });
    
    // Mouse drag pan
    let isDragging = false;
    let lastMousePos = { x: 0, y: 0 };
    
    this.canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      lastMousePos = { x: e.clientX, y: e.clientY };
    });
    
    window.addEventListener('mousemove', (e) => {
      // Update render system for hover detection
      const rect = this.canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const worldPos = this.camera.screenToWorld(Vec2.from(screenX, screenY));
      this.renderSystem.updateMousePosition(worldPos);
      
      // Handle camera dragging
      if (isDragging) {
        const dx = e.clientX - lastMousePos.x;
        const dy = e.clientY - lastMousePos.y;
        
        const currentState = this.camera.getState();
        const worldDx = -dx / currentState.zoom;
        const worldDy = -dy / currentState.zoom;
        
        this.camera.setPosition(
          Vec2.from(currentState.position.x + worldDx, currentState.position.y + worldDy)
        );
        
        lastMousePos = { x: e.clientX, y: e.clientY };
      }
    });
    
    window.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  /**
   * Go to next loadout
   */
  private nextLoadout(): void {
    this.currentLoadoutIndex = (this.currentLoadoutIndex + 1) % this.loadouts.length;
    this.loadCurrentLoadout();
    this.updateUI();
  }

  /**
   * Go to previous loadout
   */
  private previousLoadout(): void {
    this.currentLoadoutIndex = (this.currentLoadoutIndex - 1 + this.loadouts.length) % this.loadouts.length;
    this.loadCurrentLoadout();
    this.updateUI();
  }

  /**
   * Start render loop
   */
  private startRenderLoop(): void {
    const render = () => {
      this.renderSystem.renderWorld(this.worldState, this.camera, 1.0);
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.uiContainer.parentNode) {
      this.uiContainer.parentNode.removeChild(this.uiContainer);
    }
  }
}

/**
 * Initialize the tester
 */
export function initBrigantineLoadoutTester(): void {
  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%;';
  document.body.appendChild(canvas);
  
  // Handle resize
  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  });
  
  // Create tester
  new BrigantineLoadoutTester(canvas);
  
  console.log('🚢 Brigantine Loadout Tester initialized');
  console.log('Use arrow keys to cycle through loadouts');
}
