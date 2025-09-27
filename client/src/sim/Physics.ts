import { Vec2 } from '../common/Vec2.js';
import { AngleUtils } from '../common/AngleUtils.js';
import { PolygonUtils } from '../common/PolygonUtils.js';
import { WorldState, InputFrame, Ship, Player, PhysicsConfig } from './Types.js';
import { CollisionSystem } from './CollisionSystem.js';
import { 
  CarrierDetectionState, 
  CarrierChangeEvent,
  createCarrierDetectionState, 
  updateCarrierDetection 
} from './CarrierDetection.js';

/**
 * Action bit flags for player input
 */
export const PlayerActions = {
  JUMP: 1 << 0,          // Jump/Leave ship action
  INTERACT: 1 << 1,      // Interact with modules
  DISMOUNT: 1 << 2,      // Dismount from modules
  DESTROY_PLANK: 1 << 3, // Destroy nearby planks
  // Add more actions as needed
} as const;

/**
 * Pure deterministic simulation function
 * This is the core of Phase 0 - completely deterministic physics
 */
export function simulate(prevWorld: WorldState, inputFrame: InputFrame, dt: number): WorldState {
  // Clone the world state for immutability
  const newWorld: WorldState = {
    tick: prevWorld.tick + 1,
    ships: prevWorld.ships.map(ship => ({ ...ship })),
    players: prevWorld.players.map(player => ({ ...player })),
    cannonballs: prevWorld.cannonballs.map(cb => ({ ...cb })),
    timestamp: prevWorld.timestamp + dt * 1000,
    carrierDetection: new Map(prevWorld.carrierDetection)
  };

  // Update ship physics (forces, but not positions yet)
  for (const ship of newWorld.ships) {
    updateShipPhysics(ship, dt);
  }

  // Handle ship-to-ship collisions with multiple substeps to prevent tunneling
  const collisionSubsteps = 3; // Multiple collision checks per frame
  const subDt = dt / collisionSubsteps;
  
  for (let step = 0; step < collisionSubsteps; step++) {
    // Apply partial position integration
    for (const ship of newWorld.ships) {
      ship.position = ship.position.add(ship.velocity.mul(subDt));
      ship.rotation += ship.angularVelocity * subDt;
    }
    
    // Check and resolve collisions
    handleShipCollisions(newWorld.ships);
  }

  // Phase 2: Enhanced player update with carrier detection
  const allEvents: CarrierChangeEvent[] = [];
  
  for (const player of newWorld.players) {
    const events = updatePlayerWithDetection(player, newWorld.ships, newWorld.carrierDetection, inputFrame, dt, newWorld.timestamp);
    allEvents.push(...events);
  }

  // Store events for potential camera system usage (could be used by GameEngine)
  (newWorld as any).carrierEvents = allEvents;

  return newWorld;
}

/**
 * Enhanced ship physics with realistic speed-dependent turning
 */
/**
 * Update ship physics (forces and velocities, but not position integration)
 */
