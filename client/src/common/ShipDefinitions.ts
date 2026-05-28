/**
 * ShipDefinitions.ts — generated from protocol/ship_definitions.json.
 * DO NOT EDIT — run `python3 protocol/codegen.py` to regenerate.
 *
 * Source of truth: protocol/ship_definitions.json
 */

// ── Brigantine ────────────────────────────────────────

export const BRIGANTINE_HULL = {
  bow: { x: 190, y: 90 },
  bowTip: { x: 415, y: 0 },
  bowBottom: { x: 190, y: -90 },
  sternBottom: { x: -260, y: -90 },
  sternTip: { x: -345, y: 0 },
  stern: { x: -260, y: 90 },
} as const;

export const BRIGANTINE_MASS = 5000;
export const BRIGANTINE_MOMENT_OF_INERTIA = 500000;
export const BRIGANTINE_MAX_SPEED = 30.0;
export const BRIGANTINE_TURN_RATE = 0.5;
export const BRIGANTINE_WATER_DRAG = 0.98;
export const BRIGANTINE_ANGULAR_DRAG = 0.95;

export const BRIGANTINE_LENGTH = 760;
export const BRIGANTINE_BEAM = 180;

// ── Deck identifiers ─────────────────────────────────
// deck_id values match the server's ShipDeck.id field (0=lower, 1=upper)
export const BRIGANTINE_DECK_COUNT = 2;
export const BRIGANTINE_DECK_LOWER_ID = 0;  // deck_id for lower deck (z_index 0)
export const BRIGANTINE_DECK_UPPER_ID = 1;  // deck_id for upper deck (z_index 1)

// Module IDs for the deck floor surface modules
export const BRIGANTINE_LOWER_DECK_MODULE_ID = 200;  // module representing the lower deck floor
export const BRIGANTINE_UPPER_DECK_MODULE_ID = 201;  // module representing the upper deck floor
/** @deprecated Use BRIGANTINE_LOWER_DECK_MODULE_ID */
export const BRIGANTINE_DECK_ID = BRIGANTINE_LOWER_DECK_MODULE_ID;

export const BRIGANTINE_HELM_ID = 1000;
export const BRIGANTINE_PLANK_SEGMENTS_START_ID = 100;
export const BRIGANTINE_PLANK_SEGMENTS_COUNT = 48;

export const BRIGANTINE_PHYSICS = {
  mass: 5000,
  momentOfInertia: 500000,
  maxSpeed: 30.0,
  turnRate: 0.5,
  waterDrag: 0.98,
  angularDrag: 0.95,
} as const;

export function validateBrigantinePhysics(
  s: { mass: number,
  momentOfInertia: number,
  maxSpeed: number,
  turnRate: number,
  waterDrag: number,
  angularDrag: number },
  eps = 0.01
): boolean {
  return Math.abs(s.mass - BRIGANTINE_MASS) < eps &&
    Math.abs(s.momentOfInertia - BRIGANTINE_MOMENT_OF_INERTIA) < eps &&
    Math.abs(s.maxSpeed - BRIGANTINE_MAX_SPEED) < eps &&
    Math.abs(s.turnRate - BRIGANTINE_TURN_RATE) < eps &&
    Math.abs(s.waterDrag - BRIGANTINE_WATER_DRAG) < eps &&
    Math.abs(s.angularDrag - BRIGANTINE_ANGULAR_DRAG) < eps;
}

