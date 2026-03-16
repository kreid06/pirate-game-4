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
  WATER_FOAM = 'water_foam',
  SAIL_FIBER = 'sail_fiber',
  SINK_SPLASH = 'sink_splash',
  FLAME_TRAIL = 'flame_trail',
  FLAME_CONE_EMBERS = 'flame_cone_embers',
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
    const dt = deltaTime; // deltaTime is already in seconds
    
    // Update all effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      this.updateEffect(effect, dt);
      
      // Remove effects with no particles (swap-and-pop)
      if (effect.particles.length === 0) {
        this.effects[i] = this.effects[this.effects.length - 1];
        this.effects.pop();
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
   * Create a sinking-ship splash burst.
   * Called continuously while a ship sinks — emits a small geyser of water
   * droplets and foam at the given world position.
   * @param position  World-space origin of the burst (a point on the hull edge).
   * @param intensity 0–1 scale: 1 = mid-sink, higher = near fully submerged.
   */
  createSinkSplash(position: Vec2, intensity: number = 1.0): void {
    const count = Math.max(2, Math.floor(6 * intensity * this.qualityMultipliers[this.quality]));
    const particles: Particle[] = [];

    // Colour palette — white foam + blue water + translucent bubbles
    const waterColors = ['#ffffff', '#e8f4f8', '#c8e8f8', '#87ceeb', '#b0d8f0'];

    for (let i = 0; i < count; i++) {
      // Upward cone with horizontal scatter
      const spreadAngle = (Math.random() - 0.5) * Math.PI * 0.9; // ±80° from straight up
      const speed = 60 + Math.random() * 100 * intensity;
      const angle  = -Math.PI * 0.5 + spreadAngle; // mostly upward

      particles.push({
        position: position.add(Vec2.from(
          (Math.random() - 0.5) * 30,
          (Math.random() - 0.5) * 15,
        )),
        velocity: Vec2.from(Math.cos(angle) * speed, Math.sin(angle) * speed),
        life: 0,
        maxLife: 0.6 + Math.random() * 0.9,
        size: 2 + Math.random() * 4 * intensity,
        color: waterColors[Math.floor(Math.random() * waterColors.length)],
        alpha: 0.7 + Math.random() * 0.3,
        gravity: 160, // droplets arc up then fall quickly
      });
    }

    this.effects.push({
      position: position.clone(),
      type: ParticleEffectType.SINK_SPLASH,
      intensity,
      particles,
    });
  }

  /**
   * Create sail fiber damage effect — torn cloth shreds flying from a mast hit
   */
  createSailFiberEffect(position: Vec2, intensity: number = 1.0): void {
    const particleCount = Math.floor(12 * intensity * this.qualityMultipliers[this.quality]);
    const particles: Particle[] = [];

    // Palette: cream, off-white, and worn tan — typical canvas sail colours
    const clothColors = ['#F5F5DC', '#FAF0E6', '#FFFACD', '#EEE8AA', '#D2B48C'];

    for (let i = 0; i < particleCount; i++) {
      // Scatter in a cone roughly "upward" (sail hangs above deck), with some spread
      const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 1.4;
      const speed = 60 + Math.random() * 140;
      const lifetime = 1.0 + Math.random() * 1.2;

      particles.push({
        position: position.add(Vec2.from(
          (Math.random() - 0.5) * 20,
          (Math.random() - 0.5) * 20
        )),
        velocity: Vec2.from(Math.cos(angle) * speed, Math.sin(angle) * speed),
        life: 0,
        maxLife: lifetime,
        size: 2 + Math.random() * 5,
        color: clothColors[Math.floor(Math.random() * clothColors.length)],
        alpha: 0.9,
        gravity: 120  // Cloth strips fall faster than smoke
      });
    }

    this.effects.push({
      position: position.clone(),
      type: ParticleEffectType.SAIL_FIBER,
      intensity,
      particles
    });
  }

  /**
   * Scatter embers + smoke through the entire live flame-cone volume.
   * Called every frame from RenderSystem.drawFlameCones.
   * @param origin     World-space swivel-gun muzzle position.
   * @param angle      Centre-line angle of the cone (radians).
   * @param halfCone   Half-angle of the cone (radians).
   * @param innerDist  World-space inner radius (retreat edge).
   * @param outerDist  World-space outer radius (wave-front edge).
   */
  createFlameConeParticles(
    origin: Vec2,
    angle: number,
    halfCone: number,
    innerDist: number,
    outerDist: number,
  ): void {
    if (Math.random() > 0.75) return; // ~75% spawn chance keeps it light

    const span = outerDist - innerDist;
    if (span <= 0) return;

    const quality = this.qualityMultipliers[this.quality];
    const emberCount  = Math.max(2, Math.floor(6  * quality));
    const smokeCount  = Math.max(1, Math.floor(3  * quality));
    const sparkCount  = Math.max(1, Math.floor(2  * quality));

    const emberColors = ['#FFFF99', '#FFE066', '#FFC800', '#FF8C00', '#FF5500', '#FF3300'];
    const smokeColors = ['rgba(60,20,0,0.55)', 'rgba(80,40,0,0.45)', 'rgba(40,40,40,0.35)'];

    const particles: Particle[] = [];

    // ── Embers scattered across the cone ──────────────────────────────────
    for (let i = 0; i < emberCount; i++) {
      const a = angle + (Math.random() * 2 - 1) * halfCone;
      const r = innerDist + Math.random() * span;
      const frac = (r - innerDist) / span; // 0 = near origin, 1 = leading edge

      // Hotter (brighter yellows) near the tip, cooler (reds) near origin
      const colorIdx = Math.floor((1 - frac) * (emberColors.length - 1));
      const color = emberColors[Math.min(colorIdx, emberColors.length - 1)];

      // Velocity: slightly forward in cone direction + upward drift + random spread
      const forwardSpeed = 20 + frac * 60 + Math.random() * 30;
      const spread = (Math.random() - 0.5) * halfCone * 0.8;
      const velAngle = angle + spread;

      particles.push({
        position: origin.add(Vec2.from(
          Math.cos(a) * r + (Math.random() - 0.5) * 4,
          Math.sin(a) * r + (Math.random() - 0.5) * 4,
        )),
        velocity: Vec2.from(
          Math.cos(velAngle) * forwardSpeed,
          Math.sin(velAngle) * forwardSpeed - 15 - Math.random() * 20,
        ),
        life:    0,
        maxLife: 0.18 + frac * 0.30 + Math.random() * 0.25,
        size:    0.8 + frac * 1.6 + Math.random() * 1.4,
        color,
        alpha:   0.80 + Math.random() * 0.20,
        gravity: -30 - Math.random() * 20, // embers rise
      });
    }

    // ── Sparks — tiny bright white/yellow flecks that shoot outward ───────
    for (let i = 0; i < sparkCount; i++) {
      const a = angle + (Math.random() * 2 - 1) * halfCone * 0.9;
      const r = innerDist + Math.random() * span;
      const sparkSpeed = 60 + Math.random() * 90;
      particles.push({
        position: origin.add(Vec2.from(
          Math.cos(a) * r,
          Math.sin(a) * r,
        )),
        velocity: Vec2.from(
          Math.cos(a) * sparkSpeed + (Math.random() - 0.5) * 20,
          Math.sin(a) * sparkSpeed + (Math.random() - 0.5) * 20 - 25,
        ),
        life:    0,
        maxLife: 0.10 + Math.random() * 0.18,
        size:    0.5 + Math.random() * 1.0,
        color:   Math.random() > 0.5 ? '#FFFFFF' : '#FFFACD',
        alpha:   1.0,
        gravity: -15,
      });
    }

    // ── Smoke wisps — billow upward and backward, thicker mid-range ───────
    for (let i = 0; i < smokeCount; i++) {
      const a = angle + (Math.random() * 2 - 1) * halfCone * 0.85;
      const r = innerDist + 0.25 * span + Math.random() * 0.65 * span;
      const color = smokeColors[Math.floor(Math.random() * smokeColors.length)];
      const rearAngle = angle + Math.PI + (Math.random() - 0.5) * halfCone;
      const smokeSpeed = 18 + Math.random() * 28;
      particles.push({
        position: origin.add(Vec2.from(
          Math.cos(a) * r + (Math.random() - 0.5) * 8,
          Math.sin(a) * r + (Math.random() - 0.5) * 8,
        )),
        velocity: Vec2.from(
          Math.cos(rearAngle) * smokeSpeed,
          Math.sin(rearAngle) * smokeSpeed - 12 - Math.random() * 18,
        ),
        life:    0,
        maxLife: 0.55 + Math.random() * 0.65,
        size:    4 + Math.random() * 7,
        color,
        alpha:   0.35 + Math.random() * 0.25,
        gravity: -18, // smoke drifts upward
      });
    }

    this.effects.push({
      position: origin.clone(),
      type:     ParticleEffectType.FLAME_CONE_EMBERS,
      intensity: 1.0,
      particles,
    });
  }

  /**
   * Create a flame/ember trail behind a flamethrower projectile.
   * @param position  World-space centre of the projectile.
   * @param direction Travel angle in radians (Math.atan2 of velocity).
   */
  createFlameTrail(position: Vec2, direction: number): void {
    if (Math.random() > 0.55) return; // ~45% spawn chance each frame keeps it light

    const count = Math.max(1, Math.floor(3 * this.qualityMultipliers[this.quality]));
    const particles: Particle[] = [];
    const fireColors = ['#FFFF99', '#FFC800', '#FF8C00', '#FF4500', '#CC2200'];

    // Spawn slightly behind the projectile (opposite direction)
    const backX = -Math.cos(direction);
    const backY = -Math.sin(direction);

    for (let i = 0; i < count; i++) {
      const spread     = (Math.random() - 0.5) * Math.PI * 0.45; // ±40° cone
      const spawnAngle = direction + Math.PI + spread;            // backward + spread
      const offsetDist = 2 + Math.random() * 7;

      particles.push({
        position: position.add(Vec2.from(
          backX * offsetDist + (Math.random() - 0.5) * 5,
          backY * offsetDist + (Math.random() - 0.5) * 5
        )),
        velocity: Vec2.from(
          Math.cos(spawnAngle) * (15 + Math.random() * 35),
          Math.sin(spawnAngle) * (15 + Math.random() * 35)
        ),
        life:    0,
        maxLife: 0.25 + Math.random() * 0.45,
        size:    1.2 + Math.random() * 2.8,
        color:   fireColors[Math.floor(Math.random() * fireColors.length)],
        alpha:   0.75 + Math.random() * 0.25,
        gravity: -25, // embers drift slightly upward
      });
    }

    this.effects.push({
      position: position.clone(),
      type:     ParticleEffectType.FLAME_TRAIL,
      intensity: 1.0,
      particles,
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
      
      // Remove expired particles (swap-and-pop to avoid O(N) array shift)
      if (particle.life >= particle.maxLife) {
        effect.particles[i] = effect.particles[effect.particles.length - 1];
        effect.particles.pop();
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