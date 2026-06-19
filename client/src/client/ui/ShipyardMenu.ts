/**
 * ShipyardMenu.ts
 *
 * Canvas-drawn ship construction panel opened when a player presses [E] at a shipyard.
 *
 *  Phase empty    — "Lay Keel (Brigantine)" + resource inventory
 *  Phase building — "Release Ship" + resource inventory
 */

export type ConstructionPhase = 'empty' | 'building';

export interface YardResources {
  wood: number;
  fiber: number;
  metal: number;
  stone: number;
}

// ── Panel layout constants ────────────────────────────────────────────────

const PANEL_W   = 490;
const HDR_H     = 48;
const ROW_H     = 60;
const INV_HDR   = 28;
const INV_ROW_H = 40;
const PAD_TOP   = 12;
const PAD_BOT   = 36;
const CHEST_MAX = 8192;
const XFER_QTY  = 10;

const RESOURCES: Array<{ key: keyof YardResources; label: string; color: string; symbol: string }> = [
  { key: 'wood',  label: 'Wood',  color: '#8b5e2a', symbol: '🪵' },
  { key: 'fiber', label: 'Fiber', color: '#c8a46e', symbol: '🌿' },
  { key: 'metal', label: 'Metal', color: '#8a8a8c', symbol: '⚙' },
  { key: 'stone', label: 'Stone', color: '#9a9a9c', symbol: '🪨' },
];

function panelH(_phase: ConstructionPhase): number {
  return HDR_H + PAD_TOP + ROW_H + 8 + INV_HDR + RESOURCES.length * INV_ROW_H + PAD_BOT;
}

// ── Colours ───────────────────────────────────────────────────────────────
const BG_PANEL  = 'rgba(8, 16, 12, 0.97)';
const BORDER    = '#2a6040';
const TEXT_HEAD = '#88e8a0';
const TEXT_DIM  = '#507868';
const INV_BG    = 'rgba(12, 28, 20, 0.85)';

// ── Class ─────────────────────────────────────────────────────────────────

export class ShipyardMenu {
  public visible    = false;
  public structureId: number | null = null;
  public phase: ConstructionPhase = 'empty';
  /** Kept for protocol compatibility — no longer used for rendering. */
  public modulesPlaced: string[] = [];

  /** Fired when the player confirms an action. */
  public onAction: ((action: string, module?: string) => void) | null = null;
  /** Deposit / withdraw resources into the shipyard pool. */
  public onTransfer: ((structureId: number, item: string, quantity: number, direction: 'deposit' | 'withdraw') => void) | null = null;

  private _yard: YardResources = { wood: 0, fiber: 0, metal: 0, stone: 0 };
  private _player: YardResources = { wood: 0, fiber: 0, metal: 0, stone: 0 };
  private _arrowHits: Array<{ dep: { x: number; y: number; w: number; h: number }; wit: { x: number; y: number; w: number; h: number } }> = [];

  // ── Public API ─────────────────────────────────────────────────────────

  open(structureId: number, phase: ConstructionPhase, modulesPlaced: string[], yard?: YardResources, player?: YardResources): void {
    this.structureId   = structureId;
    this.phase         = phase;
    this.modulesPlaced = [...modulesPlaced];
    if (yard)   this._yard   = { ...yard };
    if (player) this._player = { ...player };
    this.visible       = true;
  }

  close(): void {
    this.visible = false;
  }

  updateState(phase: ConstructionPhase, modulesPlaced: string[]): void {
    this.phase         = phase;
    this.modulesPlaced = [...modulesPlaced];
  }

  updateResources(yard: YardResources, player?: YardResources): void {
    this._yard = { ...yard };
    if (player) this._player = { ...player };
  }

  updatePlayerResources(player: YardResources): void {
    this._player = { ...player };
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  render(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number): void {
    if (!this.visible) return;
    const ph = panelH(this.phase);
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - ph)       / 2);

