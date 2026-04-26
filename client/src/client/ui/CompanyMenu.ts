/**
 * CompanyMenu.ts
 *
 * Full-screen modal overlay for company/faction-level management.
 * Toggled by pressing [L].
 *
 * Sections:
 *  • Your Faction  — company badge + name
 *  • Your Crew     — NPCs aboard the player's current ship
 *  • Fleet         — all ships belonging to the player's company
 *  • Intel         — enemy / neutral ships visible in the world
 */

import {
  WorldState,
  Npc,
  Ship,
  COMPANY_NEUTRAL,
  COMPANY_SOLO,
  COMPANY_PIRATES,
  COMPANY_NAVY,
  NPC_STATE_IDLE,
  NPC_STATE_MOVING,
  NPC_STATE_AT_GUN,
  NPC_STATE_REPAIRING,
} from '../../sim/Types.js';

// ── Visual constants ──────────────────────────────────────────────────────────

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

const NPC_ROLE_NAMES: Record<number, string> = {
  0: 'Sailor',
  1: 'Gunner',
  2: 'Sailor',
  3: 'Rigger',
  4: 'Repairer',
};

const NPC_STATE_NAMES: Record<number, string> = {
  [NPC_STATE_IDLE]:      'Idle',
  [NPC_STATE_MOVING]:    'Moving',
  [NPC_STATE_AT_GUN]: 'At Gun',
  [NPC_STATE_REPAIRING]: 'Repairing',
};

const PANEL_W  = 560;
const PANEL_H  = 520;
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

// ─────────────────────────────────────────────────────────────────────────────

export class CompanyMenu {
  public visible = false;

  /** Fired when the player clicks the Leave Company button. */
  public onLeaveCompany: (() => void) | null = null;

  /** Hit area of the Leave Company button — refreshed each render. */
  private _leaveBtnArea: { x: number; y: number; w: number; h: number } | null = null;

  // ── Toggle ──────────────────────────────────────────────────────────────────
  toggle(): void {
    this.visible = !this.visible;
  }

