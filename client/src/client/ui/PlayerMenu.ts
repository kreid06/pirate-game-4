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
import { ITEM_DEFS, ItemKind, HOTBAR_SLOTS, INVENTORY_SLOTS, ITEM_KIND_ID, drawAxeIcon, drawSwordIcon, computeInventoryWeight, PlayerResources } from '../../sim/Inventory.js';

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
const PANEL_H  = 750;
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
  // Armor — cloth set
  { output: 'cloth_hat',     outputQty: 1, cost: [{ item: 'fiber', qty: 8  }],                                    category: 'ARMOR'        },
  { output: 'cloth_shirt',   outputQty: 1, cost: [{ item: 'fiber', qty: 25 }],                                    category: 'ARMOR'        },
  { output: 'cloth_pants',   outputQty: 1, cost: [{ item: 'fiber', qty: 20 }],                                    category: 'ARMOR'        },
  { output: 'cloth_shoes',   outputQty: 1, cost: [{ item: 'fiber', qty: 12 }],                                    category: 'ARMOR'        },
  { output: 'cloth_gloves',  outputQty: 1, cost: [{ item: 'fiber', qty: 10 }],                                    category: 'ARMOR'        },
  { output: 'wooden_shield', outputQty: 1, cost: [{ item: 'wood',  qty: 6  }],                                    category: 'ARMOR'        },
  // Tools
  { output: 'axe',           outputQty: 1, cost: [{ item: 'wood',  qty: 2  }, { item: 'stone', qty: 5 }],         category: 'TOOLS'        },
  { output: 'pickaxe',       outputQty: 1, cost: [{ item: 'wood',  qty: 3  }, { item: 'stone', qty: 4 }],         category: 'TOOLS'        },
  { output: 'hammer',        outputQty: 1, cost: [{ item: 'wood',  qty: 4  }],                                    category: 'TOOLS'        },
  { output: 'claim_flag',    outputQty: 1, cost: [{ item: 'wood',  qty: 5  }],                                    category: 'TOOLS'        },
];

/** Mirrors server player_armor_value() — sum of flat armour from cloth gear. */
function _calcArmorValue(eq: { helm: ItemKind; torso: ItemKind; legs: ItemKind; feet: ItemKind; hands: ItemKind; shield: ItemKind }): number {
  let v = 0;
  if (eq.helm   === 'cloth_hat')    v += 5;
  if (eq.torso  === 'cloth_shirt')  v += 20;
  if (eq.torso  === 'cloth_armor')  v += 5;  // legacy
  if (eq.legs   === 'cloth_pants')  v += 15;
  if (eq.feet   === 'cloth_shoes')  v += 8;
  if (eq.hands  === 'cloth_gloves') v += 7;
  return v;
}

export class PlayerMenu {
  public visible = false;
  private activeTab: 'character' | 'skills' | 'schematics' = 'character';

  /** Set by UIManager; called when the player clicks an affordable upgrade button. */
  public onUpgradeRequest: ((stat: string) => void) | null = null;

  /** Set by UIManager; called when the player clicks the LEVEL UP button (enough XP). */
  public onPlayerLevelUp: (() => void) | null = null;

  // Hit area for the LEVEL UP button — null when not visible
  private _levelUpBtnHit: { x: number; y: number; w: number; h: number } | null = null;

  // Cached panel origin — set each render frame, used by handleClick
  private _panelX = 0;
  private _panelY = 0;
  private _lastCanvasW = 800;
  private _lastCanvasH = 600;
  private _btnHits: BtnHit[] = [];
  private _craftBtnHits: CraftHit[] = [];
  private _craftTab = 'SURVIVAL';
  private _craftTabHits: Array<{ label: string; x: number; y: number; w: number; h: number }> = [];
  private _schematicsSubTab: 'LAND' | 'SHIP' = 'LAND';
  private _schematicsSubTabHits: Array<{ label: 'LAND' | 'SHIP'; x: number; y: number; w: number; h: number }> = [];
  /** Which hotbar slot is currently selected for assignment (-1 = none). */
  private _schematicsSelectedSlot = -1;
  /** Hit areas for the 8 hotbar slots in the schematics tab. */
  private _schematicsHotbarHits: Array<{ slot: number; x: number; y: number; w: number; h: number }> = [];
  /** Hit areas for each schematic card (for click-to-assign). */
  private _schematicsCardHits: Array<{ idx: number; kind: string; x: number; y: number; w: number; h: number }> = [];

  /** Current land hotbar slots — set by UIManager before each render. */
  public landHotbarSlots: (string | null)[] = [];
  /** Current ship hotbar slots — set by UIManager before each render. */
  public shipHotbarSlots: (string | null)[] = [];
  /** Callback to assign a kind to a land hotbar slot (null = clear). */
  public onSetLandHotbarSlot: ((idx: number, kind: string | null) => void) | null = null;
  /** Callback to assign a kind to a ship hotbar slot (null = clear). */
  public onSetShipHotbarSlot: ((idx: number, kind: string | null) => void) | null = null;

  /** Called when player clicks an affordable CRAFT button. */
  public onCraftRequest: ((outputItem: ItemKind, qty: number) => void) | null = null;

  /** Called when player clicks an armour item in their inventory to equip it. */
  public onEquipItem: ((slotIdx: number) => void) | null = null;

  /** Called when player clicks a filled equipment slot to unequip it. */
  public onUnequipSlot: ((slot: string) => void) | null = null;

  // Equipment slot hit-test records (slot name → canvas rect) set each frame
  private _equipSlotHits: Array<{ slot: string; item: ItemKind; x: number; y: number; w: number; h: number }> = [];

  // Inventory grid scroll state (kept for drag hit-testing caches)
  private _invScrollY    = 0;
  private _invGridY      = 0;
  private _invContentH   = 0;
  private _invViewportH  = 0;

  // Whole-panel scroll (character tab)
  private _panelScrollY    = 0;   // current scroll offset in px
  private _panelContentH   = 0;   // total content height (measured each frame)
  private _contentStartY   = 0;   // canvas Y where scrollable content begins
  private _contentViewH    = 0;   // height of the visible content area

  // Drag-and-drop state
  private _dragSlot    = -1;   // source slot index, -1 = not dragging
  private _dragX       = 0;
  private _dragY       = 0;
  private _dragISZ     = 0;    // slot size at drag start (for ghost sizing)
  private _dragStartIX = 0;    // startIX at drag start
  private _dragStride  = 0;    // STRIDE at drag start
  private _lastInv: { slots: { item: ItemKind; quantity: number }[] } | null = null;

  /** Called when the player drags a slot onto another; args are (fromSlot, toSlot). */
  public onSwapRequest: ((fromSlot: number, toSlot: number) => void) | null = null;

  /** Called when the player drags an item outside the panel to drop it in the world. */
  public onDropItem: ((fromSlot: number) => void) | null = null;

  /** Called when the player confirms a resource drop. */
  public onDropResources: ((kind: keyof PlayerResources, amount: number) => void) | null = null;

  // ── Resource chip drag / drop-slider state ────────────────────────────
  /** Hit regions for the 4 resource chips — set each render frame. */
  private _resChipHits: Array<{
    key: keyof PlayerResources; label: string; color: string;
    x: number; y: number; w: number; h: number; max: number;
  }> = [];
  /** Key being dragged out, or null. */
  private _resDragKey: keyof PlayerResources | null = null;
  private _resDragX = 0;
  private _resDragY = 0;
  private _resDragMax = 0;
  private _resDragColor = '#888';
  private _resDragLabel = '';

  // Schematic card drag-and-drop state
  private _schemDragKind: string | null = null;
  private _schemDragX = 0;
  private _schemDragY = 0;
  /** Bounds of the card where the drag started — ghost is hidden until cursor leaves this area. */
  private _schemDragSrc: { x: number; y: number; w: number; h: number } | null = null;
  private _schemDragActive = false; // true once cursor has left the source card

  /** Last known cursor position — updated in handleMouseMove, used by handleKeyDown. */
  private _lastMouseX = 0;
  private _lastMouseY = 0;
  /** Non-null while mouse is hovering a resource chip — drives the tooltip render. */
  private _resHoverTooltip: {
    cx: number; cy: number; // chip centre-x, chip top-y
    label: string; color: string;
    desc: string; kgPerUnit: number; qty: number;
  } | null = null;
  /** Non-null while the drop-quantity slider is open. */
  private _resDropSlider: {
    key:    keyof PlayerResources;
    label:  string;
    color:  string;
    max:    number;
    amount: number;
    sliderDragging: boolean;
    typing:     boolean;   // true while user is typing a number
    typingStr:  string;    // raw typed digits
    amountHit: { x: number; y: number; w: number; h: number }; // click to type
    trackX: number; trackY: number; trackW: number;
    confirmHit: { x: number; y: number; w: number; h: number };
    cancelHit:  { x: number; y: number; w: number; h: number };
  } | null = null;

  /** Keyboard listener registered while the drop slider is open. */
  private _sliderKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  toggle(): void { this.visible = !this.visible; }
  open():   void { this.visible = true; this.activeTab = 'character'; this._panelScrollY = 0; this._schematicsSubTab = 'LAND'; this._schematicsSelectedSlot = -1; }
  close():  void { this.visible = false; this._closeDropSlider(); }

  /** Open directly to the Skills tab. */
  openSkillsTab(): void { this.visible = true; this.activeTab = 'skills'; }

  // ── Drop-slider helpers ────────────────────────────────────────────────

  private _closeDropSlider(): void {
    this._resDropSlider = null;
    if (this._sliderKeyHandler) {
      document.removeEventListener('keydown', this._sliderKeyHandler, true);
      this._sliderKeyHandler = null;
    }
  }

