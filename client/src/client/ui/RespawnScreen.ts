/**
 * RespawnScreen — full-screen scrollable/zoomable map overlay shown when the player dies.
 * Styled identically to WorldMapScreen, with selectable spawn points and a RESPAWN button.
 */

import { Ship, IslandDef } from '../../sim/Types.js';

const WORLD_MIN_X = 0;
const WORLD_MIN_Y = 0;
const WORLD_MAX_X = 90_000;
const WORLD_MAX_Y = 90_000;
const WORLD_W = WORLD_MAX_X - WORLD_MIN_X;
const WORLD_H = WORLD_MAX_Y - WORLD_MIN_Y;
const MAJOR_GRID_STEP = 30_000;

interface SpawnOption {
  type: 'ship' | 'island';
  shipId?: number;
  islandId?: number;
  x: number;
  y: number;
  label: string;
}

export class RespawnScreen {
  public visible: boolean = false;

  /** Called when the player confirms a respawn location. */
  public onRespawnConfirmed: ((shipId?: number, worldX?: number, worldY?: number, islandId?: number) => void) | null = null;

  private selectedOption: SpawnOption | null = null;
  private spawnOptions: SpawnOption[] = [];

  // Pan/zoom (same convention as WorldMapScreen — world px per screen px)
  private panX = WORLD_MIN_X + WORLD_W / 2;
  private panY = WORLD_MIN_Y + WORLD_H / 2;
  private zoom = 0; // 0 = sentinel for "auto-fit on first render"

  // Drag state
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragPanStartX = 0;
  private dragPanStartY = 0;

  // Cached canvas size for hit-testing
  private _cw = 0;
  private _ch = 0;

  // Cached button bounds for click-testing
  private _btnBounds: { x: number; y: number; w: number; h: number } | null = null;

  // Pulse animation time
  private _pulseT = 0;

  open(ships: Ship[], islands: IslandDef[], localCompanyId: number): void {
    this.visible = true;
    this.selectedOption = null;
    this.spawnOptions = [];

    // Friendly ships as spawn options
    for (const ship of ships) {
      if (localCompanyId !== 0 && ship.companyId === localCompanyId) {
        this.spawnOptions.push({
          type: 'ship',
          shipId: ship.id,
          x: ship.position.x,
          y: ship.position.y,
          label: `Ship ${ship.id}`,
        });
      }
    }

    // Islands as fallback spawn options
    for (const isl of islands) {
      this.spawnOptions.push({
        type: 'island',
        islandId: isl.id,
        x: isl.x,
        y: isl.y,
        label: `Isle ${isl.id ?? '?'}`,
      });
    }

    this.selectedOption = this.spawnOptions[0] ?? null;

    // Reset zoom to auto-fit on open
    this.zoom = 0;
    this._btnBounds = null;
  }

  close(): void {
    this.visible = false;
    this.dragging = false;
    this._btnBounds = null;
  }

  // ── Input handlers (same API as WorldMapScreen) ─────────────────────────────

  handleMouseDown(x: number, y: number): boolean {
    if (!this.visible) return false;

    // Respawn button
    if (this._btnBounds) {
      const b = this._btnBounds;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        if (this.selectedOption) {
          if (this.selectedOption.type === 'ship') {
            this.onRespawnConfirmed?.(this.selectedOption.shipId, undefined, undefined, undefined);
          } else {
            this.onRespawnConfirmed?.(undefined, undefined, undefined, this.selectedOption.islandId);
          }
          this.visible = false;
        }
        return true;
      }
    }

