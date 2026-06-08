// Map Editor — world-scale canvas for editing island positions and ghost fleet spawn points.
// No live server feed; this is a static world configuration tool.

const MAP_W = 90000;
const MAP_H = 90000;

// ── Data types ───────────────────────────────────────────────────────────────

interface IslandApiData {
  id: number;
  cx: number;
  cy: number;
  preset: string;
  template?: string;
  rotation_deg?: number;
  beachRadius?: number;
  grassRadius?: number;
  outerVerts?: { x: number; y: number }[];
  shallowVerts?: { x: number; y: number }[];
}

interface IslandState extends IslandApiData {
  editX: number;
  editY: number;
  editRotDeg: number;          // current editor rotation
  templateVerts?: { x: number; y: number }[]; // un-rotated outer verts
  templateShallow?: { x: number; y: number }[]; // un-rotated shallow verts
  dirty: boolean;
}

interface SpawnPoint {
  id: number;
  x: number;
  y: number;
  level_min: number;
  level_max: number;
  fleet_min: number;
  fleet_max: number;
  angle_deg: number;
  dirty: boolean;
}

type EditorMode = 'view' | 'move-island' | 'spawn-point';

// ── State ────────────────────────────────────────────────────────────────────

let islands: IslandState[]  = [];
let spawnPoints: SpawnPoint[] = [];
let nextSpawnId = 1;

let selectedIslandId: number | null = null;
let selectedSpawnId:  number | null = null;

let mode: EditorMode = 'view';
let showGrid = true;

// Canvas pan / zoom
let offsetX = 0;
let offsetY = 0;
let scale   = 1;

// ── Drag / rotate state ───────────────────────────────────────────────────────

let isPanning        = false;
let isDraggingIsland  = false;
let isRotatingIsland  = false;
let isDraggingSpawn   = false;
let isRotatingSpawn   = false;

let dragIslandId: number | null = null;
let dragSpawnId:  number | null = null;

let dragStartCanvasX = 0;
let dragStartCanvasY = 0;
let dragStartWorldX  = 0;
let dragStartWorldY  = 0;

let panStartX    = 0;
let panStartY    = 0;
let panStartOffX = 0;
let panStartOffY = 0;

// Mouse world position (for crosshair preview)
let mouseWorldX = 0;
let mouseWorldY = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const canvas        = document.getElementById('map-canvas')   as HTMLCanvasElement;
const ctx           = canvas.getContext('2d')!;
const statusBar     = document.getElementById('status-bar')!;
const coordsDisplay = document.getElementById('coords-display')!;
const modeHint      = document.getElementById('mode-hint')!;
const islandList    = document.getElementById('island-list')!;
const islandDetail  = document.getElementById('island-detail')!;
const selIslandId   = document.getElementById('sel-island-id')!;
const selIslandX    = document.getElementById('sel-island-x')!;
const selIslandY    = document.getElementById('sel-island-y')!;
const selIslandTmpl = document.getElementById('sel-island-tmpl')!;
const selIslandRot  = document.getElementById('sel-island-rot') as HTMLInputElement;
const spawnList     = document.getElementById('spawn-list')!;
const spawnDetail   = document.getElementById('spawn-detail') as HTMLElement;
const selSpawnId    = document.getElementById('sel-spawn-id')!;
const selSpawnLevelMin = document.getElementById('sel-spawn-level-min') as HTMLInputElement;
const selSpawnLevelMax = document.getElementById('sel-spawn-level-max') as HTMLInputElement;
const selSpawnFleetMin = document.getElementById('sel-spawn-fleet-min') as HTMLInputElement;
const selSpawnFleetMax = document.getElementById('sel-spawn-fleet-max') as HTMLInputElement;
const selSpawnAngle    = document.getElementById('sel-spawn-angle')     as HTMLInputElement;
const toast         = document.getElementById('toast')!;

// ── Helpers ───────────────────────────────────────────────────────────────────

