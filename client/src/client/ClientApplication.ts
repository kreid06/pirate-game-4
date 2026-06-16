



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
import { CollisionContext } from '../sim/IslandCollisions.js';

// Gameplay Systems
import { InputManager } from './gameplay/InputManager.js';
import { ModuleInteractionSystem } from './gameplay/ModuleInteractionSystem.js';
import { PhysicsConfig } from '../sim/Types.js';

// UI System
import { UIManager } from './ui/UIManager.js';
import { MENU_ID } from './ui/UIManager.js';
import { RadialMenu, type RadialOption } from './ui/RadialMenu.js';
import { CraftingMenu } from './ui/CraftingMenu.js';
import { ChestMenu } from './ui/ChestMenu.js';
import { LandChestMenu } from './ui/LandChestMenu.js';
import { ShipyardMenu } from './ui/ShipyardMenu.js';
import { ShipRenameDialog } from './ui/ShipRenameDialog.js';
import { GroupRenameDialog } from './ui/GroupRenameDialog.js';
import { ConfirmDialog }    from './ui/ConfirmDialog.js';
import { PauseMenu, GameSettings } from './ui/PauseMenu.js';
import { CommandConsole } from './ui/CommandConsole.js';
import { ChatBox } from './ui/ChatBox.js';
import { IslandEditor } from './gfx/IslandEditor.js';
import { logout } from './auth/AuthService.js';

// Audio System
import { AudioManager } from './audio/AudioManager.js';

