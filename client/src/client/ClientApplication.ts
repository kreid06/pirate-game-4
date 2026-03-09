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

// Audio System
import { AudioManager } from './audio/AudioManager.js';

// Core Simulation Types
import { WorldState, Ship, InputFrame } from '../sim/Types.js';
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
  private previousMountState = false; // Track previous mount state to detect changes

  // Explicit build mode (B key) — independent of hotbar item build modes
  private explicitBuildMode = false;
  private buildSelectedItem: 'cannon' | 'sail' = 'cannon';
  private buildRotationDeg = 0;

  // Ghost placement system — B key opens build menu, player places planning markers
  private buildMenuOpen = false;
  private ghostPlacements: GhostPlacement[] = [];
  private pendingGhostKind: GhostModuleKind | null = null;
  // Optimistic modules placed locally, keyed by ship ID, with expiry timestamp.
  // Overlaid on top of worldToRender every frame so they appear in online mode.
  private localPendingModules = new Map<number, { module: ShipModule; expiry: number }[]>();
  
  // Timing
  private running = false;
  private lastFrameTime = 0;
  private accumulator = 0;
  private readonly clientTickDuration: number; // milliseconds per client tick
  
  // Performance Tracking
  private frameCount = 0;
  private fpsTimer = 0;
  private currentFPS = 0;
  private lastRenderLogTime = 0;
  
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
          // Not a hammer click — pass to server
          this.networkManager.sendAction(action, target);
          return;
        }

        if (action === 'interact') {
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

          // Player pressed E - interact with hovered module
          const hoveredModule = this.renderSystem.getHoveredModule();
          
          if (hoveredModule) {
            if (playerId !== null) {
              // Check if player is close enough to the module
              if (!worldState) return;
              
              
              if (player) {
                let distance: number;
                let moduleWorldPos: Vec2;
                
                // Calculate module world position
                const cos = Math.cos(hoveredModule.ship.rotation);
                const sin = Math.sin(hoveredModule.ship.rotation);
                const moduleWorldX = hoveredModule.ship.position.x + 
                  (hoveredModule.module.localPos.x * cos - hoveredModule.module.localPos.y * sin);
                const moduleWorldY = hoveredModule.ship.position.y + 
                  (hoveredModule.module.localPos.x * sin + hoveredModule.module.localPos.y * cos);
                moduleWorldPos = Vec2.from(moduleWorldX, moduleWorldY);
                
                // If player is on the same ship as the module, use local (ship-relative) coordinates
                if (player.carrierId === hoveredModule.ship.id && player.localPosition) {
                  // Both player and module are on the same ship - use local coordinates
                  const moduleLocalPos = hoveredModule.module.localPos;
                  distance = player.localPosition.sub(moduleLocalPos).length();
                } else {
                  // Player not on ship or on different ship - use world coordinates
                  distance = player.position.sub(moduleWorldPos).length();
                }
                
                const maxInteractDistance = 50; // Maximum interaction range
                
                if (distance <= maxInteractDistance) {
                  console.log(`🎯 [INTERACTION] Player interacting with ${hoveredModule.module.kind.toUpperCase()} (ID: ${hoveredModule.module.id}) at distance ${distance.toFixed(1)}px`);
                  console.log(`   Player world: (${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}), Module world: (${moduleWorldPos.x.toFixed(1)}, ${moduleWorldPos.y.toFixed(1)})`);
                  this.networkManager.sendModuleInteract(hoveredModule.module.id);
                } else {
                  console.log(`❌ [INTERACTION] ${hoveredModule.module.kind.toUpperCase()} too far: ${distance.toFixed(1)}px > ${maxInteractDistance}px`);
                  console.log(`   Player world: (${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}), Module world: (${moduleWorldPos.x.toFixed(1)}, ${moduleWorldPos.y.toFixed(1)})`);
                }
              }
            }
          } else {
            console.log(`⚠️ [INTERACTION] No module hovered - move mouse over a module and press E`);
          }
        } else {
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
      this.inputManager.onCannonAim = (aimAngle) => {
        this.networkManager.sendCannonAim(aimAngle);
      };
      this.inputManager.onCannonFire = (cannonIds, fireAll, ammoType) => {
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

      // Hotbar slot selection — update locally for instant UI feedback, then sync server
      this.inputManager.onSlotSelect = (slot) => {
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
        if (this.buildMenuOpen) {
          // Close the build menu and cancel any pending ghost
          this.buildMenuOpen = false;
          this.inputManager.buildMenuOpen = false;
          this.explicitBuildMode = false;
          this.pendingGhostKind = null;
          this.buildRotationDeg = 0;
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
          console.log(`🏗️ [BUILD MENU] OPENED${this.explicitBuildMode ? ` (free-place: ${this.buildSelectedItem})` : ''}`);
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
      
      // Set up scroll-wheel zoom
      this.inputManager.onZoom = (factor, _screenPoint) => {
        this.camera.setZoom(this.camera.getState().zoom * factor);
      };

      // Let UI panels (e.g. manning priority panel) consume clicks before game logic
      this.inputManager.onUIClick = (x, y) => {
        return this.uiManager?.handleClick(x, y) ?? false;
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

      // Build mode item selection (cannon/sail buttons in build mode panel)
      this.uiManager.onBuildItemSelect = (item) => {
        this.buildSelectedItem = item;
        this.syncBuildModeState();
      };

      // Build panel: player selected a module type for ghost placement
      // This unequips any matching hotbar item and attaches a ghost to the cursor.
      this.uiManager.onBuildPanelSelect = (kind: GhostModuleKind) => {
        const ws = this.authoritativeWorldState ?? this.predictedWorldState ?? this.demoWorldState;
        const playerId = this.networkManager?.getAssignedPlayerId();
        const player = ws?.players.find(p => p.id === playerId);
        if (player) {
          // Unequip matching hotbar item so we go into ghost-only mode
          const kindToItem: Partial<Record<GhostModuleKind, string>> = {
            plank: 'plank', cannon: 'cannon', mast: 'sail', helm: 'helm_kit', deck: 'deck',
          };
          const activeSlot = player.inventory?.activeSlot ?? 0;
          const activeItem = player.inventory?.slots[activeSlot]?.item ?? 'none';
          if (activeItem === kindToItem[kind]) {
            const emptyIdx = player.inventory.slots.findIndex(s => s.item === 'none');
            if (emptyIdx >= 0) this.networkManager.sendSlotSelect(emptyIdx);
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

      // Keep explicit build mode UI in sync with latest world state (sail count may change)
      if (this.explicitBuildMode) this.syncBuildModeState();

      // Render game world with hybrid state
      this.renderSystem.renderWorld(worldToRender, this.camera, alpha);
      
      // Pipe screen-space mouse position so UIManager can render hotbar tooltips
      if (this.inputManager) {
        const mp = this.inputManager.getMouseScreenPosition();
        this.uiManager.setMousePos(mp.x, mp.y);
      }

      // Render UI overlay
      const assignedPlayerId = this.networkManager.getAssignedPlayerId();
      const playerShipId = assignedPlayerId !== null
        ? (worldToRender.players.find(p => p.id === assignedPlayerId)?.carrierId ?? 0)
        : 0;
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
            // Player is now mounted - enable controls
            console.log(`⚓ [MOUNT STATE] Server says player is mounted to module ${player.mountedModuleId}`);
            // Look up the module kind from the ship
            let moduleKind = 'helm'; // default fallback
            const ship = worldState.ships.find(s => s.id === player.carrierId);
            if (ship && player.mountedModuleId) {
              const mod = ship.modules.find(m => m.id === player.mountedModuleId);
              if (mod) moduleKind = mod.kind.toLowerCase();
            }
            this.inputManager.setMountState(true, player.carrierId, moduleKind, player.mountedModuleId);
          } else {
            // Player is now dismounted - disable ship controls
            console.log(`⚓ [MOUNT STATE] Server says player is dismounted`);
            this.inputManager.setMountState(false);
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
        this.syncBuildModeState();
        console.log('🔨 [BUILD MODE] EXITED (item changed)');
      }
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

    const ghostRotRad = (this.buildRotationDeg * Math.PI) / 180;

    // Mast ghosts: snap to centerline and enforce min separation
    if (this.pendingGhostKind === 'mast') {
      localY = 0; // Force onto ship centerline
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
    if (!nearestShip || nearestDist > 400) return; // Too far from any ship

    // Convert world position to ship-local coordinates
    const dx = worldPos.x - nearestShip.position.x;
    const dy = worldPos.y - nearestShip.position.y;
    const cos = Math.cos(-nearestShip.rotation);
    const sin = Math.sin(-nearestShip.rotation);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    const rotationRad = (this.buildRotationDeg * Math.PI) / 180;

    // Geometry-based overlap check against existing non-plank, non-deck modules
    const newKind = this.buildSelectedItem === 'cannon' ? 'cannon' as const : 'mast' as const;
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

    // Block placement if it overlaps any ghost planning marker on this ship
    for (const g of this.ghostPlacements) {
      if (g.shipId !== nearestShip.id) continue;
      const ghostFp = getModuleFootprint(g.kind as any);
      if (footprintsOverlap(newFp, localX, localY, rotationRad, ghostFp, g.localPos.x, g.localPos.y, g.localRot)) {
        console.log(`❌ [BUILD] Placement blocked by ghost marker (${g.kind}) — remove it first`);
        return;
      }
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
      // Sail — check for max 3 masts
      const mastCount = shipRef.modules.filter(m => m.kind === 'mast').length;
      if (mastCount >= 3) {
        console.log(`❌ [BUILD] Max sails reached (${mastCount}/3)`);
        return;
      }
      // Sail placement constraints:
      // 1. Mast center must be on the ship centerline (|localY| ≤ 25)
      if (Math.abs(localY) > 25) {
        console.log(`❌ [BUILD] Sail must be on ship centerline — current offset: ${localY.toFixed(0)} (max ±25)`);
        return;
      }
      // 2. Mast cleats must not overlap — enforce minimum center-to-center separation
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
        this.camera.setZoom(this.camera.getState().zoom * 1.2);
      });
    }
    if (zoomOut) {
      zoomOut.addEventListener('click', () => {
        this.camera.setZoom(this.camera.getState().zoom / 1.2);
      });
    }
  }

  private setupDebugKeys(): void {
    window.addEventListener('keydown', (e) => {
      // Only handle if not typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Route Space / Enter to UIManager for minigame handling first
      if (this.uiManager?.handleKeyDown(e.key)) {
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case ']':
          this.renderSystem.toggleHoverBoundaries();
          e.preventDefault();
          break;
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
      
      // Log FPS and frame time for diagnostics
      console.log(`📊 Render FPS: ${this.currentFPS} | Avg frame time: ${avgFrameTime.toFixed(2)}ms | Client tick: ${this.clientTickDuration.toFixed(2)}ms (${(1000/this.clientTickDuration).toFixed(0)}Hz)`);
      
      // Detect capping
      if (this.currentFPS >= 59 && this.currentFPS <= 61) {
        console.warn('⚠️ Rendering capped at 60 FPS (likely VSync or monitor refresh rate)');
      } else if (this.currentFPS >= 119 && this.currentFPS <= 121) {
        console.log('✅ Rendering at 120 FPS - excellent!');
      } else if (this.currentFPS >= 143 && this.currentFPS <= 145) {
        console.log('✅ Rendering at 144 FPS - excellent!');
      } else if (this.currentFPS >= 29 && this.currentFPS <= 31) {
        console.warn('⚠️ Low FPS (30) - performance bottleneck detected');
      }
      
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
      
      this.inputManager.setMountState(true, shipId, moduleKind, moduleId);
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
    // Could show UI notification here
  }
}