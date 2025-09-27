#ifndef NET_RELIABILITY_H
#define NET_RELIABILITY_H

#include <stdint.h>
#include <stdbool.h>
#include <netinet/in.h>

// Reliability configuration
#define RELIABILITY_WINDOW_SIZE 64       // Sliding window for sequence numbers
#define RELIABILITY_RESEND_TIMEOUT_MS 100  // Resend timeout
#define RELIABILITY_MAX_RESENDS 3        // Max resend attempts
#define RELIABILITY_KEEPALIVE_MS 5000    // Heartbeat interval

// Acknowledgment packet
struct AckPacket {
    uint8_t type;           // PACKET_CLIENT_ACK
    uint8_t version;        // PROTOCOL_VERSION
    uint16_t ack_sequence;  // Last received sequence
    uint32_t ack_bitfield;  // Bitmask of recently received packets (1 = received)
    uint32_t client_time;   // Client timestamp
    uint16_t checksum;      // Packet integrity
} __attribute__((packed));

// Reliable packet info for resending
struct ReliablePacket {
    uint16_t sequence;
    uint32_t send_time;
    uint8_t resend_count;
    uint16_t packet_size;
    uint8_t packet_data[1400]; // Max UDP payload
};

// Per-connection reliability state
struct ReliabilityConnection {
    bool active;
    struct sockaddr_in addr;
    
    // Sequence tracking
    uint16_t local_sequence;    // Next sequence to send
    uint16_t remote_sequence;   // Last received sequence
    uint32_t ack_bitfield;      // Recent packets acknowledgment mask
    
    // Resend queue
    struct ReliablePacket pending_packets[RELIABILITY_WINDOW_SIZE];
    uint8_t pending_count;
    
    // Connection state
    uint32_t last_received_time;
    uint32_t last_sent_time;
    uint32_t rtt_ms;           // Round-trip time estimate
    
    // Statistics
    uint32_t packets_sent;
    uint32_t packets_received;
    uint32_t packets_lost;
    uint32_t packets_resent;
    
    // Player association
    entity_id player_id;
};

// Reliability manager
struct ReliabilityManager {
    struct ReliabilityConnection connections[MAX_PLAYERS];
    uint16_t active_connection_count;
    
    // Global statistics
    uint32_t total_packets_sent;
    uint32_t total_packets_received; 
    uint32_t total_packets_lost;
    uint32_t total_bytes_sent;
    uint32_t total_bytes_received;
    
    // Performance metrics
    uint32_t avg_rtt_ms;
    float packet_loss_percentage;
};

// Reliability system functions
int reliability_init(struct ReliabilityManager* mgr);
void reliability_cleanup(struct ReliabilityManager* mgr);

// Connection management
int reliability_add_connection(struct ReliabilityManager* mgr, 
                              const struct sockaddr_in* addr, entity_id player_id);
void reliability_remove_connection(struct ReliabilityManager* mgr, entity_id player_id);
struct ReliabilityConnection* reliability_get_connection(struct ReliabilityManager* mgr, 
                                                        entity_id player_id);
struct ReliabilityConnection* reliability_find_connection_by_addr(struct ReliabilityManager* mgr,
                                                                 const struct sockaddr_in* addr);

// Packet processing
int reliability_send_packet(struct ReliabilityManager* mgr, entity_id player_id,
                           const uint8_t* packet_data, uint16_t packet_size,
                           int socket_fd, bool reliable);

int reliability_receive_packet(struct ReliabilityManager* mgr, 
                              const struct sockaddr_in* from_addr,
                              const uint8_t* packet_data, uint16_t packet_size,
                              uint32_t current_time);

// Maintenance functions
void reliability_update(struct ReliabilityManager* mgr, uint32_t current_time, int socket_fd);
void reliability_process_acks(struct ReliabilityManager* mgr, uint32_t current_time);
void reliability_send_heartbeats(struct ReliabilityManager* mgr, uint32_t current_time, int socket_fd);

// Utility functions
bool reliability_should_resend(const struct ReliablePacket* packet, uint32_t current_time);
void reliability_calculate_rtt(struct ReliabilityConnection* conn, uint32_t sent_time, 
                              uint32_t received_time);
bool reliability_is_packet_acknowledged(const struct ReliabilityConnection* conn, uint16_t sequence);
void reliability_mark_packet_acknowledged(struct ReliabilityConnection* conn, uint16_t sequence);

// Statistics and monitoring
void reliability_get_stats(const struct ReliabilityManager* mgr, 
                          uint32_t* total_sent, uint32_t* total_received,
                          uint32_t* total_lost, float* loss_percentage,
                          uint32_t* avg_rtt);

void reliability_get_connection_stats(const struct ReliabilityConnection* conn,
                                     uint32_t* packets_sent, uint32_t* packets_received,
                                     uint32_t* packets_lost, uint32_t* rtt_ms);

#endif /* NET_RELIABILITY_H */