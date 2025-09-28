#include "admin/admin_server.h"
#include "sim/types.h"
#include "net/network.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>

// Static HTML content for the dashboard
static const char* dashboard_html = 
"<!DOCTYPE html>\n"
"<html>\n"
"<head>\n"
"    <title>Pirate Game Server - Admin Panel</title>\n"
"    <meta charset=\"utf-8\">\n"
"    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
"    <style>\n"
"        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; background: #f5f5f5; }\n"
"        .header { background: #2c3e50; color: white; padding: 1rem; text-align: center; }\n"
"        .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }\n"
"        \n"
"        /* Tabs */\n"
"        .tabs { display: flex; background: white; border-radius: 8px 8px 0 0; margin-bottom: 0; }\n"
"        .tab { background: #ecf0f1; border: none; padding: 1rem 2rem; cursor: pointer; border-radius: 8px 8px 0 0; margin-right: 2px; }\n"
"        .tab.active { background: white; border-bottom: 2px solid #3498db; }\n"
"        .tab:hover { background: #d5dbdb; }\n"
"        .tab.active:hover { background: white; }\n"
"        \n"
"        /* Tab content */\n"
"        .tab-content { background: white; border-radius: 0 0 8px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); padding: 2rem; min-height: 600px; }\n"
"        .tab-pane { display: none; }\n"
"        .tab-pane.active { display: block; }\n"
"        \n"
"        /* Grid layout for dashboard */\n"
"        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }\n"
"        .card { background: #f8f9fa; border-radius: 8px; padding: 1.5rem; border: 1px solid #e9ecef; }\n"
"        .card h3 { margin-top: 0; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 0.5rem; }\n"
"        .stat { display: flex; justify-content: space-between; margin: 0.5rem 0; }\n"
"        .stat-value { font-weight: bold; color: #27ae60; }\n"
"        .entity-list { max-height: 400px; overflow-y: auto; }\n"
"        .entity { padding: 0.5rem; border: 1px solid #ddd; margin: 0.25rem 0; border-radius: 4px; background: white; }\n"
"        .refresh-btn { background: #3498db; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin-bottom: 1rem; }\n"
"        .status-good { color: #27ae60; }\n"
"        .status-warn { color: #f39c12; }\n"
"        .status-error { color: #e74c3c; }\n"
"        \n"
"        /* Map styles */\n"
"        #map-container { position: relative; width: 100%; height: 600px; border: 2px solid #34495e; background: #2c5aa0; border-radius: 8px; overflow: hidden; }\n"
"        #map-canvas { width: 100%; height: 100%; display: block; }\n"
"        .map-legend { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.8); color: white; padding: 1rem; border-radius: 8px; font-size: 14px; }\n"
"        .map-info { position: absolute; bottom: 10px; left: 10px; background: rgba(0,0,0,0.8); color: white; padding: 0.5rem; border-radius: 4px; font-size: 12px; }\n"
"        .legend-item { margin: 0.25rem 0; }\n"
"        .legend-color { display: inline-block; width: 12px; height: 12px; margin-right: 8px; border-radius: 2px; }\n"
"    </style>\n"
"</head>\n"
"<body>\n"
"    <div class=\"header\">\n"
"        <h1>🏴‍☠️ Pirate Game Server - Admin Control Panel</h1>\n"
"        <p>Real-time Physics & Network Monitoring</p>\n"
"    </div>\n"
"    <div class=\"container\">\n"
"        <button class=\"refresh-btn\" onclick=\"refreshAll()\">🔄 Refresh All</button>\n"
"        \n"
"        <div class=\"tabs\">\n"
"            <button class=\"tab active\" onclick=\"showTab('dashboard')\">📊 Dashboard</button>\n"
"            <button class=\"tab\" onclick=\"showTab('map')\">🗺️ Live Map</button>\n"
"        </div>\n"
"        \n"
"        <div class=\"tab-content\">\n"
"            <div id=\"dashboard\" class=\"tab-pane active\">\n"
"                <div class=\"grid\">\n"
"                    <div class=\"card\">\n"
"                        <h3>📊 Server Status</h3>\n"
"                        <div id=\"server-status\">Loading...</div>\n"
"                    </div>\n"
"                    <div class=\"card\">\n"
"                        <h3>🎯 Physics Objects</h3>\n"
"                        <div id=\"physics-objects\">Loading...</div>\n"
"                    </div>\n"
"                    <div class=\"card\">\n"
"                        <h3>👥 Entities</h3>\n"
"                        <div id=\"entities\" class=\"entity-list\">Loading...</div>\n"
"                    </div>\n"
"                    <div class=\"card\">\n"
"                        <h3>🌐 Network Stats</h3>\n"
"                        <div id=\"network-stats\">Loading...</div>\n"
"                    </div>\n"
"                    <div class=\"card\">\n"
"                        <h3>⚡ Performance</h3>\n"
"                        <div id=\"performance\">Loading...</div>\n"
"                    </div>\n"
"                </div>\n"
"            </div>\n"
"            \n"
"            <div id=\"map\" class=\"tab-pane\">\n"
"                <h2>🗺️ Live World Map</h2>\n"
"                <div id=\"map-container\">\n"
"                    <canvas id=\"map-canvas\" width=\"800\" height=\"600\"></canvas>\n"
"                    <div class=\"map-legend\">\n"
"                        <div class=\"legend-item\"><span class=\"legend-color\" style=\"background: #e74c3c;\"></span>🚢 Ships</div>\n"
"                        <div class=\"legend-item\"><span class=\"legend-color\" style=\"background: #f39c12;\"></span>👤 Players</div>\n"
"                        <div class=\"legend-item\"><span class=\"legend-color\" style=\"background: #ecf0f1;\"></span>💥 Cannonballs</div>\n"
"                    </div>\n"
"                    <div id=\"map-info\" class=\"map-info\">Loading map data...</div>\n"
"                </div>\n"
"            </div>\n"
"        </div>\n"
"    </div>\n"
"    \n"
"    <script>\n"
"        let mapCanvas, mapCtx;\n"
"        let mapData = null;\n"
"        \n"
"        function showTab(tabName) {\n"
"            // Hide all tabs\n"
"            document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));\n"
"            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));\n"
"            \n"
"            // Show selected tab\n"
"            document.getElementById(tabName).classList.add('active');\n"
"            event.target.classList.add('active');\n"
"            \n"
"            // Initialize map if needed\n"
"            if (tabName === 'map' && !mapCanvas) {\n"
"                initMap();\n"
"            }\n"
"        }\n"
"        \n"
"        function initMap() {\n"
"            mapCanvas = document.getElementById('map-canvas');\n"
"            mapCtx = mapCanvas.getContext('2d');\n"
"            \n"
"            // Set canvas size to match container\n"
"            const container = document.getElementById('map-container');\n"
"            mapCanvas.width = container.offsetWidth;\n"
"            mapCanvas.height = container.offsetHeight;\n"
"            \n"
"            updateMap();\n"
"        }\n"
"        \n"
"        async function updateMap() {\n"
"            if (!mapCanvas || !mapCtx) return;\n"
"            \n"
"            const data = await fetchJson('/api/map');\n"
"            if (!data) {\n"
"                document.getElementById('map-info').textContent = 'Failed to load map data';\n"
"                return;\n"
"            }\n"
"            \n"
"            mapData = data;\n"
"            drawMap();\n"
"        }\n"
"        \n"
"        function drawMap() {\n"
"            if (!mapData || !mapCtx) return;\n"
"            \n"
"            const canvas = mapCanvas;\n"
"            const ctx = mapCtx;\n"
"            \n"
"            // Clear canvas\n"
"            ctx.fillStyle = '#2c5aa0';\n"
"            ctx.fillRect(0, 0, canvas.width, canvas.height);\n"
"            \n"
"            // Draw grid\n"
"            ctx.strokeStyle = 'rgba(255,255,255,0.1)';\n"
"            ctx.lineWidth = 1;\n"
"            const gridSize = 50;\n"
"            for (let x = 0; x < canvas.width; x += gridSize) {\n"
"                ctx.beginPath();\n"
"                ctx.moveTo(x, 0);\n"
"                ctx.lineTo(x, canvas.height);\n"
"                ctx.stroke();\n"
"            }\n"
"            for (let y = 0; y < canvas.height; y += gridSize) {\n"
"                ctx.beginPath();\n"
"                ctx.moveTo(0, y);\n"
"                ctx.lineTo(canvas.width, y);\n"
"                ctx.stroke();\n"
"            }\n"
"            \n"
"            // Calculate scale and offset\n"
"            const worldWidth = mapData.world.width;\n"
"            const worldHeight = mapData.world.height;\n"
"            const scaleX = canvas.width / worldWidth;\n"
"            const scaleY = canvas.height / worldHeight;\n"
"            \n"
"            // Draw ships\n"
"            ctx.fillStyle = '#e74c3c';\n"
"            mapData.ships.forEach(ship => {\n"
"                const x = (ship.x + worldWidth/2) * scaleX;\n"
"                const y = (ship.y + worldHeight/2) * scaleY;\n"
"                \n"
"                ctx.save();\n"
"                ctx.translate(x, y);\n"
"                ctx.rotate(ship.rotation);\n"
"                \n"
"                // Draw ship as a triangle\n"
"                ctx.beginPath();\n"
"                ctx.moveTo(-8, -5);\n"
"                ctx.lineTo(8, 0);\n"
"                ctx.lineTo(-8, 5);\n"
"                ctx.closePath();\n"
"                ctx.fill();\n"
"                \n"
"                ctx.restore();\n"
"                \n"
"                // Draw ship ID\n"
"                ctx.fillStyle = 'white';\n"
"                ctx.font = '10px Arial';\n"
"                ctx.fillText('S' + ship.id, x + 10, y);\n"
"            });\n"
"            \n"
"            // Draw players\n"
"            ctx.fillStyle = '#f39c12';\n"
"            mapData.players.forEach(player => {\n"
"                const x = (player.x + worldWidth/2) * scaleX;\n"
"                const y = (player.y + worldHeight/2) * scaleY;\n"
"                \n"
"                ctx.beginPath();\n"
"                ctx.arc(x, y, 4, 0, 2 * Math.PI);\n"
"                ctx.fill();\n"
"                \n"
"                // Draw player ID\n"
"                ctx.fillStyle = 'white';\n"
"                ctx.font = '8px Arial';\n"
"                ctx.fillText('P' + player.id, x + 6, y);\n"
"            });\n"
"            \n"
"            // Draw projectiles\n"
"            ctx.fillStyle = '#ecf0f1';\n"
"            mapData.projectiles.forEach(proj => {\n"
"                const x = (proj.x + worldWidth/2) * scaleX;\n"
"                const y = (proj.y + worldHeight/2) * scaleY;\n"
"                \n"
"                ctx.beginPath();\n"
"                ctx.arc(x, y, 2, 0, 2 * Math.PI);\n"
"                ctx.fill();\n"
"            });\n"
"            \n"
"            // Update info\n"
"            document.getElementById('map-info').innerHTML = \n"
"                `Ships: ${mapData.ships.length} | Players: ${mapData.players.length} | Projectiles: ${mapData.projectiles.length}`;\n"
"        }\n"
"        \n"
"        async function fetchJson(url) {\n"
"            try {\n"
"                const response = await fetch(url);\n"
"                return await response.json();\n"
"            } catch (e) {\n"
"                console.error('Fetch error:', e);\n"
"                return null;\n"
"            }\n"
"        }\n"
"\n"
"        function formatBytes(bytes) {\n"
"            if (bytes === 0) return '0 B';\n"
"            const k = 1024;\n"
"            const sizes = ['B', 'KB', 'MB', 'GB'];\n"
"            const i = Math.floor(Math.log(bytes) / Math.log(k));\n"
"            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];\n"
"        }\n"
"\n"
"        async function updateServerStatus() {\n"
"            const data = await fetchJson('/api/status');\n"
"            if (!data) return;\n"
"            \n"
"            document.getElementById('server-status').innerHTML = `\n"
"                <div class=\"stat\"><span>Uptime:</span><span class=\"stat-value\">${data.uptime_seconds}s</span></div>\n"
"                <div class=\"stat\"><span>Tick Rate:</span><span class=\"stat-value\">${data.tick_rate} Hz</span></div>\n"
"                <div class=\"stat\"><span>Current Tick:</span><span class=\"stat-value\">${data.current_tick}</span></div>\n"
"                <div class=\"stat\"><span>Players:</span><span class=\"stat-value\">${data.player_count}</span></div>\n"
"                <div class=\"stat\"><span>Status:</span><span class=\"stat-value status-good\">Running</span></div>\n"
"            `;\n"
"        }\n"
"\n"
"        async function updatePhysicsObjects() {\n"
"            const data = await fetchJson('/api/physics');\n"
"            if (!data) return;\n"
"            \n"
"            document.getElementById('physics-objects').innerHTML = `\n"
"                <div class=\"stat\"><span>🚢 Ships:</span><span class=\"stat-value\">${data.ship_count}</span></div>\n"
"                <div class=\"stat\"><span>💥 Projectiles:</span><span class=\"stat-value\">${data.projectile_count}</span></div>\n"
"                <div class=\"stat\"><span>👤 Players:</span><span class=\"stat-value\">${data.player_count}</span></div>\n"
"                <div class=\"stat\"><span>Total Objects:</span><span class=\"stat-value\">${data.total_objects}</span></div>\n"
"                <div class=\"stat\"><span>Collisions/sec:</span><span class=\"stat-value\">${data.collisions_per_second}</span></div>\n"
"            `;\n"
"        }\n"
"\n"
"        async function updateEntities() {\n"
"            const data = await fetchJson('/api/entities');\n"
"            if (!data) return;\n"
"            \n"
"            let html = '';\n"
"            data.entities.forEach(entity => {\n"
"                html += `<div class=\"entity\">\n"
"                    <strong>${entity.type} #${entity.id}</strong><br>\n"
"                    Position: (${entity.position.x.toFixed(2)}, ${entity.position.y.toFixed(2)})<br>\n"
"                    Velocity: (${entity.velocity.x.toFixed(2)}, ${entity.velocity.y.toFixed(2)})\n"
"                </div>`;\n"
"            });\n"
"            document.getElementById('entities').innerHTML = html;\n"
"        }\n"
"\n"
"        async function updateNetworkStats() {\n"
"            const data = await fetchJson('/api/network');\n"
"            if (!data) return;\n"
"            \n"
"            document.getElementById('network-stats').innerHTML = `\n"
"                <div class=\"stat\"><span>Packets Sent:</span><span class=\"stat-value\">${data.packets_sent}</span></div>\n"
"                <div class=\"stat\"><span>Packets Received:</span><span class=\"stat-value\">${data.packets_received}</span></div>\n"
"                <div class=\"stat\"><span>Bytes Sent:</span><span class=\"stat-value\">${formatBytes(data.bytes_sent)}</span></div>\n"
"                <div class=\"stat\"><span>Bytes Received:</span><span class=\"stat-value\">${formatBytes(data.bytes_received)}</span></div>\n"
"                <div class=\"stat\"><span>Packet Loss:</span><span class=\"stat-value\">${data.packet_loss.toFixed(2)}%</span></div>\n"
"                <div class=\"stat\"><span>Avg RTT:</span><span class=\"stat-value\">${data.avg_rtt}ms</span></div>\n"
"            `;\n"
"        }\n"
"\n"
"        async function updatePerformance() {\n"
"            const data = await fetchJson('/api/performance');\n"
"            if (!data) return;\n"
"            \n"
"            document.getElementById('performance').innerHTML = `\n"
"                <div class=\"stat\"><span>CPU Usage:</span><span class=\"stat-value\">${data.cpu_usage.toFixed(1)}%</span></div>\n"
"                <div class=\"stat\"><span>Memory Usage:</span><span class=\"stat-value\">${formatBytes(data.memory_usage * 1024 * 1024)}</span></div>\n"
"                <div class=\"stat\"><span>Avg Tick Time:</span><span class=\"stat-value\">${data.tick_time_avg.toFixed(2)}ms</span></div>\n"
"                <div class=\"stat\"><span>Max Tick Time:</span><span class=\"stat-value\">${data.tick_time_max.toFixed(2)}ms</span></div>\n"
"                <div class=\"stat\"><span>FPS:</span><span class=\"stat-value\">${data.fps}</span></div>\n"
"            `;\n"
"        }\n"
"\n"
"        function refreshAll() {\n"
"            updateServerStatus();\n"
"            updatePhysicsObjects();\n"
"            updateEntities();\n"
"            updateNetworkStats();\n"
"            updatePerformance();\n"
"            \n"
"            // Update map if visible\n"
"            if (document.getElementById('map').classList.contains('active')) {\n"
"                updateMap();\n"
"            }\n"
"        }\n"
"\n"
"        // Initial load and auto-refresh\n"
"        refreshAll();\n"
"        setInterval(refreshAll, 2000); // Refresh every 2 seconds\n"
"    </script>\n"
"</body>\n"
"</html>\n";

