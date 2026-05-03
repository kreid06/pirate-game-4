/**
 * island-editor-main.ts — Standalone Island Editor
 *
 * Self-contained entry point for the island editor dev tool.
 * No game client dependencies — all island data is embedded.
 *
 * Controls:
 *   LMB (add mode)       — place vertex
 *   LMB drag (move mode) — drag vertex
 *   RMB / Del            — delete vertex
 *   Middle-drag / Alt+drag — pan
 *   Scroll               — zoom
 */

// ── Types ──────────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };
type EditMode = 'move' | 'add';
type LayerKey = 'islandShape' | 'outerSand' | 'innerGrass' | 'outerShallow' | 'waterZone' | 'sandPatch' | 'stoneZone' | 'metalZone';

interface LayerDef {
  key: LayerKey;
  label: string;
  fill: string;
  stroke: string;
  multi: boolean;
}

interface IslandData {
  id: number;
  name: string;
  cx: number;
  cy: number;
  outerVerts?: Pt[];
  circleRadius?: number;
  grassPolyScale?: number;   // grass polygon = outerVerts scaled by this toward centre (default 0.82)
  sandVerts?: Pt[];          // explicit sand polygon (overrides outerVerts for sand layer)
  grassVerts?: Pt[];         // explicit grass polygon (overrides scale calculation)
  shallowVerts?: Pt[];       // explicit shallow water polygon (outer boundary of shallow zone)
}

// ── Layer definitions ──────────────────────────────────────────────────────────

const LAYERS: LayerDef[] = [
  { key: 'islandShape',  label: '🗺 Shape',   fill: 'rgba(160,128,64,0.25)',  stroke: '#f5c842', multi: false },
  { key: 'outerSand',    label: '🏖 Sand',    fill: 'rgba(214,194,139,0.35)', stroke: '#d6c28b', multi: false },
  { key: 'innerGrass',   label: '🌿 Grass',   fill: 'rgba(79,127,54,0.35)',   stroke: '#4f7f36', multi: false },
  { key: 'outerShallow', label: '🌊 Shallow', fill: 'rgba(30,144,255,0.20)',  stroke: '#3abaff', multi: false },
  { key: 'waterZone',    label: '💧 Water',   fill: 'rgba(30,144,255,0.35)',  stroke: '#1e8fff', multi: true  },
  { key: 'sandPatch',    label: '🏝 Patch',   fill: 'rgba(200,180,100,0.35)', stroke: '#c8b464', multi: true  },
  { key: 'stoneZone',    label: '⛰ Stone',   fill: 'rgba(130,100,70,0.40)',  stroke: '#a07840', multi: false },
  { key: 'metalZone',    label: '⚙ Metal',   fill: 'rgba(70,110,140,0.40)',  stroke: '#5090b0', multi: false },
];

const VERTEX_RADIUS = 6;
const HOVER_RADIUS  = 9;
const SNAP_DIST_PX  = 14;

// ── Hardcoded island data (from island_data.c) ─────────────────────────────────

function makeIsland3Verts(): Pt[] {
  // Shape uses the same 70 verts as sand (authoritative outline)
  const vx = [ -3152, -1494, -296, 1457, 2926, 4400, 4900, 5000, 4700, 4100, 3100, 3203, 3100, 2932, 2521, 1743, 1061, 550, 248, 865, 1400, 1682, 1756, 2161, 2695, 2879, 2916, 2566, 2179, 1719, 1498, 1166, 835, 319, -252, -879, -1321, -1560, -1855, -2279, -2610, -2518, -2703, -3108, -3495, -3955, -4250, -4176, -3661, -3163, -2629, -2239, -2058, -1560, -961, -1050, -1443, -1991, -2673, -3509, -4133, -4549, -4734, -4865, -5215, -5049, -4914, -5088, -4867, -4203 ];
  const vy = [ -3490, -3877, -4116, -3811, -2798, -1600, -200, 700, 1300, 1800, 2200, 2531, 2800, 3250, 3514, 3721, 3826, 3866, 3289, 2594, 2200, 1649, 1041, 1612, 1686, 1170, 875, 507, 378, 323, -285, -599, -1041, -1464, -1501, -1409, -783, -120, 396, 525, 267, -120, -267, -304, -9, 83, 488, 1004, 1152, 1152, 1115, 1561, 2268, 2859, 3321, 3787, 3944, 3640, 3382, 3381, 3358, 3058, 2665, 2111, 1392, 342, -652, -1373, -2552, -3160 ];
  return vx.map((x, i) => ({ x, y: vy[i] }));
}

function makeIsland2Verts(): Pt[] {
  const vx = [
       0,  800, 1600, 2300, 2750, 2950, 3100, 2900,
    2550, 1950, 1250,  500,  250,  100,    0, -100,
    -350,-1050,-1850,-2450,-2850,-2950,-3100,-2900,
   -2550,-1950,-1250, -500,
  ];
  const vy = [
    -3000,-2850,-2650,-2250,-1450, -500,  400, 1200,
     2050, 2600, 2900, 3050, 2450, 1850, 1650, 1850,
     2450, 2950, 2650, 2150, 1450,  500, -400,-1250,
    -2050,-2550,-2800,-2950,
  ];
  return vx.map((x, i) => ({ x, y: vy[i] }));
}

function makeIsland3SandVerts(): Pt[] {
  const vx = [ -3152, -1494, -296, 1457, 2926, 4400, 4900, 5000, 4700, 4100, 3100, 3203, 3100, 2932, 2521, 1743, 1061, 550, 248, 865, 1400, 1682, 1756, 2161, 2695, 2879, 2916, 2566, 2179, 1719, 1498, 1166, 835, 319, -252, -879, -1321, -1560, -1855, -2279, -2610, -2518, -2703, -3108, -3495, -3955, -4250, -4176, -3661, -3163, -2629, -2239, -2058, -1560, -961, -1050, -1443, -1991, -2673, -3509, -4133, -4549, -4734, -4865, -5215, -5049, -4914, -5088, -4867, -4203 ];
  const vy = [ -3490, -3877, -4116, -3811, -2798, -1600, -200, 700, 1300, 1800, 2200, 2531, 2800, 3250, 3514, 3721, 3826, 3866, 3289, 2594, 2200, 1649, 1041, 1612, 1686, 1170, 875, 507, 378, 323, -285, -599, -1041, -1464, -1501, -1409, -783, -120, 396, 525, 267, -120, -267, -304, -9, 83, 488, 1004, 1152, 1152, 1115, 1561, 2268, 2859, 3321, 3787, 3944, 3640, 3382, 3381, 3358, 3058, 2665, 2111, 1392, 342, -652, -1373, -2552, -3160 ];
  return vx.map((x, i) => ({ x, y: vy[i] }));
}

