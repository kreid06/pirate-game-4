/**
 * CarrierDetection.ts - Robust on-ship detection with hysteresis and tie-breaking
 * 
 * Handles the complex logic of determining which ship (if any) is currently carrying
 * a player, with smooth transitions and stable behavior near ship boundaries.
 */

import { PolygonUtils } from '../common/PolygonUtils.js';
import { Vec2 } from '../common/Vec2.js';
import { Player, Ship, PhysicsConfig } from './Types.js';
import { isInsidePlankAwareShip } from './PlankAwareDetection.js';

/**
 * Detection state for a single ship
 */
export interface ShipDetectionState {
  shipId: number;
  penetrationDepth: number;  // How far inside the ship (for tie-breaking)
  relativeVelocity: number;  // Player velocity relative to ship at contact
  confirmationTicks: number; // How many ticks we've been in this state
  lastDetected: number;      // Timestamp of last detection
}

/**
 * Overall carrier detection state
 */
export interface CarrierDetectionState {
  currentCarrierId: number | null;  // Currently assigned carrier
  candidateStates: Map<number, ShipDetectionState>; // States for all ships
  lastSwitchTime: number;           // Prevent rapid switching
  switchCooldownMs: number;         // Minimum time between switches
  confirmInTicks: number;           // Ticks needed to confirm on-ship
  confirmOutTicks: number;          // Ticks needed to confirm off-ship
}

/**
 * Events emitted during carrier changes
 */
export interface CarrierChangeEvent {
  type: 'carrierChanged' | 'leftDeck';
  playerId: number;
  newCarrierId: number | null;
  oldCarrierId: number | null;
  timestamp: number;
}

/**
 * Configuration for detection behavior
 */
export const DETECTION_CONFIG = {
  // Hysteresis parameters - optimized for fast exit detection
  CONFIRM_IN_TICKS: 2,      // Need 2 consecutive ticks to confirm on-ship (67ms at 30Hz)
  CONFIRM_OUT_TICKS: 1,     // Need only 1 tick to confirm off-ship (33ms at 30Hz) - fast exit
  SWITCH_COOLDOWN_MS: 50,   // 50ms minimum between carrier switches (reduced for faster exit)
  
  // Epsilon for boundary detection
  EPSILON_FACTOR: 1.5,      // Multiply by player radius for epsilon band
  
  // Tie-breaking weights
  PENETRATION_WEIGHT: 10.0, // Primary: deeper penetration wins
  VELOCITY_WEIGHT: 1.0,     // Secondary: lower relative velocity wins
} as const;

/**
 * Create initial detection state
 */
export function createCarrierDetectionState(): CarrierDetectionState {
  return {
    currentCarrierId: null,
    candidateStates: new Map(),
    lastSwitchTime: 0,
    switchCooldownMs: DETECTION_CONFIG.SWITCH_COOLDOWN_MS,
    confirmInTicks: DETECTION_CONFIG.CONFIRM_IN_TICKS,
    confirmOutTicks: DETECTION_CONFIG.CONFIRM_OUT_TICKS,
  };
}

/**
 * Update carrier detection for a player
 */