function updateShipPhysics(ship: Ship, dt: number): void {
  // Find helm module to get steering input
  const helmModule = ship.modules.find(m => m.kind === 'helm');
  let steeringInput = 0;
  
  if (helmModule && helmModule.moduleData) {
    const helmData = helmModule.moduleData as any;
    steeringInput = helmData.currentInput?.x || 0;
  }

  // Calculate current speed for turning effectiveness
  const currentSpeed = ship.velocity.length();
  const minTurningSpeed = 5; // Below this speed, turning is very slow
  const maxTurningSpeed = 40; // Above this speed, turning is at full effectiveness
  
  // Speed-based turning effectiveness (reduced by 50%)
  let turningEffectiveness;
  if (currentSpeed < minTurningSpeed) {
    // Very slow turning when stationary or moving very slowly (50% reduction)
    turningEffectiveness = 0.05 + (currentSpeed / minTurningSpeed) * 0.1; // 0.05 to 0.15 (was 0.1 to 0.3)
  } else {
    // Normal turning when moving (50% reduction)
    const speedFactor = Math.min(currentSpeed / maxTurningSpeed, 1.0);
    turningEffectiveness = 0.15 + speedFactor * 0.35; // 0.15 to 0.5 (was 0.3 to 1.0)
  }
  
  // Apply steering force with speed-dependent effectiveness
  const baseAngularAcceleration = 1.5; // Base turning force
  const effectiveSteeringForce = steeringInput * turningEffectiveness;
  const angularDamping = 0.92; // Damping factor
  
  // Apply steering force
  ship.angularVelocity += effectiveSteeringForce * baseAngularAcceleration * dt;
  
  // Apply angular damping
  ship.angularVelocity *= angularDamping;
  
  // Update rotation
  ship.rotation = AngleUtils.wrap(ship.rotation + ship.angularVelocity * dt);

  // Calculate forward thrust based on sail configuration
  let totalSailPower = 0;
  let sailCount = 0;
  
  // Check all mast modules for sail configuration
  for (const module of ship.modules) {
    if (module.kind === 'mast' && module.moduleData) {
      const mastData = module.moduleData as any;
      const openness = mastData.openness || 0; // 0-100 sail openness
      const efficiency = mastData.windEfficiency || 0.8; // How well this mast works
      
      // Convert openness (0-100) to power contribution with exponential scaling
      const opennessFactor = openness / 100; // 0-1
      const sailPower = Math.pow(opennessFactor, 0.7) * efficiency; // Exponential curve for more power
      totalSailPower += sailPower;
      sailCount++;
    }
  }
  
  // Calculate thrust force based on sail power - Reduced wind power
  const maxThrust = 8000; // Reduced from 15000
  const minThrust = 300;  // Reduced from 500
  
  let thrustForce = minThrust;
  if (sailCount > 0) {
    const averageSailPower = totalSailPower / sailCount;
    
    // Multi-mast bonus: More masts = higher efficiency (reduced)
    const mastBonus = 1 + (sailCount - 1) * 0.1; // 10% bonus per additional mast (was 20%)
    
    // Wind power amplification based on total sail area (reduced)
    const sailAreaMultiplier = 1 + (totalSailPower * 0.25); // Up to 25% bonus (was 50%)
    
    const finalSailPower = averageSailPower * mastBonus * sailAreaMultiplier;
    thrustForce = minThrust + (maxThrust - minThrust) * Math.min(finalSailPower, 1.25); // Cap at 125% (was 150%)
  }
  
  // Apply thrust in forward direction
  const forwardDir = Vec2.from(Math.cos(ship.rotation), Math.sin(ship.rotation));
  const thrustVector = forwardDir.mul(thrustForce);
  
  // Ship mass affects acceleration (lighter ships accelerate faster)
  const shipMass = 60; // Reduced from 120 for faster acceleration
  const acceleration = thrustVector.div(shipMass);
  
  // Apply acceleration to velocity
  ship.velocity = ship.velocity.add(acceleration.mul(dt));
  
  // Speed-dependent drag (reduced drag for higher speeds)
  const baseDrag = 0.995; // Reduced from 0.985 for less drag
  const speedDragFactor = 1 - (currentSpeed * 0.0002); // Reduced from 0.0005
  const finalDrag = Math.max(baseDrag * speedDragFactor, 0.98); // Higher minimum drag
  
  ship.velocity = ship.velocity.mul(finalDrag);
  
  // Note: Position integration is now handled separately in the collision loop
}

/**
 * Update ship physics including position (legacy compatibility)
 */
function updateShipWithPosition(ship: Ship, dt: number): void {
  updateShipPhysics(ship, dt);
  
  // Update position
  ship.position = ship.position.add(ship.velocity.mul(dt));
  ship.rotation += ship.angularVelocity * dt;
}

/**
 * Enhanced player update with Phase 2 carrier detection
 */
