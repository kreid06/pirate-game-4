/**
 * BedTravelMenu — full-screen map for fast travel between company beds.
 * Opened when the player interacts with a bed (island structure or ship module).
 */

import { Ship, IslandDef } from '../../sim/Types.js';

export interface BedSource {
  kind: 'island' | 'ship';
  islandBedId?: number;
  shipId?: number;
  moduleId?: number;
}

export interface BedDestination {
  kind: 'island' | 'ship';
  label: string;
  x: number;
  y: number;
  islandBedId?: number;
  shipId?: number;
  moduleId?: number;
}

const WORLD_MIN_X = 0;
const WORLD_MIN_Y = 0;
const WORLD_MAX_X = 90_000;
const WORLD_MAX_Y = 90_000;
const WORLD_W = WORLD_MAX_X - WORLD_MIN_X;
const WORLD_H = WORLD_MAX_Y - WORLD_MIN_Y;
const MAJOR_GRID_STEP = 30_000;

const PURPLE = '#c8a0e8';
const PURPLE_DIM = '#8866aa';

export class BedTravelMenu {
  public visible = false;
  public onTravel: ((source: BedSource, target: BedDestination) => void) | null = null;
  public onSetRespawn: ((source: BedSource) => void) | null = null;

  private _source: BedSource | null = null;
  private _sourceLabel = '';
  private _sourceX = 0;
  private _sourceY = 0;
  private _destinations: BedDestination[] = [];
  private _selected: BedDestination | null = null;

  private panX = WORLD_MIN_X + WORLD_W / 2;
  private panY = WORLD_MIN_Y + WORLD_H / 2;
  private zoom = 0;

  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragPanStartX = 0;
  private dragPanStartY = 0;

  private _cw = 0;
  private _ch = 0;
  private _pulseT = 0;

  private _closeBounds: { x: number; y: number; w: number; h: number } | null = null;
  private _travelBounds: { x: number; y: number; w: number; h: number } | null = null;
  private _respawnBounds: { x: number; y: number; w: number; h: number } | null = null;

  open(
    source: BedSource,
    destinations: BedDestination[],
    sourcePos: { x: number; y: number; label: string },
  ): void {
    this._source = source;
    this._destinations = destinations;
    this._sourceX = sourcePos.x;
    this._sourceY = sourcePos.y;
    this._sourceLabel = sourcePos.label;
    this._selected = destinations[0] ?? null;
    this.panX = sourcePos.x;
    this.panY = sourcePos.y;
    this.zoom = 0;
    this.dragging = false;
    this.visible = true;
  }

  close(): void {
    this.visible = false;
    this.dragging = false;
    this._source = null;
    this._destinations = [];
    this._selected = null;
    this._closeBounds = null;
    this._travelBounds = null;
    this._respawnBounds = null;
  }

  handleMouseDown(x: number, y: number): boolean {
    if (!this.visible) return false;

    if (this._closeBounds && this._hit(x, y, this._closeBounds)) {
      this.close();
      return true;
    }
    if (this._travelBounds && this._hit(x, y, this._travelBounds) && this._source && this._selected) {
      this.onTravel?.(this._source, this._selected);
      return true;
    }
    if (this._respawnBounds && this._hit(x, y, this._respawnBounds) && this._source) {
      this.onSetRespawn?.(this._source);
      return true;
    }

    if (this._trySelectNearClick(x, y)) return true;

    this.dragging = true;
    this.dragStartX = x;
    this.dragStartY = y;
    this.dragPanStartX = this.panX;
    this.dragPanStartY = this.panY;
    return true;
  }

  /** @deprecated use handleMouseDown — kept for callers that still use handleClick */
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

  render(
    ctx: CanvasRenderingContext2D,
    ships: Ship[],
    islands: IslandDef[],
    localCompanyId: number,
  ): void {
    if (!this.visible || !this._source) return;

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';

    this._refreshPositions(ships);

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    this._cw = cw;
    this._ch = ch;
    this._pulseT = Date.now() / 1000;

    if (this.zoom === 0) {
      this.zoom = this._fitZoom();
    }

    ctx.fillStyle = 'rgba(12, 8, 22, 0.94)';
    ctx.fillRect(0, 0, cw, ch);

    const toScreenX = (wx: number) => (wx - this.panX) / this.zoom + cw / 2;
    const toScreenY = (wy: number) => (wy - this.panY) / this.zoom + ch / 2;
    const toScreenLen = (wl: number) => wl / this.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(this._pulseT * 3.5);

    // Ocean boundary
    const bx = toScreenX(WORLD_MIN_X);
    const by = toScreenY(WORLD_MIN_Y);
    const bw = toScreenLen(WORLD_W);
    const bh = toScreenLen(WORLD_H);
    ctx.fillStyle = '#071830';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#1a4466';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);

    // Grid
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.25;
    for (let g = WORLD_MIN_X; g < WORLD_MAX_X; g += MAJOR_GRID_STEP) {
      const sx = toScreenX(g);
      const sy = toScreenY(g);
      if (sx >= 0 && sx <= cw) {
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, ch);
        ctx.stroke();
      }
      if (sy >= 0 && sy <= ch) {
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(cw, sy);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Islands
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
        const baseR = (isl as { beach_radius?: number }).beach_radius ?? 185;
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
        ctx.font = `${Math.max(9, Math.min(14, toScreenLen(80)))}px Georgia, serif`;
        ctx.fillStyle = '#55aa44';
        ctx.fillText(`Isle ${isl.id ?? '?'}`, lx, ly - toScreenLen(30) - 4);
      }
    }

