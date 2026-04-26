/**
 * PlayerMenu.ts
 *
 * Canvas-drawn modal showing the local player's character sheet.
 * Toggled by pressing [E] when not interacting with a module.
 *
 * Sections:
 *  • Identity   — name, ID, company, position
 *  • Status     — mount state, movement
 *  • Inventory  — hotbar slots + equipment
 */

import {
  WorldState,
  COMPANY_NEUTRAL,
  COMPANY_PIRATES,
  COMPANY_NAVY,
} from '../../sim/Types.js';
import { ITEM_DEFS, ItemKind, HOTBAR_SLOTS, ITEM_KIND_ID } from '../../sim/Inventory.js';

// ── Shared palette (mirrors CompanyMenu) ─────────────────────────────────────

const COMPANY_NAMES: Record<number, string> = {
  [COMPANY_NEUTRAL]: 'Neutral',
  [COMPANY_PIRATES]: 'Pirates',
  [COMPANY_NAVY]:    'Navy',
};

const COMPANY_COLORS: Record<number, string> = {
  [COMPANY_NEUTRAL]: '#aaaaaa',
  [COMPANY_PIRATES]: '#ff6644',
  [COMPANY_NAVY]:    '#4488ff',
};

// ─────────────────────────────────────────────────────────────────────────────

const PANEL_W  = 640;
const TAB_H    = 32;
const PANEL_H  = 900;
const PAD      = 18;
const HEADER_H = 40;
const ROW_H    = 22;

const BG_DARK   = 'rgba(10, 12, 20, 0.96)';
const BG_PANEL  = 'rgba(20, 24, 36, 0.98)';
const BG_STRIPE = 'rgba(255, 255, 255, 0.04)';
const BORDER    = '#334';
const TEXT_HEAD = '#e8e0cc';
const TEXT_DIM  = '#778';
const TEXT_MONO = '#c0b890';
const GOLD      = '#ffd700';
const GREEN     = '#66dd88';
const ORANGE    = '#ffaa44';

const SLOT_SZ  = 40;
const SLOT_GAP = 5;

// ── Player stat configuration (mirrors CrewLevelMenu STATS) ──────────────────
type AnyPlayer = NonNullable<ReturnType<WorldState['players']['find']>>;
interface StatDef {
  key:        'statHealth' | 'statDamage' | 'statStamina' | 'statWeight';
  server:     string;
  label:      string;
  currentVal: (player: AnyPlayer, statLvl: number) => string; // actual current value
  gainPerPt:  string;  // gain shown per stat point (e.g. "+20 HP")
  color:      string;
}

const PLAYER_MAX_LEVEL = 120;

const STATS: StatDef[] = [
  { key: 'statHealth',  server: 'health',  label: 'Health',
    currentVal: (p, _l) => `${p.maxHealth} HP`,
    gainPerPt:  '+20 HP',
    color: '#44cc66' },
  { key: 'statDamage',  server: 'damage',  label: 'Damage',
    currentVal: (_p, l) => l > 0 ? `+${l * 10}% dmg` : 'base',
    gainPerPt:  '+10% dmg',
    color: '#ff5544' },
  { key: 'statStamina', server: 'stamina', label: 'Stamina',
    currentVal: (p, _l) => `${p.maxStamina ?? 100} ST`,
    gainPerPt:  '+10% spd',
    color: '#ffaa44' },
  { key: 'statWeight',  server: 'weight',  label: 'Weight',
    currentVal: (_p, l) => l > 0 ? `+${l * 10}% carry` : 'base',
    gainPerPt:  '+10% carry',
    color: '#88ccff' },
];

interface BtnHit {
  serverKey: string;
  x: number; y: number; w: number; h: number;
  affordable: boolean;
}

interface CraftHit {
  recipeIdx: number;
  x: number; y: number; w: number; h: number;
}

interface HandRecipe {
  output: ItemKind;
  outputQty: number;
  cost: Array<{ item: ItemKind; qty: number }>;
  category: string;
}

const HAND_RECIPES: HandRecipe[] = [
  // Survival
  { output: 'repair_kit',    outputQty: 1, cost: [{ item: 'wood',  qty: 4  }],                                    category: 'SURVIVAL'     },
  // Armor
  { output: 'cloth_armor',   outputQty: 1, cost: [{ item: 'fiber', qty: 8  }],                                    category: 'ARMOR'        },
  { output: 'wooden_shield', outputQty: 1, cost: [{ item: 'wood',  qty: 6  }],                                    category: 'ARMOR'        },
  // Tools
  { output: 'axe',           outputQty: 1, cost: [{ item: 'wood',  qty: 3  }, { item: 'stone', qty: 2 }],         category: 'TOOLS'        },
  { output: 'pickaxe',       outputQty: 1, cost: [{ item: 'wood',  qty: 2  }, { item: 'stone', qty: 4 }],         category: 'TOOLS'        },
  // Construction
  { output: 'wooden_floor',  outputQty: 2, cost: [{ item: 'wood',  qty: 4  }],                                    category: 'CONSTRUCTION' },
  { output: 'workbench',     outputQty: 1, cost: [{ item: 'wood',  qty: 10 }],                                    category: 'CONSTRUCTION' },
];

export class PlayerMenu {
  public visible = false;
  private activeTab: 'character' | 'skills' = 'character';

  /** Set by UIManager; called when the player clicks an affordable upgrade button. */
  public onUpgradeRequest: ((stat: string) => void) | null = null;

