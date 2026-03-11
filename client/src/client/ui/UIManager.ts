/**
 * UI Manager - User Interface System
 * 
 * Handles all user interface elements including HUD, menus, and debug overlays.
 * Separated from rendering for clean architecture.
 */

import { ClientConfig } from '../ClientConfig.js';
import { WorldState, Npc, Ship, WeaponGroupMode, WeaponGroupState } from '../../sim/Types.js';
import { GhostPlacement, GhostModuleKind } from '../../sim/Types.js';
import { Camera } from '../gfx/Camera.js';
import { NetworkStats } from '../../net/NetworkManager.js';
import { ITEM_DEFS, INVENTORY_SLOTS, ItemKind, ITEM_KIND_ID } from '../../sim/Inventory.js';
import { ManningPriorityPanel } from './ManningPriorityPanel.js';
import { CompanyMenu } from './CompanyMenu.js';
import { PlayerMenu } from './PlayerMenu.js';
import { ShipMenu } from './ShipMenu.js';
import { CrewLevelMenu } from './CrewLevelMenu.js';

/**
 * UI render context
 */
export interface UIRenderContext {
  worldState: WorldState;
  camera: Camera;
  fps: number;
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

  // Company menu (toggled by [L])
  private companyMenu = new CompanyMenu();
  // Player character menu (toggled by [E] when menu is open)
  private playerMenu = new PlayerMenu();
  // Ship status menu (toggled by [F])
  private shipMenu = new ShipMenu();
  // Crew level / upgrade panel (opened by clicking an NPC)
  private crewMenu = new CrewLevelMenu();

  // UI State
  private showDebugOverlay = false;
  private showNetworkStats = false;
  private showControlHints = true;

  // Mouse screen position (updated each frame before render)
  private mouseX = 0;
  private mouseY = 0;

  // Explicit build mode (B key) overlay state
  private buildModeState: {
    active: boolean;
    selectedItem: 'cannon' | 'sail';
    rotationDeg: number;
    sailCount: number;
    maxSails: number;
  } | null = null;

  /** Called when the player clicks a build item button (cannon/sail). */
  public onBuildItemSelect: ((item: 'cannon' | 'sail') => void) | null = null;
  /** Called when a weapon group has its mode cycled via right-click. */
  public onGroupModeChange: ((groupIndex: number, mode: WeaponGroupMode) => void) | null = null;
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
    { kind: 'cannon', label: 'Cannon', symbol: '⚫', color: '#444',    borderColor: '#888'    },
    { kind: 'mast',   label: 'Sail',   symbol: '⛵', color: '#1e8c6e', borderColor: '#0f5c48' },
    { kind: 'helm',   label: 'Helm',   symbol: 'W',  color: '#6a3d8f', borderColor: '#3d2060' },
    { kind: 'deck',   label: 'Deck',   symbol: '⊟', color: '#8b5e3c', borderColor: '#5c3a1c' },
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

  /**
   * Route a keydown event.  Returns true if the minigame consumed the key.
   * Call this from the application keydown handler before processing game input.
   */
  handleKeyDown(key: string): boolean {
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
    const totalW = INVENTORY_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((this.canvas.width - totalW) / 2);
    const startY = this.canvas.height - totalH - 8;
    if (y < startY || y > startY + PADDING + SLOT_SIZE) return false;
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
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
    this.manningPanel.render(ctx, context.worldState.npcs ?? [], shipId);
    
    // Always render FPS in top-right corner
    this.renderFPS(ctx, context);

    // Ammo selector widget — show when mounted to a cannon or the helm
    if (context.mountKind === 'cannon' || context.mountKind === 'helm') {
      this.renderAmmoSelector(ctx, context.selectedAmmoType ?? 0, context.pendingAmmoType ?? context.selectedAmmoType ?? 0);
    }

    // Company menu renders last so it sits above all other UI
    this.companyMenu.render(ctx, context.worldState, context.assignedPlayerId);
    this.playerMenu.render(ctx, context.worldState, context.assignedPlayerId);
    this.shipMenu.render(ctx, context.worldState, context.assignedPlayerId);
    // Crew level menu — update live NPC data before rendering
    if (this.crewMenu.visible && this.crewMenu.npcId) {
      const liveNpc = context.worldState.npcs.find(n => n.id === this.crewMenu.npcId);
      if (liveNpc) this.crewMenu.update(liveNpc);
    }
    this.crewMenu.render(ctx, ctx.canvas);

    // Explicit build mode overlay (renders on top of everything, including menus)
    if (this.buildModeState?.active) {
      this.renderBuildModeOverlay(ctx, ctx.canvas);
    }

    // Ghost build menu panel — left side of screen
    if (this.buildMenuOpen) {
      this.renderBuildMenuPanel(ctx, ctx.canvas);
    }

    // Hammer minigame — topmost overlay, blocks all game input when active
    if (this.hammerGame.active) {
      this.renderHammerMinigame(ctx, ctx.canvas);
    }
  }
  
