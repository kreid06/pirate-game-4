// Map Editor — world-scale canvas for editing island positions and spawning ghost ships.
// Admin API runs on port 8081 (configurable).

const MAP_W = 90000;
const MAP_H = 90000;

// ── Data types ──────────────────────────────────────────────────────────────

interface IslandApiData {
  id: number;
  cx: number;
  cy: number;
  preset: string;
  beachRadius?: number;
  grassRadius?: number;
  grassPolyScale?: number;
  vertexCount?: number;
  outerVerts?: { x: number; y: number }[];
  shallowVerts?: { x: number; y: number }[];
}

interface IslandState extends IslandApiData {
  // Editable position (may differ from server until saved)
  editX: number;
  editY: number;
  dirty: boolean;
}

interface LiveShip {
  id: number;
  x: number;
  y: number;
  company: number;
  npcLevel?: number;
  shipType?: number;
  name?: string;
}

type EditorMode = 'view' | 'move-island' | 'spawn-ghost';

// ── State ───────────────────────────────────────────────────────────────────

let islands: IslandState[] = [];
let liveShips: LiveShip[] = [];
let selectedIslandId: number | null = null;

let mode: EditorMode = 'view';
let autoRefresh = false;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let showShips = true;
let showGhosts = true;
let showGrid = true;

// Canvas pan/zoom
let offsetX = 0; // canvas pixels from left edge to world (0,0)
let offsetY = 0;
let scale = 1;   // canvas px per world px

// Drag state
let isPanning = false;
let isDraggingIsland = false;
let dragIslandId: number | null = null;
let dragStartCanvasX = 0;
let dragStartCanvasY = 0;
let dragStartWorldX = 0;
let dragStartWorldY = 0;
let panStartX = 0;
let panStartY = 0;
let panStartOffX = 0;
let panStartOffY = 0;

