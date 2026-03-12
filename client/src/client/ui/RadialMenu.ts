/**
 * Generic radial action menu.
 *
 * Usage:
 *   const menu = new RadialMenu();
 *   menu.open(cx, cy, [ { id: 'climb', label: 'Climb' }, { id: 'retract', label: 'Retract' } ]);
 *   menu.updateMouse(mx, my);   // call every frame / on mousemove
 *   const selected = menu.getHoveredId();
 *   menu.close();
 */

export interface RadialOption {
  id: string;
  label: string;
}

const HOLD_OPEN_RADIUS  = 70;   // px — distance from center to option pill
const PILL_RADIUS       = 22;   // px — option pill hit/draw radius
const DEAD_ZONE         = 24;   // px — mouse inside this => keep current selection

export class RadialMenu {
  private _options: RadialOption[] = [];
  private _center: { x: number; y: number } | null = null;
  private _open = false;
  private _hoveredId: string | null = null;
  private _mouseX = 0;
  private _mouseY = 0;

  // ── Public API ─────────────────────────────────────────────────────────

  get isOpen(): boolean { return this._open; }

  open(cx: number, cy: number, options: RadialOption[]): void {
    this._center  = { x: cx, y: cy };
    this._options = options;
    this._open    = true;
    // Start with null (no selection); evaluate current mouse position immediately
    // so the selection is correct if the mouse is already outside the dead zone.
    this._hoveredId = null;
    this.updateMouse(this._mouseX, this._mouseY);
  }

  close(): void {
    this._open      = false;
    this._center    = null;
    this._hoveredId = null;
  }

  getHoveredId(): string | null {
    return this._hoveredId;
  }

  updateMouse(x: number, y: number): void {
    this._mouseX = x;
    this._mouseY = y;
    if (!this._open || !this._center || this._options.length === 0) return;

    const dx = x - this._center.x;
    const dy = y - this._center.y;
    const dist = Math.hypot(dx, dy);

    if (dist < DEAD_ZONE) {
      // Inside dead zone — null signals a cancelled interaction
      this._hoveredId = null;
      return;
    }

    // Angle from center, find closest option slot
    const angle = Math.atan2(dy, dx);
    const n     = this._options.length;
    const slice = (Math.PI * 2) / n;
    const base  = -Math.PI / 2; // options start from top

    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < n; i++) {
      const optAngle = base + i * slice;
      let diff = Math.abs(angle - optAngle);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    this._hoveredId = this._options[bestIdx].id;
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  render(ctx: CanvasRenderingContext2D): void {
    if (!this._open || !this._center || this._options.length === 0) return;

    const { x: cx, y: cy } = this._center;
    const n     = this._options.length;
    const slice = (Math.PI * 2) / n;
    const base  = -Math.PI / 2;

    ctx.save();

    // ── Background disc ────────────────────────────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, HOLD_OPEN_RADIUS + PILL_RADIUS + 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10, 14, 20, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 140, 60, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ── Center dot — red when in dead zone (cancel), gold when selecting ──
    const isCancelling = this._hoveredId === null;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = isCancelling ? 'rgba(200, 60, 60, 0.9)' : 'rgba(200, 160, 60, 0.9)';
    ctx.fill();
    // Dead zone ring hint
    ctx.beginPath();
    ctx.arc(cx, cy, DEAD_ZONE, 0, Math.PI * 2);
    ctx.strokeStyle = isCancelling ? 'rgba(200, 60, 60, 0.35)' : 'rgba(180, 140, 60, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ── Option pills ───────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const opt      = this._options[i];
      const angle    = base + i * slice;
      const ox       = cx + Math.cos(angle) * HOLD_OPEN_RADIUS;
      const oy       = cy + Math.sin(angle) * HOLD_OPEN_RADIUS;
      const isHovered = opt.id === this._hoveredId;

      // Connector line from center to pill
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ox, oy);
      ctx.strokeStyle = isHovered
        ? 'rgba(255, 200, 60, 0.7)'
        : 'rgba(120, 100, 60, 0.35)';
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.stroke();

      // Pill background
      ctx.beginPath();
      ctx.arc(ox, oy, PILL_RADIUS, 0, Math.PI * 2);
      if (isHovered) {
        ctx.fillStyle = 'rgba(200, 140, 20, 0.92)';
        ctx.strokeStyle = 'rgba(255, 220, 80, 1.0)';
        ctx.lineWidth = 2;
      } else {
        ctx.fillStyle = 'rgba(30, 35, 45, 0.88)';
        ctx.strokeStyle = 'rgba(100, 85, 50, 0.6)';
        ctx.lineWidth = 1.5;
      }
      ctx.fill();
      ctx.stroke();

      // Label
      const labelSize = isHovered ? 11 : 10;
      ctx.font = `${isHovered ? 'bold ' : ''}${labelSize}px sans-serif`;
      ctx.fillStyle = isHovered ? '#fff8e0' : 'rgba(200, 185, 140, 0.85)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opt.label, ox, oy);
    }

    ctx.restore();
  }
}
