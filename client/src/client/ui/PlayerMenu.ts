/**
 * PlayerMenu.ts
 *
 * Canvas-drawn modal showing the local player's character sheet.
 * Toggled by pressing [E] when not interacting with a module.
 *
 * Sections:
 *  • Identity   — name, ID, company, position
 *  • Status     — mount state, movement
 *  • Inventory  — hotbar slots + equipment
 */

import {
  WorldState,
  COMPANY_NEUTRAL,
  COMPANY_PIRATES,
  COMPANY_NAVY,
} from '../../sim/Types.js';
import { ITEM_DEFS, ItemKind, INVENTORY_SLOTS } from '../../sim/Inventory.js';

// ── Shared palette (mirrors CompanyMenu) ─────────────────────────────────────

const COMPANY_NAMES: Record<number, string> = {
  [COMPANY_NEUTRAL]: 'Neutral',
  [COMPANY_PIRATES]: 'Pirates',
  [COMPANY_NAVY]:    'Navy',
};

const COMPANY_COLORS: Record<number, string> = {
  [COMPANY_NEUTRAL]: '#aaaaaa',
  [COMPANY_PIRATES]: '#ff6644',
  [COMPANY_NAVY]:    '#4488ff',
};

// ─────────────────────────────────────────────────────────────────────────────

const PANEL_W  = 480;
const PANEL_H  = 490;
const PAD      = 18;
const HEADER_H = 40;
const ROW_H    = 22;

const BG_DARK   = 'rgba(10, 12, 20, 0.96)';
const BG_PANEL  = 'rgba(20, 24, 36, 0.98)';
const BG_STRIPE = 'rgba(255, 255, 255, 0.04)';
const BORDER    = '#334';
const TEXT_HEAD = '#e8e0cc';
const TEXT_DIM  = '#778';
const TEXT_MONO = '#c0b890';
const GOLD      = '#ffd700';
const GREEN     = '#66dd88';
const ORANGE    = '#ffaa44';

const SLOT_SZ  = 40;
const SLOT_GAP = 5;

export class PlayerMenu {
  public visible = false;

  toggle(): void { this.visible = !this.visible; }
  open():   void { this.visible = true;  }
  close():  void { this.visible = false; }

  render(
    ctx:             CanvasRenderingContext2D,
    worldState:      WorldState,
    assignedId:      number | null | undefined,
  ): void {
    if (!this.visible) return;

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, ch);

    const px = Math.round((cw - PANEL_W) / 2);
    const py = Math.round((ch - PANEL_H) / 2);

    ctx.fillStyle   = BG_PANEL;
    ctx.fillRect(px, py, PANEL_W, PANEL_H);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(px, py, PANEL_W, PANEL_H);

    const player = assignedId != null
      ? worldState.players.find(p => p.id === assignedId)
      : worldState.players[0] ?? null;

    let cur = py;
    cur = this._header(ctx, px, cur);

    if (!player) {
      ctx.font = '14px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('  No player data.', px + PAD, cur + 8);
      ctx.restore();
      return;
    }

    const ship = player.carrierId
      ? worldState.ships.find(s => s.id === player.carrierId) ?? null
      : null;

    cur = this._identity(ctx, px, cur, player, ship);
    cur = this._status(ctx, px, cur, player, ship, worldState);
    cur = this._inventorySection(ctx, px, cur, player);

    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────────────────

  private _header(ctx: CanvasRenderingContext2D, px: number, py: number): number {
    ctx.fillStyle = 'rgba(255,215,0,0.06)';
    ctx.fillRect(px, py, PANEL_W, HEADER_H);

    ctx.font = 'bold 17px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText('⚔  CHARACTER', px + PAD, py + HEADER_H / 2);

    ctx.font = '12px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('[I / ESC] close', px + PANEL_W - PAD, py + HEADER_H / 2);

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + HEADER_H);
    ctx.lineTo(px + PANEL_W, py + HEADER_H);
    ctx.stroke();