    // Friendly ships (context)
    for (const ship of ships) {
      if (localCompanyId !== 0 && ship.companyId !== localCompanyId) continue;
      const sx = toScreenX(ship.position.x);
      const sy = toScreenY(ship.position.y);
      if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;
      const r = Math.max(4, toScreenLen(40));
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((ship.rotation ?? 0) + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.4);
      ctx.lineTo(r * 0.7, r);
      ctx.lineTo(-r * 0.7, r);
      ctx.closePath();
      ctx.fillStyle = 'rgba(68, 136, 255, 0.55)';
      ctx.strokeStyle = '#6688cc';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Destination beds
    for (const dest of this._destinations) {
      const mx = toScreenX(dest.x);
      const my = toScreenY(dest.y);
      if (mx < -30 || mx > cw + 30 || my < -30 || my > ch + 30) continue;
      const selected = dest === this._selected;
      const isShip = dest.kind === 'ship';

      ctx.save();
      if (selected) {
        ctx.beginPath();
        ctx.arc(mx, my, 16 + pulse * 4, 0, Math.PI * 2);
        ctx.fillStyle = isShip
          ? `rgba(120, 160, 255, ${0.18 + pulse * 0.1})`
          : `rgba(100, 220, 140, ${0.18 + pulse * 0.1})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(mx, my, selected ? 8 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = selected
        ? (isShip ? '#88bbff' : '#66ee99')
        : (isShip ? '#5566aa' : '#338855');
      ctx.strokeStyle = selected ? '#ffffff' : (isShip ? '#8899cc' : '#226644');
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.font = `${selected ? 'bold ' : ''}${Math.max(9, Math.min(12, toScreenLen(70)))}px Georgia, serif`;
      ctx.fillStyle = selected ? '#ffffff' : '#99aabb';
      ctx.fillText(dest.label, mx, my - (selected ? 14 : 10));
    }

    // Current / source bed
    {
      const mx = toScreenX(this._sourceX);
      const my = toScreenY(this._sourceY);
      ctx.save();
      ctx.beginPath();
      ctx.arc(mx, my, 18 + pulse * 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 160, 232, ${0.2 + pulse * 0.08})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(mx, my, 9, 0, Math.PI * 2);
      ctx.fillStyle = PURPLE;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.max(10, Math.min(13, toScreenLen(75)))}px Georgia, serif`;
      ctx.fillStyle = PURPLE;
      ctx.fillText(this._sourceLabel, mx, my - 16);
      ctx.font = `${Math.max(9, Math.min(11, toScreenLen(60)))}px Georgia, serif`;
      ctx.fillStyle = PURPLE_DIM;
      ctx.fillText('(current bed)', mx, my + 18);
    }

    this._renderScaleBar(ctx, cw, ch);

    // HUD header
    const bannerH = 56;
    ctx.fillStyle = 'rgba(40, 20, 60, 0.85)';
    ctx.fillRect(0, 0, cw, bannerH);
    ctx.textAlign = 'left';
    ctx.font = 'bold 20px Georgia, serif';
    ctx.fillStyle = PURPLE;
    ctx.fillText('🛏  Bed Travel', 16, 34);
    ctx.font = '12px Georgia, serif';
    ctx.fillStyle = '#8878a0';
    ctx.fillText('Click a bed  •  Drag to pan  •  Scroll to zoom', 16, bannerH - 10);

    if (this._selected) {
      ctx.textAlign = 'right';
      ctx.font = '12px Georgia, serif';
      ctx.fillStyle = '#c0b0d8';
      ctx.fillText(`Selected: ${this._selected.label}`, cw - 16, 28);
    }

    ctx.textAlign = 'right';
    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = '#665577';
    ctx.fillText(`zoom ×${(1 / this.zoom * 100).toFixed(0)}%`, cw - 16, bannerH - 10);

    // Close button
    const closeW = 28;
    const closeH = 28;
    const closeX = cw - closeW - 12;
    const closeY = 10;
    ctx.fillStyle = 'rgba(60, 30, 80, 0.9)';
    ctx.strokeStyle = PURPLE_DIM;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(closeX, closeY, closeW, closeH, 5);
    else ctx.rect(closeX, closeY, closeW, closeH);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = 'bold 16px Georgia, serif';
    ctx.fillStyle = '#e8d8f8';
    ctx.fillText('✕', closeX + closeW / 2, closeY + 19);
    this._closeBounds = { x: closeX, y: closeY, w: closeW, h: closeH };

    // Footer buttons
    const respawnW = 240;
    const respawnH = 44;
    const travelW = 180;
    const travelH = 44;
    const gap = 12;
    const footY = ch - respawnH - 16;
    const travelX = cw - travelW - 16;
    const respawnX = travelX - gap - respawnW;
    const canTravel = this._selected !== null;

    ctx.fillStyle = 'rgba(60, 30, 90, 0.85)';
    ctx.strokeStyle = '#8866aa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(respawnX, footY, respawnW, respawnH, 8);
    else ctx.rect(respawnX, footY, respawnW, respawnH);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = '13px Georgia, serif';
    ctx.fillStyle = '#d8c0f8';
    ctx.fillText('Set respawn here', respawnX + respawnW / 2, footY + 27);
    this._respawnBounds = { x: respawnX, y: footY, w: respawnW, h: respawnH };

    ctx.save();
    if (canTravel) {
      ctx.shadowColor = PURPLE;
      ctx.shadowBlur = 8 + pulse * 6;
    }
    ctx.fillStyle = canTravel ? '#5a3080' : '#2a1a30';
    ctx.strokeStyle = canTravel ? PURPLE : '#443355';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(travelX, footY, travelW, travelH, 8);
    else ctx.rect(travelX, footY, travelW, travelH);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.font = 'bold 16px Georgia, serif';
    ctx.fillStyle = canTravel ? '#ffffff' : '#554466';
    ctx.fillText('TRAVEL', travelX + travelW / 2, footY + 28);
    this._travelBounds = { x: travelX, y: footY, w: travelW, h: travelH };

    if (this._destinations.length === 0) {
      ctx.textAlign = 'center';
      ctx.font = '14px Georgia, serif';
      ctx.fillStyle = '#8878a0';
      ctx.fillText('No other beds available — set respawn or close', cw / 2, ch / 2);
    }

    ctx.restore();
  }

  private _refreshPositions(ships: Ship[]): void {
    if (this._source?.kind === 'ship' && this._source.shipId && this._source.moduleId) {
      const pos = this._shipBedPos(ships, this._source.shipId, this._source.moduleId);
      if (pos) {
        this._sourceX = pos.x;
        this._sourceY = pos.y;
      }
    }
    for (const dest of this._destinations) {
      if (dest.kind === 'ship' && dest.shipId && dest.moduleId) {
        const pos = this._shipBedPos(ships, dest.shipId, dest.moduleId);
        if (pos) {
          dest.x = pos.x;
          dest.y = pos.y;
        }
      }
    }
  }

  private _shipBedPos(ships: Ship[], shipId: number, moduleId: number): { x: number; y: number } | null {
    const ship = ships.find(s => s.id === shipId);
    const mod = ship?.modules.find(m => m.id === moduleId);
    if (!ship || !mod) return null;
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return {
      x: ship.position.x + (mod.localPos.x * cos - mod.localPos.y * sin),
      y: ship.position.y + (mod.localPos.x * sin + mod.localPos.y * cos),
    };
  }

  private _trySelectNearClick(x: number, y: number): boolean {
    if (this.zoom === 0) return false;
    const wx = this.panX + (x - this._cw / 2) * this.zoom;
    const wy = this.panY + (y - this._ch / 2) * this.zoom;
    const threshold = 22 * this.zoom;
    let best: BedDestination | null = null;
    let bestDist = threshold;
    for (const dest of this._destinations) {
      const d = Math.hypot(dest.x - wx, dest.y - wy);
      if (d < bestDist) {
        bestDist = d;
        best = dest;
      }
    }
    if (best) {
      this._selected = best;
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
    const x = 16;
    const y = ch - 72;
    ctx.save();
    ctx.strokeStyle = '#8878a0';
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
    ctx.font = '11px Georgia, serif';
    ctx.fillStyle = '#8878a0';
    ctx.fillText(`${nice.toFixed(0)} px`, x + barPx / 2, y - 8);
    ctx.restore();
  }

  private _hit(x: number, y: number, h: { x: number; y: number; w: number; h: number }): boolean {
    return x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
  }
}
