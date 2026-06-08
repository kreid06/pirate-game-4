/**
 * LandChestMenu.ts
 *
 * Canvas-drawn GUI for land chest interaction.
 * Layout:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Your Resources      ⟵  ⟶      Chest Storage  [×]      │
 *   │  Wood        120    ←→   0 / 8192                       │
 *   │  Fiber        30    ←→   0 / 8192                       │
 *   │  Metal         5    ←→   0 / 8192                       │
 *   │  Stone        20    ←→   0 / 8192                       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Clicking a resource row on either side opens a quantity dialog.
 * Dragging from one side to the other (left→deposit, right→withdraw) also
 * opens the quantity dialog on release.
 */

// ── Layout constants ─────────────────────────────────────────────────────────
const PANEL_W   = 580;
const PANEL_H   = 280;
const HDR_H     = 44;
const ROW_H     = 52;
const CARD_W    = 220;
const MID_W     = 100;
const PAD       = 16;

const RESOURCES: Array<{ key: 'wood' | 'fiber' | 'metal' | 'stone'; label: string; color: string; border: string; symbol: string }> = [
  { key: 'wood',  label: 'Wood',  color: '#8b5e2a', border: '#5c3a10', symbol: '🪵' },
  { key: 'fiber', label: 'Fiber', color: '#c8a46e', border: '#8a6030', symbol: '🌿' },
  { key: 'metal', label: 'Metal', color: '#8a8a8c', border: '#555558', symbol: '⚙' },
  { key: 'stone', label: 'Stone', color: '#9a9a9c', border: '#666668', symbol: '🪨' },
];

const CHEST_MAX = 8192;

// ── Colour palette ────────────────────────────────────────────────────────────
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

interface ChestResources { wood: number; fiber: number; metal: number; stone: number }

// ── Quantity dialog ───────────────────────────────────────────────────────────
interface QuantityDialog {
  direction: 'deposit' | 'withdraw' | 'drop';
  fromSide?: 'player' | 'chest'; // set when direction === 'drop'
  item: 'wood' | 'fiber' | 'metal' | 'stone';
  label: string;
  color: string;
  max: number;
  amount: number;
  typing: boolean;
  typingStr: string;
  sliderDragging: boolean;
  // Hit regions (absolute canvas coords, recomputed each render)
  trackX: number; trackY: number; trackW: number;
  amountHit: { x: number; y: number; w: number; h: number };
  confirmHit: { x: number; y: number; w: number; h: number };
  cancelHit:  { x: number; y: number; w: number; h: number };
}

// ── Drag state ────────────────────────────────────────────────────────────────
interface DragState {
  side: 'left' | 'right';
  item: 'wood' | 'fiber' | 'metal' | 'stone';
  rowIndex: number;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  active: boolean; // true once cursor left the source row
}

export class LandChestMenu {
  visible = false;

  /** Structure ID of the open chest. */
  private _structureId = 0;
  /** Live chest resources (updated when server sends land_chest_state). */
  private _chest: ChestResources = { wood: 0, fiber: 0, metal: 0, stone: 0 };
  /** Player pack resources (updated from worldState each frame). */
  private _player: ChestResources = { wood: 0, fiber: 0, metal: 0, stone: 0 };

  /** Panel top-left in canvas coords (computed each render). */
  private _px = 0;
  private _py = 0;

  /** Hit regions for each resource row — left and right cards. */
  private _leftRowHits:  Array<{ x: number; y: number; w: number; h: number }> = [];
  private _rightRowHits: Array<{ x: number; y: number; w: number; h: number }> = [];

  /** Close button hit region. */
  private _closeHit = { x: 0, y: 0, w: 0, h: 0 };

  /** Arrow button hit regions: [{deposit, withdraw}] per resource row. */
  private _arrowHits: Array<{ dep: { x: number; y: number; w: number; h: number }; wit: { x: number; y: number; w: number; h: number } }> = [];

  /** Current open quantity dialog, or null. */
  private _dialog: QuantityDialog | null = null;
  /** Keyboard handler while dialog is open. */
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

  /** Drag-and-drop state. */
  private _drag: DragState | null = null;

