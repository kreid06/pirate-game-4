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
  
  // UI State
  private showDebugOverlay = false;
  private showNetworkStats = false;
  private showControlHints = true;
  
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
    
    // Always render FPS in top-right corner
    this.renderFPS(ctx, context);
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
    switch (event.code) {
      case 'KeyL':
        this.toggleDebugOverlay();
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

    // --- Water meter ---
    // Find the ship this player is on (or any ship if spectating)
    const playerShip = player.onDeck
      ? context.worldState.ships.find(s => s.id === player.carrierId)
      : null;

    if (playerShip !== undefined && playerShip !== null) {
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
    // waterFill: 0 = dry hull, 1 = ship sinking (inverse of hull health)
    const waterFill = Math.max(0, Math.min(1, 1 - hullHealth / 100));

    // Only show meter when there is water ingress
    if (waterFill <= 0) return;

    ctx.save();

    const barW = 240;
    const barH = 22;
    const padding = 8;
    const labelW = 58; // space for "WATER" label
    const totalW = labelW + barW + padding * 3;
    const totalH = barH + padding * 2;
    const x = 10;
    const y = canvas.height - totalH - 10;

    // Background panel
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(x, y, totalW, totalH);

    // Border — red pulse when critical (>90%)
    const isCritical = waterFill > 0.9;
    ctx.strokeStyle = isCritical ? '#ff2222' : '#446688';
    ctx.lineWidth = isCritical ? 2 : 1;
    ctx.strokeRect(x, y, totalW, totalH);

    // "WATER" label
    ctx.fillStyle = isCritical ? '#ff4444' : '#aaccee';
    ctx.font = 'bold 12px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WATER', x + padding + labelW / 2, y + totalH / 2);

    // Bar track (dark bg)
    const barX = x + padding * 2 + labelW;
    const barY = y + padding;
    ctx.fillStyle = '#111111';
    ctx.fillRect(barX, barY, barW, barH);

    // Bar fill color: blue → purple at >90%
    const fillPx = Math.round(waterFill * barW);
    if (fillPx > 0) {
      const fillColor = isCritical ? '#8800cc' : '#1166dd';
      ctx.fillStyle = fillColor;
      ctx.fillRect(barX, barY, fillPx, barH);

      // Shimmer highlight on top third of bar
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(barX, barY, fillPx, Math.round(barH / 3));
    }

    // Bar border
    ctx.strokeStyle = '#224466';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);

    // Percentage text inside/beside the bar
    const pct = Math.round(waterFill * 100);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pct}%`, barX + fillPx + 4, y + totalH / 2);

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
      'L - Toggle this overlay',
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