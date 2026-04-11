/**
 * ShipyardMenu.ts
 *
 * Canvas-drawn ship construction panel opened when a player presses [E] at a shipyard.
 *
 *  Phase empty    — one button: "Lay Keel (Brigantine)"
 *  Phase building — read-only progress display (modules installed via direct click
 *                   on the skeleton; hold [E] for radial to release)
 */

export type ConstructionPhase = 'empty' | 'building';

// ── Module definitions (used for progress display) ────────────────────────

export interface ModuleDef {
  id: string;
  label: string;
  cost: string;
  required: boolean;
  symbol: string;
  color: string;
  border: string;
}

export const MODULE_DEFS: ModuleDef[] = [
  { id: 'hull_left',   label: 'Hull Planks (Port)',  cost: '15× Plank',           required: true,  symbol: '⊟', color: '#7a5028', border: '#4a2c10' },
  { id: 'hull_right',  label: 'Hull Planks (Stbd)',  cost: '15× Plank',           required: true,  symbol: '⊟', color: '#7a5028', border: '#4a2c10' },
  { id: 'deck',        label: 'Deck',                cost: '10× Plank',           required: true,  symbol: '▭', color: '#9c7240', border: '#6c4c20' },
  { id: 'mast',        label: 'Mast',                cost: '10× Wood  5× Fiber',  required: false, symbol: '|', color: '#5a4020', border: '#3a2810' },
  { id: 'cannon_port', label: 'Cannon (Port)',        cost: '1× Cannon',           required: false, symbol: '⚫', color: '#3a3a3a', border: '#1a1a1a' },
  { id: 'cannon_stbd', label: 'Cannon (Stbd)',        cost: '1× Cannon',           required: false, symbol: '⚫', color: '#3a3a3a', border: '#1a1a1a' },
];

export const REQUIRED_IDS = new Set(['hull_left', 'hull_right', 'deck']);

// ── Panel layout constants ────────────────────────────────────────────────

const PANEL_W = 490;
const HDR_H   = 48;
const ROW_H   = 60;
const ROW_GAP = 5;
const PAD_TOP = 12;
const PAD_BOT = 40;
const INFO_ROW_H = 28;
const INFO_GAP   = 3;

function panelH(phase: ConstructionPhase): number {
  if (phase === 'empty') {
    return HDR_H + PAD_TOP + ROW_H + PAD_BOT;
  }
  // building: compact progress rows + hint text
  const rows = MODULE_DEFS.length;
  return HDR_H + PAD_TOP + rows * INFO_ROW_H + (rows - 1) * INFO_GAP + 50 + PAD_BOT;
}

// ── Colours ───────────────────────────────────────────────────────────────
const BG_PANEL  = 'rgba(8, 16, 12, 0.97)';
const BORDER    = '#2a6040';
const TEXT_HEAD = '#88e8a8';
const TEXT_DIM  = '#507868';
const TEXT_MID  = '#90b898';
const TEXT_REQ  = '#e8d070';

// ── Class ─────────────────────────────────────────────────────────────────

export class ShipyardMenu {
  public visible    = false;
  public structureId: number | null = null;
  public phase: ConstructionPhase = 'empty';
  public modulesPlaced: string[] = [];

  /**
   * Fired when the player confirms an action.
   *  action = 'craft_skeleton'              — lay the keel
   *  action = 'add_module', module = id     — install a module
   *  action = 'release_ship'               — launch finished ship
   */
  public onAction: ((action: string, module?: string) => void) | null = null;

  // ── Public API ─────────────────────────────────────────────────────────

  open(structureId: number, phase: ConstructionPhase, modulesPlaced: string[]): void {
    this.structureId   = structureId;
    this.phase         = phase;
    this.modulesPlaced = [...modulesPlaced];
    this.visible       = true;
  }

  close(): void {
    this.visible = false;
  }

  /** Called when the server broadcasts an updated state for this shipyard. */
  updateState(phase: ConstructionPhase, modulesPlaced: string[]): void {
    this.phase         = phase;
    this.modulesPlaced = [...modulesPlaced];
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  render(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number): void {
    if (!this.visible) return;
    const ph = panelH(this.phase);
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - ph)       / 2);

    ctx.save();