// Mouse world position
let mouseWorldX = 0;
let mouseWorldY = 0;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const canvas = document.getElementById('map-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusBar = document.getElementById('status-bar')!;
const coordsDisplay = document.getElementById('coords-display')!;
const islandList = document.getElementById('island-list')!;
const islandDetail = document.getElementById('island-detail')!;
const selIslandId = document.getElementById('sel-island-id')!;
const selIslandX = document.getElementById('sel-island-x')!;
const selIslandY = document.getElementById('sel-island-y')!;
const selIslandTmpl = document.getElementById('sel-island-tmpl')!;
const shipStats = document.getElementById('ship-stats')!;
const toast = document.getElementById('toast')!;

// ── Helpers ──────────────────────────────────────────────────────────────────

function serverUrl(): string {
  const port = (document.getElementById('server-port') as HTMLInputElement).value.trim();
  return `http://localhost:${port}`;
}

function worldToCanvas(wx: number, wy: number): [number, number] {
  return [offsetX + wx * scale, offsetY + wy * scale];
}

function canvasToWorld(cx: number, cy: number): [number, number] {
  return [(cx - offsetX) / scale, (cy - offsetY) / scale];
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, type: 'ok' | 'err' | '' = '') {
  toast.textContent = msg;
  toast.className = `show ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = ''; }, 3000);
}

function setStatus(msg: string) {
  statusBar.textContent = msg;
}

// ── Colour palette ────────────────────────────────────────────────────────────

const COMPANY_COLORS: Record<number, string> = {
  0:  '#aaaaaa', // neutral
  1:  '#d04040', // pirates
  2:  '#4080d0', // navy
  3:  '#40b040', // merchant
  99: '#cc44cc', // ghost
};

const ISLAND_COLORS = [
  '#4db87a', '#5bc85e', '#65a86d', '#3ea87b',
  '#56b86e', '#4aa875', '#60c87a', '#3e9862',
  '#50b870',
];

function islandColor(id: number): string {
  return ISLAND_COLORS[(id - 1) % ISLAND_COLORS.length];
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchIslands(): Promise<void> {
  try {
    const r = await fetch(`${serverUrl()}/api/islands`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as { islands: IslandApiData[] };
    const prev = new Map(islands.map(i => [i.id, i]));
    islands = data.islands.map(d => {
      const old = prev.get(d.id);
      return {
        ...d,
        editX: old?.dirty ? old.editX : d.cx,
        editY: old?.dirty ? old.editY : d.cy,
        dirty: old?.dirty ?? false,
      };
    });
    renderIslandList();
    setStatus(`Loaded ${islands.length} islands`);
  } catch (e) {
    setStatus(`Island fetch failed: ${e}`);
  }
}

async function fetchMap(): Promise<void> {
  try {
    const r = await fetch(`${serverUrl()}/api/map`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const ships: LiveShip[] = [];
    if (Array.isArray(data.ships)) {
      for (const s of data.ships) {
        ships.push({
          id: s.id,
          x: s.x,
          y: s.y,
          company: s.company_id ?? s.company ?? 0,
          npcLevel: s.npc_level ?? s.npcLevel,
          shipType: s.ship_type ?? s.shipType,
          name: s.name,
        });
      }
    }
    if (Array.isArray(data.players)) {
      for (const p of data.players) {
        ships.push({
          id: p.id,
          x: p.world_x ?? p.x,
          y: p.world_y ?? p.y,
          company: p.company ?? 0,
          name: p.name ?? 'player',
        });
      }
    }
    liveShips = ships;
    const ghostCount = ships.filter(s => s.company === 99).length;
    const playerCount = ships.filter(s => !s.npcLevel).length;
    shipStats.innerHTML =
      `Ships: <span>${ships.length}</span><br>` +
      `Ghosts: <span>${ghostCount}</span><br>` +
      `Players: <span>${playerCount}</span>`;
  } catch (e) {
    shipStats.textContent = `Map fetch failed: ${e}`;
  }
}

async function refreshAll(): Promise<void> {
  setStatus('Refreshing…');
  await Promise.all([fetchIslands(), fetchMap()]);
  draw();
  setStatus('Ready');
}

// ── Save island positions ─────────────────────────────────────────────────────

async function saveIslandPositions(): Promise<void> {
  const payload = islands
    .filter(i => i.dirty)
    .map(i => ({ id: i.id, x: Math.round(i.editX), y: Math.round(i.editY) }));

  if (payload.length === 0) {
    showToast('No changes to save', '');
    return;
  }

  try {
    const r = await fetch(`${serverUrl()}/api/islands/reposition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.ok) {
      islands.forEach(i => { i.dirty = false; });
      renderIslandList();
      showToast(`Saved ${payload.length} island position(s)`, 'ok');
    } else {
      showToast(`Save failed: ${data.error ?? 'unknown'}`, 'err');
    }
  } catch (e) {
    showToast(`Save error: ${e}`, 'err');
  }
}

// ── Spawn ghost ships ─────────────────────────────────────────────────────────

async function spawnGhost(wx: number, wy: number): Promise<void> {
  const level = parseInt((document.getElementById('ghost-level') as HTMLInputElement).value, 10) || 30;
  const fleetSize = parseInt((document.getElementById('ghost-fleet') as HTMLInputElement).value, 10) || 1;

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const spawnX = clamp(wx, 1000, MAP_W - 1000);
  const spawnY = clamp(wy, 1000, MAP_H - 1000);

  let spawned = 0;
  for (let i = 0; i < fleetSize; i++) {
    const angle = (i / fleetSize) * Math.PI * 2;
    const radius = fleetSize > 1 ? 400 : 0;
    const sx = spawnX + Math.cos(angle) * radius;
    const sy = spawnY + Math.sin(angle) * radius;
    try {
      const r = await fetch(`${serverUrl()}/api/admin/phantom-brig`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: Math.round(sx), y: Math.round(sy), level }),
      });
      const data = await r.json();
      if (data.success) spawned++;
    } catch { /* ignore individual failures */ }
  }

  if (spawned > 0) {
    showToast(`Spawned ${spawned} ghost ship(s) at (${Math.round(wx)}, ${Math.round(wy)}) lv${level}`, 'ok');
    await fetchMap();
    draw();
  } else {
    showToast('Ghost spawn failed (server may be offline)', 'err');
  }
}

