/**
 * ShipRenameDialog.ts
 *
 * Custom canvas-drawn modal for renaming a ship.
 * An HTML <input> is overlaid on the canvas text field for native
 * keyboard/cursor behaviour. Replaces window.prompt() calls.
 *
 * Usage:
 *   const dlg = new ShipRenameDialog(canvas);
 *   dlg.onConfirm = (shipId, name) => sendRenameShip(shipId, name);
 *   dlg.open(shipId, currentName);
 *   // In render loop:
 *   dlg.render(ctx, canvas.width, canvas.height);
 *   // In click handler (onUIClick):
 *   if (dlg.handleClick(x, y)) return true;
 */

// ── Palette (matches ShipMenu) ───────────────────────────────────────────────
const BG_MODAL  = 'rgba(0,0,0,0.62)';
const BG_PANEL  = 'rgba(14, 18, 30, 0.99)';
const GOLD      = '#ffd700';
const BORDER    = '#334';
const TEXT_HEAD = '#e8e0cc';
const TEXT_DIM  = '#778';
const GREEN     = '#44cc66';
const RED       = '#ff5544';

const PW = 420;
const PH = 190;

export class ShipRenameDialog {
  public visible = false;
  /** Called when the player confirms a new name. */
  public onConfirm: ((shipId: number, name: string) => void) | null = null;

  private _shipId  = 0;
  private _inputEl: HTMLInputElement;

  // Cached geometry (set each render frame)
  private _px = 0;
  private _py = 0;
  private _confirmBtn: { x: number; y: number; w: number; h: number } | null = null;
  private _cancelBtn:  { x: number; y: number; w: number; h: number } | null = null;
  private _inputArea:  { x: number; y: number; w: number; h: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Create an absolutely-positioned HTML input element that lives over the canvas
    const inp = document.createElement('input');
    inp.type        = 'text';
    inp.maxLength   = 31;
    inp.placeholder = 'Enter ship name…';
    inp.style.cssText = [
      'position:fixed',
      'display:none',
      'box-sizing:border-box',
      'background:rgba(20,24,40,0.96)',
      'color:#e8e0cc',
      'border:1.5px solid #ffd700',
      'border-radius:3px',
      'font:15px Consolas,monospace',
      'padding:0 10px',
      'outline:none',
      'z-index:9999',
      'letter-spacing:0.04em',
    ].join(';');

    // Confirm on Enter, cancel on Escape
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      // Prevent game from receiving these keys while typing
      e.stopPropagation();
    });

    document.body.appendChild(inp);
    this._inputEl = inp;
  }

  open(shipId: number, currentName: string): void {
    this._shipId        = shipId;
    this._inputEl.value = currentName;
    this.visible        = true;
    this._positionInput();
    this._inputEl.style.display = 'block';
    // Focus after a microtask so the browser registers the display change
    setTimeout(() => { this._inputEl.focus(); this._inputEl.select(); }, 0);
  }

  close(): void {
    this.visible                = false;
    this._inputEl.style.display = 'none';
    this._inputEl.blur();
  }

  /** Returns true if the click was consumed. */
  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;

    if (this._confirmBtn) {
      const b = this._confirmBtn;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this._confirm();
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
    // Consume all clicks while modal is open
    return true;
  }

  render(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    if (!this.visible) return;

    const px = Math.round((cw - PW) / 2);
    const py = Math.round((ch - PH) / 2);
    this._px = px;
    this._py = py;

    ctx.save();

    // Dim backdrop
    ctx.fillStyle = BG_MODAL;
    ctx.fillRect(0, 0, cw, ch);

    // Panel background + border
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

    ctx.font = 'bold 16px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText('✏  RENAME SHIP', px + 16, py + 20);

    // Subtitle
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Type a new name then press Enter or click Confirm.', px + 16, py + 50);

    // Text field outline (the actual input sits on top of this)
    const fieldX = px + 16;
    const fieldY = py + 76;
    const fieldW = PW - 32;
    const fieldH = 32;
    this._inputArea = { x: fieldX, y: fieldY, w: fieldW, h: fieldH };

    ctx.fillStyle = 'rgba(20,24,40,0.96)';
    ctx.fillRect(fieldX, fieldY, fieldW, fieldH);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(fieldX, fieldY, fieldW, fieldH);

    // Buttons
    const btnY = py + PH - 46;
    const btnH = 30;
    const btnW = (PW - 48) / 2;

    const cancelX  = px + 16;
    const confirmX = px + 16 + btnW + 16;

    // Cancel
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

    // Confirm
    ctx.fillStyle = 'rgba(68,204,102,0.12)';
    ctx.fillRect(confirmX, btnY, btnW, btnH);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1;
    ctx.strokeRect(confirmX, btnY, btnW, btnH);
    ctx.fillStyle = '#88ffaa';
    ctx.fillText('✓  Confirm', confirmX + btnW / 2, btnY + btnH / 2);
    this._confirmBtn = { x: confirmX, y: btnY, w: btnW, h: btnH };

    ctx.restore();

    // Re-position the HTML input to stay aligned with the field
    this._positionInput();
  }

  /** Clean up the DOM element when the app is torn down. */
  destroy(): void {
    this._inputEl.remove();
  }

  // ── private ─────────────────────────────────────────────────────────────

  private _confirm(): void {
    const name = this._inputEl.value.trim().slice(0, 31);
    if (name.length > 0) {
      this.onConfirm?.(this._shipId, name);
    }
    this.close();
  }

  private _positionInput(): void {
    if (!this._inputArea) {
      // Dialog hasn't rendered yet — compute a provisional position
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = rect.width  / this.canvas.width;
      const scaleY = rect.height / this.canvas.height;
      const px = Math.round((this.canvas.width  - PW) / 2);
      const py = Math.round((this.canvas.height - PH) / 2);
      const fx = px + 16;
      const fy = py + 76;
      const fw = PW - 32;
      const fh = 32;
      this._inputEl.style.left   = `${rect.left + fx * scaleX}px`;
      this._inputEl.style.top    = `${rect.top  + fy * scaleY}px`;
      this._inputEl.style.width  = `${fw * scaleX}px`;
      this._inputEl.style.height = `${fh * scaleY}px`;
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width  / this.canvas.width;
    const scaleY = rect.height / this.canvas.height;
    const a = this._inputArea;
    this._inputEl.style.left   = `${rect.left + a.x * scaleX}px`;
    this._inputEl.style.top    = `${rect.top  + a.y * scaleY}px`;
    this._inputEl.style.width  = `${a.w * scaleX}px`;
    this._inputEl.style.height = `${a.h * scaleY}px`;
  }
}