function serverUrl(): string {
  const raw = (document.getElementById('server-url') as HTMLInputElement).value.trim();
  return raw.replace(/\/+$/, '');
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
  toast.className   = `show ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = ''; }, 3000);
}

function setStatus(msg: string) { statusBar.textContent = msg; }

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ── Rotation math ────────────────────────────────────────────────────────────

function rotateVerts(verts: { x: number; y: number }[], deg: number): { x: number; y: number }[] {
  const rad = deg * (Math.PI / 180);
  const c = Math.cos(rad), s = Math.sin(rad);
  return verts.map(v => ({ x: v.x * c - v.y * s, y: v.x * s + v.y * c }));
}

/** Given already-rotated vertices and the rotation that was applied, recover template verts. */
function unrotateVerts(verts: { x: number; y: number }[], deg: number): { x: number; y: number }[] {
  return rotateVerts(verts, -deg);
}

/** Build IslandState template vertices from the API response. */
function buildIslandState(d: IslandApiData, old?: IslandState): IslandState {
  const loadedRot = d.rotation_deg ?? 0;

  // Template verts = un-rotate the API (already-rotated) verts back to 0°
  const templateVerts   = d.outerVerts   ? unrotateVerts(d.outerVerts,   loadedRot) : undefined;
  const templateShallow = d.shallowVerts ? unrotateVerts(d.shallowVerts, loadedRot) : undefined;

  return {
    ...d,
    editX:          old?.dirty ? old.editX    : d.cx,
    editY:          old?.dirty ? old.editY    : d.cy,
    editRotDeg:     old?.dirty ? old.editRotDeg : loadedRot,
    templateVerts,
    templateShallow,
    dirty: old?.dirty ?? false,
  };
}

// ── Colours ───────────────────────────────────────────────────────────────────

const ISLAND_COLORS = [
  '#4db87a','#5bc85e','#65a86d','#3ea87b','#56b86e','#4aa875','#60c87a','#3e9862','#50b870',
];
function islandColor(id: number) { return ISLAND_COLORS[(id - 1) % ISLAND_COLORS.length]; }

function levelColor(lv: number): string {
  const t = clamp((lv - 1) / 59, 0, 1);
  return `rgb(${Math.round(80 + t * 175)},${Math.round(200 - t * 140)},80)`;
}

// Mid-point of the level range for colouring
function spawnColor(sp: SpawnPoint) { return levelColor((sp.level_min + sp.level_max) / 2); }

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchIslands(): Promise<void> {
  try {
    const r = await fetch(`${serverUrl()}/api/islands`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as { islands: IslandApiData[] };
    const prev = new Map(islands.map(i => [i.id, i]));
    islands = data.islands.map(d => buildIslandState(d, prev.get(d.id)));
    renderIslandList();
    setStatus(`Loaded ${islands.length} island(s)`);
  } catch (e) { setStatus(`Island fetch failed: ${e}`); }
}

async function fetchSpawnPoints(): Promise<void> {
  try {
    const r = await fetch(`${serverUrl()}/api/ghost-spawns`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as {
      spawn_points: {
        id: number; x: number; y: number;
        level_min?: number; level_max?: number;
        fleet_min?: number; fleet_max?: number;
        /* legacy */ level?: number; fleet_size?: number;
        angle_deg?: number;
      }[];
    };
    const prevDirty = new Map(spawnPoints.filter(p => p.dirty).map(p => [p.id, p]));
    spawnPoints = (data.spawn_points ?? []).map(sp => {
      if (prevDirty.has(sp.id)) return prevDirty.get(sp.id)!;
      const lmin = sp.level_min ?? sp.level ?? 1;
      const lmax = sp.level_max ?? sp.level ?? lmin;
      const fmin = sp.fleet_min ?? sp.fleet_size ?? 3;
      const fmax = sp.fleet_max ?? sp.fleet_size ?? fmin;
      return { id: sp.id, x: sp.x, y: sp.y, level_min: lmin, level_max: lmax,
               fleet_min: fmin, fleet_max: fmax, angle_deg: sp.angle_deg ?? 0, dirty: false };
    });
    nextSpawnId = spawnPoints.reduce((m, p) => Math.max(m, p.id + 1), 1);
    renderSpawnList();
    setStatus(`Loaded ${spawnPoints.length} spawn point(s)`);
  } catch (e) { setStatus(`Spawn fetch failed: ${e}`); }
}

async function refreshAll(): Promise<void> {
  setStatus('Refreshing…');
  await Promise.all([fetchIslands(), fetchSpawnPoints()]);
  draw();
  setStatus('Ready');
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function saveIslandPositions(): Promise<void> {
  const payload = islands.filter(i => i.dirty)
    .map(i => ({ id: i.id, x: Math.round(i.editX), y: Math.round(i.editY), rotation_deg: Math.round(i.editRotDeg) }));
  if (!payload.length) { showToast('No island changes', ''); return; }
  try {
    const r = await fetch(`${serverUrl()}/api/islands/reposition`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.ok) { islands.forEach(i => { i.dirty = false; }); renderIslandList(); showToast(`Saved ${payload.length} island(s)`, 'ok'); }
    else showToast(`Save failed: ${d.error ?? 'unknown'}`, 'err');
  } catch (e) { showToast(`Save error: ${e}`, 'err'); }
}

async function saveSpawnPoints(): Promise<void> {
  const payload = spawnPoints.map(sp => ({
    id: sp.id, x: Math.round(sp.x), y: Math.round(sp.y),
    level_min: sp.level_min, level_max: sp.level_max,
    fleet_min: sp.fleet_min, fleet_max: sp.fleet_max,
    angle_deg: Math.round(sp.angle_deg),
  }));
  try {
    const r = await fetch(`${serverUrl()}/api/ghost-spawns`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.ok) { spawnPoints.forEach(sp => { sp.dirty = false; }); renderSpawnList(); showToast(`Saved ${payload.length} spawn point(s)`, 'ok'); }
    else showToast(`Save failed: ${d.error ?? 'unknown'}`, 'err');
  } catch (e) { showToast(`Save error: ${e}`, 'err'); }
}

// ── Spawn point CRUD ──────────────────────────────────────────────────────────

function readNewDefaults(): Omit<SpawnPoint, 'id' | 'x' | 'y' | 'dirty'> {
  const lmin = clamp(parseInt((document.getElementById('new-spawn-level-min') as HTMLInputElement).value, 10) || 20, 1, 60);
  const lmax = clamp(parseInt((document.getElementById('new-spawn-level-max') as HTMLInputElement).value, 10) || 40, lmin, 60);
  const fmin = clamp(parseInt((document.getElementById('new-spawn-fleet-min') as HTMLInputElement).value, 10) || 3, 1, 10);
  const fmax = clamp(parseInt((document.getElementById('new-spawn-fleet-max') as HTMLInputElement).value, 10) || 5, fmin, 10);
  return { level_min: lmin, level_max: lmax, fleet_min: fmin, fleet_max: fmax, angle_deg: 0 };
}

function addSpawnPoint(wx: number, wy: number): void {
  const defaults = readNewDefaults();
  const sp: SpawnPoint = {
    id: nextSpawnId++,
    x: clamp(wx, 1000, MAP_W - 1000),
    y: clamp(wy, 1000, MAP_H - 1000),
    ...defaults,
    dirty: true,
  };
  spawnPoints.push(sp);
  selectSpawn(sp.id);
  renderSpawnList();
  draw();
  showToast(`Added spawn #${sp.id} lv${sp.level_min}–${sp.level_max} ×${sp.fleet_min}–${sp.fleet_max}`, 'ok');
}