// ── Island list sidebar ───────────────────────────────────────────────────────

function renderIslandList(): void {
  islandList.innerHTML = '';
  for (const isl of islands) {
    const item = document.createElement('div');
    item.className = 'island-list-item' + (isl.id === selectedIslandId ? ' selected' : '');
    item.dataset.id = String(isl.id);

    const dot = document.createElement('div');
    dot.className = 'island-dot';
    dot.style.background = islandColor(isl.id);
    if (isl.dirty) dot.style.boxShadow = '0 0 4px #f5c842';

    const label = document.createElement('span');
    label.textContent = `Island ${isl.id}${isl.dirty ? ' *' : ''}`;

    item.appendChild(dot);
    item.appendChild(label);
    item.addEventListener('click', () => selectIsland(isl.id));
    islandList.appendChild(item);
  }
  updateIslandDetail();
}

function selectIsland(id: number | null): void {
  selectedIslandId = id;
  renderIslandList();
  updateIslandDetail();
  draw();
}

function updateIslandDetail(): void {
  const isl = islands.find(i => i.id === selectedIslandId);
  if (!isl) {
    islandDetail.style.display = 'none';
    return;
  }
  islandDetail.style.display = '';
  selIslandId.textContent = String(isl.id);
  selIslandX.textContent = Math.round(isl.editX).toString();
  selIslandY.textContent = Math.round(isl.editY).toString();
  selIslandTmpl.textContent = (isl as any).template ?? isl.preset;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Ocean background
  ctx.fillStyle = '#0e2240';
  ctx.fillRect(0, 0, W, H);

  // World boundary
  const [bx0, by0] = worldToCanvas(0, 0);
  const [bx1, by1] = worldToCanvas(MAP_W, MAP_H);
  ctx.strokeStyle = 'rgba(245,200,66,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);

  // Grid
  if (showGrid) drawGrid(W, H);

  // Islands
  for (const isl of islands) {
    drawIsland(isl);
  }

  // Ships
  if (showShips || showGhosts) {
    for (const ship of liveShips) {
      if (ship.company === 99 && !showGhosts) continue;
      if (ship.company !== 99 && !showShips) continue;
      drawShip(ship);
    }
  }

  // Cursor crosshair in spawn mode
  if (mode === 'spawn-ghost') {
    const [cx, cy] = worldToCanvas(mouseWorldX, mouseWorldY);
    ctx.strokeStyle = 'rgba(200,80,80,0.7)';
    ctx.lineWidth = 1;
    const sz = 12;
    ctx.beginPath();
    ctx.moveTo(cx - sz, cy); ctx.lineTo(cx + sz, cy);
    ctx.moveTo(cx, cy - sz); ctx.lineTo(cx, cy + sz);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawGrid(W: number, H: number): void {
  const step = chooseGridStep();
  const startX = Math.floor((-offsetX / scale) / step) * step;
  const startY = Math.floor((-offsetY / scale) / step) * step;

  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let wx = startX; wx < MAP_W + step; wx += step) {
    const [cx] = worldToCanvas(wx, 0);
    if (cx < -1 || cx > W + 1) continue;
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
  }
  for (let wy = startY; wy < MAP_H + step; wy += step) {
    const [, cy] = worldToCanvas(0, wy);
    if (cy < -1 || cy > H + 1) continue;
    ctx.moveTo(0, cy); ctx.lineTo(W, cy);
  }
  ctx.stroke();

  // Grid labels at major lines
  ctx.fillStyle = 'rgba(232,213,154,0.25)';
  ctx.font = '9px monospace';
  for (let wx = startX; wx < MAP_W + step; wx += step) {
    const [cx] = worldToCanvas(wx, 0);
    if (cx < 0 || cx > W) continue;
    ctx.fillText(String(Math.round(wx)), cx + 2, 10);
  }
  for (let wy = startY; wy < MAP_H + step; wy += step) {
    const [, cy] = worldToCanvas(0, wy);
    if (cy < 0 || cy > H) continue;
    ctx.fillText(String(Math.round(wy)), 2, cy - 2);
  }
}

function chooseGridStep(): number {
  const worldVisible = MAP_W / scale;
  const steps = [1000, 2000, 5000, 10000, 20000, 50000];
  for (const s of steps) {
    if (worldVisible / s < 20) return s;
  }
  return 50000;
}

function drawIsland(isl: IslandState): void {
  const [cx, cy] = worldToCanvas(isl.editX, isl.editY);
  const isSelected = isl.id === selectedIslandId;
  const isDirty = isl.dirty;

  ctx.save();

  if (isl.outerVerts && isl.outerVerts.length > 2) {
    // Polygon island
    const polyBoundR = (isl as any).polyBoundR ?? estimatePolyRadius(isl.outerVerts);
    const screenR = polyBoundR * scale;

    // Shallow water halo
    if (isl.shallowVerts && isl.shallowVerts.length > 2) {
      ctx.beginPath();
      for (let i = 0; i < isl.shallowVerts.length; i++) {
        const sx = cx + isl.shallowVerts[i].x * scale;
        const sy = cy + isl.shallowVerts[i].y * scale;
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(30,100,160,0.35)';
      ctx.fill();
    }

    // Main island shape
    ctx.beginPath();
    for (let i = 0; i < isl.outerVerts.length; i++) {
      const vx = cx + isl.outerVerts[i].x * scale;
      const vy = cy + isl.outerVerts[i].y * scale;
      i === 0 ? ctx.moveTo(vx, vy) : ctx.lineTo(vx, vy);
    }
    ctx.closePath();
    ctx.fillStyle = isSelected ? '#5bcf8a' : islandColor(isl.id);
    ctx.fill();
    ctx.strokeStyle = isDirty ? '#f5c842' : (isSelected ? '#fff' : 'rgba(255,255,255,0.4)');
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    // Centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(3, screenR * 0.04), 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.5)';
    ctx.fill();

    // Label (only if large enough)
    if (screenR > 20) {
      ctx.fillStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.font = `bold ${Math.max(10, Math.min(14, screenR * 0.1))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`${isl.id}`, cx, cy + 4);
    }
  } else {
    // Bump-circle island
    const radius = (isl.grassRadius ?? isl.beachRadius ?? 2500) * scale;

    // Shallow halo
    const shallowR = (isl.beachRadius ?? 2500) * scale * 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, shallowR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,100,160,0.35)';
    ctx.fill();

    // Island body
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? '#5bcf8a' : islandColor(isl.id);
    ctx.fill();
    ctx.strokeStyle = isDirty ? '#f5c842' : (isSelected ? '#fff' : 'rgba(255,255,255,0.4)');
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    // Label
    if (radius > 6) {
      ctx.fillStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.font = `bold ${Math.max(10, Math.min(14, radius * 0.3))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`${isl.id}`, cx, cy + 4);
    }
  }

  ctx.restore();
}

function estimatePolyRadius(verts: { x: number; y: number }[]): number {
  let maxR = 0;
  for (const v of verts) maxR = Math.max(maxR, Math.hypot(v.x, v.y));
  return maxR;
}

function drawShip(ship: LiveShip): void {
  const [cx, cy] = worldToCanvas(ship.x, ship.y);
  const r = ship.company === 99 ? 5 : 4;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = COMPANY_COLORS[ship.company] ?? '#aaaaaa';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Ghost ships get a skull indicator when zoomed in enough
  if (ship.company === 99 && scale > 0.003) {
    ctx.fillStyle = 'rgba(200,80,200,0.7)';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('☠', cx, cy - r - 2);
  }
}

// ── Viewport / zoom ─────────────────────────────────────────────────────────

function fitAll(): void {
  const W = canvas.width;
  const H = canvas.height;
  const margin = 30;
  const scaleX = (W - margin * 2) / MAP_W;
  const scaleY = (H - margin * 2) / MAP_H;
  scale = Math.min(scaleX, scaleY);
  offsetX = margin + (W - margin * 2 - MAP_W * scale) / 2;
  offsetY = margin + (H - margin * 2 - MAP_H * scale) / 2;
  draw();
}

function zoomAtPoint(canvasPx: number, canvasPy: number, factor: number): void {
  const wx = (canvasPx - offsetX) / scale;
  const wy = (canvasPy - offsetY) / scale;
  scale *= factor;
  scale = Math.max(0.00015, Math.min(0.08, scale));
  offsetX = canvasPx - wx * scale;
  offsetY = canvasPy - wy * scale;
  draw();
}

// ── Hit testing ───────────────────────────────────────────────────────────────

function hitTestIsland(cx: number, cy: number): IslandState | null {
  let best: IslandState | null = null;
  let bestDist = Infinity;

  for (const isl of islands) {
    const [icx, icy] = worldToCanvas(isl.editX, isl.editY);
    const dist = Math.hypot(cx - icx, cy - icy);

    // Use approximate screen radius for hit detection
    let screenR = 20; // minimum hit radius in px
    if (isl.outerVerts && isl.outerVerts.length > 0) {
      const polyR = estimatePolyRadius(isl.outerVerts);
      screenR = Math.max(20, polyR * scale * 0.5);
    } else {
      screenR = Math.max(20, (isl.grassRadius ?? isl.beachRadius ?? 2500) * scale);
    }

    if (dist < screenR && dist < bestDist) {
      best = isl;
      bestDist = dist;
    }
  }
  return best;
}

// ── Event handlers ────────────────────────────────────────────────────────────

function resizeCanvas(): void {
  const wrap = document.getElementById('canvas-wrap')!;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  draw();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAtPoint(px, py, factor);
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const [wx, wy] = canvasToWorld(cx, cy);

  if (mode === 'spawn-ghost' && e.button === 0) {
    spawnGhost(wx, wy);
    return;
  }

  if (mode === 'move-island' && e.button === 0) {
    const hit = hitTestIsland(cx, cy);
    if (hit) {
      isDraggingIsland = true;
      dragIslandId = hit.id;
      dragStartCanvasX = cx;
      dragStartCanvasY = cy;
      dragStartWorldX = hit.editX;
      dragStartWorldY = hit.editY;
      selectIsland(hit.id);
      canvas.classList.remove('cursor-grab');
      canvas.classList.add('cursor-move');
      return;
    }
  }

  // Pan on any middle-click, or left-click in view mode
  if (e.button === 1 || (e.button === 0 && mode === 'view') ||
      (e.button === 0 && mode === 'move-island' && !isDraggingIsland)) {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartOffX = offsetX;
    panStartOffY = offsetY;
    canvas.classList.add('cursor-grab');
  }
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const [wx, wy] = canvasToWorld(cx, cy);
  mouseWorldX = wx;
  mouseWorldY = wy;

  coordsDisplay.textContent = `World: (${Math.round(wx)}, ${Math.round(wy)})`;

  if (isDraggingIsland && dragIslandId !== null) {
    const dx = (cx - dragStartCanvasX) / scale;
    const dy = (cy - dragStartCanvasY) / scale;
    const isl = islands.find(i => i.id === dragIslandId);
    if (isl) {
      isl.editX = Math.max(0, Math.min(MAP_W, dragStartWorldX + dx));
      isl.editY = Math.max(0, Math.min(MAP_H, dragStartWorldY + dy));
      isl.dirty = true;
      updateIslandDetail();
      renderIslandList();
    }
    draw();
    return;
  }

  if (isPanning) {
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    offsetX = panStartOffX + dx;
    offsetY = panStartOffY + dy;
    draw();
    return;
  }

  // Update cursor hint for move-island mode
  if (mode === 'move-island') {
    const hit = hitTestIsland(cx, cy);
    canvas.style.cursor = hit ? 'grab' : 'default';
  }

  if (mode === 'spawn-ghost') draw();
});

canvas.addEventListener('mouseup', (e) => {
  if (isDraggingIsland) {
    isDraggingIsland = false;
    dragIslandId = null;
    canvas.classList.remove('cursor-move');
    canvas.style.cursor = 'grab';
  }
  if (isPanning) {
    isPanning = false;
    canvas.classList.remove('cursor-grab');
    canvas.style.cursor = mode === 'spawn-ghost' ? 'crosshair' : 'default';
  }
});

canvas.addEventListener('mouseleave', () => {
  isPanning = false;
  isDraggingIsland = false;
});

// ── Mode buttons ─────────────────────────────────────────────────────────────

function setMode(m: EditorMode): void {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('.btn[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === m);
  });
  if (m === 'spawn-ghost') {
    canvas.style.cursor = 'crosshair';
    (document.getElementById('spawn-hint') as HTMLElement).textContent =
      'Click on the map to spawn ghost ships.';
  } else if (m === 'move-island') {
    canvas.style.cursor = 'default';
    (document.getElementById('spawn-hint') as HTMLElement).textContent =
      'Switch to 💀 Spawn mode then click on the map.';
  } else {
    canvas.style.cursor = 'default';
    (document.getElementById('spawn-hint') as HTMLElement).textContent =
      'Switch to 💀 Spawn mode then click on the map.';
  }
  draw();
}