  private _openDropSlider(key: keyof PlayerResources, label: string, color: string, max: number, cw: number, ch: number): void {
    this._closeDropSlider(); // clean up any previous
    const SW = 320, SH = 200;
    const BTN_W = 90, BTN_H = 32;
    const sx = Math.round((cw - SW) / 2);
    const sy = Math.round((ch - SH) / 2);
    const trackY = sy + 110;
    const inputW = 80, inputH = 30;
    this._resDropSlider = {
      key, label, color, max, amount: max,
      sliderDragging: false,
      typing: false, typingStr: String(max),
      amountHit: { x: sx + SW / 2 - inputW / 2, y: sy + 36, w: inputW, h: inputH },
      trackX: sx + 24, trackY, trackW: SW - 48,
      confirmHit: { x: sx + SW / 2 - BTN_W - 8, y: sy + SH - BTN_H - 12, w: BTN_W, h: BTN_H },
      cancelHit:  { x: sx + SW / 2 + 8,          y: sy + SH - BTN_H - 12, w: BTN_W, h: BTN_H },
    };
    // Register keyboard handler for typing mode
    this._sliderKeyHandler = (e: KeyboardEvent) => {
      const s = this._resDropSlider;
      if (!s) return;
      if (!s.typing) {
        // Pressing a digit while not in typing mode activates it
        if (e.key >= '0' && e.key <= '9') {
          s.typing = true;
          s.typingStr = e.key;
          s.amount = parseInt(s.typingStr, 10) || 1;
          s.amount = Math.min(s.max, s.amount);
          s.typingStr = String(s.amount);
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Enter') {
          if (s.amount > 0) this.onDropResources?.(s.key, s.amount);
          this._closeDropSlider();
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Escape') {
          this._closeDropSlider();
          e.preventDefault(); e.stopPropagation();
        }
        return;
      }
      // In typing mode
      if (e.key >= '0' && e.key <= '9') {
        s.typingStr += e.key;
        const v = parseInt(s.typingStr, 10);
        s.amount = isNaN(v) ? 1 : Math.max(1, Math.min(s.max, v));
        // Keep display string in sync with the clamped value
        if (!isNaN(v) && v > s.max) s.typingStr = String(s.max);
      } else if (e.key === 'Backspace') {
        s.typingStr = s.typingStr.slice(0, -1);
        if (s.typingStr === '') {
          s.amount = 1;
        } else {
          const v = parseInt(s.typingStr, 10);
          s.amount = isNaN(v) ? 1 : Math.max(1, Math.min(s.max, v));
        }
      } else if (e.key === 'Enter') {
        s.typing = false;
        if (s.amount > 0) this.onDropResources?.(s.key, s.amount);
        this._closeDropSlider();
      } else if (e.key === 'Escape') {
        s.typing = false;
        s.typingStr = String(s.amount);
      }
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', this._sliderKeyHandler, true);
  }

  /**
   * Handle a click inside the player menu.
   * Returns true if the click was consumed (tab switch or click inside panel).
   * Returns false if the click was outside the panel (so UIManager can close the menu).
   */
  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;

    // Resource drop slider — takes priority over everything
    if (this._resDropSlider) {
      const s = this._resDropSlider;
      // Click on amount display → enter typing mode
      if (x >= s.amountHit.x && x <= s.amountHit.x + s.amountHit.w &&
          y >= s.amountHit.y && y <= s.amountHit.y + s.amountHit.h) {
        s.typing = true;
        s.typingStr = '';
        return true;
      }
      // Cancel
      if (x >= s.cancelHit.x && x <= s.cancelHit.x + s.cancelHit.w &&
          y >= s.cancelHit.y && y <= s.cancelHit.y + s.cancelHit.h) {
        this._closeDropSlider();
        return true;
      }
      // Confirm / drop
      if (x >= s.confirmHit.x && x <= s.confirmHit.x + s.confirmHit.w &&
          y >= s.confirmHit.y && y <= s.confirmHit.y + s.confirmHit.h) {
        if (s.amount > 0) this.onDropResources?.(s.key, s.amount);
        this._closeDropSlider();
        return true;
      }
      return true; // consume all clicks while slider is open
    }

    const px = this._panelX, py = this._panelY;
    // Outside panel → signal UIManager to close
    if (x < px || x > px + PANEL_W || y < py || y > py + PANEL_H) return false;

    // Tab bar region
    const tabBarY = py + HEADER_H;
    if (y >= tabBarY && y < tabBarY + TAB_H) {
      const tabW = PANEL_W / 3;
      const rel = x - px;
      if      (rel < tabW)         this.activeTab = 'character';
      else if (rel < tabW * 2)     this.activeTab = 'skills';
      else                         this.activeTab = 'schematics';
      return true;
    }

    // Schematics sub-tab clicks
    for (const hit of this._schematicsSubTabHits) {
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        this._schematicsSubTab = hit.label;
        this._schematicsSelectedSlot = -1; // reset selection on sub-tab switch
        return true;
      }
    }

