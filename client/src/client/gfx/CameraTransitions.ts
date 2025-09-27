/**
 * CameraTransitions.ts - Smooth camera transitions for client-side camera
 * 
 * Extracted from legacy engine/CameraEvents.ts - provides smooth transitions
 * when camera needs to change targets or positions.
 */

import { Vec2 } from '../../common/Vec2.js';
import { Camera } from './Camera.js';

/**
 * Camera transition configuration
 */
export interface CameraTransitionConfig {
  // Transition timing
  defaultTransitionDuration: number;
  
  // Smoothing parameters
  transitionEasing: 'linear' | 'ease-out' | 'ease-in-out';
}

/**
 * Default camera transition configuration
 */
export const DEFAULT_CAMERA_TRANSITION_CONFIG: CameraTransitionConfig = {
  defaultTransitionDuration: 0.5,      // 500ms transition
  transitionEasing: 'ease-out',
};

/**
 * Camera transition state for tracking transitions
 */
interface CameraTransitionState {
  isTransitioning: boolean;
  startTime: number;
  duration: number;
  startPosition: Vec2;
  endPosition: Vec2;
  easing: 'linear' | 'ease-out' | 'ease-in-out';
}

/**
 * Camera transition system for smooth position changes
 */
export class CameraTransitions {
  private camera: Camera;
  private config: CameraTransitionConfig;
  private transitionState: CameraTransitionState | null = null;

  constructor(camera: Camera, config: CameraTransitionConfig = DEFAULT_CAMERA_TRANSITION_CONFIG) {
    this.camera = camera;
    this.config = config;
  }

  /**
   * Start a smooth transition to a new position
   */
  transitionTo(targetPosition: Vec2, duration?: number): void {
    const currentState = this.camera.getState();
    
    this.transitionState = {
      isTransitioning: true,
      startTime: performance.now(),
      duration: duration ?? this.config.defaultTransitionDuration,
      startPosition: currentState.position.clone(),
      endPosition: targetPosition.clone(),
      easing: this.config.transitionEasing
    };
  }

  /**
   * Update transition state and camera position
   */
  update(currentTime: number): void {
    if (!this.transitionState) return;

    const elapsed = (currentTime - this.transitionState.startTime) / 1000;
    const progress = Math.min(elapsed / this.transitionState.duration, 1.0);

    if (progress >= 1.0) {
      // Transition complete
      this.camera.setPosition(this.transitionState.endPosition);
      this.transitionState = null;
      return;
    }

    // Apply easing
    const easedProgress = this.applyEasing(progress, this.transitionState.easing);
    
    // Interpolate position
    const newPosition = this.transitionState.startPosition.lerp(
      this.transitionState.endPosition,
      easedProgress
    );
    
    this.camera.setPosition(newPosition);
  }

  /**
   * Check if a transition is currently active
   */
  isTransitioning(): boolean {
    return this.transitionState !== null;
  }

  /**
   * Cancel any active transition
   */
  cancelTransition(): void {
    this.transitionState = null;
  }

  /**
   * Apply easing function to progress value
   */
  private applyEasing(t: number, easing: 'linear' | 'ease-out' | 'ease-in-out'): number {
    switch (easing) {
      case 'linear':
        return t;
      case 'ease-out':
        return 1 - Math.pow(1 - t, 3);
      case 'ease-in-out':
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      default:
        return t;
    }
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<CameraTransitionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): CameraTransitionConfig {
    return { ...this.config };
  }
}