export function updateCarrierDetection(
  player: Player,
  ships: Ship[],
  detectionState: CarrierDetectionState,
  currentTime: number
): { newState: CarrierDetectionState; events: CarrierChangeEvent[] } {
  const events: CarrierChangeEvent[] = [];
  const newState = { ...detectionState };
  newState.candidateStates = new Map(detectionState.candidateStates);
  
  const epsilon = DETECTION_CONFIG.EPSILON_FACTOR * player.radius;
  
  // Failsafe: If player is moving fast in water but still marked as on-deck, force exit
  if (newState.currentCarrierId !== null && player.velocity.length() > PhysicsConfig.PLAYER_SPEED * 0.8) {
    const currentShip = ships.find(s => s.id === newState.currentCarrierId);
    if (currentShip) {
      // Check if player is actually swimming (moving fast relative to ship)
      const relativeVel = player.velocity.sub(currentShip.velocity);
      if (relativeVel.length() > PhysicsConfig.PLAYER_SPEED * 0.6) {
        console.log(`Player ${player.id} swimming fast but marked on-deck - forcing exit`);
        newState.candidateStates.delete(newState.currentCarrierId);
        events.push({
          type: 'leftDeck',
          playerId: player.id,
          newCarrierId: null,
          oldCarrierId: newState.currentCarrierId,
          timestamp: currentTime,
        });
        events.push({
          type: 'carrierChanged',
          playerId: player.id,
          newCarrierId: null,
          oldCarrierId: newState.currentCarrierId,
          timestamp: currentTime,
        });
        newState.currentCarrierId = null;
        newState.lastSwitchTime = currentTime;
        return { newState, events };
      }
    }
  }
  
  // Check detection for each ship
  const currentDetections = new Map<number, ShipDetectionState>();
  
  // Special case: If player is very far from their current carrier, force immediate exit
  if (newState.currentCarrierId !== null) {
    const currentShip = ships.find(s => s.id === newState.currentCarrierId);
    if (currentShip) {
      const distanceToCarrier = player.position.distanceTo(currentShip.position);
      const maxCarrierDistance = 400; // If player is >400 units from ship center, force exit
      
      if (distanceToCarrier > maxCarrierDistance) {
        // Player is too far - force immediate exit regardless of hysteresis
        newState.candidateStates.delete(newState.currentCarrierId);
        events.push({
          type: 'leftDeck',
          playerId: player.id,
          newCarrierId: null,
          oldCarrierId: newState.currentCarrierId,
          timestamp: currentTime,
        });
        events.push({
          type: 'carrierChanged',
          playerId: player.id,
          newCarrierId: null,
          oldCarrierId: newState.currentCarrierId,
          timestamp: currentTime,
        });
        newState.currentCarrierId = null;
        newState.lastSwitchTime = currentTime;
        return { newState, events };
      }
    }
  }
  
  for (const ship of ships) {
    // Fast pre-check: skip expensive polygon operations if player is clearly far away
    if (!isPlayerNearShip(player, ship, epsilon)) {
      continue;
    }
    
    const shipDetection = checkShipDetection(player, ship, epsilon);
    
    if (shipDetection.penetrationDepth > 0) {
      // Player is inside this ship
      const existing = newState.candidateStates.get(ship.id);
      const confirmationTicks = existing ? existing.confirmationTicks + 1 : 1;
      
      currentDetections.set(ship.id, {
        shipId: ship.id,
        penetrationDepth: shipDetection.penetrationDepth,
        relativeVelocity: shipDetection.relativeVelocity,
        confirmationTicks,
        lastDetected: currentTime,
      });
    }
  }
  
  // Update candidate states
  for (const [shipId, state] of newState.candidateStates.entries()) {
    if (!currentDetections.has(shipId)) {
      // No longer detecting this ship - start counting down
      state.confirmationTicks = Math.max(0, state.confirmationTicks - 1);
    }
  }
  
  // Add new detections
  for (const [shipId, detection] of currentDetections.entries()) {
    newState.candidateStates.set(shipId, detection);
  }
  
  // Remove expired states
  for (const [shipId, state] of newState.candidateStates.entries()) {
    if (state.confirmationTicks === 0 && !currentDetections.has(shipId)) {
      newState.candidateStates.delete(shipId);
    }
  }
  
  // Determine new carrier using tie-breaking logic
  const newCarrierId = selectCarrier(newState, currentTime);
  
  // Check for carrier change
  if (newCarrierId !== newState.currentCarrierId) {
    const oldCarrierId = newState.currentCarrierId;
    
    // Emit appropriate events
    if (oldCarrierId !== null && newCarrierId === null) {
      console.log(`Player ${player.id} fell off ship ${oldCarrierId}!`);
      events.push({
        type: 'leftDeck',
        playerId: player.id,
        newCarrierId,
        oldCarrierId,
        timestamp: currentTime,
      });
    }
    
    if (newCarrierId !== oldCarrierId) {
      console.log(`Player ${player.id} carrier changed: ${oldCarrierId} -> ${newCarrierId}`);
      events.push({
        type: 'carrierChanged',
        playerId: player.id,
        newCarrierId,
        oldCarrierId,
        timestamp: currentTime,
      });
    }
    
    newState.currentCarrierId = newCarrierId;
    newState.lastSwitchTime = currentTime;
  }
  
  return { newState, events };
}