document.getElementById('btn-view')!.addEventListener('click', () => setMode('view'));
document.getElementById('btn-move')!.addEventListener('click', () => setMode('move-island'));
document.getElementById('btn-spawn')!.addEventListener('click', () => setMode('spawn-ghost'));

document.getElementById('btn-refresh')!.addEventListener('click', refreshAll);
document.getElementById('btn-fit')!.addEventListener('click', fitAll);
document.getElementById('btn-zoom-in')!.addEventListener('click', () => {
  zoomAtPoint(canvas.width / 2, canvas.height / 2, 1.5);
});
document.getElementById('btn-zoom-out')!.addEventListener('click', () => {
  zoomAtPoint(canvas.width / 2, canvas.height / 2, 1 / 1.5);
});

document.getElementById('btn-save-positions')!.addEventListener('click', saveIslandPositions);

document.getElementById('btn-auto-refresh')!.addEventListener('click', function() {
  autoRefresh = !autoRefresh;
  (this as HTMLButtonElement).textContent = `⏱ Auto: ${autoRefresh ? 'on' : 'off'}`;
  (this as HTMLButtonElement).classList.toggle('active', autoRefresh);
  if (autoRefresh) {
    autoRefreshTimer = setInterval(() => { fetchMap().then(draw); }, 3000);
  } else {
    if (autoRefreshTimer !== null) clearInterval(autoRefreshTimer);
  }
});

document.getElementById('chk-ships')!.addEventListener('change', (e) => {
  showShips = (e.target as HTMLInputElement).checked;
  draw();
});
document.getElementById('chk-ghosts')!.addEventListener('change', (e) => {
  showGhosts = (e.target as HTMLInputElement).checked;
  draw();
});
document.getElementById('chk-grid')!.addEventListener('change', (e) => {
  showGrid = (e.target as HTMLInputElement).checked;
  draw();
});

// ── Initialise ───────────────────────────────────────────────────────────────

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
fitAll();
refreshAll();
