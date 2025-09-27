#include "net/network.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <arpa/inet.h>

int network_init(struct NetworkManager* net_mgr, uint16_t port) {
    if (!net_mgr) return -1;
    
    memset(net_mgr, 0, sizeof(struct NetworkManager));
    net_mgr->port = port;
    net_mgr->last_stats_time = get_time_ms();
    
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
        log_error("Failed to bind socket to port %u: %s", port, strerror(errno));
        close(net_mgr->socket_fd);
        return -1;
    }
    
    // Initialize subsystems
    if (snapshot_init(&net_mgr->snapshot_mgr) != 0) {
        log_error("Failed to initialize snapshot manager");
        close(net_mgr->socket_fd);
        return -1;
    }
    
    if (reliability_init(&net_mgr->reliability_mgr) != 0) {
        log_error("Failed to initialize reliability manager");
        close(net_mgr->socket_fd);
        return -1;
    }
    
    log_info("Network manager initialized on port %u", port);
    return 0;
}

void network_cleanup(struct NetworkManager* net_mgr) {
    if (!net_mgr) return;
    
    snapshot_cleanup(&net_mgr->snapshot_mgr);
    reliability_cleanup(&net_mgr->reliability_mgr);
    
    if (net_mgr->socket_fd >= 0) {
        close(net_mgr->socket_fd);
        net_mgr->socket_fd = -1;
    }
    
    log_info("Network manager cleaned up");
}

int network_process_incoming(struct NetworkManager* net_mgr, struct Simulation* sim) {
    if (!net_mgr || !sim || net_mgr->socket_fd < 0) return -1;
    
    struct sockaddr_in from_addr;
    socklen_t addr_len = sizeof(from_addr);
    int packets_processed = 0;
    uint32_t current_time = get_time_ms();
    
    // Process all available packets
    while (packets_processed < 100) { // Rate limit to prevent starvation
        ssize_t received = recvfrom(net_mgr->socket_fd, net_mgr->recv_buffer, 
                                   PROTOCOL_MAX_PACKET_SIZE, 0,
                                   (struct sockaddr*)&from_addr, &addr_len);
        
        if (received <= 0) {
            if (errno != EAGAIN && errno != EWOULDBLOCK) {
                log_error("recvfrom error: %s", strerror(errno));
            }
            break; // No more packets or error
        }
        
        if (received < 2) {
            log_warn("Received packet too small: %zd bytes", received);
            continue;
        }
        
        // Process through reliability layer first
        int result = reliability_receive_packet(&net_mgr->reliability_mgr, &from_addr,
                                              net_mgr->recv_buffer, (uint16_t)received,
                                              current_time);
        
        if (result == 1) {
            // Unknown connection - might be handshake
            uint8_t packet_type = net_mgr->recv_buffer[0];
            
            if (packet_type == PACKET_HANDSHAKE && received >= sizeof(struct HandshakePacket)) {
                const struct HandshakePacket* handshake = (const struct HandshakePacket*)net_mgr->recv_buffer;
                network_handle_handshake(net_mgr, &from_addr, handshake);
            } else {
                log_warn("Unknown packet type %u from %s:%d", packet_type,
                         inet_ntoa(from_addr.sin_addr), ntohs(from_addr.sin_port));
            }
            
            packets_processed++;
            continue;
        }
        
        if (result != 0) {
            // Reliability layer error
            packets_processed++;
            continue;
        }
        
        // Find connection for further processing
        struct ReliabilityConnection* conn = reliability_find_connection_by_addr(
            &net_mgr->reliability_mgr, &from_addr);
        
        if (!conn) {
            packets_processed++;
            continue;
        }
        
        // Process packet based on type
        uint8_t packet_type = net_mgr->recv_buffer[0];
        
        switch (packet_type) {
            case PACKET_CLIENT_INPUT: {
                if (received >= sizeof(struct CmdPacket)) {
                    const struct CmdPacket* cmd = (const struct CmdPacket*)net_mgr->recv_buffer;
                    network_process_player_input(net_mgr, sim, conn->player_id, cmd);
                }
                break;
            }
            
            case PACKET_CLIENT_ACK:
                // Already processed by reliability layer
                break;
                
            default:
                log_debug("Unhandled packet type %u from player %u", packet_type, conn->player_id);
                break;
        }
        
        packets_processed++;
        net_mgr->packets_processed++;
    }
    
    return packets_processed;
}

