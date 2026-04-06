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
   * Create a dramatic water splash for cannonball impact / expiry over water.
   * Three passes: central geyser column, radial base ring, foam mist.
   */
  createWaterSplash(position: Vec2, intensity: number = 1.0): void {
    const q = this.qualityMultipliers[this.quality];
    const particles: Particle[] = [];

    const waterColors  = ['#ffffff', '#daf0ff', '#a8d8f0', '#87ceeb', '#c8e8ff'];
    const foamColors   = ['#ffffff', '#f0f8ff', '#e0f0ff'];

    // ── Pass 1: Central geyser — tall upward column ──────────────────────────
    const geyserCount = Math.floor(28 * intensity * q);
    for (let i = 0; i < geyserCount; i++) {
      const spread = (Math.random() - 0.5) * 0.45; // ±13° from straight up
      const angle  = -Math.PI / 2 + spread;
      const speed  = 220 + Math.random() * 280;     // fast enough to arc high
      particles.push({
        position: position.add(Vec2.from((Math.random() - 0.5) * 12, 0)),
        velocity: Vec2.from(Math.cos(angle) * speed, Math.sin(angle) * speed),
        life: 0,
        maxLife: 0.9 + Math.random() * 0.8,
        size: 4 + Math.random() * 7,
        color: waterColors[Math.floor(Math.random() * waterColors.length)],
        alpha: 0.85 + Math.random() * 0.15,
        gravity: 320,
      });
    }

    // ── Pass 2: Radial base ring — fans out to all sides ─────────────────────
    const ringCount = Math.floor(36 * intensity * q);
    for (let i = 0; i < ringCount; i++) {
      const angle = (i / ringCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      // Bias toward horizontal: [-60°, +60°] from the ring plane (y = 0)
      const vertBias = (Math.random() - 0.5) * Math.PI * 0.4;
      const finalAngle = angle + vertBias * 0.3;
      const speed = 150 + Math.random() * 200;
      particles.push({
        position: position.add(Vec2.from(
          (Math.random() - 0.5) * 20,
          (Math.random() - 0.5) * 10,
        )),
        velocity: Vec2.from(Math.cos(finalAngle) * speed, Math.sin(finalAngle) * speed - 60),
        life: 0,
        maxLife: 0.7 + Math.random() * 0.7,
        size: 3 + Math.random() * 6,
        color: waterColors[Math.floor(Math.random() * waterColors.length)],
        alpha: 0.7 + Math.random() * 0.25,
        gravity: 280,
      });
    }

    // ── Pass 3: Foam mist — small slow particles that linger ─────────────────
    const mistCount = Math.floor(20 * intensity * q);
    for (let i = 0; i < mistCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 90;
      particles.push({
        position: position.add(Vec2.from(
          (Math.random() - 0.5) * 40,
          (Math.random() - 0.5) * 20,
        )),
        velocity: Vec2.from(Math.cos(angle) * speed, Math.sin(angle) * speed - 30),
        life: 0,
        maxLife: 1.4 + Math.random() * 1.0,
        size: 6 + Math.random() * 10,
        color: foamColors[Math.floor(Math.random() * foamColors.length)],
        alpha: 0.35 + Math.random() * 0.3,
        gravity: 60,
      });
    }

    this.effects.push({
      position: position.clone(),
      type: ParticleEffectType.WATER_SPLASH,
      intensity,
      particles,
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
   * Scatter fire blobs through the live flame-cone volume.
   * Called every frame from RenderSystem.drawFlameCones.
   *
   * Color is fixed at birth (reference style): r=255, g=100-190, b=10-30.
   * Rendered as per-particle radial gradients with additive compositing.
   * Velocity combines forward cone direction, cross-cone spread, and world-space upward rise.
   */
  createFlameConeParticles(
    origin: Vec2,
    angle: number,
    halfCone: number,
    innerDist: number,
    outerDist: number,
  ): void {
    if (Math.random() > 0.25) return; // spawn only ~25% of frames to prevent overdraw
    const span = outerDist - innerDist;
    if (span <= 0) return;

    const quality   = this.qualityMultipliers[this.quality];
    const count     = Math.max(1, Math.floor(3 * quality));  // reduced from 6
    const sideCount = Math.max(1, Math.floor(1 * quality));  // reduced from 3
    const particles: Particle[] = [];

    // ── Main forward embers ─────────────────────────────────────────────────
    for (let i = 0; i < count; i++) {
      const a    = angle + (Math.random() * 2 - 1) * halfCone;
      const dist = innerDist + Math.random() * span;
      const frac = dist / Math.max(1, outerDist);

      const r = Math.round(220 + Math.random() * 35); // 220–255
      const g = Math.round(80  + Math.random() * 120); // 80–200 vivid orange-yellow
      const b = Math.round(0   + Math.random() * 15);  // 0–15

      const fwdSpeed   = 20 + frac * 45 + Math.random() * 25;
      const crossSpeed = (Math.random() - 0.5) * 30;
      const riseSpeed  = 20 + Math.random() * 35;
      const velX = Math.cos(angle) * fwdSpeed + (-Math.sin(angle)) * crossSpeed;
      const velY = Math.sin(angle) * fwdSpeed + Math.cos(angle) * crossSpeed - riseSpeed;

      particles.push({
        position: origin.add(Vec2.from(
          Math.cos(a) * dist + (Math.random() - 0.5) * 8,
          Math.sin(a) * dist + (Math.random() - 0.5) * 8,
        )),
        velocity: Vec2.from(velX, velY),
        life:    0,
        maxLife: 0.5 + Math.random() * 0.9,
        size:    30 + frac * 30 + Math.random() * 20,
        color:   `${r},${g},${b}`,
        alpha:   1.0,
        gravity: -25,
      });
    }

    // ── Side-scatter embers — spawn near the cone edges, fly sideways ───────
    // perpX/perpY = unit vector perpendicular to the cone axis
    const perpX = -Math.sin(angle);
    const perpY =  Math.cos(angle);
    for (let i = 0; i < sideCount; i++) {
      // Place along the cone edge: pick a random depth then offset to one edge
      const dist = innerDist + Math.random() * span;
      const frac = dist / Math.max(1, outerDist);
      const side = Math.random() < 0.5 ? -1 : 1; // left or right edge

      // Spawn position: at the cone edge (halfCone) ± small jitter
      const edgeAngle = angle + side * halfCone * (0.75 + Math.random() * 0.25);
      const spawnX = origin.x + Math.cos(edgeAngle) * dist + (Math.random() - 0.5) * 6;
      const spawnY = origin.y + Math.sin(edgeAngle) * dist + (Math.random() - 0.5) * 6;

      // Velocity: mostly sideways away from the cone + slower forward bleed + upward
      const lateralSpeed = 25 + Math.random() * 45;
      const forwardBleed = 8  + Math.random() * 18;
      const riseSpeed    = 15 + Math.random() * 30;
      const velX = Math.cos(angle) * forwardBleed + perpX * side * lateralSpeed;
      const velY = Math.sin(angle) * forwardBleed + perpY * side * lateralSpeed - riseSpeed;

      // Cooler colors — side embers have had more time to cool
      const r = Math.round(200 + Math.random() * 55); // 200–255
      const g = Math.round(40  + Math.random() * 80);  // 40–120 warm orange
      const b = 0;

      particles.push({
        position: Vec2.from(spawnX, spawnY),
        velocity: Vec2.from(velX, velY),
        life:    0,
        maxLife: 0.25 + Math.random() * 0.50, // shorter — they escape the flame
        size:    12 + frac * 14 + Math.random() * 10,
        color:   `${r},${g},${b}`,
        alpha:   1.0,
        gravity: -20,
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
   * Create a flame trail behind a flamethrower projectile.
   * Uses the same reference-style radial-gradient approach as the cone.
   */
  createFlameTrail(position: Vec2, direction: number): void {
    if (Math.random() > 0.60) return;

    const count = Math.max(1, Math.floor(3 * this.qualityMultipliers[this.quality]));
    const particles: Particle[] = [];
    const backX = -Math.cos(direction);
    const backY = -Math.sin(direction);

    for (let i = 0; i < count; i++) {
      const spread     = (Math.random() - 0.5) * Math.PI * 0.5;
      const spawnAngle = direction + Math.PI + spread;
      const offsetDist = 2 + Math.random() * 8;
      const r = Math.round(220 + Math.random() * 35);
      const g = Math.round(80  + Math.random() * 120);
      const b = Math.round(0   + Math.random() * 15);
      particles.push({
        position: position.add(Vec2.from(
          backX * offsetDist + (Math.random() - 0.5) * 6,
          backY * offsetDist + (Math.random() - 0.5) * 6,
        )),
        velocity: Vec2.from(
          Math.cos(spawnAngle) * (12 + Math.random() * 28),
          Math.sin(spawnAngle) * (12 + Math.random() * 28) - 20,
        ),
        life:    0,
        maxLife: 0.30 + Math.random() * 0.50,
        size:    20 + Math.random() * 22,
        color:   `${r},${g},${b}`,
        alpha:   1.0,
        gravity: -25,
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
    const isFire = effect.type === ParticleEffectType.FLAME_CONE_EMBERS
                || effect.type === ParticleEffectType.FLAME_TRAIL;

    for (let i = effect.particles.length - 1; i >= 0; i--) {
      const particle = effect.particles[i];
      particle.life += deltaTime;

      if (particle.life >= particle.maxLife) {
        effect.particles[i] = effect.particles[effect.particles.length - 1];
        effect.particles.pop();
        continue;
      }

      if (isFire) {
        // Reference-style update: flicker + simple physics (no size/alpha override)
        particle.velocity = particle.velocity.add(Vec2.from(
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 6,
        ));
        particle.position = particle.position.add(particle.velocity.mul(deltaTime));
        particle.velocity = particle.velocity.add(Vec2.from(0, particle.gravity).mul(deltaTime));
      } else {
        this.updateParticle(particle, deltaTime);
      }
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
    if (effect.type === ParticleEffectType.FLAME_CONE_EMBERS
     || effect.type === ParticleEffectType.FLAME_TRAIL) {
      this.renderFireEffect(effect, camera);
      return;
    }

    for (const particle of effect.particles) {
      if (particle.alpha <= 0.1 || particle.size <= 0.5) continue;
      if (!camera.isWorldPositionVisible(particle.position, 50)) continue;
      const screenPos  = camera.worldToScreen(particle.position);
      const scaledSize = particle.size * camera.getState().zoom;
      if (scaledSize < 1) continue;
      this.ctx.globalAlpha = particle.alpha;
      this.ctx.fillStyle   = particle.color;
      this.ctx.beginPath();
      this.ctx.arc(screenPos.x, screenPos.y, scaledSize, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1.0;
  }

  /**
   * Render fire particles (FLAME_CONE_EMBERS / FLAME_TRAIL).
   *
   * Canvas 2D translation of shader-based fire concepts:
   *   u_power      → power-curve opacity: Math.pow(1-lifeRatio, 0.7) — bright longer, sharp tail
   *   u_shape_offset → per-particle elongation along velocity direction (ctx.scale(elongation, 1))
   *   u_addition   → multi-stop gradient: hot yellow-orange core → birth colour body → dim edge
   *
   * Each blob is drawn in its own transformed context so it stretches as a "tongue of flame"
   * along whichever direction it is currently travelling.
   */
  private renderFireEffect(effect: ParticleEffect, camera: Camera): void {
    const ctx  = this.ctx;
    const zoom = camera.getState().zoom;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (const p of effect.particles) {
      if (p.life >= p.maxLife) continue;
      if (!camera.isWorldPositionVisible(p.position, p.size * 2)) continue;

      const lifeRatio = p.life / p.maxLife;

      // u_power analog: power curve keeps the blob bright through most of its life
      // then drops off sharply. Cap at 0.72 so many overlapping blobs don't white-out.
      const opacity = Math.min(0.38, Math.pow(1.0 - lifeRatio, 0.7));
      if (opacity <= 0.02) continue;

      const sp           = camera.worldToScreen(p.position);
      const screenRadius = Math.max(2, p.size * zoom * (1.0 - lifeRatio * 0.85));

      // u_shape_offset analog: elongate along the particle's current travel direction.
      // More elongated when young (fast, directional), rounder as it slows and disperses.
      const elongation = 1.4 + (1.0 - lifeRatio) * 0.5; // 1.4 → 1.9 when fresh

      // Derive the angle from current velocity so the tongue tracks actual motion
      const velAngle = Math.atan2(p.velocity.y, p.velocity.x);

      // u_addition analog: multi-stop gradient gives each blob an internal hot core.
      // Stop layout:  hot yellow-orange core → birth colour body → dim translucent edge → transparent
      const col       = p.color; // "R,G,B" stored at spawn
      const coreAlpha = (opacity * 0.95).toFixed(3);
      const bodyAlpha = (opacity * 0.70).toFixed(3);
      const edgeAlpha = (opacity * 0.20).toFixed(3);

      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.rotate(velAngle);
      ctx.scale(elongation, 1.0); // stretch along travel axis

      // Gradient is defined in the scaled/rotated space — rings become ellipses on screen
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, screenRadius);
      grd.addColorStop(0.00, `rgba(255,220,80,${coreAlpha})`);  // hot yellow-white core
      grd.addColorStop(0.15, `rgba(${col},${bodyAlpha})`);      // birth colour body
      grd.addColorStop(0.25, `rgba(${col},${edgeAlpha})`);      // dim trailing edge
      grd.addColorStop(1.00, `rgba(${col},0)`);                 // transparent boundary

      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(0, 0, screenRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore(); // ← restores per-particle transform; composite stays source-over
    }

    ctx.restore(); // ← restores composite operation
  }
}