function deleteSpawn(id: number): void {
  spawnPoints = spawnPoints.filter(sp => sp.id !== id);
  if (selectedSpawnId === id) selectSpawn(null);
  renderSpawnList();
  draw();
}

function selectSpawn(id: number | null): void {
  selectedSpawnId = id;
  const sp = spawnPoints.find(p => p.id === id);
  if (sp) {
    spawnDetail.style.display = 'flex';
    selSpawnId.textContent    = String(sp.id);
    selSpawnLevelMin.value    = String(sp.level_min);
    selSpawnLevelMax.value    = String(sp.level_max);
    selSpawnFleetMin.value    = String(sp.fleet_min);
    selSpawnFleetMax.value    = String(sp.fleet_max);
    selSpawnAngle.value       = String(Math.round(sp.angle_deg));
  } else {
    spawnDetail.style.display = 'none';
  }
  renderSpawnList();
}

function applySpawnEdit(): void {
  const sp = spawnPoints.find(p => p.id === selectedSpawnId);
  if (!sp) return;
  const lmin = clamp(parseInt(selSpawnLevelMin.value, 10) || sp.level_min, 1, 60);
  const lmax = clamp(parseInt(selSpawnLevelMax.value, 10) || sp.level_max, lmin, 60);
  const fmin = clamp(parseInt(selSpawnFleetMin.value, 10) || sp.fleet_min, 1, 10);
  const fmax = clamp(parseInt(selSpawnFleetMax.value, 10) || sp.fleet_max, fmin, 10);
  const ang  = ((parseInt(selSpawnAngle.value, 10) || 0) % 360 + 360) % 360;
  sp.level_min = lmin; sp.level_max = lmax;
  sp.fleet_min = fmin; sp.fleet_max = fmax;
  sp.angle_deg = ang;
  sp.dirty = true;
  // Sync angle input back in case it was clamped
  selSpawnAngle.value = String(ang);
  renderSpawnList();
  draw();
}

// ── Hit-test helpers ──────────────────────────────────────────────────────────

const SPAWN_OCCUPIED_R_WORLD = 4000;

function spawnScreenRadius(sp: SpawnPoint): number {
  return Math.max(10, (400 + (sp.fleet_min + sp.fleet_max) / 2 * 200) * scale);
}

/** Returns the canvas-space position of the rotation handle for a spawn point. */
function spawnHandlePos(sp: SpawnPoint): [number, number] {
  const [cx, cy] = worldToCanvas(sp.x, sp.y);
  // Handle sits on the occupancy ring edge, or at least 30 canvas px out
  const handleR = Math.max(30, SPAWN_OCCUPIED_R_WORLD * scale);
  const rad = sp.angle_deg * (Math.PI / 180);
  return [cx + Math.cos(rad) * handleR, cy + Math.sin(rad) * handleR];
}

/** Canvas-space position of the island rotation handle (a dot above the centre). */
function islandHandlePos(isl: IslandState): [number, number] {
  const [cx, cy] = worldToCanvas(isl.editX, isl.editY);
  // Handle sits on a ring at max(island_radius, 40 canvas px), at the current rotation angle
  let worldR = isl.templateVerts ? estimatePolyRadius(isl.templateVerts) : (isl.grassRadius ?? isl.beachRadius ?? 2500);
  const screenR = Math.max(40, worldR * scale * 1.1);
  const rad = isl.editRotDeg * (Math.PI / 180);
  return [cx + Math.cos(rad) * screenR, cy + Math.sin(rad) * screenR];
}

