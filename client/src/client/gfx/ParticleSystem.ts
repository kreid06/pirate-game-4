/**
 * Particle System for Visual Effects
 * 
 * Handles water splashes, smoke trails, explosions, and other particle effects.
 */

import { Camera } from './Camera.js';
import { Vec2 } from '../../common/Vec2.js';

/**
 * Individual particle data
 */
interface Particle {
  position: Vec2;
  velocity: Vec2;
  life: number;        // Current life (seconds)
  maxLife: number;     // Maximum life (seconds)
  size: number;
  color: string;
  alpha: number;
  gravity: number;     // Gravity affect factor
}

/**
 * Particle effect types
 */
export enum ParticleEffectType {
  WATER_SPLASH = 'water_splash',
  CANNONBALL_SMOKE = 'cannonball_smoke',
  EXPLOSION = 'explosion',
  WATER_FOAM = 'water_foam'
}

/**
 * Particle effect configuration
 */
interface ParticleEffect {
  position: Vec2;
  type: ParticleEffectType;
  intensity: number;
  particles: Particle[];
}

/**
 * Particle quality settings
 */
type ParticleQuality = 'low' | 'medium' | 'high';

/**
 * Main particle system
 */
export class ParticleSystem {
  private ctx: CanvasRenderingContext2D;
  private effects: ParticleEffect[] = [];
  private quality: ParticleQuality = 'medium';
  