int network_send_snapshots(struct NetworkManager* net_mgr, struct Simulation* sim) {
    if (!net_mgr || !sim || net_mgr->socket_fd < 0) return -1;
    
    // Generate and send snapshots for all connected players
    for (int i = 0; i < MAX_PLAYERS; i++) {
        struct ReliabilityConnection* conn = &net_mgr->reliability_mgr.connections[i];
        if (!conn->active) continue;
        
        // Check if player entity still exists
        if (!simulation_has_entity(sim, conn->player_id)) {
            log_warn("Player %u entity no longer exists, removing connection", conn->player_id);
            reliability_remove_connection(&net_mgr->reliability_mgr, conn->player_id);
            continue;
        }
        
        // Generate snapshot for this player
        uint8_t snapshot_buffer[PROTOCOL_MAX_PACKET_SIZE];
        uint16_t snapshot_size = 0;
        uint32_t bandwidth_used = 0;
        
        int result = snapshot_generate_for_player(&net_mgr->snapshot_mgr, sim, 
                                                 conn->player_id, snapshot_buffer, 
                                                 sizeof(snapshot_buffer), &snapshot_size,
                                                 &bandwidth_used);
        
        if (result == 0 && snapshot_size > 0) {
            // Send snapshot reliably
            reliability_send_packet(&net_mgr->reliability_mgr, conn->player_id,
                                  snapshot_buffer, snapshot_size, net_mgr->socket_fd, true);
            
            net_mgr->bandwidth_used += bandwidth_used;
        }
    }
    
    return 0;
}

int network_handle_handshake(struct NetworkManager* net_mgr, 
                            const struct sockaddr_in* from_addr,
                            const struct HandshakePacket* handshake) {
    if (!net_mgr || !from_addr || !handshake) return -1;
    
    // Validate handshake
    if (handshake->version != PROTOCOL_VERSION) {
        log_warn("Handshake version mismatch: got %u, expected %u",
                 handshake->version, PROTOCOL_VERSION);
        return -1;
    }
    
    // Validate checksum
    struct HandshakePacket temp_handshake = *handshake;
    temp_handshake.checksum = 0;
    uint16_t expected_checksum = protocol_checksum(&temp_handshake, 
                                                  sizeof(temp_handshake) - sizeof(temp_handshake.checksum));
    
    if (handshake->checksum != expected_checksum) {
        log_warn("Handshake checksum mismatch from %s:%d",
                 inet_ntoa(from_addr->sin_addr), ntohs(from_addr->sin_port));
        return -1;
    }
    
    // Check if we have space for new player
    if (net_mgr->reliability_mgr.active_connection_count >= MAX_PLAYERS) {
        log_warn("Server full, rejecting handshake from %s:%d",
                 inet_ntoa(from_addr->sin_addr), ntohs(from_addr->sin_port));
        
        // TODO: Send server full response
        return -1;
    }
    
    // Create new player entity (placeholder - would integrate with game logic)
    entity_id new_player_id = simulation_create_player_entity(sim, handshake->player_name);
    if (new_player_id == INVALID_ENTITY_ID) {
        log_error("Failed to create player entity for %s", handshake->player_name);
        return -1;
    }
    
    // Add reliable connection
    int result = reliability_add_connection(&net_mgr->reliability_mgr, from_addr, new_player_id);
    if (result != 0) {
        log_error("Failed to add reliable connection for player %u", new_player_id);
        // TODO: Remove player entity
        return -1;
    }
    
    // Initialize snapshot state for player
    snapshot_init_player(&net_mgr->snapshot_mgr, new_player_id);
    
    // Send handshake response
    struct HandshakeResponsePacket response = {0};
    response.type = PACKET_HANDSHAKE_RESPONSE;
    response.version = PROTOCOL_VERSION;
    response.player_id = new_player_id;
    response.server_time = get_time_ms();
    
    // Calculate checksum
    response.checksum = protocol_checksum(&response, sizeof(response) - sizeof(response.checksum));
    
    ssize_t sent = sendto(net_mgr->socket_fd, &response, sizeof(response), 0,
                         (struct sockaddr*)from_addr, sizeof(*from_addr));
    
    if (sent == sizeof(response)) {
        log_info("New player connected: %s (ID: %u) from %s:%d",
                 handshake->player_name, new_player_id,
                 inet_ntoa(from_addr->sin_addr), ntohs(from_addr->sin_port));
    } else {
        log_error("Failed to send handshake response");
        reliability_remove_connection(&net_mgr->reliability_mgr, new_player_id);
        return -1;
    }
    
    return 0;
}

