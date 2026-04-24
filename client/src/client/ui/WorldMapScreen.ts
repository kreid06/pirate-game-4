/**
 * WorldMapScreen — full-screen scrollable/zoomable world map overlay.
 * Toggle with M. Pan with left-drag. Zoom with scroll wheel.
 */

import { Ship, IslandDef, Player } from '../../sim/Types.js';

const WORLD_MIN_X = -500;
const WORLD_MIN_Y = -500;
const WORLD_MAX_X = 9500;
const WORLD_MAX_Y = 8500;
const WORLD_W = WORLD_MAX_X - WORLD_MIN_X; // 10000
const WORLD_H = WORLD_MAX_Y - WORLD_MIN_Y; // 9000

// Full coordinate space capacity (Q16.16 × WORLD_SCALE_FACTOR=10)
const FULL_WORLD_HALF = 327679; // ±327,679 client pixels
const FULL_WORLD_SIZE = FULL_WORLD_HALF * 2; // 655,358

export class WorldMapScreen {
  public visible = false;

  // Pan offset in world pixels (centre of viewport)
  private panX = WORLD_MIN_X + WORLD_W / 2;
  private panY = WORLD_MIN_Y + WORLD_H / 2;
  // Zoom: world pixels per canvas pixel
  private zoom = 1.0; // higher = zoomed out

  // Drag state
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragPanStartX = 0;
  private dragPanStartY = 0;

  // Cached canvas size from last render — used for hit-testing
  private _cw = 0;
  private _ch = 0;

  // Close button bounds
  private _closeBounds: { x: number; y: number; w: number; h: number } | null = null;

  // Player position captured at open() — used only as a marker, not for initial pan
  private _openPlayerPos: { x: number; y: number } | null = null;

  open(localPlayerPos?: { x: number; y: number }): void {
    this.visible = true;
    this._closeBounds = null;
    this._openPlayerPos = localPlayerPos ?? null;
    // Only reset pan/zoom on the very first open (zoom===0 is the sentinel for "never opened")
    if (this.zoom === 0) {
      this.panX = WORLD_MIN_X + WORLD_W / 2;
      this.panY = WORLD_MIN_Y + WORLD_H / 2;
      // zoom stays 0 — first render will call fitZoom()
    }
  }

  close(): void {
    this.visible = false;
    this.dragging = false;
  }

  // ── Input handlers ─────────────────────────────────────────────────────────

