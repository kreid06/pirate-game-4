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
import { WorldState, Ship, Player, Cannonball, Npc, NPC_STATE_MOVING, NPC_STATE_AT_CANNON, GhostPlacement, GhostModuleKind, COMPANY_NEUTRAL, COMPANY_PIRATES, COMPANY_NAVY } from '../../sim/Types.js';
import { ShipModule, createCompleteHullSegments, PlankSegment, PlankModuleData, getModuleFootprint, footprintsOverlap } from '../../sim/modules.js';
import { Vec2 } from '../../common/Vec2.js';
import { PolygonUtils } from '../../common/PolygonUtils.js';
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
  private hoveredNpc: Npc | null = null;

  // Build mode state
  private buildMode: boolean = false;
  /** Whether cannon replacement build mode is active (cannon item held). */
  private cannonBuildMode: boolean = false;
  /** The cannon slot (index+ship) currently under the cursor in cannon build mode. */
  private hoveredCannonSlot: { ship: Ship; cannonIndex: number } | null = null;
  /** Whether mast replacement build mode is active (sail item held). */
  private mastBuildMode: boolean = false;
  /** The mast slot (mastIndex+ship) currently under the cursor in mast build mode. */
  private hoveredMastSlot: { ship: Ship; mastIndex: number } | null = null;
  /** An existing but fiber-damaged mast within sail radius of the cursor — for R-key repair. */
  private hoveredDamagedMast: { ship: Ship; mastIndex: number } | null = null;
  /** Whether helm replacement build mode is active (helm_kit item held). */
  private helmBuildMode: boolean = false;
  /** Whether the helm ghost is hovered in helm build mode. */
  private hoveredHelmSlot: { ship: Ship } | null = null;
  /** Whether deck placement build mode is active (deck item held). */
  private deckBuildMode: boolean = false;
  /** Whether the deck ghost is hovered in deck build mode. */
  private hoveredDeckSlot: { ship: Ship } | null = null;
  /** Set by ClientApplication each frame — true when the local player is holding right-mouse. */
  public playerIsAiming: boolean = false;
  /** The assigned local player ID, so guides only draw for that player's cannon. */
  public localPlayerId: number | null = null;
  /** Player position info used by the hover tooltip to determine interact range. */
  public playerInteractInfo: { worldPos: Vec2; localPos: Vec2 | null; carrierId: number | null } | null = null;
  /** Weapon control groups — set by ClientApplication each frame. Null when not on helm. */
  public controlGroups: Map<number, { cannonIds: number[]; mode: string }> | null = null;
  /** When true, draws group membership badges on all cannons (while Shift is held). */
  public showGroupOverlay: boolean = false;
  /** Currently selected weapon group indices — cannons in these groups are always highlighted. */
  public activeWeaponGroups: Set<number> = new Set();
  /** Cached local player company for the current frame — set at start of queueWorldObjects. */
  private _localCompanyId: number = 0;
  /** Current aim angle relative to ship (from InputManager), used for cannon sector filtering. */
  public playerAimAngleRelative: number = 0;
  /** Currently selected ammo type (0 = cannonball, 1 = bar shot), set each frame by ClientApplication. */
  public selectedAmmoType: number = 0;
  /** npcId → task name map set each frame by ClientApplication; used to colour NPCs by task. */
  public npcTaskMap: ReadonlyMap<number, string> = new Map();
  private hoveredPlankSlot: { ship: Ship; sectionName: string; segmentIndex: number } | null = null;
  private plankTemplate: PlankSegment[] | null = null;
  /** shipId → timestamp (ms) when ship entered the sink-fade sequence — drives the animation. */
  private sinkTimestamps: Map<number, number> = new Map();
  /** Frozen ship snapshots for despawned ships — client-side sink animation ghosts. */
  private sinkingGhosts: Map<number, Ship> = new Map();
  /** Last known ship state per id — lets us snapshot a ship the moment it despawns. */
  private lastKnownShips: Map<number, Ship> = new Map();
  
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
   * Spawn sail fiber tear particles at a world position (bar shot mast hit)
   */
  spawnSailFiberEffect(worldPos: Vec2, intensity: number = 1.0): void {
    this.particleSystem.createSailFiberEffect(worldPos, intensity);
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
   * Enable or disable cannon replacement build mode
   */
  setCannonBuildMode(active: boolean): void {
    this.cannonBuildMode = active;
    if (!active) this.hoveredCannonSlot = null;
  }

  /**
   * Enable or disable mast replacement build mode
   */
  setMastBuildMode(active: boolean): void {
    this.mastBuildMode = active;
    if (!active) this.hoveredMastSlot = null;
  }

  /**
   * Whether mast build mode is currently active
   */
  isInMastBuildMode(): boolean {
    return this.mastBuildMode;
  }

  /**
   * Get the mast slot currently under the cursor (only in mast build mode)
   */
  getHoveredMastSlot(): { ship: Ship; mastIndex: number } | null {
    return this.hoveredMastSlot;
  }

  /**
   * Get an existing but sail-damaged mast under the cursor (for R-key repair).
   * Returns { ship, mastIndex } when the cursor is within the sail radius (40px) of a mast
   * whose fiber openness < 100 or wind_efficiency < 1.
   */
  getHoveredDamagedMast(): { ship: Ship; mastIndex: number } | null {
    return this.hoveredDamagedMast;
  }

  /**
   * Enable or disable helm replacement build mode
   */
  setHelmBuildMode(active: boolean): void {
    this.helmBuildMode = active;
    if (!active) this.hoveredHelmSlot = null;
  }

  /**
   * Whether helm build mode is currently active
   */
  isInHelmBuildMode(): boolean {
    return this.helmBuildMode;
  }

  /**
   * Get the helm ghost if hovered (only in helm build mode)
   */
  getHoveredHelmSlot(): { ship: Ship } | null {
    return this.hoveredHelmSlot;
  }

  /**
   * Enable or disable deck placement build mode
   */
  setDeckBuildMode(active: boolean): void {
    this.deckBuildMode = active;
    if (!active) this.hoveredDeckSlot = null;
  }

  /** Whether deck build mode is currently active */
  isInDeckBuildMode(): boolean {
    return this.deckBuildMode;
  }

  /** Get the ship whose deck slot is hovered (only in deck build mode) */
  getHoveredDeckSlot(): { ship: Ship } | null {
    return this.hoveredDeckSlot;
  }

  /**
   * Whether cannon build mode is currently active
   */
  isInCannonBuildMode(): boolean {
    return this.cannonBuildMode;
  }

  /**
   * Get the cannon slot currently under the cursor (only in cannon build mode)
   */
  getHoveredCannonSlot(): { ship: Ship; cannonIndex: number } | null {
    return this.hoveredCannonSlot;
  }

  /** Whether build mode is currently active */
  isInBuildMode(): boolean {
    return this.buildMode;
  }

  // Explicit B-key build mode ghost preview state
  private explicitBuildState: { item: 'cannon' | 'sail'; rotationDeg: number } | null = null;

  // Ghost placement plan markers and pending ghost cursor
  private ghostPlacements: GhostPlacement[] = [];
  private pendingGhostState: { kind: GhostModuleKind; rotDeg: number } | null = null;
  private buildMenuOpen = false;

  /**
   * Set explicit build mode state for ghost preview rendering.
   * Pass null to disable.
   */
  setExplicitBuildMode(state: { item: 'cannon' | 'sail'; rotationDeg: number } | null): void {
    this.explicitBuildState = state;
  }

  /** Update the list of ghost planning markers to render on ships. */
  setGhostPlacements(ghosts: GhostPlacement[]): void {
    this.ghostPlacements = ghosts;
  }

  /** Track whether the build menu is open so ghost plans are only shown then. */
  setBuildMenuOpen(open: boolean): void {
    this.buildMenuOpen = open;
  }

  /** Set the ghost currently attached to the cursor for precision ghost placement. Pass null to clear. */
  setPendingGhost(state: { kind: GhostModuleKind; rotDeg: number } | null): void {
    this.pendingGhostState = state;
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
      
      // --- Pass 1: ladders take priority over planks ---
      for (const module of ship.modules) {
        if (!module.moduleData) continue;
        const moduleData = module.moduleData;
        if (moduleData.kind !== 'ladder') continue;
        
        // Ladder renders as fillRect(-10, -20, 20, 40) centered at localPos with localRot
        const halfWidth = 10;  // 20 / 2
        const halfHeight = 20; // 40 / 2
        
        const mdx = localX - module.localPos.x;
        const mdy = localY - module.localPos.y;
        const mcos = Math.cos(-(module.localRot || 0));
        const msin = Math.sin(-(module.localRot || 0));
        const modLocalX = mdx * mcos - mdy * msin;
        const modLocalY = mdx * msin + mdy * mcos;
        
        if (Math.abs(modLocalX) <= halfWidth && Math.abs(modLocalY) <= halfHeight) {
          this.hoveredModule = { ship, module };
          return;
        }
      }
      
      // --- Pass 2: everything else (planks, cannons, masts, etc.) ---
      for (const module of ship.modules) {
        // Ladders already checked in pass 1
        if ((module.moduleData?.kind ?? module.kind) === 'ladder') continue;

        const moduleKind = module.moduleData?.kind ?? module.kind;

        // Special handling for curved planks
        if (module.moduleData && moduleKind === 'plank' && module.moduleData.kind === 'plank' && module.moduleData.isCurved && module.moduleData.curveData) {
          // Check if mouse is within curved plank boundary
          if (this.isPointInCurvedPlank(localX, localY, module.moduleData.curveData, module.moduleData.width)) {
            this.hoveredModule = { ship, module };
            return; // Found a match, stop searching
          }
          continue; // Skip regular rectangle check for curved planks
        }
        
        // Regular rectangle check for straight modules
        let width = 20;
        let height = 20;
        
        if (moduleKind === 'plank' && module.moduleData?.kind === 'plank') {
          width = module.moduleData.length || 20;
          height = module.moduleData.width || 10;
        } else if (moduleKind === 'cannon') {
          width = 30;
          height = 20;
        } else if (moduleKind === 'mast') {
          // Masts are circles, so use radius for both width and height
          const radius = (module.moduleData?.kind === 'mast' && module.moduleData.radius) || 15;
          width = radius * 2;
          height = radius * 2;
        } else if (moduleKind === 'helm' || moduleKind === 'steering-wheel') {
          // Helm renders as a circle with radius 8
          width = 16;
          height = 16;
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
  /**
   * Lerp a hex colour toward black proportionally to damage taken.
   * healthRatio 1.0 = full health (original colour), 0.0 = destroyed (black).
   */
  private darkenByDamage(hex: string, healthRatio: number): string {
    const t = Math.max(0, Math.min(1, healthRatio));
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * t)},${Math.round(g * t)},${Math.round(b * t)})`;
  }

  /**
   * Returns sinking-related render state for a ship.
   *  waterFill    0–1 : fraction of hull filled with water (1 - hullHealth/100)
   *  floodTint    0–1 : how blue the deck is (ramps up from waterFill=0.75 → 1.0)
   *  phase1Alpha  1–0 : hull / deck / planks fade (0–4 s after despawn)
   *  phase2Alpha  1–0 : cannons fade (2–6 s after despawn)
   *  phase3Alpha  1–0 : sail fibers & masts fade (4–8 s after despawn)
   *
   * Phase fades only activate for ghost ships (in sinkTimestamps).
   * Live ships only get the blue flood tint from their current hullHealth.
   */
  /** Called by ClientApplication when the server sends SHIP_SINKING — starts the fade clock. */
  public markShipSinking(shipId: number): void {
    if (!this.sinkTimestamps.has(shipId)) {
      this.sinkTimestamps.set(shipId, performance.now());
    }
  }

  private computeSinkState(ship: Ship): {
    waterFill: number;
    floodTint: number;
    phase1Alpha: number;
    phase2Alpha: number;
    phase3Alpha: number;
  } {
    const waterFill = Math.max(0, Math.min(1, 1 - ship.hullHealth / 100));
    const floodTint = waterFill >= 0.75 ? (waterFill - 0.75) / 0.25 : 0;

    // Start the clock for any live ship the moment hullHealth hits 0 (fallback if SHIP_SINKING arrives late)
    if (ship.hullHealth <= 0 && !this.sinkTimestamps.has(ship.id)) {
      this.sinkTimestamps.set(ship.id, performance.now());
    }

    let phase1Alpha = 1, phase2Alpha = 1, phase3Alpha = 1;
    const sinkStart = this.sinkTimestamps.get(ship.id);
    if (sinkStart !== undefined) {
      const elapsed = (performance.now() - sinkStart) / 1000;
      phase1Alpha = Math.max(0, 1 - elapsed / 4);                         // 0–4 s
      phase2Alpha = Math.max(0, 1 - Math.max(0, elapsed - 2) / 4);        // 2–6 s
      phase3Alpha = Math.max(0, 1 - Math.max(0, elapsed - 4) / 4);        // 4–8 s
    }
    return { waterFill, floodTint, phase1Alpha, phase2Alpha, phase3Alpha };
  }

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
    this.detectHoveredNpc(worldState);

    // In build mode, detect which missing plank slot is under the cursor
    if (this.buildMode) {
      this.detectHoveredPlankSlot(worldState);
    } else {
      this.hoveredPlankSlot = null;
    }

    // In cannon build mode, detect which missing cannon slot is under the cursor
    if (this.cannonBuildMode) {
      this.detectHoveredCannonSlot(worldState);
    } else {
      this.hoveredCannonSlot = null;
    }

    // In mast build mode, detect which missing mast slot is under the cursor
    if (this.mastBuildMode) {
      this.detectHoveredMastSlot(worldState);
    } else {
      this.hoveredMastSlot = null;
    }

    // Always detect fiber-damaged masts for R-key repair (independent of build mode)
    this.detectHoveredDamagedMast(worldState);

    // In helm build mode, detect whether the missing helm is under the cursor
    if (this.helmBuildMode) {
      this.detectHoveredHelmSlot(worldState);
    } else {
      this.hoveredHelmSlot = null;
    }

    // In deck build mode, detect whether the missing deck slot is under the cursor
    if (this.deckBuildMode) {
      this.detectHoveredDeckSlot(worldState);
    } else {
      this.hoveredDeckSlot = null;
    }

    // Draw background elements
    this.drawWater(camera);
    this.drawGrid(camera);
    
    // Queue all game objects for layered rendering
    this.queueWorldObjects(worldState, camera, interpolationAlpha);
    
    // Execute render queue in layer order
    this.executeRenderQueue();

    // Draw explicit B-key build mode ghost (always on top of world objects)
    if (this.explicitBuildState) {
      this.drawExplicitBuildGhost(worldState, camera);
    }

    // Draw pending ghost cursor attached to mouse
    if (this.pendingGhostState) {
      this.drawPendingGhostCursor(worldState, camera);
    }

    // Draw effects and particles (always on top)
    this.particleSystem.render(camera);
    this.effectRenderer.render(camera);
    
    // Draw hover boundaries debug if enabled
    if (this.showHoverBoundaries) {
      this.drawHoverBoundariesDebug(worldState, camera);
    }
    
    // Draw hover tooltip (screen space, on top of everything)
    this.drawHoverTooltip(camera);
    this.drawNpcTooltip(camera);
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

    // Cache local player's company for enemy-coloring this frame
    const localPlayer = this.localPlayerId != null
      ? worldState.players.find(p => p.id === this.localPlayerId)
      : null;
    this._localCompanyId = localPlayer?.companyId ?? 0;

    // ── Sinking ghost management ────────────────────────────────────────────
    // Track every live ship so we can detect despawns frame-to-frame.
    const currentShipIds = new Set<number>();
    for (const ship of worldState.ships) {
      currentShipIds.add(ship.id);
      this.lastKnownShips.set(ship.id, ship);
    }
    // Any ship present last frame but gone now just despawned.
    // Only create a sinking ghost if the server explicitly told us this ship is sinking
    // (sinkTimestamps entry already set via markShipSinking / computeSinkState).
    // Ships that disconnect, get admin-removed, etc. receive no animation.
    for (const [id, snap] of this.lastKnownShips) {
      if (!currentShipIds.has(id)) {
        if (!this.sinkingGhosts.has(id) && this.sinkTimestamps.has(id)) {
          this.sinkingGhosts.set(id, { ...snap, hullHealth: 0 });
        }
        this.lastKnownShips.delete(id);
      }
    }
    // Prune fully-faded ghosts (> 8 s elapsed).
    for (const [id, startTime] of this.sinkTimestamps) {
      if (!currentShipIds.has(id) && (performance.now() - startTime) / 1000 > 8) {
        this.sinkTimestamps.delete(id);
        this.sinkingGhosts.delete(id);
      }
    }
    // ───────────────────────────────────────────────────────────────────────
    
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

    // Plank status icons — missing (red ✕) and leaking (water waves) — layer 3 priority 2
    for (const ship of worldState.ships) {
      this.queueRenderItem(3, 'plank-status', () => this.drawPlankStatusIcons(ship, camera), 2);
    }

    // Ghost placement plan markers — visible in build menu mode, B-key mode, or hotbar build mode
    if (this.ghostPlacements.length > 0 &&
        (this.buildMenuOpen || this.explicitBuildState !== null || this.cannonBuildMode || this.mastBuildMode)) {
      for (const ship of worldState.ships) {
        const shipGhosts = this.ghostPlacements.filter(g => g.shipId === ship.id);
        if (shipGhosts.length > 0) {
          this.queueRenderItem(3, `ghost-plans-${ship.id}`, () => this.drawGhostPlacements(ship, shipGhosts, camera), 4);
        }
      }
    }

    // In cannon build mode, overlay ghost cannons at destroyed slots (layer 4, after real cannons)
    if (this.cannonBuildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(4, 'cannon-ghosts', () => this.drawMissingCannonGhosts(ship, camera), 1);
      }
    }

    // In mast build mode, overlay ghost masts at destroyed slots (layer 7, after real masts)
    if (this.mastBuildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(7, 'mast-ghosts', () => this.drawMissingMastGhosts(ship, camera), 1);
      }
    }

    // In helm build mode, overlay ghost helm if missing (layer 5, with steering wheels)
    if (this.helmBuildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(5, 'helm-ghost', () => this.drawMissingHelmGhost(ship, camera), 1);
      }
    }

    // In deck build mode, overlay ghost deck outline if missing (layer 3, under planks)
    if (this.deckBuildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(3, 'deck-ghost', () => this.drawMissingDeckGhost(ship, camera), 0);
      }
    }
    
    // Queue cannons and steering wheels (layers 4-6)
    for (const ship of worldState.ships) {
      this.queueRenderItem(4, 'cannons', () => this.drawShipCannons(ship, camera));
      this.queueRenderItem(4, 'cannon-aim-guides', () => this.drawCannonAimGuides(ship, worldState, camera), 1);
      this.queueRenderItem(4, 'rudder', () => this.drawShipRudder(ship, camera));
      if ((this.showGroupOverlay || this.activeWeaponGroups.size > 0) && this.controlGroups) {
        this.queueRenderItem(5, `cannon-groups-${ship.id}`, () => this.drawCannonGroupOverlay(ship, camera));
      }
      // Reload indicators always drawn above group overlay (layer 6)
      this.queueRenderItem(6, `cannon-reload-${ship.id}`, () => this.drawCannonReloadIndicators(ship, camera));
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

    // ── Sinking ghost ships (client-side fade-out after server despawn) ──────
    for (const ghost of this.sinkingGhosts.values()) {
      const id = ghost.id;
      this.queueRenderItem(1, `ghost-hull-${id}`,       () => this.drawShipHull(ghost, camera));
      this.queueRenderItem(3, `ghost-planks-${id}`,     () => this.drawShipPlanks(ghost, camera));
      this.queueRenderItem(4, `ghost-cannons-${id}`,    () => this.drawShipCannons(ghost, camera));
      this.queueRenderItem(4, `ghost-rudder-${id}`,     () => this.drawShipRudder(ghost, camera));
      this.queueRenderItem(5, `ghost-wheels-${id}`,     () => this.drawShipSteeringWheels(ghost, camera));
      this.queueRenderItem(5, `ghost-ladders-${id}`,    () => this.drawShipLadders(ghost, camera));
      this.queueRenderItem(5, `ghost-ropes-${id}`,      () => this.drawShipSailRopes(ghost, camera));
      this.queueRenderItem(6, `ghost-fibers-${id}`,     () => this.drawShipSailFibers(ghost, camera));
      this.queueRenderItem(7, `ghost-masts-${id}`,      () => this.drawShipSailMasts(ghost, camera));
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

    const { floodTint, phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return; // fully faded — nothing to draw
    
    this.ctx.save();
    if (phase1Alpha < 1) this.ctx.globalAlpha = phase1Alpha;
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    this.ctx.strokeStyle = '#8B4513'; // Brown
    this.ctx.fillStyle = '#DEB887'; // BurlyWood

    // Enemy ship: dark blue hull
    const isEnemy = this._localCompanyId !== 0 && ship.companyId !== 0
      && ship.companyId !== this._localCompanyId;
    if (isEnemy) {
      this.ctx.strokeStyle = '#1a1a4a';
      this.ctx.fillStyle = '#1e3a6e';
    }
    this.ctx.lineWidth = 2 / cameraState.zoom;
    
    this.ctx.beginPath();
    this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    
    for (let i = 1; i < ship.hull.length; i++) {
      this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    }
    
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();

    // Water flood tint: blue overlay that intensifies from 75% → 100% water
    if (floodTint > 0) {
      this.ctx.globalAlpha = floodTint * 0.55 * (phase1Alpha < 1 ? phase1Alpha : 1);
      this.ctx.fillStyle = '#1a6eb5';
      this.ctx.beginPath();
      this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
      for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
      this.ctx.closePath();
      this.ctx.fill();
    }
    
    // Draw ship direction indicator
    this.ctx.globalAlpha = phase1Alpha < 1 ? phase1Alpha : 1;
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

    const { floodTint, phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;
    
    this.ctx.save();
    if (phase1Alpha < 1) this.ctx.globalAlpha = phase1Alpha;
    
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
      
      // Smoothly darken toward black as health decreases
      const maxHealth = plankData.maxHealth || 10000;
      const healthRatio = Math.max(0, health / maxHealth);
      const fillColor   = this.darkenByDamage('#8B7355', healthRatio);
      const strokeColor = this.darkenByDamage('#4A3020', healthRatio);
      
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

    // Water flood tint: blue overlay painted on top of each plank
    if (floodTint > 0) {
      const tintAlpha = floodTint * 0.50 * (phase1Alpha < 1 ? phase1Alpha : 1);
      for (const plank of planks) {
        if (!plank.moduleData || plank.moduleData.kind !== 'plank') continue;
        if ((plank.moduleData.health ?? 1) <= 0) continue;
        this.ctx.save();
        this.ctx.globalAlpha = tintAlpha;
        this.ctx.fillStyle = '#1a6eb5';
        if (plank.moduleData.isCurved && plank.moduleData.curveData) {
          // Approximate the curved plank outline using the bezier start/end points
          const cd = plank.moduleData.curveData;
          const w = plank.moduleData.width;
          const s = cd.start, e = cd.end;
          const nx = -(e.y - s.y), ny = (e.x - s.x);
          const nlen = Math.hypot(nx, ny) || 1;
          const ox = (nx / nlen) * w * 0.5, oy = (ny / nlen) * w * 0.5;
          this.ctx.beginPath();
          this.ctx.moveTo(s.x - ox, s.y - oy);
          this.ctx.lineTo(s.x + ox, s.y + oy);
          this.ctx.lineTo(e.x + ox, e.y + oy);
          this.ctx.lineTo(e.x - ox, e.y - oy);
          this.ctx.closePath();
          this.ctx.fill();
        } else {
          this.ctx.translate(plank.localPos.x, plank.localPos.y);
          this.ctx.rotate(plank.localRot);
          const hl = plank.moduleData.length / 2;
          const hw = plank.moduleData.width / 2;
          this.ctx.fillRect(-hl, -hw, plank.moduleData.length, plank.moduleData.width);
        }
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

  /**
   * Draw semi-transparent status icons on planks for friendly ships:
   *   Red circle + X  — plank slot is missing entirely
   *   Blue wave lines — plank is leaking (health < 30% max)
   */
  private drawPlankStatusIcons(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    // Only show for own company or neutral ships — hide from enemies
    const isEnemy = this._localCompanyId !== 0 && ship.companyId !== 0
      && ship.companyId !== this._localCompanyId;
    if (isEnemy) return;

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const iconR = 16.5; // icon radius in ship-local units (3× base for visibility)

    // ── MISSING planks ───────────────────────────────────────────────────────
    const presentKeys = new Set<string>();
    const plankModules = ship.modules.filter(
      m => m.kind === 'plank' && m.moduleData?.kind === 'plank'
    );
    for (const pm of plankModules) {
      const pd = pm.moduleData as PlankModuleData;
      presentKeys.add(`${pd.sectionName}_${pd.segmentIndex}`);
    }

    const template = this.getPlankTemplate();
    for (const seg of template) {
      if (presentKeys.has(`${seg.sectionName}_${seg.index}`)) continue;

      let cx: number, cy: number;
      if (seg.isCurved && seg.curveStart && seg.curveControl && seg.curveEnd
          && seg.t1 !== undefined && seg.t2 !== undefined) {
        const pt = this.getQuadraticPoint(
          seg.curveStart, seg.curveControl, seg.curveEnd,
          (seg.t1 + seg.t2) / 2
        );
        cx = pt.x; cy = pt.y;
      } else {
        cx = (seg.start.x + seg.end.x) / 2;
        cy = (seg.start.y + seg.end.y) / 2;
      }
      this.drawMissingPlankIcon(cx, cy, iconR);
    }

    // ── LEAKING planks ───────────────────────────────────────────────────────
    for (const pm of plankModules) {
      const pd = pm.moduleData as PlankModuleData;
      if (pd.health <= 0) continue; // already counted as missing above
      const leakThreshold = (pd.maxHealth || 10000) * 0.30;
      if (pd.health >= leakThreshold) continue;

      let cx: number, cy: number;
      if (pd.isCurved && pd.curveData) {
        const pt = this.getQuadraticPoint(
          pd.curveData.start, pd.curveData.control, pd.curveData.end,
          (pd.curveData.t1 + pd.curveData.t2) / 2
        );
        cx = pt.x; cy = pt.y;
      } else {
        cx = pm.localPos.x;
        cy = pm.localPos.y;
      }
      this.drawLeakingPlankIcon(cx, cy, iconR);
    }

    // ── DECK status ──────────────────────────────────────────────────────────
    const deckMod = ship.modules.find(m => m.kind === 'deck');
    if (!deckMod) {
      // No deck present — draw a persistent orange warning at ship center
      this.drawMissingDeckIcon(0, 0, 22);
    } else {
      // Deck present but damaged — draw a health bar at ship center
      const dmd = deckMod.moduleData as any;
      if (dmd && typeof dmd.health === 'number' && typeof dmd.maxHealth === 'number'
          && dmd.maxHealth > 0 && dmd.health < dmd.maxHealth) {
        this.drawDeckHealthBar(0, 0, dmd.health / dmd.maxHealth);
      }
    }

    this.ctx.restore();
  }

  /** Orange circle with "!" mark — missing deck warning. */
  private drawMissingDeckIcon(cx: number, cy: number, r: number): void {
    this.ctx.save();
    this.ctx.globalAlpha = 0.82;

    // Filled circle background
    this.ctx.fillStyle = 'rgba(255,140,0,0.25)';
    this.ctx.strokeStyle = '#ff8c00';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    // "!" exclamation mark
    this.ctx.strokeStyle = '#ffaa33';
    this.ctx.lineWidth = 2.2;
    this.ctx.lineCap = 'round';
    // Vertical bar
    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy - r * 0.52);
    this.ctx.lineTo(cx, cy + r * 0.12);
    this.ctx.stroke();
    // Dot
    this.ctx.beginPath();
    this.ctx.arc(cx, cy + r * 0.42, 1.6, 0, Math.PI * 2);
    this.ctx.fillStyle = '#ffaa33';
    this.ctx.fill();

    this.ctx.restore();
  }

  /** Small horizontal health bar drawn at ship-local (cx, cy) for the deck module. */
  private drawDeckHealthBar(cx: number, cy: number, fraction: number): void {
    const barW = 44;
    const barH = 6;
    const x0 = cx - barW / 2;
    const y0 = cy - barH / 2;

    this.ctx.save();
    this.ctx.globalAlpha = 0.85;

    // Background
    this.ctx.fillStyle = 'rgba(0,0,0,0.45)';
    this.ctx.beginPath();
    this.ctx.roundRect(x0 - 1, y0 - 1, barW + 2, barH + 2, 3);
    this.ctx.fill();

    // Filled portion — gradient from orange (low) to green (full)
    const r = Math.round(255 * (1 - fraction));
    const g = Math.round(200 * fraction);
    this.ctx.fillStyle = `rgb(${r},${g},30)`;
    this.ctx.beginPath();
    this.ctx.roundRect(x0, y0, Math.max(2, barW * fraction), barH, 2);
    this.ctx.fill();

    // Border
    this.ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    this.ctx.lineWidth = 0.6;
    this.ctx.beginPath();
    this.ctx.roundRect(x0, y0, barW, barH, 2);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /** Semi-transparent red circle with an × mark (missing plank). Pulsates for attention. */
  private drawMissingPlankIcon(cx: number, cy: number, r: number): void {
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(Date.now() / 480));
    this.ctx.save();
    this.ctx.globalAlpha = 0.72 * pulse;

    // Filled circle background
    this.ctx.fillStyle = 'rgba(220,30,30,0.30)';
    this.ctx.strokeStyle = '#ff4444';
    this.ctx.lineWidth = 1.2;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    // × arms
    const arm = r * 0.55;
    this.ctx.strokeStyle = '#ff5555';
    this.ctx.lineWidth = 1.5;
    this.ctx.lineCap = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(cx - arm, cy - arm); this.ctx.lineTo(cx + arm, cy + arm);
    this.ctx.moveTo(cx + arm, cy - arm); this.ctx.lineTo(cx - arm, cy + arm);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /** Water-drop icons (leaking plank): three flat teardrops, pulsating. */
  private drawLeakingPlankIcon(cx: number, cy: number, r: number): void {
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(Date.now() / 480));
    this.ctx.save();
    this.ctx.globalAlpha = 0.82 * pulse;
    this.ctx.fillStyle = '#33aaff';

    // Drop positions: top-centre, bottom-left, bottom-right
    const dropR  = r * 0.30;
    const spread = r * 0.38;
    const drops: [number, number][] = [
      [cx,          cy - spread * 0.7],
      [cx - spread, cy + spread * 0.5],
      [cx + spread, cy + spread * 0.5],
    ];

    for (const [dx, dy] of drops) {
      this.ctx.beginPath();
      this.ctx.moveTo(dx, dy - dropR * 1.55);          // pointed tip
      this.ctx.bezierCurveTo(
        dx + dropR * 0.9, dy - dropR * 0.3,
        dx + dropR,       dy + dropR * 0.5,
        dx,               dy + dropR
      );
      this.ctx.bezierCurveTo(
        dx - dropR,       dy + dropR * 0.5,
        dx - dropR * 0.9, dy - dropR * 0.3,
        dx,               dy - dropR * 1.55
      );
      this.ctx.closePath();
      this.ctx.fill();
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
  
  // Brigantine cannon layout: cannon_xs[3] = {-35, 65, -135}
  // Port side (i < 3): y = +75, rot = PI; Starboard (i >= 3): y = -75, rot = 0
  private static readonly CANNON_XS = [-35, 65, -135];

  /**
   * Detect which missing cannon slot the cursor is over (cannon build mode only).
   * Hover is within 22px of the cannon center in ship-local space.
   */
  private detectHoveredCannonSlot(worldState: WorldState): void {
    this.hoveredCannonSlot = null;
    if (!this.mouseWorldPos) return;

    for (const ship of worldState.ships) {
      const helm = ship.modules.find(m => m.kind === 'helm');
      if (!helm) continue;
      const base = helm.id;

      const presentIds = new Set(ship.modules.map(m => m.id));

      // Transform mouse to ship-local space
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      for (let i = 0; i < 6; i++) {
        if (presentIds.has(base + 1 + i)) continue; // cannon present

        const cx = RenderSystem.CANNON_XS[i % 3];
        const cy = i < 3 ? 75 : -75;
        const ddx = localX - cx;
        const ddy = localY - cy;
        if (Math.sqrt(ddx * ddx + ddy * ddy) <= 22) {
          this.hoveredCannonSlot = { ship, cannonIndex: i };
          return;
        }
      }
    }
  }

  /**
   * Draw ghost outlines at missing cannon positions (cannon build mode).
   */
  private drawMissingCannonGhosts(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const helm = ship.modules.find(m => m.kind === 'helm');
    if (!helm) return;
    const base = helm.id;

    const presentIds = new Set(ship.modules.map(m => m.id));

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;

    for (let i = 0; i < 6; i++) {
      if (presentIds.has(base + 1 + i)) continue;

      const cx = RenderSystem.CANNON_XS[i % 3];
      const cy = i < 3 ? 75 : -75;
      const rot = i < 3 ? Math.PI : 0;

      const isHovered = this.hoveredCannonSlot?.ship === ship &&
                        this.hoveredCannonSlot?.cannonIndex === i;

      this.ctx.save();
      this.ctx.translate(cx, cy);
      this.ctx.rotate(rot);

      // Ghost cannon base rect — unified green palette
      this.ctx.strokeStyle = isHovered ? '#66ee99' : 'rgba(80,210,130,0.65)';
      this.ctx.fillStyle   = isHovered ? 'rgba(40,160,80,0.45)' : 'rgba(40,130,70,0.20)';
      this.ctx.lineWidth   = isHovered ? lw * 2 : lw;
      this.ctx.setLineDash(isHovered ? [] : [4, 3]);
      this.ctx.beginPath();
      this.ctx.rect(-15, -10, 30, 20);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      // Ghost barrel stub
      this.ctx.strokeStyle = isHovered ? '#99ffbb' : 'rgba(80,200,120,0.45)';
      this.ctx.fillStyle   = 'transparent';
      this.ctx.lineWidth   = lw;
      this.ctx.beginPath();
      this.ctx.rect(-8, -40, 16, 40);
      this.ctx.stroke();

      // Hovered: bright highlight circle
      if (isHovered) {
        this.ctx.strokeStyle = '#88ff99';
        this.ctx.lineWidth = lw * 1.5;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 22, 0, Math.PI * 2);
        this.ctx.stroke();
      }

      this.ctx.restore();
    }

    this.ctx.restore();
  }

  // Mast layout: mast_xs[3] = {165, -35, -235}, all at y=0
  private static readonly MAST_XS = [165, -35, -235];
  // Helm position: x=-90, y=0
  private static readonly HELM_X = -90;

  /**
   * Detect which missing mast slot the cursor is over.
   * Hover within 22px of the mast centre in ship-local space.
   */
  private detectHoveredMastSlot(worldState: WorldState): void {
    this.hoveredMastSlot = null;
    if (!this.mouseWorldPos) return;

    for (const ship of worldState.ships) {
      const helm = ship.modules.find(m => m.kind === 'helm');
      if (!helm) continue;
      const base = helm.id;

      const presentIds = new Set(ship.modules.map(m => m.id));

      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      for (let i = 0; i < 3; i++) {
        if (presentIds.has(base + 7 + i)) continue; // mast present

        const mx = RenderSystem.MAST_XS[i];
        const ddx = localX - mx;
        const ddy = localY;
        if (Math.sqrt(ddx * ddx + ddy * ddy) <= 22) {
          this.hoveredMastSlot = { ship, mastIndex: i };
          return;
        }
      }
    }
  }

  /**
   * Detect an existing but sail-fiber-damaged mast under the cursor.
   * Uses the sail radius (40 client-px = sailWidth/2) matching the server's BAR_SHOT_SAIL_RADIUS.
   * Only matches masts whose openness < 100 or wind_efficiency < 1 (i.e. fibers are torn).
   */
  private readonly SAIL_HIT_RADIUS = 40; // matches BAR_SHOT_SAIL_RADIUS on server

  private detectHoveredDamagedMast(worldState: WorldState): void {
    this.hoveredDamagedMast = null;
    if (!this.mouseWorldPos) return;

    for (const ship of worldState.ships) {
      const helm = ship.modules.find(m => m.kind === 'helm');
      if (!helm) continue;
      const base = helm.id;

      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      for (let i = 0; i < 3; i++) {
        const mod = ship.modules.find(m => m.id === base + 7 + i && m.kind === 'mast');
        if (!mod || !mod.moduleData || mod.moduleData.kind !== 'mast') continue;

        const md = mod.moduleData;
        // Only eligible if fibers are actually damaged
        const fibersDamaged = md.fiberHealth < md.fiberMaxHealth;
        if (!fibersDamaged) continue;

        const mx = RenderSystem.MAST_XS[i];
        const ddx = localX - mx;
        const ddy = localY;
        if (Math.sqrt(ddx * ddx + ddy * ddy) <= this.SAIL_HIT_RADIUS) {
          this.hoveredDamagedMast = { ship, mastIndex: i };
          return;
        }
      }
    }
  }

  /**
   * Detect whether the missing helm is under the cursor.
   */
  private detectHoveredHelmSlot(worldState: WorldState): void {
    this.hoveredHelmSlot = null;
    if (!this.mouseWorldPos) return;

    for (const ship of worldState.ships) {
      // Only show ghost when helm is actually missing
      const helmPresent = ship.modules.some(m => m.kind === 'helm');
      if (helmPresent) continue;

      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      const ddx = localX - RenderSystem.HELM_X;
      if (Math.sqrt(ddx * ddx + localY * localY) <= 18) {
        this.hoveredHelmSlot = { ship };
        return;
      }
    }
  }

  /**
   * Draw ghost circles at missing mast positions (mast build mode).
   */
  private drawMissingMastGhosts(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const helm = ship.modules.find(m => m.kind === 'helm');
    if (!helm) return;
    const base = helm.id;

    const presentIds = new Set(ship.modules.map(m => m.id));

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;

    for (let i = 0; i < 3; i++) {
      if (presentIds.has(base + 7 + i)) continue;

      const mx = RenderSystem.MAST_XS[i];
      const isHovered = this.hoveredMastSlot?.ship === ship &&
                        this.hoveredMastSlot?.mastIndex === i;

      // Ghost mast circle — unified green palette (matches plan ghost markers)
      this.ctx.beginPath();
      this.ctx.arc(mx, 0, 14, 0, Math.PI * 2);
      this.ctx.fillStyle   = isHovered ? 'rgba(40,160,80,0.45)' : 'rgba(40,130,70,0.20)';
      this.ctx.strokeStyle = isHovered ? '#66ee99' : 'rgba(80,210,130,0.65)';
      this.ctx.lineWidth   = isHovered ? lw * 2 : lw;
      this.ctx.setLineDash(isHovered ? [] : [4, 3]);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      // Ghost sail stub (vertical line up from mast)
      this.ctx.strokeStyle = isHovered ? '#99ffbb' : 'rgba(80,200,120,0.45)';
      this.ctx.lineWidth   = lw;
      this.ctx.beginPath();
      this.ctx.moveTo(mx, 0);
      this.ctx.lineTo(mx, -50);
      this.ctx.stroke();

      // Hovered: highlight ring
      if (isHovered) {
        this.ctx.beginPath();
        this.ctx.arc(mx, 0, 22, 0, Math.PI * 2);
        this.ctx.strokeStyle = '#88ff99';
        this.ctx.lineWidth   = lw * 1.5;
        this.ctx.stroke();
      }
    }

    this.ctx.restore();
  }

  /**
   * Draw a ghost helm at its position if the helm is destroyed (helm build mode).
   */
  private drawMissingHelmGhost(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const helmPresent = ship.modules.some(m => m.kind === 'helm');
    if (helmPresent) return; // Nothing to draw

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;
    const isHovered = this.hoveredHelmSlot?.ship === ship;

    this.ctx.beginPath();
    this.ctx.arc(RenderSystem.HELM_X, 0, 8, 0, Math.PI * 2);
    this.ctx.fillStyle   = isHovered ? 'rgba(180,80,255,0.40)' : 'rgba(140,60,200,0.18)';
    this.ctx.strokeStyle = isHovered ? '#cc44ff' : 'rgba(160,80,230,0.55)';
    this.ctx.lineWidth   = isHovered ? lw * 2 : lw;
    this.ctx.fill();
    this.ctx.stroke();

    // Hovered: highlight ring
    if (isHovered) {
      this.ctx.beginPath();
      this.ctx.arc(RenderSystem.HELM_X, 0, 18, 0, Math.PI * 2);
      this.ctx.strokeStyle = '#ee88ff';
      this.ctx.lineWidth   = lw * 1.5;
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  /**
   * Detect whether a ship with a missing deck has its hull area under the cursor.
   */
  private detectHoveredDeckSlot(worldState: WorldState): void {
    this.hoveredDeckSlot = null;
    if (!this.mouseWorldPos) return;

    for (const ship of worldState.ships) {
      const deckPresent = ship.modules.some(m => m.kind === 'deck');
      if (deckPresent) continue;

      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      // Hit-test against the ship's walkable deck area (slightly inset from full hull)
      if (Math.abs(localX) <= 280 && Math.abs(localY) <= 75) {
        this.hoveredDeckSlot = { ship };
        return;
      }
    }
  }

  /**
   * Draw a ghost deck outline when the deck module is missing (deck build mode).
   */
  private drawMissingDeckGhost(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const deckPresent = ship.modules.some(m => m.kind === 'deck');
    if (deckPresent) return;

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;
    const isHovered = this.hoveredDeckSlot?.ship === ship;

    // Deck ghost: rounded rectangle covering walkable area
    const w = 480; // half-width total
    const h = 120; // half-height total
    const r = 12;  // corner radius
    const x = -240;
    const y = -60;

    this.ctx.beginPath();
    this.ctx.moveTo(x + r, y);
    this.ctx.lineTo(x + w - r, y);
    this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    this.ctx.lineTo(x + w, y + h - r);
    this.ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    this.ctx.lineTo(x + r, y + h);
    this.ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    this.ctx.lineTo(x, y + r);
    this.ctx.quadraticCurveTo(x, y, x + r, y);
    this.ctx.closePath();

    this.ctx.fillStyle   = isHovered ? 'rgba(180,110,40,0.30)' : 'rgba(140,80,30,0.12)';
    this.ctx.strokeStyle = isHovered ? '#dd8833' : 'rgba(200,120,50,0.55)';
    this.ctx.lineWidth   = isHovered ? lw * 2 : lw;
    this.ctx.fill();
    this.ctx.stroke();

    // Draw deck plank lines for visual clarity
    this.ctx.strokeStyle = isHovered ? 'rgba(220,150,80,0.45)' : 'rgba(180,110,50,0.25)';
    this.ctx.lineWidth   = lw * 0.8;
    const plankSpacing = 20;
    for (let py2 = y + plankSpacing; py2 < y + h; py2 += plankSpacing) {
      this.ctx.beginPath();
      this.ctx.moveTo(x + 2, py2);
      this.ctx.lineTo(x + w - 2, py2);
      this.ctx.stroke();
    }

    if (isHovered) {
      // Outer highlight ring
      this.ctx.beginPath();
      this.ctx.moveTo(x + r - 6, y - 6);
      this.ctx.lineTo(x + w - r + 6, y - 6);
      this.ctx.quadraticCurveTo(x + w + 6, y - 6, x + w + 6, y + r - 6);
      this.ctx.lineTo(x + w + 6, y + h - r + 6);
      this.ctx.quadraticCurveTo(x + w + 6, y + h + 6, x + w - r + 6, y + h + 6);
      this.ctx.lineTo(x + r - 6, y + h + 6);
      this.ctx.quadraticCurveTo(x - 6, y + h + 6, x - 6, y + h - r + 6);
      this.ctx.lineTo(x - 6, y + r - 6);
      this.ctx.quadraticCurveTo(x - 6, y - 6, x + r - 6, y - 6);
      this.ctx.closePath();
      this.ctx.strokeStyle = '#ffbb66';
      this.ctx.lineWidth   = lw * 1.5;
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  private drawShipCannons(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, 200)) {
      return;
    }

    const { phase2Alpha } = this.computeSinkState(ship);
    if (phase2Alpha <= 0) return;
    
    this.ctx.save();
    if (phase2Alpha < 1) this.ctx.globalAlpha = phase2Alpha;
    
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

      // Health-based darkening
      const cannonHealthRatio = Math.max(0, cannonData.health / (cannonData.maxHealth || 8000));
      
      // Save context for this cannon
      this.ctx.save();
      
      // Move to cannon position and apply module rotation
      this.ctx.translate(x, y);
      this.ctx.rotate(localRot);
      
      const lineWidth = 1 / cameraState.zoom;
      
      // Draw cannon base (doesn't rotate with turret)
      this.ctx.fillStyle = this.darkenByDamage('#8B4513', cannonHealthRatio);
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
      this.ctx.fillStyle = this.darkenByDamage('#333333', cannonHealthRatio);
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

  private drawCannonGroupOverlay(ship: Ship, camera: Camera): void {
    if (!this.controlGroups) return;
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const GROUP_COLORS = [
      '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
      '#e67e22', '#1abc9c', '#ec407a', '#26c6da', '#9ccc65',
    ];
    const MODE_COLORS: Record<string, string> = {
      aiming:     '#3498db',
      freefire:   '#e67e22',
      haltfire:   '#e74c3c',
      targetfire: '#ff66cc',
    };

    const activeGroups = this.activeWeaponGroups;
    const showAll = this.showGroupOverlay; // Ctrl held → show every group

    // Build cannonId → { group index, mode } lookup
    const cannonGroupMap = new Map<number, { g: number; mode: string }>();
    this.controlGroups.forEach((state, g) => {
      for (const id of state.cannonIds) cannonGroupMap.set(id, { g, mode: state.mode });
    });

    const screenPos = camera.worldToScreen(ship.position);
    const cs = camera.getState();

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cs.zoom, cs.zoom);
    this.ctx.rotate(ship.rotation - cs.rotation);

    // All sizing below is in world-space units so it scales naturally with zoom.
    // (The canvas transform already applies cs.zoom, so 1 unit = 1 screen px at zoom=1.)

    for (const mod of ship.modules) {
      if (mod.kind !== 'cannon') continue;
      const info = cannonGroupMap.get(mod.id);
      const lx = mod.localPos.x;
      const ly = mod.localPos.y;
      const lr = (mod as { localRot?: number }).localRot ?? 0;

      // Decide visibility:
      //  • cannon in an active group   → always visible (bright highlight)
      //  • cannon in a non-active group → only visible when Shift is held
      //  • unassigned cannon            → only visible when Shift is held
      const isActive = info != null && activeGroups.has(info.g);
      if (!isActive && !showAll) continue;

      this.ctx.save();
      this.ctx.translate(lx, ly);
      this.ctx.rotate(lr);

      if (info) {
        const color     = GROUP_COLORS[info.g % 10];
        const modeColor = MODE_COLORS[info.mode] ?? '#999';

        if (isActive) {
          // ── Active group: bright border + subtle fill + glow ─────────────
          this.ctx.shadowColor = color;
          this.ctx.shadowBlur  = 6; // world units — scales with zoom
          this.ctx.fillStyle   = color + '33'; // ~20 % opacity tint
          this.ctx.fillRect(-15, -10, 30, 20);
          this.ctx.shadowBlur  = 0;
          this.ctx.strokeStyle = color;
          this.ctx.lineWidth   = 2.5; // world units — scales with zoom
          this.ctx.strokeRect(-15, -10, 30, 20);
        } else {
          // ── Inactive group (Shift overlay): thinner dimmed border ──────────
          this.ctx.strokeStyle = color + 'aa';
          this.ctx.lineWidth   = 1.2; // world units
          this.ctx.strokeRect(-15, -10, 30, 20);
        }

        // Group index badge (top-left corner)
        const badgeR = isActive ? 7 : 6; // world units
        this.ctx.fillStyle = isActive ? color : color + 'aa';
        this.ctx.beginPath();
        this.ctx.arc(-9, -5, badgeR, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.fillStyle = '#fff';
        this.ctx.font = `bold ${isActive ? 9 : 8}px Consolas, monospace`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(String(info.g), -9, -5);

        // Mode dot (bottom-right)
        this.ctx.fillStyle = modeColor;
        this.ctx.beginPath();
        this.ctx.arc(9, 5, isActive ? 4 : 3, 0, Math.PI * 2);
        this.ctx.fill();
      } else {
        // Unassigned — dim outline only (Shift needed to reach here)
        this.ctx.strokeStyle = 'rgba(200,200,200,0.3)';
        this.ctx.lineWidth   = 1.0; // world units
        this.ctx.strokeRect(-15, -10, 30, 20);
      }

      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /**
   * Draws the spinning reload animation over every cannon that has
   * MODULE_STATE_RELOADING (bit 4) set.  Queued at layer 6 so it renders
   * on top of the group-colour overlay (layer 5).
   */
  private drawCannonReloadIndicators(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const screenPos    = camera.worldToScreen(ship.position);
    const cameraState  = camera.getState();

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const t          = performance.now() / 1000;
    const spinAngle  = t * 2.5;          // ~2.5 rad/s
    const iconR      = 9;               // world units — scales with zoom
    const arcSpan    = (5 * Math.PI) / 6; // 150° per arc
    const arrowSize  = 3;               // world units
    // Line width in world units so it scales with zoom just like the cannon outlines
    const lw         = 1.5;

    for (const cannon of ship.modules) {
      if (cannon.kind !== 'cannon') continue;
      if (!cannon.moduleData || cannon.moduleData.kind !== 'cannon') continue;
      const isReloading = ((cannon.moduleData.stateBits ?? 0) & 16) !== 0;
      if (!isReloading) continue;

      this.ctx.save();
      this.ctx.translate(cannon.localPos.x, cannon.localPos.y);
      this.ctx.rotate((cannon as { localRot?: number }).localRot ?? 0);

      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.90)';
      this.ctx.fillStyle   = 'rgba(255, 255, 255, 0.90)';
      this.ctx.lineWidth   = lw;
      this.ctx.lineCap     = 'round';

      for (let i = 0; i < 2; i++) {
        const startAngle = spinAngle + i * Math.PI;
        const endAngle   = startAngle + arcSpan;

        // Arc segment
        this.ctx.beginPath();
        this.ctx.arc(0, 0, iconR, startAngle, endAngle);
        this.ctx.stroke();

        // Arrowhead at arc tip
        const tipX = Math.cos(endAngle) * iconR;
        const tipY = Math.sin(endAngle) * iconR;
        const tx   = -Math.sin(endAngle);  // tangent
        const ty   =  Math.cos(endAngle);
        const rx   =  Math.cos(endAngle);  // radial
        const ry   =  Math.sin(endAngle);

        this.ctx.beginPath();
        this.ctx.moveTo(tipX + tx * arrowSize,          tipY + ty * arrowSize);
        this.ctx.lineTo(tipX - tx * arrowSize * 0.5 + rx * arrowSize * 0.9,
                        tipY - ty * arrowSize * 0.5 + ry * arrowSize * 0.9);
        this.ctx.lineTo(tipX - tx * arrowSize * 0.5 - rx * arrowSize * 0.9,
                        tipY - ty * arrowSize * 0.5 - ry * arrowSize * 0.9);
        this.ctx.closePath();
        this.ctx.fill();
      }

      this.ctx.restore();
    }

    this.ctx.restore();
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

    // Each entry carries the module and a fade alpha (1 = fully visible, 0 = hidden)
    let cannonsToShow: Array<{ module: (typeof ship.modules)[0]; alpha: number }> = [];

    if (localPlayer.mountedModuleId != null) {
      const mountedMod = ship.modules.find(m => m.id === localPlayer.mountedModuleId);
      if (mountedMod?.kind === 'cannon') {
        // Mounted directly on a cannon — show just that one at full opacity (unless reloading)
        const isReloading = ((mountedMod.moduleData as { stateBits?: number } | undefined)?.stateBits ?? 0) & 16;
        if (!isReloading) cannonsToShow = [{ module: mountedMod, alpha: 1 }];
      } else if (mountedMod?.kind === 'helm' || mountedMod?.kind === 'steering-wheel') {
        // On the helm — show trajectory guides based on each cannon's angular rotation limit.
        // Matches the server formula: desired_offset = aim - localRot + π/2
        // Server clamps to ±30° (CANNON_AIM_RANGE). We add a 15° fade zone beyond that.
        //   |offset| ≤ 30°        → alpha 1.0  (within rotation range)
        //   30° < |offset| ≤ 45°  → alpha fades 1→0 (past the rotation limit)
        //   |offset| >  45°       → hidden
        const aim = this.playerAimAngleRelative;
        const CANNON_LIMIT_RAD = 30 * Math.PI / 180;
        const FADE_RAD         = 15 * Math.PI / 180;
        const shipNpcs    = worldState.npcs.filter(n => n.shipId === ship.id);
        const shipPlayers = worldState.players.filter(p => p.carrierId === ship.id && p.isMounted);
        for (const m of ship.modules) {
          if (m.kind !== 'cannon') continue;
          // Angular offset from cannon's natural axis (server convention)
          let offset = aim - (m.localRot || 0) + Math.PI / 2;
          // Normalize to [-π, π]
          while (offset >  Math.PI) offset -= 2 * Math.PI;
          while (offset < -Math.PI) offset += 2 * Math.PI;
          const absOffset = Math.abs(offset);
          if (absOffset > CANNON_LIMIT_RAD + FADE_RAD) continue; // beyond 45° — skip
          const hasNpc    = shipNpcs.some(n => n.assignedCannonId === m.id && n.state === NPC_STATE_AT_CANNON);
          const hasPlayer = shipPlayers.some(p => p.mountedModuleId === m.id);
          if (!hasNpc && !hasPlayer) continue;
          // Don't show trajectory for a reloading cannon
          const isReloading = ((m.moduleData as { stateBits?: number } | undefined)?.stateBits ?? 0) & 16;
          if (isReloading) continue;
          const alpha = absOffset <= CANNON_LIMIT_RAD
            ? 1
            : (CANNON_LIMIT_RAD + FADE_RAD - absOffset) / FADE_RAD;
          cannonsToShow.push({ module: m, alpha });
        }
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

    for (const { module: cannon, alpha: fadeAlpha } of cannonsToShow) {
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

      // ── Impact detection in world space ──
      // Convert barrel tip and direction into world space for the intersection test.
      const wBarrelX = ship.position.x + barrelTipX * cosR - barrelTipY * sinR;
      const wBarrelY = ship.position.y + barrelTipX * sinR + barrelTipY * cosR;
      const wDirX = dirX * cosR - dirY * sinR;
      const wDirY = dirX * sinR + dirY * cosR;

      let tHit = Infinity;

      if (this.selectedAmmoType === 1) {
        // ── Bar shot: stop at the nearest enemy mast (ray-circle intersection) ──
        const MAST_HIT_RADIUS = 28; // world units; generous hit zone for mast cylinder
        for (const other of worldState.ships) {
          if (other.id === ship.id) continue;
          const masts = other.modules.filter(m => m.kind === 'mast');
          const cosO = Math.cos(other.rotation);
          const sinO = Math.sin(other.rotation);
          for (const mast of masts) {
            // Mast world position
            const mlx = mast.localPos.x;
            const mly = mast.localPos.y;
            const mwx = other.position.x + mlx * cosO - mly * sinO;
            const mwy = other.position.y + mlx * sinO + mly * cosO;
            // Ray–circle: M = mastCenter - rayOrigin
            const mx = mwx - wBarrelX;
            const my = mwy - wBarrelY;
            const tProj = mx * wDirX + my * wDirY;
            if (tProj < 0 || tProj > range) continue;
            const distSq = mx * mx + my * my - tProj * tProj;
            if (distSq <= MAST_HIT_RADIUS * MAST_HIT_RADIUS) {
              const t = tProj - Math.sqrt(MAST_HIT_RADIUS * MAST_HIT_RADIUS - distSq);
              if (t >= 0 && t < tHit) tHit = t;
            }
          }
        }
      } else {
        // ── Cannonball: stop at nearest enemy ship hull ──
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
      }

      const didHit     = tHit < Infinity;
      // Trajectory ends at impact point, clamped to max range
      const drawLength = didHit ? Math.min(tHit, range) : range;
      // Bar shot uses orange-gold when targeting a mast; cannonball uses yellow/grey
      const guideColor = didHit
        ? (this.selectedAmmoType === 1 ? '#FF8C00' : '#FFD700')
        : '#AAAAAA';

      // ── Dashed trajectory line (stops at impact) ──
      this.ctx.save();
      this.ctx.globalAlpha = 0.80 * fadeAlpha;
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
        this.ctx.globalAlpha = 0.55 * fadeAlpha;
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
      this.ctx.globalAlpha = 0.75 * fadeAlpha;
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
      const helmData = helm.moduleData as import('../../sim/modules.js').HelmModuleData;
      const helmHealthRatio = Math.max(0, (helmData.health ?? 10000) / (helmData.maxHealth ?? 10000));
      
      // Draw helm as a simple brown circle, darkened by damage
      this.ctx.fillStyle = this.darkenByDamage('#8B4513', helmHealthRatio);
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

    const { phase3Alpha } = this.computeSinkState(ship);
    if (phase3Alpha <= 0) return;

    this.ctx.save();
    if (phase3Alpha < 1) this.ctx.globalAlpha = phase3Alpha;

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

    const { phase3Alpha } = this.computeSinkState(ship);
    if (phase3Alpha <= 0) return;
    
    this.ctx.save();
    if (phase3Alpha < 1) this.ctx.globalAlpha = phase3Alpha;
    
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
      
      // Use sail cloth HP (fiberHealth) for visual degradation, not mast pole HP
      const healthRatio = mastData.fiberMaxHealth > 0 ? mastData.fiberHealth / mastData.fiberMaxHealth : 1;
      this.drawSailFiber(x, y, width, height, sailColor, mastData.openness / 100, angle, healthRatio, mast.id);
      
    }
    
    this.ctx.restore();
  }
  
  private drawSailFiber(x: number, y: number, width: number, height: number, sailColor: string, openness: number, angle: number, healthRatio: number = 1, moduleId: number = 0): void {
    // Clamp health — NaN guard for missing fiberMaxHealth
    const clampedHealth = Math.max(0, Math.min(1, isNaN(healthRatio) ? 1 : healthRatio));

    // Sail fades out in the last 25% of its HP so destruction feels gradual
    const sailAlpha = clampedHealth < 0.25 ? clampedHealth / 0.25 : 1.0;
    const sailVisible = clampedHealth >= 0.02;

    // Helper: parse '#RRGGBB' → [r, g, b]
    const hexToRgb = (hex: string): [number, number, number] => {
      const h = hex.replace('#', '');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    // Helper: lerp two [r,g,b] triples and return '#RRGGBB'
    const lerpColor = (a: [number, number, number], b: [number, number, number], t: number): string => {
      const r = Math.round(a[0] + (b[0] - a[0]) * t);
      const g = Math.round(a[1] + (b[1] - a[1]) * t);
      const bl = Math.round(a[2] + (b[2] - a[2]) * t);
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
    };

    // Damage factor: 0 = pristine, 1 = nearly destroyed
    const damage = 1 - clampedHealth;
    const grey: [number, number, number] = [110, 110, 110];

    const centerColor = lerpColor(hexToRgb(sailColor), grey, damage);
    const edgeColor   = lerpColor(hexToRgb('#E6E6E6'), grey, damage);

    // Set up rotated coordinate space (yard always rotates with sail angle)
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(angle);

    const sailTopY  = -height * 1.4;
    const sailPower = width * 1.2 * openness;

    // ── Sail cloth — only when fibers are not fully shredded ──
    if (sailVisible) {
      this.ctx.save();
      this.ctx.globalAlpha = sailAlpha;

      const gradient = this.ctx.createLinearGradient(-width / 2, sailTopY, width / 2, sailTopY);
      gradient.addColorStop(0,   edgeColor);
      gradient.addColorStop(0.5, centerColor);
      gradient.addColorStop(1,   edgeColor);

      this.ctx.beginPath();
      this.ctx.moveTo(0, sailTopY);
      this.ctx.lineTo(0, -sailTopY);
      this.ctx.quadraticCurveTo(sailPower + 25, 0, 0, sailTopY);
      this.ctx.closePath();
      this.ctx.fillStyle = gradient;
      this.ctx.fill();

      // ── Tear marks ──
      if (clampedHealth < 1.0 && openness > 0) {
        const tearCount = Math.min(5, Math.floor((1 - clampedHealth) * 6));
        let seed = (moduleId * 1664525 + 1013904223) >>> 0;
        const lcg = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };

        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(80, 50, 20, 0.7)';
        this.ctx.lineWidth   = 1.8;
        this.ctx.lineCap     = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(0, sailTopY);
        this.ctx.lineTo(0, -sailTopY);
        this.ctx.quadraticCurveTo(sailPower + 25, 0, 0, sailTopY);
        this.ctx.clip();

        for (let t = 0; t < tearCount; t++) {
          const ty = sailTopY + lcg() * (-sailTopY - sailTopY);
          const halfW = (0.3 + lcg() * 0.6) * (sailPower * 0.5 + 10);
          const jitter = () => (lcg() - 0.5) * 4;
          this.ctx.beginPath();
          this.ctx.moveTo(-halfW, ty + jitter());
          this.ctx.lineTo(-halfW * 0.3, ty + jitter());
          this.ctx.lineTo(halfW * 0.3, ty + jitter());
          this.ctx.lineTo(halfW, ty + jitter());
          this.ctx.stroke();
        }
        this.ctx.restore();
      }

      this.ctx.restore(); // end sailAlpha save
    }

    // ── Horizontal yard (always visible — holds the sail even when cloth is shredded) ──
    this.ctx.fillStyle = '#8B4513';
    this.ctx.strokeStyle = '#654321';
    this.ctx.fillRect(-width / 20, sailTopY, width / 10, -sailTopY * 2);
    this.ctx.strokeRect(-width / 20, sailTopY, width / 10, -sailTopY * 2);

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

    const { phase3Alpha } = this.computeSinkState(ship);
    if (phase3Alpha <= 0) return;
    
    this.ctx.save();
    if (phase3Alpha < 1) this.ctx.globalAlpha = phase3Alpha;
    
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
    // Enemy-company players are always tinted red regardless of mount state.
    const isEnemyPlayer = this._localCompanyId !== 0 && player.companyId !== 0
      && player.companyId !== this._localCompanyId;
    if (isEnemyPlayer) {
      this.ctx.fillStyle = '#cc2222';
    } else if (player.isMounted) {
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
    // For the local player use the live mouse-to-player angle so the arrow is
    // always visually correct even before the server round-trips the rotation.
    let rotation = player.rotation;
    if (player.id === this.localPlayerId && this.mouseWorldPos) {
      const dx = this.mouseWorldPos.x - player.position.x;
      const dy = this.mouseWorldPos.y - player.position.y;
      rotation = Math.atan2(dy, dx);
    }
    
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
    if (!camera.isWorldPositionVisible(cannonball.position, 20)) return;

    const screenPos = camera.worldToScreen(cannonball.position);
    const zoom      = camera.getState().zoom;

    if (cannonball.ammoType === 1) {
      // ── Bar Shot ───────────────────────────────────────────────────────────
      // Two iron balls connected by a spinning bar.
      // Spin angle: use wall-clock time so it always animates regardless of timeAlive.
      const spinAngle = (Date.now() / 1000) * 10 + cannonball.id * 1.3; // ~1.6 rot/sec, staggered per projectile
      const ballR     = Math.max(2, 4 * zoom);
      const barHalfL  = Math.max(4, 10 * zoom);

      const cos = Math.cos(spinAngle);
      const sin = Math.sin(spinAngle);

      const ax = screenPos.x - cos * barHalfL;
      const ay = screenPos.y - sin * barHalfL;
      const bx = screenPos.x + cos * barHalfL;
      const by = screenPos.y + sin * barHalfL;

      // Connecting bar
      this.ctx.strokeStyle = '#cc5500';
      this.ctx.lineWidth   = Math.max(1.5, 2 * zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(ax, ay);
      this.ctx.lineTo(bx, by);
      this.ctx.stroke();

      // Ball A
      this.ctx.fillStyle = '#b84000';
      this.ctx.beginPath();
      this.ctx.arc(ax, ay, ballR, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = '#ff8844';
      this.ctx.lineWidth   = 1;
      this.ctx.stroke();

      // Ball B
      this.ctx.beginPath();
      this.ctx.arc(bx, by, ballR, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = '#ff8844';
      this.ctx.lineWidth   = 1;
      this.ctx.stroke();
    } else {
      // ── Cannonball (default) ───────────────────────────────────────────────
      const scaledRadius = cannonball.radius * zoom;
      this.ctx.fillStyle = '#000000';
      this.ctx.beginPath();
      this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, 0, Math.PI * 2);
      this.ctx.fill();
    }
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

      // Debug: show assigned cannon/module ID and state below name
      if (npc.assignedCannonId || npc.state !== 0) {
        const STATE_SHORT: Record<number, string> = { 0: 'IDL', 1: 'MOV', 2: 'MAN', 3: 'REP' };
        const ROLE_SHORT: Record<number, string> = { 0: '-', 1: 'G', 2: 'H', 3: 'R', 4: 'P' };
        const debugLabel = `${ROLE_SHORT[npc.role] ?? '?'}:${STATE_SHORT[npc.state] ?? '?'}`
          + (npc.assignedCannonId ? ` c${npc.assignedCannonId}` : '');
        const debugFontSize = Math.max(8, Math.min(11, 10 * cameraState.zoom));
        this.ctx.font = `${debugFontSize}px monospace`;
        const dtw = this.ctx.measureText(debugLabel).width;
        const debugY = screenPos.y + radius + debugFontSize + 2;
        this.ctx.textBaseline = 'bottom';
        this.ctx.fillStyle = 'rgba(0,0,0,0.5)';
        this.ctx.fillRect(screenPos.x - dtw / 2 - 2, debugY - debugFontSize, dtw + 4, debugFontSize + 2);
        this.ctx.fillStyle = '#aaddff';
        this.ctx.fillText(debugLabel, screenPos.x, debugY);
      }
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
  /**
   * Detect which NPC (if any) the mouse is hovering over.
   */
  private detectHoveredNpc(worldState: WorldState): void {
    this.hoveredNpc = null;
    if (!this.mouseWorldPos) return;
    const HOVER_RADIUS = 22; // world units
    let bestDist = HOVER_RADIUS;
    for (const npc of worldState.npcs) {
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
      const dist = this.mouseWorldPos.distanceTo(worldPos);
      if (dist < bestDist) { bestDist = dist; this.hoveredNpc = npc; }
    }
  }

  /**
   * Draw hover tooltip for a hovered NPC.
   */
  private drawNpcTooltip(camera: Camera): void {
    if (!this.hoveredNpc || !this.mouseWorldPos) return;
    // Skip if a module tooltip is already showing (avoid overlap)
    if (this.hoveredModule) return;

    const npc = this.hoveredNpc;
    const COMPANY_NAMES: Record<number, string> = {
      [COMPANY_NEUTRAL]: 'Neutral',
      [COMPANY_PIRATES]: 'Pirates',
      [COMPANY_NAVY]:    'Navy',
    };
    const ROLE_NAMES: Record<number, string> = {
      0: 'None', 1: 'Gunner', 2: 'Helmsman', 3: 'Rigger', 4: 'Repairer',
    };
    const STATE_NAMES: Record<number, string> = {
      0: 'Idle', 1: 'Moving', 2: 'At Cannon', 3: 'Repairing',
    };
    const companyStr = COMPANY_NAMES[npc.companyId] ?? `ID ${npc.companyId}`;
    const taskStr = this.npcTaskMap.get(npc.id) ?? 'Idle';
    const lines: string[] = [
      npc.name,
      `ID: ${npc.id}`,
      `Company: ${companyStr} (${npc.companyId})`,
      `Role: ${ROLE_NAMES[npc.role] ?? npc.role}`,
      `State: ${STATE_NAMES[npc.state] ?? npc.state}`,
      `Task: ${taskStr}`,
    ];
    if (npc.assignedCannonId) lines.push(`Cannon: ${npc.assignedCannonId}`);
    if (npc.shipId) lines.push(`Ship: ${npc.shipId}`);
    if (npc.localPosition) lines.push(`Local: (${npc.localPosition.x.toFixed(0)}, ${npc.localPosition.y.toFixed(0)})`);

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const padding = 10;
    const lineHeight = 18;

    this.ctx.font = '14px monospace';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';
    let maxWidth = 0;
    for (const line of lines) maxWidth = Math.max(maxWidth, this.ctx.measureText(line).width);

    const boxWidth  = maxWidth + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2;

    let tx = screenPos.x + 15;
    let ty = screenPos.y + 15;
    if (tx + boxWidth  > this.canvas.width)  tx = screenPos.x - boxWidth  - 15;
    if (ty + boxHeight > this.canvas.height) ty = screenPos.y - boxHeight - 15;

    this.ctx.fillStyle   = 'rgba(0,0,0,0.85)';
    this.ctx.strokeStyle = '#aac8ff';
    this.ctx.lineWidth   = 2;
    this.ctx.fillRect(tx, ty, boxWidth, boxHeight);
    this.ctx.strokeRect(tx, ty, boxWidth, boxHeight);

    // Header line in yellow, rest in white
    for (let i = 0; i < lines.length; i++) {
      this.ctx.fillStyle = i === 0 ? '#ffe066' : '#ffffff';
      this.ctx.fillText(lines[i], tx + padding, ty + padding + i * lineHeight);
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
      // Guard against Q16 fixed-point blowup from server (Q16 max for 15000 ≈ 983 million)
      const Q16_THRESHOLD = 100_000;
      const rawHp = moduleData.health ?? 15000;
      const rawMax = moduleData.maxHealth ?? 15000;
      const hp    = Math.round(rawHp  > Q16_THRESHOLD ? rawHp  / 65536 : rawHp);
      const maxHp = Math.round(rawMax > Q16_THRESHOLD ? rawMax / 65536 : rawMax);
      lines.push(`Health: ${hp} / ${maxHp}`);
      // Guard against 0/0 fiber health on freshly placed masts
      const rawFh    = moduleData.fiberHealth    ?? 15000;
      const rawFhMax = moduleData.fiberMaxHealth ?? 15000;
      const fh    = rawFhMax === 0 ? 15000 : Math.round(rawFh    > Q16_THRESHOLD ? rawFh    / 65536 : rawFh);
      const fhMax = rawFhMax === 0 ? 15000 : Math.round(rawFhMax > Q16_THRESHOLD ? rawFhMax / 65536 : rawFhMax);
      const fhPct = fhMax > 0 ? Math.round((fh / fhMax) * 100) : 100;
      lines.push(`Sail Fibers: ${fh} / ${fhMax} (${fhPct}%)`);
      lines.push(`Sail State: ${moduleData.sailState.toUpperCase()}`);
      lines.push(`Openness: ${moduleData.openness.toFixed(0)}%`);
      lines.push(`Wind Efficiency: ${(moduleData.windEfficiency * 100).toFixed(0)}%`);
    }
    
    // Add interaction hint
    lines.push('');
    const MAX_INTERACT_DIST = 50;
    let interactLabel = '[E] Interact';
    if (this.playerInteractInfo) {
      const { worldPos, localPos, carrierId } = this.playerInteractInfo;
      const cos = Math.cos(ship.rotation);
      const sin = Math.sin(ship.rotation);
      const modWorldX = ship.position.x + (module.localPos.x * cos - module.localPos.y * sin);
      const modWorldY = ship.position.y + (module.localPos.x * sin + module.localPos.y * cos);
      let dist: number;
      if (carrierId === ship.id && localPos) {
        dist = localPos.sub(module.localPos).length();
      } else {
        dist = worldPos.sub(Vec2.from(modWorldX, modWorldY)).length();
      }
      interactLabel = dist <= MAX_INTERACT_DIST ? '[E] Interact' : 'Not in Range';
    }
    lines.push(interactLabel);
    
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
      } else if (moduleData.kind === 'ladder') {
        // Ladder renders as fillRect(-10, -20, 20, 40)
        this.ctx.strokeRect(-10, -20, 20, 40);
      } else if (moduleData.kind === 'mast') {
        // Mast is a circle
        const radius = (moduleData as any).radius || 15;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, radius, 0, Math.PI * 2);
        this.ctx.stroke();
      } else if (moduleData.kind === 'helm' || moduleData.kind === 'steering-wheel') {
        // Helm renders as a circle with radius 8
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 8, 0, Math.PI * 2);
        this.ctx.stroke();
      } else {
        // Default highlight for other modules
        const size = 20;
        this.ctx.strokeRect(-size/2, -size/2, size, size);
      }
    }
    
    this.ctx.restore();
  }

  // -----------------------------------------------------------------------
  // Explicit build mode ghost preview
  // -----------------------------------------------------------------------

  /**
   * Draw a semi-transparent ghost cannon or mast at the cursor world position.
   * Tinted green when placement is valid, red when invalid (overlap or max sails).
   */
  /**
   * Draw ghost planning markers for a single ship.
   * Each ghost is rendered as a translucent colored shape at its ship-local position.
   */
  private drawGhostPlacements(ship: Ship, ghosts: GhostPlacement[], camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 400)) return;
    const screenPos = camera.worldToScreen(ship.position);
    const { zoom, rotation: camRot } = camera.getState();

    // In hotbar mode, find the nearest matching ghost within the 80u snap radius
    const hotbarKind: GhostModuleKind | null =
      this.cannonBuildMode && !this.explicitBuildState ? 'cannon' :
      this.mastBuildMode  && !this.explicitBuildState ? 'mast' : null;
    let snapGhostId: string | null = null;
    if (hotbarKind && this.mouseWorldPos) {
      let bestDist = 80;
      const cos = Math.cos(ship.rotation);
      const sin = Math.sin(ship.rotation);
      for (const g of ghosts) {
        if (g.kind !== hotbarKind) continue;
        const wx = ship.position.x + g.localPos.x * cos - g.localPos.y * sin;
        const wy = ship.position.y + g.localPos.x * sin + g.localPos.y * cos;
        const dist = Math.hypot(this.mouseWorldPos.x - wx, this.mouseWorldPos.y - wy);
        if (dist < bestDist) { bestDist = dist; snapGhostId = g.id; }
      }
    }

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - camRot);

    const t = performance.now() / 1000;
    const pulse = 0.70 + 0.20 * Math.sin(t * 2.5);
    const snapPulse = 0.85 + 0.15 * Math.sin(t * 5.0); // faster pulse for snap highlight

    for (const g of ghosts) {
      const isSnap = g.id === snapGhostId;
      this.ctx.save();
      this.ctx.translate(g.localPos.x, g.localPos.y);
      this.ctx.rotate(g.localRot);
      this.ctx.globalAlpha = isSnap ? snapPulse : pulse;

      // Snap target uses bright teal; normal plan marker uses faint green
      const ghostFill   = isSnap ? 'rgba(20,180,160,0.55)' : 'rgba(40,130,70,0.55)';
      const ghostStroke = isSnap ? '#44ffee' : '#66ee99';

      switch (g.kind) {
        case 'cannon': {
          this.ctx.fillStyle = ghostFill;
          this.ctx.strokeStyle = ghostStroke;
          this.ctx.lineWidth = 1.2;
          this.ctx.setLineDash([3, 2]);
          this.ctx.fillRect(-15, -10, 30, 20);
          this.ctx.strokeRect(-15, -10, 30, 20);
          this.ctx.fillRect(-8, -36, 16, 28);
          this.ctx.strokeRect(-8, -36, 16, 28);
          this.ctx.setLineDash([]);
          break;
        }
        case 'mast': {
          this.ctx.fillStyle = ghostFill;
          this.ctx.strokeStyle = ghostStroke;
          this.ctx.lineWidth = 1.2;
          this.ctx.setLineDash([4, 2]);
          this.ctx.beginPath();
          this.ctx.arc(0, 0, 15, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.fillStyle = 'rgba(40,110,60,0.13)';
          this.ctx.fillRect(-40, -5, 80, 10);
          this.ctx.strokeRect(-40, -5, 80, 10);
          this.ctx.setLineDash([]);
          break;
        }
        case 'helm': {
          const R = 16;
          this.ctx.fillStyle = ghostFill;
          this.ctx.strokeStyle = ghostStroke;
          this.ctx.lineWidth = 1.2;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.arc(0, 0, R, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          for (let s = 0; s < 6; s++) {
            const a = (s / 6) * Math.PI * 2;
            this.ctx.beginPath();
            this.ctx.moveTo(0, 0);
            this.ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
            this.ctx.strokeStyle = 'rgba(80,190,130,0.45)';
            this.ctx.lineWidth = 1;
            this.ctx.stroke();
          }
          break;
        }
        case 'deck': {
          this.ctx.fillStyle = ghostFill;
          this.ctx.strokeStyle = ghostStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([5, 3]);
          this.ctx.beginPath();
          this.ctx.roundRect(-240, -60, 480, 120, 8);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
        case 'plank':
        default: {
          this.ctx.fillStyle = ghostFill;
          this.ctx.strokeStyle = ghostStroke;
          this.ctx.lineWidth = 1.2;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.roundRect(-25, -8, 50, 16, 4);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
      }

      // Outer snap ring for the hotbar-snap target
      if (isSnap) {
        this.ctx.globalAlpha = snapPulse * 0.9;
        this.ctx.strokeStyle = '#44ffee';
        this.ctx.lineWidth = 2.5;
        this.ctx.setLineDash([4, 3]);
        const ringR = g.kind === 'cannon' ? 28 : g.kind === 'deck' ? 250 : 32;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }

      // Label
      this.ctx.globalAlpha = (isSnap ? snapPulse : pulse) * 0.9;
      this.ctx.fillStyle = isSnap ? '#44ffee' : '#99eebb';
      this.ctx.font = isSnap ? 'bold 10px Consolas, monospace' : '9px Consolas, monospace';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      const labelY = g.kind === 'deck' ? -64 : -22;
      this.ctx.fillText(isSnap ? '⚡ Click to place!' : g.kind, 0, labelY);

      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /**
   * Draw the ghost module that is currently attached to the cursor for precision placement.
   * Shows the module shape at the mouse world position, color-coded valid (green) or invalid (red).
   */
  private drawPendingGhostCursor(worldState: WorldState, camera: Camera): void {
    if (!this.pendingGhostState || !this.mouseWorldPos) return;
    const { kind, rotDeg } = this.pendingGhostState;

    // Find nearest ship
    let nearestShip: Ship | null = null;
    let nearestDist = Infinity;
    for (const ship of worldState.ships) {
      const d = this.mouseWorldPos.sub(ship.position).length();
      if (d < nearestDist) { nearestDist = d; nearestShip = ship; }
    }
    let onShip = nearestShip !== null && nearestDist < 400;

    let localX = 0; let localY = 0;
    if (nearestShip) {
      const dx = this.mouseWorldPos.x - nearestShip.position.x;
      const dy = this.mouseWorldPos.y - nearestShip.position.y;
      const c = Math.cos(-nearestShip.rotation);
      const s = Math.sin(-nearestShip.rotation);
      localX = dx * c - dy * s;
      localY = dx * s + dy * c;
      // Refine: cursor must actually be inside the ship hull polygon
      if (onShip) onShip = PolygonUtils.pointInPolygon(Vec2.from(localX, localY), nearestShip.hull);
    }

    const rotRad = (rotDeg * Math.PI) / 180;

    // Validate: check overlap with existing modules
    let valid = onShip;
    let invalidReason = onShip ? '' : 'Not on ship';
    if (valid && nearestShip) {
      const newKind: GhostModuleKind = kind;
      const skipKinds: GhostModuleKind[] = ['plank', 'deck'];
      if (!skipKinds.includes(newKind as GhostModuleKind)) {
        const newFp = getModuleFootprint(newKind as any);
        for (const mod of nearestShip.modules) {
          if (mod.kind === 'plank' || mod.kind === 'deck') continue;
          const existFp = getModuleFootprint(mod.kind);
          if (footprintsOverlap(newFp, localX, localY, rotRad, existFp, mod.localPos.x, mod.localPos.y, mod.localRot)) {
            valid = false;
            invalidReason = 'Overlap!';
            break;
          }
        }
      }
      // Also check existing ghost placements so cursor turns red/orange
      if (valid && nearestShip) {
        const skipKinds2: GhostModuleKind[] = ['plank', 'deck'];
        if (!skipKinds2.includes(newKind as GhostModuleKind)) {
          const newFp2 = getModuleFootprint(newKind as any);
          for (const g of this.ghostPlacements) {
            if (g.shipId !== nearestShip.id) continue;
            const gFp = getModuleFootprint(g.kind as any);
            if (footprintsOverlap(newFp2, localX, localY, rotRad, gFp, g.localPos.x, g.localPos.y, g.localRot)) {
              valid = false;
              invalidReason = 'Remove plan first!';
              break;
            }
          }
        }
      }

      // Mast: centerline + separation
      if (kind === 'mast' && valid) {
        if (Math.abs(localY) > 25) { valid = false; invalidReason = 'Must be on centerline'; }
        if (valid && (localX < -240 || localX > 200)) { valid = false; invalidReason = 'Outside sail zone!'; }
        if (valid) {
          const MIN_SEP = 80;
          for (const mod of nearestShip.modules) {
            if (mod.kind !== 'mast') continue;
            if (Math.hypot(localX - mod.localPos.x, localY - mod.localPos.y) < MIN_SEP) {
              valid = false; invalidReason = 'Too close to mast'; break;
            }
          }
        }
      }

      // Edge margin — module center must be at least module-radius inset from hull boundary
      if (valid) {
        const edgeMargin = (kind === 'cannon' || kind === 'mast') ? 15 : 10;
        const edgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
        if (edgeDist < edgeMargin) { valid = false; invalidReason = 'Too close to edge!'; }
      }
    }

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const { zoom, rotation: camRot } = camera.getState();
    const shipRot = nearestShip?.rotation ?? 0;

    this.ctx.save();
    this.ctx.globalAlpha = 0.72;
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(shipRot - camRot + rotRad);

    const planBlocked = invalidReason === 'Remove plan first!';
    const okColor   = valid ? '#44ff88' : planBlocked ? '#ffaa44' : '#ff5555';
    const fillColor = valid ? 'rgba(30,120,60,0.45)' : planBlocked ? 'rgba(160,90,20,0.45)' : 'rgba(120,30,30,0.45)';

    switch (kind) {
      case 'cannon': {
        this.ctx.fillStyle = fillColor;
        this.ctx.strokeStyle = okColor;
        this.ctx.lineWidth = 1.5;
        this.ctx.fillRect(-15, -10, 30, 20);  this.ctx.strokeRect(-15, -10, 30, 20);
        this.ctx.fillRect(-8, -38, 16, 30);   this.ctx.strokeRect(-8, -38, 16, 30);
        break;
      }
      case 'mast': {
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 15, 0, Math.PI * 2);
        this.ctx.fillStyle = fillColor; this.ctx.fill();
        this.ctx.strokeStyle = okColor; this.ctx.lineWidth = 1.5; this.ctx.stroke();
        this.ctx.fillStyle = valid ? 'rgba(100,220,160,0.30)' : planBlocked ? 'rgba(220,160,80,0.25)' : 'rgba(220,100,100,0.25)';
        this.ctx.strokeStyle = okColor;
        this.ctx.fillRect(-40, -5, 80, 10); this.ctx.strokeRect(-40, -5, 80, 10);
        break;
      }
      case 'helm': {
        const R = 16;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, R, 0, Math.PI * 2);
        this.ctx.fillStyle = fillColor; this.ctx.fill();
        this.ctx.strokeStyle = okColor; this.ctx.lineWidth = 1.5; this.ctx.stroke();
        for (let s = 0; s < 6; s++) {
          const a = (s / 6) * Math.PI * 2;
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
          this.ctx.strokeStyle = okColor; this.ctx.lineWidth = 1; this.ctx.stroke();
        }
        break;
      }
      case 'deck': {
        this.ctx.beginPath();
        this.ctx.roundRect(-240, -60, 480, 120, 8);
        this.ctx.fillStyle = fillColor; this.ctx.fill();
        this.ctx.strokeStyle = okColor; this.ctx.lineWidth = 1.5; this.ctx.stroke();
        break;
      }
      default: { // plank
        this.ctx.beginPath();
        this.ctx.roundRect(-25, -8, 50, 16, 4);
        this.ctx.fillStyle = fillColor; this.ctx.fill();
        this.ctx.strokeStyle = okColor; this.ctx.lineWidth = 1.5; this.ctx.stroke();
        break;
      }
    }

    this.ctx.restore();

    // Status label (screen-space, below cursor)
    const label = valid
      ? `Place ${kind} [click]`
      : invalidReason || 'Not on ship';
    this.ctx.save();
    this.ctx.font = 'bold 12px Consolas, monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    const tw = this.ctx.measureText(label).width + 10;
    this.ctx.fillStyle = 'rgba(0,0,0,0.65)';
    this.ctx.fillRect(screenPos.x - tw / 2, screenPos.y + 28, tw, 18);
    this.ctx.fillStyle = valid ? '#88ff99' : invalidReason === 'Remove plan first!' ? '#ffaa44' : '#ff8888';
    this.ctx.fillText(label, screenPos.x, screenPos.y + 30);
    this.ctx.restore();
  }

  private drawExplicitBuildGhost(worldState: WorldState, camera: Camera): void {
    if (!this.explicitBuildState || !this.mouseWorldPos) return;
    const { item, rotationDeg } = this.explicitBuildState;

    // Find nearest ship
    let nearestShip: Ship | null = null;
    let nearestDist = Infinity;
    for (const ship of worldState.ships) {
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) { nearestDist = dist; nearestShip = ship; }
    }

    let onShip = nearestShip !== null && nearestDist < 400;

    // Compute ship-local cursor position
    let localX = 0;
    let localY = 0;
    if (nearestShip) {
      const dx = this.mouseWorldPos.x - nearestShip.position.x;
      const dy = this.mouseWorldPos.y - nearestShip.position.y;
      const cos = Math.cos(-nearestShip.rotation);
      const sin = Math.sin(-nearestShip.rotation);
      localX = dx * cos - dy * sin;
      localY = dx * sin + dy * cos;
    }

    // Sails must sit on the ship centerline — snap cursor position to Y=0 so
    // the ghost always renders on-axis instead of showing off-center then blocking.
    if (item === 'sail') localY = 0;

    // Refine onShip using hull polygon test (after Y snap for sails)
    if (onShip && nearestShip) {
      onShip = PolygonUtils.pointInPolygon(Vec2.from(localX, localY), nearestShip.hull);
    }

    // Validate placement using geometry (OBB/circle) overlap — not a simple radius check
    const rotRad = (rotationDeg * Math.PI) / 180;
    const newKind = item === 'cannon' ? 'cannon' as const : 'mast' as const;
    const newFp = getModuleFootprint(newKind);
    let overlaps = false;
    let ghostBlocked = false;
    let ghostSnap = false;
    let edgeTooClose = false;
    if (nearestShip) {
      for (const mod of nearestShip.modules) {
        if (mod.kind === 'plank' || mod.kind === 'deck') continue;
        const existingFp = getModuleFootprint(mod.kind);
        if (footprintsOverlap(newFp, localX, localY, rotRad,
                              existingFp, mod.localPos.x, mod.localPos.y, mod.localRot)) {
          overlaps = true; break;
        }
      }
      // Also check planned ghost markers — same kind snaps, different kind blocks
      if (!overlaps) {
        for (const g of this.ghostPlacements) {
          if (g.shipId !== nearestShip.id) continue;
          const gFp = getModuleFootprint(g.kind as any);
          if (footprintsOverlap(newFp, localX, localY, rotRad, gFp, g.localPos.x, g.localPos.y, g.localRot)) {
            if (g.kind === newKind) { ghostSnap = true; } else { ghostBlocked = true; }
            break;
          }
        }
      }

      // Edge margin — cannon base half-width / mast radius = 15; center must be that far from hull edge
      if (!overlaps && !ghostBlocked) {
        const edgeMargin = newKind === 'cannon' ? 15 : 15;
        const edgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
        if (edgeDist < edgeMargin) edgeTooClose = true;
      }
    }
    const sailMaxed = item === 'sail' &&
      (nearestShip?.modules.filter(m => m.kind === 'mast').length ?? 0) >= 3;

    // Sail extra constraints: centerline already enforced by snap above; only check mast separation
    let sailConstraintFail = '';
    if (item === 'sail' && !sailMaxed && nearestShip) {
      if (localX < -240 || localX > 200) {
        sailConstraintFail = 'Outside sail zone!';
      } else {
        const MIN_SEP = 80;
        for (const mod of nearestShip.modules) {
          if (mod.kind !== 'mast') continue;
          if (Math.hypot(localX - mod.localPos.x, 0 - mod.localPos.y) < MIN_SEP) {
            sailConstraintFail = 'Too close to mast'; break;
          }
        }
      }
    }

    const valid = onShip && !overlaps && !ghostBlocked && !ghostSnap && !edgeTooClose && !sailMaxed && sailConstraintFail === '';

    // Screen position of cursor
    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const zoom = camera.getState().zoom;
    const cameraRot = camera.getState().rotation;
    const shipRot = nearestShip?.rotation ?? 0;

    const totalRot = shipRot - cameraRot + rotRad;

    this.ctx.save();
    this.ctx.globalAlpha = 0.65;
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(totalRot);

    if (item === 'cannon') {
      // -- Cannon base --
      this.ctx.fillStyle   = valid ? '#336633' : ghostSnap ? '#1a4d44' : ghostBlocked ? '#664422' : '#663333';
      this.ctx.strokeStyle = valid ? '#88ff88' : ghostSnap ? '#44ddcc' : ghostBlocked ? '#ffaa44' : '#ff8888';
      this.ctx.lineWidth   = 1 / zoom;
      this.ctx.fillRect(-15, -10, 30, 20);
      this.ctx.strokeRect(-15, -10, 30, 20);

      // -- Barrel (pointing up / forward) --
      this.ctx.fillStyle   = valid ? '#225522' : ghostSnap ? '#1a4d44' : ghostBlocked ? '#553311' : '#552222';
      this.ctx.strokeStyle = valid ? '#55ee55' : ghostSnap ? '#33ccbb' : ghostBlocked ? '#ee9933' : '#ee5555';
      this.ctx.fillRect(-8, -38, 16, 30);
      this.ctx.strokeRect(-8, -38, 16, 30);
    } else {
      // -- Mast pole --
      const radius = 15;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, radius, 0, Math.PI * 2);
      this.ctx.fillStyle   = valid ? '#334433' : ghostSnap ? '#1a4d44' : ghostBlocked ? '#443322' : '#443333';
      this.ctx.strokeStyle = valid ? '#88ff88' : ghostSnap ? '#44ddcc' : ghostBlocked ? '#ffaa44' : '#ff8888';
      this.ctx.lineWidth   = 1 / zoom;
      this.ctx.fill();
      this.ctx.stroke();

      // -- Sail outline --
      const sailW = 80;
      this.ctx.beginPath();
      this.ctx.rect(-sailW / 2, -5, sailW, 10);
      this.ctx.fillStyle   = valid ? 'rgba(180,240,180,0.35)' : ghostSnap ? 'rgba(140,240,230,0.35)' : ghostBlocked ? 'rgba(240,200,140,0.35)' : 'rgba(240,180,180,0.35)';
      this.ctx.strokeStyle = valid ? '#66dd66' : ghostSnap ? '#44ddcc' : ghostBlocked ? '#ddaa44' : '#dd6666';
      this.ctx.lineWidth   = 1 / zoom;
      this.ctx.fill();
      this.ctx.stroke();
    }

    this.ctx.restore();

    // Status label in screen space (below ghost)
    const label = valid
      ? (item === 'cannon' ? 'Place Cannon' : 'Place Sail')
      : ghostSnap        ? '⚡ Snap to plan!'
      : ghostBlocked      ? 'Remove plan first!'
      : overlaps         ? 'Blocked!'
      : edgeTooClose     ? 'Too close to edge!'
      : sailMaxed        ? 'Max Sails (3/3)'
      : sailConstraintFail ? sailConstraintFail
      : 'Not on ship';
    const labelColor = valid ? '#88ff88' : ghostSnap ? '#44ddcc' : ghostBlocked ? '#ffaa44' : '#ff8888';

    this.ctx.save();
    this.ctx.font = 'bold 13px Consolas, monospace';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const tw = this.ctx.measureText(label).width + 10;
    this.ctx.fillRect(screenPos.x - tw / 2, screenPos.y + 28, tw, 18);
    this.ctx.fillStyle = labelColor;
    this.ctx.fillText(label, screenPos.x, screenPos.y + 30);
    this.ctx.restore();
  }
}