// Core Simulation Types
import { WorldState, Ship, InputFrame, WeaponGroupState, WeaponGroupMode, COMPANY_SOLO, COMPANY_UNCLAIMED, IslandDef, NPC_STATE_AT_GUN } from '../sim/Types.js';
import { GhostPlacement, GhostModuleKind, LandGhostPlacement } from '../sim/Types.js';
import { createEmptyInventory, ITEM_KIND_ID, ITEM_ID_MAP, ITEM_DEFS, STRUCTURE_COSTS, computeInventoryWeight } from '../sim/Inventory.js';
import { tierName, itemDisplayName } from '../sim/Quality.js';
import { Vec2 } from '../common/Vec2.js';
import { ModuleUtils, ShipModule, getModuleFootprint, footprintsOverlap } from '../sim/modules.js';
import { createCurvedShipHull } from '../sim/ShipUtils.js';
import { PolygonUtils } from '../common/PolygonUtils.js';
import { BRIGANTINE_LOWER_DECK_MODULE_ID, BRIGANTINE_UPPER_DECK_MODULE_ID } from '../common/ShipDefinitions.js';

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

      /**
       * Register network event handlers for plan placement confirmation/failure.
       * Should be called after networkManager is initialized.
       */
      private _registerNetworkPlanHandlers() {
        if (!this.networkManager) return;
        // Placement failed: show warning, keep plan ghost
        this.networkManager.onPlacementFailed = (
          reason: string, x: number, y: number, structureType: string, blockerId: number | null
        ) => {
          const ghost = this.landGhostEntries.find(g => g.kind === structureType && Math.abs(g.worldPos.x - x) < 2 && Math.abs(g.worldPos.y - y) < 2);
          if (ghost && this.renderSystem && this.inputManager) {
            this.renderSystem.flashCancel?.(this.inputManager.getMouseScreenPosition?.());
            console.warn(`❌ [PLAN] Placement failed: ${structureType} @ (${x}, ${y}): ${reason}`);
          }
        };
        // Placement confirmed: remove ghost plan
        this.networkManager.onStructurePlaced = (s: any) => {
          // Add the placed structure to the render system (authoritative confirmation)
          if (s.id) this._structureCompanyMap?.set(s.id, s.companyId ?? 0);
          this.renderSystem?.addPlacedStructure(s);
          // Remove the matching ghost plan entry now that server confirmed placement
          this.landGhostEntries = this.landGhostEntries.filter(g => {
            if (g.kind === s.type && Math.abs(g.worldPos.x - s.x) < 2 && Math.abs(g.worldPos.y - s.y) < 2) {
              return false;
            }
            return true;
          });
          this.renderSystem?.setLandGhostPlacements?.(this.landGhostEntries);
          this.uiManager?.setLandGhostCounts?.(this._computeLandGhostCounts?.());
        };
      }

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
  /** Predicted state from the previous fixed tick — used for sub-tick position lerp. */
  private prevPredictedWorldState: WorldState | null = null;
  /** Interpolated world state cached once per RAF frame (start of gameLoop) and reused
   *  by both updateClient (camera follow, up to 5×) and renderFrame (rendering).
   *  Avoids up to 6 O(buffer-size) scans of the snapshot buffer per display frame. */
  private _frameInterpolatedState: WorldState | null = null;
  /** Wall-clock time of the previous render frame (ms) — for smooth-error-correction decay. */
  private _lastRenderTime = 0;
  /** Single bound game-loop reference to avoid allocating a closure every frame. */
  private _boundGameLoop = (t: number) => this.gameLoop(t);
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
  // Throttle fog worker posts to ~30 Hz (every 4th client tick at 120 Hz).
  // The blur(48px) redraw in RenderSystem is skipped when rays are unchanged,
  // so reducing the post rate directly reduces the most expensive canvas op.
  private _fogTickCounter = 0;
  private static readonly FOG_POST_EVERY_N_TICKS = 4; // 120 Hz / 4 = 30 Hz
  private explicitBuildMode = false;
  private buildSelectedItem: 'cannon' | 'sail' | 'swivel' = 'cannon';
  private buildRotationDeg = 0;

  // Island structure build mode (wooden_floor / workbench / wall while off-ship)
  private islandBuildRotationDeg = 0;

  // Ghost placement system — B key opens build menu, player places planning markers
  private buildMenuOpen = false;
  private ghostPlacements: GhostPlacement[] = [];
  private pendingGhostKind: GhostModuleKind | null = null;
  /** Which resource pool to draw from when placing ship modules: 'ship' = ship chest, 'pack' = player pack. */
  private _buildResourceSource: 'pack' | 'ship' | 'auto' = 'auto';
  /** Ship Plan Menu selection — only set by clicking a row in the left Plan Menu panel.
   *  Kept separate from pendingGhostKind (hotbar) so the two are mutually exclusive,
   *  mirroring how island uses pendingLandBuildKind vs buildSchematicKind. */
  private shipPlanMenuKind: GhostModuleKind | null = null;

  // Land build mode — B key while off-ship opens land structure panel
  private landBuildMenuOpen = false;
  /** Plan Menu selection — the structure kind the player is planning to place as a ghost marker. */
  private pendingLandBuildKind: string | null = null;
  /** Build Schematic Hotbar selection — the structure kind selected for triggering construction. */
  private buildSchematicKind: string | null = null;
  /**
   * Wall placement variant. A single Wall build entry can be placed as either a solid
   * 'wall' or an open 'door_frame'. Pressing T while placing a wall toggles between them.
   * The menu/hotbar kind stays 'wall'; this override only affects the rendered preview
   * and the structure_type string sent to the server.
   */
  private wallVariant: 'wall' | 'door_frame' = 'wall';
  /** Planned land structure ghosts — click places, Enter confirms all to server. */
  private landGhostEntries: (LandGhostPlacement & { buildAction: () => void })[] = [];

  /** Last known resource pool values — used to detect gains and flash the resource panel. */
  private _prevResources = { wood: 0, fiber: 0, metal: 0, stone: 0 };

  // Weapon control groups — 10 user-defined groups (0–9), persistent per session
  private controlGroups: Map<number, WeaponGroupState> = new Map(
    Array.from({ length: 10 }, (_, i) => [i, { cannonIds: [], mode: 'haltfire' as WeaponGroupMode, targetId: -1, gunportsOpen: false, name: ['Port','Starboard','Stern','Bow','','','','','',''][i] }])
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
  /** Cannon ID for the weapon-group sub-radial opened after selecting "Weapon Group" from the mount radial. */
  private _weaponGroupSubMenuCannonId: number | null = null;
  /** Selected radial option snapshotted by a left-click on the open radial; consumed by the next E keyup. */
  private _radialClickSelected: string | null = null;
  /** Placed-structure id locked in at E-keydown for the structure interact path. */
  private _hoveredStructureId: number | null = null;
  /** Type of the locked-in structure ('wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door'). */
  private _hoveredStructureType: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wreck' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'claim_flag' | 'company_fortress' | 'chest' | 'bed' | null = null;
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
  private chestMenu    = new ChestMenu();
  private landChestMenu = new LandChestMenu();
  /** Ship construction panel opened when the player presses E at a shipyard. */
  private shipyardMenu = new ShipyardMenu();
  /** Custom rename dialog — replaces window.prompt() for ship naming. */
  private renameDialog!: ShipRenameDialog;
  /** Custom rename dialog for weapon groups. */
  private groupRenameDialog!: GroupRenameDialog;
  /** Generic confirm dialog — replaces window.confirm() calls. */
  private confirmDialog = new ConfirmDialog();
  /** Pause overlay — opened by Escape / ` / P when no other menu is up. */
  private pauseMenu = new PauseMenu();
  /** Terminal command bar — opened by / when no other menu is up. */
  private commandConsole = new CommandConsole();
  /** In-game chat window — opened by T. */
  private chatBox = new ChatBox();
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

  /** Timestamp (performance.now, ms) when the player started holding LMB for grapple wind-up.
   *  null means no active wind-up in progress. */
  private _grappleChargeStartMs: number | null = null;

  /** Max wind-up time (ms) — matches GRAPPLE_MAX_CHARGE_MS on the server. */
  private readonly GRAPPLE_MAX_CHARGE_MS = 1500;
  /** Min range at 0% charge (px, world space) — matches GRAPPLE_MIN_RANGE server constant. */
  private readonly GRAPPLE_MIN_RANGE = 100;
  /** Max range at 100% charge (px) — matches GRAPPLE_MAX_RANGE server constant. */
  private readonly GRAPPLE_MAX_RANGE = 600;

  private _grappleBoardingStartMs: number | null = null; // ms timestamp when boarding began
  private _grappleBoardingProgress = 0;                  // 0–1, exposed to RenderSystem
  /** Set to true the moment sendBoardShip() is sent; prevents the boarding timer from
   *  restarting on subsequent frames while the server is still processing the request
   *  and the grapple hook is still in ATTACHED state. Cleared when grapple detaches. */
  private _grappleBoardingSent = false;
  /** True while we have sent grapple_reel_start in; cleared on stop/detach. */
  private _grappleReelInActive = false;
  /** True while we have sent grapple_reel_start out; cleared on stop/detach. */
  private _grappleReelOutActive = false;
  /** Active hotbar slot from the last frame — used to detect slot switches. */
  private _prevActiveSlot = -1;
  
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

    // Register network event handlers after networkManager is set up (if available)
    setTimeout(() => this._registerNetworkPlanHandlers(), 0);
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
      // Per-kind land affordability check used by plan-marker tints
      this.renderSystem.landAffordabilityCheck = (kind: string) => this._canAffordLandBuild(kind);

      // Mirror deck-level transitions to the server so its per-deck collision
      // filter (lower deck = only masts block movement) stays in sync.
      // Also update the prediction engine immediately so the physics collision
      // resolver uses the correct deck-filter on the very next tick, without
      // waiting for the server echo (which would arrive one RTT later and let
      // the player walk through ramp walls / fall through upper-deck floors
      // for the duration of that round trip).
      this.renderSystem.onDeckLevelChange = (deckLevel: number) => {
        this.networkManager.sendPlayerSetDeck(deckLevel);
        this.predictionEngine.setLocalPlayerDeckLevel(deckLevel);
      };


      // Initialize rename dialog (needs canvas to position the HTML input overlay)
      this.renameDialog = new ShipRenameDialog(this.canvas);
      this.renameDialog.onConfirm = (shipId, name) => {
        this.networkManager.sendRenameShip(shipId, name);
      };

      // Group rename dialog
      this.groupRenameDialog = new GroupRenameDialog(this.canvas);
      this.groupRenameDialog.onConfirm = (groupIndex, name) => {
        const myShipId = (() => {
          const ws = this.authoritativeWorldState;
          const pid = this.networkManager.getAssignedPlayerId();
          return ws?.players.find(p => p.id === pid)?.carrierId ?? 0;
        })();
        if (myShipId) this.networkManager.sendRenameWeaponGroup(myShipId, groupIndex, name);
        const grp = this.controlGroups.get(groupIndex);
        if (grp) grp.name = name;
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

      // Server echoes the authoritative deck level after every player_set_deck request.
      // If validation was rejected the echoed level differs from what we requested —
      // roll back both the render state machine and the prediction engine immediately.
      this.networkManager.onDeckLevelAck = (deckLevel: number) => {
        if (this.renderSystem.playerDeckLevel !== deckLevel) {
          this.renderSystem.forceSetDeckLevel(deckLevel);
          this.predictionEngine.setLocalPlayerDeckLevel(deckLevel);
        }
      };
      this.networkManager.onPlayerAck = () => {
        this._playerAckReceived = true;
        if (this.state === ClientState.CONNECTED) {
          this.state = ClientState.IN_GAME;
          this.setLoadingStep(3);
          this.hideLoadingOverlay();
          console.log('🎮 Entered game world (server ack)');
          // Fetch schematics immediately so hotbar variant badges are visible
          // without needing to open the player menu first.
          this.networkManager.sendRequestSchematics();
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
            s.shipType === 99 ? `Ghost Ship - Level ${s.npcLevel ?? 1}` : (s.shipName || 'Brigantine');
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
            const myLabel = myShip ? `Your ${shipDisplayName(myShip)}` : 'Your ship';
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

      this.networkManager.onShipXpGained = (shipId, xp, x, y, shared) => {
        const label = shared ? `+${xp} XP (shared)` : `+${xp} XP`;
        const color = shared ? '#88ddff' : '#ffe066';
        this.renderSystem.spawnResourcePickup(Vec2.from(x, y), label, color);
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
          this.uiManager?.flashResourceRow?.('wood', 'up');
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
          this.uiManager?.flashResourceRow?.('fiber', 'up');
          if (wood) this.uiManager?.flashResourceRow?.('wood', 'up');
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
          this.uiManager?.flashResourceRow?.('metal', 'up');
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
          this.uiManager?.flashResourceRow?.('stone', 'up');
        } else if (reason === 'no_stamina') {
          if (_me3) this.renderSystem.spawnResourcePickup(_me3.position, 'Out of stamina!', '#e05050');
        }
      };

      this.networkManager.onBoulderHarvestResult = (success, metal, stone, reason) => {
        const ws = this.authoritativeWorldState ?? this.predictedWorldState;
        const myId = this.networkManager.getAssignedPlayerId();
        const me = myId !== null && ws ? ws.players.find(p => p.id === myId) : null;
        if (success) {
          if (me && metal > 0) { this.renderSystem.spawnResourcePickup(me.position, `+${metal} metal`, '#a0d8ff'); this.uiManager?.flashResourceRow?.('metal', 'up'); }
          if (me && stone > 0) { this.renderSystem.spawnResourcePickup(me.position, `+${stone} stone`, '#c8b89a'); this.uiManager?.flashResourceRow?.('stone', 'up'); }
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
            gunportsOpen: g.gunportsOpen ?? false,
            name: g.name ?? '',
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

      // Gunport state changed (toggled open/closed) — update local ship module data
      this.networkManager.onGunportState = (shipId, gunportId, isOpen, mass) => {
        const ws = this.authoritativeWorldState;
        const ship = ws?.ships.find(s => s.id === shipId);
        if (!ship) return;
        const mod = ship.modules.find(m => m.id === gunportId);
        if (mod?.moduleData?.kind === 'gunport') {
          (mod.moduleData as any).isOpen = isOpen;
        }
        if (mass !== undefined) ship.mass = mass;
        // Also update predicted world state if present
        const pws = this.predictedWorldState;
        const pship = pws?.ships.find(s => s.id === shipId);
        const pmod = pship?.modules.find(m => m.id === gunportId);
        if (pmod?.moduleData?.kind === 'gunport') {
          (pmod.moduleData as any).isOpen = isOpen;
        }
        if (mass !== undefined && pship) pship.mass = mass;
        // Trigger cannon slide animation (out when opening, in when closing)
        this.renderSystem.triggerGunportAnimation(gunportId, isOpen);
      };

      // Gunport blocked notification — show a UI hint
      this.networkManager.onGunportBlocked = (_cannonId, _gunportId) => {
        const assignedId = this.networkManager.getAssignedPlayerId();
        const ws = this.predictedWorldState || this.authoritativeWorldState;
        const player = assignedId !== null ? ws?.players.find(p => p.id === assignedId) : ws?.players[0];
        const pos = player?.position ?? Vec2.from(0, 0);
        this.renderSystem.spawnResourcePickup(pos, 'Open gunport first!', '#ffaa44');
      };

      // Initialize Prediction Engine
      this.predictionEngine = new PredictionEngine(this.config.prediction);
      this.shipPredictor = new ShipPredictor();
      
      // Initialize Input System
      this.inputManager = new InputManager(this.canvas, this.config.input);
      this.inputManager.onInputFrame = this.onInputFrame.bind(this);

      // Right-click: cancel charge OR start reel-out when attached.
      this.inputManager.onBeforeRightClick = (): boolean => {
        // Cancel wind-up
        if (this._grappleChargeStartMs !== null) {
          this._grappleChargeStartMs = null;
          this.renderSystem.grappleChargeProgress = 0;
          this.renderSystem.grappleAimWorldPos    = null;
          return true;
        }
        // Start reel-out when hook is attached
        const _rmbPid = this.networkManager.getAssignedPlayerId();
        const _rmbWs  = this.predictedWorldState || this.authoritativeWorldState;
        const _rmbP   = _rmbPid !== null ? _rmbWs?.players.find(p => p.id === _rmbPid) : null;
        if (_rmbP?.grappleState === 2 && !this._grappleReelOutActive) {
          this._grappleReelOutActive = true;
          if (this._grappleReelInActive) {
            this._grappleReelInActive = false;
          }
          this.networkManager.sendGrappleReelStart('out');
          return true; // consume — skip camera aim / block
        }
        return false;
      };

      // Spacebar releases grapple when flying or attached.
      this.inputManager.onSpaceJustPressed = () => {
        const _spcPid = this.networkManager.getAssignedPlayerId();
        const _spcWs  = this.predictedWorldState || this.authoritativeWorldState;
        const _spcP   = _spcPid !== null ? _spcWs?.players.find(p => p.id === _spcPid) : null;
        const _spcGs  = _spcP?.grappleState ?? 0;
        if (_spcGs === 2 || _spcGs === 1) { // ATTACHED or FLYING
          this._stopGrappleReel();
          this.networkManager.sendReleaseGrapple();
        }
      };
      
      // HYBRID PROTOCOL: Wire up state change callbacks
      this.inputManager.onMovementStateChange = (movement, isMoving, isSprinting) => {
        if (this.uiManager?.isAnyMenuOpen()) return;
        // Semi-authority: attach the client's predicted authoritative world position so the
        // server adopts it for land/dock walking instead of re-integrating from direction.
        let predPos: Vec2 | undefined;
        const pid = this.networkManager.getAssignedPlayerId();
        if (pid !== null && this.predictedWorldState) {
          const lp = this.predictedWorldState.players.find(p => p.id === pid);
          if (lp) predPos = lp.position;
        }
        this.networkManager.sendMovementState(movement, isMoving, isSprinting, predPos);
      };
      this.inputManager.onRotationUpdate = (rotation) => {
        if (this.uiManager?.isAnyMenuOpen()) return;
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
                  const playerDeckLevel = this.renderSystem.playerDeckLevel;
                  const repairable = playerShip.modules.filter(m => {
                    if (m.kind === 'deck') {
                      // Only include the deck the player is currently standing on
                      return m.deckId === playerDeckLevel;
                    }
                    return m.kind === 'plank';
                  });
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
          // Grapple hook — hold LMB to wind up (idle) or reel in (attached).
          if (activeItem === 'grapple_hook' && player && !player.isMounted) {
            const ATTACHED = 2;
            if (player.grappleState === ATTACHED) {
              // Start reeling in while LMB is held.
              if (!this._grappleReelInActive) {
                this._grappleReelInActive = true;
                if (this._grappleReelOutActive) {
                  this._grappleReelOutActive = false;
                }
                this.networkManager.sendGrappleReelStart('in');
              }
            } else if (!player.grappleState && this._grappleChargeStartMs === null) {
              this._grappleChargeStartMs = performance.now();
            }
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
          // Metal axe attack
          if (activeItem === 'metal_axe' && player && !player.isMounted) {
            const now = performance.now();
            if (now - this.lastAxeMs < this.AXE_COOLDOWN_MS * 0.9) return;
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
            this.renderSystem.spawnSwordArc(player.position, dir, 38);
            this.renderSystem.notifySwordSwing(this.AXE_COOLDOWN_MS * 0.9);
            return;
          }
          // Metal pickaxe attack
          if (activeItem === 'metal_pickaxe' && player && !player.isMounted) {
            const now = performance.now();
            if (now - this.lastPickaxeMs < this.PICKAXE_COOLDOWN_MS * 0.92) return;
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
            this.renderSystem.spawnSwordArc(player.position, dir, 36);
            this.renderSystem.notifySwordSwing(this.PICKAXE_COOLDOWN_MS * 0.92);
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

          const playerId = this.networkManager.getAssignedPlayerId();
          const worldState = this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
          const player = playerId !== null ? worldState?.players.find(p => p.id === playerId) : null;

          // ── Ghost plan completion (BEFORE exitAllBuildModes) ──────────────
          // If the player is on a ship with a nearby ghost plan and has the
          // required resources, complete the plan without needing to hold an item.
          if (player && player.carrierId !== 0) {
            const nearbyGhost = this._getNearbyGhostPlan(player);
            if (nearbyGhost) {
              const res  = player.inventory.resources;
              const cost = nearbyGhost.resourceCost;
              if (
                res.wood  >= cost.wood  &&
                res.fiber >= cost.fiber &&
                res.metal >= cost.metal &&
                res.stone >= cost.stone
              ) {
                res.wood  -= cost.wood;
                res.fiber -= cost.fiber;
                res.metal -= cost.metal;
                res.stone -= cost.stone;
                nearbyGhost.buildAction();
                this.ghostPlacements = this.ghostPlacements.filter(g => g.id !== nearbyGhost.id);
                this.syncBuildModeState();
                console.log(`🏗️ [PLAN] Built ${nearbyGhost.kind} — consumed resources`);
              } else {
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                const need: string[] = [];
                if (cost.wood  > res.wood)  need.push(`${cost.wood - res.wood}W`);
                if (cost.fiber > res.fiber) need.push(`${cost.fiber - res.fiber}Fi`);
                if (cost.metal > res.metal) need.push(`${cost.metal - res.metal}Fe`);
                if (cost.stone > res.stone) need.push(`${cost.stone - res.stone}St`);
                console.log(`❌ [PLAN] Need more resources for ${nearbyGhost.kind}: ${need.join(', ')}`);
              }
              return;
            }
          }

          // While in any build mode, block all normal interactions
          if (this.buildMenuOpen || this.explicitBuildMode || this.landBuildMenuOpen) return;

          const activeSlot = player?.inventory?.activeSlot ?? 0;
          const activeItem = player?.inventory?.slots[activeSlot]?.item ?? 'none';

          // Repair mode: active slot = wood → spend 1 wood to raise target_health on worst plank
          if (activeItem === 'wood' && player && player.carrierId !== 0) {
            console.log(`🔧 [REPAIR] Sending repair_plank (wood) for ship ${player.carrierId}`);
            this.networkManager.sendRepairPlank(player.carrierId);
            return;
          }

          // Harvest mode: axe (stone or metal) + not on a ship + hovering a tree → chop
          if ((activeItem === 'axe' || activeItem === 'metal_axe') && player && player.carrierId === 0 && !this.combatMode) {
            const tree = this.renderSystem.getHoveredTree();
            if (tree) {
              console.log(`🪓 [HARVEST] Sending harvest_resource`);
              this.networkManager.sendHarvestResource();
              return;
            }
          }

          // Demolish mode: on own ship, hovering a non-deck module → hold [E] to demolish
          if (player && player.carrierId !== 0) {
            const hoveredDemolish = this.renderSystem.getHoveredModule();
            if (hoveredDemolish && hoveredDemolish.module.kind !== 'deck' &&
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

          // Mine rock: pickaxe (stone or metal) equipped + hovering rock → press E
          if ((activeItem === 'pickaxe' || activeItem === 'metal_pickaxe') && player && player.carrierId === 0 && !this.combatMode) {
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
            // Bed interaction on island: E on a placed bed sets the respawn point
            if (hovered?.type === 'bed') {
              this.networkManager.sendStructureInteract(hovered.id);
              return;
            }
          }
          // Ship bed: use a bed item while aboard a ship to set ship respawn
          if (player && player.carrierId !== 0) {
            const inv = player.inventory;
            const activeItem = inv?.slots?.[inv.activeSlot ?? 0]?.item;
            if (activeItem === 'bed') {
              this.networkManager.sendUseBedOnShip();
              return;
            }
          }
          // Close land chest menu on E press (toggle off)
          if (this.landChestMenu.visible) {
            this.landChestMenu.close();
            this.uiManager.setActiveMenuId(null);
            return;
          }
          // Close chest menu on E press (toggle off)
          if (this.chestMenu.visible) {
            this.chestMenu.close();
            this.uiManager.setActiveMenuId(null);
            return;
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
        // Mirror into the ship predictor so it can slew the predicted mast angle
        // (1.2 rad/s, same as server) instead of using the RTT-stale snapshot
        // angle — keeps predicted wind-alignment thrust in sync while rotating.
        this.shipPredictor?.onSailAngleControl(desiredAngle);
      };
      
      // Cannon control callbacks
      this.inputManager.onCannonAim = (aimAngle, activeGroups) => {
        this.networkManager.sendCannonAim(aimAngle, activeGroups);
      };
      this.inputManager.onSwivelAim = (aimAngle) => {
        this.networkManager.sendSwivelAim(aimAngle);
      };
      this.inputManager.onCannonFire = (cannonIds, fireAll, ammoType, weaponGroup, weaponGroups) => {
        const ws = this.authoritativeWorldState || this.predictedWorldState;
        const assignedId = this.networkManager.getAssignedPlayerId();
        const myPlayer = assignedId !== null ? ws?.players.find(p => p.id === assignedId) : ws?.players[0];
        const ship = myPlayer?.carrierId ? ws?.ships.find(s => s.id === myPlayer.carrierId) ?? null : null;
        // Cannons whose gunport is mid-animation cannot fire until the animation completes
        const animBlocked = ship ? this.renderSystem.getBlockedGunportCannonIds(ship) : new Set<number>();

        // Multi-group fire: fire all cannons in every selected group
        const groups = weaponGroups && weaponGroups.size > 0 ? weaponGroups : (weaponGroup !== undefined && weaponGroup >= 0 ? new Set([weaponGroup]) : null);
        if (groups) {
          const allIds: number[] = [];
          let skipAimCheck = !!fireAll; // double-click always skips aim-angle check
          for (const g of groups) {
            const gs = this.controlGroups.get(g);
            if (!gs || gs.cannonIds.length === 0) continue;
            for (const id of gs.cannonIds) {
              if (allIds.includes(id)) continue;
              if (animBlocked.has(id)) continue; // gunport mid-animation — wait
              // From the helm, gunport cannons require an NPC crew member stationed at them
              const cannonMod = ship?.modules.find(m => m.id === id) ?? null;
              if (cannonMod && ship && this.renderSystem.isGunportCannon(cannonMod, ship)) {
                const hasNpc = ws!.npcs.some(n => n.shipId === ship.id && n.assignedWeaponId === id);
                if (!hasNpc) continue; // no crew assigned — skip until pathfinding brings them here
              }
              allIds.push(id);
            }
            if (gs.mode === 'freefire' || gs.mode === 'targetfire') skipAimCheck = true;
          }
          if (allIds.length > 0) {
            this.networkManager.sendCannonFire(allIds, false, ammoType ?? 0, skipAimCheck);
            return;
          }
        }
        // Direct fire (player physically at the cannon): block only animation, no NPC check
        const filteredIds = cannonIds?.filter(id => !animBlocked.has(id)) ?? cannonIds;
        if (!filteredIds || filteredIds.length > 0) {
          this.networkManager.sendCannonFire(filteredIds, fireAll, ammoType ?? 0);
        }
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

      this.inputManager.onCycleRampFacing = (dir: 1 | -1) => {
        this.renderSystem.cycleRampFacing(dir);
      };

      // R key while mounted at a cannon: toggle the gunport at that cannon's position
      this.inputManager.onToggleGunportAtCannon = () => {
        const ws = this.authoritativeWorldState || this.predictedWorldState;
        const myId = this.networkManager.getAssignedPlayerId();
        const me = myId !== null ? ws?.players.find(p => p.id === myId) : null;
        if (!me || me.carrierId === 0) return;
        const ship = ws?.ships.find(s => s.id === me.carrierId);
        if (!ship) return;
        const cannonId = this.inputManager.mountedCannonModuleId;
        if (cannonId === null) return;
        const cannon = ship.modules.find(m => m.id === cannonId);
        if (!cannon) return;
        // Find the associated gunport via snap_idx (proximity check is unreliable
        // because the cannon moves 40px inboard when stowed)
        const cannonData = cannon.moduleData as { gunportSnapIdx?: number } | undefined;
        const snapIdx = cannonData?.gunportSnapIdx;
        if (snapIdx === undefined || snapIdx === 255) { console.log('🔳 No gunport linked to this cannon'); return; }
        const gp = ship.modules.find(m => {
          if (m.kind !== 'gunport') return false;
          const gpData = m.moduleData as { snapIndex?: number } | undefined;
          return gpData?.snapIndex === snapIdx;
        });
        if (!gp) { console.log('🔳 No gunport at this cannon'); return; }
        this.networkManager.sendToggleGunport(ship.id, gp.id);
        console.log(`🔳 [GUNPORT] R-key toggle gunport ${gp.id} at cannon ${cannonId}`);
      };

      // R key at helm: toggle gunports for all cannons in the active weapon group(s)
      this.inputManager.onGroupGunportToggle = (groupIndices) => {
        this.networkManager.sendGroupGunportToggle(groupIndices);
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
        // In land build mode, digits 1-8 select the build schematic hotbar slot
        if (this.uiManager?.inLandBuildMode && slot >= 0 && slot < 8) {
          const kind = this.uiManager.landHotbarSlots[slot] ?? null;
          // Toggle: re-clicking the active slot deselects it
          this.buildSchematicKind = (this.buildSchematicKind === kind) ? null : kind;
          this.renderSystem.setBuildSchematicKind(this.buildSchematicKind);
          // Mutual exclusion: selecting a schematic clears the Plan Menu selection.
          if (this.buildSchematicKind !== null) {
            this.pendingLandBuildKind = null;
            this.uiManager.clearPlanKind();
          }
          this.uiManager.selectedLandKind = this.buildSchematicKind;
          this.checkBuildMode();
          return;
        }
        // In ship build mode, digits 1-8 select the build schematic hotbar slot
        // instead of the regular inventory hotbar slot
        if (this.uiManager?.inShipBuildMode && slot >= 0 && slot < 8) {
          this.uiManager.buildHotbarActiveSlot = slot;
          if (this.uiManager.onBuildHotbarSlotChange) {
            this.uiManager.onBuildHotbarSlotChange(slot, this.uiManager.buildHotbarSlots[slot] ?? null);
          }
          return;
        }
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
        if (this.pendingGhostKind !== null || this.shipPlanMenuKind !== null) {
          this.pendingGhostKind = null;
          this.shipPlanMenuKind = null;
          this.syncBuildModeState();
        }
        // Selecting a hotbar item also clears the land build panel kind (hotbar takes priority)
        if (this.pendingLandBuildKind !== null) {
          this.pendingLandBuildKind = null;
          this.uiManager.setLandBuildMenuState(false, null);
        }
        // Re-evaluate build mode: plank in active slot → build mode on
        this.checkBuildMode();
      };

      // Build placement: left-click in build mode → send place_plank / place_cannon / place_mast / replace_helm
      this.inputManager.onBuildPlace = (worldPos) => {
        // Island structure placement — add ghost marker instead of sending immediately
        // Also enter this branch when a build schematic is active (defensive: islandBuildMode
        // may not have been re-evaluated yet after a freshly-selected hotbar schematic).
        if (this.islandBuildMode || this.buildSchematicKind !== null) {
          const ws  = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          const pid = this.networkManager.getAssignedPlayerId();
          const p   = ws?.players.find(pl => pl.id === pid);
          const hotbarKind = p?.inventory?.slots[p?.inventory?.activeSlot ?? 0]?.item;

          // ── Build Schematic Hotbar placement ─────────────────────────────
          // If a build schematic is selected in the hotbar AND the cursor is
          // hovering a matching plan ghost, consume resources and start construction.
          const hoveredGhost = this.renderSystem.getHoveredLandGhost();
          if (hoveredGhost && this.buildSchematicKind === hoveredGhost.kind) {
            const entry = UIManager.LAND_BUILD_PANEL_ENTRIES.find(e => e.kind === hoveredGhost.kind);
            const cost = entry?.cost ?? [];

            // Helper: total of an item — checks inventory.resources for bulk resources, slots for others
            const RES_KEYS = ['wood', 'fiber', 'metal', 'stone'];
            const _haveItem = (item: string): number => {
              const res = (p?.inventory as any)?.resources as Record<string, number> | undefined;
              if (res && RES_KEYS.includes(item)) return res[item] ?? 0;
              let total = 0;
              for (const sl of (p?.inventory?.slots ?? [])) {
                if (sl && (sl.item as string) === item) total += sl.quantity ?? 0;
              }
              return total;
            };

            // Check resources
            let affordable = true;
            const need: string[] = [];
            for (const ing of cost) {
              const have = _haveItem(ing.item);
              if (have < ing.qty) {
                affordable = false;
                need.push(`${ing.qty - have}×${ing.item}`);
              }
            }

            if (!affordable) {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
              console.log(`❌ [SCHEMATIC] Need resources: ${need.join(', ')}`);
              return;
            }

            // Consume resources from client-predicted inventory
            if (p) {
              const res = (p.inventory as any).resources as Record<string, number> | undefined;
              for (const ing of cost) {
                if (res && RES_KEYS.includes(ing.item)) {
                  res[ing.item] = Math.max(0, (res[ing.item] ?? 0) - ing.qty);
                } else {
                  let remaining = ing.qty;
                  for (const sl of p.inventory.slots) {
                    if (!sl || (sl.item as string) !== ing.item || remaining <= 0) continue;
                    const take = Math.min(sl.quantity ?? 0, remaining);
                    sl.quantity = (sl.quantity ?? 0) - take;
                    if ((sl.quantity ?? 0) <= 0) { (sl as any).item = 'none'; sl.quantity = 0; }
                    remaining -= take;
                    if (remaining <= 0) break;
                  }
                }
              }
            }

            // Send placement (starts at 10% HP), but do NOT remove the ghost plan yet
            const gKind = hoveredGhost.kind as 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag';
            this.networkManager.sendPlaceStructure(gKind, hoveredGhost.worldPos.x, hoveredGhost.worldPos.y, hoveredGhost.rotation, true);
            // Removal of the ghost plan will happen only on STRUCTURE_PLACED confirmation
            console.log(`🏗️ [SCHEMATIC] Placed ${gKind} from plan — consumed resources (pending server confirmation)`);
            return;
          }

          // ── Build Schematic free placement (no ghost hovered) ────────────────
          // Schematic selected but cursor is not near a matching ghost plan → perform a
          // real placement with resource check + consume + under_construction=true flag
          // (server places structure at 10% HP and regenerates to full over time).
          if (this.buildSchematicKind !== null) {
            const sKind = this.buildSchematicKind as 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag';
            const sEntry = UIManager.LAND_BUILD_PANEL_ENTRIES.find(e => e.kind === sKind);
            const sCost  = sEntry?.cost ?? [];

            const sRES_KEYS = ['wood', 'fiber', 'metal', 'stone'];
            const _haveItem2 = (item: string): number => {
              const res = (p?.inventory as any)?.resources as Record<string, number> | undefined;
              if (res && sRES_KEYS.includes(item)) return res[item] ?? 0;
              let total = 0;
              for (const sl of (p?.inventory?.slots ?? [])) {
                if (sl && (sl.item as string) === item) total += sl.quantity ?? 0;
              }
              return total;
            };
            let sAffordable = true;
            const sNeed: string[] = [];
            for (const ing of sCost) {
              const have = _haveItem2(ing.item);
              if (have < ing.qty) { sAffordable = false; sNeed.push(`${ing.qty - have}×${ing.item}`); }
            }
            if (!sAffordable) {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
              console.log(`❌ [SCHEMATIC] Need resources: ${sNeed.join(', ')}`);
              return;
            }

            if (p) {
              const sRes = (p.inventory as any).resources as Record<string, number> | undefined;
              for (const ing of sCost) {
                if (sRes && sRES_KEYS.includes(ing.item)) {
                  sRes[ing.item] = Math.max(0, (sRes[ing.item] ?? 0) - ing.qty);
                } else {
                  let remaining = ing.qty;
                  for (const sl of p.inventory.slots) {
                    if (!sl || (sl.item as string) !== ing.item || remaining <= 0) continue;
                    const take = Math.min(sl.quantity ?? 0, remaining);
                    sl.quantity = (sl.quantity ?? 0) - take;
                    if ((sl.quantity ?? 0) <= 0) { (sl as any).item = 'none'; sl.quantity = 0; }
                    remaining -= take;
                    if (remaining <= 0) break;
                  }
                }
              }
            }

            const sPos = sKind === 'wooden_floor'
              ? this.renderSystem.computeSnappedPos(worldPos.x, worldPos.y)
              : (sKind === 'wall' || sKind === 'door_frame')
              ? this.renderSystem.computeSnappedWallPos(worldPos.x, worldPos.y)
              : sKind === 'door'
              ? this.renderSystem.computeSnappedDoorPos(worldPos.x, worldPos.y)
              : sKind === 'wood_ceiling'
              ? this.renderSystem.computeSnappedCeilingPos(worldPos.x, worldPos.y)
              : { x: worldPos.x, y: worldPos.y };
            const sRot = sKind === 'wooden_floor'
              ? (this.renderSystem.getSnappedBuildRotation() ?? this.islandBuildRotationDeg)
              : (sKind === 'workbench' || sKind === 'shipyard' || sKind === 'cannon') ? this.islandBuildRotationDeg
              : sKind === 'wood_ceiling' ? (this.renderSystem.getSnappedBuildRotation() ?? this.islandBuildRotationDeg)
              : 0;
            this.networkManager.sendPlaceStructure(this.applyWallVariant(sKind), sPos.x, sPos.y, sRot, true);
            console.log(`🏗️ [SCHEMATIC] Placed ${this.applyWallVariant(sKind)} @ (${sPos.x.toFixed(0)}, ${sPos.y.toFixed(0)}) rot=${sRot} — consumed resources`);
            return;
          }

          // ── Plan Menu placement ──────────────────────────────────────────
          // Place a ghost plan marker for the selected plan kind (Plan Menu).
          // Falls back to the equipped hotbar item so holding a land item still works.
          const kind = this.pendingLandBuildKind ?? hotbarKind;
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
            // Snap rotation for all structures that have a defined orientation
            let rot = 0;
            if (kind === 'wooden_floor') {
              rot = this.renderSystem.getSnappedBuildRotation() ?? this.islandBuildRotationDeg;
            } else if (kind === 'workbench' || kind === 'shipyard' || kind === 'cannon') {
              rot = this.islandBuildRotationDeg;
            } else if (kind === 'wood_ceiling') {
              rot = this.renderSystem.getSnappedBuildRotation() ?? this.islandBuildRotationDeg;
            } else if (kind === 'wall' || kind === 'door_frame') {
              // Snap to the floor edge's rotation
              // Find the snapped wall position and match the nearest floor's rotation
              const snapped = this.renderSystem.computeSnappedWallPos(worldPos.x, worldPos.y);
              // Find the supporting floor at this snapped position
              const bases = this.renderSystem.getPlacedStructures();
              let foundRot = this.islandBuildRotationDeg;
              for (const s of bases) {
                if (s.type === 'wooden_floor') {
                  const rad = (s.rotation ?? 0) * Math.PI / 180;
                  const c = Math.cos(rad), sn = Math.sin(rad);
                  const EDGES = [
                    { ldx: 0, ldy: -25 }, { ldx: 0, ldy: 25 },
                    { ldx: -25, ldy: 0 }, { ldx: 25, ldy: 0 },
                  ];
                  for (const e of EDGES) {
                    const ex = s.x + e.ldx * c - e.ldy * sn;
                    const ey = s.y + e.ldx * sn + e.ldy * c;
                    if (Math.abs(snapped.x - ex) < 5 && Math.abs(snapped.y - ey) < 5) {
                      foundRot = s.rotation ?? 0;
                    }
                  }
                }
              }
              rot = foundRot;
            } else if (kind === 'door') {
              // Snap to the door_frame's rotation
              const snapped = this.renderSystem.computeSnappedDoorPos(worldPos.x, worldPos.y);
              const bases = this.renderSystem.getPlacedStructures();
              let foundRot = this.islandBuildRotationDeg;
              for (const s of bases) {
                if (s.type === 'door_frame' && Math.abs(snapped.x - s.x) < 5 && Math.abs(snapped.y - s.y) < 5) {
                  foundRot = s.rotation ?? 0;
                }
              }
              rot = foundRot;
            }
            const capturedKind = this.applyWallVariant(kind) as 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag';
            const capturedPos  = { x: pos.x, y: pos.y };
            const capturedRot  = rot;
            // Reject structurally invalid plans (e.g. wall without a floor)
            if (!this.renderSystem.isValidLandPlanPlacement(capturedKind, capturedPos.x, capturedPos.y)) {
              console.log(`🚫 [LAND PLAN] Invalid placement: ${capturedKind} @ (${capturedPos.x.toFixed(0)}, ${capturedPos.y.toFixed(0)}) — missing required support structure`);
              return;
            }
            const id = `land-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            this.landGhostEntries.push({
              id,
              kind: capturedKind,
              worldPos: capturedPos,
              rotation: capturedRot,
              buildAction: () => this.networkManager.sendPlaceStructure(capturedKind, capturedPos.x, capturedPos.y, capturedRot),
            });
            this.renderSystem.setLandGhostPlacements(this.landGhostEntries);
            this.uiManager.setLandGhostCounts(this._computeLandGhostCounts());
            console.log(`🏗️ [LAND PLAN] Added ghost #${this.landGhostEntries.length}: ${capturedKind} @ (${capturedPos.x.toFixed(0)}, ${capturedPos.y.toFixed(0)}) rot=${capturedRot}`);
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
          this.networkManager.sendReplaceHelm(helmSlot.ship.id, this._buildResourceSource);
          return;
        }
        // Deck placement — lower deck first, upper deck once lower is present
        const deckSlot = this.renderSystem.getHoveredDeckSlot();
        if (deckSlot) {
          const lvlName = deckSlot.deckLevel === 0 ? 'lower' : 'upper';
          console.log(`🪵 [BUILD] Placing ${lvlName} deck on ship ${deckSlot.ship.id}`);
          this.networkManager.sendPlaceDeck(deckSlot.deckLevel, this._buildResourceSource);
          return;
        }
        // Ramp placement — snaps to predefined snap points on the ship
        const rampSlot = this.renderSystem.getHoveredRampSlot();
        if (rampSlot) {
          if (this.renderSystem.isInHatchBuildMode()) {
            console.log(`🪟 [BUILD] Placing hatch cover at snap ${rampSlot.snapIndex} on ship ${rampSlot.ship.id}`);
            this.networkManager.sendPlaceHatchCover(rampSlot.ship.id, rampSlot.snapIndex, this._buildResourceSource);
          } else {
            const facing = this.renderSystem.getRampFacingRadians();
            console.log(`🪜 [BUILD] Placing ramp at snap ${rampSlot.snapIndex} (${rampSlot.localPos.x},${rampSlot.localPos.y}) facing ${facing.toFixed(2)}rad on ship ${rampSlot.ship.id}`);
            this.networkManager.sendPlaceRamp(rampSlot.ship.id, rampSlot.snapIndex, facing, this._buildResourceSource);
          }
          return;
        }
        // Gunport placement — snaps to predefined positions on the hull planks
        const gunportSnap = this.renderSystem.getHoveredGunportSnap();
        if (gunportSnap) {
          console.log(`🔳 [BUILD] Placing gunport at snap ${gunportSnap.snapIndex} on ship ${gunportSnap.ship.id}`);
          this.networkManager.sendPlaceGunport(gunportSnap.ship.id, gunportSnap.snapIndex, this._buildResourceSource);
          return;
        }
        // Chest placement — free position on ship deck, cursor world→local transform
        if (this.renderSystem.isInChestBuildMode()) {
          const ws2 = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          if (ws2 && worldPos) {
            let nearestShip2 = null as (typeof ws2.ships[0]) | null;
            let nearestDist2 = Infinity;
            for (const s of ws2.ships) {
              const d = Math.hypot(worldPos.x - s.position.x, worldPos.y - s.position.y);
              if (d < nearestDist2) { nearestDist2 = d; nearestShip2 = s; }
            }
            if (nearestShip2 && nearestDist2 < 300) {
              const dx2 = worldPos.x - nearestShip2.position.x;
              const dy2 = worldPos.y - nearestShip2.position.y;
              const cosR2 = Math.cos(-nearestShip2.rotation);
              const sinR2 = Math.sin(-nearestShip2.rotation);
              const lx2   =  dx2 * cosR2 - dy2 * sinR2;
              const ly2   =  dx2 * sinR2 + dy2 * cosR2;
              console.log(`📦 [BUILD] Placing chest at (${lx2.toFixed(0)}, ${ly2.toFixed(0)}) on ship ${nearestShip2.id}`);
              this.networkManager.sendPlaceChestAt(nearestShip2.id, lx2, ly2, 0, this.renderSystem.playerDeckLevel, this._buildResourceSource);
              return;
            }
          }
        }
        // Bed placement — free position on ship deck
        if (this.renderSystem.isInBedBuildMode()) {
          const ws2 = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          if (ws2 && worldPos) {
            let nearestShip2 = null as (typeof ws2.ships[0]) | null;
            let nearestDist2 = Infinity;
            for (const s of ws2.ships) {
              const d = Math.hypot(worldPos.x - s.position.x, worldPos.y - s.position.y);
              if (d < nearestDist2) { nearestDist2 = d; nearestShip2 = s; }
            }
            if (nearestShip2 && nearestDist2 < 300) {
              const dx2 = worldPos.x - nearestShip2.position.x;
              const dy2 = worldPos.y - nearestShip2.position.y;
              const cosR2 = Math.cos(-nearestShip2.rotation);
              const sinR2 = Math.sin(-nearestShip2.rotation);
              const lx2   =  dx2 * cosR2 - dy2 * sinR2;
              const ly2   =  dx2 * sinR2 + dy2 * cosR2;
              console.log(`🛏️ [BUILD] Placing bed at (${lx2.toFixed(0)}, ${ly2.toFixed(0)}) on ship ${nearestShip2.id}`);
              this.networkManager.sendPlaceBedAt(nearestShip2.id, lx2, ly2, this.buildRotationDeg * Math.PI / 180, this.renderSystem.playerDeckLevel, this._buildResourceSource);
              return;
            }
          }
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
        // Cannon snap to gunport position
        const gpSnap = this.renderSystem.getHoveredGunportCannonSnap();
        if (gpSnap) {
          if (!this._consumeShipBuildResources('cannon')) return;
          const gp = gpSnap.module;
          const rot = gp.localPos.y < 0 ? 0 : Math.PI;
          // Offset cannon 40px toward ship centre (inward from hull at y=±90 → cannon at y=±50)
          const CANNON_INWARD_OFFSET = 40;
          const cannonY = gp.localPos.y < 0
            ? gp.localPos.y + CANNON_INWARD_OFFSET
            : gp.localPos.y - CANNON_INWARD_OFFSET;
          const gpData = gp.moduleData as import('../sim/modules').GunportModuleData;
          const snapIdx = gpData.snapIndex >= 0 && gpData.snapIndex <= 11 ? gpData.snapIndex : undefined;
          console.log(`🔳 [BUILD] Placing cannon at gunport ${gp.id} snap=${snapIdx ?? 'none'} pos (${gp.localPos.x.toFixed(0)}, ${cannonY.toFixed(0)}) rot=${(rot * 180 / Math.PI).toFixed(0)}°`);
          this.networkManager.sendPlaceCannonAt(gpSnap.ship.id, gp.localPos.x, cannonY, rot, snapIdx, 0 /* gunport cannons are always lower deck */, this._buildResourceSource);
          return;
        }
        // Plank placement build mode
        const slot = this.renderSystem.getHoveredPlankSlot();
        if (slot) {
          console.log(`🔨 [BUILD] Placing plank in slot ${slot.sectionName}[${slot.segmentIndex}] on ship ${slot.ship.id}`);
          this.networkManager.sendPlacePlank(slot.ship.id, slot.sectionName, slot.segmentIndex, this._buildResourceSource);
        }
      };

      // Permanent gunport cannon ghosts are always clickable — fire onBuildPlace even outside build mode.
      this.inputManager.checkGunportSnap = () => this.renderSystem.getHoveredGunportCannonSnap() !== null;

      // Build menu toggle (B key) — opens/closes the left-panel build menu.
      // Works anytime the player is on a ship deck.
      // If a cannon or sail item is active in the hotbar, also enters free-placement mode.
      this.inputManager.onCombatModeToggle = () => {
        this.combatMode = !this.combatMode;
      };
      this.inputManager.onBuildModeToggle = () => {
        if (this.buildMenuOpen || this.explicitBuildMode || this.landBuildMenuOpen) {
          // Close everything via the single exit helper
          this.exitAllBuildModes();
          console.log('🏗️ [BUILD MENU] CLOSED');
        } else {
          const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          const playerId = this.networkManager?.getAssignedPlayerId();
          const player = ws?.players.find(p => p.id === playerId);
          if (player?.carrierId) {
            // On a ship — open ship ghost build panel; default resource source to 'auto'
            this.buildMenuOpen = true;
            this.inputManager.buildMenuOpen = true;
            this._buildResourceSource = 'auto';
            this.uiManager.buildResourceSource = 'auto';
            this.uiManager.buildHotbarActiveSlot = -1;
            // If a buildable item is in the hotbar, also enter free-placement mode
            const activeSlot = player.inventory?.activeSlot ?? 0;
            const activeItem = player.inventory?.slots[activeSlot]?.item ?? 'none';
            if (activeItem === 'cannon' || activeItem === 'sail' || activeItem === 'swivel') {
              this.explicitBuildMode = true;
              this.buildSelectedItem = activeItem as 'cannon' | 'sail' | 'swivel';
            }
            console.log(`🏗️ [BUILD MENU] OPENED${this.explicitBuildMode ? ` (free-place: ${this.buildSelectedItem})` : ' (plan mode)'}`);
          } else {
            // On land — open land structure build panel
            this.landBuildMenuOpen = true;
            this.uiManager.setLandBuildMenuState(true, this.pendingLandBuildKind);
            console.log('🏗️ [LAND BUILD] OPENED');
          }
        }
        this.syncBuildModeState();
        this.checkBuildMode();
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

      this.inputManager.onShowResourcePanel = () => {
        this.uiManager.flashResourcePanel();
      };

      // T while placing a wall: toggle between a solid wall and a door frame variant
      this.inputManager.onBuildVariantToggle = () => {
        this.toggleWallVariant();
      };

      // Right-click in build menu or island build mode: cancel ghost or remove nearest
      this.inputManager.onToggleBuildResourceSource = () => {
        const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        const pid = this.networkManager.getAssignedPlayerId();
        const player = ws?.players.find(p => p.id === pid);
        if (!player?.carrierId) return; // only meaningful while on a ship
        this._buildResourceSource = this._buildResourceSource === 'auto' ? 'ship'
                                    : this._buildResourceSource === 'ship' ? 'pack' : 'auto';
        this.uiManager.buildResourceSource = this._buildResourceSource;
        console.log(`🏗️ [BUILD] Resource source → ${this._buildResourceSource}`);
      };

      // Right-click in build menu or island build mode: cancel ghost or remove nearest
      this.inputManager.onBuildRightClick = (worldPos: Vec2) => {
        // Island build mode OR plan menu open: remove nearest land ghost plan marker
        if (this.inputManager.islandBuildMode || this.landBuildMenuOpen) {
          this.removeNearestLandGhost(worldPos);
          return;
        }
        if (this.pendingGhostKind !== null || this.shipPlanMenuKind !== null) {
          // Cancel the ghost currently attached to the cursor
          this.pendingGhostKind = null;
          this.shipPlanMenuKind = null;
          this.syncBuildModeState();
          console.log('🏗️ [GHOST] Cancelled pending ghost');
        } else {
          // Remove the nearest placed ghost marker
          this.removeNearestGhost(worldPos);
        }
      };

      // Enter key in island build mode: confirm all land ghost plans and send to server
      this.inputManager.onBuildConfirm = () => {
        if (this.landGhostEntries.length > 0) this.confirmAllLandGhosts();
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
        if (this.confirmDialog.handleClick(x, y)) return true;
        if (this.groupRenameDialog?.handleClick(x, y)) return true;
        if (this.renameDialog?.handleClick(x, y)) return true;
        if (this.shipyardMenu.handleClick(x, y, this.canvas.width, this.canvas.height)) return true;
        const _wsClick = this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
        const _pidClick = this.networkManager.getAssignedPlayerId();
        const _invClick = _wsClick?.players.find(p => p.id === _pidClick)?.inventory ?? null;
        if (this.craftingMenu.handleClick(x, y, this.canvas.width, this.canvas.height, _invClick)) return true;
        if (this.chestMenu.handleClick(x, y, this.canvas.width, this.canvas.height)) return true;
        if (this.landChestMenu.handleClick(x, y, this.canvas.width, this.canvas.height)) return true;
        if (this.uiManager?.handleClick(x, y)) return true;
        return false;
      };

      // Forward mouse-move/up to world map for drag-pan
      this.inputManager.onUIMouseMove = (x, y) => {
        if (this.craftingMenu.visible) this.craftingMenu.handleMouseMove(x, y);
        if (this.landChestMenu.visible) this.landChestMenu.handleMouseMove(x, y);
        if (this.chestMenu.visible) this.chestMenu.handleMouseMove(x, y);
        this.uiManager?.handleWorldMapMouseMove(x, y);
      };
      this.inputManager.onUIMouseUp = (x, y) => {
        this.chestMenu.handleMouseUp(x, y);
        this.landChestMenu.handleMouseUp(x, y, this.canvas.width, this.canvas.height);
        this.uiManager?.handleWorldMapMouseUp(x, y);
      };
      // Forward wheel to world map zoom (returns true when map is visible)
      this.inputManager.onUIWheel = (deltaY, x, y) => {
        if (this.craftingMenu.visible) return this.craftingMenu.handleWheel(deltaY);
        if (this.chestMenu.visible) return true; // consume wheel so camera doesn't zoom
        if (this.landChestMenu.visible) return true; // consume wheel so camera doesn't zoom
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
      // Suppress all InputManager mouse logic while the radial menu is open.
      this.inputManager.onBeforeMouseInput = () => this._radialMenu.isOpen;

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
      this.networkManager.onChatMessage = (channel, senderName, text) => {
        this.chatBox.addMessage(channel as import('./ui/ChatBox.js').ChatChannel, senderName, text);
      };
      this.chatBox.onSend = (channel, text) => {
        this.networkManager.sendChatMessage(channel, text);
      };
      this.networkManager.onPlayerTeleported = (playerId, x, y, parentShip, localX, localY) => {
        // Snap the local player position if it's us being teleported.
        // Only set localPosition when on a ship AND it's non-zero: the server always
        // includes local_x/local_y (0,0 for bed-respawn / swim spawns). Writing
        // Vec2.from(0,0) while carrierId > 0 is truthy and causes the anchor block
        // to render the player at ship center for the first frame after the teleport.
        const newLocalPos = (parentShip > 0 && (localX !== 0 || localY !== 0))
          ? Vec2.from(localX, localY)
          : undefined;
        for (const ws of [this.authoritativeWorldState, this.predictedWorldState]) {
          const p = ws?.players.find(pl => pl.id === playerId);
          if (!p) continue;
          p.position = Vec2.from(x, y);
          p.carrierId = parentShip;
          p.localPosition = newLocalPos;
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

      // Wire weapon-group rename rows in the ship settings panel
      this.uiManager.setGroupRenameCallback((shipId, groupIndex, currentName) => {
        const grp = this.controlGroups.get(groupIndex);
        this.groupRenameDialog.open(groupIndex, grp?.name ?? currentName, grp?.name || `G${groupIndex + 1}`);
      });

      // Wire Release Ship button in ship settings — shown when docked at a shipyard
      this.uiManager.setShipReleaseCallback((_shipId, shipyardId) => {
        this.confirmDialog.open(
          '⚓  Release Ship?',
          'The ship will be launched from the shipyard. You can still board it afterwards.',
          () => { this.networkManager.sendShipyardAction(shipyardId, 'release_ship'); },
        );
      });

      // Wire deck demolish buttons in the ship menu — confirm before sending to server
      this.uiManager.setShipDemolishDeckCallback((shipId, moduleId, deckLevel) => {
        const deckName = deckLevel === 1 ? 'Upper' : 'Lower';
        this.confirmDialog.open(
          `Demolish ${deckName} Deck?`,
          `This will destroy all modules on the ${deckName.toLowerCase()} deck. This cannot be undone.`,
          () => { this.networkManager.sendDemolishModule(shipId, moduleId); },
        );
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

      // Request schematic list when the player menu opens so the Schematics tab
      // shows the player's current quality blueprints without needing a workbench.
      this.uiManager.onPlayerMenuOpen = () => {
        this.networkManager.sendRequestSchematics();
      };

      this.uiManager.onPlayerLevelUp = () => {
        this.networkManager.sendPlayerLevelUp();
      };

      // Sync the level-up callback so the LEVEL UP button in the player menu works
      this.uiManager.syncPlayerLevelUpCallback();

      // Wire respawn confirmation: flash white, snap camera, send network request immediately
      this.uiManager.setRespawnConfirmedCallback((shipId, worldX, worldY, islandId, spawnX, spawnY, bedRespawn) => {
        // 1. Hold screen at full white
        this.uiManager.triggerWhiteFlash();
        this.uiManager.closeRespawnScreen();

        // 2. Snap camera to spawn target so it's in the right place when white fades
        if (spawnX !== undefined && spawnY !== undefined) {
          this.camera.setPosition(Vec2.from(spawnX, spawnY));
        }

        // 3. Send network request immediately
        this.networkManager.sendRespawnRequest(shipId, worldX, worldY, islandId, bedRespawn);
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

      // Supply chest resources for the resource panel.
      // • On a ship: shows ship chest modules only if at least one chest exists.
      // • On land: shows nearby land chest (PlacedStructure type='chest') resources.
      this.uiManager.getShipChestResources = () => {
        const ws  = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        if (!ws) return null;
        const pid    = this.networkManager.getAssignedPlayerId();
        const player = ws.players.find(p => p.id === pid);

        // ── Case 1: player is on a ship ──────────────────────────────────
        if (player?.carrierId) {
          const ship = ws.ships.find(s => s.id === player.carrierId);
          if (!ship) return null;
          if (!ship.modules.some(m => m.kind === 'chest')) return null;
          const totals = { wood: 0, fiber: 0, metal: 0, stone: 0 };
          for (const mod of ship.modules) {
            const data = mod.moduleData;
            if (data?.kind === 'chest') {
              totals.wood  += data.wood  ?? 0;
              totals.fiber += data.fiber ?? 0;
              totals.metal += data.metal ?? 0;
              totals.stone += data.stone ?? 0;
            }
          }
          return totals;
        }

        // ── Case 2: player is on land — aggregate nearby territory chests ─
        if (player) {
          const LAND_CHEST_RANGE_SQ = 600 * 600;
          const structs = this.renderSystem.getPlacedStructures();
          const totals  = { wood: 0, fiber: 0, metal: 0, stone: 0 };
          let found = false;
          for (const s of structs) {
            if (s.type !== 'chest' || !s.chestResources) continue;
            const dx = s.x - player.position.x;
            const dy = s.y - player.position.y;
            if (dx * dx + dy * dy > LAND_CHEST_RANGE_SQ) continue;
            found = true;
            totals.wood  += s.chestResources.wood  ?? 0;
            totals.fiber += s.chestResources.fiber ?? 0;
            totals.metal += s.chestResources.metal ?? 0;
            totals.stone += s.chestResources.stone ?? 0;
          }
          return found ? totals : null;
        }

        return null;
      };

      // Supply land-chest resources accessible from a nearby shipyard.
      // Only applies when the player is on a ship within range of a land shipyard.
      this.uiManager.getShipyardResources = () => {
        const ws  = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        if (!ws) return null;
        const pid    = this.networkManager.getAssignedPlayerId();
        const player = ws.players.find(p => p.id === pid);
        if (!player?.carrierId) return null;
        const ship = ws.ships.find(s => s.id === player.carrierId);
        if (!ship) return null;

        const YARD_RANGE_SQ = 500 * 500;
        const structs = this.renderSystem.getPlacedStructures();

        // Find shipyards within range of the ship
        const nearYards = structs.filter(s => {
          if (s.type !== 'shipyard') return false;
          const dx = s.x - ship.position.x;
          const dy = s.y - ship.position.y;
          return dx * dx + dy * dy <= YARD_RANGE_SQ;
        });
        if (nearYards.length === 0) return null;

        // Aggregate land chest resources near any of those shipyards
        const totals = { wood: 0, fiber: 0, metal: 0, stone: 0 };
        let found = false;
        for (const yard of nearYards) {
          for (const s of structs) {
            if (s.type !== 'chest' || !s.chestResources) continue;
            const dx = s.x - yard.x;
            const dy = s.y - yard.y;
            if (dx * dx + dy * dy > YARD_RANGE_SQ) continue;
            found = true;
            totals.wood  += s.chestResources.wood  ?? 0;
            totals.fiber += s.chestResources.fiber ?? 0;
            totals.metal += s.chestResources.metal ?? 0;
            totals.stone += s.chestResources.stone ?? 0;
          }
        }
        return found ? totals : null;
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

      // Drop resources by dragging a resource chip outside the panel
      this.uiManager.playerMenu.onDropResources = (kind, amount) => {
        this.networkManager.sendDropResources(kind, amount);
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
            const killerName = killerShip ? (killerShip.shipType === 99 ? `Ghost Ship - Level ${killerShip.npcLevel ?? 1}` : (killerShip.shipName || 'Brigantine')) : null;
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
        this._refreshCollisionContext();

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
          // Increment version so RenderSystem knows to re-render the fog canvas.
          this.renderSystem.fogRayVersion++;
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
        this._refreshCollisionContext();
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
        const _sdLastHp = this.renderSystem.getPlacedStructureById(id)?.hp ?? 3000;
        this._structureCompanyMap.delete(id);
        this._structureLastDamagedAt.delete(id);
        this.renderSystem.removePlacedStructure(id);
        this._refreshCollisionContext();
        if (x !== undefined && y !== undefined) {
          // Cannonball kill — big explosion
          this.renderSystem.spawnExplosion(Vec2.from(x, y), 1.2);
          const _sdMyId = this.networkManager.getAssignedPlayerId();
          const _sdWs = this.authoritativeWorldState ?? this.predictedWorldState;
          const _sdMyComp = _sdMyId !== null ? (_sdWs?.players.find(p => p.id === _sdMyId)?.companyId ?? -1) : -1;
          const _sdTeam: DamageTeam =
            _sdMyComp > 0 && _sdComp === _sdMyComp ? 'enemy' : 'friendly';
          this.renderSystem.spawnDamageNumber(Vec2.from(x, y), _sdLastHp, true, _sdTeam);
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
        const _shDmg = prev !== null ? Math.max(0, prev.prevHp - hp) : 3000;
        this.renderSystem.spawnDamageNumber(Vec2.from(x, y), _shDmg || 3000, false, _shTeam);
      };
      this.networkManager.onTreeHit = (x, y) => {
        this.renderSystem.spawnExplosion(Vec2.from(x, y), 0.5);
      };
      this.networkManager.onStructurePlaced = (s) => {
        this._structureCompanyMap.set(s.id, s.companyId ?? 0);
        this.renderSystem.addPlacedStructure(s);
        this._refreshCollisionContext();
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
          missing_resources: 'Not enough resources',
        };
        const msg = REASONS[reason] ?? `Placement failed (${reason})`;
        const kind = (reason === 'missing_resources' || reason === 'missing_item') ? 'warning' : 'info';
        this.renderSystem.showAnnouncement(`\u{1F6A7} ${msg}`, kind, 2.0);
        this.renderSystem.setBlockerStructure(blockerId ?? null, 2000);
      };
      this.networkManager.onDoorToggled = (id, open) => {
        this.renderSystem.updateStructureDoorOpen(id, open);
      };
      this.networkManager.onDoorLockToggled = (id, locked, open) => {
        this.renderSystem.updateStructureDoorLocked(id, locked, open);
      };

      // Bed respawn: store the respawn point so the respawn screen shows it as an option
      this.networkManager.onBedUsed = (bedId, x, y, shipId) => {
        this.uiManager.setBedRespawnPoint(bedId, x, y, shipId);
        const msg = shipId
          ? '🛏 Bed set on ship — you will respawn here on death'
          : `🛏 Respawn point set (${Math.round(x ?? 0)}, ${Math.round(y ?? 0)})`;
        this.chatBox.addMessage('global', '[System]', msg);
      };
      this.networkManager.onBedCooldown = (remainingMs) => {
        const secs = Math.ceil(remainingMs / 1000);
        this.chatBox.addMessage('global', '[System]', `🛏 Bed cooldown: ${secs}s remaining`);
      };
      this.networkManager.onCraftingOpen = (structureId, structureType) => {
        if (structureType === 'shipyard') {
          // Fallback if server still sends crafting_open for shipyard (pre-update)
          this.shipyardMenu.open(structureId, 'empty', []);
          this.uiManager.setActiveMenuId(MENU_ID.SHIPYARD);
        } else {
          this.craftingMenu.open(structureId);
          this.uiManager.setActiveMenuId(MENU_ID.CRAFTING);
          // Pull the player's schematics so the Schematics tab is populated.
          this.networkManager.sendRequestSchematics();
        }
      };

      this.networkManager.onLandChestState = (structureId, chestRes, playerRes, readOnly) => {
        this.landChestMenu.updateChestResources(chestRes);
        // Keep the cached placed-structure chest contents in sync. The server
        // only sends land_chest_state to the acting client (no STRUCTURES
        // rebroadcast), so without this the build resource panel / shipyard
        // aggregation would show stale chest counts until a reconnect.
        this.renderSystem.updateStructureChestResources(structureId, chestRes);
        if (!this.landChestMenu.visible) {
          this.landChestMenu.open(structureId, chestRes, readOnly);
        } else {
          this.landChestMenu.setReadOnly(readOnly ?? false);
        }
        if (playerRes) {
          this.landChestMenu.updatePlayerResources(playerRes);
        }
      };

      this.landChestMenu.onTransfer = (structureId, item, quantity, direction) => {
        this.networkManager.sendLandChestTransfer(structureId, item, quantity, direction);
      };

      this.landChestMenu.onDrop = (structureId, item, quantity, fromSide) => {
        if (fromSide === 'player') {
          this.networkManager.sendDropResources(item, quantity);
        } else {
          this.networkManager.sendLandChestDrop(structureId, item, quantity);
        }
      };

      this.networkManager.onShipyardState = (structureId, phase, modulesPlaced, shipSpawned, scaffoldedShipId, spawnerPlayerId) => {
        this.renderSystem.updateShipyardConstruction(structureId, phase, modulesPlaced, scaffoldedShipId);
        if (this.shipyardMenu.visible && this.shipyardMenu.structureId === structureId) {
          this.shipyardMenu.updateState(phase, modulesPlaced);
        }
        // Don't auto-open the menu on broadcast — player opens it with E or
        // installs modules by clicking on the skeleton directly.
        if (shipSpawned) {
          const myId = this.networkManager.getAssignedPlayerId();
          const isMyShip = spawnerPlayerId != null && myId != null && spawnerPlayerId === myId;
          if (isMyShip) {
            this.shipyardMenu.close();
            this.uiManager.setActiveMenuId(null);
          }
          this.renderSystem.showAnnouncement('⚓ Ship released!', 'info', 3.5);
          // Only open the rename dialog for the player who released the ship
          if (isMyShip) {
            this.renameDialog.open(shipSpawned, '');
          }
        }
      };

      this.shipyardMenu.onAction = (action, module) => {
        if (this.shipyardMenu.structureId == null) return;
        this.networkManager.sendShipyardAction(this.shipyardMenu.structureId, action, module);
      };

      this.networkManager.onShipyardActionFail = (reason) => {
        const MSGS: Record<string, string> = {
          ship_limit:       'World ship limit reached — too many ships active',
          missing_materials:'Not enough materials',
          already_building: 'Shipyard already building a ship',
          no_ship:          'No ship under construction',
          use_build_mode:   'Use build mode (B) to add modules',
        };
        const msg = MSGS[reason] ?? `Shipyard failed (${reason})`;
        this.renderSystem.showAnnouncement(`⚓ ${msg}`, 'warning', 3.5);
      };

      this.craftingMenu.onCraft = (recipeId) => {
        this.networkManager.sendCraftItem(recipeId);
      };

      this.craftingMenu.onCraftSchematic = (index) => {
        this.networkManager.sendCraftBlueprint(index);
      };

      // Schematic (blueprint) list — populate the Schematics tab in both menus.
      this.networkManager.onSchematicList = (items) => {
        this.craftingMenu.setSchematics(items);
        this.uiManager.playerMenu.setSchematics(items);
      };

      // Crafting a blueprint succeeded/failed; the server re-sends the schematic
      // list on success, so just surface a toast here.
      this.networkManager.onCraftBlueprintResult = (success, _index, reason, item, tier, _craftsRemaining) => {
        if (success) {
          this.renderSystem.showAnnouncement(
            `${tierName(tier)} ${itemDisplayName(item)} crafted!`, 'info', 2.5);
        } else {
          const msg: Record<string, string> = {
            missing_ingredients: 'Not enough materials',
            inventory_full:      'Inventory is full',
            not_at_workbench:    'Must be at a workbench',
            invalid_schematic:   'Schematic no longer available',
            unknown_item:        'Unknown blueprint item',
          };
          this.renderSystem.showAnnouncement(`⚒ ${msg[reason] ?? `Craft failed (${reason})`}`, 'warning', 2.5);
        }
      };

      // Salvaged a quality blueprint from a wreck.
      this.networkManager.onSalvageBlueprint = (item, tier, crafts, _wreckId, _bpRemaining, _lootRemaining) => {
        this.renderSystem.showAnnouncement(
          `📜 Salvaged ${tierName(tier)} ${itemDisplayName(item)} blueprint (${crafts} craft${crafts === 1 ? '' : 's'})`,
          'info', 3.0);
        // Refresh the Schematics tab if the crafting menu is open.
        if (this.craftingMenu.visible) this.networkManager.sendRequestSchematics();
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
        // Mutual exclusion: Plan Menu click clears the build hotbar selection
        this.shipPlanMenuKind = kind;
        this.uiManager.buildHotbarActiveSlot = -1;
        this.buildRotationDeg = 0;
        this.syncBuildModeState();
        console.log(`🏗️ [GHOST] Picking up ghost: ${kind} — click on ship to place`);
      };

      // Land build panel: player selected a land structure type from the Plan Menu
      this.uiManager.onLandBuildPanelSelect = (kind: string) => {
        if (!kind) return;
        this.pendingLandBuildKind = kind;
        this.wallVariant = 'wall';
        // Mutual exclusion: selecting a plan clears the Build Schematic Hotbar selection.
        this.buildSchematicKind = null;
        this.renderSystem.setBuildSchematicKind(null);
        this.uiManager.setLandBuildMenuState(this.landBuildMenuOpen, kind);
        // checkBuildMode will set selectedLandKind = null (buildSchematicKind is now null)
        this.checkBuildMode();
        console.log(`🏗️ [PLAN] Selected: ${kind}`);
      };

      // Build Schematic Hotbar: player clicked a hotbar slot (may deselect if toggled)
      this.uiManager.onBuildSchematicSelect = (kind: string | null) => {
        this.buildSchematicKind = kind;
        this.wallVariant = 'wall';
        this.renderSystem.setBuildSchematicKind(kind);
        // Mutual exclusion: selecting a schematic clears the Plan Menu selection.
        if (kind !== null) {
          this.pendingLandBuildKind = null;
          this.uiManager.clearPlanKind();
        }
        this.checkBuildMode();
        console.log(`🏗️ [SCHEMATIC] Hotbar selected: ${kind ?? '(none)'}`);
      };

      // Build hotbar slot selected (click or 1-8 key in ship build mode)
      this.uiManager.onBuildHotbarSlotChange = (slot: number, kind: GhostModuleKind | null) => {
        if (!kind) return;
        const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        const playerId = this.networkManager?.getAssignedPlayerId();
        const player = ws?.players.find(p => p.id === playerId);
        if (player && (player.inventory?.activeSlot ?? 255) !== 255) {
          for (const ws2 of [this.authoritativeWorldState, this.predictedWorldState]) {
            const p2 = ws2?.players.find(pl => pl.id === playerId);
            if (p2) p2.inventory.activeSlot = 255;
          }
          this.networkManager.sendUnequip();
        }
        this.explicitBuildMode = false;
        this.pendingGhostKind = kind;
        // Mutual exclusion: hotbar selection clears the Plan Menu selection
        this.shipPlanMenuKind = null;
        this.buildRotationDeg = 0;
        this.syncBuildModeState();
        this.checkBuildMode();
        console.log(`🏗️ [BUILD HOTBAR] Slot ${slot + 1} → ${kind}`);
      };


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
      requestAnimationFrame(this._boundGameLoop);
      
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
  /**
   * Rebuilds and pushes the collision context to the prediction engine.
   * Called whenever islands or placed structures change.
   * Cheap — just grabs existing references; no copying.
   */
  private _refreshCollisionContext(): void {
    const islands = this.renderSystem.getIslands?.() ?? [];
    const structures = this.renderSystem.getPlacedStructures?.() ?? [];
    if (islands.length === 0 && structures.length === 0) return;
    const ctx: CollisionContext = { islands, structures };
    this.predictionEngine.setCollisionContext(ctx);
  }

  /** Send reel-stop if currently reeling, and clear state flags. */
  private _stopGrappleReel(): void {
    if (this._grappleReelInActive || this._grappleReelOutActive) {
      this.networkManager.sendGrappleReelStop();
    }
    this._grappleReelInActive  = false;
    this._grappleReelOutActive = false;
  }

  /** Full grapple cleanup — stop reel + detach. */
  private _releaseGrapple(): void {
    this._stopGrappleReel();
    this._grappleChargeStartMs = null;
    this._grappleBoardingStartMs = null;
    this._grappleBoardingProgress = 0;
    this.renderSystem.grappleChargeProgress = 0;
    this.renderSystem.grappleAimWorldPos    = null;
    this.networkManager.sendReleaseGrapple();
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
    
    // Compute the interpolated state once per RAF frame and cache it.
    // updateClient (camera follow) and renderFrame both need it; without caching
    // getInterpolatedState does an O(snapshot-buffer) scan on every call, which
    // would fire up to 6× per display frame (5 catch-up ticks + 1 render).
    this._frameInterpolatedState = this.predictionEngine.getInterpolatedState(currentTime);

    // Fixed timestep client updates (prediction, input processing).
    // Cap the number of catch-up ticks per frame: after a long stall (tab refocus, GC, a heavy
    // frame) the accumulator can hold many ticks' worth of time. Running all of them in one
    // frame produces a visible hitch. Instead we run at most MAX_TICKS_PER_FRAME and drop the
    // backlog (keeping only the sub-tick remainder so the render `alpha` stays valid).
    const MAX_TICKS_PER_FRAME = 5;
    let ticksThisFrame = 0;
    while (this.accumulator >= this.clientTickDuration && ticksThisFrame < MAX_TICKS_PER_FRAME) {
      this.updateClient(this.clientTickDuration);
      this.accumulator -= this.clientTickDuration;
      ticksThisFrame++;
    }
    if (this.accumulator >= this.clientTickDuration) {
      // Hit the cap — discard the whole-tick backlog, keep the fractional remainder.
      this.accumulator = this.accumulator % this.clientTickDuration;
    }
    
    // Variable timestep updates (UI, audio, etc.)
    this.updateVariableTimestep(clampedDelta);
    
    // Render frame with interpolation
    const alpha = this.accumulator / this.clientTickDuration;
    this.renderFrame(alpha);
    
    // Continue game loop (reuse a single bound reference — no per-frame closure allocation)
    requestAnimationFrame(this._boundGameLoop);
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

    // Capture per-frame mouse flags BEFORE inputManager.update() calls resetFrameFlags(),
    // which clears them. Anything that needs "was released this frame" must use these captures.
    const _lmbJustReleased = this.inputManager.isLeftMouseJustReleased();
    const _rmbJustReleased = this.inputManager.isRightMouseJustReleased();

    this.inputManager.update(dt);
    
    // Update prediction engine (client-side simulation)
    if (this.authoritativeWorldState && this.state === ClientState.IN_GAME) {
      // Step the ship predictor every fixed tick (mirrors server physics rate).
      // Skipped when ship prediction is disabled — ships then use pure interpolation.
      if (this.config.prediction.enableShipPrediction) {
        this.shipPredictor?.step(dt);
      }

      // Snapshot previous state for sub-tick position lerp in renderFrame
      this.prevPredictedWorldState = this.predictedWorldState;

      const _rawInputFrame = this.inputManager.getCurrentInputFrame();
      // Inject grapple reel flags so Physics.ts can mirror server-side rope behaviour
      if (this._grappleReelInActive)  _rawInputFrame.grappleReelIn  = true;
      if (this._grappleReelOutActive) _rawInputFrame.grappleReelOut = true;
      this.predictedWorldState = this.predictionEngine.update(
        this.authoritativeWorldState,
        _rawInputFrame,
        dt
      );
      
      // Camera follows the PREDICTED local player so the world scrolls at the full client
      // tick rate (120 Hz). Following the interpolated state instead would re-introduce the
      // 30 Hz server cadence into camera motion (perceived as choppy movement). updateCamera
      // only reads the local player, so splicing it into the interpolated world is sufficient.
      if (this.predictedWorldState) {
        const _interp = this._frameInterpolatedState;
        const _assignedId = this.networkManager.getAssignedPlayerId();
        let _cameraFollowState: WorldState = this.predictedWorldState;
        if (_interp && _assignedId !== null) {
          const _predLocal = this.predictedWorldState.players.find(p => p.id === _assignedId);
          if (_predLocal) {
            const _idx = _interp.players.findIndex(p => p.id === _assignedId);
            const _players = _interp.players.slice();
            if (_idx >= 0) _players[_idx] = _predLocal;
            else _players.push(_predLocal);
            _cameraFollowState = { ..._interp, players: _players };
          } else {
            _cameraFollowState = _interp;
          }
        }
        this.updateCamera(_cameraFollowState, dt);
        
        // Update input manager with current player position and velocity for hybrid protocol
        const assignedPlayerId = this.networkManager.getAssignedPlayerId();
        const player = assignedPlayerId !== null 
          ? this.predictedWorldState.players.find(p => p.id === assignedPlayerId)
          : this.predictedWorldState.players[0];
        
        if (player) {
          this.inputManager.setPlayerPosition(player.position);
          this.inputManager.setPlayerVelocity(player.velocity); // For stop detection
          this.inputManager.setPlayerStamina(player.stamina ?? player.maxStamina ?? 100, player.maxStamina ?? 100);
          // Mirror server's carry-weight gate for sprint (block at ≥ 85 % capacity).
          {
            const carryCap = 300 * (1 + ((player.statWeight ?? 0) as number) * 0.1);
            const carryKg  = player.inventory ? computeInventoryWeight(player.inventory) : 0;
            this.inputManager.setPlayerCarryRatio(carryCap > 0 ? carryKg / carryCap : 0);
          }
          this.renderSystem.playerInteractInfo = {
            worldPos: player.position,
            localPos: player.localPosition ?? null,
            carrierId: player.carrierId ?? null,
          };

          // --- Dynamic view-range / AOI ---
          // Cast rays against island coastlines to compute per-direction visibility
          // distances. Used for the fog mask (RenderSystem) and server AOI hint.
          // Worker posts are throttled to ~30 Hz (every N ticks) — fog doesn't
          // need to update at the full 120 Hz client tick rate, and the
          // RenderSystem dirty flag skips the blur(48px) when rays are unchanged.
          this._fogTickCounter++;
          if (this._fogWorkerReady && this._fogWorker) {
            if (this._fogTickCounter % ClientApplication.FOG_POST_EVERY_N_TICKS === 0) {
              this._fogWorker.postMessage({ type: 'COMPUTE', x: player.position.x, y: player.position.y });
            }
          } else {
            // Fallback: synchronous (before first ISLANDS message, or if worker unavailable).
            const islands = this.renderSystem.getIslands();
            this.computeViewRays(player.position, islands);
            this.renderSystem.fogRayVersion++;
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

          // ── Grapple hook wind-up / fire / reel / release ───────────────────
          {
            const gSlot = player.inventory?.activeSlot ?? 0;
            const gItem = player.inventory?.slots[gSlot]?.item;
            const isGrappleEquipped = gItem === 'grapple_hook' && !player.isMounted;
            const ATTACHED = 2;
            const isAttached = player.grappleState === ATTACHED;

            // ── Hotbar-switch or un-equip → release grapple ──────────────────
            if (this._prevActiveSlot !== -1 && this._prevActiveSlot !== gSlot && (player.grappleState ?? 0) > 0) {
              this._releaseGrapple();
            }
            this._prevActiveSlot = gSlot;

            // ── Cancel charge if grapple un-equipped ─────────────────────────
            if (this._grappleChargeStartMs !== null && !isGrappleEquipped) {
              this._grappleChargeStartMs = null;
            }

            // ── Clear reel flags if grapple detached ─────────────────────────
            if (!isAttached && (this._grappleReelInActive || this._grappleReelOutActive)) {
              this._stopGrappleReel();
            }

            // ── LMB released ─────────────────────────────────────────────────
            if (_lmbJustReleased) {
              if (isGrappleEquipped) {
                if (this._grappleChargeStartMs !== null) {
                  // Wind-up complete → fire.
                  const elapsed = performance.now() - this._grappleChargeStartMs;
                  const charge  = Math.min(1, elapsed / this.GRAPPLE_MAX_CHARGE_MS);
                  this.networkManager.sendFireGrapple(this.inputManager.getMouseWorldPosition(), charge);
                  this._grappleChargeStartMs = null;
                } else if (isAttached && this._grappleReelInActive) {
                  // Stop reeling in on LMB release.
                  this._grappleReelInActive = false;
                  this.networkManager.sendGrappleReelStop();
                }
              } else {
                this._grappleChargeStartMs = null;
              }
            }

            // ── RMB released → stop reel-out ─────────────────────────────────
            if (_rmbJustReleased && this._grappleReelOutActive) {
              this._grappleReelOutActive = false;
              this.networkManager.sendGrappleReelStop();
            }

            // ── Boarding timer ────────────────────────────────────────────────
            // Activates when grapple is ATTACHED to a ship AND the player is
            // touching the ship hull (within hull-collision range). The bar only
            // fills while LMB is held; releasing LMB pauses/resets the bar.
            const BOARD_TIME_MS       = 2500; // full hold duration to complete boarding
            const BOARD_HULL_RANGE    = 90;   // px from hook — trigger boarding before old auto-detach range
            const GRAPPLE_TARGET_SHIP = 2;

            const isShipGrapple  = isAttached && player.grappleTargetType === GRAPPLE_TARGET_SHIP;
            const isAtHull       = isShipGrapple &&
              player.grappleX !== undefined && player.grappleY !== undefined &&
              (() => {
                const dx = player.position.x - player.grappleX!;
                const dy = player.position.y - player.grappleY!;
                return Math.sqrt(dx * dx + dy * dy) <= BOARD_HULL_RANGE;
              })();
            const isHoldingLMB   = this.inputManager.isLeftMouseDown();
            const canBoard       = isAtHull && isHoldingLMB;

            // Clear the sent-flag once the server has confirmed the grapple is gone
            // (grappleState no longer ATTACHED). This is the authoritative signal that
            // the previous boarding request was fully processed.
            if (!isAttached && this._grappleBoardingSent) {
              this._grappleBoardingSent = false;
            }

            if (canBoard && !this._grappleBoardingSent) {
              if (this._grappleBoardingStartMs === null) {
                this._grappleBoardingStartMs = performance.now();
                // Stop reel-in so the hook stays pinned at the hull — continuing to
                // reel would hit GRAPPLE_DETACH_DIST and detach the hook mid-boarding.
                if (this._grappleReelInActive) {
                  this._grappleReelInActive = false;
                  this.networkManager.sendGrappleReelStop();
                }
              }
              const elapsed = performance.now() - this._grappleBoardingStartMs;
              this._grappleBoardingProgress = Math.min(1, elapsed / BOARD_TIME_MS);
              if (this._grappleBoardingProgress >= 1) {
                this.networkManager.sendBoardShip();
                this._grappleBoardingStartMs = null;
                this._grappleBoardingProgress = 0;
                this._grappleBoardingSent = true; // block re-entry until server confirms detach
                // Optimistically set deck=1 immediately — server always boards at upper deck.
                // The carrier-change handler in onServerWorldState will confirm once the
                // snapshot arrives; this just closes the window where the client has no ship.
                this.renderSystem.forceSetDeckLevel(1);
                this.predictionEngine.setLocalPlayerDeckLevel(1);
                this.renderSystem.setJustBoarded();
                this._releaseGrapple();
              }
            } else if (!canBoard || this._grappleBoardingSent) {
              // Pause/reset: LMB released, player moved away, or boarding already sent
              if (this._grappleBoardingStartMs !== null) {
                this._grappleBoardingStartMs = null;
                this._grappleBoardingProgress = 0;
              }
            }

            // Push charge progress + aim to RenderSystem every frame.
            let chargeProgress = 0;
            if (isGrappleEquipped && this._grappleChargeStartMs !== null) {
              chargeProgress = Math.min(1, (performance.now() - this._grappleChargeStartMs) / this.GRAPPLE_MAX_CHARGE_MS);
            }
            this.renderSystem.grappleChargeProgress = chargeProgress;
            this.renderSystem.grappleProjectedRange = this.GRAPPLE_MIN_RANGE
              + chargeProgress * (this.GRAPPLE_MAX_RANGE - this.GRAPPLE_MIN_RANGE);
            this.renderSystem.grappleAimWorldPos = chargeProgress > 0
              ? this.inputManager.getMouseWorldPosition()
              : null;
            this.renderSystem.grappleBoardingProgress = this._grappleBoardingProgress;
          }
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
    // Use the interpolated state cached at the start of gameLoop — avoids a
    // redundant O(snapshot-buffer) scan that would duplicate updateClient's work.
    const currentTime = performance.now();
    const interpolatedState = this._frameInterpolatedState;

    // Frame delta (seconds) for decaying the smooth-error-correction offset.
    const _renderDt = this._lastRenderTime > 0
      ? Math.min(0.1, (currentTime - this._lastRenderTime) / 1000)
      : 0;
    this._lastRenderTime = currentTime;
    // Decaying visual offset that eases server corrections in instead of popping.
    const _renderErrorOffset = this.predictionEngine.getRenderErrorOffset(_renderDt);
    
    // Build hybrid world: predicted local player + interpolated other entities
    const assignedPlayerId = this.networkManager.getAssignedPlayerId();
    let worldToRender = interpolatedState || this.predictedWorldState || this.authoritativeWorldState || this.demoWorldState;
    
    // Only use hybrid rendering if prediction is enabled
    const predictionEnabled = this.config.prediction.enablePrediction;
    
    // If we have both predicted and interpolated states AND prediction is enabled, create hybrid.
    // Local player uses prediction (instant response), others use interpolation (smooth).
    // Sub-tick lerp: the fixed-step simulation runs at 120 Hz but the display runs at the
    // browser frame rate. `alpha` is the fractional tick elapsed since the last sim step, so
    // we lerp the predicted position between prevPredicted → currentPredicted to eliminate
    // the staircase micro-jitter that would otherwise appear at ≤120 fps.
    if (predictionEnabled && assignedPlayerId !== null && this.predictedWorldState && interpolatedState) {
      const predictedPlayer = this.predictedWorldState.players.find(p => p.id === assignedPlayerId);
      const prevPlayer = this.prevPredictedWorldState?.players.find(p => p.id === assignedPlayerId);
      const localIdx = interpolatedState.players.findIndex(p => p.id === assignedPlayerId);
      const interpolatedPlayer = localIdx >= 0 ? interpolatedState.players[localIdx] : undefined;
      
      if (predictedPlayer) {
        const currentRotation = this.inputManager.getCurrentInputFrame().rotation;

        // Sub-tick lerp: blend prev→current predicted position using accumulator fraction.
        // Then add the decaying error offset so server corrections ease in instead of popping.
        const predPos = (prevPlayer
          ? prevPlayer.position.lerp(predictedPlayer.position, alpha)
          : predictedPlayer.position).add(_renderErrorOffset);
        const predVel = prevPlayer
          ? prevPlayer.velocity.lerp(predictedPlayer.velocity, alpha)
          : predictedPlayer.velocity;

        // IMPORTANT: take only the CONTINUOUS quantities (position/velocity/rotation) from the
        // predictor. All DISCRETE state flags (onDeck, carrierId, isMounted, deckId, health, …)
        // come from the authoritative interpolated server state. The client-side carrier
        // detection re-runs every prediction tick and can flip onDeck on/off frame-to-frame
        // (e.g. standing on an island next to a docked ship), which would otherwise make the
        // player sprite flicker green/red. Server flags are stable, so use them for rendering.
        const stateBase = interpolatedPlayer ?? predictedPlayer;
        const renderPlayer = {
          ...stateBase,
          rotation: currentRotation,
          position: predPos,
          velocity: predVel,
        };

        if (localIdx >= 0) {
          const newPlayers = interpolatedState.players.slice();
          newPlayers[localIdx] = renderPlayer;
          worldToRender = { ...interpolatedState, players: newPlayers };
        } else {
          worldToRender = interpolatedState;
        }
      }
    }
    
    // Splice ShipPredictor output — use physics-accurate predicted position/rotation/velocity
    // for the local player's ship, same pattern as the player prediction splice above.
    // Sub-tick lerp (same alpha as the local player) eliminates the staircase jitter that
    // would otherwise appear when the fixed 120 Hz sim step advances at a different rate
    // than the display frame rate.
    if (predictionEnabled && this.config.prediction.enableShipPrediction
        && assignedPlayerId !== null && worldToRender) {
      const predictedShip = this.shipPredictor?.getPredictedShip();
      const prevShip      = this.shipPredictor?.getPrevPredictedShip();
      if (predictedShip) {
        const myPlayerIdx = worldToRender.players.findIndex(p => p.id === assignedPlayerId);
        const myPlayer = myPlayerIdx >= 0 ? worldToRender.players[myPlayerIdx] : undefined;
        if (myPlayer?.carrierId) {
          const shipIdx = worldToRender.ships.findIndex(s => s.id === myPlayer.carrierId);
          if (shipIdx >= 0) {
            // Sub-tick lerp: blend prev→current to eliminate staircase micro-jitter.
            // IMPORTANT: the ship predictor steps physics in fixed 1/30 s server
            // ticks (exact server math), so use ITS tick fraction — the engine's
            // 120 Hz `alpha` would leave visible 33 ms position steps. Feed the
            // engine's sub-client-tick remainder in so frame pacing stays smooth.
            const shipAlpha = this.shipPredictor?.getSubTickAlpha(
              alpha * this.clientTickDuration / 1000,
            ) ?? alpha;
            // Decaying correction offset: the predictor snaps its PHYSICS pose to
            // server corrections instantly and hands the visual delta back here to
            // ease out over ~80 ms, so corrections glide instead of stepping per
            // physics tick (the prior "blend into the physics state" jittered).
            const shipErr = this.shipPredictor?.getRenderErrorOffset(_renderDt)
              ?? { pos: Vec2.zero(), rot: 0 };
            const renderPos = (prevShip
              ? prevShip.position.lerp(predictedShip.position, shipAlpha)
              : predictedShip.position).add(shipErr.pos);
            // Rotation is a critically-damped follow of the physics heading (never
            // snaps), not a snap+offset like position — ships yaw slowly enough that
            // the ~2° follow lag is invisible, and this eliminates correction snaps.
            const renderRot = this.shipPredictor?.getRenderRotation(
              alpha * this.clientTickDuration / 1000,
              _renderDt,
            ) ?? predictedShip.rotation;
            const renderVel = prevShip
              ? prevShip.velocity.lerp(predictedShip.velocity, shipAlpha)
              : predictedShip.velocity;
            const renderAngVel = prevShip
              ? prevShip.angularVelocity + (predictedShip.angularVelocity - prevShip.angularVelocity) * shipAlpha
              : predictedShip.angularVelocity;

            const newShips = worldToRender.ships.slice();
            newShips[shipIdx] = {
              ...worldToRender.ships[shipIdx], // keep server data (modules, health, etc.)
              position:        renderPos,
              velocity:        renderVel,
              rotation:        renderRot,
              angularVelocity: renderAngVel,
            };
            worldToRender = { ...worldToRender, ships: newShips };

            // Re-anchor the local player to the RENDERED ship pose. The player's predicted
            // world position was computed against the prediction engine's own ship copy,
            // which can diverge from the ShipPredictor pose drawn on screen — that mismatch
            // is the visible "sliding/lagging on deck while sailing". On deck the player is
            // a rigid ship-local anchor, so derive their render position from the same ship
            // transform the renderer uses.
            const predLocalPlayer = this.predictedWorldState?.players.find(p => p.id === assignedPlayerId);
            const prevLocalPlayer = this.prevPredictedWorldState?.players.find(p => p.id === assignedPlayerId);
            let anchor = predLocalPlayer?.localPosition;
            if (anchor && prevLocalPlayer?.localPosition) {
              // Sub-tick lerp of the local anchor (same alpha as the position splice above).
              anchor = prevLocalPlayer.localPosition.lerp(anchor, alpha);
            }
            if (anchor) {
              const cosR = Math.cos(renderRot);
              const sinR = Math.sin(renderRot);
              const anchoredPos = Vec2.from(
                renderPos.x + anchor.x * cosR - anchor.y * sinR,
                renderPos.y + anchor.x * sinR + anchor.y * cosR,
              ).add(_renderErrorOffset);
              const newPlayers = worldToRender.players.slice();
              newPlayers[myPlayerIdx] = { ...myPlayer, position: anchoredPos };
              worldToRender = { ...worldToRender, players: newPlayers };
            }
          }
        }
      }
    }

    // Ship prediction DISABLED (default): the local player's ship renders from pure
    // server-snapshot interpolation (already in worldToRender). We only re-anchor the
    // local on-deck player onto that interpolated hull. The player splice above set their
    // world position from the PREDICTION engine, which derived it against its own
    // (RTT-old server-snapshot) copy of the ship — not the interpolated pose drawn here —
    // so without this they'd slide/lag relative to the deck while the ship moves. The
    // ship-local anchor (localPosition) stays client-predicted so walking is responsive;
    // we just compose it with the rendered (interpolated) ship transform.
    if (predictionEnabled && !this.config.prediction.enableShipPrediction
        && assignedPlayerId !== null && worldToRender) {
      const myPlayerIdx = worldToRender.players.findIndex(p => p.id === assignedPlayerId);
      const myPlayer = myPlayerIdx >= 0 ? worldToRender.players[myPlayerIdx] : undefined;
      if (myPlayer?.carrierId) {
        const shipIdx = worldToRender.ships.findIndex(s => s.id === myPlayer.carrierId);
        if (shipIdx >= 0) {
          const interpShip = worldToRender.ships[shipIdx];
          const predLocalPlayer = this.predictedWorldState?.players.find(p => p.id === assignedPlayerId);
          const prevLocalPlayer = this.prevPredictedWorldState?.players.find(p => p.id === assignedPlayerId);
          let anchor = predLocalPlayer?.localPosition;
          if (anchor && prevLocalPlayer?.localPosition) {
            // Sub-tick lerp of the local anchor (same alpha as the local player splice).
            anchor = prevLocalPlayer.localPosition.lerp(anchor, alpha);
          }
          if (anchor) {
            const cosR = Math.cos(interpShip.rotation);
            const sinR = Math.sin(interpShip.rotation);
            const anchoredPos = Vec2.from(
              interpShip.position.x + anchor.x * cosR - anchor.y * sinR,
              interpShip.position.y + anchor.x * sinR + anchor.y * cosR,
            ).add(_renderErrorOffset);
            const newPlayers = worldToRender.players.slice();
            newPlayers[myPlayerIdx] = { ...myPlayer, position: anchoredPos };
            worldToRender = { ...worldToRender, players: newPlayers };
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

      // Detect resource gains and flash the resource panel
      if (localPlayer) {
        const res = (localPlayer.inventory as any)?.resources ?? { wood: 0, fiber: 0, metal: 0, stone: 0 };
        const prev = this._prevResources;
        for (const key of ['wood', 'fiber', 'metal', 'stone'] as const) {
          if (res[key] > prev[key]) this.uiManager?.flashResourceRow?.(key, 'up');
          else if (res[key] < prev[key]) this.uiManager?.flashResourceRow?.(key, 'down');
        }
        this._prevResources = { wood: res.wood, fiber: res.fiber, metal: res.metal, stone: res.stone };
      }

      // Sword cooldown ring: only visible when sword is the active item and player is unmounted
      const _activeSlot  = localPlayer?.inventory?.activeSlot ?? 0;
      this.renderSystem.swordEquipped =
        (localPlayer?.inventory?.slots[_activeSlot]?.item === 'sword') &&
        !(localPlayer?.isMounted ?? false);
      this.renderSystem.axeEquipped =
        (localPlayer?.inventory?.slots[_activeSlot]?.item === 'axe' ||
         localPlayer?.inventory?.slots[_activeSlot]?.item === 'metal_axe') &&
        !(localPlayer?.isMounted ?? false);
      this.renderSystem.combatMode = this.combatMode;
      if (this.explicitBuildMode) this.syncBuildModeState();

      // Update ghost affordability every frame so slot tints update immediately.
      // Covers both build-panel (pendingGhostKind) and hotbar-driven (activeItem) modes.
      {
        const _localP = localPlayer;
        const _activeSlot = _localP?.inventory?.activeSlot ?? 0;
        const _activeItem = _localP?.inventory?.slots[_activeSlot]?.item ?? 'none';
        const _ITEM_TO_KIND: Partial<Record<string, GhostModuleKind>> = {
          plank: 'plank', cannon: 'cannon', sail: 'mast', swivel: 'swivel',
          helm_kit: 'helm', deck: 'deck', ramp: 'ramp',
          wood_ceiling: 'hatch_cover', door: 'gunport', resource_chest: 'chest',
        };
        const _hoveredGpSnap = this.renderSystem.getHoveredGunportCannonSnap() !== null;
        const _effectiveKind: GhostModuleKind | null =
          this.pendingGhostKind ?? (_ITEM_TO_KIND[_activeItem] ?? (_hoveredGpSnap ? 'cannon' : null));
        const _inAnyShipBuild = (this.buildMenuOpen || this.explicitBuildMode
          || this.inputManager.buildMode || _hoveredGpSnap) && (_localP?.carrierId ?? 0) !== 0;
        this.renderSystem.ghostCanAfford =
          (_inAnyShipBuild && _effectiveKind)
            ? this._canAffordShipBuild(_effectiveKind)
            : true;

        // Land build affordability — use ClientApplication.islandBuildMode directly
        // (RenderSystem.islandBuildKind is only set during the draw phase, too late)
        if (this.islandBuildMode || this.landBuildMenuOpen) {
          const _activeSlotLand = localPlayer?.inventory?.activeSlot ?? 0;
          const _hotbarLand     = localPlayer?.inventory?.slots[_activeSlotLand]?.item ?? null;
          // Priority: explicit plan kind → land schematic selection → hotbar item
          const _rawKind        = this.pendingLandBuildKind ?? this.buildSchematicKind ?? _hotbarLand;
          const _resolvedKind   = this.applyWallVariant(_rawKind);
          this.renderSystem.landGhostCanAfford = this._canAffordLandBuild(_resolvedKind);
        } else {
          this.renderSystem.landGhostCanAfford = true;
        }
      }

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
      this.renderSystem.altKeyHeld = this.inputManager?.altKeyHeld ?? false;
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
        const hotbarKind = localPlayer?.inventory?.slots[activeSlotB]?.item ?? 'wooden_floor';
        const islandBuildKind = this.applyWallVariant(this.pendingLandBuildKind ?? hotbarKind) as 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag' | 'chest';
        const _isWallContext = (this.buildSchematicKind === 'wall' || this.buildSchematicKind === 'door_frame'
          || this.pendingLandBuildKind === 'wall' || this.pendingLandBuildKind === 'door_frame'
          || islandBuildKind === 'wall' || islandBuildKind === 'door_frame');
        this.uiManager.setIslandBuildState({
          kind: islandBuildKind,
          tooFar: this.renderSystem.getIslandBuildTooFar(),
          enemyClose: false, // TODO: detect when enemies are nearby
          wallVariant: _isWallContext ? this.wallVariant : undefined,
        });
      } else {
        this.uiManager.setIslandBuildState(null);
      }

      // Render UI overlay
      const playerShipId = localPlayer?.carrierId ?? 0;
      const playerShip = playerShipId
        ? (worldToRender.ships.find(s => s.id === playerShipId) ?? null)
        : null;
      // Determine if the player's ship is currently scaffolded at a shipyard
      const _scaffoldedShipyardId = (() => {
        if (!playerShipId) return 0;
        const structs = this.renderSystem.getPlacedStructures();
        const sy = structs.find(s => s.type === 'shipyard' && s.construction?.scaffoldedShipId === playerShipId);
        return sy?.id ?? 0;
      })();

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
        scaffoldedShipyardId: _scaffoldedShipyardId,
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
      // Resource chest inventory panel
      if (this.chestMenu.visible) {
        // Keep chest data fresh from the current world state
        const wsC = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        const chestShipId  = (this.chestMenu as any)._shipId   as number | undefined;
        const chestModuleId = (this.chestMenu as any)._moduleId as number | undefined;
        const chestShip = wsC?.ships.find(s => s.id === chestShipId);
        const chestMod  = chestShip?.modules.find(m => m.id === chestModuleId);
        if (chestMod?.moduleData?.kind === 'chest') {
          this.chestMenu.updateChestData(chestMod.moduleData as import('../sim/modules.js').ChestModuleData);
        }
        this.chestMenu.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
          localPlayer?.inventory ?? null,
        );
      }
      // Land chest menu — two-card deposit/withdraw GUI
      if (this.landChestMenu.visible) {
        // Sync player pack resources every frame
        const landRes = (localPlayer?.inventory as any)?.resources ?? { wood: 0, fiber: 0, metal: 0, stone: 0 };
        this.landChestMenu.updatePlayerResources(landRes);
        this.landChestMenu.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
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
      // Confirm dialog — above all other UI
      if (this.confirmDialog.visible) {
        this.confirmDialog.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
        );
      }
      // Rename dialog — topmost overlay
      if (this.groupRenameDialog?.visible) {
        this.groupRenameDialog.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
        );
      }
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
        // Frame-rate independent smoothing via an exponential time-constant.
        // Now that the local player is predicted (already smooth), the camera can follow much
        // more tightly than before — a ~50 ms constant keeps motion responsive without the
        // old ~145 ms "swimmy" lag while still absorbing sub-tick boundaries.
        const CAMERA_FOLLOW_TAU = 0.05; // seconds
        const lerpFactor = 1.0 - Math.exp(-dt / CAMERA_FOLLOW_TAU);
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
    // Don't send input (including rotation) while any menu is open.
    if (this.uiManager?.isAnyMenuOpen()) return;
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

            // Authoritative deck sync: server always boards at deck 1.
            // Align all three deck sources (render, prediction, server) immediately so
            // the ramp state machine doesn't start from a stale or 0 value.
            const serverDeck = player.deckId ?? 1;
            this.renderSystem.forceSetDeckLevel(serverDeck);
            this.predictionEngine.setLocalPlayerDeckLevel(serverDeck);
            // Mark that we just boarded — RenderSystem will skip ramp detection briefly.
            this.renderSystem.setJustBoarded();
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
    
    // Sync local player ID into prediction engine (safe to do every frame — cheap assignment)
    this.predictionEngine.localPlayerId = this.networkManager.getAssignedPlayerId();

    // Update prediction engine with authoritative state
    this.predictionEngine.onAuthoritativeState(worldState);

    // Feed ShipPredictor with server ship state + wind.
    // Skipped when ship prediction is disabled — ships then use pure interpolation.
    if (this.shipPredictor && this.config.prediction.enableShipPrediction) {
      const myId = this.networkManager.getAssignedPlayerId();
      const myPlayer = worldState.players.find(p => p.id === myId);
      const playerShip = myPlayer?.carrierId ? worldState.ships.find(s => s.id === myPlayer.carrierId) : null;
      if (playerShip) {
        // Snapshot age ≈ one-way latency + half the server broadcast interval.
        // The predictor forward-projects the snapshot by this much before
        // reconciling — comparing against the raw (stale) snapshot drags the
        // ship backwards by speed × age every snapshot (rubberbanding).
        const pingMs = this.networkManager.getStats().ping;
        const snapshotAgeMs = (pingMs > 0 ? pingMs / 2 : 0) + (1000 / 30) / 2;
        this.shipPredictor.setIslands(this.renderSystem.getIslands());
        // Collision impulse partners: other ships + shipyard dock walls.
        // Must be fed BEFORE onServerShip so the snapshot forward-projection
        // advances the freshly cloned other-ship states by the same age.
        this.shipPredictor.setOtherShips(worldState.ships, playerShip.id);
        this.shipPredictor.setStructures(this.renderSystem.getPlacedStructures());
        this.shipPredictor.onServerShip(playerShip, snapshotAgeMs);
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
    if (!this.buildMenuOpen && !this.explicitBuildMode && this.pendingGhostKind === null && !this.landBuildMenuOpen) return;
    this.buildMenuOpen      = false;
    this.inputManager.buildMenuOpen = false;
    this.explicitBuildMode  = false;
    this.pendingGhostKind   = null;
    this.shipPlanMenuKind   = null;
    this.buildRotationDeg   = 0;
    this.landBuildMenuOpen  = false;
    this.pendingLandBuildKind = null;
    this.buildSchematicKind = null;
    this.renderSystem.setBuildSchematicKind(null);
    this.uiManager.setLandBuildMenuState(false, null);
    // NOTE: landGhostEntries are intentionally kept alive so the plan persists
    // across panel open/close. They are only cleared by Enter (confirmAllLandGhosts)
    // or right-click removal.
    this.syncBuildModeState();
    this.checkBuildMode();
    console.log('🏗️ [BUILD] All build/plan modes exited');
  }

  /**
   * Check whether the active hotbar item puts the player in build mode.
   * Plank in active slot → build mode on. Anything else → build mode off.
   */
  /**
   * Map a raw land-build kind through the active wall variant. When the kind is a wall
   * (or door frame), it resolves to whichever variant is currently selected via the T key;
   * all other kinds pass through unchanged.
   */
  private applyWallVariant<T extends string | null>(kind: T): T {
    return (kind === 'wall' || kind === 'door_frame') ? (this.wallVariant as T) : kind;
  }

  /** Toggle the active wall placement between a solid wall and a door frame (T key). */
  private toggleWallVariant(): void {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    const playerId = this.networkManager?.getAssignedPlayerId();
    const player   = ws?.players.find(p => p.id === playerId);
    const activeSlot = player?.inventory?.activeSlot ?? 0;
    const activeItem = player?.inventory?.slots[activeSlot]?.item ?? 'none';
    const base = this.buildSchematicKind ?? this.pendingLandBuildKind ?? activeItem;
    if (base !== 'wall' && base !== 'door_frame') return;
    this.wallVariant = this.wallVariant === 'wall' ? 'door_frame' : 'wall';
    this.checkBuildMode(); // refresh the placement preview immediately
    console.log(`🧱 Wall variant → ${this.wallVariant}`);
  }

  private checkBuildMode(): void {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    const playerId = this.networkManager?.getAssignedPlayerId();
    const player   = ws?.players.find(p => p.id === playerId);

    const activeSlot  = player?.inventory?.activeSlot ?? 0;
    const activeItem  = player?.inventory?.slots[activeSlot]?.item ?? 'none';
    const pgk = this.pendingGhostKind; // build-menu ghost kind activates matching snap mode
    const inBuildMode        = activeItem === 'plank'     || pgk === 'plank';
    const inCannonBuildMode  = activeItem === 'cannon'    || pgk === 'cannon';
    const inMastBuildMode    = activeItem === 'sail'      || pgk === 'mast';
    const inSwivelBuildMode  = activeItem === 'swivel'    || pgk === 'swivel';
    const inHelmBuildMode    = activeItem === 'helm_kit'  || pgk === 'helm';
    const inDeckBuildMode    = activeItem === 'deck'      || pgk === 'deck';
    const inRampBuildMode    = activeItem === 'ramp'      || pgk === 'ramp';
    // Hatch cover build mode: on-ship + wood_ceiling equipped, OR hatch_cover ghost selected
    const inHatchBuildMode   = ((player?.carrierId ?? 0) !== 0 && activeItem === 'wood_ceiling') || pgk === 'hatch_cover';
    // Gunport build mode: on-ship + door item equipped, OR gunport ghost selected
    const inGunportBuildMode = ((player?.carrierId ?? 0) !== 0 && activeItem === 'door') || pgk === 'gunport';
    // Chest build mode: resource_chest item equipped while on a ship, OR chest ghost selected
    const inChestBuildMode   = ((player?.carrierId ?? 0) !== 0 && activeItem === 'resource_chest') || pgk === 'chest';
    // Bed build mode: bed ghost selected from ship build menu
    const inBedBuildMode     = pgk === 'bed';

    // Auto-exit land build modes if the player is now on a ship (boarded mid-build)
    if ((player?.carrierId ?? 0) !== 0 && this.landBuildMenuOpen) {
      this.landBuildMenuOpen = false;
      this.pendingLandBuildKind = null;
      this.uiManager?.setLandBuildMenuState(false, null);
    }

    // Island placement build mode — wooden_floor, workbench, or wall while not on a ship
    // Also activated when pendingLandBuildKind is set (via the land build panel)
    const islandItem = this.pendingLandBuildKind ?? activeItem;
    const LAND_BUILDABLE = new Set(['wooden_floor', 'workbench', 'wall', 'door_frame', 'door', 'shipyard', 'wood_ceiling', 'cannon', 'flag_fort', 'company_fortress', 'claim_flag', 'chest']);
    const inIslandBuildMode = (player?.carrierId === 0) && LAND_BUILDABLE.has(islandItem);
    // Also active when a build schematic is selected in the hotbar (player may build from plan)
    const inSchematicBuildMode = (player?.carrierId === 0) && this.buildSchematicKind !== null;
    this.islandBuildMode = (inIslandBuildMode || inSchematicBuildMode) && !this.explicitBuildMode;
    // Treat the land build menu as island-build-mode for InputManager so that
    // right-click, Enter confirm, and rotation keys work even when no hotbar
    // item is selected (plan menu open, pendingLandBuildKind drives placement).
    this.inputManager.islandBuildMode = this.islandBuildMode || this.landBuildMenuOpen;
    // Show the placement ghost preview:
    //  - plan kind when the Plan Menu item is selected
    //  - schematic kind when the Build Schematic Hotbar slot is selected (preview follows cursor,
    //    and snaps onto the matching planned ghost when hovered)
    const _previewKind = !this.explicitBuildMode
      ? (inIslandBuildMode ? this.applyWallVariant(islandItem) : (inSchematicBuildMode ? this.applyWallVariant(this.buildSchematicKind!) : null))
      : null;
    this.renderSystem.setIslandBuildItem(
      _previewKind as 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag' | 'chest' | null
    );
    // Push build schematic kind to render system for ghost hover detection
    this.renderSystem.setBuildSchematicKind((player?.carrierId === 0) ? this.buildSchematicKind : null);
    // Also show planned ghosts when holding a hammer on land (repair/inspect flow)
    const hammerOnLand = activeItem === 'hammer' && (player?.carrierId ?? 0) === 0;
    this.renderSystem.landBuildModeActive = this.landBuildMenuOpen || this.islandBuildMode || hammerOnLand;
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
    this.renderSystem.setRampBuildMode(!this.explicitBuildMode && inRampBuildMode);
    this.renderSystem.setHatchBuildMode(!this.explicitBuildMode && inHatchBuildMode);
    this.renderSystem.setGunportBuildMode(!this.explicitBuildMode && inGunportBuildMode);
    this.renderSystem.setChestBuildMode(!this.explicitBuildMode && inChestBuildMode);
    this.renderSystem.setBedBuildMode(!this.explicitBuildMode && inBedBuildMode);
    if (this.inputManager) {
      this.inputManager.inRampBuildMode  = !this.explicitBuildMode && inRampBuildMode;
      this.inputManager.inHatchBuildMode = !this.explicitBuildMode && inHatchBuildMode;
    }
    this.inputManager.buildMode = this.explicitBuildMode || this.buildMenuOpen
      || inBuildMode || inCannonBuildMode || inMastBuildMode || inSwivelBuildMode || inHelmBuildMode || inDeckBuildMode || inRampBuildMode || inHatchBuildMode || inGunportBuildMode || inChestBuildMode || inBedBuildMode || this.islandBuildMode
      || (((player?.carrierId ?? 0) !== 0) && activeItem === 'claim_flag');

    // Show build hotbar when: build menu is open or explicit build mode is active
    if (this.uiManager) {
      this.uiManager.inShipBuildMode = this.buildMenuOpen || this.explicitBuildMode;
      this.uiManager.inLandBuildMode = this.landBuildMenuOpen || this.islandBuildMode;
      // selectedLandKind drives the Build Schematic Hotbar active-slot highlight
      this.uiManager.selectedLandKind = this.buildSchematicKind;
    }
    // Propagate hammer equipped state to render system for repair visuals
    if (this.renderSystem) this.renderSystem.hammerEquipped = activeItem === 'hammer';
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

    // Sync ghost placement state — Plan Menu highlight uses shipPlanMenuKind (independent from hotbar)
    this.uiManager?.setBuildMenuState(this.buildMenuOpen, this.ghostPlacements, this.shipPlanMenuKind);
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
    const kind = this.pendingGhostKind;

    // ── Snap-based module kinds ───────────────────────────────────────────
    // These read the already-computed hover state from the render system
    // so the player sees the same highlighted slot they're clicking on.
    // ── Snap-based kinds: direct placement matching island schematic protocol ──
    // Resource check + optimistic consume at click time, then send immediately.
    // No intermediate ghost plan — identical to island schematic click behaviour.
    if (kind === 'plank') {
      const sl = this.renderSystem.getHoveredPlankSlot();
      if (!sl) return;
      if (!this._consumeShipBuildResources(kind)) return;
      const plankBp = this.uiManager.playerMenu.getVariantForKind('plank') ?? undefined;
      this.networkManager.sendPlacePlank(sl.ship.id, sl.sectionName, sl.segmentIndex, this._buildResourceSource, plankBp);
      console.log(`🏗️ [SHIP BUILD] Placed plank on ship ${sl.ship.id} — consumed resources (${this._buildResourceSource})${plankBp !== undefined ? ` bp_index=${plankBp}` : ''}`);
      return;
    }
    if (kind === 'deck') {
      const sl = this.renderSystem.getHoveredDeckSlot();
      if (!sl) return;
      if (!this._consumeShipBuildResources(kind)) return;
      const deckBp = this.uiManager.playerMenu.getVariantForKind('deck') ?? undefined;
      this.networkManager.sendPlaceDeck(sl.deckLevel, this._buildResourceSource, deckBp);
      console.log(`🏗️ [SHIP BUILD] Placed deck (level ${sl.deckLevel}) — consumed resources (${this._buildResourceSource})${deckBp !== undefined ? ` bp_index=${deckBp}` : ''}`);
      return;
    }
    if (kind === 'helm') {
      const sl = this.renderSystem.getHoveredHelmSlot();
      if (!sl) return;
      if (!this._consumeShipBuildResources(kind)) return;
      this.networkManager.sendReplaceHelm(sl.ship.id, this._buildResourceSource);
      console.log(`🏗️ [SHIP BUILD] Placed helm on ship ${sl.ship.id} — consumed resources (${this._buildResourceSource})`);
      return;
    }
    if (kind === 'ramp') {
      const sl = this.renderSystem.getHoveredRampSlot();
      if (!sl) return;
      if (!this._consumeShipBuildResources(kind)) return;
      const facing = this.renderSystem.getRampFacingRadians();
      this.networkManager.sendPlaceRamp(sl.ship.id, sl.snapIndex, facing, this._buildResourceSource);
      console.log(`🏗️ [SHIP BUILD] Placed ramp (snap ${sl.snapIndex}) — consumed resources (${this._buildResourceSource})`);
      return;
    }
    if (kind === 'hatch_cover') {
      const sl = this.renderSystem.getHoveredRampSlot();
      if (!sl) return;
      if (!this._consumeShipBuildResources(kind)) return;
      this.networkManager.sendPlaceHatchCover(sl.ship.id, sl.snapIndex, this._buildResourceSource);
      console.log(`🏗️ [SHIP BUILD] Placed hatch cover (snap ${sl.snapIndex}) — consumed resources (${this._buildResourceSource})`);
      return;
    }
    if (kind === 'gunport') {
      const sl = this.renderSystem.getHoveredGunportSnap();
      if (!sl) return;
      if (!this._consumeShipBuildResources(kind)) return;
      this.networkManager.sendPlaceGunport(sl.ship.id, sl.snapIndex, this._buildResourceSource);
      console.log(`🏗️ [SHIP BUILD] Placed gunport (snap ${sl.snapIndex}) — consumed resources (${this._buildResourceSource})`);
      return;
    }

    // ── Snap-to-canonical-slot kinds (mast) ────────────────────────────
    // Mast: check snap-point first — snaps to the 3 canonical mast positions if cursor
    // is within snap radius. Falls through to free-placement ghost if not near a snap.
    if (kind === 'mast') {
      const ms = this.renderSystem.getHoveredMastSlot();
      if (ms) {
        if (!this._consumeShipBuildResources('mast')) return;
        const snapX = RenderSystem.MAST_XS[ms.mastIndex];
        console.log(`⛵ [SHIP BUILD] Placed mast at snap ${ms.mastIndex} (${snapX.toFixed(0)}, 0) — consumed resources`);
        this.networkManager.sendPlaceMastAt(ms.ship.id, snapX, 0, this._buildResourceSource,
          this.uiManager.playerMenu.getVariantForKind('mast') ?? undefined);
        return;
      }
      // No canonical snap nearby — fall through to free-placement ghost below
    }

    // ── Free-placement module kinds (cannon, mast, swivel, chest) ────────
    // Cannon: check gunport snap first — snaps to existing unlinked gunport position
    if (kind === 'cannon') {
      const gpSnap = this.renderSystem.getHoveredGunportCannonSnap();
      if (gpSnap) {
        if (!this._consumeShipBuildResources('cannon')) return;
        const gp = gpSnap.module;
        const rot = gp.localPos.y < 0 ? 0 : Math.PI;
        const cannonY = gp.localPos.y < 0 ? gp.localPos.y + 40 : gp.localPos.y - 40;
        const gpData = gp.moduleData as import('../sim/modules').GunportModuleData;
        const snapIdx = gpData.snapIndex >= 0 && gpData.snapIndex <= 11 ? gpData.snapIndex : undefined;
        console.log(`🔳 [SHIP BUILD] Placed cannon at gunport snap=${snapIdx ?? 'none'} — consumed resources (${this._buildResourceSource})`);
        this.networkManager.sendPlaceCannonAt(gpSnap.ship.id, gp.localPos.x, cannonY, rot, snapIdx, 0 /* gunport cannons are always lower deck */, this._buildResourceSource,
          this.uiManager.playerMenu.getVariantForKind('cannon') ?? undefined);
        return;
      }
      // Fixed-position slot ghosts (old helm-offset layout) — snap schematic to slot position
      const cs = this.renderSystem.getHoveredCannonSlot();
      if (cs) {
        if (!this._consumeShipBuildResources('cannon')) return;
        console.log(`🔳 [SHIP BUILD] Placed cannon at fixed slot ${cs.cannonIndex} (${cs.localX.toFixed(0)}, ${cs.localY.toFixed(0)}) — consumed resources (${this._buildResourceSource})`);
        this.networkManager.sendPlaceCannonAt(cs.ship.id, cs.localX, cs.localY, cs.rot, undefined, 1, this._buildResourceSource,
          this.uiManager.playerMenu.getVariantForKind('cannon') ?? undefined);
        return;
      }
    }

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
    const placeDeck = this.renderSystem.playerDeckLevel;
    const newFp = getModuleFootprint(this.pendingGhostKind as any);
    for (const mod of nearestShip.modules) {
      if (mod.kind === 'plank' || mod.kind === 'deck') continue;
      if (kind === 'cannon' && mod.kind === 'gunport') continue; // cannons coexist with gunports
      if (mod.deckId !== 255 && mod.deckId !== placeDeck) continue; // different deck — no collision
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

    // Consume resources and place immediately
    if (!this._consumeShipBuildResources(kind)) return;
    this._makeBuildAction(kind, nearestShip.id, localX, localY, ghostRotRad)();
    console.log(`🏗️ [SHIP BUILD] Placed ${kind} at (${localX.toFixed(0)}, ${localY.toFixed(0)}) — consumed resources (${this._buildResourceSource})`);
  }

  /**
   * Check and optimistically consume raw resources for a ship module placement.
   * Mirrors the island schematic resource-check pattern exactly.
   * Returns true if resources were available and consumed, false (+ flashCancel) if not.
   */
  /** Read-only affordability check — same logic as _consumeShipBuildResources but no deduction. */
  private _canAffordLandBuild(kind: string | null): boolean {
    if (!kind) return true;
    const entry = UIManager.LAND_BUILD_PANEL_ENTRIES.find(e => e.kind === kind);
    if (!entry || !entry.cost.length) return true;
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    const playerId = this.networkManager.getAssignedPlayerId();
    const player = ws?.players.find(p => p.id === playerId);
    if (!player) return false;
    const res  = player.inventory.resources;
    const RES_KEYS = ['wood', 'fiber', 'metal', 'stone'] as const;
    const _have = (item: string): number => {
      if ((RES_KEYS as readonly string[]).includes(item)) return (res as any)[item] ?? 0;
      let total = 0;
      for (const sl of (player.inventory.slots ?? [])) {
        if (sl && (sl.item as string) === item) total += sl.quantity ?? 0;
      }
      return total;
    };
    return entry.cost.every(({ item, qty }) => _have(item) >= qty);
  }

  private _canAffordShipBuild(kind: GhostModuleKind): boolean {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    const playerId = this.networkManager.getAssignedPlayerId();
    const player = ws?.players.find(p => p.id === playerId);
    if (!player) return false;
    const entry = UIManager.BUILD_PANEL_ENTRIES.find(e => e.kind === kind);
    const cost = entry?.cost ?? { wood: 0, fiber: 0, metal: 0, stone: 0 };
    if (!cost.wood && !cost.fiber && !cost.metal && !cost.stone) return true;

    if (this._buildResourceSource === 'ship' && player.carrierId) {
      const ship = ws?.ships.find(s => s.id === player.carrierId);
      if (!ship) return false;
      const totals = { wood: 0, fiber: 0, metal: 0, stone: 0 };
      for (const m of ship.modules.filter(mod => mod.moduleData?.kind === 'chest')) {
        const d = m.moduleData as any;
        totals.wood  += d.wood  ?? 0; totals.fiber += d.fiber ?? 0;
        totals.metal += d.metal ?? 0; totals.stone += d.stone ?? 0;
      }
      return totals.wood >= cost.wood && totals.fiber >= cost.fiber
          && totals.metal >= cost.metal && totals.stone >= cost.stone;
    }
    // Pack / auto: check player resource pool
    const res = (player.inventory as any).resources as Record<string, number> | undefined;
    if (!res) return false;
    return (res['wood']  ?? 0) >= cost.wood  && (res['fiber'] ?? 0) >= cost.fiber
        && (res['metal'] ?? 0) >= cost.metal && (res['stone'] ?? 0) >= cost.stone;
  }

  private _consumeShipBuildResources(kind: GhostModuleKind): boolean {
    const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
    const playerId = this.networkManager.getAssignedPlayerId();
    const player = ws?.players.find(p => p.id === playerId);
    if (!player) return false;

    const entry = UIManager.BUILD_PANEL_ENTRIES.find(e => e.kind === kind);
    const cost = entry?.cost ?? { wood: 0, fiber: 0, metal: 0, stone: 0 };

    if (this._buildResourceSource === 'ship' && player.carrierId) {
      // ── Ship-chest source: aggregate resources across all chest modules ──
      const ship = ws?.ships.find(s => s.id === player.carrierId);
      if (!ship) return false;
      const chestMods = ship.modules.filter(m => m.moduleData?.kind === 'chest');
      const totals = { wood: 0, fiber: 0, metal: 0, stone: 0 };
      for (const m of chestMods) {
        const d = m.moduleData as any;
        totals.wood  += d.wood  ?? 0;
        totals.fiber += d.fiber ?? 0;
        totals.metal += d.metal ?? 0;
        totals.stone += d.stone ?? 0;
      }
      const needWood  = cost.wood  - totals.wood;
      const needFiber = cost.fiber - totals.fiber;
      const needMetal = cost.metal - totals.metal;
      const needStone = cost.stone - totals.stone;
      if (needWood > 0 || needFiber > 0 || needMetal > 0 || needStone > 0) {
        this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
        const need: string[] = [];
        if (needWood  > 0) need.push(`${needWood}×wood`);
        if (needFiber > 0) need.push(`${needFiber}×fiber`);
        if (needMetal > 0) need.push(`${needMetal}×metal`);
        if (needStone > 0) need.push(`${needStone}×stone`);
        console.log(`❌ [SHIP BUILD] Ship chest needs for ${kind}: ${need.join(', ')}`);
        return false;
      }
      // Optimistic client-side deduction from chest module data
      let remWood = cost.wood, remFiber = cost.fiber, remMetal = cost.metal, remStone = cost.stone;
      for (const m of chestMods) {
        const d = m.moduleData as any;
        const take = (n: number, have: number) => { const t = Math.min(n, have); return t; };
        const tw = take(remWood,  d.wood  ?? 0); d.wood  = (d.wood  ?? 0) - tw; remWood  -= tw;
        const tf = take(remFiber, d.fiber ?? 0); d.fiber = (d.fiber ?? 0) - tf; remFiber -= tf;
        const tm = take(remMetal, d.metal ?? 0); d.metal = (d.metal ?? 0) - tm; remMetal -= tm;
        const ts = take(remStone, d.stone ?? 0); d.stone = (d.stone ?? 0) - ts; remStone -= ts;
        if (!remWood && !remFiber && !remMetal && !remStone) break;
      }
      return true;
    }

    // ── Pack source (default): player's personal resource pool ──
    const res = (player.inventory as any).resources as Record<string, number> | undefined;
    if (!res) return false;

    const needWood  = cost.wood  - (res['wood']  ?? 0);
    const needFiber = cost.fiber - (res['fiber'] ?? 0);
    const needMetal = cost.metal - (res['metal'] ?? 0);
    const needStone = cost.stone - (res['stone'] ?? 0);

    if (needWood > 0 || needFiber > 0 || needMetal > 0 || needStone > 0) {
      this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
      const need: string[] = [];
      if (needWood  > 0) need.push(`${needWood}×wood`);
      if (needFiber > 0) need.push(`${needFiber}×fiber`);
      if (needMetal > 0) need.push(`${needMetal}×metal`);
      if (needStone > 0) need.push(`${needStone}×stone`);
      console.log(`❌ [SHIP BUILD] Pack needs for ${kind}: ${need.join(', ')}`);
      return false;
    }

    res['wood']  = Math.max(0, (res['wood']  ?? 0) - cost.wood);
    res['fiber'] = Math.max(0, (res['fiber'] ?? 0) - cost.fiber);
    res['metal'] = Math.max(0, (res['metal'] ?? 0) - cost.metal);
    res['stone'] = Math.max(0, (res['stone'] ?? 0) - cost.stone);
    return true;
  }

  /** Create a build plan ghost for a snap-based module kind. */
  private _addSnapGhost(
    kind: GhostModuleKind, shipId: number, lx: number, ly: number, rot: number,
    buildAction: () => void,
  ): void {
    const ghost: GhostPlacement = {
      id: `ghost-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      kind, shipId,
      localPos: { x: lx, y: ly },
      localRot: rot,
      resourceCost: STRUCTURE_COSTS[kind] ?? { wood: 0, fiber: 0, metal: 0, stone: 0 },
      buildAction,
    };
    this.ghostPlacements.push(ghost);
    this.syncBuildModeState();
    console.log(`📋 [PLAN] Created ${kind} plan on ship ${shipId}`);
  }

  /**
   * Build the network-send closure for a free-placement module.
   * Captures position/rotation/deckLevel at ghost creation time.
   */
  private _makeBuildAction(
    kind: GhostModuleKind, shipId: number, lx: number, ly: number, rot: number,
  ): () => void {
    const src = this._buildResourceSource;
    switch (kind) {
      case 'cannon': return () => this.networkManager.sendPlaceCannonAt(shipId, lx, ly, rot, undefined, this.renderSystem.playerDeckLevel, src,
        this.uiManager.playerMenu.getVariantForKind('cannon') ?? undefined);
      case 'mast':   return () => this.networkManager.sendPlaceMastAt(shipId, lx, ly, src,
        this.uiManager.playerMenu.getVariantForKind('mast') ?? undefined);
      case 'swivel': return () => this.networkManager.sendPlaceSwivelAt(shipId, lx, ly, rot, this.renderSystem.playerDeckLevel, src,
        this.uiManager.playerMenu.getVariantForKind('swivel') ?? undefined);
      case 'chest':  return () => this.networkManager.sendPlaceChestAt(shipId, lx, ly, rot, this.renderSystem.playerDeckLevel, src);
      case 'bed':    return () => this.networkManager.sendPlaceBedAt(shipId, lx, ly, rot, this.renderSystem.playerDeckLevel, src);
      default:       return () => {};
    }
  }

  /**
   * Return the nearest ghost plan within 120 ship-local units of the player,
   * or null if none is close enough.
   */
  private _getNearbyGhostPlan(player: { carrierId: number; localPosition?: { x: number; y: number } | null }): GhostPlacement | null {
    if (!player.carrierId) return null;
    for (const g of this.ghostPlacements) {
      if (g.shipId !== player.carrierId) continue;
      if (player.localPosition) {
        const dist = Math.hypot(player.localPosition.x - g.localPos.x, player.localPosition.y - g.localPos.y);
        if (dist < 120) return g;
      } else {
        // No localPosition — player is on the ship, accept any ghost on it
        return g;
      }
    }
    return null;
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

  /** Remove the land ghost closest to worldPos (within 75 world px). */
  private removeNearestLandGhost(worldPos: Vec2): void {
    let nearestId: string | null = null;
    let nearestDist = Infinity;
    for (const g of this.landGhostEntries) {
      const dx = worldPos.x - g.worldPos.x;
      const dy = worldPos.y - g.worldPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) { nearestDist = dist; nearestId = g.id; }
    }
    if (nearestId && nearestDist < 75) {
      this.landGhostEntries = this.landGhostEntries.filter(g => g.id !== nearestId);
      this.renderSystem.setLandGhostPlacements(this.landGhostEntries);
      this.uiManager.setLandGhostCounts(this._computeLandGhostCounts());
      console.log(`🏗️ [LAND PLAN] Removed land ghost`);
    }
  }

  /** Send all planned land ghosts to server (staggered), then clear the list. */
  private confirmAllLandGhosts(): void {
    const ghosts = [...this.landGhostEntries];
    this.landGhostEntries = [];
    this.renderSystem.setLandGhostPlacements([]);
    this.uiManager.setLandGhostCounts(new Map());
    ghosts.forEach((g, i) => setTimeout(() => g.buildAction(), i * 50));
    console.log(`🏗️ [LAND PLAN] Confirmed ${ghosts.length} planned structure(s)`);
  }

  /** Return a Map<kind, count> of pending land ghost entries per structure type. */
  private _computeLandGhostCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const g of this.landGhostEntries) {
      counts.set(g.kind, (counts.get(g.kind) ?? 0) + 1);
    }
    return counts;
  }


  /**
   * Previously: clicked near ghost with matching hotbar item → build immediately.
   * Now: ghost plans are completed via E-key + resource check (_getNearbyGhostPlan).
   * This stub remains so the onBuildPlace call-site compiles; it always returns false.
   */
  private tryPlaceAtGhost(_worldPos: Vec2): boolean {
    return false;
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
    const _placeDeck = this.renderSystem.playerDeckLevel;
    for (const mod of nearestShip.modules) {
      if (mod.kind === 'plank' || mod.kind === 'deck') continue;
      if (newKind === 'cannon' && mod.kind === 'gunport') continue; // cannons coexist with gunports
      if (mod.deckId !== 255 && mod.deckId !== _placeDeck) continue; // different deck — no collision
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
      newCannon.deckId = this.renderSystem.playerDeckLevel;
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === shipRef.id);
        if (s) s.modules.push(newCannon);
      }
      // Also overlay onto interpolated / any worldToRender source
      const pending = this.localPendingModules.get(shipRef.id) ?? [];
      pending.push({ module: newCannon, expiry: Date.now() + 5000 });
      this.localPendingModules.set(shipRef.id, pending);
      this.networkManager.sendPlaceCannonAt(shipRef.id, localX, localY, rotationRad, undefined, this.renderSystem.playerDeckLevel,
        undefined, this.uiManager.playerMenu.getVariantForKind('cannon') ?? undefined);
    } else if (this.buildSelectedItem === 'swivel') {
      console.log(`🔫 [BUILD] Placing swivel at local (${localX.toFixed(0)}, ${localY.toFixed(0)}) rot=${this.buildRotationDeg}° on ship ${shipRef.id}`);
      const newSwivel = ModuleUtils.createDefaultModule(tempId, 'swivel', Vec2.from(localX, localY));
      newSwivel.localRot = rotationRad;
      newSwivel.deckId = this.renderSystem.playerDeckLevel;
      for (const state of [this.authoritativeWorldState, this.predictedWorldState, this.demoWorldState]) {
        const s = state?.ships.find(sh => sh.id === shipRef.id);
        if (s) s.modules.push(newSwivel);
      }
      const pending = this.localPendingModules.get(shipRef.id) ?? [];
      pending.push({ module: newSwivel, expiry: Date.now() + 5000 });
      this.localPendingModules.set(shipRef.id, pending);
      this.networkManager.sendPlaceSwivelAt(shipRef.id, localX, localY, rotationRad, this.renderSystem.playerDeckLevel,
        undefined, this.uiManager.playerMenu.getVariantForKind('swivel') ?? undefined);
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
      this.networkManager.sendPlaceMastAt(shipRef.id, localX, localY,
        undefined, this.uiManager.playerMenu.getVariantForKind('mast') ?? undefined);
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

    // Mouse-click handling when the radial menu is open:
    //   Left-click  → snapshot the hovered option; executed when E is released.
    //   Right-click → cancel the interaction immediately.
    // All other game mouse logic is suppressed by onBeforeMouseInput while the radial is open.
    this.canvas.addEventListener('mousedown', (event) => {
      if (this._radialMenu.isOpen && (event.button === 0 || event.button === 2)) {
        // ── Weapon Group sub-menu: read selection before closing ─────────────
        if (this._weaponGroupSubMenuCannonId !== null) {
          const _wgSelected = this._radialMenu.getHoveredId();
          this._radialMenu.close();
          const _wgCannonId = this._weaponGroupSubMenuCannonId;
          this._weaponGroupSubMenuCannonId = null;
          if (_wgSelected && _wgSelected.startsWith('wg_toggle_')) {
            const _wgGroup = parseInt(_wgSelected.replace('wg_toggle_', ''), 10);
            if (!isNaN(_wgGroup)) {
              const _wgState = this.controlGroups.get(_wgGroup);
              if (_wgState) {
                if (_wgState.cannonIds.includes(_wgCannonId)) {
                  _wgState.cannonIds = _wgState.cannonIds.filter(id => id !== _wgCannonId);
                  console.log(`❌ Cannon ${_wgCannonId} removed from group G${_wgGroup}`);
                } else {
                  // Remove from any other group first (cannon belongs to at most one group)
                  for (const [_gi, _s] of this.controlGroups) {
                    if (_s.cannonIds.includes(_wgCannonId)) {
                      _s.cannonIds = _s.cannonIds.filter(id => id !== _wgCannonId);
                      this.networkManager.sendCannonGroupConfig(_gi, _s.mode, _s.cannonIds, _s.targetId > 0 ? _s.targetId : 0);
                    }
                  }
                  _wgState.cannonIds.push(_wgCannonId);
                  console.log(`🎯 Cannon ${_wgCannonId} → group G${_wgGroup}`);
                }
                this.networkManager.sendCannonGroupConfig(_wgGroup, _wgState.mode, _wgState.cannonIds, _wgState.targetId > 0 ? _wgState.targetId : 0);
                this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
              }
            }
          }
          if (this._ladderHoldTimer !== null) {
            clearTimeout(this._ladderHoldTimer);
            this._ladderHoldTimer = null;
            this.renderSystem.stopLadderHoldRing();
          }
          return;
        }

        if (event.button === 2) {
          // Right-click: cancel — close radial and flash cancel on next E release
          this._radialMenu.close();
          this._radialClickSelected = null;
          this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
        } else {
          const _hovId = this._radialMenu.getHoveredId();
          // Special case: 'weapon_group' opens its sub-menu immediately rather than
          // waiting for E release, since the user has already clicked to confirm.
          if (_hovId === 'weapon_group' && this._ladderHoldModuleId !== null) {
            const _wgModuleId = this._ladderHoldModuleId;
            this._radialMenu.close();
            this._interactKind = null; // E keyup should be a no-op after this
            this._weaponGroupSubMenuCannonId = _wgModuleId;
            const _wgMp = this.inputManager.getMouseScreenPosition();
            const _wgOpts: RadialOption[] = [];
            for (let _g = 0; _g < 10; _g++) {
              const _gs = this.controlGroups.get(_g);
              if (!_gs) continue;
              const _inGrp = _gs.cannonIds.includes(_wgModuleId);
              _wgOpts.push({ id: `wg_toggle_${_g}`, label: _inGrp ? `✖ G${_g} Remove` : `+ G${_g} Add`, highlighted: _inGrp });
            }
            this._radialMenu.open(_wgMp.x, _wgMp.y, _wgOpts);
          } else {
            // Left-click: snapshot the hovered selection; E keyup will execute it
            this._radialClickSelected = _hovId;
            this._radialMenu.close();
          }
        }

        // Cancel the hold timer too if still counting down
        if (this._ladderHoldTimer !== null) {
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
        }
      }
    });

    // Land chest menu: slider drag starts on mousedown
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const my = (e.clientY - rect.top)  * (this.canvas.height / rect.height);
      this.landChestMenu.handleMouseDown(mx, my);
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

      // Confirm dialog intercepts all keys while open
      if (this.confirmDialog.handleKey(e)) return;

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
          if (this.chestMenu.visible) {
            this.chestMenu.close();
            this.uiManager.setActiveMenuId(null);
            e.preventDefault();
            break;
          }
          if (this.landChestMenu.visible) {
            this.landChestMenu.close();
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
          // Open command console — allowed from any state including build mode
          if (!this.uiManager.isAnyMenuOpen()) {
            this.commandConsole.open();
            e.preventDefault();
          }
          break;
        }

        case 't':
        case 'T': {
          // In deck build mode: cycle between lower/upper deck snap point
          if (this.renderSystem.isInDeckBuildMode()) {
            this.renderSystem.cycleDeckLevel();
            e.preventDefault();
          }
          // In wall/door-frame placement: cycle between wall and door frame
          if (this.renderSystem.isIslandBuildGhostActive()) {
            const _ws2 = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
            const _p2 = _ws2?.players.find(p => p.id === this.networkManager.getAssignedPlayerId());
            const _slot2 = _p2?.inventory?.activeSlot ?? 0;
            const _hotbarItem = _p2?.inventory?.slots[_slot2]?.item ?? 'none';
            const _activeBase = this.buildSchematicKind ?? this.pendingLandBuildKind ?? _hotbarItem;
            if (_activeBase === 'wall' || _activeBase === 'door_frame') {
              this.toggleWallVariant();
              e.preventDefault();
            }
          }
          break;
        }
        case 'Enter': {
          // Open chat input
          if (!this.uiManager.isAnyMenuOpen()
            && !this.commandConsole.visible
            && !this.chatBox.isOpen) {
            this.chatBox.open();
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
          // Block all interactions while in any build mode
          if (this.buildMenuOpen || this.explicitBuildMode || this.landBuildMenuOpen) break;
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
                // Raw materials come from the resource pool, not inventory slots
                const res = (meE as any).inventory?.resources;
                if (item === 'wood'  && res) return res.wood  ?? 0;
                if (item === 'fiber' && res) return res.fiber ?? 0;
                if (item === 'metal' && res) return res.metal ?? 0;
                if (item === 'stone' && res) return res.stone ?? 0;
                // Crafted items (e.g. plank) are in slots
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
              } else if (struct.type === 'chest') {
                // Chest: tap E = open; hold E = radial with Open + Demolish
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  const chestOpts: RadialOption[] = [{ id: 'use', label: '📦 Open Chest' }];
                  if (isOwnCompany) chestOpts.push({ id: 'demolish', label: 'Demolish Chest' });
                  if (isOwnCompany) { const r = _buildRepairOption(struct); if (r) chestOpts.push(r); }
                  this._radialMenu.open(mp2.x, mp2.y, chestOpts);
                }, 400);
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
                      : struct.type === 'chest'       ? 'Demolish Chest'
                      : struct.type === 'claim_flag'  ? 'Remove Claim Flag'
                      : struct.type === 'flag_fort'   ? 'Demolish Flag Fort'
                      : struct.type === 'company_fortress' ? 'Demolish Fortress'
                      : struct.type === 'cannon'      ? 'Demolish Cannon'
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
                // Weapon Group assignment shortcut
                radialOpts.push({ id: 'weapon_group', label: '🎯 Weapon Group' });
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

          // Chest: tap E to open inventory panel; hold E for radial with Open/Demolish
          if (hov.module.kind === 'chest' && meE.carrierId === hov.ship.id) {
            this._interactKind = 'module';
            this._suppressLadderInteract = true;
            this._ladderHoldModuleId = hov.module.id;
            this._ladderHoldShipId = hov.ship.id;
            this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
            const chestData = hov.module.moduleData?.kind === 'chest'
              ? (hov.module.moduleData as import('../sim/modules.js').ChestModuleData)
              : null;
            this._ladderHoldTimer = setTimeout(() => {
              this._ladderHoldTimer = null;
              this.renderSystem.stopLadderHoldRing();
              const mp = this.inputManager.getMouseScreenPosition();
              this._radialMenu.open(mp.x, mp.y, [
                { id: 'open_chest', label: '📦 Open Chest' },
                { id: 'demolish',   label: '🪓 Demolish Chest' },
              ]);
            }, 300);
            // Tap (fast release < 300 ms) handled in keyup → opens chest immediately
            (this as any)._pendingChestOpen = {
              moduleId: hov.module.id,
              shipId:   hov.ship.id,
              data:     chestData,
            };
            break;
          }

          // Gunport: tap E to toggle open/close; hold E for radial with Demolish
          if (hov.module.kind === 'gunport' && meE.carrierId === hov.ship.id) {            this._interactKind = 'module';
            this._suppressLadderInteract = true;
            this._ladderHoldModuleId = hov.module.id;
            this._ladderHoldShipId = hov.ship.id;
            this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
            this._ladderHoldTimer = setTimeout(() => {
              this._ladderHoldTimer = null;
              this.renderSystem.stopLadderHoldRing();
              const mp = this.inputManager.getMouseScreenPosition();
              const gOpen = hov.module.moduleData?.kind === 'gunport' && (hov.module.moduleData as any).isOpen;
              this._radialMenu.open(mp.x, mp.y, [
                { id: gOpen ? 'close_gunport' : 'open_gunport', label: gOpen ? 'Close Port' : 'Open Port' },
                { id: 'demolish', label: '🪓 Demolish Gunport' },
              ]);
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

      // Helper to resolve the radial selection from either the still-open radial (E-hold
      // release) or a prior left-click snapshot (_radialClickSelected set in mousedown).
      const _hasRadialPending = () => this._radialMenu.isOpen || this._radialClickSelected !== null;
      const _resolveRadialSelected = (): string | null => {
        if (this._radialMenu.isOpen) return this._radialMenu.getHoveredId();
        const s = this._radialClickSelected;
        this._radialClickSelected = null;
        return s;
      };

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
          } else if (structType === 'chest') {
            // Tap E on chest = open land chest
            doUse();
          }
          // Tap E on floor/wall/door_frame = nothing (user must hold to demolish)
        } else if (_hasRadialPending()) {
          const selected = _resolveRadialSelected();
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
        } else if (_hasRadialPending()) {
          // Hold released (or left-click) with radial pending — execute selected option or cancel
          const selected = _resolveRadialSelected();
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
        } else if (_hasRadialPending()) {
          // Hold (or left-click) — execute selected option or cancel if null/dead-zone
          const selected = _resolveRadialSelected();
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
          } else if (selected === 'weapon_group' && moduleId !== null) {
            // Open weapon group sub-menu — closed by mousedown, processed there
            this._weaponGroupSubMenuCannonId = moduleId;
            const _wgMp = this.inputManager.getMouseScreenPosition();
            const _wgOpts: RadialOption[] = [];
            for (let _g = 0; _g < 10; _g++) {
              const _gs = this.controlGroups.get(_g);
              if (!_gs) continue;
              const _inGrp = _gs.cannonIds.includes(moduleId);
              _wgOpts.push({ id: `wg_toggle_${_g}`, label: _inGrp ? `✖ G${_g} Remove` : `+ G${_g} Add`, highlighted: _inGrp });
            }
            this._radialMenu.open(_wgMp.x, _wgMp.y, _wgOpts);
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
        // Check if module is a gunport (handled differently — tap = toggle, hold = radial)
        const wsGp = this.authoritativeWorldState || this.predictedWorldState;
        const gpShip = wsGp?.ships.find(s => s.id === shipId);
        const gpMod = gpShip?.modules.find(m => m.id === moduleId);
        const isGunportModule = gpMod?.kind === 'gunport';
        const isChestModule   = gpMod?.kind === 'chest';

        // ── Chest: tap E to open inventory panel ─────────────────────────────
        if (isChestModule && moduleId !== null && shipId !== null) {
          const pending = (this as any)._pendingChestOpen as { moduleId: number; shipId: number; data: any } | null;
          (this as any)._pendingChestOpen = null;

          if (this._ladderHoldTimer !== null) {
            clearTimeout(this._ladderHoldTimer);
            this._ladderHoldTimer = null;
            this.renderSystem.stopLadderHoldRing();
            // Tap: open chest
            if (!isInRange()) {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            } else {
              const chestD = pending?.data ?? gpMod?.moduleData ?? null;
              this.chestMenu.open(moduleId, shipId, chestD as import('../sim/modules.js').ChestModuleData | null);
              this.uiManager.setActiveMenuId(MENU_ID.CHEST);
              this.chestMenu.onTransfer = (evt) => {
                this.networkManager.sendChestTransfer(evt.shipId, evt.moduleId, evt.item, evt.quantity, evt.direction);
              };
              this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
              console.log(`📦 [CHEST] Opened chest ${moduleId} on ship ${shipId}`);
            }
          } else if (_hasRadialPending()) {
            const selected = _resolveRadialSelected();
            this._radialMenu.close();
            if (selected === 'open_chest') {
              if (!isInRange()) {
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
              } else {
                const chestD = pending?.data ?? gpMod?.moduleData ?? null;
                this.chestMenu.open(moduleId, shipId, chestD as import('../sim/modules.js').ChestModuleData | null);
                this.uiManager.setActiveMenuId(MENU_ID.CHEST);
                this.chestMenu.onTransfer = (evt) => {
                  this.networkManager.sendChestTransfer(evt.shipId, evt.moduleId, evt.item, evt.quantity, evt.direction);
                };
                this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
              }
            } else if (selected === 'demolish' && moduleId !== null && shipId !== null) {
              if (!isInRange()) {
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
              } else {
                this.networkManager.sendDemolishModule(shipId, moduleId);
                this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
                console.log(`🪓 [DEMOLISH] chest ${moduleId} on ship ${shipId}`);
              }
            } else {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            }
          }
          return;
        }

        if (this._ladderHoldTimer !== null) {
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
          if (isGunportModule && moduleId !== null && shipId !== null) {
            // Tap on gunport: toggle it immediately
            if (!isInRange()) {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            } else {
              this.networkManager.sendToggleGunport(shipId, moduleId);
              this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
              console.log(`🔳 [GUNPORT] Toggle gunport ${moduleId} on ship ${shipId}`);
            }
          } else {
            // Tap: no default action — require hold to confirm demolish
            this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
          }
        } else if (_hasRadialPending()) {
          const selected = _resolveRadialSelected();
          this._radialMenu.close();
          if ((selected === 'open_gunport' || selected === 'close_gunport') && moduleId !== null && shipId !== null) {
            if (!isInRange()) {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            } else {
              this.networkManager.sendToggleGunport(shipId, moduleId);
              this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
              console.log(`🔳 [GUNPORT] Toggle gunport ${moduleId} on ship ${shipId}`);
            }
          } else if (selected === 'demolish' && moduleId !== null && shipId !== null) {
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
      } else if (_hasRadialPending()) {
        // Radial was open (or left-click snapshot) — execute selected option or cancel
        const selected = _resolveRadialSelected();
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
        // Two-deck setup: lower deck (deck_id=0) and upper deck (deck_id=1)
        ModuleUtils.createShipDeckFromPolygon(hull, BRIGANTINE_LOWER_DECK_MODULE_ID, 0),
        ModuleUtils.createShipDeckFromPolygon(hull, BRIGANTINE_UPPER_DECK_MODULE_ID, 1),

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
          deckId: 0, // lower deck (deck_index 0)
          onDeck: true,
          isMounted: false,
          companyId: 0,
          health: 100,
          maxHealth: 100,
          onIslandId: 0,
          onDockId: 0,
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