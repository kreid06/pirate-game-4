#!/bin/bash

# Admin Panel Demo Script
# Demonstrates the real-time physics object monitoring system

echo "🏴‍☠️ Pirate Game Server - Admin Control Panel Demo"
echo "=================================================="
echo ""
echo "Building server with admin panel integration..."

# Build the server
if ./build.sh > build.log 2>&1; then
    echo "✅ Server built successfully!"
else
    echo "❌ Build failed. Check build.log for details."
    echo "Last few lines of build log:"
    tail -10 build.log
    exit 1
fi

echo ""
echo "🚀 Starting server with admin panel..."
echo ""
echo "Admin panel features:"
echo "  📊 Real-time server status monitoring"
echo "  🎯 Physics objects tracking (ships, players, projectiles)"
echo "  👥 Entity list with positions and velocities"
echo "  🌐 Network statistics (packets, bandwidth, RTT)"
echo "  ⚡ Performance metrics (tick times, CPU usage)"
echo ""
echo "Server endpoints:"
echo "  🎮 Game Server: UDP port 8080"
echo "  🖥️  Admin Panel: http://localhost:8081"
echo ""
echo "Press Ctrl+C to stop the server"
echo "=================================================="

# Start the server
./build/pirate-server