  /**
   * Render FPS counter in top-right corner
   */
  private renderFPS(ctx: CanvasRenderingContext2D, context: UIRenderContext): void {
    ctx.save();
    
    const fps = Math.round(context.fps);
    const text = `${fps} FPS`;
    
    // Measure text width for background
    ctx.font = 'bold 20px Consolas, monospace';
    const textMetrics = ctx.measureText(text);
    const textWidth = textMetrics.width;
    const textHeight = 24;
    
    // Position in top-right corner
    const padding = 10;
    const x = ctx.canvas.width - textWidth - padding * 2;
    const y = padding;
    
    // Draw semi-transparent background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(x, y, textWidth + padding * 2, textHeight + padding);
    
    // Draw border
    ctx.strokeStyle = fps >= 60 ? '#00ff00' : fps >= 30 ? '#ffaa00' : '#ff0000';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, textWidth + padding * 2, textHeight + padding);
    
    // Draw FPS text
    ctx.fillStyle = fps >= 60 ? '#00ff00' : fps >= 30 ? '#ffaa00' : '#ff0000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x + padding, y + padding);
    
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
      ctx.font         = '18px Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = iconColor;
      ctx.fillText(ammo.icon, sx + pad + 2, y0 + slotH / 2 - 4);

      // Name
      const highlighted = isLoaded || isPending;
      ctx.font      = highlighted ? 'bold 11px Consolas, monospace' : '11px Consolas, monospace';
      ctx.fillStyle = textColor;
      ctx.fillText(ammo.name, sx + pad + 2, y0 + slotH / 2 + 10);