  /** When true, this is a chest-ruin wreck — deposits are disabled. */
  private _readOnly = false;

  /** Hovered row: { side, row } or null. */
  private _hover: { side: 'left' | 'right' | 'arrow'; row: number; arrowDir?: 'dep' | 'wit' } | null = null;

  /**
   * Called when the player confirms a transfer.
   * Wire up to networkManager.sendLandChestTransfer().
   */
  public onTransfer: ((structureId: number, item: string, quantity: number, direction: 'deposit' | 'withdraw') => void) | null = null;
  /** Called when the player drops/throws resources on the ground from either inventory. */
  public onDrop: ((structureId: number, item: string, quantity: number, fromSide: 'player' | 'chest') => void) | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  open(structureId: number, chestResources: ChestResources, readOnly = false): void {
    this._structureId = structureId;
    this._chest = { ...chestResources };
    this._readOnly = readOnly;
    this.visible = true;
    this._dialog = null;
    this._drag = null;
  }

  setReadOnly(readOnly: boolean): void {
    this._readOnly = readOnly;
  }

  close(): void {
    this.visible = false;
    this._closeDialog();
    this._drag = null;
  }

  updateChestResources(res: ChestResources): void {
    this._chest = { ...res };
  }

  updatePlayerResources(res: ChestResources): void {
    this._player = { ...res };
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  render(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    if (!this.visible) return;

    const px = Math.round((cw - PANEL_W) / 2);
    const py = Math.round((ch - PANEL_H) / 2);
    this._px = px;
    this._py = py;

    // ── Panel background ──────────────────────────────────────────────────────
    ctx.save();
    ctx.fillStyle = BG_PANEL;
    _roundRect(ctx, px, py, PANEL_W, PANEL_H, 10);
    ctx.fill();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2;
    _roundRect(ctx, px, py, PANEL_W, PANEL_H, 10);
    ctx.stroke();

    // ── Left card ─────────────────────────────────────────────────────────────
    const leftX = px + PAD;
    const leftY = py + PAD;
    ctx.fillStyle = BG_CARD;
    _roundRect(ctx, leftX, leftY, CARD_W, PANEL_H - PAD * 2, 6);
    ctx.fill();

    // Left header
    ctx.fillStyle = TEXT_HEAD;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Your Resources', leftX + CARD_W / 2, leftY + 18);

    // ── Right card ────────────────────────────────────────────────────────────
    const rightX = px + PAD + CARD_W + MID_W;
    const rightY = py + PAD;
    ctx.fillStyle = BG_CARD;
    _roundRect(ctx, rightX, rightY, CARD_W, PANEL_H - PAD * 2, 6);
    ctx.fill();

    // Right header
    ctx.fillStyle = TEXT_HEAD;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(this._readOnly ? 'Chest Ruin' : 'Chest Storage', rightX + CARD_W / 2, rightY + 18);
    if (this._readOnly) {
      ctx.fillStyle = '#ff8844';
      ctx.font = '10px monospace';
      ctx.fillText('(withdraw only)', rightX + CARD_W / 2, rightY + 32);
    }

    // ── Middle strip ──────────────────────────────────────────────────────────
    const midX = px + PAD + CARD_W;
    const midY = py + PAD;
    ctx.fillStyle = BG_MID;
    ctx.fillRect(midX, midY, MID_W, PANEL_H - PAD * 2);

    // ── Resource rows ─────────────────────────────────────────────────────────
    this._leftRowHits  = [];
    this._rightRowHits = [];
    this._arrowHits    = [];

    const rowStartY = py + PAD + HDR_H - 8;

    RESOURCES.forEach((res, i) => {
      const ry = rowStartY + i * ROW_H;

      // Left row hit
      const lhit = { x: leftX + 4, y: ry, w: CARD_W - 8, h: ROW_H - 4 };
      this._leftRowHits.push(lhit);
      // Right row hit
      const rhit = { x: rightX + 4, y: ry, w: CARD_W - 8, h: ROW_H - 4 };
      this._rightRowHits.push(rhit);

      // Hover highlights
      const isLeftHover  = this._hover?.side === 'left'  && this._hover.row === i;
      const isRightHover = this._hover?.side === 'right' && this._hover.row === i;

      // Left row background
      if (isLeftHover) {
        ctx.fillStyle = 'rgba(200,160,80,0.12)';
        _roundRect(ctx, lhit.x, lhit.y, lhit.w, lhit.h, 4);
        ctx.fill();
      }
      // Right row background
      if (isRightHover) {
        ctx.fillStyle = 'rgba(200,160,80,0.12)';
        _roundRect(ctx, rhit.x, rhit.y, rhit.w, rhit.h, 4);
        ctx.fill();
      }

      // Left row: colour swatch + label + quantity
      const playerQty = this._player[res.key];
      this._drawResourceRow(ctx, lhit.x + 6, ry + ROW_H / 2, res, playerQty, 'left');

      // Right row: quantity / max
      const chestQty = this._chest[res.key];
      this._drawResourceRow(ctx, rhit.x + 6, ry + ROW_H / 2, res, chestQty, 'right', CHEST_MAX);

      // Middle arrows ⟵ ⟶ (two arrow buttons per row)
      const arrowY = ry + ROW_H / 2;
      const arrowCX = midX + MID_W / 2;
      const ABTN_W = 34, ABTN_H = 24;
      // Deposit → arrow (player → chest) button
      const depHit  = { x: arrowCX - ABTN_W - 2, y: arrowY - ABTN_H / 2, w: ABTN_W, h: ABTN_H };
      // Withdraw ← arrow (chest → player) button
      const witHit  = { x: arrowCX + 2,           y: arrowY - ABTN_H / 2, w: ABTN_W, h: ABTN_H };
      this._arrowHits.push({ dep: depHit, wit: witHit });

      const isDepHov = this._hover?.side === 'arrow' && this._hover.row === i && this._hover.arrowDir === 'dep';
      const isWitHov = this._hover?.side === 'arrow' && this._hover.row === i && this._hover.arrowDir === 'wit';

      // Deposit arrow button (→)
      ctx.fillStyle = isDepHov ? BTN_HOVER : BTN_BG;
      _roundRect(ctx, depHit.x, depHit.y, depHit.w, depHit.h, 4);
      ctx.fill();
      ctx.strokeStyle = BTN_BORDER;
      ctx.lineWidth = 1;
      _roundRect(ctx, depHit.x, depHit.y, depHit.w, depHit.h, 4);
      ctx.stroke();
      ctx.fillStyle = TEXT_HEAD;
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('→', depHit.x + depHit.w / 2, arrowY);

      // Withdraw arrow button (←)
      ctx.fillStyle = isWitHov ? BTN_HOVER : BTN_BG;
      _roundRect(ctx, witHit.x, witHit.y, witHit.w, witHit.h, 4);
      ctx.fill();
      _roundRect(ctx, witHit.x, witHit.y, witHit.w, witHit.h, 4);
      ctx.stroke();
      ctx.fillStyle = TEXT_HEAD;
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('←', witHit.x + witHit.w / 2, arrowY);
    });

    // ── Close button ──────────────────────────────────────────────────────────
    const cBtnX = px + PANEL_W - 32;
    const cBtnY = py + 8;
    const cBtnW = 24, cBtnH = 24;
    this._closeHit = { x: cBtnX, y: cBtnY, w: cBtnW, h: cBtnH };
    ctx.fillStyle = 'rgba(200,80,60,0.2)';
    _roundRect(ctx, cBtnX, cBtnY, cBtnW, cBtnH, 4);
    ctx.fill();
    ctx.strokeStyle = '#c04040';
    ctx.lineWidth = 1;
    _roundRect(ctx, cBtnX, cBtnY, cBtnW, cBtnH, 4);
    ctx.stroke();
    ctx.fillStyle = '#ff8880';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', cBtnX + cBtnW / 2, cBtnY + cBtnH / 2);

    // ── Drag: target-card highlight + outside drop zone ────────────────────────
    if (this._drag?.active) {
      const d = this._drag;
      const outside = d.curX < px || d.curX > px + PANEL_W || d.curY < py || d.curY > py + PANEL_H;
      if (!outside) {
        // Highlight the card the user is hovering over (the receive side)
        const hx = d.side === 'left' ? rightX : leftX;
        const hy = d.side === 'left' ? rightY : leftY;
        ctx.fillStyle = 'rgba(80,200,80,0.10)';
        _roundRect(ctx, hx, hy, CARD_W, PANEL_H - PAD * 2, 6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(80,200,80,0.55)';
        ctx.lineWidth = 2;
        _roundRect(ctx, hx, hy, CARD_W, PANEL_H - PAD * 2, 6);
        ctx.stroke();
      } else {
        // Show a red drop zone below the panel
        const dzX = px + PANEL_W / 2 - 52;
        const dzY = py + PANEL_H + 10;
        ctx.fillStyle = 'rgba(180,40,40,0.75)';
        _roundRect(ctx, dzX, dzY, 104, 34, 6);
        ctx.fill();
        ctx.strokeStyle = '#e06060';
        ctx.lineWidth = 1.5;
        _roundRect(ctx, dzX, dzY, 104, 34, 6);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Drop on Ground', dzX + 52, dzY + 17);
      }
    }

    // ── Drag ghost ────────────────────────────────────────────────────────────
    if (this._drag?.active) {
      const d = this._drag;
      const res = RESOURCES[d.rowIndex];
      const outside = d.curX < px || d.curX > px + PANEL_W || d.curY < py || d.curY > py + PANEL_H;
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = outside ? '#9a2020' : res.color;
      _roundRect(ctx, d.curX - 36, d.curY - 14, 72, 28, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(outside ? `🗑 ${res.label}` : res.label, d.curX, d.curY);
    }

    ctx.restore();

    // ── Quantity dialog (rendered last, on top) ────────────────────────────────
    if (this._dialog) this._renderDialog(ctx, cw, ch);
  }

  private _drawResourceRow(
    ctx: CanvasRenderingContext2D,
    x: number, cy: number,
    res: typeof RESOURCES[0],
    qty: number,
    side: 'left' | 'right',
    max?: number
  ): void {
    // Colour swatch
    ctx.fillStyle = res.color;
    ctx.strokeStyle = res.border;
    ctx.lineWidth = 1;
    ctx.fillRect(x, cy - 10, 20, 20);
    ctx.strokeRect(x, cy - 10, 20, 20);

    // Label
    ctx.fillStyle = TEXT_DIM;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(res.label, x + 26, cy);

    // Quantity (right-aligned inside card)
    if (side === 'left') {
      ctx.fillStyle = TEXT_MONO;
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(qty), x + CARD_W - 18, cy);
    } else {
      // "qty / max"
      const frac = max ? `${qty} / ${max}` : String(qty);
      ctx.fillStyle = qty >= CHEST_MAX ? '#ff8844' : TEXT_MONO;
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(frac, x + CARD_W - 18, cy);
    }
  }

  // ── Quantity dialog ───────────────────────────────────────────────────────────

  private _openDialog(direction: 'deposit' | 'withdraw' | 'drop', item: 'wood' | 'fiber' | 'metal' | 'stone', cw: number, ch: number, fromSide?: 'player' | 'chest'): void {
    this._closeDialog();
    const res    = RESOURCES.find(r => r.key === item)!;
    const maxQty = direction === 'deposit'
      ? Math.min(this._player[item], CHEST_MAX - this._chest[item])
      : direction === 'withdraw'
      ? this._chest[item]
      : (fromSide === 'chest' ? this._chest[item] : this._player[item]);
    if (maxQty <= 0) return;

    const DW = 320, DH = 200;
    const BTN_W = 90, BTN_H = 32;
    const dx = Math.round((cw - DW) / 2);
    const dy = Math.round((ch - DH) / 2);

    this._dialog = {
      direction, fromSide, item,
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
          d.typing = true;
          d.typingStr = e.key;
          d.amount = Math.min(d.max, parseInt(d.typingStr, 10) || 1);
          d.typingStr = String(d.amount);
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Enter') {
          if (d.amount > 0) {
            if (d.direction === 'drop') this.onDrop?.(this._structureId, d.item, d.amount, d.fromSide ?? 'player');
            else this.onTransfer?.(this._structureId, d.item, d.amount, d.direction);
          }
          this._closeDialog();
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Escape') {
          this._closeDialog();
          e.preventDefault(); e.stopPropagation();
        }
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
          if (d.direction === 'drop') this.onDrop?.(this._structureId, d.item, d.amount, d.fromSide ?? 'player');
          else this.onTransfer?.(this._structureId, d.item, d.amount, d.direction);
        }
        this._closeDialog();
      } else if (e.key === 'Escape') {
        d.typing = false;
        d.typingStr = String(d.amount);
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
    const d = this._dialog!;
    const DW = 320, DH = 200;
    const dx = Math.round((cw - DW) / 2);
    const dy = Math.round((ch - DH) / 2);

    // Dim overlay over chest panel
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(this._px, this._py, PANEL_W, PANEL_H);

    // Dialog box
    ctx.fillStyle = '#1c1208';
    _roundRect(ctx, dx, dy, DW, DH, 8);
    ctx.fill();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2;
    _roundRect(ctx, dx, dy, DW, DH, 8);
    ctx.stroke();

    // Title
    const verb = d.direction === 'deposit' ? 'Deposit' : d.direction === 'withdraw' ? 'Withdraw' : 'Drop on Ground';
    ctx.fillStyle = d.direction === 'drop' ? '#c04040' : d.color;
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${verb} ${d.label}`, dx + DW / 2, dy + 10);

    // Amount display
    const ah = d.amountHit;
    ctx.fillStyle = d.typing ? '#2a1a08' : '#2a2010';
    ctx.fillRect(ah.x, ah.y, ah.w, ah.h);
    ctx.strokeStyle = d.typing ? GOLD : TEXT_DIM;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ah.x, ah.y, ah.w, ah.h);
    ctx.fillStyle = TEXT_MONO;
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(d.amount), ah.x + ah.w / 2, ah.y + ah.h / 2);

    ctx.fillStyle = TEXT_DIM;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`max ${d.max}`, dx + DW / 2, ah.y + ah.h + 4);

    // Slider track
    const t = d.trackX, ty = d.trackY, tw = d.trackW;
    const fraction = d.max > 0 ? d.amount / d.max : 0;
    ctx.fillStyle = '#2a1a08';
    ctx.fillRect(t, ty, tw, 8);
    ctx.fillStyle = d.color;
    ctx.fillRect(t, ty, Math.round(fraction * tw), 8);
    ctx.strokeStyle = BTN_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(t, ty, tw, 8);
    // Handle
    const hx = t + Math.round(fraction * tw);
    ctx.fillStyle = '#f0d080';
    ctx.beginPath();
    ctx.arc(hx, ty + 4, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#806030';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Buttons
    const confirmLabel = d.direction === 'deposit' ? 'Deposit' : d.direction === 'withdraw' ? 'Withdraw' : 'Drop';
    const confirmBg    = d.direction === 'drop' ? '#6a2020' : '#3a7030';
    const confirmHov   = d.direction === 'drop' ? '#8a3030' : '#4a9040';
    this._drawDialogBtn(ctx, d.confirmHit, confirmLabel, confirmBg, confirmHov);
    this._drawDialogBtn(ctx, d.cancelHit, 'Cancel', '#5a2020', '#7a3030');

    // Update hit region positions
    d.amountHit  = { x: dx + DW / 2 - 40, y: dy + 36,              w: 80, h: 30 };
    d.confirmHit = { x: dx + DW / 2 - 92, y: dy + DH - 44, w: 90, h: 32 };
    d.cancelHit  = { x: dx + DW / 2 + 8,  y: dy + DH - 44, w: 90, h: 32 };
    d.trackX = t; d.trackY = ty; d.trackW = tw;
  }

  private _drawDialogBtn(ctx: CanvasRenderingContext2D, hit: { x: number; y: number; w: number; h: number }, label: string, bg: string, bgHov: string): void {
    ctx.fillStyle = bg;
    _roundRect(ctx, hit.x, hit.y, hit.w, hit.h, 5);
    ctx.fill();
    ctx.strokeStyle = BTN_BORDER;
    ctx.lineWidth = 1;
    _roundRect(ctx, hit.x, hit.y, hit.w, hit.h, 5);
    ctx.stroke();
    ctx.fillStyle = TEXT_HEAD;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, hit.x + hit.w / 2, hit.y + hit.h / 2);
  }

  // ── Input handling ────────────────────────────────────────────────────────────

  /**
   * Returns true if the click was consumed (inside panel or dialog).
   */
  handleClick(x: number, y: number, cw: number, ch: number): boolean {
    if (!this.visible) return false;

    // Dialog takes priority
    if (this._dialog) {
      const d = this._dialog;
      if (_inHit(x, y, d.amountHit)) {
        d.typing = true; d.typingStr = ''; return true;
      }
      if (_inHit(x, y, d.confirmHit)) {
        if (d.amount > 0) {
          if (d.direction === 'drop') this.onDrop?.(this._structureId, d.item, d.amount, d.fromSide ?? 'player');
          else this.onTransfer?.(this._structureId, d.item, d.amount, d.direction);
        }
        this._closeDialog(); return true;
      }
      if (_inHit(x, y, d.cancelHit)) { this._closeDialog(); return true; }
      // Slider click
      if (x >= d.trackX && x <= d.trackX + d.trackW &&
          y >= d.trackY - 8 && y <= d.trackY + 16) {
        const frac = Math.max(0, Math.min(1, (x - d.trackX) / d.trackW));
        d.amount = Math.max(1, Math.min(d.max, Math.round(frac * d.max)));
        d.typingStr = String(d.amount);
        return true;
      }
      return true; // consume all clicks while dialog open
    }

    // Close button
    if (_inHit(x, y, this._closeHit)) { this.close(); return true; }

    // Arrow buttons
    for (let i = 0; i < this._arrowHits.length; i++) {
      const ah = this._arrowHits[i];
      if (_inHit(x, y, ah.dep)) {
        if (!this._readOnly) this._openDialog('deposit',  RESOURCES[i].key, cw, ch);
        return true;
      }
      if (_inHit(x, y, ah.wit)) {
        this._openDialog('withdraw', RESOURCES[i].key, cw, ch);
        return true;
      }
    }

    // Left card rows → deposit
    for (let i = 0; i < this._leftRowHits.length; i++) {
      if (_inHit(x, y, this._leftRowHits[i])) {
        if (!this._readOnly) this._openDialog('deposit', RESOURCES[i].key, cw, ch);
        return true;
      }
    }

    // Right card rows → withdraw
    for (let i = 0; i < this._rightRowHits.length; i++) {
      if (_inHit(x, y, this._rightRowHits[i])) {
        this._openDialog('withdraw', RESOURCES[i].key, cw, ch);
        return true;
      }
    }

    // Outside panel → close
    if (x < this._px || x > this._px + PANEL_W || y < this._py || y > this._py + PANEL_H) {
      return false;
    }
    return true;
  }

  handleMouseMove(x: number, y: number): void {
    if (!this.visible) return;

    // Dialog slider drag
    if (this._dialog?.sliderDragging) {
      const d = this._dialog;
      const frac = Math.max(0, Math.min(1, (x - d.trackX) / d.trackW));
      d.amount = Math.max(1, Math.min(d.max, Math.round(frac * d.max)));
      d.typingStr = String(d.amount);
    }

    // Drag-and-drop ghost
    if (this._drag) {
      this._drag.curX = x;
      this._drag.curY = y;
      const d = this._drag;
      const srcHit = d.side === 'left' ? this._leftRowHits[d.rowIndex] : this._rightRowHits[d.rowIndex];
      if (srcHit && !_inHit(x, y, srcHit)) d.active = true;
    }

    // Hover detection
    this._hover = null;
    if (this._dialog) return;

    for (let i = 0; i < this._arrowHits.length; i++) {
      if (_inHit(x, y, this._arrowHits[i].dep)) { this._hover = { side: 'arrow', row: i, arrowDir: 'dep' }; return; }
      if (_inHit(x, y, this._arrowHits[i].wit)) { this._hover = { side: 'arrow', row: i, arrowDir: 'wit' }; return; }
    }
    for (let i = 0; i < this._leftRowHits.length; i++) {
      if (_inHit(x, y, this._leftRowHits[i])) { this._hover = { side: 'left', row: i }; return; }
    }
    for (let i = 0; i < this._rightRowHits.length; i++) {
      if (_inHit(x, y, this._rightRowHits[i])) { this._hover = { side: 'right', row: i }; return; }
    }
  }

  handleMouseDown(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (this._dialog) {
      if (this._dialog.sliderDragging) return true;
      const d = this._dialog;
      if (x >= d.trackX && x <= d.trackX + d.trackW && y >= d.trackY - 8 && y <= d.trackY + 16) {
        d.sliderDragging = true;
        const frac = Math.max(0, Math.min(1, (x - d.trackX) / d.trackW));
        d.amount = Math.max(1, Math.min(d.max, Math.round(frac * d.max)));
        d.typingStr = String(d.amount);
        return true;
      }
      return false;
    }

    // Start drag from left card
    for (let i = 0; i < this._leftRowHits.length; i++) {
      if (_inHit(x, y, this._leftRowHits[i])) {
        this._drag = { side: 'left', item: RESOURCES[i].key, rowIndex: i, startX: x, startY: y, curX: x, curY: y, active: false };
        return true;
      }
    }
    // Start drag from right card
    for (let i = 0; i < this._rightRowHits.length; i++) {
      if (_inHit(x, y, this._rightRowHits[i])) {
        this._drag = { side: 'right', item: RESOURCES[i].key, rowIndex: i, startX: x, startY: y, curX: x, curY: y, active: false };
        return true;
      }
    }
    return false;
  }

  handleMouseUp(x: number, y: number, cw: number, ch: number): void {
    if (!this.visible) return;

    if (this._dialog?.sliderDragging) {
      this._dialog.sliderDragging = false;
      return;
    }

    const drag = this._drag;
    this._drag = null;
    if (!drag || !drag.active) return;

    // Check if released on the opposite side
    if (drag.side === 'left') {
      if (!this._readOnly) {
        for (let i = 0; i < this._rightRowHits.length; i++) {
          if (_inHit(x, y, this._rightRowHits[i])) {
            this._openDialog('deposit', drag.item, cw, ch);
            return;
          }
        }
        // Also accept drop anywhere on the right card
        const rh = this._rightRowHits;
        if (rh.length > 0) {
          const cardLeft = rh[0].x; const cardRight = rh[0].x + rh[0].w;
          const cardTop  = rh[0].y; const cardBot  = rh[rh.length - 1].y + rh[rh.length - 1].h;
          if (x >= cardLeft && x <= cardRight && y >= cardTop && y <= cardBot) {
            this._openDialog('deposit', drag.item, cw, ch);
            return;
          }
        }
      }
    } else {
      for (let i = 0; i < this._leftRowHits.length; i++) {
        if (_inHit(x, y, this._leftRowHits[i])) {
          this._openDialog('withdraw', drag.item, cw, ch);
          return;
        }
      }
      // Also accept drop anywhere on the left card
      const lh = this._leftRowHits;
      if (lh.length > 0) {
        const cardLeft = lh[0].x; const cardRight = lh[0].x + lh[0].w;
        const cardTop  = lh[0].y; const cardBot  = lh[lh.length - 1].y + lh[lh.length - 1].h;
        if (x >= cardLeft && x <= cardRight && y >= cardTop && y <= cardBot) {
          this._openDialog('withdraw', drag.item, cw, ch);
          return;
        }
      }
    }
    // Released outside panel — throw out dialog
    const outsidePanel = x < this._px || x > this._px + PANEL_W || y < this._py || y > this._py + PANEL_H;
    if (outsidePanel) {
      const fromSide: 'player' | 'chest' = drag.side === 'left' ? 'player' : 'chest';
      this._openDialog('drop', drag.item, cw, ch, fromSide);
    }
  }

  /** Returns true if the event is over the panel (so callers can block world interactions). */
  isOver(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (this._dialog) return true;
    return x >= this._px && x <= this._px + PANEL_W && y >= this._py && y <= this._py + PANEL_H;
  }
}

// ── Utility helpers ───────────────────────────────────────────────────────────
function _roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function _inHit(x: number, y: number, h: { x: number; y: number; w: number; h: number }): boolean {
  return x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
}