function makeIsland3GrassVerts(): Pt[] {
  const vx = [ -2536, -1357, -197, 927, 2511, 3799, 4518, 4504, 4078, 3490, 3167, 2800, 2594, 2447, 1977, 1596, 1023, 773, 949, 1170, 1478, 1610, 1875, 2124, 2712, 3329, 3255, 2932, 2286, 2183, 2036, 1508, 803, 156, -446, -1048, -1488, -1738, -1812, -2105, -2281, -2179, -2370, -2732, -3171, -4118, -4442, -4141, -3605, -3145, -2666, -2555, -2224, -1892, -1407, -1395, -1929, -2739, -3071, -3800, -4268, -4821, -4692, -4158, -3679, -3476, -3568 ];
  const vy = [ -3184, -3405, -3498, -3019, -2411, -1386, -109, 596, 1213, 1654, 2006, 2153, 2535, 3005, 3152, 3313, 3401, 3166, 2946, 2711, 2564, 2153, 1683, 1844, 1830, 1316, 758, 185, 141, -21, -447, -990, -1372, -1842, -1886, -1592, -1137, -373, -35, 244, 156, -94, -344, -593, -501, 31, 562, 1325, 1428, 1446, 1520, 1888, 2441, 2883, 3228, 3454, 3362, 3104, 2920, 2592, 1925, 1225, 175, -661, -1121, -1784, -2724 ];
  return vx.map((x, i) => ({ x, y: vy[i] }));
}

let ISLANDS: IslandData[] = [
  { id: 1, name: 'Island 1 — Tropical',      cx:  800,  cy:  600,  circleRadius: 185, grassPolyScale: 148/185 },
  { id: 2, name: 'Island 2 — Continental',    cx: 6000,  cy: 5000,  outerVerts: makeIsland2Verts(), grassPolyScale: 0.82 },
  { id: 3, name: 'Island 3 — Crescent Cove',  cx: -2500, cy: 2500,  outerVerts: makeIsland3Verts(), grassPolyScale: 0.82,
    sandVerts: makeIsland3SandVerts(), grassVerts: makeIsland3GrassVerts() },
];

// ── Camera ─────────────────────────────────────────────────────────────────────

class Camera {
  x = 0; y = 0; zoom = 1;

  w2s(wx: number, wy: number, cw: number, ch: number): Pt {
    return { x: (wx - this.x) * this.zoom + cw / 2, y: (wy - this.y) * this.zoom + ch / 2 };
  }
  s2w(sx: number, sy: number, cw: number, ch: number): Pt {
    return { x: (sx - cw / 2) / this.zoom + this.x, y: (sy - ch / 2) / this.zoom + this.y };
  }
  centreOn(wx: number, wy: number): void { this.x = wx; this.y = wy; }
}

const cam = new Camera();

// ── Editor state ───────────────────────────────────────────────────────────────

let selectedIslandIdx = 0;
let activeLayerKey: LayerKey = 'islandShape';
let activePolyIdx = 0;
let editMode: EditMode = 'move';
let snapGrid = 0;
let showGrid = true;

// ── Sub-island (islet) state ───────────────────────────────────────────────────

interface SubIslandEntry { id: number; sandVerts: Pt[]; grassVerts: Pt[]; }
const subIslandsMap = new Map<number, SubIslandEntry[]>();
let activeSubIslandIdx: number | null = null;
let nextSubIslandId = 1;

function getSubIslands(islandId: number): SubIslandEntry[] {
  if (!subIslandsMap.has(islandId)) subIslandsMap.set(islandId, []);
  return subIslandsMap.get(islandId)!;
}

/** Key: `${islandId}:${layerKey}` → Pt[][] */
const layerData = new Map<string, Pt[][]>();

function dataKey(islandId: number, layer: LayerKey): string {
  return `${islandId}:${layer}`;
}

function generateShallowFromSand(sandPoly: Pt[]): Pt[] {
  return sandPoly.map(v => ({ ...v }));
}

function getPolys(islandId: number, layer: LayerKey): Pt[][] {
  const k = dataKey(islandId, layer);
  if (!layerData.has(k)) {
    const isl = ISLANDS.find(i => i.id === islandId);
    if (layer === 'islandShape' || layer === 'outerSand') {
      const verts = layer === 'outerSand' && isl?.sandVerts
        ? isl.sandVerts
        : isl?.outerVerts;
      layerData.set(k, verts ? [verts.map(v => ({ ...v }))] : [[]]);
    } else if (layer === 'innerGrass') {
      if (isl?.grassVerts) {
        layerData.set(k, [isl.grassVerts.map(v => ({ ...v }))]);
      } else {
        const scale = isl?.grassPolyScale ?? 0.82;
        const verts = isl?.outerVerts?.map(v => ({ x: v.x * scale, y: v.y * scale })) ?? [];
        layerData.set(k, verts.length ? [verts] : [[]]);
      }
    } else if (layer === 'outerShallow') {
      if (isl?.shallowVerts) {
        layerData.set(k, [isl.shallowVerts.map(v => ({ ...v }))]);
      } else {
        const sandKey = dataKey(islandId, 'outerSand');
        if (!layerData.has(sandKey)) getPolys(islandId, 'outerSand');
        const sandPoly = layerData.get(sandKey)?.[0] ?? [];
        layerData.set(k, sandPoly.length ? [generateShallowFromSand(sandPoly)] : [[]]);
      }
    } else {
      layerData.set(k, [[]]);
    }
  }
  return layerData.get(k)!;
}
function getActivePoly(): Pt[] {
  // Sub-island mode: Sand layer → sub sandVerts, Grass → sub grassVerts
  if (activeSubIslandIdx !== null) {
    const isl  = ISLANDS[selectedIslandIdx];
    const sub  = getSubIslands(isl.id)[activeSubIslandIdx];
    if (!sub) return [];
    return activeLayerKey === 'innerGrass' ? sub.grassVerts : sub.sandVerts;
  }
  const isl   = ISLANDS[selectedIslandIdx];
  const polys = getPolys(isl.id, activeLayerKey);
  while (polys.length <= activePolyIdx) polys.push([]);
  return polys[activePolyIdx];
}

