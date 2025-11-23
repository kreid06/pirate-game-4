#!/usr/bin/env node

// Simple WebSocket test client for module data
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8082');

let messageCount = 0;

ws.on('open', () => {
    console.log('✅ Connected to server');
    
    // Send handshake
    const handshake = {
        type: 'handshake',
        player_name: 'NodeTester'
    };
    ws.send(JSON.stringify(handshake));
    console.log('📤 Sent handshake');
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());
        messageCount++;

        if (msg.type === 'handshake_response') {
            console.log(`🤝 Handshake complete - Player ID: ${msg.player_id}`);
        } else if (msg.type === 'GAME_STATE') {
            // Only show first few messages
            if (messageCount <= 3) {
                console.log(`\n📦 GAME_STATE #${messageCount} (tick ${msg.tick})`);
                
                if (msg.ships && msg.ships.length > 0) {
                    msg.ships.forEach(ship => {
                        console.log(`  🚢 Ship ${ship.id} at (${ship.x.toFixed(1)}, ${ship.y.toFixed(1)})`);
                        
                        if (ship.modules && ship.modules.length > 0) {
                            console.log(`  └─ ${ship.modules.length} modules:`);
                            ship.modules.forEach((mod, i) => {
                                const types = ['HELM', 'SEAT', 'CANNON', 'MAST', '?', 'LADDER', 'PLANK', 'DECK'];
                                const typeName = types[mod.typeId] || 'UNKNOWN';
                                console.log(`     [${i}] ${typeName} (id:${mod.id}) at (${mod.x.toFixed(1)}, ${mod.y.toFixed(1)}) rot:${mod.rotation.toFixed(2)}`);
                            });
                            
                            // After showing module data, close connection
                            if (messageCount === 3) {
                                console.log('\n✅ Module data verified! Closing connection...');
                                setTimeout(() => ws.close(), 100);
                            }
                        } else {
                            console.log('  ❌ No modules array found!');
                        }
                    });
                } else {
                    console.log('  ❌ No ships in game state!');
                }
            }
        }
    } catch (e) {
        console.error(`❌ Parse error: ${e.message}`);
    }
});

ws.on('error', (error) => {
    console.error(`❌ WebSocket error:`, error.message);
});

ws.on('close', () => {
    console.log('🔌 Disconnected');
    process.exit(0);
});

// Timeout after 10 seconds
setTimeout(() => {
    console.log('\n⏱️ Timeout - closing connection');
    ws.close();
}, 10000);