    return py + HEADER_H;
  }

  private _identity(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
    ship:   ReturnType<WorldState['ships']['find']> | null,
  ): number {
    const sectionH = 58;
    py += 4;

    ctx.fillStyle = BG_DARK;
    ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, sectionH);

    const co = player.companyId ?? COMPANY_NEUTRAL;
    const swatch = px + PAD + 8;
    ctx.fillStyle = COMPANY_COLORS[co] ?? '#aaa';
    ctx.fillRect(swatch, py + 8, 14, 14);

    ctx.font = 'bold 15px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_HEAD;
    const nameStr = player.name ?? `Player ${player.id}`;
    ctx.fillText(nameStr, swatch + 22, py + 7);

    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(
      `ID #${player.id}   ${(COMPANY_NAMES[co] ?? 'Unknown').toUpperCase()}   ${ship ? `Ship #${ship.id}` : 'At sea'}`,
      swatch + 22, py + 26
    );

    // World position
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_MONO;
    ctx.fillText(
      `(${player.position.x.toFixed(0)}, ${player.position.y.toFixed(0)})`,
      px + PANEL_W - PAD - 8, py + sectionH / 2
    );

    return py + sectionH + 8;
  }

  private _status(
    ctx:        CanvasRenderingContext2D,
    px:         number, py: number,
    player:     NonNullable<ReturnType<WorldState['players']['find']>>,
    ship:       ReturnType<WorldState['ships']['find']> | null,
    worldState: WorldState,
  ): number {
    py = this._sectionHeader(ctx, px, py, 'STATUS', '');

    const rows: Array<[string, string, string?]> = [];

    // Aboard / at sea
    rows.push(['Location', ship ? `Aboard Ship #${ship.id}` : 'At sea']);

    // Mount state
    if (player.isMounted && player.mountedModuleId != null) {
      const mod = ship?.modules.find(m => m.id === player.mountedModuleId);
      const modKind = mod ? mod.kind.replace('-', ' ') : `Module #${player.mountedModuleId}`;
      rows.push(['Mounted', `${modKind} (ID ${player.mountedModuleId})`, ORANGE]);
    } else {
      rows.push(['Mounted', 'None', TEXT_DIM]);
    }

    rows.push(['On Deck', player.onDeck ? 'Yes' : 'No']);

    const spd = Math.sqrt(player.velocity.x ** 2 + player.velocity.y ** 2);
    rows.push(['Speed', spd.toFixed(2) + ' u/s']);

    // Facing
    const deg = ((player.rotation * 180 / Math.PI) % 360 + 360) % 360;
    rows.push(['Facing', deg.toFixed(1) + '°']);

    for (let i = 0; i < rows.length; i++) {
      const [label, value, col3Color] = rows[i];
      if (i % 2 === 1) {
        ctx.fillStyle = BG_STRIPE;
        ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, ROW_H);
      }
      ctx.font = '13px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(label, px + PAD + 8, py + ROW_H / 2);
      ctx.fillStyle = col3Color ?? TEXT_HEAD;
      ctx.fillText(value, px + PAD + 150, py + ROW_H / 2);
      py += ROW_H;
    }

    return py + 8;
  }

  private _inventorySection(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
  ): number {
    const inv = player.inventory;
    py = this._sectionHeader(ctx, px, py, 'INVENTORY', inv.activeSlot === 255 ? 'nothing equipped' : `slot ${inv.activeSlot + 1} active`);

    py += 4;

    // Hotbar row
    const totalW = INVENTORY_SLOTS * (SLOT_SZ + SLOT_GAP) - SLOT_GAP;
    const startX = px + Math.round((PANEL_W - totalW) / 2);

    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const slot = inv.slots[i];
      const def  = ITEM_DEFS[slot.item] ?? ITEM_DEFS['none'];
      const sx   = startX + i * (SLOT_SZ + SLOT_GAP);
      const isActive = i === inv.activeSlot;

      // Slot bg
      ctx.fillStyle = isActive ? 'rgba(255,215,0,0.15)' : 'rgba(30,30,40,0.85)';
      ctx.fillRect(sx, py, SLOT_SZ, SLOT_SZ);

      // Border
      ctx.strokeStyle = isActive ? GOLD : '#445';
      ctx.lineWidth   = isActive ? 2 : 1;
      ctx.strokeRect(sx, py, SLOT_SZ, SLOT_SZ);

      // Item fill
      if (slot.item !== 'none') {
        const swPad = 6;
        ctx.fillStyle = def.color;
        ctx.fillRect(sx + swPad, py + swPad, SLOT_SZ - swPad * 2, SLOT_SZ - swPad * 2);

        ctx.font = 'bold 16px Consolas, monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.symbol, sx + SLOT_SZ / 2, py + SLOT_SZ / 2);

        if (slot.quantity > 1) {
          ctx.font = '10px Consolas, monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = '#fff';
          ctx.fillText(String(slot.quantity), sx + SLOT_SZ - 3, py + SLOT_SZ - 2);
        }
      }

      // Number label
      ctx.font = '10px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(String(i === 9 ? 0 : i + 1), sx + SLOT_SZ / 2, py + SLOT_SZ + 3);
    }

    py += SLOT_SZ + 18;

    // Equipment row (armor + shield side by side, labeled)
    const equipItems: Array<{ label: string; item: ItemKind }> = [
      { label: 'Armor',  item: inv.equipment.armor  },
      { label: 'Shield', item: inv.equipment.shield },
    ];

    const eqX = px + PAD + 8;
    ctx.font = 'bold 12px Consolas, monospace';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('EQUIPMENT', eqX, py);
    py += 16;

    for (const { label, item } of equipItems) {
      const def = ITEM_DEFS[item] ?? ITEM_DEFS['none'];
      const sx = eqX;

      ctx.fillStyle = item !== 'none' ? 'rgba(50,40,20,0.9)' : 'rgba(30,30,40,0.9)';
      ctx.fillRect(sx, py, SLOT_SZ, SLOT_SZ);
      ctx.strokeStyle = def.borderColor;
      ctx.lineWidth   = 1;
      ctx.strokeRect(sx, py, SLOT_SZ, SLOT_SZ);

      if (item !== 'none') {
        const swPad = 5;
        ctx.fillStyle = def.color;
        ctx.fillRect(sx + swPad, py + swPad, SLOT_SZ - swPad * 2, SLOT_SZ - swPad * 2);
        ctx.font = 'bold 16px Consolas, monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.symbol, sx + SLOT_SZ / 2, py + SLOT_SZ / 2);
      }

      ctx.font = '12px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_HEAD;
      ctx.fillText(
        item !== 'none' ? def.name : `${label}: Empty`,
        sx + SLOT_SZ + 10, py + SLOT_SZ / 2
      );

      py += SLOT_SZ + 6;
    }

    return py;
  }

  // ────────────────────────────────────────────────────────────────────────────

  private _sectionHeader(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    label: string, right: string,
  ): number {
    const h = 22;
    ctx.fillStyle = 'rgba(255,215,0,0.08)';
    ctx.fillRect(px, py, PANEL_W, h);

    ctx.font = 'bold 12px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText(label, px + PAD, py + h / 2);

    if (right) {
      ctx.textAlign = 'right';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(right, px + PANEL_W - PAD, py + h / 2);
    }

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + h);
    ctx.lineTo(px + PANEL_W, py + h);
    ctx.stroke();

    return py + h + 2;
  }
}
