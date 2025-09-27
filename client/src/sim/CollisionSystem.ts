import { Vec2 } from '../common/Vec2.js';
import { PolygonUtils } from '../common/PolygonUtils.js';
import { Ship } from './Types.js';

/**
 * Advanced collision system for carrier movement
 * Handles swept circle vs polygon collision with sliding and penetration resolution
 */

interface TrackedCollision {
  timestamp: number;
  playerPosition: Vec2;
  collisionPoint: Vec2;
  normal: Vec2;
  penetrationDepth: number;
  slideDistance: number;
  isPlankCollision: boolean;
  plankId?: number;
}

// Global collision tracker for debugging
const globalCollisionTracker: TrackedCollision[] = [];

export interface CollisionResult {
  newPosition: Vec2;
  newVelocity: Vec2;
  collided: boolean;
  normal: Vec2;           // Surface normal at collision point
  penetrationDepth: number;
  contactPoint: Vec2;     // Point of contact on polygon edge
  slideDistance: number;  // How far the object slid along the surface
}

export interface SweptCollisionInput {
  startPos: Vec2;
  endPos: Vec2;
  radius: number;
  velocity: Vec2;
  polygon: Vec2[];
  epsilon: number;
  dt: number;
}

interface PlankSegment {
  start: Vec2;
  end: Vec2;
  plankId: number;
}

/**
 * Advanced collision system for smooth player movement on ships
 */
export class CollisionSystem {
  /**
   * Track a collision for debugging purposes
   */
  static trackCollision(
    playerPosition: Vec2,
    collisionPoint: Vec2,
    normal: Vec2,
    penetrationDepth: number,
    slideDistance: number,
    isPlankCollision: boolean = true,
    plankId?: number
  ): void {
    globalCollisionTracker.push({
      timestamp: Date.now(),
      playerPosition: playerPosition,
      collisionPoint: collisionPoint,
      normal: normal,
      penetrationDepth: penetrationDepth,
      slideDistance: slideDistance,
      isPlankCollision: isPlankCollision,
      plankId: plankId
    });
    
    // Keep only recent collisions (last 5 seconds)
    const cutoff = Date.now() - 5000;
    while (globalCollisionTracker.length > 0 && globalCollisionTracker[0].timestamp < cutoff) {
      globalCollisionTracker.shift();
    }
    
    // Limit array size
    if (globalCollisionTracker.length > 100) {
      globalCollisionTracker.splice(0, 50);
    }
  }
  
  /**
   * Get recent collision events for debugging
   */
  static getRecentCollisions(): TrackedCollision[] {
    return [...globalCollisionTracker];
  }
  
  /**
   * Clear collision tracking
   */
  static clearCollisionTracking(): void {
    globalCollisionTracker.length = 0;
  }

  /**
   * Perform swept circle collision with sliding along polygon edges
   * This prevents tunneling and provides smooth sliding behavior
   */
  static sweptCircleVsPolygon(input: SweptCollisionInput): CollisionResult {
    const { startPos, endPos, radius, velocity, polygon, epsilon } = input;
    
    // Check if start position is already inside with enough margin
    const expandedRadius = radius + epsilon;
    const startInside = PolygonUtils.pointInPolygon(startPos, polygon, expandedRadius);
    const endInside = PolygonUtils.pointInPolygon(endPos, polygon, expandedRadius);
    
    // If both start and end are inside, no collision needed
    if (startInside && endInside) {
      return {
        newPosition: endPos,
        newVelocity: velocity,
        collided: false,
        normal: Vec2.zero(),
        penetrationDepth: 0,
        contactPoint: endPos,
        slideDistance: 0
      };
    }
    
    // If ending up outside, need to handle collision
    if (startInside && !endInside) {
      return this.handleExitCollision(input);
    }
    
    // If starting outside, try to enter or slide along boundary
    if (!startInside && !endInside) {
      return this.handleEntryOrSlide(input);
    }
    
    // Starting outside, ending inside - handle entry
    return this.handleEntry(input);
  }
  