static const char* admin_dashboard_js = 
"        function updateStats() {\n"
"\n"
"        async function updatePhysicsObjects() {\n"
"            const data = await fetchJson('/api/physics');\n"
"            if (!data) return;\n"
"            \n"
"            document.getElementById('physics-objects').innerHTML = `\n"
"                <div class=\"stat\"><span>🚢 Ships:</span><span class=\"stat-value\">${data.ship_count}</span></div>\n"
"                <div class=\"stat\"><span>💥 Projectiles:</span><span class=\"stat-value\">${data.projectile_count}</span></div>\n"
"                <div class=\"stat\"><span>👤 Players:</span><span class=\"stat-value\">${data.player_count}</span></div>\n"
"                <div class=\"stat\"><span>Total Objects:</span><span class=\"stat-value\">${data.total_objects}</span></div>\n"
"                <div class=\"stat\"><span>Collisions/sec:</span><span class=\"stat-value\">${data.collisions_per_second}</span></div>\n"
"            `;\n"
"        }\n"
"\n"
"        async function updateEntities() {\n"
"            const data = await fetchJson('/api/entities');\n"
"            if (!data) return;\n"
"            \n"
"            let html = '';\n"
"            data.entities.forEach(entity => {\n"
"                html += `<div class=\"entity\">\n"
"                    <strong>${entity.type} #${entity.id}</strong><br>\n"
"                    Position: (${entity.position.x.toFixed(2)}, ${entity.position.y.toFixed(2)})<br>\n"
"                    Velocity: (${entity.velocity.x.toFixed(2)}, ${entity.velocity.y.toFixed(2)})\n"
"                </div>`;\n"
"            });\n"
"            document.getElementById('entities').innerHTML = html;\n"
"        }\n"
"\n"
"        async function updateNetworkStats() {\n"
"            const data = await fetchJson('/api/network');\n"
"            if (!data) return;\n"
"            \n"
"            document.getElementById('network-stats').innerHTML = `\n"
"                <div class=\"stat\"><span>Packets Sent:</span><span class=\"stat-value\">${data.packets_sent}</span></div>\n"
"                <div class=\"stat\"><span>Packets Received:</span><span class=\"stat-value\">${data.packets_received}</span></div>\n"
"                <div class=\"stat\"><span>Bytes Sent:</span><span class=\"stat-value\">${formatBytes(data.bytes_sent)}</span></div>\n"
"                <div class=\"stat\"><span>Bytes Received:</span><span class=\"stat-value\">${formatBytes(data.bytes_received)}</span></div>\n"
"                <div class=\"stat\"><span>Packet Loss:</span><span class=\"stat-value\">${data.packet_loss.toFixed(2)}%</span></div>\n"
"                <div class=\"stat\"><span>Avg RTT:</span><span class=\"stat-value\">${data.avg_rtt}ms</span></div>\n"
"            `;\n"
"        }\n"
"\n"
"        async function updatePerformance() {\n"
"            const data = await fetchJson('/api/performance');\n"
"            if (!data) return;\n"
"            \n"
"            document.getElementById('performance').innerHTML = `\n"
"                <div class=\"stat\"><span>Avg Tick Time:</span><span class=\"stat-value\">${data.avg_tick_time_us.toFixed(1)}μs</span></div>\n"
"                <div class=\"stat\"><span>Max Tick Time:</span><span class=\"stat-value\">${data.max_tick_time_us}μs</span></div>\n"
"                <div class=\"stat\"><span>CPU Usage:</span><span class=\"stat-value\">${data.cpu_usage.toFixed(1)}%</span></div>\n"
"                <div class=\"stat\"><span>Memory Usage:</span><span class=\"stat-value\">${formatBytes(data.memory_usage)}</span></div>\n"
"                <div class=\"stat\"><span>TPS:</span><span class=\"stat-value\">${data.ticks_per_second}</span></div>\n"
"            `;\n"
"        }\n"
"\n"
"        function refreshAll() {\n"
"            updateServerStatus();\n"
"            updatePhysicsObjects();\n"
"            updateEntities();\n"
"            updateNetworkStats();\n"
"            updatePerformance();\n"
"        }\n"
"\n"
"        // Initial load and auto-refresh\n"
"        refreshAll();\n"
"        setInterval(refreshAll, 2000); // Refresh every 2 seconds\n"
"    </script>\n"
"</body>\n"
"</html>";

