

/**
 * Main Rendering System
 * 
 * Centralized rendering system that handles all visual output.
 * Separated from game logic for clean architecture.
 */

import { GraphicsConfig } from '../ClientConfig.js';
import { Camera } from './Camera.js';
import { ParticleSystem } from './ParticleSystem.js';
import { EffectRenderer, AnnouncementKind, DamageTeam } from './EffectRenderer.js';
import { WorldState, Ship, Player, Cannonball, Npc, NPC_STATE_MOVING, NPC_STATE_AT_GUN, GhostPlacement, GhostModuleKind, COMPANY_UNCLAIMED, COMPANY_NEUTRAL, COMPANY_SOLO, COMPANY_PIRATES, COMPANY_NAVY, COMPANY_GHOST, SHIP_TYPE_GHOST, PlacedStructure, ConstructionPhase, IslandDef, Company, LandGhostPlacement } from '../../sim/Types.js';
import { ShipModule, createCompleteHullSegments, PlankSegment, PlankModuleData, DeckModuleData, getModuleFootprint, footprintsOverlap, HULL_POINTS, getQuadraticPoint, GUNPORT_SNAP_POINTS } from '../../sim/modules.js';
import { BUCKET_LOWER_SCOOP_FILL, BUCKET_UPPER_SCOOP_FILL, computeDeckFloodTint } from '../../sim/BucketBail.js';
import { Vec2 } from '../../common/Vec2.js';
import { PolygonUtils } from '../../common/PolygonUtils.js';
import { ClientState } from '../ClientApplication.js';
import { RadialMenu } from '../ui/RadialMenu.js';
import { GLWorldRenderer } from './gl/GLWorldRenderer.js';
import {
  StructureSpriteCache,
  blitStructureSprite,
  getStructureBaseSprite,
  getCannonBarrelSprite,
  getWoodCeilingSprite,
  structureCompanyColor as structureCompanyStripColor,
} from './StructureSprites.js';
import {
  SHIPYARD_TILE,
  SHIPYARD_ARM_T,
  SHIPYARD_INT_W,
  SHIPYARD_ARM_L,
  SHIPYARD_BACK_T,
  SHIPYARD_HW,
  SHIPYARD_HH,
  SHIPYARD_HEIGHT_MULT,
  brigSlotCornersLocal,
  brigSlotOverlapsLand,
} from '../../sim/ShipyardGeometry.js';
import { tierColor, tierName, statMultLabel, computeCannonHullDamage, computeCannonEntityDamage, CANNON_HULL_BASE_DAMAGE, CANNON_ENTITY_BASE_DAMAGE, BAR_SHOT_ENTITY_BASE_DAMAGE, itemDisplayName } from '../../sim/Quality.js';
import { SHIP_ATTR_DAMAGE } from '../../sim/Types.js';

/** Max hull HP for ghost (Phantom Brig) ships — server uses raw HP scale, not 0-100. */
const GHOST_MAX_HULL_HP = 60000;

/**
 * Returns the spectral glow colour for a ghost ship at the given NPC level (1–60).
 * Level 1 = cyan (#00eeff), Level 60 = red (#ff2800).
 * Linear RGB interpolation through teal/green at mid levels.
 */
function ghostSpectralColor(level: number, alpha?: number): string {
  const t = Math.max(0, Math.min(1, ((level ?? 1) - 1) / 59));
  const r = Math.round(t * 255);
  const g = Math.round(238 * (1 - t) + 40 * t);
  const b = Math.round(255 * (1 - t));
  return alpha != null ? `rgba(${r},${g},${b},${alpha.toFixed(3)})` : `rgb(${r},${g},${b})`;
}

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

type ResourceNode = {
  ox: number;
  oy: number;
  type: string;
  size: number;
  hp: number;
  maxHp: number;
  depletedAt?: number;
  metal?: boolean;
};

type RenderIslandInput = {
  id: number;
  x: number;
  y: number;
  preset: string;
  resources: ResourceNode[];
  vertices?: { x: number; y: number }[];
  grassVertices?: { x: number; y: number }[];
  shallowVertices?: { x: number; y: number }[];
  stonePolys?: { x: number; y: number }[][];
  metalPolys?: { x: number; y: number }[][];
};

type RenderIsland = RenderIslandInput & {
  resourceGrid: {
    cellSize: number;
    cells: Map<string, number[]>;
  };
};

/**
 * Main rendering system
 */
export class RenderSystem {
    /**
     * Read-only access to all placed structures (for client-side validation and snapping).
     */
    public getPlacedStructures(): readonly PlacedStructure[] {
      return this.placedStructures;
    }
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GraphicsConfig;
  
  // Sub-systems
  private particleSystem: ParticleSystem;
  private effectRenderer: EffectRenderer;

  /** WebGL2 world renderer — null when WebGL2 is unavailable or disabled. */
  private _gl: GLWorldRenderer | null = null;
  /** Elapsed time in seconds, passed to GL shaders for animation. */
  private _glTimeSec = 0;
  /** World-wrap render settings received from NetworkManager via ClientApplication. */
  private _wrapRenderEnabled = false;
  private _wrapWorldWidth = 0;
  private _wrapWorldHeight = 0;
  
  // Render queue for layered rendering (10 pre-allocated buckets: index 0 = layer -1, index 1-9 = layers 1-9)
  private readonly renderBuckets: RenderQueueItem[][] = Array.from({length: 10}, () => []);
  
  // Hover state
  private mouseWorldPos: Vec2 | null = null;
  private hoveredModule: { ship: Ship; module: any } | null = null;
  private hoveredNpc: Npc | null = null;
  /** Ship (other than the player's own) whose hull the cursor is over. */
  private hoveredShip: Ship | null = null;

  /** Tooltip hover-delay (500 ms) */
  private _tooltipHoverKey   = '';
  private _tooltipHoverStart = 0;
  private _tooltipReady      = false;

  /** Timestamp (ms) of the last sword swing, used to draw a cooldown ring. */
  private lastSwordSwingAt: number = 0;
  private swordCooldownMs: number = 800;
  /** Set to true each frame when the local player has the sword as their active item. */
  public swordEquipped: boolean = false;
  public axeEquipped: boolean = false;
  /** Set each frame when the local player has the hammer as their active item. */
  public hammerEquipped: boolean = false;
  /** Suppresses harvest/gather prompts while the player is in combat mode. */
  public combatMode: boolean = false;

  // Build mode state
  /** Set by ClientApplication each frame: false when the hovered ghost slot can't be afforded. */
  public ghostCanAfford: boolean = true;
  /** Set by ClientApplication each frame: false when the player can't afford the active land build. */
  public landGhostCanAfford: boolean = true;
  /**
   * Quality tier of the currently-selected plank blueprint (0 = Standard / none).
   * Set each frame by ClientApplication so ghost plank slots tint to the tier colour.
   */
  public ghostPlankTier: number = 0;
  /** Optional per-kind affordability callback for plan markers — set by ClientApplication. */
  public landAffordabilityCheck: ((kind: string) => boolean) | null = null;
  private buildMode: boolean = false;
  /** Whether cannon replacement build mode is active (cannon item held). */
  private cannonBuildMode: boolean = false;
  /** The cannon slot (index+ship) currently under the cursor in cannon build mode. */
  private hoveredCannonSlot: { ship: Ship; cannonIndex: number; localX: number; localY: number; rot: number } | null = null;
  /** A gunport on the ship that the cursor is over in cannon build mode (snap cannon to this gunport). */
  private hoveredGunportCannonSnap: { ship: Ship; module: ShipModule } | null = null;
  /** Per-gunport animation state: gunportId → { targetOpen, startProgress, startTime }. */
  private gunportAnimations: Map<number, { targetOpen: boolean; startProgress: number; startTime: number }> = new Map();
  /** Duration of gunport cannon slide animation in milliseconds. */
  private static readonly GUNPORT_ANIM_MS = 800;
  /** How far inboard a gunport cannon is rendered when the gunport is closed (pixels). */
  static readonly GUNPORT_CANNON_INBOARD = 40;
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
  private hoveredDeckSlot: { ship: Ship; deckLevel: number } | null = null;
  /** Which deck level the player has manually selected with T (0=lower, 1=upper, -1=auto). */
  private deckLevelOverride: number = -1;
  /** Whether ramp placement build mode is active (ramp item held). */
  private rampBuildMode: boolean = false;
  private hatchBuildMode: boolean = false;
  /** Whether gunport placement build mode is active (door item held on ship). */
  private gunportBuildMode: boolean = false;
  /** Whether resource chest placement build mode is active (resource_chest item held). */
  private chestBuildMode: boolean = false;
  /** Whether bed placement build mode is active (bed ghost selected). */
  private bedBuildMode: boolean = false;
  /** Whether bilge well placement build mode is active (well ghost selected). */
  private wellBuildMode: boolean = false;
  /** Whether ship workbench placement build mode is active (workbench ghost selected). */
  private workbenchBuildMode: boolean = false;
  /** The gunport snap index currently hovered in gunport build mode. */
  private hoveredGunportSnap: { ship: Ship; snapIndex: number; localPos: { x: number; y: number } } | null = null;
  /** The ramp snap point slot currently under the cursor in ramp build mode. */
  private hoveredRampSlot: { ship: Ship; snapIndex: number; localPos: { x: number; y: number } } | null = null;
  /** Set by ClientApplication each frame — true when the local player is holding right-mouse. */
  public playerIsAiming: boolean = false;
  /** Camera mode badge to overlay on screen. 'free' | 'rotate' | null. */
  public cameraMode: 'free' | 'rotate' | null = null;
  /** The assigned local player ID, so guides only draw for that player's cannon. */
  public localPlayerId: number | null = null;
  /** Ship ID whose upper deck is semi-transparent because the local player is in a hole on the lower deck. */
  private _lowerDeckShipId: number | null = null;
  /** Which deck the local player is on: 1 = upper deck (default), 0 = lower deck. */
  private _playerDeckLevel: number = 1;
  /**
   * Smoothed opacity multiplier for upper-deck modules/NPCs when the local player is on the lower deck.
   * Lerps between 1.0 (on upper deck) and 0.3 (on lower deck) over ~300 ms.
   */
  private _upperDeckFade: number = 1.0;
  /** Optional callback fired whenever _playerDeckLevel changes (so ClientApplication can notify the server). */
  public onDeckLevelChange: ((deckLevel: number) => void) | null = null;
  /** Read-only access to the current player deck level for placement decisions. */
  public get playerDeckLevel(): number { return this._playerDeckLevel; }
  /** Bucket bail UI — true while local player holds water and can dump. */
  private _bucketDumpHintActive = false;
  private _bucketDumpHintValid = false;
  public setBucketDumpHint(active: boolean, valid: boolean): void {
    this._bucketDumpHintActive = active;
    this._bucketDumpHintValid = valid;
  }
  /**
   * Timestamp (performance.now) of the most recent boarding event.
   * Ramp fall-through detection is suppressed for 500 ms after boarding so a
   * hull-contact spawn position near a ramp hole can't immediately push the
   * player to the lower deck before server/client positions converge.
   */
  private _boardedAtMs: number = -Infinity;
  private readonly _BOARD_GRACE_MS = 500;

  /** Call immediately after boarding (grapple or any path) to start the grace window. */
  public setJustBoarded(): void {
    this._boardedAtMs = performance.now();
  }

  /**
   * Force-set the deck level from an external authority (e.g. server ack after rejection).
   * Does NOT fire onDeckLevelChange — the caller is responsible for updating PredictionEngine
   * and must NOT re-send player_set_deck to avoid an echo loop.
   */
  public forceSetDeckLevel(deckLevel: number): void {
    this._playerDeckLevel = deckLevel === 0 ? 0 : 1;
  }
  /** Current ramp facing index in build mode: 0=+x, 1=+y, 2=-x, 3=-y (top/light end direction). */
  private rampFacing: number = 0;
  /** Player position info used by the hover tooltip to determine interact range. */
  public playerInteractInfo: { worldPos: Vec2; localPos: Vec2 | null; carrierId: number | null } | null = null;
  /** Weapon control groups — set by ClientApplication each frame. Null when not on helm. */
  public controlGroups: Map<number, { cannonIds: number[]; mode: string }> | null = null;
  /** Groups showing the temporary RMB-hold AIM tag (for cannon overlay mode dots). */
  public rmbAimingGroups: Set<number> = new Set();
  /** When true, draws group membership badges on all cannons (while Shift is held). */
  public showGroupOverlay: boolean = false;
  /** Currently selected weapon group indices — cannons in these groups are always highlighted. */
  public activeWeaponGroups: Set<number> = new Set();
  /** NPC IDs whose command-ignore flag is set (client-side only).  Used to draw badge + block Move To. */
  public npcIgnoreSet: Set<number> = new Set();
  /** Tracks whether the Alt key is currently held — reveals lower-deck NPCs when above deck. */
  public altKeyHeld: boolean = false;
  /** NPC IDs selected via Ctrl+drag box — rendered with highlight ring. */
  public selectedNpcIds: Set<number> = new Set();
  /** Screen-space rect being dragged for box selection (null when inactive). */
  public boxSelectRect: { x1: number, y1: number, x2: number, y2: number } | null = null;
  /** Structure ID of the island cannon the local player is currently mounted to (for barrel rendering). */
  public islandCannonId: number | null = null;
  /** Live aim angle (world radians) for the mounted island cannon barrel. Null when not mounted. */
  public islandCannonAimAngle: number | null = null;
  /** Per-direction hit distances (world units) from the latest AOI ray cast.
   *  Set by ClientApplication each frame when the local player is in-game. */
  public fogRayHitDist: Float32Array | null = null;
  /** Off-screen canvas reused for fog-mask compositing. */
  private _fogCanvas: HTMLCanvasElement | null = null;
  /** Internal fog raster scale (0.25–1). Set from ClientApplication._glScale each frame. */
  public fogRenderScale = 0.5;
  /** Camera state captured when the fog canvas was last rendered.
   *  Used for dirty-detection so we skip the expensive blur pass
   *  when neither the ray data nor the camera has changed since last frame. */
  private _fogLastRayVersion = -1;
  private _fogLastCamX = NaN;
  private _fogLastCamY = NaN;
  private _fogLastZoom = NaN;
  private _fogLastRot  = NaN;
  private _fogLastRenderScale = NaN;
  /** Reused ship list for fog-visible filtering (avoids .filter() alloc per frame). */
  private _visibleShipsScratch: import('../../sim/Types.js').Ship[] = [];
  private _visiblePlayersScratch: import('../../sim/Types.js').Player[] = [];
  private _visibleCannonballsScratch: import('../../sim/Types.js').Cannonball[] = [];
  /** Pooled wrap-seam entity copies — reset each buildWrappedRenderCopies call. */
  private _wrapGhostEntities: Array<Record<string, unknown>> = [];
  private _wrapGhostPositions: Vec2[] = [];
  private _wrapGhostIdx = 0;
  /** When true, record ms for island / queue / execute / fog passes (see getLastPerfTimings). */
  public perfTimingsEnabled = false;
  private _perfMs = { island: 0, queue: 0, execute: 0, fog: 0 };
  /** Monotonic counter incremented by ClientApplication whenever the fog
   *  worker delivers a new ray set. RenderSystem compares this to skip
   *  redundant fog redraws at render-frame rate (60-120 Hz). */
  public fogRayVersion = 0;

  /** 0 = not charging, 0–1 = current grapple wind-up progress.
   *  Set by ClientApplication each frame while the player holds LMB. */
  public grappleChargeProgress = 0;
  /** World-space radius (px) of the projected grapple shot at current charge. */
  public grappleProjectedRange = 0;
  /** World-space aim target while winding up — null when not charging. */
  public grappleAimWorldPos: { x: number; y: number } | null = null;
  /** 0–1 boarding progress when grappled onto a ship and reeled in close; 0 = not boarding. */
  public grappleBoardingProgress = 0;
  /** Cached local player company for the current frame — set at start of renderWorld. */
  private _localCompanyId: number = 0;
  /** Cached local player for the current frame — set once in renderWorld, shared by all draw methods. */
  private _cachedLocalPlayer: Player | null = null;
  /** Placed island structures — updated via addPlacedStructure / setPlacedStructures. */
  private placedStructures: PlacedStructure[] = [];
  /** islandId → companyId: active island territory claims. */
  private _islandClaims: Map<number, { companyId: number; fortX: number; fortY: number; fortRadius: number; isCompanyFortress: boolean }> = new Map();
  /** When true, draws the territory overlay (Alt held). */
  private _showTerritoryOverlay = false;
  /** When true, shows names above all allied NPCs (Alt held). */
  private _showNpcNames = false;
  /**
   * Cached offscreen bitmaps for the territory claim overlay.
   * Keyed by islandId. Invalidated whenever placedStructures or _localCompanyId changes.
   * null entries mean the bitmap needs to be redrawn.
   */
  private _claimOverlayCache: Map<string, { connectedIds: Set<number>; inactiveIds: Set<number> }> = new Map();
  // Backing state for _claimOverlayDirty getter/setter
  private _claimOverlayDirtyState = true;
  /** Offscreen canvas cache for the territory overlay rasterisation. */
  private _claimOverlayBitmapValid = false;
  private _claimOverlayCachedCanvas: OffscreenCanvas | null = null;
  private _claimOverlayCachedCamX = 0;
  private _claimOverlayCachedCamY = 0;
  private _claimOverlayCachedZoom = 0;
  /** Extra pixels on each side of the viewport that the cached overlay canvas
   * covers, so camera pan can be handled by a pixel-offset drawImage instead
   * of a full re-rasterisation.  Re-render triggers when drift > 60% of this. */
  private readonly _claimOverlayMargin = 700;
  private get _claimOverlayDirty(): boolean { return this._claimOverlayDirtyState; }
  private set _claimOverlayDirty(v: boolean) {
    this._claimOverlayDirtyState = v;
    if (v) this._claimOverlayBitmapValid = false;
  }
  /**
   * Cache of world-space (camera-independent) subord/dominated structure ID
   * sets per (islandId, companyId).  Computed once on structural change and
   * reused every frame while Alt is held, avoiding the O(N²) filter loops.
   * Keyed by `${islId}_${cid}`.  Cleared alongside _claimOverlayCache.
   */
  private _miInfosCache: Map<string, {
    activeSubordIds:    Map<number, number[]>;
    activeDomIds:       Map<number, number[]>;
    inactiveSubordIds:  Map<number, number[]>;
    inactiveDomIds:     Map<number, number[]>;
  }> = new Map();
  /**
   * Pool of reusable full-screen OffscreenCanvas scratch buffers, keyed by
   * a stable slot name. Avoids per-frame allocation of dozens of large RGBA
   * buffers in the territory overlay rendering pass. Each slot must be used
   * by at most one logical buffer at any given time within a single overlay
   * pass; the helper resets transform/composite/alpha/lineDash and clears
   * the canvas on each fetch so callers always see a fresh buffer.
   */
  private _scratchCanvases: Map<string, OffscreenCanvas> = new Map();

  // ── Ship static-layer sprite caches ───────────────────────────────────────
  // Ships are mostly static between frames (no animation on hull fill or rope
  // rigging).  We rasterize these layers once into OffscreenCanvas bitmaps and
  // blit them each frame.  Each entry stores the rendered canvas and the cache
  // key that was used so we can detect when geometry has actually changed.
  private _shipRopeSprites: Map<number, { canvas: OffscreenCanvas; key: string }> = new Map();
  private _structureSpriteCache = new StructureSpriteCache();
  private _shipHullSprites: Map<number, { canvas: OffscreenCanvas; key: string; ox: number; oy: number }> = new Map();

  // Per-ship plank layer OffscreenCanvas cache.
  // Key = "<shipId>:<plankHealthBuckets>" — re-baked only when a plank's damage bucket changes.
  // Replaces 48× fillRect/strokeRect per ship per frame with a single drawImage().
  private _shipPlankSprites: Map<number, { canvas: OffscreenCanvas; key: string; ox: number; oy: number }> = new Map();

  // Hull + planks drawn in one queue pass for the standard above-deck view (one transform
  // setup, two aligned blits from existing per-layer caches). Not used on lower-deck view.

  // Per-ship upper-deck-cover OffscreenCanvas cache (base layer without flood tint).
  // Key = "<shipId>:<deckHealthBucket>" — re-baked only when deck damage bucket changes.
  // Replaces 3× 47-vertex hull polygon rebuilds per ship per frame with one drawImage() + optional flood fill.
  private _shipUpperDeckSprites: Map<number, { canvas: OffscreenCanvas; key: string; ox: number; oy: number }> = new Map();

  // ── Ghost ship pseudo-sprite caches ────────────────────────────────────────
  // Ghost hulls bypass the normal _shipHullSprites because their fill color and
  // spectral edge are health-/aggro-driven.  We still bake the polygon fill + base
  // stroke so the hull path is only rebuilt when the aggro state changes (at most
  // once per ~220 ms sin cycle), not every frame.
  // Key = "gh:<aggro>".
  private _ghostHullSprites: Map<number, { canvas: OffscreenCanvas; key: string; ox: number; oy: number }> = new Map();

  // Runic circle + 5 tick marks baked per npcLevel bucket (12 buckets across 60
  // levels).  The pulse alpha and slow rotation are applied at draw-time via
  // ctx.globalAlpha + ctx.rotate, so only geometry needs to be pre-baked.
  // Key = "gd:<levelBucket>".
  private _ghostDeckSprites: Map<number, { canvas: OffscreenCanvas; key: string; cx: number; cy: number }> = new Map();

  // Per-mastId phantom-sail torn bottom edge (seeded-random, deterministic).
  // Saves regenerating 10 random numbers per sail per frame.
  private _phantomSailTears: Map<number, { tearX: number[]; tearY: number[] }> = new Map();

  // Combined static ghost ship sprite: hull + ropes + masts + phantom sails.
  // Cannons, fog aura, animated deck rune/haze/crew, aggro glow, and health fade stay live.
  // Key = "gcomb:<aggro>:<levelBucket>".
  private _ghostCombinedSprites: Map<number, { canvas: OffscreenCanvas; key: string; ox: number; oy: number }> = new Map();

  /** Fixed brigantine rigging baked into the ghost combined sprite — no server modules. */
  private static readonly GHOST_PHANTOM_MASTS = [
    { x: 165,  y: 0, sailWidth: 80, height: 100, radius: 15, tearId: 9001 },
    { x: -35,  y: 0, sailWidth: 80, height: 100, radius: 15, tearId: 9002 },
    { x: -235, y: 0, sailWidth: 80, height: 100, radius: 15, tearId: 9003 },
  ] as const;

  // Per-frame memoization caches — cleared at the top of renderWorld() each frame.
  // computeSinkState() is called ~10× per visible ship per frame; caching cuts it to 1 compute per ship.
  private _sinkStateCache: Map<number, {
    waterFill: number;
    lowerDeckFloodTint: number;
    upperDeckFloodTint: number;
    floodTint: number;
    phase1Alpha: number;
    phase2Alpha: number;
    phase3Alpha: number;
  }> = new Map();
  // darkenByDamage() allocates a new rgb() string on every call (~116/frame for a full brig).
  // Key is "<hex>:<health_bucket>"; 21 buckets (0–20) × ~6 distinct hex colours → ≤126 entries.
  private _darkenCache: Map<string, string> = new Map();

  // Ladder sprites — 2 static variants (extended / retracted), baked once.
  // Each ladder is 100% static so a single drawImage() replaces 7+ fill/stroke ops.
  private _ladderSprites: { extended: OffscreenCanvas; retracted: OffscreenCanvas } | null = null;
  private _getLadderSprites(): { extended: OffscreenCanvas; retracted: OffscreenCanvas } {
    if (this._ladderSprites) return this._ladderSprites;

    // Extended: 20×40 world units, padded by 2 on each side → 24×44 canvas
    const ext = new OffscreenCanvas(24, 44);
    const ec  = ext.getContext('2d')!;
    ec.translate(12, 22); // centre at world origin
    // Side rails
    ec.fillStyle = '#5C3A1E';
    ec.fillRect(-10, -20, 3, 40);  // left rail
    ec.fillRect( 7,  -20, 3, 40);  // right rail
    // Rungs
    ec.fillStyle = '#8B5E3C';
    const rungSpacing = 40 / 5; // lh / (rungCount + 1)
    for (let i = 1; i <= 4; i++) {
      const ry = -20 + i * rungSpacing - 1.5;
      ec.fillRect(-7, ry, 14, 3);
    }
    // Outline
    ec.strokeStyle = '#3A2010';
    ec.lineWidth   = 1;
    ec.strokeRect(-10, -20, 20, 40);

    // Retracted: 20×12 world units, padded 2 each side → 24×16 canvas
    const ret = new OffscreenCanvas(24, 16);
    const rc  = ret.getContext('2d')!;
    rc.translate(12, 8);
    rc.fillStyle   = '#6B5040';
    rc.fillRect(-10, -6, 20, 12);
    rc.strokeStyle = '#3A2010';
    rc.lineWidth   = 1;
    rc.strokeRect(-10, -6, 20, 12);
    rc.strokeStyle = '#4A3020';
    rc.beginPath();
    rc.moveTo(-7, -4); rc.lineTo( 7,  4);
    rc.moveTo(-7,  4); rc.lineTo( 7, -4);
    rc.stroke();

    this._ladderSprites = { extended: ext, retracted: ret };
    return this._ladderSprites;
  }

  // Ramp fill sprite — pre-baked 50×50 gradient fill so createLinearGradient is
  // never called at draw time.  Opaque; callers composite via globalAlpha.
  private _rampFillSprite: OffscreenCanvas | null = null;
  private _getRampFillSprite(): OffscreenCanvas {
    if (this._rampFillSprite) return this._rampFillSprite;
    const c = new OffscreenCanvas(50, 50);
    const cx = c.getContext('2d')!;
    const grad = cx.createLinearGradient(0, 0, 50, 0);
    grad.addColorStop(0, '#b07d42');
    grad.addColorStop(1, '#2e1a08');
    cx.fillStyle = grad;
    cx.fillRect(0, 0, 50, 50);
    this._rampFillSprite = c;
    return c;
  }

  /** Build or retrieve the cached rope-rigging sprite for a ship.
   *  The canvas is rasterized in ship-local world units (zoom=1).
   *  Callers draw it via ctx.drawImage(canvas, -ox, -oy) after applying the
   *  ship-local transform (translate + scale(zoom) + rotate). */
  private _getShipRopeSprite(ship: Ship): { canvas: OffscreenCanvas; ox: number; oy: number } | null {
    const masts = ship.modules.filter(m => m.kind === 'mast');
    if (masts.length === 0) return null;

    // Cache key: encodes mast positions and sail widths — all static geometry
    const mastSig = masts
      .map(m => `${(m.localPos?.x ?? 0).toFixed(1)},${(m.localPos?.y ?? 0).toFixed(1)},${(m.moduleData as any)?.sailWidth ?? 80}`)
      .join('|');
    const key = `r:${mastSig}`;

    const existing = this._shipRopeSprites.get(ship.id);
    if (existing && existing.key === key) return { canvas: existing.canvas, ox: existing.canvas.width / 2 - 0, oy: existing.canvas.height / 2 - 0 };

    // Compute bbox from hull to size the canvas (hull is wider than mast positions)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of ship.hull) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    const pad = 12;
    const ox = -(minX - pad);
    const oy = -(minY - pad);
    const w  = Math.max(4, Math.ceil(maxX - minX + 2 * pad));
    const h  = Math.max(4, Math.ceil(maxY - minY + 2 * pad));

    const canvas = new OffscreenCanvas(w, h);
    const rctx = canvas.getContext('2d')!;
    rctx.translate(ox, oy); // world 0,0 → canvas (ox, oy)

    rctx.strokeStyle = '#8B7355';
    rctx.lineWidth   = 1.2;
    rctx.lineCap     = 'round';

    for (const mast of masts) {
      if (!mast.moduleData || mast.moduleData.kind !== 'mast') continue;
      const mastData = mast.moduleData as any;
      const mx = mast.localPos.x;
      const my = mast.localPos.y;
      const halfBase = (mastData.sailWidth ?? 80) * 0.5;
      const step = halfBase / 3;
      const x0 = mx - halfBase, x1 = mx - step, x2 = mx + step, x3 = mx + halfBase;

      for (const side of [1, -1] as const) {
        const ry0 = my + this.hullRailY(x0, side);
        const ry1 = my + this.hullRailY(x1, side);
        const ry2 = my + this.hullRailY(x2, side);
        const ry3 = my + this.hullRailY(x3, side);

        // All 7 ropes in one batched path per side
        rctx.beginPath();
        rctx.moveTo(mx, my); rctx.lineTo(x0, ry0);
        rctx.moveTo(mx, my); rctx.lineTo(x3, ry3);
        rctx.moveTo(mx, my); rctx.lineTo(x1, ry1);
        rctx.moveTo(mx, my); rctx.lineTo(x2, ry2);
        // cross-ropes
        for (const t of [1 / 3, 2 / 3]) {
          rctx.moveTo(mx + (x0 - mx) * t, my + (ry0 - my) * t);
          rctx.lineTo(mx + (x3 - mx) * t, my + (ry3 - my) * t);
        }
        // rail rope
        rctx.moveTo(x0, ry0); rctx.lineTo(x1, ry1); rctx.lineTo(x2, ry2); rctx.lineTo(x3, ry3);
        rctx.stroke();

        // Cleats (rect-based — keep as rects in sprite)
        for (const [cxA, cxB] of [[x0, x1], [x2, x3]] as [number, number][]) {
          const cy     = (this.hullRailY(cxA, side) + this.hullRailY(cxB, side)) / 2 + my;
          const angle  = Math.atan2(this.hullRailY(cxB, side) - this.hullRailY(cxA, side), cxB - cxA);
          const ccx    = (cxA + cxB) / 2;
          const bodyW  = Math.abs(cxB - cxA);
          const bodyH  = bodyW * 0.20;
          const hornW  = bodyH * 1.20;
          const hornH  = bodyH * 1.30;
          rctx.save();
          rctx.translate(ccx, cy);
          rctx.rotate(angle);
          rctx.fillStyle   = '#4A3728';
          rctx.strokeStyle = '#2C1F14';
          rctx.lineWidth   = 0.9;
          rctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
          rctx.strokeRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
          rctx.fillRect(-bodyW / 2, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.strokeRect(-bodyW / 2, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.fillRect(bodyW / 2 - hornW, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.strokeRect(bodyW / 2 - hornW, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.restore();
        }
      }
    }

    this._shipRopeSprites.set(ship.id, { canvas, key });
    return { canvas, ox, oy };
  }

  /** Build or retrieve the cached hull-fill + grain sprite for a ship.
   *  Rasterized in ship-local world units (zoom=1); blitted after ship transform.
   *  Does NOT include animated layers: flood tint, ghost glow, sink alpha, enemy tint. */
  private _getShipHullSprite(
    ship: Ship,
    hasUpperDeck: boolean,
    hasDeck: boolean,
    fillColor: string,
  ): { canvas: OffscreenCanvas; ox: number; oy: number } | null {
    if (ship.hull.length < 3) return null;

    // Cache key: structural shape + color (health-quantized already in fillColor's darkenByDamage)
    const key = `h:${hasUpperDeck ? 1 : 0}:${hasDeck ? 1 : 0}:${fillColor}`;
    const existing = this._shipHullSprites.get(ship.id);
    if (existing && existing.key === key) return { canvas: existing.canvas, ox: existing.ox, oy: existing.oy };

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of ship.hull) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    const pad = 8;
    const ox  = -(minX - pad);
    const oy  = -(minY - pad);
    const w   = Math.max(4, Math.ceil(maxX - minX + 2 * pad));
    const h   = Math.max(4, Math.ceil(maxY - minY + 2 * pad));

    const canvas = new OffscreenCanvas(w, h);
    const rctx   = canvas.getContext('2d')!;
    rctx.translate(ox, oy);

    // Hull fill — punch transparent holes at ramp/hatch positions when upper deck present
    rctx.beginPath();
    rctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    for (let i = 1; i < ship.hull.length; i++) rctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    rctx.closePath();
    if (hasUpperDeck) {
      for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
        rctx.rect(sp.x - 25, sp.y - 25, 50, 50);
      }
    }
    rctx.fillStyle = fillColor;
    rctx.fill(hasUpperDeck ? 'evenodd' : 'nonzero');

    // Grain lines (batched into one stroke call, clipped to hull)
    if (hasDeck) {
      rctx.save();
      rctx.beginPath();
      rctx.moveTo(ship.hull[0].x, ship.hull[0].y);
      for (let i = 1; i < ship.hull.length; i++) rctx.lineTo(ship.hull[i].x, ship.hull[i].y);
      rctx.closePath();
      if (hasUpperDeck) {
        for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
          rctx.rect(sp.x - 25, sp.y - 25, 50, 50);
        }
        rctx.clip('evenodd');
      } else {
        rctx.clip();
      }
      rctx.strokeStyle = hasUpperDeck ? '#b8824a' : '#7a4f28';
      rctx.lineWidth   = 1;
      rctx.beginPath();
      for (let y = minY + 12; y < maxY; y += 12) {
        rctx.moveTo(minX, y); rctx.lineTo(maxX, y);
      }
      rctx.stroke();
      rctx.restore();
    }

    // Hull outline stroke (rebuild hull-only path so hole rects are not outlined)
    rctx.beginPath();
    rctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    for (let i = 1; i < ship.hull.length; i++) rctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    rctx.closePath();
    rctx.strokeStyle = '#8B4513';
    rctx.lineWidth   = 2;
    rctx.stroke();

    this._shipHullSprites.set(ship.id, { canvas, key, ox, oy });
    return { canvas, ox, oy };
  }

  /**
   * Build or retrieve the cached ghost hull sprite.
   * Bakes the filled hull polygon + base outline stroke.
   * Dynamic effects (shadowBlur, spectral edge stroke, health alpha, mist overlay)
   * are applied at draw-time on the live canvas so the sprite only needs to be
   * rebuilt when the aggro fill-colour state flips (≤1× per ~220 ms).
   */
  private _getGhostHullSprite(
    ship: Ship,
    aggro: boolean,
  ): { canvas: OffscreenCanvas; ox: number; oy: number } | null {
    if (ship.hull.length < 3) return null;
    const key = `gh:${aggro ? 1 : 0}`;
    const existing = this._ghostHullSprites.get(ship.id);
    if (existing && existing.key === key) return { canvas: existing.canvas, ox: existing.ox, oy: existing.oy };

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of ship.hull) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const PAD = 4;
    const ox = Math.ceil(-minX) + PAD;
    const oy = Math.ceil(-minY) + PAD;
    const w  = Math.ceil(maxX - minX) + PAD * 2;
    const h  = Math.ceil(maxY - minY) + PAD * 2;
    if (w < 1 || h < 1) return null;

    const canvas = new OffscreenCanvas(w, h);
    const gctx   = canvas.getContext('2d')!;
    gctx.translate(ox, oy);

    gctx.fillStyle   = aggro ? '#1a0000' : '#0f0f1a';
    gctx.strokeStyle = '#0a0a16';
    gctx.lineWidth   = 2;

    gctx.beginPath();
    gctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    for (let i = 1; i < ship.hull.length; i++) gctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    gctx.closePath();
    gctx.fill();
    gctx.stroke();

    this._ghostHullSprites.set(ship.id, { canvas, key, ox, oy });
    return { canvas, ox, oy };
  }

  /**
   * Build or retrieve the cached ghost deck sprite — the runic circle arc and
   * 5 evenly-spaced tick marks baked in the spectral colour for the given
   * npcLevel bucket (12 buckets across levels 1–60).
   * The pulse alpha oscillation and slow rotation are applied at draw-time via
   * ctx.globalAlpha + ctx.rotate so the sprite is essentially permanent until
   * npcLevel changes.
   */
  private _getGhostDeckSprite(npcLevel: number): { canvas: OffscreenCanvas; cx: number; cy: number } | null {
    const bucket  = Math.ceil(Math.max(1, npcLevel) / 5); // 12 buckets (1-5, 6-10, … 56-60)
    const key     = `gd:${bucket}`;
    const existing = this._ghostDeckSprites.get(bucket);
    if (existing && existing.key === key) return { canvas: existing.canvas, cx: existing.cx, cy: existing.cy };

    const circleR = 55;
    const PAD     = 10; // room for the 6px shadowBlur
    const size    = Math.ceil((circleR + PAD) * 2);
    const cx      = circleR + PAD;
    const cy      = circleR + PAD;

    // Representative level for this bucket (midpoint)
    const repLvl  = (bucket - 1) * 5 + 3;
    const t       = Math.max(0, Math.min(1, (repLvl - 1) / 59));
    const r       = Math.round(t * 0);        // cyan→teal→red spectral range
    const g       = Math.round(220 * (1 - t) + 30 * t);
    const b       = Math.round(255 * (1 - t));
    const clr     = `rgb(${r},${g},${b})`;

    const canvas = new OffscreenCanvas(size, size);
    const dctx   = canvas.getContext('2d')!;

    // Circle arc
    dctx.strokeStyle = clr;
    dctx.lineWidth   = 1.5;
    dctx.shadowColor = clr;
    dctx.shadowBlur  = 6;
    dctx.beginPath();
    dctx.arc(cx, cy, circleR, 0, Math.PI * 2);
    dctx.stroke();

    // 5 tick marks
    dctx.lineWidth = 1.0;
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const cos   = Math.cos(angle);
      const sin   = Math.sin(angle);
      dctx.beginPath();
      dctx.moveTo(cx + cos * circleR,        cy + sin * circleR);
      dctx.lineTo(cx + cos * (circleR - 12), cy + sin * (circleR - 12));
      dctx.stroke();
    }

    this._ghostDeckSprites.set(bucket, { canvas, key, cx, cy });
    return { canvas, cx, cy };
  }

  /** Ship-local bounds for the full ghost static sprite (hull + phantom rigging). */
  private _ghostCombinedBounds(ship: Ship): { minX: number; maxX: number; minY: number; maxY: number } | null {
    if (ship.hull.length < 3) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const extend = (x: number, y: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const p of ship.hull) extend(p.x, p.y);
    for (const mast of RenderSystem.GHOST_PHANTOM_MASTS) {
      const halfW = mast.sailWidth * 0.5;
      extend(mast.x - halfW - 10, mast.y - mast.height * 1.4 - 10);
      extend(mast.x + halfW + 10, mast.y + mast.height * 1.4 + 10);
      extend(mast.x + mast.radius, mast.y + mast.radius);
    }
    const deckR = 55 + 14;
    extend(-deckR, -deckR);
    extend(deckR, deckR);
    const PAD = 22;
    return { minX: minX - PAD, maxX: maxX + PAD, minY: minY - PAD, maxY: maxY + PAD };
  }

  private _ghostCombinedCacheKey(ship: Ship, aggro: boolean): string {
    const bucket = Math.ceil(Math.max(1, ship.npcLevel ?? 1) / 5);
    return `gcomb:${aggro ? 1 : 0}:${bucket}`;
  }

  /**
   * Build or retrieve the combined static ghost ship sprite.
   * Bakes hull, rope rigging, phantom masts/sails, and the deck rune circle.
   * Cannons and animated overlays (fog, crew, spectral edge) are drawn live.
   */
  private _getGhostCombinedSprite(
    ship: Ship,
    aggro: boolean,
  ): { canvas: OffscreenCanvas; ox: number; oy: number } | null {
    const bounds = this._ghostCombinedBounds(ship);
    if (!bounds) return null;

    const key = this._ghostCombinedCacheKey(ship, aggro);
    const existing = this._ghostCombinedSprites.get(ship.id);
    if (existing && existing.key === key) return { canvas: existing.canvas, ox: existing.ox, oy: existing.oy };

    const ox = Math.ceil(-bounds.minX);
    const oy = Math.ceil(-bounds.minY);
    const w  = Math.ceil(bounds.maxX - bounds.minX);
    const h  = Math.ceil(bounds.maxY - bounds.minY);
    if (w < 1 || h < 1) return null;

    const canvas = new OffscreenCanvas(w, h);
    const gctx   = canvas.getContext('2d')!;
    gctx.translate(ox, oy);

    // Hull fill + base outline
    gctx.fillStyle   = aggro ? '#1a0000' : '#0f0f1a';
    gctx.strokeStyle = '#0a0a16';
    gctx.lineWidth   = 2;
    gctx.beginPath();
    gctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    for (let i = 1; i < ship.hull.length; i++) gctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    gctx.closePath();
    gctx.fill();
    gctx.stroke();

    this._bakeGhostRopesOnCtx(gctx);

    for (const mast of RenderSystem.GHOST_PHANTOM_MASTS) {
      this._bakePhantomMastOnCtx(gctx, mast.x, mast.y, mast.radius);
      this._bakePhantomSailOnCtx(gctx, mast.x, mast.y, mast.sailWidth, mast.height, mast.tearId);
    }

    this._ghostCombinedSprites.set(ship.id, { canvas, key, ox, oy });
    return { canvas, ox, oy };
  }

  /** Bake brig rope rigging for the fixed phantom mast layout (no ship modules). */
  private _bakeGhostRopesOnCtx(
    rctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ): void {
    rctx.strokeStyle = '#8B7355';
    rctx.lineWidth   = 1.2;
    rctx.lineCap     = 'round';

    for (const mast of RenderSystem.GHOST_PHANTOM_MASTS) {
      const mx = mast.x;
      const my = mast.y;
      const halfBase = mast.sailWidth * 0.5;
      const step = halfBase / 3;
      const x0 = mx - halfBase, x1 = mx - step, x2 = mx + step, x3 = mx + halfBase;

      for (const side of [1, -1] as const) {
        const ry0 = my + this.hullRailY(x0, side);
        const ry1 = my + this.hullRailY(x1, side);
        const ry2 = my + this.hullRailY(x2, side);
        const ry3 = my + this.hullRailY(x3, side);

        rctx.beginPath();
        rctx.moveTo(mx, my); rctx.lineTo(x0, ry0);
        rctx.moveTo(mx, my); rctx.lineTo(x3, ry3);
        rctx.moveTo(mx, my); rctx.lineTo(x1, ry1);
        rctx.moveTo(mx, my); rctx.lineTo(x2, ry2);
        for (const t of [1 / 3, 2 / 3]) {
          rctx.moveTo(mx + (x0 - mx) * t, my + (ry0 - my) * t);
          rctx.lineTo(mx + (x3 - mx) * t, my + (ry3 - my) * t);
        }
        rctx.moveTo(x0, ry0); rctx.lineTo(x1, ry1); rctx.lineTo(x2, ry2); rctx.lineTo(x3, ry3);
        rctx.stroke();

        for (const [cxA, cxB] of [[x0, x1], [x2, x3]] as [number, number][]) {
          const cy     = (this.hullRailY(cxA, side) + this.hullRailY(cxB, side)) / 2 + my;
          const angle  = Math.atan2(this.hullRailY(cxB, side) - this.hullRailY(cxA, side), cxB - cxA);
          const ccx    = (cxA + cxB) / 2;
          const bodyW  = Math.abs(cxB - cxA);
          const bodyH  = bodyW * 0.20;
          const hornW  = bodyH * 1.20;
          const hornH  = bodyH * 1.30;
          rctx.save();
          rctx.translate(ccx, cy);
          rctx.rotate(angle);
          rctx.fillStyle   = '#4A3728';
          rctx.strokeStyle = '#2C1F14';
          rctx.lineWidth   = 0.9;
          rctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
          rctx.strokeRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
          rctx.fillRect(-bodyW / 2, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.strokeRect(-bodyW / 2, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.fillRect(bodyW / 2 - hornW, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.strokeRect(bodyW / 2 - hornW, -bodyH / 2 - hornH, hornW, hornH * 2 + bodyH);
          rctx.restore();
        }
      }
    }
  }

  private _bakePhantomMastOnCtx(
    target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number, y: number, radius: number,
  ): void {
    target.shadowColor = '#00ccbb';
    target.shadowBlur  = 8;
    target.fillStyle   = '#0d1a18';
    target.strokeStyle = 'rgba(0,200,185,0.55)';
    target.lineWidth   = 1.5;
    target.beginPath();
    target.arc(x, y, radius, 0, Math.PI * 2);
    target.fill();
    target.stroke();
    target.shadowBlur = 0;
  }

  private _bakePhantomSailOnCtx(
    target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number, y: number, width: number, height: number, mastId: number,
    billow = 0, pulse = 0.52, t = 0, phase = mastId * 2.17,
  ): void {
    const sailTopY = -height * 1.4;
    const sailBotY = -sailTopY;
    const halfW    = width * 0.5;

    let tears = this._phantomSailTears.get(mastId);
    if (!tears) {
      let mseed = (mastId * 2654435761) >>> 0;
      const mrand = () => { mseed = (mseed * 1664525 + 1013904223) >>> 0; return mseed / 0xFFFFFFFF; };
      const tearCount = 9;
      const tearX: number[] = [];
      const tearY: number[] = [];
      for (let i = 0; i <= tearCount; i++) {
        tearX.push(-halfW + (i / tearCount) * width);
        tearY.push(sailBotY - mrand() * 28 - 4);
      }
      tears = { tearX, tearY };
      this._phantomSailTears.set(mastId, tears);
    }
    const { tearX, tearY } = tears;
    const tearCount = tearX.length - 1;

    target.save();
    target.translate(x, y);

    const buildPath = () => {
      target.beginPath();
      target.moveTo(-halfW, sailTopY);
      target.lineTo(halfW, sailTopY);
      target.quadraticCurveTo(halfW + billow * 0.7, 0, tearX[tearCount], tearY[tearCount]);
      for (let i = tearCount - 1; i >= 0; i--) target.lineTo(tearX[i], tearY[i]);
      target.quadraticCurveTo(-halfW + billow * 0.3, 0, -halfW, sailTopY);
      target.closePath();
    };

    target.shadowColor = '#00ddcc';
    target.shadowBlur  = 16;
    buildPath();
    target.strokeStyle = `rgba(0,210,200,${0.45 + 0.15 * Math.sin(t * 1.6 + phase)})`;
    target.lineWidth   = 1.5;
    target.stroke();
    target.shadowBlur = 0;

    const grad = target.createLinearGradient(-halfW, sailTopY, halfW, sailBotY);
    grad.addColorStop(0,    `rgba(0, 55, 45, ${pulse})`);
    grad.addColorStop(0.45, `rgba(0, 32, 26, ${pulse * 0.85})`);
    grad.addColorStop(1,    `rgba(0, 14, 11, ${pulse * 0.65})`);
    buildPath();
    target.fillStyle = grad;
    target.fill();

    target.save();
    buildPath();
    target.clip();
    const veinCount = 3;
    for (let v = 0; v < veinCount; v++) {
      const vx     = -halfW * 0.55 + v * (halfW * 0.55);
      const vAlpha = 0.28 + 0.18 * Math.sin(t * 2.1 + v * 1.5 + phase);
      target.shadowColor = '#00ffee';
      target.shadowBlur  = 5;
      target.strokeStyle = `rgba(0, 230, 215, ${vAlpha})`;
      target.lineWidth   = 0.9;
      target.beginPath();
      target.moveTo(vx, sailTopY + 4);
      target.quadraticCurveTo(vx + billow * 0.35, 0, vx + billow * 0.15, sailBotY - 18);
      target.stroke();
    }
    target.restore();

    target.shadowColor = '#00ccbb';
    target.shadowBlur  = 6;
    target.strokeStyle = '#1a4a40';
    target.lineWidth   = 2.5;
    target.beginPath();
    target.moveTo(-halfW - 6, sailTopY);
    target.lineTo(halfW + 6, sailTopY);
    target.stroke();
    target.shadowBlur = 0;

    target.restore();
  }

  private _getScratch(name: string, w: number, h: number): OffscreenCanvas {
    let c = this._scratchCanvases.get(name);
    if (!c || c.width !== w || c.height !== h) {
      c = new OffscreenCanvas(w, h);
      this._scratchCanvases.set(name, c);
      return c;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.clearRect(0, 0, w, h);
    return c;
  }
  /**
   * Pre-computed wall segments — rebuilt whenever placedStructures changes.
   * Each entry: [x1, y1, x2, y2] in world space.  Used for O(1)-per-frame
   * ceiling-transparency ray tests instead of recomputing each draw call.
   */
  private _wallSegs: Float32Array = new Float32Array(0);
  private _wallSegsFloorCount = 0; // floor count at last rebuild (tracks floor changes too)
  /** Cached visibility polygon (world-space points) for the building shadow overlay. */
  private _visPolyPts: Float32Array = new Float32Array(0);
  private _visPolyPx = NaN;
  private _visPolyPy = NaN;
  private _visPolyWallRev = 0;  // incremented on every _rebuildWallSegs
  private _visPolyLastRev = -1; // last rev seen when poly was built — rebuild when different
  /** Active tombstone item caches in the world. */
  private _tombstones: import('../../sim/Types').Tombstone[] = [];
  /** Ship-local attachment data for tombstones that spawned on a ship. */
  private _tombstoneShipAttach: Map<number, { shipId: number; localX: number; localY: number }> = new Map();
  /** Ships from the last rendered frame — used for tombstone ship-tracking. */
  private _cachedWorldShips: Ship[] = [];
  /** Players from the last rendered frame — used for NPC owner resolution in tooltips. */
  private _cachedWorldPlayers: Player[] = [];
  /** NPCs from the last rendered frame — used for solo ship ownership checks. */
  private _cachedWorldNpcs: import('../../sim/Types').Npc[] = [];
  /** Dynamic companies from the last rendered frame — used for name resolution in tooltips. */
  private _cachedCompanies: Company[] = [];
  /** Dropped items in the world (player-dropped inventory items). */
  private _droppedItems: import('../../sim/Types').DroppedItem[] = [];
  /** Pickup radius — matches server handle_pickup_item distance check. */
  static readonly DROPPED_ITEM_PICKUP_RANGE = 80;
  /** Maps scaffolded ship entity IDs to the shipyard structure that owns them. */
  private _scaffoldedShips: Map<number, PlacedStructure> = new Map();
  /** Structure currently under the cursor (within hover range of the local player). */
  private _hoveredStructure: PlacedStructure | null = null;
  /** ID of the structure that blocked the last placement attempt (shown in red during build mode). */
  private _blockerStructureId: number | null = null;
  /** Timestamp when the blocker highlight should expire (ms). */
  private _blockerExpiry = 0;
  /** Fiber bushes pending draw — populated by drawIsland, consumed after the render queue (above players). */
  private _pendingBushes: Array<{
    sp: { x: number; y: number };
    isHovered: boolean; bushAlpha: number; deathAlpha: number;
    ox: number; oy: number;
    wx: number; wy: number;
  }> = [];
  /** Wood ceiling tiles pending draw — populated by drawPlacedStructures, consumed by drawPendingCeilings after bushes. */
  private _pendingCeilings: Array<{
    s: PlacedStructure;
    ssp: { x: number; y: number };
    sz: number;
    isHovered: boolean;
  }> = [];
  /** All visible resources — populated by drawIsland, leaves+prompts drawn after bushes in renderWorld. */
  private _pendingAllRes: Array<{
    res: { ox: number; oy: number; type: string; size: number; hp: number; maxHp: number; depletedAt?: number };
    wx: number; wy: number;
    sp: { x: number; y: number };
    isHovered: boolean; inRange: boolean; playerNear: boolean;
    leafAlpha: number; bushAlpha: number; boulderAlpha: number; deathAlpha: number;
  }> = [];
  private _pendingAxeEquipped     = false;
  private _pendingPickaxeEquipped = false;
  /** Tree node currently under cursor (world coords) — updated each frame in drawIsland. */
  private _hoveredTree: { wx: number; wy: number; size: number } | null = null;
  /** Fiber plant currently under cursor (world coords) — updated each frame in drawIsland. */
  private _hoveredFiberPlant: { wx: number; wy: number; size: number } | null = null;
  /** Rock node currently under cursor (world coords) — updated each frame in drawIsland. */
  private _hoveredRock: { wx: number; wy: number; size: number } | null = null;
  /** Boulder node currently under cursor (world coords + size) — updated each frame in drawIsland. */
  private _hoveredBoulder: { wx: number; wy: number; size: number } | null = null;
  /** Boulders pending draw — populated by drawIsland, consumed after tree leaves in renderWorld. */
  private _pendingBoulders: Array<{
    sp: { x: number; y: number };
    isHovered: boolean; boulderAlpha: number; deathAlpha: number;
    ox: number; oy: number; size: number;
  }> = [];
  /** When non-null, draw an island placement ghost at mouseWorldPos for this item kind. */
  private islandBuildKind: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag' | 'chest' | 'bed' | null = null;
  /** Active Build Schematic Hotbar selection — used to detect ghost plan hover for construction. */
  private buildSchematicKind: string | null = null;
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
  /** Returns true when the island build ghost is currently being drawn (kind is set). */
  isIslandBuildGhostActive(): boolean { return this.islandBuildKind !== null; }
  /** Returns the current snapped placement position (or null when no ghost is active). */
  getSnappedBuildPos(): { x: number; y: number } | null { return this._snappedBuildPos; }
  /** Returns the rotation (deg) inherited from the snap source tile, or null if freely placing. */
  getSnappedBuildRotation(): number | null { return this._snappedBuildRotation; }

  /** ID of the land ghost plan marker the cursor is hovering while a build item is active. */
  private _hoveredLandGhostId: string | null = null;
  /** Returns the land ghost plan being hovered while a matching build item is active, or null. */
  getHoveredLandGhost(): LandGhostPlacement | null {
    if (!this._hoveredLandGhostId) return null;
    return this.landGhostPlacements.find(g => g.id === this._hoveredLandGhostId) ?? null;
  }
  /** Current aim angle relative to ship (from InputManager), used for cannon sector filtering. */
  public playerAimAngleRelative: number = 0;
  /** Currently selected ammo type (0 = cannonball, 1 = bar shot), set each frame by ClientApplication. */
  public selectedAmmoType: number = 0;
  /** npcId → task name map set each frame by ClientApplication; used to colour NPCs by task. */
  public npcTaskMap: ReadonlyMap<number, string> = new Map();
  private hoveredPlankSlot: { ship: Ship; sectionName: string; segmentIndex: number } | null = null;
  private plankTemplate: PlankSegment[] | null = null;
  /** `${shipId}_${section}_${seg}` → wall-clock ms when wreckage clears (blocks placement). */
  private plankWreckageUntil = new Map<string, number>();
  /** shipId → timestamp (ms) when ship entered the sink-fade sequence — drives the animation. */
  private sinkTimestamps: Map<number, number> = new Map();
  /** Frozen ship snapshots for despawned ships — client-side sink animation ghosts. */
  private sinkingGhosts: Map<number, Ship> = new Map();
  /** Last known ship state per id — lets us snapshot a ship the moment it despawns. */
  private lastKnownShips: Map<number, Ship> = new Map();
  /** moduleId → smoothed barrel aim angle (radians) — interpolated every frame toward server value. */
  private _smoothBarrelAngles: Map<number, number> = new Map();
  /** moduleId → smoothed sail rotation angle (degrees) — interpolated every frame toward server value. */
  private _smoothSailAngles: Map<number, number> = new Map();
  /** moduleId → smoothed sail openness (0–100) — interpolated every frame toward server value. */
  private _smoothSailOpenness: Map<number, number> = new Map();
  /** shipId → smoothed rudder angle (radians) — interpolated every frame toward server value. */
  private _smoothRudderAngles: Map<number, number> = new Map();
  /** shipId → current sail-fiber alpha, interpolated toward 0.30 when on deck or 1.0 otherwise. */
  private _sailAlphaByShip: Map<number, number> = new Map();
  /** Timestamp (ms) of the last renderWorld call — used to compute per-frame dt for barrel smoothing. */
  private _lastRenderMs: number = 0;
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

  /** Returns a CSS color for a structure's owning company strip. */
  private static structureCompanyColor(companyId: number): string {
    return structureCompanyStripColor(companyId);
  }

  /** Blit cached base sprite for a placed structure; returns draw rotation used. */
  private _blitStructureBase(
    s: PlacedStructure,
    ssp: { x: number; y: number },
    zoom: number,
    camRot: number,
    isHovered: boolean,
    isBlocker: boolean,
    wallRotRad?: number,
  ): number | null {
    const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
    const resolved = getStructureBaseSprite(this._structureSpriteCache, s, {
      hovered: isHovered,
      blocker: isBlocker,
      companyId: s.companyId,
      hpFrac,
      wallRotRad,
    });
    if (!resolved) return null;
    const alpha = s.type === 'wreck' ? (isHovered ? 1.0 : 0.88) : 1;
    blitStructureSprite(this.ctx, resolved.sprite, ssp.x, ssp.y, zoom, resolved.rotRad, camRot, alpha);
    return resolved.rotRad;
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
  // ── Tree leaf sprite cache ──────────────────────────────────────────────────
  private static _treeLeafSprites: Map<string, OffscreenCanvas> | null = null;
  private static readonly TREE_SPRITE_SIZE = 256;
  private static readonly TREE_ROT_BINS    = 8;
  private static readonly TREE_TINTS: [string, string, string, string][] = [
    ['#1a3a0a', '#3a7320', '#52a030', '#6ecf42'],
    ['#1c3e08', '#3f7a18', '#5aae2e', '#74d93e'],
    ['#152f08', '#2e6318', '#456e22', '#5a9030'],
    ['#233a10', '#4a7c28', '#5fa035', '#72b845'],
  ];

  private static _ensureTreeSprites(): Map<string, OffscreenCanvas> {
    if (RenderSystem._treeLeafSprites) return RenderSystem._treeLeafSprites;
    const SIZE      = RenderSystem.TREE_SPRITE_SIZE;
    const BINS      = RenderSystem.TREE_ROT_BINS;
    const ROT_RANGE = Math.PI / 3.6;
    const canopy    = SIZE * 0.38;
    const cx = SIZE / 2, cy = SIZE / 2;
    const BASE_L: [number, number, number][] = [
      [  0.00, -0.22, 0.80 ],
      [ -0.44,  0.00, 0.62 ],
      [  0.46,  0.05, 0.58 ],
      [ -0.20,  0.40, 0.50 ],
      [  0.25,  0.38, 0.48 ],
    ];
    const sprites = new Map<string, OffscreenCanvas>();
    for (let tintIdx = 0; tintIdx < 4; tintIdx++) {
      const [shadowCol, baseCol, hlCol, glintCol] = RenderSystem.TREE_TINTS[tintIdx];
      for (let bin = 0; bin < BINS; bin++) {
        const clusterRot = -ROT_RANGE + (bin / (BINS - 1)) * 2 * ROT_RANGE;
        const c = Math.cos(clusterRot), s = Math.sin(clusterRot);
        const rot = (dx: number, dy: number): [number, number] =>
          [dx * c - dy * s, dx * s + dy * c];
        const L = BASE_L.map(([dx, dy, r]) => { const [rx, ry] = rot(dx, dy); return [rx, ry, r] as [number, number, number]; });
        const off = new OffscreenCanvas(SIZE, SIZE);
        const ctx = off.getContext('2d')!;
        // Pass 1: shadow
        ctx.fillStyle = shadowCol;
        for (const [dx, dy, r] of L) { ctx.beginPath(); ctx.arc(cx + (dx + 0.13) * canopy, cy + (dy + 0.11) * canopy, r * canopy, 0, Math.PI * 2); ctx.fill(); }
        // Pass 2: base
        ctx.fillStyle = baseCol;
        for (const [dx, dy, r] of L) { ctx.beginPath(); ctx.arc(cx + dx * canopy, cy + dy * canopy, r * canopy, 0, Math.PI * 2); ctx.fill(); }
        // Pass 3: highlight
        ctx.fillStyle = hlCol;
        for (const [dx, dy, r] of L.slice(0, 3)) { ctx.beginPath(); ctx.arc(cx + (dx - 0.10) * canopy, cy + (dy - 0.15) * canopy, r * canopy * 0.62, 0, Math.PI * 2); ctx.fill(); }
        // Pass 4: specular glint
        const [apexRx, apexRy] = rot(-0.09, -0.34);
        ctx.fillStyle = glintCol;
        ctx.beginPath(); ctx.arc(cx + apexRx * canopy, cy + apexRy * canopy, canopy * 0.25, 0, Math.PI * 2); ctx.fill();
        sprites.set(`${tintIdx}_${bin}`, off);
      }
    }
    RenderSystem._treeLeafSprites = sprites;
    return sprites;
  }

  // ── Rock sprite cache — 4 tones × 3 shapes ─────────────────────────────────
  private static _rockSprites: Map<string, OffscreenCanvas> | null = null;
  private static readonly ROCK_SPRITE_SIZE = 96;
  private static readonly ROCK_SPRITE_R    = 22;
  private static readonly ROCK_TONES = [
    { body: '#888890', shadow: '#555560', hi: '#b8b8c0', crack: '#666670' }, // grey
    { body: '#8a7060', shadow: '#5a4030', hi: '#b09080', crack: '#6a5040' }, // brown
    { body: '#a09060', shadow: '#6a5830', hi: '#c8b080', crack: '#807040' }, // tan
    { body: '#505058', shadow: '#303038', hi: '#808088', crack: '#404048' }, // dark
  ];
  // Shape variants: [xScale, yScale, rotation, crackX1,crackY1,crackX2,crackY2 as fraction of R]
  private static readonly ROCK_SHAPES: [number, number, number, number, number, number, number][] = [
    [1.0,  0.70,  0.0,   -0.10, -0.20,  0.25,  0.30], // standard flat
    [0.85, 0.85,  0.3,    0.05, -0.30, -0.20,  0.20], // rounder, tilted
    [1.15, 0.55, -0.2,   -0.20, -0.10,  0.30,  0.25], // wide flat
  ];

  private static _ensureRockSprites(): Map<string, OffscreenCanvas> {
    if (RenderSystem._rockSprites) return RenderSystem._rockSprites;
    const SIZE = RenderSystem.ROCK_SPRITE_SIZE;
    const R    = RenderSystem.ROCK_SPRITE_R;
    const cx = SIZE / 2, cy = SIZE / 2;
    const sprites = new Map<string, OffscreenCanvas>();
    for (let ti = 0; ti < RenderSystem.ROCK_TONES.length; ti++) {
      const tone = RenderSystem.ROCK_TONES[ti];
      for (let si = 0; si < RenderSystem.ROCK_SHAPES.length; si++) {
        const [sx, sy, rot, cx1, cy1, cx2, cy2] = RenderSystem.ROCK_SHAPES[si];
        for (const hovered of [false, true]) {
          const off = new OffscreenCanvas(SIZE, SIZE);
          const ctx = off.getContext('2d')!;
          // Shadow
          ctx.beginPath();
          ctx.ellipse(cx + R * 0.18, cy + R * 0.18 * sy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = tone.shadow; ctx.fill();
          // Body
          ctx.beginPath();
          ctx.ellipse(cx, cy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = hovered ? tone.hi : tone.body; ctx.fill();
          if (hovered) {
            ctx.strokeStyle = '#ffe090'; ctx.lineWidth = 2;
            ctx.stroke();
          } else {
            ctx.strokeStyle = tone.shadow; ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          // Highlight fleck
          ctx.beginPath();
          ctx.ellipse(cx - R * sx * 0.28, cy - R * sy * 0.28, R * sx * 0.26, R * sy * 0.18, rot - 0.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.fill();
          // Crack
          ctx.strokeStyle = tone.crack; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx + R * cx1, cy + R * cy1);
          ctx.lineTo(cx + R * cx2, cy + R * cy2);
          ctx.stroke();
          sprites.set(`${ti}_${si}_${hovered ? 'h' : 'n'}`, off);
        }
      }
    }
    RenderSystem._rockSprites = sprites;
    return sprites;
  }

  // ── Boulder sprite cache — 3 stone tones + 3 metal tones × 5 shapes ────
  private static _boulderSprites: Map<string, OffscreenCanvas> | null = null;
  private static readonly BOULDER_SPRITE_SIZE = 160;
  private static readonly BOULDER_SPRITE_R    = 52; // reference half-size within sprite
  private static readonly BOULDER_TONES = [
    // Stone tones (indices 0-2)
    { body: '#797975', shadow: '#44443f', hi: '#aaaaa4', crack: '#55554f', moss: '#5a7040' },
    { body: '#8a7860', shadow: '#504030', hi: '#b09880', crack: '#60503a', moss: '#607848' },
    { body: '#585858', shadow: '#303030', hi: '#888888', crack: '#404040', moss: '#4a6038' },
    // Metal/iron tones (indices 3-5) — dark blue-grey iron with metallic sheen
    { body: '#4a5260', shadow: '#252b35', hi: '#7a8898', crack: '#303840', moss: '#384858' },
    { body: '#3e4a58', shadow: '#202830', hi: '#6a7a8a', crack: '#2a3240', moss: '#2e3e50' },
    { body: '#525a6a', shadow: '#2a3040', hi: '#8090a4', crack: '#363e50', moss: '#404e60' },
  ];
  private static readonly BOULDER_METAL_TONE_OFFSET = 3;
  private static readonly BOULDER_SHAPES: [number, number, number][] = [
    [1.00, 0.72, 0.0],   // flat classic
    [0.88, 0.88, 0.4],   // round
    [1.18, 0.60, -0.2],  // wide flat
    [0.72, 1.00, 1.2],   // tall upright
    [1.35, 0.50, 0.15],  // very wide slab
  ];

  private static _ensureBoulderSprites(): Map<string, OffscreenCanvas> {
    if (RenderSystem._boulderSprites) return RenderSystem._boulderSprites;
    const SIZE = RenderSystem.BOULDER_SPRITE_SIZE;
    const R    = RenderSystem.BOULDER_SPRITE_R;
    const cx = SIZE / 2, cy = SIZE / 2;
    const sprites = new Map<string, OffscreenCanvas>();

    for (let ti = 0; ti < RenderSystem.BOULDER_TONES.length; ti++) {
      const tone = RenderSystem.BOULDER_TONES[ti];
      const isMetal = ti >= RenderSystem.BOULDER_METAL_TONE_OFFSET;
      for (let si = 0; si < RenderSystem.BOULDER_SHAPES.length; si++) {
        const [sx, sy, rot] = RenderSystem.BOULDER_SHAPES[si];
        for (const hovered of [false, true]) {
          const off = new OffscreenCanvas(SIZE, SIZE);
          const ctx = off.getContext('2d')!;

          // Soft ground shadow
          ctx.beginPath();
          ctx.ellipse(cx + R * 0.20, cy + R * 0.25 * sy, R * sx * 1.10, R * sy * 0.35, rot, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fill();

          // Body shadow (offset copy)
          ctx.beginPath();
          ctx.ellipse(cx + R * 0.15, cy + R * 0.12 * sy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = tone.shadow; ctx.fill();

          // Main body
          ctx.beginPath();
          ctx.ellipse(cx, cy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = hovered ? tone.hi : tone.body;
          ctx.fill();
          ctx.strokeStyle = hovered ? '#ffe090' : tone.shadow;
          ctx.lineWidth = hovered ? 3 : 2;
          ctx.stroke();

          // Large highlight — more pronounced metallic sheen for metal nodes
          ctx.beginPath();
          ctx.ellipse(cx - R * sx * 0.28, cy - R * sy * 0.28, R * sx * 0.38, R * sy * 0.26, rot - 0.6, 0, Math.PI * 2);
          ctx.fillStyle = isMetal ? 'rgba(160,200,255,0.28)' : 'rgba(255,255,255,0.22)'; ctx.fill();

          // Specular fleck
          ctx.beginPath();
          ctx.arc(cx - R * sx * 0.35, cy - R * sy * 0.38, R * 0.08, 0, Math.PI * 2);
          ctx.fillStyle = isMetal ? 'rgba(180,220,255,0.55)' : 'rgba(255,255,255,0.40)'; ctx.fill();

          if (isMetal) {
            // Metal: bright thin streak highlight instead of moss
            ctx.beginPath();
            ctx.ellipse(cx - R * sx * 0.18, cy - R * sy * 0.22, R * sx * 0.15, R * sy * 0.06, rot - 0.3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(190,220,255,0.35)'; ctx.fill();
          } else {
            // Stone: moss patches (3 blobs near base)
            for (let m = 0; m < 3; m++) {
              const ma = rot + m * 0.7 + 0.3;
              const mx = cx + Math.cos(ma) * R * sx * 0.55;
              const my = cy + R * sy * 0.48 + Math.sin(ma) * R * sy * 0.12;
              ctx.beginPath();
              ctx.ellipse(mx, my, R * 0.14, R * 0.08, ma, 0, Math.PI * 2);
              ctx.fillStyle = tone.moss; ctx.fill();
            }
          }

          // Two crack lines
          ctx.strokeStyle = tone.crack; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx - R * sx * 0.10, cy - R * sy * 0.30);
          ctx.lineTo(cx + R * sx * 0.28, cy + R * sy * 0.32);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx + R * sx * 0.05, cy - R * sy * 0.18);
          ctx.lineTo(cx - R * sx * 0.22, cy + R * sy * 0.20);
          ctx.stroke();

          sprites.set(`${ti}_${si}_${hovered ? 'h' : 'n'}`, off);
        }
      }
    }
    RenderSystem._boulderSprites = sprites;
    return sprites;
  }
  private static _fiberSprites: Map<string, OffscreenCanvas> | null = null;
  private static readonly FIBER_SPRITE_SIZE = 96;
  private static readonly FIBER_SPRITE_H    = 32; // reference radius for draw-size math
  private static readonly FIBER_ROT_BINS    = 4;  // reused as shape variant count
  private static readonly FIBER_TINTS = [
    { shadow: '#2a5010', mid: '#4a7a20', bright: '#78b838', hi: '#a8e050' }, // green
    { shadow: '#203a08', mid: '#3c6618', bright: '#62a028', hi: '#90cc48' }, // deep green
    { shadow: '#3a5010', mid: '#607020', bright: '#96b030', hi: '#c0dc58' }, // yellow-green
    { shadow: '#284818', mid: '#486830', bright: '#6c9848', hi: '#98c070' }, // sage
  ];
  // Each variant: cluster offsets as [dx, dy, r] fractions of base radius
  private static readonly FIBER_CLUSTERS: [number, number, number][][] = [
    [ [-0.55,-0.30,0.55], [0.55,-0.30,0.50], [0.00,-0.62,0.52], [0.00, 0.10,0.48] ], // symmetric dome
    [ [-0.60,-0.18,0.52], [0.50,-0.38,0.48], [0.05,-0.65,0.50], [-0.10,0.08,0.44] ], // lean left
    [ [-0.45,-0.40,0.50], [0.60,-0.20,0.54], [0.02,-0.60,0.48], [ 0.12,0.12,0.46] ], // lean right
    [ [-0.50,-0.35,0.56], [0.50,-0.35,0.50], [-0.05,-0.72,0.44],[0.05,-0.10,0.52] ], // tall crown
  ];

  private static _ensureFiberSprites(): Map<string, OffscreenCanvas> {
    if (RenderSystem._fiberSprites) return RenderSystem._fiberSprites;
    const SIZE = RenderSystem.FIBER_SPRITE_SIZE;
    const BR   = 18; // base radius in sprite pixels
    const cx = SIZE / 2, cy = SIZE * 0.60; // anchor slightly below centre
    const sprites = new Map<string, OffscreenCanvas>();

    for (let ti = 0; ti < RenderSystem.FIBER_TINTS.length; ti++) {
      const tint = RenderSystem.FIBER_TINTS[ti];
      const clusters = RenderSystem.FIBER_CLUSTERS[ti % RenderSystem.FIBER_CLUSTERS.length];
      for (let vi = 0; vi < RenderSystem.FIBER_ROT_BINS; vi++) {
        const vc = RenderSystem.FIBER_CLUSTERS[vi];
        for (const hovered of [false, true]) {
          const off = new OffscreenCanvas(SIZE, SIZE);
          const ctx = off.getContext('2d')!;

          // Ground shadow
          ctx.beginPath();
          ctx.ellipse(cx + 2, cy + 3, BR * 0.90, BR * 0.28, 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fill();

          // Stem stubs
          ctx.strokeStyle = tint.shadow; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
          for (let s = -1; s <= 1; s++) {
            ctx.beginPath();
            ctx.moveTo(cx + s * BR * 0.28, cy);
            ctx.lineTo(cx + s * BR * 0.18, cy - BR * 0.55);
            ctx.stroke();
          }

          // Back clusters (drawn first = behind)
          for (let ci = 0; ci < vc.length; ci++) {
            const [dx, dy, fr] = vc[ci];
            if (ci >= 2) continue; // back row only
            const bx = cx + dx * BR, by = cy + dy * BR, r = fr * BR;
            ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
            ctx.fillStyle = tint.shadow; ctx.fill();
          }

          // Mid clusters
          for (let ci = 0; ci < vc.length; ci++) {
            const [dx, dy, fr] = vc[ci];
            const bx = cx + dx * BR, by = cy + dy * BR, r = fr * BR;
            ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
            ctx.fillStyle = hovered ? tint.bright : tint.mid; ctx.fill();
            if (hovered) {
              ctx.strokeStyle = '#ffe090'; ctx.lineWidth = 1.5; ctx.stroke();
            }
          }

          // Bright top foliage blobs
          for (let ci = 0; ci < vc.length; ci++) {
            const [dx, dy, fr] = vc[ci];
            const bx = cx + dx * BR * 0.72, by = cy + dy * BR * 0.72, r = fr * BR * 0.55;
            ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
            ctx.fillStyle = hovered ? tint.hi : tint.bright; ctx.fill();
          }

          // Specular highlight on top cluster
          const [tx, ty] = vc[2] ?? vc[0];
          ctx.beginPath();
          ctx.arc(cx + tx * BR * 0.5 - BR * 0.1, cy + ty * BR * 0.5 - BR * 0.1, BR * 0.18, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fill();

          sprites.set(`${ti}_${vi}_${hovered ? 'h' : 'n'}`, off);
        }
      }
    }
    RenderSystem._fiberSprites = sprites;
    return sprites;
  }


  private static _trunkSprites: Map<string, OffscreenCanvas> | null = null;
  private static readonly TRUNK_SPRITE_SIZE = 96;
  private static readonly TRUNK_SPRITE_R    = 30; // reference radius within sprite

  private static _ensureTrunkSprites(): Map<string, OffscreenCanvas> {
    if (RenderSystem._trunkSprites) return RenderSystem._trunkSprites;
    const SIZE = RenderSystem.TRUNK_SPRITE_SIZE;
    const R    = RenderSystem.TRUNK_SPRITE_R;
    const cx = SIZE / 2, cy = SIZE / 2;
    const sprites = new Map<string, OffscreenCanvas>();
    for (const hovered of [false, true]) {
      const off = new OffscreenCanvas(SIZE, SIZE);
      const ctx = off.getContext('2d')!;
      // Shadow
      ctx.fillStyle = '#2e1a0a';
      ctx.beginPath(); ctx.arc(cx + R * 0.22, cy + R * 0.22, R, 0, Math.PI * 2); ctx.fill();
      // Body
      ctx.fillStyle = '#7a4820';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      // Highlight crescent
      ctx.fillStyle = '#a0642e';
      ctx.beginPath(); ctx.arc(cx - R * 0.28, cy - R * 0.22, R * 0.45, 0, Math.PI * 2); ctx.fill();
      // Hover ring baked in for the hovered variant
      if (hovered) {
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.arc(cx, cy, R + 3, 0, Math.PI * 2); ctx.stroke();
      }
      sprites.set(hovered ? 'hovered' : 'normal', off);
    }
    // In-range hovered variant (gold ring)
    {
      const off = new OffscreenCanvas(SIZE, SIZE);
      const ctx = off.getContext('2d')!;
      ctx.fillStyle = '#2e1a0a';
      ctx.beginPath(); ctx.arc(cx + R * 0.22, cy + R * 0.22, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7a4820';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a0642e';
      ctx.beginPath(); ctx.arc(cx - R * 0.28, cy - R * 0.22, R * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#f0c040';
      ctx.lineWidth   = 2;
      ctx.beginPath(); ctx.arc(cx, cy, R + 3, 0, Math.PI * 2); ctx.stroke();
      sprites.set('inrange', off);
    }
    RenderSystem._trunkSprites = sprites;
    return sprites;
  }

  private static readonly DEFAULT_ISLAND = {
    id: 0, x: 50800, y: 50600, preset: 'tropical' as const,
    resources: [
      { ox: -65, oy: -55, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox:  85, oy: -25, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox:  15, oy:  80, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox: -90, oy:  38, type: 'wood'  as const, size: 1.0, hp: 100, maxHp: 100 },
      { ox:  45, oy: -78, type: 'fiber' as const, size: 1.0, hp: 150, maxHp: 150 },
      { ox: -28, oy:  32, type: 'fiber' as const, size: 1.0, hp: 150, maxHp: 150 },
      { ox:  70, oy:  50, type: 'fiber' as const, size: 1.0, hp: 150, maxHp: 150 },
    ],
  };

  private static readonly RESOURCE_GRID_CELL = 220;

  private static gridKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private static toGridCoord(v: number, cellSize: number): number {
    return Math.floor(v / cellSize);
  }

  private buildResourceGrid(island: RenderIsland): void {
    const cellSize = RenderSystem.RESOURCE_GRID_CELL;
    const cells = new Map<string, number[]>();
    for (let ri = 0; ri < island.resources.length; ri++) {
      const res = island.resources[ri];
      const wx = island.x + res.ox;
      const wy = island.y + res.oy;
      const cx = RenderSystem.toGridCoord(wx, cellSize);
      const cy = RenderSystem.toGridCoord(wy, cellSize);
      const key = RenderSystem.gridKey(cx, cy);
      let bucket = cells.get(key);
      if (!bucket) {
        bucket = [];
        cells.set(key, bucket);
      }
      bucket.push(ri);
    }
    island.resourceGrid = { cellSize, cells };
  }

  private queryResourceIndices(island: RenderIsland, minX: number, minY: number, maxX: number, maxY: number): number[] {
    const cellSize = island.resourceGrid.cellSize;
    const cx0 = RenderSystem.toGridCoord(minX, cellSize);
    const cy0 = RenderSystem.toGridCoord(minY, cellSize);
    const cx1 = RenderSystem.toGridCoord(maxX, cellSize);
    const cy1 = RenderSystem.toGridCoord(maxY, cellSize);

    const out: number[] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = island.resourceGrid.cells.get(RenderSystem.gridKey(cx, cy));
        if (!bucket) continue;
        out.push(...bucket);
      }
    }
    return out;
  }

  private decorateIsland(island: RenderIslandInput): RenderIsland {
    const normalized: RenderIslandInput = {
      ...island,
      vertices: island.vertices && island.vertices.length >= 3 ? island.vertices : undefined,
      grassVertices: island.grassVertices && island.grassVertices.length >= 3 ? island.grassVertices : undefined,
      shallowVertices: island.shallowVertices && island.shallowVertices.length >= 3 ? island.shallowVertices : undefined,
    };
    const decorated: RenderIsland = {
      ...normalized,
      resourceGrid: { cellSize: RenderSystem.RESOURCE_GRID_CELL, cells: new Map<string, number[]>() },
    };
    this.buildResourceGrid(decorated);
    return decorated;
  }

  /** Live island list — replaced by server ISLANDS message when received. */
  private islands: RenderIsland[] = [];

  /** Called by ClientApplication when the server sends the ISLANDS message. */
  setIslands(islands: RenderIslandInput[]): void {
    this.islands = islands.map((i) => this.decorateIsland(i));
  }

  /** Returns the live island list (for proximity checks in ClientApplication). */
  getIslands(): RenderIslandInput[] {
    return this.islands;
  }

  /**
   * Configure world-wrap rendering. Rendering ghosts are visual-only and do not
   * affect gameplay state or collision logic.
   */
  setWorldWrapConfig(enabled: boolean, worldWidth: number, worldHeight: number): void {
    this._wrapWorldWidth = Math.max(0, worldWidth || 0);
    this._wrapWorldHeight = Math.max(0, worldHeight || 0);
    this._wrapRenderEnabled = !!enabled && this._wrapWorldWidth > 0 && this._wrapWorldHeight > 0;
  }

  private getWrapRenderOffsets(position: Vec2, camera: Camera, margin: number): Array<{ dx: number; dy: number }> {
    const offsets: Array<{ dx: number; dy: number }> = [{ dx: 0, dy: 0 }];
    if (!this._wrapRenderEnabled) return offsets;

    const w = this._wrapWorldWidth;
    const h = this._wrapWorldHeight;
    const candidates: Array<{ dx: number; dy: number }> = [
      { dx: -w, dy: 0 }, { dx: w, dy: 0 },
      { dx: 0, dy: -h }, { dx: 0, dy: h },
      { dx: -w, dy: -h }, { dx: -w, dy: h },
      { dx: w, dy: -h }, { dx: w, dy: h },
    ];

    for (const off of candidates) {
      const shifted = Vec2.from(position.x + off.dx, position.y + off.dy);
      if (camera.isWorldPositionVisible(shifted, margin)) offsets.push(off);
    }
    return offsets;
  }

  /** Returns ships visible in the current fog fan (carrier always included). Reuses scratch buffer. */
  private _collectFogVisibleShips(
    ships: readonly import('../../sim/Types.js').Ship[],
    carrierId: number,
    camera: Camera,
  ): import('../../sim/Types.js').Ship[] {
    const out = this._visibleShipsScratch;
    out.length = 0;
    for (const s of ships) {
      const always = s.id === carrierId;
      if (!this._shouldRenderEntityAt(s.position.x, s.position.y, this._hullRadius(s), camera, always)) continue;
      out.push(s);
    }
    return out;
  }

  /** Camera frustum + renderDistance + fog gate for queueWorldObjects. */
  private _shouldRenderEntityAt(
    wx: number,
    wy: number,
    margin: number,
    camera: Camera,
    alwaysInclude: boolean,
  ): boolean {
    if (!camera.isWorldPositionVisible(Vec2.from(wx, wy), margin)) return false;
    if (alwaysInclude) return true;
    const rd = this.config.renderDistance;
    if (rd > 0) {
      const cam = camera.getState().position;
      const limit = rd + margin;
      const dx = wx - cam.x;
      const dy = wy - cam.y;
      if (dx * dx + dy * dy > limit * limit) return false;
    }
    return this.fogVisibleAt(wx, wy, margin);
  }

  private _collectVisiblePlayers(players: readonly Player[], camera: Camera): Player[] {
    const out = this._visiblePlayersScratch;
    out.length = 0;
    for (const p of players) {
      if (p.health <= 0 && p.id !== this.localPlayerId) continue;
      const always = p.id === this.localPlayerId;
      if (!this._shouldRenderEntityAt(p.position.x, p.position.y, 80, camera, always)) continue;
      out.push(p);
    }
    return out;
  }

  private _collectVisibleCannonballs(
    cannonballs: readonly Cannonball[],
    camera: Camera,
  ): Cannonball[] {
    const out = this._visibleCannonballsScratch;
    out.length = 0;
    for (const cb of cannonballs) {
      if (!this._shouldRenderEntityAt(cb.position.x, cb.position.y, cb.radius + 20, camera, false)) continue;
      out.push(cb);
    }
    return out;
  }

  private buildWrappedRenderCopies<T extends { position: Vec2 }>(
    entities: readonly T[],
    camera: Camera,
    margin: number,
    skipGhosts?: (entity: T) => boolean,
  ): T[] {
    const out: T[] = [];
    this._wrapGhostIdx = 0;

    for (const entity of entities) {
      out.push(entity);
      if (skipGhosts?.(entity)) continue;

      const offsets = this.getWrapRenderOffsets(entity.position, camera, margin);
      for (let i = 1; i < offsets.length; i++) {
        const off = offsets[i];
        out.push(this._makeWrapGhostCopy(entity, off.dx, off.dy));
      }
    }
    return out;
  }

  /** Pooled shallow copy with offset position for world-wrap seam rendering. */
  private _makeWrapGhostCopy<T extends { position: Vec2 }>(entity: T, dx: number, dy: number): T {
    const idx = this._wrapGhostIdx++;
    let pos = this._wrapGhostPositions[idx];
    if (!pos) {
      pos = Vec2.from(0, 0);
      this._wrapGhostPositions[idx] = pos;
    }
    pos.x = entity.position.x + dx;
    pos.y = entity.position.y + dy;

    let slot = this._wrapGhostEntities[idx];
    if (!slot) {
      slot = { ...entity, position: pos };
      this._wrapGhostEntities[idx] = slot;
    } else {
      Object.assign(slot, entity);
      slot.position = pos;
    }
    return slot as T;
  }

  /**
   * Cache of hull bounding radii keyed by ship ID.
   * Computed once per unique hull polygon; used for accurate camera/fog culling
   * so ships are not culled while any part of their hull is still on screen.
   * Includes a +80 padding for modules/planks that extend beyond the hull polygon.
   */
  private _hullRadiusCache = new Map<number, number>();

  /** Returns the world-space bounding radius of a ship's hull (cached). */
  private _hullRadius(ship: import('../../sim/Types.js').Ship): number {
    const cached = this._hullRadiusCache.get(ship.id);
    if (cached !== undefined) return cached;
    let r2 = 0;
    for (const v of ship.hull) {
      const d = v.x * v.x + v.y * v.y;
      if (d > r2) r2 = d;
    }
    const r = Math.sqrt(r2) + 80; // +80 for modules/planks beyond hull outline
    this._hullRadiusCache.set(ship.id, r);
    return r;
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
  private readonly TRAIL_SPACING_MS  = 25;   // min ms between crumbs (was 10 → 68 crumbs; now ~28)
  /** Timestamp of last crumb per ball — prevents over-sampling. */
  private trailLastEmit: Map<number, number> = new Map();
  /**
   * Combined wake history: ship id -> sampled {ship-center x/y, rotation r, timestamp t}.
   * Both the stern wash and bow V-lines are derived from this single trail at render time.
   */
  // cr/sr (cos/sin of r) are computed once at emit time and reused every frame,
  // eliminating 2 trig calls per trail point per render frame.
  private shipWakeTrails: Map<number, Array<{ x: number; y: number; r: number; t: number; cr: number; sr: number }>> = new Map();

  // Per-ship reusable Float32Array slab — avoids 9 small allocations per frame
  // per moving ship.  Sliced into logical sub-arrays; reallocated only when N grows.
  private _wakeBuffers: Map<number, { buf: Float32Array; cap: number }> = new Map();
  private static readonly _WAKE_BUF_STRIDE = 11; // arrays per point: ssx,ssy,bsx,bsy,fade,bCos,bSin,perpX,perpY,cumDist,segLen
  /** Last wake sample time per ship to avoid oversampling history. */
  private shipWakeLastEmit: Map<number, number> = new Map();
  private readonly SHIP_WAKE_TRAIL_DURATION_MS = 10000;
  private readonly SHIP_WAKE_TRAIL_SPACING_MS = 120;
  private readonly SHIP_WAKE_TRAIL_MIN_DIST = 18;
  
  // Debug flags
  private showHoverBoundaries: boolean = false;
  private _showHoverDebugHUD: boolean = false;
  
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

    // Seed fallback island through the same path as server islands so resource grids are built.
    this.setIslands([RenderSystem.DEFAULT_ISLAND]);
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

  // ── GL world renderer integration ─────────────────────────────────────────

  /**
   * Attach a GLWorldRenderer. Call once after the GL canvas is created.
   * Pass null to fall back to Canvas 2D-only rendering.
   */
  setGLRenderer(gl: GLWorldRenderer | null): void {
    this._gl = gl;
    console.log(gl ? '[GL] RenderSystem using WebGL2 world renderer' : '[GL] Falling back to Canvas 2D');
  }

  /**
   * Begin a GL frame — call BEFORE renderWorld() each frame when GL is active.
   * @param camX      Camera world X
   * @param camY      Camera world Y
   * @param zoom      Pixels per world unit
   * @param deltaMs   Frame delta in milliseconds (for time accumulation)
   */
  beginGLFrame(camX: number, camY: number, zoom: number, deltaMs: number, cameraRotation: number = 0): void {
    if (!this._gl) return;
    this._glTimeSec += deltaMs / 1000;
    this._gl.beginFrame(camX, camY, zoom, this._glTimeSec, this.canvas.width, this.canvas.height, cameraRotation);
  }

  /** Flush the GL batcher — call AFTER renderWorld() each frame when GL is active. */
  endGLFrame(): void {
    this._gl?.endFrame();
  }

  /** GL draw-call count from the last frame (for perf HUD). 0 if GL is not active. */
  get glDrawCallCount(): number { return this._gl?.drawCallCount ?? 0; }

  /** Last-frame render pass durations (ms) when perfTimingsEnabled was true. */
  getLastPerfTimings(): Readonly<{ island: number; queue: number; execute: number; fog: number }> {
    return this._perfMs;
  }
  
  /**
   * Spawn a floating damage number at a world position
   */
  spawnExplosion(worldPos: Vec2, intensity: number = 1.0): void {
    this.particleSystem.createExplosion(worldPos, intensity);
  }

  /** Mark a destroyed plank slot as blocked and spawn wreckage particles. */
  startPlankWreckage(
    shipId: number,
    sectionName: string,
    segmentIndex: number,
    worldPos: Vec2,
    wreckageUntilMs: number,
  ): void {
    const key = `${shipId}_${sectionName}_${segmentIndex}`;
    const until = wreckageUntilMs > 0 ? wreckageUntilMs : Date.now() + 15000;
    const prev = this.plankWreckageUntil.get(key) ?? 0;
    this.plankWreckageUntil.set(key, Math.max(prev, until));
    if (prev <= Date.now()) {
      this.particleSystem.createPlankWreckage(worldPos);
    }
  }

  isPlankSlotWrecked(shipId: number, sectionName: string, segmentIndex: number): boolean {
    const until = this.plankWreckageUntil.get(`${shipId}_${sectionName}_${segmentIndex}`);
    if (!until) return false;
    if (Date.now() >= until) {
      this.plankWreckageUntil.delete(`${shipId}_${sectionName}_${segmentIndex}`);
      return false;
    }
    return true;
  }

  private prunePlankWreckage(): void {
    const now = Date.now();
    for (const [key, until] of this.plankWreckageUntil) {
      if (now >= until) this.plankWreckageUntil.delete(key);
    }
  }

  spawnDamageNumber(worldPos: Vec2, damage: number, isKill: boolean = false, team: DamageTeam = 'enemy'): void {
    this.effectRenderer.createDamageNumber(worldPos, damage, isKill, team);
  }

  /** Spawn a floating resource pickup label (e.g. "+3 metal") at a world position. */
  spawnResourcePickup(worldPos: Vec2, label: string, color?: string): void {
    this.effectRenderer.createResourcePickup(worldPos, label, color);
  }

  /**
   * Spawn a muzzle flash at the cannon-centre world position.
   * The barrel-tip offset (30 px) is applied here so callers can pass the
   * raw cannon position received from the server.
   */
  spawnMuzzleFlash(x: number, y: number, angle: number): void {
    const BARREL_TIP = 40; // barrel drawn 40 px from cannon centre in local space
    const tipX = x + Math.cos(angle) * BARREL_TIP;
    const tipY = y + Math.sin(angle) * BARREL_TIP;
    this.effectRenderer.createMuzzleFlash(Vec2.from(tipX, tipY), angle);
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
  private drawFireOverlay(_cx: number, _cy: number, _radius: number): void {
    // All gradient stops are currently alpha=0 (disabled for debugging).
    // Skip the ~20 createRadialGradient+fill calls per fire point until re-enabled.
    return;
    /* eslint-disable no-unreachable */
    const cx = _cx, cy = _cy, radius = _radius;
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
  spawnSwordArc(worldPos: Vec2, direction: number, radius: number = 30): void {
    this.effectRenderer.createSwordArc(worldPos, direction, radius);
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

  /** Green/red ring around the local player when holding bucket water. */
  private drawBucketDumpHint(camera: Camera): void {
    if (!this._bucketDumpHintActive) return;
    const player = this._cachedLocalPlayer;
    if (!player) return;
    const sp = camera.worldToScreen(player.position);
    const r = 22 * camera.getState().zoom;
    this.ctx.save();
    this.ctx.strokeStyle = this._bucketDumpHintValid ? 'rgba(80, 220, 120, 0.9)' : 'rgba(220, 80, 80, 0.75)';
    this.ctx.lineWidth = 2.5;
    this.ctx.beginPath();
    this.ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  /** Returns the ship ID of the last ship that fired a cannonball near shipId, or null. */
  getLastAttackerOf(shipId: number): number | null {
    return this.lastAttackerOf.get(shipId) ?? null;
  }

  /**
   * Update render system (particles, effects, etc.)
   */
  update(deltaTime: number): void {
    this.prunePlankWreckage();
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
   * Draw the coloured glow highlight on the currently-hovered ship hull.
   * Uses the same friendly/enemy team-colour palette as the module highlight.
   * Called unconditionally so the highlight is always immediate.
   */
  private drawShipHullHighlight(camera: Camera): void {
    if (!this.hoveredShip || this.hoveredModule) return;
    const ship = this.hoveredShip;
    if (!ship.hull || ship.hull.length < 3) return;
    const hull        = ship.hull;
    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const now         = performance.now();
    const glowPulse   = 0.55 + 0.45 * Math.sin(now / 160);
    const glowAlpha   = 0.6 + 0.4 * glowPulse;

    type HoverTeam = 'friendly' | 'enemy' | 'alliance';
    const hoverTeam: HoverTeam = this.isShipFriendly(ship) ? 'friendly' : 'enemy';
    const HOVER_PALETTE: Record<HoverTeam, { glow: string; inner: string; fill: string }> = {
      friendly: { glow: '#44ff88', inner: '#88ffcc', fill: '#00ff44' },
      enemy:    { glow: '#ff4444', inner: '#ff9999', fill: '#ff2222' },
      alliance: { glow: '#66ccff', inner: '#aaeeff', fill: '#44aaff' },
    };
    const pal = HOVER_PALETTE[hoverTeam];
    const hexToRgba = (hex: string, a: number) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a.toFixed(3)})`;
    };
    const buildHullPath = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
      ctx.closePath();
    };

    const ctx = this.ctx;
    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);
    ctx.scale(cameraState.zoom, cameraState.zoom);
    ctx.rotate(ship.rotation - cameraState.rotation);

    ctx.shadowColor  = pal.glow;
    ctx.shadowBlur   = (14 + glowPulse * 6) / cameraState.zoom;
    ctx.strokeStyle  = hexToRgba(pal.glow, glowAlpha * 0.55);
    ctx.lineWidth    = (5 + glowPulse * 3) / cameraState.zoom;
    ctx.globalAlpha  = 1;
    buildHullPath(ctx);
    ctx.stroke();

    ctx.shadowBlur   = 0;
    ctx.strokeStyle  = pal.inner;
    ctx.lineWidth    = 2.5 / cameraState.zoom;
    ctx.globalAlpha  = glowAlpha;
    buildHullPath(ctx);
    ctx.stroke();

    ctx.globalAlpha  = 0.08 + 0.06 * glowPulse;
    ctx.fillStyle    = pal.fill;
    buildHullPath(ctx);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw the coloured glow highlight on the currently-hovered ship module.
   * Called unconditionally every frame so the highlight is always immediate,
   * independent of the 500 ms tooltip delay.
   *
   * Uses the legacy per-kind path geometry (curved planks, cannon w/ rotated
   * barrel, ladder dims, etc.) inside the unified 3-pass glow design.
   */
  private drawModuleHoverHighlight(camera: Camera): void {
    if (!this.hoveredModule) return;
    const { ship: modShip, module: mod } = this.hoveredModule;
    const modData     = (mod as any).moduleData ?? mod;
    const kind        = (modData.kind ?? mod.kind) as string;
    const screenPos   = camera.worldToScreen(modShip.position);
    const cameraState = camera.getState();
    const now         = performance.now();
    const glowPulse   = 0.55 + 0.45 * Math.sin(now / 160);
    const glowAlpha   = 0.6 + 0.4 * glowPulse;

    type HoverTeam = 'friendly' | 'enemy' | 'alliance';
    const hoverTeam: HoverTeam = this.isShipFriendly(modShip) ? 'friendly' : 'enemy';
    const HOVER_PALETTE: Record<HoverTeam, { glow: string; inner: string; fill: string }> = {
      friendly: { glow: '#44ff88', inner: '#88ffcc', fill: '#00ff44' },
      enemy:    { glow: '#ff4444', inner: '#ff9999', fill: '#ff2222' },
      alliance: { glow: '#66ccff', inner: '#aaeeff', fill: '#44aaff' },
    };
    const pal = HOVER_PALETTE[hoverTeam];
    const hexToRgba = (hex: string, a: number) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a.toFixed(3)})`;
    };

    // ── Build the per-kind path(s). May issue multiple sub-paths (e.g. cannon
    //    base + rotated barrel). The caller wraps this in 3 passes.
    const isCurvedPlank = kind === 'plank' && modData.isCurved && modData.curveData;

    const buildModulePath = (ctx: CanvasRenderingContext2D): void => {
      ctx.beginPath();
      if (isCurvedPlank) {
        const { start, control, end, t1, t2 } = modData.curveData;
        const segments = 20;
        const halfPlankWidth = modData.width / 2;
        const points: Array<{x: number; y: number}> = [];
        for (let i = 0; i <= segments; i++) {
          const t = t1 + (t2 - t1) * (i / segments);
          points.push(this.getQuadraticPoint(start, control, end, t));
        }
        const outer: Array<{x: number; y: number}> = [];
        const inner: Array<{x: number; y: number}> = [];
        for (let i = 0; i < points.length; i++) {
          const pt = points[i];
          let dx: number, dy: number;
          if (i === 0) { dx = points[1].x - pt.x; dy = points[1].y - pt.y; }
          else if (i === points.length - 1) { dx = pt.x - points[i - 1].x; dy = pt.y - points[i - 1].y; }
          else { dx = points[i + 1].x - points[i - 1].x; dy = points[i + 1].y - points[i - 1].y; }
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len > 0) { dx /= len; dy /= len; }
          const perpX = -dy, perpY = dx;
          outer.push({ x: pt.x + perpX * halfPlankWidth, y: pt.y + perpY * halfPlankWidth });
          inner.push({ x: pt.x - perpX * halfPlankWidth, y: pt.y - perpY * halfPlankWidth });
        }
        ctx.moveTo(outer[0].x, outer[0].y);
        for (let i = 1; i < outer.length; i++) ctx.lineTo(outer[i].x, outer[i].y);
        for (let i = inner.length - 1; i >= 0; i--) ctx.lineTo(inner[i].x, inner[i].y);
        ctx.closePath();
        return;
      }
      if (kind === 'mast') {
        ctx.arc(0, 0, modData.radius || 15, 0, Math.PI * 2);
      } else if (kind === 'helm' || kind === 'steering-wheel') {
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
      } else if (kind === 'cannon') {
        // Base
        ctx.rect(-15, -10, 30, 20);
        // Rotated barrel — apply rotation only to the barrel rect
        const turretAngle = modData.aimDirection ?? 0;
        ctx.save();
        ctx.rotate(turretAngle);
        ctx.rect(-8, -40, 16, 40);
        ctx.restore();
      } else if (kind === 'swivel') {
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
      } else if (kind === 'ladder') {
        ctx.rect(-10, -20, 20, 40);
      } else if (kind === 'plank') {
        const w = modData.length || 20;
        const h = modData.width  || 10;
        ctx.rect(-w / 2, -h / 2, w, h);
      } else if (kind === 'ramp' || kind === 'hatch_cover') {
        ctx.rect(-25, -25, 50, 50);
      } else if (kind === 'gunport') {
        ctx.rect(-10, -7, 20, 14);
      } else {
        ctx.rect(-10, -10, 20, 20);
      }
    };

    // ── Set up transform. Curved planks are pre-baked in ship-local space; all
    //    other kinds use the module's localPos + localRot.
    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.rotate(modShip.rotation - cameraState.rotation);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    if (!isCurvedPlank) {
      this.ctx.translate(mod.localPos.x, mod.localPos.y);
      this.ctx.rotate((mod as any).localRot ?? 0);
    }

    // Outer glow pass
    this.ctx.shadowColor  = pal.glow;
    this.ctx.shadowBlur   = (14 + glowPulse * 6) / cameraState.zoom;
    this.ctx.strokeStyle  = hexToRgba(pal.glow, glowAlpha * 0.55);
    this.ctx.lineWidth    = (5 + glowPulse * 3) / cameraState.zoom;
    this.ctx.globalAlpha  = 1;
    buildModulePath(this.ctx);
    this.ctx.stroke();

    // Inner crisp stroke
    this.ctx.shadowBlur   = 0;
    this.ctx.strokeStyle  = pal.inner;
    this.ctx.lineWidth    = 2.5 / cameraState.zoom;
    this.ctx.globalAlpha  = glowAlpha;
    buildModulePath(this.ctx);
    this.ctx.stroke();

    // Translucent fill overlay
    this.ctx.globalAlpha  = 0.08 + 0.06 * glowPulse;
    this.ctx.fillStyle    = pal.fill;
    buildModulePath(this.ctx);
    this.ctx.fill();

    this.ctx.restore();

    // Interact hint: "[E] – Interact" when in range, "Not in Range" when too far
    if (!this._anyBuildActive) {
      const modWorldX = modShip.position.x + mod.localPos.x * Math.cos(modShip.rotation) - mod.localPos.y * Math.sin(modShip.rotation);
      const modWorldY = modShip.position.y + mod.localPos.x * Math.sin(modShip.rotation) + mod.localPos.y * Math.cos(modShip.rotation);

      const pi = this.playerInteractInfo;
      let inRange = true;
      if (pi) {
        const dist = (pi.carrierId === modShip.id && pi.localPos)
          ? Math.hypot((pi.localPos as any).x - mod.localPos.x, (pi.localPos as any).y - mod.localPos.y)
          : Math.hypot(pi.worldPos.x - modWorldX, pi.worldPos.y - modWorldY);
        inRange = dist <= 120;
      }

      const hintScreen = camera.worldToScreen(Vec2.from(modWorldX, modWorldY));
      const label  = inRange ? '[E] – Interact' : 'Not in Range';
      const labelX = hintScreen.x;
      const labelY = hintScreen.y - 42;
      const tCtx   = this.ctx;
      tCtx.save();
      tCtx.font = 'bold 13px Georgia, serif';
      tCtx.textAlign    = 'center';
      tCtx.textBaseline = 'middle';
      const tw      = tCtx.measureText(label).width;
      const boxH    = 22;
      const boxTop  = labelY - boxH / 2;
      const textMid = labelY;
      tCtx.fillStyle   = inRange ? 'rgba(10,20,30,0.72)'  : 'rgba(20,15,10,0.72)';
      tCtx.strokeStyle = inRange ? 'rgba(130,105,55,0.8)' : 'rgba(90,70,40,0.55)';
      tCtx.lineWidth   = 1.5;
      tCtx.beginPath();
      tCtx.roundRect(labelX - tw / 2 - 8, boxTop, tw + 16, boxH, 4);
      tCtx.fill();
      tCtx.stroke();
      tCtx.fillStyle = inRange ? '#e8dfc0' : '#888070';
      tCtx.fillText(label, labelX, textMid);
      tCtx.restore();

    }
  }

  /**
   * Draw small tier-colored gems on cannon/mast/swivel modules that were crafted
   * from a quality blueprint (qualityTier >= 1). Shows item prestige in-world.
   */
  private drawModuleQualityMarkers(worldState: WorldState, camera: Camera): void {
    const ctx = this.ctx;
    for (const ship of worldState.ships) {
      for (const mod of ship.modules) {
        const qt = mod.qualityTier;
        if (typeof qt !== 'number' || qt < 1) continue;
        if (mod.kind !== 'cannon' && mod.kind !== 'mast' && mod.kind !== 'swivel') continue;
        const rot = ship.rotation;
        const wx = ship.position.x + mod.localPos.x * Math.cos(rot) - mod.localPos.y * Math.sin(rot);
        const wy = ship.position.y + mod.localPos.x * Math.sin(rot) + mod.localPos.y * Math.cos(rot);
        const sp = camera.worldToScreen(Vec2.from(wx, wy));
        if (sp.x < -20 || sp.x > this.canvas.width + 20 || sp.y < -20 || sp.y > this.canvas.height + 20) continue;
        const zoom = camera.getState().zoom;
        const col = tierColor(qt);
        const r = Math.max(2, 3.5 * zoom);
        ctx.save();
        ctx.shadowColor = col;
        ctx.shadowBlur = Math.min(20, Math.max(3, 6 * zoom));
        ctx.fillStyle = col;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = Math.max(0.5, 1 * zoom);
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y - r);
        ctx.lineTo(sp.x + r, sp.y);
        ctx.lineTo(sp.x, sp.y + r);
        ctx.lineTo(sp.x - r, sp.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * Draw ⚒ repair icons on all damaged modules of the local player's ship.
   * Only called when hammerEquipped is true.
   */
  private drawHammerRepairOverlays(worldState: WorldState, camera: Camera): void {
    const localPlayer = this._cachedLocalPlayer;
    if (!localPlayer || localPlayer.carrierId === 0) return;
    const playerShip = worldState.ships.find(s => s.id === localPlayer.carrierId);
    if (!playerShip) return;

    const ctx = this.ctx;
    const cameraState = camera.getState();
    const zoom = cameraState.zoom;
    const shipScreen = camera.worldToScreen(playerShip.position);
    const shipRot = playerShip.rotation - cameraState.rotation;
    const now = performance.now();
    const pulse = 0.7 + 0.3 * Math.sin(now / 400);

    for (const mod of playerShip.modules) {
      // Skip planks — damage is visible via hull darkening; icons would be too dense
      if (mod.kind === 'plank') continue;
      const md = mod.moduleData as any;
      if (!md) continue;
      const health = typeof md.health === 'number' ? md.health : (md.maxHealth ?? 1);
      const maxHealth = (md.maxHealth ?? 1) as number;
      if (health >= maxHealth * 0.999) continue;

      const lx = mod.localPos.x;
      const ly = mod.localPos.y;
      const sx = shipScreen.x + (lx * Math.cos(shipRot) - ly * Math.sin(shipRot)) * zoom;
      const sy = shipScreen.y + (lx * Math.sin(shipRot) + ly * Math.cos(shipRot)) * zoom;

      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.font = `${Math.max(10, Math.round(14 * zoom))}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffaa33';
      ctx.shadowColor = '#ff8800';
      ctx.shadowBlur = 4;
      ctx.fillText('\u2692', sx, sy);
      ctx.restore();
    }
  }

  /**
   * Draw an animated marching-arrow line from the commanded NPC to the mouse cursor.
   * Shown whenever Move To targeting mode is active.
   */
  private drawMoveToArrowLine(worldState: WorldState, camera: Camera): void {
    if (this._moveToSourceNpcId === null || !this.mouseWorldPos) return;
    const now = performance.now();

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
      const glowPulse    = 0.55 + 0.45 * Math.sin(now / 160);
      const glowAlpha    = 0.6 + 0.4 * glowPulse;

      type HullTeam = 'friendly' | 'enemy' | 'alliance';
      const hullTeam: HullTeam = this.isShipFriendly(hullHitShip) ? 'friendly' : 'enemy';
      const HULL_PALETTE: Record<HullTeam, { glow: string; inner: string; fill: string }> = {
        friendly: { glow: '#44ff88', inner: '#88ffcc', fill: '#00ff44' },
        enemy:    { glow: '#ff4444', inner: '#ff9999', fill: '#ff2222' },
        alliance: { glow: '#66ccff', inner: '#aaeeff', fill: '#44aaff' },
      };
      const hPal = HULL_PALETTE[hullTeam];
      const hToRgba = (hex: string, a: number) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${a.toFixed(3)})`;
      };
      const buildHullPath = (ctx: CanvasRenderingContext2D) => {
        ctx.beginPath();
        ctx.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
        ctx.closePath();
      };

      this.ctx.save();
      this.ctx.translate(screenPos.x, screenPos.y);
      this.ctx.scale(cameraState.zoom, cameraState.zoom);
      this.ctx.rotate(hullHitShip.rotation - cameraState.rotation);

      this.ctx.shadowColor  = hPal.glow;
      this.ctx.shadowBlur   = (14 + glowPulse * 6) / cameraState.zoom;
      this.ctx.strokeStyle  = hToRgba(hPal.glow, glowAlpha * 0.55);
      this.ctx.lineWidth    = (5 + glowPulse * 3) / cameraState.zoom;
      this.ctx.globalAlpha  = 1;
      buildHullPath(this.ctx);
      this.ctx.stroke();

      this.ctx.shadowBlur   = 0;
      this.ctx.strokeStyle  = hPal.inner;
      this.ctx.lineWidth    = 2.5 / cameraState.zoom;
      this.ctx.globalAlpha  = glowAlpha;
      buildHullPath(this.ctx);
      this.ctx.stroke();

      this.ctx.globalAlpha  = 0.08 + 0.06 * glowPulse;
      this.ctx.fillStyle    = hPal.fill;
      buildHullPath(this.ctx);
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
    ctx.font      = 'bold 16px Georgia, serif';
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

  /** Draw the Ctrl+drag box-select rectangle while the player is dragging. */
  private drawBoxSelectRect(): void {
    const r = this.boxSelectRect;
    if (!r) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle   = 'rgba(100,180,255,0.10)';
    ctx.strokeStyle = 'rgba(100,180,255,0.85)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.rect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * When NPCs are box-selected and the player hovers over a ship hull, draw the same
   * gold boarding-highlight used by single-NPC Move To.
   */
  private drawMultiSelectHoverHighlight(worldState: WorldState, camera: Camera): void {
    if (this.selectedNpcIds.size === 0 || !this.mouseWorldPos) return;

    const now = performance.now();

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

    let hullHitShip: (typeof worldState.ships)[0] | null = null;
    for (const s of worldState.ships) {
      if (!s.hull || s.hull.length < 3) continue;
      const dx  = this.mouseWorldPos.x - s.position.x;
      const dy  = this.mouseWorldPos.y - s.position.y;
      const cos = Math.cos(-s.rotation);
      const sin = Math.sin(-s.rotation);
      if (pointInPoly(dx * cos - dy * sin, dx * sin + dy * cos, s.hull)) {
        hullHitShip = s;
        break;
      }
    }
    if (!hullHitShip) return;

    const screenPos   = camera.worldToScreen(hullHitShip.position);
    const cameraState = camera.getState();
    const hull        = hullHitShip.hull!;
    const glowPulse   = 0.55 + 0.45 * Math.sin(now / 160);
    const glowAlpha   = 0.6  + 0.4  * glowPulse;
    const ctx         = this.ctx;

    type MsHullTeam = 'friendly' | 'enemy' | 'alliance';
    const msHullTeam: MsHullTeam = this.isShipFriendly(hullHitShip) ? 'friendly' : 'enemy';
    const MS_HULL_PALETTE: Record<MsHullTeam, { glow: string; inner: string; fill: string }> = {
      friendly: { glow: '#44ff88', inner: '#88ffcc', fill: '#00ff44' },
      enemy:    { glow: '#ff4444', inner: '#ff9999', fill: '#ff2222' },
      alliance: { glow: '#66ccff', inner: '#aaeeff', fill: '#44aaff' },
    };
    const msPal = MS_HULL_PALETTE[msHullTeam];
    const msHexToRgba = (hex: string, a: number) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a.toFixed(3)})`;
    };
    const buildMsHullPath = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      c.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) c.lineTo(hull[i].x, hull[i].y);
      c.closePath();
    };

    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);
    ctx.scale(cameraState.zoom, cameraState.zoom);
    ctx.rotate(hullHitShip.rotation - cameraState.rotation);

    ctx.shadowColor  = msPal.glow;
    ctx.shadowBlur   = (14 + glowPulse * 6) / cameraState.zoom;
    ctx.strokeStyle  = msHexToRgba(msPal.glow, glowAlpha * 0.55);
    ctx.lineWidth    = (5 + glowPulse * 3) / cameraState.zoom;
    ctx.globalAlpha  = 1;
    buildMsHullPath(ctx);
    ctx.stroke();

    ctx.shadowBlur   = 0;
    ctx.strokeStyle  = msPal.inner;
    ctx.lineWidth    = 2.5 / cameraState.zoom;
    ctx.globalAlpha  = glowAlpha;
    buildMsHullPath(ctx);
    ctx.stroke();

    ctx.globalAlpha  = 0.08 + 0.06 * glowPulse;
    ctx.fillStyle    = msPal.fill;
    buildMsHullPath(ctx);
    ctx.fill();

    ctx.restore();

    // Pulsing target ring at the mouse cursor (screen-space)
    const dstScreen  = camera.worldToScreen(this.mouseWorldPos);
    const ringPulse  = 0.65 + 0.35 * Math.sin(now / 220);
    ctx.save();
    ctx.globalAlpha  = 0.85 * ringPulse;
    ctx.beginPath();
    ctx.arc(dstScreen.x, dstScreen.y, 10 + (1 - ringPulse) * 4, 0, Math.PI * 2);
    ctx.strokeStyle  = '#ffe066';
    ctx.lineWidth    = 2;
    ctx.stroke();
    ctx.globalAlpha  = 0.95;
    ctx.beginPath();
    ctx.arc(dstScreen.x, dstScreen.y, 3, 0, Math.PI * 2);
    ctx.fillStyle    = '#fff8a0';
    ctx.fill();
    ctx.restore();
  }

  /** Draw a selection ring around each NPC in selectedNpcIds. Call after NPC rendering. */
  drawSelectedNpcRings(worldState: WorldState, camera: Camera): void {
    if (this.selectedNpcIds.size === 0) return;
    const ctx = this.ctx;
    for (const npc of worldState.npcs) {
      if (!this.selectedNpcIds.has(npc.id)) continue;
      let worldPos = npc.position;
      if (npc.shipId) {
        const ship = worldState.ships.find(s => s.id === npc.shipId);
        if (ship && npc.localPosition) {
          const cosR = Math.cos(ship.rotation);
          const sinR = Math.sin(ship.rotation);
          worldPos = Vec2.from(
            ship.position.x + npc.localPosition.x * cosR - npc.localPosition.y * sinR,
            ship.position.y + npc.localPosition.x * sinR + npc.localPosition.y * cosR,
          );
        }
      }
      const sp = camera.worldToScreen(worldPos);
      ctx.save();
      ctx.strokeStyle = 'rgba(100,200,255,0.9)';
      ctx.lineWidth   = 2.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
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
  
  /** Draw a "Not enough resources" badge above the cursor when a ghost slot is hovered but unaffordable. */
  private drawBuildAffordabilityBadge(camera: Camera): void {
    if (this.ghostCanAfford || !this._anyBuildActive || !this.mouseWorldPos) return;
    const hasHover = this.hoveredPlankSlot !== null || this.hoveredDeckSlot !== null
      || this.hoveredHelmSlot !== null || this.hoveredRampSlot !== null
      || this.hoveredCannonSlot !== null || this.hoveredMastSlot !== null;
    if (!hasHover) return;
    const sp = camera.worldToScreen(this.mouseWorldPos);
    const label = 'Not enough resources';
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const bx = sp.x, by = sp.y - 52;
    ctx.fillStyle = 'rgba(30, 8, 8, 0.82)';
    ctx.strokeStyle = 'rgba(220, 60, 40, 0.90)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx - tw / 2 - 8, by - 11, tw + 16, 22, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff7060';
    ctx.fillText(label, bx, by);
    ctx.restore();
  }

  /** True whenever any ship or land build mode is active (used to suppress interact prompts). */
  private get _anyBuildActive(): boolean {
    return this.buildMenuOpen || this.buildMode || this.cannonBuildMode || this.mastBuildMode
      || this.swivelBuildMode || this.helmBuildMode || this.deckBuildMode
      || this.rampBuildMode || this.hatchBuildMode || this.gunportBuildMode
      || this.landBuildModeActive;
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
    if (!active) this.hoveredGunportCannonSnap = null;
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
    if (!active) {
      this.hoveredDeckSlot = null;
      this.deckLevelOverride = -1; // reset selection on exit
    }
  }

  /** Cycle the selected deck level between 0 (lower) and 1 (upper). Only meaningful when both levels are missing. */
  cycleDeckLevel(): void {
    this.deckLevelOverride = this.deckLevelOverride === 1 ? 0 : 1;
  }

  /** Whether deck build mode is currently active */
  isInDeckBuildMode(): boolean {
    return this.deckBuildMode;
  }

  /** Get the ship whose deck slot is hovered (only in deck build mode) */
  getHoveredDeckSlot(): { ship: Ship; deckLevel: number } | null {
    return this.hoveredDeckSlot;
  }

  /** Enable or disable ramp placement build mode */
  setRampBuildMode(active: boolean): void {
    this.rampBuildMode = active;
    if (!active) this.hoveredRampSlot = null;
  }

  /** Enable or disable hatch cover placement build mode */
  setHatchBuildMode(active: boolean): void {
    this.hatchBuildMode = active;
    if (!active) this.hoveredRampSlot = null;
  }

  /** Enable or disable gunport placement build mode */
  setGunportBuildMode(active: boolean): void {
    this.gunportBuildMode = active;
    if (!active) this.hoveredGunportSnap = null;
  }

  /** Whether gunport build mode is currently active */
  isInGunportBuildMode(): boolean {
    return this.gunportBuildMode;
  }

  /** Get the gunport snap slot currently hovered (only in gunport build mode) */
  getHoveredGunportSnap(): { ship: Ship; snapIndex: number; localPos: { x: number; y: number } } | null {
    return this.hoveredGunportSnap;
  }

  /** Whether hatch cover build mode is currently active */
  isInHatchBuildMode(): boolean {
    return this.hatchBuildMode;
  }

  /** Activate or deactivate resource chest placement build mode. */
  setChestBuildMode(active: boolean): void {
    this.chestBuildMode = active;
  }

  /** Whether resource chest build mode is currently active */
  isInChestBuildMode(): boolean {
    return this.chestBuildMode;
  }

  /** Activate or deactivate bed placement build mode. */
  setBedBuildMode(active: boolean): void {
    this.bedBuildMode = active;
  }

  /** Whether bed build mode is currently active */
  isInBedBuildMode(): boolean {
    return this.bedBuildMode;
  }

  setWellBuildMode(active: boolean): void {
    this.wellBuildMode = active;
  }

  isInWellBuildMode(): boolean {
    return this.wellBuildMode;
  }

  /** Activate or deactivate ship workbench placement build mode. */
  setWorkbenchBuildMode(active: boolean): void {
    this.workbenchBuildMode = active;
  }

  /** Whether ship workbench build mode is currently active */
  isInWorkbenchBuildMode(): boolean {
    return this.workbenchBuildMode;
  }

  /** Whether ramp build mode is currently active */
  isInRampBuildMode(): boolean {
    return this.rampBuildMode;
  }

  /** Advance the ramp facing by 90°. dir=+1 (E key, clockwise) or -1 (Q key, counter-clockwise). */
  cycleRampFacing(dir: 1 | -1 = 1): void {
    this.rampFacing = ((this.rampFacing + dir) % 4 + 4) % 4;
  }

  /** Returns the current ramp rotation in radians (0, π/2, π, or 3π/2). */
  getRampFacingRadians(): number {
    return this.rampFacing * Math.PI / 2;
  }

  /** Get the ramp snap slot currently hovered (only in ramp build mode) */
  getHoveredRampSlot(): { ship: Ship; snapIndex: number; localPos: { x: number; y: number } } | null {
    return this.hoveredRampSlot;
  }

  // ── Island structure management ────────────────────────────────────────────

  /** Add (or update) a single placed structure received from the server. */
  addPlacedStructure(s: PlacedStructure): void {
    const idx = this.placedStructures.findIndex(p => p.id === s.id);
    const isNew = idx < 0;
    if (idx >= 0) this.placedStructures[idx] = s;
    else this.placedStructures.push(s);
    // Predict newcomer dominators locally to mirror server's
    // claim_register_placement_dominators. The authoritative
    // structure_dominators broadcast that follows will overwrite this.
    // Without this prediction, the just-placed structure is briefly
    // treated as uncarved "my territory" by pointInMyOwnUncarvedTerritory,
    // making the build-ghost wrongly green for enemy-overlap placements.
    if (isNew && s.type !== 'claim_flag' && (s.companyId ?? 0) !== 0 &&
        !s.claimOrphaned && (!s.dominators || s.dominators.length === 0)) {
      const radiusOf = (t: PlacedStructure['type']): number =>
        (t === 'flag_fort' || t === 'company_fortress') ? 600 : 400;
      const mr = radiusOf(s.type);
      const predicted: number[] = [];
      for (const other of this.placedStructures) {
        if (other === s) continue;
        if (other.id === s.id) continue;
        if ((other.companyId ?? 0) === 0) continue;
        if (other.companyId === s.companyId) continue;
        if (other.claimOrphaned) continue;
        if (other.type === 'claim_flag') continue;
        const pr = radiusOf(other.type);
        const dx = other.x - s.x, dy = other.y - s.y;
        const thresh = mr + pr;
        if (dx * dx + dy * dy > thresh * thresh) continue;
        predicted.push(other.id);
      }
      if (predicted.length > 0) s.dominators = predicted;
    }
    this._rebuildWallSegs();
    this._claimOverlayDirty = true;
  }

  // ── Territory claim API ────────────────────────────────────────────────────

  setTerritoryOverlay(on: boolean): void {
    if (on && !this._showTerritoryOverlay) this._claimOverlayDirty = true; // invalidate on show
    this._showTerritoryOverlay = on;
  }

  /** Toggle allied NPC names visibility (Alt held = true, released = false). */
  setNpcNamesVisible(on: boolean): void {
    this._showNpcNames = on;
  }

  setIslandClaim(islandId: number, companyId: number, fortX = 0, fortY = 0, fortRadius = 600, isCompanyFortress = false): void {
    this._islandClaims.set(islandId, { companyId, fortX, fortY, fortRadius, isCompanyFortress });
    this._claimOverlayDirty = true;
  }

  clearIslandClaim(islandId: number): void {
    this._islandClaims.delete(islandId);
    this._claimOverlayDirty = true;
  }

  updateClaimFlagProgress(structId: number, progressMs: number, contested: boolean, targetsFortress = false,
                          state?: number, graceMs?: number): void {
    const s = this.placedStructures.find(p => p.id === structId);
    if (s) {
      s.claimProgress = progressMs;
      s.claimContested = contested;
      s.claimTargetsFortress = targetsFortress;
      if (state !== undefined) s.claimState = state;
      if (graceMs !== undefined) s.claimGraceMs = graceMs;
    }
  }

  /** Mark a structure as orphaned (or not) for territory-overlay purposes. */
  setStructureClaimOrphaned(structId: number, orphaned: boolean): void {
    const s = this.placedStructures.find(p => p.id === structId);
    if (s) {
      s.claimOrphaned = orphaned;
      this._claimOverlayDirty = true;
    }
  }

  /** Update a structure's dominators list after a successful claim flag capture. */
  setStructureDominators(structureId: number, dominators: number[]): void {
    const s = this.placedStructures.find(p => p.id === structureId);
    if (!s) return;
    s.dominators = dominators.slice();
    this._claimOverlayDirty = true;
  }

  /** True if the point (px, py) lies inside the overlap of one of my own
   * structures' claim radii with a structure that has me as a dominator
   * (i.e. my company has carved that overlap out of an enemy structure). */
  private pointInMyDominatedArea(islandId: number, myCompany: number, px: number, py: number): boolean {
    if (!myCompany) return false;
    const radiusOf = (s: PlacedStructure): number => {
      if (s.type === 'flag_fort' || s.type === 'company_fortress') return 600;
      return 400;
    };
    for (const victim of this.placedStructures) {
      if (!victim.dominators || victim.dominators.length === 0) continue;
      if (victim.islandId !== islandId) continue;
      if (victim.companyId === myCompany) continue;
      if (victim.claimOrphaned) continue;
      const vr = radiusOf(victim);
      const dvx = px - victim.x, dvy = py - victim.y;
      if (dvx * dvx + dvy * dvy > vr * vr) continue;
      for (const dId of victim.dominators) {
        const d = this.placedStructures.find(p => p.id === dId);
        if (!d) continue;
        if (d.companyId !== myCompany) continue;
        if (d.claimOrphaned) continue;
        if (d.islandId !== islandId) continue;
        const dr = radiusOf(d);
        const ddx = px - d.x, ddy = py - d.y;
        if (ddx * ddx + ddy * ddy <= dr * dr) return true;
      }
    }
    return false;
  }

  /** True if (px,py) lies inside one of my own structures' claim radii AND
   * none of that structure's enemy dominators also covers the point. This is
   * the per-pixel "I own this point under Render Rule X" check for my own
   * (non-captured) territory. */
  private pointInMyOwnUncarvedTerritory(islandId: number, myCompany: number, px: number, py: number): boolean {
    if (!myCompany) return false;
    const radiusOf = (s: PlacedStructure): number => {
      if (s.type === 'flag_fort' || s.type === 'company_fortress') return 600;
      return 400;
    };
    for (const s of this.placedStructures) {
      if (s.companyId !== myCompany) continue;
      if (s.islandId !== islandId) continue;
      if (s.claimOrphaned) continue;
      // Only structures that project a claim radius count.
      if (s.type !== 'flag_fort' && s.type !== 'company_fortress' && s.type !== 'claim_flag') {
        // Non-fort claim sources still project the default radius via the
        // BFS overlay; include them so cursor logic mirrors the overlay.
      }
      const sr = radiusOf(s);
      const dx = px - s.x, dy = py - s.y;
      if (dx * dx + dy * dy > sr * sr) continue;
      // Check no enemy dominator of S also covers the point.
      let carved = false;
      if (s.dominators && s.dominators.length > 0) {
        for (const dId of s.dominators) {
          const d = this.placedStructures.find(p => p.id === dId);
          if (!d) continue;
          if (d.companyId === myCompany) continue; // same-company never carves
          if (d.claimOrphaned) continue;
          const dr = radiusOf(d);
          const ddx = px - d.x, ddy = py - d.y;
          if (ddx * ddx + ddy * ddy <= dr * dr) { carved = true; break; }
        }
      }
      if (!carved) return true;
    }
    return false;
  }

  /** Dominators-only effective territory test: I own (px,py) iff either
   * (a) one of my own structures covers it and no enemy dominator carves
   *     it, or
   * (b) an enemy structure covers it and one of my structures sits in that
   *     enemy's dominators list (captured area). */
  private pointInMyEffectiveTerritory(islandId: number, myCompany: number, px: number, py: number): boolean {
    if (this.pointInMyOwnUncarvedTerritory(islandId, myCompany, px, py)) return true;
    if (this.pointInMyDominatedArea(islandId, myCompany, px, py)) return true;
    return false;
  }

  updateFortressBuildProgress(structId: number, _companyId: number, _islandId: number, progressMs: number, totalMs: number, contested: boolean): void {
    const s = this.placedStructures.find(p => p.id === structId);
    if (s) {
      s.fortressBuildProgress = progressMs;
      s.fortressContested = contested;
      s.fortressComplete = progressMs >= totalMs;
    }
  }

  onFortressComplete(structId: number, _companyId: number, _islandId: number): void {
    const s = this.placedStructures.find(p => p.id === structId);
    if (s) { s.fortressComplete = true; s.fortressContested = false; }
  }

  onFortressCaptured(structId: number, newCompanyId: number, _islandId: number): void {
    const s = this.placedStructures.find(p => p.id === structId);
    if (s) {
      s.companyId = newCompanyId;
      s.fortressBuildProgress = 0;
      s.fortressComplete = false;
      s.fortressContested = false;
    }
  }

  /** Flip a Flag Fort's active state (crosses 30%-HP gate) or transition from CLAIMING→BUILDING. */
  onFlagFortActive(structId: number, active: boolean, claimPhase?: number): void {
    const s = this.placedStructures.find(p => p.id === structId);
    if (s) {
      s.fortressComplete = active;
      if (typeof claimPhase === 'number') s.claimPhase = claimPhase;
      this._claimOverlayDirty = true;
    }
  }

  /** Periodic flag-fort heal / claim-phase progress resync (does NOT toggle
   *  active gate — that arrives via the dedicated flag_fort_active event). */
  updateFlagFortBuildProgress(structId: number, hp: number, maxHp: number, contested: boolean, active: boolean,
                              claimPhase?: number, claimProgressMs?: number, claimTotalMs?: number,
                              claimState?: number, claimGraceMs?: number, targetHp?: number): void {
    const s = this.placedStructures.find(p => p.id === structId);
    if (!s) return;
    s.hp = hp;
    s.maxHp = maxHp;
    if (typeof targetHp === 'number') s.targetHp = targetHp;
    s.fortressContested = contested;
    // Build progress mapped onto a 0..max=FLAG_FORT_BUILD_MS scale so the
    // existing progress-bar reuses it (renderer divides by max_hp anyway).
    s.fortressBuildProgress = maxHp > 0 ? (hp / maxHp) * 300000 : 0;
    if (typeof claimPhase === 'number') {
      const prevPhase = s.claimPhase;
      s.claimPhase = claimPhase;
      if (prevPhase !== claimPhase) this._claimOverlayDirty = true;
      if (claimPhase === 0) {
        // CLAIMING phase — store the ground-claim countdown + contest state.
        s.claimPhaseProgressMs = claimProgressMs;
        s.claimPhaseTotalMs    = claimTotalMs;
        s.claimState           = claimState;
        s.claimGraceMs         = claimGraceMs;
        s.claimContested       = contested;
      } else {
        s.claimPhaseProgressMs = undefined;
      }
    }
    if (s.fortressComplete !== active) {
      s.fortressComplete = active;
      this._claimOverlayDirty = true;
    }
  }

  /** Look up a placed structure by id (read-only). */
  getPlacedStructureById(structId: number): PlacedStructure | undefined {
    return this.placedStructures.find(p => p.id === structId);
  }

  /**
   * Update a land chest's stored resources after a land_chest_state update.
   * The server only sends the per-transfer land_chest_state to the acting
   * client (no STRUCTURES rebroadcast), so the cached structure must be
   * patched here to keep the build resource panel / shipyard aggregation in
   * sync without waiting for a reconnect.
   */
  updateStructureChestResources(
    id: number,
    res: { wood: number; fiber: number; metal: number; stone: number },
  ): void {
    const s = this.placedStructures.find(p => p.id === id && (p.type === 'chest' || p.type === 'shipyard'));
    if (!s) return;
    s.chestResources = { wood: res.wood, fiber: res.fiber, metal: res.metal, stone: res.stone };
  }

  /** Replace the full placed-structure list (e.g. on join). */
  setPlacedStructures(arr: PlacedStructure[]): void {
    this.placedStructures = [...arr];
    this._rebuildWallSegs();
    this._claimOverlayDirty = true;
  }

  /** Update the cannonAimAngle of a single cannon structure in-place (no full rebuild needed). */
  updateStructureCannonAim(id: number, aimAngle: number): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s) s.cannonAimAngle = aimAngle;
  }

  /** Update the cannonReloadMs of a single cannon structure in-place. */
  updateStructureCannonReload(id: number, reloadMs: number, loadedAmmo?: number): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s) {
      s.cannonReloadMs = reloadMs;
      if (loadedAmmo !== undefined) s.cannonLoadedAmmo = loadedAmmo;
    }
  }

  /** Returns true if the island cannon at the given structure ID is currently reloading. */
  isIslandCannonReloading(id: number): boolean {
    const s = this.placedStructures.find(p => p.id === id && p.type === 'cannon');
    return s !== undefined && (s.cannonReloadMs ?? 0) > 0;
  }

  /** Remove a single structure by id (e.g. after server confirms demolish). */
  updateWreckPosition(id: number, x: number, y: number): void {
    const s = this.placedStructures.find(p => p.id === id && p.type === 'wreck');
    if (s) { s.x = x; s.y = y; }
  }

  removePlacedStructure(id: number): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s) {
      // Spawn destruction smoke + debris for solid structures (not cannons/shipyards)
      const smokeTypes: PlacedStructure['type'][] = ['wooden_floor', 'wood_ceiling', 'wall', 'door', 'door_frame', 'workbench'];
      if (smokeTypes.includes(s.type)) {
        this.particleSystem.createStructureDestroy(Vec2.from(s.x, s.y));
      }
    }
    this.placedStructures = this.placedStructures.filter(p => p.id !== id);
    this._rebuildWallSegs();
    this._claimOverlayDirty = true;
  }

  /**
   * Rebuild the cached wall-segment flat array from the current placedStructures.
   * Called only when the structure list mutates — not every frame.
   * Layout: [x1, y1, x2, y2,  x1, y1, x2, y2, ...]
   */
  private _rebuildWallSegs(): void {
    const WALL_HALF = 26;
    const floors = this.placedStructures.filter(f => f.type === 'wooden_floor');
    const solids  = this.placedStructures.filter(
      w => w.type === 'wall' || (w.type === 'door' && !w.doorOpen)
    );
    const buf = new Float32Array(solids.length * 4);
    let i = 0;
    for (const w of solids) {
      let nearFloor: PlacedStructure | null = null;
      let nearDist2 = Infinity;
      for (const f of floors) {
        const d2 = (f.x - w.x) ** 2 + (f.y - w.y) ** 2;
        if (d2 < nearDist2) { nearDist2 = d2; nearFloor = f; }
      }
      const ang = nearFloor
        ? Math.atan2(w.y - nearFloor.y, w.x - nearFloor.x) + Math.PI / 2
        : 0;
      const ca = Math.cos(ang) * WALL_HALF, sa = Math.sin(ang) * WALL_HALF;
      buf[i++] = w.x + ca; buf[i++] = w.y + sa;
      buf[i++] = w.x - ca; buf[i++] = w.y - sa;
    }
    this._wallSegs = buf;
    this._visPolyWallRev++; // invalidate cached visibility polygon
  }

  /** Update a structure's company ownership (one-way promotion from server). */
  updateStructureCompany(id: number, companyId: number): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s) {
      s.companyId = companyId;
      s.claimOrphaned = false; // company change = captured from inactive territory; always de-orphan
      this._claimOverlayDirty = true;
    }
  }

  updateStructureHp(id: number, hp: number, maxHp: number, targetHp?: number): { prevHp: number; prevTargetHp: number } | null {
    const s = this.placedStructures.find(p => p.id === id);
    if (!s) return null;
    const prevHp = s.hp ?? 0;
    const prevTargetHp = s.targetHp ?? prevHp;
    s.hp = hp;
    s.maxHp = maxHp;
    // Always sync targetHp — server always sends target_hp in structure_hp_changed.
    // Leaving a stale targetHp would permanently flag the structure as a schematic.
    s.targetHp = typeof targetHp === 'number' ? targetHp : undefined;
    return { prevHp, prevTargetHp };
  }

  /** Update door open/closed state after a door_toggled broadcast. */
  updateStructureDoorOpen(id: number, open: boolean): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s && s.type === 'door') {
      s.doorOpen = open;
      this._rebuildWallSegs(); // open/closed changes which segments block LOS
    }
  }

  updateStructureDoorLocked(id: number, locked: boolean, open: boolean): void {
    const s = this.placedStructures.find(p => p.id === id);
    if (s && s.type === 'door') {
      s.doorLocked = locked;
      s.doorOpen   = open;
      this._rebuildWallSegs();
    }
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

  /** Activate island placement ghost for wooden_floor, workbench, wall, door, shipyard, wood_ceiling, cannon, or clear it. */
  setIslandBuildItem(kind: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag' | 'chest' | 'bed' | null): void {
    this.islandBuildKind = kind;
  }

  /** Set the active Build Schematic Hotbar kind — used to detect ghost plan hover for construction. */
  setBuildSchematicKind(kind: string | null): void {
    this.buildSchematicKind = kind;
  }

  /** Mirror of ClientApplication.landBuildMenuOpen || islandBuildMode — gates ghost plan visibility. */
  public landBuildModeActive = false;

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
    // Must be > 0.1 to cover the %.1f server-broadcast precision gap (up to ±0.07
    // diagonal error between stored and snap-derived positions).
    const EPS = 0.2;
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
   * Returns a combined view of placed structures + pending land ghost placements
   * for snap-point computation. Ghosts are treated as already built so that
   * successive placements in the same plan snap to each other.
   */
  private _snapBases(): { type: string; x: number; y: number; rotation?: number; id: number | string }[] {
    const out: { type: string; x: number; y: number; rotation?: number; id: number | string }[] = [];
    for (const s of this.placedStructures) out.push(s);
    for (const g of this.landGhostPlacements) {
      out.push({ type: g.kind, x: g.worldPos.x, y: g.worldPos.y, rotation: g.rotation, id: g.id });
    }
    return out;
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
    const bases = this._snapBases();
    if (this.islandBuildKind !== 'wooden_floor' || bases.length === 0) {
      this._snappedBuildRotation = null;
      return { x: wx, y: wy };
    }
    let bestDist2 = SNAP_R * SNAP_R;
    let bestX = wx, bestY = wy;
    let bestRot: number | null = null;
    for (const s of bases) {
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
        const alreadyOccupied = bases.some(
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
    const bases = this._snapBases();
    if (bases.length === 0) return { x: wx, y: wy };
    let bestDist2 = SNAP_R * SNAP_R;
    let bestX = wx, bestY = wy;
    for (const s of bases) {
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
        const occ = bases.some(
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
    const bases = this._snapBases();
    if (bases.length === 0) return { x: wx, y: wy };
    let bestDist2 = SNAP_R * SNAP_R;
    let bestX = wx, bestY = wy;
    for (const s of bases) {
      if (s.type !== 'door_frame') continue;
      const hasDoor = bases.some(
        d => d.type === 'door' && Math.abs(d.x - s.x) < 2 && Math.abs(d.y - s.y) < 2
      );
      if (hasDoor) continue;
      const dist2 = (s.x - wx) * (s.x - wx) + (s.y - wy) * (s.y - wy);
      if (dist2 < bestDist2) { bestDist2 = dist2; bestX = s.x; bestY = s.y; }
    }
    return { x: bestX, y: bestY };
  }

  /**
   * Compute the snapped world position for a wood_ceiling placement at (wx, wy).
   * Valid snap targets:
   *  1. Any floor-tile centre that has a wall/door_frame at one of its 4 edge-midpoints
   *     (ceiling starts at a walled edge).
   *  2. Any tile position adjacent (edge-touching) to an existing ceiling tile
   *     (ceiling extends from another ceiling).
   */
  computeSnappedCeilingPos(wx: number, wy: number): { x: number; y: number } {
    const TILE   = 50;
    const HALF   = 25;
    const SNAP_R = TILE * 0.7;
    let bestDist2 = SNAP_R * SNAP_R;
    let bestX = wx, bestY = wy;
    // Candidate set: floor centres that have at least one wall, plus ceiling-adjacent positions
    const candidates: { x: number; y: number; rot: number }[] = [];
    const bases = this._snapBases();
    for (const s of bases) {
      if (s.type === 'wooden_floor') {
        // Is there a wall at any edge of this floor?
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const c = Math.cos(rad), sn = Math.sin(rad);
        const EDGES = [
          { ldx:  0,    ldy: -HALF },
          { ldx:  0,    ldy:  HALF },
          { ldx: -HALF, ldy:  0    },
          { ldx:  HALF, ldy:  0    },
        ];
        const hasWall = EDGES.some(e => {
          const ex = s.x + e.ldx * c - e.ldy * sn;
          const ey = s.y + e.ldx * sn + e.ldy * c;
          return bases.some(
            w => (w.type === 'wall' || w.type === 'door_frame') &&
                 Math.abs(w.x - ex) < 3 && Math.abs(w.y - ey) < 3
          );
        });
        if (hasWall) candidates.push({ x: s.x, y: s.y, rot: s.rotation ?? 0 });
      } else if (s.type === 'wood_ceiling') {
        // 4 adjacent tile positions from each existing ceiling
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
          const alreadyOccupied = bases.some(
            f => f.type === 'wood_ceiling' && Math.abs(f.x - nx) < 3 && Math.abs(f.y - ny) < 3
          );
          if (!alreadyOccupied) candidates.push({ x: nx, y: ny, rot: s.rotation ?? 0 });
        }
      }
    }
    for (const cand of candidates) {
      const dist2 = (cand.x - wx) * (cand.x - wx) + (cand.y - wy) * (cand.y - wy);
      if (dist2 < bestDist2) {
        bestDist2 = dist2; bestX = cand.x; bestY = cand.y;
        this._snappedBuildRotation = cand.rot;
      }
    }
    if (bestDist2 >= SNAP_R * SNAP_R) this._snappedBuildRotation = null;
    return { x: bestX, y: bestY };
  }

  /**
   * Returns true if a land-plan ghost placement of `kind` at world position (px, py) is
   * structurally valid given existing placed structures and pending ghost plans.
   *
   * Rules mirror server-side validation:
   *  - wall / door_frame: must be at a floor edge midpoint
   *  - workbench / cannon: must be inside a floor tile
   *  - door: must snap onto an existing door_frame
   *  - wood_ceiling: must have wall/door_frame at an edge midpoint OR be adjacent to an existing ceiling
   *  - everything else (wooden_floor, shipyard, …): always valid client-side (server enforces further)
   */
  isValidLandPlanPlacement(kind: string, px: number, py: number): boolean {
    const EDGE_TOL = 5;
    const HALF = 25;
    const TILE = 50;
    const bases = this._snapBases();

    if (kind === 'wall' || kind === 'door_frame') {
      return bases.some(s => {
        if (s.type !== 'wooden_floor') return false;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const c = Math.cos(rad), sn = Math.sin(rad);
        return [
          { ldx: 0, ldy: -HALF }, { ldx: 0, ldy: HALF },
          { ldx: -HALF, ldy: 0 }, { ldx: HALF, ldy: 0 },
        ].some(e => {
          const ex = s.x + e.ldx * c - e.ldy * sn;
          const ey = s.y + e.ldx * sn + e.ldy * c;
          return Math.abs(px - ex) < EDGE_TOL && Math.abs(py - ey) < EDGE_TOL;
        });
      });
    }

    if (kind === 'workbench' || kind === 'cannon' || kind === 'chest') {
      return bases.some(s => {
        if (s.type !== 'wooden_floor') return false;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const dx = px - s.x, dy = py - s.y;
        const lx = dx * Math.cos(-rad) - dy * Math.sin(-rad);
        const ly = dx * Math.sin(-rad) + dy * Math.cos(-rad);
        return Math.abs(lx) <= HALF && Math.abs(ly) <= HALF;
      });
    }

    if (kind === 'bed') {
      const onFloor = bases.some(s => {
        if (s.type !== 'wooden_floor') return false;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const dx = px - s.x, dy = py - s.y;
        const lx = dx * Math.cos(-rad) - dy * Math.sin(-rad);
        const ly = dx * Math.sin(-rad) + dy * Math.cos(-rad);
        return Math.abs(lx) <= HALF && Math.abs(ly) <= HALF;
      });
      if (!onFloor) return false;
      return !bases.some(s =>
        s.type === 'bed' && Math.hypot(s.x - px, s.y - py) < 30
      );
    }

    if (kind === 'door') {
      return bases.some(s =>
        s.type === 'door_frame' &&
        Math.abs(s.x - px) < EDGE_TOL && Math.abs(s.y - py) < EDGE_TOL
      );
    }

    if (kind === 'wood_ceiling') {
      const crot = (this._snappedBuildRotation ?? 0) * Math.PI / 180;
      const cc = Math.cos(crot), cs = Math.sin(crot);
      const EDGES = [
        { ldx: 0, ldy: -HALF }, { ldx: 0, ldy: HALF },
        { ldx: -HALF, ldy: 0 }, { ldx: HALF, ldy: 0 },
      ];
      // Wall/door_frame at any edge midpoint of this ceiling tile
      const hasWallAtEdge = EDGES.some(e => {
        const ex = px + e.ldx * cc - e.ldy * cs;
        const ey = py + e.ldx * cs + e.ldy * cc;
        return bases.some(
          w => (w.type === 'wall' || w.type === 'door_frame') &&
               Math.abs(w.x - ex) < EDGE_TOL && Math.abs(w.y - ey) < EDGE_TOL
        );
      });
      if (hasWallAtEdge) return true;
      // Adjacent existing ceiling
      return bases.some(s => {
        if (s.type !== 'wood_ceiling') return false;
        const adx = Math.abs(s.x - px), ady = Math.abs(s.y - py);
        return (Math.abs(adx - TILE) < EDGE_TOL && ady < EDGE_TOL) ||
               (Math.abs(ady - TILE) < EDGE_TOL && adx < EDGE_TOL);
      });
    }

    // wooden_floor, shipyard, and other types: always valid client-side
    return true;
  }

  /**
   * Return the nearest workbench within `range` world-px of the local player,
   * or null if none found. Used to decide whether E-key triggers interact.
   */
  getHoveredWorkbench(range: number = 50): PlacedStructure | null {
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
  getHoveredStructure(range: number = 50): PlacedStructure | null {
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
      // hw=170, hh=420 are world-unit half-extents; +100 interaction margin
      return Math.abs(lx) <= SHIPYARD_HW + 100 && Math.abs(ly) <= SHIPYARD_HH + 100 ? s : null;
    }
    const dx = s.x - player.position.x;
    const dy = s.y - player.position.y;
    return dx * dx + dy * dy <= range * range ? s : null;
  }

  /** Return hovered tree world pos if player is in range and off-ship, else null. */
  getHoveredTree(range: number = 50): { wx: number; wy: number } | null {
    if (!this._hoveredTree) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const effR = range * Math.max(1.0, this._hoveredTree.size);
    const dx = this._hoveredTree.wx - player.position.x;
    const dy = this._hoveredTree.wy - player.position.y;
    return dx * dx + dy * dy <= effR * effR ? this._hoveredTree : null;
  }

  /** Return hovered fiber plant world pos if player is in range and off-ship, else null. */
  getHoveredFiberPlant(range: number = 50): { wx: number; wy: number } | null {
    if (!this._hoveredFiberPlant) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const effR = range * Math.max(1.0, this._hoveredFiberPlant.size);
    const dx = this._hoveredFiberPlant.wx - player.position.x;
    const dy = this._hoveredFiberPlant.wy - player.position.y;
    return dx * dx + dy * dy <= effR * effR ? this._hoveredFiberPlant : null;
  }

  /**
   * Proximity-based fallback for fiber harvest.  Returns the world-pos of the
   * nearest live fiber bush within `range` of the player (regardless of cursor
   * hover).  Handles the case where a wooden_floor is placed over a bush and
   * the cursor naturally lands on the floor sprite instead of the bush.
   */
  getNearbyFiberPlant(range: number = 50): { wx: number; wy: number } | null {
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    let bestD2 = range * range;
    let best: { wx: number; wy: number } | null = null;
    for (const e of this._pendingAllRes) {
      if (e.res.type !== 'fiber') continue;
      if ((e.res.maxHp ?? 0) > 0 && (e.res.hp ?? 0) <= 0) continue; // depleted (dying)
      const effR = range * Math.max(1.0, e.res.size ?? 1.0);
      const dx = e.wx - player.position.x;
      const dy = e.wy - player.position.y;
      const d2 = dx * dx + dy * dy;
      const effR2 = effR * effR;
      if (d2 <= effR2 && d2 <= bestD2) { bestD2 = d2; best = { wx: e.wx, wy: e.wy }; }
    }
    return best;
  }

  /** Return hovered rock world pos if player is in range and off-ship, else null. */
  getHoveredRock(range: number = 50): { wx: number; wy: number } | null {
    if (!this._hoveredRock) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const effR = range * Math.max(1.0, this._hoveredRock.size);
    const dx = this._hoveredRock.wx - player.position.x;
    const dy = this._hoveredRock.wy - player.position.y;
    return dx * dx + dy * dy <= effR * effR ? this._hoveredRock : null;
  }

  getHoveredBoulder(): { wx: number; wy: number; size: number } | null {
    if (!this._hoveredBoulder) return null;
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    const BOULDER_HARVEST_RANGE = 50 * 1.40625; // matches server BOULDER_HARVEST_RANGE
    const effR = BOULDER_HARVEST_RANGE * Math.max(1.0, this._hoveredBoulder.size);
    const dx = this._hoveredBoulder.wx - player.position.x;
    const dy = this._hoveredBoulder.wy - player.position.y;
    return dx * dx + dy * dy <= effR * effR ? this._hoveredBoulder : null;
  }

  // ── Tombstone API ─────────────────────────────────────────────────────────

  /** Replace the full tombstone list (called on every GAME_STATE). */
  updateTombstones(list: import('../../sim/Types').Tombstone[]): void {
    this._tombstones = list;
  }

  /** Resolve the current world-space position of a tombstone, accounting for ship movement. */
  private _resolveTombstonePos(t: import('../../sim/Types').Tombstone): { x: number; y: number } {
    const attach = this._tombstoneShipAttach.get(t.id);
    if (attach) {
      const ship = this._cachedWorldShips.find(s => s.id === attach.shipId);
      if (ship) {
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        return {
          x: ship.position.x + attach.localX * cos - attach.localY * sin,
          y: ship.position.y + attach.localX * sin + attach.localY * cos,
        };
      }
    }
    return { x: t.x, y: t.y };
  }

  /** Add or update a single tombstone (called on tombstone_spawned). */
  addTombstone(t: import('../../sim/Types').Tombstone): void {
    // If the tombstone spawns within 500px of a ship centre, attach it so it
    // tracks the ship as it moves.
    for (const ship of this._cachedWorldShips) {
      const dx = t.x - ship.position.x;
      const dy = t.y - ship.position.y;
      if (dx * dx + dy * dy <= 500 * 500) {
        const cos = Math.cos(-ship.rotation);
        const sin = Math.sin(-ship.rotation);
        this._tombstoneShipAttach.set(t.id, {
          shipId: ship.id,
          localX: dx * cos - dy * sin,
          localY: dx * sin + dy * cos,
        });
        break;
      }
    }
    const idx = this._tombstones.findIndex(x => x.id === t.id);
    if (idx >= 0) this._tombstones[idx] = t;
    else this._tombstones.push(t);
  }

  /** Remove a tombstone by id (collected or despawned). */
  removeTombstone(id: number): void {
    this._tombstones = this._tombstones.filter(t => t.id !== id);
    this._tombstoneShipAttach.delete(id);
  }

  /**
   * Returns the nearest tombstone within `range` px of the local player cursor,
   * or null if none. Used for E-key interaction.
   */
  getHoveredTombstone(range: number = 80): import('../../sim/Types').Tombstone | null {
    const player = this._cachedLocalPlayer;
    if (!player || player.carrierId !== 0) return null;
    let best: import('../../sim/Types').Tombstone | null = null;
    let bestDist2 = range * range;
    for (const t of this._tombstones) {
      const pos = this._resolveTombstonePos(t);
      const dx = pos.x - player.position.x;
      const dy = pos.y - player.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestDist2) { best = t; bestDist2 = d2; }
    }
    return best;
  }

  /** Draw all active tombstones in world-space. Call during the world render pass. */
  private drawTombstones(ctx: CanvasRenderingContext2D, camera: import('./Camera').CameraState): void {
    if (this._tombstones.length === 0) return;
    const player = this._cachedLocalPlayer;
    for (const t of this._tombstones) {
      const pos = this._resolveTombstonePos(t);
      const sx = (pos.x - camera.position.x) * camera.zoom + ctx.canvas.width  / 2;
      const sy = (pos.y - camera.position.y) * camera.zoom + ctx.canvas.height / 2;
      const sz = Math.max(0.4, Math.min(1.0, camera.zoom));

      const HOVER_RANGE = 80;
      const isNear = player != null &&
        player.carrierId === 0 &&
        (pos.x - player.position.x) ** 2 + (pos.y - player.position.y) ** 2 <= HOVER_RANGE * HOVER_RANGE;

      ctx.save();
      ctx.translate(sx, sy);

      /* Shadow */
      ctx.beginPath();
      ctx.ellipse(0, 6 * sz, 14 * sz, 5 * sz, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();

      /* Stone body */
      const w = 22 * sz, h = 28 * sz;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h, w, h, [6 * sz, 6 * sz, 2 * sz, 2 * sz]);
      ctx.fillStyle = isNear ? '#c9c9d4' : '#8a8a96';
      ctx.strokeStyle = '#555560';
      ctx.lineWidth = 1.5 * sz;
      ctx.fill();
      ctx.stroke();

      /* Cross carved into the stone */
      ctx.strokeStyle = isNear ? '#ffffff' : '#aaaabc';
      ctx.lineWidth = 2 * sz;
      ctx.beginPath();
      ctx.moveTo(0, -h * 0.8);
      ctx.lineTo(0, -h * 0.35);
      ctx.moveTo(-w * 0.3, -h * 0.65);
      ctx.lineTo( w * 0.3, -h * 0.65);
      ctx.stroke();

      /* Owner name above */
      const fontSize = Math.round(10 * sz);
      ctx.font = `bold ${fontSize}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = isNear ? '#ffe97a' : '#dddddd';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3 * sz;
      const label = t.ownerName || '???';
      ctx.strokeText(label, 0, -h - 4 * sz);
      ctx.fillText(label, 0, -h - 4 * sz);

      /* Remaining time */
      const minLeft = Math.ceil(t.remainingMs / 60000);
      const timerText = `${minLeft}m`;
      ctx.font = `${Math.round(8 * sz)}px Georgia, serif`;
      ctx.fillStyle = minLeft <= 2 ? '#ff7070' : (isNear ? '#aaffaa' : '#aaaaaa');
      ctx.strokeText(timerText, 0, -h - 4 * sz - fontSize - 2 * sz);
      ctx.fillText(timerText, 0, -h - 4 * sz - fontSize - 2 * sz);

      /* Interact hint */
      if (isNear && !this._anyBuildActive) {
        ctx.font = `${Math.round(9 * sz)}px Georgia, serif`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('[E] Collect', 0, 14 * sz);
      }

      ctx.restore();
    }
  }

  // ── Dropped items ──────────────────────────────────────────────────────────

  /** Replace the full dropped-item list (called on every GAME_STATE). */
  updateDroppedItems(list: import('../../sim/Types').DroppedItem[]): void {
    this._droppedItems = list;
  }

  /** Whether a dropped item is visible on the current deck/location (render + pile grouping). */
  private _droppedItemBucket(d: import('../../sim/Types').DroppedItem): 'world' | 'ship-lower' | 'ship-upper' | null {
    const player = this._cachedLocalPlayer;
    if (!player) return null;
    if (d.shipId) {
      if (player.carrierId !== d.shipId) return null;
      return d.deckLevel === 0 ? 'ship-lower' : 'ship-upper';
    }
    if (player.carrierId !== 0) return null;
    return 'world';
  }

  /** Whether the local player can pick up a drop (deck/location rules only — no cursor hover). */
  private _canPlayerPickupDrop(
    d: import('../../sim/Types').DroppedItem,
    player: import('../../sim/Types').Player,
  ): boolean {
    const deck = typeof player.deckId === 'number'
      ? (player.deckId === 0 ? 0 : 1)
      : this._playerDeckLevel;
    if (d.shipId) {
      if (player.carrierId !== d.shipId) return false;
      if (d.deckLevel !== undefined && d.deckLevel !== deck) return false;
      return true;
    }
    return player.carrierId === 0;
  }

  /**
   * Returns dropped items within `range` px of the player (proximity — cursor hover not required).
   * Sorted nearest-first. Pass `player` from world state when calling outside the render pass.
   */
  getDroppedItemsInRange(
    range: number = RenderSystem.DROPPED_ITEM_PICKUP_RANGE,
    player?: import('../../sim/Types').Player | null,
  ): import('../../sim/Types').DroppedItem[] {
    const p = player ?? this._cachedLocalPlayer;
    if (!p) return [];
    const range2 = range * range;
    return this._droppedItems
      .filter(d => {
        if (!this._canPlayerPickupDrop(d, p)) return false;
        const dx = d.x - p.position.x;
        const dy = d.y - p.position.y;
        return dx * dx + dy * dy <= range2;
      })
      .sort((a, b) => {
        const dxa = a.x - p.position.x, dya = a.y - p.position.y;
        const dxb = b.x - p.position.x, dyb = b.y - p.position.y;
        return (dxa * dxa + dya * dya) - (dxb * dxb + dyb * dyb);
      });
  }

  /** Nearest dropped item in pickup range, or null. */
  getNearestDroppedItem(
    range: number = RenderSystem.DROPPED_ITEM_PICKUP_RANGE,
    player?: import('../../sim/Types').Player | null,
  ): import('../../sim/Types').DroppedItem | null {
    const items = this.getDroppedItemsInRange(range, player);
    return items.length > 0 ? items[0] : null;
  }

  private _buildDroppedItemPiles(
    bucket: 'world' | 'ship-lower' | 'ship-upper',
  ): Array<{ items: import('../../sim/Types').DroppedItem[]; cx: number; cy: number }> {
    const PILE_RADIUS = 24;
    const consumed = new Set<number>();
    const piles: Array<{ items: import('../../sim/Types').DroppedItem[]; cx: number; cy: number }> = [];

    for (const item of this._droppedItems) {
      if (consumed.has(item.id)) continue;
      if (this._droppedItemBucket(item) !== bucket) continue;
      const pile = { items: [item], cx: item.x, cy: item.y };
      for (const other of this._droppedItems) {
        if (consumed.has(other.id) || other.id === item.id) continue;
        if (this._droppedItemBucket(other) !== bucket) continue;
        if (item.shipId && other.shipId !== item.shipId) continue;
        const dx = other.x - item.x, dy = other.y - item.y;
        if (dx * dx + dy * dy <= PILE_RADIUS * PILE_RADIUS) {
          pile.items.push(other);
          consumed.add(other.id);
        }
      }
      consumed.add(item.id);
      piles.push(pile);
    }
    return piles;
  }

  /** Draw one dropped-item pile in world-space (ctx must already be the main canvas). */
  private _drawDroppedItemPile(
    pile: { items: import('../../sim/Types').DroppedItem[]; cx: number; cy: number },
    camera: import('./Camera').CameraState,
  ): void {
    const ctx = this.ctx;
    const player = this._cachedLocalPlayer;
    const pickupR = RenderSystem.DROPPED_ITEM_PICKUP_RANGE;
    const sx = (pile.cx - camera.position.x) * camera.zoom + ctx.canvas.width  / 2;
    const sy = (pile.cy - camera.position.y) * camera.zoom + ctx.canvas.height / 2;
    const sz = Math.max(0.4, Math.min(1.2, camera.zoom));

    const isNear = player != null && this._canPlayerPickupDrop(pile.items[0], player) &&
      (pile.cx - player.position.x) ** 2 + (pile.cy - player.position.y) ** 2
        <= pickupR * pickupR;

    const schematicItem = pile.items.find(it => it.isSchematic);
    const allSchematics = pile.items.length > 0 && pile.items.every(it => it.isSchematic);

    ctx.save();
    ctx.translate(sx, sy);

    /* Shadow */
    ctx.beginPath();
    ctx.ellipse(0, 7 * sz, 12 * sz, 4 * sz, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();

    if (allSchematics && schematicItem) {
      const tCol = tierColor(schematicItem.tier ?? 0);
      const sw = 22 * sz, sh = 26 * sz;
      if (isNear) {
        ctx.beginPath();
        ctx.arc(0, -sh / 2, 18 * sz, 0, Math.PI * 2);
        ctx.fillStyle = tCol + '33';
        ctx.fill();
      }
      ctx.fillStyle = isNear ? '#f0e8d0' : '#c8b898';
      ctx.strokeStyle = isNear ? tCol : '#8a7350';
      ctx.lineWidth = 1.5 * sz;
      ctx.beginPath();
      ctx.roundRect(-sw / 2, -sh, sw, sh, [2 * sz, 2 * sz, 4 * sz, 4 * sz]);
      ctx.fill();
      ctx.stroke();
      for (const rollY of [-sh, -2 * sz]) {
        ctx.beginPath();
        ctx.ellipse(0, rollY, sw / 2 + 2 * sz, 3 * sz, 0, 0, Math.PI * 2);
        ctx.fillStyle = isNear ? '#e8dcc0' : '#a89070';
        ctx.fill();
        ctx.strokeStyle = isNear ? tCol : '#6a5840';
        ctx.stroke();
      }
      ctx.fillStyle = tCol;
      ctx.beginPath();
      ctx.arc(0, -sh / 2, 4 * sz, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `bold ${Math.round(8 * sz)}px Georgia, serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📜', 0, -sh / 2 - 1 * sz);
    } else {
      const bw = 20 * sz, bh = 18 * sz;
      ctx.beginPath();
      ctx.roundRect(-bw / 2, -bh, bw, bh, [4 * sz, 4 * sz, 8 * sz, 8 * sz]);
      ctx.fillStyle = isNear ? '#d4a84b' : '#8b6914';
      ctx.strokeStyle = isNear ? '#ffe97a' : '#5a4209';
      ctx.lineWidth = 1.5 * sz;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(-6 * sz, -bh - 5 * sz, 12 * sz, 6 * sz, 2 * sz);
      ctx.fillStyle = isNear ? '#c49030' : '#7a5710';
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -bh - 2 * sz, 2.5 * sz, 0, Math.PI * 2);
      ctx.fillStyle = isNear ? '#ffe97a' : '#c4920a';
      ctx.fill();
      if (schematicItem) {
        ctx.font = `${Math.round(10 * sz)}px Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('📜', 0, -bh / 2);
      }
    }

    if (pile.items.length > 1) {
      const badge = pile.items.length.toString();
      const bsz = Math.round(9 * sz);
      ctx.font = `bold ${bsz}px Georgia, serif`;
      const bw2 = ctx.measureText(badge).width + 6 * sz;
      const bx = (allSchematics ? 11 : 10) * sz;
      const bby = (allSchematics ? -26 : -18) * sz + 4 * sz;
      ctx.fillStyle = '#cc3322';
      ctx.beginPath();
      ctx.roundRect(bx - bw2 / 2, bby - bsz / 2 - 2 * sz, bw2, bsz + 4 * sz, 3 * sz);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, bx, bby);
    }

    {
      const minRemMs = pile.items.reduce((min, it) =>
        (it.remainingMs !== undefined && it.remainingMs < min) ? it.remainingMs : min,
        Infinity);
      if (isFinite(minRemMs)) {
        const totalSec = Math.ceil(minRemMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        const timerStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        const timerColor = minRemMs > 120000 ? '#88ff88' : minRemMs > 60000 ? '#ffdd44' : '#ff5544';
        const tsz = Math.round(8 * sz);
        ctx.font = `bold ${tsz}px Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = timerColor;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 2.5 * sz;
        ctx.strokeText(timerStr, 0, -20 * sz);
        ctx.fillText(timerStr, 0, -20 * sz);
      }
    }

    if (isNear && !this._anyBuildActive) {
      const hint = pile.items.length > 1 ? '[E] Pick Up  [Hold E] Choose' : '[E] Pick Up';
      const fsz = Math.round(9 * sz);
      ctx.font = `${fsz}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3 * sz;
      ctx.strokeText(hint, 0, 8 * sz);
      ctx.fillText(hint, 0, 8 * sz);
    }

    ctx.restore();
  }

  /** Queue dropped items into deck-aware render layers (mirrors NPC layering). */
  private queueDroppedItems(camera: Camera): void {
    const camState = camera.getState();
    for (const pile of this._buildDroppedItemPiles('world')) {
      this.queueRenderItem(2, 'dropped-items-world', () => this._drawDroppedItemPile(pile, camState), 1);
    }
    for (const pile of this._buildDroppedItemPiles('ship-lower')) {
      this.queueRenderItem(1, 'dropped-items-lower', () => this._drawDroppedItemPile(pile, camState), 2);
      if (this.altKeyHeld) {
        this.queueRenderItem(4, 'dropped-items-lower-ghost', () => {
          this.ctx.save();
          this.ctx.globalAlpha *= 0.35;
          this._drawDroppedItemPile(pile, camState);
          this.ctx.restore();
        }, 2);
      }
    }
    for (const pile of this._buildDroppedItemPiles('ship-upper')) {
      const onLowerDeck = this._playerDeckLevel === 0
        && this._cachedLocalPlayer?.carrierId === pile.items[0]?.shipId;
      this.queueRenderItem(4, 'dropped-items-upper', () => {
        if (onLowerDeck) {
          this.ctx.save();
          this.ctx.globalAlpha *= this._upperDeckFade;
          this._drawDroppedItemPile(pile, camState);
          this.ctx.restore();
        } else {
          this._drawDroppedItemPile(pile, camState);
        }
      }, 2);
    }
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
  getHoveredCannonSlot(): { ship: Ship; cannonIndex: number; localX: number; localY: number; rot: number } | null {
    return this.hoveredCannonSlot;
  }

  /**
   * Get the gunport-snapped cannon position under the cursor (only in cannon build mode).
   * If the cursor is over a gunport that has no cannon yet, returns that gunport module.
   */
  getHoveredGunportCannonSnap(): { ship: Ship; module: ShipModule } | null {
    return this.hoveredGunportCannonSnap;
  }

  // ── Gunport cannon animation ──────────────────────────────────────────────

  /** Find the gunport module whose position matches a cannon's position (co-located at hull edge). */
  private findGunportForCannon(cannon: ShipModule, ship: Ship): ShipModule | null {
    // Match by snap index — the server links cannon to gunport via gunportSnapIdx / snapIndex.
    // Proximity matching breaks now that the server authoritatively moves the cannon between
    // stowed (y=±10) and deployed (y=±80) positions, both far from the gunport hull edge (y=±90).
    const cannonData = cannon.moduleData as import('../../sim/modules').CannonModuleData | undefined;
    const snapIdx = cannonData?.gunportSnapIdx;
    if (snapIdx === undefined || snapIdx === 255) return null;
    for (const mod of ship.modules) {
      if (mod.kind !== 'gunport') continue;
      const gpData = mod.moduleData as import('../../sim/modules').GunportModuleData | undefined;
      if (gpData?.snapIndex === snapIdx) return mod;
    }
    return null;
  }

  /** Compute deploy progress [0-1] for a gunport animation (0=stowed/closed, 1=deployed/open). */
  private computeGunportProgress(
    anim: { targetOpen: boolean; startProgress: number; startTime: number },
    now: number,
  ): number {
    const t = Math.min((now - anim.startTime) / RenderSystem.GUNPORT_ANIM_MS, 1.0);
    const eased = t * t * (3 - 2 * t); // smooth-step
    return anim.targetOpen
      ? anim.startProgress + (1 - anim.startProgress) * eased
      : anim.startProgress * (1 - eased);
  }

  /** Trigger a cannon slide-out (open) or slide-in (close) animation for a gunport. */
  triggerGunportAnimation(gunportId: number, isOpen: boolean): void {
    const existing = this.gunportAnimations.get(gunportId);
    const now = performance.now();
    const currentProgress = existing ? this.computeGunportProgress(existing, now) : (isOpen ? 0 : 1);
    this.gunportAnimations.set(gunportId, { targetOpen: isOpen, startProgress: currentProgress, startTime: now });
  }

  /** Returns true if a gunport's cannon slide animation is currently in progress. */
  isGunportAnimating(gunportId: number): boolean {
    const anim = this.gunportAnimations.get(gunportId);
    if (!anim) return false;
    const p = this.computeGunportProgress(anim, performance.now());
    return p > 0.001 && p < 0.999;
  }

  /** Returns the set of cannon module IDs whose gunport is currently mid-animation (fire blocked). */
  getBlockedGunportCannonIds(ship: Ship): Set<number> {
    const blocked = new Set<number>();
    for (const cannon of ship.modules) {
      if (cannon.kind !== 'cannon') continue;
      const gp = this.findGunportForCannon(cannon, ship);
      if (gp && this.isGunportAnimating(gp.id)) blocked.add(cannon.id);
    }
    return blocked;
  }

  /** Whether the given cannon has an associated gunport (i.e. it is a gunport cannon). */
  isGunportCannon(cannon: ShipModule, ship: Ship): boolean {
    return this.findGunportForCannon(cannon, ship) !== null;
  }


  isInBuildMode(): boolean {
    return this.buildMode;
  }

  // Explicit B-key build mode ghost preview state
  private explicitBuildState: { item: 'cannon' | 'sail' | 'swivel'; rotationDeg: number } | null = null;

  // Ghost placement plan markers and pending ghost cursor
  private ghostPlacements: GhostPlacement[] = [];
  private pendingGhostState: { kind: GhostModuleKind; rotDeg: number } | null = null;
  private buildMenuOpen = false;
  /** Planned land structure ghosts (placed but not yet sent to server). */
  private landGhostPlacements: LandGhostPlacement[] = [];

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

  /** Update the list of planned land structure ghost markers. */
  setLandGhostPlacements(ghosts: LandGhostPlacement[]): void {
    this.landGhostPlacements = ghosts;
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
      if (ship.shipType === SHIP_TYPE_GHOST) continue;

      // Collect all present (placed, health > 0) plank slots.
      // Slots with health = 0 are absent and should be hoverable for placement.
      const presentKeys = new Set<string>();
      for (const mod of ship.modules) {
        if (mod.kind === 'plank' && mod.moduleData?.kind === 'plank' && mod.moduleData.health > 0) {
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
        if (this.isPlankSlotWrecked(ship.id, seg.sectionName, seg.index)) continue;

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
   * Toggle the hover debug HUD panel (bottom-right corner, shows raw fields for hovered entity).
   */
  toggleHoverDebugHUD(): void {
    this._showHoverDebugHUD = !this._showHoverDebugHUD;
    console.log(`🔬 Hover debug HUD: ${this._showHoverDebugHUD ? 'ON' : 'OFF'}`);
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
  /**
   * Returns true if `ship` is controlled by / belongs to the local player's side.
   * - Real faction (companyId > 1): same companyId → friendly.
   * - Solo (companyId == 1): friendly only when the ship has an NPC whose ownerId matches
   *   the local player id (i.e. the player owns the crew on this ship).
   * Boarding an enemy ship changes carrierId but NOT NPC ownerships, so this stays correct.
   */
  private isShipFriendly(ship: Ship): boolean {
    const myComp = this._localCompanyId;
    if (myComp > 1 && ship.companyId === myComp) return true;
    if (ship.companyId === 1 && this.localPlayerId !== null) {
      return this._cachedWorldNpcs.some(
        n => n.shipId === ship.id && n.ownerId === this.localPlayerId,
      );
    }
    return false;
  }

  private detectHoveredModule(worldState: WorldState): void {
    this.hoveredModule = null;
    
    if (!this.mouseWorldPos) return;
    
    // Check all ships
    for (const ship of worldState.ships) {
      if (ship.shipType === SHIP_TYPE_GHOST) continue;

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

      // --- Pass 1b: gunports take priority over hull planks (lower deck only) ---
      if (this._playerDeckLevel === 0) {
        for (const module of ship.modules) {
          if (module.kind !== 'gunport') continue;
          const mdx = localX - module.localPos.x;
          const mdy = localY - module.localPos.y;
          if (Math.abs(mdx) <= 13 && Math.abs(mdy) <= 7) {
            this.hoveredModule = { ship, module };
            return;
          }
        }
      }
      
      // --- Pass 2: everything else (planks, cannons, masts, etc.) ---
      for (const module of ship.modules) {
        // Ladders already checked in pass 1; decks are never interactively highlighted
        const _pass2Kind = module.moduleData?.kind ?? module.kind;
        if (_pass2Kind === 'ladder' || _pass2Kind === 'deck') continue;

        // Gunports are only interactable from the lower deck (deck 0)
        if (_pass2Kind === 'gunport' && this._playerDeckLevel !== 0) continue;
        // Planks are interactable from any deck level (build/repair from either deck)
        // All other modules: block cross-deck interaction (deck-independent modules allowed everywhere)
        // Exception: during weapon-group overlay mode (Ctrl held), cannons/swivels are
        // hoverable across decks so the player can assign groups from either deck.
        const _crossDeckGroupMode = this.showGroupOverlay && (_pass2Kind === 'cannon' || _pass2Kind === 'swivel');
        if (!_crossDeckGroupMode && _pass2Kind !== 'plank' && _pass2Kind !== 'gunport'
            && module.deckId !== 255 && module.deckId !== this._playerDeckLevel) continue;

        const moduleKind = _pass2Kind;

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
        } else if (moduleKind === 'ramp' || moduleKind === 'hatch_cover') {
          // Ramp / hatch cover render as a 50×50 square (matches visual footprint)
          width = 50;
          height = 50;
        } else if (moduleKind === 'gunport') {
          // Gunport only interactable from lower deck; skip on upper deck
          if (this._playerDeckLevel !== 0) continue;
          // Gunport renders as a 22×10 rectangle on the hull plank
          width = 24;
          height = 14;
        } else if (moduleKind === 'chest') {
          // Chest is a 40×28 world-unit box
          width = 44;
          height = 32;
        } else if (moduleKind === 'workbench') {
          width = 44;
          height = 31;
        } else if (moduleKind === 'bed') {
          width = 44;
          height = 24;
        } else if (moduleKind === 'well') {
          width = 32;
          height = 32;
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
    // Quantise to 21 buckets (0 … 20 = 0% … 100%) to keep the LUT small.
    // Full health (bucket 20) still costs the same; the savings are at intermediate damage.
    const bucket = Math.round(Math.max(0, Math.min(1, healthRatio)) * 20);
    const key = `${hex}:${bucket}`;
    const cached = this._darkenCache.get(key);
    if (cached) return cached;
    const t = bucket / 20;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const result = `rgb(${Math.round(r * t)},${Math.round(g * t)},${Math.round(b * t)})`;
    this._darkenCache.set(key, result);
    return result;
  }

  /**
   * Returns sinking-related render state for a ship.
   *  waterFill           0–1 : fraction of hull filled with water (1 - hullHealth/100)
   *  lowerDeckFloodTint  0–1 : lower deck blue overlay (ramps from 25% flood → full)
   *  upperDeckFloodTint  0–1 : upper deck blue overlay (ramps from 75% flood → full)
   *  floodTint           alias for upperDeckFloodTint (legacy call sites)
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
    lowerDeckFloodTint: number;
    upperDeckFloodTint: number;
    floodTint: number;
    phase1Alpha: number;
    phase2Alpha: number;
    phase3Alpha: number;
  } {
    // Memoize within a single frame — this function is called ~10× per visible ship.
    const cached = this._sinkStateCache.get(ship.id);
    if (cached) return cached;

    const isGhostShipForHP = ship.shipType === SHIP_TYPE_GHOST;
    const ghostNpcLevel = isGhostShipForHP && ship.npcLevel != null && ship.npcLevel > 0 ? ship.npcLevel : 1;
    const maxHullHP = isGhostShipForHP
      ? Math.round(GHOST_MAX_HULL_HP * (1 + (ghostNpcLevel - 1) * 9 / 59))
      : 100;
    // Once the sink animation has started, lock hullPct at 0 so the fade can't reverse
    const rawHullPct = Math.max(0, Math.min(1, ship.hullHealth / maxHullHP));
    const hullPct = this.sinkTimestamps.has(ship.id) ? 0 : rawHullPct;
    const waterFill = Math.max(0, Math.min(1, 1 - hullPct));
    const lowerDeckFloodTint = computeDeckFloodTint(waterFill, BUCKET_LOWER_SCOOP_FILL);
    const upperDeckFloodTint = computeDeckFloodTint(waterFill, BUCKET_UPPER_SCOOP_FILL);
    const floodTint = upperDeckFloodTint;

    // Start the clock for any live ship the moment hullHealth hits 0 (fallback if SHIP_SINKING arrives late).
    // Ghost ships rely exclusively on the explicit markShipSinking() call from the SHIP_SINKING server
    // message — do NOT auto-trigger here.  Their hullHealth field may be 0 or unset even while alive,
    // because the server tracks their HP on a different scale (0–60000) and may not populate the field.
    if (ship.shipType !== SHIP_TYPE_GHOST && ship.hullHealth <= 0 && !this.sinkTimestamps.has(ship.id)) {
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
    const result = {
      waterFill,
      lowerDeckFloodTint,
      upperDeckFloodTint,
      floodTint,
      phase1Alpha,
      phase2Alpha,
      phase3Alpha,
    };
    this._sinkStateCache.set(ship.id, result);
    return result;
  }

  /**
   * Build a canvas path for a deck's walkable surface (module area polygon, or hull fallback).
   * Upper deck (1) subtracts ramp/hatch holes via even-odd fill.
   */
  private _buildDeckSurfacePath(ship: Ship, deckLevel: number, deckMod?: ShipModule): 'fill' | 'evenodd' | null {
    const area = deckMod?.moduleData?.kind === 'deck'
      ? (deckMod.moduleData as DeckModuleData).area
      : undefined;
    if (area && area.length >= 3) {
      this.ctx.beginPath();
      this.ctx.moveTo(area[0].x, area[0].y);
      for (let i = 1; i < area.length; i++) this.ctx.lineTo(area[i].x, area[i].y);
      this.ctx.closePath();
      return 'fill';
    }
    if (ship.hull.length < 3) return null;
    this.ctx.beginPath();
    this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    this.ctx.closePath();
    if (deckLevel === 1) {
      for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
        this.ctx.rect(sp.x - 25, sp.y - 25, 50, 50);
      }
      return 'evenodd';
    }
    return 'fill';
  }

  /** Blue flood tint clipped to a single deck's walkable surface. */
  private _drawDeckFloodFill(
    ship: Ship,
    deckLevel: number,
    floodTint: number,
    phase1Alpha: number,
    deckMod?: ShipModule,
  ): void {
    if (floodTint <= 0) return;
    const mod = deckMod ?? ship.modules.find(m => m.kind === 'deck' && m.deckId === deckLevel);
    const fillMode = this._buildDeckSurfacePath(ship, deckLevel, mod);
    if (!fillMode) return;
    this.ctx.save();
    this.ctx.globalAlpha = floodTint * 0.55 * (phase1Alpha < 1 ? phase1Alpha : 1);
    this.ctx.fillStyle = '#1a6eb5';
    if (fillMode === 'evenodd') this.ctx.fill('evenodd');
    else this.ctx.fill();
    this.ctx.restore();
  }

  /**
   * Per-deck-index flood overlays on walkable deck surfaces (layer 3).
   * Lower deck on two-deck ships is handled in drawLowerDeckFloor (hatches / below-deck view).
   */
  private drawShipDeckFloodOverlays(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
    if (ship.shipType === SHIP_TYPE_GHOST) return;

    const { lowerDeckFloodTint, upperDeckFloodTint, phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const hasUpperDeck = ship.modules.some(m => m.kind === 'deck' && m.deckId === 1);
    const playerBelow = this._lowerDeckShipId === ship.id;

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    for (const mod of ship.modules) {
      if (mod.kind !== 'deck') continue;
      const deckLevel = mod.deckId;
      if (deckLevel === 0) {
        if (hasUpperDeck) continue;
        this._drawDeckFloodFill(ship, 0, lowerDeckFloodTint, phase1Alpha, mod);
      } else if (deckLevel === 1) {
        if (playerBelow) continue;
        this._drawDeckFloodFill(ship, 1, upperDeckFloodTint, phase1Alpha, mod);
      }
    }

    this.ctx.restore();
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

    // Flush per-frame memoization caches so stale entries don't linger across frames.
    this._sinkStateCache.clear();
    this._darkenCache.clear();

    // Prune persistent OffscreenCanvas sprite caches for ships that have left.
    // Only run when the map size diverges from ship count to avoid work every frame.
    const _liveShipIds = new Set(worldState.ships.map(s => s.id));
    if (this._shipHullSprites.size > _liveShipIds.size + 4) {
      for (const id of this._shipHullSprites.keys()) if (!_liveShipIds.has(id)) this._shipHullSprites.delete(id);
    }
    if (this._shipPlankSprites.size > _liveShipIds.size + 4) {
      for (const id of this._shipPlankSprites.keys()) if (!_liveShipIds.has(id)) this._shipPlankSprites.delete(id);
    }
    if (this._shipUpperDeckSprites.size > _liveShipIds.size + 4) {
      for (const id of this._shipUpperDeckSprites.keys()) if (!_liveShipIds.has(id)) this._shipUpperDeckSprites.delete(id);
    }
    if (this._ghostHullSprites.size > _liveShipIds.size + 4) {
      for (const id of this._ghostHullSprites.keys()) if (!_liveShipIds.has(id)) this._ghostHullSprites.delete(id);
    }
    if (this._ghostCombinedSprites.size > _liveShipIds.size + 4) {
      for (const id of this._ghostCombinedSprites.keys()) if (!_liveShipIds.has(id)) this._ghostCombinedSprites.delete(id);
    }

    // Cache local player and ships once per frame — shared by all detect* and draw* methods.
    this._cachedLocalPlayer = this.localPlayerId != null
      ? worldState.players.find(p => p.id === this.localPlayerId) ?? null
      : null;
    this._localCompanyId = this._cachedLocalPlayer?.companyId ?? 0;
    this._cachedWorldShips   = worldState.ships;
    this._cachedWorldPlayers  = worldState.players;
    this._cachedWorldNpcs     = worldState.npcs ?? [];
    this._cachedCompanies     = worldState.companies ?? [];

    // ── Smooth barrel angles toward server values every frame ──────────────
    // The server steps barrels at 60°/s but only broadcasts at ~20 Hz, so the
    // raw aimDirection jumps 3° every 50 ms.  We lerp the displayed angle at a
    // faster rate so the visual barrel moves continuously at 60 fps.
    {
      const nowMs = performance.now();
      const frameDt = this._lastRenderMs > 0 ? Math.min((nowMs - this._lastRenderMs) / 1000, 0.1) : 0;
      this._lastRenderMs = nowMs;
      // Close 10× the remaining angular gap per second (time constant ≈ 100 ms).
      const alpha = frameDt > 0 ? Math.min(1.0, 10.0 * frameDt) : 1.0;
      const _smoothCarrierId = this._cachedLocalPlayer?.carrierId ?? 0;
      for (const ship of worldState.ships) {
        // Skip smoothing entirely for ships that are outside the fog boundary.
        // The carrier ship (player's own ship) is always smoothed so local cannon/sail
        // angles stay continuous even near the fog edge.
        if (ship.id !== _smoothCarrierId && !this.fogVisibleAt(ship.position.x, ship.position.y, this._hullRadius(ship))) continue;
        // Rudder angle
        {
          const target = ship.rudderAngle || 0;
          const prev   = this._smoothRudderAngles.get(ship.id) ?? target;
          let diff = target - prev;
          while (diff >  Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          this._smoothRudderAngles.set(ship.id, prev + diff * alpha);
        }
        for (const mod of ship.modules) {
          // Cannon barrel
          if (mod.kind === 'cannon' && mod.moduleData?.kind === 'cannon') {
            const target = mod.moduleData.aimDirection || 0;
            const prev   = this._smoothBarrelAngles.get(mod.id) ?? target;
            let diff = target - prev;
            while (diff >  Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;
            this._smoothBarrelAngles.set(mod.id, prev + diff * alpha);
          }
          // Sail angle and openness
          if (mod.kind === 'mast' && mod.moduleData?.kind === 'mast') {
            const targetAngle    = mod.moduleData.angle    ?? 0;
            const targetOpenness = mod.moduleData.openness ?? 0;
            const prevAngle    = this._smoothSailAngles.get(mod.id)   ?? targetAngle;
            const prevOpenness = this._smoothSailOpenness.get(mod.id) ?? targetOpenness;
            let diff = targetAngle - prevAngle;
            while (diff >  180) diff -= 360;
            while (diff < -180) diff += 360;
            this._smoothSailAngles.set(mod.id,    prevAngle + diff * alpha);
            this._smoothSailOpenness.set(mod.id,  prevOpenness + (targetOpenness - prevOpenness) * alpha);
          }
        }

        // Sail-fiber alpha: fade to 0.30 when local player is on deck, else 1.0
        {
          const onDeck = this._cachedLocalPlayer !== null
            && this._cachedLocalPlayer.carrierId === ship.id
            && !this._cachedLocalPlayer.isMounted;
          const targetAlpha = onDeck ? 0.30 : 1.0;
          const prevAlpha   = this._sailAlphaByShip.get(ship.id) ?? targetAlpha;
          const FADE_SPEED  = 3.0; // fractions of the gap closed per second
          const newAlpha    = prevAlpha + (targetAlpha - prevAlpha) * Math.min(1, FADE_SPEED * frameDt);
          this._sailAlphaByShip.set(ship.id, newAlpha);
        }
      }

      // Upper-deck fade: smoothly dim upper-deck modules and NPCs while on the lower deck.
      {
        const _udTarget = this._playerDeckLevel === 0 ? 0.3 : 1.0;
        const _udSpeed  = 4.0; // transition completes in ~300 ms
        this._upperDeckFade = this._upperDeckFade + (_udTarget - this._upperDeckFade) * Math.min(1, _udSpeed * frameDt);
      }
    }

    // Rebuild scaffolded ship lookup: maps ship entity ID → owning shipyard structure
    this._scaffoldedShips.clear();
    for (const s of this.placedStructures) {
      if (s.type === 'shipyard' && s.construction?.phase === 'building' && s.construction.scaffoldedShipId) {
        this._scaffoldedShips.set(s.construction.scaffoldedShipId, s);
      }
    }

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
      this.detectHoveredGunportCannonSnap(worldState);
    } else {
      this.hoveredCannonSlot = null;
      this.hoveredGunportCannonSnap = null;
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

    // In ramp or hatch build mode, detect which snap point is under the cursor
    if (this.rampBuildMode || this.hatchBuildMode) {
      this.detectHoveredRampSlot(worldState);
    } else {
      this.hoveredRampSlot = null;
    }

    // In gunport build mode, detect which gunport snap is under the cursor
    if (this.gunportBuildMode) {
      this.detectHoveredGunportSnap(worldState);
      // detectHoveredGunportCannonSnap is already called above for all build modes
    } else {
      this.hoveredGunportSnap = null;
    }

    // Draw background elements
    this.drawWater(camera);
    if (this.config.showGrid) this.drawGrid(camera);
    {
      const _t0 = this.perfTimingsEnabled ? performance.now() : 0;
      this.drawIsland(camera); // drawPlacedStructures is called inside, between trunk and leaf passes
      if (this.perfTimingsEnabled) this._perfMs.island = performance.now() - _t0;
    }
    this.drawIslandBuildGhost(camera);
    if (this.landBuildModeActive) this.drawLandGhostPlacements(camera);
    
    // ── Snap scaffolded ships into their shipyard docks ───────────────────────
    // Temporarily override position/rotation so every draw call renders the ship
    // inside the dock.  Originals are restored after the render queue executes.
    const scaffoldOverrides: { ship: Ship; origPos: Vec2; origRot: number }[] = [];
    for (const ship of worldState.ships) {
      const scaffold = this._scaffoldedShips.get(ship.id);
      if (scaffold) {
        scaffoldOverrides.push({ ship, origPos: ship.position, origRot: ship.rotation });
        const syRot = (scaffold.rotation ?? 0) * Math.PI / 180;
        ship.position = Vec2.from(scaffold.x, scaffold.y);
        ship.rotation = syRot + Math.PI / 2; // align ship +X (bow) with dock +Y (mouth)
      }
    }

    // Queue all game objects for layered rendering
    {
      const _t0 = this.perfTimingsEnabled ? performance.now() : 0;
      this.queueWorldObjects(worldState, camera, interpolationAlpha);
      if (this.perfTimingsEnabled) this._perfMs.queue = performance.now() - _t0;
    }
    
    // Execute render queue in layer order
    {
      const _t0 = this.perfTimingsEnabled ? performance.now() : 0;
      this.executeRenderQueue();
      if (this.perfTimingsEnabled) this._perfMs.execute = performance.now() - _t0;
    }

    // ── Fiber bushes — above players, below tree leaves ──────────────────────
    const { zoom, rotation: _deferCamRot } = camera.getState();
    for (const b of this._pendingBushes) {
      this.drawIslandFiberPlant(b.sp.x, b.sp.y, zoom, _deferCamRot, b.isHovered, b.bushAlpha * b.deathAlpha, b.ox, b.oy, b.wx, b.wy);
    }

    // ── Wood ceilings — above bushes (roof covers vegetation underneath) ──────
    this.drawPendingCeilings(camera);

    // ── Tree leaves — above bushes and players ────────────────────────────────
    const camRot = camera.getState().rotation;
    for (const e of this._pendingAllRes) {
      if (e.res.type !== 'wood') continue;
      this.drawIslandTreeLeaves(e.sp.x, e.sp.y, zoom, camRot, e.isHovered, e.inRange, e.leafAlpha, e.res.ox, e.res.oy, e.res.size ?? 1.0, e.deathAlpha, e.wx, e.wy);
    }

    // ── Hover prompts + health bars (always on top) ───────────────────────────
    for (const e of this._pendingAllRes) {
      if (e.res.type === 'wood' && e.isHovered) {
        if (!this.combatMode) {
          if (this._pendingAxeEquipped) this.drawHarvestPrompt(e.sp.x, e.sp.y, zoom, e.inRange);
          else                          this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, false, '(need axe)');
        }
        if ((e.res.maxHp ?? 0) > 0) this.drawResourceHealthBar(e.sp.x, e.sp.y, zoom, e.res.hp ?? e.res.maxHp, e.res.maxHp ?? 1, (e.res.size ?? 1.0) * 40);
      } else if (e.res.type === 'fiber' && e.isHovered) {
        if (!this.combatMode) this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, e.inRange, '[E] Gather Fiber');
        if ((e.res.maxHp ?? 0) > 0) this.drawResourceHealthBar(e.sp.x, e.sp.y, zoom, e.res.hp ?? e.res.maxHp, e.res.maxHp ?? 1, 30);
      } else if (e.res.type === 'rock' && e.isHovered) {
        if (!this.combatMode) this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, e.inRange, '[E] Pick Up');
        if ((e.res.maxHp ?? 0) > 0) this.drawResourceHealthBar(e.sp.x, e.sp.y, zoom, e.res.hp ?? e.res.maxHp, e.res.maxHp ?? 1, 28);
      } else if (e.res.type === 'boulder' && e.isHovered) {
        if (!this.combatMode) {
          if (this._pendingPickaxeEquipped) this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, e.inRange, '[E] Mine Boulder');
          else                              this.drawGatherPrompt(e.sp.x, e.sp.y, zoom, false, '(need pickaxe)');
        }
        if ((e.res.maxHp ?? 0) > 0) this.drawResourceHealthBar(e.sp.x, e.sp.y, zoom, e.res.hp ?? e.res.maxHp, e.res.maxHp ?? 1, 64);
      }
    }

    // ── Territory claim overlay (drawn when Alt is held) ─────────────────────
    // Rendered above the resource layer (nodes, hover prompts, and health bars)
    // so the dominance borders/hatching aren't occluded by trees, bushes, or
    // gather UI when inspecting territory.
    if (this._showTerritoryOverlay) {
      this.drawTerritoryOverlay(camera);
    }

    // Restore scaffolded ship positions so game logic is unaffected
    for (const o of scaffoldOverrides) {
      o.ship.position = o.origPos;
      o.ship.rotation = o.origRot;
    }

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
    // Directional fog mask (after world geometry and effects, before HUD)
    {
      const _t0 = this.perfTimingsEnabled ? performance.now() : 0;
      this.drawFogMask(camera);
      if (this.perfTimingsEnabled) this._perfMs.fog = performance.now() - _t0;
    }
    this.drawBucketDumpHint(camera);
    // Screen-space announcement banners (on top of everything)
    this.effectRenderer.renderAnnouncements(this.canvas);

    // Camera mode badge (free-cam / rotate-cam indicator)
    if (this.cameraMode) this.drawCameraModeBadge();

    // Sword cooldown cursor ring (topmost — always in screen space)
    this.drawSwordCooldownCursor();
    // Ladder hold-progress ring
    this.drawLadderHoldRing();
    // Move To directive arrow line (above world, below UI menus)
    this.drawMoveToArrowLine(worldState, camera);
    // Module hover glow (always-on, independent of move-to mode)
    this.drawModuleHoverHighlight(camera);
    // Quality-tier gems on cannons/masts/swivels crafted from quality blueprints
    this.drawModuleQualityMarkers(worldState, camera);
    // Insufficient-resource badge above cursor in build mode
    this.drawBuildAffordabilityBadge(camera);
    // Hammer repair overlays — damaged module icons when hammer is equipped
    if (this.hammerEquipped) this.drawHammerRepairOverlays(worldState, camera);
    // Ship hull hover glow (always-on, normal hover)
    this.drawShipHullHighlight(camera);
    // Ship hull highlight when multi-select NPCs are pending a destination
    this.drawMultiSelectHoverHighlight(worldState, camera);
    // Box-select drag rectangle
    this.drawBoxSelectRect();
    // Selection rings for box-selected NPCs
    this.drawSelectedNpcRings(worldState, camera);
    // Radial action menu (topmost)
    this._radialMenu?.render(this.ctx);
    // Move To targeting hint banner
    this.drawMoveToHint();
    
    // Draw hover boundaries debug if enabled
    if (this.showHoverBoundaries) {
      this.drawHoverBoundariesDebug(worldState, camera);
    }
    
    // Draw hover tooltip (screen space, on top of everything) — 500 ms delay
    const _curTtKey = this.hoveredModule
      ? `mod-${(this.hoveredModule.module as { id?: number }).id ?? 0}`
      : this.hoveredNpc
      ? `npc-${this.hoveredNpc.id}`
      : this.hoveredShip
      ? `ship-${this.hoveredShip.id}`
      : this._hoveredStructure
      ? `struct-${this._hoveredStructure.id}`
      : '';
    const _nowTt = performance.now();
    if (_curTtKey !== this._tooltipHoverKey) {
      this._tooltipHoverKey   = _curTtKey;
      this._tooltipHoverStart = _nowTt;
    }
    this._tooltipReady = _curTtKey !== '' && (_nowTt - this._tooltipHoverStart) >= 500;
    this.drawHoverTooltip(camera);
    this.drawNpcTooltip(camera);
    this.drawShipHullTooltip(camera);
    this.drawStructureTooltip(camera);
  }
  
  /**
   * Draws a small pill badge at the top-centre of the canvas indicating the
   * current camera mode (FREE CAMERA / ROTATE CAMERA).
   */
  private drawCameraModeBadge(): void {
    const mode = this.cameraMode;
    if (!mode) return;
    const ctx = this.ctx;
    const label   = mode === 'free' ? '🎥  FREE CAMERA' : '🔄  ROTATE CAMERA';
    const accent  = mode === 'free' ? '#44ccff' : '#ffcc44';
    const cx      = this.canvas.width / 2;
    const cy      = 28;

    ctx.save();
    ctx.font = 'bold 13px "Georgia", serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const tw   = ctx.measureText(label).width;
    const ph   = 18;  // pill half-height
    const pw   = tw / 2 + 14;  // pill half-width

    // Pill background
    ctx.fillStyle   = 'rgba(0, 0, 0, 0.70)';
    ctx.strokeStyle = accent;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx - pw, cy - ph / 2, pw * 2, ph, ph / 2);
    ctx.fill();
    ctx.stroke();

    // Label
    ctx.fillStyle = accent;
    ctx.fillText(label, cx, cy);

    // "Home to reset" hint for rotate mode
    if (mode === 'rotate') {
      ctx.font = '10px "Georgia", serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText('Home: reset angle', cx, cy + ph / 2 + 9);
    }

    ctx.restore();
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

  /** Semi-transparent overlay drawn over the game while reconnecting. */
  /**
   * Render a directional fog mask based on per-ray hit distances from the AOI ray cast.
   *
   * The mask uses an off-screen canvas for compositing:
   *  1. Fill with a dark sea-fog color.
   *  2. Hard-erase the visibility polygon (interior fully clear).
   *  3. Blurred-erase the polygon again so the boundary fades softly into fog.
   *  4. Blit onto the main canvas at reduced opacity.
   */
  /**
   * Returns true if a world position falls within the current fog visibility radius.
   * Uses the per-direction ray hit distances; always returns true when fog data is unavailable.
   */
  public fogVisibleAt(wx: number, wy: number, radius = 0): boolean {
    const hitDist = this.fogRayHitDist;
    if (!hitDist) return true;
    const player = this._cachedLocalPlayer;
    if (!player) return true;
    const N = hitDist.length;
    if (N === 0) return true;
    const dx = wx - player.position.x;
    const dy = wy - player.position.y;
    if (dx * dx + dy * dy < 1) return true;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += Math.PI * 2;
    const frac = angle / (Math.PI * 2 / N);
    const i0 = Math.floor(frac) % N;
    const i1 = (i0 + 1) % N;
    const t  = frac - Math.floor(frac);
    const fogDist = hitDist[i0] * (1 - t) + hitDist[i1] * t;
    return dist <= fogDist * 1.05 + radius;
  }

  private drawFogMask(camera: Camera): void {
    const hitDist = this.fogRayHitDist;
    if (!hitDist) return;

    const localPlayer = this._cachedLocalPlayer;
    if (!localPlayer) return;

    const N = hitDist.length;
    if (N === 0) return;

    // Skip fog when rays are uninitialized (all ~0) — otherwise the mask covers everything.
    let maxRay = 0;
    for (let i = 0; i < N; i++) {
      if (hitDist[i] > maxRay) maxRay = hitDist[i];
    }
    if (maxRay < 1) return;

    // Read camera state once — avoids two getState() calls that each clone a Vec2.
    const camZoom = camera.zoom;
    const camRot  = camera.rotation;
    const screenPos = camera.worldToScreen(localPlayer.position);
    const cx = screenPos.x;
    const cy = screenPos.y;
    const TWO_PI = Math.PI * 2;
    const { width, height } = this.canvas;

    // Raster fog at reduced resolution (tied to fogRenderScale / GL adaptive scale).
    const fogScale = Math.max(0.25, Math.min(1, this.fogRenderScale));
    const fw = Math.max(1, Math.ceil(width  * fogScale));
    const fh = Math.max(1, Math.ceil(height * fogScale));
    const fcX = cx * fogScale;
    const fcY = cy * fogScale;
    const blurPx = Math.max(8, Math.round(48 * fogScale));

    // Ensure the off-screen fog canvas matches the current resolution
    if (!this._fogCanvas || this._fogCanvas.width !== fw || this._fogCanvas.height !== fh) {
      this._fogCanvas = document.createElement('canvas');
      this._fogCanvas.width  = fw;
      this._fogCanvas.height = fh;
      // Force a full redraw on resize
      this._fogLastRayVersion = -1;
    }

    // Skip the expensive blur redraw when nothing has changed.
    // The fog rays update at ~30 Hz (worker cadence); the render loop runs at
    // 60-120 Hz, so most frames can just re-blit the cached fog canvas.
    //
    // Zoom dead-zone: ignore sub-3% zoom changes when scrolling.  Without this,
    // every frame of a smooth pinch/scroll triggers a full fog re-rasterise
    // (the blur filter pass) which is the single most expensive canvas
    // operation in the renderer.  A 3% zoom delta is imperceptible in fog shape.
    const FOG_ZOOM_EPSILON = 0.03;
    const zoomChanged = Math.abs(camZoom - this._fogLastZoom) > FOG_ZOOM_EPSILON * Math.max(camZoom, this._fogLastZoom);
    const scaleChanged = Math.abs(fogScale - this._fogLastRenderScale) > 0.01;
    const camMoved = Math.round(fcX) !== Math.round(this._fogLastCamX)
                  || Math.round(fcY) !== Math.round(this._fogLastCamY)
                  || zoomChanged || camRot  !== this._fogLastRot
                  || scaleChanged;
    const raysDirty = this.fogRayVersion !== this._fogLastRayVersion;

    if (!raysDirty && !camMoved) {
      // Nothing changed — blit the already-rendered fog canvas directly.
      this.ctx.save();
      this.ctx.globalAlpha = 0.68;
      this.ctx.drawImage(this._fogCanvas, 0, 0, fw, fh, 0, 0, width, height);
      this.ctx.restore();
      return;
    }

    // Record the camera/ray state for next frame's dirty check.
    this._fogLastRayVersion = this.fogRayVersion;
    this._fogLastCamX = Math.round(fcX);
    this._fogLastCamY = Math.round(fcY);
    this._fogLastZoom = camZoom;
    this._fogLastRot  = camRot;
    this._fogLastRenderScale = fogScale;

    const fc   = this._fogCanvas;
    const fctx = fc.getContext('2d')!;

    // --- Step 1: Fill with opaque dark fog ---
    fctx.globalCompositeOperation = 'source-over';
    fctx.clearRect(0, 0, fw, fh);
    fctx.fillStyle = '#000612'; // deep navy-black
    fctx.fillRect(0, 0, fw, fh);

    // Helper: trace the visibility fan polygon on the fog canvas (scaled coords)
    const tracePolygon = (scale: number) => {
      fctx.beginPath();
      fctx.moveTo(fcX, fcY);
      for (let i = 0; i <= N; i++) {
        const idx   = i % N;
        const angle = idx * TWO_PI / N - camRot;
        const dist  = hitDist[idx] * camZoom * scale * fogScale;
        fctx.lineTo(fcX + Math.cos(angle) * dist, fcY + Math.sin(angle) * dist);
      }
      fctx.closePath();
    };

    // --- Step 2: Hard-erase visibility interior ---
    fctx.globalCompositeOperation = 'destination-out';
    fctx.fillStyle = 'rgba(0,0,0,1)';
    tracePolygon(1.0);
    fctx.fill();

    // --- Step 3: Soft feather — blurred erase extends the clear zone outward ---
    fctx.filter = `blur(${blurPx}px)`;
    tracePolygon(1.0);
    fctx.fill();
    fctx.filter = 'none';

    fctx.globalCompositeOperation = 'source-over';

    // --- Step 4: Blit onto main canvas at 68% opacity (upscale from internal buffer) ---
    this.ctx.save();
    this.ctx.globalAlpha = 0.68;
    this.ctx.drawImage(fc, 0, 0, fw, fh, 0, 0, width, height);
    this.ctx.restore();
  }

  drawReconnectingOverlay(): void {
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;

    // Spinner
    const now = performance.now();
    const angle = (now / 600) * Math.PI * 2;
    const R = 28;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy - 52, R, angle, angle + Math.PI * 1.4);
    ctx.stroke();

    // "Reconnecting..." text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Reconnecting…', cx, cy + 4);

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
    this.ctx.font = '48px Georgia, serif';
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
    if (this._gl) {
      // GL ocean renderer already drew the background — Canvas 2D stays transparent
      return;
    }
    // Simple solid water color
    this.ctx.fillStyle = '#1e90ff'; // Ocean blue
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
  
  private drawGrid(camera: Camera): void {
    const bounds = camera.getWorldBounds();
    const majorStep = 30_000;

    // Active world for now: one 90k x 90k square. Use explicit major lines at
    // 0, 30k, 60k so players can orient quickly; world border itself provides
    // the outer 90k edge.
    const worldW = this._wrapWorldWidth > 0 ? this._wrapWorldWidth : 90_000;
    const worldH = this._wrapWorldHeight > 0 ? this._wrapWorldHeight : 90_000;

    this.ctx.strokeStyle = '#ffffff26';
    this.ctx.lineWidth = 1.5;

    const verticalLineCount = Math.max(1, Math.floor(worldW / majorStep));
    for (let i = 0; i < verticalLineCount; i++) {
      const x = i * majorStep;
      if (x < bounds.min.x - majorStep || x > bounds.max.x + majorStep) continue;
      const screenStart = camera.worldToScreen(Vec2.from(x, bounds.min.y));
      const screenEnd = camera.worldToScreen(Vec2.from(x, bounds.max.y));
      this.ctx.beginPath();
      this.ctx.moveTo(screenStart.x, screenStart.y);
      this.ctx.lineTo(screenEnd.x, screenEnd.y);
      this.ctx.stroke();
    }

    const horizontalLineCount = Math.max(1, Math.floor(worldH / majorStep));
    for (let i = 0; i < horizontalLineCount; i++) {
      const y = i * majorStep;
      if (y < bounds.min.y - majorStep || y > bounds.max.y + majorStep) continue;
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

  private offsetVertices(
    vertices: { x: number; y: number }[] | undefined,
    dx: number,
    dy: number,
  ): { x: number; y: number }[] | undefined {
    if (!vertices) return undefined;
    if (dx === 0 && dy === 0) return vertices;
    return vertices.map((v) => ({ x: v.x + dx, y: v.y + dy }));
  }

  private drawIsland(camera: Camera): void {
    const { zoom, rotation: camRot } = camera.getState();
    // Reset per-frame hovered resource nodes
    this._hoveredTree       = null;
    this._hoveredFiberPlant = null;
    this._hoveredRock       = null;
    this._hoveredBoulder    = null;
    this._pendingBushes     = [];
    this._pendingBoulders   = [];
    this._pendingAllRes     = [];
    this._pendingCeilings   = [];

    const localPlayer = this._cachedLocalPlayer;
    const axeEquipped = (() => {
      if (!localPlayer || localPlayer.carrierId !== 0) return false;
      const slot = localPlayer.inventory?.activeSlot ?? 0;
      const item = localPlayer.inventory?.slots[slot]?.item;
      return item === 'axe' || item === 'metal_axe';
    })();
    const pickaxeEquipped = (() => {
      if (!localPlayer || localPlayer.carrierId !== 0) return false;
      const slot = localPlayer.inventory?.activeSlot ?? 0;
      const item = localPlayer.inventory?.slots[slot]?.item;
      return item === 'pickaxe' || item === 'metal_pickaxe';
    })();
    this._pendingAxeEquipped     = axeEquipped;
    this._pendingPickaxeEquipped = pickaxeEquipped;
    const HARVEST_RANGE = 50; // base range (px) — matches server HARVEST_RANGE
    const BOULDER_HARVEST_RANGE = HARVEST_RANGE * 1.40625; // matches server BOULDER_HARVEST_RANGE; scales with node size
    // Effective range per node = HARVEST_RANGE * Math.max(1.0, size) — larger nodes extend reach
    const PLANT_HOVER_SQ = (30 * zoom) * (30 * zoom);
    const ROCK_HOVER_SQ  = (22 * zoom) * (22 * zoom);
    const LEAF_FADE_OUTER = 420;
    const LEAF_FADE_INNER = 120;
    const MIN_LEAF_ALPHA  = 0.35;
    const BUSH_FADE_OUTER = 320;
    const BUSH_FADE_INNER = 90;
    const MIN_BUSH_ALPHA  = 0.30;
    const DEATH_FADE_MS   = 2000;
    const now = performance.now();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const msp = this.mouseWorldPos ? camera.worldToScreen(this.mouseWorldPos) : null;
    const mwp = this.mouseWorldPos;
    const worldBounds = camera.getWorldBounds();
    const RESOURCE_WORLD_PAD = 140;
    const HOVER_QUERY_WORLD_R = 120;

    for (const isl of this.islands) {
      const preset = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
      const polyVerts = isl.vertices && isl.vertices.length >= 3 ? isl.vertices : undefined;
      // Visibility check: adapt radius to polygon bound or bump-circle
      const visR = polyVerts
        ? Math.max(...polyVerts.map(v => Math.hypot(v.x - isl.x, v.y - isl.y))) + 50
        : (preset.beachRadius + Math.max(0, ...preset.beachBumps.map(Math.abs)) + 20);
      const wrapOffsets = this.getWrapRenderOffsets(Vec2.from(isl.x, isl.y), camera, visR + 50);
      for (const off of wrapOffsets) {
        const islandX = isl.x + off.dx;
        const islandY = isl.y + off.dy;
        if (!camera.isWorldPositionVisible(Vec2.from(islandX, islandY), visR)) continue;

        const shiftedVertices = this.offsetVertices(polyVerts, off.dx, off.dy);
        const shiftedGrassVertices = this.offsetVertices(isl.grassVertices, off.dx, off.dy);
        const shiftedShallowVertices = this.offsetVertices(isl.shallowVertices, off.dx, off.dy);
        const shiftedStonePolys = isl.stonePolys?.map(ring => this.offsetVertices(ring, off.dx, off.dy)!);
        const shiftedMetalPolys = isl.metalPolys?.map(ring => this.offsetVertices(ring, off.dx, off.dy)!);

        const sc  = camera.worldToScreen(Vec2.from(islandX, islandY));
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
        if (shiftedVertices) {
          const verts = shiftedVertices;

          // Only render shallow zone if explicit shallow vertices are defined
          if (shiftedShallowVertices?.length) {
            const shallowBoundR = Math.max(...shiftedShallowVertices.map(v => Math.hypot(v.x - islandX, v.y - islandY)));
            const sandBoundR    = Math.max(...verts.map(v => Math.hypot(v.x - islandX, v.y - islandY)));
            const shallowW = Math.max(4, (shallowBoundR - sandBoundR) * zoom);
            const outerScreenVerts = shiftedShallowVertices.map(v => camera.worldToScreen(Vec2.from(v.x, v.y)));
            const sandScreenVerts  = verts.map(v => camera.worldToScreen(Vec2.from(v.x, v.y)));

            const drawSandPath = () => {
              ctx.beginPath();
              sandScreenVerts.forEach((sp, i) => i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y));
              ctx.closePath();
            };

            // Clip to the shallow ring (outer poly minus sand poly, even-odd)
            // so shadow and fill are only visible in the ring zone.
            ctx.beginPath();
            outerScreenVerts.forEach((sp, i) => i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y));
            ctx.closePath();
            sandScreenVerts.forEach((sp, i) => i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y));
            ctx.closePath();
            ctx.clip('evenodd');

            // Draw the sand polygon with shadow passes.
            // Shadow bleeds outward from the sand edge into the ring, clipped to the shallow boundary.
            // Multiple passes produce a sandy→teal→blue gradient by edge distance.
            ctx.fillStyle = 'rgba(220, 195, 130, 1)'; // opaque fill required to cast shadow

            // Cap blur so high zoom values don't trigger enormous GPU compositing passes.
            // Each pass is O(pixels × blurRadius²) on most browsers, so uncapped blur at
            // zoom 3+ collapses frame rate.  40px is visually indistinguishable from larger.
            const MAX_SHALLOW_BLUR = 40;
            // At high zoom only one pass is needed — the detail is already visible.
            const shallowPasses = zoom > 2.0 ? 1 : zoom > 1.2 ? 2 : 3;

            // Pass 1 — sandy, tight near-edge halo (always drawn)
            ctx.shadowBlur  = Math.min(MAX_SHALLOW_BLUR, Math.max(1, shallowW * 0.30));
            ctx.shadowColor = 'rgba(220, 195, 130, 0.95)';
            drawSandPath(); ctx.fill();

            if (shallowPasses >= 2) {
              // Pass 2 — teal mid-zone
              ctx.shadowBlur  = Math.min(MAX_SHALLOW_BLUR, Math.max(1, shallowW * 0.62));
              ctx.shadowColor = 'rgba(100, 205, 195, 0.80)';
              drawSandPath(); ctx.fill();
            }

            if (shallowPasses >= 3) {
              // Pass 3 — blue outer fade
              ctx.shadowBlur  = Math.min(MAX_SHALLOW_BLUR, Math.max(1, shallowW));
              ctx.shadowColor = 'rgba(60, 170, 205, 0.50)';
              drawSandPath(); ctx.fill();
            }
          }
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
            const sp = camera.worldToScreen(Vec2.from(islandX + Math.cos(angle) * r, islandY + Math.sin(angle) * r));
            i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
          }
          ctx.closePath();
          // Inner subpath: beach boundary (cuts out island via even-odd)
          for (let i = 0; i <= SEG; i++) {
            const angle = (i / SEG) * TWO_PI;
            const t  = (angle / TWO_PI) * n;
            const i0 = Math.floor(t) % n, i1 = (i0 + 1) % n;
            const r  = preset.beachRadius + preset.beachBumps[i0] + (t - Math.floor(t)) * (preset.beachBumps[i1] - preset.beachBumps[i0]);
            const sp = camera.worldToScreen(Vec2.from(islandX + Math.cos(angle) * r, islandY + Math.sin(angle) * r));
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

      if (shiftedVertices) {
        // ── Polygon island ─────────────────────────────────────────────────────
        const polyBoundR = Math.max(...shiftedVertices.map(v => Math.hypot(v.x - islandX, v.y - islandY)));

        // Beach
        this.traceIslandPolygon(camera, shiftedVertices);
        const beachGrad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, polyBoundR * zoom * 1.05);
        beachGrad.addColorStop(0.0,  preset.beachColors[0]);
        beachGrad.addColorStop(0.65, preset.beachColors[1]);
        beachGrad.addColorStop(1.0,  preset.beachColors[2]);
        ctx.fillStyle = beachGrad;
        ctx.fill();
        ctx.strokeStyle = preset.borderColor;
        ctx.lineWidth   = Math.max(1, 2 * zoom);
        ctx.stroke();

        // Grass interior (explicit polygon if provided, else scale sand polygon toward centre)
        const grassVerts = shiftedGrassVertices ?? (() => {
          const gScale = preset.grassPolyScale ?? 0.78;
          return shiftedVertices.map(v => ({
            x: islandX + (v.x - islandX) * gScale,
            y: islandY + (v.y - islandY) * gScale,
          }));
        })();
        this.traceIslandPolygon(camera, grassVerts);
        const grassBoundR = Math.max(...grassVerts.map(v => Math.hypot(v.x - islandX, v.y - islandY)));
        const grassGrad = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, grassBoundR * zoom);
        grassGrad.addColorStop(0.0, preset.grassColors[0]);
        grassGrad.addColorStop(0.7, preset.grassColors[1]);
        grassGrad.addColorStop(1.0, preset.grassColors[2]);
        ctx.fillStyle = grassGrad;
        ctx.fill();

        // ── Stone biome overlay (above grass) ─────────────────────────────
        if (shiftedStonePolys?.length) {
          ctx.save();
          for (const ring of shiftedStonePolys) {
            if (!ring || ring.length < 3) continue;
            ctx.beginPath();
            ring.forEach((v, i) => {
              const sp = camera.worldToScreen(Vec2.from(v.x, v.y));
              i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
            });
            ctx.closePath();
            ctx.fillStyle = 'rgba(118, 90, 55, 0.55)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(90, 65, 35, 0.7)';
            ctx.lineWidth = Math.max(1, 1.5 * zoom);
            ctx.stroke();
          }
          ctx.restore();
        }

        // ── Metal biome overlay (above grass, same stone color) ────────────
        if (shiftedMetalPolys?.length) {
          ctx.save();
          for (const ring of shiftedMetalPolys) {
            if (!ring || ring.length < 3) continue;
            ctx.beginPath();
            ring.forEach((v, i) => {
              const sp = camera.worldToScreen(Vec2.from(v.x, v.y));
              i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
            });
            ctx.closePath();
            ctx.fillStyle = 'rgba(118, 90, 55, 0.55)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(90, 65, 35, 0.7)';
            ctx.lineWidth = Math.max(1, 1.5 * zoom);
            ctx.stroke();
          }
          ctx.restore();
        }
      } else {
        // ── Bump-circle island ────────────────────────────────────────────────
        // Sandy beach
        this.traceIslandBlob(camera, islandX, islandY, preset.beachRadius, preset.beachBumps);
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
        this.traceIslandBlob(camera, islandX, islandY, preset.grassRadius, preset.grassBumps);
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
        isHovered: boolean; inRange: boolean; playerNear: boolean; leafAlpha: number; bushAlpha: number; boulderAlpha: number; deathAlpha: number;
      }> = [];

      const candidateIndices = this.queryResourceIndices(
        isl,
        worldBounds.min.x - RESOURCE_WORLD_PAD - off.dx,
        worldBounds.min.y - RESOURCE_WORLD_PAD - off.dy,
        worldBounds.max.x + RESOURCE_WORLD_PAD - off.dx,
        worldBounds.max.y + RESOURCE_WORLD_PAD - off.dy,
      );
      const hoverCandidateSet = (mwp && msp)
        ? new Set<number>(
            this.queryResourceIndices(
              isl,
              mwp.x - HOVER_QUERY_WORLD_R - off.dx,
              mwp.y - HOVER_QUERY_WORLD_R - off.dy,
              mwp.x + HOVER_QUERY_WORLD_R - off.dx,
              mwp.y + HOVER_QUERY_WORLD_R - off.dy,
            ),
          )
        : null;

      for (const ri of candidateIndices) {
        const res = isl.resources[ri];
        // Depleted resources fade out over DEATH_FADE_MS, then disappear entirely.
        // During the fade they cannot be hovered or interacted with.
        let deathAlpha = 1.0;
        if (res.maxHp > 0 && res.hp <= 0) {
          if (!res.depletedAt) continue; // no timestamp yet — skip (shouldn't happen)
          const elapsed = now - res.depletedAt;
          if (elapsed >= DEATH_FADE_MS) continue; // fully faded, skip
          deathAlpha = 1.0 - elapsed / DEATH_FADE_MS; // 1 → 0 over DEATH_FADE_MS
          const wx2 = islandX + res.ox, wy2 = islandY + res.oy;
          if (wx2 < worldBounds.min.x - RESOURCE_WORLD_PAD || wx2 > worldBounds.max.x + RESOURCE_WORLD_PAD ||
              wy2 < worldBounds.min.y - RESOURCE_WORLD_PAD || wy2 > worldBounds.max.y + RESOURCE_WORLD_PAD) continue;
          const sp2 = camera.worldToScreen(Vec2.from(wx2, wy2));
          const maxR2 = 100 * zoom;
          if (sp2.x + maxR2 < 0 || sp2.x - maxR2 > cw || sp2.y + maxR2 < 0 || sp2.y - maxR2 > ch) continue;
          // Fog cull — use canonical coords (strip wrap offset) for player-relative distance.
          if (!this.fogVisibleAt(wx2 - off.dx, wy2 - off.dy, 80)) continue;
          // No hover, no interaction while dying
          visibleRes.push({ res, wx: wx2, wy: wy2, sp: sp2, isHovered: false, inRange: false, playerNear: false, leafAlpha: 1.0, bushAlpha: 1.0, boulderAlpha: 1.0, deathAlpha });
          continue;
        }
        const wx = islandX + res.ox;
        const wy = islandY + res.oy;
        if (wx < worldBounds.min.x - RESOURCE_WORLD_PAD || wx > worldBounds.max.x + RESOURCE_WORLD_PAD ||
            wy < worldBounds.min.y - RESOURCE_WORLD_PAD || wy > worldBounds.max.y + RESOURCE_WORLD_PAD) continue;
        const sp = camera.worldToScreen(Vec2.from(wx, wy));
        const maxR = 100 * zoom;
        if (sp.x + maxR < 0 || sp.x - maxR > cw || sp.y + maxR < 0 || sp.y - maxR > ch) continue;
        if (maxR < 1) continue;
        // Use canonical (non-wrap-offset) world coords for fog check and player distance.
        const wxCanon = wx - off.dx;
        const wyCanon = wy - off.dy;
        // Fog cull — 80-unit clearance so the edge of a tree/bush is never clipped early.
        if (!this.fogVisibleAt(wxCanon, wyCanon, 80)) continue;

        let isHovered = false;
        let inRange   = false;
        let playerNear = false;
        // wxCanon/wyCanon already computed above.
        const pdx = localPlayer ? localPlayer.position.x - wxCanon : 0;
        const pdy = localPlayer ? localPlayer.position.y - wyCanon : 0;
        const pdSq = localPlayer ? (pdx * pdx + pdy * pdy) : Infinity;
        const playerDist = localPlayer ? Math.sqrt(pdSq) : Infinity;
        const mayHover = !!(hoverCandidateSet && hoverCandidateSet.has(ri));

        if (res.type === 'wood') {
          const treeHoverR = 18 * (res.size ?? 1.0) * zoom;
          if (msp && mayHover) { const hdx = msp.x - sp.x, hdy = msp.y - sp.y; isHovered = hdx*hdx + hdy*hdy <= treeHoverR * treeHoverR; }
          const effR = HARVEST_RANGE * Math.max(1.0, res.size ?? 1.0);
          inRange    = !!(axeEquipped && localPlayer && pdSq <= effR * effR);
          playerNear = !!(localPlayer && playerDist < LEAF_FADE_OUTER);
          if (isHovered) this._hoveredTree = { wx: wxCanon, wy: wyCanon, size: res.size ?? 1.0 };
        } else if (res.type === 'fiber') {
          if (msp && mayHover) { const hdx = msp.x - sp.x, hdy = msp.y - sp.y; isHovered = hdx*hdx + hdy*hdy <= PLANT_HOVER_SQ; }
          const effR = HARVEST_RANGE * Math.max(1.0, res.size ?? 1.0);
          inRange = !!(localPlayer && localPlayer.carrierId === 0 && pdSq <= effR * effR);
          if (isHovered) this._hoveredFiberPlant = { wx: wxCanon, wy: wyCanon, size: res.size ?? 1.0 };
        } else if (res.type === 'rock') {
          if (msp && mayHover) { const hdx = msp.x - sp.x, hdy = msp.y - sp.y; isHovered = hdx*hdx + hdy*hdy <= ROCK_HOVER_SQ * (res.size ?? 1.0); }
          const effR = HARVEST_RANGE * Math.max(1.0, res.size ?? 1.0);
          inRange = !!(localPlayer && localPlayer.carrierId === 0 && pdSq <= effR * effR);
          if (isHovered) this._hoveredRock = { wx: wxCanon, wy: wyCanon, size: res.size ?? 1.0 };
        } else if (res.type === 'boulder') {
          const bHoverR = 44 * (res.size ?? 1.0) * zoom;
          if (msp && mayHover) { const hdx = msp.x - sp.x, hdy = msp.y - sp.y; isHovered = hdx*hdx + hdy*hdy <= bHoverR * bHoverR; }
          const effR = BOULDER_HARVEST_RANGE * Math.max(1.0, res.size ?? 1.0);
          inRange = !!(pickaxeEquipped && localPlayer && localPlayer.carrierId === 0 && pdSq <= effR * effR);
          if (isHovered) this._hoveredBoulder = { wx: wxCanon, wy: wyCanon, size: res.size ?? 1.0 };
        }
        // Smooth leaf-fade alpha: 1.0 (far) → MIN_LEAF_ALPHA (inside LEAF_FADE_INNER)
        const leafAlpha = res.type === 'wood' && localPlayer
          ? (() => {
              const t = Math.max(0, Math.min(1, (playerDist - LEAF_FADE_INNER) / (LEAF_FADE_OUTER - LEAF_FADE_INNER)));
              return MIN_LEAF_ALPHA + t * (1.0 - MIN_LEAF_ALPHA);
            })()
          : 1.0;
        // Bush fade alpha: fades out when player is close (same pattern as leaf fade)
        const bushAlpha = res.type === 'fiber' && localPlayer
          ? (() => {
              const t = Math.max(0, Math.min(1, (playerDist - BUSH_FADE_INNER) / (BUSH_FADE_OUTER - BUSH_FADE_INNER)));
              return MIN_BUSH_ALPHA + t * (1.0 - MIN_BUSH_ALPHA);
            })()
          : 1.0;
        const boulderAlpha = 1.0;
        visibleRes.push({ res, wx, wy, sp, isHovered, inRange, playerNear, leafAlpha, bushAlpha, boulderAlpha, deathAlpha });
      }

      // Pass 1 – rocks (below structures)
      for (const e of visibleRes) {
        if (e.res.type !== 'rock') continue;
        this.drawIslandRock(e.sp.x, e.sp.y, zoom, camRot, e.isHovered, e.deathAlpha, e.res.ox, e.res.oy, e.wx, e.wy);
      }
      // Pass 2 – boulders (above rocks, below players)
      for (const e of visibleRes) {
        if (e.res.type !== 'boulder') continue;
        this.drawIslandBoulder(e.sp.x, e.sp.y, zoom, camRot, e.isHovered, e.boulderAlpha * e.deathAlpha, e.res.ox, e.res.oy, e.res.size ?? 1.0, e.wx, e.wy, e.res.metal === true);
      }
      // Pass 3 – tree trunks (only visible when player is near or hovering)
      for (const e of visibleRes) {
        if (e.res.type !== 'wood') continue;
        if (!e.playerNear && !e.isHovered) continue;
        // Trunk fades IN as leaves fade OUT — inverse of leafAlpha
        const trunkAlpha = (1.0 - e.leafAlpha) * e.deathAlpha;
        if (trunkAlpha < 0.01) continue;
        this.drawIslandTreeTrunk(e.sp.x, e.sp.y, zoom, e.isHovered, e.inRange, e.playerNear, e.res.size ?? 1.0, trunkAlpha, e.wx, e.wy);
      }
      // Fiber bushes deferred to _pendingBushes — drawn above players after render queue
      for (const e of visibleRes) {
        if (e.res.type !== 'fiber') continue;
        this._pendingBushes.push({ sp: e.sp, isHovered: e.isHovered, bushAlpha: e.bushAlpha, deathAlpha: e.deathAlpha, ox: e.res.ox, oy: e.res.oy, wx: e.wx, wy: e.wy });
      }
      this._pendingAllRes.push(...visibleRes);
      }
    }

    // ── Structures: above trunks, below leaves ────────────────────────────────
    this.drawPlacedStructures(camera);
    // ── Tombstones (above boulders, below players) — dropped items use deck-aware render queue ──
    this.drawTombstones(this.ctx, camera.getState());
    // Tree leaves and prompts are drawn in renderWorld after bushes (player → bushes → leaves)
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
    ctx.font = `bold ${fontSize}px Georgia, serif`;
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

  private drawIslandTreeLeaves(sx: number, sy: number, zoom: number, camRot = 0, hovered = false, inRange = false, leafAlpha = 1.0, seedX = 0, seedY = 0, size = 1.0, deathAlpha = 1.0, wx?: number, wy?: number): void {
    const ctx = this.ctx;
    const h  = (Math.imul(seedX | 0, 2654435761) ^ Math.imul(seedY | 0, 1664525)) >>> 0;
    const h2 = (Math.imul(h, 2246822519) ^ Math.imul(h >>> 13, 2654435761)) >>> 0;
    const clusterRot = (((h2 & 0xFF) / 255) - 0.5) * (Math.PI / 3.6);
    const tintIdx    = (h >>> 16) & 3;
    const canopy     = 72 * zoom * size;

    // Map rotation to nearest pre-baked bin
    const ROT_RANGE = Math.PI / 3.6;
    const BINS      = RenderSystem.TREE_ROT_BINS;
    const rotBin    = Math.max(0, Math.min(BINS - 1,
      Math.round(((clusterRot + ROT_RANGE) / (2 * ROT_RANGE)) * (BINS - 1))));

    const sprite       = RenderSystem._ensureTreeSprites().get(`${tintIdx}_${rotBin}`)!;
    const spriteCanopy = RenderSystem.TREE_SPRITE_SIZE * 0.38;
    const drawSize     = RenderSystem.TREE_SPRITE_SIZE * (canopy / spriteCanopy);

    ctx.save();
    // Hover glow (drawn before rotation so the circle stays upright)
    if (hovered) {
      const glowColor = inRange ? 'rgba(255,230,80,0.22)' : 'rgba(180,180,180,0.15)';
      ctx.beginPath();
      ctx.arc(sx, sy, inRange ? canopy * 1.25 : canopy * 1.15, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.fill();
    }
    // Rotate the pre-baked sprite around the tree centre to match world-space orientation
    ctx.translate(sx, sy);
    ctx.rotate(-camRot);
    ctx.globalAlpha = leafAlpha * deathAlpha;
    ctx.drawImage(sprite, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.globalAlpha = deathAlpha;
    if (hovered) {
      ctx.beginPath();
      ctx.arc(0, 0, canopy * 1.08, 0, Math.PI * 2);
      ctx.strokeStyle = inRange ? '#f0c040' : '#888888';
      ctx.lineWidth   = 1.8 * zoom;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawIslandTreeTrunk(sx: number, sy: number, zoom: number, hovered = false, inRange = false, playerNear = false, size = 1.0, alpha = 1.0, wx?: number, wy?: number): void {
    const ctx      = this.ctx;
    const trunk    = 18 * zoom * size;
    const spriteR  = RenderSystem.TRUNK_SPRITE_R;
    const SIZE     = RenderSystem.TRUNK_SPRITE_SIZE;
    const drawSize = SIZE * (trunk / spriteR);
    const key      = hovered ? (inRange ? 'inrange' : 'hovered') : 'normal';
    const sprite   = RenderSystem._ensureTrunkSprites().get(key)!;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, sx - drawSize / 2, sy - drawSize / 2, drawSize, drawSize);
    ctx.restore();
  }

  private drawIslandFiberPlant(sx: number, sy: number, zoom: number, camRot = 0, hovered = false, deathAlpha = 1.0, ox = 0, oy = 0, wx?: number, wy?: number): void {
    const ctx      = this.ctx;
    const h        = 60 * zoom;
    const spriteH  = RenderSystem.FIBER_SPRITE_H;
    const SIZE     = RenderSystem.FIBER_SPRITE_SIZE;
    const drawSize = SIZE * (h / spriteH);
    const hash     = Math.abs((ox * 73856093) ^ (oy * 19349663)) | 0;
    const ti       = hash % RenderSystem.FIBER_TINTS.length;
    const bin      = (hash >> 4) % RenderSystem.FIBER_ROT_BINS;
    const key      = `${ti}_${bin}_${hovered ? 'h' : 'n'}`;
    const sprite   = RenderSystem._ensureFiberSprites().get(key)!;
    const rot      = ((hash >> 8) % 360) * Math.PI / 180;
    ctx.save();
    ctx.globalAlpha = deathAlpha;
    ctx.translate(sx, sy);
    ctx.rotate(rot - camRot);
    ctx.drawImage(sprite, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
  }

  private drawIslandRock(sx: number, sy: number, zoom: number, camRot = 0, hovered = false, deathAlpha = 1.0, ox = 0, oy = 0, wx?: number, wy?: number): void {
    const ctx  = this.ctx;
    const R    = RenderSystem.ROCK_SPRITE_R;
    const SIZE = RenderSystem.ROCK_SPRITE_SIZE;
    const r    = 6 * zoom;
    const drawSize = SIZE * (r / R);
    const hash = Math.abs((ox * 73856093) ^ (oy * 19349663)) | 0;
    const ti   = hash % RenderSystem.ROCK_TONES.length;
    const si   = (hash >> 4) % RenderSystem.ROCK_SHAPES.length;
    const drawRot = ((hash >> 8) % 360) * Math.PI / 180;
    const key  = `${ti}_${si}_${hovered ? 'h' : 'n'}`;
    const sprite = RenderSystem._ensureRockSprites().get(key)!;
    ctx.save();
    ctx.globalAlpha = deathAlpha;
    ctx.translate(sx, sy);
    ctx.rotate(drawRot - camRot);
    ctx.drawImage(sprite, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
    ctx.restore();
  }

  private drawIslandBoulder(sx: number, sy: number, zoom: number, camRot = 0, hovered = false, alpha = 1.0, ox = 0, oy = 0, size = 1.0, wx?: number, wy?: number, metal = false): void {
    const ctx      = this.ctx;
    const R        = RenderSystem.BOULDER_SPRITE_R;
    const SIZE     = RenderSystem.BOULDER_SPRITE_SIZE;
    // Radius matches server BOULDER_BASE_R = 38 so the visual boundary aligns
    // with the server-side ellipse collision pushout.
    const r        = 38 * zoom * size;
    const drawSize = SIZE * (r / R);
    // Math.trunc matches server (int) cast; >>> 0 gives unsigned uint32 — both must match server bseed formula
    const hash     = ((Math.trunc(ox) * 73856093) ^ (Math.trunc(oy) * 19349663)) >>> 0;
    const toneCount = 3; // 3 variants within stone or metal range
    const tiBase   = metal ? RenderSystem.BOULDER_METAL_TONE_OFFSET : 0;
    const ti       = tiBase + (hash % toneCount);
    const si       = (hash >>> 4) % RenderSystem.BOULDER_SHAPES.length;
    const drawRot  = ((hash >>> 8) & 0xFF) / 256 * Math.PI * 2;
    const key      = `${ti}_${si}_${hovered ? 'h' : 'n'}`;
    const sprite   = RenderSystem._ensureBoulderSprites().get(key)!;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(sx, sy);
    ctx.rotate(drawRot - camRot);
    ctx.drawImage(sprite, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
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
    ctx.font = `bold ${fontSize}px Georgia, serif`;
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
    const { zoom, rotation: camRot } = camera.getState();

    // ── Update hovered structure ──────────────────────────────────────────────

        // Strict segment-segment intersection (cross-product sign method).
        // Returns false for collinear / touching endpoints — we don't need those cases.
        const cross2d = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number) =>
          (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
        const segsCross = (ax: number, ay: number, bx: number, by: number,
                           cx: number, cy: number, dx: number, dy: number): boolean => {
          const d1 = cross2d(cx, cy, dx, dy, ax, ay);
          const d2 = cross2d(cx, cy, dx, dy, bx, by);
          const d3 = cross2d(ax, ay, bx, by, cx, cy);
          const d4 = cross2d(ax, ay, bx, by, dx, dy);
          return (d1 * d2 < 0) && (d3 * d4 < 0);
        };

        const rayBlocked = (ax: number, ay: number, bx: number, by: number): boolean => {
          const n = this._wallSegs.length;
          for (let i = 0; i < n; i += 4) {
            if (segsCross(ax, ay, bx, by, this._wallSegs[i], this._wallSegs[i+1], this._wallSegs[i+2], this._wallSegs[i+3])) return true;
          }
          return false;
        };

        // ── Seed: ceiling tiles the player can reach without crossing a wall ──
        // No floor tile required — also works outside, on bare ground, through
        // open doorways (door_frame without a door panel).
    // ── Update hovered structure ──────────────────────────────────────────────
    // Highlight whichever structure the mouse cursor is over (AABB for floor,
    // landscape rect for workbench).  Interaction hints additionally require
    // the player to be off-ship and within range.
    const player = this._cachedLocalPlayer;
    const INTERACT_R = 50; // world px — one full floor-tile; must match getHoveredStructure range and server STRUCT_INTERACT_R
    this._hoveredStructure = null;
    if (this.mouseWorldPos && !this.islandBuildKind) {
      const mx = this.mouseWorldPos.x;
      const my = this.mouseWorldPos.y;
      const half = 25; // half of 50px tile
      let wallHit:  PlacedStructure | null = null; // wall / door_frame / door
      let floorHit: PlacedStructure | null = null; // wooden_floor / wood_ceiling
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
            wallHit = s; // walls/door frames/panels beat floors/ceilings
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
        const hw = s.type === 'workbench' ? 25 * 0.88 : s.type === 'chest' ? 25 * 0.72 : s.type === 'bed' ? 25 * 0.88 : s.type === 'shipyard' ? SHIPYARD_HW : half;
        const hh = s.type === 'workbench' ? 25 * 0.62 : s.type === 'chest' ? 25 * 0.52 : s.type === 'bed' ? 25 * 0.48 : s.type === 'shipyard' ? SHIPYARD_HH : half;
        if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) {
          if (s.type === 'shipyard') {
            // For empty shipyard: only highlight the physical U-shaped dock arms,
            // not the hollow interior water area. ARM_T = 50 world units (sz=50).
            const SY_ARM_T = 50;
            const isInHollow = s.construction?.phase !== 'building'
              && Math.abs(lx) <= hw - SY_ARM_T
              && ly > -hh + SY_ARM_T;
            if (!isInHollow) {
              this._hoveredStructure = s;
              wallHit = null;
              floorHit = null;
              break;
            }
          } else if (s.type === 'workbench' || s.type === 'bed') {
            // Workbench/bed always wins — stop searching
            this._hoveredStructure = s;
            wallHit = null;
            floorHit = null;
            break;
          } else {
            // Floor/ceiling match — keep looking in case a wall or workbench overlaps
            floorHit = s;
          }
        }
      }
      // Priority: workbench/shipyard (set directly) > wall/door_frame/door > floor/ceiling
      if (this._hoveredStructure === null) this._hoveredStructure = wallHit ?? floorHit;
    }

    // Pre-compute the player's visibility polygon. This polygon (in world space)
    // bounds the area the player has line-of-sight to. Each ceiling tile is rendered
    // fully opaque, then the lit area (vis poly) is punched to a lower alpha — producing
    // a clean shadow edge along the true LOS line.
    const MIN_CEIL_ALPHA = 0.25;
    const ceilingAlpha = new Map<number, number>(); // tile-average alpha — used for hover blocking
    let visPolyValid = false;
    if (player && this._wallSegs.length > 0) {
      const ppx = player.position.x, ppy = player.position.y;
      // Rebuild vis poly each frame the player moves > 1 unit OR walls change.
      const moved = Math.abs(ppx - this._visPolyPx) > 1 || Math.abs(ppy - this._visPolyPy) > 1;
      const wallsChanged = this._visPolyWallRev !== this._visPolyLastRev;
      if (wallsChanged) this._visPolyLastRev = this._visPolyWallRev;
      if (moved || wallsChanged || this._visPolyPts.length === 0) this._buildVisibilityPoly(ppx, ppy);
      visPolyValid = this._visPolyPts.length >= 6;

      // Approximate per-tile alpha for hover-blocking by sampling 5 points (center + corners).
      const wseg = this._wallSegs;
      const losBlocked = (tx: number, ty: number): boolean => {
        const d1x = tx - ppx, d1y = ty - ppy;
        for (let i = 0; i < wseg.length; i += 4) {
          const d2x = wseg[i+2] - wseg[i], d2y = wseg[i+3] - wseg[i+1];
          const denom = d1x * d2y - d1y * d2x;
          if (Math.abs(denom) < 1e-9) continue;
          const sx = ppx - wseg[i], sy = ppy - wseg[i+1];
          const t = (d2x * sy - d2y * sx) / denom;
          const u = (d1x * sy - d1y * sx) / denom;
          if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) return true;
        }
        return false;
      };
      const SAMPLE_INSET = 22;
      for (const s of this.placedStructures) {
        if (s.type !== 'wood_ceiling') continue;
        const cRot = (s.rotation ?? 0) * Math.PI / 180;
        const cosC = Math.cos(cRot), sinC = Math.sin(cRot);
        const samples: [number, number][] = [
          [s.x, s.y],
          [s.x + (-SAMPLE_INSET) * cosC - (-SAMPLE_INSET) * sinC, s.y + (-SAMPLE_INSET) * sinC + (-SAMPLE_INSET) * cosC],
          [s.x + ( SAMPLE_INSET) * cosC - (-SAMPLE_INSET) * sinC, s.y + ( SAMPLE_INSET) * sinC + (-SAMPLE_INSET) * cosC],
          [s.x + ( SAMPLE_INSET) * cosC - ( SAMPLE_INSET) * sinC, s.y + ( SAMPLE_INSET) * sinC + ( SAMPLE_INSET) * cosC],
          [s.x + (-SAMPLE_INSET) * cosC - ( SAMPLE_INSET) * sinC, s.y + (-SAMPLE_INSET) * sinC + ( SAMPLE_INSET) * cosC],
        ];
        let unblocked = 0;
        for (const [sx, sy] of samples) if (!losBlocked(sx, sy)) unblocked++;
        const visFrac = unblocked / samples.length;
        ceilingAlpha.set(s.id, 1 - visFrac * (1 - MIN_CEIL_ALPHA));
      }
    }
    const visPolyPts = this._visPolyPts;

    // Override hover: a ceiling tile blocks interaction with what's beneath it only if
    // it's mostly opaque. Mostly-transparent ceilings (player has good LOS) don't occlude.
    if (this.mouseWorldPos && !this.islandBuildKind) {
      const mx = this.mouseWorldPos.x, my = this.mouseWorldPos.y;
      const half = 25;
      const HOVER_BLOCK_ALPHA = 0.7; // ceilings denser than this block clicks/hover
      for (const s of this.placedStructures) {
        if (s.type !== 'wood_ceiling') continue;
        const a = ceilingAlpha.get(s.id) ?? 1;
        if (a < HOVER_BLOCK_ALPHA) continue; // see-through enough — doesn't block
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
        if (Math.abs(lx) <= half && Math.abs(ly) <= half) {
          this._hoveredStructure = s; // opaque ceiling wins over anything beneath it
          break;
        }
      }
    }

    // Floors first, then walls/doors, then workbenches/cannons/shipyards
    const sorted = [...this.placedStructures].sort((a, b) => {
      const order = (t: PlacedStructure['type']) =>
        t === 'wooden_floor' ? 0 : (t === 'wall' || t === 'door_frame') ? 1 : t === 'door' ? 1.5 : t === 'cannon' ? 1.6 : t === 'shipyard' ? 1.8 : 2;
      return order(a.type) - order(b.type);
    });

    // Expand sorted with world-wrap shadow copies so structures (including wrecks)
    // that cross the wrap boundary are rendered correctly when the world parallaxes.
    // getWrapRenderOffsets always includes {dx:0,dy:0} so canonical entries are kept.
    const sortedWrapped: PlacedStructure[] = [];
    for (const s of sorted) {
      const offsets = this.getWrapRenderOffsets(Vec2.from(s.x, s.y), camera, 200);
      for (const off of offsets) {
        sortedWrapped.push(off.dx === 0 && off.dy === 0 ? s : { ...s, x: s.x + off.dx, y: s.y + off.dy });
      }
    }

    // TILE = 50 CLIENT units (= 5 server units after ×WORLD_SCALE_FACTOR=10).
    // Half-extents in CLIENT units: shipyard SHIPYARD_HH, flag_fort ~70, fortress ~90.
    const STRUCT_TILE = 50;
    for (const s of sortedWrapped) {
      // World-space bounding radius for each structure type.
      // isWorldPositionVisible margin is in CLIENT units — same space as s.x / s.y.
      const _halfExt = s.type === 'shipyard'         ? SHIPYARD_HH
                     : s.type === 'flag_fort'        ? STRUCT_TILE * 1.4        //  70
                     : s.type === 'company_fortress' ? STRUCT_TILE * 1.8        //  90
                     : STRUCT_TILE * 1.1;                                        //  55
      // Screen-space culling — skip structures completely outside the visible area
      if (!camera.isWorldPositionVisible(Vec2.from(s.x, s.y), _halfExt)) continue;
      // Fog culling — use same half-extent so partial visibility of a large structure
      // (e.g. one dock arm in view while the center is in fog) still triggers rendering.
      if (!this.fogVisibleAt(s.x, s.y, _halfExt)) continue;
      const ssp = camera.worldToScreen(Vec2.from(s.x, s.y));
      const sz  = Math.max(4, 50 * zoom);
      const isHovered  = this._hoveredStructure?.id === s.id;
      const isBlocker  = this._blockerStructureId === s.id && performance.now() < this._blockerExpiry;

      if (s.type === 'wooden_floor') {
        const floorTargetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
        const floorIsSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);
        // Schematic overlay + progress bar when hammer equipped
        if (this.hammerEquipped && floorIsSchematic) {
          ctx.save();
          const floorRotRad = (s.rotation ?? 0) * Math.PI / 180;
          if (floorRotRad !== 0 || camRot !== 0) {
            ctx.translate(ssp.x, ssp.y);
            ctx.rotate(floorRotRad - camRot);
            ctx.translate(-ssp.x, -ssp.y);
          }
          ctx.fillStyle = 'rgba(120,200,255,0.22)';
          ctx.fillRect(ssp.x - sz / 2, ssp.y - sz / 2, sz, sz);
          const flBuildFrac = Math.max(0, Math.min(1, floorTargetHp > 0 ? s.hp / floorTargetHp : 0));
          const flBarW = sz * 0.7; const flBarH = Math.max(2, 4 * zoom);
          const flBarX = ssp.x - flBarW / 2; const flBarY = ssp.y - sz / 2 - flBarH - 2;
          ctx.strokeStyle = '#b0e0ff'; ctx.lineWidth = 1;
          ctx.strokeRect(flBarX, flBarY, flBarW, flBarH);
          ctx.fillStyle = '#55ddff'; ctx.fillRect(flBarX, flBarY, flBarW * flBuildFrac, flBarH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', ssp.x, flBarY - 2);
          ctx.restore();
        }
        // Repair icon when hammer equipped and floor is actually damaged (not schematic)
        if (this.hammerEquipped && !floorIsSchematic && hpFrac < 0.999) {
          ctx.font = `${Math.max(8, Math.round(11 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
          ctx.fillText('\u2692', ssp.x, ssp.y);
        }
      } else if (s.type === 'workbench') {
        const bw = sz * 0.88;
        const bh = sz * 0.62;
        const bx = ssp.x - bw / 2;
        const by = ssp.y - bh / 2;
        const wbTargetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
        const wbIsSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
        const wbHpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const wbDmgDarken = Math.max(0, 1 - wbHpFrac) * 0.75;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);
        if (this.hammerEquipped && wbIsSchematic) {
          ctx.save();
          const wbRotRad = (s.rotation ?? 0) * Math.PI / 180;
          if (wbRotRad !== 0 || camRot !== 0) {
            ctx.translate(ssp.x, ssp.y);
            ctx.rotate(wbRotRad - camRot);
            ctx.translate(-ssp.x, -ssp.y);
          }
          ctx.fillStyle = 'rgba(120,200,255,0.22)';
          ctx.fillRect(bx, by, bw, bh);
          const wbBuildFrac = Math.max(0, Math.min(1, wbTargetHp > 0 ? s.hp / wbTargetHp : 0));
          const wbBarW = bw * 0.7; const wbBarH = Math.max(2, 4 * zoom);
          const wbBarX = ssp.x - wbBarW / 2; const wbBarY = by - wbBarH - 2;
          ctx.strokeStyle = '#b0e0ff'; ctx.lineWidth = 1;
          ctx.strokeRect(wbBarX, wbBarY, wbBarW, wbBarH);
          ctx.fillStyle = '#55ddff'; ctx.fillRect(wbBarX, wbBarY, wbBarW * wbBuildFrac, wbBarH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', ssp.x, wbBarY - 2);
          ctx.restore();
        }
        if (this.hammerEquipped && !wbIsSchematic && wbDmgDarken > 0.01) {
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
          ctx.fillText('\u2692', ssp.x, ssp.y);
        }
      } else if (s.type === 'wall') {
        const nearWallFloor = this.placedStructures.find(f =>
          f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30
        );
        const wallRotRad = nearWallFloor
          ? Math.atan2(s.y - nearWallFloor.y, s.x - nearWallFloor.x) + Math.PI / 2
          : 0;
        const THICK = 0.18;
        const ww = sz;
        const wh = sz * THICK;
        const targetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
        const isSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const dmgDarken = Math.max(0, 1 - hpFrac) * 0.75;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker, wallRotRad);
        if (this.hammerEquipped && isSchematic) {
          ctx.save();
          ctx.translate(ssp.x, ssp.y);
          ctx.rotate(wallRotRad - camRot);
          ctx.translate(-ssp.x, -ssp.y);
          ctx.fillStyle = 'rgba(120,200,255,0.22)';
          ctx.fillRect(ssp.x - ww / 2, ssp.y - wh / 2, ww, wh);
          const barW = ww * 0.7;
          const barH = Math.max(2, 4 * zoom);
          const barX = ssp.x - barW / 2;
          const barY = ssp.y - wh / 2 - barH - 2;
          const buildFrac = Math.max(0, Math.min(1, s.hp / targetHp));
          ctx.strokeStyle = '#b0e0ff';
          ctx.lineWidth = 1;
          ctx.strokeRect(barX, barY, barW, barH);
          ctx.fillStyle = '#55ddff';
          ctx.fillRect(barX, barY, barW * buildFrac, barH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', ssp.x, barY - 2);
          ctx.restore();
        }
        if (this.hammerEquipped && !isSchematic && dmgDarken > 0.01) {
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
          ctx.fillText('\u2692', ssp.x, ssp.y);
        }
      } else if (s.type === 'door_frame') {
        const nearDFFloor = this.placedStructures.find(f =>
          f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30
        );
        const dfRotRad = nearDFFloor
          ? Math.atan2(s.y - nearDFFloor.y, s.x - nearDFFloor.x) + Math.PI / 2
          : 0;
        const ww = sz;
        const POST = sz * 0.14;
        const dfTargetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
        const dfIsSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const dmgDarken = Math.max(0, 1 - hpFrac) * 0.75;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker, dfRotRad);
        if (this.hammerEquipped && dfIsSchematic) {
          ctx.save();
          ctx.translate(ssp.x, ssp.y);
          ctx.rotate(dfRotRad - camRot);
          ctx.translate(-ssp.x, -ssp.y);
          ctx.fillStyle = 'rgba(120,200,255,0.22)';
          ctx.fillRect(ssp.x - ww / 2, ssp.y - POST / 2, ww, POST);
          const dfBuildFrac = Math.max(0, Math.min(1, dfTargetHp > 0 ? s.hp / dfTargetHp : 0));
          const dfBarW = ww * 0.7; const dfBarH = Math.max(2, 4 * zoom);
          const dfBarX = ssp.x - dfBarW / 2; const dfBarY = ssp.y - POST / 2 - dfBarH - 2;
          ctx.strokeStyle = '#b0e0ff'; ctx.lineWidth = 1;
          ctx.strokeRect(dfBarX, dfBarY, dfBarW, dfBarH);
          ctx.fillStyle = '#55ddff'; ctx.fillRect(dfBarX, dfBarY, dfBarW * dfBuildFrac, dfBarH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', ssp.x, dfBarY - 2);
          ctx.restore();
        }
        if (this.hammerEquipped && !dfIsSchematic && dmgDarken > 0.01) {
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
          ctx.fillText('\u2692', ssp.x, ssp.y);
        }
      } else if (s.type === 'door') {
        const nearDoorFloor = this.placedStructures.find(f =>
          f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30
        );
        const doorRotRad = nearDoorFloor
          ? Math.atan2(s.y - nearDoorFloor.y, s.x - nearDoorFloor.x) + Math.PI / 2
          : 0;
        const THICK = 0.18;
        const ww = sz;
        const wh = sz * THICK;
        const doorTargetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
        const doorIsSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const dmgDarken = Math.max(0, 1 - hpFrac) * 0.75;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker, doorRotRad);
        if (this.hammerEquipped && doorIsSchematic) {
          ctx.save();
          ctx.translate(ssp.x, ssp.y);
          ctx.rotate(doorRotRad - camRot);
          ctx.translate(-ssp.x, -ssp.y);
          ctx.fillStyle = 'rgba(120,200,255,0.22)';
          ctx.fillRect(ssp.x - ww / 2, ssp.y - wh / 2, ww, wh);
          const doorBuildFrac = Math.max(0, Math.min(1, doorTargetHp > 0 ? s.hp / doorTargetHp : 0));
          const doorBarW = ww * 0.7; const doorBarH = Math.max(2, 4 * zoom);
          const doorBarX = ssp.x - doorBarW / 2; const doorBarY = ssp.y - wh / 2 - doorBarH - 2;
          ctx.strokeStyle = '#b0e0ff'; ctx.lineWidth = 1;
          ctx.strokeRect(doorBarX, doorBarY, doorBarW, doorBarH);
          ctx.fillStyle = '#55ddff'; ctx.fillRect(doorBarX, doorBarY, doorBarW * doorBuildFrac, doorBarH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', ssp.x, doorBarY - 2);
          ctx.restore();
        }
        if (this.hammerEquipped && !doorIsSchematic && dmgDarken > 0.01) {
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
          ctx.fillText('\u2692', ssp.x, ssp.y);
        }
      } else if (s.type === 'shipyard') {
        const ARM_T  = sz * (SHIPYARD_ARM_T / SHIPYARD_TILE);
        const INT_W  = sz * (SHIPYARD_INT_W / SHIPYARD_TILE);
        const ARM_L  = sz * (SHIPYARD_ARM_L / SHIPYARD_TILE);
        const BACK_T = sz * (SHIPYARD_BACK_T / SHIPYARD_TILE);
        const totalW = ARM_T + INT_W + ARM_T;
        const totalH = BACK_T + ARM_L;
        const hw = totalW / 2, hh = totalH / 2;
        const cx = ssp.x, cy = ssp.y;
        const shipyardRot = (s.rotation ?? 0) * Math.PI / 180;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);
        // Pulsing stair markers (animated — not baked into sprite)
        if (s.construction?.phase === 'building') {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(shipyardRot - camRot);
          ctx.translate(-cx, -cy);
          const bayY1 = cy + hh;
          const stairPulse = 0.5 + 0.3 * Math.sin(performance.now() * 0.002);
          ctx.fillStyle = `rgba(220, 200, 100, ${stairPulse.toFixed(2)})`;
          ctx.font = `bold ${Math.max(8, Math.round(10 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('▲', cx - hw + ARM_T * 0.5, bayY1 - ARM_T * 0.5);
          ctx.fillText('▲', cx + hw - ARM_T * 0.5, bayY1 - ARM_T * 0.5);
          ctx.restore();
        }
      } else if (s.type === 'wreck') {
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);
        const wrsz = Math.max(6, 60 * zoom);
        if (isHovered) {
          ctx.save();
          ctx.font = `bold ${Math.max(10, 12 * zoom)}px Georgia, serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillText(`⚓ Wreck (${s.hp} loot)`, ssp.x + 1, ssp.y - wrsz * 0.7 + 1);
          ctx.fillStyle = '#ffd050';
          ctx.fillText(`⚓ Wreck (${s.hp} loot)`, ssp.x, ssp.y - wrsz * 0.7);
          ctx.restore();
        }
      } else if (s.type === 'wood_ceiling') {
        // Defer ceiling rendering to drawPendingCeilings(), invoked after bushes
        // in renderWorld so roofs cover bush sprites placed under the building.
        this._pendingCeilings.push({ s, ssp, sz, isHovered });
      } else if (s.type === 'cannon') {
        const rotRad = (s.rotation ?? 0) * Math.PI / 180;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const hasLiveAim = this.islandCannonId === s.id && this.islandCannonAimAngle !== null;
        const hasServerAim = typeof s.cannonAimAngle === 'number';
        const barrelRot  = hasLiveAim
          ? (this.islandCannonAimAngle! + Math.PI / 2)
          : hasServerAim
            ? (s.cannonAimAngle! + Math.PI / 2)
            : rotRad;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);
        const barrelSprite = getCannonBarrelSprite(this._structureSpriteCache, {
          hovered: isHovered,
          companyId: s.companyId,
          hpFrac,
        });
        blitStructureSprite(this.ctx, barrelSprite, ssp.x, ssp.y, zoom, barrelRot, camRot);
      } else if (s.type === 'flag_fort') {
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const ts = Math.max(10, 44 * zoom);
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);

        ctx.save();
        ctx.translate(ssp.x, ssp.y);
        ctx.rotate(-camRot);

        // ── Contested tint (any state) ───────────────────────────────
        const flagFortActive = s.fortressComplete !== false; // default-active for legacy data
        const flagFortPhase = (typeof s.claimPhase === 'number') ? s.claimPhase
                            : (flagFortActive ? 2 : 1); // legacy: derive from active flag
        if (s.fortressContested && flagFortPhase !== 0) {
          ctx.save();
          ctx.fillStyle = 'rgba(255,60,60,0.25)';
          ctx.fillRect(-ts * 0.45, -ts * 0.45, ts * 0.9, ts * 0.9);
          ctx.restore();
        }

        if (flagFortPhase === 0) {
          // ── CLAIMING phase — semi-transparent "ghost" tower, claim-flag-style
          //    contest stripes when an enemy is in radius, claim-countdown bar.
          //    HP bar deliberately hidden — fort is non-damageable here.
          ctx.save();
          // Translucent white wash over the whole sprite to convey "not yet built".
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.fillRect(-ts * 0.55, -ts * 1.4, ts * 1.1, ts * 1.9);

          // Contested stripes (red diagonal hatch) when an enemy is in the radius.
          if (s.claimContested || s.fortressContested) {
            ctx.beginPath();
            ctx.rect(-ts * 0.45, -ts * 0.45, ts * 0.9, ts * 0.9);
            ctx.clip();
            ctx.strokeStyle = 'rgba(255,60,60,0.65)';
            ctx.lineWidth = Math.max(1, 1.4 * zoom);
            const stripeStep = Math.max(4, 7 * zoom);
            for (let h = -ts; h < ts; h += stripeStep) {
              ctx.beginPath();
              ctx.moveTo(h - ts * 0.45, -ts * 0.45);
              ctx.lineTo(h + ts * 0.45, ts * 0.45);
              ctx.stroke();
            }
          }
          ctx.restore();

          // Claim-phase countdown bar above the merlons.
          const isPostDemolish = s.hp === 0;
          const totalMs = (typeof s.claimPhaseTotalMs === 'number' && s.claimPhaseTotalMs > 0)
                        ? s.claimPhaseTotalMs : 60000;
          const remMs   = (typeof s.claimPhaseProgressMs === 'number') ? s.claimPhaseProgressMs : totalMs;
          // Post-demolish: bar drains 99%→0% (rem/total). Normal claiming: fills 0%→100% (1 - rem/total).
          const claimFillFrac = isPostDemolish
            ? Math.min(1, Math.max(0, remMs / totalMs))
            : Math.min(1, Math.max(0, 1 - (remMs / totalMs)));
          const barW = ts * 1.1;
          const barH = Math.max(3, 5 * zoom);
          const barY = -ts * 0.45 - ts * 0.95;
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          ctx.fillRect(-barW / 2, barY, barW, barH);
          ctx.fillStyle = isPostDemolish ? '#cc3333' : ((s.claimContested || s.fortressContested) ? '#e04848' : '#cccccc');
          ctx.fillRect(-barW / 2, barY, barW * claimFillFrac, barH);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = Math.max(1, 1 * zoom);
          ctx.strokeRect(-barW / 2, barY, barW, barH);

          // Label
          if (zoom >= 0.5) {
            const fontPx = Math.max(8, Math.round(9 * zoom));
            ctx.font = `bold ${fontPx}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const label = isPostDemolish
              ? 'UNCLAIMING'
              : ((s.claimContested || s.fortressContested) ? 'CONTESTED' : 'CLAIMING');
            ctx.fillStyle = '#000';
            ctx.fillText(label, 1, barY - 1);
            ctx.fillStyle = isPostDemolish ? '#ff8080' : ((s.claimContested || s.fortressContested) ? '#ff8080' : '#dddddd');
            ctx.fillText(label, 0, barY - 2);
          }
        } else if (flagFortPhase === 1) {
          // ── BUILDING phase (existing visual) — hatch + 0%→30% progress bar.
          // Diagonal-hatch "under construction" overlay on the tower face
          ctx.save();
          ctx.beginPath();
          ctx.rect(-ts * 0.45, -ts * 0.45, ts * 0.9, ts * 0.9);
          ctx.clip();
          ctx.strokeStyle = 'rgba(255,200,80,0.55)';
          ctx.lineWidth = Math.max(1, 1.2 * zoom);
          const hatchStep = Math.max(4, 6 * zoom);
          for (let h = -ts; h < ts; h += hatchStep) {
            ctx.beginPath();
            ctx.moveTo(h - ts * 0.45, -ts * 0.45);
            ctx.lineTo(h + ts * 0.45, ts * 0.45);
            ctx.stroke();
          }
          ctx.restore();

          // Build/heal progress bar above the merlons
          const barW = ts * 1.1;
          const barH = Math.max(3, 5 * zoom);
          const barY = -ts * 0.45 - ts * 0.95;
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          ctx.fillRect(-barW / 2, barY, barW, barH);
          // Fill represents HP fraction (0→0.30 = inactive band)
          const fillFrac = Math.min(1, Math.max(0, hpFrac / 0.30));
          ctx.fillStyle = s.fortressContested ? '#e04848' : '#ffc848';
          ctx.fillRect(-barW / 2, barY, barW * fillFrac, barH);
          // 30% threshold tick (always at right edge since bar maps 0..0.30)
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = Math.max(1, 1 * zoom);
          ctx.strokeRect(-barW / 2, barY, barW, barH);

          // "BUILDING" label (only when zoomed in enough to read)
          if (zoom >= 0.5) {
            const fontPx = Math.max(8, Math.round(9 * zoom));
            ctx.font = `bold ${fontPx}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const label = s.fortressContested ? 'CONTESTED' : 'BUILDING';
            ctx.fillStyle = '#000';
            ctx.fillText(label, 1, barY - 1);
            ctx.fillStyle = s.fortressContested ? '#ff8080' : '#ffe080';
            ctx.fillText(label, 0, barY - 2);
          }
        } else if (flagFortPhase === 2) {
          // ── ACTIVE phase — fort is built. While hp < target_hp it is auto-
          //    repairing toward target_hp (combat damage permanently lowers
          //    target_hp so the fort can never repair to full again). Show a
          //    "REPAIRING" label + a slim repair-progress bar in that gap.
          const targetHp = (typeof s.targetHp === 'number') ? s.targetHp : s.maxHp;
          const isRepairing = s.hp < targetHp && targetHp > 0;
          if (isRepairing) {
            const barW = ts * 1.1;
            const barH = Math.max(2, 3 * zoom);
            const barY = -ts * 0.45 - ts * 0.95;
            // Background = full max-hp scale; ceiling tick at targetHp/maxHp,
            // fill grows from 0 → hp/maxHp.
            const ceilingFrac = Math.min(1, Math.max(0, targetHp / s.maxHp));
            const fillFrac    = Math.min(1, Math.max(0, s.hp / s.maxHp));
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.fillRect(-barW / 2, barY, barW, barH);
            // "Lost ceiling" zone (target_hp → max_hp) drawn dim red.
            if (ceilingFrac < 1) {
              ctx.fillStyle = 'rgba(120,40,40,0.5)';
              ctx.fillRect(-barW / 2 + barW * ceilingFrac, barY,
                           barW * (1 - ceilingFrac), barH);
            }
            // Current HP — pulses softly while repairing.
            const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 220);
            ctx.fillStyle = s.fortressContested
              ? `rgba(224,72,72,${pulse})`
              : `rgba(120,200,255,${pulse})`;
            ctx.fillRect(-barW / 2, barY, barW * fillFrac, barH);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1, 1 * zoom);
            ctx.strokeRect(-barW / 2, barY, barW, barH);

            if (zoom >= 0.5) {
              const fontPx = Math.max(8, Math.round(9 * zoom));
              ctx.font = `bold ${fontPx}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              const label = s.fortressContested ? 'CONTESTED' : 'REPAIRING';
              ctx.fillStyle = '#000';
              ctx.fillText(label, 1, barY - 1);
              ctx.fillStyle = s.fortressContested ? '#ff8080' : '#9fd6ff';
              ctx.fillText(label, 0, barY - 2);
            }
          }
        } else if (flagFortPhase === 3) {
          // ── DEMOLISHING phase — fort was captured; HP draining 10%/s to 0.
          //    Red pulsing diagonal hatch + HP drain bar.
          ctx.save();
          ctx.beginPath();
          ctx.rect(-ts * 0.45, -ts * 0.45, ts * 0.9, ts * 0.9);
          ctx.clip();
          const unclaimPulse = 0.4 + 0.4 * Math.sin(Date.now() / 250);
          ctx.strokeStyle = `rgba(220,40,40,${unclaimPulse})`;
          ctx.lineWidth = Math.max(1, 1.4 * zoom);
          const hatchStep = Math.max(4, 6 * zoom);
          for (let h = -ts; h < ts; h += hatchStep) {
            ctx.beginPath();
            ctx.moveTo(h - ts * 0.45, -ts * 0.45);
            ctx.lineTo(h + ts * 0.45, ts * 0.45);
            ctx.stroke();
          }
          ctx.restore();

          // HP drain bar (hpFrac 100% → 0%)
          const barW = ts * 1.1;
          const barH = Math.max(3, 5 * zoom);
          const barY = -ts * 0.45 - ts * 0.95;
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          ctx.fillRect(-barW / 2, barY, barW, barH);
          ctx.fillStyle = `rgba(220,40,40,${0.6 + 0.35 * Math.sin(Date.now() / 250)})`;
          ctx.fillRect(-barW / 2, barY, barW * hpFrac, barH);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = Math.max(1, 1 * zoom);
          ctx.strokeRect(-barW / 2, barY, barW, barH);

          if (zoom >= 0.5) {
            const fontPx = Math.max(8, Math.round(9 * zoom));
            ctx.font = `bold ${fontPx}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = '#000';
            ctx.fillText('DEMOLISHING', 1, barY - 1);
            ctx.fillStyle = '#ff8080';
            ctx.fillText('DEMOLISHING', 0, barY - 2);
          }
        }

        ctx.restore();
      } else if (s.type === 'company_fortress') {
        const companyColor = this._companyColor(s.companyId);
        const complete = s.fortressComplete ?? false;
        const progress = (s.fortressBuildProgress ?? 0) / 900000;
        const contested = s.fortressContested ?? false;
        const FORT_RADIUS_PX = 600;
        const fortRadiusScreen = FORT_RADIUS_PX * zoom;
        const ts = Math.max(14, 60 * zoom);
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);

        ctx.save();
        ctx.translate(ssp.x, ssp.y);
        ctx.rotate(-camRot);

        if (!complete) {
          // Build progress bar below the structure
          const barW = ts * 1.2, barH = Math.max(3, 6 * zoom);
          const barX = -barW * 0.5, barY = ts * 0.55;
          ctx.fillStyle = '#333333cc';
          ctx.fillRect(barX, barY, barW, barH);
          const fillColor = contested ? '#e04040' : companyColor;
          ctx.fillStyle = fillColor;
          ctx.fillRect(barX, barY, barW * progress, barH);
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.strokeRect(barX, barY, barW, barH);

          // Contested pulse
          if (contested) {
            const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
            ctx.beginPath();
            ctx.arc(0, 0, fortRadiusScreen, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(220,40,40,${0.3 * pulse})`;
            ctx.lineWidth = Math.max(2, 4 * zoom);
            ctx.stroke();
          }
        }

        ctx.restore();
      } else if (s.type === 'claim_flag') {
        const TOTAL_MS = 300000;
        const progress = 1 - Math.max(0, Math.min(1, (s.claimProgress ?? TOTAL_MS) / TOTAL_MS));
        const state = s.claimState ?? (s.claimContested ? 0 : 2);
        const ringR = Math.max(10, 18 * zoom);
        const companyColor = this._companyColor(s.companyId);
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);

        let arcColor = companyColor;
        if (state === 0)      arcColor = '#888888';
        else if (state === 1) arcColor = '#ffd24a';
        else if (state === 2) arcColor = companyColor;
        else if (state === 3) arcColor = '#ff9966';
        else if (state === 4) arcColor = '#ff3030';

        ctx.save();
        ctx.translate(ssp.x, ssp.y);
        ctx.rotate(-camRot);

        // Background ring
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth   = Math.max(2, 3 * zoom);
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.stroke();

        // Progress arc (clockwise from top). Pulse during reversing.
        if (progress > 0) {
          const pulse = (state === 4) ? (0.6 + 0.4 * Math.sin(Date.now() / 180)) : 1;
          ctx.strokeStyle = arcColor;
          ctx.globalAlpha = pulse;
          ctx.lineWidth   = Math.max(2, 3.5 * zoom);
          ctx.beginPath();
          ctx.arc(0, 0, ringR, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Grace tick — small inner arc filling 0→1 during CLAIMING_GRACE / REVERSING_GRACE
        if (state === 1 || state === 3) {
          const GRACE_TOTAL = 5000;
          const g = Math.max(0, Math.min(1, (s.claimGraceMs ?? 0) / GRACE_TOTAL));
          if (g > 0) {
            ctx.strokeStyle = state === 1 ? '#ffd24a' : '#ff9966';
            ctx.lineWidth   = Math.max(1, 2 * zoom);
            ctx.beginPath();
            ctx.arc(0, 0, ringR * 0.55, -Math.PI / 2, -Math.PI / 2 + g * Math.PI * 2);
            ctx.stroke();
          }
        }

        // Timer text — show time remaining / reversing / stalled
        {
          const fontSize = Math.max(9, Math.round(11 * zoom));
          ctx.font = `bold ${fontSize}px Georgia, serif`;
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'top';

          let timerLabel = '';
          let timerColor = '#ffffff';

          if (state === 0) {
            // CONTEST — stalled
            const secsLeft = Math.ceil((s.claimProgress ?? TOTAL_MS) / 1000);
            const m = Math.floor(secsLeft / 60), sc = secsLeft % 60;
            timerLabel = `⏸ ${m}:${sc.toString().padStart(2, '0')}`;
            timerColor = '#cccccc';
          } else if (state === 1) {
            // CLAIMING_GRACE — warming up
            const secsLeft = Math.ceil((s.claimProgress ?? TOTAL_MS) / 1000);
            const m = Math.floor(secsLeft / 60), sc = secsLeft % 60;
            timerLabel = `▶ ${m}:${sc.toString().padStart(2, '0')}`;
            timerColor = '#ffd24a';
          } else if (state === 2) {
            // CLAIMING — counting down to capture
            const secsLeft = Math.ceil((s.claimProgress ?? TOTAL_MS) / 1000);
            const m = Math.floor(secsLeft / 60), sc = secsLeft % 60;
            timerLabel = `${m}:${sc.toString().padStart(2, '0')}`;
            timerColor = arcColor;
          } else if (state === 3) {
            // REVERSING_GRACE — enemy warming up to reverse
            const secsLeft = Math.ceil((s.claimProgress ?? 0) / 1000);
            const m = Math.floor(secsLeft / 60), sc = secsLeft % 60;
            timerLabel = `◀ ${m}:${sc.toString().padStart(2, '0')}`;
            timerColor = '#ff9966';
          } else if (state === 4) {
            // REVERSING — enemy pushing progress back
            const secsLeft = Math.ceil((s.claimProgress ?? 0) / 1000);
            const m = Math.floor(secsLeft / 60), sc = secsLeft % 60;
            timerLabel = `↺ ${m}:${sc.toString().padStart(2, '0')}`;
            timerColor = '#ff3030';
          }

          if (timerLabel) {
            const textY = ringR + Math.max(3, 4 * zoom);
            // Shadow
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillText(timerLabel, 1, textY + 1);
            // Label
            ctx.fillStyle = timerColor;
            ctx.fillText(timerLabel, 0, textY);
          }
        }

        // ── Section badge: "Solo→Pirates" ─────────────────────────────────
        // Identifies which contest section this flag targets by resolving
        // claimLinkedFort (own anchor) and claimSourceEnemy (enemy anchor)
        // to their company IDs, then formatting as "Mine→Enemy".
        if (s.claimSourceEnemy !== undefined && s.claimSourceEnemy !== 0) {
          const mineS  = this.placedStructures.find(p => p.id === s.claimLinkedFort);
          const enemyS = this.placedStructures.find(p => p.id === s.claimSourceEnemy);
          const mineC  = mineS?.companyId ?? s.companyId ?? 0;
          const enemyC = enemyS?.companyId ?? 0;
          if (enemyC !== 0) {
            const cname = (cid: number): string => {
              const co = this._cachedCompanies.find(c => c.id === cid);
              if (co) return co.name;
              return cid === 1 ? 'Solo' : cid === 2 ? 'Pirates' : cid === 3 ? 'Navy' : cid === 99 ? 'Ghost' : `#${cid}`;
            };
            const sectLabel = `${cname(mineC)}→${cname(enemyC)}`;
            const sf = Math.max(8, Math.round(9 * zoom));
            ctx.font = `bold ${sf}px sans-serif`;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'top';
            const timerH = (state >= 0 && state <= 4) ? Math.max(9, Math.round(11 * zoom)) + 4 : 0;
            const baseY  = ringR + Math.max(3, 4 * zoom) + timerH;
            const tw = ctx.measureText(sectLabel).width;
            ctx.fillStyle = 'rgba(10,10,10,0.78)';
            ctx.fillRect(-tw / 2 - 3, baseY, tw + 6, sf + 2);
            ctx.fillStyle = 'rgba(255,215,60,0.95)';
            ctx.fillText(sectLabel, 0, baseY + 1);
          }
        }

        ctx.restore();
      } else if (s.type === 'chest') {
        const cw = sz * 0.72;
        const ch = sz * 0.52;
        const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        const chestTargetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
        const chestIsSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);
        if (this.hammerEquipped && chestIsSchematic) {
          ctx.save();
          ctx.translate(ssp.x, ssp.y);
          ctx.rotate(-camRot);
          ctx.fillStyle = 'rgba(120,200,255,0.22)';
          ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
          const chBuildFrac = Math.max(0, Math.min(1, chestTargetHp > 0 ? s.hp / chestTargetHp : 0));
          const chBarW = cw * 0.7; const chBarH = Math.max(2, 4 * zoom);
          const chBarX = -chBarW / 2; const chBarY = -ch / 2 - chBarH - 2;
          ctx.strokeStyle = '#b0e0ff'; ctx.lineWidth = 1;
          ctx.strokeRect(chBarX, chBarY, chBarW, chBarH);
          ctx.fillStyle = '#55ddff'; ctx.fillRect(chBarX, chBarY, chBarW * chBuildFrac, chBarH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', 0, chBarY - 2);
          ctx.restore();
        }
        if (this.hammerEquipped && !chestIsSchematic && hpFrac < 0.999) {
          ctx.font = `${Math.max(8, Math.round(11 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
          ctx.fillText('\u2692', ssp.x, ssp.y);
        }
      } else if (s.type === 'bed') {
        const bw = sz * 0.88;
        const bh = sz * 0.48;
        const bedTargetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
        const bedIsSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
        const bedHpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
        this._blitStructureBase(s, ssp, zoom, camRot, isHovered, isBlocker);
        if (this.hammerEquipped && bedIsSchematic) {
          ctx.save();
          ctx.translate(ssp.x, ssp.y);
          ctx.rotate(-camRot);
          ctx.fillStyle = 'rgba(120,200,255,0.22)';
          ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
          const bedBuildFrac = Math.max(0, Math.min(1, bedTargetHp > 0 ? s.hp / bedTargetHp : 0));
          const bedBarW = bw * 0.7; const bedBarH = Math.max(2, 4 * zoom);
          const bedBarX = -bedBarW / 2; const bedBarY = -bh / 2 - bedBarH - 2;
          ctx.strokeStyle = '#b0e0ff'; ctx.lineWidth = 1;
          ctx.strokeRect(bedBarX, bedBarY, bedBarW, bedBarH);
          ctx.fillStyle = '#55ddff'; ctx.fillRect(bedBarX, bedBarY, bedBarW * bedBuildFrac, bedBarH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', 0, bedBarY - 2);
          ctx.restore();
        }
        if (this.hammerEquipped && !bedIsSchematic && bedHpFrac < 0.999) {
          ctx.font = `${Math.max(8, Math.round(11 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
          ctx.fillText('\u2692', ssp.x, ssp.y);
        }
      }
    } // end for sorted

    // ── Quality-tier markers ─────────────────────────────────────────────
    // Structures crafted from a quality blueprint carry a rolled tier. Draw a
    // small tier-colored gem above each so the world shows item prestige.
    for (const s of sortedWrapped) {
      if (typeof s.qualityTier !== 'number' || s.qualityTier < 1) continue;
      const _qHalfExt = s.type === 'shipyard' ? SHIPYARD_HH : s.type === 'flag_fort' ? STRUCT_TILE * 1.4 : s.type === 'company_fortress' ? STRUCT_TILE * 1.8 : STRUCT_TILE * 1.1;
      if (!this.fogVisibleAt(s.x, s.y, _qHalfExt)) continue;
      if (!camera.isWorldPositionVisible(Vec2.from(s.x, s.y), _qHalfExt)) continue;
      const gsp = camera.worldToScreen(Vec2.from(s.x, s.y));
      const gsz = Math.max(4, 50 * zoom);
      const col = tierColor(s.qualityTier);
      const r = Math.max(2.5, 4 * zoom);
      const gy = gsp.y - gsz * 0.5 - r * 1.5;
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = Math.min(20, Math.max(4, 7 * zoom));
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = Math.max(0.5, 1 * zoom);
      ctx.beginPath();
      ctx.moveTo(gsp.x, gy - r);
      ctx.lineTo(gsp.x + r, gy);
      ctx.lineTo(gsp.x, gy + r);
      ctx.lineTo(gsp.x - r, gy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    if (this._hoveredStructure) {
      const s   = this._hoveredStructure;
      const ssp = camera.worldToScreen(Vec2.from(s.x, s.y));
      const sz  = Math.max(4, 50 * zoom);

      // Derive rendering rotation for this structure.
      // Floors/workbenches carry an explicit rotation field.
      // Walls/door_frames/doors derive orientation from the nearest floor tile:
      // the wall runs perpendicular to the floor-centre→wall-midpoint vector.
      let rotRad = 0;
      if (s.type === 'wooden_floor' || s.type === 'workbench' || s.type === 'shipyard' || s.type === 'wood_ceiling' || s.type === 'cannon') {
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
      // Cannon: base is 30×20 world units, barrel extends 40 upward from centre → total 30×50
      const rawW   = isWall ? sz : s.type === 'workbench' ? sz * 0.88 : s.type === 'chest' ? sz * 0.72 : s.type === 'bed' ? sz * 0.88 : s.type === 'shipyard' ? sz * (SHIPYARD_HW * 2 / SHIPYARD_TILE) : s.type === 'cannon' ? 30 * zoom : sz;
      const rawH   = isWall ? sz * THICK : s.type === 'workbench' ? sz * 0.62 : s.type === 'chest' ? sz * 0.52 : s.type === 'bed' ? sz * 0.48 : s.type === 'shipyard' ? sz * SHIPYARD_HEIGHT_MULT : s.type === 'cannon' ? 50 * zoom : sz;

      // Axis-aligned bounding box after rotation (used for bar/tooltip screen positioning)
      const absC = Math.abs(Math.cos(rotRad)), absS = Math.abs(Math.sin(rotRad));
      const bbW  = rawW * absC + rawH * absS;
      const bbH  = rawW * absS + rawH * absC;

      // Draw outline rect rotated to match structure orientation — team-coloured
      const _sComp = s.companyId;
      const _sTeam: 'friendly' | 'enemy' =
        this._localCompanyId > 0 && _sComp > 0 && _sComp === this._localCompanyId
          ? 'friendly' : 'enemy';
      const _sOutline = _sTeam === 'friendly' ? '#44ff88' : '#ff4444';
      ctx.save();
      ctx.strokeStyle = _sOutline;
      ctx.shadowColor = _sOutline;
      ctx.shadowBlur  = Math.min(20, 8 * zoom);
      ctx.lineWidth   = Math.max(1, 3 * zoom);
      ctx.translate(ssp.x, ssp.y);
      ctx.rotate(rotRad - camRot);
      if (s.type === 'cannon') {
        // Draw highlight matching cannon shape: base rect + barrel rect
        // Base inherits rotRad from ctx.rotate(rotRad) above — correct.
        const baseW = 22 * zoom, baseH = 15 * zoom, barW = 16 * zoom, barH = 40 * zoom;
        ctx.strokeRect(-baseW / 2, -baseH / 2, baseW, baseH);
        // Barrel: must match the actual draw code's barrelRot exactly.
        // Draw code: barrelRot = aimAngle + π/2, applied at translate(ssp) level (no rotRad stacked).
        // Our ctx already has rotRad stacked, so we apply (barrelRot - rotRad) as the delta.
        const hasLiveAim  = this.islandCannonId === s.id && this.islandCannonAimAngle !== null;
        const hasServerAim = typeof s.cannonAimAngle === 'number';
        const barrelRot = hasLiveAim
          ? (this.islandCannonAimAngle! + Math.PI / 2)
          : hasServerAim
            ? (s.cannonAimAngle! + Math.PI / 2)
            : rotRad; // no aim data → barrel aligned with base
        ctx.save();
        ctx.rotate(barrelRot - rotRad); // net absolute = rotRad + delta = barrelRot - camRot ✓
        ctx.strokeRect(-barW / 2, -barH, barW, barH);
        ctx.restore();
      } else {
        ctx.strokeRect(-rawW / 2, -rawH / 2, rawW, rawH);
      }
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
          return Math.abs(lx) <= SHIPYARD_HW + 100 && Math.abs(ly) <= SHIPYARD_HH + 100;
        }
        const dx = s.x - player.position.x;
        const dy = s.y - player.position.y;
        return dx * dx + dy * dy <= 50 * 50;
      })();

      const label = s.type === 'wooden_floor' ? 'Wooden Floor'
                 : s.type === 'wall' ? 'Wall'
                 : s.type === 'door_frame' ? 'Door Frame'
                 : s.type === 'door' ? (s.doorOpen ? 'Door (Open)' : 'Door (Closed)')
                 : s.type === 'shipyard' ? 'Shipyard'
                 : s.type === 'wreck' ? 'Shipwreck'
                 : s.type === 'wood_ceiling' ? 'Wood Ceiling'
                 : s.type === 'cannon' ? 'Cannon'
                 : s.type === 'flag_fort' ? 'Flag Fort'
                 : s.type === 'company_fortress' ? 'Company Fortress'
                 : s.type === 'claim_flag' ? 'Claiming Flag'
                 : s.type === 'chest' ? 'Chest'
                 : s.type === 'bed' ? 'Bed'
                 : 'Workbench';

      // Determine ownership line text + color
      // Company IDs match server constants: SOLO=1, PIRATES=2, NAVY=3, GHOST=99, dynamic≥100
      const COMPANY_NAMES: Record<number, string> = { 1: 'Solo', 2: 'Pirates', 3: 'Navy', 99: 'Ghosts' };
      let ownerText: string;
      if (s.companyId !== 0 && COMPANY_NAMES[s.companyId]) {
        ownerText = COMPANY_NAMES[s.companyId];
      } else if (s.companyId !== 0 && s.companyId >= 100) {
        ownerText = this._cachedCompanies.find(c => c.id === s.companyId)?.name ?? `Company #${s.companyId}`;
      } else if (s.companyId === 1 && s.placerName) {
        // COMPANY_SOLO: show "Player: name" since solo means individual ownership
        ownerText = `Player: ${s.placerName}`;
      } else if (s.placerName) {
        ownerText = s.placerName;
      } else {
        ownerText = 'Unclaimed';
      }

      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font      = `bold ${Math.max(10, Math.round(12 * zoom))}px Georgia, serif`;
      ctx.fillStyle = '#ffe8a0';
      ctx.fillText(label, ssp.x, tipY);

      const lineH = Math.max(12, 14 * zoom);
      ctx.font = `${Math.max(9, Math.round(10 * zoom))}px Georgia, serif`;

      // Owner line (colored by faction)
      ctx.fillStyle = RenderSystem.structureCompanyColor(s.companyId);
      ctx.fillText(ownerText, ssp.x, tipY - lineH);

      // Interact hint (shifted up one more line)
      if (inRange && !this._anyBuildActive) {
        ctx.fillStyle = 'rgba(200, 255, 180, 0.95)';
        const interactHint = s.type === 'door' ? 'Tap [E] to open/close'
                           : s.type === 'door_frame' ? 'Hold [E] to demolish'
                           : s.type === 'shipyard' ? 'Hold [E] to build ships'
                           : s.type === 'wreck' ? '[E] to salvage loot'
                           : s.type === 'cannon' ? 'Hold [E] to fire'
                           : s.type === 'chest' ? '[E] to open'
                           : s.type === 'bed' ? '[E] Travel'
                           : 'Hold [E] to interact';
        ctx.fillText(interactHint, ssp.x, tipY - lineH * 2);
      } else {
        ctx.fillStyle = 'rgba(180, 180, 160, 0.75)';
        ctx.fillText('(walk closer)', ssp.x, tipY - lineH * 2);
      }

      // Debug overlay (toggle with `]`): structure id + dominator list.
      // Helps diagnose dominance/border issues by surfacing the raw server
      // data that drives the territory rendering.
      if (this.showHoverBoundaries) {
        ctx.fillStyle = 'rgba(255, 220, 120, 0.95)';
        ctx.font = `${Math.max(9, Math.round(10 * zoom))}px monospace`;
        const doms = (s.dominators ?? []).join(',') || '(none)';
        ctx.fillText(`id=${s.id}`,       ssp.x, tipY - lineH * 3);
        ctx.fillText(`dom=[${doms}]`,    ssp.x, tipY - lineH * 4);

        // Claim flag: enumerate hypothetical (target, new-dom) pairs that
        // a successful capture would write. target = enemy victim,
        // new-dom = friendly challenger. We compute pairs from overlapping
        // discs (same-island, non-orphaned, non-flag); this mirrors the
        // pair-wise lens that anchors the section flood-fill server-side.
        if (s.type === 'claim_flag') {
          const claimRadiusOf = (t: string): number =>
            (t === 'flag_fort' || t === 'company_fortress') ? 600 : 400;
          const flagCo = s.companyId ?? 0;
          const isl    = s.islandId;
          const eligible = (ps: PlacedStructure): boolean =>
                 ps.islandId === isl
              && !ps.claimOrphaned
              && ps.type !== 'claim_flag'
              && !(ps.type === 'flag_fort' && !ps.fortressComplete && (ps.claimPhase ?? 0) < 2);
          const mineList: PlacedStructure[] = [];
          const enemyList: PlacedStructure[] = [];
          for (const ps of this.placedStructures) {
            if (!eligible(ps)) continue;
            if ((ps.companyId ?? 0) === 0) continue;
            if ((ps.companyId ?? 0) === flagCo) mineList.push(ps);
            else                                 enemyList.push(ps);
          }
          let line = 5;
          ctx.fillText(`src=(${s.claimSourceEnemy ?? '?'},${s.claimLinkedFort ?? '?'})`,
                       ssp.x, tipY - lineH * line); line++;
          // Emit (target=E, new-dom=M) for every overlapping (E, M) pair,
          // and shade each pair's lens(E.disc ∩ M.disc) in world space so
          // the targeted area is visually highlighted alongside the IDs.
          for (const e of enemyList) {
            const erW = claimRadiusOf(e.type);
            const erS = erW * zoom;
            const eSp = camera.worldToScreen(Vec2.from(e.x, e.y));
            for (const m of mineList) {
              const mrW = claimRadiusOf(m.type);
              const dx = e.x - m.x, dy = e.y - m.y;
              const th = erW + mrW;
              if (dx * dx + dy * dy > th * th) continue;
              const mrS = mrW * zoom;
              const mSp = camera.worldToScreen(Vec2.from(m.x, m.y));
              // Lens fill + outline (clipped circle ∩ circle)
              ctx.save();
              ctx.beginPath();
              ctx.arc(eSp.x, eSp.y, erS, 0, Math.PI * 2);
              ctx.clip();
              ctx.fillStyle = 'rgba(255, 180, 60, 0.18)';
              ctx.beginPath();
              ctx.arc(mSp.x, mSp.y, mrS, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = 'rgba(255, 210, 90, 0.85)';
              ctx.lineWidth = Math.max(1, 1.5 * zoom);
              ctx.stroke();
              ctx.restore();
              // Midpoint pair label
              ctx.save();
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.font = `bold ${Math.max(10, Math.round(11 * zoom))}px monospace`;
              ctx.strokeStyle = 'rgba(0,0,0,0.85)';
              ctx.lineWidth = 3;
              ctx.fillStyle = 'rgba(255, 230, 150, 0.95)';
              const lx = (eSp.x + mSp.x) * 0.5;
              const ly = (eSp.y + mSp.y) * 0.5;
              const txt = `(${e.id},${m.id})`;
              ctx.strokeText(txt, lx, ly);
              ctx.fillText(txt, lx, ly);
              ctx.restore();
              // Tooltip line
              ctx.fillText(`(${e.id},${m.id})`, ssp.x, tipY - lineH * line);
              line++;
              if (line > 24) break;
            }
            if (line > 24) break;
          }
        }
      }
      ctx.restore();
    }

    // ── Contest flash borders ─────────────────────────────────────────────────
    // When a claim flag is active, every structure whose centre falls inside the
    // contested lens area (intersection of both anchor claim radii) gets a pulsing
    // dashed border so players can see what territory is at stake.
    {
      const claimRadiusOf = (type: string): number =>
        (type === 'flag_fort' || type === 'company_fortress') ? 600 : 400;

      // Map structureId → flash hex color, driven by the most urgent claim flag
      // state that covers this structure (4=REVERSING is most urgent).
      const flashMap = new Map<number, { color: string; urgency: number }>();

      for (const cf of this.placedStructures) {
        if (cf.type !== 'claim_flag') continue;
        const state = cf.claimState ?? (cf.claimContested ? 0 : 2);
        let flashColor: string;
        if      (state === 0) flashColor = '#ffcc44'; // CONTEST        — amber
        else if (state === 1) flashColor = '#ffd24a'; // CLAIMING_GRACE — yellow
        else if (state === 2) flashColor = this._companyColor(cf.companyId); // CLAIMING — company colour
        else if (state === 3) flashColor = '#ff9966'; // REVERSING_GRACE— orange
        else                  flashColor = '#ff3030'; // REVERSING      — red

        const mineS  = cf.claimLinkedFort  != null ? this.placedStructures.find(p => p.id === cf.claimLinkedFort)  : null;
        const enemyS = cf.claimSourceEnemy != null ? this.placedStructures.find(p => p.id === cf.claimSourceEnemy) : null;
        if (!mineS || !enemyS) continue;
        const mineR  = claimRadiusOf(mineS.type);
        const enemyR = claimRadiusOf(enemyS.type);

        for (const s of this.placedStructures) {
          if (s.type === 'claim_flag') continue;
          const dx1 = s.x - mineS.x, dy1 = s.y - mineS.y;
          const dx2 = s.x - enemyS.x, dy2 = s.y - enemyS.y;
          if (dx1*dx1 + dy1*dy1 <= mineR*mineR && dx2*dx2 + dy2*dy2 <= enemyR*enemyR) {
            const existing = flashMap.get(s.id);
            if (!existing || state > existing.urgency) {
              flashMap.set(s.id, { color: flashColor, urgency: state });
            }
          }
        }
      }

      // Also flash structures inside a demolishing fort's claim radius.
      // A fort is demolishing when: claimPhase===0 and hp===0.
      const FORT_DEMOLISH_URGENCY = 5; // higher than any claim-flag state (0–4)
      for (const fort of this.placedStructures) {
        if (fort.type !== 'flag_fort' && fort.type !== 'company_fortress') continue;
        if ((fort.claimPhase ?? 2) !== 0 || fort.hp !== 0) continue; // not demolishing
        const fortR = 600;
        for (const s of this.placedStructures) {
          if (s.id === fort.id) continue;          // skip the fort itself
          if (s.type === 'claim_flag') continue;
          const dx = s.x - fort.x, dy = s.y - fort.y;
          if (dx*dx + dy*dy <= fortR*fortR) {
            const existing = flashMap.get(s.id);
            if (!existing || FORT_DEMOLISH_URGENCY > existing.urgency) {
              flashMap.set(s.id, { color: '#cc3333', urgency: FORT_DEMOLISH_URGENCY });
            }
          }
        }
      }

      if (flashMap.size > 0) {
        const flashAlpha = 0.35 + 0.35 * Math.abs(Math.sin(performance.now() * Math.PI / 600));
        const THICK = 0.18; // wall thickness ratio (matches draw code)
        ctx.save();
        ctx.setLineDash([Math.max(4, 8 * zoom), Math.max(3, 5 * zoom)]);
        ctx.lineWidth = Math.max(2, 3 * zoom);

        for (const s of sorted) {
          const entry = flashMap.get(s.id);
          if (!entry) continue;
          const ssp2 = camera.worldToScreen(Vec2.from(s.x, s.y));
          const sz2  = Math.max(4, 50 * zoom);

          // Rotation — mirrors the hover-highlight derivation
          let rotRad2 = 0;
          if (s.type === 'wooden_floor' || s.type === 'workbench' || s.type === 'shipyard' || s.type === 'wood_ceiling' || s.type === 'cannon') {
            rotRad2 = (s.rotation ?? 0) * Math.PI / 180;
          } else if (s.type === 'wall' || s.type === 'door_frame' || s.type === 'door') {
            const nf = this.placedStructures.find(f => f.type === 'wooden_floor' && Math.hypot(f.x - s.x, f.y - s.y) < 30);
            if (nf) rotRad2 = Math.atan2(s.y - nf.y, s.x - nf.x) + Math.PI / 2;
          }

          const isWall2 = s.type === 'wall' || s.type === 'door_frame' || s.type === 'door';
          const rawW2 = isWall2 ? sz2 : s.type === 'workbench' ? sz2 * 0.88 : s.type === 'chest' ? sz2 * 0.72 : s.type === 'bed' ? sz2 * 0.88 : s.type === 'shipyard' ? sz2 * (SHIPYARD_HW * 2 / SHIPYARD_TILE) : s.type === 'cannon' ? 30 * zoom : sz2;
          const rawH2 = isWall2 ? sz2 * THICK : s.type === 'workbench' ? sz2 * 0.62 : s.type === 'chest' ? sz2 * 0.52 : s.type === 'bed' ? sz2 * 0.48 : s.type === 'shipyard' ? sz2 * SHIPYARD_HEIGHT_MULT : s.type === 'cannon' ? 50 * zoom : sz2;

          ctx.save();
          ctx.globalAlpha = flashAlpha;
          ctx.strokeStyle = entry.color;
          ctx.translate(ssp2.x, ssp2.y);
          ctx.rotate(rotRad2 - camRot);
          ctx.strokeRect(-rawW2 / 2, -rawH2 / 2, rawW2, rawH2);
          ctx.restore();
        }

        ctx.restore(); // reset lineDash / lineWidth
      }
    }
  }

  /**
   * Render deferred wood ceiling tiles.  Called from renderWorld AFTER the
   * fiber-bush pass so roofs visually cover bushes that grow beneath the
   * building.  Mirrors the inline render block previously in drawPlacedStructures.
   */
  private drawPendingCeilings(camera: Camera): void {
    if (this._pendingCeilings.length === 0) return;
    const ctx  = this.ctx;
    const { zoom, rotation: camRot } = camera.getState();
    const visPolyPts   = this._visPolyPts;
    const visPolyValid = visPolyPts.length >= 6;
    const MIN_CEIL_ALPHA = 0.25;

    for (const { s, ssp, sz, isHovered } of this._pendingCeilings) {
      const rotRad = (s.rotation ?? 0) * Math.PI / 180;
      const targetHp = typeof s.targetHp === 'number' ? s.targetHp : s.maxHp;
      const isSchematic = typeof s.targetHp === 'number' && s.hp < s.targetHp;
      const hpFrac = s.maxHp > 0 ? s.hp / s.maxHp : 1;
      const half = sz / 2;
      const ceilSprite = getWoodCeilingSprite(this._structureSpriteCache, {
        hovered: isHovered,
        companyId: s.companyId,
        hpFrac,
      });
      const ceilSw = ceilSprite.w * zoom;
      const ceilSh = ceilSprite.h * zoom;

      const drawCeilContent = (alphaFactor: number): void => {
        ctx.globalAlpha = alphaFactor;
        ctx.drawImage(ceilSprite.canvas as unknown as CanvasImageSource, -ceilSw / 2, -ceilSh / 2, ceilSw, ceilSh);
        ctx.globalAlpha = 1;
      };

      ctx.save();
      ctx.translate(ssp.x, ssp.y);
      ctx.rotate(rotRad - camRot);

      if (visPolyValid) {
        const cosR = Math.cos(-rotRad), sinR = Math.sin(-rotRad);
        const vp = new Float32Array(visPolyPts.length);
        for (let i = 0; i < visPolyPts.length; i += 2) {
          const dx = (visPolyPts[i]   - s.x) * zoom;
          const dy = (visPolyPts[i+1] - s.y) * zoom;
          vp[i]   = dx * cosR - dy * sinR;
          vp[i+1] = dx * sinR + dy * cosR;
        }

        // Shadow region (tile rect MINUS vis poly) — fully opaque.
        ctx.save();
        ctx.beginPath();
        ctx.rect(-half, -half, sz, sz);
        ctx.moveTo(vp[0], vp[1]);
        for (let i = 2; i < vp.length; i += 2) ctx.lineTo(vp[i], vp[i+1]);
        ctx.closePath();
        ctx.clip('evenodd');
        drawCeilContent(1);
        ctx.restore();

        // Lit region (tile rect ∩ vis poly) — semi-transparent.
        ctx.save();
        ctx.beginPath();
        ctx.rect(-half, -half, sz, sz);
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(vp[0], vp[1]);
        for (let i = 2; i < vp.length; i += 2) ctx.lineTo(vp[i], vp[i+1]);
        ctx.closePath();
        ctx.clip();
        drawCeilContent(MIN_CEIL_ALPHA);
        ctx.restore();
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(-half, -half, sz, sz);
        ctx.clip();
        drawCeilContent(1);
        ctx.restore();
      }

      // Schematic (under construction / repairing) overlay — drawn on top of
      // the vis-poly result so transparency still works while building.
      if (isSchematic) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(120,200,255,0.18)';
        ctx.fillRect(-half, -half, sz, sz);
        if (this.hammerEquipped) {
          const buildFrac = Math.max(0, Math.min(1, targetHp > 0 ? s.hp / targetHp : 0));
          const barW = sz * 0.7;
          const barH = Math.max(2, 4 * zoom);
          const barX = -barW / 2;
          const barY = -half - barH - 2;
          ctx.strokeStyle = '#b0e0ff';
          ctx.lineWidth = 1;
          ctx.strokeRect(barX, barY, barW, barH);
          ctx.fillStyle = '#55ddff';
          ctx.fillRect(barX, barY, barW * buildFrac, barH);
          ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = '#b0e0ff';
          ctx.fillText('\u2692', 0, barY - 2);
        }
      } else if (this.hammerEquipped && hpFrac < 0.999) {
        // Repair icon for damaged ceilings when hammer equipped
        ctx.globalAlpha = 1;
        ctx.font = `${Math.max(8, Math.round(12 * zoom))}px Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255, 180, 60, 0.9)';
        ctx.fillText('\u2692', 0, 0);
      }

      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#5a3a12';
      ctx.lineWidth = Math.max(0.5, 1.5 * zoom);
      ctx.strokeRect(-half, -half, sz, sz);

      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  /** Draw the island structure placement ghost at the cursor position (drawn once, after all islands). */
  /** Render committed-but-unbuilt land structure ghost plan markers. */
  private drawLandGhostPlacements(camera: Camera): void {
    const ghosts = this.landGhostPlacements;
    if (ghosts.length === 0) return;
    const ctx = this.ctx;
    const { zoom, rotation: camRot } = camera.getState();
    const t = performance.now() / 1000;

    // Approximate bounding half-sizes per structure kind (world pixels)
    const DIMS: Record<string, [number, number]> = {
      wooden_floor: [25, 25],
      wall:         [25,  5],
      door_frame:   [25,  5],
      door:         [25,  5],
      wood_ceiling: [25, 25],
      workbench:    [22, 17],
      cannon:       [18, 10],
      shipyard:     [55, 35],
      flag_fort:    [20, 20],
      company_fortress: [30, 30],
      claim_flag:   [10, 10],
      chest:        [20, 14],
      bed:          [22, 12],
    };
    const DEFAULT_DIMS: [number, number] = [20, 20];

    ghosts.forEach((g, idx) => {
      const sp = camera.worldToScreen(Vec2.from(g.worldPos.x, g.worldPos.y));
      const [hw, hh] = DIMS[g.kind] ?? DEFAULT_DIMS;
      const structRad = g.rotation * Math.PI / 180;
      const drawRot = structRad - camRot;
      const isHovered = g.id === this._hoveredLandGhostId;

      // Pulse alpha between 0.55 and 0.85 (faster + brighter when hovered)
      const pulse = isHovered
        ? 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(t * 5.0))
        : 0.55 + 0.30 * (0.5 + 0.5 * Math.sin(t * 2.5 + idx * 0.7));

      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.scale(zoom, zoom);
      ctx.rotate(drawRot);

      const _ghostAfford = this.landAffordabilityCheck ? this.landAffordabilityCheck(g.kind) : this.landGhostCanAfford;
      const _hoverAfford = !isHovered || _ghostAfford;
      if (isHovered) {
        // Fill: green when affordable, red when not
        ctx.fillStyle = _hoverAfford
          ? `rgba(80, 220, 80, ${pulse * 0.30})`
          : `rgba(220, 60, 40, ${pulse * 0.30})`;
        ctx.fillRect(-hw, -hh, hw * 2, hh * 2);

        // Outline
        ctx.strokeStyle = _hoverAfford
          ? `rgba(100, 255, 100, ${pulse})`
          : `rgba(255, 80, 60, ${pulse})`;
        ctx.lineWidth = 3 / zoom;
        ctx.setLineDash([]);
        ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);

        // Inner shadow
        ctx.strokeStyle = _hoverAfford
          ? `rgba(40, 180, 40, ${pulse * 0.5})`
          : `rgba(180, 40, 20, ${pulse * 0.5})`;
        ctx.lineWidth = 1.5 / zoom;
        ctx.strokeRect(-hw + 3 / zoom, -hh + 3 / zoom, hw * 2 - 6 / zoom, hh * 2 - 6 / zoom);
      } else {
        // Blueprint fill — blue
        ctx.fillStyle = `rgba(40, 100, 220, ${pulse * 0.25})`;
        ctx.fillRect(-hw, -hh, hw * 2, hh * 2);

        // Dashed blue outline
        ctx.strokeStyle = `rgba(80, 160, 255, ${pulse})`;
        ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([4 / zoom, 3 / zoom]);
        ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
        ctx.setLineDash([]);
      }

      ctx.restore();

      // Number badge (screen-space, no rotation) — green on hover (affordable), red if not, blue otherwise
      const _badgeAfford = !isHovered || _ghostAfford;
      const badge = isHovered ? (_badgeAfford ? '✓' : '✗') : `${idx + 1}`;
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.font = `bold ${Math.round(11 * zoom)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isHovered
        ? (_badgeAfford ? 'rgba(0,60,0,0.85)' : 'rgba(80,0,0,0.85)')
        : 'rgba(0,20,80,0.8)';
      ctx.fillRect(-8 * zoom, -8 * zoom, 16 * zoom, 16 * zoom);
      ctx.fillStyle = isHovered ? (_badgeAfford ? '#88ff88' : '#ff6666') : '#66aaff';
      ctx.fillText(badge, 0, 0);
      ctx.restore();
    });
  }

  private drawIslandBuildGhost(camera: Camera): void {
    this._islandGhostTooFar    = false;
    this._snappedBuildPos      = null;
    this._snappedBuildRotation = null;
    this._hoveredLandGhostId   = null;

    // ── Build Schematic Hotbar hover detection ─────────────────────────────
    // When a schematic is selected, find the nearest matching plan ghost within
    // hover range.  If found: mark it as hovered (green highlight) and store
    // its position so the placement preview snaps there.  The preview still
    // renders — it just locks to the ghost rather than free-following the cursor.
    let _hoverGhostPos: { x: number; y: number; rotation: number } | null = null;
    if (this.buildSchematicKind && this.mouseWorldPos && this.landGhostPlacements.length > 0) {
      const HOVER_R = 50;
      let nearestGhost: LandGhostPlacement | null = null;
      let nearestDist = HOVER_R;
      for (const g of this.landGhostPlacements) {
        if (g.kind !== this.buildSchematicKind) continue;
        const dx = this.mouseWorldPos.x - g.worldPos.x;
        const dy = this.mouseWorldPos.y - g.worldPos.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < nearestDist) { nearestDist = d; nearestGhost = g; }
      }
      if (nearestGhost) {
        this._hoveredLandGhostId   = nearestGhost.id;
        this._snappedBuildPos      = { x: nearestGhost.worldPos.x, y: nearestGhost.worldPos.y };
        this._snappedBuildRotation = nearestGhost.rotation;
        _hoverGhostPos = { x: nearestGhost.worldPos.x, y: nearestGhost.worldPos.y, rotation: nearestGhost.rotation };
        // Fall through — the placement preview will render snapped to this position.
      }
    }

    if (!this.islandBuildKind || !this.mouseWorldPos) return;
    const ctx  = this.ctx;
    const { zoom, rotation: camRot } = camera.getState();
    const TILE = 50; // world px — floor tile size
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
    let mx = _hoverGhostPos ? _hoverGhostPos.x : this.mouseWorldPos.x;
    let my = _hoverGhostPos ? _hoverGhostPos.y : this.mouseWorldPos.y;
    // Merge placed structures + pending ghost plan so hover snap sees both
    const bases = this._snapBases();
    if (this.islandBuildKind === 'wooden_floor' && bases.length > 0) {
      const SNAP_R  = TILE * 0.4; // 20 px — snap pull radius
      let bestDist2 = SNAP_R * SNAP_R;
      let bestX = mx, bestY = my;
      let bestSnapRot: number | null = null;
      for (const s of bases) {
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
          const blocker = bases.find(
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
    } else if ((this.islandBuildKind === 'wall' || this.islandBuildKind === 'door_frame') && bases.length > 0) {
      // Reset rotation so stale value never persists when no snap is found
      this._wallGhostRotRad = 0;
      const HALF = TILE / 2; // 25 px
      const SNAP_R = TILE * 0.6;
      let bestDist2 = SNAP_R * SNAP_R;
      let bestX = mx, bestY = my;
      for (const s of bases) {
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
          const occ = bases.some(
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
    } else if (this.islandBuildKind === 'door' && bases.length > 0) {
      // Snap to unoccupied door_frame positions
      const SNAP_R = TILE * 0.6;
      let bestDist2 = SNAP_R * SNAP_R;
      let bestX = mx, bestY = my;
      for (const s of bases) {
        if (s.type !== 'door_frame') continue;
        const hasDoor = bases.some(
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
    } else if (this.islandBuildKind === 'wood_ceiling' && bases.length > 0) {
      // Snap ceiling to: (1) floor centres with a wall at edge, or (2) adjacent ceiling positions
      const SNAP_R = TILE * 0.7;
      let bestDist2 = SNAP_R * SNAP_R;
      let bestX = mx, bestY = my;
      let bestRot: number | null = null;
      const HALF = TILE / 2;
      for (const s of bases) {
        if (s.type === 'wooden_floor') {
          // Only a valid start position if it has a wall at one of its edges
          const rad = (s.rotation ?? 0) * Math.PI / 180;
          const c = Math.cos(rad), sn = Math.sin(rad);
          const EDGES = [
            { ldx:  0,    ldy: -HALF },
            { ldx:  0,    ldy:  HALF },
            { ldx: -HALF, ldy:  0    },
            { ldx:  HALF, ldy:  0    },
          ];
          const hasWall = EDGES.some(e => {
            const ex = s.x + e.ldx * c - e.ldy * sn;
            const ey = s.y + e.ldx * sn + e.ldy * c;
            return bases.some(
              w => (w.type === 'wall' || w.type === 'door_frame') &&
                   Math.abs(w.x - ex) < 3 && Math.abs(w.y - ey) < 3
            );
          });
          if (!hasWall) continue;
          const alreadyCeiling = bases.some(
            f => f.type === 'wood_ceiling' && Math.abs(f.x - s.x) < 3 && Math.abs(f.y - s.y) < 3
          );
          if (alreadyCeiling) continue;
          const dist2 = (s.x - mx) * (s.x - mx) + (s.y - my) * (s.y - my);
          if (dist2 < bestDist2) { bestDist2 = dist2; bestX = s.x; bestY = s.y; bestRot = s.rotation ?? 0; }
        } else if (s.type === 'wood_ceiling') {
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
            const occ = bases.some(
              f => f.type === 'wood_ceiling' && Math.abs(f.x - nx) < 3 && Math.abs(f.y - ny) < 3
            );
            if (occ) continue;
            const dist2 = (nx - mx) * (nx - mx) + (ny - my) * (ny - my);
            if (dist2 < bestDist2) { bestDist2 = dist2; bestX = nx; bestY = ny; bestRot = s.rotation ?? 0; }
          }
        }
      }
      mx = bestX; my = bestY;
      this._snappedBuildRotation = bestRot;
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

      // Helper: minimum distance from (wx, wy) to any edge of an island's polygon
      const polyEdgeDist = (verts: {x:number;y:number}[], cx: number, cy: number, wx: number, wy: number): number => {
        let minDist = Infinity;
        const n = verts.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ax = verts[j].x, ay = verts[j].y;
          const bx = verts[i].x, by = verts[i].y;
          const ex = bx - ax, ey = by - ay;
          const len2 = ex * ex + ey * ey;
          let t = len2 > 0 ? ((wx - ax) * ex + (wy - ay) * ey) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const nearX = ax + t * ex - wx, nearY = ay + t * ey - wy;
          const d = Math.hypot(nearX, nearY);
          if (d < minDist) minDist = d;
        }
        return minDist;
      };

      let inShallowZone = false;
      if (inWater) {
        for (const isl of this.islands) {
          if (isl.vertices) {
            const polyBoundR = Math.max(...isl.vertices.map(v => Math.hypot(v.x - isl.x, v.y - isl.y)));
            const shallowDepth = polyBoundR * SHALLOW_SCALE_G;
            const d = Math.hypot(mx - isl.x, my - isl.y);
            if (d <= polyBoundR + shallowDepth) {
              // Polygon-accurate: check actual edge distance
              const edgeDist = polyEdgeDist(isl.vertices, isl.x, isl.y, mx, my);
              if (edgeDist < shallowDepth) { inShallowZone = true; break; }
            }
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
      const HH_WORLD = SHIPYARD_HH;
      const rotRad = effectiveRotDeg * Math.PI / 180;
      const mouthX = mx - HH_WORLD * Math.sin(rotRad);
      const mouthY = my + HH_WORLD * Math.cos(rotRad);
      // Also check a point 600 units out (clear path for the ship)
      const releaseX = mx - 600 * Math.sin(rotRad);
      const releaseY = my + 600 * Math.cos(rotRad);
      const mouthClear = isPointInWater(mouthX, mouthY) && isPointInWater(releaseX, releaseY);

      const isOnLand = (px: number, py: number) => !isPointInWater(px, py);
      const shipSlotOnLand = brigSlotOverlapsLand(mx, my, effectiveRotDeg, isOnLand);

      // Allow placing from shore — 700 px matches the server shipyard placement range
      const syPlayerFar = playerG ? (() => {
        const dx = mx - playerG.position.x; const dy = my - playerG.position.y;
        return dx * dx + dy * dy > 700 * 700;
      })() : false;
      const syOccupied = this.placedStructures.some(s =>
        s.type === 'shipyard' && Math.hypot(s.x - mx, s.y - my) < 700
      );
      const syInvalid = !inWater || !inShallowZone || syPlayerFar || syOccupied || !mouthClear || shipSlotOnLand;
      const syCantAfford = !syInvalid && !this.landGhostCanAfford;
      this._islandGhostTooFar = syInvalid;
      const GA_T = TILE * (SHIPYARD_ARM_T / SHIPYARD_TILE) * zoom;
      const GI_W = TILE * (SHIPYARD_INT_W / SHIPYARD_TILE) * zoom;
      const GA_L = TILE * (SHIPYARD_ARM_L / SHIPYARD_TILE) * zoom;
      const GB_T = TILE * (SHIPYARD_BACK_T / SHIPYARD_TILE) * zoom;
      const gtW  = Math.max(4, GA_T + GI_W + GA_T);
      const gtH  = Math.max(4, GB_T + GA_L);
      const gHW = gtW / 2, gHH = gtH / 2;
      ctx.save();
      ctx.globalAlpha = 0.72 + 0.14 * Math.sin(performance.now() / 300);
      // Apply rotation — same effectiveRotDeg used by floor/workbench ghost
      const syRotRad = effectiveRotDeg * Math.PI / 180;
      if (syRotRad !== 0 || camRot !== 0) {
        ctx.translate(msp.x, msp.y);
        ctx.rotate(syRotRad - camRot);
        ctx.translate(-msp.x, -msp.y);
      }
      ctx.fillStyle   = (syInvalid || syCantAfford) ? 'rgba(220, 60, 40, 0.45)' : 'rgba(100, 180, 255, 0.45)';
      ctx.strokeStyle = (syInvalid || syCantAfford) ? 'rgba(255, 100, 60, 0.75)' : 'rgba(120, 200, 255, 0.75)';
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

      // Brigantine build-slot preview (where the scaffolded ship spawns).
      // Draw in dock-local screen offsets inside the same ctx rotation as the U-shape —
      // worldToScreen corners would double-apply the active canvas transform.
      const slotInvalid = shipSlotOnLand;
      ctx.fillStyle   = slotInvalid ? 'rgba(255, 80, 40, 0.35)' : 'rgba(180, 140, 60, 0.30)';
      ctx.strokeStyle = slotInvalid ? 'rgba(255, 120, 60, 0.90)' : 'rgba(220, 180, 90, 0.85)';
      ctx.lineWidth   = Math.max(1, 1.5 * zoom);
      ctx.setLineDash([Math.max(2, 3 * zoom), Math.max(2, 2 * zoom)]);
      ctx.beginPath();
      const slotCorners = brigSlotCornersLocal();
      for (let ci = 0; ci < slotCorners.length; ci++) {
        const slx = slotCorners[ci].x * zoom;
        const sly = slotCorners[ci].y * zoom;
        if (ci === 0) ctx.moveTo(msp.x + slx, msp.y + sly);
        else ctx.lineTo(msp.x + slx, msp.y + sly);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      const syLabelY = msp.y - gHH - 6;
      ctx.globalAlpha = 1;
      ctx.font = `bold ${Math.max(10, Math.round(12 * zoom))}px Georgia, serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      if (!inWater) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('ON LAND', msp.x, syLabelY);
      } else if (!inShallowZone) {
        ctx.fillStyle = '#4488ff'; ctx.fillText('PLACE IN SHALLOW WATER', msp.x, syLabelY);
      } else if (!mouthClear) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('SHIP EXIT BLOCKED BY LAND', msp.x, syLabelY);
      } else if (shipSlotOnLand) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('SHIP SLOT ON LAND', msp.x, syLabelY);
      } else if (syOccupied) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('TOO CLOSE TO SHIPYARD', msp.x, syLabelY);
      } else if (syPlayerFar) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('TOO FAR', msp.x, syLabelY);
      } else if (syCantAfford) {
        ctx.fillStyle = '#ff6644'; ctx.fillText('Insufficient Resources', msp.x, syLabelY);
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

    // Boulder obstacle: rotated-ellipse vs OBB — mirrors server structures.c and simulation.c
    // Shape/hash formula matches BOULDER_SHAPES + drawRot used in drawBoulderSprite.
    let blockedByBoulder = false;
    if (this.islandBuildKind === 'wooden_floor') {
      const BOULDER_BASE_R = 38;
      const half = TILE / 2;
      const boulderRad = effectiveRotDeg * Math.PI / 180;
      // Inverse rotation: world → floor local frame
      const frc = Math.cos(-boulderRad), frs = Math.sin(-boulderRad);
      // Forward rotation: floor local → world frame
      const frc_f = Math.cos(boulderRad), frs_f = Math.sin(boulderRad);
      outer2:
      for (const isl of this.islands) {
        for (const res of isl.resources) {
          if (res.type !== 'boulder') continue;
          if (res.hp <= 0) continue; // depleted — no longer an obstacle
          const bx = isl.x + res.ox, by = isl.y + res.oy;
          // Boulder centre in floor local frame
          const dx = bx - mx, dy = by - my;
          const lx = dx * frc - dy * frs;
          const ly = dx * frs + dy * frc;
          // Closest point on floor OBB (floor-local coords)
          const cx_f = Math.max(-half, Math.min(lx, half));
          const cy_f = Math.max(-half, Math.min(ly, half));
          // Transform closest point back to world, then into boulder-relative coords
          const cpx_w = cx_f * frc_f - cy_f * frs_f + mx - bx;
          const cpy_w = cx_f * frs_f + cy_f * frc_f + my - by;
          // Boulder ellipse shape from hash (must match drawBoulderSprite & server BSX/BSY/BSR)
          const size = res.size ?? 1.0;
          const hash = ((Math.trunc(res.ox) * 73856093) ^ (Math.trunc(res.oy) * 19349663)) >>> 0;  // matches server (int) cast + uint32_t
          const bsi = (hash >>> 4) % RenderSystem.BOULDER_SHAPES.length;
          const [shapeX, shapeY, shapeRot] = RenderSystem.BOULDER_SHAPES[bsi];
          const ax = BOULDER_BASE_R * size * shapeX;
          const ay = BOULDER_BASE_R * size * shapeY;
          const theta = shapeRot + ((hash >>> 8) & 0xFF) / 256 * Math.PI * 2;
          const ec = Math.cos(theta), es = Math.sin(theta);
          // Rotate closest-OBB-point delta into ellipse local frame
          const elx = cpx_w * ec + cpy_w * es;
          const ely = -cpx_w * es + cpy_w * ec;
          if ((elx / ax) * (elx / ax) + (ely / ay) * (ely / ay) < 1.0) { blockedByBoulder = true; break outer2; }
        }
      }
    }

    // Workbench/cannon/chest/bed needs a floor tile whose AABB contains the cursor point
    let noFloor = false;
    if (this.islandBuildKind === 'workbench' || this.islandBuildKind === 'cannon' || this.islandBuildKind === 'chest' || this.islandBuildKind === 'bed') {
      noFloor = !this.placedStructures.some(s => {
        if (s.type !== 'wooden_floor') return false;
        const rad = (s.rotation ?? 0) * Math.PI / 180;
        const rc = Math.cos(-rad), rs = Math.sin(-rad);
        const lx = (mx - s.x) * rc - (my - s.y) * rs;
        const ly = (mx - s.x) * rs + (my - s.y) * rc;
        return Math.abs(lx) <= 25 && Math.abs(ly) <= 25;
      });
    }
    let bedOccupied = false;
    if (this.islandBuildKind === 'bed') {
      bedOccupied = this.placedStructures.some(s =>
        s.type === 'bed' && Math.hypot(s.x - mx, s.y - my) < 30
      );
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
          if (s.type === 'wooden_floor' || s.type === 'wall' || s.type === 'door_frame' || s.type === 'wood_ceiling') return false;
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

    // Ceiling needs a wall at one of its edges OR an adjacent ceiling tile
    let noCeilingSupport = false;
    let ceilingOccupied = false;
    if (this.islandBuildKind === 'wood_ceiling') {
      ceilingOccupied = this.placedStructures.some(
        f => f.type === 'wood_ceiling' && Math.abs(f.x - mx) < 3 && Math.abs(f.y - my) < 3
      );
      if (!ceilingOccupied) {
        const HALF_C = 25;
        const ghostRad = (this._snappedBuildRotation ?? 0) * Math.PI / 180;
        const cGc = Math.cos(ghostRad), cGs = Math.sin(ghostRad);
        const EDGES_C = [
          { ldx:  0,    ldy: -HALF_C },
          { ldx:  0,    ldy:  HALF_C },
          { ldx: -HALF_C, ldy: 0    },
          { ldx:  HALF_C, ldy: 0    },
        ];
        const wallAtEdge = EDGES_C.some(e => {
          const ex = mx + e.ldx * cGc - e.ldy * cGs;
          const ey = my + e.ldx * cGs + e.ldy * cGc;
          return this.placedStructures.some(
            w => (w.type === 'wall' || w.type === 'door_frame') &&
                 Math.abs(w.x - ex) < 3 && Math.abs(w.y - ey) < 3
          );
        });
        const adjCeiling = this.placedStructures.some(
          f => f.type === 'wood_ceiling' &&
               Math.abs(f.x - mx) >= 3 &&  // not the same tile
               Math.hypot(f.x - mx, f.y - my) < TILE * 1.1
        );
        noCeilingSupport = !wallAtEdge && !adjCeiling;
      }
    }

    // Enemy territory: any structure not belonging to the current company within 500 world px.
    // Mirrors server logic: bypassed when the placement point lies inside the player's own
    // claim area AND the player's company is the dominant claimant on this island
    // (Company Fortress > Flag Fort > older fort id). Same dominance rule used by the
    // territory overlay renderer.
    const myCompany = (this._localCompanyId ?? 0) as number;
    let inMyDominantArea = false;
    let cursorIsl = 0;
    if (myCompany > 0) {
      // Find which island the cursor is on by scanning any claim circle that
      // contains it (forts use 600px, others use 400px).
      for (const s of this.placedStructures) {
        if ((s.companyId ?? 0) === 0) continue;
        const cr = (s.type === 'flag_fort' || s.type === 'company_fortress') ? 600 : 400;
        if ((s.x - mx) * (s.x - mx) + (s.y - my) * (s.y - my) <= cr * cr) {
          cursorIsl = (s.islandId ?? 0) as number;
          if (cursorIsl !== 0) break;
        }
      }
      // Dominators-only law: I own this point iff per-pixel Render-Rule-X
      // assigns it to my company (own uncarved territory OR captured enemy
      // overlap).
      if (cursorIsl !== 0) {
        inMyDominantArea = this.pointInMyEffectiveTerritory(cursorIsl, myCompany, mx, my);
      }
    }
    const enemyTerritory = !inMyDominantArea && this.islandBuildKind !== 'claim_flag' && this.placedStructures.some(s => {
      const co = s.companyId ?? 0;
      if (co === 0 || co === myCompany) return false;
      if (s.claimOrphaned) return false;
      // Use the actual claim radius (400 for standard, 600 for forts) so the
      // placement ghost correctly mirrors the server boundary rather than an
      // arbitrary magic number.
      const cr = (s.type === 'flag_fort' || s.type === 'company_fortress') ? 600 : 400;
      return (s.x - mx) * (s.x - mx) + (s.y - my) * (s.y - my) <= cr * cr;
    });

    // Claim flag: cursor must be inside the CONTESTED AREA = intersection of
    // (any own non-orphaned claim radius) AND (any enemy non-orphaned claim radius).
    // Mirrors server-side rules in structures.c handle_place_structure.
    let cfInOwnClaim = false;
    let cfInEnemyClaim = false;
    // Closest own/enemy source structures whose claim disc covers the cursor.
    // Used to draw the slice-preview highlight matching server placement logic.
    let cfMineSrc: { x: number; y: number; r: number; islandId: number } | null = null;
    let cfEnemySrc: { x: number; y: number; r: number; islandId: number } | null = null;
    let cfMineBestD2 = 0, cfEnemyBestD2 = 0;
    if (this.islandBuildKind === 'claim_flag' && myCompany > 0) {
      for (const s of this.placedStructures) {
        if (s.claimOrphaned) continue;
        // Inactive flag forts (not complete) cannot champion a claim — match server.
        if (s.type === 'flag_fort' && !s.fortressComplete) continue;
        const co = s.companyId ?? 0;
        const cr = (s.type === 'flag_fort' || s.type === 'company_fortress') ? 600 : 400;
        const dx = s.x - mx, dy = s.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 > cr * cr) continue;
        if (co === myCompany) {
          cfInOwnClaim = true;
          if (!cfMineSrc || d2 < cfMineBestD2) {
            cfMineSrc = { x: s.x, y: s.y, r: cr, islandId: s.islandId };
            cfMineBestD2 = d2;
          }
        } else if (co !== 0) {
          cfInEnemyClaim = true;
          if (!cfEnemySrc || d2 < cfEnemyBestD2) {
            cfEnemySrc = { x: s.x, y: s.y, r: cr, islandId: s.islandId };
            cfEnemyBestD2 = d2;
          }
        }
      }
    }
    const cfNotInMyTerritory   = this.islandBuildKind === 'claim_flag' && !cfInOwnClaim;
    const cfNotInContestedArea = this.islandBuildKind === 'claim_flag' && cfInOwnClaim && !cfInEnemyClaim;
    // Slice ownership: if the cursor sits in own dominant territory (per the
    // dominators visibility), the placer already owns this slice and cannot
    // claim what they hold. Mirrors server's slice_already_owned check.
    const cfSliceAlreadyOwned  = this.islandBuildKind === 'claim_flag' && cfInOwnClaim && cfInEnemyClaim && inMyDominantArea;

    // Workbench/cannon on enemy floor: a floor exists under cursor but belongs to a different company
    const wrongCompany = (this.islandBuildKind === 'workbench' || this.islandBuildKind === 'cannon' || this.islandBuildKind === 'chest' || this.islandBuildKind === 'bed') && !noFloor &&
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
    const invalid = tooFar || waterBlocked || noFloor || bedOccupied || overlaps || blockedByTree || blockedByBoulder || enemyTerritory || wrongCompany || noEdge || wallOccupied || blockedByStructure || noDoorFrame || doorOccupied || noCeilingSupport || ceilingOccupied || cfNotInMyTerritory || cfNotInContestedArea || cfSliceAlreadyOwned;
    const cantAfford = !invalid && !this.landGhostCanAfford;
    const ghostColor  = (invalid || cantAfford) ? 'rgba(220, 60, 40, 0.45)' : 'rgba(100, 220, 100, 0.45)';
    const borderColor = (invalid || cantAfford) ? 'rgba(255, 100, 60, 0.75)' : 'rgba(120, 255, 120, 0.75)';

    // ── Claim-flag slice preview ──────────────────────────────────────────
    // When hovering with a claim_flag selected and the cursor sits in a
    // valid contested area, highlight the claimable slice — exactly the
    // shape that will be hatched after placement = lens(Mi, Ej) ∖ tmp_own,
    // where tmp_own is own company's visible territory (own discs carved by
    // their dominators). Pulses slowly. Hidden when the cursor is not on a
    // claimable slice (already-owned region, or sitting inside own's
    // visible territory).
    let cursorInOwnVisible = false;
    if (this.islandBuildKind === 'claim_flag' && myCompany > 0) {
      // Cursor is "in own visible territory" if it lies inside some own
      // structure S whose dominators do NOT cover the cursor — i.e. on the
      // own side of every dominance border at this point.
      for (const s of this.placedStructures) {
        if ((s.companyId ?? 0) !== myCompany) continue;
        if (s.claimOrphaned) continue;
        if (s.type === 'flag_fort' && !s.fortressComplete) continue;
        const r = (s.type === 'flag_fort' || s.type === 'company_fortress') ? 600 : 400;
        const dx = s.x - mx, dy = s.y - my;
        if (dx * dx + dy * dy > r * r) continue;
        let carved = false;
        for (const did of s.dominators ?? []) {
          const d = this.placedStructures.find(p => p.id === did);
          if (!d || d.claimOrphaned) continue;
          if (d.type === 'flag_fort' && !d.fortressComplete) continue;
          const dr = (d.type === 'flag_fort' || d.type === 'company_fortress') ? 600 : 400;
          const ddx = d.x - mx, ddy = d.y - my;
          if (ddx * ddx + ddy * ddy <= dr * dr) { carved = true; break; }
        }
        if (!carved) { cursorInOwnVisible = true; break; }
      }
    }
    const showSlicePreview = this.islandBuildKind === 'claim_flag'
      && !!cfMineSrc && !!cfEnemySrc
      && !cfSliceAlreadyOwned
      && !cfNotInContestedArea
      && !cfNotInMyTerritory
      && !cursorInOwnVisible;
    if (showSlicePreview && cfMineSrc && cfEnemySrc) {
      const claimRadiusOf = (t: string): number =>
        (t === 'flag_fort' || t === 'company_fortress') ? 600 : 400;
      const cvW = ctx.canvas.width, cvH = ctx.canvas.height;
      const islandId = cfMineSrc.islandId;
      const msp = camera.worldToScreen(Vec2.from(mx, my));
      const previewInvalid = false; // hidden when invalid
      const fillCol   = previewInvalid ? 'rgba(220, 60, 40, 1)' : 'rgba(120, 220, 120, 1)';
      // Slow flash: ~2.4s period.
      const t = performance.now() / 1200;
      const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI);
      const fillAlpha   = 0.12 + 0.32 * pulse;

      // ── Build section mask ─────────────────────────────────────────────
      // 1) lensUnion = ⋃ over all (Mi, Ej) pairs on this island whose discs
      //    overlap: lens(Mi, Ej) = Mi.disc ∩ Ej.disc.
      // 2) tmp_own  = ⋃ over own structures of (S.disc ∖ ⋃ dominators).
      // 3) sliceAll = lensUnion ∖ tmp_own  (all claimable slice pieces).
      // 4) section   = connected component of sliceAll containing the cursor
      //    pixel, found via JS flood-fill on the alpha channel.

      const ownStructs:   typeof this.placedStructures = [];
      const enemyStructs: typeof this.placedStructures = [];
      for (const s of this.placedStructures) {
        if (s.claimOrphaned) continue;
        if (s.islandId !== islandId) continue;
        if (s.type === 'flag_fort' && !s.fortressComplete) continue;
        const co = s.companyId ?? 0;
        if (co === 0) continue;
        if (co === myCompany) ownStructs.push(s);
        else enemyStructs.push(s);
      }

      // (a) Lens union
      const lensUnion = this._getScratch('cfSecLensU', cvW, cvH);
      const lu = lensUnion.getContext('2d')!;
      lu.clearRect(0, 0, cvW, cvH);
      const lensTmp = this._getScratch('cfSecLensT', cvW, cvH);
      const lt = lensTmp.getContext('2d')!;
      for (const mi of ownStructs) {
        const miR = claimRadiusOf(mi.type);
        const miSp = camera.worldToScreen(Vec2.from(mi.x, mi.y));
        const miRz = miR * zoom;
        for (const ej of enemyStructs) {
          const ejR = claimRadiusOf(ej.type);
          const sum = miR + ejR;
          const dx = mi.x - ej.x, dy = mi.y - ej.y;
          if (dx * dx + dy * dy >= sum * sum) continue; // discs disjoint
          const ejSp = camera.worldToScreen(Vec2.from(ej.x, ej.y));
          lt.globalCompositeOperation = 'source-over';
          lt.clearRect(0, 0, cvW, cvH);
          lt.fillStyle = '#fff';
          lt.beginPath(); lt.arc(miSp.x, miSp.y, miRz, 0, Math.PI * 2); lt.fill();
          lt.globalCompositeOperation = 'destination-in';
          lt.beginPath(); lt.arc(ejSp.x, ejSp.y, ejR * zoom, 0, Math.PI * 2); lt.fill();
          lu.drawImage(lensTmp, 0, 0);
        }
      }

      // (b) tmp_own (own visible territory)
      const tmpOwn = this._getScratch('cfSecTmpOwn', cvW, cvH);
      const tc = tmpOwn.getContext('2d')!;
      tc.clearRect(0, 0, cvW, cvH);
      const blob = this._getScratch('cfSecBlob', cvW, cvH);
      const bc = blob.getContext('2d')!;
      for (const s of ownStructs) {
        const r = claimRadiusOf(s.type) * zoom;
        if (r <= 0) continue;
        const sp = camera.worldToScreen(Vec2.from(s.x, s.y));
        bc.globalCompositeOperation = 'source-over';
        bc.clearRect(0, 0, cvW, cvH);
        bc.fillStyle = '#fff';
        bc.beginPath(); bc.arc(sp.x, sp.y, r, 0, Math.PI * 2); bc.fill();
        const doms = s.dominators ?? [];
        if (doms.length > 0) {
          bc.globalCompositeOperation = 'destination-out';
          for (const did of doms) {
            const d = this.placedStructures.find(p => p.id === did);
            if (!d || d.claimOrphaned) continue;
            if (d.type === 'flag_fort' && !d.fortressComplete) continue;
            const dr = claimRadiusOf(d.type) * zoom;
            const dsp = camera.worldToScreen(Vec2.from(d.x, d.y));
            bc.beginPath(); bc.arc(dsp.x, dsp.y, dr, 0, Math.PI * 2); bc.fill();
          }
        }
        tc.drawImage(blob, 0, 0);
      }

      // (c) sliceAll = lensUnion ∖ tmp_own
      lu.globalCompositeOperation = 'destination-out';
      lu.drawImage(tmpOwn, 0, 0);
      lu.globalCompositeOperation = 'source-over';

      // (d) Flood-fill section from cursor pixel at downsampled resolution
      // (~4 world units per cell). We operate on the canvas-space mask so
      // we sample at zoom-dependent stride.
      const cellWorld = 4;
      const cellPx = Math.max(1, Math.round(cellWorld * zoom));
      const gw = Math.max(1, Math.floor(cvW / cellPx));
      const gh = Math.max(1, Math.floor(cvH / cellPx));
      // Read alpha at grid cell centres
      const img = lu.getImageData(0, 0, cvW, cvH).data;
      const inSlice = new Uint8Array(gw * gh);
      for (let gy = 0; gy < gh; gy++) {
        const py = Math.min(cvH - 1, (gy + 0.5) * cellPx | 0);
        for (let gx = 0; gx < gw; gx++) {
          const px = Math.min(cvW - 1, (gx + 0.5) * cellPx | 0);
          const idx = (py * cvW + px) * 4 + 3;
          if (img[idx] > 8) inSlice[gy * gw + gx] = 1;
        }
      }
      const cgx = Math.max(0, Math.min(gw - 1, Math.floor(msp.x / cellPx)));
      const cgy = Math.max(0, Math.min(gh - 1, Math.floor(msp.y / cellPx)));
      const section = new Uint8Array(gw * gh);
      if (inSlice[cgy * gw + cgx]) {
        const stack: number[] = [cgy * gw + cgx];
        section[cgy * gw + cgx] = 1;
        while (stack.length) {
          const k = stack.pop()!;
          const x = k % gw, y = (k / gw) | 0;
          if (x > 0) {
            const n = k - 1;
            if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); }
          }
          if (x < gw - 1) {
            const n = k + 1;
            if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); }
          }
          if (y > 0) {
            const n = k - gw;
            if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); }
          }
          if (y < gh - 1) {
            const n = k + gw;
            if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); }
          }
        }
      }

      // (e) Build a section mask canvas by drawing each cell of `section`
      //     as a filled rect at cell resolution, then intersecting with the
      //     true sliceAll mask so the boundary stays smooth.
      const sectionGrid = this._getScratch('cfSecGrid', cvW, cvH);
      const sg = sectionGrid.getContext('2d')!;
      sg.clearRect(0, 0, cvW, cvH);
      sg.fillStyle = '#fff';
      // Group runs along x to reduce fillRect count
      for (let gy = 0; gy < gh; gy++) {
        let runStart = -1;
        for (let gx = 0; gx <= gw; gx++) {
          const on = gx < gw && !!section[gy * gw + gx];
          if (on && runStart < 0) runStart = gx;
          else if (!on && runStart >= 0) {
            sg.fillRect(runStart * cellPx, gy * cellPx, (gx - runStart) * cellPx, cellPx);
            runStart = -1;
          }
        }
      }
      // Dilate grid by 1 cell to make sure the smooth slice mask is fully
      // covered where the section is on. Done implicitly by intersecting:
      const sectionMask = this._getScratch('cfSecMask', cvW, cvH);
      const smc = sectionMask.getContext('2d')!;
      smc.clearRect(0, 0, cvW, cvH);
      smc.drawImage(lu.canvas, 0, 0);
      smc.globalCompositeOperation = 'destination-in';
      smc.drawImage(sectionGrid, 0, 0);
      smc.globalCompositeOperation = 'source-over';

      // (f) Tint and draw with pulse.
      const tint = this._getScratch('cfSecTint', cvW, cvH);
      const tnc = tint.getContext('2d')!;
      tnc.clearRect(0, 0, cvW, cvH);
      tnc.fillStyle = fillCol;
      tnc.fillRect(0, 0, cvW, cvH);
      tnc.globalCompositeOperation = 'destination-in';
      tnc.drawImage(sectionMask, 0, 0);

      ctx.save();
      ctx.globalAlpha = fillAlpha;
      ctx.drawImage(tint, 0, 0);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.72 + 0.14 * Math.sin(performance.now() / 300);
    // Apply rotation around ghost centre
    const WALL_THICK = 0.18;
    const isWallOrDoor = this.islandBuildKind === 'wall' || this.islandBuildKind === 'door_frame' || this.islandBuildKind === 'door';
    const buildKind    = this.islandBuildKind as string;
    const isRotatable  = buildKind === 'wooden_floor' || buildKind === 'workbench' || buildKind === 'shipyard' || buildKind === 'wood_ceiling' || buildKind === 'cannon' || buildKind === 'bed';
    const ghostRotRad  = isWallOrDoor ? this._wallGhostRotRad
                       : isRotatable ? effectiveRotDeg * Math.PI / 180 : 0;
    if (ghostRotRad !== 0 || camRot !== 0) {
      ctx.translate(msp.x, msp.y);
      ctx.rotate(ghostRotRad - camRot);
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
                 : this.islandBuildKind === 'wood_ceiling' ? sz * 0.9  // slightly smaller to distinguish
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
    } else if (this.islandBuildKind === 'cannon') {
      // Ghost shaped like ship cannon: brown base + dark barrel pointing up
      ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(2, 3 * zoom)]);
      // Base
      ctx.fillRect(msp.x - 15 * zoom, msp.y - 10 * zoom, 30 * zoom, 20 * zoom);
      ctx.strokeRect(msp.x - 15 * zoom, msp.y - 10 * zoom, 30 * zoom, 20 * zoom);
      // Barrel
      ctx.beginPath();
      ctx.rect(msp.x - 8 * zoom, msp.y - 40 * zoom, 16 * zoom, 40 * zoom);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (this.islandBuildKind === 'claim_flag') {
      // Ghost shaped like a flag pole with a pennant
      const poleH = sz / 2;
      const poleW = Math.max(2, 4 * zoom);
      const flagW = Math.max(6, 16 * zoom);
      const flagH = Math.max(4, 10 * zoom);
      ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(2, 3 * zoom)]);
      // Pole (from center up to ghostH/2)
      ctx.fillRect(msp.x - poleW / 2, msp.y - poleH, poleW, poleH);
      ctx.strokeRect(msp.x - poleW / 2, msp.y - poleH, poleW, poleH);
      // Pennant triangle at pole top
      ctx.beginPath();
      ctx.moveTo(msp.x + poleW / 2, msp.y - poleH);
      ctx.lineTo(msp.x + poleW / 2 + flagW, msp.y - poleH + flagH / 2);
      ctx.lineTo(msp.x + poleW / 2, msp.y - poleH + flagH);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (this.islandBuildKind === 'flag_fort') {
      // Ghost shaped like a flag fort: stone square base with battlements on top edge
      const ts = sz * 0.9;
      ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(2, 3 * zoom)]);
      // Base square
      ctx.fillRect(msp.x - ts / 2, msp.y - ts / 2, ts, ts);
      ctx.strokeRect(msp.x - ts / 2, msp.y - ts / 2, ts, ts);
      // Battlements — 3 merlons along top edge
      const mw = ts * 0.22, mh = ts * 0.22;
      ctx.setLineDash([]);
      for (let m = -1; m <= 1; m++) {
        const bx = msp.x + m * ts * 0.3 - mw / 2;
        const by = msp.y - ts / 2 - mh;
        ctx.fillRect(bx, by, mw, mh);
        ctx.strokeRect(bx, by, mw, mh);
      }
      // Flag pole
      ctx.beginPath();
      ctx.moveTo(msp.x + ts * 0.08, msp.y - ts / 2);
      ctx.lineTo(msp.x + ts * 0.08, msp.y - ts / 2 - ts * 0.75);
      ctx.stroke();
      // Flag pennant
      ctx.beginPath();
      ctx.moveTo(msp.x + ts * 0.08, msp.y - ts / 2 - ts * 0.75);
      ctx.lineTo(msp.x + ts * 0.08 + ts * 0.4, msp.y - ts / 2 - ts * 0.55);
      ctx.lineTo(msp.x + ts * 0.08, msp.y - ts / 2 - ts * 0.35);
      ctx.closePath();
      ctx.fill();
    } else if (this.islandBuildKind === 'chest') {
      // Ghost shaped like a wooden chest (lid + base + latch)
      const bw = sz * 0.80, bh = sz * 0.56;
      const lidH = bh * 0.40;
      ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(2, 3 * zoom)]);
      // Base body
      ctx.fillRect(msp.x - bw / 2, msp.y - bh / 2 + lidH, bw, bh - lidH);
      ctx.strokeRect(msp.x - bw / 2, msp.y - bh / 2 + lidH, bw, bh - lidH);
      // Lid
      ctx.fillRect(msp.x - bw / 2, msp.y - bh / 2, bw, lidH + 2);
      ctx.strokeRect(msp.x - bw / 2, msp.y - bh / 2, bw, lidH + 2);
      ctx.setLineDash([]);
      // Latch
      const latchW = bw * 0.20, latchH = bh * 0.22;
      ctx.fillRect(msp.x - latchW / 2, msp.y - bh / 2 + lidH - latchH / 2, latchW, latchH);
      ctx.strokeRect(msp.x - latchW / 2, msp.y - bh / 2 + lidH - latchH / 2, latchW, latchH);
    } else if (this.islandBuildKind === 'bed') {
      const bw = sz * 0.88, bh = sz * 0.48;
      ctx.setLineDash([Math.max(2, 4 * zoom), Math.max(2, 3 * zoom)]);
      ctx.beginPath();
      ctx.roundRect(msp.x - bw / 2, msp.y - bh / 2, bw, bh, 3);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(200,160,232,0.55)';
      ctx.beginPath();
      ctx.roundRect(msp.x - bw / 2 + 2, msp.y - bh / 2 + 2, bw * 0.32, bh - 4, 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(119,85,170,0.55)';
      ctx.fillRect(msp.x - bw / 2 + bw * 0.34, msp.y - bh / 2 + 2, bw * 0.54, bh - 4);
    } else {
      ctx.beginPath();
      ctx.rect(msp.x - ghostW / 2, msp.y - ghostH / 2, ghostW, ghostH);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Label above the ghost — for flag_fort and chest, account for their actual top extent
    const labelTopOffset = this.islandBuildKind === 'flag_fort' ? sz * 0.9 * 0.5 + sz * 0.9 * 0.22 + 6
                         : this.islandBuildKind === 'chest' ? sz * 0.56 / 2 + 6
                         : this.islandBuildKind === 'bed' ? sz * 0.48 / 2 + 6
                         : ghostH / 2 + 6;
    const labelY = msp.y - labelTopOffset;
    ctx.globalAlpha = 1;
    ctx.font = `bold ${Math.max(10, Math.round(12 * zoom))}px Georgia, serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    if (waterBlocked) {
      ctx.fillStyle = '#4488ff';
      ctx.fillText('IN WATER', msp.x, labelY);
    } else if (enemyTerritory) {
      ctx.fillStyle = '#ff3333';
      ctx.fillText('ENEMY TERRITORY', msp.x, labelY);
    } else if (blockedByTree || blockedByBoulder) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('BLOCKED', msp.x, labelY);
    } else if (blockedByStructure) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('BLOCKED BY STRUCTURE', msp.x, labelY);
    } else if (overlaps || wallOccupied || doorOccupied || ceilingOccupied || bedOccupied) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('OCCUPIED', msp.x, labelY);
    } else if (noCeilingSupport) {
      ctx.fillStyle = '#ff6644';
      ctx.fillText('NEEDS WALL OR CEILING', msp.x, labelY);
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
    } else if (cfNotInMyTerritory) {
      ctx.fillStyle = '#ff3333';
      ctx.fillText('NOT IN YOUR TERRITORY', msp.x, labelY);
    } else if (cfNotInContestedArea) {
      ctx.fillStyle = '#ff3333';
      ctx.fillText('ALREADY OWNED', msp.x, labelY);
    } else if (cfSliceAlreadyOwned) {
      ctx.fillStyle = '#ff3333';
      ctx.fillText('ALREADY OWNED', msp.x, labelY);
    } else if (cantAfford) {
      ctx.fillStyle = '#ff4444';
      ctx.fillText('Insufficient Resources', msp.x, labelY);
    } else {
      ctx.fillStyle = '#aaffaa';
      const label = this.islandBuildKind === 'wooden_floor' ? 'Wooden Floor'
                  : this.islandBuildKind === 'wall' ? 'Wall  [T] Door Frame'
                  : this.islandBuildKind === 'door_frame' ? 'Door Frame  [T] Wall'
                  : this.islandBuildKind === 'door' ? 'Door'
                  : this.islandBuildKind === 'wood_ceiling' ? 'Wood Ceiling'
                  : this.islandBuildKind === 'cannon' ? 'Cannon'
                  : this.islandBuildKind === 'flag_fort' ? 'Flag Fort'
                  : this.islandBuildKind === 'company_fortress' ? 'Company Fortress'
                  : this.islandBuildKind === 'claim_flag' ? 'Claim Flag — Contested Area'
                  : this.islandBuildKind === 'chest' ? 'Chest'
                  : this.islandBuildKind === 'bed' ? 'Bed'
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
    const _localCarrierId = this._cachedLocalPlayer?.carrierId ?? 0;

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

    // ── Ship wake trail history sampling/pruning ───────────────────────────
    const wakeNow = performance.now();
    const wakeCutoff = wakeNow - this.SHIP_WAKE_TRAIL_DURATION_MS;
    for (const ship of worldState.ships) {
      if (ship.shipType === SHIP_TYPE_GHOST) continue;
      if (ship.id !== _localCarrierId
          && !this.fogVisibleAt(ship.position.x, ship.position.y, this._hullRadius(ship))) continue;
      const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
      if (speed < 6) continue;

      const lastEmit = this.shipWakeLastEmit.get(ship.id) ?? 0;
      if (wakeNow - lastEmit < this.SHIP_WAKE_TRAIL_SPACING_MS) continue;

      let trail = this.shipWakeTrails.get(ship.id);
      if (!trail) {
        trail = [];
        this.shipWakeTrails.set(ship.id, trail);
      }

      const prev = trail.length > 0 ? trail[trail.length - 1] : null;
      const movedEnough = !prev || Math.hypot(ship.position.x - prev.x, ship.position.y - prev.y) >= this.SHIP_WAKE_TRAIL_MIN_DIST;
      if (movedEnough) {
        // Store ship center + rotation; cr/sr pre-computed once so the render
        // loop never calls Math.cos(r) / Math.sin(r) again for this point.
        trail.push({ x: ship.position.x, y: ship.position.y, r: ship.rotation, t: wakeNow,
                     cr: Math.cos(ship.rotation), sr: Math.sin(ship.rotation) });
        this.shipWakeLastEmit.set(ship.id, wakeNow);
      }

      let start = 0;
      while (start < trail.length && trail[start].t < wakeCutoff) start++;
      if (start > 0) trail.splice(0, start);
    }

    // Remove history for ships that no longer exist in the live world set.
    for (const id of this.shipWakeTrails.keys()) {
      if (!currentShipIds.has(id)) {
        this.shipWakeTrails.delete(id);
        this.shipWakeLastEmit.delete(id);
      }
    }
    // Evict hull-radius cache entries for ships that have left the world.
    for (const id of this._hullRadiusCache.keys()) {
      if (!currentShipIds.has(id)) this._hullRadiusCache.delete(id);
    }
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

    // Visual-only wrap ghosts for seam visibility.
    // Canonical world objects remain unchanged for collisions and gameplay.
    // Filter ships by fog visibility. The carrier ship (if any) is always included
    // so the player never loses their own ship when at the fog boundary.
    const renderShips = this.buildWrappedRenderCopies(
      this._collectFogVisibleShips(worldState.ships, _localCarrierId, camera),
      camera, 520
    );
    const renderPlayers = this.buildWrappedRenderCopies(
      this._collectVisiblePlayers(worldState.players, camera),
      camera,
      80,
      (p) => p.id === this.localPlayerId,
    );
    const renderCannonballs = this.buildWrappedRenderCopies(
      this._collectVisibleCannonballs(worldState.cannonballs, camera),
      camera, 40,
    );
    
    // Render order (from lowest to highest):
    // 0: water, gridlines (drawn before this queue)
    // 1: ship hull
    // 2: players
    // 3: ship planks
    // 4: cannons
    // 5: steering wheels
    // 6: sail fibers
    // 7: sail masts
    
    // Deck-level state machine: fall through empty holes, climb back up via ramp modules
    this._lowerDeckShipId = null;
    {
      const _prevDeckLevel = this._playerDeckLevel;
      const _lp = renderPlayers.find(p => p.id === this.localPlayerId);
      if (_lp && _lp.carrierId !== 0) {
        const _cs = renderShips.find(s => s.id === _lp.carrierId);
        // Only run the fall-through state machine when there is an INTACT upper deck
        // (health > 0). A destroyed deck (health=0) is kept in ship.modules but should
        // be treated as absent — the ship reverts to a single-deck hull.
        if (_cs && _cs.modules.some(m => m.kind === 'deck' && m.deckId === 1 && (m.health === undefined || m.health > 0))) {
          // Player ship-local position — prefer localPosition (seeded from the server's
          // local_x / local_y and kept current by the prediction engine) over re-deriving
          // from the world-space round-trip (world_pos - ship_pos → rotate), which
          // introduces an extra floating-point conversion and can be slightly stale when
          // the ship is rotating.  Falling back to world-pos conversion when localPosition
          // is absent (e.g. swimming player) keeps behaviour correct.
          let _lx: number;
          let _ly: number;
          if (_lp.localPosition) {
            _lx = _lp.localPosition.x;
            _ly = _lp.localPosition.y;
          } else {
            const _dx = _lp.position.x - _cs.position.x;
            const _dy = _lp.position.y - _cs.position.y;
            const _cos = Math.cos(-_cs.rotation);
            const _sin = Math.sin(-_cs.rotation);
            _lx = _dx * _cos - _dy * _sin;
            _ly = _dx * _sin + _dy * _cos;
          }

          // Detection radius around each snap-point (px in ship-local).
          // Fall zone: 22 px — matches server FALL_ZONE.
          // Climb zone: 28 px — matches server CLIMB_ZONE (widened to absorb server/client drift).
          const _FALL_ZONE  = 22;
          const _CLIMB_ZONE = 28;

          const _inBoardingGrace = (performance.now() - this._boardedAtMs) < this._BOARD_GRACE_MS;

          // During the post-boarding grace window trust the server/prediction deck and
          // skip ramp detection entirely — a reconnect spawn on the lower deck near a
          // ramp would otherwise false-trigger a climb to the upper deck visually.
          if (_inBoardingGrace) {
            const _authDeck = (_lp.deckId ?? 1) === 0 ? 0 : 1;
            if (this._playerDeckLevel !== _authDeck) {
              this._playerDeckLevel = _authDeck;
            }
          } else if (this._playerDeckLevel === 1) {
            // Upper deck — fall through empty holes, or enter a ramp from its top (light) face
            const falling = RenderSystem.RAMP_SNAP_POINTS.some(sp => {
              const drx = _lx - sp.x, dry = _ly - sp.y;
              if (Math.abs(drx) >= _FALL_ZONE || Math.abs(dry) >= _FALL_ZONE) return false;
              // Hatch cover blocks any fall-through
              const hatchMod = _cs.modules.find(
                m => m.kind === 'hatch_cover' && Math.abs(m.localPos.x - sp.x) < 20 && Math.abs(m.localPos.y - sp.y) < 20
              );
              if (hatchMod) return false;
              const rampMod = _cs.modules.find(
                m => m.kind === 'ramp' && Math.abs(m.localPos.x - sp.x) < 20 && Math.abs(m.localPos.y - sp.y) < 20
              );
              if (!rampMod) return true; // empty hole — always fall
              // With ramp: only descend from the top/light face (ramp-local x > 0)
              const rlx = drx * Math.cos(-rampMod.localRot) - dry * Math.sin(-rampMod.localRot);
              return rlx > 0;
            });
            if (falling) this._playerDeckLevel = 0;
          }

          if (!_inBoardingGrace && this._playerDeckLevel === 0) {
            // Lower deck — climb back up via the bottom/dark face of a ramp.
            // Use CLIMB_ZONE (28) which is wider than FALL_ZONE (22) to absorb the server/client
            // position drift of up to ~10 px (one movement tick + sub-tick accumulation).
            // The face threshold is relaxed to rlx < 12 (mirrors server rlx < 12.0f) so a
            // slightly ahead server position still allows the climb to succeed.
            const climbing = RenderSystem.RAMP_SNAP_POINTS.some(sp => {
              const drx = _lx - sp.x, dry = _ly - sp.y;
              if (Math.abs(drx) >= _CLIMB_ZONE || Math.abs(dry) >= _CLIMB_ZONE) return false;
              const rampMod = _cs.modules.find(
                m => m.kind === 'ramp' && Math.abs(m.localPos.x - sp.x) < 20 && Math.abs(m.localPos.y - sp.y) < 20
              );
              if (!rampMod) return false;
              // Climb from the bottom/dark face; threshold relaxed to rlx < 12 to match server.
              const rlx = drx * Math.cos(-rampMod.localRot) - dry * Math.sin(-rampMod.localRot);
              return rlx < 12;
            });
            if (climbing) {
              this._playerDeckLevel = 1;
            } else {
              this._lowerDeckShipId = _cs.id;
            }
          }
        } else {
          // No upper deck on this ship — reset to surface
          this._playerDeckLevel = 1;
        }
      } else {
        // Not on a ship — reset to surface
        this._playerDeckLevel = 1;
      }

      // Notify server when the level changed (so per-deck collision filter stays in sync)
      if (this._playerDeckLevel !== _prevDeckLevel && this.onDeckLevelChange) {
        this.onDeckLevelChange(this._playerDeckLevel);
      }
    }

    const _camZoom = camera.getState().zoom;

    // Queue ship wakes + hulls (layer 1)
    for (const ship of renderShips) {
      this.queueRenderItem(1, 'ship-wake', () => this.drawShipWake(ship, camera), -2);
      if (!this._canUseShipStaticComposite(ship, _camZoom)) {
        this.queueRenderItem(1, 'ship-hull', () => this.drawShipHull(ship, camera));
      }
      this.queueRenderItem(1, `lower-deck-floor-${ship.id}`, () => this.drawLowerDeckFloor(ship, camera), 1);
      // Ghost fog aura: drawn at layer 0.5 (below hull, like water surface wisps)
      if (ship.shipType === SHIP_TYPE_GHOST) {
        this.queueRenderItem(1, `ghost-fog-${ship.id}`, () => this.drawGhostFogAura(ship, camera), -1);
      }
      // Scaffolding clamps & ropes for ships under construction in a shipyard
      const scaffold = this._scaffoldedShips.get(ship.id);
      if (scaffold) {
        this.queueRenderItem(1, `scaffold-vis-${ship.id}`, () => this.drawScaffoldingVisuals(ship, scaffold, camera), 1);
      }
      // Gunport doors: layer 1 priority 4 (above lower-deck cannons at prio 3).
      // Only queued when the player is on this ship's lower deck — the upper-deck
      // cover at layer 2 hides them from any other viewpoint.
      if (this._lowerDeckShipId === ship.id) {
        this.queueRenderItem(1, `gunports-${ship.id}`, () => this.drawGunportOverlays(ship, camera), 4);
      }
      // Upper-deck cover: solid hull fill at layer 2 — paints over lower-deck cannons,
      // gunports, and any other layer-1 content so nothing bleeds through plank gaps.
      // Skipped when the L3 static composite draws hull+planks (would double the deck).
      if (ship.shipType !== SHIP_TYPE_GHOST
          && ship.modules.some(m => m.kind === 'deck' && m.deckId === 1)
          && this._lowerDeckShipId !== ship.id
          && !this._canUseShipStaticComposite(ship, _camZoom)) {
        this.queueRenderItem(2, `upper-deck-cover-${ship.id}`, () => this.drawUpperDeckCover(ship, camera));
      }
    }
    
    // Queue players (layer 2 normally; layer 3 priority 5 when in shipyard build mode
    // so the local player renders above placed planks/modules)
    const inBuildMode = this.buildMode || this.cannonBuildMode || this.mastBuildMode
                     || this.swivelBuildMode || this.helmBuildMode || this.deckBuildMode;
    for (const player of renderPlayers) {
      const isLocal = player.id === this.localPlayerId;
      // Also render above planks when on a scaffolded ship (building in shipyard) even without explicit build mode
      const onScaffoldedShip = isLocal && player.carrierId !== 0 && this._scaffoldedShips.has(player.carrierId);
      const onLowerDeck = isLocal && this._lowerDeckShipId !== null;
      if (isLocal && (inBuildMode || onScaffoldedShip)) {
        this.queueRenderItem(3, 'players', () => this.drawPlayer(player, worldState, camera), 5);
      } else if (onLowerDeck) {
        // Player is on the lower deck — render below planks, clipped to hull polygon
        const _cs = renderShips.find(s => s.id === this._lowerDeckShipId);
        if (_cs) {
          this.queueRenderItem(1, 'players', () => this._drawPlayerWithHullClip(player, _cs, worldState, camera), 2);
        } else {
          this.queueRenderItem(1, 'players', () => this.drawPlayer(player, worldState, camera), 2);
        }
      } else {
        // Deck-aware layering: lower deck → layer 1 (under planks); upper deck → layer 4 (above planks)
        // For local player use _playerDeckLevel; for others use deckId. Off-ship (swimming) use layer 2.
        const _onShip = player.carrierId !== 0;
        const _deckLevel = isLocal ? this._playerDeckLevel : (player.deckId ?? 1);
        if (_onShip && _deckLevel === 0) {
          this.queueRenderItem(1, 'players', () => this.drawPlayer(player, worldState, camera), 2);
        } else if (_onShip) {
          this.queueRenderItem(4, 'players', () => this.drawPlayer(player, worldState, camera), 2);
        } else {
          this.queueRenderItem(2, 'players', () => this.drawPlayer(player, worldState, camera));
        }
      }
    }
    
    // Queue ship planks (layer 3 — ghost ships have no physical planks, purely hull-fade driven)
    for (const ship of renderShips) {
      if (ship.shipType !== SHIP_TYPE_GHOST) {
        if (this._canUseShipStaticComposite(ship, _camZoom)) {
          this.queueRenderItem(3, `ship-static-${ship.id}`, () => this.drawShipStaticComposite(ship, camera));
        } else {
          this.queueRenderItem(3, 'ship-planks', () => this.drawShipPlanks(ship, camera));
        }
        this.queueRenderItem(3, `deck-flood-${ship.id}`, () => this.drawShipDeckFloodOverlays(ship, camera), 2);
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
    for (const ship of renderShips) {
      const _da = (fn: () => void): (() => void) => this._lowerDeckShipId === ship.id
        ? () => { this.ctx.save(); this.ctx.globalAlpha *= this._upperDeckFade; fn(); this.ctx.restore(); } : fn;
      this.queueRenderItem(3, 'plank-status', _da(() => this.drawPlankStatusIcons(ship, camera)), 2);
    }

    // Grapple ropes/hooks/charge aim — layer 4 above planks and deck cover
    for (const player of renderPlayers) {
      if (player.health <= 0) continue;
      const _hasGrappleVis =
        ((player.grappleState ?? 0) > 0 && player.grappleX !== undefined && player.grappleY !== undefined)
        || (player.id === this.localPlayerId && this.grappleChargeProgress > 0);
      if (_hasGrappleVis) {
        this.queueRenderItem(4, `grapple-${player.id}`, () => this.drawPlayerGrappleVisuals(player, worldState, camera), 8);
      }
    }

    // Burning module fire overlays — drawn above module graphics
    for (const ship of renderShips) {
      const _da = (fn: () => void): (() => void) => this._lowerDeckShipId === ship.id
        ? () => { this.ctx.save(); this.ctx.globalAlpha *= this._upperDeckFade; fn(); this.ctx.restore(); } : fn;
      this.queueRenderItem(4, `fire-modules-${ship.id}`, _da(() => this.drawBurningModules(ship, camera)), 5);
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

    // Gunport cannon ghosts and fixed broadside slot ghosts — only shown in cannon build mode.
    if (this.cannonBuildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(4, `cannon-ghosts-gp-${ship.id}`, () => this.drawMissingCannonGhosts(ship, camera, true), 1);
        this.queueRenderItem(4, `cannon-ghosts-${ship.id}`, () => this.drawMissingCannonGhosts(ship, camera), 1);
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

    // In ramp or hatch build mode, overlay ghost outlines at snap points (layer 3)
    if (this.rampBuildMode || this.hatchBuildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(3, `ramp-ghost-${ship.id}`, () => this.drawRampSnapGhosts(ship, camera), 0);
      }
    }

    // In gunport build mode, overlay ghost outlines at gunport snap points (layer 3)
    if (this.gunportBuildMode) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(3, `gunport-ghost-${ship.id}`, () => this.drawGunportSnapGhosts(ship, camera), 0);
      }
    }

    // In chest build mode, overlay a ghost chest at the cursor position on each ship (layer 4)
    if (this.chestBuildMode && this.mouseWorldPos) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(4, `chest-ghost-${ship.id}`, () => this.drawChestGhostOnShip(ship, camera), 0);
      }
    }

    // In bed build mode, overlay a ghost bed at the cursor position on each ship (layer 4)
    if (this.bedBuildMode && this.mouseWorldPos) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(4, `bed-ghost-${ship.id}`, () => this.drawBedGhostOnShip(ship, camera), 0);
      }
    }

    if (this.wellBuildMode && this.mouseWorldPos && this._playerDeckLevel === 0) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(4, `well-ghost-${ship.id}`, () => this.drawWellGhostOnShip(ship, camera), 0);
      }
    }

    // In workbench build mode, overlay a ghost workbench at the cursor position on each ship (layer 4)
    if (this.workbenchBuildMode && this.mouseWorldPos) {
      for (const ship of worldState.ships) {
        this.queueRenderItem(4, `workbench-ghost-${ship.id}`, () => this.drawWorkbenchGhostOnShip(ship, camera), 0);
      }
    }

    for (const ship of renderShips) {
      const _da = (fn: () => void): (() => void) => this._lowerDeckShipId === ship.id
        ? () => { this.ctx.save(); this.ctx.globalAlpha *= this._upperDeckFade; fn(); this.ctx.restore(); } : fn;
      // Lower-deck modules (deckId=0): hull-clipped at layer 1 so they render below planks.
      // Full opacity — the planks at layer 3 cover them naturally when the player is on the upper deck.
      this.queueRenderItem(1, `cannons-lower-${ship.id}`,  () => this.drawShipCannons(ship, camera, 0), 3);
      this.queueRenderItem(1, `swivels-lower-${ship.id}`,  () => this.drawShipSwivelGuns(ship, camera, 0), 3);
      this.queueRenderItem(1, `chests-lower-${ship.id}`,   () => this.drawShipChests(ship, camera, 0), 3);
      this.queueRenderItem(1, `beds-lower-${ship.id}`,     () => this.drawShipBeds(ship, camera, 0), 3);
      this.queueRenderItem(1, `wells-lower-${ship.id}`,    () => this.drawShipWells(ship, camera, 0), 3);
      this.queueRenderItem(1, `workbenches-lower-${ship.id}`, () => this.drawShipWorkbenches(ship, camera, 0), 3);
      // Upper-deck + deck-independent modules at their normal layers.
      this.queueRenderItem(4, `cannons-upper-${ship.id}`, _da(() => this.drawShipCannons(ship, camera, 1)));
      this.queueRenderItem(4, `swivel-guns-upper-${ship.id}`, _da(() => this.drawShipSwivelGuns(ship, camera, 1)));
      this.queueRenderItem(4, `cannon-aim-guides-${ship.id}`, _da(() => this.drawCannonAimGuides(ship, worldState, camera)), 1);
      this.queueRenderItem(4, `swivel-aim-guides-${ship.id}`, _da(() => this.drawSwivelAimGuide(ship, worldState, camera)), 1);
      this.queueRenderItem(4, `chests-upper-${ship.id}`, _da(() => this.drawShipChests(ship, camera, 1)));
      this.queueRenderItem(4, `beds-upper-${ship.id}`, _da(() => this.drawShipBeds(ship, camera, 1)));
      this.queueRenderItem(4, `workbenches-upper-${ship.id}`, _da(() => this.drawShipWorkbenches(ship, camera, 1)));
      this.queueRenderItem(4, `rudder-${ship.id}`, _da(() => this.drawShipRudder(ship, camera)));
      if ((this.showGroupOverlay || this.activeWeaponGroups.size > 0) && this.controlGroups) {
        // Always render at full opacity so active groups remain visible from the steering wheel.
        this.queueRenderItem(5, `cannon-groups-${ship.id}`, () => this.drawCannonGroupOverlay(ship, camera));
      }
      // Reload indicators always drawn above group overlay (layer 6)
      this.queueRenderItem(6, `cannon-reload-${ship.id}`, _da(() => this.drawCannonReloadIndicators(ship, camera)));
      this.queueRenderItem(5, `steering-wheels-${ship.id}`, _da(() => this.drawShipSteeringWheels(ship, camera)));
      this.queueRenderItem(5, `ladders-${ship.id}`, _da(() => this.drawShipLadders(ship, camera)));
      if (ship.shipType !== SHIP_TYPE_GHOST) {
        this.queueRenderItem(5, `sail-ropes-${ship.id}`, _da(() => this.drawShipSailRopes(ship, camera)));
      }
    }

    // Island cannon trajectory guide (same layer as ship cannon aim guides)
    if (this.islandCannonId !== null && this.islandCannonAimAngle !== null && this.playerIsAiming) {
      this.queueRenderItem(4, 'island-cannon-trajectory', () => this.drawIslandCannonTrajectory(camera), 1);
    }
    
    // Queue sail fibers (layer 6)
    for (const ship of renderShips) {
      if (ship.shipType === SHIP_TYPE_GHOST) continue;
      const _da = (fn: () => void): (() => void) => this._lowerDeckShipId === ship.id
        ? () => { this.ctx.save(); this.ctx.globalAlpha *= this._upperDeckFade; fn(); this.ctx.restore(); } : fn;
      this.queueRenderItem(6, 'sail-fibers', _da(() => this.drawShipSailFibers(ship, camera)));
    }

    // Queue island cannon reload indicators at layer 6 — same z-level as ship cannon reload
    if (this.placedStructures.some(s => s.type === 'cannon' && (s.cannonReloadMs ?? 0) > 0)) {
      this.queueRenderItem(6, 'island-cannon-reload', () => this.drawIslandCannonReloadIndicators(camera));
    }

    // Queue sail masts (layer 7)
    for (const ship of renderShips) {
      if (ship.shipType === SHIP_TYPE_GHOST) continue;
      const _da = (fn: () => void): (() => void) => this._lowerDeckShipId === ship.id
        ? () => { this.ctx.save(); this.ctx.globalAlpha *= this._upperDeckFade; fn(); this.ctx.restore(); } : fn;
      this.queueRenderItem(7, 'sail-masts', _da(() => this.drawShipSailMasts(ship, camera)));
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
          // Damage number omitted — the authoritative value arrives via onStructureHpChanged
          // and will be shown immediately with the real hp-delta.
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
    }
    for (const cannonball of renderCannonballs) {
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

    // Queue NPCs — deck-aware layering: lower deck (0) → layer 1 (under planks), upper deck → layer 4 (above planks)
    for (const npc of (worldState.npcs || [])) {
      const _npcShip = npc.shipId ? worldState.ships.find(s => s.id === npc.shipId) : null;
      const _npcCheckPos = _npcShip?.position ?? npc.position;
      if (!this._shouldRenderEntityAt(_npcCheckPos.x, _npcCheckPos.y, 60, camera, false)) continue;
      if (npc.shipId && npc.deckLevel === 0) {
        // Lower-deck NPC: render at layer 1 (below planks) so they're visible from the lower
        // deck and naturally hidden from above by the upper-deck cover at layer 2.
        // Alt-held ghost rendering at layer 4 lets you see them from above in dim form.
        this.queueRenderItem(1, `npc-lower-${npc.id}`, () => this.drawNpc(npc, worldState, camera), 2);
        if (this.altKeyHeld) {
          this.queueRenderItem(4, `npc-lower-ghost-${npc.id}`, () => {
            this.ctx.save(); this.ctx.globalAlpha *= 0.35; this.drawNpc(npc, worldState, camera); this.ctx.restore();
          }, 2);
        }
      } else {
        this.queueRenderItem(4, `npc-upper-${npc.id}`, () => this.drawNpc(npc, worldState, camera), 2);
      }
    }

    // Queue dropped items — deck-aware layering (mirrors NPC pattern)
    this.queueDroppedItems(camera);

    // Queue ship ammo labels and name labels (layer 9 - HUD overlay above all ship elements)
    for (const ship of renderShips) {
      this.queueRenderItem(9, 'ship-ammo-hud', () => this.drawShipAmmoLabel(ship, camera));
      // Name label: show for ghost ships (level badge) and named player ships, but not own ship
      if (ship.id !== _localCarrierId && (ship.shipType === SHIP_TYPE_GHOST || ship.shipName)) {
        this.queueRenderItem(9, `ship-name-${ship.id}`, () => this.drawShipNameLabel(ship, camera));
      }
      if (ship.claimFlag) {
        this.queueRenderItem(9, `ship-flag-${ship.id}`, () => this.drawShipClaimFlag(ship, camera));
      }
    }

    // ── Sinking ghost ships (client-side fade-out after server despawn) ──────
    for (const ghost of this.sinkingGhosts.values()) {
      const wrappedGhostCopies = this.buildWrappedRenderCopies([ghost], camera, 320);
      for (const ghostCopy of wrappedGhostCopies) {
        const id = ghostCopy.id;
        this.queueRenderItem(1, `ghost-wake-${id}`,      () => this.drawShipWake(ghostCopy, camera), -2);
        this.queueRenderItem(1, `ghost-hull-${id}`,       () => this.drawShipHull(ghostCopy, camera));
        this.queueRenderItem(1, `ghost-fog-${id}`,        () => this.drawGhostFogAura(ghostCopy, camera), -1);
        this.queueRenderItem(3, `ghost-deck-${id}`,       () => this.drawGhostDeckEffects(ghostCopy, camera));
        this.queueRenderItem(4, `ghost-cannons-${id}`,    () => this.drawShipCannons(ghostCopy, camera));
      }
    }
  }
  
  private queueRenderItem(layer: number, layerName: string, renderFn: () => void, priority: number = 0): void {
    const idx = layer < 0 ? 0 : layer;
    this.renderBuckets[idx].push({ layer, layerName, renderFn, priority });
  }

  // ── Building shadow (visibility polygon) ─────────────────────────────────

  /**
   * Compute a 2D visibility polygon from the player position using the cached
   * wall segments.  Rays are cast toward every wall endpoint (+ ±0.0001 rad
   * offset to cleanly handle corners).  The result is stored in _visPolyPts
   * as a flat [x0,y0, x1,y1, ...] world-space array, sorted by angle.
   * Only recomputed when the player moves or walls change.
   */
  private _buildVisibilityPoly(px: number, py: number): void {
    const segs = this._wallSegs;
    const nSegs = segs.length / 4;
    if (nSegs === 0) { this._visPolyPts = new Float32Array(0); return; }

    // Bounding box around the player, FAR units to each side. Acts as a guaranteed
    // backstop so rays in directions with no wall still terminate at a finite distance.
    const FAR = 2000;
    const bx0 = px - FAR, by0 = py - FAR;
    const bx1 = px + FAR, by1 = py + FAR;
    // Treat box edges as 4 extra wall segments so every ray hits something.
    const allSegsLen = segs.length + 16;
    const all = new Float32Array(allSegsLen);
    all.set(segs);
    let bi = segs.length;
    all[bi++] = bx0; all[bi++] = by0; all[bi++] = bx1; all[bi++] = by0; // top
    all[bi++] = bx1; all[bi++] = by0; all[bi++] = bx1; all[bi++] = by1; // right
    all[bi++] = bx1; all[bi++] = by1; all[bi++] = bx0; all[bi++] = by1; // bottom
    all[bi++] = bx0; all[bi++] = by1; all[bi++] = bx0; all[bi++] = by0; // left

    // Collect angles toward every wall endpoint (±epsilon to peek around corners),
    // plus the 4 box corners so the polygon is well-defined in empty directions.
    const angles: number[] = [];
    for (let i = 0; i < segs.length; i += 4) {
      for (let k = 0; k < 2; k++) {
        const ex = segs[i + k * 2], ey = segs[i + k * 2 + 1];
        const a = Math.atan2(ey - py, ex - px);
        angles.push(a - 0.0001, a, a + 0.0001);
      }
    }
    angles.push(
      Math.atan2(by0 - py, bx0 - px),
      Math.atan2(by0 - py, bx1 - px),
      Math.atan2(by1 - py, bx1 - px),
      Math.atan2(by1 - py, bx0 - px),
    );

    const rayHit = (angle: number): [number, number] => {
      const rdx = Math.cos(angle), rdy = Math.sin(angle);
      let minT = FAR * 2;
      for (let i = 0; i < all.length; i += 4) {
        const sx = all[i], sy = all[i+1], ex = all[i+2], ey = all[i+3];
        const sdx = ex - sx, sdy = ey - sy;
        const denom = rdx * sdy - rdy * sdx;
        if (Math.abs(denom) < 1e-9) continue;
        const t1 = ((sx - px) * sdy - (sy - py) * sdx) / denom;
        const t2 = ((sx - px) * rdy - (sy - py) * rdx) / denom;
        if (t1 >= 0 && t2 >= 0 && t2 <= 1 && t1 < minT) minT = t1;
      }
      return [px + rdx * minT, py + rdy * minT];
    };

    angles.sort((a, b) => a - b);
    const pts = new Float32Array(angles.length * 2);
    for (let i = 0; i < angles.length; i++) {
      const [hx, hy] = rayHit(angles[i]);
      pts[i * 2]     = hx;
      pts[i * 2 + 1] = hy;
    }
    this._visPolyPts = pts;
    this._visPolyPx  = px;
    this._visPolyPy  = py;
  }

  /**
   * Draw a dark shadow mask over building interiors that are not in the
   * player's line of sight.  Only active when the player is on foot and
   * there are walls present.
   *
   * Technique:
   *  1. Fill an offscreen canvas fully black (the "dark" layer).
   *  2. Punch out the visibility polygon using 'destination-out' compositing.
   *  3. Blit the result onto the main canvas.
   */
  private _shadowCanvas: OffscreenCanvas | null = null;
  private _shadowCtx: OffscreenCanvasRenderingContext2D | null = null;

  drawBuildingShadow(camera: Camera): void {
    const lp = this._cachedLocalPlayer;
    if (!lp || lp.carrierId !== 0) return;  // only on foot
    if (this._wallSegs.length === 0) return; // no walls → no shadow

    const px = lp.position.x, py = lp.position.y;

    // Collect all floor tiles of every building near enough to be visible.
    const SHADOW_RANGE = 600; // world units — covers typical screen at any zoom
    const ADJ = 55;
    const allFloors = this.placedStructures.filter(f => f.type === 'wooden_floor');

    const seedFloors = allFloors.filter(f => {
      const dx = f.x - px, dy = f.y - py;
      return dx * dx + dy * dy <= SHADOW_RANGE * SHADOW_RANGE;
    });
    if (seedFloors.length === 0) return;

    // Flood-fill to include all tiles in any building that has at least one seed tile.
    const shadowFloorIds = new Set<number>(seedFloors.map(f => f.id));
    const floorQueue: PlacedStructure[] = [...seedFloors];
    while (floorQueue.length > 0) {
      const cur = floorQueue.shift()!;
      for (const f of allFloors) {
        if (shadowFloorIds.has(f.id)) continue;
        const dx = f.x - cur.x, dy = f.y - cur.y;
        if (dx * dx + dy * dy <= ADJ * ADJ) { shadowFloorIds.add(f.id); floorQueue.push(f); }
      }
    }
    const connectedFloors = allFloors.filter(f => shadowFloorIds.has(f.id));

    const cw = this.canvas.width, ch = this.canvas.height;
    if (!this._shadowCanvas || this._shadowCanvas.width !== cw || this._shadowCanvas.height !== ch) {
      this._shadowCanvas = new OffscreenCanvas(cw, ch);
      this._shadowCtx    = this._shadowCanvas.getContext('2d')!;
    }
    const sc = this._shadowCtx!;
    sc.clearRect(0, 0, cw, ch);

    // Inline world→screen.
    const camState = camera.getState();
    const camX = camState.position.x, camY = camState.position.y;
    const zoom  = camState.zoom;
    const rot   = -camState.rotation;
    const cosR  = Math.cos(rot), sinR = Math.sin(rot);
    const hw = cw / 2, hh = ch / 2;
    const toSx = (wx: number, wy: number) => {
      const tx = (wx - camX) * zoom, ty = (wy - camY) * zoom;
      return tx * cosR - ty * sinR + hw;
    };
    const toSy = (wx: number, wy: number) => {
      const tx = (wx - camX) * zoom, ty = (wy - camY) * zoom;
      return tx * sinR + ty * cosR + hh;
    };

    // ── Per-tile line-of-sight: a tile is "hidden" if a wall segment crosses
    //    every ray from the player to all 4 corners (plus center). If ANY of
    //    those 5 sample points is unblocked, the tile is visible → no shadow.
    const segs = this._wallSegs;
    // Strict segment-vs-segment intersection (cross-product sign method).
    const segIntersects = (
      ax: number, ay: number, bx: number, by: number,
      cx: number, cy: number, dx: number, dy: number,
    ): boolean => {
      const d1x = bx - ax, d1y = by - ay;
      const d2x = dx - cx, d2y = dy - cy;
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < 1e-9) return false;
      const sx = ax - cx, sy = ay - cy;
      const t = (d2x * sy - d2y * sx) / denom;
      const u = (d1x * sy - d1y * sx) / denom;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
    };
    const losBlocked = (tx: number, ty: number): boolean => {
      for (let i = 0; i < segs.length; i += 4) {
        if (segIntersects(px, py, tx, ty, segs[i], segs[i+1], segs[i+2], segs[i+3])) return true;
      }
      return false;
    };

    sc.globalCompositeOperation = 'source-over';
    sc.fillStyle = 'rgba(0,0,0,0.78)';
    const tileHalf = 26; // 25 + 1px to close seams between adjacent tiles
    const sampleHalf = 22; // sample slightly inside the tile to avoid grazing wall endpoints
    sc.beginPath();
    let drewAny = false;
    for (const f of connectedFloors) {
      const fRot = (f.rotation ?? 0) * Math.PI / 180;
      const cosF = Math.cos(fRot), sinF = Math.sin(fRot);

      // Sample points (center + 4 inset corners). Tile is hidden only if ALL are blocked.
      const samples: [number, number][] = [
        [f.x, f.y],
        [f.x + (-sampleHalf) * cosF - (-sampleHalf) * sinF, f.y + (-sampleHalf) * sinF + (-sampleHalf) * cosF],
        [f.x + ( sampleHalf) * cosF - (-sampleHalf) * sinF, f.y + ( sampleHalf) * sinF + (-sampleHalf) * cosF],
        [f.x + ( sampleHalf) * cosF - ( sampleHalf) * sinF, f.y + ( sampleHalf) * sinF + ( sampleHalf) * cosF],
        [f.x + (-sampleHalf) * cosF - ( sampleHalf) * sinF, f.y + (-sampleHalf) * sinF + ( sampleHalf) * cosF],
      ];
      let allBlocked = true;
      for (const [sx, sy] of samples) {
        if (!losBlocked(sx, sy)) { allBlocked = false; break; }
      }
      if (!allBlocked) continue; // tile visible from player → leave it lit

      // Draw the full tile quad (tileHalf, slight overrun to close seams).
      const corners: [number, number][] = [
        [f.x + (-tileHalf) * cosF - (-tileHalf) * sinF, f.y + (-tileHalf) * sinF + (-tileHalf) * cosF],
        [f.x + ( tileHalf) * cosF - (-tileHalf) * sinF, f.y + ( tileHalf) * sinF + (-tileHalf) * cosF],
        [f.x + ( tileHalf) * cosF - ( tileHalf) * sinF, f.y + ( tileHalf) * sinF + ( tileHalf) * cosF],
        [f.x + (-tileHalf) * cosF - ( tileHalf) * sinF, f.y + (-tileHalf) * sinF + ( tileHalf) * cosF],
      ];
      sc.moveTo(toSx(corners[0][0], corners[0][1]), toSy(corners[0][0], corners[0][1]));
      for (let i = 1; i < 4; i++) sc.lineTo(toSx(corners[i][0], corners[i][1]), toSy(corners[i][0], corners[i][1]));
      sc.closePath();
      drewAny = true;
    }
    if (!drewAny) return;
    sc.fill();

    this.ctx.drawImage(this._shadowCanvas, 0, 0);
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

  private drawShipWake(ship: Ship, camera: Camera): void {
    if (ship.shipType === SHIP_TYPE_GHOST) return;
    if (!camera.isWorldPositionVisible(ship.position, 420)) return;

    const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
    if (speed < 8) return;

    const forwardX = Math.cos(ship.rotation);
    const forwardY = Math.sin(ship.rotation);
    const signedForwardSpeed = ship.velocity.x * forwardX + ship.velocity.y * forwardY;

    // Wake intensity grows with forward/reverse movement along the ship heading.
    const wakeFactor = Math.min(1, Math.abs(signedForwardSpeed) / 135);
    if (wakeFactor < 0.06) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const ctx = this.ctx;
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const t = performance.now() / 1000;
    const pulse = 0.6 + 0.4 * Math.sin(t * 7.5 + ship.id * 0.37);

    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);
    ctx.scale(cameraState.zoom, cameraState.zoom);
    ctx.rotate(ship.rotation - cameraState.rotation);

    const wakeAlpha = (0.15 + wakeFactor * 0.42) * phase1Alpha;
    // Bow is at local +X (max hull X), stern at -X (min hull X).
    // Physics convention: signedForwardSpeed >= 0 maps to BACKWARD motion in this client,
    // so leadSign is intentionally inverted.
    const leadSign = signedForwardSpeed >= 0 ? -1 : 1;

    let bowLocalX = 150;
    for (let _hi = 0; _hi < ship.hull.length; _hi++) {
      const hx = ship.hull[_hi].x;
      if (hx > bowLocalX) bowLocalX = hx;
    }
    const leadX = (bowLocalX - 80) * -leadSign;
    const bowGlow = ctx.createRadialGradient(leadX, 0, 12, leadX, 0, 170 + wakeFactor * 65);
    bowGlow.addColorStop(0, `rgba(248,252,255,${(wakeAlpha * (1.0 + 0.25 * pulse)).toFixed(3)})`);  
    bowGlow.addColorStop(1, 'rgba(180,210,245,0)');
    ctx.fillStyle = bowGlow;
    ctx.beginPath();
    ctx.ellipse(leadX, 0, 140 + wakeFactor * 65, 54 + wakeFactor * 28, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(245,252,255,${(wakeAlpha * 1.4).toFixed(3)})`;  
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(bowLocalX * -leadSign, -10);
    ctx.quadraticCurveTo((bowLocalX - 140) * -leadSign, -88 - wakeFactor * 34, (bowLocalX - 370) * -leadSign, -120 - wakeFactor * 42);
    ctx.moveTo(bowLocalX * -leadSign, 10);
    ctx.quadraticCurveTo((bowLocalX - 140) * -leadSign, 88 + wakeFactor * 34, (bowLocalX - 370) * -leadSign, 120 + wakeFactor * 42);
    ctx.stroke();

    ctx.restore();

    // ── Combined wake trail (wash + Kelvin V-lines + bow wave history) ──────
    // All three effects share one trail of {x,y,r,t} (ship-center + rotation).
    // Screen positions are computed once per point and reused across effects.
    const trail = this.shipWakeTrails.get(ship.id);
    if (!trail || trail.length < 2) return;

    // Hull extremes (computed with a loop, not spread/map to avoid allocations).
    let bowLX = -Infinity, sternLX = Infinity;
    for (let i = 0; i < ship.hull.length; i++) {
      const vx = ship.hull[i].x;
      if (vx > bowLX)   bowLX   = vx;
      if (vx < sternLX) sternLX = vx;
    }
    if (!isFinite(bowLX))   bowLX   =  150;
    if (!isFinite(sternLX)) sternLX = -150;

    const nowMs  = performance.now();
    const DUR    = this.SHIP_WAKE_TRAIL_DURATION_MS;
    const z      = cameraState.zoom;
    const camRot = cameraState.rotation;
    const kelvinTan = 0.35355; // 1/√8

    // Pre-compute per-point data in one pass.
    // ssx/ssy = stern screen x/y; bsx/bsy = bow screen x/y.
    //
    // Persistent slab: reuse the Float32Array pool from a previous frame when N
    // hasn't grown.  Eliminates 9 per-frame small-array allocations (and their GC).
    const N = trail.length;
    const STRIDE = RenderSystem._WAKE_BUF_STRIDE;
    let wbEntry = this._wakeBuffers.get(ship.id);
    if (!wbEntry || wbEntry.cap < N) {
      const newCap = Math.max(N, 128); // over-allocate so single-point growth is rare
      wbEntry = { buf: new Float32Array(newCap * STRIDE), cap: newCap };
      this._wakeBuffers.set(ship.id, wbEntry);
    }
    const _b = wbEntry.buf;
    // Slice offsets within the slab (layout: 11 arrays × N elements)
    const O_SSX    = 0 * N, O_SSY    = 1 * N, O_BSX    = 2 * N, O_BSY    = 3 * N;
    const O_FADE   = 4 * N, O_BCOS   = 5 * N, O_BSIN   = 6 * N;
    const O_PERPX  = 7 * N, O_PERPY  = 8 * N, O_CUMD   = 9 * N, O_SEGL   = 10 * N;

    // Typed-array views into the slab (zero-copy)
    const ssx       = _b.subarray(O_SSX,  O_SSX  + N);
    const ssy       = _b.subarray(O_SSY,  O_SSY  + N);
    const bsx       = _b.subarray(O_BSX,  O_BSX  + N);
    const bsy       = _b.subarray(O_BSY,  O_BSY  + N);
    const fades     = _b.subarray(O_FADE, O_FADE + N);
    const bowCosArr = _b.subarray(O_BCOS, O_BCOS + N);
    const bowSinArr = _b.subarray(O_BSIN, O_BSIN + N);
    const perpX     = _b.subarray(O_PERPX, O_PERPX + N);
    const perpY     = _b.subarray(O_PERPY, O_PERPY + N);
    const cumDist   = _b.subarray(O_CUMD, O_CUMD  + N);

    // Shift to anchor trail to current stern world pos.
    const newest = trail[N - 1];
    const cosR = Math.cos(ship.rotation), sinR = Math.sin(ship.rotation);
    const curSternX = ship.position.x + cosR * sternLX;
    const curSternY = ship.position.y + sinR * sternLX;
    const shiftX = curSternX - newest.x;
    const shiftY = curSternY - newest.y;

    // Inline worldToScreen constants — avoids ~2 Vec2 heap allocations per point
    // (Vec2.from + intermediate objects inside worldToScreen).
    // Formula: screen = rotate(-camRot, (world - camPos) * zoom) + (halfW, halfH)
    const _camPos   = cameraState.position;
    const _camZoom  = cameraState.zoom;
    const _camCosNR = Math.cos(-cameraState.rotation);
    const _camSinNR = Math.sin(-cameraState.rotation);
    const _halfW    = camera.getViewport().width  / 2;
    const _halfH    = camera.getViewport().height / 2;

    // camRot cos/sin for bow-wave rotation (computed once, reused per point)
    const _camCosR = Math.cos(camRot), _camSinR = Math.sin(camRot);

    for (let i = 0; i < N; i++) {
      const pt = trail[i];
      const age = (nowMs - pt.t) / DUR;
      fades[i] = age >= 0 && age <= 1 ? 1 - age : 0;
      if (fades[i] <= 0) continue;

      // Use pre-baked cr/sr (stored at emit time) — eliminates Math.cos(pt.r) per frame
      const cosPR = pt.cr, sinPR = pt.sr;

      // Inline stern screen position (zero allocations)
      const stx = (pt.x + shiftX - _camPos.x) * _camZoom;
      const sty = (pt.y + shiftY - _camPos.y) * _camZoom;
      ssx[i] = stx * _camCosNR - sty * _camSinNR + _halfW;
      ssy[i] = stx * _camSinNR + sty * _camCosNR + _halfH;

      // Inline bow screen position (zero allocations)
      const bwx = pt.x + cosPR * bowLX;
      const bwy = pt.y + sinPR * bowLX;
      const btx = (bwx - _camPos.x) * _camZoom;
      const bty = (bwy - _camPos.y) * _camZoom;
      bsx[i] = btx * _camCosNR - bty * _camSinNR + _halfW;
      bsy[i] = btx * _camSinNR + bty * _camCosNR + _halfH;

      // Bow-wave trig via identity: cos(r-c) = cr*cc + sr*sc (no extra trig calls)
      bowCosArr[i] = cosPR * _camCosR + sinPR * _camSinR;
      bowSinArr[i] = sinPR * _camCosR - cosPR * _camSinR;
    }

    // Merged perpendicular + cumulative-distance pass.
    // Both need the same per-segment (dx, dy, len) — compute once, use twice.
    // segLen[i] = screen-space length of segment (i-1 → i).
    const segLen = _b.subarray(O_SEGL, O_SEGL + N);
    perpX[0] = 0; perpY[0] = 1; segLen[0] = 0; cumDist[N - 1] = 0;
    for (let i = 1; i < N; i++) {
      const dx = ssx[i] - ssx[i - 1], dy = ssy[i] - ssy[i - 1];
      const len = Math.sqrt(dx * dx + dy * dy);
      segLen[i] = len;
      if (len > 0.5) { perpX[i] = -dy / len; perpY[i] = dx / len; }
      else           { perpX[i] = perpX[i - 1]; perpY[i] = perpY[i - 1]; }
    }
    perpX[0] = perpX[1]; perpY[0] = perpY[1];
    cumDist[N - 1] = 0;
    for (let i = N - 2; i >= 0; i--) cumDist[i] = cumDist[i + 1] + segLen[i + 1];

    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    // Pass A – Wash (core foam stripe, 4 fade buckets).
    // Sub-pixel culling: skip segments whose screen-space extent is < 1 px —
    // they contribute no visible pixels but still cost path operations.
    const washBaseW = Math.min(100, Math.max(3, (34 + wakeFactor * 28) * z));
    for (let b = 0; b < 4; b++) {
      const fadeMin = b / 4, fadeMax = (b + 1) / 4, fadeMid = (fadeMin + fadeMax) / 2;
      const alpha = wakeAlpha * 1.2 * fadeMid;
      if (alpha <= 0.01) continue;
      ctx.strokeStyle = `rgba(248,252,255,${alpha.toFixed(3)})`;
      ctx.lineWidth   = washBaseW * fadeMid;
      ctx.beginPath();
      let drew = false;
      for (let i = 1; i < N; i++) {
        const fade = fades[i];
        if (fade <= 0 || fade < fadeMin || fade >= fadeMax) continue;
        const dx = ssx[i] - ssx[i - 1], dy = ssy[i] - ssy[i - 1];
        if (dx * dx + dy * dy < 1) continue; // sub-pixel — skip
        ctx.moveTo(ssx[i - 1], ssy[i - 1]);
        ctx.lineTo(ssx[i],     ssy[i]);
        drew = true;
      }
      if (drew) ctx.stroke();
    }

    // Pass B – Kelvin V-lines + bow wave V-shapes, interleaved in one alpha-bucketed loop.
    ctx.lineWidth = Math.min(3, Math.max(0.8, 2.2 * z));
    let lastAlpha = -1;
    ctx.beginPath();
    for (let i = 1; i < N; i++) {
      const fade = fades[i];
      if (fade <= 0) continue;
      const alpha = wakeAlpha * 1.1 * fade;
      if (alpha <= 0.01) continue;
      // Sub-pixel cull: skip if the stern segment covers < 1px on screen
      { const dx = ssx[i] - ssx[i-1], dy = ssy[i] - ssy[i-1]; if (dx*dx + dy*dy < 1) continue; }
      const qa = Math.round(alpha / 0.05) * 0.05;
      if (qa !== lastAlpha) {
        if (lastAlpha >= 0) ctx.stroke();
        ctx.strokeStyle = `rgba(238,250,255,${qa.toFixed(2)})`;
        ctx.beginPath();
        lastAlpha = qa;
      }

      // Kelvin V-lines: offset stern points perpendicular by Kelvin angle.
      const offA = cumDist[i - 1] * kelvinTan;
      const offB = cumDist[i]     * kelvinTan;
      ctx.moveTo(ssx[i-1] + perpX[i] * offA, ssy[i-1] + perpY[i] * offA);
      ctx.lineTo(ssx[i]   + perpX[i] * offB, ssy[i]   + perpY[i] * offB);
      ctx.moveTo(ssx[i-1] - perpX[i] * offA, ssy[i-1] - perpY[i] * offA);
      ctx.lineTo(ssx[i]   - perpX[i] * offB, ssy[i]   - perpY[i] * offB);

      // Bow wave V-shapes — only for the newest ~50% of the trail.
      // Old segments (fade < 0.5, i.e. > half the trail lifetime) are too faded
      // to see the fine bow detail; skipping 2 quadraticCurveTo calls per point
      // roughly halves the path operations in Pass B without visible change.
      if (fade >= 0.5) {
        const cosS = bowCosArr[i], sinS = bowSinArr[i];
        const spread = (88 + wakeFactor * 34) * fade;
        const tip    = spread * 1.36;
        const f140x = (-cosS * 140) * z, f140y = (-sinS * 140) * z;
        const f370x = (-cosS * 370) * z, f370y = (-sinS * 370) * z;
        const tpx = (-sinS *  spread) * z, tpy = ( cosS *  spread) * z;
        const bpx = (-sinS * -spread) * z, bpy = ( cosS * -spread) * z;
        const tipx = (-sinS *  tip) * z,   tipy = ( cosS *  tip) * z;
        const btipx = (-sinS * -tip) * z,  btipy = ( cosS * -tip) * z;
        ctx.moveTo(bsx[i], bsy[i]);
        ctx.quadraticCurveTo(bsx[i] + f140x + tpx,  bsy[i] + f140y + tpy,
                             bsx[i] + f370x + tipx,  bsy[i] + f370y + tipy);
        ctx.moveTo(bsx[i], bsy[i]);
        ctx.quadraticCurveTo(bsx[i] + f140x + bpx,  bsy[i] + f140y + bpy,
                             bsx[i] + f370x + btipx, bsy[i] + f370y + btipy);
      }
    }
    if (lastAlpha >= 0) ctx.stroke();

    ctx.restore();
  }
  
  private drawShipHull(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) {
      return;
    }
    
    if (ship.hull.length === 0) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return; // fully faded — nothing to draw
    
    this.ctx.save();
    const _deckAlpha = this._lowerDeckShipId === ship.id ? this._upperDeckFade : 1.0;
    if (phase1Alpha * _deckAlpha < 1) this.ctx.globalAlpha = phase1Alpha * _deckAlpha;
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    
    this.ctx.strokeStyle = '#8B4513'; // Brown
    // Upper deck (deckId=1) is lighter; lower deck only is a darker warm wood
    const hasUpperDeck = ship.modules.some(m => m.kind === 'deck' && m.deckId === 1);
    this.ctx.fillStyle = hasUpperDeck ? '#DEB887' : '#A87040'; // BurlyWood : darker lower-deck wood

    // Ghost ship: dark spectral hull with cyan edge glow
    const isGhost = ship.shipType === SHIP_TYPE_GHOST;
    // Aggro glow: enemy within de-aggro radius (matches server GHOST_DEAGGRO_RANGE)
    const GHOST_DEAGGRO_RANGE_PX = 4800;
    const isGhostAggro = isGhost && (this._cachedWorldShips ?? []).some(s =>
      s.id !== ship.id && s.shipType !== SHIP_TYPE_GHOST && s.hullHealth > 0 &&
      (s.position.x - ship.position.x) ** 2 + (s.position.y - ship.position.y) ** 2
        < GHOST_DEAGGRO_RANGE_PX * GHOST_DEAGGRO_RANGE_PX
    );
    // Pulse timer: 0-1 oscillation for the aggro glow
    const aggroPulse = isGhostAggro ? 0.65 + 0.35 * Math.sin(performance.now() / 220) : 1;
    // Enemy ship: different non-zero company to the local player
    const isEnemyShip = !isGhost && this._localCompanyId !== 0
      && ship.companyId !== 0 && ship.companyId !== this._localCompanyId;
    if (isGhost) {
      this.ctx.fillStyle   = isGhostAggro ? '#1a0000' : '#0f0f1a';
      this.ctx.strokeStyle = '#0a0a16';
      const glowColor = isGhostAggro
        ? `rgba(255,30,0,${(0.7 * aggroPulse).toFixed(3)})`
        : ghostSpectralColor(ship.npcLevel ?? 1);
      this.ctx.shadowColor  = glowColor;
      this.ctx.shadowBlur   = (isGhostAggro ? 18 : 12) / cameraState.zoom;
    }

    this.ctx.lineWidth = 2 / cameraState.zoom;

    const hasDeck = ship.modules.some(m => m.kind === 'deck');

    if (!hasDeck && !isGhost) {
      // ── Skeleton hull: bare wooden frame (no deck installed) ──
      // Hull outline only — no fill; show the raw outer edge in bare-wood colour
      this.ctx.strokeStyle = '#8B4513';
      this.ctx.lineWidth = 2.5 / cameraState.zoom;
      this.ctx.beginPath();
      this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
      for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
      this.ctx.closePath();
      this.ctx.stroke();

      // Ribs: cross-beams at plank-boundary x-positions.
      // Port side (y=+90) and starboard side (y=-90) share the same four x values:
      //   stern (-260), 1st joint (-110), 2nd joint (40), bow (190)
      this.ctx.strokeStyle = '#6B3A10';
      this.ctx.lineWidth = 1.5;
      for (const rx of [-260, -110, 40, 190]) {
        this.ctx.beginPath();
        this.ctx.moveTo(rx,  90);
        this.ctx.lineTo(rx, -90);
        this.ctx.stroke();
      }

      // Keel: longitudinal centre beam from bow tip (415,0) to stern tip (-345,0)
      this.ctx.strokeStyle = '#5A3008';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo( 415, 0);
      this.ctx.lineTo(-345, 0);
      this.ctx.stroke();
    } else {
      // ── Normal hull: filled polygon ──

      // Ghost hull fades as it takes damage (health 60000→0 maps opacity 1.0→0.2)
      if (isGhost) {
        const healthFade = Math.max(0.2, ship.hullHealth / GHOST_MAX_HULL_HP);
        this.ctx.globalAlpha = phase1Alpha * healthFade;
      }

      if (!isGhost && hasDeck) {
        // ── Sprite-cached path: hull fill + grain + outline (static) ──────────
        // Compute fill colour (health-bucketed by darkenByDamage so cache is stable
        // over small HP fluctuations that don't cross a colour bucket boundary).
        const topDeck = ship.modules.find(m => m.kind === 'deck' && m.deckId === 1)
                     ?? ship.modules.find(m => m.kind === 'deck');
        const baseHullColor = hasUpperDeck ? '#DEB887' : '#A87040';
        const dmd = topDeck?.moduleData as any;
        let fillColor = baseHullColor;
        if (dmd && typeof dmd.health === 'number' && typeof dmd.maxHealth === 'number' && dmd.maxHealth > 0) {
          fillColor = this.darkenByDamage(baseHullColor, Math.max(0, dmd.health / dmd.maxHealth));
        }
        const hullSprite = this._getShipHullSprite(ship, hasUpperDeck, hasDeck, fillColor);
        if (hullSprite) {
          this.ctx.drawImage(hullSprite.canvas, -hullSprite.ox, -hullSprite.oy);
        }
      } else {
        // Ghost hull — blit combined static sprite (hull + rigging + masts/sails + rune).
        // Dynamic effects (shadowBlur glow, health fade, spectral edge stroke, mist)
        // are drawn on top after the blit. Cannons are a separate live draw pass.
        const ghostSprite = this._getGhostCombinedSprite(ship, isGhostAggro);
        if (ghostSprite) {
          this.ctx.drawImage(ghostSprite.canvas, -ghostSprite.ox, -ghostSprite.oy);
        } else {
          // Fallback if hull geometry not ready
          this.ctx.beginPath();
          this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
          for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
          this.ctx.closePath();
          this.ctx.fill();
          this.ctx.stroke();
        }
      }

      // Ghost ships: add a second thin edge stroke for the spectral glow outline (level-tinted)
      if (isGhost) {
        const ghostNpcLvl2 = ship.npcLevel != null && ship.npcLevel > 0 ? ship.npcLevel : 1;
        const ghostLvlMaxHP2 = Math.round(GHOST_MAX_HULL_HP * (1 + (ghostNpcLvl2 - 1) * 9 / 59));
        const healthMult = Math.max(0.2, ship.hullHealth / ghostLvlMaxHP2);
        const sinkMult   = phase1Alpha < 1 ? phase1Alpha : 1;
        this.ctx.shadowBlur   = 0;
        this.ctx.strokeStyle  = isGhostAggro
          ? `rgba(255,40,0,${(0.75 * aggroPulse * sinkMult * healthMult).toFixed(3)})`
          : ghostSpectralColor(ghostNpcLvl2, 0.55 * sinkMult * healthMult);
        this.ctx.lineWidth    = (isGhostAggro ? 2.0 : 1.5) / cameraState.zoom;
        this.ctx.beginPath();
        this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
        for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
        this.ctx.closePath();
        this.ctx.stroke();
      }

      // Ghost dissolve mist (not per-deck flood — spectral hull effect only)
      if (isGhost) {
        const ghostNpcLvl3 = ship.npcLevel != null && ship.npcLevel > 0 ? ship.npcLevel : 1;
        const ghostLvlMaxHP3 = Math.round(GHOST_MAX_HULL_HP * (1 + (ghostNpcLvl3 - 1) * 9 / 59));
        const ghostMistAlpha = Math.max(0, (1 - ship.hullHealth / ghostLvlMaxHP3) - 0.25) / 0.75;
        if (ghostMistAlpha > 0) {
          const sinkMult = phase1Alpha < 1 ? phase1Alpha : 1;
          const ghostMistClr = ghostSpectralColor(ship.npcLevel ?? 1);
          this.ctx.globalAlpha = ghostMistAlpha * 0.75 * sinkMult;
          this.ctx.fillStyle = ghostMistClr;
          this.ctx.shadowColor = ghostMistClr;
          this.ctx.shadowBlur  = 16 / cameraState.zoom;
          this.ctx.beginPath();
          this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
          for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
          this.ctx.closePath();
          this.ctx.fill();
        }
      }
    }

    this.ctx.restore();
  }

  /**
   * Draw scaffolding clamps and rope ties that visually attach a scaffolded ship
   * to the surrounding shipyard dock walls.
   */
  private drawScaffoldingVisuals(ship: Ship, scaffold: PlacedStructure, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const ctx = this.ctx;
    const cameraState = camera.getState();
    const zoom = cameraState.zoom;
    const screenPos = camera.worldToScreen(ship.position);

    ctx.save();
    ctx.translate(screenPos.x, screenPos.y);
    ctx.scale(zoom, zoom);
    ctx.rotate(ship.rotation - cameraState.rotation);

    // Shipyard dock dimensions in world units (BASE = 50)
    const BASE  = 50;
    const INT_W = BASE * 4.80; // 240  — interior bay width
    const ARM_T = BASE * 1.00; // 50   — pier arm thickness
    const dockHW = (INT_W + ARM_T * 2) / 2; // 170 — half total dock width

    // Ship hull half-beam (approximate brigantine beam / 2)
    const hullHB = 90;

    // Clamp positions along the ship's local X-axis (fore-aft)
    const clampPositions = [-280, -140, 0, 140, 280];
    const pulse = 0.6 + 0.2 * Math.sin(performance.now() * 0.002);

    for (const lx of clampPositions) {
      // ── Port side (local +Y) ──
      const portHull = hullHB;
      const portDock = dockHW - ARM_T * 0.3; // inner edge of dock wall
      // Rope line from hull edge to dock wall
      ctx.strokeStyle = `rgba(160, 120, 60, ${(0.75 * pulse).toFixed(2)})`;
      ctx.lineWidth = Math.max(1.5, 2.5 / zoom);
      ctx.setLineDash([Math.max(3, 5 / zoom), Math.max(2, 3 / zoom)]);
      ctx.beginPath();
      ctx.moveTo(lx, portHull);
      ctx.lineTo(lx, portDock);
      ctx.stroke();
      // Clamp bracket at hull edge
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(120, 90, 40, ${(0.9 * pulse).toFixed(2)})`;
      ctx.lineWidth = Math.max(2, 3 / zoom);
      const bw = 12; // bracket half-width along hull
      ctx.beginPath();
      ctx.moveTo(lx - bw, portHull - 4);
      ctx.lineTo(lx - bw, portHull + 6);
      ctx.lineTo(lx + bw, portHull + 6);
      ctx.lineTo(lx + bw, portHull - 4);
      ctx.stroke();
      // Bollard dot at dock wall end
      ctx.fillStyle = `rgba(190, 150, 85, ${(0.85 * pulse).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(lx, portDock, Math.max(2, 3.5 / zoom), 0, Math.PI * 2);
      ctx.fill();

      // ── Starboard side (local -Y) ──
      const stbdHull = -hullHB;
      const stbdDock = -(dockHW - ARM_T * 0.3);
      ctx.strokeStyle = `rgba(160, 120, 60, ${(0.75 * pulse).toFixed(2)})`;
      ctx.lineWidth = Math.max(1.5, 2.5 / zoom);
      ctx.setLineDash([Math.max(3, 5 / zoom), Math.max(2, 3 / zoom)]);
      ctx.beginPath();
      ctx.moveTo(lx, stbdHull);
      ctx.lineTo(lx, stbdDock);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(120, 90, 40, ${(0.9 * pulse).toFixed(2)})`;
      ctx.lineWidth = Math.max(2, 3 / zoom);
      ctx.beginPath();
      ctx.moveTo(lx - bw, stbdHull + 4);
      ctx.lineTo(lx - bw, stbdHull - 6);
      ctx.lineTo(lx + bw, stbdHull - 6);
      ctx.lineTo(lx + bw, stbdHull + 4);
      ctx.stroke();
      ctx.fillStyle = `rgba(190, 150, 85, ${(0.85 * pulse).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(lx, stbdDock, Math.max(2, 3.5 / zoom), 0, Math.PI * 2);
      ctx.fill();
    }

    // ── "Under Construction" label ──
    ctx.rotate(-(ship.rotation - cameraState.rotation)); // undo ship rotation for text
    ctx.font = `bold ${Math.max(10, Math.round(12 / zoom))}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(220, 180, 80, ${(0.85 * pulse).toFixed(2)})`;
    ctx.fillText('⚒ Under Construction', 0, 0);

    ctx.restore();
  }
  
  private drawShipPlanks(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) {
      return;
    }

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const isGhostShip = ship.shipType === SHIP_TYPE_GHOST;
    this.ctx.save();
    // Ghost planks fade with hull damage (full opacity 0.45 at 60000 HP → 0.05 at 0 HP)
    const ghostHealthFade = isGhostShip ? Math.max(0.1, ship.hullHealth / GHOST_MAX_HULL_HP) : 1;
    const baseAlpha = isGhostShip ? Math.min(phase1Alpha, 0.45) * ghostHealthFade : phase1Alpha;
    const _deckAlpha = this._lowerDeckShipId === ship.id ? this._upperDeckFade : 1.0;
    if (baseAlpha * _deckAlpha < 1) this.ctx.globalAlpha = baseAlpha * _deckAlpha;
    
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom = cameraState.zoom;
    
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    // Find all plank modules
    const planks = ship.modules.filter(m => m.kind === 'plank');
    const shipHasDeck = ship.modules.some(m => m.kind === 'deck');
    const shipHasUpperDeck = ship.modules.some(m => m.kind === 'deck' && m.deckId === 1);
    // Lower-deck-only planks are a darker warm wood; upper deck uses the standard lighter tone
    const plankBaseColor  = shipHasUpperDeck ? '#8B7355' : '#6B5232';
    const plankStrokeBase = shipHasUpperDeck ? '#4A3020' : '#3A2010';

    // Clip to hull shape minus deck holes so planks don't draw over transparent openings.
    // Use a nested save/restore so the clip is released before gunport overlays are drawn
    // (open door panels extend 14px outside the hull and must not be clipped).
    this.ctx.save();
    if (shipHasUpperDeck && ship.hull.length >= 3) {
      this.ctx.beginPath();
      this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
      for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
      this.ctx.closePath();
      for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
        this.ctx.rect(sp.x - 25, sp.y - 25, 50, 50);
      }
      this.ctx.clip('evenodd');
    }

    if (!shipHasDeck) {
      // ── Skeleton mode: fill hull sections (between ribs/keel/hull-edge)
      // for PRESENT planks. Missing planks (health ≤ 0) are transparent gaps.
      const sectionFill = 'rgb(125, 103, 76)';
      this.ctx.fillStyle = sectionFill;

      // Rib x-positions that divide the straight hull sides into 3 sections each
      const portRibBounds: [number, number][] = [[-260, -110], [-110, 40], [40, 190]];
      const stbdRibBounds: [number, number][] = [[40, 190], [-110, 40], [-260, -110]];

      for (const plank of planks) {
        if (!plank.moduleData || plank.moduleData.kind !== 'plank') continue;
        if ((plank.moduleData.health ?? 0) <= 0) continue;

        const section = plank.moduleData.sectionName;
        const seg = plank.moduleData.segmentIndex;

        if (section === 'port_side') {
          const [x1, x2] = portRibBounds[seg] ?? [0, 0];
          this.ctx.fillRect(x1, 0, x2 - x1, 90);
        } else if (section === 'starboard_side') {
          const [x1, x2] = stbdRibBounds[seg] ?? [0, 0];
          this.ctx.fillRect(x1, -90, x2 - x1, 90);
        } else if (section) {
          this.drawCurvedHullSection(section);
        }
      }

      this.ctx.restore(); // inner - hull clip
      this.ctx.restore(); // outer - ship transform
      return;
    }

    // ── Normal mode (has deck): blit pre-baked plank sprite for main fill pass.
    // Re-baked only when a plank's health bucket changes (once per damage event, not per frame).
    // Falls back to direct drawing at zoom > 3 (close-up view, usually ≤2 ships visible).
    if (zoom <= 3) {
      const sprite = this._getShipPlankSprite(ship, planks, plankBaseColor, plankStrokeBase, isGhostShip);
      if (sprite) {
        this.ctx.drawImage(sprite.canvas, -sprite.ox, -sprite.oy);
      }
    } else {
      // High zoom fall-back: direct draw for crisp detail
      for (const plank of planks) {
        if (!plank.moduleData || plank.moduleData.kind !== 'plank') continue;
        const plankData = plank.moduleData;
        if ((plankData.health ?? 0) <= 0) continue;
        const maxHealth  = plankData.maxHealth || 10000;
        const healthRatio = Math.max(0, plankData.health / maxHealth);
        const fillColor   = isGhostShip
          ? this.darkenByDamage('#1a2a3a', healthRatio)
          : this.darkenByDamage(plankBaseColor, healthRatio);
        const strokeColor = isGhostShip
          ? this.darkenByDamage('#003055', healthRatio)
          : this.darkenByDamage(plankStrokeBase, healthRatio);
        if (isGhostShip) { this.ctx.shadowColor = ghostSpectralColor(ship.npcLevel ?? 1); this.ctx.shadowBlur = 3; }
        this.ctx.fillStyle = fillColor;
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = 1;
        if (plankData.isCurved && plankData.curveData) {
          this.ctx.save();
          this.drawCurvedPlank(plankData.curveData, plankData.width, fillColor, strokeColor);
          this.ctx.restore();
        } else {
          this.ctx.save();
          this.ctx.translate(plank.localPos.x, plank.localPos.y);
          this.ctx.rotate(plank.localRot);
          const hl = plankData.length / 2, hw = plankData.width / 2;
          this.ctx.fillRect(-hl, -hw, plankData.length, plankData.width);
          this.ctx.strokeRect(-hl, -hw, plankData.length, plankData.width);
          const grainCount = Math.max(1, Math.floor(plankData.length / (10 * zoom)));
          if (grainCount > 1) {
            this.ctx.strokeStyle = strokeColor; this.ctx.lineWidth = 0.5; this.ctx.globalAlpha = 0.3;
            this.ctx.beginPath();
            for (let i = 1; i < grainCount; i++) {
              const x = -hl + (i * plankData.length / grainCount);
              this.ctx.moveTo(x, -hw); this.ctx.lineTo(x, hw);
            }
            this.ctx.stroke(); this.ctx.globalAlpha = 1.0;
          }
          this.ctx.restore();
        }
      }
    }

    // Hover highlight + quality-tier overlay pass for placed planks
    if (!isGhostShip) {
      this._drawShipPlankDynamicOverlays(ship, planks);
    }
    // Release hull clip.
    this.ctx.restore();

    this.ctx.restore();
  }

  /**
   * Draw a curved hull section (bow/stern) as a filled polygon bounded by rib, keel, and hull curve.
   * Used in skeleton mode to show sealed panels where planks are present.
   */
  private drawCurvedHullSection(section: string): void {
    const p = HULL_POINTS;
    const steps = 12;
    let p0: {x: number; y: number}, p1: {x: number; y: number}, p2: {x: number; y: number};
    let tFrom: number, tTo: number;
    let ribX: number, hullEdgeY: number;

    if (section === 'bow_port') {
      p0 = p.bow; p1 = p.bowTip; p2 = p.bowBottom;
      tFrom = 0; tTo = 0.5;
      ribX = 190; hullEdgeY = 90;
    } else if (section === 'bow_starboard') {
      p0 = p.bow; p1 = p.bowTip; p2 = p.bowBottom;
      tFrom = 1.0; tTo = 0.5;
      ribX = 190; hullEdgeY = -90;
    } else if (section === 'stern_starboard') {
      p0 = p.sternBottom; p1 = p.sternTip; p2 = p.stern;
      tFrom = 0; tTo = 0.5;
      ribX = -260; hullEdgeY = -90;
    } else if (section === 'stern_port') {
      p0 = p.sternBottom; p1 = p.sternTip; p2 = p.stern;
      tFrom = 1.0; tTo = 0.5;
      ribX = -260; hullEdgeY = 90;
    } else {
      return;
    }

    this.ctx.beginPath();
    this.ctx.moveTo(ribX, 0);            // rib/keel corner
    this.ctx.lineTo(ribX, hullEdgeY);    // along rib to hull edge
    // Trace the hull curve from hull-edge toward the tip
    for (let i = 0; i <= steps; i++) {
      const t = tFrom + (i / steps) * (tTo - tFrom);
      const pt = getQuadraticPoint(p0, p1, p2, t);
      this.ctx.lineTo(pt.x, pt.y);
    }
    this.ctx.closePath();               // back along keel to rib/keel corner
    this.ctx.fill();
  }

  /**
   * Draw green ghost shapes for all missing plank slots — build mode overlay.
   * A brighter ghost is shown for the slot currently under the cursor.
   */
  private drawMissingPlankGhosts(ship: Ship, camera: Camera): void {
    if (ship.shipType === SHIP_TYPE_GHOST) return;
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    // Build set of present plank slot keys — only slots with health > 0 are "placed".
    // Slots with health = 0 are absent (not yet built) and should show ghost highlights.
    const presentKeys = new Set<string>();
    for (const mod of ship.modules) {
      if (mod.kind === 'plank' && mod.moduleData?.kind === 'plank' && mod.moduleData.health > 0) {
        presentKeys.add(`${mod.moduleData.sectionName}_${mod.moduleData.segmentIndex}`);
      }
    }

    const template = this.getPlankTemplate();
    const missing = template.filter(seg =>
      !presentKeys.has(`${seg.sectionName}_${seg.index}`) &&
      !this.isPlankSlotWrecked(ship.id, seg.sectionName, seg.index)
    );
    if (missing.length === 0) return;

    // When a quality blueprint is selected, tint the ghost slots to the tier colour.
    const _pt = this.ghostPlankTier;
    const _hasTier = _pt >= 1;
    const _tierHex = _hasTier ? tierColor(_pt) : null;

    // Convert tier hex (#rrggbb) to rgb components for alpha-composited fills.
    let _tr = 0, _tg = 180, _tb = 60;
    if (_tierHex) {
      const _h = _tierHex.replace('#', '');
      _tr = parseInt(_h.substring(0, 2), 16);
      _tg = parseInt(_h.substring(2, 4), 16);
      _tb = parseInt(_h.substring(4, 6), 16);
    }

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

      const _canAfford = !isHovered || this.ghostCanAfford;
      // Tier-tinted colours when a blueprint is selected; default green otherwise.
      const fillColor   = isHovered
        ? (_canAfford
            ? `rgba(${_tr}, ${_tg}, ${_tb}, 0.70)`
            : 'rgba(230, 60, 40, 0.70)')
        : `rgba(${_tr}, ${_tg}, ${_tb}, ${_hasTier ? 0.45 : 0.35})`;
      const strokeColor = isHovered
        ? (_canAfford ? (_tierHex ?? '#00ff55') : '#ff3333')
        : (_tierHex ?? '#00cc44');
      const lineWidth   = isHovered ? 2.5 : 1.5;

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

        // Hovered: add a pulsing bright inner highlight (tier-tinted when blueprint active)
        if (isHovered) {
          const _hlCol = _hasTier ? `rgba(${_tr},${_tg},${_tb},1)` : '#aaffcc';
          this.ctx.save();
          this.ctx.globalAlpha = 0.35;
          this.drawCurvedPlank(
            { start: seg.curveStart, control: seg.curveControl, end: seg.curveEnd, t1: seg.t1, t2: seg.t2 },
            seg.thickness * 0.5,
            _hlCol,
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
          this.ctx.fillStyle = _hasTier ? `rgba(${_tr},${_tg},${_tb},1)` : '#aaffcc';
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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
    // Suppress fire overlays for ships under construction in a shipyard
    if (this._scaffoldedShips.has(ship.id)) return;
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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    // Scaffolded ships under construction — suppress plank status icons
    if (this._scaffoldedShips.has(ship.id)) return;

    // Ghost ships have no planks or decks — skip all status icons
    if (ship.shipType === SHIP_TYPE_GHOST) return;

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
      // Health=0 means destroyed — treat as absent (show missing icon)
      if ((pd.health ?? 1) > 0) presentKeys.add(`${pd.sectionName}_${pd.segmentIndex}`);
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
    const upperDeckMod = ship.modules.find(m => m.kind === 'deck' && m.deckId === 1);
    const lowerDeckMod = ship.modules.find(m => m.kind === 'deck' && m.deckId === 0);
    const anyDeckMod   = upperDeckMod ?? lowerDeckMod;
    if (!anyDeckMod) {
      // No deck present — draw a persistent orange warning at ship center
      this.drawMissingDeckIcon(0, 0, 22);
    } else if (upperDeckMod) {
      // Upper deck installed — show upper bar and a lower deck bar (depleted if absent)
      const udmd = upperDeckMod.moduleData as any;
      if (udmd && typeof udmd.health === 'number' && typeof udmd.maxHealth === 'number'
          && udmd.maxHealth > 0
          && (udmd.health < udmd.maxHealth || (udmd.targetHealth != null && udmd.targetHealth < udmd.maxHealth))) {
        const uTarget = udmd.targetHealth != null ? udmd.targetHealth / udmd.maxHealth : 1;
        this.drawDeckHealthBar(0, -5, udmd.health / udmd.maxHealth, uTarget);
      }
      // Lower deck bar: show actual health or 0 (depleted) if lower deck missing
      if (lowerDeckMod) {
        const ldmd = lowerDeckMod.moduleData as any;
        if (ldmd && typeof ldmd.health === 'number' && typeof ldmd.maxHealth === 'number'
            && ldmd.maxHealth > 0
            && (ldmd.health < ldmd.maxHealth || (ldmd.targetHealth != null && ldmd.targetHealth < ldmd.maxHealth))) {
          const lTarget = ldmd.targetHealth != null ? ldmd.targetHealth / ldmd.maxHealth : 1;
          this.drawDeckHealthBar(0, 5, ldmd.health / ldmd.maxHealth, lTarget);
        }
      } else {
        // No lower deck — show it as fully depleted
        this.drawDeckHealthBar(0, 5, 0);
      }
    } else {
      // Only lower deck present — show its bar at centre
      const dmd = lowerDeckMod!.moduleData as any;
      if (dmd && typeof dmd.health === 'number' && typeof dmd.maxHealth === 'number'
          && dmd.maxHealth > 0
          && (dmd.health < dmd.maxHealth || (dmd.targetHealth != null && dmd.targetHealth < dmd.maxHealth))) {
        const dTarget = dmd.targetHealth != null ? dmd.targetHealth / dmd.maxHealth : 1;
        this.drawDeckHealthBar(0, 0, dmd.health / dmd.maxHealth, dTarget);
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

  /** Small horizontal health bar drawn at ship-local (cx, cy) for the deck module.
   *  @param targetFraction  repair ceiling (target_health / max_health); default 1 = full. */
  private drawDeckHealthBar(cx: number, cy: number, fraction: number, targetFraction = 1): void {
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

    // Amber fill up to repair ceiling (only if ceiling is below max)
    const clampedTarget = Math.max(0, Math.min(1, targetFraction));
    if (clampedTarget < 0.999) {
      this.ctx.fillStyle = 'rgba(200,160,60,0.35)';
      this.ctx.beginPath();
      this.ctx.roundRect(x0, y0, Math.max(2, barW * clampedTarget), barH, 2);
      this.ctx.fill();
    }

    // Filled portion — gradient from orange (low) to green (full)
    const clampedFrac = Math.max(0, Math.min(1, fraction));
    const r = Math.round(255 * (1 - clampedFrac));
    const g = Math.round(200 * clampedFrac);
    this.ctx.fillStyle = `rgb(${r},${g},30)`;
    this.ctx.beginPath();
    this.ctx.roundRect(x0, y0, Math.max(2, barW * clampedFrac), barH, 2);
    this.ctx.fill();

    // Tick mark at repair ceiling (amber line, only if ceiling is below max)
    if (clampedTarget < 0.999) {
      const tx = x0 + barW * clampedTarget;
      this.ctx.strokeStyle = 'rgba(255,200,60,0.9)';
      this.ctx.lineWidth = 1.2;
      this.ctx.beginPath();
      this.ctx.moveTo(tx, y0 - 1);
      this.ctx.lineTo(tx, y0 + barH + 1);
      this.ctx.stroke();
    }

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
    strokeColor: string,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D = this.ctx
  ): void {
    const { start, control, end, t1, t2 } = curveData;
    const halfWidth = width / 2;
    
    const segments = 10;
    const points: Array<{x: number, y: number}> = [];
    for (let i = 0; i <= segments; i++) {
      const t = t1 + (t2 - t1) * (i / segments);
      points.push(this.getQuadraticPoint(start, control, end, t));
    }
    
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
      const perp = { x: -tangent.y, y: tangent.x };
      
      innerPoints.push({ x: curr.x + perp.x * halfWidth, y: curr.y + perp.y * halfWidth });
      outerPoints.push({ x: curr.x - perp.x * halfWidth, y: curr.y - perp.y * halfWidth });
    }
    
    ctx.beginPath();
    ctx.moveTo(innerPoints[0].x, innerPoints[0].y);
    for (let i = 1; i < innerPoints.length; i++) ctx.lineTo(innerPoints[i].x, innerPoints[i].y);
    for (let i = outerPoints.length - 1; i >= 0; i--) ctx.lineTo(outerPoints[i].x, outerPoints[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /**
   * Bake all straight+curved planks for a ship into an OffscreenCanvas in ship-local coords.
   * Re-bakes only when plank health buckets change (normally once per damage event, not every frame).
   * The sprite avoids per-frame save/restore + translate + rotate + fillRect × N planks.
   */
  private _getShipPlankSprite(
    ship: Ship,
    planks: Ship['modules'],
    plankBaseColor: string,
    plankStrokeBase: string,
    isGhostShip: boolean
  ): { canvas: OffscreenCanvas; ox: number; oy: number } | null {
    // Build cache key: baseColor + ghost flag + per-plank health bucket
    let key = `${plankBaseColor}:${isGhostShip ? 1 : 0}`;
    let hasAny = false;
    for (const plank of planks) {
      if (!plank.moduleData || plank.moduleData.kind !== 'plank') continue;
      const h  = plank.moduleData.health ?? 0;
      const mx = plank.moduleData.maxHealth || 10000;
      const bucket = h <= 0 ? -1 : Math.floor((h / mx) * 20);
      key += `:${bucket}`;
      if (h > 0) hasAny = true;
    }
    if (!hasAny) return null;

    const cached = this._shipPlankSprites.get(ship.id);
    if (cached && cached.key === key) return cached;

    // Hull spans roughly sternTip(-345) to bowTip(415) × -100 to +100, pad by 15.
    const W = 790, H = 230;
    const ox = 360, oy = 115;

    const canvas = new OffscreenCanvas(W, H);
    const sctx = canvas.getContext('2d')!;
    sctx.translate(ox, oy);

    for (const plank of planks) {
      if (!plank.moduleData || plank.moduleData.kind !== 'plank') continue;
      const plankData = plank.moduleData;
      if ((plankData.health ?? 0) <= 0) continue;

      const maxHealth  = plankData.maxHealth || 10000;
      const healthRatio = Math.max(0, plankData.health / maxHealth);
      const fillColor   = isGhostShip
        ? this.darkenByDamage('#1a2a3a', healthRatio)
        : this.darkenByDamage(plankBaseColor, healthRatio);
      const strokeColor = isGhostShip
        ? this.darkenByDamage('#003055', healthRatio)
        : this.darkenByDamage(plankStrokeBase, healthRatio);

      sctx.fillStyle   = fillColor;
      sctx.strokeStyle = strokeColor;
      sctx.lineWidth   = 1;

      if (plankData.isCurved && plankData.curveData) {
        this.drawCurvedPlank(plankData.curveData, plankData.width, fillColor, strokeColor, sctx);
      } else {
        sctx.save();
        sctx.translate(plank.localPos.x, plank.localPos.y);
        sctx.rotate(plank.localRot);
        const hl = plankData.length / 2;
        const hw = plankData.width  / 2;
        sctx.fillRect(-hl, -hw, plankData.length, plankData.width);
        sctx.strokeRect(-hl, -hw, plankData.length, plankData.width);
        // Grain lines baked at zoom=1 detail
        const grainCount = Math.max(1, Math.floor(plankData.length / 10));
        if (grainCount > 1) {
          sctx.strokeStyle  = strokeColor;
          sctx.lineWidth    = 0.5;
          sctx.globalAlpha  = 0.3;
          sctx.beginPath();
          for (let i = 1; i < grainCount; i++) {
            const x = -hl + (i * plankData.length / grainCount);
            sctx.moveTo(x, -hw);
            sctx.lineTo(x,  hw);
          }
          sctx.stroke();
          sctx.globalAlpha = 1;
        }
        sctx.restore();
      }
    }

    const entry = { canvas, key, ox, oy };
    this._shipPlankSprites.set(ship.id, entry);
    return entry;
  }

  /** Standard above-deck view: one cached blit for hull + planks (not lower-deck or high-zoom). */
  private _canUseShipStaticComposite(ship: Ship, zoom: number): boolean {
    if (ship.shipType === SHIP_TYPE_GHOST) return false;
    if (!ship.modules.some(m => m.kind === 'deck')) return false;
    if (this._lowerDeckShipId === ship.id) return false;
    if (zoom > 3) return false;
    return true;
  }

  /**
   * Draw cached hull + planks in one pass (two aligned blits, one transform setup).
   * Reuses per-layer OffscreenCanvas caches; dynamic overlays drawn on top.
   */
  private drawShipStaticComposite(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const hasUpperDeck = ship.modules.some(m => m.kind === 'deck' && m.deckId === 1);
    const hasDeck = ship.modules.some(m => m.kind === 'deck');
    const topDeck = ship.modules.find(m => m.kind === 'deck' && m.deckId === 1)
                 ?? ship.modules.find(m => m.kind === 'deck');
    const baseHullColor = hasUpperDeck ? '#DEB887' : '#A87040';
    const dmd = topDeck?.moduleData as any;
    let fillColor = baseHullColor;
    if (dmd && typeof dmd.health === 'number' && typeof dmd.maxHealth === 'number' && dmd.maxHealth > 0) {
      fillColor = this.darkenByDamage(baseHullColor, Math.max(0, dmd.health / dmd.maxHealth));
    }

    const planks = ship.modules.filter(m => m.kind === 'plank');
    const plankBaseColor  = hasUpperDeck ? '#8B7355' : '#6B5232';
    const plankStrokeBase = hasUpperDeck ? '#4A3020' : '#3A2010';

    const hullSprite = this._getShipHullSprite(ship, hasUpperDeck, hasDeck, fillColor);
    if (!hullSprite) {
      this.drawShipHull(ship, camera);
      this.drawShipPlanks(ship, camera);
      return;
    }
    const plankSprite = this._getShipPlankSprite(ship, planks, plankBaseColor, plankStrokeBase, false);

    this.ctx.save();
    const _deckAlpha = this._lowerDeckShipId === ship.id ? this._upperDeckFade : 1.0;
    if (phase1Alpha * _deckAlpha < 1) this.ctx.globalAlpha = phase1Alpha * _deckAlpha;

    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    // Each layer keeps its own bake origin so hull and planks stay aligned in ship space.
    this.ctx.drawImage(hullSprite.canvas, -hullSprite.ox, -hullSprite.oy);
    if (plankSprite) {
      this.ctx.drawImage(plankSprite.canvas, -plankSprite.ox, -plankSprite.oy);
    }

    this._drawShipPlankDynamicOverlays(ship, planks);

    this.ctx.restore();
  }

  /** Hover glow + quality-tier tint for placed planks (not baked into static caches). */
  private _drawShipPlankDynamicOverlays(ship: Ship, planks: Ship['modules']): void {
    const _hoveredId = this.hoveredModule?.module?.id;
    for (const plank of planks) {
      if (!plank.moduleData || plank.moduleData.kind !== 'plank') continue;
      const plankData = plank.moduleData;
      if (plankData.health <= 0) continue;

      const isHovered = plank.id === _hoveredId;
      const _qt = plank.qualityTier;
      const _hasQT = typeof _qt === 'number' && _qt >= 1;

      if (!isHovered && !_hasQT) continue;

      const isCurved = plankData.isCurved || false;
      const pos = plank.localPos;
      const rot = plank.localRot;
      const length = plankData.length;
      const width  = plankData.width;

      this.ctx.save();

      if (isHovered) {
        const _hlCol = _hasQT ? tierColor(_qt!) : '#aaccff';
        this.ctx.shadowColor = _hlCol;
        this.ctx.shadowBlur  = 8;
        this.ctx.strokeStyle = _hlCol;
        this.ctx.lineWidth   = 2;
        this.ctx.globalAlpha = 0.55;
        if (isCurved && plankData.curveData) {
          this.drawCurvedPlank(plankData.curveData, width, 'transparent', _hlCol);
        } else {
          this.ctx.save();
          this.ctx.translate(pos.x, pos.y);
          this.ctx.rotate(rot);
          this.ctx.strokeRect(-length / 2, -width / 2, length, width);
          this.ctx.restore();
        }
        this.ctx.globalAlpha = 1.0;
        this.ctx.shadowBlur  = 0;
      }

      if (_hasQT) {
        const _col = tierColor(_qt!);
        const _h = _col.replace('#', '');
        const _r = parseInt(_h.substring(0, 2), 16);
        const _g = parseInt(_h.substring(2, 4), 16);
        const _b = parseInt(_h.substring(4, 6), 16);
        const _tintA = isHovered ? 0.28 : 0.15;
        const _tintFill = `rgba(${_r},${_g},${_b},${_tintA})`;
        this.ctx.globalAlpha = 1.0;
        if (isCurved && plankData.curveData) {
          this.drawCurvedPlank(plankData.curveData, width * 0.55, _tintFill, 'transparent');
        } else {
          this.ctx.save();
          this.ctx.translate(pos.x, pos.y);
          this.ctx.rotate(rot);
          this.ctx.fillStyle = _tintFill;
          this.ctx.fillRect(-length / 2 + 2, -width / 2 + 1, length - 4, width - 2);
          this.ctx.restore();
        }
      }

      this.ctx.restore();
    }
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
    if (this._playerDeckLevel !== 1) return; // fixed cannon slots are upper-deck (deck_id=1)

    for (const ship of worldState.ships) {
      const base = this._shipModuleBase(ship);
      if (base === null) continue;

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
          const rot = i < 3 ? Math.PI : 0;
          this.hoveredCannonSlot = { ship, cannonIndex: i, localX: cx, localY: cy, rot };
          return;
        }
      }
    }
  }

  /**
   * In cannon build mode: check whether the cursor is over a gunport that has no cannon yet.
   * If so, snap to that gunport position so the player can place a cannon there.
   */
  private detectHoveredGunportCannonSnap(worldState: WorldState): void {
    this.hoveredGunportCannonSnap = null;
    if (!this.mouseWorldPos) return;

    for (const ship of worldState.ships) {
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      // Gunport cannon ghosts are on the lower deck (deck 0).
      // Show when player is on deck 0 OR when the ship has no INTACT upper deck.
      // A deck module with health=0 is destroyed (kept in ship.modules with hp=0) — treat it
      // as absent so hover detection works without requiring the player to be on deck 0.
      const _shipHasUpperDeck = ship.modules.some(
        m => m.kind === 'deck' && m.deckId === 1 && (m.health === undefined || m.health > 0),
      );
      if (this._playerDeckLevel !== 0 && _shipHasUpperDeck) continue;
      for (const mod of ship.modules) {
        if (mod.kind !== 'gunport') continue;
        // Skip if a cannon is already linked to this gunport's snap index
        const gpData = mod.moduleData as import('../../sim/modules').GunportModuleData;
        const hasCannon = gpData.snapIndex >= 0 && gpData.snapIndex <= 11 && ship.modules.some(
          m => m.kind === 'cannon'
            && (m.moduleData as import('../../sim/modules').CannonModuleData).gunportSnapIdx === gpData.snapIndex,
        );
        if (hasCannon) continue;

        const stowedY = mod.localPos.y + (mod.localPos.y < 0 ? 40 : -40);
        const ddx = localX - mod.localPos.x;
        const ddy = localY - stowedY;
        if (Math.abs(ddx) <= 20 && Math.abs(ddy) <= 20) {
          this.hoveredGunportCannonSnap = { ship, module: mod };
          return;
        }
      }
    }
  }

  /**
   * Compute the helm-relative base ID for slot math without requiring the helm to be present.
   *
   * All module IDs are encoded as  (ship_seq << 8) | offset.  The helm is always at offset
   * 0x02.  We can reconstruct the correct base from ANY module on the ship:
   *   base = (anyModule.id & 0xFF00) | 0x02
   *
   * Returns null only when the ship has no modules at all (brand-new, pre-init state).
   */
  private _shipModuleBase(ship: Ship): number | null {
    const helm = ship.modules.find(m => m.kind === 'helm');
    if (helm) return helm.id;
    if (ship.modules.length > 0) return (ship.modules[0].id & 0xFF00) | 0x02;
    return null;
  }

  /**
   * Draw ghost outlines at missing cannon positions (cannon build mode).
   * @param gunportOnly When true, skip the fixed-position helm-offset slots and only draw
   *   ghost cannons at gunport snap positions (used in gunport build mode preview).
   */
  private drawMissingCannonGhosts(ship: Ship, camera: Camera, gunportOnly = false): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const base = this._shipModuleBase(ship);
    if (base === null) return;

    const presentIds = new Set<number>();
    for (const m of ship.modules) presentIds.add(m.id);

    this.ctx.save();
    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;

    // Fixed 6 broadside slots are on deck_id=1 (upper deck) — only show when on upper deck
    if (!gunportOnly && this._playerDeckLevel === 1) for (let i = 0; i < 6; i++) {
      if (presentIds.has(base + 1 + i)) continue;

      const cx = RenderSystem.CANNON_XS[i % 3];
      const cy = i < 3 ? 75 : -75;
      const rot = i < 3 ? Math.PI : 0;

      const isHovered = this.hoveredCannonSlot?.ship === ship &&
                        this.hoveredCannonSlot?.cannonIndex === i;

      this.ctx.save();
      this.ctx.translate(cx, cy);
      this.ctx.rotate(rot);

      const _cannonCanAfford = !isHovered || this.ghostCanAfford;
      // Ghost cannon base rect — unified green palette
      this.ctx.strokeStyle = isHovered ? (_cannonCanAfford ? '#66ee99' : '#ff4444') : 'rgba(80,210,130,0.65)';
      this.ctx.fillStyle   = isHovered ? (_cannonCanAfford ? 'rgba(40,160,80,0.45)' : 'rgba(200,40,40,0.45)') : 'rgba(40,130,70,0.20)';
      this.ctx.lineWidth   = isHovered ? lw * 2 : lw;
      this.ctx.setLineDash(isHovered ? [] : [4, 3]);
      this.ctx.beginPath();
      this.ctx.rect(-11, -7.5, 22, 15); // base (matches actual cannon 22×15)
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      // Ghost barrel stub
      this.ctx.strokeStyle = isHovered ? '#99ffbb' : 'rgba(80,200,120,0.45)';
      this.ctx.fillStyle   = 'transparent';
      this.ctx.lineWidth   = lw;
      this.ctx.beginPath();
      this.ctx.rect(-8, -40, 16, 40); // barrel (matches actual cannon 16×40)
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

    // ── Ghost cannons at gunport positions (no cannon installed yet) ──────
    // Show when player is on deck 0, OR when the ship has no INTACT upper deck.
    // A deck module with health=0 is destroyed (kept in ship.modules with hp=0) — treat it
    // as absent so ghosts appear without requiring the player to be on deck 0.
    const gpHalfWGhost = 11; // match visual gpHalfW
    const _gpShipHasUpperDeck = ship.modules.some(
      m => m.kind === 'deck' && m.deckId === 1 && (m.health === undefined || m.health > 0),
    );
    if (this._playerDeckLevel === 0 || !_gpShipHasUpperDeck) for (const mod of ship.modules) {
      if (mod.kind !== 'gunport') continue;
      // Skip if a cannon is already linked to this gunport (match by snap_idx, not position,
      // because the cannon is now far from the gunport hull edge when stowed/deployed).
      const gpData = mod.moduleData as import('../../sim/modules').GunportModuleData;
      const hasCannon = gpData.snapIndex >= 0 && gpData.snapIndex <= 11 && ship.modules.some(
        m => m.kind === 'cannon'
          && (m.moduleData as import('../../sim/modules').CannonModuleData).gunportSnapIdx === gpData.snapIndex,
      );
      if (hasCannon) continue;

      const isHoveredGp = this.hoveredGunportCannonSnap?.module === mod;
      // Rotation: starboard (y < 0) rot=0 → barrel points -y (outward); port (y > 0) rot=π → barrel points +y (outward)
      const rot = mod.localPos.y < 0 ? 0 : Math.PI;
      // Stowed position: 40px inboard of hull edge (gpY=-90 → ghostY=-50, gpY=+90 → ghostY=+50)
      const ghostStowedY = mod.localPos.y + (mod.localPos.y < 0 ? 40 : -40);

      this.ctx.save();
      this.ctx.translate(mod.localPos.x, ghostStowedY);
      this.ctx.rotate(rot);

      const _gpCanAfford = !isHoveredGp || this.ghostCanAfford;
      // Base rect
      this.ctx.strokeStyle = isHoveredGp ? (_gpCanAfford ? '#66ee99' : '#ff4444') : 'rgba(80,210,130,0.65)';
      this.ctx.fillStyle   = isHoveredGp ? (_gpCanAfford ? 'rgba(40,160,80,0.45)' : 'rgba(200,40,40,0.45)') : 'rgba(40,130,70,0.20)';
      this.ctx.lineWidth   = isHoveredGp ? lw * 2 : lw;
      this.ctx.setLineDash(isHoveredGp ? [] : [4, 3]);
      this.ctx.beginPath();
      this.ctx.rect(-gpHalfWGhost, -7.5, gpHalfWGhost * 2, 15);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      // Barrel stub (pointing outward — negative y = outward when rot=π, positive y when rot=0)
      this.ctx.strokeStyle = isHoveredGp ? '#99ffbb' : 'rgba(80,200,120,0.45)';
      this.ctx.fillStyle   = 'transparent';
      this.ctx.lineWidth   = lw;
      this.ctx.beginPath();
      this.ctx.rect(-6, -36, 12, 36);
      this.ctx.stroke();

      if (isHoveredGp) {
        this.ctx.strokeStyle = '#88ff99';
        this.ctx.lineWidth = lw * 1.5;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 20, 0, Math.PI * 2);
        this.ctx.stroke();
        // Label
        this.ctx.rotate(-rot); // unrotate for text
        const fontSize = Math.max(5, Math.round(7 / cameraState.zoom));
        this.ctx.font = `bold ${fontSize}px Georgia, serif`;
        this.ctx.fillStyle = '#ffffffcc';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = mod.localPos.y < 0 ? 'bottom' : 'top';
        const labelY = mod.localPos.y < 0 ? -18 : 18;
        this.ctx.fillText('Place Cannon', 0, labelY);
      }

      this.ctx.restore();
    }

    this.ctx.restore();
  }

  // Mast layout: mast_xs[3] = {165, -35, -235}, all at y=0
  static readonly MAST_XS = [165, -35, -235];
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
      const base = this._shipModuleBase(ship);
      if (base === null) continue;

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
      const base = this._shipModuleBase(ship);
      if (base === null) continue;

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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const base = this._shipModuleBase(ship);
    if (base === null) return;

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

      const _mastCanAfford = !isHovered || this.ghostCanAfford;
      // Ghost mast circle — unified green palette (matches plan ghost markers)
      this.ctx.beginPath();
      this.ctx.arc(mx, 0, 14, 0, Math.PI * 2);
      this.ctx.fillStyle   = isHovered ? (_mastCanAfford ? 'rgba(40,160,80,0.45)' : 'rgba(200,40,40,0.45)') : 'rgba(40,130,70,0.20)';
      this.ctx.strokeStyle = isHovered ? (_mastCanAfford ? '#66ee99' : '#ff4444') : 'rgba(80,210,130,0.65)';
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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

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
      if (ship.shipType === SHIP_TYPE_GHOST) continue; // ghost ships have no deck
      const decks = ship.modules.filter(m => m.kind === 'deck');
      const hasLower = decks.some(m => m.deckId === 0);
      const hasUpper = decks.some(m => m.deckId === 1);
      if (hasLower && hasUpper) continue; // both present — nothing to place

      // Always respect the T-key override; default to lower (0) first.
      const selectedLevel = this.deckLevelOverride >= 0 ? this.deckLevelOverride : 0;

      // Only register a hover slot if the selected level is actually missing
      const selectedIsMissing = selectedLevel === 0 ? !hasLower : !hasUpper;
      if (!selectedIsMissing) continue;

      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      // Hit-test against the ship's walkable deck area (slightly inset from full hull)
      if (Math.abs(localX) <= 280 && Math.abs(localY) <= 75) {
        this.hoveredDeckSlot = { ship, deckLevel: selectedLevel };
        return;
      }
    }
  }

  /**
   * Draw ghost deck outlines for any missing deck levels (deck build mode).
   * Lower deck (deckId=0) uses brown/wood tones; upper deck (deckId=1) uses
   * amber/gold tones with a dashed border to distinguish the two layers.
   */
  private drawMissingDeckGhost(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
    if (ship.shipType === SHIP_TYPE_GHOST) return; // ghost ships have no deck to place

    const decks    = ship.modules.filter(m => m.kind === 'deck');
    const hasLower = decks.some(m => m.deckId === 0);
    const hasUpper = decks.some(m => m.deckId === 1);
    if (hasLower && hasUpper) return; // both present — nothing to draw

    // Determine which deck level is currently selected via T-key override
    const selectedLevel = this.deckLevelOverride >= 0 ? this.deckLevelOverride : 0;
    // If the selected level is already present, flip to the missing one
    const bothMissing = !hasLower && !hasUpper;
    const displayLevel = bothMissing
      ? selectedLevel
      : (!hasLower ? 0 : 1);

    this.ctx.save();
    const screenPos  = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;
    const w  = 480, h = 120, r = 12;
    const x  = -240, y = -60;

    const drawLevel = (deckLevel: number, isPresent: boolean): void => {
      if (isPresent) return;
      const isHovered = this.hoveredDeckSlot?.ship === ship
                     && this.hoveredDeckSlot?.deckLevel === deckLevel;
      const isUpper   = deckLevel === 1;

      // Color palette: lower=wood-brown, upper=amber-gold
      const _deckCanAfford = !isHovered || this.ghostCanAfford;
      const fillBase    = isUpper ? 'rgba(180,150,40,0.14)' : 'rgba(140,80,30,0.12)';
      const fillHover   = _deckCanAfford ? (isUpper ? 'rgba(200,165,45,0.32)' : 'rgba(180,110,40,0.30)') : 'rgba(200,40,40,0.32)';
      const strokeBase  = isUpper ? 'rgba(210,175,55,0.65)' : 'rgba(200,120,50,0.55)';
      const strokeHover = _deckCanAfford ? (isUpper ? '#ddcc33' : '#dd8833') : '#cc2222';
      const plankBase   = isUpper ? 'rgba(200,170,60,0.28)' : 'rgba(180,110,50,0.25)';
      const plankHover  = _deckCanAfford ? (isUpper ? 'rgba(210,185,80,0.50)' : 'rgba(220,150,80,0.45)') : 'rgba(220,60,60,0.50)';
      const ringCol     = _deckCanAfford ? (isUpper ? '#ffee77' : '#ffbb66') : '#ff4444';
      const labelCol    = isHovered ? (_deckCanAfford ? '#ffffff' : '#ffaaaa')
                                    : (isUpper ? 'rgba(220,200,100,0.70)' : 'rgba(200,150,80,0.65)');

      // Rounded-rect path
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

      this.ctx.fillStyle   = isHovered ? fillHover   : fillBase;
      this.ctx.strokeStyle = isHovered ? strokeHover : strokeBase;
      this.ctx.lineWidth   = isHovered ? lw * 2      : lw;
      if (isUpper) this.ctx.setLineDash([6 / cameraState.zoom, 4 / cameraState.zoom]);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      // Plank lines
      this.ctx.strokeStyle = isHovered ? plankHover : plankBase;
      this.ctx.lineWidth   = lw * 0.8;
      const plankSpacing = 20;
      for (let py2 = y + plankSpacing; py2 < y + h; py2 += plankSpacing) {
        this.ctx.beginPath();
        this.ctx.moveTo(x + 2, py2);
        this.ctx.lineTo(x + w - 2, py2);
        this.ctx.stroke();
      }

      // Centred label
      const fontSize = Math.max(9, Math.round(11 / cameraState.zoom));
      this.ctx.font          = `bold ${fontSize}px Georgia, serif`;
      this.ctx.fillStyle     = labelCol;
      this.ctx.textAlign     = 'center';
      this.ctx.textBaseline  = 'middle';
      const deckName = deckLevel === 0 ? '[ LOWER DECK ]' : '[ UPPER DECK ]';
      // When both decks are missing show a T-cycle hint alongside the label
      const cycleHint = bothMissing ? '  [T]' : '';
      this.ctx.fillText(deckName + cycleHint, 0, 0);

      // Hover: outer glow ring
      if (isHovered) {
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
        this.ctx.strokeStyle = ringCol;
        this.ctx.lineWidth   = lw * 1.5;
        this.ctx.stroke();
      }
    };

    // Only draw the currently-selected deck level, not both simultaneously.
    // When both are missing, T cycles which one is shown.
    drawLevel(displayLevel, displayLevel === 0 ? hasLower : hasUpper);

    this.ctx.restore();
  }

  // Ramp snap point positions on the brigantine (ship-local x, y=0)
  private static readonly RAMP_SNAP_POINTS: { x: number; y: number }[] = [
    { x: 220, y: 0 },   // forward ramp (near bow quarter)
    { x: -140, y: 0 },  // aft ramp (near stern quarter)
  ];

  /**
   * Detect which ramp snap point the cursor is nearest to (within hover radius).
   * Skips snap points that already have a ramp module.
   */
  private detectHoveredRampSlot(worldState: WorldState): void {
    this.hoveredRampSlot = null;
    if (!this.mouseWorldPos) return;

    const HALF = 25; // ramp is a 50×50 square (±25 in each axis)

    for (const ship of worldState.ships) {
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      for (let i = 0; i < RenderSystem.RAMP_SNAP_POINTS.length; i++) {
        const sp = RenderSystem.RAMP_SNAP_POINTS[i];
        // Skip snap points already occupied by a ramp or hatch cover module
        const occupied = ship.modules.some(
          m => (m.kind === 'ramp' || m.kind === 'hatch_cover')
            && Math.abs(m.localPos.x - sp.x) < 20
            && Math.abs(m.localPos.y - sp.y) < 20
        );
        if (occupied) continue;

        if (Math.abs(localX - sp.x) <= HALF && Math.abs(localY - sp.y) <= HALF) {
          this.hoveredRampSlot = { ship, snapIndex: i, localPos: sp };
          return;
        }
      }
    }
  }

  /**
   * Draw deck holes at the ramp snap points on the top deck (deckId=1).
   * Holes are always open when the top deck is present.
   * - No ramp placed: dark empty shaft opening
   * - Ramp placed:    dark hole with horizontal step lines
   */

  /**
   * Draw a player sprite clipped to the ship hull polygon.
   * Used when the player is on the lower deck so they can't visually overflow the hull boundary.
   */
  private _drawPlayerWithHullClip(player: Player, ship: Ship, worldState: WorldState, camera: Camera): void {
    const screenPos = camera.worldToScreen(ship.position);
    const camState  = camera.getState();
    const angle     = ship.rotation - camState.rotation;
    const cos       = Math.cos(angle);
    const sin       = Math.sin(angle);
    const zoom      = camState.zoom;

    this.ctx.save();
    if (ship.hull.length >= 3) {
      this.ctx.beginPath();
      for (let i = 0; i < ship.hull.length; i++) {
        const sx = screenPos.x + (ship.hull[i].x * cos - ship.hull[i].y * sin) * zoom;
        const sy = screenPos.y + (ship.hull[i].x * sin + ship.hull[i].y * cos) * zoom;
        if (i === 0) this.ctx.moveTo(sx, sy);
        else         this.ctx.lineTo(sx, sy);
      }
      this.ctx.closePath();
      this.ctx.clip();
    }
    this.drawPlayer(player, worldState, camera);
    this.ctx.restore();
  }

  /**
   * Apply a screen-space hull clip and invoke fn() inside it.
   * Used to render lower-deck modules clipped to the ship hull at layer 1.
   */
  private _withShipHullClip(ship: Ship, camera: Camera, fn: () => void): void {
    if (ship.hull.length < 3) { fn(); return; }
    const screenPos = camera.worldToScreen(ship.position);
    const camState  = camera.getState();
    const angle     = ship.rotation - camState.rotation;
    const cos       = Math.cos(angle);
    const sin       = Math.sin(angle);
    const zoom      = camState.zoom;
    this.ctx.save();
    this.ctx.beginPath();
    for (let i = 0; i < ship.hull.length; i++) {
      const sx = screenPos.x + (ship.hull[i].x * cos - ship.hull[i].y * sin) * zoom;
      const sy = screenPos.y + (ship.hull[i].x * sin + ship.hull[i].y * cos) * zoom;
      if (i === 0) this.ctx.moveTo(sx, sy);
      else         this.ctx.lineTo(sx, sy);
    }
    this.ctx.closePath();
    this.ctx.clip();
    fn();
    this.ctx.restore();
  }

  /**
   * Runs at layer 1, sub-priority 1 — after hull fill, before planks.
   * If the lower deck is missing, renders a dark void so the gap reads as depth.
   */
  private drawLowerDeckFloor(ship: Ship, camera: Camera): void {
    const hasUpperDeck = ship.modules.some(m => m.kind === 'deck' && m.deckId === 1);
    if (!hasUpperDeck) return;
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const isPlayerBelow = this._lowerDeckShipId === ship.id;
    const lowerDeckMod  = ship.modules.find(m => m.kind === 'deck' && m.deckId === 0);
    const hasLowerDeck  = lowerDeckMod !== undefined;
    const lowerDeckData = lowerDeckMod?.moduleData as any;
    const lowerDeckHealthRatio = (lowerDeckData && typeof lowerDeckData.health === 'number'
        && typeof lowerDeckData.maxHealth === 'number' && lowerDeckData.maxHealth > 0)
        ? Math.max(0, lowerDeckData.health / lowerDeckData.maxHealth)
        : 1;
    const lowerDeckFloorColor = this.darkenByDamage('#5c3d1e', lowerDeckHealthRatio);
    const { lowerDeckFloodTint, phase1Alpha } = this.computeSinkState(ship);
    const lowerFloodAlpha = lowerDeckFloodTint * 0.55 * (phase1Alpha < 1 ? phase1Alpha : 1);

    this.ctx.save();
    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1 / cameraState.zoom;

    const drawRampVisual = (sp: { x: number; y: number }, localRot: number) => {
      this.drawRampVisualAt(sp, localRot, lw, 1.0);
    };

    if (isPlayerBelow && ship.hull.length >= 3) {
      // Player is on lower deck — render full hull-clipped floor then ramps on top
      this.ctx.save();
      this.ctx.beginPath();
      for (let i = 0; i < ship.hull.length; i++) {
        if (i === 0) this.ctx.moveTo(ship.hull[i].x, ship.hull[i].y);
        else         this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
      }
      this.ctx.closePath();
      this.ctx.clip();

      if (hasLowerDeck) {
        this.ctx.fillStyle = lowerDeckFloorColor;
        this.ctx.fill();

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const v of ship.hull) {
          if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
        }
        this.ctx.strokeStyle = '#3d2610';
        this.ctx.lineWidth = lw;
        // Batch all grain lines into one path → one GPU stroke() call instead of N
        this.ctx.beginPath();
        for (let y = minY + 12; y < maxY; y += 12) {
          this.ctx.moveTo(minX, y); this.ctx.lineTo(maxX, y);
        }
        this.ctx.stroke();
        this._drawDeckFloodFill(ship, 0, lowerDeckFloodTint, phase1Alpha, lowerDeckMod);
      } else {
        this.ctx.fillStyle = '#1a0e06';
        this.ctx.fill();
      }
      this.ctx.restore();

      // Draw placed ramps over the floor (outside the hull clip)
      for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
        const rampMod = ship.modules.find(
          m => m.kind === 'ramp' && Math.abs(m.localPos.x - sp.x) < 20 && Math.abs(m.localPos.y - sp.y) < 20
        );
        if (rampMod) drawRampVisual(sp, rampMod.localRot);
      }
    } else {
      // Normal (above-deck) view: only draw inside the 50×50 hole squares
      for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
        const rx = sp.x - 25, ry = sp.y - 25;
        const rampMod = ship.modules.find(
          m => m.kind === 'ramp' && Math.abs(m.localPos.x - sp.x) < 20 && Math.abs(m.localPos.y - sp.y) < 20
        );
        const hatchMod = ship.modules.find(
          m => m.kind === 'hatch_cover' && Math.abs(m.localPos.x - sp.x) < 20 && Math.abs(m.localPos.y - sp.y) < 20
        );

        if (rampMod) {
          drawRampVisual(sp, rampMod.localRot);
        } else if (hatchMod) {
          // Solid sealed hatch — looks like regular deck planking
          this.drawHatchCoverAt(sp, lw);
        } else if (hasLowerDeck) {
          this.ctx.fillStyle = lowerDeckFloorColor;
          this.ctx.fillRect(rx, ry, 50, 50);
          this.ctx.strokeStyle = '#3d2610';
          this.ctx.lineWidth = lw;
          for (let p = 1; p < 5; p++) {
            const yy = ry + (p / 5) * 50;
            this.ctx.beginPath();
            this.ctx.moveTo(rx, yy); this.ctx.lineTo(rx + 50, yy);
            this.ctx.stroke();
          }
          this.ctx.strokeStyle = '#3d2608';
          this.ctx.lineWidth = lw * 2;
          this.ctx.strokeRect(rx, ry, 50, 50);
          if (lowerDeckFloodTint > 0) {
            this.ctx.save();
            this.ctx.globalAlpha = lowerFloodAlpha;
            this.ctx.fillStyle = '#1a6eb5';
            this.ctx.fillRect(rx, ry, 50, 50);
            this.ctx.fillStyle = 'rgba(170,230,255,0.45)';
            this.ctx.fillRect(rx + 2, ry + 2, 46, 3);
            this.ctx.restore();
          }
        } else {
          const grad = this.ctx.createLinearGradient(rx, ry, rx, ry + 50);
          grad.addColorStop(0, '#1a0e06');
          grad.addColorStop(1, '#2d1a0a');
          this.ctx.fillStyle = grad;
          this.ctx.fillRect(rx, ry, 50, 50);
          this.ctx.strokeStyle = '#3d2608';
          this.ctx.lineWidth = lw * 2;
          this.ctx.strokeRect(rx, ry, 50, 50);
        }
      }
    }

    this.ctx.restore();
  }

  /**
   * Bake the upper-deck cover (hull polygon fill + grain) into an OffscreenCanvas.
   * Re-baked only when deck health bucket changes.
   */
  private _getShipUpperDeckSprite(ship: Ship): { canvas: OffscreenCanvas; ox: number; oy: number } | null {
    if (ship.hull.length < 3) return null;

    const topDeck = ship.modules.find(m => m.kind === 'deck' && m.deckId === 1)
                 ?? ship.modules.find(m => m.kind === 'deck');
    const dmd = topDeck?.moduleData as any;
    let fillColor = '#DEB887';
    if (dmd && typeof dmd.health === 'number' && typeof dmd.maxHealth === 'number' && dmd.maxHealth > 0) {
      fillColor = this.darkenByDamage(fillColor, Math.max(0, dmd.health / dmd.maxHealth));
    }
    const key = fillColor;

    const cached = this._shipUpperDeckSprites.get(ship.id);
    if (cached && cached.key === key) return cached;

    const W = 790, H = 230, ox = 360, oy = 115;
    const canvas = new OffscreenCanvas(W, H);
    const sctx = canvas.getContext('2d')!;
    sctx.translate(ox, oy);

    sctx.fillStyle = fillColor;
    sctx.beginPath();
    sctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    for (let i = 1; i < ship.hull.length; i++) sctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    sctx.closePath();
    for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
      sctx.rect(sp.x - 25, sp.y - 25, 50, 50);
    }
    sctx.fill('evenodd');

    // Grain lines (baked at zoom=1 lineWidth)
    sctx.save();
    sctx.beginPath();
    sctx.moveTo(ship.hull[0].x, ship.hull[0].y);
    for (let i = 1; i < ship.hull.length; i++) sctx.lineTo(ship.hull[i].x, ship.hull[i].y);
    sctx.closePath();
    for (const sp of RenderSystem.RAMP_SNAP_POINTS) {
      sctx.rect(sp.x - 25, sp.y - 25, 50, 50);
    }
    sctx.clip('evenodd');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of ship.hull) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    sctx.strokeStyle = '#b8824a';
    sctx.lineWidth = 1;
    sctx.beginPath();
    for (let y = minY + 12; y < maxY; y += 12) {
      sctx.moveTo(minX, y); sctx.lineTo(maxX, y);
    }
    sctx.stroke();
    sctx.restore();

    const entry = { canvas, key, ox, oy };
    this._shipUpperDeckSprites.set(ship.id, entry);
    return entry;
  }

  /**
   * Solid upper-deck cover drawn at layer 2.
   * Fills the hull polygon (with ramp/hatch holes) with the deck surface colour so that
   * lower-deck cannons, gunports, and other layer-1 content are fully hidden when the
   * player is not below deck — even through gaps between individual plank boards.
   */
  private drawUpperDeckCover(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
    if (ship.hull.length < 3) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();

    this.ctx.save();
    if (phase1Alpha < 1) this.ctx.globalAlpha = phase1Alpha;
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    // Blit the pre-baked hull polygon + grain (replaces 3× hull polygon rebuilds).
    const sprite = this._getShipUpperDeckSprite(ship);
    if (sprite) {
      this.ctx.drawImage(sprite.canvas, -sprite.ox, -sprite.oy);
    } else {
      // Fallback for very short hull arrays
      const topDeck = ship.modules.find(m => m.kind === 'deck' && m.deckId === 1)
                   ?? ship.modules.find(m => m.kind === 'deck');
      const dmd = topDeck?.moduleData as any;
      let fillColor = '#DEB887';
      if (dmd && typeof dmd.health === 'number' && typeof dmd.maxHealth === 'number' && dmd.maxHealth > 0) {
        fillColor = this.darkenByDamage(fillColor, Math.max(0, dmd.health / dmd.maxHealth));
      }
      this.ctx.fillStyle = fillColor;
      this.ctx.beginPath();
      this.ctx.moveTo(ship.hull[0].x, ship.hull[0].y);
      for (let i = 1; i < ship.hull.length; i++) this.ctx.lineTo(ship.hull[i].x, ship.hull[i].y);
      this.ctx.closePath();
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  /**
   * Draw gunport door overlays for a ship.
   * Queued at layer 1 priority 4 — only when the local player is on this ship's lower deck.
   * The upper-deck cover at layer 2 hides them from any other viewpoint (option B).
   */
  private drawGunportOverlays(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();

    this.ctx.save();
    if (phase1Alpha < 1) this.ctx.globalAlpha = phase1Alpha;
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const gpHalfW = 11;
    const gpHalfH = 5;
    const doorExt = 14;

    for (const mod of ship.modules) {
      if (mod.kind !== 'gunport') continue;
      if (mod.moduleData?.kind !== 'gunport') continue;
      const gx = mod.localPos.x;
      const gy = mod.localPos.y;
      const isOpen = (mod.moduleData as any).isOpen ?? false;
      this.ctx.save();
      this.ctx.translate(gx, gy);
      if (isOpen) {
        // Dark hole
        this.ctx.fillStyle = '#0e0808';
        this.ctx.fillRect(-gpHalfW, -gpHalfH, gpHalfW * 2, gpHalfH * 2);
        this.ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        this.ctx.lineWidth = 0.8;
        this.ctx.strokeRect(-gpHalfW, -gpHalfH, gpHalfW * 2, gpHalfH * 2);
        // Door panel swung outward (outside hull, so not covered by layer-2 fill)
        const outDir = gy < 0 ? -1 : 1;
        const hingeY = outDir * gpHalfH;
        const panelY = outDir < 0 ? hingeY - doorExt : hingeY;
        this.ctx.fillStyle = '#7a5c2a';
        this.ctx.fillRect(-gpHalfW, panelY, gpHalfW * 2, doorExt);
        this.ctx.strokeStyle = '#4a3010';
        this.ctx.lineWidth = 0.8;
        this.ctx.strokeRect(-gpHalfW, panelY, gpHalfW * 2, doorExt);
        this.ctx.globalAlpha = 0.25;
        this.ctx.strokeStyle = '#3a2010';
        this.ctx.lineWidth = 0.6;
        this.ctx.beginPath();
        this.ctx.moveTo(0, panelY + 2); this.ctx.lineTo(0, panelY + doorExt - 2);
        this.ctx.stroke();
        this.ctx.globalAlpha = 1.0;
      } else {
        // Closed door cover
        this.ctx.fillStyle = '#6a4828';
        this.ctx.fillRect(-gpHalfW, -gpHalfH, gpHalfW * 2, gpHalfH * 2);
        this.ctx.strokeStyle = '#3a2010';
        this.ctx.lineWidth = 0.8;
        this.ctx.strokeRect(-gpHalfW, -gpHalfH, gpHalfW * 2, gpHalfH * 2);
        this.ctx.beginPath();
        this.ctx.moveTo(-gpHalfW, 0); this.ctx.lineTo(gpHalfW, 0);
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /**
   * Shared ramp visual — draws a placed ramp (or preview) in its own rotated frame.
   * Caller must have already applied ship-local transform.
   * −x end (ramp-local) = top/light (upper-deck entry face).
   * +x end = bottom/dark (lower-deck climbable face).
   */
  private drawRampVisualAt(
    sp: { x: number; y: number },
    localRot: number,
    lw: number,
    alpha: number = 1.0,
  ): void {
    this.ctx.save();
    this.ctx.translate(sp.x, sp.y);
    this.ctx.rotate(localRot);
    if (alpha !== 1.0) this.ctx.globalAlpha *= alpha;

    // Gradient fill — blitted from a pre-baked sprite (eliminates createLinearGradient per frame)
    this.ctx.drawImage(this._getRampFillSprite(), -25, -25);

    // Step lines — all 6 batched into one path + one stroke() call (same strokeStyle)
    this.ctx.strokeStyle = 'rgba(0,0,0,0.55)'; // ~mid-gradient darkness
    this.ctx.lineWidth   = lw * 1.5;
    this.ctx.beginPath();
    const numSteps = 6;
    for (let s = 0; s < numSteps; s++) {
      const sx = -25 + ((s + 0.5) / numSteps) * 50;
      this.ctx.moveTo(sx, -25);
      this.ctx.lineTo(sx, 25);
    }
    this.ctx.stroke();

    // Border and left-edge highlight (different styles — kept separate)
    this.ctx.strokeStyle = '#5a3210';
    this.ctx.lineWidth   = lw * 2;
    this.ctx.strokeRect(-25, -25, 50, 50);

    this.ctx.strokeStyle = 'rgba(220,160,80,0.65)';
    this.ctx.lineWidth   = lw * 2.5;
    this.ctx.beginPath();
    this.ctx.moveTo(-25, -25);
    this.ctx.lineTo(-25, 25);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /**
   * Draw a placed hatch cover at a snap point — looks like sealed deck planking.
   * Caller must have already applied ship-local transform.
   */
  private drawHatchCoverAt(
    sp: { x: number; y: number },
    lw: number,
    alpha: number = 1.0,
  ): void {
    this.ctx.save();
    this.ctx.translate(sp.x, sp.y);
    if (alpha !== 1.0) this.ctx.globalAlpha *= alpha;

    // Solid plank fill — same warm wood tone as the deck surface
    this.ctx.fillStyle = '#7a5230';
    this.ctx.fillRect(-25, -25, 50, 50);

    // Horizontal plank lines — batched into one path + one stroke()
    this.ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    this.ctx.lineWidth   = lw * 1.2;
    this.ctx.beginPath();
    for (let p = 1; p < 5; p++) {
      const yy = -25 + (p / 5) * 50;
      this.ctx.moveTo(-25, yy);
      this.ctx.lineTo(25, yy);
    }
    this.ctx.stroke();

    // Border — slightly lighter to differentiate from regular floor
    this.ctx.strokeStyle = '#c89050';
    this.ctx.lineWidth   = lw * 2.5;
    this.ctx.strokeRect(-25, -25, 50, 50);

    // Small "X" latch indicator in the centre (2 lines, already one path)
    this.ctx.strokeStyle = 'rgba(200,140,60,0.80)';
    this.ctx.lineWidth   = lw * 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(-8, -8); this.ctx.lineTo(8, 8);
    this.ctx.moveTo(8, -8);  this.ctx.lineTo(-8, 8);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /**
   * Draw ghost ramp outlines at all available snap points on a ship (ramp build mode).
   * Shows a gradient preview matching the current rampFacing — light (top) to dark (bottom).
   * When in hatch build mode, shows a hatch cover preview instead.
   */
  private drawRampSnapGhosts(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    this.ctx.save();
    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;
    const facingAngle = this.rampFacing * Math.PI / 2;
    const isHatchMode = this.hatchBuildMode;

    for (let i = 0; i < RenderSystem.RAMP_SNAP_POINTS.length; i++) {
      const sp = RenderSystem.RAMP_SNAP_POINTS[i];

      // Skip occupied snap points (ramp or hatch cover)
      const occupied = ship.modules.some(
        m => (m.kind === 'ramp' || m.kind === 'hatch_cover')
          && Math.abs(m.localPos.x - sp.x) < 20
          && Math.abs(m.localPos.y - sp.y) < 20
      );
      if (occupied) continue;

      const isHovered = this.hoveredRampSlot?.ship === ship
                     && this.hoveredRampSlot?.snapIndex === i;

      if (isHatchMode) {
        // Hatch cover ghost
        if (isHovered) {
          this.drawHatchCoverAt(sp, lw, 1.0);
          this.ctx.save();
          this.ctx.translate(sp.x, sp.y);
          this.ctx.strokeStyle = '#ffee88';
          this.ctx.lineWidth   = lw * 1.5;
          this.ctx.strokeRect(-31, -31, 62, 62);
          const fontSize = Math.max(7, Math.round(9 / cameraState.zoom));
          this.ctx.font         = `bold ${fontSize}px Georgia, serif`;
          this.ctx.fillStyle    = '#ffffffcc';
          this.ctx.textAlign    = 'center';
          this.ctx.textBaseline = 'bottom';
          this.ctx.fillText('Hatch cover', 0, -34);
          this.ctx.restore();
        } else {
          this.drawHatchCoverAt(sp, lw, 0.30);
          this.ctx.save();
          this.ctx.translate(sp.x, sp.y);
          this.ctx.strokeStyle = 'rgba(200,150,60,0.60)';
          this.ctx.lineWidth   = lw;
          this.ctx.setLineDash([5 / cameraState.zoom, 3 / cameraState.zoom]);
          this.ctx.strokeRect(-25, -25, 50, 50);
          this.ctx.setLineDash([]);
          this.ctx.restore();
        }
      } else {
        // Ramp ghost
        if (isHovered) {
          // Hovered: draw the exact same visual as a placed ramp so the
          // highlight footprint matches the eventual placement 1:1.
          this.drawRampVisualAt(sp, facingAngle, lw, 1.0);

          // Add an outer glow ring + rotate hint, positioned relative to the
          // unrotated snap point so it always sits around the 50×50 footprint.
          this.ctx.save();
          this.ctx.translate(sp.x, sp.y);
          this.ctx.rotate(facingAngle);
          this.ctx.strokeStyle = '#ffee88';
          this.ctx.lineWidth   = lw * 1.5;
          this.ctx.strokeRect(-31, -31, 62, 62);

          const fontSize = Math.max(7, Math.round(9 / cameraState.zoom));
          this.ctx.font         = `bold ${fontSize}px Georgia, serif`;
          this.ctx.fillStyle    = '#ffffffcc';
          this.ctx.textAlign    = 'center';
          this.ctx.textBaseline = 'bottom';
          this.ctx.fillText('R: rotate', 0, -34);
          this.ctx.restore();
        } else {
          // Unhovered: faded preview using the same visual at reduced opacity,
          // plus a dashed outline so empty slots are still legible.
          this.drawRampVisualAt(sp, facingAngle, lw, 0.30);

          this.ctx.save();
          this.ctx.translate(sp.x, sp.y);
          this.ctx.rotate(facingAngle);
          this.ctx.strokeStyle = 'rgba(200,150,60,0.60)';
          this.ctx.lineWidth   = lw;
          this.ctx.setLineDash([5 / cameraState.zoom, 3 / cameraState.zoom]);
          this.ctx.strokeRect(-25, -25, 50, 50);
          this.ctx.setLineDash([]);
          this.ctx.restore();
        }
      }
    }

    this.ctx.restore();
  }

  private detectHoveredGunportSnap(worldState: WorldState): void {
    this.hoveredGunportSnap = null;
    if (!this.mouseWorldPos) return;

    const HALF_W = 14; // horizontal tolerance (~half the gunport spacing)
    const HALF_H = 12; // vertical tolerance (stays on plank)

    for (const ship of worldState.ships) {
      const dx = this.mouseWorldPos.x - ship.position.x;
      const dy = this.mouseWorldPos.y - ship.position.y;
      const cos = Math.cos(-ship.rotation);
      const sin = Math.sin(-ship.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      for (let i = 0; i < GUNPORT_SNAP_POINTS.length; i++) {
        const sp = GUNPORT_SNAP_POINTS[i];
        // Skip occupied snap points
        const occupied = ship.modules.some(
          m => m.kind === 'gunport'
            && Math.abs(m.localPos.x - sp.x) < 15
            && Math.abs(m.localPos.y - sp.y) < 12
        );
        if (occupied) continue;

        if (Math.abs(localX - sp.x) <= HALF_W && Math.abs(localY - sp.y) <= HALF_H) {
          this.hoveredGunportSnap = { ship, snapIndex: i, localPos: { x: sp.x, y: sp.y } };
          return;
        }
      }
    }
  }

  private drawGunportSnapGhosts(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    this.ctx.save();
    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const lw = 1.5 / cameraState.zoom;
    const gpHalfW = 11;
    const gpHalfH = 5;

    for (let i = 0; i < GUNPORT_SNAP_POINTS.length; i++) {
      const sp = GUNPORT_SNAP_POINTS[i];
      const occupied = ship.modules.some(
        m => m.kind === 'gunport'
          && Math.abs(m.localPos.x - sp.x) < 15
          && Math.abs(m.localPos.y - sp.y) < 12
      );
      if (occupied) continue;

      const isHovered = this.hoveredGunportSnap?.ship === ship
                     && this.hoveredGunportSnap?.snapIndex === i;

      this.ctx.save();
      this.ctx.translate(sp.x, sp.y);

      if (isHovered) {
        // Bright ghost — show the closed cover preview
        this.ctx.fillStyle = 'rgba(160,120,60,0.85)';
        this.ctx.fillRect(-gpHalfW, -gpHalfH, gpHalfW * 2, gpHalfH * 2);
        this.ctx.strokeStyle = '#ffee88';
        this.ctx.lineWidth = lw * 1.5;
        this.ctx.strokeRect(-gpHalfW - 2, -gpHalfH - 2, (gpHalfW + 2) * 2, (gpHalfH + 2) * 2);
        // Label
        const fontSize = Math.max(5, Math.round(7 / cameraState.zoom));
        this.ctx.font = `bold ${fontSize}px Georgia, serif`;
        this.ctx.fillStyle = '#ffffffcc';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = sp.side === 'starboard' ? 'bottom' : 'top';
        this.ctx.fillText('Gunport', 0, sp.side === 'starboard' ? -gpHalfH - 4 : gpHalfH + 4);
      } else {
        // Dim ghost
        this.ctx.fillStyle = 'rgba(120,80,40,0.35)';
        this.ctx.fillRect(-gpHalfW, -gpHalfH, gpHalfW * 2, gpHalfH * 2);
        this.ctx.strokeStyle = 'rgba(200,150,60,0.50)';
        this.ctx.lineWidth = lw;
        this.ctx.setLineDash([3 / cameraState.zoom, 2 / cameraState.zoom]);
        this.ctx.strokeRect(-gpHalfW, -gpHalfH, gpHalfW * 2, gpHalfH * 2);
        this.ctx.setLineDash([]);
      }

      this.ctx.restore();
    }

    this.ctx.restore();
  }

  private drawShipCannons(ship: Ship, camera: Camera, deckFilter?: 0 | 1): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) {
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
    
    // Find all cannon modules, filtered by deck if requested.
    // deckFilter=0 → lower deck only; deckFilter=1 → upper deck + deck-independent (255).
    const cannons = ship.modules.filter(m => m.kind === 'cannon' && (
      deckFilter === undefined ? true :
      deckFilter === 0 ? m.deckId === 0 :
      /* deckFilter === 1 */ m.deckId === 1 || m.deckId === 255
    ));
    
    const isPhantomBrig = ship.shipType === SHIP_TYPE_GHOST;

    // Hoist ghost-cannon constants outside the per-cannon loop.
    // ghostSpectralColor builds rgba strings; computing RGB once and reusing
    // eliminates 5 string-building calls per cannon per frame.
    const _ghostCannonT = isPhantomBrig ? performance.now() / 1000 : 0;
    const _ghostRGB: [number, number, number] = isPhantomBrig ? (() => {
      const nLvl = ship.npcLevel ?? 1;
      const lt   = Math.max(0, Math.min(1, (nLvl - 1) / 59));
      return [Math.round(lt * 255), Math.round(238 * (1 - lt) + 40 * lt), Math.round(255 * (1 - lt))];
    })() : [0, 0, 0];

    for (const cannon of cannons) {
      if (!cannon.moduleData || cannon.moduleData.kind !== 'cannon') continue;
      
      const cannonData = cannon.moduleData;
      const x = cannon.localPos.x;
      const y = cannon.localPos.y;
      // Use smoothed angle so the barrel moves continuously between server snapshots
      const turretAngle = this._smoothBarrelAngles.get(cannon.id) ?? (cannonData.aimDirection || 0);
      const localRot = cannon.localRot || 0; // Module rotation

      // Health-based darkening
      const cannonHealthRatio = Math.max(0, cannonData.health / (cannonData.maxHealth || 8000));
      
      // Save context for this cannon
      this.ctx.save();
      
      // Deck-based opacity: fade cannons on decks above the player's current deck.
      // Decks below (or same) render at full opacity — render order handles occlusion.
      if (cannon.deckId !== 255 && cannon.deckId > this._playerDeckLevel) {
        this.ctx.globalAlpha = 0.35;
      }

      // Gunport-associated cannons slide outward when the gunport opens
      let renderY = y;
      const assocGunport = this.findGunportForCannon(cannon, ship);
      if (assocGunport) {
        // Use gunport position as the reference so the animation is independent of
        // whatever local_pos the server assigns the cannon (deployed vs stowed).
        const gpY = assocGunport.localPos.y;  // ±90 (hull edge)
        // Stowed:   cannon 40 px inboard of hull edge → centre at ∓50
        // Deployed: cannon base (outboard face) flush with hull inner surface → centre at ∓80
        const stowedY   = gpY + (gpY < 0 ?  40 : -40);  // -90+40=-50 stbd, +90-40=+50 port
        const deployedY = gpY + (gpY < 0 ?  10 : -10);  // -90+10=-80 stbd, +90-10=+80 port
        const anim = this.gunportAnimations.get(assocGunport.id);
        const isOpen = (assocGunport.moduleData as any)?.isOpen ?? false;
        const progress = anim ? this.computeGunportProgress(anim, performance.now()) : (isOpen ? 1 : 0);
        renderY = stowedY + (deployedY - stowedY) * progress;
      }

      // Move to cannon position and apply module rotation
      this.ctx.translate(x, renderY);
      this.ctx.rotate(localRot);
      
      const lineWidth = 1 / cameraState.zoom;

      if (isPhantomBrig) {
        // ── Phantom Brig spectral cannon (level-tinted) ────────────────────
        // Per-cannon pulse uses a position-based phase so each cannon shimmers
        // independently, but t and the RGB channel values are ship-wide constants
        // hoisted above the loop (see _ghostCannonT / _ghostCannonRGB).
        const pulse = 0.55 + 0.45 * Math.sin(_ghostCannonT * 2.2 + x * 0.05 + y * 0.05);
        const glowAlpha = 0.5 + 0.5 * pulse;
        const [gr, gg, gb] = _ghostRGB;
        const shadowClr  = `rgba(${gr},${gg},${gb},${(glowAlpha * 0.9).toFixed(3)})`;
        const strokeClr  = `rgba(${gr},${gg},${gb},${glowAlpha.toFixed(3)})`;
        const muzzleClr  = `rgba(${gr},${gg},${gb},${(glowAlpha * 0.6).toFixed(3)})`;

        // Void-dark base with level-tinted outline — no shadowBlur (removed: was
        // 3× shadowBlur per cannon × 8+ cannons × 4+ ghost ships = 96 blur passes).
        // The pulsing stroke colour provides sufficient visual spectral quality.
        this.ctx.fillStyle = '#060f0d';
        this.ctx.strokeStyle = strokeClr;
        this.ctx.lineWidth = lineWidth * 1.5;
        this.ctx.fillRect(-11, -7.5, 22, 15);
        this.ctx.strokeRect(-11, -7.5, 22, 15);

        // Spectral barrel
        this.ctx.save();
        this.ctx.rotate(turretAngle);
        this.ctx.fillStyle = `rgba(0,30,25,${(0.85 + 0.15 * pulse).toFixed(3)})`;
        this.ctx.strokeStyle = strokeClr;
        this.ctx.lineWidth = lineWidth * 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(-6, 0);
        this.ctx.lineTo(-6, -42);
        this.ctx.lineTo(6, -42);
        this.ctx.lineTo(6, 0);
        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.stroke();
        // Muzzle glow ring — flat colour, no shadow
        this.ctx.beginPath();
        this.ctx.arc(0, -42, 5, 0, Math.PI * 2);
        this.ctx.fillStyle = muzzleClr;
        this.ctx.fill();
        this.ctx.restore();
      } else {
      // Draw cannon base (doesn't rotate with turret)
      this.ctx.fillStyle = this.darkenByDamage('#8B4513', cannonHealthRatio);
      this.ctx.strokeStyle = '#000000';
      this.ctx.lineWidth = lineWidth;
      this.ctx.fillRect(-11, -7.5, 22, 15);
      this.ctx.strokeRect(-11, -7.5, 22, 15);

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
  private drawShipSwivelGuns(ship: Ship, camera: Camera, deckFilter?: 0 | 1): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const { phase2Alpha } = this.computeSinkState(ship);
    if (phase2Alpha <= 0) return;

    this.ctx.save();
    if (phase2Alpha < 1) this.ctx.globalAlpha = phase2Alpha;

    const screenPos = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();

    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    const swivels = ship.modules.filter(m => m.kind === 'swivel' && (
      deckFilter === undefined ? true :
      deckFilter === 0 ? m.deckId === 0 :
      /* deckFilter === 1 */ m.deckId === 1 || m.deckId === 255
    ));

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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

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

  // ── Cannon trajectory helpers ────────────────────────────────────────────────

  /**
   * Returns true when world-space point (px, py) lies inside island terrain.
   * Mirrors server simulation.c over_land detection for overland range reduction.
   */
  private isPointOverIsland(px: number, py: number): boolean {
    for (const isl of this.islands) {
      if (isl.vertices && isl.vertices.length > 2) {
        const verts = isl.vertices;
        const n = verts.length;
        // Broad-phase bounding circle
        const boundR = Math.max(...verts.map(v => Math.hypot(v.x - isl.x, v.y - isl.y)));
        const dx2 = px - isl.x, dy2 = py - isl.y;
        if (dx2 * dx2 + dy2 * dy2 > (boundR + 10) * (boundR + 10)) continue;
        // Point-in-polygon (ray casting)
        let inside = false;
        for (let vi = 0, vj = n - 1; vi < n; vj = vi++) {
          const xi = verts[vi].x, yi = verts[vi].y;
          const xj = verts[vj].x, yj = verts[vj].y;
          if ((yi > py) !== (yj > py) &&
              px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            inside = !inside;
        }
        if (inside) return true;
      } else {
        const preset = RenderSystem.ISLAND_PRESETS[isl.preset] ?? RenderSystem.ISLAND_PRESETS['tropical'];
        const dx2 = px - isl.x, dy2 = py - isl.y;
        const distSq = dx2 * dx2 + dy2 * dy2;
        const broadR = preset.beachRadius + Math.max(...preset.beachBumps.map(Math.abs));
        if (distSq < broadR * broadR) {
          const angle = Math.atan2(dy2, dx2);
          const bumps = preset.beachBumps;
          let a = angle % (Math.PI * 2); if (a < 0) a += Math.PI * 2;
          const t2 = (a / (Math.PI * 2)) * bumps.length;
          const i0 = Math.floor(t2) % bumps.length;
          const i1 = (i0 + 1) % bumps.length;
          const narrowR = preset.beachRadius + bumps[i0] + (t2 - Math.floor(t2)) * (bumps[i1] - bumps[i0]);
          if (distSq < narrowR * narrowR) return true;
        }
      }
    }
    return false;
  }

  /**
   * Compute the max range for a cannonball accounting for overland range reduction.
   * Server rule: effective_age += dt * (over_land ? 2 : 1); expires at 5 000 ms.
   * At sea the cannonball travels 500 px/s × 5 s = 2 500 px.
   * Over land it ages 2× faster, halving effective reach proportionally.
   */
  private computeCannonMaxRange(ox: number, oy: number, dx: number, dy: number): number {
    const CANNON_SPEED_PX_S = 500;
    const LIFETIME_MS       = 5000;
    const STEP              = 50;  // sample every 50 px — cheap and accurate enough
    const SEA_MAX           = CANNON_SPEED_PX_S * (LIFETIME_MS / 1000); // 2 500 px
    let effectiveAgeMs = 0;
    let traveled = 0;
    while (traveled < SEA_MAX) {
      const step = Math.min(STEP, SEA_MAX - traveled);
      const overLand = this.isPointOverIsland(ox + dx * traveled, oy + dy * traveled);
      const ageIncrease = (step / CANNON_SPEED_PX_S) * 1000 * (overLand ? 2 : 1);
      effectiveAgeMs += ageIncrease;
      if (effectiveAgeMs >= LIFETIME_MS) {
        const excess    = effectiveAgeMs - LIFETIME_MS;
        const fraction  = (ageIncrease - excess) / ageIncrease;
        return traveled + step * fraction;
      }
      traveled += step;
    }
    return SEA_MAX;
  }

  /**
   * Find the first collision along a cannon trajectory ray and determine its faction color.
   *
   * Checks (in priority order):
   *   1. Players on foot        → faction-colored (green/red)
   *   2. Free-standing NPCs     → faction-colored
   *   3. Ships — hull polygons and modules — → faction-colored by ship company
   *   4. On-ship players & NPCs → faction-colored by their own company
   *   5. Placed structures      → faction-colored (neutral structures: grey)
   *   6. Resource nodes (boulders/rocks) → grey (no faction)
   *
   * Returns:
   *   color '#44ff88' — friendly (same company as local player)
   *   color '#ff4444' — enemy / opposing company
   *   color '#888888' — no hit OR environment hit (resource, neutral structure)
   *   t               — distance to first hit (Infinity = no hit within maxT)
   */
  private findCannonTrajectoryHit(
    ox: number, oy: number,
    dx: number, dy: number,
    maxT: number,
    excludeShipId: number,
    ammoType: number = 0, // 0 = cannonball, 1 = bar shot
  ): { t: number; color: string } {
    const isBarShot = ammoType !== 0; // treat any non-cannonball ammo as bar shot
    const myComp = this._localCompanyId;
    let tMin = Infinity;
    let hitColor = '#888888';

    const tryHit = (t: number, companyId: number) => {
      if (t < 0 || t >= tMin) return;
      tMin = t;
      if (myComp > 0 && companyId === myComp) {
        hitColor = '#44ff88'; // green — friendly
      } else if (companyId === 0) {
        hitColor = '#888888'; // grey — neutral / environment
      } else {
        hitColor = '#ff4444'; // red — enemy
      }
    };

    const tryEnv = (t: number) => {
      if (t < 0 || t >= tMin) return;
      tMin = t;
      hitColor = '#888888'; // grey — terrain / resource
    };

    // ── 1. Players on foot ──────────────────────────────────────────────
    const PLAYER_R = 16;
    for (const p of (this._cachedWorldPlayers ?? [])) {
      if (p.carrierId !== 0) continue;
      if (p.movementState === 'SWIMMING') continue;
      const mx = p.position.x - ox, my = p.position.y - oy;
      const tp = mx * dx + my * dy;
      if (tp < 0 || tp > maxT) continue;
      const perpSq = mx * mx + my * my - tp * tp;
      if (perpSq > PLAYER_R * PLAYER_R) continue;
      tryHit(tp - Math.sqrt(PLAYER_R * PLAYER_R - perpSq), p.companyId);
    }

    // ── 2. Free-standing NPCs (swimming / off-ship) ─────────────────────
    // Cannonball and bar shot skip swimmers — on-deck crew are checked in §3.

    // ── 3. Ships (hull + modules + on-ship entities) ────────────────────
    const MOD_R      = 20;
    const MAST_R     = 40; // matches server BAR_SHOT_SAIL_RADIUS = CLIENT_TO_SERVER(40) = 40 client px
    const NPC_R      = 14;
    // Bar shot sweeps a spinning arc: barHalfL(10) + ballR(4) = 14 world px from the trajectory centre.
    // Added to non-mast targets so the guide matches the projectile's physical reach.
    const BAR_PROJ_R = isBarShot ? 14 : 0;
    for (const ship of (this._cachedWorldShips ?? [])) {
      if (ship.id === excludeShipId) continue;
      const sc = Math.cos(ship.rotation), ss = Math.sin(ship.rotation);

      // Hull polygon — bar shot passes through the hull entirely
      if (!isBarShot && ship.hull && ship.hull.length >= 3) {
        const t2 = this.rayHullIntersect(
          ox, oy, dx, dy, ship.hull,
          ship.position.x, ship.position.y, ship.rotation, maxT);
        tryHit(t2, ship.companyId);
      }

      // Ship modules — bar shot only hits masts; cannonball hits everything
      for (const mod of ship.modules) {
        if (isBarShot && mod.kind !== 'mast') continue;
        const hitR = (isBarShot && mod.kind === 'mast') ? MAST_R : MOD_R;
        const mwx = ship.position.x + mod.localPos.x * sc - mod.localPos.y * ss;
        const mwy = ship.position.y + mod.localPos.x * ss + mod.localPos.y * sc;
        const mx = mwx - ox, my = mwy - oy;
        const tp = mx * dx + my * dy;
        if (tp < 0 || tp > maxT) continue;
        const perpSq = mx * mx + my * my - tp * tp;
        if (perpSq > hitR * hitR) continue;
        // Bar shot: use mast center (tp) so the reticle appears inside the hull at the mast,
        // not at the near-edge of the sail circle which coincides with the hull boundary.
        const hitT = (isBarShot && mod.kind === 'mast')
          ? tp
          : tp - Math.sqrt(hitR * hitR - perpSq);
        tryHit(hitT, ship.companyId);
      }

      // Players on this ship — cannonball hits crew; bar shot hits crew (anti-personnel)
      for (const p of (this._cachedWorldPlayers ?? [])) {
        if (p.carrierId !== ship.id || !p.localPosition) continue;
        if (p.movementState === 'SWIMMING') continue;
        const pwx = ship.position.x + p.localPosition.x * sc - p.localPosition.y * ss;
        const pwy = ship.position.y + p.localPosition.x * ss + p.localPosition.y * sc;
        const mx = pwx - ox, my = pwy - oy;
        const tp = mx * dx + my * dy;
        if (tp < 0 || tp > maxT) continue;
        const perpSq = mx * mx + my * my - tp * tp;
        const hitR = isBarShot ? (PLAYER_R + BAR_PROJ_R) : PLAYER_R;
        if (perpSq > hitR * hitR) continue;
        tryHit(tp - Math.sqrt(hitR * hitR - perpSq), p.companyId);
      }

      // NPCs on this ship — cannonball hits crew; bar shot hits crew (anti-personnel)
      for (const npc of (this._cachedWorldNpcs ?? [])) {
        if (npc.shipId !== ship.id || !npc.localPosition) continue;
        const nwx = ship.position.x + npc.localPosition.x * sc - npc.localPosition.y * ss;
        const nwy = ship.position.y + npc.localPosition.x * ss + npc.localPosition.y * sc;
        const mx = nwx - ox, my = nwy - oy;
        const tp = mx * dx + my * dy;
        if (tp < 0 || tp > maxT) continue;
        const perpSq = mx * mx + my * my - tp * tp;
        const hitR = isBarShot ? (NPC_R + BAR_PROJ_R) : NPC_R;
        if (perpSq > hitR * hitR) continue;
        tryHit(tp - Math.sqrt(hitR * hitR - perpSq), npc.companyId);
      }
    }

    // ── 4. Placed structures ────────────────────────────────────────────
    const STRUCT_R = 22 + BAR_PROJ_R; // bar shot's spinning arms widen the effective hitbox
    const nonSolid = new Set(['wood_ceiling', 'claim_flag']);
    for (const s of this.placedStructures) {
      if (nonSolid.has(s.type)) continue;
      const mx = s.x - ox, my = s.y - oy;
      const tp = mx * dx + my * dy;
      if (tp < 0 || tp > maxT) continue;
      const perpSq = mx * mx + my * my - tp * tp;
      if (perpSq > STRUCT_R * STRUCT_R) continue;
      const t2 = tp - Math.sqrt(STRUCT_R * STRUCT_R - perpSq);
      if (s.companyId === 0) tryEnv(t2); else tryHit(t2, s.companyId);
    }

    // ── 5. Resource nodes (boulders and tree trunks block shots; small rocks/fiber do not) ──
    for (const isl of this.islands) {
      for (const res of (isl.resources ?? [])) {
        if (res.hp <= 0) continue;
        if (res.type !== 'boulder' && res.type !== 'wood') continue;
        const rwx = isl.x + res.ox, rwy = isl.y + res.oy;
        const hitR = (res.type === 'boulder' ? 28 : 18) * (res.size ?? 1.0) + BAR_PROJ_R;
        const mx = rwx - ox, my = rwy - oy;
        const tp = mx * dx + my * dy;
        if (tp < 0 || tp > maxT) continue;
        const perpSq = mx * mx + my * my - tp * tp;
        if (perpSq > hitR * hitR) continue;
        tryEnv(tp - Math.sqrt(hitR * hitR - perpSq));
      }
    }

    return { t: tMin, color: hitColor };
  }

  // ── Territory helpers ───────────────────────────────────────────────────────

  /** Returns a CSS color string for a given company id. */
  private _companyColor(companyId: number): string {
    if (companyId === 0) return '#888888';
    if (companyId === 1) return '#ddaa00';  // COMPANY_SOLO — gold
    if (companyId === 2) return '#cc3333';  // COMPANY_PIRATES — red
    if (companyId === 3) return '#3366cc';  // COMPANY_NAVY — blue
    if (companyId === 99) return '#33cc99'; // COMPANY_GHOST — teal
    // Dynamic companies (≥100): hash into a palette
    const palette = ['#e06c22','#22a0e0','#22e06c','#e022a0','#a0e022','#6c22e0','#e0a022','#22e0a0'];
    return palette[(companyId - 100) % palette.length];
  }

  /**
   * Draw the territory claim overlay for all claimed islands.
   * Called each frame when Alt is held.
   */
  private drawTerritoryOverlay(camera: Camera): void {
    const camState = camera.getState();
    const zoom = camState.zoom;
    const camX = camState.position.x;
    const camY = camState.position.y;
    const margin = this._claimOverlayMargin;

    // ── Invalidate BFS/miInfos caches on structural change ────────────────
    if (this._claimOverlayDirty) {
      this._claimOverlayCache.clear();
      this._miInfosCache.clear();
      this._claimOverlayDirty = false;
      // _claimOverlayBitmapValid already false (set by the dirty setter)
    }
    if (zoom !== this._claimOverlayCachedZoom) this._claimOverlayBitmapValid = false;

    // ── Render overlay into an oversized offscreen canvas once per change ─
    // Camera pan is handled each frame by a single offset drawImage; only
    // zoom changes or structural events trigger a full re-rasterisation.
    if (!this._claimOverlayBitmapValid) {
      const vpW = this.ctx.canvas.width;
      const vpH = this.ctx.canvas.height;
      const cw = vpW + 2 * margin;
      const ch = vpH + 2 * margin;
      if (!this._claimOverlayCachedCanvas
          || this._claimOverlayCachedCanvas.width !== cw
          || this._claimOverlayCachedCanvas.height !== ch) {
        this._claimOverlayCachedCanvas = new OffscreenCanvas(cw, ch);
      }
      const offCtx = this._claimOverlayCachedCanvas.getContext('2d')!;
      offCtx.clearRect(0, 0, cw, ch);
      offCtx.save();
      // Shift so worldToScreen coords (centred on vpW/2, vpH/2) land at
      // the centre of the oversized canvas (vpW/2+margin, vpH/2+margin).
      offCtx.translate(margin, margin);
      const ctx = offCtx as unknown as CanvasRenderingContext2D;
      const CLAIM_RADIUS_DEFAULT = 400;  // server CLAIM_RADIUS_DEFAULT
      const CLAIM_RADIUS_FORT    = 600;  // server CLAIM_RADIUS_FLAG_FORT / COMPANY_FORT
      const myCompany = this._localCompanyId;

    // ── Pass 1: claimed-island territory fill + fort rings + labels ──────────
    for (const isl of this.islands) {
      const claim = this._islandClaims.get(isl.id);
      if (claim === undefined || claim.companyId === 0) continue;
      const claimCompany = claim.companyId;

      const wrapOffsets = this.getWrapRenderOffsets(Vec2.from(isl.x, isl.y), camera, 800);
      for (const off of wrapOffsets) {
        const islandX = isl.x + off.dx;
        const islandY = isl.y + off.dy;

        const color = this._companyColor(claimCompany);
        const companyName = this._cachedCompanies.find(c => c.id === claimCompany)?.name
          ?? (claimCompany === 1 ? 'Solo' : claimCompany === 2 ? 'Pirates' : claimCompany === 3 ? 'Navy' : `Company #${claimCompany}`);

        ctx.save();

        // Fill the island polygon with the company color (semi-transparent)
        if (isl.vertices && isl.vertices.length > 2) {
          const screenVerts = isl.vertices.map(v =>
            camera.worldToScreen(Vec2.from(v.x + off.dx, v.y + off.dy))
          );
          ctx.beginPath();
          screenVerts.forEach((sp, i) => i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y));
          ctx.closePath();
          ctx.fillStyle = color + '44'; // 27% opacity
          ctx.fill();
          ctx.strokeStyle = color + 'aa';
          ctx.lineWidth = Math.max(1, 2.5 * zoom);
          ctx.stroke();
        } else {
          // Fallback: circle
          const sc = camera.worldToScreen(Vec2.from(islandX, islandY));
          const r = Math.max(40, 150 * zoom);
          ctx.beginPath();
          ctx.arc(sc.x, sc.y, r, 0, Math.PI * 2);
          ctx.fillStyle = color + '44';
          ctx.fill();
          ctx.strokeStyle = color + 'aa';
          ctx.lineWidth = Math.max(1, 2.5 * zoom);
          ctx.stroke();
        }


        // Company label in the centre
        const sc = camera.worldToScreen(Vec2.from(islandX, islandY));
        const fontSize = Math.max(11, Math.round(13 * zoom));
        ctx.font = `bold ${fontSize}px Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = Math.max(2, 3 * zoom);
        ctx.strokeText(companyName, sc.x, sc.y);
        ctx.fillText(companyName, sc.x, sc.y);

        ctx.restore();
      }
    }

    // ── Pass 2: territory blobs for all companies with structures ─────────
    // Own company gets full rendering (inactive grey blob + active fill+ring).
    // Other companies get a ring-only treatment at reduced opacity so players
    // can read the full territorial picture after leaving or when spectating.

    // Per-overlay-render id → PlacedStructure lookup. Built once per re-rasterisation
    // (not per frame) inside the !_claimOverlayBitmapValid block above.
    const structById: Map<number, PlacedStructure> = new Map();
    for (const ps of this.placedStructures) structById.set(ps.id, ps);

    // Collect all company IDs that have placed structures on any island
    const allCompanyIds = new Set<number>();
    for (const ps of this.placedStructures) {
      if (ps.companyId && ps.companyId !== 0) allCompanyIds.add(ps.companyId);
    }
    if (myCompany !== 0) allCompanyIds.add(myCompany);
    if (allCompanyIds.size === 0) {
      // Nothing to draw — restore, mark valid, and blit the empty canvas.
      offCtx.restore();
      this._claimOverlayCachedCamX = camX;
      this._claimOverlayCachedCamY = camY;
      this._claimOverlayCachedZoom = zoom;
      this._claimOverlayBitmapValid = true;
      this.ctx.drawImage(this._claimOverlayCachedCanvas!, -margin, -margin);
      return;
    }

    const cvs = ctx.canvas;

    // ── Helper: resolve a company's active claim circles in world space ──
    // Returns { worldCircles: [{x, y, r}], inactiveList, hasFort } where the
    // first entry of worldCircles is the fort (if present) at its larger radius,
    // followed by every BFS-connected non-fort structure at CLAIM_RADIUS_DEFAULT.
    type CompanyClaim = {
      // `id` is the underlying PlacedStructure id (0 when synthesised from
      // an island_claims fallback — only used by per-structure dominator
      // lookups, so id=0 just falls back to global behaviour).
      worldCircles: Array<{ id: number; x: number; y: number; r: number }>;
      inactiveList: PlacedStructure[];
      hasFort: boolean;
      // Dominance metadata: structure id of this company's anchor fort on the
      // island (0 if none) and whether that fort is a Company Fortress. Used
      // to determine which company's contested arc gets the doubled solid
      // border vs the thin dashed line.
      fortId: number;
      fortIsCompanyFortress: boolean;
      // Forts that are NOT in the ACTIVE phase yet (CLAIMING or BUILDING).
      // They render as separate per-fort blobs (NOT merged into the company's
      // main active blob) so the claim overlay visually distinguishes
      // pending territory from established territory.
      nonActiveForts: PlacedStructure[];
    };
    type IslandClaimEntry = ReturnType<typeof this._islandClaims.get>;
    const isFortActive = (ps: PlacedStructure): boolean => {
      if (ps.type === 'company_fortress') return ps.fortressComplete === true;
      if (ps.type === 'flag_fort') {
        // Phase-aware: only ACTIVE phase (2) projects territory. CLAIMING (0)
        // and BUILDING (1) render as standalone per-fort blobs. Legacy data
        // (claimPhase === undefined) falls back to the old fortressComplete
        // gate so older saves keep working.
        if (typeof ps.claimPhase === 'number') return ps.claimPhase === 2;
        return ps.fortressComplete !== false;
      }
      return false;
    };
    const resolveCompanyClaim = (islId: number, cid: number, claim: IslandClaimEntry): CompanyClaim => {
      // ── Collect ALL forts (flag forts + company fortresses) for this
      // company on this island. ACTIVE forts seed the main territory blob;
      // non-active forts (CLAIMING / BUILDING) are returned separately and
      // drawn as standalone per-fort blobs by the caller.
      const fortCircles: Array<{ id: number; x: number; y: number; r: number }> = [];
      const allFortStructs = this.placedStructures.filter(
        ps => ps.islandId === islId
           && ps.companyId === cid
           && (!ps.claimOrphaned || ps.claimPhase === 3 || (ps.claimPhase === 0 && ps.hp === 0)) // DEMOLISHING (phase 3) and post-demolish countdown still render a flashing ring
           && (ps.type === 'flag_fort' || ps.type === 'company_fortress')
      );
      const fortStructs    = allFortStructs.filter(isFortActive);
      const nonActiveForts = allFortStructs.filter(ps => ps.type === 'flag_fort' && !isFortActive(ps));
      for (const f of fortStructs) {
        fortCircles.push({ id: f.id, x: f.x, y: f.y, r: CLAIM_RADIUS_FORT });
      }
      // territory_update fallback: if no flag/company fort was found in
      // placedStructures but the island_claims map has one for this company,
      // synthesise a single anchor circle from it (handles edge cases where
      // structure_placed hasn't arrived yet but territory_update has).
      if (fortCircles.length === 0
          && claim?.companyId === cid
          && (claim.fortX !== 0 || claim.fortY !== 0)) {
        fortCircles.push({ id: 0, x: claim.fortX, y: claim.fortY, r: claim.fortRadius });
      }
      const hasFort = fortCircles.length > 0;

      // Locate this company's anchor fort in placedStructures for dominance.
      // Prefer Company Fortress over Flag Fort if both exist (shouldn't happen
      // in practice but keeps the rule well-defined). Falls back to lowest id.
      let fortId = 0;
      let fortIsCompanyFortress = false;
      {
        const companyFortress = this.placedStructures.find(
          ps => ps.islandId === islId && ps.type === 'company_fortress' && ps.companyId === cid
        );
        if (companyFortress) {
          fortId = companyFortress.id;
          fortIsCompanyFortress = true;
        } else {
          const flagFort = this.placedStructures
            .filter(ps => ps.islandId === islId && ps.type === 'flag_fort' && ps.companyId === cid)
            .reduce<PlacedStructure | null>((min, ps) => (!min || ps.id < min.id ? ps : min), null);
          if (flagFort) fortId = flagFort.id;
        }
      }

      const companyStructs = this.placedStructures.filter(
        ps => ps.islandId === islId
           && ps.companyId === cid
           && !ps.claimOrphaned
           && ps.type !== 'flag_fort'
           && ps.type !== 'company_fortress'
           && ps.type !== 'claim_flag'
      );

      // ── BFS cache (world-space, camera-independent) ─────────────────────
      // Connectivity rule (matches server `claim_rebuild_graph`): two
      // structures are connected when their claim circles OVERLAP, i.e. the
      // distance between centres is ≤ (r_a + r_b).
      const cacheKey = `${islId}_${cid}`;
      if (!this._claimOverlayCache.has(cacheKey)) {
        const connectedIds = new Set<number>();
        const bfsQueue: PlacedStructure[] = [];
        // Seed from EVERY fort: any non-fort structure whose circle (radius
        // CLAIM_RADIUS_DEFAULT) overlaps that fort's circle joins the BFS.
        for (const fc of fortCircles) {
          const seedR = fc.r + CLAIM_RADIUS_DEFAULT;
          const seedR2 = seedR * seedR;
          for (const ps of companyStructs) {
            if (connectedIds.has(ps.id)) continue;
            const dx = ps.x - fc.x, dy = ps.y - fc.y;
            if (dx * dx + dy * dy <= seedR2) {
              connectedIds.add(ps.id);
              bfsQueue.push(ps);
            }
          }
        }
        // Step rule: two non-fort structures both have radius
        // CLAIM_RADIUS_DEFAULT, so they connect when centre distance
        // ≤ 2 × CLAIM_RADIUS_DEFAULT.
        const stepR = 2 * CLAIM_RADIUS_DEFAULT;
        const stepR2 = stepR * stepR;
        let qi = 0;
        while (qi < bfsQueue.length) {
          const cur = bfsQueue[qi++];
          for (const ps of companyStructs) {
            if (connectedIds.has(ps.id)) continue;
            const dx = ps.x - cur.x, dy = ps.y - cur.y;
            if (dx * dx + dy * dy <= stepR2) {
              connectedIds.add(ps.id);
              bfsQueue.push(ps);
            }
          }
        }
        const inactiveIds = new Set<number>(
          companyStructs.filter(ps => !connectedIds.has(ps.id)).map(ps => ps.id)
        );
        this._claimOverlayCache.set(cacheKey, { connectedIds, inactiveIds });
      }
      const bfs           = this._claimOverlayCache.get(cacheKey)!;
      const connectedList = companyStructs.filter(ps => bfs.connectedIds.has(ps.id));
      const inactiveList  = companyStructs.filter(ps => bfs.inactiveIds.has(ps.id));

      const worldCircles: Array<{ id: number; x: number; y: number; r: number }> = [];
      for (const fc of fortCircles) worldCircles.push(fc);
      for (const ps of connectedList) worldCircles.push({ id: ps.id, x: ps.x, y: ps.y, r: CLAIM_RADIUS_DEFAULT });
      return { worldCircles, inactiveList, hasFort, fortId, fortIsCompanyFortress, nonActiveForts };
    };

    for (const isl of this.islands) {
      const islClaim = this._islandClaims.get(isl.id);

      // Pre-compute each company's claim circles for this island once.
      // Used both to render that company's own blob and to clip enemy overlap
      // out of every other company's blob.
      const islandClaimsByCo = new Map<number, CompanyClaim>();
      for (const cid of allCompanyIds) {
        islandClaimsByCo.set(cid, resolveCompanyClaim(isl.id, cid, islClaim));
      }

      // ── miInfos cache: world-space subord/dominated ID sets ─────────────
      // Computed once per structural change (same lifecycle as BFS cache).
      // The subord/dominated filter ("owner area" check) is camera-independent
      // — it only depends on structure positions/radii and dominator lists —
      // so results are valid across all zoom levels and pan positions.
      for (const cid of allCompanyIds) {
        const miKey = `${isl.id}_${cid}`;
        if (this._miInfosCache.has(miKey)) continue;

        const myClaim = islandClaimsByCo.get(cid)!;
        const ownWorld     = myClaim.worldCircles; // [{id,x,y,r}] — active
        const ownInactive  = myClaim.inactiveList.map(
          ps => ({ id: ps.id, x: ps.x, y: ps.y, r: CLAIM_RADIUS_DEFAULT as number })
        );
        const allOwn = [...ownWorld, ...ownInactive];

        // All enemy world circles for this company on this island.
        const enemyWorldById = new Map<number, { id: number; x: number; y: number; r: number }>();
        for (const [otherCid, otherClaim] of islandClaimsByCo) {
          if (otherCid === cid) continue;
          for (const wc of otherClaim.worldCircles) enemyWorldById.set(wc.id, wc);
        }

        const activeSubordIds:   Map<number, number[]> = new Map();
        const activeDomIds:      Map<number, number[]> = new Map();
        const inactiveSubordIds: Map<number, number[]> = new Map();
        const inactiveDomIds:    Map<number, number[]> = new Map();

        const computeSets = (
          circles: Array<{ id: number; x: number; y: number; r: number }>,
          subordOut: Map<number, number[]>,
          domOut:    Map<number, number[]>
        ): void => {
          for (const mi of circles) {
            const myStruct = mi.id > 0 ? structById.get(mi.id) : undefined;
            const subord: number[] = [];
            const dominated: number[] = [];

            if (myStruct?.dominators) {
              for (const eid of myStruct.dominators) {
                const ec = enemyWorldById.get(eid);
                if (!ec) continue;
                const eStruct = structById.get(ec.id);
                // Drop Ej when Mi.centre lies inside an allied M2 that also
                // dominates Ej (M2 is the "owner" of this area w.r.t. Ej).
                const ownedByAlly = !!eStruct?.dominators && allOwn.some(m2 => {
                  if (m2.id === mi.id || m2.r <= 0) return false;
                  if (!eStruct.dominators!.includes(m2.id)) return false;
                  const dx = mi.x - m2.x, dy = mi.y - m2.y;
                  return dx * dx + dy * dy <= m2.r * m2.r;
                });
                if (!ownedByAlly) subord.push(eid);
              }
            }

            if (mi.id > 0) {
              for (const ec of enemyWorldById.values()) {
                if (ec.id <= 0) continue;
                const eStruct = structById.get(ec.id);
                if (!eStruct?.dominators?.includes(mi.id)) continue;
                const coveredByAlly = allOwn.some(m2 => {
                  if (m2.id === mi.id || m2.r <= 0) return false;
                  if (!eStruct.dominators!.includes(m2.id)) return false;
                  const dx = mi.x - m2.x, dy = mi.y - m2.y;
                  return dx * dx + dy * dy <= m2.r * m2.r;
                });
                if (!coveredByAlly) dominated.push(ec.id);
              }
            }

            subordOut.set(mi.id, subord);
            domOut.set(mi.id, dominated);
          }
        };

        computeSets(ownWorld,    activeSubordIds,   activeDomIds);
        computeSets(ownInactive, inactiveSubordIds, inactiveDomIds);

        this._miInfosCache.set(miKey, {
          activeSubordIds, activeDomIds, inactiveSubordIds, inactiveDomIds,
        });
      }

      for (const cid of allCompanyIds) {
        const isOwn = cid === myCompany;
        const myClaim = islandClaimsByCo.get(cid)!;
        const { worldCircles, inactiveList, hasFort, nonActiveForts } = myClaim;

        if (worldCircles.length === 0 && inactiveList.length === 0 && nonActiveForts.length === 0) continue;

        const psR = CLAIM_RADIUS_DEFAULT * zoom;

        const wrapOffsets = this.getWrapRenderOffsets(Vec2.from(isl.x, isl.y), camera, 800);
        for (const off of wrapOffsets) {
          const color = this._companyColor(cid);
          const companyName = this._cachedCompanies.find(c => c.id === cid)?.name
            ?? (cid === 1 ? 'Solo' : cid === 2 ? 'Pirates' : cid === 3 ? 'Navy' : `Company #${cid}`);
          ctx.save();

          // ── Active blob: fort + connected structures ───────────────────────
          const screenPts: Array<{ id: number; x: number; y: number; r: number }> = [];
          for (const wc of worldCircles) {
            const sp = camera.worldToScreen(Vec2.from(wc.x + off.dx, wc.y + off.dy));
            screenPts.push({ id: wc.id, x: sp.x, y: sp.y, r: wc.r * zoom });
          }

          // Cache is guaranteed to be populated above for every cid on this island.
          const _cachedMi = this._miInfosCache.get(`${isl.id}_${cid}`)!;

          if (screenPts.length > 0) {
            const borderWidth = Math.max(8, 10 * zoom);

            // ── Per-structure dominance from server `dominators` lists ────
            // Mirrors the server's Render-Rule-X exactly: each circle (Mi)
            // is the unit of dominance, NOT the fort or the company. A
            // newly-placed structure has every overlapping enemy appended
            // to its own dominators list at placement time, so its overlap
            // with that enemy must render as the enemy's territory until a
            // claim flag promotes it. The fort itself, the conjoint blob,
            // and other dominant structures are unaffected.
            //
            // Per-Mi sets:
            //   subord(Mi)    = enemy circles E where E.id ∈ Mi.dominators
            //                   (E dominates Mi at the overlap → Mi.disc
            //                    carved + dashed Mi arc inside E).
            //   dominated(Mi) = enemy circles E where Mi.id ∈ E.dominators
            //                   (Mi dominates E at the overlap → solid
            //                    Mi-inner-rim + E-outer-rim doubled border).
            type EnemyCircle = { id: number; x: number; y: number; r: number };
            const allEnemyCircles: EnemyCircle[] = [];
            const enemyById = new Map<number, EnemyCircle>();
            for (const [otherCid, otherClaim] of islandClaimsByCo) {
              if (otherCid === cid) continue;
              for (const wc of otherClaim.worldCircles) {
                const sp = camera.worldToScreen(Vec2.from(wc.x + off.dx, wc.y + off.dy));
                const ec: EnemyCircle = { id: wc.id, x: sp.x, y: sp.y, r: wc.r * zoom };
                if (wc.id > 0) enemyById.set(wc.id, ec);
                allEnemyCircles.push(ec);
              }
            }
            const lookupStruct = (id: number): PlacedStructure | undefined =>
              id > 0 ? structById.get(id) : undefined;

            // ── miInfos: resolve subord/dominated from world-space cache ──
            // The filter sets (which enemies are in subord/dominated for each
            // Mi) are camera-independent and were computed once on structural
            // change. Here we just map the cached IDs to live screen-space
            // enemy circles.
            type MiInfo = {
              mi: { id: number; x: number; y: number; r: number };
              subord:    EnemyCircle[];
              dominated: EnemyCircle[];
            };
            const miInfos: MiInfo[] = screenPts.map(mi => ({
              mi,
              subord:    (_cachedMi.activeSubordIds.get(mi.id) ?? [])
                           .map(id => enemyById.get(id)).filter(Boolean) as EnemyCircle[],
              dominated: (_cachedMi.activeDomIds.get(mi.id) ?? [])
                           .map(id => enemyById.get(id)).filter(Boolean) as EnemyCircle[],
            }));

            // ── Helper: build a filled-disc union mask in this colour ─────
            const buildMask = (pts: Array<{ x: number; y: number; r: number }>, slot: string) => {
              if (pts.length === 0) return null;
              const m = this._getScratch(slot, cvs.width, cvs.height);
              const mc = m.getContext('2d')!;
              mc.fillStyle = color;
              for (const { x, y, r } of pts) {
                if (r <= 0) continue;
                mc.beginPath(); mc.arc(x, y, r, 0, Math.PI * 2); mc.fill();
              }
              return m;
            };

            const ownInnerCv      = buildMask(screenPts, 'ovOwnInner')!;
            const allEnemyInnerCv = buildMask(allEnemyCircles, 'ovEnemyInner');

            // ── Fill (tmp): per-Mi carve ──────────────────────────────────
            // tmp = ⋃ over Mi of (Mi.disc ∖ ⋃ subord(Mi).discs)
            // A pixel inside Mk that has no subord enemy at that pixel will
            // restore the fill via union, so dominant siblings preserve the
            // overlap they own even when a subordinate sibling is carved.
            const tmp = this._getScratch('ovActiveTmp', cvs.width, cvs.height);
            const tc  = tmp.getContext('2d')!;
            for (const info of miInfos) {
              if (info.mi.r <= 0) continue;
              const m = this._getScratch('ovActiveM', cvs.width, cvs.height);
              const mc = m.getContext('2d')!;
              mc.fillStyle = color;
              mc.beginPath(); mc.arc(info.mi.x, info.mi.y, info.mi.r, 0, Math.PI * 2); mc.fill();
              if (info.subord.length > 0) {
                mc.globalCompositeOperation = 'destination-out';
                for (const e of info.subord) {
                  mc.beginPath(); mc.arc(e.x, e.y, e.r, 0, Math.PI * 2); mc.fill();
                }
              }
              tc.drawImage(m, 0, 0);
            }

            // ── Ring construction ─────────────────────────────────────────
            const ring = this._getScratch('ovActiveRing', cvs.width, cvs.height);
            const rc   = ring.getContext('2d')!;
            rc.fillStyle = color;

            // Inset eraser used by pieces 1 & 2 and the dashed pass to
            // collapse concentric sibling contours into a single outermost
            // contour: a pixel inside any of MY circles shrunk by
            // (bw/2 + 1) lies DEEP inside that circle, so any other
            // circle's stroke / inner-rim band passing through that point
            // is interior to the union and should be erased. Preserves
            // each circle's own band [r-bw/2, r+bw/2] since
            // r-bw/2 > r-(bw/2+1).
            const ownShrunk = this._getScratch('ovShrunk', cvs.width, cvs.height);
            {
              const osc = ownShrunk.getContext('2d')!;
              osc.fillStyle = color;
              const inset = borderWidth / 2 + 1;
              for (const { x, y, r } of screenPts) {
                const rr = r - inset;
                if (rr <= 0) continue;
                osc.beginPath(); osc.arc(x, y, rr, 0, Math.PI * 2); osc.fill();
              }
            }

            // Piece (1) standard outer rim, centered on the circle boundary
            // so its center aligns with the doubled-border center along
            // contested arcs. Band spans [r - bw/2, r + bw/2]. Carved by
            // ALL enemy interiors so it disappears wherever a contested
            // doubled band (pieces 2 + 3) takes over.
            //   (own_dilated_by_bw/2 ∖ own_shrunk_by_bw/2) ∖ all_enemy_inner
            for (const { x, y, r } of screenPts) {
              rc.beginPath(); rc.arc(x, y, r + borderWidth / 2, 0, Math.PI * 2); rc.fill();
            }
            rc.globalCompositeOperation = 'destination-out';
            rc.drawImage(ownShrunk, 0, 0);
            if (allEnemyInnerCv) rc.drawImage(allEnemyInnerCv, 0, 0);
            rc.globalCompositeOperation = 'source-over';

            // ownShrunkDominant: same as ownShrunk but ONLY includes own
            // circles that are themselves dominant against at least one
            // enemy (non-empty dominated set). Used by piece (2) so that a
            // newly-placed subordinate sibling (e.g. A.new pushing into B)
            // does NOT erase the EXISTING dominant sibling's solid border
            // (e.g. A.fort's border with B) where it passes through the
            // newcomer's disc. The "true claim area" of the established
            // dominant structure must remain visible even when a contestable
            // newcomer overlaps it.
            const ownShrunkDominant = this._getScratch('ovShrunkDom', cvs.width, cvs.height);
            {
              const osc = ownShrunkDominant.getContext('2d')!;
              osc.fillStyle = color;
              const inset = borderWidth / 2 + 1;
              for (const info of miInfos) {
                if (info.dominated.length === 0) continue;
                const rr = info.mi.r - inset;
                if (rr <= 0) continue;
                osc.beginPath(); osc.arc(info.mi.x, info.mi.y, rr, 0, Math.PI * 2); osc.fill();
              }
            }

            // Piece (2) per-Mi inner rim — only along arcs inside enemies
            // that THIS Mi dominates. Per-Mi ensures a new structure placed
            // in dominant territory does NOT inherit the fort's doubled
            // border treatment vs. the same enemy. ownShrunkDominant erase
            // folds concentric DOMINANT sibling rings into a single
            // combined outline, but does NOT erase by subord-only siblings
            // (preserving the established dominant border where a new
            // contestable structure overlaps it).
            //
            // Band thickness is borderWidth/2 (half of a single line). The
            // matching piece (3) drawn by the dominating enemy's pass
            // contributes the other half, so the combined doubled border
            // along Mi's contested arc visually equals one full-width line
            // — split half own-colour / half enemy-colour.
            for (const info of miInfos) {
              if (info.dominated.length === 0) continue;
              if (info.mi.r <= 0) continue;
              const p2 = this._getScratch('ovP2', cvs.width, cvs.height);
              const p2c = p2.getContext('2d')!;
              p2c.fillStyle = color;
              p2c.beginPath(); p2c.arc(info.mi.x, info.mi.y, info.mi.r, 0, Math.PI * 2); p2c.fill();
              const rr = info.mi.r - borderWidth / 2;
              if (rr > 0) {
                p2c.globalCompositeOperation = 'destination-out';
                p2c.beginPath(); p2c.arc(info.mi.x, info.mi.y, rr, 0, Math.PI * 2); p2c.fill();
              }
              // Erase deep-interior segments so only the outermost contour
              // of own-dominant-union shows inside the contested area.
              p2c.globalCompositeOperation = 'destination-out';
              p2c.drawImage(ownShrunkDominant, 0, 0);
              // Erase arc segments that fall inside another allied circle M2
              // which also dominates the same enemy (co-dominant). Mi's ring
              // inside M2's disc lies within M2's established territory — it
              // would render as a redundant second border line on top of M2's
              // existing contested border. Remove it regardless of whether Mi
              // is fully or only partially enclosed in M2.
              {
                const allyErase = this._getScratch('ovP2AllyErase', cvs.width, cvs.height);
                const aec = allyErase.getContext('2d')!;
                aec.fillStyle = color;
                for (const e of info.dominated) {
                  const eStruct = lookupStruct(e.id);
                  if (!eStruct?.dominators) continue;
                  for (const m2 of screenPts) {
                    if (m2.id === info.mi.id || m2.r <= 0) continue;
                    if (!eStruct.dominators.includes(m2.id)) continue;
                    aec.beginPath(); aec.arc(m2.x, m2.y, m2.r, 0, Math.PI * 2); aec.fill();
                  }
                }
                p2c.drawImage(allyErase, 0, 0);
              }
              // Clip to union of dominated enemies of THIS Mi.
              p2c.globalCompositeOperation = 'destination-in';
              const domMask = this._getScratch('ovP2Dom', cvs.width, cvs.height);
              const dmc2 = domMask.getContext('2d')!;
              dmc2.fillStyle = color;
              for (const e of info.dominated) {
                dmc2.beginPath(); dmc2.arc(e.x, e.y, e.r, 0, Math.PI * 2); dmc2.fill();
              }
              p2c.drawImage(domMask, 0, 0);
              rc.drawImage(p2, 0, 0);
            }

            // Piece (3) per-Mi: outer-rim band of the UNION of enemies that
            // dominate Mi, clipped to Mi.disc — the E-outer half of the
            // doubled border along Mi's contested arc. Using the union (vs
            // per-enemy bands) prevents a band from being drawn through the
            // interior of an adjacent dominant enemy when several overlap.
            //
            // Band thickness is borderWidth/2; pairs with the dominating
            // enemy's piece (2) inset band (also borderWidth/2) so the two
            // colours stack into a single-line-equivalent doubled border.
            for (const info of miInfos) {
              if (info.subord.length === 0) continue;
              if (info.mi.r <= 0) continue;
              const p3 = this._getScratch('ovP3', cvs.width, cvs.height);
              const p3c = p3.getContext('2d')!;
              p3c.fillStyle = color;
              // dilated union of subord enemies
              for (const e of info.subord) {
                p3c.beginPath(); p3c.arc(e.x, e.y, e.r + borderWidth / 2, 0, Math.PI * 2); p3c.fill();
              }
              // subtract un-dilated union → band along ∂(union)
              p3c.globalCompositeOperation = 'destination-out';
              for (const e of info.subord) {
                p3c.beginPath(); p3c.arc(e.x, e.y, e.r, 0, Math.PI * 2); p3c.fill();
              }
              // Clip to Mi.disc.
              p3c.globalCompositeOperation = 'destination-in';
              p3c.beginPath(); p3c.arc(info.mi.x, info.mi.y, info.mi.r, 0, Math.PI * 2); p3c.fill();
              rc.drawImage(p3, 0, 0);
            }

            // Dashed pass: per-Mi. Stroke Mi clipped to its subord union;
            // ownShrunk erase folds concentric sibling arcs into one clean
            // dashed loop per contested region.
            for (const info of miInfos) {
              if (info.subord.length === 0) continue;
              if (info.mi.r <= 0) continue;
              const d = this._getScratch('ovDashed', cvs.width, cvs.height);
              const dc = d.getContext('2d')!;
              dc.strokeStyle = color;
              dc.lineWidth   = borderWidth;
              dc.setLineDash([borderWidth * 1.5, borderWidth * 1.5]);
              dc.beginPath(); dc.arc(info.mi.x, info.mi.y, info.mi.r, 0, Math.PI * 2); dc.stroke();
              dc.globalCompositeOperation = 'destination-out';
              dc.drawImage(ownShrunk, 0, 0);
              dc.globalCompositeOperation = 'destination-in';
              const subMask = this._getScratch('ovDashedSub', cvs.width, cvs.height);
              const sbc = subMask.getContext('2d')!;
              sbc.fillStyle = color;
              for (const e of info.subord) {
                sbc.beginPath(); sbc.arc(e.x, e.y, e.r, 0, Math.PI * 2); sbc.fill();
              }
              dc.drawImage(subMask, 0, 0);
              rc.drawImage(d, 0, 0);
            }

            // Own company: full fill + solid border.
            // Other companies: subtle fill + softer border (still readable, less prominent).
            // (Translucent blob fill removed by user request — only borders
            // and contested-area hatching remain as visual cues.)

            // ── Contested area: solid diagonal hatching ───────────────────
            // Drawn only when THIS company (cid) has an active (non-orphaned)
            // claim_flag down on this island. Hatching is rendered in the
            // claimer's territory colour over the intersection of the
            // claimer's claim circles with any enemy claim circles.
            const hasActiveClaimFlag = this.placedStructures.some(
              s => s.type === 'claim_flag'
                && !s.claimOrphaned
                && s.islandId === isl.id
                && (s.companyId ?? 0) === cid
            );
            // True when ANY of this company's active claim flags on this
            // island is currently in the CONTEST state (claimState === 0).
            // Used to flicker the hatching so contested areas read as
            // visually unstable.
            const isContestFlickering = hasActiveClaimFlag && this.placedStructures.some(
              s => s.type === 'claim_flag'
                && !s.claimOrphaned
                && s.islandId === isl.id
                && (s.companyId ?? 0) === cid
                && (s.claimState ?? 0) === 0
            );
            if (hasActiveClaimFlag && allEnemyInnerCv) {
              // Build per-flag SECTION mask: for each of this company's
              // active claim_flags on this island, the contested section is
              // the connected component (under disc-overlap adjacency) of
              //   sliceAll = ⋃ lens(Mi, Ej) ∖ tmp_own
              // that contains the flag's position. This matches the server
              // section flood-fill, so the hatching covers EVERY targeted
              // structure pair, not just the flag's bound source pair.
              const sliceMask = this._getScratch('ovSliceMask', cvs.width, cvs.height);
              const smc = sliceMask.getContext('2d')!;
              smc.clearRect(0, 0, cvs.width, cvs.height);

              // (1) Build lensUnion in screen space once for this island/cid.
              const lensUnion = this._getScratch('ovSliceLensU', cvs.width, cvs.height);
              const lu = lensUnion.getContext('2d')!;
              lu.clearRect(0, 0, cvs.width, cvs.height);
              const lensTmp = this._getScratch('ovSliceLensT', cvs.width, cvs.height);
              const lt = lensTmp.getContext('2d')!;
              for (const mi of screenPts) {
                for (const ej of allEnemyCircles) {
                  const dx = mi.x - ej.x, dy = mi.y - ej.y;
                  const sum = mi.r + ej.r;
                  if (dx * dx + dy * dy >= sum * sum) continue;
                  lt.globalCompositeOperation = 'source-over';
                  lt.clearRect(0, 0, cvs.width, cvs.height);
                  lt.fillStyle = '#fff';
                  lt.beginPath(); lt.arc(mi.x, mi.y, mi.r, 0, Math.PI * 2); lt.fill();
                  lt.globalCompositeOperation = 'destination-in';
                  lt.beginPath(); lt.arc(ej.x, ej.y, ej.r, 0, Math.PI * 2); lt.fill();
                  lu.drawImage(lensTmp, 0, 0);
                }
              }

              // (2) sliceAll = lensUnion ∖ tmp_own (tmp already carved per Mi).
              lu.globalCompositeOperation = 'destination-out';
              lu.drawImage(tmp, 0, 0);
              lu.globalCompositeOperation = 'source-over';

              // (3) Downsample alpha into grid for flood-fill.
              const cellWorld = 4;
              const cellPx = Math.max(1, Math.round(cellWorld * zoom));
              const gw = Math.max(1, Math.floor(cvs.width / cellPx));
              const gh = Math.max(1, Math.floor(cvs.height / cellPx));
              const sliceData = lu.getImageData(0, 0, cvs.width, cvs.height).data;
              const inSlice = new Uint8Array(gw * gh);
              for (let gy = 0; gy < gh; gy++) {
                const py = Math.min(cvs.height - 1, (gy + 0.5) * cellPx | 0);
                for (let gx = 0; gx < gw; gx++) {
                  const px = Math.min(cvs.width - 1, (gx + 0.5) * cellPx | 0);
                  if (sliceData[(py * cvs.width + px) * 4 + 3] > 8) inSlice[gy * gw + gx] = 1;
                }
              }

              // (4) For each flag, flood-fill from its grid cell and OR the
              //     resulting section into sliceMask (intersected with the
              //     smooth sliceAll mask).
              const sectionGrid = this._getScratch('ovSliceGrid', cvs.width, cvs.height);
              const sg = sectionGrid.getContext('2d')!;
              const perFlagMask = this._getScratch('ovSliceFlag', cvs.width, cvs.height);
              const pfc = perFlagMask.getContext('2d')!;
              for (const flag of this.placedStructures) {
                if (flag.type !== 'claim_flag') continue;
                if (flag.claimOrphaned) continue;
                if (flag.islandId !== isl.id) continue;
                if ((flag.companyId ?? 0) !== cid) continue;
                const fsp = camera.worldToScreen(Vec2.from(flag.x + off.dx, flag.y + off.dy));
                const cgx = Math.max(0, Math.min(gw - 1, Math.floor(fsp.x / cellPx)));
                const cgy = Math.max(0, Math.min(gh - 1, Math.floor(fsp.y / cellPx)));
                if (!inSlice[cgy * gw + cgx]) continue;
                const section = new Uint8Array(gw * gh);
                const stack: number[] = [cgy * gw + cgx];
                section[cgy * gw + cgx] = 1;
                while (stack.length) {
                  const k = stack.pop()!;
                  const x = k % gw, y = (k / gw) | 0;
                  if (x > 0)        { const n = k - 1;  if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); } }
                  if (x < gw - 1)   { const n = k + 1;  if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); } }
                  if (y > 0)        { const n = k - gw; if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); } }
                  if (y < gh - 1)   { const n = k + gw; if (inSlice[n] && !section[n]) { section[n] = 1; stack.push(n); } }
                }
                // Rasterize section cells into sectionGrid (run-length).
                sg.clearRect(0, 0, cvs.width, cvs.height);
                sg.fillStyle = '#fff';
                for (let gy = 0; gy < gh; gy++) {
                  let runStart = -1;
                  for (let gx = 0; gx <= gw; gx++) {
                    const on = gx < gw && !!section[gy * gw + gx];
                    if (on && runStart < 0) runStart = gx;
                    else if (!on && runStart >= 0) {
                      sg.fillRect(runStart * cellPx, gy * cellPx, (gx - runStart) * cellPx, cellPx);
                      runStart = -1;
                    }
                  }
                }
                // Intersect grid with smooth sliceAll for clean edges.
                pfc.clearRect(0, 0, cvs.width, cvs.height);
                pfc.drawImage(lu.canvas, 0, 0);
                pfc.globalCompositeOperation = 'destination-in';
                pfc.drawImage(sectionGrid, 0, 0);
                pfc.globalCompositeOperation = 'source-over';
                smc.drawImage(perFlagMask, 0, 0);
              }
              // Hatching belongs on the ENEMY's side of the dominance
              // border: the slice's visible portion is the lens minus own's
              // carved territory (tmp). Where own dominates the enemy, the
              // lens is already painted with own's solid territory, so we
              // remove it. Where own is subordinate (the claim-flag scenario),
              // the lens lies in the enemy's visible area — that's exactly
              // what remains and is what gets hatched.
              smc.globalCompositeOperation = 'destination-out';
              smc.drawImage(tmp, 0, 0);
              smc.globalCompositeOperation = 'source-over';

              // Solid diagonal stripe pattern in the claimer's colour.
              // Stripes are anchored to world space (move with the camera) and
              // slowly translate along their perpendicular axis for a "marching
               // ants" feel without the harsh blink.
              const hatch = this._getScratch('ovHatch', cvs.width, cvs.height);
              const hc = hatch.getContext('2d')!;
              // `stripeGap` is the x-axis spacing between consecutive 45°
              // strokes. Their PERPENDICULAR spacing is stripeGap / √2, so
              // for equal painted-band and gap widths, lineWidth must be
              // half of that perpendicular spacing.
              const stripeGap = Math.max(16, 28 * zoom);
              hc.strokeStyle = color;
              hc.lineWidth   = stripeGap / (2 * Math.SQRT2);
              // World-anchored phase: project world origin onto stripe-perp
              // axis (x - y). Adding camera-anchored offset makes stripes
              // appear to stay glued to the world as the camera pans.
              const worldOrigin = camera.worldToScreen(Vec2.from(off.dx, off.dy));
              const animSpeedPxPerMs = 0.006; // ~6 px/sec at zoom 1
              const phase = ((worldOrigin.x - worldOrigin.y)
                           + performance.now() * animSpeedPxPerMs) % stripeGap;
              const diagLen = cvs.width + cvs.height;
              for (let d = -diagLen + phase; d < diagLen + cvs.width; d += stripeGap) {
                hc.beginPath();
                hc.moveTo(d, 0);
                hc.lineTo(d + cvs.height, cvs.height);
                hc.stroke();
              }
              // Clip stripes to the per-flag slice mask
              hc.globalCompositeOperation = 'destination-in';
              hc.drawImage(sliceMask, 0, 0);

              ctx.globalAlpha = 0.30;
              if (isContestFlickering) {
                // Sine-wave flicker between ~0.10 and ~0.50, ~1.4 Hz.
                const t = performance.now() * 0.009;
                ctx.globalAlpha = 0.30 + 0.20 * Math.sin(t);
              }
              ctx.drawImage(hatch, 0, 0);
              ctx.globalAlpha = 1.0;

              // ── Contest section labels ────────────────────────────────────
              // For each enemy company this company is actively contesting,
              // draw a "CompanyA↔CompanyB" badge at the centroid of their
              // overlapping disc pairs so it sits inside the hatched zone.
              if (zoom >= 0.5) {
                for (const [enemyCid, enemyClaim] of islandClaimsByCo) {
                  if (enemyCid === cid) continue;
                  if (enemyClaim.worldCircles.length === 0) continue;
                  // Only show label when there's an active flag for this section
                  const sectHasFlag = this.placedStructures.some(f =>
                    f.type === 'claim_flag'
                    && !f.claimOrphaned
                    && f.islandId === isl.id
                    && (f.companyId ?? 0) === cid
                    && (() => { const es = structById.get(f.claimSourceEnemy ?? 0); return es !== undefined && es.companyId === enemyCid; })()
                  );
                  if (!sectHasFlag) continue;
                  const enemySP = enemyClaim.worldCircles.map(wc => {
                    const sp = camera.worldToScreen(Vec2.from(wc.x + off.dx, wc.y + off.dy));
                    return { x: sp.x, y: sp.y, r: wc.r * zoom };
                  });
                  let scx = 0, scy = 0, sn = 0;
                  for (const mi of screenPts) {
                    for (const ej of enemySP) {
                      const dx = mi.x - ej.x, dy = mi.y - ej.y;
                      const sum = mi.r + ej.r;
                      if (dx * dx + dy * dy < sum * sum) {
                        scx += (mi.x + ej.x) * 0.5;
                        scy += (mi.y + ej.y) * 0.5;
                        sn++;
                      }
                    }
                  }
                  if (sn === 0) continue;
                  scx /= sn; scy /= sn;
                  const enemyName = this._cachedCompanies.find(c => c.id === enemyCid)?.name
                    ?? (enemyCid === 1 ? 'Solo' : enemyCid === 2 ? 'Pirates' : enemyCid === 3 ? 'Navy' : `#${enemyCid}`);
                  const sectLabel = `${companyName}↔${enemyName}`;
                  const sf = Math.max(10, Math.round(12 * zoom));
                  ctx.save();
                  ctx.font = `bold ${sf}px Georgia, serif`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  const tw = ctx.measureText(sectLabel).width;
                  ctx.fillStyle = 'rgba(10,10,10,0.80)';
                  ctx.fillRect(scx - tw / 2 - 4, scy - sf / 2 - 3, tw + 8, sf + 6);
                  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
                  ctx.lineWidth = Math.max(2, 2.5 * zoom);
                  ctx.fillStyle = 'rgba(255,220,80,0.95)';
                  ctx.strokeText(sectLabel, scx, scy);
                  ctx.fillText(sectLabel, scx, scy);
                  ctx.restore();
                }
              }
            }

            // Borders (including the dashed subordinate "inner" border) are
            // drawn LAST so they sit above the contested-area hatching.
            ctx.globalAlpha = isOwn ? 0.90 : 0.50;
            ctx.drawImage(ring, 0, 0);
            ctx.globalAlpha = 1.0;

            // Label at blob centroid
            let cx = 0, cy = 0;
            for (const p of screenPts) { cx += p.x; cy += p.y; }
            cx /= screenPts.length; cy /= screenPts.length;

            const fontSize = Math.max(12, Math.round(14 * zoom));
            ctx.font = `bold ${fontSize}px Georgia, serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = Math.max(2, 3 * zoom);
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.fillStyle = '#ffffff';
            ctx.strokeText(companyName, cx, cy);
            ctx.fillText(companyName, cx, cy);
          }

          // ── Inactive territory: same multi-pass border system, dimmed ─────
          // inactiveList circles (BFS-disconnected from own fort) are rendered
          // with the same piece 1/2/3/dashed ring system as active territory so
          // borders between inactive and enemy circles look identical to active
          // vs. active borders. The only differences are:
          //   • iOwnShrunkAll includes ALL own circles (active + inactive), so
          //     no double-border appears at the active/inactive company boundary.
          //   • The ring is drawn at a reduced alpha to visually distinguish
          //     disconnected territory from fully-connected territory.
          if (inactiveList.length > 0) {
            const iBW = Math.max(8, 10 * zoom);

            // Convert inactive structures to screen-space points.
            const iPts: Array<{ id: number; x: number; y: number; r: number }> = [];
            for (const ps of inactiveList) {
              const sp = camera.worldToScreen(Vec2.from(ps.x + off.dx, ps.y + off.dy));
              iPts.push({ id: ps.id, x: sp.x, y: sp.y, r: psR });
            }

            // Enemy circles: active territory circles of other companies.
            const iEnemyCircles: Array<{ id: number; x: number; y: number; r: number }> = [];
            const iEnemyById = new Map<number, { id: number; x: number; y: number; r: number }>();
            for (const [otherCid, otherClaim] of islandClaimsByCo) {
              if (otherCid === cid) continue;
              for (const wc of otherClaim.worldCircles) {
                const sp = camera.worldToScreen(Vec2.from(wc.x + off.dx, wc.y + off.dy));
                const ec = { id: wc.id, x: sp.x, y: sp.y, r: wc.r * zoom };
                if (wc.id > 0) iEnemyById.set(wc.id, ec);
                iEnemyCircles.push(ec);
              }
            }

            // Shrunk union of ALL own circles (active + inactive). Prevents a
            // double-border from appearing where active and inactive own territory
            // share a boundary.
            const iOwnShrunkAll = this._getScratch('ovInaOwnShrunk', cvs.width, cvs.height);
            {
              const osc = iOwnShrunkAll.getContext('2d')!;
              osc.fillStyle = color;
              const inset = iBW / 2 + 1;
              for (const { x, y, r } of [...screenPts, ...iPts]) {
                const rr = r - inset;
                if (rr <= 0) continue;
                osc.beginPath(); osc.arc(x, y, rr, 0, Math.PI * 2); osc.fill();
              }
            }

            // Filled enemy inner discs for carving piece 1.
            let iAllEnemyInner: OffscreenCanvas | null = null;
            if (iEnemyCircles.length > 0) {
              const m = this._getScratch('ovInaEnemyInner', cvs.width, cvs.height);
              const mc = m.getContext('2d')!;
              mc.fillStyle = color;
              for (const { x, y, r } of iEnemyCircles) {
                if (r <= 0) continue;
                mc.beginPath(); mc.arc(x, y, r, 0, Math.PI * 2); mc.fill();
              }
              iAllEnemyInner = m;
            }

            // Per-inactive-circle dominance info — resolved from world-space cache.
            const iMiInfos = iPts.map(mi => ({
              mi,
              subord:    (_cachedMi.inactiveSubordIds.get(mi.id) ?? [])
                           .map(id => iEnemyById.get(id)).filter(Boolean) as typeof iEnemyCircles,
              dominated: (_cachedMi.inactiveDomIds.get(mi.id) ?? [])
                           .map(id => iEnemyById.get(id)).filter(Boolean) as typeof iEnemyCircles,
            }));

            const iRing = this._getScratch('ovInaRing', cvs.width, cvs.height);
            const irc   = iRing.getContext('2d')!;
            irc.fillStyle = color;

            // Piece 1: standard outer rim, carved by enemy interiors and iOwnShrunkAll.
            for (const { x, y, r } of iPts) {
              irc.beginPath(); irc.arc(x, y, r + iBW / 2, 0, Math.PI * 2); irc.fill();
            }
            irc.globalCompositeOperation = 'destination-out';
            irc.drawImage(iOwnShrunkAll, 0, 0);
            if (iAllEnemyInner) irc.drawImage(iAllEnemyInner, 0, 0);
            irc.globalCompositeOperation = 'source-over';

            // Piece 2: inner rim where an inactive circle dominates an enemy.
            for (const info of iMiInfos) {
              if (info.dominated.length === 0) continue;
              if (info.mi.r <= 0) continue;
              const p2  = this._getScratch('ovInaP2', cvs.width, cvs.height);
              const p2c = p2.getContext('2d')!;
              p2c.fillStyle = color;
              p2c.beginPath(); p2c.arc(info.mi.x, info.mi.y, info.mi.r, 0, Math.PI * 2); p2c.fill();
              const rr = info.mi.r - iBW / 2;
              if (rr > 0) {
                p2c.globalCompositeOperation = 'destination-out';
                p2c.beginPath(); p2c.arc(info.mi.x, info.mi.y, rr, 0, Math.PI * 2); p2c.fill();
              }
              p2c.globalCompositeOperation = 'destination-out';
              p2c.drawImage(iOwnShrunkAll, 0, 0);
              // Same allied co-dominant erase as active territory: remove
              // ring pixels inside any allied circle M2 (active or inactive)
              // that also dominates the same enemy.
              {
                const allyErase = this._getScratch('ovInaP2AllyErase', cvs.width, cvs.height);
                const aec = allyErase.getContext('2d')!;
                aec.fillStyle = color;
                const allOwnPts = [...screenPts, ...iPts];
                for (const e of info.dominated) {
                  const eStruct = structById.get(e.id);
                  if (!eStruct?.dominators) continue;
                  for (const m2 of allOwnPts) {
                    if (m2.id === info.mi.id || m2.r <= 0) continue;
                    if (!eStruct.dominators.includes(m2.id)) continue;
                    aec.beginPath(); aec.arc(m2.x, m2.y, m2.r, 0, Math.PI * 2); aec.fill();
                  }
                }
                p2c.drawImage(allyErase, 0, 0);
              }
              p2c.globalCompositeOperation = 'destination-in';
              const domMask = this._getScratch('ovInaP2Dom', cvs.width, cvs.height);
              const dmc    = domMask.getContext('2d')!;
              dmc.fillStyle = color;
              for (const e of info.dominated) {
                dmc.beginPath(); dmc.arc(e.x, e.y, e.r, 0, Math.PI * 2); dmc.fill();
              }
              p2c.drawImage(domMask, 0, 0);
              irc.drawImage(p2, 0, 0);
            }

            // Piece 3: outer rim of dominating enemies clipped to the inactive circle.
            for (const info of iMiInfos) {
              if (info.subord.length === 0) continue;
              if (info.mi.r <= 0) continue;
              const p3  = this._getScratch('ovInaP3', cvs.width, cvs.height);
              const p3c = p3.getContext('2d')!;
              p3c.fillStyle = color;
              for (const e of info.subord) {
                p3c.beginPath(); p3c.arc(e.x, e.y, e.r + iBW / 2, 0, Math.PI * 2); p3c.fill();
              }
              p3c.globalCompositeOperation = 'destination-out';
              for (const e of info.subord) {
                p3c.beginPath(); p3c.arc(e.x, e.y, e.r, 0, Math.PI * 2); p3c.fill();
              }
              p3c.globalCompositeOperation = 'destination-in';
              p3c.beginPath(); p3c.arc(info.mi.x, info.mi.y, info.mi.r, 0, Math.PI * 2); p3c.fill();
              irc.drawImage(p3, 0, 0);
            }

            // Dashed pass: dashed arc inside each subord enemy, per inactive circle.
            for (const info of iMiInfos) {
              if (info.subord.length === 0) continue;
              if (info.mi.r <= 0) continue;
              const d  = this._getScratch('ovInaDashed', cvs.width, cvs.height);
              const dc = d.getContext('2d')!;
              dc.strokeStyle = color;
              dc.lineWidth   = iBW;
              dc.setLineDash([iBW * 1.5, iBW * 1.5]);
              dc.beginPath(); dc.arc(info.mi.x, info.mi.y, info.mi.r, 0, Math.PI * 2); dc.stroke();
              dc.globalCompositeOperation = 'destination-out';
              dc.drawImage(iOwnShrunkAll, 0, 0);
              dc.globalCompositeOperation = 'destination-in';
              const subMask = this._getScratch('ovInaDashedSub', cvs.width, cvs.height);
              const sbc     = subMask.getContext('2d')!;
              sbc.fillStyle = color;
              for (const e of info.subord) {
                sbc.beginPath(); sbc.arc(e.x, e.y, e.r, 0, Math.PI * 2); sbc.fill();
              }
              dc.drawImage(subMask, 0, 0);
              irc.drawImage(d, 0, 0);
            }

            // Draw at dimmed alpha (≈60 % of the active territory alpha).
            ctx.globalAlpha = isOwn ? 0.55 : 0.30;
            ctx.drawImage(iRing, 0, 0);
            ctx.globalAlpha = 1.0;

            // Label: company name + "(inactive)" at centroid.
            let icx = 0, icy = 0;
            for (const p of iPts) { icx += p.x; icy += p.y; }
            icx /= iPts.length; icy /= iPts.length;
            const iFontSize = Math.max(11, Math.round(13 * zoom));
            ctx.font = `bold ${iFontSize}px Georgia, serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = Math.max(2, 3 * zoom);
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            const iLineGap = iFontSize * 1.2;
            ctx.fillStyle = '#ffffff';
            ctx.strokeText(companyName, icx, icy - iLineGap / 2);
            ctx.fillText(companyName, icx, icy - iLineGap / 2);
            ctx.fillStyle = '#ff5555';
            ctx.strokeText('(inactive)', icx, icy + iLineGap / 2);
            ctx.fillText('(inactive)', icx, icy + iLineGap / 2);
          }

          // ── Per-fort claim-phase blobs (CLAIMING / BUILDING) ─────────────
          // Each non-active flag fort renders its own standalone circle so
          // pending territory is visually distinct from established blobs.
          // We render these for every company (own and others) at all times
          // — players need to see incoming claims even on enemy turf.
          //
          // SUBORDINATE-TO-ACTIVE rule: any pixel inside ANY company's
          // active territory (own or enemy) carves the non-active blob
          // (fill + ring). Along that cut arc we draw a 1× dashed border
          // in the non-active company's colour, mirroring the dashed
          // subordinate-arc treatment used between two active companies
          // in a dominance pair.
          if (nonActiveForts.length > 0) {
            const borderWidth = Math.max(8, 10 * zoom);
            const r = CLAIM_RADIUS_FORT * zoom;
            // 1Hz flashing alpha for BUILDING phase (sine wave 0.35–0.85).
            const flashT     = performance.now() * 0.006; // ≈1 Hz
            const flashAlpha = 0.60 + 0.25 * Math.sin(flashT);

            // Union of all ACTIVE interiors on this island (every company,
            // own + enemy). Used to carve each non-active fort blob so
            // active territory always wins overlapping pixels.
            const activeUnion = this._getScratch('ovActiveUnion', cvs.width, cvs.height);
            const auc = activeUnion.getContext('2d')!;
            auc.fillStyle = '#000';
            let activeUnionHasAny = false;
            for (const [, otherClaim] of islandClaimsByCo) {
              for (const wc of otherClaim.worldCircles) {
                const sp2 = camera.worldToScreen(Vec2.from(wc.x + off.dx, wc.y + off.dy));
                const rr  = wc.r * zoom;
                if (rr <= 0) continue;
                auc.beginPath(); auc.arc(sp2.x, sp2.y, rr, 0, Math.PI * 2); auc.fill();
                activeUnionHasAny = true;
              }
            }

            for (const fort of nonActiveForts) {
              const sp = camera.worldToScreen(Vec2.from(fort.x + off.dx, fort.y + off.dy));
              const phase = (typeof fort.claimPhase === 'number') ? fort.claimPhase : 1;
              const contested = fort.fortressContested || fort.claimContested;

              // Colour scheme: CLAIMING is grey (territory not yet claimed),
              // BUILDING uses the company colour but flashes (territory
              // claimed but fortifications not yet established).
              // DEMOLISHING (phase 3) = captured; red flashing ring.
              const isClaiming    = phase === 0;
              const isDemolishing = phase === 3;
              // Post-demolish: fort is in CLAIMING with hp==0 (counting down to destruction)
              const isPostDemolish = isClaiming && (fort.hp ?? 1) === 0;
              const fillCol = (isDemolishing || isPostDemolish) ? '#882222' : (isClaiming ? '#888888' : color);
              const ringCol = (isDemolishing || isPostDemolish) ? '#cc3333' : (isClaiming ? '#666666' : color);

              // Build fill mask, then carve by active union so active
              // territory wins overlapping pixels.
              const ftmp = this._getScratch('ovFTmp', cvs.width, cvs.height);
              const ftc  = ftmp.getContext('2d')!;
              ftc.fillStyle = fillCol;
              ftc.beginPath(); ftc.arc(sp.x, sp.y, r, 0, Math.PI * 2); ftc.fill();
              if (activeUnionHasAny) {
                ftc.globalCompositeOperation = 'destination-out';
                ftc.drawImage(activeUnion, 0, 0);
                ftc.globalCompositeOperation = 'source-over';
              }

              // Build ring mask. For BUILDING (phase 1) the ring is centred on
              // the circle boundary to match the active-fort border design:
              //   inner = r - bw/2, outer = r + bw/2
              // All other non-active phases keep the ring fully outside:
              //   inner = r, outer = r + bw
              const isBuilding = !isClaiming && !isDemolishing && !isPostDemolish;
              const ringOuter = isBuilding ? r + borderWidth / 2 : r + borderWidth;
              const ringInner = isBuilding ? Math.max(0, r - borderWidth / 2) : r;
              const fring = this._getScratch('ovFRing', cvs.width, cvs.height);
              const frc   = fring.getContext('2d')!;
              frc.fillStyle = ringCol;
              frc.beginPath(); frc.arc(sp.x, sp.y, ringOuter, 0, Math.PI * 2); frc.fill();
              frc.globalCompositeOperation = 'destination-out';
              frc.beginPath(); frc.arc(sp.x, sp.y, ringInner, 0, Math.PI * 2); frc.fill();
              if (activeUnionHasAny) {
                frc.drawImage(activeUnion, 0, 0);
              }
              frc.globalCompositeOperation = 'source-over';

              // Translucent fill removed by user request — only borders and
              // contested hatching remain as visual cues. ftmp is still built
              // because the hatching pass uses it as its clip mask.

              // Contest stripes (CLAIMING phase only): the whole CLAIMING
              // phase is an in-progress capture, so we show the same
              // company-coloured "marching ants" hatching that the claim_flag
              // capture system uses, with the same sine-flicker when the
              // claim is in the CONTEST state (claimState === 0).
              if (isClaiming) {
                const hatch = this._getScratch('ovFHatch', cvs.width, cvs.height);
                const hc = hatch.getContext('2d')!;
                const stripeGap = Math.max(16, 28 * zoom);
                hc.strokeStyle = color;
                hc.lineWidth   = stripeGap / (2 * Math.SQRT2);
                // World-anchored phase: project world origin onto stripe-perp
                // axis (x - y) + slow time march. Matches capture-overlay.
                const worldOrigin = camera.worldToScreen(Vec2.from(off.dx, off.dy));
                const animSpeedPxPerMs = 0.006;
                const stripePhase = ((worldOrigin.x - worldOrigin.y)
                                  + performance.now() * animSpeedPxPerMs) % stripeGap;
                const diagLen = cvs.width + cvs.height;
                for (let d = -diagLen + stripePhase; d < diagLen + cvs.width; d += stripeGap) {
                  hc.beginPath();
                  hc.moveTo(d, 0);
                  hc.lineTo(d + cvs.height, cvs.height);
                  hc.stroke();
                }
                hc.globalCompositeOperation = 'destination-in';
                hc.drawImage(ftmp, 0, 0);

                // Flicker when CONTEST (enemy in radius stalling the claim).
                const isContestState = (fort.claimState ?? 0) === 0 && contested;
                ctx.globalAlpha = isContestState
                  ? 0.30 + 0.20 * Math.sin(performance.now() * 0.009)
                  : 0.30;
                ctx.drawImage(hatch, 0, 0);
              }

              // BUILDING uses active-fort base alphas (own 0.90, enemy 0.50)
              // modulated by flashAlpha so the ring pulses but at the same
              // peak brightness as a fully-active fort border.
              const ringAlpha = isClaiming ? 0.55
                : (isDemolishing || isPostDemolish) ? flashAlpha
                : flashAlpha * (isOwn ? 0.90 : 0.50);
              ctx.globalAlpha = ringAlpha;
              ctx.drawImage(fring, 0, 0);
              ctx.globalAlpha = 1.0;

              // ── Subordinate dashed border ────────────────────────────
              // Along this non-active fort's perimeter where it sits INSIDE
              // any active territory, draw a 1× dashed line in the
              // non-active company's colour. Mirrors the dashed subordinate
              // arc drawn between two active companies in a dominance pair.
              if (activeUnionHasAny) {
                const dash = this._getScratch('ovFDash', cvs.width, cvs.height);
                const ddc  = dash.getContext('2d')!;
                ddc.strokeStyle = ringCol;
                ddc.lineWidth   = borderWidth;
                ddc.setLineDash([borderWidth * 1.5, borderWidth * 1.5]);
                ddc.beginPath(); ddc.arc(sp.x, sp.y, r, 0, Math.PI * 2); ddc.stroke();
                ddc.globalCompositeOperation = 'destination-in';
                ddc.drawImage(activeUnion, 0, 0);
                ctx.globalAlpha = ringAlpha;
                ctx.drawImage(dash, 0, 0);
                ctx.globalAlpha = 1.0;
              }

              // Label inside the blob: phase + (CONTESTED tag).
              const fontSize = Math.max(11, Math.round(12 * zoom));
              ctx.font = `bold ${fontSize}px Georgia, serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.lineWidth = Math.max(2, 3 * zoom);
              ctx.strokeStyle = 'rgba(0,0,0,0.75)';
              const remSec = typeof fort.claimPhaseProgressMs === 'number'
                ? Math.ceil(fort.claimPhaseProgressMs / 1000) : null;
              const label = isDemolishing
                ? (contested ? `${companyName} — DEMOLISHING (defended)` : `${companyName} — DEMOLISHING`)
                : isPostDemolish
                ? (contested
                  ? `${companyName} — UNCLAIMING (defended)${remSec !== null ? ` ${remSec}s` : ''}`
                  : `${companyName} — UNCLAIMING${remSec !== null ? ` ${remSec}s` : ''}`)
                : (isClaiming
                  ? (contested ? `${companyName} — CLAIMING (contested)` : `${companyName} — CLAIMING`)
                  : (contested ? `${companyName} — BUILDING (contested)` : `${companyName} — BUILDING`));
              ctx.fillStyle = (isDemolishing || isPostDemolish) ? '#ff8888' : (isClaiming ? '#dddddd' : '#ffffff');
              ctx.strokeText(label, sp.x, sp.y);
              ctx.fillText(label, sp.x, sp.y);
            }
          }

          ctx.restore();
        }
      }
    }

    // ── Pass 3: removed by user request ─────────────────────────────────
    // Previously repainted dominator-captured overlaps in the dominator's
    // colour at the same alpha as Pass 2's fill. With all translucent
    // fills removed, captured overlaps are now expressed solely through
    // the doubled solid border (Pass 2 pieces 2+3) along the contested
    // arc, with no fill colour distinction inside.

    // ── Pass 4: inactive Flag Fort indicator ─────────────────────────────
    // Draws a dashed amber outline around the claim radius of any flag fort
    // that hasn't yet healed to its 30%-HP active gate. This is a passive
    // visual cue — territory dominance is unchanged for inactive forts, but
    // the player should be able to see at-a-glance which anchors are still
    // building up (or have been beaten below the active threshold).
    for (const ps of this.placedStructures) {
      if (ps.type !== 'flag_fort') continue;
      if (ps.fortressComplete !== false) continue; // active or unknown → no overlay
      if (ps.claimOrphaned) continue;
      const color = ps.fortressContested ? '#ff7050' : '#ffc848';
      const wrapOffsetsAll = this.getWrapRenderOffsets(Vec2.from(ps.x, ps.y), camera, CLAIM_RADIUS_FORT + 50);
      for (const off of wrapOffsetsAll) {
        const sc = camera.worldToScreen(Vec2.from(ps.x + off.dx, ps.y + off.dy));
        const sr = CLAIM_RADIUS_FORT * zoom;
        if (sr <= 0) continue;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, 2 * zoom);
        ctx.setLineDash([8 * zoom, 6 * zoom]);
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, sr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

      offCtx.restore();
      this._claimOverlayCachedCamX = camX;
      this._claimOverlayCachedCamY = camY;
      this._claimOverlayCachedZoom = zoom;
      this._claimOverlayBitmapValid = true;
    } // close if (!this._claimOverlayBitmapValid)

    // ── Blit cached overlay canvas, offset by camera pan delta ───────────
    const ddx = (this._claimOverlayCachedCamX - camX) * zoom;
    const ddy = (this._claimOverlayCachedCamY - camY) * zoom;
    this.ctx.drawImage(this._claimOverlayCachedCanvas!, -margin + ddx, -margin + ddy);
    // Trigger re-render next frame if pan has drifted past 60% of the margin
    if (Math.abs(ddx) > margin * 0.6 || Math.abs(ddy) > margin * 0.6) {
      this._claimOverlayBitmapValid = false;
    }
  }

  private drawCannonGroupOverlay(ship: Ship, camera: Camera): void {
    if (!this.controlGroups) return;
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

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
      const mode = this.rmbAimingGroups.has(g) ? 'aiming' : state.mode;
      for (const id of state.cannonIds) cannonGroupMap.set(id, { g, mode });
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
        this.ctx.font = `bold ${isActive ? 9 : 8}px Georgia, serif`;
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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

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

  private drawIslandCannonReloadIndicators(camera: Camera): void {
    const ctx  = this.ctx;
    const zoom = camera.getState().zoom;
    const t          = performance.now() / 1000;
    const spinAngle  = t * 2.5;
    const iconR      = 9 * zoom;
    const arcSpan    = (5 * Math.PI) / 6;
    const arrowSz    = 3 * zoom;
    const lw         = 1.5 * zoom;

    for (const s of this.placedStructures) {
      if (s.type !== 'cannon' || (s.cannonReloadMs ?? 0) === 0) continue;
      const wp  = Vec2.from(s.x, s.y);
      if (!camera.isWorldPositionVisible(wp, 50)) continue;
      const ssp = camera.worldToScreen(wp);

      ctx.save();
      ctx.translate(ssp.x, ssp.y);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.90)';
      ctx.fillStyle   = 'rgba(255, 255, 255, 0.90)';
      ctx.lineWidth   = lw;
      ctx.lineCap     = 'round';

      for (let i = 0; i < 2; i++) {
        const startAngle = spinAngle + i * Math.PI;
        const endAngle   = startAngle + arcSpan;

        ctx.beginPath();
        ctx.arc(0, 0, iconR, startAngle, endAngle);
        ctx.stroke();

        const tipX = Math.cos(endAngle) * iconR;
        const tipY = Math.sin(endAngle) * iconR;
        const tx   = -Math.sin(endAngle);
        const ty   =  Math.cos(endAngle);
        const rx   =  Math.cos(endAngle);
        const ry   =  Math.sin(endAngle);

        ctx.beginPath();
        ctx.moveTo(tipX + tx * arrowSz,              tipY + ty * arrowSz);
        ctx.lineTo(tipX - tx * arrowSz * 0.5 + rx * arrowSz * 0.9,
                   tipY - ty * arrowSz * 0.5 + ry * arrowSz * 0.9);
        ctx.lineTo(tipX - tx * arrowSz * 0.5 - rx * arrowSz * 0.9,
                   tipY - ty * arrowSz * 0.5 - ry * arrowSz * 0.9);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    }
  }

  private drawCannonAimGuides(ship: Ship, worldState: WorldState, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
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
        // Mounted directly on a cannon — show just that one at full opacity (unless reloading
        // or the cannon's gunport plank exists and is closed).
        const isReloading = ((mountedMod.moduleData as { stateBits?: number } | undefined)?.stateBits ?? 0) & 16;
        if (!isReloading) {
          const gp = this.findGunportForCannon(mountedMod, ship);
          const gpData = gp?.moduleData as import('../../sim/modules').GunportModuleData | undefined;
          const gunportBlocked = gp !== null && gpData != null && !gpData.isOpen;
          if (!gunportBlocked) cannonsToShow = [{ module: mountedMod, alpha: 1 }];
        }
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
          // Gunport check: if this cannon is linked to a gunport plank that exists
          // and is closed, hide the trajectory (mirrors server fire-block logic).
          // If the plank is destroyed (findGunportForCannon returns null) we allow it.
          if (m.kind === 'cannon') {
            const gp = this.findGunportForCannon(m, ship);
            if (gp !== null) {
              const gpData = gp.moduleData as import('../../sim/modules').GunportModuleData | undefined;
              if (gpData && !gpData.isOpen) continue;
            }
          }
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

      // Use the same smoothed angle as drawShipCannons so trajectory locks to the visual barrel.
      const turretAngle = this._smoothBarrelAngles.get(cannon.id) ?? (cannon.moduleData.aimDirection || 0);
      const totalAngle = (cannon.localRot || 0) + turretAngle;
      const cx = cannon.localPos.x;
      const cy = cannon.localPos.y;

      // Barrel tip and fire direction in ship-local space
      const barrelTipX = cx + 40 * Math.sin(totalAngle);
      const barrelTipY = cy - 40 * Math.cos(totalAngle);
      const dirX = Math.sin(totalAngle);
      const dirY = -Math.cos(totalAngle);

      // Convert barrel tip and direction into world space for collision/range calculations.
      // (world-space distance = ship-local distance because rotation preserves lengths)
      const wBarrelX = ship.position.x + barrelTipX * cosR - barrelTipY * sinR;
      const wBarrelY = ship.position.y + barrelTipX * sinR + barrelTipY * cosR;
      const wDirX = dirX * cosR - dirY * sinR;
      const wDirY = dirX * sinR + dirY * cosR;

      // Actual max range accounting for overland lifetime reduction
      const maxRange = this.computeCannonMaxRange(wBarrelX, wBarrelY, wDirX, wDirY);

      // Find first collision — ships, players, NPCs, structures, resources
      const hit = this.findCannonTrajectoryHit(
        wBarrelX, wBarrelY, wDirX, wDirY, maxRange, ship.id, this.selectedAmmoType);

      const drawLength = Number.isFinite(hit.t) ? hit.t : maxRange;
      const guideColor = hit.color;
      const didHit     = Number.isFinite(hit.t);

      // ── Dashed trajectory line (stops at first collision) ──────────────
      // Bar shot uses a shorter dash pattern to visually distinguish from cannonball.
      // Color comes from the hit result (red=enemy, green=friendly, grey=terrain).
      const isBarShotDraw = this.selectedAmmoType !== 0;
      const drawColor  = guideColor;
      const dashOn     = isBarShotDraw ? 6 : 10;
      const dashOff    = isBarShotDraw ? 10 : 7;
      this.ctx.save();
      this.ctx.globalAlpha = 0.80 * fadeAlpha;
      this.ctx.strokeStyle = drawColor;
      this.ctx.lineWidth   = 3.5;
      this.ctx.lineCap     = 'round';
      this.ctx.setLineDash([dashOn, dashOff]);
      this.ctx.beginPath();
      this.ctx.moveTo(barrelTipX, barrelTipY);
      this.ctx.lineTo(barrelTipX + dirX * drawLength, barrelTipY + dirY * drawLength);
      this.ctx.stroke();
      this.ctx.restore();
      this.ctx.setLineDash([]);

      // ── Range-bracket tick marks at 1/3 and 2/3 of max range ──────────
      const perpX = -dirY;
      const perpY =  dirX;
      for (const frac of [1 / 3, 2 / 3]) {
        const tickDist = maxRange * frac;
        if (tickDist >= drawLength) continue; // past impact — skip
        const bx = barrelTipX + dirX * tickDist;
        const by = barrelTipY + dirY * tickDist;
        this.ctx.save();
        this.ctx.globalAlpha = 0.50 * fadeAlpha;
        this.ctx.strokeStyle = guideColor;
        this.ctx.lineWidth   = 3.5;
        this.ctx.lineCap     = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(bx - perpX * 7, by - perpY * 7);
        this.ctx.lineTo(bx + perpX * 7, by + perpY * 7);
        this.ctx.stroke();
        this.ctx.restore();
      }

      // ── Terminal reticle — 4 arcs at impact point or max range ─────────
      const termX    = barrelTipX + dirX * drawLength;
      const termY    = barrelTipY + dirY * drawLength;
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

  /**
   * Draw cannon trajectory guide for an island-placed cannon that the local player
   * is currently mounted on. Draws directly in screen space (no ship-local ctx transform).
   */
  private drawIslandCannonTrajectory(camera: Camera): void {
    if (!this.playerIsAiming) return;
    if (this.islandCannonId === null || this.islandCannonAimAngle === null) return;

    const s = this.placedStructures.find(
      ps => ps.id === this.islandCannonId && ps.type === 'cannon');
    if (!s) return;
    if ((s.cannonReloadMs ?? 0) > 0) return; // reloading — no guide

    const aimAngle = this.islandCannonAimAngle;
    const BARREL_TIP = 40; // world px from cannon center to barrel tip

    const wBarrelX = s.x + Math.cos(aimAngle) * BARREL_TIP;
    const wBarrelY = s.y + Math.sin(aimAngle) * BARREL_TIP;
    const wDirX    = Math.cos(aimAngle);
    const wDirY    = Math.sin(aimAngle);

    const maxRange  = this.computeCannonMaxRange(wBarrelX, wBarrelY, wDirX, wDirY);
    const hit       = this.findCannonTrajectoryHit(
      wBarrelX, wBarrelY, wDirX, wDirY, maxRange, 0 /* no ship to exclude */, this.selectedAmmoType);

    const drawLength = Number.isFinite(hit.t) ? hit.t : maxRange;
    const guideColor = hit.color;
    const didHit     = Number.isFinite(hit.t);

    // Convert world positions to screen positions for drawing
    const tipSP = camera.worldToScreen(Vec2.from(wBarrelX, wBarrelY));
    const endSP = camera.worldToScreen(Vec2.from(wBarrelX + wDirX * drawLength, wBarrelY + wDirY * drawLength));

    // Screen-space direction and perpendicular (accounts for camera rotation)
    const sdx = endSP.x - tipSP.x;
    const sdy = endSP.y - tipSP.y;
    const sLen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
    const snx = sdx / sLen, sny = sdy / sLen; // unit direction in screen space
    const spx = -sny, spy = snx;              // perpendicular in screen space

    const zoom = camera.getState().zoom;
    const ctx  = this.ctx;

    // ── Dashed trajectory line ──────────────────────────────────────────
    // Color comes from hit result (red=enemy, green=friendly, grey=terrain).
    // Bar shot uses a shorter dash pattern to visually distinguish from cannonball.
    const islandBarShot = this.selectedAmmoType !== 0;
    const islandDashOn  = islandBarShot ? 6 : 10;
    const islandDashOff = islandBarShot ? 10 : 7;
    ctx.save();
    ctx.globalAlpha = 0.80;
    ctx.strokeStyle = guideColor;
    ctx.lineWidth   = 3.5;
    ctx.lineCap     = 'round';
    ctx.setLineDash([islandDashOn, islandDashOff]);
    ctx.beginPath();
    ctx.moveTo(tipSP.x, tipSP.y);
    ctx.lineTo(endSP.x, endSP.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // ── Range-bracket tick marks at 1/3 and 2/3 of max range ───────────
    const tickLen = 7 * zoom;
    for (const frac of [1 / 3, 2 / 3]) {
      const tickDist = maxRange * frac;
      if (tickDist >= drawLength) continue;
      const tsp = camera.worldToScreen(Vec2.from(wBarrelX + wDirX * tickDist, wBarrelY + wDirY * tickDist));
      ctx.save();
      ctx.globalAlpha = 0.50;
      ctx.strokeStyle = guideColor;
      ctx.lineWidth   = 3.5;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(tsp.x - spx * tickLen, tsp.y - spy * tickLen);
      ctx.lineTo(tsp.x + spx * tickLen, tsp.y + spy * tickLen);
      ctx.stroke();
      ctx.restore();
    }

    // ── Terminal reticle — 4 arcs ───────────────────────────────────────
    const reticleR = (didHit ? 10 : 13) * zoom;
    const arcSpan  = Math.PI * 0.44;
    const gapHalf  = Math.PI * 0.06;
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = guideColor;
    ctx.lineWidth   = 3.5;
    ctx.lineCap     = 'round';
    for (let i = 0; i < 4; i++) {
      const centre = (Math.PI / 2) * i;
      ctx.beginPath();
      ctx.arc(endSP.x, endSP.y, reticleR, centre + gapHalf, centre + arcSpan - gapHalf);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawShipSteeringWheels(ship: Ship, camera: Camera): void {
    
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
  
  // ── Resource chest rendering ────────────────────────────────────────────────

  /**
   * Draw all resource chest modules on a ship.
   * Chests are classic wooden box shapes (40×28 world units) with a golden latch.
   */
  private drawShipChests(ship: Ship, camera: Camera, deckFilter?: 0 | 1): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const chests = ship.modules.filter(m => m.kind === 'chest' && (
      deckFilter === undefined ? true :
      deckFilter === 0 ? m.deckId === 0 :
      /* deckFilter === 1 */ m.deckId === 1 || m.deckId === 255
    ));
    if (chests.length === 0) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    for (const chest of chests) {
      const isHovered = this.hoveredModule?.ship?.id === ship.id &&
                        this.hoveredModule?.module?.id === chest.id;
      const chestHp    = (chest.moduleData as any)?.health    ?? 5000;
      const chestMaxHp = (chest.moduleData as any)?.maxHealth ?? 5000;
      const hpFrac = chestMaxHp > 0 ? Math.min(1, chestHp / chestMaxHp) : 1;
      this.ctx.save();
      this.ctx.translate(chest.localPos.x, chest.localPos.y);
      this.ctx.rotate(chest.localRot);
      this._drawChestShape(lw, 1.0, isHovered, ship.companyId ?? 0, hpFrac);
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /** Draw all bed modules on a ship. */
  private drawShipBeds(ship: Ship, camera: Camera, deckFilter?: 0 | 1): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
    const beds = ship.modules.filter(m => m.kind === 'bed' && (
      deckFilter === undefined ? true :
      deckFilter === 0 ? m.deckId === 0 :
      m.deckId === 1 || m.deckId === 255
    ));
    if (beds.length === 0) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    for (const bed of beds) {
      const isHovered = this.hoveredModule?.ship?.id === ship.id &&
                        this.hoveredModule?.module?.id === bed.id;
      this.ctx.save();
      this.ctx.translate(bed.localPos.x, bed.localPos.y);
      this.ctx.rotate(bed.localRot);
      // Bed frame
      this.ctx.fillStyle   = isHovered ? '#6a3090' : '#3d1f60';
      this.ctx.strokeStyle = '#aa77dd';
      this.ctx.lineWidth   = lw * 1.5;
      this.ctx.beginPath();
      this.ctx.roundRect(-22, -12, 44, 24, 3);
      this.ctx.fill();
      this.ctx.stroke();
      // Pillow
      this.ctx.fillStyle = '#c8a0e8';
      this.ctx.beginPath();
      this.ctx.roundRect(-20, -10, 14, 20, 2);
      this.ctx.fill();
      // Blanket
      this.ctx.fillStyle = '#7755aa';
      this.ctx.beginPath();
      this.ctx.rect(-3, -10, 24, 20);
      this.ctx.fill();
      // Hover hint
      if (isHovered) {
        this.ctx.fillStyle = '#cc99ff';
        this.ctx.font = `bold ${9 / zoom}px Georgia, serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';
        this.ctx.fillText('[E] Travel', 0, -15);
      }
      this.ctx.restore();
    }
    this.ctx.restore();
  }

  /**
   * Draw a ghost chest following the player's cursor when in chest build mode.
   * The ghost is placed in the ship-local coordinate frame of the nearest ship.
   */
  private drawChestGhostOnShip(ship: Ship, camera: Camera): void {
    if (!this.mouseWorldPos) return;

    const dx = this.mouseWorldPos.x - ship.position.x;
    const dy = this.mouseWorldPos.y - ship.position.y;
    const cosR = Math.cos(-ship.rotation);
    const sinR = Math.sin(-ship.rotation);
    const localX =  dx * cosR - dy * sinR;
    const localY =  dx * sinR + dy * cosR;

    // Only show ghost when cursor is within ship bounds (~150 units radius)
    const isOnShip = ship.hull.length >= 3
      ? this._isPointInHull(localX, localY, ship.hull)
      : Math.hypot(localX, localY) < 150;
    if (!isOnShip) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;
    const t           = performance.now() / 1000;
    const alpha       = 0.50 + 0.22 * Math.sin(t * 3.0);

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    this.ctx.translate(localX, localY);
    this.ctx.globalAlpha *= alpha;

    // Ghost tint
    this.ctx.save();
    this._drawChestShape(lw, alpha);
    // Blue-green ghost tint overlay
    this.ctx.fillStyle = 'rgba(40, 160, 120, 0.30)';
    this.ctx.strokeStyle = '#55ddbb';
    this.ctx.lineWidth = lw * 1.5;
    this.ctx.setLineDash([3 / zoom, 2 / zoom]);
    this.ctx.beginPath();
    this.ctx.roundRect(-20, -14, 40, 28, 3);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.restore();

    // Placement hint text
    this.ctx.fillStyle = '#88eedd';
    this.ctx.font = `bold ${10 / zoom}px Georgia, serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'bottom';
    this.ctx.fillText('[Click] Place Chest', 0, -18);

    this.ctx.restore();
  }

  /** Draw a ghost bed following the cursor when in bed build mode. */
  private drawBedGhostOnShip(ship: Ship, camera: Camera): void {
    if (!this.mouseWorldPos) return;
    const dx = this.mouseWorldPos.x - ship.position.x;
    const dy = this.mouseWorldPos.y - ship.position.y;
    const cosR = Math.cos(-ship.rotation);
    const sinR = Math.sin(-ship.rotation);
    const localX =  dx * cosR - dy * sinR;
    const localY =  dx * sinR + dy * cosR;
    const isOnShip = ship.hull.length >= 3
      ? this._isPointInHull(localX, localY, ship.hull)
      : Math.hypot(localX, localY) < 150;
    if (!isOnShip) return;

    const rotDeg = this.pendingGhostState?.kind === 'bed'
      ? this.pendingGhostState.rotDeg
      : 0;
    const rotRad = (rotDeg * Math.PI) / 180;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;
    const t           = performance.now() / 1000;
    const alpha       = 0.50 + 0.22 * Math.sin(t * 3.0);

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    this.ctx.translate(localX, localY);
    this.ctx.rotate(rotRad);
    this.ctx.globalAlpha *= alpha;

    // Bed frame
    this.ctx.fillStyle   = 'rgba(70,45,100,0.7)';
    this.ctx.strokeStyle = '#aa88dd';
    this.ctx.lineWidth   = lw * 1.5;
    this.ctx.setLineDash([3 / zoom, 2 / zoom]);
    this.ctx.beginPath();
    this.ctx.roundRect(-22, -12, 44, 24, 3);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    // Pillow
    this.ctx.fillStyle = 'rgba(190,160,220,0.6)';
    this.ctx.beginPath();
    this.ctx.roundRect(-20, -10, 14, 20, 2);
    this.ctx.fill();
    // Label
    this.ctx.fillStyle = '#cc99ff';
    this.ctx.font = `bold ${10 / zoom}px Georgia, serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'bottom';
    this.ctx.fillText('[Click] Place Bed', 0, -16);
    this.ctx.restore();
  }

  private _drawWellShape(lw: number, alpha: number, isHovered: boolean): void {
    const r = 16;
    this.ctx.globalAlpha *= alpha;
    this.ctx.fillStyle = isHovered ? '#3a6898' : '#2a4868';
    this.ctx.strokeStyle = isHovered ? '#88bbee' : '#5a8ac0';
    this.ctx.lineWidth = lw * 1.5;
    this.ctx.beginPath();
    this.ctx.arc(0, 0, r, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.fillStyle = 'rgba(100, 180, 255, 0.45)';
    this.ctx.beginPath();
    this.ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /** Draw placed bilge well modules (lower deck only). */
  private drawShipWells(ship: Ship, camera: Camera, deckFilter?: 0 | 1): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
    const wells = ship.modules.filter(m => m.kind === 'well' && (
      deckFilter === undefined ? true : m.deckId === deckFilter
    ));
    if (wells.length === 0) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    for (const well of wells) {
      const isHovered = this.hoveredModule?.ship?.id === ship.id &&
                        this.hoveredModule?.module?.id === well.id;
      this.ctx.save();
      this.ctx.translate(well.localPos.x, well.localPos.y);
      this._drawWellShape(lw, 1.0, isHovered);
      if (isHovered) {
        this.ctx.fillStyle = '#c8e8ff';
        this.ctx.font = `bold ${9 / zoom}px Georgia, serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';
        this.ctx.fillText('Bilge Well', 0, -18);
      }
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /** Draw a ghost well when placing from the build menu (lower deck only). */
  private drawWellGhostOnShip(ship: Ship, camera: Camera): void {
    if (!this.mouseWorldPos || ship.modules.some(m => m.kind === 'well')) return;
    const dx = this.mouseWorldPos.x - ship.position.x;
    const dy = this.mouseWorldPos.y - ship.position.y;
    const cosR = Math.cos(-ship.rotation);
    const sinR = Math.sin(-ship.rotation);
    const localX =  dx * cosR - dy * sinR;
    const localY =  dx * sinR + dy * cosR;
    const isOnShip = ship.hull.length >= 3
      ? this._isPointInHull(localX, localY, ship.hull)
      : Math.hypot(localX, localY) < 150;
    if (!isOnShip) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;
    const t           = performance.now() / 1000;
    const alpha       = 0.50 + 0.22 * Math.sin(t * 3.0);

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    this.ctx.translate(localX, localY);
    this._drawWellShape(lw, alpha, false);
    this.ctx.fillStyle = '#88ccff';
    this.ctx.font = `bold ${10 / zoom}px Georgia, serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'bottom';
    this.ctx.fillText('[Click] Place Well', 0, -22);
    this.ctx.restore();
  }

  /** Draw all workbench modules on a ship deck. */
  private drawShipWorkbenches(ship: Ship, camera: Camera, deckFilter?: 0 | 1): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;
    const benches = ship.modules.filter(m => m.kind === 'workbench' && (
      deckFilter === undefined ? true :
      deckFilter === 0 ? m.deckId === 0 :
      m.deckId === 1 || m.deckId === 255
    ));
    if (benches.length === 0) return;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    for (const bench of benches) {
      const isHovered = this.hoveredModule?.ship?.id === ship.id &&
                        this.hoveredModule?.module?.id === bench.id;
      const benchHp    = (bench.moduleData as any)?.health    ?? 10000;
      const benchMaxHp = (bench.moduleData as any)?.maxHealth ?? 10000;
      const hpFrac = benchMaxHp > 0 ? Math.min(1, benchHp / benchMaxHp) : 1;
      this.ctx.save();
      this.ctx.translate(bench.localPos.x, bench.localPos.y);
      this.ctx.rotate(bench.localRot);
      this._drawWorkbenchShape(lw, 1.0, isHovered, hpFrac);
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /** Draw a ghost workbench following the cursor when in workbench build mode. */
  private drawWorkbenchGhostOnShip(ship: Ship, camera: Camera): void {
    if (!this.mouseWorldPos) return;
    const dx = this.mouseWorldPos.x - ship.position.x;
    const dy = this.mouseWorldPos.y - ship.position.y;
    const cosR = Math.cos(-ship.rotation);
    const sinR = Math.sin(-ship.rotation);
    const localX =  dx * cosR - dy * sinR;
    const localY =  dx * sinR + dy * cosR;
    const isOnShip = ship.hull.length >= 3
      ? this._isPointInHull(localX, localY, ship.hull)
      : Math.hypot(localX, localY) < 150;
    if (!isOnShip) return;

    const rotDeg = this.pendingGhostState?.kind === 'workbench'
      ? this.pendingGhostState.rotDeg
      : 0;
    const rotRad = (rotDeg * Math.PI) / 180;

    const screenPos   = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();
    const zoom        = cameraState.zoom;
    const lw          = 1 / zoom;
    const t           = performance.now() / 1000;
    const alpha       = 0.50 + 0.22 * Math.sin(t * 3.0);

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);
    this.ctx.translate(localX, localY);
    this.ctx.rotate(rotRad);
    this.ctx.globalAlpha *= alpha;

    this._drawWorkbenchShape(lw, alpha, false, 1);

    this.ctx.fillStyle = 'rgba(40, 160, 120, 0.22)';
    this.ctx.strokeStyle = '#55ddbb';
    this.ctx.lineWidth = lw * 1.5;
    this.ctx.setLineDash([3 / zoom, 2 / zoom]);
    this.ctx.beginPath();
    this.ctx.rect(-22, -15.5, 44, 31);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    this.ctx.fillStyle = '#88eedd';
    this.ctx.font = `bold ${10 / zoom}px Georgia, serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'bottom';
    this.ctx.fillText('[Click] Place Workbench', 0, -20);
    if (rotDeg !== 0) {
      this.ctx.font = `${9 / zoom}px Georgia, serif`;
      this.ctx.fillStyle = 'rgba(180, 220, 200, 0.85)';
      this.ctx.fillText(`${Math.round(rotDeg)}°`, 0, -32);
    }
    this.ctx.restore();
  }

  /** Core workbench shape (origin = centre, 44×31 ship-local units). */
  private _drawWorkbenchShape(lw: number, _alpha: number, isHovered = false, hpFrac = 1): void {
    const bw = 44, bh = 31;
    const bx = -bw / 2, by = -bh / 2;
    const frameColor  = isHovered ? '#5a3010' : this.darkenByDamage('#4a2408', hpFrac);
    this.ctx.fillStyle   = frameColor;
    this.ctx.strokeStyle = '#2a1204';
    this.ctx.lineWidth   = lw * 1.5;
    this.ctx.beginPath();
    this.ctx.rect(bx, by, bw, bh);
    this.ctx.fill();
    this.ctx.stroke();

    const ft = 4;
    const sx2 = bx + ft, sy2 = by + ft;
    const sw  = bw - ft * 2, sh = bh - ft * 2;
    this.ctx.fillStyle = isHovered ? '#c07838' : this.darkenByDamage('#a86428', hpFrac);
    this.ctx.beginPath();
    this.ctx.rect(sx2, sy2, sw, sh);
    this.ctx.fill();

    this.ctx.strokeStyle = 'rgba(60, 30, 8, 0.35)';
    this.ctx.lineWidth   = lw;
    for (let gi = 1; gi < 3; gi++) {
      const gy = sy2 + sh * (gi / 3);
      this.ctx.beginPath();
      this.ctx.moveTo(sx2, gy);
      this.ctx.lineTo(sx2 + sw, gy);
      this.ctx.stroke();
    }

    const vw = 5, vh = sh * 0.45;
    const vx = sx2 + sw - vw;
    const vy = sy2 + (sh - vh) / 2;
    this.ctx.fillStyle   = isHovered ? '#888' : '#6a6a6a';
    this.ctx.strokeStyle = '#3a3a3a';
    this.ctx.beginPath();
    this.ctx.rect(vx, vy, vw, vh);
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.font         = `bold ${10}px Georgia, serif`;
    this.ctx.textAlign    = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillStyle    = 'rgba(255, 210, 100, 0.9)';
    this.ctx.fillText('\u2692', -vw / 2, 0);
  }

  /** Core chest shape drawing routine (origin = chest centre, 40×28 world units).
   *  Matches the island chest visual: body, lid strip, latch, company strip, hover tint. */
  private _drawChestShape(lw: number, _alpha: number, isHovered = false, companyId = 0, hpFrac = 1): void {
    const bw = 22, bh = 16;
    const bx = -bw / 2, by = -bh / 2;
    const lidH = bh * 0.35;

    // Body (bottom portion, darker brown)
    this.ctx.fillStyle   = isHovered ? '#7a4820' : '#5c3210';
    this.ctx.strokeStyle = '#2a1204';
    this.ctx.lineWidth   = lw * 1.5;
    this.ctx.beginPath();
    this.ctx.rect(bx, by, bw, bh);
    this.ctx.fill();
    this.ctx.stroke();

    // Lid strip (top ~35% of box, lighter tan)
    this.ctx.fillStyle = isHovered ? '#c0813a' : '#a06428';
    this.ctx.beginPath();
    this.ctx.rect(bx, by, bw, lidH);
    this.ctx.fill();
    this.ctx.strokeStyle = '#2a1204';
    this.ctx.lineWidth   = lw;
    this.ctx.strokeRect(bx, by, bw, lidH);

    // Latch — centred on lid/body seam
    const ltW = Math.max(2, bw * 0.12);
    const ltH = Math.max(2, bh * 0.20);
    const ltX = -ltW / 2;
    const ltY = by + lidH - ltH / 2;
    this.ctx.fillStyle   = '#d4a040';
    this.ctx.strokeStyle = '#7a5010';
    this.ctx.lineWidth   = lw * 0.8;
    this.ctx.fillRect(ltX, ltY, ltW, ltH);
    this.ctx.strokeRect(ltX, ltY, ltW, ltH);

    // Seam line
    this.ctx.strokeStyle = 'rgba(40,20,8,0.55)';
    this.ctx.lineWidth   = lw * 0.8;
    const seamY = by + lidH;
    this.ctx.beginPath();
    this.ctx.moveTo(bx, seamY);
    this.ctx.lineTo(bx + bw, seamY);
    this.ctx.stroke();

    // Company colour strip along the top edge
    const companyColors: Record<number, string> = { 0: '#aaaaaa', 1: '#ddaa44', 2: '#ff6644', 3: '#4488ff' };
    const stripColor = companyColors[companyId] ?? '#aaaaaa';
    const stripH = Math.max(1.5, 2.5 * lw);
    this.ctx.fillStyle = stripColor;
    this.ctx.fillRect(bx, by, bw, stripH);

    // Damage darkening
    const dmgDarken = Math.max(0, 1 - hpFrac) * 0.75;
    if (dmgDarken > 0.01) {
      this.ctx.fillStyle = `rgba(0,0,0,${dmgDarken.toFixed(2)})`;
      this.ctx.fillRect(bx, by, bw, bh);
    }
  }

  /** Simple point-in-polygon test (ray casting) for hull vertices. */
  private _isPointInHull(px: number, py: number, hull: Array<{x:number;y:number}>): boolean {
    let inside = false;
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const xi = hull[i].x, yi = hull[i].y;
      const xj = hull[j].x, yj = hull[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  private drawShipLadders(ship: Ship, camera: Camera): void {
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) {
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
    
    const ladderSpr = this._getLadderSprites();

    for (const ladder of ladders) {
      const x = ladder.localPos.x;
      const y = ladder.localPos.y;
      const rot = ladder.localRot || 0;
      const isExtended = (ladder.moduleData as any)?.extended !== false;

      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(rot);

      // Single drawImage() replaces 7+ fill/stroke calls — sprite is 100% static
      if (isExtended) {
        this.ctx.drawImage(ladderSpr.extended,  -12, -22); // canvas origin offset
      } else {
        this.ctx.drawImage(ladderSpr.retracted, -12,  -8);
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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

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
    const pulse   = 0.4 + 0.35 * Math.sin(t * 1.8);
    const rotate  = t * 0.22; // slow rotation
    const circleR = 55;

    ctx.save();
    ctx.rotate(rotate);

    // Outer haze — animated gradient, drawn fresh each frame
    const hazeGrd = ctx.createRadialGradient(0, 0, circleR * 0.55, 0, 0, circleR * 1.4);
    hazeGrd.addColorStop(0,   `rgba(0,230,255,${(pulse * 0.30).toFixed(3)})`);
    hazeGrd.addColorStop(1,   'rgba(0,100,160,0)');
    ctx.fillStyle = hazeGrd;
    ctx.beginPath();
    ctx.arc(0, 0, circleR * 1.4, 0, Math.PI * 2);
    ctx.fill();

    // Circle arc + tick marks — blitted from pre-baked sprite; pulse applied via globalAlpha.
    const deckSprite = this._getGhostDeckSprite(ship.npcLevel ?? 1);
    if (deckSprite) {
      ctx.globalAlpha = pulse * 0.80;
      ctx.drawImage(deckSprite.canvas, -deckSprite.cx, -deckSprite.cy);
      ctx.globalAlpha = 1.0;
    } else {
      ctx.strokeStyle = `rgba(0,220,255,${(pulse * 0.80).toFixed(3)})`;
      ctx.lineWidth   = 1.5;
      ctx.shadowColor = '#00eeff';
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      ctx.arc(0, 0, circleR, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        ctx.strokeStyle = `rgba(0,200,255,${(pulse * 0.70).toFixed(3)})`;
        ctx.lineWidth   = 1.0;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * circleR, Math.sin(angle) * circleR);
        ctx.lineTo(Math.cos(angle) * (circleR - 12), Math.sin(angle) * (circleR - 12));
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const { phase1Alpha } = this.computeSinkState(ship);
    if (phase1Alpha <= 0) return;

    const ctx       = this.ctx;
    const screenPos = camera.worldToScreen(ship.position);
    const cs        = camera.getState();
    const t         = performance.now() / 1000;
    const lvl       = ship.npcLevel != null && ship.npcLevel > 0 ? ship.npcLevel : 1;
    // Lerp factor 0→1 from level 1→60
    const lt        = Math.max(0, Math.min(1, (lvl - 1) / 59));
    // Inner mist: cyan (180,240,255) → pale red (255,140,100)
    const mi_r = Math.round(180 + lt * 75);
    const mi_g = Math.round(240 - lt * 100);
    const mi_b = Math.round(255 - lt * 155);
    // Mid mist: cyan (100,200,240) → orange-red (220,60,40)
    const mm_r = Math.round(100 + lt * 120);
    const mm_g = Math.round(200 - lt * 140);
    const mm_b = Math.round(240 - lt * 200);
    // Wake: cyan (120,220,255) → red-orange (255,80,40)
    const wk_r = Math.round(120 + lt * 135);
    const wk_g = Math.round(220 - lt * 140);
    const wk_b = Math.round(255 - lt * 215);

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
      grd.addColorStop(0,   `rgba(${mi_r},${mi_g},${mi_b},${alpha.toFixed(3)})`);
      grd.addColorStop(0.4, `rgba(${mm_r},${mm_g},${mm_b},${(alpha * 0.55).toFixed(3)})`);
      grd.addColorStop(1,   'rgba(0,0,0,0)');

      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(mp.x, mp.y + drift, mp.r, mp.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Trailing mist wake — level-tinted wisps stretching behind the stern
    for (let i = 0; i < 4; i++) {
      const wx    = -350 - i * 60;
      const wdrift = Math.sin(t * 0.6 + i * 2.0) * 12;
      const alpha  = Math.max(0, 0.12 - i * 0.025) * (0.5 + 0.5 * Math.sin(t * 0.5 + i));

      const wgrd = ctx.createRadialGradient(wx, wdrift, 0, wx, wdrift, 30 + i * 10);
      wgrd.addColorStop(0,   `rgba(${wk_r},${wk_g},${wk_b},${alpha.toFixed(3)})`);
      wgrd.addColorStop(1,   'rgba(0,0,0,0)');

      ctx.fillStyle = wgrd;
      ctx.beginPath();
      ctx.ellipse(wx, wdrift, 30 + i * 10, 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawShipRudder(ship: Ship, camera: Camera): void {
    if (ship.shipType === SHIP_TYPE_GHOST) return;
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) {
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
    
    // Get smoothed rudder angle (falls back to raw server value before first frame)
    const rudderAngle = this._smoothRudderAngles.get(ship.id) ?? ship.rudderAngle ?? 0;
    
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
    if (ship.shipType === SHIP_TYPE_GHOST) return;
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const { phase3Alpha } = this.computeSinkState(ship);
    if (phase3Alpha <= 0) return;

    const sprite = this._getShipRopeSprite(ship);
    if (!sprite) return;

    this.ctx.save();
    if (phase3Alpha < 1) this.ctx.globalAlpha = phase3Alpha;

    const screenPos  = camera.worldToScreen(ship.position);
    const cameraState = camera.getState();

    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(cameraState.zoom, cameraState.zoom);
    this.ctx.rotate(ship.rotation - cameraState.rotation);

    // Single blit replaces ~114 individual draw calls per ship
    this.ctx.drawImage(sprite.canvas, -sprite.ox, -sprite.oy);

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
    if (ship.shipType === SHIP_TYPE_GHOST) return;
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) {
      return;
    }

    const { phase3Alpha } = this.computeSinkState(ship);
    if (phase3Alpha <= 0) return;

    // Fade sails when the local player is walking on this ship's deck so they
    // don't obstruct the view of modules/NPCs below them.  The alpha is
    // smoothly interpolated each frame (see _sailAlphaByShip in renderWorld).
    const smoothedAlpha = this._sailAlphaByShip.get(ship.id) ?? 1.0;
    const sailAlpha = smoothedAlpha * phase3Alpha;

    this.ctx.save();
    this.ctx.globalAlpha = sailAlpha;

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
      const angle    = this._smoothSailAngles.get(mast.id)   ?? mastData.angle;   // smoothed sail angle (degrees)
      const openness = this._smoothSailOpenness.get(mast.id) ?? mastData.openness; // smoothed openness (0–100)
      
      // Use sail cloth HP (fiberHealth) for visual degradation, not mast pole HP
      const healthRatio = mastData.fiberMaxHealth > 0 ? mastData.fiberHealth / mastData.fiberMaxHealth : 1;
      const fireIntensity = mastData.sailFireIntensity ?? 0;
      this.drawSailFiber(x, y, width, height, sailColor, openness / 100, angle, healthRatio, mast.id, fireIntensity);
      
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
    const billow = Math.sin(t * 0.85 + phase) * 10;
    const pulse = 0.52 + 0.13 * Math.sin(t * 1.3 + phase);
    this._bakePhantomSailOnCtx(this.ctx, x, y, width, height, mastId, billow, pulse, t, phase);
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
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const screenPos = camera.worldToScreen(ship.position);
    const zoom = camera.getState().zoom;

    const ammoText = ship.infiniteAmmo ? '∞ ammo' : `⚫ ${ship.cannonAmmo}`;
    const labelY = screenPos.y - 120 * zoom;

    this.ctx.save();
    this.ctx.font = `bold ${Math.max(11, 13 * zoom)}px Georgia, serif`;
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

  private drawShipNameLabel(ship: Ship, camera: Camera): void {
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const isGhostShipLabel = ship.shipType === SHIP_TYPE_GHOST;
    const ghostLvl = isGhostShipLabel ? (ship.npcLevel ?? 1) : 0;

    const name = isGhostShipLabel ? `Ghost Ship - Level ${ghostLvl}` : ship.shipName;
    const level = isGhostShipLabel ? undefined : ship.levelStats?.shipLevel;
    if (!name && level === undefined) return;

    const screenPos = camera.worldToScreen(ship.position);
    const zoom = camera.getState().zoom;

    // Place below the hull — 110px below ship center in world-scaled screen space
    const labelY = screenPos.y + 110 * zoom;

    this.ctx.save();
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    const fontSize = Math.max(10, 12 * zoom);
    const pad = 5;

    // Build the two lines
    const nameLine = name || '';
    const levelLine = level !== undefined ? `Lv. ${level}` : '';

    // Measure both lines so the pill fits the widest
    this.ctx.font = `bold ${fontSize}px Georgia, serif`;
    const nameMetrics  = nameLine  ? this.ctx.measureText(nameLine)  : null;
    const levelMetrics = levelLine ? this.ctx.measureText(levelLine) : null;
    const lineH = fontSize + 4;
    const totalLines = (nameLine ? 1 : 0) + (levelLine ? 1 : 0);
    const pillW = Math.max(nameMetrics?.width ?? 0, levelMetrics?.width ?? 0) + pad * 2;
    const pillH = lineH * totalLines + pad;

    // Dark pill background
    this.ctx.fillStyle = 'rgba(0,0,0,0.60)';
    this.ctx.beginPath();
    this.ctx.roundRect(screenPos.x - pillW / 2, labelY - pad / 2, pillW, pillH, 5);
    this.ctx.fill();

    let curY = labelY + lineH / 2 - (totalLines === 2 ? lineH / 2 : 0);

    if (nameLine) {
      this.ctx.font = `bold ${fontSize}px Georgia, serif`;
      this.ctx.fillStyle = isGhostShipLabel ? ghostSpectralColor(ghostLvl, 0.95) : '#f0e0b0';
      this.ctx.fillText(nameLine, screenPos.x, curY);
      curY += lineH;
    }
    if (levelLine) {
      this.ctx.font = `${fontSize * 0.85}px Georgia, serif`;
      this.ctx.fillStyle = '#88ccff';
      this.ctx.fillText(levelLine, screenPos.x, curY);
    }

    this.ctx.restore();
  }

  private drawShipClaimFlag(ship: Ship, camera: Camera): void {
    const cf = ship.claimFlag;
    if (!cf) return;
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) return;

    const zoom = camera.getState().zoom;
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);

    // Transform ship-local flag position to world coords
    const wx = ship.position.x + cos * cf.localX - sin * cf.localY;
    const wy = ship.position.y + sin * cf.localX + cos * cf.localY;
    const sp = camera.worldToScreen(Vec2.from(wx, wy));

    const poleH  = 32 * zoom;
    const poleW  = 2.5 * zoom;
    const flagW  = 18 * zoom;
    const flagH  = 12 * zoom;

    const progress = Math.min(1, cf.progressMs / cf.totalMs);
    const t = Date.now() / 1000;
    const pulse = cf.contested ? 0.55 + 0.45 * Math.sin(t * 6) : 1;

    this.ctx.save();

    // Glow behind pole when contested
    if (cf.contested) {
      this.ctx.shadowColor = `rgba(255,60,60,${0.4 * pulse})`;
      this.ctx.shadowBlur  = Math.min(20, 14 * zoom);
    }

    // Pole
    this.ctx.strokeStyle = '#5c3a1a';
    this.ctx.lineWidth   = poleW;
    this.ctx.beginPath();
    this.ctx.moveTo(sp.x, sp.y);
    this.ctx.lineTo(sp.x, sp.y - poleH);
    this.ctx.stroke();

    this.ctx.shadowBlur = 0;

    // Flag cloth — derive company color from planterCompany
    const COMPANY_COLORS: Record<number, string> = {
      1: '#2266aa',  // Solo → blue
      2: '#cc2222',  // Pirates → red
      3: '#2299aa',  // Navy → teal
      99: '#556b2f', // Ghost → dark-olive
    };
    const clothColor = COMPANY_COLORS[cf.planterCompany] ?? '#cc2222';
    const topX = sp.x;
    const topY = sp.y - poleH;
    this.ctx.fillStyle = clothColor;
    this.ctx.beginPath();
    this.ctx.moveTo(topX, topY);
    this.ctx.lineTo(topX + flagW, topY + flagH * 0.4);
    this.ctx.lineTo(topX, topY + flagH);
    this.ctx.closePath();
    this.ctx.fill();

    // Progress arc ring below the pole tip
    const arcR = 10 * zoom;
    const arcCx = sp.x;
    const arcCy = sp.y - poleH - arcR * 1.5;
    const arcColor = cf.contested ? `rgba(255,60,60,${pulse})` : '#44ff88';

    this.ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    this.ctx.lineWidth = 3 * zoom;
    this.ctx.beginPath();
    this.ctx.arc(arcCx, arcCy, arcR, 0, Math.PI * 2);
    this.ctx.stroke();

    this.ctx.strokeStyle = arcColor;
    this.ctx.lineWidth = 3 * zoom;
    this.ctx.lineCap = 'round';
    this.ctx.beginPath();
    this.ctx.arc(arcCx, arcCy, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    this.ctx.stroke();

    // Label text above arc
    const fontSize = Math.max(10, 11 * zoom);
    this.ctx.font = `bold ${fontSize}px Georgia, serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'bottom';
    const label = cf.contested ? 'CONTESTED' : `${Math.round(progress * 100)}%`;
    const labelY2 = arcCy - arcR - 4 * zoom;

    this.ctx.fillStyle = 'rgba(0,0,0,0.65)';
    const mw = this.ctx.measureText(label).width;
    this.ctx.fillRect(arcCx - mw / 2 - 3, labelY2 - fontSize, mw + 6, fontSize + 2);

    this.ctx.fillStyle = cf.contested ? '#ff6666' : '#aaffaa';
    this.ctx.fillText(label, arcCx, labelY2);

    this.ctx.restore();
  }

  private drawShipSailMasts(ship: Ship, camera: Camera): void {
    if (ship.shipType === SHIP_TYPE_GHOST) return;
    // Check if ship is visible
    if (!camera.isWorldPositionVisible(ship.position, this._hullRadius(ship))) {
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

  /** Grapple rope, hook, boarding ring, and charge aim — layer 4+ so hooks draw over deck/planks. */
  private drawPlayerGrappleVisuals(player: Player, worldState: WorldState, camera: Camera): void {
    if (player.health <= 0) return;
    if (!camera.isWorldPositionVisible(player.position, 50)) return;

    const screenPos = camera.worldToScreen(player.position);
    const cameraState = camera.getState();
    const scaledRadius = player.radius * cameraState.zoom;
    const zoom = cameraState.zoom;

    const _isOtherPlayer = player.id !== this.localPlayerId;
    const _playerDeckAlpha = (_isOtherPlayer && player.deckId !== this._playerDeckLevel) ? 0.25 : 1.0;

    const ATTACHED = 2;
    if (player.grappleState && player.grappleX !== undefined && player.grappleY !== undefined) {
      const hookScreen = camera.worldToScreen(Vec2.from(player.grappleX, player.grappleY));

      this.ctx.save();
      this.ctx.globalAlpha = _playerDeckAlpha;
      this.ctx.strokeStyle = player.grappleState === ATTACHED ? '#c68642' : '#a06030';
      this.ctx.lineWidth = Math.max(1.5, 2 * zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(screenPos.x, screenPos.y);
      this.ctx.lineTo(hookScreen.x, hookScreen.y);
      this.ctx.stroke();

      const hookR = Math.max(4, 5 * zoom);
      this.ctx.fillStyle   = player.grappleState === ATTACHED ? '#e8a840' : '#cccccc';
      this.ctx.strokeStyle = '#333333';
      this.ctx.lineWidth   = 1.5;
      this.ctx.beginPath();
      this.ctx.arc(hookScreen.x, hookScreen.y, hookR, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.restore();
    }

    // ── Grapple boarding progress bar (local player only) ────────────────
    if (player.id === this.localPlayerId &&
        this.grappleBoardingProgress > 0 &&
        player.grappleX !== undefined && player.grappleY !== undefined) {
      const hookScreen = camera.worldToScreen(Vec2.from(player.grappleX, player.grappleY));
      const prog = this.grappleBoardingProgress;

      this.ctx.save();
      const boardR   = Math.max(18, 22 * zoom);
      const boardThk = Math.max(3, 4 * zoom);

      this.ctx.beginPath();
      this.ctx.arc(hookScreen.x, hookScreen.y, boardR, 0, Math.PI * 2);
      this.ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      this.ctx.lineWidth   = boardThk;
      this.ctx.stroke();

      const r = Math.round(50  + 205 * prog);
      const g = Math.round(220 - 20  * prog);
      const b = Math.round(50  - 50  * prog);
      this.ctx.beginPath();
      this.ctx.arc(hookScreen.x, hookScreen.y, boardR,
        -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
      this.ctx.strokeStyle = `rgb(${r},${g},${b})`;
      this.ctx.lineWidth   = boardThk;
      this.ctx.stroke();

      const fontSize = Math.max(9, 11 * zoom);
      this.ctx.font      = `bold ${fontSize}px monospace`;
      this.ctx.fillStyle = `rgb(${r},${g},${b})`;
      this.ctx.textAlign = 'center';
      this.ctx.fillText('BOARDING', hookScreen.x, hookScreen.y + boardR + fontSize + 2);

      this.ctx.restore();
    }

    // ── Grapple wind-up charge indicator (local player only) ──────────────
    if (player.id === this.localPlayerId && this.grappleChargeProgress > 0) {
      const charge = this.grappleChargeProgress;
      const now    = performance.now();

      const r = Math.round(charge < 0.5 ? 160 + 95 * (charge * 2) : 255);
      const g = Math.round(charge < 0.5 ? 160 + 40 * (charge * 2) : Math.max(30, 200 - 170 * ((charge - 0.5) * 2)));
      const b = Math.round(120 * (1 - charge));
      const chargeColor = `rgb(${r},${g},${b})`;

      this.ctx.save();

      const arcR         = scaledRadius + Math.max(4, 5 * zoom);
      const arcThickness = Math.max(2.5, 3.5 * zoom);
      this.ctx.beginPath();
      this.ctx.arc(screenPos.x, screenPos.y, arcR, 0, Math.PI * 2);
      this.ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      this.ctx.lineWidth   = arcThickness;
      this.ctx.stroke();
      this.ctx.beginPath();
      this.ctx.arc(
        screenPos.x, screenPos.y, arcR,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * charge
      );
      this.ctx.strokeStyle  = chargeColor;
      this.ctx.lineWidth    = arcThickness;
      this.ctx.shadowColor  = chargeColor;
      this.ctx.shadowBlur   = 5;
      this.ctx.stroke();
      this.ctx.shadowBlur = 0;

      const aim = this.grappleAimWorldPos;
      if (aim) {
        const aimScreen = camera.worldToScreen(Vec2.from(aim.x, aim.y));
        const adx = aimScreen.x - screenPos.x;
        const ady = aimScreen.y - screenPos.y;
        const rawDist = Math.sqrt(adx * adx + ady * ady);
        const ux = rawDist > 0.5 ? adx / rawDist : 1;
        const uy = rawDist > 0.5 ? ady / rawDist : 0;

        const lineLen = this.grappleProjectedRange * zoom;
        const startX = screenPos.x + ux * (scaledRadius + 2);
        const startY = screenPos.y + uy * (scaledRadius + 2);
        const tipX   = screenPos.x + ux * lineLen;
        const tipY   = screenPos.y + uy * lineLen;

        const dashLen   = 8;
        const gapLen    = 6;
        const dashCycle = dashLen + gapLen;
        this.ctx.setLineDash([dashLen, gapLen]);
        this.ctx.lineDashOffset = -(now / 30) % dashCycle;
        this.ctx.strokeStyle    = chargeColor;
        this.ctx.lineWidth      = Math.max(1.5, 2 * zoom);
        this.ctx.shadowColor    = chargeColor;
        this.ctx.shadowBlur     = 4;
        this.ctx.beginPath();
        this.ctx.moveTo(startX, startY);
        this.ctx.lineTo(tipX, tipY);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
        this.ctx.shadowBlur = 0;

        const tipR = Math.max(3, 4 * zoom);
        this.ctx.beginPath();
        this.ctx.arc(tipX, tipY, tipR, 0, Math.PI * 2);
        this.ctx.fillStyle   = chargeColor;
        this.ctx.shadowColor = chargeColor;
        this.ctx.shadowBlur  = 6;
        this.ctx.fill();
        this.ctx.shadowBlur = 0;

        if (charge >= 0.1) {
          const pct = Math.round(charge * 100);
          const fs  = Math.max(10, Math.round(11 * zoom));
          this.ctx.font         = `bold ${fs}px sans-serif`;
          this.ctx.textAlign    = 'center';
          this.ctx.fillStyle    = chargeColor;
          this.ctx.shadowColor  = 'rgba(0,0,0,0.9)';
          this.ctx.shadowBlur   = 4;
          this.ctx.fillText(`${pct}%`, tipX, tipY - tipR - 4);
          this.ctx.shadowBlur = 0;
        }
      }

      this.ctx.restore();
    }
  }
  
  private drawPlayer(player: Player, worldState: WorldState, camera: Camera): void {
    // Dead players are not rendered (includes local player while respawn screen is up)
    if (player.health <= 0) return;

    // Check if player is visible
    if (!camera.isWorldPositionVisible(player.position, 50)) {
      return; // Skip off-screen players
    }
    
    const screenPos = camera.worldToScreen(player.position);
    const cameraState = camera.getState();
    const scaledRadius = player.radius * cameraState.zoom;

    // Fade out other players on a different deck level than the local player
    const _isOtherPlayer = player.id !== this.localPlayerId;
    const _playerDeckAlpha = (_isOtherPlayer && player.deckId !== this._playerDeckLevel) ? 0.25 : 1.0;
    this.ctx.save();
    this.ctx.globalAlpha = _playerDeckAlpha;

    // Draw player circle (Canvas 2D — must stay on the overlay canvas for correct
    // layer order vs islands/ships; the GL canvas sits beneath the entire 2D stack).
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
      this.ctx.font = '12px Georgia, serif';
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
      this.ctx.font = '14px Georgia, serif';
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

    this.ctx.restore();
  }
  
  private drawCannonball(cannonball: Cannonball, camera: Camera, worldState?: WorldState): void {
    if (!camera.isWorldPositionVisible(cannonball.position, 20)) return;

    const screenPos = camera.worldToScreen(cannonball.position);
    const zoom      = camera.getState().zoom;
    const now       = performance.now();

    // Determine if this projectile was fired from a ghost ship
    const firingShip    = worldState ? worldState.ships.find(s => s.id === cannonball.firedFrom) : null;
    const firedFromGhost = firingShip?.shipType === SHIP_TYPE_GHOST;
    const ghostProjLevel = firedFromGhost ? (firingShip?.npcLevel ?? 1) : 1;

    // ── Smoke trail (cannonball & bar shot only) ───────────────────────────
    // Batched per opacity bucket: instead of one arc+fill per crumb (68×/ball),
    // group crumbs into 5 alpha buckets and issue one path per bucket.
    // This reduces draw calls from ~28/ball to ~5/ball (5× improvement per ball,
    // 24 balls × 5 = 120 calls vs 24 × 28 = 672).
    if (cannonball.ammoType === 0 || cannonball.ammoType === 1) {
      const isBarShot = cannonball.ammoType === 1;
      const trail = this.cannonballTrails.get(cannonball.id);
      if (trail && trail.length > 1) {
        const ALPHA_BUCKETS = 5;
        const smokeColor = firedFromGhost ? ghostSpectralColor(ghostProjLevel) : '#c8c8c8';
        const coreColor  = firedFromGhost ? ghostSpectralColor(ghostProjLevel, 0.85) : '#3a3a3a';
        const maxAlpha   = isBarShot ? 0.32 : 0.72;

        // Pre-classify crumbs into alpha buckets (smoke) and core bucket (fresh only)
        const buckets: { alpha: number; paths: Array<[number, number, number]> }[] =
          Array.from({ length: ALPHA_BUCKETS }, (_, b) => ({
            alpha: ((b + 0.5) / ALPHA_BUCKETS) * maxAlpha,
            paths: [],
          }));
        const corePaths: Array<[number, number, number]> = [];

        const camState = camera.getState();
        const cosR = Math.cos(-camState.rotation);
        const sinR = Math.sin(-camState.rotation);
        const ox = camState.position.x, oy = camState.position.y, z = camState.zoom;
        const hw = this.ctx.canvas.width  / 2;
        const hh = this.ctx.canvas.height / 2;

        for (let i = 0; i < trail.length; i++) {
          const crumb = trail[i];
          const age = (now - crumb.t) / this.TRAIL_DURATION_MS;
          if (age >= 1) continue;
          const ease   = 1 - age * age;
          const alpha  = ease * maxAlpha;
          const radius = Math.max(1, ease * (isBarShot ? 4.5 : 9) * z);

          // Inline worldToScreen to avoid Vec2.from allocation per crumb
          const dx = crumb.x - ox, dy = crumb.y - oy;
          const sx = (dx * cosR - dy * sinR) * z + hw;
          const sy = (dx * sinR + dy * cosR) * z + hh;

          const b = Math.min(ALPHA_BUCKETS - 1, Math.floor(alpha / maxAlpha * ALPHA_BUCKETS));
          buckets[b].paths.push([sx, sy, radius]);

          if (!isBarShot && age < 0.35) {
            const coreAlpha  = (0.35 - age) / 0.35 * 0.55;
            corePaths.push([sx, sy, radius * 0.45 * (coreAlpha / 0.55)]);
          }
        }

        this.ctx.save();
        this.ctx.fillStyle = smokeColor;
        for (const bucket of buckets) {
          if (bucket.paths.length === 0) continue;
          this.ctx.globalAlpha = bucket.alpha;
          this.ctx.beginPath();
          for (const [sx, sy, r] of bucket.paths) {
            this.ctx.moveTo(sx + r, sy);
            this.ctx.arc(sx, sy, r, 0, Math.PI * 2);
          }
          this.ctx.fill();
        }
        if (corePaths.length > 0) {
          this.ctx.fillStyle = coreColor;
          this.ctx.globalAlpha = 0.55;
          this.ctx.beginPath();
          for (const [sx, sy, r] of corePaths) {
            this.ctx.moveTo(sx + r, sy);
            this.ctx.arc(sx, sy, r, 0, Math.PI * 2);
          }
          this.ctx.fill();
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
        // Ghost projectile: glowing level-tinted spectral ball
        const t = performance.now() / 1000;
        const flicker = 0.85 + 0.15 * Math.sin(t * 12 + cannonball.id * 2.3);
        const r = Math.max(3, scaledRadius * 1.4);
        // Outer glow
        const grd = this.ctx.createRadialGradient(screenPos.x, screenPos.y, 0, screenPos.x, screenPos.y, r * 2.5);
        grd.addColorStop(0,   ghostSpectralColor(ghostProjLevel, 0.65 * flicker));
        grd.addColorStop(0.4, ghostSpectralColor(ghostProjLevel, 0.35 * flicker));
        grd.addColorStop(1,   'rgba(0,0,0,0)');
        this.ctx.fillStyle = grd;
        this.ctx.beginPath();
        this.ctx.arc(screenPos.x, screenPos.y, r * 2.5, 0, Math.PI * 2);
        this.ctx.fill();
        // Ball core
        this.ctx.fillStyle = ghostSpectralColor(ghostProjLevel, flicker);
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

    // NPC rotation is in ship-local space; add the ship's rotation for world-space rendering
    const ship = npc.shipId ? worldState.ships.find(s => s.id === npc.shipId) : null;
    const worldRotation = npc.rotation + (ship ? ship.rotation : 0);

    this.ctx.save();
    // Fade out upper-deck NPCs when the player is on the lower deck (and vice versa).
    // Lower-deck NPCs (deckLevel=0) are queued at layer 1 so they render under planks —
    // no alpha reduction needed there; the planks/cover provide natural occlusion from above.
    // Upper-deck NPCs (deckLevel=1) queued at layer 4 are dimmed when player is on lower deck.
    const _diffDeck = npc.deckLevel !== 255 && npc.deckLevel !== this._playerDeckLevel;
    const _npcDeckAlpha = (_diffDeck && npc.deckLevel === 1) ? this._upperDeckFade : 1.0;
    this.ctx.globalAlpha = (isMoving ? 0.7 : 1.0) * _npcDeckAlpha;

    // Colour NPC by company then task assignment (darkened via globalAlpha when moving)
    const npcTask = this.npcTaskMap.get(npc.id) ?? 'Idle';
    // For COMPANY_SOLO NPCs: enemy if owner unknown (ownerId=0) OR owned by a different player
    const _npcIsEnemy = this._localCompanyId !== 0 && npc.companyId !== 0 && (
      npc.companyId === COMPANY_SOLO
        ? (npc.ownerId === 0 || npc.ownerId !== this.localPlayerId)
        : npc.companyId !== this._localCompanyId
    );
    const _npcIsNeutral = npc.companyId === COMPANY_UNCLAIMED;
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
      screenPos.x + Math.cos(worldRotation - cameraState.rotation) * radius * 1.5,
      screenPos.y + Math.sin(worldRotation - cameraState.rotation) * radius * 1.5
    );
    this.ctx.stroke();

    this.ctx.restore();

    // Name label: show when this NPC is hovered, or when Alt is held for allied NPCs.
    // (Role/state/weapon debug info is in the hover debug HUD instead.)
    const _showName = this.hoveredNpc?.id === npc.id
      || (this._showNpcNames && !_npcIsEnemy && !_npcIsNeutral);
    // Show state badges when Ctrl is held (showGroupOverlay) or when the name is visible
    const _showBadges = this.showGroupOverlay || _showName;
    if (_showName) {
      const fontSize = Math.max(10, Math.min(14, 12 * cameraState.zoom));
      this.ctx.font = `${fontSize}px Georgia, serif`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      const nameY = screenPos.y - radius - 3;
      const tw = this.ctx.measureText(npc.name).width;
      this.ctx.fillStyle = 'rgba(0,0,0,0.55)';
      this.ctx.fillRect(screenPos.x - tw / 2 - 3, nameY - fontSize, tw + 6, fontSize + 2);
      this.ctx.fillStyle = '#ffe066';
      this.ctx.fillText(npc.name, screenPos.x, nameY);
    }

    if (_showBadges) {
      const badgeSize = Math.max(8, Math.min(12, 10 * cameraState.zoom));
      const lx = screenPos.x + radius - 2;
      let badgeY = screenPos.y - radius - badgeSize;

      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      this.ctx.font = `bold ${badgeSize + 2}px Georgia, serif`;

      // Locked-at-station badge
      if (npc.locked) {
        this.ctx.fillStyle = '#ffdd00';
        this.ctx.fillText('🔒', lx, badgeY);
        badgeY -= badgeSize + 2;
      }

      // Ignore-commands badge (client-side flag)
      if (this.npcIgnoreSet.has(npc.id)) {
        this.ctx.fillStyle = '#ff5544';
        this.ctx.fillText('🚫', lx, badgeY);
      }
    }
  }

  /**
   * Draws a fixed debug HUD panel in the bottom-right corner showing raw field data
   * for the currently hovered entity (module > npc > ship > structure priority).
   * Toggle with [ key via toggleHoverDebugHUD().
   */
  /** Called from ClientApplication after all UI layers so it always renders on top. */
  renderHoverDebugHUD(): void {
    if (!this._showHoverDebugHUD) return;
    this.drawHoverDebugHUD();
  }

  private drawHoverDebugHUD(): void {
    if (!this._showHoverDebugHUD) return;

    interface Row {
      label: string;
      value: string;
      color?: string;
      bar?: number;
      barColor?: string;
    }

    let title = '';
    let accentColor = '#ffcc44';
    const rows: Row[] = [];

    const COMPANY_COLORS: Record<number, string> = { 0: '#888888', 1: '#ffcc44', 2: '#ff6644', 3: '#4488ff', 4: '#00eeff' };
    const coColor = (id: number): string => COMPANY_COLORS[id] ?? '#cccccc';
    const coName = (id: number): string => ({ 0: 'Unclaimed', 1: 'Solo', 2: 'Pirates', 3: 'Navy', 4: 'Ghost' } as Record<number, string>)[id] ?? `Co#${id}`;
    const hpColor = (pct: number): string => pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa44' : '#ff5544';
    const fmtRad = (r: number): string => `${(r * 180 / Math.PI).toFixed(1)}°`;

    if (this.hoveredModule) {
      const { ship, module } = this.hoveredModule;
      const md = module.moduleData as Record<string, unknown> | undefined;
      const kind = (md?.kind as string) ?? module.kind ?? '?';
      title = `⚙ MODULE · ${kind.toUpperCase()}`;
      accentColor = '#66ee99';
      rows.push({ label: 'Mod ID',    value: String(module.id) });
      rows.push({ label: 'Ship ID',   value: String(ship.id) });
      rows.push({ label: 'Kind',      value: kind });
      const deckVal = module.deckId === 0xFF ? 'none' : module.deckId === 0 ? '0 (lower)' : module.deckId === 1 ? '1 (upper)' : String(module.deckId);
      rows.push({ label: 'Deck',      value: deckVal });
      rows.push({ label: 'LocalPos',  value: `(${module.localPos.x.toFixed(0)}, ${module.localPos.y.toFixed(0)})` });
      if (module.occupiedBy !== null) rows.push({ label: 'OccupiedBy', value: String(module.occupiedBy), color: '#ffee88' });
      if (md) {
        const hp = Number(md.health ?? 0);
        const maxHp = Number(md.maxHealth ?? 1);
        const pct = maxHp > 0 ? hp / maxHp : 1;
        rows.push({ label: 'HP', value: `${hp} / ${maxHp}`, bar: pct, barColor: hpColor(pct) });
        if ('targetHealth' in md) rows.push({ label: 'TargetHP', value: String(md.targetHealth) });
        if (kind === 'mast') {
          rows.push({ label: 'Sail',    value: `${String(md.sailState).toUpperCase()}  open:${Number(md.openness ?? 0).toFixed(0)}%` });
          const fp = Number(md.fiberHealth ?? 0);
          const fmax = Number(md.fiberMaxHealth ?? 1);
          rows.push({ label: 'Fiber', value: `${fp} / ${fmax}`, bar: fmax > 0 ? fp / fmax : 1, barColor: hpColor(fmax > 0 ? fp / fmax : 1) });
          rows.push({ label: 'WindEff', value: `${(Number(md.windEfficiency ?? 0) * 100).toFixed(1)}%` });
          rows.push({ label: 'Fire',    value: `${Number(md.sailFireIntensity ?? 0).toFixed(0)}%` });
        } else if (kind === 'cannon') {
          rows.push({ label: 'Reload',  value: `${Number(md.reloadTime ?? 3).toFixed(2)}s` });
          rows.push({ label: 'Ammo',    value: `${md.ammunition} / ${md.maxAmmunition}` });
          rows.push({ label: 'Range',   value: String(md.fireRange ?? '-') });
        } else if (kind === 'helm' || kind === 'steering-wheel') {
          rows.push({ label: 'TurnRate', value: `${Number(md.maxTurnRate ?? 0).toFixed(3)} r/s` });
          rows.push({ label: 'Resp',     value: `${(Number(md.responsiveness ?? 0) * 100).toFixed(0)}%` });
        } else if (kind === 'plank') {
          if (md.sectionName) rows.push({ label: 'Section', value: String(md.sectionName) });
          rows.push({ label: 'Material', value: String(md.material ?? '-') });
          rows.push({ label: 'Segment', value: String(md.segmentIndex ?? '-') });
        }
      }

    } else if (this.hoveredNpc) {
      const npc = this.hoveredNpc;
      title = `👤 NPC · ${npc.name}`;
      accentColor = '#66ccff';
      rows.push({ label: 'ID',       value: String(npc.id) });
      rows.push({ label: 'Level',    value: String(npc.npcLevel) });
      rows.push({ label: 'Company',  value: coName(npc.companyId), color: coColor(npc.companyId) });
      if (npc.ownerId) rows.push({ label: 'OwnerID', value: String(npc.ownerId) });
      const hpPct = npc.maxHealth > 0 ? npc.health / npc.maxHealth : 1;
      rows.push({ label: 'HP', value: `${npc.health} / ${npc.maxHealth}`, bar: hpPct, barColor: hpColor(hpPct) });
      const NPC_STATES: Record<number, string> = { 0: 'Idle', 1: 'Moving', 2: 'AtStation', 3: 'Repairing', 4: 'Fighting' };
      const NPC_ROLES: Record<number, string>  = { 0: 'Sailor', 1: 'Gunner', 2: 'Helmsman', 3: 'Rigger', 4: 'Repairer' };
      rows.push({ label: 'State',    value: NPC_STATES[npc.state] ?? String(npc.state) });
      rows.push({ label: 'Role',     value: NPC_ROLES[npc.role] ?? String(npc.role) });
      rows.push({ label: 'XP',       value: String(npc.xp) });
      rows.push({ label: 'StatPts',  value: String(npc.statPoints) });
      if (npc.shipId) rows.push({ label: 'ShipID', value: String(npc.shipId) });
      if (npc.assignedWeaponId) rows.push({ label: 'Weapon', value: String(npc.assignedWeaponId) });
      rows.push({ label: 'World',    value: `(${npc.position.x.toFixed(0)}, ${npc.position.y.toFixed(0)})` });

    } else if (this.hoveredShip) {
      const ship = this.hoveredShip;
      const _isGhostDbg = ship.shipType === SHIP_TYPE_GHOST;
      const _ghostLvlDbg = _isGhostDbg ? (ship.npcLevel ?? 1) : 0;
      title = _isGhostDbg
        ? `👻 GHOST · Lv.${_ghostLvlDbg} #${ship.id}`
        : `⚓ SHIP · ${ship.shipName || '#' + ship.id}`;
      accentColor = _isGhostDbg ? '#00eeff' : '#ff8844';
      const spd = Math.hypot(ship.velocity.x, ship.velocity.y);
      rows.push({ label: 'ID',       value: `${ship.id}  ${spd.toFixed(1)} px/s` });
      rows.push({ label: 'Company',  value: coName(ship.companyId), color: coColor(ship.companyId) });
      if (_isGhostDbg) {
        const _ghostMaxHp = Math.round(60000 * (1 + (_ghostLvlDbg - 1) * 9 / 59));
        const _hullPct = Math.max(0, Math.min(1, ship.hullHealth / _ghostMaxHp));
        rows.push({ label: 'Hull', value: `${ship.hullHealth.toFixed(0)} / ${_ghostMaxHp.toLocaleString()}`, bar: _hullPct, barColor: hpColor(_hullPct) });
      } else {
        const hullPct = Math.max(0, Math.min(1, ship.hullHealth / 100));
        rows.push({ label: 'Hull', value: `${ship.hullHealth.toFixed(1)}%`, bar: hullPct, barColor: hpColor(hullPct) });
      }
      rows.push({ label: 'Rotation', value: fmtRad(ship.rotation) });
      rows.push({ label: 'AngVel',   value: `${ship.angularVelocity.toFixed(3)} r/s` });
      rows.push({ label: 'Velocity', value: `(${ship.velocity.x.toFixed(1)}, ${ship.velocity.y.toFixed(1)})` });
      rows.push({ label: 'Position', value: `(${ship.position.x.toFixed(0)}, ${ship.position.y.toFixed(0)})` });
      rows.push({ label: 'Modules',  value: String(ship.modules.length) });
      rows.push({ label: 'Type',     value: String(ship.shipType) });
      rows.push({ label: 'Ammo',     value: ship.infiniteAmmo ? '∞' : String(ship.cannonAmmo) });
      if (ship.claimFlag) {
        const cf = ship.claimFlag;
        const prog = Math.round((1 - cf.progressMs / cf.totalMs) * 100);
        rows.push({ label: 'Claimed!', value: `${prog}% Co#${cf.planterCompany}`, color: '#ff4444' });
      }

    } else if (this._hoveredStructure) {
      const st = this._hoveredStructure;
      const STRUCT_NAMES: Record<string, string> = {
        wooden_floor: 'Floor', workbench: 'Workbench', wall: 'Wall',
        door_frame: 'DoorFrame', door: 'Door', shipyard: 'Shipyard',
        wood_ceiling: 'Ceiling', cannon: 'Cannon', flag_fort: 'Flag Fort',
        claim_flag: 'Claim Flag', company_fortress: 'C.Fortress', wreck: 'Wreck',
      };
      title = `🏗 STRUCT · ${STRUCT_NAMES[st.type] ?? st.type}`;
      accentColor = '#ffcc44';
      rows.push({ label: 'ID',       value: String(st.id) });
      rows.push({ label: 'Island',   value: String(st.islandId) });
      rows.push({ label: 'Company',  value: coName(st.companyId), color: coColor(st.companyId) });
      rows.push({ label: 'Placer',   value: st.placerName || '—' });
      const tgtHp = st.targetHp ?? st.maxHp;
      const hpPct = tgtHp > 0 ? st.hp / tgtHp : 1;
      rows.push({ label: 'HP',       value: `${st.hp} / ${tgtHp} / ${st.maxHp}`, bar: hpPct, barColor: hpColor(hpPct) });
      rows.push({ label: 'Position', value: `(${st.x.toFixed(0)}, ${st.y.toFixed(0)})` });
      if (st.rotation !== undefined) rows.push({ label: 'Rotation', value: `${st.rotation}°` });
      if (st.claimOrphaned) rows.push({ label: 'Orphaned', value: 'YES', color: '#ff4444' });
      if (st.claimPhase !== undefined) {
        const PHASES: Record<number, string> = { 0: 'CLAIMING', 1: 'BUILDING', 2: 'ACTIVE', 3: 'DEMOLISHING' };
        rows.push({ label: 'Phase',  value: PHASES[st.claimPhase] ?? String(st.claimPhase), color: '#aaddff' });
        if (st.claimPhaseProgressMs !== undefined && st.claimPhaseTotalMs) {
          const pp = Math.max(0, 1 - st.claimPhaseProgressMs / st.claimPhaseTotalMs);
          rows.push({ label: 'PhaseProgress', value: `${(pp * 100).toFixed(1)}%`, bar: pp, barColor: '#44aaff' });
        }
      }
      if (st.claimState !== undefined) {
        const STATES: Record<number, string> = { 0: 'CONTEST', 1: 'CLAIM_GRACE', 2: 'CLAIMING', 3: 'REV_GRACE', 4: 'REVERSING' };
        rows.push({ label: 'ClaimState', value: STATES[st.claimState] ?? String(st.claimState), color: '#ffee44' });
      }
      if (st.claimProgress !== undefined) rows.push({ label: 'ClaimProg', value: `${(st.claimProgress / 1000).toFixed(1)}s` });
      if (st.claimLinkedFort !== undefined) rows.push({ label: 'LinkFort',  value: String(st.claimLinkedFort) });
      if (st.claimSourceEnemy !== undefined) rows.push({ label: 'SrcEnemy', value: String(st.claimSourceEnemy) });
      if (st.dominators && st.dominators.length > 0) {
        rows.push({ label: 'Dominators', value: st.dominators.slice(0, 5).join(', ') + (st.dominators.length > 5 ? '…' : ''), color: '#ff8866' });
      }
      if (st.fortressComplete !== undefined) rows.push({ label: 'FortComplete', value: st.fortressComplete ? 'YES' : 'NO' });
      if (st.fortressContested) rows.push({ label: 'Contested', value: 'YES', color: '#ff4444' });
    } else {
      return; // nothing hovered
    }

    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    const PAD = 10;
    const ROW_H = 16;
    const BAR_H = 4;
    const W = 290;

    let panelH = PAD + 20; // header
    panelH += 6;           // separator gap
    for (const row of rows) {
      panelH += ROW_H;
      if (row.bar !== undefined) panelH += BAR_H + 4;
    }
    panelH += PAD;

    const px = 12;
    const py = ch - panelH - 12;

    ctx.save();
    ctx.globalAlpha = 1;

    // Background panel
    ctx.fillStyle = 'rgba(0,4,16,0.94)';
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, W, panelH, 5);
    ctx.fill();
    ctx.stroke();

    // Left accent bar
    ctx.fillStyle = accentColor;
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.roundRect(px, py, 3, panelH, [5, 0, 0, 5]);
    ctx.fill();
    ctx.globalAlpha = 1;

    let curY = py + PAD;

    // Title
    ctx.font = 'bold 12px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = accentColor;
    ctx.fillText(title, px + PAD + 6, curY);
    curY += 20;

    // Separator
    ctx.strokeStyle = accentColor + '44';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + PAD, curY);
    ctx.lineTo(px + W - PAD, curY);
    ctx.stroke();
    curY += 6;

    // Data rows
    ctx.font = '11px "Courier New", monospace';
    for (const row of rows) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(160,180,200,0.72)';
      ctx.fillText(row.label, px + PAD + 6, curY);
      ctx.textAlign = 'right';
      ctx.fillStyle = row.color ?? '#ddeeff';
      ctx.fillText(row.value, px + W - PAD, curY);
      curY += ROW_H;

      if (row.bar !== undefined) {
        const bx = px + PAD + 6;
        const bw = W - PAD * 2 - 6;
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(bx, curY, bw, BAR_H);
        ctx.fillStyle = row.barColor ?? '#44cc66';
        ctx.fillRect(bx, curY, Math.round(bw * Math.max(0, Math.min(1, row.bar))), BAR_H);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(bx, curY, bw, BAR_H);
        curY += BAR_H + 4;
      }
    }

    ctx.restore();
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
          this.ctx.rotate(ship.rotation - camera.getState().rotation);
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
          this.ctx.rotate(ship.rotation - camera.getState().rotation);
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
          this.ctx.font = `${12 / camera.getState().zoom}px Georgia, serif`;
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
      ctx.font = `${11}px Georgia, serif`;
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
      // ── Polygon island (e.g. continental) — draw actual vertex polygon ──────
      if (isl.vertices && isl.vertices.length >= 3) {
        const icx = isl.x, icy = isl.y;
        const isc = camera.worldToScreen(Vec2.from(icx, icy));

        // Broad-phase: max vertex distance + buffer
        let pBroadR = 0;
        for (const v of isl.vertices) {
          const dd = Math.hypot(v.x - icx, v.y - icy);
          if (dd > pBroadR) pBroadR = dd;
        }
        pBroadR += 50;

        // Broad-phase circle (dashed yellow)
        ctx.save();
        ctx.strokeStyle = 'rgba(255,220,0,0.35)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(isc.x, isc.y, pBroadR * zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Beach polygon (red-orange) — ship collision boundary
        ctx.save();
        ctx.strokeStyle = 'rgba(255,80,0,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        isl.vertices.forEach((v, vi) => {
          const vs = camera.worldToScreen(Vec2.from(v.x, v.y));
          vi === 0 ? ctx.moveTo(vs.x, vs.y) : ctx.lineTo(vs.x, vs.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        // Grass polygon (green, 0.82 scale from centre) — player walkable zone
        const GRASS_POLY_SCALE = 0.82;
        ctx.save();
        ctx.strokeStyle = 'rgba(80,220,80,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        isl.vertices.forEach((v, vi) => {
          const gx = icx + (v.x - icx) * GRASS_POLY_SCALE;
          const gy = icy + (v.y - icy) * GRASS_POLY_SCALE;
          const gs = camera.worldToScreen(Vec2.from(gx, gy));
          vi === 0 ? ctx.moveTo(gs.x, gs.y) : ctx.lineTo(gs.x, gs.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        // Centre cross + label
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(isc.x - 10, isc.y); ctx.lineTo(isc.x + 10, isc.y);
        ctx.moveTo(isc.x, isc.y - 10); ctx.lineTo(isc.x, isc.y + 10);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '11px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`island#${isl.id} (${isl.preset}) verts:${isl.vertices.length}`, isc.x, isc.y - pBroadR * zoom - 4);
        ctx.restore();
        continue;
      }

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
      ctx.font         = '11px Georgia, serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        `island#${isl.id} (${isl.preset}) beach:${beachRadius}+${beachMaxBump} grass:${grassRadius}+${grassMaxBump}`,
        sc.x, sc.y - (beachRadius + beachMaxBump) * zoom - 4,
      );
      ctx.restore();
    }

    // ── Shipyard physics bodies (U-shape: left arm, right arm, back wall) ───
    // Constants mirror server websocket_server.c DOCK_* (all in client px)
    const DOCK_HW_D    = SHIPYARD_HW;
    const DOCK_HH_D    = SHIPYARD_HH;
    const DOCK_ARM_T_D = SHIPYARD_ARM_T;
    const DOCK_BACK_T_D = SHIPYARD_BACK_T;
    const DOCK_STAIR_D  = 50;  // stair gap at arm tips

    // [local-cx, local-cy, half-x, half-y, label, color]
    // Arms span the full dock height Y ∈ [−DOCK_HH_D, +DOCK_HH_D] → centre 0, half DOCK_HH_D
    const DOCK_OBBS: [number, number, number, number, string, string][] = [
      [-(DOCK_HW_D - DOCK_ARM_T_D / 2), 0,                            DOCK_ARM_T_D / 2, DOCK_HH_D,         'arm-L', 'rgba(0,160,255,0.85)'],
      [ (DOCK_HW_D - DOCK_ARM_T_D / 2), 0,                            DOCK_ARM_T_D / 2, DOCK_HH_D,         'arm-R', 'rgba(0,160,255,0.85)'],
      [0,                               -(DOCK_HH_D - DOCK_BACK_T_D / 2), DOCK_HW_D,    DOCK_BACK_T_D / 2, 'back',  'rgba(0,200,130,0.85)'],
    ];

    // Matches ctx.rotate() standard matrix: wx = ox + lx·cosR − ly·sinR, wy = oy + lx·sinR + ly·cosR
    const drawOBBWorld = (
      originX: number, originY: number, rotDeg: number,
      cx: number, cy: number, hx: number, hy: number,
      color: string, label: string,
    ) => {
      const rad = rotDeg * Math.PI / 180;
      const cosR = Math.cos(rad), sinR = Math.sin(rad);
      const corners: [number, number][] = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
      const pts = corners.map(([ox, oy]) => {
        const lx = cx + ox, ly = cy + oy;
        return camera.worldToScreen(Vec2.from(
          originX + lx * cosR - ly * sinR,
          originY + lx * sinR + ly * cosR,
        ));
      });
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
      const csc = camera.worldToScreen(Vec2.from(
        originX + cx * cosR - cy * sinR,
        originY + cx * sinR + cy * cosR,
      ));
      ctx.fillStyle = color;
      ctx.font = '10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, csc.x, csc.y);
      ctx.restore();
    };

    for (const sy of this.placedStructures) {
      if (sy.type !== 'shipyard') continue;
      const rot = sy.rotation ?? 0;
      const sc  = camera.worldToScreen(Vec2.from(sy.x, sy.y));

      // Centre cross + label
      ctx.save();
      ctx.strokeStyle = 'rgba(255,200,0,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sc.x - 10, sc.y); ctx.lineTo(sc.x + 10, sc.y);
      ctx.moveTo(sc.x, sc.y - 10); ctx.lineTo(sc.x, sc.y + 10);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,200,0,0.9)';
      ctx.font = '11px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`shipyard#${sy.id} rot=${rot}°`, sc.x, sc.y - 12);
      ctx.restore();

      // Draw the 3 OBBs
      for (const [ocx, ocy, ohx, ohy, lbl, col] of DOCK_OBBS) {
        drawOBBWorld(sy.x, sy.y, rot, ocx, ocy, ohx, ohy, col, lbl);
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
    if (!this._tooltipReady) return;

    const ship = this.hoveredShip;
    const COMPANY_NAMES: Record<number, string> = {
      [COMPANY_UNCLAIMED]: 'Unclaimed',
      [COMPANY_SOLO]:      'Solo',
      [COMPANY_PIRATES]:   'Pirates',
      [COMPANY_NAVY]:      'Navy',
      [COMPANY_GHOST]:     'Ghost Ships',
    };
    const companyName = COMPANY_NAMES[ship.companyId]
      ?? this._cachedCompanies.find(c => c.id === ship.companyId)?.name
      ?? `#${ship.companyId}`;
    const isGhost = ship.shipType === SHIP_TYPE_GHOST;
    const ghostLevel = isGhost && ship.npcLevel != null && ship.npcLevel > 0 ? ship.npcLevel : (isGhost ? 1 : 0);
    const shipTitle   = isGhost
      ? `Ghost Ship - Level ${ghostLevel}`
      : ship.shipName
        ? ship.shipName
        : `${companyName} Brigantine`;

    // Deck module health for the tooltip bar — not shown for ghost ships (they have no deck)
    const deckModTip = !isGhost ? ship.modules.find(m => m.kind === 'deck') : undefined;
    const dmdTip = deckModTip?.moduleData as any;
    const deckHp       = dmdTip?.health    ?? 0;
    const deckMaxHp    = dmdTip?.maxHealth ?? 10000;
    const deckTargetHp = dmdTip?.targetHealth ?? deckHp;

    // Ghost HP scales with level: 60000 × (1 + (level-1) × 9/59)
    const ghostMaxHullHP = isGhost
      ? Math.round(GHOST_MAX_HULL_HP * (1 + (ghostLevel - 1) * 9 / 59))
      : GHOST_MAX_HULL_HP;
    const maxHullHP = isGhost ? ghostMaxHullHP : 100;
    const hullPct  = Math.max(0, Math.min(1, ship.hullHealth / maxHullHP));
    const hullText = isGhost
      ? `Hull: ${ship.hullHealth.toFixed(0)} / ${ghostMaxHullHP.toLocaleString()}`
      : `Hull: ${ship.hullHealth.toFixed(0)}%`;
    const deckText = deckModTip
      ? `Deck: ${Math.round(deckHp)} / ${Math.round(deckTargetHp)} / ${Math.round(deckMaxHp)}`
      : 'Deck: —';
    const deckPct       = deckMaxHp > 0 ? deckHp       / deckMaxHp : 1;
    const deckTargetPct = deckMaxHp > 0 ? deckTargetHp / deckMaxHp : 1;

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const padding   = 10;
    const barH      = 8;
    const barW      = 180;
    const lineH     = 18;

    this.ctx.font = '14px Georgia, serif';
    this.ctx.textAlign    = 'left';
    this.ctx.textBaseline = 'top';

    // Ghost ships only show title + company + hull; non-ghost ships also show deck
    const lines    = isGhost
      ? [shipTitle, `Company: ${companyName}`, hullText]
      : [shipTitle, `Company: ${companyName}`, hullText, deckText];
    const barRowH  = barH + 6;
    const numBars  = isGhost ? 1 : 2; // hull bar only for ghosts, hull + deck for others
    let boxW = Math.max(barW + padding * 2, ...lines.map(l => this.ctx.measureText(l).width + padding * 2));
    let boxH = lines.length * lineH + barRowH * numBars + padding * 2;

    let tx = screenPos.x + 15;
    let ty = screenPos.y + 15;
    if (tx + boxW > this.canvas.width)  tx = screenPos.x - boxW - 15;
    if (ty + boxH > this.canvas.height) ty = screenPos.y - boxH - 15;

    // Background
    this.ctx.fillStyle   = 'rgba(12,16,28,0.95)';
    this.ctx.strokeStyle = isGhost ? ghostSpectralColor(ghostLevel, 0.8) : '#cc6633';
    this.ctx.lineWidth   = 1.5;
    this.ctx.beginPath();
    (this.ctx as any).roundRect(tx, ty, boxW, boxH, 4);
    this.ctx.fill();
    this.ctx.stroke();

    let cy = ty + padding;

    // Ship title
    this.ctx.fillStyle = isGhost ? ghostSpectralColor(ghostLevel, 0.95) : '#ffe066';
    this.ctx.font = '14px Georgia, serif';
    this.ctx.fillText(shipTitle, tx + padding, cy);  cy += lineH;

    // Company
    this.ctx.fillStyle = '#9ab';
    this.ctx.font = '12px Georgia, serif';
    this.ctx.fillText(`Company: ${companyName}`, tx + padding, cy);  cy += lineH;

    const bx = tx + padding;
    const bw = boxW - padding * 2;

    // Hull integrity label
    this.ctx.fillStyle = '#ccc';
    this.ctx.fillText(hullText, bx, cy);  cy += lineH;
    // Hull bar
    this.ctx.fillStyle = '#333';
    this.ctx.fillRect(bx, cy, bw, barH);
    const hullColor = isGhost
      ? ghostSpectralColor(ghostLevel, 0.6 + 0.4 * hullPct)
      : (hullPct > 0.6 ? '#44cc66' : hullPct > 0.3 ? '#ffaa44' : '#ff5544');
    this.ctx.fillStyle = hullColor;
    this.ctx.fillRect(bx, cy, Math.round(bw * hullPct), barH);
    this.ctx.strokeStyle = '#556';
    this.ctx.lineWidth = 0.8;
    this.ctx.strokeRect(bx, cy, bw, barH);
    cy += barH + 6;

    // Deck section — only for non-ghost ships
    if (!isGhost) {
      // Deck HP label  (format: current / target / max)
      this.ctx.fillStyle = '#ccc';
      this.ctx.font = '12px Georgia, serif';
      this.ctx.fillText(deckText, bx, cy);  cy += lineH;
      // Plank bar: grey background, amber target-HP marker, green/amber/red current-HP fill
      this.ctx.fillStyle = '#333';
      this.ctx.fillRect(bx, cy, bw, barH);
      // Target HP marker (dimmer fill up to target ceiling)
      if (deckTargetPct < 1) {
        this.ctx.fillStyle = 'rgba(200,160,60,0.35)';
        this.ctx.fillRect(bx, cy, Math.round(bw * deckTargetPct), barH);
      }
      const deckColor = deckPct > 0.6 ? '#44cc66' : deckPct > 0.3 ? '#ffaa44' : '#ff5544';
      this.ctx.fillStyle = deckColor;
      this.ctx.fillRect(bx, cy, Math.round(bw * deckPct), barH);
      // Target HP tick mark
      if (deckTargetPct < 1) {
        const tx2 = bx + Math.round(bw * deckTargetPct);
        this.ctx.strokeStyle = '#c8a03c';
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(tx2, cy - 1);
        this.ctx.lineTo(tx2, cy + barH + 1);
        this.ctx.stroke();
      }
      this.ctx.strokeStyle = '#556';
      this.ctx.lineWidth = 0.8;
      this.ctx.strokeRect(bx, cy, bw, barH);
    }
  }

  /**
   * Draw hover tooltip for a hovered NPC.
   * Shows: name + level, role/state, HP bar (always), XP bar (same company only).
   */
  private drawNpcTooltip(camera: Camera): void {
    if (!this.hoveredNpc || !this.mouseWorldPos) return;
    // Skip if a module tooltip is already showing (avoid overlap)
    if (this.hoveredModule) return;
    if (!this._tooltipReady) return;

    const npc = this.hoveredNpc;
    const ROLE_NAMES: Record<number, string> = {
      0: 'Sailor', 1: 'Gunner', 2: 'Helmsman', 3: 'Rigger', 4: 'Repairer',
    };
    const STATE_NAMES: Record<number, string> = {
      0: 'Idle', 1: 'Moving', 2: 'At Station', 3: 'Repairing',
    };

    // For COMPANY_SOLO NPCs, same-company only if this player owns them
    const sameCompany = npc.companyId === COMPANY_SOLO
      ? (npc.ownerId !== 0 && npc.ownerId === this.localPlayerId)
      : (this._localCompanyId !== 0 && npc.companyId === this._localCompanyId);
    const hpPct = npc.maxHealth > 0 ? npc.health / npc.maxHealth : 1;
    const xpToNext = npc.npcLevel * 100;
    const xpPct    = Math.min(npc.xp / xpToNext, 1);

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    const padding = 10;
    const barH    = 8;
    const barW    = 180;
    const lineH   = 18;

    this.ctx.font = '14px Georgia, serif';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'top';

    const COMPANY_NAMES: Record<number, string> = { [COMPANY_UNCLAIMED]: 'Unclaimed', [COMPANY_SOLO]: 'Solo', [COMPANY_PIRATES]: 'Pirates', [COMPANY_NAVY]: 'Navy', [COMPANY_GHOST]: 'Ghost Ships' };
    const COMPANY_COLORS_MAP: Record<number, string> = { [COMPANY_UNCLAIMED]: '#888888', [COMPANY_SOLO]: '#ffcc44', [COMPANY_PIRATES]: '#ff6644', [COMPANY_NAVY]: '#4488ff', [COMPANY_GHOST]: '#00eeff' };

    // Resolve owner name: for solo NPCs use the ownerId field directly
    let ownerName: string | null = null;
    if (npc.companyId === COMPANY_SOLO && npc.ownerId !== 0) {
      const ownerPlayer = this._cachedWorldPlayers.find(p => p.id === npc.ownerId);
      ownerName = ownerPlayer?.name ?? `Player #${npc.ownerId}`;
    }

    const ignoreFlag  = this.npcIgnoreSet.has(npc.id) ? '  🚫' : '';
    const titleText   = `${npc.name}  Lv.${npc.npcLevel}${npc.locked ? '  🔒' : ''}${ignoreFlag}`;
    const _deckLabel  = npc.shipId ? (npc.deckLevel === 0 ? 'Deck: Lower' : 'Deck: Upper') : '';
    const subText     = `${ROLE_NAMES[npc.role] ?? 'Sailor'}  –  ${STATE_NAMES[npc.state] ?? 'Idle'}${_deckLabel ? `  –  ${_deckLabel}` : ''}`;
    const companyLabel = COMPANY_NAMES[npc.companyId]
      ?? this._cachedCompanies.find(c => c.id === npc.companyId)?.name
      ?? `#${npc.companyId}`;
    const companyText = (npc.companyId === COMPANY_SOLO)
      ? `Company of ${ownerName ?? `Player #${npc.ownerId || '?'}`}`
      : `Company: ${companyLabel}`;
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
    this.ctx.font = '12px Georgia, serif';
    this.ctx.fillText(subText, tx + padding, cy);  cy += lineH;

    // Company / owner line — color swatch + text
    const swatchSz = 10;
    const swatchColor = COMPANY_COLORS_MAP[npc.companyId] ?? '#aaa';
    this.ctx.fillStyle = swatchColor;
    this.ctx.fillRect(tx + padding, cy + 3, swatchSz, swatchSz);
    this.ctx.fillStyle = sameCompany ? '#ffe066' : '#ccc';
    this.ctx.font = '12px Georgia, serif';
    this.ctx.fillText(companyText, tx + padding + swatchSz + 5, cy);  cy += lineH;

    // HP label
    this.ctx.font = '12px Georgia, serif';
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
      this.ctx.font = '12px Georgia, serif';
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
   * Draw card-style hover tooltip for a hovered island structure.
   * Mirrors the module tooltip design: left accent bar, HP bar, stats.
   */
  private drawStructureTooltip(camera: Camera): void {
    if (!this._hoveredStructure || !this.mouseWorldPos) return;
    // Module / NPC tooltips take higher priority
    if (this.hoveredModule || this.hoveredNpc) return;
    if (!this._tooltipReady) return;

    const s = this._hoveredStructure;
    const ctx = this.ctx;
    const cw  = this.canvas.width;
    const ch  = this.canvas.height;

    // ── Per-type visual identity ─────────────────────────────────────────
    type StructMeta = { name: string; color: string; border: string; desc: string };
    const TYPE_META: Record<string, StructMeta> = {
      wooden_floor:     { name: 'Wooden Floor',      color: '#7a4f28', border: '#bb8855', desc: 'Foundation tile. Provides a stable surface for structures.' },
      workbench:        { name: 'Workbench',          color: '#9a6a28', border: '#dda850', desc: 'Crafting station. Used to create items and equipment.' },
      wall:             { name: 'Wooden Wall',        color: '#7a4f28', border: '#bb8855', desc: 'Structural wall. Protects against cannon fire and intruders.' },
      door_frame:       { name: 'Door Frame',         color: '#9a6a28', border: '#ccaa55', desc: 'Frame for mounting a door. Can be reinforced.' },
      door:             { name: 'Door',               color: '#9a6a28', border: '#ccaa55', desc: 'Lockable entry point. Open or close to control access.' },
      wood_ceiling:     { name: 'Ceiling',            color: '#6b4520', border: '#a07040', desc: 'Overhead covering. Provides shelter and structural integrity.' },
      shipyard:         { name: 'Shipyard',           color: '#2a5a88', border: '#5599cc', desc: 'Dock for constructing and repairing ships.' },
      cannon:           { name: 'Island Cannon',      color: '#882222', border: '#cc4433', desc: 'Stationary cannon emplacement. Fires at enemy ships.' },
      flag_fort:        { name: 'Flag Fort',          color: '#886622', border: '#ddaa33', desc: 'Territory anchor. Claims surrounding land for your company.' },
      company_fortress: { name: 'Company Fortress',   color: '#553388', border: '#9966cc', desc: 'Whole-island territorial stronghold.' },
      claim_flag:       { name: 'Claim Flag',         color: '#228866', border: '#44bb88', desc: 'Active territory dispute flag.' },
      wreck:            { name: 'Wreck',              color: '#555566', border: '#888899', desc: 'Salvageable ship wreckage.' },
    };
    const meta: StructMeta = TYPE_META[s.type] ?? { name: s.type, color: '#555566', border: '#8888aa', desc: '' };

    // ── Company name helper ───────────────────────────────────────────────
    const COMPANY_NAMES_MAP: Record<number, string> = {
      [COMPANY_UNCLAIMED]: 'Unclaimed',
      [COMPANY_SOLO]:      'Solo',
      [COMPANY_PIRATES]:   'Pirates',
      [COMPANY_NAVY]:      'Navy',
      [COMPANY_GHOST]:     'Ghost Ships',
    };
    const companyName = COMPANY_NAMES_MAP[s.companyId]
      ?? this._cachedCompanies.find(c => c.id === s.companyId)?.name
      ?? (s.companyId > 0 ? `Company #${s.companyId}` : 'Unclaimed');
    const isFriendly = this._localCompanyId > 0 && s.companyId === this._localCompanyId;
    const companyColor = isFriendly ? '#44ff88' : s.companyId === 0 ? '#aaaaaa' : '#ff8866';

    // ── HP values ────────────────────────────────────────────────────────
    const hp       = s.hp;
    const maxHp    = s.maxHp;
    const targetHp = s.targetHp ?? maxHp;
    const hpPct       = maxHp    > 0 ? hp / maxHp    : 1;
    const targetPct   = maxHp    > 0 ? targetHp / maxHp : 1;
    const hpColor = (p: number) => p > 0.6 ? '#44cc66' : p > 0.3 ? '#ffaa22' : '#ff4444';

    // ── Stat lines ───────────────────────────────────────────────────────
    type StatLine = { label: string; value: string; color?: string };
    const stats: StatLine[] = [];

    stats.push({ label: 'Company', value: companyName, color: companyColor });
    if (s.placerName) stats.push({ label: 'Built by', value: s.placerName, color: '#cccccc' });

    const hpLabel = targetHp < maxHp
      ? `${hp.toLocaleString()} / ${targetHp.toLocaleString()} / ${maxHp.toLocaleString()}`
      : `${hp.toLocaleString()} / ${maxHp.toLocaleString()}`;
    stats.push({ label: 'HP', value: hpLabel, color: hpColor(hpPct) });

    if (s.type === 'door') {
      stats.push({ label: 'State',  value: s.doorOpen ? 'Open' : 'Closed',      color: s.doorOpen ? '#88ee88' : '#ee8844' });
      if (s.doorLocked !== undefined)
        stats.push({ label: 'Lock',   value: s.doorLocked ? 'Locked' : 'Unlocked', color: s.doorLocked ? '#ff6644' : '#44dd88' });
    }
    if (s.type === 'cannon') {
      const reloadReady = !s.cannonReloadMs || s.cannonReloadMs <= 0;
      stats.push({ label: 'Reload', value: reloadReady ? 'Ready' : `${((s.cannonReloadMs ?? 0) / 1000).toFixed(1)}s`, color: reloadReady ? '#44cc66' : '#ffaa44' });
    }
    if (s.type === 'shipyard' && s.construction) {
      const c = s.construction;
      const placed = c.modulesPlaced.length;
      stats.push({ label: 'Constructing', value: `${placed} modules placed`, color: '#44aaff' });
    }
    if ((s.type === 'flag_fort' || s.type === 'company_fortress') && s.claimPhase !== undefined) {
      const PHASES: Record<number, string> = { 0: 'Claiming', 1: 'Building', 2: 'Active', 3: 'Demolishing' };
      stats.push({ label: 'Phase', value: PHASES[s.claimPhase] ?? String(s.claimPhase), color: '#aaddff' });
    }
    if (s.fortressContested || (s.claimPhase !== undefined && s.type === 'flag_fort' && s.dominators && s.dominators.length > 0)) {
      stats.push({ label: 'Status', value: 'CONTESTED', color: '#ff4444' });
    }
    if (hp < targetHp && targetHp > 0) {
      stats.push({ label: 'Repairing', value: `→ ${targetHp.toLocaleString()}`, color: '#88ccff' });
    }

    // ── Layout ───────────────────────────────────────────────────────────
    const PAD    = 10;
    const W      = 240;
    const LINE   = 16;
    const NAME_H = 18;

    ctx.font = '12px Georgia, serif';
    const wrapText = (text: string, maxW: number): string[] => {
      const words = text.split(' ');
      const ls: string[] = [];
      let cur = '';
      for (const w of words) {
        const test = cur ? `${cur} ${w}` : w;
        if (ctx.measureText(test).width > maxW && cur) { ls.push(cur); cur = w; }
        else cur = test;
      }
      if (cur) ls.push(cur);
      return ls;
    };
    const descLines = meta.desc ? wrapText(meta.desc, W - PAD * 2 - 4) : [];

    const totalH = PAD + NAME_H + 4
      + (descLines.length > 0 ? descLines.length * LINE + 6 : 0)
      + stats.length * LINE + (stats.length > 0 ? 6 : 0)
      + LINE * 2 + 4   // HP bar row
      + PAD;

    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    let tx = screenPos.x + 15;
    let ty = screenPos.y + 15;
    if (tx + W      > cw) tx = screenPos.x - W      - 15;
    if (ty + totalH > ch) ty = screenPos.y - totalH - 15;
    tx = Math.max(4, tx);
    ty = Math.max(4, ty);

    // ── Draw card ────────────────────────────────────────────────────────
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = 'rgba(12,12,20,0.94)';
    ctx.strokeStyle = meta.border;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(tx, ty, W, totalH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Left accent bar
    ctx.fillStyle = meta.color;
    ctx.beginPath();
    ctx.roundRect(tx, ty, 4, totalH, [6, 0, 0, 6]);
    ctx.fill();

    let cy = ty + PAD;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';

    // Name
    ctx.font      = 'bold 14px Georgia, serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(meta.name, tx + PAD + 4, cy);
    cy += NAME_H + 4;

    // Description
    if (descLines.length > 0) {
      ctx.font      = '12px Georgia, serif';
      ctx.fillStyle = '#aaaaaa';
      for (const line of descLines) { ctx.fillText(line, tx + PAD + 4, cy); cy += LINE; }
      cy += 6;
    }

    // Stats (label left, value right)
    ctx.font = '12px Georgia, serif';
    for (const st of stats) {
      if (st.label === 'HP') continue; // HP drawn as bar below
      ctx.textAlign = 'left';
      ctx.fillStyle = '#888888';
      ctx.fillText(st.label, tx + PAD + 4, cy);
      ctx.textAlign = 'right';
      ctx.fillStyle = st.color ?? '#cccccc';
      ctx.fillText(st.value, tx + W - PAD - 4, cy);
      cy += LINE;
    }
    if (stats.length > 0) cy += 6;

    // HP bar
    const barH = 8;
    const bx   = tx + PAD + 4;
    const bw   = W - PAD * 2 - 4;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#888888';
    ctx.fillText('HP', bx, cy);
    ctx.textAlign = 'right';
    ctx.fillStyle = hpColor(hpPct);
    const hpStat = stats.find(r => r.label === 'HP');
    if (hpStat) ctx.fillText(hpStat.value, tx + W - PAD - 4, cy);
    cy += LINE;

    // Bar background
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(bx, cy, bw, barH);
    // Target HP dimmer band (repair ceiling)
    if (targetPct < 1) {
      ctx.fillStyle = 'rgba(200,160,60,0.3)';
      ctx.fillRect(bx, cy, Math.round(bw * targetPct), barH);
    }
    // Current HP fill
    ctx.fillStyle = hpColor(hpPct);
    ctx.fillRect(bx, cy, Math.round(bw * hpPct), barH);
    // Target HP tick mark
    if (targetPct < 1 && targetPct > 0) {
      const tx2 = bx + Math.round(bw * targetPct);
      ctx.strokeStyle = '#c8a03c';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx2, cy - 1);
      ctx.lineTo(tx2, cy + barH + 1);
      ctx.stroke();
    }
    ctx.strokeStyle = '#444455';
    ctx.lineWidth   = 0.8;
    ctx.strokeRect(bx, cy, bw, barH);

    ctx.restore();
  }

  /**
   * Draw hover tooltip for modules
   */
  private drawHoverTooltip(camera: Camera): void {
    if (!this.hoveredModule || !this.mouseWorldPos) return;
    if (!this._tooltipReady) return;
    
    const { ship, module } = this.hoveredModule;
    const moduleData = module.moduleData;
    const effectiveKind = (moduleData?.kind ?? module.kind) as string;
    if (!effectiveKind) return;
    const md = moduleData;
    
    // Convert mouse world position to screen position for tooltip
    const screenPos = camera.worldToScreen(this.mouseWorldPos);
    
    // ── Card-style tooltip (matches item tooltip design) ─────────────────
    const ctx = this.ctx;
    const cw  = this.canvas.width;
    const ch  = this.canvas.height;

    // Per-kind visual identity
    const KIND_META: Record<string, { name: string; color: string; border: string; desc: string }> = {
      'cannon':         { name: 'Cannon',       color: '#cc3322', border: '#ff6644', desc: 'Heavy siege weapon. Fires iron shot across open water.' },
      'swivel':         { name: 'Swivel Gun',    color: '#cc3322', border: '#ff8855', desc: 'Light deck-mounted gun. Ideal for close-quarters and crew suppression.' },
      'mast':           { name: 'Mast',          color: '#336688', border: '#66aacc', desc: 'Drives the ship using wind. Sail state and openness affect speed.' },
      'helm':           { name: 'Helm',          color: '#886622', border: '#ddaa44', desc: 'Controls ship heading. Turn rate and responsiveness govern handling.' },
      'steering-wheel': { name: 'Helm',          color: '#886622', border: '#ddaa44', desc: 'Controls ship heading. Turn rate and responsiveness govern handling.' },
      'plank':          { name: 'Hull Plank',    color: '#664422', border: '#aa7744', desc: 'Structural hull plank. Protects against water ingress and cannon fire.' },
      'deck':           { name: 'Deck',          color: '#445544', border: '#778877', desc: 'Provides a stable surface for crew and cargo.' },
      'ladder':         { name: 'Ladder',        color: '#334455', border: '#5577aa', desc: 'Allows crew to move between deck levels.' },
      'seat':           { name: 'Seat',          color: '#553344', border: '#886677', desc: 'Resting position for crew members.' },
      'custom':         { name: 'Custom Module', color: '#444455', border: '#7777aa', desc: 'A custom-built module with unique properties.' },
      'workbench':      { name: 'Workbench',      color: '#9a6a28', border: '#dda850', desc: 'Crafting station for ship-side equipment and supplies.' },
      'chest':          { name: 'Chest',          color: '#886622', border: '#d4a040', desc: 'Stores raw resources. Contents add weight to the ship.' },
      'bed':            { name: 'Bed',            color: '#664488', border: '#aa77dd', desc: 'Fast travel hub — respawn here from the death screen.' },
    };
    const meta = KIND_META[effectiveKind] ?? { name: effectiveKind, color: '#555566', border: '#8888aa', desc: '' };

    // Quality tier — overrides name colour, accent bar and border when present
    const qt        = module.qualityTier;
    const hasQuality = typeof qt === 'number' && qt >= 1;
    // For missing plank slots, use the selected blueprint tier for accent colouring
    const _ghostTier = (effectiveKind === 'plank' && md && (md as any).health === 0 && this.ghostPlankTier > 0)
      ? this.ghostPlankTier : null;
    const qCol      = hasQuality ? tierColor(qt!) : _ghostTier !== null ? tierColor(_ghostTier) : null;
    const qName     = hasQuality ? tierName(qt!)  : _ghostTier !== null ? tierName(_ghostTier)  : null;
    const accentCol = qCol ?? meta.color;
    const borderCol = qCol ?? meta.border;

    // Quality helper
    const qualityFromMaterial = (mat: string): string => {
      switch (mat) {
        case 'iron':  return 'Uncommon';
        case 'steel': return 'Rare';
        default:      return 'Common';
      }
    };

    // Stat lines
    type StatLine = { label: string; value: string; color?: string };
    const stats: StatLine[] = [];

    if (effectiveKind === 'plank') {
      const hp    = Math.round(md?.health ?? module.health ?? 0);
      const maxHp = md?.maxHealth ?? 10000;
      const pct   = maxHp > 0 ? hp / maxHp : 1;
      if (hp === 0) {
        // Missing plank slot — show placement blueprint hint
        if (this.ghostPlankTier > 0) {
          stats.push({ label: 'Blueprint', value: tierName(this.ghostPlankTier), color: tierColor(this.ghostPlankTier) });
        } else {
          stats.push({ label: 'Blueprint', value: 'Standard' });
        }
      } else {
        stats.push({ label: 'Health',  value: `${hp} / ${maxHp}`, color: pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa22' : '#ff4444' });
        if (!hasQuality && md?.material) {
          // Plain placed plank — show material-derived quality label
          stats.push({ label: 'Quality', value: qualityFromMaterial(md.material) });
        }
      }
      if (md?.sectionName) stats.push({ label: 'Section', value: md.sectionName });
    } else if (effectiveKind === 'cannon') {
      const hp    = Math.round(md?.health ?? module.health ?? 0);
      const maxHp = (md as any)?.maxHealth ?? 8000;
      const pct   = maxHp > 0 ? hp / maxHp : 1;
      stats.push({ label: 'Health',  value: `${hp} / ${maxHp}`, color: pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa22' : '#ff4444' });
      const dmgLvl = ship.levelStats?.levels?.[SHIP_ATTR_DAMAGE] ?? 1;
      const qwRaw  = module.qualityWeaponDmgQ8;
      const qt     = module.qualityTier;
      const entityBase = this.selectedAmmoType !== 0 ? BAR_SHOT_ENTITY_BASE_DAMAGE : CANNON_ENTITY_BASE_DAMAGE;
      const hullDmg   = computeCannonHullDamage(CANNON_HULL_BASE_DAMAGE, dmgLvl, qwRaw, qt);
      const crewDmg   = computeCannonEntityDamage(entityBase, dmgLvl);
      stats.push({ label: 'Hull Damage', value: String(hullDmg) });
      stats.push({ label: 'Crew Damage', value: String(crewDmg) });
      stats.push({ label: 'Reload',  value: `${(md as any)?.reloadTime ?? 3.0}s` });
      if (!hasQuality) stats.push({ label: 'Quality', value: 'Common' });
    } else if (effectiveKind === 'helm' || effectiveKind === 'steering-wheel') {
      const hp    = Math.round((md as any)?.health ?? module.health ?? 10000);
      const maxHp = (md as any)?.maxHealth ?? 10000;
      const pct   = maxHp > 0 ? hp / maxHp : 1;
      stats.push({ label: 'Health',         value: `${hp} / ${maxHp}`, color: pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa22' : '#ff4444' });
      if (md) {
        stats.push({ label: 'Turn Rate',      value: md.maxTurnRate.toFixed(2) });
        stats.push({ label: 'Responsiveness', value: `${(md.responsiveness * 100).toFixed(0)}%` });
      }
    } else if (effectiveKind === 'mast') {
      if (md) {
        const Q16   = 100_000;
        const rawHp = md.health ?? 15000;
        const rawMax = md.maxHealth ?? 15000;
        const hp    = Math.round(rawHp  > Q16 ? rawHp  / 65536 : rawHp);
        const maxHp = Math.round(rawMax > Q16 ? rawMax / 65536 : rawMax);
        const pct   = maxHp > 0 ? hp / maxHp : 1;
        stats.push({ label: 'Health', value: `${hp} / ${maxHp}`, color: pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa22' : '#ff4444' });
        const rawFh    = md.fiberHealth    ?? 15000;
        const rawFhMax = md.fiberMaxHealth ?? 15000;
        const fh    = rawFhMax === 0 ? 15000 : Math.round(rawFh    > Q16 ? rawFh    / 65536 : rawFh);
        const fhMax = rawFhMax === 0 ? 15000 : Math.round(rawFhMax > Q16 ? rawFhMax / 65536 : rawFhMax);
        const fhPct = fhMax > 0 ? Math.round((fh / fhMax) * 100) : 100;
        stats.push({ label: 'Sail Fibers',    value: `${fh} / ${fhMax} (${fhPct}%)`, color: fhPct > 60 ? '#44cc66' : fhPct > 30 ? '#ffaa22' : '#ff4444' });
        stats.push({ label: 'Sail State',     value: md.sailState.toUpperCase() });
        stats.push({ label: 'Openness',       value: `${md.openness.toFixed(0)}%` });
        stats.push({ label: 'Wind Eff.',      value: `${(md.windEfficiency * 100).toFixed(0)}%` });
      } else {
        const hp = Math.round(module.health ?? 0);
        stats.push({ label: 'Health', value: `${hp} / 15000` });
      }
    } else if (effectiveKind === 'chest') {
      const hp    = Math.round((md as any)?.health ?? module.health ?? 5000);
      const maxHp = Math.round((md as any)?.maxHealth ?? 5000);
      const pct   = maxHp > 0 ? hp / maxHp : 1;
      stats.push({ label: 'Health', value: `${hp} / ${maxHp}`, color: pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa22' : '#ff4444' });
      if (md) {
        stats.push({ label: 'Wood',        value: String(md.wood) });
        stats.push({ label: 'Fiber',       value: String(md.fiber) });
        stats.push({ label: 'Metal',       value: String(md.metal) });
        stats.push({ label: 'Stone',       value: String(md.stone) });
      }
    } else if (effectiveKind === 'bed') {
      const hp    = Math.round(module.health ?? 5000);
      const maxHp = 5000;
      const pct   = maxHp > 0 ? hp / maxHp : 1;
      stats.push({ label: 'Health', value: `${hp} / ${maxHp}`, color: pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa22' : '#ff4444' });
    } else if (effectiveKind === 'workbench') {
      const hp    = Math.round(module.health ?? 10000);
      const maxHp = 10000;
      const pct   = maxHp > 0 ? hp / maxHp : 1;
      stats.push({ label: 'Health', value: `${hp} / ${maxHp}`, color: pct > 0.6 ? '#44cc66' : pct > 0.3 ? '#ffaa22' : '#ff4444' });
    }

    // Deck assignment — shown for interactive modules (not layout-only planks / decks)
    if (effectiveKind !== 'plank' && effectiveKind !== 'deck') {
      const _deckVal = module.deckId === 255 ? 'Any'
                     : module.deckId === 0    ? 'Lower'
                     :                          'Upper';
      stats.push({ label: 'Deck', value: `${_deckVal} (${module.deckId === 255 ? '—' : module.deckId})` });
    }

    // Quality bonuses — shown when the module was crafted from a quality blueprint
    if (hasQuality) {
      const qdRaw = module.qualityDurabilityQ8;
      const qwRaw = module.qualityWeaponDmgQ8;
      const qsRaw = module.qualitySailEffQ8;
      if (typeof qdRaw === 'number' && qdRaw > 0) {
        const lbl = statMultLabel(qdRaw);
        if (lbl) stats.push({ label: 'Resist. Bonus', value: lbl, color: qCol! });
      }
      if (typeof qwRaw === 'number' && qwRaw > 0) {
        const lbl = statMultLabel(qwRaw);
        if (lbl) stats.push({ label: 'Damage Bonus', value: lbl, color: qCol! });
      }
      if (typeof qsRaw === 'number' && qsRaw > 0) {
        const lbl = statMultLabel(qsRaw);
        if (lbl) stats.push({ label: 'Sail Bonus', value: lbl, color: qCol! });
      }
      // Tier bonus (+N% resist & damage from blueprint tier multiplier)
      if (typeof qt === 'number' && qt >= 1) {
        stats.push({ label: 'Tier Bonus', value: `+${qt * 10}% resist & dmg`, color: qCol! });
      }
    } else if (_ghostTier !== null) {
      // Missing plank slot with blueprint selected — show preview tier bonus
      stats.push({ label: 'Tier Bonus', value: `+${_ghostTier * 10}% resist & dmg`, color: qCol! });
    }

    // Weight
    const MODULE_KG: Record<string, number> = {
      'cannon': 100, 'swivel': 180, 'mast': 150, 'helm': 20, 'steering-wheel': 20,
      'plank': 30, 'deck': 200, 'ladder': 5, 'seat': 25, 'custom': 50, 'workbench': 40, 'bed': 25,
    };
    let weightKg = MODULE_KG[effectiveKind] ?? 50;
    if (md?.kind === 'chest') {
      weightKg = 40
        + md.wood        * 0.5
        + md.fiber       * 0.1
        + md.metal       * 1.0
        + md.stone       * 0.75;
    }
    // Cannon weight is dynamic: 40 kg when stowed (gunport closed), 100 kg when deployed (gunport open / no gunport)
    if (md?.kind === 'cannon') {
      const snapIdx = (md as import('../../sim/modules').CannonModuleData).gunportSnapIdx;
      if (snapIdx !== undefined && snapIdx !== 255) {
        const gp = ship.modules.find(m => m.moduleData?.kind === 'gunport'
          && (m.moduleData as import('../../sim/modules').GunportModuleData).snapIndex === snapIdx);
        const gpOpen = gp ? !!(gp.moduleData as import('../../sim/modules').GunportModuleData).isOpen : true;
        weightKg = gpOpen ? 100 : 40;
      }
    }

    // Interact range
    const MAX_INTERACT_DIST = 50;
    let interactLabel = '[E] Interact';
    if (this.playerInteractInfo) {
      const { worldPos, localPos, carrierId } = this.playerInteractInfo;
      const cos = Math.cos(ship.rotation);
      const sin = Math.sin(ship.rotation);
      const mwx = ship.position.x + (module.localPos.x * cos - module.localPos.y * sin);
      const mwy = ship.position.y + (module.localPos.x * sin + module.localPos.y * cos);
      let dist: number;
      if (carrierId === ship.id && localPos) {
        dist = localPos.sub(module.localPos).length();
      } else {
        dist = worldPos.sub(Vec2.from(mwx, mwy)).length();
      }
      const baseLabel = effectiveKind === 'chest' ? '[E] to open'
        : effectiveKind === 'bed' ? '[E] Travel'
        : effectiveKind === 'workbench' ? 'Hold [E] to interact'
        : '[E] Interact';
      interactLabel = dist <= MAX_INTERACT_DIST ? baseLabel : 'Not in Range';
    } else if (effectiveKind === 'chest') {
      interactLabel = '[E] to open';
    } else if (effectiveKind === 'bed') {
      interactLabel = '[E] Travel';
    } else if (effectiveKind === 'workbench') {
      interactLabel = 'Hold [E] to interact';
    }

    // ── Layout ───────────────────────────────────────────────────────────
    const PAD    = 10;
    const W      = 230;
    const LINE   = 16;
    const NAME_H = 18;

    const wrapText = (text: string, maxW: number): string[] => {
      ctx.font = '12px Georgia, serif';
      const words = text.split(' ');
      const ls: string[] = [];
      let cur = '';
      for (const w of words) {
        const test = cur ? `${cur} ${w}` : w;
        if (ctx.measureText(test).width > maxW && cur) { ls.push(cur); cur = w; }
        else cur = test;
      }
      if (cur) ls.push(cur);
      return ls;
    };
    const descLines = meta.desc ? wrapText(meta.desc, W - PAD * 2 - 4) : [];

    const totalH = PAD + NAME_H + 4
      + LINE + 4
      + descLines.length * LINE + (descLines.length > 0 ? 6 : 0)
      + stats.length * LINE + (stats.length > 0 ? 6 : 0)
      + LINE + 8   // weight
      + LINE       // hint
      + PAD;

    let tx = screenPos.x + 15;
    let ty = screenPos.y + 15;
    if (tx + W      > cw) tx = screenPos.x - W      - 15;
    if (ty + totalH > ch) ty = screenPos.y - totalH - 15;
    tx = Math.max(4, tx);
    ty = Math.max(4, ty);

    // ── Draw card ────────────────────────────────────────────────────────
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = 'rgba(12,12,20,0.94)';
    ctx.strokeStyle = borderCol;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(tx, ty, W, totalH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Left accent bar
    ctx.fillStyle = accentCol;
    ctx.beginPath();
    ctx.roundRect(tx, ty, 4, totalH, [6, 0, 0, 6]);
    ctx.fill();

    let cy = ty + PAD;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';

    // Name — tier-colored when quality or blueprint selected for missing slot
    ctx.font      = 'bold 14px Georgia, serif';
    ctx.fillStyle = qCol ?? '#ffffff';
    const _showQName = hasQuality || _ghostTier !== null;
    ctx.fillText(_showQName ? `${qName} ${meta.name}` : meta.name, tx + PAD + 4, cy);
    cy += NAME_H + 4;

    // ID + kind
    ctx.font      = '11px Georgia, serif';
    ctx.fillStyle = '#888888';
    ctx.fillText(`ID: ${module.id}   [${effectiveKind}]`, tx + PAD + 4, cy);
    cy += LINE + 4;

    // Description
    if (descLines.length > 0) {
      ctx.font      = '12px Georgia, serif';
      ctx.fillStyle = '#cccccc';
      for (const line of descLines) { ctx.fillText(line, tx + PAD + 4, cy); cy += LINE; }
      cy += 6;
    }

    // Stats (label left, value right)
    if (stats.length > 0) {
      ctx.font = '12px Georgia, serif';
      for (const st of stats) {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#888888';
        ctx.fillText(st.label, tx + PAD + 4, cy);
        ctx.textAlign = 'right';
        ctx.fillStyle = st.color ?? '#cccccc';
        ctx.fillText(st.value, tx + W - PAD - 4, cy);
        cy += LINE;
      }
      cy += 6;
    }

    // Weight
    ctx.textAlign = 'left';
    ctx.font      = '11px Georgia, serif';
    ctx.fillStyle = '#8ab4cc';
    ctx.fillText(`Weight: ${weightKg} kg`, tx + PAD + 4, cy);
    cy += LINE + 8;

    // Interact hint
    if (!this._anyBuildActive) {
      ctx.font      = '11px Georgia, serif';
      ctx.fillStyle = interactLabel === '[E] Interact' ? '#aaaaaa' : '#ff6644';
      ctx.fillText(interactLabel, tx + PAD + 4, cy);
    }

    ctx.restore();

    // NOTE: Module hover highlight is drawn by drawModuleHoverHighlight() in the
    // main render pipeline — it fires immediately on hover (no tooltip delay) and
    // uses the unified glow/inner/fill design. No additional highlight here.
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

    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.scale(zoom, zoom);
    this.ctx.rotate(ship.rotation - camRot);

    const t = performance.now() / 1000;
    const pulse = 0.65 + 0.25 * Math.sin(t * 2.0);

    for (const g of ghosts) {
      this.ctx.save();
      this.ctx.translate(g.localPos.x, g.localPos.y);
      this.ctx.rotate(g.localRot);
      this.ctx.globalAlpha = pulse;

      // Blueprint style: blue wireframe, no fill
      const blueprintStroke = '#4da6ff';
      const blueprintFill   = 'rgba(20, 80, 200, 0.12)';

      switch (g.kind) {
        case 'cannon': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([4, 2]);
          // Base (matches actual cannon 22×15)
          this.ctx.fillRect(-11, -7.5, 22, 15);
          this.ctx.strokeRect(-11, -7.5, 22, 15);
          // Barrel (matches actual cannon 16×40)
          this.ctx.fillRect(-8, -40, 16, 40);
          this.ctx.strokeRect(-8, -40, 16, 40);
          this.ctx.setLineDash([]);
          break;
        }
        case 'mast': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([4, 2]);
          this.ctx.beginPath();
          this.ctx.arc(0, 0, 15, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.fillStyle = 'rgba(20, 60, 180, 0.08)';
          this.ctx.fillRect(-40, -5, 80, 10);
          this.ctx.strokeRect(-40, -5, 80, 10);
          this.ctx.setLineDash([]);
          break;
        }
        case 'helm': {
          const R = 16;
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
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
            this.ctx.strokeStyle = 'rgba(60, 140, 255, 0.55)';
            this.ctx.lineWidth = 1;
            this.ctx.stroke();
          }
          break;
        }
        case 'swivel': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.arc(0, 0, 8, 0, Math.PI * 2);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.fillRect(-3, -22, 6, 22);
          this.ctx.strokeRect(-3, -22, 6, 22);
          this.ctx.setLineDash([]);
          break;
        }
        case 'deck': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([6, 3]);
          this.ctx.beginPath();
          this.ctx.roundRect(-240, -60, 480, 120, 8);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
        case 'ramp':
        case 'hatch_cover': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.roundRect(-20, -10, 40, 20, 4);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
        case 'gunport': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.rect(-10, -8, 20, 16);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
        case 'chest': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.roundRect(-14, -10, 28, 20, 3);
          this.ctx.fill();
          this.ctx.stroke();
          // Chest lid line
          this.ctx.beginPath();
          this.ctx.moveTo(-14, -4);
          this.ctx.lineTo(14, -4);
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
        case 'workbench': {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.rect(-22, -15.5, 44, 31);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
        case 'plank':
        default: {
          this.ctx.fillStyle = blueprintFill;
          this.ctx.strokeStyle = blueprintStroke;
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([3, 2]);
          this.ctx.beginPath();
          this.ctx.roundRect(-25, -8, 50, 16, 4);
          this.ctx.fill();
          this.ctx.stroke();
          this.ctx.setLineDash([]);
          break;
        }
      }

      // Blueprint corner crosshairs
      this.ctx.globalAlpha = pulse * 0.6;
      this.ctx.strokeStyle = blueprintStroke;
      this.ctx.lineWidth = 1;
      const cx = 12, cl = 5;
      for (const [ox, oy] of [[-cx,-cx],[cx,-cx],[cx,cx],[-cx,cx]] as [number,number][]) {
        this.ctx.beginPath(); this.ctx.moveTo(ox - cl, oy); this.ctx.lineTo(ox + cl, oy); this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.moveTo(ox, oy - cl); this.ctx.lineTo(ox, oy + cl); this.ctx.stroke();
      }

      // Label row: kind name
      this.ctx.globalAlpha = pulse * 0.95;
      this.ctx.fillStyle = '#88ccff';
      this.ctx.font = '9px Georgia, serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'bottom';
      const labelY = g.kind === 'deck' ? -64 : -24;
      this.ctx.fillText(`📋 ${g.kind}`, 0, labelY);

      // Resource cost row
      const cost = g.resourceCost;
      const parts: string[] = [];
      if (cost.wood  > 0) parts.push(`W:${cost.wood}`);
      if (cost.fiber > 0) parts.push(`Fi:${cost.fiber}`);
      if (cost.metal > 0) parts.push(`Fe:${cost.metal}`);
      if (cost.stone > 0) parts.push(`St:${cost.stone}`);
      if (parts.length > 0) {
        this.ctx.font = '8px monospace';
        this.ctx.fillStyle = 'rgba(130,190,255,0.85)';
        this.ctx.fillText(parts.join(' '), 0, labelY - 10);
      }

      // "E to build" hint
      this.ctx.font = '8px Georgia, serif';
      this.ctx.fillStyle = 'rgba(180,220,255,0.6)';
      this.ctx.textBaseline = 'top';
      this.ctx.fillText('[E] build', 0, g.kind === 'deck' ? -58 : -16);

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

    // Dedicated ship-local ghost drawers handle these kinds (with rotation).
    if (kind === 'workbench' || kind === 'chest' || kind === 'bed' || kind === 'well') return;

    // Hide the following cursor ghost when the cannon is already snapping to a gunport —
    // the slot ghost itself acts as the placement indicator.
    if (kind === 'cannon' && this.hoveredGunportCannonSnap) return;

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
          if (newKind === 'cannon' && mod.kind === 'gunport') continue; // cannons coexist with gunports
          if (mod.deckId !== 255 && mod.deckId !== this._playerDeckLevel) continue; // different deck — no collision
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

      // Edge margin — module center must be at least module-radius inset from hull boundary.
      // Planks and decks snap to fixed slots and never need a cursor-edge check.
      // Swivels are the exception: they mount on the rail within 2–30 px of the hull edge.
      if (valid && kind !== 'plank' && kind !== 'deck') {
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
    // Factor in resource affordability: valid but unaffordable → red tint
    const canAfford = !valid ? true : this.ghostCanAfford; // only apply afford-check when placement is otherwise valid
    const okColor   = valid ? (canAfford ? '#44ff88' : '#ff4444') : planBlocked ? '#ffaa44' : '#ff5555';
    const fillColor = valid ? (canAfford ? 'rgba(30,120,60,0.45)' : 'rgba(180,30,30,0.45)') : planBlocked ? 'rgba(160,90,20,0.45)' : 'rgba(120,30,30,0.45)';

    switch (kind) {
      case 'cannon': {
        this.ctx.fillStyle = fillColor;
        this.ctx.strokeStyle = okColor;
        this.ctx.lineWidth = 1.5;
        // Base (matches actual cannon 22×15)
        this.ctx.fillRect(-11, -7.5, 22, 15);  this.ctx.strokeRect(-11, -7.5, 22, 15);
        // Barrel (matches actual cannon 16×40, pointing −y)
        this.ctx.fillRect(-8, -40, 16, 40);    this.ctx.strokeRect(-8, -40, 16, 40);
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
    this.ctx.font = 'bold 12px Georgia, serif';
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
        if (newKind === 'cannon' && mod.kind === 'gunport') continue; // cannons coexist with gunports
        if (mod.deckId !== 255 && mod.deckId !== this._playerDeckLevel) continue; // different deck — no collision
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
      this.ctx.fillRect(-11, -7.5, 22, 15);
      this.ctx.strokeRect(-11, -7.5, 22, 15);

      // -- Barrel (pointing up / forward) --
      this.ctx.fillStyle   = valid ? '#225522' : ghostSnap ? '#1a4d44' : ghostBlocked ? '#553311' : '#552222';
      this.ctx.strokeStyle = valid ? '#55ee55' : ghostSnap ? '#33ccbb' : ghostBlocked ? '#ee9933' : '#ee5555';
      this.ctx.fillRect(-8, -40, 16, 40);
      this.ctx.strokeRect(-8, -40, 16, 40);
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
    this.ctx.font = 'bold 13px Georgia, serif';
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
