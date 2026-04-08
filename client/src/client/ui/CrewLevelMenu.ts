/**
 * CrewLevelMenu.ts
 *
 * Canvas-drawn panel showing a single NPC's stats and upgrade options.
 * Opened by:
 *  • Clicking an NPC sprite in the world (same or allied company)
 *  • Clicking an NPC row in the Ship Menu crew section
 *
 * Stats (upgradeable with stat points earned per global level-up):
 *   Health  — +20 max HP per level
 *   Damage  — +10% weapon damage per level
 *   Stamina — +10% reload / work speed per level
 *   Weight  — +10% carry capacity per level
 *
 * Global level: 1–66 (1 base + 65 upgrades).
 * Each level-up grants 1 stat point.  XP cost: 100 × current-level to advance.
 * No per-stat cap — all points can go into any stat.
 */

import { Npc } from '../../sim/Types.js';
// Max global NPC level
const NPC_MAX_LEVEL = 66;
const PANEL_W  = 360;
const PAD      = 16;
const HEADER_H = 44;
const ROW_H    = 52;
const BAR_H    = 8;

// ── Palette ───────────────────────────────────────────────────────────────────
const BG       = 'rgba(14,18,30,0.98)';
const BORDER   = '#3a4060';
const HDR_LINE = '#2a3050';
const TEXT_H   = '#e8e0cc';
const TEXT_DIM = '#778';
const TEXT_M   = '#b0a880';
const GOLD     = '#ffd700';
const GREEN    = '#44cc66';
const ORANGE   = '#ffaa44';
const RED      = '#ff5544';
const BLUE_XP  = '#4488ff';
const BTN_AFD  = '#2a4a2a';    // btn bg affordable
const BTN_NOT  = '#2a2a2a';    // btn bg unaffordable
const BTN_AFD_BORDER = '#44aa44';
const BTN_NOT_BORDER = '#445';
const BTN_TXT_AFD = '#aaffaa';
const BTN_TXT_NOT = '#556';

// ── NPC stat configuration ────────────────────────────────────────────────────
interface StatDef {
  key:    'statHealth' | 'statDamage' | 'statStamina' | 'statWeight';
  server: string;
  label:  string;
  desc:   (lvl: number) => string;
  color:  string;
}

const STATS: StatDef[] = [
  {
    key: 'statHealth',  server: 'health',  label: 'Health',
    desc: (l) => l > 0 ? `+${l * 20} max HP` : 'No bonus',
    color: GREEN,
  },
  {
    key: 'statDamage',  server: 'damage',  label: 'Damage',
    desc: (l) => l > 0 ? `+${l * 10}% weapon dmg` : 'No bonus',
    color: RED,
  },
  {
    key: 'statStamina', server: 'stamina', label: 'Stamina',
    desc: (l) => l > 0 ? `+${l * 10}% speed` : 'No bonus',
    color: ORANGE,
  },
  {
    key: 'statWeight',  server: 'weight',  label: 'Weight',
    desc: (l) => l > 0 ? `+${l * 10}% carry` : 'No bonus',
    color: '#88ccff',
  },
];

// ── Hit areas for click detection ─────────────────────────────────────────────
interface BtnHit {
  serverKey: string;
  x: number; y: number; w: number; h: number;
  affordable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

export class CrewLevelMenu {
  public visible = false;

  /** Set by UIManager; called when the player clicks an affordable upgrade. */
  public onUpgradeRequest: ((npcId: number, stat: string) => void) | null = null;

  private _npc: Npc | null = null;
  private _panelX = 0;
  private _panelY = 0;
  private _panelH = 0;
  private _btnHits: BtnHit[] = [];

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  open(npc: Npc): void {
    this._npc = npc;
    this.visible = true;
  }

  /** Refresh the NPC data (called each frame with the latest world-state entry). */
  update(npc: Npc): void {
    if (this._npc && this._npc.id === npc.id) this._npc = npc;
  }

