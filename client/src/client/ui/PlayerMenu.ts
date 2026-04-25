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
import { ITEM_DEFS, ItemKind, HOTBAR_SLOTS } from '../../sim/Inventory.js';

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
interface StatDef {
  key:    'statHealth' | 'statDamage' | 'statStamina' | 'statWeight';
  server: string;
  label:  string;
  desc:   (lvl: number) => string;
  color:  string;
}

const PLAYER_MAX_LEVEL = 120;

const STATS: StatDef[] = [
  { key: 'statHealth',  server: 'health',  label: 'Health',
    desc: (l) => l > 0 ? `+${l * 20} max HP` : 'No bonus', color: '#44cc66' },
  { key: 'statDamage',  server: 'damage',  label: 'Damage',
    desc: (l) => l > 0 ? `+${l * 10}% weapon dmg` : 'No bonus', color: '#ff5544' },
  { key: 'statStamina', server: 'stamina', label: 'Stamina',
    desc: (l) => l > 0 ? `+${l * 10}% speed` : 'No bonus', color: '#ffaa44' },
  { key: 'statWeight',  server: 'weight',  label: 'Weight',
    desc: (l) => l > 0 ? `+${l * 10}% carry` : 'No bonus', color: '#88ccff' },
];

interface BtnHit {
  serverKey: string;
  x: number; y: number; w: number; h: number;
  affordable: boolean;
}

export class PlayerMenu {
  public visible = false;
  private activeTab: 'character' | 'skills' = 'character';

  /** Set by UIManager; called when the player clicks an affordable upgrade button. */
  public onUpgradeRequest: ((stat: string) => void) | null = null;

  // Cached panel origin — set each render frame, used by handleClick
  private _panelX = 0;
  private _panelY = 0;
  private _btnHits: BtnHit[] = [];

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

