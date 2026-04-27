/**
 * Plank segment definitions for precise hull coverage
 * This module provides functions to create exact plank segments based on hull geometry
 */

import { Vec2 } from '../common/Vec2.js';
import { ShipModule, ModuleUtils } from './modules.js';

/**
 * Point in 2D space for plank definitions
 */
export interface PlankPoint {
  x: number;
  y: number;
}

/**
 * Plank segment definition
 */
export interface PlankSegment {
  start: PlankPoint;
  end: PlankPoint;
  thickness: number;
  sectionName: string;
  index: number;
}

/**
 * Hull points that match the curved ship hull geometry
 * These must match exactly with the hull created in GameEngine.createCurvedShipHull()
 */
export const HULL_POINTS = {
  bow: { x: 190, y: 90 },
  bowTip: { x: 415, y: 0 },
  bowBottom: { x: 190, y: -90 },
  sternBottom: { x: -260, y: -90 },
  sternTip: { x: -345, y: 0 },
  stern: { x: -260, y: 90 }
};

/**
 * Get a point on a quadratic bezier curve
 */
export function getQuadraticPoint(
  p0: PlankPoint, 
  p1: PlankPoint, 
  p2: PlankPoint, 
  t: number
): PlankPoint {
  const x = Math.pow(1-t, 2) * p0.x + 2 * (1-t) * t * p1.x + Math.pow(t, 2) * p2.x;
  const y = Math.pow(1-t, 2) * p0.y + 2 * (1-t) * t * p1.y + Math.pow(t, 2) * p2.y;
  return { x, y };
}

/**
 * Create segments for a curved section of the hull
 */
export function createCurvedSegments(
  start: PlankPoint, 
  control: PlankPoint, 
  end: PlankPoint, 
  segmentCount: number, 
  sectionName: string,
  plankThickness: number
): PlankSegment[] {
  const segments: PlankSegment[] = [];
  
  for (let i = 0; i < segmentCount; i++) {
    const t1 = i / segmentCount;
    const t2 = (i + 1) / segmentCount;
    const segStart = getQuadraticPoint(start, control, end, t1);
    const segEnd = getQuadraticPoint(start, control, end, t2);
    
    segments.push({
      start: segStart,
      end: segEnd,
      thickness: plankThickness,
      sectionName: sectionName,
      index: i
    });
  }
  
  return segments;
}

/**
 * Create segments for a straight section of the hull
 */
export function createStraightSegments(
  start: PlankPoint, 
  end: PlankPoint, 
  segmentCount: number, 
  sectionName: string,
  plankThickness: number
): PlankSegment[] {
  const segments: PlankSegment[] = [];
  
  for (let i = 0; i < segmentCount; i++) {
    const t1 = i / segmentCount;
    const t2 = (i + 1) / segmentCount;
    
    // Linear interpolation for straight segments
    const segStart = {
      x: start.x + t1 * (end.x - start.x),
      y: start.y + t1 * (end.y - start.y)
    };
    const segEnd = {
      x: start.x + t2 * (end.x - start.x),
      y: start.y + t2 * (end.y - start.y)
    };
    
    segments.push({
      start: segStart,
      end: segEnd,
      thickness: plankThickness,
      sectionName: sectionName,
      index: i
    });
  }
  
  return segments;
}

/**
 * Create all plank segments for a complete ship hull.
 *
 * Produces EXACTLY 10 segments — one per server plank slot — using the same
 * section names and segment indices as the server's PLANK_KEYS table in
 * websocket_server.c.  Keeping client and server in sync avoids name-mismatch
 * fallbacks and prevents the template from stamping more IDs than exist.
 *
 * Server slot → client segment mapping:
 *   0  bow_port,0        → port bow arc     (bow → bowTip → bowBottom)
 *   1  bow_starboard,1   → stbd bow arc     (bowBottom → bowTip → bow)
 *   2  starboard_side,0  → stbd side 0/3
 *   3  starboard_side,1  → stbd side 1/3
 *   4  starboard_side,2  → stbd side 2/3
 *   5  stern_starboard,4 → stbd stern arc   (sternBottom → sternTip → stern)
 *   6  stern_port,5      → port stern arc   (stern → sternTip → sternBottom)
 *   7  port_side,0       → port side 0/3
 *   8  port_side,1       → port side 1/3
 *   9  port_side,2       → port side 2/3
 */
export function createCompleteHullSegments(plankThickness: number = 10): PlankSegment[] {
  const p = HULL_POINTS;
  const segments: PlankSegment[] = [];

  // ── Bow curves (1 segment each = full arc, hit-tested as straight chord) ──
  // slot 0: bow_port — port side of bow
  segments.push(...createCurvedSegments(p.bow, p.bowTip, p.bowBottom, 1, 'bow_port', plankThickness));
  // slot 1: bow_starboard — starboard side of bow (index=1 matches server)
  const bowStbd = createCurvedSegments(p.bowBottom, p.bowTip, p.bow, 1, 'bow_starboard', plankThickness);
  bowStbd[0].index = 1;
  segments.push(...bowStbd);

  // ── Starboard straight side (3 segments, indices 0-2) ──
  segments.push(...createStraightSegments(p.bowBottom, p.sternBottom, 3, 'starboard_side', plankThickness));

  // ── Stern curves (1 segment each, with server's non-zero indices) ──
  // slot 5: stern_starboard (index=4 matches server PLANK_KEYS)
  const sternStbd = createCurvedSegments(p.sternBottom, p.sternTip, p.stern, 1, 'stern_starboard', plankThickness);
  sternStbd[0].index = 4;
  segments.push(...sternStbd);
  // slot 6: stern_port (index=5 matches server PLANK_KEYS)
  const sternPort = createCurvedSegments(p.stern, p.sternTip, p.sternBottom, 1, 'stern_port', plankThickness);
  sternPort[0].index = 5;
  segments.push(...sternPort);

  // ── Port straight side (3 segments, indices 0-2) ──
  segments.push(...createStraightSegments(p.sternBottom, p.bow, 3, 'port_side', plankThickness));

  return segments; // exactly 10
}

/**
 * Create ship planks from precise hull segments
 * Replaces the previous section-based approach with exact hull geometry
 */
export function createShipPlanksFromSegments(startId: number = 100): ShipModule[] {
  const planks: ShipModule[] = [];
  let currentId = startId;

  const segments = createCompleteHullSegments(10); // 10 unit thickness → 10 planks

  for (const segment of segments) {
    const centerX = (segment.start.x + segment.end.x) / 2;
    const centerY = (segment.start.y + segment.end.y) / 2;
    const position = Vec2.from(centerX, centerY);

    const deltaX = segment.end.x - segment.start.x;
    const deltaY = segment.end.y - segment.start.y;
    const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const angle = Math.atan2(deltaY, deltaX);

    const plank = ModuleUtils.createDefaultModule(currentId++, 'plank', position);
    if (plank.moduleData && plank.moduleData.kind === 'plank') {
      plank.moduleData.length = length;
      plank.moduleData.width = segment.thickness;
      plank.moduleData.health = 10000;
      plank.moduleData.targetHealth = 10000;
      plank.moduleData.maxHealth = 10000;
      plank.moduleData.material = 'wood';
      plank.moduleData.segmentIndex = segment.index;
      plank.moduleData.sectionName = segment.sectionName;
      plank.localRot = angle;
    }

    planks.push(plank);
  }

  return planks; // exactly 10
}