function updatePlayerWithDetection(
  player: Player, 
  ships: Ship[], 
  carrierDetectionMap: Map<number, CarrierDetectionState>,
  inputFrame: InputFrame, 
  dt: number,
  currentTime: number
): CarrierChangeEvent[] {
  // Get or create detection state for this player
  let detectionState = carrierDetectionMap.get(player.id);
  if (!detectionState) {
    detectionState = createCarrierDetectionState();
    carrierDetectionMap.set(player.id, detectionState);
  }
  
  // Update carrier detection
  const { newState, events } = updateCarrierDetection(
    player, 
    ships, 
    detectionState, 
    currentTime
  );
  
  // Store updated detection state
  carrierDetectionMap.set(player.id, newState);
  
  // Update player's carrierId based on detection result
  const newCarrierId = newState.currentCarrierId || 0;
  player.carrierId = newCarrierId;
  player.onDeck = newCarrierId > 0;
  
  // Apply physics based on carrier status
  const carrierShip = ships.find(ship => ship.id === newCarrierId);
  
  if (carrierShip && player.onDeck) {
    updatePlayerOnDeck(player, carrierShip, inputFrame, dt);
  } else {
    updatePlayerOffDeck(player, ships, inputFrame, dt);
  }
  
  return events;
}

/**
 * Initialize carrier detection for all players in a world state
 */
export function initializeCarrierDetection(world: WorldState): void {
  if (!world.carrierDetection) {
    world.carrierDetection = new Map();
  }
  
  for (const player of world.players) {
    if (!world.carrierDetection.has(player.id)) {
      world.carrierDetection.set(player.id, createCarrierDetectionState());
    }
  }
}

/**
 * Enhanced carrier physics implementation with better rotation handling
 */
function updatePlayerOnDeck(player: Player, ship: Ship, inputFrame: InputFrame, dt: number): void {
  // Step 1: Enhanced ship motion deltas with improved rotation handling
  const prevShipPos = ship.position.sub(ship.velocity.mul(dt));
  const prevShipRot = AngleUtils.wrap(ship.rotation - ship.angularVelocity * dt);
  
  const deltaRot = AngleUtils.diff(ship.rotation, prevShipRot);
  
  // Step 2: Enhanced carrier motion with proper rotation around ship pivot
  // Position relative to ship center at previous time
  const relativePos = player.position.sub(prevShipPos);
  
  // For high angular velocities, use more accurate rotation
  let rotatedRelativePos: Vec2;
  if (Math.abs(deltaRot) > 0.1) {
    // High rotation: use exact rotation matrix
    rotatedRelativePos = relativePos.rotate(deltaRot);
  } else {
    // Low rotation: use linear approximation for stability
    const tangentialVel = relativePos.perp().mul(ship.angularVelocity * dt);
    rotatedRelativePos = relativePos.add(tangentialVel);
  }
  
  // New carried position with momentum preservation
  const carriedPosition = ship.position.add(rotatedRelativePos);
  
  // Step 3: Apply player input (keep in world coordinates - this was working correctly!)
  const inputLocal = inputFrame.movement.mul(PhysicsConfig.PLAYER_SPEED);
  // Input is already in world coordinates due to camera transformation - don't "enhance" what works!
  const inputWorld = inputLocal;
  
  // Step 4: Enhanced ice-drift damping with ship momentum preservation
  const shipVelAtPlayer = ship.velocity.add(relativePos.perp().mul(ship.angularVelocity));
  const relativeVel = player.velocity.sub(shipVelAtPlayer);
  
  // Improved exponential decay with frame-rate independence
  const lambda = Math.log(2) / PhysicsConfig.ICE_DRIFT_HALF_LIFE;
  const dampingFactor = Math.exp(-lambda * dt);
  const dampedRelativeVel = relativeVel.mul(dampingFactor);
  
  // Calculate new velocity with better momentum conservation
  const baseVelocity = shipVelAtPlayer.add(dampedRelativeVel);
  const inputVelocityChange = inputWorld.mul(dt);
  player.velocity = baseVelocity.add(inputVelocityChange);
  
  // Step 5: Position after input with input buffering for smoothness
  const newPosition = carriedPosition.add(inputWorld.mul(dt));
  
  // Step 6: Enhanced plank-based containment system  
  // Use individual plank modules instead of solid ship deck
  const epsilon = PhysicsConfig.EPS_FACTOR * player.radius;
  
  // When in updatePlayerOnDeck, we need to be careful about collision modes:
  // - If player is clearly inside ship bounds, enable containment (prevent exit)
  // - If player is at the edge/outside, allow normal collision but no special ladder entry
  const isJumping = (inputFrame.actions & PlayerActions.JUMP) !== 0;

  // Special case: If player is jumping and near the ship edge, help them exit
  if (isJumping) {
    const distanceToShipCenter = carriedPosition.sub(ship.position).length();
    const shipRadius = 120; // Approximate ship radius
    
    if (distanceToShipCenter > shipRadius * 0.7) {
      // Player is jumping near the ship edge - bias them toward exiting
      console.log(`Player ${player.id} jumping near ship edge - assisting exit`);
      // Apply outward force to help them clear the ship
      const awayFromShip = carriedPosition.sub(ship.position).normalize();
      const exitBoost = awayFromShip.mul(PhysicsConfig.PLAYER_SPEED * 0.5 * dt);
      player.position = carriedPosition.add(inputWorld.mul(dt)).add(exitBoost);
      return; // Skip collision detection to allow clean exit
    }
  }

  // Always use plank-based collision system - this replaces the old deck polygon collision
  const collisionResult = CollisionSystem.sweptCircleVsPlankSegments(
    carriedPosition,
    newPosition,
    player.radius,
    player.velocity,
    ship,
    epsilon,
    dt,
    false, // Don't allow ladder entry when on deck (they should walk off normally)
    isJumping   // Allow exit when jumping
  );
  
  if (collisionResult.collided) {
    // Apply collision result with sliding
    player.position = collisionResult.newPosition;
    player.velocity = collisionResult.newVelocity;
    
    // Add sliding friction for more realistic feel
    const slideFriction = 0.95;
    player.velocity = player.velocity.mul(slideFriction);
  } else {
    // No collision detected by plank system - allow movement
    player.position = newPosition;
    
    // Check if player moved through a gap and should now be swimming
    // This happens when planks are destroyed creating openings
    const playerNowOutsideShip = !isPlayerInsideShipBounds(player.position, ship);
    if (playerNowOutsideShip && player.onDeck) {
      // Player fell through a gap - they should now be swimming
      // Note: The carrier detection system will handle the actual onDeck state change
      // This just ensures smooth position transition
      console.log(`Player ${player.id} fell through plank gap at position ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}!`);
    }
  }
}

