/**
 * ChestMenu.ts
 *
 * Canvas-drawn resource chest inventory panel for ship chests.
 * Two-column layout matching LandChestMenu: player resources on the left,
 * chest storage on the right, with arrow buttons in the middle.
 * Adds cannonball as a fifth storable resource not present in land chests.
 */

import { type PlayerInventory } from '../../sim/Inventory.js';
import { type ChestModuleData } from '../../sim/modules.js';

// ── Layout constants ─────────────────────────────────────────────────────────
const PANEL_W   = 620;
const PANEL_H   = 330;
const HDR_H     = 44;
const ROW_H     = 48;
const CARD_W    = 220;
const MID_W     = 120;
const PAD       = 16;
const CHEST_MAX = 8192;

const RESOURCES: Array<{ key: keyof ChestModuleData; label: string; color: string; border: string; symbol: string }> = [
  { key: 'wood',        label: 'Wood',       color: '#8b5e2a', border: '#5c3a10', symbol: '🪵' },
  { key: 'fiber',       label: 'Fiber',      color: '#c8a46e', border: '#8a6030', symbol: '🌿' },
  { key: 'metal',       label: 'Metal',      color: '#8a8a8c', border: '#555558', symbol: '⚙' },
  { key: 'stone',       label: 'Stone',      color: '#9a9a9c', border: '#666668', symbol: '🪨' },
  { key: 'cannon_ball', label: 'Cannonball', color: '#555555', border: '#333333', symbol: '●' },
];

// ── Colour palette ─────────────────────────────────────────────────────────────
const BG_PANEL   = '#1a1208';
const BG_CARD    = '#231a0e';
const BG_MID     = '#13100a';
const GOLD       = '#c8a050';
const TEXT_HEAD  = '#f0e0c0';
const TEXT_DIM   = '#8a7860';
const TEXT_MONO  = '#d0b878';
const BTN_BG     = '#3a2a10';
const BTN_HOVER  = '#5a4020';
const BTN_BORDER = '#806030';

// ── Helpers ────────────────────────────────────────────────────────────────────
function _rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function _hit(x: number, y: number, h: { x: number; y: number; w: number; h: number }): boolean {
  return x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
}

// ── Quantity dialog ───────────────────────────────────────────────────────────
interface QuantityDialog {
  direction: 'deposit' | 'withdraw';
  item: keyof ChestModuleData;
  label: string;
  color: string;
  max: number;
  amount: number;
  typing: boolean;
  typingStr: string;
  sliderDragging: boolean;
  trackX: number; trackY: number; trackW: number;
  amountHit:  { x: number; y: number; w: number; h: number };
  confirmHit: { x: number; y: number; w: number; h: number };
  cancelHit:  { x: number; y: number; w: number; h: number };
}

export interface ChestTransferEvent {
  moduleId:  number;
  shipId:    number;
  item:      string;
  quantity:  number;
  direction: 'deposit' | 'withdraw';
}

export class ChestMenu {
  visible = false;

  private _moduleId  = 0;
  private _shipId    = 0;
  private _chestData: ChestModuleData | null = null;
  /** Cached player resource counts — updated on each render() call. */
  private _playerRes: Record<string, number> = {};

  onTransfer: ((evt: ChestTransferEvent) => void) | null = null;

  private _px = 0;
  private _py = 0;

  private _arrowHits: Array<{ dep: {x:number;y:number;w:number;h:number}; wit: {x:number;y:number;w:number;h:number} }> = [];
  private _closeHit = { x: 0, y: 0, w: 0, h: 0 };
  private _hover: { side: 'arrow'; row: number; arrowDir: 'dep' | 'wit' } | null = null;
  private _dialog: QuantityDialog | null = null;
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  // ── Public API ──────────────────────────────────────────────────────────────

  open(moduleId: number, shipId: number, chestData: ChestModuleData | null): void {
    this._moduleId  = moduleId;
    this._shipId    = shipId;
    this._chestData = chestData;
    this.visible    = true;
    this._dialog    = null;
  }

  close(): void {
    this.visible = false;
    this._closeDialog();
  }

