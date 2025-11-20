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

// Simple HTML dashboard with map tab
static const char* dashboard_html = 
"<!DOCTYPE html>\n"
"<html><head><title>Pirate Admin Panel</title><meta charset=\"utf-8\"><style>\n"
"body { font-family: Arial, sans-serif; margin: 0; background: #f5f5f5; }\n"
".header { background: #2c3e50; color: white; padding: 1rem; text-align: center; }\n"
".container { max-width: 1200px; margin: 0 auto; padding: 1rem; }\n"
".tabs { display: flex; background: white; border-radius: 8px 8px 0 0; }\n"
".tab { background: #ecf0f1; border: none; padding: 1rem 2rem; cursor: pointer; }\n"
".tab.active { background: white; border-bottom: 2px solid #3498db; }\n"
".tab-content { background: white; border-radius: 0 0 8px 8px; padding: 2rem; min-height: 600px; }\n"
".tab-pane { display: none; } .tab-pane.active { display: block; }\n"
".grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }\n"
".card { background: #f8f9fa; border-radius: 8px; padding: 1.5rem; border: 1px solid #e9ecef; }\n"
".card h3 { margin-top: 0; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 0.5rem; }\n"
".stat { display: flex; justify-content: space-between; margin: 0.5rem 0; }\n"
".stat-value { font-weight: bold; color: #27ae60; }\n"
".indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-left: 5px; }\n"
".indicator.green { background: #27ae60; animation: pulse 2s infinite; }\n"
".indicator.red { background: #e74c3c; }\n"
".indicator.gray { background: #95a5a6; }\n"
"@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }\n"
"#map-container { position: relative; width: 100%; height: 500px; border: 2px solid #34495e; background: #2c5aa0; border-radius: 8px; }\n"
"#map-canvas { width: 100%; height: 100%; display: block; }\n"
".map-legend { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.8); color: white; padding: 1rem; border-radius: 8px; }\n"
".refresh-btn { background: #3498db; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin-bottom: 1rem; }\n"
"</style></head><body>\n"
"<div class=\"header\"><h1>🏴‍☠️ Pirate Game Admin Panel</h1></div>\n"
"<div class=\"container\">\n"
"<button class=\"refresh-btn\" onclick=\"refreshAll()\">🔄 Refresh</button>\n"
"<div class=\"tabs\">\n"
"<button class=\"tab active\" onclick=\"showTab('dashboard')\">📊 Dashboard</button>\n"
"<button class=\"tab\" onclick=\"showTab('map')\">🗺️ Live Map</button>\n"
"</div>\n"
"<div class=\"tab-content\">\n"
"<div id=\"dashboard\" class=\"tab-pane active\">\n"
"<div class=\"grid\">\n"
"<div class=\"card\"><h3>📊 Server Status</h3><div id=\"server-status\">Loading...</div></div>\n"
"<div class=\"card\"><h3>🎯 Physics Objects</h3><div id=\"physics-objects\">Loading...</div></div>\n"
"<div class=\"card\"><h3>🌐 Network Stats</h3><div id=\"network-stats\">Loading...</div></div>\n"
"<div class=\"card\"><h3>💬 Message Activity</h3><div id=\"message-stats\">Loading...</div></div>\n"
"</div></div>\n"
"<div id=\"map\" class=\"tab-pane\">\n"
"<h2>🗺️ Live World Map</h2>\n"
"<div id=\"map-container\">\n"
"<canvas id=\"map-canvas\" width=\"800\" height=\"400\"></canvas>\n"
"<div class=\"map-legend\">\n"
"<div>🚢 Ships</div><div>👤 Players</div><div>💥 Cannonballs</div>\n"
"</div></div></div>\n"
"</div></div>\n"
"<script>\n"
"let mapCanvas, mapCtx, mapData = null;\n"
"function showTab(tabName) {\n"
"document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));\n"
"document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));\n"
"document.getElementById(tabName).classList.add('active');\n"
"event.target.classList.add('active');\n"
"if (tabName === 'map' && !mapCanvas) initMap();\n"
"}\n"
"function initMap() {\n"
"mapCanvas = document.getElementById('map-canvas');\n"
"mapCtx = mapCanvas.getContext('2d');\n"
"updateMap();\n"
"}\n"
"async function updateMap() {\n"
"if (!mapCanvas) return;\n"
"const data = await fetchJson('/api/map');\n"
"if (!data) return;\n"
"mapData = data; drawMap();\n"
"}\n"
"function drawMap() {\n"
"if (!mapData || !mapCtx) return;\n"
"const ctx = mapCtx;\n"
"ctx.fillStyle = '#2c5aa0'; ctx.fillRect(0, 0, 800, 400);\n"
"// Draw ships\n"
"ctx.fillStyle = '#e74c3c';\n"
"mapData.ships.forEach(ship => {\n"
"const x = (ship.x + 500) * 0.8; const y = (ship.y + 250) * 0.8;\n"
"ctx.fillRect(x-4, y-4, 8, 8);\n"
"ctx.fillStyle = 'white'; ctx.font = '10px Arial';\n"
"ctx.fillText('S'+ship.id, x+6, y);\n"
"ctx.fillStyle = '#e74c3c';\n"
"});\n"
"// Draw players\n"
"ctx.fillStyle = '#f39c12';\n"
"mapData.players.forEach(p => {\n"
"const x = (p.x + 500) * 0.8; const y = (p.y + 250) * 0.8;\n"
"ctx.beginPath(); ctx.arc(x, y, 3, 0, 2*Math.PI); ctx.fill();\n"
"});\n"
"// Draw projectiles\n"
"ctx.fillStyle = 'white';\n"
"mapData.projectiles.forEach(p => {\n"
"const x = (p.x + 500) * 0.8; const y = (p.y + 250) * 0.8;\n"
"ctx.beginPath(); ctx.arc(x, y, 1, 0, 2*Math.PI); ctx.fill();\n"
"});\n"
"}\n"
"async function fetchJson(url) {\n"
"try { const r = await fetch(url); return await r.json(); } catch(e) { return null; }\n"
"}\n"
"async function updateServerStatus() {\n"
"const data = await fetchJson('/api/status');\n"
"if (!data) return;\n"
"document.getElementById('server-status').innerHTML = `\n"
"<div class=\"stat\"><span>Uptime:</span><span class=\"stat-value\">${data.uptime_seconds}s</span></div>\n"
"<div class=\"stat\"><span>Tick Rate:</span><span class=\"stat-value\">${data.tick_rate} Hz</span></div>\n"
"<div class=\"stat\"><span>Players:</span><span class=\"stat-value\">${data.player_count}</span></div>\n"
"`;\n"
"}\n"
"async function updatePhysicsObjects() {\n"
"const data = await fetchJson('/api/physics');\n"
"if (!data) return;\n"
"document.getElementById('physics-objects').innerHTML = `\n"
"<div class=\"stat\"><span>🚢 Ships:</span><span class=\"stat-value\">${data.ship_count}</span></div>\n"
"<div class=\"stat\"><span>💥 Projectiles:</span><span class=\"stat-value\">${data.projectile_count}</span></div>\n"
"<div class=\"stat\"><span>👤 Players:</span><span class=\"stat-value\">${data.player_count}</span></div>\n"
"`;\n"
"}\n"
"async function updateNetworkStats() {\n"
"const data = await fetchJson('/api/network');\n"
"if (!data) return;\n"
"document.getElementById('network-stats').innerHTML = `\n"
"<div class=\"stat\"><span>Packets Sent:</span><span class=\"stat-value\">${data.packets_sent}</span></div>\n"
"<div class=\"stat\"><span>Bytes Sent:</span><span class=\"stat-value\">${data.bytes_sent}</span></div>\n"
"`;\n"
"}\n"
"async function updateMessageStats() {\n"
"const data = await fetchJson('/api/messages');\n"
"if (!data) return;\n"
"const inputAge = data.last_input_age_ms;\n"
"const unknownAge = data.last_unknown_age_ms;\n"
"const inputIndicator = inputAge < 5000 ? 'green' : 'gray';\n"
"const unknownIndicator = unknownAge < 5000 ? 'red' : 'gray';\n"
"document.getElementById('message-stats').innerHTML = `\n"
"<div class=\"stat\"><span>🎮 Player Inputs:</span><span class=\"stat-value\">${data.input_messages_received} <span class=\"indicator ${inputIndicator}\"></span></span></div>\n"
"<div class=\"stat\"><span>❓ Unknown Messages:</span><span class=\"stat-value\">${data.unknown_messages_received} <span class=\"indicator ${unknownIndicator}\"></span></span></div>\n"
"<div class=\"stat\"><span>Last Input:</span><span class=\"stat-value\">${inputAge}ms ago</span></div>\n"
"<div class=\"stat\"><span>Last Unknown:</span><span class=\"stat-value\">${unknownAge}ms ago</span></div>\n"
"`;\n"
"}\n"
"function refreshAll() {\n"
"updateServerStatus(); updatePhysicsObjects(); updateNetworkStats(); updateMessageStats();\n"
"if (document.getElementById('map').classList.contains('active')) updateMap();\n"
"}\n"
"refreshAll(); setInterval(refreshAll, 2000);\n"
"</script>\n"
"</body></html>";

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
    
    log_info("📋 Starting admin server cleanup...");
    
    // Stop accepting new connections
    admin->running = false;
    
    if (admin->socket_fd >= 0) {
        // Shutdown the socket gracefully
        shutdown(admin->socket_fd, SHUT_RDWR);
        close(admin->socket_fd);
        admin->socket_fd = -1;
        log_info("🔌 Admin server socket closed");
    }
    
    log_info("✅ Admin server cleanup complete");
}

