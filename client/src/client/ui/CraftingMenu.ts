/**
 * CraftingMenu.ts
 *
 * Canvas-drawn crafting panel opened when a player presses [E] near a workbench.
 * Features a left-side category sidebar (Weapons, Structures, Tools, Ship) and a
 * scrollable recipe list for the active category.
 */

import { type PlayerInventory, type ItemKind, ITEM_DEFS, ITEM_KIND_ID } from '../../sim/Inventory.js';

// ── Types ──────────────────────────────────────────────────────────────────

type Category = 'Weapons' | 'Structures' | 'Tools' | 'Ship';

interface Ingredient {
  label: string;
  count: number;
}

interface Recipe {
  id: string;
  category: Category;
  outputName: string;
  outputCount: number;
  symbol: string;
  color: string;
  borderColor: string;
  ingredients: Ingredient[];
}

// ── Recipes ────────────────────────────────────────────────────────────────

const RECIPES: Recipe[] = [
  // ── Weapons ──────────────────────────────────────────────────────────────
  {
    id: 'craft_sword',
    category: 'Weapons',
    outputName: 'Sword',
    outputCount: 1,
    symbol: '⚔',
    color: '#c0c0c0',
    borderColor: '#777777',
    ingredients: [
      { label: 'Wood',  count: 2 },
      { label: 'Metal', count: 5 },
    ],
  },
  {
    id: 'craft_cannon',
    category: 'Weapons',
    outputName: 'Cannon',
    outputCount: 1,
    symbol: '●',
    color: '#333333',
    borderColor: '#111111',
    ingredients: [
      { label: 'Wood',  count: 8  },
      { label: 'Metal', count: 20 },
    ],
  },
  {
    id: 'craft_swivel',
    category: 'Weapons',
    outputName: 'Swivel Gun',
    outputCount: 1,
    symbol: '›',
    color: '#7a4a2a',
    borderColor: '#4a2810',
    ingredients: [
      { label: 'Wood',  count: 5 },
      { label: 'Metal', count: 8 },
    ],
  },
  // ── Structures ───────────────────────────────────────────────────────────
  {
    id: 'craft_wall',
    category: 'Structures',
    outputName: 'Wall',
    outputCount: 4,
    symbol: '┃',
    color: '#5c3a1a',
    borderColor: '#2e1a08',
    ingredients: [
      { label: 'Wood', count: 10 },
    ],
  },
  {
    id: 'craft_door_frame',
    category: 'Structures',
    outputName: 'Door Frame',
    outputCount: 1,
    symbol: 'Fr',
    color: '#7a4820',
    borderColor: '#3e200c',
    ingredients: [
      { label: 'Wood', count: 6 },
    ],
  },
  {
    id: 'craft_door',
    category: 'Structures',
    outputName: 'Door',
    outputCount: 1,
    symbol: '□',
    color: '#7a4820',
    borderColor: '#3e200c',
    ingredients: [
      { label: 'Wood', count: 4 },
    ],
  },
  {
    id: 'craft_floor',
    category: 'Structures',
    outputName: 'Wooden Floor',
    outputCount: 1,
    symbol: '⊟',
    color: '#b8832b',
    borderColor: '#7a5520',
    ingredients: [
      { label: 'Wood', count: 20 },
    ],
  },
  {
    id: 'craft_wood_ceiling',
    category: 'Structures',
    outputName: 'Wood Ceiling',
    outputCount: 1,
    symbol: '⊠',
    color: '#b8832b',
    borderColor: '#7a5520',
    ingredients: [
      { label: 'Wood', count: 15 },
    ],
  },
  {
    id: 'craft_workbench',
    category: 'Structures',
    outputName: 'Workbench',
    outputCount: 1,
    symbol: '⚒',
    color: '#7a4820',
    borderColor: '#4a2810',
    ingredients: [
      { label: 'Wood',  count: 15 },
      { label: 'Stone', count: 10 },
    ],
  },
  {
    id: 'craft_shipyard',
    category: 'Structures',
    outputName: 'Shipyard',
    outputCount: 1,
    symbol: '⚓',
    color: '#2a5f8a',
    borderColor: '#14304a',
    ingredients: [
      { label: 'Wood',  count: 30 },
      { label: 'Plank', count: 10 },
    ],
  },
  // ── Tools ─────────────────────────────────────────────────────────────────
  {
    id: 'craft_hammer',
    category: 'Tools',
    outputName: 'Hammer',
    outputCount: 1,
    symbol: '🔨',
    color: '#c07830',
    borderColor: '#885020',
    ingredients: [
      { label: 'Wood', count: 4 },
    ],
  },
  {
    id: 'craft_stone_axe',
    category: 'Tools',
    outputName: 'Stone Axe',
    outputCount: 1,
    symbol: '🪓',
    color: '#8b5e2a',
    borderColor: '#5c3a10',
    ingredients: [
      { label: 'Wood',  count: 2 },
      { label: 'Stone', count: 5 },
    ],
  },
  {
    id: 'craft_stone_pickaxe',
    category: 'Tools',
    outputName: 'Stone Pickaxe',
    outputCount: 1,
    symbol: '⛏',
    color: '#7a7a7c',
    borderColor: '#555558',
    ingredients: [
      { label: 'Wood',  count: 2 },
      { label: 'Stone', count: 4 },
    ],
  },
  // ── Ship ──────────────────────────────────────────────────────────────────
  {
    id: 'craft_plank',
    category: 'Ship',
    outputName: 'Plank',
    outputCount: 1,
    symbol: 'P',
    color: '#b8832b',
    borderColor: '#7a5520',
    ingredients: [
      { label: 'Wood', count: 30 },
    ],
  },
  {
    id: 'craft_sail',
    category: 'Ship',
    outputName: 'Sail',
    outputCount: 1,
    symbol: '⛵',
    color: '#1e8c6e',
    borderColor: '#0f5c48',
    ingredients: [
      { label: 'Wood',  count: 40 },
      { label: 'Fiber', count: 100 },
    ],
  },
  {
    id: 'craft_helm',
    category: 'Ship',
    outputName: 'Helm Kit',
    outputCount: 1,
    symbol: '🎡',
    color: '#6a3d8f',
    borderColor: '#3d2060',
    ingredients: [
      { label: 'Wood', count: 10 },
    ],
  },
];

