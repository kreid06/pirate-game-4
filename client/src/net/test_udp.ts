/**
 * Test file for UDP Network Manager
 * Tests both text-based protocol (like test_protocol.js) and binary protocol
 */

import { UDPNetworkManager, ConnectionState } from './UDPNetworkManager.js';
import { Vec2 } from '../common/Vec2.js';

// Test configuration matching the reference test
const SERVER_HOST = '192.168.56.10';
const SERVER_PORT = 8082

const testConfig = {
  serverUrl: `ws://${SERVER_HOST}:${SERVER_PORT}`,
  maxReconnectAttempts: 3,
  reconnectDelay: 2000,
  heartbeatInterval: 5000,
  timeoutDuration: 10000,
  protocol: 'websocket' as const,
  fallbackToWebSocket: true
};

interface TestResult {
  test: string;
  success: boolean;
  latency?: number;
  error?: string;
  [key: string]: any;
}

class PirateClientTester {
  private testResults: TestResult[] = [];

  async runAllTests(): Promise<void> {
    console.log('🏴‍☠️ Pirate Game Client Protocol Test Suite');
    console.log('============================================\n');

    try {
      // Test text-based protocol first (similar to reference test_protocol.js)
      await this.testTextProtocol();
      
      // Test binary protocol connection
      await this.testBinaryProtocol();
      
      this.printResults();
    } catch (error) {
      console.error('❌ Test suite failed:', error);
    }
  }

  async testTextProtocol(): Promise<void> {
    console.log('📝 Testing Text-Based Protocol (WebSocket as UDP bridge)...\n');
    
    // For browser environment, we'll test through WebSocket
    // The server should bridge UDP commands to WebSocket
    try {
      const ws = new WebSocket(`ws://${SERVER_HOST}:${SERVER_PORT}`);
      
      await this.testPing(ws);
      await this.testJoin(ws);
      await this.testState(ws);
      await this.testEcho(ws);
      
      ws.close();
    } catch (error) {
      console.log('❌ Failed to establish WebSocket connection for text protocol test');
      this.testResults.push({ 
        test: 'TEXT_PROTOCOL_CONNECTION', 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  async testPing(ws: WebSocket): Promise<void> {
    console.log('📡 Testing PING/PONG...');
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      const onMessage = (event: MessageEvent) => {
        const response = event.data.toString();
        const latency = Date.now() - startTime;
        
        if (response === 'PONG') {
          console.log(`✅ PING successful - latency: ${latency}ms`);
          this.testResults.push({ test: 'PING', success: true, latency });
        } else {
          console.log(`❌ Expected PONG, got: ${response}`);
          this.testResults.push({ test: 'PING', success: false });
        }
        
        ws.removeEventListener('message', onMessage);
        resolve();
      };
      
      const onOpen = () => {
        ws.addEventListener('message', onMessage);
        ws.send('PING');
      };
      
      if (ws.readyState === WebSocket.OPEN) {
        onOpen();
      } else {
        ws.addEventListener('open', onOpen, { once: true });
      }
      
      // Timeout after 5 seconds
      setTimeout(() => {
        ws.removeEventListener('message', onMessage);
        console.log('❌ PING timeout');
        this.testResults.push({ test: 'PING', success: false, error: 'timeout' });
        resolve();
      }, 5000);
    });
  }

  async testJoin(ws: WebSocket): Promise<void> {
    console.log('\n🎮 Testing JOIN...');
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      const onMessage = (event: MessageEvent) => {
        const response = event.data.toString();
        const latency = Date.now() - startTime;
        
        try {
          const json = JSON.parse(response);
          if (json.type === 'WELCOME' && json.player_id) {
            console.log(`✅ JOIN successful - Player ID: ${json.player_id}, latency: ${latency}ms`);
            this.testResults.push({ test: 'JOIN', success: true, latency, player_id: json.player_id });
          } else {
            console.log(`❌ Invalid welcome message: ${response}`);
            this.testResults.push({ test: 'JOIN', success: false });
          }
        } catch (error) {
          console.log(`❌ JOIN response not JSON: ${response}`);
          this.testResults.push({ test: 'JOIN', success: false, error: 'invalid_json' });
        }
        
        ws.removeEventListener('message', onMessage);
        resolve();
      };
      
      ws.addEventListener('message', onMessage);
      ws.send('JOIN:TestPlayer');
      
      setTimeout(() => {
        ws.removeEventListener('message', onMessage);
        console.log('❌ JOIN timeout');
        this.testResults.push({ test: 'JOIN', success: false, error: 'timeout' });
        resolve();
      }, 5000);
    });
  }

