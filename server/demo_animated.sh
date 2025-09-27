#!/bin/bash

# Admin Panel Live Action Demonstration
# Shows what the panel looks like with active physics objects

clear

cat << 'EOF'
🏴‍☠️ PIRATE GAME SERVER - ADMIN CONTROL PANEL LIVE VIEW
═══════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────┐
│                    🖥️  WEB DASHBOARD SIMULATION               │
│                 http://localhost:8081                      │
└─────────────────────────────────────────────────────────────┘

EOF

animate_dashboard() {
    local tick=0
    
    while true; do
        clear
        
        cat << EOF
🏴‍☠️ PIRATE GAME SERVER - ADMIN CONTROL PANEL LIVE VIEW
═══════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────┐
│                 📊 SERVER STATUS (Live)                    │
├─────────────────────────────────────────────────────────────┤
│  Uptime: $((tick/30))s            Tick Rate: 30 Hz         │
│  Current Tick: $tick            Status: ✅ RUNNING         │
│  Players: 3                     Memory: 15.2 MB            │
│  CPU: 12.5%                     TPS: 30.0                  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                 🎯 PHYSICS OBJECTS (Live)                  │
├─────────────────────────────────────────────────────────────┤
│  🚢 Ships: 3                   💥 Projectiles: $((RANDOM % 8 + 2)) │
│  👥 Players: 3                 📊 Total: $((6 + RANDOM % 8))       │
│  ⚡ Collisions/sec: $((RANDOM % 5 + 1))         🌍 World: 8192x8192m  │
│  Physics Step: 33.333ms        Deterministic: ✅           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              👥 LIVE ENTITIES (Auto-refresh: 2s)           │
├─────────────────────────────────────────────────────────────┤
EOF

        # Simulate moving entities
        local ship1_x=$((1000 + (tick * 3) % 2000))
        local ship1_y=$((500 + (tick * 2) % 1000))
        local ship2_x=$((2000 - (tick * 2) % 1500))
        local ship2_y=$((800 + (tick * 1) % 800))
        local ship3_x=$((1500 + (tick * 4) % 1000))
        local ship3_y=$((1200 - (tick * 3) % 600))
        
        cat << EOF
│  🚢 Ship #1 "BlackPearl"                                    │
│     Pos: (${ship1_x}.2m, ${ship1_y}.8m)  Vel: (5.2, -2.1) m/s      │
│     Rot: 1.${tick}7 rad  Mass: 1000kg  Health: 85/100      │
│                                                             │
│  🚢 Ship #2 "SeaDevil"                                      │
│     Pos: (${ship2_x}.1m, ${ship2_y}.4m)  Vel: (-3.8, 4.2) m/s     │
│     Rot: 0.${tick}2 rad  Mass: 1200kg  Health: 92/100      │
│                                                             │
│  🚢 Ship #3 "StormRider"                                    │
│     Pos: (${ship3_x}.7m, ${ship3_y}.1m)  Vel: (2.1, 6.5) m/s      │
│     Rot: 2.${tick}1 rad  Mass: 950kg   Health: 78/100      │
│                                                             │
│  👤 Player #1 -> Ship #1    👤 Player #2 -> Ship #2        │
│  👤 Player #3 -> Ship #3                                   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                🌐 NETWORK STATS (Live)                     │
├─────────────────────────────────────────────────────────────┤
│  📤 Sent: $((tick * 15)) pkts ($((tick * 2))KB)    📥 Recv: $((tick * 12)) pkts ($((tick * 1))KB) │
│  📊 Loss: 0.8%                   ⏱️  RTT: $((25 + RANDOM % 20))ms         │
│  🔗 Connections: 3               📈 Bandwidth: $((20 + RANDOM % 30)) kbps      │
│  Reliability: ✅ Active          Snapshots: $((tick * 3))/sec         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│               ⚡ PERFORMANCE (Live)                         │
├─────────────────────────────────────────────────────────────┤
│  🕐 Avg Tick: $((1200 + RANDOM % 400))μs     ⏰ Max: $((3000 + RANDOM % 1000))μs              │
│  📊 CPU: $((10 + RANDOM % 15)).$((RANDOM % 10))%              💾 Memory: $((12 + RANDOM % 5)).$((RANDOM % 10))MB         │
│  🎯 Performance: $((RANDOM % 5 + 3)).$((RANDOM % 10))% of budget   TPS: 30.0              │
│  Status: 🟢 Optimal              Determinism: ✅ Perfect    │
└─────────────────────────────────────────────────────────────┘

EOF

        echo "🔄 Auto-refresh in progress... (Ctrl+C to stop)"
        echo ""
        echo "📡 REAL-TIME FEATURES ACTIVE:"
        echo "   • Physics simulation running at 30Hz"
        echo "   • Ships moving with realistic physics"
        echo "   • Network packets flowing with reliability layer"
        echo "   • Delta compression saving ~70% bandwidth"
        echo "   • Sub-microsecond tick performance maintained"
        echo ""
        echo "🎮 This is what you'd see monitoring a live pirate battle!"
        
        sleep 1
        tick=$((tick + 30)) # Simulate 30 ticks per second
    done
}

echo "Starting live admin panel simulation..."
echo "This shows what the dashboard looks like with active physics!"
echo ""
sleep 2

animate_dashboard