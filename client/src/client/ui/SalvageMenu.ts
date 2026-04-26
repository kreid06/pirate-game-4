/**
 * SalvageMenu.ts
 *
 * Wreck salvage panel. Opened when the player presses [E] on a shipwreck.
 * Shows the remaining loot slots in the wreck. Hover a row and hold [E]
 * for 600 ms to take one item. `onTakeItem` fires when the hold completes.
 */

// ── Layout ────────────────────────────────────────────────────────────────────

const PANEL_W  = 400;
const HEADER_H = 48;
const FOOTER_H = 32;
const ROW_H    = 48;
const PAD      = 16;
const MAX_ROWS = 8;

const BG_PANEL = 'rgba(10, 14, 18, 0.97)';
const BG_ROW   = 'rgba(255,255,255,0.03)';
const BG_HOVER = 'rgba(120,200,255,0.10)';
const BG_FILL  = 'rgba(80,160,220,0.30)';
const BORDER   = '#2a3545';
const GOLD     = '#c8d890';
const TEXT_H   = '#c0d0c0';
const TEXT_DIM = '#556655';

/** How long to hold [E] to take an item (ms). */
const HOLD_MS = 600;

// ── Class ─────────────────────────────────────────────────────────────────────

export class SalvageMenu {
  public visible    = false;

  private _wreckId   = 0;
  private _lootCount = 0;

  /** Fired when the player completes a hold. Server gives the next available item. */
  public onTakeItem: ((wreckId: number) => void) | null = null;

  // Layout
  private _panelX = 0;
  private _panelY = 0;

  // Mouse
  private _mouseX = 0;
  private _mouseY = 0;

  // Hold state
  private _holdRow:     number = -1;   // row index being held
  private _holdStart:   number = 0;
  private _holdProgress = 0;

  /** Open the menu for a specific wreck. */
  open(wreckId: number, lootCount: number): void {
    this._wreckId   = wreckId;
    this._lootCount = Math.max(0, lootCount);
    this.visible    = true;
    this._cancelHold();
  }

  /** Called after a successful salvage — decrement count. */
  onItemTaken(): void {
    this._lootCount = Math.max(0, this._lootCount - 1);
    this._cancelHold();
  }

  close():  void { this.visible = false; this._cancelHold(); }
  toggle(): void { if (this.visible) this.close(); else this.visible = true; }

  get wreckId():   number { return this._wreckId; }
  get lootCount(): number { return this._lootCount; }

  handleMouseMove(x: number, y: number): void {
    this._mouseX = x;
    this._mouseY = y;
  }

  /** Call on E keydown while the menu is visible. Returns true if consumed. */
  handleEKeyDown(): boolean {
    if (!this.visible) return false;
    const row = this._rowAt(this._mouseX, this._mouseY);
    if (row < 0) return true;   // consumed even with no row
    if (this._holdRow === row)  return true;
    this._holdRow     = row;
    this._holdStart   = performance.now();
    this._holdProgress = 0;
    return true;
  }

  /** Call on E keyup. Returns true if consumed. */
  handleEKeyUp(): boolean {
    if (!this.visible) return false;
    if (this._holdProgress >= 1 && this._lootCount > 0) {
      this.onTakeItem?.(this._wreckId);
    }
    this._cancelHold();
    return true;
  }

  /** Advance hold animation — call each frame while visible. */
  tick(): void {
    if (this._holdRow < 0) return;
    const elapsed = performance.now() - this._holdStart;
    this._holdProgress = Math.min(1, elapsed / HOLD_MS);
    if (this._holdProgress >= 1) {
      this.onTakeItem?.(this._wreckId);
      this._cancelHold();
    }
  }

  render(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    if (!this.visible) return;

    this.tick();

    const rows    = Math.max(0, this._lootCount);
    const isEmpty = rows === 0;
    const visRows = Math.max(1, Math.min(rows, MAX_ROWS));
    const panelH  = HEADER_H + visRows * ROW_H + FOOTER_H + 8;
    const px = Math.round((cw - PANEL_W) / 2);
    const py = Math.round((ch - panelH) / 2);
    this._panelX = px;
    this._panelY = py;

    ctx.save();

    // Panel
    ctx.fillStyle   = BG_PANEL;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, panelH, 4);
    ctx.fill();
    ctx.stroke();