function hitTestIslandHandle(cx: number, cy: number): IslandState | null {
  if (selectedIslandId === null) return null;
  const isl = islands.find(i => i.id === selectedIslandId);
  if (!isl || !isl.templateVerts?.length) return null; // rotation only for polygon islands
  const [hx, hy] = islandHandlePos(isl);
  return Math.hypot(cx - hx, cy - hy) < 14 ? isl : null;
}

function hitTestIsland(cx: number, cy: number): IslandState | null {
  let best: IslandState | null = null, bestDist = Infinity;
  for (const isl of islands) {
    const [icx, icy] = worldToCanvas(isl.editX, isl.editY);
    const dist = Math.hypot(cx - icx, cy - icy);
    let screenR = 20;
    if (isl.templateVerts?.length) screenR = Math.max(20, estimatePolyRadius(isl.templateVerts) * scale * 0.5);
    else screenR = Math.max(20, (isl.grassRadius ?? isl.beachRadius ?? 2500) * scale);
    if (dist < screenR && dist < bestDist) { best = isl; bestDist = dist; }
  }
  return best;
}

function hitTestSpawnHandle(cx: number, cy: number): SpawnPoint | null {
  if (selectedSpawnId === null) return null;
  const sp = spawnPoints.find(p => p.id === selectedSpawnId);
  if (!sp) return null;
  const [hx, hy] = spawnHandlePos(sp);
  return Math.hypot(cx - hx, cy - hy) < 14 ? sp : null;
}

function hitTestSpawnCenter(cx: number, cy: number): SpawnPoint | null {
  let best: SpawnPoint | null = null, bestDist = Infinity;
  for (const sp of spawnPoints) {
    const [scx, scy] = worldToCanvas(sp.x, sp.y);
    const d = Math.hypot(cx - scx, cy - scy);
    const r = spawnScreenRadius(sp);
    if (d < r && d < bestDist) { best = sp; bestDist = d; }
  }
  return best;
}

// ── Island sidebar ────────────────────────────────────────────────────────────

function renderIslandList(): void {
  islandList.innerHTML = '';
  for (const isl of islands) {
    const item = document.createElement('div');
    item.className = `island-list-item${isl.id === selectedIslandId ? ' selected' : ''}`;
    const dot = document.createElement('div');
    dot.className = 'island-dot';
    dot.style.background  = islandColor(isl.id);
    if (isl.dirty) dot.style.boxShadow = '0 0 4px #f5c842';
    const label = document.createElement('span');
    label.textContent = `Island ${isl.id}${isl.dirty ? ' *' : ''}`;
    item.append(dot, label);
    item.addEventListener('click', () => selectIsland(isl.id));
    islandList.appendChild(item);
  }
  updateIslandDetail();
}

function selectIsland(id: number | null): void {
  selectedIslandId = id; renderIslandList(); updateIslandDetail(); draw();
}

function updateIslandDetail(): void {
  const isl = islands.find(i => i.id === selectedIslandId);
  if (!isl) { islandDetail.style.display = 'none'; return; }
  islandDetail.style.display = '';
  selIslandId.textContent   = String(isl.id);
  selIslandX.textContent    = Math.round(isl.editX).toString();
  selIslandY.textContent    = Math.round(isl.editY).toString();
  selIslandTmpl.textContent = isl.template ?? isl.preset;
  selIslandRot.value        = String(Math.round(isl.editRotDeg));
}

function applyIslandRot(): void {
  const isl = islands.find(i => i.id === selectedIslandId);
  if (!isl) return;
  const newRot = ((parseInt(selIslandRot.value, 10) || 0) % 360 + 360) % 360;
  isl.editRotDeg = newRot;
  isl.dirty      = true;
  selIslandRot.value = String(newRot);
  renderIslandList(); draw();
}

// ── Spawn point sidebar ───────────────────────────────────────────────────────