  // Cached panel origin — set each render frame, used by handleClick
  private _panelX = 0;
  private _panelY = 0;
  private _btnHits: BtnHit[] = [];
  private _craftBtnHits: CraftHit[] = [];
  private _craftTab = 'SURVIVAL';
  private _craftTabHits: Array<{ label: string; x: number; y: number; w: number; h: number }> = [];

  /** Called when player clicks an affordable CRAFT button. */
  public onCraftRequest: ((outputItem: ItemKind, qty: number) => void) | null = null;

  // Inventory grid scroll state
  private _invScrollY    = 0;
  private _invGridY      = 0;   // canvas-y where the grid slots start
  private _invContentH   = 0;   // total pixel height of all rows
  private _invViewportH  = 0;   // clipped viewport height

  // Drag-and-drop state
  private _dragSlot    = -1;   // source slot index, -1 = not dragging
  private _dragX       = 0;
  private _dragY       = 0;
  private _dragISZ     = 0;    // slot size at drag start (for ghost sizing)
  private _dragStartIX = 0;    // startIX at drag start
  private _dragStride  = 0;    // STRIDE at drag start

  /** Called when the player drags a slot onto another; args are (fromSlot, toSlot). */
  public onSwapRequest: ((fromSlot: number, toSlot: number) => void) | null = null;

  /** Called when the player drags an item outside the panel to drop it in the world. */
  public onDropItem: ((fromSlot: number) => void) | null = null;

  toggle(): void { this.visible = !this.visible; }
  open():   void { this.visible = true; this.activeTab = 'character'; }
  close():  void { this.visible = false; }

  /** Open directly to the Skills tab. */
  openSkillsTab(): void { this.visible = true; this.activeTab = 'skills'; }

  /**
   * Handle a click inside the player menu.
   * Returns true if the click was consumed (tab switch or click inside panel).
   * Returns false if the click was outside the panel (so UIManager can close the menu).
   */
  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;
    const px = this._panelX, py = this._panelY;
    // Outside panel → signal UIManager to close
    if (x < px || x > px + PANEL_W || y < py || y > py + PANEL_H) return false;

    // Tab bar region
    const tabBarY = py + HEADER_H;
    if (y >= tabBarY && y < tabBarY + TAB_H) {
      const tabW = PANEL_W / 2;
      this.activeTab = x < px + tabW ? 'character' : 'skills';
      return true;
    }

    // Upgrade buttons
    for (const btn of this._btnHits) {
      if (btn.affordable &&
          x >= btn.x && x <= btn.x + btn.w &&
          y >= btn.y && y <= btn.y + btn.h) {
        this.onUpgradeRequest?.(btn.serverKey);
        return true;
      }
    }

    // Craft category tabs
    for (const tab of this._craftTabHits) {
      if (x >= tab.x && x <= tab.x + tab.w &&
          y >= tab.y && y <= tab.y + tab.h) {
        this._craftTab = tab.label;
        return true;
      }
    }

    // Craft buttons
    for (const btn of this._craftBtnHits) {
      if (x >= btn.x && x <= btn.x + btn.w &&
          y >= btn.y && y <= btn.y + btn.h) {
        const r = HAND_RECIPES[btn.recipeIdx];
        this.onCraftRequest?.(r.output, r.outputQty);
        return true;
      }
    }