    // ── Dim backdrop ────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // ── Panel bg ────────────────────────────────────────────────────────
    ctx.fillStyle   = BG_PANEL;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, ph, 6);
    ctx.fill();
    ctx.stroke();

    // ── Header ──────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(16, 64, 36, 0.65)';
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, HDR_H, [6, 6, 0, 0]);
    ctx.fill();

    ctx.font         = 'bold 18px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('⚓  Shipyard — Ship Construction', px + PANEL_W / 2, py + HDR_H / 2);

    // ── Close button ────────────────────────────────────────────────────
    const btnR = 12, btnX = px + PANEL_W - 16, btnY = py + HDR_H / 2;
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(180, 40, 20, 0.8)';
    ctx.fill();
    ctx.strokeStyle = '#ff7755';
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.font         = 'bold 14px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#fff';
    ctx.fillText('✕', btnX, btnY);

    const bodyY = py + HDR_H + PAD_TOP;

    if (this.phase === 'empty') {
      this._drawKeelRow(ctx, px, bodyY);
    } else {
      this._drawModuleRows(ctx, px, bodyY);
    }

    // ── Footer ──────────────────────────────────────────────────────────
    ctx.font         = '11px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle    = TEXT_DIM;
    ctx.fillText('[E] or click ✕ to close', px + PANEL_W / 2, py + ph - 10);

    ctx.restore();
  }

  private _drawKeelRow(ctx: CanvasRenderingContext2D, px: number, ry: number): void {
    // Row bg
    ctx.fillStyle   = 'rgba(16, 52, 32, 0.75)';
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(px + 8, ry, PANEL_W - 16, ROW_H, 4);
    ctx.fill();
    ctx.stroke();

    // Icon
    const ic = 44, icy = ry + (ROW_H - ic) / 2, icx = px + 14;
    ctx.fillStyle   = '#2a5f8a';
    ctx.strokeStyle = '#14304a';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.roundRect(icx, icy, ic, ic, 4);
    ctx.fill();
    ctx.stroke();
    ctx.font         = 'bold 20px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#80d4ff';
    ctx.fillText('⚓', icx + ic / 2, icy + ic / 2);

    // Labels
    const tx = icx + ic + 10;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.font         = 'bold 14px Consolas, monospace';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('Lay Keel  (Brigantine)', tx, ry + 9);
    ctx.font      = '12px Consolas, monospace';
    ctx.fillStyle = TEXT_REQ;
    ctx.fillText('20× Wood  +  10× Fiber', tx, ry + 31);

    // Build button
    const bw = 76, bh = 28, bx = px + PANEL_W - 16 - bw, by = ry + (ROW_H - bh) / 2;
    ctx.fillStyle   = 'rgba(24, 130, 66, 0.9)';
    ctx.strokeStyle = '#40e080';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.stroke();
    ctx.font         = 'bold 13px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#ccffdd';
    ctx.fillText('Build', bx + bw / 2, by + bh / 2);
  }

  private _drawModuleRows(ctx: CanvasRenderingContext2D, px: number, bodyY: number): void {
    const canLaunch = [...REQUIRED_IDS].every(id => this.modulesPlaced.includes(id));

    // Compact read-only progress rows
    for (let i = 0; i < MODULE_DEFS.length; i++) {
      const m    = MODULE_DEFS[i];
      const ry   = bodyY + i * (INFO_ROW_H + INFO_GAP);
      const done = this.modulesPlaced.includes(m.id);

      // Row bg
      ctx.fillStyle   = done ? 'rgba(20, 50, 30, 0.6)' : 'rgba(16, 30, 20, 0.4)';
      ctx.beginPath();
      ctx.roundRect(px + 8, ry, PANEL_W - 16, INFO_ROW_H, 3);
      ctx.fill();

      // Status icon + label
      ctx.font         = '12px Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      const midY = ry + INFO_ROW_H / 2;
      ctx.fillStyle = done ? '#60c880' : (m.required ? TEXT_REQ : TEXT_DIM);
      ctx.fillText(done ? '✓' : '○', px + 16, midY);
      ctx.fillStyle = done ? '#80b890' : (m.required ? '#c8b860' : TEXT_DIM);
      ctx.fillText(m.label, px + 34, midY);

      // Cost hint (right-aligned)
      if (!done) {
        ctx.textAlign = 'right';
        ctx.fillStyle = TEXT_DIM;
        ctx.font      = '10px Consolas, monospace';
        ctx.fillText(m.cost, px + PANEL_W - 16, midY);
      }
    }

    // Hint text
    const hintY = bodyY + MODULE_DEFS.length * (INFO_ROW_H + INFO_GAP) + 12;
    ctx.font         = '11px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = TEXT_DIM;
    ctx.fillText('Click the skeleton with materials to install modules', px + PANEL_W / 2, hintY);
    ctx.fillText(canLaunch ? 'Hold [E] on shipyard → Release Ship' : 'Install required modules to launch', px + PANEL_W / 2, hintY + 16);
  }

  // ── Input handling ──────────────────────────────────────────────────────

  /** Returns true if the click was consumed. */
  handleClick(x: number, y: number, canvasWidth: number, canvasHeight: number): boolean {
    if (!this.visible) return false;
    const ph = panelH(this.phase);
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - ph)       / 2);

    // Close button
    const btnX = px + PANEL_W - 16, btnY = py + HDR_H / 2;
    if ((x - btnX) ** 2 + (y - btnY) ** 2 <= 12 ** 2) {
      this.close();
      return true;
    }

    // Outside panel → close
    if (x < px || x > px + PANEL_W || y < py || y > py + ph) {
      this.close();
      return true;
    }

    const bodyY = py + HDR_H + PAD_TOP;

    if (this.phase === 'empty') {
      // Build button
      const bw = 76, bh = 28, bx = px + PANEL_W - 16 - bw, by = bodyY + (ROW_H - bh) / 2;
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
        this.onAction?.('craft_skeleton');
      }
      return true;
    }

    // Building phase: panel is informational only — no clickable actions
    return true; // consumed (inside panel)
  }
}
