#include "net/reliability.h"
#include "net/protocol.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <sys/socket.h>
#include <arpa/inet.h>

// Forward declarations
static struct ReliabilityConnection* find_connection(struct ReliabilityManager* mgr, entity_id player_id);
static struct ReliabilityConnection* find_connection_by_addr(struct ReliabilityManager* mgr, 
                                                           const struct sockaddr_in* addr);
static void add_reliable_packet(struct ReliabilityConnection* conn, uint16_t sequence,
                               const uint8_t* data, uint16_t size, uint32_t send_time);
static void remove_reliable_packet(struct ReliabilityConnection* conn, uint16_t sequence);
static bool sequence_greater_than(uint16_t s1, uint16_t s2);
static uint16_t sequence_difference(uint16_t newer, uint16_t older);

int reliability_init(struct ReliabilityManager* mgr) {
    if (!mgr) return -1;
    
    memset(mgr, 0, sizeof(struct ReliabilityManager));
    
    // Initialize all connections as inactive
    for (int i = 0; i < MAX_PLAYERS; i++) {
        mgr->connections[i].active = false;
        mgr->connections[i].player_id = INVALID_ENTITY_ID;
        mgr->connections[i].local_sequence = 1; // Start from 1
    }
    
    log_info("Reliability manager initialized");
    return 0;
}

void reliability_cleanup(struct ReliabilityManager* mgr) {
    if (!mgr) return;
    
    log_info("Reliability stats - Sent: %u, Received: %u, Lost: %u (%.2f%%), RTT: %ums",
             mgr->total_packets_sent, mgr->total_packets_received,
             mgr->total_packets_lost, mgr->packet_loss_percentage, mgr->avg_rtt_ms);
    
    memset(mgr, 0, sizeof(struct ReliabilityManager));
}

int reliability_add_connection(struct ReliabilityManager* mgr, 
                              const struct sockaddr_in* addr, entity_id player_id) {
    if (!mgr || !addr || player_id == INVALID_ENTITY_ID) return -1;
    
    // Check if connection already exists
    struct ReliabilityConnection* existing = find_connection(mgr, player_id);
    if (existing) {
        log_warn("Connection for player %u already exists", player_id);
        return 0;
    }
    
    // Find free slot
    for (int i = 0; i < MAX_PLAYERS; i++) {
        if (!mgr->connections[i].active) {
            struct ReliabilityConnection* conn = &mgr->connections[i];
            memset(conn, 0, sizeof(struct ReliabilityConnection));
            
            conn->active = true;
            conn->addr = *addr;
            conn->player_id = player_id;
            conn->local_sequence = 1;
            conn->remote_sequence = 0;
            conn->last_received_time = get_time_ms();
            conn->last_sent_time = get_time_ms();
            conn->rtt_ms = 100; // Initial RTT estimate
            
            mgr->active_connection_count++;
            
            log_info("Added reliable connection for player %u from %s:%d",
                     player_id, inet_ntoa(addr->sin_addr), ntohs(addr->sin_port));
            return 0;
        }
    }
    
    log_error("No free connection slots available");
    return -1;
}

void reliability_remove_connection(struct ReliabilityManager* mgr, entity_id player_id) {
    if (!mgr || player_id == INVALID_ENTITY_ID) return;
    
    struct ReliabilityConnection* conn = find_connection(mgr, player_id);
    if (!conn) {
        log_warn("Connection for player %u not found for removal", player_id);
        return;
    }
    
    log_info("Removed reliable connection for player %u", player_id);
    memset(conn, 0, sizeof(struct ReliabilityConnection));
    mgr->active_connection_count--;
}

struct ReliabilityConnection* reliability_get_connection(struct ReliabilityManager* mgr, 
                                                        entity_id player_id) {
    return find_connection(mgr, player_id);
}

struct ReliabilityConnection* reliability_find_connection_by_addr(struct ReliabilityManager* mgr,
                                                                 const struct sockaddr_in* addr) {
    return find_connection_by_addr(mgr, addr);
}

