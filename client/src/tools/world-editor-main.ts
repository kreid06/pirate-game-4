/* world-editor-main.ts — Ghost-ship spawn-point and island position editor.
 *
 * Canvas renders the full world (0–90 000 units) with:
 *  - Islands at their configured centre positions (draggable, rotatable)
 *  - Ghost spawn zones as annotated circles (draggable, resizable)
 *
 * Data round-trips:
 *  GET  /api/islands        → island positions + IDs
 *  POST /api/islands/positions  → save updated positions
 *  GET  /api/ghost-spawns   → spawn zone config
 *  POST /api/ghost-spawns   → save + hot-reload server
 */
export {}; // Make this a proper ES module to avoid global-scope conflicts with other tool files.

// ── Types ────────────────────────────────────────────────────────────────────

interface Vert { x: number; y: number; }

interface IslandEntry {
  id: number;
  cx: number;
  cy: number;
  rotation_deg: number;
  template: string;
  /* Polygon shape (local coords, unrotated). Present when server returns vertex data. */
  outerVerts?:   Vert[];
  grassVerts?:   Vert[];
  shallowVerts?: Vert[];
  grassPolyScale?: number;
  shallowPolyScale?: number;
  /* Fallback circle radii for bump-circle islands */
  beach_radius?: number;
  grass_radius?: number;
}

interface GhostSpawn {
  id: number;
  label: string;
  x: number;
  y: number;
  radius: number;
  level_min: number;
  level_max: number;
  count_min: number;
  count_max: number;
  respawn_delay_s: number;
  active_count?: number;
}

interface GhostSpawnConfig {
  enabled: boolean;
  global_max_cap: number;
  active_total?: number;
  spawns: GhostSpawn[];
}

type EditMode = 'select' | 'add-spawn';

// ── Camera ───────────────────────────────────────────────────────────────────

class Camera {
  x = 45000;
  y = 45000;
  zoom = 0.003;
  readonly WORLD_SIZE = 90000;

  w2s(wx: number, wy: number, cw: number, ch: number): [number, number] {
    const sx = (wx - this.x) * this.zoom + cw / 2;
    const sy = (wy - this.y) * this.zoom + ch / 2;
    return [sx, sy];
  }

  s2w(sx: number, sy: number, cw: number, ch: number): [number, number] {
    const wx = (sx - cw / 2) / this.zoom + this.x;
    const wy = (sy - ch / 2) / this.zoom + this.y;
    return [wx, wy];
  }

  centreOn(wx: number, wy: number) {
    this.x = wx;
    this.y = wy;
  }
}

// ── State ────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const cam = new Camera();

let islands: IslandEntry[] = [];
let spawnConfig: GhostSpawnConfig = { enabled: false, global_max_cap: 0, spawns: [] };
let nextSpawnId = 100;
let editMode: EditMode = 'select';

let selectedIslandId: number | null = null;
let selectedSpawnId: number | null = null;

let isDragging = false;
let dragTarget: { type: 'island'; id: number } | { type: 'spawn'; id: number } | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panCamX = 0;
let panCamY = 0;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $serverUrl   = document.getElementById('server-url')    as HTMLInputElement;
const $status      = document.getElementById('status-bar')!;
const $btnFetch    = document.getElementById('btn-fetch')!;
const $btnRefresh  = document.getElementById('btn-refresh')!;
const $btnSaveIslands = document.getElementById('btn-save-islands')!;
const $btnSaveSpawns  = document.getElementById('btn-save-spawns')!;
const $btnResetView   = document.getElementById('btn-reset-view')!;
const $btnApplySpawn  = document.getElementById('btn-apply-spawn')!;
const $btnDeleteSpawn = document.getElementById('btn-delete-spawn')!;
const $spawnsList    = document.getElementById('spawn-list')!;
const $spawnsEnabled = document.getElementById('spawns-enabled') as HTMLInputElement;
const $modeGroup     = document.getElementById('mode-group')!;
const $coordsEl      = document.getElementById('coords')!;
const $zoomPctEl     = document.getElementById('zoom-pct')!;