  close(): void {
    this.visible = false;
    this._npc = null;
  }

  get npcId(): number { return this._npc?.id ?? 0; }

  // ── Click handling ─────────────────────────────────────────────────────────

  /**
   * Returns true if the click was consumed (inside panel or triggered an upgrade).
   */
  handleClick(x: number, y: number): boolean {
    if (!this.visible || !this._npc) return false;

    // Outside panel → close
    if (x < this._panelX || x > this._panelX + PANEL_W ||
        y < this._panelY || y > this._panelY + this._panelH) {
      return false;
    }

    for (const btn of this._btnHits) {
      if (btn.affordable &&
          x >= btn.x && x <= btn.x + btn.w &&
          y >= btn.y && y <= btn.y + btn.h) {
        this.onUpgradeRequest?.(this._npc.id, btn.serverKey);
        return true;
      }
    }
    return true; // consumed — inside panel but no button hit
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (!this.visible || !this._npc) return;
    this._btnHits = [];

    const npc = this._npc;
    const ROLE_NAMES: Record<number, string> = {
      0: 'Sailor', 1: 'Gunner', 2: 'Helmsman', 3: 'Rigger', 4: 'Repairer',
    };

    const hpPct    = npc.maxHealth > 0 ? npc.health / npc.maxHealth : 1;
    const isMaxLevel = npc.npcLevel >= NPC_MAX_LEVEL;
    const xpToNext = isMaxLevel ? NPC_MAX_LEVEL * 100 : npc.npcLevel * 100;
    const xpPct    = isMaxLevel ? 1 : Math.min(npc.xp / xpToNext, 1);

    // Panel height: header section + stats section + footer
    const HEADER_SECTION_H = HEADER_H + 2 + 20 + BAR_H + 6 + 16 + BAR_H + 6 + PAD; // ~120
    const STATS_SECTION_H  = STATS.length * ROW_H + 8;
    const FOOTER_H         = 36;
    this._panelH = HEADER_SECTION_H + STATS_SECTION_H + FOOTER_H;

    // Centre horizontally, near the top
    this._panelX = Math.round((canvas.width  - PANEL_W) / 2);
    this._panelY = Math.round((canvas.height - this._panelH) / 2);

    const px = this._panelX;
    const py = this._panelY;
    const PW = PANEL_W;

    ctx.save();

    // ── Panel background ────────────────────────────────────────────────────
    ctx.fillStyle   = BG;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, PW, this._panelH, 6);
    ctx.fill();
    ctx.stroke();

    // ── Header ──────────────────────────────────────────────────────────────
    let cy = py + PAD;

    // Name + level badge
    ctx.font      = 'bold 16px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_H;
    ctx.fillText(npc.name, px + PAD, cy);

    const badge = `Lv. ${npc.npcLevel}${npc.npcLevel >= NPC_MAX_LEVEL ? ' MAX' : ''}`;
    ctx.font      = 'bold 13px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = GOLD;
    ctx.fillText(badge, px + PW - PAD, cy + 2);

    cy += 22;

    // Role sub-line
    const roleLine = ROLE_NAMES[npc.role] ?? 'Sailor';
    ctx.font      = '12px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(roleLine, px + PAD, cy);

    cy += 16;

    // Divider
    ctx.strokeStyle = HDR_LINE;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px + PAD, cy); ctx.lineTo(px + PW - PAD, cy);
    ctx.stroke();
    cy += 8;

    // ── HP bar ───────────────────────────────────────────────────────────────
    ctx.font      = '12px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT_M;
    const hpLabel = `HP  ${npc.health} / ${npc.maxHealth}  (${Math.round(hpPct * 100)}%)`;
    ctx.fillText(hpLabel, px + PAD, cy);
    cy += 16;

    this._drawBar(ctx, px + PAD, cy, PW - PAD * 2, BAR_H,
      hpPct, hpPct > 0.6 ? GREEN : hpPct > 0.3 ? ORANGE : RED, '#2a2a2a');
    cy += BAR_H + 8;

