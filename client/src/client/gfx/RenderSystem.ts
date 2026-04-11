/**
 * Main Rendering System
 * 
 * Centralized rendering system that handles all visual output.
 * Separated from game logic for clean architecture.
 */

import { GraphicsConfig } from '../ClientConfig.js';
import { Camera } from './Camera.js';
import { ParticleSystem } from './ParticleSystem.js';
import { EffectRenderer, AnnouncementKind } from './EffectRenderer.js';
import { WorldState, Ship, Player, Cannonball, Npc, NPC_STATE_MOVING, NPC_STATE_AT_GUN, GhostPlacement, GhostModuleKind, COMPANY_NEUTRAL, COMPANY_PIRATES, COMPANY_NAVY, COMPANY_GHOST, SHIP_TYPE_GHOST, PlacedStructure, ConstructionPhase } from '../../sim/Types.js';
import { ShipModule, createCompleteHullSegments, PlankSegment, PlankModuleData, getModuleFootprint, footprintsOverlap } from '../../sim/modules.js';
import { Vec2 } from '../../common/Vec2.js';
import { PolygonUtils } from '../../common/PolygonUtils.js';
import { ClientState } from '../ClientApplication.js';
import { RadialMenu } from '../ui/RadialMenu.js';

/** Max hull HP for ghost (Phantom Brig) ships — server uses raw HP scale, not 0-100. */
const GHOST_MAX_HULL_HP = 60000;

/** NPC fill colours keyed by assigned task name (matches ManningPriorityPanel task colours). */
const NPC_TASK_COLORS: Record<string, string> = {
  Sails:   '#5aafff',
  Cannons: '#ffaa44',
  Repairs: '#55dd66',
  Combat:  '#aa44ff',
  Idle:    '#DAA520',
};

/** Wooden module kinds that can catch fire — constant, never changes. */
const WOODEN_KINDS: ReadonlySet<string> = new Set(['plank', 'deck', 'mast']);