function renderSpawnList(): void {
  spawnList.innerHTML = '';
  for (const sp of spawnPoints) {
    const item = document.createElement('div');
    item.className = `spawn-item${sp.id === selectedSpawnId ? ' selected' : ''}`;

    const dot = document.createElement('div');
    dot.className = 'spawn-dot';
    dot.style.background = spawnColor(sp);
    if (sp.dirty) dot.style.boxShadow = '0 0 5px rgba(200,80,200,0.8)';

    const info = document.createElement('div');
    info.className = 'spawn-item-info';
    info.innerHTML =
      `<div>#${sp.id}${sp.dirty ? ' *' : ''} — lv${sp.level_min}–${sp.level_max} ×${sp.fleet_min}–${sp.fleet_max} <span style="color:rgba(200,150,200,0.6)">${Math.round(sp.angle_deg)}°</span></div>` +
      `<div class="coords">(${Math.round(sp.x)}, ${Math.round(sp.y)})</div>`;

    const del = document.createElement('button');
    del.className = 'btn-danger'; del.textContent = '✕'; del.title = 'Delete';
    del.addEventListener('click', e => { e.stopPropagation(); deleteSpawn(sp.id); });

    item.append(dot, info, del);
    item.addEventListener('click', () => selectSpawn(sp.id === selectedSpawnId ? null : sp.id));
    spawnList.appendChild(item);
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function draw(): void {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#0e2240';
  ctx.fillRect(0, 0, W, H);

  const [bx0, by0] = worldToCanvas(0, 0);
  const [bx1, by1] = worldToCanvas(MAP_W, MAP_H);
  ctx.strokeStyle = 'rgba(245,200,66,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);

  if (showGrid) drawGrid(W, H);

  for (const sp of spawnPoints) drawSpawnOccupancyRing(sp);
  for (const isl of islands)     drawIsland(isl); // rotation handle drawn inside drawIsland for selected
  for (const sp of spawnPoints)  drawSpawnPoint(sp);

  // Spawn rotation handle
  if (selectedSpawnId !== null && !isDraggingIsland) {
    const sp = spawnPoints.find(p => p.id === selectedSpawnId);
    if (sp) drawRotationHandle(sp);
  }

  // Cursor crosshair in spawn mode (only when not dragging/rotating)
  if (mode === 'spawn-point' && !isDraggingSpawn && !isRotatingSpawn) {
    const hit = hitTestSpawnCenter(
      offsetX + mouseWorldX * scale, offsetY + mouseWorldY * scale);
    if (!hit) {
      const [cx, cy] = worldToCanvas(mouseWorldX, mouseWorldY);
      ctx.strokeStyle = 'rgba(200,80,200,0.6)';
      ctx.lineWidth = 1;
      const sz = 14;
      ctx.beginPath();
      ctx.moveTo(cx - sz, cy); ctx.lineTo(cx + sz, cy);
      ctx.moveTo(cx, cy - sz); ctx.lineTo(cx, cy + sz);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function drawGrid(W: number, H: number): void {
  const step   = chooseGridStep();
  const startX = Math.floor((-offsetX / scale) / step) * step;
  const startY = Math.floor((-offsetY / scale) / step) * step;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let wx = startX; wx <= MAP_W; wx += step) {
    const [cx] = worldToCanvas(wx, 0); if (cx < -1 || cx > W + 1) continue;
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
  }
  for (let wy = startY; wy <= MAP_H; wy += step) {
    const [, cy] = worldToCanvas(0, wy); if (cy < -1 || cy > H + 1) continue;
    ctx.moveTo(0, cy); ctx.lineTo(W, cy);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(232,213,154,0.25)'; ctx.font = '9px monospace';
  for (let wx = startX; wx <= MAP_W; wx += step) {
    const [cx] = worldToCanvas(wx, 0); if (cx < 0 || cx > W) continue;
    ctx.fillText(String(Math.round(wx)), cx + 2, 10);
  }
  for (let wy = startY; wy <= MAP_H; wy += step) {
    const [, cy] = worldToCanvas(0, wy); if (cy < 0 || cy > H) continue;
    ctx.fillText(String(Math.round(wy)), 2, cy - 2);
  }
}

function chooseGridStep(): number {
  const w = MAP_W / scale;
  for (const s of [1000, 2000, 5000, 10000, 20000, 50000]) if (w / s < 20) return s;
  return 50000;
}

function drawIsland(isl: IslandState): void {
  const [cx, cy] = worldToCanvas(isl.editX, isl.editY);
  const sel = isl.id === selectedIslandId;

  // Build display verts: rotate template verts by editRotDeg
  const displayOuter   = isl.templateVerts   ? rotateVerts(isl.templateVerts,   isl.editRotDeg) : null;
  const displayShallow = isl.templateShallow ? rotateVerts(isl.templateShallow, isl.editRotDeg) : null;

  ctx.save();

  if (displayOuter && displayOuter.length > 2) {
    const screenR = estimatePolyRadius(displayOuter) * scale;

    if (displayShallow && displayShallow.length > 2) {
      ctx.beginPath();
      displayShallow.forEach((v, i) => i === 0 ? ctx.moveTo(cx + v.x * scale, cy + v.y * scale) : ctx.lineTo(cx + v.x * scale, cy + v.y * scale));
      ctx.closePath(); ctx.fillStyle = 'rgba(30,100,160,0.35)'; ctx.fill();
    }

    ctx.beginPath();
    displayOuter.forEach((v, i) => i === 0 ? ctx.moveTo(cx + v.x * scale, cy + v.y * scale) : ctx.lineTo(cx + v.x * scale, cy + v.y * scale));
    ctx.closePath();
    ctx.fillStyle   = sel ? '#5bcf8a' : islandColor(isl.id);
    ctx.fill();
    ctx.strokeStyle = isl.dirty ? '#f5c842' : (sel ? '#fff' : 'rgba(255,255,255,0.4)');
    ctx.lineWidth   = sel ? 2 : 1;
    ctx.stroke();

    ctx.beginPath(); ctx.arc(cx, cy, Math.max(3, screenR * 0.04), 0, Math.PI * 2);
    ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.5)'; ctx.fill();

    if (screenR > 20) {
      ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.font = `bold ${Math.max(10, Math.min(14, screenR * 0.1))}px monospace`;
      ctx.textAlign = 'center'; ctx.fillText(`${isl.id}`, cx, cy + 4);
    }

    // Rotation handle for selected polygon islands
    if (sel) drawIslandRotHandle(isl);

  } else {
    const r  = (isl.grassRadius ?? isl.beachRadius ?? 2500) * scale;
    const sr = (isl.beachRadius ?? 2500) * scale * 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, sr, 0, Math.PI * 2); ctx.fillStyle = 'rgba(30,100,160,0.35)'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r,  0, Math.PI * 2);
    ctx.fillStyle   = sel ? '#5bcf8a' : islandColor(isl.id); ctx.fill();
    ctx.strokeStyle = isl.dirty ? '#f5c842' : (sel ? '#fff' : 'rgba(255,255,255,0.4)');
    ctx.lineWidth   = sel ? 2 : 1; ctx.stroke();
    if (r > 6) {
      ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.font = `bold ${Math.max(10, Math.min(14, r * 0.3))}px monospace`;
      ctx.textAlign = 'center'; ctx.fillText(`${isl.id}`, cx, cy + 4);
    }
  }

  ctx.restore();
}

function drawIslandRotHandle(isl: IslandState): void {
  const [hx, hy] = islandHandlePos(isl);
  const [cx, cy] = worldToCanvas(isl.editX, isl.editY);

  ctx.save();
  // Line from centre to handle
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);

  // Handle circle
  ctx.beginPath(); ctx.arc(hx, hy, 8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();

  // Small arc icon inside handle
  ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 1.5);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.restore();
}

function estimatePolyRadius(verts: { x: number; y: number }[]): number {
  return verts.reduce((m, v) => Math.max(m, Math.hypot(v.x, v.y)), 0);
}

function drawSpawnOccupancyRing(sp: SpawnPoint): void {
  const [cx, cy] = worldToCanvas(sp.x, sp.y);
  const r = SPAWN_OCCUPIED_R_WORLD * scale;
  if (r < 2) return;
  const sel = sp.id === selectedSpawnId;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = sel ? 'rgba(200,100,220,0.35)' : 'rgba(180,60,180,0.12)';
  ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
}

function drawSpawnPoint(sp: SpawnPoint): void {
  const [cx, cy] = worldToCanvas(sp.x, sp.y);
  const sel    = sp.id === selectedSpawnId;
  const color  = spawnColor(sp);
  const r      = spawnScreenRadius(sp);

  ctx.save();

  // Outer ring
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle   = sel ? `${color}33` : `${color}18`;
  ctx.fill();
  ctx.strokeStyle = sel ? color : `${color}88`;
  ctx.lineWidth   = sel ? 2 : 1;
  ctx.stroke();

  // Direction arrow line from centre (shows angle_deg)
  const arrowLen = Math.max(r * 0.7, 8);
  const rad = sp.angle_deg * (Math.PI / 180);
  const ax = cx + Math.cos(rad) * arrowLen;
  const ay = cy + Math.sin(rad) * arrowLen;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ax, ay);
  ctx.strokeStyle = sel ? '#fff' : `${color}cc`;
  ctx.lineWidth   = sel ? 2 : 1;
  ctx.stroke();

  // Arrowhead
  const headLen = Math.max(5, arrowLen * 0.3);
  const headAngle = 0.45;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - headLen * Math.cos(rad - headAngle), ay - headLen * Math.sin(rad - headAngle));
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - headLen * Math.cos(rad + headAngle), ay - headLen * Math.sin(rad + headAngle));
  ctx.stroke();

  // Centre dot
  const dotR = Math.max(5, Math.min(12, r * 0.3));
  ctx.beginPath(); ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }

  // Labels
  if (r > 8 || scale > 0.001) {
    const fz = Math.max(9, Math.min(12, r * 0.3));
    ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.8)';
    ctx.font = `bold ${fz}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`lv${sp.level_min}–${sp.level_max}`, cx, cy - dotR - 3);
    ctx.font = `${Math.max(8, fz - 1)}px monospace`;
    ctx.fillStyle = 'rgba(200,150,200,0.7)';
    ctx.fillText(`×${sp.fleet_min}–${sp.fleet_max}`, cx, cy + dotR + 10);
    ctx.fillStyle = 'rgba(200,150,200,0.45)';
    ctx.fillText(`#${sp.id}`, cx, cy + dotR + 20);
  }

  ctx.restore();
}

