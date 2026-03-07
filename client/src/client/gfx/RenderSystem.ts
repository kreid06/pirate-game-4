/**
 * Main Rendering System
 * 
 * Centralized rendering system that handles all visual output.
 * Separated from game logic for clean architecture.
 */

import { GraphicsConfig } from '../ClientConfig.js';
import { Camera } from './Camera.js';
import { ParticleSystem } from './ParticleSystem.js';
import { EffectRenderer } from './EffectRenderer.js';
import { WorldState, Ship, Player, Cannonball, Npc, NPC_STATE_MOVING } from '../../sim/Types.js';
import { ShipModule, createCompleteHullSegments, PlankSegment } from '../../sim/modules.js';
import { Vec2 } from '../../common/Vec2.js';
import { ClientState } from '../ClientApplication.js';

/** NPC fill colours keyed by assigned task name (matches ManningPriorityPanel task colours). */
const NPC_TASK_COLORS: Record<string, string> = {
  Sails:   '#5aafff',
  Cannons: '#ffaa44',
  Repairs: '#55dd66',
  Combat:  '#ff5555',
  Idle:    '#DAA520',
};

/**
 * Render queue item for layered rendering
 */
interface RenderQueueItem {
  layer: number;
  layerName: string;
  renderFn: () => void;
  priority?: number;
}

/**
 * Main rendering system
 */
export class RenderSystem {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GraphicsConfig;
  
  // Sub-systems
  private particleSystem: ParticleSystem;
  private effectRenderer: EffectRenderer;
  
  // Render queue for layered rendering
  private renderQueue: RenderQueueItem[] = [];
  
  // Hover state
  private mouseWorldPos: Vec2 | null = null;
  private hoveredModule: { ship: Ship; module: any } | null = null;

  // Build mode state
  private buildMode: boolean = false;
  /** Set by ClientApplication each frame — true when the local player is holding right-mouse. */
  public playerIsAiming: boolean = false;
  /** The assigned local player ID, so guides only draw for that player's cannon. */
  public localPlayerId: number | null = null;
  /** Current aim angle relative to ship (from InputManager), used for cannon sector filtering. */
  public playerAimAngleRelative: number = 0;
  /** npcId → task name map set each frame by ClientApplication; used to colour NPCs by task. */
  public npcTaskMap: ReadonlyMap<number, string> = new Map();
  private hoveredPlankSlot: { ship: Ship; sectionName: string; segmentIndex: number } | null = null;
  private plankTemplate: PlankSegment[] | null = null;
  
  // Debug flags
  private showHoverBoundaries: boolean = false;
  
  constructor(canvas: HTMLCanvasElement, config: GraphicsConfig) {
    this.canvas = canvas;
    this.config = config;
    
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = context;
    
    // Initialize sub-systems
    this.particleSystem = new ParticleSystem(this.ctx);
    this.effectRenderer = new EffectRenderer(this.ctx);
  }
  
  /**
   * Initialize the render system
   */
  async initialize(): Promise<void> {
    console.log('🎨 Initializing render system...');
    
    // Set up canvas properties
    this.setupCanvasProperties();
    
    // Initialize sub-systems
    await this.particleSystem.initialize();
    await this.effectRenderer.initialize();
    
    console.log('✅ Render system initialized');
  }
  
  /**
   * Spawn a floating damage number at a world position
   */
  spawnDamageNumber(worldPos: Vec2, damage: number, isKill: boolean = false): void {
    this.effectRenderer.createDamageNumber(worldPos, damage, isKill);
  }

  /**
   * Update render system (particles, effects, etc.)
   */
  update(deltaTime: number): void {
    this.particleSystem.update(deltaTime);
    this.effectRenderer.update(deltaTime);
  }
  
  /**
   * Update mouse position for hover detection
   */
  updateMousePosition(worldPos: Vec2): void {
    this.mouseWorldPos = worldPos;
  }
  
  /**
   * Enable or disable plank build mode
   */
  setBuildMode(active: boolean): void {
    this.buildMode = active;
    if (!active) this.hoveredPlankSlot = null;
  }

  /**
   * Whether build mode is currently active
   */
  isInBuildMode(): boolean {
    return this.buildMode;
  }

  /**
   * Get the plank slot currently under the cursor (only in build mode)
   */
  getHoveredPlankSlot(): { ship: Ship; sectionName: string; segmentIndex: number } | null {
    return this.hoveredPlankSlot;
  }

  /**
   * Lazily build the static plank slot template (all 10 hull segments)
   */
  private getPlankTemplate(): PlankSegment[] {
    if (!this.plankTemplate) {
      this.plankTemplate = createCompleteHullSegments(10);
    }
    return this.plankTemplate;
  }

  /**
   * Detect which missing plank slot (if any) the cursor is over
   */
  private detectHoveredPlankSlot(worldState: WorldState): void {
    this.hoveredPlankSlot = null;
    if (!this.mouseWorldPos) return;

    const template = this.getPlankTemplate();

    for (const ship of worldState.ships) {
      // Collect all present plank slots
      const presentKeys = new Set<string>();
      for (const mod of ship.modules) {
        if (mod.kind === 'plank' && mod.moduleData?.kind === 'plank') {
          presentKeys.add(`${mod.moduleData.sectionName}_${mod.moduleData.segmentIndex}`);
        }
      }

      // Transform mouse to ship-local space
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      for (const seg of template) {
        if (presentKeys.has(`${seg.sectionName}_${seg.index}`)) continue;

        let hit = false;
        if (seg.isCurved && seg.curveStart && seg.curveControl && seg.curveEnd && seg.t1 !== undefined && seg.t2 !== undefined) {
          hit = this.isPointInCurvedPlank(localX, localY, {
            start: seg.curveStart,
            control: seg.curveControl,
            end: seg.curveEnd,
            t1: seg.t1,
            t2: seg.t2
          }, seg.thickness);
        } else {
          // Straight plank rect test
          const cx = (seg.start.x + seg.end.x) / 2;
          const cy = (seg.start.y + seg.end.y) / 2;
          const ddx = seg.end.x - seg.start.x;
          const ddy = seg.end.y - seg.start.y;
          const len = Math.sqrt(ddx * ddx + ddy * ddy);
          const ang = Math.atan2(ddy, ddx);
          const sdx = localX - cx;
          const sdy = localY - cy;
          const sc = Math.cos(-ang);
          const ss = Math.sin(-ang);
          const sx = sdx * sc - sdy * ss;
          const sy = sdx * ss + sdy * sc;
          hit = Math.abs(sx) <= len / 2 + 5 && Math.abs(sy) <= seg.thickness / 2 + 5;
        }

        if (hit) {
          this.hoveredPlankSlot = { ship, sectionName: seg.sectionName, segmentIndex: seg.index };
          return;
        }
      }
    }
  }

  /**
   * Toggle hover boundary debug visualization
   */
  toggleHoverBoundaries(): void {
    this.showHoverBoundaries = !this.showHoverBoundaries;
    console.log(`🔍 Hover boundaries debug: ${this.showHoverBoundaries ? 'ON' : 'OFF'}`);
  }
  
  /**
   * Get the currently hovered module (if any)
   */
  getHoveredModule(): { ship: Ship; module: ShipModule } | null {
    return this.hoveredModule;
  }
  
  /**
   * Detect which module is under the mouse cursor
   */
  private detectHoveredModule(worldState: WorldState): void {
    this.hoveredModule = null;
    
    if (!this.mouseWorldPos) return;
    
    // Check all ships
    for (const ship of worldState.ships) {
      // Transform mouse to ship-local coordinates
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      
      // Check each module
      for (const module of ship.modules) {
        if (!module.moduleData) continue;
        
        const moduleData = module.moduleData;
        
        // Special handling for curved planks
        if (moduleData.kind === 'plank' && moduleData.isCurved && moduleData.curveData) {
          // Check if mouse is within curved plank boundary
          if (this.isPointInCurvedPlank(localX, localY, moduleData.curveData, moduleData.width)) {
            this.hoveredModule = { ship, module };
            return; // Found a match, stop searching
          }
          continue; // Skip regular rectangle check for curved planks
        }
        
        // Regular rectangle check for straight modules
        let width = 20;
        let height = 20;
        
        if (moduleData.kind === 'plank') {
          width = moduleData.length || 20;
          height = moduleData.width || 10;
        } else if (moduleData.kind === 'cannon') {
          width = 30;
          height = 20;
        } else if (moduleData.kind === 'mast') {
          // Masts are circles, so use radius for both width and height
          const radius = moduleData.radius || 15;
          width = radius * 2;
          height = radius * 2;
        }
        
        // Check if mouse is within module bounds (simple rectangle check)
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        
        // Transform to module-local coordinates
        const mdx = localX - module.localPos.x;
        const mdy = localY - module.localPos.y;
        const mcos = Math.cos(-module.localRot);
        const msin = Math.sin(-module.localRot);
        const modLocalX = mdx * mcos - mdy * msin;
        const modLocalY = mdx * msin + mdy * mcos;
        
        if (Math.abs(modLocalX) <= halfWidth && Math.abs(modLocalY) <= halfHeight) {
          this.hoveredModule = { ship, module };
          return; // Found a match, stop searching
        }
      }
    }
  }
  