/**
 * Quick check if player is inside the basic ship bounds (for gap detection)
 */
function isPlayerInsideShipBounds(playerPos: Vec2, ship: Ship): boolean {
  // Transform player position to ship-local coordinates
  const localPos = playerPos.sub(ship.position).rotate(-ship.rotation);
  
  // Use more accurate hull polygon check instead of simple rectangle
  // This provides better detection for curved hull shapes
  const epsilon = 10; // Small buffer for floating-point precision
  const inside = PolygonUtils.pointInPolygon(localPos, ship.hull, epsilon);
  
  return inside;
}

/**
 * Enhanced free movement when player is not on deck
 */
function updatePlayerOffDeck(player: Player, ships: Ship[], inputFrame: InputFrame, dt: number): void {
  const inputVel = inputFrame.movement.mul(PhysicsConfig.PLAYER_SPEED);
  
  // Enhanced water/swimming physics simulation
  const waterDrag = 0.85; // Higher drag in water
  const inputResponsiveness = 8.0; // How quickly player responds to input
  
  // Apply water drag and input
  player.velocity = player.velocity.mul(waterDrag).add(inputVel.mul(dt * inputResponsiveness));
  
  // Add small current/drift for more interesting water movement
  const currentStrength = 10; // units/s
  const currentDir = Vec2.from(0.3, 0.1).normalize(); // Slight current
  const current = currentDir.mul(currentStrength * dt);
  
  player.velocity = player.velocity.add(current);
  
  // Calculate intended new position
  const intendedPosition = player.position.add(player.velocity.mul(dt));
  
  // Check collision with all nearby ships for swimming players
  let finalPosition = intendedPosition;
  let finalVelocity = player.velocity;
  
  for (const ship of ships) {
    const epsilon = PhysicsConfig.EPS_FACTOR * player.radius;
    
    // Check if this ship is close enough to matter (performance optimization)
    const distanceToShip = player.position.distanceTo(ship.position);
    const maxRelevantDistance = 400; // Generous bounding check
    if (distanceToShip > maxRelevantDistance) continue;
    
    // Use collision system to check for ship hull collision
    const collisionResult = CollisionSystem.sweptCircleVsPlankSegments(
      player.position,
      finalPosition,
      player.radius,
      finalVelocity,
      ship,
      epsilon,
      dt,
      true,  // allowLadderEntry = true for swimming players
      false  // allowJumpExit = false for swimming players
    );
    
    if (collisionResult.collided) {
      finalPosition = collisionResult.newPosition;
      finalVelocity = collisionResult.newVelocity;
      break; // Only handle one collision per frame for simplicity
    }
  }
  
  player.position = finalPosition;
  player.velocity = finalVelocity;
  
  // Clamp velocity to reasonable bounds for water movement
  const maxWaterSpeed = PhysicsConfig.PLAYER_SPEED * 0.7; // Slower in water
  if (player.velocity.lengthSq() > maxWaterSpeed * maxWaterSpeed) {
    player.velocity = player.velocity.normalize().mul(maxWaterSpeed);
  }
}

