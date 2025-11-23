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
import { WorldState, Ship, Player, Cannonball } from '../../sim/Types.js';
import { Vec2 } from '../../common/Vec2.js';
import { ClientState } from '../ClientApplication.js';

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
   * Toggle hover boundary debug visualization
   */
  toggleHoverBoundaries(): void {
    this.showHoverBoundaries = !this.showHoverBoundaries;
    console.log(`🔍 Hover boundaries debug: ${this.showHoverBoundaries ? 'ON' : 'OFF'}`);
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
    
    // Queue ships (background layer)
    for (const ship of worldState.ships) {
      this.queueRenderItem(1, 'ships', () => this.drawShip(ship, camera));
    }
    
    // Queue players (middle layer)
    for (const player of worldState.players) {
      this.queueRenderItem(2, 'players', () => this.drawPlayer(player, camera));
    }
    
    // Queue cannonballs (foreground layer)  
    for (const cannonball of worldState.cannonballs) {
      this.queueRenderItem(3, 'cannonballs', () => this.drawCannonball(cannonball, camera));
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
  
  private drawShip(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return; // Skip off-screen ships
    }
    
    this.ctx.save();
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    // Draw ship hull
    this.drawShipHull(ship);
    
    // Draw planks (on top of hull)
    this.drawShipPlanks(ship);
    
    // Draw ship direction indicator
    this.ctx.strokeStyle = '#ff0000';
    this.ctx.lineWidth = 4 / cameraState.zoom;
    this.ctx.beginPath();
    this.ctx.moveTo(0, 0);
    this.ctx.lineTo(80, 0);
    this.ctx.stroke();
    
    this.ctx.restore();
  }
  
  private drawShipHull(ship: Ship): void {
    if (ship.hull.length === 0) return;
    
    this.ctx.strokeStyle = '#8B4513'; // Brown
    this.ctx.fillStyle = '#DEB887'; // BurlyWood
    this.ctx.lineWidth = 2;
    
    this.ctx.beginPath();
    this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    
    for (let i = 1; i < ship.hull.length; i++) {
      this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    }
    
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
  }
  
  private drawShipPlanks(ship: Ship): void {
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
  
  private drawPlayer(player: Player, camera: Camera): void {
    // Check if player is visible
    if (!camera.isWorldPositionVisible(player.position, 50)) {
      return; // Skip off-screen players
    }
    
    const screenPos = camera.worldToScreen(player.position);
    const cameraState = camera.getState();
    const scaledRadius = player.radius * cameraState.zoom;
    
    // Draw player circle
    this.ctx.fillStyle = player.onDeck ? '#00ff00' : '#ff0000';
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();
    
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
    
    // Draw cannonball
    this.ctx.fillStyle = '#333333'; // Dark gray
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth = 1;
    
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();
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
    
    // Add type-specific info
    if (moduleData.kind === 'plank') {
      const healthPercent = moduleData.health.toFixed(1);
      lines.push(`Health: ${healthPercent}%`);
      lines.push(`Material: ${moduleData.material}`);
      if (moduleData.sectionName) {
        lines.push(`Section: ${moduleData.sectionName}`);
      }
      if (moduleData.isCurved) {
        lines.push(`Type: CURVED`);
      }
    } else if (moduleData.kind === 'cannon') {
      lines.push(`Ammo: ${moduleData.ammunition}/${moduleData.maxAmmunition}`);
      lines.push(`Reload: ${moduleData.timeSinceLastFire.toFixed(1)}s`);
    } else if (moduleData.kind === 'helm' || moduleData.kind === 'steering-wheel') {
      lines.push(`Turn Rate: ${moduleData.maxTurnRate.toFixed(2)}`);
      lines.push(`Responsiveness: ${(moduleData.responsiveness * 100).toFixed(0)}%`);
    }
    
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