// ── Layout constants ───────────────────────────────────────────────────────

const PANEL_W    = 580;
const PANEL_H    = 500;
const HDR_H      = 48;
const FOOTER_H   = 32;
const SIDEBAR_W  = 130;
const ROW_H      = 68;
const ROW_GAP    = 6;
const CONTENT_PAD = 10;

const CATEGORIES: { id: Category; icon: string }[] = [
  { id: 'Weapons',    icon: '⚔' },
  { id: 'Structures', icon: '🏗' },
  { id: 'Tools',      icon: '⛏' },
  { id: 'Ship',       icon: '⛵' },
];

const BG_PANEL    = 'rgba(14, 10, 5, 0.97)';
const BG_SIDEBAR  = 'rgba(8, 5, 2, 0.6)';
const BORDER      = '#7a5520';
const BORDER_DIM  = 'rgba(100, 65, 20, 0.35)';
const TEXT_HEAD   = '#e8c870';
const TEXT_DIM    = '#998860';

// ── Ingredient label → ItemKind mapping ────────────────────────────────────

const INGREDIENT_KIND: Record<string, ItemKind> = {
  Wood:  'wood',
  Fiber: 'fiber',
  Metal: 'metal',
  Stone: 'stone',
  Plank: 'plank',
};

/** Sum total quantity of a given item kind across all inventory slots. */
function countInInventory(inv: PlayerInventory | null, kind: ItemKind): number {
  if (!inv) return 0;
  return inv.slots.reduce((sum, s) => sum + (s.item === kind ? s.quantity : 0), 0);
}

