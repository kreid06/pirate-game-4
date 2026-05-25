/**
 * CollisionBridge.ts — Typed collision-detection helpers built on WasmBridge.
 *
 * These are thin, semantically-named wrappers so game code imports shapes and
 * manifolds directly without dealing with raw pointer arithmetic or flat arrays.
 *
 * Usage:
 *   import { collisionBridge } from './CollisionBridge';
 *   await collisionBridge.initialize();
 *   const hit = collisionBridge.circleVsCircle({ x: 0, y: 0, r: 10 }, { x: 5, y: 0, r: 10 });
 */

import { wasmBridge, CollisionManifold } from './WasmBridge';

/* ── Shape types ───────────────────────────────────────────────────────────── */

export interface CircleShape {
  x: number;
  y: number;
  r: number;
}

export interface AABBShape {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Polygon described as a flat interleaved array [x0,y0, x1,y1, ...]. */
export interface PolygonShape {
  verts: number[];
}

export type { CollisionManifold };

/* ── CollisionBridge class ─────────────────────────────────────────────────── */

export class CollisionBridge {

  /** Delegate initialisation to the shared WasmBridge singleton. */
  async initialize(scriptUrl?: string): Promise<void> {
    return wasmBridge.initialize(scriptUrl);
  }

  get isReady(): boolean {
    return wasmBridge.isReady;
  }

  /* ── Primitive tests ──────────────────────────────────────────────────── */

  circleVsCircle(a: CircleShape, b: CircleShape): CollisionManifold {
    return wasmBridge.circleVsCircle(a.x, a.y, a.r, b.x, b.y, b.r);
  }

  aabbVsCircle(box: AABBShape, circle: CircleShape): CollisionManifold {
    return wasmBridge.aabbVsCircle(box.minX, box.minY, box.maxX, box.maxY,
      circle.x, circle.y, circle.r);
  }

  /** Convex polygon (CCW winding) vs circle. */
  polyVsCircle(poly: PolygonShape, circle: CircleShape): CollisionManifold {
    return wasmBridge.polyVsCircle(poly.verts, circle.x, circle.y, circle.r);
  }

  /** Convex polygon (CCW winding) vs convex polygon. */
  polyVsPoly(a: PolygonShape, b: PolygonShape): CollisionManifold {
    return wasmBridge.polyVsPoly(a.verts, b.verts);
  }

  /* ── Convenience: build AABB from a polygon ───────────────────────────── */

  static aabbFromPoly(verts: number[]): AABBShape {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < verts.length; i += 2) {
      if (verts[i]     < minX) minX = verts[i];
      if (verts[i]     > maxX) maxX = verts[i];
      if (verts[i + 1] < minY) minY = verts[i + 1];
      if (verts[i + 1] > maxY) maxY = verts[i + 1];
    }
    return { minX, minY, maxX, maxY };
  }

  /** Quick broadphase reject before running expensive SAT. */
  aabbBroadphase(a: AABBShape, b: AABBShape): boolean {
    return !(a.maxX < b.minX || a.minX > b.maxX ||
             a.maxY < b.minY || a.minY > b.maxY);
  }
}

export const collisionBridge = new CollisionBridge();