int reliability_send_packet(struct ReliabilityManager* mgr, entity_id player_id,
                           const uint8_t* packet_data, uint16_t packet_size,
                           int socket_fd, bool reliable) {
    if (!mgr || !packet_data || packet_size == 0 || socket_fd < 0) return -1;
    
    struct ReliabilityConnection* conn = find_connection(mgr, player_id);
    if (!conn) {
        log_warn("Connection for player %u not found for send", player_id);
        return -1;
    }
    
    uint32_t current_time = get_time_ms();
    
    // Send packet
    ssize_t sent = sendto(socket_fd, packet_data, packet_size, 0,
                         (struct sockaddr*)&conn->addr, sizeof(conn->addr));
    
    if (sent != packet_size) {
        log_error("Failed to send packet to player %u: %d", player_id, (int)sent);
        return -1;
    }
    
    // Update statistics
    conn->packets_sent++;
    conn->last_sent_time = current_time;
    mgr->total_packets_sent++;
    mgr->total_bytes_sent += packet_size;
    
    // Add to reliable queue if needed
    if (reliable) {
        add_reliable_packet(conn, conn->local_sequence, packet_data, packet_size, current_time);
        conn->local_sequence++;
        
        // Wrap sequence number
        if (conn->local_sequence == 0) {
            conn->local_sequence = 1;
        }
    }
    
    return 0;
}

int reliability_receive_packet(struct ReliabilityManager* mgr, 
                              const struct sockaddr_in* from_addr,
                              const uint8_t* packet_data, uint16_t packet_size,
                              uint32_t current_time) {
    if (!mgr || !from_addr || !packet_data || packet_size < 2) return -1;
    
    struct ReliabilityConnection* conn = find_connection_by_addr(mgr, from_addr);
    if (!conn) {
        // Unknown connection - might be a new handshake
        return 1; // Indicate unknown connection
    }
    
    // Update last received time
    conn->last_received_time = current_time;
    conn->packets_received++;
    mgr->total_packets_received++;
    mgr->total_bytes_received += packet_size;
    
    // Check packet type
    uint8_t packet_type = packet_data[0];
    
    if (packet_type == PACKET_CLIENT_ACK) {
        // Process acknowledgment
        if (packet_size >= sizeof(struct AckPacket)) {
            const struct AckPacket* ack = (const struct AckPacket*)packet_data;
            
            // Validate checksum
            struct AckPacket temp_ack = *ack;
            temp_ack.checksum = 0;
            uint16_t expected_checksum = protocol_checksum(&temp_ack, 
                                                          sizeof(temp_ack) - sizeof(temp_ack.checksum));
            
            if (ack->checksum == expected_checksum) {
                // Process acknowledgments
                reliability_mark_packet_acknowledged(conn, ack->ack_sequence);
                
                // Process bitfield for additional acks
                for (int i = 1; i < 32; i++) {
                    if (ack->ack_bitfield & (1U << i)) {
                        uint16_t acked_seq = ack->ack_sequence - i;
                        reliability_mark_packet_acknowledged(conn, acked_seq);
                    }
                }
                
                // Calculate RTT if we have timestamp
                if (ack->client_time > 0) {
                    reliability_calculate_rtt(conn, ack->client_time, current_time);
                }
                
                log_debug("Processed ACK from player %u: seq=%u, bitfield=0x%08X",
                          conn->player_id, ack->ack_sequence, ack->ack_bitfield);
            }
        }
        return 0;
    }
    
    // For other packet types, update sequence tracking
    if (packet_size >= sizeof(struct CmdPacket) && packet_type == PACKET_CLIENT_INPUT) {
        const struct CmdPacket* cmd = (const struct CmdPacket*)packet_data;
        
        // Check if this is a newer packet
        if (sequence_greater_than(cmd->seq, conn->remote_sequence)) {
            // Update remote sequence and mark as received
            uint16_t gap = sequence_difference(cmd->seq, conn->remote_sequence);
            
            if (gap > 1) {
                // Packets were lost
                conn->packets_lost += (gap - 1);
                mgr->total_packets_lost += (gap - 1);
            }
            
            conn->remote_sequence = cmd->seq;
            
            // Update acknowledgment bitfield
            conn->ack_bitfield = (conn->ack_bitfield << gap) | 1;
        } else {
            // Older or duplicate packet - update bitfield if within window
            uint16_t age = sequence_difference(conn->remote_sequence, cmd->seq);
            if (age < 32) {
                conn->ack_bitfield |= (1U << age);
            }
        }
    }
    
    return 0;
}