/**
 * Calculate the bounding radius of a ship based on its deck or hull
 */
function calculateShipBoundingRadius(ship: Ship): number {
  const deck = getShipDeck(ship);
  let points: Vec2[];
  
  if (deck && deck.moduleData) {
    const deckData = deck.moduleData as any;
    points = (deckData.area && Array.isArray(deckData.area)) ? deckData.area : ship.hull;
  } else {
    points = ship.hull;
  }
  
  // Find the maximum distance from center to any point
  let maxDistance = 0;
  for (const point of points) {
    const distance = point.length();
    maxDistance = Math.max(maxDistance, distance);
  }
  
  return maxDistance + 10; // Add small buffer
}

/**
 * Handle collisions between ships
 */
function handleShipCollisions(ships: Ship[]): void {
  // Check all pairs of ships for collisions
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const ship1 = ships[i];
      const ship2 = ships[j];
      
      // Check if ships are close enough to potentially collide (improved broad phase)
      const distance = ship1.position.sub(ship2.position).length();
      const ship1Radius = calculateShipBoundingRadius(ship1);
      const ship2Radius = calculateShipBoundingRadius(ship2);
      const combinedRadius = ship1Radius + ship2Radius;
      
      if (distance < combinedRadius) {
        // Perform more precise deck-to-deck collision detection
        const collision = checkShipHullCollision(ship1, ship2);
        
        if (collision.isColliding) {
          // Resolve the collision with realistic ship physics
          resolveShipCollision(ship1, ship2, collision);
          
          // Calculate plank damage from the collision
          calculateCollisionPlankDamage(ship1, ship2, collision);
        }
      }
    }
  }
}

/**
 * Check for collision between two ship hulls using deck shapes
 */
function checkShipHullCollision(ship1: Ship, ship2: Ship): {
  isColliding: boolean;
  normal: Vec2;
  penetration: number;
  contactPoint: Vec2;
} {
  // Get deck modules from both ships for consistent collision detection
  const ship1Deck = getShipDeck(ship1);
  const ship2Deck = getShipDeck(ship2);
  
  if (!ship1Deck || !ship2Deck) {
    // Fallback to hull-based collision if no deck found
    return checkHullPolygonCollision(ship1, ship2);
  }
  
  // Get deck areas (polygons) in world coordinates
  const deck1Data = ship1Deck.moduleData as any;
  const deck2Data = ship2Deck.moduleData as any;
  
  // Ensure we have proper deck areas
  const deck1Area = (deck1Data && deck1Data.area && Array.isArray(deck1Data.area)) 
    ? deck1Data.area : ship1.hull;
  const deck2Area = (deck2Data && deck2Data.area && Array.isArray(deck2Data.area)) 
    ? deck2Data.area : ship2.hull;
  
  const deck1World = deck1Area.map((p: Vec2) => 
    p.rotate(ship1.rotation).add(ship1.position)
  );
  const deck2World = deck2Area.map((p: Vec2) => 
    p.rotate(ship2.rotation).add(ship2.position)
  );
  
  // Use SAT for polygon-to-polygon collision
  return checkPolygonCollision(deck1World, deck2World, ship1.position, ship2.position);
}

