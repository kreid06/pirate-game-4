/**
 * ChestMenu.ts
 *
 * Canvas-drawn resource chest inventory panel. Opened when a player presses [E]
 * near a placed resource chest module on a ship or on land.
 *
 * Shows the five storable resource types (wood, fiber, metal, stone, cannon_ball)
 * with their current quantities.  Players can deposit or withdraw resources one
 * slot at a time using +/– buttons or hold-to-repeat.
 */

import { type PlayerInventory, type ItemKind, ITEM_DEFS } from '../../sim/Inventory.js';
import { type ChestModuleData } from '../../sim/modules.js';

// ── Layout constants ─────────────────────────────────────────────────────────
const PANEL_W  = 340;
const HDR_H    = 40;
const ROW_H    = 46;
const PAD      = 14;
const BTN_W    = 28;
const BTN_H    = 24;

const RESOURCES: Array<{ key: keyof ChestModuleData & string; label: string; color: string; border: string; symbol: string }> = [
  { key: 'wood',        label: 'Wood',        color: '#8b5e2a', border: '#5c3a10', symbol: 'W'  },
  { key: 'fiber',       label: 'Fiber',       color: '#c8a46e', border: '#8a6030', symbol: 'Fi' },
  { key: 'metal',       label: 'Metal',       color: '#8a8a8c', border: '#555558', symbol: 'Fe' },
  { key: 'stone',       label: 'Stone',       color: '#9a9a9c', border: '#666668', symbol: 'St' },
  { key: 'cannon_ball', label: 'Cannonball',  color: '#555555', border: '#333333', symbol: '●'  },
];

const PANEL_H = HDR_H + RESOURCES.length * ROW_H + PAD;

// ── Colour palette ────────────────────────────────────────────────────────────
const BG_PANEL = '#1c1208';
const GOLD     = '#c8a050';
const TEXT_HEAD = '#f0e0c0';
const TEXT_DIM  = '#8a7860';
const TEXT_MONO = '#d0b878';

export interface ChestTransferEvent {
  moduleId: number;
  shipId: number;
  item: string;
  quantity: number;
  direction: 'deposit' | 'withdraw';
}

export class ChestMenu {
  visible = false;

  /** Populated when the menu is opened — identifies which chest is open. */
  private _moduleId = 0;
  private _shipId   = 0;

  /** Live chest data received from the server (updated each frame from worldState). */
  private _chestData: ChestModuleData | null = null;

  /** Called by ClientApplication when the player clicks deposit/withdraw. */
  onTransfer: ((evt: ChestTransferEvent) => void) | null = null;

  // ── Hit areas (refreshed every render call) ──────────────────────────────
  private _depositBtns:  Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
  private _withdrawBtns: Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
  private _closeBtn: { x: number; y: number; r: number } | null = null;

  // ── Panel position ───────────────────────────────────────────────────────
  private _panelX = 0;
  private _panelY = 0;

  // ─────────────────────────────────────────────────────────────────────────

  open(moduleId: number, shipId: number, chestData: ChestModuleData | null): void {
    this._moduleId  = moduleId;
    this._shipId    = shipId;
    this._chestData = chestData;
    this.visible    = true;
  }

  close(): void {
    this.visible = false;
  }

  /** Update live chest data each frame (called from renderFrame before render). */
  updateChestData(data: ChestModuleData | null): void {
    this._chestData = data;
  }

  // ── Input handling ────────────────────────────────────────────────────────

  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;

    if (this._closeBtn) {
      const { x: bx, y: by, r } = this._closeBtn;
      if ((x - bx) ** 2 + (y - by) ** 2 <= r * r) {
        this.close();
        return true;
      }
    }

    for (const btn of this._depositBtns) {
      if (x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
        this.onTransfer?.({ moduleId: this._moduleId, shipId: this._shipId, item: btn.key, quantity: 1, direction: 'deposit' });
        return true;
      }
    }
    for (const btn of this._withdrawBtns) {
      if (x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
        this.onTransfer?.({ moduleId: this._moduleId, shipId: this._shipId, item: btn.key, quantity: 1, direction: 'withdraw' });
        return true;
      }
    }

    // Consume clicks that land inside the panel
    return x >= this._panelX && x <= this._panelX + PANEL_W
        && y >= this._panelY && y <= this._panelY + PANEL_H;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render(
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    canvasHeight: number,
    playerInventory: PlayerInventory | null,
  ): void {
    if (!this.visible) return;

    this._depositBtns  = [];
    this._withdrawBtns = [];

    const px = Math.round((canvasWidth  - PANEL_W) / 2);
    const py = Math.round((canvasHeight - PANEL_H) / 2);
    this._panelX = px;
    this._panelY = py;

    ctx.save();

    // ── Dim backdrop ─────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // ── Panel background ─────────────────────────────────────────────────────
    ctx.fillStyle   = BG_PANEL;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, PANEL_H, 6);
    ctx.fill();
    ctx.stroke();

    // ── Header ───────────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(80, 50, 10, 0.70)';
    ctx.beginPath();
    ctx.roundRect(px, py, PANEL_W, HDR_H, [6, 6, 0, 0]);
    ctx.fill();

    // Chest icon
    this._drawChestIcon(ctx, px + 18, py + HDR_H / 2, 14);

    ctx.font         = 'bold 15px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText('Resource Chest', px + 38, py + HDR_H / 2);

    // Column labels
    ctx.font         = '10px Georgia, serif';
    ctx.fillStyle    = TEXT_DIM;
    ctx.textAlign    = 'right';
    const depX = px + PANEL_W - PAD - BTN_W * 2 - 6;
    const witX = px + PANEL_W - PAD;
    ctx.fillText('stored', depX - 4, py + HDR_H - 7);
    ctx.fillText('inv', witX,        py + HDR_H - 7);