function drawRotationHandle(sp: SpawnPoint): void {
  const [hx, hy] = spawnHandlePos(sp);
  ctx.save();
  // Line from occupancy ring edge to handle (already drawn in arrow, this is the outer handle dot)
  ctx.beginPath(); ctx.arc(hx, hy, 8, 0, Math.PI * 2);
  ctx.fillStyle   = 'rgba(255,255,255,0.15)';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  // Rotation icon suggestion — small arc inside handle
  ctx.beginPath();
  ctx.arc(hx, hy, 4, 0, Math.PI * 1.5);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  // arrowhead on arc end
  const endAngle = Math.PI * 1.5;
  ctx.beginPath();
  ctx.moveTo(hx + 4 * Math.cos(endAngle), hy + 4 * Math.sin(endAngle));
  ctx.lineTo(hx + 4 * Math.cos(endAngle) + 4, hy + 4 * Math.sin(endAngle) - 2);
  ctx.stroke();
  ctx.restore();
}

// ── Viewport / zoom ───────────────────────────────────────────────────────────

function fitAll(): void {
  const W = canvas.width, H = canvas.height, m = 30;
  scale   = Math.min((W - m * 2) / MAP_W, (H - m * 2) / MAP_H);
  offsetX = m + (W - m * 2 - MAP_W * scale) / 2;
  offsetY = m + (H - m * 2 - MAP_H * scale) / 2;
  draw();
}

