/**
 * DebugOverlay.ts - Debug visualization system for client rendering
 * 
 * Extracted from legacy engine/DebugRenderer.ts - provides debug overlays
 * for development and troubleshooting.
 */

import { Vec2 } from '../../common/Vec2.js';
import { Camera } from './Camera.js';

/**
 * Debug overlay configuration
 */
export interface DebugOverlayConfig {
  // Basic overlays
  showFPS: boolean;
  showCameraInfo: boolean;
  showMousePosition: boolean;
  
  // Performance overlays
  showRenderStats: boolean;
  showNetworkStats: boolean;
  
  // Colors
  textColor: string;
  backgroundColor: string;
  overlayOpacity: number;
}

/**
 * Default debug overlay configuration
 */
export const DEFAULT_DEBUG_OVERLAY_CONFIG: DebugOverlayConfig = {
  showFPS: true,
  showCameraInfo: false,
  showMousePosition: false,
  showRenderStats: false,
  showNetworkStats: false,
  textColor: '#ffffff',
  backgroundColor: '#000000',
  overlayOpacity: 0.7,
};

/**
 * Debug overlay system for client-side debugging
 */
export class DebugOverlay {
  private config: DebugOverlayConfig;
  private frameCount = 0;
  private lastFrameTime = 0;
  private fps = 0;

  constructor(config: DebugOverlayConfig = DEFAULT_DEBUG_OVERLAY_CONFIG) {
    this.config = { ...config };
  }

  /**
   * Render all debug overlays
   */
  render(ctx: CanvasRenderingContext2D, camera: Camera, mousePos?: Vec2): void {
    if (!this.shouldRender()) return;

    ctx.save();
    
    try {
      this.setupOverlayStyles(ctx);
      
      let yOffset = 10;
      
      if (this.config.showFPS) {
        yOffset = this.renderFPS(ctx, yOffset);
      }
      
      if (this.config.showCameraInfo) {
        yOffset = this.renderCameraInfo(ctx, camera, yOffset);
      }
      
      if (this.config.showMousePosition && mousePos) {
        yOffset = this.renderMousePosition(ctx, camera, mousePos, yOffset);
      }
      
      if (this.config.showRenderStats) {
        yOffset = this.renderRenderStats(ctx, yOffset);
      }
      
    } finally {
      ctx.restore();
    }
  }

  /**
   * Update FPS calculation
   */
  updateFPS(currentTime: number): void {
    this.frameCount++;
    
    if (currentTime - this.lastFrameTime >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (currentTime - this.lastFrameTime));
      this.frameCount = 0;
      this.lastFrameTime = currentTime;
    }
  }

  /**
   * Check if any overlays should be rendered
   */
  private shouldRender(): boolean {
    return this.config.showFPS || 
           this.config.showCameraInfo || 
           this.config.showMousePosition ||
           this.config.showRenderStats ||
           this.config.showNetworkStats;
  }

  /**
   * Setup common overlay styles
   */
  private setupOverlayStyles(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = this.config.backgroundColor;
    ctx.globalAlpha = this.config.overlayOpacity;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  /**
   * Render FPS counter
   */
  private renderFPS(ctx: CanvasRenderingContext2D, yOffset: number): number {
    const text = `FPS: ${this.fps}`;
    const metrics = ctx.measureText(text);
    
    // Background
    ctx.fillRect(5, yOffset - 2, metrics.width + 10, 16);
    
    // Text
    ctx.fillStyle = this.config.textColor;
    ctx.globalAlpha = 1.0;
    ctx.fillText(text, 10, yOffset);
    
    return yOffset + 20;
  }

  /**
   * Render camera information
   */
  private renderCameraInfo(ctx: CanvasRenderingContext2D, camera: Camera, yOffset: number): number {
    const state = camera.getState();
    const lines = [
      `Camera X: ${state.position.x.toFixed(1)}`,
      `Camera Y: ${state.position.y.toFixed(1)}`,
      `Zoom: ${state.zoom.toFixed(2)}`,
      `Rotation: ${(state.rotation * 180 / Math.PI).toFixed(1)}°`
    ];
    
    const maxWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
    
    // Background
    ctx.fillStyle = this.config.backgroundColor;
    ctx.globalAlpha = this.config.overlayOpacity;
    ctx.fillRect(5, yOffset - 2, maxWidth + 10, lines.length * 16 + 4);
    
    // Text
    ctx.fillStyle = this.config.textColor;
    ctx.globalAlpha = 1.0;
    
    lines.forEach((line, index) => {
      ctx.fillText(line, 10, yOffset + (index * 16));
    });
    
    return yOffset + (lines.length * 16) + 10;
  }

  /**
   * Render mouse position
   */
  private renderMousePosition(ctx: CanvasRenderingContext2D, camera: Camera, mousePos: Vec2, yOffset: number): number {
    const worldPos = camera.screenToWorld(mousePos);
    const lines = [
      `Mouse Screen: (${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)})`,
      `Mouse World: (${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)})`
    ];
    
    const maxWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
    
    // Background
    ctx.fillStyle = this.config.backgroundColor;
    ctx.globalAlpha = this.config.overlayOpacity;
    ctx.fillRect(5, yOffset - 2, maxWidth + 10, lines.length * 16 + 4);
    
    // Text
    ctx.fillStyle = this.config.textColor;
    ctx.globalAlpha = 1.0;
    
    lines.forEach((line, index) => {
      ctx.fillText(line, 10, yOffset + (index * 16));
    });
    
    return yOffset + (lines.length * 16) + 10;
  }

  /**
   * Render render statistics
   */
  private renderRenderStats(ctx: CanvasRenderingContext2D, yOffset: number): number {
    // This would show draw calls, objects rendered, etc.
    // Placeholder implementation
    const lines = [
      `Draw Calls: N/A`,
      `Objects: N/A`
    ];
    
    const maxWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
    
    // Background
    ctx.fillStyle = this.config.backgroundColor;
    ctx.globalAlpha = this.config.overlayOpacity;
    ctx.fillRect(5, yOffset - 2, maxWidth + 10, lines.length * 16 + 4);
    
    // Text
    ctx.fillStyle = this.config.textColor;
    ctx.globalAlpha = 1.0;
    
    lines.forEach((line, index) => {
      ctx.fillText(line, 10, yOffset + (index * 16));
    });
    
    return yOffset + (lines.length * 16) + 10;
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<DebugOverlayConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): DebugOverlayConfig {
    return { ...this.config };
  }

  /**
   * Toggle specific debug features
   */
  toggleFPS(): void {
    this.config.showFPS = !this.config.showFPS;
  }

  toggleCameraInfo(): void {
    this.config.showCameraInfo = !this.config.showCameraInfo;
  }

  toggleMousePosition(): void {
    this.config.showMousePosition = !this.config.showMousePosition;
  }
}