    // ── XP bar ───────────────────────────────────────────────────────────────
    ctx.font      = '12px Consolas, monospace';
    ctx.fillStyle = TEXT_M;
    if (isMaxLevel) {
      ctx.fillText(`XP  MAX LEVEL`, px + PAD, cy);
    } else {
      ctx.fillText(`XP  ${npc.xp} / ${xpToNext}  (next level)`, px + PAD, cy);
    }
    cy += 16;

    this._drawBar(ctx, px + PAD, cy, PW - PAD * 2, BAR_H, xpPct, BLUE_XP, '#1a2040');
    cy += BAR_H + 10;

    // ── Stat points available ─────────────────────────────────────────────────
    const statPointsLeft = npc.statPoints ?? 0;
    if (statPointsLeft > 0) {
      ctx.font      = 'bold 12px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = GOLD;
      ctx.fillText(`★ ${statPointsLeft} stat point${statPointsLeft !== 1 ? 's' : ''} available`, px + PW / 2, cy);
      cy += 18;
    }

    // ── Section divider ───────────────────────────────────────────────────────
    ctx.strokeStyle = HDR_LINE;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px + PAD, cy); ctx.lineTo(px + PW - PAD, cy);
    ctx.stroke();
    cy += 8;

    // ── Stat rows ─────────────────────────────────────────────────────────────
    for (const stat of STATS) {
      const statLvl  = npc[stat.key] as number;
      const afford   = statPointsLeft > 0;

      // Row background stripe
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(px + PAD / 2, cy, PW - PAD, ROW_H - 4);

      // Stat label
      ctx.font      = 'bold 13px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = stat.color;
      ctx.fillText(stat.label, px + PAD, cy + 14);

      // Level number indicator
      ctx.font      = 'bold 12px Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = statLvl > 0 ? stat.color : TEXT_DIM;
      ctx.fillText(`${statLvl}`, px + 90, cy + 14);

      // Effect description
      ctx.font         = '11px Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = TEXT_DIM;
      ctx.fillText(stat.desc(statLvl), px + PAD, cy + ROW_H - 18);

      // Upgrade button (right side)
      const btnW = 80;
      const btnH = 26;
      const btnX = px + PW - PAD - btnW;
      const btnY = cy + (ROW_H - 4 - btnH) / 2;

      ctx.fillStyle   = afford ? BTN_AFD    : BTN_NOT;
      ctx.strokeStyle = afford ? BTN_AFD_BORDER : BTN_NOT_BORDER;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.roundRect(btnX, btnY, btnW, btnH, 3);
      ctx.fill();
      ctx.stroke();

      ctx.font         = 'bold 11px Consolas, monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = afford ? BTN_TXT_AFD : BTN_TXT_NOT;
      ctx.fillText(afford ? '+1 Point' : 'No Points', btnX + btnW / 2, btnY + btnH / 2);

      if (afford) {
        this._btnHits.push({ serverKey: stat.server, x: btnX, y: btnY, w: btnW, h: btnH, affordable: true });
      }

      cy += ROW_H;
    }

    // ── Footer (specialty system teaser) ─────────────────────────────────────
    cy += 4;
    ctx.strokeStyle = HDR_LINE;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px + PAD, cy); ctx.lineTo(px + PW - PAD, cy);
    ctx.stroke();
    cy += 8;

    ctx.font         = '11px Consolas, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = TEXT_DIM;
    ctx.fillText('Specialty progression — coming soon', px + PW / 2, cy);

    ctx.restore();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _drawBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    pct: number, fillColor: string, bgColor: string,
  ): void {
    ctx.fillStyle   = bgColor;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle   = fillColor;
    ctx.fillRect(x, y, Math.round(w * Math.min(pct, 1)), h);
    ctx.strokeStyle = '#445';
    ctx.lineWidth   = 0.8;
    ctx.strokeRect(x, y, w, h);
  }
}
