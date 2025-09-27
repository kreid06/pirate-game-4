import { Vec2 } from './Vec2.js';

/**
 * Polygon collision and containment utilities
 */
export class PolygonUtils {
  // Point-in-polygon test with epsilon band for edge tolerance
  static pointInPolygon(point: Vec2, polygon: Vec2[], epsilon: number = 0): boolean {
    if (polygon.length < 3) return false;

    let inside = false;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const vi = polygon[i];
      const vj = polygon[j];

      if ((vi.y > point.y) !== (vj.y > point.y)) {
        const intersectX = (vj.x - vi.x) * (point.y - vi.y) / (vj.y - vi.y) + vi.x;
        if (point.x < intersectX) {
          inside = !inside;
        }
      }
    }

    // If epsilon > 0, also check if point is within epsilon distance of any edge
    if (!inside && epsilon > 0) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dist = PolygonUtils.pointToSegmentDistance(point, polygon[i], polygon[j]);
        if (dist <= epsilon) {
          return true;
        }
      }
    }

    return inside;
  }

  // Distance from point to line segment
  static pointToSegmentDistance(point: Vec2, segmentStart: Vec2, segmentEnd: Vec2): number {
    const segment = segmentEnd.sub(segmentStart);
    const segmentLength = segment.length();
    
    if (segmentLength === 0) {
      return point.distanceTo(segmentStart);
    }

    const t = Math.max(0, Math.min(1, point.sub(segmentStart).dot(segment) / segmentLength));
    const projection = segmentStart.add(segment.mul(t));
    return point.distanceTo(projection);
  }

  // Find closest point on polygon boundary
  static closestPointOnPolygon(point: Vec2, polygon: Vec2[]): Vec2 {
    if (polygon.length === 0) return point.clone();
    if (polygon.length === 1) return polygon[0].clone();

    let closestPoint = polygon[0].clone();
    let minDistance = point.distanceTo(polygon[0]);

    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      const segmentStart = polygon[i];
      const segmentEnd = polygon[j];
      
      const segment = segmentEnd.sub(segmentStart);
      const segmentLength = segment.lengthSq();
      
      if (segmentLength === 0) {
        const dist = point.distanceTo(segmentStart);
        if (dist < minDistance) {
          minDistance = dist;
          closestPoint = segmentStart.clone();
        }
        continue;
      }

      const t = Math.max(0, Math.min(1, point.sub(segmentStart).dot(segment) / segmentLength));
      const projection = segmentStart.add(segment.mul(t));
      const dist = point.distanceTo(projection);
      
      if (dist < minDistance) {
        minDistance = dist;
        closestPoint = projection;
      }
    }

    return closestPoint;
  }

  // Swept circle vs line segment collision
  static sweptCircleVsSegment(
    circleStart: Vec2,
    circleEnd: Vec2,
    radius: number,
    segmentStart: Vec2,
    segmentEnd: Vec2
  ): { hit: boolean; time: number; point: Vec2; normal: Vec2 } {
    const result = {
      hit: false,
      time: 1,
      point: Vec2.zero(),
      normal: Vec2.zero()
    };

    const motion = circleEnd.sub(circleStart);
    const segment = segmentEnd.sub(segmentStart);
    const segmentNormal = segment.perp().normalize();
    
    // Check if circle is moving towards the segment
    if (motion.dot(segmentNormal) >= 0) {
      return result;
    }

    // Project circle path onto segment normal
    const startDist = circleStart.sub(segmentStart).dot(segmentNormal);
    const endDist = circleEnd.sub(segmentStart).dot(segmentNormal);
    
    // Check if circle path intersects with expanded segment
    if (Math.abs(startDist) <= radius || Math.abs(endDist) <= radius) {
      // Calculate intersection time
      const t = (Math.abs(startDist) - radius) / Math.abs(motion.dot(segmentNormal));
      
      if (t >= 0 && t <= 1) {
        const intersectionPoint = circleStart.add(motion.mul(t));
        
        // Check if intersection is within segment bounds
        const segmentLength = segment.lengthSq();
        if (segmentLength > 0) {
          const projection = intersectionPoint.sub(segmentStart).dot(segment) / segmentLength;
          
          if (projection >= 0 && projection <= 1) {
            result.hit = true;
            result.time = t;
            result.point = segmentStart.add(segment.mul(projection));
            result.normal = segmentNormal.mul(startDist < 0 ? -1 : 1);
          }
        }
      }
    }

    return result;
  }

  // Slide along polygon edges when colliding
  static slideAlongPolygon(
    position: Vec2,
    velocity: Vec2,
    radius: number,
    polygon: Vec2[],
    dt: number
  ): { newPosition: Vec2; newVelocity: Vec2 } {
    let currentPos = position.clone();
    let currentVel = velocity.clone();
    const targetPos = position.add(velocity.mul(dt));
    
    // Try up to 3 sliding iterations to handle corner cases
    for (let iteration = 0; iteration < 3; iteration++) {
      let bestCollision: any = null;
      let bestTime = 1;

      // Check collision against all edges
      for (let i = 0; i < polygon.length; i++) {
        const j = (i + 1) % polygon.length;
        const collision = PolygonUtils.sweptCircleVsSegment(
          currentPos,
          targetPos,
          radius,
          polygon[i],
          polygon[j]
        );

        if (collision.hit && collision.time < bestTime) {
          bestTime = collision.time;
          bestCollision = collision;
        }
      }

      if (!bestCollision) {
        // No collision, move to target
        currentPos = targetPos;
        break;
      }

      // Move to collision point
      const remainingMotion = targetPos.sub(currentPos);
      currentPos = currentPos.add(remainingMotion.mul(bestCollision.time));
      
      // Slide along the surface
      const remainingVel = remainingMotion.mul(1 - bestCollision.time);
      const slideVel = remainingVel.sub(bestCollision.normal.mul(remainingVel.dot(bestCollision.normal)));
      
      // Update for next iteration
      currentVel = slideVel.div(dt);
      
      if (slideVel.lengthSq() < 0.001) {
        // Velocity too small, stop sliding
        break;
      }
    }

    return {
      newPosition: currentPos,
      newVelocity: currentVel
    };
  }

  /**
   * Calculate the minimum distance from a point to the edge of a polygon
   * Returns positive distance if point is inside, negative if outside
   */
  static distanceToPolygonEdge(point: Vec2, polygon: Vec2[]): number {
    if (polygon.length < 3) return 0;
    
    let minDistance = Infinity;
    let isInside = false;
    
    // Check if point is inside using ray casting
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const pi = polygon[i];
      const pj = polygon[j];
      
      if (((pi.y > point.y) !== (pj.y > point.y)) &&
          (point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x)) {
        isInside = !isInside;
      }
    }
    
    // Find minimum distance to any edge
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      const segmentStart = polygon[i];
      const segmentEnd = polygon[j];
      
      const segment = segmentEnd.sub(segmentStart);
      const segmentLength = segment.lengthSq();
      
      if (segmentLength === 0) {
        const dist = point.distanceTo(segmentStart);
        minDistance = Math.min(minDistance, dist);
        continue;
      }

      const t = Math.max(0, Math.min(1, point.sub(segmentStart).dot(segment) / segmentLength));
      const projection = segmentStart.add(segment.mul(t));
      const dist = point.distanceTo(projection);
      
      minDistance = Math.min(minDistance, dist);
    }
    
    // Return positive if inside, negative if outside
    return isInside ? minDistance : -minDistance;
  }
}