  /** Returns true if the click was consumed. */
  handleMouseDown(x: number, y: number): boolean {
    if (!this.visible) return false;
    // Check close button
    if (this._closeBounds) {
      const b = this._closeBounds;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.close();
        return true;
      }
    }
    // Start drag anywhere on the map
    this.dragging = true;
    this.dragStartX = x;
    this.dragStartY = y;
    this.dragPanStartX = this.panX;
    this.dragPanStartY = this.panY;
    return true;
  }

  handleMouseMove(x: number, y: number): void {
    if (!this.visible || !this.dragging) return;
    const dx = x - this.dragStartX;
    const dy = y - this.dragStartY;
    this.panX = this.dragPanStartX - dx * this.zoom;
    this.panY = this.dragPanStartY - dy * this.zoom;
    this.clampPan();
  }

  handleMouseUp(): void {
    this.dragging = false;
  }

  /** Returns true if consumed. deltaY > 0 = zoom out, < 0 = zoom in. */
  handleWheel(deltaY: number, x: number, y: number): boolean {
    if (!this.visible) return false;
    // zoom = world-px per screen-px; larger = more zoomed out
    const factor = deltaY > 0 ? 1.15 : 1 / 1.15;
    const zoomOutMax = this.fitZoom();  // most zoomed out: whole world fits
    const zoomInMax = 0.15;             // most zoomed in: ~150 world-px per screen

    // Zoom toward cursor position
    const worldX = this.panX + (x - this._cw / 2) * this.zoom;
    const worldY = this.panY + (y - this._ch / 2) * this.zoom;
    this.zoom = Math.min(zoomOutMax, Math.max(zoomInMax, this.zoom * factor));
    this.panX = worldX - (x - this._cw / 2) * this.zoom;
    this.panY = worldY - (y - this._ch / 2) * this.zoom;
    this.clampPan();
    return true;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(
    ctx: CanvasRenderingContext2D,
    ships: Ship[],
    islands: IslandDef[],
    players: Player[],
    localPlayerId: number | null | undefined,
    localCompanyId: number,
  ): void {
    if (!this.visible) return;

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    this._cw = cw;
    this._ch = ch;

    // Auto-fit on first open (zoom === 0 sentinel)
    if (this.zoom === 0) {
      this.zoom = this.fitZoom();
    }

    // Dark overlay
    ctx.fillStyle = 'rgba(2, 10, 20, 0.92)';
    ctx.fillRect(0, 0, cw, ch);

    // World-space → screen helpers
    const toScreenX = (wx: number) => (wx - this.panX) / this.zoom + cw / 2;
    const toScreenY = (wy: number) => (wy - this.panY) / this.zoom + ch / 2;
    const toScreenLen = (wl: number) => wl / this.zoom;

    // ── Grid lines every 100,000 units ────────────────────────────────────
    {
      const GRID = 100_000;
      const gridStart = Math.ceil(-FULL_WORLD_HALF / GRID) * GRID;
      const gridEnd   = Math.floor( FULL_WORLD_HALF / GRID) * GRID;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.font = '9px Consolas, monospace';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      for (let g = gridStart; g <= gridEnd; g += GRID) {
        const sx = toScreenX(g);
        const sy = toScreenY(g);
        // Vertical line
        if (sx >= 0 && sx <= cw) {
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, ch);
          ctx.stroke();
          if (g !== 0) {
            ctx.textAlign = 'center';
            ctx.fillText(g >= 1000 ? `${g / 1000}k` : String(g), sx, ch - 4);
          }
        }
        // Horizontal line
        if (sy >= 0 && sy <= ch) {
          ctx.beginPath();
          ctx.moveTo(0, sy);
          ctx.lineTo(cw, sy);
          ctx.stroke();
          if (g !== 0) {
            ctx.textAlign = 'left';
            ctx.fillText(g >= 1000 ? `${g / 1000}k` : String(g), 4, sy - 3);
          }
        }
      }
      // Draw the 0,0 axes slightly brighter
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      const ox = toScreenX(0), oy = toScreenY(0);
      if (ox >= 0 && ox <= cw) { ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, ch); ctx.stroke(); }
      if (oy >= 0 && oy <= ch) { ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(cw, oy); ctx.stroke(); }
      ctx.restore();
    }

    // ── Full coordinate-space boundary (±327,679) ─────────────────────────
    const fbx = toScreenX(-FULL_WORLD_HALF);
    const fby = toScreenY(-FULL_WORLD_HALF);
    const fbw = toScreenLen(FULL_WORLD_SIZE);
    const fbh = toScreenLen(FULL_WORLD_SIZE);
    ctx.strokeStyle = 'rgba(180, 60, 60, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(fbx, fby, fbw, fbh);
    ctx.setLineDash([]);

    // Label the full boundary
    const labelY = Math.max(fby + 14, 16);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = 'rgba(180, 60, 60, 0.6)';
    ctx.fillText('coordinate boundary ±327,679', fbx + 4, labelY);
    ctx.restore();

    // ── Ocean / world boundary (content area) ─────────────────────────────
    const bx = toScreenX(WORLD_MIN_X);
    const by = toScreenY(WORLD_MIN_Y);
    const bw = toScreenLen(WORLD_W);
    const bh = toScreenLen(WORLD_H);
    ctx.fillStyle = '#071830';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#1a4466';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);

    // ── Islands ────────────────────────────────────────────────────────────
    for (const isl of islands) {
      ctx.save();
      ctx.beginPath();
      if (isl.vertices && isl.vertices.length > 2) {
        // vertices are already absolute world coordinates (server sends isl.x + vx[i])
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

      // Label
      const lx = toScreenX(isl.x);
      const ly = toScreenY(isl.y);
      if (lx > -50 && lx < cw + 50 && ly > -50 && ly < ch + 50) {
        ctx.textAlign = 'center';
        ctx.font = `${Math.max(9, Math.min(14, toScreenLen(80)))}px Consolas, monospace`;
        ctx.fillStyle = '#55aa44';
        ctx.fillText(`Isle ${isl.id ?? '?'}`, lx, ly - toScreenLen(30) - 4);
      }
    }

    // ── Ships ──────────────────────────────────────────────────────────────
    for (const ship of ships) {
      const sx = toScreenX(ship.position.x);
      const sy = toScreenY(ship.position.y);
      if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;

      const isFriendly = localCompanyId !== 0 && ship.companyId === localCompanyId;
      const r = Math.max(4, toScreenLen(40));

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((ship.rotation ?? 0) + Math.PI / 2);
      // Draw a small ship triangle
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.4);      // bow
      ctx.lineTo(r * 0.7, r);
      ctx.lineTo(-r * 0.7, r);
      ctx.closePath();
      ctx.fillStyle = isFriendly ? '#4488ff' : '#ff4444';
      ctx.strokeStyle = isFriendly ? '#aaccff' : '#ffaaaa';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Ship label
      if (toScreenLen(1) > 0.04) {
        ctx.textAlign = 'center';
        ctx.font = `${Math.max(8, Math.min(12, toScreenLen(60)))}px Consolas, monospace`;
        ctx.fillStyle = isFriendly ? '#aaccff' : '#ffaaaa';
        ctx.fillText(`Ship ${ship.id}`, sx, sy + r + 12);
      }
    }

    // ── Players ────────────────────────────────────────────────────────────
    for (const player of players) {
      const pos = player.position;
      if (!pos) continue;
      const sx = toScreenX(pos.x);
      const sy = toScreenY(pos.y);
      if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;

      const isLocal = player.id === localPlayerId;
      const pr = Math.max(3, toScreenLen(25));

      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, pr, 0, Math.PI * 2);
      ctx.fillStyle = isLocal ? '#ffee44' : '#88ffcc';
      ctx.strokeStyle = isLocal ? '#ffffff' : '#448855';
      ctx.lineWidth = isLocal ? 2 : 1;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (isLocal) {
        // Pulsing ring hint
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, pr + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,238,68,0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      // Player name
      if (player.name) {
        ctx.textAlign = 'center';
        ctx.font = `${isLocal ? 'bold ' : ''}${Math.max(8, Math.min(11, toScreenLen(55)))}px Consolas, monospace`;
        ctx.fillStyle = isLocal ? '#ffee44' : '#aaffcc';
        ctx.fillText(player.name, sx, sy - pr - 4);
      }
    }

    // ── Scale bar ─────────────────────────────────────────────────────────
    this.renderScaleBar(ctx, cw, ch);

    // ── HUD overlay ───────────────────────────────────────────────────────
    ctx.textAlign = 'left';
    ctx.font = 'bold 18px Consolas, monospace';
    ctx.fillStyle = '#ccddee';
    ctx.fillText('WORLD MAP', 16, 30);

    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = '#556677';
    ctx.fillText('Drag to pan  •  Scroll to zoom  •  M or Esc to close', 16, 50);

    // Zoom indicator
    ctx.textAlign = 'right';
    ctx.fillStyle = '#556677';
    ctx.fillText(`zoom ×${(1 / this.zoom * 100).toFixed(0)}%`, cw - 16, 30);

    // ── Close button ──────────────────────────────────────────────────────
    const btnW = 28, btnH = 28;
    const btnX = cw - btnW - 12, btnY = 10;
    ctx.save();
    ctx.fillStyle = 'rgba(80, 20, 20, 0.85)';
    ctx.strokeStyle = '#aa3333';
    ctx.lineWidth = 1.5;
    if (ctx.roundRect) ctx.roundRect(btnX, btnY, btnW, btnH, 5);
    else ctx.rect(btnX, btnY, btnW, btnH);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('✕', btnX + btnW / 2, btnY + 19);
    ctx.restore();
    this._closeBounds = { x: btnX, y: btnY, w: btnW, h: btnH };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private fitZoom(): number {
    if (this._cw === 0 || this._ch === 0) return 800;
    // Zoom out to fit the entire coordinate space (±327,679)
    return Math.max(FULL_WORLD_SIZE / (this._cw * 0.92), FULL_WORLD_SIZE / (this._ch * 0.92));
  }

  private clampPan(): void {
    const hw = (this._cw / 2) * this.zoom;
    const hh = (this._ch / 2) * this.zoom;
    // Pan is clamped to the full coordinate space, not just the content area
    const fullMin = -FULL_WORLD_HALF;
    const fullMax =  FULL_WORLD_HALF;
    const fullSize = FULL_WORLD_SIZE;
    if (hw * 2 >= fullSize) this.panX = 0;
    else this.panX = Math.max(fullMin + hw, Math.min(fullMax - hw, this.panX));
    if (hh * 2 >= fullSize) this.panY = 0;
    else this.panY = Math.max(fullMin + hh, Math.min(fullMax - hh, this.panY));
  }

  private renderScaleBar(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    // Pick a nice world-unit bar length
    const targetScreenPx = 120;
    const worldUnitsPerScreenPx = this.zoom;
    const rawWorld = targetScreenPx * worldUnitsPerScreenPx;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawWorld)));
    const nice = [1, 2, 5, 10].map(m => m * magnitude).find(v => v >= rawWorld) ?? magnitude * 10;
    const barPx = nice / worldUnitsPerScreenPx;

    const x = 16, y = ch - 24;
    ctx.save();
    ctx.strokeStyle = '#aabbcc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + barPx, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.moveTo(x + barPx, y - 5);
    ctx.lineTo(x + barPx, y + 5);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = '#aabbcc';
    ctx.fillText(`${nice.toFixed(0)} px`, x + barPx / 2, y - 8);
    ctx.restore();
  }
}