int admin_server_init(struct AdminServer* admin, uint16_t port) {
    if (!admin) return -1;
    
    memset(admin, 0, sizeof(struct AdminServer));
    admin->port = port;
    admin->running = true;
    admin->start_time = get_time_ms();
    
    // Create HTTP socket
    admin->socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (admin->socket_fd < 0) {
        log_error("Failed to create admin socket: %s", strerror(errno));
        return -1;
    }
    
    // Set socket options
    int reuse = 1;
    if (setsockopt(admin->socket_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
        log_warn("Failed to set SO_REUSEADDR on admin socket: %s", strerror(errno));
    }
    
    // Set non-blocking
    int flags = fcntl(admin->socket_fd, F_GETFL, 0);
    if (flags == -1 || fcntl(admin->socket_fd, F_SETFL, flags | O_NONBLOCK) == -1) {
        log_error("Failed to set admin socket non-blocking: %s", strerror(errno));
        close(admin->socket_fd);
        return -1;
    }
    
    // Bind socket
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    
    if (bind(admin->socket_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        log_error("Failed to bind admin socket to port %u: %s", port, strerror(errno));
        close(admin->socket_fd);
        return -1;
    }
    
    // Start listening
    if (listen(admin->socket_fd, ADMIN_MAX_CONNECTIONS) < 0) {
        log_error("Failed to listen on admin socket: %s", strerror(errno));
        close(admin->socket_fd);
        return -1;
    }
    
    log_info("Admin server initialized on port %u", port);
    return 0;
}

void admin_server_cleanup(struct AdminServer* admin) {
    if (!admin) return;
    
    // Close all client connections
    for (int i = 0; i < ADMIN_MAX_CLIENTS; i++) {
        if (admin->clients[i].active) {
            close(admin->clients[i].socket_fd);
        }
    }
    
    if (admin->socket_fd >= 0) {
        close(admin->socket_fd);
    }
    
    log_info("Admin server cleaned up - served %u requests from %u connections", 
             admin->total_requests, admin->total_connections);
}

int admin_server_update(struct AdminServer* admin, const struct Sim* sim, 
                       const struct NetworkManager* net_mgr) {
    if (!admin || !admin->running) return -1;
    
    uint32_t current_time = get_time_ms();
    
    // Accept new connections
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    
    int client_fd = accept(admin->socket_fd, (struct sockaddr*)&client_addr, &addr_len);
    if (client_fd >= 0) {
        // Find free client slot
        bool found_slot = false;
        for (int i = 0; i < ADMIN_MAX_CLIENTS; i++) {
            if (!admin->clients[i].active) {
                // Set up new client
                admin->clients[i].socket_fd = client_fd;
                admin->clients[i].active = true;
                admin->clients[i].request_length = 0;
                admin->clients[i].last_activity = current_time;
                admin->total_connections++;
                
                log_debug("Admin client connected from %s:%d", 
                         inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));
                found_slot = true;
                break;
            }
        }
        
        if (!found_slot) {
            log_warn("Admin server full, rejecting connection");
            close(client_fd);
        }
    }
    
    // Process existing client connections
    for (int i = 0; i < ADMIN_MAX_CLIENTS; i++) {
        struct AdminClient* client = &admin->clients[i];
        if (!client->active) continue;
        
        // Check for timeout
        if (current_time - client->last_activity > 30000) { // 30 second timeout
            log_debug("Admin client timeout");
            close(client->socket_fd);
            client->active = false;
            continue;
        }
        
        // Try to read request data
        ssize_t bytes_read = recv(client->socket_fd, 
                                 client->request_buffer + client->request_length,
                                 ADMIN_BUFFER_SIZE - client->request_length - 1, 0);
        
        if (bytes_read > 0) {
            client->request_length += bytes_read;
            client->request_buffer[client->request_length] = '\0';
            client->last_activity = current_time;
            
            // Check if we have a complete HTTP request
            if (strstr(client->request_buffer, "\r\n\r\n")) {
                struct HttpRequest req = {0};
                struct HttpResponse resp = {0};
                
                // Parse and handle request
                if (admin_parse_request(client->request_buffer, client->request_length, &req) == 0) {
                    admin_handle_request(&req, &resp, sim, net_mgr);
                    admin_send_response(client->socket_fd, &resp);
                    admin->total_requests++;
                }
                
                // Close connection after response (HTTP/1.0 style)
                close(client->socket_fd);
                client->active = false;
            }
        } else if (bytes_read == 0 || (bytes_read < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
            // Connection closed or error
            close(client->socket_fd);
            client->active = false;
        }
    }
    
    return 0;
}

int admin_parse_request(const char* request_data, size_t length, struct HttpRequest* req) {
    if (!request_data || !req || length == 0) return -1;
    
    // Clear request structure
    memset(req, 0, sizeof(struct HttpRequest));
    
    // Find end of first line
    const char* line_end = strstr(request_data, "\r\n");
    if (!line_end) return -1;
    
    // Parse first line: METHOD PATH HTTP/1.1
    char first_line[512];
    size_t first_line_len = line_end - request_data;
    if (first_line_len >= sizeof(first_line)) return -1;
    
    memcpy(first_line, request_data, first_line_len);
    first_line[first_line_len] = '\0';
    
    // Parse method
    if (strncmp(first_line, "GET ", 4) == 0) {
        req->method = HTTP_GET;
    } else if (strncmp(first_line, "POST ", 5) == 0) {
        req->method = HTTP_POST;
    } else {
        req->method = HTTP_UNKNOWN;
    }
    
    // Parse path
    const char* path_start = strchr(first_line, ' ');
    if (!path_start) return -1;
    path_start++; // Skip space
    
    const char* path_end = strchr(path_start, ' ');
    if (!path_end) return -1;
    
    size_t path_len = path_end - path_start;
    if (path_len >= sizeof(req->path)) return -1;
    
    memcpy(req->path, path_start, path_len);
    req->path[path_len] = '\0';
    
    // Check for query string
    char* query_start = strchr(req->path, '?');
    if (query_start) {
        *query_start = '\0'; // Terminate path
        query_start++; // Move to query string
        strncpy(req->query_string, query_start, sizeof(req->query_string) - 1);
        req->query_string[sizeof(req->query_string) - 1] = '\0';
    }
    
    return 0;
}

int admin_handle_request(const struct HttpRequest* req, struct HttpResponse* resp,
                        const struct Sim* sim, const struct NetworkManager* net_mgr) {
    if (!req || !resp) return -1;
    
    // Default to 404
    resp->status_code = 404;
    resp->content_type = "text/plain";
    resp->body = "Not Found";
    resp->body_length = 9;
    
    if (req->method == HTTP_GET) {
        if (strcmp(req->path, "/") == 0) {
            return admin_serve_dashboard(resp);
        } else if (strcmp(req->path, "/api/status") == 0) {
            return admin_api_status(resp, sim, net_mgr);
        } else if (strcmp(req->path, "/api/entities") == 0) {
            return admin_api_entities(resp, sim);
        } else if (strcmp(req->path, "/api/physics") == 0) {
            return admin_api_physics_objects(resp, sim);
        } else if (strcmp(req->path, "/api/network") == 0) {
            return admin_api_network_stats(resp, net_mgr);
        } else if (strcmp(req->path, "/api/performance") == 0) {
            return admin_api_performance(resp, sim);
        } else if (strcmp(req->path, "/api/map") == 0) {
            return admin_api_map_data(resp, sim);
        }
    }
    
    return 0;
}

int admin_send_response(int client_fd, const struct HttpResponse* resp) {
    if (client_fd < 0 || !resp) return -1;
    
    // Build HTTP response
    char response_buffer[8192];
    int header_len = snprintf(response_buffer, sizeof(response_buffer),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n"
        "%s"
        "\r\n",
        resp->status_code,
        resp->status_code == 200 ? "OK" : "Not Found",
        resp->content_type,
        (size_t)resp->body_length,
        resp->cache_control ? "Cache-Control: no-cache\r\n" : ""
    );
    
    // Send headers
    ssize_t sent = send(client_fd, response_buffer, header_len, 0);
    if (sent != header_len) return -1;
    
    // Send body
    if (resp->body && resp->body_length > 0) {
        sent = send(client_fd, resp->body, resp->body_length, 0);
        if (sent != (ssize_t)resp->body_length) return -1;
    }
    
    return 0;
}

int admin_serve_dashboard(struct HttpResponse* resp) {
    resp->status_code = 200;
    resp->content_type = "text/html";
    resp->body = dashboard_html;
    resp->body_length = strlen(dashboard_html);
    resp->cache_control = true;
    return 0;
}