/**
 * ShipSchematicPoolMenu — deposit personal schematics into the ship pool for NPC repair crew.
 * Module-type tabs, priority reordering (↑/↓), withdraw back to personal inventory.
 */

import {
  SchematicEntry,
  ShipSchematicEntry,
  tierColor,
  tierName,
  statMultLabel,
  QUALITY_STAT_NAMES,
} from '../../sim/Quality.js';

const PANEL_W = 560;
const PANEL_H = 680;
const PAD = 16;
const HEADER_H = 44;
const TAB_H = 32;
const ROW_H = 52;

const BG_PANEL  = 'rgba(20, 24, 36, 0.98)';
const BORDER    = '#334';
const TEXT_HEAD = '#e8e0cc';
const TEXT_DIM  = '#778';
const GOLD      = '#ffd700';
const GREEN     = '#44cc66';

/** Ship module types that can be deposited into the pool (matches server allow-list). */
const MODULE_TABS: { kind: string; itemId: number; label: string; color: string }[] = [
  { kind: 'plank',  itemId: 1,  label: 'Plank',  color: '#b8832b' },
  { kind: 'deck',   itemId: 13, label: 'Deck',   color: '#8b5e3c' },
  { kind: 'cannon', itemId: 7,  label: 'Cannon', color: '#444444' },
  { kind: 'swivel', itemId: 14, label: 'Swivel', color: '#7a4a2a' },
  { kind: 'mast',   itemId: 8,  label: 'Sail',   color: '#1e8c6e' },
  { kind: 'helm',   itemId: 9,  label: 'Helm',   color: '#6a3d8f' },
  { kind: 'ramp',   itemId: 37, label: 'Ramp',   color: '#7a5c2a' },
];

type Hit =
  | { type: 'tab'; itemId: number; x: number; y: number; w: number; h: number }
  | { type: 'up' | 'down' | 'withdraw'; poolIndex: number; x: number; y: number; w: number; h: number }
  | { type: 'deposit'; playerBpIndex: number; x: number; y: number; w: number; h: number }
  | { type: 'close'; x: number; y: number; w: number; h: number };

export class ShipSchematicPoolMenu {
  public visible = false;

  public onDeposit: ((shipId: number, playerBpIndex: number) => void) | null = null;
  public onWithdraw: ((shipId: number, poolIndex: number) => void) | null = null;
  public onReorder: ((shipId: number, itemId: number, order: number[]) => void) | null = null;
  public onRequestList: ((shipId: number) => void) | null = null;

  private _shipId = 0;
  private _activeItemId = MODULE_TABS[0].itemId;
  private _poolItems: ShipSchematicEntry[] = [];
  private _personalItems: SchematicEntry[] = [];
  private _hits: Hit[] = [];
  private _panelX = 0;
  private _panelY = 0;
  private _poolScrollY = 0;
  private _depositScrollY = 0;

  open(shipId: number): void {
    this.visible = true;
    this._shipId = shipId;
    this._poolScrollY = 0;
    this._depositScrollY = 0;
    this.onRequestList?.(shipId);
  }

  close(): void {
    this.visible = false;
    this._hits = [];
  }

  setPoolItems(items: ShipSchematicEntry[]): void {
    this._poolItems = items;
  }