void reliability_update(struct ReliabilityManager* mgr, uint32_t current_time, int socket_fd) {
    if (!mgr || socket_fd < 0) return;
    
    // Process all active connections
    for (int i = 0; i < MAX_PLAYERS; i++) {
        struct ReliabilityConnection* conn = &mgr->connections[i];
        if (!conn->active) continue;
        
        // Check for connection timeout
        if (current_time - conn->last_received_time > 30000) { // 30 second timeout
            log_warn("Connection timeout for player %u", conn->player_id);
            reliability_remove_connection(mgr, conn->player_id);
            continue;
        }
        
        // Process pending packet resends
        for (int j = 0; j < conn->pending_count; j++) {
            struct ReliablePacket* packet = &conn->pending_packets[j];
            
            if (reliability_should_resend(packet, current_time)) {
                if (packet->resend_count >= RELIABILITY_MAX_RESENDS) {
                    // Give up on this packet
                    log_warn("Giving up on packet seq=%u to player %u after %u resends",
                             packet->sequence, conn->player_id, packet->resend_count);
                    
                    remove_reliable_packet(conn, packet->sequence);
                    j--; // Adjust index after removal
                    continue;
                }
                
                // Resend packet
                ssize_t sent = sendto(socket_fd, packet->packet_data, packet->packet_size, 0,
                                     (struct sockaddr*)&conn->addr, sizeof(conn->addr));
                
                if (sent == packet->packet_size) {
                    packet->send_time = current_time;
                    packet->resend_count++;
                    conn->packets_resent++;
                    
                    log_debug("Resent packet seq=%u to player %u (attempt %u)",
                              packet->sequence, conn->player_id, packet->resend_count);
                }
            }
        }
    }
    
    // Send heartbeats
    reliability_send_heartbeats(mgr, current_time, socket_fd);
    
    // Update global statistics
    uint32_t total_sent = mgr->total_packets_sent;
    uint32_t total_lost = mgr->total_packets_lost;
    
    if (total_sent > 0) {
        mgr->packet_loss_percentage = (float)total_lost / total_sent * 100.0f;
    }
    
    // Calculate average RTT
    uint32_t rtt_sum = 0;
    uint16_t rtt_count = 0;
    for (int i = 0; i < MAX_PLAYERS; i++) {
        if (mgr->connections[i].active) {
            rtt_sum += mgr->connections[i].rtt_ms;
            rtt_count++;
        }
    }
    
    if (rtt_count > 0) {
        mgr->avg_rtt_ms = rtt_sum / rtt_count;
    }
}

void reliability_send_heartbeats(struct ReliabilityManager* mgr, uint32_t current_time, int socket_fd) {
    if (!mgr || socket_fd < 0) return;
    
    for (int i = 0; i < MAX_PLAYERS; i++) {
        struct ReliabilityConnection* conn = &mgr->connections[i];
        if (!conn->active) continue;
        
        // Send heartbeat if we haven't sent anything recently
        if (current_time - conn->last_sent_time > RELIABILITY_KEEPALIVE_MS) {
            uint8_t heartbeat[4] = {PACKET_HEARTBEAT, PROTOCOL_VERSION, 0, 0};
            uint16_t checksum = protocol_checksum(heartbeat, sizeof(heartbeat) - 2);
            heartbeat[2] = (uint8_t)(checksum & 0xFF);
            heartbeat[3] = (uint8_t)(checksum >> 8);
            
            ssize_t sent = sendto(socket_fd, heartbeat, sizeof(heartbeat), 0,
                                 (struct sockaddr*)&conn->addr, sizeof(conn->addr));
            
            if (sent == sizeof(heartbeat)) {
                conn->last_sent_time = current_time;
                log_debug("Sent heartbeat to player %u", conn->player_id);
            }
        }
    }
}

