/**
 * IslandEditor.ts
 *
 * A developer tool for visually editing island polygon layers.
 * Open via the `/islandEditor [id]` command in the command console.
 *
 * Supported layers:
 *  - outerSand  — the beach / outer sand polygon
 *  - innerGrass — the grass interior polygon
 *  - waterZone  — harbor / cove water cutouts (multiple polygons)
 *  - sandPatch  — inner beach sand strips (multiple polygons)
 *
 * All coordinates are stored and exported in island-local space
 * (relative to island centre at isl.x / isl.y).
 */

import { Vec2 } from '../../common/Vec2.js';
import type { IslandDef } from '../../sim/Types.js';
import type { Camera } from './Camera.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };
type EditMode = 'move' | 'add';
type LayerKey = 'outerSand' | 'innerGrass' | 'waterZone' | 'sandPatch';

interface LayerDef {
  key: LayerKey;
  label: string;
  fill: string;
  stroke: string;
  multi: boolean; // supports multiple polygons
}

const LAYERS: LayerDef[] = [
  { key: 'outerSand',  label: '🏖 Outer Sand',   fill: 'rgba(214,194,139,0.30)', stroke: '#d6c28b', multi: false },
  { key: 'innerGrass', label: '🌿 Inner Grass',  fill: 'rgba(79,127,54,0.30)',   stroke: '#4f7f36', multi: false },
  { key: 'waterZone',  label: '💧 Water Zones',  fill: 'rgba(30,144,255,0.30)',  stroke: '#3abaff', multi: true  },
  { key: 'sandPatch',  label: '🏝 Sand Patches', fill: 'rgba(200,180,100,0.30)', stroke: '#c8b464', multi: true  },
];

const VERTEX_RADIUS  = 6;   // px – normal dot
const HOVER_RADIUS   = 9;   // px – hovered dot
const SNAP_DIST_PX   = 14;  // px – how close to a vertex to grab / delete

// ── IslandEditor ──────────────────────────────────────────────────────────────

export class IslandEditor {
  public visible = false;

  // External references
  private canvas: HTMLCanvasElement;
  private getCamera: () => Camera;

  // Live island list (fed from ClientApplication each frame)
  private islands: IslandDef[] = [];
  private selectedIslandId: number | null = null;

  // Editing state
  private activeLayerKey: LayerKey = 'outerSand';
  private activePolyIdx  = 0;
  private editMode: EditMode = 'move';

  /**
   * Per-island, per-layer polygon data.
   * Key: `${islandId}:${layerKey}` → array of polygons (each polygon = Pt[]).
   * All coordinates are in island-local space (world − island centre).
   */
  private layerData = new Map<string, Pt[][]>();

  // Drag / hover state
  private dragging: { polyIdx: number; vertIdx: number } | null = null;
  private hoverVertex: { polyIdx: number; vertIdx: number } | null = null;
  private mouseScreen: Pt = { x: 0, y: 0 };

  // ── HTML panel elements ───────────────────────────────────────────────────

  private panel!: HTMLDivElement;
  private styleEl!: HTMLStyleElement;
  private islandSelect!: HTMLSelectElement;
  private polySelect!: HTMLSelectElement;
  private coordsEl!: HTMLSpanElement;
  private layerBtns = new Map<LayerKey, HTMLButtonElement>();
  private modeBtns  = new Map<EditMode, HTMLButtonElement>();

  // Bound handlers for proper cleanup
  private _onMouseMove!: (e: MouseEvent) => void;
  private _onMouseDown!: (e: MouseEvent) => void;
  private _onMouseUp!:   (e: MouseEvent) => void;
  private _onCtxMenu!:   (e: MouseEvent) => void;
  private _onKeyDown!:   (e: KeyboardEvent) => void;

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(canvas: HTMLCanvasElement, getCamera: () => Camera) {
    this.canvas   = canvas;
    this.getCamera = getCamera;
    this._buildStyles();
    this._buildPanel();
    this._bindEvents();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  open(islandId?: number): void {
    this.visible = true;
    this.panel.style.display = 'flex';
    if (islandId !== undefined) {
      this.selectIsland(islandId);
    }
  }

  close(): void {
    this.visible = false;
    this.panel.style.display = 'none';
    this.dragging = null;
  }

  toggle(): void { this.visible ? this.close() : this.open(); }

  /** Called each time the authoritative island list changes. */
  setIslands(islands: IslandDef[]): void {
    this.islands = islands;
    this._refreshIslandSelect();
  }

  /** Main render call — called from ClientApplication.renderFrame after renderWorld. */
  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.visible) return;

