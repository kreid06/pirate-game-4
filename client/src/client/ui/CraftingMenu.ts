/**
 * CraftingMenu.ts
 *
 * Canvas-drawn crafting panel opened when a player presses [E] near a workbench.
 * Features a left-side category sidebar (Weapons, Structures, Tools, Ship) and a
 * scrollable recipe list for the active category.
 */

import { type PlayerInventory, type ItemKind, ITEM_DEFS, ITEM_KIND_ID, drawAxeIcon, drawSwordIcon } from '../../sim/Inventory.js';
import { type SchematicEntry, type ShipSchematicEntry, tierColor, tierName, statMultLabel, itemDisplayName, QUALITY_STAT_NAMES, schematicCraftCost } from '../../sim/Quality.js';

// ── Types ──────────────────────────────────────────────────────────────────

type Category = 'Weapons' | 'Structures' | 'Tools' | 'Ship' | 'Schematics';

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
    outputCount: 1,
    symbol: '┃',
    color: '#5c3a1a',
    borderColor: '#2e1a08',
    ingredients: [
      { label: 'Wood', count: 10 },
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
    id: 'craft_ramp',
    category: 'Structures',
    outputName: 'Ramp',
    outputCount: 1,
    symbol: '⟋',
    color: '#7a5c2a',
    borderColor: '#4a3410',
    ingredients: [
      { label: 'Wood', count: 20 },
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
      { label: 'Wood', count: 10 },
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
      { label: 'Wood',  count: 3 },
      { label: 'Stone', count: 4 },
    ],
  },
  {
    id: 'craft_metal_axe',
    category: 'Tools',
    outputName: 'Metal Axe',
    outputCount: 1,
    symbol: '\uD83E\uDE93',
    color: '#7a9ab0',
    borderColor: '#4a6878',
    ingredients: [
      { label: 'Wood',  count: 3 },
      { label: 'Metal', count: 15 },
    ],
  },
  {
    id: 'craft_metal_pickaxe',
    category: 'Tools',
    outputName: 'Metal Pickaxe',
    outputCount: 1,
    symbol: '\u26cf',
    color: '#6a8aa0',
    borderColor: '#3a5868',
    ingredients: [
      { label: 'Wood',  count: 3 },
      { label: 'Metal', count: 12 },
    ],
  },
  {
    id: 'craft_grapple_hook',
    category: 'Tools',
    outputName: 'Grapple Hook',
    outputCount: 1,
    symbol: '\u2693',
    color: '#808080',
    borderColor: '#505050',
    ingredients: [
      { label: 'Wood',  count: 5 },
      { label: 'Metal', count: 8 },
      { label: 'Fiber', count: 5 },
    ],
  },
  {
    id: 'craft_claim_flag',
    category: 'Tools',
    outputName: 'Claiming Flag',
    outputCount: 1,
    symbol: '🚩',
    color: '#dd3333',
    borderColor: '#991111',
    ingredients: [
      { label: 'Wood', count: 5 },
    ],
  },
  {
    id: 'craft_flag_fort',
    category: 'Structures',
    outputName: 'Flag Fort',
    outputCount: 1,
    symbol: '🏰',
    color: '#cc8822',
    borderColor: '#886611',
    ingredients: [
      { label: 'Wood',  count: 40 },
      { label: 'Stone', count: 40 },
    ],
  },
  {
    id: 'craft_company_fortress',
    category: 'Structures',
    outputName: 'Company Fortress',
    outputCount: 1,
    symbol: '🏯',
    color: '#8844cc',
    borderColor: '#5522aa',
    ingredients: [
      { label: 'Wood',  count: 100 },
      { label: 'Stone', count: 100 },
      { label: 'Metal', count: 20 },
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
    id: 'craft_deck',
    category: 'Ship',
    outputName: 'Deck',
    outputCount: 1,
    symbol: '⊟',
    color: '#8b5e3c',
    borderColor: '#5c3a1c',
    ingredients: [
      { label: 'Wood', count: 75 },
    ],
  },
  {
    id: 'craft_ramp',
    category: 'Ship',
    outputName: 'Ramp',
    outputCount: 1,
    symbol: '⟋',
    color: '#7a5c2a',
    borderColor: '#4a3410',
    ingredients: [
      { label: 'Wood', count: 20 },
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
    id: 'craft_helm_kit',
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
/** Schematic rows are slightly taller to fit tier + stat + cost summary lines. */
const SCHEM_ROW_H = 102;

const CATEGORIES: { id: Category; icon: string }[] = [
  { id: 'Weapons',    icon: '⚔' },
  { id: 'Tools',      icon: '⛏' },
  { id: 'Ship',       icon: '⛵' },
  { id: 'Schematics', icon: '📜' },
];

/** Craft-tab sidebar for ship workbench — weapons/tools only (modules use schematics). */
const SHIP_CRAFT_CATEGORIES: { id: Category; icon: string }[] = [
  { id: 'Weapons', icon: '⚔' },
  { id: 'Tools',   icon: '⛏' },
];

/** Repair-tab module categories for ship workbench. */
const REPAIR_CATEGORIES: { id: string; itemId: number; label: string; icon: string }[] = [
  { id: 'plank',  itemId: 1,  label: 'Plank',  icon: 'P'  },
  { id: 'deck',   itemId: 13, label: 'Deck',   icon: '⊟' },
  { id: 'cannon', itemId: 7,  label: 'Cannon', icon: '●' },
  { id: 'swivel', itemId: 14, label: 'Swivel', icon: '›' },
  { id: 'sail',   itemId: 8,  label: 'Sail',   icon: '⛵' },
  { id: 'helm',   itemId: 9,  label: 'Helm',   icon: '🎡' },
  { id: 'ramp',   itemId: 37, label: 'Ramp',   icon: '⟋' },
];

const TOP_TAB_H = 36;
const REPAIR_POOL_SECTION_H = 220;
const REPAIR_ROW_H = 88;
const REPAIR_ROW_GAP = 4;
const REPAIR_POOL_BTN_W = 96;
/** Sentinel index — virtual default-common row appended to every pool category. */
const DEFAULT_POOL_INDEX = -1;

type PoolDisplayEntry = ShipSchematicEntry & { isDefault?: boolean };
const GREEN = '#44cc66';
type TopTab = 'craft' | 'repair';

type RepairHit =
  | { type: 'pool_up' | 'pool_down' | 'pool_withdraw'; poolIndex: number; x: number; y: number; w: number; h: number }
  | { type: 'pool_drag'; poolIndex: number; pos: number; x: number; y: number; w: number; h: number }
  | { type: 'personal'; bpIndex: number; x: number; y: number; w: number; h: number };

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
/** Count available quantity of an ingredient kind.
 * Wood/Fiber/Metal/Stone are read from the dedicated resources pool;
 * other kinds (e.g. Plank) are counted from inventory slots. */
function countInInventory(inv: PlayerInventory | null, kind: ItemKind): number {
  if (!inv) return 0;
  switch (kind) {
    case 'wood':  return inv.resources.wood;
    case 'fiber': return inv.resources.fiber;
    case 'metal': return inv.resources.metal;
    case 'stone': return inv.resources.stone;
    default:
      return inv.slots.reduce((sum, s) => sum + (s.item === kind ? s.quantity : 0), 0);
  }
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

  /** Called when the player crafts from a schematic (passes the schematic index). */
  public onCraftSchematic: ((index: number) => void) | null = null;

  /** Ship workbench repair pool — deposit / withdraw / reorder for NPC crew. */
  public onDepositToShipPool: ((shipId: number, playerBpIndex: number) => void) | null = null;
  public onWithdrawFromShipPool: ((shipId: number, poolIndex: number) => void) | null = null;
  public onReorderShipPool: ((shipId: number, itemId: number, order: number[]) => void) | null = null;
  public onRequestShipPool: ((shipId: number) => void) | null = null;

  private _activeCategory: Category = 'Weapons';
  private _scrollOffset = 0;
  private _mouseX = -1;
  private _mouseY = -1;

  /** True when opened from a ship-deck workbench module (vs island structure). */
  private _isShipWorkbench = false;
  /** Ship workbench top-level tab: craft recipes vs repair schematics. */
  private _topTab: TopTab = 'craft';
  /** Active module category within the Repair tab. */
  private _activeRepairCategory = REPAIR_CATEGORIES[0].id;
  private _shipId = 0;
  private _shipPoolSchematics: ShipSchematicEntry[] = [];
  private _repairPoolScrollY = 0;
  private _repairPersonalScrollY = 0;
  private _repairHits: RepairHit[] = [];
  private _poolDropZone: { x: number; y: number; w: number; h: number } | null = null;
  private _dragBpIndex: number | null = null;
  private _dragX = 0;
  private _dragY = 0;
  /** Pool row drag-to-reorder (works alongside ↑/↓ buttons). */
  private _poolDragIndex: number | null = null;
  private _poolDragFromPos = -1;
  private _poolDragY = 0;
  /** Pool list geometry — set each render for drop-index math on mouse-up. */
  private _poolListOriginY = 0;
  private _panelPx = 0;
  private _panelPy = 0;

  /** Player's owned schematics, fed from the server `schematic_list` message. */
  private _schematics: SchematicEntry[] = [];

  /** Replace the schematic list shown under the Schematics tab. */
  setSchematics(items: SchematicEntry[]): void {
    this._schematics = items;
  }

  setShipPoolSchematics(items: ShipSchematicEntry[]): void {
    this._shipPoolSchematics = items;
  }

  get isShipWorkbenchOpen(): boolean {
    return this.visible && this._isShipWorkbench;
  }

  private _contentTop(py: number): number {
    return py + HDR_H + (this._isShipWorkbench ? TOP_TAB_H : 0);
  }

  private _isIslandSchematicsView(): boolean {
    return !this._isShipWorkbench && this._activeCategory === 'Schematics';
  }

  private _isShipRepairView(): boolean {
    return this._isShipWorkbench && this._topTab === 'repair';
  }

  private _filteredPersonalSchematics(): SchematicEntry[] {
    const cat = REPAIR_CATEGORIES.find(c => c.id === this._activeRepairCategory) ?? REPAIR_CATEGORIES[0];
    return this._schematics.filter(s => s.item === cat.itemId);
  }

  private _filteredShipPool(): ShipSchematicEntry[] {
    const cat = REPAIR_CATEGORIES.find(c => c.id === this._activeRepairCategory) ?? REPAIR_CATEGORIES[0];
    return this._shipPoolSchematics
      .filter(s => s.item === cat.itemId)
      .sort((a, b) => a.prio - b.prio || a.index - b.index);
  }

  /** Deposited pool rows plus the always-present Common fallback at the end. */
  private _poolDisplayItems(): PoolDisplayEntry[] {
    const cat = REPAIR_CATEGORIES.find(c => c.id === this._activeRepairCategory) ?? REPAIR_CATEGORIES[0];
    return [...this._filteredShipPool(), this._defaultCommonPoolEntry(cat.itemId)];
  }

  private _defaultCommonPoolEntry(itemId: number): PoolDisplayEntry {
    return {
      index: DEFAULT_POOL_INDEX,
      item: itemId,
      quality: 0,
      tier: 0,
      crafts: 0,
      stats: QUALITY_STAT_NAMES.map(() => 256),
      prio: 255,
      isDefault: true,
    };
  }

  private _isDefaultPoolEntry(entry: { index: number; isDefault?: boolean }): boolean {
    return entry.isDefault === true || entry.index === DEFAULT_POOL_INDEX;
  }

  private _filteredSchematics(): SchematicEntry[] {
    if (this._isShipRepairView()) return this._filteredPersonalSchematics();
    return this._schematics;
  }

  private _activeRecipes(): Recipe[] {
    if (this._isShipRepairView() || this._isIslandSchematicsView()) return [];
    return RECIPES.filter(r => r.category === this._activeCategory);
  }

  open(structureId: number, opts?: { isShipWorkbench?: boolean; shipId?: number }): void {
    this.structureId = structureId;
    this._isShipWorkbench = opts?.isShipWorkbench ?? false;
    this._shipId = opts?.shipId ?? 0;
    this._topTab = 'craft';
    this._activeCategory = 'Weapons';
    this._activeRepairCategory = REPAIR_CATEGORIES[0].id;
    this._repairPoolScrollY = 0;
    this._repairPersonalScrollY = 0;
    this._dragBpIndex = null;
    this._poolDragIndex = null;
    this._poolDragFromPos = -1;
    this.visible = true;
    this._scrollOffset = 0;
    if (this._isShipWorkbench && this._shipId > 0) {
      this.onRequestShipPool?.(this._shipId);
    }
  }

  close(): void {
    this.visible = false;
    this._dragBpIndex = null;
    this._poolDragIndex = null;
    this._poolDragFromPos = -1;
    this._repairHits = [];
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.visible) this._scrollOffset = 0;
  }

  handleMouseMove(x: number, y: number): void {
    this._mouseX = x;
    this._mouseY = y;
    if (this._dragBpIndex !== null) {
      this._dragX = x;
      this._dragY = y;
    }
    if (this._poolDragIndex !== null) {
      this._poolDragY = y;
    }
  }

  handleMouseDown(x: number, y: number, canvasWidth: number, canvasHeight: number): boolean {
    if (!this.visible || !this._isShipRepairView()) return false;
    for (const hit of this._repairHits) {
      if (hit.type === 'pool_drag') {
        if (hit.poolIndex === DEFAULT_POOL_INDEX) continue;
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          this._poolDragIndex = hit.poolIndex;
          this._poolDragFromPos = hit.pos;
          this._poolDragY = y;
          return true;
        }
        continue;
      }
      if (hit.type !== 'personal') continue;
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        this._dragBpIndex = hit.bpIndex;
        this._dragX = x;
        this._dragY = y;
        return true;
      }
    }
    return false;
  }

  handleMouseUp(x: number, y: number, _canvasWidth: number, _canvasHeight: number): boolean {
    if (this._poolDragIndex !== null) {
      const fromPos = this._poolDragFromPos;
      this._poolDragIndex = null;
      this._poolDragFromPos = -1;
      const filtered = this._filteredShipPool();
      const rowStride = REPAIR_ROW_H + REPAIR_ROW_GAP;
      const contentStartY = this._poolListOriginY - this._repairPoolScrollY;
      const toPos = Math.max(0, Math.min(filtered.length - 1,
        Math.floor((y - contentStartY) / rowStride)));
      if (toPos !== fromPos) {
        this._reorderPool(fromPos, toPos);
      }
      return true;
    }
    if (this._dragBpIndex === null) return false;
    const bpIndex = this._dragBpIndex;
    this._dragBpIndex = null;
    const zone = this._poolDropZone;
    if (zone && this._shipId > 0 &&
        x >= zone.x && x <= zone.x + zone.w &&
        y >= zone.y && y <= zone.y + zone.h) {
      this.onDepositToShipPool?.(this._shipId, bpIndex);
      return true;
    }
    return true;
  }

  handleWheel(deltaY: number, x = -1, y = -1): boolean {
    if (!this.visible) return false;
    if (this._isShipRepairView()) {
      const px = this._panelPx;
      const py = this._panelPy;
      const listX = px + SIDEBAR_W;
      const listY = this._contentTop(py);
      const poolBottom = listY + REPAIR_POOL_SECTION_H;
      const personalTop = poolBottom + 28;
      const sideH = PANEL_H - (listY - py) - FOOTER_H;
      const personalAreaH = sideH - REPAIR_POOL_SECTION_H - 28;
      const poolViewH = REPAIR_POOL_SECTION_H - 18;
      const poolContentH = this._poolDisplayItems().length * (REPAIR_ROW_H + REPAIR_ROW_GAP);
      const personalContentH = this._filteredPersonalSchematics().length * (REPAIR_ROW_H + REPAIR_ROW_GAP);
      const maxPoolScroll = Math.max(0, poolContentH - poolViewH);
      const maxPersonalScroll = Math.max(0, personalContentH - personalAreaH);
      if (x >= listX && y >= listY && y < poolBottom) {
        this._repairPoolScrollY = Math.max(0, Math.min(maxPoolScroll,
          this._repairPoolScrollY + deltaY * 0.5));
      } else if (y >= personalTop) {
        this._repairPersonalScrollY = Math.max(0, Math.min(maxPersonalScroll,
          this._repairPersonalScrollY + deltaY * 0.5));
      }
      return true;
    }
    const contentH = PANEL_H - HDR_H - FOOTER_H - (this._isShipWorkbench ? TOP_TAB_H : 0);
    let totalH: number;
    if (this._isIslandSchematicsView()) {
      totalH = this._schematics.length * (SCHEM_ROW_H + ROW_GAP) + CONTENT_PAD * 2;
    } else {
      const recipes = this._activeRecipes();
      totalH = recipes.length * (ROW_H + ROW_GAP) + CONTENT_PAD * 2;
    }
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
    this._panelPx = px;
    this._panelPy = py;
    this._repairHits = [];
    this._poolDropZone = null;

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

    ctx.font = 'bold 19px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_HEAD;
    ctx.fillText(this._isShipWorkbench ? '⚒  Ship Workbench' : '⚒  Workbench', px + PANEL_W / 2, py + HDR_H / 2);

    // ── Ship workbench: Craft / Repair top tabs ───────────────────────────
    let contentTop = py + HDR_H;
    if (this._isShipWorkbench) {
      const tabW = Math.floor(PANEL_W / 2);
      for (let i = 0; i < 2; i++) {
        const tab: TopTab = i === 0 ? 'craft' : 'repair';
        const active = this._topTab === tab;
        const tx = px + i * tabW;
        ctx.fillStyle = active ? 'rgba(140, 90, 20, 0.55)' : 'rgba(20, 14, 6, 0.5)';
        ctx.fillRect(tx, contentTop, tabW, TOP_TAB_H);
        ctx.strokeStyle = active ? BORDER : BORDER_DIM;
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeRect(tx, contentTop, tabW, TOP_TAB_H);
        ctx.font = `bold ${active ? 13 : 12}px Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = active ? TEXT_HEAD : TEXT_DIM;
        ctx.fillText(tab === 'craft' ? 'Craft' : 'Repair', tx + tabW / 2, contentTop + TOP_TAB_H / 2);
      }
      ctx.strokeStyle = BORDER_DIM;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, contentTop + TOP_TAB_H);
      ctx.lineTo(px + PANEL_W, contentTop + TOP_TAB_H);
      ctx.stroke();
      contentTop += TOP_TAB_H;
    }

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
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText('✕', closeX, closeY);

    // ── Sidebar ───────────────────────────────────────────────────────────
    const sideX = px;
    const sideY = contentTop;
    const sideH = PANEL_H - (contentTop - py) - FOOTER_H;

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

    const tabH = this._isShipWorkbench && this._topTab === 'repair' ? 48 : 72;
    const tabGap = 6;
    const tabsStartY = sideY + 16;

    if (this._isShipWorkbench && this._topTab === 'repair') {
      for (let i = 0; i < REPAIR_CATEGORIES.length; i++) {
        const cat = REPAIR_CATEGORIES[i];
        const active = cat.id === this._activeRepairCategory;
        const tx = sideX + 8;
        const ty = tabsStartY + i * (tabH + tabGap);

        ctx.fillStyle = active ? 'rgba(140, 90, 20, 0.55)' : 'rgba(30, 20, 8, 0.4)';
        ctx.strokeStyle = active ? BORDER : BORDER_DIM;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        ctx.roundRect(tx, ty, SIDEBAR_W - 16, tabH, 6);
        ctx.fill();
        ctx.stroke();

        if (active) {
          ctx.fillStyle = TEXT_HEAD;
          ctx.fillRect(tx, ty + 6, 3, tabH - 12);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tabCx = tx + (SIDEBAR_W - 16) / 2;
        ctx.font = '18px Georgia, serif';
        ctx.fillStyle = active ? '#fff' : '#aaa';
        ctx.fillText(cat.icon, tabCx, ty + tabH / 2 - 8);
        ctx.font = `${active ? 'bold ' : ''}10px Georgia, serif`;
        ctx.fillStyle = active ? TEXT_HEAD : TEXT_DIM;
        ctx.fillText(cat.label, tabCx, ty + tabH / 2 + 10);
      }
    } else {
      const sidebarCats = this._isShipWorkbench ? SHIP_CRAFT_CATEGORIES : CATEGORIES;
      for (let i = 0; i < sidebarCats.length; i++) {
        const cat = sidebarCats[i];
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

        if (active) {
          ctx.fillStyle = TEXT_HEAD;
          ctx.fillRect(tx, ty + 8, 3, tabH - 16);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tabCx = tx + (SIDEBAR_W - 16) / 2;
        ctx.font = '22px Georgia, serif';
        ctx.fillStyle = active ? '#fff' : '#aaa';
        ctx.fillText(cat.icon, tabCx, ty + tabH / 2 - 10);
        ctx.font = `${active ? 'bold ' : ''}11px Georgia, serif`;
        ctx.fillStyle = active ? TEXT_HEAD : TEXT_DIM;
        ctx.fillText(cat.id, tabCx, ty + tabH / 2 + 14);
      }
    }

    // ── Recipe list (clipped to content area) ────────────────────────────
    const listX = px + SIDEBAR_W;
    const listY = contentTop;
    const listW = PANEL_W - SIDEBAR_W;
    const listH = sideH;

    ctx.save();
    ctx.beginPath();
    ctx.rect(listX, listY, listW, listH);
    ctx.clip();

    const isSchem = this._isIslandSchematicsView();
    const isRepair = this._isShipRepairView();
    const recipes = isSchem || isRepair ? [] : this._activeRecipes();
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

      ctx.font = 'bold 18px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      if (r.id === 'craft_stone_axe') drawAxeIcon(ctx, iconX + iconSize / 2, iconY + iconSize / 2, iconSize);
      else if (r.id === 'craft_sword') drawSwordIcon(ctx, iconX + iconSize / 2, iconY + iconSize / 2, iconSize);
      else ctx.fillText(r.symbol, iconX + iconSize / 2, iconY + iconSize / 2);

      // Name + yield
      const textX = iconX + iconSize + 10;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 14px Georgia, serif';
      ctx.fillStyle = TEXT_HEAD;
      const yieldStr = r.outputCount > 1 ? ` ×${r.outputCount}` : '';
      ctx.fillText(r.outputName + yieldStr, textX, ry + 12);

      // Ingredients — each segment coloured green (have enough) or red (missing)
      const craftable = canCraft(inventory, r);
      ctx.font = '11px Georgia, serif';
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
      ctx.font = 'bold 12px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = craftable ? '#dfffcc' : '#777777';
      ctx.fillText('Craft', btnX + btnW / 2, btnY + btnH / 2);
    }

    // Ship repair tab — workbench pool + draggable personal schematics
    if (isRepair) {
      this._renderShipRepairTab(ctx, listX, listY, listW, listH, inventory);
    } else if (isSchem) {
      this._renderSchematicRows(ctx, listX, listY, listW, listH, this._schematics, inventory);
    }

    // Empty state
    if (!isSchem && !isRepair && recipes.length === 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '14px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('No recipes available', listX + listW / 2, listY + listH / 2);
    }

    ctx.restore(); // pop clip

    // ── Scroll indicator (fade at bottom of list) ─────────────────────────
    const totalH = isRepair
      ? 9999
      : isSchem
      ? this._schematics.length * (SCHEM_ROW_H + ROW_GAP) + CONTENT_PAD * 2
      : recipes.length * (ROW_H + ROW_GAP) + CONTENT_PAD * 2;
    if (!isRepair && totalH > listH) {
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

    ctx.font = '11px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_DIM;
    const footerMsg = isRepair
      ? '[E] close  •  drag pool rows (or ↑↓) for priority  •  drag schematics up to deposit'
      : '[E] close  •  scroll to browse';
    ctx.fillText(footerMsg, px + SIDEBAR_W + (PANEL_W - SIDEBAR_W) / 2, py + PANEL_H - FOOTER_H / 2);

    // Drag ghost while moving a personal schematic into the pool
    if (this._dragBpIndex !== null) {
      const dragged = this._filteredPersonalSchematics().find(s => s.index === this._dragBpIndex)
        ?? this._schematics.find(s => s.index === this._dragBpIndex);
      if (dragged) {
        const col = tierColor(dragged.tier);
        const gw = 200;
        const gh = 68;
        const gx = this._dragX - gw / 2;
        const gy = this._dragY - gh / 2;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(20, 14, 6, 0.95)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(gx, gy, gw, gh, 4);
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.font = 'bold 11px Georgia, serif';
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${tierName(dragged.tier)} ${itemDisplayName(dragged.item)}`, gx + 8, gy + 6);
        ctx.font = '10px Georgia, serif';
        ctx.fillStyle = TEXT_DIM;
        ctx.fillText(`${dragged.crafts} crafts`, gx + 8, gy + 22);
        this._drawSchematicStatLine(ctx, dragged, gx + 8, gy + 36);
        this._drawSchematicCostChips(ctx, dragged, gx + 8, gy + 50, gw - 16);
      }
    }

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
    const listY = this._contentTop(py);
    const listW = PANEL_W - SIDEBAR_W;
    const sideH = PANEL_H - (listY - py) - FOOTER_H;
    const listH = sideH;

    // Only check when mouse is inside the list area
    if (mx < listX || mx > listX + listW || my < listY || my > listY + listH) return;

    const recipes = this._activeRecipes();
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
          craft_deck:        'deck',
          craft_ramp:        'ramp',
          craft_sail:        'sail',
          craft_helm_kit:    'helm_kit',
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
        const font12 = '12px Georgia, serif';
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
        ctx.font      = 'bold 14px Georgia, serif';
        ctx.fillText(def.name, tx + PAD + 4, cy);
        cy += nameH + 4;

        ctx.fillStyle = '#888888';
        ctx.font      = '11px Georgia, serif';
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

  /** Ship workbench Repair tab — pool (top) + personal schematics (bottom, draggable). */
  private _renderShipRepairTab(
    ctx: CanvasRenderingContext2D,
    listX: number, listY: number, listW: number, listH: number,
    inventory: PlayerInventory | null,
  ): void {
    const res = inventory?.resources;
    const poolItems = this._poolDisplayItems();
    const depositedCount = this._filteredShipPool().length;
    const personal = this._filteredPersonalSchematics();
    const poolAreaH = REPAIR_POOL_SECTION_H;
    const personalTop = listY + poolAreaH + 28;
    const personalAreaH = listH - poolAreaH - 28;

    this._poolDropZone = { x: listX + 4, y: listY + 18, w: listW - 8, h: poolAreaH - 18 };

    // Pool section header
    ctx.font = 'bold 11px Georgia, serif';
    ctx.fillStyle = TEXT_HEAD;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Workbench pool — drag or ↑↓ to set priority', listX + 10, listY + 4);

    // Pool drop highlight when dragging
    if (this._dragBpIndex !== null && this._poolDropZone) {
      const z = this._poolDropZone;
      ctx.fillStyle = 'rgba(68,204,102,0.08)';
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.setLineDash([]);
      ctx.fillRect(z.x, z.y, z.w, z.h);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(listX, listY + 18, listW, poolAreaH - 18);
    ctx.clip();

    let rowY = listY + 22 - this._repairPoolScrollY;
    this._poolListOriginY = listY + 22;
    if (depositedCount === 0) {
      ctx.font = '11px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText('Drag schematics here to override the default below', listX + listW / 2, listY + 28);
    }
    for (let i = 0; i < poolItems.length; i++) {
      const entry = poolItems[i];
      const isDefault = this._isDefaultPoolEntry(entry);
      if (this._poolDragIndex === entry.index) {
        rowY += REPAIR_ROW_H + REPAIR_ROW_GAP;
        continue;
      }
      if (rowY + REPAIR_ROW_H >= listY + 18 && rowY <= listY + poolAreaH) {
        this._drawRepairPoolRow(ctx, listX + 8, rowY, listW - 16, entry, i, depositedCount, res, isDefault);
      }
      rowY += REPAIR_ROW_H + REPAIR_ROW_GAP;
    }

    // Pool drag overlay — drop indicator + ghost row (deposited rows only)
    if (this._poolDragIndex !== null) {
      const deposited = this._filteredShipPool();
      const dragged = deposited.find(e => e.index === this._poolDragIndex);
      if (dragged) {
        const rowStride = REPAIR_ROW_H + REPAIR_ROW_GAP;
        const contentStartY = this._poolListOriginY - this._repairPoolScrollY;
        const dropIdx = Math.max(0, Math.min(deposited.length - 1,
          Math.floor((this._poolDragY - contentStartY) / rowStride)));
        const dropY = contentStartY + dropIdx * rowStride;
        ctx.strokeStyle = '#aac8ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(listX + 10, dropY);
        ctx.lineTo(listX + listW - 10, dropY);
        ctx.stroke();
        ctx.fillStyle = 'rgba(80,140,220,0.12)';
        ctx.fillRect(listX + 8, dropY, listW - 16, REPAIR_ROW_H);

        const ghostY = Math.max(listY + 18,
          Math.min(listY + poolAreaH - REPAIR_ROW_H, this._poolDragY - REPAIR_ROW_H / 2));
        ctx.globalAlpha = 0.9;
        const col = tierColor(dragged.tier);
        ctx.fillStyle = 'rgba(20, 14, 6, 0.95)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(listX + 8, ghostY, listW - 16, REPAIR_ROW_H, 4);
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.font = 'bold 12px Georgia, serif';
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`⣿ ${tierName(dragged.tier)} ${itemDisplayName(dragged.item)}`, listX + 16, ghostY + 16);
        ctx.font = '10px Georgia, serif';
        ctx.fillStyle = TEXT_DIM;
        ctx.fillText(`${dragged.crafts} crafts`, listX + 16, ghostY + 34);
      }
    }

    ctx.restore();

    // Personal section header
    ctx.font = 'bold 11px Georgia, serif';
    ctx.fillStyle = TEXT_HEAD;
    ctx.textAlign = 'left';
    ctx.fillText('Your schematics — drag into pool above', listX + 10, listY + poolAreaH + 8);
    ctx.strokeStyle = BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(listX + 8, listY + poolAreaH + 24);
    ctx.lineTo(listX + listW - 8, listY + poolAreaH + 24);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(listX, personalTop, listW, personalAreaH);
    ctx.clip();

    rowY = personalTop + 4 - this._repairPersonalScrollY;
    if (personal.length === 0) {
      ctx.font = '12px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText('No schematics for this module type', listX + listW / 2, personalTop + personalAreaH / 2);
    }
    for (const entry of personal) {
      if (this._dragBpIndex === entry.index) {
        rowY += REPAIR_ROW_H + REPAIR_ROW_GAP;
        continue;
      }
      if (rowY + REPAIR_ROW_H >= personalTop && rowY <= personalTop + personalAreaH) {
        this._drawRepairPersonalRow(ctx, listX + 8, rowY, listW - 16, entry, res);
      }
      rowY += REPAIR_ROW_H + REPAIR_ROW_GAP;
    }
    ctx.restore();
  }

  /** Abbreviated stat line shared by pool and personal repair rows. */
  private _drawSchematicStatLine(
    ctx: CanvasRenderingContext2D,
    entry: SchematicEntry,
    x: number,
    y: number,
  ): void {
    ctx.font = '10px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let sx = x;
    let drew = false;
    for (let st = 0; st < entry.stats.length; st++) {
      const lbl = statMultLabel(entry.stats[st]);
      if (lbl === null) continue;
      const abbr = (QUALITY_STAT_NAMES[st] ?? '').split(' ').map(w => w.charAt(0)).join('');
      const seg = (drew ? '  ' : '') + `${abbr} ${lbl}`;
      ctx.fillStyle = '#9fd0a0';
      ctx.fillText(seg, sx, y);
      sx += ctx.measureText(seg).width;
      drew = true;
    }
    if (entry.tier >= 1) {
      const bonusLabel = `+${entry.tier * 10}% Tier`;
      const seg = (drew ? '  ' : '') + bonusLabel;
      ctx.fillStyle = tierColor(entry.tier);
      ctx.fillText(seg, sx, y);
    }
  }

  /** Resource cost chips — green when affordable, red when short (mirrors server craft cost). */
  private _drawSchematicCostChips(
    ctx: CanvasRenderingContext2D,
    entry: SchematicEntry,
    x: number,
    y: number,
    maxW: number,
    resources?: { wood: number; fiber: number; metal: number; stone: number },
  ): void {
    const cost = schematicCraftCost(entry);
    const chips: Array<{ label: string; cost: number; have: number }> = [
      { label: 'Wood',  cost: cost.wood,  have: resources?.wood  ?? 0 },
      { label: 'Fiber', cost: cost.fiber, have: resources?.fiber ?? 0 },
      { label: 'Metal', cost: cost.metal, have: resources?.metal ?? 0 },
      { label: 'Stone', cost: cost.stone, have: resources?.stone ?? 0 },
    ].filter(c => c.cost > 0);
    if (chips.length === 0) return;

    ctx.font = '10px Georgia, serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    let rx = x;
    for (const c of chips) {
      const ok = c.have >= c.cost;
      const chip = `${c.cost}\u00d7 ${c.label}`;
      const chipW = ctx.measureText(chip).width + 8;
      if (rx + chipW > x + maxW) break;
      ctx.fillStyle = ok ? 'rgba(40,100,40,0.55)' : 'rgba(120,30,30,0.55)';
      ctx.beginPath();
      ctx.roundRect(rx, y, chipW, 16, 3);
      ctx.fill();
      ctx.fillStyle = ok ? '#88ee88' : '#ee8888';
      ctx.fillText(chip, rx + 4, y + 3);
      rx += chipW + 4;
    }
  }

  private _drawRepairPoolRow(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number,
    entry: ShipSchematicEntry, pos: number, depositedCount: number,
    resources?: { wood: number; fiber: number; metal: number; stone: number },
    isDefault = false,
  ): void {
    const col = tierColor(entry.tier);
    ctx.fillStyle = isDefault ? 'rgba(30, 30, 35, 0.55)' : 'rgba(40, 28, 10, 0.65)';
    ctx.strokeStyle = isDefault ? '#666677' : col;
    ctx.lineWidth = isDefault ? 1 : 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, REPAIR_ROW_H, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 12px Georgia, serif';
    ctx.fillStyle = isDefault ? '#9d9d9d' : col;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const prefix = isDefault ? 'Default' : `#${pos + 1}`;
    ctx.fillText(`${prefix}  ${tierName(entry.tier)} ${itemDisplayName(entry.item)}`, x + 8, y + 8);
    ctx.font = '10px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    if (isDefault) {
      ctx.fillText('Fallback — NPCs use when no blueprint applies', x + 8, y + 24);
      ctx.fillStyle = '#777788';
      ctx.fillText('No quality bonuses', x + 8, y + 38);
    } else {
      ctx.fillText(`${entry.crafts} craft${entry.crafts === 1 ? '' : 's'} left`, x + 8, y + 24);
      this._drawSchematicStatLine(ctx, entry, x + 8, y + 38);
    }
    this._drawSchematicCostChips(ctx, entry, x + 8, y + 54, w - (isDefault ? 8 : REPAIR_POOL_BTN_W) - 8, resources);

    if (isDefault) return;

    // Drag handle + row body (excludes priority / withdraw buttons on the right)
    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = 'rgba(180,160,120,0.45)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('⋮⋮', x + w - REPAIR_POOL_BTN_W - 18, y + REPAIR_ROW_H / 2);

    const dragW = w - REPAIR_POOL_BTN_W;
    this._repairHits.push({
      type: 'pool_drag', poolIndex: entry.index, pos,
      x, y, w: dragW, h: REPAIR_ROW_H,
    });

    const btnW = 24;
    const btnH = 20;
    const btnY = y + (REPAIR_ROW_H - btnH) / 2;
    let bx = x + w - 8 - btnW;

    // Withdraw
    ctx.fillStyle = 'rgba(255,100,80,0.15)';
    ctx.fillRect(bx - btnW - 4, btnY, btnW + 4, btnH);
    ctx.strokeStyle = '#a44';
    ctx.strokeRect(bx - btnW - 4, btnY, btnW + 4, btnH);
    ctx.font = '9px Georgia, serif';
    ctx.fillStyle = '#f88';
    ctx.textAlign = 'center';
    ctx.fillText('Out', bx - btnW / 2 - 2, btnY + btnH / 2);
    this._repairHits.push({ type: 'pool_withdraw', poolIndex: entry.index, x: bx - btnW - 4, y: btnY, w: btnW + 4, h: btnH });
    bx -= btnW + 8;

    const canDown = pos < depositedCount - 1;
    ctx.fillStyle = canDown ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(bx - btnW, btnY, btnW, btnH);
    ctx.strokeStyle = canDown ? BORDER : '#222';
    ctx.strokeRect(bx - btnW, btnY, btnW, btnH);
    ctx.fillStyle = canDown ? TEXT_HEAD : '#444';
    ctx.fillText('↓', bx - btnW / 2, btnY + btnH / 2);
    if (canDown) this._repairHits.push({ type: 'pool_down', poolIndex: entry.index, x: bx - btnW, y: btnY, w: btnW, h: btnH });
    bx -= btnW + 4;

    const canUp = pos > 0;
    ctx.fillStyle = canUp ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(bx - btnW, btnY, btnW, btnH);
    ctx.strokeStyle = canUp ? BORDER : '#222';
    ctx.strokeRect(bx - btnW, btnY, btnW, btnH);
    ctx.fillStyle = canUp ? TEXT_HEAD : '#444';
    ctx.fillText('↑', bx - btnW / 2, btnY + btnH / 2);
    if (canUp) this._repairHits.push({ type: 'pool_up', poolIndex: entry.index, x: bx - btnW, y: btnY, w: btnW, h: btnH });
  }

  private _drawRepairPersonalRow(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number,
    entry: SchematicEntry,
    resources?: { wood: number; fiber: number; metal: number; stone: number },
  ): void {
    const col = tierColor(entry.tier);
    ctx.fillStyle = 'rgba(68,204,102,0.06)';
    ctx.strokeStyle = 'rgba(68,204,102,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, REPAIR_ROW_H, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 12px Georgia, serif';
    ctx.fillStyle = col;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${tierName(entry.tier)} ${itemDisplayName(entry.item)}`, x + 8, y + 8);
    ctx.font = '10px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(`${entry.crafts} craft${entry.crafts === 1 ? '' : 's'} left`, x + 8, y + 24);
    this._drawSchematicStatLine(ctx, entry, x + 8, y + 38);
    this._drawSchematicCostChips(ctx, entry, x + 8, y + 54, w - 56, resources);

    ctx.font = '10px Georgia, serif';
    ctx.fillStyle = GREEN;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('drag ▲', x + w - 8, y + REPAIR_ROW_H / 2);

    this._repairHits.push({ type: 'personal', bpIndex: entry.index, x, y, w, h: REPAIR_ROW_H });
  }

  private _reorderPool(fromPos: number, toPos: number): void {
    const filtered = this._filteredShipPool();
    if (fromPos < 0 || toPos < 0 || fromPos >= filtered.length || toPos >= filtered.length) return;
    if (fromPos === toPos || this._shipId <= 0) return;
    const cat = REPAIR_CATEGORIES.find(c => c.id === this._activeRepairCategory) ?? REPAIR_CATEGORIES[0];
    const reordered = filtered.map(e => e.index);
    const [item] = reordered.splice(fromPos, 1);
    reordered.splice(toPos, 0, item);
    this.onReorderShipPool?.(this._shipId, cat.itemId, reordered);
  }

  private _movePoolPriority(poolIndex: number, up: boolean): void {
    const filtered = this._filteredShipPool();
    const pos = filtered.findIndex(e => e.index === poolIndex);
    if (pos < 0) return;
    const swapPos = up ? pos - 1 : pos + 1;
    if (swapPos < 0 || swapPos >= filtered.length) return;
    this._reorderPool(pos, swapPos);
  }

  /** Render the owned-schematics list (island workbench Schematics tab). Caller has already clipped. */
  private _renderSchematicRows(
    ctx: CanvasRenderingContext2D,
    listX: number, listY: number, listW: number, listH: number,
    schematics: SchematicEntry[],
    inventory: PlayerInventory | null = null,
  ): void {
    const res = inventory?.resources;
    if (schematics.length === 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('No schematics — salvage blueprints from shipwrecks.', listX + listW / 2, listY + listH / 2);
      return;
    }

    const bodyY = listY + CONTENT_PAD - this._scrollOffset;
    const iconSize = 46;
    const btnW = 72;
    const btnH = 30;
    const btnX = listX + listW - 16 - btnW;

    for (let i = 0; i < schematics.length; i++) {
      const s  = schematics[i];
      const ry = bodyY + i * (SCHEM_ROW_H + ROW_GAP);
      if (ry + SCHEM_ROW_H < listY || ry > listY + listH) continue;

      const col = tierColor(s.tier);

      // Row background with a tier-coloured border
      ctx.fillStyle = 'rgba(40, 28, 10, 0.65)';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(listX + 8, ry, listW - 16, SCHEM_ROW_H, 5);
      ctx.fill();
      ctx.stroke();

      // Tier-coloured icon box with the item's initial
      const iconX = listX + 16;
      const iconY = ry + (SCHEM_ROW_H - iconSize) / 2;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(iconX, iconY, iconSize, iconSize, 5);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(iconX, iconY, iconSize, iconSize, 5);
      ctx.stroke();

      const name = itemDisplayName(s.item);
      ctx.font = '22px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col;
      ctx.fillText(name.charAt(0).toUpperCase(), iconX + iconSize / 2, iconY + iconSize / 2);

      // Name + tier + crafts remaining
      const textX = iconX + iconSize + 10;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 14px Georgia, serif';
      ctx.fillStyle = col;
      ctx.fillText(`${tierName(s.tier)} ${name}`, textX, ry + 10);

      ctx.font = '11px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(`${s.crafts} craft${s.crafts === 1 ? '' : 's'} left`, textX, ry + 30);

      this._drawSchematicStatLine(ctx, s, textX, ry + 48);
      this._drawSchematicCostChips(ctx, s, textX, ry + 66, btnX - textX - 8, res);

      // Craft button (enabled while crafts remain)
      const canDo = s.crafts > 0;
      const btnY = ry + (SCHEM_ROW_H - btnH) / 2;
      ctx.fillStyle = canDo ? 'rgba(60, 130, 50, 0.9)' : 'rgba(50, 50, 50, 0.7)';
      ctx.strokeStyle = canDo ? '#55bb35' : '#444444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(btnX, btnY, btnW, btnH, 5);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 12px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = canDo ? '#dfffcc' : '#777777';
      ctx.fillText('Craft', btnX + btnW / 2, btnY + btnH / 2);
    }
  }

  /**
   * Returns true if the click was consumed by the crafting menu.
   * Pass canvas-space (screen) coordinates.
   */
  handleClick(x: number, y: number, canvasWidth: number, canvasHeight: number, inventory: PlayerInventory | null = null): boolean {
    if (!this.visible) return false;
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - PANEL_H) / 2);
    const contentTop = this._contentTop(py);

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

    // Ship workbench — Craft / Repair top tabs
    if (this._isShipWorkbench) {
      const tabW = Math.floor(PANEL_W / 2);
      if (y >= py + HDR_H && y <= py + HDR_H + TOP_TAB_H) {
        this._topTab = x < px + tabW ? 'craft' : 'repair';
        this._scrollOffset = 0;
        this._repairPoolScrollY = 0;
        this._repairPersonalScrollY = 0;
        if (this._topTab === 'repair' && this._shipId > 0) {
          this.onRequestShipPool?.(this._shipId);
        }
        return true;
      }
    }

    // ── Category tab clicks ───────────────────────────────────────────────
    const sideX = px;
    const sideY = contentTop;
    const tabH = this._isShipWorkbench && this._topTab === 'repair' ? 48 : 72;
    const tabGap = 6;
    const tabsStartY = sideY + 16;

    if (x >= sideX && x <= sideX + SIDEBAR_W) {
      if (this._isShipWorkbench && this._topTab === 'repair') {
        for (let i = 0; i < REPAIR_CATEGORIES.length; i++) {
          const ty = tabsStartY + i * (tabH + tabGap);
          if (y >= ty && y <= ty + tabH) {
            this._activeRepairCategory = REPAIR_CATEGORIES[i].id;
            this._repairPoolScrollY = 0;
            this._repairPersonalScrollY = 0;
            return true;
          }
        }
      } else {
        const sidebarCats = this._isShipWorkbench ? SHIP_CRAFT_CATEGORIES : CATEGORIES;
        for (let i = 0; i < sidebarCats.length; i++) {
          const ty = tabsStartY + i * (tabH + tabGap);
          if (y >= ty && y <= ty + tabH) {
            this._activeCategory = sidebarCats[i].id;
            this._scrollOffset = 0;
            return true;
          }
        }
      }
      return true;
    }

    // ── Recipe craft button clicks ────────────────────────────────────────
    const listX = px + SIDEBAR_W;
    const listY = contentTop;
    const listW = PANEL_W - SIDEBAR_W;
    const sideH = PANEL_H - (contentTop - py) - FOOTER_H;
    const listH = sideH;

    if (x >= listX && x <= listX + listW && y >= listY && y <= listY + listH) {
      // Ship repair tab — pool priority / withdraw (personal rows use drag)
      if (this._isShipRepairView()) {
        for (const hit of this._repairHits) {
          if (x < hit.x || x > hit.x + hit.w || y < hit.y || y > hit.y + hit.h) continue;
          if (hit.type === 'personal') {
            return true; // drag handled on mouse down/up
          }
          if (hit.poolIndex === DEFAULT_POOL_INDEX) continue;
          if (hit.type === 'pool_up') {
            this._movePoolPriority(hit.poolIndex, true);
            return true;
          }
          if (hit.type === 'pool_down') {
            this._movePoolPriority(hit.poolIndex, false);
            return true;
          }
          if (hit.type === 'pool_withdraw' && this._shipId > 0) {
            this.onWithdrawFromShipPool?.(this._shipId, hit.poolIndex);
            return true;
          }
        }
        return true;
      }

      const btnW = 72;
      const btnH = 30;
      const btnX = listX + listW - 16 - btnW;
      const bodyY = listY + CONTENT_PAD - this._scrollOffset;

      if (this._isIslandSchematicsView()) {
        for (let i = 0; i < this._schematics.length; i++) {
          const ry = bodyY + i * (SCHEM_ROW_H + ROW_GAP);
          const btnY = ry + (SCHEM_ROW_H - btnH) / 2;
          if (x >= btnX && x <= btnX + btnW && y >= btnY && y <= btnY + btnH) {
            const s = this._schematics[i];
            if (s && s.crafts > 0) this.onCraftSchematic?.(s.index);
            return true;
          }
        }
        return true;
      }

      const recipes = this._activeRecipes();

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
