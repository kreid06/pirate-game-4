/**
 * UI Manager - User Interface System
 * 
 * Handles all user interface elements including HUD, menus, and debug overlays.
 * Separated from rendering for clean architecture.
 */

import { ClientConfig } from '../ClientConfig.js';
import { WorldState, Npc, Ship, WeaponGroupMode, WeaponGroupState, DroppedItem } from '../../sim/Types.js';
import { GhostPlacement, GhostModuleKind } from '../../sim/Types.js';
import { Camera } from '../gfx/Camera.js';
import { NetworkStats } from '../../net/NetworkManager.js';
import { ITEM_DEFS, INVENTORY_SLOTS, HOTBAR_SLOTS, ItemKind, ITEM_KIND_ID } from '../../sim/Inventory.js';
import { ManningPriorityPanel } from './ManningPriorityPanel.js';
import { CompanyMenu } from './CompanyMenu.js';
import { PlayerMenu } from './PlayerMenu.js';
import { ShipMenu } from './ShipMenu.js';
import { CrewLevelMenu } from './CrewLevelMenu.js';
import { RespawnScreen } from './RespawnScreen.js';
import { WorldMapScreen } from './WorldMapScreen.js';
import { TombstoneMenu } from './TombstoneMenu.js';
import { SalvageMenu } from './SalvageMenu.js';

/**
 * UI render context
 */
export interface UIRenderContext {
  worldState: WorldState;
  camera: Camera;
  fps: number;
  /** Last frame duration in milliseconds. */
  frameMs?: number;
  /** GL draw calls in the most recent frame (0 when GL is disabled). */
  glDrawCalls?: number;
  /** Current GL internal scale percent (e.g. 40 for 40%). */
  glScalePct?: number;
  networkStats: NetworkStats;
  config: ClientConfig;
  assignedPlayerId?: number | null;
  playerShipId?: number; // 0 or absent = not on a ship
  /** Currently selected ammo type: 0 = Cannonball, 1 = Bar Shot */
  selectedAmmoType?: number;   // loaded (in barrel right now)
  pendingAmmoType?: number;    // queued for next reload
  /** Current mount kind: 'none' | 'helm' | 'cannon' | 'mast' */
  mountKind?: string;
  /** Active weapon group on helm: 0–9, -1=none */
  activeWeaponGroup?: number;
  /** All currently selected weapon groups (multi-select). */
  activeWeaponGroups?: Set<number>;
  /** The ship the player is currently on (for cannon group counts). */
  playerShip?: Ship | null;
  /** User-defined weapon control groups — set while on helm. */
  controlGroups?: Map<number, WeaponGroupState>;
  /** Active ammo group on helm: 'cannon' (IDs 0-1) or 'swivel' (IDs 2-4). */
  activeAmmoGroup?: 'cannon' | 'swivel';
}

/**
 * UI element types
 */
export enum UIElementType {
  HUD = 'hud',
  DEBUG_OVERLAY = 'debug_overlay',
  NETWORK_STATS = 'network_stats',
  CONTROL_HINTS = 'control_hints'
}

/**
 * All menu identifiers — used to track which menu is currently open.
 * ClientApplication uses these same IDs for its own menus (crafting, shipyard, pause).
 */
export const MENU_ID = {
  COMPANY:   'company',
  PLAYER:    'player',
  SHIP:      'ship',
  CREW:      'crew',
  CRAFTING:  'crafting',
  SHIPYARD:  'shipyard',
  PAUSE:     'pause',
  CONSOLE:   'console',
  RESPAWN:   'respawn',
  MAP:       'map',
  SALVAGE:   'salvage',
} as const;
export type MenuId = typeof MENU_ID[keyof typeof MENU_ID];

/**
 * Base UI element interface
 */
interface UIElement {
  type: UIElementType;
  visible: boolean;
  render(ctx: CanvasRenderingContext2D, context: UIRenderContext): void;
}

/**
 * Main UI manager
 */
export class UIManager {
  private config: ClientConfig;
  private canvas: HTMLCanvasElement;
  
  // UI Elements
  private elements: Map<UIElementType, UIElement> = new Map();
  
  // Manning priority panel
  private manningPanel = new ManningPriorityPanel();

  // Company menu (toggled by [K])
  private companyMenu = new CompanyMenu();
  // Player character menu (toggled by [E] when menu is open)
  public readonly playerMenu = new PlayerMenu();
  // Ship status menu (toggled by [G])
  private shipMenu = new ShipMenu();
  // Shipwreck salvage menu (opened by pressing E on a wreck)
  public readonly salvageMenu = new SalvageMenu();
  // Crew level / upgrade panel (opened by clicking an NPC)
  private crewMenu = new CrewLevelMenu();

  // Respawn screen — shown on player death or first spawn
  private respawnScreen = new RespawnScreen();
  // Islands stored for the respawn screen minimap
  private _islands: import('../../sim/Types.js').IslandDef[] = [];

  // World map screen — toggleable with M
  private worldMapScreen = new WorldMapScreen();

  // Tombstone inventory menu
  public tombstoneMenu = new TombstoneMenu();

  /** Which menu is currently open — null when none. */
  private activeMenuId: MenuId | null = null;

  // UI State
  private showDebugOverlay = false;
  private showNetworkStats = false;
  private showControlHints = true;

  // White flash overlay (triggered on respawn)
  // _flashHolding=true  → fully opaque, waiting for server confirmation
  // _flashStartTime > 0 → fading out after server confirmed
  private _flashHolding = false;
  private _flashStartTime = 0;
  private static readonly _FLASH_MS = 3000;

  // Mouse screen position (updated each frame before render)
  private mouseX = 0;
  private mouseY = 0;

  // Explicit build mode (B key) overlay state
  private buildModeState: {
    active: boolean;
    selectedItem: 'cannon' | 'sail' | 'swivel';
    rotationDeg: number;
    sailCount: number;
    maxSails: number;
  } | null = null;

  // Island structure build mode overlay state
  private islandBuildState: {
    kind: 'wooden_floor' | 'workbench';
    tooFar: boolean;
    enemyClose: boolean;
  } | null = null;

  /** Called when the player clicks a build item button (cannon/sail/swivel). */
  public onBuildItemSelect: ((item: 'cannon' | 'sail' | 'swivel') => void) | null = null;
  /** Called when a weapon group has its mode cycled via right-click. */
  public onGroupModeChange: ((groupIndex: number, mode: WeaponGroupMode) => void) | null = null;
  /** Called when the player left-clicks a hotbar slot. */
  public onHotbarSlotClick: ((slot: number) => void) | null = null;
  /** Supplier for current player inventory — used for drag-and-drop in player menu. */
  public getPlayerInventory: (() => { slots: { item: ItemKind; quantity: number }[] } | null) | null = null;
  /** Cached from last render frame — used by handleRightClick for hotbar hit-testing. */
  private _cachedHelmActiveGroup: number = -1;
  private _cachedControlGroups: Map<number, WeaponGroupState> | null = null;

  // ── Ghost build menu state ─────────────────────────────────────────────────
  private buildMenuOpen = false;
  private buildMenuGhosts: GhostPlacement[] = [];
  private buildMenuPending: GhostModuleKind | null = null;
  /** Called when player clicks a module type in the left build panel. */
  public onBuildPanelSelect: ((kind: GhostModuleKind) => void) | null = null;

  // Entries shown in the left build panel
  private static readonly BUILD_PANEL_ENTRIES: Array<{
    kind: GhostModuleKind; label: string; symbol: string; color: string; borderColor: string;
  }> = [
    { kind: 'cannon', label: 'Cannon',     symbol: '⚫', color: '#444',    borderColor: '#888'    },
    { kind: 'swivel', label: 'Swivel Gun', symbol: '›', color: '#7a4a2a', borderColor: '#4a2810' },
    { kind: 'mast',   label: 'Sail',       symbol: '⛵', color: '#1e8c6e', borderColor: '#0f5c48' },
    { kind: 'helm',   label: 'Helm',       symbol: 'W',  color: '#6a3d8f', borderColor: '#3d2060' },
    { kind: 'deck',   label: 'Deck',       symbol: '⊟', color: '#8b5e3c', borderColor: '#5c3a1c' },
  ];

  private static readonly BUILD_PANEL_W = 164;
  private static readonly BUILD_PANEL_ENTRY_H = 46;
  private static readonly BUILD_PANEL_HEADER_H = 32;

  // ── Hammer minigame state ──────────────────────────────────────────────────
  private hammerGame: {
    active:          boolean;
    startTime:       number;   // performance.now() when minigame began
    duration:        number;   // ms for cursor to travel full track
    sweetspotStart:  number;   // 0..1 — left edge of green zone
    sweetspotWidth:  number;   // 0..1 — width of green zone
    callback:        ((won: boolean) => void) | null;
    resultTime:      number;   // performance.now() when player struck; -1 = not yet
    won:             boolean | null;
  } = {
    active: false, startTime: 0, duration: 1250,
    sweetspotStart: 0, sweetspotWidth: 0,
    callback: null, resultTime: -1, won: null,
  };

  // ── Drop item picker (hold-E near pile) ───────────────────────────────────
  private _dropPicker: {
    open: boolean;
    items: DroppedItem[];
    scrollY: number;
  } = { open: false, items: [], scrollY: 0 };

  /** Called when the player confirms a pickup from the drop picker. */
  public onDropPickerPick: ((itemId: number) => void) | null = null;

  /** Open the drop-item picker overlay. */
  openDropPicker(items: DroppedItem[]): void {
    this._dropPicker = { open: true, items, scrollY: 0 };
  }

  /** Close the drop-item picker overlay. */
  closeDropPicker(): void {
    this._dropPicker.open = false;
  }

  get isDropPickerOpen(): boolean { return this._dropPicker.open; }
  
  constructor(canvas: HTMLCanvasElement, config: ClientConfig) {
    this.config = config;
    this.canvas = canvas;
    
    this.initializeUIElements();
    this.setupEventListeners();
  }
  
  /**
   * Start the hammer repair minigame.
   * callback receives true if the player hits the green zone, false otherwise.
   * A second call while the game is active is silently ignored.
   */
  startHammerMinigame(callback: (won: boolean) => void): void {
    if (this.hammerGame.active) return;
    this.hammerGame = {
      active: true,
      startTime: performance.now(),
      duration: 1250,
      // Random zone in the middle 55% of the track so it's challenging but fair
      sweetspotStart: 0.20 + Math.random() * 0.50,
      sweetspotWidth: 0.16,
      callback,
      resultTime: -1,
      won: null,
    };
  }

  /** Returns which menu is currently open, or null. */
  getActiveMenuId(): MenuId | null {
    return this.activeMenuId;
  }

  /** Returns true if any canvas-side menu/modal is currently open. */
  isAnyMenuOpen(): boolean {
    return this.activeMenuId !== null || this.respawnScreen.visible || this.worldMapScreen.visible;
  }

  /**
   * Open one of the UIManager-owned menus by ID, closing any currently open menu first.
   * For menus owned by ClientApplication (crafting, shipyard, pause), call this to keep
   * activeMenuId in sync — pass the id and handle open/close yourself.
   */
  openMenu(id: MenuId): void {
    this.closeActiveMenu();
    this.activeMenuId = id;
    switch (id) {
      case MENU_ID.COMPANY: this.companyMenu.open(); break;
      case MENU_ID.PLAYER:  this.playerMenu.open();  break;
      case MENU_ID.SHIP:    this.shipMenu.open();     break;
      case MENU_ID.CREW:    /* opened externally via openCrewMenu() */ break;
      case MENU_ID.SALVAGE: /* opened externally with salvageMenu.open(wreckId, count) */ break;
      // CRAFTING / SHIPYARD / PAUSE are owned by ClientApplication — ID is set here,
      // but the actual DOM/canvas open call happens in ClientApplication.
    }
  }

  /** Close whichever UIManager-owned menu is active and clear the tracked ID. */
  closeActiveMenu(): void {
    switch (this.activeMenuId) {
      case MENU_ID.COMPANY: this.companyMenu.close(); break;
      case MENU_ID.PLAYER:  this.playerMenu.close();  break;
      case MENU_ID.SHIP:    this.shipMenu.close();     break;
      case MENU_ID.CREW:    this.crewMenu.close();     break;
      case MENU_ID.SALVAGE: this.salvageMenu.close();  break;
    }
    this.activeMenuId = null;
  }

  /** Notify UIManager that an externally-owned menu (crafting/shipyard/pause) was opened. */
  setActiveMenuId(id: MenuId | null): void {
    this.activeMenuId = id;
  }

  /** Open the respawn screen. Pass the current world ships, islands, local company ID, and death position. */
  openRespawnScreen(ships: import('../../sim/Types.js').Ship[], islands: import('../../sim/Types.js').IslandDef[], localCompanyId: number, deathPos?: { x: number; y: number }): void {
    this._islands = islands;
    this.respawnScreen.open(ships, islands, localCompanyId, deathPos);
  }

  /** Close the respawn screen (called after the server confirms respawn). */
  closeRespawnScreen(): void {
    this.respawnScreen.close();
  }

  /** Hold screen at full white until releaseWhiteFlash() is called. */
  triggerWhiteFlash(): void {
    this._flashHolding = true;
    this._flashStartTime = 0;
  }