  async testState(ws: WebSocket): Promise<void> {
    console.log('\n🗺️ Testing STATE request...');
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      
      const onMessage = (event: MessageEvent) => {
        const response = event.data.toString();
        const latency = Date.now() - startTime;
        
        try {
          const json = JSON.parse(response);
          if (json.type === 'GAME_STATE' && json.hasOwnProperty('tick')) {
            console.log(`✅ STATE successful - Tick: ${json.tick}, latency: ${latency}ms`);
            console.log(`   Ships: ${json.ships?.length || 0}, Players: ${json.players?.length || 0}, Projectiles: ${json.projectiles?.length || 0}`);
            this.testResults.push({ test: 'STATE', success: true, latency, tick: json.tick });
          } else {
            console.log(`❌ Invalid state response: ${response}`);
            this.testResults.push({ test: 'STATE', success: false });
          }
        } catch (error) {
          console.log(`❌ STATE response not JSON: ${response}`);
          this.testResults.push({ test: 'STATE', success: false, error: 'invalid_json' });
        }
        
        ws.removeEventListener('message', onMessage);
        resolve();
      };
      
      ws.addEventListener('message', onMessage);
      ws.send('STATE');
      
      setTimeout(() => {
        ws.removeEventListener('message', onMessage);
        console.log('❌ STATE timeout');
        this.testResults.push({ test: 'STATE', success: false, error: 'timeout' });
        resolve();
      }, 5000);
    });
  }

  async testEcho(ws: WebSocket): Promise<void> {
    console.log('\n🔄 Testing ECHO...');
    
    return new Promise((resolve) => {
      const testMessage = 'HELLO_WORLD_123';
      const startTime = Date.now();
      
      const onMessage = (event: MessageEvent) => {
        const response = event.data.toString();
        const latency = Date.now() - startTime;
        
        if (response === testMessage) {
          console.log(`✅ ECHO successful - latency: ${latency}ms`);
          this.testResults.push({ test: 'ECHO', success: true, latency });
        } else {
          console.log(`❌ Echo mismatch - sent: "${testMessage}", got: "${response}"`);
          this.testResults.push({ test: 'ECHO', success: false });
        }
        
        ws.removeEventListener('message', onMessage);
        resolve();
      };
      
      ws.addEventListener('message', onMessage);
      ws.send(testMessage);
      
      setTimeout(() => {
        ws.removeEventListener('message', onMessage);
        console.log('❌ ECHO timeout');
        this.testResults.push({ test: 'ECHO', success: false, error: 'timeout' });
        resolve();
      }, 5000);
    });
  }

  async testBinaryProtocol(): Promise<void> {
    console.log('\n\n🔧 Testing Binary Protocol (Game Connection)...\n');
    
    const networkManager = new UDPNetworkManager(testConfig);
    
    return new Promise((resolve) => {
      let connectionTestComplete = false;
      
      // Setup event handlers
      networkManager.setConnectionStateHandler((state: ConnectionState) => {
        console.log(`📡 Binary protocol connection state: ${state}`);
        
        if (state === ConnectionState.CONNECTED) {
          console.log('✅ Binary protocol connection successful!');
          this.testResults.push({ test: 'BINARY_CONNECTION', success: true });
          
          // Test sending input
          const testInput = {
            tick: 0,
            movement: new Vec2(0.5, 0.8), // Forward and right
            actions: 1, // Fire action
            rotation: 0 // Facing right
          };
          
          networkManager.sendInput(testInput);
          console.log('📤 Sent test input to server');
          
          // Test stats
          setTimeout(() => {
            const stats = networkManager.getStats();
            console.log('📊 Network stats:', {
              ping: stats.ping,
              connectionState: stats.connectionState,
              packetsSent: stats.packetsSent,
              packetsReceived: stats.packetsReceived
            });
            
            this.testResults.push({ 
              test: 'BINARY_INPUT', 
              success: stats.packetsSent > 0,
              packetsSent: stats.packetsSent
            });
            
            networkManager.disconnect();
            connectionTestComplete = true;
            resolve();
          }, 2000);
          
        } else if (state === ConnectionState.ERROR) {
          console.log('❌ Binary protocol connection failed');
          this.testResults.push({ test: 'BINARY_CONNECTION', success: false, error: 'connection_failed' });
          if (!connectionTestComplete) {
            connectionTestComplete = true;
            resolve();
          }
        }
      });
      
      networkManager.setWorldStateHandler((worldState) => {
        console.log('🌍 Received world state update:', {
          tick: worldState.tick,
          ships: worldState.ships.length,
          cannonballs: worldState.cannonballs.length,
          players: worldState.players.length
        });
        
        this.testResults.push({ 
          test: 'BINARY_WORLDSTATE', 
          success: true,
          tick: worldState.tick,
          entityCount: worldState.ships.length + worldState.cannonballs.length
        });
      });
      
      // Attempt binary protocol connection
      networkManager.connect('BinaryTestPlayer').catch((error) => {
        console.error('❌ Binary protocol connection failed:', error);
        this.testResults.push({ 
          test: 'BINARY_CONNECTION', 
          success: false, 
          error: error.message 
        });
        if (!connectionTestComplete) {
          connectionTestComplete = true;
          resolve();
        }
      });
      
      // Overall timeout
      setTimeout(() => {
        if (!connectionTestComplete) {
          console.log('❌ Binary protocol test timeout');
          this.testResults.push({ test: 'BINARY_CONNECTION', success: false, error: 'timeout' });
          networkManager.disconnect();
          connectionTestComplete = true;
          resolve();
        }
      }, 10000);
    });
  }

  printResults(): void {
    console.log('\n\n📊 Test Results Summary');
    console.log('========================');
    
    const successes = this.testResults.filter(r => r.success).length;
    const total = this.testResults.length;
    
    console.log(`Overall: ${successes}/${total} tests passed\n`);
    
    // Group results by protocol type
    const textTests = this.testResults.filter(r => ['PING', 'JOIN', 'STATE', 'ECHO'].includes(r.test));
    const binaryTests = this.testResults.filter(r => r.test.startsWith('BINARY_'));
    
    if (textTests.length > 0) {
      console.log('📝 Text Protocol Results:');
      textTests.forEach(result => {
        const status = result.success ? '✅' : '❌';
        const latency = result.latency ? ` (${result.latency}ms)` : '';
        const error = result.error ? ` - ${result.error}` : '';
        console.log(`  ${status} ${result.test}${latency}${error}`);
      });
      console.log('');
    }
    
    if (binaryTests.length > 0) {
      console.log('🔧 Binary Protocol Results:');
      binaryTests.forEach(result => {
        const status = result.success ? '✅' : '❌';
        const details = result.packetsSent ? ` (${result.packetsSent} packets sent)` : 
                       result.tick ? ` (tick: ${result.tick})` : '';
        const error = result.error ? ` - ${result.error}` : '';
        console.log(`  ${status} ${result.test}${details}${error}`);
      });
    }

    if (successes === total) {
      console.log('\n🎉 All tests passed! Both protocols working correctly.');
    } else {
      console.log(`\n⚠️  ${total - successes} test(s) failed. Check server status and protocol implementation.`);
    }
  }
}

async function testUDPConnection() {
  console.log(`🔍 Testing connection to server at ${SERVER_HOST}:${SERVER_PORT}...`);
  
  const tester = new PirateClientTester();
  await tester.runAllTests();
}

// Export for use in other modules
export { testUDPConnection, PirateClientTester };

// Run test if this file is executed directly  
if (typeof window !== 'undefined') {
  // Browser environment - expose to global scope for manual testing
  (window as any).testUDPConnection = testUDPConnection;
  console.log('💡 UDP test loaded. Run testUDPConnection() in console to start tests.');
}