int admin_server_update(struct AdminServer* admin, const struct Sim* sim,
                       const struct NetworkManager* net_mgr) {
    if (!admin || !admin->running) return 0;
    
    // Accept new connections (simplified)
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    int client_fd = accept(admin->socket_fd, (struct sockaddr*)&client_addr, &addr_len);
    
    if (client_fd >= 0) {
        // Handle simple HTTP requests
        char buffer[4096];
        ssize_t received = recv(client_fd, buffer, sizeof(buffer) - 1, 0);
        if (received > 0) {
            buffer[received] = '\0';
            
            // Parse request path
            char *path_start = strstr(buffer, "GET ");
            if (path_start) {
                path_start += 4;
                char *path_end = strchr(path_start, ' ');
                if (path_end) {
                    *path_end = '\0';
                    
                    // Route requests
                    struct HttpResponse resp = {0};
                    if (strcmp(path_start, "/") == 0) {
                        admin_serve_dashboard(&resp);
                    } else if (strcmp(path_start, "/api/status") == 0) {
                        admin_api_status(&resp, sim, net_mgr);
                    } else if (strcmp(path_start, "/api/physics") == 0) {
                        admin_api_physics_objects(&resp, sim);
                    } else if (strcmp(path_start, "/api/network") == 0) {
                        admin_api_network_stats(&resp, net_mgr);
                    } else if (strcmp(path_start, "/api/map") == 0) {
                        admin_api_map_data(&resp, sim);
                    } else if (strcmp(path_start, "/api/messages") == 0) {
                        admin_api_message_stats(&resp);
                    } else if (strcmp(path_start, "/api/input-tiers") == 0) {
                        admin_api_input_tiers(&resp);
                    } else if (strcmp(path_start, "/api/physics-lod") == 0) {
                        admin_api_physics_lod(&resp);
                    } else if (strcmp(path_start, "/api/performance") == 0) {
                        admin_api_performance_monitor(&resp);
                    } else {
                        resp.status_code = 404;
                        resp.body = "Not Found";
                        resp.body_length = 9;
                    }
                    
                    admin_send_response(client_fd, &resp);
                }
            }
        }
        close(client_fd);
    }
    
    return 0;
}

