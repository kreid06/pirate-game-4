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
import { CraftingMenu } from './ui/CraftingMenu.js';

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
  private buildSelectedItem: 'cannon' | 'sail' | 'swivel' = 'cannon';
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
  /** What kind of module the current E-hold targets: 'ladder' | 'mount' | 'npc' | 'structure' | null */
  private _interactKind: 'ladder' | 'mount' | 'npc' | 'structure' | null = null;
  /** Placed-structure id locked in at E-keydown for the structure interact path. */
  private _hoveredStructureId: number | null = null;
  /** Type of the locked-in structure ('wooden_floor' | 'workbench'). */
  private _hoveredStructureType: 'wooden_floor' | 'workbench' | null = null;
  /** True when the E-hold was started while the player was already mounted (dismount path). */
  private _ladderHoldWasMounted = false;
  /** Ship ID that owns the locked-in module (for keyup range validation). */
  private _ladderHoldShipId: number | null = null;
  /** NPC id locked in at E-keydown for the NPC radial interact path. */
  private _npcInteractId: number | null = null;
  /** NPC id for the pending "Move To" targeting mode (ctrl+click → Move To → click module). */
  private _moveToNpcId: number | null = null;
  /** Screen-space position to flash once the server confirms (or rejects) a goto-module command. */
  private _pendingModuleFlashPos: Vec2 | null = null;
  /** Generic radial action menu instance (rendered by RenderSystem). */
  private _radialMenu = new RadialMenu();
  /** Crafting panel opened when the player presses E near a workbench. */
  private craftingMenu = new CraftingMenu();
  /** True when the player's active slot is wooden_floor or workbench on an island. */
  private islandBuildMode = false;
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
          this.renderSystem.spawnDamageNumber(Vec2.from(worldX, worldY), damage, false);
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
          const FACTION: Record<number, string> = { 0: 'Neutral', 1: 'Pirates', 2: 'Navy', 99: 'Phantom Brig' };
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

      this.networkManager.onHarvestResult = (success, planks, reason) => {
        if (success) {
          this.renderSystem.showAnnouncement(`🪓 Harvested wood  +${planks} plank${planks !== 1 ? 's' : ''}`, 'info', 2.5);
        } else {
          const msg: Record<string, string> = {
            need_axe:        'Equip the axe to chop trees',
            too_far:         'Move closer to a tree',
            not_on_island:   'You must be on an island',
            inventory_full:  'Inventory is full',
          };
          this.renderSystem.showAnnouncement(`🪓 ${msg[reason] ?? 'Cannot harvest right now'}`, 'info', 2.0);
        }
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

          // Harvest mode: active slot = axe + not on a ship → chop nearest wood resource
          if (activeItem === 'axe' && player && player.carrierId === 0) {
            console.log(`🪓 [HARVEST] Sending harvest_resource`);
            this.networkManager.sendHarvestResource();
            return;
          }

          // Workbench interaction: player on island, workbench within range → open crafting
          if (player && player.carrierId === 0) {
            if (this.craftingMenu.visible) {
              this.craftingMenu.close();
              return;
            }
            const bench = this.renderSystem.getHoveredWorkbench();
            if (bench) {
              console.log(`⚒ [INTERACT] Sending structure_interact for workbench ${bench.id}`);
              this.networkManager.sendStructureInteract(bench.id);
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
        // Island structure placement (wooden floor or workbench)
        if (this.islandBuildMode) {
          const ws  = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
          const pid = this.networkManager.getAssignedPlayerId();
          const p   = ws?.players.find(pl => pl.id === pid);
          const kind = p?.inventory?.slots[p.inventory.activeSlot ?? 0]?.item;
          if (kind === 'wooden_floor' || kind === 'workbench') {
            // Compute snap at click time (not from stale render state)
            const pos = kind === 'wooden_floor'
              ? this.renderSystem.computeSnappedPos(worldPos.x, worldPos.y)
              : { x: worldPos.x, y: worldPos.y };
            this.networkManager.sendPlaceStructure(kind, pos.x, pos.y);
          }
          return;
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
        if (this.craftingMenu.handleClick(x, y, this.canvas.width, this.canvas.height)) return true;
        if (this.uiManager?.handleClick(x, y)) return true;
        return false;
      };

      // Ctrl+left-click: assign/remove cannon from the active weapon group
      //   — but if an NPC is hovered, open an NPC command radial instead
      this.inputManager.onGroupAssign = () => {
        // ── Ctrl+click on an NPC → command radial ───────────────────────────
        const hovNpcCtrl = this.renderSystem.getHoveredNpc();
        if (hovNpcCtrl) {
          const ws = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const myId = this.networkManager.getAssignedPlayerId();
          const me = (myId !== null ? ws?.players.find(p => p.id === myId) : null) ?? ws?.players[0] ?? null;
          const myCompany = me?.companyId ?? 0;
          // Only command your own crew
          if (hovNpcCtrl.companyId !== myCompany || myCompany === 0) return;

          // Build radial options
          const cmdOpts: Array<{ id: string; label: string }> = [];
          if (hovNpcCtrl.assignedWeaponId !== 0) {
            // At a module — show lock toggle
            cmdOpts.push(hovNpcCtrl.locked
              ? { id: 'unlock', label: '🔓 Unlock' }
              : { id: 'lock',   label: '🔒 Lock at Post' });
          }
          cmdOpts.push({ id: 'move_to', label: '📍 Move To...' });

          if (cmdOpts.length === 1 && cmdOpts[0].id === 'move_to') {
            // Only one option — execute immediately
            this._moveToNpcId = hovNpcCtrl.id;
            this.renderSystem.setMoveToSourceNpc(hovNpcCtrl.id);
            this.renderSystem.setMoveToHint(`Moving ${hovNpcCtrl.name} — click a module, ship, or open water`);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            return;
          }

          const mp = this.inputManager.getMouseScreenPosition();
          this._radialMenu.open(mp.x, mp.y, cmdOpts);

          // Wait for the next pointerup / mouseup to resolve the selection
          const onUp = () => {
            window.removeEventListener('pointerup', onUp);
            const selected = this._radialMenu.getHoveredId();
            this._radialMenu.close();
            if (!selected) {
              this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
              return;
            }
            const npc = ws?.npcs.find(n => n.id === hovNpcCtrl.id);
            if (!npc) return;
            if (selected === 'lock') {
              this.networkManager.sendNpcLock(npc.id, true);
              console.log(`🔒 Locking NPC ${npc.id} (${npc.name}) at post`);
            } else if (selected === 'unlock') {
              this.networkManager.sendNpcLock(npc.id, false);
              console.log(`🔓 Unlocking NPC ${npc.id} (${npc.name})`);
            } else if (selected === 'move_to') {
              this._moveToNpcId = npc.id;
              this.renderSystem.setMoveToSourceNpc(npc.id);
              this.renderSystem.setMoveToHint(`Moving ${npc.name} — click a module, ship, or open water`);
              console.log(`📍 Move To mode for NPC ${npc.id} (${npc.name})`);
            }
          };
          window.addEventListener('pointerup', onUp);
          return;
        }

        // ── Default: cannon group assignment ────────────────────────────────
        const hovered = this.renderSystem.getHoveredModule();
        if (!hovered) {
          console.warn(`⚠️ GroupAssign: no module hovered`);
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
      this.inputManager.onBeforeLeftClick = () => this._moveToNpcId !== null;

      // Right-click: cancel Move To mode before any other right-click handling
      this.inputManager.onBeforeRightClick = () => {
        if (this._moveToNpcId !== null) {
          this._moveToNpcId = null;
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

      // Handle FIRE_EFFECT: mark entity/module as burning
      this.networkManager.onFireEffect = (entityType, id, x, y, durationMs, shipId, moduleId) => {
        this.renderSystem.notifyFireEffect(entityType, id, durationMs, shipId, moduleId);
      };

      // Handle ISLANDS: server-defined island layout
      this.networkManager.onIslands = (islands) => {
        this.renderSystem.setIslands(islands);
      };

      // Handle placed structures
      this.networkManager.onStructuresList = (structs) => {
        this.renderSystem.setPlacedStructures(structs);
      };
      this.networkManager.onStructureDemolished = (id) => {
        this.renderSystem.removePlacedStructure(id);
      };
      this.networkManager.onStructurePlaced = (s) => {
        this.renderSystem.addPlacedStructure(s);
      };
      this.networkManager.onCraftingOpen = (structureId, _structureType) => {
        this.craftingMenu.open(structureId);
      };

      // Handle FLAME_CONE_FIRE / FLAME_WAVE_UPDATE: advancing/retreating cone visual
      this.networkManager.onFlameWaveUpdate = (cannonId, shipId, x, y, angle, halfCone, waveDist, retreating, retreatDist, dead) => {
        this.renderSystem.updateFlameWave(cannonId, shipId, x, y, angle, halfCone, waveDist, retreating, retreatDist, dead);
      };

      // Handle CANNON_FIRE_EVENT: render hit-scan tracers for grapeshot / canister
      this.networkManager.onCannonFireEvent = (_cannonId, _shipId, x, y, angle, projectileId, ammoType) => {
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
      this.renderSystem.localPlayerId = assignedPlayerId;
      this.renderSystem.playerAimAngleRelative = this.inputManager?.cannonAimAngleRelative ?? 0;
      this.renderSystem.selectedAmmoType = this.inputManager?.getLoadedAmmoType() ?? 0;
      this.renderSystem.npcTaskMap = this.uiManager.getNpcTaskMap();
      this.renderSystem.controlGroups = this.controlGroups as Map<number, { cannonIds: number[]; mode: string }>;
      this.renderSystem.showGroupOverlay = this.inputManager?.isCtrlHeld() ?? false;
      this.renderSystem.activeWeaponGroups = this.inputManager?.activeWeaponGroups ?? new Set();

      // Resolve local player once — reused by sword equip check, cursor cooldown ring, and UI render.
      const localPlayer = assignedPlayerId !== null
        ? worldToRender.players.find(p => p.id === assignedPlayerId) ?? null
        : null;

      // Sword cooldown ring: only visible when sword is the active item and player is unmounted
      const _activeSlot  = localPlayer?.inventory?.activeSlot ?? 0;
      this.renderSystem.swordEquipped =
        (localPlayer?.inventory?.slots[_activeSlot]?.item === 'sword') &&
        !(localPlayer?.isMounted ?? false);
      if (this.explicitBuildMode) this.syncBuildModeState();

      // Render game world with hybrid state
      this.renderSystem.renderWorld(worldToRender, this.camera, alpha);

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
      });

      // Crafting menu (rendered on top of all other UI)
      if (this.craftingMenu.visible) {
        this.craftingMenu.render(
          this.renderSystem.getContext(),
          this.canvas.width,
          this.canvas.height,
        );
      }
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
  /**
   * Find the first ship whose hull polygon contains the given world position.
   * Checks ALL ships (including the player’s own) so Move To can target any deck.
   */
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

    // Island placement build mode — wooden_floor or workbench while not on a ship
    const inIslandBuildMode = (player?.carrierId === 0) && (activeItem === 'wooden_floor' || activeItem === 'workbench');
    this.islandBuildMode = inIslandBuildMode && !this.explicitBuildMode;
    this.renderSystem.setIslandBuildItem(
      this.islandBuildMode ? (activeItem as 'wooden_floor' | 'workbench') : null
    );

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
      || inBuildMode || inCannonBuildMode || inMastBuildMode || inSwivelBuildMode || inHelmBuildMode || inDeckBuildMode || this.islandBuildMode;
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

      // Route Space / Enter to UIManager for minigame handling first
      if (this.uiManager?.handleKeyDown(e.key)) {
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'Escape':
        case 'q':
        case 'Q': {
          // Cancel "Move To" targeting mode if active
          if (this._moveToNpcId !== null) {
            this._moveToNpcId = null;
            this.renderSystem.clearMoveToHint();
            this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
            e.preventDefault();
          }
          break;
        }

        case 'e':
        case 'E': {
          if (e.repeat) break; // no auto-repeat for E-hold logic
          const wsE = this.authoritativeWorldState || this.predictedWorldState || this.demoWorldState;
          const myIdE = this.networkManager.getAssignedPlayerId();
          if (!wsE) { console.warn('🪜 E: no world state'); break; }

          const meE = (myIdE !== null ? wsE.players.find(p => p.id === myIdE) : null) ?? wsE.players[0] ?? null;
          if (!meE) { console.warn('🪜 E: player not found'); break; }

          // ── Dismount: player is already mounted ──────────────────────────────
          // No hover required — player is physically AT the mounted module.
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
              const npcCompanyE = hovNpcE.companyId;

              // Enemy-company NPC: no interaction
              if (npcCompanyE !== 0 && npcCompanyE !== myCompanyE) {
                console.log(`🚫 E: NPC ${hovNpcE.id} belongs to enemy company ${npcCompanyE}`);
                this._interactKind = null;
                this._suppressLadderInteract = false;
                this._npcInteractId = null;
                this.renderSystem.flashCancel(this.inputManager.getMouseScreenPosition());
                break;
              }

              let npcOpts: { id: string; label: string }[];
              if (npcCompanyE === 0) {
                npcOpts = [{ id: 'recruit', label: 'Recruit to Company' }];
              } else if (npcCompanyE === myCompanyE && hovNpcE.shipId !== meE.carrierId) {
                npcOpts = [{ id: 'move_aboard', label: 'Move Aboard' }];
              } else {
                // Same company, same ship
                npcOpts = [{ id: 'crew_menu', label: 'Manage Crew' }];
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
          if (meE.carrierId === 0) {
            const struct = this.renderSystem.getHoveredStructure();
            if (struct) {
              this._interactKind = 'structure';
              this._hoveredStructureId = struct.id;
              this._hoveredStructureType = struct.type;
              this._suppressLadderInteract = true;
              const mp = this.inputManager.getMouseScreenPosition();
              this.renderSystem.startLadderHoldRing(mp);
              if (struct.type === 'workbench') {
                // Tap E = open workbench; hold E = radial with both options
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  this._radialMenu.open(mp2.x, mp2.y, [
                    { id: 'use',      label: 'Open Workbench' },
                    { id: 'demolish', label: 'Demolish' },
                  ]);
                }, 400);
              } else {
                // Floor: hold E = radial with only Demolish
                this._ladderHoldTimer = setTimeout(() => {
                  this._ladderHoldTimer = null;
                  this.renderSystem.stopLadderHoldRing();
                  const mp2 = this.inputManager.getMouseScreenPosition();
                  this._radialMenu.open(mp2.x, mp2.y, [
                    { id: 'demolish', label: 'Demolish Floor' },
                  ]);
                }, 600);
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
              this._radialMenu.open(mp.x, mp.y, [{ id: 'mount', label: `Mount ${mountKindLabel}` }]);
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

          console.warn(`🪜 E: hovered module kind '${hov.module.kind}' has no interact handler`);
          break;
        }
        case ']':
          this.renderSystem.toggleHoverBoundaries();
          e.preventDefault();
          break;
      }
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

        if (this._ladderHoldTimer !== null) {
          // Tap (released before radial opened)
          clearTimeout(this._ladderHoldTimer);
          this._ladderHoldTimer = null;
          this.renderSystem.stopLadderHoldRing();
          if (structType === 'workbench') {
            // Tap E on workbench = primary action: open
            doUse();
          }
          // Tap E on floor = nothing (user must hold to demolish)
        } else if (this._radialMenu.isOpen) {
          const selected = this._radialMenu.getHoveredId();
          this._radialMenu.close();
          if (selected === 'use')      doUse();
          else if (selected === 'demolish') doDemolish();
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
          if (actionId === 'recruit' && npc.companyId === 0) {
            this.networkManager.sendNpcRecruit(npc.id);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`🤝 Recruiting NPC ${npc.id} (${npc.name})`);
          } else if (actionId === 'move_aboard' && npc.companyId === myCompany) {
            this.networkManager.sendNpcMoveAboard(npc.id);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
            console.log(`⚓ Moving NPC ${npc.id} (${npc.name}) aboard`);
          } else if (actionId === 'crew_menu' && npc.companyId === myCompany) {
            this.uiManager?.openCrewMenuForNpc(npc);
            this.renderSystem.flashInteract(this.inputManager.getMouseScreenPosition());
          }
        };

        const defaultNpcAction = () => {
          const npc = npcId != null ? ws?.npcs.find(n => n.id === npcId) : null;
          if (!npc) return;
          const myCompany = me?.companyId ?? 0;
          if (npc.companyId === 0) {
            executeNpcAction('recruit');
          } else if (npc.companyId === myCompany && npc.shipId !== me?.carrierId) {
            executeNpcAction('move_aboard');
          } else if (npc.companyId === myCompany) {
            executeNpcAction('crew_menu');
          }
          // else: enemy company — no action
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
          if (selected) {
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
          onIslandId: 0,
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