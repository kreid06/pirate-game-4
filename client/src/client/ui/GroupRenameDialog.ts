/**
 * GroupRenameDialog.ts
 *
 * Custom canvas-drawn modal for renaming a weapon group.
 * Mirrors ShipRenameDialog but for group index + 23-char names.
 */

const BG_MODAL  = 'rgba(0,0,0,0.62)';
const BG_PANEL  = 'rgba(14, 18, 30, 0.99)';
const GOLD      = '#ffd700';
const BORDER    = '#334';
const TEXT_DIM  = '#778';
const GREEN     = '#44cc66';
const RED       = '#ff5544';

const PW = 420;
const PH = 190;

export class GroupRenameDialog {
  public visible = false;
  /** Called when the player confirms a new name. */
  public onConfirm: ((groupIndex: number, name: string) => void) | null = null;

  private _groupIndex = 0;
  private _groupLabel = '';
  private _inputEl: HTMLInputElement;

  private _px = 0;
  private _py = 0;
  private _confirmBtn: { x: number; y: number; w: number; h: number } | null = null;
  private _cancelBtn:  { x: number; y: number; w: number; h: number } | null = null;
  private _inputArea:  { x: number; y: number; w: number; h: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const inp = document.createElement('input');
    inp.type        = 'text';
    inp.maxLength   = 23;
    inp.placeholder = 'Enter group name…';
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

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); this._confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      e.stopPropagation();
    });

    document.body.appendChild(inp);
    this._inputEl = inp;
  }

  open(groupIndex: number, currentName: string, groupLabel?: string): void {
    this._groupIndex = groupIndex;
    this._groupLabel = groupLabel ?? `G${groupIndex + 1}`;
    this._inputEl.value = currentName;
    this.visible = true;
    this._positionInput();
    this._inputEl.style.display = 'block';
    setTimeout(() => { this._inputEl.focus(); this._inputEl.select(); }, 0);
  }

  close(): void {
    this.visible = false;
    this._inputEl.style.display = 'none';
    this._inputEl.blur();
  }

  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;
    if (this._confirmBtn) {
      const b = this._confirmBtn;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { this._confirm(); return true; }
    }
    if (this._cancelBtn) {
      const b = this._cancelBtn;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { this.close(); return true; }
    }
    return true; // consume all clicks while open
  }

  render(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    if (!this.visible) return;

    const px = Math.round((cw - PW) / 2);
    const py = Math.round((ch - PH) / 2);
    this._px = px;
    this._py = py;

    ctx.save();

    ctx.fillStyle = BG_MODAL;
    ctx.fillRect(0, 0, cw, ch);

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
    ctx.beginPath(); ctx.moveTo(px, py + 40); ctx.lineTo(px + PW, py + 40); ctx.stroke();

    ctx.font = 'bold 16px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText(`✏  RENAME GROUP — ${this._groupLabel}`, px + 16, py + 20);

    // Subtitle
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Type a new name then press Enter or click Confirm.', px + 16, py + 50);

    // Text field outline
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

    ctx.fillStyle = 'rgba(255,85,68,0.12)';
    ctx.fillRect(cancelX, btnY, btnW, btnH);
    ctx.strokeStyle = RED; ctx.lineWidth = 1;
    ctx.strokeRect(cancelX, btnY, btnW, btnH);
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff8877';
    ctx.fillText('✕  Cancel', cancelX + btnW / 2, btnY + btnH / 2);
    this._cancelBtn = { x: cancelX, y: btnY, w: btnW, h: btnH };

    ctx.fillStyle = 'rgba(68,204,102,0.12)';
    ctx.fillRect(confirmX, btnY, btnW, btnH);
    ctx.strokeStyle = GREEN; ctx.lineWidth = 1;
    ctx.strokeRect(confirmX, btnY, btnW, btnH);
    ctx.fillStyle = '#88ffaa';
    ctx.fillText('✓  Confirm', confirmX + btnW / 2, btnY + btnH / 2);
    this._confirmBtn = { x: confirmX, y: btnY, w: btnW, h: btnH };

    ctx.restore();
    this._positionInput();
  }

  destroy(): void { this._inputEl.remove(); }

  private _confirm(): void {
    const name = this._inputEl.value.trim().slice(0, 23);
    this.onConfirm?.(this._groupIndex, name);
    this.close();
  }

  private _positionInput(): void {
    const rect   = this.canvas.getBoundingClientRect();
    const scaleX = rect.width  / this.canvas.width;
    const scaleY = rect.height / this.canvas.height;

    let fx: number, fy: number, fw: number, fh: number;
    if (this._inputArea) {
      ({ x: fx, y: fy, w: fw, h: fh } = this._inputArea);
    } else {
      const px = Math.round((this.canvas.width  - PW) / 2);
      const py = Math.round((this.canvas.height - PH) / 2);
      fx = px + 16; fy = py + 76; fw = PW - 32; fh = 32;
    }
    this._inputEl.style.left   = `${rect.left + fx * scaleX}px`;
    this._inputEl.style.top    = `${rect.top  + fy * scaleY}px`;
    this._inputEl.style.width  = `${fw * scaleX}px`;
    this._inputEl.style.height = `${fh * scaleY}px`;
  }
}
