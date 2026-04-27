/**
 * SpriteAtlas — procedural sprite atlas for WebGL2 renderer.
 *
 * Generates every OffscreenCanvas sprite (tree leaves, rocks, boulders,
 * fiber plants, trunks) and shelf-packs them into a single GPU texture.
 * The caller uses `getUV(key)` to retrieve UV rects for batcher submission.
 *
 * Atlas size: 4096×4096 (safe on all WebGL2-capable devices).
 *
 * Sprite keys (same convention as RenderSystem cache keys, prefixed by type):
 *   tree_leaf:{tintIdx}_{rotBin}         (4 × 8 = 32)
 *   rock:{toneIdx}_{shapeIdx}_{n|h}      (4 × 3 × 2 = 24)
 *   boulder:{toneIdx}_{shapeIdx}_{n|h}   (3 × 5 × 2 = 30)
 *   fiber:{tintIdx}_{variantIdx}_{n|h}   (4 × 4 × 2 = 32)
 *   trunk:{normal|hovered|inrange}       (3)
 *
 * Total: 121 sprites.
 */

import { TextureManager } from './TextureManager.js';

// ── UV rect ───────────────────────────────────────────────────────────────

export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

// ── Shelf packer ──────────────────────────────────────────────────────────

class ShelfPacker {
  private _shelves: Array<{ x: number; y: number; h: number }> = [];
  private _curShelf = { x: 0, y: 0, h: 0 };
  constructor(
    private readonly atlasW: number,
    private readonly atlasH: number,
    private readonly pad = 1,
  ) {}

  pack(w: number, h: number): { x: number; y: number } | null {
    const { pad } = this;
    // Need to fit: pad + w fits if (curX + pad + w) <= atlasW
    if (this._curShelf.x + pad + w > this.atlasW) {
      // Move to next shelf
      this._shelves.push({ ...this._curShelf });
      const nextY = this._curShelf.y + this._curShelf.h + pad;
      if (nextY + h > this.atlasH) return null;
      this._curShelf = { x: 0, y: nextY, h };
    } else if (this._curShelf.h === 0) {
      // First entry on initial shelf
      this._curShelf.h = h;
    } else {
      // Grow shelf height if needed
      this._curShelf.h = Math.max(this._curShelf.h, h);
    }

    const pos = { x: this._curShelf.x + pad, y: this._curShelf.y + pad };
    this._curShelf.x += w + pad;
    return pos;
  }
}

// ── SpriteAtlas ───────────────────────────────────────────────────────────

export class SpriteAtlas {
  public readonly texture: WebGLTexture;
  public readonly atlasSize: number;

  private readonly _uvs = new Map<string, UVRect>();

  private constructor(texture: WebGLTexture, size: number, uvs: Map<string, UVRect>) {
    this.texture   = texture;
    this.atlasSize = size;
    this._uvs      = uvs;
  }

  /** Build all sprites, pack into atlas, upload to GPU. Returns ready instance. */
  static build(gl: WebGL2RenderingContext, texMgr: TextureManager): SpriteAtlas {
    const SIZE     = 4096;
    const atlasCtx = SpriteAtlas._makeCanvas(SIZE, SIZE);
    const packer   = new ShelfPacker(SIZE, SIZE, 2);
    const uvs      = new Map<string, UVRect>();

    // helper: place an OffscreenCanvas into the atlas and record its UV
    const place = (key: string, src: OffscreenCanvas) => {
      const pos = packer.pack(src.width, src.height);
      if (!pos) { console.warn(`[Atlas] No space for sprite: ${key}`); return; }
      atlasCtx.drawImage(src as unknown as HTMLCanvasElement, pos.x, pos.y);
      uvs.set(key, {
        u0: pos.x           / SIZE,
        v0: pos.y           / SIZE,
        u1: (pos.x + src.width)  / SIZE,
        v1: (pos.y + src.height) / SIZE,
      });
    };

    // ── Generate all sprite types ─────────────────────────────────────────
    SpriteAtlas._genTreeLeaves(place);
    SpriteAtlas._genRocks(place);
    SpriteAtlas._genBoulders(place);
    SpriteAtlas._genFiber(place);
    SpriteAtlas._genTrunks(place);

    const atlasDomCanvas = atlasCtx.canvas as unknown as HTMLCanvasElement;
    const tex = texMgr.upload('__sprite_atlas__', atlasDomCanvas, { linear: true });

    console.log(`[Atlas] Built with ${uvs.size} sprites on ${SIZE}×${SIZE} atlas`);
    return new SpriteAtlas(tex, SIZE, uvs);
  }