    return true; // click inside panel — consume to avoid accidental close
  }

  /** Handle mouse-wheel over the inventory grid. Returns true if consumed. */
  handleWheel(deltaY: number, _x: number, y: number): boolean {
    if (!this.visible || this.activeTab !== 'character') return false;
    if (y < this._invGridY || y > this._invGridY + this._invViewportH) return false;
    const maxScroll = Math.max(0, this._invContentH - this._invViewportH);
    if (maxScroll === 0) return false;
    this._invScrollY = Math.max(0, Math.min(maxScroll, this._invScrollY + deltaY * 0.4));
    return true;
  }

  /** Begin a drag if the mousedown lands on an inventory slot. Returns true if consumed. */
  handleMouseDown(x: number, y: number, inv: { slots: { item: ItemKind; quantity: number }[] }): boolean {
    if (!this.visible || this.activeTab !== 'character') return false;
    const slot = this._slotAt(x, y);
    if (slot === -1) return false;
    if ((inv.slots[slot]?.item ?? 'none') === 'none') return false;
    this._dragSlot = slot;
    this._dragX    = x;
    this._dragY    = y;
    return true;
  }

  /** Update drag ghost position. */
  handleMouseMove(x: number, y: number): void {
    if (this._dragSlot !== -1) {
      this._dragX = x;
      this._dragY = y;
    }
  }

  /**
   * End the drag — if dropped on a different slot, fires onSwapRequest.
   * If dropped outside the panel, fires onDropItem.
   * Returns true if consumed.
   */
  handleMouseUp(x: number, y: number): boolean {
    if (this._dragSlot === -1) return false;
    const fromSlot = this._dragSlot;
    this._dragSlot = -1;

    // Detect outside-panel drop
    const px = this._panelX, py = this._panelY;
    const outsidePanel = x < px || x > px + PANEL_W || y < py || y > py + PANEL_H;
    if (outsidePanel) {
      this.onDropItem?.(fromSlot);
      return true;
    }

    const toSlot = this._slotAt(x, y);
    if (toSlot !== -1 && toSlot !== fromSlot) {
      this.onSwapRequest?.(fromSlot, toSlot);
    }
    return true;
  }

  /** Returns the inventory slot index under (x, y), or -1 if none. */
  private _slotAt(x: number, y: number): number {
    if (!this._dragISZ) return -1; // grid not rendered yet
    const ISZ    = this._dragISZ;
    const STRIDE = this._dragStride;
    const COLS   = 10;
    const ROWS   = 6;
    // must be inside the viewport
    if (y < this._invGridY || y > this._invGridY + this._invViewportH) return -1;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i  = row * COLS + col;
        if (i >= 58) break;
        const sx = this._dragStartIX + col * STRIDE;
        const sy = this._invGridY + row * STRIDE - this._invScrollY;
        if (x >= sx && x <= sx + ISZ && y >= sy && y <= sy + ISZ) return i;
      }
    }
    return -1;
  }

  render(
    ctx:             CanvasRenderingContext2D,
    worldState:      WorldState,
    assignedId:      number | null | undefined,
    mouseX = 0,
    mouseY = 0,
  ): void {
    if (!this.visible) return;

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, ch);

    const px = Math.round((cw - PANEL_W) / 2);
    const py = Math.round((ch - PANEL_H) / 2);

    // Cache for handleClick
    this._panelX = px;
    this._panelY = py;

    ctx.fillStyle   = BG_PANEL;
    ctx.fillRect(px, py, PANEL_W, PANEL_H);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(px, py, PANEL_W, PANEL_H);

    let cur = py;
    cur = this._header(ctx, px, cur);
    cur = this._tabBar(ctx, px, cur);

    this._btnHits = [];
    this._craftBtnHits = [];
    this._craftTabHits = [];

    const player = assignedId != null
      ? worldState.players.find(p => p.id === assignedId)
      : worldState.players[0] ?? null;

    if (this.activeTab === 'skills') {
      this._skillsTab(ctx, px, cur, py + PANEL_H, player ?? null);
      ctx.restore();
      return;
    }

    if (!player) {
      ctx.font = '14px Consolas, monospace';
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('  No player data.', px + PAD, cur + 8);
      ctx.restore();
      return;
    }

    const ship = player.carrierId
      ? worldState.ships.find(s => s.id === player.carrierId) ?? null
      : null;

    cur = this._equipmentAndStatus(ctx, px, cur, player, ship, worldState, mouseX, mouseY);
    cur = this._playerCrafting(ctx, px, cur, player);
    cur = this._inventoryGrid(ctx, px, cur, player, mouseX, mouseY);

    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────────────────

  private _header(ctx: CanvasRenderingContext2D, px: number, py: number): number {
    ctx.fillStyle = 'rgba(255,215,0,0.06)';
    ctx.fillRect(px, py, PANEL_W, HEADER_H);

    ctx.font = 'bold 17px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText('⚔  CHARACTER', px + PAD, py + HEADER_H / 2);

    ctx.font = '12px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('[O / I / ESC] close', px + PANEL_W - PAD, py + HEADER_H / 2);

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + HEADER_H);
    ctx.lineTo(px + PANEL_W, py + HEADER_H);
    ctx.stroke();

    return py + HEADER_H;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Equipment grid (left) + Status rows (right) side by side

  private _equipmentAndStatus(
    ctx:         CanvasRenderingContext2D,
    px:          number, py: number,
    player:      NonNullable<ReturnType<WorldState['players']['find']>>,
    ship:        ReturnType<WorldState['ships']['find']> | null,
    _worldState: WorldState,
    mouseX = 0, mouseY = 0,
  ): number {
    py = this._sectionHeader(ctx, px, py, 'EQUIPMENT & STATUS', '');
    py += 8;

    const ESLOTSZ    = 46;
    const ESGAP      = 8;
    const LABEL_H    = 14;                          // label text row below each slot
    const ROW_STRIDE = ESLOTSZ + LABEL_H + ESGAP;  // per grid row
    const equip      = player.inventory.equipment;
    const equipX     = px + PAD;
    const equipTop   = py;

    // ── Equipment grid ──────────────────────────────────────────────────────
    // row 0:  [  –  ] [ Helm ] [  –  ]
    // row 1:  [Gloves] [Chest] [Shield]
    // row 2:  [  –  ] [ Legs ] [  –  ]
    // row 3:  [  –  ] [ Boots] [  –  ]
    type SlotSpec = { label: string; item: ItemKind } | null;
    const grid: SlotSpec[][] = [
      [null,                                   { label: 'Helm',   item: equip.helm   }, null],
      [{ label: 'Gloves', item: equip.hands }, { label: 'Chest',  item: equip.torso  }, { label: 'Shield', item: equip.shield }],
      [null,                                   { label: 'Legs',   item: equip.legs   }, null],
      [null,                                   { label: 'Boots',  item: equip.feet   }, null],
    ];

    for (let row = 0; row < grid.length; row++) {
      for (let col = 0; col < 3; col++) {
        const spec = grid[row][col];
        if (!spec) continue;
        const { label, item } = spec;
        const def = ITEM_DEFS[item] ?? ITEM_DEFS['none'];
        const sx  = equipX + col * (ESLOTSZ + ESGAP);
        const sy  = equipTop + row * ROW_STRIDE;

        ctx.fillStyle   = item !== 'none' ? 'rgba(60,50,25,0.95)' : 'rgba(25,25,38,0.9)';
        ctx.fillRect(sx, sy, ESLOTSZ, ESLOTSZ);
        ctx.strokeStyle = item !== 'none' ? def.borderColor : '#445';
        ctx.lineWidth   = 1;
        ctx.strokeRect(sx, sy, ESLOTSZ, ESLOTSZ);

        if (item !== 'none') {
          const pad = 7;
          ctx.fillStyle    = def.color;
          ctx.fillRect(sx + pad, sy + pad, ESLOTSZ - pad * 2, ESLOTSZ - pad * 2);
          ctx.font         = 'bold 18px Consolas, monospace';
          ctx.fillStyle    = '#fff';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(def.symbol, sx + ESLOTSZ / 2, sy + ESLOTSZ / 2);
        }

        ctx.font         = '10px Consolas, monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = item !== 'none' ? TEXT_HEAD : TEXT_DIM;
        ctx.fillText(label, sx + ESLOTSZ / 2, sy + ESLOTSZ + 2);
      }
    }

    const equipBlockH = 4 * ROW_STRIDE - ESGAP;

    // Right column setup
    const divX = equipX + 3 * ESLOTSZ + 2 * ESGAP + 8;

    // Status column
    const statusX  = divX + 8;
    const statusW  = px + PANEL_W - PAD - statusX;
    const STATUS_R = 22;
    const LCOL     = 72;
    let sty = equipTop;

    // Sub-label
    ctx.font         = 'bold 11px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = GOLD;
    ctx.fillText('STATUS', statusX, sty + 7);
    sty += 18;
    ctx.strokeStyle = 'rgba(255,215,0,0.25)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(statusX, sty);
    ctx.lineTo(statusX + statusW, sty);
    ctx.stroke();
    sty += 5;

    const statusRows: Array<[string, string, string?]> = [];
    statusRows.push(['Location', ship ? `Ship #${ship.id}` : 'At sea']);
    if (player.isMounted && player.mountedModuleId != null) {
      const mod     = ship?.modules.find(m => m.id === player.mountedModuleId);
      const modKind = mod ? mod.kind.replace('-', ' ') : `Mod #${player.mountedModuleId}`;
      statusRows.push(['Mounted', modKind, ORANGE]);
    } else {
      statusRows.push(['Mounted', 'None', TEXT_DIM]);
    }
    statusRows.push(['On Deck', player.onDeck ? 'Yes' : 'No']);
    const spd = Math.sqrt(player.velocity.x ** 2 + player.velocity.y ** 2);
    statusRows.push(['Speed', spd.toFixed(2) + ' u/s']);
    const deg = ((player.rotation * 180 / Math.PI) % 360 + 360) % 360;
    statusRows.push(['Facing', deg.toFixed(1) + '°']);

    for (let i = 0; i < statusRows.length; i++) {
      const [label, value, valColor] = statusRows[i];
      if (i % 2 === 1) {
        ctx.fillStyle = BG_STRIPE;
        ctx.fillRect(statusX, sty, statusW, STATUS_R);
      }
      ctx.font         = '12px Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = TEXT_DIM;
      ctx.fillText(label, statusX + 4, sty + STATUS_R / 2);
      ctx.fillStyle    = valColor ?? TEXT_HEAD;
      ctx.fillText(value, statusX + LCOL, sty + STATUS_R / 2);
      sty += STATUS_R;
    }

    // LEVEL & XP sub-label in right column
    sty += 8;
    const lvl        = player.level ?? 1;
    const xp         = player.xp ?? 0;
    const isMax      = lvl >= PLAYER_MAX_LEVEL;
    const xpToNext   = isMax ? PLAYER_MAX_LEVEL * 100 : lvl * 100;
    const xpPct      = isMax ? 1 : Math.min(xp / xpToNext, 1);
    const statPoints = player.statPoints ?? 0;

    ctx.font         = 'bold 11px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = GOLD;
    ctx.fillText(`LEVEL & XP${statPoints > 0 ? `  \u2605 ${statPoints} pts` : ''}`, statusX, sty + 7);
    sty += 18;
    ctx.strokeStyle = 'rgba(255,215,0,0.25)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(statusX, sty);
    ctx.lineTo(statusX + statusW, sty);
    ctx.stroke();
    sty += 6;

    // Level label + XP bar on one line
    const BAR_H = 7;
    const LVL_W = 54;
    ctx.font         = 'bold 12px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = GOLD;
    ctx.fillText(`Lv.${lvl}${isMax ? ' MAX' : ''}`, statusX + 4, sty + BAR_H / 2 + 1);
    const xpBarX = statusX + LVL_W;
    const xpBarW = statusW - LVL_W;
    ctx.fillStyle = '#1a2040';
    ctx.fillRect(xpBarX, sty, xpBarW, BAR_H);
    ctx.fillStyle = '#4488ff';
    ctx.fillRect(xpBarX, sty, Math.round(xpBarW * xpPct), BAR_H);
    ctx.strokeStyle = '#2a3060';
    ctx.lineWidth   = 1;
    ctx.strokeRect(xpBarX, sty, xpBarW, BAR_H);
    sty += BAR_H + 3;

    const xpLabel = isMax ? 'MAX LEVEL' : `${xp} / ${xpToNext} XP`;
    ctx.font      = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(xpLabel, statusX + statusW, sty);
    sty += 14;

    // Compact stat rows with small + button
    const STAT_ROW_H = 28;
    const SBTN_W = 24, SBTN_H = 20;
    let hoveredStat: { stat: StatDef; sbtnX: number; sbtnY: number } | null = null;

    for (let si = 0; si < STATS.length; si++) {
      const stat    = STATS[si];
      const statLvl = (player[stat.key] ?? 0) as number;
      const afford  = statPoints > 0;
      const sbtnX   = statusX + statusW - SBTN_W;
      const sbtnY   = sty + (STAT_ROW_H - SBTN_H) / 2;
      const hovering = afford &&
        mouseX >= sbtnX && mouseX <= sbtnX + SBTN_W &&
        mouseY >= sbtnY && mouseY <= sbtnY + SBTN_H;
      if (hovering) hoveredStat = { stat, sbtnX, sbtnY };

      if (si % 2 === 1) {
        ctx.fillStyle = BG_STRIPE;
        ctx.fillRect(statusX, sty, statusW, STAT_ROW_H);
      }

      // Label
      ctx.font         = 'bold 12px Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = stat.color;
      ctx.fillText(stat.label, statusX + 4, sty + STAT_ROW_H / 2);

      // Current actual value (e.g. "140 HP")
      ctx.font      = 'bold 11px Consolas, monospace';
      ctx.fillStyle = statLvl > 0 ? stat.color : TEXT_DIM;
      ctx.fillText(stat.currentVal(player, statLvl), statusX + 70, sty + STAT_ROW_H / 2);

      // Per-point gain — green if can afford, grey if not
      ctx.font      = '10px Consolas, monospace';
      ctx.fillStyle = afford ? '#66dd88' : TEXT_DIM;
      ctx.fillText(stat.gainPerPt, statusX + 160, sty + STAT_ROW_H / 2);

      // + button
      ctx.fillStyle   = afford ? (hovering ? '#3a6a3a' : '#2a4a2a') : '#1e1e2c';
      ctx.strokeStyle = afford ? (hovering ? '#66ee66' : '#44aa44') : '#445';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.roundRect(sbtnX, sbtnY, SBTN_W, SBTN_H, 3);
      ctx.fill();
      ctx.stroke();
      ctx.font         = 'bold 14px Consolas, monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = afford ? '#aaffaa' : '#445';
      ctx.fillText('+', sbtnX + SBTN_W / 2, sbtnY + SBTN_H / 2);

      if (afford) {
        this._btnHits.push({ serverKey: stat.server, x: sbtnX, y: sbtnY, w: SBTN_W, h: SBTN_H, affordable: true });
      }

      sty += STAT_ROW_H;
    }

    // Hover tooltip — shows what next point gives
    if (hoveredStat) {
      const { stat, sbtnX, sbtnY } = hoveredStat;
      const tipText = `next: ${stat.gainPerPt}`;
      const TIP_PAD = 6;
      ctx.font = 'bold 10px Consolas, monospace';
      const tipW = ctx.measureText(tipText).width + TIP_PAD * 2;
      const tipH = 18;
      const tipX = Math.min(sbtnX + SBTN_W / 2 - tipW / 2, statusX + statusW - tipW);
      const tipY = sbtnY - tipH - 4;

      ctx.fillStyle   = '#1a2a1a';
      ctx.strokeStyle = '#44cc44';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.roundRect(tipX, tipY, tipW, tipH, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle    = '#aaffaa';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tipText, tipX + TIP_PAD, tipY + tipH / 2);
    }

    // Vertical divider spanning full right-column height
    const totalH = Math.max(equipBlockH, sty - equipTop);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(divX, equipTop - 4);
    ctx.lineTo(divX, equipTop + totalH + 4);
    ctx.stroke();

    return equipTop + totalH + 12;
  }

  // Hand-crafting panel (pre-workbench recipes)

  private _playerCrafting(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
  ): number {
    py = this._sectionHeader(ctx, px, py, 'HAND CRAFTING', 'no workbench required');
    py += 4;

    // Count materials in player inventory
    const counts: Partial<Record<ItemKind, number>> = {};
    for (const slot of player.inventory.slots) {
      if (slot.item !== 'none') {
        counts[slot.item] = (counts[slot.item] ?? 0) + slot.quantity;
      }
    }

    const COLS   = 2;
    const GAP    = 8;
    const CELL_W = Math.floor((PANEL_W - PAD * 2 - GAP) / COLS);
    const CELL_H = 54;
    const CELL_V = 4;
    const BTN_W  = 52;
    const BTN_H  = 20;

    // Build category list (preserving order)
    const categories: Array<{ label: string; indices: number[] }> = [];
    for (let i = 0; i < HAND_RECIPES.length; i++) {
      const cat = HAND_RECIPES[i].category;
      const existing = categories.find(c => c.label === cat);
      if (existing) existing.indices.push(i);
      else categories.push({ label: cat, indices: [i] });
    }

    // Ensure _craftTab is valid
    if (!categories.find(c => c.label === this._craftTab)) {
      this._craftTab = categories[0]?.label ?? '';
    }

    // Tab bar
    const TAB_BAR_H = 26;
    const tabW = Math.floor((PANEL_W - PAD * 2) / categories.length);
    for (let ti = 0; ti < categories.length; ti++) {
      const { label } = categories[ti];
      const tx = px + PAD + ti * tabW;
      const isActive = label === this._craftTab;

      ctx.fillStyle = isActive ? 'rgba(255,215,0,0.10)' : 'rgba(0,0,0,0.30)';
      ctx.fillRect(tx, py, tabW, TAB_BAR_H);

      // Bottom border
      ctx.strokeStyle = isActive ? GOLD : BORDER;
      ctx.lineWidth   = isActive ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, py + TAB_BAR_H);
      ctx.lineTo(tx + tabW, py + TAB_BAR_H);
      ctx.stroke();

      // Divider between tabs
      if (ti < categories.length - 1) {
        ctx.strokeStyle = BORDER;
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(tx + tabW, py);
        ctx.lineTo(tx + tabW, py + TAB_BAR_H);
        ctx.stroke();
      }

      ctx.font         = `${isActive ? 'bold ' : ''}10px Consolas, monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = isActive ? GOLD : TEXT_DIM;
      ctx.fillText(label, tx + tabW / 2, py + TAB_BAR_H / 2);

      this._craftTabHits.push({ label, x: tx, y: py, w: tabW, h: TAB_BAR_H });
    }
    py += TAB_BAR_H + 6;

    // Recipes for active tab
    const active = categories.find(c => c.label === this._craftTab);
    if (active) {
      for (let ci = 0; ci < active.indices.length; ci++) {
        const i      = active.indices[ci];
        const recipe = HAND_RECIPES[i];
        const col    = ci % COLS;
        const row    = Math.floor(ci / COLS);
        const rx     = px + PAD + col * (CELL_W + GAP);
        const ry     = py + row * (CELL_H + CELL_V);
        const canAfford = recipe.cost.every(c => (counts[c.item] ?? 0) >= c.qty);
        const outDef    = ITEM_DEFS[recipe.output];

        // Cell background
        ctx.fillStyle   = canAfford ? 'rgba(28,54,28,0.75)' : 'rgba(20,20,34,0.80)';
        ctx.strokeStyle = canAfford ? '#3a8a3a' : '#334';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.roundRect(rx, ry, CELL_W, CELL_H, 4);
        ctx.fill();
        ctx.stroke();

        // Output icon
        const ICON = 34;
        const iconX = rx + 6;
        const iconY = ry + (CELL_H - ICON) / 2;
        ctx.fillStyle   = outDef.color;
        ctx.fillRect(iconX, iconY, ICON, ICON);
        ctx.strokeStyle = outDef.borderColor;
        ctx.lineWidth   = 1;
        ctx.strokeRect(iconX, iconY, ICON, ICON);
        ctx.font         = 'bold 14px Consolas, monospace';
        ctx.fillStyle    = '#fff';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(outDef.symbol, iconX + ICON / 2, iconY + ICON / 2);

        // Output name + qty
        const textX = iconX + ICON + 6;
        ctx.font         = 'bold 12px Consolas, monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = canAfford ? TEXT_HEAD : TEXT_DIM;
        const nameStr = outDef.name + (recipe.outputQty > 1 ? ` x${recipe.outputQty}` : '');
        ctx.fillText(nameStr, textX, ry + 7);

        // Ingredients with per-item colour
        ctx.font = '10px Consolas, monospace';
        ctx.textBaseline = 'top';
        let ix = textX;
        const ingY = ry + 23;
        for (const c of recipe.cost) {
          const ok  = (counts[c.item] ?? 0) >= c.qty;
          ctx.fillStyle = ok ? GREEN : '#cc4444';
          const txt = `${c.qty}${ITEM_DEFS[c.item].symbol} `;
          ctx.fillText(txt, ix, ingY);
          ix += ctx.measureText(txt).width;
        }

        // CRAFT button
        const btnX = rx + CELL_W - BTN_W - 4;
        const btnY = ry + (CELL_H - BTN_H) / 2;
        ctx.fillStyle   = canAfford ? '#2a5a2a' : '#1e1e2e';
        ctx.strokeStyle = canAfford ? '#44cc44' : '#445';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.roundRect(btnX, btnY, BTN_W, BTN_H, 3);
        ctx.fill();
        ctx.stroke();
        ctx.font         = 'bold 11px Consolas, monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = canAfford ? '#aaffaa' : '#556';
        ctx.fillText('CRAFT', btnX + BTN_W / 2, btnY + BTN_H / 2);

        if (canAfford) {
          this._craftBtnHits.push({ recipeIdx: i, x: btnX, y: btnY, w: BTN_W, h: BTN_H });
        }
      }

      const catRows = Math.ceil(active.indices.length / COLS);
      py += catRows * (CELL_H + CELL_V) + 4;
    }

    return py;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 58-slot inventory grid (first 10 = hotbar, highlighted)

  private _inventoryGrid(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
    mouseX = 0, mouseY = 0,
  ): number {
    const inv    = player.inventory;
    const COLS   = 10;
    const IGAP   = 6;
    // Slots expand to fill the inner content width
    const ISZ    = Math.floor((PANEL_W - 2 * PAD - (COLS - 1) * IGAP) / COLS); // 55
    const STRIDE = ISZ + IGAP;
    const ROWS   = Math.ceil(58 / COLS);  // 6
    const LABEL_ROW_H = 14; // hotbar key-number row height

    const activeSlot = inv.activeSlot;
    const slotLabel  = (activeSlot === 255 || activeSlot >= 10)
      ? 'no selection'
      : `slot ${activeSlot + 1} active`;

    py = this._sectionHeader(ctx, px, py, 'INVENTORY  (58 slots)', slotLabel);
    py += 6;

    const startIX  = px + PAD;
    const contentH = ROWS * STRIDE - IGAP + LABEL_ROW_H + 4;
    // Viewport: whatever is left inside the panel minus a small bottom margin
    const panelBottom  = this._panelY + PANEL_H - PAD;
    const viewportH    = Math.min(contentH, Math.max(0, panelBottom - py));

    // Cache for handleWheel
    this._invGridY     = py;
    this._invContentH  = contentH;
    this._invViewportH = viewportH;

    // Cache for drag hit-testing
    this._dragISZ     = ISZ;
    this._dragStride  = STRIDE;
    this._dragStartIX = startIX;

    // Clamp scroll
    const maxScroll = Math.max(0, contentH - viewportH);
    if (this._invScrollY > maxScroll) this._invScrollY = maxScroll;

    // Clip to viewport
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, PANEL_W, viewportH);
    ctx.clip();

    const scrollY = this._invScrollY;

    let hoveredSlot = -1;
    let hoveredSX   = 0;
    let hoveredSY   = 0;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        if (i >= 58) break;

        const slot     = inv.slots[i] ?? { item: 'none' as ItemKind, quantity: 0 };
        const def      = ITEM_DEFS[slot.item] ?? ITEM_DEFS['none'];
        const sx       = startIX + col * STRIDE;
        const sy       = py + row * STRIDE - scrollY;
        const isActive = i === activeSlot;
        const isHotbar = i < HOTBAR_SLOTS;

        // Hover detection (only within visible viewport, skip if dragging this slot)
        const isDragSource = i === this._dragSlot;
        if (
          slot.item !== 'none' &&
          !isDragSource &&
          mouseX >= sx && mouseX <= sx + ISZ &&
          mouseY >= sy && mouseY <= sy + ISZ &&
          mouseY >= py && mouseY <= py + viewportH
        ) {
          hoveredSlot = i;
          hoveredSX   = sx;
          hoveredSY   = sy;
        }

        // Drop-target highlight
        const isDropTarget = this._dragSlot !== -1 && i === this._slotAt(mouseX, mouseY) && i !== this._dragSlot;

        ctx.fillStyle = isDropTarget
          ? 'rgba(100,200,255,0.25)'
          : isActive
          ? 'rgba(255,215,0,0.20)'
          : isHotbar ? 'rgba(30,35,50,0.92)' : 'rgba(22,22,35,0.85)';
        ctx.fillRect(sx, sy, ISZ, ISZ);

        ctx.strokeStyle = isDropTarget ? '#64c8ff' : isActive ? GOLD : isHotbar ? '#446' : '#334';
        ctx.lineWidth   = (isDropTarget || isActive) ? 2 : 1;
        ctx.strokeRect(sx, sy, ISZ, ISZ);

        // Draw item (dimmed if it's the drag source)
        if (slot.item !== 'none') {
          ctx.globalAlpha = isDragSource ? 0.3 : 1.0;
          const pad = 6;
          ctx.fillStyle = def.color;
          ctx.fillRect(sx + pad, sy + pad, ISZ - pad * 2, ISZ - pad * 2);
          ctx.font         = 'bold 16px Consolas, monospace';
          ctx.fillStyle    = '#fff';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(def.symbol, sx + ISZ / 2, sy + ISZ / 2);

          if (slot.quantity > 1) {
            ctx.font         = '10px Consolas, monospace';
            ctx.textAlign    = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle    = '#fff';
            ctx.fillText(String(slot.quantity), sx + ISZ - 3, sy + ISZ - 2);
          }
          ctx.globalAlpha = 1.0;
        }
      }
    }

    // Hotbar key-number labels below first row
    ctx.font         = '10px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const sx = startIX + i * STRIDE;
      ctx.fillStyle = i === activeSlot ? GOLD : TEXT_DIM;
      ctx.fillText(String(i === 9 ? 0 : i + 1), sx + ISZ / 2, py + ISZ + 3 - scrollY);
    }

    ctx.restore();

    // Tooltip — drawn unclipped so it can overlap above/outside the grid
    if (hoveredSlot !== -1 && this._dragSlot === -1) {
      const slot = inv.slots[hoveredSlot]!;
      this._invTooltip(ctx, slot, hoveredSX, hoveredSY, ISZ);
    }

    // Drag ghost — follows cursor
    if (this._dragSlot !== -1) {
      const dragSlotData = inv.slots[this._dragSlot];
      if (dragSlotData && dragSlotData.item !== 'none') {
        const def = ITEM_DEFS[dragSlotData.item] ?? ITEM_DEFS['none'];
        const gx  = this._dragX - ISZ / 2;
        const gy  = this._dragY - ISZ / 2;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(12,12,24,0.75)';
        ctx.fillRect(gx, gy, ISZ, ISZ);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 2;
        ctx.strokeRect(gx, gy, ISZ, ISZ);
        const pad = 6;
        ctx.fillStyle = def.color;
        ctx.fillRect(gx + pad, gy + pad, ISZ - pad * 2, ISZ - pad * 2);
        ctx.font = 'bold 16px Consolas, monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.symbol, gx + ISZ / 2, gy + ISZ / 2);
        ctx.globalAlpha = 1.0;
        ctx.restore();
      }
    }

    // Scrollbar (only visible when content overflows)
    if (maxScroll > 0) {
      const SB_W  = 4;
      const sbX   = px + PANEL_W - PAD / 2 - SB_W;
      const track = viewportH;
      const thumb = Math.max(20, (viewportH / contentH) * track);
      const thumbY = py + (scrollY / maxScroll) * (track - thumb);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(sbX, py, SB_W, track);
      ctx.fillStyle = 'rgba(255,215,0,0.5)';
      ctx.fillRect(sbX, thumbY, SB_W, thumb);
    }

    return py + viewportH + 8;
  }

  /** Draw tooltip for a hovered inventory slot. */
  private _invTooltip(
    ctx:  CanvasRenderingContext2D,
    slot: { item: ItemKind; quantity: number },
    sx: number, sy: number,
    slotSize: number,
  ): void {
    const def    = ITEM_DEFS[slot.item] ?? ITEM_DEFS['none'];
    const itemId = ITEM_KIND_ID[slot.item] ?? 0;

    const PAD_T  = 10;
    const W      = 220;
    const LINE   = 16;
    const nameH  = 18;
    const descLines = this._wrapText(ctx, def.description, W - PAD_T * 2, '12px Consolas, monospace');
    const quantityLine = slot.quantity > 1 ? 1 : 0;
    const totalH = PAD_T + nameH + 4 + LINE + 4 + descLines.length * LINE + quantityLine * LINE + PAD_T;

    // Position above slot, clamped to canvas
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    let tx = sx + slotSize / 2 - W / 2;
    let ty = sy - totalH - 6;
    tx = Math.max(4, Math.min(cw - W - 4, tx));
    if (ty < 4) ty = sy + slotSize + 6;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur  = 8;
    ctx.fillStyle   = 'rgba(12,12,20,0.94)';
    ctx.strokeStyle = def.borderColor;
    ctx.lineWidth   = 1.5;
    this._roundRect(ctx, tx, ty, W, totalH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Colour accent bar
    ctx.fillStyle = def.color;
    this._roundRect(ctx, tx, ty, 4, totalH, { tl: 6, tr: 0, br: 0, bl: 6 });
    ctx.fill();

    let cy = ty + PAD_T;

    ctx.fillStyle    = '#ffffff';
    ctx.font         = 'bold 14px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(def.name, tx + PAD_T + 4, cy);
    cy += nameH + 4;

    ctx.fillStyle = '#888';
    ctx.font      = '11px Consolas, monospace';
    ctx.fillText(`ID: ${itemId}   [${def.category}]`, tx + PAD_T + 4, cy);
    cy += LINE + 4;

    ctx.fillStyle = '#ccc';
    ctx.font      = '12px Consolas, monospace';
    for (const line of descLines) {
      ctx.fillText(line, tx + PAD_T + 4, cy);
      cy += LINE;
    }

    if (slot.quantity > 1) {
      ctx.fillStyle = '#aaa';
      ctx.fillText(`Qty: ${slot.quantity}`, tx + PAD_T + 4, cy);
    }

    ctx.restore();
  }

  /** Word-wrap helper. */
  private _wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    font: string,
  ): string[] {
    ctx.save();
    ctx.font = font;
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    ctx.restore();
    return lines;
  }

  /** Draw a rounded rectangle path. Radii can be a number or per-corner object. */
  private _roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    r: number | { tl: number; tr: number; br: number; bl: number },
  ): void {
    const tl = typeof r === 'number' ? r : r.tl;
    const tr = typeof r === 'number' ? r : r.tr;
    const br = typeof r === 'number' ? r : r.br;
    const bl = typeof r === 'number' ? r : r.bl;
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }

  // ────────────────────────────────────────────────────────────────────────────

  private _tabBar(ctx: CanvasRenderingContext2D, px: number, py: number): number {
    const tabs: Array<{ label: string; id: 'character' | 'skills' }> = [
      { label: '⚔  CHARACTER', id: 'character' },
      { label: '✦  SKILLS',    id: 'skills'    },
    ];
    const tabW = PANEL_W / tabs.length;

    for (let i = 0; i < tabs.length; i++) {
      const { label, id } = tabs[i];
      const tx = px + i * tabW;
      const isActive = this.activeTab === id;

      ctx.fillStyle = isActive ? 'rgba(255,215,0,0.10)' : 'rgba(0,0,0,0.30)';
      ctx.fillRect(tx, py, tabW, TAB_H);

      // Bottom border — gold for active, dim for inactive
      ctx.strokeStyle = isActive ? GOLD : BORDER;
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, py + TAB_H);
      ctx.lineTo(tx + tabW, py + TAB_H);
      ctx.stroke();

      // Divider between tabs
      if (i < tabs.length - 1) {
        ctx.strokeStyle = BORDER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx + tabW, py);
        ctx.lineTo(tx + tabW, py + TAB_H);
        ctx.stroke();
      }

      ctx.font = `${isActive ? 'bold ' : ''}12px Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isActive ? GOLD : TEXT_DIM;
      ctx.fillText(label, tx + tabW / 2, py + TAB_H / 2);
    }

    return py + TAB_H;
  }

  private _skillsTab(
    ctx:          CanvasRenderingContext2D,
    px:           number,
    contentTop:   number,
    contentBottom: number,
    _player:      NonNullable<ReturnType<WorldState['players']['find']>> | null,
  ): void {
    const midY = Math.round((contentTop + contentBottom) / 2);
    const midX = px + PANEL_W / 2;

    ctx.font = '14px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('Skill tree — coming soon.', midX, midY - 12);

    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = 'rgba(120,120,136,0.5)';
    ctx.fillText('Active abilities, passives and talent trees will appear here.', midX, midY + 12);
  }

  // ─────────────────────────────────────────────────────────────────────────

  private _sectionHeader(
    ctx: CanvasRenderingContext2D,
    px: number, py: number,
    label: string, right: string,
  ): number {
    const h = 22;
    ctx.fillStyle = 'rgba(255,215,0,0.08)';
    ctx.fillRect(px, py, PANEL_W, h);

    ctx.font = 'bold 12px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText(label, px + PAD, py + h / 2);

    if (right) {
      ctx.textAlign = 'right';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(right, px + PANEL_W - PAD, py + h / 2);
    }

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + h);
    ctx.lineTo(px + PANEL_W, py + h);
    ctx.stroke();

    return py + h + 2;
  }
}
