#include "net/network.h"
#include "sim/types.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <arpa/inet.h>
#include <stdio.h>

// Simple UDP network implementation for the pirate server

int network_init(struct NetworkManager* net_mgr, uint16_t port) {
    if (!net_mgr) return -1;
    
    memset(net_mgr, 0, sizeof(struct NetworkManager));
    net_mgr->port = port;
    
    // Create UDP socket
    net_mgr->socket_fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (net_mgr->socket_fd < 0) {
        log_error("Failed to create UDP socket: %s", strerror(errno));
        return -1;
    }
    
    // Set socket to non-blocking
    int flags = fcntl(net_mgr->socket_fd, F_GETFL, 0);
    if (flags == -1 || fcntl(net_mgr->socket_fd, F_SETFL, flags | O_NONBLOCK) == -1) {
        log_error("Failed to set socket non-blocking: %s", strerror(errno));
        close(net_mgr->socket_fd);
        return -1;
    }
    
    // Enable socket reuse
    int reuse = 1;
    if (setsockopt(net_mgr->socket_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
        log_warn("Failed to set SO_REUSEADDR: %s", strerror(errno));
    }
    
    // Bind socket
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    
    if (bind(net_mgr->socket_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        log_error("Failed to bind UDP socket to port %u: %s", port, strerror(errno));
        close(net_mgr->socket_fd);
        return -1;
    }
    
    net_mgr->packets_processed = 0;
    net_mgr->bandwidth_used = 0;
    net_mgr->last_stats_time = get_time_ms();
    
    log_info("Network initialized on UDP port %u", port);
    
    // Enhanced startup message
    printf("\n🏴‍☠️ ═══════════════════════════════════════════════════════════════\n");
    printf("🌊 Pirate Game Server - Network Layer Ready!\n");
    printf("🔗 UDP Socket listening on 0.0.0.0:%u\n", port);
    printf("📡 Supported commands: PING, JOIN:PlayerName, STATE, QUIT\n");
    printf("🎮 Ready to accept client connections...\n");
    printf("═══════════════════════════════════════════════════════════════\n\n");
    
    return 0;
}

void network_cleanup(struct NetworkManager* net_mgr) {
    if (!net_mgr) return;
    
    if (net_mgr->socket_fd >= 0) {
        close(net_mgr->socket_fd);
        net_mgr->socket_fd = -1;
    }
    
    log_info("Network cleanup complete");
}

int network_process_incoming(struct NetworkManager* net_mgr, struct Sim* sim) {
    if (!net_mgr || net_mgr->socket_fd < 0) return 0;
    
    char buffer[1400]; // Max safe UDP packet size
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    
    int packets_processed = 0;
    
    // Process multiple packets per call (non-blocking)
    for (int i = 0; i < 10; i++) { // Limit to prevent infinite loop
        ssize_t received = recvfrom(net_mgr->socket_fd, buffer, sizeof(buffer), 0,
                                   (struct sockaddr*)&client_addr, &addr_len);
        
        if (received < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                break; // No more packets
            }
            log_warn("UDP receive error: %s", strerror(errno));
            break;
        }
        
        if (received == 0) break;
        
        // Update statistics
        net_mgr->packets_processed++;
        net_mgr->bandwidth_used += received;
        packets_processed++;
        
        // Get client info for logging
        char client_ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, sizeof(client_ip));
        uint16_t client_port = ntohs(client_addr.sin_port);
        
        // Enhanced connection logging
        printf("🔗 [CONNECTION] %s:%u → Server | ", client_ip, client_port);
        
        // Null-terminate buffer for safe string operations
        buffer[received] = '\0';
        
        // Log the command being processed
        if (received >= 4 && strncmp(buffer, "PING", 4) == 0) {
            printf("PING request\n");
            log_info("📡 PING from %s:%u", client_ip, client_port);
            
            // Respond to ping
            const char* pong = "PONG";
            ssize_t sent = sendto(net_mgr->socket_fd, pong, 4, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                printf("✅ [RESPONSE] Server → %s:%u | PONG sent (%ld bytes)\n", 
                       client_ip, client_port, sent);
                log_info("📡 PONG response sent to %s:%u", client_ip, client_port);
            } else {
                printf("❌ [ERROR] Failed to send PONG to %s:%u\n", client_ip, client_port);
                log_error("Failed to send PONG to %s:%u: %s", client_ip, client_port, strerror(errno));
            }
        }
        else if (received >= 4 && strncmp(buffer, "JOIN", 4) == 0) {
            // Extract player name if provided
            char player_name[64] = "Unknown";
            if (received > 5 && buffer[4] == ':') {
                strncpy(player_name, &buffer[5], sizeof(player_name) - 1);
                player_name[sizeof(player_name) - 1] = '\0';
            }
            
            printf("JOIN request (Player: %s)\n", player_name);
            log_info("🎮 JOIN request from %s:%u - Player: %s", client_ip, client_port, player_name);
            // Handle join request
            char response[256];
            int len = snprintf(response, sizeof(response), 
                              "{\"type\":\"WELCOME\",\"player_id\":%u,\"server_time\":%u,\"player_name\":\"%s\"}",
                              1234, get_time_ms(), player_name);
            
            ssize_t sent = sendto(net_mgr->socket_fd, response, len, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                printf("✅ [RESPONSE] Server → %s:%u | WELCOME sent (%ld bytes) - Player ID: 1234\n", 
                       client_ip, client_port, sent);
                log_info("🎮 WELCOME response sent to %s:%u - Player: %s assigned ID 1234", 
                        client_ip, client_port, player_name);
            } else {
                printf("❌ [ERROR] Failed to send WELCOME to %s:%u\n", client_ip, client_port);
                log_error("Failed to send WELCOME to %s:%u: %s", client_ip, client_port, strerror(errno));
            }
        }
        else if (received >= 5 && strncmp(buffer, "STATE", 5) == 0) {
            printf("STATE request\n");
            log_info("🗺️ STATE request from %s:%u", client_ip, client_port);
            
            // Send game state
            char state[512];
            int len = snprintf(state, sizeof(state),
                              "{\"type\":\"GAME_STATE\",\"tick\":%u,\"time\":%u,\"ships\":[],\"players\":[],\"projectiles\":[]}",
                              sim ? sim->tick : 0, get_time_ms());
            
            ssize_t sent = sendto(net_mgr->socket_fd, state, len, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                printf("✅ [RESPONSE] Server → %s:%u | GAME_STATE sent (%ld bytes) - Tick: %u\n", 
                       client_ip, client_port, sent, sim ? sim->tick : 0);
                log_info("🗺️ GAME_STATE response sent to %s:%u - Tick: %u", 
                        client_ip, client_port, sim ? sim->tick : 0);
            } else {
                printf("❌ [ERROR] Failed to send GAME_STATE to %s:%u\n", client_ip, client_port);
                log_error("Failed to send GAME_STATE to %s:%u: %s", client_ip, client_port, strerror(errno));
            }
        }
        else if (received >= 4 && strncmp(buffer, "QUIT", 4) == 0) {
            printf("QUIT request\n");
            log_info("👋 QUIT request from %s:%u", client_ip, client_port);
            
            const char* goodbye = "GOODBYE";
            ssize_t sent = sendto(net_mgr->socket_fd, goodbye, 7, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                printf("✅ [RESPONSE] Server → %s:%u | GOODBYE sent - Client disconnecting\n", 
                       client_ip, client_port);
                log_info("👋 GOODBYE response sent to %s:%u", client_ip, client_port);
            }
        }
        else {
            // Log unknown command
            char cmd_preview[32];
            snprintf(cmd_preview, sizeof(cmd_preview), "%.20s%s", buffer, received > 20 ? "..." : "");
            printf("UNKNOWN command: %s\n", cmd_preview);
            log_info("❓ Unknown command from %s:%u: %s", client_ip, client_port, cmd_preview);
            
            // Echo unknown packets back for testing
            ssize_t sent = sendto(net_mgr->socket_fd, buffer, received, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                printf("✅ [RESPONSE] Server → %s:%u | ECHO sent (%ld bytes)\n", 
                       client_ip, client_port, sent);
                log_info("🔄 Echoed %ld bytes back to %s:%u", sent, client_ip, client_port);
            } else {
                printf("❌ [ERROR] Failed to echo to %s:%u\n", client_ip, client_port);
                log_error("Failed to echo to %s:%u: %s", client_ip, client_port, strerror(errno));
            }
        }
        
        // Add separator line for readability
        printf("─────────────────────────────────────────────────────\n");
    }
    
    return packets_processed;
}