  /** Returns the UV rect for the given sprite key, or the full-white fallback. */
  getUV(key: string): UVRect {
    return this._uvs.get(key) ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
  }

  has(key: string): boolean {
    return this._uvs.has(key);
  }

  // ── Convenience key builders ──────────────────────────────────────────

  static keyTreeLeaf(tintIdx: number, rotBin: number): string {
    return `tree_leaf:${tintIdx}_${rotBin}`;
  }

  static keyRock(toneIdx: number, shapeIdx: number, hovered: boolean): string {
    return `rock:${toneIdx}_${shapeIdx}_${hovered ? 'h' : 'n'}`;
  }

  static keyBoulder(toneIdx: number, shapeIdx: number, hovered: boolean): string {
    return `boulder:${toneIdx}_${shapeIdx}_${hovered ? 'h' : 'n'}`;
  }

  static keyFiber(tintIdx: number, variantIdx: number, hovered: boolean): string {
    return `fiber:${tintIdx}_${variantIdx}_${hovered ? 'h' : 'n'}`;
  }

  static keyTrunk(state: 'normal' | 'hovered' | 'inrange'): string {
    return `trunk:${state}`;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private static _makeCanvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
    const c = new OffscreenCanvas(w, h);
    return c.getContext('2d')!;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Sprite generators — identical logic to RenderSystem private statics.
  // Duplicated here so SpriteAtlas is self-contained; once gl-world is done
  // the RenderSystem copies can be removed.
  // ──────────────────────────────────────────────────────────────────────

  // ── Tree leaves ───────────────────────────────────────────────────────

  private static readonly _TREE_SIZE    = 256;
  private static readonly _TREE_BINS    = 8;
  private static readonly _TREE_TINTS: [string, string, string, string][] = [
    ['#1a3a0a', '#3a7320', '#52a030', '#6ecf42'],
    ['#1c3e08', '#3f7a18', '#5aae2e', '#74d93e'],
    ['#152f08', '#2e6318', '#456e22', '#5a9030'],
    ['#233a10', '#4a7c28', '#5fa035', '#72b845'],
  ];

  private static _genTreeLeaves(place: (k: string, c: OffscreenCanvas) => void): void {
    const SIZE      = SpriteAtlas._TREE_SIZE;
    const BINS      = SpriteAtlas._TREE_BINS;
    const ROT_RANGE = Math.PI / 3.6;
    const canopy    = SIZE * 0.38;
    const cx = SIZE / 2, cy = SIZE / 2;
    const BASE_L: [number, number, number][] = [
      [  0.00, -0.22, 0.80 ],
      [ -0.44,  0.00, 0.62 ],
      [  0.46,  0.05, 0.58 ],
      [ -0.20,  0.40, 0.50 ],
      [  0.25,  0.38, 0.48 ],
    ];

    for (let tintIdx = 0; tintIdx < 4; tintIdx++) {
      const [shadowCol, baseCol, hlCol, glintCol] = SpriteAtlas._TREE_TINTS[tintIdx];
      for (let bin = 0; bin < BINS; bin++) {
        const clusterRot = -ROT_RANGE + (bin / (BINS - 1)) * 2 * ROT_RANGE;
        const c = Math.cos(clusterRot), s = Math.sin(clusterRot);
        const rot = (dx: number, dy: number): [number, number] =>
          [dx * c - dy * s, dx * s + dy * c];
        const L = BASE_L.map(([dx, dy, r]) => {
          const [rx, ry] = rot(dx, dy); return [rx, ry, r] as [number, number, number];
        });
        const off = new OffscreenCanvas(SIZE, SIZE);
        const ctx = off.getContext('2d')!;
        ctx.fillStyle = shadowCol;
        for (const [dx, dy, r] of L) { ctx.beginPath(); ctx.arc(cx + (dx + 0.13) * canopy, cy + (dy + 0.11) * canopy, r * canopy, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = baseCol;
        for (const [dx, dy, r] of L) { ctx.beginPath(); ctx.arc(cx + dx * canopy, cy + dy * canopy, r * canopy, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = hlCol;
        for (const [dx, dy, r] of L.slice(0, 3)) { ctx.beginPath(); ctx.arc(cx + (dx - 0.10) * canopy, cy + (dy - 0.15) * canopy, r * canopy * 0.62, 0, Math.PI * 2); ctx.fill(); }
        const [apexRx, apexRy] = rot(-0.09, -0.34);
        ctx.fillStyle = glintCol;
        ctx.beginPath(); ctx.arc(cx + apexRx * canopy, cy + apexRy * canopy, canopy * 0.25, 0, Math.PI * 2); ctx.fill();
        place(SpriteAtlas.keyTreeLeaf(tintIdx, bin), off);
      }
    }
  }

  // ── Rocks ─────────────────────────────────────────────────────────────

  private static readonly _ROCK_SIZE = 96;
  private static readonly _ROCK_R    = 22;
  private static readonly _ROCK_TONES = [
    { body: '#888890', shadow: '#555560', hi: '#b8b8c0', crack: '#666670' },
    { body: '#8a7060', shadow: '#5a4030', hi: '#b09080', crack: '#6a5040' },
    { body: '#a09060', shadow: '#6a5830', hi: '#c8b080', crack: '#807040' },
    { body: '#505058', shadow: '#303038', hi: '#808088', crack: '#404048' },
  ];
  private static readonly _ROCK_SHAPES: [number, number, number, number, number, number, number][] = [
    [1.0,  0.70,  0.0,  -0.10, -0.20,  0.25,  0.30],
    [0.85, 0.85,  0.3,   0.05, -0.30, -0.20,  0.20],
    [1.15, 0.55, -0.2,  -0.20, -0.10,  0.30,  0.25],
  ];

  private static _genRocks(place: (k: string, c: OffscreenCanvas) => void): void {
    const SIZE = SpriteAtlas._ROCK_SIZE;
    const R    = SpriteAtlas._ROCK_R;
    const cx = SIZE / 2, cy = SIZE / 2;
    for (let ti = 0; ti < SpriteAtlas._ROCK_TONES.length; ti++) {
      const tone = SpriteAtlas._ROCK_TONES[ti];
      for (let si = 0; si < SpriteAtlas._ROCK_SHAPES.length; si++) {
        const [sx, sy, rot, cx1, cy1, cx2, cy2] = SpriteAtlas._ROCK_SHAPES[si];
        for (const hovered of [false, true]) {
          const off = new OffscreenCanvas(SIZE, SIZE);
          const ctx = off.getContext('2d')!;
          ctx.beginPath(); ctx.ellipse(cx + R * 0.18, cy + R * 0.18 * sy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = tone.shadow; ctx.fill();
          ctx.beginPath(); ctx.ellipse(cx, cy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = hovered ? tone.hi : tone.body; ctx.fill();
          if (hovered) { ctx.strokeStyle = '#ffe090'; ctx.lineWidth = 2; ctx.stroke(); }
          else         { ctx.strokeStyle = tone.shadow; ctx.lineWidth = 1.5; ctx.stroke(); }
          ctx.beginPath(); ctx.ellipse(cx - R * sx * 0.28, cy - R * sy * 0.28, R * sx * 0.26, R * sy * 0.18, rot - 0.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.fill();
          ctx.strokeStyle = tone.crack; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cx + R * cx1, cy + R * cy1); ctx.lineTo(cx + R * cx2, cy + R * cy2); ctx.stroke();
          place(SpriteAtlas.keyRock(ti, si, hovered), off);
        }
      }
    }
  }

  // ── Boulders ──────────────────────────────────────────────────────────

  private static readonly _BOULDER_SIZE = 160;
  private static readonly _BOULDER_R    = 52;
  private static readonly _BOULDER_TONES = [
    { body: '#797975', shadow: '#44443f', hi: '#aaaaa4', crack: '#55554f', moss: '#5a7040' },
    { body: '#8a7860', shadow: '#504030', hi: '#b09880', crack: '#60503a', moss: '#607848' },
    { body: '#585858', shadow: '#303030', hi: '#888888', crack: '#404040', moss: '#4a6038' },
  ];
  private static readonly _BOULDER_SHAPES: [number, number, number][] = [
    [1.00, 0.72,  0.0 ],
    [0.88, 0.88,  0.4 ],
    [1.18, 0.60, -0.2 ],
    [0.72, 1.00,  1.2 ],
    [1.35, 0.50,  0.15],
  ];

  private static _genBoulders(place: (k: string, c: OffscreenCanvas) => void): void {
    const SIZE = SpriteAtlas._BOULDER_SIZE;
    const R    = SpriteAtlas._BOULDER_R;
    const cx = SIZE / 2, cy = SIZE / 2;
    for (let ti = 0; ti < SpriteAtlas._BOULDER_TONES.length; ti++) {
      const tone = SpriteAtlas._BOULDER_TONES[ti];
      for (let si = 0; si < SpriteAtlas._BOULDER_SHAPES.length; si++) {
        const [sx, sy, rot] = SpriteAtlas._BOULDER_SHAPES[si];
        for (const hovered of [false, true]) {
          const off = new OffscreenCanvas(SIZE, SIZE);
          const ctx = off.getContext('2d')!;
          ctx.beginPath(); ctx.ellipse(cx + R * 0.20, cy + R * 0.25 * sy, R * sx * 1.10, R * sy * 0.35, rot, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fill();
          ctx.beginPath(); ctx.ellipse(cx + R * 0.15, cy + R * 0.12 * sy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = tone.shadow; ctx.fill();
          ctx.beginPath(); ctx.ellipse(cx, cy, R * sx, R * sy, rot, 0, Math.PI * 2);
          ctx.fillStyle = hovered ? tone.hi : tone.body; ctx.fill();
          ctx.strokeStyle = hovered ? '#ffe090' : tone.shadow; ctx.lineWidth = hovered ? 3 : 2; ctx.stroke();
          ctx.beginPath(); ctx.ellipse(cx - R * sx * 0.28, cy - R * sy * 0.28, R * sx * 0.38, R * sy * 0.26, rot - 0.6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fill();
          ctx.beginPath(); ctx.arc(cx - R * sx * 0.35, cy - R * sy * 0.38, R * 0.08, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.40)'; ctx.fill();
          for (let m = 0; m < 3; m++) {
            const ma = rot + m * 0.7 + 0.3;
            const mx = cx + Math.cos(ma) * R * sx * 0.55;
            const my = cy + R * sy * 0.48 + Math.sin(ma) * R * sy * 0.12;
            ctx.beginPath(); ctx.ellipse(mx, my, R * 0.14, R * 0.08, ma, 0, Math.PI * 2);
            ctx.fillStyle = tone.moss; ctx.fill();
          }
          ctx.strokeStyle = tone.crack; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(cx - R * sx * 0.10, cy - R * sy * 0.30); ctx.lineTo(cx + R * sx * 0.28, cy + R * sy * 0.32); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx + R * sx * 0.05, cy - R * sy * 0.18); ctx.lineTo(cx - R * sx * 0.22, cy + R * sy * 0.20); ctx.stroke();
          place(SpriteAtlas.keyBoulder(ti, si, hovered), off);
        }
      }
    }
  }

  // ── Fiber plants ──────────────────────────────────────────────────────

  private static readonly _FIBER_SIZE = 96;
  private static readonly _FIBER_TINTS = [
    { shadow: '#2a5010', mid: '#4a7a20', bright: '#78b838', hi: '#a8e050' },
    { shadow: '#203a08', mid: '#3c6618', bright: '#62a028', hi: '#90cc48' },
    { shadow: '#3a5010', mid: '#607020', bright: '#96b030', hi: '#c0dc58' },
    { shadow: '#284818', mid: '#486830', bright: '#6c9848', hi: '#98c070' },
  ];
  private static readonly _FIBER_CLUSTERS: [number, number, number][][] = [
    [ [-0.55,-0.30,0.55], [0.55,-0.30,0.50], [0.00,-0.62,0.52], [0.00, 0.10,0.48] ],
    [ [-0.60,-0.18,0.52], [0.50,-0.38,0.48], [0.05,-0.65,0.50], [-0.10,0.08,0.44] ],
    [ [-0.45,-0.40,0.50], [0.60,-0.20,0.54], [0.02,-0.60,0.48], [ 0.12,0.12,0.46] ],
    [ [-0.50,-0.35,0.56], [0.50,-0.35,0.50], [-0.05,-0.72,0.44],[0.05,-0.10,0.52] ],
  ];

  private static _genFiber(place: (k: string, c: OffscreenCanvas) => void): void {
    const SIZE = SpriteAtlas._FIBER_SIZE;
    const BR   = 18;
    const cx = SIZE / 2, cy = SIZE * 0.60;
    for (let ti = 0; ti < SpriteAtlas._FIBER_TINTS.length; ti++) {
      const tint = SpriteAtlas._FIBER_TINTS[ti];
      for (let vi = 0; vi < SpriteAtlas._FIBER_CLUSTERS.length; vi++) {
        const vc = SpriteAtlas._FIBER_CLUSTERS[vi];
        for (const hovered of [false, true]) {
          const off = new OffscreenCanvas(SIZE, SIZE);
          const ctx = off.getContext('2d')!;
          ctx.beginPath(); ctx.ellipse(cx + 2, cy + 3, BR * 0.90, BR * 0.28, 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fill();
          ctx.strokeStyle = tint.shadow; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
          for (let s = -1; s <= 1; s++) {
            ctx.beginPath(); ctx.moveTo(cx + s * BR * 0.28, cy); ctx.lineTo(cx + s * BR * 0.18, cy - BR * 0.55); ctx.stroke();
          }
          for (let ci = 0; ci < vc.length; ci++) {
            if (ci >= 2) continue;
            const [dx, dy, fr] = vc[ci];
            ctx.beginPath(); ctx.arc(cx + dx * BR, cy + dy * BR, fr * BR, 0, Math.PI * 2);
            ctx.fillStyle = tint.shadow; ctx.fill();
          }
          for (const [dx, dy, fr] of vc) {
            ctx.beginPath(); ctx.arc(cx + dx * BR, cy + dy * BR, fr * BR, 0, Math.PI * 2);
            ctx.fillStyle = hovered ? tint.bright : tint.mid; ctx.fill();
            if (hovered) { ctx.strokeStyle = '#ffe090'; ctx.lineWidth = 1.5; ctx.stroke(); }
          }
          for (const [dx, dy, fr] of vc) {
            ctx.beginPath(); ctx.arc(cx + dx * BR * 0.72, cy + dy * BR * 0.72, fr * BR * 0.55, 0, Math.PI * 2);
            ctx.fillStyle = hovered ? tint.hi : tint.bright; ctx.fill();
          }
          const [tx, ty] = vc[2] ?? vc[0];
          ctx.beginPath(); ctx.arc(cx + tx * BR * 0.5 - BR * 0.1, cy + ty * BR * 0.5 - BR * 0.1, BR * 0.18, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fill();
          place(SpriteAtlas.keyFiber(ti, vi, hovered), off);
        }
      }
    }
  }

  // ── Trunks ────────────────────────────────────────────────────────────

  private static readonly _TRUNK_SIZE = 96;
  private static readonly _TRUNK_R    = 30;

  private static _genTrunks(place: (k: string, c: OffscreenCanvas) => void): void {
    const SIZE = SpriteAtlas._TRUNK_SIZE;
    const R    = SpriteAtlas._TRUNK_R;
    const cx = SIZE / 2, cy = SIZE / 2;

    const _draw = (ctx: OffscreenCanvasRenderingContext2D, ring?: string) => {
      ctx.fillStyle = '#2e1a0a';
      ctx.beginPath(); ctx.arc(cx + R * 0.22, cy + R * 0.22, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7a4820';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a0642e';
      ctx.beginPath(); ctx.arc(cx - R * 0.28, cy - R * 0.22, R * 0.45, 0, Math.PI * 2); ctx.fill();
      if (ring) {
        ctx.strokeStyle = ring; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, R + 3, 0, Math.PI * 2); ctx.stroke();
      }
    };

    const normal  = new OffscreenCanvas(SIZE, SIZE); _draw(normal.getContext('2d')!);
    const hovered = new OffscreenCanvas(SIZE, SIZE); _draw(hovered.getContext('2d')!, '#cccccc');
    const inrange = new OffscreenCanvas(SIZE, SIZE); _draw(inrange.getContext('2d')!, '#f0c040');

    place(SpriteAtlas.keyTrunk('normal'),  normal);
    place(SpriteAtlas.keyTrunk('hovered'), hovered);
    place(SpriteAtlas.keyTrunk('inrange'), inrange);
  }
}