      // Small label: LOADED / NEXT
      if (isLoaded && switchPending) {
        ctx.font      = '9px Consolas, monospace';
        ctx.fillStyle = '#44dd66';
        ctx.textAlign = 'right';
        ctx.fillText('LOADED', sx + slotW - 5, y0 + slotH - 6);
        ctx.textAlign = 'left';
      } else if (isPending && switchPending) {
        ctx.font      = '9px Consolas, monospace';
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
    ctx.font         = '10px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = 'rgba(120,120,140,0.7)';
    const hint = switchPending ? '[X] cycle  |  hold X (0.5s) → force reload' : '[X] cycle ammo  |  hold X (0.5s) → force swap';
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
    };
  }

  /**
   * Open the crew level menu for a specific NPC (e.g. from a world click).
   */
  openCrewMenuForNpc(npc: Npc): void {
    this.crewMenu.open(npc);
  }

  /**
   * Update explicit build mode state (called by ClientApplication each frame / on change).
   * Pass null to hide the build mode overlay.
   */
  setBuildModeState(state: {
    active: boolean;
    selectedItem: 'cannon' | 'sail';
    rotationDeg: number;
    sailCount: number;
    maxSails: number;
  } | null): void {
    this.buildModeState = state;
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
    // Hammer minigame swallows all clicks while active
    if (this.hammerGame.active) {
      if (this.hammerGame.resultTime === -1) this.strikeHammer();
      return true;
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
    // If company menu is open, clicks anywhere close it (the menu itself has no buttons yet).
    // Log-term: route internal clicks to menu sub-elements here.
    if (this.companyMenu.visible) {
      this.companyMenu.close();
      return true;
    }
    if (this.playerMenu.visible) {
      this.playerMenu.close();
      return true;
    }
    if (this.crewMenu.visible) {
      const consumed = this.crewMenu.handleClick(x, y);
      if (!consumed) this.crewMenu.close();
      return true;
    }
    if (this.shipMenu.visible) {
      // Forward to shipMenu — returns true if inside panel (upgrade click or panel area)
      const consumed = this.shipMenu.handleClick(x, y);
      if (!consumed) this.shipMenu.close();
      return true;
    }
    return this.manningPanel.handleClick(x, y);
  }

  /** Returns the current npcId → task name map for colouring NPCs in the render system. */
  getNpcTaskMap(): ReadonlyMap<number, string> {
    return this.manningPanel.getTaskMap();
  }

  /**
   * Called when the local player boards a new ship.
   * Seeds the crew panel from the ship's authoritative NPC states and resets delta tracking.
   */
  syncCrewFromBoarding(npcs: Npc[], shipId: number): void {
    this.manningPanel.syncFromBoarding(npcs, shipId);
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
      : `⛵ SAIL (${sailCount}/${maxSails})`;
    ctx.font = 'bold 22px Consolas, monospace';
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
        ctx.font = '9px Consolas, monospace';
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
    ctx.font = 'bold 15px Consolas, monospace';
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
      ctx.font = 'bold 18px Consolas, monospace';
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
    ctx.font = 'bold 12px Consolas, monospace';
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
      ctx.font = `${swatchR * 1.1}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.symbol, swatchX, swatchY + 1);

      // Entry label
      ctx.fillStyle = isPending ? '#88ee99' : isHovered ? '#d0e8ff' : '#c8d8e8';
      ctx.font = isPending ? 'bold 13px Consolas, monospace' : '13px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.label, swatchX + swatchR + 8, swatchY);

      // Ghost count badge
      const count = ghostCounts.get(e.kind) ?? 0;
      if (count > 0) {
        const badge = `×${count}`;
        ctx.fillStyle = 'rgba(255,200,50,0.85)';
        ctx.font = 'bold 11px Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(badge, px + W - 10, swatchY);
      }

      // Pending indicator arrow on the right edge
      if (isPending) {
        ctx.fillStyle = '#55ee88';
        ctx.font = '13px sans-serif';
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
    ctx.font = '10px Consolas, monospace';
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
    // Close any open modal on Escape first
    if (event.code === 'Escape') {
      if (this.companyMenu.visible) { this.companyMenu.close(); event.preventDefault(); event.stopPropagation(); return; }
      if (this.playerMenu.visible)  { this.playerMenu.close();  event.preventDefault(); event.stopPropagation(); return; }
      if (this.shipMenu.visible)    { this.shipMenu.close();    event.preventDefault(); event.stopPropagation(); return; }
      return;
    }

    switch (event.code) {
      case 'KeyL':
        // [L] toggles (opens or closes) the company ledger menu
        this.companyMenu.toggle();
        // Close sibling menus so only one is open at a time
        if (this.companyMenu.visible) { this.playerMenu.close(); this.shipMenu.close(); }
        if (this.companyMenu.visible) { event.preventDefault(); event.stopPropagation(); }
        break;

      case 'KeyI':
        // [I] opens the player character sheet.
        // Only intercept if the menu is already open (so normal I key still fires when closed).
        if (this.playerMenu.visible) {
          this.playerMenu.close();
          event.preventDefault();
          event.stopPropagation();
        } else {
          this.playerMenu.open();
          this.companyMenu.close();
          this.shipMenu.close();
          event.preventDefault();
          event.stopPropagation();
        }
        break;

      case 'KeyF':
        this.shipMenu.toggle();
        if (this.shipMenu.visible) { this.companyMenu.close(); this.playerMenu.close(); }
        if (this.shipMenu.visible) { event.preventDefault(); event.stopPropagation(); }
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
    ctx.font          = 'bold 21px Consolas, monospace';
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
      ctx.font      = 'bold 28px Consolas, monospace';
      ctx.fillStyle = this.hammerGame.won ? '#33ff88' : '#ff5555';
      ctx.fillText(this.hammerGame.won ? 'CRACK! \u2192 +10 000 HP' : 'MISSED!', cw / 2, py + 128);
    } else {
      ctx.font      = '14px Consolas, monospace';
      ctx.fillStyle = '#aaaacc';
      ctx.fillText('Press [SPACE] or click when the cursor enters the green zone', cw / 2, py + 128);
      // Countdown ticks along the bottom of the track as tiny tick marks
      const pct = elapsed / this.hammerGame.duration;
      ctx.fillStyle = pct > 0.75 ? '#ff8800' : '#555577';
      ctx.fillRect(trackX, trackY + trackH + 3, trackW * (1 - pct), 3);
    }

    ctx.restore();
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
    
    // Set up text rendering with better visibility
    ctx.save();
    
    // Background for better readability
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(10, 10, 320, 120);
    
    // Border for the info box
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, 320, 120);
    
    // Set up text rendering
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Consolas, monospace';
    ctx.textAlign = 'left';
    
    // Player coordinates (prominent display)
    ctx.fillStyle = '#00ff00'; // Green for coordinates
    ctx.font = 'bold 18px Consolas, monospace';
    ctx.fillText(`POSITION: ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}`, 20, 35);
    
    // Other info in white
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px Consolas, monospace';
    const lines = [
      `FPS: ${context.fps}`,
      `On Ship: ${player.onDeck ? 'Yes' : 'No'}`,
      `Carrier ID: ${player.carrierId}`,
      `Velocity: ${player.velocity.x.toFixed(1)}, ${player.velocity.y.toFixed(1)}`,
      `Network: ${context.networkStats.ping.toFixed(0)}ms`
    ];
    
    // Render additional info lines
    lines.forEach((line, index) => {
      ctx.fillText(line, 20, 55 + index * 16);
    });
    
    ctx.restore();

    // --- Water meter (top-right boat icon) ---
    // Show whenever the player is aboard any ship
    const playerShip = player.onDeck
      ? context.worldState.ships.find(s => s.id === player.carrierId)
      : null;

    if (playerShip != null) {
      // Compute aggregate plank health ratio from the ship's plank modules
      const planks = playerShip.modules.filter(m => m.kind === 'plank');
      let plankRatio = 1;
      if (planks.length > 0) {
        let totalHp = 0, totalMax = 0;
        for (const m of planks) {
          const d = m.moduleData as { health?: number; maxHealth?: number } | undefined;
          totalHp  += d?.health    ?? 0;
          totalMax += d?.maxHealth ?? 10000;
        }
        plankRatio = totalMax > 0 ? Math.max(0, Math.min(1, totalHp / totalMax)) : 1;
      }
      this.renderWaterMeter(ctx, ctx.canvas, playerShip.hullHealth ?? 100, plankRatio);
    }

    // Hotbar — in ship/helm mode reuses same grid to show weapon groups
    const helmMode = context.mountKind === 'helm'
      ? { activeGroup: context.activeWeaponGroup ?? -1, activeGroups: context.activeWeaponGroups ?? new Set<number>(), playerShip: context.playerShip ?? null, controlGroups: context.controlGroups }
      : undefined;
    this.renderHotbar(ctx, ctx.canvas, player.inventory.slots, player.inventory.activeSlot, helmMode);

    // Equipment panel (armor + shield)
    this.renderEquipmentPanel(ctx, ctx.canvas, player.inventory.equipment.armor, player.inventory.equipment.shield);
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
    const totalW = INVENTORY_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
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

    for (let i = 0; i < INVENTORY_SLOTS; i++) {
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
        ctx.font         = 'bold 11px Consolas, monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = isActive ? '#ffd700' : 'rgba(160,160,180,0.75)';
        ctx.fillText(`G${groupIdx}`, sx + SLOT_SIZE / 2, sy + 3);

        // Cannon count (large, centre)
        if (count > 0) {
          ctx.font         = 'bold 20px Consolas, monospace';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = isActive ? '#ffffff' : 'rgba(200,200,220,0.9)';
          ctx.fillText(String(count), sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2 - 3);
          ctx.font         = '8px Consolas, monospace';
          ctx.fillStyle    = isActive ? 'rgba(255,255,255,0.65)' : 'rgba(140,140,160,0.6)';
          ctx.fillText(count === 1 ? 'cannon' : 'cannons', sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2 + 10);
        } else {
          ctx.font         = '10px Consolas, monospace';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = 'rgba(70,70,80,0.5)';
          ctx.fillText('empty', sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);
        }

        // Mode badge strip along bottom
        const BADGE_H = 13;
        ctx.fillStyle = count > 0 ? modeCol : 'rgba(50,50,60,0.85)';
        ctx.fillRect(sx + 1, sy + SLOT_SIZE - BADGE_H - 1, SLOT_SIZE - 2, BADGE_H);
        ctx.font         = 'bold 8px Consolas, monospace';
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
          ctx.font = 'bold 18px Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(def.symbol, sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);

          // Stack count (bottom-right, only for stackables > 1)
          if (slot.quantity > 1) {
            ctx.fillStyle = '#ffee88';
            ctx.font = 'bold 11px Consolas, monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(String(slot.quantity), sx + SLOT_SIZE - 3, sy + SLOT_SIZE - 3);
          }
        }
      }

      // Slot number label below slot
      ctx.fillStyle = isActive ? '#ffd700' : '#778';
      ctx.font = '11px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(i === 9 ? 0 : i + 1), sx + SLOT_SIZE / 2, sy + SLOT_SIZE + 2);
    }

    // Tooltip: check which slot (if any) the mouse is hovering
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
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
    const descLines = this.wrapText(ctx, def.description, W - PAD * 2, '12px Consolas, monospace');
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
    ctx.font         = `bold 14px Consolas, monospace`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(def.name, tx + PAD + 4, cy);
    cy += nameH + 4;

    // ID  +  category
    ctx.fillStyle = '#888';
    ctx.font      = '11px Consolas, monospace';
    ctx.fillText(`ID: ${itemId}   [${def.category}]`, tx + PAD + 4, cy);
    cy += LINE + 4;

    // Description
    ctx.fillStyle = '#ccc';
    ctx.font      = '12px Consolas, monospace';
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
    ctx.font = 'bold 11px Consolas, monospace';
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
        ctx.font = 'bold 16px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.symbol, sx + SLOT_SIZE / 2, sy + SLOT_SIZE / 2);
      }

      // Label
      ctx.fillStyle = '#778';
      ctx.font = '10px Consolas, monospace';
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
    plankRatio: number = 1
  ): void {
    // waterFill: 0 = completely dry, 1 = ship fully flooded
    const waterFill = Math.max(0, Math.min(1, 1 - hullHealth / 100));
    const isCritical = waterFill > 0.9;

    ctx.save();

    // ── Dimensions & position (top-right corner) ─────────────────────────
    const iW   = 88;   // icon width
    const iH   = 66;   // icon height (hull cross-section)
    const marg = 14;   // margin from canvas edge
    const ix   = canvas.width - iW - marg;
    const iy   = marg;

    // ── Hull cross-section path ───────────────────────────────────────────
    // Wide at the deck, tapering slightly, with a curved bottom
    const deckY  = iy + 10;          // y of the deck rail
    const sideBot = iy + iH - 6;     // y where sides meet the curved keel
    const hullPath = new Path2D();
    hullPath.moveTo(ix + 2,      deckY);              // port (left) rail
    hullPath.lineTo(ix + iW - 2, deckY);              // starboard (right) rail
    hullPath.lineTo(ix + iW - 9, sideBot);            // starboard lower side
    // Curved keel bottom
    hullPath.quadraticCurveTo(
      ix + iW / 2, iy + iH + 4,                       // control: below center
      ix + 9,      sideBot                             // port lower side
    );
    hullPath.closePath();

    // ── Water fill (clipped to hull interior) ────────────────────────────
    ctx.save();
    ctx.clip(hullPath);

    // Fill water from the bottom of the keel up
    const interiorH = sideBot - deckY;
    const fillH     = waterFill * (interiorH + 12); // +12 to cover the curved keel
    const fillY     = sideBot - waterFill * interiorH;

    if (waterFill > 0) {
      // Main water body
      ctx.fillStyle = isCritical ? '#bb1111' : '#1155cc';
      ctx.fillRect(ix, fillY, iW, fillH + 8);

      // Animated-looking wave bands (lighter stripes)
      const waveColor = isCritical ? 'rgba(255,140,140,0.20)' : 'rgba(120,200,255,0.22)';
      const bandH = 4;
      for (let by = fillY + 4; by < sideBot; by += 12) {
        ctx.fillStyle = waveColor;
        ctx.fillRect(ix, by, iW, bandH);
      }

      // Surface shimmer line at water top
      ctx.fillStyle = isCritical ? 'rgba(255,160,160,0.50)' : 'rgba(170,230,255,0.55)';
      ctx.fillRect(ix, fillY, iW, 3);
    }

    ctx.restore(); // remove clip

    // ── Hull outline (white / red-tinted when critical) ───────────────────
    ctx.strokeStyle = isCritical ? '#ff5555' : '#ffffff';
    ctx.lineWidth   = isCritical ? 2.5 : 2;
    ctx.stroke(hullPath);

    // ── Deck rail (horizontal line at top of hull) ────────────────────────
    ctx.beginPath();
    ctx.moveTo(ix + 2,      deckY);
    ctx.lineTo(ix + iW - 2, deckY);
    ctx.strokeStyle = isCritical ? '#ff8888' : '#dddddd';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Small deck posts / bollards for a nautical feel
    for (const bx of [ix + 10, ix + iW / 2 - 1, ix + iW - 10]) {
      ctx.beginPath();
      ctx.moveTo(bx, deckY);
      ctx.lineTo(bx, deckY - 5);
      ctx.strokeStyle = isCritical ? '#ff8888' : '#bbbbbb';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // ── Percentage label + "WATER" tag below icon ─────────────────────────
    const pct       = Math.round(waterFill * 100);
    const labelY    = iy + iH + 7;
    const labelColor = isCritical ? '#ff5555' : '#88bbee';

    ctx.font          = 'bold 12px Consolas, monospace';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'top';
    ctx.fillStyle     = labelColor;
    ctx.fillText(`${pct}%`, ix + iW / 2, labelY);

    // Tiny "WATER" subtitle
    ctx.font      = '9px Consolas, monospace';
    ctx.fillStyle = isCritical ? '#ff7777' : '#557799';
    ctx.fillText('WATER', ix + iW / 2, labelY + 14);

    // ── Hull (plank) health bar ───────────────────────────────────────────
    const barY       = labelY + 28;
    const barW       = iW;
    const barH       = 8;
    const plankCrit  = plankRatio < 0.30;
    const plankWarn  = plankRatio < 0.60;
    const barColor   = plankCrit ? '#dd3333' : plankWarn ? '#dd9922' : '#33aa55';

    // Background track
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(ix, barY, barW, barH);

    // Filled portion
    ctx.fillStyle = barColor;
    ctx.fillRect(ix, barY, Math.round(barW * plankRatio), barH);

    // Border
    ctx.strokeStyle = plankCrit ? '#ff4444' : 'rgba(255,255,255,0.30)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(ix, barY, barW, barH);

    // Label: "HULL  XX%"
    const hullPct = Math.round(plankRatio * 100);
    ctx.font         = '9px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = plankCrit ? '#ff5555' : '#778866';
    ctx.fillText('HULL', ix, barY + barH + 3);
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
    ctx.font = '14px monospace';
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
    ctx.font = '14px monospace';
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
    ctx.font = '12px Arial';
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