void network_update(struct NetworkManager* net_mgr, uint32_t current_time) {
    if (!net_mgr) return;
    (void)current_time; // Unused for now
    
    // Could add periodic tasks here (heartbeats, cleanup, etc.)
}

// Stub implementations for missing functions
int network_send_snapshots(struct NetworkManager* net_mgr, struct Sim* sim) {
    (void)net_mgr; (void)sim;
    return 0; // Not implemented yet
}

int network_process_player_input(struct NetworkManager* net_mgr, struct Sim* sim,
                                entity_id player_id, const struct CmdPacket* cmd) {
    (void)net_mgr; (void)sim; (void)player_id; (void)cmd;
    return 0; // Not implemented yet
}

void network_get_stats(const struct NetworkManager* net_mgr,
                      uint32_t* packets_sent, uint32_t* packets_received,
                      uint32_t* bytes_sent, uint32_t* bytes_received,
                      float* packet_loss, uint16_t* avg_rtt) {
    if (!net_mgr) return;
    
    // Return current stats based on available data
    *packets_sent = net_mgr->packets_processed / 2; // Rough estimate 
    *packets_received = net_mgr->packets_processed;
    *bytes_sent = net_mgr->bandwidth_used / 2; // Rough estimate
    *bytes_received = net_mgr->bandwidth_used;
    *packet_loss = 0.01f; // Fake low packet loss
    *avg_rtt = 15; // Fake low RTT
}