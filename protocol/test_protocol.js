#!/usr/bin/env node

/**
 * Pirate Game Protocol Test Suite
 * 
 * This script tests the actual UDP protocol implementation
 * against the running pirate-server on localhost:8080
 */

const dgram = require('dgram');

const SERVER_HOST = 'localhost';
const SERVER_PORT = 8080;

class PirateServerTester {
    constructor() {
        this.client = dgram.createSocket('udp4');
        this.testResults = [];
    }

    async runAllTests() {
        console.log('🏴‍☠️ Pirate Game Server Protocol Test Suite');
        console.log('===========================================\n');

        try {
            await this.testPing();
            await this.testJoin();
            await this.testState();
            await this.testEcho();
            
            this.printResults();
        } catch (error) {
            console.error('❌ Test suite failed:', error);
        } finally {
            this.client.close();
        }
    }

    async testPing() {
        console.log('📡 Testing PING/PONG...');
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            
            // Setup response handler
            const onMessage = (msg, rinfo) => {
                const response = msg.toString();
                const latency = Date.now() - startTime;
                
                if (response === 'PONG') {
                    console.log(`✅ PING successful - latency: ${latency}ms`);
                    this.testResults.push({ test: 'PING', success: true, latency });
                } else {
                    console.log(`❌ Expected PONG, got: ${response}`);
                    this.testResults.push({ test: 'PING', success: false });
                }
                
                this.client.off('message', onMessage);
                resolve();
            };
            
            this.client.on('message', onMessage);
            
            // Send PING
            const message = Buffer.from('PING');
            this.client.send(message, SERVER_PORT, SERVER_HOST, (err) => {
                if (err) {
                    console.error('❌ Failed to send PING:', err);
                    this.testResults.push({ test: 'PING', success: false, error: err.message });
                    resolve();
                }
            });
            
            // Timeout after 5 seconds
            setTimeout(() => {
                this.client.off('message', onMessage);
                console.log('❌ PING timeout');
                this.testResults.push({ test: 'PING', success: false, error: 'timeout' });
                resolve();
            }, 5000);
        });
    }

    async testJoin() {
        console.log('\\n🎮 Testing JOIN...');
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            
            const onMessage = (msg, rinfo) => {
                const response = msg.toString();
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
                
                this.client.off('message', onMessage);
                resolve();
            };
            
            this.client.on('message', onMessage);
            
            // Send JOIN with player name
            const message = Buffer.from('JOIN:TestPlayer');
            this.client.send(message, SERVER_PORT, SERVER_HOST, (err) => {
                if (err) {
                    console.error('❌ Failed to send JOIN:', err);
                    this.testResults.push({ test: 'JOIN', success: false, error: err.message });
                    resolve();
                }
            });
            
            setTimeout(() => {
                this.client.off('message', onMessage);
                console.log('❌ JOIN timeout');
                this.testResults.push({ test: 'JOIN', success: false, error: 'timeout' });
                resolve();
            }, 5000);
        });
    }

    async testState() {
        console.log('\\n🗺️ Testing STATE request...');
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            
            const onMessage = (msg, rinfo) => {
                const response = msg.toString();
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
                
                this.client.off('message', onMessage);
                resolve();
            };
            
            this.client.on('message', onMessage);
            
            // Send STATE request
            const message = Buffer.from('STATE');
            this.client.send(message, SERVER_PORT, SERVER_HOST, (err) => {
                if (err) {
                    console.error('❌ Failed to send STATE:', err);
                    this.testResults.push({ test: 'STATE', success: false, error: err.message });
                    resolve();
                }
            });
            
            setTimeout(() => {
                this.client.off('message', onMessage);
                console.log('❌ STATE timeout');
                this.testResults.push({ test: 'STATE', success: false, error: 'timeout' });
                resolve();
            }, 5000);
        });
    }

    async testEcho() {
        console.log('\\n🔄 Testing ECHO...');
        
        return new Promise((resolve) => {
            const testMessage = 'HELLO_WORLD_123';
            const startTime = Date.now();
            
            const onMessage = (msg, rinfo) => {
                const response = msg.toString();
                const latency = Date.now() - startTime;
                
                if (response === testMessage) {
                    console.log(`✅ ECHO successful - latency: ${latency}ms`);
                    this.testResults.push({ test: 'ECHO', success: true, latency });
                } else {
                    console.log(`❌ Echo mismatch - sent: "${testMessage}", got: "${response}"`);
                    this.testResults.push({ test: 'ECHO', success: false });
                }
                
                this.client.off('message', onMessage);
                resolve();
            };
            
            this.client.on('message', onMessage);
            
            // Send test message
            const message = Buffer.from(testMessage);
            this.client.send(message, SERVER_PORT, SERVER_HOST, (err) => {
                if (err) {
                    console.error('❌ Failed to send ECHO test:', err);
                    this.testResults.push({ test: 'ECHO', success: false, error: err.message });
                    resolve();
                }
            });
            
            setTimeout(() => {
                this.client.off('message', onMessage);
                console.log('❌ ECHO timeout');
                this.testResults.push({ test: 'ECHO', success: false, error: 'timeout' });
                resolve();
            }, 5000);
        });
    }

    printResults() {
        console.log('\\n📊 Test Results Summary');
        console.log('========================');
        
        const successes = this.testResults.filter(r => r.success).length;
        const total = this.testResults.length;
        
        console.log(`Overall: ${successes}/${total} tests passed\\n`);
        
        this.testResults.forEach(result => {
            const status = result.success ? '✅' : '❌';
            const latency = result.latency ? ` (${result.latency}ms)` : '';
            const error = result.error ? ` - ${result.error}` : '';
            
            console.log(`${status} ${result.test}${latency}${error}`);
        });

        if (successes === total) {
            console.log('\\n🎉 All tests passed! Server is working correctly.');
        } else {
            console.log(`\\n⚠️  ${total - successes} test(s) failed. Check server status.`);
        }
    }
}

// Check if server is reachable
function checkServer() {
    return new Promise((resolve) => {
        const testSocket = dgram.createSocket('udp4');
        const timeout = setTimeout(() => {
            testSocket.close();
            resolve(false);
        }, 2000);

        testSocket.send(Buffer.from('PING'), SERVER_PORT, SERVER_HOST, (err) => {
            if (err) {
                clearTimeout(timeout);
                testSocket.close();
                resolve(false);
                return;
            }
        });

        testSocket.once('message', () => {
            clearTimeout(timeout);
            testSocket.close();
            resolve(true);
        });
    });
}

// Main execution
async function main() {
    console.log(`🔍 Checking if server is running on ${SERVER_HOST}:${SERVER_PORT}...`);
    
    const serverReachable = await checkServer();
    
    if (!serverReachable) {
        console.log('❌ Server not reachable. Make sure pirate-server is running.');
        console.log('   Start server with: ./server/build_debug/pirate-server');
        process.exit(1);
    }
    
    console.log('✅ Server is reachable. Starting tests...\\n');
    
    const tester = new PirateServerTester();
    await tester.runAllTests();
}

if (require.main === module) {
    main().catch(console.error);
}