  /** Start fading the white flash out (call once server confirms new position). */
  releaseWhiteFlash(): void {
    if (!this._flashHolding && this._flashStartTime === 0) return; // not active
    this._flashHolding = false;
    this._flashStartTime = Date.now();
  }

  /** True while the respawn screen is showing. */
  isRespawnScreenVisible(): boolean {
    return this.respawnScreen.visible;
  }

  /** Set the callback that fires when the player confirms a respawn location. */
  setRespawnConfirmedCallback(cb: (shipId?: number, worldX?: number, worldY?: number, islandId?: number, spawnX?: number, spawnY?: number) => void): void {
    this.respawnScreen.onRespawnConfirmed = cb;
  }

  /** Store island definitions so the respawn screen minimap can draw them. */
  setIslandsForRespawn(islands: import('../../sim/Types.js').IslandDef[]): void {
    this._islands = islands;
  }

  // ── World map ──────────────────────────────────────────────────────────────

  /** Open the world map screen, optionally centring on the local player's position. */
  openWorldMap(localPlayerPos?: { x: number; y: number }): void {
    this.worldMapScreen.open(localPlayerPos);
  }

  /** Close the world map. */
  closeWorldMap(): void {
    this.worldMapScreen.close();
  }

  /** True while the world map is showing. */
  isWorldMapVisible(): boolean {
    return this.worldMapScreen.visible;
  }

  /** Toggle the world map open/closed. */
  toggleWorldMap(localPlayerPos?: { x: number; y: number }): void {
    if (this.worldMapScreen.visible) this.worldMapScreen.close();
    else this.worldMapScreen.open(localPlayerPos);
  }

  /** Forward a mouse-down event to the world map (for drag-pan and close-button). */
  handleWorldMapMouseDown(x: number, y: number): boolean {
    return this.worldMapScreen.handleMouseDown(x, y);
  }

  /** Forward mouse-move to the world map or respawn screen for drag-pan. */
  handleWorldMapMouseMove(x: number, y: number): void {
    if (this.tombstoneMenu.visible) this.tombstoneMenu.handleMouseMove(x, y);
    if (this.activeMenuId === MENU_ID.PLAYER) this.playerMenu.handleMouseMove(x, y);
    if (this.salvageMenu.visible) this.salvageMenu.handleMouseMove(x, y);
    if (this.respawnScreen.visible) this.respawnScreen.handleMouseMove(x, y);
    this.manningPanel.handleMouseMove(x, y);
    this.worldMapScreen.handleMouseMove(x, y);
  }

  /** Notify world map / respawn screen of mouse-up to end drag. */
  handleWorldMapMouseUp(x = 0, y = 0): void {
    if (this.tombstoneMenu.visible) this.tombstoneMenu.handleMouseUp(x, y);
    if (this.activeMenuId === MENU_ID.PLAYER) this.playerMenu.handleMouseUp(x, y);
    if (this.respawnScreen.visible) this.respawnScreen.handleMouseUp();
    this.manningPanel.handleMouseUp();
    this.worldMapScreen.handleMouseUp();
  }

  /** Forward wheel delta to the respawn screen or world map for zoom. Returns true if consumed. */
  handleWorldMapWheel(deltaY: number, x: number, y: number): boolean {
    if (this._dropPicker.open) return this.handleDropPickerWheel(deltaY);
    if (this.tombstoneMenu.visible) return this.tombstoneMenu.handleWheel(x, y, deltaY);
    if (this.respawnScreen.visible) return this.respawnScreen.handleWheel(deltaY, x, y);
    if (this.activeMenuId === MENU_ID.PLAYER) return this.playerMenu.handleWheel(deltaY, x, y);
    return this.worldMapScreen.handleWheel(deltaY, x, y);
  }

  /**
   * Route a keydown event.  Returns true if the minigame consumed the key.
   * Call this from the application keydown handler before processing game input.
   */
  handleKeyDown(key: string): boolean {
    // Company menu key routing is handled exclusively by onKeyDown (the window listener)
    // to avoid double-processing. Only handle non-company-menu cases here.
    if (key === 'Escape' && this._dropPicker.open) {
      this._dropPicker.open = false;
      return true;
    }
    if (key === 'Escape' && this.tombstoneMenu.visible) {
      this.tombstoneMenu.close();
      return true;
    }
    if (!this.hammerGame.active) return false;
    if (key === ' ' || key === 'Enter') {
      if (this.hammerGame.resultTime === -1) this.strikeHammer();
      return true;
    }
    return false;
  }

  /**
   * Update UI manager
   */
  update(_deltaTime: number): void {
    // Update any animated UI elements
    // For now, most UI is static
    
    // Update visibility based on config
    this.showDebugOverlay = this.config.debug.enabled;
    this.showNetworkStats = this.config.debug.showNetworkStats;
  }
  