// Island panel fields
const $islPanel = document.getElementById('island-panel')!;
const $islName  = document.getElementById('isl-name')!;
const $islX     = document.getElementById('isl-x')     as HTMLInputElement;
const $islY     = document.getElementById('isl-y')     as HTMLInputElement;
const $islRot   = document.getElementById('isl-rot')   as HTMLInputElement;

// Spawn panel fields
const $spPanel    = document.getElementById('spawn-panel')!;
const $spId       = document.getElementById('sp-id')!;
const $spLabel    = document.getElementById('sp-label')    as HTMLInputElement;
const $spX        = document.getElementById('sp-x')        as HTMLInputElement;
const $spY        = document.getElementById('sp-y')        as HTMLInputElement;
const $spRadius   = document.getElementById('sp-radius')   as HTMLInputElement;
const $spLvlMin   = document.getElementById('sp-lvl-min')  as HTMLInputElement;
const $spLvlMax   = document.getElementById('sp-lvl-max')  as HTMLInputElement;
const $spCntMin   = document.getElementById('sp-cnt-min')  as HTMLInputElement;
const $spCntMax   = document.getElementById('sp-cnt-max')  as HTMLInputElement;
const $spRespawn  = document.getElementById('sp-respawn')  as HTMLInputElement;

// Global cap + live count
const $globalCap    = document.getElementById('global-cap')   as HTMLInputElement;
const $activeTotal  = document.getElementById('active-total')!;

// New-zone preset fields
const $defLvlMin  = document.getElementById('def-lvl-min')  as HTMLInputElement;
const $defLvlMax  = document.getElementById('def-lvl-max')  as HTMLInputElement;
const $defCntMin  = document.getElementById('def-cnt-min')  as HTMLInputElement;
const $defCntMax  = document.getElementById('def-cnt-max')  as HTMLInputElement;
const $defRadius  = document.getElementById('def-radius')   as HTMLInputElement;
const $defRespawn = document.getElementById('def-respawn')  as HTMLInputElement;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg: string, kind: '' | 'ok' | 'err' = '') {
  $status.textContent = msg;
  $status.className = kind;
}

function apiUrl(path: string): string {
  let base = $serverUrl.value.trim().replace(/\/$/, '');
  if (!base) base = window.location.origin + '/admin';
  return base + path;
}

/**
 * Level colour gradient: 1 → green (#22c55e), 20 → yellow (#eab308), 40 → orange (#f97316), 60+ → red (#ef4444)
 * Levels are clamped to [1, 60] and interpolated smoothly across two segments:
 *   segment A: 1–20  (green → yellow)
 *   segment B: 20–40 (yellow → orange)
 *   segment C: 40–60 (orange → red)
 */
