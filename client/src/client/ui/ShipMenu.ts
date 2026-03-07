/**
 * ShipMenu.ts
 *
 * Canvas-drawn modal showing the current ship's status sheet.
 * Only meaningful when the player is aboard — otherwise shows a prompt.
 * Toggled by pressing [F].
 *
 * Sections:
 *  • Identity      — ship ID, company, speed, heading
 *  • Hull & Ammo   — hullHealth bar, cannonAmmo
 *  • Modules       — grouped count by kind with health summary
 *  • Crew          — NPCs aboard (count + role breakdown)
 */

import {
  WorldState,
  COMPANY_NEUTRAL,
  COMPANY_PIRATES,
  COMPANY_NAVY,
} from '../../sim/Types.js';
import { ShipModule, CannonModuleData, MastModuleData, PlankModuleData } from '../../sim/modules.js';

// ── Shared palette ────────────────────────────────────────────────────────────

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
const PANEL_H  = 510;
const PAD      = 18;
const HEADER_H = 40;
const ROW_H    = 22;
const BAR_H    = 14;

const BG_PANEL  = 'rgba(20, 24, 36, 0.98)';
const BG_DARK   = 'rgba(10, 12, 20, 0.96)';
const BG_STRIPE = 'rgba(255, 255, 255, 0.04)';
const BORDER    = '#334';
const TEXT_HEAD = '#e8e0cc';
const TEXT_DIM  = '#778';
const TEXT_MONO = '#c0b890';
const GOLD      = '#ffd700';
const GREEN     = '#44cc66';
const ORANGE    = '#ffaa44';
const RED       = '#ff5544';

export class ShipMenu {
  public visible = false;

  toggle(): void { this.visible = !this.visible; }
  open():   void { this.visible = true;  }
  close():  void { this.visible = false; }

  render(
    ctx:        CanvasRenderingContext2D,
    worldState: WorldState,
    assignedId: number | null | undefined,
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

    const ship = player?.carrierId
      ? worldState.ships.find(s => s.id === player.carrierId) ?? null
      : null;

    if (!ship) {
      ctx.font = '14px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('Not aboard a ship.', px + PANEL_W / 2, cur + 20);
      ctx.restore();
      return;
    }

    cur = this._identity(ctx, px, cur, ship);
    cur = this._hullAmmo(ctx, px, cur, ship);
    cur = this._modulesSection(ctx, px, cur, ship.modules);
    this._crewSection(ctx, px, cur, worldState, ship.id);

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
    ctx.fillText('⛵  SHIP STATUS', px + PAD, py + HEADER_H / 2);

    ctx.font = '12px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('[F / ESC] close', px + PANEL_W - PAD, py + HEADER_H / 2);

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + HEADER_H);
    ctx.lineTo(px + PANEL_W, py + HEADER_H);
    ctx.stroke();