  /**
   * Check if a point (in ship-local coordinates) is inside a curved plank
   */
  private isPointInCurvedPlank(
    localX: number, 
    localY: number, 
    curveData: { start: any; control: any; end: any; t1: number; t2: number },
    plankWidth: number
  ): boolean {
    const { start, control, end, t1, t2 } = curveData;
    const halfWidth = plankWidth / 2;
    
    // Sample the curve to find the closest point
    const samples = 20;
    let minDistance = Infinity;
    let closestT = 0;
    
    for (let i = 0; i <= samples; i++) {
      const t = t1 + (t2 - t1) * (i / samples);
      const pt = this.getQuadraticPoint(start, control, end, t);
      const dist = Math.sqrt((pt.x - localX) ** 2 + (pt.y - localY) ** 2);
      
      if (dist < minDistance) {
        minDistance = dist;
        closestT = t;
      }
    }
    
    // Get the point on the curve at closestT
    const curvePoint = this.getQuadraticPoint(start, control, end, closestT);
    
    // Calculate the tangent at this point to get perpendicular direction
    const delta = 0.01;
    const t1Point = this.getQuadraticPoint(start, control, end, Math.max(t1, closestT - delta));
    const t2Point = this.getQuadraticPoint(start, control, end, Math.min(t2, closestT + delta));
    
    const tangentX = t2Point.x - t1Point.x;
    const tangentY = t2Point.y - t1Point.y;
    const tangentLen = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
    
    if (tangentLen === 0) return false;
    
    // Normalized tangent
    const tx = tangentX / tangentLen;
    const ty = tangentY / tangentLen;
    
    // Perpendicular (normal) to the curve
    const nx = -ty;
    const ny = tx;
    
    // Vector from curve point to mouse
    const toMouseX = localX - curvePoint.x;
    const toMouseY = localY - curvePoint.y;
    
    // Project onto perpendicular to get distance from curve centerline
    const perpDist = Math.abs(toMouseX * nx + toMouseY * ny);
    
    // Also check distance along the curve
    const alongDist = toMouseX * tx + toMouseY * ty;
    
    // Check if within plank width and reasonably close along curve
    return perpDist <= halfWidth && minDistance < plankWidth * 2;
  }
  
  /**
   * Render the game world
   */
  renderWorld(worldState: WorldState, camera: Camera, interpolationAlpha: number): void {
    // Clear canvas
    this.clearCanvas();
    
    // Detect hovered module
    this.detectHoveredModule(worldState);

    // In build mode, detect which missing plank slot is under the cursor
    if (this.buildMode) {
      this.detectHoveredPlankSlot(worldState);
    } else {
      this.hoveredPlankSlot = null;
    }

    // Draw background elements
    this.drawWater(camera);
    this.drawGrid(camera);
    
    // Queue all game objects for layered rendering
    this.queueWorldObjects(worldState, camera, interpolationAlpha);
    
    // Execute render queue in layer order
    this.executeRenderQueue();
    
    // Draw effects and particles (always on top)
    this.particleSystem.render(camera);
    this.effectRenderer.render(camera);
    
    // Draw hover boundaries debug if enabled
    if (this.showHoverBoundaries) {
      this.drawHoverBoundariesDebug(worldState, camera);
    }
    
    // Draw hover tooltip (screen space, on top of everything)
    this.drawHoverTooltip(camera);
  }
  
  /**
   * Render loading/connection screen
   */
  renderLoadingScreen(clientState: ClientState, camera: Camera): void {
    this.clearCanvas();
    
    // Draw simple background
    this.ctx.fillStyle = '#1e90ff'; // Ocean blue
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Draw loading message
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '48px Arial';
    this.ctx.textAlign = 'center';
    
    let message = 'Loading...';
    switch (clientState) {
      case ClientState.INITIALIZING:
        message = 'Initializing Game...';
        break;
      case ClientState.CONNECTING:
        message = 'Connecting to Server...';
        break;
      case ClientState.CONNECTED:
        message = 'Entering World...';
        break;
      case ClientState.DISCONNECTED:
        message = 'Disconnected - Reconnecting...';
        break;
      case ClientState.ERROR:
        message = 'Connection Error';
        this.ctx.fillStyle = '#ff4444';
        break;
    }
    
    this.ctx.fillText(message, this.canvas.width / 2, this.canvas.height / 2);
    
    // Draw loading spinner
    if (clientState !== ClientState.ERROR) {
      this.drawLoadingSpinner();
    }
  }
  
  /**
   * Get rendering context for UI system
   */
  getContext(): CanvasRenderingContext2D {
    return this.ctx;
  }
  
  /**
   * Handle canvas resize
   */
  onCanvasResize(width: number, height: number): void {
    // Canvas size is handled by the main application
    // No need to update patterns since we're using solid color
  }
  
  /**
   * Update graphics configuration
   */
  updateConfig(newConfig: GraphicsConfig): void {
    this.config = { ...newConfig };
    this.setupCanvasProperties();
    this.particleSystem.updateQuality(newConfig.particleQuality);
  }
  
  /**
   * Shutdown the render system
   */
  shutdown(): void {
    // Clean up any resources
    this.particleSystem.shutdown();
    this.effectRenderer.shutdown();
  }
  
  // Private rendering methods
  