// ── Canvas setup ───────────────────────────────────────────────────────────────

const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
const ctx    = canvas.getContext('2d')!;
const wrap   = document.getElementById('canvas-wrap') as HTMLDivElement;

function resizeCanvas(): void {
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
new ResizeObserver(resizeCanvas).observe(wrap);
resizeCanvas();

function w2s(wx: number, wy: number): Pt { return cam.w2s(wx, wy, canvas.width, canvas.height); }
function s2w(sx: number, sy: number): Pt { return cam.s2w(sx, sy, canvas.width, canvas.height); }

// ── Input state ────────────────────────────────────────────────────────────────

let mouseWorld: Pt | null = null;
let hoverVi: number | null = null;
let dragging: { vi: number } | null = null;
let panning = false;
let panStart: Pt | null = null;
let panCamStart: Pt | null = null;

function snap(pt: Pt): Pt {
  if (snapGrid <= 0) return pt;
  return { x: Math.round(pt.x / snapGrid) * snapGrid, y: Math.round(pt.y / snapGrid) * snapGrid };
}

function findNearestVert(sx: number, sy: number): number | null {
  const isl  = ISLANDS[selectedIslandIdx];
  const poly = getActivePoly();
  let best = -1, bestD2 = SNAP_DIST_PX * SNAP_DIST_PX;
  for (let vi = 0; vi < poly.length; vi++) {
    const sp = w2s(isl.cx + poly[vi].x, isl.cy + poly[vi].y);
    const d2 = (sp.x - sx) ** 2 + (sp.y - sy) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = vi; }
  }
  return best === -1 ? null : best;
}

/**
 * Returns the index to splice a new point into `poly` so it sits on the
 * closest edge.  The point is in island-local space; cx/cy are the island
 * world-centre (needed to project into screen space for distance calc).
 * Inserts AFTER the edge start, i.e. splice(result, 0, pt).
 */
function nearestEdgeInsertIdx(poly: Pt[], localPt: Pt, cx: number, cy: number): number {
  // Project the new point to screen space for a consistent distance metric
  const sp = w2s(cx + localPt.x, cy + localPt.y);

  let bestIdx  = poly.length; // fallback: append
  let bestDist = Infinity;

  for (let i = 0; i < poly.length; i++) {
    const j  = (i + 1) % poly.length;
    const ax = w2s(cx + poly[i].x, cy + poly[i].y);
    const bx = w2s(cx + poly[j].x, cy + poly[j].y);

    // Squared distance from sp to segment ax→bx
    const dx = bx.x - ax.x, dy = bx.y - ax.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((sp.x - ax.x) * dx + (sp.y - ax.y) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const nearX = ax.x + t * dx, nearY = ax.y + t * dy;
    const dist  = (sp.x - nearX) ** 2 + (sp.y - nearY) ** 2;

    if (dist < bestDist) { bestDist = dist; bestIdx = j; }
  }

  return bestIdx;
}

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  mouseWorld = s2w(sx, sy);

  if (panning && panStart && panCamStart) {
    cam.x = panCamStart.x - (sx - panStart.x) / cam.zoom;
    cam.y = panCamStart.y - (sy - panStart.y) / cam.zoom;
    return;
  }

  if (dragging !== null) {
    const isl   = ISLANDS[selectedIslandIdx];
    const local = snap({ x: mouseWorld.x - isl.cx, y: mouseWorld.y - isl.cy });
    getActivePoly()[dragging.vi] = local;
    refreshVertCount();
    return;
  }

  hoverVi = findNearestVert(sx, sy);
  canvas.style.cursor = (hoverVi !== null && editMode === 'move') ? 'grab' : 'crosshair';
  updateCoords(mouseWorld);
});

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    panning = true; panStart = { x: sx, y: sy }; panCamStart = { x: cam.x, y: cam.y };
    e.preventDefault(); return;
  }
  if (e.button === 2) { const vi = findNearestVert(sx, sy); if (vi !== null) deleteVert(vi); return; }
  if (e.button !== 0) return;

  if (editMode === 'move') {
    const vi = findNearestVert(sx, sy);
    if (vi !== null) { dragging = { vi }; canvas.style.cursor = 'grabbing'; }
  } else {
    const isl   = ISLANDS[selectedIslandIdx];
    const world = s2w(sx, sy);
    const local = snap({ x: world.x - isl.cx, y: world.y - isl.cy });
    const poly  = getActivePoly();
    const insertAt = poly.length < 2 ? poly.length : nearestEdgeInsertIdx(poly, local, isl.cx, isl.cy);
    poly.splice(insertAt, 0, local);
    refreshVertCount();
    refreshPolySelect();
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (panning && (e.button === 1 || e.button === 0)) { panning = false; return; }
  if (dragging) { dragging = null; canvas.style.cursor = 'crosshair'; refreshVertCount(); }
});

canvas.addEventListener('mouseleave', () => { panning = false; dragging = null; mouseWorld = null; hoverVi = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const rect   = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const before = s2w(sx, sy);
  cam.zoom = Math.max(0.02, Math.min(20, cam.zoom * factor));
  const after  = s2w(sx, sy);
  cam.x -= after.x - before.x;
  cam.y -= after.y - before.y;
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && hoverVi !== null) {
    e.preventDefault(); deleteVert(hoverVi);
  }
});

function deleteVert(vi: number): void {
  const poly = getActivePoly();
  if (vi >= 0 && vi < poly.length) {
    poly.splice(vi, 1);
    hoverVi = null;
    refreshVertCount();
    refreshPolySelect();
  }
}

// ── Render loop ────────────────────────────────────────────────────────────────

