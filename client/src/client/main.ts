/**
 * Pirate MMO Client Entry Point
 * 
 * This is the main entry point for the client-side application.
 * It initializes all client systems and starts the game loop.
 */

import { ClientApplication } from './ClientApplication.js';
import { ClientConfig, DEFAULT_CLIENT_CONFIG } from './ClientConfig.js';

/**
 * Initialize and start the client application
 */
export async function main(): Promise<void> {
  try {
    console.log('🏴‍☠️ Pirate MMO Client Starting...');
    
    // Get canvas element
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    if (!canvas) {
      throw new Error('Canvas element #gameCanvas not found');
    }
    
    // Handle canvas resize
    function resizeCanvas(): void {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    
    // Initial resize and set up listener
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Load client configuration (could come from server or local storage)
    const config: ClientConfig = {
      ...DEFAULT_CLIENT_CONFIG,
      // Override any settings from URL parameters or local storage
      ...parseClientConfigFromUrl(),
      canvas: {
        width: canvas.width,
        height: canvas.height
      }
    };
    
    // Create and initialize client application
    const clientApp = new ClientApplication(canvas, config);
    await clientApp.initialize();
    
    // Start the application
    clientApp.start();
    
    console.log('✅ Pirate MMO Client Started Successfully');
    
    // Handle graceful shutdown
    window.addEventListener('beforeunload', () => {
      console.log('🛑 Client Shutting Down...');
      clientApp.shutdown();
    });
    
  } catch (error) {
    console.error('❌ Failed to start Pirate MMO Client:', error);
    
    // Show error to user
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: #ff4444; color: white; padding: 20px; border-radius: 10px;
      font-family: Arial, sans-serif; font-size: 16px; z-index: 10000;
    `;
    errorDiv.textContent = `Failed to start game: ${error instanceof Error ? error.message : 'Unknown error'}`;
    document.body.appendChild(errorDiv);
  }
}

/**
 * Parse client configuration from URL parameters
 */
function parseClientConfigFromUrl(): Partial<ClientConfig> {
  const params = new URLSearchParams(window.location.search);
  const config: Partial<ClientConfig> = {};
  
  // Server connection settings
  if (params.has('server')) {
    config.network = {
      ...DEFAULT_CLIENT_CONFIG.network,
      serverUrl: params.get('server')!
    };
  }
  
  // Debug settings
  if (params.has('debug')) {
    config.debug = {
      ...DEFAULT_CLIENT_CONFIG.debug,
      enabled: params.get('debug') === 'true'
    };
  }
  
  // Graphics settings
  if (params.has('fps')) {
    const fps = parseInt(params.get('fps')!, 10);
    if (fps > 0 && fps <= 120) {
      config.graphics = {
        ...DEFAULT_CLIENT_CONFIG.graphics,
        targetFPS: fps
      };
    }
  }
  
  return config;
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}