  private setupCanvasProperties(): void {
    // Set up rendering properties based on config
    if (this.config.antialiasing) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    } else {
      this.ctx.imageSmoothingEnabled = false;
    }
  }
  
  private clearCanvas(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  
  private drawWater(camera: Camera): void {
    // Simple solid water color
    this.ctx.fillStyle = '#1e90ff'; // Ocean blue
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
  
  private drawGrid(camera: Camera): void {
    const cameraState = camera.getState();
    const bounds = camera.getWorldBounds();
    
    this.ctx.strokeStyle = '#ffffff20';
    this.ctx.lineWidth = 1;
    
    const gridSize = 100; // World units
    const startX = Math.floor(bounds.min.x / gridSize) * gridSize;
    const endX = Math.ceil(bounds.max.x / gridSize) * gridSize;
    const startY = Math.floor(bounds.min.y / gridSize) * gridSize;
    const endY = Math.ceil(bounds.max.y / gridSize) * gridSize;
    
    // Draw vertical lines
    for (let x = startX; x <= endX; x += gridSize) {
      const screenStart = camera.worldToScreen(Vec2.from(x, bounds.min.y));
      const screenEnd = camera.worldToScreen(Vec2.from(x, bounds.max.y));
      
      this.ctx.beginPath();
      this.ctx.moveTo(screenStart.x, screenStart.y);
      this.ctx.lineTo(screenEnd.x, screenEnd.y);
      this.ctx.stroke();
    }
    
    // Draw horizontal lines
    for (let y = startY; y <= endY; y += gridSize) {
      const screenStart = camera.worldToScreen(Vec2.from(bounds.min.x, y));
      const screenEnd = camera.worldToScreen(Vec2.from(bounds.max.x, y));
      
      this.ctx.beginPath();
      this.ctx.moveTo(screenStart.x, screenStart.y);
      this.ctx.lineTo(screenEnd.x, screenEnd.y);
      this.ctx.stroke();
    }
  }
  
  private queueWorldObjects(worldState: WorldState, camera: Camera, alpha: number): void {
    // Clear render queue
    this.renderQueue = [];
    
    // Render order (from lowest to highest):
    // 0: water, gridlines (drawn before this queue)
    // 1: ship hull
    // 2: players
    // 3: ship planks
    // 4: cannons
    // 5: steering wheels
    // 6: sail fibers
    // 7: sail masts
    
    // Queue ship hulls (layer 1)
    for (const ship of worldState.ships) {
      this.queueRenderItem(1, 'ship-hull', () => this.drawShipHull(ship, camera));
    }
    
    // Queue players (layer 2)
    for (const player of worldState.players) {
      this.queueRenderItem(2, 'players', () => this.drawPlayer(player, worldState, camera));
    }
    
    // Queue ship planks (layer 3)
    for (const ship of worldState.ships) {
      this.queueRenderItem(3, 'ship-planks', () => this.drawShipPlanks(ship, camera));
    }

    // In build mode, overlay missing plank ghost shapes (layer 3, priority 1 = after real planks)
    if (this.buildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(3, 'plank-ghosts', () => this.drawMissingPlankGhosts(ship, camera), 1);
      }
    }
    
    // Queue cannons and steering wheels (layers 4-5)
    for (const ship of worldState.ships) {
      this.queueRenderItem(4, 'cannons', () => this.drawShipCannons(ship, camera));
      this.queueRenderItem(4, 'cannon-aim-guides', () => this.drawCannonAimGuides(ship, worldState, camera), 1);
      this.queueRenderItem(4, 'rudder', () => this.drawShipRudder(ship, camera));
      this.queueRenderItem(5, 'steering-wheels', () => this.drawShipSteeringWheels(ship, camera));
      this.queueRenderItem(5, 'ladders', () => this.drawShipLadders(ship, camera));
      this.queueRenderItem(5, 'sail-ropes', () => this.drawShipSailRopes(ship, camera));
    }
    
    // Queue sail fibers (layer 6)
    for (const ship of worldState.ships) {
      this.queueRenderItem(6, 'sail-fibers', () => this.drawShipSailFibers(ship, camera));
    }
    
    // Queue sail masts (layer 7)
    for (const ship of worldState.ships) {
      this.queueRenderItem(7, 'sail-masts', () => this.drawShipSailMasts(ship, camera));
    }
    
    // Queue cannonballs (layer 8 - on top of everything)  
    for (const cannonball of worldState.cannonballs) {
      this.queueRenderItem(8, 'cannonballs', () => this.drawCannonball(cannonball, camera));
    }

    // Queue NPCs (layer 2 - same as players)
    for (const npc of (worldState.npcs || [])) {
      this.queueRenderItem(2, 'npcs', () => this.drawNpc(npc, worldState, camera));
    }

    // Queue ship ammo labels (layer 9 - HUD overlay above all ship elements)
    for (const ship of worldState.ships) {
      this.queueRenderItem(9, 'ship-ammo-hud', () => this.drawShipAmmoLabel(ship, camera));
    }
  }
  
  private queueRenderItem(layer: number, layerName: string, renderFn: () => void, priority: number = 0): void {
    this.renderQueue.push({
      layer,
      layerName,
      renderFn,
      priority
    });
  }
  
  private executeRenderQueue(): void {
    // Sort by layer, then by priority
    this.renderQueue.sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return (a.priority || 0) - (b.priority || 0);
    });
    
    // Execute all render functions
    for (const item of this.renderQueue) {
      try {
        item.renderFn();
      } catch (error) {
        console.error(`Error rendering ${item.layerName}:`, error);
      }
    }
  }
  
  private drawShipHull(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    if (ship.hull.length === 0) return;
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    this.ctx.strokeStyle = '#8B4513'; // Brown
    this.ctx.fillStyle = '#DEB887'; // BurlyWood
    this.ctx.lineWidth = 2 / cameraState.zoom;
    
    this.ctx.beginPath();
    this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    
    for (let i = 1; i < ship.hull.length; i++) {
      this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    }
    
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    
    // Draw ship direction indicator
    this.ctx.strokeStyle = '#ff0000';
    this.ctx.lineWidth = 4 / cameraState.zoom;
    this.ctx.beginPath();
    this.ctx.moveTo(0, 0);
    this.ctx.lineTo(80, 0);
    this.ctx.stroke();
    
    this.ctx.restore();
  }
  
  private drawShipPlanks(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    // Find all plank modules
    const planks = ship.modules.filter(m => m.kind === 'plank');
    
    for (const plank of planks) {
      if (!plank.moduleData || plank.moduleData.kind !== 'plank') continue;
      
      const plankData = plank.moduleData;
      const pos = plank.localPos;
      const rot = plank.localRot;
      const length = plankData.length;
      const width = plankData.width;
      const health = plankData.health;
      const isCurved = plankData.isCurved || false;
      
      // Skip completely destroyed planks
      if (health <= 0) continue;
      
      // Color based on health
      const healthRatio = health / 100;
      let fillColor: string;
      let strokeColor: string;
      
      if (healthRatio > 0.66) {
        fillColor = '#8B7355'; // Healthy brown
        strokeColor = '#654321';
      } else if (healthRatio > 0.33) {
        fillColor = '#A0826D'; // Damaged (lighter)
        strokeColor = '#8B4513';
      } else {
        fillColor = '#B8956A'; // Critical (very light)
        strokeColor = '#A0826D';
      }
      
      this.ctx.fillStyle = fillColor;
      this.ctx.strokeStyle = strokeColor;
      this.ctx.lineWidth = 1;
      
      if (isCurved && plankData.curveData) {
        // For curved planks, draw directly in ship-local coordinates
        // The curve shape already defines the correct position and orientation
        this.ctx.save();
        this.drawCurvedPlank(plankData.curveData, width, fillColor, strokeColor);
        this.ctx.restore();
      } else {
        // For straight planks, use position and rotation
        this.ctx.save();
        this.ctx.translate(pos.x, pos.y);
        this.ctx.rotate(rot);
        
        const halfLength = length / 2;
        const halfWidth = width / 2;
        
        this.ctx.fillRect(-halfLength, -halfWidth, length, width);
        this.ctx.strokeRect(-halfLength, -halfWidth, length, width);
        
        // Add wood grain effect (parallel lines)
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = 0.5;
        this.ctx.globalAlpha = 0.3;
        
        const grainCount = Math.floor(length / 10);
        for (let i = 1; i < grainCount; i++) {
          const x = -halfLength + (i * length / grainCount);
          this.ctx.beginPath();
          this.ctx.moveTo(x, -halfWidth);
          this.ctx.lineTo(x, halfWidth);
          this.ctx.stroke();
        }
        
        this.ctx.globalAlpha = 1.0;
        this.ctx.restore();
      }
    }
    
    this.ctx.restore();
  }

  /**
   * Draw green ghost shapes for all missing plank slots — build mode overlay.
   * A brighter ghost is shown for the slot currently under the cursor.
   */
  private drawMissingPlankGhosts(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    // Build set of present plank slot keys
    const presentKeys = new Set<string>();
    for (const mod of ship.modules) {
      if (mod.kind === 'plank' && mod.moduleData?.kind === 'plank') {
        presentKeys.add(`${mod.moduleData.sectionName}_${mod.moduleData.segmentIndex}`);
      }
    }

    const template = this.getPlankTemplate();
    const missing = template.filter(seg => !presentKeys.has(`${seg.sectionName}_${seg.index}`));
    if (missing.length === 0) return;

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    for (const seg of missing) {
      const isHovered =
        this.hoveredPlankSlot?.ship === ship &&
        this.hoveredPlankSlot?.sectionName === seg.sectionName &&
        this.hoveredPlankSlot?.segmentIndex === seg.index;

      const fillColor  = isHovered ? 'rgba(0, 230, 80, 0.70)' : 'rgba(0, 180, 60, 0.35)';
      const strokeColor = isHovered ? '#00ff55' : '#00cc44';
      const lineWidth  = isHovered ? 2.5 : 1.5;

      this.ctx.fillStyle   = fillColor;
      this.ctx.strokeStyle = strokeColor;
      this.ctx.lineWidth   = lineWidth;

      if (
        seg.isCurved &&
        seg.curveStart && seg.curveControl && seg.curveEnd &&
        seg.t1 !== undefined && seg.t2 !== undefined
      ) {
        this.ctx.save();
        this.drawCurvedPlank(
          { start: seg.curveStart, control: seg.curveControl, end: seg.curveEnd, t1: seg.t1, t2: seg.t2 },
          seg.thickness,
          fillColor,
          strokeColor
        );
        this.ctx.restore();

        // Hovered: add a pulsing bright inner highlight
        if (isHovered) {
          this.ctx.save();
          this.ctx.globalAlpha = 0.35;
          this.drawCurvedPlank(
            { start: seg.curveStart, control: seg.curveControl, end: seg.curveEnd, t1: seg.t1, t2: seg.t2 },
            seg.thickness * 0.5,
            '#aaffcc',
            'transparent'
          );
          this.ctx.globalAlpha = 1.0;
          this.ctx.restore();
        }
      } else {
        const cx  = (seg.start.x + seg.end.x) / 2;
        const cy  = (seg.start.y + seg.end.y) / 2;
        const ddx = seg.end.x - seg.start.x;
        const ddy = seg.end.y - seg.start.y;
        const len = Math.sqrt(ddx * ddx + ddy * ddy);
        const ang = Math.atan2(ddy, ddx);
        const halfLen   = len / 2;
        const halfThick = seg.thickness / 2;

        this.ctx.save();
        this.ctx.translate(cx, cy);
        this.ctx.rotate(ang);
        this.ctx.fillRect(-halfLen, -halfThick, len, seg.thickness);
        this.ctx.strokeRect(-halfLen, -halfThick, len, seg.thickness);

        if (isHovered) {
          this.ctx.globalAlpha = 0.35;
          this.ctx.fillStyle = '#aaffcc';
          this.ctx.fillRect(-halfLen, -halfThick * 0.5, len, seg.thickness * 0.5);
          this.ctx.globalAlpha = 1.0;
        }

        this.ctx.restore();
      }
    }

    this.ctx.restore();
  }

  private drawCurvedPlank(
    curveData: { start: any; control: any; end: any; t1: number; t2: number },
    width: number,
    fillColor: string,
    strokeColor: string
  ): void {
    const { start, control, end, t1, t2 } = curveData;
    const halfWidth = width / 2;
    
    // Sample points along the curve segment
    const segments = 10; // Number of subdivisions for smooth curve
    const points: Array<{x: number, y: number}> = [];
    
    for (let i = 0; i <= segments; i++) {
      const t = t1 + (t2 - t1) * (i / segments);
      const pt = this.getQuadraticPoint(start, control, end, t);
      points.push(pt);
    }
    
    // Points are already in ship-local coordinates, no transformation needed
    
    // Calculate perpendicular offsets for the plank width
    const innerPoints: Array<{x: number, y: number}> = [];
    const outerPoints: Array<{x: number, y: number}> = [];
    
    for (let i = 0; i < points.length; i++) {
      const curr = points[i];
      let tangent;
      
      if (i === 0) {
        tangent = { x: points[1].x - curr.x, y: points[1].y - curr.y };
      } else if (i === points.length - 1) {
        tangent = { x: curr.x - points[i-1].x, y: curr.y - points[i-1].y };
      } else {
        tangent = { x: points[i+1].x - points[i-1].x, y: points[i+1].y - points[i-1].y };
      }
      
      const len = Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y);
      tangent.x /= len;
      tangent.y /= len;
      
      // Perpendicular vector (rotated 90 degrees)
      const perp = { x: -tangent.y, y: tangent.x };
      
      innerPoints.push({
        x: curr.x + perp.x * halfWidth,
        y: curr.y + perp.y * halfWidth
      });
      outerPoints.push({
        x: curr.x - perp.x * halfWidth,
        y: curr.y - perp.y * halfWidth
      });
    }
    
    // Draw filled curved plank
    this.ctx.beginPath();
    this.ctx.moveTo(innerPoints[0].x, innerPoints[0].y);
    for (let i = 1; i < innerPoints.length; i++) {
      this.ctx.lineTo(innerPoints[i].x, innerPoints[i].y);
    }
    for (let i = outerPoints.length - 1; i >= 0; i--) {
      this.ctx.lineTo(outerPoints[i].x, outerPoints[i].y);
    }
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
  }
  
  private getQuadraticPoint(
    p0: {x: number, y: number},
    p1: {x: number, y: number},
    p2: {x: number, y: number},
    t: number
  ): {x: number, y: number} {
    const x = Math.pow(1-t, 2) * p0.x + 2 * (1-t) * t * p1.x + Math.pow(t, 2) * p2.x;
    const y = Math.pow(1-t, 2) * p0.y + 2 * (1-t) * t * p1.y + Math.pow(t, 2) * p2.y;
    return { x, y };
  }
  
  private drawShipCannons(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    // Find all cannon modules
    const cannons = ship.modules.filter(m => m.kind === 'cannon');
    
    for (const cannon of cannons) {
      if (!cannon.moduleData || cannon.moduleData.kind !== 'cannon') continue;
      
      const cannonData = cannon.moduleData;
      const x = cannon.localPos.x;
      const y = cannon.localPos.y;
      const turretAngle = cannonData.aimDirection || 0; // Cannon aim direction in radians
      const localRot = cannon.localRot || 0; // Module rotation
      
      // Save context for this cannon
      this.ctx.save();
      
      // Move to cannon position and apply module rotation
      this.ctx.translate(x, y);
      this.ctx.rotate(localRot);
      
      const lineWidth = 1 / cameraState.zoom;
      
      // Draw cannon base (doesn't rotate with turret)
      this.ctx.fillStyle = '#8B4513';
      this.ctx.strokeStyle = '#000000';
      this.ctx.lineWidth = lineWidth;
      this.ctx.fillRect(-15, -10, 30, 20);
      this.ctx.strokeRect(-15, -10, 30, 20);

   
      // Save context to apply turret rotation
      this.ctx.save();
      
      // Move to the pivot point (center of the cannon base)
      this.ctx.translate(0, 0); // Pivot point at center of cannon base
      
      // Rotate by turretAngle
      this.ctx.rotate(turretAngle);
      
      // Draw cannon turret (barrel) - now relative to the pivot point
      this.ctx.fillStyle = '#333333';
      this.ctx.strokeStyle = '#000000';
      this.ctx.lineWidth = lineWidth;
      this.ctx.beginPath();
      this.ctx.moveTo(-8, 0);    // Start at pivot point (center of base)
      this.ctx.lineTo(-8, -40);  // Extend forward
      this.ctx.lineTo(8, -40);   // Barrel width
      this.ctx.lineTo(8, 0);     // Back to pivot point
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.stroke();
      
      // Restore turret rotation
      this.ctx.restore();
      
      // Restore cannon position
      this.ctx.restore();
    }
    
    this.ctx.restore();
  }
  
  /**
   * Draw trajectory aim guides for cannons that are currently being manned.
   * A dashed line fans out from the barrel tip in the fire direction, with
   * range-brackets at 1/3 and 2/3 of fireRange and a terminal impact cross.
   */
  /**
   * Ray–convex-polygon intersection in world space using the target ship's hull polygon.
   * Returns the smallest t ≥ 0 where the ray hits any edge of `hull` (in ship-local coords),
   * or Infinity when the ray misses entirely within [0, maxT].
   *
   * The ray is specified in world space; the hull polygon is in ship-local space and
   * is transformed back with (shipX, shipY, shipRot).
   */
  private rayHullIntersect(
    rox: number, roy: number,   // ray origin (world)
    rdx: number, rdy: number,   // ray direction (world, unit-ish, magnitude = range units)
    hull: { x: number; y: number }[],
    shipX: number, shipY: number, shipRot: number,
    maxT: number
  ): number {
    if (hull.length < 3) return Infinity;

    // Transform the ray origin and direction into ship-local space
    const dx = rox - shipX;
    const dy = roy - shipY;
    const cosR = Math.cos(-shipRot);
    const sinR = Math.sin(-shipRot);
    const lox = dx * cosR - dy * sinR;
    const loy = dx * sinR + dy * cosR;
    const ldx = rdx * cosR - rdy * sinR;
    const ldy = rdx * sinR + rdy * cosR;

    let tMin = Infinity;
    const n = hull.length;
    for (let i = 0; i < n; i++) {
      const ax = hull[i].x,       ay = hull[i].y;
      const bx = hull[(i + 1) % n].x, by = hull[(i + 1) % n].y;
      const ex = bx - ax,  ey = by - ay;

      // Cramer's rule: lox + t*ldx = ax + s*ex,  loy + t*ldy = ay + s*ey
      const denom = ldx * ey - ldy * ex;
      if (Math.abs(denom) < 1e-10) continue; // parallel

      const t = ((ax - lox) * ey - (ay - loy) * ex) / denom;
      const s = ((ax - lox) * ldy - (ay - loy) * ldx) / denom;
      if (t >= 0 && t <= maxT && s >= 0 && s <= 1) {
        if (t < tMin) tMin = t;
      }
    }
    return tMin;
  }

  private drawCannonAimGuides(ship: Ship, worldState: WorldState, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;
    if (!this.playerIsAiming) return;

    // Determine which cannons to show guides for based on what the local player is mounted to.
    const localPlayer = this.localPlayerId != null
      ? worldState.players.find(p => p.id === this.localPlayerId)
      : null;

    // Player must be mounted and on this ship
    if (!localPlayer || !localPlayer.isMounted || localPlayer.carrierId !== ship.id) return;

    let cannonsToShow: typeof ship.modules = [];

    if (localPlayer.mountedModuleId != null) {
      const mountedMod = ship.modules.find(m => m.id === localPlayer.mountedModuleId);
      if (mountedMod?.kind === 'cannon') {
        // Mounted directly on a cannon — show just that one
        cannonsToShow = [mountedMod];
      } else if (mountedMod?.kind === 'helm' || mountedMod?.kind === 'steering-wheel') {
        // On the helm — only show cannons whose outward-facing sector contains the aim direction.
        // Sector check: sin(cannon.localRot - aimAngleRelative) > 0 means the cannon's barrel
        // faces the same general half-plane as the player is aiming toward.
        const aim = this.playerAimAngleRelative;
        cannonsToShow = ship.modules.filter(m =>
          m.kind === 'cannon' &&
          Math.sin((m.localRot || 0) - aim) > 0
        );
      }
    }

    if (cannonsToShow.length === 0) return;

    this.ctx.save();
    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const cosR = Math.cos(ship.rotation);
    const sinR = Math.sin(ship.rotation);

    for (const cannon of cannonsToShow) {
      if (!cannon.moduleData || cannon.moduleData.kind !== 'cannon') continue;
      const cannonData = cannon.moduleData;

      const totalAngle = (cannon.localRot || 0) + (cannonData.aimDirection || 0);
      const cx = cannon.localPos.x;
      const cy = cannon.localPos.y;

      const barrelTipX = cx + 40 * Math.sin(totalAngle);
      const barrelTipY = cy - 40 * Math.cos(totalAngle);
      const dirX = Math.sin(totalAngle);
      const dirY = -Math.cos(totalAngle);
      const range = cannonData.fireRange || 2000;

      // ── Hull-accurate impact detection in world space ──
      // Convert barrel tip and direction into world space for the intersection test.
      const wBarrelX = ship.position.x + barrelTipX * cosR - barrelTipY * sinR;
      const wBarrelY = ship.position.y + barrelTipX * sinR + barrelTipY * cosR;
      const wDirX = dirX * cosR - dirY * sinR;
      const wDirY = dirX * sinR + dirY * cosR;

      // Find the nearest enemy ship hull intersection.  tHit is in the same unit space
      // as `range` (world units ≡ local canvas units at this transform level).
      let tHit = Infinity;
      for (const other of worldState.ships) {
        if (other.id === ship.id) continue;
        if (!other.hull || other.hull.length < 3) continue;
        const t = this.rayHullIntersect(
          wBarrelX, wBarrelY, wDirX, wDirY,
          other.hull, other.position.x, other.position.y, other.rotation,
          range
        );
        if (t < tHit) tHit = t;
      }

      const didHit     = tHit < Infinity;
      // Trajectory ends at hull-entry point, clamped to max range
      const drawLength = didHit ? Math.min(tHit, range) : range;
      const guideColor = didHit ? '#FFD700' : '#AAAAAA';

      // ── Dashed trajectory line (stops at impact) ──
      this.ctx.save();
      this.ctx.globalAlpha = 0.80;
      this.ctx.strokeStyle = guideColor;
      this.ctx.lineWidth   = 3.5;
      this.ctx.lineCap     = 'round';
      this.ctx.setLineDash([10, 7]);
      this.ctx.beginPath();
      this.ctx.moveTo(barrelTipX, barrelTipY);
      this.ctx.lineTo(barrelTipX + dirX * drawLength, barrelTipY + dirY * drawLength);
      this.ctx.stroke();
      this.ctx.restore();
      this.ctx.setLineDash([]);

      // ── Range-bracket tick marks at 1/3 and 2/3 of max range (only if before impact) ──
      const perpX = -dirY;
      const perpY =  dirX;
      for (const frac of [1 / 3, 2 / 3]) {
        const tickDist = range * frac;
        if (tickDist >= drawLength) continue; // past (or at) impact — skip
        const bx = barrelTipX + dirX * tickDist;
        const by = barrelTipY + dirY * tickDist;
        this.ctx.save();
        this.ctx.globalAlpha = 0.55;
        this.ctx.strokeStyle = guideColor;
        this.ctx.lineWidth   = 3.5;
        this.ctx.lineCap     = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(bx - perpX * 7, by - perpY * 7);
        this.ctx.lineTo(bx + perpX * 7, by + perpY * 7);
        this.ctx.stroke();
        this.ctx.restore();
      }

      // ── Terminal reticle — 4 arcs, hollow centre (at impact or max range) ──
      const termX    = barrelTipX + dirX * drawLength;
      const termY    = barrelTipY + dirY * drawLength;
      // When hitting a ship the reticle is tighter to convey a direct hit
      const reticleR = didHit ? 10 : 13;
      const arcSpan  = Math.PI * 0.44;
      const gapHalf  = Math.PI * 0.06;
      this.ctx.save();
      this.ctx.globalAlpha = 0.75;
      this.ctx.strokeStyle = guideColor;
      this.ctx.lineWidth   = 3.5;
      this.ctx.lineCap     = 'round';
      for (let i = 0; i < 4; i++) {
        const centre = (Math.PI / 2) * i;
        this.ctx.beginPath();
        this.ctx.arc(termX, termY, reticleR, centre + gapHalf, centre + arcSpan - gapHalf);
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  private drawShipSteeringWheels(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    // Find all helm/steering wheel modules
    const helms = ship.modules.filter(m => m.kind === 'helm' || m.kind === 'steering-wheel');
    
    for (const helm of helms) {
      if (!helm.moduleData) continue;
      
      const x = helm.localPos.x;
      const y = helm.localPos.y;
      
      // Draw helm as a simple brown circle
      this.ctx.fillStyle = '#8B4513';
      this.ctx.beginPath();
      this.ctx.arc(x, y, 8, 0, Math.PI * 2);
      this.ctx.fill();
    }
    
    this.ctx.restore();
  }
  
  private drawShipLadders(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    // Find all ladder modules
    const ladders = ship.modules.filter(m => m.kind === 'ladder');
    
    for (const ladder of ladders) {
      const x = ladder.localPos.x;
      const y = ladder.localPos.y;
      const rot = ladder.localRot || 0;
      
      // Save context for this ladder
      this.ctx.save();
      
      // Move to ladder position and apply rotation
      this.ctx.translate(x, y);
      this.ctx.rotate(rot);
      
      // Draw ladder as a black rectangle (20x40 pixels)
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(-10, -20, 20, 40);
      
      // Restore ladder transform
      this.ctx.restore();
    }
    
    this.ctx.restore();
  }
  
  private drawShipRudder(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    // Rudder position at the stern (slightly forward of the absolute tip)
    // Brigantine stern tip is at x = -345, positioning rudder at -320 for better visual placement
    const rudderX = -300; // Near the stern tip
    const rudderY = 0; // Centered vertically
    
    // Rudder dimensions
    const rudderWidth = 8;
    const rudderLength = 30;
    
    // Get rudder angle from ship state (server provides this)
    const rudderAngle = ship.rudderAngle || 0;
    
    // Move to rudder pivot point
    this.ctx.save();
    this.ctx.translate(rudderX, rudderY);
    this.ctx.rotate(Math.PI / 2); // Rotate 90 degrees to make it perpendicular (pointing backward)
    this.ctx.rotate(rudderAngle); // Apply rudder turning angle
    
    // Draw rudder as a rectangle extending backward from the stern
    this.ctx.fillStyle = '#4A3020'; // Dark brown wood color
    this.ctx.strokeStyle = '#2A1810';
    this.ctx.lineWidth = 1;
    
    // Draw rudder rectangle (centered on pivot, extending in positive Y direction which is now backward)
    this.ctx.fillRect(-rudderWidth / 2, 0, rudderWidth, rudderLength);
    this.ctx.strokeRect(-rudderWidth / 2, 0, rudderWidth, rudderLength);
    
    // Draw pivot pin/hinge
    this.ctx.fillStyle = '#888888'; // Gray metal
    this.ctx.beginPath();
    this.ctx.arc(0, 0, 3, 0, Math.PI * 2);
    this.ctx.fill();
    
    this.ctx.restore();
    this.ctx.restore();
  }
  
  /**
   * Draw sail rigging ropes for each mast.
   *
   * Ship-local coordinate convention:
   *   X = fore (+) / aft (-)   — the long axis
   *   Y = port (+) / stbd (-)  — perpendicular to long axis
   *
   * Design per mast per side:
   *
   *           apex (mx, 0)
   *          / |  | \
   *         /  |  |  \         ← 4 downlines: outer diagonals + 2 inner verticals
   *        /---+--+---\        ← horizontal cross-rope at t = 1/3
   *       /----+--+----\       ← horizontal cross-rope at t = 2/3
   *      [==x0=x1] [x2=x3==]  ← base rail-rope + 2 elongated cleats
   *       x0   x1   x2   x3
   *
   * x0 = mx-halfBase, x1 = mx-step, x2 = mx+step, x3 = mx+halfBase
   * step = halfBase / 3
   * 2 cleats: one spanning x0→x1, one spanning x2→x3
   */
  private drawShipSailRopes(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    this.ctx.save();

    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();

    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const masts = ship.modules.filter(m => m.kind === 'mast');

    for (const mast of masts) {
      if (!mast.moduleData || mast.moduleData.kind !== 'mast') continue;

      const mastData = mast.moduleData;
      const mx = mast.localPos.x;
      const my = mast.localPos.y;

      // Half-base = half sail width → triangle base spans full sail width
      const halfBase = mastData.sailWidth * 0.5;
      // 4 rope X-positions evenly across the base: x0, x1, x2, x3
      const step = halfBase / 3;
      const x0 = mx - halfBase;       // aft outer
      const x1 = mx - step;           // aft inner
      const x2 = mx + step;           // fore inner
      const x3 = mx + halfBase;       // fore outer

      // Rope style — hemp tan
      this.ctx.strokeStyle = '#8B7355';
      this.ctx.lineWidth = 1.2;
      this.ctx.lineCap = 'round';

      for (const side of [1, -1] as const) { // +1 = port, -1 = stbd
        // Each rope column gets its own rail Y — follows the hull curve at bow/stern
        const ry0 = my + this.hullRailY(x0, side);
        const ry1 = my + this.hullRailY(x1, side);
        const ry2 = my + this.hullRailY(x2, side);
        const ry3 = my + this.hullRailY(x3, side);

        // ── Outer diagonal braces: apex → x0 and apex → x3 ──
        this.ctx.beginPath();
        this.ctx.moveTo(mx, my);
        this.ctx.lineTo(x0, ry0);
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(mx, my);
        this.ctx.lineTo(x3, ry3);
        this.ctx.stroke();

        // ── 2 inner shrouds: from mast apex down to x1 and x2 on the rail ──
        this.ctx.beginPath();
        this.ctx.moveTo(mx, my);
        this.ctx.lineTo(x1, ry1);
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(mx, my);
        this.ctx.lineTo(x2, ry2);
        this.ctx.stroke();

        // ── 2 horizontal cross-ropes at t = 1/3 and 2/3 along the outer diagonals ──
        for (const t of [1 / 3, 2 / 3]) {
          // Interpolate along the outer diagonals to get cross-rope endpoints
          const crossXL = mx + (x0 - mx) * t;
          const crossYL = my + (ry0 - my) * t;
          const crossXR = mx + (x3 - mx) * t;
          const crossYR = my + (ry3 - my) * t;
          this.ctx.beginPath();
          this.ctx.moveTo(crossXL, crossYL);
          this.ctx.lineTo(crossXR, crossYR);
          this.ctx.stroke();
        }

        // ── Base rail-rope following the hull edge through all 4 rope endpoints ──
        this.ctx.beginPath();
        this.ctx.moveTo(x0, ry0);
        this.ctx.lineTo(x1, ry1);
        this.ctx.lineTo(x2, ry2);
        this.ctx.lineTo(x3, ry3);
        this.ctx.stroke();

        // ── 2 elongated cleats: aft pair (x0→x1) and fore pair (x2→x3) ──
        // Angle is derived directly from the two endpoint positions so the cleat
        // naturally follows the hull tangent on both straight and curved sections.
        this.drawSailRopeCleat(x0, x1, (ry0 + ry1) / 2, Math.atan2(ry1 - ry0, x1 - x0));
        this.drawSailRopeCleat(x2, x3, (ry2 + ry3) / 2, Math.atan2(ry3 - ry2, x3 - x2));
      }
    }

    this.ctx.restore();
  }

  /**
   * Draw a long-blocky wooden cleat whose body spans exactly from xA to xB at y.
   * The body is elongated along X (long axis of the rail) and shallow in Y —
   * a 5:1 aspect ratio gives the "long plank" look.
   * The cleat is rotated by `angle` to follow the local hull plank tangent.
   *
   *   |       body (long bar)       |
   *   [█]═════════════════════════[█]
   *   horn                        horn
   *   (at xA)                  (at xB)
   */
  private drawSailRopeCleat(xA: number, xB: number, y: number, angle: number = 0): void {
    const cx    = (xA + xB) / 2;
    const bodyW = Math.abs(xB - xA);  // full span — body reaches both rope positions
    const bodyH = bodyW * 0.20;       // 5 : 1 long-blocky ratio
    const hornW = bodyH * 1.20;       // horn is wider than body is tall (square-ish block)
    const hornH = bodyH * 1.30;       // horn projects 1.3× body height beyond rail

    this.ctx.save();
    this.ctx.translate(cx, y);
    this.ctx.rotate(angle);           // follow local hull plank tangent

    this.ctx.fillStyle   = '#4A3728';
    this.ctx.strokeStyle = '#2C1F14';
    this.ctx.lineWidth   = 0.9;

    // Long central bar
    this.ctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
    this.ctx.strokeRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);

    // Aft horn — upright block at the xA end, centred on the bar
    this.ctx.fillRect(-bodyW / 2, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
    this.ctx.strokeRect(-bodyW / 2, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);

    // Fore horn — upright block at the xB end, centred on the bar
    this.ctx.fillRect(bodyW / 2 - hornW, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
    this.ctx.strokeRect(bodyW / 2 - hornW, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);

    this.ctx.restore();
  }

  /**
   * Return the actual hull rail Y at ship-local x position for a given side.
   * Straight section (x ∈ [−260, 190]) → ±90.
   * Bow/stern Bézier curves return the interpolated Y on the hull boundary.
   */
  private hullRailY(x: number, side: 1 | -1): number {
    // Straight sides
    if (x >= -260 && x <= 190) return side * 90;

    // Bow Bézier: Bx = 190 + 450·t·(1−t),  By = 90·(1−2t)
    if (x > 190) {
      const disc = 450 * 450 - 4 * 450 * (x - 190);
      if (disc < 0) return 0;
      const sqrtDisc = Math.sqrt(disc);
      const t = side === 1
        ? (450 - sqrtDisc) / (2 * 450)   // port half (t ∈ [0,0.5], By > 0)
        : (450 + sqrtDisc) / (2 * 450);  // stbd half (t ∈ [0.5,1], By < 0)
      return 90 * (1 - 2 * t);
    }

    // Stern Bézier: Bx = −260 − 170·t·(1−t),  By = 90·(2t−1)
    const disc = 170 * 170 + 4 * 170 * (x + 260);
    if (disc < 0) return 0;
    const sqrtDisc = Math.sqrt(disc);
    const t = side === -1
      ? (170 - sqrtDisc) / (2 * 170)   // stbd half (t ∈ [0,0.5], By < 0)
      : (170 + sqrtDisc) / (2 * 170);  // port half (t ∈ [0.5,1], By > 0)
    return 90 * (2 * t - 1);
  }

  /**
   * Return the angle of the hull-plank tangent at ship-local x position.
   *
   * Hull geometry (from ShipUtils / BRIGANTINE_SPECIFICATION):
   *   Straight port/stbd sides: x ∈ [−260, 190]  →  angle = 0  (horizontal)
   *   Bow Bézier:  P0=(190,90) P1=(415,0) P2=(190,−90)
   *     Bx(t) = 190 + 450·t·(1−t)   →   tangent = (450(1−2t), ±180)
   *   Stern Bézier: P0=(−260,−90) P1=(−345,0) P2=(−260,90)
   *     Bx(t) = −260 − 170·t·(1−t)  →   tangent = (170(2t−1), ±180)
   *
   * `side` = +1 for port (upper half of bow/stern curves), −1 for starboard.
   */
  private hullTangentAngle(x: number, side: 1 | -1): number {
    // ── Straight side (vast majority of rail positions) ──
    if (x >= -260 && x <= 190) return 0;

    // ── Bow curve: Bx = 190 + 450·t·(1−t),  t ∈ [0, 1] ──
    if (x > 190) {
      // Solve 450t² − 450t + (x−190) = 0
      const disc = 450 * 450 - 4 * 450 * (x - 190);
      if (disc < 0) return 0;
      // port uses t ∈ [0, 0.5] (y positive), stbd uses t ∈ [0.5, 1]
      const sqrtDisc = Math.sqrt(disc);
      const t = side === 1
        ? (450 - sqrtDisc) / (2 * 450)   // smaller root → port half
        : (450 + sqrtDisc) / (2 * 450);  // larger root  → stbd half
      return Math.atan2(-180 * side, 450 * (1 - 2 * t));
    }

    // ── Stern curve: Bx = −260 − 170·t·(1−t),  t ∈ [0, 1] ──
    // Solve 170t² − 170t − (x + 260) = 0  (x + 260 < 0)
    const disc = 170 * 170 + 4 * 170 * (x + 260); // note: (x+260) < 0
    if (disc < 0) return 0;
    const sqrtDisc = Math.sqrt(disc);
    // stbd uses t ∈ [0, 0.5], port uses t ∈ [0.5, 1]
    const t = side === -1
      ? (170 - sqrtDisc) / (2 * 170)
      : (170 + sqrtDisc) / (2 * 170);
    return Math.atan2(180 * side, 170 * (2 * t - 1));
  }

  private drawShipSailFibers(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    // Find all mast modules
    const masts = ship.modules.filter(m => m.kind === 'mast');
    
    for (const mast of masts) {
      if (!mast.moduleData || mast.moduleData.kind !== 'mast') continue;
      
      const mastData = mast.moduleData;
      const x = mast.localPos.x;
      const y = mast.localPos.y;
      const width = mastData.sailWidth;
      const height = mastData.height;
      const sailColor = mastData.sailColor;
      const angle = mastData.angle; // Sail angle in degrees
      
      // Only draw sail if openness > 0
        this.drawSailFiber(x, y, width, height, sailColor, mastData.openness / 100, angle);
      
    }
    
    this.ctx.restore();
  }
  
  private drawSailFiber(x: number, y: number, width: number, height: number, sailColor: string, openness: number, angle: number): void {
    // Save context and apply rotation around mast position
    this.ctx.save();
    
    // Translate to mast position and rotate (this rotates both sail and yard)
    this.ctx.translate(x, y);
    this.ctx.rotate(angle); // Angle is already in radians from server
    
    // Now draw everything relative to (0, 0) since we've translated to the mast position
    const sailTopY = -height * 1.4; // Top of sail attaches to yard (negative = up)
    const sailPower = width * 1.2 * openness; // Adjust height based on openness
    
    // Create a gradient for the sail
    const gradient = this.ctx.createLinearGradient(
      -width / 2, sailTopY,
      width / 2, sailTopY
    );
    gradient.addColorStop(0, '#E6E6E6');
    gradient.addColorStop(0.5, sailColor);
    gradient.addColorStop(1, '#E6E6E6');
    
    // Draw sail shape
    this.ctx.beginPath();
    this.ctx.moveTo(0, sailTopY);
    this.ctx.lineTo(0, -sailTopY);
    
    // Bottom of sail curves slightly
    this.ctx.quadraticCurveTo(sailPower + 25, 0, 0, sailTopY);
   
    this.ctx.closePath();
    
    // Fill with gradient
    this.ctx.fillStyle = gradient;
    this.ctx.fill();
    
    // Add some sail details (horizontal lines)
    this.ctx.strokeStyle = '#DDDDDD';
    this.ctx.lineWidth = 0.5;
    
    const lineCount = 3;
    const spacing = sailPower / (lineCount + 1);
    
    this.ctx.beginPath();

    // Draw the horizontal yard (mast pole) BEFORE restoring context so it rotates with the sail
    this.ctx.fillStyle = '#8B4513';
    this.ctx.strokeStyle = '#654321';
    this.ctx.fillRect(-width / 20, sailTopY, width / 10, -sailTopY * 2);
    this.ctx.strokeRect(-width / 20, sailTopY, width / 10, -sailTopY * 2);

    // Restore context after rotation
    this.ctx.restore();
  }
  
  private drawShipAmmoLabel(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const screenPos = camera.worldToScreen(ship.position);
    const zoom = camera.getState().zoom;

    const ammoText = ship.infiniteAmmo ? '∞ ammo' : `⚫ ${ship.cannonAmmo}`;
    const labelY = screenPos.y - 120 * zoom;

    this.ctx.save();
    this.ctx.font = `bold ${Math.max(11, 13 * zoom)}px Arial`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    // Background pill
    const metrics = this.ctx.measureText(ammoText);
    const pad = 5;
    this.ctx.fillStyle = 'rgba(0,0,0,0.55)';
    this.ctx.beginPath();
    const rx = screenPos.x - metrics.width / 2 - pad;
    const ry = labelY - 9;
    const rw = metrics.width + pad * 2;
    const rh = 18;
    this.ctx.roundRect(rx, ry, rw, rh, 4);
    this.ctx.fill();

    this.ctx.fillStyle = ship.infiniteAmmo ? '#aaffaa' : '#ffdd88';
    this.ctx.fillText(ammoText, screenPos.x, labelY);
    this.ctx.restore();
  }

  private drawShipSailMasts(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    // Find all mast modules
    const masts = ship.modules.filter(m => m.kind === 'mast');
    
    for (const mast of masts) {
      if (!mast.moduleData || mast.moduleData.kind !== 'mast') continue;
      
      const mastData = mast.moduleData;
      const x = mast.localPos.x;
      const y = mast.localPos.y;
      const radius = mastData.radius;
      
      // Draw mast as a circle
      this.ctx.fillStyle = '#8B4513'; // Brown color for wooden mast
      this.ctx.strokeStyle = '#654321'; // Darker brown outline
      this.ctx.lineWidth = 2 / cameraState.zoom;
      
      this.ctx.beginPath();
      this.ctx.arc(x, y, radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
    }
    
    this.ctx.restore();
  }
  
  private drawPlayer(player: Player, worldState: WorldState, camera: Camera): void {
    // Check if player is visible
    if (!camera.isWorldPositionVisible(player.position, 50)) {
      return; // Skip off-screen players
    }
    
    const screenPos = camera.worldToScreen(player.position);
    const cameraState = camera.getState();
    const scaledRadius = player.radius * cameraState.zoom;
    
    // Draw player circle
    // Color: Green if on deck, Blue if mounted, Red if swimming
    if (player.isMounted) {
      this.ctx.fillStyle = '#0099ff'; // Blue for mounted
    } else {
      this.ctx.fillStyle = player.onDeck ? '#00ff00' : '#ff0000';
    }
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();
    
    // If mounted, draw mount indicator
    if (player.isMounted) {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '12px Arial';
      this.ctx.fillText('⚓', screenPos.x - 5, screenPos.y - scaledRadius - 5);
    }
    
    // Draw rotation indicator (facing direction from mouse aim)
    const rotation = player.rotation;
    
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 3;
    this.ctx.beginPath();
    this.ctx.moveTo(screenPos.x, screenPos.y);
    const directionLength = scaledRadius * 1.5;
    const directionEnd = {
      x: screenPos.x + Math.cos(rotation) * directionLength,
      y: screenPos.y + Math.sin(rotation) * directionLength
    };
    this.ctx.lineTo(directionEnd.x, directionEnd.y);
    this.ctx.stroke();
    
    // Draw arrowhead
    const arrowSize = scaledRadius * 0.4;
    const arrowAngle = Math.PI / 6; // 30 degrees
    
    this.ctx.beginPath();
    this.ctx.moveTo(directionEnd.x, directionEnd.y);
    this.ctx.lineTo(
      directionEnd.x - Math.cos(rotation - arrowAngle) * arrowSize,
      directionEnd.y - Math.sin(rotation - arrowAngle) * arrowSize
    );
    this.ctx.moveTo(directionEnd.x, directionEnd.y);
    this.ctx.lineTo(
      directionEnd.x - Math.cos(rotation + arrowAngle) * arrowSize,
      directionEnd.y - Math.sin(rotation + arrowAngle) * arrowSize
    );
    this.ctx.stroke();
    
    // Draw velocity vector
    this.ctx.strokeStyle = '#ffff00';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(screenPos.x, screenPos.y);
    const velEnd = camera.worldToScreen(player.position.add(player.velocity.mul(0.1)));
    this.ctx.lineTo(velEnd.x, velEnd.y);
    this.ctx.stroke();
    
    // Draw player name above the player
    if (player.name) {
      this.ctx.font = '14px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      
      // Draw text background for readability
      const textMetrics = this.ctx.measureText(player.name);
      const textWidth = textMetrics.width;
      const textHeight = 16;
      const nameY = screenPos.y - scaledRadius - 8;
      
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      this.ctx.fillRect(
        screenPos.x - textWidth / 2 - 4,
        nameY - textHeight,
        textWidth + 8,
        textHeight + 4
      );
      
      // Draw the name text
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillText(player.name, screenPos.x, nameY);
    }
  }
  
  private drawCannonball(cannonball: Cannonball, camera: Camera): void {
    // Check if cannonball is visible
    if (!camera.isWorldPositionVisible(cannonball.position, 20)) {
      return; // Skip off-screen cannonballs
    }
    
    const screenPos = camera.worldToScreen(cannonball.position);
    const cameraState = camera.getState();
    const scaledRadius = cannonball.radius * cameraState.zoom;
    
    // Draw cannonball as solid black circle (simple and visible)
    this.ctx.fillStyle = '#000000'; // Pure black
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, 0, Math.PI * 2);
    this.ctx.fill();
  }
  
  private drawLoadingSpinner(): void {
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2 + 100;
    const radius = 30;
    const time = Date.now() / 100;
    
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 4;
    this.ctx.lineCap = 'round';
    
    // Draw spinning arc
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius, time, time + Math.PI * 1.5);
    this.ctx.stroke();
  }

  private drawNpc(npc: Npc, worldState: WorldState, camera: Camera): void {
    // If on a ship, derive world position from the ship's current (interpolated) transform
    // so the NPC moves smoothly with the ship between server ticks.
    let worldPos = npc.position;
    if (npc.shipId) {
      const ship = worldState.ships.find(s => s.id === npc.shipId);
      if (ship && npc.localPosition) {
        const cosR = Math.cos(ship.rotation);
        const sinR = Math.sin(ship.rotation);
        worldPos = Vec2.from(
          ship.position.x + npc.localPosition.x * cosR - npc.localPosition.y * sinR,
          ship.position.y + npc.localPosition.x * sinR + npc.localPosition.y * cosR
        );
      }
    }

    if (!camera.isWorldPositionVisible(worldPos, 60)) return;

    const screenPos = camera.worldToScreen(worldPos);
    const cameraState = camera.getState();
    const radius = 8 * cameraState.zoom;
    const isMoving = npc.state === NPC_STATE_MOVING;

    this.ctx.save();
    this.ctx.globalAlpha = isMoving ? 0.7 : 1.0;

    // Colour NPC by their current task assignment (darkened via globalAlpha when moving)
    const npcTask = this.npcTaskMap.get(npc.id) ?? 'Idle';
    this.ctx.fillStyle = NPC_TASK_COLORS[npcTask] ?? '#DAA520';
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, radius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    // Facing direction indicator
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(screenPos.x, screenPos.y);
    this.ctx.lineTo(
      screenPos.x + Math.cos(npc.rotation) * radius * 1.5,
      screenPos.y + Math.sin(npc.rotation) * radius * 1.5
    );
    this.ctx.stroke();

    this.ctx.restore();

    // Name label only when standing still (avoid visual noise during movement)
    if (!isMoving) {
      const fontSize = Math.max(10, Math.min(14, 12 * cameraState.zoom));
      this.ctx.font = `${fontSize}px Arial`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      const nameY = screenPos.y - radius - 3;
      const tw = this.ctx.measureText(npc.name).width;
      this.ctx.fillStyle = 'rgba(0,0,0,0.55)';
      this.ctx.fillRect(screenPos.x - tw / 2 - 3, nameY - fontSize, tw + 6, fontSize + 2);
      this.ctx.fillStyle = '#ffe066';
      this.ctx.fillText(npc.name, screenPos.x, nameY);
    }
  }

  /**
   * Debug visualization for hover boundaries
   */
  private drawHoverBoundariesDebug(worldState: WorldState, camera: Camera): void {
    for (const ship of worldState.ships) {
      for (const module of ship.modules) {
        if (!module.moduleData) continue;
        
        const moduleData = module.moduleData;
        
        // Get module bounds
        let width = 20;
        let height = 20;
        
        if (moduleData.kind === 'plank') {
          width = moduleData.length || 20;
          height = moduleData.width || 10;
        } else if (moduleData.kind === 'cannon') {
          width = 30;
          height = 20;
        }
        
        this.ctx.save();
        
        // Check if this is a curved plank
        if (moduleData.kind === 'plank' && moduleData.isCurved && moduleData.curveData) {
          // For curved planks, draw in ship-local coordinates
          this.ctx.translate(camera.worldToScreen(ship.position).x, camera.worldToScreen(ship.position).y);
          this.ctx.rotate(ship.rotation);
          this.ctx.scale(camera.getState().zoom, camera.getState().zoom);
          
          // Draw curved plank boundary
          this.ctx.strokeStyle = 'rgba(255, 0, 255, 0.5)'; // Magenta
          this.ctx.lineWidth = 2 / camera.getState().zoom;
          this.ctx.setLineDash([5, 5]);
          this.ctx.beginPath();
          
          const { start, control, end, t1, t2 } = moduleData.curveData;
          const segments = 20;
          const halfPlankWidth = moduleData.width / 2;
          
          // Sample points along the curve
          const points: Array<{x: number, y: number}> = [];
          for (let i = 0; i <= segments; i++) {
            const t = t1 + (t2 - t1) * (i / segments);
            const pt = this.getQuadraticPoint(start, control, end, t);
            points.push(pt);
          }
          
          // Calculate perpendicular offsets for width
          const outerPoints: Array<{x: number, y: number}> = [];
          const innerPoints: Array<{x: number, y: number}> = [];
          
          for (let i = 0; i < points.length; i++) {
            const pt = points[i];
            
            // Calculate tangent direction
            let dx: number, dy: number;
            if (i === 0) {
              dx = points[1].x - pt.x;
              dy = points[1].y - pt.y;
            } else if (i === points.length - 1) {
              dx = pt.x - points[i - 1].x;
              dy = pt.y - points[i - 1].y;
            } else {
              dx = points[i + 1].x - points[i - 1].x;
              dy = points[i + 1].y - points[i - 1].y;
            }
            
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0) {
              dx /= len;
              dy /= len;
            }
            
            const perpX = -dy;
            const perpY = dx;
            
            outerPoints.push({
              x: pt.x + perpX * halfPlankWidth,
              y: pt.y + perpY * halfPlankWidth
            });
            
            innerPoints.push({
              x: pt.x - perpX * halfPlankWidth,
              y: pt.y - perpY * halfPlankWidth
            });
          }
          
          // Draw the boundary outline
          this.ctx.moveTo(outerPoints[0].x, outerPoints[0].y);
          for (let i = 1; i < outerPoints.length; i++) {
            this.ctx.lineTo(outerPoints[i].x, outerPoints[i].y);
          }
          for (let i = innerPoints.length - 1; i >= 0; i--) {
            this.ctx.lineTo(innerPoints[i].x, innerPoints[i].y);
          }
          this.ctx.closePath();
          this.ctx.stroke();
          
          // Draw center line
          this.ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)'; // Yellow
          this.ctx.setLineDash([]);
          this.ctx.beginPath();
          this.ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) {
            this.ctx.lineTo(points[i].x, points[i].y);
          }
          this.ctx.stroke();
        } else {
          // For straight modules, draw simple rectangle boundary
          this.ctx.translate(camera.worldToScreen(ship.position).x, camera.worldToScreen(ship.position).y);
          this.ctx.rotate(ship.rotation);
          this.ctx.scale(camera.getState().zoom, camera.getState().zoom);
          this.ctx.translate(module.localPos.x, module.localPos.y);
          this.ctx.rotate(module.localRot);
          
          const halfWidth = width / 2;
          const halfHeight = height / 2;
          
          // Draw boundary rectangle
          this.ctx.strokeStyle = 'rgba(255, 0, 255, 0.5)'; // Magenta
          this.ctx.lineWidth = 2 / camera.getState().zoom;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(-halfWidth, -halfHeight, width, height);
          
          // Draw center point
          this.ctx.fillStyle = 'rgba(255, 255, 0, 0.8)'; // Yellow
          this.ctx.setLineDash([]);
          this.ctx.beginPath();
          this.ctx.arc(0, 0, 3 / camera.getState().zoom, 0, Math.PI * 2);
          this.ctx.fill();
          
          // Draw module ID label
          this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          this.ctx.font = `${12 / camera.getState().zoom}px monospace`;
          this.ctx.textAlign = 'center';
          this.ctx.textBaseline = 'middle';
          this.ctx.fillText(`#${module.id}`, 0, 0);
        }
        
        this.ctx.restore();
      }
    }
  }
  
  /**
   * Draw hover tooltip for modules
   */
  private drawHoverTooltip(camera: Camera): void {
    if (!this.hoveredModule || !this.mouseWorldPos) return;
    
    const { ship, module } = this.hoveredModule;
    const moduleData = module.moduleData;
    
    if (!moduleData) return;
    
    // Convert mouse world position to screen position for tooltip
    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    
    // Build tooltip text lines
    const lines: string[] = [];
    lines.push(`Type: ${moduleData.kind.toUpperCase()}`);
    lines.push(`ID: ${module.id}`);
    
    // Quality helper: map material to quality tier
    const qualityFromMaterial = (mat: string): string => {
      switch (mat) {
        case 'iron':  return 'Uncommon';
        case 'steel': return 'Rare';
        default:      return 'Common';
      }
    };

    // Add type-specific info
    if (moduleData.kind === 'plank') {
      const hp = Math.round(moduleData.health);
      const maxHp = moduleData.maxHealth ?? 10000;
      lines.push(`Health: ${hp} / ${maxHp}`);
      lines.push(`Quality: ${qualityFromMaterial(moduleData.material)}`);
      if (moduleData.sectionName) {
        lines.push(`Section: ${moduleData.sectionName}`);
      }
    } else if (moduleData.kind === 'cannon') {
      const hp = Math.round(moduleData.health);
      const maxHp = (moduleData as any).maxHealth ?? 8000;
      lines.push(`Health: ${hp} / ${maxHp}`);
      lines.push(`Dmg: 3000`);
      lines.push(`Reload: ${(moduleData as any).reloadTime ?? 3.0}s`);
      lines.push(`Quality: Common`);
    } else if (moduleData.kind === 'helm' || moduleData.kind === 'steering-wheel') {
      const hp = Math.round((moduleData as any).health ?? 10000);
      const maxHp = (moduleData as any).maxHealth ?? 10000;
      lines.push(`Health: ${hp} / ${maxHp}`);
      lines.push(`Turn Rate: ${moduleData.maxTurnRate.toFixed(2)}`);
      lines.push(`Responsiveness: ${(moduleData.responsiveness * 100).toFixed(0)}%`);
    } else if (moduleData.kind === 'mast') {
      const hp = Math.round((moduleData as any).health ?? 15000);
      const maxHp = (moduleData as any).maxHealth ?? 15000;
      lines.push(`Health: ${hp} / ${maxHp}`);
      lines.push(`Sail State: ${moduleData.sailState.toUpperCase()}`);
      lines.push(`Openness: ${moduleData.openness.toFixed(0)}%`);
      lines.push(`Wind Efficiency: ${(moduleData.windEfficiency * 100).toFixed(0)}%`);
    }
    
    // Add interaction hint
    lines.push('');
    lines.push('[E] Interact');
    
    // Measure text dimensions
    this.ctx.font = '14px monospace';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';
    
    let maxWidth = 0;
    for (const line of lines) {
      const metrics = this.ctx.measureText(line);
      maxWidth = Math.max(maxWidth, metrics.width);
    }
    
    const padding = 10;
    const lineHeight = 18;
    const boxWidth = maxWidth + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2;
    
    // Position tooltip near mouse, but keep it on screen
    let tooltipX = screenPos.x + 15;
    let tooltipY = screenPos.y + 15;
    
    // Keep tooltip on screen
    if (tooltipX + boxWidth > this.canvas.width) {
      tooltipX = screenPos.x - boxWidth - 15;
    }
    if (tooltipY + boxHeight > this.canvas.height) {
      tooltipY = screenPos.y - boxHeight - 15;
    }
    
    // Draw tooltip background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    this.ctx.strokeStyle = '#ffaa00';
    this.ctx.lineWidth = 2;
    this.ctx.fillRect(tooltipX, tooltipY, boxWidth, boxHeight);
    this.ctx.strokeRect(tooltipX, tooltipY, boxWidth, boxHeight);
    
    // Draw tooltip text
    this.ctx.fillStyle = '#ffffff';
    for (let i = 0; i < lines.length; i++) {
      const textY = tooltipY + padding + i * lineHeight;
      this.ctx.fillText(lines[i], tooltipX + padding, textY);
    }
    
    // Draw green highlight outline around the hovered module
    this.ctx.save();
    
    // Check if it's a curved plank (needs special handling)
    if (moduleData.kind === 'plank' && moduleData.isCurved && moduleData.curveData) {
      // For curved planks, draw directly in ship-local coordinates
      // Transform to ship's coordinate system only
      this.ctx.translate(camera.worldToScreen(ship.position).x, camera.worldToScreen(ship.position).y);
      this.ctx.rotate(ship.rotation);
      this.ctx.scale(camera.getState().zoom, camera.getState().zoom);
      
      // Draw curved plank highlight
      this.ctx.strokeStyle = '#00ff00'; // Green
      this.ctx.lineWidth = 3 / camera.getState().zoom;
      this.ctx.beginPath();
      
      const { start, control, end, t1, t2 } = moduleData.curveData;
      const segments = 20;
      const halfPlankWidth = moduleData.width / 2;
      
      // Sample points along the curve
      const points: Array<{x: number, y: number}> = [];
      for (let i = 0; i <= segments; i++) {
        const t = t1 + (t2 - t1) * (i / segments);
        const pt = this.getQuadraticPoint(start, control, end, t);
        points.push(pt);
      }
      
      // Calculate perpendicular offsets for width
      const outerPoints: Array<{x: number, y: number}> = [];
      const innerPoints: Array<{x: number, y: number}> = [];
      
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        
        // Calculate tangent direction
        let dx: number, dy: number;
        if (i === 0) {
          dx = points[1].x - pt.x;
          dy = points[1].y - pt.y;
        } else if (i === points.length - 1) {
          dx = pt.x - points[i - 1].x;
          dy = pt.y - points[i - 1].y;
        } else {
          dx = points[i + 1].x - points[i - 1].x;
          dy = points[i + 1].y - points[i - 1].y;
        }
        
        // Normalize and get perpendicular
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          dx /= len;
          dy /= len;
        }
        
        const perpX = -dy;
        const perpY = dx;
        
        outerPoints.push({
          x: pt.x + perpX * halfPlankWidth,
          y: pt.y + perpY * halfPlankWidth
        });
        
        innerPoints.push({
          x: pt.x - perpX * halfPlankWidth,
          y: pt.y - perpY * halfPlankWidth
        });
      }
      
      // Draw the outline
      this.ctx.moveTo(outerPoints[0].x, outerPoints[0].y);
      for (let i = 1; i < outerPoints.length; i++) {
        this.ctx.lineTo(outerPoints[i].x, outerPoints[i].y);
      }
      for (let i = innerPoints.length - 1; i >= 0; i--) {
        this.ctx.lineTo(innerPoints[i].x, innerPoints[i].y);
      }
      this.ctx.closePath();
      this.ctx.stroke();
    } else {
      // For straight planks and other modules, use full transform
      // Transform to ship's coordinate system
      this.ctx.translate(camera.worldToScreen(ship.position).x, camera.worldToScreen(ship.position).y);
      this.ctx.rotate(ship.rotation);
      this.ctx.scale(camera.getState().zoom, camera.getState().zoom);
      
      // Transform to module's local position and rotation
      this.ctx.translate(module.localPos.x, module.localPos.y);
      this.ctx.rotate(module.localRot);
      
      // Draw highlight based on module type
      this.ctx.strokeStyle = '#00ff00'; // Green
      this.ctx.lineWidth = 3 / camera.getState().zoom;
      
      if (moduleData.kind === 'plank') {
        // Straight plank
        const width = moduleData.length || 20;
        const height = moduleData.width || 10;
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        this.ctx.strokeRect(-halfWidth, -halfHeight, width, height);
      } else if (moduleData.kind === 'cannon') {
        // Draw cannon highlight
        const width = 30;
        const height = 20;
        this.ctx.strokeRect(-width/2, -height/2, width, height);
      } else {
        // Default highlight for other modules
        const size = 20;
        this.ctx.strokeRect(-size/2, -size/2, size, size);
      }
    }
    
    this.ctx.restore();
  }
}