    return true; // click inside panel — consume to avoid accidental close
  }

  render(
    ctx:             CanvasRenderingContext2D,
    worldState:      WorldState,
    assignedId:      number | null | undefined,
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

    cur = this._equipmentSection(ctx, px, cur, player);
    cur = this._status(ctx, px, cur, player, ship, worldState);
    cur = this._levelXpCompact(ctx, px, cur, player);
    cur = this._inventoryGrid(ctx, px, cur, player);

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
  // Equipment section — 6 body slots at top of character tab

  private _equipmentSection(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
  ): number {
    const equip = player.inventory.equipment;
    py = this._sectionHeader(ctx, px, py, 'EQUIPMENT', '');
    py += 8;

    const ESLOTSZ = 46;
    const ESGAP   = 8;
    const equipSlots: Array<{ label: string; item: ItemKind }> = [
      { label: 'Helm',   item: equip.helm   },
      { label: 'Torso',  item: equip.torso  },
      { label: 'Legs',   item: equip.legs   },
      { label: 'Feet',   item: equip.feet   },
      { label: 'Hands',  item: equip.hands  },
      { label: 'Shield', item: equip.shield },
    ];

    const totalEW = 6 * ESLOTSZ + 5 * ESGAP;
    const startEX = px + Math.round((PANEL_W - totalEW) / 2);

    for (let i = 0; i < 6; i++) {
      const { label, item } = equipSlots[i];
      const def = ITEM_DEFS[item] ?? ITEM_DEFS['none'];
      const sx  = startEX + i * (ESLOTSZ + ESGAP);

      ctx.fillStyle = item !== 'none' ? 'rgba(60,50,25,0.95)' : 'rgba(25,25,38,0.9)';
      ctx.fillRect(sx, py, ESLOTSZ, ESLOTSZ);
      ctx.strokeStyle = item !== 'none' ? def.borderColor : '#445';
      ctx.lineWidth   = 1;
      ctx.strokeRect(sx, py, ESLOTSZ, ESLOTSZ);

      if (item !== 'none') {
        const pad = 7;
        ctx.fillStyle = def.color;
        ctx.fillRect(sx + pad, py + pad, ESLOTSZ - pad * 2, ESLOTSZ - pad * 2);
        ctx.font         = 'bold 18px Consolas, monospace';
        ctx.fillStyle    = '#fff';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.symbol, sx + ESLOTSZ / 2, py + ESLOTSZ / 2);
      }

      // Label below slot
      ctx.font         = '10px Consolas, monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = item !== 'none' ? TEXT_HEAD : TEXT_DIM;
      ctx.fillText(label, sx + ESLOTSZ / 2, py + ESLOTSZ + 3);
    }

    return py + ESLOTSZ + 20;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Level/XP bar + stat upgrades inline on the character tab

  private _levelXpCompact(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
  ): number {
    const lvl        = player.level ?? 1;
    const xp         = player.xp ?? 0;
    const isMax      = lvl >= PLAYER_MAX_LEVEL;
    const xpToNext   = isMax ? PLAYER_MAX_LEVEL * 100 : lvl * 100;
    const xpPct      = isMax ? 1 : Math.min(xp / xpToNext, 1);
    const statPoints = player.statPoints ?? 0;

    py = this._sectionHeader(ctx, px, py, 'LEVEL & XP',
      statPoints > 0 ? `★ ${statPoints} pts avail` : '');
    py += 6;

    const barX = px + PAD;
    const barW = PANEL_W - PAD * 2;
    const BAR_H = 8;

    ctx.font         = 'bold 14px Consolas, monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = GOLD;
    ctx.fillText(`Lv. ${lvl}${isMax ? '  MAX' : ''}`, barX, py + 8);

    const xpLabel = isMax ? 'MAX LEVEL' : `${xp} / ${xpToNext} XP`;
    ctx.font      = '12px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(xpLabel, px + PANEL_W - PAD, py + 8);
    py += 18;

    ctx.fillStyle = '#1a2040';
    ctx.fillRect(barX, py, barW, BAR_H);
    ctx.fillStyle = '#4488ff';
    ctx.fillRect(barX, py, Math.round(barW * xpPct), BAR_H);
    py += BAR_H + 10;

    // ── Stat upgrades inline ────────────────────────────────────────
    const BTN_W = 80, BTN_H = 22;
    const ROW   = 44;

    for (const stat of STATS) {
      const statLvl = (player[stat.key] ?? 0) as number;
      const afford  = statPoints > 0;

      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(px + PAD / 2, py, PANEL_W - PAD, ROW - 3);

      ctx.font         = 'bold 13px Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = stat.color;
      ctx.fillText(stat.label, px + PAD, py + 13);

      ctx.font      = 'bold 12px Consolas, monospace';
      ctx.fillStyle = statLvl > 0 ? stat.color : TEXT_DIM;
      ctx.fillText(`${statLvl}`, px + 90, py + 13);

      ctx.font         = '11px Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = TEXT_DIM;
      ctx.fillText(stat.desc(statLvl), px + PAD, py + ROW - 16);

      const btnX = px + PANEL_W - PAD - BTN_W;
      const btnY = py + (ROW - 3 - BTN_H) / 2;
      ctx.fillStyle   = afford ? '#2a4a2a' : '#2a2a2a';
      ctx.strokeStyle = afford ? '#44aa44' : '#445';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.roundRect(btnX, btnY, BTN_W, BTN_H, 3);
      ctx.fill();
      ctx.stroke();

      ctx.font         = 'bold 11px Consolas, monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = afford ? '#aaffaa' : '#556';
      ctx.fillText(afford ? '+1 Point' : 'No Points', btnX + BTN_W / 2, btnY + BTN_H / 2);

      if (afford) {
        this._btnHits.push({ serverKey: stat.server, x: btnX, y: btnY, w: BTN_W, h: BTN_H, affordable: true });
      }

      py += ROW;
    }

    return py + 6;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 58-slot inventory grid (first 10 = hotbar, highlighted)

  private _inventoryGrid(
    ctx:    CanvasRenderingContext2D,
    px:     number, py: number,
    player: NonNullable<ReturnType<WorldState['players']['find']>>,
  ): number {
    const inv   = player.inventory;
    const COLS  = 10;
    const ISZ   = 36;
    const IGAP  = 4;
    const STRIDE = ISZ + IGAP;
    const ROWS  = Math.ceil(58 / COLS);   // 6

    const activeSlot = inv.activeSlot;
    const slotLabel  = (activeSlot === 255 || activeSlot >= 10)
      ? 'no selection'
      : `slot ${activeSlot + 1} active`;

    py = this._sectionHeader(ctx, px, py, 'INVENTORY  (58 slots)', slotLabel);
    py += 6;

    const totalIW = COLS * STRIDE - IGAP;
    const startIX = px + Math.round((PANEL_W - totalIW) / 2);

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        if (i >= 58) break;

        const slot     = inv.slots[i] ?? { item: 'none' as ItemKind, quantity: 0 };
        const def      = ITEM_DEFS[slot.item] ?? ITEM_DEFS['none'];
        const sx       = startIX + col * STRIDE;
        const sy       = py + row * STRIDE;
        const isActive = i === activeSlot;
        const isHotbar = i < HOTBAR_SLOTS;

        ctx.fillStyle = isActive
          ? 'rgba(255,215,0,0.20)'
          : isHotbar ? 'rgba(30,35,50,0.92)' : 'rgba(22,22,35,0.85)';
        ctx.fillRect(sx, sy, ISZ, ISZ);

        ctx.strokeStyle = isActive ? GOLD : isHotbar ? '#446' : '#334';
        ctx.lineWidth   = isActive ? 2 : 1;
        ctx.strokeRect(sx, sy, ISZ, ISZ);

        if (slot.item !== 'none') {
          const pad = 5;
          ctx.fillStyle = def.color;
          ctx.fillRect(sx + pad, sy + pad, ISZ - pad * 2, ISZ - pad * 2);
          ctx.font         = 'bold 14px Consolas, monospace';
          ctx.fillStyle    = '#fff';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(def.symbol, sx + ISZ / 2, sy + ISZ / 2);

          if (slot.quantity > 1) {
            ctx.font         = '9px Consolas, monospace';
            ctx.textAlign    = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle    = '#fff';
            ctx.fillText(String(slot.quantity), sx + ISZ - 2, sy + ISZ - 1);
          }
        }
      }
    }

    // Hotbar key-number labels below first row
    ctx.font         = '9px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const sx = startIX + i * STRIDE;
      ctx.fillStyle = i === activeSlot ? GOLD : TEXT_DIM;
      ctx.fillText(String(i === 9 ? 0 : i + 1), sx + ISZ / 2, py + ISZ + 2);
    }

    py += ROWS * STRIDE - IGAP + 16;
    return py + 8;
  }

  // ─────────────────────────────────────────────────────────────────────────

  private _status(
    ctx:        CanvasRenderingContext2D,
    px:         number, py: number,
    player:     NonNullable<ReturnType<WorldState['players']['find']>>,
    ship:       ReturnType<WorldState['ships']['find']> | null,
    worldState: WorldState,
  ): number {
    py = this._sectionHeader(ctx, px, py, 'STATUS', '');

    const rows: Array<[string, string, string?]> = [];

    // Aboard / at sea
    rows.push(['Location', ship ? `Aboard Ship #${ship.id}` : 'At sea']);

    // Mount state
    if (player.isMounted && player.mountedModuleId != null) {
      const mod = ship?.modules.find(m => m.id === player.mountedModuleId);
      const modKind = mod ? mod.kind.replace('-', ' ') : `Module #${player.mountedModuleId}`;
      rows.push(['Mounted', `${modKind} (ID ${player.mountedModuleId})`, ORANGE]);
    } else {
      rows.push(['Mounted', 'None', TEXT_DIM]);
    }

    rows.push(['On Deck', player.onDeck ? 'Yes' : 'No']);

    const spd = Math.sqrt(player.velocity.x ** 2 + player.velocity.y ** 2);
    rows.push(['Speed', spd.toFixed(2) + ' u/s']);

    // Facing
    const deg = ((player.rotation * 180 / Math.PI) % 360 + 360) % 360;
    rows.push(['Facing', deg.toFixed(1) + '°']);

    for (let i = 0; i < rows.length; i++) {
      const [label, value, col3Color] = rows[i];
      if (i % 2 === 1) {
        ctx.fillStyle = BG_STRIPE;
        ctx.fillRect(px + PAD, py, PANEL_W - PAD * 2, ROW_H);
      }
      ctx.font = '13px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(label, px + PAD + 8, py + ROW_H / 2);
      ctx.fillStyle = col3Color ?? TEXT_HEAD;
      ctx.fillText(value, px + PAD + 150, py + ROW_H / 2);
      py += ROW_H;
    }

    return py + 8;
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
