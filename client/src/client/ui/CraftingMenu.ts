/**
 * CraftingMenu.ts
 *
 * Canvas-drawn crafting panel opened when a player presses [E] near a workbench.
 * Shows available recipes (placeholder for now).
 */

// ── Layout ─────────────────────────────────────────────────────────────────

const PANEL_W = 420;
const PANEL_H = 320;

const BG_PANEL  = 'rgba(18, 14, 8, 0.97)';
const BORDER    = '#7a5520';
const TEXT_HEAD = '#e8c870';
const TEXT_DIM  = '#998860';
const TEXT_BODY = '#d0c090';

// ── Class ──────────────────────────────────────────────────────────────────

export class CraftingMenu {
  public visible = false;
  public structureId: number = 0;

  open(structureId: number): void {
    this.structureId = structureId;
    this.visible = true;
  }

  close(): void {
    this.visible = false;
  }

  toggle(): void {
    this.visible = !this.visible;
  }

  /**
   * Render the crafting panel centred on the canvas.
   * Call only when `visible === true`.
   */
  render(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number): void {
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - PANEL_H) / 2);

    ctx.save();

    // ── Dim backdrop ──────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // ── Panel background ──────────────────────────────────────────────────
    ctx.fillStyle = BG_PANEL;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, PANEL_H, 6);
    ctx.fill();
    ctx.stroke();

    // ── Header ────────────────────────────────────────────────────────────
    const headerH = 44;
    ctx.fillStyle = 'rgba(120, 80, 20, 0.35)';
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, headerH, [6, 6, 0, 0]);
    ctx.fill();

    ctx.font = 'bold 18px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_HEAD;
    ctx.fillText('\u2692 Workbench', px + PANEL_W / 2, py + headerH / 2);

    // ── Close button ── top-right corner ─────────────────────────────────
    const btnR = 12;
    const btnX = px + PANEL_W - 16;
    const btnY = py + headerH / 2;
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180, 40, 20, 0.8)';
    ctx.fill();
    ctx.strokeStyle = '#ff7755';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText('✕', btnX, btnY);

    // ── Body ─────────────────────────────────────────────────────────────
    const bodyY = py + headerH + 20;
    ctx.font = '14px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('No recipes yet — more crafting options coming soon.', px + PANEL_W / 2, bodyY);

    // Placeholder recipe slots (greyed out, for visual framing)
    const slotSz = 56;
    const slotGap = 12;
    const cols = 5;
    const rowsToShow = 2;
    const totalW = cols * slotSz + (cols - 1) * slotGap;
    const startX = px + Math.round((PANEL_W - totalW) / 2);
    const startSlotY = bodyY + 30;

    for (let row = 0; row < rowsToShow; row++) {
      for (let col = 0; col < cols; col++) {
        const sx = startX + col * (slotSz + slotGap);
        const sy = startSlotY + row * (slotSz + slotGap);
        ctx.fillStyle = 'rgba(60, 45, 20, 0.5)';
        ctx.strokeStyle = 'rgba(120, 90, 30, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(sx, sy, slotSz, slotSz, 4);
        ctx.fill();
        ctx.stroke();
      }
    }

    // ── Footer hint ───────────────────────────────────────────────────────
    ctx.font = '12px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('[E] or click outside to close', px + PANEL_W / 2, py + PANEL_H - 10);

    ctx.restore();
  }

  /**
   * Returns true if the click was consumed by the crafting menu (so callers
   * can skip other click handling).
   * Pass canvas-space (screen) coordinates.
   */
  handleClick(x: number, y: number, canvasWidth: number, canvasHeight: number): boolean {
    if (!this.visible) return false;
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - PANEL_H) / 2);

    // Close button hit-test
    const headerH = 44;
    const btnX = px + PANEL_W - 16;
    const btnY = py + headerH / 2;
    const dx = x - btnX;
    const dy = y - btnY;
    if (dx * dx + dy * dy <= 12 * 12) {
      this.close();
      return true;
    }

    // Click inside panel — consume but don't close
    if (x >= px && x <= px + PANEL_W && y >= py && y <= py + PANEL_H) {
      return true;
    }

    // Click outside panel — close
    this.close();
    return true;
  }
}
