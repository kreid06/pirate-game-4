// Main entry point for Pirate Game Client
import { main } from './client/main.js';

// Start the client application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
