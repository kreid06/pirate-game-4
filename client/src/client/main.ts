/**
 * Pirate MMO Client Entry Point
 * 
 * This is the main entry point for the client-side application.
 * It initializes all client systems and starts the game loop.
 */

import { ClientApplication } from './ClientApplication.js';
import { ClientConfig, DEFAULT_CLIENT_CONFIG } from './ClientConfig.js';
import { AuthScreen } from './auth/AuthScreen.js';
import { restoreSession } from './auth/AuthService.js';

/**
 * Initialize and start the client application
 */
export async function main(): Promise<void> {
  try {
    const mainId = Math.random().toString(36).substr(2, 9);
    console.log(`🏴‍☠️ [${mainId}] Pirate MMO Client Starting...`);

    // ── Auth gate ──────────────────────────────────────────────────────────
    // Try to restore an existing session first (skips the login screen on
    // page refresh if the tokens are still valid).
    let session = await restoreSession();
    if (!session) {
      const screen = new AuthScreen();
      session = await screen.waitForAuth();
    }
    console.log(`✅ Authenticated as "${session.displayName}" (guest: ${session.guest})`);
    
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

    // ── Global input suppression ──────────────────────────────────────────
    // Block browser shortcuts that interfere with gameplay.
    // Never suppresses while the user is typing in a real input/textarea.
    const isTyping = (): boolean =>
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement;

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (isTyping()) return;

      const ctrl  = e.ctrlKey || e.metaKey;
      const alt   = e.altKey;
      const shift = e.shiftKey;
      const key   = e.key;
      const code  = e.code;

      // ── Ctrl combos ───────────────────────────────────────────────────
      if (ctrl) {
        switch (key) {
          // Page / navigation / UI chrome — always block
          case 'r': case 'R':   // reload
          case 'p': case 'P':   // print
          case 's': case 'S':   // save page
          case 'f': case 'F':   // find in page
          case 'd': case 'D':   // bookmark
          case 'g': case 'G':   // find next
          case 'u': case 'U':   // view source
          case 'l': case 'L':   // address bar (some browsers)
          // Zoom (conflicts with scroll-wheel zoom we implement ourselves)
          case '=': case '+': case '-': case '0':
            e.preventDefault();
            break;
          // DevTools — block to avoid accidental opening mid-game
          case 'i': case 'I':
          case 'j': case 'J':
          case 'c': case 'C':
            if (shift) e.preventDefault();
            break;
          // Undo / redo — block outside inputs so they don't bubble to browser
          case 'z': case 'Z':
          case 'y': case 'Y':
            e.preventDefault();
            break;
          // Select-all — block so it doesn't highlight page content
          case 'a': case 'A':
            e.preventDefault();
            break;
        }
      }

      // ── Alt combos ───────────────────────────────────────────────────
      if (alt && !ctrl) {
        switch (code) {
          case 'ArrowLeft':   // browser Back
          case 'ArrowRight':  // browser Forward
            e.preventDefault();
            break;
        }
      }

      // ── Function keys ────────────────────────────────────────────────
      if (/^F\d+$/.test(key)) {
        // Allow F11 only if the game itself wants to use it; for now block all.
        // Remove individual entries here to re-enable specific keys.
        switch (key) {
          case 'F1':  // help
          case 'F2':
          case 'F3':  // find
          case 'F4':
          case 'F5':  // reload
          case 'F7':  // caret browsing
          case 'F8': case 'F9': case 'F10':
          case 'F11': // fullscreen (let the browser handle unless you implement your own)
          case 'F12': // devtools
            e.preventDefault();
            break;
        }
      }

      // ── Navigation keys that scroll the page ─────────────────────────
      // Block only when canvas has pointer focus (pointer is locked or was last clicked on canvas)
      if (document.pointerLockElement === canvas || document.activeElement === canvas || document.activeElement === document.body) {
        switch (code) {
          case 'Space':
          case 'ArrowUp': case 'ArrowDown':
          case 'ArrowLeft': case 'ArrowRight':
          case 'PageUp': case 'PageDown':
          case 'Home': case 'End':
            e.preventDefault();
            break;
        }
      }

      // ── Backspace — block page-back navigation ────────────────────────
      if (code === 'Backspace') e.preventDefault();
    }, { capture: true }); // capture phase so it runs before game handlers

    // Block right-click context menu on the canvas
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Block Ctrl+scroll-wheel page zoom
    window.addEventListener('wheel', (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    }, { passive: false });
    // ── End global input suppression ──────────────────────────────────────

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
    
    // Start the application, passing auth credentials for the server handshake
    clientApp.start(session.displayName, session.accessToken, session.guest);
    
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
      font-family: Georgia, serif, Georgia, serif; font-size: 16px; z-index: 10000;
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
      enabled: params.get('debug') === 'true',
    };
  }

  // Extended perf HUD: ?debug=true&perfstats=true
  if (params.get('perfstats') === 'true') {
    config.debug = {
      ...DEFAULT_CLIENT_CONFIG.debug,
      ...config.debug,
      enabled: true,
      showPerformanceStats: true,
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

// Note: main() is called from src/main.ts - don't call it here to avoid duplicates