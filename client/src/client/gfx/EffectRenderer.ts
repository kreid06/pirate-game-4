/**
 * Effect Renderer for Special Visual Effects
 * 
 * Handles special rendering effects like muzzle flashes, water wakes, 
 * and other non-particle visual effects.
 */

import { Camera } from './Camera.js';
import { Vec2 } from '../../common/Vec2.js';

/**
 * Visual effect types
 */
export enum EffectType {
  MUZZLE_FLASH = 'muzzle_flash',
  WATER_WAKE = 'water_wake',
  SHIP_FOAM = 'ship_foam',
  EXPLOSION_FLASH = 'explosion_flash',
  DAMAGE_NUMBER = 'damage_number',
  SWORD_ARC = 'sword_arc'
}

/** Category controls the colour and icon of a top-centre announcement banner. */
export type AnnouncementKind = 'ship_sink' | 'npc_kill' | 'info';

/**
 * Base effect interface
 */
interface Effect {
  id: number;
  type: EffectType;
  position: Vec2;
  age: number;
  maxAge: number;
  intensity: number;
}

/**
 * Muzzle flash effect
 */
interface MuzzleFlashEffect extends Effect {
  type: EffectType.MUZZLE_FLASH;
  direction: number; // Radians
  size: number;
}

/**
 * Water wake effect
 */
interface WaterWakeEffect extends Effect {
  type: EffectType.WATER_WAKE;
  direction: number; // Direction of movement
  width: number;
  points: Vec2[]; // Trail points
}

/**
 * Sword swing arc effect
 */
interface SwordArcEffect extends Effect {
  type: EffectType.SWORD_ARC;
  direction: number; // attack angle in radians
  arcHalf: number;   // half arc spread in radians (PI/3 = 60°)
  radius: number;    // reach in world pixels
}

/**
 * Damage number floating text effect
 */
interface DamageNumberEffect extends Effect {
  type: EffectType.DAMAGE_NUMBER;
  damage: number;
  isKill: boolean;     // true = plank/module destroyed
  floatOffset: number; // pixels floated upward so far (screen space)
}

/** Screen-space announcement banner shown at the top-centre of the canvas. */
interface Announcement {
  text: string;
  kind: AnnouncementKind;
  age: number;      // seconds elapsed
  maxAge: number;   // total lifetime
}

/**
 * Effect union type
 */
type VisualEffect = MuzzleFlashEffect | WaterWakeEffect | DamageNumberEffect | SwordArcEffect | Effect;

/**
 * Effect renderer system
 */
