import { ITEM_DEFS, ITEM_ID_MAP, INVENTORY_SLOTS, ItemKind, PlayerInventory } from '../../sim/Inventory.js';

// ── Layout constants ──────────────────────────────────────────────────────────
const COLS      = 6;
const ISZ       = 52;   // item slot size px
const PAD       = 14;
const SCROLLBAR = 8;
// Each half: COLS*ISZ grid + PAD on each side + scrollbar
const HALF_W    = COLS * ISZ + PAD * 2 + SCROLLBAR;  // 344px
const PANEL_W   = HALF_W * 2;                          // 688px
const PANEL_H   = 520;
const HEADER_H  = 40;
const FOOTER_H  = 50;
const DIVIDER_X = HALF_W;  // centre divider

export class TombstoneMenu {
  public visible = false;

  /** Fired when the user drags a tombstone slot to the player side (or clicks Take). */
  public onTakeSlot: ((tombstoneId: number, slot: number) => void) | null = null;
  /** Fired when user clicks "Take All". */
  public onTakeAll: ((tombstoneId: number) => void) | null = null;
  /** Fired when menu closes. */
  public onClose: (() => void) | null = null;

  private _tombstoneId = 0;
  private _ownerName   = '';
  /** Flat array of [itemKind, quantity] — index == server slot index. */
  private _tombSlots: Array<[number, number]> = [];
  /** Player's live inventory. */
  private _playerInv: PlayerInventory | null = null;

  /** Anchor (top-left corner of panel in screen coords). */
  private _px = 0;
  private _py = 0;

  // Drag state
  private _dragSlot  = -1;   // tombstone slot index being dragged
  private _dragX     = 0;
  private _dragY     = 0;

  // Scroll
  private _scrollT   = 0;   // tombstone side scroll offset (px)
  private _scrollP   = 0;   // player side scroll offset (px)

  /** Call whenever the server sends tombstone_items. */
  open(tombstoneId: number, ownerName: string, slots: Array<[number, number]>): void {
    this._tombstoneId = tombstoneId;
    this._ownerName   = ownerName;
    this._tombSlots   = slots.slice();  // shallow copy
    this._dragSlot    = -1;
    this._scrollT     = 0;
    this._scrollP     = 0;
    this.visible      = true;
  }

  /** Refresh tombstone slots after a take_slot server ack. */
  refreshSlots(slots: Array<[number, number]>): void {
    this._tombSlots = slots.slice();
    this._dragSlot  = -1;
  }

  close(): void {
    this.visible   = false;
    this._dragSlot = -1;
    this.onClose?.();
  }

  setPlayerInventory(inv: PlayerInventory | null): void {
    this._playerInv = inv;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  handleMouseDown(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (!this._hitTest(x, y)) { this.close(); return true; }

    const local = this._toLocal(x, y);
    // Close button
    if (this._hitClose(local.x, local.y)) { this.close(); return true; }
    // Take All button
    if (this._hitTakeAll(local.x, local.y)) {
      this.onTakeAll?.(this._tombstoneId);
      this.close();
      return true;
    }
    // Tombstone slot → start drag
    const tSlot = this._tombSlotAt(local.x, local.y);
    if (tSlot !== -1 && this._tombSlots[tSlot]?.[0]) {
      this._dragSlot = tSlot;
      this._dragX    = x;
      this._dragY    = y;
    }
    return true;
  }

  handleMouseMove(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (this._dragSlot !== -1) { this._dragX = x; this._dragY = y; }
    return this._hitTest(x, y) || this._dragSlot !== -1;
  }

  handleMouseUp(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (this._dragSlot === -1) return this._hitTest(x, y);

    const slot = this._dragSlot;
    this._dragSlot = -1;

    const local = this._toLocal(x, y);
    // Released on player side (left) → take that slot
    if (local.x >= 0 && local.x < DIVIDER_X) {
      this.onTakeSlot?.(this._tombstoneId, slot);
      // Optimistic clear
      if (this._tombSlots[slot]) this._tombSlots[slot] = [0, 0];
    }
    return true;
  }

  handleWheel(x: number, y: number, deltaY: number): boolean {
    if (!this.visible) return false;
    const local = this._toLocal(x, y);
    if (!this._hitTest(x, y)) return false;
    if (local.x >= DIVIDER_X) {
      // Right side = tombstone
      this._scrollT = this._clampScroll(this._scrollT + deltaY * 0.5, this._tombSlots.length, true);
    } else {
      // Left side = player
      const pSlots = this._playerInv?.slots.length ?? 0;
      this._scrollP = this._clampScroll(this._scrollP + deltaY * 0.5, pSlots, false);
    }
    return true;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    this._px  = Math.round((cw - PANEL_W) / 2);
    this._py  = Math.round((ch - PANEL_H) / 2);

    ctx.save();

    // Dim overlay
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, ch);

    // Panel background
    ctx.fillStyle = 'rgba(12,16,26,0.97)';
    ctx.strokeStyle = '#c8a846';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(this._px, this._py, PANEL_W, PANEL_H, 6);
    ctx.fill();
    ctx.stroke();

    ctx.translate(this._px, this._py);

    this._drawHeader(ctx);
    this._drawDivider(ctx);
    this._drawPlayerPanel(ctx);
    this._drawTombstonePanel(ctx);
    this._drawFooter(ctx);

    ctx.restore();

    // Drag ghost (absolute coords)
    if (this._dragSlot !== -1) {
      this._drawDragGhost(ctx);
    }
  }