  updateChestData(data: ChestModuleData | null): void {
    this._chestData = data;
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  handleClick(x: number, y: number, cw: number, ch: number): boolean {
    if (!this.visible) return false;

    if (this._dialog) {
      const d = this._dialog;
      if (_hit(x, y, d.amountHit))  { d.typing = true; d.typingStr = ''; return true; }
      if (_hit(x, y, d.confirmHit)) {
        if (d.amount > 0) {
          this.onTransfer?.({ moduleId: this._moduleId, shipId: this._shipId,
            item: d.item as string, quantity: d.amount, direction: d.direction });
        }
        this._closeDialog();
        return true;
      }
      if (_hit(x, y, d.cancelHit)) { this._closeDialog(); return true; }
      if (x >= d.trackX && x <= d.trackX + d.trackW && Math.abs(y - d.trackY - 4) <= 12) {
        d.sliderDragging = true;
        d.amount = Math.max(1, Math.min(d.max, Math.round(((x - d.trackX) / d.trackW) * d.max)));
        d.typingStr = String(d.amount);
        return true;
      }
      return true;
    }

    if (_hit(x, y, this._closeHit)) { this.close(); return true; }

    for (let i = 0; i < this._arrowHits.length; i++) {
      const ah = this._arrowHits[i];
      if (_hit(x, y, ah.dep)) { this._openDialog('deposit',  RESOURCES[i].key, cw, ch); return true; }
      if (_hit(x, y, ah.wit)) { this._openDialog('withdraw', RESOURCES[i].key, cw, ch); return true; }
    }

    return x >= this._px && x <= this._px + PANEL_W && y >= this._py && y <= this._py + PANEL_H;
  }

  handleMouseMove(x: number, y: number): void {
    if (!this.visible || this._dialog) { this._hover = null; return; }
    for (let i = 0; i < this._arrowHits.length; i++) {
      const ah = this._arrowHits[i];
      if (_hit(x, y, ah.dep)) { this._hover = { side: 'arrow', row: i, arrowDir: 'dep' }; return; }
      if (_hit(x, y, ah.wit)) { this._hover = { side: 'arrow', row: i, arrowDir: 'wit' }; return; }
    }
    this._hover = null;
  }

  handleMouseUp(_x: number, _y: number): void {
    if (this._dialog) this._dialog.sliderDragging = false;
  }

  handleMouseDrag(x: number, _y: number): void {
    if (!this.visible || !this._dialog?.sliderDragging) return;
    const d = this._dialog;
    d.amount = Math.max(1, Math.min(d.max, Math.round(((x - d.trackX) / d.trackW) * d.max)));
    d.typingStr = String(d.amount);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(
    ctx: CanvasRenderingContext2D,
    cw: number,
    ch: number,
    playerInventory: PlayerInventory | null,
  ): void {
    if (!this.visible) return;

    // Build player resource counts from inventory
    this._playerRes = {};
    if (playerInventory) {
      for (const slot of playerInventory.slots) {
        if (slot.item) this._playerRes[slot.item] = (this._playerRes[slot.item] ?? 0) + slot.quantity;
      }
    }

    const px = Math.round((cw - PANEL_W) / 2);
    const py = Math.round((ch - PANEL_H) / 2);
    this._px = px;
    this._py = py;

    ctx.save();

    // ── Dim backdrop ──────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, ch);

    // ── Panel ─────────────────────────────────────────────────────────────────
    ctx.fillStyle = BG_PANEL;
    _rr(ctx, px, py, PANEL_W, PANEL_H, 10); ctx.fill();
    ctx.strokeStyle = GOLD; ctx.lineWidth = 2;
    _rr(ctx, px, py, PANEL_W, PANEL_H, 10); ctx.stroke();

    const leftX  = px + PAD;
    const leftY  = py + PAD;
    const rightX = px + PAD + CARD_W + MID_W;
    const rightY = py + PAD;
    const midX   = px + PAD + CARD_W;
    const cardH  = PANEL_H - PAD * 2;

    // ── Left card (player) ────────────────────────────────────────────────────
    ctx.fillStyle = BG_CARD;
    _rr(ctx, leftX, leftY, CARD_W, cardH, 6); ctx.fill();
    ctx.fillStyle = TEXT_HEAD; ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Your Resources', leftX + CARD_W / 2, leftY + 18);

    // ── Right card (chest) ────────────────────────────────────────────────────
    ctx.fillStyle = BG_CARD;
    _rr(ctx, rightX, rightY, CARD_W, cardH, 6); ctx.fill();
    ctx.fillStyle = TEXT_HEAD; ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Chest Storage', rightX + CARD_W / 2, rightY + 18);

    // ── Middle strip ──────────────────────────────────────────────────────────
    ctx.fillStyle = BG_MID;
    ctx.fillRect(midX, leftY, MID_W, cardH);

    // ── Resource rows ─────────────────────────────────────────────────────────
    this._arrowHits = [];
    const rowStartY = py + PAD + HDR_H - 6;

    RESOURCES.forEach((res, i) => {
      const ry      = rowStartY + i * ROW_H;
      const arrowY  = ry + ROW_H / 2;
      const arrowCX = midX + MID_W / 2;
      const ABTN_W  = 42, ABTN_H = 24;

      const playerQty = this._playerRes[res.key as string] ?? 0;
      const chestQty  = this._chestData ? (this._chestData as any)[res.key] as number ?? 0 : 0;

      // Row separators
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(leftX  + 8, ry); ctx.lineTo(leftX  + CARD_W - 8, ry); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rightX + 8, ry); ctx.lineTo(rightX + CARD_W - 8, ry); ctx.stroke();

      // Left row (player) and right row (chest)
      this._drawRow(ctx, leftX  + 10, arrowY, res, playerQty, 'left');
      this._drawRow(ctx, rightX + 10, arrowY, res, chestQty,  'right', CHEST_MAX);

      // Arrow buttons
      const depHit = { x: arrowCX - ABTN_W - 2, y: arrowY - ABTN_H / 2, w: ABTN_W, h: ABTN_H };
      const witHit = { x: arrowCX + 2,           y: arrowY - ABTN_H / 2, w: ABTN_W, h: ABTN_H };
      this._arrowHits.push({ dep: depHit, wit: witHit });

      const isDepHov = this._hover?.row === i && this._hover.arrowDir === 'dep';
      const isWitHov = this._hover?.row === i && this._hover.arrowDir === 'wit';

      ctx.fillStyle = isDepHov ? BTN_HOVER : BTN_BG;
      _rr(ctx, depHit.x, depHit.y, depHit.w, depHit.h, 4); ctx.fill();
      ctx.strokeStyle = BTN_BORDER; ctx.lineWidth = 1;
      _rr(ctx, depHit.x, depHit.y, depHit.w, depHit.h, 4); ctx.stroke();
      ctx.fillStyle = TEXT_HEAD; ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('→', depHit.x + depHit.w / 2, arrowY);

      ctx.fillStyle = isWitHov ? BTN_HOVER : BTN_BG;
      _rr(ctx, witHit.x, witHit.y, witHit.w, witHit.h, 4); ctx.fill();
      ctx.strokeStyle = BTN_BORDER; ctx.lineWidth = 1;
      _rr(ctx, witHit.x, witHit.y, witHit.w, witHit.h, 4); ctx.stroke();
      ctx.fillStyle = TEXT_HEAD; ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('←', witHit.x + witHit.w / 2, arrowY);
    });

    // ── Header title (drawn over cards so it's always visible) ───────────────
    this._drawChestIcon(ctx, px + 20, py + HDR_H / 2, 12);
    ctx.fillStyle = TEXT_HEAD; ctx.font = 'bold 15px Georgia, serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('Resource Chest', px + 36, py + HDR_H / 2);

    // ── Close button ──────────────────────────────────────────────────────────
    const cBtnX = px + PANEL_W - 32, cBtnY = py + 8;
    const cBtnW = 24, cBtnH = 24;
    this._closeHit = { x: cBtnX, y: cBtnY, w: cBtnW, h: cBtnH };
    ctx.fillStyle = 'rgba(200,80,60,0.2)';
    _rr(ctx, cBtnX, cBtnY, cBtnW, cBtnH, 4); ctx.fill();
    ctx.strokeStyle = '#c04040'; ctx.lineWidth = 1;
    _rr(ctx, cBtnX, cBtnY, cBtnW, cBtnH, 4); ctx.stroke();
    ctx.fillStyle = '#ff8880'; ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('×', cBtnX + cBtnW / 2, cBtnY + cBtnH / 2);

    ctx.restore();

    if (this._dialog) this._renderDialog(ctx, cw, ch);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _drawRow(
    ctx: CanvasRenderingContext2D,
    x: number, cy: number,
    res: typeof RESOURCES[0],
    qty: number,
    side: 'left' | 'right',
    max?: number,
  ): void {
    ctx.fillStyle   = res.color;
    ctx.strokeStyle = res.border;
    ctx.lineWidth   = 1;
    ctx.fillRect(x, cy - 10, 20, 20);
    ctx.strokeRect(x, cy - 10, 20, 20);

    ctx.fillStyle    = TEXT_DIM;
    ctx.font         = '12px monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(res.label, x + 26, cy);

    if (side === 'left') {
      ctx.fillStyle = qty > 0 ? TEXT_MONO : TEXT_DIM;
      ctx.font      = 'bold 13px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(qty), x + CARD_W - 14, cy);
    } else {
      const frac = max !== undefined ? `${qty} / ${max}` : String(qty);
      ctx.fillStyle = (max !== undefined && qty >= max) ? '#ff8844' : TEXT_MONO;
      ctx.font      = 'bold 12px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(frac, x + CARD_W - 14, cy);
    }
  }

  private _drawChestIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    const w = r * 2, h = r * 1.5;
    const x = cx - r, y = cy - h / 2;
    ctx.fillStyle   = '#7a4820';
    ctx.strokeStyle = '#4a2810'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(x, y + h * 0.45, w, h * 0.55, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8b5a2a';
    ctx.beginPath(); ctx.roundRect(x, y, w, h * 0.50, [3, 3, 0, 0]); ctx.fill(); ctx.stroke();
    ctx.fillStyle   = '#c8a050';
    ctx.strokeStyle = '#806020'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(cx - 3, cy - 2, 6, 5, 1); ctx.fill(); ctx.stroke();
  }

  // ── Quantity dialog ───────────────────────────────────────────────────────────

  private _openDialog(direction: 'deposit' | 'withdraw', item: keyof ChestModuleData, cw: number, ch: number): void {
    this._closeDialog();
    const res      = RESOURCES.find(r => r.key === item)!;
    const playerQt = this._playerRes[item as string] ?? 0;
    const chestQt  = this._chestData ? (this._chestData as any)[item] as number ?? 0 : 0;
    const maxQty   = direction === 'deposit'
      ? Math.min(playerQt, CHEST_MAX - chestQt)
      : chestQt;
    if (maxQty <= 0) return;

    const DW = 320, DH = 200;
    const BTN_W = 90, BTN_H = 32;
    const dx = Math.round((cw - DW) / 2);
    const dy = Math.round((ch - DH) / 2);

    this._dialog = {
      direction, item,
      label: res.label, color: res.color,
      max: maxQty, amount: maxQty,
      typing: false, typingStr: String(maxQty),
      sliderDragging: false,
      trackX: dx + 24, trackY: dy + 110, trackW: DW - 48,
      amountHit:  { x: dx + DW / 2 - 40, y: dy + 36,              w: 80, h: 30 },
      confirmHit: { x: dx + DW / 2 - BTN_W - 8, y: dy + DH - BTN_H - 12, w: BTN_W, h: BTN_H },
      cancelHit:  { x: dx + DW / 2 + 8,          y: dy + DH - BTN_H - 12, w: BTN_W, h: BTN_H },
    };

    this._keyHandler = (e: KeyboardEvent) => {
      const d = this._dialog;
      if (!d) return;
      if (!d.typing) {
        if (e.key >= '0' && e.key <= '9') {
          d.typing = true; d.typingStr = e.key;
          d.amount = Math.min(d.max, parseInt(d.typingStr, 10) || 1);
          d.typingStr = String(d.amount);
        } else if (e.key === 'Enter') {
          if (d.amount > 0) {
            this.onTransfer?.({ moduleId: this._moduleId, shipId: this._shipId,
              item: d.item as string, quantity: d.amount, direction: d.direction });
          }
          this._closeDialog();
        } else if (e.key === 'Escape') {
          this._closeDialog();
        }
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (e.key >= '0' && e.key <= '9') {
        d.typingStr += e.key;
        const v = parseInt(d.typingStr, 10);
        d.amount = isNaN(v) ? 1 : Math.max(1, Math.min(d.max, v));
        if (!isNaN(v) && v > d.max) d.typingStr = String(d.max);
      } else if (e.key === 'Backspace') {
        d.typingStr = d.typingStr.slice(0, -1);
        d.amount = d.typingStr === '' ? 1 : Math.max(1, Math.min(d.max, parseInt(d.typingStr, 10) || 1));
      } else if (e.key === 'Enter') {
        d.typing = false;
        if (d.amount > 0) {
          this.onTransfer?.({ moduleId: this._moduleId, shipId: this._shipId,
            item: d.item as string, quantity: d.amount, direction: d.direction });
        }
        this._closeDialog();
      } else if (e.key === 'Escape') {
        d.typing = false; d.typingStr = String(d.amount);
      }
      e.preventDefault(); e.stopPropagation();
    };
    document.addEventListener('keydown', this._keyHandler, true);
  }

  private _closeDialog(): void {
    this._dialog = null;
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler, true);
      this._keyHandler = null;
    }
  }

  private _renderDialog(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const d  = this._dialog!;
    const DW = 320, DH = 200;
    const BTN_W = 90, BTN_H = 32;
    const dx = Math.round((cw - DW) / 2);
    const dy = Math.round((ch - DH) / 2);

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(this._px, this._py, PANEL_W, PANEL_H);

    ctx.fillStyle = '#1c1208';
    _rr(ctx, dx, dy, DW, DH, 8); ctx.fill();
    ctx.strokeStyle = GOLD; ctx.lineWidth = 2;
    _rr(ctx, dx, dy, DW, DH, 8); ctx.stroke();

    const verb = d.direction === 'deposit' ? 'Deposit' : 'Withdraw';
    ctx.fillStyle = d.color; ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`${verb} ${d.label}`, dx + DW / 2, dy + 10);

    const ah = d.amountHit;
    ctx.fillStyle   = d.typing ? '#2a1a08' : '#2a2010';
    ctx.fillRect(ah.x, ah.y, ah.w, ah.h);
    ctx.strokeStyle = d.typing ? GOLD : TEXT_DIM; ctx.lineWidth = 1.5;
    ctx.strokeRect(ah.x, ah.y, ah.w, ah.h);
    ctx.fillStyle = TEXT_MONO; ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(d.amount), ah.x + ah.w / 2, ah.y + ah.h / 2);

