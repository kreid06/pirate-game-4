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

const RING_INNER        = 40;   // px — inner radius of the ring
const RING_OUTER        = 90;   // px — outer radius of the ring
const RING_MID          = (RING_INNER + RING_OUTER) / 2;  // label placement radius
const DEAD_ZONE         = 24;   // px — mouse inside this => cancel (null selection)
const GAP_PX            = 6;    // px — straight gap width between slices

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
    const n            = this._options.length;
    const slice        = (Math.PI * 2) / n;
    const base         = -Math.PI / 2;
    const g            = GAP_PX / 2; // half-gap: perpendicular distance from boundary to slice edge
    const isCancelling = this._hoveredId === null;

    ctx.save();

    // ── Ring slices ────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const opt       = this._options[i];
      const isHovered = opt.id === this._hoveredId;

      ctx.beginPath();

      if (n === 1) {
        // Single option: full ring — moveTo prevents the implicit lineTo
        // that canvas would otherwise draw between the two arcs.
        ctx.arc(cx, cy, RING_OUTER, 0, Math.PI * 2);
        ctx.moveTo(cx + RING_INNER, cy);
        ctx.arc(cx, cy, RING_INNER, 0, Math.PI * 2, true);
      } else {
        // Parallel-edge slice: the gap at each boundary is a straight line
        // (chord) parallel to the radius at that angle, offset by g pixels.
        // Intersection of that chord with a circle of radius R is at angle:
        //   boundaryAngle + arcsin(g / R)  (into the slice)
        const A = base + i * slice;
        const B = base + (i + 1) * slice;

        // Adjusted arc endpoints so the straight edge is a true chord (parallel gap)
        const aoOuter = A + Math.asin(g / RING_OUTER); // arc-start on outer circle
        const aoInner = A + Math.asin(g / RING_INNER); // arc-start on inner circle
        const boOuter = B - Math.asin(g / RING_OUTER); // arc-end on outer circle
        const boInner = B - Math.asin(g / RING_INNER); // arc-end on inner circle

        // Path: inner-start → outer-start (straight parallel edge)
        //       outer arc from start to end
        //       outer-end → inner-end (straight parallel edge)
        //       inner arc from end back to start (reversed)
        ctx.moveTo(cx + Math.cos(aoInner) * RING_INNER, cy + Math.sin(aoInner) * RING_INNER);
        ctx.lineTo(cx + Math.cos(aoOuter) * RING_OUTER, cy + Math.sin(aoOuter) * RING_OUTER);
        ctx.arc(cx, cy, RING_OUTER, aoOuter, boOuter);
        ctx.lineTo(cx + Math.cos(boInner) * RING_INNER, cy + Math.sin(boInner) * RING_INNER);
        ctx.arc(cx, cy, RING_INNER, boInner, aoInner, true);
      }

      ctx.closePath();

      if (isHovered) {
        ctx.fillStyle   = 'rgba(200, 145, 20, 0.90)';
        ctx.strokeStyle = 'rgba(255, 220, 80, 1.0)';
        ctx.lineWidth   = 2;
      } else {
        ctx.fillStyle   = 'rgba(14, 18, 26, 0.82)';
        ctx.strokeStyle = 'rgba(130, 105, 55, 0.55)';
        ctx.lineWidth   = 1.5;
      }
      ctx.fill();
      ctx.stroke();

      // Label at the angular midpoint of the slice, at mid-ring radius
      const midAngle = base + (i + 0.5) * slice;
      const lx = cx + Math.cos(midAngle) * RING_MID;
      const ly = cy + Math.sin(midAngle) * RING_MID;

      ctx.font         = isHovered ? 'bold 11px sans-serif' : '10px sans-serif';
      ctx.fillStyle    = isHovered ? '#fff8e0' : 'rgba(200, 185, 140, 0.85)';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opt.label, lx, ly);
    }

    // ── Center dot — red when cancelling, gold when selecting ─────────────
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = isCancelling ? 'rgba(200, 60, 60, 0.9)' : 'rgba(200, 160, 60, 0.9)';
    ctx.fill();

    // Dead-zone ring hint
    ctx.beginPath();
    ctx.arc(cx, cy, DEAD_ZONE, 0, Math.PI * 2);
    ctx.strokeStyle = isCancelling ? 'rgba(200, 60, 60, 0.30)' : 'rgba(180, 140, 60, 0.15)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.restore();
  }
}
