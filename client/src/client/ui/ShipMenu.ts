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
  SHIP_TYPE_GHOST,
  ShipLevelStats,
  SHIP_ATTR_WEIGHT,
  SHIP_ATTR_RESISTANCE,
  SHIP_ATTR_DAMAGE,
  SHIP_ATTR_CREW,
  SHIP_ATTR_STURDINESS,
  SHIP_ATTR_COUNT,
  SHIP_ATTR_NAMES,
  SHIP_ATTR_DESC,
  SHIP_ATTR_CAPS,
  SHIP_LEVEL_TOTAL_POINT_CAP,
  SHIP_LEVEL_XP_BASE,
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

/** Attribute index → server-side string name used in upgrade_ship messages */
const SHIP_ATTR_SERVER_NAMES: Record<number, string> = {
  [SHIP_ATTR_WEIGHT]:     'weight',
  [SHIP_ATTR_RESISTANCE]: 'resistance',
  [SHIP_ATTR_DAMAGE]:     'damage',
  [SHIP_ATTR_CREW]:       'crew',
  [SHIP_ATTR_STURDINESS]: 'sturdiness',
};

// ─────────────────────────────────────────────────────────────────────────────

const PANEL_W  = 480;
const PANEL_H  = 720;
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

  /** Called when the player clicks an affordable upgrade row. */
  public onUpgradeRequest?: (shipId: number, attribute: string) => void;

  /** Called when the player clicks an NPC row in the crew section. */
  public onNpcClick?: (npc: import('../../sim/Types.js').Npc) => void;

  /** Hit areas for attribute rows populated each render frame. */
  private _upgradeHitAreas: Array<{ attr: number; serverName: string; x: number; y: number; w: number; h: number; affordable: boolean }> = [];
  private _npcHitAreas: Array<{ npc: import('../../sim/Types.js').Npc; x: number; y: number; w: number; h: number }> = [];
  private _panelX = 0;
  private _panelY = 0;
  private _currentShipId = 0;

  toggle(): void { this.visible = !this.visible; }
  open():   void { this.visible = true;  }
  close():  void { this.visible = false; }

  /**
   * Handle a canvas click while the menu is visible.
   * Returns true if the click was consumed (inside panel or was an upgrade action).
   */
  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;
    // Check NPC row hit areas
    for (const area of this._npcHitAreas) {
      if (x >= area.x && x <= area.x + area.w &&
          y >= area.y && y <= area.y + area.h) {
        this.onNpcClick?.(area.npc);
        return true;
      }
    }
    // Check upgrade row hit areas (only affordable rows fire the callback)
    for (const area of this._upgradeHitAreas) {
      if (area.affordable &&
          x >= area.x && x <= area.x + area.w &&
          y >= area.y && y <= area.y + area.h) {
        this.onUpgradeRequest?.(this._currentShipId, area.serverName);
        return true;
      }
    }
    // Click inside the panel — consume but don't close
    if (x >= this._panelX && x <= this._panelX + PANEL_W &&
        y >= this._panelY && y <= this._panelY + PANEL_H) {
      return true;
    }
    // Click outside panel — let caller close the menu
    return false;
  }

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

    this._panelX = px;
    this._panelY = py;
    this._upgradeHitAreas = [];
    this._currentShipId = 0;

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
    cur = this._progressionSection(ctx, px, cur, ship.id, ship.levelStats);
    this._crewSection(ctx, px, cur, worldState, ship.id, ship.shipType ?? 3);

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
    shipType:   number = 3,
  ): void {
    this._npcHitAreas = [];
    const aboard  = worldState.npcs.filter(n => n.shipId === shipId);
    const players = worldState.players.filter(p => p.carrierId === shipId);

    py = this._sectionHeader(ctx, px, py, 'CREW', `${players.length} player${players.length !== 1 ? 's' : ''}, ${aboard.length} NPC${aboard.length !== 1 ? 's' : ''}`);

    if (aboard.length === 0 && players.length === 0) {
      ctx.font = '13px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        shipType === SHIP_TYPE_GHOST
          ? '  Phantom Brig — no crew aboard.'
          : '  No crew aboard.',
        px + PAD, py + 4,
      );
      return;
    }

    const ROLE_TAGS: Record<number, string> = { 0: 'Sailor', 1: 'Gunner', 2: 'Helm', 3: 'Rigger', 4: 'Repair' };
    const NPC_ROW_H = 36;
    const BAR_H_SM  = 5;

    for (const npc of aboard) {
      const rowX = px + PAD;
      const rowW = PANEL_W - PAD * 2;
      const rowY = py;

      // Hover highlight
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(rowX, rowY, rowW, NPC_ROW_H - 2);

      ctx.textBaseline = 'top';

      // Name + level
      ctx.font      = 'bold 13px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = TEXT_HEAD;
      ctx.fillText(npc.name, rowX + 4, rowY + 4);

      ctx.font      = '11px Consolas, monospace';
      ctx.fillStyle = GOLD;
      ctx.fillText(`Lv.${npc.npcLevel}`, rowX + 140, rowY + 5);

      // Role tag
      const roleStr = ROLE_TAGS[npc.role] ?? 'Crew';
      ctx.font      = '11px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'right';
      ctx.fillText(roleStr, rowX + rowW - 4, rowY + 5);

      // HP bar
      const hpPct = npc.maxHealth > 0 ? npc.health / npc.maxHealth : 1;
      const barX  = rowX + 4;
      const barW  = rowW - 8;
      const barY  = rowY + NPC_ROW_H - BAR_H_SM - 4;
      ctx.fillStyle = '#222';
      ctx.fillRect(barX, barY, barW, BAR_H_SM);
      ctx.fillStyle = hpPct > 0.6 ? GREEN : hpPct > 0.3 ? ORANGE : RED;
      ctx.fillRect(barX, barY, Math.round(barW * hpPct), BAR_H_SM);
      ctx.strokeStyle = '#445';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(barX, barY, barW, BAR_H_SM);

      // HP text next to bar
      ctx.font      = '10px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(`${npc.health}/${npc.maxHealth}`, barX + barW + 3, barY);

      // Click hint (small arrow)
      ctx.font      = '10px Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('▸', rowX + rowW, rowY + 4);

      // Register hit area
      this._npcHitAreas.push({ npc, x: rowX, y: rowY, w: rowW, h: NPC_ROW_H - 2 });
      py += NPC_ROW_H;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Renders the ship progression / attribute section.
   * Shows each attribute's current level, a filled bar up to its individual cap,
   * the computed effect multiplier, and remaining XP to next upgrade.
   */
  private _progressionSection(
    ctx:        CanvasRenderingContext2D,
    px:         number, py: number,
    shipId:     number,
    ls:         ShipLevelStats | undefined,
  ): number {
    this._currentShipId = shipId;
    if (!ls) {
      // Server hasn't sent level data yet — show a placeholder
      py = this._sectionHeader(ctx, px, py, 'PROGRESSION', 'no data');
      ctx.font = '12px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('  Level data not received from server.', px + PAD, py + 4);
      return py + ROW_H + 4;
    }

    const shipLevel    = ls.shipLevel;
    const totalCap     = ls.totalCap;
    const nextCostAll  = ls.nextUpgradeCost;   // same for every attr at this ship level
    const shipCapped   = shipLevel >= totalCap;
    const xpStr        = ls.xp.toLocaleString();
    const lvlStr       = `Lv. ${shipLevel} / ${totalCap}`;

    py = this._sectionHeader(ctx, px, py, 'PROGRESSION', `XP: ${xpStr}   ${lvlStr}`);

    // Ship-level progress bar
    {
      const barW     = PANEL_W - PAD * 2 - 100;
      const barX     = px + PAD + 90;
      const fillFrac = Math.min(shipLevel / totalCap, 1);
      const barColor = shipCapped ? GOLD : GREEN;

      ctx.font = '12px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('Ship Level', px + PAD + 8, py + ROW_H / 2);

      ctx.fillStyle = '#1a1a28';
      ctx.fillRect(barX, py + (ROW_H - BAR_H) / 2, barW, BAR_H);
      ctx.fillStyle = barColor;
      ctx.fillRect(barX, py + (ROW_H - BAR_H) / 2, barW * fillFrac, BAR_H);

      ctx.textAlign = 'right';
      ctx.fillStyle = shipCapped ? GOLD : TEXT_HEAD;
      ctx.fillText(lvlStr, barX + barW - 2, py + ROW_H / 2);
      py += ROW_H;
    }

    // Next upgrade cost row (single cost applies to any attribute)
    if (!shipCapped) {
      ctx.font = '12px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('Next upgrade cost (any attr):', px + PAD + 8, py + ROW_H / 2);
      ctx.fillStyle = ls.xp >= nextCostAll ? GREEN : ORANGE;
      ctx.fillText(`${nextCostAll.toLocaleString()} XP`, px + PAD + 260, py + ROW_H / 2);
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(`(${ls.xp.toLocaleString()} available)`, px + PAD + 360, py + ROW_H / 2);
      py += ROW_H;
    }

    // Header row for attribute table
    {
      ctx.font = 'bold 11px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('Attribute',  px + PAD + 8,   py + ROW_H / 2);
      ctx.fillText('Lvl',        px + PAD + 130,  py + ROW_H / 2);
      ctx.fillText('invested',   px + PAD + 160,  py + ROW_H / 2);
      ctx.fillText('Effect',     px + PAD + 270,  py + ROW_H / 2);
      py += ROW_H;
    }

    // One row per attribute
    const attrOrder = [
      SHIP_ATTR_DAMAGE,
      SHIP_ATTR_RESISTANCE,
      SHIP_ATTR_STURDINESS,
      SHIP_ATTR_WEIGHT,
      SHIP_ATTR_CREW,
    ];

    for (let ii = 0; ii < attrOrder.length; ii++) {
      const attr    = attrOrder[ii];
      const lvl     = ls.levels[attr] ?? 1;
      const pts     = lvl - 1;                              // points spent in this attr
      const attrCap = ls.attrCaps[attr] ?? SHIP_ATTR_CAPS[attr] ?? 50;
      const attrMaxed = pts >= attrCap;
      const isMaxed   = attrMaxed || shipCapped;
      const wip       = attr === SHIP_ATTR_WEIGHT || attr === SHIP_ATTR_CREW;

      // Alternate stripe
      if (ii % 2 === 1) {
        ctx.fillStyle = BG_STRIPE;
        ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, ROW_H);
      }

      // Attribute name
      ctx.font = '13px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = wip ? TEXT_DIM : TEXT_HEAD;
      ctx.fillText((SHIP_ATTR_NAMES[attr] ?? 'Unknown') + (wip ? ' (WIP)' : ''), px + PAD + 8, py + ROW_H / 2);

      // Level number
      ctx.fillStyle = lvl > 1 ? GOLD : TEXT_DIM;
      ctx.fillText(String(lvl), px + PAD + 130, py + ROW_H / 2);

      // Mini bar: pts out of attrCap
      {
        const mBarW = 80;
        const mBarX = px + PAD + 158;
        const frac  = Math.min(pts / attrCap, 1);
        ctx.fillStyle = '#1a1a28';
        ctx.fillRect(mBarX, py + (ROW_H - 8) / 2, mBarW, 8);
        ctx.fillStyle = isMaxed && pts >= attrCap ? GOLD : (wip ? '#556' : GREEN);
        ctx.fillRect(mBarX, py + (ROW_H - 8) / 2, mBarW * frac, 8);
        // pts/cap label
        ctx.font = '10px Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillStyle = TEXT_DIM;
        ctx.fillText(`${pts}/${attrCap}`, mBarX + mBarW + 28, py + ROW_H / 2);
      }

      // Computed effect
      ctx.font = '12px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = wip ? TEXT_DIM : TEXT_MONO;
      let effectStr = '';
      if (!wip) {
        if (attr === SHIP_ATTR_DAMAGE) {
          const mult = 1.0 + 0.04 * pts;
          effectStr = `×${mult.toFixed(2)} dmg`;
        } else if (attr === SHIP_ATTR_RESISTANCE) {
          const mult = Math.max(0.30, 1.0 - 0.02 * pts);
          effectStr = `×${mult.toFixed(2)} recv`;
        } else if (attr === SHIP_ATTR_STURDINESS) {
          const mult = Math.max(0.25, 1.0 - 0.03 * pts);
          effectStr = `×${mult.toFixed(2)} drain`;
        }
      } else {
        effectStr = attr === SHIP_ATTR_CREW ? `max ${ls.maxCrew}` : 'WIP';
      }
      ctx.fillText(effectStr, px + PAD + 270, py + ROW_H / 2);

      // + upgrade button (uses shared nextCostAll)
      const affordable = !isMaxed && !wip && ls.xp >= nextCostAll && nextCostAll > 0;
      const btnW = 28;
      const btnH = ROW_H - 6;
      const btnX = px + PANEL_W - PAD - btnW;
      const btnY = py + 3;

      if (isMaxed) {
        ctx.textAlign = 'right';
        ctx.fillStyle = TEXT_DIM;
        ctx.font = '11px Consolas, monospace';
        ctx.fillText(attrMaxed ? '— maxed —' : '— capped —', btnX + btnW, py + ROW_H / 2);
      } else if (wip) {
        ctx.textAlign = 'right';
        ctx.fillStyle = TEXT_DIM;
        ctx.font = '11px Consolas, monospace';
        ctx.fillText('— WIP —', btnX + btnW, py + ROW_H / 2);
      } else {
        // + button
        ctx.fillStyle = affordable ? 'rgba(68,204,102,0.22)' : 'rgba(80,80,80,0.12)';
        ctx.fillRect(btnX, btnY, btnW, btnH);
        ctx.strokeStyle = affordable ? GREEN : '#444';
        ctx.lineWidth = 1;
        ctx.strokeRect(btnX, btnY, btnW, btnH);
        ctx.font = 'bold 15px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = affordable ? GREEN : TEXT_DIM;
        ctx.fillText('+', btnX + btnW / 2, py + ROW_H / 2);

        // Record hit area
        this._upgradeHitAreas.push({
          attr,
          serverName: SHIP_ATTR_SERVER_NAMES[attr] ?? '',
          x: btnX, y: btnY, w: btnW, h: btnH,
          affordable,
        });
      }

      py += ROW_H;
    }

    return py + 8;
  }

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