  setPersonalItems(items: SchematicEntry[]): void {
    this._personalItems = items;
  }

  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;
    for (const hit of this._hits) {
      if (x < hit.x || x > hit.x + hit.w || y < hit.y || y > hit.y + hit.h) continue;
      switch (hit.type) {
        case 'tab':
          this._activeItemId = hit.itemId;
          this._poolScrollY = 0;
          this._depositScrollY = 0;
          return true;
        case 'deposit':
          this.onDeposit?.(this._shipId, hit.playerBpIndex);
          return true;
        case 'withdraw':
          this.onWithdraw?.(this._shipId, hit.poolIndex);
          return true;
        case 'up':
        case 'down':
          this._movePriority(hit.poolIndex, hit.type === 'up');
          return true;
        case 'close':
          this.close();
          return true;
      }
    }
    if (x >= this._panelX && x <= this._panelX + PANEL_W &&
        y >= this._panelY && y <= this._panelY + PANEL_H) {
      return true;
    }
    this.close();
    return true;
  }

  handleWheel(deltaY: number, x: number, y: number): boolean {
    if (!this.visible) return false;
    if (x < this._panelX || x > this._panelX + PANEL_W ||
        y < this._panelY || y > this._panelY + PANEL_H) return false;
    const splitY = this._panelY + HEADER_H + TAB_H + 220;
    if (y < splitY) {
      this._poolScrollY = Math.max(0, this._poolScrollY + deltaY * 0.5);
    } else {
      this._depositScrollY = Math.max(0, this._depositScrollY + deltaY * 0.5);
    }
    return true;
  }

  private _movePriority(poolIndex: number, up: boolean): void {
    const filtered = this._poolForTab();
    const pos = filtered.findIndex(e => e.index === poolIndex);
    if (pos < 0) return;
    const swapPos = up ? pos - 1 : pos + 1;
    if (swapPos < 0 || swapPos >= filtered.length) return;
    const reordered = filtered.map(e => e.index);
    const tmp = reordered[pos];
    reordered[pos] = reordered[swapPos];
    reordered[swapPos] = tmp;
    this.onReorder?.(this._shipId, this._activeItemId, reordered);
  }

  private _poolForTab(): ShipSchematicEntry[] {
    return this._poolItems
      .filter(e => e.item === this._activeItemId)
      .sort((a, b) => a.prio - b.prio || a.index - b.index);
  }

  private _personalForTab(): SchematicEntry[] {
    return this._personalItems.filter(e => e.item === this._activeItemId);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    this._hits = [];

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, cw, ch);

    const px = Math.round((cw - PANEL_W) / 2);
    const py = Math.round((ch - PANEL_H) / 2);
    this._panelX = px;
    this._panelY = py;

    ctx.fillStyle = BG_PANEL;
    ctx.fillRect(px, py, PANEL_W, PANEL_H);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px, py, PANEL_W, PANEL_H);

    // Header
    ctx.fillStyle = 'rgba(255,215,0,0.08)';
    ctx.fillRect(px, py, PANEL_W, HEADER_H);
    ctx.font = 'bold 16px Georgia, serif';
    ctx.fillStyle = GOLD;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('📋  SHIP SCHEMATIC POOL', px + PAD, py + HEADER_H / 2);
    ctx.font = '12px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.fillText('NPC repair crew uses these first', px + PANEL_W - PAD, py + HEADER_H / 2);

    const closeW = 52;
    const closeX = px + PANEL_W - PAD - closeW;
    const closeY = py + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(closeX, closeY, closeW, 28);
    ctx.strokeStyle = BORDER;
    ctx.strokeRect(closeX, closeY, closeW, 28);
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText('Close', closeX + closeW / 2, closeY + 14);
    this._hits.push({ type: 'close', x: closeX, y: closeY, w: closeW, h: 28 });

    let cy = py + HEADER_H + 6;

    // Module type tabs
    const tabW = Math.floor((PANEL_W - PAD * 2) / MODULE_TABS.length);
    for (let i = 0; i < MODULE_TABS.length; i++) {
      const tab = MODULE_TABS[i];
      const tx = px + PAD + i * tabW;
      const active = tab.itemId === this._activeItemId;
      ctx.fillStyle = active ? 'rgba(255,215,0,0.14)' : 'rgba(0,0,0,0.25)';
      ctx.fillRect(tx, cy, tabW - 2, TAB_H);
      ctx.strokeStyle = active ? GOLD : BORDER;
      ctx.strokeRect(tx, cy, tabW - 2, TAB_H);
      ctx.font = '11px Georgia, serif';
      ctx.fillStyle = active ? GOLD : TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText(tab.label, tx + (tabW - 2) / 2, cy + TAB_H / 2);
      this._hits.push({ type: 'tab', itemId: tab.itemId, x: tx, y: cy, w: tabW - 2, h: TAB_H });
    }
    cy += TAB_H + 8;

    // Pool section label
    const poolEntries = this._poolForTab();
    ctx.font = 'bold 12px Georgia, serif';
    ctx.fillStyle = TEXT_HEAD;
    ctx.textAlign = 'left';
    ctx.fillText(`Ship pool — priority order (top = used first)  [${poolEntries.length}]`, px + PAD, cy);
    cy += 18;

    const poolViewH = 200;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px + PAD, cy, PANEL_W - PAD * 2, poolViewH);
    ctx.clip();

    let rowY = cy - this._poolScrollY;
    if (poolEntries.length === 0) {
      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('No schematics deposited for this module type.', px + PAD + 4, cy + 24);
    }
    for (let i = 0; i < poolEntries.length; i++) {
      const entry = poolEntries[i];
      if (rowY + ROW_H >= cy && rowY <= cy + poolViewH) {
        this._drawPoolRow(ctx, px + PAD, rowY, PANEL_W - PAD * 2, entry, i, poolEntries.length);
      }
      rowY += ROW_H + 4;
    }
    ctx.restore();
    cy += poolViewH + 10;

    // Deposit section
    const personal = this._personalForTab();
    ctx.font = 'bold 12px Georgia, serif';
    ctx.fillStyle = TEXT_HEAD;
    ctx.fillText(`Your schematics — click to deposit  [${personal.length}]`, px + PAD, cy);
    cy += 18;

    const depViewH = py + PANEL_H - cy - PAD;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px + PAD, cy, PANEL_W - PAD * 2, depViewH);
    ctx.clip();

    rowY = cy - this._depositScrollY;
    if (personal.length === 0) {
      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('No matching personal schematics.', px + PAD + 4, cy + 24);
    }
    for (const entry of personal) {
      if (rowY + ROW_H >= cy && rowY <= cy + depViewH) {
        this._drawDepositRow(ctx, px + PAD, rowY, PANEL_W - PAD * 2, entry);
      }
      rowY += ROW_H + 4;
    }
    ctx.restore();

    ctx.restore();
  }

  private _drawPoolRow(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number,
    entry: ShipSchematicEntry,
    pos: number, total: number,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(x, y, w, ROW_H);
    ctx.strokeStyle = BORDER;
    ctx.strokeRect(x, y, w, ROW_H);

    ctx.font = 'bold 13px Georgia, serif';
    ctx.fillStyle = tierColor(entry.tier);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`#${pos + 1}  ${tierName(entry.tier)}`, x + 8, y + 16);

    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(`${entry.crafts} crafts`, x + 8, y + 36);

    const stats = entry.stats
      .map((q8, i) => (q8 ? `${QUALITY_STAT_NAMES[i]} ${statMultLabel(q8)}` : null))
      .filter(Boolean)
      .slice(0, 2)
      .join('  ');
    if (stats) {
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(stats, x + 100, y + 26);
    }

    const btnW = 28;
    const btnH = 22;
    const btnY = y + (ROW_H - btnH) / 2;
    let bx = x + w - 8 - btnW;

    // Withdraw
    ctx.fillStyle = 'rgba(255,100,80,0.15)';
    ctx.fillRect(bx - btnW - 4, btnY, btnW + 4, btnH);
    ctx.strokeStyle = '#a44';
    ctx.strokeRect(bx - btnW - 4, btnY, btnW + 4, btnH);
    ctx.font = '10px Georgia, serif';
    ctx.fillStyle = '#f88';
    ctx.textAlign = 'center';
    ctx.fillText('Out', bx - btnW / 2 - 2, btnY + btnH / 2);
    this._hits.push({ type: 'withdraw', poolIndex: entry.index, x: bx - btnW - 4, y: btnY, w: btnW + 4, h: btnH });
    bx -= btnW + 8;

    // Down
    const canDown = pos < total - 1;
    ctx.fillStyle = canDown ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(bx - btnW, btnY, btnW, btnH);
    ctx.strokeStyle = canDown ? BORDER : '#222';
    ctx.strokeRect(bx - btnW, btnY, btnW, btnH);
    ctx.fillStyle = canDown ? TEXT_HEAD : '#444';
    ctx.fillText('↓', bx - btnW / 2, btnY + btnH / 2);
    if (canDown) this._hits.push({ type: 'down', poolIndex: entry.index, x: bx - btnW, y: btnY, w: btnW, h: btnH });
    bx -= btnW + 4;

    // Up
    const canUp = pos > 0;
    ctx.fillStyle = canUp ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(bx - btnW, btnY, btnW, btnH);
    ctx.strokeStyle = canUp ? BORDER : '#222';
    ctx.strokeRect(bx - btnW, btnY, btnW, btnH);
    ctx.fillStyle = canUp ? TEXT_HEAD : '#444';
    ctx.fillText('↑', bx - btnW / 2, btnY + btnH / 2);
    if (canUp) this._hits.push({ type: 'up', poolIndex: entry.index, x: bx - btnW, y: btnY, w: btnW, h: btnH });
  }

  private _drawDepositRow(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number,
    entry: SchematicEntry,
  ): void {
    ctx.fillStyle = 'rgba(68,204,102,0.06)';
    ctx.fillRect(x, y, w, ROW_H);
    ctx.strokeStyle = 'rgba(68,204,102,0.35)';
    ctx.strokeRect(x, y, w, ROW_H);

    ctx.font = 'bold 13px Georgia, serif';
    ctx.fillStyle = tierColor(entry.tier);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(tierName(entry.tier), x + 8, y + 18);

    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(`${entry.crafts} crafts — click to deposit`, x + 8, y + 36);

    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = GREEN;
    ctx.textAlign = 'right';
    ctx.fillText('+ Deposit', x + w - 10, y + ROW_H / 2);

    this._hits.push({ type: 'deposit', playerBpIndex: entry.index, x, y, w, h: ROW_H });
  }
}