  // Quality multipliers for particle counts
  private readonly qualityMultipliers = {
    low: 0.5,
    medium: 1.0,
    high: 2.0
  };
  
  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }
  
  /**
   * Initialize particle system
   */
  async initialize(): Promise<void> {
    console.log('✨ Particle system initialized');
  }
  
  /**
   * Update all particle effects
   */
  update(deltaTime: number): void {
    const dt = deltaTime / 1000; // Convert to seconds
    
    // Update all effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      this.updateEffect(effect, dt);
      
      // Remove effects with no particles
      if (effect.particles.length === 0) {
        this.effects.splice(i, 1);
      }
    }
  }
  
  /**
   * Render all particle effects
   */
  render(camera: Camera): void {
    this.ctx.save();
    
    for (const effect of this.effects) {
      this.renderEffect(effect, camera);
    }
    
    this.ctx.restore();
  }
  
  /**
   * Create a water splash effect
   */
  createWaterSplash(position: Vec2, intensity: number = 1.0): void {
    const particleCount = Math.floor(20 * intensity * this.qualityMultipliers[this.quality]);
    const particles: Particle[] = [];
    
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2;
      const speed = 80 + Math.random() * 120;
      const lifetime = 1.5 + Math.random() * 1.0;
      
      particles.push({
        position: position.clone(),
        velocity: Vec2.from(
          Math.cos(angle) * speed,
          Math.sin(angle) * speed
        ),
        life: 0,
        maxLife: lifetime,
        size: 2 + Math.random() * 3,
        color: '#87ceeb', // Sky blue for water
        alpha: 0.8,
        gravity: 50 // Water falls down
      });
    }
    
    this.effects.push({
      position: position.clone(),
      type: ParticleEffectType.WATER_SPLASH,
      intensity,
      particles
    });
  }
  
  /**
   * Create cannonball smoke trail
   */
  createSmokeTrail(position: Vec2): void {
    if (Math.random() > 0.3) return; // Only 30% chance per frame
    
    const particles: Particle[] = [];
    const particleCount = Math.floor(2 * this.qualityMultipliers[this.quality]);
    
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 10 + Math.random() * 20;
      const lifetime = 2.0 + Math.random() * 1.0;
      
      particles.push({
        position: position.add(Vec2.from(
          (Math.random() - 0.5) * 5,
          (Math.random() - 0.5) * 5
        )),
        velocity: Vec2.from(
          Math.cos(angle) * speed,
          Math.sin(angle) * speed
        ),
        life: 0,
        maxLife: lifetime,
        size: 3 + Math.random() * 4,
        color: '#555555', // Gray smoke
        alpha: 0.6,
        gravity: -10 // Smoke rises
      });
    }
    
    this.effects.push({
      position: position.clone(),
      type: ParticleEffectType.CANNONBALL_SMOKE,
      intensity: 1.0,
      particles
    });
  }
  
  /**
   * Create explosion effect
   */
  createExplosion(position: Vec2, intensity: number = 1.0): void {
    const particleCount = Math.floor(30 * intensity * this.qualityMultipliers[this.quality]);
    const particles: Particle[] = [];
    
    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 200;
      const lifetime = 0.5 + Math.random() * 1.0;
      
      particles.push({
        position: position.clone(),
        velocity: Vec2.from(
          Math.cos(angle) * speed,
          Math.sin(angle) * speed
        ),
        life: 0,
        maxLife: lifetime,
        size: 3 + Math.random() * 5,
        color: Math.random() > 0.5 ? '#ff6600' : '#ffaa00', // Orange/yellow explosion
        alpha: 1.0,
        gravity: 0 // Explosion particles don't fall initially
      });
    }
    
    this.effects.push({
      position: position.clone(),
      type: ParticleEffectType.EXPLOSION,
      intensity,
      particles
    });
  }
  
  /**
   * Update particle quality
   */
  updateQuality(quality: ParticleQuality): void {
    this.quality = quality;
    console.log(`✨ Particle quality set to: ${quality}`);
  }
  
  /**
   * Shutdown particle system
   */
  shutdown(): void {
    this.effects = [];
    console.log('✨ Particle system shutdown');
  }
  
  // Private methods
  
  private updateEffect(effect: ParticleEffect, deltaTime: number): void {
    // Update all particles in the effect
    for (let i = effect.particles.length - 1; i >= 0; i--) {
      const particle = effect.particles[i];
      
      // Update particle life
      particle.life += deltaTime;
      
      // Remove expired particles
      if (particle.life >= particle.maxLife) {
        effect.particles.splice(i, 1);
        continue;
      }
      
      // Update particle physics
      this.updateParticle(particle, deltaTime);
    }
  }
  
  private updateParticle(particle: Particle, deltaTime: number): void {
    // Apply velocity
    particle.position = particle.position.add(particle.velocity.mul(deltaTime));
    
    // Apply gravity
    particle.velocity = particle.velocity.add(Vec2.from(0, particle.gravity).mul(deltaTime));
    
    // Update alpha based on life (fade out over time)
    const lifeRatio = particle.life / particle.maxLife;
    particle.alpha = 1.0 - lifeRatio;
    
    // Update size for some effect types (shrink over time)
    if (lifeRatio > 0.5) {
      particle.size *= 0.95; // Gradually shrink
    }
  }
  
  private renderEffect(effect: ParticleEffect, camera: Camera): void {
    for (const particle of effect.particles) {
      // Skip particles that are too faded or too small
      if (particle.alpha <= 0.1 || particle.size <= 0.5) continue;
      
      // Check if particle is visible
      if (!camera.isWorldPositionVisible(particle.position, 50)) continue;
      
      // Convert to screen coordinates
      const screenPos = camera.worldToScreen(particle.position);
      const cameraState = camera.getState();
      const scaledSize = particle.size * cameraState.zoom;
      
      // Skip particles that are too small to see
      if (scaledSize < 1) continue;
      
      // Set particle style
      this.ctx.globalAlpha = particle.alpha;
      this.ctx.fillStyle = particle.color;
      
      // Draw particle
      this.ctx.beginPath();
      this.ctx.arc(screenPos.x, screenPos.y, scaledSize, 0, Math.PI * 2);
      this.ctx.fill();
    }
    
    // Reset global alpha
    this.ctx.globalAlpha = 1.0;
  }
}