/** Returns true if the player has enough materials for all ingredients. */
function canCraft(inv: PlayerInventory | null, recipe: Recipe): boolean {
  return recipe.ingredients.every(ig => {
    const kind = INGREDIENT_KIND[ig.label];
    if (!kind) return true; // unknown ingredient — don't block
    return countInInventory(inv, kind) >= ig.count;
  });
}

// ── Class ──────────────────────────────────────────────────────────────────

export class CraftingMenu {
  public visible = false;
  public structureId: number = 0;

  /** Called when the player clicks Craft on a recipe. */
  public onCraft: ((recipeId: string) => void) | null = null;

  private _activeCategory: Category = 'Weapons';
  private _scrollOffset = 0;
  private _mouseX = -1;
  private _mouseY = -1;

  open(structureId: number): void {
    this.structureId = structureId;
    this.visible = true;
    this._scrollOffset = 0;
  }

  close(): void {
    this.visible = false;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.visible) this._scrollOffset = 0;
  }

  handleMouseMove(x: number, y: number): void {
    this._mouseX = x;
    this._mouseY = y;
  }

  handleWheel(deltaY: number): boolean {
    if (!this.visible) return false;
    const recipes = RECIPES.filter(r => r.category === this._activeCategory);
    const contentH = PANEL_H - HDR_H - FOOTER_H;
    const totalH = recipes.length * (ROW_H + ROW_GAP) + CONTENT_PAD * 2;
    const maxScroll = Math.max(0, totalH - contentH);
    this._scrollOffset = Math.max(0, Math.min(maxScroll, this._scrollOffset + deltaY * 0.4));
    return true;
  }

  /**
   * Render the crafting panel centred on the canvas.
   * Call only when `visible === true`.
   */
  render(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, inventory: PlayerInventory | null = null): void {
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - PANEL_H) / 2);

    ctx.save();

    // ── Dim backdrop ──────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // ── Panel background ──────────────────────────────────────────────────
    ctx.fillStyle = BG_PANEL;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, PANEL_H, 8);
    ctx.fill();
    ctx.stroke();

    // ── Header ────────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(120, 80, 20, 0.4)';
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, HDR_H, [8, 8, 0, 0]);
    ctx.fill();
    // header divider
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + HDR_H);
    ctx.lineTo(px + PANEL_W, py + HDR_H);
    ctx.stroke();

    ctx.font = 'bold 19px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_HEAD;
    ctx.fillText('⚒  Workbench', px + PANEL_W / 2, py + HDR_H / 2);

    // ── Close button ──────────────────────────────────────────────────────
    const closeR = 12;
    const closeX = px + PANEL_W - 20;
    const closeY = py + HDR_H / 2;
    ctx.beginPath();
    ctx.arc(closeX, closeY, closeR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180, 40, 20, 0.85)';
    ctx.fill();
    ctx.strokeStyle = '#ff7755';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText('✕', closeX, closeY);

    // ── Sidebar ───────────────────────────────────────────────────────────
    const sideX = px;
    const sideY = py + HDR_H;
    const sideH = PANEL_H - HDR_H;

    ctx.fillStyle = BG_SIDEBAR;
    ctx.beginPath();
    ctx.roundRect(sideX, sideY, SIDEBAR_W, sideH, [0, 0, 0, 8]);
    ctx.fill();
    // sidebar right border
    ctx.strokeStyle = BORDER_DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sideX + SIDEBAR_W, sideY);
    ctx.lineTo(sideX + SIDEBAR_W, sideY + sideH);
    ctx.stroke();

    const tabH = 72;
    const tabGap = 6;
    const tabsStartY = sideY + 16;

    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];
      const active = cat.id === this._activeCategory;
      const tx = sideX + 8;
      const ty = tabsStartY + i * (tabH + tabGap);

      ctx.fillStyle = active ? 'rgba(140, 90, 20, 0.55)' : 'rgba(30, 20, 8, 0.4)';
      ctx.strokeStyle = active ? BORDER : BORDER_DIM;
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(tx, ty, SIDEBAR_W - 16, tabH, 6);
      ctx.fill();
      ctx.stroke();

      // Active indicator — left accent bar
      if (active) {
        ctx.fillStyle = TEXT_HEAD;
        ctx.fillRect(tx, ty + 8, 3, tabH - 16);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tabCx = tx + (SIDEBAR_W - 16) / 2;

      // Icon
      ctx.font = '22px serif';
      ctx.fillStyle = active ? '#fff' : '#aaa';
      ctx.fillText(cat.icon, tabCx, ty + tabH / 2 - 10);

      // Label
      ctx.font = `${active ? 'bold ' : ''}11px Consolas, monospace`;
      ctx.fillStyle = active ? TEXT_HEAD : TEXT_DIM;
      ctx.fillText(cat.id, tabCx, ty + tabH / 2 + 14);
    }

    // ── Recipe list (clipped to content area) ────────────────────────────
    const listX = px + SIDEBAR_W;
    const listY = py + HDR_H;
    const listW = PANEL_W - SIDEBAR_W;
    const listH = PANEL_H - HDR_H - FOOTER_H;

    ctx.save();
    ctx.beginPath();
    ctx.rect(listX, listY, listW, listH);
    ctx.clip();

    const recipes = RECIPES.filter(r => r.category === this._activeCategory);
    const bodyY = listY + CONTENT_PAD - this._scrollOffset;

    for (let i = 0; i < recipes.length; i++) {
      const r = recipes[i];
      const ry = bodyY + i * (ROW_H + ROW_GAP);

      // Skip if completely out of view
      if (ry + ROW_H < listY || ry > listY + listH) continue;

      // Row background
      ctx.fillStyle = 'rgba(40, 28, 10, 0.65)';
      ctx.strokeStyle = 'rgba(120, 80, 30, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(listX + 8, ry, listW - 16, ROW_H, 5);
      ctx.fill();
      ctx.stroke();

      // Icon box
      const iconSize = 46;
      const iconX = listX + 16;
      const iconY = ry + (ROW_H - iconSize) / 2;
      ctx.fillStyle = r.color;
      ctx.strokeStyle = r.borderColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(iconX, iconY, iconSize, iconSize, 5);
      ctx.fill();
      ctx.stroke();

      ctx.font = 'bold 18px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(r.symbol, iconX + iconSize / 2, iconY + iconSize / 2);

      // Name + yield
      const textX = iconX + iconSize + 10;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 14px Consolas, monospace';
      ctx.fillStyle = TEXT_HEAD;
      const yieldStr = r.outputCount > 1 ? ` ×${r.outputCount}` : '';
      ctx.fillText(r.outputName + yieldStr, textX, ry + 12);

      // Ingredients — each segment coloured green (have enough) or red (missing)
      const craftable = canCraft(inventory, r);
      ctx.font = '11px Consolas, monospace';
      ctx.textBaseline = 'top';
      let ingCursorX = textX;
      for (let j = 0; j < r.ingredients.length; j++) {
        const ig = r.ingredients[j];
        const kind = INGREDIENT_KIND[ig.label];
        const have = kind ? countInInventory(inventory, kind) : ig.count;
        const ok = have >= ig.count;
        const segText = (j > 0 ? '   ' : '') + `${ig.count}× ${ig.label}`;
        ctx.fillStyle = ok ? '#55dd55' : '#dd4444';
        ctx.fillText(segText, ingCursorX, ry + 34);
        ingCursorX += ctx.measureText(segText).width;
      }

      // Craft button — greyed out when player can't afford
      const btnW = 72;
      const btnH = 30;
      const btnX = listX + listW - 16 - btnW;
      const btnY = ry + (ROW_H - btnH) / 2;
      ctx.fillStyle = craftable ? 'rgba(60, 130, 50, 0.9)' : 'rgba(50, 50, 50, 0.7)';
      ctx.strokeStyle = craftable ? '#55bb35' : '#444444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(btnX, btnY, btnW, btnH, 5);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 12px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = craftable ? '#dfffcc' : '#777777';
      ctx.fillText('Craft', btnX + btnW / 2, btnY + btnH / 2);
    }

    // Empty state
    if (recipes.length === 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '14px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('No recipes available', listX + listW / 2, listY + listH / 2);
    }

    ctx.restore(); // pop clip

    // ── Scroll indicator (fade at bottom of list) ─────────────────────────
    const totalH = recipes.length * (ROW_H + ROW_GAP) + CONTENT_PAD * 2;
    if (totalH > listH) {
      const grad = ctx.createLinearGradient(0, listY + listH - 32, 0, listY + listH);
      grad.addColorStop(0, 'rgba(14,10,5,0)');
      grad.addColorStop(1, 'rgba(14,10,5,0.85)');
      ctx.fillStyle = grad;
      ctx.fillRect(listX, listY + listH - 32, listW, 32);
    }

    // ── Footer ────────────────────────────────────────────────────────────
    ctx.strokeStyle = BORDER_DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + SIDEBAR_W, py + PANEL_H - FOOTER_H);
    ctx.lineTo(px + PANEL_W,   py + PANEL_H - FOOTER_H);
    ctx.stroke();

    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('[E] close  •  scroll to browse', px + SIDEBAR_W + (PANEL_W - SIDEBAR_W) / 2, py + PANEL_H - FOOTER_H / 2);

    // ── Icon hover tooltip ────────────────────────────────────────────────
    this._renderIconTooltip(ctx, px, py, canvasWidth, canvasHeight);

    ctx.restore();
  }

  private _renderIconTooltip(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    canvasWidth: number, canvasHeight: number,
  ): void {
    const mx = this._mouseX;
    const my = this._mouseY;
    if (mx < 0) return;

    const listX = px + SIDEBAR_W;
    const listY = py + HDR_H;
    const listW = PANEL_W - SIDEBAR_W;
    const listH = PANEL_H - HDR_H - FOOTER_H;

    // Only check when mouse is inside the list area
    if (mx < listX || mx > listX + listW || my < listY || my > listY + listH) return;

    const recipes = RECIPES.filter(r => r.category === this._activeCategory);
    const bodyY = listY + CONTENT_PAD - this._scrollOffset;
    const iconSize = 46;

    for (let i = 0; i < recipes.length; i++) {
      const ry = bodyY + i * (ROW_H + ROW_GAP);
      if (ry + ROW_H < listY || ry > listY + listH) continue;

      const iconX = listX + 16;
      const iconY = ry + (ROW_H - iconSize) / 2;

      if (mx >= iconX && mx <= iconX + iconSize && my >= iconY && my <= iconY + iconSize) {
        const r = recipes[i];
        // Map recipe id → ItemKind
        const KIND_MAP: Record<string, ItemKind> = {
          craft_plank:       'plank',
          craft_sail:        'sail',
          craft_helm:        'helm_kit',
          craft_cannon:      'cannon',
          craft_swivel:      'swivel',
          craft_sword:       'sword',
          craft_wall:        'wall',
          craft_door_frame:  'door_frame',
          craft_door:        'door',
          craft_floor:       'wooden_floor',
          craft_wood_ceiling:'wood_ceiling',
          craft_workbench:   'workbench',
          craft_shipyard:    'shipyard',
          craft_hammer:      'hammer',
          craft_stone_axe:   'axe',
          craft_stone_pickaxe:'pickaxe',
        };
        const kind: ItemKind = KIND_MAP[r.id] ?? 'none';
        const def = ITEM_DEFS[kind];
        if (!def || def.kind === 'none') return;

        const itemId = ITEM_KIND_ID[kind] ?? 0;

        // Measure tooltip
        const PAD    = 10;
        const W      = 230;
        const LINE   = 16;
        const nameH  = 18;
        const font12 = '12px Consolas, monospace';
        const descLines = this._wrapText(ctx, def.description, W - PAD * 2, font12);
        const totalH = PAD + nameH + 4 + LINE + 4 + descLines.length * LINE + PAD;

        // Position: near icon, clamped to canvas
        let tx = iconX + iconSize + 8;
        let ty = iconY;
        if (tx + W > canvasWidth) tx = iconX - W - 8;
        if (ty + totalH > canvasHeight) ty = canvasHeight - totalH - 4;
        if (ty < 4) ty = 4;

        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur  = 8;
        ctx.fillStyle   = 'rgba(12,12,20,0.96)';
        ctx.strokeStyle = def.borderColor;
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.roundRect(tx, ty, W, totalH, 6);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Colour accent bar
        ctx.fillStyle = def.color;
        ctx.beginPath();
        ctx.roundRect(tx, ty, 4, totalH, 6);
        ctx.fill();

        let cy = ty + PAD;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';

        ctx.fillStyle = '#ffffff';
        ctx.font      = 'bold 14px Consolas, monospace';
        ctx.fillText(def.name, tx + PAD + 4, cy);
        cy += nameH + 4;

        ctx.fillStyle = '#888888';
        ctx.font      = '11px Consolas, monospace';
        ctx.fillText(`ID: ${itemId}   [${def.category}]`, tx + PAD + 4, cy);
        cy += LINE + 4;

        ctx.fillStyle = '#cccccc';
        ctx.font      = font12;
        for (const line of descLines) {
          ctx.fillText(line, tx + PAD + 4, cy);
          cy += LINE;
        }

        ctx.restore();
        return;
      }
    }
  }

  private _wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: string): string[] {
    ctx.save();
    ctx.font = font;
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    ctx.restore();
    return lines;
  }

  /**
   * Returns true if the click was consumed by the crafting menu.
   * Pass canvas-space (screen) coordinates.
   */
  handleClick(x: number, y: number, canvasWidth: number, canvasHeight: number, inventory: PlayerInventory | null = null): boolean {
    if (!this.visible) return false;
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - PANEL_H) / 2);

    // Close button
    const closeX = px + PANEL_W - 20;
    const closeY = py + HDR_H / 2;
    if ((x - closeX) ** 2 + (y - closeY) ** 2 <= 12 ** 2) {
      this.close();
      return true;
    }

    // Click outside panel
    if (x < px || x > px + PANEL_W || y < py || y > py + PANEL_H) {
      this.close();
      return true;
    }

    // ── Category tab clicks ───────────────────────────────────────────────
    const sideX = px;
    const sideY = py + HDR_H;
    const tabH = 72;
    const tabGap = 6;
    const tabsStartY = sideY + 16;

    if (x >= sideX && x <= sideX + SIDEBAR_W) {
      for (let i = 0; i < CATEGORIES.length; i++) {
        const ty = tabsStartY + i * (tabH + tabGap);
        if (y >= ty && y <= ty + tabH) {
          this._activeCategory = CATEGORIES[i].id;
          this._scrollOffset = 0;
          return true;
        }
      }
      return true;
    }

    // ── Recipe craft button clicks ────────────────────────────────────────
    const listX = px + SIDEBAR_W;
    const listY = py + HDR_H;
    const listW = PANEL_W - SIDEBAR_W;
    const listH = PANEL_H - HDR_H - FOOTER_H;

    if (x >= listX && x <= listX + listW && y >= listY && y <= listY + listH) {
      const recipes = RECIPES.filter(r => r.category === this._activeCategory);
      const bodyY = listY + CONTENT_PAD - this._scrollOffset;
      const btnW = 72;
      const btnH = 30;
      const btnX = listX + listW - 16 - btnW;

      for (let i = 0; i < recipes.length; i++) {
        const ry = bodyY + i * (ROW_H + ROW_GAP);
        const btnY = ry + (ROW_H - btnH) / 2;
        if (x >= btnX && x <= btnX + btnW && y >= btnY && y <= btnY + btnH) {
          if (canCraft(inventory, recipes[i])) {
            this.onCraft?.(recipes[i].id);
          }
          return true;
        }
      }
      return true;
    }

    return true;
  }
}
