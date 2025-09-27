#ifndef SERVER_NET_H
#define SERVER_NET_H

#include "net/protocol.h"
#include "net/snapshot.h"
#include "net/reliability.h"
#include <sys/socket.h>
#include <netinet/in.h>

// Forward declarations
struct Sim;
struct HandshakePacket;

// Network manager combining all networking components
struct NetworkManager {
    int socket_fd;
    uint16_t port;
    
    struct SnapshotManager snapshot_mgr;
    struct ReliabilityManager reliability_mgr;
    
    // Receive buffer
    uint8_t recv_buffer[MAX_PACKET_SIZE];
    
    // Performance tracking
    uint32_t packets_processed;
    uint32_t bandwidth_used;
    uint32_t last_stats_time;
};

// Initialize network manager
int network_init(struct NetworkManager* net_mgr, uint16_t port);

// Cleanup network manager
void network_cleanup(struct NetworkManager* net_mgr);

// Process incoming packets
int network_process_incoming(struct NetworkManager* net_mgr, struct Sim* sim);

// Send snapshots to all connected players
int network_send_snapshots(struct NetworkManager* net_mgr, struct Sim* sim);

// Handle new player connection
int network_handle_handshake(struct NetworkManager* net_mgr, 
                            const struct sockaddr_in* from_addr,
                            const struct HandshakePacket* handshake);

// Process player command input
int network_process_player_input(struct NetworkManager* net_mgr, struct Sim* sim,
                                entity_id player_id, const struct CmdPacket* cmd);

// Update network systems (reliability, stats, etc.)
void network_update(struct NetworkManager* net_mgr, uint32_t current_time);

// Get network statistics for monitoring
void network_get_stats(const struct NetworkManager* net_mgr, 
                      uint32_t* packets_sent, uint32_t* packets_received,
                      uint32_t* bytes_sent, uint32_t* bytes_received,
                      float* packet_loss, uint16_t* avg_rtt);

#endif /* SERVER_NET_H */