    const isl = this._selectedIsland();
    if (!isl) return;

    // Draw all layer polygons (dim non-active, highlight active)
    for (const layerDef of LAYERS) {
      const polys = this._getPolys(isl.id, layerDef.key);
      if (polys.length === 0) continue;

      const isActive = layerDef.key === this.activeLayerKey;
      ctx.save();
      ctx.globalAlpha = isActive ? 1.0 : 0.4;

      for (let pi = 0; pi < polys.length; pi++) {
        const poly = polys[pi];
        if (poly.length < 2) continue;
        const isActivePoly = isActive && pi === this.activePolyIdx;

        ctx.beginPath();
        for (let i = 0; i < poly.length; i++) {
          const sp = camera.worldToScreen(Vec2.from(isl.x + poly[i].x, isl.y + poly[i].y));
          if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
        }
        ctx.closePath();

        ctx.fillStyle   = layerDef.fill;
        ctx.fill();
        ctx.strokeStyle = isActivePoly ? '#fff' : layerDef.stroke;
        ctx.lineWidth   = isActivePoly ? 2 : 1;
        ctx.setLineDash(isActivePoly ? [] : [4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // Draw vertices for active layer / active polygon
    const isl2 = isl; // closure
    const activePoly = this._getActivePoly(isl.id);
    for (let vi = 0; vi < activePoly.length; vi++) {
      const pt = activePoly[vi];
      const sp = camera.worldToScreen(Vec2.from(isl2.x + pt.x, isl2.y + pt.y));
      const isHover = this.hoverVertex !== null &&
                      this.hoverVertex.polyIdx === this.activePolyIdx &&
                      this.hoverVertex.vertIdx === vi;

      ctx.save();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, isHover ? HOVER_RADIUS : VERTEX_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle   = isHover ? '#ffe066' : 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.strokeStyle = '#222';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      if (isHover) {
        // Coordinate label
        ctx.font      = '11px monospace';
        ctx.fillStyle = '#ffe066';
        ctx.fillText(`${Math.round(pt.x)}, ${Math.round(pt.y)}`, sp.x + 10, sp.y - 8);
      }
      ctx.restore();
    }

    // Add-mode ghost vertex
    if (this.editMode === 'add' && !this.dragging) {
      const cam = camera;
      const wp  = cam.screenToWorld(Vec2.from(this.mouseScreen.x, this.mouseScreen.y));
      const sp  = cam.worldToScreen(wp);
      ctx.save();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, VERTEX_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(100,220,255,0.7)';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1;
      ctx.stroke();
      ctx.restore();
    }

    // Vertex count badge
    ctx.save();
    ctx.font      = '12px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(
      `verts: ${activePoly.length}  |  island-local coords`,
      12, this.canvas.height - 12
    );
    ctx.restore();
  }

  destroy(): void {
    this.canvas.removeEventListener('mousemove',    this._onMouseMove);
    this.canvas.removeEventListener('mousedown',    this._onMouseDown);
    this.canvas.removeEventListener('mouseup',      this._onMouseUp);
    this.canvas.removeEventListener('contextmenu',  this._onCtxMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    this.panel.remove();
    this.styleEl.remove();
  }

  // ── Island / layer helpers ────────────────────────────────────────────────

  private _selectedIsland(): IslandDef | null {
    if (this.selectedIslandId === null) return null;
    return this.islands.find(i => i.id === this.selectedIslandId) ?? null;
  }

  private _layerKey(islandId: number, layer: LayerKey): string {
    return `${islandId}:${layer}`;
  }

  private _getPolys(islandId: number, layer: LayerKey): Pt[][] {
    return this.layerData.get(this._layerKey(islandId, layer)) ?? [];
  }

  private _setPolys(islandId: number, layer: LayerKey, polys: Pt[][]): void {
    this.layerData.set(this._layerKey(islandId, layer), polys);
  }

  private _getActivePoly(islandId: number): Pt[] {
    const polys = this._getPolys(islandId, this.activeLayerKey);
    return polys[this.activePolyIdx] ?? [];
  }

  private _setActivePoly(islandId: number, poly: Pt[]): void {
    const polys = this._getPolys(islandId, this.activeLayerKey);
    while (polys.length <= this.activePolyIdx) polys.push([]);
    polys[this.activePolyIdx] = poly;
    this._setPolys(islandId, this.activeLayerKey, polys);
  }

  /** Bootstrap a fresh island — load outerSand from server verts, others empty. */
  private selectIsland(id: number): void {
    this.selectedIslandId = id;
    this.activePolyIdx = 0;

    const isl = this._selectedIsland();
    if (!isl) return;

    // Seed outerSand from server vertices (world → island-local)
    if (isl.vertices && !this.layerData.has(this._layerKey(id, 'outerSand'))) {
      const local = isl.vertices.map(v => ({ x: v.x - isl.x, y: v.y - isl.y }));
      this._setPolys(id, 'outerSand', [local]);
    }

    // Ensure other layers have at least one empty polygon slot
    for (const lk of ['innerGrass', 'waterZone', 'sandPatch'] as LayerKey[]) {
      if (!this.layerData.has(this._layerKey(id, lk))) {
        this._setPolys(id, lk, [[]]);
      }
    }

    this._refreshIslandSelect();
    this._refreshPolySelect(id);

    // Update island select value
    if (this.islandSelect) {
      this.islandSelect.value = String(id);
    }
  }

  // ── Mouse event handling ──────────────────────────────────────────────────

  private _bindEvents(): void {
    this._onMouseMove = (e: MouseEvent) => {
      if (!this.visible) return;
      const rect = this.canvas.getBoundingClientRect();
      this.mouseScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      const isl = this._selectedIsland();
      if (!isl) return;

      if (this.dragging) {
        // Move dragged vertex
        e.stopPropagation();
        const wp  = this.getCamera().screenToWorld(Vec2.from(this.mouseScreen.x, this.mouseScreen.y));
        const lx  = wp.x - isl.x;
        const ly  = wp.y - isl.y;
        const poly = [...this._getActivePoly(isl.id)];
        poly[this.dragging.vertIdx] = { x: lx, y: ly };
        this._setActivePoly(isl.id, poly);
        this._updateCoordsDisplay(lx, ly);
        return;
      }

      // Update hover state
      this._updateHover(isl);
    };

    this._onMouseDown = (e: MouseEvent) => {
      if (!this.visible) return;
      const isl = this._selectedIsland();
      if (!isl) return;

      const rect = this.canvas.getBoundingClientRect();
      this.mouseScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      if (e.button === 2) return; // handled by contextmenu

      if (this.editMode === 'move') {
        const hit = this._hitTest(isl);
        if (hit) {
          e.stopPropagation();
          this.dragging = hit;
        }
      } else if (this.editMode === 'add') {
        e.stopPropagation();
        const wp  = this.getCamera().screenToWorld(Vec2.from(this.mouseScreen.x, this.mouseScreen.y));
        const lx  = wp.x - isl.x;
        const ly  = wp.y - isl.y;
        const poly = [...this._getActivePoly(isl.id)];
        poly.push({ x: lx, y: ly });
        this._setActivePoly(isl.id, poly);
        this._refreshPolySelect(isl.id);
      }
    };

    this._onMouseUp = (e: MouseEvent) => {
      if (!this.visible) return;
      if (this.dragging) {
        e.stopPropagation();
        this.dragging = null;
      }
    };

    this._onCtxMenu = (e: MouseEvent) => {
      if (!this.visible) return;
      e.preventDefault();
      e.stopPropagation();

      const isl = this._selectedIsland();
      if (!isl) return;
      const rect = this.canvas.getBoundingClientRect();
      this.mouseScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      const hit = this._hitTest(isl);
      if (hit) {
        const poly = [...this._getActivePoly(isl.id)];
        poly.splice(hit.vertIdx, 1);
        this._setActivePoly(isl.id, poly);
        this.hoverVertex = null;
      }
    };

    this._onKeyDown = (e: KeyboardEvent) => {
      if (!this.visible) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!this.hoverVertex) return;
        const isl = this._selectedIsland();
        if (!isl) return;
        const poly = [...this._getActivePoly(isl.id)];
        poly.splice(this.hoverVertex.vertIdx, 1);
        this._setActivePoly(isl.id, poly);
        this.hoverVertex = null;
        e.stopPropagation();
      }
    };

    this.canvas.addEventListener('mousemove',   this._onMouseMove,   { passive: true });
    this.canvas.addEventListener('mousedown',   this._onMouseDown);
    this.canvas.addEventListener('mouseup',     this._onMouseUp);
    this.canvas.addEventListener('contextmenu', this._onCtxMenu);
    window.addEventListener('keydown', this._onKeyDown);
  }

  private _hitTest(isl: IslandDef): { polyIdx: number; vertIdx: number } | null {
    const camera = this.getCamera();
    const polys  = this._getPolys(isl.id, this.activeLayerKey);

    // Only test active poly for move/delete
    const poly = polys[this.activePolyIdx];
    if (!poly) return null;

    for (let vi = 0; vi < poly.length; vi++) {
      const sp = camera.worldToScreen(Vec2.from(isl.x + poly[vi].x, isl.y + poly[vi].y));
      const dx = sp.x - this.mouseScreen.x;
      const dy = sp.y - this.mouseScreen.y;
      if (dx * dx + dy * dy <= SNAP_DIST_PX * SNAP_DIST_PX) {
        return { polyIdx: this.activePolyIdx, vertIdx: vi };
      }
    }
    return null;
  }

  private _updateHover(isl: IslandDef): void {
    const hit = this._hitTest(isl);
    this.hoverVertex = hit;
    if (hit) {
      const poly = this._getPolys(isl.id, this.activeLayerKey)[hit.polyIdx];
      if (poly) this._updateCoordsDisplay(poly[hit.vertIdx].x, poly[hit.vertIdx].y);
    } else {
      const wp = this.getCamera().screenToWorld(Vec2.from(this.mouseScreen.x, this.mouseScreen.y));
      this._updateCoordsDisplay(wp.x - isl.x, wp.y - isl.y);
    }
  }

  private _updateCoordsDisplay(lx: number, ly: number): void {
    if (this.coordsEl) {
      this.coordsEl.textContent = `x: ${Math.round(lx)},  y: ${Math.round(ly)}`;
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  private _exportToClipboard(): void {
    const isl = this._selectedIsland();
    if (!isl) return;

    const fmtPts = (pts: Pt[]) =>
      '[\n' + pts.map(p => `      { x: ${Math.round(p.x)}, y: ${Math.round(p.y)} }`).join(',\n') + '\n    ]';

    const outerSand  = this._getPolys(isl.id, 'outerSand')[0]  ?? [];
    const innerGrass = this._getPolys(isl.id, 'innerGrass')[0] ?? [];
    const waterZones = this._getPolys(isl.id, 'waterZone').filter(p => p.length > 0);
    const sandPatches= this._getPolys(isl.id, 'sandPatch').filter(p => p.length > 0);

    const out = [
      `// Island ${isl.id} — exported from IslandEditor`,
      `// Island centre: (${isl.x}, ${isl.y})`,
      `// All coordinates are island-local (world − island centre)`,
      ``,
      `const island${isl.id}Visual = {`,
      `  outerSand: ${fmtPts(outerSand)},`,
      `  innerGrass: ${fmtPts(innerGrass)},`,
      `  waterZones: [`,
      ...waterZones.map((z, i) =>
        `    { id: "zone-${i}", points: ${fmtPts(z)} },`),
      `  ],`,
      `  sandPatches: [`,
      ...sandPatches.map((p, i) =>
        `    { id: "patch-${i}", outer: ${fmtPts(p)}, holes: [] },`),
      `  ],`,
      `};`,
    ].join('\n');

    navigator.clipboard.writeText(out).then(() => {
      alert(`✅ Island ${isl.id} schema copied to clipboard!`);
    }).catch(() => {
      // fallback: open text in new tab
      const w = window.open('', '_blank');
      if (w) { w.document.write(`<pre>${out}</pre>`); w.document.close(); }
    });
  }

  // ── Panel UI ──────────────────────────────────────────────────────────────

  private _buildStyles(): void {
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = /* css */`
      #island-editor-panel {
        position: fixed;
        top: 60px;
        left: 12px;
        width: 220px;
        display: none;
        flex-direction: column;
        gap: 6px;
        z-index: 1000;
        background: rgba(12, 20, 30, 0.92);
        border: 1px solid rgba(245,200,66,0.4);
        border-radius: 6px;
        padding: 10px;
        font-family: 'Courier New', monospace;
        font-size: 12px;
        color: #e8d59a;
        pointer-events: all;
        user-select: none;
      }
      #island-editor-panel h3 {
        margin: 0 0 4px;
        font-size: 13px;
        color: #f5c842;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      #island-editor-panel label {
        color: rgba(232,213,154,0.65);
        font-size: 11px;
        margin-bottom: 2px;
        display: block;
      }
      #island-editor-panel select {
        width: 100%;
        background: rgba(0,0,0,0.5);
        color: #e8d59a;
        border: 1px solid rgba(245,200,66,0.3);
        border-radius: 3px;
        padding: 3px 5px;
        font-family: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .ie-btn-row {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .ie-btn {
        flex: 1;
        background: rgba(30,30,40,0.8);
        color: #c8c0a8;
        border: 1px solid rgba(245,200,66,0.25);
        border-radius: 3px;
        padding: 4px 6px;
        font-family: inherit;
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.1s;
      }
      .ie-btn:hover { background: rgba(245,200,66,0.15); }
      .ie-btn.active {
        background: rgba(245,200,66,0.25);
        color: #f5c842;
        border-color: rgba(245,200,66,0.6);
      }
      .ie-btn-close {
        background: none;
        border: none;
        color: rgba(232,213,154,0.5);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0 2px;
      }
      .ie-btn-close:hover { color: #f5c842; }
      .ie-separator {
        border: none;
        border-top: 1px solid rgba(245,200,66,0.15);
        margin: 2px 0;
      }
      #ie-coords {
        color: rgba(232,213,154,0.6);
        font-size: 11px;
        min-height: 14px;
      }
      .ie-btn-export {
        width: 100%;
        background: rgba(50,120,50,0.6);
        color: #b8e8a0;
        border: 1px solid rgba(100,200,80,0.4);
        border-radius: 3px;
        padding: 5px 8px;
        font-family: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .ie-btn-export:hover { background: rgba(60,160,60,0.7); }
    `;
    document.head.appendChild(this.styleEl);
  }

  private _buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.id = 'island-editor-panel';
    document.body.appendChild(this.panel);

    // Header
    const header = document.createElement('h3');
    header.innerHTML = '🏝 Island Editor';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ie-btn-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => this.close();
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    // Island selector
    const islLabel = document.createElement('label');
    islLabel.textContent = 'Island';
    this.panel.appendChild(islLabel);
    this.islandSelect = document.createElement('select');
    this.islandSelect.onchange = () => {
      const id = parseInt(this.islandSelect.value, 10);
      if (!isNaN(id)) this.selectIsland(id);
    };
    this.panel.appendChild(this.islandSelect);

    // Separator
    const sep1 = document.createElement('hr');
    sep1.className = 'ie-separator';
    this.panel.appendChild(sep1);

    // Layer buttons
    const layerLabel = document.createElement('label');
    layerLabel.textContent = 'Layer';
    this.panel.appendChild(layerLabel);
    const layerRow = document.createElement('div');
    layerRow.className = 'ie-btn-row';
    for (const ld of LAYERS) {
      const btn = document.createElement('button');
      btn.className = 'ie-btn' + (ld.key === this.activeLayerKey ? ' active' : '');
      btn.title = ld.label;
      // short label
      const shortLabels: Record<LayerKey, string> = {
        outerSand: 'Sand', innerGrass: 'Grass', waterZone: 'Water', sandPatch: 'Patch'
      };
      btn.textContent = shortLabels[ld.key];
      btn.onclick = () => this._selectLayer(ld.key);
      this.layerBtns.set(ld.key, btn);
      layerRow.appendChild(btn);
    }
    this.panel.appendChild(layerRow);

    // Polygon selector (for multi-polygon layers)
    const polyLabel = document.createElement('label');
    polyLabel.textContent = 'Polygon';
    this.panel.appendChild(polyLabel);
    const polyRow = document.createElement('div');
    polyRow.style.display = 'flex';
    polyRow.style.gap = '4px';
    this.polySelect = document.createElement('select');
    this.polySelect.style.flex = '1';
    this.polySelect.onchange = () => {
      const idx = parseInt(this.polySelect.value, 10);
      if (!isNaN(idx)) { this.activePolyIdx = idx; }
    };
    polyRow.appendChild(this.polySelect);
    const addPolyBtn = document.createElement('button');
    addPolyBtn.className = 'ie-btn';
    addPolyBtn.textContent = '+';
    addPolyBtn.title = 'Add new polygon';
    addPolyBtn.onclick = () => this._addPolygon();
    polyRow.appendChild(addPolyBtn);
    const delPolyBtn = document.createElement('button');
    delPolyBtn.className = 'ie-btn';
    delPolyBtn.textContent = '–';
    delPolyBtn.title = 'Delete active polygon';
    delPolyBtn.style.color = '#e87070';
    delPolyBtn.onclick = () => this._deletePolygon();
    polyRow.appendChild(delPolyBtn);
    this.panel.appendChild(polyRow);

    // Separator
    const sep2 = document.createElement('hr');
    sep2.className = 'ie-separator';
    this.panel.appendChild(sep2);

    // Edit mode
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Mode';
    this.panel.appendChild(modeLabel);
    const modeRow = document.createElement('div');
    modeRow.className = 'ie-btn-row';
    const modeOptions: { key: EditMode; label: string; hint: string }[] = [
      { key: 'move', label: '✥ Move',   hint: 'Drag vertices. Right-click to delete.' },
      { key: 'add',  label: '+ Add',    hint: 'Click to append vertices.' },
    ];
    for (const m of modeOptions) {
      const btn = document.createElement('button');
      btn.className = 'ie-btn' + (m.key === this.editMode ? ' active' : '');
      btn.textContent = m.label;
      btn.title = m.hint;
      btn.onclick = () => this._selectMode(m.key);
      this.modeBtns.set(m.key, btn);
      modeRow.appendChild(btn);
    }
    this.panel.appendChild(modeRow);

    // Separator
    const sep3 = document.createElement('hr');
    sep3.className = 'ie-separator';
    this.panel.appendChild(sep3);

    // Coordinates display
    const coordLabel = document.createElement('label');
    coordLabel.textContent = 'Cursor (island-local)';
    this.panel.appendChild(coordLabel);
    this.coordsEl = document.createElement('span');
    this.coordsEl.id = 'ie-coords';
    this.coordsEl.textContent = '—';
    this.panel.appendChild(this.coordsEl);

    // Export button
    const sep4 = document.createElement('hr');
    sep4.className = 'ie-separator';
    this.panel.appendChild(sep4);
    const exportBtn = document.createElement('button');
    exportBtn.className = 'ie-btn-export';
    exportBtn.textContent = '📋 Copy Schema';
    exportBtn.title = 'Export island visual schema to clipboard';
    exportBtn.onclick = () => this._exportToClipboard();
    this.panel.appendChild(exportBtn);

    // Clear active polygon
    const clearBtn = document.createElement('button');
    clearBtn.className = 'ie-btn';
    clearBtn.style.width = '100%';
    clearBtn.style.color = '#e87070';
    clearBtn.style.marginTop = '4px';
    clearBtn.textContent = '🗑 Clear Polygon';
    clearBtn.onclick = () => {
      const isl = this._selectedIsland();
      if (!isl) return;
      this._setActivePoly(isl.id, []);
    };
    this.panel.appendChild(clearBtn);
  }

  // ── Panel helpers ─────────────────────────────────────────────────────────

  private _refreshIslandSelect(): void {
    const prev = this.islandSelect.value;
    this.islandSelect.innerHTML = '';
    if (this.islands.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '— no islands —';
      opt.disabled = true;
      this.islandSelect.appendChild(opt);
      return;
    }
    for (const isl of this.islands) {
      const opt = document.createElement('option');
      opt.value = String(isl.id);
      opt.textContent = `Island ${isl.id}  (${Math.round(isl.x)}, ${Math.round(isl.y)})`;
      this.islandSelect.appendChild(opt);
    }
    if (prev) this.islandSelect.value = prev;
    else if (this.selectedIslandId !== null) this.islandSelect.value = String(this.selectedIslandId);
  }

  private _refreshPolySelect(islandId: number): void {
    const polys = this._getPolys(islandId, this.activeLayerKey);
    this.polySelect.innerHTML = '';
    for (let i = 0; i < polys.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Poly ${i}  (${polys[i].length} verts)`;
      this.polySelect.appendChild(opt);
    }
    this.polySelect.value = String(Math.min(this.activePolyIdx, polys.length - 1));

    // Hide poly controls for single-polygon layers
    const ld = LAYERS.find(l => l.key === this.activeLayerKey);
    this.polySelect.parentElement!.style.display = ld?.multi ? 'flex' : 'none';
  }

  private _selectLayer(key: LayerKey): void {
    this.activeLayerKey = key;
    this.activePolyIdx  = 0;
    this.layerBtns.forEach((btn, k) => btn.classList.toggle('active', k === key));
    const isl = this._selectedIsland();
    if (isl) this._refreshPolySelect(isl.id);
  }

  private _selectMode(mode: EditMode): void {
    this.editMode = mode;
    this.modeBtns.forEach((btn, k) => btn.classList.toggle('active', k === mode));
  }

  private _addPolygon(): void {
    const isl = this._selectedIsland();
    if (!isl) return;
    const ld = LAYERS.find(l => l.key === this.activeLayerKey);
    if (!ld?.multi) return;
    const polys = [...this._getPolys(isl.id, this.activeLayerKey), []];
    this._setPolys(isl.id, this.activeLayerKey, polys);
    this.activePolyIdx = polys.length - 1;
    this._refreshPolySelect(isl.id);
  }

  private _deletePolygon(): void {
    const isl = this._selectedIsland();
    if (!isl) return;
    const ld = LAYERS.find(l => l.key === this.activeLayerKey);
    if (!ld?.multi) return;
    const polys = this._getPolys(isl.id, this.activeLayerKey);
    if (polys.length <= 1) { polys[0] = []; this._setPolys(isl.id, this.activeLayerKey, polys); }
    else {
      polys.splice(this.activePolyIdx, 1);
      this.activePolyIdx = Math.max(0, this.activePolyIdx - 1);
      this._setPolys(isl.id, this.activeLayerKey, polys);
    }
    this._refreshPolySelect(isl.id);
  }
}