    // Try to select a spawn option near click, else start drag
    const clicked = this._trySelectNearClick(x, y);
    if (!clicked) {
      this.dragging = true;
      this.dragStartX = x;
      this.dragStartY = y;
      this.dragPanStartX = this.panX;
      this.dragPanStartY = this.panY;
    }
    return true;
  }

  /** Alias for backwards-compat with UIManager.handleClick */
  handleClick(x: number, y: number): boolean {
    return this.handleMouseDown(x, y);
  }

  handleMouseMove(x: number, y: number): void {
    if (!this.visible || !this.dragging) return;
    const dx = x - this.dragStartX;
    const dy = y - this.dragStartY;
    this.panX = this.dragPanStartX - dx * this.zoom;
    this.panY = this.dragPanStartY - dy * this.zoom;
    this._clampPan();
  }

  handleMouseUp(): void {
    this.dragging = false;
  }

  handleWheel(deltaY: number, x: number, y: number): boolean {
    if (!this.visible) return false;
    const factor = deltaY > 0 ? 1.15 : 1 / 1.15;
    const zoomOutMax = this._fitZoom();
    const zoomInMax = 0.15;
    const worldX = this.panX + (x - this._cw / 2) * this.zoom;
    const worldY = this.panY + (y - this._ch / 2) * this.zoom;
    this.zoom = Math.min(zoomOutMax, Math.max(zoomInMax, this.zoom * factor));
    this.panX = worldX - (x - this._cw / 2) * this.zoom;
    this.panY = worldY - (y - this._ch / 2) * this.zoom;
    this._clampPan();
    return true;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  render(ctx: CanvasRenderingContext2D, ships: Ship[], islands: IslandDef[], localCompanyId: number): void {
    if (!this.visible) return;

    // Keep ship spawn option positions fresh
    for (const opt of this.spawnOptions) {
      if (opt.type === 'ship' && opt.shipId !== undefined) {
        const ship = ships.find(s => s.id === opt.shipId);
        if (ship) { opt.x = ship.position.x; opt.y = ship.position.y; }
      }
    }

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    this._cw = cw;
    this._ch = ch;
    this._pulseT = Date.now() / 1000;

    if (this.zoom === 0) {
      this.zoom = this._fitZoom();
      // Pan to selected option if one exists
      if (this.selectedOption) {
        this.panX = this.selectedOption.x;
        this.panY = this.selectedOption.y;
      }
    }

    // ── Dark overlay ──────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(2, 10, 20, 0.92)';
    ctx.fillRect(0, 0, cw, ch);

    // World-space → screen helpers
    const toScreenX = (wx: number) => (wx - this.panX) / this.zoom + cw / 2;
    const toScreenY = (wy: number) => (wy - this.panY) / this.zoom + ch / 2;
    const toScreenLen = (wl: number) => wl / this.zoom;

    // ── Ocean boundary ────────────────────────────────────────────────────────
    const bx = toScreenX(WORLD_MIN_X);
    const by = toScreenY(WORLD_MIN_Y);
    const bw = toScreenLen(WORLD_W);
    const bh = toScreenLen(WORLD_H);
    ctx.fillStyle = '#071830';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#1a4466';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);

    // ── Major grid lines every 30,000 units (3 x 3 active world grid) ──────
    // Draw this after map fill so grid sits above the map layer.
    {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 1.25;
      for (let g = WORLD_MIN_X; g < WORLD_MAX_X; g += MAJOR_GRID_STEP) {
        const sx = toScreenX(g);
        const sy = toScreenY(g);
        if (sx >= 0 && sx <= cw) { ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ch); ctx.stroke(); }
        if (sy >= 0 && sy <= ch) { ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cw, sy); ctx.stroke(); }
      }
      ctx.restore();
    }

    // ── Islands ───────────────────────────────────────────────────────────────
    for (const isl of islands) {
      ctx.save();
      ctx.beginPath();
      if (isl.vertices && isl.vertices.length > 2) {
        ctx.moveTo(toScreenX(isl.vertices[0].x), toScreenY(isl.vertices[0].y));
        for (let i = 1; i < isl.vertices.length; i++) {
          ctx.lineTo(toScreenX(isl.vertices[i].x), toScreenY(isl.vertices[i].y));
        }
        ctx.closePath();
      } else {
        const baseR = (isl as any).beach_radius ?? 185;
        const sr = Math.max(2, toScreenLen(baseR));
        ctx.arc(toScreenX(isl.x), toScreenY(isl.y), sr, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#1a4a10';
      ctx.strokeStyle = '#2a7a18';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      const lx = toScreenX(isl.x);
      const ly = toScreenY(isl.y);
      if (lx > -50 && lx < cw + 50 && ly > -50 && ly < ch + 50) {
        ctx.textAlign = 'center';
        ctx.font = `${Math.max(9, Math.min(14, toScreenLen(80)))}px Consolas, monospace`;
        ctx.fillStyle = '#55aa44';
        ctx.fillText(`Isle ${isl.id ?? '?'}`, lx, ly - toScreenLen(30) - 4);
      }
    }

    // ── All ships (context) ───────────────────────────────────────────────────
    for (const ship of ships) {
      const sx = toScreenX(ship.position.x);
      const sy = toScreenY(ship.position.y);
      if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;
      const isFriendly = localCompanyId !== 0 && ship.companyId === localCompanyId;
      const r = Math.max(4, toScreenLen(40));
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((ship.rotation ?? 0) + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.4);
      ctx.lineTo(r * 0.7, r);
      ctx.lineTo(-r * 0.7, r);
      ctx.closePath();
      ctx.fillStyle = isFriendly ? '#4488ff' : '#ff4444';
      ctx.strokeStyle = isFriendly ? '#aaccff' : '#ffaaaa';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // ── Spawn options (selectable) ────────────────────────────────────────────
    const pulse = 0.5 + 0.5 * Math.sin(this._pulseT * 3.5);
    for (const opt of this.spawnOptions) {
      const mx = toScreenX(opt.x);
      const my = toScreenY(opt.y);
      const selected = opt === this.selectedOption;

      ctx.save();
      if (opt.type === 'ship') {
        if (selected) {
          // Pulsing glow ring
          ctx.beginPath();
          ctx.arc(mx, my, 14 + pulse * 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 238, 68, ${0.15 + pulse * 0.1})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(mx, my, selected ? 8 : 5, 0, Math.PI * 2);
        ctx.fillStyle = selected ? '#ffee44' : '#aaaaff';
        ctx.strokeStyle = selected ? '#ffffff' : '#6666cc';
        ctx.lineWidth = selected ? 2 : 1.5;
        ctx.fill();
        ctx.stroke();
      } else {
        if (selected) {
          ctx.beginPath();
          ctx.arc(mx, my, 14 + pulse * 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(68, 255, 160, ${0.15 + pulse * 0.1})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(mx, my, selected ? 7 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = selected ? '#44ffaa' : '#44aa66';
        ctx.strokeStyle = selected ? '#ffffff' : '#226644';
        ctx.lineWidth = selected ? 2 : 1;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.font = `${selected ? 'bold ' : ''}${Math.max(9, Math.min(13, toScreenLen(70)))}px Consolas, monospace`;
      ctx.fillStyle = selected ? '#ffffff' : '#999999';
      ctx.fillText(opt.label, mx, my - (selected ? 13 : 9));
    }

    // ── Scale bar ─────────────────────────────────────────────────────────────
    this._renderScaleBar(ctx, cw, ch);

    // ── HUD header ────────────────────────────────────────────────────────────
    // Red "YOU DIED" banner at top
    const bannerH = 64;
    ctx.fillStyle = 'rgba(80, 0, 0, 0.72)';
    ctx.fillRect(0, 0, cw, bannerH);

    ctx.textAlign = 'left';
    ctx.font = 'bold 32px serif';
    ctx.fillStyle = '#dd2233';
    ctx.fillText('YOU DIED', 16, 42);

    ctx.font = '13px Consolas, monospace';
    ctx.fillStyle = '#778899';
    ctx.fillText('Click a spawn point  •  Drag to pan  •  Scroll to zoom', 16, bannerH - 8);

    // Selected spawn info (top right)
    if (this.selectedOption) {
      ctx.textAlign = 'right';
      ctx.font = '13px Consolas, monospace';
      ctx.fillStyle = '#aabbcc';
      ctx.fillText(`Selected: ${this.selectedOption.label}`, cw - 16, 30);
    }

    ctx.textAlign = 'right';
    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = '#445566';
    ctx.fillText(`zoom ×${(1 / this.zoom * 100).toFixed(0)}%`, cw - 16, bannerH - 8);

    // ── RESPAWN button ────────────────────────────────────────────────────────
    const btnW = 200, btnH = 48;
    const btnX = cw - btnW - 16;
    const btnY = ch - btnH - 16;
    const enabled = this.selectedOption !== null;

    ctx.save();
    // Pulsing glow on button when enabled
    if (enabled) {
      ctx.shadowColor = '#dd5533';
      ctx.shadowBlur = 10 + pulse * 8;
    }
    ctx.fillStyle = enabled ? '#881a0e' : '#2a1a14';
    ctx.strokeStyle = enabled ? '#dd5533' : '#4a2a22';
    ctx.lineWidth = 2;
    if (ctx.roundRect) ctx.roundRect(btnX, btnY, btnW, btnH, 8);
    else ctx.rect(btnX, btnY, btnW, btnH);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = enabled ? '#ffffff' : '#444444';
    ctx.fillText('RESPAWN', btnX + btnW / 2, btnY + 31);

    this._btnBounds = { x: btnX, y: btnY, w: btnW, h: btnH };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Try to select a spawn option within ~20px of the click. Returns true if one was found. */
  private _trySelectNearClick(x: number, y: number): boolean {
    if (this.zoom === 0) return false;
    const wx = this.panX + (x - this._cw / 2) * this.zoom;
    const wy = this.panY + (y - this._ch / 2) * this.zoom;
    // Threshold: 20 screen px converted to world units
    const threshold = 20 * this.zoom;
    let best: SpawnOption | null = null;
    let bestDist = threshold;
    for (const opt of this.spawnOptions) {
      const d = Math.hypot(opt.x - wx, opt.y - wy);
      if (d < bestDist) { bestDist = d; best = opt; }
    }
    if (best) {
      this.selectedOption = best;
      return true;
    }
    return false;
  }

  private _fitZoom(): number {
    if (this._cw === 0 || this._ch === 0) return 800;
    return Math.max(WORLD_W / (this._cw * 0.92), WORLD_H / (this._ch * 0.92));
  }

  private _clampPan(): void {
    const hw = (this._cw / 2) * this.zoom;
    const hh = (this._ch / 2) * this.zoom;
    if (hw * 2 >= WORLD_W) this.panX = WORLD_MIN_X + WORLD_W / 2;
    else this.panX = Math.max(WORLD_MIN_X + hw, Math.min(WORLD_MAX_X - hw, this.panX));
    if (hh * 2 >= WORLD_H) this.panY = WORLD_MIN_Y + WORLD_H / 2;
    else this.panY = Math.max(WORLD_MIN_Y + hh, Math.min(WORLD_MAX_Y - hh, this.panY));
  }

  private _renderScaleBar(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const targetScreenPx = 120;
    const rawWorld = targetScreenPx * this.zoom;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawWorld)));
    const nice = [1, 2, 5, 10].map(m => m * magnitude).find(v => v >= rawWorld) ?? magnitude * 10;
    const barPx = nice / this.zoom;
    const x = 16, y = ch - 24;
    ctx.save();
    ctx.strokeStyle = '#aabbcc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + barPx, y);
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
    ctx.moveTo(x + barPx, y - 5); ctx.lineTo(x + barPx, y + 5);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = '#aabbcc';
    ctx.fillText(`${nice.toFixed(0)} px`, x + barPx / 2, y - 8);
    ctx.restore();
  }
}
