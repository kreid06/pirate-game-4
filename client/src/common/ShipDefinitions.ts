/**
 * Ship Definitions - Client-Side Constants
 * 
 * These constants MUST match protocol/ship_definitions.h on the server
 * to ensure identical physics simulation on client and server.
 */

/**
 * Brigantine physics constants (must match server)
 */
export const BRIGANTINE_MASS = 5000.0;              // kg
export const BRIGANTINE_MOMENT_OF_INERTIA = 500000.0; // kg⋅m²
export const BRIGANTINE_MAX_SPEED = 30.0;           // m/s
export const BRIGANTINE_TURN_RATE = 0.5;            // rad/s
export const BRIGANTINE_WATER_DRAG = 0.98;          // 0-1 coefficient
export const BRIGANTINE_ANGULAR_DRAG = 0.95;        // 0-1 coefficient

/**
 * Brigantine dimensions
 */
export const BRIGANTINE_LENGTH = 760;  // units (stern_tip to bow_tip)
export const BRIGANTINE_BEAM = 180;    // units (width at widest point)

/**
 * Brigantine module IDs
 */
export const BRIGANTINE_DECK_ID = 200;
export const BRIGANTINE_HELM_ID = 1000;
export const BRIGANTINE_PLANK_START_ID = 100;

/**
 * All brigantine constants in one object for easy import
 */
export const BRIGANTINE_PHYSICS = {
  mass: BRIGANTINE_MASS,
  momentOfInertia: BRIGANTINE_MOMENT_OF_INERTIA,
  maxSpeed: BRIGANTINE_MAX_SPEED,
  turnRate: BRIGANTINE_TURN_RATE,
  waterDrag: BRIGANTINE_WATER_DRAG,
  angularDrag: BRIGANTINE_ANGULAR_DRAG,
} as const;

/**
 * Validate ship physics properties match expected brigantine values
 * Useful for debugging/testing server data
 */
export function validateBrigantinePhysics(ship: {
  mass: number;
  momentOfInertia: number;
  maxSpeed: number;
  turnRate: number;
  waterDrag: number;
  angularDrag: number;
}): boolean {
  const epsilon = 0.01; // Tolerance for floating-point comparison
  
  return (
    Math.abs(ship.mass - BRIGANTINE_MASS) < epsilon &&
    Math.abs(ship.momentOfInertia - BRIGANTINE_MOMENT_OF_INERTIA) < epsilon &&
    Math.abs(ship.maxSpeed - BRIGANTINE_MAX_SPEED) < epsilon &&
    Math.abs(ship.turnRate - BRIGANTINE_TURN_RATE) < epsilon &&
    Math.abs(ship.waterDrag - BRIGANTINE_WATER_DRAG) < epsilon &&
    Math.abs(ship.angularDrag - BRIGANTINE_ANGULAR_DRAG) < epsilon
  );
}