  /** Returns true if the click landed on a button inside the menu. */
  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (this._leaveBtnArea) {
      const b = this._leaveBtnArea;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.onLeaveCompany?.();
        return true;
      }
    }
    return false;
  }

  open():  void { this.visible = true;  }
  close(): void { this.visible = false; }

  // ── Render ──────────────────────────────────────────────────────────────────
  render(
    ctx: CanvasRenderingContext2D,
    worldState: WorldState,
    assignedPlayerId: number | null | undefined,
  ): void {
    if (!this.visible) return;

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    // ── Dim the background ────────────────────────────────────────────────────
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, cw, ch);

    // ── Centre the panel ──────────────────────────────────────────────────────
    const px = Math.round((cw - PANEL_W) / 2);
    const py = Math.round((ch - PANEL_H) / 2);

    // Panel background + border
    ctx.fillStyle  = BG_PANEL;
    ctx.fillRect(px, py, PANEL_W, PANEL_H);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(px, py, PANEL_W, PANEL_H);

    // Resolve player / ship context
    const player = assignedPlayerId != null
      ? worldState.players.find(p => p.id === assignedPlayerId)
      : worldState.players[0] ?? null;

    const playerCompany = player?.companyId ?? COMPANY_NEUTRAL;
    const playerShipId  = player?.carrierId ?? 0;
    const playerShip    = playerShipId
      ? worldState.ships.find(s => s.id === playerShipId) ?? null
      : null;

    let cursor = py;

    cursor = this._drawHeader(ctx, px, cursor, playerCompany);
    cursor = this._drawFactionBadge(ctx, px, cursor, playerCompany, player?.id ?? null);
    cursor = this._drawCrewSection(ctx, px, cursor, worldState.npcs, playerShipId);
    cursor = this._drawFleetSection(ctx, px, cursor, worldState.ships, playerCompany, playerShipId);
    this._drawFooter(ctx, px, py, worldState.npcs, worldState.ships, playerCompany);

    ctx.restore();
  }

  // ── Internal sections ────────────────────────────────────────────────────────

  private _drawHeader(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    playerCompany: number,
  ): number {
    const companyColor = COMPANY_COLORS[playerCompany] ?? '#aaa';
    ctx.fillStyle = companyColor + '22';                // subtle tinted header bg
    ctx.fillRect(px, py, PANEL_W, HEADER_H);

    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + HEADER_H);
    ctx.lineTo(px + PANEL_W, py + HEADER_H);
    ctx.stroke();

    // Title
    ctx.font          = 'bold 17px Consolas, monospace';
    ctx.textAlign     = 'left';
    ctx.textBaseline  = 'middle';
    ctx.fillStyle     = GOLD;
    ctx.fillText('⚓  COMPANY LEDGER', px + PAD, py + HEADER_H / 2);

    // Close hint
    ctx.font          = '12px Consolas, monospace';
    ctx.textAlign     = 'right';
    ctx.fillStyle     = TEXT_DIM;
    ctx.fillText('[L / ESC] close', px + PANEL_W - PAD, py + HEADER_H / 2);

    return py + HEADER_H;
  }

  private _drawFactionBadge(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    playerCompany: number,
    playerId: number | null,
  ): number {
    const sectionH = 46;
    py += 4;

    ctx.fillStyle    = BG_DARK;
    ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, sectionH);

    // Faction color swatch
    const swatchX = px + PAD + 8;
    const swatchY = py + (sectionH - 18) / 2;
    ctx.fillStyle = COMPANY_COLORS[playerCompany] ?? '#aaa';
    ctx.fillRect(swatchX, swatchY, 18, 18);

    // Company name
    ctx.font         = 'bold 16px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_HEAD;
    const name = COMPANY_NAMES[playerCompany] ?? `Company ${playerCompany}`;
    ctx.fillText(name.toUpperCase(), swatchX + 26, py + sectionH / 2);

    // Player ID tag (only when not showing the leave button)
    const canLeave = playerCompany !== COMPANY_SOLO && playerCompany !== COMPANY_NEUTRAL;
    if (!canLeave && playerId != null) {
      ctx.font      = '13px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'right';
      ctx.fillText(`Player #${playerId}`, px + PANEL_W - PAD - 8, py + sectionH / 2);
    }

    // Leave Company button — only shown when in a guild company
    if (canLeave) {
      const btnW = 120;
      const btnH = 22;
      const btnX = px + PANEL_W - PAD - btnW;
      const btnY = py + (sectionH - btnH) / 2;
      this._leaveBtnArea = { x: btnX, y: btnY, w: btnW, h: btnH };

      ctx.fillStyle = '#7a1a1a';
      ctx.fillRect(btnX, btnY, btnW, btnH);
      ctx.strokeStyle = '#cc4444';
      ctx.lineWidth   = 1;
      ctx.strokeRect(btnX, btnY, btnW, btnH);

      ctx.font         = 'bold 12px Consolas, monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#ff8888';
      ctx.fillText('LEAVE COMPANY', btnX + btnW / 2, btnY + btnH / 2);
    } else {
      this._leaveBtnArea = null;
    }

    return py + sectionH + 8;
  }

  private _drawCrewSection(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    npcs: Npc[],
    shipId: number,
  ): number {
    const crewAboard = npcs.filter(n => n.shipId === shipId);

    py = this._sectionHeader(ctx, px, py, 'YOUR CREW ABOARD', `${crewAboard.length} sailor${crewAboard.length !== 1 ? 's' : ''}`);

    if (crewAboard.length === 0) {
      ctx.font         = '13px Consolas, monospace';
      ctx.fillStyle    = TEXT_DIM;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('  No crew members aboard.', px + PAD, py + 4);
      return py + ROW_H + 6;
    }

    // Column header row
    py = this._tableRow(ctx, px, py, '#ID', 'Name', 'Role', 'State', true);

    const maxRows = Math.min(crewAboard.length, 6);
    for (let i = 0; i < maxRows; i++) {
      const npc = crewAboard[i];
      const roleName  = NPC_ROLE_NAMES[npc.role]  ?? `Role ${npc.role}`;
      const stateName = NPC_STATE_NAMES[npc.state] ?? `State ${npc.state}`;

      const stateColor =
        npc.state === NPC_STATE_AT_GUN ? '#ff9944' :
        npc.state === NPC_STATE_REPAIRING ? '#66dd88' :
        npc.state === NPC_STATE_MOVING    ? '#88ccff' :
                                            TEXT_DIM;

      py = this._tableRow(ctx, px, py, String(npc.id), npc.name, roleName, stateName, false, stateColor);
    }

    if (crewAboard.length > maxRows) {
      ctx.font         = '12px Consolas, monospace';
      ctx.fillStyle    = TEXT_DIM;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`  … and ${crewAboard.length - maxRows} more`, px + PAD, py + 3);
      py += ROW_H;
    }

    return py + 8;
  }

  private _drawFleetSection(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    ships: Ship[],
    playerCompany: number,
    playerShipId: number,
  ): number {
    // Partition ships into ally (friendly to player) and enemy/neutral
    const ally    = ships.filter(s => s.companyId === playerCompany);
    const neutral = ships.filter(s => s.companyId === COMPANY_NEUTRAL && s.companyId !== playerCompany);
    const enemy   = ships.filter(s => s.companyId !== playerCompany && s.companyId !== COMPANY_NEUTRAL);

    py = this._sectionHeader(ctx, px, py, 'SHIPS IN RANGE', `${ships.length} total`);

    const drawGroup = (label: string, group: Ship[], color: string): number => {
      if (group.length === 0) return py;
      ctx.font         = 'bold 12px Consolas, monospace';
      ctx.fillStyle    = color;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`  ── ${label} ──`, px + PAD, py + 4);
      py += ROW_H - 4;

      for (const ship of group) {
        const isYours = ship.id === playerShipId;
        // Compact row: swatch | Ship #N | companyName | (YOU)
        const rowY = py;
        if ((rowY - (ctx.canvas.height / 2 - PANEL_H / 2)) > PANEL_H - 60) break; // guard overflow

        // Stripe alternate rows
        if ((group.indexOf(ship) % 2) === 1) {
          ctx.fillStyle = BG_STRIPE;
          ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, ROW_H);
        }

        // Company swatch
        ctx.fillStyle = COMPANY_COLORS[ship.companyId] ?? '#aaa';
        ctx.fillRect(px + PAD + 4, py + 6, 10, 10);

        ctx.font         = '13px Consolas, monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = isYours ? GOLD : TEXT_HEAD;
        ctx.fillText(
          `Ship #${ship.id}   ${(COMPANY_NAMES[ship.companyId] ?? 'Unknown').padEnd(9)}${isYours ? '  ◀ yours' : ''}`,
          px + PAD + 20, py + 4
        );

        py += ROW_H;
      }
      return py;
    };

    py = drawGroup('Friendly', ally,    COMPANY_COLORS[playerCompany] ?? '#aaa');
    py = drawGroup('Neutral',  neutral, COMPANY_COLORS[COMPANY_NEUTRAL]);
    py = drawGroup('Enemy',    enemy,   '#ff5555');

    if (ships.length === 0) {
      ctx.font         = '13px Consolas, monospace';
      ctx.fillStyle    = TEXT_DIM;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('  No ships in range.', px + PAD, py + 4);
      py += ROW_H;
    }

    return py + 8;
  }

  private _drawFooter(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    npcs: Npc[],
    ships: Ship[],
    playerCompany: number,
  ): void {
    const footerY = py + PANEL_H - 28;

    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px, footerY);
    ctx.lineTo(px + PANEL_W, footerY);
    ctx.stroke();

    const allyShips = ships.filter(s => s.companyId === playerCompany).length;
    const allyNpcs  = npcs.filter(n => n.companyId === playerCompany).length;

    ctx.font         = '12px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_DIM;
    ctx.fillText(
      `Company ships: ${allyShips}   Company sailors: ${allyNpcs}   Total NPC entities: ${npcs.length}`,
      px + PAD, footerY + 14
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Draws a coloured section-header bar, returns updated cursor Y. */
  private _sectionHeader(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    label: string, right: string,
  ): number {
    const h = 22;
    ctx.fillStyle = 'rgba(255,215,0,0.08)';
    ctx.fillRect(px, py, PANEL_W, h);

    ctx.font         = 'bold 12px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = GOLD;
    ctx.fillText(label, px + PAD, py + h / 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(right, px + PANEL_W - PAD, py + h / 2);

    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + h);
    ctx.lineTo(px + PANEL_W, py + h);
    ctx.stroke();

    return py + h + 2;
  }

  /** Renders a four-column table row. Pass isHeader=true for the label row. */
  private _tableRow(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    col0: string, col1: string, col2: string, col3: string,
    isHeader: boolean,
    col3Color?: string,
  ): number {
    if (!isHeader && (Math.floor((py / ROW_H)) % 2 === 0)) {
      ctx.fillStyle = BG_STRIPE;
      ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, ROW_H);
    }

    ctx.font         = isHeader ? 'bold 12px Consolas, monospace' : '13px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    const baseY = py + ROW_H / 2;
    const midY  = baseY;

    const c0x = px + PAD + 4;
    const c1x = px + PAD + 60;
    const c2x = px + PAD + 220;
    const c3x = px + PAD + 340;

    ctx.fillStyle = isHeader ? TEXT_DIM : TEXT_MONO;
    ctx.fillText(col0, c0x, midY);
    ctx.fillText(col1, c1x, midY);
    ctx.fillText(col2, c2x, midY);

    ctx.fillStyle = col3Color ?? (isHeader ? TEXT_DIM : TEXT_HEAD);
    ctx.fillText(col3, c3x, midY);

    return py + ROW_H;
  }
}
