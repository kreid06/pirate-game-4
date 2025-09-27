/**
 * Test file for UDP Network Manager
 * This will test the connection to the C physics server
 */

import { UDPNetworkManager, ConnectionState } from './UDPNetworkManager.js';
import { Vec2 } from '../common/Vec2.js';

// Test configuration
const testConfig = {
  serverUrl: 'ws://localhost:8080', // WebSocket bridge to UDP server
  reconnectAttempts: 3,
  heartbeatInterval: 5000,
  timeout: 10000
};

async function testUDPConnection() {
  console.log('🧪 Testing UDP Network Manager connection...');
  
  const networkManager = new UDPNetworkManager(testConfig);
  
  // Setup event handlers
  networkManager.setConnectionStateHandler((state: ConnectionState) => {
    console.log(`📡 Connection state changed: ${state}`);
    
    if (state === ConnectionState.CONNECTED) {
      console.log('✅ Successfully connected to physics server!');
      
      // Test sending input
      const testInput = {
        tick: 0,
        movement: new Vec2(0.5, 0.8), // Forward and right
        actions: 1 // Fire action
      };
      
      networkManager.sendInput(testInput);
      console.log('📤 Sent test input to server');
      
      // Test stats
      setTimeout(() => {
        const stats = networkManager.getStats();
        console.log('📊 Network stats:', stats);
      }, 1000);
    }
  });
  
  networkManager.setWorldStateHandler((worldState) => {
    console.log('🌍 Received world state update:', {
      tick: worldState.tick,
      ships: worldState.ships.length,
      cannonballs: worldState.cannonballs.length,
      players: worldState.players.length
    });
  });
  
  try {
    // Attempt connection
    await networkManager.connect('TestPlayer');
    console.log('🚀 Connection attempt completed');
    
    // Keep running for a bit to test
    setTimeout(() => {
      console.log('🛑 Test completed, disconnecting...');
      networkManager.disconnect();
    }, 5000);
    
  } catch (error) {
    console.error('❌ Connection failed:', error);
  }
}

// Run test if this file is executed directly
if (import.meta.url === new URL(import.meta.resolve?.('./test') || '', import.meta.url).href) {
  testUDPConnection();
}

export { testUDPConnection };