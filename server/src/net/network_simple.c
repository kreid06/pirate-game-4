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
        
        // Log incoming packet for debugging
        char client_ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, sizeof(client_ip));
        
        log_info("Received %ld bytes from %s:%u - Content: %.50s%s", 
                 received, client_ip, ntohs(client_addr.sin_port),
                 buffer, received > 50 ? "..." : "");
        
        // Simple protocol handling
        if (received >= 4 && strncmp(buffer, "PING", 4) == 0) {
            // Respond to ping
            const char* pong = "PONG";
            ssize_t sent = sendto(net_mgr->socket_fd, pong, 4, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                log_info("Sent PONG response to %s:%u", client_ip, ntohs(client_addr.sin_port));
            }
        }
        else if (received >= 4 && strncmp(buffer, "JOIN", 4) == 0) {
            // Handle join request
            char response[256];
            int len = snprintf(response, sizeof(response), 
                              "{\"type\":\"WELCOME\",\"player_id\":%u,\"server_time\":%u}",
                              1234, get_time_ms());
            
            ssize_t sent = sendto(net_mgr->socket_fd, response, len, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                log_info("Sent WELCOME response to %s:%u", client_ip, ntohs(client_addr.sin_port));
            }
        }
        else if (received >= 5 && strncmp(buffer, "STATE", 5) == 0) {
            // Send game state
            char state[512];
            int len = snprintf(state, sizeof(state),
                              "{\"type\":\"GAME_STATE\",\"tick\":%u,\"ships\":[],\"players\":[],\"projectiles\":[]}",
                              sim ? sim->tick : 0);
            
            ssize_t sent = sendto(net_mgr->socket_fd, state, len, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                log_info("Sent GAME_STATE to %s:%u", client_ip, ntohs(client_addr.sin_port));
            }
        }
        else {
            // Echo unknown packets back for testing
            ssize_t sent = sendto(net_mgr->socket_fd, buffer, received, 0,
                                 (struct sockaddr*)&client_addr, addr_len);
            if (sent > 0) {
                net_mgr->bandwidth_used += sent;
                log_info("Echoed %ld bytes back to %s:%u", sent, client_ip, ntohs(client_addr.sin_port));
            }
        }
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