int network_process_player_input(struct NetworkManager* net_mgr, struct Simulation* sim,
                                entity_id player_id, const struct CmdPacket* cmd) {
    if (!net_mgr || !sim || !cmd || player_id == INVALID_ENTITY_ID) return -1;
    
    // Validate checksum
    struct CmdPacket temp_cmd = *cmd;
    temp_cmd.checksum = 0;
    uint16_t expected_checksum = protocol_checksum(&temp_cmd, 
                                                  sizeof(temp_cmd) - sizeof(temp_cmd.checksum));
    
    if (cmd->checksum != expected_checksum) {
        log_warn("Command checksum mismatch from player %u", player_id);
        return -1;
    }
    
    // Process input through simulation
    return simulation_process_player_input(sim, player_id, cmd);
}

void network_update(struct NetworkManager* net_mgr, uint32_t current_time) {
    if (!net_mgr) return;
    
    // Update reliability system
    reliability_update(&net_mgr->reliability_mgr, current_time, net_mgr->socket_fd);
    
    // Update snapshot system
    snapshot_update(&net_mgr->snapshot_mgr, current_time);
    
    // Log statistics periodically
    if (current_time - net_mgr->last_stats_time > 10000) { // Every 10 seconds
        uint32_t packets_sent, packets_received, bytes_sent, bytes_received;
        float packet_loss;
        uint16_t avg_rtt;
        
        network_get_stats(net_mgr, &packets_sent, &packets_received,
                         &bytes_sent, &bytes_received, &packet_loss, &avg_rtt);
        
        log_info("Network Stats - Sent: %u pkts (%.1f KB), Received: %u pkts (%.1f KB), "
                 "Loss: %.2f%%, RTT: %u ms, Connections: %u",
                 packets_sent, bytes_sent / 1024.0f,
                 packets_received, bytes_received / 1024.0f,
                 packet_loss, avg_rtt, net_mgr->reliability_mgr.active_connection_count);
        
        net_mgr->last_stats_time = current_time;
    }
}

void network_get_stats(const struct NetworkManager* net_mgr, 
                      uint32_t* packets_sent, uint32_t* packets_received,
                      uint32_t* bytes_sent, uint32_t* bytes_received,
                      float* packet_loss, uint16_t* avg_rtt) {
    if (!net_mgr) return;
    
    const struct ReliabilityManager* rel_mgr = &net_mgr->reliability_mgr;
    
    if (packets_sent) *packets_sent = rel_mgr->total_packets_sent;
    if (packets_received) *packets_received = rel_mgr->total_packets_received;
    if (bytes_sent) *bytes_sent = rel_mgr->total_bytes_sent;
    if (bytes_received) *bytes_received = rel_mgr->total_bytes_received;
    if (packet_loss) *packet_loss = rel_mgr->packet_loss_percentage;
    if (avg_rtt) *avg_rtt = rel_mgr->avg_rtt_ms;
}