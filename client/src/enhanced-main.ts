/**
 * Enhanced Client Application Entry Point
 * 
 * Complete multiplayer pirate game client with:
 * - Week 3-4 server integration
 * - Client-side prediction with rollback
 * - Network optimization and lag compensation
 * - Smooth interpolated rendering
 */

import { EnhancedGameEngine, ClientState } from './client/EnhancedGameEngine.js';
import { DEFAULT_CLIENT_CONFIG } from './client/ClientConfig.js';

/**
 * Enhanced Client Application
 */
class EnhancedClientApplication {
  private canvas: HTMLCanvasElement;
  private gameEngine: EnhancedGameEngine;
  private uiElements = {
    connectionStatus: null as HTMLElement | null,
    networkStats: null as HTMLElement | null,
    performanceStats: null as HTMLElement | null,
    errorMessage: null as HTMLElement | null
  };
  
  constructor() {
    console.log('🏴‍☠️ Enhanced Pirate Game Client Starting...');
    
    // Create and configure canvas
    this.canvas = this.createCanvas();
    
    // Create enhanced game engine
    this.gameEngine = new EnhancedGameEngine(this.canvas, DEFAULT_CLIENT_CONFIG);
    
    // Set up UI
    this.setupUI();
    
    // Set up error handling
    this.setupErrorHandling();
    
    console.log('✅ Enhanced Client Application initialized');
    console.log('   Canvas size:', this.canvas.width, 'x', this.canvas.height);
    console.log('   Ready to connect to server...');
  }
  
  /**
   * Start the enhanced client application
   */
  public async start(): Promise<void> {
    try {
      this.updateConnectionStatus('Connecting to server...');
      
      // Start the enhanced game engine
      await this.gameEngine.start();
      
      this.updateConnectionStatus('Connected - Game Running');
      
      // Start UI update loop
      this.startUIUpdateLoop();
      
      console.log('🎮 Enhanced Pirate Game Client running!');
      console.log('   Server integration: Week 3-4 compatible');
      console.log('   Client prediction: Enabled with rollback');
      console.log('   Network optimization: Active');
      console.log('');
      console.log('🕹️  Controls:');
      console.log('   WASD / Arrow Keys: Move');
      console.log('   Space: Jump/Action');
      console.log('   E: Interact');
      console.log('   Q: Dismount');
      console.log('   F: Destroy plank');
      
    } catch (error) {
      console.error('❌ Failed to start client:', error);
      this.updateConnectionStatus('Connection failed: ' + error);
      this.showError('Failed to connect to game server. Please check that the server is running.');
    }
  }
  