    ctx.save();

    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    ctx.fillStyle   = BG_PANEL;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, ph, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(16, 64, 36, 0.65)';
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, HDR_H, [6, 6, 0, 0]);
    ctx.fill();

    ctx.font         = 'bold 18px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('⚓  Shipyard — Ship Construction', px + PANEL_W / 2, py + HDR_H / 2);

    const btnR = 12, btnX = px + PANEL_W - 16, btnY = py + HDR_H / 2;
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(180, 40, 20, 0.8)';
    ctx.fill();
    ctx.strokeStyle = '#ff7755';
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.font      = 'bold 14px Georgia, serif';
    ctx.fillStyle = '#fff';
    ctx.fillText('✕', btnX, btnY);

    const bodyY = py + HDR_H + PAD_TOP;

    if (this.phase === 'empty') {
      this._drawKeelRow(ctx, px, bodyY);
    } else {
      this._drawReleaseRow(ctx, px, bodyY);
    }

    this._drawInventory(ctx, px, bodyY + ROW_H + 8);

    ctx.font         = '11px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle    = TEXT_DIM;
    ctx.fillText('[E] or click ✕ to close', px + PANEL_W / 2, py + ph - 10);

    ctx.restore();
  }

  private _drawKeelRow(ctx: CanvasRenderingContext2D, px: number, ry: number): void {
    ctx.fillStyle   = 'rgba(16, 52, 32, 0.75)';
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(px + 8, ry, PANEL_W - 16, ROW_H, 4);
    ctx.fill();
    ctx.stroke();

    const ic = 44, icy = ry + (ROW_H - ic) / 2, icx = px + 14;
    ctx.fillStyle = '#2a5f8a';
    ctx.beginPath();
    ctx.roundRect(icx, icy, ic, ic, 4);
    ctx.fill();
    ctx.font      = 'bold 20px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#80d4ff';
    ctx.fillText('⚓', icx + ic / 2, icy + ic / 2);

    const tx = icx + ic + 10;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('Lay Keel  (Brigantine)', tx, ry + 9);
    ctx.font      = '12px Georgia, serif';
    ctx.fillStyle = '#e8d070';
    ctx.fillText('20× Wood  +  10× Fiber', tx, ry + 31);

    const bw = 76, bh = 28, bx = px + PANEL_W - 16 - bw, by = ry + (ROW_H - bh) / 2;
    ctx.fillStyle = 'rgba(24, 130, 66, 0.9)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.strokeStyle = '#40e080';
    ctx.stroke();
    ctx.font      = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ccffdd';
    ctx.fillText('Build', bx + bw / 2, by + bh / 2);
  }

  private _drawReleaseRow(ctx: CanvasRenderingContext2D, px: number, ry: number): void {
    ctx.fillStyle = 'rgba(16, 52, 32, 0.75)';
    ctx.beginPath();
    ctx.roundRect(px + 8, ry, PANEL_W - 16, ROW_H, 4);
    ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.stroke();

    const ic = 44, icy = ry + (ROW_H - ic) / 2, icx = px + 14;
    ctx.fillStyle = '#3a6030';
    ctx.beginPath();
    ctx.roundRect(icx, icy, ic, ic, 4);
    ctx.fill();
    ctx.font      = 'bold 20px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#80ffaa';
    ctx.fillText('⚓', icx + ic / 2, icy + ic / 2);

    const tx = icx + ic + 10;
    ctx.textAlign = 'left';
    ctx.font      = 'bold 14px Georgia, serif';
    ctx.fillStyle = TEXT_HEAD;
    ctx.fillText('Ship Under Construction', tx, ry + 9);
    ctx.font      = '12px Georgia, serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('Use build mode [B] to add planks & modules', tx, ry + 31);

    const bw = 100, bh = 28, bx = px + PANEL_W - 16 - bw, by = ry + (ROW_H - bh) / 2;
    ctx.fillStyle = 'rgba(24, 100, 130, 0.9)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.strokeStyle = '#40c8e0';
    ctx.stroke();
    ctx.font      = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ccf4ff';
    ctx.fillText('Release', bx + bw / 2, by + bh / 2);
  }

  private _drawInventory(ctx: CanvasRenderingContext2D, px: number, invY: number): void {
    const invH = INV_HDR + RESOURCES.length * INV_ROW_H;
    ctx.fillStyle = INV_BG;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(px + 8, invY, PANEL_W - 16, invH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font         = 'bold 12px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('Shipyard Resources  (used for ship builds)', px + PANEL_W / 2, invY + INV_HDR / 2);

    this._arrowHits = [];
    const rowStart = invY + INV_HDR;
    const leftX = px + 20;
    const midX  = px + PANEL_W / 2 - 36;
    const rightX = px + PANEL_W - 20;

    RESOURCES.forEach((res, i) => {
      const ry = rowStart + i * INV_ROW_H;
      const cy = ry + INV_ROW_H / 2;
      const yardAmt = this._yard[res.key];
      const plyAmt  = this._player[res.key];

      ctx.font      = '13px Georgia, serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#c8b890';
      ctx.fillText(`${plyAmt}`, leftX + 52, cy);

      const dep = { x: midX, y: cy - 12, w: 28, h: 24 };
      const wit = { x: midX + 44, y: cy - 12, w: 28, h: 24 };
      this._arrowHits.push({ dep, wit });

      ctx.fillStyle = 'rgba(24, 80, 50, 0.9)';
      ctx.strokeStyle = '#40a060';
      ctx.beginPath();
      ctx.roundRect(dep.x, dep.y, dep.w, dep.h, 3);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(wit.x, wit.y, wit.w, wit.h, 3);
      ctx.fill();
      ctx.stroke();
      ctx.font      = 'bold 14px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#a0ffc0';
      ctx.fillText('→', dep.x + dep.w / 2, cy);
      ctx.fillText('←', wit.x + wit.w / 2, cy);

      ctx.font      = '13px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = res.color;
      ctx.fillText(`${res.symbol} ${res.label}`, midX - 108, cy - 6);
      ctx.fillStyle = '#d0e8d0';
      ctx.font      = '12px monospace';
      ctx.fillText(`${yardAmt} / ${CHEST_MAX}`, rightX - 90, cy + 4);
    });
  }

  // ── Input handling ──────────────────────────────────────────────────────

  handleClick(x: number, y: number, canvasWidth: number, canvasHeight: number): boolean {
    if (!this.visible) return false;
    const ph = panelH(this.phase);
    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - ph)       / 2);

    const btnX = px + PANEL_W - 16, btnY = py + HDR_H / 2;
    if ((x - btnX) ** 2 + (y - btnY) ** 2 <= 12 ** 2) {
      this.close();
      return true;
    }

    if (x < px || x > px + PANEL_W || y < py || y > py + ph) {
      this.close();
      return true;
    }

    const bodyY = py + HDR_H + PAD_TOP;

    if (this.phase === 'empty') {
      const bw = 76, bh = 28, bx = px + PANEL_W - 16 - bw, by = bodyY + (ROW_H - bh) / 2;
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
        this.onAction?.('craft_skeleton');
        return true;
      }
    } else {
      const bw = 100, bh = 28, bx = px + PANEL_W - 16 - bw, by = bodyY + (ROW_H - bh) / 2;
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
        this.onAction?.('release_ship');
        this.close();
        return true;
      }
    }

    if (this.structureId != null && this.onTransfer) {
      for (let i = 0; i < this._arrowHits.length; i++) {
        const h = this._arrowHits[i];
        const key = RESOURCES[i].key;
        if (x >= h.dep.x && x <= h.dep.x + h.dep.w && y >= h.dep.y && y <= h.dep.y + h.dep.h) {
          this.onTransfer(this.structureId, key, XFER_QTY, 'deposit');
          return true;
        }
        if (x >= h.wit.x && x <= h.wit.x + h.wit.w && y >= h.wit.y && y <= h.wit.y + h.wit.h) {
          this.onTransfer(this.structureId, key, XFER_QTY, 'withdraw');
          return true;
        }
      }
    }

    return true;
  }
}