  // ── Private drawing ───────────────────────────────────────────────────────

  private _drawHeader(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = 'rgba(200,168,70,0.12)';
    ctx.fillRect(0, 0, PANEL_W, HEADER_H);

    // Player side title (left)
    ctx.fillStyle = '#e8e0cc';
    ctx.font = 'bold 13px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Your Inventory', PAD, HEADER_H / 2);

    // Tombstone side title (right)
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffe97a';
    ctx.fillText(`☠ ${this._ownerName}'s Items`, PANEL_W - PAD - 20, HEADER_H / 2);

    // Close button [X]
    const cx = PANEL_W - 10, cy = HEADER_H / 2;
    ctx.fillStyle = '#ff6666';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✕', cx, cy);
  }

  private _drawDivider(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = 'rgba(200,168,70,0.3)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(DIVIDER_X, HEADER_H);
    ctx.lineTo(DIVIDER_X, PANEL_H - FOOTER_H);
    ctx.stroke();
  }

  private _drawPlayerPanel(ctx: CanvasRenderingContext2D): void {
    const panelW  = HALF_W;
    const panelH  = PANEL_H - HEADER_H - FOOTER_H;
    const startY  = HEADER_H;
    const inv     = this._playerInv;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, startY, panelW, panelH);
    ctx.clip();

    if (!inv) {
      ctx.restore();
      return;
    }

    const offX  = PAD;
    const rows  = Math.ceil(INVENTORY_SLOTS / COLS);

    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const col  = i % COLS;
      const row  = Math.floor(i / COLS);
      const sx   = offX + col * ISZ;
      const sy   = startY + row * ISZ - this._scrollP;
      if (sy + ISZ < startY || sy > startY + panelH) continue;

      const slot = inv.slots[i];
      const itemKind: ItemKind = slot?.item ?? 'none';
      const qty  = slot?.quantity ?? 0;
      const kindNum = this._kindToNum(itemKind);
      this._drawSlot(ctx, sx, sy, kindNum, qty, false, true);
    }

    this._drawScrollbar(ctx, panelW - SCROLLBAR, startY, panelH, rows * ISZ, this._scrollP);
    ctx.restore();
  }

  private _drawTombstonePanel(ctx: CanvasRenderingContext2D): void {
    const panelX  = DIVIDER_X;
    const panelW  = HALF_W;
    const panelH  = PANEL_H - HEADER_H - FOOTER_H;
    const startY  = HEADER_H;

    ctx.save();
    ctx.beginPath();
    ctx.rect(panelX, startY, panelW, panelH);
    ctx.clip();

    const slots = this._tombSlots;
    const rows  = Math.ceil(INVENTORY_SLOTS / COLS);
    const offX  = panelX + PAD;

    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const sx  = offX + col * ISZ;
      const sy  = startY + row * ISZ - this._scrollT;
      if (sy + ISZ < startY || sy > startY + panelH) continue;

      const [kind, qty] = slots[i] ?? [0, 0];
      const isDragging  = i === this._dragSlot;
      this._drawSlot(ctx, sx, sy, kind, qty, isDragging);
    }

    // Scrollbar
    this._drawScrollbar(ctx, PANEL_W - SCROLLBAR, startY, panelH, rows * ISZ, this._scrollT);

    ctx.restore();
  }

  private _drawSlot(
    ctx: CanvasRenderingContext2D,
    sx: number, sy: number,
    kindNum: number, qty: number,
    faded = false, readonly = false
  ): void {
    const itemKind: ItemKind = ITEM_ID_MAP[kindNum] ?? 'none';
    const def = ITEM_DEFS[itemKind];
    const hasItem = itemKind !== 'none' && qty > 0;

    // Background
    ctx.fillStyle = readonly ? 'rgba(20,26,40,0.7)' : 'rgba(10,14,24,0.85)';
    ctx.strokeStyle = hasItem ? (def?.borderColor ?? '#444') : '#2a2a3a';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(sx + 2, sy + 2, ISZ - 4, ISZ - 4, 3);
    ctx.fill();
    ctx.stroke();

    if (!hasItem) return;

    ctx.globalAlpha = faded ? 0.3 : 1.0;

    // Colored background
    ctx.fillStyle = def?.color ?? '#444';
    ctx.beginPath();
    ctx.roundRect(sx + 2, sy + 2, ISZ - 4, ISZ - 4, 3);
    ctx.fill();

    // Symbol
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(ISZ * 0.38)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def?.symbol ?? '?', sx + ISZ / 2, sy + ISZ / 2 - 2);

    // Quantity badge
    if (qty > 1) {
      ctx.font = `bold 10px monospace`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(qty), sx + ISZ - 4, sy + ISZ - 2);
    }

    ctx.globalAlpha = 1.0;
  }

  private _drawDragGhost(ctx: CanvasRenderingContext2D): void {
    const [kind, qty] = this._tombSlots[this._dragSlot] ?? [0, 0];
    if (!kind || !qty) return;
    const itemKind: ItemKind = ITEM_ID_MAP[kind] ?? 'none';
    if (itemKind === 'none') return;
    const def = ITEM_DEFS[itemKind];
    const x   = this._dragX - ISZ / 2;
    const y   = this._dragY - ISZ / 2;

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = def?.color ?? '#444';
    ctx.strokeStyle = def?.borderColor ?? '#888';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, ISZ, ISZ, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(ISZ * 0.38)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def?.symbol ?? '?', x + ISZ / 2, y + ISZ / 2);
    ctx.restore();
  }

  private _drawFooter(ctx: CanvasRenderingContext2D): void {
    const fy = PANEL_H - FOOTER_H;
    ctx.fillStyle = 'rgba(200,168,70,0.08)';
    ctx.fillRect(0, fy, PANEL_W, FOOTER_H);

    // Hint text on the left (player) side
    ctx.fillStyle = '#778';
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('[Esc] Close  •  Drag items ←', PAD, fy + FOOTER_H / 2);

    // Take All button on the right (tombstone) side
    const btnW  = 120, btnH = 28;
    const btnX  = Math.round(DIVIDER_X + HALF_W / 2 - btnW / 2);
    const btnY  = fy + Math.round((FOOTER_H - btnH) / 2);
    ctx.fillStyle   = '#7a3a00';
    ctx.strokeStyle = '#c8a846';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffe97a';
    ctx.font = 'bold 12px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Take All', btnX + btnW / 2, btnY + btnH / 2);
  }

  private _drawScrollbar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, viewH: number, contentH: number, scroll: number
  ): void {
    if (contentH <= viewH) return;
    const sbH  = Math.max(20, (viewH / contentH) * viewH);
    const maxS = contentH - viewH;
    const sbY  = y + (scroll / Math.max(1, maxS)) * (viewH - sbH);
    ctx.fillStyle = 'rgba(200,168,70,0.3)';
    ctx.beginPath();
    ctx.roundRect(x, sbY, 4, sbH, 2);
    ctx.fill();
  }

  // ── Hit testing ───────────────────────────────────────────────────────────

  private _hitTest(x: number, y: number): boolean {
    return x >= this._px && x <= this._px + PANEL_W &&
           y >= this._py && y <= this._py + PANEL_H;
  }

  private _toLocal(x: number, y: number): { x: number; y: number } {
    return { x: x - this._px, y: y - this._py };
  }

  private _hitClose(lx: number, ly: number): boolean {
    const cx = PANEL_W - 10, cy = HEADER_H / 2;
    return Math.abs(lx - cx) <= 12 && Math.abs(ly - cy) <= 12;
  }

  private _hitTakeAll(lx: number, ly: number): boolean {
    const fy   = PANEL_H - FOOTER_H;
    const btnW = 120, btnH = 28;
    const btnX = Math.round(DIVIDER_X + HALF_W / 2 - btnW / 2);
    const btnY = fy + Math.round((FOOTER_H - btnH) / 2);
    return lx >= btnX && lx <= btnX + btnW && ly >= btnY && ly <= btnY + btnH;
  }

  private _tombSlotAt(lx: number, ly: number): number {
    const startY = HEADER_H;
    const panelH = PANEL_H - HEADER_H - FOOTER_H;
    // Tombstone is now on the RIGHT side
    if (lx < DIVIDER_X || lx > PANEL_W || ly < startY || ly > startY + panelH) return -1;
    const col    = Math.floor((lx - DIVIDER_X - PAD) / ISZ);
    const row    = Math.floor((ly - startY + this._scrollT) / ISZ);
    if (col < 0 || col >= COLS || row < 0) return -1;
    const idx = row * COLS + col;
    return idx < INVENTORY_SLOTS ? idx : -1;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _clampScroll(val: number, totalSlots: number, _isTomb: boolean): number {
    const panelH  = PANEL_H - HEADER_H - FOOTER_H;
    const rows    = Math.ceil(totalSlots / COLS);
    const maxS    = Math.max(0, rows * ISZ - panelH);
    return Math.max(0, Math.min(maxS, val));
  }

  private _kindToNum(kind: ItemKind): number {
    // Reverse lookup: ItemKind string → server numeric ID
    for (const [num, k] of Object.entries(ITEM_ID_MAP)) {
      if (k === kind) return Number(num);
    }
    return 0;
  }
}
