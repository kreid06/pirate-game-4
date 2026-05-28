/**
 * Client Application - Main Client Coordinator
 * 
 * This class orchestrates all client-side systems and provides the main game loop.
 * It follows the composition pattern, delegating specific concerns to specialized systems.
 */

import { ClientConfig, ClientConfigManager } from './ClientConfig.js';

// Graphics System
import { RenderSystem } from './gfx/RenderSystem.js';
import { Camera } from './gfx/Camera.js';
import { GLContext } from './gfx/gl/GLContext.js';
import { GLWorldRenderer } from './gfx/gl/GLWorldRenderer.js';
import { DamageTeam } from './gfx/EffectRenderer.js';

// Network System  
import { NetworkManager, ConnectionState } from '../net/NetworkManager.js';
import { PredictionEngine } from '../net/PredictionEngine.js';
import { ShipPredictor } from '../net/ShipPredictor.js';

// Gameplay Systems
import { InputManager } from './gameplay/InputManager.js';
import { ModuleInteractionSystem } from './gameplay/ModuleInteractionSystem.js';
import { PhysicsConfig } from '../sim/Types.js';

// UI System
import { UIManager } from './ui/UIManager.js';
import { MENU_ID } from './ui/UIManager.js';
import { RadialMenu, type RadialOption } from './ui/RadialMenu.js';
import { CraftingMenu } from './ui/CraftingMenu.js';
import { ShipyardMenu } from './ui/ShipyardMenu.js';
import { ShipRenameDialog } from './ui/ShipRenameDialog.js';
import { PauseMenu, GameSettings } from './ui/PauseMenu.js';
import { CommandConsole } from './ui/CommandConsole.js';
import { IslandEditor } from './gfx/IslandEditor.js';
import { logout } from './auth/AuthService.js';

// Audio System
import { AudioManager } from './audio/AudioManager.js';

