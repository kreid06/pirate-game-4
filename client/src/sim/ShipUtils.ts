/**
 * Ship Creation Utilities
 * 
 * Utilities for creating ships and ship-related geometry.
 * Extracted from GameEngine for reusability.
 */

import { Vec2 } from '../common/Vec2.js';
import { Ship, WorldState } from './Types.js';
import { HULL_POINTS, getQuadraticPoint, ModuleUtils } from './modules.js';
import { BRIGANTINE_PHYSICS } from '../common/ShipDefinitions.js';

/**
 * Create a curved ship hull polygon that matches the HULL_POINTS definition
 * This generates the visual hull shape using quadratic curves and straight lines
 */
export function createCurvedShipHull(): Vec2[] {
  const hull: Vec2[] = [];
  const p = HULL_POINTS;
  
  // Create curved bow section (port side: bow -> bowTip -> bowBottom)
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const point = getQuadraticPoint(p.bow, p.bowTip, p.bowBottom, t);
    hull.push(Vec2.from(point.x, point.y));
  }
  
  // Create straight starboard side (bowBottom -> sternBottom)  
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    const x = p.bowBottom.x + t * (p.sternBottom.x - p.bowBottom.x);
    const y = p.bowBottom.y + t * (p.sternBottom.y - p.bowBottom.y);
    hull.push(Vec2.from(x, y));
  }
  
  // Create curved stern section (sternBottom -> sternTip -> stern)
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    const point = getQuadraticPoint(p.sternBottom, p.sternTip, p.stern, t);
    hull.push(Vec2.from(point.x, point.y));
  }
  
  // Create straight port side (stern -> bow)
  for (let i = 1; i < 12; i++) { // Don't include the last point to avoid duplication
    const t = i / 12;
    const x = p.stern.x + t * (p.bow.x - p.stern.x);
    const y = p.stern.y + t * (p.bow.y - p.stern.y);
    hull.push(Vec2.from(x, y));
  }
  
  console.log(`Created curved hull with ${hull.length} points`);
  return hull;
}

/**
 * Create a basic ship at a specific position and rotation
 */
export function createShipAtPosition(position: Vec2, rotation: number): Ship {
  // Use the curved hull shape for collision detection
  const hull = createCurvedShipHull();
  
  return {
    id: Math.floor(Math.random() * 1000000),
    position,
    rotation,
    velocity: Vec2.zero(),
    angularVelocity: 0,
    hull,
    modules: [
      // Basic deck module
      ModuleUtils.createShipDeckFromPolygon(hull, 200),
      // Basic planks 
      ...ModuleUtils.createShipPlanksFromSegments(100),
      // Basic helm
      ModuleUtils.createDefaultModule(1000, 'helm', Vec2.from(-90, 0))
    ],
    // Brigantine physics properties (match protocol/ship_definitions.h)
    mass: BRIGANTINE_PHYSICS.mass,
    momentOfInertia: BRIGANTINE_PHYSICS.momentOfInertia,
    maxSpeed: BRIGANTINE_PHYSICS.maxSpeed,
    turnRate: BRIGANTINE_PHYSICS.turnRate,
    waterDrag: BRIGANTINE_PHYSICS.waterDrag,
    angularDrag: BRIGANTINE_PHYSICS.angularDrag
  };
}