int admin_parse_request(const char* request_data, size_t length, struct HttpRequest* req) {
    (void)request_data; (void)length; (void)req;
    return 0;  // Simplified
}

int admin_handle_request(const struct HttpRequest* req, struct HttpResponse* resp,
                        const struct Sim* sim, const struct NetworkManager* net_mgr) {
    (void)req; (void)resp; (void)sim; (void)net_mgr;
    return 0;  // Simplified
}

int admin_send_response(int client_fd, const struct HttpResponse* resp) {
    if (client_fd < 0 || !resp) return -1;
    
    char response_buffer[8192];
    int header_len = snprintf(response_buffer, sizeof(response_buffer),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n"
        "\r\n",
        resp->status_code,
        resp->status_code == 200 ? "OK" : "Not Found",
        resp->content_type ? resp->content_type : "text/plain",
        resp->body_length
    );
    
    // Send headers
    send(client_fd, response_buffer, header_len, 0);
    
    // Send body if present
    if (resp->body && resp->body_length > 0) {
        send(client_fd, resp->body, resp->body_length, 0);
    }
    
    return 0;
}

int admin_serve_dashboard(struct HttpResponse* resp) {
    if (!resp) return -1;
    
    resp->status_code = 200;
    resp->content_type = "text/html";
    resp->body = dashboard_html;
    resp->body_length = strlen(dashboard_html);
    resp->cache_control = false;
    
    return 0;
}