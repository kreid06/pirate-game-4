/**
 * RespawnScreen — full-screen overlay shown when the player dies or first spawns.
 * Displays a minimap with world islands and friendly ships as selectable spawn points.
 */

import { Ship, IslandDef } from '../../sim/Types.js';

interface SpawnOption {
  type: 'ship' | 'island';
  shipId?: number;
  x: number;
  y: number;
  label: string;
}

export class RespawnScreen {
  public visible: boolean = false;

  /** Called when the player confirms a respawn location.
   *  shipId is set when spawning on a ship, otherwise worldX/worldY are used. */
  public onRespawnConfirmed: ((shipId?: number, worldX?: number, worldY?: number) => void) | null = null;

  private selectedOption: SpawnOption | null = null;
  private spawnOptions: SpawnOption[] = [];

  // World bounds (pixels) — covers both islands with margin.
  // Island 1 (tropical): centre (800, 600).
  // Island 2 (continental): centre (6000, 5000), vertices ±3100 X, ±3050 Y → edges ~2900–9100 X, ~2000–8050 Y.
  // No hard server boundary, but playable space is effectively 0–9500 × 0–8500.
  private readonly WORLD_W = 9500;
  private readonly WORLD_H = 8500;

  // Cached render bounds for click hit-testing
  private _btnBounds: { x: number; y: number; w: number; h: number } | null = null;
  private _mapBounds: { x: number; y: number; w: number; h: number } | null = null;

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
        x: isl.x,
        y: isl.y,
        label: `Isle ${isl.id ?? '?'}`,
      });
    }

    this.selectedOption = this.spawnOptions[0] ?? null;
  }

  close(): void {
    this.visible = false;
    this._btnBounds = null;
    this._mapBounds = null;
  }

  render(ctx: CanvasRenderingContext2D, ships: Ship[], islands: IslandDef[], localCompanyId: number): void {
    if (!this.visible) return;

    // Keep spawn option positions fresh (ships move)
    for (const opt of this.spawnOptions) {
      if (opt.type === 'ship' && opt.shipId !== undefined) {
        const ship = ships.find(s => s.id === opt.shipId);
        if (ship) { opt.x = ship.position.x; opt.y = ship.position.y; }
      }
    }

    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    // Dark overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
    ctx.fillRect(0, 0, cw, ch);

    // Title
    ctx.textAlign = 'center';
    ctx.font = 'bold 60px serif';
    ctx.fillStyle = '#cc2233';
    ctx.fillText('YOU DIED', cw / 2, ch * 0.14);

    ctx.font = '20px Consolas, monospace';
    ctx.fillStyle = '#999999';
    ctx.fillText('Select a spawn location and press RESPAWN', cw / 2, ch * 0.14 + 38);

    // ── Minimap panel ─────────────────────────────────────────────────────────
    const mapW = Math.min(cw - 64, 680);
    const mapH = Math.min(ch * 0.52, 460);
    const mapX = (cw - mapW) / 2;
    const mapY = ch * 0.22;

    ctx.fillStyle = '#071420';
    ctx.strokeStyle = '#335566';
    ctx.lineWidth = 2;
    ctx.fillRect(mapX, mapY, mapW, mapH);
    ctx.strokeRect(mapX, mapY, mapW, mapH);

    // World-space → map-pixel helpers
    const toMapX = (wx: number) => mapX + (wx / this.WORLD_W) * mapW;
    const toMapY = (wy: number) => mapY + (wy / this.WORLD_H) * mapH;

    // Draw islands
    for (const isl of islands) {
      const mx = toMapX(isl.x);
      const my = toMapY(isl.y);

      ctx.save();
      ctx.beginPath();
      if (isl.vertices && isl.vertices.length > 2) {
        ctx.moveTo(
          toMapX(isl.x + isl.vertices[0].x),
          toMapY(isl.y + isl.vertices[0].y)
        );
        for (let i = 1; i < isl.vertices.length; i++) {
          ctx.lineTo(
            toMapX(isl.x + isl.vertices[i].x),
            toMapY(isl.y + isl.vertices[i].y)
          );
        }
        ctx.closePath();
      } else {
        // Circular island — use beach_radius if available
        const r = Math.max(3, (((isl as any).beach_radius ?? 120) / this.WORLD_W) * mapW);
        ctx.arc(mx, my, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#1e4a12';
      ctx.strokeStyle = '#3a7a20';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.font = '10px Consolas, monospace';
      ctx.fillStyle = '#88cc66';
      ctx.fillText(`Isle ${isl.id ?? '?'}`, mx, my - 6);
    }

    // Draw all friendly ships on the map (even non-spawn ships for context)
    for (const ship of ships) {
      if (ship.companyId !== localCompanyId || localCompanyId === 0) continue;
      const mx = toMapX(ship.position.x);
      const my = toMapY(ship.position.y);
      ctx.save();
      ctx.beginPath();
      ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#8888ff';
      ctx.fill();
      ctx.restore();
    }

    // Draw selectable spawn options
    for (const opt of this.spawnOptions) {
      const mx = toMapX(opt.x);
      const my = toMapY(opt.y);
      const selected = opt === this.selectedOption;

      ctx.save();
      if (opt.type === 'ship') {
        // Ship icon: filled circle with glow when selected
        if (selected) {
          ctx.beginPath();
          ctx.arc(mx, my, 11, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 238, 68, 0.25)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(mx, my, selected ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = selected ? '#ffee44' : '#aaaaff';
        ctx.strokeStyle = selected ? '#ffffff' : '#6666cc';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      } else {
        // Island icon: small square
        if (selected) {
          ctx.beginPath();
          ctx.arc(mx, my, 10, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(68, 255, 160, 0.20)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(mx, my, selected ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = selected ? '#44ffaa' : '#44aa66';
        ctx.strokeStyle = selected ? '#ffffff' : '#226644';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.font = `${selected ? 'bold ' : ''}11px Consolas, monospace`;
      ctx.fillStyle = selected ? '#ffffff' : '#999999';
      ctx.fillText(opt.label, mx, my - 11);
    }

    // ── Respawn button ────────────────────────────────────────────────────────
    const btnW = 220;
    const btnH = 50;
    const btnX = cw / 2 - btnW / 2;
    const btnY = mapY + mapH + 20;
    const enabled = this.selectedOption !== null;

    ctx.save();
    ctx.fillStyle = enabled ? '#881a0e' : '#3a1a14';
    ctx.strokeStyle = enabled ? '#dd5533' : '#5a2a22';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(btnX, btnY, btnW, btnH, 7);
    } else {
      ctx.rect(btnX, btnY, btnW, btnH);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillStyle = enabled ? '#ffffff' : '#555555';
    ctx.fillText('RESPAWN', cw / 2, btnY + 34);

    // Hint text
    if (this.selectedOption) {
      ctx.textAlign = 'center';
      ctx.font = '14px Consolas, monospace';
      ctx.fillStyle = '#888888';
      ctx.fillText(`Spawn: ${this.selectedOption.label}`, cw / 2, btnY + btnH + 20);
    }

    this._btnBounds = { x: btnX, y: btnY, w: btnW, h: btnH };
    this._mapBounds = { x: mapX, y: mapY, w: mapW, h: mapH };
  }

  handleClick(x: number, y: number): boolean {
    if (!this.visible) return false;

    // Respawn button
    if (this._btnBounds) {
      const b = this._btnBounds;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        if (this.selectedOption) {
          if (this.selectedOption.type === 'ship') {
            this.onRespawnConfirmed?.(this.selectedOption.shipId, undefined, undefined);
          } else {
            this.onRespawnConfirmed?.(undefined, this.selectedOption.x, this.selectedOption.y);
          }
          this.visible = false;
        }
        return true;
      }
    }

    // Map area — select nearest spawn option
    if (this._mapBounds) {
      const m = this._mapBounds;
      if (x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) {
        const wx = ((x - m.x) / m.w) * this.WORLD_W;
        const wy = ((y - m.y) / m.h) * this.WORLD_H;
        let best: SpawnOption | null = null;
        let bestDist = Infinity;
        for (const opt of this.spawnOptions) {
          const d = Math.hypot(opt.x - wx, opt.y - wy);
          if (d < bestDist) { bestDist = d; best = opt; }
        }
        if (best) this.selectedOption = best;
        return true;
      }
    }

    // Consume all clicks while visible so nothing behind fires
    return true;
  }
}
