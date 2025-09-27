/**
 * Client-Side Camera System
 * 
 * Moved from engine/ to client/gfx/ for proper separation of concerns.
 * Handles world-to-screen coordinate transformations and smooth following.
 */

import { Vec2 } from '../../common/Vec2.js';

/**
 * Viewport dimensions
 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * Camera state snapshot
 */
export interface CameraState {
  position: Vec2;
  zoom: number;
  rotation: number;
}

/**
 * Camera world bounds for culling
 */
export interface WorldBounds {
  min: Vec2;
  max: Vec2;
}

/**
 * Camera system for managing view transformations
 */
export class Camera {
  private viewport: Viewport;
  private state: CameraState;
  private targetPosition: Vec2 | null = null;
  
  // Smooth following parameters
  private velocity: Vec2 = Vec2.zero();
  
  constructor(viewport: Viewport, initialState: CameraState) {
    this.viewport = viewport;
    this.state = {
      position: initialState.position.clone(),
      zoom: initialState.zoom,
      rotation: initialState.rotation
    };
  }
  
  /**
   * Get current camera state (immutable)
   */
  getState(): CameraState {
    return {
      position: this.state.position.clone(),
      zoom: this.state.zoom,
      rotation: this.state.rotation
    };
  }
  
  /**
   * Set camera position directly
   */
  setPosition(position: Vec2): void {
    this.state.position = position.clone();
    this.targetPosition = null; // Clear target when setting position directly
  }
  
  /**
   * Set camera zoom level
   */
  setZoom(zoom: number): void {
    this.state.zoom = Math.max(0.1, Math.min(10.0, zoom)); // Clamp to reasonable range
  }
  
  /**
   * Set camera rotation
   */
  setRotation(rotation: number): void {
    this.state.rotation = rotation;
  }
  
  /**
   * Set target position for smooth following
   */
  setTarget(position: Vec2): void {
    this.targetPosition = position.clone();
  }
  
  /**
   * Update camera to follow target with smooth damping
   */
  followTarget(targetPos: Vec2, followSpeed: number, deltaTime: number): void {
    if (!targetPos) return;
    
    // Calculate distance to target
    const toTarget = targetPos.sub(this.state.position);
    
    // If very close, snap to avoid jitter
    if (toTarget.lengthSq() < 0.1) {
      this.state.position = targetPos.clone();
      this.velocity = Vec2.zero();
      return;
    }
    
    // Apply critically damped spring dynamics for smooth following
    const springStrength = followSpeed;
    const damping = 2.0 * Math.sqrt(springStrength); // Critical damping
    
    // Calculate acceleration toward target
    const acceleration = toTarget.mul(springStrength).sub(this.velocity.mul(damping));
    
    // Update velocity and position
    this.velocity = this.velocity.add(acceleration.mul(deltaTime));
    this.state.position = this.state.position.add(this.velocity.mul(deltaTime));
  }
  
  /**
   * Zoom by factor around a screen point
   */
  zoomBy(factor: number, screenPoint: Vec2): void {
    // Convert screen point to world coordinates before zoom
    const worldPoint = this.screenToWorld(screenPoint);
    
    // Apply zoom
    const newZoom = this.state.zoom * factor;
    this.setZoom(newZoom);
    
    // Convert world point back to screen coordinates after zoom
    const newScreenPoint = this.worldToScreen(worldPoint);
    
    // Adjust camera position to keep world point under cursor
    const screenDelta = screenPoint.sub(newScreenPoint);
    const worldDelta = this.screenToWorldDelta(screenDelta);
    this.state.position = this.state.position.sub(worldDelta);
  }
  
  /**
   * Convert world coordinates to screen coordinates
   */
  worldToScreen(worldPos: Vec2): Vec2 {
    // Translate to camera space
    const translated = worldPos.sub(this.state.position);
    
    // Apply zoom
    const scaled = translated.mul(this.state.zoom);
    
    // Apply rotation
    const cos = Math.cos(-this.state.rotation);
    const sin = Math.sin(-this.state.rotation);
    const rotated = Vec2.from(
      scaled.x * cos - scaled.y * sin,
      scaled.x * sin + scaled.y * cos
    );
    
    // Translate to screen center
    return rotated.add(Vec2.from(this.viewport.width / 2, this.viewport.height / 2));
  }
  
  /**
   * Convert screen coordinates to world coordinates
   */
  screenToWorld(screenPos: Vec2): Vec2 {
    // Translate from screen center
    const centered = screenPos.sub(Vec2.from(this.viewport.width / 2, this.viewport.height / 2));
    
    // Apply inverse rotation
    const cos = Math.cos(this.state.rotation);
    const sin = Math.sin(this.state.rotation);
    const rotated = Vec2.from(
      centered.x * cos - centered.y * sin,
      centered.x * sin + centered.y * cos
    );
    
    // Apply inverse zoom
    const scaled = rotated.mul(1 / this.state.zoom);
    
    // Translate from camera space
    return scaled.add(this.state.position);
  }
  
  /**
   * Convert screen delta to world delta (useful for drag operations)
   */
  screenToWorldDelta(screenDelta: Vec2): Vec2 {
    // Apply inverse rotation
    const cos = Math.cos(this.state.rotation);
    const sin = Math.sin(this.state.rotation);
    const rotated = Vec2.from(
      screenDelta.x * cos - screenDelta.y * sin,
      screenDelta.x * sin + screenDelta.y * cos
    );
    
    // Apply inverse zoom
    return rotated.mul(1 / this.state.zoom);
  }
  
  /**
   * Get visible world bounds for culling
   */
  getWorldBounds(): WorldBounds {
    // Calculate world bounds from screen corners
    const topLeft = this.screenToWorld(Vec2.zero());
    const topRight = this.screenToWorld(Vec2.from(this.viewport.width, 0));
    const bottomLeft = this.screenToWorld(Vec2.from(0, this.viewport.height));
    const bottomRight = this.screenToWorld(Vec2.from(this.viewport.width, this.viewport.height));
    
    // Find min/max bounds
    const allPoints = [topLeft, topRight, bottomLeft, bottomRight];
    let minX = allPoints[0].x, minY = allPoints[0].y;
    let maxX = allPoints[0].x, maxY = allPoints[0].y;
    
    for (const point of allPoints) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    
    return {
      min: Vec2.from(minX, minY),
      max: Vec2.from(maxX, maxY)
    };
  }
  
  /**
   * Check if a world position is visible
   */
  isWorldPositionVisible(worldPos: Vec2, margin: number = 0): boolean {
    const bounds = this.getWorldBounds();
    return worldPos.x >= bounds.min.x - margin &&
           worldPos.x <= bounds.max.x + margin &&
           worldPos.y >= bounds.min.y - margin &&
           worldPos.y <= bounds.max.y + margin;
  }
  
  /**
   * Update viewport dimensions
   */
  setViewport(viewport: Viewport): void {
    this.viewport = { ...viewport };
  }
  
  /**
   * Get viewport dimensions
   */
  getViewport(): Viewport {
    return { ...this.viewport };
  }
}