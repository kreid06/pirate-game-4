/**
 * CraftingMenu.ts
 *
 * Canvas-drawn crafting panel opened when a player presses [E] near a workbench.
 */

// ── Recipes ────────────────────────────────────────────────────────────────

interface Ingredient {
  label: string;
  count: number;
}

interface Recipe {
  id: string;
  outputName: string;
  outputCount: number;
  symbol: string;
  color: string;
  borderColor: string;
  ingredients: Ingredient[];
}

const RECIPES: Recipe[] = [
  {
    id: 'craft_plank',
    outputName: 'Plank',
    outputCount: 1,
    symbol: 'P',
    color: '#b8832b',
    borderColor: '#7a5520',
    ingredients: [
      { label: 'Wood', count: 20 },
    ],
  },
  {
    id: 'craft_sail',
    outputName: 'Sail',
    outputCount: 1,
    symbol: '\u26f5',
    color: '#1e8c6e',
    borderColor: '#0f5c48',
    ingredients: [
      { label: 'Wood',  count: 15 },
      { label: 'Fiber', count: 50 },
    ],
  },
  {
    id: 'craft_helm',
    outputName: 'Helm Kit',
    outputCount: 1,
    symbol: 'W',
    color: '#6a3d8f',
    borderColor: '#3d2060',
    ingredients: [
      { label: 'Wood', count: 10 },
    ],
  },
  {
    id: 'craft_cannon',
    outputName: 'Cannon',
    outputCount: 1,
    symbol: '\u26ab',
    color: '#333333',
    borderColor: '#111111',
    ingredients: [
      { label: 'Wood',  count: 8  },
      { label: 'Metal', count: 20 },
    ],
  },
  {
    id: 'craft_swivel',
    outputName: 'Swivel Gun',
    outputCount: 1,
    symbol: '\u2023',
    color: '#7a4a2a',
    borderColor: '#4a2810',
    ingredients: [
      { label: 'Wood',  count: 5 },
      { label: 'Metal', count: 8 },
    ],
  },
  {
    id: 'craft_sword',
    outputName: 'Sword',
    outputCount: 1,
    symbol: 'S',
    color: '#c0c0c0',
    borderColor: '#777777',
    ingredients: [
      { label: 'Wood',  count: 2 },
      { label: 'Metal', count: 5 },
    ],
  },
];

// ── Layout ─────────────────────────────────────────────────────────────────

const PANEL_W  = 440;
const HDR_H    = 44;
const ROW_H    = 62;
const ROW_GAP  = 6;
const PAD_TOP  = 12;
const PAD_BOT  = 36;
const PANEL_H  = HDR_H + PAD_TOP + RECIPES.length * ROW_H + (RECIPES.length - 1) * ROW_GAP + PAD_BOT;

const BG_PANEL  = 'rgba(18, 14, 8, 0.97)';
const BORDER    = '#7a5520';
const TEXT_HEAD = '#e8c870';
const TEXT_DIM  = '#998860';
const TEXT_BODY = '#d0c090';

// ── Class ──────────────────────────────────────────────────────────────────

export class CraftingMenu {
  public visible = false;
  public structureId: number = 0;

  /** Called when the player clicks Craft on a recipe. */
  public onCraft: ((recipeId: string) => void) | null = null;

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
    ctx.fillStyle = 'rgba(120, 80, 20, 0.35)';
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, HDR_H, [6, 6, 0, 0]);
    ctx.fill();

    ctx.font = 'bold 18px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_HEAD;
    ctx.fillText('\u2692 Workbench', px + PANEL_W / 2, py + HDR_H / 2);

    // ── Close button ──────────────────────────────────────────────────────
    const btnR = 12;
    const btnX = px + PANEL_W - 16;
    const btnY = py + HDR_H / 2;
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
    ctx.fillText('\u2715', btnX, btnY);

    // ── Recipe rows ───────────────────────────────────────────────────────
    const bodyY = py + HDR_H + PAD_TOP;

    for (let i = 0; i < RECIPES.length; i++) {
      const r = RECIPES[i];
      const ry = bodyY + i * (ROW_H + ROW_GAP);

      // Row background
      ctx.fillStyle = 'rgba(40, 28, 10, 0.6)';
      ctx.strokeStyle = 'rgba(120, 80, 30, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(px + 8, ry, PANEL_W - 16, ROW_H, 4);
      ctx.fill();
      ctx.stroke();

      // Output icon
      const iconSize = 44;
      const iconX = px + 16;
      const iconY = ry + (ROW_H - iconSize) / 2;
      ctx.fillStyle = r.color;
      ctx.strokeStyle = r.borderColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(iconX, iconY, iconSize, iconSize, 4);
      ctx.fill();
      ctx.stroke();

      // Icon symbol
      ctx.font = 'bold 18px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(r.symbol, iconX + iconSize / 2, iconY + iconSize / 2);

      // Recipe name
      const textX = iconX + iconSize + 10;
      ctx.textAlign = 'left';
      ctx.font = 'bold 14px Consolas, monospace';
      ctx.fillStyle = TEXT_HEAD;
      ctx.textBaseline = 'top';
      ctx.fillText(r.outputName, textX, ry + 10);

      // Ingredients
      ctx.font = '12px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      const ingStr = r.ingredients.map(ig => `${ig.count}\u00d7 ${ig.label}`).join('  ');
      ctx.fillText(ingStr, textX, ry + 30);

      // Craft button
      const craftBtnW = 68;
      const craftBtnH = 28;
      const craftBtnX = px + PANEL_W - 16 - craftBtnW;
      const craftBtnY = ry + (ROW_H - craftBtnH) / 2;
      ctx.fillStyle = 'rgba(80, 140, 60, 0.85)';
      ctx.strokeStyle = '#60c040';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(craftBtnX, craftBtnY, craftBtnW, craftBtnH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 12px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#dfffcc';
      ctx.fillText('Craft', craftBtnX + craftBtnW / 2, craftBtnY + craftBtnH / 2);
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
   * Returns true if the click was consumed by the crafting menu.
   * Pass canvas-space (screen) coordinates.
   */
  handleClick(x: number, y: number, canvasWidth: number, canvasHeight: number): boolean {
    if (!this.visible) return false;
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - PANEL_H) / 2);

    // Close button hit-test
    const btnX = px + PANEL_W - 16;
    const btnY = py + HDR_H / 2;
    const dx = x - btnX;
    const dy = y - btnY;
    if (dx * dx + dy * dy <= 12 * 12) {
      this.close();
      return true;
    }

    // Click inside panel
    if (x >= px && x <= px + PANEL_W && y >= py && y <= py + PANEL_H) {
      // Check craft buttons
      const bodyY = py + HDR_H + PAD_TOP;
      const craftBtnW = 68;
      const craftBtnH = 28;
      const craftBtnX = px + PANEL_W - 16 - craftBtnW;

      for (let i = 0; i < RECIPES.length; i++) {
        const r = RECIPES[i];
        const ry = bodyY + i * (ROW_H + ROW_GAP);
        const craftBtnY = ry + (ROW_H - craftBtnH) / 2;
        if (
          x >= craftBtnX && x <= craftBtnX + craftBtnW &&
          y >= craftBtnY && y <= craftBtnY + craftBtnH
        ) {
          this.onCraft?.(r.id);
          return true;
        }
      }
      return true;
    }

    // Click outside — close
    this.close();
    return true;
  }
}