/**
 * Get the deck module from a ship
 */
function getShipDeck(ship: Ship) {
  return ship.modules.find(module => module.kind === 'deck');
}

/**
 * Fallback hull-based collision detection
 */
function checkHullPolygonCollision(ship1: Ship, ship2: Ship): {
  isColliding: boolean;
  normal: Vec2;
  penetration: number;
  contactPoint: Vec2;
} {
  const hull1World = ship1.hull.map(p => p.rotate(ship1.rotation).add(ship1.position));
  const hull2World = ship2.hull.map(p => p.rotate(ship2.rotation).add(ship2.position));
  
  return checkPolygonCollision(hull1World, hull2World, ship1.position, ship2.position);
}

/**
 * Generic polygon collision detection using SAT
 */
function checkPolygonCollision(
  poly1: Vec2[], 
  poly2: Vec2[], 
  center1: Vec2, 
  center2: Vec2
): {
  isColliding: boolean;
  normal: Vec2;
  penetration: number;
  contactPoint: Vec2;
} {
  const axes: Vec2[] = [];
  
  // Get normal vectors from both polygons
  for (let i = 0; i < poly1.length; i++) {
    const current = poly1[i];
    const next = poly1[(i + 1) % poly1.length];
    const edge = next.sub(current);
    axes.push(Vec2.from(-edge.y, edge.x).normalize());
  }
  
  for (let i = 0; i < poly2.length; i++) {
    const current = poly2[i];
    const next = poly2[(i + 1) % poly2.length];
    const edge = next.sub(current);
    axes.push(Vec2.from(-edge.y, edge.x).normalize());
  }
  
  let minOverlap = Infinity;
  let separationAxis = Vec2.zero();
  
  // Test each axis for separation
  for (const axis of axes) {
    const proj1 = projectPolygonOntoAxis(poly1, axis);
    const proj2 = projectPolygonOntoAxis(poly2, axis);
    
    const overlap = Math.min(proj1.max, proj2.max) - Math.max(proj1.min, proj2.min);
    
    if (overlap <= 0) {
      return {
        isColliding: false,
        normal: Vec2.zero(),
        penetration: 0,
        contactPoint: Vec2.zero()
      };
    }
    
    if (overlap < minOverlap) {
      minOverlap = overlap;
      separationAxis = axis;
    }
  }
  
  // Ensure normal points from ship1 to ship2
  const centerDiff = center2.sub(center1);
  if (centerDiff.dot(separationAxis) < 0) {
    separationAxis = separationAxis.mul(-1);
  }
  
  return {
    isColliding: true,
    normal: separationAxis,
    penetration: minOverlap,
    contactPoint: center1.add(center2).mul(0.5)
  };
}

/**
 * Project a polygon onto an axis
 */
function projectPolygonOntoAxis(vertices: Vec2[], axis: Vec2): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  
  for (const vertex of vertices) {
    const projection = vertex.dot(axis);
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  
  return { min, max };
}

/**
 * Resolve collision between two ships with realistic physics
 */