bool reliability_should_resend(const struct ReliablePacket* packet, uint32_t current_time) {
    if (!packet) return false;
    
    return (current_time - packet->send_time) > RELIABILITY_RESEND_TIMEOUT_MS;
}

void reliability_calculate_rtt(struct ReliabilityConnection* conn, uint32_t sent_time, 
                              uint32_t received_time) {
    if (!conn) return;
    
    uint32_t measured_rtt = received_time - sent_time;
    
    // Smooth RTT calculation (exponential moving average)
    conn->rtt_ms = (conn->rtt_ms * 7 + measured_rtt) / 8;
    
    // Clamp RTT to reasonable range
    if (conn->rtt_ms < 10) conn->rtt_ms = 10;
    if (conn->rtt_ms > 2000) conn->rtt_ms = 2000;
}

bool reliability_is_packet_acknowledged(const struct ReliabilityConnection* conn, uint16_t sequence) {
    if (!conn) return false;
    
    // Check if packet is already acknowledged and removed
    for (int i = 0; i < conn->pending_count; i++) {
        if (conn->pending_packets[i].sequence == sequence) {
            return false; // Still pending
        }
    }
    
    return true; // Not in pending queue, must be acknowledged
}

void reliability_mark_packet_acknowledged(struct ReliabilityConnection* conn, uint16_t sequence) {
    if (!conn) return;
    
    remove_reliable_packet(conn, sequence);
}

// Helper function implementations
static struct ReliabilityConnection* find_connection(struct ReliabilityManager* mgr, entity_id player_id) {
    if (!mgr || player_id == INVALID_ENTITY_ID) return NULL;
    
    for (int i = 0; i < MAX_PLAYERS; i++) {
        if (mgr->connections[i].active && mgr->connections[i].player_id == player_id) {
            return &mgr->connections[i];
        }
    }
    
    return NULL;
}

static struct ReliabilityConnection* find_connection_by_addr(struct ReliabilityManager* mgr, 
                                                           const struct sockaddr_in* addr) {
    if (!mgr || !addr) return NULL;
    
    for (int i = 0; i < MAX_PLAYERS; i++) {
        struct ReliabilityConnection* conn = &mgr->connections[i];
        if (conn->active && 
            conn->addr.sin_addr.s_addr == addr->sin_addr.s_addr &&
            conn->addr.sin_port == addr->sin_port) {
            return conn;
        }
    }
    
    return NULL;
}

static void add_reliable_packet(struct ReliabilityConnection* conn, uint16_t sequence,
                               const uint8_t* data, uint16_t size, uint32_t send_time) {
    if (!conn || !data || size == 0 || conn->pending_count >= RELIABILITY_WINDOW_SIZE) return;
    
    struct ReliablePacket* packet = &conn->pending_packets[conn->pending_count];
    packet->sequence = sequence;
    packet->send_time = send_time;
    packet->resend_count = 0;
    packet->packet_size = size;
    memcpy(packet->packet_data, data, size);
    
    conn->pending_count++;
}

static void remove_reliable_packet(struct ReliabilityConnection* conn, uint16_t sequence) {
    if (!conn) return;
    
    for (int i = 0; i < conn->pending_count; i++) {
        if (conn->pending_packets[i].sequence == sequence) {
            // Shift remaining packets down
            memmove(&conn->pending_packets[i], &conn->pending_packets[i + 1],
                   (conn->pending_count - i - 1) * sizeof(struct ReliablePacket));
            conn->pending_count--;
            return;
        }
    }
}

static bool sequence_greater_than(uint16_t s1, uint16_t s2) {
    return ((s1 > s2) && (s1 - s2 <= 32768)) || 
           ((s1 < s2) && (s2 - s1 > 32768));
}

static uint16_t sequence_difference(uint16_t newer, uint16_t older) {
    if (newer >= older) {
        return newer - older;
    } else {
        return (65536 - older) + newer;
    }
}