/** Module kinds where only one occupant (player or NPC) is allowed at a time. */
const SINGLE_OCCUPANCY_KINDS: ReadonlySet<string> = new Set(['cannon', 'swivel', 'mast', 'helm']);

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
  
  // Render queue for layered rendering (10 pre-allocated buckets: index 0 = layer -1, index 1-9 = layers 1-9)
  private readonly renderBuckets: RenderQueueItem[][] = Array.from({length: 10}, () => []);
  
  // Hover state
  private mouseWorldPos: Vec2 | null = null;
  private hoveredModule: { ship: Ship; module: any } | null = null;
  private hoveredNpc: Npc | null = null;
  /** Ship (other than the player's own) whose hull the cursor is over. */
  private hoveredShip: Ship | null = null;

  /** Timestamp (ms) of the last sword swing, used to draw a cooldown ring. */
  private lastSwordSwingAt: number = 0;
  private swordCooldownMs: number = 800;
  /** Set to true each frame when the local player has the sword as their active item. */
  public swordEquipped: boolean = false;

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
  /** Whether swivel gun placement build mode is active (swivel item held). */
  private swivelBuildMode: boolean = false;
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
  /** Cached local player company for the current frame — set at start of renderWorld. */
  private _localCompanyId: number = 0;
  /** Cached local player for the current frame — set once in renderWorld, shared by all draw methods. */
  private _cachedLocalPlayer: Player | null = null;
  /** Placed island structures — updated via addPlacedStructure / setPlacedStructures. */
  private placedStructures: PlacedStructure[] = [];
  /** Structure currently under the cursor (within hover range of the local player). */
  private _hoveredStructure: PlacedStructure | null = null;
  /** ID of the structure that blocked the last placement attempt (shown in red during build mode). */
  private _blockerStructureId: number | null = null;
  /** Timestamp when the blocker highlight should expire (ms). */
  private _blockerExpiry = 0;
  /** Tree node currently under cursor (world coords) — updated each frame in drawIsland. */
  private _hoveredTree: { wx: number; wy: number } | null = null;
  /** Fiber plant currently under cursor (world coords) — updated each frame in drawIsland. */
  private _hoveredFiberPlant: { wx: number; wy: number } | null = null;
  /** Rock node currently under cursor (world coords) — updated each frame in drawIsland. */
  private _hoveredRock: { wx: number; wy: number } | null = null;
  /** When non-null, draw an island placement ghost at mouseWorldPos for this item kind. */
  private islandBuildKind: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | null = null;
  /** Rotation (degrees) applied to the island floor/workbench placement ghost. */
  private islandBuildRotationDeg = 0;
  private _wallGhostRotRad: number = 0; // rotation (radians) of wall/door ghost, inherited from floor edge
  /** True when the placement ghost is beyond the server's max placement range (200 px). */
  private _islandGhostTooFar = false;
  /** Last snapped placement position (may differ from raw cursor when snap-to-grid is active). */
  private _snappedBuildPos: { x: number; y: number } | null = null;
  /** Rotation (degrees) of the source tile that generated the current snap, or null if freely placing. */
  private _snappedBuildRotation: number | null = null;

  /** Returns whether the last-rendered island build ghost was out of placement range. */
  getIslandBuildTooFar(): boolean { return this._islandGhostTooFar; }
  /** Returns the current snapped placement position (or null when no ghost is active). */
  getSnappedBuildPos(): { x: number; y: number } | null { return this._snappedBuildPos; }
  /** Returns the rotation (deg) inherited from the snap source tile, or null if freely placing. */
  getSnappedBuildRotation(): number | null { return this._snappedBuildRotation; }
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
  /** Last known NPC set — used to detect NPC deaths for kill announcements. */
  private lastKnownNpcIds: Set<number> = new Set();
  /** NPC id → name cache for the kill announcement message. */
  private _lastNpcNames: Map<number, string> = new Map();
  /** Last ship to fire a cannonball near each ship — used for sink announcements. */
  private lastAttackerOf: Map<number, number> = new Map();
  /** Last splash emit time (ms) per sinking ship — throttles particle emission. */
  private sinkSplashTimers: Map<number, number> = new Map();
  /** playerId → timestamp of last damage hit, for red flash overlay. */
  private playerDamageFlash: Map<number, number> = new Map();
  /** npcId → timestamp of last damage hit, for red flash overlay. */
  private npcDamageFlash: Map<number, number> = new Map();
  /** Key → fire expiry timestamp (ms). Key format: "npc:{id}" | "player:{id}" | "module:{shipId}:{moduleId}" */
  private burningEntities: Map<string, number> = new Map();
  /** Cached fire-point positions in ship-local space per burning module. Generated once on first draw. */
  private moduleFirePoints: Map<string, Array<{lx: number; ly: number; r: number}>> = new Map();
  /**
   * Short-lived hit-scan tracer lines for grapeshot / canister bursts.
   * Each entry: origin (world px), angle (rad), range (px), spawnAt (ms), ttl (ms).
   */
  private grapeshotTracers: Array<{
    x: number; y: number; angle: number; range: number;
    spawnAt: number; ttl: number; ammoType: number;
  }> = [];

  // ── Island data (server-driven via ISLANDS message; falls back to default) ──

  /** Returns a CSS color for a structure's owning company (0=neutral grey, 1=pirate orange, 2=navy blue). */
  private static structureCompanyColor(companyId: number): string {
    if (companyId === 1) return 'rgba(255, 100, 50, 0.85)';  // Pirates
    if (companyId === 2) return 'rgba(50, 130, 255, 0.85)';  // Navy
    return 'rgba(160, 160, 160, 0.60)';                       // Neutral
  }

  /** Preset visual parameters keyed by preset name. */
  private static readonly ISLAND_PRESETS: Record<string, {
    beachRadius: number; grassRadius: number;
    beachBumps: number[]; grassBumps: number[];
    beachColors: [string, string, string];  // radial gradient 0/0.65/1.0
    grassColors: [string, string, string];  // radial gradient 0/0.7/1.0
    borderColor: string;
    grassPolyScale?: number;  // for polygon islands: inner-grass scale (e.g. 0.78)
  }> = {
    tropical: {
      beachRadius: 185, grassRadius: 148,
      beachBumps:  [ 0, 14, -9, 20,  6, -13, 16,  3, -7, 18, -5, 10, 12, -11,  7, -9],
      grassBumps:  [ 0,  9, -6, 13,  4,  -9, 10,  2, -4, 11, -3,  7,  8,  -7,  5, -6],
      beachColors: ['#c8a96e', '#d4b97a', '#e8d4a0'],
      grassColors: ['#47692a', '#598038', '#6b9444'],
      borderColor: '#9a7840',
    },
    jungle: {
      beachRadius: 200, grassRadius: 172,
      beachBumps:  [-5, 18, -12, 22,  8, -16, 14,  5, -10, 20, -8, 13, 16, -14,  9, -11],
      grassBumps:  [-3, 12,  -8, 15,  5, -11,  9,  3,  -6, 13, -5,  9, 11,  -9,  6,  -7],
      beachColors: ['#b09058', '#c4a464', '#d8be80'],
      grassColors: ['#2e4f1a', '#3c6522', '#4a7a2c'],
      borderColor: '#7a6030',
    },
    desert: {
      beachRadius: 165, grassRadius: 80,
      beachBumps:  [ 2, 10, -6, 15,  4, -10, 12,  1, -5, 14, -3,  7,  9,  -8,  5, -6],
      grassBumps:  [ 1,  6, -4,  9,  3,  -6,  7,  1, -3,  8, -2,  4,  5,  -5,  3, -4],
      beachColors: ['#d4b870', '#e0c880', '#f0dca0'],
      grassColors: ['#8f7a30', '#a08840', '#b09850'],
      borderColor: '#a08040',
    },
    rocky: {
      beachRadius: 170, grassRadius: 120,
      beachBumps:  [-8, 20, -15, 25, 10, -18, 20,  6, -12, 22, -10, 15, 18, -16, 11, -14],
      grassBumps:  [-5, 13, -10, 16,  6, -12, 13,  4,  -8, 14,  -6,  9, 11, -10,  7,  -9],
      beachColors: ['#a09080', '#b4a490', '#ccc0b0'],
      grassColors: ['#506040', '#607050', '#708060'],
      borderColor: '#807060',
    },
    pine: {
      beachRadius: 178, grassRadius: 145,
      beachBumps:  [ 3, 12, -8, 18,  5, -12, 14,  2, -6, 16, -4,  9, 11, -10,  6, -8],
      grassBumps:  [ 2,  8, -5, 12,  3,  -8,  9,  1, -4, 10, -3,  6,  7,  -6,  4, -5],
      beachColors: ['#b8a478', '#ceb888', '#e2d0a8'],
      grassColors: ['#284a1a', '#345e24', '#40722e'],
      borderColor: '#887048',
    },
    continental: {
      /* Polygon island — beachRadius/grassRadius/bumps unused for rendering.
       * Colors and grassPolyScale are used instead.                           */
      beachRadius: 0, grassRadius: 0,
      beachBumps:  [], grassBumps:  [],
      beachColors: ['#c0a870', '#cbb880', '#ddd0a8'],
      grassColors: ['#3a5e22', '#4a7230', '#5a883e'],
      borderColor: '#8a7040',
      grassPolyScale: 0.78,
    },
  };

  /** Default fallback island — shown before the server sends ISLANDS. */
  private static readonly DEFAULT_ISLAND = {
    id: 0, x: 800, y: 600, preset: 'tropical' as const,
    resources: [
      { ox: -65, oy: -55, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox:  85, oy: -25, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox:  15, oy:  80, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox: -90, oy:  38, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox:  45, oy: -78, type: 'fiber' as const, size: 1.0, hp:  30, maxHp:  30 },
      { ox: -28, oy:  32, type: 'fiber' as const, size: 1.0, hp:  30, maxHp:  30 },
      { ox:  70, oy:  50, type: 'fiber' as const, size: 1.0, hp:  30, maxHp:  30 },
    ],
  };

  /** Live island list — replaced by server ISLANDS message when received. */
  private islands: Array<{
    id: number; x: number; y: number; preset: string;
    resources: Array<{ ox: number; oy: number; type: string; size: number; hp: number; maxHp: number; depletedAt?: number }>;
    vertices?: { x: number; y: number }[];
  }> = [RenderSystem.DEFAULT_ISLAND];

  /** Called by ClientApplication when the server sends the ISLANDS message. */
  setIslands(islands: Array<{ id: number; x: number; y: number; preset: string; resources: Array<{ ox: number; oy: number; type: string; size: number; hp: number; maxHp: number; depletedAt?: number }>; vertices?: { x: number; y: number }[] }>): void {
    this.islands = islands;
  }

  /** Returns the live island list (for proximity checks in ClientApplication). */
  getIslands(): Array<{ id: number; x: number; y: number; preset: string; resources: Array<{ ox: number; oy: number; type: string; size: number; hp: number; maxHp: number; depletedAt?: number }>; vertices?: { x: number; y: number }[] }> {
    return this.islands;
  }

  /** Active flamethrower wave states keyed by cannonId. Client interpolates between server ticks. */
  private flameWaves: Map<number, {
    x: number; y: number; angle: number; halfCone: number;
    waveDist: number; retreating: boolean; retreatDist: number;
    serverUpdateAt: number;
    rotationSpeed: number; // rad/s — used to widen particle cone when aim flicks fast
  }> = new Map();
  /** Client-side smoke trail: cannonball id → ring of past positions with timestamps. */
  private cannonballTrails: Map<number, Array<{ x: number; y: number; t: number }>> = new Map();
  /** Last known world position of each live cannonball — used to spawn water splash on expiry. */
  private cannonballLastPos: Map<number, { x: number; y: number; ammoType: number }> = new Map();
  /** Trail colour override per projectile — future customisation hook. */
  public trailColor: string = 'rgba(180,180,180,{a})';
  private readonly TRAIL_DURATION_MS = 680;  // how long each crumb lives
  private readonly TRAIL_SPACING_MS  = 10;   // min ms between crumbs
  /** Timestamp of last crumb per ball — prevents over-sampling. */
  private trailLastEmit: Map<number, number> = new Map();
  
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
  spawnExplosion(worldPos: Vec2, intensity: number = 1.0): void {
    this.particleSystem.createExplosion(worldPos, intensity);
  }

  spawnDamageNumber(worldPos: Vec2, damage: number, isKill: boolean = false): void {
    this.effectRenderer.createDamageNumber(worldPos, damage, isKill);
  }

  /**
   * Record a damage hit on an entity so the next ~300 ms of frames
   * render a red flash overlay on that entity's circle.
   */
  notifyEntityDamaged(id: number, isNpc: boolean): void {
    if (isNpc) this.npcDamageFlash.set(id, performance.now());
    else        this.playerDamageFlash.set(id, performance.now());
  }

  /** Spawn a hit-scan flamethrower cone flash effect at world position (x, y).
   * @deprecated Use updateFlameWave() — kept for backward compat with any remaining call sites.
   */
  spawnFlameCone(_x: number, _y: number, _angle: number, _halfCone: number): void { /* no-op */ }

  /**
   * Spawn hit-scan tracer lines for a grapeshot or canister burst.
   * @param ammoType 10 = grapeshot, 12 = canister
   */
  spawnGrapeshotTracers(x: number, y: number, angle: number, ammoType: number): void {
    // 3 tracers for grapeshot (±12°), 5 for canister (±20°)
    const isCanister = ammoType === 12;
    const count      = isCanister ? 5 : 3;
    const halfSpread = isCanister ? (20 * Math.PI / 180) : (12 * Math.PI / 180);
    const range      = isCanister ? 180 : 250;
    const now        = performance.now();

    // Server broadcasts pivot position; offset to barrel tip (matches server BARREL_LEN = 20px)
    const BARREL_TIP = 20;
    const bx = x + Math.cos(angle) * BARREL_TIP;
    const by = y + Math.sin(angle) * BARREL_TIP;

    for (let p = 0; p < count; p++) {
      const t   = count > 1 ? p / (count - 1) : 0.5;
      const ray = angle + halfSpread * (2 * t - 1);
      this.grapeshotTracers.push({ x: bx, y: by, angle: ray, range, spawnAt: now, ttl: 180, ammoType });
    }
  }

  /**
   * Called each time a FLAME_WAVE_UPDATE arrives from the server.
   * The client stores the server-reported state and locally interpolates
   * the wave front between ticks for smooth 60fps visuals.
   */
  updateFlameWave(
    cannonId: number, _shipId: number,
    x: number, y: number, angle: number, halfCone: number,
    waveDist: number, retreating: boolean, retreatDist: number,
    dead: boolean,
  ): void {
    if (dead) { this.flameWaves.delete(cannonId); return; }
    const prev = this.flameWaves.get(cannonId);
    // Compute shortest angular distance to derive rotation speed
    let rotationSpeed = 0;
    if (prev) {
      const dt = (performance.now() - prev.serverUpdateAt) / 1000;
      if (dt > 0.001) {
        let diff = angle - prev.angle;
        // Wrap to [-π, π]
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        rotationSpeed = Math.abs(diff) / dt;
      } else {
        rotationSpeed = prev.rotationSpeed; // hold last value if update arrived too fast
      }
    }
    this.flameWaves.set(cannonId, {
      x, y, angle, halfCone,
      waveDist,
      retreating,
      retreatDist,
      serverUpdateAt: performance.now(),
      rotationSpeed,
    });
  }

  private drawFlameCones(camera: Camera): void {
    if (this.flameWaves.size === 0) return;

    const WAVE_SPEED    = 350; // px/s — must match FLAME_WAVE_SPEED on server
    const RETREAT_SPEED = 700; // px/s — must match FLAME_RETREAT_SPEED on server
    const now           = performance.now();

    for (const [cannonId, fw] of this.flameWaves) {
      // Auto-expire stale entries (server went silent for > 2s)
      if (now - fw.serverUpdateAt > 2000) { this.flameWaves.delete(cannonId); continue; }

      // Client-side interpolation: advance wave/retreat from last server report
      const dt = (now - fw.serverUpdateAt) / 1000;
      const FLAME_RANGE  = 280;
      const waveDist    = fw.retreating ? fw.waveDist
                                        : Math.min(fw.waveDist + dt * WAVE_SPEED, FLAME_RANGE);
      const retreatDist = fw.retreating ? Math.min(fw.retreatDist + dt * RETREAT_SPEED, FLAME_RANGE) : 0;

      // Nothing to draw if retreat has consumed the whole cone
      if (retreatDist >= waveDist) continue;

      // ── Particle effects — pulsed wave emission: dense bursts every 110ms ─
      // 60ms "on" window followed by 50ms gap creates visible waves of flame
      const emitPhase = now % 110;
      if (emitPhase <= 60) {
        this.particleSystem.createFlameConeParticles(
          Vec2.from(fw.x, fw.y),
          fw.angle,
          fw.halfCone,
          retreatDist,
          waveDist,
          fw.rotationSpeed,
        );
      }
    }
  }

  private drawGrapeshotTracers(camera: Camera): void {
    if (this.grapeshotTracers.length === 0) return;
    const now  = performance.now();
    const ctx  = this.ctx;
    const zoom = camera.getState().zoom;

    this.grapeshotTracers = this.grapeshotTracers.filter(t => now - t.spawnAt < t.ttl);
    for (const t of this.grapeshotTracers) {
      const age    = now - t.spawnAt;
      const frac   = age / t.ttl;               // 0 → 1 as tracer fades
      const alpha  = (1 - frac) * 0.85;
      const origin = camera.worldToScreen(Vec2.from(t.x, t.y));
      const tipX   = t.x + Math.cos(t.angle) * t.range;
      const tipY   = t.y + Math.sin(t.angle) * t.range;
      const tip    = camera.worldToScreen(Vec2.from(tipX, tipY));

      // Faded tracer line: bright white core → transparent tip
      const grad = ctx.createLinearGradient(origin.x, origin.y, tip.x, tip.y);
      if (t.ammoType === 12) {
        // Canister: slightly wider, warm-white
        grad.addColorStop(0,   `rgba(255,230,180,${alpha.toFixed(3)})`);
        grad.addColorStop(0.5, `rgba(255,180,80,${(alpha * 0.6).toFixed(3)})`);
        grad.addColorStop(1,    'rgba(255,120,0,0)');
        ctx.lineWidth = Math.max(1, 1.5 * zoom);
      } else {
        // Grapeshot: thin white tracer
        grad.addColorStop(0,   `rgba(255,255,220,${alpha.toFixed(3)})`);
        grad.addColorStop(0.4, `rgba(200,200,160,${(alpha * 0.5).toFixed(3)})`);
        grad.addColorStop(1,    'rgba(160,160,100,0)');
        ctx.lineWidth = Math.max(0.5, 1 * zoom);
      }
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
    }
  }

  /** Mark an entity or module as burning for `durationMs` milliseconds. */
  notifyFireEffect(entityType: 'npc' | 'player' | 'module', id: number, durationMs: number,
    shipId?: number, moduleId?: number): void {
    const key = entityType === 'module'
      ? `module:${shipId}:${moduleId}`
      : `${entityType}:${id}`;
    console.log(`[FIRE] notifyFireEffect type=${entityType} key=${key} dur=${durationMs}ms burningCount=${this.burningEntities.size + 1}`);
    this.burningEntities.set(key, performance.now() + durationMs);
  }

  /** Clear the burning state for an entity or module. */
  notifyFireExtinguished(entityType: 'npc' | 'player' | 'module', id: number,
    shipId?: number, moduleId?: number): void {
    const key = entityType === 'module'
      ? `module:${shipId}:${moduleId}`
      : `${entityType}:${id}`;
    this.burningEntities.delete(key);
    if (entityType === 'module') this.moduleFirePoints.delete(key);
  }

  /** Returns true if an entity/module is currently marked as burning. */
  private isBurning(entityType: 'npc' | 'player' | 'module', id: number,
    shipId?: number, moduleId?: number): boolean {
    const key = entityType === 'module'
      ? `module:${shipId}:${moduleId}`
      : `${entityType}:${id}`;
    const expiry = this.burningEntities.get(key);
    if (expiry === undefined) return false;
    if (performance.now() > expiry) { this.burningEntities.delete(key); return false; }
    return true;
  }

  /** Draw an animated fire overlay (flicker ring) centred at (cx, cy) in screen space. */
  private drawFireOverlay(cx: number, cy: number, radius: number): void {
    const ctx = this.ctx;
    const t = performance.now() / 1000;

    // ── Seething heat haze ── DISABLED (alpha=0 for debugging)
    const hazeGrd = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 2.2);
    hazeGrd.addColorStop(0,   'rgba(255,140,0,0)');
    hazeGrd.addColorStop(0.5, 'rgba(200,40,0,0)');
    hazeGrd.addColorStop(1,   'rgba(100,10,0,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = hazeGrd;
    ctx.fill();

    // ── Flame tongues ── DISABLED (alpha=0 for debugging)
    const numFlames = 9;
    for (let layer = 0; layer < 2; layer++) {
      const layerScale = layer === 0 ? 1.0 : 0.65;
      const layerSpeed = layer === 0 ? 3.5 : 5.2;
      const layerOffset = layer * (Math.PI / numFlames);
      for (let i = 0; i < numFlames; i++) {
        const angle   = (i / numFlames) * Math.PI * 2 + t * layerSpeed + layerOffset;
        const flicker = 0.78 + 0.22 * Math.sin(t * 11 + i * 1.7 + layer * 2.4);
        const orbitR  = radius * 0.50 * layerScale * flicker;
        const fx      = cx + Math.cos(angle) * orbitR;
        const fy      = cy + Math.sin(angle) * orbitR;
        const fh      = radius * 0.70 * layerScale * flicker;
        const grad = ctx.createRadialGradient(fx, fy - fh * 0.35, 0, fx, fy, fh);
        grad.addColorStop(0,   'rgba(255,255,180,0)');
        grad.addColorStop(0.25,'rgba(255,200,40,0)');
        grad.addColorStop(0.55,'rgba(255,80,0,0)');
        grad.addColorStop(1,   'rgba(180,10,0,0)');
        ctx.beginPath();
        ctx.ellipse(fx, fy - fh * 0.28, fh * 0.34, fh * 0.62, 0, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    // ── Central hotspot ── DISABLED (alpha=0 for debugging)
    const coreGrd = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.6);
    const cf = 0.80 + 0.20 * Math.sin(t * 19);
    coreGrd.addColorStop(0,   'rgba(255,255,230,0)');
    coreGrd.addColorStop(0.5, 'rgba(255,160,20,0)');
    coreGrd.addColorStop(1,   'rgba(255,60,0,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = coreGrd;
    ctx.fill();

    // ── Smoke column ── DISABLED (alpha=0 for debugging)
    const numSmoke = 4;
    for (let s = 0; s < numSmoke; s++) {
      const sx    = cx + Math.sin(t * 1.8 + s * 1.2) * radius * 0.3;
      const riseY = ((t * 28 + s * 22) % (radius * 3)) - radius * 0.5;
      const sr    = radius * (0.22 + s * 0.06 + riseY / (radius * 6));
      ctx.beginPath();
      ctx.arc(sx, cy - radius * 0.9 - riseY, Math.max(2, sr), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(50,30,10,0)';
      ctx.fill();
    }
  }

  /**
   * Spawn a sword swing arc effect at a world position.
   * @param worldPos  Attacker's world position.
   * @param direction Attack angle in radians.
   */
  spawnSwordArc(worldPos: Vec2, direction: number): void {
    this.effectRenderer.createSwordArc(worldPos, direction);
  }

  /**
   * Spawn sail fiber tear particles at a world position (bar shot mast hit)
   */
  spawnSailFiberEffect(worldPos: Vec2, intensity: number = 1.0): void {
    this.particleSystem.createSailFiberEffect(worldPos, intensity);
  }

  /**
   * Show a top-centre announcement banner.
   * @param text    Message to display.
   * @param kind    'ship_sink' | 'npc_kill' | 'info'
   * @param duration Seconds to display (default 3.5).
   */
  showAnnouncement(text: string, kind: AnnouncementKind = 'info', duration = 3.5): void {
    this.effectRenderer.createAnnouncement(text, kind, duration);
  }

  /** Returns the ship ID of the last ship that fired a cannonball near shipId, or null. */
  getLastAttackerOf(shipId: number): number | null {
    return this.lastAttackerOf.get(shipId) ?? null;
  }

  /**
   * Update render system (particles, effects, etc.)
   */
  update(deltaTime: number): void {
    this.particleSystem.update(deltaTime);
    this.effectRenderer.update(deltaTime);
  }
  
  private swordCursorMousePos: Vec2 | null = null;
  private swordCursorLastAttackMs = 0;
  private swordCursorCooldownMs   = 1000;

  /** Ladder hold-progress ring (fills over the hold threshold while E is held near a ladder). */
  private ladderHoldMousePos: Vec2 | null = null;
  private ladderHoldStartMs = 0;
  private ladderHoldActive  = false;
  private _quickFlashPos: Vec2 | null = null;
  private _quickFlashStartMs = -1;

  /** Generic radial action menu (set by ClientApplication). */
  private _radialMenu: RadialMenu | null = null;
  setRadialMenu(menu: RadialMenu): void { this._radialMenu = menu; }

  /** On-screen instruction shown while the player is in "Move To" NPC targeting mode. */
  private _moveToHint: string | null = null;
  /** NPC id whose world position is the arrow-line origin while in Move To mode. */
  private _moveToSourceNpcId: number | null = null;

  /** Set the Move To hint text (shown centre-bottom of screen until cleared). */
  setMoveToHint(text: string): void { this._moveToHint = text; }
  /** Record which NPC is the source so the arrow line can originate from it. */
  setMoveToSourceNpc(npcId: number | null): void { this._moveToSourceNpcId = npcId; }
  /** Clear the Move To hint and arrow-line source together. */
  clearMoveToHint(): void { this._moveToHint = null; this._moveToSourceNpcId = null; }

  /** Begin drawing the ladder hold-progress ring at the given screen position. */
  startLadderHoldRing(mouseScreenPos: Vec2): void {
    this.ladderHoldMousePos = mouseScreenPos;
    this.ladderHoldStartMs  = performance.now();
    this.ladderHoldActive   = true;
  }

  /** Stop drawing the ladder hold-progress ring. */
  stopLadderHoldRing(): void {
    this.ladderHoldActive   = false;
    this.ladderHoldMousePos = null;
  }

  /** Flash a green confirmation ring at the given screen position (quick tap feedback). */
  flashInteract(pos: Vec2): void {
    this._quickFlashPos     = pos;
    this._quickFlashStartMs = performance.now();
  }

  /** Flash a red cancel ring at the given screen position. */
  flashCancel(pos: Vec2): void {
    this._quickFlashPos     = pos;
    this._quickFlashStartMs = -(performance.now()); // negative = red
  }

  /**
   * Draw an animated marching-arrow line from the commanded NPC to the mouse cursor.
   * Shown whenever Move To targeting mode is active.
   */
  private drawMoveToArrowLine(worldState: WorldState, camera: Camera): void {
    if (this._moveToSourceNpcId === null || !this.mouseWorldPos) return;

    // Resolve the NPC's current world position (same logic as drawNpc)
    const npc = worldState.npcs.find(n => n.id === this._moveToSourceNpcId);
    if (!npc) return;

    let npcWorldPos = npc.position;
    if (npc.shipId) {
      const ship = worldState.ships.find(s => s.id === npc.shipId);
      if (ship && npc.localPosition) {
        const cosR = Math.cos(ship.rotation);
        const sinR = Math.sin(ship.rotation);
        npcWorldPos = Vec2.from(
          ship.position.x + npc.localPosition.x * cosR - npc.localPosition.y * sinR,
          ship.position.y + npc.localPosition.x * sinR + npc.localPosition.y * cosR,
        );
      }
    }

    // ── Module highlight: amber glow when cursor hovers a module in Move To mode ──
    const now = performance.now();
    if (this.hoveredModule) {
      const { ship: modShip, module: mod } = this.hoveredModule;
      const screenPos   = camera.worldToScreen(modShip.position);
      const cameraState = camera.getState();
      const glowPulse   = 0.55 + 0.45 * Math.sin(now / 160);
      const glowAlpha   = 0.6 + 0.4 * glowPulse;

      // Build the module's local-space path for the given kind
      const buildModulePath = (ctx: CanvasRenderingContext2D): void => {
        ctx.beginPath();
        if (mod.kind === 'mast') {
          ctx.arc(0, 0, (mod as any).radius || 15, 0, Math.PI * 2);
        } else if (mod.kind === 'helm' || mod.kind === 'steering-wheel') {
          ctx.arc(0, 0, 8, 0, Math.PI * 2);
        } else if (mod.kind === 'cannon') {
          ctx.rect(-15, -10, 30, 20);
        } else if (mod.kind === 'swivel') {
          ctx.arc(0, 0, 10, 0, Math.PI * 2);
        } else if (mod.kind === 'ladder') {
          ctx.rect(-10, -20, 20, 40);
        } else if (mod.kind === 'plank') {
          const w = (mod as any).length || 20;
          const h = (mod as any).width  || 10;
          ctx.rect(-w / 2, -h / 2, w, h);
        } else {
          ctx.rect(-10, -10, 20, 20);
        }
      };

      this.ctx.save();
      this.ctx.translate(screenPos.x, screenPos.y);
      this.ctx.rotate(modShip.rotation - cameraState.rotation);
      this.ctx.scale(cameraState.zoom, cameraState.zoom);
      this.ctx.translate(mod.localPos.x, mod.localPos.y);
      this.ctx.rotate((mod as any).localRot ?? 0);

      // Outer glow pass
      this.ctx.shadowColor  = '#ffe066';
      this.ctx.shadowBlur   = (14 + glowPulse * 6) / cameraState.zoom;
      this.ctx.strokeStyle  = `rgba(255, 220, 60, ${(glowAlpha * 0.55).toFixed(3)})`;
      this.ctx.lineWidth    = (5 + glowPulse * 3) / cameraState.zoom;
      this.ctx.globalAlpha  = 1;
      buildModulePath(this.ctx);
      this.ctx.stroke();

      // Inner crisp stroke
      this.ctx.shadowBlur   = 0;
      this.ctx.strokeStyle  = `rgba(255, 240, 130, ${(glowAlpha * 0.9).toFixed(3)})`;
      this.ctx.lineWidth    = 2.5 / cameraState.zoom;
      this.ctx.globalAlpha  = glowAlpha;
      buildModulePath(this.ctx);
      this.ctx.stroke();

      // Translucent amber fill overlay
      this.ctx.globalAlpha  = 0.08 + 0.06 * glowPulse;
      this.ctx.fillStyle    = '#ffe066';
      buildModulePath(this.ctx);
      this.ctx.fill();

      this.ctx.restore();
    }

    // ── Ship hull highlight: pulse the hull outline when cursor is over a ship ──
    // Only when: no module is hovered (module highlight takes priority), AND the
    // NPC is not already on that ship (boarding is the action — not an intra-ship move).
    const hullHitShip = (() => {
      if (!this.mouseWorldPos || this.hoveredModule) return null;
      const pointInPoly = (px: number, py: number, poly: Vec2[]): boolean => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x, yi = poly[i].y;
          const xj = poly[j].x, yj = poly[j].y;
          if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
            inside = !inside;
        }
        return inside;
      };
      for (const s of worldState.ships) {
        if (!s.hull || s.hull.length < 3) continue;
        // Skip if the NPC is already on this ship — no boarding would occur
        if (npc.shipId && npc.shipId === s.id) continue;
        const dx  = this.mouseWorldPos!.x - s.position.x;
        const dy  = this.mouseWorldPos!.y - s.position.y;
        const cos = Math.cos(-s.rotation);
        const sin = Math.sin(-s.rotation);
        if (pointInPoly(dx * cos - dy * sin, dx * sin + dy * cos, s.hull)) return s;
      }
      return null;
    })();

    if (hullHitShip) {
      const screenPos    = camera.worldToScreen(hullHitShip.position);
      const cameraState  = camera.getState();
      const hull         = hullHitShip.hull;
      // Alternating gold/white glow pulse
      const glowPulse    = 0.55 + 0.45 * Math.sin(now / 160);
      const glowAlpha    = 0.6 + 0.4 * glowPulse;

      this.ctx.save();
      this.ctx.translate(screenPos.x, screenPos.y);
      this.ctx.scale(cameraState.zoom, cameraState.zoom);
      this.ctx.rotate(hullHitShip.rotation - cameraState.rotation);

      // Outer glow pass  (wider, dimmer)
      this.ctx.shadowColor  = '#ffe066';
      this.ctx.shadowBlur   = (14 + glowPulse * 6) / cameraState.zoom;
      this.ctx.strokeStyle  = `rgba(255, 220, 60, ${(glowAlpha * 0.55).toFixed(3)})`;
      this.ctx.lineWidth    = (5 + glowPulse * 3) / cameraState.zoom;
      this.ctx.globalAlpha  = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) this.ctx.lineTo(hull[i].x, hull[i].y);
      this.ctx.closePath();
      this.ctx.stroke();

      // Inner crisp stroke
      this.ctx.shadowBlur   = 0;
      this.ctx.strokeStyle  = `rgba(255, 240, 130, ${(glowAlpha * 0.9).toFixed(3)})`;
      this.ctx.lineWidth    = (2.5) / cameraState.zoom;
      this.ctx.globalAlpha  = glowAlpha;
      this.ctx.beginPath();
      this.ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) this.ctx.lineTo(hull[i].x, hull[i].y);
      this.ctx.closePath();
      this.ctx.stroke();

      // Translucent amber fill overlay
      this.ctx.globalAlpha  = 0.08 + 0.06 * glowPulse;
      this.ctx.fillStyle    = '#ffe066';
      this.ctx.beginPath();
      this.ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) this.ctx.lineTo(hull[i].x, hull[i].y);
      this.ctx.closePath();
      this.ctx.fill();

      this.ctx.restore();
    }

    // ── Arrow colour mode ─────────────────────────────────────────────────────
    // yellow  = default (world / hull target)
    // green   = hovered module that is free
    // red     = hovered module that is already occupied by another NPC
    let arrowMode: 'yellow' | 'green' | 'red' = 'yellow';
    if (this.hoveredModule) {
      const modKind = this.hoveredModule.module.kind as string;
      if (SINGLE_OCCUPANCY_KINDS.has(modKind)) {
        const modId = this.hoveredModule.module.id as number;
        const occupied = worldState.npcs.some(
          n => n.id !== this._moveToSourceNpcId && n.assignedWeaponId === modId,
        );
        arrowMode = occupied ? 'red' : 'green';
      } else {
        arrowMode = 'green'; // non-occupancy modules are always free
      }
    }

    // Palette per mode  [base, dimBase(rgba), dot]
    const ARROW_PALETTES = {
      yellow: { base: '#ffe066', dim: 'rgba(255,220,60,0.45)',  dot: '#fff8a0' },
      green:  { base: '#44ff88', dim: 'rgba(68,255,136,0.45)',  dot: '#a0ffe0' },
      red:    { base: '#ff4455', dim: 'rgba(255,68,80,0.45)',   dot: '#ffb0b8' },
    } as const;
    const palette = ARROW_PALETTES[arrowMode];
    // ─────────────────────────────────────────────────────────────────────────

    const src  = camera.worldToScreen(npcWorldPos);
    const dst  = camera.worldToScreen(this.mouseWorldPos);
    const dx   = dst.x - src.x;
    const dy   = dst.y - src.y;
    const totalLen = Math.sqrt(dx * dx + dy * dy);
    if (totalLen < 8) return;

    const UX  = dx / totalLen;
    const UY  = dy / totalLen;
    // Perpendicular unit vector
    const PX  = -UY;
    const PY  =  UX;
    const ctx = this.ctx;

    ctx.save();

    // ── Dashed base line (scrolling animation) ───────────────────
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -((now / 22) % 14);
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(dst.x, dst.y);
    ctx.strokeStyle = palette.dim;
    ctx.lineWidth   = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // ── Marching chevron arrowheads ────────────────────────────
    const SPACING   = 38;   // px between arrow tips
    const HALF_W    = 7;    // half wingspan
    const BACK_LEN  = 9;    // how far behind the tip the wings start
    const MARCH_SPD = 0.055; // px per ms

    const marchOffset = (now * MARCH_SPD) % SPACING;
    const numArrows   = Math.ceil(totalLen / SPACING) + 1;

    ctx.lineWidth   = 2.2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (let i = 0; i < numArrows; i++) {
      // t = distance from src to the arrow tip
      const t = marchOffset + i * SPACING;
      if (t < 14 || t > totalLen - 10) continue; // keep clear of endpoints

      // Fade in near src, fade out near dst
      const edgeFade = Math.min(t / 28, 1) * Math.min((totalLen - 10 - t) / 28, 1);
      if (edgeFade <= 0) continue;

      // Subtle pulse so each arrow breathes slightly out of phase
      const pulse = 0.72 + 0.28 * Math.sin(now / 180 + i * 1.1);

      const tx = src.x + UX * t;
      const ty = src.y + UY * t;

      ctx.globalAlpha = edgeFade * pulse * 0.92;
      ctx.strokeStyle = palette.base;
      ctx.beginPath();
      // Left wing: from rear-left to tip
      ctx.moveTo(
        tx - UX * BACK_LEN + PX * HALF_W,
        ty - UY * BACK_LEN + PY * HALF_W,
      );
      ctx.lineTo(tx, ty);
      // Right wing: tip back to rear-right
      ctx.lineTo(
        tx - UX * BACK_LEN - PX * HALF_W,
        ty - UY * BACK_LEN - PY * HALF_W,
      );
      ctx.stroke();
    }

    // ── Pulsing target ring at the destination ─────────────────────
    const ringPulse = 0.65 + 0.35 * Math.sin(now / 220);
    ctx.globalAlpha = 0.85 * ringPulse;
    ctx.beginPath();
    ctx.arc(dst.x, dst.y, 10 + (1 - ringPulse) * 4, 0, Math.PI * 2);
    ctx.strokeStyle = palette.base;
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Inner dot at cursor
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(dst.x, dst.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = palette.dot;
    ctx.fill();

    // ── Source NPC indicator dot ──────────────────────────
    const srcPulse = 0.6 + 0.4 * Math.sin(now / 200 + Math.PI); // opposite phase to ring
    ctx.globalAlpha = 0.8 * srcPulse;
    ctx.beginPath();
    ctx.arc(src.x, src.y, 12 + (1 - srcPulse) * 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#80e0ff';
    ctx.lineWidth   = 2;
    ctx.stroke();

    ctx.globalAlpha = 1.0;
    ctx.restore();
  }

  /** Draw the "Move To" hint banner at the bottom-centre of the screen. */
  private drawMoveToHint(): void {
    if (!this._moveToHint) return;
    const ctx  = this.ctx;
    const cw   = this.canvas.width;
    const ch   = this.canvas.height;
    const text = this._moveToHint;
    ctx.save();
    ctx.font      = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw  = ctx.measureText(text).width;
    const bw  = tw + 32;
    const bh  = 36;
    const bx  = (cw - bw) / 2;
    const by  = ch - 80;
    ctx.fillStyle   = 'rgba(0,0,0,0.75)';
    ctx.strokeStyle = '#ffdd00';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffe066';
    ctx.fillText(`📍 ${text}`, cw / 2, by + bh / 2);
    ctx.restore();
  }

  /** Called each frame from ClientApplication to keep sword cursor ring in sync. */
  updateSwordCooldownCursor(mouseScreenPos: Vec2 | null, lastAttackMs: number, cooldownMs: number): void {
    this.swordCursorMousePos    = mouseScreenPos;
    this.swordCursorLastAttackMs = lastAttackMs;
    this.swordCursorCooldownMs   = cooldownMs;
  }

  /**
   * Update mouse position for hover detection
   */
  updateMousePosition(worldPos: Vec2): void {
    this.mouseWorldPos = worldPos;
  }

  /**
   * Notify the render system that a sword swing just happened.
   * Starts the cooldown ring animation around the cursor.
   * @param cooldownMs Total cooldown duration in milliseconds (default 800ms).
   */
  notifySwordSwing(cooldownMs: number = 800): void {
    this.lastSwordSwingAt = performance.now();
    this.swordCooldownMs  = cooldownMs;
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
   * Enable or disable swivel gun placement build mode
   */
  setSwivelBuildMode(active: boolean): void {
    this.swivelBuildMode = active;
  }

  /**
   * Whether swivel build mode is currently active
   */
  isInSwivelBuildMode(): boolean {
    return this.swivelBuildMode;
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

  // ── Island structure management ────────────────────────────────────────────

  /** Add (or update) a single placed structure received from the server. */
  addPlacedStructure(s: PlacedStructure): void {
    const idx = this.placedStructures.findIndex(p => p.id === s.id);
    if (idx >= 0) this.placedStructures[idx] = s;
    else this.placedStructures.push(s);
  }

  /** Replace the full placed-structure list (e.g. on join). */
  setPlacedStructures(arr: PlacedStructure[]): void {
    this.placedStructures = [...arr];
  }

  /** Remove a single structure by id (e.g. after server confirms demolish). */
  removePlacedStructure(id: number): void {
    this.placedStructures = this.placedStructures.filter(s => s.id !== id);
  }

  /** Update a structure's company ownership (one-way promotion from server). */
  updateStructureCompany(id: number, companyId: number): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s) s.companyId = companyId;
  }

  updateStructureHp(id: number, hp: number, maxHp: number): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s) { s.hp = hp; s.maxHp = maxHp; }
  }

  /** Update door open/closed state after a door_toggled broadcast. */
  updateStructureDoorOpen(id: number, open: boolean): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s && s.type === 'door') s.doorOpen = open;
  }

  /** Update ship construction state after a shipyard_state broadcast. */
  updateShipyardConstruction(id: number, phase: ConstructionPhase, modulesPlaced: string[], scaffoldedShipId?: number): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (!s || s.type !== 'shipyard') return;
    s.construction = phase === 'empty' ? undefined : { phase, modulesPlaced, scaffoldedShipId };
  }

  /** Get the construction state of a shipyard by structure id. */
  getShipyardConstruction(id: number): { phase: ConstructionPhase; modulesPlaced: string[] } | null {
    const s = this.placedStructures.find(p => p.id === id && p.type === 'shipyard');
    if (!s || !s.construction) return null;
    return { phase: s.construction.phase, modulesPlaced: [...s.construction.modulesPlaced] };
  }

  /** Set (or clear) the structure that should be highlighted red as a placement blocker. */
  setBlockerStructure(id: number | null, durationMs = 2000): void {
    this._blockerStructureId = id;
    this._blockerExpiry = id !== null ? performance.now() + durationMs : 0;
  }

  /** Activate island placement ghost for wooden_floor, workbench, wall, door, shipyard, or clear it. */
  setIslandBuildItem(kind: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | null): void {
    this.islandBuildKind = kind;
  }

  /** Set the rotation (degrees) for the island floor/workbench ghost. */
  setIslandBuildRotation(deg: number): void {
    this.islandBuildRotationDeg = deg;
  }

  /**
   * SAT OBB-OBB overlap test for two 50×50 floor tiles.
   * Returns true if they share any interior space (touching edges = false).
   */
  private static floorsOverlap(
    ax: number, ay: number, aRad: number,
    bx: number, by: number, bRad: number
  ): boolean {
    const HALF = 25;
    // Small epsilon to absorb floating-point rounding on touching-edge adjacency.
    // Valid adjacent tiles are exactly TILE=50px apart; any genuine overlap is >> 0.01px.
    const EPS = 0.01;
    const cA = Math.cos(aRad), sA = Math.sin(aRad);
    const cB = Math.cos(bRad), sB = Math.sin(bRad);
    const dx = bx - ax, dy = by - ay;
    // 4 SAT axes: local X and Y of each box
    const axes: [number, number][] = [[cA, sA], [-sA, cA], [cB, sB], [-sB, cB]];
    for (const [nx, ny] of axes) {
      const d  = Math.abs(dx * nx + dy * ny);
      const rA = HALF * Math.abs(cA * nx + sA * ny) + HALF * Math.abs(-sA * nx + cA * ny);
      const rB = HALF * Math.abs(cB * nx + sB * ny) + HALF * Math.abs(-sB * nx + cB * ny);
      if (d >= rA + rB - EPS) return false; // separating axis (or touching edge) — no overlap
    }
    return true; // no separating axis — tiles genuinely overlap
  }

  /**
   * Compute the snapped world position for a wooden_floor placement at (wx, wy).
   * If the point is within SNAP_R of an unoccupied cardinal neighbour slot of any
   * existing floor, snaps to that slot. Otherwise returns the input unchanged.
   * Called at click time so it is never stale.
   */
  computeSnappedPos(wx: number, wy: number): { x: number; y: number } {
    const TILE   = 50;
    const SNAP_R = TILE * 0.4; // 20 px — snap pull radius
    if (this.islandBuildKind !== 'wooden_floor' || this.placedStructures.length === 0) {
      this._snappedBuildRotation = null;
      return { x: wx, y: wy };
    }
    let bestDist2 = SNAP_R * SNAP_R;
    let bestX = wx, bestY = wy;
    let bestRot: number | null = null;
    for (const s of this.placedStructures) {
      if (s.type !== 'wooden_floor') continue;
      // Derive the 4 neighbour slots using this tile's own rotation
      const rad = (s.rotation ?? 0) * Math.PI / 180;
      const c = Math.cos(rad), sn = Math.sin(rad);
      const DIRS = [
        {  dx:  TILE * c,  dy:  TILE * sn },
        {  dx: -TILE * c,  dy: -TILE * sn },
        {  dx: -TILE * sn, dy:  TILE * c  },
        {  dx:  TILE * sn, dy: -TILE * c  },
      ];
      for (const d of DIRS) {
        const nx = s.x + d.dx, ny = s.y + d.dy;
        // candidateRad inherits source tile's rotation.
        // Exclude source tile (s) itself — candidate is by construction adjacent/touching it.
        const candidateRad = rad;
        const alreadyOccupied = this.placedStructures.some(
          f => f.type === 'wooden_floor' && f.id !== s.id &&
               RenderSystem.floorsOverlap(nx, ny, candidateRad, f.x, f.y, (f.rotation ?? 0) * Math.PI / 180)
        );
        if (alreadyOccupied) continue;
        const dist2 = (nx - wx) * (nx - wx) + (ny - wy) * (ny - wy);
        if (dist2 < bestDist2) { bestDist2 = dist2; bestX = nx; bestY = ny; bestRot = s.rotation ?? 0; }
      }
    }
    this._snappedBuildRotation = bestRot;
    return { x: bestX, y: bestY };
  }

  /**
   * Compute the snapped world position for a wall placement at (wx, wy).
   * Snaps to the nearest unoccupied edge midpoint of any floor tile.
   */
  computeSnappedWallPos(wx: number, wy: number): { x: number; y: number } {
    const HALF = 25;
    const SNAP_R = 30;
    if (this.placedStructures.length === 0) return { x: wx, y: wy };
    let bestDist2 = SNAP_R * SNAP_R;
    let bestX = wx, bestY = wy;
    for (const s of this.placedStructures) {
      if (s.type !== 'wooden_floor') continue;
      // Rotate the 4 canonical edge-midpoint offsets by this floor's rotation
      const rad = (s.rotation ?? 0) * Math.PI / 180;
      const c = Math.cos(rad), sn = Math.sin(rad);
      // Local-space edges: (0,±HALF) → N/S (horizontal wall), (±HALF,0) → E/W (vertical wall)
      const EDGES = [
        { ldx:  0,    ldy: -HALF }, // N
        { ldx:  0,    ldy:  HALF }, // S
        { ldx: -HALF, ldy:  0    }, // W
        { ldx:  HALF, ldy:  0    }, // E
      ];
      for (const e of EDGES) {
        const nx = s.x + e.ldx * c - e.ldy * sn;
        const ny = s.y + e.ldx * sn + e.ldy * c;
        const occ = this.placedStructures.some(
          w => (w.type === 'wall' || w.type === 'door_frame') && Math.abs(w.x - nx) < 2 && Math.abs(w.y - ny) < 2
        );
        if (occ) continue;
        const dist2 = (nx - wx) * (nx - wx) + (ny - wy) * (ny - wy);
        if (dist2 < bestDist2) { bestDist2 = dist2; bestX = nx; bestY = ny; }
      }
    }
    return { x: bestX, y: bestY };
  }

  /** Snap a door panel to the nearest unoccupied door_frame position. */
  computeSnappedDoorPos(wx: number, wy: number): { x: number; y: number } {
    const SNAP_R = 30;
    if (this.placedStructures.length === 0) return { x: wx, y: wy };
    let bestDist2 = SNAP_R * SNAP_R;
    let bestX = wx, bestY = wy;
    for (const s of this.placedStructures) {
      if (s.type !== 'door_frame') continue;
      const hasDoor = this.placedStructures.some(
        d => d.type === 'door' && Math.abs(d.x - s.x) < 2 && Math.abs(d.y - s.y) < 2
      );
      if (hasDoor) continue;
      const dist2 = (s.x - wx) * (s.x - wx) + (s.y - wy) * (s.y - wy);
      if (dist2 < bestDist2) { bestDist2 = dist2; bestX = s.x; bestY = s.y; }
    }
    return { x: bestX, y: bestY };
  }

  /**
   * Return the nearest workbench within `range` world-px of the local player,
   * or null if none found. Used to decide whether E-key triggers interact.
   */
  getHoveredWorkbench(range: number = 110): PlacedStructure | null {
    const player = this._cachedLocalPlayer;
    if (!player) return null;
    const px = player.position.x;
    const py = player.position.y;
    const rangeSq = range * range;
    let best: PlacedStructure | null = null;
    let bestDist = Infinity;
    for (const s of this.placedStructures) {
      if (s.type !== 'workbench') continue;
      const dx = s.x - px;
      const dy = s.y - py;
      const dist = dx * dx + dy * dy;
      if (dist <= rangeSq && dist < bestDist) {
        bestDist = dist;
        best = s;
      }
    }
    return best;
  }

  /**
   * Return the hovered structure if the player is also within `range` world-px
   * of it (so E-key only fires when actually reachable). Returns null if no
   * structure is moused-over or the player is too far / on a ship.
   */
  getHoveredStructure(range: number = 110): PlacedStructure | null {
    if (!this._hoveredStructure) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const s = this._hoveredStructure;
    if (s.type === 'shipyard') {
      // OBB check: rotate player position into shipyard local frame and test against half-extents
      const rot = (s.rotation ?? 0) * Math.PI / 180;
      const dx = player.position.x - s.x;
      const dy = player.position.y - s.y;
      const c = Math.cos(-rot), sn = Math.sin(-rot);
      const lx = dx * c - dy * sn;
      const ly = dx * sn + dy * c;
      // hw=170, hh=445 are world-unit half-extents; +100 interaction margin
      return Math.abs(lx) <= 270 && Math.abs(ly) <= 545 ? s : null;
    }
    const dx = s.x - player.position.x;
    const dy = s.y - player.position.y;
    return dx * dx + dy * dy <= range * range ? s : null;
  }

  /**
   * Given a world-space click position, find the nearest unplaced module slot
   * on a shipyard construction in building phase.  Returns the shipyard structure
   * and the module id to install, or null if no match.
   * The held item name is used to filter to compatible modules.
   */
  getConstructionModuleSlot(
    worldX: number, worldY: number, heldItem: string, playerX: number, playerY: number,
  ): { shipyard: PlacedStructure; moduleId: string } | null {
    // World-space dimensions of the shipyard (matches rendering constants scaled by base size 50)
    const BASE    = 50;
    const INT_W   = BASE * 4.80;
    const ARM_L   = BASE * 16.80;
    const BACK_T  = BASE * 1.00;
    const ARM_T   = BASE * 1.00;
    const totalH  = BACK_T + ARM_L;
    const bHW     = INT_W * 0.44;      // hull half-beam
    const bLen    = ARM_L * 0.96;       // hull length (top 2% to bottom 2%)
    const bTopOff = -totalH / 2 + BACK_T + ARM_L * 0.02; // bow tip offset from center

    for (const s of this.placedStructures) {
      if (s.type !== 'shipyard' || s.construction?.phase !== 'building') continue;
      const mp = s.construction.modulesPlaced;

      // Player distance check (same generous OBB as getHoveredStructure)
      const rot = (s.rotation ?? 0) * Math.PI / 180;
      const pdx = playerX - s.x, pdy = playerY - s.y;
      const c = Math.cos(-rot), sn = Math.sin(-rot);
      const plx = pdx * c - pdy * sn, ply = pdx * sn + pdy * c;
      if (Math.abs(plx) > 270 || Math.abs(ply) > 545) continue;

      // Transform click into shipyard-local frame (y-axis = bow-to-stern)
      const cdx = worldX - s.x, cdy = worldY - s.y;
      const lx = cdx * c - cdy * sn;
      const ly = cdx * sn + cdy * c;

      // Check if click is inside the construction area
      if (Math.abs(lx) > bHW + 30 || ly < bTopOff - 20 || ly > bTopOff + bLen + 20) continue;

      // Determine best module based on held item and click position
      const relY = (ly - bTopOff) / bLen; // 0=bow, 1=stern

      let bestModule: string | null = null;

      if (heldItem === 'plank') {
        // Planks → hull_left, hull_right, or deck based on click side
        if (lx < -10) {
          // Left / port side
          if (!mp.includes('hull_left')) bestModule = 'hull_left';
          else if (!mp.includes('deck')) bestModule = 'deck';
          else if (!mp.includes('hull_right')) bestModule = 'hull_right';
        } else if (lx > 10) {
          // Right / starboard side
          if (!mp.includes('hull_right')) bestModule = 'hull_right';
          else if (!mp.includes('deck')) bestModule = 'deck';
          else if (!mp.includes('hull_left')) bestModule = 'hull_left';
        } else {
          // Center
          if (!mp.includes('deck')) bestModule = 'deck';
          else if (!mp.includes('hull_left')) bestModule = 'hull_left';
          else if (!mp.includes('hull_right')) bestModule = 'hull_right';
        }
      } else if (heldItem === 'wood') {
        // Wood + fiber → mast
        if (!mp.includes('mast')) bestModule = 'mast';
      } else if (heldItem === 'cannon') {
        // Cannon → port or starboard based on click side
        if (lx <= 0) {
          if (!mp.includes('cannon_port')) bestModule = 'cannon_port';
          else if (!mp.includes('cannon_stbd')) bestModule = 'cannon_stbd';
        } else {
          if (!mp.includes('cannon_stbd')) bestModule = 'cannon_stbd';
          else if (!mp.includes('cannon_port')) bestModule = 'cannon_port';
        }
      }

      if (bestModule) return { shipyard: s, moduleId: bestModule };
    }
    return null;
  }

  /** Return hovered tree world pos if player is in range and off-ship, else null. */
  getHoveredTree(range: number = 110): { wx: number; wy: number } | null {
    if (!this._hoveredTree) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const dx = this._hoveredTree.wx - player.position.x;
    const dy = this._hoveredTree.wy - player.position.y;
    return dx * dx + dy * dy <= range * range ? this._hoveredTree : null;
  }

  /** Return hovered fiber plant world pos if player is in range and off-ship, else null. */
  getHoveredFiberPlant(range: number = 110): { wx: number; wy: number } | null {
    if (!this._hoveredFiberPlant) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const dx = this._hoveredFiberPlant.wx - player.position.x;
    const dy = this._hoveredFiberPlant.wy - player.position.y;
    return dx * dx + dy * dy <= range * range ? this._hoveredFiberPlant : null;
  }

  /** Return hovered rock world pos if player is in range and off-ship, else null. */
  getHoveredRock(range: number = 110): { wx: number; wy: number } | null {
    if (!this._hoveredRock) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const dx = this._hoveredRock.wx - player.position.x;
    const dy = this._hoveredRock.wy - player.position.y;
    return dx * dx + dy * dy <= range * range ? this._hoveredRock : null;
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
  private explicitBuildState: { item: 'cannon' | 'sail' | 'swivel'; rotationDeg: number } | null = null;

  // Ghost placement plan markers and pending ghost cursor
  private ghostPlacements: GhostPlacement[] = [];
  private pendingGhostState: { kind: GhostModuleKind; rotDeg: number } | null = null;
  private buildMenuOpen = false;

  /**
   * Set explicit build mode state for ghost preview rendering.
   * Pass null to disable.
   */
  setExplicitBuildMode(state: { item: 'cannon' | 'sail' | 'swivel'; rotationDeg: number } | null): void {
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
        
        // Hover bounds match rendered size: 20x40 when extended, 20x12 when retracted
        const isLadderExtended = (moduleData as any).extended !== false;
        const halfWidth = 10;
        const halfHeight = isLadderExtended ? 20 : 6;
        
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
        } else if (moduleKind === 'swivel') {
          // Swivel: circular pivot — use diameter for hit-box
          width = 22;
          height = 22;
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
    const isGhostShipForHP = ship.shipType === SHIP_TYPE_GHOST;
    const maxHullHP = isGhostShipForHP ? GHOST_MAX_HULL_HP : 100;
    // Once the sink animation has started, lock hullPct at 0 so the fade can't reverse
    const rawHullPct = Math.max(0, Math.min(1, ship.hullHealth / maxHullHP));
    const hullPct = this.sinkTimestamps.has(ship.id) ? 0 : rawHullPct;
    const waterFill = Math.max(0, Math.min(1, 1 - hullPct));
    const floodTint = waterFill >= 0.75 ? (waterFill - 0.75) / 0.25 : 0;

    // Start the clock for any live ship the moment hullHealth hits 0 (fallback if SHIP_SINKING arrives late)
    const zeroThreshold = ship.shipType === SHIP_TYPE_GHOST ? 1 : 0;
    if (ship.hullHealth <= zeroThreshold && !this.sinkTimestamps.has(ship.id)) {
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

    // Cache local player once for the entire frame — shared by all detect* and draw* methods.
    this._cachedLocalPlayer = this.localPlayerId != null
      ? worldState.players.find(p => p.id === this.localPlayerId) ?? null
      : null;
    this._localCompanyId = this._cachedLocalPlayer?.companyId ?? 0;

    // Detect hovered module
    this.detectHoveredModule(worldState);
    this.detectHoveredNpc(worldState);
    this.detectHoveredShip(worldState);

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
    this.drawIsland(camera); // drawPlacedStructures is called inside, between trunk and leaf passes
    this.drawIslandBuildGhost(camera);
    
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
    // Flamethrower instant cone flashes (on top of particles)
    this.drawFlameCones(camera);
    // Grapeshot / canister hit-scan tracers
    this.drawGrapeshotTracers(camera);
    // Screen-space announcement banners (on top of everything)
    this.effectRenderer.renderAnnouncements(this.canvas);

    // Sword cooldown cursor ring (topmost — always in screen space)
    this.drawSwordCooldownCursor();
    // Ladder hold-progress ring
    this.drawLadderHoldRing();
    // Move To directive arrow line (above world, below UI menus)
    this.drawMoveToArrowLine(worldState, camera);
    // Radial action menu (topmost)
    this._radialMenu?.render(this.ctx);
    // Move To targeting hint banner
    this.drawMoveToHint();
    
    // Draw hover boundaries debug if enabled
    if (this.showHoverBoundaries) {
      this.drawHoverBoundariesDebug(worldState, camera);
    }
    
    // Draw hover tooltip (screen space, on top of everything)
    this.drawHoverTooltip(camera);
    this.drawNpcTooltip(camera);
    this.drawShipHullTooltip(camera);
  }
  
  /**
   * Draws a shrinking arc ring around the mouse cursor while the sword is on cooldown.
   * Full ring = just swung; empty ring = ready.
   */
  private drawSwordCooldownIndicator(camera: Camera): void {
    if (!this.mouseWorldPos) return;
    if (!this.swordEquipped) return;

    const elapsed   = performance.now() - this.lastSwordSwingAt;
    const onCooldown = elapsed < this.swordCooldownMs;
    const progress  = onCooldown ? elapsed / this.swordCooldownMs : 1; // 0→1 as cooldown fills

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const RADIUS    = 12;
    const TRACK_W   = 2.5;
    const START     = -Math.PI / 2; // 12 o'clock

    const ctx = this.ctx;
    ctx.save();

    // Dim background track (always shown)
    ctx.strokeStyle = 'rgba(0,0,0,0.40)';
    ctx.lineWidth   = TRACK_W + 1;
    ctx.lineCap     = 'butt';
    ctx.beginPath();
    ctx.arc(screenPos.x, screenPos.y, RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    if (onCooldown) {
      // Filling arc: draws from empty → full as cooldown completes (red)
      const END = START + progress * Math.PI * 2;
      ctx.strokeStyle = 'rgba(220, 40, 40, 0.9)';
      ctx.lineWidth   = TRACK_W;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, RADIUS, START, END);
      ctx.stroke();
    } else {
      // Ready — full green circle
      ctx.strokeStyle = 'rgba(80, 220, 100, 0.85)';
      ctx.lineWidth   = TRACK_W;
      ctx.lineCap     = 'butt';
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
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

  /** Draw the sword cooldown ring around the mouse cursor (screen space). */
  private drawLadderHoldRing(): void {
    const ctx = this.ctx;
    const R   = 18;
    const now = performance.now();

    ctx.save();

    // ── Hold progress ring ────────────────────────────────────────────────
    if (this.ladderHoldActive && this.ladderHoldMousePos) {
      const cx = this.ladderHoldMousePos.x;
      const cy = this.ladderHoldMousePos.y;
      const HOLD_MS = 300;
      const progress = Math.min((now - this.ladderHoldStartMs) / HOLD_MS, 1);

      // Dark track
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.lineWidth = 3.5;
      ctx.stroke();

      // Amber fill arc, clockwise from top
      if (progress > 0) {
        const startAngle = -Math.PI / 2;
        const endAngle   = startAngle + progress * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, R, startAngle, endAngle);
        ctx.strokeStyle = progress >= 1
          ? 'rgba(255, 220, 80, 1.0)'   // bright gold when complete
          : 'rgba(255, 160, 30, 0.9)';  // amber while filling
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }

    // ── Quick-interact flash ring (expands + fades, green = confirm / red = cancel) ─
    if (this._quickFlashPos && this._quickFlashStartMs !== -1) {
      const FLASH_MS  = 380;
      const isCancel  = this._quickFlashStartMs < 0;
      const startMs   = isCancel ? -this._quickFlashStartMs : this._quickFlashStartMs;
      const fp = (now - startMs) / FLASH_MS;
      if (fp >= 0 && fp < 1) {
        const alpha = (1 - fp) * 0.9;
        const fr    = R + fp * 10;
        ctx.beginPath();
        ctx.arc(this._quickFlashPos.x, this._quickFlashPos.y, fr, 0, Math.PI * 2);
        ctx.strokeStyle = isCancel
          ? `rgba(220, 70, 60, ${alpha.toFixed(3)})`
          : `rgba(80, 220, 100, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 3;
        ctx.lineCap   = 'butt';
        ctx.stroke();
      } else if (fp >= 1) {
        this._quickFlashPos     = null;
        this._quickFlashStartMs = -1;
      }
    }

    ctx.restore();
  }

  private drawSwordCooldownCursor(): void {
    if (!this.swordCursorMousePos) return;

    const ctx  = this.ctx;
    const cx   = this.swordCursorMousePos.x;
    const cy   = this.swordCursorMousePos.y;
    const R    = 14; // ring radius (px)
    const now  = performance.now();
    const elapsed = now - this.swordCursorLastAttackMs;
    const progress = Math.min(elapsed / this.swordCursorCooldownMs, 1); // 0→1

    ctx.save();

    // Background track
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 3;
    ctx.stroke();

    if (progress >= 1) {
      // Ready: full bright ring
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(200, 220, 255, 0.9)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      // Filling clockwise from top (−π/2) proportional to progress
      const startAngle = -Math.PI / 2;
      const endAngle   = startAngle + progress * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, R, startAngle, endAngle);
      ctx.strokeStyle = 'rgba(140, 180, 255, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.restore();
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

  // ── Island rendering ─────────────────────────────────────────────────────────

  /** Trace an irregular closed blob path using per-point radius bumps. */
  private traceIslandBlob(
    camera: Camera,
    worldCx: number, worldCy: number,
    radius: number, bumps: number[],
    segments = 64,
  ): void {
    const ctx  = this.ctx;
    const n    = bumps.length;
    const TWO_PI = Math.PI * 2;
    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * TWO_PI;   // 0→2π, matching server island_boundary_r
      const t     = (angle / TWO_PI) * n;
      const i0    = Math.floor(t) % n;
      const i1    = (i0 + 1) % n;
      const f     = t - Math.floor(t);
      const r     = radius + bumps[i0] + f * (bumps[i1] - bumps[i0]);
      const sp    = camera.worldToScreen(Vec2.from(
        worldCx + Math.cos(angle) * r,
        worldCy + Math.sin(angle) * r,
      ));
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else         ctx.lineTo(sp.x, sp.y);
    }
    ctx.closePath();
  }

  /** Trace a closed polygon path in screen space from an array of world-space vertices. */
  private traceIslandPolygon(
    camera: Camera,
    vertices: { x: number; y: number }[],
  ): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < vertices.length; i++) {
      const sp = camera.worldToScreen(Vec2.from(vertices[i].x, vertices[i].y));
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else         ctx.lineTo(sp.x, sp.y);
    }
    ctx.closePath();
  }

  private drawIsland(camera: Camera): void {
    const zoom = camera.getState().zoom;
    // Reset per-frame hovered resource nodes
    this._hoveredTree       = null;
    this._hoveredFiberPlant = null;
    this._hoveredRock       = null;

    // Hoist frame-constants so they're available both inside the per-island loop
    // and in the post-loop passes 4+5 that execute after structures are drawn.
    const localPlayer = this._cachedLocalPlayer;
    const axeEquipped = (() => {
      if (!localPlayer || localPlayer.carrierId !== 0) return false;
      const slot = localPlayer.inventory?.activeSlot ?? 0;
      return localPlayer.inventory?.slots[slot]?.item === 'axe';
    })();
    const pickaxeEquipped = (() => {
      if (!localPlayer || localPlayer.carrierId !== 0) return false;
      const slot = localPlayer.inventory?.activeSlot ?? 0;
      return localPlayer.inventory?.slots[slot]?.item === 'pickaxe';
    })();
    const HARVEST_RANGE_SQ = 110 * 110;
    const PLANT_HOVER_SQ = (14 * zoom) * (14 * zoom);
    const ROCK_HOVER_SQ  = (12 * zoom) * (12 * zoom);
    const LEAF_FADE_OUTER = 420;
    const LEAF_FADE_INNER = 120;
    const MIN_LEAF_ALPHA  = 0.12;
    const DEATH_FADE_MS   = 2000; // ms — how long a depleted resource fades out
    const now = performance.now();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const msp = this.mouseWorldPos ? camera.worldToScreen(this.mouseWorldPos) : null;
    // Collects visible resources from all islands; leaves+prompts drawn after structures.
    const allVisibleRes: Array<{
      res: { ox: number; oy: number; type: string; size: number; hp: number; maxHp: number; depletedAt?: number };
      wx: number; wy: number;
      sp: ReturnType<typeof camera.worldToScreen>;
      isHovered: boolean; inRange: boolean; playerNear: boolean; leafAlpha: number; deathAlpha: number;
    }> = [];

    for (const isl of this.islands) {
      const preset = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
      // Visibility check: adapt radius to polygon bound or bump-circle
      const visR = isl.vertices
        ? Math.max(...isl.vertices.map(v => Math.hypot(v.x - isl.x, v.y - isl.y))) + 50
        : (preset.beachRadius + Math.max(0, ...preset.beachBumps.map(Math.abs)) + 20);
      if (!camera.isWorldPositionVisible(Vec2.from(isl.x, isl.y), visR)) continue;
      const sc  = camera.worldToScreen(Vec2.from(isl.x, isl.y));
      const ctx = this.ctx;

      // ── Shallow water ring (drawn before island body) ────────────────────
      {
        // ── Shallow water ring — follows the island's actual shape ────────────
        // Depth scales with island radius (SHALLOW_WATER_SCALE, matches server).
        // Uses even-odd fill: outer expanded shape minus inner beach shape = ring.
        const SHALLOW_SCALE = 0.375; // must match server SHALLOW_WATER_SCALE
        const SEG = 64;
        const TWO_PI = Math.PI * 2;
        ctx.save();
        if (isl.vertices) {
          const verts = isl.vertices;
          const polyBoundR = Math.max(...verts.map(v => Math.hypot(v.x - isl.x, v.y - isl.y)));
          const polyMinR   = Math.min(...verts.map(v => Math.hypot(v.x - isl.x, v.y - isl.y)));
          const SHALLOW_DEPTH = polyBoundR * SHALLOW_SCALE;
          // Outer subpath: expand each vertex outward by SHALLOW_DEPTH
          const expanded = verts.map(v => {
            const dx = v.x - isl.x, dy = v.y - isl.y;
            const d  = Math.hypot(dx, dy);
            const scale = d > 0 ? (d + SHALLOW_DEPTH) / d : 1;
            return camera.worldToScreen(Vec2.from(isl.x + dx * scale, isl.y + dy * scale));
          });
          ctx.beginPath();
          expanded.forEach((sp, i) => i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y));
          ctx.closePath();
          // Inner subpath: original polygon boundary (cut out via even-odd)
          verts.forEach((v, i) => {
            const sp = camera.worldToScreen(Vec2.from(v.x, v.y));
            i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
          });
          ctx.closePath();
          const sg = ctx.createRadialGradient(sc.x, sc.y, polyMinR * zoom * 0.85, sc.x, sc.y, (polyBoundR + SHALLOW_DEPTH) * zoom);
          sg.addColorStop(0.0,  'rgba(220, 195, 130, 0.95)');
          sg.addColorStop(0.30, 'rgba(130, 210, 200, 0.75)');
          sg.addColorStop(0.65, 'rgba(70, 185, 215, 0.35)');
          sg.addColorStop(1.0,  'rgba(60, 170, 205, 0.0)');
          ctx.fillStyle = sg;
          ctx.fill('evenodd');
        } else {
          const SHALLOW_DEPTH = preset.beachRadius * SHALLOW_SCALE;
          const n    = preset.beachBumps.length;
          const outerBase = preset.beachRadius + SHALLOW_DEPTH;
          // Outer subpath: expanded blob (beachRadius + SHALLOW_DEPTH + same bumps)
          ctx.beginPath();
          for (let i = 0; i <= SEG; i++) {
            const angle = (i / SEG) * TWO_PI;
            const t  = (angle / TWO_PI) * n;
            const i0 = Math.floor(t) % n, i1 = (i0 + 1) % n;
            const r  = outerBase + preset.beachBumps[i0] + (t - Math.floor(t)) * (preset.beachBumps[i1] - preset.beachBumps[i0]);
            const sp = camera.worldToScreen(Vec2.from(isl.x + Math.cos(angle) * r, isl.y + Math.sin(angle) * r));
            i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
          }
          ctx.closePath();
          // Inner subpath: beach boundary (cuts out island via even-odd)
          for (let i = 0; i <= SEG; i++) {
            const angle = (i / SEG) * TWO_PI;
            const t  = (angle / TWO_PI) * n;
            const i0 = Math.floor(t) % n, i1 = (i0 + 1) % n;
            const r  = preset.beachRadius + preset.beachBumps[i0] + (t - Math.floor(t)) * (preset.beachBumps[i1] - preset.beachBumps[i0]);
            const sp = camera.worldToScreen(Vec2.from(isl.x + Math.cos(angle) * r, isl.y + Math.sin(angle) * r));
            i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
          }
          ctx.closePath();
          const maxBump = Math.max(0, ...preset.beachBumps.map(Math.abs));
          const sg = ctx.createRadialGradient(sc.x, sc.y, (preset.beachRadius - maxBump) * zoom, sc.x, sc.y, (outerBase + maxBump) * zoom);
          sg.addColorStop(0.0,  'rgba(220, 195, 130, 0.95)');
          sg.addColorStop(0.30, 'rgba(130, 210, 200, 0.75)');
          sg.addColorStop(0.65, 'rgba(70, 185, 215, 0.35)');
          sg.addColorStop(1.0,  'rgba(60, 170, 205, 0.0)');
          ctx.fillStyle = sg;
          ctx.fill('evenodd');
        }
        ctx.restore();
      }

      ctx.save();

      if (isl.vertices) {
        // ── Polygon island ─────────────────────────────────────────────────────
        const polyBoundR = Math.max(...isl.vertices.map(v => Math.hypot(v.x - isl.x, v.y - isl.y)));

        // Beach
        this.traceIslandPolygon(camera, isl.vertices);
        const beachGrad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, polyBoundR * zoom * 1.05);
        beachGrad.addColorStop(0.0,  preset.beachColors[0]);
        beachGrad.addColorStop(0.65, preset.beachColors[1]);
        beachGrad.addColorStop(1.0,  preset.beachColors[2]);
        ctx.fillStyle = beachGrad;
        ctx.fill();
        ctx.strokeStyle = preset.borderColor;
        ctx.lineWidth   = Math.max(1, 2 * zoom);
        ctx.stroke();

        // Grass interior (polygon scaled toward island centre)
        const gScale = preset.grassPolyScale ?? 0.78;
        const grassVerts = isl.vertices.map(v => ({
          x: isl.x + (v.x - isl.x) * gScale,
          y: isl.y + (v.y - isl.y) * gScale,
        }));
        this.traceIslandPolygon(camera, grassVerts);
        const grassBoundR = polyBoundR * gScale;
        const grassGrad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, grassBoundR * zoom);
        grassGrad.addColorStop(0.0, preset.grassColors[0]);
        grassGrad.addColorStop(0.7, preset.grassColors[1]);
        grassGrad.addColorStop(1.0, preset.grassColors[2]);
        ctx.fillStyle = grassGrad;
        ctx.fill();
      } else {
        // ── Bump-circle island ────────────────────────────────────────────────
        // Sandy beach
        this.traceIslandBlob(camera, isl.x, isl.y, preset.beachRadius, preset.beachBumps);
        const beachGrad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, preset.beachRadius * zoom * 1.1);
        beachGrad.addColorStop(0.0,  preset.beachColors[0]);
        beachGrad.addColorStop(0.65, preset.beachColors[1]);
        beachGrad.addColorStop(1.0,  preset.beachColors[2]);
        ctx.fillStyle = beachGrad;
        ctx.fill();
        ctx.strokeStyle = preset.borderColor;
        ctx.lineWidth   = Math.max(1, 2 * zoom);
        ctx.stroke();

        // Grass interior
        this.traceIslandBlob(camera, isl.x, isl.y, preset.grassRadius, preset.grassBumps);
        const grassGrad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, preset.grassRadius * zoom);
        grassGrad.addColorStop(0.0, preset.grassColors[0]);
        grassGrad.addColorStop(0.7, preset.grassColors[1]);
        grassGrad.addColorStop(1.0, preset.grassColors[2]);
        ctx.fillStyle = grassGrad;
        ctx.fill();
      }

      ctx.restore();

      // ── Resource nodes — Passes 1-3 (drawn below structures) ────────────────
      const visibleRes: Array<{
        res: typeof isl.resources[0];
        wx: number; wy: number;
        sp: ReturnType<typeof camera.worldToScreen>;
        isHovered: boolean; inRange: boolean; playerNear: boolean; leafAlpha: number; deathAlpha: number;
      }> = [];

      for (const res of isl.resources) {
        // Depleted resources fade out over DEATH_FADE_MS, then disappear entirely.
        // During the fade they cannot be hovered or interacted with.
        let deathAlpha = 1.0;
        if (res.maxHp > 0 && res.hp <= 0) {
          if (!res.depletedAt) continue; // no timestamp yet — skip (shouldn't happen)
          const elapsed = now - res.depletedAt;
          if (elapsed >= DEATH_FADE_MS) continue; // fully faded, skip
          deathAlpha = 1.0 - elapsed / DEATH_FADE_MS; // 1 → 0 over DEATH_FADE_MS
          const wx2 = isl.x + res.ox, wy2 = isl.y + res.oy;
          const sp2 = camera.worldToScreen(Vec2.from(wx2, wy2));
          const maxR2 = 100 * zoom;
          if (sp2.x + maxR2 < 0 || sp2.x - maxR2 > cw || sp2.y + maxR2 < 0 || sp2.y - maxR2 > ch) continue;
          // No hover, no interaction while dying
          visibleRes.push({ res, wx: wx2, wy: wy2, sp: sp2, isHovered: false, inRange: false, playerNear: false, leafAlpha: 1.0, deathAlpha });
          continue;
        }
        const wx = isl.x + res.ox;
        const wy = isl.y + res.oy;
        const sp = camera.worldToScreen(Vec2.from(wx, wy));
        const maxR = 100 * zoom;
        if (sp.x + maxR < 0 || sp.x - maxR > cw || sp.y + maxR < 0 || sp.y - maxR > ch) continue;
        if (maxR < 1) continue;

        let isHovered = false;
        let inRange   = false;
        let playerNear = false;

        if (res.type === 'wood') {
          const treeHoverR = 18 * (res.size ?? 1.0) * zoom;
          if (msp) { const hdx = msp.x - sp.x, hdy = msp.y - sp.y; isHovered = hdx*hdx + hdy*hdy <= treeHoverR * treeHoverR; }
          const pdx = localPlayer ? localPlayer.position.x - wx : Infinity;
          const pdy = localPlayer ? localPlayer.position.y - wy : Infinity;
          const pdSq = pdx * pdx + pdy * pdy;
          const dist = Math.sqrt(pdSq);
          inRange    = !!(axeEquipped && localPlayer && pdSq <= HARVEST_RANGE_SQ);
          playerNear = !!(localPlayer && dist < LEAF_FADE_OUTER);
          if (isHovered) this._hoveredTree = { wx, wy };
        } else if (res.type === 'fiber') {
          if (msp) { const hdx = msp.x - sp.x, hdy = msp.y - sp.y; isHovered = hdx*hdx + hdy*hdy <= PLANT_HOVER_SQ; }
          inRange = localPlayer && localPlayer.carrierId === 0
            ? (() => { const dx = localPlayer!.position.x - wx; const dy = localPlayer!.position.y - wy; return dx*dx+dy*dy <= HARVEST_RANGE_SQ; })()
            : false;
          if (isHovered) this._hoveredFiberPlant = { wx, wy };
        } else if (res.type === 'rock') {
          if (msp) { const hdx = msp.x - sp.x, hdy = msp.y - sp.y; isHovered = hdx*hdx + hdy*hdy <= ROCK_HOVER_SQ; }
          inRange = pickaxeEquipped && localPlayer
            ? (() => { const dx = localPlayer!.position.x - wx; const dy = localPlayer!.position.y - wy; return dx*dx+dy*dy <= HARVEST_RANGE_SQ; })()
            : false;
          if (isHovered) this._hoveredRock = { wx, wy };
        }
        // Smooth leaf-fade alpha: 1.0 (far) → MIN_LEAF_ALPHA (inside LEAF_FADE_INNER)
        const leafAlpha = res.type === 'wood' && localPlayer
          ? (() => {
              const dist = Math.sqrt((localPlayer.position.x - wx) ** 2 + (localPlayer.position.y - wy) ** 2);
              const t = Math.max(0, Math.min(1, (dist - LEAF_FADE_INNER) / (LEAF_FADE_OUTER - LEAF_FADE_INNER)));
              return MIN_LEAF_ALPHA + t * (1.0 - MIN_LEAF_ALPHA);
            })()
          : 1.0;
        visibleRes.push({ res, wx, wy, sp, isHovered, inRange, playerNear, leafAlpha, deathAlpha });
      }

      // Pass 1 – fiber plants (back-most layer)
      for (const e of visibleRes) {
        if (e.res.type !== 'fiber') continue;
        this.drawIslandFiberPlant(e.sp.x, e.sp.y, zoom, e.isHovered, e.deathAlpha);
      }
      // Pass 2 – rocks
      for (const e of visibleRes) {
        if (e.res.type !== 'rock') continue;
        this.drawIslandRock(e.sp.x, e.sp.y, zoom, e.isHovered, e.deathAlpha);
      }
      // Pass 3 – tree trunks
      for (const e of visibleRes) {
        if (e.res.type !== 'wood') continue;
        this.drawIslandTreeTrunk(e.sp.x, e.sp.y, zoom, e.isHovered, e.inRange, e.playerNear, e.res.size ?? 1.0, e.deathAlpha);
      }

      // Defer leaves + prompts until ALL trunks (across all islands) are done,
      // so that structures can slot in between the two layers.
      for (const e of visibleRes) allVisibleRes.push(e);
    }

    // ── Structures: above trunks, below leaves ────────────────────────────────
    this.drawPlacedStructures(camera);

    // ── Pass 4 – tree leaves (all islands, above structures) ──────────────────
    for (const e of allVisibleRes) {
      if (e.res.type !== 'wood') continue;
      this.drawIslandTreeLeaves(e.sp.x, e.sp.y, zoom, e.isHovered, e.inRange, e.leafAlpha, e.res.ox, e.res.oy, e.res.size ?? 1.0, e.deathAlpha);
    }
    // ── Pass 5 – hover prompts + health bars (always on top) ─────────────────
    for (const e of allVisibleRes) {
      if (e.res.type === 'wood' && e.isHovered) {
        if (axeEquipped) this.drawHarvestPrompt(e.sp.x, e.sp.y, zoom, e.inRange);
        else             this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, false, '(need axe)');
        if ((e.res.maxHp ?? 0) > 0) this.drawResourceHealthBar(e.sp.x, e.sp.y, zoom, e.res.hp ?? e.res.maxHp, e.res.maxHp ?? 1, (e.res.size ?? 1.0) * 40);
      } else if (e.res.type === 'fiber' && e.isHovered) {
        this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, e.inRange, '[E] Gather Fiber');
        if ((e.res.maxHp ?? 0) > 0) this.drawResourceHealthBar(e.sp.x, e.sp.y, zoom, e.res.hp ?? e.res.maxHp, e.res.maxHp ?? 1, 30);
      } else if (e.res.type === 'rock' && e.isHovered) {
        if (pickaxeEquipped) this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, e.inRange, '[E] Mine Rock');
        else                 this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, false, '(need pickaxe)');
        if ((e.res.maxHp ?? 0) > 0) this.drawResourceHealthBar(e.sp.x, e.sp.y, zoom, e.res.hp ?? e.res.maxHp, e.res.maxHp ?? 1, 28);
      }
    }
  }

  /** Draw a floating "Too far" or "[E] Chop" prompt above a tree. */
  private drawHarvestPrompt(sx: number, sy: number, zoom: number, inRange: boolean): void {
    const ctx = this.ctx;
    const canopy    = 17 * zoom;
    const label     = inRange ? '[E] Chop' : 'Too far';
    const borderCol = inRange ? '#f0c040' : '#888888';
    const textCol   = inRange ? '#f0c040' : '#aaaaaa';
    const fontSize  = Math.max(10, Math.round(13 * zoom));
    ctx.save();
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    const textW = ctx.measureText(label).width;
    const padX  = 5;
    const padY  = 3;
    const bx    = sx - textW / 2 - padX;
    const by    = sy - canopy * 1.65 - fontSize - padY;
    const bw    = textW + padX * 2;
    const bh    = fontSize + padY * 2;
    // Pulsing alpha only when in range
    const pulse = inRange ? (0.75 + 0.25 * Math.sin(performance.now() / 350)) : 0.55;
    ctx.globalAlpha = pulse;
    ctx.fillStyle   = 'rgba(0,0,0,0.75)';
    ctx.strokeStyle = borderCol;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = textCol;
    ctx.fillText(label, sx, sy - canopy * 1.65);
    ctx.restore();
  }

  /** Draw a health bar below the resource prompt. barW is in world-units (scaled by zoom). */
  private drawResourceHealthBar(sx: number, sy: number, zoom: number, hp: number, maxHp: number, barW: number): void {
    if (maxHp <= 0) return;
    const ctx  = this.ctx;
    const pct  = Math.max(0, Math.min(1, hp / maxHp));
    const bw   = barW * zoom;
    const bh   = 5  * zoom;
    const by   = sy + 14 * zoom; // just below the resource centre
    ctx.save();
    ctx.globalAlpha = 0.88;
    // Background track
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.beginPath();
    ctx.roundRect(sx - bw / 2, by, bw, bh, 2);
    ctx.fill();
    // Coloured fill
    ctx.fillStyle = pct > 0.6 ? '#4cdd44' : pct > 0.3 ? '#ddcc22' : '#dd3322';
    if (pct > 0) {
      ctx.beginPath();
      ctx.roundRect(sx - bw / 2, by, bw * pct, bh, 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawIslandTreeLeaves(sx: number, sy: number, zoom: number, hovered = false, inRange = false, leafAlpha = 1.0, seedX = 0, seedY = 0, size = 1.0, deathAlpha = 1.0): void {
    const ctx = this.ctx;
    const h  = (Math.imul(seedX | 0, 2654435761) ^ Math.imul(seedY | 0, 1664525)) >>> 0;
    const h2 = (Math.imul(h, 2246822519) ^ Math.imul(h >>> 13, 2654435761)) >>> 0;
    // size comes from server hash (range 0.5–1.8); only use local hash for rotation/tint
    const clusterRot  = (((h2 & 0xFF) / 255) - 0.5) * (Math.PI / 3.6);
    const tintIdx = (h >>> 16) & 3;
    const TINTS: [string, string, string, string][] = [
      ['#1a3a0a', '#3a7320', '#52a030', '#6ecf42'],
      ['#1c3e08', '#3f7a18', '#5aae2e', '#74d93e'],
      ['#152f08', '#2e6318', '#456e22', '#5a9030'],
      ['#233a10', '#4a7c28', '#5fa035', '#72b845'],
    ];
    const [shadowCol, baseCol, hlCol, glintCol] = TINTS[tintIdx];
    const canopy = 72 * zoom * size;
    const rot = (dx: number, dy: number): [number, number] => {
      const c = Math.cos(clusterRot), s = Math.sin(clusterRot);
      return [dx * c - dy * s, dx * s + dy * c];
    };
    const BASE_L: [number, number, number][] = [
      [  0.00, -0.22,  0.80 ],
      [ -0.44,  0.00,  0.62 ],
      [  0.46,  0.05,  0.58 ],
      [ -0.20,  0.40,  0.50 ],
      [  0.25,  0.38,  0.48 ],
    ];
    const L = BASE_L.map(([dx, dy, r]) => { const [rx, ry] = rot(dx, dy); return [rx, ry, r] as [number, number, number]; });

    ctx.save();
    // Hover glow behind canopy
    if (hovered) {
      const glowColor = inRange ? 'rgba(255,230,80,0.22)' : 'rgba(180,180,180,0.15)';
      const glowR     = inRange ? canopy * 1.25 : canopy * 1.15;
      ctx.beginPath();
      ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.fill();
    }
    // Canopy — fades when player is underneath (leafAlpha) AND when tree is dying (deathAlpha)
    ctx.globalAlpha = leafAlpha * deathAlpha;
    // Pass 1: deep shadow
    ctx.fillStyle = shadowCol;
    for (const [dx, dy, r] of L) {
      ctx.beginPath();
      ctx.arc(sx + (dx + 0.13) * canopy, sy + (dy + 0.11) * canopy, r * canopy, 0, Math.PI * 2);
      ctx.fill();
    }
    // Pass 2: base colour
    ctx.fillStyle = baseCol;
    for (const [dx, dy, r] of L) {
      ctx.beginPath();
      ctx.arc(sx + dx * canopy, sy + dy * canopy, r * canopy, 0, Math.PI * 2);
      ctx.fill();
    }
    // Pass 3: highlight — top 3 lobes
    ctx.fillStyle = hlCol;
    for (const [dx, dy, r] of L.slice(0, 3)) {
      ctx.beginPath();
      ctx.arc(sx + (dx - 0.10) * canopy, sy + (dy - 0.15) * canopy, r * canopy * 0.62, 0, Math.PI * 2);
      ctx.fill();
    }
    // Pass 4: specular glint
    const [apexRx, apexRy] = rot(-0.09, -0.34);
    ctx.fillStyle = glintCol;
    ctx.beginPath();
    ctx.arc(sx + apexRx * canopy, sy + apexRy * canopy, canopy * 0.25, 0, Math.PI * 2);
    ctx.fill();
    // Canopy hover ring
    ctx.globalAlpha = deathAlpha;
    if (hovered) {
      ctx.beginPath();
      ctx.arc(sx, sy, canopy * 1.08, 0, Math.PI * 2);
      ctx.strokeStyle = inRange ? '#f0c040' : '#888888';
      ctx.lineWidth   = 1.8 * zoom;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawIslandTreeTrunk(sx: number, sy: number, zoom: number, hovered = false, inRange = false, playerNear = false, size = 1.0, deathAlpha = 1.0): void {
    const ctx   = this.ctx;
    const trunk = 18 * zoom * size;
    ctx.save();
    ctx.globalAlpha = deathAlpha;
    // Shadow circle (offset SE)
    ctx.fillStyle = '#2e1a0a';
    ctx.beginPath();
    ctx.arc(sx + trunk * 0.22, sy + trunk * 0.22, trunk, 0, Math.PI * 2);
    ctx.fill();
    // Body circle — matches server TREE_TRUNK_R_PX exactly
    ctx.fillStyle = '#7a4820';
    ctx.beginPath();
    ctx.arc(sx, sy, trunk, 0, Math.PI * 2);
    ctx.fill();
    // Highlight crescent (small circle offset NW)
    ctx.fillStyle = '#a0642e';
    ctx.beginPath();
    ctx.arc(sx - trunk * 0.28, sy - trunk * 0.22, trunk * 0.45, 0, Math.PI * 2);
    ctx.fill();
    // Hover ring when player is near
    if (playerNear && hovered) {
      ctx.strokeStyle = inRange ? '#f0c040' : '#cccccc';
      ctx.lineWidth   = 1.5 * zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, trunk + 2 * zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawIslandFiberPlant(sx: number, sy: number, zoom: number, hovered = false, deathAlpha = 1.0): void {
    const ctx        = this.ctx;
    const h          = 15 * zoom;
    const bladeCount = 6;

    ctx.save();
    ctx.globalAlpha = deathAlpha;
    ctx.lineCap = 'round';
    // Dark base blades
    ctx.strokeStyle = hovered ? '#7ac040' : '#5a9030';
    ctx.lineWidth   = Math.max(1, 2.2 * zoom);
    for (let i = 0; i < bladeCount; i++) {
      const angle  = -Math.PI / 2 + ((i / (bladeCount - 1)) - 0.5) * Math.PI * 0.95;
      const bend   = Math.sin(i * 1.8) * 0.3;
      const midX   = sx + Math.cos(angle + bend * 0.5) * h * 0.5;
      const midY   = sy + Math.sin(angle + bend * 0.5) * h * 0.5;
      const tipX   = sx + Math.cos(angle + bend) * h;
      const tipY   = sy + Math.sin(angle + bend) * h;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(midX, midY, tipX, tipY);
      ctx.stroke();
    }
    // Bright inner blades
    ctx.strokeStyle = hovered ? '#b0ff60' : '#8acc48';
    ctx.lineWidth   = Math.max(0.5, 1.2 * zoom);
    for (let i = 1; i < bladeCount - 1; i++) {
      const angle = -Math.PI / 2 + ((i / (bladeCount - 1)) - 0.5) * Math.PI * 0.6;
      ctx.beginPath();
      ctx.moveTo(sx, sy - h * 0.25);
      ctx.lineTo(sx + Math.cos(angle) * h * 0.72, sy + Math.sin(angle) * h * 0.72);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawIslandRock(sx: number, sy: number, zoom: number, hovered = false, deathAlpha = 1.0): void {
    const ctx = this.ctx;
    const r   = 12 * zoom;
    ctx.save();
    ctx.globalAlpha = deathAlpha;
    // Main rock body
    ctx.beginPath();
    ctx.ellipse(sx, sy + r * 0.15, r, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fillStyle   = hovered ? '#b0b0b4' : '#888890';
    ctx.strokeStyle = hovered ? '#ffe090' : '#555560';
    ctx.lineWidth   = hovered ? 2.5 * zoom : 1.5 * zoom;
    ctx.fill();
    ctx.stroke();
    // Highlight fleck
    ctx.beginPath();
    ctx.ellipse(sx - r * 0.25, sy - r * 0.15, r * 0.28, r * 0.18, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
    // Crack lines
    ctx.strokeStyle = hovered ? '#888890' : '#666670';
    ctx.lineWidth   = zoom;
    ctx.beginPath();
    ctx.moveTo(sx - r * 0.1, sy - r * 0.2);
    ctx.lineTo(sx + r * 0.25, sy + r * 0.3);
    ctx.stroke();
    ctx.restore();
  }

  /** Draw a floating "[E] action" or "Too far" prompt above a resource node. */
  private drawGatherPrompt(sx: number, sy: number, zoom: number, inRange: boolean, actionLabel: string): void {
    const ctx = this.ctx;
    const offsetY  = 16 * zoom;
    const label     = inRange ? actionLabel : actionLabel.startsWith('(') ? actionLabel : 'Too far';
    const borderCol = inRange ? '#a0ff60' : '#888888';
    const textCol   = inRange ? '#c0ff80' : '#aaaaaa';
    const fontSize  = Math.max(10, Math.round(12 * zoom));
    ctx.save();
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    const textW = ctx.measureText(label).width;
    const padX = 5, padY = 3;
    const bx = sx - textW / 2 - padX;
    const by = sy - offsetY - fontSize - padY;
    const bw = textW + padX * 2;
    const bh = fontSize + padY * 2;
    const pulse = inRange ? (0.75 + 0.25 * Math.sin(performance.now() / 350)) : 0.55;
    ctx.globalAlpha = pulse;
    ctx.fillStyle   = 'rgba(0,0,0,0.75)';
    ctx.strokeStyle = borderCol;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = textCol;
    ctx.fillText(label, sx, sy - offsetY);
    ctx.restore();
  }
  private drawPlacedStructures(camera: Camera): void {
    const ctx  = this.ctx;
    const zoom = camera.getState().zoom;

    // ── Update hovered structure ──────────────────────────────────────────────
    // Highlight whichever structure the mouse cursor is over (AABB for floor,
    // landscape rect for workbench).  Interaction hints additionally require
    // the player to be off-ship and within range.
    const player = this._cachedLocalPlayer;
    const INTERACT_R = 110; // world px — must match getHoveredStructure range
    this._hoveredStructure = null;
    if (this.mouseWorldPos && !this.islandBuildKind) {
      const mx = this.mouseWorldPos.x;
      const my = this.mouseWorldPos.y;
      const half = 25; // half of 50px tile
      let floorHit: PlacedStructure | null = null;
      for (const s of this.placedStructures) {
        if (s.type === 'wall' || s.type === 'door_frame' || s.type === 'door') {
          // Derive wall orientation from nearest floor tile, then rotate mouse into local space
          let nearFloor: PlacedStructure | null = null;
          let nearDist2 = Infinity;
          for (const f of this.placedStructures) {
            if (f.type !== 'wooden_floor') continue;
            const d2 = (f.x - s.x) * (f.x - s.x) + (f.y - s.y) * (f.y - s.y);
            if (d2 < nearDist2) { nearDist2 = d2; nearFloor = f; }
          }
          const wRad = nearFloor
            ? Math.atan2(s.y - nearFloor.y, s.x - nearFloor.x) + Math.PI / 2
            : 0;
          const wc = Math.cos(-wRad), ws = Math.sin(-wRad);
          const ddx = mx - s.x, ddy = my - s.y;
          const lx = ddx * wc - ddy * ws;
          const ly = ddx * ws + ddy * wc;
          if (Math.abs(lx) <= 25 && Math.abs(ly) <= 8) {
            floorHit = s; // walls/door frames/panels treated like floors — workbench still wins
          }
          continue;
        }
        // Rotate mouse into this structure's local space to handle rotation
        const rot = (s.rotation ?? 0) * Math.PI / 180;
        let lx: number, ly: number;
        if (rot === 0) {
          lx = mx - s.x; ly = my - s.y;
        } else {
          const c = Math.cos(-rot), sn = Math.sin(-rot);
          const dx = mx - s.x, dy = my - s.y;
          lx = dx * c - dy * sn;
          ly = dx * sn + dy * c;
        }
        const hw = s.type === 'workbench' ? 25 * 0.88 : s.type === 'shipyard' ? 170 : half;
        const hh = s.type === 'workbench' ? 25 * 0.62 : s.type === 'shipyard' ? 445 : half;
        if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) {
          if (s.type === 'workbench' || s.type === 'shipyard') {
            // Workbench/shipyard always wins — stop searching
            this._hoveredStructure = s;
            floorHit = null;
            break;
          } else {
            // Floor match — keep looking in case a workbench overlaps
            floorHit = s;
          }
        }
      }
      if (this._hoveredStructure === null) this._hoveredStructure = floorHit;
    }

    // Floors first, then walls/doors, then workbenches/shipyards
    const sorted = [...this.placedStructures].sort((a, b) => {
      const order = (t: PlacedStructure['type']) =>
        t === 'wooden_floor' ? 0 : (t === 'wall' || t === 'door_frame') ? 1 : t === 'door' ? 1.5 : t === 'shipyard' ? 1.8 : 2;
      return order(a.type) - order(b.type);
    });

    for (const s of sorted) {
      const ssp = camera.worldToScreen(Vec2.from(s.x, s.y));
      const sz  = Math.max(4, 50 * zoom);
      // Cull structures that are entirely off-screen
      if (ssp.x + sz < 0 || ssp.x - sz > this.canvas.width ||
          ssp.y + sz < 0 || ssp.y - sz > this.canvas.height) continue;
      const isHovered  = this._hoveredStructure?.id === s.id;
      const isBlocker  = this._blockerStructureId === s.id && performance.now() < this._blockerExpiry;

      if (s.type === 'wooden_floor') {
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        // Darken the fill as hp drops (up to 50% darker at 0 hp)
        const dmgDarken = (1 - hpFrac) * 0.5;
        const baseColor = isBlocker ? '#cc3322' : isHovered ? '#d09a3a' : '#b8832b';
        ctx.save();
        if (s.rotation) {
          ctx.translate(ssp.x, ssp.y);
          ctx.rotate(s.rotation * Math.PI / 180);
          ctx.translate(-ssp.x, -ssp.y);
        }
        ctx.fillStyle   = baseColor;
        ctx.strokeStyle = '#7a5520';
        ctx.lineWidth   = Math.max(1, 2 * zoom);
        ctx.beginPath();
        ctx.rect(ssp.x - sz / 2, ssp.y - sz / 2, sz, sz);
        ctx.fill();
        ctx.stroke();
        // Damage darkening overlay
        if (dmgDarken > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
          ctx.fillRect(ssp.x - sz / 2, ssp.y - sz / 2, sz, sz);
        }
        // Plank lines
        ctx.strokeStyle = 'rgba(90, 55, 15, 0.5)';
        ctx.lineWidth   = Math.max(0.5, 1 * zoom);
        const third = sz / 3;
        for (let li = 1; li < 3; li++) {
          ctx.beginPath();
          ctx.moveTo(ssp.x - sz / 2, ssp.y - sz / 2 + li * third);
          ctx.lineTo(ssp.x + sz / 2, ssp.y - sz / 2 + li * third);
          ctx.stroke();
        }
        // Company ownership strip along the top edge
        const floorCompanyColor = RenderSystem.structureCompanyColor(s.companyId);
        const stripH = Math.max(2, 3 * zoom);
        ctx.fillStyle = floorCompanyColor;
        ctx.fillRect(ssp.x - sz / 2, ssp.y - sz / 2, sz, stripH);
        ctx.restore();
      } else if (s.type === 'workbench') {
        // Top-down view: wide rectangular bench filling most of the floor tile
        const bw = sz * 0.88;   // bench width
        const bh = sz * 0.62;   // bench depth
        const bx = ssp.x - bw / 2;
        const by = ssp.y - bh / 2;
        ctx.save();
        if (s.rotation) {
          ctx.translate(ssp.x, ssp.y);
          ctx.rotate(s.rotation * Math.PI / 180);
          ctx.translate(-ssp.x, -ssp.y);
        }

        // Outer frame (structural legs / frame seen from above)
        const frameColor  = isHovered ? '#5a3010' : '#4a2408';
        ctx.fillStyle   = frameColor;
        ctx.strokeStyle = '#2a1204';
        ctx.lineWidth   = Math.max(1, 1.5 * zoom);
        ctx.beginPath();
        ctx.rect(bx, by, bw, bh);
        ctx.fill();
        ctx.stroke();

        // Inner work surface (inset by frame thickness)
        const ft = Math.max(2, 4 * zoom); // frame thickness
        const sx2 = bx + ft, sy2 = by + ft;
        const sw  = bw - ft * 2, sh = bh - ft * 2;
        ctx.fillStyle = isHovered ? '#c07838' : '#a86428';
        ctx.beginPath();
        ctx.rect(sx2, sy2, sw, sh);
        ctx.fill();

        // Plank grain lines along the length
        ctx.strokeStyle = 'rgba(60, 30, 8, 0.35)';
        ctx.lineWidth   = Math.max(0.5, 1 * zoom);
        const grainCount = 3;
        for (let gi = 1; gi < grainCount; gi++) {
          const gy = sy2 + sh * (gi / grainCount);
          ctx.beginPath();
          ctx.moveTo(sx2, gy);
          ctx.lineTo(sx2 + sw, gy);
          ctx.stroke();
        }

        // Vise block on the right side
        const vw = Math.max(2, 5 * zoom);
        const vh = Math.max(2, sh * 0.45);
        const vx = sx2 + sw - vw;
        const vy = sy2 + (sh - vh) / 2;
        ctx.fillStyle   = isHovered ? '#888' : '#6a6a6a';
        ctx.strokeStyle = '#3a3a3a';
        ctx.lineWidth   = Math.max(0.5, 1 * zoom);
        ctx.beginPath();
        ctx.rect(vx, vy, vw, vh);
        ctx.fill();
        ctx.stroke();

        // Corner leg indicators (small dark squares at each corner)
        const legSz = Math.max(2, 3.5 * zoom);
        ctx.fillStyle = '#2a1204';
        for (const [lx, ly] of [[bx, by], [bx + bw - legSz, by],
                                 [bx, by + bh - legSz], [bx + bw - legSz, by + bh - legSz]]) {
          ctx.fillRect(lx, ly, legSz, legSz);
        }

        // ⚒ icon centred on the work surface
        ctx.font         = `${Math.max(7, Math.round(10 * zoom))}px monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = 'rgba(255, 210, 100, 0.9)';
        ctx.fillText('\u2692', ssp.x - vw / 2, ssp.y);

        // Company ownership strip along the top edge
        const wbCompanyColor = RenderSystem.structureCompanyColor(s.companyId);
        const wbStripH = Math.max(2, 3 * zoom);
        ctx.fillStyle = wbCompanyColor;
        ctx.fillRect(bx, by, bw, wbStripH);
        // Damage darkening overlay
        const wbHpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const wbDmgDarken = (1 - wbHpFrac) * 0.5;
        if (wbDmgDarken > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${wbDmgDarken.toFixed(2)})`;
          ctx.fillRect(bx, by, bw, bh);
        }

        ctx.restore();
      } else if (s.type === 'wall') {
        // Derive wall rotation from the nearest floor (floor-centre → wall-midpoint vector + 90°)
        const nearWallFloor = this.placedStructures.find(f =>
          f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30
        );
        const wallRotRad = nearWallFloor
          ? Math.atan2(s.y - nearWallFloor.y, s.x - nearWallFloor.x) + Math.PI / 2
          : 0;
        const THICK = 0.18; // ratio of tile (50px * 0.18 = 9px)
        const ww = sz;          // long axis (rotated by wallRotRad)
        const wh = sz * THICK;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const dmgDarken = (1 - hpFrac) * 0.5;

        ctx.save();
        ctx.translate(ssp.x, ssp.y);
        ctx.rotate(wallRotRad);
        ctx.translate(-ssp.x, -ssp.y);
        ctx.fillStyle   = isHovered ? '#7a5030' : '#5c3a1a';
        ctx.strokeStyle = '#2e1a08';
        ctx.lineWidth   = Math.max(0.5, 1.5 * zoom);
        ctx.beginPath();
        ctx.rect(ssp.x - ww / 2, ssp.y - wh / 2, ww, wh);
        ctx.fill();
        ctx.stroke();
        // Plank grain lines (verticals in wall-local space)
        ctx.strokeStyle = 'rgba(40, 20, 5, 0.4)';
        ctx.lineWidth   = Math.max(0.5, 0.8 * zoom);
        for (let li = 1; li < 3; li++) {
          const gx = ssp.x - ww / 2 + ww * (li / 3);
          ctx.beginPath(); ctx.moveTo(gx, ssp.y - wh / 2); ctx.lineTo(gx, ssp.y + wh / 2); ctx.stroke();
        }
        // Company color strip
        const wallCompanyColor = RenderSystem.structureCompanyColor(s.companyId);
        const stripSz = Math.max(1, 2 * zoom);
        ctx.fillStyle = wallCompanyColor;
        ctx.fillRect(ssp.x - ww / 2, ssp.y - wh / 2, ww, stripSz);
        // Damage darkening
        if (dmgDarken > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
          ctx.fillRect(ssp.x - ww / 2, ssp.y - wh / 2, ww, wh);
        }
        ctx.restore();
      } else if (s.type === 'door_frame') {
        // Door Frame: two posts at the ends with an open gap in the centre
        const nearDFFloor = this.placedStructures.find(f =>
          f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30
        );
        const dfRotRad = nearDFFloor
          ? Math.atan2(s.y - nearDFFloor.y, s.x - nearDFFloor.x) + Math.PI / 2
          : 0;
        const THICK = 0.18;
        const ww = sz;          // long axis
        const wh = sz * THICK;
        const POST = sz * 0.14; // post square size
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const dmgDarken = (1 - hpFrac) * 0.5;

        ctx.save();
        ctx.translate(ssp.x, ssp.y);
        ctx.rotate(dfRotRad);
        ctx.translate(-ssp.x, -ssp.y);
        ctx.fillStyle   = isHovered ? '#9a6040' : '#7a4820';
        ctx.strokeStyle = '#3e200c';
        ctx.lineWidth   = Math.max(0.5, 1.5 * zoom);
        // Two posts at left and right ends (in wall-local horizontal space)
        ctx.fillRect(ssp.x - ww / 2, ssp.y - POST / 2, POST, POST);
        ctx.strokeRect(ssp.x - ww / 2, ssp.y - POST / 2, POST, POST);
        ctx.fillRect(ssp.x + ww / 2 - POST, ssp.y - POST / 2, POST, POST);
        ctx.strokeRect(ssp.x + ww / 2 - POST, ssp.y - POST / 2, POST, POST);
        // Dashed lintel lines
        ctx.strokeStyle = 'rgba(120, 70, 30, 0.45)';
        ctx.lineWidth = Math.max(0.5, 1 * zoom);
        ctx.setLineDash([Math.max(2, 3 * zoom), Math.max(2, 2 * zoom)]);
        ctx.beginPath(); ctx.moveTo(ssp.x - ww / 2 + POST, ssp.y - wh / 2);
        ctx.lineTo(ssp.x + ww / 2 - POST, ssp.y - wh / 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ssp.x - ww / 2 + POST, ssp.y + wh / 2);
        ctx.lineTo(ssp.x + ww / 2 - POST, ssp.y + wh / 2); ctx.stroke();
        ctx.setLineDash([]);
        // Company color strip
        const dfCompanyColor = RenderSystem.structureCompanyColor(s.companyId);
        const dfStripSz = Math.max(1, 2 * zoom);
        ctx.fillStyle = dfCompanyColor;
        ctx.fillRect(ssp.x - ww / 2, ssp.y - POST / 2, POST, dfStripSz);
        if (dmgDarken > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
          ctx.fillRect(ssp.x - ww / 2, ssp.y - POST / 2, POST, POST);
          ctx.fillRect(ssp.x + ww / 2 - POST, ssp.y - POST / 2, POST, POST);
        }
        ctx.restore();
      } else if (s.type === 'door') {
        // Door: derive rotation from nearest floor (same as wall/door_frame)
        const nearDoorFloor = this.placedStructures.find(f =>
          f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30
        );
        const doorRotRad = nearDoorFloor
          ? Math.atan2(s.y - nearDoorFloor.y, s.x - nearDoorFloor.x) + Math.PI / 2
          : 0;
        // Always draw in horizontal local space; rotation is applied via ctx transform
        const THICK = 0.18;
        const ww = sz;
        const wh = sz * THICK;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const dmgDarken = (1 - hpFrac) * 0.5;
        const isOpen = s.doorOpen === true;

        ctx.save();
        ctx.translate(ssp.x, ssp.y);
        ctx.rotate(doorRotRad);
        ctx.translate(-ssp.x, -ssp.y);
        if (!isOpen) {
          // Closed door: filled planks
          ctx.fillStyle   = isHovered ? '#9a6040' : '#7a4820';
          ctx.strokeStyle = '#3e200c';
          ctx.lineWidth   = Math.max(0.5, 1.5 * zoom);
          ctx.beginPath();
          ctx.rect(ssp.x - ww / 2, ssp.y - wh / 2, ww, wh);
          ctx.fill();
          ctx.stroke();
          // Center dividing line (vertical in local space = across the width)
          ctx.strokeStyle = 'rgba(30, 12, 4, 0.5)';
          ctx.lineWidth   = Math.max(0.5, 1 * zoom);
          ctx.beginPath(); ctx.moveTo(ssp.x, ssp.y - wh / 2); ctx.lineTo(ssp.x, ssp.y + wh / 2); ctx.stroke();
        } else {
          // Open door: two short end-posts, gap in middle
          const postSz = sz * 0.15;
          ctx.fillStyle   = isHovered ? '#9a6040' : '#7a4820';
          ctx.strokeStyle = '#3e200c';
          ctx.lineWidth   = Math.max(0.5, 1.5 * zoom);
          ctx.fillRect(ssp.x - ww / 2, ssp.y - wh / 2, postSz, wh);
          ctx.strokeRect(ssp.x - ww / 2, ssp.y - wh / 2, postSz, wh);
          ctx.fillRect(ssp.x + ww / 2 - postSz, ssp.y - wh / 2, postSz, wh);
          ctx.strokeRect(ssp.x + ww / 2 - postSz, ssp.y - wh / 2, postSz, wh);
          // Dashed outline showing door extent
          ctx.strokeStyle = 'rgba(150, 100, 60, 0.35)';
          ctx.lineWidth   = Math.max(0.5, 1 * zoom);
          ctx.setLineDash([Math.max(2, 3 * zoom), Math.max(2, 3 * zoom)]);
          ctx.strokeRect(ssp.x - ww / 2, ssp.y - wh / 2, ww, wh);
          ctx.setLineDash([]);
        }
        // Company color strip
        const doorCompanyColor = RenderSystem.structureCompanyColor(s.companyId);
        const doorStripSz = Math.max(1, 2 * zoom);
        ctx.fillStyle = doorCompanyColor;
        ctx.fillRect(ssp.x - ww / 2, ssp.y - wh / 2, ww, doorStripSz);
        // Damage darkening
        if (!isOpen && dmgDarken > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
          ctx.fillRect(ssp.x - ww / 2, ssp.y - wh / 2, ww, wh);
        }
        ctx.restore();
      } else if (s.type === 'shipyard') {
        // ── U-shaped dry dock sized to fit the Brigantine (760×180 world px) ──
        const ARM_T  = sz * 1.00;   // pier arm thickness
        const INT_W  = sz * 4.80;   // interior bay width  (brigantine beam 180 + margins)
        const ARM_L  = sz * 16.80;  // arm length / bay depth (brigantine length 760 + margins)
        const BACK_T = sz * 1.00;   // back wall thickness
        const totalW = ARM_T + INT_W + ARM_T;   // sz * 6.8
        const totalH = BACK_T + ARM_L;          // sz * 17.8
        const hw = totalW / 2, hh = totalH / 2;
        const cx = ssp.x, cy = ssp.y;
        const hpFrac    = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const dmgDarken = (1 - hpFrac) * 0.5;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((s.rotation ?? 0) * Math.PI / 180);
        ctx.translate(-cx, -cy);
        // U-path: clockwise outer polygon with gap at +y (mouth / open end)
        const uPath = () => {
          ctx.beginPath();
          ctx.moveTo(cx - hw,         cy - hh);
          ctx.lineTo(cx + hw,         cy - hh);
          ctx.lineTo(cx + hw,         cy + hh);
          ctx.lineTo(cx + hw - ARM_T, cy + hh);
          ctx.lineTo(cx + hw - ARM_T, cy - hh + BACK_T);
          ctx.lineTo(cx - hw + ARM_T, cy - hh + BACK_T);
          ctx.lineTo(cx - hw + ARM_T, cy + hh);
          ctx.lineTo(cx - hw,         cy + hh);
          ctx.closePath();
        };
        // ── Dock body (weathered timber) ──────────────────────────────────────
        ctx.fillStyle   = isHovered ? '#4a6852' : '#2e4a36';
        ctx.strokeStyle = '#1a2a1e';
        ctx.lineWidth   = Math.max(1, 2 * zoom);
        uPath();
        ctx.fill();
        ctx.stroke();
        // ── Plank grain on arms and back wall ─────────────────────────────────
        ctx.strokeStyle = 'rgba(10, 20, 10, 0.28)';
        ctx.lineWidth   = Math.max(0.5, 0.8 * zoom);
        const plankStep = ARM_T / 2.5;
        for (let p = plankStep; p < totalH; p += plankStep) {
          const py = cy - hh + p;
          ctx.beginPath(); ctx.moveTo(cx - hw,         py); ctx.lineTo(cx - hw + ARM_T, py); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + hw - ARM_T, py); ctx.lineTo(cx + hw,         py); ctx.stroke();
        }
        for (let p = plankStep; p < INT_W; p += plankStep) {
          const px = cx - hw + ARM_T + p;
          ctx.beginPath(); ctx.moveTo(px, cy - hh); ctx.lineTo(px, cy - hh + BACK_T); ctx.stroke();
        }

        // ── Dark seafloor inside the bay ──────────────────────────────────────
        ctx.fillStyle = 'rgba(10, 40, 65, 0.72)';
        ctx.fillRect(cx - hw + ARM_T, cy - hh + BACK_T, INT_W, ARM_L);
        // ── Brigantine hull silhouette (empty dock — ghost/placeholder) ────────
        {
          const shpHW  = INT_W * 0.36;
          const shpTop = cy - hh + BACK_T + ARM_L * 0.05;
          const shpBot = cy + hh          - ARM_L * 0.05;
          const shpLen = shpBot - shpTop;
          ctx.fillStyle   = 'rgba(68, 46, 20, 0.30)';
          ctx.strokeStyle = 'rgba(155, 115, 60, 0.55)';
          ctx.lineWidth   = Math.max(1, 1.5 * zoom);
          ctx.beginPath();
          ctx.moveTo(cx, shpTop);
          ctx.bezierCurveTo(cx + shpHW * 0.5, shpTop + shpLen * 0.07,
                            cx + shpHW,       shpTop + shpLen * 0.22,
                            cx + shpHW,       shpTop + shpLen * 0.65);
          ctx.bezierCurveTo(cx + shpHW,       shpTop + shpLen * 0.85,
                            cx + shpHW * 0.5, shpBot,
                            cx,               shpBot);
          ctx.bezierCurveTo(cx - shpHW * 0.5, shpBot,
                            cx - shpHW,       shpTop + shpLen * 0.85,
                            cx - shpHW,       shpTop + shpLen * 0.65);
          ctx.bezierCurveTo(cx - shpHW,       shpTop + shpLen * 0.22,
                            cx - shpHW * 0.5, shpTop + shpLen * 0.07,
                            cx,               shpTop);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        // ── Ship under construction (building phase) ───────────────────────────
        if (s.construction?.phase === 'building') {
          const mp    = s.construction.modulesPlaced;
          const bHW   = INT_W * 0.44;   // brigantine half-beam in screen units
          const bTop  = cy - hh + BACK_T + ARM_L * 0.02;  // bow tip
          const bBot  = cy + hh          - ARM_L * 0.02;  // stern
          const bLen  = bBot - bTop;

          // Hull bezier path helper
          const hullPath = () => {
            ctx.beginPath();
            ctx.moveTo(cx, bTop);
            ctx.bezierCurveTo(cx + bHW * 0.5, bTop + bLen * 0.07,
                              cx + bHW,       bTop + bLen * 0.22,
                              cx + bHW,       bTop + bLen * 0.65);
            ctx.bezierCurveTo(cx + bHW,       bTop + bLen * 0.85,
                              cx + bHW * 0.5, bBot,
                              cx,             bBot);
            ctx.bezierCurveTo(cx - bHW * 0.5, bBot,
                              cx - bHW,       bTop + bLen * 0.85,
                              cx - bHW,       bTop + bLen * 0.65);
            ctx.bezierCurveTo(cx - bHW,       bTop + bLen * 0.22,
                              cx - bHW * 0.5, bTop + bLen * 0.07,
                              cx,             bTop);
            ctx.closePath();
          };

          // Keel / skeleton (always shown in building phase)
          ctx.strokeStyle = 'rgba(200, 155, 80, 0.90)';
          ctx.lineWidth   = Math.max(1.5, 3 * zoom);
          ctx.setLineDash([Math.max(3, 6 * zoom), Math.max(2, 4 * zoom)]);
          hullPath(); ctx.stroke();
          ctx.setLineDash([]);

          // Port hull planks
          if (mp.includes('hull_left')) {
            ctx.strokeStyle = 'rgba(120, 80, 35, 0.95)';
            ctx.lineWidth   = Math.max(2, 4 * zoom);
            ctx.beginPath();
            ctx.moveTo(cx - bHW, bTop + bLen * 0.65);
            ctx.bezierCurveTo(cx - bHW, bTop + bLen * 0.85, cx - bHW * 0.5, bBot, cx, bBot);
            ctx.moveTo(cx, bTop);
            ctx.bezierCurveTo(cx - bHW * 0.5, bTop + bLen * 0.07, cx - bHW, bTop + bLen * 0.22, cx - bHW, bTop + bLen * 0.65);
            ctx.stroke();
          }
          // Stbd hull planks
          if (mp.includes('hull_right')) {
            ctx.strokeStyle = 'rgba(120, 80, 35, 0.95)';
            ctx.lineWidth   = Math.max(2, 4 * zoom);
            ctx.beginPath();
            ctx.moveTo(cx + bHW, bTop + bLen * 0.65);
            ctx.bezierCurveTo(cx + bHW, bTop + bLen * 0.85, cx + bHW * 0.5, bBot, cx, bBot);
            ctx.moveTo(cx, bTop);
            ctx.bezierCurveTo(cx + bHW * 0.5, bTop + bLen * 0.07, cx + bHW, bTop + bLen * 0.22, cx + bHW, bTop + bLen * 0.65);
            ctx.stroke();
          }
          // Deck
          if (mp.includes('deck')) {
            ctx.fillStyle = 'rgba(140, 100, 50, 0.35)';
            hullPath(); ctx.fill();
            ctx.strokeStyle = 'rgba(100, 72, 30, 0.40)';
            ctx.lineWidth   = Math.max(0.5, 1 * zoom);
            const planks2 = 8;
            for (let pi = 1; pi < planks2; pi++) {
              const py2 = bTop + bLen * (pi / planks2);
              ctx.beginPath(); ctx.moveTo(cx - bHW * 0.9, py2); ctx.lineTo(cx + bHW * 0.9, py2); ctx.stroke();
            }
          }
          // Mast
          if (mp.includes('mast')) {
            const mastY = bTop + bLen * 0.30;
            ctx.strokeStyle = 'rgba(180, 140, 70, 0.95)';
            ctx.lineWidth   = Math.max(2, 3.5 * zoom);
            ctx.beginPath(); ctx.moveTo(cx, bTop + bLen * 0.05); ctx.lineTo(cx, bTop + bLen * 0.55); ctx.stroke();
            ctx.lineWidth   = Math.max(1.5, 2.5 * zoom);
            ctx.beginPath(); ctx.moveTo(cx - bHW * 0.45, mastY); ctx.lineTo(cx + bHW * 0.45, mastY); ctx.stroke();
          }
          // Port cannon
          if (mp.includes('cannon_port')) {
            const canY = bTop + bLen * 0.45;
            ctx.fillStyle = 'rgba(60, 60, 60, 0.90)';
            ctx.beginPath(); ctx.arc(cx - bHW * 0.78, canY, Math.max(3, 5 * zoom), 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
            const cbl = Math.max(4, 10 * zoom);
            ctx.beginPath(); ctx.moveTo(cx - bHW * 0.78 - cbl, canY); ctx.lineTo(cx - bHW * 0.78 + cbl * 0.3, canY); ctx.stroke();
          }
          // Stbd cannon
          if (mp.includes('cannon_stbd')) {
            const canY = bTop + bLen * 0.45;
            ctx.fillStyle = 'rgba(60, 60, 60, 0.90)';
            ctx.beginPath(); ctx.arc(cx + bHW * 0.78, canY, Math.max(3, 5 * zoom), 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
            const cbl = Math.max(4, 10 * zoom);
            ctx.beginPath(); ctx.moveTo(cx + bHW * 0.78 + cbl, canY); ctx.lineTo(cx + bHW * 0.78 - cbl * 0.3, canY); ctx.stroke();
          }

          // ── Ghost slots for unplaced modules (pulsing dashed outlines) ──────
          {
            const pulse = 0.4 + 0.3 * Math.sin(performance.now() * 0.003);
            const dashLen = Math.max(2, 4 * zoom);
            ctx.setLineDash([dashLen, dashLen]);
            // Port hull ghost
            if (!mp.includes('hull_left')) {
              ctx.strokeStyle = `rgba(200, 155, 80, ${pulse.toFixed(2)})`;
              ctx.lineWidth   = Math.max(1, 2 * zoom);
              ctx.beginPath();
              ctx.moveTo(cx - bHW, bTop + bLen * 0.65);
              ctx.bezierCurveTo(cx - bHW, bTop + bLen * 0.85, cx - bHW * 0.5, bBot, cx, bBot);
              ctx.moveTo(cx, bTop);
              ctx.bezierCurveTo(cx - bHW * 0.5, bTop + bLen * 0.07, cx - bHW, bTop + bLen * 0.22, cx - bHW, bTop + bLen * 0.65);
              ctx.stroke();
              ctx.font = `${Math.max(7, Math.round(9 * zoom))}px Consolas, monospace`;
              ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              ctx.fillStyle = `rgba(220, 180, 80, ${pulse.toFixed(2)})`;
              ctx.fillText('⊟ Hull (Port)', cx - bHW * 0.55, bTop + bLen * 0.45);
            }
            // Stbd hull ghost
            if (!mp.includes('hull_right')) {
              ctx.strokeStyle = `rgba(200, 155, 80, ${pulse.toFixed(2)})`;
              ctx.lineWidth   = Math.max(1, 2 * zoom);
              ctx.beginPath();
              ctx.moveTo(cx + bHW, bTop + bLen * 0.65);
              ctx.bezierCurveTo(cx + bHW, bTop + bLen * 0.85, cx + bHW * 0.5, bBot, cx, bBot);
              ctx.moveTo(cx, bTop);
              ctx.bezierCurveTo(cx + bHW * 0.5, bTop + bLen * 0.07, cx + bHW, bTop + bLen * 0.22, cx + bHW, bTop + bLen * 0.65);
              ctx.stroke();
              ctx.font = `${Math.max(7, Math.round(9 * zoom))}px Consolas, monospace`;
              ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              ctx.fillStyle = `rgba(220, 180, 80, ${pulse.toFixed(2)})`;
              ctx.fillText('⊟ Hull (Stbd)', cx + bHW * 0.55, bTop + bLen * 0.45);
            }
            // Deck ghost
            if (!mp.includes('deck')) {
              ctx.strokeStyle = `rgba(180, 130, 50, ${(pulse * 0.6).toFixed(2)})`;
              ctx.lineWidth   = Math.max(0.5, 1 * zoom);
              hullPath(); ctx.stroke();
              ctx.font = `${Math.max(7, Math.round(9 * zoom))}px Consolas, monospace`;
              ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              ctx.fillStyle = `rgba(220, 180, 80, ${pulse.toFixed(2)})`;
              ctx.fillText('▭ Deck', cx, bTop + bLen * 0.50);
            }
            // Mast ghost
            if (!mp.includes('mast')) {
              const mastY = bTop + bLen * 0.30;
              ctx.strokeStyle = `rgba(180, 140, 70, ${pulse.toFixed(2)})`;
              ctx.lineWidth   = Math.max(1, 2 * zoom);
              ctx.beginPath(); ctx.moveTo(cx, bTop + bLen * 0.05); ctx.lineTo(cx, bTop + bLen * 0.55); ctx.stroke();
              ctx.font = `${Math.max(7, Math.round(9 * zoom))}px Consolas, monospace`;
              ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              ctx.fillStyle = `rgba(180, 140, 70, ${pulse.toFixed(2)})`;
              ctx.fillText('| Mast', cx, mastY - Math.max(6, 10 * zoom));
            }
            // Port cannon ghost
            if (!mp.includes('cannon_port')) {
              const canY = bTop + bLen * 0.45;
              ctx.strokeStyle = `rgba(100, 100, 100, ${pulse.toFixed(2)})`;
              ctx.lineWidth   = Math.max(1, 1.5 * zoom);
              ctx.beginPath(); ctx.arc(cx - bHW * 0.78, canY, Math.max(3, 5 * zoom), 0, Math.PI * 2); ctx.stroke();
            }
            // Stbd cannon ghost
            if (!mp.includes('cannon_stbd')) {
              const canY = bTop + bLen * 0.45;
              ctx.strokeStyle = `rgba(100, 100, 100, ${pulse.toFixed(2)})`;
              ctx.lineWidth   = Math.max(1, 1.5 * zoom);
              ctx.beginPath(); ctx.arc(cx + bHW * 0.78, canY, Math.max(3, 5 * zoom), 0, Math.PI * 2); ctx.stroke();
            }
            ctx.setLineDash([]);
          }
          // Progress label
          const required  = ['hull_left', 'hull_right', 'deck'];
          const doneCnt   = required.filter(id => mp.includes(id)).length;
          const allDone   = doneCnt === required.length;
          ctx.font         = `bold ${Math.max(9, Math.round(11 * zoom))}px Consolas, monospace`;
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = allDone ? 'rgba(80, 200, 120, 0.90)' : 'rgba(220, 180, 80, 0.90)';
          ctx.fillText(
            allDone ? '⚓ Ready to Launch' : `Building… ${doneCnt}/${required.length} required`,
            cx, cy - hh + BACK_T + ARM_L * 0.50
          );
        }
        // Mast yard-arm crosses (fore + main)
        ctx.strokeStyle = 'rgba(155, 115, 60, 0.65)';
        ctx.lineWidth   = Math.max(1, 2 * zoom);
        for (const mf of [0.28, 0.60]) {
          const mpy = cy - hh + BACK_T + ARM_L * mf;
          const mhw = INT_W * 0.36;
          ctx.beginPath(); ctx.moveTo(cx,             mpy - ARM_T * 0.25); ctx.lineTo(cx,             mpy + ARM_T * 0.25); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx - mhw * 0.4, mpy);               ctx.lineTo(cx + mhw * 0.4, mpy);               ctx.stroke();
        }
        // ── Scaffolding cross-beams and diagonal arm bracing ──────────────────
        ctx.strokeStyle = 'rgba(190, 150, 85, 0.85)';
        ctx.lineWidth   = Math.max(1, 1.8 * zoom);
        for (const frac of [0.25, 0.50, 0.75]) {
          const bpy = cy - hh + BACK_T + ARM_L * frac;
          ctx.beginPath(); ctx.moveTo(cx - hw + ARM_T, bpy); ctx.lineTo(cx + hw - ARM_T, bpy); ctx.stroke();
          const pLen = ARM_T * 0.30;
          ctx.beginPath(); ctx.moveTo(cx - hw + ARM_T, bpy - pLen); ctx.lineTo(cx - hw + ARM_T, bpy + pLen); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + hw - ARM_T, bpy - pLen); ctx.lineTo(cx + hw - ARM_T, bpy + pLen); ctx.stroke();
        }
        ctx.lineWidth   = Math.max(0.5, 1 * zoom);
        ctx.strokeStyle = 'rgba(160, 120, 60, 0.45)';
        const bFracs = [0, 0.25, 0.50, 0.75, 1.0];
        for (let bi = 0; bi < bFracs.length - 1; bi++) {
          const y0 = cy - hh + BACK_T + ARM_L * bFracs[bi];
          const y1 = cy - hh + BACK_T + ARM_L * bFracs[bi + 1];
          ctx.beginPath(); ctx.moveTo(cx - hw,         y0); ctx.lineTo(cx - hw + ARM_T, y1); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx - hw + ARM_T, y0); ctx.lineTo(cx - hw,         y1); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + hw - ARM_T, y0); ctx.lineTo(cx + hw,         y1); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + hw,         y0); ctx.lineTo(cx + hw - ARM_T, y1); ctx.stroke();
        }
        // ── Mooring bollards at the mouth ──────────────────────────────────────
        ctx.fillStyle = 'rgba(190, 150, 85, 0.95)';
        const bollardR = Math.max(2, 3.5 * zoom);
        ctx.beginPath(); ctx.arc(cx - hw + ARM_T * 0.5, cy + hh - ARM_T * 0.4, bollardR, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + hw - ARM_T * 0.5, cy + hh - ARM_T * 0.4, bollardR, 0, Math.PI * 2); ctx.fill();
        // ── Company color strip along back wall ────────────────────────────────
        const syStripH = Math.max(2, 3 * zoom);
        ctx.fillStyle = RenderSystem.structureCompanyColor(s.companyId);
        ctx.fillRect(cx - hw, cy - hh, totalW, syStripH);
        // ── Damage darkening overlay ────────────────────────────────────────────
        if (dmgDarken > 0.01) {
          ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
          uPath();
          ctx.fill();
        }
        ctx.restore();
      }
    } // end for sorted

    if (this._hoveredStructure) {
      const s   = this._hoveredStructure;
      const ssp = camera.worldToScreen(Vec2.from(s.x, s.y));
      const sz  = Math.max(4, 50 * zoom);

      // Derive rendering rotation for this structure.
      // Floors/workbenches carry an explicit rotation field.
      // Walls/door_frames/doors derive orientation from the nearest floor tile:
      // the wall runs perpendicular to the floor-centre→wall-midpoint vector.
      let rotRad = 0;
      if (s.type === 'wooden_floor' || s.type === 'workbench' || s.type === 'shipyard') {
        rotRad = (s.rotation ?? 0) * Math.PI / 180;
      } else {
        let nearFloor: PlacedStructure | null = null;
        let nearDist2 = Infinity;
        for (const f of this.placedStructures) {
          if (f.type !== 'wooden_floor') continue;
          const d2 = (f.x - s.x) * (f.x - s.x) + (f.y - s.y) * (f.y - s.y);
          if (d2 < nearDist2) { nearDist2 = d2; nearFloor = f; }
        }
        if (nearFloor) rotRad = Math.atan2(s.y - nearFloor.y, s.x - nearFloor.x) + Math.PI / 2;
      }

      // Unrotated dimensions of the structure rect
      const THICK  = 0.18;
      const isWall = s.type === 'wall' || s.type === 'door_frame' || s.type === 'door';
      const rawW   = isWall ? sz : s.type === 'workbench' ? sz * 0.88 : s.type === 'shipyard' ? sz * 6.8  : sz;
      const rawH   = isWall ? sz * THICK : s.type === 'workbench' ? sz * 0.62 : s.type === 'shipyard' ? sz * 17.8 : sz;

      // Axis-aligned bounding box after rotation (used for bar/tooltip screen positioning)
      const absC = Math.abs(Math.cos(rotRad)), absS = Math.abs(Math.sin(rotRad));
      const bbW  = rawW * absC + rawH * absS;
      const bbH  = rawW * absS + rawH * absC;

      // Draw outline rect rotated to match structure orientation
      ctx.save();
      ctx.strokeStyle = '#ffe090';
      ctx.lineWidth   = Math.max(1, 3 * zoom);
      ctx.translate(ssp.x, ssp.y);
      ctx.rotate(rotRad);
      ctx.strokeRect(-rawW / 2, -rawH / 2, rawW, rawH);
      ctx.restore();

      // ── HP bar (hover only) ────────────────────────────────────────────
      {
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const barW   = bbW;
        const barH   = Math.max(2, 3 * zoom);
        const barX   = ssp.x - barW / 2;
        const barY   = ssp.y + bbH / 2 + Math.max(2, 2 * zoom);
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = hpFrac > 0.5 ? '#66dd44' : hpFrac > 0.25 ? '#ffaa22' : '#ee3322';
        ctx.fillRect(barX, barY, barW * hpFrac, barH);
        ctx.restore();
      }

      // ── Tooltip ────────────────────────────────────────────────────────
      const tipY = ssp.y - bbH / 2 - 8;

      const inRange = player && player.carrierId === 0 && (() => {
        if (s.type === 'shipyard') {
          // OBB check: rotate player into shipyard local frame
          const rot = (s.rotation ?? 0) * Math.PI / 180;
          const dx = player.position.x - s.x;
          const dy = player.position.y - s.y;
          const c = Math.cos(-rot), sn = Math.sin(-rot);
          const lx = dx * c - dy * sn;
          const ly = dx * sn + dy * c;
          return Math.abs(lx) <= 270 && Math.abs(ly) <= 545;
        }
        const dx = s.x - player.position.x;
        const dy = s.y - player.position.y;
        return dx * dx + dy * dy <= 110 * 110;
      })();

      const label = s.type === 'wooden_floor' ? 'Wooden Floor'
                 : s.type === 'wall' ? 'Wall'
                 : s.type === 'door_frame' ? 'Door Frame'
                 : s.type === 'door' ? (s.doorOpen ? 'Door (Open)' : 'Door (Closed)')
                 : s.type === 'shipyard' ? 'Shipyard'
                 : 'Workbench';

      // Determine ownership line text + color
      const COMPANY_NAMES: Record<number, string> = { 1: 'Pirates', 2: 'Navy', 99: 'Ghosts' };
      let ownerText: string;
      if (s.companyId !== 0 && COMPANY_NAMES[s.companyId]) {
        ownerText = COMPANY_NAMES[s.companyId];
      } else if (s.placerName) {
        ownerText = `Player: ${s.placerName}`;
      } else {
        ownerText = 'Unclaimed';
      }

      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font      = `bold ${Math.max(10, Math.round(12 * zoom))}px Consolas, monospace`;
      ctx.fillStyle = '#ffe8a0';
      ctx.fillText(label, ssp.x, tipY);

      const lineH = Math.max(12, 14 * zoom);
      ctx.font = `${Math.max(9, Math.round(10 * zoom))}px Consolas, monospace`;

      // Owner line (colored by faction)
      ctx.fillStyle = RenderSystem.structureCompanyColor(s.companyId);
      ctx.fillText(ownerText, ssp.x, tipY - lineH);

      // Interact hint (shifted up one more line)
      if (inRange) {
        ctx.fillStyle = 'rgba(200, 255, 180, 0.95)';
        const interactHint = s.type === 'door' ? 'Tap [E] to open/close'
                           : s.type === 'door_frame' ? 'Hold [E] to demolish'
                           : s.type === 'shipyard' ? 'Hold [E] to build ships'
                           : 'Hold [E] to interact';
        ctx.fillText(interactHint, ssp.x, tipY - lineH * 2);
      } else {
        ctx.fillStyle = 'rgba(180, 180, 160, 0.75)';
        ctx.fillText('(walk closer)', ssp.x, tipY - lineH * 2);
      }
      ctx.restore();
    }
  }

  /** Draw the island structure placement ghost at the cursor position (drawn once, after all islands). */
  private drawIslandBuildGhost(camera: Camera): void {
    this._islandGhostTooFar    = false;
    this._snappedBuildPos      = null;
    this._snappedBuildRotation = null;
    if (!this.islandBuildKind || !this.mouseWorldPos) return;
    const zoom = camera.getState().zoom;
    const ctx  = this.ctx;
    const TILE = 50; // world px — floor tile size

    // Helper: sample bumpy island boundary at an angle (mirrors server island_boundary_r)
    const sampleBoundary = (baseR: number, bumps: number[], angle: number): number => {
      const TWO_PI = Math.PI * 2;
      const n = bumps.length;
      let a = angle % TWO_PI;
      if (a < 0) a += TWO_PI;
      const t = (a / TWO_PI) * n;
      const i0 = Math.floor(t) % n;
      const i1 = (i0 + 1) % n;
      return baseR + bumps[i0] + (t - Math.floor(t)) * (bumps[i1] - bumps[i0]);
    };

    // ── Snap to adjacent floor neighbour ────────────────────────────────────
    // When cursor is within SNAP_R world px of any unoccupied cardinal neighbour
    // slot of an existing floor, lock the ghost position there.
    let mx = this.mouseWorldPos.x;
    let my = this.mouseWorldPos.y;
    if (this.islandBuildKind === 'wooden_floor' && this.placedStructures.length > 0) {
      const SNAP_R  = TILE * 0.4; // 20 px — snap pull radius
      let bestDist2 = SNAP_R * SNAP_R;
      let bestX = mx, bestY = my;
      let bestSnapRot: number | null = null;
      for (const s of this.placedStructures) {
        if (s.type !== 'wooden_floor') continue;
        // Derive the 4 neighbour slots using this tile's own rotation
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const c = Math.cos(rad), sn = Math.sin(rad);
        const DIRS = [
          {  dx:  TILE * c,  dy:  TILE * sn },
          {  dx: -TILE * c,  dy: -TILE * sn },
          {  dx: -TILE * sn, dy:  TILE * c  },
          {  dx:  TILE * sn, dy: -TILE * c  },
        ];
        for (const d of DIRS) {
          const nx = s.x + d.dx, ny = s.y + d.dy;
          // Skip neighbour slots occupied by a *different* floor.
          // Source tile (s) is excluded by id — candidate is adjacent/touching it by construction.
          const blocker = this.placedStructures.find(
            f => f.type === 'wooden_floor' && f.id !== s.id &&
                 RenderSystem.floorsOverlap(nx, ny, rad, f.x, f.y, (f.rotation ?? 0) * Math.PI / 180)
          );
          if (blocker) {
            if (import.meta.env.DEV) console.debug(
              `[snap] candidate (${nx.toFixed(1)},${ny.toFixed(1)}) blocked by floor id=${blocker.id}` +
              ` at (${blocker.x.toFixed(1)},${blocker.y.toFixed(1)}) rot=${blocker.rotation ?? 0}°`
            );
            continue;
          }
          const dist2 = (nx - mx) * (nx - mx) + (ny - my) * (ny - my);
          if (dist2 < bestDist2) { bestDist2 = dist2; bestX = nx; bestY = ny; bestSnapRot = s.rotation ?? 0; }
        }
      }
      mx = bestX; my = bestY;
      this._snappedBuildRotation = bestSnapRot;
    } else if ((this.islandBuildKind === 'wall' || this.islandBuildKind === 'door_frame') && this.placedStructures.length > 0) {
      // Reset rotation so stale value never persists when no snap is found
      this._wallGhostRotRad = 0;
      const HALF = TILE / 2; // 25 px
      const SNAP_R = TILE * 0.6;
      let bestDist2 = SNAP_R * SNAP_R;
      let bestX = mx, bestY = my;
      for (const s of this.placedStructures) {
        if (s.type !== 'wooden_floor') continue;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const c = Math.cos(rad), sn = Math.sin(rad);
        // (ldx, ldy) in local tile space; isHoriz tracks whether it's a N/S edge
        const EDGES = [
          { ldx:  0,    ldy: -HALF, horiz: true  }, // N
          { ldx:  0,    ldy:  HALF, horiz: true  }, // S
          { ldx: -HALF, ldy:  0,    horiz: false }, // W
          { ldx:  HALF, ldy:  0,    horiz: false }, // E
        ];
        for (const e of EDGES) {
          const nx = s.x + e.ldx * c - e.ldy * sn;
          const ny = s.y + e.ldx * sn + e.ldy * c;
          const occ = this.placedStructures.some(
            w => (w.type === 'wall' || w.type === 'door_frame') && Math.abs(w.x - nx) < 2 && Math.abs(w.y - ny) < 2
          );
          if (occ) continue;
          const dist2 = (nx - mx) * (nx - mx) + (ny - my) * (ny - my);
          if (dist2 < bestDist2) {
            bestDist2 = dist2; bestX = nx; bestY = ny;
            const floorRad = (s.rotation ?? 0) * Math.PI / 180;
            this._wallGhostRotRad = e.horiz ? floorRad : floorRad + Math.PI / 2;
          }
        }
      }
      mx = bestX; my = bestY;
    } else if (this.islandBuildKind === 'door' && this.placedStructures.length > 0) {
      // Snap to unoccupied door_frame positions
      const SNAP_R = TILE * 0.6;
      let bestDist2 = SNAP_R * SNAP_R;
      let bestX = mx, bestY = my;
      for (const s of this.placedStructures) {
        if (s.type !== 'door_frame') continue;
        const hasDoor = this.placedStructures.some(
          d => d.type === 'door' && Math.abs(d.x - s.x) < 2 && Math.abs(d.y - s.y) < 2
        );
        if (hasDoor) continue;
        const dist2 = (s.x - mx) * (s.x - mx) + (s.y - my) * (s.y - my);
        if (dist2 < bestDist2) {
          bestDist2 = dist2; bestX = s.x; bestY = s.y;
          const nearFloorDoor = this.placedStructures.find(f =>
            f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30
          );
          this._wallGhostRotRad = nearFloorDoor
            ? Math.atan2(s.y - nearFloorDoor.y, s.x - nearFloorDoor.x) + Math.PI / 2
            : 0;
        }
      }
      mx = bestX; my = bestY;
    }
    this._snappedBuildPos = { x: mx, y: my };
    // Effective rotation: snapped tile inherits source floor's rotation; free-placing uses user setting
    const effectiveRotDeg = this._snappedBuildRotation !== null
      ? this._snappedBuildRotation : this.islandBuildRotationDeg;

    // Recalculate screen position after potential snap
    const msp = camera.worldToScreen(Vec2.from(mx, my));
    const sz  = Math.max(4, TILE * zoom);

    // Water check: is snapped pos over any island's beach area?
    let inWater = true;
    for (const isl of this.islands) {
      if (isl.vertices) {
        // Polygon island: ray-cast point-in-polygon
        let inside = false;
        const verts = isl.vertices;
        const n = verts.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = verts[i].x, yi = verts[i].y;
          const xj = verts[j].x, yj = verts[j].y;
          if ((yi > my) !== (yj > my) && mx < (xj - xi) * (my - yi) / (yj - yi) + xi)
            inside = !inside;
        }
        if (inside) { inWater = false; break; }
      } else {
        // Bump-circle island
        const preset = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
        const dx = mx - isl.x, dy = my - isl.y;
        const distSq = dx * dx + dy * dy;
        const broadR = preset.beachRadius + Math.max(...preset.beachBumps.map(Math.abs));
        if (distSq >= broadR * broadR) continue;
        const angle   = Math.atan2(dy, dx);
        const narrowR = sampleBoundary(preset.beachRadius, preset.beachBumps, angle);
        if (distSq < narrowR * narrowR) { inWater = false; break; }
      }
    }

    // ── Shipyard ghost — unique placement logic ──────────────────────────
    if (this.islandBuildKind === 'shipyard') {
      const SHALLOW_SCALE_G = 0.375; // must match server SHALLOW_WATER_SCALE
      const playerG = this._cachedLocalPlayer;

      // Helper: check if a world point is in water (not inside any island land mass)
      const isPointInWater = (px: number, py: number): boolean => {
        for (const isl of this.islands) {
          if (isl.vertices) {
            let inside = false;
            const verts = isl.vertices;
            const n = verts.length;
            for (let i = 0, j = n - 1; i < n; j = i++) {
              const xi = verts[i].x, yi = verts[i].y;
              const xj = verts[j].x, yj = verts[j].y;
              if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
                inside = !inside;
            }
            if (inside) return false;
          } else {
            const preset = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
            const ddx = px - isl.x, ddy = py - isl.y;
            const dSq = ddx * ddx + ddy * ddy;
            const broadR = preset.beachRadius + Math.max(...preset.beachBumps.map(Math.abs));
            if (dSq >= broadR * broadR) continue;
            const ang = Math.atan2(ddy, ddx);
            const nR = sampleBoundary(preset.beachRadius, preset.beachBumps, ang);
            if (dSq < nR * nR) return false;
          }
        }
        return true;
      };

      let inShallowZone = false;
      if (inWater) {
        for (const isl of this.islands) {
          if (isl.vertices) {
            const polyBoundR = Math.max(...isl.vertices.map(v => Math.hypot(v.x - isl.x, v.y - isl.y)));
            const shallowDepth = polyBoundR * SHALLOW_SCALE_G;
            const d = Math.hypot(mx - isl.x, my - isl.y);
            if (d <= polyBoundR + shallowDepth) { inShallowZone = true; break; }
          } else {
            const preset = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
            const maxBump = Math.max(...preset.beachBumps.map(Math.abs));
            const shallowDepth = preset.beachRadius * SHALLOW_SCALE_G;
            const outerR  = preset.beachRadius + maxBump + shallowDepth;
            const dx = mx - isl.x, dy = my - isl.y;
            if (dx * dx + dy * dy <= outerR * outerR) { inShallowZone = true; break; }
          }
        }
      }

      // Check that the dock mouth leads to open water for ship release.
      // Mouth is 445 world units from center in the local +y direction.
      const HH_WORLD = 445;
      const rotRad = effectiveRotDeg * Math.PI / 180;
      const mouthX = mx - HH_WORLD * Math.sin(rotRad);
      const mouthY = my + HH_WORLD * Math.cos(rotRad);
      // Also check a point 600 units out (clear path for the ship)
      const releaseX = mx - 600 * Math.sin(rotRad);
      const releaseY = my + 600 * Math.cos(rotRad);
      const mouthClear = isPointInWater(mouthX, mouthY) && isPointInWater(releaseX, releaseY);

      // Allow placing from shore — 700 px matches the server shipyard placement range
      const syPlayerFar = playerG ? (() => {
        const dx = mx - playerG.position.x; const dy = my - playerG.position.y;
        return dx * dx + dy * dy > 700 * 700;
      })() : false;
      const syOccupied = this.placedStructures.some(s =>
        s.type === 'shipyard' && Math.hypot(s.x - mx, s.y - my) < 700
      );
      const syInvalid = !inWater || !inShallowZone || syPlayerFar || syOccupied || !mouthClear;
      this._islandGhostTooFar = syInvalid;
      // Ghost uses same proportions as rendered shipyard (bracketized to brigantine scale)
      const GA_T = TILE * 1.00 * zoom;
      const GI_W = TILE * 4.80 * zoom;
      const GA_L = TILE * 16.80 * zoom;
      const GB_T = TILE * 1.00 * zoom;
      const gtW  = Math.max(4, GA_T + GI_W + GA_T);
      const gtH  = Math.max(4, GB_T + GA_L);
      const gHW = gtW / 2, gHH = gtH / 2;
      ctx.save();
      ctx.globalAlpha = 0.72 + 0.14 * Math.sin(performance.now() / 300);
      // Apply rotation — same effectiveRotDeg used by floor/workbench ghost
      if (effectiveRotDeg !== 0) {
        ctx.translate(msp.x, msp.y);
        ctx.rotate(effectiveRotDeg * Math.PI / 180);
        ctx.translate(-msp.x, -msp.y);
      }
      ctx.fillStyle   = syInvalid ? 'rgba(220, 60, 40, 0.45)' : 'rgba(100, 180, 255, 0.45)';
      ctx.strokeStyle = syInvalid ? 'rgba(255, 100, 60, 0.75)' : 'rgba(120, 200, 255, 0.75)';
      ctx.lineWidth   = Math.max(1, 2 * zoom);
      ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(2, 3 * zoom)]);
      ctx.beginPath();
      ctx.moveTo(msp.x - gHW,         msp.y - gHH);
      ctx.lineTo(msp.x + gHW,         msp.y - gHH);
      ctx.lineTo(msp.x + gHW,         msp.y + gHH);
      ctx.lineTo(msp.x + gHW - GA_T,  msp.y + gHH);
      ctx.lineTo(msp.x + gHW - GA_T,  msp.y - gHH + GB_T);
      ctx.lineTo(msp.x - gHW + GA_T,  msp.y - gHH + GB_T);
      ctx.lineTo(msp.x - gHW + GA_T,  msp.y + gHH);
      ctx.lineTo(msp.x - gHW,         msp.y + gHH);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      const syLabelY = msp.y - gHH - 6;
      ctx.globalAlpha = 1;
      ctx.font = `bold ${Math.max(10, Math.round(12 * zoom))}px Consolas, monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      if (!inWater) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('ON LAND', msp.x, syLabelY);
      } else if (!inShallowZone) {
        ctx.fillStyle = '#4488ff'; ctx.fillText('PLACE IN SHALLOW WATER', msp.x, syLabelY);
      } else if (!mouthClear) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('SHIP EXIT BLOCKED BY LAND', msp.x, syLabelY);
      } else if (syOccupied) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('TOO CLOSE TO SHIPYARD', msp.x, syLabelY);
      } else if (syPlayerFar) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('TOO FAR', msp.x, syLabelY);
      } else {
        ctx.fillStyle = '#aadeff'; ctx.fillText('Shipyard', msp.x, syLabelY);
      }
      ctx.restore();
      return;
    }

    // Distance check: player must be within 200 px (world space) of placement point
    const player = this._cachedLocalPlayer;
    let tooFar = false;
    if (player) {
      const dx = mx - player.position.x;
      const dy = my - player.position.y;
      tooFar = dx * dx + dy * dy > 200 * 200;
    }

    // OBB-OBB overlap check via SAT: ghost floor must not overlap any existing floor tile
    let overlaps = false;
    if (this.islandBuildKind === 'wooden_floor') {
      const ghostRad = effectiveRotDeg * Math.PI / 180;
      overlaps = this.placedStructures.some(s => {
        if (s.type !== 'wooden_floor') return false;
        return RenderSystem.floorsOverlap(mx, my, ghostRad, s.x, s.y, (s.rotation ?? 0) * Math.PI / 180);
      });
    }

    // Tree obstacle: circle-OBB intersection — trees (wood resources) block floor placement
    const TREE_R = 20; // world px — obstacle exclusion radius around tree trunk+canopy
    let blockedByTree = false;
    if (this.islandBuildKind === 'wooden_floor') {
      const half = TILE / 2;
      const treeRad = effectiveRotDeg * Math.PI / 180;
      const trc = Math.cos(-treeRad), trs = Math.sin(-treeRad);
      outer:
      for (const isl of this.islands) {
        for (const res of isl.resources) {
          if (res.type !== 'wood') continue;
          if (res.hp <= 0) continue; // depleted — no longer an obstacle
          const tx = isl.x + res.ox, ty = isl.y + res.oy;
          // Rotate tree into floor's local space, then closest-point on local AABB
          const lx = (tx - mx) * trc - (ty - my) * trs;
          const ly = (tx - mx) * trs + (ty - my) * trc;
          const cx = Math.max(-half, Math.min(lx, half));
          const cy = Math.max(-half, Math.min(ly, half));
          const cdx = lx - cx, cdy = ly - cy;
          if (cdx * cdx + cdy * cdy < TREE_R * TREE_R) { blockedByTree = true; break outer; }
        }
      }
    }

    // Workbench needs a floor tile whose AABB contains the cursor point
    let noFloor = false;
    if (this.islandBuildKind === 'workbench') {
      noFloor = !this.placedStructures.some(s => {
        if (s.type !== 'wooden_floor') return false;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const rc = Math.cos(-rad), rs = Math.sin(-rad);
        const lx = (mx - s.x) * rc - (my - s.y) * rs;
        const ly = (mx - s.x) * rs + (my - s.y) * rc;
        return Math.abs(lx) <= 25 && Math.abs(ly) <= 25;
      });
    }

    // Wall/door_frame needs to be at a floor tile edge midpoint; door panel needs a door_frame
    let noEdge = false;
    let wallOccupied = false;
    let noDoorFrame = false;
    let doorOccupied = false;
    let blockedByStructure = false;  // workbench / door blocks the slot
    if (this.islandBuildKind === 'wall' || this.islandBuildKind === 'door_frame') {
      wallOccupied = this.placedStructures.some(
        w => (w.type === 'wall' || w.type === 'door_frame') && Math.abs(w.x - mx) < 2 && Math.abs(w.y - my) < 2
      );
      noEdge = !this.placedStructures.some(s => {
        if (s.type !== 'wooden_floor') return false;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const rc = Math.cos(rad), rs = Math.sin(rad);
        const HALF_E = 25;
        return [
          { ldx: 0, ldy: -HALF_E }, { ldx: 0, ldy: HALF_E },
          { ldx: -HALF_E, ldy: 0 }, { ldx: HALF_E, ldy: 0 },
        ].some(e => {
          const ex = s.x + e.ldx * rc - e.ldy * rs;
          const ey = s.y + e.ldx * rs + e.ldy * rc;
          return Math.abs(mx - ex) < 3 && Math.abs(my - ey) < 3;
        });
      });
      // Check if a workbench or door panel occupies this slot
      if (!wallOccupied && !noEdge) {
        blockedByStructure = this.placedStructures.some(s => {
          if (s.type === 'wooden_floor' || s.type === 'wall' || s.type === 'door_frame') return false;
          return Math.hypot(s.x - mx, s.y - my) < 35;
        });
      }
    } else if (this.islandBuildKind === 'door') {
      noDoorFrame = !this.placedStructures.some(
        s => s.type === 'door_frame' && Math.abs(s.x - mx) < 2 && Math.abs(s.y - my) < 2
      );
      doorOccupied = this.placedStructures.some(
        d => d.type === 'door' && Math.abs(d.x - mx) < 2 && Math.abs(d.y - my) < 2
      );
    }

    // Enemy territory: any structure not belonging to the current company within 500 world px
    const myCompany = (this._localCompanyId ?? 0) as number;
    const enemyTerritory = this.placedStructures.some(s =>
      s.companyId !== myCompany &&
      (s.x - mx) * (s.x - mx) + (s.y - my) * (s.y - my) < 500 * 500
    );

    // Workbench on enemy floor: a floor exists under cursor but belongs to a different company
    const wrongCompany = this.islandBuildKind === 'workbench' && !noFloor &&
      !this.placedStructures.some(s => {
        if (s.type !== 'wooden_floor') return false;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const rc = Math.cos(-rad), rs = Math.sin(-rad);
        const lx = (mx - s.x) * rc - (my - s.y) * rs;
        const ly = (mx - s.x) * rs + (my - s.y) * rc;
        return Math.abs(lx) <= 25 && Math.abs(ly) <= 25 && s.companyId === myCompany;
      });

    // Only floors are rejected for water placement — other types need a floor tile anyway
    const waterBlocked = inWater && this.islandBuildKind === 'wooden_floor';
    this._islandGhostTooFar = tooFar || waterBlocked;
    const invalid = tooFar || waterBlocked || noFloor || overlaps || blockedByTree || enemyTerritory || wrongCompany || noEdge || wallOccupied || blockedByStructure || noDoorFrame || doorOccupied;
    const ghostColor  = invalid ? 'rgba(220, 60, 40, 0.45)' : 'rgba(100, 220, 100, 0.45)';
    const borderColor = invalid ? 'rgba(255, 100, 60, 0.75)' : 'rgba(120, 255, 120, 0.75)';

    ctx.save();
    ctx.globalAlpha = 0.72 + 0.14 * Math.sin(performance.now() / 300);
    // Apply rotation around ghost centre
    const WALL_THICK = 0.18;
    const isWallOrDoor = this.islandBuildKind === 'wall' || this.islandBuildKind === 'door_frame' || this.islandBuildKind === 'door';
    const buildKind    = this.islandBuildKind as string;
    const isRotatable  = buildKind === 'wooden_floor' || buildKind === 'workbench' || buildKind === 'shipyard';
    const ghostRotRad  = isWallOrDoor ? this._wallGhostRotRad
                       : isRotatable ? effectiveRotDeg * Math.PI / 180 : 0;
    if (ghostRotRad !== 0) {
      ctx.translate(msp.x, msp.y);
      ctx.rotate(ghostRotRad);
      ctx.translate(-msp.x, -msp.y);
    }
    ctx.fillStyle   = ghostColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth   = Math.max(1, 2 * zoom);
    ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(2, 3 * zoom)]);
    const ghostW = this.islandBuildKind === 'workbench' ? sz * 0.88
                 : isWallOrDoor ? sz
                 : sz;
    const ghostH = this.islandBuildKind === 'workbench' ? sz * 0.62
                 : isWallOrDoor ? sz * WALL_THICK
                 : sz;

    if (this.islandBuildKind === 'door_frame') {
      // Ghost shaped like a door frame: two posts at ends, dashed span in the middle
      // Rotation is already applied via ctx.rotate(ghostRotRad); always draw horizontal shape.
      const POST = sz * 0.14;
      ctx.setLineDash([]);
      ctx.fillRect(msp.x - ghostW / 2, msp.y - POST / 2, POST, POST);
      ctx.strokeRect(msp.x - ghostW / 2, msp.y - POST / 2, POST, POST);
      ctx.fillRect(msp.x + ghostW / 2 - POST, msp.y - POST / 2, POST, POST);
      ctx.strokeRect(msp.x + ghostW / 2 - POST, msp.y - POST / 2, POST, POST);
      // dashed span lines top + bottom
      ctx.setLineDash([Math.max(2, 3 * zoom), Math.max(2, 2 * zoom)]);
      ctx.beginPath();
      ctx.moveTo(msp.x - ghostW / 2 + POST, msp.y - ghostH / 2);
      ctx.lineTo(msp.x + ghostW / 2 - POST, msp.y - ghostH / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(msp.x - ghostW / 2 + POST, msp.y + ghostH / 2);
      ctx.lineTo(msp.x + ghostW / 2 - POST, msp.y + ghostH / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.beginPath();
      ctx.rect(msp.x - ghostW / 2, msp.y - ghostH / 2, ghostW, ghostH);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Label above the ghost
    const labelY = msp.y - ghostH / 2 - 6;
    ctx.globalAlpha = 1;
    ctx.font = `bold ${Math.max(10, Math.round(12 * zoom))}px Consolas, monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    if (waterBlocked) {
      ctx.fillStyle = '#4488ff';
      ctx.fillText('IN WATER', msp.x, labelY);
    } else if (enemyTerritory) {
      ctx.fillStyle = '#ff3333';
      ctx.fillText('ENEMY FLOOR', msp.x, labelY);
    } else if (blockedByTree) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('BLOCKED', msp.x, labelY);
    } else if (blockedByStructure) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('BLOCKED BY STRUCTURE', msp.x, labelY);
    } else if (overlaps || wallOccupied || doorOccupied) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('OCCUPIED', msp.x, labelY);
    } else if (noDoorFrame) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('NEEDS DOOR FRAME', msp.x, labelY);
    } else if (tooFar) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('TOO FAR', msp.x, labelY);
    } else if (wrongCompany) {
      ctx.fillStyle = '#ff3333';
      ctx.fillText('ENEMY FLOOR', msp.x, labelY);
    } else if (noFloor) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('NEEDS FLOOR', msp.x, labelY);
    } else if (noEdge) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('NEEDS FLOOR EDGE', msp.x, labelY);
    } else {
      ctx.fillStyle = '#aaffaa';
      const label = this.islandBuildKind === 'wooden_floor' ? 'Wooden Floor'
                  : this.islandBuildKind === 'wall' ? 'Wall'
                  : this.islandBuildKind === 'door_frame' ? 'Door Frame'
                  : this.islandBuildKind === 'door' ? 'Door'
                  : 'Workbench';
      ctx.fillText(label, msp.x, labelY);
    }

    ctx.restore();
  }

  private queueWorldObjects(worldState: WorldState, camera: Camera, alpha: number): void {
    // Clear render queue buckets
    for (const b of this.renderBuckets) b.length = 0;

    // Cache local player's company for enemy-coloring this frame (already set at renderWorld entry)
    // this._localCompanyId is updated there; no second find() needed.

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
        this.sinkSplashTimers.delete(id);
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    // ── NPC kill detection ─────────────────────────────────────────────────
    // Build current NPC id set and detect disappearances.
    const currentNpcIds = new Set<number>();
    for (const npc of worldState.npcs) currentNpcIds.add(npc.id);
    for (const id of this.lastKnownNpcIds) {
      if (!currentNpcIds.has(id)) {
        // NPC vanished — find its last known name from the previous frame's NPC list
        // (we keep it in lastKnownShips-style via a name map below).
        const name = this._lastNpcNames.get(id) ?? `Crew ${id}`;
        this.effectRenderer.createAnnouncement(`${name} eliminated`, 'npc_kill');
        this._lastNpcNames.delete(id);
      }
    }
    // Update id set and name map for next frame.
    this.lastKnownNpcIds = currentNpcIds;
    for (const npc of worldState.npcs) this._lastNpcNames.set(npc.id, npc.name);
    // ───────────────────────────────────────────────────────────────────────
    // Emit water-splash bursts for every ship currently in the sink sequence.
    // Burst rate increases from ~1/s at the start to ~4/s near full submersion.
    const nowMs = performance.now();
    for (const [id, sinkStart] of this.sinkTimestamps) {
      const elapsedS = (nowMs - sinkStart) / 1000;
      if (elapsedS > 8) continue;
      // Intensity: ramp from 0.2 at t=0 to 1.0 at t=4s, hold to t=8s
      const intensity = Math.min(1.0, 0.2 + elapsedS / 5);
      // Emission interval: 1000ms at start → 250ms near full sink
      const intervalMs = Math.max(250, 1000 - elapsedS * 100);
      const lastEmit = this.sinkSplashTimers.get(id) ?? 0;
      if (nowMs - lastEmit < intervalMs) continue;
      this.sinkSplashTimers.set(id, nowMs);

      // Resolve world position: prefer live ship, fall back to ghost snapshot
      let shipPos: Vec2 | null = null;
      let shipRot = 0;
      const liveShip = worldState.ships.find(s => s.id === id);
      if (liveShip) { shipPos = liveShip.position; shipRot = liveShip.rotation; }
      else {
        const ghost = this.sinkingGhosts.get(id);
        if (ghost) { shipPos = ghost.position; shipRot = ghost.rotation; }
      }
      if (!shipPos) continue;

      // Emit 2–4 bursts at random positions along the hull waterline
      const burstCount = Math.max(2, Math.round(intensity * 4));
      const cosR = Math.cos(shipRot);
      const sinR = Math.sin(shipRot);
      for (let b = 0; b < burstCount; b++) {
        // Random local X along hull (-260 to 190), sides (+/-90)
        const lx = -260 + Math.random() * 450;
        const side = (Math.random() < 0.5 ? 1 : -1);
        const ly = side * (70 + Math.random() * 20); // near the hull edge
        // Rotate into world space
        const wx = shipPos.x + lx * cosR - ly * sinR;
        const wy = shipPos.y + lx * sinR + ly * cosR;
        this.particleSystem.createSinkSplash(Vec2.from(wx, wy), intensity);
      }
    }
    
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
      // Ghost fog aura: drawn at layer 0.5 (below hull, like water surface wisps)
      if (ship.shipType === SHIP_TYPE_GHOST) {
        this.queueRenderItem(1, `ghost-fog-${ship.id}`, () => this.drawGhostFogAura(ship, camera), -1);
      }
    }
    
    // Queue players (layer 2)
    for (const player of worldState.players) {
      this.queueRenderItem(2, 'players', () => this.drawPlayer(player, worldState, camera));
    }
    
    // Queue ship planks (layer 3 — ghost ships have no physical planks, purely hull-fade driven)
    for (const ship of worldState.ships) {
      if (ship.shipType !== SHIP_TYPE_GHOST) {
        this.queueRenderItem(3, 'ship-planks', () => this.drawShipPlanks(ship, camera));
      }
      // Ghost deck effects (runic circle + crew silhouettes) drawn above planks
      if (ship.shipType === SHIP_TYPE_GHOST) {
        this.queueRenderItem(3, `ghost-deck-${ship.id}`, () => this.drawGhostDeckEffects(ship, camera), 3);
      }
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

    // Burning module fire overlays — drawn above module graphics
    for (const ship of worldState.ships) {
      this.queueRenderItem(4, `fire-modules-${ship.id}`, () => this.drawBurningModules(ship, camera), 5);
    }

    // Ghost placement plan markers — visible in build menu mode, B-key mode, or hotbar build mode
    if (this.ghostPlacements.length > 0 &&
        (this.buildMenuOpen || this.explicitBuildState !== null || this.cannonBuildMode || this.mastBuildMode || this.swivelBuildMode)) {
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
    
    // Queue cannons, swivel guns, and steering wheels (layers 4-6)
    for (const ship of worldState.ships) {
      this.queueRenderItem(4, 'cannons', () => this.drawShipCannons(ship, camera));
      this.queueRenderItem(4, 'swivel-guns', () => this.drawShipSwivelGuns(ship, camera));
      this.queueRenderItem(4, 'cannon-aim-guides', () => this.drawCannonAimGuides(ship, worldState, camera), 1);
      this.queueRenderItem(4, 'swivel-aim-guides', () => this.drawSwivelAimGuide(ship, worldState, camera), 1);
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
    const now = performance.now();
    const liveIds = new Set<number>();
    for (const cb of worldState.cannonballs) liveIds.add(cb.id);
    // Prune trails for cannonballs that no longer exist; spawn water splash for expired ones
    for (const id of this.cannonballTrails.keys()) {
      if (!liveIds.has(id)) {
        this.cannonballTrails.delete(id);
        this.trailLastEmit.delete(id);
      }
    }
    for (const [id, last] of this.cannonballLastPos) {
      if (!liveIds.has(id)) {
        // Ball just disappeared — check if it's over open water (not inside any ship hull)
        const overShip = worldState.ships.some(ship => {
          const dx = last.x - ship.position.x;
          const dy = last.y - ship.position.y;
          return dx * dx + dy * dy < 500 * 500; // covers full brigantine hull (~435px radius) + margin
        });

        // Check if it disappeared near a structure.
        // Pass 1: workbenches (server checks these first — they sit on top of floors)
        // Pass 2: floors (only if no workbench matched)
        // Guard: skip if last position is at origin (never properly updated)
        if (last.x === 0 && last.y === 0) {
          this.cannonballLastPos.delete(id);
          continue;
        }

        const hitStructure =
          this.placedStructures.find(s => {
            if (s.type !== 'workbench') return false;
            const dx = last.x - s.x;
            const dy = last.y - s.y;
            return dx * dx + dy * dy <= 26.5 * 26.5; // broad-phase radius (matches server)
          }) ||
          this.placedStructures.find(s => {
            if (s.type !== 'wooden_floor') return false;
            const dx = last.x - s.x;
            const dy = last.y - s.y;
            return Math.abs(dx) <= 25 && Math.abs(dy) <= 25; // AABB ±25px
          });

        // Check near an island tree
        const hitTree = !hitStructure && this.islands.some(isl =>
          (isl.resources ?? []).some(r => {
            if (r.type !== 'wood') return false;
            const dx = last.x - (isl.x + r.ox);
            const dy = last.y - (isl.y + r.oy);
            return dx * dx + dy * dy <= 22 * 22;
          })
        );

        if (hitStructure || hitTree) {
          const intensity = hitStructure ? 0.6 : 0.5;
          this.particleSystem.createExplosion(Vec2.from(last.x, last.y), intensity);
          if (hitStructure) {
            this.spawnDamageNumber(Vec2.from(last.x, last.y), 25, false);
          }
        } else if (!overShip && (last.ammoType === 0 || last.ammoType === 1)) {
          // Check if over island land → dirt splash; otherwise water splash
          let overLand = false;
          for (const isl of this.islands) {
            if (isl.vertices) {
              let inside = false;
              const verts = isl.vertices;
              const n = verts.length;
              for (let vi = 0, vj = n - 1; vi < n; vj = vi++) {
                const xi = verts[vi].x, yi = verts[vi].y;
                const xj = verts[vj].x, yj = verts[vj].y;
                if ((yi > last.y) !== (yj > last.y) &&
                    last.x < (xj - xi) * (last.y - yi) / (yj - yi) + xi)
                  inside = !inside;
              }
              if (inside) { overLand = true; break; }
            } else {
              const preset = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
              const dx = last.x - isl.x, dy = last.y - isl.y;
              const distSq = dx * dx + dy * dy;
              const broadR = preset.beachRadius + Math.max(...preset.beachBumps.map(Math.abs));
              if (distSq < broadR * broadR) {
                const angle = Math.atan2(dy, dx);
                const TWO_PI = Math.PI * 2;
                const bumps = preset.beachBumps;
                let a = angle % TWO_PI; if (a < 0) a += TWO_PI;
                const t = (a / TWO_PI) * bumps.length;
                const i0 = Math.floor(t) % bumps.length;
                const i1 = (i0 + 1) % bumps.length;
                const narrowR = preset.beachRadius + bumps[i0] + (t - Math.floor(t)) * (bumps[i1] - bumps[i0]);
                if (distSq < narrowR * narrowR) { overLand = true; break; }
              }
            }
          }
          if (overLand) {
            console.log(`💨 DIRT: cannonball ${id} expired over land at (${last.x.toFixed(1)}, ${last.y.toFixed(1)})`);
            this.particleSystem.createDirtSplash(Vec2.from(last.x, last.y), 1.2);
          } else {
            console.log(`💦 SPLASH: cannonball ${id} expired over water at (${last.x.toFixed(1)}, ${last.y.toFixed(1)})`);
            this.particleSystem.createWaterSplash(Vec2.from(last.x, last.y), 1.2);
          }
        } else if (overShip) {
          console.log(`💥 NO SPLASH: cannonball ${id} disappeared near ship at (${last.x.toFixed(1)}, ${last.y.toFixed(1)})`);
        }
        this.cannonballLastPos.delete(id);
      }
    }
    for (const cannonball of worldState.cannonballs) {
      // Update last-known position for splash detection
      this.cannonballLastPos.set(cannonball.id, { x: cannonball.position.x, y: cannonball.position.y, ammoType: cannonball.ammoType });
      // Leave smoke trails for cannonballs (0/1) and spark trails for grapeshot (10 or server type 2)
      if (cannonball.ammoType === 0 || cannonball.ammoType === 1 || cannonball.ammoType === 10 || cannonball.ammoType === 2) {
        const last = this.trailLastEmit.get(cannonball.id) ?? 0;
        if (now - last >= this.TRAIL_SPACING_MS) {
          if (!this.cannonballTrails.has(cannonball.id)) this.cannonballTrails.set(cannonball.id, []);
          this.cannonballTrails.get(cannonball.id)!.push({ x: cannonball.position.x, y: cannonball.position.y, t: now });
          this.trailLastEmit.set(cannonball.id, now);
        }
        // Expire old crumbs
        const trail = this.cannonballTrails.get(cannonball.id);
        if (trail) {
          const cutoff = now - this.TRAIL_DURATION_MS;
          let start = 0;
          while (start < trail.length && trail[start].t < cutoff) start++;
          if (start > 0) trail.splice(0, start);
        }
      }
      this.queueRenderItem(8, 'cannonballs', () => this.drawCannonball(cannonball, camera, worldState));
    }

    // Track last attacker per ship: record when a cannonball is within 150 units of a ship
    // it didn't originate from — used to populate the "sunk by" announcement.
    for (const cb of worldState.cannonballs) {
      for (const ship of worldState.ships) {
        if (ship.id === cb.firedFrom) continue;
        const dx = cb.position.x - ship.position.x;
        const dy = cb.position.y - ship.position.y;
        if (dx * dx + dy * dy < 150 * 150) {
          this.lastAttackerOf.set(ship.id, cb.firedFrom);
        }
      }
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
      this.queueRenderItem(4, `ghost-swivelguns-${id}`, () => this.drawShipSwivelGuns(ghost, camera));
      this.queueRenderItem(4, `ghost-rudder-${id}`,     () => this.drawShipRudder(ghost, camera));
      this.queueRenderItem(5, `ghost-wheels-${id}`,     () => this.drawShipSteeringWheels(ghost, camera));
      this.queueRenderItem(5, `ghost-ladders-${id}`,    () => this.drawShipLadders(ghost, camera));
      this.queueRenderItem(5, `ghost-ropes-${id}`,      () => this.drawShipSailRopes(ghost, camera));
      this.queueRenderItem(6, `ghost-fibers-${id}`,     () => this.drawShipSailFibers(ghost, camera));
      this.queueRenderItem(7, `ghost-masts-${id}`,      () => this.drawShipSailMasts(ghost, camera));
    }
  }
  
  private queueRenderItem(layer: number, layerName: string, renderFn: () => void, priority: number = 0): void {
    const idx = layer < 0 ? 0 : layer;
    this.renderBuckets[idx].push({ layer, layerName, renderFn, priority });
  }
  
  private executeRenderQueue(): void {
    // Iterate pre-allocated layer buckets in order (bucket 0 = layer -1, 1-9 = layers 1-9).
    // Sort within each bucket by priority only — far fewer comparisons than a full-queue sort.
    for (const bucket of this.renderBuckets) {
      if (bucket.length === 0) continue;
      if (bucket.length > 1) bucket.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
      for (const item of bucket) {
        try {
          item.renderFn();
        } catch (error) {
          console.error(`Error rendering ${item.layerName}:`, error);
        }
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

    // Ghost ship: dark spectral hull with cyan edge glow
    const isGhost = ship.shipType === SHIP_TYPE_GHOST;
    if (isGhost) {
      this.ctx.fillStyle   = '#0f0f1a';
      this.ctx.strokeStyle = '#0a0a16';
      this.ctx.shadowColor  = '#00eeff';
      this.ctx.shadowBlur   = 12 / cameraState.zoom;
    }

    // Enemy ship: dark blue hull
    const isEnemy = this._localCompanyId !== 0 && ship.companyId !== 0
      && ship.companyId !== this._localCompanyId;
    if (!isGhost && isEnemy) {
      this.ctx.strokeStyle = '#1a1a4a';
      this.ctx.fillStyle = '#1e3a6e';
    }
    this.ctx.lineWidth = 2 / cameraState.zoom;

    // Ghost hull fades as it takes damage (health 60000→0 maps opacity 1.0→0.2)
    if (isGhost) {
      const healthFade = Math.max(0.2, ship.hullHealth / GHOST_MAX_HULL_HP);
      this.ctx.globalAlpha = phase1Alpha * healthFade;
    }
    
    this.ctx.beginPath();
    this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    
    for (let i = 1; i < ship.hull.length; i++) {
      this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    }
    
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();

    // Ghost ships: add a second thin cyan edge stroke for the spectral glow outline
    if (isGhost) {
      const healthMult = Math.max(0.2, ship.hullHealth / GHOST_MAX_HULL_HP);
      const sinkMult   = phase1Alpha < 1 ? phase1Alpha : 1;
      this.ctx.shadowBlur   = 0;
      this.ctx.strokeStyle  = `rgba(0,230,255,${0.55 * sinkMult * healthMult})`;
      this.ctx.lineWidth    = 1.5 / cameraState.zoom;
      this.ctx.beginPath();
      this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
      for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
      this.ctx.closePath();
      this.ctx.stroke();
    }

    // Water flood tint: blue overlay (non-ghost), cyan mist dissolve (ghost)
    // Ghost mist begins at 75% HP (25% damage) and reaches full intensity at 0 HP
    const ghostMistAlpha = isGhost ? Math.max(0, (1 - ship.hullHealth / GHOST_MAX_HULL_HP) - 0.25) / 0.75 : 0;
    if (isGhost ? ghostMistAlpha > 0 : floodTint > 0) {
      if (isGhost) {
        // Ghost dissolve: cyan/teal mist, starts from 75% HP
        const sinkMult = phase1Alpha < 1 ? phase1Alpha : 1;
        this.ctx.globalAlpha = ghostMistAlpha * 0.75 * sinkMult;
        this.ctx.fillStyle = '#00eeff';
        this.ctx.shadowColor = '#00eeff';
        this.ctx.shadowBlur  = 16 / cameraState.zoom;
      } else {
        this.ctx.globalAlpha = floodTint * 0.55 * (phase1Alpha < 1 ? phase1Alpha : 1);
        this.ctx.fillStyle = '#1a6eb5';
      }
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

    const isGhostShip = ship.shipType === SHIP_TYPE_GHOST;
    
    this.ctx.save();
    // Ghost planks fade with hull damage (full opacity 0.45 at 60000 HP → 0.05 at 0 HP)
    const ghostHealthFade = isGhostShip ? Math.max(0.1, ship.hullHealth / GHOST_MAX_HULL_HP) : 1;
    const baseAlpha = isGhostShip ? Math.min(phase1Alpha, 0.45) * ghostHealthFade : phase1Alpha;
    if (baseAlpha < 1) this.ctx.globalAlpha = baseAlpha;
    
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
      // Ghost planks: dark semi-transparent with cyan tinge; pulsed by health
      const fillColor   = isGhostShip
        ? this.darkenByDamage('#1a2a3a', healthRatio)
        : this.darkenByDamage('#8B7355', healthRatio);
      const strokeColor = isGhostShip
        ? this.darkenByDamage('#003055', healthRatio)
        : this.darkenByDamage('#4A3020', healthRatio);

      if (isGhostShip) {
        this.ctx.shadowColor = '#00eeff';
        this.ctx.shadowBlur  = 3;
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
   * Draw animated fire overlays on burning wooden modules (plank, deck, mast).
   * Each module has a set of stable fire-point positions in ship-local space
   * (generated once on first draw, min-distance spaced so they do not clump).
   */
  private _fireDbgLastLog = 0;
  private drawBurningModules(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 300)) return;
    const cosR = Math.cos(ship.rotation);
    const sinR = Math.sin(ship.rotation);
    const zoom = camera.getState().zoom;

    // Throttled diagnostic — logs once per 3s if any burning entities exist
    const now = performance.now();
    if (this.burningEntities.size > 0 && now - this._fireDbgLastLog > 3000) {
      this._fireDbgLastLog = now;
      const woodenMods = ship.modules.filter(m => WOODEN_KINDS.has(m.kind));
      const burningKeys = [...this.burningEntities.keys()];
      console.log(`[FIRE DBG] ship=${ship.id} burningEntities=${[...burningKeys]} woodenMods=${woodenMods.map(m => m.kind+':'+m.id)}`);
    }

    for (const mod of ship.modules) {
      if (!WOODEN_KINDS.has(mod.kind)) continue;
      if (!this.isBurning('module', mod.id, ship.id, mod.id)) continue;

      const key = `module:${ship.id}:${mod.id}`;
      // Generate and cache stable local-space fire positions for this module
      if (!this.moduleFirePoints.has(key)) {
        this.moduleFirePoints.set(key, this.generateModuleFirePoints(mod));
      }
      const firePts = this.moduleFirePoints.get(key)!;

      // Deck: extract active zone bits (bits 11-13) and draw zone overlays
      const isDeck = mod.kind === 'deck';
      const zoneBits = isDeck ? (mod.stateBits ?? 0) : 0;
      const zone0 = isDeck && (zoneBits & (1 << 11)) !== 0; // bow  (+80 to +240)
      const zone1 = isDeck && (zoneBits & (1 << 12)) !== 0; // mid  (-80 to +80)
      const zone2 = isDeck && (zoneBits & (1 << 13)) !== 0; // stern(-240 to -80)

      if (isDeck && (zone0 || zone1 || zone2)) {
        this.drawDeckZoneOverlays(ship, cosR, sinR, zone0, zone1, zone2, zoom, camera);
      }

      for (const pt of firePts) {
        // Zone filtering for deck: only render fire in active zones
        if (isDeck) {
          const inZ0 = pt.lx > 80;
          const inZ1 = pt.lx >= -80 && pt.lx <= 80;
          const inZ2 = pt.lx < -80;
          if (inZ0 && !zone0) continue;
          if (inZ1 && !zone1) continue;
          if (inZ2 && !zone2) continue;
        }

        const wx = ship.position.x + pt.lx * cosR - pt.ly * sinR;
        const wy = ship.position.y + pt.lx * sinR + pt.ly * cosR;
        const screen = camera.worldToScreen(Vec2.from(wx, wy));
        const screenR = Math.max(8, pt.r * zoom);
        this.ctx.save();
        this.drawFireOverlay(screen.x, screen.y, screenR);
        this.ctx.restore();
      }
    }
  }

  /** Draw per-zone heat overlays and divider lines for a burning deck. */
  private drawDeckZoneOverlays(
    ship: Ship, cosR: number, sinR: number,
    zone0: boolean, zone1: boolean, zone2: boolean,
    zoom: number, camera: Camera
  ): void {
    // Each zone: 160 units wide, deck ~110 units tall (ly ±55)
    // Zone 0 = bow  lx [80, 240], Zone 1 = mid lx [-80, 80], Zone 2 = stern lx [-240, -80]
    const zoneDefs: Array<{ lxMin: number; lxMax: number; active: boolean }> = [
      { lxMin:  80, lxMax:  240, active: zone0 },
      { lxMin: -80, lxMax:   80, active: zone1 },
      { lxMin: -240, lxMax: -80, active: zone2 },
    ];

    const HALF_H = 55; // half-height of deck in local units

    for (const zone of zoneDefs) {
      if (!zone.active) continue;
      // Draw a semi-transparent heat tint over the zone (4 corners → polygon)
      // Corners in ship-local space
      const corners: Array<[number, number]> = [
        [zone.lxMin, -HALF_H],
        [zone.lxMax, -HALF_H],
        [zone.lxMax,  HALF_H],
        [zone.lxMin,  HALF_H],
      ];
      const screenCorners = corners.map(([lx, ly]) => {
        const wx = ship.position.x + lx * cosR - ly * sinR;
        const wy = ship.position.y + lx * sinR + ly * cosR;
        return camera.worldToScreen(Vec2.from(wx, wy));
      });

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.moveTo(screenCorners[0].x, screenCorners[0].y);
      for (let i = 1; i < screenCorners.length; i++) {
        this.ctx.lineTo(screenCorners[i].x, screenCorners[i].y);
      }
      this.ctx.closePath();
      this.ctx.fillStyle = 'rgba(255, 80, 0, 0.12)';
      this.ctx.fill();
      this.ctx.restore();
    }

    // Zone divider lines at lx = +80 and lx = -80
    const dividers: Array<{ lx: number; show: boolean }> = [
      { lx:  80, show: zone0 || zone1 },
      { lx: -80, show: zone1 || zone2 },
    ];
    for (const div of dividers) {
      if (!div.show) continue;
      const top = camera.worldToScreen(Vec2.from(
        ship.position.x + div.lx * cosR - (-HALF_H) * sinR,
        ship.position.y + div.lx * sinR + (-HALF_H) * cosR,
      ));
      const bot = camera.worldToScreen(Vec2.from(
        ship.position.x + div.lx * cosR - HALF_H * sinR,
        ship.position.y + div.lx * sinR + HALF_H * cosR,
      ));
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.moveTo(top.x, top.y);
      this.ctx.lineTo(bot.x, bot.y);
      this.ctx.strokeStyle = 'rgba(255, 120, 0, 0.65)';
      this.ctx.lineWidth = Math.max(1, 1.5 * zoom);
      this.ctx.setLineDash([4 * zoom, 3 * zoom]);
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  /**
   * Generate a stable set of fire-point positions in ship-local space for a burning module.
   * Points are spaced at least MIN_FIRE_DIST world-units apart.
   *
   * - deck  → grid of points across the deck polygon / default bounds
   * - plank → 1–4 points along the plank span or curve
   * - mast  → single point at localPos
   */
  private generateModuleFirePoints(mod: ShipModule): Array<{lx: number; ly: number; r: number}> {
    const MIN_DIST = 30; // world-unit minimum spacing between fire points
    const points: Array<{lx: number; ly: number; r: number}> = [];

    // Deterministic per-module PRNG (LCG) — same layout every time for the same module
    let seed = (mod.id * 2654435761) >>> 0;
    const rand = (): number => {
      seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
      return seed / 0x100000000;
    };

    const tryAdd = (lx: number, ly: number, r: number): boolean => {
      for (const p of points) {
        const dx = p.lx - lx, dy = p.ly - ly;
        if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) return false;
      }
      points.push({ lx, ly, r });
      return true;
    };

    if (mod.kind === 'deck') {
      // Sample a grid across the deck polygon; fall back to the default hull footprint
      const data = mod.moduleData as any;
      const area: Vec2[] | undefined = data?.area;
      let minX = -220, minY = -48, maxX = 220, maxY = 48;
      if (area && area.length > 2) {
        minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
        for (const v of area) {
          if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
        }
      }
      const spacing = MIN_DIST * 1.05;
      for (let lx = minX + spacing * 0.55; lx < maxX; lx += spacing) {
        for (let ly = minY + spacing * 0.55; ly < maxY; ly += spacing) {
          // Jitter so the grid does not look artificial
          const jx = lx + (rand() - 0.5) * spacing * 0.55;
          const jy = ly + (rand() - 0.5) * spacing * 0.55;
          const pt = Vec2.from(jx, jy);
          if (area && area.length > 2 && !PolygonUtils.pointInPolygon(pt, area)) continue;
          tryAdd(jx, jy, 15);
        }
      }
      // Guarantee at least a few visible points
      if (points.length < 3) {
        tryAdd(0, 0, 15);
        tryAdd(-55, 0, 15);
        tryAdd(55, 0, 15);
      }

    } else if (mod.kind === 'plank') {
      const pd = mod.moduleData as PlankModuleData;
      const lx0 = mod.localPos?.x ?? 0;
      const ly0 = mod.localPos?.y ?? 0;
      if (pd?.isCurved && pd.curveData) {
        // Sample along the bezier curve at t1, midpoint, and t2
        const { start, control, end, t1, t2 } = pd.curveData;
        const tSamples = [t1, (t1 + t2) / 2, t2];
        for (const t of tSamples) {
          const bx = (1-t)*(1-t)*start.x + 2*(1-t)*t*control.x + t*t*end.x;
          const by = (1-t)*(1-t)*start.y + 2*(1-t)*t*control.y + t*t*end.y;
          tryAdd(bx, by, 16);
        }
      } else {
        const len = pd?.length ?? 40;
        const cos = Math.cos(mod.localRot ?? 0);
        const sin = Math.sin(mod.localRot ?? 0);
        const nPts = Math.max(1, Math.min(4, Math.round(len / MIN_DIST)));
        for (let i = 0; i < nPts; i++) {
          const f = nPts === 1 ? 0 : i / (nPts - 1) - 0.5;
          tryAdd(lx0 + cos * len * f, ly0 + sin * len * f, 16);
        }
      }

    } else if (mod.kind === 'mast') {
      tryAdd(mod.localPos?.x ?? 0, mod.localPos?.y ?? 0, 18);
    }

    return points;
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

      const presentIds = new Set<number>();
      for (const m of ship.modules) presentIds.add(m.id);

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

    const presentIds = new Set<number>();
    for (const m of ship.modules) presentIds.add(m.id);

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

      const presentIds = new Set<number>();
      for (const m of ship.modules) presentIds.add(m.id);

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

    const presentIds = new Set<number>();
    for (const m of ship.modules) presentIds.add(m.id);

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
    
    const isPhantomBrig = ship.shipType === SHIP_TYPE_GHOST;

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

      if (isPhantomBrig) {
        // ── Phantom Brig spectral cannon ────────────────────────────────────
        const t = performance.now() / 1000;
        const pulse = 0.55 + 0.45 * Math.sin(t * 2.2 + x * 0.05 + y * 0.05);
        const glowAlpha = 0.5 + 0.5 * pulse;

        // Void-dark base with cyan glow
        this.ctx.shadowColor = `rgba(0,220,190,${glowAlpha * 0.9})`;
        this.ctx.shadowBlur = 10 / cameraState.zoom;
        this.ctx.fillStyle = '#060f0d';
        this.ctx.strokeStyle = `rgba(0,200,180,${glowAlpha})`;
        this.ctx.lineWidth = lineWidth * 1.5;
        this.ctx.fillRect(-15, -10, 30, 20);
        this.ctx.strokeRect(-15, -10, 30, 20);

        // Spectral barrel
        this.ctx.save();
        this.ctx.rotate(turretAngle);
        this.ctx.shadowColor = `rgba(0,240,200,${glowAlpha})`;
        this.ctx.shadowBlur = 8 / cameraState.zoom;
        this.ctx.fillStyle = `rgba(0,30,25,${0.85 + 0.15 * pulse})`;
        this.ctx.strokeStyle = `rgba(0,210,185,${glowAlpha})`;
        this.ctx.lineWidth = lineWidth * 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(-6, 0);
        this.ctx.lineTo(-6, -42);
        this.ctx.lineTo(6, -42);
        this.ctx.lineTo(6, 0);
        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.stroke();
        // Muzzle glow ring
        this.ctx.beginPath();
        this.ctx.arc(0, -42, 5, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(0,220,190,${glowAlpha * 0.6})`;
        this.ctx.shadowBlur = 12 / cameraState.zoom;
        this.ctx.fill();
        this.ctx.restore();

        this.ctx.shadowColor = 'transparent';
        this.ctx.shadowBlur = 0;
      } else {
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
      } // end normal cannon

      // Restore cannon position
      this.ctx.restore();
    }
    
    this.ctx.restore();
  }

  /**
   * Draw swivel guns — small, fast-reload anti-personnel weapons on ship edges.
   * Visual: circular pivot base + short rotating barrel.
   */
  private drawShipSwivelGuns(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const { phase2Alpha } = this.computeSinkState(ship);
    if (phase2Alpha <= 0) return;

    this.ctx.save();
    if (phase2Alpha < 1) this.ctx.globalAlpha = phase2Alpha;

    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();

    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const swivels = ship.modules.filter(m => m.kind === 'swivel');

    for (const swivel of swivels) {
      // Use moduleData if present; fall back to safe defaults so newly-placed swivels always render
      const swivelData = (swivel.moduleData?.kind === 'swivel') ? swivel.moduleData : null;

      const x = swivel.localPos.x;
      const y = swivel.localPos.y;
      const turretAngle = swivelData?.aimDirection ?? 0;
      const localRot = swivel.localRot || 0;
      const healthRatio = swivelData ? Math.max(0, swivelData.health / (swivelData.maxHealth || 4000)) : 1;
      const lineWidth = 1 / cameraState.zoom;

      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(localRot);

      // Pivot base — small circle
      this.ctx.beginPath();
      this.ctx.arc(0, 0, 8, 0, Math.PI * 2);
      this.ctx.fillStyle = this.darkenByDamage('#5C3A1E', healthRatio);
      this.ctx.strokeStyle = '#000000';
      this.ctx.lineWidth = lineWidth;
      this.ctx.fill();
      this.ctx.stroke();

      // Rotating barrel
      this.ctx.save();
      this.ctx.rotate(turretAngle);
      this.ctx.fillStyle = this.darkenByDamage('#2a2a2a', healthRatio);
      this.ctx.strokeStyle = '#000000';
      this.ctx.lineWidth = lineWidth;
      this.ctx.fillRect(-3, 0, 6, -22);   // Short barrel: 6 wide, 22 long
      this.ctx.strokeRect(-3, 0, 6, -22);
      this.ctx.restore();

      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /**
   * Draw aim guide for a swivel gun the local player is currently mounted to.
   * Shows: a short dashed trajectory line, and a ±45° arc indicating the rotation limits.
   */
  private drawSwivelAimGuide(ship: Ship, worldState: WorldState, camera: Camera): void {
    if (!this.playerIsAiming) return;
    if (!camera.isWorldPositionVisible(ship.position, 200)) return;

    const localPlayer = this._cachedLocalPlayer;
    if (!localPlayer || !localPlayer.isMounted || localPlayer.carrierId !== ship.id) return;
    if (localPlayer.mountedModuleId == null) return;

    const mountedMod = ship.modules.find(m => m.id === localPlayer.mountedModuleId);
    if (!mountedMod || mountedMod.kind !== 'swivel') return;

    const swivelData = (mountedMod.moduleData?.kind === 'swivel') ? mountedMod.moduleData : null;
    const localRot = mountedMod.localRot || 0;

    // Client-predicted aim: mirror server formula (desired_offset = aim - localRot + PI/2),
    // clamped to ±45°.  This gives zero-lag visual feedback instead of waiting for a
    // server round-trip to update swivelData.aimDirection.
    const SWIVEL_LIMIT = 45 * Math.PI / 180;
    let predictedAimDir = this.playerAimAngleRelative - localRot + Math.PI / 2;
    while (predictedAimDir >  Math.PI) predictedAimDir -= 2 * Math.PI;
    while (predictedAimDir < -Math.PI) predictedAimDir += 2 * Math.PI;
    predictedAimDir = Math.max(-SWIVEL_LIMIT, Math.min(SWIVEL_LIMIT, predictedAimDir));
    const aimDir = predictedAimDir;

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    // Move to swivel position and apply its base rotation
    this.ctx.translate(mountedMod.localPos.x, mountedMod.localPos.y);
    this.ctx.rotate(localRot);

    const BARREL_TIP = 22;    // px from pivot to barrel tip
    const RANGE      = 200;   // swivel effective range in client units
    const LIMIT_RAD  = 45 * Math.PI / 180;

    // ── ±45° arc (limit indicators) ──────────────────────────────────────
    // The barrel's natural direction in local swivel frame = -π/2 (straight up before rotation)
    // arc centred on natural barrel direction = angle 0 in the post-localRot frame
    const arcCentreAngle = -Math.PI / 2; // straight "out" in swivel local space
    this.ctx.beginPath();
    this.ctx.arc(0, 0, BARREL_TIP + 6, arcCentreAngle - LIMIT_RAD, arcCentreAngle + LIMIT_RAD);
    this.ctx.strokeStyle = 'rgba(255,120,40,0.35)';
    this.ctx.lineWidth = 1 / cameraState.zoom;
    this.ctx.stroke();

    // ── Barrel trajectory / area overlay (ammo-specific) ─────────────────
    const barrelAngle = arcCentreAngle + aimDir;
    const cosB = Math.cos(barrelAngle);
    const sinB = Math.sin(barrelAngle);
    // Barrel tip in swivel-local space
    const tipX = cosB * BARREL_TIP;
    const tipY = sinB * BARREL_TIP;

    // Normalise ammo ID: 10/2=grapeshot, 11/3=flame, 12/4=canister
    const ammo = this.selectedAmmoType;
    const ammoNorm = ammo === 10 ? 10 : ammo === 2 ? 10
                   : ammo === 11 ? 11 : ammo === 3 ? 11
                   : ammo === 12 ? 12 : ammo === 4 ? 12
                   : ammo; // pass-through for cannon types

    if (ammoNorm === 10) {
      // ── Grapeshot: ±12° hit cone centred on barrel tip, 250px range ─────
      const GRAPE_RANGE = 250;
      const SPREAD      = 12 * Math.PI / 180;
      const leftA  = barrelAngle - SPREAD;
      const rightA = barrelAngle + SPREAD;

      this.ctx.save();
      this.ctx.translate(tipX, tipY);

      // Filled wedge
      this.ctx.beginPath();
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(Math.cos(leftA) * GRAPE_RANGE, Math.sin(leftA) * GRAPE_RANGE);
      this.ctx.arc(0, 0, GRAPE_RANGE, leftA, rightA);
      this.ctx.closePath();
      this.ctx.fillStyle = 'rgba(255,200,80,0.07)';
      this.ctx.fill();

      // Cone outline edges
      this.ctx.strokeStyle = 'rgba(255,200,80,0.55)';
      this.ctx.lineWidth = 1 / cameraState.zoom;
      this.ctx.setLineDash([4 / cameraState.zoom, 3 / cameraState.zoom]);
      this.ctx.beginPath();
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(Math.cos(leftA) * GRAPE_RANGE, Math.sin(leftA) * GRAPE_RANGE);
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(Math.cos(rightA) * GRAPE_RANGE, Math.sin(rightA) * GRAPE_RANGE);
      this.ctx.stroke();

      // Solid arc at max range
      this.ctx.setLineDash([]);
      this.ctx.globalAlpha = 0.30;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, GRAPE_RANGE, leftA, rightA);
      this.ctx.stroke();
      this.ctx.globalAlpha = 1.0;

      // Centre aim line (solid, bright)
      this.ctx.strokeStyle = 'rgba(255,220,100,0.75)';
      this.ctx.lineWidth = 1.5 / cameraState.zoom;
      this.ctx.setLineDash([5 / cameraState.zoom, 4 / cameraState.zoom]);
      this.ctx.beginPath();
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(cosB * GRAPE_RANGE, sinB * GRAPE_RANGE);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.restore();

    } else if (ammoNorm === 11) {
      // ── Liquid Flame: ±15° cone centred on barrel tip, 280px range ──────
      const FLAME_RANGE = 280;
      const SPREAD      = 15 * Math.PI / 180;
      const leftA  = barrelAngle - SPREAD;
      const rightA = barrelAngle + SPREAD;

      this.ctx.save();
      this.ctx.translate(tipX, tipY);

      // Filled wedge — orange/flame tint
      this.ctx.beginPath();
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(Math.cos(leftA) * FLAME_RANGE, Math.sin(leftA) * FLAME_RANGE);
      this.ctx.arc(0, 0, FLAME_RANGE, leftA, rightA);
      this.ctx.closePath();
      this.ctx.fillStyle = 'rgba(255,100,0,0.08)';
      this.ctx.fill();

      // Cone edges (dashed, flame orange)
      this.ctx.strokeStyle = 'rgba(255,120,0,0.55)';
      this.ctx.lineWidth = 1 / cameraState.zoom;
      this.ctx.setLineDash([3 / cameraState.zoom, 3 / cameraState.zoom]);
      this.ctx.beginPath();
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(Math.cos(leftA) * FLAME_RANGE, Math.sin(leftA) * FLAME_RANGE);
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(Math.cos(rightA) * FLAME_RANGE, Math.sin(rightA) * FLAME_RANGE);
      this.ctx.stroke();

      // Solid arc at max range
      this.ctx.setLineDash([]);
      this.ctx.globalAlpha = 0.28;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, FLAME_RANGE, leftA, rightA);
      this.ctx.stroke();
      this.ctx.globalAlpha = 1.0;

      // Centre aim line — thin solid, shorter than cannon lines
      this.ctx.strokeStyle = 'rgba(255,160,0,0.80)';
      this.ctx.lineWidth = 1 / cameraState.zoom;
      this.ctx.setLineDash([4 / cameraState.zoom, 3 / cameraState.zoom]);
      this.ctx.beginPath();
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(cosB * FLAME_RANGE, sinB * FLAME_RANGE);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.restore();

    } else {
      // ── Default / canister: simple dashed trajectory line ────────────────
      this.ctx.save();
      this.ctx.setLineDash([5 / cameraState.zoom, 4 / cameraState.zoom]);
      this.ctx.strokeStyle = 'rgba(255,200,80,0.85)';
      this.ctx.lineWidth = 1.5 / cameraState.zoom;
      this.ctx.beginPath();
      this.ctx.moveTo(tipX, tipY);
      this.ctx.lineTo(cosB * (BARREL_TIP + RANGE), sinB * (BARREL_TIP + RANGE));
      this.ctx.stroke();
      this.ctx.setLineDash([]);
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
      if (mod.kind !== 'cannon' && mod.kind !== 'swivel') continue;
      const info = cannonGroupMap.get(mod.id);
      const lx = mod.localPos.x;
      const ly = mod.localPos.y;
      const lr = (mod as { localRot?: number }).localRot ?? 0;

      // Decide visibility:
      //  • weapon in an active group    → always visible (bright highlight)
      //  • weapon in a non-active group → only visible when Shift is held
      //  • unassigned weapon             → only visible when Shift is held
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

    // Use frame-cached local player (set once in renderWorld).
    const localPlayer = this._cachedLocalPlayer;

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

        // Build the set of cannon IDs that belong to an active weapon group.
        // Only cannons in a selected group show trajectory lines.
        const activeCannonIds = new Set<number>();
        if (this.controlGroups) {
          this.controlGroups.forEach((state, g) => {
            if (this.activeWeaponGroups.has(g)) {
              for (const id of state.cannonIds) activeCannonIds.add(id);
            }
          });
        }

        for (const m of ship.modules) {
          if (m.kind !== 'cannon' && m.kind !== 'swivel') continue;
          // Only show trajectory for weapons in an active weapon group
          if (!activeCannonIds.has(m.id)) continue;
          // Angular offset from cannon's natural axis (server convention)
          let offset = aim - (m.localRot || 0) + Math.PI / 2;
          // Normalize to [-π, π]
          while (offset >  Math.PI) offset -= 2 * Math.PI;
          while (offset < -Math.PI) offset += 2 * Math.PI;
          const absOffset = Math.abs(offset);
          if (absOffset > CANNON_LIMIT_RAD + FADE_RAD) continue; // beyond 45° — skip
          const hasNpc    = shipNpcs.some(n => n.assignedWeaponId === m.id && n.state === NPC_STATE_AT_GUN);
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
      // ── Swivel: draw ammo-appropriate aim cone / line from helm ──────────
      if (cannon.kind === 'swivel') {
        const SWIVEL_LIMIT = 45 * Math.PI / 180;
        const localRot = cannon.localRot || 0;
        let predictedAimDir = this.playerAimAngleRelative - localRot + Math.PI / 2;
        while (predictedAimDir >  Math.PI) predictedAimDir -= 2 * Math.PI;
        while (predictedAimDir < -Math.PI) predictedAimDir += 2 * Math.PI;
        predictedAimDir = Math.max(-SWIVEL_LIMIT, Math.min(SWIVEL_LIMIT, predictedAimDir));

        const BARREL_TIP = 22;
        const sx = cannon.localPos.x;
        const sy = cannon.localPos.y;
        // Barrel direction in ship-local space: localRot sets the "natural out" axis at -π/2
        const barrelAngle = localRot - Math.PI / 2 + predictedAimDir;
        const cosB = Math.cos(barrelAngle);
        const sinB = Math.sin(barrelAngle);
        const tipX = sx + cosB * BARREL_TIP;
        const tipY = sy + sinB * BARREL_TIP;

        const ammo = this.selectedAmmoType;
        const ammoNorm = (ammo === 10 || ammo === 2) ? 10
                       : (ammo === 11 || ammo === 3) ? 11
                       : 12; // canister / default

        this.ctx.save();
        this.ctx.globalAlpha = fadeAlpha;

        // ±45° rotation-limit arc centred on the swivel pivot
        this.ctx.save();
        this.ctx.translate(sx, sy);
        const arcCentre = localRot - Math.PI / 2;
        const LIMIT_RAD = 45 * Math.PI / 180;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, BARREL_TIP + 6, arcCentre - LIMIT_RAD, arcCentre + LIMIT_RAD);
        this.ctx.strokeStyle = 'rgba(255,120,40,0.35)';
        this.ctx.lineWidth = 1 / cameraState.zoom;
        this.ctx.stroke();
        this.ctx.restore();

        if (ammoNorm === 10) {
          // Grapeshot: ±12° cone, 250px range
          const GRAPE_RANGE = 250;
          const SPREAD = 12 * Math.PI / 180;
          const leftA  = barrelAngle - SPREAD;
          const rightA = barrelAngle + SPREAD;
          this.ctx.save();
          this.ctx.translate(tipX, tipY);
          // Filled wedge
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Math.cos(leftA) * GRAPE_RANGE, Math.sin(leftA) * GRAPE_RANGE);
          this.ctx.arc(0, 0, GRAPE_RANGE, leftA, rightA);
          this.ctx.closePath();
          this.ctx.fillStyle = 'rgba(255,200,80,0.07)';
          this.ctx.fill();
          // Dashed edges
          this.ctx.strokeStyle = 'rgba(255,200,80,0.55)';
          this.ctx.lineWidth = 1 / cameraState.zoom;
          this.ctx.setLineDash([4 / cameraState.zoom, 3 / cameraState.zoom]);
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Math.cos(leftA) * GRAPE_RANGE, Math.sin(leftA) * GRAPE_RANGE);
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Math.cos(rightA) * GRAPE_RANGE, Math.sin(rightA) * GRAPE_RANGE);
          this.ctx.stroke();
          // Faint arc at max range
          this.ctx.setLineDash([]);
          this.ctx.globalAlpha = 0.30 * fadeAlpha;
          this.ctx.beginPath();
          this.ctx.arc(0, 0, GRAPE_RANGE, leftA, rightA);
          this.ctx.stroke();
          this.ctx.globalAlpha = fadeAlpha;
          // Centre aim line
          this.ctx.strokeStyle = 'rgba(255,220,100,0.75)';
          this.ctx.lineWidth = 1.5 / cameraState.zoom;
          this.ctx.setLineDash([5 / cameraState.zoom, 4 / cameraState.zoom]);
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(cosB * GRAPE_RANGE, sinB * GRAPE_RANGE);
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          this.ctx.restore();

        } else if (ammoNorm === 11) {
          // Liquid flame: ±15° cone, 200px range
          const FLAME_RANGE = 280;
          const SPREAD = 15 * Math.PI / 180;
          const leftA  = barrelAngle - SPREAD;
          const rightA = barrelAngle + SPREAD;
          this.ctx.save();
          this.ctx.translate(tipX, tipY);
          // Filled wedge
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Math.cos(leftA) * FLAME_RANGE, Math.sin(leftA) * FLAME_RANGE);
          this.ctx.arc(0, 0, FLAME_RANGE, leftA, rightA);
          this.ctx.closePath();
          this.ctx.fillStyle = 'rgba(255,100,0,0.08)';
          this.ctx.fill();
          // Dashed edges
          this.ctx.strokeStyle = 'rgba(255,120,0,0.55)';
          this.ctx.lineWidth = 1 / cameraState.zoom;
          this.ctx.setLineDash([3 / cameraState.zoom, 3 / cameraState.zoom]);
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Math.cos(leftA) * FLAME_RANGE, Math.sin(leftA) * FLAME_RANGE);
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(Math.cos(rightA) * FLAME_RANGE, Math.sin(rightA) * FLAME_RANGE);
          this.ctx.stroke();
          // Faint arc at max range
          this.ctx.setLineDash([]);
          this.ctx.globalAlpha = 0.28 * fadeAlpha;
          this.ctx.beginPath();
          this.ctx.arc(0, 0, FLAME_RANGE, leftA, rightA);
          this.ctx.stroke();
          this.ctx.globalAlpha = fadeAlpha;
          // Centre aim line
          this.ctx.strokeStyle = 'rgba(255,160,0,0.80)';
          this.ctx.lineWidth = 1 / cameraState.zoom;
          this.ctx.setLineDash([4 / cameraState.zoom, 3 / cameraState.zoom]);
          this.ctx.beginPath();
          this.ctx.moveTo(0, 0);
          this.ctx.lineTo(cosB * FLAME_RANGE, sinB * FLAME_RANGE);
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          this.ctx.restore();

        } else {
          // Canister / default: simple dashed line
          this.ctx.save();
          this.ctx.strokeStyle = 'rgba(255,200,80,0.85)';
          this.ctx.lineWidth = 1.5 / cameraState.zoom;
          this.ctx.setLineDash([5 / cameraState.zoom, 4 / cameraState.zoom]);
          this.ctx.beginPath();
          this.ctx.moveTo(tipX, tipY);
          this.ctx.lineTo(tipX + cosB * 200, tipY + sinB * 200);
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          this.ctx.restore();
        }

        this.ctx.restore();
        continue;
      }

      if (!cannon.moduleData || cannon.moduleData.kind !== 'cannon') continue;
      const cannonData = cannon.moduleData;

      // Client-predicted aim direction — mirrors the server formula so the guide
      // tracks the mouse instantly rather than waiting for a round-trip.
      // Formula: desired_offset = playerAimAngleRelative - localRot + PI/2
      const CANNON_LIMIT = 30 * Math.PI / 180;
      let predictedAimDir = this.playerAimAngleRelative - (cannon.localRot || 0) + Math.PI / 2;
      while (predictedAimDir >  Math.PI) predictedAimDir -= 2 * Math.PI;
      while (predictedAimDir < -Math.PI) predictedAimDir += 2 * Math.PI;
      predictedAimDir = Math.max(-CANNON_LIMIT, Math.min(CANNON_LIMIT, predictedAimDir));

      const totalAngle = (cannon.localRot || 0) + predictedAimDir;
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
      const isExtended = (ladder.moduleData as any)?.extended !== false; // default to extended if unknown

      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(rot);

      if (isExtended) {
        // --- Extended ladder: wooden frame with rungs ---
        const lw = 20; // total width
        const lh = 40; // total height
        const railW = 3;
        const rungCount = 4;

        // Side rails (dark brown)
        this.ctx.fillStyle = '#5C3A1E';
        this.ctx.fillRect(-lw / 2, -lh / 2, railW, lh);           // left rail
        this.ctx.fillRect(lw / 2 - railW, -lh / 2, railW, lh);    // right rail

        // Rungs (lighter tan wood)
        this.ctx.fillStyle = '#8B5E3C';
        const rungH = 3;
        const rungSpacing = lh / (rungCount + 1);
        for (let i = 1; i <= rungCount; i++) {
          const ry = -lh / 2 + i * rungSpacing - rungH / 2;
          this.ctx.fillRect(-lw / 2 + railW, ry, lw - railW * 2, rungH);
        }

        // Thin outline
        this.ctx.strokeStyle = '#3A2010';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(-lw / 2, -lh / 2, lw, lh);
      } else {
        // --- Retracted ladder: flat stowed plank, grey-brown, narrow ---
        this.ctx.fillStyle = '#6B5040';
        this.ctx.fillRect(-10, -6, 20, 12);
        this.ctx.strokeStyle = '#3A2010';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(-10, -6, 20, 12);
        // Small diagonal lines to suggest folded/stowed state
        this.ctx.strokeStyle = '#4A3020';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(-7, -4); this.ctx.lineTo( 7,  4);
        this.ctx.moveTo(-7,  4); this.ctx.lineTo( 7, -4);
        this.ctx.stroke();
      }

      this.ctx.restore();
    }
    
    this.ctx.restore();
  }
  
  // ─── Ghost Ship FX ────────────────────────────────────────────────────────

  /**
   * Draw ghostly runic circle on deck + 3 translucent crew silhouettes that
   * fade in and out asynchronously.
   */
  private drawGhostDeckEffects(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 300)) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const ctx         = this.ctx;
    const screenPos   = camera.worldToScreen(ship.position);
    const cs          = camera.getState();
    const t           = performance.now() / 1000;

    ctx.save();
    ctx.globalAlpha = phase1Alpha;
    ctx.translate(screenPos.x, screenPos.y);
    ctx.scale(cs.zoom, cs.zoom);
    ctx.rotate(ship.rotation - cs.rotation);

    // ── Runic circle pulsing glow ─────────────────────────────────────────
    const pulse  = 0.4 + 0.35 * Math.sin(t * 1.8);
    const rotate = t * 0.22; // slow rotation
    const circleR = 55;

    // Outer haze
    ctx.save();
    ctx.rotate(rotate);
    const hazeGrd = ctx.createRadialGradient(0, 0, circleR * 0.55, 0, 0, circleR * 1.4);
    hazeGrd.addColorStop(0,   `rgba(0,230,255,${(pulse * 0.30).toFixed(3)})`);
    hazeGrd.addColorStop(1,   'rgba(0,100,160,0)');
    ctx.fillStyle = hazeGrd;
    ctx.beginPath();
    ctx.arc(0, 0, circleR * 1.4, 0, Math.PI * 2);
    ctx.fill();

    // Circle stroke
    ctx.strokeStyle = `rgba(0,220,255,${(pulse * 0.80).toFixed(3)})`;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = '#00eeff';
    ctx.shadowBlur  = 6;
    ctx.beginPath();
    ctx.arc(0, 0, circleR, 0, Math.PI * 2);
    ctx.stroke();

    // 5 rune tick marks around the ring
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const ix    = Math.cos(angle) * circleR;
      const iy    = Math.sin(angle) * circleR;
      const ox    = Math.cos(angle) * (circleR - 12);
      const oy    = Math.sin(angle) * (circleR - 12);
      ctx.strokeStyle = `rgba(0,200,255,${(pulse * 0.70).toFixed(3)})`;
      ctx.lineWidth   = 1.0;
      ctx.beginPath();
      ctx.moveTo(ix, iy);
      ctx.lineTo(ox, oy);
      ctx.stroke();
    }
    ctx.restore();

    // ── Ghost crew silhouettes ────────────────────────────────────────────
    // 3 "figures" at staggered positions along the deck centreline.
    // Each fades in/out with a different phase offset.
    const crewPositions = [
      { x: 60,  y: 0,  phase: 0.0 },
      { x: -40, y: 20, phase: 1.8 },
      { x: -40, y: -20, phase: 3.2 },
    ];
    for (const crew of crewPositions) {
      const alpha = Math.max(0, 0.15 + 0.35 * Math.sin(t * 1.1 + crew.phase));

      ctx.save();
      ctx.translate(crew.x, crew.y);
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = '#a0e8ff';
      ctx.shadowColor = '#00eeff';
      ctx.shadowBlur  = 8;

      // Body (torso + head silhouette)
      ctx.beginPath();
      ctx.ellipse(0, -12, 5, 10, 0, 0, Math.PI * 2); // torso
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, -24, 5, 0, Math.PI * 2);              // head
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Draw wispy fog/mist aura around the ghost ship hull edges + stern whisps.
   */
  private drawGhostFogAura(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, 300)) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const ctx       = this.ctx;
    const screenPos = camera.worldToScreen(ship.position);
    const cs        = camera.getState();
    const t         = performance.now() / 1000;

    ctx.save();
    ctx.globalAlpha = phase1Alpha;
    ctx.translate(screenPos.x, screenPos.y);
    ctx.scale(cs.zoom, cs.zoom);
    ctx.rotate(ship.rotation - cs.rotation);

    // 8 mist puffs at hull-edge positions: bow, stern, two amidships port/stbd
    const mistPositions = [
      { x:  280, y:   0, r: 45 },   // bow
      { x: -330, y:   0, r: 40 },   // stern
      { x:   80, y:  80, r: 35 },   // fore-port
      { x:   80, y: -80, r: 35 },   // fore-stbd
      { x:  -80, y:  80, r: 35 },   // aft-port
      { x:  -80, y: -80, r: 35 },   // aft-stbd
      { x: -170, y:  55, r: 30 },   // far-aft-port
      { x: -170, y: -55, r: 30 },   // far-aft-stbd
    ];

    for (let i = 0; i < mistPositions.length; i++) {
      const mp    = mistPositions[i];
      const drift = Math.sin(t * 0.7 + i * 1.2) * 8; // gentle drift
      const alpha = 0.08 + 0.08 * Math.sin(t * 0.9 + i * 0.8);

      const grd = ctx.createRadialGradient(mp.x, mp.y + drift, 2, mp.x, mp.y + drift, mp.r);
      grd.addColorStop(0,   `rgba(180,240,255,${alpha.toFixed(3)})`);
      grd.addColorStop(0.4, `rgba(100,200,240,${(alpha * 0.55).toFixed(3)})`);
      grd.addColorStop(1,   'rgba(0,150,200,0)');

      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(mp.x, mp.y + drift, mp.r, mp.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Trailing mist wake — cyan wisps stretching behind the stern
    for (let i = 0; i < 4; i++) {
      const wx    = -350 - i * 60;
      const wdrift = Math.sin(t * 0.6 + i * 2.0) * 12;
      const alpha  = Math.max(0, 0.12 - i * 0.025) * (0.5 + 0.5 * Math.sin(t * 0.5 + i));

      const wgrd = ctx.createRadialGradient(wx, wdrift, 0, wx, wdrift, 30 + i * 10);
      wgrd.addColorStop(0,   `rgba(120,220,255,${alpha.toFixed(3)})`);
      wgrd.addColorStop(1,   'rgba(0,120,180,0)');

      ctx.fillStyle = wgrd;
      ctx.beginPath();
      ctx.ellipse(wx, wdrift, 30 + i * 10, 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
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

      // ── Phantom Brig: spectral shroud sails instead of normal cloth ──
      if (ship.shipType === SHIP_TYPE_GHOST) {
        this.drawPhantomSail(x, y, mastData.sailWidth, mastData.height, mast.id);
        continue;
      }

      const width = mastData.sailWidth;
      const height = mastData.height;
      const sailColor = mastData.sailColor;
      const angle = mastData.angle; // Sail angle in degrees
      
      // Use sail cloth HP (fiberHealth) for visual degradation, not mast pole HP
      const healthRatio = mastData.fiberMaxHealth > 0 ? mastData.fiberHealth / mastData.fiberMaxHealth : 1;
      const fireIntensity = mastData.sailFireIntensity ?? 0;
      this.drawSailFiber(x, y, width, height, sailColor, mastData.openness / 100, angle, healthRatio, mast.id, fireIntensity);
      
    }
    
    this.ctx.restore();
  }
  
  /**
   * Spectral shroud sails for the Phantom Brig.
   * Called inside drawShipSailFibers, inheriting the ship-level canvas transform.
   * Wind angle is ignored — sails billow from spectral energy alone.
   */
  private drawPhantomSail(x: number, y: number, width: number, height: number, mastId: number): void {
    const now   = Date.now();
    const t     = now * 0.001;
    const phase = mastId * 2.17;

    // Gentle supernatural billow — no wind angle, slight side-to-side sway
    const billow = Math.sin(t * 0.85 + phase) * 10;

    const sailTopY = -height * 1.4;
    const sailBotY = -sailTopY;
    const halfW    = width * 0.5;

    // Build seeded-random torn bottom edge
    let mseed = (mastId * 2654435761) >>> 0;
    const mrand = () => { mseed = (mseed * 1664525 + 1013904223) >>> 0; return mseed / 0xFFFFFFFF; };
    const tearCount = 9;
    const tearX: number[] = [];
    const tearY: number[] = [];
    for (let i = 0; i <= tearCount; i++) {
      tearX.push(-halfW + (i / tearCount) * width);
      tearY.push(sailBotY - mrand() * 28 - 4);
    }

    this.ctx.save();
    this.ctx.translate(x, y);

    // Build clip path (outline of sail)
    const buildPath = () => {
      this.ctx.beginPath();
      this.ctx.moveTo(-halfW, sailTopY);
      this.ctx.lineTo(halfW, sailTopY);
      this.ctx.quadraticCurveTo(halfW + billow * 0.7, 0, tearX[tearCount], tearY[tearCount]);
      for (let i = tearCount - 1; i >= 0; i--) {
        this.ctx.lineTo(tearX[i], tearY[i]);
      }
      this.ctx.quadraticCurveTo(-halfW + billow * 0.3, 0, -halfW, sailTopY);
      this.ctx.closePath();
    };

    // ── Outer glow pass ──
    this.ctx.shadowColor = '#00ddcc';
    this.ctx.shadowBlur  = 16;
    buildPath();
    this.ctx.strokeStyle = `rgba(0,210,200,${0.45 + 0.15 * Math.sin(t * 1.6 + phase)})`;
    this.ctx.lineWidth   = 1.5;
    this.ctx.stroke();
    this.ctx.shadowBlur = 0;

    // ── Cloth fill — dark void-teal gradient ──
    const pulse = 0.52 + 0.13 * Math.sin(t * 1.3 + phase);
    const grad  = this.ctx.createLinearGradient(-halfW, sailTopY, halfW, sailBotY);
    grad.addColorStop(0,   `rgba(0, 55, 45, ${pulse})`);
    grad.addColorStop(0.45,`rgba(0, 32, 26, ${pulse * 0.85})`);
    grad.addColorStop(1,   `rgba(0, 14, 11, ${pulse * 0.65})`);
    buildPath();
    this.ctx.fillStyle = grad;
    this.ctx.fill();

    // ── Spectral vein lines through the sail cloth ──
    this.ctx.save();
    buildPath();
    this.ctx.clip();
    const veinCount = 3;
    for (let v = 0; v < veinCount; v++) {
      const vx     = -halfW * 0.55 + v * (halfW * 0.55);
      const vAlpha = 0.28 + 0.18 * Math.sin(t * 2.1 + v * 1.5 + phase);
      this.ctx.shadowColor  = '#00ffee';
      this.ctx.shadowBlur   = 5;
      this.ctx.strokeStyle  = `rgba(0, 230, 215, ${vAlpha})`;
      this.ctx.lineWidth    = 0.9;
      this.ctx.beginPath();
      this.ctx.moveTo(vx, sailTopY + 4);
      this.ctx.quadraticCurveTo(vx + billow * 0.35, 0, vx + billow * 0.15, sailBotY - 18);
      this.ctx.stroke();
    }
    this.ctx.restore();

    // ── Yard (horizontal boom at top) ──
    this.ctx.shadowColor = '#00ccbb';
    this.ctx.shadowBlur  = 6;
    this.ctx.strokeStyle = '#1a4a40';
    this.ctx.lineWidth   = 2.5;
    this.ctx.beginPath();
    this.ctx.moveTo(-halfW - 6, sailTopY);
    this.ctx.lineTo(halfW  + 6, sailTopY);
    this.ctx.stroke();
    this.ctx.shadowBlur = 0;

    this.ctx.restore();
  }

  private drawSailFiber(x: number, y: number, width: number, height: number, sailColor: string, openness: number, angle: number, healthRatio: number = 1, moduleId: number = 0, fireIntensity: number = 0): void {
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
    // Fire factor: 0 = not burning, 1 = fully engulfed
    const fireFactor = Math.min(1, (fireIntensity ?? 0) / 100);

    let centerRgb = lerpColor(hexToRgb(sailColor), grey, damage);
    let edgeRgb   = lerpColor(hexToRgb('#E6E6E6'), grey, damage);
    if (fireFactor > 0) {
      // Shift sail cloth colour toward orange-red as intensity rises
      const fireCore: [number, number, number] = [255, 60,  0];
      const fireEdge: [number, number, number] = [255, 190, 20];
      centerRgb = lerpColor(hexToRgb(centerRgb), fireCore, fireFactor * 0.55);
      edgeRgb   = lerpColor(hexToRgb(edgeRgb),   fireEdge, fireFactor * 0.38);
    }
    const centerColor = centerRgb;
    const edgeColor   = edgeRgb;

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

      // ── Pulsing fire overlay on the sail cloth ──
      if (fireFactor > 0 && openness > 0) {
        const now     = Date.now();
        const flicker = 0.7 + 0.3 * (Math.sin(now * 0.009) * 0.5 + 0.5);
        this.ctx.save();
        this.ctx.globalAlpha = fireFactor * 0.30 * flicker * sailAlpha;
        this.ctx.beginPath();
        this.ctx.moveTo(0, sailTopY);
        this.ctx.lineTo(0, -sailTopY);
        this.ctx.quadraticCurveTo(sailPower + 25, 0, 0, sailTopY);
        this.ctx.clip();
        const fireGrad = this.ctx.createLinearGradient(0, sailTopY, 0, 0);
        fireGrad.addColorStop(0,   `rgba(255,${Math.floor(60 * (1 - fireFactor * 0.8))},0,1)`);
        fireGrad.addColorStop(0.5, 'rgba(255,120,0,0.7)');
        fireGrad.addColorStop(1,   'rgba(255,200,0,0)');
        this.ctx.fillStyle = fireGrad;
        this.ctx.fillRect(-width, sailTopY, width * 2.5 + sailPower, -sailTopY * 2);
        this.ctx.restore();
      }
    }

    // ── Animated flame licks along the burning sail ──
    if (fireFactor > 0 && openness > 0 && clampedHealth > 0.02) {
      const now        = Date.now();
      const flicker    = 0.7 + 0.3 * (Math.sin(now * 0.009) * 0.5 + 0.5);
      const flameCount = Math.max(3, Math.round(fireFactor * 7));
      let fseed = ((moduleId * 6364136) ^ 0xdeadbeef) >>> 0;
      const flcg  = (): number => { fseed = (fseed * 6364136 + 1442695041) >>> 0; return fseed / 0xFFFFFFFF; };
      this.ctx.save();
      for (let i = 0; i < flameCount; i++) {
        const phase   = flcg() * Math.PI * 2;
        const baseT   = (i + 0.5) / flameCount;
        const baseY   = sailTopY + baseT * (-sailTopY * 2.0);
        const wobbleX = Math.sin(now * 0.008 + phase) * 9 * fireFactor;
        const px      = sailPower * baseT * 0.55 + wobbleX;
        const flameH  = (12 + flcg() * 22) * fireFactor;
        const flameW  = (5  + flcg() * 10) * fireFactor;
        const alpha   = (0.55 + 0.35 * flicker) * fireFactor * sailAlpha;
        const innerG  = Math.floor(240 * (1 - fireFactor * 0.7));
        const fGrad   = this.ctx.createRadialGradient(px, baseY - flameH * 0.35, 0, px, baseY, flameW * 1.5);
        fGrad.addColorStop(0,   `rgba(255,${innerG},60,${alpha})`);
        fGrad.addColorStop(0.5, `rgba(255,80,0,${(alpha * 0.65).toFixed(3)})`);
        fGrad.addColorStop(1,   'rgba(180,20,0,0)');
        this.ctx.beginPath();
        this.ctx.ellipse(px, baseY - flameH * 0.5, flameW, flameH, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = fGrad;
        this.ctx.fill();
      }
      this.ctx.restore();
    }

    // ── Horizontal yard (always visible — holds the sail even when cloth is shredded) ──
    this.ctx.fillStyle = '#8B4513';
    this.ctx.strokeStyle = '#654321';
    this.ctx.fillRect(-width / 20, sailTopY, width / 10, -sailTopY * 2);
    this.ctx.strokeRect(-width / 20, sailTopY, width / 10, -sailTopY * 2);

    // ── Rising smoke wisps at medium–high fire intensity ──
    if (fireFactor > 0.3 && openness > 0) {
      const now    = Date.now();
      const wCount = Math.max(1, Math.floor(fireFactor * 4));
      let wseed = ((moduleId * 22695477) ^ 0x6c62272e) >>> 0;
      const wlcg = (): number => { wseed = (wseed * 22695477 + 1) >>> 0; return wseed / 0xFFFFFFFF; };
      this.ctx.save();
      for (let i = 0; i < wCount; i++) {
        const phase   = wlcg() * Math.PI * 2;
        const baseX   = (wlcg() - 0.5) * sailPower * 0.7;
        const drift   = Math.sin(now * 0.004 + phase) * 10;
        const tOff    = (now * 0.04 + i * 30) % 70;      // each wisp cycles 0→70
        const wispY   = sailTopY - 8 - tOff;
        const fadeT   = tOff / 70;
        const wAlpha  = (1 - fadeT) * 0.18 * fireFactor;
        const wRadius = 6 + i * 3 + fadeT * 8;
        this.ctx.beginPath();
        this.ctx.ellipse(baseX + drift, wispY, wRadius * 0.7, wRadius, Math.PI * 0.15, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(70,65,65,${wAlpha.toFixed(3)})`;
        this.ctx.fill();
      }
      this.ctx.restore();
    }

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

      if (ship.shipType === SHIP_TYPE_GHOST) {
        // Dark phantom mast — ebony pole with cyan glow
        this.ctx.shadowColor = '#00ccbb';
        this.ctx.shadowBlur  = 8;
        this.ctx.fillStyle   = '#0d1a18';
        this.ctx.strokeStyle = `rgba(0,200,185,${0.55 + 0.2 * Math.sin(Date.now() * 0.002 + x)})`;
        this.ctx.lineWidth   = 1.5 / cameraState.zoom;
        this.ctx.beginPath();
        this.ctx.arc(x, y, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
        continue;
      }
      
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

    // Damage flash — red overlay that fades out over 300 ms
    const _pFlashAt = this.playerDamageFlash.get(player.id);
    if (_pFlashAt !== undefined) {
      const _pFlashElapsed = performance.now() - _pFlashAt;
      const PLAYER_FLASH_MS = 300;
      if (_pFlashElapsed < PLAYER_FLASH_MS) {
        this.ctx.fillStyle = `rgba(255,40,40,${((1 - _pFlashElapsed / PLAYER_FLASH_MS) * 0.65).toFixed(3)})`;
        this.ctx.beginPath();
        this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, 0, Math.PI * 2);
        this.ctx.fill();
      } else {
        this.playerDamageFlash.delete(player.id);
      }
    }

    // Fire overlay — animated flames when burning
    if (this.isBurning('player', player.id)) {
      this.drawFireOverlay(screenPos.x, screenPos.y, scaledRadius * 1.6);
    }
    
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
  
  private drawCannonball(cannonball: Cannonball, camera: Camera, worldState?: WorldState): void {
    if (!camera.isWorldPositionVisible(cannonball.position, 20)) return;

    const screenPos = camera.worldToScreen(cannonball.position);
    const zoom      = camera.getState().zoom;
    const now       = performance.now();

    // Determine if this projectile was fired from a ghost ship
    const firedFromGhost = worldState
      ? (worldState.ships.find(s => s.id === cannonball.firedFrom)?.shipType === SHIP_TYPE_GHOST)
      : false;

    // ── Smoke trail (cannonball & bar shot only) ───────────────────────────
    if (cannonball.ammoType === 0 || cannonball.ammoType === 1) {
      const isBarShot = cannonball.ammoType === 1;
      const trail = this.cannonballTrails.get(cannonball.id);
      if (trail && trail.length > 1) {
        this.ctx.save();
        for (let i = 0; i < trail.length; i++) {
          const crumb = trail[i];
          const age   = (now - crumb.t) / this.TRAIL_DURATION_MS; // 0=fresh … 1=gone
          if (age >= 1) continue;
          const ease   = 1 - age * age; // quadratic — stays full longer, drops off at end
          // Bar shot: thinner, more transparent, no dark core
          const alpha  = ease * (isBarShot ? 0.32 : 0.72);
          const radius = Math.max(1, ease * (isBarShot ? 4.5 : 9) * zoom);
          const sp     = camera.worldToScreen(Vec2.from(crumb.x, crumb.y));
          // Ghost: spectral green-cyan trail; normal: light grey smoke
          this.ctx.globalAlpha = alpha;
          this.ctx.fillStyle   = firedFromGhost ? '#00ff88' : '#c8c8c8';
          this.ctx.beginPath();
          this.ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
          this.ctx.fill();
          // Ghost: glowing core; normal: black powder dark core (cannonball only, fresh crumbs)
          if (!isBarShot && age < 0.35) {
            const coreAlpha  = (0.35 - age) / 0.35 * 0.55;
            const coreRadius = radius * 0.45;
            this.ctx.globalAlpha = coreAlpha;
            this.ctx.fillStyle   = firedFromGhost ? '#00ddaa' : '#3a3a3a';
            this.ctx.beginPath();
            this.ctx.arc(sp.x, sp.y, coreRadius, 0, Math.PI * 2);
            this.ctx.fill();
          }
        }
        this.ctx.globalAlpha = 1.0;
        this.ctx.restore();
      }
    }

    if (cannonball.ammoType === 10) {
      // ── Grapeshot pellet ───────────────────────────────────────────────────
      // Hot iron pellet — fast, close-range, anti-personnel.
      // Spark trail: white-hot crumbs cooling through orange → deep red.
      const GRAPE_TRAIL_MS = 200;
      const trail = this.cannonballTrails.get(cannonball.id);
      if (trail && trail.length > 1) {
        this.ctx.save();
        for (let i = 0; i < trail.length; i++) {
          const crumb = trail[i];
          const age   = (now - crumb.t) / GRAPE_TRAIL_MS;
          if (age >= 1) continue;
          const ease   = 1 - age * age;
          const alpha  = ease * 0.90;
          const radius = Math.max(0.5, ease * 3 * zoom);
          const sp = camera.worldToScreen(Vec2.from(crumb.x, crumb.y));
          const color = age < 0.20 ? '#ffffc0'    // white-hot
                      : age < 0.45 ? '#ff9420'    // orange
                      : '#cc3300';               // deep red
          this.ctx.globalAlpha = alpha;
          this.ctx.fillStyle   = color;
          this.ctx.beginPath();
          this.ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
          this.ctx.fill();
        }
        this.ctx.globalAlpha = 1.0;
        this.ctx.restore();
      }

      // Motion blur streak along velocity direction
      const vx = cannonball.velocity.x;
      const vy = cannonball.velocity.y;
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > 0.1) {
        const angle     = Math.atan2(vy, vx);
        const streakLen = Math.max(4, Math.min(14, speed * 0.08)) * zoom;
        const streakW   = Math.max(1, 1.8 * zoom);
        this.ctx.save();
        this.ctx.translate(screenPos.x, screenPos.y);
        this.ctx.rotate(angle);
        const streakGrd = this.ctx.createLinearGradient(streakLen * 0.5, 0, -streakLen * 1.2, 0);
        streakGrd.addColorStop(0,   'rgba(255,220,80,0.85)');
        streakGrd.addColorStop(0.4, 'rgba(255,100,0,0.55)');
        streakGrd.addColorStop(1,   'rgba(180,30,0,0)');
        this.ctx.fillStyle = streakGrd;
        this.ctx.beginPath();
        this.ctx.ellipse(-streakLen * 0.35, 0, streakLen, streakW, 0, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.restore();
      }

      // Rim glow — orange halo around pellet
      const r = Math.max(2, 3 * zoom);
      this.ctx.globalAlpha = 0.50;
      const rimGrd = this.ctx.createRadialGradient(screenPos.x, screenPos.y, r * 0.6, screenPos.x, screenPos.y, r * 2.4);
      rimGrd.addColorStop(0,   'rgba(255,160,0,0.55)');
      rimGrd.addColorStop(1,   'rgba(200,50,0,0)');
      this.ctx.fillStyle = rimGrd;
      this.ctx.beginPath();
      this.ctx.arc(screenPos.x, screenPos.y, r * 2.4, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.globalAlpha = 1.0;

      // Pellet core: radial gradient — white-hot centre → burnt dark brown rim
      const coreGrd = this.ctx.createRadialGradient(
        screenPos.x - r * 0.25, screenPos.y - r * 0.25, r * 0.05,
        screenPos.x, screenPos.y, r
      );
      coreGrd.addColorStop(0,   '#ffffff');
      coreGrd.addColorStop(0.3, '#ffcc44');
      coreGrd.addColorStop(0.6, '#cc5500');
      coreGrd.addColorStop(1,   '#3a1800');
      this.ctx.fillStyle = coreGrd;
      this.ctx.beginPath();
      this.ctx.arc(screenPos.x, screenPos.y, r, 0, Math.PI * 2);
      this.ctx.fill();
    } else if (cannonball.ammoType === 1) {
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
    } else if (cannonball.ammoType === 11 || cannonball.ammoType === 3) {
      // ── Liquid Flame (Flamethrower) ─────────────────────────────────────────
      // Elongated flame jet oriented along the velocity vector.
      const ctx     = this.ctx;
      const t       = performance.now() / 1000;
      const flicker = 0.88 + 0.12 * Math.sin(t * 14 + cannonball.id * 1.7);

      // Travel angle — use velocity direction; fallback to 0 if stopped
      const vx    = cannonball.velocity.x;
      const vy    = cannonball.velocity.y;
      const angle = (Math.abs(vx) + Math.abs(vy) > 0.01) ? Math.atan2(vy, vx) : 0;

      // Jet dimensions scale with zoom and flicker
      const jetLen = Math.max(8, 18 * zoom) * flicker;  // along travel axis
      const jetW   = Math.max(3,  6 * zoom) * flicker;  // perpendicular width

      ctx.save();
      ctx.translate(screenPos.x, screenPos.y);
      ctx.rotate(angle);
      // In local space: +x = forward (travel direction), origin = projectile centre

      // Outer atmospheric haze — wide, intense orange bloom
      const hazeGrd = ctx.createRadialGradient(-jetLen * 0.1, 0, 0, -jetLen * 0.1, 0, jetLen * 2.2);
      hazeGrd.addColorStop(0,   `rgba(255,180,30,${(0.55 * flicker).toFixed(3)})`);
      hazeGrd.addColorStop(0.35,`rgba(230,80,10,${(0.38 * flicker).toFixed(3)})`);
      hazeGrd.addColorStop(0.7, `rgba(160,20,0,${(0.20 * flicker).toFixed(3)})`);
      hazeGrd.addColorStop(1,   'rgba(80,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(0, 0, jetLen * 2.2, jetW * 2.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = hazeGrd;
      ctx.fill();

      // Main jet body — bold linear gradient from white-hot tip to deep red tail
      const jetGrd = ctx.createLinearGradient(jetLen * 0.95, 0, -jetLen * 0.6, 0);
      jetGrd.addColorStop(0,    `rgba(255,255,220,${(1.0  * flicker).toFixed(3)})`);
      jetGrd.addColorStop(0.15, `rgba(255,230,60,${(0.95 * flicker).toFixed(3)})`);
      jetGrd.addColorStop(0.45, `rgba(255,110,0,${(0.80 * flicker).toFixed(3)})`);
      jetGrd.addColorStop(0.75, `rgba(200,30,0,${(0.55 * flicker).toFixed(3)})`);
      jetGrd.addColorStop(1,    'rgba(120,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(0, 0, jetLen * 1.15, jetW * 1.1, 0, 0, Math.PI * 2);
      ctx.fillStyle = jetGrd;
      ctx.fill();

      // Secondary narrower core for depth
      const coreGrd2 = ctx.createLinearGradient(jetLen * 0.9, 0, -jetLen * 0.2, 0);
      coreGrd2.addColorStop(0,   `rgba(255,255,255,${(0.85 * flicker).toFixed(3)})`);
      coreGrd2.addColorStop(0.3, `rgba(255,230,120,${(0.70 * flicker).toFixed(3)})`);
      coreGrd2.addColorStop(1,   'rgba(255,80,0,0)');
      ctx.beginPath();
      ctx.ellipse(jetLen * 0.15, 0, jetLen * 0.75, jetW * 0.50, 0, 0, Math.PI * 2);
      ctx.fillStyle = coreGrd2;
      ctx.fill();

      // Inner blazing white-hot spot right at the muzzle tip
      const wf = 0.92 + 0.08 * Math.sin(t * 26 + cannonball.id * 3.1);
      ctx.beginPath();
      ctx.ellipse(jetLen * 0.55, 0, jetLen * 0.28, jetW * 0.32, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${(wf).toFixed(3)})`;
      ctx.fill();

      ctx.restore();

      // Ember particle trail (world-space, behind the projectile)
      this.particleSystem.createFlameTrail(cannonball.position, angle);
    } else if (cannonball.ammoType === 12 || cannonball.ammoType === 4) {
      // ── Canister Shot pellet ───────────────────────────────────────────────
      // Wider spread than grapeshot — slightly larger, darker iron pellet.
      const r = Math.max(2, 3.5 * zoom);
      this.ctx.fillStyle = '#4A3728';
      this.ctx.beginPath();
      this.ctx.arc(screenPos.x, screenPos.y, r, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = '#7A5C47';
      this.ctx.lineWidth = 0.6;
      this.ctx.stroke();
    } else {
      // ── Cannonball (default) ───────────────────────────────────────────────
      const scaledRadius = cannonball.radius * zoom;
      if (firedFromGhost) {
        // Ghost projectile: glowing green-cyan ball
        const t = performance.now() / 1000;
        const flicker = 0.85 + 0.15 * Math.sin(t * 12 + cannonball.id * 2.3);
        const r = Math.max(3, scaledRadius * 1.4);
        // Outer glow
        const grd = this.ctx.createRadialGradient(screenPos.x, screenPos.y, 0, screenPos.x, screenPos.y, r * 2.5);
        grd.addColorStop(0,   `rgba(0,255,160,${(0.65 * flicker).toFixed(3)})`);
        grd.addColorStop(0.4, `rgba(0,200,120,${(0.35 * flicker).toFixed(3)})`);
        grd.addColorStop(1,   'rgba(0,100,80,0)');
        this.ctx.fillStyle = grd;
        this.ctx.beginPath();
        this.ctx.arc(screenPos.x, screenPos.y, r * 2.5, 0, Math.PI * 2);
        this.ctx.fill();
        // Ball core
        this.ctx.fillStyle = `rgba(0,255,180,${flicker.toFixed(3)})`;
        this.ctx.beginPath();
        this.ctx.arc(screenPos.x, screenPos.y, r, 0, Math.PI * 2);
        this.ctx.fill();
      } else {
        this.ctx.fillStyle = '#000000';
        this.ctx.beginPath();
        this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, 0, Math.PI * 2);
        this.ctx.fill();
      }
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

    // Colour NPC by company then task assignment (darkened via globalAlpha when moving)
    const npcTask = this.npcTaskMap.get(npc.id) ?? 'Idle';
    const _npcIsEnemy   = this._localCompanyId !== 0 && npc.companyId !== 0 && npc.companyId !== this._localCompanyId;
    const _npcIsNeutral = npc.companyId === COMPANY_NEUTRAL;
    this.ctx.fillStyle = _npcIsNeutral ? '#222222' : _npcIsEnemy ? '#cc2222' : (NPC_TASK_COLORS[npcTask] ?? '#DAA520');
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, radius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();

    // Damage flash — red overlay that fades out over 300 ms
    const _nFlashAt = this.npcDamageFlash.get(npc.id);
    if (_nFlashAt !== undefined) {
      const _nFlashElapsed = performance.now() - _nFlashAt;
      const NPC_FLASH_MS = 300;
      if (_nFlashElapsed < NPC_FLASH_MS) {
        this.ctx.fillStyle = `rgba(255,40,40,${((1 - _nFlashElapsed / NPC_FLASH_MS) * 0.65).toFixed(3)})`;
        this.ctx.beginPath();
        this.ctx.arc(screenPos.x, screenPos.y, radius, 0, Math.PI * 2);
        this.ctx.fill();
      } else {
        this.npcDamageFlash.delete(npc.id);
      }
    }

    // Fire overlay — animated flames when burning
    if (this.isBurning('npc', npc.id)) {
      this.drawFireOverlay(screenPos.x, screenPos.y, radius * 1.6);
    }

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

      // Lock badge — small padlock icon above the NPC when task_locked
      if (npc.locked) {
        const lockSize = Math.max(8, Math.min(12, 10 * cameraState.zoom));
        const lx = screenPos.x + radius - 2;
        const ly = screenPos.y - radius - lockSize;
        this.ctx.fillStyle = '#ffdd00';
        this.ctx.strokeStyle = '#222';
        this.ctx.lineWidth = 1;
        this.ctx.font = `bold ${lockSize + 2}px Arial`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';
        this.ctx.fillText('🔒', lx, ly);
      }

      // Debug: show assigned cannon/module ID and state below name
      if (npc.assignedWeaponId || npc.state !== 0) {
        const STATE_SHORT: Record<number, string> = { 0: 'IDL', 1: 'MOV', 2: 'MAN', 3: 'REP' };
        const ROLE_SHORT: Record<number, string> = { 0: '-', 1: 'G', 2: 'H', 3: 'R', 4: 'P' };
        const debugLabel = `${ROLE_SHORT[npc.role] ?? '?'}:${STATE_SHORT[npc.state] ?? '?'}`
          + (npc.assignedWeaponId ? ` c${npc.assignedWeaponId}` : '');
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

    const ctx  = this.ctx;
    const zoom = camera.getState().zoom;

    // ── Ship bounding circles (broad-phase, server = 435px client radius) ───
    const SHIP_BOUNDING_R = 435; // matches sim_create_brigantine bounding_radius
    for (const ship of worldState.ships) {
      const sc = camera.worldToScreen(ship.position);
      ctx.save();
      ctx.strokeStyle = 'rgba(0,220,255,0.55)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, SHIP_BOUNDING_R * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0,220,255,0.85)';
      ctx.font = `${11}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`ship#${ship.id} broad`, sc.x, sc.y - SHIP_BOUNDING_R * zoom - 4);
      ctx.restore();
    }

    // ── Island physics bodies ────────────────────────────────────────────────
    // Helper: sample the bumpy boundary at a given angle (mirrors island_boundary_r on server)
    const sampleBoundary = (baseR: number, bumps: number[], angle: number): number => {
      const TWO_PI = Math.PI * 2;
      const n      = bumps.length;
      let   a      = angle % TWO_PI;
      if (a < 0) a += TWO_PI;
      const t  = (a / TWO_PI) * n;
      const i0 = Math.floor(t) % n;
      const i1 = (i0 + 1) % n;
      const f  = t - Math.floor(t);
      return baseR + bumps[i0] + f * (bumps[i1] - bumps[i0]);
    };

    const drawBumpyPolygon = (cx: number, cy: number, baseR: number, bumps: number[], segments = 64) => {
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const r     = sampleBoundary(baseR, bumps, angle);
        const sx    = cx + Math.cos(angle) * r * zoom;
        const sy    = cy + Math.sin(angle) * r * zoom;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
    };

    for (const isl of this.islands) {
      const preset  = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
      const { beachRadius, grassRadius, beachBumps, grassBumps } = preset;
      const beachMaxBump = Math.max(...beachBumps.map(Math.abs));
      const grassMaxBump = Math.max(...grassBumps.map(Math.abs));
      const sc = camera.worldToScreen(Vec2.from(isl.x, isl.y));

      // Beach broad-phase circle (dashed yellow) — beachRadius + maxBump
      ctx.save();
      ctx.strokeStyle = 'rgba(255,220,0,0.45)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, (beachRadius + beachMaxBump) * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Beach narrow-phase bumpy polygon (red-orange, solid) — ship collision boundary
      ctx.save();
      ctx.strokeStyle = 'rgba(255,80,0,0.85)';
      ctx.lineWidth   = 2;
      drawBumpyPolygon(sc.x, sc.y, beachRadius, beachBumps);
      ctx.stroke();
      ctx.restore();

      // Grass narrow-phase bumpy polygon (green, solid) — player walk zone
      ctx.save();
      ctx.strokeStyle = 'rgba(80,220,80,0.85)';
      ctx.lineWidth   = 2;
      drawBumpyPolygon(sc.x, sc.y, grassRadius, grassBumps);
      ctx.stroke();
      ctx.restore();

      // Grass broad-phase circle (dashed green) — grassRadius + maxBump
      ctx.save();
      ctx.strokeStyle = 'rgba(80,220,80,0.35)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, (grassRadius + grassMaxBump) * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Island centre cross + label
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(sc.x - 8, sc.y); ctx.lineTo(sc.x + 8, sc.y);
      ctx.moveTo(sc.x, sc.y - 8); ctx.lineTo(sc.x, sc.y + 8);
      ctx.stroke();
      ctx.fillStyle    = 'rgba(255,255,255,0.9)';
      ctx.font         = '11px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        `island#${isl.id} (${isl.preset}) beach:${beachRadius}+${beachMaxBump} grass:${grassRadius}+${grassMaxBump}`,
        sc.x, sc.y - (beachRadius + beachMaxBump) * zoom - 4,
      );
      ctx.restore();
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

  /** Returns the NPC currently under the cursor (null if none). */
  getHoveredNpc(): Npc | null { return this.hoveredNpc; }

  /**
   * Detect whether the cursor is over a foreign ship's hull (polygon hit test).
   * Sets hoveredShip; cleared when over own ship or no ship.
   */
  private detectHoveredShip(worldState: WorldState): void {
    this.hoveredShip = null;
    if (!this.mouseWorldPos) return;
    // Don't show hull tooltip when a module or NPC is already hovered
    if (this.hoveredModule || this.hoveredNpc) return;

    // Determine the local player's current ship (use frame cache set in renderWorld)
    const localPlayer = this._cachedLocalPlayer;
    const ownShipId = localPlayer?.carrierId ?? -1;

    // Ray-cast point-in-polygon helper (ship-local space)
    const pointInPolygon = (px: number, py: number, poly: Vec2[]): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    };

    for (const ship of worldState.ships) {
      if (ship.id === ownShipId) continue;
      if (!ship.hull || ship.hull.length < 3) continue;
      // Transform mouse to ship-local coordinates
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (pointInPolygon(lx, ly, ship.hull)) {
        this.hoveredShip = ship;
        break;
      }
    }
  }

  /**
   * Draw a tooltip for a hovered foreign ship showing name, company, and hull/deck HP.
   */
  private drawShipHullTooltip(camera: Camera): void {
    if (!this.hoveredShip || !this.mouseWorldPos) return;
    // Don't overlap module or NPC tooltips
    if (this.hoveredModule || this.hoveredNpc) return;

    const ship = this.hoveredShip;
    const COMPANY_NAMES: Record<number, string> = {
      [COMPANY_NEUTRAL]: 'Neutral',
      [COMPANY_PIRATES]: 'Pirates',
      [COMPANY_NAVY]:    'Navy',
      [COMPANY_GHOST]:   'Ghost Ships',
    };
    const companyName = COMPANY_NAMES[ship.companyId] ?? `#${ship.companyId}`;
    const shipTitle   = ship.shipType === SHIP_TYPE_GHOST
      ? 'Phantom Brig'
      : `${companyName} Brigantine`;

    // Sum plank/deck module health
    let totalPlankHp    = 0;
    let totalPlankMaxHp = 0;
    for (const mod of ship.modules) {
      const md = mod.moduleData as any;
      if (!md) continue;
      if (md.kind === 'plank' || md.kind === 'deck') {
        totalPlankHp    += md.health    ?? md.maxHealth ?? 10000;
        totalPlankMaxHp += md.maxHealth ?? 10000;
      }
    }

    const isGhost = ship.shipType === SHIP_TYPE_GHOST;
    const maxHullHP = isGhost ? GHOST_MAX_HULL_HP : 100;
    const hullPct  = Math.max(0, Math.min(1, ship.hullHealth / maxHullHP));
    const hullText = isGhost
      ? `Hull: ${ship.hullHealth.toFixed(0)} / ${GHOST_MAX_HULL_HP.toLocaleString()}`
      : `Hull: ${ship.hullHealth.toFixed(0)}%`;
    const deckText = totalPlankMaxHp > 0
      ? `Deck HP: ${Math.round(totalPlankHp)} / ${Math.round(totalPlankMaxHp)}`
      : 'Deck HP: —';
    const deckPct  = totalPlankMaxHp > 0 ? totalPlankHp / totalPlankMaxHp : 1;

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const padding   = 10;
    const barH      = 8;
    const barW      = 180;
    const lineH     = 18;

    this.ctx.font = '14px monospace';
    this.ctx.textAlign    = 'left';
    this.ctx.textBaseline = 'top';

    const lines    = [shipTitle, `Company: ${companyName}`, hullText, deckText];
    const barRowH  = barH + 6;
    let boxW = Math.max(barW + padding * 2, ...lines.map(l => this.ctx.measureText(l).width + padding * 2));
    let boxH = lines.length * lineH + barRowH * 2 + padding * 2; // hull bar + deck bar

    let tx = screenPos.x + 15;
    let ty = screenPos.y + 15;
    if (tx + boxW > this.canvas.width)  tx = screenPos.x - boxW - 15;
    if (ty + boxH > this.canvas.height) ty = screenPos.y - boxH - 15;

    // Background
    this.ctx.fillStyle   = 'rgba(12,16,28,0.95)';
    this.ctx.strokeStyle = '#cc6633';
    this.ctx.lineWidth   = 1.5;
    this.ctx.beginPath();
    (this.ctx as any).roundRect(tx, ty, boxW, boxH, 4);
    this.ctx.fill();
    this.ctx.stroke();

    let cy = ty + padding;

    // Ship title (gold)
    this.ctx.fillStyle = '#ffe066';
    this.ctx.font = '14px monospace';
    this.ctx.fillText(shipTitle, tx + padding, cy);  cy += lineH;

    // Company
    this.ctx.fillStyle = '#9ab';
    this.ctx.font = '12px monospace';
    this.ctx.fillText(`Company: ${companyName}`, tx + padding, cy);  cy += lineH;

    const bx = tx + padding;
    const bw = boxW - padding * 2;

    // Hull integrity label
    this.ctx.fillStyle = '#ccc';
    this.ctx.fillText(hullText, bx, cy);  cy += lineH;
    // Hull bar
    this.ctx.fillStyle = '#333';
    this.ctx.fillRect(bx, cy, bw, barH);
    const hullColor = hullPct > 0.6 ? '#44cc66' : hullPct > 0.3 ? '#ffaa44' : '#ff5544';
    this.ctx.fillStyle = hullColor;
    this.ctx.fillRect(bx, cy, Math.round(bw * hullPct), barH);
    this.ctx.strokeStyle = '#556';
    this.ctx.lineWidth = 0.8;
    this.ctx.strokeRect(bx, cy, bw, barH);
    cy += barH + 6;

    // Deck HP label
    this.ctx.fillStyle = '#ccc';
    this.ctx.font = '12px monospace';
    this.ctx.fillText(deckText, bx, cy);  cy += lineH;
    // Deck bar
    this.ctx.fillStyle = '#333';
    this.ctx.fillRect(bx, cy, bw, barH);
    const deckColor = deckPct > 0.6 ? '#44cc66' : deckPct > 0.3 ? '#ffaa44' : '#ff5544';
    this.ctx.fillStyle = deckColor;
    this.ctx.fillRect(bx, cy, Math.round(bw * deckPct), barH);
    this.ctx.strokeStyle = '#556';
    this.ctx.lineWidth = 0.8;
    this.ctx.strokeRect(bx, cy, bw, barH);
  }

  /**
   * Draw hover tooltip for a hovered NPC.
   * Shows: name + level, role/state, HP bar (always), XP bar (same company only).
   */
  private drawNpcTooltip(camera: Camera): void {
    if (!this.hoveredNpc || !this.mouseWorldPos) return;
    // Skip if a module tooltip is already showing (avoid overlap)
    if (this.hoveredModule) return;

    const npc = this.hoveredNpc;
    const ROLE_NAMES: Record<number, string> = {
      0: 'Sailor', 1: 'Gunner', 2: 'Helmsman', 3: 'Rigger', 4: 'Repairer',
    };
    const STATE_NAMES: Record<number, string> = {
      0: 'Idle', 1: 'Moving', 2: 'At Station', 3: 'Repairing',
    };

    const sameCompany = this._localCompanyId !== 0 && npc.companyId === this._localCompanyId;
    const hpPct = npc.maxHealth > 0 ? npc.health / npc.maxHealth : 1;
    const xpToNext = npc.npcLevel * 100;
    const xpPct    = Math.min(npc.xp / xpToNext, 1);

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const padding = 10;
    const barH    = 8;
    const barW    = 180;
    const lineH   = 18;

    this.ctx.font = '14px monospace';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';

    const COMPANY_NAMES: Record<number, string> = { [COMPANY_NEUTRAL]: 'Neutral', [COMPANY_PIRATES]: 'Pirates', [COMPANY_NAVY]: 'Navy', [COMPANY_GHOST]: 'Ghost Ships' };
    const titleText   = `${npc.name}  Lv.${npc.npcLevel}${npc.locked ? '  🔒' : ''}`;
    const subText     = `${ROLE_NAMES[npc.role] ?? 'Sailor'}  –  ${STATE_NAMES[npc.state] ?? 'Idle'}`;
    const companyText = `Company: ${COMPANY_NAMES[npc.companyId] ?? `#${npc.companyId}`}`;
    const hpText      = `HP ${npc.health}/${npc.maxHealth} (${Math.round(hpPct * 100)}%)`;

    const lines = [titleText, subText, companyText, hpText];
    let boxW = Math.max(barW + padding * 2, ...lines.map(l => this.ctx.measureText(l).width + padding * 2));
    // height: 3 text lines + 2 bars (hp always, xp if sameCompany)
    const barRowH = barH + 4;
    let boxH = lines.length * lineH + barRowH + padding * 2; // hp bar
    if (sameCompany) boxH += barRowH + lineH;                // xp label + xp bar

    let tx = screenPos.x + 15;
    let ty = screenPos.y + 15;
    if (tx + boxW > this.canvas.width)  tx = screenPos.x - boxW  - 15;
    if (ty + boxH > this.canvas.height) ty = screenPos.y - boxH  - 15;

    // Background
    this.ctx.fillStyle   = 'rgba(12,16,28,0.95)';
    this.ctx.strokeStyle = '#88aaff';
    this.ctx.lineWidth   = 1.5;
    this.ctx.beginPath();
    this.ctx.roundRect(tx, ty, boxW, boxH, 4);
    this.ctx.fill();
    this.ctx.stroke();

    let cy = ty + padding;

    // Title (gold)
    this.ctx.fillStyle = '#ffe066';
    this.ctx.fillText(titleText, tx + padding, cy);  cy += lineH;

    // Sub-line (dim)
    this.ctx.fillStyle = '#9ab';
    this.ctx.font = '12px monospace';
    this.ctx.fillText(subText, tx + padding, cy);  cy += lineH;

    // HP label
    this.ctx.font = '12px monospace';
    this.ctx.fillStyle = '#ccc';
    this.ctx.fillText(hpText, tx + padding, cy);  cy += lineH;

    // HP bar
    const bx = tx + padding;
    const bw = boxW - padding * 2;
    this.ctx.fillStyle = '#333';
    this.ctx.fillRect(bx, cy, bw, barH);
    const hpColor = hpPct > 0.6 ? '#44cc66' : hpPct > 0.3 ? '#ffaa44' : '#ff5544';
    this.ctx.fillStyle = hpColor;
    this.ctx.fillRect(bx, cy, Math.round(bw * hpPct), barH);
    this.ctx.strokeStyle = '#556';
    this.ctx.lineWidth = 0.8;
    this.ctx.strokeRect(bx, cy, bw, barH);
    cy += barH + 6;

    if (sameCompany) {
      // XP label
      this.ctx.fillStyle = '#9ab';
      this.ctx.font = '12px monospace';
      this.ctx.fillText(`XP ${npc.xp} / ${xpToNext}  (next level)`, tx + padding, cy);  cy += lineH;
      // XP bar
      this.ctx.fillStyle = '#333';
      this.ctx.fillRect(bx, cy, bw, barH);
      this.ctx.fillStyle = '#4488ff';
      this.ctx.fillRect(bx, cy, Math.round(bw * xpPct), barH);
      this.ctx.strokeStyle = '#556';
      this.ctx.lineWidth = 0.8;
      this.ctx.strokeRect(bx, cy, bw, barH);
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
      this.cannonBuildMode  && !this.explicitBuildState ? 'cannon' :
      this.mastBuildMode   && !this.explicitBuildState ? 'mast' :
      this.swivelBuildMode && !this.explicitBuildState ? 'swivel' : null;
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
        case 'swivel': {
          this.ctx.fillStyle = ghostFill;
          this.ctx.strokeStyle = ghostStroke;
          this.ctx.lineWidth = 1.2;
          this.ctx.setLineDash([3, 2]);
          // Pivot base circle
          this.ctx.beginPath();
          this.ctx.arc(0, 0, 8, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.stroke();
          // Barrel stub (pointing up)
          this.ctx.fillRect(-3, -22, 6, 22);
          this.ctx.strokeRect(-3, -22, 6, 22);
          this.ctx.setLineDash([]);
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
      // Swivels are the exception: they mount on the rail within 2–30 px of the hull edge
      if (valid) {
        const edgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
        if (kind === 'swivel') {
          if (edgeDist > 30) { valid = false; invalidReason = 'Must be on ship rail!'; }
          else if (edgeDist < 2) { valid = false; invalidReason = 'Too far outside rail!'; }
        } else {
          const edgeMargin = (kind === 'cannon' || kind === 'mast') ? 15 : 10;
          if (edgeDist < edgeMargin) { valid = false; invalidReason = 'Too close to edge!'; }
        }
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
      case 'swivel': {
        // Pivot circle + barrel stub
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 8, 0, Math.PI * 2);
        this.ctx.fillStyle = fillColor; this.ctx.fill();
        this.ctx.strokeStyle = okColor; this.ctx.lineWidth = 1.5; this.ctx.stroke();
        this.ctx.fillStyle = fillColor;
        this.ctx.strokeStyle = okColor;
        this.ctx.fillRect(-3, -22, 6, 22);
        this.ctx.strokeRect(-3, -22, 6, 22);
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
    const newKind = item === 'cannon' ? 'cannon' as const
                  : item === 'swivel' ? 'swivel' as const
                  : 'mast' as const;
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
      // Swivels mount on the rail (within 2–30 px of hull edge)
      if (!overlaps && !ghostBlocked) {
        const edgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
        if (newKind === 'swivel') {
          if (edgeDist > 30 || edgeDist < 2) edgeTooClose = true;
        } else {
          const edgeMargin = 15;
          if (edgeDist < edgeMargin) edgeTooClose = true;
        }
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
    } else if (item === 'swivel') {
      // -- Swivel base (smaller than cannon) --
      this.ctx.fillStyle   = valid ? '#336633' : ghostSnap ? '#1a4d44' : ghostBlocked ? '#664422' : '#663333';
      this.ctx.strokeStyle = valid ? '#88ff88' : ghostSnap ? '#44ddcc' : ghostBlocked ? '#ffaa44' : '#ff8888';
      this.ctx.lineWidth   = 1 / zoom;
      this.ctx.fillRect(-8, -8, 16, 16);
      this.ctx.strokeRect(-8, -8, 16, 16);

      // -- Short barrel --
      this.ctx.fillStyle   = valid ? '#225522' : ghostSnap ? '#1a4d44' : ghostBlocked ? '#553311' : '#552222';
      this.ctx.strokeStyle = valid ? '#55ee55' : ghostSnap ? '#33ccbb' : ghostBlocked ? '#ee9933' : '#ee5555';
      this.ctx.fillRect(-4, -22, 8, 16);
      this.ctx.strokeRect(-4, -22, 8, 16);
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
      ? (item === 'cannon' ? 'Place Cannon' : item === 'swivel' ? 'Place Swivel' : 'Place Sail')
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