    // Schematics hotbar slot clicks
    for (const hit of this._schematicsHotbarHits) {
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        // Toggle selection: clicking selected slot deselects it
        this._schematicsSelectedSlot = this._schematicsSelectedSlot === hit.slot ? -1 : hit.slot;
        return true;
      }
    }

    // Schematics card clicks — assign to selected hotbar slot (or clear if already there)
    if (this._schematicsSelectedSlot >= 0) {
      for (const hit of this._schematicsCardHits) {
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          const slotIdx = this._schematicsSelectedSlot;
          const currentHotbar = this._schematicsSubTab === 'LAND' ? this.landHotbarSlots : this.shipHotbarSlots;
          const newKind = currentHotbar[slotIdx] === hit.kind ? null : hit.kind;
          if (this._schematicsSubTab === 'LAND') {
            this.onSetLandHotbarSlot?.(slotIdx, newKind);
          } else {
            this.onSetShipHotbarSlot?.(slotIdx, newKind);
          }
          this._schematicsSelectedSlot = -1; // deselect after assignment
          return true;
        }
      }
    }

    // Level-up button
    const lub = this._levelUpBtnHit;
    if (lub && y >= this._contentStartY &&
        x >= lub.x && x <= lub.x + lub.w && y >= lub.y && y <= lub.y + lub.h) {
      this.onPlayerLevelUp?.();
      return true;
    }

    // Upgrade buttons
    for (const btn of this._btnHits) {
      if (btn.affordable && y >= this._contentStartY &&
          x >= btn.x && x <= btn.x + btn.w &&
          y >= btn.y && y <= btn.y + btn.h) {
        this.onUpgradeRequest?.(btn.serverKey);
        return true;
      }
    }

    // Craft category tabs
    for (const tab of this._craftTabHits) {
      if (y >= this._contentStartY &&
          x >= tab.x && x <= tab.x + tab.w &&
          y >= tab.y && y <= tab.y + tab.h) {
        this._craftTab = tab.label;
        return true;
      }
    }

    // Craft buttons
    for (const btn of this._craftBtnHits) {
      if (y >= this._contentStartY &&
          x >= btn.x && x <= btn.x + btn.w &&
          y >= btn.y && y <= btn.y + btn.h) {
        const r = HAND_RECIPES[btn.recipeIdx];
        this.onCraftRequest?.(r.output, r.outputQty);
        return true;
      }
    }

    // Equipment slot clicks — unequip filled slots
    for (const hit of this._equipSlotHits) {
      if (y >= this._contentStartY &&
          x >= hit.x && x <= hit.x + hit.w &&
          y >= hit.y && y <= hit.y + hit.h) {
        this.onUnequipSlot?.(hit.slot);
        return true;
      }
    }

    return true; // click inside panel — consume to avoid accidental close
  }

  /** Handle mouse-wheel over the character panel or drop slider. Returns true if consumed. */
  handleWheel(deltaY: number, _x: number, y: number): boolean {
    if (!this.visible) return false;
    // Adjust slider amount with scroll wheel
    if (this._resDropSlider) {
      const delta = deltaY > 0 ? -1 : 1;
      const s = this._resDropSlider;
      s.amount = Math.max(1, Math.min(s.max, s.amount + delta));
      return true;
    }
    if (this.activeTab !== 'character' && this.activeTab !== 'schematics') return false;
    if (y < this._contentStartY || y > this._panelY + PANEL_H) return false;
    const maxScroll = Math.max(0, this._panelContentH - this._contentViewH);
    if (maxScroll === 0) return false;
    this._panelScrollY = Math.max(0, Math.min(maxScroll, this._panelScrollY + deltaY * 0.5));
    return true;
  }

  /** Begin a drag if the mousedown lands on an inventory slot, resource chip, or schematic card. Returns true if consumed. */
  handleMouseDown(x: number, y: number, inv: { slots: { item: ItemKind; quantity: number }[] }): boolean {
    if (!this.visible) return false;

    // Schematics tab: drag a card to assign it to a hotbar slot
    if (this.activeTab === 'schematics') {
      for (const hit of this._schematicsCardHits) {
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          this._schemDragKind   = hit.kind;
          this._schemDragX      = x;
          this._schemDragY      = y;
          this._schemDragSrc    = { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
          this._schemDragActive = false;
          return true;
        }
      }
      return false;
    }

    if (this.activeTab !== 'character') return false;

    // Slider thumb drag — start dragging if mousedown on track
    if (this._resDropSlider) {
      const s = this._resDropSlider;
      const tY = s.trackY + 4;
      const TRACK_HIT = 20;
      if (y >= tY - TRACK_HIT && y <= tY + TRACK_HIT &&
          x >= s.trackX - 8 && x <= s.trackX + s.trackW + 8) {
        s.sliderDragging = true;
        s.typing = false; // exit typing mode when starting drag
        const ratio = Math.max(0, Math.min(1, (x - s.trackX) / s.trackW));
        s.amount = Math.max(1, Math.round(ratio * s.max));
        s.typingStr = String(s.amount);
        return true;
      }
      return false; // let handleClick process button/amountHit taps
    }

    // Resource chip drag — only if the chip has > 0 quantity
    for (const chip of this._resChipHits) {
      if (chip.max > 0 && x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h) {
        this._resDragKey   = chip.key;
        this._resDragMax   = chip.max;
        this._resDragColor = chip.color;
        this._resDragLabel = chip.label;
        this._resDragX     = x;
        this._resDragY     = y;
        return true;
      }
    }

    const slot = this._slotAt(x, y);
    if (slot === -1) return false;
    if ((inv.slots[slot]?.item ?? 'none') === 'none') return false;
    this._dragSlot = slot;
    this._dragX    = x;
    this._dragY    = y;
    this._lastInv  = inv;
    return true;
  }

  /** Update drag ghost position. */
  handleMouseMove(x: number, y: number): void {
    this._lastMouseX = x;
    this._lastMouseY = y;
    // Slider thumb drag
    if (this._resDropSlider?.sliderDragging) {
      const s = this._resDropSlider;
      const ratio = Math.max(0, Math.min(1, (x - s.trackX) / s.trackW));
      s.amount = Math.max(1, Math.round(ratio * s.max));
      s.typingStr = String(s.amount);
      return;
    }
    if (this._resDragKey !== null) {
      this._resDragX = x;
      this._resDragY = y;
    }
    if (this._schemDragKind !== null) {
      this._schemDragX = x;
      this._schemDragY = y;
      // Activate ghost once cursor leaves the source card
      if (!this._schemDragActive && this._schemDragSrc) {
        const s = this._schemDragSrc;
        if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) {
          this._schemDragActive = true;
        }
      }
    }
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
    // End slider thumb drag
    if (this._resDropSlider?.sliderDragging) {
      this._resDropSlider.sliderDragging = false;
      return true;
    }

    // Resource chip drag — if released outside panel, open the drop slider
    if (this._resDragKey !== null) {
      const key   = this._resDragKey;
      const max   = this._resDragMax;
      const color = this._resDragColor;
      const label = this._resDragLabel;
      this._resDragKey = null;
      const px2 = this._panelX, py2 = this._panelY;
      const outsidePanel2 = x < px2 || x > px2 + PANEL_W || y < py2 || y > py2 + PANEL_H;
      if (outsidePanel2 && max > 0) {
        this._openDropSlider(key, label, color, max, this._lastCanvasW, this._lastCanvasH);
        return true;
      }
      return false;
    }

    // Schematic drag: drop onto a hotbar slot to assign (or clear if already there)
    if (this._schemDragKind !== null) {
      const kind = this._schemDragKind;
      this._schemDragKind = null;
      for (const hit of this._schematicsHotbarHits) {
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          const currentHotbar = this._schematicsSubTab === 'LAND' ? this.landHotbarSlots : this.shipHotbarSlots;
          const newKind = currentHotbar[hit.slot] === kind ? null : kind;
          if (this._schematicsSubTab === 'LAND') this.onSetLandHotbarSlot?.(hit.slot, newKind);
          else this.onSetShipHotbarSlot?.(hit.slot, newKind);
          this._schematicsSelectedSlot = -1;
          return true;
        }
      }
      return true;
    }

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
    } else if (toSlot === fromSlot) {
      // Drag released on same slot — treat as click, no equip on left-release
    } else {
      // Check if dropped onto an equipment slot — equip the dragged item
      const equipHit = this._equipSlotHits.find(
        h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h
      );
      if (equipHit) {
        this.onEquipItem?.(fromSlot);
      }
    }
    return true;
  }

  /**
   * Handle a key press while the player menu is open.
   * Pressing 1–8 while hovering a schematic card assigns it to that hotbar slot.
   * Returns true if consumed.
   */
  handleKeyDown(key: string): boolean {
    if (!this.visible || this.activeTab !== 'schematics') return false;
    const slotIdx = parseInt(key, 10);
    if (isNaN(slotIdx) || slotIdx < 1 || slotIdx > 8) return false;
    const idx = slotIdx - 1; // 0-based
    // Find which schematic the cursor is currently over
    const hovered = this._schematicsCardHits.find(
      h => this._lastMouseX >= h.x && this._lastMouseX <= h.x + h.w &&
           this._lastMouseY >= h.y && this._lastMouseY <= h.y + h.h,
    );
    if (!hovered) return false;
    const currentHotbar = this._schematicsSubTab === 'LAND' ? this.landHotbarSlots : this.shipHotbarSlots;
    const newKind = currentHotbar[idx] === hovered.kind ? null : hovered.kind;
    if (this._schematicsSubTab === 'LAND') this.onSetLandHotbarSlot?.(idx, newKind);
    else this.onSetShipHotbarSlot?.(idx, newKind);
    this._schematicsSelectedSlot = -1;
    return true;
  }

  /**
   * Handle a right-click inside the player menu (character tab).
   * Right-clicking an armour/shield item in the inventory bag equips it.
   * Returns true if consumed.
   */
  handleRightClick(x: number, y: number, inv: { slots: { item: ItemKind; quantity: number }[] }): boolean {
    if (!this.visible) return false;

    // Schematics tab: right-click hotbar slot to clear it
    if (this.activeTab === 'schematics') {
      for (const hit of this._schematicsHotbarHits) {
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          if (this._schematicsSubTab === 'LAND') {
            this.onSetLandHotbarSlot?.(hit.slot, null);
          } else {
            this.onSetShipHotbarSlot?.(hit.slot, null);
          }
          this._schematicsSelectedSlot = -1;
          return true;
        }
      }
      return false;
    }

    if (this.activeTab !== 'character') return false;
    // Right-click on a filled equipment slot → unequip
    for (const hit of this._equipSlotHits) {
      if (hit.item !== 'none' && x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        this.onUnequipSlot?.(hit.slot);
        return true;
      }
    }
    // Right-click on an armour/shield item in the bag → equip
    const slot = this._slotAt(x, y);
    if (slot === -1) return false;
    const item = inv.slots[slot]?.item ?? 'none';
    if (item === 'none') return false;
    const cat = ITEM_DEFS[item]?.category;
    if (cat === 'armor' || cat === 'shield') {
      this.onEquipItem?.(slot);
      return true;
    }
    return false;
  }

  /** Returns the inventory slot index under (x, y), or -1 if none. */
  private _slotAt(x: number, y: number): number {
    if (!this._dragISZ) return -1; // grid not rendered yet
    const ISZ    = this._dragISZ;
    const STRIDE = this._dragStride;
    const COLS   = 8;
    const ROWS   = Math.ceil(INVENTORY_SLOTS / COLS);
    // must be inside the viewport
    if (y < this._invGridY || y > this._invGridY + this._invViewportH) return -1;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i  = row * COLS + col;
        if (i >= INVENTORY_SLOTS) break;
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
    this._lastCanvasW = cw;
    this._lastCanvasH = ch;

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
    this._schematicsSubTabHits = [];

    const player = assignedId != null
      ? worldState.players.find(p => p.id === assignedId)
      : worldState.players[0] ?? null;

    if (this.activeTab === 'skills') {
      this._skillsTab(ctx, px, cur, py + PANEL_H, player ?? null);
      ctx.restore();
      return;
    }

    if (this.activeTab === 'schematics') {
      this._schematicsTab(ctx, px, cur, py + PANEL_H, player ?? null);
      ctx.restore();
      return;
    }

    if (!player) {
      ctx.font = '14px Georgia, serif';
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

    // ── Scrollable content area ────────────────────────────────────────────
    const contentStartY = cur;
    const contentViewH  = py + PANEL_H - contentStartY;
    this._contentStartY = contentStartY;
    this._contentViewH  = contentViewH;

    // Clamp scroll
    const maxPanelScroll = Math.max(0, this._panelContentH - contentViewH);
    if (this._panelScrollY > maxPanelScroll) this._panelScrollY = maxPanelScroll;
    if (this._panelScrollY < 0) this._panelScrollY = 0;

    // Clip to content viewport and scroll
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, contentStartY, PANEL_W, contentViewH);
    ctx.clip();

    cur = contentStartY - this._panelScrollY;   // shifted start

    cur = this._equipmentAndStatus(ctx, px, cur, player, ship, worldState, mouseX, mouseY);
    cur = this._resourcesSection(ctx, px, cur, player.inventory.resources, mouseX, mouseY);
    cur = this._playerCrafting(ctx, px, cur, player);
    cur = this._inventoryGrid(ctx, px, cur, player, mouseX, mouseY);

    // Measure total content so next frame's clamp is accurate
    this._panelContentH = (cur + this._panelScrollY) - contentStartY;

    ctx.restore(); // remove content clip

    // Scrollbar for panel content
    if (this._panelContentH > contentViewH + 4) {
      const SB_W   = 4;
      const sbX    = px + PANEL_W - 6;
      const track  = contentViewH;
      const thumb  = Math.max(24, (contentViewH / this._panelContentH) * track);
      const thumbY = contentStartY + (this._panelScrollY / Math.max(1, this._panelContentH - contentViewH)) * (track - thumb);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(sbX, contentStartY, SB_W, track);
      ctx.fillStyle = 'rgba(255,215,0,0.55)';
      ctx.fillRect(sbX, thumbY, SB_W, thumb);
    }

    ctx.restore(); // remove the outer ctx.save() from render()

    // Resource drop-quantity slider — rendered above everything else
    if (this._resDropSlider) {
      this._renderResDropSlider(ctx);
    }

    // Resource hover tooltip — rendered above everything, outside clip
    if (this._resHoverTooltip) {
      const tt = this._resHoverTooltip;
      const TW = 178, TH = 100;
      let ttX = tt.cx - TW / 2;
      let ttY = tt.cy - TH - 6;
      ttX = Math.max(4, Math.min(this._lastCanvasW - TW - 4, ttX));
      ttY = Math.max(4, Math.min(this._lastCanvasH - TH - 4, ttY));

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur  = 10;
      ctx.fillStyle   = 'rgba(8,12,22,0.97)';
      ctx.beginPath();
      ctx.roundRect(ttX, ttY, TW, TH, 5);
      ctx.fill();
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = tt.color;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.roundRect(ttX, ttY, TW, TH, 5);
      ctx.stroke();

      // Name
      ctx.font         = 'bold 13px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = tt.color;
      ctx.fillText(tt.label, ttX + 10, ttY + 10);

      // Divider
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(ttX + 8, ttY + 28); ctx.lineTo(ttX + TW - 8, ttY + 28);
      ctx.stroke();

      // Description
      ctx.font      = '10px Georgia, serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(tt.desc, ttX + 10, ttY + 33);

      // Weight per unit row
      ctx.fillStyle    = TEXT_DIM;
      ctx.textAlign    = 'left';
      ctx.fillText('Weight per unit:', ttX + 10, ttY + 52);
      ctx.fillStyle    = '#c4d8ee';
      ctx.textAlign    = 'right';
      ctx.fillText(`${tt.kgPerUnit.toFixed(1)} kg`, ttX + TW - 10, ttY + 52);

      // Total weight row
      const totalKg = tt.qty * tt.kgPerUnit;
      ctx.textAlign    = 'left';
      ctx.fillStyle    = TEXT_DIM;
      ctx.fillText('Total carried:', ttX + 10, ttY + 68);
      ctx.textAlign    = 'right';
      ctx.fillStyle    = totalKg > 0 ? '#a8e0a8' : '#556';
      ctx.fillText(totalKg > 0 ? `${totalKg.toFixed(1)} kg` : '— empty', ttX + TW - 10, ttY + 68);

      // In pool count
      ctx.textAlign    = 'left';
      ctx.fillStyle    = TEXT_DIM;
      ctx.fillText('In resource pool:', ttX + 10, ttY + 82);
      ctx.textAlign    = 'right';
      ctx.fillStyle    = tt.qty > 0 ? '#ffffff' : '#556';
      ctx.fillText(tt.qty > 0 ? String(tt.qty) : 'none', ttX + TW - 10, ttY + 82);

      ctx.restore();
    }

    // Resource drag ghost — small colored chip following the cursor
    if (this._resDragKey !== null) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = this._resDragColor;
      ctx.fillRect(this._resDragX - 16, this._resDragY - 16, 32, 32);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(this._resDragX - 16, this._resDragY - 16, 32, 32);
      ctx.font = 'bold 9px Georgia, serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this._resDragLabel.substring(0, 2).toUpperCase(), this._resDragX, this._resDragY);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  /** Render the drop-quantity slider popup (pure canvas, no HTML elements). */
  private _renderResDropSlider(ctx: CanvasRenderingContext2D): void {
    const s = this._resDropSlider!;
    const SW = 320, SH = 200;
    const sx = s.trackX - 24;
    const sy = s.confirmHit.y - (SH - s.confirmHit.h - 12);

    ctx.save();

    // Backdrop dim
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, this._lastCanvasW, this._lastCanvasH);

    // Panel background
    ctx.fillStyle = 'rgba(14,18,30,0.98)';
    ctx.fillRect(sx, sy, SW, SH);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, SW, SH);

    // Title
    ctx.font = 'bold 15px Georgia, serif';
    ctx.fillStyle = s.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`Drop ${s.label}`, sx + SW / 2, sy + 12);

    // ── Amount display / typing field ─────────────────────────────────────
    const { amountHit: ah } = s;
    const isTyping = s.typing;
    const displayStr = isTyping
      ? (s.typingStr.length > 0 ? s.typingStr : '0')
      : String(s.amount);

    // Field background
    ctx.fillStyle = isTyping ? 'rgba(30,36,58,0.98)' : 'rgba(20,24,40,0.9)';
    ctx.fillRect(ah.x, ah.y, ah.w, ah.h);

    // Field border — gold when focused, dimmer otherwise
    ctx.strokeStyle = isTyping ? '#ffee88' : '#ffcc44';
    ctx.lineWidth = isTyping ? 2 : 1.5;
    ctx.strokeRect(ah.x, ah.y, ah.w, ah.h);

    // Amount text
    ctx.font = 'bold 18px Georgia, serif';
    ctx.fillStyle = isTyping ? '#ffee88' : '#fff8e0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayStr, ah.x + ah.w / 2, ah.y + ah.h / 2);

    // Blinking cursor when typing
    if (isTyping && Math.floor(Date.now() / 500) % 2 === 0) {
      const tw = ctx.measureText(displayStr).width;
      const cx = ah.x + ah.w / 2 + tw / 2 + 2;
      const cy = ah.y + 5;
      ctx.fillStyle = '#ffee88';
      ctx.fillRect(cx, cy, 2, ah.h - 10);
    }

    // Click hint below field
    ctx.font = '10px Georgia, serif';
    ctx.fillStyle = isTyping ? '#aaa' : '#556';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(
      isTyping ? 'type a number • Enter to confirm' : 'click to type  ·  of ' + s.max,
      ah.x + ah.w / 2, ah.y + ah.h + 3,
    );

    // ── Slider track ──────────────────────────────────────────────────────
    const TRACK_H = 8;
    const { trackX, trackY, trackW } = s;
    const tY = trackY + 4;

    // Track background
    ctx.fillStyle = '#1a1e2e';
    ctx.fillRect(trackX, tY - TRACK_H / 2, trackW, TRACK_H);
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 1;
    ctx.strokeRect(trackX, tY - TRACK_H / 2, trackW, TRACK_H);

    // Filled portion
    const ratio   = s.max > 0 ? s.amount / s.max : 0;
    const fillW   = Math.round(trackW * ratio);
    ctx.fillStyle = s.color;
    ctx.fillRect(trackX, tY - TRACK_H / 2, fillW, TRACK_H);

    // Min / Max labels
    ctx.font = '9px Georgia, serif';
    ctx.fillStyle = '#446';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('1', trackX, tY + TRACK_H / 2 + 3);
    ctx.textAlign = 'right';
    ctx.fillText(String(s.max), trackX + trackW, tY + TRACK_H / 2 + 3);

    // Thumb — grows when dragging
    const thumbX = trackX + fillW;
    const thumbR  = s.sliderDragging ? 11 : 9;
    // Shadow
    ctx.shadowColor   = s.sliderDragging ? s.color : 'rgba(0,0,0,0.5)';
    ctx.shadowBlur    = s.sliderDragging ? 8 : 4;
    ctx.fillStyle     = s.sliderDragging ? '#fff' : '#dde';
    ctx.beginPath();
    ctx.arc(thumbX, tY, thumbR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur    = 0;
    ctx.strokeStyle   = s.sliderDragging ? '#ffee88' : s.color;
    ctx.lineWidth     = s.sliderDragging ? 2.5 : 2;
    ctx.stroke();
    // Grip lines
    ctx.strokeStyle   = s.sliderDragging ? '#888' : '#667';
    ctx.lineWidth     = 1.5;
    for (const dx of [-3, 0, 3]) {
      ctx.beginPath();
      ctx.moveTo(thumbX + dx, tY - 4);
      ctx.lineTo(thumbX + dx, tY + 4);
      ctx.stroke();
    }

    // ── Buttons ───────────────────────────────────────────────────────────
    const c = s.confirmHit;
    ctx.fillStyle = 'rgba(180,100,0,0.9)';
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = '#ffcc44';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.font = 'bold 13px Georgia, serif';
    ctx.fillStyle = '#fff8e0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DROP', c.x + c.w / 2, c.y + c.h / 2);

    const cc = s.cancelHit;
    ctx.fillStyle = 'rgba(40,40,60,0.9)';
    ctx.fillRect(cc.x, cc.y, cc.w, cc.h);
    ctx.strokeStyle = '#445';
    ctx.lineWidth = 1;
    ctx.strokeRect(cc.x, cc.y, cc.w, cc.h);
    ctx.fillStyle = '#aaa';
    ctx.fillText('CANCEL', cc.x + cc.w / 2, cc.y + cc.h / 2);

    // Hint — rendered below the buttons
    ctx.font = '10px Georgia, serif';
    ctx.fillStyle = '#445';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Drag • Scroll • Click amount to type', sx + SW / 2, s.confirmHit.y + s.confirmHit.h + 8);

    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────────────────

  private _header(ctx: CanvasRenderingContext2D, px: number, py: number): number {
    ctx.fillStyle = 'rgba(255,215,0,0.06)';
    ctx.fillRect(px, py, PANEL_W, HEADER_H);

    ctx.font = 'bold 17px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD;
    ctx.fillText('⚔  CHARACTER', px + PAD, py + HEADER_H / 2);

    ctx.font = '12px Georgia, serif';
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

    // Clear equipment slot hit-test records for this frame
    this._equipSlotHits = [];

    // ── Equipment grid ──────────────────────────────────────────────────────
    // row 0:  [  –  ] [ Helm ] [  –  ]
    // row 1:  [Gloves] [Chest] [Shield]
    // row 2:  [  –  ] [ Legs ] [  –  ]
    // row 3:  [  –  ] [ Boots] [  –  ]
    type SlotSpec = { label: string; slotKey: string; item: ItemKind } | null;
    const grid: SlotSpec[][] = [
      [null,                                                      { label: 'Helm',   slotKey: 'helm',   item: equip.helm   }, null],
      [{ label: 'Gloves', slotKey: 'hands',  item: equip.hands }, { label: 'Chest',  slotKey: 'torso',  item: equip.torso  }, { label: 'Shield', slotKey: 'shield', item: equip.shield }],
      [null,                                                      { label: 'Legs',   slotKey: 'legs',   item: equip.legs   }, null],
      [null,                                                      { label: 'Boots',  slotKey: 'feet',   item: equip.feet   }, null],
    ];

    for (let row = 0; row < grid.length; row++) {
      for (let col = 0; col < 3; col++) {
        const spec = grid[row][col];
        if (!spec) continue;
        const { label, slotKey, item } = spec;
        const def = ITEM_DEFS[item] ?? ITEM_DEFS['none'];
        const sx  = equipX + col * (ESLOTSZ + ESGAP);
        const sy  = equipTop + row * ROW_STRIDE;

        const isHovered = mouseX >= sx && mouseX <= sx + ESLOTSZ && mouseY >= sy && mouseY <= sy + ESLOTSZ;
        ctx.fillStyle   = item !== 'none'
          ? (isHovered ? 'rgba(80,65,30,0.95)' : 'rgba(60,50,25,0.95)')
          : 'rgba(25,25,38,0.9)';
        ctx.fillRect(sx, sy, ESLOTSZ, ESLOTSZ);
        ctx.strokeStyle = item !== 'none' ? (isHovered ? '#ddaa44' : def.borderColor) : '#445';
        ctx.lineWidth   = 1;
        ctx.strokeRect(sx, sy, ESLOTSZ, ESLOTSZ);

        if (item !== 'none') {
          const pad = 7;
          ctx.fillStyle    = def.color;
          ctx.fillRect(sx + pad, sy + pad, ESLOTSZ - pad * 2, ESLOTSZ - pad * 2);
          ctx.font         = 'bold 18px Georgia, serif';
          ctx.fillStyle    = '#fff';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          if (item === 'axe') drawAxeIcon(ctx, sx + ESLOTSZ / 2, sy + ESLOTSZ / 2, ESLOTSZ);
          else if (item === 'sword') drawSwordIcon(ctx, sx + ESLOTSZ / 2, sy + ESLOTSZ / 2, ESLOTSZ);
          else ctx.fillText(def.symbol, sx + ESLOTSZ / 2, sy + ESLOTSZ / 2);
        }

        // Always register hit region — filled slots: click to unequip; empty slots: drop target for equip
        this._equipSlotHits.push({ slot: slotKey, item, x: sx, y: sy, w: ESLOTSZ, h: ESLOTSZ });

        ctx.font         = '10px Georgia, serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = item !== 'none' ? TEXT_HEAD : TEXT_DIM;
        ctx.fillText(label, sx + ESLOTSZ / 2, sy + ESLOTSZ + 2);

        // Hover tooltip: item name + "click to unequip"
        if (item !== 'none' && isHovered) {
          const tipLines = [def.name, 'click to unequip'];
          const TIP_PAD = 5;
          ctx.font = '10px Georgia, serif';
          const tipW = Math.max(...tipLines.map(l => ctx.measureText(l).width)) + TIP_PAD * 2;
          const tipH = tipLines.length * 14 + TIP_PAD * 2;
          const tipX = Math.min(sx + ESLOTSZ + 4, equipX + 3 * ESLOTSZ + 2 * ESGAP - tipW - 2);
          const tipY = sy;
          ctx.fillStyle   = '#1a1a2c';
          ctx.strokeStyle = '#667';
          ctx.lineWidth   = 1;
          ctx.fillRect(tipX, tipY, tipW, tipH);
          ctx.strokeRect(tipX, tipY, tipW, tipH);
          ctx.fillStyle    = '#ccd';
          ctx.textAlign    = 'left';
          ctx.textBaseline = 'top';
          tipLines.forEach((line, li) => ctx.fillText(line, tipX + TIP_PAD, tipY + TIP_PAD + li * 14));
        }
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
    ctx.font         = 'bold 11px Georgia, serif';
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
    // Armor value from equipped cloth gear
    const armorVal = _calcArmorValue(player.inventory.equipment);
    statusRows.push(['Armor', armorVal > 0 ? `${armorVal} DEF` : 'None', armorVal > 0 ? '#8bc4ff' : TEXT_DIM]);

    for (let i = 0; i < statusRows.length; i++) {
      const [label, value, valColor] = statusRows[i];
      if (i % 2 === 1) {
        ctx.fillStyle = BG_STRIPE;
        ctx.fillRect(statusX, sty, statusW, STATUS_R);
      }
      ctx.font         = '12px Georgia, serif';
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

    ctx.font         = 'bold 11px Georgia, serif';
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
    ctx.font         = 'bold 12px Georgia, serif';
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
    ctx.font      = '10px Georgia, serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(xpLabel, statusX + statusW, sty);
    sty += 14;

    // LEVEL UP button — shown when the player has enough XP to advance
    const canLevelUp = !isMax && xp >= xpToNext;
    this._levelUpBtnHit = null;
    if (canLevelUp) {
      const LU_W = 80, LU_H = 18;
      const luX = statusX + statusW - LU_W;
      const luY = sty - 1;
      const luHover = mouseX >= luX && mouseX <= luX + LU_W && mouseY >= luY && mouseY <= luY + LU_H;
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 300);
      const r = Math.round(80  + pulse * 60).toString(16).padStart(2, '0');
      const g = Math.round(200 + pulse * 55).toString(16).padStart(2, '0');
      ctx.fillStyle   = luHover ? `#44aa44` : `#${r}${g}00`;
      ctx.strokeStyle = luHover ? '#88ff88' : '#88dd44';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.roundRect(luX, luY, LU_W, LU_H, 3);
      ctx.fill();
      ctx.stroke();
      ctx.font         = 'bold 10px Georgia, serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#ffffff';
      ctx.fillText('▲ LEVEL UP', luX + LU_W / 2, luY + LU_H / 2);
      this._levelUpBtnHit = { x: luX, y: luY, w: LU_W, h: LU_H };
      sty += LU_H + 3;
    }

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
      ctx.font         = 'bold 12px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = stat.color;
      ctx.fillText(stat.label, statusX + 4, sty + STAT_ROW_H / 2);

      // Current actual value (e.g. "140 HP")
      ctx.font      = 'bold 11px Georgia, serif';
      ctx.fillStyle = statLvl > 0 ? stat.color : TEXT_DIM;
      ctx.fillText(stat.currentVal(player, statLvl), statusX + 70, sty + STAT_ROW_H / 2);

      // Per-point gain — green if can afford, grey if not
      ctx.font      = '10px Georgia, serif';
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
      ctx.font         = 'bold 14px Georgia, serif';
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
      ctx.font = 'bold 10px Georgia, serif';
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

    // ── Carry Weight bar ─────────────────────────────────────────────────────
    {
      sty += 8;
      // Separator line
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(statusX, sty);
      ctx.lineTo(statusX + statusW, sty);
      ctx.stroke();
      sty += 5;

      const weightLvl     = (player.statWeight ?? 0) as number;
      const BASE_CAPACITY = 300;
      const capacity      = Math.round(BASE_CAPACITY * (1 + weightLvl * 0.1));
      const carried       = computeInventoryWeight(player.inventory);
      const pct           = Math.min(carried / capacity, 1);

      // Warn colours: normal → green, >75% → amber, >95% → red
      const barColor = pct >= 0.95 ? '#cc2222' : pct >= 0.75 ? '#cc8811' : '#3a8a3a';

      const BAR_H  = 8;
      const LABEL_W = 80;
      const barW   = statusW - LABEL_W;
      const barX   = statusX + LABEL_W;

      ctx.font         = 'bold 11px Georgia, serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#aabbcc';
      ctx.fillText('Carry Weight', statusX + 4, sty + BAR_H / 2);

      // Track
      ctx.fillStyle = '#111827';
      ctx.fillRect(barX, sty, barW, BAR_H);
      // Fill
      ctx.fillStyle = barColor;
      ctx.fillRect(barX, sty, Math.round(barW * pct), BAR_H);
      // Border
      ctx.strokeStyle = '#334';
      ctx.lineWidth   = 1;
      ctx.strokeRect(barX, sty, barW, BAR_H);

      sty += BAR_H + 3;

      // Numeric label right-aligned: "47 / 110"
      ctx.font      = '10px Georgia, serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = pct >= 0.95 ? '#ff6666' : pct >= 0.75 ? '#ffcc66' : '#88aabb';
      ctx.fillText(`${carried} kg / ${capacity} kg`, statusX + statusW, sty);
      sty += 13;
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

    // Read materials from the resource pool (wood/fiber/metal/stone live there, not in slots)
    const res = player.inventory.resources;
    const counts: Partial<Record<ItemKind, number>> = {
      wood:  res.wood,
      fiber: res.fiber,
      metal: res.metal,
      stone: res.stone,
    };
    // Also count non-resource items still in slots (e.g. planks, repair kits used as ingredients)
    for (const slot of player.inventory.slots) {
      if (slot.item !== 'none' && !(slot.item in counts)) {
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

      ctx.font         = `${isActive ? 'bold ' : ''}10px Georgia, serif`;
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
        ctx.font         = 'bold 14px Georgia, serif';
        ctx.fillStyle    = '#fff';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        if (recipe.output === 'axe') drawAxeIcon(ctx, iconX + ICON / 2, iconY + ICON / 2, ICON);
        else ctx.fillText(outDef.symbol, iconX + ICON / 2, iconY + ICON / 2);

        // Output name + qty
        const textX = iconX + ICON + 6;
        ctx.font         = 'bold 12px Georgia, serif';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = canAfford ? TEXT_HEAD : TEXT_DIM;
        const nameStr = outDef.name + (recipe.outputQty > 1 ? ` x${recipe.outputQty}` : '');
        ctx.fillText(nameStr, textX, ry + 7);

        // Ingredients with per-item colour
        ctx.font = '10px Georgia, serif';
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
        ctx.font         = 'bold 11px Georgia, serif';
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

  // ── Resources section ────────────────────────────────────────────────────

  private _resourcesSection(
    ctx: CanvasRenderingContext2D,
    px:  number, py: number,
    res: PlayerResources,
    mouseX = 0, mouseY = 0,
  ): number {
    py = this._sectionHeader(ctx, px, py, 'RESOURCES', 'drag outside to drop');
    py += 6;

    const items: Array<{
      label: string; key: keyof PlayerResources;
      color: string; border: string; symbol: string;
      kgPerUnit: number; desc: string;
    }> = [
      { label: 'Wood',  key: 'wood',  color: '#8b5e2a', border: '#5c3a10', symbol: 'W',  kgPerUnit: 2.0, desc: 'Harvested from trees. Used in construction.' },
      { label: 'Fiber', key: 'fiber', color: '#c8a46e', border: '#8a6030', symbol: 'Fi', kgPerUnit: 0.1, desc: 'Gathered from plants. Used in cloth crafting.' },
      { label: 'Metal', key: 'metal', color: '#8a8a8c', border: '#555558', symbol: 'Fe', kgPerUnit: 5.0, desc: 'Mined from ore deposits. Used in metalwork.' },
      { label: 'Stone', key: 'stone', color: '#9a9a9c', border: '#666668', symbol: 'St', kgPerUnit: 4.0, desc: 'Quarried from boulders. Used in fortifications.' },
    ];

    const RCOLS  = items.length;
    const GAP    = 8;
    const CHIP_W = Math.floor((PANEL_W - 2 * PAD - (RCOLS - 1) * GAP) / RCOLS);
    const CHIP_H = 58;
    const LAB_H  = 14;
    const x0     = px + PAD;

    // Reset hit regions and hover tooltip for this frame
    this._resChipHits    = [];
    this._resHoverTooltip = null;

    for (let i = 0; i < items.length; i++) {
      const r   = items[i];
      const cx_ = x0 + i * (CHIP_W + GAP);
      const qty = res[r.key];
      const has = qty > 0;
      const isDragging = this._resDragKey === r.key;
      const isHovered  = !isDragging &&
                         mouseX >= cx_ && mouseX <= cx_ + CHIP_W &&
                         mouseY >= py  && mouseY <= py + CHIP_H;

      // Register hit region
      this._resChipHits.push({ key: r.key, label: r.label, color: r.color, x: cx_, y: py, w: CHIP_W, h: CHIP_H, max: qty });

      // Store hover data for tooltip rendered outside clip
      if (isHovered) {
        this._resHoverTooltip = {
          cx: cx_ + CHIP_W / 2, cy: py,
          label: r.label, color: r.color,
          desc: r.desc, kgPerUnit: r.kgPerUnit, qty,
        };
      }

      // Background
      ctx.fillStyle = 'rgba(14, 18, 28, 0.95)';
      ctx.fillRect(cx_, py, CHIP_W, CHIP_H);

      // Coloured tint — brighter when dragging or hovered
      ctx.fillStyle = r.color;
      ctx.globalAlpha = isDragging ? 0.38 : isHovered ? 0.28 : has ? 0.18 : 0.06;
      ctx.fillRect(cx_, py, CHIP_W, CHIP_H);
      ctx.globalAlpha = 1.0;

      // Border
      ctx.strokeStyle = isDragging ? '#fff' : isHovered ? '#fff' : has ? r.color : '#334';
      ctx.lineWidth   = (isDragging || isHovered || has) ? 1.5 : 1;
      ctx.strokeRect(cx_, py, CHIP_W, CHIP_H);

      // Drag hint arrow (top-right corner)
      if (has) {
        ctx.font         = '10px Georgia, serif';
        ctx.fillStyle    = 'rgba(255,255,255,0.3)';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText('⤤', cx_ + CHIP_W - 3, py + 3);
      }

      // Symbol
      ctx.font         = 'bold 13px Georgia, serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = has ? r.color : '#446';
      ctx.fillText(r.symbol, cx_ + CHIP_W / 2, py + 14);

      // Quantity
      ctx.font      = has ? 'bold 13px Georgia, serif' : '12px Georgia, serif';
      ctx.fillStyle = has ? '#fff' : '#556';
      ctx.fillText(String(qty), cx_ + CHIP_W / 2, py + 30);

      // Weight line (dim, small)
      const totalKg = qty * r.kgPerUnit;
      ctx.font      = '9px Georgia, serif';
      ctx.fillStyle = has ? 'rgba(180,200,220,0.70)' : '#334';
      ctx.fillText(
        has ? `${totalKg < 1 ? totalKg.toFixed(2) : totalKg.toFixed(1)} kg` : '0 kg',
        cx_ + CHIP_W / 2, py + 44,
      );

      // Label below chip
      ctx.font         = '10px Georgia, serif';
      ctx.fillStyle    = isHovered ? '#fff' : TEXT_DIM;
      ctx.textBaseline = 'top';
      ctx.fillText(r.label, cx_ + CHIP_W / 2, py + CHIP_H + 3);
    }

    return py + CHIP_H + LAB_H + 10;
  }

  // ─────────────────────────────────────────────────────────────────────────

  private _inventoryGrid(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
    mouseX = 0, mouseY = 0,
  ): number {
    const inv    = player.inventory;
    const COLS   = 8;
    const IGAP   = 6;
    // Slots expand to fill the inner content width
    const ISZ    = Math.floor((PANEL_W - 2 * PAD - (COLS - 1) * IGAP) / COLS);
    const STRIDE = ISZ + IGAP;
    const ROWS   = Math.ceil(INVENTORY_SLOTS / COLS);  // 2
    const LABEL_ROW_H = 14; // hotbar key-number row height

    const activeSlot = inv.activeSlot;
    const slotLabel  = (activeSlot === 255 || activeSlot >= HOTBAR_SLOTS)
      ? 'no selection'
      : `slot ${activeSlot + 1} active`;

    py = this._sectionHeader(ctx, px, py, `INVENTORY  (${INVENTORY_SLOTS} slots)`, slotLabel);
    py += 6;

    const startIX  = px + PAD;
    const contentH = ROWS * STRIDE - IGAP + LABEL_ROW_H + 4;
    // Viewport: show all content (panel scroll handles any overflow)
    const viewportH = contentH;

    // Cache for handleWheel (kept for drag hit-testing)
    this._invGridY     = py;
    this._invContentH  = contentH;
    this._invViewportH = viewportH;

    // Cache for drag hit-testing
    this._dragISZ     = ISZ;
    this._dragStride  = STRIDE;
    this._dragStartIX = startIX;

    this._invScrollY = 0;
    const maxScroll  = 0;

    // Clip to inventory grid
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, PANEL_W, viewportH);
    ctx.clip();

    const scrollY = 0;

    let hoveredSlot = -1;
    let hoveredSX   = 0;
    let hoveredSY   = 0;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        if (i >= INVENTORY_SLOTS) break;

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
          ctx.font         = 'bold 16px Georgia, serif';
          ctx.fillStyle    = '#fff';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          if (slot.item === 'axe') drawAxeIcon(ctx, sx + ISZ / 2, sy + ISZ / 2, ISZ);
          else if (slot.item === 'sword') drawSwordIcon(ctx, sx + ISZ / 2, sy + ISZ / 2, ISZ);
          else ctx.fillText(def.symbol, sx + ISZ / 2, sy + ISZ / 2);

          if (slot.quantity > 1) {
            ctx.font         = '10px Georgia, serif';
            ctx.textAlign    = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle    = '#fff';
            ctx.fillText(String(slot.quantity), sx + ISZ - 3, sy + ISZ - 2);
          }
          ctx.globalAlpha = 1.0;
        }
      }
    }

    // Hotbar key-number labels below first row (slots 1–8)
    ctx.font         = '10px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const sx = startIX + i * STRIDE;
      ctx.fillStyle = i === activeSlot ? GOLD : TEXT_DIM;
      ctx.fillText(String(i + 1), sx + ISZ / 2, py + ISZ + 3);
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
        ctx.font = 'bold 16px Georgia, serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (dragSlotData.item === 'axe') drawAxeIcon(ctx, gx + ISZ / 2, gy + ISZ / 2, ISZ);
        else if (dragSlotData.item === 'sword') drawSwordIcon(ctx, gx + ISZ / 2, gy + ISZ / 2, ISZ);
        else ctx.fillText(def.symbol, gx + ISZ / 2, gy + ISZ / 2);
        ctx.globalAlpha = 1.0;
        ctx.restore();
      }
    }

    // Scrollbar handled at the panel level
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
    const descLines = this._wrapText(ctx, def.description, W - PAD_T * 2, '12px Georgia, serif');
    const quantityLine = slot.quantity > 1 ? 1 : 0;
    const totalH = PAD_T + nameH + 4 + LINE + 4 + descLines.length * LINE + quantityLine * LINE + LINE + PAD_T;

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
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(def.name, tx + PAD_T + 4, cy);
    cy += nameH + 4;

    ctx.fillStyle = '#888';
    ctx.font      = '11px Georgia, serif';
    ctx.fillText(`ID: ${itemId}   [${def.category}]`, tx + PAD_T + 4, cy);
    cy += LINE + 4;

    ctx.fillStyle = '#ccc';
    ctx.font      = '12px Georgia, serif';
    for (const line of descLines) {
      ctx.fillText(line, tx + PAD_T + 4, cy);
      cy += LINE;
    }

    if (slot.quantity > 1) {
      ctx.fillStyle = '#aaa';
      ctx.fillText(`Qty: ${slot.quantity}`, tx + PAD_T + 4, cy);
      cy += LINE;
    }

    // Weight
    const wPerUnit = def.weight;
    const totalWt  = wPerUnit * (slot.quantity || 1);
    const weightTxt = slot.quantity > 1
      ? `Weight: ${wPerUnit} kg ea  ·  ${totalWt} kg total`
      : `Weight: ${wPerUnit} kg`;
    ctx.fillStyle = '#8ab4cc';
    ctx.font      = '11px Georgia, serif';
    ctx.fillText(weightTxt, tx + PAD_T + 4, cy);

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

  // ── Schematics data ──────────────────────────────────────────────────────

  private static readonly SCHEMATICS: {
    subTab: 'LAND' | 'SHIP';
    kind: string;
    name: string;
    symbol: string;
    color: string;
    wood: number; fiber: number; metal: number; stone: number;
  }[] = [
    // LAND
    { subTab: 'LAND', kind: 'wooden_floor',    name: 'Wooden Floor',    symbol: '\u229f', color: '#8b6914', wood: 10, fiber: 0, metal: 0,  stone: 0 },
    { subTab: 'LAND', kind: 'wall',             name: 'Wall',            symbol: '\u258b', color: '#7a6030', wood: 10, fiber: 0, metal: 0,  stone: 0 },
    { subTab: 'LAND', kind: 'door_frame',       name: 'Door Frame',      symbol: '\u2293', color: '#6a5028', wood: 6,  fiber: 0, metal: 0,  stone: 0 },
    { subTab: 'LAND', kind: 'door',             name: 'Door',            symbol: '\uD83D\uDEAA', color: '#7a5838', wood: 6,  fiber: 0, metal: 0,  stone: 0 },
    { subTab: 'LAND', kind: 'wood_ceiling',     name: 'Wood Ceiling',    symbol: '\u229e', color: '#7a5c2a', wood: 8,  fiber: 0, metal: 0,  stone: 0 },
    { subTab: 'LAND', kind: 'workbench',        name: 'Workbench',       symbol: '\u2692', color: '#6b4c1e', wood: 15, fiber: 0, metal: 0,  stone: 0 },
    { subTab: 'LAND', kind: 'shipyard',         name: 'Shipyard',        symbol: '\u26F5', color: '#4a6080', wood: 20, fiber: 0, metal: 5,  stone: 0 },
    { subTab: 'LAND', kind: 'cannon',           name: 'Cannon',          symbol: '\u25CF', color: '#333333', wood: 8,  fiber: 0, metal: 20, stone: 0 },
    { subTab: 'LAND', kind: 'flag_fort',        name: 'Flag Fort',       symbol: '\uD83D\uDEA9', color: '#2a5c2a', wood: 20, fiber: 0, metal: 10, stone: 10 },
    { subTab: 'LAND', kind: 'company_fortress', name: 'Fortress',        symbol: '\uD83C\uDFF0', color: '#4a3060', wood: 40, fiber: 0, metal: 20, stone: 20 },
    { subTab: 'LAND', kind: 'claim_flag',       name: 'Claim Flag',      symbol: '\uD83C\uDFF3', color: '#c0a020', wood: 5,  fiber: 5, metal: 0,  stone: 0 },
    // SHIP
    { subTab: 'SHIP', kind: 'plank',     name: 'Plank',      symbol: '\u25A1', color: '#7a5c2a', wood: 10, fiber: 0,  metal: 0, stone: 0 },
    { subTab: 'SHIP', kind: 'deck',      name: 'Deck',       symbol: '\u25A0', color: '#4a3820', wood: 15, fiber: 0,  metal: 0, stone: 0 },
    { subTab: 'SHIP', kind: 'cannon',    name: 'Cannon',     symbol: '\u25CF', color: '#333333', wood: 2,  fiber: 0,  metal: 5, stone: 0 },
    { subTab: 'SHIP', kind: 'swivel',    name: 'Swivel Gun', symbol: '\u203A', color: '#7a4a2a', wood: 1,  fiber: 0,  metal: 3, stone: 0 },
    { subTab: 'SHIP', kind: 'mast',      name: 'Mast',       symbol: '\u2021', color: '#8b6914', wood: 20, fiber: 10, metal: 0, stone: 0 },
    { subTab: 'SHIP', kind: 'helm',      name: 'Helm',       symbol: '\u2388', color: '#6a4820', wood: 5,  fiber: 0,  metal: 3, stone: 0 },
    { subTab: 'SHIP', kind: 'ramp',      name: 'Ramp',       symbol: '\u2571', color: '#5c4018', wood: 8,  fiber: 0,  metal: 0, stone: 0 },
    { subTab: 'SHIP', kind: 'hatch',     name: 'Hatch',      symbol: '\u25A3', color: '#4a3010', wood: 8,  fiber: 0,  metal: 0, stone: 0 },
    { subTab: 'SHIP', kind: 'helm_kit',  name: 'Helm Kit',   symbol: '\u2388', color: '#7a5838', wood: 5,  fiber: 0,  metal: 3, stone: 0 },
    { subTab: 'SHIP', kind: 'sail',      name: 'Sail',       symbol: '\u25B3', color: '#e0e0e0', wood: 0,  fiber: 20, metal: 0, stone: 0 },
  ];

  private _schematicsTab(
    ctx:          CanvasRenderingContext2D,
    px:           number,
    contentTop:   number,
    contentBottom: number,
    player:       NonNullable<ReturnType<WorldState['players']['find']>> | null,
  ): void {
    const res = player?.inventory?.resources ?? { wood: 0, fiber: 0, metal: 0, stone: 0 };
    const INNER_PAD = 14;
    const SUB_TAB_H = 30;
    const CARD_H    = 64;
    const CARD_GAP  = 6;
    const CARD_W    = PANEL_W - INNER_PAD * 2;

    let cy = contentTop + INNER_PAD;

    // ── Sub-tab bar (LAND / SHIP) ─────────────────────────────────────────
    this._schematicsSubTabHits = [];
    this._schematicsHotbarHits = [];
    this._schematicsCardHits   = [];
    const subTabs: ('LAND' | 'SHIP')[] = ['LAND', 'SHIP'];
    const subTabW = Math.floor(CARD_W / subTabs.length);
    for (let i = 0; i < subTabs.length; i++) {
      const id   = subTabs[i];
      const tx   = px + INNER_PAD + i * subTabW;
      const isActive = this._schematicsSubTab === id;
      ctx.fillStyle = isActive ? 'rgba(255,215,0,0.12)' : 'rgba(0,0,0,0.30)';
      ctx.fillRect(tx, cy, subTabW, SUB_TAB_H);
      ctx.strokeStyle = isActive ? GOLD : BORDER;
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, cy + SUB_TAB_H);
      ctx.lineTo(tx + subTabW, cy + SUB_TAB_H);
      ctx.stroke();
      if (i < subTabs.length - 1) {
        ctx.strokeStyle = BORDER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx + subTabW, cy);
        ctx.lineTo(tx + subTabW, cy + SUB_TAB_H);
        ctx.stroke();
      }
      ctx.font = `${isActive ? 'bold ' : ''}12px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isActive ? GOLD : TEXT_DIM;
      const icon = id === 'LAND' ? '\uD83C\uDFD7' : '\u26F5';
      ctx.fillText(`${icon}  ${id}`, tx + subTabW / 2, cy + SUB_TAB_H / 2);
      this._schematicsSubTabHits.push({ label: id, x: tx, y: cy, w: subTabW, h: SUB_TAB_H });
    }
    cy += SUB_TAB_H + INNER_PAD;

    // ── Hotbar strip ──────────────────────────────────────────────────────
    const N_SLOTS = 8;
    const HS = 38;   // slot size px
    const HG = 3;    // gap between slots
    const HP = 6;    // inner padding of strip
    const STRIP_H = HS + HP * 2 + 10; // extra 10 for "HOTBAR" label
    const baseHotbar = this._schematicsSubTab === 'LAND' ? this.landHotbarSlots : this.shipHotbarSlots;
    const currentHotbar: (string | null)[] = Array.from({ length: N_SLOTS }, (_, i) => baseHotbar[i] ?? null);

    // Strip background
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(px + INNER_PAD, cy, CARD_W, STRIP_H, 4);
    ctx.fill();
    ctx.stroke();

    // "HOTBAR" label
    ctx.font = 'bold 8px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('HOTBAR — drag or click a schematic onto a slot  |  right-click to clear', px + INNER_PAD + 6, cy + 3);

    const slotsAreaW = N_SLOTS * (HS + HG) - HG;
    const slotsStartX = px + INNER_PAD + Math.floor((CARD_W - slotsAreaW) / 2);
    const slotsTopY   = cy + 13;

    for (let i = 0; i < N_SLOTS; i++) {
      const kind  = currentHotbar[i];
      const entry = kind ? PlayerMenu.SCHEMATICS.find(s => s.kind === kind) : null;
      const isSelected  = this._schematicsSelectedSlot === i;
      const sx = slotsStartX + i * (HS + HG);
      const sy = slotsTopY;
      const isDragTarget = this._schemDragKind !== null &&
        this._schemDragX >= sx && this._schemDragX <= sx + HS &&
        this._schemDragY >= sy && this._schemDragY <= sy + HS;

      this._schematicsHotbarHits.push({ slot: i, x: sx, y: sy, w: HS, h: HS });

      // Slot background
      ctx.fillStyle   = isDragTarget ? 'rgba(0,200,100,0.22)' : isSelected ? 'rgba(255,215,0,0.18)' : 'rgba(30,20,10,0.55)';
      ctx.strokeStyle = isDragTarget ? '#00cc66'              : isSelected ? GOLD                   : 'rgba(120,90,30,0.45)';
      ctx.lineWidth   = isDragTarget || isSelected ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(sx, sy, HS, HS, 3);
      ctx.fill();
      ctx.stroke();

      if (entry) {
        // Small icon swatch
        const SW = 18;
        const swX = sx + (HS - SW) / 2;
        const swY = sy + 3;
        ctx.fillStyle = entry.color;
        ctx.beginPath();
        ctx.roundRect(swX, swY, SW, SW, 2);
        ctx.fill();
        ctx.font = 'bold 9px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(entry.symbol, sx + HS / 2, swY + SW / 2);
        // Name below icon
        ctx.font = '6px Georgia, serif';
        ctx.fillStyle = isSelected ? GOLD : TEXT_DIM;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(entry.name.substring(0, 7), sx + HS / 2, sy + HS);
      } else {
        ctx.font = '14px Georgia, serif';
        ctx.fillStyle = '#443322';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('—', sx + HS / 2, sy + HS / 2);
      }

      // Slot number
      ctx.font = '7px monospace';
      ctx.fillStyle = isSelected ? GOLD : '#665533';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(String(i + 1), sx + 2, sy + 2);
    }
    cy += STRIP_H + 4;

    // Hint when a slot is selected
    if (this._schematicsSelectedSlot >= 0) {
      ctx.font = '10px Georgia, serif';
      ctx.fillStyle = GOLD;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `Slot ${this._schematicsSelectedSlot + 1} selected — click a schematic to assign`,
        px + PANEL_W / 2, cy,
      );
      cy += 15;
    }
    cy += Math.floor(INNER_PAD / 2);

    // ── Scrollable schematic cards ────────────────────────────────────────
    const viewH  = contentBottom - cy - INNER_PAD;
    const items  = PlayerMenu.SCHEMATICS.filter(s => s.subTab === this._schematicsSubTab);
    const totalH = items.length * (CARD_H + CARD_GAP);

    // Clamp scroll
    this._panelScrollY = Math.max(0, Math.min(this._panelScrollY, Math.max(0, totalH - viewH)));

    ctx.save();
    ctx.beginPath();
    ctx.rect(px, cy, PANEL_W, viewH);
    ctx.clip();

    let cardY = cy - this._panelScrollY;
    for (let si = 0; si < items.length; si++) {
      const s = items[si];
      const cardX = px + INNER_PAD;

      // Which hotbar slot (if any) is this schematic assigned to?
      const hotbarSlotIdx = currentHotbar.findIndex(k => k === s.kind);
      // Is the currently-selected slot pointing at this card?
      const isAssignTarget = this._schematicsSelectedSlot >= 0 &&
        currentHotbar[this._schematicsSelectedSlot] === s.kind;

      // Card background
      ctx.fillStyle = isAssignTarget ? 'rgba(255,215,0,0.10)' : 'rgba(255,255,255,0.04)';
      ctx.strokeStyle = isAssignTarget
        ? GOLD
        : hotbarSlotIdx >= 0
          ? 'rgba(255,180,0,0.35)'
          : 'rgba(120,90,30,0.35)';
      ctx.lineWidth = isAssignTarget || hotbarSlotIdx >= 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, CARD_W, CARD_H, 5);
      ctx.fill();
      ctx.stroke();

      // Register card hit area
      this._schematicsCardHits.push({ idx: si, kind: s.kind, x: cardX, y: cardY, w: CARD_W, h: CARD_H });

      // Icon box
      const ICON_SZ = 42;
      const iconX = cardX + 10;
      const iconY = cardY + (CARD_H - ICON_SZ) / 2;
      ctx.fillStyle = s.color;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(iconX, iconY, ICON_SZ, ICON_SZ, 4);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 18px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(s.symbol, iconX + ICON_SZ / 2, iconY + ICON_SZ / 2);

      // Name
      const textX = iconX + ICON_SZ + 12;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = 'bold 14px Georgia, serif';
      ctx.fillStyle = TEXT_HEAD;
      ctx.fillText(s.name, textX, cardY + 12);

      // Quality badge — all defaults are Common
      const QUAL_LABEL = '\u25c6 Common';
      ctx.font = '10px Georgia, serif';
      const qualW = ctx.measureText(QUAL_LABEL).width + 8;
      const qualX = cardX + CARD_W - qualW - 8;
      const qualY = cardY + 8;
      ctx.fillStyle = 'rgba(180,180,200,0.18)';
      ctx.beginPath();
      ctx.roundRect(qualX, qualY, qualW, 16, 3);
      ctx.fill();
      ctx.fillStyle = '#c0bcd0';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(QUAL_LABEL, qualX + 4, qualY + 3);

      // Slot badge — shown when this schematic is already in a hotbar slot
      if (hotbarSlotIdx >= 0) {
        const slotLabel = `#${hotbarSlotIdx + 1}`;
        ctx.font = 'bold 9px monospace';
        const badgeW = ctx.measureText(slotLabel).width + 8;
        const badgeX = qualX - badgeW - 4;
        ctx.fillStyle = 'rgba(255,180,0,0.28)';
        ctx.beginPath();
        ctx.roundRect(badgeX, qualY, badgeW, 16, 3);
        ctx.fill();
        ctx.fillStyle = GOLD;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(slotLabel, badgeX + badgeW / 2, qualY + 8);
      }

      // Resource costs inline
      const costs: Array<{ label: string; cost: number; have: number }> = [
        { label: 'Wood',  cost: s.wood,  have: res.wood  },
        { label: 'Fiber', cost: s.fiber, have: res.fiber },
        { label: 'Metal', cost: s.metal, have: res.metal },
        { label: 'Stone', cost: s.stone, have: res.stone },
      ].filter(c => c.cost > 0);

      ctx.font = '11px Georgia, serif';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      let rx = textX;
      const costY = cardY + 34;
      for (const c of costs) {
        const ok = c.have >= c.cost;
        const chip = `${c.cost}\u00d7 ${c.label}`;
        const chipW = ctx.measureText(chip).width + 10;
        ctx.fillStyle = ok ? 'rgba(40,100,40,0.55)' : 'rgba(120,30,30,0.55)';
        ctx.beginPath();
        ctx.roundRect(rx, costY, chipW, 18, 3);
        ctx.fill();
        ctx.fillStyle = ok ? '#88ee88' : '#ee8888';
        ctx.fillText(chip, rx + 5, costY + 4);
        rx += chipW + 5;
      }
      if (costs.length === 0) {
        ctx.fillStyle = TEXT_DIM;
        ctx.fillText('No resources required', rx, costY + 3);
      }

      cardY += CARD_H + CARD_GAP;
    }

    ctx.restore();

    // Scrollbar
    if (totalH > viewH) {
      const SB_W  = 4;
      const sbX   = px + PANEL_W - 8;
      const thumb = Math.max(24, (viewH / totalH) * viewH);
      const thumbY = cy + (this._panelScrollY / Math.max(1, totalH - viewH)) * (viewH - thumb);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(sbX, cy, SB_W, viewH);
      ctx.fillStyle = 'rgba(255,215,0,0.50)';
      ctx.fillRect(sbX, thumbY, SB_W, thumb);
    }

    // Schematic drag ghost — rendered above the clip region
    if (this._schemDragKind !== null && this._schemDragActive) {
      const entry = PlayerMenu.SCHEMATICS.find(s => s.kind === this._schemDragKind);
      if (entry) {
        const GS = 46;
        const gx = this._schemDragX - GS / 2;
        const gy = this._schemDragY - GS / 2;
        ctx.save();
        ctx.globalAlpha = 0.87;
        ctx.fillStyle = 'rgba(12,12,24,0.80)';
        ctx.beginPath();
        ctx.roundRect(gx, gy, GS, GS, 5);
        ctx.fill();
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(gx, gy, GS, GS, 5);
        ctx.stroke();
        ctx.fillStyle = entry.color;
        ctx.beginPath();
        ctx.roundRect(gx + 4, gy + 4, GS - 8, GS - 8, 3);
        ctx.fill();
        ctx.font = 'bold 17px Georgia, serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(entry.symbol, this._schemDragX, this._schemDragY);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
  }

  private _tabBar(ctx: CanvasRenderingContext2D, px: number, py: number): number {
    const tabs: Array<{ label: string; id: 'character' | 'skills' | 'schematics' }> = [
      { label: '⚔  CHARACTER',   id: 'character'  },
      { label: '✦  SKILLS',      id: 'skills'     },
      { label: '📐  SCHEMATICS', id: 'schematics' },
    ];
    const tabW = Math.floor(PANEL_W / tabs.length);

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

      ctx.font = `${isActive ? 'bold ' : ''}12px Georgia, serif`;
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

    ctx.font = '14px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('Skill tree — coming soon.', midX, midY - 12);

    ctx.font = '12px Georgia, serif';
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

    ctx.font = 'bold 12px Georgia, serif';
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
