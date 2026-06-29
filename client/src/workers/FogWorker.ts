/**
 * FogWorker — off-main-thread fog ray casting.
 *
 * Protocol:
 *   Main → Worker  { type: 'INIT',    islands: FogIsland[] }
 *   Main → Worker  { type: 'COMPUTE', x: number, y: number }
 *   Worker → Main  Float32Array(N)  (ray hit distances, world units)
 *
 * Islands are sent once on INIT and cached.  Only a plain {x,y} position is
 * sent each tick, keeping postMessage overhead minimal (~8 bytes).
 */

// ── Island shape data (minimal subset needed for ray casting) ────────────────

interface FogPt { x: number; y: number; }

interface FogIsland {
  x: number;
  y: number;
  vertices?:      FogPt[];
  grassVertices?: FogPt[];
  stonePolys?:    FogPt[][];
}

// ── Constants (must match ClientApplication) ─────────────────────────────────

const RAY_COUNT   = 32;
const MAX_VIEW_DIST = 5000;

// ── State ────────────────────────────────────────────────────────────────────

let islands: FogIsland[] = [];
const resultA = new Float32Array(RAY_COUNT);
const resultB = new Float32Array(RAY_COUNT);
/** Writable buffer for the current compute; posted buffer alternates to avoid slice(). */
let result = resultA;

// ── Helpers ──────────────────────────────────────────────────────────────────

function pointInPolygon(px: number, py: number, verts: FogPt[]): boolean {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Core ray computation ──────────────────────────────────────────────────────

function computeRays(px: number, py: number): void {
  const N      = RAY_COUNT;
  const MAX_D  = MAX_VIEW_DIST;
  const TWO_PI = Math.PI * 2;

  // Pre-filter islands within range; compute player-inside flags.
  const nearIslands:  FogIsland[] = [];
  const insideCoast:  boolean[]   = [];
  const insideGrass:  boolean[]   = [];
  const insideStone:  boolean[]   = [];

  for (const isl of islands) {
    if (!isl.vertices || isl.vertices.length < 3) continue;
    const cdx = isl.x - px, cdy = isl.y - py;
    if (cdx * cdx + cdy * cdy > MAX_D * MAX_D * 4) continue;
    nearIslands.push(isl);
    const pip = pointInPolygon(px, py, isl.vertices);
    insideCoast.push(pip);
    insideGrass.push(
      pip && !!isl.grassVertices && isl.grassVertices.length >= 3
        && pointInPolygon(px, py, isl.grassVertices)
    );
    insideStone.push(
      !!(isl.stonePolys?.some(sp => sp.length >= 3 && pointInPolygon(px, py, sp)))
    );
  }

  const fallbackInlandPlayer = nearIslands.some((isl, ni) =>
    insideCoast[ni] && (!isl.grassVertices || isl.grassVertices.length < 3)
  );
  const playerInGrass = insideGrass.some(Boolean) || fallbackInlandPlayer;
  const playerInStone = insideStone.some(Boolean);

  const evDist: number[] = [];
  const evKind: number[] = [];

  for (let i = 0; i < N; i++) {
    const angle = i * TWO_PI / N;
    const dx    = Math.cos(angle);
    const dy    = Math.sin(angle);

    evDist.length = 0;
    evKind.length = 0;

    for (let ni = 0; ni < nearIslands.length; ni++) {
      const isl      = nearIslands[ni];
      const verts    = isl.vertices!;
      const nv       = verts.length;
      const gverts   = isl.grassVertices;
      const hasGrass = !!(gverts && gverts.length >= 3);

      if (hasGrass) {
        // grassVertices crossings (kind 1) — beach between coast and here costs 1
        const ngv = gverts!.length;
        for (let j = 0; j < ngv; j++) {
          const ax = gverts![j].x           - px, ay = gverts![j].y           - py;
          const bx = gverts![(j + 1) % ngv].x - px, by = gverts![(j + 1) % ngv].y - py;
          const denom = dx * (by - ay) - dy * (bx - ax);
          if (Math.abs(denom) < 1e-6) continue;
          const t = (ax * (by - ay) - ay * (bx - ax)) / denom;
          const u = (ax * dy        - ay * dx)         / denom;
          if (t > 0.01 && u >= 0 && u <= 1) { evDist.push(t); evKind.push(1); }
        }
      } else {
        // Fallback: outer coast is the grass boundary (kind 3)
        for (let j = 0; j < nv; j++) {
          const ax = verts[j].x           - px, ay = verts[j].y           - py;
          const bx = verts[(j + 1) % nv].x - px, by = verts[(j + 1) % nv].y - py;
          const denom = dx * (by - ay) - dy * (bx - ax);
          if (Math.abs(denom) < 1e-6) continue;
          const t = (ax * (by - ay) - ay * (bx - ax)) / denom;
          const u = (ax * dy        - ay * dx)         / denom;
          if (t > 0.01 && u >= 0 && u <= 1) { evDist.push(t); evKind.push(3); }
        }
      }

      // Stone polygon crossings (kind 2)
      if (isl.stonePolys) {
        for (const sp of isl.stonePolys) {
          if (sp.length < 3) continue;
          const ns = sp.length;
          for (let j = 0; j < ns; j++) {
            const ax = sp[j].x           - px, ay = sp[j].y           - py;
            const bx = sp[(j + 1) % ns].x - px, by = sp[(j + 1) % ns].y - py;
            const denom = dx * (by - ay) - dy * (bx - ax);
            if (Math.abs(denom) < 1e-6) continue;
            const t = (ax * (by - ay) - ay * (bx - ax)) / denom;
            const u = (ax * dy        - ay * dx)         / denom;
            if (t > 0.01 && u >= 0 && u <= 1) { evDist.push(t); evKind.push(2); }
          }
        }
      }
    }

    // Sort events by ascending distance
    const order = Array.from({ length: evDist.length }, (_, k) => k)
      .sort((a, b) => evDist[a] !== evDist[b] ? evDist[a] - evDist[b] : evKind[a] - evKind[b]);

    // Walk the ray with a 4-zone visibility budget:
    //   ocean/beach → cost 1   grass → cost 5   stone → cost 2
    let inGrass   = playerInGrass;
    let inStone   = playerInStone;
    let budget    = MAX_D;
    let worldDist = 0;
    let exhausted = false;

    for (const ei of order) {
      const segLen = evDist[ei] - worldDist;
      if (segLen <= 0) continue;
      const cost           = inStone ? 2.0 : inGrass ? 5.0 : 1.0;
      const maxTraversable = budget / cost;
      if (segLen >= maxTraversable) {
        worldDist += maxTraversable;
        exhausted  = true;
        break;
      }
      budget    -= segLen * cost;
      worldDist  = evDist[ei];
      if (evKind[ei] === 2) inStone = !inStone;
      else                  inGrass = !inGrass;
    }

    if (!exhausted) {
      worldDist += budget / (inStone ? 2.0 : inGrass ? 5.0 : 1.0);
    }

    result[i] = worldDist;
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; islands?: FogIsland[]; x?: number; y?: number };

  if (msg.type === 'INIT') {
    islands = msg.islands ?? [];
    return;
  }

  if (msg.type === 'COMPUTE') {
    computeRays(msg.x ?? 0, msg.y ?? 0);
    const out = result;
    result = out === resultA ? resultB : resultA;
    // Transfer the buffer for zero-copy delivery; main thread wraps it in a new Float32Array.
    const buf = out.buffer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).postMessage(buf, [buf]);
  }
};

export {};
