/**
 * ConfirmDialog.ts
 *
 * Generic canvas-drawn confirmation modal with a title, message, and
 * Confirm / Cancel buttons. Replaces window.confirm() calls.
 *
 * Usage:
 *   const dlg = new ConfirmDialog();
 *   dlg.open('Demolish lower deck?', 'This will destroy all modules on that deck.', () => doAction());
 *   // In render loop:
 *   dlg.render(ctx, canvas.width, canvas.height);
 *   // In click handler:
 *   if (dlg.handleClick(x, y)) return true;
 *   // In keydown handler:
 *   if (dlg.handleKey(e)) return true;
 */

// ── Palette (matches ShipMenu / ShipRenameDialog) ───────────────────────────
const BG_MODAL  = 'rgba(0,0,0,0.62)';
const BG_PANEL  = 'rgba(14, 18, 30, 0.99)';
const GOLD      = '#ffd700';
const BORDER    = '#334';
const TEXT_HEAD = '#e8e0cc';
const TEXT_DIM  = '#778';
const GREEN     = '#44cc66';
const RED       = '#ff5544';

const PW = 420;
const PH = 170;

export class ConfirmDialog {
  public visible = false;

  private _title   = '';
  private _message = '';
  private _onConfirm: (() => void) | null = null;

  private _confirmBtn: { x: number; y: number; w: number; h: number } | null = null;
  private _cancelBtn:  { x: number; y: number; w: number; h: number } | null = null;

  open(title: string, message: string, onConfirm: () => void): void {
    this._title     = title;
    this._message   = message;
    this._onConfirm = onConfirm;
    this.visible    = true;
  }

  close(): void {
    this.visible    = false;
    this._onConfirm = null;
  }

  /** Returns true if the click was consumed by this dialog. */
  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (this._confirmBtn) {
      const b = this._confirmBtn;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        const cb = this._onConfirm;
        this.close();
        cb?.();
        return true;
      }
    }
    if (this._cancelBtn) {
      const b = this._cancelBtn;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.close();
        return true;
      }
    }
    // Consume all clicks while the modal is open
    return true;
  }

  /** Returns true if the key event was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible) return false;
    if (e.key === 'Enter') {
      e.preventDefault();
      const cb = this._onConfirm;
      this.close();
      cb?.();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return true;
    }
    return true; // Swallow all keys while open
  }

  render(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    if (!this.visible) return;

    const px = Math.round((cw - PW) / 2);
    const py = Math.round((ch - PH) / 2);

    ctx.save();

    // Dim backdrop
    ctx.fillStyle = BG_MODAL;
    ctx.fillRect(0, 0, cw, ch);

    // Panel background + gold border
    ctx.fillStyle = BG_PANEL;
    ctx.fillRect(px, py, PW, PH);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px, py, PW, PH);

    // Title bar
    ctx.fillStyle = 'rgba(255,215,0,0.07)';
    ctx.fillRect(px, py, PW, 40);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + 40);
    ctx.lineTo(px + PW, py + 40);
    ctx.stroke();

    ctx.font = 'bold 15px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText(this._title, px + 16, py + 20);

    // Message body — wrap at ~50 chars per line
    const lines = this._wrapText(this._message, 50);
    ctx.font = '13px Georgia, serif';
    ctx.fillStyle = TEXT_HEAD;
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], px + 16, py + 52 + i * 20);
    }

    // Buttons
    const btnY  = py + PH - 46;
    const btnH  = 30;
    const btnW  = (PW - 48) / 2;
    const cancelX  = px + 16;
    const confirmX = px + 16 + btnW + 16;

    // Cancel button
    ctx.fillStyle = 'rgba(255,85,68,0.12)';
    ctx.fillRect(cancelX, btnY, btnW, btnH);
    ctx.strokeStyle = RED;
    ctx.lineWidth = 1;
    ctx.strokeRect(cancelX, btnY, btnW, btnH);
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff8877';
    ctx.fillText('✕  Cancel', cancelX + btnW / 2, btnY + btnH / 2);
    this._cancelBtn = { x: cancelX, y: btnY, w: btnW, h: btnH };

    // Confirm button
    ctx.fillStyle = 'rgba(68,204,102,0.12)';
    ctx.fillRect(confirmX, btnY, btnW, btnH);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1;
    ctx.strokeRect(confirmX, btnY, btnW, btnH);
    ctx.fillStyle = '#88ffaa';
    ctx.fillText('✓  Confirm', confirmX + btnW / 2, btnY + btnH / 2);
    this._confirmBtn = { x: confirmX, y: btnY, w: btnW, h: btnH };

    ctx.restore();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private _wrapText(text: string, maxChars: number): string[] {
    const words  = text.split(' ');
    const lines: string[] = [];
    let   line   = '';
    for (const word of words) {
      if ((line + ' ' + word).trimStart().length > maxChars && line.length > 0) {
        lines.push(line);
        line = word;
      } else {
        line = line ? line + ' ' + word : word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }
}