function resolveShipCollision(ship1: Ship, ship2: Ship, collision: any): void {
  const normal = collision.normal;
  const penetration = collision.penetration;
  
  // Ship masses (assume larger ships are heavier)
  const mass1 = 1000; // Base ship mass
  const mass2 = 1000; // Base ship mass
  const totalMass = mass1 + mass2;
  
  // Separate ships to avoid overlap
  const separationRatio1 = mass2 / totalMass; // Lighter object moves more
  const separationRatio2 = mass1 / totalMass;
  
  ship1.position = ship1.position.sub(normal.mul(penetration * separationRatio1));
  ship2.position = ship2.position.add(normal.mul(penetration * separationRatio2));
  
  // Calculate relative velocity at collision point
  const relativeVelocity = ship2.velocity.sub(ship1.velocity);
  const velocityAlongNormal = relativeVelocity.dot(normal);
  
  // Don't resolve if objects are separating
  if (velocityAlongNormal > 0) return;
  
  // Very low restitution for realistic ship collision (no bounce)
  const restitution = 0.05; // Ships are heavy and absorb impact
  const impulseScalar = -(1 + restitution) * velocityAlongNormal / totalMass;
  const impulse = normal.mul(impulseScalar);
  
  // Apply impulse to velocities with momentum transfer
  const momentum1 = impulse.mul(mass2);
  const momentum2 = impulse.mul(mass1);
  
  ship1.velocity = ship1.velocity.sub(momentum1);
  ship2.velocity = ship2.velocity.add(momentum2);
  
  // Calculate impact speed for damage scaling
  const impactSpeed = Math.abs(velocityAlongNormal);
  
  // Add angular velocity based on impact location and speed
  const arm1 = collision.contactPoint.sub(ship1.position);
  const arm2 = collision.contactPoint.sub(ship2.position);
  const angularFactor = Math.min(impactSpeed * 0.0005, 0.002); // Scale with impact speed
  
  const torque1 = arm1.cross(momentum1.mul(-1)) * angularFactor;
  const torque2 = arm2.cross(momentum2) * angularFactor;
  
  ship1.angularVelocity += torque1;
  ship2.angularVelocity += torque2;
  
  // Heavy damping for realistic water resistance and structural damage absorption
  const speedDamping = Math.max(0.7, 1.0 - impactSpeed * 0.01); // More damping at high speeds
  const angularDamping = Math.max(0.6, 1.0 - impactSpeed * 0.015);
  
  ship1.velocity = ship1.velocity.mul(speedDamping);
  ship2.velocity = ship2.velocity.mul(speedDamping);
  ship1.angularVelocity *= angularDamping;
  ship2.angularVelocity *= angularDamping;
}

/**
 * Calculate plank damage from ship collision
 */
function calculateCollisionPlankDamage(ship1: Ship, ship2: Ship, collision: any): void {
  const impactForce = collision.penetration * 10; // Convert penetration to damage force
  const damageRadius = 50; // Radius around contact point where planks take damage
  const baseDamage = Math.min(impactForce * 2, 15); // Cap collision damage at 15 per hit
  
  // Apply damage to planks near the collision contact point on both ships
  applyCollisionDamageToShip(ship1, collision.contactPoint, baseDamage, damageRadius);
  applyCollisionDamageToShip(ship2, collision.contactPoint, baseDamage, damageRadius);
}

/**
 * Apply collision damage to planks within radius of contact point
 */
function applyCollisionDamageToShip(ship: Ship, contactPoint: Vec2, baseDamage: number, damageRadius: number): void {
  for (const module of ship.modules) {
    if (module.kind !== 'plank') continue;
    if (!module.moduleData || module.moduleData.kind !== 'plank') continue;
    
    const plankData = module.moduleData as any;
    if (plankData.health <= 0) continue; // Skip already destroyed planks
    
    // Calculate plank position in world coordinates
    const plankWorldPos = module.localPos.rotate(ship.rotation).add(ship.position);
    const distanceToContact = plankWorldPos.sub(contactPoint).length();
    
    // Apply damage based on distance to contact point
    if (distanceToContact <= damageRadius) {
      const damageMultiplier = 1 - (distanceToContact / damageRadius); // Closer = more damage
      const damage = baseDamage * damageMultiplier;
      
      plankData.health = Math.max(0, plankData.health - damage);
      
      if (plankData.health <= 0 && damage > 0) {
        console.log(`💥 Collision destroyed plank! (${damage.toFixed(1)} damage)`);
        plankData.destroyed = true;
      } else if (damage > 0) {
        console.log(`⚔️ Collision damaged plank: ${plankData.health.toFixed(1)} health remaining`);
      }
    }
  }
}