// Core Simulation Types
import { WorldState, Ship, InputFrame, WeaponGroupState, WeaponGroupMode, COMPANY_SOLO, COMPANY_UNCLAIMED, IslandDef, NPC_STATE_AT_GUN } from '../sim/Types.js';
import { GhostPlacement, GhostModuleKind } from '../sim/Types.js';
import { createEmptyInventory, ITEM_KIND_ID, ITEM_ID_MAP, ITEM_DEFS } from '../sim/Inventory.js';
import { Vec2 } from '../common/Vec2.js';
import { ModuleUtils, ShipModule, getModuleFootprint, footprintsOverlap } from '../sim/modules.js';
import { createCurvedShipHull } from '../sim/ShipUtils.js';
import { PolygonUtils } from '../common/PolygonUtils.js';

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
  /** Separate WebGL2 canvas stacked behind the main 2D canvas. Null if WebGL2 is disabled/unavailable. */
  private _glCanvas: HTMLCanvasElement | null = null;
  /** GL world renderer — null when WebGL2 is off or init failed. */
  private _glRenderer: GLWorldRenderer | null = null;
  /** Delta time from the last game loop tick (ms), stored for GL frame time accumulation. */
  private _lastDeltaMs = 16;
  /** Current GL internal render scale (GL canvas pixels / 2D canvas pixels). */
  private _glScale = 0.40;
  /** Adaptive GL scale limits. */
  private readonly _glScaleMin = 0.33;
  private readonly _glScaleMax = 0.50;
  /** Adaptive scaler counters and cooldown timestamp. */
  private _glBadFrameCount = 0;
  private _glGoodFrameCount = 0;
  private _glNextScaleAdjustAt = 0;
  private config: ClientConfig;
  private state: ClientState = ClientState.INITIALIZING;
  
  // Core Systems
  private renderSystem!: RenderSystem;
  private networkManager!: NetworkManager;
  private predictionEngine!: PredictionEngine;
  private shipPredictor: ShipPredictor | null = null;
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
  private previousMountState = false;    // Track previous mount state to detect changes
  private previousCarrierId: number | null = null; // Track ship changes for boarding sync
  private _prevLocalHealth: number | null = null;  // Detect respawn (health ≤0 → >0) for flash
  // Optimistic hotbar slot — held until server confirms the same value so that
  // rapid movement messages (W held) don't let stale world-states flicker the UI back.
  private pendingActiveSlot: number | null = null;
  /** companyId keyed by structure id — for team-colouring damage numbers on structure hits. */
  private _structureCompanyMap = new Map<number, number>();
  /** performance.now() timestamp of the most recent combat damage seen for a
   *  given structure id. Used to grey out the Repair option during the 30s
   *  post-damage cooldown enforced by the server. */
  private _structureLastDamagedAt = new Map<number, number>();
  // Player join/leave notification tracking
  private _knownPlayerIds = new Map<number, string>(); // playerId → name
  private _playerTrackingReady = false;
  // Claim flag state tracking for island proximity notifications
  private _claimFlagStates = new Map<number, number>(); // structId → last state
  // Optimistic mount state — held from module_interact_success until the server's
  // world-state echo confirms isMounted=true for the same module.
  private pendingMount: { moduleId: number; moduleKind: string; mountOffset?: Vec2; mountWorldPos?: Vec2 } | null = null;

  // Camera zoom animation
  private targetZoom  = 1.0;  // Zoom level we're animating toward
  private preHelmZoom = 1.0;  // Zoom before helm mount, restored on dismount
  private static readonly HELM_ZOOM    = 0.60; // Zoomed-out level while at the helm
  private static readonly DEFAULT_ZOOM = 1.00; // Normal gameplay zoom

  // Dynamic view-range / AOI
  private static readonly VIEW_RAY_COUNT = 32;    // Angular ray samples per frame
  private static readonly MAX_VIEW_DIST  = 5000;  // World-unit radius for open sea
  private static readonly BEACH_DEPTH    = 50;    // World-unit coastal strip treated same as ocean (1:1)
  private static readonly COAST_ZOOM     = 1.25;  // Zoom when fully surrounded by land
  private static readonly SEA_ZOOM       = 0.82;  // Zoom when fully in open sea
  private _userZoomMul  = 1.0;  // Accumulated scroll-wheel multiplier
  private _aoiBaseZoom  = 1.0;  // AOI-driven base zoom (not including user multiplier)
  private _viewOpenness = 1.0;  // 0=coast, 1=open sea (exponentially smoothed)
  private _rayHitDist   = new Float32Array(ClientApplication.VIEW_RAY_COUNT); // per-ray hit distance (world units)

  // Fog ray Web Worker — runs computeViewRays off the main thread.
  // Result arrives async (1-frame lag) which is imperceptible for fog.
  private _fogWorker: Worker | null = null;
  private _fogWorkerReady = false; // true once INIT has been sent
  private explicitBuildMode = false;
  private buildSelectedItem: 'cannon' | 'sail' | 'swivel' = 'cannon';
  private buildRotationDeg = 0;

  // Island structure build mode (wooden_floor / workbench / wall while off-ship)
  private islandBuildRotationDeg = 0;

  // Ghost placement system — B key opens build menu, player places planning markers
  private buildMenuOpen = false;
  private ghostPlacements: GhostPlacement[] = [];
  private pendingGhostKind: GhostModuleKind | null = null;

  // Weapon control groups — 10 user-defined groups (0–9), persistent per session
  private controlGroups: Map<number, WeaponGroupState> = new Map(
    Array.from({ length: 10 }, (_, i) => [i, { cannonIds: [], mode: 'haltfire' as WeaponGroupMode, targetId: -1 }])
  );
  /**
   * Ship ID received from the server's player_boarded or module_interact_success message.
   * Used to accept cannon_group_state packets that arrive before the world-state tick
   * has updated the player's carrierId (the boarding/mount event runs in the same tick
   * as the group-state push, so carrierId is 0 or stale when the message is processed).
   * Cleared once the group state has been applied or when carrierId catches up.
   */
  private pendingGroupShipId: number = 0;
  /** Maps group index → previous mode, saved while right-click-hold temporarily switches all selected groups to 'aiming'. */
  private _aimOverrideGroups: Map<number, WeaponGroupMode> | null = null;
  // Optimistic modules placed locally, keyed by ship ID, with expiry timestamp.
  // Overlaid on top of worldToRender every frame so they appear in online mode.
  private localPendingModules = new Map<number, { module: ShipModule; expiry: number }[]>();
  
  // Timing
  private running = false;
  private lastFrameTime = 0;
  /** Timestamp (ms) of the last sword attack sent to the server — enforces client-side cooldown matching the server's 600ms. */
  private lastSwordSwingMs = 0;
  private readonly SWORD_COOLDOWN_MS = 1000; // matches server SWORD_COOLDOWN_MS
  /** Timestamp (ms) of the last punch sent to the server — enforces client-side cooldown. */
  private lastPunchMs = 0;
  private readonly PUNCH_COOLDOWN_MS = 800; // matches server PUNCH_COOLDOWN_MS
  private lastAxeMs = 0;
  private readonly AXE_COOLDOWN_MS = 1000; // matches server AXE_COOLDOWN_MS
  private lastPickaxeMs = 0;
  private readonly PICKAXE_COOLDOWN_MS = 1200; // matches server PICKAXE_COOLDOWN_MS
  /** True when combat mode is active (toggled with Z, or auto-enabled on first attack). */
  private combatMode = false;
  /** Timestamp of last combat action — used for the 10 s auto-disable timer. */
  private lastCombatActionMs = 0;

  // ── Camera mode state ─────────────────────────────────────────────────
  /** True while free-camera mode is active (middle-mouse toggled). */
  private _freeCameraMode = false;
  /** True while rotate-camera mode is active (Shift + middle-mouse held). */
  private _rotateCamActive = false;
  /** Camera rotation target — lerped toward each frame. */
  private _cameraRotationTarget = 0;
  // ── Ship debug panel ────────────────────────────────────────────────────
  private _shipDebugPanel: HTMLDivElement | null = null;
  private _shipDebugTableBody: HTMLTableSectionElement | null = null;

  /** E-hold interaction state — covers ladders and mountable modules. */
  private _ladderHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private _suppressLadderInteract = false;
  private _ladderHoldModuleId: number | null = null;
  private _ladderHoldIsExtended = false;
  /** True if player was on the ladder's ship when E was pressed. */
  private _ladderHoldOnShip = false;
  /** What kind of module the current E-hold targets: 'ladder' | 'module' | 'mount' | 'npc' | 'structure' | null */
  private _interactKind: 'ladder' | 'module' | 'mount' | 'npc' | 'structure' | null = null;
  /** Placed-structure id locked in at E-keydown for the structure interact path. */
  private _hoveredStructureId: number | null = null;
  /** Type of the locked-in structure ('wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door'). */
  private _hoveredStructureType: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wreck' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'claim_flag' | 'company_fortress' | null = null;
  /** True when the E-hold was started while the player was already mounted (dismount path). */
  private _ladderHoldWasMounted = false;
  /** Ship ID that owns the locked-in module (for keyup range validation). */
  private _ladderHoldShipId: number | null = null;
  /** NPC id locked in at E-keydown for the NPC radial interact path. */
  private _npcInteractId: number | null = null;
  /** Hold-E timer: timestamp (ms) when E was pressed near a dropped-item pile; -1 when not pending. */
  private _holdEDropTimer = -1;
  /** NPC id for the pending "Move To" targeting mode (ctrl+click → Move To → click module). */
  private _moveToNpcId: number | null = null;
  /** Multiple NPCs selected via Ctrl+drag box — all move together on next click. */
  private _selectedNpcIds: number[] = [];
  /** NPC IDs whose command-ignore flag is set (client-side only).  Ctrl+right-click toggles. */
  private _npcIgnoreSet = new Set<number>();
  /** Screen-space position to flash once the server confirms (or rejects) a goto-module command. */
  private _pendingModuleFlashPos: Vec2 | null = null;
  /** Generic radial action menu instance (rendered by RenderSystem). */
  private _radialMenu = new RadialMenu();
  /** Crafting panel opened when the player presses E near a workbench. */
  private craftingMenu = new CraftingMenu();
  /** Ship construction panel opened when the player presses E at a shipyard. */
  private shipyardMenu = new ShipyardMenu();
  /** Custom rename dialog — replaces window.prompt() for ship naming. */
  private renameDialog!: ShipRenameDialog;
  /** Pause overlay — opened by Escape / ` / P when no other menu is up. */
  private pauseMenu = new PauseMenu();
  /** Terminal command bar — opened by / when no other menu is up. */
  private commandConsole = new CommandConsole();
  /** Dev tool for editing island polygon layers — opened via /islandEditor. */
  private islandEditor: IslandEditor | null = null;
  /** True when the player's active slot is wooden_floor or workbench on an island. */
  private islandBuildMode = false;
  /** When true, renders the territory claim overlay (Alt key held). */
  private showTerritoryOverlay = false;
  private accumulator = 0;
  private readonly clientTickDuration: number; // milliseconds per client tick
  
  // Performance Tracking
  private frameCount = 0;
  private fpsTimer = 0;
  private currentFPS = 0;
  private lastRenderLogTime = 0;
  /** Timestamp (ms) of the last sword swing, for cursor cooldown ring. */
  private swordLastAttackMs = 0;
  
  // Loading overlay DOM state
  private _loadingOverlay: HTMLElement | null = null;
  private _loadingBar: HTMLElement | null = null;
  private _loadingSteps: Array<HTMLElement | null> = [];
  private _loadingShownAt = 0;
  private _loadingHidden = false;
  private static readonly LOADING_MIN_MS = 2000; // minimum time overlay is visible
  /** Timestamp (ms) when we entered CONNECTED state — used for loading fallback timeout. */
  private _loadingConnectedAt = 0;
  /** Set true when the server sends {type:"ack"} — the real ready-to-play signal. */
  private _playerAckReceived = false;
  /** Max ms to wait for the server ack before forcing past loading screen. */
  private static readonly LOADING_PLAYER_TIMEOUT_MS = 10000;

  constructor(canvas: HTMLCanvasElement, config: ClientConfig) {
    this.canvas = canvas;
    this.config = config;
    this.clientTickDuration = 1000 / config.prediction.clientTickRate; // e.g., ~8.33ms for 120Hz

    this._loadingOverlay = document.getElementById('loading-overlay');
    this._loadingBar = document.getElementById('loading-bar');
    this._loadingSteps = [
      document.getElementById('step-init'),
      document.getElementById('step-connect'),
      document.getElementById('step-world'),
      document.getElementById('step-enter'),
    ];
    this._loadingShownAt = Date.now();

    console.log(`🎮 Client initialized with ${config.prediction.clientTickRate}Hz tick rate`);
  }

  /** Advance the loading overlay to the given step index (0–3) and update the progress bar. */
  private setLoadingStep(step: number): void {
    if (!this._loadingOverlay || this._loadingHidden) return;
    const pct = [10, 35, 60, 90][step] ?? 100;
    if (this._loadingBar) this._loadingBar.style.width = `${pct}%`;

    this._loadingSteps.forEach((el, i) => {
      if (!el) return;
      const icon = el.querySelector('.step-icon') as HTMLElement | null;
      if (i < step) {
        el.classList.add('done');
        el.classList.remove('active');
        if (icon) icon.textContent = '✓';
      } else if (i === step) {
        el.classList.add('active');
        el.classList.remove('done');
        if (icon) icon.innerHTML = '<span class="step-spinner"></span>';
      } else {
        el.classList.remove('active', 'done');
        if (icon) icon.textContent = '⏳';
      }
    });
  }

  /** Fade out then hide the loading overlay. Respects minimum display time. Idempotent. */
  private hideLoadingOverlay(): void {
    if (this._loadingHidden) return;
    this._loadingHidden = true;

    const overlay = this._loadingOverlay;
    if (!overlay) return;

    // Mark all steps done
    if (this._loadingBar) this._loadingBar.style.width = '100%';
    this._loadingSteps.forEach(el => {
      if (!el) return;
      el.classList.add('done');
      el.classList.remove('active');
      const icon = el.querySelector('.step-icon') as HTMLElement | null;
      if (icon) icon.textContent = '✓';
    });

    const elapsed = Date.now() - this._loadingShownAt;
    const delay = Math.max(0, ClientApplication.LOADING_MIN_MS - elapsed) + 300;

    setTimeout(() => {
      overlay.classList.add('fade-out');
      overlay.addEventListener('transitionend', () => {
        overlay.classList.add('hidden');
      }, { once: true });
    }, delay);
  }
  
  /**
   * Initialize all client systems
   */
  async initialize(): Promise<void> {
    try {
      this.state = ClientState.INITIALIZING;
      this.setLoadingStep(0);
      console.log('⚡ Initializing client systems...');
      
      // Initialize Camera first (needed by other systems)
      this.camera = new Camera(
        { width: this.canvas.width, height: this.canvas.height },
        { position: Vec2.from(600, 400), zoom: 1.0, rotation: 0 }
      );
      
      // Initialize Graphics System
      this.renderSystem = new RenderSystem(this.canvas, this.config.graphics);
      await this.renderSystem.initialize();
      this.renderSystem.setRadialMenu(this._radialMenu);

      // Initialize rename dialog (needs canvas to position the HTML input overlay)
      this.renameDialog = new ShipRenameDialog(this.canvas);
      this.renameDialog.onConfirm = (shipId, name) => {
        this.networkManager.sendRenameShip(shipId, name);
      };

      // Initialize WebGL2 world renderer (dual-canvas setup)
      if (this.config.graphics.useWebGL2) {
        try {
          const glCanvas = document.createElement('canvas');
          // Render below native resolution to reduce ocean shader fill-rate cost.
          glCanvas.width  = Math.ceil(this.canvas.width  * this._glScale);
          glCanvas.height = Math.ceil(this.canvas.height * this._glScale);
          glCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;image-rendering:auto;';
          this.canvas.style.position = 'absolute';
          this.canvas.style.background = 'transparent';
          this.canvas.parentElement?.insertBefore(glCanvas, this.canvas);
          const glCtx = GLContext.create(glCanvas);
          if (!glCtx) throw new Error('WebGL2 context creation failed');
          this._glCanvas  = glCanvas;
          this._glRenderer = new GLWorldRenderer(glCtx);
          this.renderSystem.setGLRenderer(this._glRenderer);
          // Keep GL canvas pixel dimensions in sync on resize and scale changes.
          this.applyGLCanvasScale();
          window.addEventListener('resize', () => this.applyGLCanvasScale());
          console.log(`✅ WebGL2 world renderer initialized (${Math.round(this._glScale * 100)}% scale)`);
        } catch (e) {
          console.warn('[GL] WebGL2 init failed, falling back to Canvas 2D:', e);
          this._glCanvas?.remove();
          this._glCanvas   = null;
          this._glRenderer = null;
        }
      }
      
      // Initialize Network System
      this.networkManager = new NetworkManager(this.config.network);
      this.networkManager.setWorldStateHandler(this.onServerWorldState.bind(this));
      this.networkManager.setConnectionStateHandler(this.onConnectionStateChanged.bind(this));
      this.networkManager.onPlayerAck = () => {
        this._playerAckReceived = true;
        if (this.state === ClientState.CONNECTED) {
          this.state = ClientState.IN_GAME;
          this.setLoadingStep(3);
          this.hideLoadingOverlay();
          console.log('🎮 Entered game world (server ack)');
        }
      };
      
      // Module mounting callbacks
      this.networkManager.onModuleMountSuccess = (moduleId, moduleKind, mountOffset) => {
        this.handleModuleMountSuccess(moduleId, moduleKind, mountOffset);
      };
      this.networkManager.onModuleMountFailure = (reason) => {
        this.handleModuleMountFailure(reason);
      };
      this.networkManager.onIslandCannonMounted = (structureId, aimAngle, _reloadMs, mountX, mountY, facingAngle) => {
        console.log(`🎯 [ISLAND CANNON] Mounted to island cannon ${structureId} at (${mountX.toFixed(1)}, ${mountY.toFixed(1)})`);
        // Store world mount position so the pendingMount loop re-applies it every
        // frame until the server's world-state echo confirms isMounted=true.
        const mountPos = Vec2.from(mountX, mountY);
        this.pendingMount = { moduleId: structureId, moduleKind: 'CANNON', mountWorldPos: mountPos };
        // Enable aim/fire controls (no shipId — island cannon is not on a ship).
        // Pass initial aim and facing angle so clamping and barrel rendering start correctly.
        this.inputManager?.setMountState(true, undefined, 'CANNON', structureId, undefined, aimAngle, facingAngle);
      };
      this.networkManager.onIslandCannonAimSync = (structureId, aimAngle) => {
        this.inputManager?.syncIslandCannonAim(structureId, aimAngle);
        // Keep the world-state structure in sync so the fallback renderer
        // always has the latest server-confirmed angle (important after dismount).
        this.renderSystem.updateStructureCannonAim(structureId, aimAngle);
      };
      this.networkManager.onStructureReload = (structureId, reloadMs, loadedAmmo) => {
        this.renderSystem.updateStructureCannonReload(structureId, reloadMs, loadedAmmo);
        // When the server confirms reload is done, commit the loaded ammo type
        // so the aim guide switches to the newly loaded ammo.
        if (reloadMs === 0 && this.inputManager?.isOnIslandCannon &&
            this.inputManager.mountedCannonModuleId === structureId) {
          this.inputManager.loadedAmmoType = loadedAmmo;
        }
      };
      this.networkManager.onNoAmmo = () => {
        // Show floating "No cannonballs!" warning at the player's current position
        const assignedId = this.networkManager.getAssignedPlayerId();
        const ws = this.predictedWorldState || this.authoritativeWorldState;
        const player = assignedId !== null ? ws?.players.find(p => p.id === assignedId) : ws?.players[0];
        const pos = player?.position ?? Vec2.from(0, 0);
        this.renderSystem.spawnResourcePickup(pos, 'No cannonballs!', '#ff4444');
      };
      this.networkManager.onModuleDestroyed = (shipId, moduleId, damage, hitX, hitY) => {
        // Spawn a kill damage number at the hit location
        // Prefer server-provided hit coords; fall back to module world position
        let worldX: number | null = (hitX !== undefined) ? hitX : null;
        let worldY: number | null = (hitY !== undefined) ? hitY : null;

        const ws = this.authoritativeWorldState || this.predictedWorldState;
        if (ws) {
          const ship = ws.ships.find(s => s.id === shipId);
          if (ship && (worldX === null || worldY === null)) {
            const mod = ship.modules.find(m => m.id === moduleId);
            const lx = mod?.localPos.x ?? 0;
            const ly = mod?.localPos.y ?? 0;
            const cos = Math.cos(ship.rotation);
            const sin = Math.sin(ship.rotation);
            worldX = ship.position.x + lx * cos - ly * sin;
            worldY = ship.position.y + lx * sin + ly * cos;
          }
        }

        if (worldX !== null && worldY !== null) {
          // Determine team: hit ship same company as local → we took damage (enemy), else we dealt it (friendly)
          const _dWs = this.authoritativeWorldState ?? this.predictedWorldState;
          const _dMyId = this.networkManager.getAssignedPlayerId();
          const _dMyComp = _dMyId !== null ? (_dWs?.players.find(p => p.id === _dMyId)?.companyId ?? -1) : -1;
          const _dHitComp = _dWs?.ships.find(s => s.id === shipId)?.companyId ?? -1;
          const _dTeam: DamageTeam =
            _dMyComp > 0 && _dHitComp === _dMyComp ? 'enemy' : 'friendly';
          this.renderSystem.spawnDamageNumber(Vec2.from(worldX, worldY), damage || 3000, true, _dTeam);
          // Mast destroyed: big sail-shred burst
          const ws2 = this.authoritativeWorldState || this.predictedWorldState;
          const hitShip = ws2?.ships.find(s => s.id === shipId);
          const hitMod  = hitShip?.modules.find(m => m.id === moduleId);
          if (hitMod?.kind === 'mast') {
            this.renderSystem.spawnSailFiberEffect(Vec2.from(worldX, worldY), 2.0);
          }
          // Hull/plank or cannon destruction: big explosion burst
          if (hitMod?.kind === 'plank' || hitMod?.kind === 'cannon') {
            this.renderSystem.spawnExplosion(Vec2.from(worldX, worldY), 1.2);
          }
        }

        // Remove the destroyed module immediately from world state so it disappears
        // before the next GAME_STATE update arrives
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const ship = ws.ships.find(s => s.id === shipId);
          if (ship) {
            ship.modules = ship.modules.filter(m => m.id !== moduleId);
          }
        }
      };
      this.networkManager.onModuleDamaged = (shipId, moduleId, damage, hitX, hitY) => {
        // Visual effects only — health is authoritative from server GAME_STATE updates
        console.log(`🎨 onModuleDamaged callback: ship ${shipId} module ${moduleId} damage ${damage} at (${hitX}, ${hitY})`);
        let worldX: number | null = (hitX !== undefined) ? hitX : null;
        let worldY: number | null = (hitY !== undefined) ? hitY : null;

        const ws = this.authoritativeWorldState || this.predictedWorldState;
        if (worldX === null || worldY === null) {
          const ship = ws?.ships.find(s => s.id === shipId);
          const mod  = ship?.modules.find(m => m.id === moduleId);
          if (ship) {
            const lx = mod?.localPos.x ?? 0;
            const ly = mod?.localPos.y ?? 0;
            const cos = Math.cos(ship.rotation);
            const sin = Math.sin(ship.rotation);
            worldX = ship.position.x + lx * cos - ly * sin;
            worldY = ship.position.y + lx * sin + ly * cos;
          }
        }

        if (worldX !== null && worldY !== null) {
          // Determine team: hit ship same company as local → we took damage (enemy), else we dealt it (friendly)
          const _mdWs = this.authoritativeWorldState ?? this.predictedWorldState;
          const _mdMyId = this.networkManager.getAssignedPlayerId();
          const _mdMyComp = _mdMyId !== null ? (_mdWs?.players.find(p => p.id === _mdMyId)?.companyId ?? -1) : -1;
          const _mdHitComp = _mdWs?.ships.find(s => s.id === shipId)?.companyId ?? -1;
          const _mdTeam: DamageTeam =
            _mdMyComp > 0 && _mdHitComp === _mdMyComp ? 'enemy' : 'friendly';
          this.renderSystem.spawnDamageNumber(Vec2.from(worldX, worldY), damage, false, _mdTeam);
          // Impact explosion for hull/plank and cannon hits
          const hitShipDmg = ws?.ships.find(s => s.id === shipId);
          const hitModDmg  = hitShipDmg?.modules.find(m => m.id === moduleId);
          // moduleId === 0 → direct hull hit (no specific module); always show explosion
          if (moduleId === 0 || hitModDmg?.kind === 'plank' || hitModDmg?.kind === 'cannon') {
            this.renderSystem.spawnExplosion(Vec2.from(worldX, worldY), 0.5);
          }
          // If the hit module is a mast, spawn sail fiber shred particles
          const ship = ws?.ships.find(s => s.id === shipId);
          const mod  = ship?.modules.find(m => m.id === moduleId);
          if (mod?.kind === 'mast') {
            this.renderSystem.spawnSailFiberEffect(Vec2.from(worldX, worldY), 0.7);
          }
        }
      };
      this.networkManager.onShipSunk = (shipId) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          ws.ships = ws.ships.filter(s => s.id !== shipId);
        }
      };

      this.networkManager.onModuleDemolished = (shipId, moduleId) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const ship = ws.ships.find(s => s.id === shipId);
          if (ship) ship.modules = ship.modules.filter(m => m.id !== moduleId);
        }
        this.renderSystem.showAnnouncement('🪓 Module demolished', 'info', 2.0);
      };
      this.networkManager.onShipSinking = (shipId) => {
        // Trigger the client-side fade animation immediately when the server enters sinking state
        this.renderSystem.markShipSinking(shipId);

        // Single declaration shared by announcement and dismount logic
        const myPlayerId = this.networkManager.getAssignedPlayerId();

        // Announcement banner — distinguish own ship vs enemy
        const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        const myPlayer    = myPlayerId !== null ? ws?.players.find(p => p.id === myPlayerId) : null;
        const sinkingShip = ws?.ships.find(s => s.id === shipId);
        if (sinkingShip) {
          const dynCompanies = ws?.companies ?? [];
          const shipDisplayName = (s: Ship) =>
            s.shipName || 'Brigantine';
          const sinkLabel  = shipDisplayName(sinkingShip);
          const isOwnShip  = myPlayer?.carrierId === shipId;
          if (isOwnShip) {
            const attackerId = this.renderSystem.getLastAttackerOf(shipId);
            const attacker   = attackerId !== null ? ws?.ships.find(s => s.id === attackerId) : null;
            const msg = attacker
              ? `Your ${sinkLabel} was sunk by ${shipDisplayName(attacker)}`
              : `Your ${sinkLabel} was sunk!`;
            this.renderSystem.showAnnouncement(msg, 'ship_sink', 4.0);
          } else {
            const myShip  = myPlayer?.carrierId ? ws?.ships.find(s => s.id === myPlayer!.carrierId) : null;
            const myLabel = myShip ? shipDisplayName(myShip) : 'Our ship';
            this.renderSystem.showAnnouncement(`${myLabel} sunk ${sinkLabel}`, 'ship_sink', 4.0);
          }
        }

        // Dismount the local player only if they were on THIS sinking ship
        if (myPlayerId !== null) {
          let wasOnSinkingShip = false;
          for (const wsState of [this.authoritativeWorldState, this.predictedWorldState]) {
            if (!wsState) continue;
            const me = wsState.players.find(p => p.id === myPlayerId);
            if (me && me.carrierId === shipId) {
              me.isMounted = false;
              me.mountedModuleId = undefined;
              wasOnSinkingShip = true;
            }
          }
          if (wasOnSinkingShip && this.inputManager) {
            this.inputManager.setMountState(false);
          }
        }
      };
      this.networkManager.onShipLevelUp = (shipId, attribute, attrLevel, xp, shipLevel, totalCap, nextUpgradeCost) => {
        const attrNames = ['weight', 'resistance', 'damage', 'crew', 'sturdiness'];
        const attrIdx = attrNames.indexOf(attribute);
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const ship = ws.ships.find(s => s.id === shipId);
          if (!ship?.levelStats) continue;
          if (attrIdx >= 0) ship.levelStats.levels[attrIdx] = attrLevel;
          ship.levelStats.xp              = xp;
          ship.levelStats.shipLevel       = shipLevel;
          ship.levelStats.totalCap        = totalCap;
          ship.levelStats.nextUpgradeCost = nextUpgradeCost;
        }
      };

      this.networkManager.onShipUnclaimed = (shipId) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const ship = ws.ships.find(s => s.id === shipId);
          if (ship) ship.companyId = 0; // COMPANY_UNCLAIMED
          // NPCs and players keep their own company — NOT reset here
        }
        console.log(`⚓ Ship ${shipId} unclaimed`);
      };

      this.networkManager.onShipClaimed = (shipId, companyId) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const ship = ws.ships.find(s => s.id === shipId);
          if (ship) ship.companyId = companyId;
        }
        console.log(`⚓ Ship ${shipId} claimed — company ${companyId}`);
      };

      this.networkManager.onShipRenamed = (shipId, name) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const ship = ws.ships.find(s => s.id === shipId);
          if (ship) ship.shipName = name;
        }
      };

      this.networkManager.onNpcUnclaimed = (npcId) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const npc = ws.npcs.find(n => n.id === npcId);
          if (npc) npc.companyId = 0; // COMPANY_UNCLAIMED
        }
        // Clear any client-side ignore state for this NPC
        this._npcIgnoreSet.delete(npcId);
        console.log(`⚓ NPC ${npcId} unclaimed`);
      };

      // Append newly created dynamic company to local world state
      this.networkManager.onCompanyCreated = (company) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          if (!ws.companies.find(c => c.id === company.id)) {
            ws.companies.push(company);
          }
        }
        console.log(`🏴 Company created: "${company.name}" (id=${company.id})`);
      };

      // When the server confirms a ladder board, record the ship ID so that the
      // cannon_group_state that follows can be accepted before the world-state tick
      // updates the player's carrierId.
      this.networkManager.onPlayerBoarded = (shipId) => {
        this.pendingGroupShipId = shipId;
      };

      this.networkManager.onHarvestResult = (success, wood, reason) => {
        const _ws0 = this.authoritativeWorldState ?? this.predictedWorldState;
        const _id0 = this.networkManager.getAssignedPlayerId();
        const _me0 = _id0 !== null && _ws0 ? _ws0.players.find(p => p.id === _id0) : null;
        if (success) {
          if (_me0) this.renderSystem.spawnResourcePickup(_me0.position, `+${wood} wood`, '#c8a060');
        } else if (reason === 'no_stamina') {
          if (_me0) this.renderSystem.spawnResourcePickup(_me0.position, 'Out of stamina!', '#e05050');
        }
      };

      this.networkManager.onFiberHarvestResult = (success, fiber, reason, wood) => {
        const _ws1 = this.authoritativeWorldState ?? this.predictedWorldState;
        const _id1 = this.networkManager.getAssignedPlayerId();
        const _me1 = _id1 !== null && _ws1 ? _ws1.players.find(p => p.id === _id1) : null;
        if (success) {
          if (_me1) {
            this.renderSystem.spawnResourcePickup(_me1.position, `+${fiber} fiber`, '#60c870');
            if (wood) this.renderSystem.spawnResourcePickup(_me1.position.add(Vec2.from(0, -20)), `+${wood} wood`, '#c8a060');
          }
        } else if (reason === 'no_stamina') {
          if (_me1) this.renderSystem.spawnResourcePickup(_me1.position, 'Out of stamina!', '#e05050');
        }
      };

      this.networkManager.onRockHarvestResult = (success, metal, reason) => {
        const ws = this.authoritativeWorldState ?? this.predictedWorldState;
        const myId = this.networkManager.getAssignedPlayerId();
        const me = myId !== null && ws ? ws.players.find(p => p.id === myId) : null;
        if (success) {
          if (me) this.renderSystem.spawnResourcePickup(me.position, `+${metal} metal`, '#a0d8ff');
        } else if (reason === 'no_stamina') {
          if (me) this.renderSystem.spawnResourcePickup(me.position, 'Out of stamina!', '#e05050');
        }
      };

      this.networkManager.onStoneHarvestResult = (success, stone, reason) => {
        const _ws3 = this.authoritativeWorldState ?? this.predictedWorldState;
        const _id3 = this.networkManager.getAssignedPlayerId();
        const _me3 = _id3 !== null && _ws3 ? _ws3.players.find(p => p.id === _id3) : null;
        if (success) {
          if (_me3) this.renderSystem.spawnResourcePickup(_me3.position, `+${stone} stone`, '#b0b8c0');
        } else if (reason === 'no_stamina') {
          if (_me3) this.renderSystem.spawnResourcePickup(_me3.position, 'Out of stamina!', '#e05050');
        }
      };

      this.networkManager.onBoulderHarvestResult = (success, metal, stone, reason) => {
        const ws = this.authoritativeWorldState ?? this.predictedWorldState;
        const myId = this.networkManager.getAssignedPlayerId();
        const me = myId !== null && ws ? ws.players.find(p => p.id === myId) : null;
        if (success) {
          if (me && metal > 0) this.renderSystem.spawnResourcePickup(me.position, `+${metal} metal`, '#a0d8ff');
          if (me && stone > 0) this.renderSystem.spawnResourcePickup(me.position, `+${stone} stone`, '#c8b89a');
        } else if (reason === 'no_stamina') {
          if (me) this.renderSystem.spawnResourcePickup(me.position, 'Out of stamina!', '#e05050');
        }
      };

      this.networkManager.onNoStamina = () => {
        const _wsS = this.authoritativeWorldState ?? this.predictedWorldState;
        const _idS = this.networkManager.getAssignedPlayerId();
        const _meS = _idS !== null && _wsS ? _wsS.players.find(p => p.id === _idS) : null;
        if (_meS) this.renderSystem.spawnResourcePickup(_meS.position, 'Out of stamina!', '#e05050');
      };

      // Authoritative per-ship weapon group state from server
      this.networkManager.onCannonGroupState = (shipId, groups) => {
        // Resolve the player's current ship from the world state.
        const myPlayerId = this.networkManager.getAssignedPlayerId();
        const ws = this.authoritativeWorldState;
        const myPlayer = myPlayerId !== null && ws ? ws.players.find(p => p.id === myPlayerId) : null;
        const myShipId = myPlayer?.carrierId ?? 0;

        // Accept the message if:
        //  (a) the world state already reflects the player on this ship, OR
        //  (b) the player just boarded/mounted and the world tick hasn't caught up yet
        //      (pendingGroupShipId is set by the player_boarded handler above).
        const isMyShip = shipId !== 0 && (shipId === myShipId || shipId === this.pendingGroupShipId);
        if (!isMyShip) return;

        // Clear the pending flag — we've now applied the authoritative state.
        if (shipId === this.pendingGroupShipId) this.pendingGroupShipId = 0;

        for (const g of groups) {
          this.controlGroups.set(g.index, {
            mode: g.mode as WeaponGroupMode,
            cannonIds: g.cannonIds,
            targetId: g.targetShipId,
          });
        }

        // If an aim override is currently active (player is holding right-click),
        // re-apply the temporary 'aiming' mode for any group that was overridden.
        // Without this, a partial echo from the server (sent after processing the
        // first group-config message but before the second) would reset the second
        // group back to its previous mode, causing only the first group to aim.
        if (this._aimOverrideGroups) {
          for (const [g] of this._aimOverrideGroups) {
            const state = this.controlGroups.get(g);
            if (state) state.mode = 'aiming';
          }
        }

        // Sync InputManager's activeGroupMode to the primary selected group
        if (this.inputManager) {
          const primaryState = this.controlGroups.get(this.inputManager.activeWeaponGroup);
          if (primaryState) this.inputManager.activeGroupMode = primaryState.mode;
        }
      };

      // Initialize Prediction Engine
      this.predictionEngine = new PredictionEngine(this.config.prediction);
      this.shipPredictor = new ShipPredictor();
      
      // Initialize Input System
      this.inputManager = new InputManager(this.canvas, this.config.input);
      this.inputManager.onInputFrame = this.onInputFrame.bind(this);
      
      // HYBRID PROTOCOL: Wire up state change callbacks
      this.inputManager.onMovementStateChange = (movement, isMoving, isSprinting) => {
        this.networkManager.sendMovementState(movement, isMoving, isSprinting);
      };
      this.inputManager.onRotationUpdate = (rotation) => {
        this.networkManager.sendRotationUpdate(rotation);
      };
      this.inputManager.onActionEvent = (action, target) => {
        // ── Move To targeting mode — intercept the next left-click to dispatch an NPC ──
        if (action === 'attack' && this._moveToNpcId !== null) {
          const moveNpcId = this._moveToNpcId;
          this._moveToNpcId = null;
          this.renderSystem.clearMoveToHint(); // also clears _moveToSourceNpcId

          const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const flashPos = this.inputManager.getMouseScreenPosition();

          // Priority 1: specific module hovered — most precise command
          // Flash is deferred: server checks occupancy and responds with ok/reject.
          const hovMod = this.renderSystem.getHoveredModule();
          if (hovMod) {
            this._pendingModuleFlashPos = flashPos;
            this.networkManager.sendNpcGotoModule(moveNpcId, hovMod.module.id);
            console.log(`📍 NPC ${moveNpcId} → module ${hovMod.module.id}`);
            return;
          }

          // Priority 2: click landed on a ship hull (board / walk to deck position)
          if (target && ws) {
            const targetShip = this.findShipAtWorldPos(target, ws);
            if (targetShip) {
              this.networkManager.sendNpcMoveToPos(moveNpcId, target.x, target.y, targetShip.id);
              this.renderSystem.flashInteract(flashPos);
              console.log(`📍 NPC ${moveNpcId} → ship ${targetShip.id} @ (${target.x.toFixed(0)}, ${target.y.toFixed(0)})`);
              return;
            }
          }

          // Priority 3: open-water / world position (also disembarks if NPC is on a ship)
          if (target) {
            this.networkManager.sendNpcMoveToPos(moveNpcId, target.x, target.y, 0);
            this.renderSystem.flashInteract(flashPos);
            console.log(`🌊 NPC ${moveNpcId} → world (${target.x.toFixed(0)}, ${target.y.toFixed(0)})`);
            return;
          }

          // Fallback: no target position (shouldn’t happen but guard anyway)
          this.renderSystem.flashCancel(flashPos);
          return;
        }

        // ── Multi-NPC box-select move ──
        if (action === 'attack' && this._selectedNpcIds.length > 0) {
          const ids = [...this._selectedNpcIds];
          this._selectedNpcIds = [];
          this.renderSystem.selectedNpcIds = new Set();
          this.renderSystem.clearMoveToHint();
          const flashPos = this.inputManager.getMouseScreenPosition();
          if (!target) { this.renderSystem.flashCancel(flashPos); return; }

          const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const targetShip = ws ? this.findShipAtWorldPos(target, ws) : null;
          const shipId = targetShip?.id ?? 0;

          const spread = ids.length > 1 ? Math.min(20 * (ids.length - 1), 80) : 0;
          for (let i = 0; i < ids.length; i++) {
            const angle = (2 * Math.PI * i) / ids.length;
            this.networkManager.sendNpcMoveToPos(ids[i],
              target.x + Math.cos(angle) * spread,
              target.y + Math.sin(angle) * spread, shipId);
          }
          this.renderSystem.flashInteract(flashPos);
          if (shipId) {
            console.log(`⚓ ${ids.length} NPCs → ship ${shipId} @ (${target.x.toFixed(0)}, ${target.y.toFixed(0)})`);
          } else {
            console.log(`🌊 ${ids.length} NPCs → world (${target.x.toFixed(0)}, ${target.y.toFixed(0)})`);
          }
          return;
        }

        // Hammer tool: left-click on hovered module while holding hammer → minigame
        if (action === 'attack') {
          const playerId = this.networkManager.getAssignedPlayerId();
          const worldState = this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
          const player = playerId !== null ? worldState?.players.find(p => p.id === playerId) : null;
          const activeSlot = player?.inventory?.activeSlot ?? 0;
          const activeItem = player?.inventory?.slots[activeSlot]?.item ?? 'none';

          if (activeItem === 'hammer' && player && player.carrierId !== 0) {
            const hoveredForHammer = this.renderSystem.getHoveredModule();
            if (!hoveredForHammer) {
              // No specific module hovered — check if click landed on the ship hull for deck repair
              const playerShip = worldState?.ships.find(s => s.id === player.carrierId);
              if (playerShip && playerShip.hull && target) {
                const dx = target.x - playerShip.position.x;
                const dy = target.y - playerShip.position.y;
                const cos = Math.cos(-playerShip.rotation);
                const sin = Math.sin(-playerShip.rotation);
                const localClick = Vec2.from(dx * cos - dy * sin, dx * sin + dy * cos);
                if (PolygonUtils.pointInPolygon(localClick, playerShip.hull, 8)) {
                  const repairable = playerShip.modules.filter(m => m.kind === 'plank' || m.kind === 'deck');
                  const damaged = repairable.filter(m => {
                    const md = m.moduleData as any;
                    if (!md) return false;
                    // For planks, repairable means below target HP (not max HP)
                    const cap = m.kind === 'plank'
                      ? (md.targetHealth ?? md.maxHealth ?? 0)
                      : (md.maxHealth ?? 0);
                    return md.health < cap;
                  });
                  if (damaged.length === 0) {
                    console.log('🔨 [HAMMER] All planks and deck are at full health');
                    return;
                  }
                  const worstPlank = damaged.reduce((worst, m) => {
                    const wmd = worst.moduleData as any;
                    const cmd = m.moduleData as any;
                    return (cmd?.health ?? 0) / (cmd?.maxHealth ?? 1) < (wmd?.health ?? 0) / (wmd?.maxHealth ?? 1)
                      ? m : worst;
                  });
                  this.uiManager?.startHammerMinigame((won) => {
                    if (won) this.networkManager.sendUseHammer(player!.carrierId, worstPlank.id);
                  });
                  return;
                }
              }
              console.log('🔨 [HAMMER] No module hovered — aim at a module or click the deck to repair');
              return;
            }
            // Proximity check
            let hammerDist: number;
            if (player.carrierId === hoveredForHammer.ship.id && player.localPosition) {
              hammerDist = player.localPosition.sub(hoveredForHammer.module.localPos).length();
            } else {
              const cos = Math.cos(hoveredForHammer.ship.rotation);
              const sin = Math.sin(hoveredForHammer.ship.rotation);
              const wx = hoveredForHammer.ship.position.x
                + hoveredForHammer.module.localPos.x * cos - hoveredForHammer.module.localPos.y * sin;
              const wy = hoveredForHammer.ship.position.y
                + hoveredForHammer.module.localPos.x * sin + hoveredForHammer.module.localPos.y * cos;
              hammerDist = player.position.sub(Vec2.from(wx, wy)).length();
            }
            if (hammerDist > 50) {
              console.log(`🔨 [HAMMER] Module too far (${hammerDist.toFixed(1)}px) — get closer`);
              return;
            }
            const shipId   = hoveredForHammer.ship.id;
            const moduleId = hoveredForHammer.module.id;
            // Don't start the minigame if the module is already at its repair ceiling
            const md = hoveredForHammer.module.moduleData as any;
            const repairCap = md?.targetHealth ?? md?.maxHealth ?? 0;
            const poleFullHealth  = !md || md.health >= repairCap;
            const fiberFullHealth = hoveredForHammer.module.kind !== 'mast'
              || (md?.fiberHealth ?? 0) >= (md?.fiberMaxHealth ?? 0);
            if (poleFullHealth && fiberFullHealth) {
              console.log('🔨 [HAMMER] Module is already at its repair ceiling (use wood to raise target HP)');
              return;
            }
            this.uiManager?.startHammerMinigame((won) => {
              if (won) this.networkManager.sendUseHammer(shipId, moduleId);
            });
            return;
          }
          // Not a hammer click — check for sword
          if (activeItem === 'sword' && player && !player.isMounted) {
            const now = performance.now();
            if (now - this.swordLastAttackMs < this.SWORD_COOLDOWN_MS) return;
            if (!this.combatMode) {
              this.combatMode = true;
              this.lastCombatActionMs = now;
              return; // enable combat mode; the next click will swing
            }
            this.swordLastAttackMs = now;
            this.lastCombatActionMs = now;
            const dir = target
              ? Math.atan2(target.y - player.position.y, target.x - player.position.x)
              : player.rotation;
            this.networkManager.sendAction(action, target);
            // Optimistic local arc (appears immediately without waiting for server)
            this.renderSystem.spawnSwordArc(player.position, dir);
            // Start cooldown ring around cursor (visual, matches server cooldown)
            this.renderSystem.notifySwordSwing(this.SWORD_COOLDOWN_MS);
            return;
          }
          // Axe attack
          if (activeItem === 'axe' && player && !player.isMounted) {
            const now = performance.now();
            if (now - this.lastAxeMs < this.AXE_COOLDOWN_MS) return;
            if (!this.combatMode) {
              this.combatMode = true;
              this.lastCombatActionMs = now;
              return;
            }
            this.lastAxeMs = now;
            this.lastCombatActionMs = now;
            const dir = target
              ? Math.atan2(target.y - player.position.y, target.x - player.position.x)
              : player.rotation;
            this.networkManager.sendAction(action, target);
            this.renderSystem.spawnSwordArc(player.position, dir, 35);
            this.renderSystem.notifySwordSwing(this.AXE_COOLDOWN_MS);
            return;
          }
          // Pickaxe attack
          if (activeItem === 'pickaxe' && player && !player.isMounted) {
            const now = performance.now();
            if (now - this.lastPickaxeMs < this.PICKAXE_COOLDOWN_MS) return;
            if (!this.combatMode) {
              this.combatMode = true;
              this.lastCombatActionMs = now;
              return;
            }
            this.lastPickaxeMs = now;
            this.lastCombatActionMs = now;
            const dir = target
              ? Math.atan2(target.y - player.position.y, target.x - player.position.x)
              : player.rotation;
            this.networkManager.sendAction(action, target);
            this.renderSystem.spawnSwordArc(player.position, dir, 35);
            this.renderSystem.notifySwordSwing(this.PICKAXE_COOLDOWN_MS);
            return;
          }
          // Not a hammer or sword click — punch if unarmed or holding non-weapon/tool/building item
          const punchAllowed =
            activeItem === 'none' ||
            (ITEM_DEFS[activeItem]?.category !== 'weapon' &&
             ITEM_DEFS[activeItem]?.category !== 'tool' &&
             ITEM_DEFS[activeItem]?.category !== 'building');
          if (punchAllowed && player && !player.isMounted) {
            const now = performance.now();
            if (!this.combatMode) {
              this.combatMode = true;
              this.lastCombatActionMs = now;
              return;
            }
            if (now - this.lastPunchMs < this.PUNCH_COOLDOWN_MS) return;
            this.lastPunchMs = now;
            this.lastCombatActionMs = now;
            const dir = target
              ? Math.atan2(target.y - player.position.y, target.x - player.position.x)
              : player.rotation;
            this.networkManager.sendAction(action, target);
            this.renderSystem.spawnSwordArc(player.position, dir, 25);
            this.renderSystem.notifySwordSwing(this.PUNCH_COOLDOWN_MS);
            return;
          }
          // Tool/weapon/building item active — pass action to server
          this.networkManager.sendAction(action, target);
          return;
        }

        if (action === 'interact') {
          // If the dedicated E keydown ladder handler is active, suppress all
          // game-loop interact events to prevent mount/other modules firing.
          if (this._suppressLadderInteract) return;

          // Exit build/plan mode on any interaction attempt
          this.exitAllBuildModes();

          const playerId = this.networkManager.getAssignedPlayerId();
          const worldState = this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
          const player = playerId !== null ? worldState?.players.find(p => p.id === playerId) : null;
          const activeSlot = player?.inventory?.activeSlot ?? 0;
          const activeItem = player?.inventory?.slots[activeSlot]?.item ?? 'none';

          // Repair mode: active slot = wood → spend 1 wood to raise target_health on worst plank
          if (activeItem === 'wood' && player && player.carrierId !== 0) {
            console.log(`🔧 [REPAIR] Sending repair_plank (wood) for ship ${player.carrierId}`);
            this.networkManager.sendRepairPlank(player.carrierId);
            return;
          }

          // Harvest mode: active slot = axe + not on a ship + hovering a tree → chop
          // (disabled in combat mode — sword/punch state suppresses gathering)
          if (activeItem === 'axe' && player && player.carrierId === 0 && !this.combatMode) {
            const tree = this.renderSystem.getHoveredTree();
            if (tree) {
              console.log(`🪓 [HARVEST] Sending harvest_resource`);
              this.networkManager.sendHarvestResource();
              return;
            }
          }

          // Demolish mode: on own ship, hovering a non-plank module → hold [E] to demolish
          if (player && player.carrierId !== 0) {
            const hoveredDemolish = this.renderSystem.getHoveredModule();
            if (hoveredDemolish && hoveredDemolish.module.kind !== 'plank' &&
                hoveredDemolish.module.kind !== 'deck' &&
                hoveredDemolish.ship.id === player.carrierId) {
              const modLx = hoveredDemolish.module.localPos.x;
              const modLy = hoveredDemolish.module.localPos.y;
              let demolishDist: number;
              if (player.localPosition) {
                demolishDist = player.localPosition.sub(Vec2.from(modLx, modLy)).length();
              } else {
                const cos = Math.cos(hoveredDemolish.ship.rotation);
                const sin = Math.sin(hoveredDemolish.ship.rotation);
                const wx = hoveredDemolish.ship.position.x + modLx * cos - modLy * sin;
                const wy = hoveredDemolish.ship.position.y + modLx * sin + modLy * cos;
                demolishDist = player.position.sub(Vec2.from(wx, wy)).length();
              }
              if (demolishDist <= 120) {
                // Hold E to confirm demolish
                this._interactKind       = 'structure'; // reuse structure keyup path
                this._hoveredStructureId = hoveredDemolish.module.id;
                this._hoveredStructureType = 'wooden_floor' as any; // sentinel — handled below
                this._ladderHoldModuleId = hoveredDemolish.module.id;
                this._ladderHoldShipId   = hoveredDemolish.ship.id;
                this._suppressLadderInteract = true;
                this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mid   = this._ladderHoldModuleId;
                  const sid   = this._ladderHoldShipId;
                  this._ladderHoldModuleId = null;
                  this._ladderHoldShipId   = null;
                  this._interactKind       = null;
                  if (mid && sid) {
                    console.log(`🪓 [DEMOLISH] Hold complete — demolishing module ${mid} on ship ${sid}`);
                    this.networkManager.sendDemolishModule(sid, mid);
                  }
                }, 500);
              } else {
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                console.log(`🪓 [DEMOLISH] Module too far (${demolishDist.toFixed(1)}px)`);
              }
              return;
            }
          }

          // Harvest fiber: hover a fiber plant → press E (no tool required)
          // Falls back to proximity if no plant is hovered (handles cases where
          // a floor tile is placed over the bush and the cursor lands on it instead).
          if (player && player.carrierId === 0 && !this.combatMode) {
            const plant = this.renderSystem.getHoveredFiberPlant() ?? this.renderSystem.getNearbyFiberPlant();
            if (plant) {
              this.networkManager.sendHarvestFiber();
              return;
            }
          }

          // Harvest stone: hover a rock → press E (no tool required, gives ITEM_STONE)
          if (player && player.carrierId === 0 && !this.combatMode) {
            const rock = this.renderSystem.getHoveredRock();
            if (rock) {
              this.networkManager.sendHarvestStone();
              return;
            }
          }

          // Mine rock: pickaxe equipped + hovering rock → press E (gives ITEM_METAL)
          if (activeItem === 'pickaxe' && player && player.carrierId === 0 && !this.combatMode) {
            const rock = this.renderSystem.getHoveredRock();
            if (rock) {
              this.networkManager.sendHarvestRock();
              return;
            }
            const boulder = this.renderSystem.getHoveredBoulder();
            if (boulder) {
              this.networkManager.sendHarvestBoulder();
              return;
            }
          }

          // Collect tombstone: any player on foot within 80px → press E → open menu
          if (player && player.carrierId === 0) {
            const tomb = this.renderSystem.getHoveredTombstone();
            if (tomb) {
              this.networkManager.sendTombstoneOpen(tomb.id);
              return;
            }
          }

          // Pick up dropped item: player on foot within 80px → press E → nearest item
          if (player && player.carrierId === 0) {
            const nearbyDrops = this.renderSystem.getDroppedItemsInRange(80);
            if (nearbyDrops.length > 0) {
              const _di = nearbyDrops[0];
              const _ik = ITEM_ID_MAP[_di.itemKind];
              const _dname = _ik ? (ITEM_DEFS[_ik]?.name ?? _ik) : 'item';
              this.renderSystem.spawnResourcePickup(Vec2.from(_di.x, _di.y), `+${_di.quantity} ${_dname}`, '#80e880');
              this.networkManager.sendPickupItem(_di.id);
              return;
            }
          }

          // Workbench interaction: player on island, workbench under cursor and within range → open crafting
          if (player && player.carrierId === 0) {
            if (this.craftingMenu.visible) {
              this.craftingMenu.close();
              this.uiManager.setActiveMenuId(null);
              return;
            }
            if (this.shipyardMenu.visible) {
              this.shipyardMenu.close();
              this.uiManager.setActiveMenuId(null);
              return;
            }
            const hovered = this.renderSystem.getHoveredStructure();
            if (hovered?.type === 'workbench' || hovered?.type === 'shipyard') {
              console.log(`⚒ [INTERACT] Sending structure_interact for ${hovered.type} ${hovered.id}`);
              this.networkManager.sendStructureInteract(hovered.id);
              return;
            }
          }

          // Module interaction takes priority over NPC menu
          const hoveredModule = this.renderSystem.getHoveredModule();

          if (hoveredModule && player) {
            if (!worldState) return;

            // Calculate module world position
            const cos = Math.cos(hoveredModule.ship.rotation);
            const sin = Math.sin(hoveredModule.ship.rotation);
            const moduleWorldX = hoveredModule.ship.position.x +
              (hoveredModule.module.localPos.x * cos - hoveredModule.module.localPos.y * sin);
            const moduleWorldY = hoveredModule.ship.position.y +
              (hoveredModule.module.localPos.x * sin + hoveredModule.module.localPos.y * cos);
            const moduleWorldPos = Vec2.from(moduleWorldX, moduleWorldY);

            // Use local distance when both player and module are on the same ship
            let distance: number;
            if (player.carrierId === hoveredModule.ship.id && player.localPosition) {
              distance = player.localPosition.sub(hoveredModule.module.localPos).length();
            } else {
              distance = player.position.sub(moduleWorldPos).length();
            }

            const maxInteractDistance = 120;

            if (distance <= maxInteractDistance) {
              // All module interactions (including ladders) are handled by the E
              // keydown → keyup path in setupDebugKeys. That handler sets
              // _suppressLadderInteract=true before InputManager can fire a second
              // event, so nothing should be dispatched here. Falling through to the
              // proximity / NPC paths is intentional.
            }
          }

          // E key: NPC interactions are now fully handled by the E-hold radial
          // system in setupDebugKeys (which sets _suppressLadderInteract=true before
          // this game-loop path runs). Skip here to avoid double-firing.
          if (this.renderSystem.getHoveredNpc()) return;

          if (!hoveredModule && !this._suppressLadderInteract) {
            // Proximity fallback: scan for nearest ladder WITHOUT requiring mouse hover.
            // This is only for off-ship players trying to board — once on a ship the
            // hover path above always works and the distance-only scan would fire on
            // the wrong ladder (e.g. retracting a ladder you just climbed).
            const wsL = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
            if (wsL && player && player.carrierId === 0) {
              const LADDER_RANGE = 200;
              let nearestLadder: { ship: any; module: any } | null = null;
              let nearestDist = Infinity;
              let nearestAnyDist = Infinity;
              for (const ship of wsL.ships) {
                const cos = Math.cos(ship.rotation);
                const sin = Math.sin(ship.rotation);
                for (const mod of ship.modules) {
                  if (mod.kind !== 'ladder') continue;
                  const mwx = ship.position.x + (mod.localPos.x * cos - mod.localPos.y * sin);
                  const mwy = ship.position.y + (mod.localPos.x * sin + mod.localPos.y * cos);
                  let dist: number;
                  // Only use local coords when genuinely on this ship (carrierId !== 0)
                  if (player.carrierId !== 0 && player.carrierId === ship.id && player.localPosition) {
                    dist = Math.hypot(
                      (player.localPosition as any).x - mod.localPos.x,
                      (player.localPosition as any).y - mod.localPos.y
                    );
                  } else {
                    dist = Math.hypot(player.position.x - mwx, player.position.y - mwy);
                  }
                  if (dist < nearestAnyDist) nearestAnyDist = dist;
                  if (dist <= LADDER_RANGE && dist < nearestDist) {
                    nearestDist = dist;
                    nearestLadder = { ship, module: mod };
                  }
                }
              }
              if (nearestLadder) {
                const onShip = player.carrierId === nearestLadder.ship.id;
                const isExtended = (nearestLadder.module.moduleData as any)?.extended !== false;
                console.log(`🪜 proximity: ladder ${nearestLadder.module.id} onShip=${onShip} extended=${isExtended} dist=${nearestDist.toFixed(0)}px`);
                if (onShip) {
                  // On-ship: module_interact → handle_ladder_interact toggles (no company check)
                  this.networkManager.sendModuleInteract(nearestLadder.module.id);
                } else if (isExtended) {
                  // Off-ship + extended: climb/board
                  this.networkManager.sendModuleInteract(nearestLadder.module.id);
                } else {
                  // Off-ship + retracted: extend via toggle_ladder (module_interact would fail)
                  this.networkManager.sendToggleLadder(nearestLadder.module.id);
                }
              }
            }
          }
        } else {
          // 'dismount' is owned by the E-hold radial while the suppress flag is live —
          // prevent the InputManager game-loop from firing it independently so the
          // radial cancel dead zone still works.
          if (action === 'dismount' && this._suppressLadderInteract) return;
          // Other actions go to server
          this.networkManager.sendAction(action, target);
        }
      };
      
      // Ship control callbacks (when mounted to helm)
      this.inputManager.onShipSailControl = (desiredOpenness) => {
        this.networkManager.sendShipSailControl(desiredOpenness);
        // Feed predictor — compute avg wind efficiency from mast modules
        const myId = this.networkManager.getAssignedPlayerId();
        const world = this.predictedWorldState ?? this.authoritativeWorldState;
        const myPlayer = world?.players.find(p => p.id === myId);
        const playerShip = myPlayer?.carrierId ? world?.ships.find(s => s.id === myPlayer.carrierId) : null;
        let windEfficiency = 1.0;
        if (playerShip) {
          const masts = playerShip.modules.filter(m => m.kind === 'mast' && m.moduleData);
          if (masts.length > 0) {
            windEfficiency = masts.reduce((sum, m) => sum + ((m.moduleData as any).windEfficiency ?? 1.0), 0) / masts.length;
          }
        }
        this.shipPredictor?.onSailControl(desiredOpenness, windEfficiency);
      };
      this.inputManager.onShipRudderControl = (turningLeft, turningRight, movingBackward) => {
        this.networkManager.sendShipRudderControl(turningLeft, turningRight, movingBackward);
        const dir = turningLeft ? 'left' : turningRight ? 'right' : 'straight';
        this.shipPredictor?.onRudderControl(dir);
        this.shipPredictor?.onReverseThrust(movingBackward ?? false);
      };
      this.inputManager.onShipSailAngleControl = (desiredAngle) => {
        this.networkManager.sendShipSailAngleControl(desiredAngle);
      };
      
      // Cannon control callbacks
      this.inputManager.onCannonAim = (aimAngle, activeGroups) => {
        this.networkManager.sendCannonAim(aimAngle, activeGroups);
      };
      this.inputManager.onSwivelAim = (aimAngle) => {
        this.networkManager.sendSwivelAim(aimAngle);
      };
      this.inputManager.onCannonFire = (cannonIds, fireAll, ammoType, weaponGroup, weaponGroups) => {
        // Multi-group fire: fire all cannons in every selected group
        const groups = weaponGroups && weaponGroups.size > 0 ? weaponGroups : (weaponGroup !== undefined && weaponGroup >= 0 ? new Set([weaponGroup]) : null);
        if (groups) {
          const allIds: number[] = [];
          let skipAimCheck = !!fireAll; // double-click always skips aim-angle check
          for (const g of groups) {
            const gs = this.controlGroups.get(g);
            if (!gs || gs.cannonIds.length === 0) continue;
            for (const id of gs.cannonIds) if (!allIds.includes(id)) allIds.push(id);
            if (gs.mode === 'freefire' || gs.mode === 'targetfire') skipAimCheck = true;
          }
          if (allIds.length > 0) {
            this.networkManager.sendCannonFire(allIds, false, ammoType ?? 0, skipAimCheck);
            return;
          }
        }
        this.networkManager.sendCannonFire(cannonIds, fireAll, ammoType ?? 0);
      };
      this.inputManager.onForceReload = () => {
        const ammoType = this.inputManager?.selectedAmmoType ?? 0;
        this.networkManager.sendForceReload(ammoType);
        // Optimistically mark the island cannon as reloading so the per-frame
        // ammo-commit check doesn't instantly swap loadedAmmoType before the
        // server's structure_reload echo arrives.
        if (this.inputManager?.isOnIslandCannon) {
          const sid = this.inputManager.mountedCannonModuleId;
          if (sid !== null) this.renderSystem.updateStructureCannonReload(sid, 3000, ammoType);
        }
      };

      // Sail fiber repair: R key while hovering a damaged mast → consume repair kit, restore fibers
      this.inputManager.onRepairSail = () => {
        const damagedMast = this.renderSystem.getHoveredDamagedMast();
        if (!damagedMast) return;
        const playerId = this.networkManager.getAssignedPlayerId();
        const worldState = this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
        const player = playerId !== null ? worldState?.players.find(p => p.id === playerId) : null;
        if (!player || player.carrierId !== damagedMast.ship.id) return; // must be on the same ship
        console.log(`🧵 [REPAIR] Repairing sail fibers mast ${damagedMast.mastIndex} on ship ${damagedMast.ship.id}`);
        this.networkManager.sendRepairSail(damagedMast.ship.id, damagedMast.mastIndex);
      };

      // Q key: unequip active slot — use 255 as "nothing selected" sentinel
      this.inputManager.onUnequip = () => {
        this.pendingActiveSlot = 255;
        const playerId = this.networkManager.getAssignedPlayerId();
        if (playerId !== null) {
          for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
            const p = ws?.players.find(pl => pl.id === playerId);
            if (p) p.inventory.activeSlot = 255;
          }
        }
        this.networkManager.sendUnequip();
        // Also exit any build mode that was active due to the equipped item
        this.exitAllBuildModes();
        console.log('🎒 [INVENTORY] Unequipped active slot');
      };

      // Hotbar slot selection — update locally for instant UI feedback, then sync server
      this.inputManager.onSlotSelect = (slot) => {
        this.pendingActiveSlot = slot;
        const playerId = this.networkManager.getAssignedPlayerId();
        if (playerId !== null) {
          for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
            const p = ws?.players.find(pl => pl.id === playerId);
            if (p) p.inventory.activeSlot = slot;
          }
        }
        this.networkManager.sendSlotSelect(slot);
        // Deactivate combat mode when a building item is selected
        if (this.combatMode) {
          const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          const pid = this.networkManager.getAssignedPlayerId();
          const p = ws?.players.find(pl => pl.id === pid);
          const selectedItem = p?.inventory?.slots[slot]?.item ?? 'none';
          if (ITEM_DEFS[selectedItem]?.category === 'building') {
            this.combatMode = false;
          }
        }
        // Selecting a hotbar item deselects any build panel ghost kind
        if (this.pendingGhostKind !== null) {
          this.pendingGhostKind = null;
          this.syncBuildModeState();
        }
        // Re-evaluate build mode: plank in active slot → build mode on
        this.checkBuildMode();
      };

      // Build placement: left-click in build mode → send place_plank / place_cannon / place_mast / replace_helm
      this.inputManager.onBuildPlace = (worldPos) => {
        // Island structure placement (wooden floor or workbench)
        if (this.islandBuildMode) {
          const ws  = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          const pid = this.networkManager.getAssignedPlayerId();
          const p   = ws?.players.find(pl => pl.id === pid);
          const kind = p?.inventory?.slots[p.inventory.activeSlot ?? 0]?.item;
          if (kind === 'wooden_floor' || kind === 'workbench' || kind === 'wall' || kind === 'door_frame' || kind === 'door' || kind === 'shipyard' || kind === 'wood_ceiling' || kind === 'cannon' || kind === 'flag_fort' || kind === 'company_fortress' || kind === 'claim_flag') {
            // Compute snap at click time (not from stale render state)
            const pos = kind === 'wooden_floor'
              ? this.renderSystem.computeSnappedPos(worldPos.x, worldPos.y)
              : (kind === 'wall' || kind === 'door_frame')
              ? this.renderSystem.computeSnappedWallPos(worldPos.x, worldPos.y)
              : kind === 'door'
              ? this.renderSystem.computeSnappedDoorPos(worldPos.x, worldPos.y)
              : kind === 'wood_ceiling'
              ? this.renderSystem.computeSnappedCeilingPos(worldPos.x, worldPos.y)
              : { x: worldPos.x, y: worldPos.y };
            // Only floors, workbenches, ceilings, and cannons carry rotation
            const rot = kind === 'wooden_floor'
              ? (this.renderSystem.getSnappedBuildRotation() ?? this.islandBuildRotationDeg)
              : (kind === 'workbench' || kind === 'shipyard' || kind === 'cannon') ? this.islandBuildRotationDeg
              : kind === 'wood_ceiling' ? (this.renderSystem.getSnappedBuildRotation() ?? this.islandBuildRotationDeg)
              : 0;
            this.networkManager.sendPlaceStructure(kind as 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag', pos.x, pos.y, rot);
          }
          return;
        }
        // Ship deck claim flag placement: claim_flag in hotbar while boarding a ship → plant at click position
        {
          const ws2 = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          const pid2 = this.networkManager.getAssignedPlayerId();
          const p2   = ws2?.players.find(pl => pl.id === pid2);
          const kind2 = p2?.inventory?.slots[p2?.inventory?.activeSlot ?? 0]?.item;
          if (kind2 === 'claim_flag' && (p2?.carrierId ?? 0) !== 0) {
            this.networkManager.sendPlantClaimFlag(p2!.carrierId, worldPos.x, worldPos.y);
            return;
          }
        }
        // Ghost menu pending placement takes highest priority
        if (this.buildMenuOpen && this.pendingGhostKind !== null) {
          this.handleGhostPlace(worldPos);
          return;
        }
        // Explicit B-key build mode takes priority (free placement, real module)
        if (this.explicitBuildMode) {
          this.handleExplicitBuildPlace(worldPos);
          return;
        }
        // Hotbar ghost snap: if the active hotbar item matches a nearby ghost, place
        // the real module at the ghost's stored position and consume the ghost.
        if (this.tryPlaceAtGhost(worldPos)) return;
        // Helm replacement (highest priority — only one helm per ship)
        const helmSlot = this.renderSystem.getHoveredHelmSlot();
        if (helmSlot) {
          console.log(`🔧 [BUILD] Replacing helm on ship ${helmSlot.ship.id}`);
          this.networkManager.sendReplaceHelm(helmSlot.ship.id);
          return;
        }
        // Deck replacement (high priority — only one deck per ship)
        const deckSlot = this.renderSystem.getHoveredDeckSlot();
        if (deckSlot) {
          console.log(`🪵 [BUILD] Placing deck on ship ${deckSlot.ship.id}`);
          this.networkManager.sendPlaceDeck();
          return;
        }
        // Mast placement build mode
        const mastSlot = this.renderSystem.getHoveredMastSlot();
        if (mastSlot) {
          console.log(`⛵ [BUILD] Placing mast ${mastSlot.mastIndex} on ship ${mastSlot.ship.id}`);
          this.networkManager.sendPlaceMast(mastSlot.ship.id, mastSlot.mastIndex);
          return;
        }
        // Cannon replacement build mode
        const cannonSlot = this.renderSystem.getHoveredCannonSlot();
        if (cannonSlot) {
          console.log(`🔧 [BUILD] Placing cannon in slot ${cannonSlot.cannonIndex} on ship ${cannonSlot.ship.id}`);
          this.networkManager.sendPlaceCannon(cannonSlot.ship.id);
          return;
        }
        // Plank placement build mode
        const slot = this.renderSystem.getHoveredPlankSlot();
        if (slot) {
          console.log(`🔨 [BUILD] Placing plank in slot ${slot.sectionName}[${slot.segmentIndex}] on ship ${slot.ship.id}`);
          this.networkManager.sendPlacePlank(slot.ship.id, slot.sectionName, slot.segmentIndex);
        }
      };

      // Build menu toggle (B key) — opens/closes the left-panel build menu.
      // Works anytime the player is on a ship deck.
      // If a cannon or sail item is active in the hotbar, also enters free-placement mode.
      this.inputManager.onCombatModeToggle = () => {
        this.combatMode = !this.combatMode;
      };
      this.inputManager.onBuildModeToggle = () => {
        if (this.buildMenuOpen || this.explicitBuildMode) {
          // Close everything via the single exit helper
          this.exitAllBuildModes();
          console.log('🏗️ [BUILD MENU] CLOSED');
        } else {
          // Open — require player to be on a ship
          const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          const playerId = this.networkManager?.getAssignedPlayerId();
          const player = ws?.players.find(p => p.id === playerId);
          if (!player?.carrierId) {
            console.log('🏗️ [BUILD MENU] Cannot open — not on a ship');
            return;
          }
          this.buildMenuOpen = true;
          this.inputManager.buildMenuOpen = true;
          // If a buildable item is in the hotbar, also enter free-placement mode
          const activeSlot = player.inventory?.activeSlot ?? 0;
          const activeItem = player.inventory?.slots[activeSlot]?.item ?? 'none';
          if (activeItem === 'cannon' || activeItem === 'sail' || activeItem === 'swivel') {
            this.explicitBuildMode = true;
            this.buildSelectedItem = activeItem as 'cannon' | 'sail' | 'swivel';
          }
          console.log(`🏗️ [BUILD MENU] OPENED${this.explicitBuildMode ? ` (free-place: ${this.buildSelectedItem})` : ' (plan mode)'}`);
        }
        this.syncBuildModeState();
      };

      // Build rotation (R/Q key in build modes)
      this.inputManager.onBuildRotate = (deltaDeg: number) => {
        if (this.inputManager.islandBuildMode) {
          this.islandBuildRotationDeg = (this.islandBuildRotationDeg + deltaDeg + 360) % 360;
          this.renderSystem.setIslandBuildRotation(this.islandBuildRotationDeg);
        } else {
          this.buildRotationDeg = (this.buildRotationDeg + deltaDeg + 360) % 360;
          this.syncBuildModeState();
        }
      };

      // Right-click in build menu: cancel pending ghost or remove nearest placed ghost
      this.inputManager.onBuildRightClick = (worldPos: Vec2) => {
        if (this.pendingGhostKind !== null) {
          // Cancel the ghost currently attached to the cursor
          this.pendingGhostKind = null;
          this.syncBuildModeState();
          console.log('🏗️ [GHOST] Cancelled pending ghost');
        } else {
          // Remove the nearest placed ghost marker
          this.removeNearestGhost(worldPos);
        }
      };
      
      // Set up scroll-wheel zoom — accumulate into _userZoomMul so AOI base zoom
      // remains separate and the two combine correctly. We update only targetZoom
      // here; the per-frame lerp (see updateCamera) smoothly animates camera.zoom
      // toward targetZoom so scroll-wheel zooms feel eased instead of snappy.
      this.inputManager.onZoom = (factor, _screenPoint) => {
        this._userZoomMul = Math.max(0.1, Math.min(4.0, this._userZoomMul * factor));
        this.targetZoom   = Math.max(0.1, Math.min(10.0, this._aoiBaseZoom * this._userZoomMul));
      };

      // ── Camera mode callbacks ─────────────────────────────────────────────
      // Middle-mouse (no Shift) → toggle free-camera mode
      this.inputManager.onMiddleMouseToggle = () => {
        this._freeCameraMode = !this._freeCameraMode;
        // Sync flag so InputManager can gate normal mouse actions while in free-cam mode
        this.inputManager.freeCameraMode = this._freeCameraMode;
        // Entering free-cam: release camera from player tracking while active.
        // Exiting free-cam: next updateCamera call will resume player following.
      };

      // Free-cam drag — pan the camera position directly
      this.inputManager.onFreeCamDrag = (dx, dy) => {
        if (!this._freeCameraMode) return;
        // screenToWorldDelta applies the correct inverse rotation (+rot) and zoom
        const worldDelta = this.camera.screenToWorldDelta(Vec2.from(dx, dy));
        const pos = this.camera.getState().position;
        this.camera.setPosition(Vec2.from(pos.x - worldDelta.x, pos.y - worldDelta.y));
      };

      // Shift + middle-mouse (hold) → rotate camera
      this.inputManager.onRotateCamStart  = () => { this._rotateCamActive = true; };
      this.inputManager.onRotateCamEnd    = () => { this._rotateCamActive = false; };
      this.inputManager.onRotateCamDrag   = (dx, _dy) => {
        // Horizontal drag rotates by ~0.005 rad/px
        this._cameraRotationTarget += dx * 0.005;
      };

      // Let UI panels (e.g. manning priority panel) consume clicks before game logic
      this.inputManager.onUIClick = (x, y) => {
        // Rename dialog is topmost — check first
        if (this.renameDialog?.handleClick(x, y)) return true;
        if (this.shipyardMenu.handleClick(x, y, this.canvas.width, this.canvas.height)) return true;
        const _wsClick = this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
        const _pidClick = this.networkManager.getAssignedPlayerId();
        const _invClick = _wsClick?.players.find(p => p.id === _pidClick)?.inventory ?? null;
        if (this.craftingMenu.handleClick(x, y, this.canvas.width, this.canvas.height, _invClick)) return true;
        if (this.uiManager?.handleClick(x, y)) return true;
        return false;
      };

      // Forward mouse-move/up to world map for drag-pan
      this.inputManager.onUIMouseMove = (x, y) => {
        if (this.craftingMenu.visible) this.craftingMenu.handleMouseMove(x, y);
        this.uiManager?.handleWorldMapMouseMove(x, y);
      };
      this.inputManager.onUIMouseUp = (x, y) => {
        this.uiManager?.handleWorldMapMouseUp(x, y);
      };
      // Forward wheel to world map zoom (returns true when map is visible)
      this.inputManager.onUIWheel = (deltaY, x, y) => {
        if (this.craftingMenu.visible) return this.craftingMenu.handleWheel(deltaY);
        return this.uiManager?.handleWorldMapWheel(deltaY, x, y) ?? false;
      };

      // Ctrl+left-click: assign/remove cannon from the active weapon group
      //   — but if an NPC is hovered, enter Move To mode directly
      //   — if nothing is hovered, start a box-select drag
      this.inputManager.onGroupAssign = () => {
        // ── Ctrl+click on an NPC → enter Move To mode immediately ───────────
        const hovNpcCtrl = this.renderSystem.getHoveredNpc();
        if (hovNpcCtrl) {
          const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const myId = this.networkManager.getAssignedPlayerId();
          const me = (myId !== null ? ws?.players.find(p => p.id === myId) : null) ?? ws?.players[0] ?? null;
          const myCompany = me?.companyId ?? 0;
          const isMyNpcCtrl = hovNpcCtrl.companyId !== COMPANY_UNCLAIMED && (
            hovNpcCtrl.companyId === COMPANY_SOLO
              ? hovNpcCtrl.ownerId === myId
              : hovNpcCtrl.companyId === myCompany && myCompany !== 0
          );
          if (!isMyNpcCtrl) return;

          // Ignored NPCs cannot be moved
          if (this._npcIgnoreSet.has(hovNpcCtrl.id)) {
            this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            console.log(`⛔ NPC ${hovNpcCtrl.id} (${hovNpcCtrl.name}) ignores commands`);
            return;
          }

          // Enter Move To mode immediately (server clears task_locked on npc_move_to_pos)
          this._selectedNpcIds = [];
          this.renderSystem.selectedNpcIds = new Set();
          this._moveToNpcId = hovNpcCtrl.id;
          this.renderSystem.setMoveToSourceNpc(hovNpcCtrl.id);
          this.renderSystem.setMoveToHint(`Moving ${hovNpcCtrl.name} — click a module, ship, or open water`);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          return;
        }

        // ── Default: cannon group assignment ────────────────────────────────
        const hovered = this.renderSystem.getHoveredModule();
        if (!hovered) {
          // Nothing hovered — start box-select drag
          this._startBoxSelect();
          return;
        }
        if (hovered.module.kind !== 'cannon' && hovered.module.kind !== 'swivel') {
          console.warn(`⚠️ GroupAssign: hovered module is '${hovered.module.kind}', not a cannon or swivel`);
          return;
        }
        const cannonId = hovered.module.id;
        const group = this.inputManager.activeWeaponGroup;
        if (group < 0) {
          // No group selected — remove this cannon from whichever group it belongs to
          for (const [gi, s] of this.controlGroups) {
            if (s.cannonIds.includes(cannonId)) {
              s.cannonIds = s.cannonIds.filter(id => id !== cannonId);
              console.log(`🗑️ Cannon ${cannonId} cleared from group G${gi}`);
              this.networkManager.sendCannonGroupConfig(gi, s.mode, s.cannonIds, s.targetId > 0 ? s.targetId : 0);
            }
          }
          return;
        }
        const state = this.controlGroups.get(group);
        if (!state) return;
        if (state.cannonIds.includes(cannonId)) {
          // Already in this group — remove it
          state.cannonIds = state.cannonIds.filter(id => id !== cannonId);
          console.log(`❌ Cannon ${cannonId} removed from group G${group}`);
        } else {
          // Remove from any previous group first (a cannon belongs to at most one group)
          for (const [gi, s] of this.controlGroups) {
            if (s.cannonIds.includes(cannonId)) {
              s.cannonIds = s.cannonIds.filter(id => id !== cannonId);
              this.networkManager.sendCannonGroupConfig(gi, s.mode, s.cannonIds, s.targetId > 0 ? s.targetId : 0);
            }
          }
          state.cannonIds.push(cannonId);
          console.log(`🎯 Cannon ${cannonId} → group G${group}`);
        }
        // Sync the updated group to server
        this.networkManager.sendCannonGroupConfig(group, state.mode, state.cannonIds, state.targetId > 0 ? state.targetId : 0);
      };

      this.inputManager.onGroupAssignTo = (targetGroup: number) => {
        const hovered = this.renderSystem.getHoveredModule();
        if (!hovered || (hovered.module.kind !== 'cannon' && hovered.module.kind !== 'swivel')) return;
        const cannonId = hovered.module.id;
        const state = this.controlGroups.get(targetGroup);
        if (!state) return;
        if (state.cannonIds.includes(cannonId)) {
          // Already in this group — remove it
          state.cannonIds = state.cannonIds.filter(id => id !== cannonId);
          console.log(`\u274c Cannon ${cannonId} removed from group G${targetGroup}`);
        } else {
          // Remove from any other group first
          for (const [gi, s] of this.controlGroups) {
            if (gi !== targetGroup && s.cannonIds.includes(cannonId)) {
              s.cannonIds = s.cannonIds.filter(id => id !== cannonId);
              this.networkManager.sendCannonGroupConfig(gi, s.mode, s.cannonIds, s.targetId > 0 ? s.targetId : 0);
            }
          }
          state.cannonIds.push(cannonId);
          console.log(`\ud83c\udfaf Cannon ${cannonId} \u2192 group G${targetGroup}`);
        }
        this.networkManager.sendCannonGroupConfig(targetGroup, state.mode, state.cannonIds, state.targetId > 0 ? state.targetId : 0);
      };

      // Left-click while mounted: Move To mode takes priority over cannon fire
      this.inputManager.onBeforeLeftClick = () => this._moveToNpcId !== null || this._selectedNpcIds.length > 0;

      // Ctrl+right-click on an NPC: cycle normal → ignore → locked (at module) → normal
      this.inputManager.onNpcStateCycle = () => {
        const hovNpc = this.renderSystem.getHoveredNpc();
        if (!hovNpc) {
          // No NPC hovered — fall back to group-assign behaviour
          if (this.inputManager) this.inputManager.onGroupAssign?.();
          return;
        }
        const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
        const myId = this.networkManager.getAssignedPlayerId();
        const me = (myId !== null ? ws?.players.find(p => p.id === myId) : null) ?? null;
        const myCompany = me?.companyId ?? 0;
        const isMine = hovNpc.companyId !== 0 && (
          hovNpc.companyId === 0 /* COMPANY_SOLO hack */ ? hovNpc.ownerId === myId
            : hovNpc.companyId === myCompany && myCompany !== 0
        ) || (hovNpc.ownerId !== 0 && hovNpc.ownerId === myId);
        if (!isMine) return;

        const isIgnored = this._npcIgnoreSet.has(hovNpc.id);
        const isLocked  = hovNpc.locked;
        const atModule  = hovNpc.assignedWeaponId !== 0;

        if (!isIgnored && !isLocked) {
          // Normal → Ignore commands
          this._npcIgnoreSet.add(hovNpc.id);
          console.log(`🚫 NPC ${hovNpc.id} (${hovNpc.name}) → ignore commands`);
        } else if (isIgnored && !isLocked) {
          if (atModule) {
            // Ignore → Locked at station
            this._npcIgnoreSet.delete(hovNpc.id);
            this.networkManager.sendNpcLock(hovNpc.id, true);
            console.log(`🔒 NPC ${hovNpc.id} (${hovNpc.name}) → locked at station`);
          } else {
            // No module — Ignore → Normal
            this._npcIgnoreSet.delete(hovNpc.id);
            console.log(`✅ NPC ${hovNpc.id} (${hovNpc.name}) → normal`);
          }
        } else if (isLocked) {
          // Locked → Normal (unlock; also clear ignore)
          this.networkManager.sendNpcLock(hovNpc.id, false);
          this._npcIgnoreSet.delete(hovNpc.id);
          console.log(`✅ NPC ${hovNpc.id} (${hovNpc.name}) → normal (unlocked)`);
        }
      };

      // Right-click: cancel Move To / box-select mode before any other right-click handling
      this.inputManager.onBeforeRightClick = () => {
        if (this._moveToNpcId !== null || this._selectedNpcIds.length > 0) {
          this._moveToNpcId = null;
          this._selectedNpcIds = [];
          this.renderSystem.selectedNpcIds = new Set();
          this.renderSystem.clearMoveToHint();
          return true; // consume — don't aim, retarget, etc.
        }
        return false;
      };

      // Right-click intercepted by UIManager (e.g. cycling weapon group mode on hotbar)
      this.inputManager.onUIRightClick = (x, y) => {
        return this.uiManager?.handleRightClick(x, y) ?? false;
      };

      // Sync the active group's mode into InputManager whenever the selected group changes.
      // InputManager uses this to decide whether right-click aims or locks a target.
      this.inputManager.onWeaponGroupSelect = (group: number) => {
        const state = this.controlGroups.get(group);
        this.inputManager.activeGroupMode = state?.mode ?? 'haltfire';
      };

      // Right-click hold → temporarily enter 'aiming' mode so cannons track the mouse.
      // Applies to all currently selected groups whose mode isn't targetfire/aiming.
      this.inputManager.onAimStart = () => {
        const groups = this.inputManager.activeWeaponGroups;
        if (groups.size === 0) return;
        this._aimOverrideGroups = new Map();
        for (const g of groups) {
          const state = this.controlGroups.get(g);
          if (!state || state.mode === 'targetfire' || state.mode === 'aiming') continue;
          this._aimOverrideGroups.set(g, state.mode);
          state.mode = 'aiming';
          this.networkManager.sendCannonGroupConfig(g, 'aiming', state.cannonIds, state.targetId > 0 ? state.targetId : 0);
        }
        // Update primary group mode for right-click routing
        const primaryState = this.controlGroups.get(this.inputManager.activeWeaponGroup);
        this.inputManager.activeGroupMode = primaryState?.mode ?? 'aiming';
      };
      this.inputManager.onAimEnd = () => {
        if (!this._aimOverrideGroups) return;
        for (const [g, prevMode] of this._aimOverrideGroups) {
          const state = this.controlGroups.get(g);
          if (!state) continue;
          state.mode = prevMode;
          this.networkManager.sendCannonGroupConfig(g, prevMode, state.cannonIds, state.targetId > 0 ? state.targetId : 0);
        }
        this._aimOverrideGroups = null;
        const primaryState = this.controlGroups.get(this.inputManager.activeWeaponGroup);
        this.inputManager.activeGroupMode = primaryState?.mode ?? 'haltfire';
      };

      // Right-click on world while on helm = lock target for all selected targetfire groups
      this.inputManager.onGroupTarget = (worldPos) => {
        const groups = this.inputManager.activeWeaponGroups;
        if (groups.size === 0) return;
        const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        if (!ws) return;
        const pid = this.networkManager.getAssignedPlayerId();
        const player = pid !== null ? ws.players.find(p => p.id === pid) : null;
        const myShipId = player?.carrierId ?? -1;
        let best = -1;
        let bestDist = 600;
        for (const ship of ws.ships) {
          if (ship.id === myShipId) continue;
          const dx = ship.position.x - worldPos.x;
          const dy = ship.position.y - worldPos.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < bestDist) { bestDist = d; best = ship.id; }
        }
        for (const g of groups) {
          const state = this.controlGroups.get(g);
          if (!state || state.mode !== 'targetfire') continue;
          state.targetId = best;
          this.networkManager.sendCannonGroupConfig(g, state.mode, state.cannonIds, best > 0 ? best : 0);
        }
        if (best >= 0) console.log(`🎯 Groups [${[...groups].join(',')}] target → ship ${best} (dist ${bestDist.toFixed(0)})`);
      };

      // Set up mouse tracking for mouse-relative movement
      this.setupMouseTracking();
      
      // Set up debug keyboard shortcuts
      this.setupDebugKeys();

      // Wire pause menu logout button → revoke token on auth server, clear local storage, reload
      this.pauseMenu.onLogout = () => {
        this.shutdown();
        logout().finally(() => window.location.reload());
      };

      // Clear the active menu ID when the pause menu closes (Resume, backdrop, Escape)
      this.pauseMenu.onClose = () => {
        this.uiManager?.setActiveMenuId(null);
      };

      // Wire pause menu settings → apply live to running systems
      this.pauseMenu.onSettingsChange = (settings) => {
        this.applySettings(settings);
      };

      // Wire command console
      this.commandConsole.onCommand = (cmd) => {
        const parts = cmd.slice(1).trim().split(/\s+/);
        const name  = parts[0].toLowerCase();

        // Client-side-only commands — do NOT forward to server
        if (name === 'islandeditor') {
          if (!this.islandEditor) {
            this.islandEditor = new IslandEditor(this.canvas, () => this.camera);
          }
          // Feed current islands from renderSystem (the authoritative client store)
          this.islandEditor.setIslands(this.renderSystem.getIslands() as any);
          const idArg = parseInt(parts[1] ?? '', 10);
          this.islandEditor.open(isNaN(idArg) ? undefined : idArg);
          this.commandConsole.pushResponse('Island editor opened.', 'info');
          return;
        }

        this.networkManager.sendCommand(cmd);
      };
      this.commandConsole.onVisibilityChange = (visible) => {
        this.uiManager?.setActiveMenuId(visible ? MENU_ID.CONSOLE : null);
      };

      // Dynamic autocomplete — player names and ship IDs from live world state
      this.commandConsole.setArgValuesProvider('TpPlayerToShip', 0, () => {
        const ws = this.authoritativeWorldState;
        if (!ws) return [];
        return ws.players
          .filter(p => p.name)
          .map(p => p.name as string);
      });
      this.commandConsole.setArgValuesProvider('TpPlayerToShip', 1, () => {
        const ws = this.authoritativeWorldState;
        if (!ws) return [];
        return ws.ships.filter(s => s.id).map(s => String(s.id));
      });
      this.commandConsole.setArgValuesProvider('KillPlayer', 0, () => {
        const ws = this.authoritativeWorldState;
        if (!ws) return [];
        return ws.players.filter(p => p.name).map(p => p.name as string);
      });
      this.commandConsole.setArgValuesProvider('TpPlayerTo', 0, () => {
        const ws = this.authoritativeWorldState;
        if (!ws) return [];
        return ws.players.filter(p => p.name).map(p => p.name as string);
      });
      this.commandConsole.setArgValuesProvider('TpToPlayer', 0, () => {
        const ws = this.authoritativeWorldState;
        if (!ws) return [];
        return ws.players.filter(p => p.name).map(p => p.name as string);
      });
      this.commandConsole.setArgValuesProvider('TpToPlayer', 1, () => {
        const ws = this.authoritativeWorldState;
        if (!ws) return [];
        return ws.players.filter(p => p.name).map(p => p.name as string);
      });
      this.networkManager.onCommandResponse = (text, success) => {
        this.commandConsole.pushResponse(text, success ? 'response' : 'error');
        // Don't auto-open — the player can re-open with / to see the log
      };
      this.networkManager.onPlayerTeleported = (playerId, x, y, parentShip, localX, localY) => {
        // Snap the local player position if it's us being teleported
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          const p = ws?.players.find(pl => pl.id === playerId);
          if (!p) continue;
          p.position = Vec2.from(x, y);
          p.carrierId = parentShip;
          p.localPosition = Vec2.from(localX, localY);
        }
      };
      
      // Initialize UI System
      this.uiManager = new UIManager(this.canvas, this.config);

      // Exit free-camera mode whenever any menu is opened
      this.uiManager.onMenuOpen = () => {
        if (this._freeCameraMode) {
          this._freeCameraMode = false;
          this.inputManager.freeCameraMode = false;
        }
      };

      // Wire crew assignment changes from the manning panel to the server
      this.uiManager.setCrewAssignmentCallback((shipId, assignments) => {
        this.networkManager.sendCrewAssign(shipId, assignments);
      });

      // Wire ship attribute upgrade requests from the ship status menu to the server
      this.uiManager.setShipUpgradeCallback((shipId, attribute) => {
        this.networkManager.sendUpgradeShipAttribute(shipId, attribute);
      });

      // Wire ship unclaim requests from the settings panel to the server
      this.uiManager.setShipUnclaimCallback((shipId) => {
        this.networkManager.sendUnclaimShip(shipId);
      });

      // Wire ship claim requests from the settings panel to the server
      this.uiManager.setShipClaimCallback((shipId) => {
        this.networkManager.sendClaimShip(shipId);
      });

      this.uiManager.setShipRenameRequestCallback((shipId, currentName) => {
        this.renameDialog.open(shipId, currentName);
      });

      // Wire Leave Company button in the company menu — moves player back to Solo
      this.uiManager.setLeaveCompanyCallback(() => {
        this.networkManager.sendCommand('/AddPlayerToCompany solo');
      });

      // Wire Join Company buttons in the company menu — moves player (and their NPCs) to the chosen guild
      this.uiManager.setJoinCompanyCallback((companyId: number) => {
        if (companyId >= 100) {
          // Dynamic player-created company — use JSON protocol message
          this.networkManager.sendJoinCompany(companyId);
        } else {
          const companyName = companyId === 2 ? 'pirates' : companyId === 3 ? 'navy' : 'solo';
          this.networkManager.sendCommand(`/AddPlayerToCompany ${companyName}`);
        }
      });

      // Wire Create Company button in the company menu
      this.uiManager.setCreateCompanyCallback((name: string) => {
        this.networkManager.sendCreateCompany(name);
      });

      // Wire NPC stat upgrade requests from the crew level menu to the server
      this.uiManager.setCrewUpgradeCallback((npcId, stat) => {
        this.networkManager.sendCrewUpgrade(npcId, stat);
      });

      // Wire player stat upgrade requests from the character menu to the server
      this.uiManager.setPlayerUpgradeCallback((stat) => {
        this.networkManager.sendPlayerStatUpgrade(stat);
      });

      this.uiManager.onPlayerLevelUp = () => {
        this.networkManager.sendPlayerLevelUp();
      };

      // Sync the level-up callback so the LEVEL UP button in the player menu works
      this.uiManager.syncPlayerLevelUpCallback();

      // Wire respawn confirmation: flash white, snap camera, send network request immediately
      this.uiManager.setRespawnConfirmedCallback((shipId, worldX, worldY, islandId, spawnX, spawnY) => {
        // 1. Hold screen at full white
        this.uiManager.triggerWhiteFlash();
        this.uiManager.closeRespawnScreen();

        // 2. Snap camera to spawn target so it's in the right place when white fades
        if (spawnX !== undefined && spawnY !== undefined) {
          this.camera.setPosition(Vec2.from(spawnX, spawnY));
        }

        // 3. Send network request immediately
        this.networkManager.sendRespawnRequest(shipId, worldX, worldY, islandId);
      });

      // Hotbar left-click slot selection
      this.uiManager.onHotbarSlotClick = (slot) => {
        this.inputManager.onSlotSelect?.(slot);
      };

      // Supply inventory data for drag-and-drop in the player menu
      this.uiManager.getPlayerInventory = () => {
        const ws  = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        const pid = this.networkManager.getAssignedPlayerId();
        return ws?.players.find(p => p.id === pid)?.inventory ?? null;
      };

      // Inventory drag-and-drop swap
      this.uiManager.playerMenu.onSwapRequest = (fromSlot, toSlot) => {
        const pid = this.networkManager.getAssignedPlayerId();
        for (const w of [this.authoritativeWorldState, this.predictedWorldState]) {
          const p = w?.players.find(pl => pl.id === pid);
          if (!p) continue;
          // Optimistic local swap
          const tmp = { ...p.inventory.slots[fromSlot] };
          p.inventory.slots[fromSlot] = { ...p.inventory.slots[toSlot] };
          p.inventory.slots[toSlot] = tmp;
        }
        this.networkManager.sendInvSwap(fromSlot, toSlot);
      };

      this.uiManager.playerMenu.onDropItem = (fromSlot) => {
        const pid = this.networkManager.getAssignedPlayerId();
        let _dropLabel: string | null = null;
        let _dropPos: import('../common/Vec2.js').Vec2 | null = null;
        for (const w of [this.authoritativeWorldState, this.predictedWorldState]) {
          const p = w?.players.find(pl => pl.id === pid);
          if (!p) continue;
          const slot = p.inventory.slots[fromSlot];
          if (!_dropLabel && slot && slot.item !== 'none' && slot.quantity > 0) {
            const name = ITEM_DEFS[slot.item]?.name ?? slot.item;
            _dropLabel = `\u2212${slot.quantity} ${name}`;
            _dropPos = p.position;
          }
          // Optimistic local clear
          p.inventory.slots[fromSlot] = { item: 'none' as any, quantity: 0 };
        }
        this.networkManager.sendDropItem(fromSlot);
        if (_dropLabel && _dropPos) this.renderSystem.spawnResourcePickup(_dropPos, _dropLabel, '#e07070');
      };

      // Hand-craft from inventory (no workbench needed)
      this.uiManager.playerMenu.onCraftRequest = (outputItem) => {
        const recipeId = `craft_${outputItem.replace(/-/g, '_')}`;
        this.networkManager.sendCraftItem(recipeId);
      };

      // Equip armour item from inventory slot (click on armor item in bag)
      this.uiManager.playerMenu.onEquipItem = (slotIdx) => {
        this.networkManager.sendEquipArmor(slotIdx);
      };

      // Unequip armour from equipment slot (click on filled equipment slot)
      this.uiManager.playerMenu.onUnequipSlot = (slot) => {
        this.networkManager.sendUnequipArmor(slot);
      };

      // Wreck salvage menu
      this.uiManager.salvageMenu.onTakeItem = (wreckId) => {
        this.networkManager.sendStructureInteract(wreckId);
      };
      this.networkManager.onSalvageSuccess = (_item, qty) => {
        const kind = ITEM_ID_MAP[_item];
        const label = kind ? (ITEM_DEFS[kind]?.symbol ?? kind) : `item #${_item}`;
        this.renderSystem.showAnnouncement(`🪵 Salvaged ×${qty} ${label}`, 'info', 2.5);
        this.uiManager.salvageMenu.onItemTaken();
        if (this.uiManager.salvageMenu.lootCount <= 0) {
          this.uiManager.salvageMenu.close();
          this.uiManager.setActiveMenuId(null);
        }
      };

      // Handle drop picker item selection (hold-E near pile)
      this.uiManager.onDropPickerPick = (itemId) => {
        const _ws = this.authoritativeWorldState ?? this.predictedWorldState;
        const _di = _ws?.droppedItems.find(d => d.id === itemId);
        if (_di) {
          const _ik = ITEM_ID_MAP[_di.itemKind];
          const _dname = _ik ? (ITEM_DEFS[_ik]?.name ?? _ik) : 'item';
          this.renderSystem.spawnResourcePickup(Vec2.from(_di.x, _di.y), `+${_di.quantity} ${_dname}`, '#80e880');
        }
        this.networkManager.sendPickupItem(itemId);
      };

      // Handle NPC_STAT_UP broadcast: refresh world-state NPC fields
      this.networkManager.onNpcStatUp = (npcId, _stat, _statLevel, xp,
          maxHealth, npcLevel, statHealth, statDamage, statStamina, statWeight, statPoints) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const npc = ws.npcs.find(n => n.id === npcId);
          if (!npc) continue;
          npc.xp         = xp;
          npc.maxHealth  = maxHealth;
          npc.npcLevel   = npcLevel;
          npc.statHealth  = statHealth;
          npc.statDamage  = statDamage;
          npc.statStamina = statStamina;
          npc.statWeight  = statWeight;
          npc.statPoints  = statPoints;
        }
      };

      // Handle PLAYER_STAT_UP broadcast: refresh world-state player fields
      this.networkManager.onPlayerStatUp = (_stat, _statLevel, xp,
          maxHealth, maxStamina, playerLevel, statHealth, statDamage, statStamina, statWeight, statPoints) => {
        const playerId = this.networkManager.getAssignedPlayerId();
        if (playerId === null) return;
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          const p = ws.players.find(pl => pl.id === playerId);
          if (!p) continue;
          if (xp !== undefined)         p.xp         = xp;
          if (playerLevel !== undefined) p.level      = playerLevel;
          if (maxHealth)                 p.maxHealth  = maxHealth;
          if (maxStamina)                p.maxStamina = maxStamina;
          if (statHealth !== undefined)  p.statHealth  = statHealth;
          if (statDamage !== undefined)  p.statDamage  = statDamage;
          if (statStamina !== undefined) p.statStamina = statStamina;
          if (statWeight !== undefined)  p.statWeight  = statWeight;
          if (statPoints !== undefined)  p.statPoints  = statPoints;
        }
      };

      // Handle npc_goto_module server response — flash green on success, red if occupied/invalid
      this.networkManager.onNpcMoveResult = (ok: boolean) => {
        const pos = this._pendingModuleFlashPos;
        this._pendingModuleFlashPos = null;
        if (!pos) return;
        if (ok) {
          this.renderSystem.flashInteract(pos);
        } else {
          this.renderSystem.flashCancel(pos);
        }
      };

      // Handle ENTITY_HIT: update NPC/player health and show floating damage number
      this.networkManager.onEntityHit = (entityType, id, x, y, damage, health, maxHealth, killed, killerShipId) => {
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          if (!ws) continue;
          if (entityType === 'npc') {
            const npc = ws.npcs.find(n => n.id === id);
            if (npc) { npc.health = health; npc.maxHealth = maxHealth; if (killed) npc.health = 0; }
          } else {
            const player = ws.players.find(p => p.id === id);
            if (player) { player.health = health; player.maxHealth = maxHealth; }
          }
        }
        // Determine team relationship for damage number colour
        const _hitWs = this.authoritativeWorldState ?? this.predictedWorldState;
        const _myId2  = this.networkManager.getAssignedPlayerId();
        const _myPlayer2 = _myId2 !== null ? _hitWs?.players.find(p => p.id === _myId2) : null;
        const _myCompany = _myPlayer2?.companyId ?? -1;
        let _dmgTeam: DamageTeam = 'enemy';
        if (killerShipId > 0 && _hitWs) {
          const _kShip = _hitWs.ships.find(s => s.id === killerShipId);
          if (_kShip && _myCompany !== -1 && _kShip.companyId === _myCompany) _dmgTeam = 'friendly';
        }
        this.renderSystem.spawnDamageNumber(Vec2.from(x, y), damage, killed, _dmgTeam);
        this.renderSystem.notifyEntityDamaged(id, entityType === 'npc');

        // Kill announcement — skip for the local player's own death (respawn screen handles that)
        if (killed) {
          const myId = this.networkManager.getAssignedPlayerId();
          const isLocalPlayerDeath = entityType === 'player' && myId !== null && id === myId;
          if (!isLocalPlayerDeath) {
            const ws = this.authoritativeWorldState ?? this.predictedWorldState;
            // Resolve killer ship: prefer server-provided ID, fall back to nearest ship
            let killerShip = killerShipId > 0 ? ws?.ships.find(s => s.id === killerShipId) : undefined;
            if (!killerShip && ws) {
              let bestDist = Infinity;
              for (const s of ws.ships) {
                const dx = s.position.x - x, dy = s.position.y - y;
                const d = dx * dx + dy * dy;
                if (d < bestDist) { bestDist = d; killerShip = s; }
              }
            }
            const killerName = killerShip ? (killerShip.shipName || 'Brigantine') : null;
            if (killerName) {
              let targetName: string;
              if (entityType === 'player') {
                const p = ws?.players.find(pl => pl.id === id);
                targetName = p?.name || `Player #${id}`;
              } else {
                const npc = ws?.npcs.find(n => n.id === id);
                targetName = npc?.name || `NPC #${id}`;
              }
              this.renderSystem.showAnnouncement(`${killerName} killed ${targetName}`, 'info', 3.0);
            }
          }
        }

        // Detect local player death → show respawn screen
        if (killed && entityType === 'player') {
          const myId = this.networkManager.getAssignedPlayerId();
          if (myId !== null && id === myId) {
            const ws = this.authoritativeWorldState || this.predictedWorldState;
            const me = ws?.players.find(p => p.id === myId);
            const companyId = me?.companyId ?? 0;
            const islands = this.renderSystem.getIslands();
            const ships = ws?.ships ?? [];
            const deathPos = me ? { x: me.position.x, y: me.position.y } : undefined;
            // Open immediately — the RespawnScreen's own fade-in animation handles the transition.
            this.uiManager.openRespawnScreen(ships, islands as unknown as IslandDef[], companyId, deathPos);
          }
        }
      };

      // Handle FIRE_EFFECT: mark entity/module as burning
      this.networkManager.onFireEffect = (entityType, id, x, y, durationMs, shipId, moduleId) => {
        this.renderSystem.notifyFireEffect(entityType, id, durationMs, shipId, moduleId);
      };

      // Handle ISLANDS: server-defined island layout
      this.networkManager.onIslands = (islands) => {
        this.renderSystem.setIslands(islands);
        this.uiManager.setIslandsForRespawn(islands);
        this.islandEditor?.setIslands(islands);
        // Expose islands on world states so client-side collision prediction can use them
        if (this.authoritativeWorldState) this.authoritativeWorldState.islands = islands;
        if (this.predictedWorldState) this.predictedWorldState.islands = islands;

        // (Re-)initialise the fog worker with the new island set.
        // Strip resources from the island data — the worker only needs geometry.
        this._fogWorker?.terminate();
        this._fogWorker = new Worker(
          new URL('../workers/FogWorker.ts', import.meta.url),
          { type: 'module' },
        );
        this._fogWorker.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          // Swap in the worker's result buffer directly — zero copy on the main thread.
          this._rayHitDist = new Float32Array(e.data);
        };
        this._fogWorker.postMessage({
          type: 'INIT',
          islands: islands.map(isl => ({
            x: isl.x, y: isl.y,
            vertices:      isl.vertices,
            grassVertices: isl.grassVertices,
            stonePolys:    isl.stonePolys,
          })),
        });
        this._fogWorkerReady = true;
      };

      // Update a resource's HP when the server broadcasts resource_damaged
      this.networkManager.onResourceDamaged = (islandId, ox, oy, hp, maxHp) => {
        const isl = this.renderSystem.getIslands().find(i => i.id === islandId);
        if (!isl) return;
        const res = isl.resources.find(r => Math.abs(r.ox - ox) < 0.5 && Math.abs(r.oy - oy) < 0.5);
        if (res) {
          res.hp = hp; res.maxHp = maxHp;
          if (hp <= 0 && !res.depletedAt) res.depletedAt = performance.now();
        }
      };

      this.networkManager.onResourceRespawned = (islandId, ri, ox, oy, hp, maxHp) => {
        const isl = this.renderSystem.getIslands().find(i => i.id === islandId);
        if (!isl) return;
        // Prefer index-based lookup; fall back to position match for robustness
        const res = isl.resources[ri] ?? isl.resources.find(r => Math.abs(r.ox - ox) < 0.5 && Math.abs(r.oy - oy) < 0.5);
        if (res) {
          res.hp = hp;
          res.maxHp = maxHp;
          res.depletedAt = undefined;
        }
      };

      // Handle placed structures
      this.networkManager.onStructuresList = (structs) => {
        this.renderSystem.setPlacedStructures(structs);
      };

      // Tombstone lifecycle
      this.networkManager.onTombstoneSpawned = (t) => {
        this.renderSystem.addTombstone(t);
      };
      this.networkManager.onTombstoneCollected = (id) => {
        this.renderSystem.removeTombstone(id);
        if (this.uiManager.tombstoneMenu.visible) this.uiManager.tombstoneMenu.close();
      };
      this.networkManager.onTombstoneDespawned = (id) => {
        this.renderSystem.removeTombstone(id);
        if (this.uiManager.tombstoneMenu.visible) this.uiManager.tombstoneMenu.close();
      };
      this.networkManager.onTombstoneItems = (id, ownerName, slots, _equip) => {
        const menu = this.uiManager.tombstoneMenu;
        const ws  = this.authoritativeWorldState ?? this.predictedWorldState;
        const pid = this.networkManager.getAssignedPlayerId();
        const inv = ws?.players.find(p => p.id === pid)?.inventory ?? null;
        menu.open(id, ownerName, slots);
        menu.setPlayerInventory(inv);
        menu.onTakeSlot = (tombId, slot) => {
          this.networkManager.sendTombstoneTakeSlot(tombId, slot);
        };
        menu.onTakeAll = (tombId) => {
          this.networkManager.sendCollectTombstone(tombId);
        };
      };
      this.networkManager.onStructureDemolished = (id, x, y) => {
        const _sdComp = this._structureCompanyMap.get(id) ?? -1;
        this._structureCompanyMap.delete(id);
        this._structureLastDamagedAt.delete(id);
        this.renderSystem.removePlacedStructure(id);
        if (x !== undefined && y !== undefined) {
          // Cannonball kill — big explosion
          this.renderSystem.spawnExplosion(Vec2.from(x, y), 1.2);
          const _sdMyId = this.networkManager.getAssignedPlayerId();
          const _sdWs = this.authoritativeWorldState ?? this.predictedWorldState;
          const _sdMyComp = _sdMyId !== null ? (_sdWs?.players.find(p => p.id === _sdMyId)?.companyId ?? -1) : -1;
          const _sdTeam: DamageTeam =
            _sdMyComp > 0 && _sdComp === _sdMyComp ? 'enemy' : 'friendly';
          this.renderSystem.spawnDamageNumber(Vec2.from(x, y), 25, true, _sdTeam);
        }
      };
      this.networkManager.onStructureCompanyUpdated = (id, companyId) => {
        this._structureCompanyMap.set(id, companyId);
        this.renderSystem.updateStructureCompany(id, companyId);
      };
      this.networkManager.onStructureHpChanged = (id, hp, maxHp, x, y, targetHp) => {
        const prev = this.renderSystem.updateStructureHp(id, hp, maxHp, targetHp);
        // Suppress damage FX (explosion + red damage number) when HP is going
        // up — this fires during repair ticks and shouldn't look like damage.
        const isRepairTick = prev !== null && hp >= prev.prevHp && (targetHp === undefined || targetHp >= prev.prevTargetHp);
        if (isRepairTick) return;
        // Real damage — stamp the time so the Repair radial option can apply
        // the 30s cooldown that the server enforces.
        this._structureLastDamagedAt.set(id, performance.now());
        this.renderSystem.spawnExplosion(Vec2.from(x, y), 0.6);
        const _shComp = this._structureCompanyMap.get(id) ?? -1;
        const _shMyId = this.networkManager.getAssignedPlayerId();
        const _shWs = this.authoritativeWorldState ?? this.predictedWorldState;
        const _shMyComp = _shMyId !== null ? (_shWs?.players.find(p => p.id === _shMyId)?.companyId ?? -1) : -1;
        const _shTeam: DamageTeam =
          _shMyComp > 0 && _shComp === _shMyComp ? 'enemy' : 'friendly';
        this.renderSystem.spawnDamageNumber(Vec2.from(x, y), 25, false, _shTeam);
      };
      this.networkManager.onTreeHit = (x, y) => {
        this.renderSystem.spawnExplosion(Vec2.from(x, y), 0.5);
      };
      this.networkManager.onStructurePlaced = (s) => {
        this._structureCompanyMap.set(s.id, s.companyId ?? 0);
        this.renderSystem.addPlacedStructure(s);
      };

      // Territory claim events
      this.networkManager.onTerritoryUpdate = (islandId, companyId, claimed, fortX, fortY, fortRadius, isCompanyFortress) => {
        if (claimed) {
          this.renderSystem.setIslandClaim(islandId, companyId, fortX, fortY, fortRadius, isCompanyFortress);
        } else {
          this.renderSystem.clearIslandClaim(islandId);
        }
      };
      this.networkManager.onTerritoryCaptured = (islandId, newCompanyId) => {
        this.renderSystem.setIslandClaim(islandId, newCompanyId);
        this.renderSystem.showAnnouncement(`🏰 Island ${islandId} captured!`, 'info', 3.0);
      };
      this.networkManager.onClaimFlagProgress = (structId, progressMs, contested, targetsFortress, state, graceMs) => {
        this.renderSystem.updateClaimFlagProgress(structId, progressMs, contested, targetsFortress, state, graceMs);
        // Notify on claim-state transitions if the player is near the affected island
        const prevState = this._claimFlagStates.get(structId);
        if (state !== undefined) this._claimFlagStates.set(structId, state);
        if (prevState !== undefined && prevState !== state) {
          const struct = this.renderSystem.getPlacedStructureById?.(structId);
          const islandId = struct?.islandId ?? 0;
          if (islandId && this._isPlayerNearIsland(islandId)) {
            if (state === 2) {
              this.renderSystem.showAnnouncement(`🚩 Claim advancing on island ${islandId}`, 'info', 3.0);
            } else if (state === 0) {
              this.renderSystem.showAnnouncement(`⚔️ Claim contested on island ${islandId}`, 'info', 3.0);
            } else if (state === 4) {
              this.renderSystem.showAnnouncement(`↺ Claim reversing on island ${islandId}`, 'info', 3.0);
            }
          }
        }
      };
      this.networkManager.onTerritoryFlipped = (_flagId, orphanedId, oldCompanyId, newCompanyId, islandId) => {
        // Immediate visual flip: mark the captured source structure as orphaned so its
        // claim radius (and any contested-area hatching it implies) disappears right away,
        // without waiting for the next full snapshot.
        if (orphanedId) this.renderSystem.setStructureClaimOrphaned(orphanedId, true);
        this.renderSystem.showAnnouncement(
          `🏴 Territory flipped on island ${islandId}: company ${oldCompanyId} → ${newCompanyId}`,
          'info', 4.0,
        );
      };
      this.networkManager.onStructureDominators = (structureId, dominators) => {
        this.renderSystem.setStructureDominators(structureId, dominators);
      };
      this.networkManager.onFortressBuildProgress = (structId, companyId, islandId, progressMs, totalMs, contested) => {
        this.renderSystem.updateFortressBuildProgress(structId, companyId, islandId, progressMs, totalMs, contested);
      };
      this.networkManager.onFortressComplete = (structId, companyId, islandId) => {
        // Defensive: ignore if this id is actually a flag fort (server should
        // never emit `fortress_complete` for flag forts — they use the
        // dedicated `flag_fort_active` event — but guard anyway).
        const ps = this.renderSystem.getPlacedStructureById?.(structId);
        if (ps && ps.type === 'flag_fort') return;
        this.renderSystem.onFortressComplete(structId, companyId, islandId);
        this.renderSystem.showAnnouncement(`🏰 Company Fortress complete! Island ${islandId} claimed!`, 'info', 5.0);
      };
      this.networkManager.onFortressCaptured = (structId, newCompanyId, _oldCompanyId, islandId) => {
        this.renderSystem.onFortressCaptured(structId, newCompanyId, islandId);
        this.renderSystem.showAnnouncement(`⚔️ Company Fortress captured! Island ${islandId} changing hands…`, 'info', 5.0);
      };
      this.networkManager.onFlagFortActive = (structId, _companyId, islandId, active, claimPhase) => {
        this.renderSystem.onFlagFortActive(structId, active, claimPhase);
        if (active) {
          this.renderSystem.showAnnouncement(`🚩 Flag Fort active on island ${islandId}`, 'info', 3.0);
        } else {
          this.renderSystem.showAnnouncement(`🚩 Flag Fort deactivated on island ${islandId}`, 'info', 3.0);
        }
      };
      this.networkManager.onFlagFortBuildProgress = (structId, hp, maxHp, contested, active, claimPhase, claimProgressMs, claimTotalMs, claimState, claimGraceMs, targetHp) => {
        this.renderSystem.updateFlagFortBuildProgress(structId, hp, maxHp, contested, active, claimPhase, claimProgressMs, claimTotalMs, claimState, claimGraceMs, targetHp);
      };
      this.networkManager.onPlacementFailed = (reason, _x, _y, _structureType, blockerId) => {
        const REASONS: Record<string, string> = {
          occupied:          'Space already occupied',
          blocked_by_tree:   'Blocked by a tree',
          blocked_by_boulder: 'Blocked by a boulder',
          needs_floor:       'Must be placed on a floor',
          needs_floor_edge:  'Must snap to a floor edge',
          needs_door_frame:  'Requires a door frame',
          wrong_company:     'Belongs to another company',
          enemy_territory:       'Enemy territory',
          not_in_my_territory:     'Not inside your claimed area',
          not_in_contested_area:   'Not in a contested area (need overlapping enemy claim)',
          contested_area_already_claimed: 'Contested area already has your claim flag',
          slice_already_owned:     'Your company already owns this slice',
          island_already_claimed: 'Island already claimed',
          fort_exists:            'Company fort limit reached (max 3 per island)',
          not_on_island:          'Must be placed on an island',
          not_contested_territory: 'Not in contested territory',
          not_in_fort_radius:      'Must be placed within an enemy fort or fortress radius',
          not_in_fort_or_fortress_radius: 'Must be inside an enemy fort or fortress radius',
          no_flag_fort:            'Your company has no flag fort',
          blocked_by_player: 'Blocked by a player',
          too_far:           'Too far away',
          in_water:          'Cannot place in water',
          world_full:        'World structure limit reached',
          missing_item:      'Missing required item',
        };
        const msg = REASONS[reason] ?? `Placement failed (${reason})`;
        this.renderSystem.showAnnouncement(`\u{1F6A7} ${msg}`, 'info', 2.0);
        this.renderSystem.setBlockerStructure(blockerId ?? null, 2000);
      };
      this.networkManager.onDoorToggled = (id, open) => {
        this.renderSystem.updateStructureDoorOpen(id, open);
      };
      this.networkManager.onDoorLockToggled = (id, locked, open) => {
        this.renderSystem.updateStructureDoorLocked(id, locked, open);
      };
      this.networkManager.onCraftingOpen = (structureId, structureType) => {
        if (structureType === 'shipyard') {
          // Fallback if server still sends crafting_open for shipyard (pre-update)
          this.shipyardMenu.open(structureId, 'empty', []);
          this.uiManager.setActiveMenuId(MENU_ID.SHIPYARD);
        } else {
          this.craftingMenu.open(structureId);
          this.uiManager.setActiveMenuId(MENU_ID.CRAFTING);
        }
      };

      this.networkManager.onShipyardState = (structureId, phase, modulesPlaced, shipSpawned, scaffoldedShipId) => {
        this.renderSystem.updateShipyardConstruction(structureId, phase, modulesPlaced, scaffoldedShipId);
        if (this.shipyardMenu.visible && this.shipyardMenu.structureId === structureId) {
          this.shipyardMenu.updateState(phase, modulesPlaced);
        }
        // Don't auto-open the menu on broadcast — player opens it with E or
        // installs modules by clicking on the skeleton directly.
        if (shipSpawned) {
          this.shipyardMenu.close();
          this.uiManager.setActiveMenuId(null);
          this.renderSystem.showAnnouncement('⚓ Ship released!', 'info', 3.5);
          // Open custom rename dialog for the newly-launched ship
          this.renameDialog.open(shipSpawned, '');
        }
      };

      this.shipyardMenu.onAction = (action, module) => {
        if (this.shipyardMenu.structureId == null) return;
        this.networkManager.sendShipyardAction(this.shipyardMenu.structureId, action, module);
      };

      this.craftingMenu.onCraft = (recipeId) => {
        this.networkManager.sendCraftItem(recipeId);
      };

      this.networkManager.onCraftResult = (success, recipeId, reason) => {
        if (success) {
          this.renderSystem.showAnnouncement(`\u2692 Crafted ${recipeId.replace('craft_', '')}!`, 'info', 2.5);
        } else {
          const msg: Record<string, string> = {
            missing_ingredients: 'Not enough materials',
            inventory_full:      'Inventory is full',
            not_at_workbench:    'Must be at a workbench',
            unknown_recipe:      'Unknown recipe',
          };
          this.renderSystem.showAnnouncement(`\u2692 ${msg[reason ?? ''] ?? 'Cannot craft right now'}`, 'info', 2.0);
        }
      };

      // ── Structure repair feedback ─────────────────────────────────────
      this.networkManager.onRepairStarted = (_id, _pid, _hp, _maxHp, _tHp) => {
        this.renderSystem.showAnnouncement('\ud83d\udd27 Repair started', 'info', 1.5);
      };
      this.networkManager.onRepairCancelled = (_id, _pid) => {
        this.renderSystem.showAnnouncement('\ud83d\udd27 Repair cancelled', 'info', 1.5);
      };
      this.networkManager.onRepairComplete = (_id, _pid) => {
        this.renderSystem.showAnnouncement('\ud83d\udd27 Repair complete', 'info', 1.5);
      };
      this.networkManager.onRepairFail = (_id, reason) => {
        const msg: Record<string, string> = {
          insufficient_resources: 'Not enough materials to repair',
          already_full:           'Structure is already fully repaired',
          in_progress:            'Repair already in progress',
          too_far:                'Too far to repair',
          wrong_company:          'Cannot repair another company\u2019s structure',
          not_repairable:         'This structure cannot be repaired',
          claiming:               'Cannot repair during claim phase',
          recently_damaged:       'Recently damaged \u2014 wait before repairing',
          not_found:              'Structure not found',
        };
        this.renderSystem.showAnnouncement(`\ud83d\udd27 ${msg[reason] ?? 'Repair failed'}`, 'info', 2.0);
      };

      // Handle FLAME_CONE_FIRE / FLAME_WAVE_UPDATE: advancing/retreating cone visual
      this.networkManager.onFlameWaveUpdate = (cannonId, shipId, x, y, angle, halfCone, waveDist, retreating, retreatDist, dead) => {
        this.renderSystem.updateFlameWave(cannonId, shipId, x, y, angle, halfCone, waveDist, retreating, retreatDist, dead);
      };

      // Handle CANNON_FIRE_EVENT: muzzle flash + hit-scan tracers for grapeshot / canister
      this.networkManager.onCannonFireEvent = (_cannonId, _shipId, x, y, angle, projectileId, ammoType) => {
        // Muzzle flash for every cannon fire
        this.renderSystem.spawnMuzzleFlash(x, y, angle);
        // Only spawn tracers for hit-scan ammo types (no real projectile, id=0)
        if (projectileId === 0 && (ammoType === 10 || ammoType === 12)) {
          this.renderSystem.spawnGrapeshotTracers(x, y, angle, ammoType);
        }
      };

      // Handle FIRE_EXTINGUISHED: clear burning state
      this.networkManager.onFireExtinguished = (entityType, id, shipId, moduleId) => {
        this.renderSystem.notifyFireExtinguished(entityType, id, shipId, moduleId);
        // Clear sail fire intensity when a mast module is extinguished
        if (entityType === 'module' && shipId !== undefined && moduleId !== undefined) {
          const ws = this.authoritativeWorldState || this.predictedWorldState;
          const ship = ws?.ships.find(s => s.id === shipId);
          const mod = ship?.modules.find(m => m.id === moduleId && m.kind === 'mast');
          if (mod?.moduleData?.kind === 'mast') {
            mod.moduleData.sailFireIntensity = 0;
          }
        }
      };

      // Handle SAIL_FIBER_FIRE: update mast module fire intensity in real time
      this.networkManager.onSailFiberFire = (shipId, moduleId, intensity, fiberHealth, windEff) => {
        const ws = this.authoritativeWorldState || this.predictedWorldState;
        const ship = ws?.ships.find(s => s.id === shipId);
        const mod  = ship?.modules.find(m => m.id === moduleId && m.kind === 'mast');
        if (mod?.moduleData?.kind === 'mast') {
          mod.moduleData.sailFireIntensity = intensity;
          mod.moduleData.fiberHealth       = fiberHealth;
          mod.moduleData.windEfficiency    = windEff;
        }
      };

      this.networkManager.onLadderState = (shipId, moduleId, retracted) => {
        const ws = this.authoritativeWorldState || this.predictedWorldState;
        if (!ws) return;
        const ship = ws.ships.find(s => s.id === shipId);
        if (!ship) return;
        const mod = ship.modules.find(m => m.id === moduleId);
        if (!mod || mod.kind !== 'ladder' || !mod.moduleData || mod.moduleData.kind !== 'ladder') return;
        mod.moduleData.extended = !retracted;
        console.log(`🪤 Ladder ${moduleId} on ship ${shipId}: ${retracted ? 'retracted' : 'extended'}`);
      };

      // Handle SWORD_SWING: show arc for other players' attacks;
      // for own player use it to re-sync the cooldown ring to the server-confirmed timestamp.
      this.networkManager.onSwordSwing = (playerId, x, y, angle, _range) => {
        const myId = this.networkManager.getAssignedPlayerId();
        if (playerId === myId) {
          // Server confirmed the swing — re-anchor cooldown to now so the ring
          // stays in sync even if there's clock drift or the attack was delayed.
          this.swordLastAttackMs = performance.now();
          this.renderSystem.notifySwordSwing(this.SWORD_COOLDOWN_MS);
          return;
        }
        this.renderSystem.spawnSwordArc(Vec2.from(x, y), angle);
      };

      // Build mode item selection (cannon/sail buttons in build mode panel)
      this.uiManager.onBuildItemSelect = (item) => {
        this.buildSelectedItem = item;
        this.syncBuildModeState();
      };

      // Weapon group mode cycling (right-click on hotbar slot while on helm)
      this.uiManager.onGroupModeChange = (groupIndex: number, mode: WeaponGroupMode) => {
        const state = this.controlGroups.get(groupIndex);
        if (state) {
          state.mode = mode;
          if (mode !== 'targetfire') state.targetId = -1; // clear lock when leaving targetfire
          console.log(`🎯 Group G${groupIndex} mode → ${mode}`);
          // Keep InputManager.activeGroupMode in sync if this is the active group
          if (this.inputManager && this.inputManager.activeWeaponGroup === groupIndex) {
            this.inputManager.activeGroupMode = mode;
          }
          // Sync mode change to server
          this.networkManager.sendCannonGroupConfig(groupIndex, mode, state.cannonIds, 0);
        }
      };

      // Build panel: player selected a module type for ghost placement
      // This unequips any matching hotbar item and attaches a ghost to the cursor.
      this.uiManager.onBuildPanelSelect = (kind: GhostModuleKind) => {
        const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        const playerId = this.networkManager?.getAssignedPlayerId();
        const player = ws?.players.find(p => p.id === playerId);
        if (player) {
          // Always go to unequipped state (255) when entering ghost placement —
          // so no hotbar item is active and we don't accidentally build the real thing.
          if ((player.inventory?.activeSlot ?? 255) !== 255) {
            for (const ws2 of [this.authoritativeWorldState, this.predictedWorldState]) {
              const p2 = ws2?.players.find(pl => pl.id === playerId);
              if (p2) p2.inventory.activeSlot = 255;
            }
            this.networkManager.sendUnequip();
          }
        }
        // Exit free-placement mode — this is now a ghost-only action
        this.explicitBuildMode = false;
        this.pendingGhostKind = kind;
        this.buildRotationDeg = 0;
        this.syncBuildModeState();
        console.log(`🏗️ [GHOST] Picking up ghost: ${kind} — click on ship to place`);
      };
      
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

      // Set up zoom buttons
      this.setupZoomButtons();

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
  async start(playerName?: string, accessToken?: string, guest = false): Promise<void> {
    if (this.running) {
      console.warn('⚠️ Client is already running');
      return;
    }
    
    try {
      console.log('🚀 Starting client application...');

      // Configure pause menu for guest vs permanent account
      this.pauseMenu.setGuest(guest);
      this.pauseMenu.onAccountCreated = (displayName: string) => {
        console.log(`✅ Guest converted to permanent account: ${displayName}`);
        this.pauseMenu.setGuest(false);
      };
      
      // Try to connect to server, but continue even if it fails
      this.state = ClientState.CONNECTING;
      this.setLoadingStep(1);
      try {
        await this.networkManager.connect(playerName ?? 'Player', accessToken);
        this._loadingConnectedAt = Date.now();
        this.setLoadingStep(2);
        console.log('✅ Connected to physics server');
      } catch (serverError) {
        console.warn('⚠️ Could not connect to physics server:', serverError);
        console.log('🎮 Running in offline mode - UI and local systems will work');
        this.state = ClientState.DISCONNECTED;
        // Create demo world state for offline testing
        this.demoWorldState = this.createDemoWorldState();
        this.hideLoadingOverlay();
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
   * Apply live settings changes from the pause menu.
   * Currently handles audio volume and input bindings; graphics/FPS settings take effect on next load.
   */
  private applySettings(settings: GameSettings): void {
    this.audioManager?.setVolumes(
      settings.masterVolume,
      settings.sfxVolume,
      settings.musicVolume,
    );

    // Rebuild action mappings so rebound keys take effect immediately
    if (this.inputManager) {
      const cfg = ClientConfigManager.load();
      this.inputManager.updateConfig(cfg.input);
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
    this._lastDeltaMs = deltaTime;
    
    // Cap delta time to prevent spiral of death
    const clampedDelta = Math.min(deltaTime, 100); // Max 100ms
    this.updateAdaptiveGLScale(clampedDelta, currentTime);
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

    // Re-derive the mouse world position from the current (unchanged) screen position every
    // frame so player movement toward the mouse keeps working even when the camera pans
    // (i.e. the mouse hasn't physically moved but the world under it has shifted).
    const mouseScreen = this.inputManager.getMouseScreenPosition();
    const mouseWorld  = this.camera.screenToWorld(mouseScreen);
    this.inputManager.updateMouseWorldPosition(mouseWorld);
    // Suppress hover detection while the respawn screen is up so modules/resources
    // don't flicker with highlight glows through the overlay.
    const _respawnOpen = this.uiManager?.isRespawnScreenVisible() ?? false;
    this.renderSystem.updateMousePosition(_respawnOpen ? Vec2.from(-999999, -999999) : mouseWorld);
    this.inputManager.update(dt);
    
    // Update prediction engine (client-side simulation)
    if (this.authoritativeWorldState && this.state === ClientState.IN_GAME) {
      // Step the ship predictor every fixed tick (mirrors server physics rate)
      this.shipPredictor?.step(dt);

      this.predictedWorldState = this.predictionEngine.update(
        this.authoritativeWorldState,
        this.inputManager.getCurrentInputFrame(),
        dt
      );
      
      // Update camera based on interpolated state so it tracks the same smoothed
      // position that the renderer uses, avoiding the 20 Hz snap from raw server data.
      if (this.predictedWorldState) {
        const _cameraFollowState =
          this.predictionEngine.getInterpolatedState(performance.now()) ?? this.predictedWorldState;
        this.updateCamera(_cameraFollowState, dt);
        
        // Update input manager with current player position and velocity for hybrid protocol
        const assignedPlayerId = this.networkManager.getAssignedPlayerId();
        const player = assignedPlayerId !== null 
          ? this.predictedWorldState.players.find(p => p.id === assignedPlayerId)
          : this.predictedWorldState.players[0];
        
        if (player) {
          this.inputManager.setPlayerPosition(player.position);
          this.inputManager.setPlayerVelocity(player.velocity); // For stop detection
          this.inputManager.setPlayerStamina(player.stamina ?? player.maxStamina ?? 100);
          this.renderSystem.playerInteractInfo = {
            worldPos: player.position,
            localPos: player.localPosition ?? null,
            carrierId: player.carrierId ?? null,
          };

          // --- Dynamic view-range / AOI ---
          // Cast rays against island coastlines to compute per-direction visibility
          // distances. Used for the fog mask (RenderSystem) and server AOI hint.
          if (this._fogWorkerReady && this._fogWorker) {
            // Off-thread: dispatch position to worker, use previous frame's result now.
            this._fogWorker.postMessage({ type: 'COMPUTE', x: player.position.x, y: player.position.y });
          } else {
            // Fallback: synchronous (before first ISLANDS message, or if worker unavailable).
            const islands = this.renderSystem.getIslands();
            this.computeViewRays(player.position, islands);
          }

          // Smooth openness so the fog/zoom doesn't jitter when near a polygon edge
          const N = ClientApplication.VIEW_RAY_COUNT;
          const MAX_D = ClientApplication.MAX_VIEW_DIST;
          let raySum = 0;
          for (let _i = 0; _i < N; _i++) raySum += this._rayHitDist[_i];
          const rawOpenness = raySum / (N * MAX_D);
          this._viewOpenness += (rawOpenness - this._viewOpenness) * (1 - Math.pow(0.05, dt));

          // Pass ray data to render system so it can draw the fog mask this frame
          this.renderSystem.fogRayHitDist = this._rayHitDist;

          // Expose average view distance for server AOI hint (client units)
          this.networkManager.viewRadius = raySum / N;
        }
      }
      
      // Update module interactions
      this.moduleInteractionSystem.update(this.predictedWorldState || this.authoritativeWorldState, dt);
    }

    // Update island cannon aim angle for barrel rendering
    if (this.inputManager.isOnIslandCannon) {
      this.renderSystem.islandCannonId = this.inputManager.mountedCannonModuleId;
      this.renderSystem.islandCannonAimAngle = this.inputManager.getLastCannonAimAngle();
    } else {
      // On the frame we transition from mounted→unmounted, persist the last live aim
      // into placedStructures so the fallback renderer shows the correct angle.
      if (this.renderSystem.islandCannonId !== null && this.renderSystem.islandCannonAimAngle !== null) {
        this.renderSystem.updateStructureCannonAim(this.renderSystem.islandCannonId, this.renderSystem.islandCannonAimAngle);
      }
      this.renderSystem.islandCannonId = null;
      this.renderSystem.islandCannonAimAngle = null;
    }

    // Commit pending ammo type once the cannon finishes reloading.
    // loadedAmmoType stays at the old value during the reload cycle so the aim guide
    // shows what's actually in the barrel, not the queued selection.
    if (this.inputManager.selectedAmmoType !== this.inputManager.loadedAmmoType) {
      const world = this.predictedWorldState ?? this.authoritativeWorldState;
      const mountKind = this.inputManager.getMountKind();

      if (this.inputManager.isOnIslandCannon) {
        const cannonId = this.inputManager.mountedCannonModuleId;
        if (cannonId !== null && !this.renderSystem.isIslandCannonReloading(cannonId)) {
          this.inputManager.loadedAmmoType = this.inputManager.selectedAmmoType;
        }
      } else if (mountKind === 'cannon' || mountKind === 'helm') {
        const playerId = this.networkManager.getAssignedPlayerId();
        const player = world?.players.find(p => p.id === playerId);
        const ship = player?.carrierId ? world?.ships.find(s => s.id === player.carrierId) : null;
        if (ship) {
          if (mountKind === 'cannon') {
            // Single cannon: wait for this specific module's reload to clear
            const mod = ship.modules.find(m => m.id === this.inputManager.mountedCannonModuleId);
            const isReloading = ((mod?.moduleData as { stateBits?: number } | undefined)?.stateBits ?? 0) & 16;
            if (!isReloading) this.inputManager.loadedAmmoType = this.inputManager.selectedAmmoType;
          } else {
            // Helm: all ship cannons were force-reloaded — wait until none are reloading
            const anyReloading = ship.modules.some(
              m => m.kind === 'cannon' && (((m.moduleData as { stateBits?: number } | undefined)?.stateBits ?? 0) & 16));
            if (!anyReloading) this.inputManager.loadedAmmoType = this.inputManager.selectedAmmoType;
          }
        }
      }
    }
  }
  
  /**
   * Variable timestep updates (UI, audio, particles)
   */
  private updateVariableTimestep(deltaTime: number): void {
    const dt = deltaTime / 1000;

    // Auto-disable combat mode after 10 s of no combat actions
    if (this.combatMode && performance.now() - this.lastCombatActionMs > 10_000) {
      this.combatMode = false;
    }

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
    
    // Only use hybrid rendering if prediction is enabled
    const predictionEnabled = this.config.prediction.enablePrediction;
    
    // If we have both predicted and interpolated states AND prediction is enabled, create hybrid
    // Local player uses prediction (instant response), others use interpolation (smooth)
    if (predictionEnabled && assignedPlayerId !== null && this.predictedWorldState && interpolatedState) {
      const predictedPlayer = this.predictedWorldState.players.find(p => p.id === assignedPlayerId);
      const interpolatedPlayer = interpolatedState.players.find(p => p.id === assignedPlayerId);
      
      if (predictedPlayer && interpolatedPlayer) {
        // Get current rotation from input manager
        const currentRotation = this.inputManager.getCurrentInputFrame().rotation;
        
        // Splice predicted player in — avoid allocating N player objects when only 1 changes.
        const localIdx = interpolatedState.players.findIndex(p => p.id === assignedPlayerId);
        if (localIdx >= 0) {
          const newPlayers = interpolatedState.players.slice(); // 1 array alloc
          newPlayers[localIdx] = { ...predictedPlayer, rotation: currentRotation }; // 1 player alloc
          worldToRender = { ...interpolatedState, players: newPlayers };
        } else {
          worldToRender = interpolatedState;
        }
      }
    }
    
    // Splice ShipPredictor output — use physics-accurate predicted position/rotation/velocity
    // for the local player's ship, same pattern as the player prediction splice above.
    if (predictionEnabled && assignedPlayerId !== null && worldToRender) {
      const predictedShip = this.shipPredictor?.getPredictedShip();
      if (predictedShip) {
        const myPlayer = worldToRender.players.find(p => p.id === assignedPlayerId);
        if (myPlayer?.carrierId) {
          const shipIdx = worldToRender.ships.findIndex(s => s.id === myPlayer.carrierId);
          if (shipIdx >= 0) {
            const newShips = worldToRender.ships.slice();
            newShips[shipIdx] = {
              ...worldToRender.ships[shipIdx], // keep server data (modules, health, etc.)
              position:        predictedShip.position,
              velocity:        predictedShip.velocity,
              rotation:        predictedShip.rotation,
              angularVelocity: predictedShip.angularVelocity,
            };
            worldToRender = { ...worldToRender, ships: newShips };
          }
        }
      }
    }

    // Overlay any locally-placed optimistic modules (needed in online mode where
    // worldToRender comes from the interpolation engine and wouldn't include them)
    if (worldToRender && this.localPendingModules.size > 0) {
      const now = Date.now();
      let anyPending = false;
      const overlaid = worldToRender.ships.map(ship => {
        let entries = this.localPendingModules.get(ship.id);
        if (!entries) return ship;
        // Expire old entries
        entries = entries.filter(e => e.expiry > now);
        if (entries.length === 0) { this.localPendingModules.delete(ship.id); return ship; }
        this.localPendingModules.set(ship.id, entries);
        anyPending = true;
        // Don't add duplicates — skip if server already sent a module of the SAME KIND at same spot
        const newMods = entries
          .map(e => e.module)
          .filter(pm => !ship.modules.some(m =>
            m.kind === pm.kind &&
            Math.abs(m.localPos.x - pm.localPos.x) < 5 &&
            Math.abs(m.localPos.y - pm.localPos.y) < 5
          ));
        if (newMods.length === 0) return ship;
        return { ...ship, modules: [...ship.modules, ...newMods] };
      });
      if (anyPending) worldToRender = { ...worldToRender, ships: overlaid };
    }

    if (!worldToRender) {
      // Render loading/connection screen
      this.renderSystem.renderLoadingScreen(this.state, this.camera);
    } else {
      // Pass aiming state so cannon aim guides only draw when actively aiming
      this.renderSystem.playerIsAiming = this.inputManager?.isRightMouseDown ?? false;
      this.renderSystem.cameraMode = this._rotateCamActive ? 'rotate' : this._freeCameraMode ? 'free' : null;
      this.renderSystem.localPlayerId = assignedPlayerId;
      this.renderSystem.playerAimAngleRelative = this.inputManager?.cannonAimAngleRelative ?? 0;
      // Use the loaded ammo type (physically in the barrel) so the aim guide shows
      // the trajectory of what will actually fire, not the pending GUI selection.
      this.renderSystem.selectedAmmoType = this.inputManager?.getLoadedAmmoType() ?? 0;
      this.renderSystem.npcTaskMap = this.uiManager.getNpcTaskMap();
      this.renderSystem.controlGroups = this.controlGroups as Map<number, { cannonIds: number[]; mode: string }>;
      this.renderSystem.showGroupOverlay = this.inputManager?.isCtrlHeld() ?? false;
      this.renderSystem.activeWeaponGroups = this.inputManager?.activeWeaponGroups ?? new Set();
      this.renderSystem.npcIgnoreSet = this._npcIgnoreSet;
      this.renderSystem.selectedNpcIds = new Set(this._selectedNpcIds);

      // Resolve local player once — reused by sword equip check, cursor cooldown ring, and UI render.
      const localPlayer = assignedPlayerId !== null
        ? worldToRender.players.find(p => p.id === assignedPlayerId) ?? null
        : null;

      // Sword cooldown ring: only visible when sword is the active item and player is unmounted
      const _activeSlot  = localPlayer?.inventory?.activeSlot ?? 0;
      this.renderSystem.swordEquipped =
        (localPlayer?.inventory?.slots[_activeSlot]?.item === 'sword') &&
        !(localPlayer?.isMounted ?? false);
      this.renderSystem.axeEquipped =
        (localPlayer?.inventory?.slots[_activeSlot]?.item === 'axe') &&
        !(localPlayer?.isMounted ?? false);
      if (this.explicitBuildMode) this.syncBuildModeState();

      // Sync tombstones into the render system on every frame
      this.renderSystem.updateTombstones(worldToRender.tombstones ?? []);

      // Sync dropped items into the render system on every frame
      this.renderSystem.updateDroppedItems(worldToRender.droppedItems ?? []);

      // Keep render-side world-wrap config in sync with authoritative map settings.
      this.renderSystem.setWorldWrapConfig(
        this.networkManager.mapWrap,
        this.networkManager.mapWidth,
        this.networkManager.mapHeight,
      );

      // Render game world with hybrid state
      if (this._glRenderer) {
        const camState = this.camera.getState();
        this.renderSystem.beginGLFrame(camState.position.x, camState.position.y, camState.zoom, this._lastDeltaMs, camState.rotation);
      }
      this.renderSystem.renderWorld(worldToRender, this.camera, alpha);
      if (this._glRenderer) {
        this.renderSystem.endGLFrame();
      }

      // Island editor overlay (dev tool)
      if (this.islandEditor?.visible) {
        this.islandEditor.render(this.renderSystem.getContext(), this.camera);
      }

      // Update sword cooldown cursor ring
      if (this.inputManager) {
        const mp = this.inputManager.getMouseScreenPosition();
        this.uiManager.setMousePos(mp.x, mp.y);

        // Pass sword cooldown state so RenderSystem can draw the cursor ring
        const activeSlot2 = localPlayer?.inventory?.activeSlot ?? 0;
        const activeItem2 = localPlayer?.inventory?.slots[activeSlot2]?.item ?? 'none';
        if (activeItem2 === 'sword') {
          this.renderSystem.updateSwordCooldownCursor(mp, this.swordLastAttackMs, this.SWORD_COOLDOWN_MS);
        } else {
          this.renderSystem.updateSwordCooldownCursor(null, 0, this.SWORD_COOLDOWN_MS);
        }
      }

      // Update island build mode overlay state
      if (this.islandBuildMode) {
        const activeSlotB = localPlayer?.inventory?.activeSlot ?? 0;
        const islandBuildKind = (localPlayer?.inventory?.slots[activeSlotB]?.item ?? 'wooden_floor') as 'wooden_floor' | 'workbench';
        this.uiManager.setIslandBuildState({
          kind: islandBuildKind,
          tooFar: this.renderSystem.getIslandBuildTooFar(),
          enemyClose: false, // TODO: detect when enemies are nearby
        });
      } else {
        this.uiManager.setIslandBuildState(null);
      }

      // Render UI overlay
      const playerShipId = localPlayer?.carrierId ?? 0;
      const playerShip = playerShipId
        ? (worldToRender.ships.find(s => s.id === playerShipId) ?? null)
        : null;
      this.uiManager.render(this.renderSystem.getContext(), {
        worldState: worldToRender,
        camera: this.camera,
        fps: this.currentFPS,
        frameMs: this._lastDeltaMs,
        glDrawCalls: this.renderSystem.glDrawCallCount,
        glScalePct: this._glRenderer ? Math.round(this._glScale * 100) : 0,
        networkStats: this.networkManager.getStats(),
        config: this.config,
        assignedPlayerId,
        playerShipId,
        selectedAmmoType: this.inputManager?.getLoadedAmmoType() ?? 0,
        pendingAmmoType: this.inputManager?.selectedAmmoType ?? 0,
        mountKind: this.inputManager?.getMountKind() ?? 'none',
        activeAmmoGroup: this.inputManager?.activeAmmoGroup ?? 'cannon',
        activeWeaponGroup: this.inputManager?.activeWeaponGroup ?? -1,
        activeWeaponGroups: this.inputManager?.activeWeaponGroups,
        playerShip,
        controlGroups: this.controlGroups,
        windAngle: this.networkManager.windAngle,
        debugMode: this.uiManager.isDebugMode,
        combatMode: this.combatMode,
        altHeld: this.inputManager?.isAltHeld() ?? false,
      });

      // Crafting menu (rendered on top of all other UI)
      if (this.craftingMenu.visible) {
        this.craftingMenu.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
          localPlayer?.inventory ?? null,
        );
      }
      // Shipyard construction menu
      if (this.shipyardMenu.visible) {
        this.shipyardMenu.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
        );
      }
      // Rename dialog — topmost overlay
      if (this.renameDialog?.visible) {
        this.renameDialog.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
        );
      }

      // Hover debug HUD — rendered last so it always appears above all UI layers
      this.renderSystem.renderHoverDebugHUD();

      // Ship debug panel — DOM overlay, updated every frame when visible
      this._updateShipDebugPanel();

      // Reconnecting overlay — sits above everything when disconnected mid-game
      if (this.state === ClientState.DISCONNECTED) {
        this.renderSystem.drawReconnectingOverlay();
      }
    }
  }
  
  /**
   * Update camera based on world state
   */
  /**
   * Cast VIEW_RAY_COUNT rays from `pos` in all directions and record the nearest
   * island-polygon edge hit distance for each ray (world units).
   * Ocean costs 1 budget-unit/world-unit; land costs 2 (half range through land).
   * Results are written into this._rayHitDist in-place.
   */

  /** Ray-cast point-in-polygon test (winding / crossing number). */
  private static pointInPolygon(p: {x: number; y: number}, verts: {x: number; y: number}[]): boolean {
    let inside = false;
    const n = verts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = verts[i].x, yi = verts[i].y;
      const xj = verts[j].x, yj = verts[j].y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  private computeViewRays(pos: {x: number; y: number}, islands: ReturnType<typeof this.renderSystem.getIslands>): void {
    const N      = ClientApplication.VIEW_RAY_COUNT;
    const MAX_D  = ClientApplication.MAX_VIEW_DIST;
    const TWO_PI = Math.PI * 2;
    const result = this._rayHitDist;

    // Pre-filter islands within range; compute per-island player-inside flags (coast, grass, stone)
    const nearIslands:  ReturnType<typeof this.renderSystem.getIslands> = [];
    const insideCoast:  boolean[] = [];
    const insideGrass:  boolean[] = [];
    const insideStone:  boolean[] = [];
    for (const isl of islands) {
      if (!isl.vertices || isl.vertices.length < 3) continue;
      const cdx = isl.x - pos.x, cdy = isl.y - pos.y;
      if (cdx * cdx + cdy * cdy > MAX_D * MAX_D * 4) continue;
      nearIslands.push(isl);
      const pip = ClientApplication.pointInPolygon(pos, isl.vertices);
      insideCoast.push(pip);
      insideGrass.push(
        pip && !!isl.grassVertices && isl.grassVertices.length >= 3
          && ClientApplication.pointInPolygon(pos, isl.grassVertices)
      );
      insideStone.push(
        !!(isl.stonePolys?.some(sp => sp.length >= 3 && ClientApplication.pointInPolygon(pos, sp)))
      );
    }

    // For fallback islands (no grassVertices), the outer coast IS the grass boundary —
    // the whole interior is treated as the grass zone.  This ensures rays going deeper
    // into such islands correctly use cost 3, not cost 1.
    const fallbackInlandPlayer = nearIslands.some((isl, ni) =>
      insideCoast[ni] && (!isl.grassVertices || isl.grassVertices.length < 3)
    );
    const playerInGrass = insideGrass.some(Boolean) || fallbackInlandPlayer;
    const playerInStone = insideStone.some(Boolean);

    // Event kinds (coast events for hasGrass islands are omitted — beach cost === ocean cost = 1):
    //   1 = grassVertices boundary  → toggles inGrass  (cost 3 inside)
    //   2 = stone polygon boundary  → toggles inStone  (cost 2 inside, overrides grass)
    //   3 = fallback coast boundary → toggles inGrass  (entire interior = grass for these islands)
    const evDist: number[] = [];
    const evKind: number[] = [];

    for (let i = 0; i < N; i++) {
      const angle = i * TWO_PI / N;
      const dx    = Math.cos(angle);
      const dy    = Math.sin(angle);

      evDist.length = 0;
      evKind.length = 0;

      for (let ni = 0; ni < nearIslands.length; ni++) {
        const isl      = nearIslands[ni];
        const verts    = isl.vertices!;
        const nv       = verts.length;
        const gverts   = isl.grassVertices;
        const hasGrass = !!(gverts && gverts.length >= 3);

        if (hasGrass) {
          // --- grassVertices crossings (kind 1) — beach between coast and here costs 1 ---
          const ngv = gverts!.length;
          for (let j = 0; j < ngv; j++) {
            const ax = gverts![j].x          - pos.x,  ay = gverts![j].y          - pos.y;
            const bx = gverts![(j+1)%ngv].x  - pos.x,  by = gverts![(j+1)%ngv].y  - pos.y;
            const denom = dx * (by - ay) - dy * (bx - ax);
            if (Math.abs(denom) < 1e-6) continue;
            const t = (ax * (by - ay) - ay * (bx - ax)) / denom;
            const u = (ax * dy        - ay * dx)         / denom;
            if (t > 0.01 && u >= 0 && u <= 1) { evDist.push(t); evKind.push(1); }
          }
        } else {
          // --- Fallback: outer coast is the grass boundary (kind 3) ---
          for (let j = 0; j < nv; j++) {
            const ax = verts[j].x          - pos.x,  ay = verts[j].y          - pos.y;
            const bx = verts[(j+1)%nv].x   - pos.x,  by = verts[(j+1)%nv].y   - pos.y;
            const denom = dx * (by - ay) - dy * (bx - ax);
            if (Math.abs(denom) < 1e-6) continue;
            const t = (ax * (by - ay) - ay * (bx - ax)) / denom;
            const u = (ax * dy        - ay * dx)         / denom;
            if (t > 0.01 && u >= 0 && u <= 1) { evDist.push(t); evKind.push(3); }
          }
        }

        // --- Stone polygon crossings (kind 2) ---
        if (isl.stonePolys) {
          for (const sp of isl.stonePolys) {
            if (sp.length < 3) continue;
            const ns = sp.length;
            for (let j = 0; j < ns; j++) {
              const ax = sp[j].x          - pos.x,  ay = sp[j].y          - pos.y;
              const bx = sp[(j+1)%ns].x   - pos.x,  by = sp[(j+1)%ns].y   - pos.y;
              const denom = dx * (by - ay) - dy * (bx - ax);
              if (Math.abs(denom) < 1e-6) continue;
              const t = (ax * (by - ay) - ay * (bx - ax)) / denom;
              const u = (ax * dy        - ay * dx)         / denom;
              if (t > 0.01 && u >= 0 && u <= 1) { evDist.push(t); evKind.push(2); }
            }
          }
        }
      }

      // Sort events by ascending distance
      const order = Array.from({length: evDist.length}, (_, k) => k)
        .sort((a, b) => evDist[a] !== evDist[b] ? evDist[a] - evDist[b] : evKind[a] - evKind[b]);

      // Walk the ray with a 4-zone visibility budget:
      //   ocean / beach → cost 1/unit  (full range)
      //   grass zone    → cost 3/unit  (dense vegetation)
      //   rocky stone   → cost 2/unit  (open rock; overrides grass)
      let inGrass   = playerInGrass;
      let inStone   = playerInStone;
      let budget    = MAX_D;
      let worldDist = 0;
      let exhausted = false;

      for (const ei of order) {
        const segLen = evDist[ei] - worldDist;
        if (segLen <= 0) continue;
        const cost           = inStone ? 2.0 : inGrass ? 5.0 : 1.0;
        const maxTraversable = budget / cost;
        if (segLen >= maxTraversable) {
          worldDist += maxTraversable;
          exhausted  = true;
          break;
        }
        budget    -= segLen * cost;
        worldDist  = evDist[ei];
        if (evKind[ei] === 2) inStone = !inStone; // stone boundary
        else                  inGrass = !inGrass;  // grass or fallback coast
      }

      if (!exhausted) {
        worldDist += budget / (inStone ? 2.0 : inGrass ? 5.0 : 1.0);
      }

      result[i] = worldDist;
    }
  }

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

    // In free-camera mode the camera position is driven entirely by drag input.
    // Skip all player-following and AOI position logic, but still lerp zoom/rotation.
    if (!this._freeCameraMode) {
      // Smooth camera follow with lerp for grid stability.
      // But when world-wrap teleports the player across a seam, snap immediately
      // so the camera doesn't scroll across the whole map.
      const currentPos = this.camera.getState().position;
      const mapWrapEnabled = this.networkManager.mapWrap;
      const mapWidth = this.networkManager.mapWidth;
      const mapHeight = this.networkManager.mapHeight;
      const crossedWrapSeam = mapWrapEnabled
        && mapWidth > 0
        && mapHeight > 0
        && (
          Math.abs(player.position.x - currentPos.x) > mapWidth * 0.5
          || Math.abs(player.position.y - currentPos.y) > mapHeight * 0.5
        );

      if (crossedWrapSeam) {
        this.camera.setPosition(player.position);
      } else {
        const lerpFactor = 1.0 - Math.pow(0.001, dt); // Frame-rate independent smoothing
        const smoothedX = currentPos.x + (player.position.x - currentPos.x) * lerpFactor;
        const smoothedY = currentPos.y + (player.position.y - currentPos.y) * lerpFactor;
        this.camera.setPosition(Vec2.from(smoothedX, smoothedY));
      }
    }

    // Dynamic AOI zoom: only applied when the player is NOT at the helm.
    // Helm mount/dismount manages targetZoom separately (HELM_ZOOM / preHelmZoom).
    if (this.inputManager.getMountKind() !== 'helm') {
      const aoiZoom = ClientApplication.COAST_ZOOM +
        (ClientApplication.SEA_ZOOM - ClientApplication.COAST_ZOOM) * this._viewOpenness;
      if (Math.abs(aoiZoom - this._aoiBaseZoom) > 0.003) {
        this._aoiBaseZoom = aoiZoom;
        this.targetZoom   = Math.max(0.1, Math.min(10.0, this._aoiBaseZoom * this._userZoomMul));
      }
    }

    // Smooth zoom toward targetZoom (ease-out, ~0.6 s to settle)
    const currentZoom = this.camera.getState().zoom;
    if (Math.abs(currentZoom - this.targetZoom) > 0.001) {
      const zoomLerp = 1.0 - Math.pow(0.01, dt);
      this.camera.setZoom(currentZoom + (this.targetZoom - currentZoom) * zoomLerp);
    }

    // Smooth rotation toward target (same ease-out curve as zoom)
    const currentRot = this.camera.getState().rotation;
    if (Math.abs(currentRot - this._cameraRotationTarget) > 0.0001) {
      const rotLerp = 1.0 - Math.pow(0.01, dt);
      this.camera.setRotation(currentRot + (this._cameraRotationTarget - currentRot) * rotLerp);
    }
  }
  
  /**
   * Handle input frame from input manager
   */
  private onInputFrame(inputFrame: InputFrame): void {
    // Don't send input while the player is dead / respawn screen is open.
    if (this.uiManager?.isRespawnScreenVisible()) return;
    // Send input to server
    this.networkManager.sendInput(inputFrame);
  }
  
  /**
   * Handle authoritative world state from server
   */
  private onServerWorldState(worldState: WorldState): void {
    // Carry islands forward — the server WorldState message doesn't include them
    // (they arrive separately via onIslands), but client-side collision prediction needs them.
    if (this.authoritativeWorldState?.islands) {
      worldState.islands = this.authoritativeWorldState.islands;
    }
    this.authoritativeWorldState = worldState;

    // Keep pause menu player count up to date
    this.pauseMenu.setPlayerCount(worldState.players.length);

    // Detect respawn: local player health transitions from ≤0 to >0 → flash white again
    const _pid = this.networkManager.getAssignedPlayerId();
    if (_pid !== null) {
      const _lp = worldState.players.find(p => p.id === _pid);
      if (_lp) {
        const wasDown = this._prevLocalHealth !== null && this._prevLocalHealth <= 0;
        const nowUp   = _lp.health > 0;
        if (wasDown && nowUp) {
          // Server confirmed respawn — start fading the white out
          this.uiManager.releaseWhiteFlash();
        }
        this._prevLocalHealth = _lp.health;
      }
    }

    // Re-apply optimistic hotbar slot so rapid world-state updates don't flicker it back.
    // Once the server confirms (its activeSlot matches our pending value) we clear pending.
    if (this.pendingActiveSlot !== null) {
      const pid = this.networkManager.getAssignedPlayerId();
      const p   = pid !== null ? worldState.players.find(pl => pl.id === pid) : null;
      if (p) {
        if (p.inventory.activeSlot === this.pendingActiveSlot) {
          this.pendingActiveSlot = null; // server confirmed — stop overriding
        } else {
          p.inventory.activeSlot = this.pendingActiveSlot; // keep local value
        }
      }
    }

    // Re-apply optimistic mount state until the server's world-state confirms it.
    if (this.pendingMount !== null) {
      const pid = this.networkManager.getAssignedPlayerId();
      const p   = pid !== null ? worldState.players.find(pl => pl.id === pid) : null;
      if (p) {
        const isIslandCannon = !!this.pendingMount.mountWorldPos;
        if (isIslandCannon) {
          // Island cannon: server won't mirror the structure ID in mounted_module_id.
          // Always apply position snap while pendingMount is active (until server confirms mount).
          if (this.pendingMount.mountWorldPos) p.position = this.pendingMount.mountWorldPos;
          if (p.isMounted) {
            this.pendingMount = null; // server confirmed — stop overriding position
          } else {
            // Not yet confirmed — force isMounted so UI/controls stay in mount state
            p.isMounted = true;
          }
        } else if (p.isMounted && p.mountedModuleId === this.pendingMount.moduleId) {
          this.pendingMount = null; // server confirmed ship-mount — stop overriding
        } else {
          // Keep local mount state visible until server catches up (ship cannon/helm)
          p.isMounted        = true;
          p.mountedModuleId  = this.pendingMount.moduleId;
          if (this.pendingMount.mountOffset)   p.mountOffset = this.pendingMount.mountOffset;
          if (this.pendingMount.mountWorldPos) p.position    = this.pendingMount.mountWorldPos;
        }
      }
    }

    // Update network latency for dynamic interpolation buffer
    const networkStats = this.networkManager.getStats();
    if (networkStats.ping > 0) {
      this.predictionEngine.updateNetworkLatency(networkStats.ping);
    }
    
    // Check if player mount state changed
    const playerId = this.networkManager.getAssignedPlayerId();
    if (playerId !== null && this.inputManager) {
      const player = worldState.players.find(p => p.id === playerId);
      if (player) {
        // Update ship ID and rotation for cannon aiming (works even if not mounted to helm)
        this.inputManager.setCurrentShipId(player.carrierId || null);

        // Detect boarding — when carrierId changes to a new ship, sync ammo type and crew tasks
        const newCarrierId = player.carrierId || null;
        if (newCarrierId !== this.previousCarrierId) {
          if (newCarrierId) {
            console.log(`⚓ [BOARD] Boarded ship ${newCarrierId} (was: ${this.previousCarrierId ?? 'none'}) — syncing ammo type & crew tasks`);
            this.inputManager.resetAmmoType();
            this.uiManager.syncCrewFromBoarding(worldState.npcs, newCarrierId, player.companyId ?? 0);
          }
          this.previousCarrierId = newCarrierId;
        }

        if (player.carrierId) {
          const ship = worldState.ships.find(s => s.id === player.carrierId);
          if (ship) {
            this.inputManager.setCurrentShipRotation(ship.rotation);
          }
        }
        
        const currentlyMounted = player.isMounted || false;
        
        // Only update if mount state actually changed
        if (currentlyMounted !== this.previousMountState) {
          if (currentlyMounted) {
            // Player is now mounted — exit build/plan mode and enable controls
            console.log(`⚓ [MOUNT STATE] Server says player is mounted to module ${player.mountedModuleId}`);
            this.exitAllBuildModes();
            // Look up the module kind from the ship
            const ship = worldState.ships.find(s => s.id === player.carrierId);
            // Island cannon: player.carrierId == 0, ship not found — mount is
            // already handled by onIslandCannonMounted; skip setMountState here
            // so we don't overwrite mountKind with the 'helm' default fallback.
            if (!ship && player.carrierId === 0) {
              // island cannon already configured — nothing to do
            } else {
            let moduleKind = 'helm'; // default fallback (only reached with a real ship)
            if (ship && player.mountedModuleId) {
              const mod = ship.modules.find(m => m.id === player.mountedModuleId);
              if (mod) moduleKind = mod.kind.toLowerCase();
            }
            // For helm: seed sail openness from the first mast so W works immediately
            let initialSailOpenness: number | undefined;
            let initialSailAngleDeg: number | undefined;
            if (moduleKind === 'helm') {
              const mast = ship?.modules.find(m => m.kind === 'mast');
              const mastData = mast?.moduleData as any;
              if (typeof mastData?.openness === 'number') initialSailOpenness = mastData.openness;
              if (typeof mastData?.angle === 'number') {
                initialSailAngleDeg = Math.max(-60, Math.min(60, Math.round(mastData.angle * 180 / Math.PI)));
              }
            }
            this.inputManager.setMountState(true, player.carrierId, moduleKind, player.mountedModuleId, initialSailOpenness, undefined, undefined, initialSailAngleDeg);
            // Zoom out when mounting the helm
            if (moduleKind === 'helm') {
              this.preHelmZoom = this.camera.getState().zoom;
              this.targetZoom  = ClientApplication.HELM_ZOOM;
            }
            } // end else (ship cannon / helm branch)
          } else {
            // Player is now dismounted - disable ship controls
            console.log(`⚓ [MOUNT STATE] Server says player is dismounted`);
            this.inputManager.setMountState(false);
            // Restore zoom to what it was before mounting the helm
            this.targetZoom = this.preHelmZoom;
          }
          this.previousMountState = currentlyMounted;
        }
      }
    }
    
    // Mark that we've received at least one world state (suppresses early camera warnings)
    if (!this.hasReceivedWorldState && worldState.players.length > 0) {
      this.hasReceivedWorldState = true;
    }
    
    // Update prediction engine with authoritative state
    this.predictionEngine.onAuthoritativeState(worldState);

    // Feed ShipPredictor with server ship state + wind
    if (this.shipPredictor) {
      const myId = this.networkManager.getAssignedPlayerId();
      const myPlayer = worldState.players.find(p => p.id === myId);
      const playerShip = myPlayer?.carrierId ? worldState.ships.find(s => s.id === myPlayer.carrierId) : null;
      if (playerShip) {
        this.shipPredictor.onServerShip(playerShip);
        this.shipPredictor.setWindPower(this.networkManager.windStrength);
        this.shipPredictor.setWindAngle(this.networkManager.windAngle);
      }
    }

    // Re-evaluate build mode whenever world state arrives (inventory may have changed)
    this.checkBuildMode();

    // Player join/leave notifications — compare current player list to previous snapshot
    {
      const myId = this.networkManager.getAssignedPlayerId();
      const currentPlayers = new Map(worldState.players.map(p => [p.id, p.name || `Player_${p.id}`]));
      if (this._playerTrackingReady) {
        for (const [id, name] of currentPlayers) {
          if (id !== myId && !this._knownPlayerIds.has(id)) {
            this.renderSystem.showAnnouncement(`👤 ${name} joined`, 'info', 3.0);
          }
        }
        for (const [id, name] of this._knownPlayerIds) {
          if (id !== myId && !currentPlayers.has(id)) {
            this.renderSystem.showAnnouncement(`👤 ${name} left`, 'info', 3.0);
          }
        }
      }
      this._knownPlayerIds = currentPlayers;
      // Only start tracking after we have confirmed our own identity in the player list
      if (!this._playerTrackingReady && myId !== null && currentPlayers.has(myId)) {
        this._playerTrackingReady = true;
      }
    }

    // Fallback: if ack never arrived but 10s passed since connect, force-advance.
    if (this.state === ClientState.CONNECTED && !this._playerAckReceived) {
      const timedOut = this._loadingConnectedAt > 0
        && (Date.now() - this._loadingConnectedAt) > ClientApplication.LOADING_PLAYER_TIMEOUT_MS;
      if (timedOut) {
        console.warn('⚠️ Loading timeout — no server ack received, entering game anyway');
        this.state = ClientState.IN_GAME;
        this.setLoadingStep(3);
        this.hideLoadingOverlay();
        console.log('🎮 Entered game world (timeout fallback)');
      }
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
      // Reset NPC kill tracking so reconnect does not produce spurious "eliminated" announcements.
      this.renderSystem.resetNpcTracking();
      // TODO: Handle reconnection logic
    } else if (state === ConnectionState.CONNECTING) {
      this.state = ClientState.CONNECTING;
      console.log('🔄 Connecting to server...');
    }
  }
  
  /**
   * Exit every build and plan mode in one call.
   * Use this whenever the player does something incompatible with build/plan mode
   * (interact, mount, dismount, etc.).
   */
  /**
   * Find the first ship whose hull polygon contains the given world position.
   * Checks ALL ships (including the player’s own) so Move To can target any deck.
   */
  /**
   * Start a Ctrl+left-drag box-select.  Tracks mouse movement and, on release,
   * selects all owned NPCs within the dragged screen rectangle.
   */
  private _startBoxSelect(): void {
    const startPos = this.inputManager.getMouseScreenPosition();
    let isDragging = false;

    const onMove = (e: MouseEvent) => {
      const canvasRect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - canvasRect.left;
      const sy = e.clientY - canvasRect.top;
      const dx = sx - startPos.x;
      const dy = sy - startPos.y;
      if (!isDragging && dx * dx + dy * dy > 64) isDragging = true;
      if (isDragging) {
        this.renderSystem.boxSelectRect = {
          x1: Math.min(startPos.x, sx),
          y1: Math.min(startPos.y, sy),
          x2: Math.max(startPos.x, sx),
          y2: Math.max(startPos.y, sy),
        };
      }
    };

    const onUp = (e: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const rect = this.renderSystem.boxSelectRect;
      this.renderSystem.boxSelectRect = null;
      if (!isDragging || !rect) return;

      const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
      if (!ws) return;
      const myId = this.networkManager.getAssignedPlayerId();
      const me = myId !== null ? ws.players.find(p => p.id === myId) : null;
      const myCompany = me?.companyId ?? 0;

      const selected = ws.npcs.filter(npc => {
        if (npc.companyId === COMPANY_UNCLAIMED) return false;
        const isMyNpc = npc.companyId === COMPANY_SOLO
          ? npc.ownerId === myId
          : npc.companyId === myCompany && myCompany !== 0;
        if (!isMyNpc || this._npcIgnoreSet.has(npc.id)) return false;

        let worldPos = npc.position;
        if (npc.shipId) {
          const ship = ws.ships.find(s => s.id === npc.shipId);
          if (ship && npc.localPosition) {
            const cosR = Math.cos(ship.rotation);
            const sinR = Math.sin(ship.rotation);
            worldPos = Vec2.from(
              ship.position.x + npc.localPosition.x * cosR - npc.localPosition.y * sinR,
              ship.position.y + npc.localPosition.x * sinR + npc.localPosition.y * cosR,
            );
          }
        }
        const sp = this.camera.worldToScreen(worldPos);
        return sp.x >= rect.x1 && sp.x <= rect.x2 && sp.y >= rect.y1 && sp.y <= rect.y2;
      });

      const centre = Vec2.from((rect.x1 + rect.x2) / 2, (rect.y1 + rect.y2) / 2);
      if (selected.length === 0) {
        this.renderSystem.flashCancel(centre);
        return;
      }
      this._moveToNpcId = null;
      this._selectedNpcIds = selected.map(n => n.id);
      this.renderSystem.selectedNpcIds = new Set(this._selectedNpcIds);
      const label = selected.length === 1 ? selected[0].name : `${selected.length} crew`;
      this.renderSystem.setMoveToHint(`Moving ${label} — click destination`);
      this.renderSystem.flashInteract(centre);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  private findShipAtWorldPos(pos: Vec2, worldState: WorldState): Ship | null {
    for (const ship of worldState.ships) {
      if (!ship.hull || ship.hull.length < 3) continue;
      const dx     = pos.x - ship.position.x;
      const dy     = pos.y - ship.position.y;
      const cosR   = Math.cos(-ship.rotation);
      const sinR   = Math.sin(-ship.rotation);
      const localX = dx * cosR - dy * sinR;
      const localY = dx * sinR + dy * cosR;
      if (PolygonUtils.pointInPolygon(Vec2.from(localX, localY), ship.hull)) return ship;
    }
    return null;
  }

  /**
   * Returns true if the local player is within notification range of the given island.
   * Used to filter island-specific claim notifications to only the player's current area.
   */
  private _isPlayerNearIsland(islandId: number): boolean {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState;
    const myId = this.networkManager.getAssignedPlayerId();
    if (!ws || myId === null) return false;
    const player = ws.players.find(p => p.id === myId);
    if (!player) return false;
    const island = this.renderSystem.getIslands().find(i => i.id === islandId);
    if (!island) return false;
    const dx = island.x - player.position.x;
    const dy = island.y - player.position.y;
    return (dx * dx + dy * dy) < 3000 * 3000; // 3000-unit proximity threshold
  }

  private exitAllBuildModes(): void {
    if (!this.buildMenuOpen && !this.explicitBuildMode && this.pendingGhostKind === null) return;
    this.buildMenuOpen      = false;
    this.inputManager.buildMenuOpen = false;
    this.explicitBuildMode  = false;
    this.pendingGhostKind   = null;
    this.buildRotationDeg   = 0;
    this.syncBuildModeState();
    this.checkBuildMode();
    console.log('🏗️ [BUILD] All build/plan modes exited');
  }

  /**
   * Check whether the active hotbar item puts the player in build mode.
   * Plank in active slot → build mode on. Anything else → build mode off.
   */
  private checkBuildMode(): void {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    const playerId = this.networkManager?.getAssignedPlayerId();
    const player   = ws?.players.find(p => p.id === playerId);

    const activeSlot  = player?.inventory?.activeSlot ?? 0;
    const activeItem  = player?.inventory?.slots[activeSlot]?.item ?? 'none';
    const inBuildMode       = activeItem === 'plank';
    const inCannonBuildMode  = activeItem === 'cannon';
    const inMastBuildMode    = activeItem === 'sail';
    const inSwivelBuildMode  = activeItem === 'swivel';
    const inHelmBuildMode   = activeItem === 'helm_kit';
    const inDeckBuildMode   = activeItem === 'deck';

    // Island placement build mode — wooden_floor, workbench, or wall while not on a ship
    const inIslandBuildMode = (player?.carrierId === 0) && (activeItem === 'wooden_floor' || activeItem === 'workbench' || activeItem === 'wall' || activeItem === 'door_frame' || activeItem === 'door' || activeItem === 'shipyard' || activeItem === 'wood_ceiling' || activeItem === 'cannon' || activeItem === 'flag_fort' || activeItem === 'company_fortress' || activeItem === 'claim_flag');
    this.islandBuildMode = inIslandBuildMode && !this.explicitBuildMode;
    this.inputManager.islandBuildMode = this.islandBuildMode;
    this.renderSystem.setIslandBuildItem(
      this.islandBuildMode ? (activeItem as 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag') : null
    );
    this.renderSystem.setIslandBuildRotation(this.islandBuildMode ? this.islandBuildRotationDeg : 0);

    // Show territory claim overlay when Alt is held OR a territory item is active in the hotbar
    const territoryHotbarActive = activeItem === 'flag_fort' || activeItem === 'claim_flag' || activeItem === 'company_fortress';
    this.renderSystem.setTerritoryOverlay(this.showTerritoryOverlay || territoryHotbarActive);

    // Track whether the active item changed while in explicit build mode
    if (this.explicitBuildMode) {
      if (activeItem === 'cannon' || activeItem === 'sail' || activeItem === 'swivel') {
        // Keep item type in sync with hotbar
        if (this.buildSelectedItem !== activeItem) {
          this.buildSelectedItem = activeItem;
          this.syncBuildModeState();
        }
      } else {
        // Player switched to a non-buildable item — auto-exit explicit placement mode
        // (but keep build menu open if it was open)
        this.explicitBuildMode = false;
        this.buildRotationDeg = 0;
        this.islandBuildRotationDeg = 0;
        this.pendingGhostKind = null;
        this.syncBuildModeState();
        console.log('🔨 [BUILD MODE] EXITED (item changed)');
      }
    } else if (this.buildMenuOpen && (activeItem === 'cannon' || activeItem === 'sail' || activeItem === 'swivel')) {
      // Plan mode is open and player equipped a buildable item — jump straight into build
      this.explicitBuildMode = true;
      this.buildSelectedItem = activeItem;
      this.syncBuildModeState();
      console.log(`🏗️ [BUILD] Auto-entered explicit build from plan mode: ${activeItem}`);
    }

    // inputManager.buildMode must be true when menu is open, in explicit mode, or any snap-point mode
    this.renderSystem.setBuildMode(!this.explicitBuildMode && inBuildMode);
    this.renderSystem.setCannonBuildMode(!this.explicitBuildMode && inCannonBuildMode);
    this.renderSystem.setMastBuildMode(!this.explicitBuildMode && inMastBuildMode);
    this.renderSystem.setSwivelBuildMode(!this.explicitBuildMode && inSwivelBuildMode);
    this.renderSystem.setHelmBuildMode(!this.explicitBuildMode && inHelmBuildMode);
    this.renderSystem.setDeckBuildMode(!this.explicitBuildMode && inDeckBuildMode);
    this.inputManager.buildMode = this.explicitBuildMode || this.buildMenuOpen
      || inBuildMode || inCannonBuildMode || inMastBuildMode || inSwivelBuildMode || inHelmBuildMode || inDeckBuildMode || this.islandBuildMode
      || (((player?.carrierId ?? 0) !== 0) && activeItem === 'claim_flag');
  }

  /**
   * Propagate explicit build mode state to UIManager and RenderSystem.
   */
  private syncBuildModeState(): void {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;

    // Count masts only on the player's own ship to avoid summing across all world ships
    const playerId = this.networkManager?.getAssignedPlayerId();
    const player   = ws?.players.find(p => p.id === playerId);
    const playerShip = ws?.ships.find(s => s.id === player?.carrierId);
    const sailCount = playerShip?.modules.filter(m => m.kind === 'mast').length ?? 0;

    this.uiManager?.setBuildModeState(
      this.explicitBuildMode ? {
        active: true,
        selectedItem: this.buildSelectedItem,
        rotationDeg: this.buildRotationDeg,
        sailCount,
        maxSails: 3,
      } : null
    );
    this.renderSystem?.setExplicitBuildMode(
      this.explicitBuildMode ? {
        item: this.buildSelectedItem,
        rotationDeg: this.buildRotationDeg,
      } : null
    );

    // Sync ghost placement state
    this.uiManager?.setBuildMenuState(this.buildMenuOpen, this.ghostPlacements, this.pendingGhostKind);
    this.renderSystem?.setBuildMenuOpen(this.buildMenuOpen);
    this.renderSystem?.setGhostPlacements(this.ghostPlacements);
    this.renderSystem?.setPendingGhost(
      this.pendingGhostKind !== null
        ? { kind: this.pendingGhostKind, rotDeg: this.buildRotationDeg }
        : null
    );

    // In explicit build mode inputManager.buildMode must stay true
    if (this.inputManager) {
      this.inputManager.explicitBuildMode = this.explicitBuildMode;
      if (this.explicitBuildMode || this.buildMenuOpen) this.inputManager.buildMode = true;
    }
  }

  /**
   * Place a ghost planning marker at the specified world position.
   * Ghost placements are purely client-local visual markers — never sent to server.
   * Mast ghosts are snapped to the ship centerline and must respect min separation.
   */
  private handleGhostPlace(worldPos: Vec2): void {
    if (!this.pendingGhostKind) return;
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    if (!ws) return;

    let nearestShip: Ship | null = null;
    let nearestDist = Infinity;
    for (const ship of ws.ships) {
      const dist = worldPos.sub(ship.position).length();
      if (dist < nearestDist) { nearestDist = dist; nearestShip = ship; }
    }
    if (!nearestShip || nearestDist > 400) return;

    const dx = worldPos.x - nearestShip.position.x;
    const dy = worldPos.y - nearestShip.position.y;
    const cos = Math.cos(-nearestShip.rotation);
    const sin = Math.sin(-nearestShip.rotation);
    let localX = dx * cos - dy * sin;
    let localY = dx * sin + dy * cos;

    // Reject if outside the ship hull polygon
    if (!PolygonUtils.pointInPolygon(Vec2.from(localX, localY), nearestShip.hull)) {
      console.log('❌ [GHOST] Click is outside ship hull — ignoring');
      return;
    }

    const ghostRotRad = (this.buildRotationDeg * Math.PI) / 180;

    // Mast ghosts: snap to centerline and enforce min separation
    if (this.pendingGhostKind === 'mast') {
      localY = 0; // Force onto ship centerline
      // Constrain to rectangular body of ship (away from bow/stern curves)
      const MAST_X_MIN = -240, MAST_X_MAX = 200;
      if (localX < MAST_X_MIN || localX > MAST_X_MAX) {
        console.log(`❌ [GHOST] Mast ghost outside allowed fore-aft range`);
        return;
      }
      const MIN_MAST_SEP = 80;
      for (const mod of nearestShip.modules) {
        if (mod.kind !== 'mast') continue;
        if (Math.hypot(localX - mod.localPos.x, 0 - mod.localPos.y) < MIN_MAST_SEP) {
          console.log(`❌ [GHOST] Mast ghost too close to existing mast`);
          return;
        }
      }
      for (const g of this.ghostPlacements) {
        if (g.shipId !== nearestShip.id || g.kind !== 'mast') continue;
        if (Math.hypot(localX - g.localPos.x, 0) < MIN_MAST_SEP) {
          console.log(`❌ [GHOST] Mast ghost too close to another mast ghost`);
          return;
        }
      }
    }

    // Edge margin — ghost center must be at least module-radius inset from hull boundary
    const ghostEdgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
    if (this.pendingGhostKind === 'swivel') {
      // Swivels mount on the hull rail — must be within the plank/edge band (2–30 px from hull)
      if (ghostEdgeDist > 30 || ghostEdgeDist < 2) {
        console.log(`❌ [GHOST] Swivel must be on ship rail (edge dist ${ghostEdgeDist.toFixed(1)}, need 2–30)`);
        return;
      }
    } else {
      const ghostMargin = this.pendingGhostKind === 'cannon' ? 15 : this.pendingGhostKind === 'mast' ? 15 : 10;
      if (ghostEdgeDist < ghostMargin) {
        console.log(`❌ [GHOST] Too close to hull edge (dist ${ghostEdgeDist.toFixed(1)}, min ${ghostMargin})`);
        return;
      }
    }

    // Geometry-based overlap check against existing ship modules (same logic as real placement)
    const newFp = getModuleFootprint(this.pendingGhostKind as any);
    for (const mod of nearestShip.modules) {
      if (mod.kind === 'plank' || mod.kind === 'deck') continue;
      const existFp = getModuleFootprint(mod.kind);
      if (footprintsOverlap(newFp, localX, localY, ghostRotRad, existFp, mod.localPos.x, mod.localPos.y, mod.localRot)) {
        console.log(`❌ [GHOST] Ghost overlaps existing ${mod.kind}`);
        return;
      }
    }

    // Overlap check against other ghost placements on the same ship
    for (const g of this.ghostPlacements) {
      if (g.shipId !== nearestShip.id) continue;
      const existFp = getModuleFootprint(g.kind as any);
      if (footprintsOverlap(newFp, localX, localY, ghostRotRad, existFp, g.localPos.x, g.localPos.y, g.localRot)) {
        console.log(`❌ [GHOST] Ghost overlaps another ghost (${g.kind})`);
        return;
      }
    }

    const ghost: GhostPlacement = {
      id: `ghost-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      kind: this.pendingGhostKind,
      shipId: nearestShip.id,
      localPos: { x: localX, y: localY },
      localRot: ghostRotRad,
    };
    this.ghostPlacements.push(ghost);
    this.syncBuildModeState();
    console.log(`🏗️ [GHOST] Placed ${this.pendingGhostKind} ghost at (${localX.toFixed(0)}, ${localY.toFixed(0)})`);
  }

  /**
   * Remove the ghost placement nearest to the given world position.
   * Only fires if the cursor is within 60 units of a ghost.
   */
  private removeNearestGhost(worldPos: Vec2): void {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    let nearestId: string | null = null;
    let nearestDist = Infinity;
    for (const ghost of this.ghostPlacements) {
      const ship = ws?.ships.find(s => s.id === ghost.shipId);
      if (!ship) continue;
      const cos = Math.cos(ship.rotation);
      const sin = Math.sin(ship.rotation);
      const wx = ship.position.x + ghost.localPos.x * cos - ghost.localPos.y * sin;
      const wy = ship.position.y + ghost.localPos.x * sin + ghost.localPos.y * cos;
      const dist = worldPos.sub(Vec2.from(wx, wy)).length();
      if (dist < nearestDist) { nearestDist = dist; nearestId = ghost.id; }
    }
    if (nearestId && nearestDist < 60) {
      this.ghostPlacements = this.ghostPlacements.filter(g => g.id !== nearestId);
      this.syncBuildModeState();
      console.log(`🏗️ [GHOST] Removed ghost`);
    }
  }

  /**
   * When the player has a buildable item in their hotbar (cannon / sail) and
   * clicks within 80 units of a matching ghost marker, place the real module
   * at the ghost's stored position/rotation and consume the ghost.
   * Returns true if a placement was attempted (caller should early-return).
   */
  private tryPlaceAtGhost(worldPos: Vec2): boolean {
    if (this.ghostPlacements.length === 0) return false;

    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    if (!ws) return false;

    const playerId = this.networkManager?.getAssignedPlayerId();
    const player   = ws.players.find(p => p.id === playerId);
    if (!player) return false;
    const activeSlot  = player.inventory?.activeSlot ?? 0;
    const activeItem  = player.inventory?.slots[activeSlot]?.item ?? 'none';
    const itemToKind: Partial<Record<string, GhostModuleKind>> = {
      cannon: 'cannon', sail: 'mast', swivel: 'swivel',
    };
    const matchKind = itemToKind[activeItem];
    if (!matchKind) return false;

    // Find the nearest ghost of the matching kind within 80 world units
    let bestGhost: GhostPlacement | null = null;
    let bestDist = 80; // snap radius in world units
    for (const g of this.ghostPlacements) {
      if (g.kind !== matchKind) continue;
      const ship = ws.ships.find(s => s.id === g.shipId);
      if (!ship) continue;
      const cos = Math.cos(ship.rotation);
      const sin = Math.sin(ship.rotation);
      const wx = ship.position.x + g.localPos.x * cos - g.localPos.y * sin;
      const wy = ship.position.y + g.localPos.x * sin + g.localPos.y * cos;
      const dist = worldPos.sub(Vec2.from(wx, wy)).length();
      if (dist < bestDist) { bestDist = dist; bestGhost = g; }
    }
    if (!bestGhost) return false;

    const ship = ws.ships.find(s => s.id === bestGhost!.shipId)!;
    const { x: localX, y: localY } = bestGhost.localPos;
    const localRot = bestGhost.localRot;
    const tempId = Date.now() % 100000 + 10000;

    // Overlap check against real modules (exclude the ghost's own footprint since we're consuming it)
    const newFp = getModuleFootprint(matchKind as any);
    for (const mod of ship.modules) {
      if (mod.kind === 'plank' || mod.kind === 'deck') continue;
      const existFp = getModuleFootprint(mod.kind);
      if (footprintsOverlap(newFp, localX, localY, localRot, existFp, mod.localPos.x, mod.localPos.y, mod.localRot)) {
        console.log(`❌ [GHOST SNAP] Placement blocked by existing ${mod.kind}`);
        return true; // consumed the click, even though blocked
      }
    }
    // Also check OTHER ghosts (not this one)
    for (const g of this.ghostPlacements) {
      if (g.id === bestGhost.id) continue;
      if (g.shipId !== ship.id) continue;
      const gFp = getModuleFootprint(g.kind as any);
      if (footprintsOverlap(newFp, localX, localY, localRot, gFp, g.localPos.x, g.localPos.y, g.localRot)) {
        console.log(`❌ [GHOST SNAP] Placement blocked by ghost ${g.kind}`);
        return true;
      }
    }

    if (matchKind === 'cannon') {
      console.log(`🔨 [GHOST SNAP] Placing cannon at ghost pos (${localX.toFixed(0)}, ${localY.toFixed(0)}) rot=${(localRot * 180 / Math.PI).toFixed(0)}°`);
      const newCannon = ModuleUtils.createDefaultModule(tempId, 'cannon', Vec2.from(localX, localY));
      newCannon.localRot = localRot;
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === ship.id);
        if (s) s.modules.push(newCannon);
      }
      const pending = this.localPendingModules.get(ship.id) ?? [];
      pending.push({ module: newCannon, expiry: Date.now() + 5000 });
      this.localPendingModules.set(ship.id, pending);
      this.networkManager.sendPlaceCannonAt(ship.id, localX, localY, localRot);
    } else if (matchKind === 'swivel') {
      console.log(`🔫 [GHOST SNAP] Placing swivel at ghost pos (${localX.toFixed(0)}, ${localY.toFixed(0)}) rot=${(localRot * 180 / Math.PI).toFixed(0)}°`);
      const newSwivel = ModuleUtils.createDefaultModule(tempId, 'swivel', Vec2.from(localX, localY));
      newSwivel.localRot = localRot;
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === ship.id);
        if (s) s.modules.push(newSwivel);
      }
      const pending = this.localPendingModules.get(ship.id) ?? [];
      pending.push({ module: newSwivel, expiry: Date.now() + 5000 });
      this.localPendingModules.set(ship.id, pending);
      this.networkManager.sendPlaceSwivelAt(ship.id, localX, localY, localRot);
    } else {
      // mast
      const mastCount = ship.modules.filter(m => m.kind === 'mast').length;
      if (mastCount >= 3) { console.log(`❌ [GHOST SNAP] Max sails`); return true; }
      console.log(`⛵ [GHOST SNAP] Placing mast at ghost pos (${localX.toFixed(0)}, ${localY.toFixed(0)})`);
      const newMast = ModuleUtils.createDefaultModule(tempId, 'mast', Vec2.from(localX, localY));
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === ship.id);
        if (s) s.modules.push(newMast);
      }
      const pending = this.localPendingModules.get(ship.id) ?? [];
      pending.push({ module: newMast, expiry: Date.now() + 5000 });
      this.localPendingModules.set(ship.id, pending);
      this.networkManager.sendPlaceMastAt(ship.id, localX, localY);
    }

    // Consume the ghost marker
    this.ghostPlacements = this.ghostPlacements.filter(g => g.id !== bestGhost!.id);
    this.syncBuildModeState();
    return true;
  }

  /**
   * Handle a left-click placement in explicit B-key build mode.
   * Finds the nearest ship under the cursor and sends a placement message.
   */
  private handleExplicitBuildPlace(worldPos: Vec2): void {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    if (!ws) return;

    // Find the nearest ship to the cursor
    let nearestShip = null;
    let nearestDist = Infinity;
    for (const ship of ws.ships) {
      const dist = worldPos.sub(ship.position).length();
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestShip = ship;
      }
    }
    if (!nearestShip || nearestDist > 400) return;

    // Convert world position to ship-local coordinates
    const dx = worldPos.x - nearestShip.position.x;
    const dy = worldPos.y - nearestShip.position.y;
    const cos = Math.cos(-nearestShip.rotation);
    const sin = Math.sin(-nearestShip.rotation);
    let localX = dx * cos - dy * sin;
    let localY = dx * sin + dy * cos;

    // Reject if click lands outside the ship hull polygon
    if (!PolygonUtils.pointInPolygon(Vec2.from(localX, localY), nearestShip.hull)) {
      console.log('❌ [BUILD] Click is outside ship hull — ignoring');
      return;
    }

    let rotationRad = (this.buildRotationDeg * Math.PI) / 180;

    // Sails must be on the ship centerline — snap Y to 0 (matches visual cursor behaviour)
    if (this.buildSelectedItem === 'sail') localY = 0;

    // Geometry-based overlap check against existing non-plank, non-deck modules
    const newKind = this.buildSelectedItem === 'cannon' ? 'cannon' as const
                  : this.buildSelectedItem === 'swivel' ? 'swivel' as const
                  : 'mast' as const;

    // Cannon base half-width = 15; mast radius = 15 — center must be at least this far from hull edge
    // Swivels are the exception: they mount ON the rail (2–30 px from the hull edge)
    const edgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
    if (this.buildSelectedItem === 'swivel') {
      if (edgeDist > 30 || edgeDist < 2) {
        console.log(`❌ [BUILD] Swivel must be on ship rail (edge dist ${edgeDist.toFixed(1)}, need 2–30)`);
        return;
      }
    } else {
      const placementMargin = 15;
      if (edgeDist < placementMargin) {
        console.log(`❌ [BUILD] Too close to hull edge (dist ${edgeDist.toFixed(1)}, min ${placementMargin})`);
        return;
      }
    }

    const newFp = getModuleFootprint(newKind);
    for (const mod of nearestShip.modules) {
      if (mod.kind === 'plank' || mod.kind === 'deck') continue;
      const existingFp = getModuleFootprint(mod.kind);
      if (footprintsOverlap(newFp, localX, localY, rotationRad,
                            existingFp, mod.localPos.x, mod.localPos.y, mod.localRot)) {
        console.log(`❌ [BUILD] Placement blocked: overlaps ${mod.kind} at (${mod.localPos.x.toFixed(0)}, ${mod.localPos.y.toFixed(0)})`);
        return;
      }
    }

    // If placement overlaps a ghost planning marker on this ship:
    //   - same kind  → snap to ghost's stored position/rotation and consume it
    //   - other kind → still block (different module type is in the way)
    for (const g of this.ghostPlacements) {
      if (g.shipId !== nearestShip.id) continue;
      const ghostFp = getModuleFootprint(g.kind as any);
      if (!footprintsOverlap(newFp, localX, localY, rotationRad, ghostFp, g.localPos.x, g.localPos.y, g.localRot)) continue;
      if (g.kind === newKind) {
        // Snap real placement to the ghost's exact stored position and consume it
        console.log(`🎯 [BUILD] Snapping to ghost plan at (${g.localPos.x.toFixed(0)}, ${g.localPos.y.toFixed(0)})`);
        localX = g.localPos.x;
        localY = g.localPos.y;
        rotationRad = g.localRot;
        this.buildRotationDeg = g.localRot * 180 / Math.PI;
        this.ghostPlacements = this.ghostPlacements.filter(gh => gh.id !== g.id);
        this.syncBuildModeState();
        // Fall through to normal placement below using snapped coords
      } else {
        console.log(`❌ [BUILD] Placement blocked by ghost marker (${g.kind}) — different module type`);
        return;
      }
      break;
    }

    // Optimistically add the module to all local world states so it appears immediately.
    // In online mode the server's next authoritative tick will include (or exclude) it.
    // In demo/offline mode this IS the only placement path.
    const tempId = Date.now() % 100000 + 10000; // temporary ID
    const shipRef = nearestShip; // capture before potential async

    if (this.buildSelectedItem === 'cannon') {
      console.log(`🔨 [BUILD] Placing cannon at local (${localX.toFixed(0)}, ${localY.toFixed(0)}) rot=${this.buildRotationDeg}° on ship ${shipRef.id}`);
      const newCannon = ModuleUtils.createDefaultModule(tempId, 'cannon', Vec2.from(localX, localY));
      newCannon.localRot = rotationRad;
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === shipRef.id);
        if (s) s.modules.push(newCannon);
      }
      // Also overlay onto interpolated / any worldToRender source
      const pending = this.localPendingModules.get(shipRef.id) ?? [];
      pending.push({ module: newCannon, expiry: Date.now() + 5000 });
      this.localPendingModules.set(shipRef.id, pending);
      this.networkManager.sendPlaceCannonAt(shipRef.id, localX, localY, rotationRad);
    } else if (this.buildSelectedItem === 'swivel') {
      console.log(`🔫 [BUILD] Placing swivel at local (${localX.toFixed(0)}, ${localY.toFixed(0)}) rot=${this.buildRotationDeg}° on ship ${shipRef.id}`);
      const newSwivel = ModuleUtils.createDefaultModule(tempId, 'swivel', Vec2.from(localX, localY));
      newSwivel.localRot = rotationRad;
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === shipRef.id);
        if (s) s.modules.push(newSwivel);
      }
      const pending = this.localPendingModules.get(shipRef.id) ?? [];
      pending.push({ module: newSwivel, expiry: Date.now() + 5000 });
      this.localPendingModules.set(shipRef.id, pending);
      this.networkManager.sendPlaceSwivelAt(shipRef.id, localX, localY, rotationRad);
    } else {
      // Sail — constrain to rectangular body of ship (away from bow/stern curves)
      const MAST_X_MIN = -240, MAST_X_MAX = 200;
      if (localX < MAST_X_MIN || localX > MAST_X_MAX) {
        console.log(`❌ [BUILD] Sail outside allowed fore-aft range (x=${localX.toFixed(0)}, range ${MAST_X_MIN}..${MAST_X_MAX})`);
        return;
      }
      // Sail — check for max 3 masts
      const mastCount = shipRef.modules.filter(m => m.kind === 'mast').length;
      if (mastCount >= 3) {
        console.log(`❌ [BUILD] Max sails reached (${mastCount}/3)`);
        return;
      }
      // Mast cleats must not overlap — enforce minimum center-to-center separation
      const MIN_MAST_SEP = 80;
      for (const mod of shipRef.modules) {
        if (mod.kind !== 'mast') continue;
        const dist = Math.hypot(localX - mod.localPos.x, localY - mod.localPos.y);
        if (dist < MIN_MAST_SEP) {
          console.log(`❌ [BUILD] Mast too close to existing mast at (${mod.localPos.x.toFixed(0)}, ${mod.localPos.y.toFixed(0)}) — distance ${dist.toFixed(0)} < ${MIN_MAST_SEP}`);
          return;
        }
      }
      console.log(`⛵ [BUILD] Placing sail at local (${localX.toFixed(0)}, ${localY.toFixed(0)}) on ship ${shipRef.id}`);
      const newMast = ModuleUtils.createDefaultModule(tempId, 'mast', Vec2.from(localX, localY));
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === shipRef.id);
        if (s) s.modules.push(newMast);
      }
      // Also overlay onto interpolated / any worldToRender source
      const pending = this.localPendingModules.get(shipRef.id) ?? [];
      pending.push({ module: newMast, expiry: Date.now() + 5000 });
      this.localPendingModules.set(shipRef.id, pending);
      this.networkManager.sendPlaceMastAt(shipRef.id, localX, localY);
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
      
      // Update render system for hover detection (suppressed during respawn screen)
      if (!(this.uiManager?.isRespawnScreenVisible() ?? false)) {
        this.renderSystem.updateMousePosition(worldPos);
      }
      // Feed radial menu mouse position (screen space)
      this._radialMenu.updateMouse(screenX, screenY);
    });

    // Close the radial menu immediately on any mouse click (left or right) so
    // it can never remain accidentally open after the player clicks away.
    this.canvas.addEventListener('mousedown', (event) => {
      if (this._radialMenu.isOpen && (event.button === 0 || event.button === 2)) {
        this._radialMenu.close();
        // Cancel the hold timer too if still counting down
        if (this._ladderHoldTimer !== null) {
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
        }
      }
    });

    console.log('🖱️ Mouse tracking initialized for directional movement');
  }
  
  /**
   * Set up debug keyboard shortcuts
   */
  /**
   * Setup +/- zoom buttons in the HTML overlay
   */
  private setupZoomButtons(): void {
    const zoomIn = document.getElementById('zoom-in-btn');
    const zoomOut = document.getElementById('zoom-out-btn');

    if (zoomIn) {
      zoomIn.addEventListener('click', () => {
        this.targetZoom = Math.max(0.1, Math.min(10.0, this.targetZoom * 1.2));
      });
    }
    if (zoomOut) {
      zoomOut.addEventListener('click', () => {
        this.targetZoom = Math.max(0.1, Math.min(10.0, this.targetZoom / 1.2));
      });
    }
  }

  private setupDebugKeys(): void {
    window.addEventListener('keydown', (e) => {
      // Only handle if not typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Route Space / Enter to UIManager for minigame handling first
      if (this.uiManager?.handleKeyDown(e.key)) {
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'Escape':
        case '`': { // backtick also closes/cancels
          // Close world map first
          if (this.uiManager?.isWorldMapVisible()) {
            this.uiManager.closeWorldMap();
            e.preventDefault();
            break;
          }
          // Close command console if open
          if (this.commandConsole.visible) {
            this.commandConsole.close();
            this.uiManager.setActiveMenuId(null);
            e.preventDefault();
            break;
          }
          // Close pause menu if open
          if (this.pauseMenu.visible) {
            this.pauseMenu.close();
            this.uiManager.setActiveMenuId(null);
            e.preventDefault();
            break;
          }
          // Close crafting/shipyard menus if open
          if (this.craftingMenu.visible) {
            this.craftingMenu.close();
            this.uiManager.setActiveMenuId(null);
            e.preventDefault();
            break;
          }
          if (this.shipyardMenu.visible) {
            this.shipyardMenu.close();
            this.uiManager.setActiveMenuId(null);
            e.preventDefault();
            break;
          }
          // Exit any active build mode (ship or island)
          if (this.buildMenuOpen || this.explicitBuildMode || this.pendingGhostKind !== null || this.islandBuildMode) {
            this.exitAllBuildModes();
            // For island build mode (hotbar-driven), also unequip so the ghost preview is dismissed
            if (this.islandBuildMode) {
              this.pendingActiveSlot = 255;
              const playerId = this.networkManager.getAssignedPlayerId();
              if (playerId !== null) {
                for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
                  const p = ws?.players.find(pl => pl.id === playerId);
                  if (p) p.inventory.activeSlot = 255;
                }
              }
              this.networkManager.sendUnequip();
              this.checkBuildMode();
            }
            e.preventDefault();
            break;
          }
          // Cancel "Move To" / box-select targeting mode if active
          if (this._moveToNpcId !== null || this._selectedNpcIds.length > 0) {
            this._moveToNpcId = null;
            this._selectedNpcIds = [];
            this.renderSystem.selectedNpcIds = new Set();
            this.renderSystem.clearMoveToHint();
            this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            e.preventDefault();
            break;
          }
          // Nothing else to close — open pause menu if no other menu is up
          if (!this.uiManager.isAnyMenuOpen()) {
            this.pauseMenu.open();
            this.uiManager.setActiveMenuId(MENU_ID.PAUSE);
            e.preventDefault();
          }
          break;
        }

        case 'p':
        case 'P': {
          // P toggles pause menu only when no other menu is open
          if (!this.uiManager.isAnyMenuOpen()
            && !this.buildMenuOpen
            && !this.explicitBuildMode) {
            if (this.pauseMenu.visible) {
              this.pauseMenu.close();
              this.uiManager.setActiveMenuId(null);
            } else {
              this.pauseMenu.open();
              this.uiManager.setActiveMenuId(MENU_ID.PAUSE);
            }
            e.preventDefault();
          }
          break;
        }

        case '/': {
          // Open command console if nothing else is open
          if (!this.uiManager.isAnyMenuOpen()
            && !this.buildMenuOpen
            && !this.explicitBuildMode) {
            this.commandConsole.open();
            e.preventDefault();
          }
          break;
        }

        case 'e':
        case 'E': {
          // Salvage menu intercepts E entirely when visible
          if (this.uiManager?.salvageMenu.visible) {
            if (!e.repeat) this.uiManager.salvageMenu.handleEKeyDown();
            e.preventDefault();
            break;
          }
          if (e.repeat) {
            // Hold-E: check if we should open the item picker
            if (this._holdEDropTimer > 0 && Date.now() - this._holdEDropTimer >= 500) {
              this._holdEDropTimer = -1; // prevent repeated opens
              const drops = this.renderSystem.getDroppedItemsInRange(80);
              if (drops.length > 1) {
                this.uiManager.openDropPicker(drops);
              }
            }
            break;
          }
          // Start hold-E timer if there are multiple items nearby
          const wsECheck = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const myIdECheck = this.networkManager.getAssignedPlayerId();
          const meECheck = wsECheck
            ? (myIdECheck !== null ? wsECheck.players.find(p => p.id === myIdECheck) : null) ?? wsECheck.players[0] ?? null
            : null;
          if (meECheck && meECheck.carrierId === 0) {
            const nearbyDrops = this.renderSystem.getDroppedItemsInRange(80);
            if (nearbyDrops.length > 1) {
              this._holdEDropTimer = Date.now();
            }
          }

          const wsE = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const myIdE = this.networkManager.getAssignedPlayerId();
          if (!wsE) { console.warn('🪜 E: no world state'); break; }

          const meE = (myIdE !== null ? wsE.players.find(p => p.id === myIdE) : null) ?? wsE.players[0] ?? null;
          if (!meE) { console.warn('🪜 E: player not found'); break; }

          // ── Dismount: player is already mounted ──────────────────────────────
          // No hover required — player is physically AT the mounted module.
          // Island cannon: player stays on foot (carrierId === 0) but is still mounted.
          if (meE.isMounted && meE.carrierId === 0) {
            // Dismount from island cannon immediately
            this._suppressLadderInteract = true;
            this.networkManager.sendAction('dismount');
            this.inputManager?.setMountState(false);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log('🎮 E: dismount island cannon');
            break;
          }
          if (meE.isMounted && meE.carrierId !== 0) {
            // Find the module by ID if known, else fall back to kind search on current ship
            const MOUNTABLE = new Set(['helm', 'cannon', 'mast', 'swivel']);
            let dismountMod: { ship: any; module: any; kind: string } | null = null;
            for (const ship of wsE.ships) {
              if (ship.id !== meE.carrierId) continue;
              for (const mod of ship.modules) {
                if (!MOUNTABLE.has(mod.kind)) continue;
                if (meE.mountedModuleId !== undefined && mod.id === meE.mountedModuleId) {
                  dismountMod = { ship, module: mod, kind: mod.kind };
                  break;
                }
                if (!dismountMod) dismountMod = { ship, module: mod, kind: mod.kind }; // first match
              }
              if (dismountMod) break;
            }

            if (dismountMod) {
              // Dismount immediately on keydown — no hold ring or radial needed.
              this._suppressLadderInteract = true; // cleared on keyup; blocks game-loop double-fire
              this.networkManager.sendAction('dismount');
              this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
              console.log(`🎮 E: dismount ${dismountMod.kind} ${dismountMod.module.id}`);
              break;
            }
          }

          // ── NPC Interact: only when no module is hovered (module takes priority) ─
          {
            const hovNpcE = this.renderSystem.getHoveredNpc();
            if (hovNpcE && !this.renderSystem.getHoveredModule()) {
              const npcDist = meE.position.sub(hovNpcE.position).length();
              if (npcDist > hovNpcE.interactRadius + 80) {
                console.warn(`🤝 E: NPC out of range (dist=${npcDist.toFixed(0)})`);
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                break;
              }

              this._interactKind = 'npc';
              this._suppressLadderInteract = true;
              this._npcInteractId = hovNpcE.id;

              const myCompanyE = meE.companyId ?? 0;
              const myIdE = this.networkManager.getAssignedPlayerId();
              const npcCompanyE = hovNpcE.companyId;

              // Determine if this NPC belongs to the local player
              const isMyNpcE = npcCompanyE !== COMPANY_UNCLAIMED && (
                npcCompanyE === COMPANY_SOLO
                  ? hovNpcE.ownerId === myIdE
                  : npcCompanyE === myCompanyE && myCompanyE !== 0
              );

              // Enemy-company NPC: no interaction
              if (!isMyNpcE && npcCompanyE !== COMPANY_UNCLAIMED) {
                console.log(`🚫 E: NPC ${hovNpcE.id} belongs to enemy company ${npcCompanyE}`);
                this._interactKind = null;
                this._suppressLadderInteract = false;
                this._npcInteractId = null;
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                break;
              }

              let npcOpts: { id: string; label: string }[];
              if (npcCompanyE === COMPANY_UNCLAIMED) {
                npcOpts = [{ id: 'recruit', label: 'Recruit to Company' }];
              } else if (isMyNpcE && hovNpcE.shipId !== meE.carrierId) {
                npcOpts = [{ id: 'move_aboard', label: 'Move Aboard' }, { id: 'unclaim_npc', label: 'Unclaim NPC' }];
              } else {
                // My NPC, same ship
                npcOpts = [{ id: 'crew_menu', label: 'Manage Crew' }, { id: 'unclaim_npc', label: 'Unclaim NPC' }];
              }
              const npcOptsSnap = npcOpts;

              this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
              this._ladderHoldTimer = setTimeout(() => {
                this._ladderHoldTimer = null;
                this.renderSystem.stopLadderHoldRing();
                const mp = this.inputManager.getMouseScreenPosition();
                this._radialMenu.open(mp.x, mp.y, npcOptsSnap);
              }, 300);
              break;
            }
          }

          // ── Structure interact: floors and workbenches, only when off-ship ──
          // Skip the structure check when a ship module is within interaction range —
          // module/ship interactions take priority over the shipyard while hovered.
          const _hovModPriority = this.renderSystem.getHoveredModule();
          const _moduleInRange = (() => {
            if (!_hovModPriority) return false;
            const _hCos = Math.cos(_hovModPriority.ship.rotation);
            const _hSin = Math.sin(_hovModPriority.ship.rotation);
            const _mwx = _hovModPriority.ship.position.x + (_hovModPriority.module.localPos.x * _hCos - _hovModPriority.module.localPos.y * _hSin);
            const _mwy = _hovModPriority.ship.position.y + (_hovModPriority.module.localPos.x * _hSin + _hovModPriority.module.localPos.y * _hCos);
            return Math.hypot(meE.position.x - _mwx, meE.position.y - _mwy) <= 200;
          })();
          if (meE.carrierId === 0 && !_moduleInRange) {
            const struct = this.renderSystem.getHoveredStructure();
            if (struct) {
              const myCompanyE = meE.companyId ?? 0;
              const isOwnCompany = struct.companyId === myCompanyE;
              // Repair option is shown when the structure has been damaged
              // (target_hp < max_hp). Claim flags, wrecks, and forts still in
              // their CLAIMING phase are never repairable on the server side,
              // so we suppress the option for those types client-side too.
              const _structIsDamaged = (s: typeof struct): boolean => {
                if (s.type === 'claim_flag' || s.type === 'wreck') return false;
                if (s.type === 'flag_fort' && (s as any).claimPhase === 0) return false;
                const maxHp = s.maxHp ?? 0;
                if (maxHp <= 0) return false;
                const tHp = (typeof (s as any).targetHp === 'number') ? (s as any).targetHp as number : maxHp;
                return tHp < maxHp;
              };

              // Repair recipes — must mirror server `repair_recipe_for_struct`
              // in server/src/net/structures.c exactly. Cost per ingredient is
              // ceil(qty * missing_hp / max_hp), min 1 (mirrors `compute_repair_cost`).
              const REPAIR_RECIPES: Record<string, { item: string; qty: number }[]> = {
                wooden_floor:     [{ item: 'wood',  qty: 2   }],
                wood_ceiling:     [{ item: 'wood',  qty: 15  }],
                workbench:        [{ item: 'wood',  qty: 10  }],
                wall:             [{ item: 'wood',  qty: 3   }],
                door_frame:       [{ item: 'wood',  qty: 6   }],
                door:             [{ item: 'wood',  qty: 4   }],
                shipyard:         [{ item: 'wood',  qty: 30  }, { item: 'plank', qty: 10 }],
                cannon:           [{ item: 'wood',  qty: 8   }, { item: 'metal', qty: 20 }],
                flag_fort:        [{ item: 'wood',  qty: 40  }, { item: 'stone', qty: 40 }],
                company_fortress: [{ item: 'wood',  qty: 100 }, { item: 'stone', qty: 100 }, { item: 'metal', qty: 20 }],
              };
              const ITEM_PRETTY: Record<string, string> = {
                wood: 'Wood', plank: 'Plank', stone: 'Stone', metal: 'Metal',
              };
              const _have = (item: string): number => {
                const slots = (meE as any).inventory?.slots ?? [];
                let total = 0;
                for (const sl of slots) {
                  if (sl && sl.item === item) total += sl.quantity ?? 0;
                }
                return total;
              };
              const _buildRepairOption = (s: typeof struct): RadialOption | null => {
                if (!_structIsDamaged(s)) return null;
                const recipe = REPAIR_RECIPES[s.type];
                if (!recipe) return null;
                const maxHp = s.maxHp ?? 0;
                const tHp = (typeof (s as any).targetHp === 'number') ? (s as any).targetHp as number : maxHp;
                const missing = Math.max(0, maxHp - tHp);
                if (missing <= 0 || maxHp <= 0) return null;
                // 30s post-damage cooldown (mirrors server enforcement).
                const lastDmgAt = this._structureLastDamagedAt.get(s.id) ?? 0;
                const sinceDmg  = lastDmgAt > 0 ? (performance.now() - lastDmgAt) : Infinity;
                const cooldownRemainingMs = sinceDmg < 30000 ? (30000 - sinceDmg) : 0;
                const tip: string[] = ['Repair cost:'];
                let affordable = true;
                for (const ing of recipe) {
                  const cost = Math.max(1, Math.ceil(ing.qty * missing / maxHp));
                  const h    = _have(ing.item);
                  const ok   = h >= cost;
                  if (!ok) affordable = false;
                  const name = ITEM_PRETTY[ing.item] ?? ing.item;
                  const line = `  ${name}: ${h}/${cost}`;
                  // Lines that start with '!' are rendered red by RadialMenu.
                  tip.push(ok ? line : '!' + line);
                }
                if (cooldownRemainingMs > 0) {
                  tip.push(`!Recently damaged — wait ${Math.ceil(cooldownRemainingMs / 1000)}s`);
                } else if (!affordable) {
                  tip.push('!Not enough resources');
                }
                const disabled = !affordable || cooldownRemainingMs > 0;
                return { id: 'repair', label: 'Repair', disabled, tooltip: tip };
              };

              // Can't interact at all with another company's floor (no use, no demolish)
              if (!isOwnCompany && struct.type === 'wooden_floor') {
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                break;
              }
              // Non-owners have nothing to interact with on these demolish-only types
              if (!isOwnCompany && (struct.type === 'wall' || struct.type === 'door_frame' || struct.type === 'wood_ceiling')) {
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                break;
              }

              this._interactKind = 'structure';
              this._hoveredStructureId = struct.id;
              this._hoveredStructureType = struct.type;
              this._suppressLadderInteract = true;
              const mp = this.inputManager.getMouseScreenPosition();
              this.renderSystem.startLadderHoldRing(mp);
              if (struct.type === 'workbench') {
                // Tap E = open workbench; hold E = radial with options based on ownership
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  const opts: RadialOption[] = [{ id: 'use', label: 'Open Workbench' }];
                  if (isOwnCompany) opts.push({ id: 'demolish', label: 'Demolish' });
                  if (isOwnCompany) { const r = _buildRepairOption(struct); if (r) opts.push(r); }
                  this._radialMenu.open(mp2.x, mp2.y, opts);
                }, 400);
              } else if (struct.type === 'wall') {
                // Wall: hold E = radial with only Demolish
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  const wallOpts: RadialOption[] = [{ id: 'demolish', label: 'Demolish Wall' }];
                  if (isOwnCompany) { const r = _buildRepairOption(struct); if (r) wallOpts.push(r); }
                  this._radialMenu.open(mp2.x, mp2.y, wallOpts);
                }, 600);
              } else if (struct.type === 'door_frame') {
                // Door Frame: hold E = radial with Demolish (removing the frame also removes the panel)
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  const dfOpts: RadialOption[] = [{ id: 'demolish', label: 'Demolish Door Frame' }];
                  if (isOwnCompany) { const r = _buildRepairOption(struct); if (r) dfOpts.push(r); }
                  this._radialMenu.open(mp2.x, mp2.y, dfOpts);
                }, 600);
              } else if (struct.type === 'door') {
                // Door: tap E = toggle open/closed; hold E = radial with Demolish + Lock/Unlock
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  const doorOpts: RadialOption[] = [
                    { id: 'use', label: struct.doorOpen ? 'Close Door' : 'Open Door' },
                  ];
                  if (isOwnCompany) {
                    doorOpts.push({ id: struct.doorLocked ? 'unlock_door' : 'lock_door', label: struct.doorLocked ? '🔓 Unlock Door' : '🔒 Lock Door' });
                    doorOpts.push({ id: 'demolish', label: 'Demolish' });
                    const r = _buildRepairOption(struct); if (r) doorOpts.push(r);
                  }
                  this._radialMenu.open(mp2.x, mp2.y, doorOpts);
                }, 400);
              } else if (struct.type === 'shipyard') {
                // Shipyard: hold E → radial with Release Ship / Demolish
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  const opts: RadialOption[] = [];
                  if (struct.construction?.phase === 'building') {
                    // Ship can be released at any time — it's a real entity
                    opts.push({ id: 'release', label: '⚓ Release Ship' });
                  }
                  if (isOwnCompany) opts.push({ id: 'demolish', label: 'Demolish Shipyard' });
                  if (isOwnCompany) { const r = _buildRepairOption(struct); if (r) opts.push(r); }
                  if (opts.length > 0) {
                    this._radialMenu.open(mp2.x, mp2.y, opts);
                  }
                }, 500);
              } else if (struct.type === 'wreck') {
                // Wreck: tap or hold E → open salvage menu
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  this.uiManager.setActiveMenuId(MENU_ID.SALVAGE);
                  this.uiManager.salvageMenu.open(struct.id, struct.hp ?? 1);
                }, 400);
              } else if (struct.type === 'cannon') {
                // Cannon: tap E = mount; hold E = radial with Mount + Demolish
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  const cannonOpts: RadialOption[] = [
                    { id: 'use', label: 'Mount Cannon' },
                  ];
                  if (isOwnCompany) cannonOpts.push({ id: 'demolish', label: 'Demolish Cannon' });
                  if (isOwnCompany) { const r = _buildRepairOption(struct); if (r) cannonOpts.push(r); }
                  this._radialMenu.open(mp2.x, mp2.y, cannonOpts);
                }, 300);
              } else {
                if (isOwnCompany) {
                  this._ladderHoldTimer = setTimeout(() => {
                    this._ladderHoldTimer = null;
                    this.renderSystem.stopLadderHoldRing();
                    const mp2 = this.inputManager.getMouseScreenPosition();
                    const _demolishLabel =
                      struct.type === 'wood_ceiling' ? 'Demolish Ceiling'
                      : struct.type === 'wall'        ? 'Demolish Wall'
                      : struct.type === 'door_frame'  ? 'Demolish Door Frame'
                      : struct.type === 'door'        ? 'Demolish Door'
                      : struct.type === 'workbench'   ? 'Demolish Workbench'
                      : struct.type === 'shipyard'    ? 'Demolish Shipyard'
                      : 'Demolish Floor';
                    const defOpts: RadialOption[] = [
                      { id: 'demolish', label: _demolishLabel },
                    ];
                    const r = _buildRepairOption(struct); if (r) defOpts.push(r);
                    this._radialMenu.open(mp2.x, mp2.y, defOpts);
                  }, 600);
                }
              }
              break;
            }
          }

          // ── Mount / ladder: target is locked in HERE at keydown from the
          // hovered module. Continued hover is NOT required — the module ID and
          // ship ID are cached and used for the entire hold/keyup sequence.
          // A range check at keyup confirmation ensures the player hasn't wandered
          // too far before releasing E.
          const hov = this.renderSystem.getHoveredModule();
          if (!hov) {
            console.warn('🪜 E: no module under cursor');
            break;
          }

          // ── Range check at keydown — flash red and bail immediately if too far ─
          {
            const hovCos = Math.cos(hov.ship.rotation);
            const hovSin = Math.sin(hov.ship.rotation);
            const mwx = hov.ship.position.x + (hov.module.localPos.x * hovCos - hov.module.localPos.y * hovSin);
            const mwy = hov.ship.position.y + (hov.module.localPos.x * hovSin + hov.module.localPos.y * hovCos);
            const hovDist = (meE.carrierId === hov.ship.id && meE.localPosition)
              ? Math.hypot((meE.localPosition as any).x - hov.module.localPos.x, (meE.localPosition as any).y - hov.module.localPos.y)
              : Math.hypot(meE.position.x - mwx, meE.position.y - mwy);
            if (hovDist > 120) {
              console.warn(`🪜 E: module out of range (dist=${hovDist.toFixed(0)})`);
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
              break;
            }
          }

          const MOUNTABLE = new Set(['helm', 'cannon', 'mast', 'swivel']);

          // ── Claim flag: plant on enemy helm, or remove from any ship ──────
          {
            const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
            const myCompany = meE.companyId ?? 0;
            const targetShipCompany = hov.ship.companyId ?? 0;
            const isEnemyShip = targetShipCompany !== myCompany && targetShipCompany !== 0;

            // Player must be on the ship for both plant and remove
            if (meE.carrierId === hov.ship.id) {
              // Remove flag: if ship already has a claim flag, offer to remove it
              if (hov.ship.claimFlag) {
                this._interactKind = null;
                const mp = this.inputManager.getMouseScreenPosition();
                this._radialMenu.open(mp.x, mp.y, [
                  { id: `remove_flag_${hov.ship.id}`, label: '⛳ Remove Flag' },
                ]);
                break;
              }
            }
          }

          if (MOUNTABLE.has(hov.module.kind)) {
            // ── Mount ──────────────────────────────────────────────────────────
            // Player must be on the ship — can't mount a helm/cannon/mast from off-ship.
            if (meE.carrierId !== hov.ship.id) {
              console.warn(`🎮 E: can't mount ${hov.module.kind} — player is off-ship`);
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
              break;
            }
            this._interactKind = 'mount';
            this._suppressLadderInteract = true;
            this._ladderHoldWasMounted = false;
            this._ladderHoldModuleId = hov.module.id;
            this._ladderHoldShipId = hov.ship.id;
            console.log(`🎮 E: mount ${hov.module.kind} ${hov.module.id}`);
            this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
            const mountKindLabel = hov.module.kind.charAt(0).toUpperCase() + hov.module.kind.slice(1);
            this._ladderHoldTimer = setTimeout(() => {
              this._ladderHoldTimer = null;
              this.renderSystem.stopLadderHoldRing();
              const mp = this.inputManager.getMouseScreenPosition();
              const radialOpts: Array<{ id: string; label: string }> = [
                { id: 'mount', label: `Mount ${mountKindLabel}` }
              ];
              // Offer "Dismiss NPC" if an NPC is stationed at this cannon/swivel
              if (hov.module.kind === 'cannon' || hov.module.kind === 'swivel') {
                const ws2 = this.authoritativeWorldState || this.predictedWorldState;
                const npcAtGun = ws2?.npcs.find(n => n.assignedWeaponId === hov.module.id && n.state === NPC_STATE_AT_GUN);
                if (npcAtGun) {
                  radialOpts.push({ id: 'dismiss_npc', label: `Dismiss ${npcAtGun.name}` });
                }
              }
              // Demolish option — always available when on own ship (server validates ownership)
              radialOpts.push({ id: 'demolish', label: '🪓 Demolish' });
              this._radialMenu.open(mp.x, mp.y, radialOpts);
            }, 300);
            break;
          }

          if (hov.module.kind === 'ladder') {
            // ── Ladder ─────────────────────────────────────────────────────────
            this._interactKind = 'ladder';
            this._suppressLadderInteract = true;
            this._ladderHoldModuleId = hov.module.id;
            this._ladderHoldShipId = hov.ship.id;
            this._ladderHoldIsExtended = (hov.module.moduleData as any)?.extended !== false;
            this._ladderHoldOnShip = meE.carrierId === hov.ship.id;
            console.log(`🪜 E: ladder ${hov.module.id} onShip=${this._ladderHoldOnShip} extended=${this._ladderHoldIsExtended}`);
            this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
            const onShipAtPress = this._ladderHoldOnShip;
            const extendedAtPress = this._ladderHoldIsExtended;
            this._ladderHoldTimer = setTimeout(() => {
              this._ladderHoldTimer = null;
              this.renderSystem.stopLadderHoldRing();
              const mp = this.inputManager.getMouseScreenPosition();
              if (onShipAtPress) {
                this._radialMenu.open(mp.x, mp.y, [
                  extendedAtPress
                    ? { id: 'retract', label: 'Retract' }
                    : { id: 'extend',  label: 'Extend'  },
                  { id: 'demolish', label: '🪓 Demolish' },
                ]);
              } else if (extendedAtPress) {
                this._radialMenu.open(mp.x, mp.y, [
                  { id: 'climb',   label: 'Climb'   },
                  { id: 'retract', label: 'Retract' },
                ]);
              } else {
                this._radialMenu.open(mp.x, mp.y, [
                  { id: 'extend', label: 'Extend' },
                ]);
              }
            }, 300);
            break;
          }

          // Generic module: open Demolish radial when on own ship
          if (meE.carrierId === hov.ship.id) {
            const modKindLabel = hov.module.kind.charAt(0).toUpperCase() + hov.module.kind.slice(1);
            this._interactKind = 'module';
            this._suppressLadderInteract = true;
            this._ladderHoldModuleId = hov.module.id;
            this._ladderHoldShipId = hov.ship.id;
            this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
            this._ladderHoldTimer = setTimeout(() => {
              this._ladderHoldTimer = null;
              this.renderSystem.stopLadderHoldRing();
              const mp = this.inputManager.getMouseScreenPosition();
              this._radialMenu.open(mp.x, mp.y, [
                { id: 'demolish', label: `🪓 Demolish ${modKindLabel}` },
              ]);
            }, 400);
            break;
          }
          console.warn(`🪜 E: hovered module kind '${hov.module.kind}' has no interact handler`);
          break;
        }
        case ']':
          this.toggleShipDebugPanel();
          e.preventDefault();
          break;

        case '[':
          this.renderSystem.toggleHoverDebugHUD();
          e.preventDefault();
          break;

        case '\\':
          this.renderSystem.toggleHoverBoundaries();
          e.preventDefault();
          break;

        case 'Home': {
          // Reset camera rotation to 0 and exit rotate/free-camera modes
          this._cameraRotationTarget = 0;
          this._rotateCamActive  = false;
          // Do NOT automatically exit free-cam mode; user may still want to pan
          e.preventDefault();
          break;
        }

        case 'm':
        case 'M': {
          if (e.repeat) break;
          // Toggle world map — close it if open, otherwise open (centred on local player)
          if (this.uiManager?.isWorldMapVisible()) {
            this.uiManager.closeWorldMap();
          } else if (this.uiManager && !this.uiManager.isRespawnScreenVisible()) {
            const ws = this.authoritativeWorldState || this.predictedWorldState;
            const myId = this.networkManager.getAssignedPlayerId();
            const me = myId !== null ? ws?.players.find(p => p.id === myId) : null;
            const pos = me?.position ? { x: me.position.x, y: me.position.y } : undefined;
            // Exit free-camera mode when opening the world map
            if (this._freeCameraMode) {
              this._freeCameraMode = false;
              this.inputManager.freeCameraMode = false;
            }
            this.uiManager.openWorldMap(pos);
          }
          e.preventDefault();
          break;
        }

        case 'n':
        case 'N': {
          if (e.repeat) break;
          // Rename the ship the player is currently aboard
          const ws = this.authoritativeWorldState || this.predictedWorldState;
          const myId = this.networkManager.getAssignedPlayerId();
          const me = myId !== null ? ws?.players.find(p => p.id === myId) : null;
          const shipId = me?.carrierId ?? 0;
          if (shipId === 0) break; // not on a ship
          const ship = ws?.ships.find(s => s.id === shipId);
          const current = ship?.shipName ?? '';
          // Open the custom rename dialog instead of window.prompt
          this.renameDialog.open(shipId, current);
          e.preventDefault();
          break;
        }
      }
    });

    // Alt key — show territory claim overlay + all ally NPC names while held
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Alt') {
        ev.preventDefault(); // suppress browser menu activation
        this.showTerritoryOverlay = true;
        this.renderSystem.setTerritoryOverlay(true);
        this.renderSystem.setNpcNamesVisible(true);
      }
    });
    window.addEventListener('keyup', (ev) => {
      if (ev.key === 'Alt') {
        this.showTerritoryOverlay = false;
        this.renderSystem.setTerritoryOverlay(false);
        this.renderSystem.setNpcNamesVisible(false);
      }
    });

    // Close radial menu when the tab/window loses focus so it doesn't stay
    // permanently open if the player tabs out while the wheel is visible.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._radialMenu.close();
    });
    window.addEventListener('blur', () => {
      this._radialMenu.close();
    });

    // L key — mass-toggle all company ladders, wired via InputManager.onToggleAllLadders
    // so it fires correctly while moving (same pattern as build mode toggle).
    this.inputManager.onToggleAllLadders = () => {
      const ws = this.authoritativeWorldState || this.predictedWorldState;
      const myId = this.networkManager.getAssignedPlayerId();
      const me = myId !== null ? ws?.players.find(p => p.id === myId) : null;
      if (!me || !ws) return;
      const companyId = me.companyId ?? 0;
      if (companyId === 0) { console.log('Neutral company — cannot mass-toggle ladders'); return; }
      let ladderCount = 0;
      for (const ship of ws.ships) {
        if (ship.companyId !== companyId) continue;
        for (const mod of ship.modules) {
          if (mod.kind === 'ladder') { this.networkManager.sendToggleLadder(mod.id); ladderCount++; }
        }
      }
      console.log(`🪜 [LADDER] Toggled ${ladderCount} ladder(s) on company ${companyId} ships`);
    };

    // E keyup: execute action based on how long E was held
    window.addEventListener('keyup', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== 'e' && e.key !== 'E') return;

      // Let salvage menu consume keyup when visible
      if (this.uiManager?.salvageMenu.visible) {
        this.uiManager.salvageMenu.handleEKeyUp();
        return;
      }

      // Clear hold-E drop timer
      this._holdEDropTimer = -1;

      const moduleId = this._ladderHoldModuleId;
      const shipId   = this._ladderHoldShipId;
      const interactKind = this._interactKind;
      const wasMounted = this._ladderHoldWasMounted;
      this._suppressLadderInteract = false;
      this._ladderHoldModuleId = null;
      this._ladderHoldShipId = null;
      this._interactKind = null;
      this._ladderHoldWasMounted = false;

      // Range validation: re-check player ↔ module distance at confirmation time.
      // The target was locked in at keydown (hover) so continued hover is NOT required,
      // but the player must still be within interaction range so they can't reach across
      // the ship to interact with a distant module.
      // • Same ship  → local coords (server units), threshold matches onActionEvent (120 px)
      // • Off-ship   → world coords, lenient threshold for boarding/ladder ops
      // • Dismount   → always pass (player is physically AT the mounted module)
      const CONFIRM_RANGE_LOCAL    = 150; // local/world px — slightly lenient of the 120 keydown hover
      const CONFIRM_RANGE_OFFSHIP  = 300; // world px — lenient for off-ship ops
      const isInRange = (): boolean => {
        if (wasMounted) return true; // dismount: always at the module
        if (moduleId === null || shipId === null) return false;
        const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
        const myId = this.networkManager.getAssignedPlayerId();
        const me = (myId !== null ? ws?.players.find(p => p.id === myId) : null) ?? ws?.players[0] ?? null;
        if (!me || !ws) return true; // no state yet — allow it
        const ship = ws.ships.find(s => s.id === shipId);
        if (!ship) return false;
        const mod = ship.modules.find(m => m.id === moduleId);
        if (!mod) return false;
        // Same ship + not a ladder: use local coords (server units, unaffected by
        // ship motion) for range check.  Ladders always use world coords because an
        // off-ship player may be boarding and carrierId can lag mid-transition.
        if (interactKind !== 'ladder' && me.carrierId === shipId) {
          if (!me.localPosition) {
            // localPosition is temporarily null (e.g. first tick on ship).
            // Player is confirmed on-ship so proximity at keydown was valid — allow it.
            return true;
          }
          const localDist = Math.hypot(
            (me.localPosition as any).x - mod.localPos.x,
            (me.localPosition as any).y - mod.localPos.y
          );
          if (localDist > CONFIRM_RANGE_LOCAL) console.warn(`📏 range fail (local): dist=${localDist.toFixed(1)} > ${CONFIRM_RANGE_LOCAL} | playerLocal=(${(me.localPosition as any).x.toFixed(1)},${(me.localPosition as any).y.toFixed(1)}) modLocal=(${mod.localPos.x.toFixed(1)},${mod.localPos.y.toFixed(1)})`);
          return localDist <= CONFIRM_RANGE_LOCAL;
        }
        // Off-ship or ladder: world distance.
        // mod.localPos is already in client pixels (same space as ship.position).
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        const mwx = ship.position.x + (mod.localPos.x * cos - mod.localPos.y * sin);
        const mwy = ship.position.y + (mod.localPos.x * sin + mod.localPos.y * cos);
        const worldDist = Math.hypot(me.position.x - mwx, me.position.y - mwy);
        if (worldDist > CONFIRM_RANGE_OFFSHIP) console.warn(`📏 range fail (world): dist=${worldDist.toFixed(1)} > ${CONFIRM_RANGE_OFFSHIP} | player=(${me.position.x.toFixed(1)},${me.position.y.toFixed(1)}) modWorld=(${mwx.toFixed(1)},${mwy.toFixed(1)}) carrierId=${me.carrierId} shipId=${shipId}`);
        return worldDist <= CONFIRM_RANGE_OFFSHIP;
      };

      // ── STRUCTURE INTERACT (floor / workbench) ────────────────────────────
      if (interactKind === 'structure') {
        const structId   = this._hoveredStructureId;
        const structType = this._hoveredStructureType;
        this._hoveredStructureId   = null;
        this._hoveredStructureType = null;

        const doUse = () => {
          if (structId === null) return;
          this.networkManager.sendStructureInteract(structId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          console.log(`⚒ [STRUCTURE] Open workbench ${structId}`);
        };
        const doDemolish = () => {
          if (structId === null) return;
          this.networkManager.sendDemolishStructure(structId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          console.log(`🔨 [STRUCTURE] Demolish ${structType} ${structId}`);
        };
        const doRepair = () => {
          if (structId === null) return;
          this.networkManager.sendRepairStructure(structId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          console.log(`🔧 [STRUCTURE] Repair ${structType} ${structId}`);
        };

        if (this._ladderHoldTimer !== null) {
          // Tap (released before radial opened)
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
          if (structType === 'workbench') {
            // Tap E on workbench = open crafting menu
            doUse();
          } else if (structType === 'cannon') {
            // Tap E on island cannon = mount
            doUse();
          } else if (structType === 'shipyard' && structId !== null) {
            // Tap E on shipyard = open menu with current local state
            const cst = this.renderSystem.getShipyardConstruction(structId);
            this.shipyardMenu.open(structId, cst?.phase ?? 'empty', cst?.modulesPlaced ?? []);
            // Also request latest state from server to keep in sync
            doUse();
          } else if (structType === 'door') {
            // Tap E on door: if locked by another company, flash cancel with feedback
            if (structId !== null) {
              const doorStruct = this.renderSystem.getHoveredStructure(500);
              const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
              const myId = this.networkManager.getAssignedPlayerId();
              const myPlayer = ws && myId !== null ? ws.players.find(p => p.id === myId) ?? null : null;
              const myComp = myPlayer?.companyId ?? 0;
              const doorOwnComp = doorStruct?.companyId ?? 0;
              const isOwnDoor = doorOwnComp !== 0 && doorOwnComp === myComp;
              if (doorStruct?.doorLocked && !isOwnDoor) {
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                this.renderSystem.showAnnouncement('🔒 This door is locked.', 'info', 1.5);
              } else {
                doUse();
              }
            } else {
              doUse();
            }
          } else if (structType === 'wreck' && structId !== null) {
            // Tap E on wreck = open salvage menu (loot count from render system)
            const wreckStruct = this.renderSystem.getHoveredStructure(500);
            const loot = wreckStruct?.hp ?? 1;
            this.uiManager.setActiveMenuId(MENU_ID.SALVAGE);
            this.uiManager.salvageMenu.open(structId, loot);
          }
          // Tap E on floor/wall/door_frame = nothing (user must hold to demolish)
        } else if (this._radialMenu.isOpen) {
          const selected = this._radialMenu.getHoveredId();
          this._radialMenu.close();
          if (selected === 'use')           doUse();
          else if (selected === 'demolish') doDemolish();
          else if (selected === 'repair')   doRepair();
          else if (selected === 'lock_door' || selected === 'unlock_door') {
            if (structId !== null) {
              const locked = selected === 'lock_door';
              this.networkManager.sendStructureLock(structId, locked);
              this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            }
          }
          else if (selected === 'release' && structId !== null) {
            this.networkManager.sendShipyardAction(structId, 'release_ship');
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`⚓ [SHIPYARD] Release ship from shipyard ${structId}`);
          }
          else this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
        }
        return;
      }

      // ── NPC INTERACT ─────────────────────────────────────────────────────────
      if (interactKind === 'npc') {
        const npcId = this._npcInteractId;
        this._npcInteractId = null;

        const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
        const myId = this.networkManager.getAssignedPlayerId();
        const me = (myId !== null ? ws?.players.find(p => p.id === myId) : null) ?? ws?.players[0] ?? null;

        const executeNpcAction = (actionId: string) => {
          const npc = npcId != null ? ws?.npcs.find(n => n.id === npcId) : null;
          if (!npc) { console.warn(`🤝 NPC ${npcId} not found in world state`); return; }
          const myCompany = me?.companyId ?? 0;
          const myIdAct = myId;
          const isMyNpc = npc.companyId !== COMPANY_UNCLAIMED && (
            npc.companyId === COMPANY_SOLO
              ? npc.ownerId === myIdAct
              : npc.companyId === myCompany && myCompany !== 0
          );
          if (actionId === 'recruit' && npc.companyId === COMPANY_UNCLAIMED) {
            this.networkManager.sendNpcRecruit(npc.id);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`🤝 Recruiting NPC ${npc.id} (${npc.name})`);
          } else if (actionId === 'move_aboard' && isMyNpc) {
            this.networkManager.sendNpcMoveAboard(npc.id);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`⚓ Moving NPC ${npc.id} (${npc.name}) aboard`);
          } else if (actionId === 'crew_menu' && isMyNpc) {
            this.uiManager?.openCrewMenuForNpc(npc);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          } else if (actionId === 'unclaim_npc' && isMyNpc) {
            this._npcIgnoreSet.delete(npc.id);
            this.networkManager.sendNpcUnclaim(npc.id);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`⚓ Unclaiming NPC ${npc.id} (${npc.name})`);
          }
        };

        const defaultNpcAction = () => {
          const npc = npcId != null ? ws?.npcs.find(n => n.id === npcId) : null;
          if (!npc) return;
          const myCompany = me?.companyId ?? 0;
          const isMyNpc = npc.companyId !== COMPANY_UNCLAIMED && (
            npc.companyId === COMPANY_SOLO
              ? npc.ownerId === myId
              : npc.companyId === myCompany && myCompany !== 0
          );
          if (npc.companyId === COMPANY_UNCLAIMED) {
            executeNpcAction('recruit');
          } else if (isMyNpc && npc.shipId !== me?.carrierId) {
            executeNpcAction('move_aboard');
          } else if (isMyNpc) {
            executeNpcAction('crew_menu');
          }
          // else: enemy/other player's NPC — no action
        };

        if (this._ladderHoldTimer !== null) {
          // Tap (< 300 ms): execute default action without radial
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
          defaultNpcAction();
        } else if (this._radialMenu.isOpen) {
          // Hold released with radial open — execute selected option or cancel
          const selected = this._radialMenu.getHoveredId();
          this._radialMenu.close();
          if (selected) { executeNpcAction(selected); }
          else { this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition()); }
        }
        return;
      }

      // ── MOUNTABLE MODULES (helm / cannon / mast) — mount or dismount ────────
      if (interactKind === 'mount') {
        // Route to the correct network call based on whether the player was mounted.
        const doMountAction = (): boolean => {
          if (!isInRange()) {
            console.warn('🎮 interact cancelled: moved out of range');
            return false;
          }
          if (wasMounted) {
            this.networkManager.sendAction('dismount');
            console.log(`🎮 dismount (module ${moduleId})`);
          } else if (moduleId !== null) {
            this.networkManager.sendModuleInteract(moduleId);
            console.log(`🎮 mount module ${moduleId}`);
          } else {
            return false;
          }
          return true;
        };

        if (this._ladderHoldTimer !== null) {
          // Tap (< 300 ms) — execute immediately, no cancel possible
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
          if (doMountAction()) {
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          }
        } else if (this._radialMenu.isOpen) {
          // Hold — execute selected option or cancel if centre dead zone
          const selected = this._radialMenu.getHoveredId();
          this._radialMenu.close();
          if (selected === 'dismiss_npc' && moduleId !== null) {
            // Dismiss the NPC currently stationed at this cannon/swivel
            // Also clear any client-side ignore/lock state for that NPC
            const _ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
            const _npcAtMod = _ws?.npcs.find(n => n.assignedWeaponId === moduleId);
            if (_npcAtMod) this._npcIgnoreSet.delete(_npcAtMod.id);
            this.networkManager.sendDismissNpc(moduleId);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`👋 dismiss NPC from module ${moduleId}`);
          } else if (selected === 'demolish' && moduleId !== null && shipId !== null) {
            this.networkManager.sendDemolishModule(shipId, moduleId);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`🪓 [DEMOLISH] module ${moduleId} on ship ${shipId}`);
          } else if (selected) {
            if (doMountAction()) {
              this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            } else {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            }
          } else {
            console.log('🎮 radial: cancelled (centre dead zone)');
            this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
          }
        }
        return;
      }

      // ── GENERIC MODULE (plank / seat / custom / etc.) — Demolish only ───
      if (interactKind === 'module') {
        if (this._ladderHoldTimer !== null) {
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
          // Tap: no default action — require hold to confirm demolish
          this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
        } else if (this._radialMenu.isOpen) {
          const selected = this._radialMenu.getHoveredId();
          this._radialMenu.close();
          if (selected === 'demolish' && moduleId !== null && shipId !== null) {
            if (!isInRange()) {
              console.warn('🪓 module demolish cancelled: moved out of range');
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            } else {
              this.networkManager.sendDemolishModule(shipId, moduleId);
              this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
              console.log(`🪓 [DEMOLISH] module ${moduleId} on ship ${shipId}`);
            }
          } else {
            this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
          }
        }
        return;
      }

      // ── LADDER ───────────────────────────────────────────────────────────
      if (this._ladderHoldTimer !== null) {
        clearTimeout(this._ladderHoldTimer);
        this._ladderHoldTimer = null;
        this.renderSystem.stopLadderHoldRing();

        if (moduleId === null) return;

        if (!isInRange()) {
          console.warn('🪜 ladder interact cancelled: moved out of range');
          this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
          return;
        }

        if (this._ladderHoldIsExtended) {
          // Extended: tap = climb (any position) or retract (on ship)
          this.networkManager.sendModuleInteract(moduleId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          console.log(`🪜 tap: ${this._ladderHoldOnShip ? 'retract' : 'climb'} ladder ${moduleId}`);
        } else {
          // Retracted: tap = extend (toggle_ladder, works on-ship and off)
          this.networkManager.sendToggleLadder(moduleId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          console.log(`🪜 tap: extend ladder ${moduleId}`);
        }
      } else if (this._radialMenu.isOpen) {
        // Radial was open — execute selected option or cancel if centre dead zone / out of range
        const selected = this._radialMenu.getHoveredId();
        this._radialMenu.close();

        if (!selected || moduleId === null) {
          this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
          return;
        }

        if (!isInRange()) {
          console.warn('🪜 ladder radial cancelled: moved out of range');
          this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
          return;
        }

        console.log(`🪜 radial: ${selected} ladder ${moduleId}`);

        if (selected === 'climb' || selected === 'retract') {
          // climb and retract both use module_interact (ladder must be extended)
          this.networkManager.sendModuleInteract(moduleId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
        } else if (selected === 'extend') {
          // extend always uses toggle_ladder — module_interact on retracted = climb attempt
          this.networkManager.sendToggleLadder(moduleId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
        } else if (selected === 'demolish' && shipId !== null) {
          this.networkManager.sendDemolishModule(shipId, moduleId);
          this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          console.log(`🪓 [DEMOLISH] ladder ${moduleId} on ship ${shipId}`);
        } else if (selected?.startsWith('remove_flag_')) {
          // ── Remove claim flag from ship ──────────────────────────────────
          const flagShipId = parseInt(selected.replace('remove_flag_', ''), 10);
          if (!isNaN(flagShipId)) {
            this.networkManager.sendRemoveClaimFlag(flagShipId);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`🚩 Removing claim flag from ship ${flagShipId}`);
          }
        }
      }
    });

    console.log('⌨️ Debug keys initialized (] = toggle hover boundaries)');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ship debug panel
  // ─────────────────────────────────────────────────────────────────────────

  private _createShipDebugPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'ship-debug-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      zIndex: '9999',
      background: 'rgba(0,0,0,0.75)',
      color: '#e8e8e8',
      fontFamily: 'monospace',
      fontSize: '11px',
      padding: '6px 8px',
      borderRadius: '4px',
      border: '1px solid rgba(255,255,255,0.2)',
      minWidth: '380px',
      maxHeight: '320px',
      overflowY: 'auto',
      userSelect: 'none',
      cursor: 'move',
      boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
    });

    // Title bar
    const title = document.createElement('div');
    Object.assign(title.style, {
      fontWeight: 'bold',
      marginBottom: '4px',
      color: '#ffcc44',
      fontSize: '11px',
    });
    title.textContent = '🚢 Ships received';
    panel.appendChild(title);

    // Table
    const table = document.createElement('table');
    Object.assign(table.style, { borderCollapse: 'collapse', width: '100%' });
    const thead = table.createTHead();
    const hrow = thead.insertRow();
    for (const col of ['ID', 'Name', 'X', 'Y', 'Spd', 'Hull', 'Co', 'Vis']) {
      const th = document.createElement('th');
      Object.assign(th.style, {
        textAlign: 'left', padding: '1px 5px 1px 0',
        color: '#aac4ff', borderBottom: '1px solid rgba(255,255,255,0.15)',
      });
      th.textContent = col;
      hrow.appendChild(th);
    }
    this._shipDebugTableBody = table.createTBody();
    panel.appendChild(table);

    // Drag support
    let dragOffX = 0, dragOffY = 0, dragging = false;
    panel.addEventListener('mousedown', (e) => {
      dragging = true;
      dragOffX = e.clientX - panel.getBoundingClientRect().left;
      dragOffY = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = e.clientX - dragOffX;
      const top  = e.clientY - dragOffY;
      panel.style.left  = `${left}px`;
      panel.style.top   = `${top}px`;
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    document.body.appendChild(panel);
    return panel;
  }

  public toggleShipDebugPanel(): void {
    if (this._shipDebugPanel) {
      this._shipDebugPanel.remove();
      this._shipDebugPanel = null;
      this._shipDebugTableBody = null;
    } else {
      this._shipDebugPanel = this._createShipDebugPanel();
    }
  }

  private _updateShipDebugPanel(): void {
    if (!this._shipDebugPanel || !this._shipDebugTableBody) return;
    const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
    const ships = ws?.ships ?? [];
    const tbody = this._shipDebugTableBody;
    tbody.innerHTML = '';
    for (const s of ships) {
      const spd = Math.sqrt(s.velocity.x * s.velocity.x + s.velocity.y * s.velocity.y);
      const fogVis = this.renderSystem.fogVisibleAt(s.position.x, s.position.y, 200);
      const tr = tbody.insertRow();
      const cells = [
        String(s.id),
        s.shipName ?? '—',
        s.position.x.toFixed(0),
        s.position.y.toFixed(0),
        spd.toFixed(1),
        (s.hullHealth ?? 100).toFixed(0),
        String(s.companyId ?? 0),
        fogVis ? '✓' : '✗',
      ];
      for (let i = 0; i < cells.length; i++) {
        const td = tr.insertCell();
        Object.assign(td.style, { padding: '1px 5px 1px 0', whiteSpace: 'nowrap' });
        if (i === 5) {
          const hp = parseFloat(cells[i]);
          td.style.color = hp < 30 ? '#ff5555' : hp < 60 ? '#ffaa44' : '#88ff88';
        } else if (i === 7) {
          td.style.color = fogVis ? '#88ff88' : '#ff5555';
        }
        td.textContent = cells[i];
      }
    }
    // Update title count
    const title = this._shipDebugPanel.firstElementChild as HTMLElement;
    if (title) title.textContent = `🚢 Ships received (${ships.length})`;
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

        // Keep GL canvas resolution in sync with 2D canvas size and current GL scale
        this.applyGLCanvasScale();
      }
    });
    
    resizeObserver.observe(this.canvas);
  }

  /** Apply the current GL scale to the back-buffer dimensions. */
  private applyGLCanvasScale(): void {
    if (!this._glCanvas) return;
    this._glCanvas.width  = Math.ceil(this.canvas.width  * this._glScale);
    this._glCanvas.height = Math.ceil(this.canvas.height * this._glScale);
  }

  /**
   * Adaptive dynamic resolution for the GL pass.
   * Drops internal GL resolution under sustained frame pressure and recovers slowly when stable.
   */
  private updateAdaptiveGLScale(frameMs: number, nowMs: number): void {
    if (!this._glRenderer || !this._glCanvas) return;

    const targetMs = 1000 / Math.max(30, this.config.graphics.targetFPS || 60);
    const isOverBudget = frameMs > targetMs * 1.18;
    const isComfortable = frameMs < targetMs * 0.75;

    if (isOverBudget) this._glBadFrameCount++;
    else this._glBadFrameCount = Math.max(0, this._glBadFrameCount - 1);

    if (isComfortable) this._glGoodFrameCount++;
    else this._glGoodFrameCount = Math.max(0, this._glGoodFrameCount - 1);

    if (nowMs < this._glNextScaleAdjustAt) return;

    if (this._glBadFrameCount >= 20 && this._glScale > this._glScaleMin) {
      this._glScale = Math.max(this._glScaleMin, this._glScale - 0.05);
      this.applyGLCanvasScale();
      this._glBadFrameCount = 0;
      this._glGoodFrameCount = 0;
      this._glNextScaleAdjustAt = nowMs + 1500;
      console.log(`[GL] Adaptive scale lowered to ${Math.round(this._glScale * 100)}%`);
      return;
    }

    if (this._glGoodFrameCount >= 180 && this._glScale < this._glScaleMax) {
      this._glScale = Math.min(this._glScaleMax, this._glScale + 0.05);
      this.applyGLCanvasScale();
      this._glBadFrameCount = 0;
      this._glGoodFrameCount = 0;
      this._glNextScaleAdjustAt = nowMs + 2500;
      console.log(`[GL] Adaptive scale raised to ${Math.round(this._glScale * 100)}%`);
    }
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
      const avgFrameTime = this.fpsTimer / this.frameCount;
      

      
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
    // Build the full 49-point Bezier hull used by the real brigantine
    const hull = createCurvedShipHull();

    // Helper: create a cannon module and set its local rotation
    const mkCannon = (id: number, x: number, y: number, rot: number): ShipModule => {
      const m = ModuleUtils.createDefaultModule(id, 'cannon', Vec2.from(x, y));
      m.localRot = rot;
      return m;
    };

    const ship: Ship = {
      id: 1,
      position: Vec2.from(600, 400),
      rotation: 0,
      velocity: Vec2.zero(),
      angularVelocity: 0,
      hull,
      // Brigantine physics (matches server constants)
      mass: 5000,
      momentOfInertia: 500000,
      maxSpeed: 30,
      turnRate: 0.5,
      waterDrag: 0.98,
      angularDrag: 0.95,
      rudderAngle: 0,
      cannonAmmo: 0,
      infiniteAmmo: true,
      hullHealth: 100,
      companyId: 0,
      shipType: 3,
      levelStats: {
        levels: [1, 8, 12, 3, 5], // demo: some points in resistance/damage
        xp: 350,
        maxCrew: 9 + 2 * 2,       // crew lvl 3 → 13
        shipLevel:       (1-1)+(8-1)+(12-1)+(3-1)+(5-1), // 0+7+11+2+4 = 24
        totalCap:        65,
        nextUpgradeCost: 100 * (24 + 1), // XP_BASE * (shipLevel + 1) = 2500
        attrCaps: [50, 35, 35, 50, 25],
      },
      modules: [
        // Deck — walkable interior polygon inset from hull
        ModuleUtils.createShipDeckFromPolygon(hull),

        // Hull planks — 24 segments covering the full hull perimeter
        ...ModuleUtils.createShipPlanksFromSegments(100),

        // Helm (stern-center)
        ModuleUtils.createDefaultModule(1000, 'helm', Vec2.from(-90, 0)),

        // Three masts: fore, main, mizzen
        ModuleUtils.createDefaultModule(1001, 'mast', Vec2.from(165, 0)),
        ModuleUtils.createDefaultModule(1002, 'mast', Vec2.from(-35, 0)),
        ModuleUtils.createDefaultModule(1003, 'mast', Vec2.from(-235, 0)),

        // Port side cannons — barrel faces +Y (port) → localRot = π
        mkCannon(1004, -35,   75,  Math.PI),
        mkCannon(1005,  65,   75,  Math.PI),
        mkCannon(1006, -135,  75,  Math.PI),

        // Starboard side cannons — barrel faces -Y (starboard) → localRot = 0
        mkCannon(1007, -35,  -75,  0),
        mkCannon(1008,  65,  -75,  0),
        mkCannon(1009, -135, -75,  0),

        // Emergency boarding ladder at stern (fixed ID 300 — always present)
        ModuleUtils.createDefaultModule(300, 'ladder', Vec2.from(-305, 0)),
      ]
    };

    return {
      tick: 0,
      timestamp: Date.now(),
      ships: [ship],
      players: [
        {
          id: 1,
          position: Vec2.from(600, 400),
          velocity: Vec2.zero(),
          rotation: 0,
          radius: PhysicsConfig.PLAYER_RADIUS,
          carrierId: ship.id,
          deckId: ship.modules[0].id,
          onDeck: true,
          isMounted: false,
          companyId: 0,
          health: 100,
          maxHealth: 100,
          onIslandId: 0,
          inventory: createEmptyInventory()
        }
      ],
      cannonballs: [],
      npcs: [],
      tombstones: [],
      droppedItems: [],
      companies: [],
      carrierDetection: new Map()
    };
  }
  
  /**
   * Handle successful module mount from server
   */
  private handleModuleMountSuccess(moduleId: number, moduleKind: string, mountOffset?: Vec2): void {
    console.log(`🎮 [MOUNT] Player mounted to ${moduleKind} (ID: ${moduleId})`);

    // Set optimistic pending mount so world-state flickers don't undo the visual
    this.pendingMount = { moduleId, moduleKind, mountOffset };

    const playerId = this.networkManager.getAssignedPlayerId();
    if (playerId === null) return;
    
    // Enable ship/cannon/mast/swivel controls
    if (moduleKind.toUpperCase() === 'HELM' || moduleKind.toUpperCase() === 'CANNON' || moduleKind.toUpperCase() === 'MAST' || moduleKind.toUpperCase() === 'SWIVEL') {
      let shipId: number | undefined;
      
      // Find the ship the player is on
      const worldState = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
      if (worldState) {
        const player = worldState.players.find(p => p.id === playerId);
        if (player) {
          shipId = player.carrierId;
        }
      }
      
      this.inputManager.setMountState(true, shipId, moduleKind, moduleId,
        // Seed sail openness for helm so W works on first mount
        moduleKind.toUpperCase() === 'HELM' && worldState
          ? (() => { const mast = worldState.ships.find(s => s.id === shipId)?.modules.find(m => m.kind === 'mast'); return (mast?.moduleData as any)?.openness as number | undefined; })()
          : undefined,
        undefined,
        undefined,
        // Seed sail angle for helm so rotation controls start correctly
        moduleKind.toUpperCase() === 'HELM' && worldState
          ? (() => { const mast = worldState.ships.find(s => s.id === shipId)?.modules.find(m => m.kind === 'mast'); const a = (mast?.moduleData as any)?.angle; return typeof a === 'number' ? Math.max(-60, Math.min(60, Math.round(a * 180 / Math.PI))) : undefined; })()
          : undefined
      );

      // Zoom out when mounting the helm
      if (moduleKind.toUpperCase() === 'HELM') {
        this.preHelmZoom = this.camera.getState().zoom;
        this.targetZoom  = ClientApplication.HELM_ZOOM;
      }
    }
    
    // Update player state in all world states
    const updatePlayerMount = (worldState: WorldState | null) => {
      if (!worldState) return;
      
      const player = worldState.players.find(p => p.id === playerId);
      if (player) {
        player.isMounted = true;
        player.mountedModuleId = moduleId;
        player.mountOffset = mountOffset;
        
        // Find the ship and module to set player position
        const ship = worldState.ships.find(s => s.id === player.carrierId);
        if (ship) {
          const module = ship.modules.find(m => m.id === moduleId);
          if (module && mountOffset) {
            // Set player local position to module position + mount offset
            const mountLocalPos = Vec2.from(
              module.localPos.x + mountOffset.x,
              module.localPos.y + mountOffset.y
            );
            player.localPosition = mountLocalPos;
            
            // Convert to world position
            const cos = Math.cos(ship.rotation);
            const sin = Math.sin(ship.rotation);
            const worldX = ship.position.x + (mountLocalPos.x * cos - mountLocalPos.y * sin);
            const worldY = ship.position.y + (mountLocalPos.x * sin + mountLocalPos.y * cos);
            player.position = Vec2.from(worldX, worldY);
            
            console.log(`📍 [MOUNT] Player positioned at local (${mountLocalPos.x.toFixed(1)}, ${mountLocalPos.y.toFixed(1)})`);
          }
        }
      }
    };
    
    updatePlayerMount(this.authoritativeWorldState);
    updatePlayerMount(this.predictedWorldState);
    updatePlayerMount(this.demoWorldState);
  }
  
  /**
   * Handle failed module mount from server
   */
  private handleModuleMountFailure(reason: string): void {
    console.log(`⚠️ [MOUNT] Mount failed: ${reason}`);
    this.pendingMount = null; // clear optimistic mount on failure
  }
}