    // ── Close button ─────────────────────────────────────────────────────────
    const btnR = 11;
    const btnX = px + PANEL_W - 16;
    const btnY = py + HDR_H / 2;
    this._closeBtn = { x: btnX, y: btnY, r: btnR };
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(160,36,18,0.82)';
    ctx.fill();
    ctx.strokeStyle = '#ff7755';
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.font         = 'bold 13px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#fff';
    ctx.fillText('✕', btnX, btnY);

    // ── Resource rows ─────────────────────────────────────────────────────────
    let ry = py + HDR_H;
    for (const res of RESOURCES) {
      this._drawResourceRow(ctx, px, ry, res, playerInventory);
      ry += ROW_H;
    }

    ctx.restore();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _drawResourceRow(
    ctx: CanvasRenderingContext2D,
    px: number, ry: number,
    res: typeof RESOURCES[number],
    playerInventory: PlayerInventory | null,
  ): void {
    const chestQty = this._chestData ? (this._chestData as any)[res.key] as number ?? 0 : 0;
    const invQty   = this._playerItemCount(playerInventory, res.key as ItemKind);

    // Row stripe
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(px + 1, ry, PANEL_W - 2, ROW_H);
    // Separator line
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px + PAD, ry);
    ctx.lineTo(px + PANEL_W - PAD, ry);
    ctx.stroke();

    const cy = ry + ROW_H / 2;

    // Colour swatch
    ctx.fillStyle   = res.color;
    ctx.strokeStyle = res.border;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(px + PAD, cy - 11, 22, 22, 3);
    ctx.fill();
    ctx.stroke();

    ctx.font         = 'bold 11px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#f0e0c0';
    ctx.fillText(res.symbol, px + PAD + 11, cy);

    // Resource label
    ctx.font         = '13px Georgia, serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = TEXT_HEAD;
    ctx.fillText(res.label, px + PAD + 28, cy);

    // ── Quantities ─────────────────────────────────────────────────────────
    const qFont = 'bold 13px Georgia, serif';
    const qRight = px + PANEL_W - PAD - BTN_W * 2 - 10;

    // Stored (chest) quantity
    ctx.font         = qFont;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = chestQty > 0 ? TEXT_MONO : TEXT_DIM;
    ctx.fillText(chestQty.toString(), qRight, cy);

    // ── Withdraw button (– : chest → inventory) ───────────────────────────
    const witX = px + PANEL_W - PAD - BTN_W;
    const witY = cy - BTN_H / 2;
    const canWithdraw = chestQty > 0;
    ctx.fillStyle   = canWithdraw ? 'rgba(100,180,80,0.25)'  : 'rgba(60,60,60,0.20)';
    ctx.strokeStyle = canWithdraw ? '#70c050'                  : '#444';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(witX, witY, BTN_W, BTN_H, 3);
    ctx.fill();
    ctx.stroke();
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = canWithdraw ? '#90e878' : '#555';
    ctx.fillText('−', witX + BTN_W / 2, cy);
    if (canWithdraw) {
      this._withdrawBtns.push({ key: res.key, x: witX, y: witY, w: BTN_W, h: BTN_H });
    }

    // ── Inventory quantity ─────────────────────────────────────────────────
    const invX = px + PANEL_W - PAD - BTN_W + BTN_W + 4;
    ctx.font         = qFont;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = invQty > 0 ? TEXT_MONO : TEXT_DIM;
    ctx.fillText(invQty.toString(), invX + BTN_W - 4, cy);

    // ── Deposit button (+ : inventory → chest) ────────────────────────────
    const depX  = px + PANEL_W - PAD - BTN_W - BTN_W - 4;
    const depY  = cy - BTN_H / 2;
    const canDep = invQty > 0;
    ctx.fillStyle   = canDep ? 'rgba(80,130,200,0.25)' : 'rgba(60,60,60,0.20)';
    ctx.strokeStyle = canDep ? '#5080d0'                : '#444';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(depX, depY, BTN_W, BTN_H, 3);
    ctx.fill();
    ctx.stroke();
    ctx.font         = 'bold 14px Georgia, serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = canDep ? '#88aaf0' : '#555';
    ctx.fillText('+', depX + BTN_W / 2, cy);
    if (canDep) {
      this._depositBtns.push({ key: res.key, x: depX, y: depY, w: BTN_W, h: BTN_H });
    }
  }

  /** Count how many of a given item the player has across all inventory slots. */
  private _playerItemCount(inv: PlayerInventory | null, kind: ItemKind): number {
    if (!inv) return 0;
    let n = 0;
    for (const slot of inv.slots) {
      if (slot.item === kind) n += slot.quantity;
    }
    return n;
  }

  /** Draw a mini wooden chest icon at (cx, cy) with half-size r. */
  private _drawChestIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    const w = r * 2, h = r * 1.5;
    const x = cx - r, y = cy - h / 2;
    // Body
    ctx.fillStyle   = '#7a4820';
    ctx.strokeStyle = '#4a2810';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y + h * 0.45, w, h * 0.55, 2);
    ctx.fill();
    ctx.stroke();
    // Lid
    ctx.fillStyle = '#8b5a2a';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h * 0.50, [3, 3, 0, 0]);
    ctx.fill();
    ctx.stroke();
    // Latch
    ctx.fillStyle   = '#c8a050';
    ctx.strokeStyle = '#806020';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(cx - 3, cy - 2, 6, 5, 1);
    ctx.fill();
    ctx.stroke();
  }
}