/**
 * Create an expanded detection polygon that includes ladder boarding zones
 * This allows players to board ships from the water via ladders
 * Now uses plank-based detection with gaps for destroyed planks
 */
function createDetectionPolygon(ship: Ship): Vec2[] {
  // Start with the base deck polygon but modify it based on plank health
  const basePolygon = ship.hull.slice(); // Copy the base hull polygon
  
  // Note: Plank-aware detection is now handled by PlankAwareDetection.ts
  // This function is still used for ladder zone expansion and penetration calculations
  let detectionPolygon = basePolygon;
  
  // Add ladder boarding zones regardless of plank state
  const ladders = ship.modules.filter(m => m.kind === 'ladder');
  
  if (ladders.length === 0) {
    return detectionPolygon; // No ladders, use base polygon
  }
  
  // For each ladder, we need to extend the detection polygon
  // to include the ladder's boarding zone
  const expandedPoints: Vec2[] = [...detectionPolygon];
  
  for (const ladder of ladders) {
    if (ladder.moduleData && ladder.moduleData.kind === 'ladder') {
      const ladderData = ladder.moduleData;
      
      // Create ladder boarding zone rectangle
      // Ladder extends outward from the ship hull
      const ladderPos = ladder.localPos;
      const ladderWidth = ladderData.width;
      const ladderLength = ladderData.length;
      
      // Calculate ladder direction (default extends toward stern if not specified)
      const extendDirection = ladderData.extendDirection || Math.PI; // Default toward stern (180°)
      const dirVec = Vec2.from(Math.cos(extendDirection), Math.sin(extendDirection));
      const perpVec = dirVec.perp(); // Perpendicular for width
      
      // Create the ladder boarding rectangle points
      const halfWidth = ladderWidth / 2;
      const ladderEnd = ladderPos.add(dirVec.mul(ladderLength));
      
      const ladderPoints = [
        ladderPos.add(perpVec.mul(halfWidth)),
        ladderPos.add(perpVec.mul(-halfWidth)),
        ladderEnd.add(perpVec.mul(-halfWidth)),
        ladderEnd.add(perpVec.mul(halfWidth))
      ];
      
      expandedPoints.push(...ladderPoints);
    }
  }
  
  // For now, return all points as a simple combined polygon
  // This creates a detection zone that encompasses both the ship deck and ladder zones
  return expandedPoints;
}

/**
 * Check if player is inside a specific ship
 */
function checkShipDetection(
  player: Player,
  ship: Ship,
  epsilon: number
): { penetrationDepth: number; relativeVelocity: number } {
  // Transform player position to ship-local coordinates
  const relativePos = player.position.sub(ship.position);
  const localPos = relativePos.rotate(-ship.rotation);
  
  // Use plank-aware detection instead of solid polygon with ladder zones
  const isInside = isInsidePlankAwareShip(player.position, ship, epsilon);
  
  if (!isInside) {
    return { penetrationDepth: 0, relativeVelocity: 0 };
  }
  
  // For plank-aware detection, use simplified penetration calculation
  // (more sophisticated methods could be added later)
  const detectionPolygon = createDetectionPolygon(ship);
  const penetrationDepth = PolygonUtils.distanceToPolygonEdge(localPos, detectionPolygon);
  
  // Calculate relative velocity at contact point
  const playerWorldVel = player.velocity;
  const shipWorldVel = ship.velocity.add(
    localPos.perp().mul(ship.angularVelocity) // Tangential velocity from rotation
  );
  const relativeVelocity = playerWorldVel.sub(shipWorldVel).length();
  
  return { penetrationDepth, relativeVelocity };
}