function render(): void {
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Ocean
  ctx.fillStyle = '#0d2340';
  ctx.fillRect(0, 0, cw, ch);

  drawGrid();

  const isl = ISLANDS[selectedIslandIdx];

  // Circle island reference (Island 1)
  if (isl.circleRadius) {
    const sc = w2s(isl.cx, isl.cy);
    ctx.save(); ctx.globalAlpha = 0.10;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, isl.circleRadius * cam.zoom, 0, Math.PI * 2);
    ctx.fillStyle = '#a08040'; ctx.fill();
    ctx.restore();
  }

  // All layers (islandShape rendered first as the base)
  for (const ld of LAYERS) {
    const polys         = getPolys(isl.id, ld.key);
    const isActiveLayer = ld.key === activeLayerKey;

    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      if (poly.length < 2) continue;
      const isActivePoly = isActiveLayer && pi === activePolyIdx;

      ctx.save();
      // islandShape is always shown (faint when not active, normal when active)
      ctx.globalAlpha = isActiveLayer ? 1.0 : (ld.key === 'islandShape' ? 0.55 : 0.30);
      ctx.beginPath();
      poly.forEach((v, i) => {
        const s = w2s(isl.cx + v.x, isl.cy + v.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle   = ld.fill;
      ctx.fill();
      ctx.strokeStyle = isActivePoly ? '#ffffff' : ld.stroke;
      ctx.lineWidth   = isActivePoly ? 2 : 1;
      ctx.setLineDash(isActivePoly ? [] : (ld.key === 'islandShape' ? [] : [4, 4]));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // Vertices for active polygon — always show shape verts when shape layer is active
  const activePoly = getActivePoly();
  const activeLd   = LAYERS.find(l => l.key === activeLayerKey)!;

  for (let vi = 0; vi < activePoly.length; vi++) {
    const pt    = activePoly[vi];
    const sp    = w2s(isl.cx + pt.x, isl.cy + pt.y);
    const hover = hoverVi === vi;

    ctx.save();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, hover ? HOVER_RADIUS : VERTEX_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle   = hover ? '#ffe066' : 'rgba(255,255,255,0.85)';
    ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.font      = '10px Georgia, serif';
    ctx.fillStyle = hover ? '#ffe066' : 'rgba(255,255,255,0.45)';
    ctx.fillText(String(vi), sp.x + 9, sp.y - 6);

    if (hover) {
      ctx.font = '11px Georgia, serif'; ctx.fillStyle = '#ffe066';
      ctx.fillText(`(${Math.round(pt.x)}, ${Math.round(pt.y)})`, sp.x + 9, sp.y + 7);
    }
    ctx.restore();
  }

  // Ghost vertex + edge highlight in add mode
  if (editMode === 'add' && mouseWorld && !panning) {
    const isl2    = ISLANDS[selectedIslandIdx];
    const snapped = snap({ x: mouseWorld.x - isl2.cx, y: mouseWorld.y - isl2.cy });
    const sp      = w2s(isl2.cx + snapped.x, isl2.cy + snapped.y);

    // Highlight the edge that would be split
    const poly = getActivePoly();
    if (poly.length >= 2) {
      const insertAt = nearestEdgeInsertIdx(poly, snapped, isl2.cx, isl2.cy);
      const prevIdx  = (insertAt - 1 + poly.length) % poly.length;
      const a = w2s(isl2.cx + poly[prevIdx].x, isl2.cy + poly[prevIdx].y);
      const b = w2s(isl2.cx + poly[insertAt % poly.length].x, isl2.cy + poly[insertAt % poly.length].y);
      ctx.save();
      ctx.strokeStyle = activeLd.stroke; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.8;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Ghost dot
    ctx.save(); ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, VERTEX_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = activeLd.stroke; ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  // Sub-islands (islets)
  const subIsls = getSubIslands(isl.id);
  for (let si = 0; si < subIsls.length; si++) {
    const sub         = subIsls[si];
    const isActiveSub = activeSubIslandIdx === si;

    const drawSubPoly = (verts: Pt[], fill: string, stroke: string, isActiveLayer: boolean): void => {
      if (verts.length < 2) return;
      ctx.save();
      ctx.globalAlpha = isActiveSub ? 1.0 : 0.45;
      ctx.beginPath();
      verts.forEach((v, i) => {
        const s = w2s(isl.cx + v.x, isl.cy + v.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle   = fill; ctx.fill();
      ctx.strokeStyle = isActiveLayer ? '#ffffff' : stroke;
      ctx.lineWidth   = isActiveLayer ? 2 : 1;
      ctx.stroke();
      ctx.restore();
    };

    const sandActive  = isActiveSub && activeLayerKey !== 'innerGrass';
    const grassActive = isActiveSub && activeLayerKey === 'innerGrass';
    drawSubPoly(sub.sandVerts,  'rgba(214,194,139,0.40)', '#d6c28b', sandActive);
    drawSubPoly(sub.grassVerts, 'rgba(79,127,54,0.40)',   '#4f7f36', grassActive);

    // Islet label (centroid of sand)
    if (sub.sandVerts.length > 0) {
      const cx = sub.sandVerts.reduce((s, v) => s + v.x, 0) / sub.sandVerts.length;
      const cy = sub.sandVerts.reduce((s, v) => s + v.y, 0) / sub.sandVerts.length;
      const sc = w2s(isl.cx + cx, isl.cy + cy);
      ctx.save();
      ctx.font = '11px Georgia, serif';
      ctx.fillStyle = isActiveSub ? '#f5c842' : 'rgba(245,200,66,0.45)';
      ctx.textAlign = 'center';
      ctx.fillText(`islet ${si + 1}`, sc.x, sc.y + 4);
      ctx.restore();
    }

    // Vertices for active sub-island polygon
    if (isActiveSub) {
      const verts = activeLayerKey === 'innerGrass' ? sub.grassVerts : sub.sandVerts;
      for (let vi = 0; vi < verts.length; vi++) {
        const pt    = verts[vi];
        const sp    = w2s(isl.cx + pt.x, isl.cy + pt.y);
        const hover = hoverVi === vi;
        ctx.save();
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, hover ? HOVER_RADIUS : VERTEX_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle   = hover ? '#ffe066' : 'rgba(255,255,255,0.85)';
        ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.font = '10px Georgia, serif';
        ctx.fillStyle = hover ? '#ffe066' : 'rgba(255,255,255,0.45)';
        ctx.fillText(String(vi), sp.x + 9, sp.y - 6);
        if (hover) {
          ctx.font = '11px Georgia, serif'; ctx.fillStyle = '#ffe066';
          ctx.fillText(`(${Math.round(pt.x)}, ${Math.round(pt.y)})`, sp.x + 9, sp.y + 7);
        }
        ctx.restore();
      }
    }
  }

  // Sub-island mode HUD
  if (activeSubIslandIdx !== null) {
    ctx.save();
    ctx.font = 'bold 13px Georgia, serif';
    ctx.fillStyle = 'rgba(245,200,66,0.85)';
    ctx.fillText(`✏ Editing Islet ${activeSubIslandIdx + 1}  [${activeLayerKey === 'innerGrass' ? 'Grass' : 'Sand'}]`, 12, 22);
    ctx.restore();
  }

  // Centre crosshair
  {
    const sc = w2s(isl.cx, isl.cy);
    ctx.save(); ctx.strokeStyle = 'rgba(255,200,50,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sc.x - 8, sc.y); ctx.lineTo(sc.x + 8, sc.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sc.x, sc.y - 8); ctx.lineTo(sc.x, sc.y + 8); ctx.stroke();
    ctx.restore();
  }

  requestAnimationFrame(render);
}

function drawGrid(): void {
  if (!showGrid || snapGrid <= 0) return;
  const step = snapGrid * cam.zoom;
  if (step < 5) return;

  const tl    = s2w(0, 0);
  const startX = Math.floor(tl.x / snapGrid) * snapGrid;
  const startY = Math.floor(tl.y / snapGrid) * snapGrid;
  const cw = canvas.width, ch = canvas.height;

  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let wx = startX; w2s(wx, 0).x < cw + step; wx += snapGrid) {
    const sx = w2s(wx, 0).x; ctx.moveTo(sx, 0); ctx.lineTo(sx, ch);
  }
  for (let wy = startY; w2s(0, wy).y < ch + step; wy += snapGrid) {
    const sy = w2s(0, wy).y; ctx.moveTo(0, sy); ctx.lineTo(cw, sy);
  }
  ctx.stroke(); ctx.restore();
}

// ── Status ─────────────────────────────────────────────────────────────────────

const coordsEl    = document.getElementById('coords')!;
const vertCountEl = document.getElementById('vert-count')!;

function updateCoords(pt: Pt | null): void {
  if (!pt) { coordsEl.textContent = '—'; return; }
  const isl = ISLANDS[selectedIslandIdx];
  coordsEl.textContent =
    `world (${Math.round(pt.x)}, ${Math.round(pt.y)})  local (${Math.round(pt.x - isl.cx)}, ${Math.round(pt.y - isl.cy)})`;
}

function refreshVertCount(): void {
  vertCountEl.textContent = `verts: ${getActivePoly().length}`;
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

// Island selector
const islSelect = document.getElementById('isl-select') as HTMLSelectElement;
ISLANDS.forEach((isl, i) => {
  const opt = document.createElement('option');
  opt.value = String(i); opt.textContent = isl.name;
  islSelect.appendChild(opt);
});
islSelect.value = '0';
islSelect.addEventListener('change', () => {
  selectedIslandIdx = parseInt(islSelect.value);
  activePolyIdx = 0;
  activeLayerKey = 'islandShape';
  activeSubIslandIdx = null;
  layerBtnsEl.querySelectorAll('.btn').forEach((b, i) => {
    b.classList.toggle('active', LAYERS[i].key === activeLayerKey);
  });
  const isl = ISLANDS[selectedIslandIdx];
  cam.centreOn(isl.cx, isl.cy); cam.zoom = 0.12;
  refreshPolySelect(); refreshVertCount(); refreshSubIslandList();
  updateSubIslandUI();
});

// Layer buttons
const layerBtnsEl = document.getElementById('layer-btns')!;
LAYERS.forEach(ld => {
  const btn = document.createElement('button');
  btn.className = 'btn' + (ld.key === activeLayerKey ? ' active' : '');
  btn.textContent = ld.label;
  btn.addEventListener('click', () => {
    activeLayerKey = ld.key; activePolyIdx = 0;
    layerBtnsEl.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    refreshPolySelect(); refreshVertCount();
  });
  layerBtnsEl.appendChild(btn);
});

// Polygon selector
const polySection = document.getElementById('poly-section')!;
const polySelect  = document.getElementById('poly-select') as HTMLSelectElement;

function refreshPolySelect(): void {
  const isl  = ISLANDS[selectedIslandIdx];
  const ld   = LAYERS.find(l => l.key === activeLayerKey)!;
  // Hide poly selector in sub-island mode (always single polygon)
  if (activeSubIslandIdx !== null) { polySection.style.display = 'none'; return; }
  polySection.style.display = ld.multi ? '' : 'none';
  if (!ld.multi) return;

  const polys = getPolys(isl.id, activeLayerKey);
  polySelect.innerHTML = '';
  polys.forEach((poly, i) => {
    const opt = document.createElement('option');
    opt.value = String(i); opt.textContent = `Poly ${i + 1} (${poly.length} verts)`;
    polySelect.appendChild(opt);
  });
  activePolyIdx = Math.min(activePolyIdx, polys.length - 1);
  polySelect.value = String(activePolyIdx);
  refreshVertCount();
}

polySelect.addEventListener('change', () => { activePolyIdx = parseInt(polySelect.value) || 0; refreshVertCount(); });

document.getElementById('poly-add')!.addEventListener('click', () => {
  const isl   = ISLANDS[selectedIslandIdx];
  const polys = getPolys(isl.id, activeLayerKey);
  polys.push([]); activePolyIdx = polys.length - 1;
  refreshPolySelect();
});

document.getElementById('poly-del')!.addEventListener('click', () => {
  const isl   = ISLANDS[selectedIslandIdx];
  const polys = getPolys(isl.id, activeLayerKey);
  if (polys.length <= 1) { polys[0] = []; refreshPolySelect(); return; }
  polys.splice(activePolyIdx, 1);
  activePolyIdx = Math.max(0, activePolyIdx - 1);
  refreshPolySelect();
});

// Mode buttons
const modeBtnsEl = document.getElementById('mode-btns')!;
(['move', 'add'] as EditMode[]).forEach(m => {
  const btn = document.createElement('button');
  btn.className = 'btn' + (m === editMode ? ' active' : '');
  btn.textContent = m === 'move' ? '✥ Move' : '✚ Add';
  btn.addEventListener('click', () => {
    editMode = m;
    modeBtnsEl.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
  modeBtnsEl.appendChild(btn);
});

// Snap
const snapInput = document.getElementById('snap-input') as HTMLInputElement;
snapInput.addEventListener('input', () => { snapGrid = Math.max(0, parseInt(snapInput.value) || 0); });
const showGridChk = document.getElementById('show-grid') as HTMLInputElement;
showGridChk.addEventListener('change', () => { showGrid = showGridChk.checked; });

// Clear actions
document.getElementById('btn-clear-poly')!.addEventListener('click', () => {
  getActivePoly().length = 0; refreshVertCount();
});
document.getElementById('btn-clear-layer')!.addEventListener('click', () => {
  if (!confirm('Clear all polygons in this layer?')) return;
  const isl = ISLANDS[selectedIslandIdx];
  layerData.set(dataKey(isl.id, activeLayerKey), [[]]);
  activePolyIdx = 0; refreshPolySelect(); refreshVertCount();
});

document.getElementById('btn-sand-from-shape')!.addEventListener('click', () => {
  const isl       = ISLANDS[selectedIslandIdx];
  // Prefer explicit sandVerts as the "default"; fall back to shape polygon
  const source    = isl.sandVerts ?? getPolys(isl.id, 'islandShape')[0];
  if (!source?.length) { alert('No source polygon available.'); return; }
  layerData.set(dataKey(isl.id, 'outerSand'), [source.map(v => ({ ...v }))]);
  if (activeLayerKey === 'outerSand') { refreshPolySelect(); refreshVertCount(); }
  toast('Sand reset to ' + (isl.sandVerts ? 'saved verts' : 'shape vertices'));
});

document.getElementById('btn-grass-from-shape')!.addEventListener('click', () => {
  const isl       = ISLANDS[selectedIslandIdx];
  const shapePoly = getPolys(isl.id, 'islandShape')[0];
  if (!shapePoly.length) { alert('Shape layer is empty.'); return; }
  const scale     = isl.grassPolyScale ?? 0.82;
  const scaled    = shapePoly.map(v => ({ x: v.x * scale, y: v.y * scale }));
  layerData.set(dataKey(isl.id, 'innerGrass'), [scaled]);
  if (activeLayerKey === 'innerGrass') { refreshPolySelect(); refreshVertCount(); }
  toast(`Grass reset to shape × ${scale}`);
});

document.getElementById('btn-shape-from-sand')!.addEventListener('click', () => {
  const isl      = ISLANDS[selectedIslandIdx];
  const sandPoly = getPolys(isl.id, 'outerSand')[0];
  if (!sandPoly.length) { alert('Sand layer is empty.'); return; }
  layerData.set(dataKey(isl.id, 'islandShape'), [sandPoly.map(v => ({ ...v }))]);
  if (activeLayerKey === 'islandShape') { refreshPolySelect(); refreshVertCount(); }
  toast('Shape reset to sand vertices');
});

// ── Server fetch ───────────────────────────────────────────────────────────────

interface ServerIslandData {
  id: number;
  cx: number;
  cy: number;
  preset: string;
  vertexCount?: number;
  grassPolyScale?: number;
  outerVerts?: Pt[];
  grassVertCount?: number;
  grassVerts?: Pt[];
  shallowVertCount?: number;
  shallowVerts?: Pt[];
  stoneVertCount?: number;
  stoneVerts?: Pt[];
  metalVertCount?: number;
  metalVerts?: Pt[];
  beachRadius?: number;
  grassRadius?: number;
}

const serverStatusEl = document.getElementById('server-status')!;
const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;

async function fetchFromServer(): Promise<void> {
  const base = serverUrlInput.value.trim().replace(/\/$/, '');
  serverStatusEl.textContent = 'connecting…';
  serverStatusEl.style.color = 'rgba(232,213,154,0.5)';
  try {
    const res  = await fetch(`${base}/api/islands`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: { islands: ServerIslandData[] } = await res.json();

    let updated = 0;
    for (const srv of data.islands) {
      const local = ISLANDS.find(i => i.id === srv.id);
      if (!local) continue;
      // Update centre
      local.cx = srv.cx;
      local.cy = srv.cy;
      // Update shape/outer verts for polygon islands
      if (srv.outerVerts && srv.outerVerts.length) {
        local.outerVerts     = srv.outerVerts.map(v => ({ x: v.x, y: v.y }));
        local.grassPolyScale = srv.grassPolyScale ?? local.grassPolyScale;
        // Invalidate cached layer data so getPolys() re-seeds from updated outerVerts
        layerData.delete(dataKey(local.id, 'islandShape'));
        // Only reset sand/grass from server if they're not already explicitly set
        if (!local.sandVerts)  layerData.delete(dataKey(local.id, 'outerSand'));
        if (!local.grassVerts) layerData.delete(dataKey(local.id, 'innerGrass'));
        // Load explicit grass polygon from server if provided
        if (srv.grassVerts && srv.grassVerts.length) {
          local.grassVerts = srv.grassVerts.map(v => ({ x: v.x, y: v.y }));
          layerData.delete(dataKey(local.id, 'innerGrass'));
        }
        // Load explicit shallow polygon from server if provided
        if (srv.shallowVerts && srv.shallowVerts.length) {
          local.shallowVerts = srv.shallowVerts.map(v => ({ x: v.x, y: v.y }));
          layerData.delete(dataKey(local.id, 'outerShallow'));
        } else {
          // Regenerate shallow from updated sand
          layerData.delete(dataKey(local.id, 'outerShallow'));
        }
        // Load stone biome polygon from server if provided
        if (srv.stoneVerts && srv.stoneVerts.length) {
          layerData.set(dataKey(local.id, 'stoneZone'), [srv.stoneVerts.map(v => ({ x: v.x, y: v.y }))]);
        }
        // Load metal biome polygon from server if provided
        if (srv.metalVerts && srv.metalVerts.length) {
          layerData.set(dataKey(local.id, 'metalZone'), [srv.metalVerts.map(v => ({ x: v.x, y: v.y }))]);
        }
      }
      if (srv.beachRadius !== undefined) local.circleRadius = srv.beachRadius;
      updated++;
    }

    serverStatusEl.textContent = `✓ ${updated} island(s) loaded`;
    serverStatusEl.style.color = '#a8e890';
    refreshPolySelect();
    refreshVertCount();
    refreshSubIslandList();
    toast(`Loaded ${updated} island(s) from server`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    serverStatusEl.textContent = `✗ ${msg}`;
    serverStatusEl.style.color = '#e87070';
  }
}

document.getElementById('btn-fetch-server')!.addEventListener('click', fetchFromServer);

document.getElementById('btn-shallow-from-sand')?.addEventListener('click', () => {
  const isl = ISLANDS[selectedIslandIdx];
  if (!isl) return;
  // Force regenerate shallow from current sand polygon
  const sandPoly = getPolys(isl.id, 'outerSand')[0] ?? [];
  if (!sandPoly.length) { toast('No sand polygon to expand from'); return; }
  const generated = generateShallowFromSand(sandPoly);
  layerData.set(dataKey(isl.id, 'outerShallow'), [generated]);
  toast('Shallow polygon reset from sand');
});

// Auto-fetch on load (silent failure — just updates status)
fetchFromServer();

// Import
document.getElementById('btn-import')!.addEventListener('click', () => {
  const ta = document.getElementById('import-area') as HTMLTextAreaElement;
  try {
    const parsed = JSON.parse(ta.value.trim());

    // Full schema object — load sand, grass, islets all at once
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // ── Switch to the correct island based on islandId in the schema ──
      if (parsed.islandId != null) {
        const idx = ISLANDS.findIndex(i => i.id === parsed.islandId);
        if (idx >= 0) {
          selectedIslandIdx = idx;
          islSelect.value = String(idx);
          activeSubIslandIdx = null;
          updateSubIslandUI();
        }
      }
      const isl = ISLANDS[selectedIslandIdx];

      // ── Update island centre if provided ──
      if (parsed.centre) {
        isl.cx = +parsed.centre.x;
        isl.cy = +parsed.centre.y;
        // Invalidate all cached layer data so getPolys() re-seeds from new centre
        for (const ld of LAYERS) layerData.delete(dataKey(isl.id, ld.key));
      }

      const importedLayers: LayerKey[] = [];
      if (parsed.sand_verts_JSON) {
        layerData.set(dataKey(isl.id, 'outerSand'),   [(parsed.sand_verts_JSON as Pt[]).map((p: Pt) => ({ x: +p.x, y: +p.y }))]);
        layerData.set(dataKey(isl.id, 'islandShape'), [(parsed.sand_verts_JSON as Pt[]).map((p: Pt) => ({ x: +p.x, y: +p.y }))]);
        importedLayers.push('outerSand');
      }
      if (parsed.grass_verts_JSON) {
        layerData.set(dataKey(isl.id, 'innerGrass'), [(parsed.grass_verts_JSON as Pt[]).map((p: Pt) => ({ x: +p.x, y: +p.y }))]);
        importedLayers.push('innerGrass');
      }
      if (parsed.shallow_verts_JSON) {
        layerData.set(dataKey(isl.id, 'outerShallow'), [(parsed.shallow_verts_JSON as Pt[]).map((p: Pt) => ({ x: +p.x, y: +p.y }))]);
        importedLayers.push('outerShallow');
      }
      if (Array.isArray(parsed.islets)) {
        const subs: SubIslandEntry[] = (parsed.islets as any[]).map((s: any) => ({
          id: nextSubIslandId++,
          sandVerts:  (s.sand  ?? []).map((p: Pt) => ({ x: +p.x, y: +p.y })),
          grassVerts: (s.grass ?? []).map((p: Pt) => ({ x: +p.x, y: +p.y })),
        }));
        subIslandsMap.set(isl.id, subs);
        refreshSubIslandList();
      }
      if (parsed.stone_verts_JSON) {
        layerData.set(dataKey(isl.id, 'stoneZone'), [(parsed.stone_verts_JSON as Pt[]).map((p: Pt) => ({ x: +p.x, y: +p.y }))]);
        importedLayers.push('stoneZone');
      }
      if (parsed.metal_verts_JSON) {
        layerData.set(dataKey(isl.id, 'metalZone'), [(parsed.metal_verts_JSON as Pt[]).map((p: Pt) => ({ x: +p.x, y: +p.y }))]);
        importedLayers.push('metalZone');
      }

      // ── Switch to first imported layer so the result is immediately visible ──
      if (importedLayers.length > 0) {
        activeLayerKey = importedLayers[0];
        activePolyIdx  = 0;
        layerBtnsEl.querySelectorAll('.btn').forEach((b, i) => {
          b.classList.toggle('active', LAYERS[i].key === activeLayerKey);
        });
      }

      // Pan camera to the island centre
      cam.centreOn(isl.cx, isl.cy);
      cam.zoom = 0.12;

      refreshPolySelect(); refreshVertCount(); ta.value = '';
      toast(`Imported ${importedLayers.map(k => LAYERS.find(l => l.key === k)?.label ?? k).join(', ')}`);
      return;
    }

    // Bare array — import into active layer/poly
    if (!Array.isArray(parsed)) throw new Error('expected array or schema object');
    const islArr = ISLANDS[selectedIslandIdx];
    const polys = getPolys(islArr.id, activeLayerKey);
    if (Array.isArray(parsed[0])) {
      (parsed as Pt[][]).forEach((pts, i) => { polys[i] = pts.map((p: Pt) => ({ x: +p.x, y: +p.y })); });
    } else {
      polys[activePolyIdx] = (parsed as Pt[]).map((p: Pt) => ({ x: +p.x, y: +p.y }));
    }
    refreshPolySelect(); refreshVertCount(); ta.value = '';
    toast('Polygon imported');
  } catch { alert('Invalid JSON'); }
});

// Export
document.getElementById('btn-export')!.addEventListener('click', () => {
  const isl    = ISLANDS[selectedIslandIdx];
  const schema: Record<string, unknown> = { islandId: isl.id, centre: { x: isl.cx, y: isl.cy } };

  for (const ld of LAYERS) {
    const polys = getPolys(isl.id, ld.key).filter(p => p.length > 0);
    if (!polys.length) continue;

    if (ld.key === 'islandShape' || ld.key === 'outerSand' || ld.key === 'innerGrass' || ld.key === 'outerShallow' || ld.key === 'stoneZone' || ld.key === 'metalZone') {
      const verts = polys[0];
      const label = ld.key === 'innerGrass' ? 'grass'
                  : ld.key === 'outerShallow' ? 'shallow'
                  : ld.key === 'stoneZone' ? 'stone'
                  : ld.key === 'metalZone' ? 'metal'
                  : 'sand';
      schema[`${label}_verts_JSON`] = verts;
      schema[`${label}_C_vx`]      = `.vx = { ${verts.map(v => Math.round(v.x)).join(', ')} }`;
      schema[`${label}_C_vy`]      = `.vy = { ${verts.map(v => Math.round(v.y)).join(', ')} }`;
      schema[`${label}_vertex_count`] = verts.length;
    } else {
      schema[ld.key] = ld.multi ? polys : polys[0];
    }
  }

  // Include islets
  const islets = getSubIslands(isl.id);
  if (islets.length > 0) {
    (schema as any).islets = islets.map(s => ({ sand: s.sandVerts, grass: s.grassVerts }));
  }

  const jsonFinal = JSON.stringify(schema, null, 2);
  navigator.clipboard.writeText(jsonFinal).then(
    () => toast('Copied to clipboard!'),
    () => {
      const w = window.open('', '_blank', 'width=700,height=600');
      w?.document.write(`<pre style="font:12px Georgia, serif;background:#111;color:#cfc;padding:16px">${
        jsonFinal.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      }</pre>`);
    },
  );
});

// Save to Server
document.getElementById('btn-save-to-server')!.addEventListener('click', async () => {
  const isl    = ISLANDS[selectedIslandIdx];
  const schema: Record<string, unknown> = { islandId: isl.id, centre: { x: isl.cx, y: isl.cy } };
  for (const ld of LAYERS) {
    const polys = getPolys(isl.id, ld.key).filter(p => p.length > 0);
    if (!polys.length) continue;
    if (ld.key === 'islandShape' || ld.key === 'outerSand' || ld.key === 'innerGrass' || ld.key === 'outerShallow' || ld.key === 'stoneZone' || ld.key === 'metalZone') {
      const verts = polys[0];
      const label = ld.key === 'innerGrass' ? 'grass'
                  : ld.key === 'outerShallow' ? 'shallow'
                  : ld.key === 'stoneZone' ? 'stone'
                  : ld.key === 'metalZone' ? 'metal'
                  : 'sand';
      schema[`${label}_verts_JSON`] = verts;
    }
  }
  const base = serverUrlInput.value.trim().replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/islands/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schema, null, 2),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data.ok) toast(`Saved → ${data.file}`);
    else toast(`Error: ${data.error ?? res.status}`);
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`);
  }
});

function toast(msg: string): void {
  const d = document.createElement('div');
  d.textContent = msg;
  Object.assign(d.style, {
    position:'fixed', bottom:'24px', right:'24px',
    background:'rgba(30,90,30,0.92)', color:'#a8e890',
    padding:'8px 14px', borderRadius:'4px', fontFamily:'Georgia, serif', fontSize:'13px',
    zIndex:'9999', transition:'opacity 0.4s',
  });
  document.body.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 400); }, 1800);
}

// ── Sub-island sidebar wiring ───────────────────────────────────────────────────

const subIslSelect = document.getElementById('sub-isl-select') as HTMLSelectElement;
const subIslBar    = document.getElementById('sub-isl-bar')!;
const subIslLabel  = document.getElementById('sub-isl-label')!;

function refreshSubIslandList(): void {
  const isl  = ISLANDS[selectedIslandIdx];
  const subs = getSubIslands(isl.id);
  subIslSelect.innerHTML = subs.length === 0
    ? '<option value="" disabled>No islets</option>'
    : '';
  subs.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Islet ${i + 1} (${s.sandVerts.length} sand, ${s.grassVerts.length} grass)`;
    subIslSelect.appendChild(opt);
  });
  if (subs.length > 0) subIslSelect.value = String(Math.min(parseInt(subIslSelect.value) || 0, subs.length - 1));
}

function updateSubIslandUI(): void {
  const inSub = activeSubIslandIdx !== null;
  subIslBar.style.display = inSub ? '' : 'none';
  if (inSub) {
    subIslLabel.textContent = `${activeSubIslandIdx! + 1}`;
  }
}

document.getElementById('sub-isl-add')!.addEventListener('click', () => {
  const isl  = ISLANDS[selectedIslandIdx];
  const subs = getSubIslands(isl.id);
  subs.push({ id: nextSubIslandId++, sandVerts: [], grassVerts: [] });
  refreshSubIslandList();
  subIslSelect.value = String(subs.length - 1);
});

document.getElementById('sub-isl-del')!.addEventListener('click', () => {
  const isl  = ISLANDS[selectedIslandIdx];
  const subs = getSubIslands(isl.id);
  const idx  = parseInt(subIslSelect.value);
  if (isNaN(idx) || subs.length === 0) return;
  if (activeSubIslandIdx === idx) { activeSubIslandIdx = null; updateSubIslandUI(); }
  subs.splice(idx, 1);
  refreshSubIslandList();
});

document.getElementById('sub-isl-edit')!.addEventListener('click', () => {
  const isl  = ISLANDS[selectedIslandIdx];
  const subs = getSubIslands(isl.id);
  const idx  = parseInt(subIslSelect.value);
  if (isNaN(idx) || idx >= subs.length) { alert('Select an islet first.'); return; }
  activeSubIslandIdx = idx;
  // Switch to a sand-relevant layer for editing
  if (activeLayerKey !== 'outerSand' && activeLayerKey !== 'innerGrass') {
    activeLayerKey = 'outerSand';
    layerBtnsEl.querySelectorAll('.btn').forEach((b, i) => {
      b.classList.toggle('active', LAYERS[i].key === activeLayerKey);
    });
  }
  refreshPolySelect(); refreshVertCount(); updateSubIslandUI();
});

document.getElementById('sub-isl-back')!.addEventListener('click', () => {
  activeSubIslandIdx = null;
  refreshPolySelect(); refreshVertCount(); updateSubIslandUI();
});



{
  const isl = ISLANDS[selectedIslandIdx];
  cam.centreOn(isl.cx, isl.cy);
  cam.zoom = 0.12;
}
refreshPolySelect();
refreshVertCount();
refreshSubIslandList();
updateSubIslandUI();
requestAnimationFrame(render);