export class EffectRenderer {
  private ctx: CanvasRenderingContext2D;
  private effects: VisualEffect[] = [];
  private nextEffectId = 1;
  /** Screen-space announcement banners (independent of world position). */
  private announcements: Announcement[] = [];
  
  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }
  
  /**
   * Initialize effect renderer
   */
  async initialize(): Promise<void> {
    console.log('🌟 Effect renderer initialized');
  }
  
  /**
   * Update all effects
   */
  update(deltaTime: number): void {
    const dt = deltaTime; // deltaTime is already in seconds
    
    // Update all effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      effect.age += dt;
      
      // Remove expired effects
      if (effect.age >= effect.maxAge) {
        this.effects.splice(i, 1);
        continue;
      }
      
      // Update effect-specific properties
      this.updateEffect(effect, dt);
    }

    // Age announcements
    for (let i = this.announcements.length - 1; i >= 0; i--) {
      this.announcements[i].age += dt;
      if (this.announcements[i].age >= this.announcements[i].maxAge)
        this.announcements.splice(i, 1);
    }
  }
  
  /**
   * Render all effects
   */
  render(camera: Camera): void {
    this.ctx.save();
    
    for (const effect of this.effects) {
      // Check if effect is visible (generous margin for nearby off-screen effects)
      if (!camera.isWorldPositionVisible(effect.position, 500)) continue;
      
      // Render based on effect type
      switch (effect.type) {
        case EffectType.MUZZLE_FLASH:
          this.renderMuzzleFlash(effect as MuzzleFlashEffect, camera);
          break;
        case EffectType.WATER_WAKE:
          this.renderWaterWake(effect as WaterWakeEffect, camera);
          break;
        case EffectType.EXPLOSION_FLASH:
          this.renderExplosionFlash(effect, camera);
          break;
        case EffectType.DAMAGE_NUMBER:
          this.renderDamageNumber(effect as DamageNumberEffect, camera);
          break;
        case EffectType.SWORD_ARC:
          this.renderSwordArc(effect as SwordArcEffect, camera);
          break;
      }
    }
    
    this.ctx.restore();
  }
  
  /**
   * Create muzzle flash effect
   */
  createMuzzleFlash(position: Vec2, direction: number, intensity: number = 1.0): void {
    const effect: MuzzleFlashEffect = {
      id: this.nextEffectId++,
      type: EffectType.MUZZLE_FLASH,
      position: position.clone(),
      direction,
      size: 40 * intensity,
      age: 0,
      maxAge: 0.15, // Very brief flash
      intensity
    };
    
    this.effects.push(effect);
  }
  
  /**
   * Create water wake effect for moving ships
   */
  createWaterWake(position: Vec2, direction: number, width: number): void {
    const effect: WaterWakeEffect = {
      id: this.nextEffectId++,
      type: EffectType.WATER_WAKE,
      position: position.clone(),
      direction,
      width,
      points: [position.clone()],
      age: 0,
      maxAge: 5.0, // Wake persists for 5 seconds
      intensity: 1.0
    };
    
    this.effects.push(effect);
  }
  
  /**
   * Create a floating damage number at a world position
   */
  createDamageNumber(position: Vec2, damage: number, isKill: boolean = false): void {
    const effect: DamageNumberEffect = {
      id: this.nextEffectId++,
      type: EffectType.DAMAGE_NUMBER,
      position: position.clone(),
      damage: Math.round(damage),
      isKill,
      floatOffset: 0,
      age: 0,
      maxAge: 3.0,
      intensity: 1.0
    };
    this.effects.push(effect);
  }

  /**
   * Queue a top-centre announcement banner.
   * @param text    The message to display.
   * @param kind    Controls colour/icon: 'ship_sink' | 'npc_kill' | 'info'.
   * @param duration Total display time in seconds (default 3.5 s).
   */
  createAnnouncement(text: string, kind: AnnouncementKind = 'info', duration = 3.5): void {
    this.announcements.push({ text, kind, age: 0, maxAge: duration });
  }

  /**
   * Render all active announcement banners (screen-space, call after world render).
   * Must be called with the raw canvas dimensions available.
   */
  renderAnnouncements(canvas: HTMLCanvasElement): void {
    if (this.announcements.length === 0) return;

    const ctx = this.ctx;
    const cx = canvas.width / 2;

    const FADE_IN  = 0.15; // s — quick pop
    const HOLD_END = 0.65; // fraction of maxAge while fully opaque
    const FONT_SIZE = 22;
    const PAD_X = 28;
    const PAD_Y = 12;
    const LINE_H = FONT_SIZE + PAD_Y * 2;

    ctx.save();
    ctx.font = `bold ${FONT_SIZE}px Consolas, monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // Stack banners downward from the top (offset each so they don't overlap)
    let offsetY = 0;
    for (const ann of this.announcements) {
      const t = ann.age / ann.maxAge;
      // Fast fade-in (0 → FADE_IN s), hold, then slow fade-out
      let alpha: number;
      const fadeInT = ann.age / FADE_IN;
      if (fadeInT < 1) {
        alpha = fadeInT;            // 0 → 1 in FADE_IN seconds
      } else if (t < HOLD_END) {
        alpha = 1;                  // fully visible
      } else {
        alpha = 1 - (t - HOLD_END) / (1 - HOLD_END); // slow fade out
      }
      alpha = Math.max(0, Math.min(1, alpha));

      // Colour scheme per kind
      let bgColor: string;
      let textColor: string;
      let borderColor: string;
      let icon: string;
      if (ann.kind === 'ship_sink') {
        bgColor = 'rgba(20,10,10,0.88)'; borderColor = '#cc3322'; textColor = '#ff7755'; icon = '⚓';
      } else if (ann.kind === 'npc_kill') {
        bgColor = 'rgba(10,18,10,0.88)'; borderColor = '#336622'; textColor = '#88ee55'; icon = '💀';
      } else {
        bgColor = 'rgba(14,18,30,0.88)'; borderColor = '#445566'; textColor = '#aaccee'; icon = 'ℹ';
      }

      const label = `${icon}  ${ann.text}`;
      const textW = ctx.measureText(label).width;
      const boxW  = textW + PAD_X * 2;
      const bx    = cx - boxW / 2;
      const by    = 28 + offsetY;

      ctx.globalAlpha = alpha;

      // Background
      ctx.fillStyle = bgColor;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, LINE_H, 5);
      ctx.fill();

      // Border
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, LINE_H, 5);
      ctx.stroke();

      // Text
      ctx.fillStyle = textColor;
      ctx.fillText(label, cx, by + LINE_H / 2);

      offsetY += LINE_H + 6;
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * Create a sword swing arc effect at a world position.
   * @param position  World position of the attacker.
   * @param direction Attack angle in radians.
   * @param radius    Reach in world pixels (default 80).
   */
  createSwordArc(position: Vec2, direction: number, radius: number = 30): void {
    const effect: SwordArcEffect = {
      id: this.nextEffectId++,
      type: EffectType.SWORD_ARC,
      position: position.clone(),
      direction,
      arcHalf: Math.PI / 3, // ±60° sweep
      radius,
      age: 0,
      maxAge: 0.25,
      intensity: 1.0
    };
    this.effects.push(effect);
  }

  /**
   * Create explosion flash effect
   */
  createExplosionFlash(position: Vec2, intensity: number = 1.0): void {
    const effect: Effect = {
      id: this.nextEffectId++,
      type: EffectType.EXPLOSION_FLASH,
      position: position.clone(),
      age: 0,
      maxAge: 0.3, // Brief flash
      intensity
    };
    
    this.effects.push(effect);
  }
  
  /**
   * Shutdown effect renderer
   */
  shutdown(): void {
    this.effects = [];
    console.log('🌟 Effect renderer shutdown');
  }
  
  // Private rendering methods
  
  private updateEffect(effect: VisualEffect, deltaTime: number): void {
    switch (effect.type) {
      case EffectType.WATER_WAKE:
        this.updateWaterWake(effect as WaterWakeEffect, deltaTime);
        break;
      case EffectType.DAMAGE_NUMBER:
        // no float
        break;
    }
  }
  
  private updateWaterWake(effect: WaterWakeEffect, deltaTime: number): void {
    // Add new points to the wake trail (simplified - in real game this would come from ship movement)
    const timeSinceLastPoint = effect.age % 0.1; // Add point every 100ms
    if (timeSinceLastPoint < deltaTime) {
      // Calculate new point based on direction
      const lastPoint = effect.points[effect.points.length - 1];
      const speed = 50; // Wake movement speed
      const newPoint = lastPoint.add(Vec2.from(
        Math.cos(effect.direction) * speed * 0.1,
        Math.sin(effect.direction) * speed * 0.1
      ));
      
      effect.points.push(newPoint);
      
      // Limit wake trail length
      if (effect.points.length > 50) {
        effect.points.shift(); // Remove oldest point
      }
    }
  }
  
  private renderMuzzleFlash(effect: MuzzleFlashEffect, camera: Camera): void {
    const screenPos = camera.worldToScreen(effect.position);
    const cameraState = camera.getState();
    const scaledSize = effect.size * cameraState.zoom;
    
    // Calculate alpha based on age (quick fade)
    const alpha = 1.0 - (effect.age / effect.maxAge);
    
    this.ctx.save();
    this.ctx.translate(screenPos.x, screenPos.y);
    this.ctx.rotate(effect.direction - cameraState.rotation);
    
    // Draw muzzle flash as bright white/yellow oval
    const gradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, scaledSize);
    gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    gradient.addColorStop(0.5, `rgba(255, 200, 0, ${alpha * 0.8})`);
    gradient.addColorStop(1, `rgba(255, 100, 0, 0)`);
    
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(-scaledSize, -scaledSize * 0.3, scaledSize * 2, scaledSize * 0.6);
    
    this.ctx.restore();
  }
  
  private renderWaterWake(effect: WaterWakeEffect, camera: Camera): void {
    if (effect.points.length < 2) return;
    
    const cameraState = camera.getState();
    const alpha = Math.max(0.1, 1.0 - (effect.age / effect.maxAge));
    
    this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.3})`;
    this.ctx.lineWidth = effect.width * cameraState.zoom;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    
    // Draw wake trail
    this.ctx.beginPath();
    const firstScreenPos = camera.worldToScreen(effect.points[0]);
    this.ctx.moveTo(firstScreenPos.x, firstScreenPos.y);
    
    for (let i = 1; i < effect.points.length; i++) {
      const screenPos = camera.worldToScreen(effect.points[i]);
      this.ctx.lineTo(screenPos.x, screenPos.y);
    }
    
    this.ctx.stroke();
  }
  
  private renderDamageNumber(effect: DamageNumberEffect, camera: Camera): void {
    const screenPos = camera.worldToScreen(effect.position);
    const t = effect.age / effect.maxAge; // 0→1 over lifetime

    // Fade: hold full for first 60%, then fade out over remaining 40%
    const alpha = t < 0.6 ? 1.0 : 1.0 - (t - 0.6) / 0.4;

    // Scale: pop in quickly then stay (min 0.3 so text is never 0px)
    const scale = t < 0.08 ? 0.3 + 0.7 * (t / 0.08) : 1.0;

    const x = screenPos.x;
    const y = screenPos.y;

    const label = effect.isKill ? `💥 -${effect.damage}` : `-${effect.damage}`;
    const fontSize = effect.isKill ? 28 : 24;

    this.ctx.save();
    this.ctx.globalAlpha = alpha;
    this.ctx.font = `bold ${Math.round(fontSize * scale)}px Arial`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    // Shadow for readability
    this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
    this.ctx.fillText(label, x + 1, y + 1);

    // Main text: red for kill, orange for damage
    this.ctx.fillStyle = effect.isKill ? '#ff3030' : '#ffaa00';
    this.ctx.fillText(label, x, y);
    this.ctx.restore();
  }

  private renderSwordArc(effect: SwordArcEffect, camera: Camera): void {
    const screenPos = camera.worldToScreen(effect.position);
    const cameraState = camera.getState();
    const t = effect.age / effect.maxAge; // 0 → 1

    // Swing progress: arc sweeps from (direction - arcHalf) → (direction + arcHalf)
    const startAngle = effect.direction - effect.arcHalf - cameraState.rotation;
    const endAngle   = effect.direction + effect.arcHalf - cameraState.rotation;
    const scaledRadius = effect.radius * cameraState.zoom;

    // Fade out quickly
    const alpha = Math.max(0, 1.0 - t);

    this.ctx.save();
    this.ctx.globalAlpha = alpha;

    // Outer glow
    this.ctx.strokeStyle = `rgba(220, 220, 255, ${alpha * 0.4})`;
    this.ctx.lineWidth = 10 * cameraState.zoom;
    this.ctx.lineCap = 'round';
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, startAngle, endAngle);
    this.ctx.stroke();

    // Sharp inner arc
    this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    this.ctx.lineWidth = 2.5 * cameraState.zoom;
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, scaledRadius, startAngle, endAngle);
    this.ctx.stroke();

    // Short radial lines at arc ends
    for (const angle of [startAngle, endAngle]) {
      const ex = screenPos.x + Math.cos(angle) * scaledRadius * 0.65;
      const ey = screenPos.y + Math.sin(angle) * scaledRadius * 0.65;
      const tx = screenPos.x + Math.cos(angle) * scaledRadius;
      const ty = screenPos.y + Math.sin(angle) * scaledRadius;
      this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.7})`;
      this.ctx.lineWidth = 1.5 * cameraState.zoom;
      this.ctx.beginPath();
      this.ctx.moveTo(ex, ey);
      this.ctx.lineTo(tx, ty);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  private renderExplosionFlash(effect: Effect, camera: Camera): void {
    const screenPos = camera.worldToScreen(effect.position);
    const cameraState = camera.getState();
    
    // Calculate size and alpha
    const maxSize = 80 * effect.intensity;
    const size = maxSize * cameraState.zoom;
    const alpha = 1.0 - (effect.age / effect.maxAge);
    
    // Draw bright flash
    const gradient = this.ctx.createRadialGradient(0, 0, 0, screenPos.x, screenPos.y, size);
    gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    gradient.addColorStop(0.3, `rgba(255, 150, 0, ${alpha * 0.8})`);
    gradient.addColorStop(0.7, `rgba(255, 50, 0, ${alpha * 0.4})`);
    gradient.addColorStop(1, `rgba(255, 0, 0, 0)`);
    
    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.arc(screenPos.x, screenPos.y, size, 0, Math.PI * 2);
    this.ctx.fill();
  }
}