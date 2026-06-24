/**
 * UI Manager - User Interface System
 * 
 * Handles all user interface elements including HUD, menus, and debug overlays.
 * Separated from rendering for clean architecture.
 */

import { ClientConfig } from '../ClientConfig.js';
import { WorldState, Npc, Ship, WeaponGroupMode, WeaponGroupState, DroppedItem, IslandResource, SHIP_TYPE_GHOST } from '../../sim/Types.js';
import { GhostPlacement, GhostModuleKind } from '../../sim/Types.js';
import { Camera } from '../gfx/Camera.js';
import { NetworkStats } from '../../net/NetworkManager.js';
import { ITEM_DEFS, INVENTORY_SLOTS, HOTBAR_SLOTS, ItemKind, ITEM_KIND_ID, drawAxeIcon, drawSwordIcon, computeInventoryWeight } from '../../sim/Inventory.js';
import { computePlayerCarriedKg, playerCarryCapacityKg } from '../../sim/Grapple.js';
import { ManningPriorityPanel } from './ManningPriorityPanel.js';
import { CompanyMenu } from './CompanyMenu.js';
import { PlayerMenu } from './PlayerMenu.js';
import { SHIP_BUILD_PANEL_ENTRIES } from './buildPanelShared.js';
import { ShipMenu } from './ShipMenu.js';
import { ShipSchematicPoolMenu } from './ShipSchematicPoolMenu.js';
import { CrewLevelMenu } from './CrewLevelMenu.js';
import { RespawnScreen } from './RespawnScreen.js';
import { WorldMapScreen } from './WorldMapScreen.js';
import { TombstoneMenu } from './TombstoneMenu.js';
import { SalvageMenu } from './SalvageMenu.js';
import { tierColor as _tierColor, tierName as _tierName, statMultLabel as _statMultLabel, QUALITY_STAT_NAMES as _QUALITY_STAT_NAMES, itemDisplayName as _itemDisplayName } from '../../sim/Quality.js';

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
  /** Groups showing the temporary RMB-hold AIM tag. */
  rmbAimingGroups?: Set<number>;
  /** Active ammo group on helm: 'cannon' (IDs 0-1) or 'swivel' (IDs 2-4). */
  activeAmmoGroup?: 'cannon' | 'swivel';
  /** Current world wind direction (radians, 0=North, clockwise). */
  windAngle?: number;
  /** True when the debug overlay is active (L key). */
  debugMode?: boolean;
  /** True when the player has combat mode enabled (Z key). */
  combatMode?: boolean;
  /** Shipyard structure ID if the player's current ship is scaffolded there, 0 otherwise. */
  scaffoldedShipyardId?: number;
  /** True when Alt is held — used for detail overlays (e.g. ship IDs on map). */
  altHeld?: boolean;
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
  CHEST:     'chest',
  BED_TRAVEL:'bed_travel',
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
  /** Ship shared schematic pool (opened from ship menu). */
  public readonly shipSchematicPoolMenu = new ShipSchematicPoolMenu();
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

  /** True when the debug overlay is currently visible. */
  get isDebugMode(): boolean { return this.showDebugOverlay; }
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
    kind: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag' | 'chest' | 'bed';
    tooFar: boolean;
    enemyClose: boolean;
    wallVariant?: 'wall' | 'door_frame';
  } | null = null;

  /** Called when the player clicks the XP bar to level up (has enough XP). */
  public onPlayerLevelUp: (() => void) | null = null;
  /** Cached player level/xp for XP bar click detection. */
  private _cachedPlayerLevel = 1;
  private _cachedPlayerXp = 0;
  /** Called when the player clicks a build item button (cannon/sail/swivel). */
  public onBuildItemSelect: ((item: 'cannon' | 'sail' | 'swivel') => void) | null = null;
  /** Called when a weapon group has its mode cycled via right-click. */
  public onGroupModeChange: ((groupIndex: number, mode: WeaponGroupMode) => void) | null = null;
  /** Called when the player left-clicks a hotbar slot. */
  public onHotbarSlotClick: ((slot: number) => void) | null = null;
  /** Supplier for current player inventory — used for drag-and-drop in player menu. */
  public getPlayerInventory: (() => { slots: { item: ItemKind; quantity: number }[] } | null) | null = null;
  /** Supplier for the connected ship's aggregated chest resources — used for land build resource panel. */
  public getShipChestResources: (() => { wood: number; fiber: number; metal: number; stone: number } | null) | null = null;
  /** Supplier for land-chest resources accessible from a nearby shipyard — null when not near a shipyard. */
  public getShipyardResources: (() => { wood: number; fiber: number; metal: number; stone: number } | null) | null = null;
  /** Which resource pool is active for ship building: 'ship' = chest, 'pack' = player. Toggled with R. */
  public buildResourceSource: 'pack' | 'ship' | 'yard' | 'auto' = 'auto';
  /** Persistent column display order in the resource panel (left=lowest priority, right=highest). */
  public columnOrder: string[] = ['PACK', 'CHEST', 'YARD'];
  /** Active column header drag state (null when not dragging). */
  private _resColDrag: { header: string; dragX: number } | null = null;
  /** Cached column hit-test info from the last renderResourcePanel call. */
  private _resPanelHit: { colStartX: number; hdrY: number; colW: number; hdrH: number; count: number; headers: string[] } | null = null;
  /** Cached from last render frame — used by handleRightClick for hotbar hit-testing. */
  private _cachedHelmActiveGroup: number = -1;
  private _cachedControlGroups: Map<number, WeaponGroupState> | null = null;

  // ── Ghost build menu state ─────────────────────────────────────────────────
  private buildMenuOpen = false;
  private buildMenuGhosts: GhostPlacement[] = [];
  private buildMenuPending: GhostModuleKind | null = null;
  /** Left plan-menu panel (ship + land build). Hidden by default; toggle with Y. */
  public buildSidePanelVisible = false;
  /** Called when player clicks a module type in the left build panel. */
  public onBuildPanelSelect: ((kind: GhostModuleKind) => void) | null = null;

  // ── Land build menu state ─────────────────────────────────────────────────
  private landBuildMenuOpen = false;
  private _pendingLandBuildKind: string | null = null;
  /** Called when player selects a land structure from the Plan Menu (left panel). */
  public onLandBuildPanelSelect: ((kind: string) => void) | null = null;
  /** Called when player selects (or deselects) a slot in the Build Schematic Hotbar (bottom). */
  public onBuildSchematicSelect: ((kind: string | null) => void) | null = null;
  /** Per-kind ghost counts for badge display in the land build panel. */
  private _landGhostCounts: Map<string, number> = new Map();
  /** Total number of pending land ghost placements. */
  private get _totalLandGhosts(): number {
    let n = 0; this._landGhostCounts.forEach(v => n += v); return n;
  }

  /** Update the pending ghost counts per land structure kind. */
  setLandGhostCounts(counts: Map<string, number>): void {
    this._landGhostCounts = counts;
  }

  // Entries shown in the left land build panel
  static readonly LAND_BUILD_PANEL_ENTRIES: Array<{
    kind: string; label: string; symbol: string; color: string; borderColor: string;
    cost: { item: string; qty: number }[];
  }> = [
    { kind: 'wooden_floor', label: 'Floor',        symbol: '\u229f',       color: '#8b6914', borderColor: '#5c4008', cost: [{ item: 'wood',  qty: 40  }] },
    { kind: 'wall',         label: 'Wall',          symbol: '\u258b',       color: '#7a6030', borderColor: '#4a3818', cost: [{ item: 'wood',  qty: 20  }] },
    { kind: 'door',         label: 'Door',          symbol: '\uD83D\uDEAA', color: '#7a5838', borderColor: '#4a3010', cost: [{ item: 'wood',  qty: 8   }] },
    { kind: 'wood_ceiling', label: 'Ceiling',       symbol: '\u229e',       color: '#7a5c2a', borderColor: '#4a3410', cost: [{ item: 'wood',  qty: 25  }] },
    { kind: 'workbench',    label: 'Workbench',     symbol: '\u2692',       color: '#6a4a20', borderColor: '#3a2808', cost: [{ item: 'wood',  qty: 12  }] },
    { kind: 'chest',        label: 'Chest',         symbol: '\u229f',       color: '#7a4820', borderColor: '#4a2810', cost: [{ item: 'wood',  qty: 12  }] },
    { kind: 'bed',          label: 'Bed',           symbol: '\uD83D\uDECF', color: '#4a3060', borderColor: '#2a1840', cost: [{ item: 'wood',  qty: 10  }, { item: 'fiber', qty: 5 }] },
    { kind: 'shipyard',     label: 'Shipyard',      symbol: '\u26F5',       color: '#1e6080', borderColor: '#0f3850', cost: [{ item: 'wood',  qty: 250 }, { item: 'stone', qty: 100 }] },
    { kind: 'cannon',       label: 'Cannon',        symbol: '\u26AB',       color: '#444444', borderColor: '#888888', cost: [{ item: 'wood',  qty: 15  }, { item: 'metal', qty: 25  }] },
    { kind: 'flag_fort',     label: 'Flag Fortress', symbol: '\u2302',      color: '#5a5848', borderColor: '#2a2820', cost: [{ item: 'wood',  qty: 300 }, { item: 'stone', qty: 200 }] },
  ];

  // Entries shown in the left build panel (shared with PlayerMenu ship schematics)
  static readonly BUILD_PANEL_ENTRIES = SHIP_BUILD_PANEL_ENTRIES;

  /** Plan Menu entries — same as BUILD_PANEL_ENTRIES but without plank/deck (placed via schematics). */
  static readonly PLAN_PANEL_ENTRIES = UIManager.BUILD_PANEL_ENTRIES.filter(
    e => e.kind !== 'plank' && e.kind !== 'deck'
  );

  private static readonly BUILD_PANEL_W = 192;
  private static readonly BUILD_PANEL_ENTRY_H = 54;
  private static readonly BUILD_PANEL_HEADER_H = 32;

  // ── Hammer / bucket timing minigame state ─────────────────────────────────
  private hammerGame: {
    active:          boolean;
    theme:           'hammer' | 'bucket';
    startTime:       number;   // performance.now() when minigame began
    duration:        number;   // ms for cursor to travel full track
    sweetspotStart:  number;   // 0..1 — left edge of green zone
    sweetspotWidth:  number;   // 0..1 — width of green zone
    callback:        ((won: boolean) => void) | null;
    resultTime:      number;   // performance.now() when player struck; -1 = not yet
    won:             boolean | null;
  } = {
    active: false, theme: 'hammer', startTime: 0, duration: 1250,
    sweetspotStart: 0, sweetspotWidth: 0,
    callback: null, resultTime: -1, won: null,
  };

  // ── Build hotbar (replaces regular hotbar visually in ship build mode) ─────
  /** 8 schematic slots; each entry is the GhostModuleKind (or null = empty). */
  public get buildHotbarSlots(): (GhostModuleKind | null)[] {
    return (this.elements.get(UIElementType.HUD) as HUDElement | undefined)?.buildHotbarSlots ?? [];
  }
  public set buildHotbarSlots(v: (GhostModuleKind | null)[]) {
    const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (hud) hud.buildHotbarSlots = v;
  }
  /** Currently selected build hotbar slot (0–7). */
  public get buildHotbarActiveSlot(): number {
    return (this.elements.get(UIElementType.HUD) as HUDElement | undefined)?.buildHotbarActiveSlot ?? 0;
  }
  public set buildHotbarActiveSlot(v: number) {
    const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (hud) hud.buildHotbarActiveSlot = v;
  }
  /** Set to true by ClientApplication when ship build mode is active. */
  public get inShipBuildMode(): boolean {
    return (this.elements.get(UIElementType.HUD) as HUDElement | undefined)?.inShipBuildMode ?? false;
  }
  public set inShipBuildMode(v: boolean) {
    const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (hud) hud.inShipBuildMode = v;
  }
  public get inLandBuildMode(): boolean {
    return (this.elements.get(UIElementType.HUD) as HUDElement | undefined)?.inLandBuildMode ?? false;
  }
  public set inLandBuildMode(v: boolean) {
    const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (hud) hud.inLandBuildMode = v;
  }
  public get selectedLandKind(): string | null {
    return (this.elements.get(UIElementType.HUD) as HUDElement | undefined)?.selectedLandKind ?? null;
  }
  public set selectedLandKind(v: string | null) {
    const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (hud) hud.selectedLandKind = v;
  }
  /** Land schematic hotbar slots (8 slots, kind string or null). */
  public get landHotbarSlots(): (string | null)[] {
    return (this.elements.get(UIElementType.HUD) as HUDElement | undefined)?.landHotbarSlots ?? [];
  }
  public set landHotbarSlots(v: (string | null)[]) {
    const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (hud) hud.landHotbarSlots = v;
  }
  /** Callback fired when the player selects a new build hotbar slot. */
  public onBuildHotbarSlotChange: ((slot: number, kind: GhostModuleKind | null) => void) | null = null;

  // ── Drop item picker (hold-E near pile) ───────────────────────────────────
  private _dropPicker: {
    open: boolean;
    items: DroppedItem[];
    scrollY: number;
  } = { open: false, items: [], scrollY: 0 };

  // ── Schematic slot picker (click empty land hotbar slot) ──────────────────
  private _schematicPicker: { open: boolean; slotIdx: number; anchorX: number; anchorY: number } =
    { open: false, slotIdx: 0, anchorX: 0, anchorY: 0 };
  private _schematicPickerHits: { kind: string; x: number; y: number; w: number; h: number }[] = [];

  // ── Ship module picker (click empty ship build hotbar slot) ───────────────
  private _shipModulePicker: { open: boolean; slotIdx: number; anchorX: number; anchorY: number } =
    { open: false, slotIdx: 0, anchorX: 0, anchorY: 0 };
  private _shipModulePickerHits: { kind: GhostModuleKind; x: number; y: number; w: number; h: number }[] = [];

  /** Timestamp (performance.now()) until which the resource panel should remain visible after a resource gain. */
  private _resourceFlashUntil = 0;

  /** Timestamp when the resource panel started fading out, or null when it is fully visible. */
  private _resourceFadeOutStart: number | null = null;
  private static readonly RESOURCE_FADE_MS = 350;

  /** Per-resource row flash state: maps resource key → { until, direction } */
  private _resourceRowFlash = new Map<string, { until: number; dir: 'up' | 'down' }>();
  /** Per-column flash keyed as `${item}:${columnHeader}` (e.g. wood:YARD). */
  private _resourceCellFlash = new Map<string, { until: number; dir: 'up' | 'down' }>();

  /** Timestamp of last resource-source toggle (for the pop animation on the active column). */
  private _resourceSourceToggledAt = 0;

  markResourceSourceToggled(): void {
    this._resourceSourceToggledAt = performance.now();
  }

  /** Flash the resource panel visible for ~3 seconds (call when resources are gained). */
  flashResourcePanel(): void {
    this._resourceFlashUntil = performance.now() + 3000;
    this._resourceSourceToggledAt = performance.now();
  }

  /** Flash a specific resource row green (up) or red (down) for 1.2 seconds. Optional col flashes one column only. */
  flashResourceRow(item: string, dir: 'up' | 'down', col?: string): void {
    this._resourceFlashUntil = Math.max(this._resourceFlashUntil, performance.now() + 3000);
    const flash = { until: performance.now() + 1200, dir };
    if (col) this._resourceCellFlash.set(`${item}:${col}`, flash);
    else this._resourceRowFlash.set(item, flash);
  }

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
      theme: 'hammer',
      startTime: performance.now(),
      duration: 1250,
      sweetspotStart: 0.20 + Math.random() * 0.50,
      sweetspotWidth: 0.16,
      callback,
      resultTime: -1,
      won: null,
    };
  }

  /** Bucket scoop uses the same timing minigame with bucket-themed UI. */
  startBucketMinigame(callback: (won: boolean) => void): void {
    if (this.hammerGame.active) return;
    this.hammerGame = {
      active: true,
      theme: 'bucket',
      startTime: performance.now(),
      duration: 1250,
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

  /** Called whenever a menu is opened — used by ClientApplication to exit free-camera mode. */
  public onMenuOpen: (() => void) | null = null;
  /** Fired when the Player (character/inventory) menu specifically opens. */
  public onPlayerMenuOpen: (() => void) | null = null;

  /**
   * Open one of the UIManager-owned menus by ID, closing any currently open menu first.
   * For menus owned by ClientApplication (crafting, shipyard, pause), call this to keep
   * activeMenuId in sync — pass the id and handle open/close yourself.
   */
  openMenu(id: MenuId): void {
    this.onMenuOpen?.();
    this.closeActiveMenu();
    this.activeMenuId = id;
    switch (id) {
      case MENU_ID.COMPANY: this.companyMenu.open(); break;
      case MENU_ID.PLAYER:  this.playerMenu.open(); this.onPlayerMenuOpen?.(); break;
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

  /** Open the respawn screen. Pass the current world ships, islands, placed structures, local company ID, and death position. */
  openRespawnScreen(
    nearbyShips: import('../../sim/Types.js').Ship[],
    islands: import('../../sim/Types.js').IslandDef[],
    placedStructures: readonly import('../../sim/Types.js').PlacedStructure[],
    localCompanyId: number,
    deathPos?: { x: number; y: number },
  ): void {
    this._islands = islands;
    this.respawnScreen.open(nearbyShips, islands, placedStructures, localCompanyId, deathPos);
  }

  setRespawnFriendlyFleet(ships: import('./RespawnScreen.js').RespawnMapShip[]): void {
    this.respawnScreen.setFriendlyFleet(ships);
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
  setRespawnConfirmedCallback(cb: (choice: import('./RespawnScreen.js').RespawnChoice) => void): void {
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
    if (this._resColDrag) this._resColDrag.dragX = x;
    if (this.tombstoneMenu.visible) this.tombstoneMenu.handleMouseMove(x, y);
    if (this.activeMenuId === MENU_ID.PLAYER) this.playerMenu.handleMouseMove(x, y);
    if (this.salvageMenu.visible) this.salvageMenu.handleMouseMove(x, y);
    if (this.respawnScreen.visible) this.respawnScreen.handleMouseMove(x, y);
    this.manningPanel.handleMouseMove(x, y);
    this.worldMapScreen.handleMouseMove(x, y);
  }

  /** Notify world map / respawn screen of mouse-up to end drag. */
  handleWorldMapMouseUp(x = 0, y = 0): void {
    if (this._resColDrag) {
      const rph = this._resPanelHit;
      if (rph && rph.count > 1) {
        const relX = x - rph.colStartX;
        const rawCi = Math.round(relX / rph.colW - 0.5);
        const targetCi = Math.max(0, Math.min(rph.count - 1, rawCi));
        const srcCi = rph.headers.indexOf(this._resColDrag.header);
        if (srcCi !== -1 && targetCi !== srcCi) {
          // Reorder the visible headers
          const visibleHeaders = [...rph.headers];
          const newVisibleOrder = [...visibleHeaders];
          newVisibleOrder.splice(srcCi, 1);
          newVisibleOrder.splice(targetCi, 0, visibleHeaders[srcCi]);
          // Rebuild columnOrder: replace positions of visible headers in-place
          const newOrder = [...this.columnOrder];
          let vi = 0;
          for (let i = 0; i < newOrder.length; i++) {
            if (visibleHeaders.includes(newOrder[i])) newOrder[i] = newVisibleOrder[vi++];
          }
          this.columnOrder = newOrder;
        }
      }
      this._resColDrag = null;
    }
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
    if (this.activeMenuId === MENU_ID.SHIP)   return this.shipMenu.handleWheel(deltaY, x, y) ||
      this.shipSchematicPoolMenu.handleWheel(deltaY, x, y);
    return this.worldMapScreen.handleWheel(deltaY, x, y);
  }

  /**
   * Route a keydown event.  Returns true if the minigame consumed the key.
   * Call this from the application keydown handler before processing game input.
   */
  handleKeyDown(key: string): boolean {
    // Company menu key routing is handled exclusively by onKeyDown (the window listener)
    // to avoid double-processing. Only handle non-company-menu cases here.
    if (key === 'Escape' && this._schematicPicker.open) {
      this._schematicPicker.open = false;
      return true;
    }
    if (key === 'Escape' && this._shipModulePicker.open) {
      this._shipModulePicker.open = false;
      return true;
    }
    if (key === 'Escape' && this._dropPicker.open) {
      this._dropPicker.open = false;
      return true;
    }
    if (key === 'Escape' && this.tombstoneMenu.visible) {
      this.tombstoneMenu.close();
      return true;
    }
    if (this.playerMenu.visible && this.playerMenu.handleKeyDown(key)) return true;
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
   * Also handles right-click equip of armor items in the player menu inventory.
   */
  handleRightClick(x: number, y: number): boolean {
    // Land build hotbar right-click: clear filled slot / open picker for empty slot
    if (this.inLandBuildMode) {
      const N_SLOTS = this.landHotbarSlots.length;
      const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
      const totalW = N_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
      const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
      const startX = Math.round((this.canvas.width - totalW) / 2);
      const startY = this.canvas.height - totalH - 8;
      if (y >= startY + PADDING && y <= startY + PADDING + SLOT_SIZE) {
        for (let i = 0; i < N_SLOTS; i++) {
          const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
          if (x >= sx && x <= sx + SLOT_SIZE) {
            const kind = this.landHotbarSlots[i] ?? null;
            if (kind !== null) {
              // Clear this slot and deselect if it was active
              const slots = [...this.landHotbarSlots];
              slots[i] = null;
              this.landHotbarSlots = slots;
              if (this.selectedLandKind === kind) {
                this.selectedLandKind = null;
                this.onBuildSchematicSelect?.(null);
              }
            } else {
              // Empty slot — open schematic picker
              const slotCx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2;
              this._schematicPicker = { open: true, slotIdx: i, anchorX: slotCx, anchorY: startY };
            }
            return true;
          }
        }
      }
    }

    // Player menu open — check inventory for armor right-click equip first
    if (this.activeMenuId === MENU_ID.PLAYER && this.playerMenu.visible) {
      const inv = this.getPlayerInventory?.() ?? null;
      if (inv && this.playerMenu.handleRightClick(x, y, inv)) return true;
    }

    // Ship build hotbar right-click: clear filled slot / open picker for empty slot
    if (this.inShipBuildMode) {
      const BUILD_SLOTS = 8;
      const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
      const totalW = BUILD_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
      const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
      const startX = Math.round((this.canvas.width - totalW) / 2);
      const startY = this.canvas.height - totalH - 8;
      if (y >= startY + PADDING && y <= startY + PADDING + SLOT_SIZE) {
        for (let i = 0; i < BUILD_SLOTS; i++) {
          const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
          if (x >= sx && x <= sx + SLOT_SIZE) {
            const kind = this.buildHotbarSlots[i] ?? null;
            if (kind !== null) {
              // Clear this slot
              const slots = [...this.buildHotbarSlots];
              slots[i] = null;
              this.buildHotbarSlots = slots;
              this._saveHotbars();
              // Deselect if it was the active slot
              if (this.buildHotbarActiveSlot === i) {
                this.buildHotbarActiveSlot = -1;
                this.onBuildHotbarSlotChange?.(i, null);
              }
            } else {
              // Empty slot — open ship module picker above this slot
              const slotCx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2;
              this._shipModulePicker = { open: true, slotIdx: i, anchorX: slotCx, anchorY: startY };
            }
            return true;
          }
        }
      }
    }

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
        const groupIdx = i; // slot 0→G0 (Port), slot 1→G1 (Starboard), …, slot 9→G9
        const state = this._cachedControlGroups.get(groupIdx);
        if (!state) return false;
        const CYCLE: WeaponGroupMode[] = ['freefire', 'haltfire', 'targetfire'];
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
    // Cache player level/xp for XP bar click detection in handleClick
    const _localPlayerForCache = context.worldState.players.find(p => p.id === context.assignedPlayerId)
      ?? context.worldState.players[0];
    if (_localPlayerForCache) {
      this._cachedPlayerLevel = _localPlayerForCache.level ?? 1;
      this._cachedPlayerXp    = _localPlayerForCache.xp    ?? 0;
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
    // Provide current hotbar slot arrays to the player menu before render
    const _hudEl = this.elements.get(UIElementType.HUD) as HUDElement | undefined;
    if (_hudEl) {
      this.playerMenu.landHotbarSlots = _hudEl.landHotbarSlots;
      this.playerMenu.shipHotbarSlots = _hudEl.buildHotbarSlots as (string | null)[];
    }
    this.playerMenu.render(ctx, context.worldState, context.assignedPlayerId, this.mouseX, this.mouseY);
    this.shipMenu.controlGroups = context.controlGroups ?? new Map();
    this.shipMenu.scaffoldedAtShipyardId = context.scaffoldedShipyardId ?? 0;
    this.shipMenu.render(ctx, context.worldState, context.assignedPlayerId);
    this.shipSchematicPoolMenu.render(ctx);
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
      if (!this.buildModeState?.active) {
        this.renderShipPlanModeBanner(ctx, ctx.canvas);
      }
      if (this.buildSidePanelVisible) {
        this.renderBuildMenuPanel(ctx, ctx.canvas);
      }
    }

    // Land build panel — left side of screen
    if (this.landBuildMenuOpen) {
      this.renderLandBuildModeBanner(ctx, ctx.canvas);
      if (this.buildSidePanelVisible) {
        this.renderLandBuildMenuPanel(ctx, ctx.canvas);
      }
    }

    // Resource panel — shown independently (flash on gain, hammer, build mode, etc.)
    this.renderResourcePanel(ctx, ctx.canvas);

    // Hammer minigame — topmost overlay, blocks all game input when active
    if (this.hammerGame.active) {
      this.renderHammerMinigame(ctx, ctx.canvas);
    }

    // World map — below respawn screen so respawn screen still covers it
    if (this.worldMapScreen.visible) {
      const ws = context.worldState;
      const localPlayer = ws.players.find(p => p.id === context.assignedPlayerId);
      const companyId = localPlayer?.companyId ?? 0;
      this.worldMapScreen.render(ctx, ws.ships, this._islands, ws.players, context.assignedPlayerId, companyId, context.altHeld ?? false);
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

    // Schematic slot picker — above hotbar
    if (this._schematicPicker.open) {
      this._renderSchematicPicker(ctx);
    }

    // Ship module picker — above build hotbar
    if (this._shipModulePicker.open) {
      this._renderShipModulePicker(ctx);
    }

    // Tombstone menu — rendered above everything else
    if (this.tombstoneMenu.visible) {
      this.tombstoneMenu.render(ctx);
    }

    // ── Suffocation / low-oxygen vignette ─────────────────────────────────
    // Shown while swimming with stamina = 0 and oxygen < max.
    // Deepens from a subtle blue tint to a full dark overlay as oxygen depletes.
    {
      const _vigPlayer = context.worldState.players.find(p => p.id === context.assignedPlayerId)
        ?? context.worldState.players[0];
      if (_vigPlayer) {
        const _vigO2    = _vigPlayer.oxygen    ?? (_vigPlayer.maxOxygen ?? 100);
        const _vigMaxO2 = _vigPlayer.maxOxygen ?? 100;
        const _vigSt    = _vigPlayer.stamina   ?? (_vigPlayer.maxStamina ?? 100);
        const _isSwim   = _vigPlayer.movementState === 'SWIMMING';
        if (_isSwim && _vigSt <= 0 && _vigO2 < _vigMaxO2) {
          const _depleted = _vigMaxO2 > 0 ? 1 - _vigO2 / _vigMaxO2 : 1;
          // Alpha: 0 at full O2, up to 0.75 when depleted
          const _vigAlpha = _depleted * 0.75;
          // Pulse the vignette when critically low (O2 < 25%)
          const _pulse = (_vigO2 / _vigMaxO2 < 0.25)
            ? 0.7 + 0.3 * Math.sin(performance.now() / 200) : 1;
          ctx.save();
          const _cw = ctx.canvas.width, _ch = ctx.canvas.height;
          // Radial gradient: dark blue edges → transparent centre
          const _grad = ctx.createRadialGradient(
            _cw / 2, _ch / 2, _ch * 0.15,
            _cw / 2, _ch / 2, _ch * 0.72,
          );
          _grad.addColorStop(0, 'rgba(0,20,60,0)');
          _grad.addColorStop(1, `rgba(0,10,40,${(_vigAlpha * _pulse).toFixed(3)})`);
          ctx.fillStyle = _grad;
          ctx.fillRect(0, 0, _cw, _ch);
          // Thin bright-blue border ring when nearly suffocating
          if (_vigO2 / _vigMaxO2 < 0.25) {
            ctx.strokeStyle = `rgba(30,160,255,${(0.25 * _pulse).toFixed(3)})`;
            ctx.lineWidth = 6;
            ctx.strokeRect(0, 0, _cw, _ch);
          }
          ctx.restore();
        }
      }
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

  /** Set callback for weapon group rename rows in the ship settings panel. */
  setGroupRenameCallback(cb: (shipId: number, groupIndex: number, currentName: string) => void): void {
    this.shipMenu.onGroupRename = cb;
  }

  /** Set callback for the "Release Ship" button in the ship settings panel (shown when docked at a shipyard). */
  setShipReleaseCallback(cb: (shipId: number, shipyardId: number) => void): void {
    this.shipMenu.onReleaseShipRequest = cb;
  }

  /** Set callback for deck demolish buttons in the ship status menu. */
  setShipDemolishDeckCallback(cb: (shipId: number, moduleId: number, deckLevel: number) => void): void {
    this.shipMenu.onDemolishDeck = cb;
  }

  /** Open the ship schematic pool overlay from the ship status menu. */
  setShipSchematicPoolOpenCallback(cb: (shipId: number) => void): void {
    this.shipMenu.onOpenSchematicPool = cb;
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
   * Wire the level-up callback from the player menu to the UIManager handler.
   * Called once during setup so the LEVEL UP button in the player menu fires
   * the same action as clicking the XP bar above the hotbar.
   */
  syncPlayerLevelUpCallback(): void {
    this.playerMenu.onPlayerLevelUp = () => this.onPlayerLevelUp?.();
    // Wire hotbar slot assignment callbacks so the schematics tab can edit hotbars
    this.playerMenu.onSetLandHotbarSlot = (idx, kind) => {
      const slots = this.landHotbarSlots;
      if (idx >= 0 && idx < slots.length) { slots[idx] = kind; this._saveHotbars(); }
    };
    this.playerMenu.onSetShipHotbarSlot = (idx, kind) => {
      const slots = this.buildHotbarSlots;
      if (idx >= 0 && idx < slots.length) { slots[idx] = kind as (typeof slots)[0]; this._saveHotbars(); }
    };
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
    kind: 'wooden_floor' | 'workbench' | 'wall' | 'door_frame' | 'door' | 'shipyard' | 'wood_ceiling' | 'cannon' | 'flag_fort' | 'company_fortress' | 'claim_flag' | 'chest' | 'bed';
    tooFar: boolean;
    enemyClose: boolean;
    wallVariant?: 'wall' | 'door_frame';
  } | null): void {
    this.islandBuildState = state;
  }

  /** Open or close the land build panel and track the currently selected kind. */
  setLandBuildMenuState(open: boolean, selectedKind: string | null): void {
    const wasOpen = this.landBuildMenuOpen;
    this.landBuildMenuOpen = open;
    this._pendingLandBuildKind = selectedKind;
    this.selectedLandKind = selectedKind;
    if (open && !wasOpen) this.buildSidePanelVisible = false;
  }

  /** Toggle the left plan-menu panel while ship or land build mode is active. */
  toggleBuildSidePanel(): void {
    this.buildSidePanelVisible = !this.buildSidePanelVisible;
  }

  /**
   * Clear only the Plan Menu row highlight without touching the Build Schematic Hotbar.
   * Used by mutual-exclusion logic when the hotbar takes priority.
   */
  clearPlanKind(): void {
    this._pendingLandBuildKind = null;
  }

  /**
   * Update ghost build menu state (called by ClientApplication on each change).
   */
  setBuildMenuState(
    open: boolean,
    ghosts: GhostPlacement[],
    pending: GhostModuleKind | null
  ): void {
    const wasOpen = this.buildMenuOpen;
    this.buildMenuOpen = open;
    this.buildMenuGhosts = ghosts;
    this.buildMenuPending = pending;
    if (open && !wasOpen) this.buildSidePanelVisible = false;
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
    // Schematic slot picker intercepts all clicks when open
    if (this._schematicPicker.open) {
      // Check if a schematic entry was hit
      for (const hit of this._schematicPickerHits) {
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          const slots = [...this.landHotbarSlots];
          slots[this._schematicPicker.slotIdx] = hit.kind;
          this.landHotbarSlots = slots;
          this._schematicPicker.open = false;
          return true;
        }
      }
      // Click outside — close
      this._schematicPicker.open = false;
      return true;
    }
    // Ship module picker intercepts all clicks when open
    if (this._shipModulePicker.open) {
      for (const hit of this._shipModulePickerHits) {
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          const slots = [...this.buildHotbarSlots];
          slots[this._shipModulePicker.slotIdx] = hit.kind;
          this.buildHotbarSlots = slots;
          this._shipModulePicker.open = false;
          this._saveHotbars();
          return true;
        }
      }
      // Click outside — close
      this._shipModulePicker.open = false;
      return true;
    }
    // Drop picker intercepts all clicks when open
    if (this._dropPicker.open) {
      return this.handleDropPickerClick(x, y);
    }
    // Resource panel column header drag start
    {
      const rph = this._resPanelHit;
      if (rph && rph.count > 1) {
        const relX = x - rph.colStartX;
        const relY = y - rph.hdrY;
        if (relX >= 0 && relX < rph.count * rph.colW && Math.abs(relY) <= rph.hdrH / 2 + 3) {
          const ci = Math.floor(relX / rph.colW);
          if (ci >= 0 && ci < rph.count) {
            this._resColDrag = { header: rph.headers[ci], dragX: x };
            return true;
          }
        }
      }
    }
    // Land build hotbar slot click — selects (or deselects) the Build Schematic Hotbar slot
    if (this.inLandBuildMode) {
      const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;

      // Variant popup absorbs clicks first (even outside the popup rows, to dismiss)
      if (hud?.handleVariantPopupClick(x, y)) return true;

      const N_SLOTS = this.landHotbarSlots.length;
      const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
      const totalW = N_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
      const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
      const startX = Math.round((this.canvas.width - totalW) / 2);
      const startY = this.canvas.height - totalH - 8;
      if (y >= startY + PADDING && y <= startY + PADDING + SLOT_SIZE) {
        for (let i = 0; i < N_SLOTS; i++) {
          const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
          if (x >= sx && x <= sx + SLOT_SIZE) {
            const kind = this.landHotbarSlots[i] ?? null;
            if (kind !== null) {
              if (this.selectedLandKind === kind) {
                // Re-clicking the active slot: open variant picker if blueprints exist,
                // otherwise deselect
                const variants = hud?.getVariantsForKind(kind) ?? [];
                if (variants.length > 0) {
                  const slotCx = sx + SLOT_SIZE / 2;
                  hud?.openVariantPopup(kind, slotCx, startY);
                } else {
                  this.selectedLandKind = null;
                  this.onBuildSchematicSelect?.(null);
                }
              } else {
                // Select this slot
                this.selectedLandKind = kind;
                this.onBuildSchematicSelect?.(kind);
                hud?.closeVariantPopup();
              }
            } else {
              // Empty slot — open inline schematic picker above this slot
              const slotCx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2;
              this._schematicPicker = { open: true, slotIdx: i, anchorX: slotCx, anchorY: startY };
              hud?.closeVariantPopup();
            }
            return true;
          }
        }
      }
    }
    // Land build panel (left side) — check before ship build panel
    if (this.landBuildMenuOpen && this.buildSidePanelVisible) {
      if (this.handleLandBuildPanelClick(x, y)) return true;
    }
    // Build panel (left side) — check before other panels
    if (this.buildMenuOpen && this.buildSidePanelVisible) {
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
      if (this.shipSchematicPoolMenu.visible) {
        if (this.shipSchematicPoolMenu.handleClick(x, y)) return true;
      }
      // Forward to shipMenu — returns true if inside panel (upgrade click or panel area)
      const consumed = this.shipMenu.handleClick(x, y);
      if (!consumed) this.closeActiveMenu();
      return true;
    }
    // Hotbar left-click slot selection (only when no menu/build mode is consuming)
    // Build hotbar click — when in ship build mode, clicks on hotbar area select schematic slots
    if (this.inShipBuildMode) {
      const hud = this.elements.get(UIElementType.HUD) as HUDElement | undefined;

      // Variant popup absorbs clicks first (even outside the popup rows, to dismiss)
      if (hud?.handleVariantPopupClick(x, y)) return true;

      const BUILD_SLOTS = 8;
      const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
      const totalW = BUILD_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
      const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
      const startX = Math.round((this.canvas.width - totalW) / 2);
      const startY = this.canvas.height - totalH - 8;
      if (y >= startY + PADDING && y <= startY + PADDING + SLOT_SIZE) {
        for (let i = 0; i < BUILD_SLOTS; i++) {
          const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
          if (x >= sx && x <= sx + SLOT_SIZE) {
            const kind = this.buildHotbarSlots[i] ?? null;
            if (kind !== null) {
              if (this.buildHotbarActiveSlot === i) {
                // Re-clicking the active slot: open variant picker if blueprints exist,
                // otherwise deselect the slot
                const variants = hud?.getVariantsForKind(kind) ?? [];
                if (variants.length > 0) {
                  const slotCx = sx + SLOT_SIZE / 2;
                  hud?.openVariantPopup(kind, slotCx, startY);
                } else {
                  this.buildHotbarActiveSlot = -1;
                  this.onBuildHotbarSlotChange?.(i, null);
                }
              } else {
                this.buildHotbarActiveSlot = i;
                this.onBuildHotbarSlotChange?.(i, kind);
                hud?.closeVariantPopup();
              }
            } else {
              // Empty slot — open ship module picker above this slot
              const slotCx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2;
              this._shipModulePicker = { open: true, slotIdx: i, anchorX: slotCx, anchorY: startY };
              hud?.closeVariantPopup();
            }
            return true;
          }
        }
      }
    }

    if (this.onHotbarSlotClick && !this._cachedControlGroups) {
      const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
      const totalW = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
      const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
      const startX = Math.round((this.canvas.width - totalW) / 2);
      const hotbarY = this.canvas.height - totalH - 8;

      // XP bar click — check ABOVE the hotbar in the stats panel
      const XP_BAR_H = 6, GAP = 3, BAR_H = 10, PANEL_PAD = 4;
      const panelH = PANEL_PAD * 2 + XP_BAR_H + GAP + BAR_H * 2 + GAP;
      const panelY = hotbarY - panelH - 4;
      const barX   = startX + PANEL_PAD;
      const barW   = totalW - PANEL_PAD * 2;
      if (x >= barX && x <= barX + barW && y >= panelY + PANEL_PAD && y <= panelY + PANEL_PAD + XP_BAR_H + 4) {
        const PLAYER_MAX_LEVEL = 120;
        const lvl = this._cachedPlayerLevel;
        const xp  = this._cachedPlayerXp;
        const xpToNext = lvl * 100;
        const canLevelUp = lvl < PLAYER_MAX_LEVEL && xp >= xpToNext;
        if (canLevelUp && this.onPlayerLevelUp) {
          this.onPlayerLevelUp();
          return true;
        }
      }

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
    const entries = UIManager.PLAN_PANEL_ENTRIES;
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
   * Handle a click on the left-side land build panel.
   * Returns true if the click landed inside the panel.
   */
  private handleLandBuildPanelClick(x: number, y: number): boolean {
    const W = UIManager.BUILD_PANEL_W;
    const ENTRY_H = UIManager.BUILD_PANEL_ENTRY_H;
    const HEADER_H = UIManager.BUILD_PANEL_HEADER_H;
    const entries = UIManager.LAND_BUILD_PANEL_ENTRIES;
    const totalH = HEADER_H + entries.length * ENTRY_H + 8;
    const panelY = (this.canvas.height - totalH) / 2;

    if (x < 0 || x > W || y < panelY || y > panelY + totalH) {
      // Click outside panel closes it
      if (x > W) {
        this.onLandBuildPanelSelect?.(this._pendingLandBuildKind ?? '');
        // Let caller close via callback; don't consume click
      }
      return false;
    }

    const relY = y - panelY - HEADER_H;
    if (relY < 0) return true; // clicked header area

    const idx = Math.floor(relY / ENTRY_H);
    if (idx >= 0 && idx < entries.length) {
      this._pendingLandBuildKind = entries[idx].kind;
      this.onLandBuildPanelSelect?.(entries[idx].kind);
    }
    return true;
  }

  /**
   * Top banner for ship plan mode (shown even when the left panel is hidden).
   */
  private renderShipPlanModeBanner(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const BANNER_H = 40;
    const cw = canvas.width;
    const panelHint = this.buildSidePanelVisible ? '[Y] Hide Plan Menu' : '[Y] Plan Menu';
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
      `\uD83D\uDCCB  PLAN MODE  \u2014  ${panelHint}  |  Hotbar: build  |  [B] Exit  |  [Click] Place Ghost`,
      cw / 2, BANNER_H / 2
    );
    ctx.restore();
  }

  /**
   * Top banner for land build mode (shown even when the left panel is hidden).
   */
  private renderLandBuildModeBanner(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const BANNER_H = 40;
    const cw = canvas.width;
    const panelHint = this.buildSidePanelVisible ? '[Y] Hide Plan Menu' : '[Y] Plan Menu';
    ctx.save();
    const bannerGrad = ctx.createLinearGradient(0, 0, 0, BANNER_H);
    bannerGrad.addColorStop(0, '#3d2800');
    bannerGrad.addColorStop(1, '#1e1200');
    ctx.fillStyle = bannerGrad;
    ctx.fillRect(0, 0, cw, BANNER_H);
    ctx.strokeStyle = '#cc8833';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, BANNER_H);
    ctx.lineTo(cw, BANNER_H);
    ctx.stroke();
    ctx.font = 'bold 18px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffcc66';
    const ghostHint = this._totalLandGhosts > 0
      ? `  |  [RMB] Remove  |  [Enter] Build All (${this._totalLandGhosts})`
      : '';
    ctx.fillText(
      `\uD83C\uDFD7  LAND BUILD  \u2014  ${panelHint}  |  Hotbar: build ghosts  |  [B] Exit${ghostHint}`,
      cw / 2, BANNER_H / 2
    );
    ctx.restore();
  }

  /**
   * Render the land build panel on the left side of the screen.
   */
  private renderLandBuildMenuPanel(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const W      = UIManager.BUILD_PANEL_W;
    const EH     = UIManager.BUILD_PANEL_ENTRY_H;
    const HH     = UIManager.BUILD_PANEL_HEADER_H;
    const PAD    = 10;
    const entries = UIManager.LAND_BUILD_PANEL_ENTRIES;
    const totalH = HH + entries.length * EH + 8;
    const px     = 0;
    const py     = Math.round((canvas.height - totalH) / 2);

    ctx.save();

    // Panel background
    ctx.fillStyle = 'rgba(14,10,4,0.90)';
    ctx.strokeStyle = 'rgba(180,130,50,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, W, totalH, [0, 8, 8, 0]);
    ctx.fill();
    ctx.stroke();

    // Header
    ctx.fillStyle = 'rgba(60,40,10,0.90)';
    ctx.beginPath();
    ctx.roundRect(px, py, W, HH, [0, 8, 0, 0]);
    ctx.fill();
    ctx.fillStyle = '#ffcc66';
    ctx.font = 'bold 12px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📋  Plan Menu  [B]', px + W / 2, py + HH / 2);

    // Entries
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const ey = py + HH + i * EH;
      const isPending = this._pendingLandBuildKind === e.kind;
      const isHovered = this.mouseX >= px && this.mouseX < px + W
        && this.mouseY >= ey && this.mouseY < ey + EH;

      // Row background
      if (isPending) {
        ctx.fillStyle = 'rgba(180,100,20,0.30)';
      } else if (isHovered) {
        ctx.fillStyle = 'rgba(120,80,20,0.22)';
      } else {
        ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent';
      }
      ctx.fillRect(px + 2, ey + 1, W - 4, EH - 2);

      // Color swatch circle
      const swatchX = px + PAD + 10;
      const swatchY = ey + EH / 2;
      const swatchR = 10;
      ctx.fillStyle = e.color;
      ctx.strokeStyle = isPending ? '#ffaa44' : e.borderColor;
      ctx.lineWidth = isPending ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(swatchX, swatchY, swatchR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Symbol
      ctx.fillStyle = '#fff';
      ctx.font = `${swatchR * 1.1}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.symbol, swatchX, swatchY + 1);

      // Label
      ctx.fillStyle = isPending ? '#ffcc66' : isHovered ? '#ffe0aa' : '#d0c8b0';
      ctx.font = isPending ? 'bold 13px Georgia, serif' : '13px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.label, swatchX + swatchR + 8, ey + EH / 2);

      // Ghost count badge
      const ghostCount = this._landGhostCounts.get(e.kind) ?? 0;
      if (ghostCount > 0) {
        const badgeText = `×${ghostCount}`;
        ctx.font = 'bold 11px monospace';
        const badgeW = ctx.measureText(badgeText).width + 8;
        const badgeX = px + W - 24 - badgeW;
        const badgeY = ey + (EH - 16) / 2;
        ctx.fillStyle = 'rgba(220,110,20,0.85)';
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#fff8e0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 8);
      }

      // Pending arrow
      if (isPending) {
        ctx.fillStyle = '#ffaa44';
        ctx.font = '13px Georgia, serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u25B6', px + W - 8, ey + EH / 2);
      }

      // Separator
      if (i < entries.length - 1) {
        ctx.strokeStyle = 'rgba(180,130,50,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 8, ey + EH);
        ctx.lineTo(px + W - 8, ey + EH);
        ctx.stroke();
      }
    }

    // Footer hint
    ctx.fillStyle = 'rgba(200,160,80,0.6)';
    ctx.font = '10px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      this._totalLandGhosts > 0
        ? `[R] rotate  [RMB] remove plan  \u25b6 [Enter] build all (${this._totalLandGhosts})`
        : '[R] rotate  [LMB] place plan  \u2502  select hotbar \u25b6 click ghost to build',
      px + W / 2, py + totalH - 6
    );


    ctx.restore();
  }

  /** Draw the resource panel (bottom-left corner) — shown whenever the build menu is
   *  open, build mode is active, the hammer is equipped, or resources were recently gained. */
  private renderResourcePanel(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    // Show if: land build menu open, build mode active, hammer equipped, or recently gained resources
    const inv = this.getPlayerInventory?.() ?? null;
    let showResources = false;
    if (this.landBuildMenuOpen || this.buildMenuOpen || this.buildMenuPending !== null || (this.buildModeState?.active)) {
      showResources = true;
    } else {
      const activeSlot = (inv as any)?.activeSlot ?? 0;
      const slots = inv?.slots ?? [];
      const activeItem = slots[activeSlot]?.item ?? 'none';
      if (activeItem === 'hammer') showResources = true;
      if (performance.now() < this._resourceFlashUntil) showResources = true;
    }
    let panelAlpha = 1.0;
    if (!showResources) {
      if (this._resourceFadeOutStart === null) this._resourceFadeOutStart = performance.now();
      const elapsed = performance.now() - this._resourceFadeOutStart;
      panelAlpha = 1.0 - elapsed / UIManager.RESOURCE_FADE_MS;
      if (panelAlpha <= 0) return;
    } else {
      this._resourceFadeOutStart = null;
    }

    const invRes   = (inv as any)?.resources as { wood: number; fiber: number; metal: number; stone: number } | undefined;
    const chestRes = this.getShipChestResources?.() ?? null;
    const yardRes  = this.getShipyardResources?.()  ?? null;

    const RES_ITEMS  = ['wood', 'fiber', 'stone', 'metal'] as const;
    const RES_LABELS: Record<string, string> = { wood: 'Wood', fiber: 'Fiber', stone: 'Stone', metal: 'Metal' };

    // Build active source columns (dynamic — only show present sources)
    type ResCol = { header: string; color: string; get: (item: string) => number };
    const allCols: ResCol[] = [
      { header: 'PACK',  color: '#cc9944', get: item => invRes  ? ((invRes  as any)[item] ?? 0) : 0 },
    ];
    if (chestRes !== null) allCols.push({ header: 'CHEST', color: '#66aadd', get: item => (chestRes as any)[item] ?? 0 });
    if (yardRes  !== null) allCols.push({ header: 'YARD',  color: '#66dd88', get: item => (yardRes  as any)[item] ?? 0 });
    // Sort by columnOrder (left=lowest, right=highest priority)
    const cols = [...allCols].sort((a, b) => {
      const ai = this.columnOrder.indexOf(a.header);
      const bi = this.columnOrder.indexOf(b.header);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    // Build cost map
    const costMap = new Map<string, number>();
    if (this.selectedLandKind) {
      const ent = UIManager.LAND_BUILD_PANEL_ENTRIES.find(e => e.kind === this.selectedLandKind);
      if (ent) for (const c of ent.cost) costMap.set(c.item, c.qty);
    }
    const hasCost = costMap.size > 0;

    // Panel dimensions — width grows with the number of columns
    const PAD      = 8;
    const ROW_H    = 16;
    const HDR_H    = 14;
    const TITLE_H  = 16;
    const SEP      = 2;
    const LABEL_W  = 68;
    const COL_W    = 42;
    const COST_W   = 44;
    const HOTBAR_H = 76;
    const RES_W    = PAD + LABEL_W + (hasCost ? COST_W : 0) + cols.length * COL_W + PAD;
    const resH     = TITLE_H + HDR_H + SEP + RES_ITEMS.length * ROW_H + PAD;
    const resX     = 8;
    const resY     = canvas.height - HOTBAR_H - 8 - resH - 6;

    ctx.save();
    ctx.globalAlpha = panelAlpha;

    // Panel background
    ctx.fillStyle   = 'rgba(14,10,4,0.90)';
    ctx.strokeStyle = 'rgba(180,130,50,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(resX, resY, RES_W, resH, 4);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.font         = 'bold 10px Georgia, serif';
    ctx.fillStyle    = '#ffcc66';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('RESOURCES', resX + PAD, resY + TITLE_H / 2);
    // [R] toggle hint — show when ship build mode is active and multiple pools exist
    if ((this.buildMenuOpen || this.buildModeState?.active) && (chestRes !== null || yardRes !== null)) {
      ctx.font      = '8px monospace';
      ctx.fillStyle = 'rgba(200,180,120,0.6)';
      ctx.textAlign = 'right';
      const _rHint = this.buildResourceSource === 'yard' ? 'YARD'
                   : this.buildResourceSource === 'ship' ? 'CHEST'
                   : this.buildResourceSource === 'pack' ? 'PACK' : 'AUTO';
      ctx.fillText(`[R] ${_rHint}`, resX + RES_W - PAD, resY + TITLE_H / 2);
    }

    // Column headers — highlight active resource source column
    const hdrY       = resY + TITLE_H + HDR_H / 2;
    const colStartX  = resX + PAD + LABEL_W + (hasCost ? COST_W : 0);

    // Cache hit-test info for drag handling
    this._resPanelHit = {
      colStartX, hdrY, colW: COL_W, hdrH: HDR_H,
      count: cols.length, headers: cols.map(c => c.header),
    };

    // Determine which column index is "active" for building
    const activeColHeader = this.buildResourceSource === 'yard' ? 'YARD'
                           : this.buildResourceSource === 'ship' ? 'CHEST'
                           : this.buildResourceSource === 'pack' ? 'PACK' : null;
    const activeColIdx = cols.findIndex(c => c.header === activeColHeader);

    ctx.font      = 'bold 9px Georgia, serif';
    ctx.textAlign = 'center';
    if (hasCost) {
      ctx.fillStyle = '#ff6666';
      ctx.fillText('COST', resX + PAD + LABEL_W + COST_W / 2, hdrY);
    }
    for (let ci = 0; ci < cols.length; ci++) {
      const colCX = colStartX + ci * COL_W + COL_W / 2;
      if (ci === activeColIdx) {
        // Pulse alpha — fades from 0.55 → 0.14 over 400 ms after source toggle
        const toggleAge = performance.now() - this._resourceSourceToggledAt;
        const PULSE_MS = 400;
        const pulseExtra = toggleAge < PULSE_MS ? 0.55 * (1 - toggleAge / PULSE_MS) : 0;
        // Draw highlight background spanning header + data rows
        ctx.fillStyle = `rgba(${cols[ci].color.slice(1,3) === 'ff' ? '255,200,40' : '60,140,220'},${(0.14 + pulseExtra).toFixed(2)})`;
        ctx.beginPath();
        ctx.roundRect(colStartX + ci * COL_W, resY + TITLE_H + 2, COL_W - 1, resH - TITLE_H - 4, 3);
        ctx.fill();
        // Bright border along top
        ctx.strokeStyle = cols[ci].color;
        ctx.lineWidth = 1.5 + (toggleAge < PULSE_MS ? 1.5 * (1 - toggleAge / PULSE_MS) : 0);
        ctx.beginPath();
        ctx.moveTo(colStartX + ci * COL_W + 2, resY + TITLE_H + 2);
        ctx.lineTo(colStartX + ci * COL_W + COL_W - 3, resY + TITLE_H + 2);
        ctx.stroke();
      }
      // Dim columns that are not the dragged one when a drag is active
      const isDragging = this._resColDrag !== null;
      const isDraggedCol = isDragging && this._resColDrag!.header === cols[ci].header;
      ctx.globalAlpha = panelAlpha * (isDragging && !isDraggedCol ? 0.45 : 1.0);
      ctx.fillStyle = ci === activeColIdx ? '#ffffff' : cols[ci].color;
      ctx.fillText(cols[ci].header, colCX, hdrY);
      ctx.globalAlpha = panelAlpha;
    }
    // Drag indicator: vertical line at current drag position
    if (this._resColDrag) {
      const dx = Math.max(colStartX, Math.min(colStartX + cols.length * COL_W, this._resColDrag.dragX));
      const dragColor = cols.find(c => c.header === this._resColDrag!.header)?.color ?? '#ffffff';
      ctx.strokeStyle = dragColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(dx, resY + TITLE_H + 2);
      ctx.lineTo(dx, resY + resH - 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Separator
    const sepY = resY + TITLE_H + HDR_H + SEP;
    ctx.strokeStyle = 'rgba(180,130,50,0.30)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(resX + 4, sepY);
    ctx.lineTo(resX + RES_W - 4, sepY);
    ctx.stroke();

    // Data rows
    for (let i = 0; i < RES_ITEMS.length; i++) {
      const item = RES_ITEMS[i];
      const rowY = sepY + i * ROW_H + ROW_H / 2 + 2;

      // Row flash highlight
      const flash = this._resourceRowFlash.get(item);
      if (flash && performance.now() < flash.until) {
        const t     = 1 - (flash.until - performance.now()) / 1200;
        const alpha = 0.45 * (1 - t * t);
        ctx.fillStyle = flash.dir === 'up' ? `rgba(60,200,80,${alpha.toFixed(2)})` : `rgba(220,60,40,${alpha.toFixed(2)})`;
        ctx.fillRect(resX + 2, rowY - ROW_H / 2, RES_W - 4, ROW_H - 1);
      } else if (flash && performance.now() >= flash.until) {
        this._resourceRowFlash.delete(item);
      }

      // Label
      ctx.font         = '11px Georgia, serif';
      ctx.fillStyle    = '#c0b898';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(RES_LABELS[item], resX + PAD, rowY);

      // Cost column
      if (hasCost) {
        const costQty = costMap.get(item);
        ctx.font      = 'bold 11px Georgia, serif';
        ctx.textAlign = 'right';
        if (costQty !== undefined) {
          ctx.fillStyle = '#ff4444';
          ctx.fillText(`-${costQty}`, resX + PAD + LABEL_W + COST_W - 2, rowY);
        } else {
          ctx.fillStyle = 'rgba(100,60,60,0.4)';
          ctx.fillText('—', resX + PAD + LABEL_W + COST_W - 2, rowY);
        }
      }

      // Source columns
      ctx.font      = 'bold 11px Georgia, serif';
      ctx.textAlign = 'right';
      for (let ci = 0; ci < cols.length; ci++) {
        const val = cols[ci].get(item);
        const isActive = ci === activeColIdx;
        const cellFlash = this._resourceCellFlash.get(`${item}:${cols[ci].header}`);
        if (cellFlash && performance.now() < cellFlash.until) {
          const t     = 1 - (cellFlash.until - performance.now()) / 1200;
          const alpha = 0.55 * (1 - t * t);
          ctx.fillStyle = cellFlash.dir === 'up' ? `rgba(60,200,80,${alpha.toFixed(2)})` : `rgba(220,60,40,${alpha.toFixed(2)})`;
          ctx.fillRect(colStartX + ci * COL_W, rowY - ROW_H / 2, COL_W - 1, ROW_H - 1);
        } else if (cellFlash && performance.now() >= cellFlash.until) {
          this._resourceCellFlash.delete(`${item}:${cols[ci].header}`);
        }
        ctx.fillStyle = val > 0 ? (isActive ? '#ffffff' : cols[ci].color) : (isActive ? 'rgba(180,160,140,0.5)' : 'rgba(80,60,40,0.5)');
        ctx.fillText(String(val), colStartX + ci * COL_W + COL_W - 2, rowY);
      }
    }
    ctx.restore();
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
    const { kind, tooFar, enemyClose, wallVariant } = this.islandBuildState;

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
    const STRUCT_LABELS: Record<string, string> = {
      wooden_floor:      '\u229f WOODEN FLOOR',
      workbench:         '\u2692 WORKBENCH',
      wall:              '\u258b WALL',
      door_frame:        '\u2293 DOOR FRAME',
      door:              '\uD83D\uDEAA DOOR',
      wood_ceiling:      '\u229e CEILING',
      shipyard:          '\u26F5 SHIPYARD',
      cannon:            '\u26AB CANNON',
      flag_fort:         '\uD83D\uDEA9 FLAG FORT',
      company_fortress:  '\uD83C\uDFF0 FORTRESS',
      claim_flag:        '\uD83C\uDFF3 CLAIM FLAG',
    };
    const itemLabel = STRUCT_LABELS[kind] ?? `\u229f ${kind.toUpperCase()}`;

    // Status suffix
    let status = '';
    if (enemyClose) status = '  \u26a0\ufe0f ENEMY NEARBY — retreat to place';
    else if (tooFar) status = '  \u26a0\ufe0f TOO FAR — move closer';

    ctx.font = 'bold 20px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff8e0';
    const confirmHint = this._totalLandGhosts > 0
      ? `  |  [Enter] Build All (${this._totalLandGhosts})  |  [RMB] Remove`
      : '  |  [Esc / change slot] Cancel';
    ctx.fillText(
      `\u2301  BUILD MODE — ${itemLabel}  |  [Click] Plan${confirmHint}${status}`,
      cw / 2, BANNER_H / 2
    );

    ctx.restore();

    // ── Wall / Door Frame variant selector — mid-right of screen ─────────────
    if (wallVariant !== undefined) {
      this._renderWallVariantSelector(ctx, canvas, wallVariant);
    }
  }

  private _renderWallVariantSelector(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    wallVariant: 'wall' | 'door_frame'
  ): void {
    const options: Array<{ label: string; value: 'wall' | 'door_frame' }> = [
      { label: '\u258b  Wall',       value: 'wall'       },
      { label: '\u2293  Door Frame', value: 'door_frame' },
    ];

    const ITEM_H  = 38;
    const ITEM_W  = 140;
    const ITEM_GAP = 6;
    const PAD_X   = 14;
    const PAD_Y   = 12;
    const RADIUS  = 8;
    const HINT_H  = 18;

    const totalH  = options.length * ITEM_H + (options.length - 1) * ITEM_GAP + PAD_Y * 2 + HINT_H + 4;
    const panelW  = ITEM_W + PAD_X * 2;
    const panelX  = canvas.width - panelW - 18;
    const panelY  = (canvas.height - totalH) / 2;

    ctx.save();

    // Panel background
    ctx.fillStyle = 'rgba(20, 15, 8, 0.82)';
    ctx.strokeStyle = 'rgba(180, 140, 50, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(panelX, panelY, panelW, totalH, RADIUS + 2);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.font = 'bold 11px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(220, 180, 80, 0.65)';
    ctx.fillText('STRUCTURE TYPE', panelX + panelW / 2, panelY + PAD_Y / 2 + 4);

    options.forEach((opt, i) => {
      const itemX = panelX + PAD_X;
      const itemY = panelY + PAD_Y + HINT_H / 2 + i * (ITEM_H + ITEM_GAP);
      const isSelected = opt.value === wallVariant;

      // Row background
      ctx.beginPath();
      ctx.roundRect(itemX, itemY, ITEM_W, ITEM_H, RADIUS);

      if (isSelected) {
        ctx.fillStyle = 'rgba(220, 175, 40, 0.90)';
        ctx.fill();
        ctx.strokeStyle = '#ffe066';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(50, 40, 20, 0.60)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(120, 100, 40, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Label
      ctx.font = isSelected ? 'bold 14px Georgia, serif' : '14px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isSelected ? '#1a1000' : 'rgba(180, 150, 70, 0.50)';
      ctx.fillText(opt.label, itemX + ITEM_W / 2, itemY + ITEM_H / 2);
    });

    // [T] hint at the bottom of the panel
    ctx.font = '11px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(220, 180, 80, 0.50)';
    ctx.fillText('[T] to cycle', panelX + panelW / 2, panelY + totalH - 4);

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
    const entries = UIManager.PLAN_PANEL_ENTRIES;
    const totalH = HH + entries.length * EH + 8;
    const px     = 0;
    const py     = Math.round((canvas.height - totalH) / 2);

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
    ctx.fillText('📋  Plan Menu  [B]', px + W / 2, py + HH / 2);

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
      const labelY = ey + EH / 2 - 7;
      ctx.fillText(e.label, swatchX + swatchR + 8, labelY);

      // Resource cost row
      const parts: string[] = [];
      if (e.cost.wood  > 0) parts.push(`\uD83E\uDEB5${e.cost.wood}`);
      if (e.cost.fiber > 0) parts.push(`\uD83C\uDF3F${e.cost.fiber}`);
      if (e.cost.metal > 0) parts.push(`\u2699\uFE0F${e.cost.metal}`);
      if (e.cost.stone > 0) parts.push(`\uD83E\uDEA8${e.cost.stone}`);
      ctx.font = '10px Georgia, serif';
      ctx.fillStyle = 'rgba(180,200,220,0.55)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(parts.join(' '), swatchX + swatchR + 8, ey + EH / 2 + 9);

      // Ghost count badge
      const count = ghostCounts.get(e.kind) ?? 0;
      if (count > 0) {
        const badge = `×${count}`;
        ctx.fillStyle = 'rgba(255,200,50,0.85)';
        ctx.font = 'bold 11px Georgia, serif';
        ctx.textAlign = 'right';
        ctx.fillText(badge, px + W - 10, labelY);
      }

      // Pending indicator arrow on the right edge
      if (isPending) {
        ctx.fillStyle = '#55ee88';
        ctx.font = '13px Georgia, serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('▶', px + W - 8, labelY);
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
    const _hudEl = new HUDElement();
    _hudEl.getVariantTooltipInfo  = (kind) => this.playerMenu.getVariantTooltipInfo(kind);
    _hudEl.getVariantsForKind     = (kind) => this.playerMenu.getVariantsForKind(kind);
    _hudEl.setVariantForKind      = (kind, idx) => this.playerMenu.setVariantForKind(kind, idx);
    _hudEl.tierColorFn            = _tierColor;
    _hudEl.tierNameFn             = _tierName;
    _hudEl.statMultLabelFn        = _statMultLabel;
    _hudEl.qualityStatNamesFn     = () => _QUALITY_STAT_NAMES;
    this.elements.set(UIElementType.HUD, _hudEl);
    this._loadHotbars();
    
    // Initialize Debug Overlay
    this.elements.set(UIElementType.DEBUG_OVERLAY, new DebugOverlayElement());
    
    // Initialize Network Stats
    this.elements.set(UIElementType.NETWORK_STATS, new NetworkStatsElement());
    
    // Control hints element removed
    
    // Set initial visibility
    this.updateElementVisibility();
  }
  
  /** Persist current hotbar selections to localStorage. */
  private _saveHotbars(): void {
    try {
      localStorage.setItem('pirate_mmo_land_hotbar', JSON.stringify(this.landHotbarSlots));
      localStorage.setItem('pirate_mmo_ship_hotbar', JSON.stringify(this.buildHotbarSlots));
    } catch { /* quota exceeded or private mode — ignore */ }
  }

  /** Restore hotbar selections from localStorage, validating each entry. */
  private _loadHotbars(): void {
    const validLand = new Set(UIManager.LAND_BUILD_PANEL_ENTRIES.map(e => e.kind));
    const validShip = new Set<string>(SHIP_BUILD_PANEL_ENTRIES.map(e => e.kind));
    try {
      const landRaw = localStorage.getItem('pirate_mmo_land_hotbar');
      if (landRaw) {
        const parsed: unknown[] = JSON.parse(landRaw);
        if (Array.isArray(parsed) && parsed.length === 8) {
          this.landHotbarSlots = parsed.map(v => (typeof v === 'string' && validLand.has(v)) ? v : null);
        }
      }
    } catch { /* corrupt data — keep defaults */ }
    try {
      const shipRaw = localStorage.getItem('pirate_mmo_ship_hotbar');
      if (shipRaw) {
        const parsed: unknown[] = JSON.parse(shipRaw);
        if (Array.isArray(parsed) && parsed.length === 8) {
          this.buildHotbarSlots = parsed.map(v => (typeof v === 'string' && validShip.has(v)) ? v as GhostModuleKind : null);
        }
      }
    } catch { /* corrupt data — keep defaults */ }
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
    if (event.repeat) return;
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
          this.onPlayerMenuOpen?.();
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

    const isBucket = this.hammerGame.theme === 'bucket';

    ctx.fillStyle   = '#16162a';
    ctx.strokeStyle = isBucket ? '#2a6a9a' : '#8b6520';
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.roundRect?.(px, py, pw, ph, 12);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.fillStyle     = isBucket ? '#7ec8f0' : '#f0c060';
    ctx.font          = 'bold 21px Georgia, serif';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'top';
    ctx.fillText(isBucket ? '\uD83E\uDEA3  BUCKET SCOOP' : '\uD83D\uDD28  HAMMER REPAIR', cw / 2, py + 16);

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
      ctx.fillStyle = this.hammerGame.won ? '#33ff88' : (isBucket ? '#ffaa44' : '#ff5555');
      const resultText = isBucket
        ? (this.hammerGame.won ? 'FULL BUCKET!' : 'HALF BUCKET')
        : (this.hammerGame.won ? 'CRACK! \u2192 +10 000 HP' : 'MISSED!');
      ctx.fillText(resultText, cw / 2, py + 128);
    } else {
      ctx.font      = '14px Georgia, serif';
      ctx.fillStyle = '#aaaacc';
      const hint = isBucket
        ? 'Press [SPACE] or click in the green zone for a full scoop'
        : 'Press [SPACE] or click when the cursor enters the green zone';
      ctx.fillText(hint, cw / 2, py + 128);
      // Countdown ticks along the bottom of the track as tiny tick marks
      const pct = elapsed / this.hammerGame.duration;
      ctx.fillStyle = pct > 0.75 ? '#ff8800' : '#555577';
      ctx.fillRect(trackX, trackY + trackH + 3, trackW * (1 - pct), 3);
    }

    ctx.restore();
  }

  // ── Drop item picker overlay ───────────────────────────────────────────────

  private _dropPickerHits: { itemId: number; y: number; h: number }[] = [];

  private _renderSchematicPicker(ctx: CanvasRenderingContext2D): void {
    const entries = UIManager.LAND_BUILD_PANEL_ENTRIES;
    const { anchorX, anchorY } = this._schematicPicker;

    const COLS = 3;
    const CELL = 64, GAP = 6, PAD = 10, HEADER_H = 28;
    const rows = Math.ceil(entries.length / COLS);
    const W = COLS * CELL + (COLS - 1) * GAP + PAD * 2;
    const H = HEADER_H + rows * CELL + (rows - 1) * GAP + PAD * 2;

    // Position above the slot, centred on anchorX, above anchorY
    let px = Math.round(anchorX - W / 2);
    let py = anchorY - H - 6;
    // Clamp to canvas
    px = Math.max(4, Math.min(ctx.canvas.width - W - 4, px));
    py = Math.max(4, py);

    ctx.save();

    // Panel background
    ctx.fillStyle = 'rgba(14,10,4,0.96)';
    ctx.strokeStyle = '#cc8822';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, W, H, 6);
    ctx.fill();
    ctx.stroke();

    // Header
    ctx.font = 'bold 11px Georgia, serif';
    ctx.fillStyle = '#ffcc66';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Assign Schematic  [Esc]', px + W / 2, py + HEADER_H / 2);

    this._schematicPickerHits = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx = px + PAD + col * (CELL + GAP);
      const cy = py + HEADER_H + PAD + row * (CELL + GAP);

      const isHov = this.mouseX >= cx && this.mouseX <= cx + CELL &&
                    this.mouseY >= cy && this.mouseY <= cy + CELL;
      const isAssigned = this.landHotbarSlots.includes(e.kind);

      this._schematicPickerHits.push({ kind: e.kind, x: cx, y: cy, w: CELL, h: CELL });

      // Cell background
      ctx.fillStyle = isHov ? 'rgba(180,100,20,0.45)' : (isAssigned ? 'rgba(80,50,10,0.6)' : 'rgba(25,15,5,0.8)');
      ctx.strokeStyle = isHov ? '#ffcc44' : (isAssigned ? '#886620' : '#4a3010');
      ctx.lineWidth = isHov ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(cx, cy, CELL, CELL, 4);
      ctx.fill();
      ctx.stroke();

      // Colour swatch
      const SW = 28;
      ctx.fillStyle = e.color;
      ctx.fillRect(cx + (CELL - SW) / 2, cy + 8, SW, SW);
      ctx.strokeStyle = e.borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + (CELL - SW) / 2, cy + 8, SW, SW);

      // Symbol
      ctx.font = 'bold 12px Georgia, serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.symbol, cx + CELL / 2, cy + 8 + SW / 2);

      // Label
      ctx.font = '8px Georgia, serif';
      ctx.fillStyle = isHov ? '#ffee88' : '#b8905a';
      ctx.textBaseline = 'bottom';
      ctx.fillText(e.label.substring(0, 9), cx + CELL / 2, cy + CELL - 3);
    }

    ctx.restore();
  }

  private _renderShipModulePicker(ctx: CanvasRenderingContext2D): void {
    const entries = UIManager.BUILD_PANEL_ENTRIES;
    const { anchorX, anchorY } = this._shipModulePicker;

    const COLS = 3;
    const CELL = 64, GAP = 6, PAD = 10, HEADER_H = 28;
    const rows = Math.ceil(entries.length / COLS);
    const W = COLS * CELL + (COLS - 1) * GAP + PAD * 2;
    const H = HEADER_H + rows * CELL + (rows - 1) * GAP + PAD * 2;

    let px = Math.round(anchorX - W / 2);
    let py = anchorY - H - 6;
    px = Math.max(4, Math.min(ctx.canvas.width - W - 4, px));
    py = Math.max(4, py);

    ctx.save();

    ctx.fillStyle = 'rgba(14,8,4,0.96)';
    ctx.strokeStyle = '#c87800';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, W, H, 6);
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 11px Georgia, serif';
    ctx.fillStyle = '#ffcc66';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Assign Module  [Esc]', px + W / 2, py + HEADER_H / 2);

    this._shipModulePickerHits = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx = px + PAD + col * (CELL + GAP);
      const cy = py + HEADER_H + PAD + row * (CELL + GAP);

      const isHov = this.mouseX >= cx && this.mouseX <= cx + CELL &&
                    this.mouseY >= cy && this.mouseY <= cy + CELL;
      const isAssigned = this.buildHotbarSlots.includes(e.kind);

      this._shipModulePickerHits.push({ kind: e.kind, x: cx, y: cy, w: CELL, h: CELL });

      ctx.fillStyle = isHov ? 'rgba(200,120,20,0.45)' : (isAssigned ? 'rgba(80,45,5,0.6)' : 'rgba(25,15,5,0.8)');
      ctx.strokeStyle = isHov ? '#ffcc44' : (isAssigned ? '#886620' : '#4a3010');
      ctx.lineWidth = isHov ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(cx, cy, CELL, CELL, 4);
      ctx.fill();
      ctx.stroke();

      const SW = 28;
      ctx.fillStyle = e.color;
      ctx.fillRect(cx + (CELL - SW) / 2, cy + 8, SW, SW);
      ctx.strokeStyle = e.borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + (CELL - SW) / 2, cy + 8, SW, SW);

      ctx.font = 'bold 12px Georgia, serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.symbol, cx + CELL / 2, cy + 8 + SW / 2);

      ctx.font = '8px Georgia, serif';
      ctx.fillStyle = isHov ? '#ffee88' : '#b8905a';
      ctx.textBaseline = 'bottom';
      ctx.fillText(e.label.substring(0, 9), cx + CELL / 2, cy + CELL - 3);
    }

    ctx.restore();
  }

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

      // Resolve item name/symbol from ITEM_DEFS or schematic metadata
      const kindNum = item.itemKind;
      let name   = `Item #${kindNum}`;
      let symbol = '?';
      let rowColor = isHovered ? '#ffd700' : '#e8e0cc';
      if (item.isSchematic) {
        symbol = '📜';
        const tName = _tierName(item.tier ?? 0);
        name = `${tName} ${_itemDisplayName(kindNum)} Schematic`;
        rowColor = isHovered ? _tierColor(item.tier ?? 0) : '#d8c8f0';
      } else {
        const kindStr = Object.entries(ITEM_KIND_ID).find(([, v]) => (v as number) === kindNum)?.[0];
        if (kindStr && (ITEM_DEFS as any)[kindStr]) {
          const def = (ITEM_DEFS as any)[kindStr];
          name   = def.name   ?? name;
          symbol = def.symbol ?? symbol;
        }
      }

      ctx.font = '18px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(symbol, px + PAD, ry + ROW_H / 2);

      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = rowColor;
      ctx.fillText(name, px + PAD + 28, ry + ROW_H / 2);

      if (item.quantity > 1 && !item.isSchematic) {
        ctx.font = 'bold 11px Georgia, serif';
        ctx.fillStyle = '#aaa';
        ctx.textAlign = 'right';
        ctx.fillText(`\u00d7${item.quantity}`, px + W - PAD, ry + ROW_H / 2);
      } else if (item.isSchematic && item.crafts !== undefined) {
        ctx.font = 'bold 11px Georgia, serif';
        ctx.fillStyle = '#aaa';
        ctx.textAlign = 'right';
        ctx.fillText(`×${item.crafts}`, px + W - PAD, ry + ROW_H / 2);
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
  private _cachedPlayerLevel = 1;
  private _cachedPlayerXp    = 0;

  // ── Build hotbar state (owned by HUDElement since it renders it) ───────
  /** 8 schematic slots; each entry is the GhostModuleKind (or null = empty). */
  public buildHotbarSlots: (GhostModuleKind | null)[] = [
    'plank', 'deck', 'mast', 'cannon', 'swivel', 'helm', 'ramp', 'chest',
  ];
  /** Currently selected build hotbar slot (0–7). */
  public buildHotbarActiveSlot = 0;
  /** Set to true when ship build mode is active. */
  public inShipBuildMode = false;
  /** Set to true when land build mode is active (panel open or structure selected). */
  public inLandBuildMode = false;
  /** The currently selected land structure kind (highlighted in land build hotbar). */
  public selectedLandKind: string | null = null;
  /** 8 land schematic hotbar slots; string kind or null = empty. */
  public landHotbarSlots: (string | null)[] = UIManager.LAND_BUILD_PANEL_ENTRIES.slice(0, 8).map(e => e.kind);
  /** Wired by UIManager so build-hotbar tooltip can show the active quality variant. */
  public getVariantTooltipInfo: (kind: string) => { tierPrefix: string; crafts: number; color: string; costMult: number } | undefined = () => undefined;
  /** Wired by UIManager — returns quality blueprints available for a build kind. */
  public getVariantsForKind: (kind: string) => Array<{ index: number; tier: number; crafts: number; stats: number[] }> = () => [];
  /** Wired by UIManager — persists a variant selection (null = Standard). */
  public setVariantForKind: (kind: string, index: number | null) => void = () => {};

  // ── Variant picker popup ────────────────────────────────────────────────
  private _variantPopup: {
    kind: string;
    anchorX: number;
    anchorY: number;
    hits: Array<{ index: number | null; x: number; y: number; w: number; h: number }>;
  } | null = null;

  /** Open the variant picker popup anchored above the given hotbar slot. */
  openVariantPopup(kind: string, anchorX: number, anchorY: number): void {
    this._variantPopup = { kind, anchorX, anchorY, hits: [] };
  }

  /** Close the popup (no selection change). */
  closeVariantPopup(): boolean {
    const was = this._variantPopup !== null;
    this._variantPopup = null;
    return was;
  }

  /**
   * Handle a click that may land on the variant popup.
   * Returns true (consuming the event) if the popup was open regardless of where
   * the click landed — any click outside the popup rows also closes it.
   */
  handleVariantPopupClick(x: number, y: number): boolean {
    if (!this._variantPopup) return false;
    for (const h of this._variantPopup.hits) {
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        this.setVariantForKind(this._variantPopup.kind, h.index);
        this._variantPopup = null;
        return true;
      }
    }
    // Click missed all rows — dismiss popup without changing variant
    this._variantPopup = null;
    return true;
  }

  // ── Tooltip hover-delay tracking (500 ms) ─────────────────────────────
  private _ttHoverKey   = '';
  private _ttHoverStart = 0;
  private _ttFrameKey   = '';

  /** Register a bar as hovered this frame. Returns true once 500 ms has elapsed. */
  private _ttHit(key: string): boolean {
    this._ttFrameKey = key;
    return this._ttHoverKey === key && (Date.now() - this._ttHoverStart) >= 500;
  }

  // ── Bar change-flash tracking ───────────────────────────────────────────
  private _barFlash = new Map<string, number>(); // key → perf timestamp of last change
  private _barPrev  = new Map<string, number>(); // key → previous ratio 0–1

  /** Call before drawing a bar fill. Triggers a change-flash if ratio moved. */
  private _tickFlash(key: string, ratio: number): void {
    const prev = this._barPrev.get(key);
    if (prev !== undefined && Math.abs(ratio - prev) > 0.01) {
      this._barFlash.set(key, performance.now());
    }
    this._barPrev.set(key, ratio);
  }

  /** White overlay alpha (0–0.55) for the active change-flash on a bar. */
  private _flashAlpha(key: string): number {
    const t = this._barFlash.get(key);
    if (t === undefined) return 0;
    const elapsed = performance.now() - t;
    const DURATION = 600;
    if (elapsed >= DURATION) { this._barFlash.delete(key); return 0; }
    return 0.55 * (1 - elapsed / DURATION);
  }

  render(ctx: CanvasRenderingContext2D, context: UIRenderContext): void {
    this._ttFrameKey = '';
    // Find our player using the server-assigned player ID
    const player = context.assignedPlayerId !== null && context.assignedPlayerId !== undefined
      ? context.worldState.players.find(p => p.id === context.assignedPlayerId)
      : context.worldState.players[0]; // Fallback to first player if no ID assigned yet
    
    if (!player) return;
    
    // ── Stats box (left of hotbar) ────────────────────────────────────────
    ctx.save();

    const fps      = Math.round(context.fps);
    const frameMs  = context.frameMs ?? (fps > 0 ? 1000 / fps : 0);
    const ping     = Math.round(context.networkStats?.ping ?? 0);
    const glDc     = context.glDrawCalls ?? 0;
    const glScale  = context.glScalePct ?? 0;
    const fpsColor = fps >= 60 ? '#44ff66' : fps >= 30 ? '#ffaa00' : '#ff4444';

    // Mirror hotbar layout to anchor the stats panel beside it
    const _hbSlot = 48, _hbGap = 4, _hbPad = 6, _hbLabelH = 16;
    const _hbW  = HOTBAR_SLOTS * (_hbSlot + _hbGap) - _hbGap + _hbPad * 2;
    const _hbH  = _hbSlot + _hbPad * 2 + _hbLabelH;
    const _hbX  = Math.round(ctx.canvas.width / 2 - _hbW / 2);
    const _hbY  = ctx.canvas.height - _hbH - 8;
    // Player bars sit above the hotbar (same constants as renderPlayerBars)
    const _barsH = 4 * 2 + 6 + 3 + 10 * 2 + 3; // PPPAD*2 + XP_H + GAP + BAR_H*2 + GAP = 40
    const _statsExtra = context.config?.debug?.showPerformanceStats ? 26 : 0;
    const BOX_W  = 220;
    const BOX_H  = _hbH + _barsH + 4 + 16 + _statsExtra;
    const BX     = Math.max(8, _hbX - BOX_W - 6);
    const BY     = _hbY - _barsH - 4;

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
    ctx.fillText(`${fps} FPS  ${frameMs.toFixed(1)}ms`, BX + 10, BY + 9);

    // Ping + GL row
    ctx.font      = '13px Georgia, serif';
    ctx.fillStyle = ping < 80 ? '#88ddff' : ping < 200 ? '#ffaa00' : '#ff4444';
    const glText  = glScale > 0 ? `  GL ${glDc}dc @${glScale}%` : '  Canvas 2D';
    ctx.fillText(`Ping ${ping}ms${glText}`, BX + 10, BY + 28);

    if (context.config?.debug?.showPerformanceStats && typeof window !== 'undefined') {
      const fa = (window as unknown as { __frameAuditStats?: Record<string, number> }).__frameAuditStats;
      if (fa) {
        ctx.font = '11px Georgia, serif';
        ctx.fillStyle = '#cccccc';
        ctx.fillText(
          `p95 ${fa.frameMsP95?.toFixed(1) ?? '?'}ms  hitches ${fa.hitchCount ?? 0}`,
          BX + 10,
          BY + 42
        );
        const qi = fa.renderQueueMs ?? 0;
        const ex = fa.renderExecuteMs ?? 0;
        const fg = fa.renderFogMs ?? 0;
        const isl = fa.renderIslandMs ?? 0;
        if (qi + ex + fg + isl > 0) {
          ctx.fillText(
            `pass isl/q/ex/fog ${isl.toFixed(0)}/${qi.toFixed(0)}/${ex.toFixed(0)}/${fg.toFixed(0)}ms`,
            BX + 10,
            BY + 54
          );
        }
      }
    }

    // Divider
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(BX + 8, BY + 46 + _statsExtra); ctx.lineTo(BX + BOX_W - 8, BY + 46 + _statsExtra);
    ctx.stroke();

    // Position
    ctx.font      = '13px Georgia, serif';
    ctx.fillStyle = '#aaffcc';
    ctx.fillText(`Pos  ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}`, BX + 10, BY + 52 + _statsExtra);

    // Ship info OR island info depending on where the player is
    if (player.onIslandId > 0) {
      const island = context.worldState.islands?.find(i => i.id === player.onIslandId);
      const preset = island ? (island.preset.charAt(0).toUpperCase() + island.preset.slice(1)) : '?';
      ctx.fillStyle = '#aaffaa';
      ctx.fillText(`Island #${player.onIslandId}  ${preset}`, BX + 10, BY + 68 + _statsExtra);
      if (island) {
        const live = (type: IslandResource['type']) =>
          island.resources.filter(r => r.type === type && (r.hp ?? 0) > 0).length;
        const wood   = live('wood');
        const fiber  = live('fiber');
        const rock   = live('rock');
        const boulder = live('boulder');
        const parts: string[] = [];
        if (wood)    parts.push(`${wood}W`);
        if (fiber)   parts.push(`${fiber}Fi`);
        if (rock)    parts.push(`${rock}Rk`);
        if (boulder) parts.push(`${boulder}Bo`);
        ctx.fillStyle = '#88cc88';
        ctx.fillText(parts.length ? `Res: ${parts.join('  ')}` : 'No resources', BX + 10, BY + 82 + _statsExtra);
      }
    } else {
      const _deckLabel = player.onDeck
        ? (player.deckId === 0 ? 'Lower deck' : 'Upper deck')
        : 'Off ship';
      ctx.fillStyle = '#cccccc';
      ctx.fillText(`Ship ${player.onDeck ? `#${player.carrierId}` : '\u2014'}  ${_deckLabel}`, BX + 10, BY + 68 + _statsExtra);
    }

    // Velocity
    ctx.fillStyle = '#bbbbbb';
    ctx.fillText(`Vel  ${player.velocity.x.toFixed(1)}, ${player.velocity.y.toFixed(1)}`, BX + 10, BY + 84 + _statsExtra);

    // Network bandwidth
    const ns = context.networkStats;
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`\u2191${(ns.bytesSent / 1024).toFixed(1)}KB \u2193${(ns.bytesReceived / 1024).toFixed(1)}KB loss ${ns.packetLoss.toFixed(1)}%`, BX + 10, BY + 100 + _statsExtra);

    ctx.restore();

    // --- Water meter (top-right boat icon) ---
    // Show whenever the player is aboard any ship
    const playerShip = player.onDeck
      ? context.worldState.ships.find(s => s.id === player.carrierId)
      : null;

    if (playerShip != null) {
      // Compute deck health ratio from the ship's deck module(s).
      // Also build per-deck ratios for the multi-bar HUD display.
      const decks = playerShip.modules.filter(m => m.kind === 'deck');
      let deckRatio = 1;
      const deckRatios: number[] = [];
      if (decks.length > 0) {
        // Accumulate hp/maxHp sums per deck level for per-bar display
        const perDeckHp:    number[] = [];
        const perDeckMax:   number[] = [];
        let totalHp = 0, totalMax = 0;
        for (const m of decks) {
          const d = m.moduleData as { health?: number; maxHealth?: number } | undefined;
          const hp    = d?.health    ?? 0;
          const maxHp = d?.maxHealth ?? 10000;
          totalHp  += hp;
          totalMax += maxHp;
          const di = m.deckId ?? 0; // 0 = lower deck, 1 = upper deck
          perDeckHp[di]  = (perDeckHp[di]  ?? 0) + hp;
          perDeckMax[di] = (perDeckMax[di] ?? 0) + maxHp;
        }
        deckRatio = totalMax > 0 ? Math.max(0, Math.min(1, totalHp / totalMax)) : 1;
        // Build ratios array indexed by deck level
        const maxDi = perDeckMax.length;
        for (let di = 0; di < maxDi; di++) {
          const m = perDeckMax[di] ?? 0;
          deckRatios[di] = m > 0 ? Math.max(0, Math.min(1, (perDeckHp[di] ?? 0) / m)) : 1;
        }
      }
      const mastModules = playerShip.modules.filter(m => m.kind === 'mast');
      const _shipSpeed = Math.hypot((playerShip.velocity as {x:number;y:number}|undefined)?.x ?? 0,
                                       (playerShip.velocity as {x:number;y:number}|undefined)?.y ?? 0);

      // Compute total ship weight: modules + bodies (75 kg ea) + inventory
      const SHIP_WEIGHT_CAP = 6000 + ((playerShip.levelStats?.levels?.[0] ?? 1) - 1) * 400;
      const MODULE_KG_W: Record<string, number> = {
        cannon: 100, swivel: 180, mast: 150, helm: 20, 'steering-wheel': 20,
        plank: 30, deck: 200, ladder: 5, seat: 25, custom: 50,
      };
      const _modKg = playerShip.modules.reduce((s, m) => {
        if (m.kind === 'cannon') {
          const snapIdx = (m.moduleData as any)?.gunportSnapIdx;
          if (snapIdx !== undefined && snapIdx !== 255) {
            const gp = playerShip.modules.find(gm => gm.kind === 'gunport' && (gm.moduleData as any)?.snapIndex === snapIdx);
            return s + (gp ? ((gp.moduleData as any)?.isOpen ? 100 : 40) : 100);
          }
          return s + 100;
        }
        return s + (MODULE_KG_W[m.kind] ?? 50);
      }, 0);
      const _aboard     = context.worldState.players.filter(p => p.onDeck && p.carrierId === playerShip.id);
      const _npcsAboard = context.worldState.npcs.filter(n => n.shipId === playerShip.id);
      const _bodyKg     = (_aboard.length + _npcsAboard.length) * 75;
      const _invKg      = _aboard.reduce((sum, p) => sum + computeInventoryWeight(p.inventory), 0);
      const shipRawKg   = _modKg + _bodyKg + _invKg;
      const _shipWeight = Math.min(100, (shipRawKg / SHIP_WEIGHT_CAP) * 100);

      this.renderWaterMeter(ctx, ctx.canvas, playerShip.hullHealth ?? 100, deckRatio, playerShip.rotation ?? 0, mastModules, playerShip.hull ?? [], context.windAngle ?? 0, context.debugMode ?? false, _shipSpeed, context.camera.getState().rotation, playerShip.shipName, playerShip.levelStats?.shipLevel, _shipWeight, shipRawKg, SHIP_WEIGHT_CAP, deckRatios);
    }

    // Health / stamina bars above hotbar
    const maxSt  = player.maxStamina ?? 100;
    const st     = player.stamina    ?? maxSt;
    const maxO2  = player.maxOxygen  ?? 100;
    const o2     = player.oxygen     ?? maxO2;
    const isSwimming = (player.movementState === 'SWIMMING');
    const _lvl = player.level ?? 1;
    const _xp  = player.xp ?? 0;
    this._cachedPlayerLevel = _lvl;
    this._cachedPlayerXp    = _xp;
    this.renderPlayerBars(ctx, ctx.canvas, player.health, player.maxHealth ?? 100, st, maxSt, o2, maxO2, isSwimming, _lvl, _xp, player.statPoints ?? 0, context.combatMode ?? false);

    // Hotbar — in ship/helm mode reuses same grid to show weapon groups
    // In ship build mode, show the build schematic hotbar instead
    const helmMode = context.mountKind === 'helm'
      ? { activeGroup: context.activeWeaponGroup ?? -1, activeGroups: context.activeWeaponGroups ?? new Set<number>(), playerShip: context.playerShip ?? null, controlGroups: context.controlGroups, rmbAimingGroups: context.rmbAimingGroups }
      : undefined;
    if (this.inLandBuildMode) {
      this.renderLandBuildHotbar(ctx, ctx.canvas, player.inventory.slots);
    } else if (this.inShipBuildMode) {
      this.renderBuildHotbar(ctx, ctx.canvas);
    } else {
      this.renderHotbar(ctx, ctx.canvas, player.inventory.slots, player.inventory.activeSlot, helmMode, player.bucketFill ?? 0);
    }

    // Vital bars (weight / food / water) — right of hotbar
    const carryCapacity = playerCarryCapacityKg((player.statWeight ?? 0) as number);
    const carriedKg = computePlayerCarriedKg(player, context.worldState.players);
    this.renderVitalBars(
      ctx, ctx.canvas,
      carriedKg, carryCapacity,
      player.hunger ?? 100,
      player.thirst ?? 100,
    );

    // Equipment HUD — all 6 slots (helm, chest, legs, feet, hands, shield)
    this.renderEquipmentHUD(ctx, ctx.canvas, player.inventory.equipment);

    // Finalise tooltip hover delay — reset timer whenever hovered element changes
    if (this._ttFrameKey !== this._ttHoverKey) {
      this._ttHoverKey   = this._ttFrameKey;
      this._ttHoverStart = Date.now();
    }
  }

  private renderPlayerBars(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    health: number,
    maxHealth: number,
    stamina: number,
    maxStamina: number,
    oxygen: number,
    maxOxygen: number,
    isSwimming: boolean,
    level = 1,
    xp = 0,
    statPoints = 0,
    combatMode = false,
  ): void {
    const PLAYER_MAX_LEVEL = 120;
    const SLOT_SIZE = 48, SLOT_GAP = 4, PADDING = 6, LABEL_H = 16;
    const totalW = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((canvas.width - totalW) / 2);
    const hotbarY = canvas.height - totalH - 8;

    const BAR_H    = 10;
    const XP_BAR_H = 6;
    const GAP      = 3;
    const PANEL_PAD = 4;
    // Show the oxygen bar only once it starts depleting (not just on entering water)
    const showOxygen = oxygen < maxOxygen;
    const panelH   = PANEL_PAD * 2 + XP_BAR_H + GAP + BAR_H * 2 + GAP + (showOxygen ? BAR_H + GAP : 0);
    const panelY   = hotbarY - panelH - 4;
    const barX     = startX + PANEL_PAD;
    const barW     = totalW - PANEL_PAD * 2;

    const hpRatio = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 1;
    const stRatio = maxStamina > 0 ? Math.max(0, Math.min(1, stamina / maxStamina)) : 1;
    const isMaxLevel = level >= PLAYER_MAX_LEVEL;
    const xpToNext  = isMaxLevel ? PLAYER_MAX_LEVEL * 100 : level * 100;
    const xpRatio   = isMaxLevel ? 1 : Math.min(xp / xpToNext, 1);
    const canLevelUp = !isMaxLevel && xp >= xpToNext;

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
    let xpBarColor: string;
    if (isMaxLevel) {
      xpBarColor = '#ffdd44';
    } else if (canLevelUp || statPoints > 0) {
      // Flash gold when stat points are pending (pulse brightness instead of toggling colour)
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 300);
      const gold = Math.round(pulse * 255).toString(16).padStart(2, '0');
      xpBarColor = `#ffdd${gold}`;
    } else {
      xpBarColor = '#4488ff';
    }
    // When points are available, always show the bar at full to signal the milestone
    const xpDrawRatio = (canLevelUp || statPoints > 0) ? 1 : xpRatio;
    ctx.fillStyle = xpBarColor;
    ctx.fillRect(barX, xpY, Math.round(barW * xpDrawRatio), XP_BAR_H);
    // Change-flash overlay
    this._tickFlash('bar-xp', xpRatio);
    const _xpFa = this._flashAlpha('bar-xp');
    if (_xpFa > 0) {
      ctx.fillStyle = `rgba(255,255,255,${_xpFa.toFixed(2)})`;
      ctx.fillRect(barX, xpY, barW, XP_BAR_H);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, xpY, barW, XP_BAR_H);

    ctx.font = 'bold 8px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.70)';
    ctx.fillText(`Lv.${level}${isMaxLevel ? ' MAX' : ''}`, barX + 3, xpY + XP_BAR_H / 2);
    ctx.textAlign = 'right';
    if (statPoints > 0 && !isMaxLevel) {
      // Overlay stat point count in the centre of the bar
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.fillText(`★ ${statPoints} pt${statPoints !== 1 ? 's' : ''} to spend`, barX + barW / 2, xpY + XP_BAR_H / 2);
      ctx.textAlign = 'right';
    }
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
    // Change-flash overlay
    this._tickFlash('bar-hp', hpRatio);
    const _hpFa = this._flashAlpha('bar-hp');
    if (_hpFa > 0) {
      ctx.fillStyle = `rgba(255,255,255,${_hpFa.toFixed(2)})`;
      ctx.fillRect(barX, hpY, barW, BAR_H);
    }
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
    // Change-flash overlay
    this._tickFlash('bar-st', stRatio);
    const _stFa = this._flashAlpha('bar-st');
    if (_stFa > 0) {
      ctx.fillStyle = `rgba(255,255,255,${_stFa.toFixed(2)})`;
      ctx.fillRect(barX, stY, barW, BAR_H);
    }
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

    // ── Oxygen bar (only while swimming or oxygen is not full) ─────────────
    if (showOxygen) {
      const o2Y    = stY + BAR_H + GAP;
      const o2Ratio = maxOxygen > 0 ? Math.max(0, Math.min(1, oxygen / maxOxygen)) : 1;
      const o2Crit  = o2Ratio < 0.25;
      const o2Warn  = o2Ratio < 0.50;
      // Pulse the bar border when critically low
      const o2Pulse = o2Crit ? 0.55 + 0.45 * Math.sin(performance.now() / 250) : 1;
      // Fill is always fully opaque so the bar level is always readable; pulse only affects the border
      const o2Color = o2Crit ? '#1e9fff' : o2Warn ? '#2299ee' : '#44bbff';

      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(barX, o2Y, barW, BAR_H);
      ctx.fillStyle = o2Color;
      ctx.fillRect(barX, o2Y, Math.round(barW * o2Ratio), BAR_H);
      // Change-flash overlay
      this._tickFlash('bar-o2', o2Ratio);
      const _o2Fa = this._flashAlpha('bar-o2');
      if (_o2Fa > 0) {
        ctx.fillStyle = `rgba(255,255,255,${_o2Fa.toFixed(2)})`;
        ctx.fillRect(barX, o2Y, barW, BAR_H);
      }
      ctx.strokeStyle = o2Crit ? `rgba(30,200,255,${o2Pulse.toFixed(2)})` : 'rgba(255,255,255,0.20)';
      ctx.lineWidth = 1;
      ctx.strokeRect(barX, o2Y, barW, BAR_H);

      ctx.font = 'bold 9px Georgia, serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.80)';
      ctx.fillText('O₂', barX + 4, o2Y + BAR_H / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = o2Crit ? '#88ddff' : 'rgba(255,255,255,0.70)';
      ctx.fillText(`${Math.ceil(oxygen)}/${maxOxygen}`, barX + barW - 4, o2Y + BAR_H / 2);
    }

    // ── Combat mode indicator ──────────────────────────────────────────────
    const indicatorW = 114;
    const indicatorH = 18;
    const indicatorX = startX + totalW - indicatorW;
    const indicatorY = panelY - indicatorH - 4;

    if (combatMode) {
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 380);
      ctx.fillStyle = 'rgba(110, 15, 15, 0.92)';
      ctx.fillRect(indicatorX, indicatorY, indicatorW, indicatorH);
      ctx.strokeStyle = `rgba(255, 70, 70, ${pulse.toFixed(2)})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(indicatorX, indicatorY, indicatorW, indicatorH);
      ctx.font = 'bold 10px Georgia, serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ff9090';
      ctx.fillText('\u2694  COMBAT', indicatorX + indicatorW / 2, indicatorY + indicatorH / 2);
    } else {
      ctx.fillStyle = 'rgba(15, 15, 22, 0.55)';
      ctx.fillRect(indicatorX, indicatorY, indicatorW, indicatorH);
      ctx.strokeStyle = 'rgba(70, 70, 95, 0.40)';
      ctx.lineWidth = 1;
      ctx.strokeRect(indicatorX, indicatorY, indicatorW, indicatorH);
      ctx.font = '9px Georgia, serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(130, 130, 155, 0.50)';
      ctx.fillText('[Z] Combat Mode', indicatorX + indicatorW / 2, indicatorY + indicatorH / 2);
    }

    // ── Bar hover tooltips ─────────────────────────────────────────────────
    const _mx = this.mouseX, _my = this.mouseY;
    if (_mx >= barX && _mx <= barX + barW) {
      if (_my >= xpY && _my <= xpY + XP_BAR_H) {
        if (this._ttHit('bar-xp')) {
          const xpDesc = isMaxLevel
            ? 'You have reached the maximum level.'
            : `${xpToNext - xp} XP needed to reach level ${level + 1}.`;
          this._drawStatTooltip(ctx, canvas, barX + barW / 2, xpY,
            'Experience', '#4488ff', '#aaddff',
            isMaxLevel ? 'MAX LEVEL' : `${xp} / ${xpToNext} XP`,
            xpDesc,
            statPoints > 0 ? [{ label: 'Unspent stat points', val: String(statPoints), col: '#ffdd44' }] : [],
          );
        }
      } else if (_my >= hpY && _my <= hpY + BAR_H) {
        if (this._ttHit('bar-hp')) {
          const hpDesc = hpCrit
            ? 'Critical — seek healing immediately.'
            : hpWarn ? 'Low health. Use supplies or rest to recover.'
            : 'Damaged by enemies and environmental hazards.';
          this._drawStatTooltip(ctx, canvas, barX + barW / 2, hpY,
            'Health', hpColor, '#aaffbb',
            `${Math.ceil(health)} / ${maxHealth}`,
            hpDesc, [],
          );
        }
      } else if (_my >= stY && _my <= stY + BAR_H) {
        if (this._ttHit('bar-st')) {
          const stDesc = stLow
            ? 'Nearly exhausted. Stop sprinting to recover.'
            : 'Consumed by sprinting, climbing, and combat. Regenerates over time.';
          this._drawStatTooltip(ctx, canvas, barX + barW / 2, stY,
            'Stamina', stColor, '#ffee88',
            `${Math.ceil(stamina)} / ${maxStamina}`,
            stDesc, [],
          );
        }
      }
    }

    ctx.restore();
  }

  /** Renders the 8-slot build schematic hotbar (replaces regular hotbar in ship build mode). */
  private renderBuildHotbar(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const BUILD_SLOTS = 8;
    const SLOT_SIZE = 48;
    const SLOT_GAP = 4;
    const PADDING = 6;
    const LABEL_H = 16;
    const totalW = BUILD_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((canvas.width - totalW) / 2);
    const startY = canvas.height - totalH - 8;

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(20,14,0,0.85)';
    ctx.fillRect(startX, startY, totalW, totalH);
    ctx.strokeStyle = '#c87800';
    ctx.lineWidth = 2;
    ctx.strokeRect(startX, startY, totalW, totalH);

    // "BUILD" label bottom-left of panel
    ctx.font = 'bold 9px Georgia, serif';
    ctx.fillStyle = '#ffcc44';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('BUILD', startX + 4, startY + totalH - LABEL_H + 2);

    for (let i = 0; i < BUILD_SLOTS; i++) {
      const kind = this.buildHotbarSlots[i];
      const entry = kind ? UIManager.BUILD_PANEL_ENTRIES.find(e => e.kind === kind) : null;
      const isActive = i === this.buildHotbarActiveSlot;
      const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      const sy = startY + PADDING;  // same line

      // Slot background
      ctx.fillStyle = isActive ? 'rgba(200,120,0,0.45)' : 'rgba(30,20,5,0.7)';
      ctx.strokeStyle = isActive ? '#ffcc44' : '#7a5500';
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(sx, sy, SLOT_SIZE, SLOT_SIZE, 4);
      ctx.fill();
      ctx.stroke();

      if (entry) {
        // Module color swatch
        const swatchSize = 28;
        const swatchX = sx + (SLOT_SIZE - swatchSize) / 2;
        const swatchY = sy + 6;
        ctx.fillStyle = entry.color;
        ctx.fillRect(swatchX, swatchY, swatchSize, swatchSize);
        ctx.strokeStyle = entry.borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(swatchX, swatchY, swatchSize, swatchSize);

        // Symbol
        ctx.font = 'bold 13px Georgia, serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(entry.symbol, sx + SLOT_SIZE / 2, swatchY + swatchSize / 2);

        // Crafts-remaining badge (bottom-right of swatch, shown when quality variant active)
        const vBadge = this.getVariantTooltipInfo(kind!);
        if (vBadge) {
          ctx.font = 'bold 9px Georgia, serif';
          ctx.fillStyle = vBadge.color;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(`×${vBadge.crafts}`, swatchX + swatchSize - 1, swatchY + swatchSize - 1);
        }

        // Short label at bottom of slot — quality tier color when variant active
        ctx.font = '8px Georgia, serif';
        ctx.fillStyle = vBadge ? vBadge.color : (isActive ? '#ffee88' : '#b8a080');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(entry.label.substring(0, 8), sx + SLOT_SIZE / 2, sy + SLOT_SIZE - 2);
      } else {
        // Empty slot
        ctx.font = '10px Georgia, serif';
        ctx.fillStyle = '#554433';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('—', sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);
      }

      // Slot key number
      ctx.font = '9px monospace';
      ctx.fillStyle = isActive ? '#ffcc44' : '#776655';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(String(i + 1), sx + 3, sy + 3);
    }

    ctx.restore();

    // Tooltip — show name + costs after hovering for 500 ms
    for (let i = 0; i < BUILD_SLOTS; i++) {
      const kind = this.buildHotbarSlots[i];
      const entry = kind ? UIManager.BUILD_PANEL_ENTRIES.find(e => e.kind === kind) : null;
      if (!entry) continue;
      const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      const sy = startY + PADDING;
      if (this.mouseX >= sx && this.mouseX <= sx + SLOT_SIZE &&
          this.mouseY >= sy && this.mouseY <= sy + SLOT_SIZE &&
          this._ttHit(`build-ship-${i}`)) {
        const vInfo = this.getVariantTooltipInfo(kind!);
        const m = vInfo?.costMult ?? 1;
        const costs = ([
          entry.cost.wood  > 0 ? `Wood:  ${Math.ceil(entry.cost.wood  * m)}` : null,
          entry.cost.fiber > 0 ? `Fiber: ${Math.ceil(entry.cost.fiber * m)}` : null,
          entry.cost.metal > 0 ? `Metal: ${Math.ceil(entry.cost.metal * m)}` : null,
          entry.cost.stone > 0 ? `Stone: ${Math.ceil(entry.cost.stone * m)}` : null,
        ] as Array<string | null>).filter((l): l is string => l !== null);
        this._drawBuildSlotTooltip(ctx, canvas, sx, sy, SLOT_SIZE,
          entry.label, entry.color, entry.borderColor, costs, vInfo);
      }
    }

    // Variant popup — rendered on top of everything, only for ship build mode
    if (this._variantPopup) this._renderVariantPopup(ctx, canvas);
  }

  /** Renders the land structure build hotbar (replaces regular hotbar in land build mode). */
  private renderLandBuildHotbar(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, _invSlots: { item: ItemKind; quantity: number }[]): void {
    const slots = this.landHotbarSlots;
    const N_SLOTS = slots.length;
    const SLOT_SIZE = 48;
    const SLOT_GAP = 4;
    const PADDING = 6;
    const LABEL_H = 16;
    const totalW = N_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((canvas.width - totalW) / 2);
    const startY = canvas.height - totalH - 8;

    ctx.save();

    // Background — amber/brown tint
    ctx.fillStyle = 'rgba(20,12,0,0.88)';
    ctx.fillRect(startX, startY, totalW, totalH);
    ctx.strokeStyle = '#cc8822';
    ctx.lineWidth = 2;
    ctx.strokeRect(startX, startY, totalW, totalH);

    // "BUILD SCHEMATICS" label bottom-left
    ctx.font = 'bold 9px Georgia, serif';
    ctx.fillStyle = '#ffcc44';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('BUILD SCHEMATICS', startX + 4, startY + totalH - LABEL_H + 2);

    for (let i = 0; i < N_SLOTS; i++) {
      const kind = slots[i] ?? null;
      const e = kind ? UIManager.LAND_BUILD_PANEL_ENTRIES.find(ent => ent.kind === kind) : null;
      const isActive = kind !== null && this.selectedLandKind === kind;
      const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      const sy = startY + PADDING;

      // Slot background
      ctx.fillStyle = isActive ? 'rgba(180,100,0,0.50)' : 'rgba(25,15,5,0.75)';
      ctx.strokeStyle = isActive ? '#ffcc44' : '#6a4400';
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(sx, sy, SLOT_SIZE, SLOT_SIZE, 4);
      ctx.fill();
      ctx.stroke();

      if (e) {
        // Module color swatch
        const swatchSize = 28;
        const swatchX = sx + (SLOT_SIZE - swatchSize) / 2;
        const swatchY = sy + 6;
        ctx.fillStyle = e.color;
        ctx.fillRect(swatchX, swatchY, swatchSize, swatchSize);
        ctx.strokeStyle = e.borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(swatchX, swatchY, swatchSize, swatchSize);

        // Symbol
        ctx.font = 'bold 13px Georgia, serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(e.symbol, sx + SLOT_SIZE / 2, swatchY + swatchSize / 2);

        // Crafts-remaining badge when quality variant active
        const vBadgeLand = kind ? this.getVariantTooltipInfo(kind) : undefined;
        if (vBadgeLand) {
          ctx.font = 'bold 9px Georgia, serif';
          ctx.fillStyle = vBadgeLand.color;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(`×${vBadgeLand.crafts}`, swatchX + swatchSize - 1, swatchY + swatchSize - 1);
        }

        // Short label — quality tier color when variant active
        ctx.font = '8px Georgia, serif';
        ctx.fillStyle = vBadgeLand ? vBadgeLand.color : (isActive ? '#ffee88' : '#b8905a');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(e.label.substring(0, 8), sx + SLOT_SIZE / 2, sy + SLOT_SIZE - 2);
      } else {
        // Empty slot
        ctx.font = '14px Georgia, serif';
        ctx.fillStyle = '#443322';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('—', sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);
      }

      // Slot key number
      ctx.font = '9px monospace';
      ctx.fillStyle = isActive ? '#ffcc44' : '#665533';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(String(i + 1), sx + 3, sy + 3);
    }

    ctx.restore();

    // Tooltip — show name + costs after hovering for 500 ms
    for (let i = 0; i < N_SLOTS; i++) {
      const kind = slots[i] ?? null;
      const e = kind ? UIManager.LAND_BUILD_PANEL_ENTRIES.find(ent => ent.kind === kind) : null;
      if (!e) continue;
      const sx = startX + PADDING + i * (SLOT_SIZE + SLOT_GAP);
      const sy = startY + PADDING;
      if (this.mouseX >= sx && this.mouseX <= sx + SLOT_SIZE &&
          this.mouseY >= sy && this.mouseY <= sy + SLOT_SIZE &&
          this._ttHit(`build-land-${i}`)) {
        const vInfo = this.getVariantTooltipInfo(kind!);
        const m = vInfo?.costMult ?? 1;
        const costs = e.cost
          .map(c => `${c.item.charAt(0).toUpperCase() + c.item.slice(1)}: ${Math.ceil(c.qty * m)}`);
        this._drawBuildSlotTooltip(ctx, canvas, sx, sy, SLOT_SIZE,
          e.label, e.color, e.borderColor, costs, vInfo);
      }
    }

    // Variant popup for land build mode
    if (this._variantPopup) this._renderVariantPopup(ctx, canvas);
  }

  private renderHotbar(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    slots: { item: ItemKind; quantity: number }[],
    activeSlot: number,
    weaponMode?: { activeGroup: number; activeGroups: Set<number>; playerShip: Ship | null; controlGroups?: Map<number, WeaponGroupState>; rmbAimingGroups?: Set<number> },
    bucketFill = 0,
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
      const groupIdx = i; // slot 0→G0 (Port), slot 1→G1 (Starboard), …, slot 9→G9
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
        const rmbAim   = weaponMode.rmbAimingGroups?.has(groupIdx) ?? false;
        const mode     = rmbAim ? 'aiming' : (state?.mode ?? 'haltfire');
        const modeCol  = MODE_COLORS[mode] ?? '#555';
        const modeLbl  = MODE_LABELS[mode] ?? mode;
        const hasLock  = mode === 'targetfire' && state != null && state.targetId >= 0;

        // Group label (top-centre): use name if set, else "G{n}"
        const _gName = state?.name ?? '';
        const _gLabel = _gName.length > 0 ? _gName : `G${groupIdx}`;
        // Scale font to fit slot width
        let _gFontSize = 11;
        ctx.font = `bold ${_gFontSize}px Georgia, serif`;
        while (_gFontSize > 7 && ctx.measureText(_gLabel).width > SLOT_SIZE - 4) {
          _gFontSize--;
          ctx.font = `bold ${_gFontSize}px Georgia, serif`;
        }
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = isActive ? '#ffd700' : 'rgba(160,160,180,0.75)';
        ctx.fillText(_gLabel, sx + SLOT_SIZE / 2, sy + 3);

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
          if (slot.item === 'axe') drawAxeIcon(ctx, sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2, SLOT_SIZE);
          else if (slot.item === 'sword') drawSwordIcon(ctx, sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2, SLOT_SIZE);
          else ctx.fillText(def.symbol, sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);

          // Bucket water level — vertical bar on the left edge of the slot
          if (slot.item === 'bucket') {
            this.renderBucketWaterBar(ctx, sx, sy, SLOT_SIZE, bucketFill);
          }

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
        if (this._ttHit(`hotbar-${i}`)) {
          this.renderHotbarTooltip(ctx, canvas, slots, i, sx, sy, bucketFill);
        }
        break;
      }
    }

    ctx.restore();
  }

  /** Vertical water fill indicator for the bucket hotbar slot (0 / half / full). */
  private renderBucketWaterBar(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    slotSize: number,
    bucketFill: number,
  ): void {
    const fill = Math.max(0, Math.min(2, bucketFill));
    const fillFrac = fill >= 2 ? 1 : fill >= 1 ? 0.5 : 0;
    const pad = 4;
    const barW = 6;
    const barX = sx + 3;
    const barY = sy + pad;
    const barH = slotSize - pad * 2;
    const innerH = Math.round(barH * fillFrac);

    ctx.save();
    ctx.fillStyle = 'rgba(12, 28, 48, 0.92)';
    ctx.strokeStyle = 'rgba(80, 140, 200, 0.85)';
    ctx.lineWidth = 1;
    this.roundRect(ctx, barX, barY, barW, barH, 2);
    ctx.fill();
    ctx.stroke();

    if (innerH > 0) {
      const waterY = barY + barH - innerH;
      const grad = ctx.createLinearGradient(0, waterY, 0, barY + barH);
      grad.addColorStop(0, '#6ec8ff');
      grad.addColorStop(1, '#1a6aa8');
      ctx.fillStyle = grad;
      this.roundRect(ctx, barX + 1, waterY, barW - 2, innerH - 1, 1);
      ctx.fill();
      // Water surface shimmer at top of fill
      ctx.fillStyle = 'rgba(180, 230, 255, 0.55)';
      ctx.fillRect(barX + 1, waterY, barW - 2, Math.min(3, innerH));
    }
    ctx.restore();
  }

  /** Three vertical vital bars (carry weight / food / water) to the right of the hotbar. */
  private renderVitalBars(
    ctx:          CanvasRenderingContext2D,
    canvas:       HTMLCanvasElement,
    carryWeight:  number,   // kg currently carried
    carryCapacity: number,  // max kg
    hunger:       number,   // 0–100 (100 = full)
    thirst:       number,   // 0–100 (100 = full)
  ): void {
    const SLOT_SIZE = 48;
    const SLOT_GAP  = 4;
    const PADDING   = 6;
    const LABEL_H   = 16;
    const hotbarW   = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const hotbarH   = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const hotbarX   = Math.round((canvas.width - hotbarW) / 2);
    const hotbarY   = canvas.height - hotbarH - 8;

    const BAR_W    = 14;
    const BAR_GAP  = 5;
    const ICON_SZ  = 8;
    const NUM_H    = 9;  // height reserved for numeric label
    const PAD      = 5;
    const barH     = hotbarH - PAD * 2 - ICON_SZ - 3 - NUM_H;
    const PANEL_W  = 3 * BAR_W + 2 * BAR_GAP + PAD * 2;
    const PANEL_H  = hotbarH;
    const px       = hotbarX + hotbarW + 6;
    const py       = hotbarY;

    ctx.save();
    ctx.fillStyle   = 'rgba(0,0,0,0.75)';
    ctx.fillRect(px, py, PANEL_W, PANEL_H);
    ctx.strokeStyle = '#556';
    ctx.lineWidth   = 1;
    ctx.strokeRect(px, py, PANEL_W, PANEL_H);

    const barTop  = py + PAD;
    const iconTop = barTop + barH + 3;
    const numTop  = iconTop + ICON_SZ + 1;

    interface BarDef {
      label:    string;
      pct:      number;
      highIsBad: boolean;
      normal:   string;
      warn:     string;
      crit:     string;
      warnAt:   number;
      critAt:   number;
    }
    const defs: BarDef[] = [
      { label: 'WT',   pct: Math.min(carryWeight / Math.max(carryCapacity, 1), 1),
        highIsBad: true,  normal: '#664422', warn: '#cc8811', crit: '#cc2222', warnAt: 0.70, critAt: 0.85 },
      { label: 'FOOD', pct: Math.max(0, Math.min(hunger / 100, 1)),
        highIsBad: false, normal: '#3a8a3a', warn: '#cc8811', crit: '#cc2222', warnAt: 0.30, critAt: 0.15 },
      { label: 'H2O',  pct: Math.max(0, Math.min(thirst / 100, 1)),
        highIsBad: false, normal: '#2266bb', warn: '#cc8811', crit: '#cc2222', warnAt: 0.30, critAt: 0.15 },
    ];

    for (let i = 0; i < defs.length; i++) {
      const d   = defs[i];
      const bx  = px + PAD + i * (BAR_W + BAR_GAP);
      const icx = bx + BAR_W / 2;

      const isCrit = d.highIsBad ? d.pct >= d.critAt  : d.pct <= d.critAt;
      const isWarn = d.highIsBad ? d.pct >= d.warnAt  : d.pct <= d.warnAt;
      const fill   = isCrit ? d.crit : isWarn ? d.warn : d.normal;

      // Track
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(bx, barTop, BAR_W, barH);

      // Fill (bottom-up)
      const fillH = Math.round(barH * d.pct);
      ctx.fillStyle = fill;
      ctx.fillRect(bx, barTop + barH - fillH, BAR_W, fillH);
      // Change-flash + critical-full red pulse (WT only)
      const _vbKey = i === 0 ? 'bar-wt' : i === 1 ? 'bar-food' : 'bar-h2o';
      this._tickFlash(_vbKey, d.pct);
      const _vbFa = this._flashAlpha(_vbKey);
      if (_vbFa > 0) {
        ctx.fillStyle = `rgba(255,255,255,${_vbFa.toFixed(2)})`;
        ctx.fillRect(bx, barTop, BAR_W, barH);
      }
      if (i === 0 && isCrit) {
        const _pulse = 0.20 + 0.20 * Math.sin(performance.now() / 200);
        ctx.fillStyle = `rgba(255,0,0,${_pulse.toFixed(2)})`;
        ctx.fillRect(bx, barTop, BAR_W, barH);
      }

      // Border
      ctx.strokeStyle = isCrit ? 'rgba(255,80,80,0.6)' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth   = 1;
      ctx.strokeRect(bx, barTop, BAR_W, barH);

      // Rotated label inside bar
      ctx.save();
      ctx.fillStyle    = 'rgba(255,255,255,0.75)';
      ctx.font         = `bold 7px Georgia, serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(bx + BAR_W / 2, barTop + barH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(d.label, 0, 0);
      ctx.restore();

      // Icon
      const icy = iconTop + ICON_SZ / 2;
      const r   = ICON_SZ * 0.44;
      if (i === 0) {
        // Anchor (weight)
        ctx.strokeStyle = isCrit ? '#ff6666' : '#aabbaa';
        ctx.fillStyle   = isCrit ? '#ff6666' : '#aabbaa';
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.arc(icx, icy - r * 0.5, r * 0.3, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(icx, icy - r * 0.2); ctx.lineTo(icx, icy + r * 0.9); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(icx - r * 0.7, icy - r * 0.1); ctx.lineTo(icx + r * 0.7, icy - r * 0.1); ctx.stroke();
        ctx.beginPath(); ctx.arc(icx, icy + r * 0.5, r * 0.5, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      } else if (i === 1) {
        // Apple (food)
        ctx.fillStyle = isCrit ? '#ff6666' : '#66bb44';
        ctx.beginPath(); ctx.arc(icx, icy + r * 0.1, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = isCrit ? '#ff8888' : '#88dd66';
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.moveTo(icx, icy - r * 0.8); ctx.lineTo(icx + r * 0.5, icy - r * 1.2); ctx.stroke();
      } else {
        // Teardrop (water)
        ctx.beginPath();
        ctx.moveTo(icx, iconTop);
        ctx.bezierCurveTo(icx + r * 0.9, icy - r * 0.1, icx + r, icy + r * 0.5, icx, icy + r);
        ctx.bezierCurveTo(icx - r, icy + r * 0.5, icx - r * 0.9, icy - r * 0.1, icx, iconTop);
        ctx.closePath();
        ctx.fillStyle = isCrit ? '#ff6666' : '#4499dd';
        ctx.fill();
      }

      // Numeric label below icon
      ctx.font         = '8px Georgia, serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = isCrit ? '#ff9999' : 'rgba(160,180,200,0.75)';
      const numTxt = i === 0
        ? `${Math.round(carryWeight)}`
        : `${Math.round(d.pct * 100)}%`;
      ctx.fillText(numTxt, bx + BAR_W / 2, numTop);
    }

    // ── Bar hover tooltips ─────────────────────────────────────────────────
    const _mx = this.mouseX, _my = this.mouseY;
    for (let i = 0; i < defs.length; i++) {
      const d  = defs[i];
      const bx = px + PAD + i * (BAR_W + BAR_GAP);
      if (_mx < bx || _mx > bx + BAR_W || _my < barTop || _my > barTop + barH) continue;
      const isCrit = d.highIsBad ? d.pct >= d.critAt : d.pct <= d.critAt;
      const isWarn = d.highIsBad ? d.pct >= d.warnAt : d.pct <= d.warnAt;
      const col    = isCrit ? d.crit : isWarn ? d.warn : d.normal;
      const ttKey  = i === 0 ? 'bar-wt' : i === 1 ? 'bar-food' : 'bar-h2o';
      if (i === 0) {
        if (this._ttHit(ttKey)) {
          const wtDesc = isCrit
            ? 'Overencumbered — movement is impaired.'
            : isWarn ? 'Heavy load. Movement may slow near capacity.'
            : 'Items in your inventory add to carry weight.';
          this._drawStatTooltip(ctx, canvas, bx + BAR_W / 2, barTop,
            'Carry Weight', col, '#ccbbaa',
            `${Math.round(carryWeight)} / ${Math.round(carryCapacity)} kg`,
            wtDesc, [],
          );
        }
      } else if (i === 1) {
        if (this._ttHit(ttKey)) {
          const desc = isCrit ? 'Starving — health is draining rapidly.'
            : isWarn ? 'Hungry. Eat food to restore your hunger.'
            : 'Well fed. Food restores hunger over time.';
          this._drawStatTooltip(ctx, canvas, bx + BAR_W / 2, barTop,
            'Hunger', col, '#aaffaa',
            `${Math.round(hunger)}%`,
            desc, [],
          );
        }
      } else {
        if (this._ttHit(ttKey)) {
          const desc = isCrit ? 'Dehydrated — health is draining rapidly.'
            : isWarn ? 'Thirsty. Drink water to restore your thirst.'
            : 'Well hydrated. Water restores thirst over time.';
          this._drawStatTooltip(ctx, canvas, bx + BAR_W / 2, barTop,
            'Thirst', col, '#aabbff',
            `${Math.round(thirst)}%`,
            desc, [],
          );
        }
      }
    }

    ctx.restore();
  }

  /** Draw a compact stat info card anchored above a bar. */
  private _drawStatTooltip(
    ctx:       CanvasRenderingContext2D,
    canvas:    HTMLCanvasElement,
    anchorCX:  number,
    anchorTop: number,
    name:      string,
    accent:    string,
    border:    string,
    value:     string,
    desc:      string,
    extras:    Array<{ label: string; val: string; col?: string }>,
  ): void {
    const PAD    = 10;
    const W      = 210;
    const LINE   = 15;
    const NAME_H = 17;

    const descLines = this.wrapText(ctx, desc, W - PAD * 2 - 4, '11px Georgia, serif');
    const totalH = PAD + NAME_H + 4
      + (descLines.length > 0 ? descLines.length * LINE + 4 : 0)
      + extras.length * LINE
      + PAD;

    let tx = anchorCX - W / 2;
    let ty = anchorTop - totalH - 8;
    tx = Math.max(4, Math.min(canvas.width - W - 4, tx));
    if (ty < 4) ty = anchorTop + 8;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = 'rgba(12,12,20,0.94)';
    ctx.strokeStyle = border;
    ctx.lineWidth   = 1.5;
    this.roundRect(ctx, tx, ty, W, totalH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = accent;
    this.roundRect(ctx, tx, ty, 4, totalH, { tl: 6, tr: 0, br: 0, bl: 6 });
    ctx.fill();

    let cy = ty + PAD;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';

    ctx.font      = 'bold 13px Georgia, serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, tx + PAD + 4, cy);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#cccccc';
    ctx.fillText(value, tx + W - PAD - 4, cy);
    cy += NAME_H + 4;

    if (descLines.length > 0) {
      ctx.textAlign = 'left';
      ctx.font      = '11px Georgia, serif';
      ctx.fillStyle = '#aaaaaa';
      for (const l of descLines) { ctx.fillText(l, tx + PAD + 4, cy); cy += LINE; }
      cy += 4;
    }

    for (const e of extras) {
      ctx.font = '11px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#888888';
      ctx.fillText(e.label, tx + PAD + 4, cy);
      ctx.textAlign = 'right';
      ctx.fillStyle = e.col ?? '#cccccc';
      ctx.fillText(e.val, tx + W - PAD - 4, cy);
      cy += LINE;
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
    bucketFill = 0,
  ): void {
    const SLOT_SIZE = 48;
    const slot = slots[hoveredIndex] ?? { item: 'none' as ItemKind, quantity: 0 };
    if (slot.item === 'none') return;

    const def    = ITEM_DEFS[slot.item] ?? ITEM_DEFS['none'];
    const itemId = ITEM_KIND_ID[slot.item] ?? 0;
    const bucketExtra = slot.item === 'bucket'
      ? (bucketFill >= 2 ? 'Water: Full bucket (4 HP taken from ship)' : bucketFill >= 1 ? 'Water: Half bucket (2 HP taken from ship)' : 'Water: Empty')
      : null;

    const PAD   = 10;
    const W     = 220;
    const LINE  = 16;
    const nameH = 18;
    const descLines = this.wrapText(ctx, def.description, W - PAD * 2, '12px Georgia, serif');
    const extraLines = bucketExtra ? 1 : 0;
    const totalH = PAD + nameH + 4 + LINE + 4 + descLines.length * LINE + (extraLines ? LINE : 0) + LINE + PAD;

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

    if (bucketExtra) {
      ctx.fillStyle = bucketFill >= 2 ? '#6ec8ff' : bucketFill >= 1 ? '#4a9fd4' : '#888';
      ctx.font      = '12px Georgia, serif';
      ctx.fillText(bucketExtra, tx + PAD + 4, cy);
      cy += LINE;
    }

    // Weight
    const wPerUnit = def.weight;
    const totalW   = wPerUnit * (slot.quantity || 1);
    const weightTxt = slot.quantity > 1
      ? `Weight: ${wPerUnit} kg ea  ·  ${totalW} kg total`
      : `Weight: ${wPerUnit} kg`;
    ctx.fillStyle = '#8ab4cc';
    ctx.font      = '11px Georgia, serif';
    ctx.fillText(weightTxt, tx + PAD + 4, cy);

    ctx.restore();
  }

  /** Draw a tooltip popup for a build hotbar slot (ship or land build mode). */
  private _drawBuildSlotTooltip(
    ctx:         CanvasRenderingContext2D,
    canvas:      HTMLCanvasElement,
    sx:          number,
    sy:          number,
    slotSize:    number,
    label:       string,
    color:       string,
    borderColor: string,
    costLines:   string[],
    variantInfo?: { tierPrefix: string; crafts: number; color: string; costMult: number },
  ): void {
    const PAD    = 10;
    const LINE   = 15;
    const W      = 190;
    // When a variant is active, add a blueprint cost line
    const extraLines = variantInfo ? 1 : 0;
    const totalH = PAD + 18 + (costLines.length + extraLines > 0 ? 6 + (costLines.length + extraLines) * LINE : 0) + PAD;

    let tx = sx + slotSize / 2 - W / 2;
    let ty = sy - totalH - 6;
    tx = Math.max(4, Math.min(canvas.width - W - 4, tx));
    if (ty < 4) ty = sy + slotSize + 6;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = 'rgba(12,12,20,0.94)';
    ctx.strokeStyle = variantInfo ? variantInfo.color : borderColor;
    ctx.lineWidth   = 1.5;
    this.roundRect(ctx, tx, ty, W, totalH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Left colour accent bar
    ctx.fillStyle = variantInfo ? variantInfo.color : color;
    this.roundRect(ctx, tx, ty, 4, totalH, { tl: 6, tr: 0, br: 0, bl: 6 });
    ctx.fill();

    let cy = ty + PAD;

    // Structure name — prefixed with tier name and coloured when a variant is active
    const displayLabel = variantInfo ? `${variantInfo.tierPrefix} ${label}` : label;
    ctx.fillStyle    = variantInfo ? variantInfo.color : '#ffffff';
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(displayLabel, tx + PAD + 4, cy);
    cy += 18;

    // Resource costs
    const allCostLines = variantInfo
      ? [...costLines, `\u25c6 Blueprint \u00d7${variantInfo.crafts} remaining`]
      : costLines;
    if (allCostLines.length > 0) {
      cy += 6;
      ctx.font = '11px Georgia, serif';
      for (let i = 0; i < allCostLines.length; i++) {
        // Blueprint line gets tier color; resource lines are dimmed
        ctx.fillStyle = (variantInfo && i === allCostLines.length - 1) ? variantInfo.color : '#aaaaaa';
        ctx.fillText(allCostLines[i], tx + PAD + 4, cy);
        cy += LINE;
      }
    }

    ctx.restore();
  }

  /**
   * Renders the floating variant picker popup above the active build hotbar slot.
   * Each row is a clickable hit-area recorded into `_variantPopup.hits`.
   */
  private _renderVariantPopup(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const popup = this._variantPopup;
    if (!popup) return;

    const variants = this.getVariantsForKind(popup.kind);
    const activeInfo = this.getVariantTooltipInfo(popup.kind);
    const ROW_H  = 24;  // primary row height
    const PILL_H = 14;  // stat pill line height
    const PAD = 10;
    const W = 230;

    // Compute heights: each blueprint row with any non-zero stats gets an extra pill line
    const statNames    = this.qualityStatNamesFn();
    const hasPills = (bp: { stats: number[]; tier: number }) =>
      bp.stats.some(s => s !== 0 && s !== 256) || bp.tier >= 1;
    const totalH = PAD
      + ROW_H /* Standard row */
      + variants.reduce((acc, bp) => acc + ROW_H + (hasPills(bp) ? PILL_H : 0), 0)
      + PAD;

    let px = popup.anchorX - W / 2;
    let py = popup.anchorY - totalH - 6;
    px = Math.max(4, Math.min(canvas.width  - W - 4, px));
    py = Math.max(4, Math.min(canvas.height - totalH - 4, py));

    popup.hits = []; // reset hit areas for this frame

    ctx.save();

    // Panel background
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = 'rgba(10,10,22,0.96)';
    ctx.strokeStyle = 'rgba(200,160,50,0.7)';
    ctx.lineWidth   = 1.5;
    this.roundRect(ctx, px, py, W, totalH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Header
    ctx.font         = 'bold 10px Georgia, serif';
    ctx.fillStyle    = 'rgba(200,160,50,0.7)';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('SELECT VARIANT', px + PAD, py + 5);

    // Standard row
    const stdY   = py + PAD;
    const isStd  = !activeInfo;
    popup.hits.push({ index: null, x: px, y: stdY, w: W, h: ROW_H });

    if (isStd) {
      ctx.fillStyle = 'rgba(80,160,80,0.15)';
      ctx.beginPath();
      ctx.roundRect(px + 2, stdY, W - 4, ROW_H, 3);
      ctx.fill();
    }

    ctx.font         = 'bold 11px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = isStd ? '#88ee88' : 'rgba(180,180,180,0.7)';
    ctx.textAlign    = 'left';
    ctx.fillText(isStd ? '✓' : '○', px + PAD, stdY + ROW_H / 2);
    ctx.fillStyle = isStd ? '#cceecc' : 'rgba(180,180,180,0.7)';
    ctx.fillText('Standard', px + PAD + 14, stdY + ROW_H / 2);
    ctx.font      = '9px Georgia, serif';
    ctx.fillStyle = 'rgba(140,140,140,0.6)';
    ctx.textAlign = 'right';
    ctx.fillText('(resources only)', px + W - PAD, stdY + ROW_H / 2);

    // Blueprint rows — rowY tracked dynamically because pill lines vary per row
    let bpCursorY = stdY + ROW_H;
    for (let bi = 0; bi < variants.length; bi++) {
      const bp     = variants[bi];
      const rowY   = bpCursorY;
      const col    = this._tierColorCache(bp.tier);
      const tname  = this._tierNameCache(bp.tier);
      const isSel  = activeInfo && this._activeVariantIndex(popup.kind) === bp.index;
      const pills  = hasPills(bp);
      const thisRowH = ROW_H + (pills ? PILL_H : 0);

      popup.hits.push({ index: bp.index, x: px, y: rowY, w: W, h: thisRowH });

      if (isSel) {
        ctx.fillStyle = 'rgba(60,40,100,0.25)';
        ctx.beginPath();
        ctx.roundRect(px + 2, rowY, W - 4, thisRowH, 3);
        ctx.fill();
      }

      // Radio dot
      ctx.font         = 'bold 11px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = isSel ? col : 'rgba(140,140,140,0.6)';
      ctx.fillText(isSel ? '✓' : '○', px + PAD, rowY + ROW_H / 2);

      // Tier colour dot
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px + PAD + 20, rowY + ROW_H / 2, 4, 0, Math.PI * 2);
      ctx.fill();

      // Tier name
      ctx.font      = 'bold 11px Georgia, serif';
      ctx.fillStyle = col;
      ctx.fillText(tname, px + PAD + 28, rowY + ROW_H / 2);

      // ×crafts
      const tnameW = ctx.measureText(tname).width;
      ctx.font      = '10px Georgia, serif';
      ctx.fillStyle = bp.crafts > 0 ? '#b0d0b0' : 'rgba(130,130,130,0.6)';
      ctx.fillText(`×${bp.crafts}`, px + PAD + 28 + tnameW + 6, rowY + ROW_H / 2);

      // Stat pills on a secondary line
      if (pills) {
        const pillLineY = rowY + ROW_H;
        let pillX = px + PAD;
        const maxPillX = px + W - PAD;

        // Per-stat pills (e.g. "D:+12%")
        for (let si = 0; si < bp.stats.length && pillX < maxPillX - 24; si++) {
          const lbl = this.statMultLabelFn(bp.stats[si]);
          if (!lbl) continue;
          const initial = (statNames[si] ?? '?')[0];
          const pill = `${initial}:${lbl}`;
          ctx.font = '9px Georgia, serif';
          const pillW = ctx.measureText(pill).width + 6;
          if (pillX + pillW > maxPillX) break;
          ctx.fillStyle = 'rgba(50,80,50,0.55)';
          ctx.beginPath();
          ctx.roundRect(pillX, pillLineY + 2, pillW, PILL_H - 4, 2);
          ctx.fill();
          ctx.fillStyle = '#88ee88';
          ctx.textBaseline = 'middle';
          ctx.fillText(pill, pillX + 3, pillLineY + PILL_H / 2);
          pillX += pillW + 3;
        }

        // Tier bonus pill ("+N% T")
        if (bp.tier >= 1 && pillX < maxPillX - 20) {
          const bonusPill = `+${bp.tier * 10}% T`;
          ctx.font = '9px Georgia, serif';
          const pillW = ctx.measureText(bonusPill).width + 6;
          if (pillX + pillW <= maxPillX) {
            ctx.fillStyle = 'rgba(80,50,10,0.6)';
            ctx.beginPath();
            ctx.roundRect(pillX, pillLineY + 2, pillW, PILL_H - 4, 2);
            ctx.fill();
            ctx.fillStyle = col;
            ctx.textBaseline = 'middle';
            ctx.fillText(bonusPill, pillX + 3, pillLineY + PILL_H / 2);
          }
        }
      }

      bpCursorY += thisRowH;
    }

    ctx.restore();
  }

  /** Reads the currently-selected blueprint index for a kind (used by popup rendering). */
  private _activeVariantIndex(kind: string): number | null {
    // Forward to getVariantTooltipInfo indirectly — we check the selection via tooltip absence
    // The popup is responsible for opening only when the kind matches, so we track selection
    // through setVariantForKind/getVariantTooltipInfo.  Here we just need the raw index.
    // UIManager wires setVariantForKind which writes through to PlayerMenu._variantSelection.
    // We read it back via getVariantsForKind cross-referenced with getVariantTooltipInfo:
    const info = this.getVariantTooltipInfo(kind);
    if (!info) return null;
    // Match by tier+crafts — not perfect if two blueprints have identical tier+crafts, but
    // functionally correct since the popup only shows distinct blueprints.
    const vs = this.getVariantsForKind(kind);
    return vs.find(v => {
      const col = this._tierColorCache(v.tier);
      return col === info.color && v.crafts === info.crafts;
    })?.index ?? null;
  }

  // Tiny cache wrappers so HUDElement doesn't need to import Quality.ts directly.
  // These are set by UIManager after wiring:
  public tierColorFn: (tier: number) => string = () => '#ffffff';
  public tierNameFn:  (tier: number) => string = () => 'Unknown';
  public statMultLabelFn: (q8: number) => string | null = () => null;
  public qualityStatNamesFn: () => readonly string[] = () => [];
  private _tierColorCache(tier: number): string { return this.tierColorFn(tier); }
  private _tierNameCache(tier: number):  string { return this.tierNameFn(tier);  }

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

  /**
   * HUD equipment panel — bottom-right corner.
   * Shows all 6 equipment slots (helm, chest, legs, feet, hands, shield)
   * as small icon slots with labels. Filled slots glow gold.
   */
  private renderEquipmentHUD(
    ctx:    CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    equip:  { helm: ItemKind; torso: ItemKind; legs: ItemKind; feet: ItemKind; hands: ItemKind; shield: ItemKind },
  ): void {
    // 6 slots arranged in two columns of 3, matching the character sheet layout:
    //   col0 (body):  Helm, Chest, Legs
    //   col1 (extra): Hands, Feet, Shield
    const SLOT_W  = 36;
    const SLOT_H  = 32;
    const SLOT_GAP_X = 6;
    const SLOT_GAP_Y = 4;
    const LABEL_H = 11;
    const COL_STRIDE = SLOT_W + SLOT_GAP_X;
    const ROW_STRIDE = SLOT_H + LABEL_H + SLOT_GAP_Y;
    const PADDING = 7;
    const COLS = 2, ROWS = 3;
    const panelW = COLS * COL_STRIDE - SLOT_GAP_X + PADDING * 2;
    const panelH = ROWS * ROW_STRIDE - SLOT_GAP_Y + PADDING * 2;

    // Position: bottom-right, just above the hotbar is not needed — place it at bottom-right edge
    const px = canvas.width  - panelW - 6;
    const py = canvas.height - panelH - 6;

    ctx.save();

    // Panel background
    ctx.fillStyle = 'rgba(8,10,18,0.82)';
    ctx.strokeStyle = 'rgba(80,80,120,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(px, py, panelW, panelH, 4);
    else ctx.rect(px, py, panelW, panelH);
    ctx.fill();
    ctx.stroke();

    // Slot definitions — col0: body column, col1: extras
    const slots: { label: string; item: ItemKind; col: number; row: number }[] = [
      { label: 'Helm',   item: equip.helm,   col: 0, row: 0 },
      { label: 'Chest',  item: equip.torso,  col: 0, row: 1 },
      { label: 'Legs',   item: equip.legs,   col: 0, row: 2 },
      { label: 'Hands',  item: equip.hands,  col: 1, row: 0 },
      { label: 'Feet',   item: equip.feet,   col: 1, row: 1 },
      { label: 'Shield', item: equip.shield, col: 1, row: 2 },
    ];

    for (const { label, item, col, row } of slots) {
      const def = ITEM_DEFS[item] ?? ITEM_DEFS['none'];
      const sx  = px + PADDING + col * COL_STRIDE;
      const sy  = py + PADDING + row * ROW_STRIDE;
      const filled = item !== 'none';

      // Slot background
      ctx.fillStyle   = filled ? 'rgba(55,44,18,0.95)' : 'rgba(20,22,36,0.9)';
      ctx.strokeStyle = filled ? def.borderColor        : 'rgba(60,65,100,0.7)';
      ctx.lineWidth   = filled ? 1.5 : 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(sx, sy, SLOT_W, SLOT_H, 3);
      else ctx.rect(sx, sy, SLOT_W, SLOT_H);
      ctx.fill();
      ctx.stroke();

      if (filled) {
        // Color swatch
        const pad = 5;
        ctx.fillStyle = def.color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(sx + pad, sy + pad, SLOT_W - pad * 2, SLOT_H - pad * 2, 2);
        else ctx.rect(sx + pad, sy + pad, SLOT_W - pad * 2, SLOT_H - pad * 2);
        ctx.fill();
        // Symbol
        ctx.font         = `bold ${SLOT_H <= 32 ? 13 : 15}px Georgia, serif`;
        ctx.fillStyle    = '#fff';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        if (item === 'axe') drawAxeIcon(ctx, sx + SLOT_W / 2, sy + SLOT_H / 2, SLOT_W);
        else ctx.fillText(def.symbol, sx + SLOT_W / 2, sy + SLOT_H / 2);
      }

      // Label below slot
      ctx.font         = '9px Georgia, serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = filled ? '#c8b87a' : 'rgba(80,85,120,0.9)';
      ctx.fillText(label, sx + SLOT_W / 2, sy + SLOT_H + 2);
    }

    ctx.restore();
  }

  private renderWaterMeter(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    hullHealth: number,
    plankRatio: number = 1,
    shipRotation: number = 0,
    mastModules: import('../../sim/modules.js').ShipModule[] = [],
    shipHull: import('../../common/Vec2.js').Vec2[] = [],
    windAngle: number = 0,
    debugMode: boolean = false,
    shipSpeed: number = 0,
    cameraRotation: number = 0,
    shipName?: string,
    shipLevel?: number,
    shipWeight: number = 0,
    shipWeightKg: number = 0,
    shipWeightCap: number = 6000,
    /** Per-deck health ratios indexed by deck level (0=lower, 1=upper). When provided with 2+
     *  entries, separate labelled bars are drawn instead of the single combined DECK bar. */
    deckRatios: number[] = [],
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

    // ── Apply ship rotation around icon centre (adjusted for camera rotation) ──
    ctx.translate(cx, cy);
    ctx.rotate(shipRotation - cameraRotation + Math.PI / 2);
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
      ctx.rotate(-(shipRotation - cameraRotation + Math.PI / 2));
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

      // Sail arc + openness indicator line
      const md = mast.moduleData as { kind: string; angle?: number; openness?: number } | undefined;
      const sailAngle = md?.angle ?? 0;   // radians, ship-local
      const openness  = (md?.openness ?? 100) / 100;

      // ── Wind-effectiveness colour ──────────────────────────────────────
      // sailAngle is ship-local; windAngle is world-space (same CW-from-N convention).
      // ±15° of wind → full green (#39ff14); beyond ±90° → full red (#ff3214).
      // Linearly blends between the two limits.
      {
        // nothing here yet — colour computed just below
      }
      const _sailWorld = sailAngle + shipRotation + Math.PI / 2;
      let   _diff      = _sailWorld - windAngle;
      while (_diff >  Math.PI) _diff -= 2 * Math.PI;
      while (_diff < -Math.PI) _diff += 2 * Math.PI;
      const _absD     = Math.abs(_diff);
      const _FULL_EFF = 15 * Math.PI / 180;  // ±15° → 100%
      const _NO_EFF   = 90 * Math.PI / 180;  // ±90° → min
      const _t        = Math.max(0, Math.min(1, (_absD - _FULL_EFF) / (_NO_EFF - _FULL_EFF)));
      // Green (57,255,20) → Red (255,50,20)
      const _cr = Math.round(57  + _t * (255 - 57));
      const _cg = Math.round(255 + _t * (50  - 255));
      const sailColor = `rgb(${_cr},${_cg},20)`;

      ctx.save();
      ctx.translate(cx, my);
      ctx.rotate(sailAngle);

      ctx.strokeStyle = sailColor;
      ctx.shadowColor = sailColor;
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

    // ── Wind direction arrow (screen-space, always world-aligned) ─────────
    // windAngle = 0 → North (screen up), increases clockwise.
    // Tail is pinned to the icon centre; length scales with wind strength.
    // windStrength raw range 0.30–1.00 is normalised to 0–1 so the visual
    // span is as wide as possible: ~8 px at weakest, ~52 px at strongest.
    {
      const headLen   = 9;    // arrowhead triangle height (fixed)
      const headW     = 6;    // arrowhead triangle half-width (fixed)
      const windStrength = 0.3 + 0.7 * Math.abs(Math.cos(windAngle)); // matches server formula
      const normStr   = (windStrength - 0.3) / 0.7;  // 0 = weakest (E/W), 1 = strongest (N/S)
      const shaftLen  = 8 + normStr * 44;             // 8 px weak → 52 px strong
      const totalLen  = shaftLen + headLen; // tip offset from tail (origin)

      ctx.save();
      ctx.translate(cx, cy);  // tail = icon centre
      ctx.rotate(windAngle - cameraRotation);

      ctx.shadowColor = 'rgba(255, 235, 80, 0.85)';
      ctx.shadowBlur  = 6;

      // Shaft — tail at (0,0), tip at (0, -totalLen)
      ctx.strokeStyle = 'rgba(255, 235, 80, 0.92)';
      ctx.lineWidth   = 3;
      ctx.beginPath();
      ctx.moveTo(0, 0);           // tail (icon centre)
      ctx.lineTo(0, -shaftLen);   // tip of shaft
      ctx.stroke();

      // Arrowhead sits beyond the shaft tip
      ctx.fillStyle = 'rgba(255, 235, 80, 0.88)';
      ctx.beginPath();
      ctx.moveTo(0,      -totalLen);            // point
      ctx.lineTo(-headW, -totalLen + headLen);
      ctx.lineTo( headW, -totalLen + headLen);
      ctx.closePath();
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // labelY is below the maximum rotated extent of the silhouette
    // (pushed down further if a ship name/level block is shown above it)
    const nameBlockH = (shipName ? 13 : 0) + (shipLevel !== undefined ? 12 : 0);

    // ── Ship name + level (between silhouette and bars) ───────────────────
    if (shipName || shipLevel !== undefined) {
      let nameLineY = cy + halfDiag + 6;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      if (shipName) {
        ctx.font      = 'bold 10px Georgia, serif';
        ctx.fillStyle = '#f0e0b0';
        ctx.fillText(shipName, cx, nameLineY);
        nameLineY += 13;
      }
      if (shipLevel !== undefined) {
        ctx.font      = '9px Georgia, serif';
        ctx.fillStyle = '#88ccff';
        ctx.fillText(`Lv. ${shipLevel}`, cx, nameLineY);
      }
    }

    const labelY = cy + halfDiag + (nameBlockH > 0 ? nameBlockH + 10 : 6);

    ctx.save();

    // ── Two vertical bars: Water (left) and Weight (right) ────────────────
    const weightRatio = Math.max(0, Math.min(1, shipWeight / 100));
    const vBarW       = 20;
    const vBarGap     = 4;   // 20 + 4 + 20 = 44 = iW
    const vBarH       = 56;
    const lBarX       = ix;
    const rBarX       = ix + vBarW + vBarGap;
    const weightCrit  = weightRatio > 0.85;
    const weightWarn  = weightRatio > 0.70;

    // Backgrounds
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(lBarX, labelY, vBarW, vBarH);
    ctx.fillRect(rBarX, labelY, vBarW, vBarH);

    // Water fill (bottom-up)
    const waterFillH = Math.round(vBarH * waterFill);
    ctx.fillStyle    = isCritical ? '#cc2222' : '#2266bb';
    ctx.fillRect(lBarX, labelY + vBarH - waterFillH, vBarW, waterFillH);
    this._tickFlash('ship-water', waterFill);
    const _wFa = this._flashAlpha('ship-water');
    if (_wFa > 0) {
      ctx.fillStyle = `rgba(255,255,255,${_wFa.toFixed(2)})`;
      ctx.fillRect(lBarX, labelY, vBarW, vBarH);
    }

    // Weight fill (bottom-up)
    const weightFillH = Math.round(vBarH * weightRatio);
    ctx.fillStyle     = weightCrit ? '#cc2222' : weightWarn ? '#cc8811' : '#664422';
    ctx.fillRect(rBarX, labelY + vBarH - weightFillH, vBarW, weightFillH);
    this._tickFlash('ship-weight', weightRatio);
    const _swFa = this._flashAlpha('ship-weight');
    if (_swFa > 0) {
      ctx.fillStyle = `rgba(255,255,255,${_swFa.toFixed(2)})`;
      ctx.fillRect(rBarX, labelY, vBarW, vBarH);
    }
    if (weightCrit) {
      const _swPulse = 0.20 + 0.20 * Math.sin(performance.now() / 200);
      ctx.fillStyle = `rgba(255,0,0,${_swPulse.toFixed(2)})`;
      ctx.fillRect(rBarX, labelY, vBarW, vBarH);
    }

    // Borders
    ctx.lineWidth   = 1;
    ctx.strokeStyle = isCritical ? 'rgba(255,80,80,0.60)' : 'rgba(255,255,255,0.22)';
    ctx.strokeRect(lBarX, labelY, vBarW, vBarH);
    ctx.strokeStyle = weightCrit ? 'rgba(255,80,80,0.60)' : 'rgba(255,255,255,0.22)';
    ctx.strokeRect(rBarX, labelY, vBarW, vBarH);

    // Labels inside bars (rotated −90°)
    ctx.fillStyle    = 'rgba(255,255,255,0.80)';
    ctx.font         = 'bold 8px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    ctx.save();
    ctx.translate(lBarX + vBarW / 2, labelY + vBarH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('WATER', 0, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(rBarX + vBarW / 2, labelY + vBarH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('WEIGHT', 0, 0);
    ctx.restore();

    // ── Icons below bars ──────────────────────────────────────────────────
    const iconAreaY = labelY + vBarH + 5;
    const iconSz    = 10;
    const lIconCx   = lBarX + vBarW / 2;
    const rIconCx   = rBarX + vBarW / 2;

    // Teardrop (water icon)
    {
      const tx = lIconCx;
      const ty = iconAreaY + iconSz * 0.55;
      const r  = iconSz * 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, iconAreaY);
      ctx.bezierCurveTo(tx + r * 0.9, ty - r * 0.1,  tx + r, ty + r * 0.5,  tx, ty + r);
      ctx.bezierCurveTo(tx - r, ty + r * 0.5,  tx - r * 0.9, ty - r * 0.1,  tx, iconAreaY);
      ctx.closePath();
      ctx.fillStyle = isCritical ? '#ff6666' : '#4499dd';
      ctx.fill();
    }

    // Anchor (weight icon)
    {
      const ax = rIconCx;
      const ay = iconAreaY;
      const ar = iconSz * 0.5;
      ctx.strokeStyle = weightCrit ? '#ff6666' : '#aabbaa';
      ctx.fillStyle   = weightCrit ? '#ff6666' : '#aabbaa';
      ctx.lineWidth   = 1.3;
      // Ring
      ctx.beginPath();
      ctx.arc(ax, ay + ar * 0.38, ar * 0.28, 0, Math.PI * 2);
      ctx.stroke();
      // Shaft
      ctx.beginPath();
      ctx.moveTo(ax, ay + ar * 0.66);
      ctx.lineTo(ax, ay + ar * 1.72);
      ctx.stroke();
      // Crossbar
      ctx.beginPath();
      ctx.moveTo(ax - ar * 0.72, ay + ar * 0.92);
      ctx.lineTo(ax + ar * 0.72, ay + ar * 0.92);
      ctx.stroke();
      // Bottom arc
      ctx.beginPath();
      ctx.arc(ax, ay + ar * 1.28, ar * 0.50, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      // End dots
      ctx.beginPath();
      ctx.arc(ax - ar * 0.49, ay + ar * 1.70, ar * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ax + ar * 0.49, ay + ar * 1.70, ar * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Deck health bar(s) (horizontal) ───────────────────────────────────
    const barY      = iconAreaY + iconSz + 6;
    const barW      = iW;
    const barH      = 8;

    // When per-deck ratios are supplied (brigantine: index 0=lower, 1=upper),
    // draw a separate labelled bar for each deck. Otherwise fall back to the
    // combined plankRatio with the generic "DECK" label.
    const deckBars: { label: string; ratio: number; flashKey: string }[] =
      deckRatios.length >= 2
        ? deckRatios.map((r, i) => ({
            label:    i === 0 ? 'LOWER' : 'UPPER',
            ratio:    r ?? 1,
            flashKey: `ship-deck-${i}`,
          }))
        : [{ label: 'DECK', ratio: plankRatio, flashKey: 'ship-deck' }];

    let curBarY = barY;
    for (const bar of deckBars) {
      const isCrit = bar.ratio < 0.30;
      const isWarn = bar.ratio < 0.60;
      const color  = isCrit ? '#dd3333' : isWarn ? '#dd9922' : '#33aa55';

      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(ix, curBarY, barW, barH);

      ctx.fillStyle = color;
      ctx.fillRect(ix, curBarY, Math.round(barW * bar.ratio), barH);
      this._tickFlash(bar.flashKey, bar.ratio);
      const _dkFa = this._flashAlpha(bar.flashKey);
      if (_dkFa > 0) {
        ctx.fillStyle = `rgba(255,255,255,${_dkFa.toFixed(2)})`;
        ctx.fillRect(ix, curBarY, barW, barH);
      }

      ctx.strokeStyle = isCrit ? '#ff4444' : 'rgba(255,255,255,0.30)';
      ctx.lineWidth   = 1;
      ctx.strokeRect(ix, curBarY, barW, barH);

      const pct = Math.round(bar.ratio * 100);
      ctx.font         = '9px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = isCrit ? '#ff5555' : '#778866';
      ctx.fillText(bar.label, ix, curBarY + barH + 3);
      ctx.textAlign = 'right';
      ctx.fillStyle = isCrit ? '#ff5555' : '#aabbaa';
      ctx.fillText(`${pct}%`, ix + barW, curBarY + barH + 3);

      curBarY += barH + 16; // bar(8) + label line(~10) + gap(~6)
    }

    // ── Wind / force debug panel (left of silhouette, debug mode only) ────
    if (debugMode) {
      const panelW = 142;
      const panelX = ix - 10 - panelW;  // 10px gap left of icon
      const panelY = iy;

      // Derived stats
      const windDeg  = ((windAngle * 180 / Math.PI) % 360 + 360) % 360;
      const CARDS    = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
      const cardinal = CARDS[Math.round(windDeg / 22.5) % 16];
      const windStr  = 0.3 + 0.7 * Math.abs(Math.cos(windAngle));

      let sumOpen = 0, sumAlign = 0;
      const mc = mastModules.length;
      for (const mast of mastModules) {
        const md = mast.moduleData as { openness?: number; angle?: number } | undefined;
        sumOpen += md?.openness ?? 100;
        const sw = (md?.angle ?? 0) + shipRotation + Math.PI / 2;
        let d = sw - windAngle;
        while (d >  Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const ad = Math.abs(d);
        const FULL = 15 * Math.PI / 180;
        const NO   = 90 * Math.PI / 180;
        sumAlign += ad <= FULL ? 1 : ad >= NO ? 0.15
                                  : 1 - 0.85 * (ad - FULL) / (NO - FULL);
      }
      const avgOpen  = mc > 0 ? sumOpen  / mc : 0;
      const avgAlign = mc > 0 ? sumAlign / mc : 1;
      const force    = windStr * avgOpen / 100 * avgAlign;

      const LH = 14;
      const panelH = 8 + 14 + 5 + LH * 6 + 8;  // pad + header + div + 6 rows + pad

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(panelX, panelY, panelW, panelH);
      ctx.strokeStyle = 'rgba(255,255,255,0.20)';
      ctx.lineWidth = 1;
      ctx.strokeRect(panelX, panelY, panelW, panelH);

      const LX = panelX + 7;
      const VX = panelX + panelW - 7;
      let ly   = panelY + 6;

      ctx.textBaseline = 'top';
      ctx.font = 'bold 10px Georgia, serif';
      ctx.fillStyle = '#ffcc44';
      ctx.textAlign = 'left';
      ctx.fillText('Wind / Force', LX, ly);
      ly += 15;

      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.moveTo(LX, ly); ctx.lineTo(VX, ly); ctx.stroke();
      ly += 5;

      ctx.font = '10px Georgia, serif';
      const row = (label: string, value: string, vc: string) => {
        ctx.fillStyle = '#777777';
        ctx.textAlign = 'left';
        ctx.fillText(label, LX, ly);
        ctx.fillStyle = vc;
        ctx.textAlign = 'right';
        ctx.fillText(value, VX, ly);
        ly += LH;
      };

      row('Wind dir', `${windDeg.toFixed(0)}° ${cardinal}`, '#88ddff');
      row('Wind str', windStr.toFixed(2), '#ffee88');
      row('Sail open', `${avgOpen.toFixed(0)}%`, '#cccccc');
      const alignHue = Math.round(avgAlign * 120);  // 0=red, 120=green
      row('Align', avgAlign.toFixed(2), `hsl(${alignHue},100%,65%)`);
      const forceHue = Math.round(Math.min(1, force / 0.6) * 120);
      row('Force', force.toFixed(3), `hsl(${forceHue},100%,65%)`);
      row('Speed', `${shipSpeed.toFixed(0)} px/s`, '#aaaaaa');

      ctx.restore();
    }

    // ── Bar hover tooltips ─────────────────────────────────────────────────
    {
      const _mx = this.mouseX, _my = this.mouseY;

      // Water ingress vertical bar
      if (_mx >= lBarX && _mx <= lBarX + vBarW && _my >= labelY && _my <= labelY + vBarH) {
        if (this._ttHit('ship-water')) {
          const waterPct = Math.round(waterFill * 100);
          const wDesc = isCritical
            ? 'Critical flooding \u2014 the ship is in danger of sinking.'
            : waterFill > 0.3 ? 'Significant water ingress. Repair planks to reduce flooding.'
            : 'Hull is intact. No significant flooding.';
          this._drawStatTooltip(ctx, canvas, lBarX + vBarW / 2, labelY,
            'Water Ingress',
            isCritical ? '#cc2222' : '#2266bb',
            isCritical ? '#ff4444' : '#66aacc',
            `${waterPct}%`,
            wDesc,
            [{ label: 'Hull Health', val: `${Math.round(hullHealth)}%`, col: hullHealth > 60 ? '#44cc66' : hullHealth > 30 ? '#ffaa22' : '#ff4444' }],
          );
        }
      }

      // Ship weight vertical bar
      if (_mx >= rBarX && _mx <= rBarX + vBarW && _my >= labelY && _my <= labelY + vBarH) {
        if (this._ttHit('ship-weight')) {
          const swDesc = weightCrit
            ? 'Overloaded \u2014 ship performance is heavily impaired.'
            : weightWarn ? 'Heavy load. Ship maneuverability is reduced.'
            : 'Ship weight is within safe limits.';
          this._drawStatTooltip(ctx, canvas, rBarX + vBarW / 2, labelY,
            'Ship Weight',
            weightCrit ? '#cc2222' : weightWarn ? '#cc8811' : '#664422',
            weightCrit ? '#ff4444' : weightWarn ? '#ffaa22' : '#aa7744',
            `${shipWeightKg} / ${shipWeightCap} kg`,
            swDesc, [],
          );
        }
      }

      // Deck integrity bar(s) tooltip — hit-test the full stacked bar region
      const deckBarsEndY = barY + deckBars.length * (barH + 16);
      if (_mx >= ix && _mx <= ix + barW && _my >= barY && _my <= deckBarsEndY) {
        const hoveredBar = deckBars.find((_, i) => {
          const by = barY + i * (barH + 16);
          return _my >= by && _my <= by + barH + 16;
        }) ?? deckBars[0];
        if (hoveredBar && this._ttHit('ship-deck')) {
          const isCrit  = hoveredBar.ratio < 0.30;
          const isWarn  = hoveredBar.ratio < 0.60;
          const dkDesc  = isCrit
            ? 'Deck is critically damaged. Board repairs recommended immediately.'
            : isWarn ? 'Deck integrity is low. Repair planks to restore structural strength.'
            : 'Deck is in good condition.';
          const col     = isCrit ? '#dd3333' : isWarn ? '#dd9922' : '#33aa55';
          const outline = isCrit ? '#ff4444' : isWarn ? '#ffaa22' : '#66cc88';
          this._drawStatTooltip(ctx, canvas, ix + barW / 2, barY,
            `${hoveredBar.label} Deck Integrity`,
            col,
            outline,
            `${Math.round(hoveredBar.ratio * 100)}%`,
            dkDesc, [],
          );
        }
      }
    }

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
      `Ships: ${context.worldState.ships.length} (👻 ${context.worldState.ships.filter(s => s.shipType === SHIP_TYPE_GHOST).length} ghost)`,
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