    ctx.fillStyle = TEXT_DIM; ctx.font = '11px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`max ${d.max}`, dx + DW / 2, ah.y + ah.h + 4);

    const t = d.trackX, ty = d.trackY, tw = d.trackW;
    const fraction = d.max > 0 ? d.amount / d.max : 0;
    ctx.fillStyle = '#2a1a08'; ctx.fillRect(t, ty, tw, 8);
    ctx.fillStyle = d.color;   ctx.fillRect(t, ty, Math.round(fraction * tw), 8);
    ctx.strokeStyle = BTN_BORDER; ctx.lineWidth = 1; ctx.strokeRect(t, ty, tw, 8);
    const hx = t + Math.round(fraction * tw);
    ctx.fillStyle = '#f0d080';
    ctx.beginPath(); ctx.arc(hx, ty + 4, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#806030'; ctx.lineWidth = 1; ctx.stroke();

    const confirmHit = { x: dx + DW / 2 - BTN_W - 8, y: dy + DH - BTN_H - 12, w: BTN_W, h: BTN_H };
    const cancelHit  = { x: dx + DW / 2 + 8,          y: dy + DH - BTN_H - 12, w: BTN_W, h: BTN_H };
    this._drawDialogBtn(ctx, confirmHit, verb,     d.direction === 'deposit' ? '#3a7030' : '#3a4a80');
    this._drawDialogBtn(ctx, cancelHit,  'Cancel', '#5a2020');

    d.amountHit  = ah;
    d.confirmHit = confirmHit;
    d.cancelHit  = cancelHit;
    d.trackX = t; d.trackY = ty; d.trackW = tw;
  }

  private _drawDialogBtn(ctx: CanvasRenderingContext2D, hit: {x:number;y:number;w:number;h:number}, label: string, bg: string): void {
    ctx.fillStyle = bg;
    _rr(ctx, hit.x, hit.y, hit.w, hit.h, 5); ctx.fill();
    ctx.strokeStyle = BTN_BORDER; ctx.lineWidth = 1;
    _rr(ctx, hit.x, hit.y, hit.w, hit.h, 5); ctx.stroke();
    ctx.fillStyle = TEXT_HEAD; ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, hit.x + hit.w / 2, hit.y + hit.h / 2);
  }
}