/**
 * Fast pre-check to see if player is potentially near a ship
 * Uses bounding circle check before expensive polygon operations
 */
function isPlayerNearShip(player: Player, ship: Ship, epsilon: number): boolean {
  const distance = player.position.distanceTo(ship.position);
  // Use a generous bounding radius (ship diagonal + epsilon + player radius)
  const maxShipRadius = 300; // Conservative estimate for largest ship dimension
  const boundingRadius = maxShipRadius + epsilon + player.radius;
  return distance <= boundingRadius;
}

/**
 * Get the detection polygon for a ship (including ladder boarding zones)
 * This is used by the debug renderer to visualize the boarding areas
 */
export function getShipDetectionPolygon(ship: Ship): Vec2[] {
  return createDetectionPolygon(ship);
}

/**
 * Select the best carrier using tie-breaking logic
 */
function selectCarrier(
  detectionState: CarrierDetectionState,
  currentTime: number
): number | null {
  // Check cooldown to prevent rapid switching, but allow exits during cooldown
  const timeSinceSwitch = currentTime - detectionState.lastSwitchTime;
  if (timeSinceSwitch < detectionState.switchCooldownMs) {
    // During cooldown, allow exit to null but prevent switching between ships
    const currentState = detectionState.currentCarrierId 
      ? detectionState.candidateStates.get(detectionState.currentCarrierId)
      : null;
    
    if (currentState && currentState.confirmationTicks >= detectionState.confirmInTicks) {
      return detectionState.currentCarrierId; // Keep current carrier
    } else if (!currentState || currentState.confirmationTicks === 0) {
      return null; // Allow immediate exit during cooldown
    }
  }
  
  // Find all confirmed carriers
  const confirmedCarriers: ShipDetectionState[] = [];
  
  for (const state of detectionState.candidateStates.values()) {
    if (state.confirmationTicks >= detectionState.confirmInTicks) {
      confirmedCarriers.push(state);
    }
  }
  
  if (confirmedCarriers.length === 0) {
    // Check if current carrier needs more time to be removed
    const currentState = detectionState.currentCarrierId 
      ? detectionState.candidateStates.get(detectionState.currentCarrierId)
      : null;
    
    if (currentState && currentState.confirmationTicks > 0) {
      return detectionState.currentCarrierId; // Keep current until confirmed out
    }
    
    return null; // No carrier
  }
  
  if (confirmedCarriers.length === 1) {
    return confirmedCarriers[0].shipId;
  }
  
  // Tie-breaking: multiple confirmed carriers
  confirmedCarriers.sort((a, b) => {
    // Primary: Maximum penetration depth
    const depthDiff = b.penetrationDepth - a.penetrationDepth;
    if (Math.abs(depthDiff) > 0.1) return depthDiff > 0 ? 1 : -1;
    
    // Secondary: Minimum relative velocity
    const velDiff = a.relativeVelocity - b.relativeVelocity;
    if (Math.abs(velDiff) > 0.1) return velDiff > 0 ? 1 : -1;
    
    // Tertiary: Ship ID for determinism
    return a.shipId - b.shipId;
  });
  
  return confirmedCarriers[0].shipId;
}

/**
 * Get debug information about current detection state
 */
export function getDetectionDebugInfo(detectionState: CarrierDetectionState) {
  return {
    currentCarrier: detectionState.currentCarrierId,
    candidateCount: detectionState.candidateStates.size,
    candidates: Array.from(detectionState.candidateStates.values()).map(state => ({
      shipId: state.shipId,
      penetration: state.penetrationDepth.toFixed(2),
      velocity: state.relativeVelocity.toFixed(2),
      ticks: state.confirmationTicks,
    })),
    timeSinceSwitch: Date.now() - detectionState.lastSwitchTime,
  };
}
