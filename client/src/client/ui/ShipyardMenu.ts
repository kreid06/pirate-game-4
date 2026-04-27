/**
 * ShipyardMenu.ts
 *
 * Canvas-drawn ship construction panel opened when a player presses [E] at a shipyard.
 *
 *  Phase empty    — one button: "Lay Keel (Brigantine)"
 *  Phase building — "Release Ship" button; modules are built via the ship's own build mode
 */

export type ConstructionPhase = 'empty' | 'building';

// ── Panel layout constants ────────────────────────────────────────────────

const PANEL_W = 490;
const HDR_H   = 48;
const ROW_H   = 60;
const PAD_TOP = 12;
const PAD_BOT = 40;

function panelH(_phase: ConstructionPhase): number {
  // Both phases use the same single-row layout
  return HDR_H + PAD_TOP + ROW_H + PAD_BOT;
}

// ── Colours ───────────────────────────────────────────────────────────────
const BG_PANEL  = 'rgba(8, 16, 12, 0.97)';
const BORDER    = '#2a6040';
const TEXT_HEAD = '#88e8a8';
const TEXT_DIM  = '#507868';

// ── Class ─────────────────────────────────────────────────────────────────

export class ShipyardMenu {
  public visible    = false;
  public structureId: number | null = null;
  public phase: ConstructionPhase = 'empty';
  /** Kept for protocol compatibility — no longer used for rendering. */
  public modulesPlaced: string[] = [];

  /** Fired when the player confirms an action. */
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

    ctx.font         = 'bold 18px Georgia, serif';
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
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#fff';
    ctx.fillText('✕', btnX, btnY);

    const bodyY = py + HDR_H + PAD_TOP;

    if (this.phase === 'empty') {
      this._drawKeelRow(ctx, px, bodyY);
    } else {
      this._drawReleaseRow(ctx, px, bodyY);
    }

    // ── Footer ──────────────────────────────────────────────────────────
    ctx.font         = '11px Georgia, serif';
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
    ctx.font         = 'bold 20px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#80d4ff';
    ctx.fillText('⚓', icx + ic / 2, icy + ic / 2);

    // Labels
    const tx = icx + ic + 10;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('Lay Keel  (Brigantine)', tx, ry + 9);
    ctx.font      = '12px Georgia, serif';
    ctx.fillStyle = '#e8d070';
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
    ctx.font         = 'bold 13px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#ccffdd';
    ctx.fillText('Build', bx + bw / 2, by + bh / 2);
  }

  private _drawReleaseRow(ctx: CanvasRenderingContext2D, px: number, ry: number): void {
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
    ctx.fillStyle   = '#3a6030';
    ctx.strokeStyle = '#1a3a18';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.roundRect(icx, icy, ic, ic, 4);
    ctx.fill();
    ctx.stroke();
    ctx.font         = 'bold 20px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#80ffaa';
    ctx.fillText('⚓', icx + ic / 2, icy + ic / 2);

    // Labels
    const tx = icx + ic + 10;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('Ship Under Construction', tx, ry + 9);
    ctx.font      = '12px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('Use build mode [B] to add planks & modules', tx, ry + 31);

    // Release button
    const bw = 100, bh = 28, bx = px + PANEL_W - 16 - bw, by = ry + (ROW_H - bh) / 2;
    ctx.fillStyle   = 'rgba(24, 100, 130, 0.9)';
    ctx.strokeStyle = '#40c8e0';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.stroke();
    ctx.font         = 'bold 13px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#ccf4ff';
    ctx.fillText('Release', bx + bw / 2, by + bh / 2);
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

    // Building phase: Release button
    const bw = 100, bh = 28, bx = px + PANEL_W - 16 - bw, by = bodyY + (ROW_H - bh) / 2;
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
      this.onAction?.('release_ship');
      this.close();
    }
    return true; // always consumed (inside panel)
  }
}
