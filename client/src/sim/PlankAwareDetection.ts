/**
 * PlankAwareDetection.ts - Enhanced carrier detection that respects plank health
 */

import { Vec2 } from '../common/Vec2.js';
import { Ship } from './Types.js';

// Cache for detection polygons to avoid recomputation
const detectionCache = new Map<string, { polygon: Vec2[], lastUpdate: number }>();

/**
 * Create a detection polygon that accounts for destroyed planks
 * This replaces the solid deck polygon with a more dynamic system
 */
export function createPlankAwareDetectionPolygon(ship: Ship): Vec2[] {
  const cacheKey = `${ship.id}`;
  const now = Date.now();
  const cached = detectionCache.get(cacheKey);
  
  // Use cache if it's less than 33ms old (for faster updates when players fall through gaps)
  if (cached && (now - cached.lastUpdate) < 33) {
    return cached.polygon;
  }
  
  // Get all healthy planks (optimized: single pass through modules)
  let healthyPlankCount = 0;
  let totalPlankCount = 0;
  
  for (const module of ship.modules) {
    if (module.kind === 'plank' && module.moduleData?.kind === 'plank') {
      totalPlankCount++;
      if (module.moduleData.health > 0) {
        healthyPlankCount++;
      }
    }
  }

  let detectionPolygon: Vec2[];
  
  // If no planks exist, use full hull (for ships without plank modules)
  if (totalPlankCount === 0) {
    detectionPolygon = ship.hull.slice();
  }
  // If no healthy planks, the ship has no collision boundary
  else if (healthyPlankCount === 0) {
    detectionPolygon = []; // Empty polygon = no detection
  }
  // If most planks are destroyed, use reduced detection area
  else if (healthyPlankCount / totalPlankCount < 0.5) {
    const reducedSize = 0.7; // 70% of original size
    detectionPolygon = ship.hull.map(point => point.mul(reducedSize));
  }
  // Ship is mostly intact - use full detection area
  else {
    detectionPolygon = ship.hull.slice();
  }
  
  // Cache the result
  detectionCache.set(cacheKey, {
    polygon: detectionPolygon,
    lastUpdate: now
  });
  
  return detectionPolygon;
}

/**
 * Check if a position is inside the plank-aware detection area
 */
export function isInsidePlankAwareShip(position: Vec2, ship: Ship, epsilon: number = 0): boolean {
  const detectionPolygon = createPlankAwareDetectionPolygon(ship);
  
  if (detectionPolygon.length === 0) {
    return false; // No detection area if no planks
  }

  // Transform position to ship-local coordinates
  const localPos = position.sub(ship.position).rotate(-ship.rotation);
  
  // Use point-in-polygon test with the plank-aware polygon
  return pointInPolygon(localPos, detectionPolygon, epsilon);
}

/**
 * Simple point-in-polygon test (copied from PolygonUtils to avoid circular import)
 */
function pointInPolygon(point: Vec2, polygon: Vec2[], epsilon: number = 0): boolean {
  if (polygon.length < 3) return false;
  
  let inside = false;
  const x = point.x;
  const y = point.y;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  
  // Apply epsilon expansion if needed
  if (!inside && epsilon > 0) {
    // Check if point is within epsilon distance of any edge
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i];
      const end = polygon[(i + 1) % polygon.length];
      
      // Distance from point to line segment
      const lineVec = end.sub(start);
      const pointVec = point.sub(start);
      
      if (lineVec.lengthSq() < 1e-10) continue; // Degenerate edge
      
      const t = Math.max(0, Math.min(1, pointVec.dot(lineVec) / lineVec.lengthSq()));
      const closest = start.add(lineVec.mul(t));
      const distance = point.sub(closest).length();
      
      if (distance <= epsilon) {
        return true;
      }
    }
  }
  
  return inside;
}

/**
 * Clear the detection polygon cache (call when planks are damaged/repaired)
 */
export function clearPlankDetectionCache(shipId?: number): void {
  if (shipId !== undefined) {
    detectionCache.delete(shipId.toString());
  } else {
    detectionCache.clear();
  }
}