    return py + HEADER_H;
  }

  private _identity(
    ctx:  CanvasRenderingContext2D,
    px:   number, py: number,
    ship: NonNullable<ReturnType<WorldState['ships']['find']>>,
  ): number {
    const sectionH = 52;
    py += 4;

    ctx.fillStyle = BG_DARK;
    ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, sectionH);

    const co = ship.companyId ?? COMPANY_NEUTRAL;

    // Company swatch
    ctx.fillStyle = COMPANY_COLORS[co] ?? '#aaa';
    ctx.fillRect(px + PAD + 8, py + 10, 14, 14);

    ctx.font = 'bold 15px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_HEAD;
    ctx.fillText(`Ship #${ship.id}   — ${COMPANY_NAMES[co] ?? 'Unknown'}`, px + PAD + 30, py + 9);

    // Speed + heading
    const spd = Math.sqrt(ship.velocity.x ** 2 + ship.velocity.y ** 2);
    const deg = ((ship.rotation * 180 / Math.PI) % 360 + 360) % 360;
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = TEXT_MONO;
    ctx.fillText(
      `Speed: ${spd.toFixed(1)} u/s   Heading: ${deg.toFixed(1)}°`,
      px + PAD + 30, py + 28
    );

    // World pos
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `(${ship.position.x.toFixed(0)}, ${ship.position.y.toFixed(0)})`,
      px + PANEL_W - PAD - 8, py + sectionH / 2
    );

    return py + sectionH + 8;
  }

  private _hullAmmo(
    ctx:  CanvasRenderingContext2D,
    px:   number, py: number,
    ship: NonNullable<ReturnType<WorldState['ships']['find']>>,
  ): number {
    py = this._sectionHeader(ctx, px, py, 'HULL & ARMAMENT', '');

    const barW = PANEL_W - PAD * 2 - 100;
    const barX = px + PAD + 90;

    // Hull health bar
    {
      const hp      = Math.max(0, Math.min(100, ship.hullHealth));
      const barColor = hp > 60 ? GREEN : hp > 30 ? ORANGE : RED;

      ctx.font = '12px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('Hull Integrity', px + PAD + 8, py + ROW_H / 2);

      // Track bg
      ctx.fillStyle = '#1a1a28';
      ctx.fillRect(barX, py + (ROW_H - BAR_H) / 2, barW, BAR_H);
      // Fill
      ctx.fillStyle = barColor;
      ctx.fillRect(barX, py + (ROW_H - BAR_H) / 2, barW * (hp / 100), BAR_H);
      // Label
      ctx.textAlign = 'right';
      ctx.fillStyle = TEXT_HEAD;
      ctx.fillText(`${hp.toFixed(0)}%`, barX + barW - 2, py + ROW_H / 2);

      py += ROW_H;
    }

    // Ammo row
    {
      ctx.font = '12px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = BG_STRIPE;
      ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, ROW_H);

      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('Cannon Ammo', px + PAD + 8, py + ROW_H / 2);

      ctx.textAlign = 'left';
      ctx.fillStyle = ship.infiniteAmmo ? GOLD : TEXT_HEAD;
      ctx.fillText(
        ship.infiniteAmmo ? '∞  (infinite)' : String(ship.cannonAmmo),
        barX, py + ROW_H / 2
      );

      py += ROW_H;
    }

    return py + 8;
  }

  private _modulesSection(
    ctx:     CanvasRenderingContext2D,
    px:      number, py: number,
    modules: ShipModule[],
  ): number {
    // Group by kind, compute health summaries
    const groups = new Map<string, { total: number; damaged: number; occupied: number }>();
    for (const m of modules) {
      if (m.kind === 'deck') continue; // skip deck as it's structural noise
      const entry = groups.get(m.kind) ?? { total: 0, damaged: 0, occupied: 0 };
      entry.total++;
      if (m.occupiedBy != null) entry.occupied++;

      // Health check
      const md = m.moduleData;
      if (md) {
        const hp =
          md.kind === 'cannon' ? (md as CannonModuleData).health :
          md.kind === 'mast'   ? (md as MastModuleData).health :
          md.kind === 'plank'  ? (md as PlankModuleData).health :
          md.kind === 'helm' || md.kind === 'steering-wheel' ? (md as any).health :
          null;
        const maxHp =
          md.kind === 'cannon' ? (md as CannonModuleData).maxHealth ?? 8000 :
          md.kind === 'mast'   ? (md as MastModuleData).maxHealth ?? 15000 :
          md.kind === 'plank'  ? (md as PlankModuleData).maxHealth ?? 10000 :
          md.kind === 'helm' || md.kind === 'steering-wheel' ? (md as any).maxHealth ?? 10000 :
          null;
        if (hp !== null && maxHp !== null && hp / maxHp < 0.5) entry.damaged++;
      }

      groups.set(m.kind, entry);
    }

    const kindOrder = ['helm', 'steering-wheel', 'cannon', 'mast', 'plank', 'ladder', 'seat', 'custom'];
    const sorted = kindOrder
      .filter(k => groups.has(k))
      .concat([...groups.keys()].filter(k => !kindOrder.includes(k)));

    const count = sorted.length;
    py = this._sectionHeader(ctx, px, py, 'MODULES', `${modules.filter(m => m.kind !== 'deck').length} installed`);

    const colLabel = px + PAD + 8;
    const colCount = px + PAD + 180;
    const colOcc   = px + PAD + 240;
    const colDmg   = px + PAD + 320;

    // Column header
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('Module', colLabel, py + ROW_H / 2);
    ctx.fillText('#', colCount, py + ROW_H / 2);
    ctx.fillText('In use', colOcc, py + ROW_H / 2);
    ctx.fillText('Damaged', colDmg, py + ROW_H / 2);
    py += ROW_H;

    for (let i = 0; i < sorted.length && i < 8; i++) {
      const kind  = sorted[i];
      const entry = groups.get(kind)!;

      if (i % 2 === 1) {
        ctx.fillStyle = BG_STRIPE;
        ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, ROW_H);
      }

      const label = kind.replace('-', ' ');
      ctx.font = '13px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_HEAD;
      ctx.fillText(label.charAt(0).toUpperCase() + label.slice(1), colLabel, py + ROW_H / 2);

      ctx.fillStyle = TEXT_MONO;
      ctx.fillText(String(entry.total), colCount, py + ROW_H / 2);

      ctx.fillStyle = entry.occupied > 0 ? ORANGE : TEXT_DIM;
      ctx.fillText(entry.occupied > 0 ? String(entry.occupied) : '—', colOcc, py + ROW_H / 2);

      ctx.fillStyle = entry.damaged > 0 ? RED : TEXT_DIM;
      ctx.fillText(entry.damaged > 0 ? String(entry.damaged) : '—', colDmg, py + ROW_H / 2);

      py += ROW_H;
    }

    if (count > 8) {
      ctx.font = '12px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`  … and ${count - 8} more module types`, px + PAD, py + 2);
      py += ROW_H;
    }

    return py + 8;
  }

  private _crewSection(
    ctx:        CanvasRenderingContext2D,
    px:         number, py: number,
    worldState: WorldState,
    shipId:     number,
  ): void {
    const aboard = worldState.npcs.filter(n => n.shipId === shipId);
    const players = worldState.players.filter(p => p.carrierId === shipId);

    py = this._sectionHeader(ctx, px, py, 'CREW', `${players.length} player${players.length !== 1 ? 's' : ''}, ${aboard.length} NPC${aboard.length !== 1 ? 's' : ''}`);

    if (aboard.length === 0 && players.length === 0) {
      ctx.font = '13px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('  Ghost ship — no crew aboard.', px + PAD, py + 4);
      return;
    }

    // Role tally
    const roleTally = new Map<string, number>();
    for (const npc of aboard) {
      const roleName =
        npc.role === 1 ? 'Gunner' :
        npc.role === 3 ? 'Rigger' : 'Sailor';
      roleTally.set(roleName, (roleTally.get(roleName) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [role, n] of roleTally) parts.push(`${n} ${role}${n !== 1 ? 's' : ''}`);
    if (players.length > 0) parts.unshift(`${players.length} Player${players.length !== 1 ? 's' : ''}`);

    ctx.font = '13px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_MONO;
    ctx.fillText('  ' + parts.join('   ·   '), px + PAD, py + 5);
  }

  // ─────────────────────────────────────────────────────────────────────────

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