  /**
   * Create and configure the game canvas
   */
  private createCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.id = 'gameCanvas';
    canvas.width = 1200;
    canvas.height = 800;
    canvas.style.border = '2px solid #333';
    canvas.style.background = '#1e3a5f'; // Ocean blue
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    
    document.body.appendChild(canvas);
    return canvas;
  }
  
  /**
   * Set up the user interface
   */
  private setupUI(): void {
    // Apply basic styles
    document.body.style.margin = '0';
    document.body.style.padding = '20px';
    document.body.style.backgroundColor = '#0f1419';
    document.body.style.fontFamily = 'Consolas, Monaco, monospace';
    document.body.style.color = '#ffffff';
    
    // Create title
    const title = document.createElement('h1');
    title.textContent = '🏴‍☠️ Enhanced Pirate Game - Week 3-4 Client';
    title.style.textAlign = 'center';
    title.style.color = '#ffd700';
    title.style.marginBottom = '20px';
    document.body.insertBefore(title, this.canvas);
    
    // Create status container
    const statusContainer = document.createElement('div');
    statusContainer.style.display = 'flex';
    statusContainer.style.justifyContent = 'space-between';
    statusContainer.style.marginTop = '20px';
    statusContainer.style.fontSize = '12px';
    statusContainer.style.fontFamily = 'monospace';
    
    // Connection status
    this.uiElements.connectionStatus = document.createElement('div');
    this.uiElements.connectionStatus.style.color = '#ff6b6b';
    statusContainer.appendChild(this.uiElements.connectionStatus);
    
    // Network stats
    this.uiElements.networkStats = document.createElement('div');
    this.uiElements.networkStats.style.color = '#4ecdc4';
    statusContainer.appendChild(this.uiElements.networkStats);
    
    // Performance stats
    this.uiElements.performanceStats = document.createElement('div');
    this.uiElements.performanceStats.style.color = '#45b7d1';
    statusContainer.appendChild(this.uiElements.performanceStats);
    
    document.body.appendChild(statusContainer);
    
    // Error message container
    this.uiElements.errorMessage = document.createElement('div');
    this.uiElements.errorMessage.style.color = '#ff4757';
    this.uiElements.errorMessage.style.backgroundColor = '#2c2c54';
    this.uiElements.errorMessage.style.padding = '10px';
    this.uiElements.errorMessage.style.marginTop = '10px';
    this.uiElements.errorMessage.style.border = '1px solid #ff4757';
    this.uiElements.errorMessage.style.borderRadius = '5px';
    this.uiElements.errorMessage.style.display = 'none';
    document.body.appendChild(this.uiElements.errorMessage);
    
    // Instructions
    const instructions = document.createElement('div');
    instructions.innerHTML = `
      <h3 style="color: #ffd700; margin-top: 20px;">Enhanced Features:</h3>
      <ul style="color: #ffffff; line-height: 1.6;">
        <li><strong>🎯 Client-Side Prediction:</strong> Responsive input with server reconciliation</li>
        <li><strong>⏪ Rollback & Replay:</strong> Lag compensation with deterministic physics</li>
        <li><strong>🌐 Network Optimization:</strong> Bandwidth-efficient delta compression</li>
        <li><strong>📊 Advanced Metrics:</strong> Real-time performance and network monitoring</li>
        <li><strong>🔄 Auto-Reconnection:</strong> Seamless connection recovery</li>
        <li><strong>🎨 Smooth Interpolation:</strong> 60fps rendering with 30Hz server</li>
      </ul>
    `;
    instructions.style.maxWidth = '1200px';
    instructions.style.margin = '0 auto';
    document.body.appendChild(instructions);
  }
  
  /**
   * Start the UI update loop
   */
  private startUIUpdateLoop(): void {
    const updateUI = () => {
      if (this.gameEngine) {
        const metrics = this.gameEngine.getMetrics();
        const state = this.gameEngine.getState();
        
        // Update network stats
        if (this.uiElements.networkStats) {
          this.uiElements.networkStats.innerHTML = `
            📡 Network: ${metrics.networkLatency.toFixed(1)}ms | 
            📊 Loss: ${metrics.packetLossRate.toFixed(1)}% | 
            🔗 ${metrics.connectionState}
          `;
        }
        
        // Update performance stats
        if (this.uiElements.performanceStats) {
          this.uiElements.performanceStats.innerHTML = `
            🎮 FPS: ${metrics.fps} | 
            ⏱️ Frame: ${metrics.frameTime.toFixed(1)}ms | 
            🎯 Accuracy: ${metrics.predictionAccuracy.toFixed(1)}%
          `;
        }
        
        // Update connection status color based on state
        if (this.uiElements.connectionStatus) {
          switch (state) {
            case ClientState.CONNECTED:
            case ClientState.IN_GAME:
              this.uiElements.connectionStatus.style.color = '#2ecc71';
              break;
            case ClientState.CONNECTING:
            case ClientState.DISCONNECTED:
              this.uiElements.connectionStatus.style.color = '#f39c12';
              break;
            case ClientState.ERROR:
              this.uiElements.connectionStatus.style.color = '#e74c3c';
              break;
          }
        }
      }
      
      requestAnimationFrame(updateUI);
    };
    
    updateUI();
  }
  
  /**
   * Set up global error handling
   */
  private setupErrorHandling(): void {
    window.addEventListener('error', (event) => {
      console.error('🚨 Client Error:', event.error);
      this.showError(`Client Error: ${event.error?.message || 'Unknown error'}`);
    });
    
    window.addEventListener('unhandledrejection', (event) => {
      console.error('🚨 Unhandled Promise Rejection:', event.reason);
      this.showError(`Promise Error: ${event.reason?.message || 'Promise rejected'}`);
    });
  }
  
  /**
   * Update connection status display
   */
  private updateConnectionStatus(status: string): void {
    if (this.uiElements.connectionStatus) {
      this.uiElements.connectionStatus.textContent = `🔗 ${status}`;
    }
    console.log('📡', status);
  }
  
  /**
   * Show error message to user
   */
  private showError(message: string): void {
    if (this.uiElements.errorMessage) {
      this.uiElements.errorMessage.textContent = `❌ ${message}`;
      this.uiElements.errorMessage.style.display = 'block';
    }
  }
}

/**
 * Application entry point
 */
async function main() {
  try {
    const app = new EnhancedClientApplication();
    await app.start();
  } catch (error) {
    console.error('💥 Failed to start Enhanced Pirate Game Client:', error);
    
    // Show fallback error message
    document.body.innerHTML = `
      <div style="
        position: fixed; 
        top: 50%; 
        left: 50%; 
        transform: translate(-50%, -50%);
        background: #1e1e1e;
        color: #ff4757;
        padding: 40px;
        border-radius: 10px;
        text-align: center;
        font-family: Consolas, Monaco, monospace;
        max-width: 600px;
      ">
        <h1>🚨 Client Startup Failed</h1>
        <p><strong>Error:</strong> ${error}</p>
        <p>Please check the console for more details and ensure the server is running.</p>
        <button onclick="location.reload()" style="
          background: #ff4757;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 5px;
          cursor: pointer;
          font-family: inherit;
          margin-top: 20px;
        ">Retry</button>
      </div>
    `;
  }
}

// Start the application when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}