function zoomAtPoint(px: number, py: number, factor: number): void {
  const wx = (px - offsetX) / scale, wy = (py - offsetY) / scale;
  scale = clamp(scale * factor, 0.00015, 0.08);
  offsetX = px - wx * scale; offsetY = py - wy * scale;
  draw();
}

// ── Events ────────────────────────────────────────────────────────────────────

function resizeCanvas(): void {
  const wrap = document.getElementById('canvas-wrap')!;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  draw();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const py = (e.clientY - rect.top)  * (canvas.height / rect.height);
  zoomAtPoint(px, py, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const [wx, wy] = canvasToWorld(cx, cy);

  if (mode === 'spawn-point' && e.button === 0) {
    // Rotation handle takes priority (only when a point is selected)
    const handleHit = hitTestSpawnHandle(cx, cy);
    if (handleHit) {
      isRotatingSpawn = true;
      dragSpawnId = handleHit.id;
      return;
    }

    // Hit-test spawn center for drag-to-move
    const centerHit = hitTestSpawnCenter(cx, cy);
    if (centerHit) {
      // First click selects; second click on already selected starts drag
      if (centerHit.id === selectedSpawnId) {
        isDraggingSpawn  = true;
        dragSpawnId      = centerHit.id;
        dragStartCanvasX = cx;
        dragStartCanvasY = cy;
        dragStartWorldX  = centerHit.x;
        dragStartWorldY  = centerHit.y;
        canvas.style.cursor = 'move';
      } else {
        selectSpawn(centerHit.id);
        draw();
      }
      return;
    }

    // Click on empty water → place new spawn point
    addSpawnPoint(wx, wy);
    return;
  }

  if (mode === 'move-island' && e.button === 0) {
    // Rotation handle takes priority over drag
    const rotHit = hitTestIslandHandle(cx, cy);
    if (rotHit) {
      isRotatingIsland = true;
      dragIslandId     = rotHit.id;
      canvas.style.cursor = 'ew-resize';
      return;
    }
    const hit = hitTestIsland(cx, cy);
    if (hit) {
      isDraggingIsland = true;
      dragIslandId     = hit.id;
      dragStartCanvasX = cx; dragStartCanvasY = cy;
      dragStartWorldX  = hit.editX; dragStartWorldY = hit.editY;
      selectIsland(hit.id);
      canvas.classList.add('cursor-move');
      return;
    }
  }

  if (e.button === 1 || (e.button === 0 && mode === 'view') ||
      (e.button === 0 && mode === 'move-island' && !isDraggingIsland) ||
      (e.button === 0 && mode === 'spawn-point' && !isDraggingSpawn && !isRotatingSpawn)) {
    isPanning = true;
    panStartX = e.clientX; panStartY = e.clientY;
    panStartOffX = offsetX; panStartOffY = offsetY;
    canvas.classList.add('cursor-grab');
  }
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const [wx, wy] = canvasToWorld(cx, cy);
  mouseWorldX = wx; mouseWorldY = wy;
  coordsDisplay.textContent = `World: (${Math.round(wx)}, ${Math.round(wy)})`;

  // Rotating island
  if (isRotatingIsland && dragIslandId !== null) {
    const isl = islands.find(i => i.id === dragIslandId);
    if (isl) {
      const [icx, icy] = worldToCanvas(isl.editX, isl.editY);
      const ang = Math.atan2(cy - icy, cx - icx) * (180 / Math.PI);
      isl.editRotDeg = ((ang % 360) + 360) % 360;
      isl.dirty      = true;
      updateIslandDetail();
      renderIslandList();
      draw();
    }
    return;
  }

  // Rotating spawn point
  if (isRotatingSpawn && dragSpawnId !== null) {
    const sp = spawnPoints.find(p => p.id === dragSpawnId);
    if (sp) {
      const [scx, scy] = worldToCanvas(sp.x, sp.y);
      const ang = Math.atan2(cy - scy, cx - scx) * (180 / Math.PI);
      sp.angle_deg = ((ang % 360) + 360) % 360;
      sp.dirty     = true;
      if (selectedSpawnId === sp.id) selSpawnAngle.value = String(Math.round(sp.angle_deg));
      renderSpawnList(); draw();
    }
    return;
  }

  // Dragging spawn point
  if (isDraggingSpawn && dragSpawnId !== null) {
    const sp = spawnPoints.find(p => p.id === dragSpawnId);
    if (sp) {
      const dxW = (cx - dragStartCanvasX) / scale;
      const dyW = (cy - dragStartCanvasY) / scale;
      sp.x     = clamp(dragStartWorldX + dxW, 1000, MAP_W - 1000);
      sp.y     = clamp(dragStartWorldY + dyW, 1000, MAP_H - 1000);
      sp.dirty = true;
      renderSpawnList(); draw();
    }
    return;
  }

  // Dragging island
  if (isDraggingIsland && dragIslandId !== null) {
    const isl = islands.find(i => i.id === dragIslandId);
    if (isl) {
      isl.editX = clamp(dragStartWorldX + (cx - dragStartCanvasX) / scale, 0, MAP_W);
      isl.editY = clamp(dragStartWorldY + (cy - dragStartCanvasY) / scale, 0, MAP_H);
      isl.dirty = true;
      updateIslandDetail(); renderIslandList();
    }
    draw(); return;
  }

  // Panning
  if (isPanning) {
    offsetX = panStartOffX + (e.clientX - panStartX);
    offsetY = panStartOffY + (e.clientY - panStartY);
    draw(); return;
  }

  // Cursor hints
  if (mode === 'move-island') {
    if (hitTestIslandHandle(cx, cy))      canvas.style.cursor = 'ew-resize';
    else if (hitTestIsland(cx, cy))       canvas.style.cursor = 'grab';
    else                                  canvas.style.cursor = 'default';
  } else if (mode === 'spawn-point') {
    if (hitTestSpawnHandle(cx, cy))       canvas.style.cursor = 'ew-resize';
    else if (hitTestSpawnCenter(cx, cy))  canvas.style.cursor = selectedSpawnId === hitTestSpawnCenter(cx, cy)?.id ? 'move' : 'pointer';
    else                                  canvas.style.cursor = 'crosshair';
    draw(); // refresh crosshair / hover highlighting
  }
});

