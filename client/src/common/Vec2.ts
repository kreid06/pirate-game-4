/**
 * Deterministic 2D Vector class for physics calculations
 */
export class Vec2 {
  constructor(public x: number = 0, public y: number = 0) {}

  static zero(): Vec2 {
    return new Vec2(0, 0);
  }

  static from(x: number, y: number): Vec2 {
    return new Vec2(x, y);
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  add(other: Vec2): Vec2 {
    return new Vec2(this.x + other.x, this.y + other.y);
  }

  sub(other: Vec2): Vec2 {
    return new Vec2(this.x - other.x, this.y - other.y);
  }

  mul(scalar: number): Vec2 {
    return new Vec2(this.x * scalar, this.y * scalar);
  }

  div(scalar: number): Vec2 {
    return new Vec2(this.x / scalar, this.y / scalar);
  }

  dot(other: Vec2): number {
    return this.x * other.x + this.y * other.y;
  }

  cross(other: Vec2): number {
    return this.x * other.y - this.y * other.x;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  normalize(): Vec2 {
    const len = this.length();
    if (len === 0) return Vec2.zero();
    return this.div(len);
  }

  // Perpendicular vector for 2D rotation
  perp(): Vec2 {
    return new Vec2(-this.y, this.x);
  }

  // Rotate by angle (radians)
  rotate(angle: number): Vec2 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vec2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos
    );
  }

  // Distance to another point
  distanceTo(other: Vec2): number {
    return this.sub(other).length();
  }

  // Linear interpolation
  lerp(other: Vec2, t: number): Vec2 {
    return this.add(other.sub(this).mul(t));
  }

  equals(other: Vec2, epsilon: number = 1e-6): boolean {
    return Math.abs(this.x - other.x) < epsilon && Math.abs(this.y - other.y) < epsilon;
  }

  toString(): string {
    return `Vec2(${this.x.toFixed(3)}, ${this.y.toFixed(3)})`;
  }
}