    // Header bg
    ctx.fillStyle = 'rgba(40,80,100,0.20)';
    ctx.fillRect(px, py, PANEL_W, HEADER_H);

    // Header text
    ctx.font         = 'bold 15px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = GOLD;
    ctx.fillText('🪵  SHIPWRECK', px + PAD, py + HEADER_H / 2);

    ctx.font      = '11px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('[Esc] close', px + PANEL_W - PAD, py + HEADER_H / 2);

    // Header divider
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + HEADER_H);
    ctx.lineTo(px + PANEL_W, py + HEADER_H);
    ctx.stroke();

    // Content
    const clipY = py + HEADER_H;
    const clipH = panelH - HEADER_H - FOOTER_H - 8;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, clipY, PANEL_W, clipH);
    ctx.clip();

    if (isEmpty) {
      ctx.font         = '13px Consolas, monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = TEXT_DIM;
      ctx.fillText('Wreck is empty.', px + PANEL_W / 2, clipY + ROW_H / 2);
    } else {
      for (let i = 0; i < visRows; i++) {
        const ry      = clipY + i * ROW_H;
        const hovered = this._isRowHovered(i, ry);
        const holding = this._holdRow === i;

        // Row bg
        if (i % 2 === 1) {
          ctx.fillStyle = BG_ROW;
          ctx.fillRect(px + 1, ry, PANEL_W - 2, ROW_H);
        }
        if (hovered) {
          ctx.fillStyle = BG_HOVER;
          ctx.fillRect(px + 1, ry, PANEL_W - 2, ROW_H);
        }
        if (holding) {
          ctx.fillStyle = BG_FILL;
          ctx.fillRect(px + 1, ry, (PANEL_W - 2) * this._holdProgress, ROW_H);
        }

        // Chest icon
        ctx.font         = '20px serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = hovered ? '#fff' : TEXT_H;
        ctx.fillText('📦', px + PAD + 12, ry + ROW_H / 2);

        // Label
        ctx.font         = '13px Consolas, monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = hovered ? GOLD : TEXT_H;
        ctx.fillText('Loot Item', px + PAD + 34, ry + ROW_H / 2 - 7);
        ctx.font      = '11px Consolas, monospace';
        ctx.fillStyle = TEXT_DIM;
        ctx.fillText(`slot ${i + 1} of ${rows}`, px + PAD + 34, ry + ROW_H / 2 + 8);

        // Arrow hint
        if (hovered) {
          ctx.font         = '11px Consolas, monospace';
          ctx.textAlign    = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = GOLD;
          ctx.fillText(holding ? 'releasing…' : 'hold [E]', px + PANEL_W - PAD, ry + ROW_H / 2);
        }

        // Divider
        ctx.strokeStyle = BORDER;
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        ctx.moveTo(px + PAD, ry + ROW_H - 0.5);
        ctx.lineTo(px + PANEL_W - PAD, ry + ROW_H - 0.5);
        ctx.stroke();
      }
    }

    ctx.restore(); // clip

    // Footer
    const fy = py + panelH - FOOTER_H;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px, fy);
    ctx.lineTo(px + PANEL_W, fy);
    ctx.stroke();

    ctx.font         = '11px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_DIM;
    const footerText = isEmpty
      ? 'No loot remaining'
      : `${rows} item${rows === 1 ? '' : 's'} remaining — hover and hold [E] to take`;
    ctx.fillText(footerText, px + PANEL_W / 2, fy + FOOTER_H / 2);

    ctx.restore();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _isRowHovered(i: number, rowY: number): boolean {
    return this._mouseX >= this._panelX
        && this._mouseX <  this._panelX + PANEL_W
        && this._mouseY >= rowY
        && this._mouseY <  rowY + ROW_H;
  }

  private _rowAt(x: number, y: number): number {
    if (x < this._panelX || x >= this._panelX + PANEL_W) return -1;
    const clipY = this._panelY + HEADER_H;
    const rel   = y - clipY;
    if (rel < 0) return -1;
    const idx = Math.floor(rel / ROW_H);
    if (idx < 0 || idx >= Math.min(this._lootCount, MAX_ROWS)) return -1;
    return idx;
  }

  private _cancelHold(): void {
    this._holdRow      = -1;
    this._holdProgress = 0;
  }
}
