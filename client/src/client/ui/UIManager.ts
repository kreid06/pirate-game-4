/**
 * UI Manager - User Interface System
 * 
 * Handles all user interface elements including HUD, menus, and debug overlays.
 * Separated from rendering for clean architecture.
 */

import { ClientConfig } from '../ClientConfig.js';
import { WorldState } from '../../sim/Types.js';
import { Camera } from '../gfx/Camera.js';
import { NetworkStats } from '../../net/NetworkManager.js';
import { ITEM_DEFS, INVENTORY_SLOTS, ItemKind } from '../../sim/Inventory.js';
import { ManningPriorityPanel } from './ManningPriorityPanel.js';
import { CompanyMenu } from './CompanyMenu.js';
import { PlayerMenu } from './PlayerMenu.js';
import { ShipMenu } from './ShipMenu.js';

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

  // UI State
  private showDebugOverlay = false;
  private showNetworkStats = false;
  private showControlHints = true;

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
  
  constructor(_canvas: HTMLCanvasElement, config: ClientConfig) {
    this.config = config;
    
    this.initializeUIElements();
    this.setupEventListeners();
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
  render(ctx: CanvasRenderingContext2D, context: UIRenderContext): void {
    // Render elements in order
    const renderOrder: UIElementType[] = [
      UIElementType.HUD,
      UIElementType.CONTROL_HINTS,
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

    // Company menu renders last so it sits above all other UI
    this.companyMenu.render(ctx, context.worldState, context.assignedPlayerId);
    this.playerMenu.render(ctx, context.worldState, context.assignedPlayerId);
    this.shipMenu.render(ctx, context.worldState, context.assignedPlayerId);

    // Explicit build mode overlay (renders on top of everything, including menus)
    if (this.buildModeState?.active) {
      this.renderBuildModeOverlay(ctx, ctx.canvas);
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
   * Handle a canvas click — returns true if the UI consumed it.
   */
  handleClick(x: number, y: number): boolean {
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

  // -----------------------------------------------------------------------
  // Build mode helpers
  // -----------------------------------------------------------------------

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

  private initializeUIElements(): void {
    // Initialize HUD
    this.elements.set(UIElementType.HUD, new HUDElement());
    
    // Initialize Debug Overlay
    this.elements.set(UIElementType.DEBUG_OVERLAY, new DebugOverlayElement());
    
    // Initialize Network Stats
    this.elements.set(UIElementType.NETWORK_STATS, new NetworkStatsElement());
    
    // Initialize Control Hints
    this.elements.set(UIElementType.CONTROL_HINTS, new ControlHintsElement());
    
    // Set initial visibility
    this.updateElementVisibility();
  }
  
  private updateElementVisibility(): void {
    this.elements.get(UIElementType.HUD)!.visible = true;
    this.elements.get(UIElementType.DEBUG_OVERLAY)!.visible = this.showDebugOverlay;
    this.elements.get(UIElementType.NETWORK_STATS)!.visible = this.showNetworkStats;
    this.elements.get(UIElementType.CONTROL_HINTS)!.visible = this.showControlHints;
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
        this.showControlHints = !this.showControlHints;
        this.updateElementVisibility();
        break;
    }
  }
}

/**
 * HUD Element - Main game HUD
 */
class HUDElement implements UIElement {
  type = UIElementType.HUD;
  visible = true;
  
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
      this.renderWaterMeter(ctx, ctx.canvas, playerShip.hullHealth ?? 100);
    }

    // Hotbar
    this.renderHotbar(ctx, ctx.canvas, player.inventory.slots, player.inventory.activeSlot);

    // Equipment panel (armor + shield)
    this.renderEquipmentPanel(ctx, ctx.canvas, player.inventory.equipment.armor, player.inventory.equipment.shield);
  }

  private renderHotbar(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    slots: { item: ItemKind; quantity: number }[],
    activeSlot: number
  ): void {
    const SLOT_SIZE = 48;
    const SLOT_GAP = 4;
    const PADDING = 6;
    const LABEL_H = 16;
    const totalW = INVENTORY_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP + PADDING * 2;
    const totalH = SLOT_SIZE + PADDING * 2 + LABEL_H;
    const startX = Math.round((canvas.width - totalW) / 2);
    const startY = canvas.height - totalH - 8;

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
      const isActive = i === activeSlot;

      // Slot background
      ctx.fillStyle = isActive ? 'rgba(255,220,60,0.18)' : 'rgba(30,30,40,0.9)';
      ctx.fillRect(sx, sy, SLOT_SIZE, SLOT_SIZE);

      // Slot border (bright gold when active)
      ctx.strokeStyle = isActive ? '#ffd700' : def.borderColor;
      ctx.lineWidth = isActive ? 2.5 : 1;
      ctx.strokeRect(sx, sy, SLOT_SIZE, SLOT_SIZE);

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

      // Slot number label below slot
      ctx.fillStyle = isActive ? '#ffd700' : '#778';
      ctx.font = '11px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(i === 9 ? 0 : i + 1), sx + SLOT_SIZE / 2, sy + SLOT_SIZE + 2);
    }

    ctx.restore();
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
    hullHealth: number
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