  /**
   * Handle collision when player tries to exit the polygon
   */
  private static handleExitCollision(input: SweptCollisionInput): CollisionResult {
    const { startPos, endPos, radius, velocity, polygon, epsilon } = input;
    const expandedRadius = radius + epsilon;
    
    // Find the edge being crossed
    const movement = endPos.sub(startPos);
    let bestEdge: { edge: [Vec2, Vec2], t: number, normal: Vec2 } | null = null;
    let minT = Infinity;
    
    for (let i = 0; i < polygon.length; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % polygon.length];
      
      // Check ray-vs-line intersection
      const result = this.rayVsLineSegment(startPos, movement, p1, p2, expandedRadius);
      if (result && result.t < minT && result.t >= 0 && result.t <= 1) {
        minT = result.t;
        bestEdge = {
          edge: [p1, p2],
          t: result.t,
          normal: result.normal
        };
      }
    }
    
    if (!bestEdge) {
      // No collision found, clamp to closest point
      return this.clampToClosestPoint(input);
    }
    
    // Stop at collision point and slide along the edge
    const collisionPoint = startPos.add(movement.mul(bestEdge.t));
    const slideVelocity = this.calculateSlideVelocity(velocity, bestEdge.normal);
    
    return {
      newPosition: collisionPoint,
      newVelocity: slideVelocity,
      collided: true,
      normal: bestEdge.normal,
      penetrationDepth: 0,
      contactPoint: collisionPoint,
      slideDistance: slideVelocity.length() * input.dt
    };
  }
  
  /**
   * Handle case where player is outside and trying to enter or slide
   */
  private static handleEntryOrSlide(input: SweptCollisionInput): CollisionResult {
    // Implement proper swept collision for entry
    return this.sweptCirclePolygon(input);
  }
  
  /**
   * Swept collision detection: circle moving along a line vs polygon
   */
  private static sweptCirclePolygon(input: SweptCollisionInput): CollisionResult {
    const { startPos, endPos, radius, polygon, epsilon, velocity } = input;
    const expandedRadius = radius + epsilon;
    const movement = endPos.sub(startPos);
    const movementLength = movement.length();
    
    if (movementLength < 1e-6) {
      // No movement, fall back to simple clamping
      return this.clampToClosestPoint(input);
    }
    
    const movementDir = movement.normalize();
    let closestCollisionTime = Infinity;
    let collisionNormal = Vec2.zero();
    let collisionPoint = startPos;
    
    // Check collision with each edge of the polygon
    for (let i = 0; i < polygon.length; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % polygon.length];
      const edge = p2.sub(p1);
      const edgeLength = edge.length();
      
      if (edgeLength < 1e-6) continue; // Skip degenerate edges
      
      const edgeDir = edge.normalize();
      const edgeNormal = Vec2.from(-edgeDir.y, edgeDir.x); // Outward normal
      
      // Check if moving towards the edge
      const approachSpeed = -movementDir.dot(edgeNormal);
      if (approachSpeed <= 0) continue; // Moving away or parallel
      
      // Distance from start position to edge line
      const toP1 = startPos.sub(p1);
      const distanceToEdgeLine = toP1.dot(edgeNormal);
      
      // Time to reach edge (if moving towards it)
      const timeToEdge = (distanceToEdgeLine - expandedRadius) / approachSpeed;
      
      if (timeToEdge < 0 || timeToEdge > movementLength / velocity.length()) {
        continue; // Already past edge or won't reach it
      }
      
      // Position at collision time
      const collisionPos = startPos.add(movementDir.mul(timeToEdge * velocity.length()));
      
      // Check if collision point is within the edge segment
      const toCollision = collisionPos.sub(p1);
      const projectionLength = toCollision.dot(edgeDir);
      
      if (projectionLength >= 0 && projectionLength <= edgeLength) {
        // Valid collision with edge
        if (timeToEdge < closestCollisionTime) {
          closestCollisionTime = timeToEdge;
          collisionNormal = edgeNormal;
          collisionPoint = collisionPos;
        }
      }
    }
    
    // Also check collision with vertices (rounded corners)
    for (const vertex of polygon) {
      const toVertex = startPos.sub(vertex);
      const a = movement.dot(movement);
      const b = 2 * toVertex.dot(movement);
      const c = toVertex.dot(toVertex) - (expandedRadius * expandedRadius);
      
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const t1 = (-b - Math.sqrt(discriminant)) / (2 * a);
        const t2 = (-b + Math.sqrt(discriminant)) / (2 * a);
        
        const t = (t1 >= 0 && t1 <= 1) ? t1 : (t2 >= 0 && t2 <= 1) ? t2 : -1;
        
        if (t >= 0 && t < closestCollisionTime / movementLength) {
          const collisionPos = startPos.add(movement.mul(t));
          const normal = collisionPos.sub(vertex).normalize();
          
          closestCollisionTime = t * movementLength;
          collisionNormal = normal;
          collisionPoint = collisionPos;
        }
      }
    }
    
    if (closestCollisionTime < Infinity) {
      // Collision detected - slide along the surface
      const slideDirection = movementDir.sub(collisionNormal.mul(movementDir.dot(collisionNormal)));
      const remainingDistance = movementLength - closestCollisionTime;
      const slideVelocity = slideDirection.mul(velocity.length());
      const finalPosition = collisionPoint.add(slideDirection.mul(remainingDistance));
      
      return {
        newPosition: finalPosition,
        newVelocity: slideVelocity,
        collided: true,
        normal: collisionNormal,
        penetrationDepth: 0,
        contactPoint: collisionPoint,
        slideDistance: remainingDistance
      };
    }
    
    // No collision - allow free movement
    return {
      newPosition: endPos,
      newVelocity: velocity,
      collided: false,
      normal: Vec2.zero(),
      penetrationDepth: 0,
      contactPoint: endPos,
      slideDistance: 0
    };
  }
  
  /**
   * Handle entry into polygon
   */
  private static handleEntry(input: SweptCollisionInput): CollisionResult {
    // Allow entry with simple position
    return {
      newPosition: input.endPos,
      newVelocity: input.velocity,
      collided: false,
      normal: Vec2.zero(),
      penetrationDepth: 0,
      contactPoint: input.endPos,
      slideDistance: 0
    };
  }
  
  /**
   * Fallback: clamp position to closest valid point on polygon
   */
  private static clampToClosestPoint(input: SweptCollisionInput): CollisionResult {
    const { endPos, radius, polygon, epsilon } = input;
    const expandedRadius = radius + epsilon;
    
    const closestPoint = PolygonUtils.closestPointOnPolygon(endPos, polygon);
    const toCenter = endPos.sub(closestPoint);
    const distance = toCenter.length();
    
    if (distance < expandedRadius) {
      // Push back to safe distance
      const pushDirection = distance > 0 ? toCenter.normalize() : Vec2.from(0, -1);
      const safePosition = closestPoint.add(pushDirection.mul(expandedRadius));
      
      return {
        newPosition: safePosition,
        newVelocity: Vec2.zero(), // Stop on clamping
        collided: true,
        normal: pushDirection,
        penetrationDepth: expandedRadius - distance,
        contactPoint: closestPoint,
        slideDistance: 0
      };
    }
    
    return {
      newPosition: endPos,
      newVelocity: input.velocity,
      collided: false,
      normal: Vec2.zero(),
      penetrationDepth: 0,
      contactPoint: endPos,
      slideDistance: 0
    };
  }
  
  /**
   * Ray vs line segment intersection for swept collision
   */
  private static rayVsLineSegment(
    rayStart: Vec2, 
    rayDir: Vec2, 
    lineStart: Vec2, 
    lineEnd: Vec2, 
    radius: number
  ): { t: number; normal: Vec2 } | null {
    const lineDir = lineEnd.sub(lineStart);
    const lineLength = lineDir.length();
    
    if (lineLength < 1e-10) return null;
    
    const lineNorm = lineDir.normalize();
    const lineNormal = lineNorm.perp(); // Perpendicular to line
    
    // Offset line by radius
    const offsetStart = lineStart.add(lineNormal.mul(radius));
    
    // Ray-line intersection
    const toLineStart = offsetStart.sub(rayStart);
    const rayLength = rayDir.length();
    
    if (rayLength < 1e-10) return null;
    
    const rayNorm = rayDir.normalize();
    
    // Solve: rayStart + t * rayDir = offsetStart + s * (offsetEnd - offsetStart)
    const det = rayNorm.x * lineDir.y - rayNorm.y * lineDir.x;
    
    if (Math.abs(det) < 1e-10) return null; // Parallel
    
    const t = (toLineStart.x * lineDir.y - toLineStart.y * lineDir.x) / det;
    const s = (toLineStart.x * rayNorm.y - toLineStart.y * rayNorm.x) / det;
    
    // Check if intersection is within line segment
    if (s >= 0 && s <= lineLength && t >= 0) {
      return {
        t: t / rayLength, // Normalize to [0,1]
        normal: lineNormal.mul(-1) // Point inward
      };
    }
    
    return null;
  }
  
  /**
   * Calculate slide velocity along a surface
   */
  private static calculateSlideVelocity(velocity: Vec2, surfaceNormal: Vec2): Vec2 {
    // Project velocity onto surface (remove normal component)
    const normalComponent = velocity.dot(surfaceNormal);
    
    if (normalComponent >= 0) {
      // Moving away from surface, keep full velocity
      return velocity;
    }
    
    // Remove the component moving into the surface
    return velocity.sub(surfaceNormal.mul(normalComponent));
  }
  
  /**
   * Resolve penetration by pushing object out of polygon
   */
  static resolvePenetration(
    position: Vec2, 
    radius: Vec2, 
    polygon: Vec2[], 
    epsilon: number
  ): { newPosition: Vec2; penetrationDepth: number; normal: Vec2 } {
    const expandedRadius = radius.length() + epsilon;
    
    if (PolygonUtils.pointInPolygon(position, polygon, expandedRadius)) {
      const closestPoint = PolygonUtils.closestPointOnPolygon(position, polygon);
      const toCenter = position.sub(closestPoint);
      const distance = toCenter.length();
      const penetration = expandedRadius - distance;
      
      if (penetration > 0) {
        const pushDirection = distance > 0 ? toCenter.normalize() : Vec2.from(0, -1);
        const newPosition = closestPoint.add(pushDirection.mul(expandedRadius));
        
        return {
          newPosition,
          penetrationDepth: penetration,
          normal: pushDirection
        };
      }
    }
    
    return {
      newPosition: position,
      penetrationDepth: 0,
      normal: Vec2.zero()
    };
  }

  /**
   * Create collision segments from ship plank modules
   * Returns array of line segments representing physical barriers with plank IDs
   */
  static createPlankCollisionSegments(ship: Ship): PlankSegment[] {
    const segments: PlankSegment[] = [];
    
    // Find all healthy plank modules
    const planks = ship.modules.filter(module => {
      if (module.kind !== 'plank') return false;
      if (!module.moduleData || module.moduleData.kind !== 'plank') return false;
      
      // Only include planks with health > 0 (destroyed planks create gaps)
      return module.moduleData.health > 0;
    });
    
    for (const plank of planks) {
      if (plank.moduleData && plank.moduleData.kind === 'plank') {
        const plankData = plank.moduleData;
        const pos = plank.localPos;
        const rot = plank.localRot;
        
        // Create plank collision rectangle
        const halfLength = plankData.length / 2;
        const halfWidth = plankData.width / 2;
        
        // Define plank corners in local plank coordinates
        const corners = [
          Vec2.from(-halfLength, -halfWidth),
          Vec2.from(halfLength, -halfWidth),
          Vec2.from(halfLength, halfWidth),
          Vec2.from(-halfLength, halfWidth)
        ];
        
        // Transform to ship coordinates
        const shipCoords = corners.map(corner => 
          corner.rotate(rot).add(pos)
        );
        
        // Transform to world coordinates
        const worldCoords = shipCoords.map(point =>
          point.rotate(ship.rotation).add(ship.position)
        );
        
        // Create collision segments (4 edges of the plank rectangle)
        for (let i = 0; i < worldCoords.length; i++) {
          const start = worldCoords[i];
          const end = worldCoords[(i + 1) % worldCoords.length];
          segments.push({
            start: start,
            end: end,
            plankId: plank.id
          });
        }
      }
    }
    
    return segments;
  }

  /**
   * Check collision against plank segments with ladder exceptions
   * Allows entry through ladder zones while blocking other areas
   * Allows exit when jumping action is pressed
   */
  static sweptCircleVsPlankSegments(
    startPos: Vec2,
    endPos: Vec2,
    radius: number,
    velocity: Vec2,
    ship: Ship,
    epsilon: number,
    _dt: number, // Currently unused, might be needed for future physics calculations
    allowLadderEntry: boolean = true,
    allowJumpExit: boolean = false
  ): CollisionResult {
    const segments = this.createPlankCollisionSegments(ship);
    
    // Get ladder boarding zones for exceptions
    const ladderZones: Vec2[][] = [];
    if (allowLadderEntry) {
      const ladders = ship.modules.filter(m => m.kind === 'ladder');
      for (const ladder of ladders) {
        if (ladder.moduleData && ladder.moduleData.kind === 'ladder') {
          const ladderData = ladder.moduleData;
          const ladderPos = ladder.localPos;
          const ladderLength = ladderData.length;
          const ladderWidth = ladderData.width;
          
          // Calculate ladder direction
          const extendDirection = ladderData.extendDirection || Math.PI;
          const dirVec = Vec2.from(Math.cos(extendDirection), Math.sin(extendDirection));
          const perpVec = dirVec.perp();
          
          // Create ladder boarding zone
          const halfWidth = ladderWidth / 2;
          const ladderEnd = ladderPos.add(dirVec.mul(ladderLength));
          
          const ladderPoints = [
            ladderPos.add(perpVec.mul(halfWidth)),
            ladderPos.add(perpVec.mul(-halfWidth)),
            ladderEnd.add(perpVec.mul(-halfWidth)),
            ladderEnd.add(perpVec.mul(halfWidth))
          ].map(point => point.rotate(ship.rotation).add(ship.position));
          
          ladderZones.push(ladderPoints);
        }
      }
    }
    
    // Check if movement path intersects any ladder zones
    const pathIntersectsLadder = ladderZones.some(zone => 
      PolygonUtils.pointInPolygon(startPos, zone, radius + epsilon) ||
      PolygonUtils.pointInPolygon(endPos, zone, radius + epsilon)
    );
    
    // Check if player is inside ship bounds
    const startInside = this.isPlayerInsideShipBounds(startPos, ship, radius + epsilon);
    const endInside = this.isPlayerInsideShipBounds(endPos, ship, radius + epsilon);
    
    // If player is trying to exit the ship without jumping and not through a ladder
    if (startInside && !endInside && !allowJumpExit && !pathIntersectsLadder) {
      // Containment: prevent exit by clamping to the ship boundary
      const clampedPosition = this.clampPlayerToShipBounds(endPos, ship, radius + epsilon);
      
      // Calculate new velocity that slides along the boundary
      const actualMovement = clampedPosition.sub(startPos);
      const slideVelocity = actualMovement.length() > 0 ? 
        actualMovement.normalize().mul(velocity.length()) : 
        Vec2.zero();
      
      // Track the containment collision
      const normal = clampedPosition.sub(endPos);
      const normalizedNormal = normal.length() > 0 ? normal.normalize() : Vec2.from(0, -1);
      CollisionSystem.trackCollision(
        startPos,
        clampedPosition,
        normalizedNormal,
        endPos.sub(clampedPosition).length(),
        actualMovement.length(),
        true,
        -1 // Special ID for containment collision
      );
      
      return {
        newPosition: clampedPosition,
        newVelocity: slideVelocity,
        collided: true,
        normal: normalizedNormal,
        penetrationDepth: endPos.sub(clampedPosition).length(),
        contactPoint: clampedPosition,
        slideDistance: actualMovement.length()
      };
    }
    
    // If player is jumping, allow exit through any plank barrier
    if (allowJumpExit) {
      return {
        newPosition: endPos,
        newVelocity: velocity,
        collided: false,
        normal: Vec2.zero(),
        penetrationDepth: 0,
        contactPoint: Vec2.zero(),
        slideDistance: 0
      };
    }
    
    // Special case: Allow ladder entry only when swimming from OUTSIDE to INSIDE through a ladder
    if (pathIntersectsLadder && !startInside && endInside && allowLadderEntry) {
      return {
        newPosition: endPos,
        newVelocity: velocity,
        collided: false,
        normal: Vec2.zero(),
        penetrationDepth: 0,
        contactPoint: Vec2.zero(),
        slideDistance: 0
      };
    }
    
    // Check collision against all plank segments
    let closestCollision: CollisionResult | null = null;
    let closestTime = Infinity;
    let collisionPlankId: number | undefined = undefined;
    
    for (const segment of segments) {
      const segStart = segment.start;
      const segEnd = segment.end;
      
      // Use existing swept circle vs segment collision
      const collision = PolygonUtils.sweptCircleVsSegment(
        startPos, endPos, radius, segStart, segEnd
      );
      
      if (collision.hit && collision.time < closestTime) {
        closestTime = collision.time;
        collisionPlankId = segment.plankId;
        
        // Calculate collision position based on time
        const collisionPos = startPos.add(endPos.sub(startPos).mul(collision.time));
        
        // Calculate new velocity with reflection
        const normalComponent = velocity.dot(collision.normal);
        const newVelocity = velocity.sub(collision.normal.mul(normalComponent * 2));
        
        closestCollision = {
          newPosition: collisionPos,
          newVelocity: newVelocity,
          collided: true,
          normal: collision.normal,
          penetrationDepth: 0, // For swept collision, no penetration
          contactPoint: collision.point,
          slideDistance: 0 // Will be calculated if needed
        };
      }
    }
    
    if (closestCollision) {
      // Track the collision for debugging
      CollisionSystem.trackCollision(
        startPos,
        closestCollision.contactPoint,
        closestCollision.normal,
        closestCollision.penetrationDepth,
        closestCollision.slideDistance,
        true, // isPlankCollision
        collisionPlankId // Now we have the actual plank ID!
      );
      
      return closestCollision;
    }
    
    // No collision
    return {
      newPosition: endPos,
      newVelocity: velocity,
      collided: false,
      normal: Vec2.zero(),
      penetrationDepth: 0,
      contactPoint: Vec2.zero(),
      slideDistance: 0
    };
  }
  
  /**
   * Check if a player position is inside the ship's overall bounds
   * Optimized version that caches transformed hull coordinates
   */
  private static isPlayerInsideShipBounds(playerPos: Vec2, ship: Ship, expandedRadius: number): boolean {
    // Use cached transformed hull if available, otherwise compute it
    const shipHullWorld = this.getTransformedShipHull(ship);
    return PolygonUtils.pointInPolygon(playerPos, shipHullWorld, expandedRadius);
  }
  
  /**
   * Get transformed ship hull coordinates (with caching for performance)
   */
  private static hullCache = new Map<string, { hull: Vec2[], position: Vec2, rotation: number }>();
  
  private static getTransformedShipHull(ship: Ship): Vec2[] {
    const cacheKey = ship.id.toString();
    const cached = this.hullCache.get(cacheKey);
    
    // Check if cached version is still valid
    if (cached && 
        cached.position.equals(ship.position) && 
        Math.abs(cached.rotation - ship.rotation) < 1e-6) {
      return cached.hull;
    }
    
    // Compute and cache new transformed hull
    const transformedHull = ship.hull.map(point => 
      point.rotate(ship.rotation).add(ship.position)
    );
    
    this.hullCache.set(cacheKey, {
      hull: transformedHull,
      position: ship.position,
      rotation: ship.rotation
    });
    
    return transformedHull;
  }
  
  /**
   * Clear the hull transformation cache (call when ships are added/removed)
   */
  static clearHullCache(): void {
    this.hullCache.clear();
  }

  /**
   * Clamp player position to stay within ship bounds
   */
  private static clampPlayerToShipBounds(playerPos: Vec2, ship: Ship, expandedRadius: number): Vec2 {
    // Use cached transformed hull for better performance
    const shipHull = this.getTransformedShipHull(ship);
    
    // Simply find closest point on hull and move inward by expandedRadius
    const closestPoint = PolygonUtils.closestPointOnPolygon(playerPos, shipHull);
    
    // Calculate direction from closest point toward ship center
    const shipCenter = ship.position;
    const toCenter = shipCenter.sub(closestPoint);
    
    // If no clear direction to center, use a safe fallback
    if (toCenter.length() < 1e-6) {
      return shipCenter; // Just put player at ship center as fallback
    }
    
    // Move from the boundary point toward the center by expandedRadius
    const inwardDirection = toCenter.normalize();
    return closestPoint.add(inwardDirection.mul(expandedRadius));
  }
}