canvas.addEventListener('mouseup', () => {
  if (isDraggingSpawn)  { isDraggingSpawn  = false; dragSpawnId  = null; canvas.style.cursor = 'crosshair'; }
  if (isRotatingSpawn)  { isRotatingSpawn  = false; dragSpawnId  = null; canvas.style.cursor = 'crosshair'; }
  if (isRotatingIsland) { isRotatingIsland = false; dragIslandId = null; canvas.style.cursor = 'default'; }
  if (isDraggingIsland) { isDraggingIsland = false; dragIslandId = null; canvas.classList.remove('cursor-move'); canvas.style.cursor = 'grab'; }
  if (isPanning)        { isPanning = false; canvas.classList.remove('cursor-grab'); canvas.style.cursor = mode === 'spawn-point' ? 'crosshair' : 'default'; }
});

canvas.addEventListener('mouseleave', () => {
  isPanning = isDraggingIsland = isDraggingSpawn = isRotatingSpawn = false;
  if (mode === 'spawn-point') draw();
});

// ── Mode buttons ──────────────────────────────────────────────────────────────

const MODE_HINTS: Record<EditorMode, string> = {
  'view':        'Left-drag to pan · Scroll to zoom',
  'move-island': 'Drag island to move · Drag ↻ handle to rotate (polygon islands)',
  'spawn-point': 'Click open water to place · Click point to select · Drag to move · Drag ↻ handle to rotate',
};

function setMode(m: EditorMode): void {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('.btn[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  modeHint.textContent = MODE_HINTS[m];
  canvas.style.cursor  = m === 'spawn-point' ? 'crosshair' : 'default';
  draw();
}

document.getElementById('btn-view')!.addEventListener('click',  () => setMode('view'));
document.getElementById('btn-move')!.addEventListener('click',  () => setMode('move-island'));
document.getElementById('btn-spawn')!.addEventListener('click', () => setMode('spawn-point'));
document.getElementById('btn-refresh')!.addEventListener('click',  refreshAll);
document.getElementById('btn-fit')!.addEventListener('click',      fitAll);
document.getElementById('btn-zoom-in')!.addEventListener('click',  () => zoomAtPoint(canvas.width / 2, canvas.height / 2, 1.5));
document.getElementById('btn-zoom-out')!.addEventListener('click', () => zoomAtPoint(canvas.width / 2, canvas.height / 2, 1 / 1.5));
document.getElementById('btn-save-islands')!.addEventListener('click',      saveIslandPositions);
document.getElementById('btn-save-spawns')!.addEventListener('click',       saveSpawnPoints);
document.getElementById('btn-apply-island-rot')!.addEventListener('click',  applyIslandRot);
document.getElementById('btn-apply-spawn')!.addEventListener('click',  applySpawnEdit);
document.getElementById('btn-delete-spawn')!.addEventListener('click', () => { if (selectedSpawnId !== null) deleteSpawn(selectedSpawnId); });
document.getElementById('chk-grid')!.addEventListener('change', e => { showGrid = (e.target as HTMLInputElement).checked; draw(); });

// ── Initialise ────────────────────────────────────────────────────────────────

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
fitAll();
refreshAll();
