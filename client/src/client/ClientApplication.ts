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
import { RadialMenu } from './ui/RadialMenu.js';

// Audio System
import { AudioManager } from './audio/AudioManager.js';

// Core Simulation Types
import { WorldState, Ship, InputFrame, WeaponGroupState, WeaponGroupMode } from '../sim/Types.js';
import { GhostPlacement, GhostModuleKind } from '../sim/Types.js';
import { createEmptyInventory } from '../sim/Inventory.js';
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
  private previousMountState = false;    // Track previous mount state to detect changes
  private previousCarrierId: number | null = null; // Track ship changes for boarding sync
  // Optimistic hotbar slot — held until server confirms the same value so that
  // rapid movement messages (W held) don't let stale world-states flicker the UI back.
  private pendingActiveSlot: number | null = null;
  // Optimistic mount state — held from module_interact_success until the server's
  // world-state echo confirms isMounted=true for the same module.
  private pendingMount: { moduleId: number; moduleKind: string; mountOffset?: Vec2 } | null = null;

  // Camera zoom animation
  private targetZoom  = 1.0;  // Zoom level we're animating toward
  private preHelmZoom = 1.0;  // Zoom before helm mount, restored on dismount
  private static readonly HELM_ZOOM    = 0.60; // Zoomed-out level while at the helm
  private static readonly DEFAULT_ZOOM = 1.00; // Normal gameplay zoom

  // Explicit build mode (B key) — independent of hotbar item build modes
  private explicitBuildMode = false;
  private buildSelectedItem: 'cannon' | 'sail' = 'cannon';
  private buildRotationDeg = 0;

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
  private readonly SWORD_COOLDOWN_MS = 600;
  /** E-hold interaction state — covers ladders and mountable modules. */
  private _ladderHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private _suppressLadderInteract = false;
  private _ladderHoldModuleId: number | null = null;
  private _ladderHoldIsExtended = false;
  /** True if player was on the ladder's ship when E was pressed. */
  private _ladderHoldOnShip = false;
  /** What kind of module the current E-hold targets: 'ladder' | 'mount' | null */
  private _interactKind: 'ladder' | 'mount' | null = null;
  /** True when the E-hold was started while the player was already mounted (dismount path). */
  private _ladderHoldWasMounted = false;
  /** Generic radial action menu instance (rendered by RenderSystem). */
  private _radialMenu = new RadialMenu();
  private accumulator = 0;
  private readonly clientTickDuration: number; // milliseconds per client tick
  
  // Performance Tracking
  private frameCount = 0;
  private fpsTimer = 0;
  private currentFPS = 0;
  private lastRenderLogTime = 0;
  /** Timestamp (ms) of the last sword swing, for cursor cooldown ring. */
  private swordLastAttackMs = 0;
  
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
      this.renderSystem.setRadialMenu(this._radialMenu);
      
      // Initialize Network System
      this.networkManager = new NetworkManager(this.config.network);
      this.networkManager.setWorldStateHandler(this.onServerWorldState.bind(this));
      this.networkManager.setConnectionStateHandler(this.onConnectionStateChanged.bind(this));
      
      // Module mounting callbacks
      this.networkManager.onModuleMountSuccess = (moduleId, moduleKind, mountOffset) => {
        this.handleModuleMountSuccess(moduleId, moduleKind, mountOffset);
      };
      this.networkManager.onModuleMountFailure = (reason) => {
        this.handleModuleMountFailure(reason);
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
          this.renderSystem.spawnDamageNumber(Vec2.from(worldX, worldY), damage || 3000, true);
          // Mast destroyed: big sail-shred burst
          const ws2 = this.authoritativeWorldState || this.predictedWorldState;
          const hitShip = ws2?.ships.find(s => s.id === shipId);
          const hitMod  = hitShip?.modules.find(m => m.id === moduleId);
          if (hitMod?.kind === 'mast') {
            this.renderSystem.spawnSailFiberEffect(Vec2.from(worldX, worldY), 2.0);
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
        // Non-fatal hit — spawn damage number but keep the module alive
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
          this.renderSystem.spawnDamageNumber(Vec2.from(worldX, worldY), damage, false);
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
          const FACTION: Record<number, string> = { 0: 'Neutral', 1: 'Pirates', 2: 'Navy' };
          const shipLabel = (s: Ship) => FACTION[s.companyId] ?? `Ship #${s.id}`;
          const sinkLabel  = shipLabel(sinkingShip);
          const isOwnShip  = myPlayer?.carrierId === shipId;
          if (isOwnShip) {
            const attackerId = this.renderSystem.getLastAttackerOf(shipId);
            const attacker   = attackerId !== null ? ws?.ships.find(s => s.id === attackerId) : null;
            const msg = attacker
              ? `Your ${sinkLabel} was sunk by ${shipLabel(attacker)}`
              : `Your s${sinkLabel} was sunk!`;
            this.renderSystem.showAnnouncement(msg, 'ship_sink', 4.0);
          } else {
            const myShip  = myPlayer?.carrierId ? ws?.ships.find(s => s.id === myPlayer!.carrierId) : null;
            const myLabel = myShip ? shipLabel(myShip) : 'Our ship';
            this.renderSystem.showAnnouncement(`Your ${myLabel} sunk ${sinkLabel}`, 'ship_sink', 4.0);
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

      // When the server confirms a ladder board, record the ship ID so that the
      // cannon_group_state that follows can be accepted before the world-state tick
      // updates the player's carrierId.
      this.networkManager.onPlayerBoarded = (shipId) => {
        this.pendingGroupShipId = shipId;
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
                    return md && md.health < (md.maxHealth ?? 0);
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
            const shipId   = player.carrierId;
            const moduleId = hoveredForHammer.module.id;
            // Don't start the minigame if the module is already at full health
            const md = hoveredForHammer.module.moduleData as any;
            const poleFullHealth  = !md || md.health >= (md.maxHealth ?? 0);
            const fiberFullHealth = hoveredForHammer.module.kind !== 'mast'
              || (md?.fiberHealth ?? 0) >= (md?.fiberMaxHealth ?? 0);
            if (poleFullHealth && fiberFullHealth) {
              console.log('🔨 [HAMMER] Module is already at full health');
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
            this.swordLastAttackMs = now;
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
          // Not a hammer or sword click — pass to server
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

          // Repair mode: active slot = repair_kit → repair most damaged plank on ship
          if (activeItem === 'repair_kit' && player && player.carrierId !== 0) {
            console.log(`🔧 [REPAIR] Sending repair_plank for ship ${player.carrierId}`);
            this.networkManager.sendRepairPlank(player.carrierId);
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
              if (hoveredModule.module.kind === 'ladder') {
                if (this._suppressLadderInteract) return;
                const onShip = player.carrierId === hoveredModule.ship.id;
                const isExtended = (hoveredModule.module.moduleData as any)?.extended !== false;
                console.log(`🪜 hover: ladder ${hoveredModule.module.id} onShip=${onShip} extended=${isExtended}`);
                if (onShip) {
                  this.networkManager.sendModuleInteract(hoveredModule.module.id);
                } else if (isExtended) {
                  this.networkManager.sendModuleInteract(hoveredModule.module.id);
                } else {
                  this.networkManager.sendToggleLadder(hoveredModule.module.id);
                }
                return;
              }
              // Non-ladder modules (helm, cannon, mast): handled by E keydown → keyup path.
              // The keydown handler sets _suppressLadderInteract=true when a mountable is found,
              // so this code is only reached if keydown found nothing OR player is using a gamepad.
              // In either case, skip the game-loop path to avoid firing sendModuleInteract every tick.
            }
          }

          // E key: open crew level menu if hovering an NPC (fallback when no module interacted)
          const hovNpc = this.renderSystem.getHoveredNpc();
          if (hovNpc) {
            this.uiManager?.openCrewMenuForNpc(hovNpc);
            return;
          }

          if (!hoveredModule && !this._suppressLadderInteract) {
            // Proximity fallback: scan for nearest ladder without requiring mouse hover
            const wsL = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
            if (wsL && player) {
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
      };
      this.inputManager.onShipRudderControl = (turningLeft, turningRight) => {
        this.networkManager.sendShipRudderControl(turningLeft, turningRight);
      };
      this.inputManager.onShipSailAngleControl = (desiredAngle) => {
        this.networkManager.sendShipSailAngleControl(desiredAngle);
      };
      
      // Cannon control callbacks
      this.inputManager.onCannonAim = (aimAngle, activeGroups) => {
        this.networkManager.sendCannonAim(aimAngle, activeGroups);
      };
      this.inputManager.onCannonFire = (cannonIds, fireAll, ammoType, weaponGroup, weaponGroups) => {
        // Multi-group fire: fire all cannons in every selected group
        const groups = weaponGroups && weaponGroups.size > 0 ? weaponGroups : (weaponGroup !== undefined && weaponGroup >= 0 ? new Set([weaponGroup]) : null);
        if (groups && !fireAll) {
          const allIds: number[] = [];
          let skipAimCheck = false;
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
        this.networkManager.sendForceReload();
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
          if (activeItem === 'cannon' || activeItem === 'sail') {
            this.explicitBuildMode = true;
            this.buildSelectedItem = activeItem as 'cannon' | 'sail';
          }
          console.log(`🏗️ [BUILD MENU] OPENED${this.explicitBuildMode ? ` (free-place: ${this.buildSelectedItem})` : ' (plan mode)'}`);
        }
        this.syncBuildModeState();
      };

      // Build rotation (R key in explicit build mode or ghost placement)
      this.inputManager.onBuildRotate = (deltaDeg: number) => {
        this.buildRotationDeg = (this.buildRotationDeg + deltaDeg + 360) % 360;
        this.syncBuildModeState();
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
      
      // Set up scroll-wheel zoom (also update targetZoom so animation doesn't fight the user)
      this.inputManager.onZoom = (factor, _screenPoint) => {
        this.targetZoom = Math.max(0.1, Math.min(10.0, this.targetZoom * factor));
        this.camera.setZoom(this.targetZoom);
      };

      // Let UI panels (e.g. manning priority panel) consume clicks before game logic
      this.inputManager.onUIClick = (x, y) => {
        if (this.uiManager?.handleClick(x, y)) return true;
        return false;
      };

      // Ctrl+left-click: assign/remove cannon from the active weapon group
      this.inputManager.onGroupAssign = () => {
        const hovered = this.renderSystem.getHoveredModule();
        if (!hovered) {
          console.warn(`⚠️ GroupAssign: no module hovered`);
          return;
        }
        if (hovered.module.kind !== 'cannon') {
          console.warn(`⚠️ GroupAssign: hovered module is '${hovered.module.kind}', not a cannon`);
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
        if (!hovered || hovered.module.kind !== 'cannon') return;
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
      
      // Initialize UI System
      this.uiManager = new UIManager(this.canvas, this.config);

      // Wire crew assignment changes from the manning panel to the server
      this.uiManager.setCrewAssignmentCallback((shipId, assignments) => {
        this.networkManager.sendCrewAssign(shipId, assignments);
      });

      // Wire ship attribute upgrade requests from the ship status menu to the server
      this.uiManager.setShipUpgradeCallback((shipId, attribute) => {
        this.networkManager.sendUpgradeShipAttribute(shipId, attribute);
      });

      // Wire NPC stat upgrade requests from the crew level menu to the server
      this.uiManager.setCrewUpgradeCallback((npcId, stat) => {
        this.networkManager.sendCrewUpgrade(npcId, stat);
      });

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

      // Handle ENTITY_HIT: update NPC/player health and show floating damage number
      this.networkManager.onEntityHit = (entityType, id, x, y, damage, health, maxHealth, killed) => {
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
        this.renderSystem.spawnDamageNumber(Vec2.from(x, y), damage, killed);
        this.renderSystem.notifyEntityDamaged(id, entityType === 'npc');
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

      // Handle SWORD_SWING: show arc for other players' sword attacks
      this.networkManager.onSwordSwing = (playerId, x, y, angle, _range) => {
        const myId = this.networkManager.getAssignedPlayerId();
        // Skip own swing — already shown optimistically in onActionEvent
        if (playerId === myId) return;
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

    // Re-derive the mouse world position from the current (unchanged) screen position every
    // frame so player movement toward the mouse keeps working even when the camera pans
    // (i.e. the mouse hasn't physically moved but the world under it has shifted).
    const mouseScreen = this.inputManager.getMouseScreenPosition();
    const mouseWorld  = this.camera.screenToWorld(mouseScreen);
    this.inputManager.updateMouseWorldPosition(mouseWorld);
    this.renderSystem.updateMousePosition(mouseWorld);

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
          this.renderSystem.playerInteractInfo = {
            worldPos: player.position,
            localPos: player.localPosition ?? null,
            carrierId: player.carrierId ?? null,
          };
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
        
        // Clone interpolated state and replace our player with predicted version (including rotation)
        worldToRender = {
          ...interpolatedState,
          players: interpolatedState.players.map(p => 
            p.id === assignedPlayerId ? { ...predictedPlayer, rotation: currentRotation } : p
          )
        };
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
        // Don't add duplicates — skip if server already sent a module at same spot
        const newMods = entries
          .map(e => e.module)
          .filter(pm => !ship.modules.some(m =>
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
      this.renderSystem.localPlayerId = this.networkManager.getAssignedPlayerId();
      this.renderSystem.playerAimAngleRelative = this.inputManager?.cannonAimAngleRelative ?? 0;
      this.renderSystem.selectedAmmoType = this.inputManager?.getLoadedAmmoType() ?? 0;
      this.renderSystem.npcTaskMap = this.uiManager.getNpcTaskMap();
      this.renderSystem.controlGroups = this.controlGroups as Map<number, { cannonIds: number[]; mode: string }>;
      this.renderSystem.showGroupOverlay = this.inputManager?.isCtrlHeld() ?? false;
      this.renderSystem.activeWeaponGroups = this.inputManager?.activeWeaponGroups ?? new Set();

      // Sword cooldown ring: only visible when sword is the active item and player is unmounted
      const _localPlayer = worldToRender.players.find(p => p.id === this.networkManager.getAssignedPlayerId());
      const _activeSlot  = _localPlayer?.inventory?.activeSlot ?? 0;
      this.renderSystem.swordEquipped =
        (_localPlayer?.inventory?.slots[_activeSlot]?.item === 'sword') &&
        !(_localPlayer?.isMounted ?? false);
      if (this.explicitBuildMode) this.syncBuildModeState();

      // Render game world with hybrid state
      this.renderSystem.renderWorld(worldToRender, this.camera, alpha);

      // Update sword cooldown cursor ring
      if (this.inputManager) {
        const mp = this.inputManager.getMouseScreenPosition();
        this.uiManager.setMousePos(mp.x, mp.y);

        // Pass sword cooldown state so RenderSystem can draw the cursor ring
        const assignedId = this.networkManager.getAssignedPlayerId();
        const pl = assignedId !== null ? worldToRender.players.find(p => p.id === assignedId) : null;
        const activeSlot2 = pl?.inventory?.activeSlot ?? 0;
        const activeItem2 = pl?.inventory?.slots[activeSlot2]?.item ?? 'none';
        if (activeItem2 === 'sword') {
          this.renderSystem.updateSwordCooldownCursor(mp, this.swordLastAttackMs, this.SWORD_COOLDOWN_MS);
        } else {
          this.renderSystem.updateSwordCooldownCursor(null, 0, this.SWORD_COOLDOWN_MS);
        }
      }

      // Render UI overlay
      const assignedPlayerId = this.networkManager.getAssignedPlayerId();
      const playerShipId = assignedPlayerId !== null
        ? (worldToRender.players.find(p => p.id === assignedPlayerId)?.carrierId ?? 0)
        : 0;
      const playerShip = playerShipId
        ? (worldToRender.ships.find(s => s.id === playerShipId) ?? null)
        : null;
      this.uiManager.render(this.renderSystem.getContext(), {
        worldState: worldToRender,
        camera: this.camera,
        fps: this.currentFPS,
        networkStats: this.networkManager.getStats(),
        config: this.config,
        assignedPlayerId,
        playerShipId,
        selectedAmmoType: this.inputManager?.getLoadedAmmoType() ?? 0,
        pendingAmmoType: this.inputManager?.selectedAmmoType ?? 0,
        mountKind: this.inputManager?.getMountKind() ?? 'none',
        activeWeaponGroup: this.inputManager?.activeWeaponGroup ?? -1,
        activeWeaponGroups: this.inputManager?.activeWeaponGroups,
        playerShip,
        controlGroups: this.controlGroups,
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

    // Smooth zoom toward targetZoom (ease-out, ~0.6 s to settle)
    const currentZoom = this.camera.getState().zoom;
    if (Math.abs(currentZoom - this.targetZoom) > 0.001) {
      const zoomLerp = 1.0 - Math.pow(0.01, dt);
      this.camera.setZoom(currentZoom + (this.targetZoom - currentZoom) * zoomLerp);
    }
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
        if (p.isMounted && p.mountedModuleId === this.pendingMount.moduleId) {
          this.pendingMount = null; // server confirmed — stop overriding
        } else {
          // Keep local mount state visible until server catches up
          p.isMounted        = true;
          p.mountedModuleId  = this.pendingMount.moduleId;
          if (this.pendingMount.mountOffset) p.mountOffset = this.pendingMount.mountOffset;
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
            let moduleKind = 'helm'; // default fallback
            const ship = worldState.ships.find(s => s.id === player.carrierId);
            if (ship && player.mountedModuleId) {
              const mod = ship.modules.find(m => m.id === player.mountedModuleId);
              if (mod) moduleKind = mod.kind.toLowerCase();
            }
            // For helm: seed sail openness from the first mast so W works immediately
            let initialSailOpenness: number | undefined;
            if (moduleKind === 'helm') {
              const mast = ship?.modules.find(m => m.kind === 'mast');
              const mastData = mast?.moduleData as any;
              if (typeof mastData?.openness === 'number') initialSailOpenness = mastData.openness;
            }
            this.inputManager.setMountState(true, player.carrierId, moduleKind, player.mountedModuleId, initialSailOpenness);
            // Zoom out when mounting the helm
            if (moduleKind === 'helm') {
              this.preHelmZoom = this.camera.getState().zoom;
              this.targetZoom  = ClientApplication.HELM_ZOOM;
            }
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

    // Re-evaluate build mode whenever world state arrives (inventory may have changed)
    this.checkBuildMode();
    
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
   * Exit every build and plan mode in one call.
   * Use this whenever the player does something incompatible with build/plan mode
   * (interact, mount, dismount, etc.).
   */
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
    const inCannonBuildMode = activeItem === 'cannon';
    const inMastBuildMode   = activeItem === 'sail';
    const inHelmBuildMode   = activeItem === 'helm_kit';
    const inDeckBuildMode   = activeItem === 'deck';

    // Track whether the active item changed while in explicit build mode
    if (this.explicitBuildMode) {
      if (activeItem === 'cannon' || activeItem === 'sail') {
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
        this.pendingGhostKind = null;
        this.syncBuildModeState();
        console.log('🔨 [BUILD MODE] EXITED (item changed)');
      }
    } else if (this.buildMenuOpen && (activeItem === 'cannon' || activeItem === 'sail')) {
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
    this.renderSystem.setHelmBuildMode(!this.explicitBuildMode && inHelmBuildMode);
    this.renderSystem.setDeckBuildMode(!this.explicitBuildMode && inDeckBuildMode);
    this.inputManager.buildMode = this.explicitBuildMode || this.buildMenuOpen
      || inBuildMode || inCannonBuildMode || inMastBuildMode || inHelmBuildMode || inDeckBuildMode;
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
    const ghostMargin = this.pendingGhostKind === 'cannon' ? 15 : this.pendingGhostKind === 'mast' ? 15 : 10;
    const ghostEdgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
    if (ghostEdgeDist < ghostMargin) {
      console.log(`❌ [GHOST] Too close to hull edge (dist ${ghostEdgeDist.toFixed(1)}, min ${ghostMargin})`);
      return;
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
      cannon: 'cannon', sail: 'mast',
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
    const newKind = this.buildSelectedItem === 'cannon' ? 'cannon' as const : 'mast' as const;

    // Cannon base half-width = 15; mast radius = 15 — center must be at least this far from hull edge
    const placementMargin = 15;
    const edgeDist = PolygonUtils.distanceToPolygonEdge(Vec2.from(localX, localY), nearestShip.hull);
    if (edgeDist < placementMargin) {
      console.log(`❌ [BUILD] Too close to hull edge (dist ${edgeDist.toFixed(1)}, min ${placementMargin})`);
      return;
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
      
      // Update render system for hover detection
      this.renderSystem.updateMousePosition(worldPos);
      // Feed radial menu mouse position (screen space)
      this._radialMenu.updateMouse(screenX, screenY);
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
      if (e.repeat) return; // no auto-repeat for E-hold logic

      // Route Space / Enter to UIManager for minigame handling first
      if (this.uiManager?.handleKeyDown(e.key)) {
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'e':
        case 'E': {
          // Auth state has the most reliable positions; fall through to predicted then demo
          const wsE = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const myIdE = this.networkManager.getAssignedPlayerId();
          if (!wsE) { console.warn('🪜 E: no world state'); break; }

          // Try specific ID first; fall back to first player (demo / offline mode)
          let meE = (myIdE !== null ? wsE.players.find(p => p.id === myIdE) : null) ?? wsE.players[0] ?? null;
          if (!meE) { console.warn('🪜 E: player not found'); break; }

          // ── STEP 1: Player is mounted → dismount (hold ring + radial) ────────
          // Checked first so dismounting never accidentally opens a ladder radial.
          if (meE.isMounted && meE.carrierId !== 0) {
            const MOUNT_RANGE = 180;
            const MOUNTABLE = new Set(['helm', 'cannon', 'mast']);
            let dismountModule: { ship: any; module: any; kind: string } | null = null;
            let dismountDist = Infinity;

            for (const ship of wsE.ships) {
              if (ship.id !== meE.carrierId) continue;
              for (const mod of ship.modules) {
                if (!MOUNTABLE.has(mod.kind)) continue;
                // Prefer exact mounted module ID when available
                if (meE.mountedModuleId !== undefined && mod.id === meE.mountedModuleId) {
                  dismountModule = { ship, module: mod, kind: mod.kind };
                  dismountDist = 0;
                  break;
                }
                let dist: number;
                if (meE.localPosition) {
                  dist = Math.hypot(
                    (meE.localPosition as any).x - mod.localPos.x,
                    (meE.localPosition as any).y - mod.localPos.y
                  );
                } else {
                  const cos = Math.cos(ship.rotation);
                  const sin = Math.sin(ship.rotation);
                  const mwx = ship.position.x + (mod.localPos.x * cos - mod.localPos.y * sin);
                  const mwy = ship.position.y + (mod.localPos.x * sin + mod.localPos.y * cos);
                  dist = Math.hypot(meE.position.x - mwx, meE.position.y - mwy);
                }
                if (dist <= MOUNT_RANGE && dist < dismountDist) {
                  dismountDist = dist;
                  dismountModule = { ship, module: mod, kind: mod.kind };
                }
              }
              if (dismountDist === 0) break;
            }

            if (dismountModule) {
              this._interactKind = 'mount';
              this._suppressLadderInteract = true;
              this._ladderHoldWasMounted = true;
              this._ladderHoldModuleId = dismountModule.module.id;
              console.log(`🎮 E: dismount ${dismountModule.kind} ${dismountModule.module.id}`);
              this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
              this._ladderHoldTimer = setTimeout(() => {
                this._ladderHoldTimer = null;
                this.renderSystem.stopLadderHoldRing();
                const mp = this.inputManager.getMouseScreenPosition();
                this._radialMenu.open(mp.x, mp.y, [{ id: 'dismount', label: 'Dismount' }]);
              }, 300);
              break;
            }
          }

          // ── STEP 2: Nearest mountable on player's ship (120 px) ──────────────
          // Only when not already mounted — mount is deferred to keyup via radial.
          if (!meE.isMounted && meE.carrierId !== 0) {
            const MOUNT_RANGE = 120;
            const MOUNTABLE = new Set(['helm', 'cannon', 'mast']);
            let bestMount: { ship: any; module: any; kind: string } | null = null;
            let bestMountDist = Infinity;

            for (const ship of wsE.ships) {
              if (ship.id !== meE.carrierId) continue;
              for (const mod of ship.modules) {
                if (!MOUNTABLE.has(mod.kind)) continue;
                let dist: number;
                if (meE.localPosition) {
                  dist = Math.hypot(
                    (meE.localPosition as any).x - mod.localPos.x,
                    (meE.localPosition as any).y - mod.localPos.y
                  );
                } else {
                  const cos = Math.cos(ship.rotation);
                  const sin = Math.sin(ship.rotation);
                  const mwx = ship.position.x + (mod.localPos.x * cos - mod.localPos.y * sin);
                  const mwy = ship.position.y + (mod.localPos.x * sin + mod.localPos.y * cos);
                  dist = Math.hypot(meE.position.x - mwx, meE.position.y - mwy);
                }
                if (dist <= MOUNT_RANGE && dist < bestMountDist) {
                  bestMountDist = dist;
                  bestMount = { ship, module: mod, kind: mod.kind };
                }
              }
            }

            if (bestMount) {
              this._interactKind = 'mount';
              this._suppressLadderInteract = true;
              this._ladderHoldWasMounted = false;
              this._ladderHoldModuleId = bestMount.module.id;
              console.log(`🎮 E: mount ${bestMount.kind} ${bestMount.module.id} dist=${bestMountDist.toFixed(0)}px`);
              this.renderSystem.startLadderHoldRing(this.inputManager.getMouseScreenPosition());
              const mountKindLabel = bestMount.kind.charAt(0).toUpperCase() + bestMount.kind.slice(1);
              this._ladderHoldTimer = setTimeout(() => {
                this._ladderHoldTimer = null;
                this.renderSystem.stopLadderHoldRing();
                const mp = this.inputManager.getMouseScreenPosition();
                this._radialMenu.open(mp.x, mp.y, [{ id: 'mount', label: `Mount ${mountKindLabel}` }]);
              }, 300);
              break;
            }
          }

          // ── STEP 3: Nearest ladder (200 px) ──────────────────────────────────
          const LADDER_RANGE = 200;
          let bestLadder: { ship: any; module: any } | null = null;
          let bestLadderDist = Infinity;
          let nearestAny = Infinity;

          for (const ship of wsE.ships) {
            const cos = Math.cos(ship.rotation);
            const sin = Math.sin(ship.rotation);
            for (const mod of ship.modules) {
              if (mod.kind !== 'ladder') continue;
              const mwx = ship.position.x + (mod.localPos.x * cos - mod.localPos.y * sin);
              const mwy = ship.position.y + (mod.localPos.x * sin + mod.localPos.y * cos);
              let dist: number;
              if (meE.carrierId !== 0 && meE.carrierId === ship.id && meE.localPosition) {
                dist = Math.hypot(
                  (meE.localPosition as any).x - mod.localPos.x,
                  (meE.localPosition as any).y - mod.localPos.y
                );
              } else {
                dist = Math.hypot(meE.position.x - mwx, meE.position.y - mwy);
              }
              if (dist < nearestAny) nearestAny = dist;
              if (dist <= LADDER_RANGE && dist < bestLadderDist) { bestLadderDist = dist; bestLadder = { ship, module: mod }; }
            }
          }

          if (bestLadder) {
            // ── LADDER INTERACTION ───────────────────────────────────────────
            this._interactKind = 'ladder';
            this._suppressLadderInteract = true;
            this._ladderHoldModuleId = bestLadder.module.id;
            this._ladderHoldIsExtended = (bestLadder.module.moduleData as any)?.extended !== false;
            this._ladderHoldOnShip = meE.carrierId === bestLadder.ship.id;

            console.log(`🪜 E: ladder ${bestLadder.module.id} dist=${bestLadderDist.toFixed(0)}px onShip=${this._ladderHoldOnShip} extended=${this._ladderHoldIsExtended}`);

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

          // Nothing found
          console.warn(`🪜 E: nothing in range (nearest ladder ${nearestAny === Infinity ? '-' : nearestAny.toFixed(0)}px)`);
          break;
        }
        case 'l':
        case 'L': {
          // Toggle all ladders on all ships belonging to player's company
          const ws = this.authoritativeWorldState || this.predictedWorldState;
          const myId = this.networkManager.getAssignedPlayerId();
          const me = myId !== null ? ws?.players.find(p => p.id === myId) : null;
          if (!me || !ws) { e.preventDefault(); break; }
          const companyId = me.companyId ?? 0;
          if (companyId === 0) {
            console.log('Neutral company — cannot mass-toggle ladders');
            e.preventDefault();
            break;
          }
          let ladderCount = 0;
          for (const ship of ws.ships) {
            if (ship.companyId !== companyId) continue;
            for (const mod of ship.modules) {
              if (mod.kind === 'ladder') {
                this.networkManager.sendToggleLadder(mod.id);
                ladderCount++;
              }
            }
          }
          console.log(`🪜 [LADDER] Toggled ${ladderCount} ladder(s) on company ${companyId} ships`);
          e.preventDefault();
          break;
        }
        case ']':
          this.renderSystem.toggleHoverBoundaries();
          e.preventDefault();
          break;
      }
    });

    // E keyup: execute action based on how long E was held
    window.addEventListener('keyup', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== 'e' && e.key !== 'E') return;

      const moduleId = this._ladderHoldModuleId;
      const interactKind = this._interactKind;
      const wasMounted = this._ladderHoldWasMounted;
      this._suppressLadderInteract = false;
      this._ladderHoldModuleId = null;
      this._interactKind = null;
      this._ladderHoldWasMounted = false;

      // ── MOUNTABLE MODULES (helm / cannon / mast) — mount or dismount ────────
      if (interactKind === 'mount') {
        // Route to the correct network call based on whether the player was mounted.
        const doMountAction = (): void => {
          if (wasMounted) {
            this.networkManager.sendAction('dismount');
            console.log(`🎮 dismount (module ${moduleId})`);
          } else if (moduleId !== null) {
            this.networkManager.sendModuleInteract(moduleId);
            console.log(`🎮 mount module ${moduleId}`);
          }
        };

        if (this._ladderHoldTimer !== null) {
          // Tap (< 300 ms) — execute immediately, no cancel possible
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
          doMountAction();
        } else if (this._radialMenu.isOpen) {
          // Hold — execute selected option or cancel if centre dead zone
          const selected = this._radialMenu.getHoveredId();
          this._radialMenu.close();
          if (selected) {
            doMountAction();
          } else {
            console.log('🎮 radial: cancelled (centre dead zone)');
          }
        }
        return;
      }

      // ── LADDER ───────────────────────────────────────────────────────────
      if (this._ladderHoldTimer !== null) {
        // Released before 300 ms — execute PRIMARY action immediately (no radial shown)
        clearTimeout(this._ladderHoldTimer);
        this._ladderHoldTimer = null;
        this.renderSystem.stopLadderHoldRing();

        if (moduleId === null) return;

        if (this._ladderHoldOnShip) {
          // On ship: tap toggles extend/retract via module_interact (no company check)
          this.networkManager.sendModuleInteract(moduleId);
          console.log(`🪜 tap: ${this._ladderHoldIsExtended ? 'retract' : 'extend'} ladder ${moduleId}`);
        } else if (this._ladderHoldIsExtended) {
          // Off ship, extended: tap = climb
          this.networkManager.sendModuleInteract(moduleId);
          console.log(`🪜 tap: climb ladder ${moduleId}`);
        } else {
          // Off ship, retracted: tap = extend
          this.networkManager.sendToggleLadder(moduleId);
          console.log(`🪜 tap: extend ladder ${moduleId}`);
        }
      } else if (this._radialMenu.isOpen) {
        // Radial was open — execute selected option
        const selected = this._radialMenu.getHoveredId();
        this._radialMenu.close();

        if (!selected || moduleId === null) return;
        console.log(`🪜 radial: ${selected} ladder ${moduleId}`);

        if (selected === 'climb') {
          this.networkManager.sendModuleInteract(moduleId);
        } else if (selected === 'retract' || selected === 'extend') {
          if (this._ladderHoldOnShip) {
            this.networkManager.sendModuleInteract(moduleId);
          } else {
            this.networkManager.sendToggleLadder(moduleId);
          }
        }
      }
    });

    console.log('⌨️ Debug keys initialized (] = toggle hover boundaries)');
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

        // Boarding ladder at stern
        ModuleUtils.createDefaultModule(1010, 'ladder', Vec2.from(-305, 0)),
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
          inventory: createEmptyInventory()
        }
      ],
      cannonballs: [],
      npcs: [],
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
    
    // Enable ship/cannon/mast controls
    if (moduleKind.toUpperCase() === 'HELM' || moduleKind.toUpperCase() === 'CANNON' || moduleKind.toUpperCase() === 'MAST') {
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