  /**
   * Render all UI elements
   */
  /**
   * Handle a right-click: if the cursor is over a weapon group hotbar slot while on helm,
   * cycles that group’s mode and returns true to consume the click.
   */
  handleRightClick(x: number, y: number): boolean {
    if (!this._cachedControlGroups) return false;
    const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
    const totalW = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((this.canvas.width - totalW) / 2);
    const startY = this.canvas.height - totalH - 8;
    if (y < startY || y > startY + PADDING + SLOT_SIZE) return false;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      if (x >= sx && x <= sx + SLOT_SIZE) {
        const groupIdx = (i + 1) % 10; // slot 0→G1, …, slot 8→G9, slot 9→G0
        const state = this._cachedControlGroups.get(groupIdx);
        if (!state) return false;
        const CYCLE: WeaponGroupMode[] = ['aiming', 'freefire', 'haltfire', 'targetfire'];
        const next = CYCLE[(CYCLE.indexOf(state.mode) + 1) % CYCLE.length];
        if (this.onGroupModeChange) this.onGroupModeChange(groupIdx, next);
        return true;
      }
    }
    return false;
  }

  render(ctx: CanvasRenderingContext2D, context: UIRenderContext): void {
    // Cache helm state so handleRightClick can do hotbar hit-testing
    if (context.mountKind === 'helm' && context.controlGroups) {
      this._cachedHelmActiveGroup = context.activeWeaponGroup ?? -1;
      this._cachedControlGroups = context.controlGroups;
    } else {
      this._cachedControlGroups = null;
    }

    // Render elements in order
    const renderOrder: UIElementType[] = [
      UIElementType.HUD,
      UIElementType.NETWORK_STATS,
      UIElementType.DEBUG_OVERLAY
    ];
    
    for (const elementType of renderOrder) {
      const element = this.elements.get(elementType);
      if (element && element.visible) {
        try {
          element.render(ctx, context);
        } catch (error) {
          console.error(`Error rendering UI element ${elementType}:`, error);
        }
      }
    }
    
    // Render manning priority panel (always on top, left side)
    const shipId = context.playerShipId ?? 0;
    const _localPlayer = context.worldState.players.find(p => p.id === context.assignedPlayerId);
    const _localCompanyId = _localPlayer?.companyId ?? 0;
    this.manningPanel.render(ctx, context.worldState.npcs ?? [], shipId, _localCompanyId);
    

    // Ammo selector widget
    if (context.mountKind === 'cannon') {
      this.renderAmmoSelector(ctx, context.selectedAmmoType ?? 0, context.pendingAmmoType ?? context.selectedAmmoType ?? 0);
    } else if (context.mountKind === 'helm') {
      // Combined cannon+swivel row with [U] group switching
      this.renderHelmCombinedAmmoSelector(
        ctx,
        context.selectedAmmoType ?? 0,
        context.pendingAmmoType ?? context.selectedAmmoType ?? 0,
        context.activeAmmoGroup ?? 'cannon'
      );
    }

    // Swivel ammo selector — three types, shown when mounted to a swivel
    if (context.mountKind === 'swivel') {
      this.renderSwivelAmmoSelector(ctx, context.selectedAmmoType ?? 2, context.pendingAmmoType ?? context.selectedAmmoType ?? 2);
    }

    // Company menu renders last so it sits above all other UI
    this.companyMenu.render(ctx, context.worldState, context.assignedPlayerId);
    this.playerMenu.render(ctx, context.worldState, context.assignedPlayerId, this.mouseX, this.mouseY);
    this.shipMenu.render(ctx, context.worldState, context.assignedPlayerId);
    this.salvageMenu.render(ctx, ctx.canvas.width, ctx.canvas.height);
    // Crew level menu — update live NPC data before rendering
    if (this.activeMenuId === MENU_ID.CREW && this.crewMenu.npcId) {
      const liveNpc = context.worldState.npcs.find(n => n.id === this.crewMenu.npcId);
      if (liveNpc) this.crewMenu.update(liveNpc);
    }
    this.crewMenu.render(ctx, ctx.canvas);

    // Explicit build mode overlay (renders on top of everything, including menus)
    if (this.buildModeState?.active) {
      this.renderBuildModeOverlay(ctx, ctx.canvas);
    }

    // Island structure build mode overlay
    if (this.islandBuildState) {
      this.renderIslandBuildOverlay(ctx, ctx.canvas);
    }

    // Ghost build menu panel — left side of screen
    if (this.buildMenuOpen) {
      this.renderBuildMenuPanel(ctx, ctx.canvas);
    }

    // Hammer minigame — topmost overlay, blocks all game input when active
    if (this.hammerGame.active) {
      this.renderHammerMinigame(ctx, ctx.canvas);
    }

    // World map — below respawn screen so respawn screen still covers it
    if (this.worldMapScreen.visible) {
      const ws = context.worldState;
      const localPlayer = ws.players.find(p => p.id === context.assignedPlayerId);
      const companyId = localPlayer?.companyId ?? 0;
      this.worldMapScreen.render(ctx, ws.ships, this._islands, ws.players, context.assignedPlayerId, companyId);
    }

    // Respawn screen — rendered last so it covers everything
    if (this.respawnScreen.visible) {
      const ws = context.worldState;
      const localPlayer = ws.players.find(p => p.id === context.assignedPlayerId);
      const companyId = localPlayer?.companyId ?? 0;
      this.respawnScreen.render(ctx, ws.ships, this._islands, companyId);
    }

    // Drop picker — topmost overlay
    if (this._dropPicker.open) {
      this._renderDropPicker(ctx);
    }

    // Tombstone menu — rendered above everything else
    if (this.tombstoneMenu.visible) {
      this.tombstoneMenu.render(ctx);
    }

    // White flash — very topmost, fades out after respawn
    if (this._flashHolding) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
    } else if (this._flashStartTime > 0) {
      const elapsed = Date.now() - this._flashStartTime;
      const t = Math.min(1, elapsed / UIManager._FLASH_MS);
      // Fast-in slow-out: start opaque, decelerate as it fades (ease-out quad)
      const alpha = Math.max(0, (1 - t) * (1 - t));
      if (alpha > 0) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
      } else {
        this._flashStartTime = 0;
      }
    }
  }
  

  /**
   * Helm combined ammo selector — bottom-left corner.
   * Shows all 5 ammo types in one row: [CANNONBALL][BAR SHOT] | [GRAPESHOT][LIQ.FLAME][CANISTER]
   * Active group is fully opaque; inactive group is dimmed.
   * [U] toggles between cannon/swivel group;  [X] cycles within the active group.
   */
  private renderHelmCombinedAmmoSelector(
    ctx: CanvasRenderingContext2D,
    loadedAmmoType: number,
    pendingAmmoType: number,
    activeGroup: 'cannon' | 'swivel'
  ): void {
    ctx.save();

    // Normalise client UI IDs (10/11/12) → internal swivel IDs (2/3/4)
    const normSwivel = (id: number) => id === 10 ? 2 : id === 11 ? 3 : id === 12 ? 4 : id;
    loadedAmmoType  = normSwivel(loadedAmmoType);
    pendingAmmoType = normSwivel(pendingAmmoType);

    const slotW  = 68;
    const slotH  = 48;
    const margin = 3;
    const divW   = 12;   // gap for the | divider
    const x0     = 12;
    const y0     = ctx.canvas.height - slotH - 12;
    const pad    = 4;

    const cannonAmmos: { id: number; name: string; icon: string; color: string }[] = [
      { id: 0, name: 'CANNONBALL', icon: '●',   color: '#c0c0a0' },
      { id: 1, name: 'BAR SHOT',   icon: '◉━◉', color: '#ff7733' },
    ];
    const swivelAmmos: { id: number; name: string; icon: string; color: string; desc: string }[] = [
      { id: 2, name: 'GRAPESHOT',  icon: '∷', color: '#c8c8b0', desc: 'crew dmg'  },
      { id: 3, name: 'LIQ. FLAME', icon: '≈', color: '#ff8832', desc: 'fire dmg'  },
      { id: 4, name: 'CANISTER',   icon: '⊠', color: '#90d890', desc: 'spread'    },
    ];

    const switchPending = pendingAmmoType !== loadedAmmoType;

    const renderSlot = (
      slotX: number,
      ammo: { id: number; name: string; icon: string; color: string; desc?: string },
      groupActive: boolean
    ) => {
      const isLoaded  = ammo.id === loadedAmmoType;
      const isPending = ammo.id === pendingAmmoType && switchPending;

      let bgColor: string;
      let borderColor: string;
      let borderWidth: number;
      let textColor: string;
      let iconColor: string;
      let dotColor: string | null = null;

      if (isLoaded) {
        bgColor     = 'rgba(50,220,80,0.20)';
        borderColor = '#44dd66';
        borderWidth = 2;
        iconColor   = ammo.color;
        textColor   = '#ccffcc';
        dotColor    = '#44dd66';
      } else if (isPending) {
        bgColor     = 'rgba(255,200,50,0.18)';
        borderColor = '#ffd700';
        borderWidth = 2;
        iconColor   = ammo.color;
        textColor   = '#fffccc';
        dotColor    = '#ffd700';
      } else {
        bgColor     = 'rgba(0,0,0,0.55)';
        borderColor = '#445';
        borderWidth = 1;
        iconColor   = '#556';
        textColor   = '#668';
      }

      const alpha = groupActive ? 1.0 : 0.35;
      ctx.globalAlpha = alpha;

      ctx.fillStyle   = bgColor;
      ctx.fillRect(slotX, y0, slotW, slotH);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth   = borderWidth;
      ctx.strokeRect(slotX, y0, slotW, slotH);

      // Icon
      ctx.font         = '11px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = iconColor;
      ctx.fillText(ammo.icon, slotX + pad + 1, y0 + slotH / 2 - 4);

      // Name
      ctx.font      = (isLoaded || isPending) ? 'bold 8px Georgia, serif' : '8px Georgia, serif';
      ctx.fillStyle = textColor;
      ctx.fillText(ammo.name, slotX + pad + 1, y0 + slotH / 2 + 5);

      // Desc (swivel only)
      if (ammo.desc) {
        ctx.font      = '6px Georgia, serif';
        ctx.fillStyle = (isLoaded || isPending) ? 'rgba(160,200,160,0.65)' : 'rgba(90,100,100,0.50)';
        ctx.fillText(ammo.desc, slotX + pad + 1, y0 + slotH / 2 + 13);
      }

      // Dot indicator
      if (dotColor) {
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(slotX + slotW - 7, y0 + 7, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1.0;
    };

    // --- Cannon slots ---
    for (let i = 0; i < cannonAmmos.length; i++) {
      renderSlot(x0 + i * (slotW + margin), cannonAmmos[i], activeGroup === 'cannon');
    }

    // --- Divider ---
    const divX = x0 + cannonAmmos.length * (slotW + margin);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = 'rgba(160,160,200,0.70)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(divX + divW / 2, y0 + 5);
    ctx.lineTo(divX + divW / 2, y0 + slotH - 5);
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // --- Swivel slots ---
    const swivelStartX = divX + divW;
    for (let i = 0; i < swivelAmmos.length; i++) {
      renderSlot(swivelStartX + i * (slotW + margin), swivelAmmos[i], activeGroup === 'swivel');
    }

    // --- Group labels above each section ---
    ctx.font         = 'bold 6px Georgia, serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign    = 'center';

    const cannonCx = x0 + (cannonAmmos.length * slotW + (cannonAmmos.length - 1) * margin) / 2;
    ctx.globalAlpha = activeGroup === 'cannon' ? 0.85 : 0.38;
    ctx.fillStyle   = '#c8d8c8';
    ctx.fillText('CANNON', cannonCx, y0 - 3);

    const swivelCx = swivelStartX + (swivelAmmos.length * slotW + (swivelAmmos.length - 1) * margin) / 2;
    ctx.globalAlpha = activeGroup === 'swivel' ? 0.85 : 0.38;
    ctx.fillStyle   = '#c8d8c8';
    ctx.fillText('SWIVEL', swivelCx, y0 - 3);

    ctx.globalAlpha = 1.0;

    // --- Hint row ---
    ctx.font         = '9px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = 'rgba(120,120,140,0.70)';
    ctx.fillText('[U] switch group  |  [X] cycle  |  hold X (0.5s) → force reload', x0 + 2, y0 + slotH + 3);

    ctx.restore();
  }

  /**
   * Ammo selector widget — bottom-left corner.
   * Shows two slots: Cannonball and Bar Shot, with the active one highlighted.
   */
  private renderAmmoSelector(ctx: CanvasRenderingContext2D, loadedAmmoType: number, pendingAmmoType: number): void {
    ctx.save();

    const ammoTypes = [
      { name: 'CANNONBALL', icon: '●',   color: '#c0c0a0' },
      { name: 'BAR SHOT',   icon: '◉━◉', color: '#ff7733' },
    ];

    const slotW  = 110;
    const slotH  = 46;
    const pad    = 6;
    const margin = 6;
    const x0     = 12;
    const y0     = ctx.canvas.height - slotH - 12;

    // If pending == loaded, only one slot needs highlighting (yellow/gold)
    const switchPending = pendingAmmoType !== loadedAmmoType;

    for (let i = 0; i < ammoTypes.length; i++) {
      const ammo    = ammoTypes[i];
      const isLoaded  = i === loadedAmmoType;
      const isPending = i === pendingAmmoType;
      const sx      = x0 + i * (slotW + margin);

      // Determine highlight state
      // loaded → green;  pending (different from loaded) → yellow;  inactive → dim
      let bgColor: string;
      let borderColor: string;
      let borderWidth: number;
      let textColor: string;
      let iconColor: string;
      let dotColor: string | null = null;

      if (isLoaded && !switchPending) {
        // No pending switch — loaded slot is green (active/ready)
        bgColor     = 'rgba(50,220,80,0.18)';
        borderColor = '#44dd66';
        borderWidth = 2;
        iconColor   = ammo.color;
        textColor   = '#ccffcc';
        dotColor    = '#44dd66';
      } else if (isLoaded) {
        // Loaded but a different ammo is queued — show green
        bgColor     = 'rgba(50,220,80,0.18)';
        borderColor = '#44dd66';
        borderWidth = 2;
        iconColor   = ammo.color;
        textColor   = '#ccffcc';
        dotColor    = '#44dd66';
      } else if (isPending) {
        // Pending/queued ammo — yellow
        bgColor     = 'rgba(255,200,50,0.18)';
        borderColor = '#ffd700';
        borderWidth = 2;
        iconColor   = ammo.color;
        textColor   = '#fff';
        dotColor    = '#ffd700';
      } else {
        // Inactive
        bgColor     = 'rgba(0,0,0,0.55)';
        borderColor = '#445';
        borderWidth = 1;
        iconColor   = '#556';
        textColor   = '#668';
      }

      // Background
      ctx.fillStyle = bgColor;
      ctx.fillRect(sx, y0, slotW, slotH);

      // Border
      ctx.strokeStyle = borderColor;
      ctx.lineWidth   = borderWidth;
      ctx.strokeRect(sx, y0, slotW, slotH);

      // Icon
      ctx.font         = '18px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = iconColor;
      ctx.fillText(ammo.icon, sx + pad + 2, y0 + slotH / 2 - 4);

      // Name
      const highlighted = isLoaded || isPending;
      ctx.font      = highlighted ? 'bold 11px Georgia, serif' : '11px Georgia, serif';
      ctx.fillStyle = textColor;
      ctx.fillText(ammo.name, sx + pad + 2, y0 + slotH / 2 + 10);

      // Small label: LOADED / NEXT
      if (isLoaded && switchPending) {
        ctx.font      = '9px Georgia, serif';
        ctx.fillStyle = '#44dd66';
        ctx.textAlign = 'right';
        ctx.fillText('LOADED', sx + slotW - 5, y0 + slotH - 6);
        ctx.textAlign = 'left';
      } else if (isPending && switchPending) {
        ctx.font      = '9px Georgia, serif';
        ctx.fillStyle = '#ffd700';
        ctx.textAlign = 'right';
        ctx.fillText('NEXT', sx + slotW - 5, y0 + slotH - 6);
        ctx.textAlign = 'left';
      }

      // Indicator dot
      if (dotColor) {
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(sx + slotW - 10, y0 + 10, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // [X] key hint below the slots
    ctx.font         = '10px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = 'rgba(120,120,140,0.7)';
    const hint = switchPending ? '[X] cycle  |  hold X (0.5s) → force reload' : '[X] cycle ammo  |  hold X (0.5s) → force swap';
    ctx.fillText(hint, x0 + 2, y0 + slotH + 3);

    ctx.restore();
  }

  /**
   * Swivel gun ammo selector widget — bottom-left corner.
   * Shows three slots: Grapeshot, Liquid Flame, Canister Shot.
   * Ammo IDs: 2 = GRAPESHOT, 3 = LIQUID FLAME, 4 = CANISTER SHOT
   */
  private renderSwivelAmmoSelector(ctx: CanvasRenderingContext2D, loadedAmmoType: number, pendingAmmoType: number): void {
    ctx.save();

    // Normalise client UI IDs (10/11/12) → internal swivel IDs (2/3/4)
    const normSwivel = (id: number) => id === 10 ? 2 : id === 11 ? 3 : id === 12 ? 4 : id;
    const validIds = [2, 3, 4];
    const safeLoaded  = validIds.includes(normSwivel(loadedAmmoType))  ? normSwivel(loadedAmmoType)  : 2;
    const safePending = validIds.includes(normSwivel(pendingAmmoType)) ? normSwivel(pendingAmmoType) : safeLoaded;

    const ammoTypes = [
      { id: 2, name: 'GRAPESHOT',  icon: '∷', color: '#c8c8b0', desc: 'crew damage'  },
      { id: 3, name: 'LIQ. FLAME', icon: '≈',  color: '#ff8832', desc: 'fire damage'  },
      { id: 4, name: 'CANISTER',   icon: '⊠',  color: '#90d890', desc: 'wide spread'  },
    ];

    const slotW  = 96;
    const slotH  = 52;
    const margin = 5;
    const pad    = 6;
    const x0     = 12;
    const y0     = ctx.canvas.height - slotH - 14;

    const switchPending = safePending !== safeLoaded;

    // Header label
    ctx.font         = 'bold 9px Georgia, serif';
    ctx.fillStyle    = 'rgba(200,160,80,0.80)';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('⚫ SWIVEL AMMO', x0, y0 - 4);

    for (let i = 0; i < ammoTypes.length; i++) {
      const ammo      = ammoTypes[i];
      const isLoaded  = ammo.id === safeLoaded;
      const isPending = ammo.id === safePending;
      const sx        = x0 + i * (slotW + margin);

      let bgColor: string;
      let borderColor: string;
      let borderWidth: number;
      let textColor: string;
      let iconColor: string;
      let dotColor: string | null = null;

      if (isLoaded) {
        bgColor     = 'rgba(50,220,80,0.18)';
        borderColor = '#44dd66';
        borderWidth = 2;
        iconColor   = ammo.color;
        textColor   = '#ccffcc';
        dotColor    = '#44dd66';
      } else if (isPending) {
        bgColor     = 'rgba(255,200,50,0.18)';
        borderColor = '#ffd700';
        borderWidth = 2;
        iconColor   = ammo.color;
        textColor   = '#fffccc';
        dotColor    = '#ffd700';
      } else {
        bgColor     = 'rgba(0,0,0,0.55)';
        borderColor = '#445';
        borderWidth = 1;
        iconColor   = '#556';
        textColor   = '#668';
      }

      // Background
      ctx.fillStyle = bgColor;
      ctx.fillRect(sx, y0, slotW, slotH);

      // Border
      ctx.strokeStyle = borderColor;
      ctx.lineWidth   = borderWidth;
      ctx.strokeRect(sx, y0, slotW, slotH);

      // Icon
      ctx.font         = '17px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = iconColor;
      ctx.fillText(ammo.icon, sx + pad, y0 + slotH / 2 - 8);

      // Name
      ctx.font         = (isLoaded || isPending) ? 'bold 10px Georgia, serif' : '10px Georgia, serif';
      ctx.fillStyle    = textColor;
      ctx.textBaseline = 'middle';
      ctx.fillText(ammo.name, sx + pad, y0 + slotH / 2 + 5);

      // Desc line
      ctx.font      = '8px Georgia, serif';
      ctx.fillStyle = (isLoaded || isPending) ? 'rgba(180,220,180,0.65)' : 'rgba(100,100,120,0.5)';
      ctx.fillText(ammo.desc, sx + pad, y0 + slotH / 2 + 17);

      // LOADED / NEXT sub-label
      if (isLoaded && switchPending) {
        ctx.font         = '8px Georgia, serif';
        ctx.fillStyle    = '#44dd66';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('LOADED', sx + slotW - 4, y0 + slotH - 3);
        ctx.textAlign = 'left';
      } else if (isPending && switchPending) {
        ctx.font         = '8px Georgia, serif';
        ctx.fillStyle    = '#ffd700';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('NEXT', sx + slotW - 4, y0 + slotH - 3);
        ctx.textAlign = 'left';
      }

      // Status indicator dot (top-right of slot)
      if (dotColor) {
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(sx + slotW - 9, y0 + 9, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Key hint below the slots
    ctx.font         = '10px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = 'rgba(120,120,140,0.7)';
    const hint = switchPending
      ? '[X] cycle  |  hold X (0.5s) → force load'
      : '[X] cycle ammo  |  hold X (0.5s) → force swap';
    ctx.fillText(hint, x0 + 2, y0 + slotH + 3);

    ctx.restore();
  }

  /**
   * Set callback for crew assignment changes from the manning priority panel.
   * The callback receives the player's ship ID and the full assignment list.
   */
  setCrewAssignmentCallback(
    cb: (shipId: number, assignments: Array<{ npcId: number; task: string }>) => void
  ): void {
    this.manningPanel.onAssignmentChanged = cb;
  }

  /**
   * Set callback for ship attribute upgrades from the ship status menu.
   * Called when the player clicks an affordable \u2191 UPGRADE button.
   */
  setShipUpgradeCallback(
    cb: (shipId: number, attribute: string) => void
  ): void {
    this.shipMenu.onUpgradeRequest = cb;
  }

  /** Set callback for the "Unclaim Ship" action from the ship settings panel. */
  setShipUnclaimCallback(cb: (shipId: number) => void): void {
    this.shipMenu.onUnclaimShip = cb;
  }

  /** Set callback for the "Claim Ship" action from the ship settings panel. */
  setShipClaimCallback(cb: (shipId: number) => void): void {
    this.shipMenu.onClaimShip = cb;
  }

  /** Set callback for the "Rename Ship" button in the ship settings panel.
   *  Receives the shipId and current name so a dialog can pre-fill the field. */
  setShipRenameRequestCallback(cb: (shipId: number, currentName: string) => void): void {
    this.shipMenu.onRenameRequest = cb;
  }

  /** Set callback for the Leave Company button in the company menu. */
  setLeaveCompanyCallback(cb: () => void): void {
    this.companyMenu.onLeaveCompany = cb;
  }

  /** Set callback for the Join Company buttons in the company menu. */
  setJoinCompanyCallback(cb: (companyId: number) => void): void {
    this.companyMenu.onJoinCompany = cb;
  }

  /** Set callback for the Create Company button in the company menu. */
  setCreateCompanyCallback(cb: (name: string) => void): void {
    this.companyMenu.onCreateCompany = cb;
  }

  /**
   * Set callback for NPC stat upgrades from the crew level menu.
   * Called when the player clicks an affordable upgrade button.
   */
  setCrewUpgradeCallback(
    cb: (npcId: number, stat: string) => void
  ): void {
    this.crewMenu.onUpgradeRequest = cb;
    // Also wire ShipMenu NPC rows → open crew menu
    this.shipMenu.onNpcClick = (npc) => {
      this.crewMenu.open(npc);
      this.activeMenuId = MENU_ID.CREW;
    };
  }

  /**
   * Set callback for player stat upgrades from the player character menu.
   * Called when the player clicks an affordable upgrade button in the character tab.
   */
  setPlayerUpgradeCallback(
    cb: (stat: string) => void
  ): void {
    this.playerMenu.onUpgradeRequest = cb;
  }

  /**
   * Open the crew level menu for a specific NPC (e.g. from a world click).
   */
  openCrewMenuForNpc(npc: Npc): void {
    this.crewMenu.open(npc);
    this.activeMenuId = MENU_ID.CREW;
  }

  /**
   * Update explicit build mode state (called by ClientApplication each frame / on change).
   * Pass null to hide the build mode overlay.
   */
  setBuildModeState(state: {
    active: boolean;
    selectedItem: 'cannon' | 'sail' | 'swivel';
    rotationDeg: number;
    sailCount: number;
    maxSails: number;
  } | null): void {
    this.buildModeState = state;
  }

  /**
   * Set island structure placement build mode state.
   * Pass null to hide the overlay.
   */
  setIslandBuildState(state: {
    kind: 'wooden_floor' | 'workbench';
    tooFar: boolean;
    enemyClose: boolean;
  } | null): void {
    this.islandBuildState = state;
  }

  /**
   * Update ghost build menu state (called by ClientApplication on each change).
   */
  setBuildMenuState(
    open: boolean,
    ghosts: GhostPlacement[],
    pending: GhostModuleKind | null
  ): void {
    this.buildMenuOpen = open;
    this.buildMenuGhosts = ghosts;
    this.buildMenuPending = pending;
  }

  /**
   * Handle a canvas click — returns true if the UI consumed it.
   */
  /** Update the current screen-space mouse position so tooltips can be drawn. */
  setMousePos(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
    const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (hud) { hud.mouseX = x; hud.mouseY = y; }
  }

  handleClick(x: number, y: number): boolean {
    // Tombstone menu takes highest priority
    if (this.tombstoneMenu.visible) {
      return this.tombstoneMenu.handleMouseDown(x, y);
    }
    // Respawn screen takes absolute priority — blocks all game input
    if (this.respawnScreen.visible) {
      return this.respawnScreen.handleClick(x, y);
    }
    // World map consumes all clicks (mousedown starts drag or closes)
    if (this.worldMapScreen.visible) {
      return this.worldMapScreen.handleMouseDown(x, y);
    }
    // Hammer minigame swallows all clicks while active
    if (this.hammerGame.active) {
      if (this.hammerGame.resultTime === -1) this.strikeHammer();
      return true;
    }
    // Drop picker intercepts all clicks when open
    if (this._dropPicker.open) {
      return this.handleDropPickerClick(x, y);
    }
    // Build panel (left side) — check before other panels
    if (this.buildMenuOpen) {
      if (this.handleBuildPanelClick(x, y)) return true;
    }
    // Build mode item selection buttons (highest priority — always shown when in build mode)
    if (this.buildModeState?.active) {
      const consumed = this.handleBuildModeClick(x, y);
      if (consumed) return true;
    }
    // If company menu is open, try internal buttons first, then close on outside click.
    if (this.activeMenuId === MENU_ID.COMPANY) {
      if (this.companyMenu.handleClick(x, y)) return true;
      this.closeActiveMenu();
      return true;
    }
    if (this.activeMenuId === MENU_ID.PLAYER) {
      // Try to start a drag first
      const inv = this.getPlayerInventory?.() ?? null;
      if (inv && this.playerMenu.handleMouseDown(x, y, inv)) {
        return true; // drag started — don't process as a normal click
      }
      const consumed = this.playerMenu.handleClick(x, y);
      if (!consumed) this.closeActiveMenu();
      return true;
    }
    if (this.activeMenuId === MENU_ID.CREW) {
      const consumed = this.crewMenu.handleClick(x, y);
      if (!consumed) this.closeActiveMenu();
      return true;
    }
    if (this.activeMenuId === MENU_ID.SHIP) {
      // Forward to shipMenu — returns true if inside panel (upgrade click or panel area)
      const consumed = this.shipMenu.handleClick(x, y);
      if (!consumed) this.closeActiveMenu();
      return true;
    }
    // Hotbar left-click slot selection (only when no menu/build mode is consuming)
    if (this.onHotbarSlotClick && !this._cachedControlGroups) {
      const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
      const totalW = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
      const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
      const startX = Math.round((this.canvas.width - totalW) / 2);
      const startY = this.canvas.height - totalH - 8;
      if (y >= startY + PADDING && y <= startY + PADDING + SLOT_SIZE) {
        for (let i = 0; i < HOTBAR_SLOTS; i++) {
          const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
          if (x >= sx && x <= sx + SLOT_SIZE) {
            this.onHotbarSlotClick(i);
            return true;
          }
        }
      }
    }
    return this.manningPanel.handleMouseDown(x, y);
  }

  /** Returns the current npcId → task name map for colouring NPCs in the render system. */
  getNpcTaskMap(): ReadonlyMap<number, string> {
    return this.manningPanel.getTaskMap();
  }

  /**
   * Called when the local player boards a new ship.
   * Seeds the crew panel from the ship's authoritative NPC states and resets delta tracking.
   */
  syncCrewFromBoarding(npcs: Npc[], shipId: number, localCompanyId: number = 0): void {
    this.manningPanel.syncFromBoarding(npcs, shipId, localCompanyId);
  }

  // -----------------------------------------------------------------------
  // Build mode helpers
  // -----------------------------------------------------------------------

  /**
   * Handle a click on the left-side ghost build module panel.
   * Returns true if the click landed inside the panel.
   */
  private handleBuildPanelClick(x: number, y: number): boolean {
    const W = UIManager.BUILD_PANEL_W;
    const ENTRY_H = UIManager.BUILD_PANEL_ENTRY_H;
    const HEADER_H = UIManager.BUILD_PANEL_HEADER_H;
    const entries = UIManager.BUILD_PANEL_ENTRIES;
    const totalH = HEADER_H + entries.length * ENTRY_H + 8;
    const panelY = (this.canvas.height - totalH) / 2;

    if (x < 0 || x > W || y < panelY || y > panelY + totalH) return false;

    const relY = y - panelY - HEADER_H;
    if (relY < 0) return true; // clicked header area

    const idx = Math.floor(relY / ENTRY_H);
    if (idx >= 0 && idx < entries.length) {
      this.onBuildPanelSelect?.(entries[idx].kind);
    }
    return true;
  }

  /**
   * Test whether a click hits one of the build mode item buttons.
   * Returns true and fires the callback if so.
   * (Buttons removed — item type is determined by hotbar. Kept as stub so
   * handleClick can still check buildMode before other panels.)
   */
  private handleBuildModeClick(_x: number, _y: number): boolean {
    return false;
  }

  /**
   * Toggle debug overlay visibility
   */
  toggleDebugOverlay(): void {
    this.showDebugOverlay = !this.showDebugOverlay;
    const debugElement = this.elements.get(UIElementType.DEBUG_OVERLAY);
    if (debugElement) {
      debugElement.visible = this.showDebugOverlay;
    }
  }
  
  /**
   * Toggle network stats visibility
   */
  toggleNetworkStats(): void {
    this.showNetworkStats = !this.showNetworkStats;
    const networkElement = this.elements.get(UIElementType.NETWORK_STATS);
    if (networkElement) {
      networkElement.visible = this.showNetworkStats;
    }
  }
  
  /**
   * Handle canvas resize
   */
  onCanvasResize(width: number, height: number): void {
    // Update any UI elements that need to respond to canvas size changes
    console.log(`📱 UI canvas resized to ${width}x${height}`);
  }
  
  /**
   * Shutdown UI manager
   */
  shutdown(): void {
    this.removeEventListeners();
    console.log('🖥️ UI manager shutdown');
  }
  
  // Private methods

  // -----------------------------------------------------------------------
  // Build mode rendering (called only when explicitBuildMode active)
  // -----------------------------------------------------------------------

  private renderBuildModeOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (!this.buildModeState) return;
    const { selectedItem, rotationDeg, sailCount, maxSails } = this.buildModeState;

    ctx.save();

    // ================================================================
    // 1) TOP BANNER — amber, clearly not repair-mode (repair is teal/blue)
    //    Shows which item is selected (comes from hotbar, not a button).
    // ================================================================
    const BANNER_H = 48;
    const cw = canvas.width;

    const bannerGrad = ctx.createLinearGradient(0, 0, 0, BANNER_H);
    bannerGrad.addColorStop(0, '#c87800');
    bannerGrad.addColorStop(1, '#7a4800');
    ctx.fillStyle = bannerGrad;
    ctx.fillRect(0, 0, cw, BANNER_H);

    ctx.strokeStyle = '#ffcc44';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, BANNER_H);
    ctx.lineTo(cw, BANNER_H);
    ctx.stroke();

    const itemLabel = selectedItem === 'cannon'
      ? '🔫 CANNON'
      : selectedItem === 'swivel'
      ? '🔫 SWIVEL'
      : `⛵ SAIL (${sailCount}/${maxSails})`;
    ctx.font = 'bold 22px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff8e0';
    ctx.fillText(
      `⚒  BUILD MODE — ${itemLabel}  |  [B] Exit  |  [R] Rotate  |  [Click] Place`,
      cw / 2, BANNER_H / 2
    );

    // ================================================================
    // 2) ROTATION DIAL — above the hotbar, centered
    // ================================================================
    this.renderRotationDial(ctx, canvas, rotationDeg);

    ctx.restore();
  }

  /** Amber top banner shown when the player has a wooden_floor or workbench equipped. */
  private renderIslandBuildOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (!this.islandBuildState) return;
    const { kind, tooFar, enemyClose } = this.islandBuildState;

    ctx.save();

    const BANNER_H = 48;
    const cw = canvas.width;

    // Background — amber for normal, red-tint for warnings
    const topColor    = (tooFar || enemyClose) ? '#a83000' : '#c87800';
    const bottomColor = (tooFar || enemyClose) ? '#661800' : '#7a4800';
    const bannerGrad = ctx.createLinearGradient(0, 0, 0, BANNER_H);
    bannerGrad.addColorStop(0, topColor);
    bannerGrad.addColorStop(1, bottomColor);
    ctx.fillStyle = bannerGrad;
    ctx.fillRect(0, 0, cw, BANNER_H);

    // Bottom edge
    ctx.strokeStyle = (tooFar || enemyClose) ? '#ff7744' : '#ffcc44';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, BANNER_H);
    ctx.lineTo(cw, BANNER_H);
    ctx.stroke();

    // Item label
    const itemLabel = kind === 'wooden_floor' ? '\u229f WOODEN FLOOR' : '\u2692 WORKBENCH';

    // Status suffix
    let status = '';
    if (enemyClose) status = '  \u26a0\ufe0f ENEMY NEARBY — retreat to place';
    else if (tooFar) status = '  \u26a0\ufe0f TOO FAR — move closer';

    ctx.font = 'bold 20px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff8e0';
    ctx.fillText(
      `\u2301  BUILD MODE — ${itemLabel}  |  [Click] Place  |  [Esc / change slot] Cancel${status}`,
      cw / 2, BANNER_H / 2
    );

    ctx.restore();
  }

  /**
   * Render a horizontal compass-strip rotation dial above the hotbar.
   */
  private renderRotationDial(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, angleDeg: number): void {
    const SLOT_SIZE = 48;
    const SLOT_GAP  = 4;
    const PADDING   = 6;
    const LABEL_H   = 16;
    const DIAL_H    = 38;
    const DIAL_W    = 320;
    const MARGIN    = 6;
    const INVENTORY_SLOTS_COUNT = 10;
    const hotbarTotalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const hotbarStartY = canvas.height - hotbarTotalH - 8;
    const dialY = hotbarStartY - DIAL_H - MARGIN;
    const dialX = Math.round((canvas.width - DIAL_W) / 2);

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.80)';
    ctx.fillRect(dialX, dialY, DIAL_W, DIAL_H);
    ctx.strokeStyle = '#ffcc44';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(dialX, dialY, DIAL_W, DIAL_H);

    // Clip to dial area so tick marks don’t overflow
    ctx.beginPath();
    ctx.rect(dialX + 1, dialY + 1, DIAL_W - 2, DIAL_H - 2);
    ctx.clip();

    // The strip shows ±90° around the current angle
    const DEG_PER_PX = 180 / DIAL_W; // 180° visible across the full width
    const centerX = dialX + DIAL_W / 2;

    // Draw tick marks around the current angle (± 100° range)
    for (let dOff = -100; dOff <= 100; dOff++) {
      const tickDeg = (angleDeg + dOff + 360) % 360;
      const px = centerX + dOff / DEG_PER_PX;
      const is45  = tickDeg % 45 === 0;
      const is15  = tickDeg % 15 === 0;
      if (!is15) continue;
      const tickH = is45 ? 14 : 7;
      ctx.strokeStyle = is45 ? '#ffcc44' : '#887744';
      ctx.lineWidth = is45 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(px, dialY + DIAL_H - 4);
      ctx.lineTo(px, dialY + DIAL_H - 4 - tickH);
      ctx.stroke();
      if (is45) {
        ctx.fillStyle = '#ffcc44';
        ctx.font = '9px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${tickDeg}°`, px, dialY + DIAL_H - 4 - tickH - 1);
      }
    }

    ctx.restore();
    ctx.save();

    // Center pointer triangle (pointing DOWN from top)
    const triX = centerX;
    const triY = dialY + 2;
    ctx.fillStyle = '#ffcc44';
    ctx.beginPath();
    ctx.moveTo(triX - 6, triY);
    ctx.lineTo(triX + 6, triY);
    ctx.lineTo(triX, triY + 10);
    ctx.closePath();
    ctx.fill();

    // Current angle label (centered in dial)
    ctx.font = 'bold 15px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${Math.round(angleDeg)}°`, centerX, dialY + 3);

    ctx.restore();
  }

  /**
   * Render the left-side ghost build module panel.
   * Shows clickable entries for each buildable module type.
   * The currently-pending ghost kind is highlighted.
   * Ghost placements are shown as a count badge on each entry.
   */
  private renderBuildMenuPanel(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const W      = UIManager.BUILD_PANEL_W;
    const EH     = UIManager.BUILD_PANEL_ENTRY_H;
    const HH     = UIManager.BUILD_PANEL_HEADER_H;
    const PAD    = 10;
    const entries = UIManager.BUILD_PANEL_ENTRIES;
    const totalH = HH + entries.length * EH + 8;
    const px     = 0;
    const py     = Math.round((canvas.height - totalH) / 2);

    // ── Plan mode top banner (only when not also in explicit build mode) ──
    if (!this.buildModeState?.active) {
      const BANNER_H = 40;
      const cw = canvas.width;
      ctx.save();
      const bannerGrad = ctx.createLinearGradient(0, 0, 0, BANNER_H);
      bannerGrad.addColorStop(0, '#0a3d2e');
      bannerGrad.addColorStop(1, '#062618');
      ctx.fillStyle = bannerGrad;
      ctx.fillRect(0, 0, cw, BANNER_H);
      ctx.strokeStyle = '#33cc77';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, BANNER_H);
      ctx.lineTo(cw, BANNER_H);
      ctx.stroke();
      ctx.font = 'bold 18px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#66ee99';
      ctx.fillText(
        '📋  PLAN MODE — Select module on left  |  [B] Exit  |  [Click] Place Ghost',
        cw / 2, BANNER_H / 2
      );
      ctx.restore();
    }

    ctx.save();

    // ── Panel background ──────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(8,14,24,0.88)';
    ctx.strokeStyle = 'rgba(90,140,200,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, W, totalH, [0, 8, 8, 0]);
    ctx.fill();
    ctx.stroke();

    // ── Header ─────────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(20,80,60,0.85)';
    ctx.beginPath();
    ctx.roundRect(px, py, W, HH, [0, 8, 0, 0]);
    ctx.fill();

    ctx.fillStyle = '#66ee99';
    ctx.font = 'bold 12px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📋  PLAN MODE  [B]', px + W / 2, py + HH / 2);

    // ── Module entries ─────────────────────────────────────────────────────
    const ghostCounts = new Map<GhostModuleKind, number>();
    for (const g of this.buildMenuGhosts) {
      ghostCounts.set(g.kind, (ghostCounts.get(g.kind) ?? 0) + 1);
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const ey = py + HH + i * EH;
      const isPending = this.buildMenuPending === e.kind;
      const isHovered = this.mouseX >= px && this.mouseX < px + W
        && this.mouseY >= ey && this.mouseY < ey + EH;

      // Row background
      if (isPending) {
        ctx.fillStyle = 'rgba(50,180,80,0.25)';
      } else if (isHovered) {
        ctx.fillStyle = 'rgba(80,120,180,0.22)';
      } else {
        ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent';
      }
      ctx.fillRect(px + 2, ey + 1, W - 4, EH - 2);

      // Color swatch circle
      const swatchX = px + PAD + 10;
      const swatchY = ey + EH / 2;
      const swatchR = 10;
      ctx.fillStyle = e.color;
      ctx.strokeStyle = isPending ? '#55ee88' : e.borderColor;
      ctx.lineWidth = isPending ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(swatchX, swatchY, swatchR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Symbol inside swatch
      ctx.fillStyle = '#fff';
      ctx.font = `${swatchR * 1.1}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.symbol, swatchX, swatchY + 1);

      // Entry label
      ctx.fillStyle = isPending ? '#88ee99' : isHovered ? '#d0e8ff' : '#c8d8e8';
      ctx.font = isPending ? 'bold 13px Georgia, serif' : '13px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.label, swatchX + swatchR + 8, swatchY);

      // Ghost count badge
      const count = ghostCounts.get(e.kind) ?? 0;
      if (count > 0) {
        const badge = `×${count}`;
        ctx.fillStyle = 'rgba(255,200,50,0.85)';
        ctx.font = 'bold 11px Georgia, serif';
        ctx.textAlign = 'right';
        ctx.fillText(badge, px + W - 10, swatchY);
      }

      // Pending indicator arrow on the right edge
      if (isPending) {
        ctx.fillStyle = '#55ee88';
        ctx.font = '13px Georgia, serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('▶', px + W - 8, swatchY);
      }

      // Separator
      if (i < entries.length - 1) {
        ctx.strokeStyle = 'rgba(90,140,200,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 8, ey + EH);
        ctx.lineTo(px + W - 8, ey + EH);
        ctx.stroke();
      }
    }

    // ── Footer hint ────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(140,170,200,0.6)';
    ctx.font = '10px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('[R] rotate  [RMB] cancel', px + W / 2, py + totalH - 6);

    ctx.restore();
  }

  private initializeUIElements(): void {
    // Initialize HUD
    this.elements.set(UIElementType.HUD, new HUDElement());
    
    // Initialize Debug Overlay
    this.elements.set(UIElementType.DEBUG_OVERLAY, new DebugOverlayElement());
    
    // Initialize Network Stats
    this.elements.set(UIElementType.NETWORK_STATS, new NetworkStatsElement());
    
    // Control hints element removed
    
    // Set initial visibility
    this.updateElementVisibility();
  }
  
  private updateElementVisibility(): void {
    this.elements.get(UIElementType.HUD)!.visible = true;
    this.elements.get(UIElementType.DEBUG_OVERLAY)!.visible = this.showDebugOverlay;
    this.elements.get(UIElementType.NETWORK_STATS)!.visible = this.showNetworkStats;
  }
  
  private setupEventListeners(): void {
    // Listen for debug toggle keys
    window.addEventListener('keydown', this.onKeyDown.bind(this));
  }
  
  private removeEventListeners(): void {
    window.removeEventListener('keydown', this.onKeyDown.bind(this));
  }
  
  private onKeyDown(event: KeyboardEvent): void {
    // Close any open modal on Escape or backtick
    if (event.code === 'Escape' || event.code === 'Backquote') {
      // Let the company menu handle ESC first (e.g. cancel name-entry form)
      if (this.activeMenuId === MENU_ID.COMPANY && this.companyMenu.handleKeyDown('Escape')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.activeMenuId !== null
          && this.activeMenuId !== MENU_ID.CRAFTING
          && this.activeMenuId !== MENU_ID.SHIPYARD
          && this.activeMenuId !== MENU_ID.PAUSE) {
        this.closeActiveMenu();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Don't stopPropagation here — let ClientApplication handle Escape for pause menu
      return;
    }

    // Forward all keys to the company menu while its create form is active
    if (this.activeMenuId === MENU_ID.COMPANY && this.companyMenu.handleKeyDown(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    switch (event.code) {
      case 'KeyK':
        if (this.activeMenuId === MENU_ID.COMPANY) {
          this.closeActiveMenu();
        } else {
          this.openMenu(MENU_ID.COMPANY);
        }
        event.preventDefault();
        event.stopPropagation();
        break;

      case 'KeyO':
        if (this.activeMenuId === MENU_ID.PLAYER) {
          this.closeActiveMenu();
        } else {
          this.closeActiveMenu();
          this.activeMenuId = MENU_ID.PLAYER;
          this.playerMenu.openSkillsTab();
        }
        event.preventDefault();
        event.stopPropagation();
        break;

      case 'KeyI':
        if (this.activeMenuId === MENU_ID.PLAYER) {
          this.closeActiveMenu();
        } else {
          this.openMenu(MENU_ID.PLAYER);
        }
        event.preventDefault();
        event.stopPropagation();
        break;

      case 'KeyG':
        if (this.activeMenuId === MENU_ID.SHIP) {
          this.closeActiveMenu();
        } else {
          this.openMenu(MENU_ID.SHIP);
        }
        event.preventDefault();
        event.stopPropagation();
        break;

      case 'F1':
        // Control hints panel removed; F1 is a no-op
        break;
    }
  }

  // ── Hammer minigame private helpers ──────────────────────────────────────

  /** Called when the player presses SPACE, Enter, or clicks during the minigame. */
  private strikeHammer(): void {
    const elapsed = performance.now() - this.hammerGame.startTime;
    const pos     = Math.min(elapsed / this.hammerGame.duration, 1);
    const inZone  = pos >= this.hammerGame.sweetspotStart
                 && pos <= this.hammerGame.sweetspotStart + this.hammerGame.sweetspotWidth;
    this.hammerGame.won       = inZone;
    this.hammerGame.resultTime = performance.now();
    // Dismiss after 900 ms so the player can see the result flash
    setTimeout(() => {
      const cb  = this.hammerGame.callback;
      const won = this.hammerGame.won;
      this.hammerGame.active   = false;
      this.hammerGame.callback = null;
      if (cb) cb(won!);
    }, 900);
  }

  /** Full-screen overlay rendering for the hammer minigame. */
  private renderHammerMinigame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const now = performance.now();
    const elapsed = now - this.hammerGame.startTime;

    // Auto-fail when cursor reaches the end without a strike
    if (this.hammerGame.resultTime === -1 && elapsed >= this.hammerGame.duration) {
      this.hammerGame.won       = false;
      this.hammerGame.resultTime = now;
      setTimeout(() => {
        const cb = this.hammerGame.callback;
        this.hammerGame.active   = false;
        this.hammerGame.callback = null;
        if (cb) cb(false);
      }, 900);
    }

    const cw = canvas.width;
    const ch = canvas.height;

    ctx.save();

    // Dim background
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, cw, ch);

    // Panel
    const pw = 500, ph = 190;
    const px = (cw - pw) / 2;
    const py = (ch - ph) / 2;

    ctx.fillStyle   = '#16162a';
    ctx.strokeStyle = '#8b6520';
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.roundRect?.(px, py, pw, ph, 12);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.fillStyle     = '#f0c060';
    ctx.font          = 'bold 21px Georgia, serif';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'top';
    ctx.fillText('\uD83D\uDD28  HAMMER REPAIR', cw / 2, py + 16);

    // ── Track bar ────────────────────────────────────────────────────────
    const trackW = 430;
    const trackH = 26;
    const trackX = (cw - trackW) / 2;
    const trackY = py + 80;

    // Track background
    ctx.fillStyle   = '#252538';
    ctx.strokeStyle = '#4a4a66';
    ctx.lineWidth   = 1.5;
    ctx.fillRect(trackX, trackY, trackW, trackH);
    ctx.strokeRect(trackX, trackY, trackW, trackH);

    // Sweetspot (green zone)
    const ssX = trackX + this.hammerGame.sweetspotStart * trackW;
    const ssW = this.hammerGame.sweetspotWidth * trackW;
    ctx.fillStyle   = 'rgba(0,210,70,0.30)';
    ctx.strokeStyle = '#00cc44';
    ctx.lineWidth   = 1.5;
    ctx.fillRect(ssX, trackY, ssW, trackH);
    ctx.strokeRect(ssX, trackY, ssW, trackH);

    // Cursor — frozen at strike position after result
    const resultElapsed = this.hammerGame.resultTime >= 0 ? (now - this.hammerGame.resultTime) : -1;
    const cursorFrac    = this.hammerGame.resultTime >= 0
      ? Math.min((this.hammerGame.resultTime - this.hammerGame.startTime) / this.hammerGame.duration, 1)
      : Math.min(elapsed / this.hammerGame.duration, 1);
    const cursorX = trackX + cursorFrac * trackW;

    // Result flash tint over the whole track
    if (resultElapsed >= 0) {
      const fade = Math.max(0, 1 - resultElapsed / 700);
      ctx.globalAlpha = 0.35 + fade * 0.55;
      ctx.fillStyle   = this.hammerGame.won ? 'rgba(0,255,80,0.55)' : 'rgba(255,50,50,0.55)';
      ctx.fillRect(trackX, trackY, trackW, trackH);
      ctx.globalAlpha = 1;
    }

    // Cursor line
    ctx.strokeStyle = resultElapsed >= 0
      ? (this.hammerGame.won ? '#44ff88' : '#ff4444')
      : (cursorFrac > 0.8 ? '#ffcc00' : '#ffffff'); // warn yellow near the end
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cursorX, trackY - 5);
    ctx.lineTo(cursorX, trackY + trackH + 5);
    ctx.stroke();

    // ── Result / instructions text ────────────────────────────────────────
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    if (resultElapsed >= 0) {
      ctx.font      = 'bold 28px Georgia, serif';
      ctx.fillStyle = this.hammerGame.won ? '#33ff88' : '#ff5555';
      ctx.fillText(this.hammerGame.won ? 'CRACK! \u2192 +10 000 HP' : 'MISSED!', cw / 2, py + 128);
    } else {
      ctx.font      = '14px Georgia, serif';
      ctx.fillStyle = '#aaaacc';
      ctx.fillText('Press [SPACE] or click when the cursor enters the green zone', cw / 2, py + 128);
      // Countdown ticks along the bottom of the track as tiny tick marks
      const pct = elapsed / this.hammerGame.duration;
      ctx.fillStyle = pct > 0.75 ? '#ff8800' : '#555577';
      ctx.fillRect(trackX, trackY + trackH + 3, trackW * (1 - pct), 3);
    }

    ctx.restore();
  }

  // ── Drop item picker overlay ───────────────────────────────────────────────

  private _dropPickerHits: { itemId: number; y: number; h: number }[] = [];

  private _renderDropPicker(ctx: CanvasRenderingContext2D): void {
    const { items, scrollY } = this._dropPicker;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    const W = 300, ROW_H = 44, PAD = 12, HEADER_H = 36;
    const visibleRows = Math.min(items.length, 6);
    const contentH = items.length * ROW_H;
    const viewH = visibleRows * ROW_H;
    const totalH = HEADER_H + viewH + PAD;
    const px = Math.round((cw - W) / 2);
    const py = Math.round((ch - totalH) / 2);

    ctx.save();

    // Backdrop
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, ch);

    // Panel
    ctx.fillStyle = 'rgba(14,18,28,0.97)';
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, W, totalH, 6);
    ctx.fill();
    ctx.stroke();

    // Header
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Pick Up Item', px + W / 2, py + HEADER_H / 2);

    // Close hint
    ctx.fillStyle = '#778';
    ctx.font = '11px Georgia, serif';
    ctx.textAlign = 'right';
    ctx.fillText('[Esc]', px + W - PAD, py + HEADER_H / 2);

    // Clip to viewport
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py + HEADER_H, W, viewH);
    ctx.clip();

    this._dropPickerHits = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const ry = py + HEADER_H + i * ROW_H - scrollY;
      if (ry + ROW_H < py + HEADER_H || ry > py + HEADER_H + viewH) continue;

      this._dropPickerHits.push({ itemId: item.id, y: ry, h: ROW_H });

      const isHovered = this.mouseY >= ry && this.mouseY <= ry + ROW_H &&
                        this.mouseX >= px && this.mouseX <= px + W;
      if (isHovered) {
        ctx.fillStyle = 'rgba(255,215,0,0.10)';
        ctx.fillRect(px + 2, ry + 2, W - 4, ROW_H - 4);
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + PAD, ry + ROW_H);
      ctx.lineTo(px + W - PAD, ry + ROW_H);
      ctx.stroke();

      // Resolve item name/symbol from ITEM_DEFS
      const kindNum = item.itemKind;
      let name   = `Item #${kindNum}`;
      let symbol = '?';
      const kindStr = Object.entries(ITEM_KIND_ID).find(([, v]) => (v as number) === kindNum)?.[0];
      if (kindStr && (ITEM_DEFS as any)[kindStr]) {
        const def = (ITEM_DEFS as any)[kindStr];
        name   = def.name   ?? name;
        symbol = def.symbol ?? symbol;
      }

      ctx.font = '18px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(symbol, px + PAD, ry + ROW_H / 2);

      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = isHovered ? '#ffd700' : '#e8e0cc';
      ctx.fillText(name, px + PAD + 28, ry + ROW_H / 2);

      if (item.quantity > 1) {
        ctx.font = 'bold 11px Georgia, serif';
        ctx.fillStyle = '#aaa';
        ctx.textAlign = 'right';
        ctx.fillText(`\u00d7${item.quantity}`, px + W - PAD, ry + ROW_H / 2);
      }
    }
    ctx.restore(); // unclip

    // Scrollbar
    if (contentH > viewH) {
      const sbH = Math.max(20, (viewH / contentH) * viewH);
      const maxScroll = contentH - viewH;
      const sbY = py + HEADER_H + (scrollY / Math.max(1, maxScroll)) * (viewH - sbH);
      ctx.fillStyle = 'rgba(255,215,0,0.35)';
      ctx.beginPath();
      ctx.roundRect(px + W - 6, sbY, 4, sbH, 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /** Handle click in the drop picker. Returns true if consumed. */
  handleDropPickerClick(x: number, y: number): boolean {
    if (!this._dropPicker.open) return false;
    for (const hit of this._dropPickerHits) {
      if (y >= hit.y && y <= hit.y + hit.h) {
        this.onDropPickerPick?.(hit.itemId);
        this._dropPicker.open = false;
        return true;
      }
    }
    // Click outside closes picker
    const W = 300, ROW_H = 44, PAD = 12, HEADER_H = 36;
    const visibleRows = Math.min(this._dropPicker.items.length, 6);
    const viewH = visibleRows * ROW_H;
    const totalH = HEADER_H + viewH + PAD;
    const px = Math.round((this.canvas.width  - W) / 2);
    const py = Math.round((this.canvas.height - totalH) / 2);
    if (x < px || x > px + W || y < py || y > py + totalH) {
      this._dropPicker.open = false;
    }
    return true;
  }

  /** Handle wheel scroll in the drop picker. Returns true if consumed. */
  handleDropPickerWheel(deltaY: number): boolean {
    if (!this._dropPicker.open) return false;
    const ROW_H = 44;
    const visibleRows = Math.min(this._dropPicker.items.length, 6);
    const viewH = visibleRows * ROW_H;
    const contentH = this._dropPicker.items.length * ROW_H;
    const maxScroll = Math.max(0, contentH - viewH);
    this._dropPicker.scrollY = Math.max(0, Math.min(maxScroll, this._dropPicker.scrollY + deltaY * 0.4));
    return true;
  }

}

/**
 * HUD Element - Main game HUD
 */
class HUDElement implements UIElement {
  type = UIElementType.HUD;
  visible = true;
  public mouseX = 0;
  public mouseY = 0;
  
  render(ctx: CanvasRenderingContext2D, context: UIRenderContext): void {
    // Find our player using the server-assigned player ID
    const player = context.assignedPlayerId !== null && context.assignedPlayerId !== undefined
      ? context.worldState.players.find(p => p.id === context.assignedPlayerId)
      : context.worldState.players[0]; // Fallback to first player if no ID assigned yet
    
    if (!player) return;
    
    // ── Top-left stats box ────────────────────────────────────────────────
    ctx.save();

    const fps      = Math.round(context.fps);
    const frameMs  = context.frameMs ?? (fps > 0 ? 1000 / fps : 0);
    const ping     = Math.round(context.networkStats?.ping ?? 0);
    const glDc     = context.glDrawCalls ?? 0;
    const glScale  = context.glScalePct ?? 0;
    const fpsColor = fps >= 60 ? '#44ff66' : fps >= 30 ? '#ffaa00' : '#ff4444';

    const BOX_W = 260;
    const BOX_H = 118;
    const BX = 10, BY = 10;

    // Background + border
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(BX, BY, BOX_W, BOX_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(BX, BY, BOX_W, BOX_H);

    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';

    // FPS row — large & colour-coded
    ctx.font      = 'bold 15px Georgia, serif';
    ctx.fillStyle = fpsColor;
    ctx.fillText(`${fps} FPS  ${frameMs.toFixed(1)} ms`, BX + 10, BY + 9);

    // Ping + GL row
    ctx.font      = '13px Georgia, serif';
    ctx.fillStyle = ping < 80 ? '#88ddff' : ping < 200 ? '#ffaa00' : '#ff4444';
    const glText  = glScale > 0 ? `  GL ${glDc} dc @ ${glScale}%` : '  Canvas 2D';
    ctx.fillText(`Ping ${ping} ms${glText}`, BX + 10, BY + 28);

    // Divider
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(BX + 8, BY + 46); ctx.lineTo(BX + BOX_W - 8, BY + 46);
    ctx.stroke();

    // Position
    ctx.font      = '13px Georgia, serif';
    ctx.fillStyle = '#aaffcc';
    ctx.fillText(`Pos  ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}`, BX + 10, BY + 52);

    // Ship / velocity
    ctx.fillStyle = '#cccccc';
    ctx.fillText(`Ship ${player.onDeck ? `#${player.carrierId}` : '—'}   Vel ${player.velocity.x.toFixed(1)}, ${player.velocity.y.toFixed(1)}`, BX + 10, BY + 69);

    // Network bandwidth
    const ns = context.networkStats;
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`↑ ${(ns.bytesSent / 1024).toFixed(1)} KB  ↓ ${(ns.bytesReceived / 1024).toFixed(1)} KB  loss ${ns.packetLoss.toFixed(1)}%`, BX + 10, BY + 86);

    ctx.restore();

    // --- Water meter (top-right boat icon) ---
    // Show whenever the player is aboard any ship
    const playerShip = player.onDeck
      ? context.worldState.ships.find(s => s.id === player.carrierId)
      : null;

    if (playerShip != null) {
      // Compute deck health ratio from the ship's deck module(s)
      const decks = playerShip.modules.filter(m => m.kind === 'deck');
      let deckRatio = 1;
      if (decks.length > 0) {
        let totalHp = 0, totalMax = 0;
        for (const m of decks) {
          const d = m.moduleData as { health?: number; maxHealth?: number } | undefined;
          totalHp  += d?.health    ?? 0;
          totalMax += d?.maxHealth ?? 10000;
        }
        deckRatio = totalMax > 0 ? Math.max(0, Math.min(1, totalHp / totalMax)) : 1;
      }
      const mastModules = playerShip.modules.filter(m => m.kind === 'mast');
      this.renderWaterMeter(ctx, ctx.canvas, playerShip.hullHealth ?? 100, deckRatio, playerShip.rotation ?? 0, mastModules, playerShip.hull ?? []);
    }

    // Health / stamina bars above hotbar
    const maxSt = player.maxStamina ?? 100;
    const st    = player.stamina    ?? maxSt;
    this.renderPlayerBars(ctx, ctx.canvas, player.health, player.maxHealth ?? 100, st, maxSt, player.level ?? 1, player.xp ?? 0);

    // Hotbar — in ship/helm mode reuses same grid to show weapon groups
    const helmMode = context.mountKind === 'helm'
      ? { activeGroup: context.activeWeaponGroup ?? -1, activeGroups: context.activeWeaponGroups ?? new Set<number>(), playerShip: context.playerShip ?? null, controlGroups: context.controlGroups }
      : undefined;
    this.renderHotbar(ctx, ctx.canvas, player.inventory.slots, player.inventory.activeSlot, helmMode);

    // Equipment panel (armor + shield)
    this.renderEquipmentPanel(ctx, ctx.canvas, player.inventory.equipment.torso, player.inventory.equipment.shield);
  }

  private renderPlayerBars(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    health: number,
    maxHealth: number,
    stamina: number,
    maxStamina: number,
    level = 1,
    xp = 0,
  ): void {
    const PLAYER_MAX_LEVEL = 66;
    const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
    const totalW = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((canvas.width - totalW) / 2);
    const hotbarY = canvas.height - totalH - 8;

    const BAR_H    = 10;
    const XP_BAR_H = 6;
    const GAP      = 3;
    const PANEL_PAD = 4;
    const panelH   = PANEL_PAD * 2 + XP_BAR_H + GAP + BAR_H * 2 + GAP;
    const panelY   = hotbarY - panelH - 4;
    const barX     = startX + PANEL_PAD;
    const barW     = totalW - PANEL_PAD * 2;

    const hpRatio = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 1;
    const stRatio = maxStamina > 0 ? Math.max(0, Math.min(1, stamina / maxStamina)) : 1;
    const isMaxLevel = level >= PLAYER_MAX_LEVEL;
    const xpToNext  = isMaxLevel ? PLAYER_MAX_LEVEL * 100 : level * 100;
    const xpRatio   = isMaxLevel ? 1 : Math.min(xp / xpToNext, 1);

    ctx.save();

    // Background panel
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(startX, panelY, totalW, panelH);
    ctx.strokeStyle = '#556';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, panelY, totalW, panelH);

    // XP bar
    const xpY = panelY + PANEL_PAD;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(barX, xpY, barW, XP_BAR_H);
    ctx.fillStyle = isMaxLevel ? '#ffdd44' : '#4488ff';
    ctx.fillRect(barX, xpY, Math.round(barW * xpRatio), XP_BAR_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, xpY, barW, XP_BAR_H);

    ctx.font = 'bold 8px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.70)';
    ctx.fillText(`Lv.${level}${isMaxLevel ? ' MAX' : ''}`, barX + 3, xpY + XP_BAR_H / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(180,200,255,0.65)';
    ctx.fillText(isMaxLevel ? 'MAX' : `${xp}/${xpToNext} XP`, barX + barW - 3, xpY + XP_BAR_H / 2);

    // Health bar
    const hpY    = xpY + XP_BAR_H + GAP;
    const hpCrit = hpRatio < 0.25;
    const hpWarn = hpRatio < 0.50;
    const hpColor = hpCrit ? '#cc2222' : hpWarn ? '#cc8822' : '#22aa44';

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, hpY, barW, BAR_H);
    ctx.fillStyle = hpColor;
    ctx.fillRect(barX, hpY, Math.round(barW * hpRatio), BAR_H);
    ctx.strokeStyle = hpCrit ? '#ff4444' : 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, hpY, barW, BAR_H);

    ctx.font = 'bold 9px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.80)';
    ctx.fillText('HP', barX + 4, hpY + BAR_H / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = hpCrit ? '#ff6666' : 'rgba(255,255,255,0.70)';
    ctx.fillText(`${Math.ceil(health)}/${maxHealth}`, barX + barW - 4, hpY + BAR_H / 2);

    // ── Stamina bar ────────────────────────────────────────────────────────
    const stY   = hpY + BAR_H + GAP;
    const stLow = stRatio < 0.25;
    const stColor = stLow ? '#cc9900' : '#ddbb00';

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, stY, barW, BAR_H);
    ctx.fillStyle = stColor;
    ctx.fillRect(barX, stY, Math.round(barW * stRatio), BAR_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, stY, barW, BAR_H);

    ctx.font = 'bold 9px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.80)';
    ctx.fillText('ST', barX + 4, stY + BAR_H / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.70)';
    ctx.fillText(`${Math.ceil(stamina)}/${maxStamina}`, barX + barW - 4, stY + BAR_H / 2);

    ctx.restore();
  }

  private renderHotbar(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    slots: { item: ItemKind; quantity: number }[],
    activeSlot: number,
    weaponMode?: { activeGroup: number; activeGroups: Set<number>; playerShip: Ship | null; controlGroups?: Map<number, WeaponGroupState> },
  ): void {
    const SLOT_SIZE = 48;
    const SLOT_GAP = 4;
    const PADDING = 6;
    const LABEL_H = 16;
    const totalW = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((canvas.width - totalW) / 2);
    const startY = canvas.height - totalH - 8;

    // ── Weapon-group display constants (used in helm mode) ─────────────────
    const MODE_LABELS: Record<string, string> = {
      aiming:     'AIM',
      freefire:   'FREE',
      haltfire:   'HALT',
      targetfire: 'LOCK',
    };
    const MODE_COLORS: Record<string, string> = {
      aiming:     '#3498db',
      freefire:   '#e67e22',
      haltfire:   '#555',
      targetfire: '#ff66cc',
    };
    // ── ─────────────────────────────────────────────────────────────────────

    // Background panel
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(startX, startY, totalW, totalH);
    ctx.strokeStyle = '#556';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, startY, totalW, totalH);

    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const slot = slots[i] ?? { item: 'none' as ItemKind, quantity: 0 };
      const def  = ITEM_DEFS[slot.item] ?? ITEM_DEFS['none'];
      const sx   = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      const sy   = startY + PADDING;
      const groupIdx = (i + 1) % 10; // slot 0→G1, …, slot 8→G9, slot 9→G0
      const isActive = weaponMode
        ? weaponMode.activeGroups.has(groupIdx)
        : (i === activeSlot && activeSlot < 10);

      // Slot background
      ctx.fillStyle = isActive ? 'rgba(255,220,60,0.18)' : 'rgba(30,30,40,0.9)';
      ctx.fillRect(sx, sy, SLOT_SIZE, SLOT_SIZE);

      // Slot border (bright gold when active)
      ctx.strokeStyle = isActive ? '#ffd700' : (weaponMode ? 'rgba(120,120,140,0.55)' : def.borderColor);
      ctx.lineWidth = isActive ? 2.5 : 1;
      ctx.strokeRect(sx, sy, SLOT_SIZE, SLOT_SIZE);

      if (weaponMode) {
        // ── Ship / helm mode: show weapon control group ──────────────────────
        const cgroups  = weaponMode.controlGroups ?? new Map<number, WeaponGroupState>();
        const state    = cgroups.get(groupIdx);
        const count    = state?.cannonIds.length ?? 0;
        const mode     = state?.mode ?? 'haltfire';
        const modeCol  = MODE_COLORS[mode] ?? '#555';
        const modeLbl  = MODE_LABELS[mode] ?? mode;
        const hasLock  = mode === 'targetfire' && state != null && state.targetId >= 0;

        // Group number label (top-centre)
        ctx.font         = 'bold 11px Georgia, serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = isActive ? '#ffd700' : 'rgba(160,160,180,0.75)';
        ctx.fillText(`G${groupIdx}`, sx + SLOT_SIZE / 2, sy + 3);

        // Cannon count (large, centre)
        if (count > 0) {
          ctx.font         = 'bold 20px Georgia, serif';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = isActive ? '#ffffff' : 'rgba(200,200,220,0.9)';
          ctx.fillText(String(count), sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2 - 3);
          ctx.font         = '8px Georgia, serif';
          ctx.fillStyle    = isActive ? 'rgba(255,255,255,0.65)' : 'rgba(140,140,160,0.6)';
          ctx.fillText(count === 1 ? 'cannon' : 'cannons', sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2 + 10);
        } else {
          ctx.font         = '10px Georgia, serif';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = 'rgba(70,70,80,0.5)';
          ctx.fillText('empty', sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);
        }

        // Mode badge strip along bottom
        const BADGE_H = 13;
        ctx.fillStyle = count > 0 ? modeCol : 'rgba(50,50,60,0.85)';
        ctx.fillRect(sx + 1, sy + SLOT_SIZE - BADGE_H - 1, SLOT_SIZE - 2, BADGE_H);
        ctx.font         = 'bold 8px Georgia, serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = '#fff';
        ctx.fillText(count > 0 ? modeLbl : '---', sx + SLOT_SIZE / 2, sy + SLOT_SIZE - BADGE_H / 2 - 1);

        // Target-locked dot (top-right corner)
        if (hasLock) {
          ctx.fillStyle = '#ff66cc';
          ctx.beginPath();
          ctx.arc(sx + SLOT_SIZE - 5, sy + 5, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // ── Normal inventory mode ─────────────────────────────────────────────
        // Item fill color swatch
        if (slot.item !== 'none') {
          const swatchPad = 6;
          ctx.fillStyle = def.color;
          ctx.fillRect(sx + swatchPad, sy + swatchPad, SLOT_SIZE - swatchPad * 2, SLOT_SIZE - swatchPad * 2);
          ctx.strokeStyle = def.borderColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(sx + swatchPad, sy + swatchPad, SLOT_SIZE - swatchPad * 2, SLOT_SIZE - swatchPad * 2);

          // Symbol
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 18px Georgia, serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(def.symbol, sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);

          // Stack count (bottom-right, only for stackables > 1)
          if (slot.quantity > 1) {
            ctx.fillStyle = '#ffee88';
            ctx.font = 'bold 11px Georgia, serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(String(slot.quantity), sx + SLOT_SIZE - 3, sy + SLOT_SIZE - 3);
          }
        }
      }

      // Slot number label below slot
      ctx.fillStyle = isActive ? '#ffd700' : '#778';
      ctx.font = '11px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(i === 9 ? 0 : i + 1), sx + SLOT_SIZE / 2, sy + SLOT_SIZE + 2);
    }

    // Tooltip: check which slot (if any) the mouse is hovering
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      const sy = startY + PADDING;
      if (
        this.mouseX >= sx && this.mouseX <= sx + SLOT_SIZE &&
        this.mouseY >= sy && this.mouseY <= sy + SLOT_SIZE
      ) {
        this.renderHotbarTooltip(ctx, canvas, slots, i, sx, sy);
        break;
      }
    }

    ctx.restore();
  }

  /** Draw a tooltip above the hovered hotbar slot. */
  private renderHotbarTooltip(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    slots: { item: ItemKind; quantity: number }[],
    hoveredIndex: number,
    slotX: number,
    slotY: number,
  ): void {
    const SLOT_SIZE = 48;
    const slot = slots[hoveredIndex] ?? { item: 'none' as ItemKind, quantity: 0 };
    if (slot.item === 'none') return;

    const def    = ITEM_DEFS[slot.item] ?? ITEM_DEFS['none'];
    const itemId = ITEM_KIND_ID[slot.item] ?? 0;

    const PAD   = 10;
    const W     = 220;
    const LINE  = 16;
    const nameH = 18;
    const descLines = this.wrapText(ctx, def.description, W - PAD * 2, '12px Georgia, serif');
    const totalH = PAD + nameH + 4 + LINE + 4 + descLines.length * LINE + PAD;

    // Position: centred above the slot, clamped to canvas
    let tx = slotX + SLOT_SIZE / 2 - W / 2;
    let ty = slotY - totalH - 6;
    tx = Math.max(4, Math.min(canvas.width - W - 4, tx));
    if (ty < 4) ty = slotY + SLOT_SIZE + 6;

    ctx.save();

    // Shadow
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = 'rgba(12,12,20,0.94)';
    ctx.strokeStyle = def.borderColor;
    ctx.lineWidth   = 1.5;
    this.roundRect(ctx, tx, ty, W, totalH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Colour accent bar on left
    ctx.fillStyle = def.color;
    this.roundRect(ctx, tx, ty, 4, totalH, { tl: 6, tr: 0, br: 0, bl: 6 });
    ctx.fill();

    let cy = ty + PAD;

    // Item name
    ctx.fillStyle    = '#ffffff';
    ctx.font         = `bold 14px Georgia, serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(def.name, tx + PAD + 4, cy);
    cy += nameH + 4;

    // ID  +  category
    ctx.fillStyle = '#888';
    ctx.font      = '11px Georgia, serif';
    ctx.fillText(`ID: ${itemId}   [${def.category}]`, tx + PAD + 4, cy);
    cy += LINE + 4;

    // Description
    ctx.fillStyle = '#ccc';
    ctx.font      = '12px Georgia, serif';
    for (const line of descLines) {
      ctx.fillText(line, tx + PAD + 4, cy);
      cy += LINE;
    }

    ctx.restore();
  }

  /** Word-wrap `text` into lines that fit within `maxWidth`. */
  private wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    font: string,
  ): string[] {
    ctx.save();
    ctx.font = font;
    const words  = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    ctx.restore();
    return lines;
  }

  /** Draw a rounded rectangle path. corners can be a uniform radius or per-corner object. */
  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    corners: number | { tl: number; tr: number; br: number; bl: number },
  ): void {
    const tl = typeof corners === 'number' ? corners : corners.tl;
    const tr = typeof corners === 'number' ? corners : corners.tr;
    const br = typeof corners === 'number' ? corners : corners.br;
    const bl = typeof corners === 'number' ? corners : corners.bl;
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }

  private renderEquipmentPanel(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    armor: ItemKind,
    shield: ItemKind
  ): void {
    const SLOT_SIZE = 44;
    const SLOT_GAP = 6;
    const PADDING = 8;
    const panelW = 2 * SLOT_SIZE + SLOT_GAP + PADDING * 2;
    const panelH = SLOT_SIZE + PADDING * 2 + 16 + 14; // slots + labels + header
    const px = canvas.width - panelW - 8;
    const py = canvas.height - panelH - 8;

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(px, py, panelW, panelH);
    ctx.strokeStyle = '#556';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, panelW, panelH);

    // Header
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 11px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('EQUIP', px + panelW / 2, py + 4);

    const slots: { item: ItemKind; label: string }[] = [
      { item: armor,  label: 'Armor'  },
      { item: shield, label: 'Shield' },
    ];

    for (let i = 0; i < 2; i++) {
      const { item, label } = slots[i];
      const def = ITEM_DEFS[item] ?? ITEM_DEFS['none'];
      const sx = px + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      const sy = py + 4 + 14; // below header

      // Background
      ctx.fillStyle = item !== 'none' ? 'rgba(50,40,20,0.9)' : 'rgba(30,30,40,0.9)';
      ctx.fillRect(sx, sy, SLOT_SIZE, SLOT_SIZE);
      ctx.strokeStyle = def.borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx, sy, SLOT_SIZE, SLOT_SIZE);

      if (item !== 'none') {
        const swatchPad = 5;
        ctx.fillStyle = def.color;
        ctx.fillRect(sx + swatchPad, sy + swatchPad, SLOT_SIZE - swatchPad * 2, SLOT_SIZE - swatchPad * 2);
        ctx.strokeStyle = def.borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + swatchPad, sy + swatchPad, SLOT_SIZE - swatchPad * 2, SLOT_SIZE - swatchPad * 2);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 16px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.symbol, sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);
      }

      // Label
      ctx.fillStyle = '#778';
      ctx.font = '10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, sx + SLOT_SIZE / 2, sy + SLOT_SIZE + 3);
    }

    ctx.restore();
  }

  private renderWaterMeter(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    hullHealth: number,
    plankRatio: number = 1,
    shipRotation: number = 0,
    mastModules: import('../../../sim/modules.js').ShipModule[] = [],
    shipHull: import('../../../common/Vec2.js').Vec2[] = []
  ): void {
    const waterFill  = Math.max(0, Math.min(1, 1 - hullHealth / 100));
    const isCritical = waterFill > 0.9;

    ctx.save(); // OUTER — removed at end; labels drawn after this restore

    // ── Dimensions & position (top-right corner) ─────────────────────────
    const iW   = 44;
    const iH   = 110;
    const marg = 28;
    const ix   = canvas.width - iW - marg;
    const iy   = marg;
    const cx   = ix + iW / 2;
    const cy   = iy + iH / 2;
    // Half-diagonal of the icon bounding box: max screen extent after any rotation
    const halfDiag = Math.ceil(Math.sqrt(iW * iW + iH * iH) / 2) + 4; // ≈62

    // ── Apply ship rotation around icon centre ────────────────────────────
    ctx.translate(cx, cy);
    ctx.rotate(shipRotation + Math.PI / 2);
    ctx.translate(-cx, -cy);

    // ── Ship silhouette path (defined in rotated space) ───────────────────
    const bowY   = iy + 4;
    const sternY = iy + iH - 4;
    const hw     = iW / 2 - 2;

    const shipPath = new Path2D();
    shipPath.moveTo(cx, bowY);
    shipPath.bezierCurveTo(
      cx + hw * 0.45, iy + iH * 0.14,
      cx + hw,        iy + iH * 0.38,
      cx + hw - 1,    iy + iH * 0.65
    );
    shipPath.quadraticCurveTo(cx + hw - 3, sternY - 5, cx + 7, sternY);
    shipPath.lineTo(cx - 7, sternY);
    shipPath.quadraticCurveTo(cx - hw + 3, sternY - 5, cx - hw + 1, iy + iH * 0.65);
    shipPath.bezierCurveTo(
      cx - hw,        iy + iH * 0.38,
      cx - hw * 0.45, iy + iH * 0.14,
      cx, bowY
    );
    shipPath.closePath();

    // ── Water fill — clipped to ship, drawn in SCREEN space ───────────────
    // ctx.clip() captures the clip region in screen coords at call time, so
    // after we undo the rotation the rectangle fills are always horizontal.
    if (waterFill > 0) {
      ctx.save(); // CLIP A
      ctx.clip(shipPath);

      // Undo rotation → back to screen (unrotated) space
      ctx.translate(cx, cy);
      ctx.rotate(-(shipRotation + Math.PI / 2));
      ctx.translate(-cx, -cy);

      // Water rises from the screen-bottom of the silhouette bounding box upward
      const shipScreenBottom = cy + halfDiag;
      const shipScreenTop    = cy - halfDiag;
      const shipScreenH      = shipScreenBottom - shipScreenTop;
      const fillH            = waterFill * shipScreenH;
      const fillY            = shipScreenBottom - fillH;
      const spanX            = cx - halfDiag - 2;
      const spanW            = halfDiag * 2 + 4;

      ctx.fillStyle = isCritical ? 'rgba(187,17,17,0.82)' : 'rgba(17,85,204,0.78)';
      ctx.fillRect(spanX, fillY, spanW, fillH + 4);

      // Shimmer at water surface
      ctx.fillStyle = isCritical ? 'rgba(255,160,160,0.55)' : 'rgba(170,230,255,0.60)';
      ctx.fillRect(spanX, fillY, spanW, 2);

      // Wave bands
      for (let by = fillY + 6; by < shipScreenBottom; by += 9) {
        ctx.fillStyle = isCritical ? 'rgba(255,80,80,0.14)' : 'rgba(120,200,255,0.18)';
        ctx.fillRect(spanX, by, spanW, 3);
      }

      ctx.restore(); // CLIP A — removes clip, restores rotated transform
    }

    // ── Fore-aft plank lines (clipped, drawn in rotated space) ────────────
    ctx.save(); // CLIP B
    ctx.clip(shipPath);
    ctx.strokeStyle = waterFill > 0.6 ? 'rgba(200,120,120,0.30)' : 'rgba(200,180,140,0.28)';
    ctx.lineWidth   = 0.8;
    for (let lx = ix + 8; lx < ix + iW - 4; lx += 8) {
      ctx.beginPath();
      ctx.moveTo(lx, bowY + 10);
      ctx.lineTo(lx, sternY - 4);
      ctx.stroke();
    }
    ctx.restore(); // CLIP B

    // ── Bowsprit ──────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(cx, bowY);
    ctx.lineTo(cx, bowY - 10);
    ctx.strokeStyle = isCritical ? '#ff9977' : '#ccbbaa';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // ── Masts + Sails (data-driven from ship modules) ────────────────────
    // Map mast localPos.x (fore-aft in ship space, +x = bow) onto stencil Y.
    // Use hull fore/aft extent for normalisation; fall back to mast range.
    let hullFore = 0, hullAft = 0;
    if (shipHull.length > 0) {
      hullFore = Math.max(...shipHull.map(v => v.x));
      hullAft  = Math.min(...shipHull.map(v => v.x));
    } else if (mastModules.length > 0) {
      hullFore = Math.max(...mastModules.map(m => m.localPos.x));
      hullAft  = Math.min(...mastModules.map(m => m.localPos.x));
    }
    const shipLocalLen = hullFore - hullAft || 1;
    // Map localPos.x → stencil Y: bow (hullFore) → bowY, stern (hullAft) → sternY
    const toIconY = (lx: number) =>
      bowY + (hullFore - lx) / shipLocalLen * (sternY - bowY);

    const sailR    = 10;

    // Sort fore → aft so they draw in natural order
    const sortedMasts = [...mastModules].sort((a, b) => b.localPos.x - a.localPos.x);

    for (const mast of sortedMasts) {
      const my = toIconY(mast.localPos.x);

      // Mast dot — skip, sail arc already marks the position

      // Sail arc + openness indicator line
      const md = mast.moduleData as { kind: string; angle?: number; openness?: number } | undefined;
      const sailAngle = md?.angle ?? 0;   // radians
      const openness  = (md?.openness ?? 100) / 100;

      ctx.save();
      ctx.translate(cx, my);
      ctx.rotate(sailAngle);

      ctx.strokeStyle = '#39ff14';
      ctx.shadowColor = '#39ff14';
      ctx.shadowBlur  = 4;

      // Arc — always full size, full opacity
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, sailR, 0, Math.PI, true); // semicircle, no diameter line
      ctx.stroke();

      // Radius line along the arc's bisector — starts at arc edge, grows inward
      // Arc midpoint is at (0, -sailR); full openness reaches center (0, 0)
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -sailR);
      ctx.lineTo(0, -sailR + sailR * openness);
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // ── Ship outline ──────────────────────────────────────────────────────
    ctx.strokeStyle = isCritical ? '#ff5555' : '#e0e0e0';
    ctx.lineWidth   = isCritical ? 2.5 : 1.8;
    ctx.stroke(shipPath);

    ctx.restore(); // OUTER — removes rotation; labels drawn below in screen space

    // ── Water % label + "WATER" tag ───────────────────────────────────────
    const pct        = Math.round(waterFill * 100);
    // labelY is below the maximum rotated extent of the silhouette
    const labelY     = cy + halfDiag + 6;
    const labelColor = isCritical ? '#ff5555' : '#88bbee';

    ctx.save();
    ctx.font         = 'bold 12px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = labelColor;
    ctx.fillText(`${pct}%`, cx, labelY);

    ctx.font      = '9px Georgia, serif';
    ctx.fillStyle = isCritical ? '#ff7777' : '#557799';
    ctx.fillText('WATER', cx, labelY + 14);

    // ── Deck health bar ───────────────────────────────────────────────────
    const barY      = labelY + 28;
    const barW      = iW;
    const barH      = 8;
    const plankCrit = plankRatio < 0.30;
    const plankWarn = plankRatio < 0.60;
    const barColor  = plankCrit ? '#dd3333' : plankWarn ? '#dd9922' : '#33aa55';

    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(ix, barY, barW, barH);

    ctx.fillStyle = barColor;
    ctx.fillRect(ix, barY, Math.round(barW * plankRatio), barH);

    ctx.strokeStyle = plankCrit ? '#ff4444' : 'rgba(255,255,255,0.30)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(ix, barY, barW, barH);

    const hullPct = Math.round(plankRatio * 100);
    ctx.font         = '9px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = plankCrit ? '#ff5555' : '#778866';
    ctx.fillText('DECK', ix, barY + barH + 3);
    ctx.textAlign = 'right';
    ctx.fillStyle = plankCrit ? '#ff5555' : '#aabbaa';
    ctx.fillText(`${hullPct}%`, ix + barW, barY + barH + 3);

    ctx.restore();
  }
}

/**
 * Debug Overlay Element
 */
class DebugOverlayElement implements UIElement {
  type = UIElementType.DEBUG_OVERLAY;
  visible = false;
  
  render(ctx: CanvasRenderingContext2D, context: UIRenderContext): void {
    // Find our player using the server-assigned player ID
    const player = context.assignedPlayerId !== null && context.assignedPlayerId !== undefined
      ? context.worldState.players.find(p => p.id === context.assignedPlayerId)
      : context.worldState.players[0]; // Fallback to first player if no ID assigned yet
    
    const cameraState = context.camera.getState();
    
    if (!player) return;
    
    // Semi-transparent background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(10, 10, 400, 300);
    
    // Debug text
    ctx.fillStyle = '#00ff00';
    ctx.font = '14px Georgia, serif';
    ctx.textAlign = 'left';
    
    const debugLines = [
      '=== DEBUG INFO ===',
      `Tick: ${context.worldState.tick}`,
      `Player Velocity: ${player.velocity.x.toFixed(2)}, ${player.velocity.y.toFixed(2)}`,
      `Camera Position: ${cameraState.position.x.toFixed(1)}, ${cameraState.position.y.toFixed(1)}`,
      `Camera Zoom: ${cameraState.zoom.toFixed(2)}x`,
      `Ships: ${context.worldState.ships.length}`,
      `Cannonballs: ${context.worldState.cannonballs.length}`,
      '',
      '=== CONTROLS ===',
      'I - Character sheet',
      'F - Ship status',
      'L - Company Ledger menu',
      '] - Toggle hover boundaries',
      'F1 - Toggle control hints',
      'WASD - Movement',
      'Space - Jump off ship',
      'E - Interact with modules',
    ];
    
    debugLines.forEach((line, index) => {
      ctx.fillText(line, 20, 35 + index * 16);
    });
  }
}

/**
 * Network Stats Element
 */
class NetworkStatsElement implements UIElement {
  type = UIElementType.NETWORK_STATS;
  visible = false;
  
  render(ctx: CanvasRenderingContext2D, context: UIRenderContext): void {
    const stats = context.networkStats;
    
    // Position in top-right corner
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(ctx.canvas.width - 220, 10, 210, 120);
    
    ctx.fillStyle = '#00ffff';
    ctx.font = '14px Georgia, serif';
    ctx.textAlign = 'left';
    
    const networkLines = [
      '=== NETWORK ===',
      `Ping: ${stats.ping}ms`,
      `Packet Loss: ${stats.packetLoss.toFixed(1)}%`,
      `Sent: ${(stats.bytesSent / 1024).toFixed(1)}KB`,
      `Received: ${(stats.bytesReceived / 1024).toFixed(1)}KB`,
      `Messages: ${stats.messagesSent}/${stats.messagesReceived}`,
    ];
    
    networkLines.forEach((line, index) => {
      ctx.fillText(line, ctx.canvas.width - 210, 30 + index * 16);
    });
  }
}

/**
 * Control Hints Element
 */
class ControlHintsElement implements UIElement {
  type = UIElementType.CONTROL_HINTS;
  visible = true;
  
  render(ctx: CanvasRenderingContext2D, _context: UIRenderContext): void {
    // Position in bottom-left corner
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(10, ctx.canvas.height - 120, 300, 110);
    
    ctx.fillStyle = '#ffff00';
    ctx.font = '12px Georgia, serif';
    ctx.textAlign = 'left';
    
    const controlLines = [
      'CONTROLS:',
      'WASD - Move',
      'Mouse - Look direction',
      'Space - Jump off ship',
      'E - Interact with modules',
      'R - Dismount from modules',
      'Q - Damage planks',
    ];
    
    controlLines.forEach((line, index) => {
      ctx.fillText(line, 20, ctx.canvas.height - 105 + index * 14);
    });
  }
}