function spawnColour(sp: GhostSpawn, alpha = 1): string {
  const avg = Math.max(1, (sp.level_min + sp.level_max) / 2);

  // Key-colour stops [r, g, b]
  const stops: [number, number, number][] = [
    [34,  197, 94],   // level  1 — green
    [234, 179,  8],   // level 20 — yellow
    [249, 115, 22],   // level 40 — orange
    [239,  68, 68],   // level 60 — red
  ];
  let t: number;
  let c0: [number, number, number];
  let c1: [number, number, number];

  if (avg <= 20) {
    t  = (avg - 1) / 19;
    c0 = stops[0]; c1 = stops[1];
  } else if (avg <= 40) {
    t  = (avg - 20) / 20;
    c0 = stops[1]; c1 = stops[2];
  } else {
    t  = Math.min((avg - 40) / 20, 1);
    c0 = stops[2]; c1 = stops[3];
  }

  const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
  const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
  const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
  return `rgba(${r},${g},${b},${alpha})`;
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchWorld() {
  setStatus('Fetching…');
  try {
    const [islandRes, spawnRes] = await Promise.all([
      fetch(apiUrl('/api/islands')),
      fetch(apiUrl('/api/ghost-spawns')),
    ]);
    if (!islandRes.ok) throw new Error(`Islands ${islandRes.status}`);
    if (!spawnRes.ok)  throw new Error(`Spawns ${spawnRes.status}`);

    const islandData = await islandRes.json();
    const spawnData  = await spawnRes.json();

    // Normalise island list
    const raw: any[] = islandData.islands ?? islandData ?? [];
    islands = raw.map((e: any) => {
      const isl: IslandEntry = {
        id:           e.id ?? 0,
        cx:           e.cx ?? e.x ?? 0,
        cy:           e.cy ?? e.y ?? 0,
        rotation_deg: e.rotation_deg ?? e.rotation ?? 0,
        template:     e.preset ?? e.template ?? e.name ?? `island_${e.id}`,
        beach_radius: e.beach_radius ?? e.beachRadius ?? 800,
        grass_radius: e.grass_radius ?? e.grassRadius ?? 1400,
        grassPolyScale:   e.grassPolyScale   ?? 0.82,
        shallowPolyScale: e.shallowPolyScale ?? 1.375,
      };
      if (e.outerVerts   && e.outerVerts.length   > 0) isl.outerVerts   = e.outerVerts;
      if (e.grassVerts   && e.grassVerts.length   > 0) isl.grassVerts   = e.grassVerts;
      if (e.shallowVerts && e.shallowVerts.length > 0) isl.shallowVerts = e.shallowVerts;
      return isl;
    });

    spawnConfig = {
      enabled:        spawnData.enabled ?? false,
      global_max_cap: spawnData.global_max_cap ?? 0,
      active_total:   spawnData.active_total ?? 0,
      spawns:  (spawnData.spawns ?? []).map((s: any) => ({
        id:              s.id,
        label:           s.label ?? `Zone ${s.id}`,
        x:               s.x,
        y:               s.y,
        radius:          s.radius ?? 3000,
        level_min:       s.level_min ?? 1,
        level_max:       s.level_max ?? 2,
        count_min:       s.count_min ?? 1,
        count_max:       s.count_max ?? 2,
        respawn_delay_s: s.respawn_delay_s ?? 120,
        active_count:    s.active_count ?? 0,
      })),
    };

    // Compute a good ID for next spawn
    if (spawnConfig.spawns.length > 0)
      nextSpawnId = Math.max(...spawnConfig.spawns.map(s => s.id)) + 1;

    $spawnsEnabled.checked        = spawnConfig.enabled;
    $globalCap.value              = String(spawnConfig.global_max_cap ?? 0);
    $activeTotal.textContent      = String(spawnConfig.active_total ?? 0);
    refreshSpawnList();
    cam.centreOn(45000, 45000);
    setStatus(`Loaded ${islands.length} islands, ${spawnConfig.spawns.length} spawn zones`, 'ok');
    render();
  } catch (e: any) {
    setStatus(`Error: ${e.message}`, 'err');
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function saveIslandPositions() {
  const body = JSON.stringify({
    islands: islands.map(isl => ({
      id:           isl.id,
      centre:       { x: isl.cx, y: isl.cy },
      rotation_deg: isl.rotation_deg,
      template:     isl.template,
    })),
  }, null, 2);

  try {
    setStatus('Saving island positions…');
    const r = await fetch(apiUrl('/api/islands/positions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json = await r.json();
    if (json.ok) {
      setStatus('Island positions saved (restart server to apply)', 'ok');
    } else {
      setStatus(`Save failed: ${json.error}`, 'err');
    }
  } catch (e: any) {
    setStatus(`Error: ${e.message}`, 'err');
  }
}

async function saveGhostSpawns() {
  spawnConfig.enabled        = $spawnsEnabled.checked;
  spawnConfig.global_max_cap = Math.max(0, parseInt($globalCap.value) || 0);
  const body = JSON.stringify(spawnConfig, null, 2);
  try {
    setStatus('Saving ghost spawn config…');
    const r = await fetch(apiUrl('/api/ghost-spawns'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json = await r.json();
    if (json.ok) {
      setStatus('Ghost spawn config saved & hot-reloaded', 'ok');
    } else {
      setStatus(`Save failed: ${json.error}`, 'err');
    }
  } catch (e: any) {
    setStatus(`Error: ${e.message}`, 'err');
  }
}

// ── Spawn list UI ─────────────────────────────────────────────────────────────

function refreshSpawnList() {
  $spawnsList.innerHTML = '';
  spawnConfig.spawns.forEach(sp => {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:5px;padding:3px 0;cursor:pointer;
      border-bottom:1px solid #1a2436;font-size:11px;`;
    const dot = document.createElement('div');
    dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${spawnColour(sp)};`;
    const txt = document.createElement('span');
    txt.textContent = `#${sp.id} ${sp.label} (Lv${sp.level_min}–${sp.level_max})`;
    txt.style.flex = '1';
    if (selectedSpawnId === sp.id) {
      row.style.color = '#a78bfa';
    }
    row.append(dot, txt);
    row.addEventListener('click', () => selectSpawn(sp.id));
    $spawnsList.appendChild(row);
  });
}

// ── Selection panels ──────────────────────────────────────────────────────────

function selectIsland(id: number | null) {
  selectedIslandId = id;
  selectedSpawnId = null;
  $spPanel.classList.remove('visible');
  if (id === null) {
    $islPanel.classList.remove('visible');
    return;
  }
  const isl = islands.find(i => i.id === id);
  if (!isl) return;
  $islPanel.classList.add('visible');
  $islName.textContent = isl.template || `Island ${id}`;
  $islX.value   = String(Math.round(isl.cx));
  $islY.value   = String(Math.round(isl.cy));
  $islRot.value = String(Math.round(isl.rotation_deg));
}

function selectSpawn(id: number | null) {
  selectedSpawnId = id;
  selectedIslandId = null;
  $islPanel.classList.remove('visible');
  if (id === null) {
    $spPanel.classList.remove('visible');
    refreshSpawnList();
    return;
  }
  const sp = spawnConfig.spawns.find(s => s.id === id);
  if (!sp) return;
  $spPanel.classList.add('visible');
  $spId.textContent     = String(sp.id);
  $spLabel.value        = sp.label;
  $spX.value            = String(Math.round(sp.x));
  $spY.value            = String(Math.round(sp.y));
  $spRadius.value       = String(Math.round(sp.radius));
  $spLvlMin.value       = String(sp.level_min);
  $spLvlMax.value       = String(sp.level_max);
  $spCntMin.value       = String(sp.count_min);
  $spCntMax.value       = String(sp.count_max);
  $spRespawn.value      = String(sp.respawn_delay_s);
  refreshSpawnList();
}

function applySpawnPanel() {
  if (selectedSpawnId === null) return;
  const sp = spawnConfig.spawns.find(s => s.id === selectedSpawnId);
  if (!sp) return;
  sp.label           = $spLabel.value || sp.label;
  sp.x               = parseFloat($spX.value)        || sp.x;
  sp.y               = parseFloat($spY.value)        || sp.y;
  sp.radius          = clamp(parseFloat($spRadius.value)  || sp.radius, 500, 20000);
  sp.level_min       = clamp(parseInt($spLvlMin.value)    || sp.level_min, 1, 60);
  sp.level_max       = clamp(parseInt($spLvlMax.value)    || sp.level_max, 1, 60);
  if (sp.level_max < sp.level_min) sp.level_max = sp.level_min;
  sp.count_min       = clamp(parseInt($spCntMin.value)    || sp.count_min, 0, 10);
  sp.count_max       = clamp(parseInt($spCntMax.value)    || sp.count_max, 0, 10);
  if (sp.count_max < sp.count_min) sp.count_max = sp.count_min;
  sp.respawn_delay_s = clamp(parseFloat($spRespawn.value) || sp.respawn_delay_s, 10, 3600);
  refreshSpawnList();
  render();
}

function deleteSpawn() {
  if (selectedSpawnId === null) return;
  spawnConfig.spawns = spawnConfig.spawns.filter(s => s.id !== selectedSpawnId);
  selectedSpawnId = null;
  $spPanel.classList.remove('visible');
  refreshSpawnList();
  render();
}

function addSpawnAt(wx: number, wy: number) {
  const id = nextSpawnId++;
  const sp: GhostSpawn = {
    id,
    label:           `Zone ${id}`,
    x:               Math.round(wx),
    y:               Math.round(wy),
    radius:          Math.max(500, parseInt($defRadius.value)  || 3000),
    level_min:       Math.max(1,   parseInt($defLvlMin.value)  || 1),
    level_max:       Math.max(1,   parseInt($defLvlMax.value)  || 3),
    count_min:       Math.max(0,   parseInt($defCntMin.value)  || 1),
    count_max:       Math.max(1,   parseInt($defCntMax.value)  || 2),
    respawn_delay_s: Math.max(10,  parseFloat($defRespawn.value) || 120),
    active_count:    0,
  };
  spawnConfig.spawns.push(sp);
  refreshSpawnList();
  selectSpawn(sp.id);
  render();
}

// ── Hit testing ───────────────────────────────────────────────────────────────

function hitTestSpawn(wx: number, wy: number): number | null {
  // Test from last to first so topmost renders last = gets hit first
  for (let i = spawnConfig.spawns.length - 1; i >= 0; i--) {
    const sp = spawnConfig.spawns[i];
    const dx = wx - sp.x;
    const dy = wy - sp.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= sp.radius) return sp.id;
  }
  return null;
}

function hitTestIsland(wx: number, wy: number): number | null {
  for (let i = islands.length - 1; i >= 0; i--) {
    const isl = islands[i];
    const r   = isl.grass_radius ?? 1400;
    const dx  = wx - isl.cx;
    const dy  = wy - isl.cy;
    if (dx * dx + dy * dy <= r * r) return isl.id;
  }
  return null;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function resize() {
  const wrap = document.getElementById('canvas-wrap')!;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  render();
}

function render() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  drawOcean(W, H);
  drawGrid(W, H);
  drawIslands(W, H);
  drawSpawnZones(W, H);
  drawSpawnZoneLabels(W, H);
}

function drawOcean(W: number, H: number) {
  ctx.fillStyle = '#060c18';
  ctx.fillRect(0, 0, W, H);

  // World boundary
  const [x0, y0] = cam.w2s(0, 0, W, H);
  const [x1, y1] = cam.w2s(cam.WORLD_SIZE, cam.WORLD_SIZE, W, H);
  ctx.strokeStyle = '#1e3a5f';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);
}

function drawGrid(W: number, H: number) {
  // Draw grid lines every 10 000 units
  const STEP = 10000;
  ctx.strokeStyle = 'rgba(30,58,95,0.4)';
  ctx.lineWidth   = 0.5;

  for (let gx = 0; gx <= cam.WORLD_SIZE; gx += STEP) {
    const [sx0, sy0] = cam.w2s(gx, 0, W, H);
    const [sx1, sy1] = cam.w2s(gx, cam.WORLD_SIZE, W, H);
    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.stroke();
  }
  for (let gy = 0; gy <= cam.WORLD_SIZE; gy += STEP) {
    const [sx0, sy0] = cam.w2s(0, gy, W, H);
    const [sx1, sy1] = cam.w2s(cam.WORLD_SIZE, gy, W, H);
    ctx.beginPath();
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.stroke();
  }

  // Coordinate labels at grid intersections (only when zoomed in enough)
  if (cam.zoom > 0.006) {
    ctx.fillStyle = 'rgba(71,85,105,0.7)';
    ctx.font = '9px monospace';
    for (let gx = 0; gx <= cam.WORLD_SIZE; gx += STEP) {
      for (let gy = 0; gy <= cam.WORLD_SIZE; gy += STEP) {
        const [sx, sy] = cam.w2s(gx, gy, W, H);
        ctx.fillText(`${gx / 1000}k,${gy / 1000}k`, sx + 3, sy - 3);
      }
    }
  }
}

/**
 * Translate a pre-rotated local vertex into screen coordinates.
 *
 * The server bakes rotation_deg into all vertex arrays via islands_apply_rotations()
 * at startup, so vertices from the API are already in the correct orientation.
 * We simply add the island centre (cx, cy) to get world coords.
 */
function islVertToScreen(isl: IslandEntry, lx: number, ly: number, W: number, H: number): [number, number] {
  return cam.w2s(isl.cx + lx, isl.cy + ly, W, H);
}

function drawPolyPath(isl: IslandEntry, verts: { x: number; y: number }[], W: number, H: number) {
  ctx.beginPath();
  for (let i = 0; i < verts.length; i++) {
    const [sx, sy] = islVertToScreen(isl, verts[i].x, verts[i].y, W, H);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
}

function drawIslands(W: number, H: number) {
  for (const isl of islands) {
    const [sx, sy] = cam.w2s(isl.cx, isl.cy, W, H);
    const isSelected = isl.id === selectedIslandId;

    if (isl.outerVerts && isl.outerVerts.length >= 3) {
      // ── Polygon island ──────────────────────────────────────────────────────

      // Shallow water polygon
      if (isl.shallowVerts && isl.shallowVerts.length >= 3) {
        drawPolyPath(isl, isl.shallowVerts, W, H);
        ctx.fillStyle = 'rgba(5,18,40,0.75)';
        ctx.fill();
      }

      // Sand (outer) polygon
      drawPolyPath(isl, isl.outerVerts, W, H);
      ctx.fillStyle = isSelected ? 'rgba(196,181,253,0.35)' : 'rgba(200,168,92,0.75)';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#a78bfa' : 'rgba(200,168,92,0.6)';
      ctx.lineWidth   = isSelected ? 2 : 0.8;
      ctx.stroke();

      // Grass polygon
      const grassVerts = isl.grassVerts && isl.grassVerts.length >= 3
        ? isl.grassVerts
        : null;
      if (grassVerts) {
        drawPolyPath(isl, grassVerts, W, H);
        ctx.fillStyle = isSelected ? 'rgba(139,92,246,0.4)' : 'rgba(22,101,52,0.8)';
        ctx.fill();
      }

      // Orientation arrow: points in the direction of rotation_deg (degrees CW from +X)
      // Vertices are already pre-rotated, so we compute the tip directly in world space.
      const rotRad   = (isl.rotation_deg * Math.PI) / 180;
      const arrowLen = 700; // world units
      const [ex, ey] = cam.w2s(
        isl.cx + arrowLen * Math.cos(rotRad),
        isl.cy + arrowLen * Math.sin(rotRad),
        W, H,
      );
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = isSelected ? '#c4b5fd' : '#22d3ee';
      ctx.lineWidth   = isSelected ? 2.5 : 1.5;
      ctx.stroke();
      // Arrow head
      const arrowHeadLen = Math.max(6, 60 * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(
        ex - arrowHeadLen * Math.cos(rotRad - 0.4),
        ey - arrowHeadLen * Math.sin(rotRad - 0.4),
      );
      ctx.lineTo(
        ex - arrowHeadLen * Math.cos(rotRad + 0.4),
        ey - arrowHeadLen * Math.sin(rotRad + 0.4),
      );
      ctx.closePath();
      ctx.fillStyle = isSelected ? '#c4b5fd' : '#22d3ee';
      ctx.fill();

    } else {
      // ── Fallback: bump-circle island ────────────────────────────────────────
      const r_grass = (isl.grass_radius ?? 1400) * cam.zoom;
      const r_beach = (isl.beach_radius ?? 800)  * cam.zoom;

      // Shallow water
      ctx.beginPath();
      ctx.arc(sx, sy, r_grass * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(7,28,55,0.7)';
      ctx.fill();

      // Beach ring
      ctx.beginPath();
      ctx.arc(sx, sy, r_grass, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? 'rgba(124,58,237,0.25)' : 'rgba(200,168,92,0.5)';
      ctx.fill();

      // Inner grass
      ctx.beginPath();
      ctx.arc(sx, sy, r_beach, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? 'rgba(139,92,246,0.45)' : 'rgba(22,101,52,0.6)';
      ctx.fill();

      // Rotation indicator line
      const rotRad = (isl.rotation_deg * Math.PI) / 180;
      const lineLen = r_beach * 1.2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(rotRad) * lineLen, sy + Math.sin(rotRad) * lineLen);
      ctx.strokeStyle = isSelected ? '#a78bfa' : '#22d3ee';
      ctx.lineWidth   = isSelected ? 2 : 1;
      ctx.stroke();

      // Outline
      ctx.beginPath();
      ctx.arc(sx, sy, r_grass, 0, Math.PI * 2);
      ctx.strokeStyle = isSelected ? '#a78bfa' : '#22d3ee';
      ctx.lineWidth   = isSelected ? 2 : 0.8;
      ctx.stroke();
    }

    // Label (only when large enough)
    const labelMinPx = 8;
    const labelSz = Math.max(9, Math.min(14, cam.zoom * 1200));
    if (labelSz > labelMinPx) {
      ctx.font = `${labelSz}px sans-serif`;
      ctx.fillStyle = isSelected ? '#c4b5fd' : '#67e8f9';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isl.template || `#${isl.id}`, sx, sy);
    }
  }
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawSpawnZones(W: number, H: number) {
  for (const sp of spawnConfig.spawns) {
    const [sx, sy] = cam.w2s(sp.x, sp.y, W, H);
    const sr       = sp.radius * cam.zoom;
    const isSelected = sp.id === selectedSpawnId;
    const col = isSelected ? '#a78bfa' : spawnColour(sp);
    const colA = isSelected ? 'rgba(167,139,250,0.12)' : spawnColour(sp, 0.08);

    // Fill
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fillStyle = colA;
    ctx.fill();

    // Border (dashed)
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.setLineDash(isSelected ? [] : [5, 4]);
    ctx.strokeStyle = col;
    ctx.lineWidth   = isSelected ? 2 : 1.2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Centre cross
    const cs = Math.min(8, sr * 0.15 + 3);
    ctx.beginPath();
    ctx.moveTo(sx - cs, sy); ctx.lineTo(sx + cs, sy);
    ctx.moveTo(sx, sy - cs); ctx.lineTo(sx, sy + cs);
    ctx.strokeStyle = col;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Active count badge
    if ((sp.active_count ?? 0) > 0) {
      ctx.beginPath();
      ctx.arc(sx + cs + 5, sy - cs - 5, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#15803d';
      ctx.fill();
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(sp.active_count), sx + cs + 5, sy - cs - 5);
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }
}

function drawSpawnZoneLabels(W: number, H: number) {
  for (const sp of spawnConfig.spawns) {
    const [sx, sy] = cam.w2s(sp.x, sp.y, W, H);
    const sr       = sp.radius * cam.zoom;
    if (sr < 20) continue;

    const isSelected = sp.id === selectedSpawnId;
    const col = isSelected ? '#c4b5fd' : spawnColour(sp);
    const fontSize = Math.max(10, Math.min(14, sr * 0.12));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = col;
    ctx.textAlign = 'center';

    ctx.fillText(sp.label, sx, sy + sr * 0.35 + fontSize);
    ctx.font = `${fontSize - 1}px sans-serif`;
    ctx.fillStyle = 'rgba(200,212,232,0.7)';
    ctx.fillText(`Lv${sp.level_min}–${sp.level_max} | ${sp.count_min}–${sp.count_max} ships`, sx, sy + sr * 0.35 + fontSize * 2.3);
    ctx.fillText(`Respawn: ${sp.respawn_delay_s}s`, sx, sy + sr * 0.35 + fontSize * 3.5);

    ctx.textAlign = 'left';
  }
}

// ── Pointer events ────────────────────────────────────────────────────────────

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  cam.zoom = clamp(cam.zoom * factor, 0.0005, 0.05);
  $zoomPctEl.textContent = `${Math.round(cam.zoom / 0.003 * 100)}%`;
  render();
}, { passive: false });

canvas.addEventListener('pointerdown', e => {
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const sy = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const [wx, wy] = cam.s2w(sx, sy, canvas.width, canvas.height);

  if (e.button === 1 || e.button === 2) {
    // Middle / right: pan
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panCamX   = cam.x;
    panCamY   = cam.y;
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (editMode === 'add-spawn') {
    addSpawnAt(wx, wy);
    return;
  }

  // Select mode: check spawn first (they're on top), then island
  const spId  = hitTestSpawn(wx, wy);
  const islId = spId !== null ? null : hitTestIsland(wx, wy);

  if (spId !== null) {
    selectSpawn(spId);
    isDragging    = true;
    dragTarget    = { type: 'spawn', id: spId };
    const sp      = spawnConfig.spawns.find(s => s.id === spId)!;
    dragOffsetX   = wx - sp.x;
    dragOffsetY   = wy - sp.y;
  } else if (islId !== null) {
    selectIsland(islId);
    isDragging    = true;
    dragTarget    = { type: 'island', id: islId };
    const isl     = islands.find(i => i.id === islId)!;
    dragOffsetX   = wx - isl.cx;
    dragOffsetY   = wy - isl.cy;
  } else {
    selectIsland(null);
    selectSpawn(null);
    refreshSpawnList();
    // Begin pan on left click in open water
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panCamX   = cam.x;
    panCamY   = cam.y;
    canvas.style.cursor = 'grabbing';
  }

  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  render();
});

canvas.addEventListener('pointermove', e => {
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const sy = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const [wx, wy] = cam.s2w(sx, sy, canvas.width, canvas.height);

  $coordsEl.textContent = `${Math.round(wx)}, ${Math.round(wy)}`;

  if (isPanning) {
    const dx = (e.clientX - panStartX) / cam.zoom;
    const dy = (e.clientY - panStartY) / cam.zoom;
    cam.x = panCamX - dx;
    cam.y = panCamY - dy;
    render();
    return;
  }

  if (!isDragging || !dragTarget) return;

  if (dragTarget.type === 'spawn') {
    const sp = spawnConfig.spawns.find(s => s.id === dragTarget!.id);
    if (sp) {
      sp.x = Math.round(wx - dragOffsetX);
      sp.y = Math.round(wy - dragOffsetY);
      if (selectedSpawnId === sp.id) {
        $spX.value = String(sp.x);
        $spY.value = String(sp.y);
      }
    }
  } else if (dragTarget.type === 'island') {
    const isl = islands.find(i => i.id === dragTarget!.id);
    if (isl) {
      isl.cx = Math.round(wx - dragOffsetX);
      isl.cy = Math.round(wy - dragOffsetY);
      if (selectedIslandId === isl.id) {
        $islX.value = String(isl.cx);
        $islY.value = String(isl.cy);
      }
    }
  }
  render();
});

canvas.addEventListener('pointerup', () => {
  isDragging  = false;
  dragTarget  = null;
  isPanning   = false;
  canvas.style.cursor = 'crosshair';
});

canvas.addEventListener('pointerleave', () => {
  isDragging  = false;
  dragTarget  = null;
  isPanning   = false;
  canvas.style.cursor = 'crosshair';
});

canvas.addEventListener('contextmenu', e => e.preventDefault());

// ── Island field input sync ───────────────────────────────────────────────────

function syncIslandFromPanel() {
  if (selectedIslandId === null) return;
  const isl = islands.find(i => i.id === selectedIslandId);
  if (!isl) return;
  const nx = parseFloat($islX.value);
  const ny = parseFloat($islY.value);
  const nr = parseFloat($islRot.value);
  if (!isNaN(nx)) isl.cx = nx;
  if (!isNaN(ny)) isl.cy = ny;
  if (!isNaN(nr)) isl.rotation_deg = nr;
  render();
}
$islX.addEventListener('change', syncIslandFromPanel);
$islY.addEventListener('change', syncIslandFromPanel);
$islRot.addEventListener('change', syncIslandFromPanel);

// ── Button wiring ─────────────────────────────────────────────────────────────

$btnFetch.addEventListener('click',        fetchWorld);
$btnRefresh.addEventListener('click',      fetchWorld);
$btnSaveIslands.addEventListener('click',  saveIslandPositions);
$btnSaveSpawns.addEventListener('click',   saveGhostSpawns);
$btnApplySpawn.addEventListener('click',   applySpawnPanel);
$btnDeleteSpawn.addEventListener('click',  deleteSpawn);
$btnResetView.addEventListener('click', () => {
  cam.centreOn(45000, 45000);
  cam.zoom = 0.003;
  $zoomPctEl.textContent = '100%';
  render();
});

$spawnsEnabled.addEventListener('change', () => {
  spawnConfig.enabled = $spawnsEnabled.checked;
});

$globalCap.addEventListener('change', () => {
  spawnConfig.global_max_cap = Math.max(0, parseInt($globalCap.value) || 0);
});

// Edit mode buttons
$modeGroup.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    $modeGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    editMode = btn.dataset.mode as EditMode;
    canvas.style.cursor = editMode === 'add-spawn' ? 'cell' : 'crosshair';
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

new ResizeObserver(resize).observe(document.getElementById('canvas-wrap')!);
resize();

// In local dev (Vite proxy) and production (nginx) the admin API lives at /admin.
// Direct access to port 8081 also works (no base path needed in that case).
const defaultBase = window.location.origin + '/admin';
if (!$serverUrl.value) $serverUrl.value = defaultBase;

// Auto-fetch on load (best-effort)
fetchWorld().catch(() => {});
