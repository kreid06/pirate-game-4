/**
 * Deterministic angle utilities
 */
export class AngleUtils {
  // Wrap angle to [-π, π]
  static wrap(angle: number): number {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
  }

  // Angle difference (shortest path)
  static diff(a: number, b: number): number {
    return AngleUtils.wrap(a - b);
  }

  // Linear interpolation of angles
  static lerp(a: number, b: number, t: number): number {
    const diff = AngleUtils.diff(b, a);
    return AngleUtils.wrap(a + diff * t);
  }

  // Convert degrees to radians
  static toRadians(degrees: number): number {
    return degrees * Math.PI / 180;
  }

  // Convert radians to degrees
  static toDegrees(radians: number): number {
    return radians * 180 / Math.PI;
  }
}
